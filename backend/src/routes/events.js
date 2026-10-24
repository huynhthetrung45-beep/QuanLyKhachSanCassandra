const express = require('express');
const realtime = require('../services/realtime.service');

const router = express.Router();

// GET /api/v1/events - luong Server-Sent Events cho nguoi dang dang nhap.
router.get('/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\n');
    res.write(`event: ready\ndata: ${JSON.stringify({ userId: req.user.userId })}\n\n`);

    const unsubscribe = realtime.subscribe(req.user.userId, res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
});

module.exports = router;
