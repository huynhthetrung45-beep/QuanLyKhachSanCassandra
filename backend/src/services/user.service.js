const db = require('../db');
const { fold, nameTokens, tokenBucket, prefixUpperBound } = require('../utils/text');
const { normalizeEmail } = require('../utils/validate');

const toUserDto = row => ({
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || null
});

// Q0 (SRS): danh sach nguoi dung - quet bang users, chi dung cho demo (it dong).
async function listUsers() {
    const result = await db.execute('SELECT user_id, display_name, avatar_url FROM users', [], { fetchSize: 500 });
    return result.rows.map(toUserDto);
}

// Doc ho so theo danh sach id: moi id la mot truy van mot partition, chay song song
// (tot hon IN tren partition key vi moi truy van duoc dinh tuyen token-aware).
async function getUsersByIds(ids) {
    const unique = [...new Set(ids)];
    const results = await Promise.all(unique.map(id =>
        db.execute('SELECT user_id, display_name, avatar_url FROM users WHERE user_id = ?', [id])
    ));
    const map = new Map();
    results.forEach(result => {
        const row = result.first();
        if (row) map.set(row.user_id, toUserDto(row));
    });
    return map;
}

// Tim nguoi dung (query-first, khong quet bang users):
//  - Co '@'  : tra cuu CHINH XAC email tren accounts_by_email (1 partition).
//  - Dang ma : user01 / u_xxx -> doc thang users theo partition key.
//  - Con lai : tim theo TIEN TO tung tu trong ten, khong phan biet dau/hoa thuong.
//      "dang li" -> tu "dang" va "li". Doc lat cat users_by_name_token cua tu DAI NHAT
//      (chon loc nhat): WHERE token_prefix = 'da' AND name_token >= 'dang' AND name_token < 'dang~'
//      roi giu nhung nguoi ma MOI tu con lai la tien to cua mot tu trong ten.
//      Gioi han doc toi da MAX_TOKEN_ROWS dong token, tra toi da `limit` nguoi.
const MAX_TOKEN_ROWS = 500;
const ID_RE = /^(user\d{1,6}|u_[0-9a-f]{20})$/i;

async function searchUsers(query, excludeUserId, limit = 20) {
    const q = String(query || '').trim();
    if (!q) return [];

    if (q.includes('@')) {
        const result = await db.execute(
            'SELECT user_id, status FROM accounts_by_email WHERE email = ?',
            [normalizeEmail(q)]
        );
        const account = result.first();
        if (!account || account.status !== 'ACTIVE' || account.user_id === excludeUserId) return [];
        const users = await getUsersByIds([account.user_id]);
        return [...users.values()].map(user => ({ ...user, matchedBy: 'email' }));
    }

    const found = new Map();
    if (ID_RE.test(q) && q !== excludeUserId) {
        const byId = await getUsersByIds([q]);
        byId.forEach(user => found.set(user.userId, { ...user, matchedBy: 'id' }));
    }

    const words = nameTokens(q);
    if (words.length === 0) return [...found.values()];
    const driver = [...words].sort((a, b) => b.length - a.length)[0];
    const others = words.filter(word => word !== driver);

    let pageState;
    let read = 0;
    do {
        const result = await db.execute(
            `SELECT name_token, user_id, display_name, avatar_url FROM users_by_name_token
             WHERE token_prefix = ? AND name_token >= ? AND name_token < ?`,
            [tokenBucket(driver), driver, prefixUpperBound(driver)],
            { fetchSize: 100, pageState }
        );
        for (const row of result.rows) {
            read += 1;
            if (row.user_id === excludeUserId || found.has(row.user_id)) continue;
            const nameWords = nameTokens(row.display_name);
            if (others.every(word => nameWords.some(w => w.startsWith(word)))) {
                found.set(row.user_id, {
                    userId: row.user_id,
                    displayName: row.display_name,
                    avatarUrl: row.avatar_url || null,
                    matchedBy: 'name'
                });
            }
        }
        pageState = result.pageState;
    } while (pageState && read < MAX_TOKEN_ROWS);

    return [...found.values()]
        .sort((a, b) => fold(a.displayName).localeCompare(fold(b.displayName)) || a.userId.localeCompare(b.userId))
        .slice(0, limit);
}

module.exports = { listUsers, getUsersByIds, searchUsers, toUserDto };
