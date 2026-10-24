import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import AuthScreen from './components/AuthScreen';
import ChatApp from './components/ChatApp';
import Logo from './components/Logo';
import { api } from './api';
import { clearSharedPostCache } from './components/SharedPostPreview';
import './App.css';
import { GateScreen, ResetPasswordScreen } from './extensions/AuthExtras';

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState('');
  // Chuc nang moi: dat lai mat khau (?reset=TOKEN), man hinh 2FA / xac minh email.
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.search).get('reset'));
  const [gate, setGate] = useState(null);
  useEffect(() => {
    const onGate = e => setGate(e.detail?.code || null);
    window.addEventListener('chatott:gate', onGate);
    return () => window.removeEventListener('chatott:gate', onGate);
  }, []);

  // Khoi phuc phien tu cookie HttpOnly
  useEffect(() => {
    api.me()
      .then(data => setUser(data.user))
      .catch(err => {
        setUser(null);
        // 401 = chua dang nhap / het phien (binh thuong). Loi khac: bao ro, khong xoa gi.
        if (err.code === 'TWO_FACTOR_REQUIRED' || err.code === 'EMAIL_NOT_VERIFIED') { setGate(err.code); return; }
        if (err.status !== 401) setNotice(err.message || 'Không kiểm tra được phiên đăng nhập.');
      })
      .finally(() => setChecking(false));
  }, []);

  // Bat ky API nao tra 401 -> quay ve man hinh dang nhap
  useEffect(() => {
    const onUnauthorized = e => {
      setUser(current => {
        if (current && e.detail?.code === 'SESSION_EXPIRED') {
          setNotice('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
        }
        return null;
      });
    };
    window.addEventListener('chatott:unauthorized', onUnauthorized);
    return () => window.removeEventListener('chatott:unauthorized', onUnauthorized);
  }, []);

  // Dang xuat THAT: chi roi phien khi server xac nhan. Loi -> nem ra de hop thoai bao loi, khong bao thanh cong gia.
  // Doi user = unmount ChatApp (key = userId) -> dong SSE, go listener, bo state cua tai khoan cu.
  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch (err) {
      if (err.status !== 401) throw err; // 401: phien da het han tren server -> coi nhu da dang xuat
    }
    clearSharedPostCache();
    setNotice('Bạn đã đăng xuất.');
    setUser(null);
  }, []);

  if (checking) {
    return (
      <div className="boot">
        <Logo size={56} />
        <LoaderCircle className="spin" size={22} />
      </div>
    );
  }

  if (resetToken) {
    return (
      <ResetPasswordScreen token={resetToken} onDone={msg => {
        window.history.replaceState(null, '', window.location.pathname);
        setResetToken(null);
        if (msg) setNotice(msg);
      }} />
    );
  }

  if (gate) {
    return (
      <GateScreen code={gate}
        onPassed={() => { setGate(null); api.me().then(d => setUser(d.user)).catch(() => {}); }}
        onLogout={() => { api.logout().catch(() => {}); setGate(null); setUser(null); }} />
    );
  }

  if (!user) {
    return <AuthScreen notice={notice} onLoggedIn={u => { setNotice(''); setUser(u); }} />;
  }

  return <ChatApp key={user.userId} user={user} onLogout={logout} onUserChanged={patch => setUser(u => ({ ...u, ...patch }))} />;
}
