// Form tao / sua cong viec (kiem tra trung lich, goi y gio trong) + chi tiet cong viec (trang thai, phien, binh luan, lich su, nhac).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BellPlus, CalendarPlus, Check, Clock, History, LoaderCircle, MessageSquare, Pencil, Trash2, X } from 'lucide-react';
import Avatar from '../components/Avatar';
import { useSse } from './sse';
import { PRIORITY, STATUS, fmtDateTime, fmtRange, fromLocalInput, newIdemKey, toLocalInput, work } from './workApi';

export function ConflictBox({ error, onPick }) {
  if (!error) return null;
  const d = error.details || {};
  if (error.code !== 'SCHEDULE_CONFLICT') return <p className="error-text" role="alert">{error.message}</p>;
  return (
    <div className="wk-conflict" role="alert">
      <p><AlertTriangle size={16} /> {error.message}</p>
      <ul>
        {(d.conflicts || []).map((c, i) => (
          <li key={i}><b>{c.displayName}</b> bận {fmtRange(c.start, c.end)} — {c.kindLabel ? `${c.kindLabel}: ` : ''}{c.title}</li>
        ))}
      </ul>
      {(d.suggestions || []).length > 0 && (
        <div className="wk-suggest">
          <span>Giờ trống gợi ý:</span>
          {d.suggestions.map(s => (
            <button key={s.start} type="button" className="btn small secondary" onClick={() => onPick?.(s)}>{fmtRange(s.start, s.end)}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const REMINDER_OPTIONS = [
  { value: '', label: 'Không nhắc' },
  { value: 'START:15', label: '15 phút trước khi bắt đầu' },
  { value: 'START:60', label: '1 giờ trước khi bắt đầu' },
  { value: 'DUE:60', label: '1 giờ trước hạn' },
  { value: 'DUE:1440', label: '1 ngày trước hạn' }
];

export function useGroupMembers(conversationId) {
  const [members, setMembers] = useState([]);
  useEffect(() => {
    if (!conversationId) { setMembers([]); return; }
    let alive = true;
    const now = new Date();
    work.groupCalendar(conversationId, now.toISOString(), new Date(now.getTime() + 86400000).toISOString(), false)
      .then(r => alive && setMembers(r.members)).catch(() => alive && setMembers([]));
    return () => { alive = false; };
  }, [conversationId]);
  return members;
}

// initial: cong viec dang sua (dto) hoac { start, end, conversationId } khi tao tu lich.
export function TaskForm({ user, groups, initial = {}, onClose, onSaved, onToast }) {
  const editing = Boolean(initial.taskId);
  const [f, setF] = useState(() => ({
    title: initial.title || '', description: initial.description || '',
    conversationId: initial.conversationId || '', assigneeIds: (initial.assignees || []).map(a => a.userId), leadId: initial.lead?.userId || '',
    start: toLocalInput(initial.start), end: toLocalInput(initial.end), dueAt: toLocalInput(initial.dueAt),
    priority: initial.priority || 'NORMAL', labels: (initial.labels || []).join(', '), reminder: ''
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [check, setCheck] = useState(null);
  const [key] = useState(newIdemKey);
  const members = useGroupMembers(f.conversationId);
  const set = (k, v) => { setF(x => ({ ...x, [k]: v })); setError(null); setCheck(null); };
  const scopeGroup = Boolean(f.conversationId);

  const payload = () => {
    const body = {
      title: f.title, description: f.description, priority: f.priority,
      start: fromLocalInput(f.start), end: fromLocalInput(f.end), dueAt: fromLocalInput(f.dueAt),
      labels: f.labels.split(',').map(s => s.trim()).filter(Boolean)
    };
    if (!editing) {
      body.scope = scopeGroup ? 'GROUP' : 'PERSONAL';
      if (scopeGroup) body.conversationId = f.conversationId;
      if (f.reminder) { const [anchor, m] = f.reminder.split(':'); body.reminders = [{ anchor, offsetMinutes: Number(m) }]; }
    }
    if (scopeGroup) { body.assigneeIds = f.assigneeIds; body.leadId = f.leadId || f.assigneeIds[0] || null; }
    return body;
  };

  async function precheck() {
    if (!f.start || !f.end) { setError({ message: 'Chọn giờ bắt đầu và kết thúc để kiểm tra.' }); return; }
    const ids = scopeGroup ? f.assigneeIds : [user.userId];
    if (!ids.length) { setError({ message: 'Chưa chọn người thực hiện.' }); return; }
    try {
      const r = await work.checkConflicts({ start: fromLocalInput(f.start), end: fromLocalInput(f.end), userIds: ids, ignoreEventId: initial.sessions?.find(s => s.primary)?.eventId });
      setCheck(r);
    } catch (err) { setError(err); }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = editing ? await work.updateTask(initial.taskId, payload()) : await work.createTask(payload(), key);
      onToast(editing ? 'Đã cập nhật công việc.' : 'Đã tạo công việc.');
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const pick = s => { setF(x => ({ ...x, start: toLocalInput(s.start), end: toLocalInput(s.end) })); setError(null); setCheck(null); };
  const toggleAssignee = id => set('assigneeIds', f.assigneeIds.includes(id) ? f.assigneeIds.filter(x => x !== id) : [...f.assigneeIds, id]);

  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && !busy && onClose()}>
      <form className="dialog wk-dialog" onSubmit={submit} aria-label={editing ? 'Sửa công việc' : 'Tạo công việc'}>
        <div className="wk-dialog-head">
          <h3>{editing ? 'Sửa công việc' : 'Công việc mới'}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        <div className="wk-dialog-body">
          <div className="field"><label htmlFor="wk-title">Tiêu đề</label>
            <input id="wk-title" className="input" value={f.title} maxLength={200} required autoFocus onChange={e => set('title', e.target.value)} /></div>
          <div className="field"><label htmlFor="wk-desc">Mô tả</label>
            <textarea id="wk-desc" className="input" rows={3} maxLength={5000} value={f.description} onChange={e => set('description', e.target.value)} /></div>
          {!editing && (
            <div className="field"><label htmlFor="wk-scope">Phạm vi</label>
              <select id="wk-scope" className="input" value={f.conversationId} onChange={e => { set('conversationId', e.target.value); setF(x => ({ ...x, assigneeIds: [], leadId: '' })); }}>
                <option value="">Công việc cá nhân (chỉ mình tôi)</option>
                {groups.map(g => <option key={g.conversationId} value={g.conversationId}>Nhóm: {g.conversationName}</option>)}
              </select></div>
          )}
          {scopeGroup && (
            <div className="field"><span className="field-label">Người thực hiện ({f.assigneeIds.length})</span>
              <div className="wk-members">
                {members.map(m => (
                  <label key={m.userId} className={'wk-member' + (f.assigneeIds.includes(m.userId) ? ' on' : '')}>
                    <input type="checkbox" checked={f.assigneeIds.includes(m.userId)} onChange={() => toggleAssignee(m.userId)} />
                    <Avatar name={m.displayName} seed={m.userId} size={22} /> {m.displayName}{m.userId === user.userId ? ' (tôi)' : ''}
                  </label>
                ))}
                {!members.length && <span className="muted">Đang tải thành viên…</span>}
              </div>
              {f.assigneeIds.length > 1 && (
                <select className="input" aria-label="Người chịu trách nhiệm chính" value={f.leadId || f.assigneeIds[0]} onChange={e => set('leadId', e.target.value)}>
                  {f.assigneeIds.map(id => <option key={id} value={id}>Phụ trách chính: {members.find(m => m.userId === id)?.displayName || id}</option>)}
                </select>
              )}
            </div>
          )}
          <div className="wk-row">
            <div className="field"><label htmlFor="wk-start">Bắt đầu thực hiện</label>
              <input id="wk-start" type="datetime-local" className="input" value={f.start} onChange={e => set('start', e.target.value)} /></div>
            <div className="field"><label htmlFor="wk-end">Kết thúc</label>
              <input id="wk-end" type="datetime-local" className="input" value={f.end} onChange={e => set('end', e.target.value)} /></div>
          </div>
          <div className="wk-row">
            <div className="field"><label htmlFor="wk-due">Hạn hoàn thành</label>
              <input id="wk-due" type="datetime-local" className="input" value={f.dueAt} onChange={e => set('dueAt', e.target.value)} /></div>
            <div className="field"><label htmlFor="wk-pri">Mức ưu tiên</label>
              <select id="wk-pri" className="input" value={f.priority} onChange={e => set('priority', e.target.value)}>
                {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
          </div>
          <div className="wk-row">
            <div className="field"><label htmlFor="wk-labels">Nhãn (cách nhau dấu phẩy)</label>
              <input id="wk-labels" className="input" value={f.labels} onChange={e => set('labels', e.target.value)} /></div>
            {!editing && (
              <div className="field"><label htmlFor="wk-rem">Nhắc nhở</label>
                <select id="wk-rem" className="input" value={f.reminder} onChange={e => set('reminder', e.target.value)}>
                  {REMINDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select></div>
            )}
          </div>
          {check && (check.ok ? <p className="wk-ok"><Check size={15} /> Không trùng lịch với người thực hiện.</p>
            : <ConflictBox error={{ code: 'SCHEDULE_CONFLICT', message: 'Khung giờ này bị trùng lịch.', details: check }} onPick={pick} />)}
          <ConflictBox error={error} onPick={pick} />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn secondary" onClick={precheck} disabled={busy}><Clock size={15} /> Kiểm tra trùng lịch</button>
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Hủy</button>
          <button type="submit" className="btn primary" disabled={busy || !f.title.trim()}>{busy ? 'Đang lưu…' : editing ? 'Lưu' : 'Tạo công việc'}</button>
        </div>
      </form>
    </div>
  );
}

export function StatusPill({ status }) {
  return <span className={`wk-pill st-${status}`}>{STATUS[status] || status}</span>;
}

export function TaskDetail({ user, groups, taskId, onClose, onToast }) {
  const [task, setTask] = useState(null);
  const [comments, setComments] = useState([]);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState(null);
  const [tab, setTab] = useState('comments');
  const [remind, setRemind] = useState('START:15');

  const load = useCallback(async () => {
    try {
      const [t, c, h] = await Promise.all([work.task(taskId), work.comments(taskId), work.history(taskId)]);
      setTask(t); setComments(c.items); setHistory(h.items); setError(null);
    } catch (err) { setError(err); }
  }, [taskId]);
  useEffect(() => { load(); }, [load]);
  useSse('task:changed', d => d?.taskId === taskId && load());

  const act = async (fn, ok) => {
    setActionError(null);
    try { await fn(); if (ok) onToast(ok); await load(); } catch (err) { setActionError(err); }
  };
  const groupName = useMemo(() => task?.groupName || groups.find(g => g.conversationId === task?.conversationId)?.conversationName, [task, groups]);

  if (editing && task) {
    return <TaskForm user={user} groups={groups} initial={task} onToast={onToast} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />;
  }
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog wk-dialog wk-detail" role="dialog" aria-modal="true" aria-label="Chi tiết công việc">
        <div className="wk-dialog-head">
          <h3>{task ? task.title : 'Công việc'}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Đóng"><X size={18} /></button>
        </div>
        {error && <p className="error-text pad">{error.message}</p>}
        {!task && !error && <p className="muted pad"><LoaderCircle className="spin" size={16} /> Đang tải…</p>}
        {task && (
          <div className="wk-dialog-body">
            <div className="wk-meta">
              <StatusPill status={task.status} />
              <span className={`wk-pill pr-${task.priority}`}>{task.priorityLabel}</span>
              {task.overdue && <span className="wk-pill st-overdue">Quá hạn</span>}
              {task.dueSoon && <span className="wk-pill st-soon">Sắp đến hạn</span>}
              <span className="muted">{task.scope === 'GROUP' ? (groupName || 'Công việc nhóm') : 'Cá nhân'}</span>
              {task.labels.map(l => <span key={l} className="chip">#{l}</span>)}
            </div>
            {task.description && <p className="wk-desc">{task.description}</p>}
            <dl className="wk-facts">
              <dt>Người giao</dt><dd>{task.assigner?.displayName}</dd>
              <dt>Thực hiện</dt><dd>{task.assignees.length ? task.assignees.map(a => a.displayName + (task.lead?.userId === a.userId ? ' (chính)' : '')).join(', ') : <i>Chưa giao</i>}</dd>
              <dt>Thời gian</dt><dd>{task.start ? fmtRange(task.start, task.end) : '—'}</dd>
              <dt>Hạn</dt><dd>{task.dueAt ? fmtDateTime(task.dueAt) : '—'}</dd>
              {task.completedAt && (<><dt>Hoàn thành</dt><dd>{fmtDateTime(task.completedAt)}</dd></>)}
            </dl>
            {task.allowedStatuses.length > 0 && (
              <div className="wk-actions">
                {task.allowedStatuses.map(s => (
                  <button key={s} type="button" className={'btn small ' + (s === 'DONE' ? 'primary' : s === 'CANCELLED' ? 'danger' : 'secondary')}
                    onClick={() => act(() => work.setStatus(task.taskId, s), `Đã chuyển sang “${STATUS[s]}”.`)}>{STATUS[s]}</button>
                ))}
                {task.permissions.manage && task.status !== 'CANCELLED' && (
                  <button type="button" className="btn small secondary" onClick={() => setEditing(true)}><Pencil size={14} /> Sửa</button>
                )}
              </div>
            )}
            <ConflictBox error={actionError} onPick={s => setSession({ start: toLocalInput(s.start), end: toLocalInput(s.end) })} />

            <h4 className="wk-h4">Phiên làm việc trên lịch</h4>
            <ul className="wk-sessions">
              {(task.sessions || []).map(s => (
                <li key={s.eventId}><CalendarPlus size={14} /> {fmtRange(s.start, s.end)}{s.primary ? ' · chính' : ''}
                  {task.permissions.manage && (
                    <button type="button" className="icon-btn" aria-label="Xóa phiên" onClick={() => act(() => work.removeSession(task.taskId, s.eventId), 'Đã xóa phiên.')}><Trash2 size={14} /></button>
                  )}
                </li>
              ))}
              {!(task.sessions || []).length && <li className="muted">Chưa có phiên nào.</li>}
            </ul>
            {task.permissions.manage && !['DONE', 'CANCELLED'].includes(task.status) && (
              session ? (
                <div className="wk-inline">
                  <input type="datetime-local" className="input" aria-label="Bắt đầu phiên" value={session.start} onChange={e => setSession(x => ({ ...x, start: e.target.value }))} />
                  <input type="datetime-local" className="input" aria-label="Kết thúc phiên" value={session.end} onChange={e => setSession(x => ({ ...x, end: e.target.value }))} />
                  <button type="button" className="btn small primary" onClick={() => act(async () => { await work.addSession(task.taskId, fromLocalInput(session.start), fromLocalInput(session.end)); setSession(null); }, 'Đã thêm phiên làm việc.')}>Thêm</button>
                  <button type="button" className="btn small secondary" onClick={() => setSession(null)}>Hủy</button>
                </div>
              ) : <button type="button" className="btn small secondary" onClick={() => setSession({ start: '', end: '' })}><CalendarPlus size={14} /> Thêm phiên làm việc</button>
            )}

            <div className="wk-inline wk-remind">
              <BellPlus size={15} />
              <select className="input" aria-label="Thời điểm nhắc" value={remind} onChange={e => setRemind(e.target.value)}>
                {REMINDER_OPTIONS.filter(o => o.value).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button type="button" className="btn small secondary" onClick={() => act(() => {
                const [anchor, m] = remind.split(':');
                return work.createReminder({ targetType: 'TASK', targetId: task.taskId, anchor, offsetMinutes: Number(m) });
              }, 'Đã đặt nhắc nhở.')}>Đặt nhắc cho tôi</button>
            </div>

            <div className="segmented wk-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}><MessageSquare size={14} /> Bình luận ({comments.filter(c => !c.deleted).length})</button>
              <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}><History size={14} /> Lịch sử</button>
            </div>
            {tab === 'comments' ? (
              <div className="wk-comments">
                {comments.map(c => (
                  <div key={c.commentId} className="wk-comment">
                    <Avatar name={c.author.displayName} seed={c.author.userId} size={28} />
                    <div>
                      <b>{c.author.displayName}</b> <span className="muted">{fmtDateTime(c.createdAt)}{c.editedAt ? ' · đã sửa' : ''}</span>
                      <p>{c.deleted ? <i className="muted">Bình luận đã xóa</i> : c.content}</p>
                    </div>
                    {!c.deleted && (c.canEdit || task.permissions.manage) && (
                      <button type="button" className="icon-btn" aria-label="Xóa bình luận" onClick={() => act(() => work.deleteComment(task.taskId, c.commentId))}><Trash2 size={14} /></button>
                    )}
                  </div>
                ))}
                <form className="wk-inline" onSubmit={e => { e.preventDefault(); if (comment.trim()) act(async () => { await work.addComment(task.taskId, comment); setComment(''); }); }}>
                  <input className="input" placeholder="Viết bình luận…" maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} />
                  <button type="submit" className="btn small primary" disabled={!comment.trim()}>Gửi</button>
                </form>
              </div>
            ) : (
              <ul className="wk-history">
                {history.map((h, i) => <li key={i}><span className="muted">{fmtDateTime(h.at)}</span> <b>{h.actor}</b> — {h.detail || h.action}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
