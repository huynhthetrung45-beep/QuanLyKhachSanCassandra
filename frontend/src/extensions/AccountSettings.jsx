// Trang cai dat tai khoan: PT-03, PT-04 (ho so), PT-01, PT-09, PT-17, NFR-16 (bao mat),
// PT-25, PT-14 (thong bao), NFR-17 (giao dien toi).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Camera, Image as ImageIcon, KeyRound, LaptopMinimal, LoaderCircle, MailCheck, Palette, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import Avatar from '../components/Avatar';
import QRCode from 'qrcode';
import ImageCropper from './ImageCropper';
import { ext } from './extApi';
import { refreshAvatar } from './avatarStore';
import { disablePush, enablePush, currentSubscription, pushSupported } from './push';
import { getTheme, setTheme } from './theme';
import { formatFull } from '../utils';

const TYPE_LABEL = {
  POST_REACTION: 'Cảm xúc về bài viết', POST_COMMENT: 'Bình luận bài viết', COMMENT_REPLY: 'Trả lời bình luận',
  POST_SHARE: 'Chia sẻ bài viết', FRIEND_REQUEST: 'Lời mời kết bạn', FRIEND_ACCEPT: 'Chấp nhận kết bạn',
  MESSAGE: 'Tin nhắn mới', MENTION: 'Được nhắc tên (@)', TASK_DUE: 'Nhắc hạn công việc',
  GROUP_JOIN_REQUEST: 'Yêu cầu tham gia nhóm', REPORT_UPDATE: 'Kết quả báo cáo vi phạm'
};

function Section({ icon: Icon, title, children }) {
  return (
    <section className="card ext-card">
      <h3 className="ext-card-title"><Icon size={17} /> {title}</h3>
      {children}
    </section>
  );
}

function ProfileTab({ user, onToast, onUserChanged }) {
  const [name, setName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState(null); // { file, kind }
  const fileRef = useRef(null);
  const kindRef = useRef('avatar');

  async function saveName(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await ext.changeDisplayName(name);
      if (r.changed) { onUserChanged({ displayName: r.displayName }); onToast('Đã đổi tên hiển thị.'); }
    } catch (err) {
      onToast(err.fields?.displayName || err.message);
    } finally {
      setBusy(false);
    }
  }
  const pick = kind => { kindRef.current = kind; fileRef.current?.click(); };
  async function upload(blob) {
    const kind = crop.kind;
    setCrop(null);
    try {
      await (kind === 'avatar' ? ext.uploadAvatar(blob) : ext.uploadCover(blob));
      refreshAvatar(user.userId);
      onToast(kind === 'avatar' ? 'Đã cập nhật ảnh đại diện.' : 'Đã cập nhật ảnh bìa.');
    } catch (err) {
      onToast(err.message);
    }
  }
  async function remove(kind) {
    try {
      await (kind === 'avatar' ? ext.removeAvatar() : ext.removeCover());
      refreshAvatar(user.userId);
      onToast('Đã xóa ảnh.');
    } catch (err) {
      onToast(err.message);
    }
  }
  return (
    <>
      <Section icon={UserRound} title="Tên hiển thị">
        <form className="ext-row" onSubmit={saveName}>
          <input className="ext-input" value={name} maxLength={50} onChange={e => setName(e.target.value)} aria-label="Tên hiển thị" />
          <button type="submit" className="btn primary small" disabled={busy || name.trim() === user.displayName || name.trim().length < 2}>Lưu</button>
        </form>
        <p className="muted ext-note">2–50 ký tự. Mọi người tìm được bạn theo tên mới ngay sau khi lưu.</p>
      </Section>
      <Section icon={Camera} title="Ảnh đại diện & ảnh bìa">
        <div className="ext-row">
          <Avatar name={user.displayName} seed={user.userId} size={72} />
          <div className="ext-col">
            <button type="button" className="btn secondary small" onClick={() => pick('avatar')}><Camera size={15} /> Đổi ảnh đại diện</button>
            <button type="button" className="btn secondary small" onClick={() => pick('cover')}><ImageIcon size={15} /> Đổi ảnh bìa</button>
          </div>
          <div className="ext-col">
            <button type="button" className="btn secondary small" onClick={() => remove('avatar')}><Trash2 size={15} /> Xóa ảnh đại diện</button>
            <button type="button" className="btn secondary small" onClick={() => remove('cover')}><Trash2 size={15} /> Xóa ảnh bìa</button>
          </div>
        </div>
        <p className="muted ext-note">JPG, PNG, WEBP, GIF. Ảnh đại diện tối đa 5 MB, ảnh bìa 8 MB.</p>
        <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif"
          onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) setCrop({ file: f, kind: kindRef.current }); }} />
      </Section>
      {crop && (
        <ImageCropper file={crop.file} aspect={crop.kind === 'avatar' ? 1 : 3} outWidth={crop.kind === 'avatar' ? 512 : 1200}
          title={crop.kind === 'avatar' ? 'Cắt ảnh đại diện' : 'Cắt ảnh bìa'} onCancel={() => setCrop(null)} onDone={upload} />
      )}
    </>
  );
}

// Ma QR otpauth:// sinh ngay tren trinh duyet (khoa bi mat khong gui ra dich vu ngoai).
function TotpQr({ url }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 200, errorCorrectionLevel: 'M' })
      .then(data => alive && setSrc(data)).catch(() => alive && setSrc(null));
    return () => { alive = false; };
  }, [url]);
  return src ? <img className="ext-qr" src={src} width={200} height={200} alt="Mã QR thiết lập xác thực hai lớp" /> : null;
}

function SecurityTab({ onToast }) {
  const [sec, setSec] = useState(null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [pwError, setPwError] = useState('');
  const [sessions, setSessions] = useState([]);
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState(null);
  const [twoCode, setTwoCode] = useState('');

  const load = useCallback(() => {
    ext.security().then(setSec).catch(err => onToast(err.message));
    ext.sessions().then(r => setSessions(r.items)).catch(() => {});
  }, [onToast]);
  useEffect(() => { load(); }, [load]);

  async function changePw(e) {
    e.preventDefault();
    setPwError('');
    try {
      const r = await ext.changePassword(pw);
      setPw({ currentPassword: '', newPassword: '', confirmPassword: '' });
      onToast(`Đã đổi mật khẩu. Đăng xuất ${r.revokedSessions} phiên khác.`);
      load();
    } catch (err) {
      setPwError(Object.values(err.fields || {})[0] || err.message);
    }
  }
  const run = async (fn, ok) => {
    try { await fn(); if (ok) onToast(ok); load(); } catch (err) { onToast(err.message); }
  };

  if (!sec) return <p className="muted pad"><LoaderCircle size={15} className="spin" /> Đang tải…</p>;
  return (
    <>
      <Section icon={KeyRound} title="Đổi mật khẩu">
        <form className="ext-form" onSubmit={changePw}>
          <input className="ext-input" type="password" placeholder="Mật khẩu hiện tại" autoComplete="current-password" value={pw.currentPassword}
            onChange={e => setPw(p => ({ ...p, currentPassword: e.target.value }))} aria-label="Mật khẩu hiện tại" />
          <input className="ext-input" type="password" placeholder="Mật khẩu mới (8+ ký tự, có chữ và số)" autoComplete="new-password" value={pw.newPassword}
            onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} aria-label="Mật khẩu mới" />
          <input className="ext-input" type="password" placeholder="Nhập lại mật khẩu mới" autoComplete="new-password" value={pw.confirmPassword}
            onChange={e => setPw(p => ({ ...p, confirmPassword: e.target.value }))} aria-label="Nhập lại mật khẩu mới" />
          {pwError && <p className="field-error" role="alert">{pwError}</p>}
          <button type="submit" className="btn primary small" disabled={!pw.currentPassword || !pw.newPassword}>Đổi mật khẩu</button>
          <p className="muted ext-note">Đổi xong, mọi phiên đăng nhập khác của bạn sẽ bị đăng xuất.</p>
        </form>
      </Section>

      <Section icon={MailCheck} title="Xác minh email">
        <p>{sec.email || 'Chưa xác định email'} · {sec.emailVerified
          ? <strong className="ext-ok">Đã xác minh {sec.emailVerifiedAt ? `(${formatFull(sec.emailVerifiedAt)})` : ''}</strong>
          : <strong className="ext-warn">Chưa xác minh</strong>}</p>
        {!sec.emailVerified && (
          <div className="ext-row">
            <button type="button" className="btn secondary small" onClick={() => run(ext.sendVerification, 'Đã gửi mã xác minh tới email của bạn.')}>Gửi mã</button>
            <input className="ext-input ext-short" inputMode="numeric" maxLength={6} placeholder="Mã 6 số" value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))} aria-label="Mã xác minh" />
            <button type="button" className="btn primary small" disabled={code.length !== 6}
              onClick={() => run(() => ext.verifyEmail(code), 'Đã xác minh email.')}>Xác minh</button>
          </div>
        )}
      </Section>

      <Section icon={ShieldCheck} title="Xác thực hai lớp (TOTP)">
        {sec.twoFactorEnabled ? (
          <>
            <p className="ext-ok">Đang bật. Mỗi lần đăng nhập trên thiết bị mới cần mã từ ứng dụng xác thực.</p>
            <div className="ext-row">
              <input className="ext-input ext-short" inputMode="numeric" maxLength={6} placeholder="Mã 6 số" value={twoCode}
                onChange={e => setTwoCode(e.target.value.replace(/\D/g, ''))} aria-label="Mã xác thực" />
              <button type="button" className="btn secondary small" disabled={twoCode.length !== 6}
                onClick={() => run(async () => { await ext.disable2fa(twoCode); setTwoCode(''); }, 'Đã tắt xác thực hai lớp.')}>Tắt 2FA</button>
            </div>
          </>
        ) : setup ? (
          <>
            <p>1. Mở ứng dụng xác thực và quét mã QR, hoặc nhập <strong>khóa thiết lập</strong> bên dưới:</p>
            <TotpQr url={setup.otpauthUrl} />
            <code className="ext-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            <p><a href={setup.otpauthUrl} className="link-btn">Mở bằng ứng dụng xác thực</a></p>
            <p>2. Nhập mã 6 số đang hiển thị để bật:</p>
            <div className="ext-row">
              <input className="ext-input ext-short" inputMode="numeric" maxLength={6} placeholder="Mã 6 số" value={twoCode}
                onChange={e => setTwoCode(e.target.value.replace(/\D/g, ''))} aria-label="Mã xác thực" />
              <button type="button" className="btn primary small" disabled={twoCode.length !== 6}
                onClick={() => run(async () => { await ext.enable2fa(twoCode); setSetup(null); setTwoCode(''); }, 'Đã bật xác thực hai lớp.')}>Bật 2FA</button>
            </div>
          </>
        ) : (
          <button type="button" className="btn secondary small" onClick={() => run(async () => setSetup(await ext.setup2fa()))}>Thiết lập 2FA</button>
        )}
      </Section>

      <Section icon={LaptopMinimal} title="Thiết bị đang đăng nhập">
        <ul className="ext-list">
          {sessions.map(s => (
            <li key={s.sessionId}>
              <span className="ext-grow"><strong>{s.device}</strong>{s.current && <span className="ext-badge">Thiết bị này</span>}
                <span className="muted ext-sub">IP {s.ip || '—'} · hoạt động {s.lastSeenAt ? formatFull(s.lastSeenAt) : '—'}</span></span>
              {!s.current && <button type="button" className="btn secondary small" onClick={() => run(() => ext.revokeSession(s.sessionId), 'Đã đăng xuất thiết bị.')}>Đăng xuất</button>}
            </li>
          ))}
        </ul>
        {sessions.length > 1 && (
          <button type="button" className="btn secondary small" onClick={() => run(ext.revokeOtherSessions, 'Đã đăng xuất mọi thiết bị khác.')}>Đăng xuất tất cả thiết bị khác</button>
        )}
      </Section>
    </>
  );
}

function NotificationTab({ onToast }) {
  const [types, setTypes] = useState(null);
  const [push, setPush] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ext.notificationSettings().then(r => setTypes(r.types)).catch(err => onToast(err.message));
    currentSubscription().then(s => setPush(Boolean(s))).catch(() => {});
  }, [onToast]);
  async function toggle(type) {
    const next = !types[type];
    setTypes(t => ({ ...t, [type]: next }));
    try { setTypes((await ext.updateNotificationSettings({ [type]: next })).types); } catch (err) { onToast(err.message); }
  }
  async function togglePush() {
    setBusy(true);
    try {
      if (push) { await disablePush(); setPush(false); onToast('Đã tắt thông báo đẩy trên trình duyệt này.'); }
      else { await enablePush(); setPush(true); onToast('Đã bật thông báo đẩy.'); }
    } catch (err) {
      onToast(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Section icon={Bell} title="Thông báo đẩy (Web Push)">
        <p>Nhận thông báo cả khi đã đóng tab ChatOTT.</p>
        {pushSupported()
          ? <button type="button" className={'btn small ' + (push ? 'secondary' : 'primary')} disabled={busy} onClick={togglePush}>{push ? 'Tắt thông báo đẩy' : 'Bật thông báo đẩy'}</button>
          : <p className="muted">Trình duyệt này không hỗ trợ thông báo đẩy.</p>}
      </Section>
      <Section icon={Bell} title="Loại thông báo muốn nhận">
        {!types ? <p className="muted"><LoaderCircle size={14} className="spin" /> Đang tải…</p> : (
          <ul className="ext-list">
            {Object.keys(types).map(t => (
              <li key={t}>
                <span className="ext-grow">{TYPE_LABEL[t] || t}</span>
                <button type="button" role="switch" aria-checked={types[t]} aria-label={TYPE_LABEL[t] || t}
                  className={'switch' + (types[t] ? ' on' : '')} onClick={() => toggle(t)} />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function AppearanceTab() {
  const [theme, setT] = useState(getTheme());
  const choose = t => { setT(t); setTheme(t); };
  return (
    <Section icon={Palette} title="Giao diện">
      <div className="ext-row">
        {[['system', 'Theo hệ thống'], ['light', 'Sáng'], ['dark', 'Tối']].map(([k, l]) => (
          <button key={k} type="button" className={'btn small ' + (theme === k ? 'primary' : 'secondary')} onClick={() => choose(k)}>{l}</button>
        ))}
      </div>
      <p className="muted ext-note">Cài đặt PWA: dùng menu trình duyệt "Cài đặt ứng dụng" / "Thêm vào màn hình chính".</p>
    </Section>
  );
}

export default function AccountSettings({ user, onClose, onToast, onUserChanged, initialTab = 'profile' }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <section className="posts-page" aria-label="Cài đặt tài khoản">
      <div className="posts-scroll">
        <div className="posts-col">
          <div className="notif-head">
            <h2 className="posts-title">Cài đặt tài khoản</h2>
            {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>}
          </div>
          <div className="filters ext-tabs" role="tablist">
            {[['profile', 'Hồ sơ'], ['security', 'Bảo mật'], ['notifications', 'Thông báo'], ['appearance', 'Giao diện']].map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>
          {tab === 'profile' && <ProfileTab user={user} onToast={onToast} onUserChanged={onUserChanged} />}
          {tab === 'security' && <SecurityTab onToast={onToast} />}
          {tab === 'notifications' && <NotificationTab onToast={onToast} />}
          {tab === 'appearance' && <AppearanceTab />}
        </div>
      </div>
    </section>
  );
}
