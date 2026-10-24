// Ho so, ket ban, chan (Giai doan 1).
//
// Nguon su that cua quan he 2 nguoi la bang relationships (1 dong / cap, MOI lenh ghi la LWT):
//   khong co dong         -> chua quan he
//   PENDING, requester_id -> co loi moi tu requester_id
//   FRIENDS               -> ban be
// Cac bang friend_requests_by_* / friends_by_user chi la chi muc de liet ke; khi doc danh sach,
// moi dong duoc doi chieu voi relationships va dong lech (do loi giua chung) bi bo qua + don.
// Chan (blocked_users_by_user) tach rieng: chan xoa moi quan he/loi moi, khong xoa lich su chat.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { iso } = require('../utils/types');
const userService = require('./user.service');
const realtime = require('./realtime.service');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9]$/;
const BIO_MAX = 300;
const LIST_CAP = 1000;

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function requireTarget(user, targetUserId) {
    const target = String(targetUserId || '').trim();
    if (!ID_RE.test(target)) throw httpError(400, 'INVALID_USER_ID', 'Mã người dùng không hợp lệ.');
    if (target === user.userId) throw httpError(400, 'SELF_RELATION', 'Không thể thực hiện thao tác này với chính mình.');
    return target;
}

async function requireUser(userId) {
    const found = (await userService.getUsersByIds([userId])).get(userId);
    if (!found) throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    return found;
}

async function getRelationship(a, b) {
    return (await db.execute(
        'SELECT status, requester_id, updated_at FROM relationships WHERE pair_key = ?', [pairKey(a, b)]
    )).first();
}

async function blockedBy(userId, otherId) {
    return Boolean((await db.execute(
        'SELECT blocked_id FROM blocked_users_by_user WHERE user_id = ? AND blocked_id = ?', [userId, otherId]
    )).first());
}

// { iBlocked, blockedMe }
async function blockState(me, other) {
    const [iBlocked, blockedMe] = await Promise.all([blockedBy(me, other), blockedBy(other, me)]);
    return { iBlocked, blockedMe };
}

async function assertNotBlocked(me, other) {
    const s = await blockState(me, other);
    if (s.iBlocked) throw httpError(403, 'USER_BLOCKED', 'Bạn đã chặn người này. Bỏ chặn để tiếp tục.');
    if (s.blockedMe) throw httpError(403, 'BLOCKED_BY_USER', 'Bạn không thể tương tác với người dùng này.');
}

// Trang thai quan he nhin tu phia "me": SELF | NONE | FRIENDS | OUTGOING | INCOMING | BLOCKED
async function relationshipStatus(me, other) {
    if (me === other) return 'SELF';
    const [rel, iBlocked] = await Promise.all([getRelationship(me, other), blockedBy(me, other)]);
    if (iBlocked) return 'BLOCKED';
    if (!rel) return 'NONE';
    if (rel.status === 'FRIENDS') return 'FRIENDS';
    return rel.requester_id === me ? 'OUTGOING' : 'INCOMING';
}

async function notify(userIds, event, data) {
    realtime.publish(userIds, event, data);
}

// ===== Ket ban =====

async function writeRequestIndex(sender, receiver, at) {
    await Promise.all([
        db.execute('INSERT INTO friend_requests_by_receiver (receiver_id, sender_id, created_at) VALUES (?, ?, ?)', [receiver, sender, at]),
        db.execute('INSERT INTO friend_requests_by_sender (sender_id, receiver_id, created_at) VALUES (?, ?, ?)', [sender, receiver, at])
    ]);
}

async function clearRequestIndex(a, b) {
    await Promise.all([
        db.execute('DELETE FROM friend_requests_by_receiver WHERE receiver_id = ? AND sender_id = ?', [a, b]),
        db.execute('DELETE FROM friend_requests_by_receiver WHERE receiver_id = ? AND sender_id = ?', [b, a]),
        db.execute('DELETE FROM friend_requests_by_sender WHERE sender_id = ? AND receiver_id = ?', [a, b]),
        db.execute('DELETE FROM friend_requests_by_sender WHERE sender_id = ? AND receiver_id = ?', [b, a])
    ]);
}

async function writeFriendIndex(a, b, since) {
    await Promise.all([
        db.execute('INSERT INTO friends_by_user (user_id, friend_id, since) VALUES (?, ?, ?)', [a, b, since]),
        db.execute('INSERT INTO friends_by_user (user_id, friend_id, since) VALUES (?, ?, ?)', [b, a, since])
    ]);
}

async function clearFriendIndex(a, b) {
    await Promise.all([
        db.execute('DELETE FROM friends_by_user WHERE user_id = ? AND friend_id = ?', [a, b]),
        db.execute('DELETE FROM friends_by_user WHERE user_id = ? AND friend_id = ?', [b, a])
    ]);
}

async function acceptInternal(me, sender) {
    const now = new Date();
    const rs = await db.execute(
        `UPDATE relationships SET status = 'FRIENDS', updated_at = ? WHERE pair_key = ?
         IF status = 'PENDING' AND requester_id = ?`,
        [now, pairKey(me, sender), sender]
    );
    if (!rs.wasApplied()) {
        const rel = await getRelationship(me, sender);
        if (rel && rel.status === 'FRIENDS') return { status: 'FRIENDS', changed: false };
        throw httpError(404, 'REQUEST_NOT_FOUND', 'Lời mời kết bạn không còn tồn tại.');
    }
    await writeFriendIndex(me, sender, now);
    await clearRequestIndex(me, sender);
    await require('./notification.service').notifySafe({
        recipientId: sender, actorId: me, type: 'FRIEND_ACCEPT', dedupeKey: `FRIEND_ACCEPT:${me}:${now.getTime()}`,
        preview: 'đã chấp nhận lời mời kết bạn'
    });
    notify([sender, me], 'friend:updated', { userIds: [me, sender], status: 'FRIENDS', actorId: me });
    return { status: 'FRIENDS', changed: true };
}

async function sendRequest(user, targetUserId) {
    const target = requireTarget(user, targetUserId);
    await requireUser(target);
    await assertNotBlocked(user.userId, target);
    const now = new Date();
    const rs = await db.execute(
        `INSERT INTO relationships (pair_key, status, requester_id, updated_at)
         VALUES (?, 'PENDING', ?, ?) IF NOT EXISTS`,
        [pairKey(user.userId, target), user.userId, now]
    );
    if (rs.wasApplied()) {
        await writeRequestIndex(user.userId, target, now);
        await require('./notification.service').notifySafe({
            recipientId: target, actorId: user.userId, type: 'FRIEND_REQUEST', dedupeKey: `FRIEND_REQUEST:${user.userId}:${now.getTime()}`,
            preview: 'đã gửi lời mời kết bạn'
        });
        notify([target, user.userId], 'friend:updated', { userIds: [user.userId, target], status: 'PENDING', actorId: user.userId });
        return { status: 'OUTGOING', changed: true };
    }
    const rel = await getRelationship(user.userId, target);
    if (!rel) throw httpError(409, 'RETRY', 'Trạng thái vừa thay đổi, hãy thử lại.');
    if (rel.status === 'FRIENDS') return { status: 'FRIENDS', changed: false };
    if (rel.requester_id === user.userId) {
        await writeRequestIndex(user.userId, target, rel.updated_at || now); // retry: chi muc idempotent
        return { status: 'OUTGOING', changed: false };
    }
    // Nguoi kia da moi minh truoc: gui loi moi = chap nhan.
    return acceptInternal(user.userId, target);
}

async function acceptRequest(user, senderId) {
    const sender = requireTarget(user, senderId);
    await assertNotBlocked(user.userId, sender);
    return acceptInternal(user.userId, sender);
}

async function removePending(me, other, requester, code) {
    const rs = await db.execute(
        `DELETE FROM relationships WHERE pair_key = ? IF status = 'PENDING' AND requester_id = ?`,
        [pairKey(me, other), requester]
    );
    if (!rs.wasApplied()) throw httpError(404, code, 'Lời mời kết bạn không còn tồn tại.');
    await clearRequestIndex(me, other);
    notify([me, other], 'friend:updated', { userIds: [me, other], status: 'NONE', actorId: me });
    return { status: 'NONE', changed: true };
}

const declineRequest = (user, senderId) => {
    const sender = requireTarget(user, senderId);
    return removePending(user.userId, sender, sender, 'REQUEST_NOT_FOUND');
};

const cancelRequest = (user, targetUserId) => {
    const target = requireTarget(user, targetUserId);
    return removePending(user.userId, target, user.userId, 'REQUEST_NOT_FOUND');
};

// Xoa ket ban: KHONG xoa hoi thoai / lich su chat.
async function unfriend(user, friendId) {
    const friend = requireTarget(user, friendId);
    const rs = await db.execute(
        `DELETE FROM relationships WHERE pair_key = ? IF status = 'FRIENDS'`, [pairKey(user.userId, friend)]
    );
    if (!rs.wasApplied()) throw httpError(404, 'NOT_FRIENDS', 'Hai người chưa là bạn bè.');
    await clearFriendIndex(user.userId, friend);
    notify([user.userId, friend], 'friend:updated', { userIds: [user.userId, friend], status: 'NONE', actorId: user.userId });
    return { status: 'NONE', changed: true };
}

// ===== Chan =====

async function block(user, targetUserId) {
    const target = requireTarget(user, targetUserId);
    await requireUser(target);
    await db.execute(
        'INSERT INTO blocked_users_by_user (user_id, blocked_id, created_at) VALUES (?, ?, ?)',
        [user.userId, target, new Date()]
    );
    // Chan = huy moi quan he / loi moi hien co (LWT theo trang thai dang doc duoc).
    const rel = await getRelationship(user.userId, target);
    if (rel) {
        await db.execute('DELETE FROM relationships WHERE pair_key = ? IF status = ?', [pairKey(user.userId, target), rel.status]);
    }
    await Promise.all([clearRequestIndex(user.userId, target), clearFriendIndex(user.userId, target)]);
    notify([user.userId], 'friend:updated', { userIds: [user.userId, target], status: 'BLOCKED', actorId: user.userId });
    if (rel) notify([target], 'friend:updated', { userIds: [user.userId, target], status: 'NONE', actorId: user.userId });
    return { status: 'BLOCKED', changed: true };
}

async function unblock(user, targetUserId) {
    const target = requireTarget(user, targetUserId);
    await db.execute('DELETE FROM blocked_users_by_user WHERE user_id = ? AND blocked_id = ?', [user.userId, target]);
    notify([user.userId], 'friend:updated', { userIds: [user.userId, target], status: 'NONE', actorId: user.userId });
    return { status: 'NONE', changed: true };
}

// ===== Liet ke =====

async function readAll(query, params) {
    const rows = [];
    let pageState;
    do {
        const rs = await db.execute(query, params, { fetchSize: 200, pageState });
        rows.push(...rs.rows);
        pageState = rs.pageState;
    } while (pageState && rows.length < LIST_CAP);
    return rows;
}

async function withProfiles(entries) {
    const profiles = await userService.getUsersByIds(entries.map(e => e.userId));
    return entries
        .filter(e => profiles.has(e.userId))
        .map(e => ({ ...profiles.get(e.userId), ...e }))
        .sort((a, b) => (b.at || '').localeCompare(a.at || ''));
}

async function listFriends(user) {
    const rows = await readAll('SELECT friend_id, since FROM friends_by_user WHERE user_id = ?', [user.userId]);
    const checked = await Promise.all(rows.map(async r => {
        const rel = await getRelationship(user.userId, r.friend_id);
        if (rel && rel.status === 'FRIENDS') return { userId: r.friend_id, at: iso(r.since) };
        await db.execute('DELETE FROM friends_by_user WHERE user_id = ? AND friend_id = ?', [user.userId, r.friend_id]);
        return null;
    }));
    return withProfiles(checked.filter(Boolean));
}

async function listRequests(user, direction) {
    const incoming = direction !== 'outgoing';
    const rows = incoming
        ? (await readAll('SELECT sender_id, created_at FROM friend_requests_by_receiver WHERE receiver_id = ?', [user.userId]))
            .map(r => ({ other: r.sender_id, created_at: r.created_at }))
        : (await readAll('SELECT receiver_id, created_at FROM friend_requests_by_sender WHERE sender_id = ?', [user.userId]))
            .map(r => ({ other: r.receiver_id, created_at: r.created_at }));
    const checked = await Promise.all(rows.map(async r => {
        const rel = await getRelationship(user.userId, r.other);
        const expectRequester = incoming ? r.other : user.userId;
        if (rel && rel.status === 'PENDING' && rel.requester_id === expectRequester) return { userId: r.other, at: iso(r.created_at) };
        return null; // chi muc lech: an di (lenh accept/decline/cancel tiep theo se don)
    }));
    return withProfiles(checked.filter(Boolean));
}

async function listBlocked(user) {
    const rows = await readAll('SELECT blocked_id, created_at FROM blocked_users_by_user WHERE user_id = ?', [user.userId]);
    return withProfiles(rows.map(r => ({ userId: r.blocked_id, at: iso(r.created_at) })));
}

// Gan trang thai quan he cho ket qua tim kiem (toi da 20 nguoi -> 20-40 lan doc theo khoa).
async function annotate(user, people) {
    return Promise.all(people.map(async p => ({ ...p, relationship: await relationshipStatus(user.userId, p.userId) })));
}

// ===== Ho so =====

async function readProfileRow(userId) {
    return (await db.execute('SELECT username, bio, updated_at FROM user_profiles WHERE user_id = ?', [userId])).first();
}

// Ho so cong khai: KHONG co email / so dien thoai.
async function getProfile(viewer, userId) {
    const target = String(userId || '').trim();
    if (!ID_RE.test(target)) throw httpError(400, 'INVALID_USER_ID', 'Mã người dùng không hợp lệ.');
    const base = await requireUser(target);
    if (target !== viewer.userId && await blockedBy(target, viewer.userId)) {
        throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    }
    const row = await readProfileRow(target);
    return {
        userId: base.userId,
        displayName: base.displayName,
        avatarUrl: base.avatarUrl || null,
        username: row?.username || null,
        bio: row?.bio || '',
        relationship: await relationshipStatus(viewer.userId, target)
    };
}

async function updateProfile(user, body = {}) {
    const current = await readProfileRow(user.userId);
    let username = current?.username || null;
    let bio = current?.bio || '';

    if (body.bio !== undefined) {
        if (typeof body.bio !== 'string') throw httpError(400, 'INVALID_BIO', 'Giới thiệu phải là văn bản.');
        bio = body.bio.replace(/\r\n/g, '\n').trim();
        if (bio.length > BIO_MAX) throw httpError(400, 'INVALID_BIO', `Giới thiệu tối đa ${BIO_MAX} ký tự.`);
    }

    if (body.username !== undefined) {
        const next = body.username === null || body.username === '' ? null : String(body.username).trim().toLowerCase();
        if (next !== null && !USERNAME_RE.test(next)) {
            throw httpError(400, 'INVALID_USERNAME', 'Tên người dùng 3-30 ký tự: chữ thường không dấu, số, dấu chấm hoặc gạch dưới; không bắt đầu/kết thúc bằng dấu.');
        }
        if (next !== username) {
            if (next) {
                const rs = await db.execute(
                    'INSERT INTO usernames (username, user_id, created_at) VALUES (?, ?, ?) IF NOT EXISTS',
                    [next, user.userId, new Date()]
                );
                const owner = rs.wasApplied() ? user.userId
                    : (await db.execute('SELECT user_id FROM usernames WHERE username = ?', [next])).first()?.user_id;
                if (owner !== user.userId) {
                    throw httpError(409, 'USERNAME_TAKEN', 'Tên người dùng này đã có người dùng.');
                }
            }
            if (username) {
                await db.execute('DELETE FROM usernames WHERE username = ? IF user_id = ?', [username, user.userId]);
            }
            username = next;
        }
    }

    await db.execute(
        'INSERT INTO user_profiles (user_id, username, bio, updated_at) VALUES (?, ?, ?, ?)',
        [user.userId, username, bio, new Date()]
    );
    return getProfile(user, user.userId);
}

module.exports = {
    pairKey, relationshipStatus, blockState, assertNotBlocked,
    sendRequest, acceptRequest, declineRequest, cancelRequest, unfriend, block, unblock,
    listFriends, listRequests, listBlocked, annotate, getProfile, updateProfile
};
