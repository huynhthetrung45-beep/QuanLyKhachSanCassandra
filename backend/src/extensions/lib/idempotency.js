// Chong gui lap khi client gui lai yeu cau (mang cham / timeout): header Idempotency-Key hoac body.clientKey.
// Giu cho khoa TRUOC khi tao tai nguyen (LWT IF NOT EXISTS) voi id da sinh san:
//   - thang  -> tao tai nguyen voi dung id do; loi giua chung -> xoa khoa de client thu lai duoc.
//   - thua   -> tra id tai nguyen da tao boi lan gui truoc (hoac 409 neu lan truoc chua xong).
const db = require('../../db');
const { httpError } = require('../../utils/httpError');

const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

function keyOf(req, body = {}) {
    const k = req.headers['idempotency-key'] || body.clientKey;
    if (k === undefined || k === null || k === '') return null;
    if (!KEY_RE.test(String(k))) throw httpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key không hợp lệ.');
    return String(k);
}

// Tra ve { claimed: true } hoac { claimed: false, resourceId }.
async function claim(userId, key, type, resourceId) {
    if (!key) return { claimed: true };
    const rs = await db.execute(
        'INSERT INTO idempotency_keys (user_id, idem_key, resource_type, resource_id, created_at) VALUES (?, ?, ?, ?, ?) IF NOT EXISTS USING TTL 86400',
        [userId, key, type, String(resourceId), new Date()]);
    if (rs.wasApplied()) return { claimed: true };
    const row = rs.first() || {};
    if (row.resource_type && row.resource_type !== type) throw httpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã dùng cho thao tác khác.');
    return { claimed: false, resourceId: row.resource_id };
}

async function release(userId, key) {
    if (key) await db.execute('DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?', [userId, key]).catch(() => {});
}

module.exports = { keyOf, claim, release };
