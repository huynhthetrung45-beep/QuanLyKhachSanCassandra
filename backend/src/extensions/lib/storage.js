// Luu noi dung tep cua cac chuc nang moi (anh dai dien, anh bia, anh nhom, story) tren o dia.
// Cung quy uoc voi tep chat: Cassandra chi giu khoa luu tru "YYYY/MM/<uuid>", ten tep do server sinh.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('../../utils/httpError');
const { sniff } = require('../../utils/fileType');
const attachments = require('../../services/attachment.service');

const IMAGE_MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const KEY_RE = /^\d{4}\/\d{2}\/[0-9a-f-]{36}$/;
const AREAS = ['profiles', 'groups', 'stories'];

function areaRoot(area) {
    if (!AREAS.includes(area)) throw new Error('Khu lưu trữ không hợp lệ: ' + area);
    return path.join(attachments.uploadDir(), area);
}

function fullPath(area, key) {
    if (!KEY_RE.test(String(key || ''))) throw httpError(500, 'BAD_STORAGE_KEY', 'Khóa lưu trữ không hợp lệ.');
    const root = areaRoot(area);
    const full = path.resolve(root, ...key.split('/'));
    if (!full.startsWith(root + path.sep)) throw httpError(500, 'BAD_STORAGE_KEY', 'Khóa lưu trữ không hợp lệ.');
    return full;
}

// Chi chap nhan anh JPG/PNG/GIF/WEBP theo NOI DUNG that (khong tin ten tep / Content-Type).
function checkImage(buffer, maxBytes) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError(400, 'EMPTY_FILE', 'Tệp rỗng hoặc không đọc được.');
    if (buffer.length > maxBytes) {
        throw httpError(413, 'FILE_TOO_LARGE', `Ảnh vượt quá ${Math.round(maxBytes / 1048576)} MB.`);
    }
    const actual = sniff(buffer);
    if (!IMAGE_MIME[actual]) throw httpError(415, 'FILE_TYPE_NOT_ALLOWED', 'Chỉ chấp nhận ảnh JPG, PNG, GIF hoặc WEBP.');
    return IMAGE_MIME[actual];
}

async function save(area, buffer) {
    const id = crypto.randomUUID();
    const now = new Date();
    const key = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
    const full = fullPath(area, key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    const tmp = full + '.part';
    await fs.promises.writeFile(tmp, buffer, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(tmp, full);
    return key;
}

async function remove(area, key) {
    if (!key) return;
    await fs.promises.unlink(fullPath(area, key)).catch(() => {});
}

// Gui tep anh ve trinh duyet (chi qua API co kiem tra dang nhap).
async function sendFile(res, area, key, mime, maxAge = 300) {
    const full = fullPath(area, key);
    const stat = await fs.promises.stat(full).catch(() => null);
    if (!stat) throw httpError(404, 'FILE_GONE', 'Tệp không còn trên máy chủ.');
    res.set({
        'Content-Type': mime || 'application/octet-stream',
        'Content-Length': String(stat.size),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        'Cache-Control': `private, max-age=${maxAge}`
    });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

module.exports = { checkImage, save, remove, sendFile, fullPath, areaRoot, IMAGE_MIME };
