// Tha cam xuc cho binh luan bai viet (migration 016, bang comment_reactions).
// Quyen: ai XEM duoc bai viet thi xem / tha cam xuc cho binh luan cua bai do (dung lai requireVisiblePost cu).
// Moi nguoi 1 cam xuc / binh luan: tha lai = doi cam xuc; bo = xoa dong cua minh.
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid } = require('../utils/types');
const userService = require('../services/user.service');

const REACTIONS = ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'];
const posts = () => require('../services/post.service');
const notifications = () => require('../services/notification.service');

function parseId(value, name) {
    try { return TimeUuid.fromString(String(value)); } catch { throw httpError(400, 'INVALID_ID', `${name} không hợp lệ.`); }
}

// Bai viet xem duoc + binh luan con ton tai (chua xoa).
async function requireComment(viewer, postId, commentId) {
    const pid = parseId(postId, 'postId');
    const cid = parseId(commentId, 'commentId');
    await posts().requireVisiblePost(viewer, pid);
    const row = (await db.execute('SELECT author_id, is_deleted FROM post_comments WHERE post_id = ? AND comment_id = ?', [pid, cid])).first();
    if (!row || row.is_deleted) throw httpError(404, 'COMMENT_NOT_FOUND', 'Không tìm thấy bình luận.');
    return { pid, cid, row };
}

async function summaryOf(pid, cid, viewerId) {
    const rows = (await db.execute('SELECT user_id, reaction FROM comment_reactions WHERE post_id = ? AND comment_id = ?', [pid, cid])).rows;
    const counts = {};
    let mine = null;
    for (const r of rows) {
        counts[r.reaction] = (counts[r.reaction] || 0) + 1;
        if (r.user_id === viewerId) mine = r.reaction;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3);
    return { total: rows.length, counts, top, mine };
}

async function react(user, postId, commentId, body = {}) {
    const reaction = String(body.reaction || '').toUpperCase();
    if (!REACTIONS.includes(reaction)) throw httpError(400, 'INVALID_REACTION', 'Cảm xúc không hợp lệ.');
    const { pid, cid, row } = await requireComment(user, postId, commentId);
    const before = (await db.execute('SELECT reaction FROM comment_reactions WHERE post_id = ? AND comment_id = ? AND user_id = ?', [pid, cid, user.userId])).first();
    await db.execute('INSERT INTO comment_reactions (post_id, comment_id, user_id, reaction, reacted_at) VALUES (?, ?, ?, ?, ?)',
        [pid, cid, user.userId, reaction, new Date()]);
    // Thong bao cho nguoi viet binh luan (1 lan / nguoi / binh luan, doi cam xuc khong bao lai).
    if (!before && row.author_id !== user.userId) {
        await notifications().notifySafe({
            recipientId: row.author_id, actorId: user.userId, type: 'COMMENT_REACTION',
            dedupeKey: `COMMENT_REACTION:${cid}:${user.userId}`, postId: pid, commentId: cid, preview: reaction
        });
    }
    return { commentId: cid.toString(), reactions: await summaryOf(pid, cid, user.userId) };
}

async function unreact(user, postId, commentId) {
    const { pid, cid } = await requireComment(user, postId, commentId);
    await db.execute('DELETE FROM comment_reactions WHERE post_id = ? AND comment_id = ? AND user_id = ?', [pid, cid, user.userId]);
    return { commentId: cid.toString(), reactions: await summaryOf(pid, cid, user.userId) };
}

// Danh sach nguoi da tha cam xuc (toi da 200), loc theo loai neu co.
async function listReactors(user, postId, commentId, query = {}) {
    const { pid, cid } = await requireComment(user, postId, commentId);
    const type = query.type ? String(query.type).toUpperCase() : null;
    const rows = (await db.execute('SELECT user_id, reaction, reacted_at FROM comment_reactions WHERE post_id = ? AND comment_id = ? LIMIT 200', [pid, cid])).rows
        .filter(r => !type || r.reaction === type);
    const profiles = await userService.getUsersByIds(rows.map(r => r.user_id));
    return {
        items: rows.sort((a, b) => new Date(b.reacted_at) - new Date(a.reacted_at))
            .map(r => ({ userId: r.user_id, displayName: profiles.get(r.user_id)?.displayName || r.user_id, reaction: r.reaction })),
        summary: await summaryOf(pid, cid, user.userId)
    };
}

// GET /posts/:id/comments va /replies: gan "reactions" cho tung binh luan (route cu giu nguyen).
async function decorateComments(body, req) {
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return body;
    let pid;
    try { pid = TimeUuid.fromString(String(req.params.postId)); } catch { return body; }
    await Promise.all(items.map(async c => {
        if (!c || c.deleted || !c.commentId) return;
        try { c.reactions = await summaryOf(pid, TimeUuid.fromString(c.commentId), req.user.userId); } catch { /* bo qua */ }
    }));
    return body;
}

module.exports = { react, unreact, listReactors, decorateComments, summaryOf, REACTIONS };
