// Tai khoan & bao mat (PT-01 doi mat khau, PT-02 quen mat khau, PT-09 xac minh email,
// PT-17 quan ly thiet bi, PT-08 khoa tai khoan, NFR-16 xac thuc hai lop TOTP).
//
// Khong sua auth.service: moi trang thai moi nam o bang account_security / sessions_by_user.
//  - Phien: bang sessions (cu) van la nguon su that; sessions_by_user la chi muc de liet ke / huy tu xa.
//  - Huy phien = DELETE FROM sessions (requireAuth cu se tu tu choi phien do).
//  - Phien tao TRUOC moc password_changed_at bi tu choi (ke ca phien chua co trong chi muc).
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { hashPassword, verifyPassword } = require('../utils/password');
const { normalizeEmail } = require('../utils/validate');
const { iso } = require('../utils/types');
const authService = require('../services/auth.service');
const realtime = require('../services/realtime.service');
const mailer = require('./lib/mailer');
const totp = require('./lib/totp');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const RESET_TTL_SECONDS = 30 * 60;
const VERIFY_TTL_SECONDS = 15 * 60;
const SEC_COLS = `user_id, email, role, locked, locked_reason, locked_at, locked_by, password_changed_at,
                  email_verified_at, verification_required, totp_secret, totp_enabled, updated_at`;

// ===== Trang thai bao mat =====
async function getSecurity(userId) {
    return (await db.execute(`SELECT ${SEC_COLS} FROM account_security WHERE user_id = ?`, [userId])).first();
}

async function setSecurity(userId, fields) {
    const cols = Object.keys(fields);
    if (cols.length === 0) return;
    await db.execute(
        `UPDATE account_security SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`,
        [...cols.map(c => fields[c]), new Date(), userId]
    );
}

const adminEmails = () => (process.env.ADMIN_EMAILS || '').split(',').map(e => normalizeEmail(e)).filter(Boolean);

function isAdminRow(row, email) {
    if (row && row.role === 'ADMIN') return true;
    const mail = normalizeEmail((row && row.email) || email || '');
    return Boolean(mail) && adminEmails().includes(mail);
}

async function isAdmin(user) {
    return isAdminRow(await getSecurity(user.userId), user.email);
}

// Email cua tai khoan: users.email (seed / dang ky moi) hoac account_security.email (ghi khi dang nhap).
async function emailOf(user, sec) {
    return normalizeEmail(user.email || (sec && sec.email) || '') || null;
}

async function rememberEmail(userId, email) {
    if (!userId || !email) return;
    const sec = await getSecurity(userId);
    if (!sec || sec.email !== email) await setSecurity(userId, { email: normalizeEmail(email) });
}

// ===== Kiem tra moi request da xac thuc (session guard) =====
// Cache ngan (5 giay) de khong doc them Cassandra o moi request; thay doi bao mat goi forget().
const cache = new Map();
const CACHE_MS = 5000;
function forget(userId) {
    for (const key of cache.keys()) if (key.startsWith(userId + '|')) cache.delete(key);
}

async function sessionState(userId, sessionHash) {
    const key = `${userId}|${sessionHash}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const [sec, session, tracked] = await Promise.all([
        getSecurity(userId),
        db.execute('SELECT created_at FROM sessions WHERE session_hash = ?', [sessionHash]).then(r => r.first()),
        db.execute('SELECT two_factor_ok, last_seen_at, created_at FROM sessions_by_user WHERE user_id = ? AND session_hash = ?',
            [userId, sessionHash]).then(r => r.first())
    ]);
    // Moc tao hieu luc = muon nhat giua sessions.created_at va chi muc (phien duoc giu lai khi doi mat khau).
    const createdAt = Math.max(
        session && session.created_at ? new Date(session.created_at).getTime() : 0,
        tracked && tracked.created_at ? new Date(tracked.created_at).getTime() : 0
    );
    const changedAt = sec && sec.password_changed_at ? new Date(sec.password_changed_at).getTime() : 0;
    const value = {
        locked: Boolean(sec && sec.locked),
        revoked: Boolean(changedAt && createdAt && createdAt < changedAt),
        twoFactorRequired: Boolean(sec && sec.totp_enabled),
        twoFactorOk: Boolean(tracked && tracked.two_factor_ok),
        verificationPending: Boolean(sec && sec.verification_required && !sec.email_verified_at),
        tracked: Boolean(tracked),
        lastSeenAt: tracked && tracked.last_seen_at ? new Date(tracked.last_seen_at).getTime() : 0,
        sessionCreatedAt: session ? session.created_at : null
    };
    cache.set(key, { value, until: Date.now() + CACHE_MS });
    if (cache.size > 20000) cache.clear();
    return value;
}

const clientIp = req => (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);

// Ghi / cap nhat chi muc phien (toi da 1 lan / 5 phut / phien). TTL bang thoi han phien.
async function trackSession(req, state) {
    const now = Date.now();
    if (state.tracked && now - state.lastSeenAt < 5 * 60 * 1000) return;
    const ua = String(req.headers['user-agent'] || '').slice(0, 300);
    if (!state.tracked) {
        await db.execute(
            `UPDATE sessions_by_user USING TTL ? SET created_at = ?, last_seen_at = ?, user_agent = ?, ip = ?
             WHERE user_id = ? AND session_hash = ?`,
            [authService.SESSION_TTL_SECONDS, state.sessionCreatedAt || new Date(), new Date(now), ua, clientIp(req),
                req.user.userId, req.sessionHash]
        );
    } else {
        await db.execute(
            'UPDATE sessions_by_user USING TTL ? SET last_seen_at = ?, user_agent = ?, ip = ? WHERE user_id = ? AND session_hash = ?',
            [authService.SESSION_TTL_SECONDS, new Date(now), ua, clientIp(req), req.user.userId, req.sessionHash]
        );
    }
    state.tracked = true;
    state.lastSeenAt = now;
}

// Duong dan van cho phep khi phien chua qua 2FA / chua xac minh email.
const PENDING_ALLOW = [
    /^\/api\/v1\/auth\/(logout|2fa\/verify)$/,
    /^\/api\/v1\/me\/security$/,
    /^\/api\/v1\/me\/email\/(verification|verify)$/,
    /^\/api\/v1\/events$/
];

function guard() {
    return async (req, res, next) => {
        if (!req.user || !req.sessionHash) return next();
        const state = await sessionState(req.user.userId, req.sessionHash);
        if (state.locked || state.revoked) {
            await db.execute('DELETE FROM sessions WHERE session_hash = ?', [req.sessionHash]).catch(() => {});
            cache.delete(`${req.user.userId}|${req.sessionHash}`);
            res.clearCookie('chatott_sid', { path: '/' });
            return next(state.locked
                ? httpError(401, 'ACCOUNT_LOCKED', 'Tài khoản đã bị khóa bởi quản trị viên.')
                : httpError(401, 'SESSION_REVOKED', 'Phiên đăng nhập đã bị đăng xuất (mật khẩu vừa được đổi).'));
        }
        trackSession(req, state).catch(error => console.warn('[ext] Không ghi được phiên:', error.message));
        const urlPath = req.originalUrl.split('?')[0];
        const allowed = PENDING_ALLOW.some(re => re.test(urlPath));
        if (state.twoFactorRequired && !state.twoFactorOk && !allowed) {
            return next(httpError(403, 'TWO_FACTOR_REQUIRED', 'Nhập mã xác thực hai lớp để tiếp tục.'));
        }
        if (state.verificationPending && !allowed && process.env.REQUIRE_EMAIL_VERIFICATION === 'true') {
            return next(httpError(403, 'EMAIL_NOT_VERIFIED', 'Hãy xác minh email trước khi sử dụng ChatOTT.'));
        }
        req.securityState = state;
        return next();
    };
}

// ===== Tong quan bao mat cua toi =====
async function mySecurity(user, sessionHash) {
    const sec = await getSecurity(user.userId);
    const email = await emailOf(user, sec);
    const state = sessionHash ? await sessionState(user.userId, sessionHash) : {};
    return {
        userId: user.userId,
        email,
        isAdmin: isAdminRow(sec, email),
        emailVerified: Boolean(sec && sec.email_verified_at),
        emailVerifiedAt: iso(sec && sec.email_verified_at),
        verificationRequired: Boolean(sec && sec.verification_required),
        twoFactorEnabled: Boolean(sec && sec.totp_enabled),
        twoFactorPending: Boolean(state.twoFactorRequired && !state.twoFactorOk),
        passwordChangedAt: iso(sec && sec.password_changed_at)
    };
}

// ===== Mat khau =====
function validateNewPassword(password, confirm) {
    const p = typeof password === 'string' ? password : '';
    if (p.length < 8 || p.length > 72) throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu mới cần từ 8 đến 72 ký tự.', { fields: { newPassword: 'Từ 8 đến 72 ký tự.' } });
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu mới cần có cả chữ và số.', { fields: { newPassword: 'Cần có cả chữ và số.' } });
    if (confirm !== undefined && confirm !== p) throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu xác nhận không khớp.', { fields: { confirmPassword: 'Không khớp.' } });
    return p;
}

async function readAccount(email) {
    return (await db.execute('SELECT email, user_id, password_hash, status FROM accounts_by_email WHERE email = ?', [email])).first();
}

// LWT: chi doi mat khau cua dung tai khoan (user_id khop).
async function writePassword(email, userId, password) {
    const rs = await db.execute(
        'UPDATE accounts_by_email SET password_hash = ? WHERE email = ? IF user_id = ?',
        [await hashPassword(password), email, userId]
    );
    if (!rs.wasApplied()) throw httpError(409, 'ACCOUNT_CHANGED', 'Tài khoản vừa thay đổi, hãy thử lại.');
}

async function listSessionRows(userId) {
    return (await db.execute(
        'SELECT session_hash, created_at, last_seen_at, user_agent, ip FROM sessions_by_user WHERE user_id = ?',
        [userId], { fetchSize: 200 })).rows;
}

async function revokeSession(userId, sessionHash) {
    await db.execute('DELETE FROM sessions WHERE session_hash = ?', [sessionHash]);
    await db.execute('DELETE FROM sessions_by_user WHERE user_id = ? AND session_hash = ?', [userId, sessionHash]);
    cache.delete(`${userId}|${sessionHash}`);
}

async function revokeAll(userId, exceptHash = null) {
    const rows = await listSessionRows(userId);
    let count = 0;
    for (const r of rows) {
        if (r.session_hash === exceptHash) continue;
        await revokeSession(userId, r.session_hash);
        count += 1;
    }
    forget(userId);
    realtime.publish([userId], 'account:security', { reason: 'sessions' });
    return count;
}

// Danh dau phien hien tai la "tao sau moc doi mat khau": giu phien nay, moi phien cu bi tu choi.
async function bumpPasswordChanged(userId, keepSessionHash) {
    const changedAt = new Date();
    await setSecurity(userId, { password_changed_at: changedAt });
    if (keepSessionHash) {
        await db.execute(
            'UPDATE sessions_by_user USING TTL ? SET created_at = ? WHERE user_id = ? AND session_hash = ?',
            [authService.SESSION_TTL_SECONDS, new Date(changedAt.getTime() + 1), userId, keepSessionHash]
        );
    }
    forget(userId);
}

async function changePassword(user, sessionHash, body = {}) {
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = validateNewPassword(body.newPassword, body.confirmPassword);
    const sec = await getSecurity(user.userId);
    const email = await emailOf(user, sec) || normalizeEmail(body.email);
    const account = email ? await readAccount(email) : null;
    if (!account || account.user_id !== user.userId) {
        throw httpError(400, 'EMAIL_UNKNOWN', 'Không xác định được email của tài khoản. Hãy đăng nhập lại rồi thử lại.');
    }
    if (!(await verifyPassword(current, account.password_hash))) {
        throw httpError(400, 'WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng.', { fields: { currentPassword: 'Mật khẩu hiện tại không đúng.' } });
    }
    if (current === next) throw httpError(400, 'VALIDATION_ERROR', 'Mật khẩu mới phải khác mật khẩu hiện tại.', { fields: { newPassword: 'Phải khác mật khẩu hiện tại.' } });
    await writePassword(email, user.userId, next);
    await bumpPasswordChanged(user.userId, sessionHash);
    const revoked = await revokeAll(user.userId, sessionHash);
    return { changed: true, revokedSessions: revoked };
}

// PT-02: luon tra cung mot thong bao (khong lo email nao ton tai).
async function requestPasswordReset(body = {}) {
    const email = normalizeEmail(body.email);
    const generic = { sent: true, message: 'Nếu email đã đăng ký, liên kết đặt lại mật khẩu đã được gửi. Liên kết có hiệu lực 30 phút.' };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        throw httpError(400, 'VALIDATION_ERROR', 'Email không đúng định dạng.', { fields: { email: 'Email không đúng định dạng.' } });
    }
    const account = await readAccount(email);
    if (!account || account.status !== 'ACTIVE') return generic;
    const token = crypto.randomBytes(32).toString('base64url');
    await db.execute(
        'INSERT INTO password_reset_tokens (token_hash, user_id, email, created_at) VALUES (?, ?, ?, ?) USING TTL ?',
        [sha256(token), account.user_id, email, new Date(), RESET_TTL_SECONDS]
    );
    const link = `${mailer.appUrl()}/?reset=${token}`;
    await mailer.sendMail({
        to: email,
        subject: 'ChatOTT - Đặt lại mật khẩu',
        text: `Xin chào,\n\nBạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu ChatOTT.\nMở liên kết sau trong 30 phút để đặt mật khẩu mới (chỉ dùng được một lần):\n\n${link}\n\nNếu không phải bạn, hãy bỏ qua email này.`
    }).catch(error => console.warn('[mail] Gửi thư đặt lại mật khẩu lỗi:', error.message));
    return generic;
}

async function resetPassword(body = {}) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const next = validateNewPassword(body.newPassword, body.confirmPassword);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw httpError(400, 'INVALID_RESET_TOKEN', 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
    const hash = sha256(token);
    const row = (await db.execute('SELECT user_id, email FROM password_reset_tokens WHERE token_hash = ?', [hash])).first();
    if (!row) throw httpError(400, 'INVALID_RESET_TOKEN', 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
    // Dung mot lan: LWT xoa token, chi 1 yeu cau thang.
    const claim = await db.execute('DELETE FROM password_reset_tokens WHERE token_hash = ? IF EXISTS', [hash]);
    if (!claim.wasApplied()) throw httpError(400, 'INVALID_RESET_TOKEN', 'Liên kết đặt lại mật khẩu đã được sử dụng.');
    await writePassword(row.email, row.user_id, next);
    await bumpPasswordChanged(row.user_id, null);
    await revokeAll(row.user_id, null);
    await rememberEmail(row.user_id, row.email);
    return { reset: true, message: 'Đã đặt mật khẩu mới. Hãy đăng nhập lại.' };
}

// ===== PT-17: thiet bi / phien =====
function describeAgent(ua) {
    const s = String(ua || '');
    const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome'
        : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : /node|undici/i.test(s) ? 'Ứng dụng' : 'Trình duyệt';
    const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS'
        : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
    return os ? `${browser} trên ${os}` : browser;
}

async function listSessions(user, currentHash) {
    const rows = await listSessionRows(user.userId);
    const alive = [];
    for (const r of rows) {
        const exists = (await db.execute('SELECT session_hash FROM sessions WHERE session_hash = ?', [r.session_hash])).first();
        if (!exists) {
            await db.execute('DELETE FROM sessions_by_user WHERE user_id = ? AND session_hash = ?', [user.userId, r.session_hash]);
            continue;
        }
        alive.push({
            sessionId: r.session_hash.slice(0, 16),
            device: describeAgent(r.user_agent),
            userAgent: r.user_agent || '',
            ip: r.ip || '',
            createdAt: iso(r.created_at),
            lastSeenAt: iso(r.last_seen_at),
            current: r.session_hash === currentHash
        });
    }
    return { items: alive.sort((a, b) => Number(b.current) - Number(a.current) || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))) };
}

async function revokeSessionById(user, currentHash, sessionId) {
    const id = String(sessionId || '');
    if (!/^[0-9a-f]{16}$/.test(id)) throw httpError(400, 'INVALID_ID', 'Mã phiên không hợp lệ.');
    const row = (await listSessionRows(user.userId)).find(r => r.session_hash.startsWith(id));
    if (!row) throw httpError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên đăng nhập.');
    if (row.session_hash === currentHash) throw httpError(400, 'CURRENT_SESSION', 'Dùng nút Đăng xuất để thoát phiên hiện tại.');
    await revokeSession(user.userId, row.session_hash);
    realtime.publish([user.userId], 'account:security', { reason: 'sessions' });
    return { revoked: true };
}

// ===== PT-09: xac minh email =====
async function sendVerification(user) {
    const sec = await getSecurity(user.userId);
    if (sec && sec.email_verified_at) return { alreadyVerified: true };
    const email = await emailOf(user, sec);
    if (!email) throw httpError(400, 'EMAIL_UNKNOWN', 'Không xác định được email của tài khoản. Hãy đăng nhập lại.');
    const old = (await db.execute('SELECT expires_at FROM email_verification_codes WHERE user_id = ?', [user.userId])).first();
    if (old && old.expires_at && new Date(old.expires_at).getTime() - VERIFY_TTL_SECONDS * 1000 + 60000 > Date.now()) {
        throw httpError(429, 'TOO_MANY_REQUESTS', 'Vừa gửi mã xác minh, hãy chờ 1 phút rồi gửi lại.');
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.execute(
        'INSERT INTO email_verification_codes (user_id, code_hash, email, expires_at, attempts) VALUES (?, ?, ?, ?, 0) USING TTL ?',
        [user.userId, sha256(`${user.userId}:${code}`), email, new Date(Date.now() + VERIFY_TTL_SECONDS * 1000), VERIFY_TTL_SECONDS]
    );
    await mailer.sendMail({
        to: email,
        subject: 'ChatOTT - Mã xác minh email',
        text: `Mã xác minh email ChatOTT của bạn là: ${code}\nMã có hiệu lực 15 phút.`
    }).catch(error => console.warn('[mail] Gửi mã xác minh lỗi:', error.message));
    return { sent: true, email, expiresInSeconds: VERIFY_TTL_SECONDS };
}

async function verifyEmail(user, body = {}) {
    const code = String(body.code || '').trim();
    const row = (await db.execute('SELECT code_hash, email, expires_at, attempts FROM email_verification_codes WHERE user_id = ?', [user.userId])).first();
    if (!row || (row.expires_at && new Date(row.expires_at) < new Date())) {
        throw httpError(400, 'CODE_EXPIRED', 'Mã xác minh đã hết hạn. Hãy gửi lại mã mới.');
    }
    if ((row.attempts || 0) >= 5) throw httpError(429, 'TOO_MANY_ATTEMPTS', 'Nhập sai quá nhiều lần. Hãy gửi lại mã mới.');
    if (!/^\d{6}$/.test(code) || sha256(`${user.userId}:${code}`) !== row.code_hash) {
        await db.execute('UPDATE email_verification_codes SET attempts = ? WHERE user_id = ?', [(row.attempts || 0) + 1, user.userId]);
        throw httpError(400, 'WRONG_CODE', 'Mã xác minh không đúng.');
    }
    await db.execute('DELETE FROM email_verification_codes WHERE user_id = ?', [user.userId]);
    await setSecurity(user.userId, { email_verified_at: new Date(), email: row.email });
    forget(user.userId);
    return { verified: true };
}

// Goi sau khi dang ky (afterJson): danh dau tai khoan moi can xac minh va gui ma.
async function onRegistered(body) {
    const u = body && body.user;
    if (!u || !u.userId) return;
    await setSecurity(u.userId, {
        email: normalizeEmail(u.email),
        verification_required: process.env.REQUIRE_EMAIL_VERIFICATION === 'true'
    });
    if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true') await sendVerification(u).catch(() => {});
}

// ===== NFR-16: TOTP =====
async function setupTwoFactor(user) {
    const sec = await getSecurity(user.userId);
    if (sec && sec.totp_enabled) throw httpError(409, 'TWO_FACTOR_ENABLED', 'Xác thực hai lớp đang bật. Hãy tắt trước khi tạo khóa mới.');
    const secret = totp.generateSecret();
    await setSecurity(user.userId, { totp_secret: secret, totp_enabled: false });
    const account = (await emailOf(user, sec)) || user.userId;
    return { secret, otpauthUrl: totp.otpauthUrl(secret, account) };
}

async function markSessionTwoFactor(userId, sessionHash) {
    await db.execute(
        'UPDATE sessions_by_user USING TTL ? SET two_factor_ok = true, last_seen_at = ? WHERE user_id = ? AND session_hash = ?',
        [authService.SESSION_TTL_SECONDS, new Date(), userId, sessionHash]
    );
    cache.delete(`${userId}|${sessionHash}`);
}

async function enableTwoFactor(user, sessionHash, body = {}) {
    const sec = await getSecurity(user.userId);
    if (!sec || !sec.totp_secret) throw httpError(400, 'TWO_FACTOR_NOT_SETUP', 'Hãy tạo khóa xác thực trước.');
    if (!totp.verify(sec.totp_secret, body.code)) throw httpError(400, 'WRONG_CODE', 'Mã xác thực không đúng.');
    await setSecurity(user.userId, { totp_enabled: true });
    await markSessionTwoFactor(user.userId, sessionHash);
    forget(user.userId);
    return { enabled: true };
}

async function disableTwoFactor(user, body = {}) {
    const sec = await getSecurity(user.userId);
    if (!sec || !sec.totp_enabled) return { enabled: false };
    if (!totp.verify(sec.totp_secret, body.code)) throw httpError(400, 'WRONG_CODE', 'Mã xác thực không đúng.');
    await setSecurity(user.userId, { totp_enabled: false, totp_secret: null });
    forget(user.userId);
    return { enabled: false };
}

const twoFactorFails = new Map();
async function verifyTwoFactorLogin(user, sessionHash, body = {}) {
    const key = sessionHash;
    const fails = twoFactorFails.get(key) || 0;
    if (fails >= 8) throw httpError(429, 'TOO_MANY_ATTEMPTS', 'Nhập sai quá nhiều lần. Hãy đăng nhập lại.');
    const sec = await getSecurity(user.userId);
    if (!sec || !sec.totp_enabled) return { verified: true };
    if (!totp.verify(sec.totp_secret, body.code)) {
        twoFactorFails.set(key, fails + 1);
        if (twoFactorFails.size > 10000) twoFactorFails.clear();
        throw httpError(400, 'WRONG_CODE', 'Mã xác thực không đúng.');
    }
    twoFactorFails.delete(key);
    await markSessionTwoFactor(user.userId, sessionHash);
    return { verified: true };
}

// ===== PT-08: khoa / mo khoa (goi tu moderation.service) =====
async function lockUser(userId, adminId, reason) {
    const users = await require('../services/user.service').getUsersByIds([userId]);
    if (!users.has(userId)) throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    const row = (await db.execute('SELECT email FROM users WHERE user_id = ?', [userId])).first();
    const sec = await getSecurity(userId);
    const email = normalizeEmail((row && row.email) || (sec && sec.email) || '');
    await setSecurity(userId, { locked: true, locked_reason: String(reason || '').slice(0, 300), locked_at: new Date(), locked_by: adminId });
    // Dang nhap cu tu choi trang thai khac ACTIVE (ACCOUNT_DISABLED) -> khong dang nhap duoc nua.
    if (email) await db.execute("UPDATE accounts_by_email SET status = 'LOCKED' WHERE email = ? IF status = 'ACTIVE'", [email]).catch(() => {});
    forget(userId);
    await revokeAll(userId, null);
    realtime.publish([userId], 'account:security', { reason: 'locked' });
    return { locked: true, email: email || null };
}

async function unlockUser(userId) {
    const row = (await db.execute('SELECT email FROM users WHERE user_id = ?', [userId])).first();
    const sec = await getSecurity(userId);
    const email = normalizeEmail((row && row.email) || (sec && sec.email) || '');
    await setSecurity(userId, { locked: false, locked_reason: null });
    if (email) await db.execute("UPDATE accounts_by_email SET status = 'ACTIVE' WHERE email = ? IF status = 'LOCKED'", [email]).catch(() => {});
    forget(userId);
    return { locked: false };
}

async function setRole(userId, role) {
    if (!['ADMIN', 'USER'].includes(role)) throw httpError(400, 'INVALID_ROLE', 'Vai trò phải là ADMIN hoặc USER.');
    await setSecurity(userId, { role });
    forget(userId);
    return { userId, role };
}

module.exports = {
    getSecurity, setSecurity, isAdmin, isAdminRow, rememberEmail, guard, forget, sessionState, mySecurity,
    changePassword, requestPasswordReset, resetPassword, listSessions, revokeSessionById, revokeAll,
    sendVerification, verifyEmail, onRegistered, setupTwoFactor, enableTwoFactor, disableTwoFactor, verifyTwoFactorLogin,
    lockUser, unlockUser, setRole, describeAgent, sha256
};
