// Tha cam xuc cho binh luan bai viet (migration 016).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, linkAccount } = require('./helpers');

let ctx, an, binh, chi;
const login = async email => {
    const a = ctx.agent();
    const r = await a.post('/api/v1/auth/login', { email, password: 'MatKhau123' });
    assert.equal(r.status, 200);
    return a;
};

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, 'MatKhau123');
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    chi = await login('chi@chatott.demo');
});
test.after(() => ctx.server.close());

test('thả, đổi, gỡ cảm xúc bình luận; danh sách bình luận có tổng hợp; thông báo 1 lần cho người viết', async () => {
    const post = await an.post('/api/v1/posts', { privacy: 'PUBLIC', content: 'Bài công khai' });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const pid = post.body.postId;
    const c = await binh.post(`/api/v1/posts/${pid}/comments`, { content: 'Bình luận của Bình' });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const cid = c.body.comment.commentId;

    const r1 = await chi.put(`/api/v1/posts/${pid}/comments/${cid}/reaction`, { reaction: 'LOVE' });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.reactions, { total: 1, counts: { LOVE: 1 }, top: ['LOVE'], mine: 'LOVE' });
    await an.put(`/api/v1/posts/${pid}/comments/${cid}/reaction`, { reaction: 'LIKE' });
    // Doi cam xuc: van 1 luot cua Chi.
    const r2 = await chi.put(`/api/v1/posts/${pid}/comments/${cid}/reaction`, { reaction: 'HAHA' });
    assert.equal(r2.body.reactions.total, 2);
    assert.deepEqual(r2.body.reactions.counts, { LIKE: 1, HAHA: 1 });

    // GET danh sach binh luan: moi binh luan co "reactions" theo goc nhin nguoi xem.
    const list = await binh.get(`/api/v1/posts/${pid}/comments`);
    const item = list.body.items.find(x => x.commentId === cid);
    assert.equal(item.reactions.total, 2);
    assert.equal(item.reactions.mine, null);
    const asChi = (await chi.get(`/api/v1/posts/${pid}/comments`)).body.items.find(x => x.commentId === cid);
    assert.equal(asChi.reactions.mine, 'HAHA');

    // Thong bao cho Binh: Chi va An, moi nguoi 1 lan (doi cam xuc khong bao lai).
    const notes = (await binh.get('/api/v1/notifications')).body.items.filter(n => n.type === 'COMMENT_REACTION');
    assert.equal(notes.length, 2);
    assert.ok(notes.every(n => n.postId === pid));

    // Tu tha cam xuc binh luan cua minh: khong thong bao cho chinh minh.
    await binh.put(`/api/v1/posts/${pid}/comments/${cid}/reaction`, { reaction: 'LIKE' });
    assert.equal((await binh.get('/api/v1/notifications')).body.items.filter(n => n.type === 'COMMENT_REACTION').length, 2);

    // Danh sach nguoi tha cam xuc.
    const who = await an.get(`/api/v1/posts/${pid}/comments/${cid}/reactions`);
    assert.equal(who.body.items.length, 3);
    assert.ok(who.body.items.some(r => r.displayName === 'Lê Chi' && r.reaction === 'HAHA'));

    // Go cam xuc.
    const un = await chi.del(`/api/v1/posts/${pid}/comments/${cid}/reaction`);
    assert.equal(un.body.reactions.total, 2);
    assert.equal(un.body.reactions.mine, null);

    // Cam xuc khong hop le.
    assert.equal((await chi.put(`/api/v1/posts/${pid}/comments/${cid}/reaction`, { reaction: 'XYZ' })).body.error.code, 'INVALID_REACTION');
});

test('không xem được bài thì không thả được; bình luận đã xóa -> 404', async () => {
    const priv = await an.post('/api/v1/posts', { privacy: 'PRIVATE', content: 'Chỉ mình tôi' });
    const c = await an.post(`/api/v1/posts/${priv.body.postId}/comments`, { content: 'ghi chú' });
    const cid = c.body.comment.commentId;
    assert.equal((await chi.put(`/api/v1/posts/${priv.body.postId}/comments/${cid}/reaction`, { reaction: 'LIKE' })).status, 404);
    assert.equal((await chi.get(`/api/v1/posts/${priv.body.postId}/comments/${cid}/reactions`)).status, 404);

    const pub = await an.post('/api/v1/posts', { privacy: 'PUBLIC', content: 'Công khai 2' });
    const c2 = await binh.post(`/api/v1/posts/${pub.body.postId}/comments`, { content: 'sẽ xóa' });
    await binh.del(`/api/v1/posts/${pub.body.postId}/comments/${c2.body.comment.commentId}`);
    assert.equal((await chi.put(`/api/v1/posts/${pub.body.postId}/comments/${c2.body.comment.commentId}/reaction`, { reaction: 'LIKE' })).status, 404);
});
