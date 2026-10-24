// NFR-17: che do toi / sang / theo he thong. Luu o localStorage (chi tien ich cho nguoi xem).
const KEY = 'chatott.theme';

export function getTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function applyTheme(theme = getTheme()) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f1b26' : '#16324F');
}

export function setTheme(theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* bo qua */ }
  applyTheme(theme);
}

if (typeof window !== 'undefined') {
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme());
}
