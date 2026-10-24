const PREVIEW_MAX = 50; // BR-08

function makePreview(content) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text;
}

// Bo dau tieng Viet de tim kiem khong phan biet dau/hoa thuong.
function fold(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[đðĐÐ]/g, 'd')   // gom ca chu Eth (Ð/ð) hay bi go nham thay cho Đ/đ
        .toLowerCase()
        .trim();
}

const RECALLED_PREVIEW = 'Tin nhắn đã được thu hồi';

module.exports = { makePreview, fold, PREVIEW_MAX, RECALLED_PREVIEW };

// ===== Token tim kiem ten (bang users_by_name_token) =====
// Chuan hoa: bo dau, d/đ -> d, chu thuong, chi giu [a-z0-9]; tach theo tu.
// Tu dai < 2 ky tu bi bo qua (khong the tim vi truy van toi thieu 2 ky tu).
const TOKEN_MIN = 2;
const TOKEN_MAX = 30;
const TOKENS_PER_USER = 10;

function nameTokens(name) {
    const words = fold(name).replace(/[^a-z0-9]+/g, ' ').split(' ')
        .filter(word => word.length >= TOKEN_MIN)
        .map(word => word.slice(0, TOKEN_MAX));
    return [...new Set(words)].slice(0, TOKENS_PER_USER);
}

// Partition key = 2 ky tu dau cua token; truy van tien to la mot lat cat
// clustering lien tuc: name_token >= 'ngu' AND name_token < 'ngu~' (vi token chi gom [a-z0-9] < '~').
const tokenBucket = token => token.slice(0, TOKEN_MIN);
const prefixUpperBound = prefix => prefix + '~';

module.exports.nameTokens = nameTokens;
module.exports.tokenBucket = tokenBucket;
module.exports.prefixUpperBound = prefixUpperBound;
module.exports.TOKEN_MIN = TOKEN_MIN;
