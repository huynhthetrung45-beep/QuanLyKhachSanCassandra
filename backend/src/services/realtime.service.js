// Realtime bang Server-Sent Events (SSE): mot ket noi HTTP mot chieu
// server -> trinh duyet. Khong can cai them thu vien (khac Socket.IO), dung cookie
// dang nhap san co, trinh duyet tu ket noi lai khi mat mang.
// Gioi han: hub nam trong bo nho cua MOT tien trinh backend. Neu chay nhieu
// instance can them pub/sub (vd. Redis) - ngoai pham vi do an.
const clients = new Map(); // userId -> Set<res>
// "Last seen" chi luu trong bo nho: mat khi backend khoi dong lai (khong co co so ben vung).
const lastSeen = new Map(); // userId -> Date
const presenceListeners = new Set();

// Tra ve { firstConnection } de route biet khi nao bao "online".
function subscribe(userId, res) {
    if (!clients.has(userId)) clients.set(userId, new Set());
    const set = clients.get(userId);
    set.add(res);
    if (set.size === 1) presenceListeners.forEach(fn => fn(userId, true));
    return () => {
        const current = clients.get(userId);
        if (!current) return;
        current.delete(res);
        if (current.size === 0) {
            clients.delete(userId);
            lastSeen.set(userId, new Date());
            presenceListeners.forEach(fn => fn(userId, false));
        }
    };
}

function isOnline(userId) {
    return clients.has(userId);
}

function presenceOf(userId) {
    const seen = lastSeen.get(userId);
    return { online: clients.has(userId), lastSeenAt: clients.has(userId) ? null : (seen ? seen.toISOString() : null) };
}

function onPresenceChange(fn) {
    presenceListeners.add(fn);
    return () => presenceListeners.delete(fn);
}

function publish(userIds, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const userId of new Set(userIds)) {
        const set = clients.get(userId);
        if (!set) continue;
        for (const res of set) {
            try {
                res.write(payload);
            } catch {
                set.delete(res);
            }
        }
    }
}

// Phat cho MOI ket noi. Chi dung cho su kien KHONG chua noi dung (vd. { postId }): nguoi nhan
// tu tai lai qua API co kiem tra quyen, nen khong lo du lieu rieng tu.
function publishAll(event, data) {
    publish([...clients.keys()], event, data);
}

function connectionCount() {
    let total = 0;
    for (const set of clients.values()) total += set.size;
    return total;
}

module.exports = { subscribe, publish, publishAll, connectionCount, isOnline, presenceOf, onPresenceChange };
