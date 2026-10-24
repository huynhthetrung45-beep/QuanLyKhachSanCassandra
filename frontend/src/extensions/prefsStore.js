// PT-11: trang thai tat thong bao / luu tru cua cac hoi thoai (dung chung Sidebar + panel).
import { useEffect, useState } from 'react';
import { ext } from './extApi';

let state = {};
let loaded = false;
const subs = new Set();
const emit = () => subs.forEach(fn => fn(state));

export function loadPrefs() {
  return ext.prefs().then(r => {
    state = Object.fromEntries(r.items.map(p => [p.conversationId, p]));
    loaded = true;
    emit();
  }).catch(() => {});
}

export function usePrefs() {
  const [s, setS] = useState(state);
  useEffect(() => {
    subs.add(setS);
    if (!loaded) loadPrefs();
    return () => subs.delete(setS);
  }, []);
  return s;
}

export const isMutedNow = p => Boolean(p && p.muted && (!p.mutedUntil || new Date(p.mutedUntil) > new Date()));

if (typeof window !== 'undefined') {
  window.addEventListener('chatott:sse', e => {
    if (e.detail?.name !== 'conversation:prefs') return;
    const p = e.detail.data;
    state = { ...state, [p.conversationId]: p };
    emit();
  });
}
