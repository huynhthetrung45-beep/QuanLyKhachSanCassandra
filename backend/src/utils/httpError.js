class HttpError extends Error {
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

const httpError = (status, code, message, details) =>
    new HttpError(status, code, message, details);

// Loi cua cassandra-driver khi khong ket noi duoc hoac het thoi gian cho.
function isDbUnavailable(error) {
    const name = error && (error.name || error.constructor?.name || '');
    return [
        'NoHostAvailableError',
        'OperationTimedOutError',
        'BusyConnectionError'
    ].includes(name) || (error && error.code === 0x1001 /* unavailable */);
}

module.exports = { HttpError, httpError, isDbUnavailable };
