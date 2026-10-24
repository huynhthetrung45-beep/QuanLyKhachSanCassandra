// Danh sach cuoc hop, tao cuoc hop (lich hoac hop nhanh), chi tiet: loi moi, phan hoi, link moi, doi lich, huy, lich su tham gia.
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, Copy, Link2, LoaderCircle, Plus, Video, X } from 'lucide-react';
import UserPicker from '../components/UserPicker';
import { copyText } from '../utils';
import { useSse } from './sse';
import { ConflictBox, useGroupMembers } from './TaskDialogs';
import { fmtDateTime, fmtRange, fromLocalInput, newIdemKey, toLocalInput, work } from './workApi';

const joinMeeting = id => window.dispatchEvent(new CustomEvent('chatott:join-meeting', { detail: { meetingId: id } }));
const INV = { PENDING: 'Chưa phản hồi', ACCEPTED: 'Tham gia', DECLINED: 'Từ chối' };

export function MeetingForm({ user, groups, initial = {}, onClose, onSaved, onToast }) {
  const [f, setF] = useState(() => {
    const now = new Date();
    now.setMinutes(Math.ceil(now.getMinutes() / 30) * 30 + 30, 0, 0);
    return {
      title: '', description: '', conversationId: initial.conversationId || '', instant: false,
      start: toLocalInput(initial.start || now), end: toLocalInput(initial.end || new Date(now.getTime() + 3600000))
    };
  });
  const [people, setPeople] = useState([]);
  const [groupInvite, setGroupInvite] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [key] = useState(newIdemKey);
  const members = useGroupMembers(f.conversationId);
  const set = (k, v) => { setF(x => ({ ...x, [k]: v })); setError(null); };

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { title: f.title, description: f.description, instant: f.instant };
      if (!f.instant) { body.start = fromLocalInput(f.start); body.end = fromLocalInput(f.end); }
      if (f.conversationId) { body.conversationId = f.conversationId; body.inviteeIds = groupInvite; body.joinPolicy = 'GROUP'; }
      else body.inviteeIds = people.map(p => p.userId);
      const m = await work.createMeeting(body, key);
      if (m.warnings?.length) onToast(`Lưu ý: ${m.warnings.map(w => w.displayName).join(', ')} đang có lịch khác.`);
      else onToast(f.instant ? 'Đã tạo cuộc họp nhanh.' : 'Đã lên lịch cuộc họp.');
      onSaved(m);
      if (f.instant) joinMeeting(m.meetingId);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog wk-dialog" onSubmit={submit} aria-label="Tạo cuộc họp">
        <div className="wk-dialog-head"><h3>Cuộc họp mới</h3>
          <button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}><X size={18} /></button></div>
        <div className="wk-dialog-body">
          <div className="wk-tabs" role="tablist">
            <button type="button" className={!f.instant ? 'active' : ''} onClick={() => set('instant', false)}><CalendarClock size={14} /> Lên lịch</button>
            <button type="button" className={f.instant ? 'active' : ''} onClick={() => set('instant', true)}><Video size={14} /> Họp ngay</button>
          </div>
          <div className="field"><label htmlFor="mt-title">Tiêu đề</label>
            <input id="mt-title" className="input" maxLength={200} value={f.title} required={!f.instant} placeholder={f.instant ? 'Cuộc họp nhanh' : ''} onChange={e => set('title', e.target.value)} /></div>
          <div className="field"><label htmlFor="mt-desc">Nội dung</label>
            <textarea id="mt-desc" className="input" rows={2} maxLength={2000} value={f.description} onChange={e => set('description', e.target.value)} /></div>
          {!f.instant && (
            <div className="wk-row">
              <div className="field"><label htmlFor="mt-start">Bắt đầu</label><input id="mt-start" type="datetime-local" className="input" value={f.start} onChange={e => set('start', e.target.value)} /></div>
              <div className="field"><label htmlFor="mt-end">Kết thúc</label><input id="mt-end" type="datetime-local" className="input" value={f.end} onChange={e => set('end', e.target.value)} /></div>
            </div>
          )}
          <div className="field"><label htmlFor="mt-scope">Họp với</label>
            <select id="mt-scope" className="input" value={f.conversationId} onChange={e => { set('conversationId', e.target.value); setGroupInvite([]); }}>
              <option value="">Người được chọn</option>
              {groups.map(g => <option key={g.conversationId} value={g.conversationId}>Nhóm: {g.conversationName}</option>)}
            </select></div>
          {f.conversationId ? (
            <div className="field"><span className="field-label">Gửi lời mời ({groupInvite.length}) · mọi thành viên nhóm đều vào được</span>
              <div className="wk-members">
                <button type="button" className="link-btn" onClick={() => setGroupInvite(members.filter(m => m.userId !== user.userId).map(m => m.userId))}>Mời tất cả</button>
                {members.filter(m => m.userId !== user.userId).map(m => (
                  <label key={m.userId} className={'wk-member' + (groupInvite.includes(m.userId) ? ' on' : '')}>
                    <input type="checkbox" checked={groupInvite.includes(m.userId)}
                      onChange={() => setGroupInvite(l => (l.includes(m.userId) ? l.filter(x => x !== m.userId) : [...l, m.userId]))} /> {m.displayName}
                  </label>
                ))}
              </div></div>
          ) : (
            <div className="field"><span className="field-label">Người được mời</span>
              <UserPicker selected={people} onChange={setPeople} excludeIds={[user.userId]} /></div>
          )}
          <ConflictBox error={error} onPick={s => { set('start', toLocalInput(s.start)); set('end', toLocalInput(s.end)); }} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Hủy</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Đang tạo…' : f.instant ? 'Tạo và vào phòng' : 'Lên lịch'}</button>
        </div>
      </form>
    </div>
  );
}

export function MeetingDetail({ meetingId, onClose, onToast }) {
  const [m, setM] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [history, setHistory] = useState(null);
  const [edit, setEdit] = useState(null);
  const [invite, setInvite] = useState([]);

  const load = useCallback(() => work.meeting(meetingId).then(r => { setM(r); setError(null); }).catch(setError), [meetingId]);
  useEffect(() => { load(); }, [load]);
  useSse('meeting:changed', d => d?.meetingId === meetingId && load());

  const act = async (fn, ok) => {
    setActionError(null);
    try { const r = await fn(); if (ok) onToast(ok); await load(); return r; } catch (err) { setActionError(err); return null; }
  };
  const linkUrl = code => `${window.location.origin}${window.location.pathname}?meetingInvite=${code}`;
  const open = m && ['SCHEDULED', 'LIVE'].includes(m.status);

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog wk-dialog" role="dialog" aria-modal="true" aria-label="Chi tiết cuộc họp">
        <div className="wk-dialog-head"><h3>{m?.title || 'Cuộc họp'}</h3>
          <button type="button" className="icon-btn" aria-label="Đóng" onClick={onClose}><X size={18} /></button></div>
        {error && <p className="error-text pad">{error.message}</p>}
        {!m && !error && <p className="muted pad"><LoaderCircle size={16} className="spin" /> Đang tải…</p>}
        {m && (
          <div className="wk-dialog-body">
            <div className="wk-meta">
              <span className={`wk-pill mt-${m.status}`}>{m.statusLabel}</span>
              {m.liveCount > 0 && <span className="wk-pill st-IN_PROGRESS">{m.liveCount} người đang trong phòng</span>}
              <span className="muted">Tổ chức: {m.organizer.displayName}</span>
            </div>
            {m.description && <p className="wk-desc">{m.description}</p>}
            <p><CalendarClock size={15} /> {fmtRange(m.start, m.end)}</p>
            {m.actualStart && <p className="muted">Bắt đầu thực tế {fmtDateTime(m.actualStart)}{m.actualEnd ? ` · kết thúc ${fmtDateTime(m.actualEnd)}` : ''}</p>}
            <div className="wk-actions">
              {m.canJoin && <button type="button" className="btn primary" onClick={() => { joinMeeting(m.meetingId); onClose(); }}><Video size={15} /> Vào phòng họp</button>}
              {!m.canJoin && open && <span className="muted">Phòng mở 15 phút trước giờ bắt đầu.</span>}
              {open && m.myInvitation && m.myInvitation !== 'ACCEPTED' && <button type="button" className="btn small secondary" onClick={() => act(() => work.respondMeeting(m.meetingId, 'ACCEPTED'), 'Đã nhận lời mời.')}><Check size={14} /> Tham gia</button>}
              {open && m.myInvitation && m.myInvitation !== 'DECLINED' && <button type="button" className="btn small secondary" onClick={() => act(() => work.respondMeeting(m.meetingId, 'DECLINED'), 'Đã từ chối.')}>Từ chối</button>}
            </div>
            {m.isOrganizer && open && (
              <div className="wk-actions">
                {m.inviteCode
                  ? <>
                    <button type="button" className="btn small secondary" onClick={() => copyText(linkUrl(m.inviteCode)).then(() => onToast('Đã sao chép link mời.'))}><Copy size={14} /> Sao chép link mời</button>
                    <button type="button" className="btn small secondary" onClick={() => act(() => work.revokeMeetingLink(m.meetingId), 'Đã thu hồi link.')}>Thu hồi link</button>
                  </>
                  : <button type="button" className="btn small secondary" onClick={() => act(() => work.meetingLink(m.meetingId), 'Đã tạo link mời.')}><Link2 size={14} /> Tạo link mời</button>}
                {m.status === 'SCHEDULED' && <button type="button" className="btn small secondary" onClick={() => setEdit({ start: toLocalInput(m.start), end: toLocalInput(m.end) })}>Đổi lịch</button>}
                {m.status === 'LIVE' && <button type="button" className="btn small danger" onClick={() => act(() => work.endMeeting(m.meetingId), 'Đã kết thúc cuộc họp.')}>Kết thúc</button>}
                <button type="button" className="btn small danger" onClick={() => act(() => work.cancelMeeting(m.meetingId), 'Đã hủy cuộc họp.')} disabled={m.status === 'LIVE'}>Hủy cuộc họp</button>
              </div>
            )}
            {edit && (
              <div className="wk-inline">
                <input type="datetime-local" className="input" aria-label="Bắt đầu" value={edit.start} onChange={e => setEdit(x => ({ ...x, start: e.target.value }))} />
                <input type="datetime-local" className="input" aria-label="Kết thúc" value={edit.end} onChange={e => setEdit(x => ({ ...x, end: e.target.value }))} />
                <button type="button" className="btn small primary" onClick={async () => { if (await act(() => work.rescheduleMeeting(m.meetingId, { start: fromLocalInput(edit.start), end: fromLocalInput(edit.end) }), 'Đã đổi lịch.')) setEdit(null); }}>Lưu</button>
                <button type="button" className="btn small secondary" onClick={() => setEdit(null)}>Hủy</button>
              </div>
            )}
            <ConflictBox error={actionError} onPick={s => setEdit({ start: toLocalInput(s.start), end: toLocalInput(s.end) })} />
            <h4 className="wk-h4">Khách mời ({m.invitations.length})</h4>
            <ul className="wk-invites">
              {m.invitations.map(i => <li key={i.userId}>{i.displayName}<span className={`wk-pill inv-${i.status}`}>{INV[i.status]}</span></li>)}
            </ul>
            {m.isOrganizer && open && (
              <div className="field">
                <UserPicker selected={invite} onChange={setInvite} excludeIds={[m.organizer.userId, ...m.invitations.map(i => i.userId)]} />
                {invite.length > 0 && <button type="button" className="btn small primary" onClick={async () => {
                  const r = await act(() => work.inviteMeeting(m.meetingId, invite.map(p => p.userId)), 'Đã gửi lời mời.');
                  if (r) { setInvite([]); if (r.warnings?.length) onToast(`Lưu ý: ${r.warnings.map(w => w.displayName).join(', ')} đang bận giờ này.`); }
                }}><Plus size={14} /> Mời {invite.length} người</button>}
              </div>
            )}
            <button type="button" className="link-btn" onClick={() => work.meetingHistory(m.meetingId).then(r => setHistory(r.items)).catch(err => onToast(err.message))}>Xem lịch sử tham gia</button>
            {history && (
              <ul className="wk-history">
                {history.map((h, i) => <li key={i}><b>{h.displayName}</b> vào {fmtDateTime(h.joinedAt)}{h.leftAt ? ` · rời ${fmtDateTime(h.leftAt)}` : ' · đang trong phòng'}</li>)}
                {!history.length && <li className="muted">Chưa có ai vào phòng.</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function MeetingList({ onOpen, onCreate }) {
  const [scope, setScope] = useState('upcoming');
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => work.meetings(scope).then(r => { setItems(r.items); setError(''); }).catch(err => setError(err.message)), [scope]);
  useEffect(() => { load(); }, [load]);
  useSse('meeting:changed', load);
  return (
    <div>
      <div className="wk-toolbar">
        <div className="wk-tabs" role="tablist">
          {[['upcoming', 'Sắp tới'], ['invitations', 'Lời mời'], ['past', 'Đã qua']].map(([k, v]) => (
            <button key={k} type="button" role="tab" aria-selected={scope === k} className={scope === k ? 'active' : ''} onClick={() => setScope(k)}>{v}</button>
          ))}
        </div>
        <button type="button" className="btn small primary" onClick={onCreate}><Plus size={15} /> Cuộc họp mới</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!items && !error && <p className="muted"><LoaderCircle size={16} className="spin" /> Đang tải…</p>}
      {items && !items.length && <p className="muted pad">Không có cuộc họp nào.</p>}
      <div className="wk-cards">
        {(items || []).map(m => (
          <div key={m.meetingId} className="wk-card" role="button" tabIndex={0} onClick={() => onOpen(m.meetingId)} onKeyDown={e => e.key === 'Enter' && onOpen(m.meetingId)}>
            <div className="wk-card-top"><b>{m.title}</b><span className={`wk-pill mt-${m.status}`}>{m.statusLabel}</span></div>
            <span className="muted">{fmtRange(m.start, m.end)} · {m.organizer.displayName}</span>
            <span className="muted">{m.invitations.length} khách mời{m.myInvitation ? ` · bạn: ${INV[m.myInvitation]}` : ''}</span>
            {m.canJoin && <button type="button" className="btn small primary" onClick={e => { e.stopPropagation(); joinMeeting(m.meetingId); }}><Video size={14} /> Vào phòng</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
