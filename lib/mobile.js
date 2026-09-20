// Mobile client API and one-time pairing support.
//
// Mobile clients never receive the server administrator key or the computer
// device keys as a credential.  They exchange those credentials once and then
// use a separately revocable bearer token.  The token is only stored as a
// SHA-256 digest on disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { readJson } from './carriers.js';
import { replaceFileSyncPortable } from './fs-portable.js';

const MOBILE_PREFIX = 'a2sm_';
const PAIRING_TTL_MS = 5 * 60 * 1000;

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function error(res, status, code, message, details) {
  json(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function now() { return Date.now(); }
function id(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`; }
function digest(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function secretEqual(a, b) {
  const left = Buffer.from(digest(a), 'hex');
  const right = Buffer.from(digest(b), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' && /^Bearer\s+/i.test(value)
    ? value.replace(/^Bearer\s+/i, '').trim()
    : '';
}

function deviceIdFor(instance) {
  return instance?.info?.deviceId || instance?.summary?.()?.deviceId || String(instance?.instanceId || '').split(':')[0] || null;
}

function publicClient(client) {
  return {
    id: client.id,
    name: client.name,
    platform: client.platform,
    appVersion: client.appVersion,
    createdAt: client.createdAt,
    lastSeenAt: client.lastSeenAt,
    online: now() - (client.lastSeenAt || 0) < 90_000,
    authorizedDevices: (client.authorizedDevices || []).map((item) => ({ ...item })),
  };
}

function publicDevice(entry, instances) {
  const members = instances.filter((item) => item.deviceId === entry.deviceId || item.instanceId?.startsWith(`${entry.deviceId}:`));
  return {
    id: entry.deviceId || entry.id,
    label: entry.label,
    keyId: entry.id,
    keyFingerprint: entry.fingerprint,
    online: members.some((item) => item.online),
    agents: members,
    instanceIds: entry.instanceIds || [],
    lastUsedAt: entry.lastUsedAt || null,
  };
}

export class MobileStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'mobile.json');
    this.clients = [];
    // The server owns one shared profile image.  It is deliberately kept in
    // the same atomically replaced record as the mobile grants so no per
    // phone copies are created on disk.
    this.avatar = null;
    // Pairing tickets intentionally live in memory. A server restart invalidates
    // every QR code, which is safer than persisting a bearer-capable ticket.
    this.pairing = null;
    this.load();
  }

  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.clients = Array.isArray(value?.clients) ? value.clients : [];
      this.avatar = value?.avatar && typeof value.avatar.dataUrl === 'string'
        ? { ...value.avatar }
        : null;
    } catch {
      this.clients = [];
      this.avatar = null;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ clients: this.clients, avatar: this.avatar }, null, 2) + '\n', { mode: 0o600 });
    replaceFileSyncPortable(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  createClient({ name = 'A2S 手机', platform = 'android', appVersion = 'unknown', authorizedDevices = [], adminDigest = null } = {}) {
    const token = id(MOBILE_PREFIX);
    const client = {
      id: id('mobile'),
      name: String(name || 'A2S 手机').slice(0, 80),
      platform: String(platform || 'android').slice(0, 32),
      appVersion: String(appVersion || 'unknown').slice(0, 32),
      tokenHash: digest(token),
      adminDigest: adminDigest || null,
      createdAt: now(),
      lastSeenAt: now(),
      authorizedDevices: authorizedDevices.map((item) => ({ ...item })),
    };
    this.clients.push(client);
    this.save();
    return { client, token };
  }

  authenticate(token, adminDigest = null) {
    if (!token) return null;
    const candidate = digest(token);
    const client = this.clients.find((item) => typeof item.tokenHash === 'string' && secretEqual(item.tokenHash, candidate));
    if (!client || client.revokedAt) return null;
    if (client.adminDigest && adminDigest && client.adminDigest !== adminDigest) return null;
    if (!client.adminDigest && adminDigest) {
      client.adminDigest = adminDigest;
    }
    client.lastSeenAt = now();
    this.save();
    return client;
  }

  revoke(idValue) {
    const client = this.clients.find((item) => item.id === idValue);
    if (!client) return null;
    client.revokedAt = now();
    this.save();
    return client;
  }

  rename(idValue, name) {
    const client = this.clients.find((item) => item.id === idValue);
    if (!client) return null;
    const value = String(name || '').trim();
    if (value) client.name = value.slice(0, 80);
    this.save();
    return client;
  }

  authorize(client, device, source = 'manual') {
    const next = {
      deviceId: device.deviceId || device.id,
      keyId: device.id,
      keyFingerprint: device.fingerprint,
      grantedAt: now(),
      source,
    };
    const current = client.authorizedDevices || [];
    client.authorizedDevices = [...current.filter((item) => item.deviceId !== next.deviceId), next];
    client.lastSeenAt = now();
    this.save();
    return next;
  }

  canAccess(client, deviceId) {
    return !!client?.authorizedDevices?.some((item) => item.deviceId === deviceId);
  }

  createPairing({ endpoint, deviceIds, ttlMs = PAIRING_TTL_MS } = {}) {
    const ticket = id('pair');
    const expiresAt = now() + Math.min(Math.max(Number(ttlMs) || PAIRING_TTL_MS, 30_000), PAIRING_TTL_MS);
    this.pairing = { ticketHash: digest(ticket), expiresAt, endpoint, deviceIds: [...new Set(deviceIds || [])], createdAt: now() };
    return { ticket, expiresAt, endpoint, deviceIds: this.pairing.deviceIds };
  }

  consumePairing(ticket) {
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= now() || !secretEqual(pairing.ticketHash, digest(ticket))) return null;
    // Consume before issuing a token. Concurrent requests therefore cannot both
    // exchange the same QR code even if persistence is slow.
    this.pairing = null;
    return pairing;
  }

  invalidatePairing() {
    this.pairing = null;
  }

  setAvatar(dataUrl, mimeType = '') {
    const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
    if (!match) throw Object.assign(new Error('头像必须是 PNG、JPEG、WEBP 或 GIF 图片'), { code: 'invalid_avatar' });
    const encoded = match[2].replace(/\s+/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) {
      throw Object.assign(new Error('头像图片不能超过 2 MB'), { code: 'avatar_too_large' });
    }
    const type = match[1].toLowerCase() || String(mimeType || '').toLowerCase();
    this.avatar = { dataUrl: `data:${type};base64,${encoded}`, mimeType: type, updatedAt: now() };
    this.save();
    return this.avatar;
  }

  clearAvatar() {
    this.avatar = null;
    this.save();
  }
}

export class MobileApi {
  constructor(ctx) {
    this.ctx = ctx;
    this.store = new MobileStore(ctx.cfg.dataDir);
    this.streamClients = new Set();
    // Idempotency records are short lived and scoped to one mobile credential.
    // A retry after a lost response therefore cannot submit a second prompt or
    // mutate the same remote session twice.
    this.requestCache = new Map();
    ctx.relay.bus.on('frame', (payload) => this.broadcast('frame', payload));
    ctx.relay.bus.on('out', (payload) => this.broadcast('frame', { ...payload, dir: 'out' }));
    ctx.relay.bus.on('link', (payload) => this.broadcast('link', payload));
  }

  isAdmin(req) {
    const candidate = req.headers['x-admin-key'];
    return typeof candidate === 'string' && this.ctx.keystore.adminKeyMatches(candidate);
  }

  adminDigest() {
    return digest(this.ctx.keystore.adminKey());
  }

  instances() { return this.ctx.relay.list(); }

  entries() { return this.ctx.keystore.entries; }

  deviceEntry(deviceId) {
    return this.entries().find((entry) => entry.deviceId === deviceId || entry.id === deviceId) || null;
  }

  deviceViews() {
    const instances = this.instances();
    return this.ctx.keystore.list().map((entry) => publicDevice(entry, instances));
  }

  /** Authorization is bound to the current server-side key fingerprint. */
  canAccess(client, deviceId) {
    if (!client || client.revokedAt) return false;
    const grant = client?.authorizedDevices?.find((item) => item.deviceId === deviceId);
    if (!grant) return false;
    const current = this.deviceViews().find((item) => item.id === deviceId);
    return !!current && grant.keyId === current.keyId && (!grant.keyFingerprint || grant.keyFingerprint === current.keyFingerprint);
  }

  requireAdmin(req, res) {
    if (!this.isAdmin(req)) {
      error(res, 401, 'unauthorized', '管理密钥无效');
      return false;
    }
    return true;
  }

  requireClient(req, res) {
    const client = this.store.authenticate(bearer(req), this.adminDigest());
    if (!client) {
      error(res, 401, 'unauthorized', '手机凭据无效或已撤销');
      return null;
    }
    return client;
  }

  body(req, res, fn) {
    readJson(req)
      .then((value) => Promise.resolve(fn(value || {})))
      .catch((err) => error(res, 400, 'bad_request', err.message));
  }

  handle(req, res, pathname, requestContext) {
    const base = `${this.ctx.cfg.basePath}/mobile/v1`;
    // A2Switch deliberately reads only this public, read-only projection so
    // the local desktop app never needs the server administrator key.
    if (pathname === `${this.ctx.cfg.basePath}/avatar` && req.method === 'GET') {
      json(res, 200, { ok: true, avatar: this.store.avatar });
      return true;
    }
    if (!(pathname === base || pathname.startsWith(`${base}/`))) return false;
    const rel = pathname.slice(base.length).replace(/^\/+/, '');
    const parts = rel ? rel.split('/').map((value) => decodeURIComponent(value)) : [];

    if (req.method === 'POST' && parts.join('/') === 'auth/login') {
      this.body(req, res, (body) => {
        const supplied = body.adminKey || req.headers['x-admin-key'];
        if (typeof supplied !== 'string' || !this.ctx.keystore.adminKeyMatches(supplied)) {
          error(res, 401, 'unauthorized', '管理密钥无效');
          return;
        }
        const issued = this.store.createClient({
          name: body.name || body.deviceName,
          platform: body.platform,
          appVersion: body.appVersion,
          adminDigest: this.adminDigest(),
        });
        json(res, 200, { ok: true, token: issued.token, client: publicClient(issued.client), ...this.bootstrap(issued.client) });
      });
      return true;
    }

    if (req.method === 'POST' && parts.join('/') === 'pairings') {
      if (!this.requireAdmin(req, res)) return true;
      this.body(req, res, async (body) => {
        const requested = Array.isArray(body.deviceIds) ? body.deviceIds : [];
        const available = new Set(this.deviceViews().map((item) => item.id));
        const deviceIds = requested.filter((item) => available.has(item));
        if (!deviceIds.length) { error(res, 400, 'invalid_params', '至少选择一台已登记电脑'); return; }
        const endpoint = String(body.endpoint || requestContext.baseUrl).replace(/\/$/, '');
        const pairing = this.store.createPairing({ endpoint, deviceIds });
        const qr = JSON.stringify({ v: 1, type: 'a2s-pairing', endpoint, ticket: pairing.ticket, expiresAt: pairing.expiresAt });
        const qrDataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 1, width: 420 });
        json(res, 200, { ok: true, ...pairing, qr, qrDataUrl });
      });
      return true;
    }

    if (req.method === 'DELETE' && parts.join('/') === 'pairings') {
      if (!this.requireAdmin(req, res)) return true;
      this.store.invalidatePairing();
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'pairings') {
      if (!this.requireAdmin(req, res)) return true;
      const pairing = this.store.pairing;
      json(res, 200, { ok: true, active: !!pairing && pairing.expiresAt > now(), expiresAt: pairing?.expiresAt || null, deviceIds: pairing?.deviceIds || [] });
      return true;
    }

    if (req.method === 'POST' && parts.join('/') === 'pairings/redeem') {
      this.body(req, res, (body) => {
        const pairing = this.store.consumePairing(String(body.ticket || ''));
        if (!pairing) { error(res, 410, 'pairing_expired', '二维码已失效，请让服务器重新生成'); return; }
        const current = new Set(this.deviceViews().map((item) => item.id));
        const entries = pairing.deviceIds.map((deviceId) => this.deviceEntry(deviceId)).filter(Boolean);
        if (!entries.length || entries.some((entry) => !current.has(entry.deviceId || entry.id))) {
          error(res, 409, 'pairing_changed', '二维码中的电脑已发生变化，请重新生成');
          return;
        }
        const issued = this.store.createClient({ name: body.name || body.deviceName, platform: body.platform, appVersion: body.appVersion, adminDigest: this.adminDigest() });
        for (const entry of entries) this.store.authorize(issued.client, { ...entry, fingerprint: this.ctx.keystore.list().find((item) => item.id === entry.id)?.fingerprint }, 'qr');
        json(res, 200, { ok: true, token: issued.token, client: publicClient(issued.client), ...this.bootstrap(issued.client) });
      });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'bootstrap') {
      const client = this.requireClient(req, res);
      if (!client) return true;
      json(res, 200, { ok: true, ...this.bootstrap(client) });
      return true;
    }

    if (parts.join('/') === 'avatar' && (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE')) {
      const isAdmin = this.isAdmin(req);
      const client = isAdmin ? null : this.requireClient(req, res);
      if (!isAdmin && !client) return true;
      if (req.method === 'GET') {
        json(res, 200, { ok: true, avatar: this.store.avatar });
        return true;
      }
      if (req.method === 'DELETE') {
        this.store.clearAvatar();
        json(res, 200, { ok: true, avatar: null });
        return true;
      }
      this.body(req, res, (body) => {
        try {
          const avatar = this.store.setAvatar(body?.dataUrl, body?.mimeType);
          json(res, 200, { ok: true, avatar });
        } catch (errValue) {
          error(res, 400, errValue?.code || 'invalid_avatar', errValue?.message || String(errValue));
        }
      });
      return true;
    }

    if (req.method === 'POST' && parts.join('/') === 'clients/heartbeat') {
      const client = this.requireClient(req, res);
      if (!client) return true;
      json(res, 200, { ok: true, client: publicClient(client) });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'devices') {
      const client = this.requireClient(req, res);
      if (!client) return true;
        json(res, 200, { ok: true, items: this.deviceViews().map((item) => ({ ...item, unlocked: this.canAccess(client, item.id) })) });
      return true;
    }

    if (req.method === 'POST' && parts[0] === 'devices' && parts[1] && (parts.length === 2 || (parts.length === 3 && parts[2] === 'unlock'))) {
      const client = this.requireClient(req, res);
      if (!client) return true;
      const deviceId = parts[1];
      this.body(req, res, (body) => {
        const entry = this.deviceEntry(deviceId);
        if (!entry || entry.deviceId !== deviceId && entry.id !== deviceId) { error(res, 404, 'not_found', '电脑不存在'); return; }
        const verified = typeof body.deviceKey === 'string' ? this.ctx.keystore.verify(body.deviceKey) : null;
        if (!verified) {
          error(res, 401, 'device_unauthorized', '电脑 key 无效'); return;
        }
        if (verified.id !== entry.id) { error(res, 403, 'forbidden', '电脑 key 与目标不匹配'); return; }
        const view = this.ctx.keystore.list().find((item) => item.id === entry.id);
        this.store.authorize(client, { ...entry, fingerprint: view?.fingerprint }, 'manual');
        json(res, 200, { ok: true, device: { ...publicDevice(view || { ...entry, fingerprint: view?.fingerprint }, this.instances()), unlocked: true }, ...this.bootstrap(client) });
      });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'clients') {
      if (!this.requireAdmin(req, res)) return true;
      json(res, 200, { ok: true, items: this.store.clients.filter((item) => !item.revokedAt).map(publicClient) });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'keys') {
      if (!this.requireAdmin(req, res)) return true;
      json(res, 200, { ok: true, items: this.ctx.keystore.list() });
      return true;
    }

    if (req.method === 'POST' && parts.join('/') === 'keys') {
      if (!this.requireAdmin(req, res)) return true;
      this.body(req, res, (body) => {
        try {
          const entry = this.ctx.keystore.register(body?.key, {
            label: body?.label,
            instanceId: body?.instanceId,
            deviceId: body?.deviceId,
          });
          this.ctx.relay.bus.emit('instances');
          json(res, 200, {
            ok: true,
            item: this.ctx.keystore.list().find((item) => item.id === entry.id),
          });
        } catch (errValue) {
          error(res, 400, 'invalid_params', errValue?.message || String(errValue));
        }
      });
      return true;
    }

    if (req.method === 'PATCH' && parts[0] === 'keys' && parts[1]) {
      if (!this.requireAdmin(req, res)) return true;
      this.body(req, res, (body) => {
        try {
          const entry = this.ctx.keystore.update(parts[1], body || {});
          if (!entry) {
            error(res, 404, 'not_found', '没有这条 key');
            return;
          }
          for (const instanceId of entry.instanceIds || (entry.instanceId ? [entry.instanceId] : [])) {
            const instance = this.ctx.relay.get(instanceId);
            if (instance) instance.label = entry.label;
          }
          this.ctx.relay.bus.emit('instances');
          json(res, 200, {
            ok: true,
            item: this.ctx.keystore.list().find((item) => item.id === entry.id),
          });
        } catch (errValue) {
          error(res, 400, 'bad_request', errValue?.message || String(errValue));
        }
      });
      return true;
    }

    if (req.method === 'DELETE' && parts[0] === 'keys' && parts[1]) {
      if (!this.requireAdmin(req, res)) return true;
      const gone = this.ctx.keystore.revoke(parts[1]);
      if (!gone) {
        error(res, 404, 'not_found', '没有这条 key');
        return true;
      }
      for (const instanceId of gone.instanceIds || (gone.instanceId ? [gone.instanceId] : [])) {
        const instance = this.ctx.relay.get(instanceId);
        if (!instance) continue;
        for (const link of [...instance.links.values()]) link.close(4401, 'device key revoked');
      }
      this.ctx.relay.bus.emit('instances');
      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'logs') {
      if (!this.requireAdmin(req, res)) return true;
      const lines = typeof this.ctx.log?.tail === 'function' ? this.ctx.log.tail(200) : [];
      json(res, 200, { ok: true, lines });
      return true;
    }

    if (req.method === 'DELETE' && parts[0] === 'clients' && parts[1]) {
      if (!this.requireAdmin(req, res)) return true;
      const revoked = this.store.revoke(parts[1]);
      if (!revoked) { error(res, 404, 'not_found', '手机不存在'); return true; }
      for (const item of [...this.streamClients]) {
        if (item.client.id !== revoked.id) continue;
        this.streamClients.delete(item);
        try { item.res.end(); } catch { /* already closed */ }
      }
      json(res, 200, { ok: true, client: publicClient(revoked) });
      return true;
    }

    if (req.method === 'PATCH' && parts[0] === 'clients' && parts[1]) {
      if (!this.requireAdmin(req, res)) return true;
      this.body(req, res, (body) => {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) { error(res, 400, 'invalid_params', '手机名称不能为空'); return; }
        const renamed = this.store.rename(parts[1], name);
        if (!renamed || renamed.revokedAt) { error(res, 404, 'not_found', '手机不存在'); return; }
        json(res, 200, { ok: true, client: publicClient(renamed) });
      });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'stats') {
      const client = this.requireClient(req, res);
      if (!client) return true;
      const devices = this.authorizedInstances(client);
      json(res, 200, { ok: true, service: 'a2s-server-api', devices: devices.length, online: devices.filter((item) => item.online).length, relay: this.ctx.relay.stats() });
      return true;
    }

    if (req.method === 'GET' && parts.join('/') === 'stream') {
      const client = this.requireClient(req, res);
      if (!client) return true;
      this.openStream(req, res, client);
      return true;
    }

    if (parts[0] === 'instances' && parts[1]) {
      const client = this.requireClient(req, res);
      if (!client) return true;
      const instanceId = parts[1];
      const instance = this.ctx.relay.get(instanceId);
      const deviceId = deviceIdFor(instance);
      if (!instance || !deviceId || !this.canAccess(client, deviceId)) { error(res, 403, 'forbidden', '手机尚未解锁这台电脑'); return true; }
      this.instanceRoute(req, res, parts.slice(2), instanceId, instance, client);
      return true;
    }

    error(res, 404, 'not_found', '没有这个手机接口');
    return true;
  }

  bootstrap(client) {
    return { client: publicClient(client), avatar: this.store.avatar, devices: this.deviceViews().map((item) => ({ ...item, unlocked: this.canAccess(client, item.id) })), basePath: this.ctx.cfg.basePath, protocol: 1 };
  }

  authorizedInstances(client) {
    return this.instances().filter((item) => this.canAccess(client, item.deviceId || item.instanceId?.split(':')[0]));
  }

  instanceRoute(req, res, parts, instanceId, instance, client) {
    if (req.method === 'GET' && !parts.length) {
      const archivedIds = this.ctx.archives.ids(instanceId);
      json(res, 200, {
        ok: true,
        ...(instance.summary ? instance.summary() : {}),
        sessions: (instance.sessionList?.() || []).filter((row) => !archivedIds.has(row.sessionId)),
        archivedSessions: this.ctx.archives.list(instanceId),
        workspaces: instance.workspaces || [],
        jobs: instance.jobs || [],
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'sessions') {
      const archivedIds = this.ctx.archives.ids(instanceId);
      json(res, 200, {
        ok: true,
        items: (instance.sessionList?.() || []).filter((row) => !archivedIds.has(row.sessionId)),
        pausedSessions: [...(instance.pausedSessions || [])],
        pendingDecisions: [...(instance.pendingDecisions?.values?.() || [])],
        needsResync: !!instance.needsResync,
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'archives') {
      json(res, 200, { ok: true, items: this.ctx.archives.list(instanceId) });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'session-events' && parts[1]) {
      const sessionId = parts[1];
      const limit = Math.min(Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 200), 1000);
      json(res, 200, {
        ok: true,
        items: (instance.sessionEvents?.get(sessionId) || []).slice(-limit),
        stream: instance.sessionStreams?.get(sessionId) || null,
        todos: instance.todos?.get(sessionId) || null,
        goal: instance.goals?.get(sessionId) ?? null,
        snapshot: instance.snapshots?.get(sessionId) || null,
        paused: instance.pausedSessions?.has(sessionId) || false,
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'snapshot' && parts[1]) {
      json(res, 200, { ok: true, snapshot: instance.snapshots?.get(parts[1]) || null });
      return;
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && parts[0] === 'sessions' && parts[1] && parts[2] === 'archive') {
      const sessionId = parts[1];
      if (req.method === 'DELETE') {
        const restored = this.ctx.archives.restore(instanceId, sessionId);
        json(res, 200, { ok: true, restored });
        return;
      }
      this.body(req, res, async (body) => {
        const scope = body?.scope === 'host' ? 'host' : 'server';
        const session = (instance.sessionList?.() || []).find((row) => row.sessionId === sessionId);
        if (!session && !this.ctx.archives.has(instanceId, sessionId)) {
          error(res, 404, 'session_not_found', `未知会话 ${sessionId}`);
          return;
        }
        try {
          if (scope === 'host') await this.ctx.relay.call(instanceId, 'session.archive', { sessionId });
          const item = this.ctx.archives.archive(instanceId, session || { sessionId }, scope);
          json(res, 200, { ok: true, item });
        } catch (errValue) {
          error(res, 500, errValue?.code || 'internal', errValue?.message || String(errValue));
        }
      });
      return;
    }
    if (req.method === 'GET' && parts[0] === 'events') { const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since') || 0); json(res, 200, { ok: true, ...(instance.eventsSince ? instance.eventsSince(since) : { items: instance.events || [] }) }); return; }
    if (req.method === 'POST' && parts[0] === 'request') {
      this.body(req, res, async (body) => {
        const requestId = typeof body.requestId === 'string' && body.requestId.trim()
          ? body.requestId.trim().slice(0, 200)
          : null;
        const cacheKey = requestId ? `${client.id}:${requestId}` : null;
        const nowValue = now();
        const cached = cacheKey ? this.requestCache.get(cacheKey) : null;
        if (cached && cached.expiresAt > nowValue) {
          const response = await cached.promise;
          json(res, response.status, response.body);
          return;
        }

        const promise = (async () => {
          try {
            const result = await this.ctx.relay.call(instanceId, body.method, body.params || {}, {
              timeoutMs: body.timeoutMs,
              requestId,
            });
            return { status: 200, body: { ok: true, result } };
          } catch (errValue) {
            return {
              status: 500,
              body: {
                ok: false,
                error: {
                  code: errValue?.code || 'internal',
                  message: errValue?.message || String(errValue),
                  retryable: !!errValue?.retryable,
                },
              },
            };
          }
        })();
        if (cacheKey) {
          const record = { promise, expiresAt: nowValue + 5 * 60 * 1000 };
          this.requestCache.set(cacheKey, record);
          setTimeout(() => {
            if (this.requestCache.get(cacheKey) === record) this.requestCache.delete(cacheKey);
          }, 5 * 60 * 1000).unref?.();
        }
        const response = await promise;
        json(res, response.status, response.body);
      });
      return;
    }
    if (req.method === 'POST' && parts[0] === 'subscribe') { this.body(req, res, (body) => json(res, 200, { ok: true, subscriptions: instance.subscribe(body || {}) })); return; }
    if (req.method === 'POST' && parts[0] === 'unsubscribe') { this.body(req, res, (body) => json(res, 200, { ok: true, subscriptions: instance.unsubscribe(body || {}) })); return; }
    error(res, 404, 'not_found', '没有这个实例接口');
  }

  openStream(req, res, client) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    const item = { res, client };
    this.streamClients.add(item);
    const close = () => this.streamClients.delete(item);
    req.on('close', close);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); close(); } }, 25_000);
    ping.unref?.();
    req.on('close', () => clearInterval(ping));
  }

  broadcast(event, payload) {
    for (const item of [...this.streamClients]) {
      const deviceId = payload?.instanceId ? (payload.deviceId || String(payload.instanceId).split(':')[0]) : null;
      if (deviceId && !this.canAccess(item.client, deviceId)) continue;
      try { item.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { this.streamClients.delete(item); }
    }
  }
}

export { PAIRING_TTL_MS };
