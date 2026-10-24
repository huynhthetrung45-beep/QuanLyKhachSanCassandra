// Kiem thu API tu dong tren Cassandra gia lap. Chay: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestServer, linkAccount, GROUP_ID, SMALL_ID, OTHER_GROUP_ID } = require('./helpers');

const PASSWORD = 'MatKhau123';
let ctx;
let an;    // user01 - Nguyen An (thanh vien nhom trong tam)
let binh;  // user02
let linh;  // user07 - KHONG thuoc nhom trong tam

async function loginAs(email, password = PASSWORD) {
    const agent = ctx.agent();
    const res = await agent.post('/api/v1/auth/login', { email, password });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return agent;
}

async function readAllPages(agent, conversationId, limit = 20) {
    const pages = [];
    let token = null;
    for (let guard = 0; guard < 100; guard++) {
        const qs = new URLSearchParams({ limit: String(limit) });
        if (token) qs.set('pageToken', token);
        const res = await agent.get(`/api/v1/conversations/${conversationId}/messages?${qs}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        pages.push(res.body);
        token = res.body.nextPageToken;
        if (!token) break;
    }
    return pages;
}

test.before(async () => {
    ctx = await startTestServer();
    await linkAccount(ctx.fake, 'user01', 'an@chatott.demo', PASSWORD);
    await linkAccount(ctx.fake, 'user02', 'binh@chatott.demo', PASSWORD);
    await linkAccount(ctx.fake, 'user07', 'linh@chatott.demo', PASSWORD);
    an = await loginAs('an@chatott.demo');
    binh = await loginAs('binh@chatott.demo');
    linh = await loginAs('linh@chatott.demo');
});

test.after(() => ctx.server.close());

// ================= Tai khoan =================
test.describe('Đăng ký / đăng nhập / đăng xuất', () => {
    test('health không cần đăng nhập và báo đủ bảng', async () => {
        const res = await ctx.agent().get('/api/health');
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'OK');
        assert.deepEqual(res.body.missingTables, []);
    });

    test('chưa đăng nhập thì mọi API chat trả 401', async () => {
        const guest = ctx.agent();
        for (const p of ['/api/v1/me/conversations', `/api/v1/conversations/${GROUP_ID}/messages`, '/api/v1/auth/me']) {
            const res = await guest.get(p);
            assert.equal(res.status, 401, p);
            assert.equal(res.body.error.code, 'UNAUTHENTICATED');
        }
        const send = await guest.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'x', userId: 'user01' });
        assert.equal(send.status, 401);
    });

    test('kiểm tra dữ liệu đăng ký, trả lỗi theo từng trường bằng tiếng Việt', async () => {
        const res = await ctx.agent().post('/api/v1/auth/register', {
            displayName: 'A', email: 'sai-email', password: 'abc', confirmPassword: 'xyz'
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'VALIDATION_ERROR');
        assert.ok(res.body.error.fields.displayName);
        assert.ok(res.body.error.fields.email);
        assert.ok(res.body.error.fields.password);
        assert.ok(res.body.error.fields.confirmPassword);
    });

    test('đăng ký thành công, mật khẩu được băm và không trả về hash', async () => {
        const res = await ctx.agent().post('/api/v1/auth/register', {
            displayName: 'Ngô Mai', email: 'Mai.Ngo@Example.com', password: 'Secret123', confirmPassword: 'Secret123'
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.user.email, 'mai.ngo@example.com');
        assert.equal(JSON.stringify(res.body).includes('Secret123'), false);
        assert.equal('passwordHash' in res.body.user, false);

        const stored = [...ctx.fake.data.accounts_by_email.values()].find(r => r.email === 'mai.ngo@example.com');
        assert.match(stored.password_hash, /^scrypt\$/);
        assert.equal(stored.password_hash.includes('Secret123'), false);
    });

    test('email trùng (không phân biệt hoa thường) bị từ chối 409', async () => {
        const res = await ctx.agent().post('/api/v1/auth/register', {
            displayName: 'Người khác', email: '  MAI.NGO@example.com ', password: 'Secret123', confirmPassword: 'Secret123'
        });
        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, 'EMAIL_EXISTS');
    });

    test('đăng ký đồng thời cùng email, khác người (khác mật khẩu): chỉ một yêu cầu thắng (LWT)', async () => {
        const results = await Promise.all([1, 2, 3].map(i => ctx.agent().post('/api/v1/auth/register', {
            displayName: 'Song Song ' + i, email: 'race@example.com', password: 'Secret12' + i, confirmPassword: 'Secret12' + i
        })));
        assert.equal(results.filter(r => r.status === 201).length, 1);
        assert.equal(results.filter(r => r.status === 409).length, 2);
        const rows = [...ctx.fake.data.accounts_by_email.values()].filter(r => r.email === 'race@example.com');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, 'ACTIVE');
    });

    test('gửi lại cùng email + cùng mật khẩu đồng thời (bấm đúp): một tài khoản duy nhất, cùng userId', async () => {
        const body = { displayName: 'Bấm Đúp', email: 'double@example.com', password: 'Secret123', confirmPassword: 'Secret123' };
        const results = await Promise.all([1, 2].map(() => ctx.agent().post('/api/v1/auth/register', body)));
        const ok = results.filter(r => r.status === 201);
        assert.ok(ok.length >= 1);
        assert.equal(new Set(ok.map(r => r.body.user.userId)).size, 1);
        assert.equal([...ctx.fake.data.accounts_by_email.values()].filter(r => r.email === 'double@example.com').length, 1);
    });

    test('đăng nhập sai mật khẩu và email không tồn tại trả cùng thông báo', async () => {
        const wrong = await ctx.agent().post('/api/v1/auth/login', { email: 'mai.ngo@example.com', password: 'Sai12345' });
        const missing = await ctx.agent().post('/api/v1/auth/login', { email: 'khongco@example.com', password: 'Sai12345' });
        assert.equal(wrong.status, 401);
        assert.equal(missing.status, 401);
        assert.equal(wrong.body.error.message, missing.body.error.message);
    });

    test('đăng nhập đặt cookie HttpOnly, /auth/me trả hồ sơ không có mật khẩu', async () => {
        const agent = ctx.agent();
        const res = await agent.post('/api/v1/auth/login', { email: 'mai.ngo@example.com', password: 'Secret123' });
        assert.equal(res.status, 200);
        const cookie = res.setCookies.find(c => c.startsWith('chatott_sid='));
        assert.ok(cookie);
        assert.match(cookie, /HttpOnly/i);
        assert.match(cookie, /SameSite=Lax/i);
        assert.equal(JSON.stringify(res.body).includes(agent.cookies.chatott_sid), false, 'token không nằm trong body');

        const me = await agent.get('/api/v1/auth/me');
        assert.equal(me.status, 200);
        assert.equal(me.body.user.displayName, 'Ngô Mai');
        assert.equal(JSON.stringify(me.body).includes('scrypt'), false);
    });

    test('token phiên chỉ lưu dạng SHA-256 trong Cassandra', async () => {
        const token = an.cookies.chatott_sid;
        const keys = [...ctx.fake.data.sessions.values()].map(r => r.session_hash);
        assert.equal(keys.includes(token), false);
        assert.ok(keys.every(k => /^[0-9a-f]{64}$/.test(k)));
    });

    test('đăng xuất xóa phiên; cookie cũ không dùng lại được', async () => {
        const agent = await loginAs('mai.ngo@example.com', 'Secret123');
        const stolen = agent.cookies.chatott_sid;
        const out = await agent.post('/api/v1/auth/logout');
        assert.equal(out.status, 200);
        const replay = ctx.agent();
        replay.cookies.chatott_sid = stolen;
        const me = await replay.get('/api/v1/auth/me');
        assert.equal(me.status, 401);
        assert.equal(me.body.error.code, 'SESSION_EXPIRED');
    });

    test('phiên hết hạn trả 401 SESSION_EXPIRED', async () => {
        const agent = await loginAs('mai.ngo@example.com', 'Secret123');
        for (const row of ctx.fake.data.sessions.values()) {
            if (row.user_id === [...ctx.fake.data.accounts_by_email.values()]
                .find(a => a.email === 'mai.ngo@example.com').user_id) {
                row.expires_at = Date.now() - 1000;
            }
        }
        const me = await agent.get('/api/v1/auth/me');
        assert.equal(me.status, 401);
        assert.equal(me.body.error.code, 'SESSION_EXPIRED');
    });

    test('request thay đổi dữ liệu từ Origin lạ bị chặn (CSRF)', async () => {
        const res = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'csrf' },
            { Origin: 'http://evil.example' });
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'FORBIDDEN_ORIGIN');
    });

    test('đăng nhập sai quá nhiều lần bị giới hạn 429', async () => {
        let last;
        for (let i = 0; i < 12; i++) {
            last = await ctx.agent().post('/api/v1/auth/login', { email: 'bruteforce@example.com', password: 'Sai12345' });
        }
        assert.equal(last.status, 429);
    });
});

// ================= Phuc hoi dang ky =================
test.describe('Phục hồi đăng ký ghi dở (PENDING → ACTIVE)', () => {
    const acc = email => [...ctx.fake.data.accounts_by_email.values()].find(r => r.email === email);
    const failNextBatch = () => {
        const original = ctx.fake.batch.bind(ctx.fake);
        ctx.fake.batch = async () => {
            ctx.fake.batch = original;
            const e = new Error('Operation timed out'); e.name = 'OperationTimedOutError'; throw e;
        };
    };

    test('ghi hồ sơ thất bại: email giữ PENDING (không xóa), đăng nhập báo chưa hoàn tất', async () => {
        failNextBatch();
        const reg = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Lỗi Mạng', email: 'pending1@example.com', password: 'Secret123', confirmPassword: 'Secret123' });
        assert.equal(reg.status, 503);
        assert.equal(acc('pending1@example.com').status, 'PENDING');
        const login = await ctx.agent().post('/api/v1/auth/login', { email: 'pending1@example.com', password: 'Secret123' });
        assert.equal(login.status, 401);
        assert.equal(login.body.error.code, 'REGISTRATION_INCOMPLETE');
    });

    test('chính người đó đăng ký lại (đúng mật khẩu): dùng lại userId cũ, kích hoạt', async () => {
        const oldUserId = acc('pending1@example.com').user_id;
        const reg = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Lỗi Mạng', email: 'pending1@example.com', password: 'Secret123', confirmPassword: 'Secret123' });
        assert.equal(reg.status, 201, JSON.stringify(reg.body));
        assert.equal(reg.body.user.userId, oldUserId);
        assert.equal(acc('pending1@example.com').status, 'ACTIVE');
        assert.equal((await ctx.agent().post('/api/v1/auth/login', { email: 'pending1@example.com', password: 'Secret123' })).status, 200);
    });

    test('người khác không chiếm được bản ghi PENDING còn mới (< ngưỡng)', async () => {
        failNextBatch();
        await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Chủ Thật', email: 'pending2@example.com', password: 'Secret123', confirmPassword: 'Secret123' });
        const before = { ...acc('pending2@example.com') };
        const other = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Kẻ Khác', email: 'pending2@example.com', password: 'Khac12345', confirmPassword: 'Khac12345' });
        assert.equal(other.status, 409);
        assert.deepEqual(acc('pending2@example.com'), before, 'không được thay đổi bản ghi');
    });

    test('PENDING quá ngưỡng, chưa có hồ sơ: người khác chiếm lại có điều kiện, chỉ một người thắng', async () => {
        acc('pending2@example.com').created_at = Date.now() - 11 * 60 * 1000;
        const results = await Promise.all(['Khac12345', 'Khac67890'].map(pw => ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Người Mới', email: 'pending2@example.com', password: pw, confirmPassword: pw })));
        assert.equal(results.filter(r => r.status === 201).length, 1);
        assert.equal(results.filter(r => r.status === 409).length, 1);
        assert.equal(acc('pending2@example.com').status, 'ACTIVE');
    });

    test('PENDING quá ngưỡng nhưng ĐÃ có hồ sơ: không ai chiếm được; chủ đăng nhập thì được kích hoạt', async () => {
        const original = ctx.fake.execute.bind(ctx.fake);
        // Lam that bai buoc kich hoat (B3) mot lan
        ctx.fake.execute = async (q, p, o) => {
            if (/^\s*UPDATE accounts_by_email SET status = 'ACTIVE'/.test(q)) {
                ctx.fake.execute = original;
                const e = new Error('timeout'); e.name = 'OperationTimedOutError'; throw e;
            }
            return original(q, p, o);
        };
        const reg = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Có Hồ Sơ', email: 'pending3@example.com', password: 'Secret123', confirmPassword: 'Secret123' });
        assert.equal(reg.status, 503);
        assert.equal(acc('pending3@example.com').status, 'PENDING');
        acc('pending3@example.com').created_at = Date.now() - 60 * 60 * 1000;

        const thief = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Kẻ Khác', email: 'pending3@example.com', password: 'Khac12345', confirmPassword: 'Khac12345' });
        assert.equal(thief.status, 409);

        const login = await ctx.agent().post('/api/v1/auth/login', { email: 'pending3@example.com', password: 'Secret123' });
        assert.equal(login.status, 200, JSON.stringify(login.body));
        assert.equal(acc('pending3@example.com').status, 'ACTIVE');
    });

    test('tài khoản ACTIVE không bao giờ bị chiếm hay đổi mật khẩu qua đăng ký', async () => {
        const row = acc('an@chatott.demo');
        row.created_at = Date.now() - 24 * 3600 * 1000;
        const hash = row.password_hash;
        const res = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Mạo Danh', email: 'an@chatott.demo', password: 'Khac12345', confirmPassword: 'Khac12345' });
        assert.equal(res.status, 409);
        assert.equal(acc('an@chatott.demo').password_hash, hash);
        assert.equal(acc('an@chatott.demo').user_id, 'user01');
    });

    test('mọi lệnh ghi vào accounts_by_email đều là lệnh có điều kiện (LWT)', () => {
        const writes = ctx.fake.log.filter(e => /^(INSERT INTO|UPDATE|DELETE FROM) accounts_by_email/.test(e.query));
        assert.ok(writes.length > 0);
        writes.forEach(e => assert.match(e.query, / IF /, e.query));
    });
});

// ================= Phan quyen =================
test.describe('Chống giả mạo danh tính và phân quyền', () => {
    test('đổi userId trong query để đọc hộ người khác bị 403', async () => {
        const res = await linh.get(`/api/v1/conversations/${GROUP_ID}/messages?userId=user01`);
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'IDENTITY_MISMATCH');
    });

    test('người không thuộc hội thoại không đọc được lịch sử (NOT_A_MEMBER)', async () => {
        const res = await linh.get(`/api/v1/conversations/${GROUP_ID}/messages`);
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'NOT_A_MEMBER');
    });

    test('gửi tin kèm senderId của người khác bị 403, không ghi gì vào Cassandra', async () => {
        const before = ctx.fake.data.messages_by_conversation.size;
        const res = await linh.post(`/api/v1/conversations/${OTHER_GROUP_ID}/messages`, { content: 'giả mạo', senderId: 'user02' });
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'IDENTITY_MISMATCH');
        assert.equal(ctx.fake.data.messages_by_conversation.size, before);
    });

    test('không xem được danh sách hội thoại của người khác', async () => {
        const res = await an.get('/api/v1/users/user02/conversations');
        assert.equal(res.status, 403);
        const mine = await an.get('/api/v1/users/user01/conversations');
        assert.equal(mine.status, 200);
    });

    test('không đọc được thông tin hội thoại mình không tham gia', async () => {
        const res = await linh.get(`/api/v1/conversations/${GROUP_ID}`);
        assert.equal(res.status, 403);
    });

    test('conversationId sai định dạng trả 400 INVALID_ID', async () => {
        const res = await an.get('/api/v1/conversations/khong-phai-uuid/messages');
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'INVALID_ID');
    });

    test('hội thoại không tồn tại trả 404', async () => {
        const res = await an.get('/api/v1/conversations/12345678-1234-1234-1234-123456789abc/messages');
        assert.equal(res.status, 404);
        assert.equal(res.body.error.code, 'CONVERSATION_NOT_FOUND');
    });
});

// ================= Phan trang (TC-01 -> TC-07, TC-12, TC-14) =================
test.describe('Phân trang Paging State', () => {
    test('TC-01: trang đầu đúng 20 tin #200 → #181, có queryTimeMs', async () => {
        const res = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?limit=20`);
        assert.equal(res.status, 200);
        assert.equal(res.body.count, 20);
        assert.equal(res.body.hasMore, true);
        assert.equal(typeof res.body.queryTimeMs, 'number');
        assert.match(res.body.items[0].content, /^#200/);
        assert.match(res.body.items[19].content || '', /^(#181|)/);
        assert.equal(res.body.items[19].createdAt < res.body.items[0].createdAt, true);
    });

    test('TC-02/03/05: duyệt hết 200 tin, mỗi trang 20, không trùng, không thiếu, giảm dần', async () => {
        const pages = await readAllPages(an, GROUP_ID);
        const items = pages.flatMap(p => p.items);
        assert.equal(items.length, 200);
        assert.equal(new Set(items.map(i => i.messageId)).size, 200);
        pages.slice(0, 10).forEach(p => assert.equal(p.count, 20));
        assert.equal(pages[pages.length - 1].hasMore, false);
        assert.equal(pages[pages.length - 1].nextPageToken, null);
        for (let i = 1; i < items.length; i++) {
            assert.ok(items[i - 1].createdAt >= items[i].createdAt, `thứ tự sai tại ${i}`);
        }
        assert.match(items[199].content, /^#001/);
        assert.match(pages[1].items[0].content || '#180', /^#180/);
    });

    test('Q2 không dùng LIMIT/OFFSET/ALLOW FILTERING và truyền fetchSize = 20', async () => {
        ctx.fake.log.length = 0;
        await an.get(`/api/v1/conversations/${GROUP_ID}/messages`);
        const q2 = ctx.fake.log.find(e => /FROM messages_by_conversation WHERE conversation_id = \?$/.test(e.query));
        assert.ok(q2, 'phải có truy vấn Q2');
        assert.equal(q2.options.fetchSize, 20);
        assert.doesNotMatch(q2.query, /LIMIT|OFFSET|ALLOW FILTERING/i);
    });

    test('TC-04: hội thoại 7 tin trả 7 tin, hasMore = false', async () => {
        const res = await an.get(`/api/v1/conversations/${SMALL_ID}/messages`);
        assert.equal(res.body.count, 7);
        assert.equal(res.body.hasMore, false);
        assert.equal(res.body.nextPageToken, null);
    });

    test('TC-06: token hỏng trả 400 INVALID_PAGE_TOKEN', async () => {
        const res = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?pageToken=abc`);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'INVALID_PAGE_TOKEN');
    });

    test('TC-07: token của hội thoại A dùng cho B bị từ chối', async () => {
        const first = await an.get(`/api/v1/conversations/${GROUP_ID}/messages`);
        const res = await an.get(`/api/v1/conversations/22222222-2222-2222-2222-222222222222/messages?pageToken=${first.body.nextPageToken}`);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'INVALID_PAGE_TOKEN');
    });

    test('token bị sửa (đổi cid nhưng giữ chữ ký) bị từ chối', async () => {
        const first = await an.get(`/api/v1/conversations/${GROUP_ID}/messages`);
        const data = JSON.parse(Buffer.from(first.body.nextPageToken, 'base64url').toString());
        data.cid = '22222222-2222-2222-2222-222222222222';
        const forged = Buffer.from(JSON.stringify(data)).toString('base64url');
        const res = await an.get(`/api/v1/conversations/22222222-2222-2222-2222-222222222222/messages?pageToken=${forged}`);
        assert.equal(res.status, 400);
    });

    test('limit ngoài 1–50 trả 400 INVALID_LIMIT', async () => {
        for (const limit of ['0', '51', 'abc']) {
            const res = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?limit=${limit}`);
            assert.equal(res.status, 400);
            assert.equal(res.body.error.code, 'INVALID_LIMIT');
        }
    });

    test('TC-12: hai tin cùng created_at đều được trả về', async () => {
        const items = (await readAllPages(an, GROUP_ID)).flatMap(p => p.items);
        const counts = {};
        items.forEach(i => (counts[i.createdAt] = (counts[i.createdAt] || 0) + 1));
        assert.ok(Object.values(counts).some(c => c === 2));
    });

    test('TC-14: gửi tin giữa lúc phân trang, trang sau vẫn nối tiếp đúng', async () => {
        const p1 = await an.get(`/api/v1/conversations/${GROUP_ID}/messages`);
        const p2 = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?pageToken=${p1.body.nextPageToken}`);
        await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Tin chen giua luc cuon' });
        const p3 = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?pageToken=${p2.body.nextPageToken}`);
        const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map(i => i.messageId);
        assert.equal(new Set(ids).size, 60);
        assert.ok(p2.body.items[19].createdAt >= p3.body.items[0].createdAt);
    });
});

// ================= Gui / thu hoi (TC-08 -> TC-11) =================
test.describe('Gửi và thu hồi tin nhắn', () => {
    let sent;

    test('TC-08: gửi tin, tin nằm đầu partition, hội thoại lên đầu danh sách mọi thành viên', async () => {
        const res = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: '  Demo bảo vệ đề tài 09  ' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        sent = res.body;
        assert.equal(sent.senderId, 'user01');
        assert.equal(sent.senderName, 'Nguyễn An');
        assert.equal(sent.content, 'Demo bảo vệ đề tài 09');

        const first = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?limit=1`);
        assert.equal(first.body.items[0].messageId, sent.messageId);

        for (const agent of [an, binh]) {
            const list = await agent.get('/api/v1/me/conversations');
            const top = list.body.data.find(c => !c.pinned);
            assert.equal(top.conversationId, GROUP_ID);
            assert.equal(top.lastMessagePreview, 'Demo bảo vệ đề tài 09');
            assert.equal(list.body.data.filter(c => c.conversationId === GROUP_ID).length, 1, 'không trùng dòng');
        }
    });

    test('created_at khớp thời gian trong TimeUUID message_id', async () => {
        const { TimeUuid } = require('cassandra-driver').types;
        assert.equal(TimeUuid.fromString(sent.messageId).getDate().toISOString(), sent.createdAt);
    });

    test('TC-09: nội dung rỗng hoặc quá 2000 ký tự bị 400', async () => {
        for (const content of ['   ', 'a'.repeat(2001), 123]) {
            const res = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content });
            assert.equal(res.status, 400);
            assert.equal(res.body.error.code, 'INVALID_CONTENT');
        }
    });

    test('đoạn trích tin cuối tối đa 50 ký tự kèm “…”', async () => {
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'x'.repeat(80) });
        const list = await an.get('/api/v1/me/conversations');
        const conv = list.body.data.find(c => c.conversationId === SMALL_ID);
        assert.equal(conv.lastMessagePreview, 'x'.repeat(50) + '…');
    });

    test('TC-11: thu hồi tin của người khác bị 403 FORBIDDEN_DELETE', async () => {
        const res = await binh.del(`/api/v1/conversations/${GROUP_ID}/messages/${sent.messageId}?createdAt=${encodeURIComponent(sent.createdAt)}`);
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'FORBIDDEN_DELETE');
    });

    test('thu hồi thiếu createdAt trả 400', async () => {
        const res = await an.del(`/api/v1/conversations/${GROUP_ID}/messages/${sent.messageId}`);
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'MISSING_CREATED_AT');
    });

    test('TC-10: thu hồi tin của mình theo khóa chính đầy đủ, không quét partition', async () => {
        ctx.fake.log.length = 0;
        const res = await an.del(`/api/v1/conversations/${GROUP_ID}/messages/${sent.messageId}?createdAt=${encodeURIComponent(sent.createdAt)}`);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.isDeleted, true);

        const reads = ctx.fake.log.filter(e => /^SELECT .* FROM messages_by_conversation/.test(e.query));
        reads.forEach(e => assert.ok(
            /created_at = \? AND message_id = \?/.test(e.query) || /LIMIT 1$/.test(e.query),
            `truy vấn quét partition: ${e.query}`
        ));
        const update = ctx.fake.log.find(e => /^UPDATE messages_by_conversation/.test(e.query));
        assert.match(update.query, /WHERE conversation_id = \? AND created_at = \? AND message_id = \?/);

        const page = await binh.get(`/api/v1/conversations/${GROUP_ID}/messages?limit=1`);
        assert.equal(page.body.items[0].messageId, sent.messageId, 'tin vẫn giữ vị trí');
        assert.equal(page.body.items[0].isDeleted, true);
        assert.equal(page.body.items[0].content, null);

        const list = await binh.get('/api/v1/me/conversations');
        assert.equal(list.body.data.find(c => c.conversationId === GROUP_ID).lastMessagePreview, 'Tin nhắn đã được thu hồi');
    });

    test('thu hồi lần hai là idempotent (200)', async () => {
        const res = await an.del(`/api/v1/conversations/${GROUP_ID}/messages/${sent.messageId}?createdAt=${encodeURIComponent(sent.createdAt)}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.alreadyDeleted, true);
    });

    test('thu hồi tin không tồn tại trả 404', async () => {
        const res = await an.del(`/api/v1/conversations/${GROUP_ID}/messages/${sent.messageId}?createdAt=2020-01-01T00:00:00.000Z`);
        assert.equal(res.status, 404);
        assert.equal(res.body.error.code, 'MESSAGE_NOT_FOUND');
    });

    test('FR-14: đếm số tin trong một partition', async () => {
        const res = await an.get(`/api/v1/conversations/${GROUP_ID}/stats`);
        assert.equal(res.status, 200);
        assert.ok(res.body.messageCount >= 200);
    });
});

// ================= Du lieu cu: thu hoi va doan trich =================
test.describe('Thu hồi trên dữ liệu kiểu cũ (last_message_at ≠ dòng đầu partition)', () => {
    // Mo phong dung trang thai that cua hoi thoai 1111: tin moi nhat da bi thu hoi tu truoc,
    // conversations.last_message_at = thoi diem tin CHUA thu hoi gan nhat, va dong danh sach
    // cua moi thanh vien dung khoa clustering do.
    const CID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const { TimeUuid } = require('cassandra-driver').types;
    const t0 = Date.now() - 3 * 3600 * 1000;
    const shown = new Date(t0 + 60000);
    const recalledHead = new Date(t0 + 120000);
    const older = new Date(t0);
    const ids = {};

    test.before(() => {
        const add = (key, at, sender, content, deleted) => {
            ids[key] = TimeUuid.fromDate(at).toString();
            ctx.fake.seedRow('messages_by_conversation', {
                conversation_id: CID, created_at: at, message_id: ids[key], sender_id: sender,
                sender_name: sender === 'user01' ? 'Nguyễn An' : 'Trần Bình',
                content: deleted ? null : content, message_type: 'TEXT', is_deleted: deleted
            });
        };
        add('older', older, 'user01', 'Tin cũ hơn', false);
        add('shown', shown, 'user01', 'Tin đang hiện ở danh sách', false);
        add('head', recalledHead, 'user01', null, true);
        ctx.fake.seedRow('conversations', {
            conversation_id: CID, conversation_name: 'Kiểu cũ', conversation_type: 'GROUP',
            participant_ids: ['user01', 'user02'], created_at: new Date(t0), last_message_at: shown
        });
        ['user01', 'user02'].forEach(u => ctx.fake.seedRow('conversations_by_user', {
            user_id: u, last_message_at: shown, conversation_id: CID, conversation_name: 'Kiểu cũ',
            conversation_type: 'GROUP', last_message_preview: 'Tin đang hiện ở danh sách', last_sender_name: 'Nguyễn An'
        }));
    });

    const rowsOf = user => [...ctx.fake.data.conversations_by_user.values()].filter(r => r.user_id === user && r.conversation_id === CID);

    test('thu hồi tin cũ hơn (không phải tin đang hiện): đoạn trích và khóa không đổi', async () => {
        const res = await an.del(`/api/v1/conversations/${CID}/messages/${ids.older}?createdAt=${encodeURIComponent(older.toISOString())}`);
        assert.equal(res.status, 200);
        const rows = rowsOf('user02');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].last_message_preview, 'Tin đang hiện ở danh sách');
    });

    test('thu hồi đúng tin đang hiện ở danh sách: đoạn trích đổi, last_message_at giữ nguyên, không sinh dòng mới', async () => {
        const res = await an.del(`/api/v1/conversations/${CID}/messages/${ids.shown}?createdAt=${encodeURIComponent(shown.toISOString())}`);
        assert.equal(res.status, 200);
        for (const u of ['user01', 'user02']) {
            const rows = rowsOf(u);
            assert.equal(rows.length, 1, 'không tạo dòng trùng');
            assert.equal(rows[0].last_message_preview, 'Tin nhắn đã được thu hồi');
            assert.equal(rows[0].last_message_at, shown.getTime(), 'khóa clustering không đổi');
        }
        const conv = [...ctx.fake.data.conversations.values()].find(r => r.conversation_id === CID);
        assert.equal(conv.last_message_at, shown.getTime(), 'không tự đồng bộ last_message_at theo dòng đầu partition');
    });

    test('gửi tin mới sau đó: xóa đúng dòng cũ theo last_message_at, chỉ còn một dòng mỗi người', async () => {
        const sent = await binh.post(`/api/v1/conversations/${CID}/messages`, { content: 'Tin mới' });
        assert.equal(sent.status, 201);
        for (const u of ['user01', 'user02']) {
            const rows = rowsOf(u);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].last_sender_id, 'user02');
        }
    });
});

test.describe('Chuẩn hóa tiếng Việt và dữ liệu đầu vào', () => {
    const { nameTokens } = require('../src/utils/text');

    test('NFC và NFD cho cùng token; Đ/đ và Ð/ð đều thành d', () => {
        const nfc = 'Nguyễn Thị Đặng'.normalize('NFC');
        const nfd = 'Nguyễn Thị Đặng'.normalize('NFD');
        assert.deepEqual(nameTokens(nfc), ['nguyen', 'thi', 'dang']);
        assert.deepEqual(nameTokens(nfd), nameTokens(nfc));
        assert.deepEqual(nameTokens('ÐẶNG ƯỚC Ơn'), ['dang', 'uoc', 'on']);
        assert.deepEqual(nameTokens('  A  B  '), [], 'từ 1 ký tự không tạo token');
    });

    test('tìm bằng chuỗi NFD vẫn ra người tên lưu dạng NFC', async () => {
        const q = encodeURIComponent('Đặng'.normalize('NFD'));
        const res = await an.get(`/api/v1/users/search?q=${q}`);
        assert.deepEqual(res.body.data.map(u => u.userId), ['user07']);
    });

    test('email chuẩn hóa nhất quán khi đăng nhập (hoa/thường, khoảng trắng)', async () => {
        const res = await ctx.agent().post('/api/v1/auth/login', { email: '  AN@ChatOTT.Demo ', password: PASSWORD });
        assert.equal(res.status, 200);
    });

    test('tên hiển thị chứa ký tự điều khiển bị từ chối', async () => {
        const res = await ctx.agent().post('/api/v1/auth/register',
            { displayName: 'Tên\u202eẩn', email: 'ctrl@example.com', password: 'Secret123', confirmPassword: 'Secret123' });
        assert.equal(res.status, 400);
        assert.ok(res.body.error.fields.displayName);
    });

    test('mật khẩu băm bằng scrypt tham số OWASP (N=16384, r=8, p=5); hash bị sửa tham số không làm treo máy', async () => {
        const { hashPassword, verifyPassword } = require('../src/utils/password');
        const h = await hashPassword('Secret123');
        assert.match(h, /^scrypt\$16384\$8\$5\$/);
        assert.equal(await verifyPassword('Secret123', h), true);
        assert.equal(await verifyPassword('Secret124', h), false);
        const evil = h.replace('scrypt$16384$8$5$', 'scrypt$1073741824$8$5$');
        assert.equal(await verifyPassword('Secret123', evil), false);
    });

    test('giới hạn đăng nhập theo IP chặn thử lần lượt nhiều email', async () => {
        const { rateLimit } = require('../src/middleware/security');
        const limiter = rateLimit({ windowMs: 60000, max: 3, key: req => req.ip });
        const results = [];
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => limiter({ ip: '10.0.0.9' }, { setHeader() {} }, err => { results.push(err ? err.status : 200); resolve(); }));
        }
        assert.deepEqual(results, [200, 200, 200, 429, 429]);
    });
});

// ================= Danh ba, 1-1, nhom =================
test.describe('Tìm người dùng, hội thoại 1-1 và nhóm', () => {
    test('tìm tên theo tiền tố từng từ qua users_by_name_token, không quét bảng users', async () => {
        ctx.fake.log.length = 0;
        const res = await an.get('/api/v1/users/search?q=ngu');
        assert.ok(res.body.data.some(u => u.userId === 'user01') === false, 'không trả về chính mình');
        const binhRes = await binh.get('/api/v1/users/search?q=NGUY');
        assert.deepEqual(binhRes.body.data.map(u => u.userId), ['user01']);
        assert.equal((await an.get('/api/v1/users/search?q=dang li')).body.data[0].userId, 'user07');
        assert.deepEqual((await an.get('/api/v1/users/search?q=inh')).body.data, [], 'không tìm chuỗi con giữa từ');
        assert.deepEqual((await an.get('/api/v1/users/search?q=l')).body.data, [], 'dưới 2 ký tự không tìm');
        assert.equal(ctx.fake.log.some(e => /FROM users$/.test(e.query)), false, 'không được quét toàn bảng users');
        const reads = ctx.fake.log.filter(e => /FROM users_by_name_token/.test(e.query));
        reads.forEach(e => assert.match(e.query, /WHERE token_prefix = \? AND name_token >= \? AND name_token < \?/));
    });

    test('người vừa đăng ký tìm được ngay theo tên (ghi cùng batch với hồ sơ)', async () => {
        const res = await an.get('/api/v1/users/search?q=ngo mai');
        assert.deepEqual(res.body.data.map(u => u.displayName), ['Ngô Mai']);
    });

    test('tìm theo tên không dấu và theo email chính xác', async () => {
        const byName = await an.get('/api/v1/users/search?q=dang linh');
        assert.equal(byName.status, 200);
        assert.deepEqual(byName.body.data.map(u => u.userId), ['user07']);
        assert.equal('email' in byName.body.data[0], false);

        const byEmail = await an.get('/api/v1/users/search?q=LINH@chatott.demo');
        assert.deepEqual(byEmail.body.data.map(u => u.userId), ['user07']);

        const self = await an.get('/api/v1/users/search?q=Nguyễn An');
        assert.equal(self.body.data.some(u => u.userId === 'user01'), false);
    });

    test('mở hội thoại 1-1 mới, mở lại (kể cả đồng thời) không tạo trùng', async () => {
        const results = await Promise.all([
            an.post('/api/v1/conversations/direct', { targetUserId: 'user07' }),
            an.post('/api/v1/conversations/direct', { targetUserId: 'user07' }),
            linh.post('/api/v1/conversations/direct', { targetUserId: 'user01' })
        ]);
        const ids = new Set(results.map(r => r.body.conversationId));
        assert.equal(ids.size, 1);
        assert.equal(results.filter(r => r.status === 201).length, 1);

        const cid = [...ids][0];
        const listLinh = await linh.get('/api/v1/me/conversations');
        const conv = listLinh.body.data.find(c => c.conversationId === cid);
        assert.equal(conv.displayName, 'Nguyễn An');

        const sent = await linh.post(`/api/v1/conversations/${cid}/messages`, { content: 'Chào An' });
        assert.equal(sent.status, 201);
    });

    test('không tự nhắn cho chính mình, không nhắn người không tồn tại', async () => {
        assert.equal((await an.post('/api/v1/conversations/direct', { targetUserId: 'user01' })).status, 400);
        assert.equal((await an.post('/api/v1/conversations/direct', { targetUserId: 'khong-co' })).status, 404);
    });

    let groupId;
    test('tạo nhóm, đổi tên, thêm/xóa thành viên, rời nhóm', async () => {
        const tooSmall = await an.post('/api/v1/conversations/groups', { name: 'Nhỏ', memberIds: ['user02'] });
        assert.equal(tooSmall.status, 400);

        const created = await an.post('/api/v1/conversations/groups', { name: 'Ôn thi NoSQL', memberIds: ['user02', 'user03'] });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        groupId = created.body.conversationId;

        const detail = await binh.get(`/api/v1/conversations/${groupId}`);
        assert.equal(detail.body.members.length, 3);
        assert.equal(detail.body.createdBy, 'user01');
        assert.equal(detail.body.canManageMembers, false);

        const notOwnerRename = await binh.patch(`/api/v1/conversations/${groupId}`, { name: 'Đổi lén' });
        assert.equal(notOwnerRename.status, 403);
        assert.equal(notOwnerRename.body.error.code, 'FORBIDDEN_MANAGE_GROUP');
        const renamed = await an.patch(`/api/v1/conversations/${groupId}`, { name: 'Ôn thi cuối kỳ' });
        assert.equal(renamed.status, 200);
        const listBinh = await binh.get('/api/v1/me/conversations');
        const row = listBinh.body.data.find(c => c.conversationId === groupId);
        assert.equal(row.conversationName, 'Ôn thi cuối kỳ');
        assert.match(row.lastMessagePreview, /đổi tên nhóm/);

        const added = await an.post(`/api/v1/conversations/${groupId}/members`, { memberIds: ['user07'] });
        assert.equal(added.status, 200);
        assert.equal(added.body.members.length, 4);
        const linhRead = await linh.get(`/api/v1/conversations/${groupId}/messages`);
        assert.equal(linhRead.status, 200);

        const notOwner = await binh.del(`/api/v1/conversations/${groupId}/members/user07`);
        assert.equal(notOwner.status, 403);
        assert.equal(notOwner.body.error.code, 'FORBIDDEN_MANAGE_GROUP');

        const removed = await an.del(`/api/v1/conversations/${groupId}/members/user07`);
        assert.equal(removed.status, 200);
        const blocked = await linh.get(`/api/v1/conversations/${groupId}/messages`);
        assert.equal(blocked.status, 403);
        const linhList = await linh.get('/api/v1/me/conversations');
        assert.equal(linhList.body.data.some(c => c.conversationId === groupId), false);

        const left = await binh.del(`/api/v1/conversations/${groupId}/members/user02`);
        assert.equal(left.status, 200);
        assert.equal(left.body.left, true);
        const sendAfterLeave = await binh.post(`/api/v1/conversations/${groupId}/messages`, { content: 'còn không?' });
        assert.equal(sendAfterLeave.status, 403);
    });

    test('nhóm cũ chưa có trưởng nhóm (created_by = null): không ai xóa được thành viên, vẫn tự rời được', async () => {
        const OLD_GROUP = '22222222-2222-2222-2222-222222222222';
        const detail = await an.get(`/api/v1/conversations/${OLD_GROUP}`);
        assert.equal(detail.body.createdBy, null);
        assert.equal(detail.body.ownerKnown, false);
        assert.equal(detail.body.canManageMembers, false);
        const res = await an.del(`/api/v1/conversations/${OLD_GROUP}/members/user06`);
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'GROUP_OWNER_UNKNOWN');
        const rename = await an.patch(`/api/v1/conversations/${OLD_GROUP}`, { name: 'Đổi tên' });
        assert.equal(rename.status, 403);
        assert.equal(rename.body.error.code, 'GROUP_OWNER_UNKNOWN');
        assert.equal(detail.body.canRename, false);
        const outsider = await linh.patch(`/api/v1/conversations/${OLD_GROUP}`, { name: 'x' });
        assert.equal(outsider.status, 403);
        assert.equal(outsider.body.error.code, 'NOT_A_MEMBER', 'người ngoài: lỗi không phải thành viên, không phải lỗi quyền chủ nhóm');
        const missing = await an.patch('/api/v1/conversations/12345678-1234-1234-1234-123456789abc', { name: 'x' });
        assert.equal(missing.status, 404, 'tài nguyên không tồn tại khác với thiếu quyền');
        const left = await binh.del(`/api/v1/conversations/${OLD_GROUP}/members/user02`);
        assert.equal(left.status, 200);
        const row = [...ctx.fake.data.conversations.values()].find(r => r.conversation_id === OLD_GROUP);
        assert.equal(row.created_by ?? null, null, 'không tự gán trưởng nhóm khi có người rời');
    });

    test('tin hệ thống của nhóm không thu hồi được', async () => {
        const page = await an.get(`/api/v1/conversations/${groupId}/messages`);
        const sys = page.body.items.find(i => i.messageType === 'SYSTEM');
        const res = await an.del(`/api/v1/conversations/${groupId}/messages/${sys.messageId}?createdAt=${encodeURIComponent(sys.createdAt)}`);
        assert.equal(res.status, 403);
    });
});

// ================= Chua doc / ghim =================
test.describe('Chưa đọc và ghim hội thoại', () => {
    test('tin người khác gửi làm hội thoại chưa đọc; đánh dấu đã đọc thì hết', async () => {
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Bạn ơi' });
        let list = await an.get('/api/v1/me/conversations');
        assert.equal(list.body.data.find(c => c.conversationId === SMALL_ID).unread, true);
        const listBinh = await binh.get('/api/v1/me/conversations');
        assert.equal(listBinh.body.data.find(c => c.conversationId === SMALL_ID).unread, false);

        await an.post(`/api/v1/conversations/${SMALL_ID}/read`);
        list = await an.get('/api/v1/me/conversations');
        assert.equal(list.body.data.find(c => c.conversationId === SMALL_ID).unread, false);
    });

    test('cập nhật last_read_at và pinned độc lập, không làm mất trường còn lại', async () => {
        const CID = '55555555-5555-5555-5555-555555555555';
        await an.put(`/api/v1/conversations/${CID}/pin`, { pinned: true });
        await an.post(`/api/v1/conversations/${CID}/read`);
        let row = [...ctx.fake.data.conversation_state_by_user.values()].find(r => r.user_id === 'user01' && r.conversation_id === CID);
        assert.equal(row.pinned, true);
        assert.ok(row.last_read_at);
        const readAt = row.last_read_at;
        await an.put(`/api/v1/conversations/${CID}/pin`, { pinned: false });
        row = [...ctx.fake.data.conversation_state_by_user.values()].find(r => r.user_id === 'user01' && r.conversation_id === CID);
        assert.equal(row.pinned, false);
        assert.equal(row.last_read_at, readAt);
    });

    test('ghim đưa hội thoại lên đầu danh sách', async () => {
        const res = await an.put('/api/v1/conversations/88888888-8888-8888-8888-888888888888/pin', { pinned: true });
        assert.equal(res.status, 200);
        const list = await an.get('/api/v1/me/conversations');
        assert.equal(list.body.data[0].conversationId, '88888888-8888-8888-8888-888888888888');
        assert.equal(list.body.data[0].pinned, true);
        await an.put('/api/v1/conversations/88888888-8888-8888-8888-888888888888/pin', { pinned: false });
    });
});

// ================= Realtime =================
test.describe('Realtime (SSE)', () => {
    test('thành viên nhận sự kiện message:new ngay khi có tin mới', async () => {
        const controller = new AbortController();
        const res = await fetch(`${ctx.baseUrl}/api/v1/events`, {
            headers: { Cookie: `chatott_sid=${binh.cookies.chatott_sid}` },
            signal: controller.signal
        });
        assert.equal(res.status, 200);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const waitFor = async needle => {
            const deadline = Date.now() + 3000;
            while (!buffer.includes(needle) && Date.now() < deadline) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value);
            }
            return buffer.includes(needle);
        };
        assert.ok(await waitFor('event: ready'));
        await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Tin realtime' });
        assert.ok(await waitFor('Tin realtime'));
        assert.ok(buffer.includes('event: message:new'));
        controller.abort();
    });

    test('SSE yêu cầu đăng nhập', async () => {
        const res = await ctx.agent().get('/api/v1/events');
        assert.equal(res.status, 401);
    });
});

// ================= Loi CSDL va ra soat ma nguon =================
test.describe('Xử lý lỗi và rà soát thiết kế truy vấn', () => {
    test('Cassandra không phản hồi trả 503 DB_UNAVAILABLE', async () => {
        ctx.fake.down = true;
        try {
            const res = await an.get(`/api/v1/conversations/${GROUP_ID}/messages`);
            assert.equal(res.status, 503);
            assert.equal(res.body.error.code, 'DB_UNAVAILABLE');
        } finally {
            ctx.fake.down = false;
        }
    });

    test('mã nguồn backend không dùng ALLOW FILTERING, OFFSET hay secondary index', () => {
        const dir = path.resolve(__dirname, '../src');
        const files = [];
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
        });
        walk(dir);
        for (const f of files) {
            const code = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
            assert.doesNotMatch(code, /ALLOW FILTERING/i, f);
            assert.doesNotMatch(code, /\bOFFSET\s+\d|\bOFFSET\s+\?/i, f);
            assert.doesNotMatch(code, /CREATE\s+(CUSTOM\s+)?INDEX/i, f);
        }
    });
});
