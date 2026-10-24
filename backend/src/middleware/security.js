const { httpError } = require('../utils/httpError');
// NFR-13: khi co REDIS_URL, bo dem dung chung giua cac tien trinh (extensions/lib/redisRateLimit.js).
const sharedLimit = require('../extensions/lib/redisRateLimit');

function allowedOrigins() {
    return (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

// Chong CSRF cho request thay doi du lieu: neu trinh duyet gui Origin,
// Origin phai nam trong danh sach cho phep. Body phai la JSON.
function originGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const origin = req.headers.origin;
    if (origin && !allowedOrigins().includes(origin)) {
        return next(httpError(403, 'FORBIDDEN_ORIGIN', 'Nguồn gửi yêu cầu không được phép.'));
    }

    // Ngoai le DUY NHAT cho body khong phai JSON: tai tep len (van kiem tra Origin o tren).
    const urlPath = req.originalUrl.split('?')[0];
    const isUpload = req.method === 'POST' && (/^\/api\/v1\/conversations\/[^/]+\/attachments$/.test(urlPath) || urlPath === '/api/v1/posts/media');
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (hasBody && !isUpload && !req.is('application/json')) {
        return next(httpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Yêu cầu phải gửi dữ liệu dạng JSON.'));
    }
    return next();
}

// Gioi han so lan thu (bo nho trong tien trinh - du cho demo 1 may chu).
function rateLimit({ windowMs, max, key, code = 'TOO_MANY_REQUESTS', message }) {
    const hits = new Map();
    const sharedName = sharedLimit.register({ windowMs, max, code, message });
    return (req, res, next) => {
        if (sharedLimit.ready()) return sharedLimit.limit(sharedName, key(req), { windowMs, max, code, message }, res, next);
        const now = Date.now();
        const id = key(req);
        const entry = hits.get(id);
        if (!entry || entry.resetAt <= now) {
            hits.set(id, { count: 1, resetAt: now + windowMs });
        } else {
            entry.count += 1;
            if (entry.count > max) {
                res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
                return next(httpError(429, code, message));
            }
        }
        if (hits.size > 10000) {
            for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
        }
        return next();
    };
}

module.exports = { allowedOrigins, originGuard, rateLimit };
