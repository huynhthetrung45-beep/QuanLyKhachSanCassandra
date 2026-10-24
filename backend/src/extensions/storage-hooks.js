// NFR-15: gan S3/MinIO vao luong tai len / tai xuong CO SAN ma khong sua attachment.service.js, post.service.js.
// Boc cac ham xuat khau (route cu goi qua doi tuong module nen nhan ban boc):
//   upload / uploadMedia     : sau khi luu o dia -> day len S3; that bai -> huy tep vua tai, tra 503.
//   cancelPending/cancelMedia: xoa ca object tren S3.
//   openForDownload/openMedia/openPendingMedia: tep chua co trong bo dem -> tai tu S3 truoc khi gui.
// STORAGE_DRIVER=disk (mac dinh): khong boc gi, hanh vi giu nguyen 100%.
const path = require('path');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { parseUuid, parseTimeUuid, TimeUuid } = require('../utils/types');
const blob = require('./lib/blobstore');

const unavailable = error => {
    console.warn('[lưu trữ] Lỗi S3:', error.message);
    return httpError(503, 'STORAGE_UNAVAILABLE', 'Máy chủ lưu trữ tệp tạm thời không khả dụng, vui lòng thử lại.');
};

function wrapAttachments() {
    const attachments = require('../services/attachment.service');
    if (attachments.__s3) return;
    const orig = { upload: attachments.upload, cancelPending: attachments.cancelPending, openForDownload: attachments.openForDownload };
    const keyOf = async (conversationId, attachmentId) => {
        const rows = await attachments.getRows(parseUuid(String(conversationId).toLowerCase()), [parseTimeUuid(String(attachmentId), 'attachmentId')]);
        return rows[0] ? rows[0].storage_key : null;
    };

    attachments.upload = async (conversationId, user, input) => {
        const result = await orig.upload(conversationId, user, input);
        const key = await keyOf(conversationId, result.attachmentId);
        try {
            await blob.pushFile(attachments.storagePath(key), result.mimeType);
        } catch (error) {
            await orig.cancelPending(conversationId, result.attachmentId, user).catch(() => {});
            throw unavailable(error);
        }
        return result;
    };
    attachments.cancelPending = async (conversationId, attachmentId, user) => {
        const key = await keyOf(conversationId, attachmentId).catch(() => null);
        const result = await orig.cancelPending(conversationId, attachmentId, user);
        if (key) await blob.removeFile(attachments.storagePath(key));
        return result;
    };
    attachments.openForDownload = async (conversationId, attachmentId, user) => {
        try {
            return await orig.openForDownload(conversationId, attachmentId, user);
        } catch (error) {
            if (error.code !== 'ATTACHMENT_GONE') throw error;
            const key = await keyOf(conversationId, attachmentId);
            const ok = await blob.ensureLocal(attachments.storagePath(key)).catch(e => { throw unavailable(e); });
            if (!ok) throw error;
            return orig.openForDownload(conversationId, attachmentId, user);
        }
    };
    attachments.__s3 = true;
}

function wrapPosts() {
    const posts = require('../services/post.service');
    if (posts.__s3) return;
    const orig = { uploadMedia: posts.uploadMedia, cancelMedia: posts.cancelMedia, openMedia: posts.openMedia, openPendingMedia: posts.openPendingMedia };
    const fileOf = async mediaId => {
        const row = (await db.execute('SELECT storage_key FROM post_media WHERE media_id = ?', [TimeUuid.fromString(String(mediaId))])).first();
        return row ? path.join(posts.mediaRoot(), ...row.storage_key.split('/')) : null;
    };

    posts.uploadMedia = async (user, input) => {
        const result = await orig.uploadMedia(user, input);
        try {
            await blob.pushFile(await fileOf(result.mediaId), result.mimeType);
        } catch (error) {
            await orig.cancelMedia(user, result.mediaId).catch(() => {});
            throw unavailable(error);
        }
        return result;
    };
    posts.cancelMedia = async (user, mediaId) => {
        const file = await fileOf(mediaId).catch(() => null);
        const result = await orig.cancelMedia(user, mediaId);
        if (file) await blob.removeFile(file);
        return result;
    };
    posts.openMedia = async (viewer, postId, mediaId) => {
        try {
            return await orig.openMedia(viewer, postId, mediaId);
        } catch (error) {
            if (error.code !== 'MEDIA_GONE') throw error;
            const ok = await blob.ensureLocal(await fileOf(mediaId)).catch(e => { throw unavailable(e); });
            if (!ok) throw error;
            return orig.openMedia(viewer, postId, mediaId);
        }
    };
    posts.openPendingMedia = async (user, mediaId) => {
        const result = await orig.openPendingMedia(user, mediaId);
        await blob.ensureLocal(result.full).catch(e => { throw unavailable(e); });
        return result;
    };
    posts.__s3 = true;
}

function installStorageHooks() {
    if (!blob.enabled()) return false;
    const info = blob.describe();
    if (info.missing.length) throw new Error(`[lưu trữ] STORAGE_DRIVER=s3 nhưng thiếu: ${info.missing.join(', ')}`);
    wrapAttachments();
    wrapPosts();
    console.log(`[lưu trữ] Tệp lưu trên S3/MinIO: ${info.endpoint} bucket ${info.bucket} (tiền tố ${info.prefix}). UPLOAD_DIR chỉ là bộ đệm.`);
    return true;
}

module.exports = { installStorageHooks, wrapAttachments, wrapPosts };
