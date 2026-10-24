const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { hashPassword, verifyPassword, verifyAgainstDummy } = require('../utils/password');
const { validateRegistration, validateLogin } = require('../utils/validate');
const { nameTokens, tokenBucket } = require('../utils/text');
const { iso } = require('../utils/types');

const SESSION_TTL_SECONDS = Math.max(
    300,
    Math.round(Number(process.env.SESSION_TTL_HOURS || 168) * 3600)
);

// Ban ghi PENDING cu hon nguong nay, khong co ho so users, moi duoc nguoi KHAC
// (mat khau khac) chiem lai. Nguong lon hon nhieu so voi readTimeout cua driver (12s)
// de mot lan dang ky dang chay khong bi chiem giua chung.
const RECLAIM_AFTER_MS = Math.max(60, Number(process.env.REGISTRATION_RECLAIM_MINUTES || 10) * 60) * 1000;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function toPublicUser(row) {
    if (!row) return null;
    return {
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email || null,
        avatarUrl: row.avatar_url || null,
        createdAt: iso(row.created_at)
    };
}

async function getUserRow(userId) {
    const result = await db.execute(
        'SELECT user_id, display_name, avatar_url, email, created_at FROM users WHERE user_id = ?',
        [userId]
    );
    return result.first();
}

// Ho so + token tim ten trong MOT logged batch: Cassandra (batchlog) bao dam
// hoac tat ca dong duoc ghi, hoac khong dong nao (cuoi cung nhat quan).
// Ghi lai cung du lieu nhieu lan cho cung ket qua (idempotent).
function profileBatch(userId, displayName, email, createdAt) {
    return [
        {
            query: `INSERT INTO users (user_id, display_name, avatar_url, email, created_at)
                    VALUES (?, ?, ?, ?, ?)`,
            params: [userId, displayName, null, email, createdAt]
        },
        ...nameTokens(displayName).map(token => ({
            query: `INSERT INTO users_by_name_token (token_prefix, name_token, user_id, display_name, avatar_url)
                    VALUES (?, ?, ?, ?, ?)`,
            params: [tokenBucket(token), token, userId, displayName, null]
        }))
    ];
}

// PENDING -> ACTIVE. Dieu kien gom user_id: khong bao gio kich hoat nham ban ghi
// da bi mot lan dang ky khac chiem lai.
async function activate(email, userId) {
    const rs = await db.execute(
        `UPDATE accounts_by_email SET status = 'ACTIVE'
         WHERE email = ? IF status = 'PENDING' AND user_id = ?`,
        [email, userId]
    );
    if (rs.wasApplied()) return true;
    const row = rs.first() || {};
    return row.status === 'ACTIVE' && row.user_id === userId;
}

// ===== Dang ky =====
// B1 (LWT, partition email): INSERT accounts_by_email ... status='PENDING' IF NOT EXISTS
//     -> hai yeu cau cung email: Paxos chi cho MOT yeu cau thang.
// B2 (LOGGED BATCH): users + users_by_name_token.
// B3 (LWT): status PENDING -> ACTIVE IF user_id = <cua minh>.
// Khong co buoc xoa: loi o B2/B3 de lai PENDING, duoc phuc hoi o lan dang nhap / dang ky sau.
async function register(body) {
    const { displayName, email, password } = validateRegistration(body);
    const passwordHash = await hashPassword(password);
    const now = new Date();
    let userId = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);

    const lwt = await db.execute(
        `INSERT INTO accounts_by_email (email, user_id, password_hash, status, created_at)
         VALUES (?, ?, ?, 'PENDING', ?) IF NOT EXISTS`,
        [email, userId, passwordHash, now]
    );

    if (!lwt.wasApplied()) {
        const existing = lwt.first();
        userId = await resolveExistingRegistration(existing, email, password, passwordHash, now);
    }

    // B2: neu loi (vd. timeout) -> nem loi; ban ghi van PENDING, khong xoa gi.
    await db.batch(profileBatch(userId, displayName, email, now));

    // B3: neu loi -> ho so da co, lan dang nhap dau tien se kich hoat.
    const ok = await activate(email, userId).catch(() => false);
    if (!ok) {
        throw httpError(503, 'REGISTRATION_INCOMPLETE',
            'Tài khoản đã được tạo nhưng chưa kích hoạt xong. Hãy thử đăng nhập lại sau ít phút.');
    }

    return { userId, displayName, email, avatarUrl: null, createdAt: now.toISOString() };
}

// Email da co ban ghi. Chi co 3 truong hop duoc tiep tuc, con lai -> 409.
async function resolveExistingRegistration(existing, email, password, passwordHash, now) {
    const conflict = () => httpError(409, 'EMAIL_EXISTS',
        'Email này đã được đăng ký. Hãy đăng nhập hoặc dùng email khác.',
        { fields: { email: 'Email này đã được đăng ký.' } });

    if (!existing || existing.status !== 'PENDING') throw conflict();

    // (a) Chinh nguoi do thu lai (chung minh bang mat khau): tiep tuc dung user_id cu,
    //     ghi lai ho so (idempotent) roi kich hoat. Khong tao user_id moi.
    if (await verifyPassword(password, existing.password_hash)) {
        return existing.user_id;
    }

    // (b) Nguoi khac: chi chiem lai khi ban ghi PENDING da qua nguong VA chua co ho so.
    const age = now.getTime() - new Date(existing.created_at || 0).getTime();
    if (age < RECLAIM_AFTER_MS) throw conflict();
    if (await getUserRow(existing.user_id)) throw conflict(); // co ho so: chu cu se kich hoat khi dang nhap

    const newUserId = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const reclaim = await db.execute(
        `UPDATE accounts_by_email SET user_id = ?, password_hash = ?, created_at = ?
         WHERE email = ? IF status = 'PENDING' AND user_id = ?`,
        [newUserId, passwordHash, now, email, existing.user_id]
    );
    if (!reclaim.wasApplied()) throw conflict(); // mot yeu cau khac vua thang
    return newUserId;
}

// ===== Dang nhap =====
async function login(body) {
    const { email, password } = validateLogin(body);
    const result = await db.execute(
        'SELECT email, user_id, password_hash, status FROM accounts_by_email WHERE email = ?',
        [email]
    );
    const account = result.first();

    const ok = account
        ? await verifyPassword(password, account.password_hash)
        : await verifyAgainstDummy(password);
    if (!ok) {
        throw httpError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    const userRow = await getUserRow(account.user_id);

    if (account.status === 'PENDING') {
        // Phuc hoi: mat khau dung + ho so da ton tai -> kich hoat co dieu kien.
        if (!userRow || !(await activate(email, account.user_id))) {
            throw httpError(401, 'REGISTRATION_INCOMPLETE',
                'Đăng ký trước đó chưa hoàn tất. Hãy đăng ký lại với cùng email và mật khẩu.');
        }
    } else if (account.status !== 'ACTIVE') {
        throw httpError(401, 'ACCOUNT_DISABLED', 'Tài khoản không ở trạng thái hoạt động.');
    }

    if (!userRow) {
        throw httpError(401, 'INVALID_CREDENTIALS', 'Tài khoản không còn tồn tại.');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

    // Khoa = hash cua token; user_id duoc luu de sau nay co the them bang
    // sessions_by_user (dang xuat moi thiet bi) ma khong doi bang nay.
    await db.execute(
        `INSERT INTO sessions (session_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?) USING TTL ?`,
        [sha256(token), account.user_id, now, expiresAt, SESSION_TTL_SECONDS]
    );

    return {
        token,
        maxAgeMs: SESSION_TTL_SECONDS * 1000,
        expiresAt: expiresAt.toISOString(),
        user: toPublicUser({ ...userRow, email: userRow.email || account.email })
    };
}

async function resolveSession(token) {
    const sessionHash = sha256(token);
    const result = await db.execute(
        'SELECT user_id, expires_at FROM sessions WHERE session_hash = ?',
        [sessionHash]
    );
    const session = result.first();
    if (!session) return null;

    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
        await db.execute('DELETE FROM sessions WHERE session_hash = ?', [sessionHash]).catch(() => {});
        return null;
    }

    const userRow = await getUserRow(session.user_id);
    if (!userRow) return null;

    return { sessionHash, user: toPublicUser(userRow) };
}

async function logout(token) {
    if (!token) return;
    await db.execute('DELETE FROM sessions WHERE session_hash = ?', [sha256(token)]);
}

module.exports = {
    register, login, logout, resolveSession, getUserRow, toPublicUser, profileBatch,
    SESSION_TTL_SECONDS, RECLAIM_AFTER_MS
};
