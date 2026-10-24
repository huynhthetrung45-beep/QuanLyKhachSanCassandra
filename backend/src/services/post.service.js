// Bai dang, anh, cam xuc, binh luan, chia se (Giai doan 2).
//
// Quyen xem (canView) la DIEM KIEM TRA DUY NHAT cho bai, anh, cam xuc, binh luan, chia se:
//   - bai da xoa: khong ai xem
//   - tac gia: luon xem
//   - chan (1 trong 2 chieu) giua nguoi xem va tac gia: khong xem
//   - PUBLIC: moi nguoi da dang nhap | FRIENDS: chi ban be | PRIVATE: chi tac gia
// Bai khong xem duoc tra 404 (khong tiet lo bai co ton tai).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso, toNumber } = require('../utils/types');
const { classify, sanitizeFileName } = require('../utils/fileType');
const { encodePageToken, decodePageToken } = require('../utils/pageToken');
const userService = require('./user.service');
const social = require('./social.service');
const attachmentService = require('./attachment.service');
const { compareDesc, bucketOf, previousBucket } = require('../utils/postTime');
const realtime = require('./realtime.service');
const stats = require('./stats.service');
const notifications = require('./notification.service');

// Su kien realtime KHONG chua noi dung: client dang hien bai nay tu tai lai qua GET /posts/:id (co kiem tra quyen).
// Chi gui cho nguoi CO THE xem bai: PUBLIC -> moi ket noi; FRIENDS -> tac gia + ban be; PRIVATE -> tac gia.
// (Nguoi nhan van phai qua canView khi tai lai, nen ke ca sai lech nho cung khong lo noi dung.)
function postChanged(postId, kind) {
    (async () => {
        const row = await readPost(postId);
        if (!row) return;
        const data = { postId: postId.toString(), kind };
        if (row.privacy === 'PUBLIC' && !row.is_deleted) return realtime.publishAll('post:changed', data);
        const audience = [row.author_id];
        if (row.privacy === 'FRIENDS' && !row.is_deleted) {
            audience.push(...(await social.listFriends({ userId: row.author_id })).map(f => f.userId));
        }
        if (row.is_deleted) return realtime.publishAll('post:changed', data); // bai bi xoa: moi noi dang hien deu phai go bai
        return realtime.publish(audience, 'post:changed', data);
    })().catch(error => console.warn('Không phát được cập nhật bài viết:', error.message));
}

const PRIVACY = ['PUBLIC', 'FRIENDS', 'PRIVATE'];
const REACTIONS = ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'];
const POST_MAX = 5000;
const COMMENT_MAX = 2000;
const MAX_IMAGES = 10;
const PAGE = 20;
const FEED_AUTHORS_CAP = 300;
const PUBLIC_MONTHS_BACK = 24; // so thang toi da lui lai moi lan tim bai cong khai
const MAX_IMAGE_BYTES = attachmentService.MAX_FILE_BYTES;

const POST_COLS = 'post_id, author_id, content, privacy, media_ids, shared_post_id, created_at, updated_at, is_deleted';

function parseId(value, name = 'postId') {
    try {
        const id = TimeUuid.fromString(String(value));
        return id;
    } catch {
        throw httpError(400, 'INVALID_ID', `${name} không hợp lệ.`);
    }
}

const notFound = () => httpError(404, 'POST_NOT_FOUND', 'Không tìm thấy bài viết hoặc bạn không có quyền xem.');

// ===== Luu tru anh cua bai: UPLOAD_DIR/posts/YYYY/MM/<uuid> (tach khoi tep chat) =====
function mediaRoot() {
    return path.join(attachmentService.uploadDir(), 'posts');
}
function mediaPath(storageKey) {
    if (!/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/.test(storageKey)) throw httpError(500, 'BAD_STORAGE_KEY', 'Khóa lưu trữ không hợp lệ.');
    const root = mediaRoot();
    const full = path.resolve(root, ...storageKey.split('/'));
    if (!full.startsWith(root + path.sep)) throw httpError(500, 'BAD_STORAGE_KEY', 'Khóa lưu trữ không hợp lệ.');
    return full;
}

// ===== Doc / quyen =====
async function readPost(postId) {
    return (await db.execute(`SELECT ${POST_COLS} FROM posts WHERE post_id = ?`, [postId])).first();
}

// Bo nho dem quan he trong 1 request (tranh doc lap lai cung 1 cap).
function relCache(viewerId) {
    const cache = new Map();
    return async authorId => {
        if (authorId === viewerId) return { self: true };
        if (!cache.has(authorId)) {
            cache.set(authorId, Promise.all([social.blockState(viewerId, authorId), social.relationshipStatus(viewerId, authorId)])
                .then(([block, status]) => ({ blocked: block.iBlocked || block.blockedMe, friends: status === 'FRIENDS' })));
        }
        return cache.get(authorId);
    };
}

async function canView(row, rel) {
    if (!row || row.is_deleted) return false;
    const r = await rel(row.author_id);
    if (r.self) return true;
    if (r.blocked) return false;
    if (row.privacy === 'PUBLIC') return true;
    if (row.privacy === 'FRIENDS') return r.friends;
    return false;
}

async function requireVisiblePost(viewer, postId, rel = relCache(viewer.userId)) {
    const row = await readPost(postId);
    if (!(await canView(row, rel))) throw notFound();
    return row;
}

// ===== Tong hop cam xuc / binh luan (dem tu dong that -> khong lech khi retry / dong thoi) =====
async function reactionSummary(postId, viewerId) {
    const counts = {};
    let mine = null;
    let total = 0;
    let pageState;
    do {
        const rs = await db.execute('SELECT user_id, reaction FROM post_reactions WHERE post_id = ?', [postId], { fetchSize: 500, pageState });
        for (const r of rs.rows) {
            counts[r.reaction] = (counts[r.reaction] || 0) + 1;
            total += 1;
            if (r.user_id === viewerId) mine = r.reaction;
        }
        pageState = rs.pageState;
    } while (pageState);
    return { total, counts, mine };
}

async function commentCount(postId) {
    let n = 0;
    let pageState;
    do {
        const rs = await db.execute('SELECT is_deleted FROM post_comments WHERE post_id = ?', [postId], { fetchSize: 500, pageState });
        n += rs.rows.filter(r => !r.is_deleted).length;
        pageState = rs.pageState;
    } while (pageState);
    return n;
}

async function shareCount(postId) {
    let n = 0;
    let pageState;
    do {
        const rs = await db.execute('SELECT share_id FROM post_shares WHERE post_id = ?', [postId], { fetchSize: 500, pageState });
        n += rs.rows.length;
        pageState = rs.pageState;
    } while (pageState);
    return n;
}

async function recordShare(postId, shareId, userId, kind) {
    await db.execute('INSERT INTO post_shares (post_id, share_id, user_id, kind) VALUES (?, ?, ?, ?)', [postId, shareId, userId, kind]);
    const original = await readPost(postId);
    if (original && original.author_id !== userId) {
        await stats.bumpSocial(original.author_id, 'shares_received', 1);
        await notifications.notifySafe({
            recipientId: original.author_id, actorId: userId, type: 'POST_SHARE', dedupeKey: `SHARE:${shareId}`,
            postId, preview: kind === 'CHAT' ? 'đã gửi bài viết của bạn vào một cuộc trò chuyện' : 'đã chia sẻ bài viết của bạn'
        });
    }
    postChanged(postId, 'share');
}

// Chi muc bang tin cong khai: dong cu (bai doi quyen / da xoa) vo hai vi canView kiem tra lai.
async function setPublicIndex(row, isPublic) {
    const bucket = bucketOf(row.post_id);
    if (isPublic) {
        await db.execute('INSERT INTO public_posts_by_month (bucket, post_id, author_id) VALUES (?, ?, ?)', [bucket, row.post_id, row.author_id]);
    } else {
        await db.execute('DELETE FROM public_posts_by_month WHERE bucket = ? AND post_id = ?', [bucket, row.post_id]);
    }
}

async function mediaDtos(row) {
    const ids = [...(row.media_ids || [])];
    const rows = await Promise.all(ids.map(id => db.execute(
        'SELECT media_id, post_id, status, mime_type, file_name, size_bytes FROM post_media WHERE media_id = ?', [id]
    ).then(rs => rs.first())));
    return rows
        .filter(m => m && m.status === 'ATTACHED' && String(m.post_id) === String(row.post_id))
        .map(m => ({ mediaId: m.media_id.toString(), fileName: m.file_name, mimeType: m.mime_type, size: toNumber(m.size_bytes) }));
}

// DTO cua 1 bai cho nguoi xem (da qua canView). Bai chia se: kem bai goc NEU nguoi xem duoc xem.
async function toPostDto(row, viewer, rel, { depth = 0 } = {}) {
    const postId = row.post_id;
    const [author, media, reactions, comments, shares] = await Promise.all([
        userService.getUsersByIds([row.author_id]).then(m => m.get(row.author_id)),
        mediaDtos(row),
        reactionSummary(postId, viewer.userId),
        commentCount(postId),
        shareCount(postId)
    ]);
    let shared = null;
    if (row.shared_post_id) {
        const original = depth === 0 ? await readPost(row.shared_post_id) : null;
        shared = original && await canView(original, rel)
            ? { available: true, post: await toPostDto(original, viewer, rel, { depth: 1 }) }
            : { available: false, postId: row.shared_post_id.toString() };
    }
    return {
        postId: postId.toString(),
        author: author ? { userId: author.userId, displayName: author.displayName, avatarUrl: author.avatarUrl || null }
            : { userId: row.author_id, displayName: 'Người dùng', avatarUrl: null },
        content: row.content || '',
        privacy: row.privacy,
        media,
        shared,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        edited: Boolean(row.updated_at && row.created_at && new Date(row.updated_at) - new Date(row.created_at) > 1000),
        reactions,
        commentCount: comments,
        shareCount: shares,
        canEdit: row.author_id === viewer.userId
    };
}

// ===== Anh =====
async function uploadMedia(user, { buffer, fileName }) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError(400, 'EMPTY_FILE', 'Tệp rỗng.');
    if (buffer.length > MAX_IMAGE_BYTES) throw httpError(413, 'FILE_TOO_LARGE', 'Ảnh vượt quá dung lượng cho phép.');
    const name = sanitizeFileName(fileName);
    const kind = classify(name, buffer);
    if (!kind.ok) {
        throw httpError(415, kind.code, kind.code === 'FILE_TYPE_MISMATCH'
            ? 'Nội dung tệp không khớp với phần mở rộng.' : 'Chỉ đăng được ảnh JPG, PNG, GIF hoặc WEBP.');
    }
    if (kind.kind !== 'IMAGE') throw httpError(415, 'FILE_TYPE_NOT_ALLOWED', 'Chỉ đăng được ảnh JPG, PNG, GIF hoặc WEBP.');

    const mediaId = TimeUuid.now();
    const now = new Date();
    const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}`;
    const full = mediaPath(storageKey);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full + '.part', buffer, { flag: 'wx' });
    await fs.promises.rename(full + '.part', full);
    try {
        await db.execute(
            `INSERT INTO post_media (media_id, owner_id, post_id, status, mime_type, file_name, size_bytes, sha256, storage_key, created_at)
             VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?) IF NOT EXISTS`,
            [mediaId, user.userId, null, kind.mime, name, buffer.length,
                crypto.createHash('sha256').update(buffer).digest('hex'), storageKey, now]
        );
    } catch (error) {
        await fs.promises.unlink(full).catch(() => {});
        throw error;
    }
    return { mediaId: mediaId.toString(), fileName: name, mimeType: kind.mime, size: buffer.length, status: 'PENDING' };
}

async function cancelMedia(user, mediaId) {
    const id = parseId(mediaId, 'mediaId');
    const row = (await db.execute('SELECT owner_id, status, storage_key FROM post_media WHERE media_id = ?', [id])).first();
    if (!row || row.owner_id !== user.userId) throw httpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy ảnh.');
    const rs = await db.execute(`DELETE FROM post_media WHERE media_id = ? IF status = 'PENDING' AND owner_id = ?`, [id, user.userId]);
    if (!rs.wasApplied()) throw httpError(409, 'MEDIA_IN_USE', 'Ảnh đã thuộc một bài viết.');
    await fs.promises.unlink(mediaPath(row.storage_key)).catch(() => {});
    return { mediaId: id.toString(), cancelled: true };
}

// Giu cho anh PENDING cua chinh minh cho bai postId (LWT; tranh 1 anh gan vao 2 bai).
async function claimMedia(user, mediaIds, postId) {
    if (mediaIds === undefined) return [];
    if (!Array.isArray(mediaIds)) throw httpError(400, 'INVALID_MEDIA', 'mediaIds phải là danh sách.');
    if (mediaIds.length > MAX_IMAGES) throw httpError(400, 'TOO_MANY_IMAGES', `Tối đa ${MAX_IMAGES} ảnh mỗi bài.`);
    const ids = [...new Set(mediaIds.map(String))].map(id => parseId(id, 'mediaId'));
    const claimed = [];
    for (const id of ids) {
        const rs = await db.execute(
            `UPDATE post_media SET status = 'ATTACHED', post_id = ? WHERE media_id = ? IF status = 'PENDING' AND owner_id = ?`,
            [postId, id, user.userId]
        );
        if (!rs.wasApplied()) {
            await Promise.all(claimed.map(c => db.execute(
                `UPDATE post_media SET status = 'PENDING', post_id = ? WHERE media_id = ? IF status = 'ATTACHED' AND post_id = ?`, [null, c, postId]
            ).catch(() => {})));
            throw httpError(409, 'MEDIA_UNAVAILABLE', 'Ảnh không còn khả dụng (đã dùng ở bài khác hoặc không phải của bạn).');
        }
        claimed.push(id);
    }
    return claimed;
}

async function openMedia(viewer, postId, mediaId) {
    const pid = parseId(postId);
    const mid = parseId(mediaId, 'mediaId');
    await requireVisiblePost(viewer, pid);
    const m = (await db.execute('SELECT post_id, status, mime_type, file_name, size_bytes, storage_key FROM post_media WHERE media_id = ?', [mid])).first();
    if (!m || m.status !== 'ATTACHED' || String(m.post_id) !== String(pid)) throw httpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy ảnh.');
    const full = mediaPath(m.storage_key);
    if (!fs.existsSync(full)) throw httpError(410, 'MEDIA_GONE', 'Ảnh không còn trên máy chủ.');
    return { full, mimeType: m.mime_type, fileName: m.file_name, size: toNumber(m.size_bytes) };
}

// Anh PENDING cua chinh minh (xem truoc khi chua dang).
async function openPendingMedia(user, mediaId) {
    const mid = parseId(mediaId, 'mediaId');
    const m = (await db.execute('SELECT owner_id, status, mime_type, file_name, size_bytes, storage_key FROM post_media WHERE media_id = ?', [mid])).first();
    if (!m || m.owner_id !== user.userId || m.status !== 'PENDING') throw httpError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy ảnh.');
    return { full: mediaPath(m.storage_key), mimeType: m.mime_type, fileName: m.file_name, size: toNumber(m.size_bytes) };
}

// ===== Bai viet =====
function validateContent(text, { required }) {
    if (text === undefined || text === null) {
        if (required) throw httpError(400, 'EMPTY_POST', 'Bài viết cần có nội dung hoặc ảnh.');
        return '';
    }
    if (typeof text !== 'string') throw httpError(400, 'INVALID_CONTENT', 'Nội dung phải là văn bản.');
    const value = text.replace(/\r\n/g, '\n').trim();
    if (required && !value) throw httpError(400, 'EMPTY_POST', 'Bài viết cần có nội dung hoặc ảnh.');
    if (value.length > POST_MAX) throw httpError(400, 'POST_TOO_LONG', `Bài viết tối đa ${POST_MAX} ký tự.`);
    return value;
}

function validatePrivacy(value, fallback = 'FRIENDS') {
    const p = value === undefined ? fallback : String(value).toUpperCase();
    if (!PRIVACY.includes(p)) throw httpError(400, 'INVALID_PRIVACY', 'Quyền riêng tư phải là PUBLIC, FRIENDS hoặc PRIVATE.');
    return p;
}

async function insertPost(user, { content, privacy, mediaIds = [], sharedPostId = null }) {
    const postId = TimeUuid.now();
    const now = postId.getDate();
    const claimed = await claimMedia(user, mediaIds, postId);
    try {
        await db.execute(
            `INSERT INTO posts (post_id, author_id, content, privacy, media_ids, shared_post_id, created_at, updated_at, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, false)`,
            [postId, user.userId, content, privacy, claimed, sharedPostId, now, now]
        );
        await db.execute('INSERT INTO posts_by_author (author_id, post_id) VALUES (?, ?)', [user.userId, postId]);
        if (privacy === 'PUBLIC') await setPublicIndex({ post_id: postId, author_id: user.userId }, true);
    } catch (error) {
        await Promise.all(claimed.map(c => db.execute(
            `UPDATE post_media SET status = 'PENDING', post_id = ? WHERE media_id = ? IF status = 'ATTACHED' AND post_id = ?`, [null, c, postId]
        ).catch(() => {})));
        throw error;
    }
    return postId;
}

async function createPost(user, body = {}) {
    const hasImages = Array.isArray(body.mediaIds) && body.mediaIds.length > 0;
    const content = validateContent(body.content, { required: !hasImages });
    const privacy = validatePrivacy(body.privacy);
    const postId = await insertPost(user, { content, privacy, mediaIds: body.mediaIds });
    await stats.bumpSocial(user.userId, 'posts', 1);
    return getPost(user, postId.toString());
}

// Chia se len bang tin: tao bai moi chi chua THAM CHIEU bai goc + loi dan.
async function sharePost(user, postId, body = {}) {
    const pid = parseId(postId);
    const original = await requireVisiblePost(user, pid);
    // Chia se cua chia se -> tro ve bai goc (khong long nhieu tang).
    const targetId = original.shared_post_id || original.post_id;
    if (original.shared_post_id) await requireVisiblePost(user, targetId);
    const content = validateContent(body.content, { required: false });
    const privacy = validatePrivacy(body.privacy);
    const newId = await insertPost(user, { content, privacy, sharedPostId: targetId });
    await recordShare(targetId, newId, user.userId, 'FEED');
    return getPost(user, newId.toString());
}

async function getPost(viewer, postId) {
    const rel = relCache(viewer.userId);
    const row = await requireVisiblePost(viewer, parseId(postId), rel);
    return toPostDto(row, viewer, rel);
}

async function requireOwnPost(user, postId) {
    const row = await readPost(parseId(postId));
    if (!row || row.is_deleted) throw notFound();
    if (row.author_id !== user.userId) {
        // Khong xem duoc bai -> 404 (khong tiet lo bai rieng tu co ton tai); xem duoc nhung khong phai chu -> 403.
        if (!(await canView(row, relCache(user.userId)))) throw notFound();
        throw httpError(403, 'FORBIDDEN_POST', 'Bạn chỉ có thể sửa hoặc xóa bài của chính mình.');
    }
    return row;
}

async function updatePost(user, postId, body = {}) {
    const row = await requireOwnPost(user, postId);
    const content = body.content === undefined ? row.content : validateContent(body.content, {
        required: !(row.media_ids && row.media_ids.length) && !row.shared_post_id
    });
    const privacy = body.privacy === undefined ? row.privacy : validatePrivacy(body.privacy);
    await db.execute('UPDATE posts SET content = ?, privacy = ?, updated_at = ? WHERE post_id = ?',
        [content, privacy, new Date(), row.post_id]);
    if (privacy !== row.privacy) await setPublicIndex(row, privacy === 'PUBLIC');
    postChanged(row.post_id, 'update');
    return getPost(user, row.post_id.toString());
}

// Xoa mem: bai bien mat voi moi nguoi (ke ca qua ban chia se); anh khong con tai duoc.
async function deletePost(user, postId) {
    const row = await requireOwnPost(user, postId);
    await db.execute('UPDATE posts SET is_deleted = true, content = null, updated_at = ? WHERE post_id = ?', [new Date(), row.post_id]);
    if (row.privacy === 'PUBLIC') await setPublicIndex(row, false);
    // Bai chia se bi xoa -> khong con tinh la 1 luot chia se cua bai goc.
    if (row.shared_post_id) {
        await db.execute('DELETE FROM post_shares WHERE post_id = ? AND share_id = ?', [row.shared_post_id, row.post_id]);
        const original = await readPost(row.shared_post_id);
        if (original && original.author_id !== user.userId) await stats.bumpSocial(original.author_id, 'shares_received', -1);
        postChanged(row.shared_post_id, 'share');
    }
    if (!row.shared_post_id) await stats.bumpSocial(user.userId, 'posts', -1);
    postChanged(row.post_id, 'delete');
    return { postId: row.post_id.toString(), deleted: true };
}

// Doc 1 trang dong thoi gian cua 1 tac gia: post_id < cursor, moi nhat truoc.
async function authorPostIds(authorId, cursor) {
    const rs = cursor
        ? await db.execute(`SELECT post_id FROM posts_by_author WHERE author_id = ? AND post_id < ? LIMIT ${PAGE}`, [authorId, cursor])
        : await db.execute(`SELECT post_id FROM posts_by_author WHERE author_id = ? LIMIT ${PAGE}`, [authorId]);
    return rs.rows.map(r => r.post_id);
}

const parseCursor = c => (c ? parseId(c, 'cursor') : null);

// Bai cong khai moi nhat (moi nguoi), post_id < cursor, lui tung thang toi khi du `limit` id.
async function publicPostIds(cursor, limit) {
    let bucket = bucketOf(cursor || TimeUuid.now());
    const ids = [];
    for (let i = 0; i <= PUBLIC_MONTHS_BACK && ids.length < limit; i++) {
        const rs = cursor
            ? await db.execute(`SELECT post_id FROM public_posts_by_month WHERE bucket = ? AND post_id < ? LIMIT ${PAGE}`, [bucket, cursor])
            : await db.execute(`SELECT post_id FROM public_posts_by_month WHERE bucket = ? LIMIT ${PAGE}`, [bucket]);
        ids.push(...rs.rows.map(r => r.post_id));
        bucket = previousBucket(bucket);
    }
    return { ids: ids.slice(0, limit), complete: ids.length < limit };
}

// Gom id tu nhieu nguon, LOAI TRUNG, sap moi nhat truoc (thu tu timeuuid nhu Cassandra), doc bai + loc
// quyen cho toi khi du PAGE bai. Con tro = post_id cua bai cuoi da xet; trang sau lay post_id < con tro.
async function pageFromSources(viewer, authorIds, cursorValue, { includePublic = false } = {}) {
    const rel = relCache(viewer.userId);
    let cursor = parseCursor(cursorValue);
    let exhausted = false;
    const out = [];
    for (let round = 0; round < 5 && out.length < PAGE && !exhausted; round++) {
        const lists = await Promise.all(authorIds.map(a => authorPostIds(a, cursor)));
        const pub = includePublic ? await publicPostIds(cursor, PAGE) : { ids: [], complete: true };
        const unique = new Map();
        for (const id of [...lists.flat(), ...pub.ids]) unique.set(id.toString(), id);
        const all = [...unique.values()].sort((a, b) => compareDesc(a.toString(), b.toString()));
        const merged = all.slice(0, PAGE);
        exhausted = lists.every(l => l.length < PAGE) && pub.complete && all.length <= PAGE;
        if (merged.length === 0) break;
        const rows = await Promise.all(merged.map(readPost));
        for (const row of rows) {
            if (out.length >= PAGE) break;
            if (await canView(row, rel)) out.push(row);
        }
        cursor = merged[merged.length - 1];
    }
    const nextCursor = out.length >= PAGE ? out[out.length - 1].post_id.toString() : (exhausted ? null : cursor && cursor.toString());
    const items = await Promise.all(out.map(row => toPostDto(row, viewer, rel)));
    return { items, nextCursor, hasMore: Boolean(nextCursor) };
}

// Bang tin = bai cua toi + bai cua ban be (moi muc quyen ho cho phep) + bai CONG KHAI cua moi nguoi.
async function feed(viewer, cursor) {
    const friends = await social.listFriends(viewer);
    const authors = [viewer.userId, ...friends.slice(0, FEED_AUTHORS_CAP).map(f => f.userId)];
    return pageFromSources(viewer, authors, cursor, { includePublic: true });
}

async function timeline(viewer, userId, cursor) {
    const target = String(userId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(target)) throw httpError(400, 'INVALID_USER_ID', 'Mã người dùng không hợp lệ.');
    if (target !== viewer.userId) {
        const b = await social.blockState(viewer.userId, target);
        if (b.blockedMe) throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    }
    return pageFromSources(viewer, [target], cursor);
}

// ===== Cam xuc =====
// MOI lenh ghi post_reactions la LWT -> biet chac day la cam xuc MOI / DOI / GO, de bo dem va thong bao
// khong trung khi bam nhieu lan hoac request dong thoi.
async function readReaction(pid, userId) {
    return (await db.execute('SELECT reaction FROM post_reactions WHERE post_id = ? AND user_id = ?', [pid, userId])).first();
}

async function react(user, postId, reaction) {
    const pid = parseId(postId);
    const post = await requireVisiblePost(user, pid);
    const value = String(reaction || '').toUpperCase();
    if (!REACTIONS.includes(value)) throw httpError(400, 'INVALID_REACTION', 'Cảm xúc không hợp lệ.');
    for (let attempt = 0; attempt < 3; attempt++) {
        const ins = await db.execute(
            'INSERT INTO post_reactions (post_id, user_id, reaction, reacted_at) VALUES (?, ?, ?, ?) IF NOT EXISTS',
            [pid, user.userId, value, new Date()]
        );
        if (ins.wasApplied()) {
            await stats.bumpSocial(user.userId, 'reactions_made', 1);
            if (post.author_id !== user.userId) await stats.bumpSocial(post.author_id, 'reactions_received', 1);
            await notifications.notifySafe({
                recipientId: post.author_id, actorId: user.userId, type: 'POST_REACTION',
                dedupeKey: `REACTION:${pid}:${user.userId}`, postId: pid, preview: value
            });
            break;
        }
        const current = await readReaction(pid, user.userId);
        if (!current) continue; // vua bi go dong thoi -> thu lai
        if (current.reaction === value) break; // bam lai cung cam xuc: khong doi gi
        const upd = await db.execute('UPDATE post_reactions SET reaction = ?, reacted_at = ? WHERE post_id = ? AND user_id = ? IF reaction = ?',
            [value, new Date(), pid, user.userId, current.reaction]);
        if (upd.wasApplied()) break;
    }
    postChanged(pid, 'reaction');
    return reactionSummary(pid, user.userId);
}

async function unreact(user, postId) {
    const pid = parseId(postId);
    const post = await requireVisiblePost(user, pid);
    const current = await readReaction(pid, user.userId);
    if (current) {
        const del = await db.execute('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? IF reaction = ?', [pid, user.userId, current.reaction]);
        if (del.wasApplied()) {
            await stats.bumpSocial(user.userId, 'reactions_made', -1);
            if (post.author_id !== user.userId) await stats.bumpSocial(post.author_id, 'reactions_received', -1);
            postChanged(pid, 'reaction');
        }
    }
    return reactionSummary(pid, user.userId);
}

// Danh sach nguoi da bay to cam xuc (ai xem duoc bai deu xem duoc). An nguoi co chan voi nguoi xem.
async function listReactions(viewer, postId, query = {}) {
    const pid = parseId(postId);
    const rel = relCache(viewer.userId);
    await requireVisiblePost(viewer, pid, rel);
    const type = query.type ? String(query.type).toUpperCase() : null;
    if (type && !REACTIONS.includes(type)) throw httpError(400, 'INVALID_REACTION', 'Cảm xúc không hợp lệ.');
    const scope = '00000000-0000-1000-8000-' + crypto.createHash('sha1').update('reactions:' + pid + ':' + (type || '')).digest('hex').slice(0, 12);
    let pageState = query.pageToken ? decodePageToken(query.pageToken, scope) : undefined;
    const rows = [];
    // Loc theo loai co the lam trang thua: doc them toi khi du 50 dong hoac het (toi da 10 lan / request).
    for (let i = 0; i < 10 && rows.length < 50; i++) {
        const rs = await db.execute('SELECT user_id, reaction, reacted_at FROM post_reactions WHERE post_id = ?', [pid], { fetchSize: 50, pageState });
        for (const r of rs.rows) {
            if (type && r.reaction !== type) continue;
            if (r.user_id !== viewer.userId && (await rel(r.user_id)).blocked) continue;
            rows.push(r);
        }
        pageState = rs.pageState;
        if (!pageState) break;
    }
    const profiles = await userService.getUsersByIds(rows.map(r => r.user_id));
    const nextPageToken = pageState ? encodePageToken(scope, pageState) : null;
    return {
        items: rows.map(r => ({
            userId: r.user_id,
            displayName: profiles.get(r.user_id)?.displayName || 'Người dùng',
            avatarUrl: profiles.get(r.user_id)?.avatarUrl || null,
            reaction: r.reaction,
            reactedAt: iso(r.reacted_at),
            isMe: r.user_id === viewer.userId
        })).sort((x, y) => (y.isMe - x.isMe) || String(y.reactedAt).localeCompare(String(x.reactedAt))),
        summary: await reactionSummary(pid, viewer.userId),
        nextPageToken,
        hasMore: Boolean(nextPageToken)
    };
}

// ===== Binh luan (theo luong) =====
// post_comments: nguon su that (moi binh luan, xoa mem). Chi muc:
//   root_comments_by_post  : binh luan GOC cua bai   -> GET /posts/:id/comments (20 / trang)
//   comment_replies_by_root: phan hoi cua 1 goc      -> GET /posts/:id/comments/:rootId/replies (20 / trang)
// Tra loi 1 phan hoi = phan hoi trong CUNG luong goc (2 cap nhu Facebook), van ghi ro tra loi ai (reply_to).
// Xoa binh luan goc: phan hoi cua nguoi khac giu nguyen, goc hien "Bình luận đã bị xóa" (khong lo noi dung).
const COMMENT_COLS = 'comment_id, author_id, content, created_at, updated_at, is_deleted, reply_to_comment_id, root_comment_id';
const EXCERPT = 80;
const REPLY_COUNT_CAP = 100;

function validateComment(text) {
    if (typeof text !== 'string') throw httpError(400, 'INVALID_COMMENT', 'Bình luận phải là văn bản.');
    const value = text.replace(/\r\n/g, '\n').trim();
    if (!value) throw httpError(400, 'EMPTY_COMMENT', 'Bình luận không được để trống.');
    if (value.length > COMMENT_MAX) throw httpError(400, 'COMMENT_TOO_LONG', `Bình luận tối đa ${COMMENT_MAX} ký tự.`);
    return value;
}

async function readCommentRow(pid, cid) {
    return (await db.execute(`SELECT ${COMMENT_COLS} FROM post_comments WHERE post_id = ? AND comment_id = ?`, [pid, cid])).first();
}

// Binh luan con ton tai (chua xoa) THUOC bai pid; khong co -> 404 (khong phan biet "khac bai" hay "da xoa").
async function readComment(pid, commentId) {
    const row = await readCommentRow(pid, parseId(commentId, 'commentId'));
    if (!row || row.is_deleted) throw httpError(404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận.');
    return row;
}

// Goc cua luong: cot root_comment_id (binh luan moi) hoac do theo chuoi reply_to (binh luan cu).
async function rootOf(pid, row) {
    if (row.root_comment_id) return row.root_comment_id;
    let cur = row;
    for (let hop = 0; hop < 20 && cur.reply_to_comment_id; hop++) {
        const parent = await readCommentRow(pid, cur.reply_to_comment_id);
        if (!parent) break;
        if (parent.root_comment_id) return parent.root_comment_id;
        cur = parent;
    }
    return cur.comment_id;
}

const clip = t => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > EXCERPT ? s.slice(0, EXCERPT) + '…' : s;
};

async function toCommentDtos(rows, viewer, postAuthor, rel, pid, { keepDeleted = false } = {}) {
    const visible = [];
    for (const r of rows) {
        if (r.is_deleted && !keepDeleted) continue;
        if (!r.is_deleted && r.author_id !== viewer.userId && (await rel(r.author_id)).blocked) continue; // an nguoi co chan
        visible.push(r);
    }
    // Binh luan duoc tra loi: ten + doan trich (da xoa -> khong lo noi dung).
    const parentIds = [...new Set(visible.map(r => r.reply_to_comment_id).filter(Boolean).map(String))];
    const known = new Map(rows.map(r => [r.comment_id.toString(), r]));
    const parents = new Map();
    for (const id of parentIds) parents.set(id, known.get(id) || await readCommentRow(pid, TimeUuid.fromString(id)));
    const ids = new Set([...visible.map(r => r.author_id), ...[...parents.values()].filter(Boolean).map(p => p.author_id)]);
    const profiles = await userService.getUsersByIds([...ids]);
    const nameOf = id => profiles.get(id)?.displayName || 'Người dùng';
    return visible.map(r => {
        const parent = r.reply_to_comment_id ? parents.get(r.reply_to_comment_id.toString()) : null;
        const deleted = Boolean(r.is_deleted);
        return {
            commentId: r.comment_id.toString(),
            author: deleted ? null : { userId: r.author_id, displayName: nameOf(r.author_id) },
            content: deleted ? null : r.content,
            deleted,
            createdAt: iso(r.created_at),
            edited: !deleted && Boolean(r.updated_at && r.created_at && new Date(r.updated_at) - new Date(r.created_at) > 1000),
            canEdit: !deleted && r.author_id === viewer.userId,
            canDelete: !deleted && (r.author_id === viewer.userId || postAuthor === viewer.userId),
            replyTo: r.reply_to_comment_id ? {
                commentId: r.reply_to_comment_id.toString(),
                available: Boolean(parent && !parent.is_deleted),
                authorName: parent && !parent.is_deleted ? nameOf(parent.author_id) : null,
                excerpt: parent && !parent.is_deleted ? clip(parent.content) : null
            } : null
        };
    });
}

const tokenScope = key => '00000000-0000-1000-8000-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);

async function replyRows(pid, rootId, limit = REPLY_COUNT_CAP) {
    const rs = await db.execute(`SELECT comment_id FROM comment_replies_by_root WHERE post_id = ? AND root_comment_id = ? LIMIT ${limit}`, [pid, rootId]);
    return (await Promise.all(rs.rows.map(r => readCommentRow(pid, r.comment_id)))).filter(Boolean);
}

async function visibleReplyCount(pid, rootId, viewer, rel) {
    let n = 0;
    for (const r of await replyRows(pid, rootId)) {
        if (r.is_deleted) continue;
        if (r.author_id !== viewer.userId && (await rel(r.author_id)).blocked) continue;
        n += 1;
    }
    return n;
}

// GET /posts/:id/comments: binh luan goc, cu nhat truoc, 20 / trang; kem so phan hoi.
async function listComments(viewer, postId, pageToken) {
    const pid = parseId(postId);
    const rel = relCache(viewer.userId);
    const post = await requireVisiblePost(viewer, pid, rel);
    const scope = tokenScope('comments:' + pid);
    const pageState = pageToken ? decodePageToken(pageToken, scope) : undefined;
    const rs = await db.execute('SELECT comment_id FROM root_comments_by_post WHERE post_id = ?', [pid], { fetchSize: PAGE, pageState });
    const rows = (await Promise.all(rs.rows.map(r => readCommentRow(pid, r.comment_id)))).filter(Boolean);
    const counts = new Map(await Promise.all(rows.map(async r => [r.comment_id.toString(), await visibleReplyCount(pid, r.comment_id, viewer, rel)])));
    // Goc da xoa: chi giu (dang placeholder) neu con phan hoi hien thi.
    const kept = rows.filter(r => !r.is_deleted || counts.get(r.comment_id.toString()) > 0);
    const dtos = await toCommentDtos(kept, viewer, post.author_id, rel, pid, { keepDeleted: true });
    const items = dtos.map(d => ({ ...d, replyCount: counts.get(d.commentId) || 0, replyCountCapped: (counts.get(d.commentId) || 0) >= REPLY_COUNT_CAP }));
    const nextPageToken = rs.pageState ? encodePageToken(scope, rs.pageState) : null;
    return { items, nextPageToken, hasMore: Boolean(nextPageToken), total: await commentCount(pid) };
}

// GET /posts/:id/comments/:rootId/replies: phan hoi cua 1 binh luan goc, 20 / trang.
async function listReplies(viewer, postId, rootId, pageToken) {
    const pid = parseId(postId);
    const rel = relCache(viewer.userId);
    const post = await requireVisiblePost(viewer, pid, rel);
    const root = await readCommentRow(pid, parseId(rootId, 'commentId'));
    if (!root || root.reply_to_comment_id) throw httpError(404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận gốc.');
    const scope = tokenScope('replies:' + pid + ':' + root.comment_id);
    const pageState = pageToken ? decodePageToken(pageToken, scope) : undefined;
    const rs = await db.execute('SELECT comment_id FROM comment_replies_by_root WHERE post_id = ? AND root_comment_id = ?',
        [pid, root.comment_id], { fetchSize: PAGE, pageState });
    const rows = (await Promise.all(rs.rows.map(r => readCommentRow(pid, r.comment_id)))).filter(Boolean);
    const items = await toCommentDtos(rows, viewer, post.author_id, rel, pid);
    const nextPageToken = rs.pageState ? encodePageToken(scope, rs.pageState) : null;
    return { rootCommentId: root.comment_id.toString(), items, nextPageToken, hasMore: Boolean(nextPageToken) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function addComment(user, postId, body = {}) {
    const pid = parseId(postId);
    const rel = relCache(user.userId);
    const post = await requireVisiblePost(user, pid, rel);
    const content = validateComment(body.content);
    // Tra loi: binh luan cha phai TON TAI, chua xoa va THUOC CUNG bai (doc trong partition cua pid).
    const parent = body.replyToCommentId ? await readComment(pid, body.replyToCommentId) : null;
    const rootId = parent ? await rootOf(pid, parent) : null;

    // Chong trung khi gui lai: clientId do client sinh 1 lan cho moi lan bam Gui (LWT IF NOT EXISTS).
    const cid = TimeUuid.now();
    if (body.clientId !== undefined) {
        if (!UUID_RE.test(String(body.clientId))) throw httpError(400, 'INVALID_CLIENT_ID', 'clientId phải là UUID.');
        const claim = await db.execute(
            'INSERT INTO comment_client_ids (post_id, client_id, comment_id, author_id) VALUES (?, ?, ?, ?) IF NOT EXISTS',
            [pid, require('cassandra-driver').types.Uuid.fromString(String(body.clientId)), cid, user.userId]
        );
        if (!claim.wasApplied()) {
            const prev = (await db.execute('SELECT comment_id, author_id FROM comment_client_ids WHERE post_id = ? AND client_id = ?',
                [pid, require('cassandra-driver').types.Uuid.fromString(String(body.clientId))])).first();
            if (!prev || prev.author_id !== user.userId) throw httpError(409, 'DUPLICATE_CLIENT_ID', 'Yêu cầu trùng không hợp lệ.');
            const existing = await readCommentRow(pid, prev.comment_id);
            if (existing) {
                const [dto] = await toCommentDtos([existing], user, post.author_id, rel, pid, { keepDeleted: true });
                return { comment: { ...dto, rootCommentId: (existing.root_comment_id || '').toString() || null }, total: await commentCount(pid), duplicate: true };
            }
            // Lan truoc dung giua chung truoc khi ghi binh luan -> ghi tiep voi id da giu cho.
            return finishInsert(user, pid, post, rel, { cid: prev.comment_id, content, parent, rootId });
        }
    }
    return finishInsert(user, pid, post, rel, { cid, content, parent, rootId });
}

async function finishInsert(user, pid, post, rel, { cid, content, parent, rootId }) {
    const now = new Date();
    await db.execute(
        `INSERT INTO post_comments (post_id, comment_id, author_id, content, created_at, updated_at, is_deleted, reply_to_comment_id, root_comment_id)
         VALUES (?, ?, ?, ?, ?, ?, false, ?, ?)`,
        [pid, cid, user.userId, content, now, now, parent ? parent.comment_id : null, rootId]
    );
    if (rootId) {
        await db.execute('INSERT INTO comment_replies_by_root (post_id, root_comment_id, comment_id) VALUES (?, ?, ?)', [pid, rootId, cid]);
    } else {
        await db.execute('INSERT INTO root_comments_by_post (post_id, comment_id) VALUES (?, ?)', [pid, cid]);
    }
    await stats.bumpSocial(user.userId, 'comments_made', 1);
    if (post.author_id !== user.userId) await stats.bumpSocial(post.author_id, 'comments_received', 1);
    // Thong bao: nguoi duoc tra loi (neu van xem duoc bai) + tac gia bai; khong trung nguoi, khong tu bao.
    const told = new Set([user.userId]);
    if (parent && !told.has(parent.author_id) && await canView(post, relCache(parent.author_id))) {
        told.add(parent.author_id);
        await notifications.notifySafe({ recipientId: parent.author_id, actorId: user.userId, type: 'COMMENT_REPLY',
            dedupeKey: `COMMENT:${cid}`, postId: pid, commentId: cid, preview: content });
    }
    if (!told.has(post.author_id)) {
        await notifications.notifySafe({ recipientId: post.author_id, actorId: user.userId, type: 'POST_COMMENT',
            dedupeKey: `COMMENT:${cid}`, postId: pid, commentId: cid, preview: content });
    }
    postChanged(pid, 'comment');
    const [dto] = await toCommentDtos([{ comment_id: cid, author_id: user.userId, content, created_at: now, updated_at: now, is_deleted: false,
        reply_to_comment_id: parent ? parent.comment_id : null, root_comment_id: rootId }], user, post.author_id, rel, pid);
    return { comment: { ...dto, rootCommentId: rootId ? rootId.toString() : null, replyCount: 0 }, total: await commentCount(pid) };
}

// Sua: CHI nguoi viet binh luan (danh tinh tu phien).
async function updateComment(user, postId, commentId, body = {}) {
    const pid = parseId(postId);
    const rel = relCache(user.userId);
    const post = await requireVisiblePost(user, pid, rel);
    const row = await readComment(pid, commentId);
    if (row.author_id !== user.userId) throw httpError(403, 'FORBIDDEN_COMMENT', 'Bạn chỉ có thể sửa bình luận của chính mình.');
    const content = validateComment(body.content);
    const now = new Date();
    await db.execute('UPDATE post_comments SET content = ?, updated_at = ? WHERE post_id = ? AND comment_id = ?', [content, now, pid, row.comment_id]);
    const [dto] = await toCommentDtos([{ ...row, content, updated_at: now }], user, post.author_id, rel, pid);
    postChanged(pid, 'comment');
    return { comment: dto };
}

// Xoa: nguoi viet binh luan HOAC chu bai (chinh sach). Nguoi khac: 403, khong doi du lieu. Xoa mem.
async function deleteComment(user, postId, commentId) {
    const pid = parseId(postId);
    const post = await requireVisiblePost(user, pid);
    const row = await readComment(pid, commentId);
    if (row.author_id !== user.userId && post.author_id !== user.userId) {
        throw httpError(403, 'FORBIDDEN_COMMENT', 'Bạn không có quyền xóa bình luận này.');
    }
    await db.execute('UPDATE post_comments SET is_deleted = true, content = null, updated_at = ? WHERE post_id = ? AND comment_id = ?',
        [new Date(), pid, row.comment_id]);
    await stats.bumpSocial(row.author_id, 'comments_made', -1);
    if (post.author_id !== row.author_id) await stats.bumpSocial(post.author_id, 'comments_received', -1);
    postChanged(pid, 'comment');
    return { commentId: row.comment_id.toString(), deleted: true, total: await commentCount(pid) };
}

module.exports = {
    recordShare, shareCount,
    PRIVACY, REACTIONS, MAX_IMAGES, MAX_IMAGE_BYTES, parseId, readPost, relCache, canView, requireVisiblePost,
    uploadMedia, cancelMedia, openMedia, openPendingMedia, mediaRoot,
    createPost, sharePost, getPost, updatePost, deletePost, feed, timeline,
    react, unreact, listReactions, listComments, listReplies, addComment, updateComment, deleteComment
};
