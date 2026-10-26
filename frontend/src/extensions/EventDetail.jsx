// Chi tiet 1 lich ca nhan: thong tin day du, sua tieu de / thoi gian (kiem tra trung lich), dat / huy nhac, huy lich.
import { useCallback, useEffect, useState } from 'react';
import { AlarmClock, CalendarClock, Clock, LoaderCircle, Pencil, Trash2, User, Users, X } from 'lucide-react';
import { useSse } from './sse';
import { ConflictBox } from './TaskDialogs';
import { fmtDateTime, fmtRange, fromLocalInput, toLocalInput, work } from './workApi';

const OFFSETS = [[0, 'Đúng giờ bắt đầu'], [5, 'Trước 5 phút'], [15, 'Trước 15 phút'], [30, 'Trước 30 phút'], [60, 'Trước 1 giờ'], [1440, 'Trước 1 ngày']];
const REM_STATUS = { PENDING: 'Chờ gửi', PROCESSING: 'Đang gửi', SENT: 'Đã gửi', FAILED: 'Gửi lỗi', CANCELLED: 'Đã hủy' };

const duration = m => (m >= 60 ? `${Math.floor(m / 60)} giờ${m % 60 ? ` ${m % 60} phút` : ''}` : `${m} phút`);

export default function EventDetail({ eventId, onClose, onToast }) {
  const [ev, setEv] = useState(null);
  const [error, setError] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [edit, setEdit] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [offset, setOffset] = useState(15);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, rem] = await Promise.all([work.event(eventId), work.reminders().catch(() => ({ items: [] }))]);
      setEv(detail);
      setReminders(rem.items.filter(r => r.targetType === 'EVENT' && r.targetId === eventId && r.status !== 'CANCELLED'));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [eventId]);
  useEffect(() => { load(); }, [load]);
  useSse('calendar:changed', d => d?.eventId === eventId && load());
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const act = async (fn, ok) => {
    setActionError(null);
    setBusy(true);
    try { const r = await fn(); if (ok) onToast(ok); await load(); return r || true; } catch (err) { setActionError(err); return null; } finally { setBusy(false); }
  };

  async function save(e) {
    e.preventDefault();
    if (!edit.title.trim()) { setActionError({ message: 'Tiêu đề không được để trống.' }); return; }
    const done = await act(() => work.updateEvent(eventId, { title: edit.title.trim(), start: fromLocalInput(edit.start), end: fromLocalInput(edit.end) }), 'Đã cập nhật lịch.');
    if (done) setEdit(null);
  }

  async function cancelEvent() {
    const done = await act(() => work.cancelEvent(eventId), 'Đã hủy lịch.');
    if (done) onClose();
  }

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog wk-dialog" role="dialog" aria-modal="true" aria-label="Chi tiết lịch">
        <div className="wk-dialog-head">
          <h3>{ev ? ev.title : 'Chi tiết lịch'}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        {error && <p className="error-text pad">{error.message}</p>}
        {!ev && !error && <p className="muted pad"><LoaderCircle className="spin" size={16} /> Đang tải…</p>}
        {ev && (
          <div className="wk-dialog-body">
            <div className="wk-meta">
              <span className={`wk-pill wk-kind k-${ev.kind}`}>{ev.kindLabel}</span>
              {ev.status === 'CANCELLED' && <span className="wk-pill st-CANCELLED">Đã hủy</span>}
              {new Date(ev.end) < new Date() && ev.status !== 'CANCELLED' && <span className="wk-pill st-DONE">Đã diễn ra</span>}
              {new Date(ev.start) <= new Date() && new Date(ev.end) > new Date() && <span className="wk-pill st-IN_PROGRESS">Đang diễn ra</span>}
            </div>
            <dl className="wk-facts">
              <dt><CalendarClock size={14} /> Thời gian</dt><dd>{fmtRange(ev.start, ev.end)}</dd>
              <dt><Clock size={14} /> Thời lượng</dt><dd>{duration(ev.durationMinutes)}</dd>
              <dt><User size={14} /> Người tạo</dt><dd>{ev.owner.displayName}</dd>
              {ev.participants.length > 1 && (<><dt><Users size={14} /> Tham gia</dt><dd>{ev.participants.map(p => p.displayName).join(', ')}</dd></>)}
              {ev.groupName && (<><dt><Users size={14} /> Nhóm</dt><dd>{ev.groupName}</dd></>)}
              {ev.createdAt && (<><dt>Tạo lúc</dt><dd>{fmtDateTime(ev.createdAt)}{ev.updatedAt && ev.updatedAt !== ev.createdAt ? ` · sửa ${fmtDateTime(ev.updatedAt)}` : ''}</dd></>)}
            </dl>

            {edit ? (
              <form className="wk-event-edit" onSubmit={save}>
                <div className="field"><label htmlFor="ev-title">Tiêu đề</label>
                  <input id="ev-title" className="input" maxLength={200} value={edit.title} onChange={e => setEdit(x => ({ ...x, title: e.target.value }))} autoFocus /></div>
                <div className="wk-row">
                  <div className="field"><label htmlFor="ev-start">Bắt đầu</label>
                    <input id="ev-start" type="datetime-local" className="input" value={edit.start} onChange={e => setEdit(x => ({ ...x, start: e.target.value }))} /></div>
                  <div className="field"><label htmlFor="ev-end">Kết thúc</label>
                    <input id="ev-end" type="datetime-local" className="input" value={edit.end} onChange={e => setEdit(x => ({ ...x, end: e.target.value }))} /></div>
                </div>
                <div className="wk-actions">
                  <button type="submit" className="btn small primary" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
                  <button type="button" className="btn small secondary" onClick={() => { setEdit(null); setActionError(null); }} disabled={busy}>Hủy sửa</button>
                </div>
              </form>
            ) : ev.canEdit && (
              <div className="wk-actions">
                <button type="button" className="btn small secondary" onClick={() => setEdit({ title: ev.title, start: toLocalInput(ev.start), end: toLocalInput(ev.end) })}><Pencil size={14} /> Sửa lịch</button>
                {ev.canCancel && !confirmCancel && <button type="button" className="btn small danger" onClick={() => setConfirmCancel(true)}><Trash2 size={14} /> Hủy lịch</button>}
              </div>
            )}
            {confirmCancel && (
              <div className="wk-confirm" role="alert">
                <span>Hủy lịch “{ev.title}”? Các nhắc nhở của lịch này cũng bị hủy.</span>
                <div className="wk-actions">
                  <button type="button" className="btn small danger" onClick={cancelEvent} disabled={busy}>Xác nhận hủy</button>
                  <button type="button" className="btn small secondary" onClick={() => setConfirmCancel(false)} disabled={busy}>Không</button>
                </div>
              </div>
            )}
            <ConflictBox error={actionError} onPick={s => setEdit(x => ({ ...(x || { title: ev.title }), start: toLocalInput(s.start), end: toLocalInput(s.end) }))} />

            {ev.status === 'ACTIVE' && (
              <>
                <h4 className="wk-h4"><AlarmClock size={15} /> Nhắc nhở cho lịch này</h4>
                <ul className="wk-sessions">
                  {reminders.map(r => (
                    <li key={r.reminderId}>
                      <AlarmClock size={14} /> {fmtDateTime(r.fireAt)} · {r.offsetMinutes ? `trước ${duration(r.offsetMinutes)}` : 'đúng giờ'} · {REM_STATUS[r.status] || r.status}
                      {r.status === 'PENDING' && (
                        <button type="button" className="icon-btn" aria-label="Hủy nhắc nhở" onClick={() => act(() => work.cancelReminder(r.reminderId), 'Đã hủy nhắc nhở.')}><Trash2 size={14} /></button>
                      )}
                    </li>
                  ))}
                  {!reminders.length && <li className="muted">Chưa có nhắc nhở.</li>}
                </ul>
                {new Date(ev.start) > new Date() && (
                  <div className="wk-inline">
                    <select className="input" aria-label="Thời điểm nhắc" value={offset} onChange={e => setOffset(Number(e.target.value))}>
                      {OFFSETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <button type="button" className="btn small secondary" disabled={busy}
                      onClick={() => act(() => work.createReminder({ targetType: 'EVENT', targetId: eventId, anchor: 'START', offsetMinutes: offset }), 'Đã đặt nhắc nhở.')}>
                      Đặt nhắc
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
