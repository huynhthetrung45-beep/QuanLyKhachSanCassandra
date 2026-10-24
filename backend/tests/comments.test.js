// Danh sach cam xuc, luong binh luan, quyen xoa, realtime - Cassandra GIA LAP (khong chung minh Cassandra that).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-comments-'));
process.env.POST_RATE_LIMIT = '1000';
process.env.COMMENT_RATE_LIMIT = '1000';
const { startTestServer, linkAccount } = require('./helpers');

const PW = 'MatKhau123';
let ctx, an, binh, chi, dung;
async function login(email) {
    const agent = ctx.agent();
    assert.equal((await agent.post('/api/v1/auth/login', { email, password: PW })).status, 200);
    return agent;
}
function sse(agent) {
    const controller = new AbortController();
    let buffer = '';
    const ready = fetch(`${ctx.baseUrl}/api/v1/events`, { headers: { Cookie: `chatott_sid=${agent.cookies.chatott_sid}` }, signal: controller.signal })
        .then(async res => {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += dec.decode(value); } } catch { /* dong */ } })();
        });
    return {
        ready,
        async waitFor(needle, ms = 1500) {
            const until = Date.now() + ms;
            while (!buffer.includes(needle) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
            return buffer.includes(needle);
        },
        count: needle => buffer.split(needle).length - 1,
        close() { controller.abort(); }
    };
}

let pub, priv;
test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user04', 'dung']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    chi = await login('chi@chatott.demo');
    dung = await login('dung@chatott.demo');
    pub = (await an.post('/api/v1/posts', { content: 'Ảnh đẹp không?', privacy: 'PUBLIC' })).body;
    priv = (await an.post('/api/v1/posts', { content: 'Riêng tư', privacy: 'PRIVATE' })).body;
});
test.after(() => ctx.server.close());

test.describe('Cảm xúc công khai', () => {
    test('người xem bài công khai (không phải chủ bài) thấy tổng và danh sách người bày tỏ: tên + loại', async () => {
        await binh.put(`/api/v1/posts/${pub.postId}/reaction`, { reaction: 'LIKE' });
        await chi.put(`/api/v1/posts/${pub.postId}/reaction`, { reaction: 'HAHA' });
        const post = (await dung.get(`/api/v1/posts/${pub.postId}`)).body;
        assert.equal(post.reactions.total, 2);
        const list = await dung.get(`/api/v1/posts/${pub.postId}/reactions`);
        assert.equal(list.status, 200);
        assert.deepEqual(list.body.items.map(i => [i.displayName, i.reaction]).sort(), [['Lê Chi', 'HAHA'], ['Trần Bình', 'LIKE']]);
        assert.equal(list.body.summary.total, 2);
        assert.equal(JSON.stringify(list.body).includes('@'), false, 'không lộ email');
        const onlyHaha = (await dung.get(`/api/v1/posts/${pub.postId}/reactions?type=haha`)).body;
        assert.deepEqual(onlyHaha.items.map(i => i.displayName), ['Lê Chi']);
        assert.equal((await dung.get(`/api/v1/posts/${pub.postId}/reactions?type=BAD`)).status, 400);
    });

    test('bài riêng tư: người không có quyền không lấy được danh sách cảm xúc (404, không lộ bài)', async () => {
        await an.put(`/api/v1/posts/${priv.postId}/reaction`, { reaction: 'LOVE' });
        assert.equal((await binh.get(`/api/v1/posts/${priv.postId}/reactions`)).status, 404);
        assert.equal((await ctx.agent().get(`/api/v1/posts/${pub.postId}/reactions`)).status, 401);
        assert.equal((await an.get(`/api/v1/posts/${priv.postId}/reactions`)).body.items[0].isMe, true);
    });

    test('thêm / đổi / gỡ của chính mình; gửi lặp đồng thời vẫn chỉ 1 cảm xúc hiện hành', async () => {
        await Promise.all([1, 2, 3, 4, 5].map(i => dung.put(`/api/v1/posts/${pub.postId}/reaction`, { reaction: i % 2 ? 'SAD' : 'ANGRY' })));
        const mine = (await dung.get(`/api/v1/posts/${pub.postId}/reactions`)).body.items.filter(i => i.isMe);
        assert.equal(mine.length, 1);
        assert.equal([...ctx.fake.data.post_reactions.values()].filter(r => String(r.post_id) === pub.postId && r.user_id === 'user04').length, 1);
        await dung.put(`/api/v1/posts/${pub.postId}/reaction`, { reaction: 'WOW' });
        assert.equal((await dung.get(`/api/v1/posts/${pub.postId}`)).body.reactions.mine, 'WOW');
        await dung.del(`/api/v1/posts/${pub.postId}/reaction`);
        const after = (await dung.get(`/api/v1/posts/${pub.postId}`)).body.reactions;
        assert.deepEqual([after.mine, after.total], [null, 2]);
    });
});

test.describe('Trả lời bình luận', () => {
    let rootAn, replyBinh;
    test('An bình luận, Bình trả lời An, Chi trả lời Bình: cùng một luồng, lưu ID cha', async () => {
        rootAn = (await an.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'Ảnh đẹp quá!' })).body.comment;
        const r1 = await binh.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'Cảm ơn bạn!', replyToCommentId: rootAn.commentId });
        assert.equal(r1.status, 201);
        replyBinh = r1.body.comment;
        assert.deepEqual([replyBinh.rootCommentId, replyBinh.replyTo.authorName, replyBinh.replyTo.excerpt], [rootAn.commentId, 'Nguyễn An', 'Ảnh đẹp quá!']);
        const r2 = (await chi.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'Mình cũng thấy vậy', replyToCommentId: replyBinh.commentId })).body.comment;
        assert.equal(r2.rootCommentId, rootAn.commentId, 'trả lời phản hồi vẫn nằm trong luồng gốc');
        assert.equal(r2.replyTo.authorName, 'Trần Bình');
        const row = [...ctx.fake.data.post_comments.values()].find(c => String(c.comment_id) === r2.commentId);
        assert.equal(String(row.reply_to_comment_id), replyBinh.commentId);

        const roots = (await dung.get(`/api/v1/posts/${pub.postId}/comments`)).body;
        assert.deepEqual(roots.items.map(c => [c.content, c.replyCount]), [['Ảnh đẹp quá!', 2]]);
        assert.equal(roots.total, 3);
        const replies = (await dung.get(`/api/v1/posts/${pub.postId}/comments/${rootAn.commentId}/replies`)).body;
        assert.deepEqual(replies.items.map(c => c.content), ['Cảm ơn bạn!', 'Mình cũng thấy vậy']);
    });

    test('không trả lời bình luận không tồn tại / thuộc bài khác; không xem được bài thì không thêm / trả lời / đọc', async () => {
        const other = (await chi.post('/api/v1/posts', { content: 'Bài khác', privacy: 'PUBLIC' })).body;
        const otherC = (await chi.post(`/api/v1/posts/${other.postId}/comments`, { content: 'bình luận bài khác' })).body.comment;
        assert.equal((await binh.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'x', replyToCommentId: otherC.commentId })).status, 404);
        assert.equal((await binh.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'x', replyToCommentId: '00000000-0000-1000-8000-000000000000' })).status, 404);
        assert.equal((await binh.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'x', replyToCommentId: 'abc' })).status, 400);
        const privC = (await an.post(`/api/v1/posts/${priv.postId}/comments`, { content: 'ghi chú riêng' })).body.comment;
        assert.equal((await binh.get(`/api/v1/posts/${priv.postId}/comments`)).status, 404);
        assert.equal((await binh.post(`/api/v1/posts/${priv.postId}/comments`, { content: 'x' })).status, 404);
        assert.equal((await binh.post(`/api/v1/posts/${priv.postId}/comments`, { content: 'x', replyToCommentId: privC.commentId })).status, 404);
        assert.equal((await binh.patch(`/api/v1/posts/${priv.postId}/comments/${privC.commentId}`, { content: 'x' })).status, 404);
        assert.equal((await binh.del(`/api/v1/posts/${priv.postId}/comments/${privC.commentId}`)).status, 404);
        assert.equal((await binh.get(`/api/v1/posts/${priv.postId}/comments/${privC.commentId}/replies`)).status, 404);
    });

    test('quyền: người viết sửa/xóa của mình; người xem không xóa của người khác (403, dữ liệu giữ nguyên); chủ bài xóa được', async () => {
        const url = id => `/api/v1/posts/${pub.postId}/comments/${id}`;
        const r = await dung.del(url(replyBinh.commentId));
        assert.equal(r.status, 403);
        assert.equal((await dung.patch(url(replyBinh.commentId), { content: 'hack' })).status, 403);
        assert.equal((await an.patch(url(replyBinh.commentId), { content: 'chủ bài cũng không sửa hộ' })).status, 403);
        const kept = [...ctx.fake.data.post_comments.values()].find(c => String(c.comment_id) === replyBinh.commentId);
        assert.deepEqual([kept.is_deleted, kept.content], [false, 'Cảm ơn bạn!']);
        assert.equal((await binh.patch(url(replyBinh.commentId), { content: 'Cảm ơn bạn nhiều!' })).status, 200);
        const d1 = (await dung.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'của Dũng' })).body.comment;
        assert.equal((await dung.del(url(d1.commentId))).status, 200, 'tác giả xóa của mình');
        const c2 = (await chi.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'của Chi' })).body.comment;
        assert.equal((await an.del(url(c2.commentId))).status, 200, 'chủ bài xóa bình luận trên bài mình');
        // nguoi khong phai chu bai khong xoa duoc bai
        assert.equal((await binh.del(`/api/v1/posts/${pub.postId}`)).status, 403);
        // danh tinh lay tu phien, khong tu body
        assert.equal((await dung.del(url(replyBinh.commentId) + '?userId=user02')).status, 403);
    });

    test('xóa bình luận gốc: phản hồi của người khác vẫn còn dưới placeholder, không lộ nội dung gốc', async () => {
        await an.del(`/api/v1/posts/${pub.postId}/comments/${rootAn.commentId}`);
        const roots = (await dung.get(`/api/v1/posts/${pub.postId}/comments`)).body.items;
        const placeholder = roots.find(c => c.commentId === rootAn.commentId);
        assert.deepEqual([placeholder.deleted, placeholder.content, placeholder.author, placeholder.canDelete], [true, null, null, false]);
        assert.equal(placeholder.replyCount, 2);
        const replies = (await dung.get(`/api/v1/posts/${pub.postId}/comments/${rootAn.commentId}/replies`)).body.items;
        assert.equal(replies[0].replyTo.available, false);
        assert.equal(replies[0].replyTo.excerpt, null);
        assert.equal(JSON.stringify(replies).includes('Ảnh đẹp quá!'), false);
    });

    test('gửi lại cùng clientId (retry) không tạo bình luận trùng; clientId của người khác bị từ chối', async () => {
        const clientId = crypto.randomUUID();
        const body = { content: 'Gửi một lần thôi', clientId };
        const [a, b] = await Promise.all([binh.post(`/api/v1/posts/${pub.postId}/comments`, body), binh.post(`/api/v1/posts/${pub.postId}/comments`, body)]);
        assert.equal(a.body.comment.commentId, b.body.comment.commentId);
        assert.equal([...ctx.fake.data.post_comments.values()].filter(c => c.content === 'Gửi một lần thôi').length, 1);
        assert.equal((await chi.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'x', clientId })).status, 409);
        assert.equal((await binh.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'x', clientId: 'not-uuid' })).status, 400);
    });

    test('phân trang bình luận gốc và phản hồi: 20 / trang, không lặp, không sót', async () => {
        const post = (await chi.post('/api/v1/posts', { content: 'Nhiều bình luận', privacy: 'PUBLIC' })).body;
        const roots = [];
        for (let i = 0; i < 23; i++) roots.push((await dung.post(`/api/v1/posts/${post.postId}/comments`, { content: `gốc ${i}` })).body.comment);
        for (let i = 0; i < 25; i++) await binh.post(`/api/v1/posts/${post.postId}/comments`, { content: `phản hồi ${i}`, replyToCommentId: roots[0].commentId });
        const collect = async url => {
            const out = [];
            let token = null;
            do {
                const r = (await chi.get(url + (token ? `?pageToken=${encodeURIComponent(token)}` : ''))).body;
                assert.ok(r.items.length <= 20);
                out.push(...r.items.map(c => c.content));
                token = r.nextPageToken;
            } while (token);
            return out;
        };
        const allRoots = await collect(`/api/v1/posts/${post.postId}/comments`);
        assert.deepEqual(allRoots, roots.map(r => r.content));
        const allReplies = await collect(`/api/v1/posts/${post.postId}/comments/${roots[0].commentId}/replies`);
        assert.equal(allReplies.length, 25);
        assert.equal(new Set(allReplies).size, 25);
        assert.equal(allReplies[0], 'phản hồi 0');
    });
});

test.describe('Realtime', () => {
    test('cảm xúc / bình luận / trả lời / sửa / xóa phát post:changed cho người đang xem, không cần tải lại', async () => {
        const watch = sse(dung);
        await watch.ready;
        await chi.put(`/api/v1/posts/${pub.postId}/reaction`, { reaction: 'LOVE' });
        assert.ok(await watch.waitFor(`"postId":"${pub.postId}","kind":"reaction"`));
        const c = (await chi.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'realtime' })).body.comment;
        assert.ok(await watch.waitFor('"kind":"comment"'));
        const before = watch.count('"kind":"comment"');
        await chi.patch(`/api/v1/posts/${pub.postId}/comments/${c.commentId}`, { content: 'realtime 2' });
        await chi.del(`/api/v1/posts/${pub.postId}/comments/${c.commentId}`);
        await new Promise(r => setTimeout(r, 300));
        assert.equal(watch.count('"kind":"comment"'), before + 2, 'mỗi thao tác đúng 1 sự kiện');
        watch.close();
    });

    test('sự kiện bài riêng tư chỉ gửi cho tác giả; bài bạn bè chỉ gửi tác giả + bạn bè', async () => {
        const watchB = sse(binh);
        const watchA = sse(an);
        await Promise.all([watchB.ready, watchA.ready]);
        await an.put(`/api/v1/posts/${priv.postId}/reaction`, { reaction: 'LIKE' });
        assert.ok(await watchA.waitFor(priv.postId));
        assert.equal(await watchB.waitFor(priv.postId, 400), false, 'người không có quyền không nhận');
        await an.post('/api/v1/friends/requests', { targetUserId: 'user02' });
        await binh.post('/api/v1/friends/requests/user01/accept');
        const fr = (await an.post('/api/v1/posts', { content: 'cho bạn bè', privacy: 'FRIENDS' })).body;
        const watchC = sse(chi);
        await watchC.ready;
        await an.put(`/api/v1/posts/${fr.postId}/reaction`, { reaction: 'LIKE' });
        assert.ok(await watchB.waitFor(fr.postId), 'bạn bè nhận');
        assert.equal(await watchC.waitFor(fr.postId, 400), false, 'người lạ không nhận');
        [watchA, watchB, watchC].forEach(w => w.close());
    });
});
