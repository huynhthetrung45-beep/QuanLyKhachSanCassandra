// Nhac nho ben vung (cong viec, lich, cuoc hop, nhac tuy chinh).
//
//  - reminders la bang nguon; reminders_due((bucket = gio UTC), fire_at, reminder_id) de worker chi doc vai partition gan day.
//  - Worker (startWorker) chay dinh ky trong backend, doc cac gio tu 48h truoc den hien tai, voi moi nhac den han:
//      1. Nhan viec bang LWT: PENDING -> PROCESSING (IF status = 'PENDING'). Nhieu tien trinh cung chay -> chi 1 tien trinh thang.
//         PROCESSING qua 5 phut (tien trinh chet giua chung) duoc nhan lai bang LWT IF claim_id = <cu>.
//      2. Kiem tra nguoi nhan con quyen xem doi tuong; doi tuong da huy -> CANCELLED.
//      3. Tao thong bao qua he thong thong bao co san voi dedupe_key = REMINDER:<id> (notification_keys LWT):
//         chay lai sau su co cung KHONG tao thong bao thu 2.
//      4. Thanh cong -> SENT. Loi -> thu lai toi da 3 lan (2, 4, 8 phut), sau do FAILED + last_error.
//  - Doi lich / huy doi tuong -> rescheduleTarget / cancelTarget cap nhat cac nhac lien quan.
//  - Khoi dong lai backend khong mat nhac (tat ca nam trong Cassandra).
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso } = require('../utils/types');

const TARGETS = ['TASK', 'EVENT', 'MEETING', 'CUSTOM'];
const ANCHORS = ['START', 'END', 'DUE'];
const MAX_ATTEMPTS = 3;
const STALE_MS = 5 * 60 * 1000;
const COLS = `reminder_id, user_id, target_type, target_id, offset_minutes, anchor, fire_at, note, status, attempts, claim_id, claimed_at,
              last_error, sent_at, created_at, updated_at`;

const bucketOf = d => new Date(d).toISOString().slice(0, 13); // YYYY-MM-DDTHH (UTC)

async function readReminder(id) {
    return (await db.execute(`SELECT ${COLS} FROM reminders WHERE reminder_id = ?`, [id])).first();
}

// ===== Doi tuong nhac =====
async function resolveTarget(user, targetType, targetId) {
    if (targetType === 'CUSTOM') return { title: null, times: {} };
    if (targetType === 'TASK') {
        const task = await require('./task.service').requireVisibleTask(user, targetId);
        return { title: task.title, times: { START: task.start_at, END: task.end_at, DUE: task.due_at }, alive: !['CANCELLED', 'DONE'].includes(task.status) };
    }
    if (targetType === 'EVENT') {
        const cal = require('./calendar.service');
        const ev = await cal.readEvent(TimeUuid.fromString(String(targetId)));
        if (!ev || !(await cal.canViewEvent(user.userId, ev))) throw httpError(404, 'EVENT_NOT_FOUND', 'Không tìm thấy lịch.');
        return { title: ev.title, times: { START: ev.start_at, END: ev.end_at }, alive: ev.status === 'ACTIVE' };
    }
    if (targetType === 'MEETING') {
        const m = await require('./meeting.service').requireMeetingAccess(user, targetId);
        return { title: m.title, times: { START: m.start_at, END: m.end_at }, alive: !['CANCELLED', 'ENDED'].includes(m.status) };
    }
    throw httpError(400, 'INVALID_TARGET', 'Loại nhắc nhở không hợp lệ.');
}

function computeFireAt(times, anchor, offsetMinutes) {
    const base = times[anchor];
    if (!base) return null;
    return new Date(new Date(base).getTime() - offsetMinutes * 60000);
}

function dto(r, title = null) {
    return {
        reminderId: r.reminder_id.toString(), targetType: r.target_type, targetId: r.target_id, title,
        anchor: r.anchor, offsetMinutes: r.offset_minutes, fireAt: iso(r.fire_at), note: r.note || '',
        status: r.status, attempts: r.attempts || 0, lastError: r.last_error || null, sentAt: iso(r.sent_at)
    };
}

async function moveDue(r, newFireAt) {
    if (r.fire_at) await db.execute('DELETE FROM reminders_due WHERE bucket = ? AND fire_at = ? AND reminder_id = ?', [bucketOf(r.fire_at), r.fire_at, r.reminder_id]);
    if (newFireAt) await db.execute('INSERT INTO reminders_due (bucket, fire_at, reminder_id) VALUES (?, ?, ?)', [bucketOf(newFireAt), newFireAt, r.reminder_id]);
}

function parseOffset(v) {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 60 * 24 * 30) throw httpError(400, 'INVALID_OFFSET', 'Nhắc trước 0 phút đến 30 ngày.');
    return n;
}

// ===== Tao / sua / huy =====
// body: { targetType, targetId, anchor = START, offsetMinutes, fireAt (CUSTOM hoac tuy chinh), note }
async function createReminder(user, body = {}, { allowPast = false } = {}) {
    const targetType = String(body.targetType || 'CUSTOM').toUpperCase();
    if (!TARGETS.includes(targetType)) throw httpError(400, 'INVALID_TARGET', 'Loại nhắc nhở không hợp lệ.');
    const targetId = targetType === 'CUSTOM' ? crypto.randomUUID() : String(body.targetId || '');
    const anchor = ANCHORS.includes(String(body.anchor || '').toUpperCase()) ? String(body.anchor).toUpperCase() : 'START';
    const offset = parseOffset(body.offsetMinutes);
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    const target = await resolveTarget(user, targetType, targetId);
    let fireAt;
    if (body.fireAt) {
        fireAt = new Date(body.fireAt);
        if (Number.isNaN(fireAt.getTime())) throw httpError(400, 'INVALID_TIME', 'Thời điểm nhắc không hợp lệ.');
    } else {
        fireAt = computeFireAt(target.times, anchor, offset);
        if (!fireAt) throw httpError(400, 'NO_ANCHOR_TIME', anchor === 'DUE' ? 'Công việc chưa có hạn hoàn thành.' : 'Đối tượng chưa có thời gian để nhắc.');
    }
    if (targetType === 'CUSTOM' && !note) throw httpError(400, 'INVALID_NOTE', 'Nhắc nhở tùy chỉnh cần có nội dung.');
    if (!allowPast && fireAt.getTime() < Date.now() - 60000) throw httpError(400, 'REMINDER_IN_PAST', 'Thời điểm nhắc đã qua.');
    const id = TimeUuid.now();
    const now = new Date();
    await db.execute(`INSERT INTO reminders (reminder_id, user_id, target_type, target_id, offset_minutes, anchor, fire_at, note, status, attempts, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
        [id, user.userId, targetType, targetId, offset, anchor, fireAt, note || null, now, now]);
    await db.execute('INSERT INTO reminders_by_user (user_id, reminder_id) VALUES (?, ?)', [user.userId, id]);
    if (targetType !== 'CUSTOM') await db.execute('INSERT INTO reminders_by_target (target_type, target_id, reminder_id) VALUES (?, ?, ?)', [targetType, targetId, id]);
    await db.execute('INSERT INTO reminders_due (bucket, fire_at, reminder_id) VALUES (?, ?, ?)', [bucketOf(fireAt), fireAt, id]);
    return dto(await readReminder(id), target.title);
}

async function requireOwn(user, reminderId) {
    let id;
    try { id = TimeUuid.fromString(String(reminderId)); } catch { throw httpError(400, 'INVALID_ID', 'Mã nhắc nhở không hợp lệ.'); }
    const r = await readReminder(id);
    if (!r || r.user_id !== user.userId) throw httpError(404, 'REMINDER_NOT_FOUND', 'Không tìm thấy nhắc nhở.');
    return r;
}

async function updateReminder(user, reminderId, body = {}) {
    const r = await requireOwn(user, reminderId);
    if (body.enabled === false) return cancelReminder(user, reminderId);
    let fireAt = r.fire_at;
    let offset = r.offset_minutes || 0;
    let anchor = r.anchor || 'START';
    if (body.fireAt) {
        fireAt = new Date(body.fireAt);
        if (Number.isNaN(fireAt.getTime())) throw httpError(400, 'INVALID_TIME', 'Thời điểm nhắc không hợp lệ.');
    } else if (body.offsetMinutes !== undefined || body.anchor !== undefined) {
        offset = parseOffset(body.offsetMinutes ?? offset);
        anchor = ANCHORS.includes(String(body.anchor || anchor).toUpperCase()) ? String(body.anchor || anchor).toUpperCase() : 'START';
        const target = await resolveTarget(user, r.target_type, r.target_id);
        fireAt = computeFireAt(target.times, anchor, offset);
        if (!fireAt) throw httpError(400, 'NO_ANCHOR_TIME', 'Đối tượng chưa có thời gian để nhắc.');
    }
    if (fireAt.getTime() < Date.now() - 60000) throw httpError(400, 'REMINDER_IN_PAST', 'Thời điểm nhắc đã qua.');
    const note = body.note !== undefined ? String(body.note).trim().slice(0, 300) : r.note;
    await db.execute(`UPDATE reminders SET fire_at = ?, offset_minutes = ?, anchor = ?, note = ?, status = 'PENDING', attempts = 0,
                      last_error = null, updated_at = ? WHERE reminder_id = ?`, [fireAt, offset, anchor, note || null, new Date(), r.reminder_id]);
    await moveDue(r, fireAt);
    return dto(await readReminder(r.reminder_id));
}

async function snooze(user, reminderId, body = {}) {
    const minutes = Number(body.minutes || 10);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw httpError(400, 'INVALID_OFFSET', 'Hoãn từ 1 phút đến 24 giờ.');
    return updateReminder(user, reminderId, { fireAt: new Date(Date.now() + minutes * 60000).toISOString() });
}

async function cancelReminder(user, reminderId) {
    const r = await requireOwn(user, reminderId);
    await db.execute("UPDATE reminders SET status = 'CANCELLED', updated_at = ? WHERE reminder_id = ?", [new Date(), r.reminder_id]);
    await moveDue(r, null);
    return dto({ ...r, status: 'CANCELLED' });
}

async function listReminders(user, query = {}) {
    const rows = (await db.execute('SELECT reminder_id FROM reminders_by_user WHERE user_id = ? LIMIT 300', [user.userId])).rows;
    const items = [];
    for (const row of rows) {
        const r = await readReminder(row.reminder_id);
        if (!r) continue;
        if (query.status === 'upcoming' && r.status !== 'PENDING') continue;
        let title = null;
        if (r.target_type !== 'CUSTOM') title = await resolveTarget(user, r.target_type, r.target_id).then(t => t.title).catch(() => null);
        items.push(dto(r, title));
    }
    items.sort((a, b) => String(a.fireAt).localeCompare(String(b.fireAt)));
    return { items };
}

// Cap nhat cac nhac PENDING khi doi tuong doi gio.
async function rescheduleTarget(targetType, targetId) {
    const rows = (await db.execute('SELECT reminder_id FROM reminders_by_target WHERE target_type = ? AND target_id = ?', [targetType, String(targetId)])).rows;
    for (const row of rows) {
        const r = await readReminder(row.reminder_id);
        if (!r || r.status !== 'PENDING' || r.target_type === 'CUSTOM') continue;
        const target = await resolveTarget({ userId: r.user_id }, r.target_type, r.target_id).catch(() => null);
        if (!target) { await cancelInternal(r, 'Không còn quyền truy cập'); continue; }
        const fireAt = computeFireAt(target.times, r.anchor || 'START', r.offset_minutes || 0);
        if (!fireAt) { await cancelInternal(r, 'Đối tượng không còn thời gian'); continue; }
        await db.execute('UPDATE reminders SET fire_at = ?, updated_at = ? WHERE reminder_id = ?', [fireAt, new Date(), r.reminder_id]);
        await moveDue(r, fireAt);
    }
}

async function cancelInternal(r, reason) {
    await db.execute("UPDATE reminders SET status = 'CANCELLED', last_error = ?, updated_at = ? WHERE reminder_id = ?", [reason || null, new Date(), r.reminder_id]);
    await moveDue(r, null);
}

async function cancelTarget(targetType, targetId, { userId = null } = {}) {
    const rows = (await db.execute('SELECT reminder_id FROM reminders_by_target WHERE target_type = ? AND target_id = ?', [targetType, String(targetId)])).rows;
    for (const row of rows) {
        const r = await readReminder(row.reminder_id);
        if (r && r.status === 'PENDING' && (!userId || r.user_id === userId)) await cancelInternal(r, 'Đối tượng đã hủy hoặc không còn liên quan');
    }
}

// ===== Worker =====
const TARGET_LABEL = { TASK: 'Công việc', EVENT: 'Lịch', MEETING: 'Cuộc họp' };
let sender = null; // kiem thu co the thay ham gui (gia lap loi)
function setSender(fn) { sender = fn; }

async function deliver(r) {
    const notifications = require('../services/notification.service');
    let title = null;
    if (r.target_type !== 'CUSTOM') {
        const target = await resolveTarget({ userId: r.user_id }, r.target_type, r.target_id).catch(() => null);
        if (!target || target.alive === false) return { cancelled: true };
        title = target.title;
    }
    const when = r.offset_minutes ? `còn ${r.offset_minutes >= 60 ? Math.round(r.offset_minutes / 60) + ' giờ' : r.offset_minutes + ' phút'}` : 'đến giờ';
    const preview = r.target_type === 'CUSTOM' ? r.note
        : `${TARGET_LABEL[r.target_type]} “${title}” ${r.anchor === 'DUE' ? (r.offset_minutes ? when + ' đến hạn' : 'đã đến hạn') : when + ' bắt đầu'}${r.note ? ' – ' + r.note : ''}`;
    const ev = { recipientId: r.user_id, actorId: 'system', type: 'REMINDER', dedupeKey: `REMINDER:${r.reminder_id}`, preview,
        ref: r.target_type === 'CUSTOM' ? null : { type: r.target_type, id: r.target_id } };
    if (sender) await sender(ev);
    // Goi notify (khong phai notifySafe) de biet loi that su; dedupe_key LWT chong tao trung khi chay lai.
    const id = await notifications.notify(ev);
    if (id) await require('./notify-extras.service').afterNotified(ev, id).catch(() => {});
    return { sent: true };
}

async function claim(r, instance) {
    const claimId = `${instance}:${crypto.randomUUID()}`;
    const now = new Date();
    let rs;
    if (r.status === 'PENDING') {
        rs = await db.execute("UPDATE reminders SET status = 'PROCESSING', claim_id = ?, claimed_at = ? WHERE reminder_id = ? IF status = 'PENDING'", [claimId, now, r.reminder_id]);
    } else if (r.status === 'PROCESSING' && r.claimed_at && now - new Date(r.claimed_at) > STALE_MS) {
        rs = await db.execute("UPDATE reminders SET claim_id = ?, claimed_at = ? WHERE reminder_id = ? IF status = 'PROCESSING' AND claim_id = ?", [claimId, now, r.reminder_id, r.claim_id]);
    } else {
        return null;
    }
    return rs.wasApplied() ? claimId : null;
}

async function processDue({ now = new Date(), instance = 'worker' } = {}) {
    const stats = { checked: 0, sent: 0, failed: 0, retried: 0, cancelled: 0, skipped: 0 };
    for (let h = 48; h >= 0; h--) {
        const bucket = bucketOf(now.getTime() - h * 3600000);
        const rows = (await db.execute('SELECT fire_at, reminder_id FROM reminders_due WHERE bucket = ? AND fire_at <= ?', [bucket, now])).rows;
        for (const row of rows) {
            stats.checked += 1;
            const r = await readReminder(row.reminder_id);
            if (!r || ['SENT', 'CANCELLED', 'FAILED'].includes(r.status)) {
                await db.execute('DELETE FROM reminders_due WHERE bucket = ? AND fire_at = ? AND reminder_id = ?', [bucket, row.fire_at, row.reminder_id]);
                continue;
            }
            if (new Date(r.fire_at).getTime() !== new Date(row.fire_at).getTime()) {
                await db.execute('DELETE FROM reminders_due WHERE bucket = ? AND fire_at = ? AND reminder_id = ?', [bucket, row.fire_at, row.reminder_id]);
                continue; // dong cu sau khi doi gio
            }
            const claimId = await claim(r, instance);
            if (!claimId) { stats.skipped += 1; continue; }
            try {
                const result = await deliver(r);
                if (result.cancelled) {
                    await db.execute("UPDATE reminders SET status = 'CANCELLED', last_error = ?, updated_at = ? WHERE reminder_id = ? IF claim_id = ?",
                        ['Đối tượng đã hủy, hoàn thành hoặc không còn quyền', new Date(), r.reminder_id, claimId]);
                    stats.cancelled += 1;
                } else {
                    await db.execute("UPDATE reminders SET status = 'SENT', sent_at = ?, updated_at = ? WHERE reminder_id = ? IF claim_id = ?",
                        [new Date(), new Date(), r.reminder_id, claimId]);
                    stats.sent += 1;
                }
                await db.execute('DELETE FROM reminders_due WHERE bucket = ? AND fire_at = ? AND reminder_id = ?', [bucket, row.fire_at, row.reminder_id]);
            } catch (error) {
                const attempts = (r.attempts || 0) + 1;
                const msg = String(error.message || error).slice(0, 300);
                console.warn(`[nhắc nhở] Gửi ${r.reminder_id} lỗi (lần ${attempts}):`, msg);
                if (attempts >= MAX_ATTEMPTS) {
                    await db.execute("UPDATE reminders SET status = 'FAILED', attempts = ?, last_error = ?, updated_at = ? WHERE reminder_id = ? IF claim_id = ?",
                        [attempts, msg, new Date(), r.reminder_id, claimId]);
                    await db.execute('DELETE FROM reminders_due WHERE bucket = ? AND fire_at = ? AND reminder_id = ?', [bucket, row.fire_at, row.reminder_id]);
                    stats.failed += 1;
                } else {
                    const retryAt = new Date(now.getTime() + 2 ** attempts * 60000);
                    await db.execute("UPDATE reminders SET status = 'PENDING', attempts = ?, last_error = ?, fire_at = ?, updated_at = ? WHERE reminder_id = ? IF claim_id = ?",
                        [attempts, msg, retryAt, new Date(), r.reminder_id, claimId]);
                    await moveDue({ ...r, fire_at: row.fire_at }, retryAt);
                    stats.retried += 1;
                }
            }
        }
    }
    return stats;
}

let timer = null;
const instanceId = `${require('os').hostname()}-${process.pid}`;
function startWorker() {
    if (timer || process.env.REMINDER_WORKER === 'false') return;
    const every = Math.max(10, Number(process.env.REMINDER_INTERVAL_SECONDS || 30)) * 1000;
    const tick = () => processDue({ instance: instanceId })
        .then(s => (s.sent || s.failed) && console.log(`[nhắc nhở] gửi ${s.sent}, lỗi ${s.failed}, thử lại ${s.retried}, hủy ${s.cancelled}`))
        .catch(error => console.warn('[nhắc nhở] Lỗi worker:', error.message));
    setTimeout(tick, 3000).unref();
    timer = setInterval(tick, every);
    timer.unref();
}

module.exports = {
    createReminder, updateReminder, cancelReminder, snooze, listReminders, rescheduleTarget, cancelTarget, processDue, startWorker,
    setSender, readReminder, bucketOf, TARGETS
};
