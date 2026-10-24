// Bao cao vi pham & kiem duyet: PT-07 bao cao, PT-08 kiem duyet / khoa tai khoan, PT-16 trang quan tri.
//
// Quan tri vien: account_security.role = 'ADMIN' hoac email nam trong ADMIN_EMAILS (backend/.env).
// "An" noi dung dung co che xoa mem co san (is_deleted = true) nen moi man hinh cu tu an noi dung,
// nhung KHONG xoa noi dung goc -> khoi phuc duoc. moderation_state danh dau noi dung do quan tri vien an.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, Uuid, parseTimeUuid, parseTimestamp, iso, toNumber } = require('../utils/types');
const { localParts } = require('../utils/searchTerms');
const { bucketOf } = require('../utils/postTime');
const conversations = require('../services/conversation.service');
const messageService = require('../services/message.service');
const posts = require('../services/post.service');
const userService = require('../services/user.service');
const realtime = require('../services/realtime.service');
const security = require('./security.service');

const TARGETS = ['POST', 'COMMENT', 'MESSAGE', 'USER'];
const REASONS = ['SPAM', 'HARASSMENT', 'HATE', 'NUDITY', 'VIOLENCE', 'SCAM', 'FAKE', 'OTHER'];
const STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'];

const clip = (t, n = 160) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
};

async function requireAdmin(user) {
    if (!(await security.isAdmin(user))) throw httpError(403, 'FORBIDDEN_ADMIN', 'Chức năng chỉ dành cho quản trị viên.');
}

// ===== Doi tuong bi bao cao: kiem tra nguoi bao cao THAY duoc doi tuong =====
async function resolveTarget(user, body) {
    const type = String(body.targetType || '').toUpperCase();
    if (!TARGETS.includes(type)) throw httpError(400, 'INVALID_TARGET', 'Loại nội dung không hợp lệ.');
    if (type === 'USER') {
        const id = String(body.targetId || '');
        const u = (await userService.getUsersByIds([id])).get(id);
        if (!u) throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
        if (id === user.userId) throw httpError(400, 'SELF_REPORT', 'Không thể báo cáo chính mình.');
        return { type, targetId: id, ownerId: id, excerpt: `Tài khoản ${u.displayName}` };
    }
    if (type === 'POST') {
        const pid = posts.parseId(body.targetId);
        const row = await posts.requireVisiblePost(user, pid);
        return { type, targetId: pid.toString(), ownerId: row.author_id, postId: pid, excerpt: clip(row.content) };
    }
    if (type === 'COMMENT') {
        const pid = posts.parseId(body.postId, 'postId');
        await posts.requireVisiblePost(user, pid);
        const cmid = posts.parseId(body.targetId, 'commentId');
        const c = (await db.execute('SELECT author_id, content, is_deleted FROM post_comments WHERE post_id = ? AND comment_id = ?', [pid, cmid])).first();
        if (!c || c.is_deleted) throw httpError(404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận.');
        return { type, targetId: cmid.toString(), ownerId: c.author_id, postId: pid, excerpt: clip(c.content) };
    }
    const { cid } = await conversations.requireMembership(body.conversationId, user.userId);
    const mid = parseTimeUuid(body.targetId);
    const at = parseTimestamp(body.createdAt);
    const m = await messageService.readByFullKey(cid, at, mid);
    if (!m || m.message_type === 'SYSTEM') throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
    return { type, targetId: mid.toString(), ownerId: m.sender_id, conversationId: cid, messageCreatedAt: m.created_at, excerpt: clip(m.content) };
}

async function createReport(user, body = {}) {
    const reason = String(body.reason || '').toUpperCase();
    if (!REASONS.includes(reason)) throw httpError(400, 'INVALID_REASON', 'Lý do báo cáo không hợp lệ.');
    const details = typeof body.details === 'string' ? body.details.trim().slice(0, 500) : '';
    const t = await resolveTarget(user, body);
    if (t.ownerId === user.userId) throw httpError(400, 'SELF_REPORT', 'Không thể báo cáo nội dung của chính mình.');
    const reportId = TimeUuid.now();
    const key = `${t.type}:${t.targetId}`;
    const claim = await db.execute('INSERT INTO report_keys (reporter_id, target_key, report_id) VALUES (?, ?, ?) IF NOT EXISTS', [user.userId, key, reportId]);
    if (!claim.wasApplied()) return { reported: true, duplicate: true, message: 'Bạn đã báo cáo nội dung này. Quản trị viên sẽ xem xét.' };
    const now = reportId.getDate();
    await db.execute(
        `INSERT INTO reports (report_id, reporter_id, target_type, target_id, target_owner_id, conversation_id, post_id, message_created_at,
            reason, details, excerpt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
        [reportId, user.userId, t.type, t.targetId, t.ownerId, t.conversationId || null, t.postId || null, t.messageCreatedAt || null,
            reason, details, t.excerpt, now]);
    await db.execute(
        "INSERT INTO reports_by_status (status, report_id, target_type, target_id, reporter_id, reason, excerpt) VALUES ('OPEN', ?, ?, ?, ?, ?, ?)",
        [reportId, t.type, t.targetId, user.userId, reason, t.excerpt]);
    realtime.publishAll('report:new', { reportId: reportId.toString() }); // khong chua noi dung; client admin tu tai lai
    return { reported: true, reportId: reportId.toString(), message: 'Đã gửi báo cáo. Cảm ơn bạn đã giúp ChatOTT an toàn hơn.' };
}

async function reportDto(row) {
    const ids = [row.reporter_id, row.target_owner_id, row.resolved_by].filter(Boolean);
    const p = await userService.getUsersByIds(ids);
    const name = id => (id ? p.get(id)?.displayName || id : null);
    const state = (await db.execute('SELECT hidden FROM moderation_state WHERE target_key = ?', [`${row.target_type}:${row.target_id}`])).first();
    return {
        reportId: row.report_id.toString(), status: row.status, reason: row.reason, details: row.details || '',
        targetType: row.target_type, targetId: row.target_id, excerpt: row.excerpt || '',
        conversationId: row.conversation_id ? row.conversation_id.toString() : null,
        postId: row.post_id ? row.post_id.toString() : null, messageCreatedAt: iso(row.message_created_at),
        reporter: { userId: row.reporter_id, displayName: name(row.reporter_id) },
        owner: row.target_owner_id ? { userId: row.target_owner_id, displayName: name(row.target_owner_id) } : null,
        createdAt: iso(row.created_at), resolvedAt: iso(row.resolved_at), resolvedBy: name(row.resolved_by), resolution: row.resolution || null,
        contentHidden: Boolean(state && state.hidden)
    };
}

const REPORT_COLS = `report_id, reporter_id, target_type, target_id, target_owner_id, conversation_id, post_id, message_created_at,
    reason, details, excerpt, status, created_at, resolved_by, resolved_at, resolution`;

async function listReports(admin, query = {}) {
    await requireAdmin(admin);
    const status = STATUSES.includes(String(query.status || 'OPEN').toUpperCase()) ? String(query.status || 'OPEN').toUpperCase() : 'OPEN';
    const rs = await db.execute('SELECT report_id FROM reports_by_status WHERE status = ? LIMIT 100', [status]);
    const items = [];
    for (const r of rs.rows) {
        const row = (await db.execute(`SELECT ${REPORT_COLS} FROM reports WHERE report_id = ?`, [r.report_id])).first();
        if (row) items.push(await reportDto(row));
    }
    return { status, items };
}

async function log(admin, action, targetType, targetId, note) {
    const id = TimeUuid.now();
    await db.execute('INSERT INTO moderation_log (day, action_id, admin_id, action, target_type, target_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [localParts(id.getDate()).day, id, admin.userId, action, targetType, String(targetId), clip(note, 300) || null]);
}

// ===== An / khoi phuc noi dung =====
async function setHiddenState(admin, key, hidden, note) {
    await db.execute('INSERT INTO moderation_state (target_key, hidden, hidden_by, hidden_at, note) VALUES (?, ?, ?, ?, ?)',
        [key, hidden, admin.userId, new Date(), clip(note, 300) || null]);
}

async function hidePost(pid, hidden) {
    const row = await posts.readPost(pid);
    if (!row) throw httpError(404, 'POST_NOT_FOUND', 'Không tìm thấy bài viết.');
    await db.execute('UPDATE posts SET is_deleted = ? WHERE post_id = ?', [hidden, pid]);
    if (row.privacy === 'PUBLIC') {
        const bucket = bucketOf(pid);
        if (hidden) await db.execute('DELETE FROM public_posts_by_month WHERE bucket = ? AND post_id = ?', [bucket, pid]);
        else await db.execute('INSERT INTO public_posts_by_month (bucket, post_id, author_id) VALUES (?, ?, ?)', [bucket, pid, row.author_id]);
    }
    realtime.publishAll('post:changed', { postId: pid.toString(), kind: hidden ? 'delete' : 'update' });
}

async function hideContent(admin, body = {}, hidden = true) {
    await requireAdmin(admin);
    const type = String(body.targetType || '').toUpperCase();
    const note = body.note || '';
    if (type === 'POST') {
        const pid = posts.parseId(body.targetId);
        const state = (await db.execute('SELECT hidden FROM moderation_state WHERE target_key = ?', [`POST:${pid}`])).first();
        if (!hidden && !(state && state.hidden)) throw httpError(400, 'NOT_MODERATED', 'Bài này không bị quản trị viên ẩn nên không khôi phục được.');
        await hidePost(pid, hidden);
        await setHiddenState(admin, `POST:${pid}`, hidden, note);
    } else if (type === 'COMMENT') {
        const pid = posts.parseId(body.postId, 'postId');
        const cmid = posts.parseId(body.targetId, 'commentId');
        const c = (await db.execute('SELECT comment_id FROM post_comments WHERE post_id = ? AND comment_id = ?', [pid, cmid])).first();
        if (!c) throw httpError(404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận.');
        await db.execute('UPDATE post_comments SET is_deleted = ? WHERE post_id = ? AND comment_id = ?', [hidden, pid, cmid]);
        await setHiddenState(admin, `COMMENT:${cmid}`, hidden, note);
        realtime.publishAll('post:changed', { postId: pid.toString(), kind: 'comment' });
    } else if (type === 'MESSAGE') {
        const cid = Uuid.fromString(String(body.conversationId || '').toLowerCase());
        const mid = parseTimeUuid(body.targetId);
        const at = parseTimestamp(body.createdAt);
        const m = await messageService.readByFullKey(cid, at, mid);
        if (!m) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
        if (!hidden && !m.content) throw httpError(400, 'NOT_RESTORABLE', 'Tin nhắn đã bị người gửi thu hồi, không khôi phục được.');
        await db.execute('UPDATE messages_by_conversation SET is_deleted = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?',
            [hidden, cid, m.created_at, mid]);
        await setHiddenState(admin, `MESSAGE:${mid}`, hidden, note);
        const conv = await conversations.getConversationRow(cid);
        const members = conversations.membersOf(conv);
        if (hidden) {
            realtime.publish(members, 'message:deleted', { conversationId: cid.toString(), messageId: mid.toString(), createdAt: iso(m.created_at) });
            await require('../services/pin.service').unpinRecalled(cid, mid, members).catch(() => {});
        } else {
            realtime.publish(members, 'message:restored', { conversationId: cid.toString(), messageId: mid.toString() });
        }
    } else {
        throw httpError(400, 'INVALID_TARGET', 'Chỉ ẩn được bài viết, bình luận hoặc tin nhắn.');
    }
    await log(admin, hidden ? 'HIDE_CONTENT' : 'RESTORE_CONTENT', type, body.targetId, note);
    return { targetType: type, targetId: String(body.targetId), hidden };
}

async function moveReport(row, status, admin, resolution) {
    const now = new Date();
    await db.execute('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, resolution = ? WHERE report_id = ?',
        [status, admin.userId, now, resolution, row.report_id]);
    await db.execute('DELETE FROM reports_by_status WHERE status = ? AND report_id = ?', [row.status, row.report_id]);
    await db.execute('INSERT INTO reports_by_status (status, report_id, target_type, target_id, reporter_id, reason, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [status, row.report_id, row.target_type, row.target_id, row.reporter_id, row.reason, row.excerpt]);
}

// POST /admin/reports/:id/resolve { action: HIDE | LOCK_USER | DISMISS | RESOLVE, note }
async function resolveReport(admin, reportId, body = {}) {
    await requireAdmin(admin);
    const rid = parseTimeUuid(reportId, 'reportId');
    const row = (await db.execute(`SELECT ${REPORT_COLS} FROM reports WHERE report_id = ?`, [rid])).first();
    if (!row) throw httpError(404, 'REPORT_NOT_FOUND', 'Không tìm thấy báo cáo.');
    const action = String(body.action || '').toUpperCase();
    const note = typeof body.note === 'string' ? body.note : '';
    if (action === 'HIDE') {
        await hideContent(admin, {
            targetType: row.target_type, targetId: row.target_id, postId: row.post_id && row.post_id.toString(),
            conversationId: row.conversation_id && row.conversation_id.toString(), createdAt: iso(row.message_created_at), note
        }, true);
    } else if (action === 'LOCK_USER') {
        if (!row.target_owner_id) throw httpError(400, 'NO_OWNER', 'Báo cáo không gắn với tài khoản nào.');
        await lockUser(admin, row.target_owner_id, { reason: note || `Vi phạm: ${row.reason}` });
    } else if (!['DISMISS', 'RESOLVE'].includes(action)) {
        throw httpError(400, 'INVALID_ACTION', 'Hành động phải là HIDE, LOCK_USER, RESOLVE hoặc DISMISS.');
    }
    const status = action === 'DISMISS' ? 'DISMISSED' : 'RESOLVED';
    await moveReport(row, status, admin, `${action}${note ? ': ' + clip(note, 200) : ''}`);
    await log(admin, `REPORT_${status}`, 'REPORT', rid.toString(), note);
    await require('../services/notification.service').notifySafe({
        recipientId: row.reporter_id, actorId: admin.userId, type: 'REPORT_UPDATE', dedupeKey: `REPORT:${rid}`,
        preview: status === 'DISMISSED' ? 'Báo cáo của bạn đã được xem xét, nội dung không vi phạm.' : 'Báo cáo của bạn đã được xử lý. Cảm ơn bạn!'
    });
    return reportDto((await db.execute(`SELECT ${REPORT_COLS} FROM reports WHERE report_id = ?`, [rid])).first());
}

// ===== Tai khoan =====
async function lockUser(admin, userId, body = {}) {
    await requireAdmin(admin);
    if (userId === admin.userId) throw httpError(400, 'SELF_LOCK', 'Không thể tự khóa tài khoản của mình.');
    const r = await security.lockUser(userId, admin.userId, body.reason);
    await log(admin, 'LOCK_USER', 'USER', userId, body.reason);
    return { userId, ...r };
}

async function unlockUser(admin, userId) {
    await requireAdmin(admin);
    const r = await security.unlockUser(userId);
    await log(admin, 'UNLOCK_USER', 'USER', userId, '');
    return { userId, ...r };
}

async function setUserRole(admin, userId, body = {}) {
    await requireAdmin(admin);
    if (userId === admin.userId && body.role !== 'ADMIN') throw httpError(400, 'SELF_ROLE', 'Không thể tự gỡ quyền quản trị.');
    const r = await security.setRole(userId, String(body.role || '').toUpperCase());
    await log(admin, 'SET_ROLE', 'USER', userId, r.role);
    return r;
}

async function searchUsers(admin, query = {}) {
    await requireAdmin(admin);
    const q = String(query.q || '').trim();
    const found = q ? await userService.searchUsers(q, null, 30) : (await userService.listUsers()).slice(0, 50);
    const out = [];
    for (const u of found) {
        const sec = await security.getSecurity(u.userId);
        out.push({
            userId: u.userId, displayName: u.displayName, avatarUrl: u.avatarUrl || null,
            email: (sec && sec.email) || null, isAdmin: security.isAdminRow(sec, null),
            locked: Boolean(sec && sec.locked), lockedReason: (sec && sec.locked_reason) || null
        });
    }
    return { items: out };
}

async function moderationLog(admin, query = {}) {
    await requireAdmin(admin);
    const days = Math.min(Math.max(Number(query.days) || 7, 1), 31);
    const items = [];
    for (let d = 0; d < days; d++) {
        const day = localParts(Date.now() - d * 86400000).day;
        const rs = await db.execute('SELECT action_id, admin_id, action, target_type, target_id, note FROM moderation_log WHERE day = ? LIMIT 200', [day]);
        items.push(...rs.rows);
    }
    const profiles = await userService.getUsersByIds(items.map(r => r.admin_id));
    return {
        items: items.map(r => ({
            actionId: r.action_id.toString(), at: iso(r.action_id.getDate()), admin: profiles.get(r.admin_id)?.displayName || r.admin_id,
            action: r.action, targetType: r.target_type, targetId: r.target_id, note: r.note || ''
        }))
    };
}

// ===== PT-16: tong quan he thong =====
async function overview(admin) {
    await requireAdmin(admin);
    const started = process.hrtime.bigint();
    let cassandra = { status: 'UP' };
    try {
        await db.execute('SELECT release_version FROM system.local');
    } catch (error) {
        // Fake Cassandra (kiem thu) khong co bang system.local: thu 1 truy van nho khac.
        try { await db.execute('SELECT user_id FROM users LIMIT 1'); } catch { cassandra = { status: 'DOWN', error: error.message }; }
    }
    cassandra.latencyMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
    try {
        const client = db.getClient();
        const hosts = client.hosts && typeof client.hosts.values === 'function' ? client.hosts.values() : [];
        cassandra.hosts = hosts.map(h => ({ address: h.address, datacenter: h.datacenter, up: h.isUp() }));
        cassandra.keyspace = client.keyspace || process.env.CASSANDRA_KEYSPACE || 'chat_ott';
    } catch { /* bo qua */ }

    // Demo / do an: so nguoi dung = quet bang users (nho). Tin / ngay = cong bang counter theo hoi thoai.
    let users = 0;
    let pageState;
    do {
        const rs = await db.execute('SELECT user_id FROM users', [], { fetchSize: 1000, pageState });
        users += rs.rows.length;
        pageState = rs.pageState;
    } while (pageState && users < 100000);

    const days = Array.from({ length: 14 }, (_, i) => localParts(Date.now() - (13 - i) * 86400000).day);
    const perDay = Object.fromEntries(days.map(d => [d, 0]));
    let conversationsCount = 0;
    let cs;
    do {
        const rs = await db.execute('SELECT conversation_id FROM conversations', [], { fetchSize: 500, pageState: cs });
        for (const r of rs.rows) {
            conversationsCount += 1;
            const stats = await db.execute('SELECT day, messages FROM conversation_daily_stats WHERE conversation_id = ? AND day >= ?', [r.conversation_id, days[0]]);
            stats.rows.forEach(s => { if (s.day in perDay) perDay[s.day] += toNumber(s.messages) || 0; });
        }
        cs = rs.pageState;
    } while (cs && conversationsCount < 20000);

    const openReports = (await db.execute('SELECT report_id FROM reports_by_status WHERE status = ? LIMIT 1000', ['OPEN'])).rows.length;
    const mem = process.memoryUsage();
    return {
        users,
        conversations: conversationsCount,
        messagesPerDay: days.map(d => ({ day: d, messages: perDay[d] })),
        messagesToday: perDay[days[days.length - 1]],
        realtime: { connections: realtime.connectionCount() },
        openReports,
        cassandra,
        process: { uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), node: process.version },
        generatedAt: new Date().toISOString()
    };
}

module.exports = {
    TARGETS, REASONS, requireAdmin, createReport, listReports, resolveReport, hideContent, lockUser, unlockUser,
    setUserRole, searchUsers, moderationLog, overview
};
