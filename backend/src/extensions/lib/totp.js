// TOTP (RFC 6238, HMAC-SHA1, 6 chu so, buoc 30 giay) cho xac thuc hai lop (NFR-16).
// Khong can thu vien ngoai: dung crypto co san cua Node.js.
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(text) {
    const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | ALPHABET.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, counter) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return String(bin % 1000000).padStart(6, '0');
}

// Chap nhan lech +-1 buoc (30 giay) do dong ho dien thoai.
function verify(secret, code, now = Date.now()) {
    const c = String(code || '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(c) || !secret) return false;
    const step = Math.floor(now / 30000);
    return [-1, 0, 1].some(d => {
        const expected = Buffer.from(codeAt(secret, step + d));
        return crypto.timingSafeEqual(expected, Buffer.from(c));
    });
}

function otpauthUrl(secret, account, issuer = 'ChatOTT') {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, codeAt, otpauthUrl, base32Encode, base32Decode };
