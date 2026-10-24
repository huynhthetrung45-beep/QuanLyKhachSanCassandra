// Hop truc tuyen (mo rong SRS): lich hop, loi moi, link moi, phong hop WebRTC.
//
// Kien truc media: WebRTC MESH (moi nguoi ket noi P2P voi tung nguoi khac), phu hop nhom nho (mac dinh toi da 8 nguoi).
//  - Backend KHONG truyen am thanh / hinh anh. Backend lam: xac thuc, cap ma tham gia (HMAC, ngan han), cap ICE server
//    (STUN + TURN co thoi han neu cau hinh), chuyen tiep tin hieu (offer / answer / ICE) qua SSE co san, danh sach nguoi
//    dang trong phong, trang thai mic / camera / chia se man hinh, chat trong phong, ket thuc phong.
//  - Ma tham gia gui trong body / header X-Meeting-Token, KHONG nam tren URL, KHONG ghi log.
//  - Gioi han da biet: danh sach nguoi dang trong phong nam trong bo nho tien trinh (1 instance backend); chay nhieu instance
//    can dua roster sang Redis. Mang NAT nghiem ngat can TURN (TURN_URLS + TURN_SECRET), khong co TURN co the khong noi duoc.
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso } = require('../utils/types');
const userService = require('../services/user.service');
const realtime = require('../services/realtime.service');
const cal = require('./calendar.service');
const reminders = require('./reminder.service');
const idem = require('./lib/idempotency');

const notifications = () => require('../services/notification.service');

const COLS = `meeting_id, title, description, organizer_id, conversation_id, start_at, end_at, status, join_policy, event_id, invite_code,
              invite_revoked, actual_start, actual_end, created_at, updated_at`;
const STATUS_LABEL = { SCHEDULED: 'Đã lên lịch', LIVE: 'Đang diễn ra', ENDED: 'Đã kết thúc', CANCELLED: 'Đã hủy' };
const MAX_PARTICIPANTS = () => Math.max(2, Number(process.env.MEETING_MAX_PARTICIPANTS || 8));
const EARLY_JOIN_MS = 15 * 60000;
const TOKEN_TTL_MS = 4 * 3600000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const SIGNAL_TYPES = ['offer', 'answer', 'ice', 'renegotiate'];
// Secret ky ma tham gia: tu bien moi truong; khong co -> sinh ngau nhien moi lan khoi dong (khong hardcode).
const TOKEN_SECRET = process.env.MEETING_TOKEN_SECRET || crypto.randomBytes(32).toString('hex');

const clean = (v, max) => String(v || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

function parseId(value) {
    try { return TimeUuid.fromString(String(value)); } catch { throw httpError(400, 'INVALID_ID', 'Mã cuộc họp không hợp lệ.'); }
}

async function readMeeting(id) {
    return (await db.execute(`SELECT ${COLS} FROM meetings WHERE meeting_id = ?`, [id])).first();
}

async function invitations(meetingId) {
    return (await db.execute('SELECT user_id, status, invited_by, invited_at, responded_at FROM meeting_invitations WHERE meeting_id = ?', [meetingId])).rows;
}

async function groupMembers(cid) {
    if (!cid) return [];
    const conv = (await db.execute('SELECT participant_ids FROM conversations WHERE conversation_id = ?', [cid])).first();
    return conv ? [...(conv.participant_ids || [])].map(String) : [];
}

// Quyen: nguoi to chuc; nguoi duoc moi; cuoc hop nhom voi join_policy GROUP: moi thanh vien hien tai cua nhom.
async function accessOf(user, m, invites = null) {
    const list = invites || await invitations(m.meeting_id);
    const inv = list.find(i => i.user_id === user.userId);
    const isOrganizer = m.organizer_id === user.userId;
    const members = m.conversation_id ? await groupMembers(m.conversation_id) : [];
    const isMember = members.includes(user.userId);
    // Cuoc hop nhom: roi nhom -> mat quyen (tru nguoi to chuc).
    const inGroupScope = !m.conversation_id || isMember || isOrganizer;
    const view = inGroupScope && (isOrganizer || Boolean(inv) || (m.join_policy === 'GROUP' && isMember));
    return { view, join: view, organizer: isOrganizer, invitation: inv || null, members };
}

async function requireMeeting(user, meetingId) {
    const m = await readMeeting(parseId(meetingId));
    if (!m) throw httpError(404, 'MEETING_NOT_FOUND', 'Không tìm thấy cuộc họp.');
    const invites = await invitations(m.meeting_id);
    const acl = await accessOf(user, m, invites);
    if (!acl.view) throw httpError(404, 'MEETING_NOT_FOUND', 'Không tìm thấy cuộc họp.');
    return { m, acl, invites };
}

async function requireMeetingAccess(user, meetingId) {
    return (await requireMeeting(user, meetingId)).m;
}

function requireOrganizer(acl) {
    if (!acl.organizer) throw httpError(403, 'FORBIDDEN_MEETING', 'Chỉ người tổ chức mới được thực hiện thao tác này.');
}

// ===== Roster (nguoi dang o trong phong) =====
const rooms = new Map(); // meetingId -> Map(sessionId -> { userId, displayName, joinedAt, lastSeen, audio, video, screen })
const roomOf = id => {
    const key = String(id);
    if (!rooms.has(key)) rooms.set(key, new Map());
    return rooms.get(key);
};
const rosterDto = room => [...room.entries()].map(([sessionId, p]) => ({
    sessionId, userId: p.userId, displayName: p.displayName, joinedAt: iso(p.joinedAt), audio: p.audio, video: p.video, screen: p.screen
}));
const roomUsers = room => [...new Set([...room.values()].map(p => p.userId))];

function broadcast(meetingId, event, data, { except = null } = {}) {
    const room = rooms.get(String(meetingId));
    if (!room) return;
    const users = [...new Set([...room.entries()].filter(([sid]) => sid !== except).map(([, p]) => p.userId))];
    realtime.publish(users, event, { meetingId: String(meetingId), ...data });
}

async function markLeft(meetingId, sessionId) {
    await db.execute('UPDATE meeting_participation SET left_at = ? WHERE meeting_id = ? AND session_id = ?', [new Date(), meetingId, TimeUuid.fromString(sessionId)])
        .catch(() => {});
}

async function removeFromRoom(meetingId, sessionId, reason = 'left') {
    const room = rooms.get(String(meetingId));
    if (!room || !room.has(sessionId)) return false;
    const p = room.get(sessionId);
    room.delete(sessionId);
    await markLeft(parseId(meetingId), sessionId);
    broadcast(meetingId, 'meeting:left', { sessionId, userId: p.userId, reason });
    if (room.size === 0) rooms.delete(String(meetingId));
    return true;
}

// Don nguoi mat ket noi (khong heartbeat qua 45s).
let sweeper = null;
function startSweeper() {
    if (sweeper) return;
    sweeper = setInterval(() => {
        const now = Date.now();
        for (const [mid, room] of rooms) {
            for (const [sid, p] of room) if (now - p.lastSeen > HEARTBEAT_TIMEOUT_MS) removeFromRoom(mid, sid, 'timeout').catch(() => {});
        }
    }, 15000);
    sweeper.unref();
}

// ===== Ma tham gia (HMAC) =====
const b64 = buf => Buffer.from(buf).toString('base64url');
function signToken(payload) {
    const body = b64(JSON.stringify(payload));
    return `${body}.${crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url')}`;
}

function verifyToken(token, user, meetingId) {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) throw httpError(401, 'INVALID_MEETING_TOKEN', 'Mã tham gia phòng họp không hợp lệ.');
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, 'INVALID_MEETING_TOKEN', 'Mã tham gia phòng họp không hợp lệ.');
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw httpError(401, 'INVALID_MEETING_TOKEN', 'Mã tham gia phòng họp không hợp lệ.'); }
    // Ma gan voi nguoi dung cua phien dang nhap + cuoc hop: khong dung ma cua nguoi khac / phong khac duoc.
    if (p.u !== user.userId || p.m !== String(meetingId)) throw httpError(403, 'INVALID_MEETING_TOKEN', 'Mã tham gia không thuộc về bạn hoặc phòng này.');
    if (Date.now() > p.e) throw httpError(401, 'MEETING_TOKEN_EXPIRED', 'Mã tham gia đã hết hạn, hãy vào lại phòng.');
    return p;
}

function tokenFrom(req, body = {}) {
    return req.headers['x-meeting-token'] || body.token;
}

// ICE: STUN mac dinh; TURN chi khi cau hinh, credential ngan han kieu coturn REST (use-auth-secret).
function iceServers(userId) {
    const stun = String(process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean);
    const servers = stun.length ? [{ urls: stun }] : [];
    const turn = String(process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (turn.length && process.env.TURN_SECRET) {
        const ttl = Math.max(600, Number(process.env.TURN_TTL_SECONDS || 3600));
        const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
        const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
        servers.push({ urls: turn, username, credential });
    }
    return servers;
}

// ===== DTO =====
async function dto(m, user, acl = null, invites = null) {
    const list = invites || await invitations(m.meeting_id);
    const a = acl || await accessOf(user, m, list);
    const profiles = await userService.getUsersByIds([m.organizer_id, ...list.map(i => i.user_id)]);
    const name = id => profiles.get(id)?.displayName || id;
    const room = rooms.get(m.meeting_id.toString());
    const out = {
        meetingId: m.meeting_id.toString(), title: m.title, description: m.description || '', status: m.status, statusLabel: STATUS_LABEL[m.status],
        organizer: { userId: m.organizer_id, displayName: name(m.organizer_id) },
        conversationId: m.conversation_id ? m.conversation_id.toString() : null, joinPolicy: m.join_policy,
        start: iso(m.start_at), end: iso(m.end_at), actualStart: iso(m.actual_start), actualEnd: iso(m.actual_end), eventId: m.event_id ? m.event_id.toString() : null,
        invitations: list.map(i => ({ userId: i.user_id, displayName: name(i.user_id), status: i.status, respondedAt: iso(i.responded_at) })),
        myInvitation: a.invitation ? a.invitation.status : null, isOrganizer: a.organizer,
        liveCount: room ? room.size : 0, canJoin: canJoinNow(m)
    };
    if (a.organizer && m.invite_code && !m.invite_revoked) out.inviteCode = m.invite_code;
    return out;
}

function canJoinNow(m) {
    if (['ENDED', 'CANCELLED'].includes(m.status)) return false;
    if (m.status === 'LIVE') return true;
    const now = Date.now();
    return now >= new Date(m.start_at).getTime() - EARLY_JOIN_MS && now <= new Date(m.end_at).getTime();
}

async function notifyMany(userIds, actor, type, m, preview, keySuffix) {
    for (const recipientId of [...new Set(userIds)].filter(u => u && u !== actor.userId)) {
        await notifications().notifySafe({
            recipientId, actorId: actor.userId, type, preview: `“${m.title}”${preview ? ' – ' + preview : ''}`,
            dedupeKey: `${type}:${m.meeting_id}:${recipientId}:${keySuffix || Date.now()}`, ref: { type: 'MEETING', id: m.meeting_id.toString() }
        });
    }
}

const fmt = d => require('./lib/timefmt').formatWhen(d);

async function writeInvites(meetingId, inviterId, userIds, status = 'PENDING') {
    const now = new Date();
    const q = [];
    for (const u of userIds) {
        q.push({ query: 'INSERT INTO meeting_invitations (meeting_id, user_id, status, invited_by, invited_at) VALUES (?, ?, ?, ?, ?)', params: [meetingId, u, status, inviterId, now] });
        q.push({ query: 'INSERT INTO meetings_by_user (user_id, meeting_id, role) VALUES (?, ?, ?)', params: [u, meetingId, 'INVITEE'] });
    }
    for (let i = 0; i < q.length; i += 30) await db.batch(q.slice(i, i + 30), { logged: false });
}

// ===== Tao =====
// body: { title, description, conversationId?, inviteeIds[], start?, end?, durationMinutes?, instant?, joinPolicy?, reminders[] }
async function createMeeting(user, body = {}, { idemKey = null } = {}) {
    const title = clean(body.title, 200) || (body.instant ? 'Cuộc họp nhanh' : '');
    if (!title) throw httpError(400, 'INVALID_TITLE', 'Tiêu đề cuộc họp từ 1 đến 200 ký tự.');
    const description = clean(body.description, 2000);
    let cid = null;
    let members = [];
    if (body.conversationId) ({ cid, members } = await cal.requireGroupMember(body.conversationId, user.userId));
    let invitees = [...new Set((Array.isArray(body.inviteeIds) ? body.inviteeIds : []).map(String))].filter(u => u !== user.userId);
    if (cid) {
        const outsiders = invitees.filter(u => !members.includes(u));
        if (outsiders.length) throw httpError(400, 'INVITEE_NOT_IN_GROUP', 'Chỉ mời được thành viên hiện tại của nhóm.', { userIds: outsiders });
        if (body.inviteAll) invitees = members.filter(u => u !== user.userId);
    } else if (invitees.length) {
        const found = await userService.getUsersByIds(invitees);
        const missing = invitees.filter(u => !found.get(u));
        if (missing.length) throw httpError(400, 'USER_NOT_FOUND', 'Có người được mời không tồn tại.', { userIds: missing });
    }
    if (invitees.length > 100) throw httpError(400, 'INVALID_INVITEES', 'Tối đa 100 người được mời.');
    const joinPolicy = cid && String(body.joinPolicy || 'GROUP').toUpperCase() === 'GROUP' ? 'GROUP' : 'INVITED';
    const instant = Boolean(body.instant);
    let start = instant ? new Date() : cal.parseTime(body.start, 'start');
    let end = cal.parseTime(body.end, 'end');
    if (instant && !end) end = new Date(start.getTime() + Math.min(Math.max(Number(body.durationMinutes) || 60, 15), 480) * 60000);
    cal.validateRange(start, end);
    if (!instant && end.getTime() < Date.now()) throw httpError(400, 'INVALID_TIME', 'Không thể lên lịch họp đã kết thúc trong quá khứ.');

    const meetingId = TimeUuid.now();
    const claim = await idem.claim(user.userId, idemKey, 'MEETING', meetingId);
    if (!claim.claimed) {
        const existing = await readMeeting(TimeUuid.fromString(claim.resourceId));
        if (!existing) throw httpError(409, 'REQUEST_IN_PROGRESS', 'Yêu cầu trước với cùng Idempotency-Key đang được xử lý.');
        return { ...(await dto(existing, user)), replayed: true };
    }
    let event;
    try {
        // Lich hop chiem thoi gian cua nguoi to chuc + nguoi duoc moi -> kiem tra trung (hop nhanh: chi canh bao).
        event = await cal.createEvent({ kind: 'MEETING', title, ownerId: user.userId, conversationId: cid, meetingId, participants: [user.userId, ...invitees],
            start, end, visibility: cid ? 'GROUP' : 'PRIVATE' }, { viewerId: user.userId, check: !instant });
        const now = new Date();
        await db.execute(`INSERT INTO meetings (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [meetingId, title, description || null, user.userId, cid, start, end, 'SCHEDULED', joinPolicy, event.event_id, null, false, null, null, now, now]);
    } catch (error) {
        if (event) await cal.cancelEvent(event.event_id).catch(() => {});
        await idem.release(user.userId, idemKey);
        throw error;
    }
    const q = [{ query: 'INSERT INTO meetings_by_user (user_id, meeting_id, role) VALUES (?, ?, ?)', params: [user.userId, meetingId, 'ORGANIZER'] }];
    if (cid) q.push({ query: 'INSERT INTO meetings_by_group (conversation_id, meeting_id) VALUES (?, ?)', params: [cid, meetingId] });
    await db.batch(q, { logged: false });
    await writeInvites(meetingId, user.userId, invitees);
    const m = await readMeeting(meetingId);
    const plan = Array.isArray(body.reminders) ? body.reminders.slice(0, 5) : (instant ? [] : [{ anchor: 'START', offsetMinutes: 15 }]);
    for (const u of [user.userId, ...invitees]) {
        for (const r of plan) {
            await reminders.createReminder({ userId: u }, { targetType: 'MEETING', targetId: meetingId.toString(), anchor: 'START', offsetMinutes: r.offsetMinutes })
                .catch(() => {});
        }
    }
    await notifyMany(invitees, user, 'MEETING_INVITE', m, instant ? 'đang bắt đầu, vào ngay' : fmt(start), 'create');
    realtime.publish([user.userId, ...invitees], 'meeting:changed', { meetingId: meetingId.toString() });
    const warnings = instant ? await cal.findConflicts(invitees, start, end, { ignore: [event.event_id], viewerId: user.userId }) : [];
    return { ...(await dto(m, user)), warnings };
}

// ===== Doc =====
async function getMeeting(user, meetingId) {
    const { m, acl, invites } = await requireMeeting(user, meetingId);
    return dto(m, user, acl, invites);
}

async function listMine(user, query = {}) {
    const rows = (await db.execute('SELECT meeting_id, role FROM meetings_by_user WHERE user_id = ? LIMIT 300', [user.userId])).rows;
    const seen = new Set();
    const items = [];
    for (const r of rows) {
        if (seen.has(r.meeting_id.toString())) continue;
        seen.add(r.meeting_id.toString());
        const m = await readMeeting(r.meeting_id);
        if (!m) continue;
        const acl = await accessOf(user, m);
        if (!acl.view) continue;
        items.push(await dto(m, user, acl));
    }
    // Them cuoc hop nhom (join_policy GROUP) cua cac nhom minh tham gia.
    const groups = (await db.execute('SELECT conversation_id, conversation_type FROM conversations_by_user WHERE user_id = ?', [user.userId])).rows
        .filter(r => r.conversation_type === 'GROUP');
    for (const g of groups) {
        for (const r of (await db.execute('SELECT meeting_id FROM meetings_by_group WHERE conversation_id = ? LIMIT 30', [g.conversation_id])).rows) {
            if (seen.has(r.meeting_id.toString())) continue;
            seen.add(r.meeting_id.toString());
            const m = await readMeeting(r.meeting_id);
            if (!m) continue;
            const acl = await accessOf(user, m);
            if (acl.view) items.push(await dto(m, user, acl));
        }
    }
    const now = Date.now();
    let list = items;
    if (query.scope === 'upcoming') list = items.filter(m => ['SCHEDULED', 'LIVE'].includes(m.status) && new Date(m.end).getTime() >= now);
    if (query.scope === 'past') list = items.filter(m => ['ENDED', 'CANCELLED'].includes(m.status) || new Date(m.end).getTime() < now);
    if (query.scope === 'invitations') list = items.filter(m => m.myInvitation === 'PENDING' && m.status !== 'CANCELLED');
    list.sort((a, b) => (query.scope === 'past' ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start)));
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    return { items: list.slice(0, limit), total: list.length };
}

const upcoming = (user, { limit = 5 } = {}) => listMine(user, { scope: 'upcoming', limit });

async function listGroup(user, conversationId) {
    const { cid } = await cal.requireGroupMember(conversationId, user.userId);
    const items = [];
    for (const r of (await db.execute('SELECT meeting_id FROM meetings_by_group WHERE conversation_id = ? LIMIT 100', [cid])).rows) {
        const m = await readMeeting(r.meeting_id);
        if (!m) continue;
        const acl = await accessOf(user, m);
        if (acl.view) items.push(await dto(m, user, acl));
    }
    return { conversationId: cid.toString(), items: items.sort((a, b) => b.start.localeCompare(a.start)) };
}

// ===== Moi / phan hoi =====
async function invite(user, meetingId, body = {}) {
    const { m, acl, invites } = await requireMeeting(user, meetingId);
    requireOrganizer(acl);
    if (['ENDED', 'CANCELLED'].includes(m.status)) throw httpError(409, 'MEETING_CLOSED', 'Cuộc họp đã kết thúc hoặc đã hủy.');
    const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String))].filter(u => u !== m.organizer_id && !invites.some(i => i.user_id === u));
    if (!ids.length) return dto(m, user, acl, invites);
    if (m.conversation_id) {
        const outsiders = ids.filter(u => !acl.members.includes(u));
        if (outsiders.length) throw httpError(400, 'INVITEE_NOT_IN_GROUP', 'Chỉ mời được thành viên hiện tại của nhóm.', { userIds: outsiders });
    } else {
        const found = await userService.getUsersByIds(ids);
        const missing = ids.filter(u => !found.get(u));
        if (missing.length) throw httpError(400, 'USER_NOT_FOUND', 'Có người được mời không tồn tại.', { userIds: missing });
    }
    if (invites.length + ids.length > 100) throw httpError(400, 'INVALID_INVITEES', 'Tối đa 100 người được mời.');
    // Kiem tra trung lich cua nguoi moi (chi thong bao, khong chan: nguoi duoc moi tu quyet dinh nhan / tu choi).
    const warnings = await cal.findConflicts(ids, new Date(m.start_at), new Date(m.end_at), { ignore: [m.event_id], viewerId: user.userId });
    if (m.event_id) {
        const ev = await cal.readEvent(m.event_id);
        if (ev && ev.status === 'ACTIVE') await cal.updateEvent(m.event_id, { participants: [...cal.membersOf(ev), ...ids] }, { viewerId: user.userId, check: false });
    }
    await writeInvites(m.meeting_id, user.userId, ids);
    await notifyMany(ids, user, 'MEETING_INVITE', m, m.status === 'LIVE' ? 'đang diễn ra' : fmt(m.start_at), 'invite');
    realtime.publish([user.userId, ...ids], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    return { ...(await getMeeting(user, meetingId)), warnings };
}

async function respond(user, meetingId, body = {}) {
    const { m, acl } = await requireMeeting(user, meetingId);
    const status = String(body.status || '').toUpperCase();
    if (!['ACCEPTED', 'DECLINED'].includes(status)) throw httpError(400, 'INVALID_STATUS', 'Trạng thái phải là ACCEPTED hoặc DECLINED.');
    if (!acl.invitation) throw httpError(400, 'NOT_INVITED', 'Bạn không có lời mời cho cuộc họp này.');
    await db.execute('UPDATE meeting_invitations SET status = ?, responded_at = ? WHERE meeting_id = ? AND user_id = ?', [status, new Date(), m.meeting_id, user.userId]);
    // Tu choi -> cuoc hop khong con chiem lich cua nguoi do; nhan lai -> them lai (khong chan neu trung).
    if (m.event_id && !['ENDED', 'CANCELLED'].includes(m.status)) {
        const ev = await cal.readEvent(m.event_id);
        if (ev && ev.status === 'ACTIVE') {
            const now = cal.membersOf(ev);
            const next = status === 'DECLINED' ? now.filter(u => u !== user.userId) : [...new Set([...now, user.userId])];
            if (next.length && next.length !== now.length) await cal.updateEvent(m.event_id, { participants: next }, { viewerId: user.userId, check: false });
        }
        if (status === 'DECLINED') await reminders.cancelTarget('MEETING', m.meeting_id.toString(), { userId: user.userId });
    }
    realtime.publish([m.organizer_id, user.userId], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    return getMeeting(user, meetingId);
}

// ===== Link moi =====
async function createLink(user, meetingId) {
    const { m, acl } = await requireMeeting(user, meetingId);
    requireOrganizer(acl);
    if (['ENDED', 'CANCELLED'].includes(m.status)) throw httpError(409, 'MEETING_CLOSED', 'Cuộc họp đã kết thúc hoặc đã hủy.');
    if (m.invite_code && !m.invite_revoked) return { inviteCode: m.invite_code };
    const code = crypto.randomBytes(18).toString('base64url');
    const expires = new Date(new Date(m.end_at).getTime() + 3600000);
    await db.execute('INSERT INTO meeting_links (invite_code, meeting_id, created_by, expires_at, revoked) VALUES (?, ?, ?, ?, false)', [code, m.meeting_id, user.userId, expires]);
    await db.execute('UPDATE meetings SET invite_code = ?, invite_revoked = false, updated_at = ? WHERE meeting_id = ?', [code, new Date(), m.meeting_id]);
    return { inviteCode: code, expiresAt: iso(expires) };
}

async function revokeLink(user, meetingId) {
    const { m, acl } = await requireMeeting(user, meetingId);
    requireOrganizer(acl);
    if (m.invite_code) {
        await db.execute('UPDATE meeting_links SET revoked = true WHERE invite_code = ?', [m.invite_code]);
        await db.execute('UPDATE meetings SET invite_revoked = true, updated_at = ? WHERE meeting_id = ?', [new Date(), m.meeting_id]);
    }
    return { revoked: true };
}

// Mo link: nguoi dang nhap duoc them vao danh sach moi (cuoc hop nhom: phai la thanh vien nhom).
async function joinByLink(user, code) {
    const c = String(code || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(c)) throw httpError(404, 'INVITE_INVALID', 'Link mời không hợp lệ.');
    const link = (await db.execute('SELECT meeting_id, expires_at, revoked FROM meeting_links WHERE invite_code = ?', [c])).first();
    if (!link || link.revoked) throw httpError(404, 'INVITE_INVALID', 'Link mời không hợp lệ hoặc đã bị thu hồi.');
    if (new Date(link.expires_at).getTime() < Date.now()) throw httpError(410, 'INVITE_EXPIRED', 'Link mời đã hết hạn.');
    const m = await readMeeting(link.meeting_id);
    if (!m || ['ENDED', 'CANCELLED'].includes(m.status)) throw httpError(410, 'MEETING_CLOSED', 'Cuộc họp đã kết thúc hoặc đã hủy.');
    if (m.conversation_id && m.organizer_id !== user.userId && !(await groupMembers(m.conversation_id)).includes(user.userId)) {
        throw httpError(403, 'NOT_A_MEMBER', 'Cuộc họp này chỉ dành cho thành viên nhóm.');
    }
    const invites = await invitations(m.meeting_id);
    if (m.organizer_id !== user.userId && !invites.some(i => i.user_id === user.userId)) {
        await writeInvites(m.meeting_id, m.organizer_id, [user.userId], 'ACCEPTED');
        realtime.publish([m.organizer_id], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    }
    return getMeeting(user, m.meeting_id.toString());
}

// ===== Doi lich / huy / ket thuc =====
async function reschedule(user, meetingId, body = {}) {
    const { m, acl } = await requireMeeting(user, meetingId);
    requireOrganizer(acl);
    if (m.status !== 'SCHEDULED') throw httpError(409, 'MEETING_NOT_SCHEDULED', 'Chỉ đổi lịch được cuộc họp chưa diễn ra.');
    const start = cal.parseTime(body.start, 'start') || new Date(m.start_at);
    const end = cal.parseTime(body.end, 'end') || new Date(m.end_at);
    cal.validateRange(start, end);
    const title = body.title !== undefined ? clean(body.title, 200) : m.title;
    if (!title) throw httpError(400, 'INVALID_TITLE', 'Tiêu đề cuộc họp từ 1 đến 200 ký tự.');
    let ev = null;
    if (m.event_id) ev = await cal.updateEvent(m.event_id, { start, end, title }, { viewerId: user.userId });
    await db.execute('UPDATE meetings SET start_at = ?, end_at = ?, title = ?, description = ?, updated_at = ? WHERE meeting_id = ?',
        [start, end, title, body.description !== undefined ? clean(body.description, 2000) || null : m.description, new Date(), m.meeting_id]);
    await reminders.rescheduleTarget('MEETING', m.meeting_id.toString());
    const fresh = await readMeeting(m.meeting_id);
    const invitees = (await invitations(m.meeting_id)).filter(i => i.status !== 'DECLINED').map(i => i.user_id);
    if (start.getTime() !== new Date(m.start_at).getTime() || end.getTime() !== new Date(m.end_at).getTime()) {
        await notifyMany(invitees, user, 'MEETING_UPDATED', fresh, 'giờ mới ' + fmt(start));
    }
    realtime.publish([user.userId, ...invitees], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    // Goi tu trang lich (keo tha) -> tra ve dang su kien lich.
    if (body.asEvent && ev) return cal.eventDto(ev, user.userId, true);
    return dto(fresh, user);
}

async function cancelMeeting(user, meetingId) {
    const { m, acl, invites } = await requireMeeting(user, meetingId);
    requireOrganizer(acl);
    if (m.status === 'ENDED') throw httpError(409, 'MEETING_CLOSED', 'Cuộc họp đã kết thúc.');
    if (m.status === 'CANCELLED') return dto(m, user, acl, invites);
    const rs = await db.execute('UPDATE meetings SET status = ?, updated_at = ? WHERE meeting_id = ? IF status = ?', ['CANCELLED', new Date(), m.meeting_id, m.status]);
    if (!rs.wasApplied()) throw httpError(409, 'MEETING_CHANGED', 'Cuộc họp vừa thay đổi trạng thái, hãy tải lại.');
    if (m.event_id) await cal.cancelEvent(m.event_id);
    await reminders.cancelTarget('MEETING', m.meeting_id.toString());
    broadcast(m.meeting_id, 'meeting:ended', { reason: 'cancelled' });
    rooms.delete(m.meeting_id.toString());
    const fresh = await readMeeting(m.meeting_id);
    await notifyMany(invites.map(i => i.user_id), user, 'MEETING_CANCELLED', fresh, '');
    realtime.publish([user.userId, ...invites.map(i => i.user_id)], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    return dto(fresh, user);
}

async function endMeeting(user, meetingId) {
    const { m, acl } = await requireMeeting(user, meetingId);
    requireOrganizer(acl);
    if (m.status === 'ENDED') return dto(m, user, acl);
    if (m.status === 'CANCELLED') throw httpError(409, 'MEETING_CLOSED', 'Cuộc họp đã hủy.');
    const rs = await db.execute('UPDATE meetings SET status = ?, actual_end = ?, updated_at = ? WHERE meeting_id = ? IF status = ?',
        ['ENDED', new Date(), new Date(), m.meeting_id, m.status]);
    if (!rs.wasApplied()) throw httpError(409, 'MEETING_CHANGED', 'Cuộc họp vừa thay đổi trạng thái, hãy tải lại.');
    const room = rooms.get(m.meeting_id.toString());
    broadcast(m.meeting_id, 'meeting:ended', { reason: 'ended', by: user.userId });
    if (room) for (const sid of room.keys()) await markLeft(m.meeting_id, sid);
    rooms.delete(m.meeting_id.toString());
    await reminders.cancelTarget('MEETING', m.meeting_id.toString());
    const fresh = await readMeeting(m.meeting_id);
    realtime.publish([user.userId, ...(await invitations(m.meeting_id)).map(i => i.user_id)], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    return dto(fresh, user);
}

// ===== Phong hop =====
async function join(user, meetingId, body = {}) {
    const { m, acl } = await requireMeeting(user, meetingId);
    if (m.status === 'CANCELLED') throw httpError(410, 'MEETING_CLOSED', 'Cuộc họp đã bị hủy.');
    if (m.status === 'ENDED') throw httpError(410, 'MEETING_CLOSED', 'Cuộc họp đã kết thúc.');
    if (!canJoinNow(m)) {
        throw httpError(409, 'MEETING_NOT_OPEN', `Phòng họp mở từ 15 phút trước giờ bắt đầu (${fmt(m.start_at)}) đến khi kết thúc.`, { start: iso(m.start_at), end: iso(m.end_at) });
    }
    const room = roomOf(m.meeting_id);
    // Tai lai trang / ket noi lai: bo phien cu cua chinh nguoi nay (client giu sessionId cu trong sessionStorage cua tab).
    const prev = String(body.replaceSessionId || '');
    if (prev && room.get(prev)?.userId === user.userId) await removeFromRoom(m.meeting_id, prev, 'replaced');
    if (room.size >= MAX_PARTICIPANTS()) throw httpError(409, 'MEETING_FULL', `Phòng họp đã đủ ${MAX_PARTICIPANTS()} người (giới hạn kết nối trực tiếp).`);
    if (m.status === 'SCHEDULED') {
        await db.execute('UPDATE meetings SET status = ?, actual_start = ?, updated_at = ? WHERE meeting_id = ? IF status = ?',
            ['LIVE', new Date(), new Date(), m.meeting_id, 'SCHEDULED']);
    }
    // Nguoi duoc moi vao phong = chap nhan.
    if (acl.invitation && acl.invitation.status === 'PENDING') {
        await db.execute('UPDATE meeting_invitations SET status = ?, responded_at = ? WHERE meeting_id = ? AND user_id = ?', ['ACCEPTED', new Date(), m.meeting_id, user.userId]);
    }
    const sessionId = TimeUuid.now();
    const now = new Date();
    await db.execute('INSERT INTO meeting_participation (meeting_id, session_id, user_id, joined_at) VALUES (?, ?, ?, ?)', [m.meeting_id, sessionId, user.userId, now]);
    const profile = (await userService.getUsersByIds([user.userId])).get(user.userId);
    const entry = { userId: user.userId, displayName: profile?.displayName || user.userId, joinedAt: now, lastSeen: Date.now(), audio: true, video: true, screen: false };
    const others = rosterDto(room);
    room.set(sessionId.toString(), entry);
    startSweeper();
    broadcast(m.meeting_id, 'meeting:joined', { participant: { sessionId: sessionId.toString(), ...rosterDto(new Map([[sessionId.toString(), entry]]))[0] } },
        { except: sessionId.toString() });
    realtime.publish([m.organizer_id], 'meeting:changed', { meetingId: m.meeting_id.toString() });
    const exp = Math.min(Date.now() + TOKEN_TTL_MS, new Date(m.end_at).getTime() + 2 * 3600000);
    return {
        meeting: await dto(await readMeeting(m.meeting_id), user),
        sessionId: sessionId.toString(),
        token: signToken({ m: m.meeting_id.toString(), u: user.userId, s: sessionId.toString(), e: exp }),
        expiresAt: new Date(exp).toISOString(),
        iceServers: iceServers(user.userId),
        participants: others,
        // Nguoi moi vao gui offer toi nhung nguoi da o trong phong (tranh 2 ben cung gui offer).
        initiator: true
    };
}

function requireLive(meetingId, payload) {
    const room = rooms.get(String(meetingId));
    if (!room || !room.has(payload.s)) throw httpError(409, 'NOT_IN_ROOM', 'Bạn không còn ở trong phòng họp, hãy vào lại.');
    return room;
}

async function signal(user, meetingId, token, body = {}) {
    const p = verifyToken(token, user, meetingId);
    const room = requireLive(meetingId, p);
    const type = String(body.type || '');
    if (!SIGNAL_TYPES.includes(type)) throw httpError(400, 'INVALID_SIGNAL', 'Loại tín hiệu không hợp lệ.');
    const target = room.get(String(body.toSessionId || ''));
    if (!target) throw httpError(404, 'PEER_NOT_FOUND', 'Người nhận không còn trong phòng.');
    const payload = body.payload ?? null;
    if (JSON.stringify(payload).length > 64 * 1024) throw httpError(413, 'SIGNAL_TOO_LARGE', 'Tín hiệu quá lớn.');
    room.get(p.s).lastSeen = Date.now();
    realtime.publish([target.userId], 'meeting:signal', { meetingId: String(meetingId), fromSessionId: p.s, fromUserId: user.userId, fromDisplayName: room.get(p.s).displayName,
        toSessionId: String(body.toSessionId), type, payload });
    return { ok: true };
}

async function heartbeat(user, meetingId, token) {
    const p = verifyToken(token, user, meetingId);
    const room = requireLive(meetingId, p);
    room.get(p.s).lastSeen = Date.now();
    return { ok: true, participants: rosterDto(room) };
}

async function setMedia(user, meetingId, token, body = {}) {
    const p = verifyToken(token, user, meetingId);
    const room = requireLive(meetingId, p);
    const e = room.get(p.s);
    for (const k of ['audio', 'video', 'screen']) if (typeof body[k] === 'boolean') e[k] = body[k];
    e.lastSeen = Date.now();
    broadcast(meetingId, 'meeting:media', { sessionId: p.s, userId: user.userId, audio: e.audio, video: e.video, screen: e.screen });
    return { ok: true };
}

async function chat(user, meetingId, token, body = {}) {
    const p = verifyToken(token, user, meetingId);
    const room = requireLive(meetingId, p);
    const content = clean(body.content, 1000);
    if (!content) throw httpError(400, 'INVALID_CONTENT', 'Tin nhắn từ 1 đến 1000 ký tự.');
    const e = room.get(p.s);
    e.lastSeen = Date.now();
    const msg = { id: crypto.randomUUID(), sessionId: p.s, userId: user.userId, displayName: e.displayName, content, at: new Date().toISOString() };
    broadcast(meetingId, 'meeting:chat', { message: msg });
    return { message: msg };
}

async function leave(user, meetingId, token) {
    const p = verifyToken(token, user, meetingId);
    await removeFromRoom(meetingId, p.s, 'left');
    return { ok: true };
}

async function liveParticipants(user, meetingId) {
    const { m } = await requireMeeting(user, meetingId);
    const room = rooms.get(m.meeting_id.toString());
    return { items: room ? rosterDto(room) : [] };
}

// Lich su tham gia: nguoi to chuc xem tat ca; nguoi khac chi xem cua minh.
async function participationHistory(user, meetingId) {
    const { m, acl } = await requireMeeting(user, meetingId);
    const rows = (await db.execute('SELECT session_id, user_id, joined_at, left_at FROM meeting_participation WHERE meeting_id = ?', [m.meeting_id])).rows
        .filter(r => acl.organizer || r.user_id === user.userId);
    const profiles = await userService.getUsersByIds(rows.map(r => r.user_id));
    return {
        items: rows.map(r => ({ userId: r.user_id, displayName: profiles.get(r.user_id)?.displayName || r.user_id, joinedAt: iso(r.joined_at), leftAt: iso(r.left_at) }))
            .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
    };
}

// Kiem thu: xoa trang thai phong trong bo nho.
function _resetRooms() { rooms.clear(); }

module.exports = {
    createMeeting, getMeeting, listMine, listGroup, upcoming, invite, respond, createLink, revokeLink, joinByLink, reschedule, cancelMeeting,
    endMeeting, join, signal, heartbeat, setMedia, chat, leave, liveParticipants, participationHistory, requireMeetingAccess, tokenFrom,
    iceServers, _resetRooms, STATUS_LABEL
};
