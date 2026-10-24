// Su kien realtime cua chuc nang moi: useEventStream phat lai thanh window event 'chatott:sse'
// ({ name, data }). Component moi nghe bang hook nay, khong can sua ChatApp.
import { useEffect, useRef } from 'react';

export const EXTRA_EVENTS = [
  'message:extra', 'message:edited', 'message:restored', 'poll:updated', 'avatar:changed', 'group:updated',
  'conversation:prefs', 'story:changed', 'account:security', 'report:new'
];

export function useSse(names, handler) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  const key = [].concat(names).join('|');
  useEffect(() => {
    const list = key.split('|');
    const on = e => { if (list.includes(e.detail?.name)) ref.current(e.detail.data, e.detail.name); };
    window.addEventListener('chatott:sse', on);
    return () => window.removeEventListener('chatott:sse', on);
  }, [key]);
}

// Dieu huong giua cac trang moi ma khong can truyen prop qua nhieu tang.
export const navigate = (view, detail = {}) => window.dispatchEvent(new CustomEvent('chatott:navigate', { detail: { view, ...detail } }));
