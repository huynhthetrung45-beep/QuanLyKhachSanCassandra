// API phan he Cong viec & Lich, Nhac nho, Hop truc tuyen. Giu nguyen chi tiet loi (danh sach trung lich, goi y gio trong).
import { ApiError } from '../api';
import { signal } from './extApi';

const BASE = import.meta.env.VITE_API_BASE || '/api/v1';

export class WorkError extends ApiError {
  constructor(status, error) {
    super(status, error.code || 'HTTP_' + status, error.message || 'Yêu cầu không thành công.', error.fields);
    this.details = error;
  }
}

async function request(method, path, { body, query, headers = {} } = {}) {
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  let res;
  try {
    res = await fetch(BASE + path + (qs.length > 1 ? qs : ''), {
      method, credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new WorkError(0, { code: 'NETWORK_ERROR', message: 'Không kết nối được máy chủ ChatOTT.' });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new WorkError(res.status, data?.error || {});
    signal(err);
    throw err;
  }
  return data;
}

// Khoa chong gui lap: sinh 1 lan cho moi lan mo form, gui lai (mang cham) dung lai khoa cu.
export const newIdemKey = () => 'k-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

const enc = encodeURIComponent;
// Ma tham gia phong hop: chi gui trong header, khong dua len URL.
const room = token => ({ 'X-Meeting-Token': token });

export const work = {
  overview: () => request('GET', '/work/overview'),
  tasks: query => request('GET', '/tasks', { query }),
  task: id => request('GET', `/tasks/${enc(id)}`),
  createTask: (payload, key) => request('POST', '/tasks', { body: payload, headers: key ? { 'Idempotency-Key': key } : {} }),
  updateTask: (id, payload) => request('PATCH', `/tasks/${enc(id)}`, { body: payload }),
  setStatus: (id, status, note) => request('POST', `/tasks/${enc(id)}/status`, { body: { status, note } }),
  cancelTask: id => request('DELETE', `/tasks/${enc(id)}`),
  addSession: (id, start, end) => request('POST', `/tasks/${enc(id)}/sessions`, { body: { start, end } }),
  removeSession: (id, eventId) => request('DELETE', `/tasks/${enc(id)}/sessions/${enc(eventId)}`),
  comments: id => request('GET', `/tasks/${enc(id)}/comments`),
  addComment: (id, content) => request('POST', `/tasks/${enc(id)}/comments`, { body: { content } }),
  editComment: (id, commentId, content) => request('PATCH', `/tasks/${enc(id)}/comments/${enc(commentId)}`, { body: { content } }),
  deleteComment: (id, commentId) => request('DELETE', `/tasks/${enc(id)}/comments/${enc(commentId)}`),
  history: id => request('GET', `/tasks/${enc(id)}/history`),
  groupTasks: (cid, query) => request('GET', `/groups/${enc(cid)}/tasks`, { query }),

  calendar: (from, to) => request('GET', '/calendar', { query: { from, to } }),
  groupCalendar: (cid, from, to, members = true) => request('GET', `/groups/${enc(cid)}/calendar`, { query: { from, to, members: members ? undefined : '0' } }),
  checkConflicts: payload => request('POST', '/calendar/check', { body: payload }),
  createEvent: payload => request('POST', '/calendar/events', { body: payload }),
  moveEvent: (id, start, end) => request('PATCH', `/calendar/events/${enc(id)}`, { body: { start, end } }),
  cancelEvent: id => request('DELETE', `/calendar/events/${enc(id)}`),
  event: id => request('GET', `/calendar/events/${enc(id)}`),
  updateEvent: (id, payload) => request('PATCH', `/calendar/events/${enc(id)}`, { body: payload }),

  reminders: status => request('GET', '/reminders', { query: { status } }),
  createReminder: payload => request('POST', '/reminders', { body: payload }),
  updateReminder: (id, payload) => request('PATCH', `/reminders/${enc(id)}`, { body: payload }),
  snooze: (id, minutes) => request('POST', `/reminders/${enc(id)}/snooze`, { body: { minutes } }),
  cancelReminder: id => request('DELETE', `/reminders/${enc(id)}`),

  meetings: scope => request('GET', '/meetings', { query: { scope } }),
  meeting: id => request('GET', `/meetings/${enc(id)}`),
  createMeeting: (payload, key) => request('POST', '/meetings', { body: payload, headers: key ? { 'Idempotency-Key': key } : {} }),
  rescheduleMeeting: (id, payload) => request('PATCH', `/meetings/${enc(id)}`, { body: payload }),
  cancelMeeting: id => request('DELETE', `/meetings/${enc(id)}`),
  inviteMeeting: (id, userIds) => request('POST', `/meetings/${enc(id)}/invitations`, { body: { userIds } }),
  respondMeeting: (id, status) => request('POST', `/meetings/${enc(id)}/respond`, { body: { status } }),
  meetingLink: id => request('POST', `/meetings/${enc(id)}/link`),
  revokeMeetingLink: id => request('DELETE', `/meetings/${enc(id)}/link`),
  joinByLink: code => request('POST', `/meetings/links/${enc(code)}`),
  endMeeting: id => request('POST', `/meetings/${enc(id)}/end`),
  meetingHistory: id => request('GET', `/meetings/${enc(id)}/history`),
  groupMeetings: cid => request('GET', `/groups/${enc(cid)}/meetings`),

  join: (id, replaceSessionId) => request('POST', `/meetings/${enc(id)}/join`, { body: { replaceSessionId } }),
  signal: (id, token, payload) => request('POST', `/meetings/${enc(id)}/signal`, { body: payload, headers: room(token) }),
  heartbeat: (id, token) => request('POST', `/meetings/${enc(id)}/heartbeat`, { body: {}, headers: room(token) }),
  media: (id, token, state) => request('POST', `/meetings/${enc(id)}/media`, { body: state, headers: room(token) }),
  chat: (id, token, content) => request('POST', `/meetings/${enc(id)}/chat`, { body: { content }, headers: room(token) }),
  leave: (id, token) => request('POST', `/meetings/${enc(id)}/leave`, { body: {}, headers: room(token) })
};

// ===== Tien ich thoi gian (hien thi theo gio may nguoi dung, gui len may chu dang ISO UTC) =====
export const pad = n => String(n).padStart(2, '0');
export const toLocalInput = d => {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
};
export const fromLocalInput = v => (v ? new Date(v).toISOString() : null);
export const fmtTime = d => (d ? new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '');
export const fmtDate = d => (d ? new Date(d).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '');
export const fmtDateTime = d => (d ? `${fmtTime(d)} ${new Date(d).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : '');
export const fmtRange = (s, e) => {
  if (!s) return '';
  const same = new Date(s).toDateString() === new Date(e).toDateString();
  return same ? `${fmtTime(s)} – ${fmtTime(e)}, ${fmtDate(s)}` : `${fmtDateTime(s)} – ${fmtDateTime(e)}`;
};
export const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const startOfWeek = d => { const x = startOfDay(d); const wd = (x.getDay() + 6) % 7; return addDays(x, -wd); };

export const STATUS = {
  NOT_STARTED: 'Chưa bắt đầu', IN_PROGRESS: 'Đang thực hiện', PAUSED: 'Tạm dừng', WAITING_REVIEW: 'Chờ xác nhận', DONE: 'Đã hoàn thành', CANCELLED: 'Đã hủy'
};
export const PRIORITY = { LOW: 'Thấp', NORMAL: 'Bình thường', HIGH: 'Cao', URGENT: 'Khẩn cấp' };
export const KIND = { TASK_SESSION: 'Công việc', MEETING: 'Cuộc họp', PERSONAL: 'Lịch cá nhân' };
