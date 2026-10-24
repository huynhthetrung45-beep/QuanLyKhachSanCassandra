// Ghim tin nhan trong hoi thoai (migration 008).
// Quyen (kiem tra o backend, danh tinh lay tu phien dang nhap):
//  - Doc danh sach ghim / ghim tin: moi THANH VIEN cua hoi thoai (nguoi ngoai: 403, khong lo noi dung).
//  - Bo ghim: nguoi da ghim tin do; hoac truong nhom (created_by) trong nhom; hoac ca hai nguoi trong hoi thoai 1-1.
// Doc 1 partition pinned_messages_by_conversation (<= MAX_PINS dong), roi doc tin goc bang khoa chinh day du.
// Ghi chi bang LWT: ghim lai / bo ghim lai khi retry la idempotent, khong tao dong trung.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { parseTimeUuid, parseTimestamp, iso } = require('../utils/types');
const conversations = require('./conversation.service');
const realtime = require('./realtime.service');
const users = require('./user.service');

const MAX_PINS = 20;
const PREVIEW_MAX = 160;

const messages = () => require('./message.service'); // tranh vong require khi khoi dong

function canUnpin(row, user, pin) {
    if (pin.pinned_by === user.userId) return true;
    if (row.conversation_type !== 'GROUP') return true;
    return Boolean(row.created_by) && row.created_by === user.userId;
}

function previewOf(m) {
    const text = String(m.content || '').replace(/\s+/g, ' ').trim();
    if (text) return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text;
    if (m.attachments?.length) {
        const a = m.attachments[0];
        const label = a.kind === 'IMAGE' ? '[Ảnh]' : a.kind === 'VIDEO' ? '[Video]' : `[Tệp] ${a.fileName}`;
        return m.attachments.length > 1 ? `${label} +${m.attachments.length - 1} tệp` : label;
    }
    if (m.sharedPostId) return '[Bài viết được chia sẻ]';
    return '';
}

async function readPins(cid) {
    const rs = await db.execute(
        `SELECT message_id, message_created_at, pinned_by, pinned_at FROM pinned_messages_by_conversation
         WHERE conversation_id = ? LIMIT ${MAX_PINS + 5}`, [cid]);
    return rs.rows;
}

async function listPinsFor(cid, row, user) {
    const pins = await readPins(cid);
    if (pins.length === 0) return { items: [], total: 0, maxPins: MAX_PINS };
    const ms = messages();
    const msgRows = await Promise.all(pins.map(p => ms.readByFullKey(cid, p.message_created_at, p.message_id)));
    const hidden = await ms.hiddenSet(user.userId, cid, pins.map(p => p.message_id));
    const live = pins.map((p, i) => ({ p, m: msgRows[i] }))
        .filter(({ p, m }) => m && !m.is_deleted && !hidden.has(p.message_id.toString()));
    const dtos = await ms.enrich(cid, live.map(({ m }) => ms.toMessageDto(m)));
    const people = await users.getUsersByIds([...live.map(({ m }) => m.sender_id), ...live.map(({ p }) => p.pinned_by)]);
    const nameOf = (id, fallback) => people.get(id)?.displayName || fallback || 'Người dùng';
    const items = live.map(({ p, m }, i) => ({
        messageId: p.message_id.toString(),
        createdAt: iso(m.created_at),
        senderId: m.sender_id,
        senderName: nameOf(m.sender_id, m.sender_name),
        senderAvatarUrl: people.get(m.sender_id)?.avatarUrl || null,
        preview: previewOf(dtos[i]),
        messageType: m.message_type || 'TEXT',
        pinnedAt: iso(p.pinned_at),
        pinnedBy: { userId: p.pinned_by, displayName: nameOf(p.pinned_by) },
        canUnpin: canUnpin(row, user, p)
    })).sort((a, b) => new Date(b.pinnedAt) - new Date(a.pinnedAt) || (a.messageId < b.messageId ? 1 : -1));
    return { items, total: items.length, maxPins: MAX_PINS };
}

async function listPins(conversationId, user) {
    const { cid, row } = await conversations.requireMembership(conversationId, user.userId);
    return { conversationId: cid.toString(), ...(await listPinsFor(cid, row, user)) };
}

function publish(members, cid, action, messageId, actorId) {
    // Chi gui cho thanh vien; client tu tai lai danh sach qua API co kiem tra quyen.
    realtime.publish(members, 'message:pins', { conversationId: cid.toString(), action, messageId, actorId });
}

async function pinMessage(conversationId, messageId, user, body = {}) {
    const mid = parseTimeUuid(messageId);
    const createdAt = parseTimestamp(body.createdAt);
    const { cid, row, members } = await conversations.requireMembership(conversationId, user.userId);
    const msg = await messages().readByFullKey(cid, createdAt, mid);
    if (!msg) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
    if (msg.is_deleted) throw httpError(400, 'MESSAGE_RECALLED', 'Không thể ghim tin nhắn đã thu hồi.');
    if (msg.message_type === 'SYSTEM') throw httpError(400, 'SYSTEM_MESSAGE', 'Không thể ghim tin hệ thống.');
    const current = await readPins(cid);
    const already = current.some(p => p.message_id.toString() === mid.toString());
    if (!already && current.length >= MAX_PINS) {
        throw httpError(400, 'PIN_LIMIT', `Mỗi cuộc trò chuyện ghim tối đa ${MAX_PINS} tin nhắn. Hãy bỏ ghim bớt.`);
    }
    let applied = false;
    if (!already) {
        const rs = await db.execute(
            `INSERT INTO pinned_messages_by_conversation (conversation_id, message_id, message_created_at, pinned_by, pinned_at)
             VALUES (?, ?, ?, ?, ?) IF NOT EXISTS`, [cid, mid, msg.created_at, user.userId, new Date()]);
        applied = rs.wasApplied();
    }
    if (applied) publish(members, cid, 'pinned', mid.toString(), user.userId);
    return { conversationId: cid.toString(), pinned: true, alreadyPinned: !applied, ...(await listPinsFor(cid, row, user)) };
}

async function unpinMessage(conversationId, messageId, user) {
    const mid = parseTimeUuid(messageId);
    const { cid, row, members } = await conversations.requireMembership(conversationId, user.userId);
    const pin = (await db.execute(
        'SELECT message_id, pinned_by FROM pinned_messages_by_conversation WHERE conversation_id = ? AND message_id = ?',
        [cid, mid])).first();
    if (!pin) return { conversationId: cid.toString(), pinned: false, alreadyUnpinned: true, ...(await listPinsFor(cid, row, user)) };
    if (!canUnpin(row, user, pin)) {
        throw httpError(403, 'FORBIDDEN_UNPIN', 'Chỉ người đã ghim tin này hoặc trưởng nhóm mới được bỏ ghim.');
    }
    const rs = await db.execute(
        'DELETE FROM pinned_messages_by_conversation WHERE conversation_id = ? AND message_id = ? IF EXISTS', [cid, mid]);
    if (rs.wasApplied()) publish(members, cid, 'unpinned', mid.toString(), user.userId);
    return { conversationId: cid.toString(), pinned: false, ...(await listPinsFor(cid, row, user)) };
}

// Goi khi thu hoi tin: bo ghim neu dang ghim (loi o day khong chan viec thu hoi).
async function unpinRecalled(cid, mid, members) {
    try {
        const rs = await db.execute(
            'DELETE FROM pinned_messages_by_conversation WHERE conversation_id = ? AND message_id = ? IF EXISTS', [cid, mid]);
        if (rs.wasApplied()) publish(members, cid, 'unpinned', mid.toString(), null);
    } catch (error) {
        console.warn('Không bỏ ghim được tin đã thu hồi:', error.message);
    }
}

module.exports = { listPins, pinMessage, unpinMessage, unpinRecalled, MAX_PINS };
