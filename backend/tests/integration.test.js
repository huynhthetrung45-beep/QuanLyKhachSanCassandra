// Kiem thu tich hop tren CASSANDRA THAT (khong dung Cassandra gia lap).
//   npm run test:integration
// Can: Cassandra dang chay, da chay "npm run migrate".
// Du lieu tao them (KHONG xoa du lieu cu): 2 tai khoan "it-...@chatott.test",
// 1 hoi thoai 1-1 giua hai tai khoan do voi 25 tin nhan.
// Tuy chon: dat IT_EMAIL va IT_PASSWORD (tai khoan demo thuoc hoi thoai 1111...)
// de kiem tra phan trang tren hoi thoai 200 tin (chi doc).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('./helpers');

process.env.LOG_REQUESTS = process.env.LOG_REQUESTS || 'false';
const db = require('../src/db');
const { createApp } = require('../src/app');

const FOCUS = '11111111-1111-1111-1111-111111111111';
let server;
let base;
let a;
let b;
let directId;
const stamp = Date.now();
const PASSWORD = 'TichHop' + (stamp % 100000) + 'x';

test.before(async () => {
    await db.getClient().connect();
    server = createApp().listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    server.close();
    await db.getClient().shutdown();
});

test('health: kết nối Cassandra thật và đủ bảng sau migration', async () => {
    const res = await new Agent(base).get('/api/health');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'OK', 'Hãy chạy npm run migrate. ' + JSON.stringify(res.body.missingTables));
});

test('đăng ký 2 tài khoản kiểm thử, email trùng bị 409, đăng nhập', async () => {
    const mk = n => ({ displayName: `Kiểm thử ${n}`, email: `it-${n}-${stamp}@chatott.test`, password: PASSWORD, confirmPassword: PASSWORD });
    for (const n of ['a', 'b']) {
        const r = await new Agent(base).post('/api/v1/auth/register', mk(n));
        assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const dup = await new Agent(base).post('/api/v1/auth/register', mk('a'));
    assert.equal(dup.status, 409);

    a = new Agent(base);
    b = new Agent(base);
    assert.equal((await a.post('/api/v1/auth/login', { email: `it-a-${stamp}@chatott.test`, password: PASSWORD })).status, 200);
    assert.equal((await b.post('/api/v1/auth/login', { email: `it-b-${stamp}@chatott.test`, password: PASSWORD })).status, 200);
    assert.equal((await a.post('/api/v1/auth/login', { email: `it-a-${stamp}@chatott.test`, password: 'sai' })).status, 401);
});

test('người ngoài không đọc được hội thoại demo; giả mạo userId bị 403', async () => {
    assert.equal((await a.get(`/api/v1/conversations/${FOCUS}/messages`)).status, 403);
    assert.equal((await a.get(`/api/v1/conversations/${FOCUS}/messages?userId=user01`)).status, 403);
    assert.equal((await new Agent(base).get('/api/v1/me/conversations')).status, 401);
});

test('mở hội thoại 1-1 hai lần trả cùng một id (LWT)', async () => {
    const meB = await b.get('/api/v1/auth/me');
    const r1 = await a.post('/api/v1/conversations/direct', { targetUserId: meB.body.user.userId });
    const r2 = await a.post('/api/v1/conversations/direct', { targetUserId: meB.body.user.userId });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r2.body.conversationId, r1.body.conversationId);
    directId = r1.body.conversationId;
});

test('gửi 25 tin, phân trang 20 + 5 bằng pageToken, thu hồi, đọc lại bằng CQL', async () => {
    for (let i = 1; i <= 25; i++) {
        const sender = i % 2 ? a : b;
        const r = await sender.post(`/api/v1/conversations/${directId}/messages`, { content: `IT #${String(i).padStart(2, '0')}` });
        assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const p1 = await b.get(`/api/v1/conversations/${directId}/messages?limit=20`);
    assert.equal(p1.body.count, 20);
    assert.equal(p1.body.items[0].content, 'IT #25');
    assert.ok(p1.body.nextPageToken);
    const p2 = await b.get(`/api/v1/conversations/${directId}/messages?limit=20&pageToken=${p1.body.nextPageToken}`);
    assert.equal(p2.body.count, 5);
    assert.equal(p2.body.items[4].content, 'IT #01');
    assert.equal(p2.body.hasMore, false);

    const last = p1.body.items[0]; // IT #25, do a gui
    assert.equal((await b.del(`/api/v1/conversations/${directId}/messages/${last.messageId}?createdAt=${encodeURIComponent(last.createdAt)}`)).status, 403);
    const del = await a.del(`/api/v1/conversations/${directId}/messages/${last.messageId}?createdAt=${encodeURIComponent(last.createdAt)}`);
    assert.equal(del.status, 200, JSON.stringify(del.body));

    const row = (await db.execute(
        'SELECT is_deleted, content FROM messages_by_conversation WHERE conversation_id = ? LIMIT 1', [directId]
    )).first();
    assert.equal(row.is_deleted, true);
    assert.equal(row.content, null);

    const list = await b.get('/api/v1/me/conversations');
    const conv = list.body.data.find(c => c.conversationId === directId);
    assert.equal(conv.lastMessagePreview, 'Tin nhắn đã được thu hồi');
});

test('đăng xuất vô hiệu hóa phiên', async () => {
    assert.equal((await a.post('/api/v1/auth/logout')).status, 200);
    assert.equal((await a.get('/api/v1/auth/me')).status, 401);
});

test('phân trang hội thoại demo 200+ tin (chỉ đọc, cần IT_EMAIL/IT_PASSWORD)', { skip: !process.env.IT_EMAIL }, async () => {
    const demo = new Agent(base);
    assert.equal((await demo.post('/api/v1/auth/login', { email: process.env.IT_EMAIL, password: process.env.IT_PASSWORD })).status, 200);
    const ids = [];
    let token = null;
    let prev = null;
    let pages = 0;
    do {
        const qs = token ? `?limit=20&pageToken=${token}` : '?limit=20';
        const r = await demo.get(`/api/v1/conversations/${FOCUS}/messages${qs}`);
        assert.equal(r.status, 200);
        if (r.body.nextPageToken) assert.equal(r.body.count, 20);
        r.body.items.forEach(i => {
            if (prev) assert.ok(prev >= i.createdAt);
            prev = i.createdAt;
            ids.push(i.messageId);
        });
        token = r.body.nextPageToken;
        pages += 1;
    } while (token && pages < 100);
    const count = (await demo.get(`/api/v1/conversations/${FOCUS}/stats`)).body.messageCount;
    assert.equal(ids.length, count);
    assert.equal(new Set(ids).size, count);
    await demo.post('/api/v1/auth/logout');
});
