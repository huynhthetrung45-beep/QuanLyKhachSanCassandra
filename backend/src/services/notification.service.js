// Thong bao ben vung (Cassandra) + day realtime (SSE) toi DUNG nguoi nhan.
//
// Chong trung: moi su kien co dedupe_key on dinh (vd. REACTION:<postId>:<actor>). Lan dau ghi
// notification_keys bang LWT IF NOT EXISTS -> chi 1 thong bao du API bi goi lai / bam nhieu lan.
// Rieng tin nhan (MESSAGE:<conversationId>): khi thong bao cu CHUA doc, thong bao duoc "don len"
// (thay bang ban moi nhat, tang event_count) thay vi tao them dong - bang LWT IF notification_id = cu.
// Khong bao gio thong bao cho chinh nguoi thuc hien.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, Uuid, iso } = require('../utils/types');
const { encodePageToken, decodePageToken } = require('../utils/pageToken');
const crypto = require('crypto');
const realtime = require('./realtime.service');
const userService = require('./user.service');

const TYPES = ['POST_REACTION', 'POST_COMMENT', 'COMMENT_REPLY', 'POST_SHARE', 'FRIEND_REQUEST', 'FRIEND_ACCEPT', 'MESSAGE'];
const PAGE = 20;
const UNREAD_SCAN = 200; // dem chua doc trong 200 thong bao moi nhat (hien "99+" neu lon)
const PREVIEW_MAX = 120;
const COLS = 'notification_id, actor_id, type, post_id, comment_id, conversation_id, preview, event_count, is_read';

const clip = text => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + '…' : t;
};

function scopeOf(userId) {
    // pageToken gan voi nguoi dung (khong dung token cua nguoi khac).
    return '00000000-0000-1000-8000-' + crypto.createHash('sha1').update('notif:' + userId).digest('hex').slice(0, 12);
}

async function readRow(userId, notificationId) {
    return (await db.execute(`SELECT ${COLS} FROM notifications_by_user WHERE user_id = ? AND notification_id = ?`,
        [userId, notificationId])).first();
}

async function toDtos(rows) {
    const profiles = await userService.getUsersByIds([...new Set(rows.map(r => r.actor_id).filter(Boolean))]);
    return rows.map(r => {
        const actor = profiles.get(r.actor_id);
        return {
            notificationId: r.notification_id.toString(),
            type: r.type,
            actor: actor ? { userId: actor.userId, displayName: actor.displayName } : { userId: r.actor_id, displayName: 'Người dùng' },
            postId: r.post_id ? r.post_id.toString() : null,
            commentId: r.comment_id ? r.comment_id.toString() : null,
            conversationId: r.conversation_id ? r.conversation_id.toString() : null,
            preview: r.preview || '',
            count: r.event_count || 1,
            isRead: Boolean(r.is_read),
            createdAt: iso(r.notification_id.getDate())
        };
    });
}

async function unreadCount(userId) {
    const rs = await db.execute(`SELECT is_read FROM notifications_by_user WHERE user_id = ? LIMIT ${UNREAD_SCAN}`, [userId]);
    return rs.rows.filter(r => !r.is_read).length;
}

async function insertRow(userId, id, ev, count) {
    await db.execute(
        `INSERT INTO notifications_by_user (user_id, notification_id, actor_id, type, post_id, comment_id, conversation_id, preview, event_count, is_read)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, false)`,
        [userId, id, ev.actorId, ev.type, ev.postId || null, ev.commentId || null, ev.conversationId || null, clip(ev.preview), count]
    );
}

async function push(userId, id) {
    const row = await readRow(userId, id);
    if (!row) return;
    const [dto] = await toDtos([row]);
    realtime.publish([userId], 'notification:new', { notification: dto, unreadCount: await unreadCount(userId) });
}

// ev: { recipientId, actorId, type, dedupeKey, postId?, commentId?, conversationId?, preview?, stack? }
async function notify(ev) {
    if (!ev.recipientId || ev.recipientId === ev.actorId) return null; // khong tu thong bao cho minh
    if (!TYPES.includes(ev.type)) throw new Error('Loai thong bao khong hop le: ' + ev.type);
    const id = TimeUuid.now();
    const claim = await db.execute(
        'INSERT INTO notification_keys (user_id, dedupe_key, notification_id) VALUES (?, ?, ?) IF NOT EXISTS',
        [ev.recipientId, ev.dedupeKey, id]
    );
    if (claim.wasApplied()) {
        await insertRow(ev.recipientId, id, ev, 1);
        await push(ev.recipientId, id);
        return id;
    }
    if (!ev.stack) return null; // da thong bao su kien nay -> khong trung
    // Don thong bao (tin nhan): doc ban cu; neu da doc -> tao ban moi; neu chua -> thay ban cu.
    const keyRow = (await db.execute('SELECT notification_id FROM notification_keys WHERE user_id = ? AND dedupe_key = ?',
        [ev.recipientId, ev.dedupeKey])).first();
    if (!keyRow) return null;
    const old = await readRow(ev.recipientId, keyRow.notification_id);
    const moved = await db.execute(
        'UPDATE notification_keys SET notification_id = ? WHERE user_id = ? AND dedupe_key = ? IF notification_id = ?',
        [id, ev.recipientId, ev.dedupeKey, keyRow.notification_id]
    );
    if (!moved.wasApplied()) return null; // request dong thoi da don roi
    const count = old && !old.is_read ? (old.event_count || 1) + 1 : 1;
    await insertRow(ev.recipientId, id, ev, count);
    if (old && !old.is_read) {
        await db.execute('DELETE FROM notifications_by_user WHERE user_id = ? AND notification_id = ?', [ev.recipientId, old.notification_id]);
    }
    await push(ev.recipientId, id);
    return id;
}

// Goi tu luong nghiep vu: loi thong bao khong duoc lam hong hanh dong chinh.
function notifySafe(ev) {
    return notify(ev).catch(error => console.warn('Không tạo được thông báo:', error.message));
}

async function list(user, pageToken) {
    const scope = scopeOf(user.userId);
    const pageState = pageToken ? decodePageToken(pageToken, scope) : undefined;
    const rs = await db.execute(`SELECT ${COLS} FROM notifications_by_user WHERE user_id = ?`, [user.userId], { fetchSize: PAGE, pageState });
    const nextPageToken = rs.pageState ? encodePageToken(scope, rs.pageState) : null;
    return { items: await toDtos(rs.rows), nextPageToken, hasMore: Boolean(nextPageToken), unreadCount: await unreadCount(user.userId) };
}

async function markRead(user, notificationId) {
    let id;
    try { id = TimeUuid.fromString(String(notificationId)); } catch { throw httpError(400, 'INVALID_ID', 'notificationId không hợp lệ.'); }
    const row = await readRow(user.userId, id); // chi doc trong partition cua CHINH minh
    if (!row) throw httpError(404, 'NOTIFICATION_NOT_FOUND', 'Không tìm thấy thông báo.');
    if (!row.is_read) await db.execute('UPDATE notifications_by_user SET is_read = true WHERE user_id = ? AND notification_id = ?', [user.userId, id]);
    const unread = await unreadCount(user.userId);
    realtime.publish([user.userId], 'notification:read', { notificationIds: [id.toString()], unreadCount: unread });
    return { notificationId: id.toString(), isRead: true, unreadCount: unread };
}

async function markAllRead(user) {
    const rs = await db.execute(`SELECT notification_id, is_read FROM notifications_by_user WHERE user_id = ? LIMIT ${UNREAD_SCAN}`, [user.userId]);
    const ids = rs.rows.filter(r => !r.is_read).map(r => r.notification_id);
    await Promise.all(ids.map(id => db.execute('UPDATE notifications_by_user SET is_read = true WHERE user_id = ? AND notification_id = ?', [user.userId, id])));
    realtime.publish([user.userId], 'notification:read', { notificationIds: ids.map(String), unreadCount: 0 });
    return { updated: ids.length, unreadCount: await unreadCount(user.userId) };
}

// Mo hoi thoai = da doc thong bao tin nhan cua hoi thoai do.
async function markConversationRead(userId, conversationId) {
    const keyRow = (await db.execute('SELECT notification_id FROM notification_keys WHERE user_id = ? AND dedupe_key = ?',
        [userId, `MESSAGE:${conversationId}`])).first();
    if (!keyRow) return;
    const row = await readRow(userId, keyRow.notification_id);
    if (!row || row.is_read) return;
    await db.execute('UPDATE notifications_by_user SET is_read = true WHERE user_id = ? AND notification_id = ?', [userId, row.notification_id]);
    realtime.publish([userId], 'notification:read', { notificationIds: [row.notification_id.toString()], unreadCount: await unreadCount(userId) });
}

module.exports = { notify, notifySafe, list, markRead, markAllRead, markConversationRead, unreadCount, TYPES, Uuid };
