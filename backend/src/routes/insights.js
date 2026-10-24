// Tim kiem lich su (Huong 2), thong ke (Huong 4), AI tom tat (Huong 3). Moi API kiem tra thanh vien hoi thoai.
const express = require('express');
const search = require('../services/search.service');
const stats = require('../services/stats.service');
const ai = require('../services/ai.service');
const { rateLimit } = require('../middleware/security');

const router = express.Router();
const perUser = (windowMs, max, message) => rateLimit({ windowMs, max, key: req => req.user.userId, message });
const searchLimiter = perUser(60 * 1000, Number(process.env.SEARCH_RATE_LIMIT || 60), 'Bạn tìm kiếm quá nhanh, hãy chờ một chút.');
const aiLimiter = perUser(10 * 60 * 1000, Number(process.env.AI_RATE_LIMIT || 10), 'Bạn đã dùng AI quá nhiều lần, hãy thử lại sau ít phút.');

router.get('/search/messages', searchLimiter, async (req, res) => res.json(await search.searchMessages(req.user, req.query)));

router.get('/conversations/:conversationId/analytics', async (req, res) =>
    res.json(await stats.conversationAnalytics(req.params.conversationId, req.user, req.query)));
router.get('/me/analytics', async (req, res) => res.json(await stats.socialAnalytics(req.user)));

router.get('/ai/status', async (req, res) => res.json(ai.status()));
router.get('/conversations/:conversationId/ai', async (req, res) => res.json(await ai.overview(req.params.conversationId, req.user)));
router.post('/conversations/:conversationId/ai/summaries', aiLimiter, async (req, res) =>
    res.status(201).json(await ai.summarize(req.params.conversationId, req.user, req.body || {})));
router.patch('/conversations/:conversationId/ai/tasks/:taskId', async (req, res) =>
    res.json(await ai.updateTask(req.params.conversationId, req.params.taskId, req.user, req.body || {})));

module.exports = router;
