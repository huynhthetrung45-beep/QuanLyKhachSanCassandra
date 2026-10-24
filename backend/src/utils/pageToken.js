// Dong goi Paging State cua Cassandra driver thanh pageToken "mo" cho client.
// Dinh dang: base64url(JSON { v, cid, ps, sig })
//   cid : conversationId da sinh ra pageState  -> chong dung token sai hoi thoai
//   ps  : pageState (hex) do driver tra ve
//   sig : HMAC-SHA256(cid + ps) bang secret phia server -> chong sua token
const crypto = require('crypto');
const { httpError } = require('./httpError');

let secret = process.env.PAGE_TOKEN_SECRET || process.env.SESSION_SECRET;
if (!secret) {
    // Khong co secret: sinh ngau nhien moi lan khoi dong.
    // Token cu se bi tu choi (400) sau khi restart -> client tai lai trang dau.
    secret = crypto.randomBytes(32).toString('hex');
}

function sign(cid, ps) {
    return crypto.createHmac('sha256', secret).update(`${cid}.${ps}`).digest('base64url');
}

function encodePageToken(conversationId, pageState) {
    if (!pageState) return null;
    const ps = Buffer.isBuffer(pageState) ? pageState.toString('hex') : String(pageState);
    const cid = String(conversationId).toLowerCase();
    return Buffer.from(JSON.stringify({ v: 1, cid, ps, sig: sign(cid, ps) })).toString('base64url');
}

function decodePageToken(pageToken, conversationId) {
    const invalid = () =>
        httpError(400, 'INVALID_PAGE_TOKEN', 'pageToken không hợp lệ hoặc không thuộc hội thoại này');

    if (typeof pageToken !== 'string' || pageToken.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(pageToken)) {
        throw invalid();
    }

    let data;
    try {
        data = JSON.parse(Buffer.from(pageToken, 'base64url').toString('utf8'));
    } catch {
        throw invalid();
    }

    const cid = String(conversationId).toLowerCase();
    if (!data || data.v !== 1 || data.cid !== cid || typeof data.ps !== 'string' || !data.ps) {
        throw invalid();
    }

    const expected = Buffer.from(sign(data.cid, data.ps));
    const actual = Buffer.from(String(data.sig || ''));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
        throw invalid();
    }

    return data.ps; // driver nhan pageState dang chuoi hex
}

module.exports = { encodePageToken, decodePageToken };
