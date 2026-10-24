import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Newspaper, Pencil, X } from 'lucide-react';
import Avatar from './Avatar';
import RelationActions from './RelationActions';
import { ReportUserButton } from '../extensions/SocialExtras';
import { api } from '../api';

// Xem ho so (nguoi khac) hoac xem + sua ho so (chinh minh). Khong hien email nguoi khac.
export default function ProfileModal({ userId, me, onClose, onMessage, onToast, onRelationChanged, onViewPage }) {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ username: '', bio: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const isMe = userId === me.userId;

  const load = useCallback(() => {
    api.profile(userId)
      .then(p => { setProfile(p); setForm({ username: p.username || '', bio: p.bio || '' }); setError(''); })
      .catch(err => setError(err.message));
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && !editing && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const p = await api.updateProfile({ username: form.username.trim() || null, bio: form.bio });
      setProfile(p);
      setEditing(false);
      onToast?.('Đã lưu hồ sơ.');
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog profile-dialog" role="dialog" aria-modal="true" aria-label="Hồ sơ">
        <button type="button" className="icon-btn profile-close" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        {error && <p className="error-text">{error}</p>}
        {!profile && !error && <p className="muted"><LoaderCircle size={15} className="spin" /> Đang tải hồ sơ…</p>}
        {profile && (
          <>
            <div className="profile-cover" aria-hidden="true" style={profile.coverUrl ? { backgroundImage: `url(${profile.coverUrl})` } : undefined} />
            <div className="profile-head">
              <Avatar name={profile.displayName} seed={profile.userId} size={84} />
              <h3>{profile.displayName}</h3>
              {profile.username && <p className="muted">@{profile.username}</p>}
              {isMe && me.email && <p className="muted small-note">Email (chỉ bạn thấy): {me.email}</p>}
            </div>

            {editing ? (
              <form className="profile-form" onSubmit={save}>
                <label className="field-label" htmlFor="pf-username">Tên người dùng</label>
                <div className="input-wrap"><span className="muted">@</span>
                  <input id="pf-username" value={form.username} maxLength={30} autoComplete="off"
                    onChange={e => setForm(f => ({ ...f, username: e.target.value.toLowerCase() }))} placeholder="vd. nguyen.an" />
                </div>
                <p className="hint-inline">3–30 ký tự: chữ thường không dấu, số, dấu chấm, gạch dưới.</p>
                <label className="field-label" htmlFor="pf-bio">Giới thiệu</label>
                <textarea id="pf-bio" className="profile-bio-input" rows={3} maxLength={300} value={form.bio}
                  onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} placeholder="Vài dòng về bạn" />
                <p className="hint-inline">{form.bio.length}/300</p>
                {formError && <p className="error-text" role="alert">{formError}</p>}
                <div className="dialog-actions">
                  <button type="button" className="btn secondary" onClick={() => { setEditing(false); setFormError(''); }}>Hủy</button>
                  <button type="submit" className="btn primary" disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
                </div>
              </form>
            ) : (
              <>
                <p className={'profile-bio' + (profile.bio ? '' : ' muted')}>{profile.bio || (isMe ? 'Bạn chưa viết giới thiệu.' : 'Chưa có giới thiệu.')}</p>
                {onViewPage && (
                  <div className="rel-actions" style={{ marginBottom: 8 }}>
                    <button type="button" className="btn small secondary" onClick={() => { onClose(); onViewPage(profile.userId); }}>
                      <Newspaper size={15} /> {isMe ? 'Trang cá nhân của tôi' : 'Xem trang cá nhân'}</button>
                  </div>
                )}
                {isMe ? (
                  <div className="rel-actions"><button type="button" className="btn small secondary" onClick={() => setEditing(true)}>
                    <Pencil size={15} /> Sửa hồ sơ</button></div>
                ) : (
                  <RelationActions
                    userId={profile.userId}
                    displayName={profile.displayName}
                    relationship={profile.relationship}
                    onToast={onToast}
                    onMessage={onMessage ? id => { onClose(); onMessage(id); } : null}
                    onChanged={() => { load(); onRelationChanged?.(); }}
                  />
                )}
                {!isMe && (
                  <div className="rel-actions ext-report-user"><ReportUserButton userId={profile.userId} displayName={profile.displayName} onToast={onToast} /></div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
