// Mang xa hoi mo rong: PT-22 luu bai, PT-23 story 24 gio, PT-24 hashtag.
// Quyen xem bai luon qua posts.getPost / requireVisiblePost co san (khong tu kiem tra lai).
const db = require('../db');
const { httpError } = require('../utils/httpError');
const { TimeUuid, iso } = require('../utils/types');
const { fold } = require('../utils/text');
const posts = require('../services/post.service');
const social = require('../services/social.service');
const userService = require('../services/user.service');
const realtime = require('../services/realtime.service');
const storage = require('./lib/storage');

const STORY_TTL = 24 * 3600;
const STORY_MAX = 500;
const BACKGROUNDS = ['teal', 'harbor', 'sunset', 'violet', 'forest', 'rose', 'ocean', 'fire', 'night', 'mint', 'gold', 'berry', 'sky', 'black'];
const FONTS = ['clean', 'simple', 'casual', 'headline'];
const ALIGNS = ['left', 'center', 'right'];
const STORY_REACTIONS = ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'];
const PAGE = 20;

// ===== PT-22: luu bai =====
async function savePost(user, postId) {
    const pid = posts.parseId(postId);
    await posts.requireVisiblePost(user, pid);
    const existing = (await db.execute('SELECT saved_at FROM saved_post_keys WHERE user_id = ? AND post_id = ?', [user.userId, pid])).first();
    if (existing) return { postId: pid.toString(), saved: true };
    const now = new Date();
    await db.batch([
        { query: 'INSERT INTO saved_post_keys (user_id, post_id, saved_at) VALUES (?, ?, ?)', params: [user.userId, pid, now] },
        { query: 'INSERT INTO saved_posts_by_user (user_id, saved_at, post_id) VALUES (?, ?, ?)', params: [user.userId, now, pid] }
    ]);
    return { postId: pid.toString(), saved: true };
}

async function unsavePost(user, postId) {
    const pid = posts.parseId(postId);
    const existing = (await db.execute('SELECT saved_at FROM saved_post_keys WHERE user_id = ? AND post_id = ?', [user.userId, pid])).first();
    if (existing) {
        await db.batch([
            { query: 'DELETE FROM saved_post_keys WHERE user_id = ? AND post_id = ?', params: [user.userId, pid] },
            { query: 'DELETE FROM saved_posts_by_user WHERE user_id = ? AND saved_at = ? AND post_id = ?', params: [user.userId, existing.saved_at, pid] }
        ]);
    }
    return { postId: pid.toString(), saved: false };
}

async function listSaved(user, cursor) {
    const before = cursor ? new Date(cursor) : null;
    if (before && Number.isNaN(before.getTime())) throw httpError(400, 'INVALID_CURSOR', 'cursor không hợp lệ.');
    const rs = before
        ? await db.execute(`SELECT saved_at, post_id FROM saved_posts_by_user WHERE user_id = ? AND saved_at < ? LIMIT ${PAGE}`, [user.userId, before])
        : await db.execute(`SELECT saved_at, post_id FROM saved_posts_by_user WHERE user_id = ? LIMIT ${PAGE}`, [user.userId]);
    const items = [];
    for (const r of rs.rows) {
        try {
            items.push({ ...(await posts.getPost(user, r.post_id.toString())), saved: true, savedAt: iso(r.saved_at) });
        } catch {
            items.push({ postId: r.post_id.toString(), unavailable: true, saved: true, savedAt: iso(r.saved_at) });
        }
    }
    const last = rs.rows[rs.rows.length - 1];
    const nextCursor = rs.rows.length === PAGE && last ? iso(last.saved_at) : null;
    return { items, nextCursor, hasMore: Boolean(nextCursor) };
}

// ===== PT-24: hashtag =====
// Khoa hashtag: bo dau, chu thuong, chi [a-z0-9_]; 2-50 ky tu; toi da 10 / bai.
function hashtagsOf(text) {
    const out = new Set();
    const re = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{2,50})/gu;
    let m;
    while ((m = re.exec(String(text || ''))) && out.size < 10) {
        const key = fold(m[2]).replace(/[^a-z0-9_]/g, '');
        if (key.length >= 2 && !/^\d+$/.test(key)) out.add(key);
    }
    return [...out];
}

async function indexPostHashtags(post) {
    if (!post || !post.postId) return;
    const pid = TimeUuid.fromString(post.postId);
    const current = (await db.execute('SELECT hashtag FROM hashtags_by_post WHERE post_id = ?', [pid])).rows.map(r => r.hashtag);
    const next = post.deleted ? [] : hashtagsOf(post.content);
    const authorId = post.author ? post.author.userId : null;
    for (const tag of current.filter(t => !next.includes(t))) {
        await db.execute('DELETE FROM posts_by_hashtag WHERE hashtag = ? AND post_id = ?', [tag, pid]);
        await db.execute('DELETE FROM hashtags_by_post WHERE post_id = ? AND hashtag = ?', [pid, tag]);
    }
    for (const tag of next.filter(t => !current.includes(t))) {
        await db.execute('INSERT INTO posts_by_hashtag (hashtag, post_id, author_id) VALUES (?, ?, ?)', [tag, pid, authorId]);
        await db.execute('INSERT INTO hashtags_by_post (post_id, hashtag) VALUES (?, ?)', [pid, tag]);
    }
}

async function postsByHashtag(user, rawTag, cursor) {
    const tag = fold(String(rawTag || '').replace(/^#/, '')).replace(/[^a-z0-9_]/g, '');
    if (tag.length < 2 || tag.length > 50) throw httpError(400, 'INVALID_HASHTAG', 'Hashtag cần từ 2 đến 50 ký tự chữ hoặc số.');
    const items = [];
    let cur = cursor ? posts.parseId(cursor, 'cursor') : null;
    let exhausted = false;
    for (let round = 0; round < 5 && items.length < PAGE && !exhausted; round++) {
        const rs = cur
            ? await db.execute(`SELECT post_id FROM posts_by_hashtag WHERE hashtag = ? AND post_id < ? LIMIT ${PAGE}`, [tag, cur])
            : await db.execute(`SELECT post_id FROM posts_by_hashtag WHERE hashtag = ? LIMIT ${PAGE}`, [tag]);
        exhausted = rs.rows.length < PAGE;
        for (const r of rs.rows) {
            cur = r.post_id;
            if (items.length >= PAGE) break;
            try { items.push(await posts.getPost(user, r.post_id.toString())); } catch { /* khong xem duoc: bo qua */ }
        }
        if (rs.rows.length === 0) break;
    }
    const nextCursor = !exhausted && cur ? cur.toString() : null;
    return { hashtag: tag, items: await decoratePostList(user, items), nextCursor, hasMore: Boolean(nextCursor) };
}

// Gan saved + hashtags cho bai viet trong phan hoi cu (bang tin, dong thoi gian, 1 bai).
async function decoratePostList(user, items) {
    const list = items.filter(p => p && p.postId && !p.unavailable);
    if (list.length === 0) return items;
    const ids = list.map(p => TimeUuid.fromString(p.postId));
    const marks = ids.map(() => '?').join(', ');
    const saved = new Set((await db.execute(`SELECT post_id FROM saved_post_keys WHERE user_id = ? AND post_id IN (${marks})`,
        [user.userId, ...ids])).rows.map(r => r.post_id.toString()));
    for (const p of list) {
        p.saved = saved.has(p.postId);
        p.hashtags = hashtagsOf(p.content);
        if (p.shared && p.shared.post) p.shared.post.hashtags = hashtagsOf(p.shared.post.content);
    }
    return items;
}

async function decoratePosts(body, req) {
    if (Array.isArray(body.items)) await decoratePostList(req.user, body.items);
    else if (body.postId) await decoratePostList(req.user, [body]);
    return body;
}

// ===== PT-23: tin (story) 24 gio cho ban be + ban than =====
// Mo rong: kieu chu (story_styles), cam xuc (story_reactions), tra loi bang tin nhan, chia se tin.
const notifications = () => require('../services/notification.service');
const excerptOf = (t, n = 60) => {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
};

async function readStyle(storyId) {
    return (await db.execute('SELECT font, text_color, text_align, shared_from_id, shared_from_name FROM story_styles WHERE story_id = ?', [storyId])).first();
}

function storyDto(row, authorId, viewerId, style = null) {
    return {
        storyId: row.story_id.toString(),
        authorId,
        content: row.content || '',
        background: row.background || 'teal',
        font: (style && style.font) || 'clean',
        textColor: (style && style.text_color) || '#ffffff',
        textAlign: (style && style.text_align) || 'center',
        sharedFrom: style && style.shared_from_id ? { userId: style.shared_from_id, displayName: style.shared_from_name || '' } : null,
        mediaUrl: row.media_key ? `/api/v1/stories/${encodeURIComponent(authorId)}/${row.story_id}/media` : null,
        createdAt: iso(row.created_at),
        expiresAt: new Date(new Date(row.created_at).getTime() + STORY_TTL * 1000).toISOString(),
        mine: authorId === viewerId
    };
}

async function activeStories(authorId) {
    const rs = await db.execute('SELECT story_id, content, background, media_key, media_mime, created_at FROM stories_by_author WHERE author_id = ? LIMIT 30', [authorId]);
    const cutoff = Date.now() - STORY_TTL * 1000;
    return rs.rows.filter(r => new Date(r.created_at).getTime() > cutoff); // TTL Cassandra la chinh, loc them cho chac
}

function validateStyle(body = {}) {
    const textColor = /^#[0-9a-f]{6}$/i.test(String(body.textColor || '')) ? String(body.textColor).toLowerCase() : '#ffffff';
    return {
        background: BACKGROUNDS.includes(body.background) ? body.background : 'teal',
        font: FONTS.includes(body.font) ? body.font : 'clean',
        textColor,
        textAlign: ALIGNS.includes(body.textAlign) ? body.textAlign : 'center'
    };
}

// Thong bao cho ban be (toi da 300 nguoi). dedupeKey rieng tung nguoi nhan.
async function notifyFriends(user, ev) {
    const friends = (await social.listFriends(user)).slice(0, 300);
    for (const f of friends) {
        await notifications().notifySafe({ recipientId: f.userId, actorId: user.userId, ...ev, dedupeKey: `${ev.dedupeKey}:${f.userId}` });
    }
    return friends.length;
}

async function createStory(user, { content, buffer, sharedFrom = null, mediaCopy = null, ...rest }) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text.length > STORY_MAX) throw httpError(400, 'INVALID_STORY', `Tin tối đa ${STORY_MAX} ký tự.`);
    const style = validateStyle(rest);
    let mediaKey = null;
    let mime = null;
    if (buffer && buffer.length) {
        mime = storage.checkImage(buffer, 8 * 1024 * 1024);
        mediaKey = await storage.save('stories', buffer);
    } else if (mediaCopy) {
        mediaKey = mediaCopy.key;
        mime = mediaCopy.mime;
    }
    if (!text && !mediaKey) throw httpError(400, 'INVALID_STORY', 'Tin cần có chữ hoặc ảnh.');
    const storyId = TimeUuid.now();
    await db.execute(
        `INSERT INTO stories_by_author (author_id, story_id, content, background, media_key, media_mime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) USING TTL ?`,
        [user.userId, storyId, text || null, style.background, mediaKey, mime, storyId.getDate(), STORY_TTL]);
    await db.execute(
        'INSERT INTO story_styles (story_id, font, text_color, text_align, shared_from_id, shared_from_name) VALUES (?, ?, ?, ?, ?, ?) USING TTL ?',
        [storyId, style.font, style.textColor, style.textAlign, sharedFrom ? sharedFrom.userId : null, sharedFrom ? sharedFrom.displayName : null, STORY_TTL + 3600]);
    const friends = (await social.listFriends(user)).map(f => f.userId);
    realtime.publish([user.userId, ...friends], 'story:changed', { authorId: user.userId });
    // Moi tac gia toi da 1 thong bao "dang tin" / ngay / nguoi nhan.
    const day = new Date().toISOString().slice(0, 10);
    await notifyFriends(user, {
        type: 'FRIEND_STORY', dedupeKey: `FRIEND_STORY:${user.userId}:${day}`,
        preview: text ? excerptOf(text) : 'đã thêm một tin mới'
    }).catch(error => console.warn('[ext] Không gửi được thông báo tin mới:', error.message));
    const styleRow = { font: style.font, text_color: style.textColor, text_align: style.textAlign,
        shared_from_id: sharedFrom && sharedFrom.userId, shared_from_name: sharedFrom && sharedFrom.displayName };
    return storyDto({ story_id: storyId, content: text, background: style.background, media_key: mediaKey, created_at: storyId.getDate() },
        user.userId, user.userId, styleRow);
}

async function canSeeStories(viewer, authorId) {
    if (viewer.userId === authorId) return true;
    return (await social.relationshipStatus(viewer.userId, authorId)) === 'FRIENDS';
}

async function reactionsOf(sid) {
    return (await db.execute('SELECT user_id, reaction, reacted_at FROM story_reactions WHERE story_id = ?', [sid], { fetchSize: 1000 })).rows;
}

async function storyFeed(user) {
    const friends = (await social.listFriends(user)).slice(0, 300);
    const authors = [{ userId: user.userId, displayName: user.displayName }, ...friends];
    const groups = [];
    await Promise.all(authors.map(async a => {
        const rows = await activeStories(a.userId);
        if (rows.length === 0) return;
        const items = [];
        for (const r of [...rows].reverse()) { // cu -> moi de xem lan luot
            const sid = r.story_id;
            const [style, viewed, reactions, views] = await Promise.all([
                readStyle(sid),
                db.execute('SELECT viewer_id FROM story_views WHERE story_id = ? AND viewer_id = ?', [sid, user.userId]).then(x => Boolean(x.first())),
                reactionsOf(sid),
                a.userId === user.userId ? db.execute('SELECT viewer_id FROM story_views WHERE story_id = ?', [sid], { fetchSize: 1000 }).then(x => x.rows.length) : null
            ]);
            const dto = storyDto(r, a.userId, user.userId, style);
            dto.viewed = viewed;
            dto.myReaction = reactions.find(x => x.user_id === user.userId)?.reaction || null;
            if (dto.mine) {
                dto.viewCount = views;
                dto.reactionCounts = reactions.reduce((m, x) => ({ ...m, [x.reaction]: (m[x.reaction] || 0) + 1 }), {});
            }
            items.push(dto);
        }
        groups.push({ author: { userId: a.userId, displayName: a.displayName }, items, allViewed: items.every(s => s.viewed || s.mine), latestAt: items[items.length - 1].createdAt });
    }));
    groups.sort((a, b) => (a.author.userId === user.userId ? -1 : b.author.userId === user.userId ? 1
        : Number(a.allViewed) - Number(b.allViewed) || b.latestAt.localeCompare(a.latestAt)));
    return { groups };
}

async function requireStory(viewer, authorId, storyId) {
    const sid = posts.parseId(storyId, 'storyId');
    if (!(await canSeeStories(viewer, authorId))) throw httpError(404, 'STORY_NOT_FOUND', 'Không tìm thấy tin.');
    const row = (await db.execute('SELECT story_id, content, background, media_key, media_mime, created_at FROM stories_by_author WHERE author_id = ? AND story_id = ?',
        [authorId, sid])).first();
    if (!row) throw httpError(404, 'STORY_NOT_FOUND', 'Tin đã hết hạn hoặc bị xóa.');
    return { sid, row };
}

async function viewStory(user, authorId, storyId) {
    const { sid } = await requireStory(user, authorId, storyId);
    if (authorId !== user.userId) {
        await db.execute('INSERT INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?) USING TTL ?', [sid, user.userId, new Date(), STORY_TTL + 3600]);
    }
    return { viewed: true };
}

async function storyViewers(user, storyId) {
    const { sid } = await requireStory(user, user.userId, storyId);
    const [views, reactions] = await Promise.all([
        db.execute('SELECT viewer_id, viewed_at FROM story_views WHERE story_id = ?', [sid], { fetchSize: 1000 }),
        reactionsOf(sid)
    ]);
    const ids = [...new Set([...views.rows.map(r => r.viewer_id), ...reactions.map(r => r.user_id)])];
    const profiles = await userService.getUsersByIds(ids);
    const byUser = new Map(reactions.map(r => [r.user_id, r.reaction]));
    const viewedAt = new Map(views.rows.map(r => [r.viewer_id, iso(r.viewed_at)]));
    return {
        items: ids.map(id => ({ userId: id, displayName: profiles.get(id)?.displayName || id, viewedAt: viewedAt.get(id) || null, reaction: byUser.get(id) || null }))
            .sort((a, b) => String(b.viewedAt).localeCompare(String(a.viewedAt)))
    };
}

// Cam xuc ve tin cua nguoi khac (moi nguoi 1 cam xuc; gui null de go).
async function reactStory(user, authorId, storyId, body = {}) {
    const { sid } = await requireStory(user, authorId, storyId);
    if (authorId === user.userId) throw httpError(400, 'OWN_STORY', 'Không thể bày tỏ cảm xúc với tin của chính mình.');
    const reaction = body.reaction === null ? null : String(body.reaction || '').toUpperCase();
    if (reaction === null) {
        await db.execute('DELETE FROM story_reactions WHERE story_id = ? AND user_id = ?', [sid, user.userId]);
        return { reaction: null };
    }
    if (!STORY_REACTIONS.includes(reaction)) throw httpError(400, 'INVALID_REACTION', 'Cảm xúc không hợp lệ.');
    await db.execute('INSERT INTO story_reactions (story_id, user_id, reaction, reacted_at) VALUES (?, ?, ?, ?) USING TTL ?',
        [sid, user.userId, reaction, new Date(), STORY_TTL + 3600]);
    await notifications().notifySafe({
        recipientId: authorId, actorId: user.userId, type: 'STORY_REACTION', dedupeKey: `STORY_REACTION:${sid}:${user.userId}`,
        preview: reaction
    });
    realtime.publish([authorId], 'story:changed', { authorId, storyId: sid.toString(), kind: 'reaction' });
    return { reaction };
}

// Tra loi tin = gui tin nhan 1-1 cho tac gia (dung service chat co san).
async function replyStory(user, authorId, storyId, body = {}) {
    const { row } = await requireStory(user, authorId, storyId);
    if (authorId === user.userId) throw httpError(400, 'OWN_STORY', 'Không thể trả lời tin của chính mình.');
    const text = typeof body.content === 'string' ? body.content.trim() : '';
    if (!text || text.length > 1000) throw httpError(400, 'INVALID_CONTENT', 'Nội dung trả lời từ 1 đến 1000 ký tự.');
    const conversations = require('../services/conversation.service');
    const messages = require('../services/message.service');
    const { conversationId } = await conversations.openDirect(user, authorId);
    const quote = row.content ? `“${excerptOf(row.content)}”` : '(tin ảnh)';
    const msg = await messages.sendMessage(conversationId, user, { content: `↩️ Trả lời tin ${quote}: ${text}` });
    return { conversationId, messageId: msg.messageId };
}

// Chia se tin: target = 'story' (dang lai len tin cua minh) | 'chat' (gui vao 1 hoi thoai).
async function shareStory(user, authorId, storyId, body = {}) {
    const { sid, row } = await requireStory(user, authorId, storyId);
    const style = await readStyle(sid);
    const author = (await userService.getUsersByIds([authorId])).get(authorId);
    const authorName = author ? author.displayName : authorId;
    if (body.target === 'chat') {
        const messages = require('../services/message.service');
        const note = typeof body.content === 'string' ? body.content.trim().slice(0, 500) : '';
        const content = `📖 Tin của ${authorName}: ${row.content ? `“${excerptOf(row.content, 200)}”` : '(tin ảnh)'}${note ? `\n${note}` : ''}`;
        const msg = await messages.sendMessage(String(body.conversationId || ''), user, { content });
        return { shared: 'chat', conversationId: String(body.conversationId), messageId: msg.messageId };
    }
    if (authorId === user.userId) throw httpError(400, 'OWN_STORY', 'Đây đã là tin của bạn.');
    let mediaCopy = null;
    if (row.media_key) {
        // Sao chep tep anh: tin goc bi xoa / het han khong lam mat anh cua ban chia se.
        const buf = await require('fs').promises.readFile(storage.fullPath('stories', row.media_key)).catch(() => null);
        if (buf) mediaCopy = { key: await storage.save('stories', buf), mime: row.media_mime };
    }
    const created = await createStory(user, {
        content: row.content || '', background: row.background, font: style?.font, textColor: style?.text_color,
        textAlign: style?.text_align, mediaCopy, sharedFrom: { userId: authorId, displayName: authorName }
    });
    return { shared: 'story', story: created };
}

async function deleteStory(user, storyId) {
    const { sid, row } = await requireStory(user, user.userId, storyId);
    await db.execute('DELETE FROM stories_by_author WHERE author_id = ? AND story_id = ?', [user.userId, sid]);
    if (row.media_key) await storage.remove('stories', row.media_key);
    const friends = (await social.listFriends(user)).map(f => f.userId);
    realtime.publish([user.userId, ...friends], 'story:changed', { authorId: user.userId });
    return { deleted: true };
}

async function openStoryMedia(user, authorId, storyId) {
    const { row } = await requireStory(user, authorId, storyId);
    if (!row.media_key) throw httpError(404, 'FILE_GONE', 'Tin không có ảnh.');
    return { key: row.media_key, mime: row.media_mime };
}

// Thong bao ban be khi dang bai moi (bai Cong khai / Ban be; khong thong bao bai chia se, bai Rieng tu).
async function notifyFriendsOfPost(post, user) {
    if (!post || !post.postId || post.privacy === 'PRIVATE' || post.shared) return 0;
    return notifyFriends(user, {
        type: 'FRIEND_POST', dedupeKey: `FRIEND_POST:${post.postId}`, postId: TimeUuid.fromString(post.postId),
        preview: post.content ? excerptOf(post.content, 100) : 'đã đăng ảnh mới'
    });
}

module.exports = {
    savePost, unsavePost, listSaved, hashtagsOf, indexPostHashtags, postsByHashtag, decoratePosts, decoratePostList,
    createStory, storyFeed, viewStory, storyViewers, deleteStory, openStoryMedia, reactStory, replyStory, shareStory,
    notifyFriendsOfPost, BACKGROUNDS, FONTS, STORY_REACTIONS
};
