// Route phan he Cong viec & Lich, Nhac nho, Hop truc tuyen (tien to /api/v1, sau requireAuth + session guard).
// Danh tinh luon lay tu phien (req.user); body khong duoc khai bao nguoi dung khac.
const express = require('express');
const { rateLimit } = require('../middleware/security');
const tasks = require('./task.service');
const cal = require('./calendar.service');
const reminders = require('./reminder.service');
const meetings = require('./meeting.service');
const idem = require('./lib/idempotency');

const perUser = (windowMs, max, message) => rateLimit({ windowMs, max, key: req => req.user.userId, message });
const writeLimiter = perUser(60 * 1000, Number(process.env.WORK_RATE_LIMIT || 120), 'Bạn thao tác quá nhanh, hãy chờ một chút.');
const signalLimiter = perUser(60 * 1000, Number(process.env.SIGNAL_RATE_LIMIT || 1200), 'Tín hiệu phòng họp gửi quá nhanh.');
const chatLimiter = perUser(10 * 1000, 20, 'Bạn gửi tin quá nhanh, hãy chờ vài giây.');

const router = express.Router();
const body = req => req.body || {};

// ----- Cong viec -----
router.get('/work/overview', async (req, res) => res.json(await tasks.overview(req.user)));
router.get('/tasks', async (req, res) => res.json(await tasks.listMine(req.user, req.query)));
router.post('/tasks', writeLimiter, async (req, res) =>
    res.status(201).json(await tasks.createTask(req.user, body(req), { idemKey: idem.keyOf(req, body(req)) })));
router.get('/tasks/:taskId', async (req, res) => res.json(await tasks.getTask(req.user, req.params.taskId)));
router.patch('/tasks/:taskId', writeLimiter, async (req, res) => res.json(await tasks.updateTask(req.user, req.params.taskId, body(req))));
router.post('/tasks/:taskId/status', writeLimiter, async (req, res) => res.json(await tasks.setStatus(req.user, req.params.taskId, body(req))));
router.delete('/tasks/:taskId', writeLimiter, async (req, res) => res.json(await tasks.cancelTask(req.user, req.params.taskId)));
router.post('/tasks/:taskId/sessions', writeLimiter, async (req, res) => res.status(201).json(await tasks.addSession(req.user, req.params.taskId, body(req))));
router.delete('/tasks/:taskId/sessions/:eventId', writeLimiter, async (req, res) =>
    res.json(await tasks.removeSession(req.user, req.params.taskId, req.params.eventId)));
router.get('/tasks/:taskId/comments', async (req, res) => res.json(await tasks.listComments(req.user, req.params.taskId)));
router.post('/tasks/:taskId/comments', writeLimiter, async (req, res) => res.status(201).json(await tasks.addComment(req.user, req.params.taskId, body(req))));
router.patch('/tasks/:taskId/comments/:commentId', writeLimiter, async (req, res) =>
    res.json(await tasks.editComment(req.user, req.params.taskId, req.params.commentId, body(req))));
router.delete('/tasks/:taskId/comments/:commentId', writeLimiter, async (req, res) =>
    res.json(await tasks.editComment(req.user, req.params.taskId, req.params.commentId, {}, true)));
router.get('/tasks/:taskId/history', async (req, res) => res.json(await tasks.listHistory(req.user, req.params.taskId)));
router.get('/groups/:conversationId/tasks', async (req, res) => res.json(await tasks.listGroup(req.user, req.params.conversationId, req.query)));

// ----- Lich -----
router.get('/calendar', async (req, res) => res.json(await cal.userCalendar(req.user, req.query)));
router.get('/groups/:conversationId/calendar', async (req, res) => res.json(await cal.groupCalendar(req.user, req.params.conversationId, req.query)));
router.get('/calendar/availability', async (req, res) => res.json(await cal.availability(req.user, req.query)));
router.post('/calendar/check', async (req, res) => res.json(await cal.checkConflicts(req.user, body(req))));
router.post('/calendar/events', writeLimiter, async (req, res) => res.status(201).json(await cal.createPersonalEvent(req.user, body(req))));
router.patch('/calendar/events/:eventId', writeLimiter, async (req, res) => res.json(await cal.moveEvent(req.user, req.params.eventId, body(req))));
router.delete('/calendar/events/:eventId', writeLimiter, async (req, res) => res.json(await cal.cancelPersonalEvent(req.user, req.params.eventId)));

// ----- Nhac nho -----
router.get('/reminders', async (req, res) => res.json(await reminders.listReminders(req.user, req.query)));
router.post('/reminders', writeLimiter, async (req, res) => res.status(201).json(await reminders.createReminder(req.user, body(req))));
router.patch('/reminders/:reminderId', writeLimiter, async (req, res) => res.json(await reminders.updateReminder(req.user, req.params.reminderId, body(req))));
router.post('/reminders/:reminderId/snooze', writeLimiter, async (req, res) => res.json(await reminders.snooze(req.user, req.params.reminderId, body(req))));
router.delete('/reminders/:reminderId', writeLimiter, async (req, res) => res.json(await reminders.cancelReminder(req.user, req.params.reminderId)));

// ----- Hop truc tuyen -----
router.get('/meetings', async (req, res) => res.json(await meetings.listMine(req.user, req.query)));
router.post('/meetings', writeLimiter, async (req, res) =>
    res.status(201).json(await meetings.createMeeting(req.user, body(req), { idemKey: idem.keyOf(req, body(req)) })));
router.post('/meetings/links/:code', writeLimiter, async (req, res) => res.json(await meetings.joinByLink(req.user, req.params.code)));
router.get('/groups/:conversationId/meetings', async (req, res) => res.json(await meetings.listGroup(req.user, req.params.conversationId)));
router.get('/meetings/:meetingId', async (req, res) => res.json(await meetings.getMeeting(req.user, req.params.meetingId)));
router.patch('/meetings/:meetingId', writeLimiter, async (req, res) => res.json(await meetings.reschedule(req.user, req.params.meetingId, body(req))));
router.delete('/meetings/:meetingId', writeLimiter, async (req, res) => res.json(await meetings.cancelMeeting(req.user, req.params.meetingId)));
router.post('/meetings/:meetingId/invitations', writeLimiter, async (req, res) => res.json(await meetings.invite(req.user, req.params.meetingId, body(req))));
router.post('/meetings/:meetingId/respond', writeLimiter, async (req, res) => res.json(await meetings.respond(req.user, req.params.meetingId, body(req))));
router.post('/meetings/:meetingId/link', writeLimiter, async (req, res) => res.json(await meetings.createLink(req.user, req.params.meetingId)));
router.delete('/meetings/:meetingId/link', writeLimiter, async (req, res) => res.json(await meetings.revokeLink(req.user, req.params.meetingId)));
router.post('/meetings/:meetingId/end', writeLimiter, async (req, res) => res.json(await meetings.endMeeting(req.user, req.params.meetingId)));
router.get('/meetings/:meetingId/participants', async (req, res) => res.json(await meetings.liveParticipants(req.user, req.params.meetingId)));
router.get('/meetings/:meetingId/history', async (req, res) => res.json(await meetings.participationHistory(req.user, req.params.meetingId)));
// Phong hop: ma tham gia trong header X-Meeting-Token (khong dua len URL).
router.post('/meetings/:meetingId/join', writeLimiter, async (req, res) => res.json(await meetings.join(req.user, req.params.meetingId, body(req))));
router.post('/meetings/:meetingId/signal', signalLimiter, async (req, res) =>
    res.json(await meetings.signal(req.user, req.params.meetingId, meetings.tokenFrom(req, body(req)), body(req))));
router.post('/meetings/:meetingId/heartbeat', signalLimiter, async (req, res) =>
    res.json(await meetings.heartbeat(req.user, req.params.meetingId, meetings.tokenFrom(req, body(req)))));
router.post('/meetings/:meetingId/media', signalLimiter, async (req, res) =>
    res.json(await meetings.setMedia(req.user, req.params.meetingId, meetings.tokenFrom(req, body(req)), body(req))));
router.post('/meetings/:meetingId/chat', chatLimiter, async (req, res) =>
    res.json(await meetings.chat(req.user, req.params.meetingId, meetings.tokenFrom(req, body(req)), body(req))));
router.post('/meetings/:meetingId/leave', async (req, res) =>
    res.json(await meetings.leave(req.user, req.params.meetingId, meetings.tokenFrom(req, body(req)))));

module.exports = router;
