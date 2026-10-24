const { httpError } = require('./httpError');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Chuan hoa email dung CHUNG cho dang ky, dang nhap, tim kiem va seed:
// trim + Unicode NFC + chu thuong.
function normalizeEmail(email) {
    return String(email || '').trim().normalize('NFC').toLowerCase();
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

function validateRegistration(body = {}) {
    const fields = {};
    const displayName = typeof body.displayName === 'string'
        ? body.displayName.normalize('NFC').trim().replace(/\s+/g, ' ')
        : '';
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

    if (displayName.length < 2 || displayName.length > 50) {
        fields.displayName = 'Tên hiển thị cần từ 2 đến 50 ký tự.';
    } else if (CONTROL_RE.test(displayName)) {
        fields.displayName = 'Tên hiển thị chứa ký tự không hợp lệ.';
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
        fields.email = 'Email không đúng định dạng.';
    }
    if (password.length < 8 || password.length > 72) {
        fields.password = 'Mật khẩu cần từ 8 đến 72 ký tự.';
    } else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        fields.password = 'Mật khẩu cần có cả chữ và số.';
    }
    if (confirmPassword !== password) {
        fields.confirmPassword = 'Mật khẩu xác nhận không khớp.';
    }

    if (Object.keys(fields).length > 0) {
        throw httpError(400, 'VALIDATION_ERROR', 'Thông tin đăng ký chưa hợp lệ.', { fields });
    }
    return { displayName, email, password };
}

function validateLogin(body = {}) {
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) {
        throw httpError(400, 'VALIDATION_ERROR', 'Vui lòng nhập email và mật khẩu.');
    }
    return { email, password };
}

function validateContent(content) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text.length < 1 || text.length > 2000) {
        throw httpError(400, 'INVALID_CONTENT', 'Nội dung tin nhắn phải có từ 1 đến 2000 ký tự.');
    }
    return text;
}

function validateLimit(raw) {
    if (raw === undefined || raw === '') return 20;
    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw httpError(400, 'INVALID_LIMIT', 'limit phải là số nguyên từ 1 đến 50.');
    }
    return limit;
}

function validateGroupName(name) {
    const text = typeof name === 'string' ? name.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
    if (text.length < 1 || text.length > 80 || CONTROL_RE.test(text)) {
        throw httpError(400, 'INVALID_GROUP_NAME', 'Tên nhóm cần từ 1 đến 80 ký tự.');
    }
    return text;
}

function validateUserIdList(list, label = 'memberIds') {
    if (!Array.isArray(list) || list.length === 0 || list.length > 50) {
        throw httpError(400, 'INVALID_MEMBERS', `${label} phải là danh sách từ 1 đến 50 người dùng.`);
    }
    const ids = [...new Set(list.map(id => String(id || '').trim()).filter(Boolean))];
    if (ids.some(id => id.length > 100)) {
        throw httpError(400, 'INVALID_MEMBERS', 'Mã người dùng không hợp lệ.');
    }
    return ids;
}

module.exports = {
    normalizeEmail,
    validateRegistration,
    validateLogin,
    validateContent,
    validateLimit,
    validateGroupName,
    validateUserIdList
};
