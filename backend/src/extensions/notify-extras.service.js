// Thong bao mo rong: PT-25 cai dat loai thong bao, PT-11 tat thong bao hoi thoai,
// PT-14 Web Push, PT-15 nhac han cong viec AI.
//
// Khong sua notification.service: boc ham notifySafe (moi noi goi deu qua notifications.notifySafe)
// de (1) bo qua thong bao nguoi nhan da tat, (2) day Web Push khi nguoi nhan khong mo tab.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { Uuid, TimeUuid } = require('../utils/types');
const { localParts } = require('../utils/searchTerms');
const realtime = require('../services/realtime.service');
const userService = require('../services/user.service');
const notificationService = require('../services/notification.service');

const EXTRA_TYPES = ['MENTION', 'TASK_DUE', 'GROUP_JOIN_REQUEST', 'REPORT_UPDATE'];
const ALL_TYPES = () => notificationService.TYPES.slice();

const TYPE_TEXT = {
    POST_REACTION: 'đã bày tỏ cảm xúc về bài viết của bạn',
    POST_COMMENT: 'đã bình luận bài viết của bạn',
    COMMENT_REPLY: 'đã trả lời bình luận của bạn',
    POST_SHARE: 'đã chia sẻ bài viết của bạn',
    FRIEND_REQUEST: 'đã gửi cho bạn lời mời kết bạn',
    FRIEND_ACCEPT: 'đã chấp nhận lời mời kết bạn',
    MESSAGE: 'đã gửi tin nhắn',
    MENTION: 'đã nhắc đến bạn',
    TASK_DUE: 'Công việc sắp đến hạn',
    GROUP_JOIN_REQUEST: 'muốn tham gia nhóm',
    REPORT_UPDATE: 'Báo cáo của bạn đã được xử lý'
};

// ===== PT-25 =====
async function getSettings(user) {
    const rs = await db.execute('SELECT type, enabled FROM notification_settings_by_user WHERE user_id = ?', [user.userId]);
    const off = new Set(rs.rows.filter(r => r.enabled === false).map(r => r.type));
    return { types: Object.fromEntries(ALL_TYPES().map(t => [t, !off.has(t)])) };
}

async function updateSettings(user, body = {}) {
    const types = body.types && typeof body.types === 'object' ? body.types : null;
    if (!types) throw httpError(400, 'INVALID_SETTINGS', 'Cần gửi { types: { LOẠI: true|false } }.');
    for (const [type, enabled] of Object.entries(types)) {
        if (!ALL_TYPES().includes(type) || typeof enabled !== 'boolean') throw httpError(400, 'INVALID_SETTINGS', `Loại thông báo không hợp lệ: ${type}`);
        await db.execute('INSERT INTO notification_settings_by_user (user_id, type, enabled) VALUES (?, ?, ?)', [user.userId, type, enabled]);
    }
    return getSettings(user);
}

async function typeEnabled(userId, type) {
    const r = (await db.execute('SELECT enabled FROM notification_settings_by_user WHERE user_id = ? AND type = ?', [userId, type])).first();
    return !(r && r.enabled === false);
}

async function shouldDeliver(ev) {
    if (!ev || !ev.recipientId) return true;
    if (!(await typeEnabled(ev.recipientId, ev.type))) return false;
    if (ev.type === 'MESSAGE' && ev.conversationId) {
        if (await require('./group.service').isMuted(ev.recipientId, ev.conversationId)) return false;
    }
    return true;
}

// ===== PT-14: Web Push =====
let webpush = null;
let vapid = null;
function loadWebPush() {
    if (webpush !== null) return webpush || null;
    try {
        // eslint-disable-next-line global-require
        webpush = require('web-push');
    } catch {
        webpush = false;
        return null;
    }
    let pub = process.env.VAPID_PUBLIC_KEY;
    let priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) {
        const file = path.resolve(__dirname, '../../../storage/vapid.json');
        try {
            ({ publicKey: pub, privateKey: priv } = JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
            const keys = webpush.generateVAPIDKeys();
            pub = keys.publicKey;
            priv = keys.privateKey;
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
            } catch (error) {
                console.warn('[push] Không lưu được khóa VAPID:', error.message);
            }
        }
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@chatott.local', pub, priv);
    vapid = { publicKey: pub };
    return webpush;
}

function pushStatus() {
    const lib = process.env.NODE_ENV === 'test' ? null : loadWebPush();
    return { available: Boolean(lib), publicKey: lib ? vapid.publicKey : null,
        message: lib ? null : 'Máy chủ chưa cài web-push (npm install web-push) nên chưa gửi được thông báo đẩy.' };
}

const endpointHash = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 40);

async function subscribe(user, body = {}, ua = '') {
    const endpoint = String(body.endpoint || '');
    const keys = body.keys || {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !keys.p256dh || !keys.auth) {
        throw httpError(400, 'INVALID_SUBSCRIPTION', 'Thông tin đăng ký thông báo đẩy không hợp lệ.');
    }
    await db.execute(
        'INSERT INTO push_subscriptions_by_user (user_id, endpoint_hash, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [user.userId, endpointHash(endpoint), endpoint, String(keys.p256dh).slice(0, 200), String(keys.auth).slice(0, 100), String(ua).slice(0, 300), new Date()]);
    return { subscribed: true };
}

async function unsubscribe(user, body = {}) {
    const endpoint = String(body.endpoint || '');
    if (endpoint) await db.execute('DELETE FROM push_subscriptions_by_user WHERE user_id = ? AND endpoint_hash = ?', [user.userId, endpointHash(endpoint)]);
    return { subscribed: false };
}

async function sendPush(userId, payload) {
    const lib = loadWebPush();
    if (!lib) return 0;
    const subs = (await db.execute('SELECT endpoint_hash, endpoint, p256dh, auth FROM push_subscriptions_by_user WHERE user_id = ?', [userId])).rows;
    let sent = 0;
    for (const s of subs) {
        try {
            await lib.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
            sent += 1;
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                await db.execute('DELETE FROM push_subscriptions_by_user WHERE user_id = ? AND endpoint_hash = ?', [userId, s.endpoint_hash]).catch(() => {});
            }
        }
    }
    return sent;
}

async function pushIfOffline(ev) {
    if (process.env.NODE_ENV === 'test' || realtime.isOnline(ev.recipientId)) return;
    const actor = ev.actorId ? (await userService.getUsersByIds([ev.actorId])).get(ev.actorId) : null;
    const isTask = ev.type === 'TASK_DUE' || ev.type === 'REPORT_UPDATE';
    await sendPush(ev.recipientId, {
        title: isTask ? 'ChatOTT' : (actor ? actor.displayName : 'ChatOTT'),
        body: isTask ? `${TYPE_TEXT[ev.type]}: ${ev.preview || ''}` : `${TYPE_TEXT[ev.type] || ''}${ev.preview ? ': ' + ev.preview : ''}`,
        tag: ev.dedupeKey ? String(ev.dedupeKey).split(':').slice(0, 2).join(':') : ev.type,
        url: ev.conversationId ? `/?conversation=${ev.conversationId}` : '/'
    });
}

// ===== Boc notifySafe =====
function installNotificationHooks() {
    if (notificationService.__extended) return;
    EXTRA_TYPES.forEach(t => { if (!notificationService.TYPES.includes(t)) notificationService.TYPES.push(t); });
    const original = notificationService.notifySafe;
    notificationService.notifySafe = async ev => {
        try {
            if (!(await shouldDeliver(ev))) return null;
        } catch (error) {
            console.warn('[ext] Không đọc được cài đặt thông báo:', error.message);
        }
        const id = await original(ev);
        if (id) pushIfOffline(ev).catch(error => console.warn('[push] Lỗi gửi thông báo đẩy:', error.message));
        return id;
    };
    notificationService.__extended = true;
}

// ===== PT-15: nhac han cong viec AI =====
// Goi sau PATCH .../ai/tasks/:taskId (afterJson). req.extBefore = dong cong viec TRUOC khi sua.
async function syncTaskReminder(req) {
    const cid = Uuid.fromString(String(req.params.conversationId).toLowerCase());
    const tid = TimeUuid.fromString(String(req.params.taskId));
    const now = (await db.execute('SELECT title, assignee_id, due_date, status FROM ai_tasks_by_conversation WHERE conversation_id = ? AND task_id = ?', [cid, tid])).first();
    const before = req.extBefore;
    if (before && before.due_date && (!now || before.due_date !== now.due_date || now.status !== 'CONFIRMED')) {
        await db.execute('DELETE FROM task_reminders_by_day WHERE due_day = ? AND task_id = ?', [before.due_date, tid]);
    }
    if (now && now.status === 'CONFIRMED' && now.due_date) {
        const existing = (await db.execute('SELECT reminded FROM task_reminders_by_day WHERE due_day = ? AND task_id = ?', [now.due_date, tid])).first();
        await db.execute(
            'INSERT INTO task_reminders_by_day (due_day, task_id, conversation_id, title, assignee_id, reminded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [now.due_date, tid, cid, now.title, now.assignee_id || null, Boolean(existing && existing.reminded), new Date()]);
    }
}

async function readTaskBefore(req) {
    const cid = Uuid.fromString(String(req.params.conversationId).toLowerCase());
    const tid = TimeUuid.fromString(String(req.params.taskId));
    return (await db.execute('SELECT due_date, status FROM ai_tasks_by_conversation WHERE conversation_id = ? AND task_id = ?', [cid, tid])).first();
}

// Doc cac ngay hom qua / hom nay / ngay mai: cong viec chua nhac -> LWT reminded false -> true roi gui thong bao.
async function runReminders(now = Date.now()) {
    const days = [-1, 0, 1].map(d => localParts(now + d * 86400000).day);
    let sent = 0;
    for (const day of days) {
        const rows = (await db.execute('SELECT due_day, task_id, conversation_id, title, assignee_id, reminded FROM task_reminders_by_day WHERE due_day = ?', [day])).rows;
        for (const r of rows) {
            if (r.reminded) continue;
            const claim = await db.execute('UPDATE task_reminders_by_day SET reminded = true WHERE due_day = ? AND task_id = ? IF reminded = false', [day, r.task_id]);
            if (!claim.wasApplied()) continue;
            const task = (await db.execute('SELECT status FROM ai_tasks_by_conversation WHERE conversation_id = ? AND task_id = ?', [r.conversation_id, r.task_id])).first();
            if (!task || task.status !== 'CONFIRMED') continue;
            const conv = (await db.execute('SELECT participant_ids FROM conversations WHERE conversation_id = ?', [r.conversation_id])).first();
            const members = conv ? [...(conv.participant_ids || [])].map(String) : [];
            const recipients = r.assignee_id && members.includes(r.assignee_id) ? [r.assignee_id] : members;
            for (const recipientId of recipients) {
                await notificationService.notifySafe({
                    recipientId, actorId: 'system', type: 'TASK_DUE', dedupeKey: `TASK_DUE:${r.task_id}:${recipientId}`,
                    conversationId: r.conversation_id, preview: `Hạn ${day}: ${r.title}`
                });
                sent += 1;
            }
        }
    }
    return { checkedDays: days, sent };
}

let timer = null;
function startReminderScheduler() {
    if (timer || process.env.TASK_REMINDERS === 'false') return;
    const every = Math.max(1, Number(process.env.TASK_REMINDER_INTERVAL_MINUTES || 15)) * 60 * 1000;
    const tick = () => runReminders().then(r => r.sent && console.log(`[nhắc hạn] Đã gửi ${r.sent} nhắc hạn công việc.`))
        .catch(error => console.warn('[nhắc hạn] Lỗi:', error.message));
    setTimeout(tick, 5000).unref();
    timer = setInterval(tick, every);
    timer.unref();
}

module.exports = {
    EXTRA_TYPES, getSettings, updateSettings, shouldDeliver, pushStatus, subscribe, unsubscribe, sendPush,
    installNotificationHooks, syncTaskReminder, readTaskBefore, runReminders, startReminderScheduler
};
