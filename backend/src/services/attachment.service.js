// Tep dinh kem: noi dung tep nam trong UPLOAD_DIR (o dia), Cassandra chi luu metadata.
//
// Vong doi (cot status, MOI lenh ghi vao bang nay deu la LWT de khong tron LWT voi ghi thuong):
//   PENDING   - vua tai len, chi nguoi tai len thay; co the huy
//   ATTACHING - dang duoc gan vao mot tin (da giu cho, chong gan 1 tep vao 2 tin)
//   ATTACHED  - da thuoc mot tin; moi thanh vien hoi thoai tai duoc
//   RECALLED  - tin chua tep da bi thu hoi; khong ai tai duoc nua
// Cassandra khong co giao dich nhieu bang: thu tu ghi duoc chon sao cho loi giua chung chi
// de lai tep PENDING / ATTACHING - lenh "npm run attachments:cleanup" xu ly (mac dinh dry-run).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, parseTimeUuid, iso, toNumber } = require('../utils/types');
const { classify, sanitizeFileName } = require('../utils/fileType');
const { encodePageToken, decodePageToken } = require('../utils/pageToken');
const conversations = require('./conversation.service');

const MAX_FILE_BYTES = Number(process.env.MAX_UPLOAD_MB || 20) * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = Number(process.env.MAX_FILES_PER_MESSAGE || 5);

function uploadDir() {
    return path.resolve(process.env.UPLOAD_DIR || path.resolve(__dirname, '../../../storage/uploads'));
}

// Duong dan tuyet doi tu storage_key; chan moi duong dan thoat khoi UPLOAD_DIR.
function storagePath(storageKey) {
    if (!/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/.test(storageKey)) throw httpError(500, 'BAD_STORAGE_KEY', 'Khóa lưu trữ không hợp lệ.');
    const root = uploadDir();
    const full = path.resolve(root, ...storageKey.split('/'));
    if (!full.startsWith(root + path.sep)) throw httpError(500, 'BAD_STORAGE_KEY', 'Khóa lưu trữ không hợp lệ.');
    return full;
}

function toAttachmentDto(row) {
    return {
        attachmentId: row.attachment_id.toString(),
        fileName: row.file_name,
        mimeType: row.mime_type,
        kind: row.kind,
        size: toNumber(row.size_bytes),
        status: row.status,
        createdAt: iso(row.created_at)
    };
}

const SELECT_COLS = `attachment_id, uploader_id, message_id, message_created_at, kind, mime_type, file_name,
                     size_bytes, sha256, storage_key, status, created_at`;

async function getRow(cid, aid) {
    return (await db.execute(
        `SELECT ${SELECT_COLS} FROM attachments_by_conversation WHERE conversation_id = ? AND attachment_id = ?`,
        [cid, aid]
    )).first();
}

async function getRows(cid, aids) {
    if (aids.length === 0) return [];
    const marks = aids.map(() => '?').join(', ');
    return (await db.execute(
        `SELECT ${SELECT_COLS} FROM attachments_by_conversation WHERE conversation_id = ? AND attachment_id IN (${marks})`,
        [cid, ...aids]
    )).rows;
}

// ===== Tai len =====
async function upload(conversationId, user, { buffer, fileName }) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw httpError(400, 'EMPTY_FILE', 'Tệp rỗng hoặc không đọc được.');
    }
    if (buffer.length > MAX_FILE_BYTES) {
        throw httpError(413, 'FILE_TOO_LARGE', `Tệp vượt quá ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`);
    }
    const name = sanitizeFileName(fileName);
    const type = classify(name, buffer);
    if (!type.ok) {
        throw httpError(415, type.code, type.code === 'FILE_TYPE_NOT_ALLOWED'
            ? 'Định dạng tệp không được hỗ trợ. Cho phép: JPG, PNG, WEBP, GIF, MP4, PDF, DOCX, XLSX, TXT, ZIP.'
            : 'Nội dung tệp không khớp với phần mở rộng.');
    }

    const attachmentId = TimeUuid.now();
    const now = attachmentId.getDate();
    // Ten luu tru do server sinh (UUID), khong lien quan ten do client gui -> khong the path traversal.
    const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${attachmentId.toString()}`;
    const full = storagePath(storageKey);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    const tmp = full + '.part';
    await fs.promises.writeFile(tmp, buffer, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(tmp, full);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    try {
        const rs = await db.execute(
            `INSERT INTO attachments_by_conversation (conversation_id, attachment_id, uploader_id, kind, mime_type,
                file_name, size_bytes, sha256, storage_key, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?) IF NOT EXISTS`,
            [cid, attachmentId, user.userId, type.kind, type.mime, name, buffer.length, sha256, storageKey, now]
        );
        if (!rs.wasApplied()) throw new Error('attachment id collision');
    } catch (error) {
        await fs.promises.unlink(full).catch(() => {});
        throw error;
    }

    return {
        attachmentId: attachmentId.toString(), fileName: name, mimeType: type.mime, kind: type.kind,
        size: buffer.length, status: 'PENDING', createdAt: now.toISOString()
    };
}

// Huy tep chua gui (chi nguoi tai len, chi khi con PENDING).
async function cancelPending(conversationId, attachmentId, user) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const aid = parseTimeUuid(attachmentId, 'attachmentId');
    const row = await getRow(cid, aid);
    if (!row || row.uploader_id !== user.userId) throw httpError(404, 'ATTACHMENT_NOT_FOUND', 'Không tìm thấy tệp.');
    const rs = await db.execute(
        `DELETE FROM attachments_by_conversation WHERE conversation_id = ? AND attachment_id = ?
         IF status = 'PENDING' AND uploader_id = ?`,
        [cid, aid, user.userId]
    );
    if (!rs.wasApplied()) throw httpError(409, 'ATTACHMENT_IN_USE', 'Tệp đã được gửi, không thể hủy.');
    await fs.promises.unlink(storagePath(row.storage_key)).catch(() => {});
    return { attachmentId: aid.toString(), cancelled: true };
}

// ===== Gan tep vao tin (goi tu message.service) =====
// Giu cho bang LWT PENDING -> ATTACHING. Neu mot tep that bai thi tra lai cac tep da giu.
async function claimForMessage(cid, user, attachmentIds, messageId, createdAt) {
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];
    const unique = [...new Set(attachmentIds.map(String))];
    if (unique.length > MAX_FILES_PER_MESSAGE) {
        throw httpError(400, 'TOO_MANY_FILES', `Mỗi tin nhắn tối đa ${MAX_FILES_PER_MESSAGE} tệp.`);
    }
    const aids = unique.map(id => parseTimeUuid(id, 'attachmentId'));
    const claimed = [];
    try {
        for (const aid of aids) {
            const rs = await db.execute(
                `UPDATE attachments_by_conversation SET status = 'ATTACHING', message_id = ?, message_created_at = ?
                 WHERE conversation_id = ? AND attachment_id = ? IF status = 'PENDING' AND uploader_id = ?`,
                [messageId, createdAt, cid, aid, user.userId]
            );
            if (!rs.wasApplied()) {
                throw httpError(409, 'ATTACHMENT_UNAVAILABLE', 'Tệp không tồn tại, không thuộc bạn hoặc đã được gửi.');
            }
            claimed.push(aid);
        }
    } catch (error) {
        await releaseClaims(cid, claimed, messageId);
        throw error;
    }
    const rows = await getRows(cid, aids);
    const byId = new Map(rows.map(r => [r.attachment_id.toString(), r]));
    return aids.map(aid => byId.get(aid.toString())).filter(Boolean);
}

async function releaseClaims(cid, aids, messageId) {
    for (const aid of aids) {
        await db.execute(
            `UPDATE attachments_by_conversation SET status = 'PENDING', message_id = null, message_created_at = null
             WHERE conversation_id = ? AND attachment_id = ? IF status = 'ATTACHING' AND message_id = ?`,
            [cid, aid, messageId]
        ).catch(() => {});
    }
}

async function finalizeClaims(cid, aids, messageId) {
    for (const aid of aids) {
        await db.execute(
            `UPDATE attachments_by_conversation SET status = 'ATTACHED'
             WHERE conversation_id = ? AND attachment_id = ? IF status = 'ATTACHING' AND message_id = ?`,
            [cid, aid, messageId]
        );
    }
}

// Chuyen tiep: tao ban ghi metadata MOI trong hoi thoai dich, dung chung tep da luu.
// Quyen tai xuong vi vay luon kiem tra theo hoi thoai dich.
async function copyToConversation(sourceRows, targetCid, user, messageId, createdAt) {
    const ids = [];
    for (const row of sourceRows) {
        const aid = TimeUuid.now();
        const rs = await db.execute(
            `INSERT INTO attachments_by_conversation (conversation_id, attachment_id, uploader_id, message_id,
                message_created_at, kind, mime_type, file_name, size_bytes, sha256, storage_key, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ATTACHED', ?) IF NOT EXISTS`,
            [targetCid, aid, user.userId, messageId, createdAt, row.kind, row.mime_type, row.file_name,
                row.size_bytes, row.sha256, row.storage_key, createdAt]
        );
        if (rs.wasApplied()) ids.push(aid);
    }
    return ids;
}

async function markRecalled(cid, aids, messageId) {
    for (const aid of aids) {
        await db.execute(
            `UPDATE attachments_by_conversation SET status = 'RECALLED'
             WHERE conversation_id = ? AND attachment_id = ? IF status = 'ATTACHED' AND message_id = ?`,
            [cid, aid, messageId]
        ).catch(() => {});
    }
}

// DTO tep cho mot trang tin: chi tep ATTACHED, giu thu tu trong tin.
async function dtoMap(cid, aids) {
    const rows = await getRows(cid, aids);
    const map = new Map();
    rows.filter(r => r.status === 'ATTACHED').forEach(r => map.set(r.attachment_id.toString(), toAttachmentDto(r)));
    return map;
}

// ===== Tai xuong =====
async function openForDownload(conversationId, attachmentId, user) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const aid = parseTimeUuid(attachmentId, 'attachmentId');
    const row = await getRow(cid, aid);
    const ownPending = row && ['PENDING', 'ATTACHING'].includes(row.status) && row.uploader_id === user.userId;
    if (!row || !(row.status === 'ATTACHED' || ownPending)) {
        throw httpError(404, 'ATTACHMENT_NOT_FOUND', 'Không tìm thấy tệp hoặc tệp đã bị thu hồi.');
    }
    const full = storagePath(row.storage_key);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat) throw httpError(410, 'ATTACHMENT_GONE', 'Tệp không còn trên máy chủ lưu trữ.');
    return { row, full, size: stat.size };
}

// Tab anh / tep: phan trang partition attachment (moi nhat truoc), loc o ung dung.
async function list(conversationId, user, query = {}) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const kinds = query.kind === 'media' ? ['IMAGE', 'VIDEO'] : query.kind === 'file' ? ['FILE'] : ['IMAGE', 'VIDEO', 'FILE'];
    const pageState = query.pageToken ? decodePageToken(query.pageToken, cid.toString()) : undefined;
    const rs = await db.execute(
        `SELECT ${SELECT_COLS} FROM attachments_by_conversation WHERE conversation_id = ?`,
        [cid], { fetchSize: 30, pageState }
    );
    const items = rs.rows.filter(r => r.status === 'ATTACHED' && kinds.includes(r.kind)).map(r => ({
        ...toAttachmentDto(r),
        messageId: r.message_id ? r.message_id.toString() : null,
        messageCreatedAt: iso(r.message_created_at)
    }));
    const nextPageToken = rs.rows.length > 0 ? encodePageToken(cid.toString(), rs.pageState) : null;
    return { conversationId: cid.toString(), items, nextPageToken, hasMore: nextPageToken !== null };
}

module.exports = {
    upload, cancelPending, claimForMessage, releaseClaims, finalizeClaims, copyToConversation, markRecalled,
    dtoMap, getRows, openForDownload, list, storagePath, uploadDir, toAttachmentDto,
    MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE
};
