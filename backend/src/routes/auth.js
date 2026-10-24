const express = require('express');
const authService = require('../services/auth.service');
const { COOKIE_NAME, cookieOptions, readSessionToken, requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { normalizeEmail } = require('../utils/validate');

const router = express.Router();

const ip = req => req.ip || req.socket?.remoteAddress || 'unknown';

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT || 10),
    key: req => `${ip(req)}|${normalizeEmail(req.body?.email)}`,
    code: 'TOO_MANY_ATTEMPTS',
    message: 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau ít phút.'
});

// Gioi han them theo IP (khong phu thuoc email) de chan thu lan luot nhieu email.
const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_IP_RATE_LIMIT || 50),
    key: req => ip(req),
    code: 'TOO_MANY_ATTEMPTS',
    message: 'Có quá nhiều lần đăng nhập từ thiết bị này. Vui lòng thử lại sau ít phút.'
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.REGISTER_RATE_LIMIT || 20),
    key: req => ip(req),
    code: 'TOO_MANY_ATTEMPTS',
    message: 'Bạn đã tạo quá nhiều tài khoản. Vui lòng thử lại sau.'
});

// POST /api/v1/auth/register
router.post('/register', registerLimiter, async (req, res) => {
    const user = await authService.register(req.body);
    res.status(201).json({ user, message: 'Tạo tài khoản thành công. Hãy đăng nhập để bắt đầu trò chuyện.' });
});

// POST /api/v1/auth/login
router.post('/login', loginIpLimiter, loginLimiter, async (req, res) => {
    const session = await authService.login(req.body);
    res.cookie(COOKIE_NAME, session.token, cookieOptions(session.maxAgeMs));
    // Token chi nam trong cookie HttpOnly, khong tra trong body.
    res.json({ user: session.user, expiresAt: session.expiresAt });
});

// POST /api/v1/auth/logout - xoa phien tren Cassandra va xoa cookie.
router.post('/logout', async (req, res) => {
    await authService.logout(readSessionToken(req));
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ message: 'Đã đăng xuất.' });
});

// GET /api/v1/auth/me
router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

module.exports = router;
