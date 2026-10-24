const express = require('express');
const conversationService = require('../services/conversation.service');
const messageService = require('../services/message.service');
const pins = require('../services/pin.service');
const reactionService = require('../services/reaction.service');
const attachmentService = require('../services/attachment.service');
const { rateLimit } = require('../middleware/security');

const router = express.Router();

// Chong spam theo NGUOI DUNG da xac thuc (khong theo du lieu client gui).
const perUser = (windowMs, max, message) => rateLimit({ windowMs, max, key: req => req.user.userId, message });
const sendLimiter = perUser(10 * 1000, Number(process.env.SEND_RATE_LIMIT || 30), 'Bạn gửi tin quá nhanh, hãy chờ vài giây.');
const reactLimiter = perUser(60 * 1000, Number(process.env.REACTION_RATE_LIMIT || 120), 'Bạn thả cảm xúc quá nhanh.');
const uploadLimiter = perUser(10 * 60 * 1000, Number(process.env.UPLOAD_RATE_LIMIT || 60), 'Bạn tải lên quá nhiều tệp, hãy thử lại sau.');
const rawUpload = express.raw({ type: () => true, limit: attachmentService.MAX_FILE_BYTES + 1024 });

// ----- Hoi thoai -----
router.post('/conversations/direct', async (req, res) => {
    const result = await conversationService.openDirect(req.user, req.body?.targetUserId);
    res.status(result.created ? 201 : 200).json(result);
});

router.post('/conversations/groups', async (req, res) => {
    res.status(201).json(await conversationService.createGroup(req.user, req.body));
});

// Q5
router.get('/conversations/:conversationId', async (req, res) => {
    res.json(await conversationService.getDetail(req.params.conversationId, req.user));
});

router.patch('/conversations/:conversationId', async (req, res) => {
    res.json(await conversationService.renameGroup(req.params.conversationId, req.user, req.body));
});

router.post('/conversations/:conversationId/members', async (req, res) => {
    res.json(await conversationService.addMembers(req.params.conversationId, req.user, req.body));
});

router.delete('/conversations/:conversationId/members/:memberId', async (req, res) => {
    res.json(await conversationService.removeMember(req.params.conversationId, req.user, req.params.memberId));
});

router.post('/conversations/:conversationId/typing', async (req, res) => {
    res.json(await conversationService.typing(req.params.conversationId, req.user));
});

router.post('/conversations/:conversationId/read', async (req, res) => {
    res.json(await conversationService.markRead(req.params.conversationId, req.user));
});

router.put('/conversations/:conversationId/pin', async (req, res) => {
    res.json(await conversationService.setPinned(req.params.conversationId, req.user, req.body?.pinned));
});

// ----- Tin nhan -----
// Q2: GET /conversations/:id/messages?limit=20&pageToken=...
router.get('/conversations/:conversationId/messages', async (req, res) => {
    const page = await messageService.listMessages(req.params.conversationId, req.user, req.query);
    res.locals.logExtra = {
        conversationId: page.conversationId,
        rows: page.count,
        hasMore: page.hasMore,
        queryTimeMs: page.queryTimeMs
    };
    res.json(page);
});

// Q3 (van ban, tra loi, kem tep)
router.post('/conversations/:conversationId/messages', sendLimiter, async (req, res) => {
    res.status(201).json(await messageService.sendMessage(req.params.conversationId, req.user, req.body));
});

// Chuyen tiep sang hoi thoai :conversationId; body.source = { conversationId, messageId, createdAt }
router.post('/conversations/:conversationId/forward', sendLimiter, async (req, res) => {
    res.status(201).json(await messageService.forwardMessage(req.params.conversationId, req.user, req.body));
});

// Cam xuc: moi nguoi 1 cam xuc / tin
router.put('/conversations/:conversationId/messages/:messageId/reaction', reactLimiter, async (req, res) => {
    res.json(await reactionService.setReaction(req.params.conversationId, req.params.messageId, req.user, req.body));
});
router.delete('/conversations/:conversationId/messages/:messageId/reaction', reactLimiter, async (req, res) => {
    res.json(await reactionService.removeReaction(req.params.conversationId, req.params.messageId, req.user, req.query));
});

// Xoa phia toi
// ----- Ghim tin nhan (migration 008) -----
router.get('/conversations/:conversationId/pins', async (req, res) => {
    res.json(await pins.listPins(req.params.conversationId, req.user));
});
router.put('/conversations/:conversationId/messages/:messageId/pin', async (req, res) => {
    res.json(await pins.pinMessage(req.params.conversationId, req.params.messageId, req.user, req.body));
});
router.delete('/conversations/:conversationId/messages/:messageId/pin', async (req, res) => {
    res.json(await pins.unpinMessage(req.params.conversationId, req.params.messageId, req.user));
});

router.post('/conversations/:conversationId/messages/:messageId/hide', async (req, res) => {
    res.json(await messageService.hideForMe(req.params.conversationId, req.params.messageId, req.user, req.body));
});

// ----- Tep -----
// Tai len: body la NOI DUNG TEP (khong multipart), ten tep trong header X-File-Name (encodeURIComponent).
router.post('/conversations/:conversationId/attachments', uploadLimiter, rawUpload, async (req, res) => {
    let fileName = '';
    try {
        fileName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    } catch {
        fileName = '';
    }
    res.status(201).json(await attachmentService.upload(req.params.conversationId, req.user, {
        buffer: Buffer.isBuffer(req.body) ? req.body : null,
        fileName
    }));
});

router.get('/conversations/:conversationId/attachments', async (req, res) => {
    res.json(await attachmentService.list(req.params.conversationId, req.user, req.query));
});

router.delete('/conversations/:conversationId/attachments/:attachmentId', async (req, res) => {
    res.json(await attachmentService.cancelPending(req.params.conversationId, req.params.attachmentId, req.user));
});

// Tai xuong: kiem tra quyen thanh vien moi lan; khong co URL tinh.
router.get('/conversations/:conversationId/attachments/:attachmentId/content', async (req, res) => {
    const { row, full, size } = await attachmentService.openForDownload(req.params.conversationId, req.params.attachmentId, req.user);
    const inline = req.query.inline === '1' && ['IMAGE', 'VIDEO'].includes(row.kind);
    res.set({
        'Content-Type': row.mime_type,
        'Content-Length': String(size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; sandbox",
        'Cache-Control': 'private, max-age=300'
    });
    require('fs').createReadStream(full).on('error', () => res.destroy()).pipe(res);
});

// Q4: DELETE /conversations/:id/messages/:messageId?createdAt=ISO
router.delete('/conversations/:conversationId/messages/:messageId', async (req, res) => {
    res.json(await messageService.recallMessage(
        req.params.conversationId, req.params.messageId, req.user, req.query
    ));
});

// FR-14
router.get('/conversations/:conversationId/stats', async (req, res) => {
    res.json(await messageService.countMessages(req.params.conversationId, req.user));
});

module.exports = router;
