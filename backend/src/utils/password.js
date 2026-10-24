// Bam mat khau bang scrypt co san trong Node.js (khong can thu vien native,
// khong can node-gyp tren Windows). Moi mat khau co salt ngau nhien 16 byte.
// Tham so theo OWASP Password Storage Cheat Sheet cho scrypt: N=2^14 (16 MiB), r=8, p=5
// (tuong duong muc toi thieu N=2^17, r=8, p=1 nhung it RAM hon moi lan bam).
// Dinh dang luu: scrypt$N$r$p$saltBase64$hashBase64 -> tham so nam trong hash,
// sau nay tang tham so van xac minh duoc hash cu.
const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 5;
const KEYLEN = 64;

function scrypt(password, salt, params = { N, r: R, p: P }) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, KEYLEN, { ...params, maxmem: 64 * 1024 * 1024 }, (err, key) =>
            err ? reject(err) : resolve(key)
        );
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt);
    return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    // Chan tham so bat thuong (hash bi sua) gay ton CPU/RAM.
    if (![n, r, p].every(v => /^\d+$/.test(v)) || Number(n) > 1048576 || Number(r) > 32 || Number(p) > 16) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), {
        N: Number(n), r: Number(r), p: Number(p)
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Dung khi email khong ton tai: van ton thoi gian tuong duong de
// khong lo email nao da dang ky qua do tre phan hoi.
let dummyHash = null;
async function verifyAgainstDummy(password) {
    if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
    await verifyPassword(password, dummyHash);
    return false;
}

module.exports = { hashPassword, verifyPassword, verifyAgainstDummy };
