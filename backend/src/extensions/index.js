// Diem gan DUY NHAT cac chuc nang moi (PT-01..PT-26, NFR-13/16/18) vao ung dung Express co san.
// app.js chi them vai dong goi cac ham duoi day; ma nguon cac route / service cu khong bi sua.
//
//   mountEarly(app)     : so lieu Prometheus + log JSON, GET /metrics           (truoc moi route)
//   mountUploads(app)   : route tai tep moi (body nhi phan)                      (truoc originGuard)
//   mountPublic(app)    : quen / dat lai mat khau, xac thuc 2 lop, hook dang nhap (truoc authRouter)
//   mountAuthed(app)    : session guard, bo sung route cu, route moi            (sau requireAuth)
//   startBackground()   : job nen (nhac han cong viec, lan cuoi truy cap, Redis) - chi khi chay that
const express = require('express');
const { requireAuth, rejectSpoofedIdentity } = require('../middleware/auth');
const { allowedOrigins, rateLimit } = require('../middleware/security');
const { httpError } = require('../utils/httpError');
const { normalizeEmail } = require('../utils/validate');
const { afterJson, decorateJson, beforeHandler } = require('./lib/intercept');
const security = require('./security.service');
const profile = require('./profile.service');
const groups = require('./group.service');
const msgx = require('./message-extras.service');
const socialx = require('./social-extras.service');
const notifyx = require('./notify-extras.service');
const metrics = require('./metrics');
const routes = require('./routes');
const workRoutes = require('./work-routes');

// Bang cua migration 009-012: backend tu choi khoi dong neu thieu (giong bang cu).
const REQUIRED_TABLES = [
    'account_security', 'sessions_by_user', 'password_reset_tokens', 'email_verification_codes', 'user_media', 'user_last_seen',
    'message_meta_by_conversation', 'message_edits_by_message', 'conversation_members', 'group_owner_claims', 'group_profiles',
    'conversation_prefs_by_user', 'mentions_by_user', 'group_invite_links', 'invite_links_by_conversation', 'group_join_requests',
    'polls_by_conversation', 'poll_votes',
    'saved_posts_by_user', 'saved_post_keys', 'stories_by_author', 'story_views', 'posts_by_hashtag', 'hashtags_by_post',
    'notification_settings_by_user', 'push_subscriptions_by_user', 'task_reminders_by_day',
    'reports', 'reports_by_status', 'report_keys', 'moderation_log', 'moderation_state',
    // migration 013
    'story_reactions', 'story_styles', 'ai_chat_by_user',
    // migration 014-015: cong viec, lich, nhac nho, hop truc tuyen
    'tasks', 'tasks_by_user', 'tasks_by_group', 'task_comments_by_task', 'task_history_by_task', 'calendar_events', 'events_by_user_day',
    'events_by_group_day', 'schedule_locks', 'idempotency_keys', 'reminders', 'reminders_by_user', 'reminders_by_target', 'reminders_due',
    'notification_refs', 'meetings', 'meetings_by_user', 'meetings_by_group', 'meeting_invitations', 'meeting_links', 'meeting_participation',
    // migration 016: cam xuc binh luan
    'comment_reactions'
];

function installHooks() {
    require('./storage-hooks').installStorageHooks();
    notifyx.installNotificationHooks();
    profile.installPresencePersistence();
}

function mountEarly(app) {
    installHooks();
    app.use(metrics.middleware());
    app.get('/metrics', metrics.handler);
}

// ===== Tai tep (truoc originGuard vi body khong phai JSON) =====
function uploadOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins().includes(origin)) return next(httpError(403, 'FORBIDDEN_ORIGIN', 'Nguồn gửi yêu cầu không được phép.'));
    return next();
}

const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: Number(process.env.UPLOAD_RATE_LIMIT || 60),
    key: req => req.user.userId, message: 'Bạn tải lên quá nhiều tệp, hãy thử lại sau.'
});
const raw = limitMb => express.raw({ type: () => true, limit: limitMb * 1024 * 1024 + 1024 });
const bufferOf = req => (Buffer.isBuffer(req.body) ? req.body : null);
const header = (req, name) => {
    try { return decodeURIComponent(String(req.headers[name] || '')); } catch { return ''; }
};

function mountUploads(app) {
    const chain = (mb) => [uploadOrigin, requireAuth, rejectSpoofedIdentity, security.guard(), uploadLimiter, raw(mb)];
    app.post('/api/v1/me/avatar', ...chain(5), async (req, res) =>
        res.status(201).json(await profile.uploadProfileImage(req.user, 'avatar', bufferOf(req))));
    app.post('/api/v1/me/cover', ...chain(8), async (req, res) =>
        res.status(201).json(await profile.uploadProfileImage(req.user, 'cover', bufferOf(req))));
    app.post('/api/v1/conversations/:conversationId/avatar', ...chain(5), async (req, res) =>
        res.status(201).json(await groups.uploadAvatar(req.params.conversationId, req.user, bufferOf(req))));
    app.post('/api/v1/conversations/:conversationId/voice', ...chain(3), async (req, res) =>
        res.status(201).json(await msgx.sendVoice(req.params.conversationId, req.user, {
            buffer: bufferOf(req), durationMs: req.headers['x-duration-ms']
        })));
    app.post('/api/v1/stories/media', ...chain(8), async (req, res) =>
        res.status(201).json(await socialx.createStory(req.user, {
            buffer: bufferOf(req), content: header(req, 'x-story-text'), background: header(req, 'x-story-background'),
            font: header(req, 'x-story-font'), textColor: header(req, 'x-story-text-color'), textAlign: header(req, 'x-story-text-align')
        })));
}

// ===== Cong khai / phien chua day du =====
const ip = req => req.ip || req.socket?.remoteAddress || 'unknown';
const forgotLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: Number(process.env.FORGOT_RATE_LIMIT || 5),
    key: req => `${ip(req)}|${normalizeEmail(req.body?.email)}`, code: 'TOO_MANY_ATTEMPTS',
    message: 'Bạn đã yêu cầu đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau.'
});
const resetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20, key: req => ip(req), code: 'TOO_MANY_ATTEMPTS',
    message: 'Có quá nhiều lần thử đặt lại mật khẩu. Vui lòng thử lại sau.'
});

const passwordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: Number(process.env.ACCOUNT_RATE_LIMIT || 20), key: req => req.user.userId,
    message: 'Bạn thao tác quá nhiều lần, hãy thử lại sau ít phút.'
});

function mountPublic(app) {
    // Doi mat khau theo duong dan trong SRS (muc 6.3); giong POST /me/password.
    app.post('/api/v1/auth/password/change', requireAuth, rejectSpoofedIdentity, security.guard(), passwordLimiter, async (req, res) =>
        res.json(await security.changePassword(req.user, req.sessionHash, req.body || {})));
    app.post('/api/v1/auth/password/forgot', forgotLimiter, async (req, res) => res.json(await security.requestPasswordReset(req.body || {})));
    app.post('/api/v1/auth/password/reset', resetLimiter, async (req, res) => res.json(await security.resetPassword(req.body || {})));
    app.post('/api/v1/auth/2fa/verify', requireAuth, async (req, res) =>
        res.json(await security.verifyTwoFactorLogin(req.user, req.sessionHash, req.body || {})));
    // /auth/me cu: them guard (tai khoan bi khoa, phien bi huy, 2FA) roi chuyen tiep cho route cu.
    app.get('/api/v1/auth/me', requireAuth, security.guard());
    // Ghi nho email cua tai khoan khi dang nhap (users.email co the trong voi du lieu cu).
    app.post('/api/v1/auth/login', afterJson(body => body.user && security.rememberEmail(body.user.userId, body.user.email)));
    app.post('/api/v1/auth/register', afterJson(body => security.onRegistered(body)));
}

// ===== Sau requireAuth =====
function deputyIntercept(fn) {
    return async (req, res, next) => {
        const result = await fn(req);
        if (result === null) return next();
        return res.json(result);
    };
}

function mountAuthed(app) {
    app.use('/api/v1', security.guard());

    // Tin nhan: gan extra cho trang tin; sau khi gui -> nhac ten + xem truoc lien ket.
    app.get('/api/v1/conversations/:conversationId/messages', decorateJson(msgx.decorateMessagePage));
    app.post('/api/v1/conversations/:conversationId/messages', afterJson(msgx.afterSend));
    // Pho nhom doi ten / xoa thanh vien (truong nhom va thanh vien thuong: route cu xu ly).
    app.patch('/api/v1/conversations/:conversationId',
        deputyIntercept(req => groups.deputyRename(req.params.conversationId, req.user, req.body || {})));
    app.delete('/api/v1/conversations/:conversationId/members/:memberId',
        deputyIntercept(req => groups.deputyRemove(req.params.conversationId, req.user, req.params.memberId)));
    // Nhac han cong viec AI da xac nhan.
    app.patch('/api/v1/conversations/:conversationId/ai/tasks/:taskId',
        beforeHandler(notifyx.readTaskBefore), afterJson((body, req) => notifyx.syncTaskReminder(req)));
    // Bai viet: trang thai da luu + hashtag.
    app.get(['/api/v1/feed', '/api/v1/users/:userId/posts', '/api/v1/posts/:postId'], decorateJson(socialx.decoratePosts));
    app.post(['/api/v1/posts', '/api/v1/posts/:postId/share'], afterJson(body => socialx.indexPostHashtags(body)));
    // Thong bao ban be khi dang bai moi.
    app.post('/api/v1/posts', afterJson((body, req) => socialx.notifyFriendsOfPost(body, req.user)));
    app.patch('/api/v1/posts/:postId', afterJson(body => socialx.indexPostHashtags(body)));
    app.delete('/api/v1/posts/:postId', afterJson(body => socialx.indexPostHashtags(body)));
    // Ho so: them anh bia.
    app.get(['/api/v1/me/profile', '/api/v1/users/:userId/profile'],
        decorateJson(async body => (body.userId ? { ...body, ...(await profile.coverInfo(body.userId)) } : body)));

    // Thong bao: gan doi tuong lien quan (cong viec / cuoc hop) de mo dung man hinh.
    app.get('/api/v1/notifications', decorateJson(notifyx.decorateNotifications));
    // Binh luan bai viet: gan tong hop cam xuc cho tung binh luan.
    app.get(['/api/v1/posts/:postId/comments', '/api/v1/posts/:postId/comments/:commentId/replies'],
        decorateJson(require('./comment-reactions.service').decorateComments));

    app.use('/api/v1', routes);
    app.use('/api/v1', workRoutes);
}

let backgroundStarted = false;
async function startBackground() {
    if (backgroundStarted) return;
    backgroundStarted = true;
    notifyx.startReminderScheduler();
    require('./reminder.service').startWorker();
    profile.loadPersistedPresence().catch(error => console.warn('[ext] Không tải được lần cuối truy cập:', error.message));
    await require('./lib/redisRateLimit').connect().catch(error => console.warn('[redis] Không kết nối được (giới hạn tốc độ):', error.message));
    await require('./realtime-redis').installRedisBridge().catch(error => console.warn('[redis] Không kết nối được:', error.message));
}

module.exports = { REQUIRED_TABLES, mountEarly, mountUploads, mountPublic, mountAuthed, startBackground, installHooks };
