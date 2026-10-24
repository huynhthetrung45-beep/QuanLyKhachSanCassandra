// Cong viec (mo rong SRS: phan he Cong viec & Lich).
//
// Phan biet: CONG VIEC (tasks) - PHIEN LAM VIEC tren lich (calendar_events kind TASK_SESSION, 1 cong viec co the co nhieu
// phien) - HAN HOAN THANH (due_at, khong phai khoang thoi gian thuc hien).
//
// Quyen (kiem tra o backend cho MOI thao tac, theo tai nguyen):
//   xem        : nguoi tao, nguoi giao, nguoi thuc hien; cong viec nhom: moi THANH VIEN HIEN TAI cua nhom.
//   quan ly    : nguoi tao, nguoi giao, truong / pho nhom (cong viec nhom) -> sua, doi nguoi thuc hien, doi lich, huy.
//   tien do    : nguoi thuc hien -> Dang thuc hien / Tam dung / Cho xac nhan (cong viec nhom), Hoan thanh (cong viec ca nhan).
//   nguoi giao : chi giao cho thanh vien cua nhom tai thoi diem giao.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, Uuid, iso } = require('../utils/types');
const userService = require('../services/user.service');
const realtime = require('../services/realtime.service');
const cal = require('./calendar.service');
const reminders = require('./reminder.service');
const idem = require('./lib/idempotency');

const notifications = () => require('../services/notification.service');

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'WAITING_REVIEW', 'DONE', 'CANCELLED'];
const STATUS_LABEL = { NOT_STARTED: 'Chưa bắt đầu', IN_PROGRESS: 'Đang thực hiện', PAUSED: 'Tạm dừng', WAITING_REVIEW: 'Chờ xác nhận', DONE: 'Đã hoàn thành', CANCELLED: 'Đã hủy' };
const PRIORITY_LABEL = { LOW: 'Thấp', NORMAL: 'Bình thường', HIGH: 'Cao', URGENT: 'Khẩn cấp' };
// Chuyen trang thai hop le.
const TRANSITIONS = {
    NOT_STARTED: ['IN_PROGRESS', 'WAITING_REVIEW', 'DONE', 'CANCELLED'],
    IN_PROGRESS: ['PAUSED', 'WAITING_REVIEW', 'DONE', 'CANCELLED'],
    PAUSED: ['IN_PROGRESS', 'CANCELLED'],
    WAITING_REVIEW: ['DONE', 'IN_PROGRESS', 'CANCELLED'],
    DONE: ['IN_PROGRESS'],
    CANCELLED: ['NOT_STARTED']
};
const TASK_COLS = `task_id, title, description, scope, conversation_id, creator_id, assigner_id, assignee_ids, lead_id, start_at, end_at, due_at,
                   priority, status, labels, primary_event_id, session_ids, created_at, updated_at, completed_at`;
const CONTROL_RE = new RegExp('[' + [[0, 8], [11, 12], [14, 31], [127, 159], [8203, 8207], [8232, 8238], [8294, 8297]]
    .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']', 'g');

const clean = (v, max) => String(v || '').replace(CONTROL_RE, '').trim().slice(0, max);
const assigneesOf = t => [...(t.assignee_ids || [])].map(String);

function parseId(value, name = 'taskId') {
    try { return TimeUuid.fromString(String(value)); } catch { throw httpError(400, 'INVALID_ID', `${name} không hợp lệ.`); }
}

async function readTask(taskId) {
    return (await db.execute(`SELECT ${TASK_COLS} FROM tasks WHERE task_id = ?`, [taskId])).first();
}

async function groupMembers(cid) {
    const conv = (await db.execute('SELECT participant_ids, conversation_type, conversation_name FROM conversations WHERE conversation_id = ?', [cid])).first();
    return conv ? { members: [...(conv.participant_ids || [])].map(String), name: conv.conversation_name } : { members: [], name: null };
}

async function isGroupManager(user, cid) {
    try {
        const ctx = await require('./group.service').context(cid.toString(), user);
        return ctx.canManage;
    } catch {
        return false;
    }
}

async function access(user, task) {
    const assignees = assigneesOf(task);
    const isCreator = task.creator_id === user.userId;
    const isAssigner = task.assigner_id === user.userId;
    const isAssignee = assignees.includes(user.userId);
    let isMember = false;
    let isManagerOfGroup = false;
    if (task.scope === 'GROUP' && task.conversation_id) {
        isMember = (await groupMembers(task.conversation_id)).members.includes(user.userId);
        if (isMember) isManagerOfGroup = await isGroupManager(user, task.conversation_id);
    }
    // Nguoi da roi nhom mat quyen voi cong viec nhom, ke ca neu tung la nguoi tao / duoc giao.
    const inScope = task.scope !== 'GROUP' || isMember;
    return {
        view: inScope && (isCreator || isAssigner || isAssignee || isMember),
        manage: inScope && (isCreator || isAssigner || isManagerOfGroup),
        progress: inScope && isAssignee,
        isCreator, isAssigner, isAssignee
    };
}

async function requireTask(user, taskId) {
    const task = await readTask(parseId(taskId));
    if (!task) throw httpError(404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
    const acl = await access(user, task);
    // Khong co quyen xem -> 404 (khong tiet lo cong viec ton tai khi doan ID).
    if (!acl.view) throw httpError(404, 'TASK_NOT_FOUND', 'Không tìm thấy công việc.');
    return { task, acl };
}

async function requireVisibleTask(user, taskId) {
    return (await requireTask(user, taskId)).task;
}

async function history(taskId, actorId, action, detail = '') {
    await db.execute('INSERT INTO task_history_by_task (task_id, event_id, actor_id, action, detail) VALUES (?, ?, ?, ?, ?)',
        [taskId, TimeUuid.now(), actorId, action, String(detail).slice(0, 500)]);
}

async function notify(userIds, actor, type, task, preview, keySuffix = '') {
    for (const recipientId of [...new Set(userIds)].filter(u => u && u !== actor.userId)) {
        await notifications().notifySafe({
            recipientId, actorId: actor.userId, type, preview: `“${task.title}”${preview ? ' – ' + preview : ''}`,
            dedupeKey: `${type}:${task.task_id}:${recipientId}:${keySuffix || Date.now()}`, ref: { type: 'TASK', id: task.task_id.toString() }
        });
    }
}

function publish(task, extra = []) {
    realtime.publish([task.creator_id, task.assigner_id, ...assigneesOf(task), ...extra].filter(Boolean), 'task:changed', { taskId: task.task_id.toString() });
}

// ===== DTO =====
async function dto(task, user, acl = null, { detail = false } = {}) {
    const a = acl || await access(user, task);
    const ids = [task.creator_id, task.assigner_id, ...assigneesOf(task)].filter(Boolean);
    const profiles = await userService.getUsersByIds(ids);
    const person = id => (id ? { userId: id, displayName: profiles.get(id)?.displayName || id } : null);
    const now = Date.now();
    const due = task.due_at ? new Date(task.due_at).getTime() : null;
    const open = !['DONE', 'CANCELLED'].includes(task.status);
    const out = {
        taskId: task.task_id.toString(), title: task.title, description: task.description || '', scope: task.scope,
        conversationId: task.conversation_id ? task.conversation_id.toString() : null,
        creator: person(task.creator_id), assigner: person(task.assigner_id), assignees: assigneesOf(task).map(person), lead: person(task.lead_id),
        start: iso(task.start_at), end: iso(task.end_at), dueAt: iso(task.due_at),
        priority: task.priority, priorityLabel: PRIORITY_LABEL[task.priority], status: task.status, statusLabel: STATUS_LABEL[task.status],
        labels: [...(task.labels || [])], createdAt: iso(task.created_at), updatedAt: iso(task.updated_at), completedAt: iso(task.completed_at),
        overdue: Boolean(open && due && due < now), dueSoon: Boolean(open && due && due >= now && due - now <= 48 * 3600000),
        unassigned: assigneesOf(task).length === 0,
        permissions: { manage: a.manage, progress: a.progress, comment: a.view },
        allowedStatuses: (TRANSITIONS[task.status] || []).filter(s => canTransition(a, task, s))
    };
    if (task.conversation_id) out.groupName = (await groupMembers(task.conversation_id)).name;
    if (detail) {
        const sessions = [];
        for (const sid of [...(task.session_ids || [])]) {
            const ev = await cal.readEvent(sid);
            if (ev && ev.status === 'ACTIVE') sessions.push({ eventId: ev.event_id.toString(), start: iso(ev.start_at), end: iso(ev.end_at), primary: String(ev.event_id) === String(task.primary_event_id) });
        }
        out.sessions = sessions.sort((x, y) => x.start.localeCompare(y.start));
    }
    return out;
}

// ===== Kiem tra du lieu =====
function validatePriority(p, fallback = 'NORMAL') {
    if (p === undefined || p === null || p === '') return fallback;
    const v = String(p).toUpperCase();
    if (!PRIORITIES.includes(v)) throw httpError(400, 'INVALID_PRIORITY', 'Mức ưu tiên phải là LOW, NORMAL, HIGH hoặc URGENT.');
    return v;
}

function validateLabels(labels) {
    if (labels === undefined) return undefined;
    if (!Array.isArray(labels)) throw httpError(400, 'INVALID_LABELS', 'labels phải là danh sách.');
    return [...new Set(labels.map(l => clean(l, 30)).filter(Boolean))].slice(0, 10);
}

function validateTimes(start, end, due) {
    if ((start && !end) || (!start && end)) throw httpError(400, 'INVALID_TIME', 'Cần cả thời gian bắt đầu và kết thúc (hoặc bỏ trống cả hai).');
    if (start && end) cal.validateRange(start, end);
    if (due && start && due.getTime() <= start.getTime()) throw httpError(400, 'INVALID_TIME', 'Hạn hoàn thành phải sau thời gian bắt đầu.');
    if (due && end && end.getTime() > due.getTime()) throw httpError(400, 'INVALID_TIME', 'Lịch thực hiện kết thúc sau hạn hoàn thành. Hãy dời hạn hoặc rút ngắn lịch.');
}

// ===== Tao =====
async function createTask(user, body = {}, { idemKey = null } = {}) {
    const title = clean(body.title, 200);
    if (!title) throw httpError(400, 'INVALID_TITLE', 'Tiêu đề công việc từ 1 đến 200 ký tự.');
    const description = clean(body.description, 5000);
    const scope = String(body.scope || (body.conversationId ? 'GROUP' : 'PERSONAL')).toUpperCase();
    if (!['PERSONAL', 'GROUP'].includes(scope)) throw httpError(400, 'INVALID_SCOPE', 'scope phải là PERSONAL hoặc GROUP.');
    let cid = null;
    let assignees;
    if (scope === 'GROUP') {
        ({ cid } = await cal.requireGroupMember(body.conversationId, user.userId));
        const { members } = await groupMembers(cid);
        assignees = [...new Set((Array.isArray(body.assigneeIds) ? body.assigneeIds : []).map(String))];
        const outsiders = assignees.filter(id => !members.includes(id));
        if (outsiders.length) throw httpError(400, 'ASSIGNEE_NOT_IN_GROUP', 'Chỉ giao việc cho thành viên hiện tại của nhóm.', { userIds: outsiders });
        if (assignees.length > 50) throw httpError(400, 'INVALID_ASSIGNEES', 'Tối đa 50 người thực hiện.');
    } else {
        const others = (Array.isArray(body.assigneeIds) ? body.assigneeIds : []).map(String).filter(id => id !== user.userId);
        if (others.length) throw httpError(400, 'PERSONAL_TASK_SELF_ONLY', 'Công việc cá nhân chỉ dành cho chính bạn. Hãy tạo công việc nhóm để giao cho người khác.');
        assignees = [user.userId];
    }
    const leadId = body.leadId ? String(body.leadId) : (assignees[0] || null);
    if (leadId && !assignees.includes(leadId)) throw httpError(400, 'INVALID_LEAD', 'Người chịu trách nhiệm chính phải nằm trong danh sách người thực hiện.');
    const start = cal.parseTime(body.start, 'start');
    const end = cal.parseTime(body.end, 'end');
    const due = cal.parseTime(body.dueAt, 'dueAt');
    validateTimes(start, end, due);
    const priority = validatePriority(body.priority);
    const labels = validateLabels(body.labels) || [];
    const reminderPlan = Array.isArray(body.reminders) ? body.reminders.slice(0, 5) : [];

    const taskId = TimeUuid.now();
    const claim = await idem.claim(user.userId, idemKey, 'TASK', taskId);
    if (!claim.claimed) {
        const existing = await readTask(TimeUuid.fromString(claim.resourceId));
        if (!existing) throw httpError(409, 'REQUEST_IN_PROGRESS', 'Yêu cầu trước với cùng Idempotency-Key đang được xử lý.');
        return { ...(await dto(existing, user, null, { detail: true })), replayed: true };
    }
    let event = null;
    try {
        // Phien lam viec dau tien: kiem tra trung lich cua TUNG nguoi thuc hien (duoi khoa) TRUOC khi ghi cong viec.
        if (start && end && assignees.length) {
            event = await cal.createEvent({
                kind: 'TASK_SESSION', title, ownerId: user.userId, conversationId: cid, taskId, participants: assignees, start, end,
                visibility: scope === 'GROUP' ? 'GROUP' : 'PRIVATE'
            }, { viewerId: user.userId });
        }
        const now = new Date();
        await db.execute(`INSERT INTO tasks (${TASK_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            taskId, title, description || null, scope, cid, user.userId, user.userId, assignees, leadId, start, end, due, priority, 'NOT_STARTED',
            labels, event ? event.event_id : null, event ? [event.event_id] : [], now, now, null]);
    } catch (error) {
        if (event) await cal.cancelEvent(event.event_id).catch(() => {});
        await idem.release(user.userId, idemKey);
        throw error;
    }
    const indexQ = [...new Set([user.userId, ...assignees])].map(u => ({
        query: 'INSERT INTO tasks_by_user (user_id, task_id, is_creator, is_assignee) VALUES (?, ?, ?, ?)',
        params: [u, taskId, u === user.userId, assignees.includes(u)]
    }));
    if (cid) indexQ.push({ query: 'INSERT INTO tasks_by_group (conversation_id, task_id) VALUES (?, ?)', params: [cid, taskId] });
    await db.batch(indexQ, { logged: false });
    await history(taskId, user.userId, 'CREATED', assignees.length ? `Giao cho ${assignees.length} người` : 'Chưa giao cho ai');
    const task = await readTask(taskId);
    // Nhac nho: ap dung cho tung nguoi thuc hien (nguoi tu cau hinh, khong tao mac dinh lien tuc).
    for (const assignee of assignees) {
        for (const r of reminderPlan) {
            await reminders.createReminder({ userId: assignee }, { targetType: 'TASK', targetId: taskId.toString(), anchor: r.anchor, offsetMinutes: r.offsetMinutes })
                .catch(() => {});
        }
    }
    await notify(assignees, user, 'TASK_ASSIGNED', task, due ? `hạn ${require('./lib/timefmt').formatWhen(due)}` : '', 'create');
    publish(task);
    return dto(task, user, null, { detail: true });
}

// ===== Doc =====
async function getTask(user, taskId) {
    const { task, acl } = await requireTask(user, taskId);
    return dto(task, user, acl, { detail: true });
}

function matches(t, f, userId) {
    if (f.status && !String(f.status).split(',').includes(t.status)) return false;
    if (f.priority && !String(f.priority).split(',').includes(t.priority)) return false;
    if (f.groupId && (!t.conversation_id || t.conversation_id.toString() !== f.groupId)) return false;
    if (f.assigneeId && !assigneesOf(t).includes(f.assigneeId)) return false;
    if (f.assignerId && t.assigner_id !== f.assignerId) return false;
    if (f.relation === 'assigned' && !assigneesOf(t).includes(userId)) return false;
    if (f.relation === 'created' && t.creator_id !== userId) return false;
    const anchor = t.due_at || t.start_at;
    if (f.from && (!anchor || new Date(anchor) < new Date(f.from))) return false;
    if (f.to && (!anchor || new Date(anchor) > new Date(f.to))) return false;
    return true;
}

async function loadFrom(query, params, user, f, cap = 500) {
    const rs = await db.execute(query, params, { fetchSize: cap });
    const out = [];
    for (const row of rs.rows) {
        const t = await readTask(row.task_id);
        if (!t || !matches(t, f, user.userId)) continue;
        const acl = await access(user, t);
        if (!acl.view) continue;
        out.push(await dto(t, user, acl));
    }
    return out;
}

const sortTasks = list => list.sort((a, b) => {
    const order = s => ['IN_PROGRESS', 'WAITING_REVIEW', 'NOT_STARTED', 'PAUSED', 'DONE', 'CANCELLED'].indexOf(s);
    return order(a.status) - order(b.status) || String(a.dueAt || a.start || '9').localeCompare(String(b.dueAt || b.start || '9'));
});

// GET /tasks/mine?relation=assigned|created&status=&priority=&groupId=&assigneeId=&assignerId=&from=&to=&limit=&offsetId=
async function listMine(user, query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    const items = sortTasks(await loadFrom('SELECT task_id FROM tasks_by_user WHERE user_id = ?', [user.userId], user, query));
    // Phan trang theo vi tri sau khi sap xep (tap ket qua toi da 500 cong viec / nguoi).
    const startAt = query.after ? items.findIndex(t => t.taskId === query.after) + 1 : 0;
    const page = items.slice(startAt, startAt + limit);
    return { items: page, total: items.length, nextAfter: startAt + limit < items.length ? page[page.length - 1].taskId : null };
}

async function listGroup(user, conversationId, query = {}) {
    const { cid } = await cal.requireGroupMember(conversationId, user.userId);
    const items = sortTasks(await loadFrom('SELECT task_id FROM tasks_by_group WHERE conversation_id = ?', [cid], user, query));
    return { conversationId: cid.toString(), items, unassigned: items.filter(t => t.unassigned) };
}

// ===== Sua =====
async function updateTask(user, taskId, body = {}) {
    const { task, acl } = await requireTask(user, taskId);
    if (!acl.manage) throw httpError(403, 'FORBIDDEN_TASK', 'Chỉ người tạo, người giao việc hoặc trưởng/phó nhóm mới được sửa công việc.');
    if (['CANCELLED'].includes(task.status)) throw httpError(409, 'TASK_CANCELLED', 'Công việc đã hủy, hãy mở lại trước khi sửa.');
    const changes = [];
    const set = {};
    if (body.title !== undefined) { const v = clean(body.title, 200); if (!v) throw httpError(400, 'INVALID_TITLE', 'Tiêu đề từ 1 đến 200 ký tự.'); if (v !== task.title) { set.title = v; changes.push('tiêu đề'); } }
    if (body.description !== undefined) { set.description = clean(body.description, 5000) || null; changes.push('mô tả'); }
    if (body.priority !== undefined) { const v = validatePriority(body.priority); if (v !== task.priority) { set.priority = v; changes.push('mức ưu tiên: ' + PRIORITY_LABEL[v]); } }
    if (body.labels !== undefined) { set.labels = validateLabels(body.labels); changes.push('nhãn'); }
    const start = body.start !== undefined ? cal.parseTime(body.start, 'start') : task.start_at && new Date(task.start_at);
    const end = body.end !== undefined ? cal.parseTime(body.end, 'end') : task.end_at && new Date(task.end_at);
    const due = body.dueAt !== undefined ? cal.parseTime(body.dueAt, 'dueAt') : task.due_at && new Date(task.due_at);
    validateTimes(start || null, end || null, due || null);

    // Nguoi thuc hien
    let assignees = assigneesOf(task);
    let added = [];
    let removed = [];
    if (body.assigneeIds !== undefined) {
        if (task.scope !== 'GROUP') throw httpError(400, 'PERSONAL_TASK_SELF_ONLY', 'Công việc cá nhân không đổi người thực hiện.');
        const { members } = await groupMembers(task.conversation_id);
        const next = [...new Set((Array.isArray(body.assigneeIds) ? body.assigneeIds : []).map(String))];
        const outsiders = next.filter(id => !members.includes(id));
        if (outsiders.length) throw httpError(400, 'ASSIGNEE_NOT_IN_GROUP', 'Chỉ giao việc cho thành viên hiện tại của nhóm.', { userIds: outsiders });
        added = next.filter(id => !assignees.includes(id));
        removed = assignees.filter(id => !next.includes(id));
        assignees = next;
        if (added.length || removed.length) changes.push('người thực hiện');
    }
    let lead = body.leadId !== undefined ? (body.leadId ? String(body.leadId) : null) : task.lead_id;
    if (lead && !assignees.includes(lead)) lead = assignees[0] || null;

    // Lich: doi gio / doi nguoi -> cap nhat phien chinh duoi khoa + kiem tra trung (that bai -> khong ghi gi).
    const timeChanged = String(iso(start)) !== String(iso(task.start_at)) || String(iso(end)) !== String(iso(task.end_at));
    let primary = task.primary_event_id;
    let sessionIds = [...(task.session_ids || [])];
    if (timeChanged) changes.push('thời gian thực hiện');
    if (primary && (timeChanged || added.length || removed.length)) {
        if (start && end && assignees.length) {
            await cal.updateEvent(primary, { start, end, participants: assignees, title: set.title }, { viewerId: user.userId });
        } else {
            await cal.cancelEvent(primary);
            sessionIds = sessionIds.filter(s => String(s) !== String(primary));
            primary = null;
        }
        // Cac phien phu: chi doi nguoi tham gia (kiem tra trung cho nguoi moi).
        for (const sid of sessionIds.filter(s => String(s) !== String(primary))) {
            if ((added.length || removed.length) && assignees.length) await cal.updateEvent(sid, { participants: assignees }, { viewerId: user.userId });
        }
    } else if (!primary && start && end && assignees.length) {
        const ev = await cal.createEvent({ kind: 'TASK_SESSION', title: set.title || task.title, ownerId: task.creator_id, conversationId: task.conversation_id,
            taskId: task.task_id, participants: assignees, start, end, visibility: task.scope === 'GROUP' ? 'GROUP' : 'PRIVATE' }, { viewerId: user.userId });
        primary = ev.event_id;
        sessionIds.push(ev.event_id);
    }
    if (body.dueAt !== undefined && String(iso(due)) !== String(iso(task.due_at))) changes.push('hạn hoàn thành');

    const cols = { ...set, start_at: start || null, end_at: end || null, due_at: due || null, assignee_ids: assignees, lead_id: lead,
        primary_event_id: primary || null, session_ids: sessionIds, updated_at: new Date() };
    if (added.length || removed.length) cols.assigner_id = user.userId;
    const keys = Object.keys(cols);
    await db.execute(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE task_id = ?`, [...keys.map(k => cols[k]), task.task_id]);
    const idx = [];
    for (const u of added) idx.push({ query: 'INSERT INTO tasks_by_user (user_id, task_id, is_creator, is_assignee) VALUES (?, ?, ?, ?)', params: [u, task.task_id, u === task.creator_id, true] });
    for (const u of removed) {
        idx.push(u === task.creator_id
            ? { query: 'UPDATE tasks_by_user SET is_assignee = false WHERE user_id = ? AND task_id = ?', params: [u, task.task_id] }
            : { query: 'DELETE FROM tasks_by_user WHERE user_id = ? AND task_id = ?', params: [u, task.task_id] });
        await reminders.cancelTarget('TASK', task.task_id.toString(), { userId: u });
    }
    if (idx.length) await db.batch(idx, { logged: false });
    if (timeChanged || body.dueAt !== undefined) await reminders.rescheduleTarget('TASK', task.task_id.toString());
    const fresh = await readTask(task.task_id);
    if (changes.length) {
        await history(task.task_id, user.userId, 'UPDATED', 'Thay đổi ' + changes.join(', '));
        await notify(added, user, 'TASK_ASSIGNED', fresh, '', 'add');
        await notify(assignees.filter(u => !added.includes(u)), user, 'TASK_UPDATED', fresh, changes.join(', '));
        await notify(removed, user, 'TASK_UPDATED', fresh, 'bạn không còn được giao công việc này');
    }
    publish(fresh, removed);
    return dto(fresh, user, null, { detail: true });
}

function canTransition(acl, task, next) {
    if (acl.manage) return true;
    if (!acl.progress) return false;
    // Nguoi thuc hien cong viec nhom: tien do + gui cho xac nhan; hoan thanh / huy / mo lai do nguoi quan ly.
    if (task.scope === 'GROUP') return ['IN_PROGRESS', 'PAUSED', 'WAITING_REVIEW'].includes(next) && task.status !== 'DONE';
    return next !== 'CANCELLED';
}

async function setStatus(user, taskId, body = {}) {
    const { task, acl } = await requireTask(user, taskId);
    const next = String(body.status || '').toUpperCase();
    if (!STATUSES.includes(next)) throw httpError(400, 'INVALID_STATUS', 'Trạng thái không hợp lệ.');
    if (next === task.status) return dto(task, user, acl, { detail: true });
    if (!(TRANSITIONS[task.status] || []).includes(next)) {
        throw httpError(409, 'INVALID_TRANSITION', `Không thể chuyển từ “${STATUS_LABEL[task.status]}” sang “${STATUS_LABEL[next]}”.`);
    }
    if (!canTransition(acl, task, next)) throw httpError(403, 'FORBIDDEN_TASK', 'Bạn không có quyền chuyển công việc sang trạng thái này.');
    // LWT theo trang thai dang doc: 2 nguoi doi cung luc -> chi 1 nguoi thang.
    const rs = await db.execute('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE task_id = ? IF status = ?',
        [next, next === 'DONE' ? new Date() : null, new Date(), task.task_id, task.status]);
    if (!rs.wasApplied()) throw httpError(409, 'TASK_CHANGED', 'Công việc vừa được người khác cập nhật, hãy tải lại.');
    const note = clean(body.note, 300);
    await history(task.task_id, user.userId, 'STATUS', `${STATUS_LABEL[task.status]} → ${STATUS_LABEL[next]}${note ? ': ' + note : ''}`);
    if (next === 'CANCELLED') {
        for (const sid of [...(task.session_ids || [])]) await cal.cancelEvent(sid);
        await reminders.cancelTarget('TASK', task.task_id.toString());
    }
    if (task.status === 'CANCELLED' && next === 'NOT_STARTED') {
        // Mo lai: phien lich da huy khong tu dong khoi phuc (tranh ghi lich trung); nguoi quan ly dat lai lich.
        await db.execute('UPDATE tasks SET primary_event_id = null, session_ids = ? WHERE task_id = ?', [[], task.task_id]);
    }
    const fresh = await readTask(task.task_id);
    await notify([task.creator_id, task.assigner_id, ...assigneesOf(task)], user, 'TASK_STATUS', fresh, STATUS_LABEL[next]);
    publish(fresh);
    return dto(fresh, user, null, { detail: true });
}

// Huy (khong xoa vat ly).
const cancelTask = (user, taskId) => setStatus(user, taskId, { status: 'CANCELLED' });

// Them phien lam viec (1 cong viec nhieu phien).
async function addSession(user, taskId, body = {}) {
    const { task, acl } = await requireTask(user, taskId);
    if (!acl.manage) throw httpError(403, 'FORBIDDEN_TASK', 'Chỉ người quản lý công việc mới được lên lịch.');
    if (['DONE', 'CANCELLED'].includes(task.status)) throw httpError(409, 'TASK_CLOSED', 'Công việc đã đóng.');
    const assignees = assigneesOf(task);
    if (!assignees.length) throw httpError(400, 'TASK_UNASSIGNED', 'Hãy giao việc cho ít nhất một người trước khi lên lịch.');
    const start = cal.parseTime(body.start, 'start');
    const end = cal.parseTime(body.end, 'end');
    cal.validateRange(start, end);
    if (task.due_at && end > new Date(task.due_at)) throw httpError(400, 'INVALID_TIME', 'Phiên làm việc kết thúc sau hạn hoàn thành.');
    const ev = await cal.createEvent({ kind: 'TASK_SESSION', title: task.title, ownerId: task.creator_id, conversationId: task.conversation_id, taskId: task.task_id,
        participants: assignees, start, end, visibility: task.scope === 'GROUP' ? 'GROUP' : 'PRIVATE' }, { viewerId: user.userId });
    await db.execute('UPDATE tasks SET session_ids = session_ids + ?, updated_at = ? WHERE task_id = ?', [[ev.event_id], new Date(), task.task_id]);
    if (!task.primary_event_id) await db.execute('UPDATE tasks SET primary_event_id = ?, start_at = ?, end_at = ? WHERE task_id = ?', [ev.event_id, start, end, task.task_id]);
    await history(task.task_id, user.userId, 'SESSION_ADDED', `${iso(start)} – ${iso(end)}`);
    publish(task);
    return getTask(user, taskId);
}

// Keo tha phien tren lich (goi tu calendar.moveEvent).
async function moveSession(user, ev, { start, end }) {
    const { task, acl } = await requireTask(user, ev.task_id.toString());
    if (!acl.manage) throw httpError(403, 'FORBIDDEN_TASK', 'Chỉ người quản lý công việc mới được dời lịch.');
    if (task.due_at && end && end > new Date(task.due_at)) throw httpError(400, 'INVALID_TIME', 'Lịch mới kết thúc sau hạn hoàn thành.');
    const updated = await cal.updateEvent(ev.event_id, { start, end }, { viewerId: user.userId });
    if (String(ev.event_id) === String(task.primary_event_id)) {
        await db.execute('UPDATE tasks SET start_at = ?, end_at = ?, updated_at = ? WHERE task_id = ?', [start, end, new Date(), task.task_id]);
        await reminders.rescheduleTarget('TASK', task.task_id.toString());
    }
    await history(task.task_id, user.userId, 'SESSION_MOVED', `${iso(start)} – ${iso(end)}`);
    const fresh = await readTask(task.task_id);
    await notify(assigneesOf(task), user, 'TASK_UPDATED', fresh, 'thời gian thực hiện');
    publish(fresh);
    return cal.eventDto(updated, user.userId, true);
}

async function removeSession(user, taskId, eventId) {
    const { task, acl } = await requireTask(user, taskId);
    if (!acl.manage) throw httpError(403, 'FORBIDDEN_TASK', 'Chỉ người quản lý công việc mới được xóa phiên làm việc.');
    const sid = parseId(eventId, 'eventId');
    if (![...(task.session_ids || [])].some(s => String(s) === String(sid))) throw httpError(404, 'EVENT_NOT_FOUND', 'Không tìm thấy phiên làm việc.');
    await cal.cancelEvent(sid);
    await db.execute('UPDATE tasks SET session_ids = session_ids - ?, updated_at = ? WHERE task_id = ?', [[sid], new Date(), task.task_id]);
    if (String(sid) === String(task.primary_event_id)) await db.execute('UPDATE tasks SET primary_event_id = null, start_at = null, end_at = null WHERE task_id = ?', [task.task_id]);
    await history(task.task_id, user.userId, 'SESSION_REMOVED', '');
    publish(task);
    return getTask(user, taskId);
}

// ===== Binh luan & lich su =====
async function listComments(user, taskId) {
    const { task } = await requireTask(user, taskId);
    const rows = (await db.execute('SELECT comment_id, author_id, content, edited_at, is_deleted FROM task_comments_by_task WHERE task_id = ? LIMIT 500', [task.task_id])).rows;
    const profiles = await userService.getUsersByIds(rows.map(r => r.author_id));
    return {
        items: rows.map(r => ({
            commentId: r.comment_id.toString(), author: { userId: r.author_id, displayName: profiles.get(r.author_id)?.displayName || r.author_id },
            content: r.is_deleted ? null : r.content, deleted: Boolean(r.is_deleted), createdAt: iso(r.comment_id.getDate()), editedAt: iso(r.edited_at),
            canEdit: !r.is_deleted && r.author_id === user.userId
        }))
    };
}

async function addComment(user, taskId, body = {}) {
    const { task } = await requireTask(user, taskId);
    const content = clean(body.content, 2000);
    if (!content) throw httpError(400, 'INVALID_CONTENT', 'Bình luận từ 1 đến 2000 ký tự.');
    const id = TimeUuid.now();
    await db.execute('INSERT INTO task_comments_by_task (task_id, comment_id, author_id, content, is_deleted) VALUES (?, ?, ?, ?, false)', [task.task_id, id, user.userId, content]);
    await notify([task.creator_id, task.assigner_id, ...assigneesOf(task)], user, 'TASK_COMMENT', task, content.slice(0, 80), id.toString());
    publish(task);
    return listComments(user, taskId);
}

async function editComment(user, taskId, commentId, body = {}, remove = false) {
    const { task, acl } = await requireTask(user, taskId);
    const cid = parseId(commentId, 'commentId');
    const row = (await db.execute('SELECT author_id, is_deleted FROM task_comments_by_task WHERE task_id = ? AND comment_id = ?', [task.task_id, cid])).first();
    if (!row || row.is_deleted) throw httpError(404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận.');
    if (row.author_id !== user.userId && !(remove && acl.manage)) throw httpError(403, 'FORBIDDEN', 'Bạn không có quyền sửa bình luận này.');
    if (remove) {
        await db.execute('UPDATE task_comments_by_task SET is_deleted = true, content = null WHERE task_id = ? AND comment_id = ?', [task.task_id, cid]);
    } else {
        const content = clean(body.content, 2000);
        if (!content) throw httpError(400, 'INVALID_CONTENT', 'Bình luận từ 1 đến 2000 ký tự.');
        await db.execute('UPDATE task_comments_by_task SET content = ?, edited_at = ? WHERE task_id = ? AND comment_id = ?', [content, new Date(), task.task_id, cid]);
    }
    publish(task);
    return listComments(user, taskId);
}

async function listHistory(user, taskId) {
    const { task } = await requireTask(user, taskId);
    const rows = (await db.execute('SELECT event_id, actor_id, action, detail FROM task_history_by_task WHERE task_id = ? LIMIT 200', [task.task_id])).rows;
    const profiles = await userService.getUsersByIds(rows.map(r => r.actor_id));
    return { items: rows.map(r => ({ at: iso(r.event_id.getDate()), actor: profiles.get(r.actor_id)?.displayName || r.actor_id, action: r.action, detail: r.detail })) };
}

// ===== Tong quan =====
async function overview(user) {
    const mine = (await listMine(user, { limit: 100 })).items;
    const open = t => !['DONE', 'CANCELLED'].includes(t.status);
    const now = new Date();
    const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
    const tomorrow = new Date(dayStart.getTime() + 2 * 86400000);
    const today = await cal.userCalendar(user, { from: new Date(now.getTime() - 12 * 3600000).toISOString(), to: tomorrow.toISOString() });
    const meetings = await require('./meeting.service').upcoming(user, { limit: 5 }).catch(() => ({ items: [] }));
    const rem = await reminders.listReminders(user, { status: 'upcoming' }).catch(() => ({ items: [] }));
    // Cong viec moi trong cac nhom toi tham gia (3 ngay gan nhat).
    const groups = (await db.execute('SELECT conversation_id, conversation_type FROM conversations_by_user WHERE user_id = ?', [user.userId])).rows
        .filter(r => r.conversation_type === 'GROUP').map(r => r.conversation_id.toString());
    const recentGroup = [];
    for (const gid of [...new Set(groups)].slice(0, 20)) {
        const rows = (await db.execute('SELECT task_id FROM tasks_by_group WHERE conversation_id = ? LIMIT 10', [Uuid.fromString(gid)])).rows;
        for (const r of rows) {
            if (now - r.task_id.getDate() > 3 * 86400000) continue;
            const t = await readTask(r.task_id);
            if (!t) continue;
            const acl = await access(user, t);
            if (acl.view) recentGroup.push(await dto(t, user, acl));
        }
    }
    return {
        assignedToMe: mine.filter(t => open(t) && t.assignees.some(a => a.userId === user.userId)),
        createdByMe: mine.filter(t => open(t) && t.creator?.userId === user.userId),
        inProgress: mine.filter(t => t.status === 'IN_PROGRESS'),
        dueSoon: mine.filter(t => t.dueSoon),
        overdue: mine.filter(t => t.overdue),
        done: mine.filter(t => t.status === 'DONE').slice(0, 10),
        needsMyReview: mine.filter(t => t.status === 'WAITING_REVIEW' && t.permissions.manage),
        today: today.items,
        upcomingMeetings: meetings.items,
        upcomingReminders: rem.items.slice(0, 10),
        newInGroups: recentGroup.filter(t => t.creator?.userId !== user.userId).slice(0, 15)
    };
}

module.exports = {
    createTask, getTask, listMine, listGroup, updateTask, setStatus, cancelTask, addSession, moveSession, removeSession,
    listComments, addComment, editComment, listHistory, overview, requireVisibleTask, readTask, access, STATUSES, PRIORITIES, STATUS_LABEL
};
