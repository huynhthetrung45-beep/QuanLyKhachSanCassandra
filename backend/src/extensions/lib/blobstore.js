// NFR-15: noi luu noi dung tep. STORAGE_DRIVER=disk (mac dinh, nhu cu) | s3 (AWS S3 / MinIO).
//
// Che do s3: object storage la noi luu CHINH. UPLOAD_DIR chi con la bo dem cuc bo:
//   - Tai len: ghi tam ra o dia (code cu giu nguyen) roi day len S3; day len that bai -> huy tep, bao loi 503.
//   - Tai xuong: tep chua co trong bo dem (backend khac tai len, bo dem bi xoa, may moi) -> tai tu S3 ve roi gui.
//   - Xoa: xoa ca object tren S3 va ban trong bo dem.
//   - S3_KEEP_LOCAL=false: xoa ban cuc bo ngay sau khi day len (o dia chi giu tep dang duoc tai xuong).
// Khoa object = S3_PREFIX + duong dan tuong doi trong UPLOAD_DIR (vd chatott/2026/10/<uuid>, chatott/posts/..., chatott/profiles/...).
const fs = require('fs');
const path = require('path');
const s3 = require('./s3');

let client = null;
let state = null;

function driver() {
    return String(process.env.STORAGE_DRIVER || 'disk').toLowerCase() === 's3' ? 's3' : 'disk';
}

const enabled = () => driver() === 's3';

function uploadRoot() {
    return require('../../services/attachment.service').uploadDir();
}

function getClient() {
    if (client) return client;
    const cfg = s3.config();
    const lack = s3.missing(cfg);
    if (lack.length) throw new Error(`STORAGE_DRIVER=s3 nhưng thiếu cấu hình: ${lack.map(k => ({ endpoint: 'S3_ENDPOINT', bucket: 'S3_BUCKET', accessKeyId: 'S3_ACCESS_KEY_ID', secretAccessKey: 'S3_SECRET_ACCESS_KEY' })[k]).join(', ')}`);
    client = s3.createClient(cfg);
    return client;
}

// Kiem thu: thay client (S3 gia lap).
function setClient(c) { client = c; }

function objectKey(fullPath) {
    const root = uploadRoot();
    const rel = path.relative(root, path.resolve(fullPath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Tệp nằm ngoài UPLOAD_DIR');
    const prefix = (process.env.S3_PREFIX ?? 'chatott/').replace(/^\/+/, '');
    return prefix + rel.split(path.sep).join('/');
}

const mimeOf = file => ({ '.jpg': 'image/jpeg', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream';

// Sau khi code cu ghi tep ra o dia: day len S3.
async function pushFile(fullPath, contentType) {
    if (!enabled()) return;
    const buffer = await fs.promises.readFile(fullPath);
    await getClient().putObject(objectKey(fullPath), buffer, contentType || mimeOf(fullPath));
    if (process.env.S3_KEEP_LOCAL === 'false') await fs.promises.unlink(fullPath).catch(() => {});
}

// Truoc khi doc: dam bao tep co trong bo dem (tai tu S3 neu thieu). Tra ve true neu co tep.
async function ensureLocal(fullPath) {
    if (fs.existsSync(fullPath)) return true;
    if (!enabled()) return false;
    const buffer = await getClient().getObject(objectKey(fullPath));
    if (!buffer) return false;
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    const tmp = `${fullPath}.${process.pid}.${Date.now()}.dl`;
    await fs.promises.writeFile(tmp, buffer, { mode: 0o600 });
    await fs.promises.rename(tmp, fullPath).catch(async () => fs.promises.unlink(tmp).catch(() => {}));
    return true;
}

async function removeFile(fullPath) {
    await fs.promises.unlink(fullPath).catch(() => {});
    if (enabled()) await getClient().deleteObject(objectKey(fullPath)).catch(error => console.warn('[lưu trữ] Không xóa được trên S3:', error.message));
}

// Kiem tra khi khoi dong: in ra che do luu tru; thieu cau hinh s3 -> bao loi ro rang.
function describe() {
    if (!enabled()) return { driver: 'disk', dir: uploadRoot() };
    const cfg = s3.config();
    return { driver: 's3', endpoint: cfg.endpoint, bucket: cfg.bucket, prefix: process.env.S3_PREFIX ?? 'chatott/', missing: s3.missing(cfg) };
}

function status() {
    if (state) return state;
    state = describe();
    return state;
}

module.exports = { driver, enabled, pushFile, ensureLocal, removeFile, objectKey, setClient, getClient, describe, status };
