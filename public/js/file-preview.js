import { api } from './api.js';
import { state, hasCapability } from './store.js';
import { h, toast } from './util.js';
import { openModal } from './ui.js';

const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const imageCache = new Map();

export function localPathFromHref(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return decodeSafe(raw);
  if (!raw.toLowerCase().startsWith('file:')) return null;
  try {
    const url = new URL(raw);
    let path = decodeURIComponent(url.pathname || '');
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    return path.replaceAll('/', '\\');
  } catch {
    return decodeSafe(raw.replace(/^file:\/{0,3}/i, ''));
  }
}

export async function readRemoteFile(path, maxBytes = MAX_PREVIEW_BYTES) {
  if (!state.currentInstanceId) throw new Error('尚未选择机器');
  if (!hasCapability('fileBrowser')) throw new Error('当前 Agent 插件未提供本机文件读取能力');
  return api.call(state.currentInstanceId, 'workspace.fs.read', { path, maxBytes });
}

export async function openRemoteFile(path, title) {
  try {
    const out = await readRemoteFile(path);
    const name = title || out?.name || baseName(path);
    openModal({ title: name, width: 'min(980px, 94vw)', body: previewBody(out) });
  } catch (error) {
    toast('error', `读取本机文件失败：${error.message}`);
  }
}

export async function hydrateRemoteImage(image, path) {
  const cacheKey = `${state.currentInstanceId}|${path}`;
  try {
    if (!imageCache.has(cacheKey)) {
      imageCache.set(cacheKey, readRemoteFile(path).then((out) => {
        if (!out?.dataBase64 || !String(out.mime || '').startsWith('image/')) throw new Error('文件不是可预览图片');
        return `data:${out.mime};base64,${out.dataBase64}`;
      }));
    }
    image.src = await imageCache.get(cacheKey);
    image.classList.remove('remoteImageLoading');
    image.onclick = () => void openRemoteFile(path, image.alt || baseName(path));
  } catch (error) {
    image.replaceWith(h('button', {
      type: 'button', class: 'remoteFileFallback', title: path,
      onclick: () => void openRemoteFile(path, baseName(path)),
      text: `查看图片：${baseName(path)}（${error.message}）`,
    }));
  }
}

export function mediaElement(media) {
  const path = media?.path || localPathFromHref(media?.url || media?.src);
  const name = media?.name || baseName(path || media?.url || '附件');
  const mime = String(media?.mime || '');
  const direct = media?.url || media?.src;
  const looksImage = media?.kind === 'image' || media?.type === 'image' || mime.startsWith('image/')
    || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path || direct || '');
  if (looksImage) {
    const image = h('img', { class: 'messageImage remoteImageLoading', alt: name, loading: 'lazy' });
    if (path) void hydrateRemoteImage(image, path);
    else if (/^(data:|https?:)/i.test(String(direct || ''))) {
      image.src = direct;
      image.classList.remove('remoteImageLoading');
    }
    return image;
  }
  return h('button', {
    type: 'button', class: 'fileChip', title: path || direct || name,
    onclick: () => path ? void openRemoteFile(path, name) : undefined,
    text: name,
  });
}

function previewBody(out) {
  if (!out?.binary) return h('pre', { class: 'jsonBox remoteTextPreview', text: out?.text ?? out?.content ?? '' });
  if (String(out.mime || '').startsWith('image/') && out.dataBase64) {
    return h('div', { class: 'remoteImageStage' }, h('img', {
      class: 'remoteImagePreview', alt: out.name || '图片',
      src: `data:${out.mime};base64,${out.dataBase64}`,
    }));
  }
  if (out.dataBase64) {
    const href = `data:${out.mime || 'application/octet-stream'};base64,${out.dataBase64}`;
    return h('div', { class: 'empty' },
      h('p', { text: `二进制文件，大小 ${formatSize(out.size)}` }),
      h('a', { class: 'btn primary', href, download: out.name || 'download', text: '下载文件' }));
  }
  return h('div', { class: 'empty', text: `该二进制文件无法在线预览（${formatSize(out?.size)}）` });
}

function baseName(path) {
  return String(path || '').split(/[\\/]/).filter(Boolean).pop() || String(path || '文件');
}

function decodeSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function formatSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
