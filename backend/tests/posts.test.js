// Kiem thu bai dang / anh / cam xuc / binh luan / chia se tren Cassandra GIA LAP.
// Khong chung minh tich hop Cassandra that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-posts-'));
process.env.POST_RATE_LIMIT = '1000'; // test tao nhieu bai lien tiep; gioi han that van la 20/phut
const { startTestServer, linkAccount, SMALL_ID } = require('./helpers');

const PW = 'MatKhau123';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d30000000049454e44ae426082', 'hex');
let ctx, an, binh, chi, dung;

async function login(email) {
    const agent = ctx.agent();
    assert.equal((await agent.post('/api/v1/auth/login', { email, password: PW })).status, 200);
    return agent;
}
const cookie = agent => Object.entries(agent.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
async function uploadImage(agent, name, buf, origin = 'http://localhost:5173') {
    const res = await fetch(`${ctx.baseUrl}/api/v1/posts/media`, {
        method: 'POST',
        headers: { Cookie: cookie(agent), Origin: origin, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
        body: buf
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}
async function getImage(agent, postId, mediaId) {
    const res = await fetch(`${ctx.baseUrl}/api/v1/posts/${postId}/media/${mediaId}`, { headers: agent ? { Cookie: cookie(agent) } : {} });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
}
const post = (agent, body) => agent.post('/api/v1/posts', body);

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user04', 'dung']]) {
        await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    }
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    chi = await login('chi@chatott.demo');
    dung = await login('dung@chatott.demo');
    // An - Binh la ban; Chi la nguoi la
    await an.post('/api/v1/friends/requests', { targetUserId: 'user02' });
    await binh.post('/api/v1/friends/requests/user01/accept');
});
test.after(() => ctx.server.close());

let pub, fri, priv;

test.describe('Bài viết và quyền riêng tư', () => {
    test('chưa đăng nhập không đăng / đọc được', async () => {
        assert.equal((await ctx.agent().post('/api/v1/posts', { content: 'x' })).status, 401);
        assert.equal((await ctx.agent().get('/api/v1/feed')).status, 401);
    });

    test('đăng 3 mức quyền; nội dung rỗng / quyền sai bị 400', async () => {
        pub = (await post(an, { content: 'Bài công khai', privacy: 'PUBLIC' })).body;
        fri = (await post(an, { content: 'Bài bạn bè', privacy: 'FRIENDS' })).body;
        priv = (await post(an, { content: 'Bài riêng tư', privacy: 'PRIVATE' })).body;
        assert.equal(pub.privacy, 'PUBLIC');
        assert.equal(pub.author.displayName, 'Nguyễn An');
        assert.ok(pub.createdAt);
        assert.equal((await post(an, { content: '   ' })).status, 400);
        assert.equal((await post(an, { content: 'x', privacy: 'SECRET' })).status, 400);
        assert.equal((await post(an, { content: 'x'.repeat(5001) })).status, 400);
    });

    test('PUBLIC / FRIENDS / PRIVATE áp dụng ở backend cho từng người xem', async () => {
        const see = async (agent, p) => (await agent.get(`/api/v1/posts/${p.postId}`)).status;
        assert.deepEqual([await see(an, pub), await see(an, fri), await see(an, priv)], [200, 200, 200], 'tác giả');
        assert.deepEqual([await see(binh, pub), await see(binh, fri), await see(binh, priv)], [200, 200, 404], 'bạn bè');
        assert.deepEqual([await see(chi, pub), await see(chi, fri), await see(chi, priv)], [200, 404, 404], 'người lạ');
        const tl = async agent => (await agent.get('/api/v1/users/user01/posts')).body.items.map(p => p.content);
        assert.deepEqual(await tl(an), ['Bài riêng tư', 'Bài bạn bè', 'Bài công khai']);
        assert.deepEqual(await tl(binh), ['Bài bạn bè', 'Bài công khai']);
        assert.deepEqual(await tl(chi), ['Bài công khai']);
    });

    test('bảng tin nhiều người dùng: bài công khai của mọi người + bài bạn bè; không có bài riêng tư của người khác', async () => {
        await post(binh, { content: 'Bình chào cả nhà', privacy: 'FRIENDS' });
        await post(chi, { content: 'Chi đăng công khai', privacy: 'PUBLIC' });
        await post(chi, { content: 'Chi chỉ cho bạn bè', privacy: 'FRIENDS' });
        await post(chi, { content: 'Chi riêng tư', privacy: 'PRIVATE' });
        const feedOf = async agent => (await agent.get('/api/v1/feed')).body.items.map(p => p.content);
        assert.deepEqual(await feedOf(binh), ['Chi đăng công khai', 'Bình chào cả nhà', 'Bài bạn bè', 'Bài công khai']);
        assert.deepEqual(await feedOf(chi), ['Chi riêng tư', 'Chi chỉ cho bạn bè', 'Chi đăng công khai', 'Bài công khai']);
        const d = await feedOf(dung);
        assert.deepEqual(d, ['Chi đăng công khai', 'Bài công khai']);
        assert.equal(d.some(c => /riêng tư|bạn bè|Bình chào/.test(c)), false);
    });

    test('bài FRIENDS theo quan hệ bạn bè thật: kết bạn thì thấy, hủy kết bạn thì mất', async () => {
        const has = async agent => (await agent.get('/api/v1/feed')).body.items.some(p => p.content === 'Chi chỉ cho bạn bè');
        assert.equal(await has(dung), false);
        await dung.post('/api/v1/friends/requests', { targetUserId: 'user03' });
        await chi.post('/api/v1/friends/requests/user04/accept');
        assert.equal(await has(dung), true);
        await dung.del('/api/v1/friends/user03');
        assert.equal(await has(dung), false);
    });

    test('chặn: bài công khai của người đã chặn mình / mình chặn không vào bảng tin', async () => {
        const has = async agent => (await agent.get('/api/v1/feed')).body.items.some(p => p.content === 'Chi đăng công khai');
        assert.equal(await has(dung), true);
        await chi.post('/api/v1/blocks', { targetUserId: 'user04' });
        assert.equal(await has(dung), false, 'bị chặn');
        await chi.del('/api/v1/blocks/user04');
        await dung.post('/api/v1/blocks', { targetUserId: 'user03' });
        assert.equal(await has(dung), false, 'mình chặn');
        await dung.del('/api/v1/blocks/user03');
        assert.equal(await has(dung), true);
    });

    test('phân trang bảng tin: 20 bài / trang, trộn nhiều nguồn, không lặp, không thiếu, đúng thứ tự', async () => {
        for (let i = 0; i < 25; i++) await post(dung, { content: `Dũng #${i}`, privacy: i % 2 ? 'PUBLIC' : 'PRIVATE' });
        for (let i = 0; i < 12; i++) await post(chi, { content: `Chi công khai #${i}`, privacy: 'PUBLIC' });
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const r = (await dung.get('/api/v1/feed' + (cursor ? `?cursor=${cursor}` : ''))).body;
            assert.ok(r.items.length <= 20);
            seen.push(...r.items);
            cursor = r.nextCursor;
            pages += 1;
        } while (cursor && pages < 10);
        const ids = seen.map(p => p.postId);
        assert.equal(new Set(ids).size, ids.length, 'không lặp bài giữa các trang');
        const contents = seen.map(p => p.content);
        for (let i = 0; i < 25; i++) assert.ok(contents.includes(`Dũng #${i}`), `thiếu Dũng #${i}`);
        for (let i = 0; i < 12; i++) assert.ok(contents.includes(`Chi công khai #${i}`), `thiếu Chi #${i}`);
        const times = seen.map(p => new Date(p.createdAt).getTime());
        assert.deepEqual(times, [...times].sort((a, b) => b - a), 'mới nhất trước');
        assert.ok(pages >= 2, "đủ nhiều bài để cần phân trang");
        assert.equal((await dung.get('/api/v1/feed?cursor=abc')).status, 400);
    });

    test('đổi quyền / xóa bài cập nhật bảng tin công khai ngay', async () => {
        const p = (await post(chi, { content: 'Chi đổi quyền', privacy: 'PUBLIC' })).body;
        const has = async () => (await dung.get('/api/v1/feed')).body.items.some(x => x.postId === p.postId);
        assert.equal(await has(), true);
        await chi.patch(`/api/v1/posts/${p.postId}`, { privacy: 'PRIVATE' });
        assert.equal(await has(), false);
        await chi.patch(`/api/v1/posts/${p.postId}`, { privacy: 'PUBLIC' });
        assert.equal(await has(), true);
        await chi.del(`/api/v1/posts/${p.postId}`);
        assert.equal(await has(), false);
    });

    test('chỉ tác giả sửa / xóa; bài xóa biến mất với mọi người', async () => {
        assert.equal((await binh.patch(`/api/v1/posts/${pub.postId}`, { content: 'hack' })).status, 403);
        assert.equal((await binh.del(`/api/v1/posts/${pub.postId}`)).status, 403);
        assert.equal((await chi.patch(`/api/v1/posts/${priv.postId}`, { content: 'hack' })).status, 404);
        const e = await an.patch(`/api/v1/posts/${fri.postId}`, { content: 'Bài bạn bè (đã sửa)', privacy: 'PUBLIC' });
        assert.equal(e.status, 200);
        assert.equal(e.body.content, 'Bài bạn bè (đã sửa)');
        assert.equal((await chi.get(`/api/v1/posts/${fri.postId}`)).status, 200, 'đổi sang công khai -> người lạ xem được');
        await an.patch(`/api/v1/posts/${fri.postId}`, { privacy: 'FRIENDS' });
        const tmp = (await post(an, { content: 'Sẽ xóa', privacy: 'PUBLIC' })).body;
        assert.equal((await an.del(`/api/v1/posts/${tmp.postId}`)).status, 200);
        assert.equal((await an.get(`/api/v1/posts/${tmp.postId}`)).status, 404);
        assert.equal((await chi.get(`/api/v1/posts/${tmp.postId}`)).status, 404);
        assert.ok([...ctx.fake.data.posts.values()].some(r => String(r.post_id) === tmp.postId && r.is_deleted), 'xóa mềm');
    });

    test('chặn: người bị chặn không thấy bài kể cả công khai', async () => {
        await an.post('/api/v1/blocks', { targetUserId: 'user03' });
        assert.equal((await chi.get(`/api/v1/posts/${pub.postId}`)).status, 404);
        assert.equal((await chi.get('/api/v1/users/user01/posts')).status, 404);
        await an.del('/api/v1/blocks/user03');
        assert.equal((await chi.get(`/api/v1/posts/${pub.postId}`)).status, 200);
    });
});

test.describe('Ảnh của bài viết', () => {
    let imgPost, mediaId;
    test('tải ảnh, đăng bài nhiều ảnh; ảnh PENDING chỉ chủ xem được', async () => {
        const a = await uploadImage(an, 'anh-1.png', PNG);
        const b = await uploadImage(an, 'anh-2.png', PNG);
        assert.equal(a.status, 201, JSON.stringify(a.body));
        mediaId = a.body.mediaId;
        const prev = await fetch(`${ctx.baseUrl}/api/v1/posts/media/${mediaId}/preview`, { headers: { Cookie: cookie(an) } });
        assert.equal(prev.status, 200);
        const other = await fetch(`${ctx.baseUrl}/api/v1/posts/media/${mediaId}/preview`, { headers: { Cookie: cookie(binh) } });
        assert.equal(other.status, 404);
        const r = await post(an, { content: 'Nhật ký ảnh', privacy: 'FRIENDS', mediaIds: [a.body.mediaId, b.body.mediaId] });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        imgPost = r.body;
        assert.equal(imgPost.media.length, 2);
        assert.equal((await post(an, { mediaIds: [mediaId] })).status, 409, 'một ảnh không gắn vào 2 bài');
        const steal = await uploadImage(chi, 'cua-chi.png', PNG);
        assert.equal((await post(an, { mediaIds: [steal.body.mediaId] })).status, 409, 'không dùng ảnh của người khác');
    });

    test('ảnh của bài FRIENDS: bạn tải được, người lạ / chưa đăng nhập không tải được', async () => {
        const ok = await getImage(binh, imgPost.postId, mediaId);
        assert.equal(ok.status, 200);
        assert.ok(ok.buf.equals(PNG));
        assert.equal(ok.type, 'image/png');
        assert.equal((await getImage(chi, imgPost.postId, mediaId)).status, 404);
        assert.equal((await getImage(null, imgPost.postId, mediaId)).status, 401);
        assert.equal((await getImage(binh, pub.postId, mediaId)).status, 404, 'ảnh không thuộc bài đó');
    });

    test('ảnh của bài PRIVATE và bài đã xóa không tải được', async () => {
        const m = await uploadImage(an, 'rieng.png', PNG);
        const p = (await post(an, { privacy: 'PRIVATE', mediaIds: [m.body.mediaId] })).body;
        assert.equal((await getImage(an, p.postId, m.body.mediaId)).status, 200);
        assert.equal((await getImage(binh, p.postId, m.body.mediaId)).status, 404);
        await an.del(`/api/v1/posts/${p.postId}`);
        assert.equal((await getImage(an, p.postId, m.body.mediaId)).status, 404);
    });

    test('tệp không phải ảnh / giả đuôi / quá lớn / Origin lạ bị từ chối; quá 10 ảnh bị 400', async () => {
        assert.equal((await uploadImage(an, 'x.pdf', Buffer.from('%PDF-1.4 x'))).status, 415);
        assert.equal((await uploadImage(an, 'gia.png', Buffer.from('%PDF-1.4 x'))).status, 415);
        assert.equal((await uploadImage(an, 'x.svg', Buffer.from('<svg/>'))).status, 415);
        assert.equal((await uploadImage(an, 'lon.png', Buffer.alloc(20 * 1024 * 1024 + 10))).status, 413);
        assert.equal((await uploadImage(an, 'x.png', PNG, 'http://evil.example')).status, 403);
        const ids = [];
        for (let i = 0; i < 11; i++) ids.push((await uploadImage(an, `n${i}.png`, PNG)).body.mediaId);
        assert.equal((await post(an, { mediaIds: ids })).status, 400);
    });

    test('ảnh lưu tách khỏi tệp chat (UPLOAD_DIR/posts), tên lưu do server sinh', () => {
        const row = [...ctx.fake.data.post_media.values()].find(r => String(r.media_id) === mediaId);
        assert.match(row.storage_key, /^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
        assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, 'posts', ...row.storage_key.split('/'))));
        const writes = ctx.fake.log.filter(e => /^(INSERT INTO|UPDATE|DELETE FROM) post_media/.test(e.query));
        writes.forEach(e => assert.match(e.query, / IF /, e.query));
    });
});

test.describe('Cảm xúc', () => {
    test('thêm, đổi, gỡ; gửi lặp / đồng thời không trùng và đếm đúng', async () => {
        const url = `/api/v1/posts/${pub.postId}/reaction`;
        let r = await binh.put(url, { reaction: 'like' });
        assert.equal(r.status, 200);
        assert.deepEqual([r.body.total, r.body.mine], [1, 'LIKE']);
        await Promise.all([1, 2, 3, 4].map(() => binh.put(url, { reaction: 'LOVE' })));
        r = await chi.put(url, { reaction: 'HAHA' });
        assert.equal(r.body.total, 2);
        assert.deepEqual(r.body.counts, { LOVE: 1, HAHA: 1 });
        const view = (await binh.get(`/api/v1/posts/${pub.postId}`)).body.reactions;
        assert.equal(view.mine, 'LOVE');
        r = await binh.del(url);
        assert.deepEqual([r.body.total, r.body.mine], [1, null]);
        assert.equal((await binh.put(url, { reaction: 'POOP' })).status, 400);
    });

    test('không thả cảm xúc vào bài không được xem; chưa đăng nhập 401', async () => {
        assert.equal((await chi.put(`/api/v1/posts/${priv.postId}/reaction`, { reaction: 'LIKE' })).status, 404);
        assert.equal((await chi.put(`/api/v1/posts/${fri.postId}/reaction`, { reaction: 'LIKE' })).status, 404);
        assert.equal((await ctx.agent().put(`/api/v1/posts/${pub.postId}/reaction`, { reaction: 'LIKE' })).status, 401);
    });
});

test.describe('Bình luận', () => {
    let c1;
    test('thêm, đếm, phân trang 20', async () => {
        const r = await binh.post(`/api/v1/posts/${fri.postId}/comments`, { content: 'Hay quá' });
        assert.equal(r.status, 201);
        c1 = r.body.comment;
        assert.equal(c1.author.displayName, 'Trần Bình');
        for (let i = 0; i < 24; i++) await an.post(`/api/v1/posts/${fri.postId}/comments`, { content: `bl ${i}` });
        const p1 = (await binh.get(`/api/v1/posts/${fri.postId}/comments`)).body;
        assert.equal(p1.items.length, 20);
        assert.equal(p1.total, 25);
        assert.equal(p1.items[0].content, 'Hay quá', 'cũ nhất trước');
        const p2 = (await binh.get(`/api/v1/posts/${fri.postId}/comments?pageToken=${encodeURIComponent(p1.nextPageToken)}`)).body;
        assert.equal(p2.items.length, 5);
        assert.equal(p2.hasMore, false);
        assert.equal((await binh.get(`/api/v1/posts/${fri.postId}`)).body.commentCount, 25);
        assert.equal((await binh.get(`/api/v1/posts/${pub.postId}/comments?pageToken=${encodeURIComponent(p1.nextPageToken)}`)).status, 400,
            'token của bài khác bị từ chối');
    });

    test('sửa: chỉ tác giả bình luận; xóa: tác giả bình luận hoặc tác giả bài', async () => {
        const url = `/api/v1/posts/${fri.postId}/comments/${c1.commentId}`;
        assert.equal((await an.patch(url, { content: 'sửa hộ' })).status, 403);
        const e = await binh.patch(url, { content: 'Hay quá (sửa)' });
        assert.equal(e.body.comment.content, 'Hay quá (sửa)');
        const theirs = (await an.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'của An' })).body.comment;
        assert.equal((await chi.del(`/api/v1/posts/${pub.postId}/comments/${theirs.commentId}`)).status, 403);
        const chiC = (await chi.post(`/api/v1/posts/${pub.postId}/comments`, { content: 'của Chi' })).body.comment;
        assert.equal((await an.del(`/api/v1/posts/${pub.postId}/comments/${chiC.commentId}`)).status, 200, 'chủ bài xóa được');
        const d = await binh.del(url);
        assert.equal(d.body.total, 24);
        assert.equal((await binh.patch(url, { content: 'x' })).status, 404);
    });

    test('không đọc / bình luận vào bài không được xem; nội dung rỗng 400', async () => {
        assert.equal((await chi.get(`/api/v1/posts/${fri.postId}/comments`)).status, 404);
        assert.equal((await chi.post(`/api/v1/posts/${priv.postId}/comments`, { content: 'x' })).status, 404);
        assert.equal((await binh.post(`/api/v1/posts/${fri.postId}/comments`, { content: '  ' })).status, 400);
    });
});

test.describe('Chia sẻ', () => {
    test('chia sẻ lên bảng tin: lưu tham chiếu + lời dẫn, không sao chép nội dung', async () => {
        const s = await binh.post(`/api/v1/posts/${pub.postId}/share`, { content: 'Xem bài này', privacy: 'PUBLIC' });
        assert.equal(s.status, 201, JSON.stringify(s.body));
        assert.equal(s.body.content, 'Xem bài này');
        assert.equal(s.body.shared.available, true);
        assert.equal(s.body.shared.post.content, 'Bài công khai');
        const row = [...ctx.fake.data.posts.values()].find(r => String(r.post_id) === s.body.postId);
        assert.equal(String(row.shared_post_id), pub.postId);
        assert.equal(row.content, 'Xem bài này');
    });

    test('đếm lượt chia sẻ thật (bảng tin + chat); xóa bài chia sẻ thì trừ', async () => {
        const base = (await an.get(`/api/v1/posts/${pub.postId}`)).body.shareCount;
        const s1 = (await chi.post(`/api/v1/posts/${pub.postId}/share`, { privacy: 'PRIVATE' })).body;
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { sharedPostId: pub.postId });
        assert.equal((await an.get(`/api/v1/posts/${pub.postId}`)).body.shareCount, base + 2);
        await chi.del(`/api/v1/posts/${s1.postId}`);
        assert.equal((await an.get(`/api/v1/posts/${pub.postId}`)).body.shareCount, base + 1);
    });

    test('không chia sẻ được bài mình không xem được', async () => {
        assert.equal((await chi.post(`/api/v1/posts/${priv.postId}/share`, {})).status, 404);
        assert.equal((await chi.post(`/api/v1/posts/${fri.postId}/share`, {})).status, 404);
    });

    test('bản chia sẻ không làm lộ bài gốc FRIENDS cho người lạ, và ẩn khi bài gốc bị xóa', async () => {
        const s = (await binh.post(`/api/v1/posts/${fri.postId}/share`, { content: 'Chia sẻ bài bạn bè', privacy: 'PUBLIC' })).body;
        const chiView = (await chi.get(`/api/v1/posts/${s.postId}`)).body;
        assert.equal(chiView.content, 'Chia sẻ bài bạn bè');
        assert.deepEqual(chiView.shared, { available: false, postId: fri.postId });
        assert.equal(JSON.stringify(chiView).includes('Bài bạn bè (đã sửa)'), false);
        const tmp = (await post(an, { content: 'Gốc sẽ bị xóa', privacy: 'PUBLIC' })).body;
        const s2 = (await binh.post(`/api/v1/posts/${tmp.postId}/share`, { privacy: 'PUBLIC' })).body;
        await an.del(`/api/v1/posts/${tmp.postId}`);
        const after = (await chi.get(`/api/v1/posts/${s2.postId}`)).body;
        assert.equal(after.shared.available, false);
        assert.equal(JSON.stringify(after).includes('Gốc sẽ bị xóa'), false);
    });

    test('chia sẻ vào chat: tin chỉ chứa tham chiếu; người không có quyền không đọc được bài qua tin', async () => {
        const r = await an.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Đọc thử nhé', sharedPostId: fri.postId });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.sharedPostId, fri.postId);
        assert.equal(r.body.messageType, 'POST_SHARE');
        assert.equal(JSON.stringify(r.body).includes('Bài bạn bè'), false, 'tin không chứa nội dung bài');
        const page = (await binh.get(`/api/v1/conversations/${SMALL_ID}/messages`)).body;
        assert.equal(page.items[0].sharedPostId, fri.postId);
        assert.ok(page.items.length <= 20, 'phân trang chat tối đa 20 tin vẫn giữ');
        assert.equal((await binh.get(`/api/v1/posts/${fri.postId}`)).status, 200, 'Bình là bạn -> xem được');
        const list = await binh.get('/api/v1/me/conversations');
        assert.equal(list.body.data.find(c => c.conversationId === SMALL_ID).lastMessagePreview, 'Đọc thử nhé');
        // nguoi gui phai xem duoc bai
        assert.equal((await chi.post('/api/v1/conversations/55555555-5555-5555-5555-555555555555/messages', { sharedPostId: priv.postId })).status, 404);
        assert.equal((await an.post(`/api/v1/conversations/${SMALL_ID}/messages`, { sharedPostId: 'abc' })).status, 400);
    });
});

test('migration 005 chỉ thêm 2 bảng, không có lệnh phá hủy', () => {
    const { parsePlan } = require('../scripts/migrate');
    const file = path.resolve(__dirname, '../../db/migrations/005_public_feed_shares.cql');
    const plan = parsePlan([file]);
    assert.deepEqual(plan.creates.map(c => c.def.table).sort(), ['post_shares', 'public_posts_by_month']);
    assert.equal(plan.alters.length, 0);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8').replace(/--.*$/gm, ''), /\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
});

test('migration 004 chỉ thêm (5 bảng + 1 cột), không có lệnh phá hủy', () => {
    const { parsePlan } = require('../scripts/migrate');
    const file = path.resolve(__dirname, '../../db/migrations/004_posts_reactions_comments.cql');
    const plan = parsePlan([file]);
    assert.equal(plan.creates.length, 5);
    assert.equal(plan.alters.length, 1);
    assert.doesNotMatch(fs.readFileSync(file, 'utf8').replace(/--.*$/gm, ''), /\b(DROP|TRUNCATE|DELETE)\b/i);
});
