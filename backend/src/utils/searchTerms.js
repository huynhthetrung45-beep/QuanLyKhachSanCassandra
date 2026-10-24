// Tach tu de lap chi muc / tim kiem: bo dau tieng Viet, chu thuong, tach theo ky tu khong phai chu/so.
// Dung CHUNG cho ghi chi muc (backend), backfill (migrate.js) va truy van tim kiem.
const { fold } = require('./text');

const MAX_TERMS = 60;

function termsOf(...texts) {
    const out = new Set();
    for (const text of texts) {
        for (const w of fold(String(text || '')).split(/[^a-z0-9]+/)) {
            if (w.length >= 2 && w.length <= 40) out.add(w);
            if (out.size >= MAX_TERMS) return [...out];
        }
    }
    return [...out];
}

// Ngay / gio theo Asia/Ho_Chi_Minh (UTC+7, khong co gio mua he).
function localParts(date) {
    const d = new Date(new Date(date).getTime() + 7 * 3600 * 1000);
    return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

module.exports = { termsOf, localParts };
