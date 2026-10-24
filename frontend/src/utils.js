const TZ = 'Asia/Ho_Chi_Minh';

export function fold(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

function dayKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(date);
}

export function formatClock(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function formatFull(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(iso));
}

// Thoi gian ngan trong danh sach hoi thoai
export function formatListTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const diffMin = (now - date) / 60000;
  if (diffMin < 1) return 'Vừa xong';
  if (diffMin < 60) return `${Math.floor(diffMin)} phút`;
  if (dayKey(date) === dayKey(now)) return formatClock(iso);
  const yesterday = new Date(now.getTime() - 86400000);
  if (dayKey(date) === dayKey(yesterday)) return 'Hôm qua';
  if (now - date < 6 * 86400000) {
    return new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(date);
}

export function formatDayDivider(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return 'Hôm nay';
  if (dayKey(date) === dayKey(new Date(now.getTime() - 86400000))) return 'Hôm qua';
  return new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(date);
}

export function sameDay(a, b) {
  return dayKey(new Date(a)) === dayKey(new Date(b));
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[parts.length - 2].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

const AVATAR_COLORS = ['#1F7A8C', '#7A4E9C', '#C2603B', '#3D7A3A', '#B03A62', '#2F5DA8', '#8A6D1E', '#4B5D73'];

export function avatarColor(seed) {
  let hash = 0;
  for (const ch of String(seed || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function readPref(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* bo qua khi trinh duyet chan localStorage */
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

// "Hoat dong ... truoc" tu moc ngat ket noi realtime gan nhat (chi co khi backend biet).
export function lastSeenText(iso) {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'Vừa truy cập';
  if (min < 60) return `Hoạt động ${min} phút trước`;
  if (min < 24 * 60) return `Hoạt động ${Math.floor(min / 60)} giờ trước`;
  return 'Hoạt động ' + formatListTime(iso).toLowerCase();
}

// Danh sach dinh dang ma backend chap nhan (backend van kiem tra lai noi dung that).
export const UPLOAD_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'pdf', 'docx', 'xlsx', 'txt', 'zip'];
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

export function fileExt(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Du phong khi trinh duyet chan Clipboard API (http khong phai localhost...)
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

// Thoi diem tao cua timeuuid (v1) -> ISO; created_at cua tin nhan luon lay tu chinh message_id.
export function timeuuidToIso(id) {
  const [low, mid, hiVer] = String(id).split('-');
  const ticks = (BigInt('0x' + hiVer.slice(1)) << 48n) | (BigInt('0x' + mid) << 32n) | BigInt('0x' + low);
  return new Date(Number((ticks - 122192928000000000n) / 10000n)).toISOString();
}

// Ranh gioi ngay theo GIO DIA PHUONG cua nguoi dung (vd UTC+7), gui dang ISO day du -> backend khong hieu nham ngay UTC.
export const localDayStart = ymd => (ymd ? new Date(`${ymd}T00:00:00`).toISOString() : undefined);
export const localDayEnd = ymd => (ymd ? new Date(`${ymd}T23:59:59.999`).toISOString() : undefined);
