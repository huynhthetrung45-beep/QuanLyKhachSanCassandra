// Tab "Quan ly" trong panel thong tin: PT-11 tat thong bao / luu tru (moi hoi thoai),
// PT-10 anh & mo ta nhom, PT-05 vai tro, PT-19 link moi + duyet thanh vien (nhom).
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, BellOff, Camera, Copy, Crown, Link2, LoaderCircle, Shield, Trash2, UserCheck, UserX } from 'lucide-react';
import Avatar from '../components/Avatar';
import ImageCropper from './ImageCropper';
import { ext } from './extApi';
import { useSse } from './sse';
import { refreshAvatar } from './avatarStore';
import { usePrefs } from './prefsStore';
import { formatFull } from '../utils';

const ROLE_LABEL = { OWNER: 'Trưởng nhóm', DEPUTY: 'Phó nhóm', MEMBER: 'Thành viên' };

function PrefsSection({ conversationId, onToast }) {
  const prefs = usePrefs()[conversationId] || {};
  async function set(payload, msg) {
    try { await ext.setPrefs(conversationId, payload); onToast(msg); } catch (err) { onToast(err.message); }
  }
  return (
    <section className="info-section">
      <h5><BellOff size={14} /> Thông báo & lưu trữ</h5>
      <p className="muted ext-note">{prefs.muted ? (prefs.mutedForever ? 'Đã tắt thông báo đến khi bật lại.' : `Tắt thông báo đến ${formatFull(prefs.mutedUntil)}.`) : 'Đang nhận thông báo tin nhắn.'}</p>
      <div className="ext-row wrap">
        {prefs.muted
          ? <button type="button" className="btn secondary small" onClick={() => set({ mute: 'off' }, 'Đã bật lại thông báo.')}>Bật thông báo</button>
          : [['1h', '1 giờ'], ['8h', '8 giờ'], ['forever', 'Đến khi bật lại']].map(([k, l]) => (
            <button key={k} type="button" className="btn secondary small" onClick={() => set({ mute: k }, `Đã tắt thông báo (${l.toLowerCase()}).`)}>Tắt {l}</button>
          ))}
        <button type="button" className="btn secondary small" onClick={() => set({ archived: !prefs.archived }, prefs.archived ? 'Đã đưa khỏi lưu trữ.' : 'Đã lưu trữ hội thoại.')}>
          <Archive size={14} /> {prefs.archived ? 'Bỏ lưu trữ' : 'Lưu trữ'}</button>
      </div>
    </section>
  );
}

export default function ConversationManageTab({ conversation, user, members = [], onToast, onChanged }) {
  const id = conversation.conversationId;
  const isGroup = conversation.conversationType === 'GROUP';
  const [roles, setRoles] = useState(null);
  const [profile, setProfile] = useState(null);
  const [desc, setDesc] = useState('');
  const [invites, setInvites] = useState(null);
  const [crop, setCrop] = useState(null);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    if (!isGroup) return;
    try {
      const [r, p] = await Promise.all([ext.roles(id), ext.groupProfile(id)]);
      setRoles(r);
      setProfile(p);
      setDesc(p.description);
      if (r.canManage) setInvites(await ext.invites(id)); else setInvites(null);
    } catch (err) {
      onToast(err.message);
    }
  }, [id, isGroup, onToast]);
  useEffect(() => { load(); }, [load]);
  useSse(['group:updated'], d => d.conversationId === id && load());

  const run = async (fn, msg) => {
    try { const r = await fn(); if (msg) onToast(msg); await load(); onChanged?.(); return r; } catch (err) { onToast(err.message); return null; }
  };
  async function uploadAvatar(blob) {
    setCrop(null);
    await run(() => ext.uploadGroupAvatar(id, blob), 'Đã đổi ảnh nhóm.');
    refreshAvatar(id);
  }
  const inviteUrl = code => `${window.location.origin}/?invite=${code}`;
  const copy = code => navigator.clipboard?.writeText(inviteUrl(code)).then(() => onToast('Đã sao chép link mời.'), () => onToast(inviteUrl(code)));

  return (
    <div className="info-scroll">
      <PrefsSection conversationId={id} onToast={onToast} />
      {isGroup && !roles && <p className="muted pad"><LoaderCircle size={14} className="spin" /> Đang tải…</p>}
      {isGroup && roles && (
        <>
          <section className="info-section">
            <h5><Camera size={14} /> Ảnh & mô tả nhóm</h5>
            <div className="ext-row">
              <Avatar name={conversation.displayName} seed={id} group size={56} />
              {profile?.canEdit && (
                <div className="ext-col">
                  <button type="button" className="btn secondary small" onClick={() => fileRef.current?.click()}><Camera size={14} /> Đổi ảnh nhóm</button>
                  {profile.avatarUrl && <button type="button" className="btn secondary small" onClick={async () => { await run(() => ext.removeGroupAvatar(id), 'Đã xóa ảnh nhóm.'); refreshAvatar(id); }}><Trash2 size={14} /> Xóa ảnh</button>}
                </div>
              )}
            </div>
            {profile?.canEdit ? (
              <>
                <textarea className="ext-input ext-textarea" rows={3} maxLength={500} value={desc} onChange={e => setDesc(e.target.value)} placeholder="Mô tả nhóm" aria-label="Mô tả nhóm" />
                <button type="button" className="btn primary small" disabled={desc === profile.description} onClick={() => run(() => ext.updateGroupProfile(id, desc), 'Đã lưu mô tả nhóm.')}>Lưu mô tả</button>
              </>
            ) : <p className={profile?.description ? '' : 'muted'}>{profile?.description || 'Nhóm chưa có mô tả.'}</p>}
            <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif"
              onChange={e => { const f = e.target.files[0]; e.target.value = ''; if (f) setCrop(f); }} />
          </section>

          <section className="info-section">
            <h5><Shield size={14} /> Vai trò · bạn là {ROLE_LABEL[roles.myRole]}</h5>
            {roles.canClaimOwner && (
              <div className="banner warn">Nhóm chưa có trưởng nhóm.{' '}
                <button type="button" className="link-btn" onClick={() => run(() => ext.claimOwner(id), 'Bạn đã là trưởng nhóm.')}>Nhận quyền trưởng nhóm</button></div>
            )}
            <ul className="ext-list">
              {members.map(m => {
                const role = roles.roles[m.userId] || 'MEMBER';
                return (
                  <li key={m.userId}>
                    <Avatar name={m.displayName} seed={m.userId} size={30} />
                    <span className="ext-grow">{m.displayName}{m.userId === user.userId ? ' (bạn)' : ''}
                      <span className={'ext-badge role-' + role.toLowerCase()}>{role === 'OWNER' && <Crown size={11} />} {ROLE_LABEL[role]}</span></span>
                    {roles.canAssignRoles && m.userId !== user.userId && (
                      <select className="ext-input ext-select" value={role} aria-label={'Vai trò của ' + m.displayName}
                        onChange={e => {
                          const next = e.target.value;
                          if (next === 'OWNER' && !window.confirm(`Chuyển quyền trưởng nhóm cho ${m.displayName}? Bạn sẽ trở thành phó nhóm.`)) return;
                          run(() => ext.setRole(id, m.userId, next), 'Đã cập nhật vai trò.');
                        }}>
                        <option value="MEMBER">Thành viên</option>
                        <option value="DEPUTY">Phó nhóm</option>
                        <option value="OWNER">Trưởng nhóm</option>
                      </select>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="muted ext-note">Phó nhóm được đổi tên, sửa ảnh/mô tả, tạo link mời, duyệt và xóa thành viên thường.</p>
          </section>

          {roles.canManage && invites && (
            <section className="info-section">
              <h5><Link2 size={14} /> Link mời vào nhóm</h5>
              <div className="ext-row wrap">
                <button type="button" className="btn secondary small" onClick={() => run(() => ext.createInvite(id, false), 'Đã tạo link mời.')}>Tạo link</button>
                <button type="button" className="btn secondary small" onClick={() => run(() => ext.createInvite(id, true), 'Đã tạo link mời cần duyệt.')}>Tạo link cần duyệt</button>
              </div>
              <ul className="ext-list">
                {invites.items.map(i => (
                  <li key={i.code}>
                    <span className="ext-grow"><code>{i.code}</code><span className="muted ext-sub">{i.requireApproval ? 'Cần duyệt' : 'Vào ngay'} · {formatFull(i.createdAt)}</span></span>
                    <button type="button" className="icon-btn ghost small" onClick={() => copy(i.code)} aria-label="Sao chép link" title="Sao chép link"><Copy size={14} /></button>
                    <button type="button" className="icon-btn ghost small" onClick={() => run(() => ext.revokeInvite(id, i.code), 'Đã thu hồi link.')} aria-label="Thu hồi link" title="Thu hồi"><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
              {invites.requests.length > 0 && (
                <>
                  <h5>Yêu cầu tham gia ({invites.requests.length})</h5>
                  <ul className="ext-list">
                    {invites.requests.map(r => (
                      <li key={r.userId}>
                        <Avatar name={r.displayName} seed={r.userId} size={30} />
                        <span className="ext-grow">{r.displayName}<span className="muted ext-sub">{formatFull(r.requestedAt)}</span></span>
                        <button type="button" className="icon-btn ghost small" title="Duyệt" aria-label={'Duyệt ' + r.displayName} onClick={() => run(() => ext.decideJoin(id, r.userId, true), 'Đã duyệt thành viên.')}><UserCheck size={15} /></button>
                        <button type="button" className="icon-btn ghost small" title="Từ chối" aria-label={'Từ chối ' + r.displayName} onClick={() => run(() => ext.decideJoin(id, r.userId, false), 'Đã từ chối.')}><UserX size={15} /></button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </>
      )}
      {crop && <ImageCropper file={crop} aspect={1} title="Cắt ảnh nhóm" onCancel={() => setCrop(null)} onDone={uploadAvatar} />}
    </div>
  );
}
