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
const BACKGROUNDS = ['teal', 'harbor', 'sunset', 'violet', 'forest', 'rose'];
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

// ===== PT-23: story 24 gio (ban be + ban than) =====
function storyDto(row, authorId, viewerId) {
    return {
        storyId: row.story_id.toString(),
        authorId,
        content: row.content || '',
        background: row.background || 'teal',
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

async function createStory(user, { content, background, buffer }) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text.length > STORY_MAX) throw httpError(400, 'INVALID_STORY', `Story tối đa ${STORY_MAX} ký tự.`);
    let mediaKey = null;
    let mime = null;
    if (buffer && buffer.length) {
        mime = storage.checkImage(buffer, 8 * 1024 * 1024);
        mediaKey = await storage.save('stories', buffer);
    }
    if (!text && !mediaKey) throw httpError(400, 'INVALID_STORY', 'Story cần có chữ hoặc ảnh.');
    const bg = BACKGROUNDS.includes(background) ? background : 'teal';
    const storyId = TimeUuid.now();
    await db.execute(
        `INSERT INTO stories_by_author (author_id, story_id, content, background, media_key, media_mime, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) USING TTL ?`,
        [user.userId, storyId, text || null, bg, mediaKey, mime, storyId.getDate(), STORY_TTL]);
    const friends = (await social.listFriends(user)).map(f => f.userId);
    realtime.publish([user.userId, ...friends], 'story:changed', { authorId: user.userId });
    return storyDto({ story_id: storyId, content: text, background: bg, media_key: mediaKey, created_at: storyId.getDate() }, user.userId, user.userId);
}

async function canSeeStories(viewer, authorId) {
    if (viewer.userId === authorId) return true;
    return (await social.relationshipStatus(viewer.userId, authorId)) === 'FRIENDS';
}

async function storyFeed(user) {
    const friends = (await social.listFriends(user)).slice(0, 300);
    const authors = [{ userId: user.userId, displayName: user.displayName }, ...friends];
    const groups = [];
    await Promise.all(authors.map(async a => {
        const rows = await activeStories(a.userId);
        if (rows.length === 0) return;
        const items = rows.map(r => storyDto(r, a.userId, user.userId)).reverse(); // cu -> moi de xem lan luot
        const viewed = await Promise.all(items.map(s => db.execute('SELECT viewer_id FROM story_views WHERE story_id = ? AND viewer_id = ?',
            [TimeUuid.fromString(s.storyId), user.userId]).then(r => Boolean(r.first()))));
        items.forEach((s, i) => { s.viewed = viewed[i]; });
        groups.push({ author: { userId: a.userId, displayName: a.displayName }, items, allViewed: viewed.every(Boolean), latestAt: items[items.length - 1].createdAt });
    }));
    groups.sort((a, b) => (a.author.userId === user.userId ? -1 : b.author.userId === user.userId ? 1
        : Number(a.allViewed) - Number(b.allViewed) || b.latestAt.localeCompare(a.latestAt)));
    return { groups };
}

async function requireStory(viewer, authorId, storyId) {
    const sid = posts.parseId(storyId, 'storyId');
    if (!(await canSeeStories(viewer, authorId))) throw httpError(404, 'STORY_NOT_FOUND', 'Không tìm thấy story.');
    const row = (await db.execute('SELECT story_id, content, background, media_key, media_mime, created_at FROM stories_by_author WHERE author_id = ? AND story_id = ?',
        [authorId, sid])).first();
    if (!row) throw httpError(404, 'STORY_NOT_FOUND', 'Story đã hết hạn hoặc bị xóa.');
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
    const rs = await db.execute('SELECT viewer_id, viewed_at FROM story_views WHERE story_id = ?', [sid]);
    const profiles = await userService.getUsersByIds(rs.rows.map(r => r.viewer_id));
    return { items: rs.rows.map(r => ({ userId: r.viewer_id, displayName: profiles.get(r.viewer_id)?.displayName || r.viewer_id, viewedAt: iso(r.viewed_at) })) };
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
    if (!row.media_key) throw httpError(404, 'FILE_GONE', 'Story không có ảnh.');
    return { key: row.media_key, mime: row.media_mime };
}

module.exports = {
    savePost, unsavePost, listSaved, hashtagsOf, indexPostHashtags, postsByHashtag, decoratePosts, decoratePostList,
    createStory, storyFeed, viewStory, storyViewers, deleteStory, openStoryMedia, BACKGROUNDS
};
