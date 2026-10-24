// Bai dang, anh, cam xuc, binh luan, chia se. Moi route sau requireAuth; quyen xem kiem tra trong post.service.
const express = require('express');
const fs = require('fs');
const posts = require('../services/post.service');
const { rateLimit } = require('../middleware/security');

const router = express.Router();
const perUser = (windowMs, max, message) => rateLimit({ windowMs, max, key: req => req.user.userId, message });
const postLimiter = perUser(60 * 1000, Number(process.env.POST_RATE_LIMIT || 20), 'Bạn đăng bài quá nhanh, hãy chờ một chút.');
const commentLimiter = perUser(60 * 1000, Number(process.env.COMMENT_RATE_LIMIT || 60), 'Bạn bình luận quá nhanh.');
const reactLimiter = perUser(60 * 1000, Number(process.env.REACTION_RATE_LIMIT || 120), 'Bạn thả cảm xúc quá nhanh.');
const uploadLimiter = perUser(10 * 60 * 1000, Number(process.env.UPLOAD_RATE_LIMIT || 60), 'Bạn tải lên quá nhiều ảnh, hãy thử lại sau.');
const rawUpload = express.raw({ type: () => true, limit: posts.MAX_IMAGE_BYTES || (20 * 1024 * 1024 + 1024) });

function sendImage(res, { full, mimeType, fileName, size }) {
    res.set({
        'Content-Type': mimeType,
        'Content-Length': String(size),
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
        'Cache-Control': 'private, max-age=300'
    });
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
}

// ----- Anh -----
router.post('/posts/media', uploadLimiter, rawUpload, async (req, res) => {
    let fileName = '';
    try { fileName = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { fileName = ''; }
    res.status(201).json(await posts.uploadMedia(req.user, { buffer: Buffer.isBuffer(req.body) ? req.body : null, fileName }));
});
router.delete('/posts/media/:mediaId', async (req, res) => res.json(await posts.cancelMedia(req.user, req.params.mediaId)));
router.get('/posts/media/:mediaId/preview', async (req, res) => sendImage(res, await posts.openPendingMedia(req.user, req.params.mediaId)));
router.get('/posts/:postId/media/:mediaId', async (req, res) =>
    sendImage(res, await posts.openMedia(req.user, req.params.postId, req.params.mediaId)));

// ----- Bang tin / dong thoi gian -----
router.get('/feed', async (req, res) => res.json(await posts.feed(req.user, req.query.cursor)));
router.get('/users/:userId/posts', async (req, res) => res.json(await posts.timeline(req.user, req.params.userId, req.query.cursor)));

// ----- Bai viet -----
router.post('/posts', postLimiter, async (req, res) => res.status(201).json(await posts.createPost(req.user, req.body || {})));
router.get('/posts/:postId', async (req, res) => res.json(await posts.getPost(req.user, req.params.postId)));
router.patch('/posts/:postId', async (req, res) => res.json(await posts.updatePost(req.user, req.params.postId, req.body || {})));
router.delete('/posts/:postId', async (req, res) => res.json(await posts.deletePost(req.user, req.params.postId)));
router.post('/posts/:postId/share', postLimiter, async (req, res) =>
    res.status(201).json(await posts.sharePost(req.user, req.params.postId, req.body || {})));

// ----- Cam xuc -----
router.put('/posts/:postId/reaction', reactLimiter, async (req, res) =>
    res.json(await posts.react(req.user, req.params.postId, req.body?.reaction)));
router.delete('/posts/:postId/reaction', reactLimiter, async (req, res) => res.json(await posts.unreact(req.user, req.params.postId)));

// ----- Binh luan -----
router.get('/posts/:postId/reactions', async (req, res) => res.json(await posts.listReactions(req.user, req.params.postId, req.query)));
router.get('/posts/:postId/comments/:commentId/replies', async (req, res) =>
    res.json(await posts.listReplies(req.user, req.params.postId, req.params.commentId, req.query.pageToken)));
router.get('/posts/:postId/comments', async (req, res) => res.json(await posts.listComments(req.user, req.params.postId, req.query.pageToken)));
router.post('/posts/:postId/comments', commentLimiter, async (req, res) =>
    res.status(201).json(await posts.addComment(req.user, req.params.postId, req.body || {})));
router.patch('/posts/:postId/comments/:commentId', async (req, res) =>
    res.json(await posts.updateComment(req.user, req.params.postId, req.params.commentId, req.body || {})));
router.delete('/posts/:postId/comments/:commentId', async (req, res) =>
    res.json(await posts.deleteComment(req.user, req.params.postId, req.params.commentId)));

module.exports = router;
