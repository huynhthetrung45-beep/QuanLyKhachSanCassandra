// NFR-11: log moi request (endpoint, nguoi dung, ma trang thai, thoi gian).
// Cac route phan trang them res.locals.logExtra (conversationId, so dong, queryTimeMs).
// Khong bao gio log mat khau, cookie hay token.
function requestLogger(req, res, next) {
    if (process.env.LOG_REQUESTS === 'false') return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const user = req.user ? req.user.userId : '-';
        const extra = res.locals.logExtra ? ' ' + JSON.stringify(res.locals.logExtra) : '';
        const path = req.originalUrl.replace(/pageToken=[^&]+/, 'pageToken=…');
        console.log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms user=${user}${extra}`);
    });
    next();
}

module.exports = { requestLogger };
