import { useEffect, useRef, useState } from 'react';
import { EVENTS_URL } from '../api';
import { EXTRA_EVENTS } from '../extensions/sse';

const NAMES = [
  'message:new', 'message:deleted', 'message:hidden', 'reaction:updated', 'conversation:updated', 'conversation:removed',
  'typing', 'read', 'presence', 'friend:updated', 'notification:new', 'notification:read', 'post:changed', 'message:pins'
];

// Ket noi Server-Sent Events. Mot ket noi cho moi lan mount (component gan voi phien dang nhap).
// - Mat mang: trinh duyet tu ket noi lai.
// - Backend khoi dong lai / tra loi HTTP: EventSource dung han -> tu tao ket noi moi, gian cach 1s -> 30s.
// - Unmount (dang xuat / doi tai khoan): dong ket noi, huy hen gio, go moi listener.
export default function useEventStream(handlers) {
  const handlersRef = useRef(handlers);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let source = null;
    let timer = null;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source = new EventSource(EVENTS_URL, { withCredentials: true });
      NAMES.forEach(name => source.addEventListener(name, event => {
        try {
          handlersRef.current[name]?.(JSON.parse(event.data));
        } catch {
          /* bo qua su kien loi dinh dang */
        }
      }));
      // Su kien cua chuc nang moi: phat lai thanh window event 'chatott:sse' cho component moi nghe.
      // Gom ca su kien cu de component moi dung chung (khong doi cach xu ly cu).
      [...EXTRA_EVENTS, ...NAMES].forEach(name => source.addEventListener(name, event => {
        try {
          window.dispatchEvent(new CustomEvent('chatott:sse', { detail: { name, data: JSON.parse(event.data) } }));
        } catch {
          /* bo qua */
        }
      }));
      source.addEventListener('ready', () => {
        attempt = 0;
        setConnected(true);
        handlersRef.current.ready?.();
      });
      source.onerror = () => {
        setConnected(false);
        if (source.readyState === EventSource.CLOSED && !disposed) {
          source.close();
          const delay = Math.min(30000, 1000 * 2 ** attempt++);
          timer = setTimeout(connect, delay);
        }
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
      setConnected(false);
    };
  }, []);

  return connected;
}
