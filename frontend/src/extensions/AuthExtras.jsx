// PT-02 quen / dat lai mat khau, NFR-16 nhap ma 2FA, PT-09 xac minh email (man hinh chan).
import { useState } from 'react';
import { KeyRound, LoaderCircle, MailCheck, ShieldCheck, X } from 'lucide-react';
import Logo from '../components/Logo';
import { ext } from './extApi';

export function ForgotPasswordDialog({ initialEmail = '', onClose }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await ext.forgotPassword(email.trim());
      setDone(r.message);
    } catch (err) {
      setError(err.fields?.email || err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <form className="dialog small" role="dialog" aria-modal="true" aria-label="Quên mật khẩu" onSubmit={submit}>
        <div className="dialog-head"><h3><KeyRound size={18} /> Quên mật khẩu</h3>
          <button type="button" className="icon-btn ghost" onClick={onClose} aria-label="Đóng"><X size={18} /></button></div>
        {done ? (
          <>
            <div className="banner ok" role="status">{done}</div>
            <p className="muted ext-note">Chế độ phát triển (chưa cấu hình SMTP): liên kết được in ra cửa sổ backend và lưu trong thư mục storage/outbox.</p>
            <div className="dialog-actions"><button type="button" className="btn primary" onClick={onClose}>Đóng</button></div>
          </>
        ) : (
          <>
            <p>Nhập email đã đăng ký. Chúng tôi sẽ gửi liên kết đặt lại mật khẩu (hiệu lực 30 phút, dùng một lần).</p>
            <div className="field"><label htmlFor="fp-email">Email</label>
              <input id="fp-email" className="ext-input" type="email" value={email} onChange={e => setEmail(e.target.value)} autoFocus autoComplete="email" /></div>
            {error && <p className="field-error" role="alert">{error}</p>}
            <div className="dialog-actions">
              <button type="button" className="btn secondary" onClick={onClose}>Hủy</button>
              <button type="submit" className="btn primary" disabled={busy || !email.trim()}>{busy && <LoaderCircle size={16} className="spin" />} Gửi liên kết</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

export function ResetPasswordScreen({ token, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (pw !== pw2) { setError('Mật khẩu xác nhận không khớp.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await ext.resetPassword(token, pw, pw2);
      onDone(r.message);
    } catch (err) {
      setError(err.fields?.newPassword || err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ext-gate">
      <form className="auth-card ext-gate-card" onSubmit={submit}>
        <div className="auth-mobile-logo ext-show"><Logo size={40} /><span className="brand-word dark">ChatOTT</span></div>
        <h1>Đặt mật khẩu mới</h1>
        <p className="auth-sub">Mọi phiên đăng nhập cũ sẽ bị đăng xuất sau khi đổi.</p>
        <div className="field"><label htmlFor="rp-1">Mật khẩu mới</label>
          <input id="rp-1" className="ext-input" type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" autoFocus /></div>
        <div className="field"><label htmlFor="rp-2">Nhập lại mật khẩu mới</label>
          <input id="rp-2" className="ext-input" type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" /></div>
        <p className="hint">Ít nhất 8 ký tự, gồm cả chữ và số.</p>
        {error && <div className="banner error" role="alert">{error}</div>}
        <button className="btn primary block" type="submit" disabled={busy || !pw}>{busy && <LoaderCircle size={18} className="spin" />} Đặt mật khẩu</button>
        <p className="auth-switch"><button type="button" className="link-btn" onClick={() => onDone('')}>Quay lại đăng nhập</button></p>
      </form>
    </div>
  );
}

// Phien da dang nhap nhung bi chan: can ma 2FA hoac xac minh email.
export function GateScreen({ code, onPassed, onLogout }) {
  const twoFactor = code === 'TWO_FACTOR_REQUIRED';
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (twoFactor) await ext.verifyTwoFactor(value.trim());
      else await ext.verifyEmail(value.trim());
      onPassed();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    try {
      const r = await ext.sendVerification();
      setInfo(r.alreadyVerified ? 'Email đã được xác minh.' : `Đã gửi mã tới ${r.email}.`);
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div className="ext-gate">
      <form className="auth-card ext-gate-card" onSubmit={submit}>
        <div className="ext-gate-icon">{twoFactor ? <ShieldCheck size={34} /> : <MailCheck size={34} />}</div>
        <h1>{twoFactor ? 'Xác thực hai lớp' : 'Xác minh email'}</h1>
        <p className="auth-sub">{twoFactor
          ? 'Nhập mã 6 số trong ứng dụng xác thực (Google Authenticator, Microsoft Authenticator…).'
          : 'Nhập mã 6 số đã gửi tới email của bạn để kích hoạt tài khoản.'}</p>
        <input className="ext-input ext-code" inputMode="numeric" maxLength={6} value={value} autoFocus aria-label="Mã 6 số"
          onChange={e => setValue(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
        {info && <div className="banner ok" role="status">{info}</div>}
        {error && <div className="banner error" role="alert">{error}</div>}
        <button className="btn primary block" type="submit" disabled={busy || value.length !== 6}>{busy && <LoaderCircle size={18} className="spin" />} Xác nhận</button>
        <p className="auth-switch">
          {!twoFactor && <><button type="button" className="link-btn" onClick={resend}>Gửi lại mã</button> · </>}
          <button type="button" className="link-btn" onClick={onLogout}>Đăng xuất</button>
        </p>
      </form>
    </div>
  );
}
