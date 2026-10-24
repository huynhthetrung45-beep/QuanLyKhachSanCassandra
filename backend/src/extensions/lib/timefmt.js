// Dinh dang thoi gian cho noi dung thong bao (may chu khong biet mui gio trinh duyet): theo APP_TIMEZONE, mac dinh gio Viet Nam.
const TZ = process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh';

let formatter;
try {
    formatter = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
} catch {
    formatter = new Intl.DateTimeFormat('vi-VN', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });
}

// "15:00 28/10/2026"
function formatWhen(date) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(date)).map(p => [p.type, p.value]));
    return `${parts.hour}:${parts.minute} ${parts.day}/${parts.month}/${parts.year}`;
}

module.exports = { formatWhen, TZ };
