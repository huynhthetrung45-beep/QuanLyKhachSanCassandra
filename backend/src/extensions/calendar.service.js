// Lich thong nhat + chong trung lich (mo rong SRS: phan he Cong viec & Lich, Hop truc tuyen).
//
// Mo hinh:
//  - calendar_events la BANG NGUON cua moi su kien lich (phien lam viec cua cong viec, cuoc hop, hoat dong ca nhan).
//    Lich ca nhan va lich nhom cung doc tu bang nay -> khong co 2 ban ghi doc lap bi lech nhau.
//  - events_by_user_day / events_by_group_day la CHI MUC doc theo (nguoi | nhom, ngay UTC). Su kien keo dai nhieu
//    ngay co 1 dong o moi ngay no cham toi. Kiem tra trung lich cua 1 nguoi chi doc cac partition (nguoi, ngay) lien quan.
//  - Khi doc chi muc, moi dong duoc doi chieu voi bang nguon (con ACTIVE, nguoi do con la thanh vien, gio khop);
//    dong lech (do loi giua chung) bi bo qua va don di.
//
// Quy tac trung: khoang nua mo [start, end): A trung B <=> A.start < B.end AND B.start < A.end.
// Su kien CANCELLED khong chiem thoi gian (chi muc bi xoa khi huy).
//
// Dong thoi (Cassandra khong co giao dich nhieu bang):
//  - Moi thao tac tao / doi lich giu KHOA THEO NGUOI (schedule_locks, LWT IF NOT EXISTS, USING TTL) cho TAT CA nguoi
//    tham gia, theo thu tu user_id tang dan (tranh deadlock), roi moi kiem tra trung + ghi + nha khoa.
//  - Hai yeu cau dong thoi cung dat lich cho 1 nguoi: chi 1 yeu cau giu duoc khoa; yeu cau kia cho / thu lai, sau do
//    kiem tra lai va nhan SCHEDULE_CONFLICT. Gioi han: khoa co TTL; neu 1 thao tac chay lau hon TTL (hiem) khoa het han.
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, Uuid, iso } = require('../utils/types');
const userService = require('../services/user.service');
const realtime = require('../services/realtime.service');

const MAX_EVENT_DAYS = 7;
const LOCK_TTL = 15;          // giay
const LOCK_RETRIES = 25;
const KINDS = ['TASK_SESSION', 'MEETING', 'PERSONAL'];
const DAY_MS = 86400000;

// ===== Thoi gian =====
function parseTime(value, name) {
    if (value === undefined || value === null || value === '') return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw httpError(400, 'INVALID_TIME', `${name} không đúng định dạng thời gian ISO-8601.`);
    return d;
}

function validateRange(start, end) {
    if (!start || !end) throw httpError(400, 'INVALID_TIME', 'Cần có thời gian bắt đầu và kết thúc.');
    if (end.getTime() <= start.getTime()) throw httpError(400, 'INVALID_TIME', 'Thời gian kết thúc phải sau thời gian bắt đầu.');
    if (end.getTime() - start.getTime() > MAX_EVENT_DAYS * DAY_MS) throw httpError(400, 'INVALID_TIME', `Một lịch tối đa ${MAX_EVENT_DAYS} ngày.`);
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();

// Ngay UTC ma khoang [start, end) cham toi (end dung 00:00 khong tinh ngay do).
function dayKeys(start, end) {
    const keys = [];
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    while (d.getTime() < end.getTime()) {
        keys.push(d.toISOString().slice(0, 10));
        d.setUTCDate(d.getUTCDate() + 1);
        if (keys.length > 62) break;
    }
    return keys;
}

// ===== Khoa theo nguoi =====
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function acquireLocks(userIds) {
    const holder = crypto.randomUUID();
    const held = [];
    try {
        for (const userId of [...new Set(userIds)].sort()) {
            let ok = false;
            for (let attempt = 0; attempt < LOCK_RETRIES && !ok; attempt++) {
                const rs = await db.execute('INSERT INTO schedule_locks (user_id, holder, acquired_at) VALUES (?, ?, ?) IF NOT EXISTS USING TTL ?',
                    [userId, holder, new Date(), LOCK_TTL]);
                ok = rs.wasApplied();
                if (!ok) await sleep(40 + attempt * 20);
            }
            if (!ok) throw httpError(409, 'SCHEDULE_BUSY_RETRY', 'Lịch của một thành viên đang được cập nhật bởi thao tác khác. Vui lòng thử lại.');
            held.push(userId);
        }
    } catch (error) {
        await releaseLocks(held, holder);
        throw error;
    }
    return { holder, held };
}

async function releaseLocks(userIds, holder) {
    for (const userId of userIds) {
        await db.execute('DELETE FROM schedule_locks WHERE user_id = ? IF holder = ?', [userId, holder]).catch(() => {});
    }
}

async function withLocks(userIds, fn) {
    const lock = await acquireLocks(userIds);
    try {
        return await fn();
    } finally {
        await releaseLocks(lock.held, lock.holder);
    }
}

// ===== Doc =====
const EVENT_COLS = 'event_id, kind, title, owner_id, conversation_id, task_id, meeting_id, participant_ids, start_at, end_at, status, visibility, created_at, updated_at';

async function readEvent(eventId) {
    return (await db.execute(`SELECT ${EVENT_COLS} FROM calendar_events WHERE event_id = ?`, [eventId])).first();
}

const membersOf = row => [...(row.participant_ids || [])].map(String);

// Su kien dang chiem thoi gian cua userId trong [from, to) (doc chi muc + doi chieu nguon, tu don dong lech).
async function busyEvents(userId, from, to, cache = new Map()) {
    const out = new Map();
    for (const day of dayKeys(from, to)) {
        const rs = await db.execute('SELECT start_at, event_id, end_at FROM events_by_user_day WHERE user_id = ? AND day = ?', [userId, day]);
        for (const r of rs.rows) {
            if (!overlaps(new Date(r.start_at), new Date(r.end_at), from, to)) continue;
            const key = r.event_id.toString();
            if (out.has(key)) continue;
            let ev = cache.get(key);
            if (ev === undefined) { ev = await readEvent(r.event_id); cache.set(key, ev || null); }
            const valid = ev && ev.status === 'ACTIVE' && membersOf(ev).includes(userId)
                && new Date(ev.start_at).getTime() === new Date(r.start_at).getTime() && new Date(ev.end_at).getTime() === new Date(r.end_at).getTime();
            if (!valid) {
                await db.execute('DELETE FROM events_by_user_day WHERE user_id = ? AND day = ? AND start_at = ? AND event_id = ?',
                    [userId, day, r.start_at, r.event_id]).catch(() => {});
                continue;
            }
            out.set(key, ev);
        }
    }
    return [...out.values()];
}

// Quyen xem chi tiet su kien: nguoi tham gia / chu su kien, hoac thanh vien nhom voi su kien hien thi trong nhom.
async function canViewEvent(viewerId, ev, groupCache = new Map()) {
    if (ev.owner_id === viewerId || membersOf(ev).includes(viewerId)) return true;
    if (ev.visibility === 'GROUP' && ev.conversation_id) {
        const k = ev.conversation_id.toString();
        if (!groupCache.has(k)) {
            const conv = (await db.execute('SELECT participant_ids FROM conversations WHERE conversation_id = ?', [ev.conversation_id])).first();
            groupCache.set(k, conv ? [...(conv.participant_ids || [])].map(String) : []);
        }
        return groupCache.get(k).includes(viewerId);
    }
    return false;
}

const KIND_LABEL = { TASK_SESSION: 'Công việc', MEETING: 'Cuộc họp', PERSONAL: 'Lịch cá nhân' };

// Tim xung dot cho tung nguoi. ignore: id su kien bo qua (chinh su kien dang sua).
async function findConflicts(userIds, start, end, { ignore = [], viewerId = null } = {}) {
    const ignoreSet = new Set(ignore.map(String));
    const conflicts = [];
    const cache = new Map();
    const groupCache = new Map();
    const names = await userService.getUsersByIds(userIds);
    for (const userId of [...new Set(userIds)]) {
        for (const ev of await busyEvents(userId, start, end, cache)) {
            if (ignoreSet.has(ev.event_id.toString())) continue;
            const visible = viewerId ? await canViewEvent(viewerId, ev, groupCache) : false;
            conflicts.push({
                userId,
                displayName: names.get(userId)?.displayName || userId,
                start: iso(ev.start_at),
                end: iso(ev.end_at),
                kind: ev.kind,
                kindLabel: KIND_LABEL[ev.kind] || 'Lịch',
                // Khong lo noi dung lich rieng cua nguoi khac: chi bao "dang ban".
                eventId: visible ? ev.event_id.toString() : null,
                title: visible ? ev.title : 'Đang bận'
            });
        }
    }
    return conflicts;
}

// Goi y toi da 3 khung gio trong (cung thoi luong) cho TAT CA nguoi, trong 3 ngay tu thoi diem yeu cau.
async function suggestSlots(userIds, start, end, ignore = []) {
    const dur = end.getTime() - start.getTime();
    const horizon = new Date(start.getTime() + 3 * DAY_MS);
    const ignoreSet = new Set(ignore.map(String));
    const busy = [];
    const cache = new Map();
    for (const userId of [...new Set(userIds)]) {
        for (const ev of await busyEvents(userId, start, horizon, cache)) {
            if (!ignoreSet.has(ev.event_id.toString())) busy.push([new Date(ev.start_at).getTime(), new Date(ev.end_at).getTime()]);
        }
    }
    busy.sort((a, b) => a[0] - b[0]);
    const out = [];
    let cursor = start.getTime();
    const step = 15 * 60000;
    while (out.length < 3 && cursor + dur <= horizon.getTime()) {
        const clash = busy.find(([s, e]) => cursor < e && s < cursor + dur);
        if (!clash) {
            out.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + dur).toISOString() });
            cursor += Math.max(dur, step);
        } else {
            cursor = Math.ceil(clash[1] / step) * step;
        }
    }
    return out;
}

async function assertNoConflicts(userIds, start, end, { ignore = [], viewerId }) {
    const conflicts = await findConflicts(userIds, start, end, { ignore, viewerId });
    if (conflicts.length) {
        const suggestions = await suggestSlots(userIds, start, end, ignore).catch(() => []);
        const who = [...new Set(conflicts.map(c => c.displayName))].join(', ');
        throw httpError(409, 'SCHEDULE_CONFLICT', `Trùng lịch: ${who} đã có lịch trong khoảng thời gian này.`, { conflicts, suggestions });
    }
}

// ===== Ghi chi muc =====
function indexQueries(ev, members, { remove = false } = {}) {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    const q = [];
    for (const day of dayKeys(start, end)) {
        for (const userId of members) {
            q.push(remove
                ? { query: 'DELETE FROM events_by_user_day WHERE user_id = ? AND day = ? AND start_at = ? AND event_id = ?', params: [userId, day, start, ev.event_id] }
                : { query: 'INSERT INTO events_by_user_day (user_id, day, start_at, event_id, end_at, kind) VALUES (?, ?, ?, ?, ?, ?)', params: [userId, day, start, ev.event_id, end, ev.kind] });
        }
        if (ev.conversation_id) {
            q.push(remove
                ? { query: 'DELETE FROM events_by_group_day WHERE conversation_id = ? AND day = ? AND start_at = ? AND event_id = ?', params: [ev.conversation_id, day, start, ev.event_id] }
                : { query: 'INSERT INTO events_by_group_day (conversation_id, day, start_at, event_id, end_at, kind) VALUES (?, ?, ?, ?, ?, ?)', params: [ev.conversation_id, day, start, ev.event_id, end, ev.kind] });
        }
    }
    return q;
}

async function runAll(queries) {
    for (let i = 0; i < queries.length; i += 30) await db.batch(queries.slice(i, i + 30), { logged: false });
}

function notifyChanged(ev, members) {
    realtime.publish(members, 'calendar:changed', { eventId: ev.event_id.toString(), kind: ev.kind });
}

// ===== Tao / sua / huy =====
// input: { kind, title, ownerId, conversationId, taskId, meetingId, participants[], start, end, visibility, eventId? }
async function createEvent(input, { viewerId, check = true } = {}) {
    if (!KINDS.includes(input.kind)) throw httpError(400, 'INVALID_KIND', 'Loại lịch không hợp lệ.');
    validateRange(input.start, input.end);
    const participants = [...new Set(input.participants)].filter(Boolean);
    if (participants.length === 0) throw httpError(400, 'INVALID_PARTICIPANTS', 'Lịch cần ít nhất một người tham gia.');
    const eventId = input.eventId || TimeUuid.now();
    return withLocks(participants, async () => {
        if (check) await assertNoConflicts(participants, input.start, input.end, { viewerId });
        const now = new Date();
        const ev = {
            event_id: eventId, kind: input.kind, title: String(input.title || '').slice(0, 200), owner_id: input.ownerId,
            conversation_id: input.conversationId || null, task_id: input.taskId || null, meeting_id: input.meetingId || null,
            participant_ids: participants, start_at: input.start, end_at: input.end, status: 'ACTIVE',
            visibility: input.visibility === 'GROUP' && input.conversationId ? 'GROUP' : 'PRIVATE', created_at: now, updated_at: now
        };
        // Bang nguon truoc, chi muc sau (chi muc thieu se duoc "calendar:reindex" bo sung; doc luon doi chieu nguon).
        await db.execute(`INSERT INTO calendar_events (${EVENT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ev.event_id, ev.kind, ev.title, ev.owner_id, ev.conversation_id, ev.task_id, ev.meeting_id, participants, ev.start_at, ev.end_at,
                ev.status, ev.visibility, now, now]);
        await runAll(indexQueries(ev, participants));
        notifyChanged(ev, participants);
        return ev;
    });
}

async function requireEvent(eventId) {
    const ev = await readEvent(eventId);
    if (!ev) throw httpError(404, 'EVENT_NOT_FOUND', 'Không tìm thấy lịch.');
    return ev;
}

// Doi gio va / hoac nguoi tham gia. Kiem tra trung cho TAT CA nguoi tham gia moi (bo qua chinh su kien).
async function updateEvent(eventId, { start, end, participants, title } = {}, { viewerId, check = true } = {}) {
    const old = await requireEvent(eventId);
    if (old.status !== 'ACTIVE') throw httpError(409, 'EVENT_CANCELLED', 'Lịch đã bị hủy.');
    const newStart = start || new Date(old.start_at);
    const newEnd = end || new Date(old.end_at);
    validateRange(newStart, newEnd);
    const oldMembers = membersOf(old);
    const newMembers = participants ? [...new Set(participants)].filter(Boolean) : oldMembers;
    if (newMembers.length === 0) throw httpError(400, 'INVALID_PARTICIPANTS', 'Lịch cần ít nhất một người tham gia.');
    const timeChanged = newStart.getTime() !== new Date(old.start_at).getTime() || newEnd.getTime() !== new Date(old.end_at).getTime();
    const toCheck = timeChanged ? newMembers : newMembers.filter(u => !oldMembers.includes(u));
    return withLocks([...oldMembers, ...newMembers], async () => {
        if (check && toCheck.length) await assertNoConflicts(toCheck, newStart, newEnd, { ignore: [old.event_id], viewerId });
        const now = new Date();
        await db.execute('UPDATE calendar_events SET start_at = ?, end_at = ?, participant_ids = ?, title = ?, updated_at = ? WHERE event_id = ?',
            [newStart, newEnd, newMembers, title !== undefined ? String(title).slice(0, 200) : old.title, now, old.event_id]);
        await runAll(indexQueries(old, oldMembers, { remove: true }));
        const ev = { ...old, start_at: newStart, end_at: newEnd, participant_ids: newMembers, updated_at: now };
        await runAll(indexQueries(ev, newMembers));
        notifyChanged(ev, [...new Set([...oldMembers, ...newMembers])]);
        return ev;
    });
}

async function cancelEvent(eventId) {
    const ev = await readEvent(eventId);
    if (!ev || ev.status === 'CANCELLED') return ev;
    await db.execute('UPDATE calendar_events SET status = ?, updated_at = ? WHERE event_id = ?', ['CANCELLED', new Date(), ev.event_id]);
    await runAll(indexQueries(ev, membersOf(ev), { remove: true }));
    notifyChanged(ev, membersOf(ev));
    return { ...ev, status: 'CANCELLED' };
}

// ===== Doc lich =====
function eventDto(ev, viewerId, visible) {
    return {
        eventId: ev.event_id.toString(),
        kind: ev.kind,
        title: visible ? ev.title : 'Đang bận',
        visible,
        start: iso(ev.start_at),
        end: iso(ev.end_at),
        ownerId: ev.owner_id,
        conversationId: ev.conversation_id ? ev.conversation_id.toString() : null,
        taskId: visible && ev.task_id ? ev.task_id.toString() : null,
        meetingId: visible && ev.meeting_id ? ev.meeting_id.toString() : null,
        participantIds: visible ? membersOf(ev) : [],
        mine: membersOf(ev).includes(viewerId)
    };
}

function parseRange(query) {
    const from = parseTime(query.from, 'from') || new Date(Date.now() - 7 * DAY_MS);
    const to = parseTime(query.to, 'to') || new Date(from.getTime() + 7 * DAY_MS);
    if (to <= from) throw httpError(400, 'INVALID_TIME', 'Khoảng thời gian không hợp lệ.');
    if (to - from > 42 * DAY_MS) throw httpError(400, 'INVALID_TIME', 'Mỗi lần xem tối đa 42 ngày.');
    return { from, to };
}

async function userCalendar(viewer, query = {}) {
    const { from, to } = parseRange(query);
    const events = await busyEvents(viewer.userId, from, to);
    return { from: from.toISOString(), to: to.toISOString(), items: events.map(ev => eventDto(ev, viewer.userId, true)).sort((a, b) => a.start.localeCompare(b.start)) };
}

async function requireGroupMember(conversationId, userId) {
    let cid;
    try { cid = Uuid.fromString(String(conversationId).toLowerCase()); } catch { throw httpError(400, 'INVALID_ID', 'Mã nhóm không hợp lệ.'); }
    const conv = (await db.execute('SELECT conversation_id, conversation_type, conversation_name, participant_ids FROM conversations WHERE conversation_id = ?', [cid])).first();
    if (!conv || conv.conversation_type !== 'GROUP') throw httpError(404, 'GROUP_NOT_FOUND', 'Không tìm thấy nhóm.');
    const members = [...(conv.participant_ids || [])].map(String);
    if (!members.includes(userId)) throw httpError(403, 'NOT_A_MEMBER', 'Bạn không phải thành viên của nhóm này.');
    return { cid, conv, members };
}

// Lich nhom: su kien cua nhom + (tuy chon) lich ban cua tung thanh vien trong pham vi quyen rieng tu.
async function groupCalendar(viewer, conversationId, query = {}) {
    const { cid, conv, members } = await requireGroupMember(conversationId, viewer.userId);
    const { from, to } = parseRange(query);
    const seen = new Map();
    for (const day of dayKeys(from, to)) {
        const rs = await db.execute('SELECT start_at, event_id, end_at FROM events_by_group_day WHERE conversation_id = ? AND day = ?', [cid, day]);
        for (const r of rs.rows) {
            if (seen.has(r.event_id.toString()) || !overlaps(new Date(r.start_at), new Date(r.end_at), from, to)) continue;
            const ev = await readEvent(r.event_id);
            if (!ev || ev.status !== 'ACTIVE') continue;
            seen.set(ev.event_id.toString(), eventDto(ev, viewer.userId, true));
        }
    }
    const items = [...seen.values()].sort((a, b) => a.start.localeCompare(b.start));
    let busy = [];
    if (query.members !== '0') {
        const groupCache = new Map([[cid.toString(), members]]);
        const cache = new Map();
        for (const m of members) {
            for (const ev of await busyEvents(m, from, to, cache)) {
                if (seen.has(ev.event_id.toString())) continue;
                const visible = await canViewEvent(viewer.userId, ev, groupCache);
                busy.push({ userId: m, ...eventDto(ev, viewer.userId, visible) });
            }
        }
    }
    // Xung dot noi bo: 1 thanh vien co >= 2 lich trung nhau trong khoang dang xem.
    const perUser = new Map();
    for (const e of [...items.flatMap(e => e.participantIds.map(u => ({ u, e }))), ...busy.map(b => ({ u: b.userId, e: b }))]) {
        if (!perUser.has(e.u)) perUser.set(e.u, []);
        perUser.get(e.u).push(e.e);
    }
    const conflicts = [];
    for (const [u, list] of perUser) {
        const uniq = [...new Map(list.map(x => [x.eventId, x])).values()].sort((a, b) => a.start.localeCompare(b.start));
        for (let i = 0; i < uniq.length; i++) {
            for (let j = i + 1; j < uniq.length; j++) {
                if (overlaps(new Date(uniq[i].start), new Date(uniq[i].end), new Date(uniq[j].start), new Date(uniq[j].end))) {
                    conflicts.push({ userId: u, eventIds: [uniq[i].eventId, uniq[j].eventId] });
                }
            }
        }
    }
    const profiles = await userService.getUsersByIds(members);
    return {
        conversationId: cid.toString(), name: conv.conversation_name, from: from.toISOString(), to: to.toISOString(), items, busy, conflicts,
        members: members.map(id => ({ userId: id, displayName: profiles.get(id)?.displayName || id }))
    };
}

// Lich ban cua nhieu nguoi (chi nhung nguoi chung nhom / ban be voi nguoi xem moi thay chi tiet; con lai "dang ban").
async function availability(viewer, query = {}) {
    const { from, to } = parseRange(query);
    const ids = String(query.userIds || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
    if (ids.length === 0) throw httpError(400, 'INVALID_PARTICIPANTS', 'Cần userIds.');
    const cache = new Map();
    const out = [];
    for (const userId of ids) {
        const events = await busyEvents(userId, from, to, cache);
        out.push({ userId, busy: await Promise.all(events.map(async ev => ({ start: iso(ev.start_at), end: iso(ev.end_at),
            ...(await canViewEvent(viewer.userId, ev) ? { title: ev.title, kind: ev.kind } : { title: 'Đang bận' }) }))) });
    }
    return { from: from.toISOString(), to: to.toISOString(), items: out };
}

async function checkConflicts(viewer, body = {}) {
    const start = parseTime(body.start, 'start');
    const end = parseTime(body.end, 'end');
    validateRange(start, end);
    const ids = Array.isArray(body.userIds) && body.userIds.length ? body.userIds.map(String).slice(0, 50) : [viewer.userId];
    const ignore = body.ignoreEventId ? [body.ignoreEventId] : [];
    const conflicts = await findConflicts(ids, start, end, { ignore, viewerId: viewer.userId });
    return { ok: conflicts.length === 0, conflicts, suggestions: conflicts.length ? await suggestSlots(ids, start, end, ignore) : [] };
}

// ===== Lich ca nhan (hoc, lam viec, hoat dong khac) =====
async function createPersonalEvent(user, body = {}) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 200) throw httpError(400, 'INVALID_TITLE', 'Tiêu đề từ 1 đến 200 ký tự.');
    const start = parseTime(body.start, 'start');
    const end = parseTime(body.end, 'end');
    const ev = await createEvent({ kind: 'PERSONAL', title, ownerId: user.userId, participants: [user.userId], start, end }, { viewerId: user.userId });
    return eventDto(ev, user.userId, true);
}

async function requireOwnedPersonal(user, eventId) {
    let id;
    try { id = TimeUuid.fromString(String(eventId)); } catch { throw httpError(400, 'INVALID_ID', 'Mã lịch không hợp lệ.'); }
    const ev = await readEvent(id);
    if (!ev || !(ev.owner_id === user.userId || membersOf(ev).includes(user.userId))) throw httpError(404, 'EVENT_NOT_FOUND', 'Không tìm thấy lịch.');
    return ev;
}

// Sua lich tu trang lich (keo tha): lich ca nhan do chinh minh; phien cong viec / cuoc hop chuyen cho service tuong ung.
async function moveEvent(user, eventId, body = {}) {
    const ev = await requireOwnedPersonal(user, eventId);
    const start = parseTime(body.start, 'start');
    const end = parseTime(body.end, 'end');
    if (ev.kind === 'TASK_SESSION') return require('./task.service').moveSession(user, ev, { start, end });
    if (ev.kind === 'MEETING') return require('./meeting.service').reschedule(user, ev.meeting_id.toString(), { start: body.start, end: body.end, asEvent: true });
    if (ev.owner_id !== user.userId) throw httpError(403, 'FORBIDDEN', 'Bạn không có quyền sửa lịch này.');
    const updated = await updateEvent(ev.event_id, { start, end, title: body.title }, { viewerId: user.userId });
    await require('./reminder.service').rescheduleTarget('EVENT', ev.event_id.toString()).catch(() => {});
    return eventDto(updated, user.userId, true);
}

async function cancelPersonalEvent(user, eventId) {
    const ev = await requireOwnedPersonal(user, eventId);
    if (ev.kind !== 'PERSONAL' || ev.owner_id !== user.userId) throw httpError(403, 'FORBIDDEN', 'Chỉ hủy được lịch cá nhân của chính mình tại đây.');
    await cancelEvent(ev.event_id);
    await require('./reminder.service').cancelTarget('EVENT', ev.event_id.toString()).catch(() => {});
    return { eventId: ev.event_id.toString(), status: 'CANCELLED' };
}

module.exports = {
    parseTime, validateRange, overlaps, dayKeys, acquireLocks, releaseLocks, withLocks, readEvent, busyEvents, findConflicts,
    suggestSlots, assertNoConflicts, createEvent, updateEvent, cancelEvent, eventDto, userCalendar, groupCalendar, availability,
    checkConflicts, createPersonalEvent, moveEvent, cancelPersonalEvent, requireGroupMember, canViewEvent, membersOf, KIND_LABEL
};
