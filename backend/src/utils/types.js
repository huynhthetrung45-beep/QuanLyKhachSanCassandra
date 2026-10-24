const cassandra = require('cassandra-driver');
const { httpError } = require('./httpError');

const { Uuid, TimeUuid } = cassandra.types;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseUuid(value, label = 'conversationId') {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw httpError(400, 'INVALID_ID', `${label} không phải UUID hợp lệ`);
    }
    return Uuid.fromString(value.toLowerCase());
}

function parseTimeUuid(value, label = 'messageId') {
    if (typeof value !== 'string' || !UUID_RE.test(value) || value[14] !== '1') {
        throw httpError(400, 'INVALID_ID', `${label} không phải TimeUUID hợp lệ`);
    }
    return TimeUuid.fromString(value.toLowerCase());
}

function parseTimestamp(value, label = 'createdAt') {
    if (typeof value !== 'string' || !value) {
        throw httpError(400, 'MISSING_CREATED_AT', `Thiếu tham số ${label}`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw httpError(400, 'INVALID_CREATED_AT', `${label} không đúng định dạng ISO-8601`);
    }
    return date;
}

function toNumber(value) {
    if (value && typeof value.toNumber === 'function') return value.toNumber();
    return Number(value);
}

const iso = date => (date ? new Date(date).toISOString() : null);

module.exports = { Uuid, TimeUuid, parseUuid, parseTimeUuid, parseTimestamp, toNumber, iso };
