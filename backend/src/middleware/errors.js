const { HttpError, isDbUnavailable } = require('../utils/httpError');

function notFound(req, res) {
    res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn API.' }
    });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    if (err instanceof HttpError) {
        const body = { error: { code: err.code, message: err.message } };
        if (err.details) Object.assign(body.error, err.details);
        return res.status(err.status).json(body);
    }

    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: 'Dữ liệu gửi lên vượt quá giới hạn cho phép.' } });
    }

    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Dữ liệu JSON không hợp lệ.' } });
    }

    if (isDbUnavailable(err)) {
        console.error('[DB_UNAVAILABLE]', err.message);
        return res.status(503).json({
            error: { code: 'DB_UNAVAILABLE', message: 'Không kết nối được Cassandra. Vui lòng thử lại.' }
        });
    }

    console.error('[ERROR]', req.method, req.originalUrl, err);
    return res.status(500).json({
        error: { code: 'INTERNAL_SERVER_ERROR', message: 'Đã có lỗi phía máy chủ.' }
    });
}

module.exports = { notFound, errorHandler };
