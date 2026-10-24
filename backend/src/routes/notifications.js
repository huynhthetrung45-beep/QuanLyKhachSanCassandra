// Thong bao cua CHINH nguoi dang nhap (doc partition user_id = req.user.userId).
const express = require('express');
const notifications = require('../services/notification.service');

const router = express.Router();
router.get('/notifications', async (req, res) => res.json(await notifications.list(req.user, req.query.pageToken)));
router.get('/notifications/unread-count', async (req, res) => res.json({ unreadCount: await notifications.unreadCount(req.user.userId) }));
router.post('/notifications/read-all', async (req, res) => res.json(await notifications.markAllRead(req.user)));
router.post('/notifications/:notificationId/read', async (req, res) => res.json(await notifications.markRead(req.user, req.params.notificationId)));
module.exports = router;
