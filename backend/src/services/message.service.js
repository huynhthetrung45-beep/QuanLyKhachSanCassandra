const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, parseUuid, parseTimeUuid, parseTimestamp, toNumber, iso } = require('../utils/types');
const { encodePageToken, decodePageToken } = require('../utils/pageToken');
const { validateLimit } = require('../utils/validate');
const { makePreview, RECALLED_PREVIEW } = require('../utils/text');
const conversations = require('./conversation.service');
const attachments = require('./attachment.service');
const reactions = require('./reaction.service');
const realtime = require('./realtime.service');

const HIDDEN_PREVIEW = 'Bạn đã xóa một tin nhắn';
const REPLY_EXCERPT_MAX = 120;

// Q2 - KHONG co LIMIT: so dong moi trang do fetchSize quyet dinh (Paging State cua driver).
const Q2 = `SELECT conversation_id, created_at, message_id, sender_id, sender_name, content, message_type,
                   is_deleted, reply_to_id, reply_to_created_at, attachment_ids, forwarded, shared_post_id
            FROM messages_by_conversation WHERE conversation_id = ?`;

const Q3 = `INSERT INTO messages_by_conversation
            (conversation_id, created_at, message_id, sender_id, sender_name, content, message_type, is_deleted,
             reply_to_id, reply_to_created_at, attachment_ids, forwarded, shared_post_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, false, ?, ?, ?, ?, ?)`;

const Q4 = `UPDATE messages_by_conversation
            SET content = null, is_deleted = true, deleted_at = ?
            WHERE conversation_id = ? AND created_at = ? AND message_id = ?`;

// Doc mot tin theo KHOA CHINH DAY DU (khong quet partition).
const FULL_KEY_READ = Q2 + ' AND created_at = ? AND message_id = ?';

// BR-09: khong bao gio tra noi dung goc, tep hay cam xuc cua tin da thu hoi.
function toMessageDto(row) {
    const deleted = Boolean(row.is_deleted);
    return {
        messageId: row.message_id.toString(),
        createdAt: iso(row.created_at),
        senderId: row.sender_id,
        senderName: row.sender_name,
        content: deleted ? null : row.content,
        messageType: row.message_type || 'TEXT',
        isDeleted: deleted,
        forwarded: Boolean(row.forwarded),
        // Chi tham chieu bai viet; noi dung bai do frontend tai qua GET /posts/:id (kiem tra quyen THEO NGUOI XEM).
        sharedPostId: !deleted && row.shared_post_id ? row.shared_post_id.toString() : null,
        replyRef: row.reply_to_id
            ? { messageId: row.reply_to_id.toString(), createdAt: iso(row.reply_to_created_at) }
            : null,
        attachmentIds: deleted ? [] : [...(row.attachment_ids || [])].map(String),
        replyTo: null,
        attachments: [],
        reactions: []
    };
}

function excerpt(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > REPLY_EXCERPT_MAX ? t.slice(0, REPLY_EXCERPT_MAX) + '…' : t;
}

async function readByFullKey(cid, createdAt, mid) {
    return (await db.execute(FULL_KEY_READ, [cid, createdAt, mid])).first();
}

// Bo sung cho mot trang tin: doan trich tin goc, tep, cam xuc. Moi truy van chi cham
// MOT partition (cung conversation_id); tin goc doc theo khoa chinh day du.
async function enrich(cid, items) {
    const visible = items.filter(m => !m.isDeleted);
    const refs = [...new Map(items.filter(m => m.replyRef).map(m => [m.replyRef.messageId, m.replyRef])).values()];
    const allAttachmentIds = [...new Set(visible.flatMap(m => m.attachmentIds))];

    const [originals, attachmentMap, reactionMap] = await Promise.all([
        Promise.all(refs.map(async ref => {
            const row = await readByFullKey(cid, new Date(ref.createdAt), TimeUuid.fromString(ref.messageId));
            return [ref.messageId, row];
        })),
        attachments.dtoMap(cid, allAttachmentIds.map(id => TimeUuid.fromString(id))),
        reactions.summaries(cid, visible.filter(m => m.messageType !== 'SYSTEM').map(m => TimeUuid.fromString(m.messageId)))
    ]);
    const originalMap = new Map(originals);

    for (const m of items) {
        if (m.replyRef) {
            const row = originalMap.get(m.replyRef.messageId);
            m.replyTo = !row
                ? { ...m.replyRef, available: false }
                : {
                    ...m.replyRef,
                    available: true,
                    senderId: row.sender_id,
                    senderName: row.sender_name,
                    isDeleted: Boolean(row.is_deleted),
                    excerpt: row.is_deleted ? null : excerpt(row.content),
                    attachmentCount: row.is_deleted ? 0 : (row.attachment_ids || []).length
                };
        }
        m.attachments = m.attachmentIds.map(id => attachmentMap.get(id)).filter(Boolean);
        m.reactions = m.isDeleted ? [] : (reactionMap.get(m.messageId) || []);
        delete m.attachmentIds;
    }
    return items;
}

async function hiddenSet(userId, cid, messageIds) {
    if (messageIds.length === 0) return new Set();
    const marks = messageIds.map(() => '?').join(', ');
    const rs = await db.execute(
        `SELECT message_id FROM hidden_messages_by_user
         WHERE user_id = ? AND conversation_id = ? AND message_id IN (${marks})`,
        [userId, cid, ...messageIds]
    );
    return new Set(rs.rows.map(r => r.message_id.toString()));
}

// UC03 / UC04: doc lich su theo trang bang Paging State cua driver.
// Tin "xoa phia toi" bi loc SAU khi doc trang -> mot trang co the it hon 20 tin hien thi,
// nhung Paging State van di dung thu tu partition (khong lech, khong trung).
async function listMessages(conversationId, user, query = {}) {
    if (query.around || query.before || query.after) return listWindow(conversationId, user, query);
    const limit = validateLimit(query.limit);
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const pageState = query.pageToken ? decodePageToken(query.pageToken, cid.toString()) : undefined;

    const startedAt = process.hrtime.bigint();
    const result = await db.execute(Q2, [cid], { fetchSize: limit, pageState });
    const queryTimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const hidden = await hiddenSet(user.userId, cid, result.rows.map(r => r.message_id));
    const items = await enrich(cid, result.rows
        .filter(r => !hidden.has(r.message_id.toString()))
        .map(toMessageDto));

    const nextPageToken = result.rows.length > 0 ? encodePageToken(cid.toString(), result.pageState) : null;
    return {
        conversationId: cid.toString(),
        items,
        count: items.length,
        rowsRead: result.rows.length,
        hiddenCount: result.rows.length - items.length,
        hasMore: nextPageToken !== null,
        nextPageToken,
        queryTimeMs: Number(queryTimeMs.toFixed(2))
    };
}

// ===== Cua so lich su quanh / truoc / sau mot tin (nhay toi ket qua tim kiem) =====
// Con tro = "<created_at ISO>_<message_id>" (khoa clustering day du, on dinh; khong dua vao noi dung).
// Chi doc MOT partition, gioi han bang clustering created_at (khong ALLOW FILTERING, khong OFFSET).
// Cac tin trung created_at (cung mili-giay) duoc tach dung bang message_id theo thu tu timeuuid.
const { compareDesc } = require('../utils/postTime');
const TIE_SLACK = 20;
const Q_OLDER = Q2 + ' AND created_at <= ? LIMIT ?';
const Q_NEWER = Q2 + ' AND created_at >= ? ORDER BY created_at ASC, message_id ASC LIMIT ?';

function parseCursor(raw, name) {
    const text = String(raw);
    const i = text.lastIndexOf('_');
    const at = i > 0 ? new Date(text.slice(0, i)) : null;
    let mid = null;
    try { mid = i > 0 ? TimeUuid.fromString(text.slice(i + 1)) : null; } catch { mid = null; }
    if (!at || Number.isNaN(at.getTime()) || !mid) throw httpError(400, 'INVALID_CURSOR', `${name} không hợp lệ.`);
    return { at, mid };
}
const cursorOf = m => `${m.createdAt}_${m.messageId}`;

// Thu tu clustering: (created_at DESC, message_id DESC). >0 neu row MOI HON moc.
function newerThan(row, c) {
    const d = row.created_at.getTime() - c.at.getTime();
    if (d !== 0) return d > 0;
    return compareDesc(row.message_id.toString(), c.mid.toString()) < 0;
}

async function readSide(cid, c, limit, side) {
    const fetch = limit + 1 + TIE_SLACK;
    const rs = await db.execute(side === 'older' ? Q_OLDER : Q_NEWER, [cid, c.at, fetch], { prepare: true });
    const rows = rs.rows.filter(r => (side === 'older' ? !newerThan(r, c) && !(r.message_id.toString() === c.mid.toString()) : newerThan(r, c)));
    const more = rows.length > limit || rs.rows.length === fetch;
    return { rows: rows.slice(0, limit), more };
}

async function visibleDtos(user, cid, rows) {
    const hidden = await hiddenSet(user.userId, cid, rows.map(r => r.message_id));
    return enrich(cid, rows.filter(r => !hidden.has(r.message_id.toString())).map(toMessageDto));
}

async function listWindow(conversationId, user, query) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const startedAt = process.hrtime.bigint();
    let older = { rows: [], more: false };
    let newer = { rows: [], more: false };
    let target = null;
    if (query.around) {
        const c = parseCursor(query.around, 'around');
        const row = await readByFullKey(cid, c.at, c.mid);
        const hidden = row ? await hiddenSet(user.userId, cid, [row.message_id]) : new Set();
        if (!row || hidden.has(row.message_id.toString())) {
            throw httpError(404, 'MESSAGE_NOT_FOUND', 'Tin nhắn không còn trong cuộc trò chuyện này.');
        }
        target = row;
        [older, newer] = await Promise.all([readSide(cid, c, 15, 'older'), readSide(cid, c, 10, 'newer')]);
    } else if (query.before) {
        older = await readSide(cid, parseCursor(query.before, 'before'), validateLimit(query.limit), 'older');
    } else {
        newer = await readSide(cid, parseCursor(query.after, 'after'), validateLimit(query.limit), 'newer');
    }
    // Tra ve moi nhat truoc, giong trang thuong.
    const rows = [...newer.rows.slice().reverse(), ...(target ? [target] : []), ...older.rows];
    const items = await visibleDtos(user, cid, rows);
    const queryTimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const oldest = items[items.length - 1];
    const newest = items[0];
    const hasOlder = query.after ? true : older.more;
    const hasNewer = query.before ? true : newer.more;
    return {
        conversationId: cid.toString(),
        items,
        count: items.length,
        rowsRead: rows.length,
        targetMessageId: target ? target.message_id.toString() : null,
        hasOlder,
        hasNewer,
        olderCursor: oldest && hasOlder ? cursorOf(oldest) : (query.after ? query.after : null),
        newerCursor: newest && hasNewer ? cursorOf(newest) : (query.before ? query.before : null),
        queryTimeMs: Number(queryTimeMs.toFixed(2))
    };
}

function attachmentPreview(rows) {
    if (rows.length === 0) return '';
    if (rows.length > 1) return `[${rows.length} tệp]`;
    const r = rows[0];
    return r.kind === 'IMAGE' ? '[Ảnh]' : r.kind === 'VIDEO' ? '[Video]' : `[Tệp] ${r.file_name}`;
}

// Ghi mot tin (Q3) va dong bo danh sach hoi thoai cua moi thanh vien.
async function insertMessage(row, members, msg) {
    // created_at lay tu chinh TimeUUID -> hai gia tri luon khop nhau (BR-06, BR-07).
    const messageId = msg.messageId || TimeUuid.now();
    const createdAt = messageId.getDate();
    const attachmentIds = msg.attachmentIds && msg.attachmentIds.length ? msg.attachmentIds : null;

    await db.execute(Q3, [
        row.conversation_id, createdAt, messageId, msg.senderId, msg.senderName, msg.content, msg.messageType,
        msg.replyTo ? msg.replyTo.mid : null, msg.replyTo ? msg.replyTo.createdAt : null,
        attachmentIds, msg.forwarded ? true : null, msg.sharedPostId || null
    ]);

    // Huong 4 (thong ke) + Huong 2 (chi muc tim kiem): ghi ngay khi gui; loi o day khong chan viec gui.
    await require('./stats.service').recordMessage(row.conversation_id, { createdAt, messageType: msg.messageType, senderId: msg.senderId });
    if (msg.messageType !== 'SYSTEM') {
        await require('./search.service').indexMessage(row.conversation_id, {
            messageId, createdAt, content: msg.content, fileNames: msg.fileNames || []
        });
    }

    await conversations.touchConversationIndex(row, members, {
        at: createdAt,
        preview: makePreview(msg.content || msg.attachmentPreview || ''),
        senderName: msg.senderName,
        senderId: msg.senderId
    });

    return { messageId, createdAt };
}

async function publishNew(cid, members, messageId, createdAt) {
    const row = await readByFullKey(cid, createdAt, messageId);
    const [message] = await enrich(cid, [toMessageDto(row)]);
    realtime.publish(members, 'message:new', { conversationId: cid.toString(), message });
    return message;
}

function validateText(content, { required }) {
    if (content === undefined || content === null || content === '') {
        if (required) throw httpError(400, 'INVALID_CONTENT', 'Nội dung tin nhắn phải có từ 1 đến 2000 ký tự.');
        return null;
    }
    if (typeof content !== 'string') throw httpError(400, 'INVALID_CONTENT', 'Nội dung tin nhắn không hợp lệ.');
    const text = content.trim();
    if (text.length === 0 && required) throw httpError(400, 'INVALID_CONTENT', 'Nội dung tin nhắn phải có từ 1 đến 2000 ký tự.');
    if (text.length > 2000) throw httpError(400, 'INVALID_CONTENT', 'Nội dung tin nhắn phải có từ 1 đến 2000 ký tự.');
    return text || null;
}

// Tin goc cua tra loi: bat buoc cung hoi thoai (doc theo khoa chinh trong partition cua CHINH hoi thoai nay),
// chua thu hoi, khong phai tin he thong.
async function resolveReplyTarget(cid, replyTo) {
    if (!replyTo) return null;
    if (typeof replyTo !== 'object') throw httpError(400, 'INVALID_REPLY', 'Thông tin trả lời không hợp lệ.');
    const mid = parseTimeUuid(replyTo.messageId, 'replyTo.messageId');
    const at = parseTimestamp(replyTo.createdAt, 'replyTo.createdAt');
    const row = await readByFullKey(cid, at, mid);
    if (!row) throw httpError(404, 'REPLY_TARGET_NOT_FOUND', 'Không tìm thấy tin nhắn được trả lời trong hội thoại này.');
    if (row.is_deleted) throw httpError(400, 'REPLY_TARGET_RECALLED', 'Không thể trả lời tin nhắn đã thu hồi.');
    if (row.message_type === 'SYSTEM') throw httpError(400, 'INVALID_REPLY', 'Không thể trả lời tin hệ thống.');
    return { mid, createdAt: row.created_at };
}

// UC05: nguoi gui LUON la nguoi da dang nhap (req.user), khong lay tu body.
// Thu tu ghi: giu cho tep (LWT) -> ghi tin -> chot tep (LWT). Loi o giua: tra lai tep.
// Chat 1-1 giua 2 nguoi co chan (1 trong 2 chieu): khong gui tin moi. Lich su cu van giu.
// Nhom chat khong bi anh huong (chinh sach).
async function assertDirectNotBlocked(row, members, userId) {
    if (row.conversation_type !== 'DIRECT') return;
    const peer = members.find(id => id !== userId);
    if (peer) await require('./social.service').assertNotBlocked(userId, peer);
}

async function sendMessage(conversationId, user, body = {}) {
    if (body.messageType !== undefined && body.messageType !== 'TEXT') {
        throw httpError(400, 'INVALID_MESSAGE_TYPE', 'Loại tin nhắn không hợp lệ.');
    }
    if (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds)) {
        throw httpError(400, 'INVALID_ATTACHMENTS', 'attachmentIds phải là danh sách.');
    }
    const hasFiles = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
    const sharing = body.sharedPostId !== undefined && body.sharedPostId !== null;
    if (sharing && hasFiles) throw httpError(400, 'INVALID_MESSAGE', 'Không thể vừa chia sẻ bài viết vừa đính kèm tệp.');
    const content = validateText(body.content, { required: !hasFiles && !sharing });
    const { row, members, cid } = await conversations.requireMembership(conversationId, user.userId);
    await assertDirectNotBlocked(row, members, user.userId);
    // Chia se bai vao chat: nguoi gui phai DANG xem duoc bai; nguoi nhan van bi kiem tra quyen khi xem.
    let sharedPostId = null;
    if (sharing) {
        const postService = require('./post.service');
        sharedPostId = postService.parseId(body.sharedPostId);
        const post = await postService.requireVisiblePost(user, sharedPostId);
        if (post.shared_post_id) sharedPostId = post.shared_post_id; // chia se cua chia se -> tro ve bai goc
    }
    const replyTo = await resolveReplyTarget(cid, body.replyTo);

    const messageId = TimeUuid.now();
    const createdAt = messageId.getDate();
    const claimed = hasFiles ? await attachments.claimForMessage(cid, user, body.attachmentIds, messageId, createdAt) : [];
    const claimedIds = claimed.map(r => r.attachment_id);

    try {
        await insertMessage(row, members, {
            messageId, senderId: user.userId, senderName: user.displayName, content,
            messageType: hasFiles ? 'ATTACHMENT' : sharing ? 'POST_SHARE' : 'TEXT', replyTo, attachmentIds: claimedIds,
            attachmentPreview: sharing ? '[Bài viết]' : attachmentPreview(claimed), sharedPostId,
            fileNames: claimed.map(r => r.file_name)
        });
    } catch (error) {
        await attachments.releaseClaims(cid, claimedIds, messageId);
        throw error;
    }
    if (claimedIds.length) await attachments.finalizeClaims(cid, claimedIds, messageId);
    if (sharedPostId) await require('./post.service').recordShare(sharedPostId, messageId, user.userId, 'CHAT').catch(() => {});
    await conversations.markReadAt(cid, user.userId, createdAt).catch(() => {});

    const message = await publishNew(cid, members, messageId, createdAt);
    await notifyMembers(cid, members, user, message);
    return { conversationId: cid.toString(), ...message, message };
}

// Chuyen tiep: kiem tra quyen o CA hai hoi thoai; ban sao noi dung + tep (metadata moi o hoi thoai dich).
async function forwardMessage(targetConversationId, user, body = {}) {
    const source = body.source || {};
    const srcCid = parseUuid(source.conversationId, 'source.conversationId');
    const mid = parseTimeUuid(source.messageId, 'source.messageId');
    const at = parseTimestamp(source.createdAt, 'source.createdAt');
    await conversations.requireMembership(srcCid.toString(), user.userId);
    const { row, members, cid } = await conversations.requireMembership(targetConversationId, user.userId);
    await assertDirectNotBlocked(row, members, user.userId);

    const original = await readByFullKey(srcCid, at, mid);
    if (!original) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn cần chuyển tiếp.');
    if (original.is_deleted) throw httpError(400, 'MESSAGE_RECALLED', 'Không thể chuyển tiếp tin đã thu hồi.');
    if (original.message_type === 'SYSTEM') throw httpError(400, 'SYSTEM_MESSAGE', 'Không thể chuyển tiếp tin hệ thống.');

    const messageId = TimeUuid.now();
    const createdAt = messageId.getDate();
    const sourceFiles = (await attachments.getRows(srcCid, [...(original.attachment_ids || [])]
        .map(id => TimeUuid.fromString(id.toString())))).filter(r => r.status === 'ATTACHED');
    const copiedIds = await attachments.copyToConversation(sourceFiles, cid, user, messageId, createdAt);

    await insertMessage(row, members, {
        messageId, senderId: user.userId, senderName: user.displayName, content: original.content || null,
        messageType: copiedIds.length ? 'ATTACHMENT' : original.shared_post_id ? 'POST_SHARE' : 'TEXT',
        attachmentIds: copiedIds, forwarded: true, sharedPostId: original.shared_post_id || null,
        fileNames: sourceFiles.map(r => r.file_name),
        attachmentPreview: original.shared_post_id ? '[Bài viết]' : attachmentPreview(sourceFiles)
    });
    await conversations.markReadAt(cid, user.userId, createdAt).catch(() => {});
    const message = await publishNew(cid, members, messageId, createdAt);
    await notifyMembers(cid, members, user, message);
    return { conversationId: cid.toString(), ...message, message };
}

// Thong bao tin nhan moi cho thanh vien khac: 1 thong bao / hoi thoai, "don len" khi chua doc.
async function notifyMembers(cid, members, user, message) {
    const notifications = require('./notification.service');
    const preview = message.content || (message.sharedPostId ? '[Bài viết]' : message.attachments?.length ? `[${message.attachments.length} tệp]` : '');
    await Promise.all(members.filter(id => id !== user.userId).map(recipientId => notifications.notifySafe({
        recipientId, actorId: user.userId, type: 'MESSAGE', dedupeKey: `MESSAGE:${cid}`, conversationId: cid,
        preview, stack: true
    })));
}

async function postSystemMessage(row, members, actor, content) {
    const { messageId, createdAt } = await insertMessage(row, members, {
        senderId: actor.userId, senderName: actor.displayName, content, messageType: 'SYSTEM'
    });
    return publishNew(row.conversation_id, members, messageId, createdAt);
}

// Cap nhat doan trich cua cac dong danh sach dang tro toi tin tai thoi diem last_message_at.
// Khong doi last_message_at -> khong doi khoa clustering, khong sinh dong moi.
async function setPreviewIfLatest(row, cid, memberIds, messageCreatedAt, preview) {
    if (!row.last_message_at || new Date(row.last_message_at).getTime() !== new Date(messageCreatedAt).getTime()) return;
    const updates = [];
    for (const memberId of memberIds) {
        for (const indexRow of await conversations.findIndexRows(memberId, cid)) {
            if (new Date(indexRow.last_message_at).getTime() !== new Date(row.last_message_at).getTime()) continue;
            updates.push({
                query: `UPDATE conversations_by_user SET last_message_preview = ?
                        WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?`,
                params: [preview, memberId, indexRow.last_message_at, cid]
            });
        }
    }
    if (updates.length > 0) await db.batch(updates);
}

// UC06: thu hoi (xoa voi moi nguoi). Doc va cap nhat theo KHOA CHINH DAY DU.
async function recallMessage(conversationId, messageId, user, query = {}) {
    const mid = parseTimeUuid(messageId);
    const createdAt = parseTimestamp(query.createdAt);
    const { cid, row, members } = await conversations.requireMembership(conversationId, user.userId);

    const message = await readByFullKey(cid, createdAt, mid);
    if (!message) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
    if (message.sender_id !== user.userId || message.message_type === 'SYSTEM') {
        throw httpError(403, 'FORBIDDEN_DELETE', 'Bạn chỉ có thể thu hồi tin nhắn do chính mình gửi.');
    }
    if (message.is_deleted) return { messageId: mid.toString(), isDeleted: true, alreadyDeleted: true };

    const deletedAt = new Date();
    await db.execute(Q4, [deletedAt, cid, message.created_at, mid]);
    const fileIds = [...(message.attachment_ids || [])].map(id => TimeUuid.fromString(id.toString()));
    if (fileIds.length) await attachments.markRecalled(cid, fileIds, mid);
    await setPreviewIfLatest(row, cid, members, message.created_at, RECALLED_PREVIEW);
    // Tin da thu hoi khong con duoc ghim (khong de lo noi dung goc qua thanh ghim).
    await require('./pin.service').unpinRecalled(cid, mid, members);

    realtime.publish(members, 'message:deleted', {
        conversationId: cid.toString(), messageId: mid.toString(), createdAt: iso(message.created_at)
    });
    return { messageId: mid.toString(), isDeleted: true, deletedAt: deletedAt.toISOString() };
}

// Xoa phia toi: chi an voi nguoi yeu cau; khong anh huong nguoi khac, cho phep ca tin cua nguoi khac.
async function hideForMe(conversationId, messageId, user, body = {}) {
    const mid = parseTimeUuid(messageId);
    const createdAt = parseTimestamp(body.createdAt);
    const { cid, row } = await conversations.requireMembership(conversationId, user.userId);
    const message = await readByFullKey(cid, createdAt, mid);
    if (!message) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
    await db.execute(
        'INSERT INTO hidden_messages_by_user (user_id, conversation_id, message_id, hidden_at) VALUES (?, ?, ?, ?)',
        [user.userId, cid, mid, new Date()]
    );
    await setPreviewIfLatest(row, cid, [user.userId], message.created_at, HIDDEN_PREVIEW);
    realtime.publish([user.userId], 'message:hidden', { conversationId: cid.toString(), messageId: mid.toString() });
    return { messageId: mid.toString(), hidden: true };
}

// FR-14: dem so tin trong MOT partition.
async function countMessages(conversationId, user) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const startedAt = process.hrtime.bigint();
    const result = await db.execute(
        'SELECT COUNT(*) AS total FROM messages_by_conversation WHERE conversation_id = ?',
        [cid]
    );
    const queryTimeMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
        conversationId: cid.toString(),
        messageCount: toNumber(result.first().total),
        queryTimeMs: Number(queryTimeMs.toFixed(2))
    };
}

module.exports = {
    listMessages, sendMessage, forwardMessage, postSystemMessage, recallMessage, hideForMe, countMessages,
    toMessageDto, HIDDEN_PREVIEW, readByFullKey, hiddenSet, enrich
};
