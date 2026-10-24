// Route cua cac chuc nang moi (tien to /api/v1). Moi route sau requireAuth + session guard,
// danh tinh lay tu phien (req.user), khong tu body.
const express = require('express');
const { rateLimit } = require('../middleware/security');
const security = require('./security.service');
const profile = require('./profile.service');
const groups = require('./group.service');
const msgx = require('./message-extras.service');
const socialx = require('./social-extras.service');
const notifyx = require('./notify-extras.service');
const moderation = require('./moderation.service');
const aix = require('./ai-extras.service');
const assistant = require('./assistant.service');
const storage = require('./lib/storage');

const perUser = (windowMs, max, message) => rateLimit({ windowMs, max, key: req => req.user.userId, message });
const accountLimiter = perUser(15 * 60 * 1000, Number(process.env.ACCOUNT_RATE_LIMIT || 20), 'Bạn thao tác quá nhiều lần, hãy thử lại sau ít phút.');
const sendLimiter = perUser(10 * 1000, Number(process.env.SEND_RATE_LIMIT || 30), 'Bạn gửi tin quá nhanh, hãy chờ vài giây.');
const reportLimiter = perUser(60 * 60 * 1000, Number(process.env.REPORT_RATE_LIMIT || 30), 'Bạn gửi quá nhiều báo cáo, hãy thử lại sau.');
const aiLimiter = perUser(10 * 60 * 1000, Number(process.env.AI_RATE_LIMIT || 10) * 3, 'Bạn đã dùng AI quá nhiều lần, hãy thử lại sau ít phút.');

const router = express.Router();

// ----- Tai khoan & bao mat -----
router.get('/me/security', async (req, res) => res.json(await security.mySecurity(req.user, req.sessionHash)));
router.post('/me/password', accountLimiter, async (req, res) => res.json(await security.changePassword(req.user, req.sessionHash, req.body || {})));
router.patch('/me/display-name', accountLimiter, async (req, res) => res.json(await profile.changeDisplayName(req.user, req.body || {})));
router.get('/me/sessions', async (req, res) => res.json(await security.listSessions(req.user, req.sessionHash)));
router.delete('/me/sessions', accountLimiter, async (req, res) =>
    res.json({ revoked: await security.revokeAll(req.user.userId, req.sessionHash) }));
router.delete('/me/sessions/:sessionId', async (req, res) => res.json(await security.revokeSessionById(req.user, req.sessionHash, req.params.sessionId)));
router.post('/me/email/verification', accountLimiter, async (req, res) => res.json(await security.sendVerification(req.user)));
router.post('/me/email/verify', accountLimiter, async (req, res) => res.json(await security.verifyEmail(req.user, req.body || {})));
router.post('/me/2fa/setup', accountLimiter, async (req, res) => res.json(await security.setupTwoFactor(req.user)));
router.post('/me/2fa/enable', accountLimiter, async (req, res) => res.json(await security.enableTwoFactor(req.user, req.sessionHash, req.body || {})));
router.post('/me/2fa/disable', accountLimiter, async (req, res) => res.json(await security.disableTwoFactor(req.user, req.body || {})));

// ----- Ho so: anh, goi y ket ban -----
router.delete('/me/avatar', async (req, res) => res.json(await profile.removeProfileImage(req.user, 'avatar')));
router.delete('/me/cover', async (req, res) => res.json(await profile.removeProfileImage(req.user, 'cover')));
router.get('/users/:userId/avatar', async (req, res) => {
    const f = await profile.openProfileImage(req.user, req.params.userId, 'avatar');
    await storage.sendFile(res, 'profiles', f.key, f.mime, 86400);
});
router.get('/users/:userId/cover', async (req, res) => {
    const f = await profile.openProfileImage(req.user, req.params.userId, 'cover');
    await storage.sendFile(res, 'profiles', f.key, f.mime, 86400);
});
router.get('/avatars', async (req, res) => res.json(await profile.lookupAvatars(req.user, req.query.ids)));
router.get('/friends/suggestions', async (req, res) => res.json(await profile.suggestions(req.user)));

// ----- Nhom -----
router.get('/conversations/:conversationId/roles', async (req, res) => res.json(await groups.roles(req.params.conversationId, req.user)));
router.put('/conversations/:conversationId/members/:memberId/role', async (req, res) =>
    res.json(await groups.setRole(req.params.conversationId, req.user, req.params.memberId, req.body || {})));
router.post('/conversations/:conversationId/claim-owner', async (req, res) => res.json(await groups.claimOwner(req.params.conversationId, req.user)));
router.get('/conversations/:conversationId/profile', async (req, res) => res.json(await groups.getProfile(req.params.conversationId, req.user)));
router.patch('/conversations/:conversationId/profile', async (req, res) => res.json(await groups.updateProfile(req.params.conversationId, req.user, req.body || {})));
router.delete('/conversations/:conversationId/avatar', async (req, res) => res.json(await groups.removeAvatar(req.params.conversationId, req.user)));
router.get('/conversations/:conversationId/avatar', async (req, res) => {
    const f = await groups.openAvatar(req.params.conversationId, req.user);
    await storage.sendFile(res, 'groups', f.key, f.mime, 86400);
});
router.put('/conversations/:conversationId/prefs', async (req, res) => res.json(await groups.setPrefs(req.params.conversationId, req.user, req.body || {})));
router.get('/me/conversation-prefs', async (req, res) => res.json(await groups.listPrefs(req.user)));
router.get('/conversations/:conversationId/invites', async (req, res) => res.json(await groups.listInvites(req.params.conversationId, req.user)));
router.post('/conversations/:conversationId/invites', async (req, res) => res.status(201).json(await groups.createInvite(req.params.conversationId, req.user, req.body || {})));
router.delete('/conversations/:conversationId/invites/:code', async (req, res) => res.json(await groups.revokeInvite(req.params.conversationId, req.user, req.params.code)));
router.post('/conversations/:conversationId/join-requests/:userId/approve', async (req, res) =>
    res.json(await groups.decideJoin(req.params.conversationId, req.user, req.params.userId, true)));
router.post('/conversations/:conversationId/join-requests/:userId/decline', async (req, res) =>
    res.json(await groups.decideJoin(req.params.conversationId, req.user, req.params.userId, false)));
router.get('/invites/:code', async (req, res) => res.json(await groups.previewInvite(req.params.code, req.user)));
router.post('/invites/:code/join', async (req, res) => res.json(await groups.joinByInvite(req.params.code, req.user)));

// ----- Tin nhan mo rong -----
router.get('/stickers', (req, res) => res.json({ items: msgx.STICKERS }));
router.patch('/conversations/:conversationId/messages/:messageId', async (req, res) =>
    res.json(await msgx.editMessage(req.params.conversationId, req.params.messageId, req.user, req.body || {})));
router.get('/conversations/:conversationId/messages/:messageId/edits', async (req, res) =>
    res.json(await msgx.editHistory(req.params.conversationId, req.params.messageId, req.user)));
router.post('/conversations/:conversationId/stickers', sendLimiter, async (req, res) =>
    res.status(201).json(await msgx.sendSticker(req.params.conversationId, req.user, req.body || {})));
router.post('/conversations/:conversationId/polls', sendLimiter, async (req, res) =>
    res.status(201).json(await msgx.createPoll(req.params.conversationId, req.user, req.body || {})));
router.get('/conversations/:conversationId/polls/:pollId', async (req, res) => res.json(await msgx.getPoll(req.params.conversationId, req.params.pollId, req.user)));
router.put('/conversations/:conversationId/polls/:pollId/vote', async (req, res) =>
    res.json(await msgx.vote(req.params.conversationId, req.params.pollId, req.user, req.body || {})));
router.post('/conversations/:conversationId/polls/:pollId/close', async (req, res) =>
    res.json(await msgx.closePoll(req.params.conversationId, req.params.pollId, req.user)));
router.get('/me/mentions', async (req, res) => res.json(await msgx.listMentions(req.user)));

// ----- AI mo rong -----
router.post('/conversations/:conversationId/ai/reply-suggestions', aiLimiter, async (req, res) =>
    res.json(await aix.suggestReplies(req.params.conversationId, req.user)));
router.post('/conversations/:conversationId/messages/:messageId/translate', aiLimiter, async (req, res) =>
    res.json(await aix.translate(req.params.conversationId, req.params.messageId, req.user, req.body || {})));

// ----- Tro ly AI (Gemini) -----
router.get('/assistant', async (req, res) => res.json(await assistant.history(req.user)));
router.post('/assistant/messages', aiLimiter, async (req, res) => res.status(201).json(await assistant.ask(req.user, req.body || {})));
router.delete('/assistant', async (req, res) => res.json(await assistant.clear(req.user)));

// ----- Bai viet mo rong -----
router.put('/posts/:postId/save', async (req, res) => res.json(await socialx.savePost(req.user, req.params.postId)));
router.delete('/posts/:postId/save', async (req, res) => res.json(await socialx.unsavePost(req.user, req.params.postId)));
router.get('/me/saved-posts', async (req, res) => res.json(await socialx.listSaved(req.user, req.query.cursor)));
router.get('/hashtags/:tag/posts', async (req, res) => res.json(await socialx.postsByHashtag(req.user, req.params.tag, req.query.cursor)));
router.get('/stories', async (req, res) => res.json(await socialx.storyFeed(req.user)));
router.post('/stories', async (req, res) => res.status(201).json(await socialx.createStory(req.user, req.body || {})));
router.post('/stories/:authorId/:storyId/view', async (req, res) => res.json(await socialx.viewStory(req.user, req.params.authorId, req.params.storyId)));
router.get('/stories/mine/:storyId/viewers', async (req, res) => res.json(await socialx.storyViewers(req.user, req.params.storyId)));
router.put('/stories/:authorId/:storyId/reaction', async (req, res) => res.json(await socialx.reactStory(req.user, req.params.authorId, req.params.storyId, req.body || {})));
router.post('/stories/:authorId/:storyId/reply', sendLimiter, async (req, res) =>
    res.status(201).json(await socialx.replyStory(req.user, req.params.authorId, req.params.storyId, req.body || {})));
router.post('/stories/:authorId/:storyId/share', sendLimiter, async (req, res) =>
    res.status(201).json(await socialx.shareStory(req.user, req.params.authorId, req.params.storyId, req.body || {})));
router.delete('/stories/mine/:storyId', async (req, res) => res.json(await socialx.deleteStory(req.user, req.params.storyId)));
router.get('/stories/:authorId/:storyId/media', async (req, res) => {
    const f = await socialx.openStoryMedia(req.user, req.params.authorId, req.params.storyId);
    await storage.sendFile(res, 'stories', f.key, f.mime, 600);
});

// ----- Thong bao mo rong -----
router.get('/me/notification-settings', async (req, res) => res.json(await notifyx.getSettings(req.user)));
router.put('/me/notification-settings', async (req, res) => res.json(await notifyx.updateSettings(req.user, req.body || {})));
router.get('/push/status', (req, res) => res.json(notifyx.pushStatus()));
router.post('/push/subscriptions', async (req, res) => res.status(201).json(await notifyx.subscribe(req.user, req.body || {}, req.headers['user-agent'])));
router.delete('/push/subscriptions', async (req, res) => res.json(await notifyx.unsubscribe(req.user, req.body || {})));

// ----- Bao cao & quan tri -----
router.post('/reports', reportLimiter, async (req, res) => res.status(201).json(await moderation.createReport(req.user, req.body || {})));
router.get('/admin/overview', async (req, res) => res.json(await moderation.overview(req.user)));
router.get('/admin/reports', async (req, res) => res.json(await moderation.listReports(req.user, req.query)));
router.post('/admin/reports/:reportId/resolve', async (req, res) => res.json(await moderation.resolveReport(req.user, req.params.reportId, req.body || {})));
router.post('/admin/content/hide', async (req, res) => res.json(await moderation.hideContent(req.user, req.body || {}, true)));
router.post('/admin/content/restore', async (req, res) => res.json(await moderation.hideContent(req.user, req.body || {}, false)));
router.get('/admin/users', async (req, res) => res.json(await moderation.searchUsers(req.user, req.query)));
router.post('/admin/users/:userId/lock', async (req, res) => res.json(await moderation.lockUser(req.user, req.params.userId, req.body || {})));
router.post('/admin/users/:userId/unlock', async (req, res) => res.json(await moderation.unlockUser(req.user, req.params.userId)));
router.post('/admin/users/:userId/role', async (req, res) => res.json(await moderation.setUserRole(req.user, req.params.userId, req.body || {})));
router.get('/admin/moderation-log', async (req, res) => res.json(await moderation.moderationLog(req.user, req.query)));
router.post('/admin/conversations/:conversationId/owner', async (req, res) => {
    await moderation.requireAdmin(req.user);
    res.json(await groups.assignOwnerByAdmin(req.params.conversationId, req.user, String(req.body?.ownerId || '')));
});
router.post('/admin/reminders/run', async (req, res) => {
    await moderation.requireAdmin(req.user);
    res.json(await notifyx.runReminders());
});

module.exports = router;
