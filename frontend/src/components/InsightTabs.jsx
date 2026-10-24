import { useCallback, useEffect, useState } from 'react';
import { Check, LoaderCircle, Pencil, Sparkles, X } from 'lucide-react';
import { api } from '../api';
import { formatFull } from '../utils';

const TYPE_LABEL = { TEXT: 'Văn bản', ATTACHMENT: 'Tệp đính kèm', POST_SHARE: 'Chia sẻ bài viết', SYSTEM: 'Hệ thống' };

function Bars({ rows, labelOf, valueOf, max }) {
  const top = max || Math.max(1, ...rows.map(valueOf));
  return (
    <ul className="bars">
      {rows.map((r, i) => (
        <li key={i}>
          <span className="bar-label">{labelOf(r)}</span>
          <span className="bar-track"><span className="bar-fill" style={{ width: `${(valueOf(r) / top) * 100}%` }} /></span>
          <span className="bar-value">{valueOf(r)}</span>
        </li>
      ))}
    </ul>
  );
}

// Thong ke hoi thoai: doc bang tong hop (khong quet tin nhan).
export function AnalyticsTab({ conversationId, version }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.conversationAnalytics(conversationId, 14).then(d => alive && setData(d)).catch(err => alive && setError(err.message));
    return () => { alive = false; };
  }, [conversationId, version]);
  if (error) return <p className="error-text pad">{error}</p>;
  if (!data) return <p className="muted pad"><LoaderCircle size={14} className="spin" /> Đang tải…</p>;
  const busiest = [...data.hourly].sort((a, b) => b.messages - a.messages)[0];
  return (
    <div className="insight">
      <div className="kpis">
        <div><strong>{data.totalMessages}</strong><span>tin đã gửi</span></div>
        <div><strong>{data.participants}</strong><span>thành viên</span></div>
        <div><strong>{busiest?.messages ? `${busiest.hour}h` : '—'}</strong><span>giờ sôi nổi nhất</span></div>
      </div>
      <h5>14 ngày gần nhất</h5>
      {data.daily.length ? <Bars rows={data.daily} labelOf={r => r.day.slice(5).split('-').reverse().join('/')} valueOf={r => r.messages} />
        : <p className="muted small-note">Không có tin nào trong 14 ngày qua.</p>}
      <h5>Theo giờ trong ngày</h5>
      <div className="hour-strip" aria-label="Phân bố theo giờ">
        {data.hourly.map(h => {
          const top = Math.max(1, ...data.hourly.map(x => x.messages));
          return <span key={h.hour} title={`${h.hour}h: ${h.messages} tin`} style={{ height: `${8 + (h.messages / top) * 52}px` }} className={h.messages ? '' : 'zero'} />;
        })}
      </div>
      <div className="hour-axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
      <h5>Loại nội dung</h5>
      <Bars rows={Object.entries(data.byType)} labelOf={([k]) => TYPE_LABEL[k] || k} valueOf={([, v]) => v} />
      <h5>Người gửi nhiều nhất</h5>
      <Bars rows={data.topSenders} labelOf={r => r.displayName} valueOf={r => r.messages} />
      <p className="muted small-note">{data.source}. Tính cả tin đã thu hồi.</p>
    </div>
  );
}

function TaskRow({ task, members, onSave, onJump }) {
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState({ title: task.title, assigneeId: task.assigneeId || '', dueDate: task.dueDate || '' });
  return (
    <li className={'ai-task s-' + task.status}>
      {edit ? (
        <form className="ai-edit" onSubmit={e => { e.preventDefault(); onSave(task, { ...draft, assigneeId: draft.assigneeId || null, dueDate: draft.dueDate || null }); setEdit(false); }}>
          <input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} maxLength={300} aria-label="Tên công việc" autoFocus />
          <select value={draft.assigneeId} onChange={e => setDraft(d => ({ ...d, assigneeId: e.target.value }))} aria-label="Người phụ trách">
            <option value="">Chưa giao</option>
            {members.map(m => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </select>
          <input type="date" value={draft.dueDate} onChange={e => setDraft(d => ({ ...d, dueDate: e.target.value }))} aria-label="Hạn" />
          <button type="submit" className="btn small primary">Lưu</button>
          <button type="button" className="btn small secondary" onClick={() => setEdit(false)}>Hủy</button>
        </form>
      ) : (
        <>
          <div className="ai-task-main">
            <strong>{task.title}</strong>
            <span className="muted small-note">
              {task.assigneeName ? `Phụ trách: ${task.assigneeName}` : 'Chưa giao'} · {task.dueDate ? `Hạn ${task.dueDate.split('-').reverse().join('/')}` : 'Chưa có hạn'}
              {' · '}{{ SUGGESTED: 'AI đề xuất', CONFIRMED: 'Đã xác nhận', REJECTED: 'Đã bác bỏ' }[task.status]}
            </span>
            <span className="ai-sources">Nguồn: {task.sourceMessageIds.map((id, i) => (
              <button key={id} type="button" className="link-btn" onClick={() => onJump(id)}>tin {i + 1}</button>
            ))}</span>
          </div>
          <div className="ai-task-actions">
            {task.status !== 'CONFIRMED' && <button type="button" className="icon-btn small" title="Xác nhận" aria-label="Xác nhận" onClick={() => onSave(task, { status: 'CONFIRMED' })}><Check size={15} /></button>}
            {task.status !== 'REJECTED' && <button type="button" className="icon-btn small" title="Bác bỏ" aria-label="Bác bỏ" onClick={() => onSave(task, { status: 'REJECTED' })}><X size={15} /></button>}
            <button type="button" className="icon-btn small" title="Sửa" aria-label="Sửa" onClick={() => setEdit(true)}><Pencil size={14} /></button>
          </div>
        </>
      )}
    </li>
  );
}

// AI tom tat + cong viec. Thieu cau hinh -> bao ro, khong tao noi dung gia.
export function AiTab({ conversationId, onJumpToMessage, onToast }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => api.aiOverview(conversationId).then(setData).catch(err => setError(err.message)), [conversationId]);
  useEffect(() => { load(); }, [load]);

  async function summarize() {
    setBusy(true);
    setError('');
    try {
      setData(await api.aiSummarize(conversationId, 100));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save(task, patch) {
    try {
      setData(await api.aiUpdateTask(conversationId, task.taskId, patch));
    } catch (err) {
      onToast(err.message);
    }
  }

  if (!data && !error) return <p className="muted pad"><LoaderCircle size={14} className="spin" /> Đang tải…</p>;
  const latest = data?.summaries[0];
  return (
    <div className="insight">
      {data && !data.configured && <div className="banner warn">{data.message}</div>}
      <button type="button" className="btn small primary" onClick={summarize} disabled={busy || (data && !data.configured)}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={15} />} Tóm tắt 100 tin gần nhất
      </button>
      {error && <p className="error-text" role="alert" style={{ marginTop: 8 }}>{error}</p>}
      {latest && (
        <div className="ai-summary">
          <h5>Tóm tắt <span className="muted small-note">({latest.messageCount} tin · {latest.model} · {formatFull(latest.createdAt)})</span></h5>
          <p>{latest.summary}</p>
          <span className="ai-sources">Nguồn: {latest.sourceMessageIds.length ? latest.sourceMessageIds.map((id, i) => (
            <button key={id} type="button" className="link-btn" onClick={() => onJumpToMessage(id)}>tin {i + 1}</button>
          )) : <em className="muted">không có</em>}</span>
          <p className="muted small-note">Nội dung do AI tạo, chưa được xác minh. Hãy kiểm tra tin nguồn.</p>
        </div>
      )}
      {data?.tasks.length > 0 && (
        <>
          <h5>Công việc trích xuất</h5>
          <ul className="ai-tasks">
            {data.tasks.map(t => <TaskRow key={t.taskId} task={t} members={data.members} onSave={save} onJump={onJumpToMessage} />)}
          </ul>
        </>
      )}
      {data?.configured && !latest && <p className="muted small-note" style={{ marginTop: 10 }}>Chưa có bản tóm tắt nào cho hội thoại này.</p>}
    </div>
  );
}
