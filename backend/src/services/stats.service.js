// Thong ke (Huong 4): bang counter cap nhat ngay khi ghi -> mo trang thong ke chi doc vai partition nho.
// Tach rieng thong ke TIN NHAN (theo hoi thoai) va MANG XA HOI (theo nguoi dung).
// Tin da thu hoi van tinh la "da gui" (thong ke luong gui, khong phai noi dung con lai).
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { localParts } = require('../utils/searchTerms');
const { toNumber } = require('../utils/types');
const userService = require('./user.service');

const SOCIAL_METRICS = ['posts', 'comments_made', 'comments_received', 'reactions_made', 'reactions_received', 'shares_received'];

// Ghi 1 tin vao 4 bang counter. Loi thong ke khong lam hong viec gui tin.
async function recordMessage(conversationId, { createdAt, messageType, senderId }) {
    const { day, hour } = localParts(createdAt);
    await Promise.all([
        db.execute('UPDATE conversation_daily_stats SET messages = messages + 1 WHERE conversation_id = ? AND day = ?', [conversationId, day]),
        db.execute('UPDATE conversation_hourly_stats SET messages = messages + 1 WHERE conversation_id = ? AND hour = ?', [conversationId, hour]),
        db.execute('UPDATE conversation_type_stats SET messages = messages + 1 WHERE conversation_id = ? AND message_type = ?', [conversationId, messageType || 'TEXT']),
        db.execute('UPDATE conversation_sender_stats SET messages = messages + 1 WHERE conversation_id = ? AND sender_id = ?', [conversationId, senderId])
    ]).catch(error => console.warn('Không cập nhật được thống kê tin nhắn:', error.message));
}

async function bumpSocial(userId, metric, delta = 1) {
    if (!userId || !SOCIAL_METRICS.includes(metric) || !delta) return;
    const op = delta > 0 ? '+' : '-';
    await db.execute(`UPDATE user_social_stats SET amount = amount ${op} ? WHERE user_id = ? AND metric = ?`,
        [Math.abs(delta), userId, metric]).catch(error => console.warn('Không cập nhật được thống kê:', error.message));
}

const num = v => toNumber(v) || 0;

async function conversationAnalytics(conversationId, user, { days = 30 } = {}) {
    const conversations = require('./conversation.service');
    const { cid, members } = await conversations.requireMembership(conversationId, user.userId);
    const span = Math.min(Math.max(Number(days) || 30, 1), 365);
    const since = localParts(Date.now() - (span - 1) * 86400000).day;
    const [daily, hourly, types, senders] = await Promise.all([
        db.execute('SELECT day, messages FROM conversation_daily_stats WHERE conversation_id = ? AND day >= ?', [cid, since]),
        db.execute('SELECT hour, messages FROM conversation_hourly_stats WHERE conversation_id = ?', [cid]),
        db.execute('SELECT message_type, messages FROM conversation_type_stats WHERE conversation_id = ?', [cid]),
        db.execute('SELECT sender_id, messages FROM conversation_sender_stats WHERE conversation_id = ?', [cid])
    ]);
    const profiles = await userService.getUsersByIds(senders.rows.map(r => r.sender_id));
    const byType = Object.fromEntries(types.rows.map(r => [r.message_type, num(r.messages)]));
    return {
        conversationId: cid.toString(),
        participants: members.length,
        totalMessages: Object.values(byType).reduce((a, b) => a + b, 0),
        days: span,
        daily: daily.rows.map(r => ({ day: r.day, messages: num(r.messages) })).sort((a, b) => a.day.localeCompare(b.day)),
        hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, messages: num(hourly.rows.find(r => r.hour === h)?.messages) })),
        byType,
        topSenders: senders.rows
            .map(r => ({ userId: r.sender_id, displayName: profiles.get(r.sender_id)?.displayName || 'Người dùng cũ', messages: num(r.messages) }))
            .sort((a, b) => b.messages - a.messages).slice(0, 10),
        source: 'Bảng tổng hợp cập nhật khi ghi (counter), không quét tin nhắn'
    };
}

async function socialAnalytics(user, userId = user.userId) {
    if (userId !== user.userId) throw httpError(403, 'FORBIDDEN', 'Bạn chỉ xem được thống kê của chính mình.');
    const rs = await db.execute('SELECT metric, amount FROM user_social_stats WHERE user_id = ?', [userId]);
    const out = Object.fromEntries(SOCIAL_METRICS.map(m => [m, 0]));
    rs.rows.forEach(r => { out[r.metric] = num(r.amount); });
    return { userId, ...out };
}

module.exports = { recordMessage, bumpSocial, conversationAnalytics, socialAnalytics, SOCIAL_METRICS };
