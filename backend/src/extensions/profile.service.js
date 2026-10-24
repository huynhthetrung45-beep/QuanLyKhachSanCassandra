// Ho so mo rong: PT-03 doi ten hien thi, PT-04 anh dai dien / anh bia, PT-18 goi y ket ban,
// han che 3.3 "lan cuoi truy cap" luu ben vung.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { Uuid, iso } = require('../utils/types');
const { nameTokens, tokenBucket } = require('../utils/text');
const userService = require('../services/user.service');
const social = require('../services/social.service');
const realtime = require('../services/realtime.service');
const conversations = require('../services/conversation.service');
const storage = require('./lib/storage');

// Ky tu dieu khien / dao chieu van ban (giong validate.js)
const CONTROL_RE = new RegExp('[' + [[0,31],[127,159],[8203,8207],[8232,8238],[8294,8297]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']');
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;

function validateDisplayName(raw) {
    const name = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 50) {
        throw httpError(400, 'VALIDATION_ERROR', 'Tên hiển thị cần từ 2 đến 50 ký tự.', { fields: { displayName: 'Từ 2 đến 50 ký tự.' } });
    }
    if (CONTROL_RE.test(name)) throw httpError(400, 'VALIDATION_ERROR', 'Tên hiển thị chứa ký tự không hợp lệ.', { fields: { displayName: 'Ký tự không hợp lệ.' } });
    return name;
}

async function readUser(userId) {
    return (await db.execute('SELECT user_id, display_name, avatar_url, email FROM users WHERE user_id = ?', [userId])).first();
}

// ===== PT-03 =====
// users + users_by_name_token trong CUNG mot logged batch (xoa token cu, ghi token moi).
// Ten hoi thoai 1-1 luu dang "Ten A - Ten B" -> cap nhat phan ten cua minh de danh sach hien dung ten nguoi kia.
async function changeDisplayName(user, body = {}) {
    const name = validateDisplayName(body.displayName);
    const row = await readUser(user.userId);
    if (!row) throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    const oldName = row.display_name;
    if (name === oldName) return { userId: user.userId, displayName: name, changed: false };

    const oldTokens = nameTokens(oldName);
    const newTokens = nameTokens(name);
    const queries = [{ query: 'UPDATE users SET display_name = ? WHERE user_id = ?', params: [name, user.userId] }];
    oldTokens.filter(t => !newTokens.includes(t)).forEach(token => queries.push({
        query: 'DELETE FROM users_by_name_token WHERE token_prefix = ? AND name_token = ? AND user_id = ?',
        params: [tokenBucket(token), token, user.userId]
    }));
    newTokens.forEach(token => queries.push({
        query: `INSERT INTO users_by_name_token (token_prefix, name_token, user_id, display_name, avatar_url)
                VALUES (?, ?, ?, ?, ?)`,
        params: [tokenBucket(token), token, user.userId, name, row.avatar_url || null]
    }));
    await db.batch(queries);

    await renameDirectConversations(user.userId, oldName, name).catch(error =>
        console.warn('[ext] Không cập nhật được tên hội thoại 1-1:', error.message));
    const peers = await conversations.peersOf(user.userId).catch(() => []);
    realtime.publish([user.userId, ...peers], 'conversation:updated', { reason: 'display-name', userId: user.userId });
    realtime.publish([user.userId], 'account:security', { reason: 'profile' });
    return { userId: user.userId, displayName: name, changed: true };
}

async function renameDirectConversations(userId, oldName, newName) {
    const rows = (await db.execute(
        'SELECT last_message_at, conversation_id, conversation_name, conversation_type FROM conversations_by_user WHERE user_id = ?',
        [userId])).rows.filter(r => r.conversation_type === 'DIRECT');
    for (const r of rows) {
        const parts = String(r.conversation_name || '').split(' - ');
        if (parts.length !== 2 || !parts.includes(oldName)) continue;
        const renamed = parts.map(p => (p === oldName ? newName : p)).join(' - ');
        const conv = (await db.execute('SELECT participant_ids FROM conversations WHERE conversation_id = ?', [r.conversation_id])).first();
        if (!conv) continue;
        const updates = [{ query: 'UPDATE conversations SET conversation_name = ? WHERE conversation_id = ?', params: [renamed, r.conversation_id] }];
        for (const member of [...(conv.participant_ids || [])].map(String)) {
            for (const idx of await conversations.findIndexRows(member, r.conversation_id)) {
                updates.push({
                    query: 'UPDATE conversations_by_user SET conversation_name = ? WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
                    params: [renamed, member, idx.last_message_at, r.conversation_id]
                });
            }
        }
        await db.batch(updates);
    }
}

// ===== PT-04 =====
const avatarUrlOf = (userId, at) => `/api/v1/users/${encodeURIComponent(userId)}/avatar?v=${at.getTime()}`;

async function readMedia(userId) {
    return (await db.execute('SELECT avatar_key, avatar_mime, cover_key, cover_mime, updated_at FROM user_media WHERE user_id = ?', [userId])).first();
}

async function setAvatarUrl(userId, url) {
    const row = await readUser(userId);
    if (!row) return;
    const queries = [{ query: 'UPDATE users SET avatar_url = ? WHERE user_id = ?', params: [url, userId] }];
    nameTokens(row.display_name).forEach(token => queries.push({
        query: 'UPDATE users_by_name_token SET avatar_url = ? WHERE token_prefix = ? AND name_token = ? AND user_id = ?',
        params: [url, tokenBucket(token), token, userId]
    }));
    await db.batch(queries);
}

async function uploadProfileImage(user, kind, buffer) {
    const isAvatar = kind === 'avatar';
    const mime = storage.checkImage(buffer, isAvatar ? MAX_AVATAR_BYTES : MAX_COVER_BYTES);
    const key = await storage.save('profiles', buffer);
    const old = await readMedia(user.userId);
    const now = new Date();
    try {
        await db.execute(
            isAvatar
                ? 'UPDATE user_media SET avatar_key = ?, avatar_mime = ?, updated_at = ? WHERE user_id = ?'
                : 'UPDATE user_media SET cover_key = ?, cover_mime = ?, updated_at = ? WHERE user_id = ?',
            [key, mime, now, user.userId]
        );
        if (isAvatar) await setAvatarUrl(user.userId, avatarUrlOf(user.userId, now));
    } catch (error) {
        await storage.remove('profiles', key);
        throw error;
    }
    if (old) await storage.remove('profiles', isAvatar ? old.avatar_key : old.cover_key);
    realtime.publishAll('avatar:changed', { id: user.userId });
    return { kind, url: isAvatar ? avatarUrlOf(user.userId, now) : `/api/v1/users/${encodeURIComponent(user.userId)}/cover?v=${now.getTime()}` };
}

async function removeProfileImage(user, kind) {
    const old = await readMedia(user.userId);
    if (!old) return { removed: false };
    if (kind === 'avatar') {
        await db.execute('UPDATE user_media SET avatar_key = null, avatar_mime = null, updated_at = ? WHERE user_id = ?', [new Date(), user.userId]);
        await setAvatarUrl(user.userId, null);
        await storage.remove('profiles', old.avatar_key);
    } else {
        await db.execute('UPDATE user_media SET cover_key = null, cover_mime = null, updated_at = ? WHERE user_id = ?', [new Date(), user.userId]);
        await storage.remove('profiles', old.cover_key);
    }
    realtime.publishAll('avatar:changed', { id: user.userId });
    return { removed: true };
}

async function openProfileImage(viewer, userId, kind) {
    const target = String(userId || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(target)) throw httpError(400, 'INVALID_USER_ID', 'Mã người dùng không hợp lệ.');
    if (target !== viewer.userId) {
        const s = await social.blockState(viewer.userId, target);
        if (s.blockedMe) throw httpError(404, 'FILE_GONE', 'Không có ảnh.');
    }
    const media = await readMedia(target);
    const key = media && (kind === 'avatar' ? media.avatar_key : media.cover_key);
    if (!key) throw httpError(404, 'FILE_GONE', 'Người dùng chưa đặt ảnh.');
    return { key, mime: kind === 'avatar' ? media.avatar_mime : media.cover_mime };
}

// Tra cuu anh cho nhieu id cung luc (nguoi dung + nhom). Nhom chi tra anh neu nguoi xem la thanh vien.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function lookupAvatars(viewer, rawIds) {
    const ids = [...new Set(String(rawIds || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 100);
    const out = {};
    const userIds = ids.filter(id => !UUID_RE.test(id) && /^[A-Za-z0-9_-]{1,64}$/.test(id));
    const groupIds = ids.filter(id => UUID_RE.test(id));
    await Promise.all(userIds.map(async id => {
        const row = (await db.execute('SELECT avatar_url FROM users WHERE user_id = ?', [id])).first();
        out[id] = row && row.avatar_url ? row.avatar_url : null;
    }));
    await Promise.all(groupIds.map(async id => {
        const cid = Uuid.fromString(id.toLowerCase());
        const [conv, prof] = await Promise.all([
            db.execute('SELECT participant_ids, conversation_type FROM conversations WHERE conversation_id = ?', [cid]).then(r => r.first()),
            db.execute('SELECT avatar_key, updated_at FROM group_profiles WHERE conversation_id = ?', [cid]).then(r => r.first())
        ]);
        const member = conv && [...(conv.participant_ids || [])].map(String).includes(viewer.userId);
        out[id] = member && prof && prof.avatar_key
            ? `/api/v1/conversations/${id}/avatar?v=${new Date(prof.updated_at || 0).getTime()}` : null;
    }));
    return { avatars: out };
}

async function coverInfo(userId) {
    const media = await readMedia(userId);
    return {
        coverUrl: media && media.cover_key ? `/api/v1/users/${encodeURIComponent(userId)}/cover?v=${new Date(media.updated_at || 0).getTime()}` : null
    };
}

// ===== PT-18: goi y ket ban theo so ban chung =====
async function friendIds(userId, cap = 200) {
    const rs = await db.execute('SELECT friend_id FROM friends_by_user WHERE user_id = ?', [userId], { fetchSize: cap });
    return rs.rows.map(r => r.friend_id);
}

async function suggestions(user, limit = 20) {
    const mine = await friendIds(user.userId);
    const mineSet = new Set(mine);
    const counts = new Map();
    for (const friend of mine) {
        for (const fof of await friendIds(friend)) {
            if (fof === user.userId || mineSet.has(fof)) continue;
            const entry = counts.get(fof) || { count: 0, via: [] };
            entry.count += 1;
            if (entry.via.length < 3) entry.via.push(friend);
            counts.set(fof, entry);
        }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, limit * 2);
    const profiles = await userService.getUsersByIds([...ranked.map(([id]) => id), ...mine]);
    const out = [];
    for (const [id, entry] of ranked) {
        if (!profiles.has(id)) continue;
        const status = await social.relationshipStatus(user.userId, id);
        if (status === 'BLOCKED' || status === 'FRIENDS') continue;
        const s = await social.blockState(user.userId, id);
        if (s.blockedMe) continue;
        out.push({
            ...profiles.get(id),
            mutualCount: entry.count,
            mutualNames: entry.via.map(v => profiles.get(v)?.displayName).filter(Boolean),
            relationship: status
        });
        if (out.length >= limit) break;
    }
    return { data: out };
}

// ===== Lan cuoi truy cap ben vung =====
const persisted = new Map();
let presenceInstalled = false;
function installPresencePersistence() {
    if (presenceInstalled) return;
    presenceInstalled = true;
    const original = realtime.presenceOf;
    realtime.presenceOf = userId => {
        const p = original(userId);
        if (!p.online && !p.lastSeenAt && persisted.has(userId)) return { ...p, lastSeenAt: persisted.get(userId) };
        return p;
    };
    realtime.onPresenceChange((userId, online) => {
        if (online) return;
        const at = new Date();
        persisted.set(userId, at.toISOString());
        db.execute('INSERT INTO user_last_seen (user_id, last_seen_at) VALUES (?, ?)', [userId, at])
            .catch(error => console.warn('[ext] Không lưu được lần cuối truy cập:', error.message));
    });
}

async function loadPersistedPresence() {
    let pageState;
    let n = 0;
    do {
        const rs = await db.execute('SELECT user_id, last_seen_at FROM user_last_seen', [], { fetchSize: 500, pageState });
        rs.rows.forEach(r => { if (r.last_seen_at) persisted.set(r.user_id, iso(r.last_seen_at)); });
        n += rs.rows.length;
        pageState = rs.pageState;
    } while (pageState && n < 20000);
    return n;
}

module.exports = {
    changeDisplayName, uploadProfileImage, removeProfileImage, openProfileImage, lookupAvatars, coverInfo,
    suggestions, installPresencePersistence, loadPersistedPresence, validateDisplayName
};
