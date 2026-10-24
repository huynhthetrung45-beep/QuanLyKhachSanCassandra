// Tim kiem trong cuoc tro chuyen + cua so lich su quanh mot tin (nhay toi ket qua) - Cassandra GIA LAP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TimeUuid } = require('cassandra-driver').types;
const { startTestServer, linkAccount, GROUP_ID, SMALL_ID } = require('./helpers');

const PW = 'MatKhau123';
let ctx, an, binh, giang;
const login = async email => {
    const a = ctx.agent();
    assert.equal((await a.post('/api/v1/auth/login', { email, password: PW })).status, 200);
    return a;
};
const base = cid => `/api/v1/conversations/${cid}/messages`;
const cur = m => encodeURIComponent(`${m.createdAt}_${m.messageId}`);

async function allMessages(agent, cid) {
    const out = [];
    let token = null;
    do {
        const page = (await agent.get(base(cid) + (token ? `?pageToken=${encodeURIComponent(token)}` : ''))).body;
        out.push(...page.items);
        token = page.nextPageToken;
    } while (token);
    return out;
}

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user05', 'giang']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    giang = await login('giang@chatott.demo');
});
test.after(() => ctx.server.close());

test('around: trả về đúng tin đích + ngữ cảnh hai phía, khớp thứ tự lịch sử đầy đủ', async () => {
    const all = await allMessages(an, GROUP_ID);
    assert.ok(all.length >= 150);
    const idx = 150;
    const t = all[idx];
    const r = await an.get(`${base(GROUP_ID)}?around=${cur(t)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.targetMessageId, t.messageId);
    const ids = r.body.items.map(m => m.messageId);
    assert.deepEqual(ids, all.slice(idx - 10, idx + 16).map(m => m.messageId));
    assert.equal(r.body.hasNewer, true);
    assert.equal(r.body.hasOlder, true);
});

test('before/after: đi hết hai phía từ cửa sổ không trùng, không sót', async () => {
    const all = await allMessages(an, GROUP_ID);
    const t = all[120];
    const w = (await an.get(`${base(GROUP_ID)}?around=${cur(t)}`)).body;
    const seen = w.items.map(m => m.messageId);
    let older = w.olderCursor;
    while (older) {
        const p = (await an.get(`${base(GROUP_ID)}?before=${encodeURIComponent(older)}&limit=17`)).body;
        seen.push(...p.items.map(m => m.messageId));
        older = p.hasOlder ? p.olderCursor : null;
    }
    let newer = w.newerCursor;
    while (newer) {
        const p = (await an.get(`${base(GROUP_ID)}?after=${encodeURIComponent(newer)}&limit=13`)).body;
        seen.unshift(...p.items.map(m => m.messageId));
        newer = p.hasNewer ? p.newerCursor : null;
    }
    assert.equal(new Set(seen).size, seen.length, 'không trùng');
    assert.deepEqual(seen, all.map(m => m.messageId), 'đủ và đúng thứ tự');
});

test('các tin cùng mili-giây được tách đúng theo message_id', async () => {
    const at = new Date(Date.UTC(2020, 0, 1, 0, 0, 0, 0));
    const ids = [0, 1, 2, 3].map(i => TimeUuid.fromDate(at, i).toString());
    for (const id of ids) {
        ctx.fake.seedRow('messages_by_conversation', {
            conversation_id: SMALL_ID, created_at: at, message_id: id, sender_id: 'user02', sender_name: 'Trần Bình',
            content: 'trùng giờ ' + id.slice(0, 4), message_type: 'TEXT', is_deleted: false
        });
    }
    const all = await allMessages(an, SMALL_ID);
    const pos = all.findIndex(m => m.messageId === ids[1]);
    const w = (await an.get(`${base(SMALL_ID)}?around=${encodeURIComponent(`${at.toISOString()}_${ids[1]}`)}`)).body;
    assert.equal(w.targetMessageId, ids[1]);
    assert.deepEqual(w.items.map(m => m.messageId), all.slice(Math.max(0, pos - 10), pos + 16).map(m => m.messageId));
    const before = (await an.get(`${base(SMALL_ID)}?before=${encodeURIComponent(`${at.toISOString()}_${ids[2]}`)}&limit=50`)).body;
    assert.deepEqual(before.items.map(m => m.messageId), all.slice(all.findIndex(m => m.messageId === ids[2]) + 1).map(m => m.messageId));
});

test('quyền: người ngoài hội thoại không mở được cửa sổ; tin đã ẩn phía tôi / con trỏ sai bị từ chối', async () => {
    const all = await allMessages(an, SMALL_ID);
    const t = all[2];
    const outsider = await giang.get(`${base(SMALL_ID)}?around=${cur(t)}`);
    assert.ok([403, 404].includes(outsider.status));
    assert.equal(JSON.stringify(outsider.body).includes(t.content || '§'), false);
    assert.equal((await an.get(`${base(SMALL_ID)}?around=abc`)).status, 400);
    const fake = TimeUuid.now().toString();
    assert.equal((await an.get(`${base(SMALL_ID)}?around=${encodeURIComponent(`${new Date().toISOString()}_${fake}`)}`)).status, 404);
    const mine = (await an.post(base(SMALL_ID), { content: 'tin sẽ ẩn phía An' })).body;
    const hid = await an.post(`${base(SMALL_ID)}/${mine.messageId}/hide`, { createdAt: mine.createdAt });
    assert.ok(hid.status < 300, 'ẩn phía tôi: ' + hid.status);
    {
        assert.equal((await an.get(`${base(SMALL_ID)}?around=${cur(mine)}`)).status, 404);
        assert.equal((await binh.get(`${base(SMALL_ID)}?around=${cur(mine)}`)).status, 200);
    }
});

test('tìm trong hội thoại: kết hợp từ khóa + người gửi + ngày, chỉ trong hội thoại đang chọn, phân trang không lặp', async () => {
    for (let i = 0; i < 25; i++) await an.post(base(SMALL_ID), { content: `báo cáo tuần số ${i}` });
    await binh.post(base(SMALL_ID), { content: 'báo cáo của Bình' });
    await an.post(base(GROUP_ID), { content: 'báo cáo ở nhóm khác' });
    const today = new Date().toISOString().slice(0, 10);
    const q = `/api/v1/search/messages?conversationId=${SMALL_ID}&q=${encodeURIComponent('bao cao')}`;
    const p1 = (await an.get(q)).body;
    assert.equal(p1.items.length, 20);
    assert.ok(p1.items.every(i => i.conversationId === SMALL_ID));
    const p2 = (await an.get(`${q}&cursor=${p1.nextCursor}`)).body;
    const ids = [...p1.items, ...p2.items].map(i => i.messageId);
    assert.equal(ids.length, 26);
    assert.equal(new Set(ids).size, 26);
    const bySender = (await an.get(`${q}&senderId=user02&from=${today}&to=${today}`)).body;
    assert.deepEqual(bySender.items.map(i => i.snippet), ['báo cáo của Bình']);
    const none = (await an.get(`${q}&from=2001-01-01&to=2001-01-02`)).body;
    assert.equal(none.items.length, 0);
    // ket qua -> cua so chua dung tin do
    const hit = p2.items[0];
    const w = (await an.get(`${base(SMALL_ID)}?around=${encodeURIComponent(`${hit.createdAt}_${hit.messageId}`)}`)).body;
    assert.ok(w.items.some(m => m.messageId === hit.messageId));
    assert.equal((await giang.get(q)).status === 200 && (await giang.get(q)).body.items.length > 0, false);
});
