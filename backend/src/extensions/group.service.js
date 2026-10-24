// Nhom mo rong: PT-05 vai tro (truong / pho nhom, chuyen quyen, nhan quyen nhom cu),
// PT-10 anh & mo ta nhom, PT-11 tat thong bao / luu tru, PT-19 link moi + duyet thanh vien.
//
// Truong nhom van la conversations.created_by (khong doi y nghia du lieu cu).
// Pho nhom (DEPUTY) nam o conversation_members; chi tinh khi nguoi do VAN la thanh vien.
const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { Uuid, iso } = require('../utils/types');
const { validateGroupName } = require('../utils/validate');
const conversations = require('../services/conversation.service');
const userService = require('../services/user.service');
const realtime = require('../services/realtime.service');
const storage = require('./lib/storage');

const messages = () => require('../services/message.service');
const notifications = () => require('../services/notification.service');

const ROLES = ['OWNER', 'DEPUTY', 'MEMBER'];
const DESCRIPTION_MAX = 500;
const MAX_MEMBERS = 100;

async function requireGroup(conversationId, user) {
    const ctx = await conversations.requireMembership(conversationId, user.userId);
    if (ctx.row.conversation_type !== 'GROUP') throw httpError(400, 'NOT_A_GROUP', 'Thao tác này chỉ áp dụng cho nhóm chat.');
    return ctx;
}

async function deputiesOf(cid, members) {
    const rs = await db.execute('SELECT user_id, role FROM conversation_members WHERE conversation_id = ?', [cid]);
    return rs.rows.filter(r => r.role === 'DEPUTY' && members.includes(r.user_id)).map(r => r.user_id);
}

function roleOf(userId, ownerId, deputies) {
    if (ownerId && userId === ownerId) return 'OWNER';
    if (deputies.includes(userId)) return 'DEPUTY';
    return 'MEMBER';
}

async function context(conversationId, user) {
    const ctx = await requireGroup(conversationId, user);
    const deputies = await deputiesOf(ctx.cid, ctx.members);
    const ownerId = ctx.row.created_by || null;
    const myRole = roleOf(user.userId, ownerId, deputies);
    return { ...ctx, deputies, ownerId, myRole, canManage: myRole === 'OWNER' || myRole === 'DEPUTY' };
}

const requireManager = (ctx, action) => {
    if (!ctx.canManage) {
        throw httpError(403, ctx.ownerId ? 'FORBIDDEN_MANAGE_GROUP' : 'GROUP_OWNER_UNKNOWN',
            ctx.ownerId ? `Chỉ trưởng nhóm hoặc phó nhóm mới được ${action}.` : `Nhóm chưa có trưởng nhóm nên không ai được ${action}. Hãy nhận quyền trưởng nhóm trước.`);
    }
};

async function roles(conversationId, user) {
    const ctx = await context(conversationId, user);
    const claim = (await db.execute('SELECT user_id FROM group_owner_claims WHERE conversation_id = ?', [ctx.cid])).first();
    return {
        conversationId: ctx.cid.toString(),
        ownerId: ctx.ownerId,
        deputies: ctx.deputies,
        myRole: ctx.myRole,
        canManage: ctx.canManage,
        canAssignRoles: ctx.myRole === 'OWNER',
        canClaimOwner: !ctx.ownerId && !claim,
        roles: Object.fromEntries(ctx.members.map(id => [id, roleOf(id, ctx.ownerId, ctx.deputies)]))
    };
}

async function systemMessage(ctx, actor, text, members = ctx.members) {
    const row = (await db.execute(
        `SELECT conversation_id, conversation_name, conversation_type, participant_ids, created_by, created_at, last_message_at
         FROM conversations WHERE conversation_id = ?`, [ctx.cid])).first();
    await messages().postSystemMessage(row, members, actor, text);
}

async function nameOf(userId) {
    return (await userService.getUsersByIds([userId])).get(userId)?.displayName || userId;
}

// PUT /conversations/:id/members/:uid/role  { role: OWNER | DEPUTY | MEMBER } - chi truong nhom.
async function setRole(conversationId, user, memberId, body = {}) {
    const ctx = await context(conversationId, user);
    const role = String(body.role || '').toUpperCase();
    if (!ROLES.includes(role)) throw httpError(400, 'INVALID_ROLE', 'Vai trò phải là OWNER, DEPUTY hoặc MEMBER.');
    if (ctx.myRole !== 'OWNER') throw httpError(403, 'FORBIDDEN_MANAGE_GROUP', 'Chỉ trưởng nhóm mới được phân quyền.');
    const target = String(memberId || '');
    if (!ctx.members.includes(target)) throw httpError(404, 'MEMBER_NOT_FOUND', 'Người này không ở trong nhóm.');
    if (target === user.userId) throw httpError(400, 'SELF_ROLE', 'Hãy chuyển quyền trưởng nhóm cho người khác thay vì tự đổi vai trò.');
    const now = new Date();
    const targetName = await nameOf(target);
    if (role === 'OWNER') {
        await db.batch([
            { query: 'UPDATE conversations SET created_by = ? WHERE conversation_id = ?', params: [target, ctx.cid] },
            { query: 'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', params: [ctx.cid, target] },
            { query: "INSERT INTO conversation_members (conversation_id, user_id, role, updated_at, updated_by) VALUES (?, ?, 'DEPUTY', ?, ?)",
                params: [ctx.cid, user.userId, now, user.userId] }
        ]);
        await systemMessage(ctx, user, `${user.displayName} đã chuyển quyền trưởng nhóm cho ${targetName}`);
    } else if (role === 'DEPUTY') {
        await db.execute('INSERT INTO conversation_members (conversation_id, user_id, role, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)',
            [ctx.cid, target, 'DEPUTY', now, user.userId]);
        await systemMessage(ctx, user, `${user.displayName} đã bổ nhiệm ${targetName} làm phó nhóm`);
    } else {
        await db.execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [ctx.cid, target]);
        if (ctx.deputies.includes(target)) await systemMessage(ctx, user, `${user.displayName} đã gỡ quyền phó nhóm của ${targetName}`);
    }
    realtime.publish(ctx.members, 'group:updated', { conversationId: ctx.cid.toString(), reason: 'roles' });
    return roles(conversationId, user);
}

// Nhom cu (created_by = null): thanh vien dau tien nhan quyen thang (LWT IF NOT EXISTS tren bang rieng).
async function claimOwner(conversationId, user) {
    const ctx = await context(conversationId, user);
    if (ctx.ownerId) throw httpError(409, 'GROUP_HAS_OWNER', 'Nhóm đã có trưởng nhóm.');
    const rs = await db.execute('INSERT INTO group_owner_claims (conversation_id, user_id, claimed_at) VALUES (?, ?, ?) IF NOT EXISTS',
        [ctx.cid, user.userId, new Date()]);
    if (!rs.wasApplied()) throw httpError(409, 'GROUP_HAS_OWNER', 'Một thành viên khác vừa nhận quyền trưởng nhóm.');
    await db.execute('UPDATE conversations SET created_by = ? WHERE conversation_id = ?', [user.userId, ctx.cid]);
    await systemMessage(ctx, user, `${user.displayName} đã nhận quyền trưởng nhóm`);
    realtime.publish(ctx.members, 'group:updated', { conversationId: ctx.cid.toString(), reason: 'roles' });
    return roles(conversationId, user);
}

// Quan tri vien gan truong nhom cho nhom cu.
async function assignOwnerByAdmin(conversationId, admin, userId) {
    const cid = Uuid.fromString(String(conversationId).toLowerCase());
    const row = await conversations.getConversationRow(cid);
    if (row.conversation_type !== 'GROUP') throw httpError(400, 'NOT_A_GROUP', 'Chỉ áp dụng cho nhóm chat.');
    const members = conversations.membersOf(row);
    if (!members.includes(userId)) throw httpError(404, 'MEMBER_NOT_FOUND', 'Người này không ở trong nhóm.');
    await db.execute('UPDATE conversations SET created_by = ? WHERE conversation_id = ?', [userId, cid]);
    await messages().postSystemMessage(row, members, admin, `Quản trị viên đã đặt ${await nameOf(userId)} làm trưởng nhóm`);
    realtime.publish(members, 'group:updated', { conversationId: cid.toString(), reason: 'roles' });
    return { conversationId: cid.toString(), ownerId: userId };
}

// ===== Pho nhom: doi ten / xoa thanh vien (route cu chi cho truong nhom) =====
// Tra ve null neu nguoi goi khong phai pho nhom -> route cu xu ly nhu truoc.
async function deputyRename(conversationId, user, body) {
    const ctx = await context(conversationId, user).catch(() => null);
    if (!ctx || ctx.myRole !== 'DEPUTY') return null;
    const name = validateGroupName(body && body.name);
    if (name !== ctx.row.conversation_name) {
        await db.execute('UPDATE conversations SET conversation_name = ? WHERE conversation_id = ?', [name, ctx.cid]);
        await messages().postSystemMessage({ ...ctx.row, conversation_name: name }, ctx.members, user,
            `${user.displayName} đã đổi tên nhóm thành “${name}”`);
    }
    return conversations.getDetail(conversationId, user);
}

async function deputyRemove(conversationId, user, memberId) {
    const ctx = await context(conversationId, user).catch(() => null);
    if (!ctx || ctx.myRole !== 'DEPUTY' || String(memberId) === user.userId) return null;
    const target = String(memberId || '');
    if (!ctx.members.includes(target)) throw httpError(404, 'MEMBER_NOT_FOUND', 'Người này không ở trong nhóm.');
    if (target === ctx.ownerId || ctx.deputies.includes(target)) {
        throw httpError(403, 'FORBIDDEN_MANAGE_GROUP', 'Phó nhóm không được xóa trưởng nhóm hoặc phó nhóm khác.');
    }
    await removeFromGroup(ctx, user, target, `${user.displayName} đã xóa ${await nameOf(target)} khỏi nhóm`);
    return conversations.getDetail(conversationId, user);
}

// Giong thu tu ghi cua removeMember cu: participant_ids, chi muc danh sach, trang thai rieng -> 1 batch.
async function removeFromGroup(ctx, actor, target, text) {
    const remaining = ctx.members.filter(id => id !== target);
    const queries = [
        { query: 'UPDATE conversations SET participant_ids = participant_ids - ? WHERE conversation_id = ?', params: [[target], ctx.cid] },
        { query: 'DELETE FROM conversation_state_by_user WHERE user_id = ? AND conversation_id = ?', params: [target, ctx.cid] },
        { query: 'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', params: [ctx.cid, target] }
    ];
    for (const idx of await conversations.findIndexRows(target, ctx.cid)) {
        queries.push({
            query: 'DELETE FROM conversations_by_user WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
            params: [target, idx.last_message_at, ctx.cid]
        });
    }
    await db.batch(queries);
    await messages().postSystemMessage({ ...ctx.row, participant_ids: remaining }, remaining, actor, text);
    realtime.publish([target], 'conversation:removed', { conversationId: ctx.cid.toString() });
}

// ===== PT-10: anh & mo ta nhom =====
async function readProfile(cid) {
    return (await db.execute('SELECT description, avatar_key, avatar_mime, updated_at, updated_by FROM group_profiles WHERE conversation_id = ?', [cid])).first();
}

async function getProfile(conversationId, user) {
    const ctx = await context(conversationId, user);
    const p = await readProfile(ctx.cid);
    return {
        conversationId: ctx.cid.toString(),
        description: (p && p.description) || '',
        avatarUrl: p && p.avatar_key ? `/api/v1/conversations/${ctx.cid}/avatar?v=${new Date(p.updated_at || 0).getTime()}` : null,
        updatedAt: iso(p && p.updated_at),
        canEdit: ctx.canManage
    };
}

async function updateProfile(conversationId, user, body = {}) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'sửa thông tin nhóm');
    if (typeof body.description !== 'string') throw httpError(400, 'INVALID_DESCRIPTION', 'Mô tả phải là văn bản.');
    const description = body.description.replace(/\r\n/g, '\n').trim();
    if (description.length > DESCRIPTION_MAX) throw httpError(400, 'INVALID_DESCRIPTION', `Mô tả tối đa ${DESCRIPTION_MAX} ký tự.`);
    await db.execute('UPDATE group_profiles SET description = ?, updated_at = ?, updated_by = ? WHERE conversation_id = ?',
        [description, new Date(), user.userId, ctx.cid]);
    await systemMessage(ctx, user, `${user.displayName} đã cập nhật mô tả nhóm`);
    realtime.publish(ctx.members, 'group:updated', { conversationId: ctx.cid.toString(), reason: 'profile' });
    return getProfile(conversationId, user);
}

async function uploadAvatar(conversationId, user, buffer) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'đổi ảnh nhóm');
    const mime = storage.checkImage(buffer, 5 * 1024 * 1024);
    const key = await storage.save('groups', buffer);
    const old = await readProfile(ctx.cid);
    await db.execute('UPDATE group_profiles SET avatar_key = ?, avatar_mime = ?, updated_at = ?, updated_by = ? WHERE conversation_id = ?',
        [key, mime, new Date(), user.userId, ctx.cid]);
    if (old && old.avatar_key) await storage.remove('groups', old.avatar_key);
    await systemMessage(ctx, user, `${user.displayName} đã đổi ảnh nhóm`);
    realtime.publish(ctx.members, 'avatar:changed', { id: ctx.cid.toString() });
    return getProfile(conversationId, user);
}

async function removeAvatar(conversationId, user) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'xóa ảnh nhóm');
    const old = await readProfile(ctx.cid);
    if (old && old.avatar_key) {
        await db.execute('UPDATE group_profiles SET avatar_key = null, avatar_mime = null, updated_at = ? WHERE conversation_id = ?', [new Date(), ctx.cid]);
        await storage.remove('groups', old.avatar_key);
    }
    realtime.publish(ctx.members, 'avatar:changed', { id: ctx.cid.toString() });
    return getProfile(conversationId, user);
}

async function openAvatar(conversationId, user) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const p = await readProfile(cid);
    if (!p || !p.avatar_key) throw httpError(404, 'FILE_GONE', 'Nhóm chưa có ảnh.');
    return { key: p.avatar_key, mime: p.avatar_mime };
}

// ===== PT-11: tat thong bao / luu tru =====
const MUTE = { '1h': 3600e3, '8h': 8 * 3600e3, '24h': 24 * 3600e3 };
const FOREVER = new Date('2999-12-31T00:00:00Z');

async function setPrefs(conversationId, user, body = {}) {
    const { cid } = await conversations.requireMembership(conversationId, user.userId);
    const current = (await db.execute('SELECT muted_until, archived FROM conversation_prefs_by_user WHERE user_id = ? AND conversation_id = ?',
        [user.userId, cid])).first();
    let mutedUntil = current ? current.muted_until : null;
    let archived = current ? Boolean(current.archived) : false;
    if (body.mute !== undefined) {
        if (body.mute === null || body.mute === 'off') mutedUntil = null;
        else if (body.mute === 'forever') mutedUntil = FOREVER;
        else if (MUTE[body.mute]) mutedUntil = new Date(Date.now() + MUTE[body.mute]);
        else throw httpError(400, 'INVALID_MUTE', 'mute phải là 1h, 8h, 24h, forever hoặc off.');
    }
    if (body.archived !== undefined) {
        if (typeof body.archived !== 'boolean') throw httpError(400, 'INVALID_ARCHIVED', 'archived phải là true hoặc false.');
        archived = body.archived;
    }
    await db.execute('INSERT INTO conversation_prefs_by_user (user_id, conversation_id, muted_until, archived, updated_at) VALUES (?, ?, ?, ?, ?)',
        [user.userId, cid, mutedUntil, archived, new Date()]);
    const dto = prefDto(cid.toString(), mutedUntil, archived);
    realtime.publish([user.userId], 'conversation:prefs', dto);
    return dto;
}

function prefDto(conversationId, mutedUntil, archived) {
    const until = mutedUntil ? new Date(mutedUntil) : null;
    const muted = Boolean(until && until.getTime() > Date.now());
    return {
        conversationId,
        muted,
        mutedUntil: muted ? until.toISOString() : null,
        mutedForever: Boolean(muted && until.getUTCFullYear() >= 2999),
        archived: Boolean(archived)
    };
}

async function listPrefs(user) {
    const rs = await db.execute('SELECT conversation_id, muted_until, archived FROM conversation_prefs_by_user WHERE user_id = ?', [user.userId], { fetchSize: 1000 });
    return { items: rs.rows.map(r => prefDto(r.conversation_id.toString(), r.muted_until, r.archived)) };
}

async function isMuted(userId, conversationId) {
    if (!conversationId) return false;
    const cid = typeof conversationId === 'string' ? Uuid.fromString(conversationId) : conversationId;
    const r = (await db.execute('SELECT muted_until FROM conversation_prefs_by_user WHERE user_id = ? AND conversation_id = ?', [userId, cid])).first();
    return Boolean(r && r.muted_until && new Date(r.muted_until).getTime() > Date.now());
}

// ===== PT-19: link moi =====
const newCode = () => crypto.randomBytes(9).toString('base64url');

async function createInvite(conversationId, user, body = {}) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'tạo link mời');
    const requireApproval = Boolean(body.requireApproval);
    const code = newCode();
    const now = new Date();
    const rs = await db.execute(
        'INSERT INTO group_invite_links (invite_code, conversation_id, created_by, created_at, require_approval, revoked) VALUES (?, ?, ?, ?, ?, false) IF NOT EXISTS',
        [code, ctx.cid, user.userId, now, requireApproval]);
    if (!rs.wasApplied()) throw httpError(409, 'RETRY', 'Hãy thử lại.');
    await db.execute('INSERT INTO invite_links_by_conversation (conversation_id, invite_code, created_by, created_at, require_approval, revoked) VALUES (?, ?, ?, ?, ?, false)',
        [ctx.cid, code, user.userId, now, requireApproval]);
    return listInvites(conversationId, user);
}

async function listInvites(conversationId, user) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'xem link mời');
    const rs = await db.execute('SELECT invite_code, created_by, created_at, require_approval, revoked FROM invite_links_by_conversation WHERE conversation_id = ?', [ctx.cid]);
    const requests = await listJoinRequests(ctx);
    return {
        items: rs.rows.filter(r => !r.revoked).map(r => ({
            code: r.invite_code, createdBy: r.created_by, createdAt: iso(r.created_at), requireApproval: Boolean(r.require_approval)
        })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
        requests
    };
}

async function revokeInvite(conversationId, user, code) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'thu hồi link mời');
    const row = (await db.execute('SELECT conversation_id FROM group_invite_links WHERE invite_code = ?', [String(code || '')])).first();
    if (!row || row.conversation_id.toString() !== ctx.cid.toString()) throw httpError(404, 'INVITE_NOT_FOUND', 'Không tìm thấy link mời.');
    await db.execute('UPDATE group_invite_links SET revoked = true WHERE invite_code = ?', [code]);
    await db.execute('UPDATE invite_links_by_conversation SET revoked = true WHERE conversation_id = ? AND invite_code = ?', [ctx.cid, code]);
    return listInvites(conversationId, user);
}

async function readInvite(code) {
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(code || ''))) throw httpError(404, 'INVITE_NOT_FOUND', 'Link mời không hợp lệ.');
    const inv = (await db.execute('SELECT invite_code, conversation_id, created_by, require_approval, revoked FROM group_invite_links WHERE invite_code = ?', [code])).first();
    if (!inv || inv.revoked) throw httpError(404, 'INVITE_NOT_FOUND', 'Link mời không còn hiệu lực.');
    const row = await conversations.getConversationRow(inv.conversation_id);
    return { inv, row, members: conversations.membersOf(row) };
}

async function previewInvite(code, user) {
    const { inv, row, members } = await readInvite(code);
    const pending = (await db.execute('SELECT user_id FROM group_join_requests WHERE conversation_id = ? AND user_id = ?', [row.conversation_id, user.userId])).first();
    const p = await readProfile(row.conversation_id);
    return {
        code: inv.invite_code,
        conversationId: row.conversation_id.toString(),
        name: row.conversation_name,
        description: (p && p.description) || '',
        memberCount: members.length,
        requireApproval: Boolean(inv.require_approval),
        isMember: members.includes(user.userId),
        pending: Boolean(pending)
    };
}

async function addToGroup(row, members, actor, newIds, text) {
    if (members.length + newIds.length > MAX_MEMBERS) throw httpError(400, 'INVALID_MEMBERS', 'Nhóm tối đa 100 thành viên.');
    await db.execute('UPDATE conversations SET participant_ids = participant_ids + ? WHERE conversation_id = ?', [newIds, row.conversation_id]);
    const all = [...members, ...newIds];
    await messages().postSystemMessage({ ...row, participant_ids: all }, all, actor, text);
    realtime.publish(newIds, 'conversation:updated', { conversationId: row.conversation_id.toString() });
}

async function joinByInvite(code, user) {
    const { inv, row, members } = await readInvite(code);
    if (members.includes(user.userId)) return { joined: true, conversationId: row.conversation_id.toString() };
    if (inv.require_approval) {
        await db.execute('INSERT INTO group_join_requests (conversation_id, user_id, requested_at, invite_code) VALUES (?, ?, ?, ?)',
            [row.conversation_id, user.userId, new Date(), inv.invite_code]);
        const deputies = await deputiesOf(row.conversation_id, members);
        const managers = [row.created_by, ...deputies].filter(Boolean);
        for (const m of managers) {
            await notifications().notifySafe({
                recipientId: m, actorId: user.userId, type: 'GROUP_JOIN_REQUEST', conversationId: row.conversation_id,
                dedupeKey: `JOIN:${row.conversation_id}:${user.userId}:${Date.now()}`, preview: `muốn tham gia nhóm “${row.conversation_name}”`
            });
        }
        realtime.publish(managers, 'group:updated', { conversationId: row.conversation_id.toString(), reason: 'join-request' });
        return { joined: false, pending: true, conversationId: row.conversation_id.toString() };
    }
    await addToGroup(row, members, user, [user.userId], `${user.displayName} đã tham gia nhóm bằng link mời`);
    return { joined: true, conversationId: row.conversation_id.toString() };
}

async function listJoinRequests(ctx) {
    const rs = await db.execute('SELECT user_id, requested_at FROM group_join_requests WHERE conversation_id = ?', [ctx.cid]);
    const profiles = await userService.getUsersByIds(rs.rows.map(r => r.user_id));
    return rs.rows.filter(r => !ctx.members.includes(r.user_id)).map(r => ({
        userId: r.user_id, displayName: profiles.get(r.user_id)?.displayName || r.user_id, requestedAt: iso(r.requested_at)
    }));
}

async function decideJoin(conversationId, user, userId, approve) {
    const ctx = await context(conversationId, user);
    requireManager(ctx, 'duyệt thành viên');
    const target = String(userId || '');
    const req = (await db.execute('SELECT user_id FROM group_join_requests WHERE conversation_id = ? AND user_id = ?', [ctx.cid, target])).first();
    if (!req) throw httpError(404, 'REQUEST_NOT_FOUND', 'Không tìm thấy yêu cầu tham gia.');
    await db.execute('DELETE FROM group_join_requests WHERE conversation_id = ? AND user_id = ?', [ctx.cid, target]);
    if (approve && !ctx.members.includes(target)) {
        await addToGroup(ctx.row, ctx.members, user, [target], `${user.displayName} đã duyệt ${await nameOf(target)} vào nhóm`);
    }
    return listInvites(conversationId, user);
}

module.exports = {
    roles, setRole, claimOwner, assignOwnerByAdmin, deputyRename, deputyRemove, context,
    getProfile, updateProfile, uploadAvatar, removeAvatar, openAvatar,
    setPrefs, listPrefs, isMuted, createInvite, listInvites, revokeInvite, previewInvite, joinByInvite, decideJoin
};
