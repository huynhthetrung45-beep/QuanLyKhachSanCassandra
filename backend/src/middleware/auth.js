const authService = require('../services/auth.service');
const { httpError } = require('../utils/httpError');

const COOKIE_NAME = 'chatott_sid';

function parseCookies(header) {
    const out = {};
    String(header || '').split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx < 0) return;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (!key) return;
        try {
            out[key] = decodeURIComponent(value);
        } catch {
            out[key] = value;
        }
    });
    return out;
}

function readSessionToken(req) {
    return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

function cookieOptions(maxAgeMs) {
    const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
    return {
        httpOnly: true,       // JavaScript khong doc duoc token
        sameSite: 'lax',      // khong gui kem request POST tu trang web khac
        secure,
        path: '/',
        maxAge: maxAgeMs
    };
}

// Bat buoc dang nhap. Gan req.user = { userId, displayName, email, avatarUrl }.
async function requireAuth(req, res, next) {
    const token = readSessionToken(req);
    if (!token) {
        return next(httpError(401, 'UNAUTHENTICATED', 'Bạn cần đăng nhập để tiếp tục.'));
    }

    const session = await authService.resolveSession(token);
    if (!session) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return next(httpError(401, 'SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
    }

    req.user = session.user;
    req.sessionHash = session.sessionHash;
    return next();
}

// Chong gia mao: neu request van gui kem userId / senderId / requesterId
// (kieu API cu) thi gia tri do bat buoc trung voi nguoi da xac thuc.
// Danh tinh luon lay tu phien, khong bao gio lay tu tham so client.
function rejectSpoofedIdentity(req, res, next) {
    const claimed = [
        req.query?.userId,
        req.query?.requesterId,
        req.body?.userId,
        req.body?.senderId,
        req.body?.requesterId
    ].filter(value => value !== undefined && value !== null && value !== '');

    if (claimed.some(value => String(value) !== req.user.userId)) {
        return next(httpError(403, 'IDENTITY_MISMATCH',
            'Không thể gửi yêu cầu thay mặt người dùng khác.'));
    }
    return next();
}

module.exports = {
    COOKIE_NAME,
    parseCookies,
    readSessionToken,
    cookieOptions,
    requireAuth,
    rejectSpoofedIdentity
};
