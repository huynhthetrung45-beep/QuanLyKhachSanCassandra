// PT-14: dang ky Web Push qua service worker (/sw.js). Can HTTPS hoac localhost.
import { ext } from './extApi';

const b64ToBytes = s => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
};

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerSw() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('Trình duyệt này không hỗ trợ thông báo đẩy.');
  const status = await ext.pushStatus();
  if (!status.available) throw new Error(status.message);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Bạn chưa cho phép hiển thị thông báo.');
  const reg = await registerSw();
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(status.publicKey) });
  await ext.subscribePush(sub.toJSON());
  return true;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await ext.unsubscribePush(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}
