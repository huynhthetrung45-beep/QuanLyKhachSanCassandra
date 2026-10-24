// Ghim tin nhan trong hoi thoai - Cassandra GIA LAP (khong chung minh Cassandra that).
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SEND_RATE_LIMIT = '1000';
const { startTestServer, linkAccount, SMALL_ID } = require('./helpers');

const PW = 'MatKhau123';
let ctx, an, binh, chi, giang, groupId;
const login = async email => {
    const a = ctx.agent();
    assert.equal((await a.post('/api/v1/auth/login', { email, password: PW })).status, 200);
    return a;
};
function sse(agent) {
    const controller = new AbortController();
    let buffer = '';
    fetch(`${ctx.baseUrl}/api/v1/events`, { headers: { Cookie: `chatott_sid=${agent.cookies.chatott_sid}` }, signal: controller.signal })
        .then(async res => {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            try { for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += dec.decode(value); } } catch { /* dong */ }
        }).catch(() => {});
    return {
        async waitFor(needle, ms = 1500) {
            const until = Date.now() + ms;
            while (!buffer.includes(needle) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
            return buffer.includes(needle);
        },
        count: needle => buffer.split(needle).length - 1,
        close() { controller.abort(); }
    };
}
const send = (agent, cid, content) => agent.post(`/api/v1/conversations/${cid}/messages`, { content }).then(r => r.body);
const pin = (agent, cid, m) => agent.put(`/api/v1/conversations/${cid}/messages/${m.messageId}/pin`, { createdAt: m.createdAt });
const unpin = (agent, cid, m) => agent.del(`/api/v1/conversations/${cid}/messages/${m.messageId}/pin`);
const list = (agent, cid) => agent.get(`/api/v1/conversations/${cid}/pins`);

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user05', 'giang']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    chi = await login('chi@chatott.demo');
    giang = await login('giang@chatott.demo');
    const g = await an.post('/api/v1/conversations/groups', { name: 'Nhóm ghim', memberIds: ['user02', 'user03'] });
    assert.ok(g.status < 300, 'tạo nhóm: ' + g.status);
    groupId = g.body.conversationId;
});
test.after(() => ctx.server.close());

test('ghim nhiều tin: tin đại diện = ghim gần nhất, tên người gửi lấy từ tài khoản, retry không trùng', async () => {
    const m1 = await send(binh, groupId, 'Nhắc mọi người nộp báo cáo trước thứ sáu nhé');
    const m2 = await send(an, groupId, 'Link tài liệu: https://example.com/doc');
    const m3 = await send(chi, groupId, 'Họp lúc 9h');
    assert.equal((await pin(chi, groupId, m1)).status, 200);
    await new Promise(r => setTimeout(r, 5));
    assert.equal((await pin(binh, groupId, m2)).status, 200);
    await new Promise(r => setTimeout(r, 5));
    const r3 = await pin(an, groupId, m3);
    assert.equal(r3.body.total, 3);
    const again = await pin(an, groupId, m3);
    assert.equal(again.body.alreadyPinned, true);
    const l = (await list(binh, groupId)).body;
    assert.equal(l.total, 3);
    assert.deepEqual(l.items.map(i => i.messageId), [m3.messageId, m2.messageId, m1.messageId]);
    assert.equal(l.items[2].senderName, 'Trần Bình');
    assert.equal(l.items[2].pinnedBy.displayName, 'Lê Chi');
    assert.equal(l.items[0].preview, 'Họp lúc 9h');
    assert.ok(l.items[0].pinnedAt);
});

test('quyền: người ngoài không đọc/ghim/bỏ ghim; bỏ ghim chỉ người ghim hoặc trưởng nhóm', async () => {
    const l = (await list(an, groupId)).body;
    const pinnedByChi = l.items.find(i => i.pinnedBy.userId === 'user03');
    const pinnedByBinh = l.items.find(i => i.pinnedBy.userId === 'user02');
    for (const r of [await list(giang, groupId), await pin(giang, groupId, pinnedByChi), await unpin(giang, groupId, pinnedByChi)]) {
        assert.equal(r.status, 403);
        assert.equal(JSON.stringify(r.body).includes('báo cáo'), false);
    }
    // Binh (khong phai truong nhom, khong phai nguoi ghim) -> 403, du lieu khong doi
    const asBinh = (await list(binh, groupId)).body.items.find(i => i.messageId === pinnedByChi.messageId);
    assert.equal(asBinh.canUnpin, false);
    assert.equal((await unpin(binh, groupId, pinnedByChi)).status, 403);
    assert.equal((await list(an, groupId)).body.total, 3);
    // Binh bo ghim tin chinh minh ghim -> duoc; An (truong nhom) bo ghim tin Chi ghim -> duoc
    const ub = await unpin(binh, groupId, pinnedByBinh);
    assert.equal(ub.status, 200, JSON.stringify(ub.body));
    assert.equal(ub.body.total, 2);
    assert.equal((await unpin(an, groupId, pinnedByChi)).body.total, 1);
    assert.equal((await unpin(an, groupId, pinnedByChi)).body.alreadyUnpinned, true);
});

test('hội thoại 1-1: cả hai người đều bỏ ghim được; không ghim tin hệ thống / tin đã thu hồi; thu hồi tự bỏ ghim', async () => {
    const m = await send(an, SMALL_ID, 'tin 1-1 cần ghim');
    await pin(an, SMALL_ID, m);
    assert.equal((await list(binh, SMALL_ID)).body.items[0].canUnpin, true);
    const recalled = await send(an, SMALL_ID, 'sẽ thu hồi');
    await pin(binh, SMALL_ID, recalled);
    assert.equal((await list(an, SMALL_ID)).body.total, 2);
    const del = await an.del(`/api/v1/conversations/${SMALL_ID}/messages/${recalled.messageId}?createdAt=${encodeURIComponent(recalled.createdAt)}`);
    assert.ok(del.status < 300, 'thu hồi: ' + del.status);
    const after = (await list(binh, SMALL_ID)).body;
    assert.deepEqual(after.items.map(i => i.preview), ['tin 1-1 cần ghim']);
    assert.equal(JSON.stringify(after).includes('sẽ thu hồi'), false);
    assert.equal((await pin(an, SMALL_ID, recalled)).status, 400);
    assert.equal((await binh.put(`/api/v1/conversations/${SMALL_ID}/messages/${m.messageId}/pin`, { createdAt: 'x' })).status, 400);
});

test('realtime: chỉ thành viên nhận sự kiện ghim/bỏ ghim, mỗi thao tác đúng một lần', async () => {
    const sb = sse(binh);
    const sg = sse(giang);
    await new Promise(r => setTimeout(r, 150));
    const m = await send(chi, groupId, 'tin realtime');
    await pin(chi, groupId, m);
    await pin(chi, groupId, m); // retry: khong phat lai
    assert.equal(await sb.waitFor(`"messageId":"${m.messageId}"`), true);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sb.count('event: message:pins'), 1);
    await unpin(chi, groupId, m);
    assert.equal(await sb.waitFor('"action":"unpinned"'), true);
    assert.equal(sg.count('message:pins'), 0);
    sb.close(); sg.close();
});
