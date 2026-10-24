// PT-04 / PT-10: kho anh dai dien dung chung. Avatar goi useAvatarSrc(seed): seed la userId hoac
// conversationId (nhom). Cac id duoc gom lai, 1 request GET /avatars?ids=... moi 60ms.
// Su kien realtime 'avatar:changed' (qua chatott:sse) -> tai lai id do.
import { useEffect, useState } from 'react';
import { ext } from './extApi';

const cache = new Map();       // id -> url | null
const listeners = new Map();   // id -> Set<fn>
const pending = new Set();
let timer = null;

function flush() {
  timer = null;
  const ids = [...pending];
  pending.clear();
  if (ids.length === 0) return;
  ext.avatars(ids).then(r => {
    ids.forEach(id => set(id, r.avatars?.[id] ?? null));
  }).catch(() => ids.forEach(id => set(id, null)));
}

function set(id, url) {
  cache.set(id, url);
  listeners.get(id)?.forEach(fn => fn(url));
}

export function requestAvatar(id, force = false) {
  if (!id || (!force && cache.has(id))) return;
  if (!force) cache.set(id, null);
  pending.add(id);
  if (!timer) timer = setTimeout(flush, 60);
}

export function refreshAvatar(id) { requestAvatar(id, true); }

export function useAvatarSrc(seed) {
  const [url, setUrl] = useState(() => (seed ? cache.get(seed) || null : null));
  useEffect(() => {
    if (!seed) return undefined;
    if (!listeners.has(seed)) listeners.set(seed, new Set());
    const fn = u => setUrl(u);
    listeners.get(seed).add(fn);
    setUrl(cache.get(seed) || null);
    requestAvatar(seed);
    return () => listeners.get(seed)?.delete(fn);
  }, [seed]);
  return url;
}

if (typeof window !== 'undefined') {
  window.addEventListener('chatott:sse', e => {
    if (e.detail?.name === 'avatar:changed' && e.detail.data?.id) refreshAvatar(e.detail.data.id);
  });
}
