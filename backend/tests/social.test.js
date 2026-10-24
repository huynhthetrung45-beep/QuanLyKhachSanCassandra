// Kiem thu ho so / ket ban / chan tren Cassandra GIA LAP. Khong chung minh tich hop Cassandra that.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, linkAccount, SMALL_ID } = require('./helpers');

const PW = 'MatKhau123';
let ctx, an, binh, chi, dung;

async function login(email) {
    const agent = ctx.agent();
    const r = await agent.post('/api/v1/auth/login', { email, password: PW });
    assert.equal(r.status, 200);
    return agent;
}
const rel = () => [...ctx.fake.data.relationships.values()];
const status = async (agent, userId) => (await agent.get(`/api/v1/users/${userId}/profile`)).body.relationship;

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user04', 'dung']]) {
        await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    }
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    chi = await login('chi@chatott.demo');
    dung = await login('dung@chatott.demo');
});
test.after(() => ctx.server.close());

test.describe('Hồ sơ', () => {
    test('sửa hồ sơ của mình; hồ sơ công khai không lộ email', async () => {
        const r = await an.patch('/api/v1/me/profile', { username: 'nguyen.an', bio: 'Sinh viên NoSQL' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.username, 'nguyen.an');
        const view = await binh.get('/api/v1/users/user01/profile');
        assert.equal(view.body.bio, 'Sinh viên NoSQL');
        assert.equal(JSON.stringify(view.body).includes('@'), false);
        assert.equal('email' in view.body, false);
    });

    test('username trùng bị 409; đổi username thì nhả tên cũ', async () => {
        const dup = await binh.patch('/api/v1/me/profile', { username: 'nguyen.an' });
        assert.equal(dup.status, 409);
        assert.equal((await an.patch('/api/v1/me/profile', { username: 'an.nguyen' })).status, 200);
        assert.equal((await binh.patch('/api/v1/me/profile', { username: 'nguyen.an' })).status, 200);
    });

    test('dữ liệu hồ sơ không hợp lệ bị 400; không có API sửa hồ sơ người khác; chưa đăng nhập 401', async () => {
        assert.equal((await an.patch('/api/v1/me/profile', { username: 'A B' })).status, 400);
        assert.equal((await an.patch('/api/v1/me/profile', { bio: 'x'.repeat(301) })).status, 400);
        assert.equal((await an.patch('/api/v1/users/user02/profile', { bio: 'hack' })).status, 404);
        assert.equal((await an.patch('/api/v1/me/profile', { userId: 'user02', bio: 'hack' })).status, 403);
        assert.equal((await ctx.agent().get('/api/v1/users/user01/profile')).status, 401);
    });
});

test.describe('Kết bạn', () => {
    test('gửi -> chấp nhận -> bạn bè ở cả hai phía; gửi trùng không tạo bản ghi thứ hai', async () => {
        assert.equal((await an.post('/api/v1/friends/requests', { targetUserId: 'user02' })).status, 201);
        const again = await an.post('/api/v1/friends/requests', { targetUserId: 'user02' });
        assert.equal(again.body.changed, false);
        assert.equal(rel().length, 1);
        assert.deepEqual((await an.get('/api/v1/friends/requests?direction=outgoing')).body.data.map(u => u.userId), ['user02']);
        assert.deepEqual((await binh.get('/api/v1/friends/requests')).body.data.map(u => u.userId), ['user01']);
        assert.equal(await status(an, 'user02'), 'OUTGOING');
        assert.equal(await status(binh, 'user01'), 'INCOMING');

        const ok = await binh.post('/api/v1/friends/requests/user01/accept');
        assert.equal(ok.body.status, 'FRIENDS');
        assert.deepEqual((await an.get('/api/v1/friends')).body.data.map(u => u.userId), ['user02']);
        assert.deepEqual((await binh.get('/api/v1/friends')).body.data.map(u => u.userId), ['user01']);
        assert.equal((await binh.get('/api/v1/friends/requests')).body.data.length, 0);
        assert.equal((await binh.post('/api/v1/friends/requests/user01/accept')).body.changed, false, 'chấp nhận lại = không đổi');
    });

    test('hai bên gửi cùng lúc: chỉ một quan hệ, kết quả là bạn bè', async () => {
        const [a, b] = await Promise.all([
            chi.post('/api/v1/friends/requests', { targetUserId: 'user04' }),
            dung.post('/api/v1/friends/requests', { targetUserId: 'user03' })
        ]);
        assert.ok([a.status, b.status].every(s => s === 201 || s === 200), JSON.stringify([a.body, b.body]));
        const pair = rel().filter(r => r.pair_key === 'user03|user04');
        assert.equal(pair.length, 1);
        assert.equal(pair[0].status, 'FRIENDS');
    });

    test('từ chối và hủy lời mời; người thứ ba không chấp nhận hộ được', async () => {
        await an.post('/api/v1/friends/requests', { targetUserId: 'user03' });
        assert.equal((await dung.post('/api/v1/friends/requests/user01/accept')).status, 404, 'không có lời mời cho Dũng');
        assert.equal((await chi.post('/api/v1/friends/requests/user01/decline')).status, 200);
        assert.equal(await status(an, 'user03'), 'NONE');
        await an.post('/api/v1/friends/requests', { targetUserId: 'user03' });
        assert.equal((await chi.del('/api/v1/friends/requests/user01')).status, 404, 'người nhận không "hủy" lời mời của người gửi');
        assert.equal((await an.del('/api/v1/friends/requests/user03')).status, 200);
        assert.equal((await chi.get('/api/v1/friends/requests')).body.data.length, 0);
    });

    test('tự kết bạn, người không tồn tại, id sai định dạng', async () => {
        assert.equal((await an.post('/api/v1/friends/requests', { targetUserId: 'user01' })).status, 400);
        assert.equal((await an.post('/api/v1/friends/requests', { targetUserId: 'user99' })).status, 404);
        assert.equal((await an.post('/api/v1/friends/requests', { targetUserId: '../x' })).status, 400);
    });

    test('xóa kết bạn ở cả hai phía nhưng KHÔNG xóa lịch sử chat', async () => {
        const msgsBefore = [...ctx.fake.data.messages_by_conversation.values()].filter(m => m.conversation_id.toString() === SMALL_ID).length;
        assert.equal((await an.del('/api/v1/friends/user02')).status, 200);
        assert.equal((await binh.get('/api/v1/friends')).body.data.length, 0);
        assert.equal((await an.del('/api/v1/friends/user02')).status, 404);
        const page = await an.get(`/api/v1/conversations/${SMALL_ID}/messages`);
        assert.equal(page.status, 200);
        const msgsAfter = [...ctx.fake.data.messages_by_conversation.values()].filter(m => m.conversation_id.toString() === SMALL_ID).length;
        assert.equal(msgsAfter, msgsBefore);
    });

    test('mọi lệnh ghi vào relationships đều là LWT', () => {
        const writes = ctx.fake.log.filter(e => /^(INSERT INTO|UPDATE|DELETE FROM) relationships/.test(e.query));
        assert.ok(writes.length >= 6);
        writes.forEach(e => assert.match(e.query, / IF /, e.query));
    });
});

test.describe('Chặn', () => {
    test('chặn hủy quan hệ, chặn lời mời 2 chiều, ẩn khỏi tìm kiếm và hồ sơ của người bị chặn', async () => {
        await chi.post('/api/v1/friends/requests', { targetUserId: 'user01' });
        assert.equal((await an.post('/api/v1/blocks', { targetUserId: 'user03' })).status, 201);
        assert.equal(await status(an, 'user03'), 'BLOCKED');
        assert.equal((await an.get('/api/v1/friends/requests')).body.data.length, 0, 'lời mời đến bị hủy');
        const fromChi = await chi.post('/api/v1/friends/requests', { targetUserId: 'user01' });
        assert.equal(fromChi.status, 403);
        assert.equal(fromChi.body.error.code, 'BLOCKED_BY_USER');
        assert.equal((await an.post('/api/v1/friends/requests', { targetUserId: 'user03' })).body.error.code, 'USER_BLOCKED');
        assert.equal((await chi.get('/api/v1/users/user01/profile')).status, 404);
        const search = await chi.get('/api/v1/users/search?q=An');
        assert.equal(search.body.data.some(u => u.userId === 'user01'), false);
        assert.deepEqual((await an.get('/api/v1/blocks')).body.data.map(u => u.userId), ['user03']);
    });

    test('chặn áp dụng cho chat 1-1: không mở mới, không gửi, không chuyển tiếp; lịch sử vẫn đọc được', async () => {
        const cid = '55555555-5555-5555-5555-555555555555'; // An - Chi
        const send = await chi.post(`/api/v1/conversations/${cid}/messages`, { content: 'xin chào' });
        assert.equal(send.status, 403);
        assert.equal((await an.post(`/api/v1/conversations/${cid}/messages`, { content: 'x' })).status, 403);
        assert.equal((await chi.post('/api/v1/conversations/direct', { targetUserId: 'user01' })).status, 403);
        assert.equal((await chi.get(`/api/v1/conversations/${cid}/messages`)).status, 200);
        const src = (await chi.get('/api/v1/conversations/22222222-2222-2222-2222-222222222222/messages')).body.items[0];
        const fw = await chi.post(`/api/v1/conversations/${cid}/forward`, {
            source: { conversationId: '22222222-2222-2222-2222-222222222222', messageId: src.messageId, createdAt: src.createdAt }
        });
        assert.equal(fw.status, 403);
    });

    test('nhóm chat không bị ảnh hưởng bởi chặn (chính sách)', async () => {
        const r = await chi.post('/api/v1/conversations/22222222-2222-2222-2222-222222222222/messages', { content: 'trong nhóm' });
        assert.equal(r.status, 201);
    });

    test('bỏ chặn: nhắn tin và kết bạn lại được', async () => {
        assert.equal((await an.del('/api/v1/blocks/user03')).status, 200);
        assert.equal((await chi.post('/api/v1/conversations/55555555-5555-5555-5555-555555555555/messages', { content: 'đã bỏ chặn' })).status, 201);
        assert.equal((await chi.post('/api/v1/friends/requests', { targetUserId: 'user01' })).status, 201);
    });
});

test('tìm kiếm trả kèm trạng thái quan hệ', async () => {
    const r = await an.get('/api/v1/users/search?q=Chi');
    const c = r.body.data.find(u => u.userId === 'user03');
    assert.equal(c.relationship, 'INCOMING');
});
