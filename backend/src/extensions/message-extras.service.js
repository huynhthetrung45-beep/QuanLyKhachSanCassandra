// Tin nhan mo rong: PT-06 sua tin, PT-12 tin thoai, PT-13 @mention, PT-20 binh chon,
// PT-21 sticker + xem truoc lien ket.
//
// Bang messages_by_conversation va message.service GIU NGUYEN:
//  - Tin moi (binh chon, sticker, tin thoai) duoc gui qua messageService.sendMessage co san
//    (noi dung van ban thay the de client cu van doc duoc), sau do gan "extra" o bang
//    message_meta_by_conversation va phat su kien 'message:extra'.
//  - Danh sach tin (GET .../messages) duoc bo sung truong `extra` bang decorateJson.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, parseTimeUuid, parseTimestamp, iso } = require('../utils/types');
const { makePreview } = require('../utils/text');
const { termsOf } = require('../utils/searchTerms');
const conversations = require('../services/conversation.service');
const messageService = require('../services/message.service');
const attachments = require('../services/attachment.service');
const search = require('../services/search.service');
const realtime = require('../services/realtime.service');
const userService = require('../services/user.service');
const linkPreview = require('./lib/linkPreview');

const notifications = () => require('../services/notification.service');

const EDIT_WINDOW_MS = Number(process.env.EDIT_WINDOW_MINUTES || 15) * 60 * 1000;
const META_COLS = `message_id, kind, edited_at, edit_count, poll_id, sticker_id, voice_ms, mention_ids,
                   link_url, link_title, link_description, link_image, link_site`;

// Bo sticker co san (khong tai tu Internet). Client ve sticker tu id.
const STICKERS = [
    { id: 'hello', emoji: '👋', label: 'Xin chào' }, { id: 'love', emoji: '😍', label: 'Yêu quá' },
    { id: 'haha', emoji: '🤣', label: 'Haha' }, { id: 'ok', emoji: '👌', label: 'OK nhé' },
    { id: 'thanks', emoji: '🙏', label: 'Cảm ơn' }, { id: 'party', emoji: '🥳', label: 'Tuyệt vời' },
    { id: 'sad', emoji: '😢', label: 'Buồn quá' }, { id: 'angry', emoji: '😤', label: 'Hừm' },
    { id: 'think', emoji: '🤔', label: 'Để xem' }, { id: 'sleep', emoji: '😴', label: 'Buồn ngủ' },
    { id: 'coffee', emoji: '☕', label: 'Cà phê không?' }, { id: 'fire', emoji: '🔥', label: 'Cháy quá' },
    { id: 'cat', emoji: '😺', label: 'Meo' }, { id: 'dog', emoji: '🐶', label: 'Gâu' },
    { id: 'clap', emoji: '👏', label: 'Hoan hô' }, { id: 'deadline', emoji: '⏰', label: 'Deadline!' }
];
const stickerById = id => STICKERS.find(s => s.id === id) || null;

// ===== Doc / ghi meta =====
async function readMeta(cid, messageIds) {
    if (messageIds.length === 0) return new Map();
    const marks = messageIds.map(() => '?').join(', ');
    const rs = await db.execute(
        `SELECT ${META_COLS} FROM message_meta_by_conversation WHERE conversation_id = ? AND message_id IN (${marks})`,
        [cid, ...messageIds]);
    return new Map(rs.rows.map(r => [r.message_id.toString(), r]));
}

async function pollDto(cid, pollId, viewerId) {
    const poll = (await db.execute(
        'SELECT poll_id, question, options, multiple, created_by, closed, message_id, message_created_at FROM polls_by_conversation WHERE conversation_id = ? AND poll_id = ?',
        [cid, pollId])).first();
    if (!poll) return null;
    const votes = (await db.execute('SELECT user_id, choices FROM poll_votes WHERE poll_id = ?', [pollId], { fetchSize: 1000 })).rows;
    const options = [...(poll.options || [])];
    const counts = options.map(() => ({ count: 0, voters: [] }));
    let mine = [];
    for (const v of votes) {
        const choices = [...(v.choices || [])].map(Number).filter(i => i >= 0 && i < options.length);
        choices.forEach(i => { counts[i].count += 1; if (counts[i].voters.length < 20) counts[i].voters.push(v.user_id); });
        if (v.user_id === viewerId) mine = choices;
    }
    return {
        pollId: poll.poll_id.toString(),
        question: poll.question,
        multiple: Boolean(poll.multiple),
        closed: Boolean(poll.closed),
        createdBy: poll.created_by,
        totalVoters: votes.filter(v => (v.choices || []).length > 0).length,
        options: options.map((text, i) => ({ index: i, text, count: counts[i].count, voters: counts[i].voters })),
        myChoices: mine,
        messageId: poll.message_id ? poll.message_id.toString() : null
    };
}

async function extraDto(cid, meta, viewerId) {
    if (!meta) return null;
    const extra = {
        kind: meta.kind || null,
        editedAt: iso(meta.edited_at),
        editCount: meta.edit_count || 0,
        mentions: [...(meta.mention_ids || [])].map(String),
        voiceMs: meta.voice_ms || null,
        sticker: meta.sticker_id ? stickerById(meta.sticker_id) : null,
        link: meta.link_url ? {
            url: meta.link_url, title: meta.link_title || null, description: meta.link_description || null,
            image: meta.link_image || null, site: meta.link_site || null
        } : null,
        poll: null
    };
    if (meta.poll_id) extra.poll = await pollDto(cid, meta.poll_id, viewerId);
    return extra;
}

// decorateJson cho GET .../messages: gan `extra` cho tin co meta (1 truy van IN trong 1 partition).
async function decorateMessagePage(body, req) {
    if (!body || !Array.isArray(body.items) || body.items.length === 0 || !body.conversationId) return body;
    const { cid } = await conversations.requireMembership(body.conversationId, req.user.userId);
    const ids = body.items.map(m => TimeUuid.fromString(m.messageId));
    const metas = await readMeta(cid, ids);
    for (const m of body.items) {
        const meta = metas.get(m.messageId);
        if (meta && !m.isDeleted) m.extra = await extraDto(cid, meta, req.user.userId);
    }
    return body;
}

async function publishExtra(cid, members, messageId, viewerId = null) {
    const meta = (await readMeta(cid, [messageId])).get(messageId.toString());
    const extra = await extraDto(cid, meta, viewerId);
    realtime.publish(members, 'message:extra', { conversationId: cid.toString(), messageId: messageId.toString(), extra });
    return extra;
}

// ===== PT-06: sua tin =====
async function editMessage(conversationId, messageId, user, body = {}) {
    const mid = parseTimeUuid(messageId);
    const createdAt = parseTimestamp(body.createdAt);
    const text = typeof body.content === 'string' ? body.content.trim() : '';
    if (text.length < 1 || text.length > 2000) throw httpError(400, 'INVALID_CONTENT', 'Nội dung tin nhắn phải có từ 1 đến 2000 ký tự.');
    const { cid, row, members } = await conversations.requireMembership(conversationId, user.userId);
    const msg = await messageService.readByFullKey(cid, createdAt, mid);
    if (!msg) throw httpError(404, 'MESSAGE_NOT_FOUND', 'Không tìm thấy tin nhắn.');
    if (msg.sender_id !== user.userId || msg.message_type === 'SYSTEM') throw httpError(403, 'FORBIDDEN_EDIT', 'Bạn chỉ có thể sửa tin nhắn do chính mình gửi.');
    if (msg.is_deleted) throw httpError(400, 'MESSAGE_RECALLED', 'Không thể sửa tin đã thu hồi.');
    if (Date.now() - new Date(msg.created_at).getTime() > EDIT_WINDOW_MS) {
        throw httpError(400, 'EDIT_WINDOW_PASSED', `Chỉ sửa được trong ${Math.round(EDIT_WINDOW_MS / 60000)} phút sau khi gửi.`);
    }
    const meta = (await readMeta(cid, [mid])).get(mid.toString());
    if (meta && ['POLL', 'STICKER', 'VOICE'].includes(meta.kind)) throw httpError(400, 'NOT_EDITABLE', 'Loại tin nhắn này không sửa được.');
    if ((msg.content || '') === text) return { messageId: mid.toString(), content: text, changed: false };

    const now = new Date();
    await db.execute(
        'INSERT INTO message_edits_by_message (conversation_id, message_id, edited_at, previous_content, editor_id) VALUES (?, ?, ?, ?, ?)',
        [cid, mid, now, msg.content || '', user.userId]);
    await db.execute('UPDATE messages_by_conversation SET content = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?',
        [text, cid, msg.created_at, mid]);
    await db.execute('UPDATE message_meta_by_conversation SET edited_at = ?, edit_count = ? WHERE conversation_id = ? AND message_id = ?',
        [now, ((meta && meta.edit_count) || 0) + 1, cid, mid]);

    // Chi muc tim kiem: bo tu cu khong con (tru ten tep), them tu moi.
    const files = await attachments.getRows(cid, [...(msg.attachment_ids || [])].map(id => TimeUuid.fromString(id.toString())));
    const keep = new Set(termsOf(text, ...files.map(f => f.file_name)));
    await Promise.all(termsOf(msg.content).filter(t => !keep.has(t)).map(term => db.execute(
        'DELETE FROM message_terms_by_conversation WHERE conversation_id = ? AND term = ? AND created_at = ? AND message_id = ?',
        [cid, term, msg.created_at, mid]))).catch(() => {});
    await search.indexMessage(cid, { messageId: mid, createdAt: msg.created_at, content: text, fileNames: files.map(f => f.file_name) });

    // Doan trich danh sach hoi thoai (neu la tin moi nhat).
    if (row.last_message_at && new Date(row.last_message_at).getTime() === new Date(msg.created_at).getTime()) {
        const updates = [];
        for (const memberId of members) {
            for (const idx of await conversations.findIndexRows(memberId, cid)) {
                if (new Date(idx.last_message_at).getTime() !== new Date(row.last_message_at).getTime()) continue;
                updates.push({
                    query: 'UPDATE conversations_by_user SET last_message_preview = ? WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
                    params: [makePreview(text), memberId, idx.last_message_at, cid]
                });
            }
        }
        if (updates.length) await db.batch(updates);
        realtime.publish(members, 'conversation:updated', { conversationId: cid.toString() });
    }
    const extra = await extraDto(cid, (await readMeta(cid, [mid])).get(mid.toString()), user.userId);
    realtime.publish(members, 'message:edited', { conversationId: cid.toString(), messageId: mid.toString(), content: text, extra });
    return { messageId: mid.toString(), createdAt: iso(msg.created_at), content: text, extra, changed: true };
}

async function editHistory(conversationId, messageId, user) {
    const mid = parseTimeUuid(messageId);
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const rs = await db.execute('SELECT edited_at, previous_content, editor_id FROM message_edits_by_message WHERE conversation_id = ? AND message_id = ? LIMIT 50', [cid, mid]);
    return { items: rs.rows.map(r => ({ editedAt: iso(r.edited_at), previousContent: r.previous_content, editorId: r.editor_id })) };
}

// ===== PT-13 @mention + PT-21 xem truoc lien ket (sau khi gui tin bang route cu) =====
async function afterSend(body, req) {
    const msg = body && (body.message || body);
    if (!msg || !msg.messageId) return;
    const { cid: convId, members } = await conversations.requireMembership(body.conversationId || req.params.conversationId, req.user.userId);
    const mid = TimeUuid.fromString(msg.messageId);
    let changed = false;

    const raw = Array.isArray(req.body && req.body.mentions) ? req.body.mentions : [];
    const mentioned = [...new Set(raw.map(String))].filter(id => id !== req.user.userId && members.includes(id)).slice(0, 20);
    if (mentioned.length) {
        await db.execute('UPDATE message_meta_by_conversation SET mention_ids = mention_ids + ? WHERE conversation_id = ? AND message_id = ?',
            [mentioned, convId, mid]);
        const createdAt = new Date(msg.createdAt);
        const preview = makePreview(msg.content || '');
        for (const target of mentioned) {
            await db.execute(
                'INSERT INTO mentions_by_user (user_id, created_at, message_id, conversation_id, actor_id, preview) VALUES (?, ?, ?, ?, ?, ?)',
                [target, createdAt, mid, convId, req.user.userId, preview]);
            await notifications().notifySafe({
                recipientId: target, actorId: req.user.userId, type: 'MENTION', dedupeKey: `MENTION:${mid}:${target}`,
                conversationId: convId, preview
            });
        }
        changed = true;
    }

    const url = linkPreview.enabled() ? linkPreview.firstUrl(msg.content) : null;
    if (url) {
        const p = await linkPreview.fetchPreview(url);
        if (p) {
            await db.execute(
                'UPDATE message_meta_by_conversation SET link_url = ?, link_title = ?, link_description = ?, link_image = ?, link_site = ? WHERE conversation_id = ? AND message_id = ?',
                [p.url.slice(0, 1000), p.title, p.description, p.image, p.site, convId, mid]);
            changed = true;
        }
    }
    if (changed) await publishExtra(convId, members, mid);
}

async function listMentions(user) {
    const rs = await db.execute('SELECT created_at, message_id, conversation_id, actor_id, preview FROM mentions_by_user WHERE user_id = ? LIMIT 50', [user.userId]);
    const profiles = await userService.getUsersByIds(rs.rows.map(r => r.actor_id));
    return {
        items: rs.rows.map(r => ({
            messageId: r.message_id.toString(), createdAt: iso(r.created_at), conversationId: r.conversation_id.toString(),
            actor: { userId: r.actor_id, displayName: profiles.get(r.actor_id)?.displayName || r.actor_id }, preview: r.preview
        }))
    };
}

// ===== Gui tin dac biet qua route cu =====
async function sendSpecial(conversationId, user, content, metaFields, extraBody = {}) {
    const result = await messageService.sendMessage(conversationId, user, { content, ...extraBody });
    const { cid, members } = await conversations.requireMembership(conversationId, user.userId);
    const mid = TimeUuid.fromString(result.messageId);
    const cols = Object.keys(metaFields);
    await db.execute(
        `UPDATE message_meta_by_conversation SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE conversation_id = ? AND message_id = ?`,
        [...cols.map(c => metaFields[c]), cid, mid]);
    const extra = await publishExtra(cid, members, mid, user.userId);
    return { ...result.message, extra, conversationId: cid.toString() };
}

// PT-21: sticker
async function sendSticker(conversationId, user, body = {}) {
    const sticker = stickerById(String(body.stickerId || ''));
    if (!sticker) throw httpError(400, 'INVALID_STICKER', 'Sticker không tồn tại.');
    return sendSpecial(conversationId, user, `${sticker.emoji} [Sticker: ${sticker.label}]`, { kind: 'STICKER', sticker_id: sticker.id });
}

// PT-20: binh chon (chi trong nhom)
async function createPoll(conversationId, user, body = {}) {
    const { row } = await conversations.requireMembership(conversationId, user.userId);
    if (row.conversation_type !== 'GROUP') throw httpError(400, 'NOT_A_GROUP', 'Bình chọn chỉ dùng trong nhóm chat.');
    const question = typeof body.question === 'string' ? body.question.trim().replace(/\s+/g, ' ') : '';
    if (question.length < 1 || question.length > 200) throw httpError(400, 'INVALID_POLL', 'Câu hỏi cần từ 1 đến 200 ký tự.');
    const options = (Array.isArray(body.options) ? body.options : []).map(o => String(o || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
    if (options.length < 2 || options.length > 10) throw httpError(400, 'INVALID_POLL', 'Bình chọn cần từ 2 đến 10 lựa chọn.');
    if (options.some(o => o.length > 100)) throw httpError(400, 'INVALID_POLL', 'Mỗi lựa chọn tối đa 100 ký tự.');
    if (new Set(options.map(o => o.toLowerCase())).size !== options.length) throw httpError(400, 'INVALID_POLL', 'Các lựa chọn không được trùng nhau.');
    const pollId = TimeUuid.now();
    const result = await messageService.sendMessage(conversationId, user, { content: `📊 Bình chọn: ${question}` });
    const cid = row.conversation_id;
    const mid = TimeUuid.fromString(result.messageId);
    await db.execute(
        `INSERT INTO polls_by_conversation (conversation_id, poll_id, question, options, multiple, created_by, message_id, message_created_at, closed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, false)`,
        [cid, pollId, question, options, Boolean(body.multiple), user.userId, mid, new Date(result.createdAt)]);
    await db.execute('UPDATE message_meta_by_conversation SET kind = ?, poll_id = ? WHERE conversation_id = ? AND message_id = ?', ['POLL', pollId, cid, mid]);
    const { members } = await conversations.requireMembership(conversationId, user.userId);
    const extra = await publishExtra(cid, members, mid, user.userId);
    return { ...result.message, extra, conversationId: cid.toString() };
}

async function requirePoll(conversationId, pollId, user) {
    const ctx = await conversations.requireMembership(conversationId, user.userId);
    const pid = parseTimeUuid(pollId, 'pollId');
    const poll = (await db.execute('SELECT poll_id, options, multiple, closed, created_by, message_id FROM polls_by_conversation WHERE conversation_id = ? AND poll_id = ?',
        [ctx.cid, pid])).first();
    if (!poll) throw httpError(404, 'POLL_NOT_FOUND', 'Không tìm thấy bình chọn.');
    return { ...ctx, pid, poll };
}

async function publishPoll(ctx) {
    const poll = await pollDto(ctx.cid, ctx.pid, null);
    realtime.publish(ctx.members, 'poll:updated', {
        conversationId: ctx.cid.toString(), messageId: ctx.poll.message_id ? ctx.poll.message_id.toString() : null, pollId: ctx.pid.toString()
    });
    return poll;
}

async function vote(conversationId, pollId, user, body = {}) {
    const ctx = await requirePoll(conversationId, pollId, user);
    if (ctx.poll.closed) throw httpError(400, 'POLL_CLOSED', 'Bình chọn đã kết thúc.');
    const n = (ctx.poll.options || []).length;
    const choices = [...new Set((Array.isArray(body.choices) ? body.choices : []).map(Number))];
    if (choices.some(i => !Number.isInteger(i) || i < 0 || i >= n)) throw httpError(400, 'INVALID_CHOICE', 'Lựa chọn không hợp lệ.');
    if (!ctx.poll.multiple && choices.length > 1) throw httpError(400, 'INVALID_CHOICE', 'Bình chọn này chỉ được chọn một phương án.');
    if (choices.length === 0) await db.execute('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', [ctx.pid, user.userId]);
    else await db.execute('INSERT INTO poll_votes (poll_id, user_id, choices, voted_at) VALUES (?, ?, ?, ?)', [ctx.pid, user.userId, choices, new Date()]);
    await publishPoll(ctx);
    return pollDto(ctx.cid, ctx.pid, user.userId);
}

async function getPoll(conversationId, pollId, user) {
    const ctx = await requirePoll(conversationId, pollId, user);
    return pollDto(ctx.cid, ctx.pid, user.userId);
}

async function closePoll(conversationId, pollId, user) {
    const ctx = await requirePoll(conversationId, pollId, user);
    const isOwner = ctx.row.created_by && ctx.row.created_by === user.userId;
    if (ctx.poll.created_by !== user.userId && !isOwner) throw httpError(403, 'FORBIDDEN', 'Chỉ người tạo hoặc trưởng nhóm được kết thúc bình chọn.');
    await db.execute('UPDATE polls_by_conversation SET closed = true WHERE conversation_id = ? AND poll_id = ?', [ctx.cid, ctx.pid]);
    await publishPoll(ctx);
    return pollDto(ctx.cid, ctx.pid, user.userId);
}

// ===== PT-12: tin nhan thoai =====
const VOICE_MAX_BYTES = 3 * 1024 * 1024;
const VOICE_MAX_MS = 2 * 60 * 1000 + 3000;

function sniffAudio(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
    if (buf.subarray(0, 4).toString('latin1') === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
    if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
    return null;
}

async function sendVoice(conversationId, user, { buffer, durationMs }) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError(400, 'EMPTY_FILE', 'Bản ghi âm rỗng.');
    if (buffer.length > VOICE_MAX_BYTES) throw httpError(413, 'FILE_TOO_LARGE', 'Bản ghi âm quá lớn (tối đa khoảng 2 phút).');
    const ms = Math.round(Number(durationMs) || 0);
    if (ms <= 0 || ms > VOICE_MAX_MS) throw httpError(400, 'INVALID_DURATION', 'Tin nhắn thoại tối đa 2 phút.');
    const type = sniffAudio(buffer);
    if (!type) throw httpError(415, 'FILE_TYPE_NOT_ALLOWED', 'Định dạng ghi âm không được hỗ trợ (WEBM, OGG, M4A, WAV).');

    const aid = TimeUuid.now();
    const now = aid.getDate();
    const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${aid.toString()}`;
    const full = attachments.storagePath(storageKey);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full + '.part', buffer, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(full + '.part', full);
    const fileName = `Tin nhắn thoại ${Math.max(1, Math.round(ms / 1000))}s.${type.ext}`;
    try {
        const rs = await db.execute(
            `INSERT INTO attachments_by_conversation (conversation_id, attachment_id, uploader_id, kind, mime_type,
                file_name, size_bytes, sha256, storage_key, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?) IF NOT EXISTS`,
            [cid, aid, user.userId, 'AUDIO', type.mime, fileName, buffer.length,
                require('crypto').createHash('sha256').update(buffer).digest('hex'), storageKey, now]);
        if (!rs.wasApplied()) throw new Error('attachment id collision');
    } catch (error) {
        await fs.promises.unlink(full).catch(() => {});
        throw error;
    }
    return sendSpecial(conversationId, user, undefined, { kind: 'VOICE', voice_ms: ms }, { attachmentIds: [aid.toString()] });
}

module.exports = {
    STICKERS, decorateMessagePage, editMessage, editHistory, afterSend, listMentions,
    sendSticker, createPoll, vote, getPoll, closePoll, sendVoice, sniffAudio, readMeta, extraDto
};
