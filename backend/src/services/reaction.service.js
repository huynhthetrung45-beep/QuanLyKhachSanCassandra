// Tha cam xuc. Quy tac: MOI NGUOI TOI DA 1 cam xuc / tin.
// Khoa chinh ((conversation_id), message_id, user_id): tha lai = ghi de (doi emoji),
// bam 2 lan / retry = cung mot dong -> khong the tao ban ghi trung.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { parseTimeUuid, parseTimestamp } = require('../utils/types');
const conversations = require('./conversation.service');
const realtime = require('./realtime.service');

const ALLOWED_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// Gom reaction cua nhieu tin trong MOT partition: message_id IN (...) tren cot clustering.
async function summaries(cid, messageIds) {
    const map = new Map();
    if (messageIds.length === 0) return map;
    const marks = messageIds.map(() => '?').join(', ');
    const rs = await db.execute(
        `SELECT message_id, user_id, emoji FROM reactions_by_message
         WHERE conversation_id = ? AND message_id IN (${marks})`,
        [cid, ...messageIds]
    );
    for (const row of rs.rows) {
        const mid = row.message_id.toString();
        if (!map.has(mid)) map.set(mid, new Map());
        const byEmoji = map.get(mid);
        if (!byEmoji.has(row.emoji)) byEmoji.set(row.emoji, []);
        byEmoji.get(row.emoji).push(row.user_id);
    }
    const out = new Map();
    for (const [mid, byEmoji] of map) {
        out.set(mid, [...byEmoji].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
            .sort((a, b) => b.count - a.count || ALLOWED_EMOJI.indexOf(a.emoji) - ALLOWED_EMOJI.indexOf(b.emoji)));
    }
    return out;
}

// Tin phai ton tai trong DUNG hoi thoai, chua thu hoi, khong phai tin he thong.
async function loadTarget(conversationId, messageId, createdAt, user) {
    const mid = parseTimeUuid(messageId);
    const at = parseTimestamp(createdAt);
    const { cid, members } = await conversations.requireMembership(conversationId, user.userId);
    const msg = (await db.execute(
        `SELECT message_id, is_deleted, message_type FROM messages_by_conversation
         WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
        [cid, at, mid]
    )).first();
    if (!msg) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
    if (msg.is_deleted) throw httpError(400, 'MESSAGE_RECALLED', 'Không thể thả cảm xúc cho tin đã thu hồi.');
    if (msg.message_type === 'SYSTEM') throw httpError(400, 'SYSTEM_MESSAGE', 'Không thể thả cảm xúc cho tin hệ thống.');
    return { cid, mid, members };
}

async function publishSummary(cid, mid, members) {
    const reactions = (await summaries(cid, [mid])).get(mid.toString()) || [];
    realtime.publish(members, 'reaction:updated', { conversationId: cid.toString(), messageId: mid.toString(), reactions });
    return reactions;
}

async function setReaction(conversationId, messageId, user, body = {}) {
    if (!ALLOWED_EMOJI.includes(body.emoji)) {
        throw httpError(400, 'INVALID_EMOJI', 'Cảm xúc không được hỗ trợ.');
    }
    const { cid, mid, members } = await loadTarget(conversationId, messageId, body.createdAt, user);
    await db.execute(
        `INSERT INTO reactions_by_message (conversation_id, message_id, user_id, emoji, reacted_at)
         VALUES (?, ?, ?, ?, ?)`,
        [cid, mid, user.userId, body.emoji, new Date()]
    );
    return { messageId: mid.toString(), reactions: await publishSummary(cid, mid, members) };
}

async function removeReaction(conversationId, messageId, user, query = {}) {
    const { cid, mid, members } = await loadTarget(conversationId, messageId, query.createdAt, user);
    await db.execute(
        'DELETE FROM reactions_by_message WHERE conversation_id = ? AND message_id = ? AND user_id = ?',
        [cid, mid, user.userId]
    );
    return { messageId: mid.toString(), reactions: await publishSummary(cid, mid, members) };
}

module.exports = { summaries, setReaction, removeReaction, ALLOWED_EMOJI };
