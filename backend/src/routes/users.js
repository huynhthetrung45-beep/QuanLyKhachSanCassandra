const express = require('express');
const userService = require('../services/user.service');
const conversationService = require('../services/conversation.service');
const { httpError } = require('../utils/httpError');
const social = require('../services/social.service');

const router = express.Router();

// GET /api/v1/users - Q0 (SRS), can dang nhap; khong tra email/mat khau.
router.get('/users', async (req, res) => {
    res.json({ data: await userService.listUsers() });
});

// GET /api/v1/users/search?q=...
router.get('/users/search', async (req, res) => {
    const q = String(req.query.q || '');
    if (q.trim().length < 1 || q.length > 100) {
        throw httpError(400, 'INVALID_QUERY', 'Từ khóa tìm kiếm cần từ 1 đến 100 ký tự.');
    }
    // Kem trang thai quan he; an nguoi da chan minh.
    const people = await social.annotate(req.user, await userService.searchUsers(q, req.user.userId));
    const visible = (await Promise.all(people.map(async p => ((await social.blockState(req.user.userId, p.userId)).blockedMe ? null : p))))
        .filter(Boolean);
    res.json({ data: visible });
});

// GET /api/v1/me/conversations - Q1 cho nguoi dang dang nhap
router.get('/me/conversations', async (req, res) => {
    res.json({ userId: req.user.userId, data: await conversationService.listForUser(req.user) });
});

// GET /api/v1/users/:userId/conversations - giu duong dan cua SRS de tuong thich,
// nhung chi cho phep xem danh sach cua CHINH MINH.
router.get('/users/:userId/conversations', async (req, res) => {
    if (req.params.userId !== req.user.userId) {
        throw httpError(403, 'IDENTITY_MISMATCH', 'Bạn chỉ có thể xem danh sách hội thoại của chính mình.');
    }
    res.json({ userId: req.user.userId, data: await conversationService.listForUser(req.user) });
});

module.exports = router;
