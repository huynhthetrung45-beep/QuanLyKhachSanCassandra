// Trang "Cong viec & Lich": tong quan, danh sach cong viec, lich ca nhan / nhom, cuoc hop, nhac nho.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlarmClock, BellRing, CalendarDays, ClipboardList, LayoutDashboard, LoaderCircle, Plus, Trash2, Video } from 'lucide-react';
import { useSse } from './sse';
import { StatusPill, TaskDetail, TaskForm } from './TaskDialogs';
import WorkCalendar from './WorkCalendar';
import EventDetail from './EventDetail';
import { MeetingDetail, MeetingForm, MeetingList } from './Meetings';
import { PRIORITY, STATUS, fmtDateTime, fmtRange, fromLocalInput, toLocalInput, work } from './workApi';
import './work.css';

const TABS = [
  ['overview', 'Tổng quan', LayoutDashboard], ['tasks', 'Công việc', ClipboardList], ['calendar', 'Lịch', CalendarDays],
  ['meetings', 'Cuộc họp', Video], ['reminders', 'Nhắc nhở', BellRing]
];

const offsetLabel = m => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} ngày` : m >= 60 && m % 60 === 0 ? `${m / 60} giờ` : `${m} phút`);

function TaskRow({ t, onOpen }) {
  return (
    <button type="button" className="wk-task" onClick={() => onOpen(t.taskId)}>
      <span className={`wk-prio pr-${t.priority}`} title={PRIORITY[t.priority]} />
      <span className="wk-task-main">
        <b>{t.title}</b>
        <span className="muted">
          {t.scope === 'GROUP' ? (t.groupName || 'Nhóm') : 'Cá nhân'}
          {t.assignees.length ? ` · ${t.assignees.map(a => a.displayName).join(', ')}` : ' · chưa giao'}
          {t.dueAt ? ` · hạn ${fmtDateTime(t.dueAt)}` : ''}
        </span>
      </span>
      {t.overdue && <span className="wk-pill st-overdue">Quá hạn</span>}
      {t.dueSoon && <span className="wk-pill st-soon">Sắp hạn</span>}
      <StatusPill status={t.status} />
    </button>
  );
}

function Overview({ onOpenTask, onOpenMeeting, onOpenEvent, onTab }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => work.overview().then(d => { setData(d); setError(''); }).catch(err => setError(err.message)), []);
  useEffect(() => { load(); }, [load]);
  useSse(['task:changed', 'calendar:changed', 'meeting:changed'], load);
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted"><LoaderCircle size={16} className="spin" /> Đang tải…</p>;
  const stat = (label, n, cls, tab) => <button type="button" className={`wk-stat ${cls}`} onClick={() => onTab(tab)}><b>{n}</b><span>{label}</span></button>;
  const section = (title, list, empty) => (
    <section className="wk-section"><h4>{title}</h4>
      {list.length ? list.slice(0, 6).map(t => <TaskRow key={t.taskId} t={t} onOpen={onOpenTask} />) : <p className="muted">{empty}</p>}
    </section>
  );
  return (
    <div className="wk-overview">
      <div className="wk-stats">
        {stat('Được giao cho tôi', data.assignedToMe.length, '', 'tasks')}
        {stat('Đang thực hiện', data.inProgress.length, 'blue', 'tasks')}
        {stat('Sắp đến hạn', data.dueSoon.length, 'amber', 'tasks')}
        {stat('Quá hạn', data.overdue.length, 'red', 'tasks')}
        {stat('Cần tôi xác nhận', data.needsMyReview.length, 'violet', 'tasks')}
      </div>
      <div className="wk-two">
        <section className="wk-section"><h4>Lịch hôm nay & ngày mai</h4>
          {data.today.length ? data.today.map(e => (
            <button key={e.eventId} type="button" className={`wk-list-item wk-ev k-${e.kind}`} onClick={() => (e.taskId ? onOpenTask(e.taskId) : e.meetingId ? onOpenMeeting(e.meetingId) : onOpenEvent(e.eventId))}>
              <span className="wk-when">{fmtRange(e.start, e.end)}</span><b>{e.title}</b>
            </button>
          )) : <p className="muted">Không có lịch.</p>}
        </section>
        <section className="wk-section"><h4>Cuộc họp sắp tới</h4>
          {data.upcomingMeetings.length ? data.upcomingMeetings.map(m => (
            <button key={m.meetingId} type="button" className="wk-list-item wk-ev k-MEETING" onClick={() => onOpenMeeting(m.meetingId)}>
              <span className="wk-when">{fmtRange(m.start, m.end)}</span><b>{m.title}</b>{m.status === 'LIVE' && <span className="wk-pill mt-LIVE">Đang diễn ra</span>}
            </button>
          )) : <p className="muted">Không có cuộc họp.</p>}
        </section>
      </div>
      <div className="wk-two">
        {section('Được giao cho tôi', data.assignedToMe, 'Không có công việc đang mở.')}
        {section('Tôi đã giao', data.createdByMe.filter(t => t.scope === 'GROUP'), 'Chưa giao việc cho ai.')}
      </div>
      <div className="wk-two">
        {section('Sắp đến hạn / quá hạn', [...data.overdue, ...data.dueSoon], 'Không có việc gấp.')}
        {section('Mới trong nhóm', data.newInGroups, 'Không có công việc mới.')}
      </div>
      <section className="wk-section"><h4>Nhắc nhở sắp tới</h4>
        {data.upcomingReminders.length ? data.upcomingReminders.map(r => (
          <p key={r.reminderId} className="wk-rem-line"><AlarmClock size={14} /> {fmtDateTime(r.fireAt)} — {r.title || r.note}</p>
        )) : <p className="muted">Không có nhắc nhở.</p>}
      </section>
    </div>
  );
}

function TaskList({ groups, onOpen, onCreate }) {
  const [filter, setFilter] = useState({ relation: '', status: '', priority: '', groupId: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => work.tasks({ ...filter, limit: 100 }).then(r => { setData(r); setError(''); }).catch(err => setError(err.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  useSse('task:changed', load);
  const set = (k, v) => setFilter(f => ({ ...f, [k]: v }));
  return (
    <div>
      <div className="wk-toolbar">
        <select className="input" aria-label="Quan hệ" value={filter.relation} onChange={e => set('relation', e.target.value)}>
          <option value="">Tất cả của tôi</option><option value="assigned">Được giao cho tôi</option><option value="created">Tôi tạo / giao</option>
        </select>
        <select className="input" aria-label="Trạng thái" value={filter.status} onChange={e => set('status', e.target.value)}>
          <option value="">Mọi trạng thái</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" aria-label="Ưu tiên" value={filter.priority} onChange={e => set('priority', e.target.value)}>
          <option value="">Mọi mức ưu tiên</option>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" aria-label="Nhóm" value={filter.groupId} onChange={e => set('groupId', e.target.value)}>
          <option value="">Mọi nhóm</option>{groups.map(g => <option key={g.conversationId} value={g.conversationId}>{g.conversationName}</option>)}
        </select>
        <button type="button" className="btn small primary" onClick={onCreate}><Plus size={15} /> Công việc mới</button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!data && !error && <p className="muted"><LoaderCircle size={16} className="spin" /> Đang tải…</p>}
      {data && !data.items.length && <p className="muted pad">Không có công việc phù hợp.</p>}
      <div className="wk-tasks">{(data?.items || []).map(t => <TaskRow key={t.taskId} t={t} onOpen={onOpen} />)}</div>
    </div>
  );
}

function Reminders({ onToast }) {
  const [items, setItems] = useState(null);
  const [form, setForm] = useState(() => ({ note: '', fireAt: toLocalInput(new Date(Date.now() + 3600000)) }));
  const [error, setError] = useState('');
  const load = useCallback(() => work.reminders().then(r => { setItems(r.items); setError(''); }).catch(err => setError(err.message)), []);
  useEffect(() => { load(); }, [load]);
  useSse(['notification:new', 'task:changed', 'meeting:changed'], load);
  const act = async (fn, ok) => { try { await fn(); onToast(ok); load(); } catch (err) { onToast(err.message); } };
  const LABEL = { PENDING: 'Chờ gửi', PROCESSING: 'Đang gửi', SENT: 'Đã gửi', FAILED: 'Gửi lỗi', CANCELLED: 'Đã hủy' };
  return (
    <div>
      <form className="wk-toolbar" onSubmit={e => { e.preventDefault(); act(async () => { await work.createReminder({ targetType: 'CUSTOM', note: form.note, fireAt: fromLocalInput(form.fireAt) }); setForm(f => ({ ...f, note: '' })); }, 'Đã đặt nhắc nhở.'); }}>
        <input className="input grow" placeholder="Nội dung nhắc (ví dụ: Gọi cho khách hàng)" maxLength={300} value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
        <input className="input" type="datetime-local" aria-label="Thời điểm nhắc" value={form.fireAt} onChange={e => setForm(f => ({ ...f, fireAt: e.target.value }))} />
        <button type="submit" className="btn small primary" disabled={!form.note.trim()}><Plus size={15} /> Đặt nhắc</button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {items && !items.length && <p className="muted pad">Chưa có nhắc nhở. Có thể đặt nhắc trong chi tiết công việc / cuộc họp.</p>}
      <ul className="wk-reminders">
        {(items || []).map(r => (
          <li key={r.reminderId} className={'st-r-' + r.status}>
            <AlarmClock size={16} />
            <span className="grow"><b>{r.title || r.note || 'Nhắc nhở'}</b>
              <span className="muted"> · {fmtDateTime(r.fireAt)}{r.targetType !== 'CUSTOM' ? ` · ${r.anchor === 'DUE' ? 'trước hạn' : 'trước giờ bắt đầu'} ${offsetLabel(r.offsetMinutes)}` : ''}</span>
              {r.lastError && r.status === 'FAILED' && <span className="error-text"> · {r.lastError}</span>}
            </span>
            <span className={`wk-pill r-${r.status}`}>{LABEL[r.status] || r.status}</span>
            {['PENDING', 'SENT'].includes(r.status) && <button type="button" className="btn small secondary" onClick={() => act(() => work.snooze(r.reminderId, 10), 'Đã hoãn 10 phút.')}>Hoãn 10′</button>}
            {r.status === 'PENDING' && <button type="button" className="icon-btn" aria-label="Hủy nhắc" onClick={() => act(() => work.cancelReminder(r.reminderId), 'Đã hủy nhắc nhở.')}><Trash2 size={15} /></button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function WorkPage({ user, conversations, onToast, target }) {
  const [tab, setTab] = useState('overview');
  const [taskId, setTaskId] = useState(null);
  const [meetingId, setMeetingId] = useState(null);
  const [eventId, setEventId] = useState(null);
  const [createTask, setCreateTask] = useState(null);
  const [createMeeting, setCreateMeeting] = useState(null);
  const [calSource, setCalSource] = useState('me');
  const groups = useMemo(() => conversations.filter(c => c.conversationType === 'GROUP')
    .map(c => ({ conversationId: c.conversationId, conversationName: c.conversationName || c.displayName })), [conversations]);

  // Mo tu thong bao: { type: TASK | MEETING | EVENT, id }
  useEffect(() => {
    if (!target) return;
    if (target.type === 'TASK') { setTab('tasks'); setTaskId(target.id); }
    if (target.type === 'MEETING') { setTab('meetings'); setMeetingId(target.id); }
    if (target.type === 'EVENT') setTab('calendar');
  }, [target]);

  const openItem = ev => {
    if (ev.taskId) setTaskId(ev.taskId);
    else if (ev.meetingId) setMeetingId(ev.meetingId);
    else if (ev.eventId && ev.visible !== false) setEventId(ev.eventId); // lich ca nhan: mo hop chi tiet
  };
  const createAt = (start, end) => setCreateTask({ start: start.toISOString(), end: end.toISOString(), conversationId: calSource !== 'me' ? calSource : '' });

  return (
    <section className="posts-page wk-page" aria-label="Công việc và lịch">
      <div className="posts-scroll">
        <div className="wk-col-main">
          <div className="wk-head">
            <h2>Công việc & Lịch</h2>
            <div className="wk-head-actions">
              <button type="button" className="btn small secondary" onClick={() => setCreateMeeting({})}><Video size={15} /> Cuộc họp</button>
              <button type="button" className="btn small primary" onClick={() => setCreateTask({})}><Plus size={15} /> Công việc</button>
            </div>
          </div>
          <div className="wk-tabs wk-main-tabs" role="tablist">
            {TABS.map(([k, v, Icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}><Icon size={15} /> {v}</button>
            ))}
          </div>
          {tab === 'overview' && <Overview onOpenTask={setTaskId} onOpenMeeting={setMeetingId} onOpenEvent={setEventId} onTab={setTab} />}
          {tab === 'tasks' && <TaskList groups={groups} onOpen={setTaskId} onCreate={() => setCreateTask({})} />}
          {tab === 'calendar' && (
            <>
              <div className="wk-toolbar">
                <select className="input" aria-label="Xem lịch của" value={calSource} onChange={e => setCalSource(e.target.value)}>
                  <option value="me">Lịch của tôi</option>
                  {groups.map(g => <option key={g.conversationId} value={g.conversationId}>Lịch nhóm: {g.conversationName}</option>)}
                </select>
              </div>
              <WorkCalendar key={calSource} source={calSource === 'me' ? { type: 'me' } : { type: 'group', cid: calSource }}
                onOpenItem={openItem} onCreateAt={createAt} onToast={onToast} />
            </>
          )}
          {tab === 'meetings' && <MeetingList onOpen={setMeetingId} onCreate={() => setCreateMeeting({})} />}
          {tab === 'reminders' && <Reminders onToast={onToast} />}
        </div>
      </div>
      {createTask && <TaskForm user={user} groups={groups} initial={createTask} onToast={onToast} onClose={() => setCreateTask(null)}
        onSaved={t => { setCreateTask(null); setTaskId(t.taskId); }} />}
      {taskId && <TaskDetail user={user} groups={groups} taskId={taskId} onToast={onToast} onClose={() => setTaskId(null)} />}
      {createMeeting && <MeetingForm user={user} groups={groups} initial={createMeeting} onToast={onToast} onClose={() => setCreateMeeting(null)}
        onSaved={m => { setCreateMeeting(null); setTab('meetings'); if (!m.joined) setMeetingId(m.status === 'SCHEDULED' ? m.meetingId : null); }} />}
      {eventId && <EventDetail eventId={eventId} onToast={onToast} onClose={() => setEventId(null)} />}
      {meetingId && <MeetingDetail meetingId={meetingId} onToast={onToast} onClose={() => setMeetingId(null)} />}
    </section>
  );
}
