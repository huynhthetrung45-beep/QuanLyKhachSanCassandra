import { useState } from 'react';
import { Eye, EyeOff, LoaderCircle } from 'lucide-react';
import Logo from './Logo';
import { api } from '../api';
import { ForgotPasswordDialog } from '../extensions/AuthExtras';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(mode, form) {
  const errors = {};
  if (mode === 'register') {
    const name = form.displayName.trim();
    if (name.length < 2 || name.length > 50) errors.displayName = 'Tên hiển thị cần từ 2 đến 50 ký tự.';
  }
  if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Nhập email đúng định dạng, ví dụ ten@truong.edu.vn.';
  if (mode === 'login') {
    if (!form.password) errors.password = 'Nhập mật khẩu.';
  } else {
    if (form.password.length < 8) errors.password = 'Mật khẩu cần ít nhất 8 ký tự.';
    else if (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password)) errors.password = 'Mật khẩu cần có cả chữ và số.';
    if (form.confirmPassword !== form.password) errors.confirmPassword = 'Mật khẩu xác nhận không khớp.';
  }
  return errors;
}

function PasswordField({ id, label, value, onChange, error, autoComplete }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={'input-wrap' + (error ? ' has-error' : '')}>
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? id + '-error' : undefined}
        />
        <button
          type="button"
          className="icon-btn ghost"
          onClick={() => setVisible(v => !v)}
          aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
          title={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {error && <p className="field-error" id={id + '-error'}>{error}</p>}
    </div>
  );
}

function TextField({ id, label, value, onChange, error, type = 'text', autoComplete, autoFocus }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={'input-wrap' + (error ? ' has-error' : '')}>
        <input
          id={id}
          type={type}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? id + '-error' : undefined}
        />
      </div>
      {error && <p className="field-error" id={id + '-error'}>{error}</p>}
    </div>
  );
}

const EMPTY = { displayName: '', email: '', password: '', confirmPassword: '' };

export default function AuthScreen({ onLoggedIn, notice }) {
  const [mode, setMode] = useState('login');
  const [forgot, setForgot] = useState(false); // PT-02
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const set = key => e => {
    setForm(f => ({ ...f, [key]: e.target.value }));
    setErrors(err => ({ ...err, [key]: undefined }));
  };

  function switchMode(next) {
    setMode(next);
    setErrors({});
    setFormError('');
    setSuccess('');
    setForm(f => ({ ...EMPTY, email: f.email }));
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const found = validate(mode, form);
    setErrors(found);
    setFormError('');
    setSuccess('');
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      if (mode === 'login') {
        const { user } = await api.login(form.email.trim(), form.password);
        onLoggedIn(user);
      } else {
        await api.register({
          displayName: form.displayName.trim(),
          email: form.email.trim(),
          password: form.password,
          confirmPassword: form.confirmPassword
        });
        setMode('login');
        setForm({ ...EMPTY, email: form.email.trim() });
        setSuccess('Đã tạo tài khoản. Nhập mật khẩu để đăng nhập.');
      }
    } catch (err) {
      if (err.fields) setErrors(err.fields);
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === 'login';

  return (
    <div className="auth-page">
      <section className="auth-brand" aria-hidden="true">
        <div className="auth-brand-top">
          <Logo size={44} />
          <span className="brand-word">ChatOTT</span>
        </div>
        <div className="auth-preview">
          <div className="preview-bubble theirs">Tối nay nhóm mình chốt slide nhé?</div>
          <div className="preview-bubble theirs short">Mình gửi bản mới rồi đó</div>
          <div className="preview-bubble mine">Ok, mình xem rồi góp ý trong nhóm</div>
          <div className="preview-meta">Lịch sử trò chuyện luôn sẵn sàng, cuộn tới đâu tải tới đó.</div>
        </div>
        <p className="auth-brand-foot">Nhắn tin 1-1 và nhóm, đồng bộ trên mọi cửa sổ.</p>
      </section>

      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit} noValidate>
          <div className="auth-mobile-logo"><Logo size={40} /><span className="brand-word dark">ChatOTT</span></div>
          <h1>{isLogin ? 'Đăng nhập' : 'Tạo tài khoản'}</h1>
          <p className="auth-sub">
            {isLogin ? 'Dùng email và mật khẩu bạn đã đăng ký.' : 'Chỉ mất một phút. Bạn sẽ dùng email này để đăng nhập.'}
          </p>

          {notice && isLogin && !success && <div className="banner warn" role="status">{notice}</div>}
          {success && <div className="banner ok" role="status">{success}</div>}
          {formError && <div className="banner error" role="alert">{formError}</div>}

          {!isLogin && (
            <TextField id="displayName" label="Tên hiển thị" value={form.displayName} onChange={set('displayName')}
              error={errors.displayName} autoComplete="name" autoFocus />
          )}
          <TextField id="email" label="Email" type="email" value={form.email} onChange={set('email')}
            error={errors.email} autoComplete="email" autoFocus={isLogin} />
          <PasswordField id="password" label="Mật khẩu" value={form.password} onChange={set('password')}
            error={errors.password} autoComplete={isLogin ? 'current-password' : 'new-password'} />
          {!isLogin && (
            <PasswordField id="confirmPassword" label="Nhập lại mật khẩu" value={form.confirmPassword}
              onChange={set('confirmPassword')} error={errors.confirmPassword} autoComplete="new-password" />
          )}
          {!isLogin && <p className="hint">Ít nhất 8 ký tự, gồm cả chữ và số.</p>}
          {isLogin && (
            <p className="ext-forgot"><button type="button" className="link-btn" onClick={() => setForgot(true)}>Quên mật khẩu?</button></p>
          )}

          <button className="btn primary block" type="submit" disabled={busy}>
            {busy && <LoaderCircle size={18} className="spin" />}
            {isLogin ? (busy ? 'Đang đăng nhập…' : 'Đăng nhập') : (busy ? 'Đang tạo tài khoản…' : 'Tạo tài khoản')}
          </button>

          <p className="auth-switch">
            {isLogin ? 'Chưa có tài khoản?' : 'Đã có tài khoản?'}{' '}
            <button type="button" className="link-btn" onClick={() => switchMode(isLogin ? 'register' : 'login')}>
              {isLogin ? 'Đăng ký' : 'Đăng nhập'}
            </button>
          </p>
        </form>
      </section>
      {forgot && <ForgotPasswordDialog initialEmail={form.email} onClose={() => setForgot(false)} />}
    </div>
  );
}
