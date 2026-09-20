// End-to-end smoke test for the local mobile API.
// It deliberately prints status codes and booleans only; keys and bearer
// credentials never appear in the report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = process.env.A2S_SERVER_DATA_DIR || path.join(os.homedir(), '.a2s-server');
const base = (process.env.A2S_MOBILE_TEST_BASE || 'http://127.0.0.1:50443/a2s-api/mobile/v1').replace(/\/$/, '');
const adminKey = fs.readFileSync(path.join(dataDir, 'admin-key.txt'), 'utf8').trim();
const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8')).keys || [];

async function call(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let body = null;
  try { body = await response.json(); } catch { /* status is enough for this smoke test */ }
  return { status: response.status, body };
}

const login = await call('/auth/login', {
  method: 'POST',
  body: JSON.stringify({ adminKey, deviceName: 'mobile-api-smoke', appVersion: 'test' }),
});
const token = login.body?.token;
const auth = { authorization: `Bearer ${token}` };
const devices = await call('/devices', { headers: auth });
const device = devices.body?.items?.[0];
const instanceId = device?.agents?.[0]?.instanceId;
const keyEntry = keys.find((item) => item.id === device?.keyId || item.deviceId === device?.id) || keys[0];

const beforeUnlock = instanceId
  ? await call(`/instances/${encodeURIComponent(instanceId)}`, { headers: auth })
  : { status: 0 };
const unlock = device
  ? await call(`/devices/${encodeURIComponent(device.id)}/unlock`, {
      method: 'POST', headers: auth, body: JSON.stringify({ deviceKey: keyEntry?.key }),
    })
  : { status: 0 };
const heartbeat = await call('/clients/heartbeat', { method: 'POST', headers: auth });
const health1 = instanceId
  ? await call(`/instances/${encodeURIComponent(instanceId)}/request`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ method: 'instance.health', params: {}, requestId: 'mobile-smoke-health' }),
    })
  : { status: 0 };
const health2 = instanceId
  ? await call(`/instances/${encodeURIComponent(instanceId)}/request`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ method: 'instance.health', params: {}, requestId: 'mobile-smoke-health' }),
    })
  : { status: 0 };
const replay = instanceId
  ? await call(`/instances/${encodeURIComponent(instanceId)}/events?since=0`, { headers: auth })
  : { status: 0 };

const pairing = device
  ? await call('/pairings', {
      method: 'POST', headers: { 'x-admin-key': adminKey },
      body: JSON.stringify({ endpoint: 'http://127.0.0.1:50443/a2s-api', deviceIds: [device.id] }),
    })
  : { status: 0 };
const redeemed = pairing.body?.ticket
  ? await call('/pairings/redeem', {
      method: 'POST',
      body: JSON.stringify({ ticket: pairing.body.ticket, deviceName: 'mobile-api-qr-smoke', appVersion: 'test' }),
    })
  : { status: 0 };
const reused = pairing.body?.ticket
  ? await call('/pairings/redeem', {
      method: 'POST', body: JSON.stringify({ ticket: pairing.body.ticket, deviceName: 'duplicate' }),
    })
  : { status: 0 };

const renamed = login.body?.client?.id
  ? await call(`/clients/${encodeURIComponent(login.body.client.id)}`, {
      method: 'PATCH', headers: { 'x-admin-key': adminKey },
      body: JSON.stringify({ name: 'mobile-api-renamed' }),
    })
  : { status: 0 };

const revokeIds = [login.body?.client?.id, redeemed.body?.client?.id].filter(Boolean);
const revokes = [];
for (const id of revokeIds) {
  revokes.push(await call(`/clients/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'x-admin-key': adminKey },
  }));
}
const afterRevoke = redeemed.body?.token
  ? await call('/bootstrap', { headers: { authorization: `Bearer ${redeemed.body.token}` } })
  : { status: 0 };

console.log(JSON.stringify({
  login: login.status,
  beforeUnlock: beforeUnlock.status,
  unlock: unlock.status,
  heartbeat: heartbeat.status,
  health1: health1.status,
  health2: health2.status,
  dedupeSame: JSON.stringify(health1.body) === JSON.stringify(health2.body),
  replay: replay.status,
  pairing: pairing.status,
  qr: Boolean(pairing.body?.qrDataUrl),
  redeem: redeemed.status,
  reused: reused.status,
  renamed: renamed.status,
  revokes: revokes.map((item) => item.status),
  afterRevoke: afterRevoke.status,
}));
