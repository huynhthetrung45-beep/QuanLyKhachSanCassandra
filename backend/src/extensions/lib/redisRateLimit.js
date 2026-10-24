// NFR-13: bo dem gioi han toc do dung chung giua NHIEU tien trinh backend qua Redis.
// rateLimit() trong middleware/security.js goi vao day khi Redis san sang; chua cau hinh / mat ket noi -> dem trong
// bo nho tien trinh nhu cu (khong chan nguoi dung vi loi Redis).
//
// Moi bo gioi han co ten on dinh: chu ky (windowMs, max, code, message) + thu tu tao. Moi tien trinh nap module theo
// cung thu tu nen cung bo gioi han o 2 tien trinh co cung ten -> cung khoa Redis "rl:<ten>:<id>".
// Dem bang script Lua nguyen tu: INCR, lan dau dat PEXPIRE = cua so; tra ve (so lan, ms con lai).
const crypto = require('crypto');
const { httpError } = require('../../utils/httpError');

const SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end "
    + "local t = redis.call('PTTL', KEYS[1]) if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end return {c, t}";
const PREFIX = process.env.RATE_LIMIT_PREFIX || 'chatott:rl:';

let client = null;
let failedAt = 0;
const seen = new Map();
const fallback = new Map(); // dem cuc bo khi Redis loi giua chung

function register({ windowMs, max, code, message }) {
    const sig = crypto.createHash('sha1').update(`${windowMs}|${max}|${code}|${message}`).digest('hex').slice(0, 10);
    const n = (seen.get(sig) || 0) + 1;
    seen.set(sig, n);
    return `${sig}${n > 1 ? '-' + n : ''}`;
}

// Redis loi -> tam dung 10 giay roi thu lai, trong luc do dem cuc bo.
const ready = () => Boolean(client && (client.isReady !== false) && Date.now() - failedAt > 10000);

function localHit(name, id, windowMs) {
    const k = `${name}:${id}`;
    const now = Date.now();
    const e = fallback.get(k);
    if (!e || e.resetAt <= now) { fallback.set(k, { count: 1, resetAt: now + windowMs }); return { count: 1, ttl: windowMs }; }
    e.count += 1;
    if (fallback.size > 10000) for (const [key, v] of fallback) if (v.resetAt <= now) fallback.delete(key);
    return { count: e.count, ttl: e.resetAt - now };
}

async function hit(name, id, windowMs) {
    try {
        const [count, ttl] = await client.eval(SCRIPT, { keys: [`${PREFIX}${name}:${id}`], arguments: [String(windowMs)] });
        return { count: Number(count), ttl: Number(ttl) };
    } catch (error) {
        failedAt = Date.now();
        console.warn('[redis] Giới hạn tốc độ tạm đếm cục bộ:', error.message);
        return localHit(name, id, windowMs);
    }
}

// Middleware dung chung: goi tu rateLimit() khi ready().
function limit(name, id, { windowMs, max, code, message }, res, next) {
    return hit(name, id, windowMs).then(({ count, ttl }) => {
        if (count > max) {
            res.setHeader('Retry-After', Math.max(1, Math.ceil(ttl / 1000)));
            return next(httpError(429, code, message));
        }
        return next();
    }, next);
}

async function connect() {
    if (client || !process.env.REDIS_URL || process.env.RATE_LIMIT_REDIS === 'false') return false;
    let redis;
    try {
        // eslint-disable-next-line global-require
        redis = require('redis');
    } catch {
        console.warn('[redis] Có REDIS_URL nhưng chưa cài thư viện redis. Giới hạn tốc độ đếm trong từng tiến trình.');
        return false;
    }
    const c = redis.createClient({ url: process.env.REDIS_URL });
    c.on('error', e => { failedAt = Date.now(); console.warn('[redis] rate-limit:', e.message); });
    await c.connect();
    client = c;
    console.log('[redis] Giới hạn tốc độ dùng chung giữa các tiến trình qua Redis.');
    return true;
}

// Kiem thu: dung client gia lap (co ham eval).
function setClient(c) { client = c; failedAt = 0; }

module.exports = { register, ready, limit, connect, setClient, SCRIPT };
