const crypto = require('crypto');
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { Uuid, parseUuid, iso } = require('../utils/types');
const { validateGroupName, validateUserIdList } = require('../utils/validate');
const userService = require('./user.service');
const realtime = require('./realtime.service');

// Lazy require de tranh vong lap module (message.service cung dung file nay).
const messages = () => require('./message.service');

const Q5 = `SELECT conversation_id, conversation_name, conversation_type, participant_ids,
                   created_by, created_at, last_message_at
            FROM conversations WHERE conversation_id = ?`;

const membersOf = row => [...(row.participant_ids || [])].map(String);

async function getConversationRow(conversationUuid) {
    const result = await db.execute(Q5, [conversationUuid]);
    const row = result.first();
    if (!row) {
        throw httpError(404, 'CONVERSATION_NOT_FOUND', 'Không tìm thấy cuộc trò chuyện.');
    }
    return row;
}

// BR-03: chi thanh vien moi duoc doc/gui. Kiem tra o backend cho MOI request.
async function requireMembership(conversationId, userId) {
    const cid = parseUuid(conversationId);
    const row = await getConversationRow(cid);
    const members = membersOf(row);
    if (!members.includes(userId)) {
        throw httpError(403, 'NOT_A_MEMBER', 'Bạn không phải thành viên của cuộc trò chuyện này.');
    }
    return { cid, row, members };
}

// Ten hien thi cua hoi thoai 1-1 voi tung nguoi xem: ten nguoi con lai.
// Ten luu trong CSDL co dang "Ten A - Ten B" (giu tuong thich du lieu mau).
function directDisplayName(storedName, viewerName) {
    const parts = String(storedName || '').split(' - ').map(part => part.trim()).filter(Boolean);
    if (parts.length === 2 && viewerName) {
        if (parts[0] === viewerName) return parts[1];
        if (parts[1] === viewerName) return parts[0];
    }
    return storedName;
}

// Cac dong cua mot hoi thoai trong danh sach cua mot nguoi (doc 1 partition user_id).
async function findIndexRows(userId, conversationUuid) {
    const result = await db.execute(
        'SELECT last_message_at, conversation_id FROM conversations_by_user WHERE user_id = ?',
        [userId]
    );
    return result.rows.filter(row => row.conversation_id.toString() === conversationUuid.toString());
}

// SRS 4.5.4: dua hoi thoai len dau danh sach cua MOI thanh vien.
// last_message_at la cot clustering nen phai DELETE dong cu + INSERT dong moi,
// gom trong mot LOGGED BATCH cung voi UPDATE conversations.last_message_at.
async function touchConversationIndex(row, members, { at, preview, senderName, senderId, name }) {
    const cid = row.conversation_id;
    const oldAt = row.last_message_at;
    const conversationName = name || row.conversation_name;
    const queries = [{
        query: 'UPDATE conversations SET last_message_at = ? WHERE conversation_id = ?',
        params: [at, cid]
    }];

    for (const memberId of members) {
        if (oldAt && new Date(oldAt).getTime() !== new Date(at).getTime()) {
            queries.push({
                query: `DELETE FROM conversations_by_user
                        WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?`,
                params: [memberId, oldAt, cid]
            });
        }
        queries.push({
            query: `INSERT INTO conversations_by_user
                    (user_id, last_message_at, conversation_id, conversation_name, conversation_type,
                     last_message_preview, last_sender_name, last_sender_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [memberId, at, cid, conversationName, row.conversation_type, preview, senderName, senderId]
        });
    }

    await db.batch(queries);
}

async function getStateMap(userId) {
    const result = await db.execute(
        'SELECT conversation_id, last_read_at, pinned FROM conversation_state_by_user WHERE user_id = ?',
        [userId]
    );
    const map = new Map();
    result.rows.forEach(row => map.set(row.conversation_id.toString(), row));
    return map;
}

// Q1: danh sach hoi thoai cua nguoi dung (1 partition user_id, da sap xep san
// theo last_message_at DESC). Neu co ban ghi trung (gui dong thoi - rui ro R-04
// trong SRS), giu dong moi nhat va don dong cu o nen.
async function listForUser(user) {
    const [result, states] = await Promise.all([
        db.execute(
            `SELECT user_id, last_message_at, conversation_id, conversation_name, conversation_type,
                    last_message_preview, last_sender_name, last_sender_id
             FROM conversations_by_user WHERE user_id = ?`,
            [user.userId]
        ),
        getStateMap(user.userId)
    ]);

    const seen = new Set();
    const stale = [];
    const items = [];

    for (const row of result.rows) {
        const id = row.conversation_id.toString();
        if (seen.has(id)) {
            stale.push(row);
            continue;
        }
        seen.add(id);

        const state = states.get(id);
        const lastAt = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
        const readAt = state && state.last_read_at ? new Date(state.last_read_at).getTime() : 0;
        const unread = Boolean(row.last_sender_id) && row.last_sender_id !== user.userId && lastAt > readAt;
        // So chua doc chi tinh duoc khi da co moc last_read_at; chua co moc -> chi hien cham.
        const countFrom = unread && state && state.last_read_at ? state.last_read_at : null;

        items.push({
            conversationId: id,
            conversationName: row.conversation_name,
            displayName: row.conversation_type === 'DIRECT'
                ? directDisplayName(row.conversation_name, user.displayName)
                : row.conversation_name,
            conversationType: row.conversation_type,
            lastMessagePreview: row.last_message_preview || '',
            lastSenderName: row.last_sender_name || '',
            lastSenderId: row.last_sender_id || null,
            lastMessageAt: iso(row.last_message_at),
            unread,
            unreadCount: null,
            countFrom,
            pinned: Boolean(state && state.pinned)
        });
    }

    if (stale.length > 0) {
        Promise.all(stale.map(row => db.execute(
            'DELETE FROM conversations_by_user WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
            [user.userId, row.last_message_at, row.conversation_id]
        ))).catch(error => console.warn('Không dọn được bản ghi trùng:', error.message));
    }

    // So tin chua doc: lat cat clustering created_at > last_read_at trong MOT partition,
    // gioi han 100 dong (hien "99+"); chi cho hoi thoai dang co tin moi tu nguoi khac.
    await Promise.all(items.filter(item => item.countFrom).map(async item => {
        const rs = await db.execute(
            `SELECT sender_id FROM messages_by_conversation
             WHERE conversation_id = ? AND created_at > ? LIMIT 100`,
            [Uuid.fromString(item.conversationId), item.countFrom]
        );
        item.unreadCount = rs.rows.filter(r => r.sender_id !== user.userId).length;
    }));
    items.forEach(item => delete item.countFrom);

    // Hoi thoai ghim len tren; trong moi nhom giu thu tu Cassandra tra ve.
    return [...items.filter(item => item.pinned), ...items.filter(item => !item.pinned)];
}

async function getDetail(conversationId, user) {
    const { row, members } = await requireMembership(conversationId, user.userId);
    const profiles = await userService.getUsersByIds(members);
    // Moc "da xem" cua tung thanh vien: doc theo khoa chinh day du (user_id, conversation_id).
    const readRows = await Promise.all(members.map(id => db.execute(
        'SELECT last_read_at FROM conversation_state_by_user WHERE user_id = ? AND conversation_id = ?',
        [id, row.conversation_id]
    ).then(rs => [id, rs.first()])));
    const readMap = new Map(readRows.map(([id, r]) => [id, r && r.last_read_at ? iso(r.last_read_at) : null]));
    const memberList = members.map(id => ({
        ...(profiles.get(id) || { userId: id, displayName: id, avatarUrl: null }),
        lastReadAt: readMap.get(id) || null,
        ...realtime.presenceOf(id)
    }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));

    let displayName = row.conversation_name;
    if (row.conversation_type === 'DIRECT') {
        const peer = memberList.find(member => member.userId !== user.userId);
        displayName = peer ? peer.displayName : directDisplayName(row.conversation_name, user.displayName);
    }

    const states = await getStateMap(user.userId);
    const state = states.get(row.conversation_id.toString());

    return {
        conversationId: row.conversation_id.toString(),
        conversationName: row.conversation_name,
        displayName,
        conversationType: row.conversation_type,
        participantIds: members,
        members: memberList,
        createdBy: row.created_by || null,
        ownerKnown: row.conversation_type === 'GROUP' ? Boolean(row.created_by) : null,
        isOwner: row.conversation_type === 'GROUP' && Boolean(row.created_by) && row.created_by === user.userId,
        canManageMembers: row.conversation_type === 'GROUP' && Boolean(row.created_by) && row.created_by === user.userId,
        canRename: row.conversation_type === 'GROUP' && Boolean(row.created_by) && row.created_by === user.userId,
        createdAt: iso(row.created_at),
        lastMessageAt: iso(row.last_message_at),
        pinned: Boolean(state && state.pinned)
    };
}

// ===== Hoi thoai 1-1: khong tao trung =====
// direct_conversations(pair_key) + INSERT ... IF NOT EXISTS: neu hai nguoi bam
// "Nhan tin" cung luc, chi mot ban ghi thang (LWT), ben con lai nhan lai id da co.
const pairKey = (a, b) => [a, b].sort().join('|');

async function openDirect(user, targetUserId) {
    const target = String(targetUserId || '').trim();
    if (!target) throw httpError(400, 'INVALID_MEMBERS', 'Thiếu người dùng cần nhắn tin.');
    if (target === user.userId) throw httpError(400, 'INVALID_MEMBERS', 'Không thể tự nhắn tin cho chính mình.');

    const profiles = await userService.getUsersByIds([target]);
    const peer = profiles.get(target);
    if (!peer) throw httpError(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    await require('./social.service').assertNotBlocked(user.userId, target);

    const key = pairKey(user.userId, target);
    const existing = await db.execute(
        'SELECT conversation_id FROM direct_conversations WHERE pair_key = ?',
        [key]
    );
    if (existing.first()) {
        return { conversationId: existing.first().conversation_id.toString(), created: false };
    }

    const cid = Uuid.fromString(crypto.randomUUID());
    const now = new Date();
    const lwt = await db.execute(
        'INSERT INTO direct_conversations (pair_key, conversation_id, created_at) VALUES (?, ?, ?) IF NOT EXISTS',
        [key, cid, now]
    );
    if (!lwt.wasApplied()) {
        return { conversationId: lwt.first().conversation_id.toString(), created: false };
    }

    const name = `${user.displayName} - ${peer.displayName}`;
    const members = [user.userId, target];
    await db.execute(
        `INSERT INTO conversations (conversation_id, conversation_name, conversation_type, participant_ids,
                                    created_by, created_at, last_message_at)
         VALUES (?, ?, 'DIRECT', ?, ?, ?, ?)`,
        [cid, name, members, user.userId, now, now]
    );
    await touchConversationIndex(
        { conversation_id: cid, conversation_name: name, conversation_type: 'DIRECT', last_message_at: null },
        members,
        { at: now, preview: '', senderName: '', senderId: null }
    );

    realtime.publish(members, 'conversation:updated', { conversationId: cid.toString() });
    return { conversationId: cid.toString(), created: true };
}

// ===== Nhom chat =====
async function assertUsersExist(ids) {
    const profiles = await userService.getUsersByIds(ids);
    const missing = ids.filter(id => !profiles.has(id));
    if (missing.length > 0) {
        throw httpError(404, 'USER_NOT_FOUND', `Không tìm thấy người dùng: ${missing.join(', ')}`);
    }
    return profiles;
}

const namesOf = (ids, profiles) => ids.map(id => profiles.get(id)?.displayName || id).join(', ');

async function createGroup(user, body = {}) {
    const name = validateGroupName(body.name);
    const others = validateUserIdList(body.memberIds).filter(id => id !== user.userId);
    if (others.length < 2) {
        throw httpError(400, 'INVALID_MEMBERS', 'Nhóm cần ít nhất 3 người (bạn và 2 thành viên khác).');
    }
    const profiles = await assertUsersExist(others);

    const cid = Uuid.fromString(crypto.randomUUID());
    const now = new Date();
    const members = [user.userId, ...others];
    await db.execute(
        `INSERT INTO conversations (conversation_id, conversation_name, conversation_type, participant_ids,
                                    created_by, created_at)
         VALUES (?, ?, 'GROUP', ?, ?, ?)`,
        [cid, name, members, user.userId, now]
    );

    const row = await getConversationRow(cid);
    await messages().postSystemMessage(row, members, user,
        `${user.displayName} đã tạo nhóm và thêm ${namesOf(others, profiles)}`);

    return { conversationId: cid.toString(), created: true };
}

async function requireGroup(conversationId, user) {
    const context = await requireMembership(conversationId, user.userId);
    if (context.row.conversation_type !== 'GROUP') {
        throw httpError(400, 'NOT_A_GROUP', 'Thao tác này chỉ áp dụng cho nhóm chat.');
    }
    return context;
}

// Chinh sach quyen nhom (xac dinh ro rang):
//  - Moi thanh vien: doc/gui tin, them thanh vien, tu roi nhom.
//  - Chi truong nhom (created_by): doi ten nhom, xoa thanh vien khac.
//  - Nhom chua xac dinh truong nhom (created_by = null, du lieu cu): khong ai doi ten
//    hay xoa thanh vien; khong tu cap quyen cho bat ky thanh vien nao.
function requireOwner(row, user, action) {
    if (!row.created_by) {
        throw httpError(403, 'GROUP_OWNER_UNKNOWN',
            `Nhóm này chưa xác định trưởng nhóm nên không ai có quyền ${action}. Thành viên vẫn có thể tự rời nhóm.`);
    }
    if (row.created_by !== user.userId) {
        throw httpError(403, 'FORBIDDEN_MANAGE_GROUP', `Chỉ trưởng nhóm mới được ${action}.`);
    }
}

async function renameGroup(conversationId, user, body = {}) {
    const { cid, row, members } = await requireGroup(conversationId, user);
    requireOwner(row, user, 'đổi tên nhóm');
    const name = validateGroupName(body.name);
    if (name === row.conversation_name) return getDetail(conversationId, user);

    await db.execute('UPDATE conversations SET conversation_name = ? WHERE conversation_id = ?', [name, cid]);
    await messages().postSystemMessage({ ...row, conversation_name: name }, members, user,
        `${user.displayName} đã đổi tên nhóm thành “${name}”`);
    return getDetail(conversationId, user);
}

async function addMembers(conversationId, user, body = {}) {
    const { cid, row, members } = await requireGroup(conversationId, user);
    const ids = validateUserIdList(body.memberIds).filter(id => !members.includes(id));
    if (ids.length === 0) {
        throw httpError(400, 'INVALID_MEMBERS', 'Những người này đã ở trong nhóm.');
    }
    if (members.length + ids.length > 100) {
        throw httpError(400, 'INVALID_MEMBERS', 'Nhóm tối đa 100 thành viên.');
    }
    const profiles = await assertUsersExist(ids);

    await db.execute(
        'UPDATE conversations SET participant_ids = participant_ids + ? WHERE conversation_id = ?',
        [ids, cid]
    );
    const all = [...members, ...ids];
    await messages().postSystemMessage({ ...row, participant_ids: all }, all, user,
        `${user.displayName} đã thêm ${namesOf(ids, profiles)} vào nhóm`);
    return getDetail(conversationId, user);
}

// Truong nhom (created_by) duoc xoa thanh vien; moi thanh vien duoc tu roi nhom.
async function removeMember(conversationId, user, memberId) {
    const { cid, row, members } = await requireGroup(conversationId, user);
    const target = String(memberId || '');
    if (!members.includes(target)) {
        throw httpError(404, 'MEMBER_NOT_FOUND', 'Người này không ở trong nhóm.');
    }
    const leaving = target === user.userId;
    if (!leaving) requireOwner(row, user, 'xóa thành viên');

    const remaining = members.filter(id => id !== target);
    if (remaining.length === 0) {
        throw httpError(400, 'LAST_MEMBER', 'Bạn là thành viên cuối cùng, không thể rời nhóm.');
    }

    const queries = [{
        query: 'UPDATE conversations SET participant_ids = participant_ids - ? WHERE conversation_id = ?',
        params: [[target], cid]
    }];
    // Chi chuyen quyen khi nhom DA co truong nhom va chinh truong nhom roi di
    // (nhom co created_by = null giu nguyen null).
    if (leaving && row.created_by && row.created_by === user.userId) {
        queries.push({
            query: 'UPDATE conversations SET created_by = ? WHERE conversation_id = ?',
            params: [[...remaining].sort()[0], cid]
        });
    }
    for (const indexRow of await findIndexRows(target, cid)) {
        queries.push({
            query: 'DELETE FROM conversations_by_user WHERE user_id = ? AND last_message_at = ? AND conversation_id = ?',
            params: [target, indexRow.last_message_at, cid]
        });
    }
    queries.push({
        query: 'DELETE FROM conversation_state_by_user WHERE user_id = ? AND conversation_id = ?',
        params: [target, cid]
    });
    await db.batch(queries);

    const profiles = await userService.getUsersByIds([target]);
    const text = leaving
        ? `${user.displayName} đã rời nhóm`
        : `${user.displayName} đã xóa ${profiles.get(target)?.displayName || target} khỏi nhóm`;
    await messages().postSystemMessage({ ...row, participant_ids: remaining }, remaining, user, text);

    realtime.publish([target], 'conversation:removed', { conversationId: cid.toString() });
    return leaving ? { left: true } : getDetail(conversationId, user);
}

// ===== Trang thai rieng: da doc, ghim =====
async function markReadAt(cid, userId, at) {
    await db.execute(
        'UPDATE conversation_state_by_user SET last_read_at = ? WHERE user_id = ? AND conversation_id = ?',
        [at, userId, cid]
    );
}

// Da xem: ghi moc last_read_at that va bao cho thanh vien (de hien "Da xem").
async function markRead(conversationId, user) {
    const { cid, members } = await requireMembership(conversationId, user.userId);
    const now = new Date();
    await markReadAt(cid, user.userId, now);
    realtime.publish(members, 'read', { conversationId: cid.toString(), userId: user.userId, lastReadAt: now.toISOString() });
    await require('./notification.service').markConversationRead(user.userId, cid.toString()).catch(() => {});
    return { conversationId: cid.toString(), lastReadAt: now.toISOString() };
}

// Dang nhap (typing): chi phat cho thanh vien khac; gioi han 1 su kien / 2 giay / nguoi / hoi thoai.
const typingSeen = new Map();
async function typing(conversationId, user) {
    const key = `${user.userId}|${conversationId}`;
    const last = typingSeen.get(key) || 0;
    if (Date.now() - last < 2000) return { sent: false };
    typingSeen.set(key, Date.now());
    if (typingSeen.size > 5000) typingSeen.clear();
    const { cid, members } = await requireMembership(conversationId, user.userId);
    realtime.publish(members.filter(id => id !== user.userId), 'typing', {
        conversationId: cid.toString(), userId: user.userId, displayName: user.displayName
    });
    return { sent: true };
}

// Nhung nguoi chung it nhat mot hoi thoai -> duoc nhan su kien online/offline (cache 60s).
const peersCache = new Map();
async function peersOf(userId) {
    const cached = peersCache.get(userId);
    if (cached && cached.until > Date.now()) return cached.peers;
    const rows = (await db.execute(
        'SELECT conversation_id FROM conversations_by_user WHERE user_id = ?', [userId]
    )).rows;
    const ids = [...new Set(rows.map(r => r.conversation_id.toString()))];
    const convs = await Promise.all(ids.map(id => db.execute(
        'SELECT participant_ids FROM conversations WHERE conversation_id = ?', [Uuid.fromString(id)]
    ).then(rs => rs.first())));
    const peers = [...new Set(convs.filter(Boolean).flatMap(membersOf))].filter(id => id !== userId);
    peersCache.set(userId, { peers, until: Date.now() + 60000 });
    return peers;
}

realtime.onPresenceChange((userId, online) => {
    peersOf(userId)
        .then(peers => realtime.publish(peers, 'presence', { userId, ...realtime.presenceOf(userId), online }))
        .catch(() => {});
});

async function setPinned(conversationId, user, pinned) {
    if (typeof pinned !== 'boolean') {
        throw httpError(400, 'INVALID_PINNED', 'pinned phải là true hoặc false.');
    }
    const { cid } = await requireMembership(conversationId, user.userId);
    await db.execute(
        'UPDATE conversation_state_by_user SET pinned = ? WHERE user_id = ? AND conversation_id = ?',
        [pinned, user.userId, cid]
    );
    return { conversationId: cid.toString(), pinned };
}

module.exports = {
    membersOf,
    getConversationRow,
    requireMembership,
    touchConversationIndex,
    findIndexRows,
    listForUser,
    getDetail,
    openDirect,
    createGroup,
    renameGroup,
    addMembers,
    removeMember,
    markRead,
    markReadAt,
    typing,
    peersOf,
    setPinned,
    directDisplayName,
    pairKey
};
