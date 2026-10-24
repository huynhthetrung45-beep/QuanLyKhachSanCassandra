// Thong bao / tim kiem / thong ke / AI tren Cassandra GIA LAP. Khong chung minh tich hop Cassandra that.
// AI dung provider gia lap TRONG TEST (ai.setProvider) - chay that can ANTHROPIC_API_KEY.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-insights-'));
process.env.POST_RATE_LIMIT = '1000';
process.env.SEARCH_RATE_LIMIT = '1000';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.AI_PROVIDER;
const { startTestServer, linkAccount, GROUP_ID, SMALL_ID } = require('./helpers');
const ai = require('../src/services/ai.service');

const PW = 'MatKhau123';
let ctx, an, binh, chi, linh;

async function login(email) {
    const agent = ctx.agent();
    assert.equal((await agent.post('/api/v1/auth/login', { email, password: PW })).status, 200);
    return agent;
}
const notifs = async agent => (await agent.get('/api/v1/notifications')).body;
const unread = async agent => (await agent.get('/api/v1/notifications/unread-count')).body.unreadCount;

function sse(agent) {
    const controller = new AbortController();
    let buffer = '';
    const ready = fetch(`${ctx.baseUrl}/api/v1/events`, { headers: { Cookie: `chatott_sid=${agent.cookies.chatott_sid}` }, signal: controller.signal })
        .then(async res => {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value); } } catch { /* dong */ } })();
        });
    return {
        ready,
        async waitFor(needle, ms = 2000) {
            const until = Date.now() + ms;
            while (!buffer.includes(needle) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
            return buffer.includes(needle);
        },
        get text() { return buffer; },
        close() { controller.abort(); }
    };
}

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user07', 'linh']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    chi = await login('chi@chatott.demo');
    linh = await login('linh@chatott.demo');
});
test.after(() => ctx.server.close());

test.describe('Thông báo', () => {
    let post;
    test('cảm xúc trên bài của tôi -> thông báo realtime + lưu bền vững; bấm lại / đổi cảm xúc không tạo trùng', async () => {
        post = (await an.post('/api/v1/posts', { content: 'Bài của An', privacy: 'PUBLIC' })).body;
        const watch = sse(an);
        await watch.ready;
        await chi.put(`/api/v1/posts/${post.postId}/reaction`, { reaction: 'LIKE' });
        assert.ok(await watch.waitFor('event: notification:new'), 'nhận realtime không cần tải lại');
        assert.ok(watch.text.includes('"unreadCount":1'));
        watch.close();
        await Promise.all([1, 2, 3].map(() => chi.put(`/api/v1/posts/${post.postId}/reaction`, { reaction: 'LIKE' })));
        await chi.put(`/api/v1/posts/${post.postId}/reaction`, { reaction: 'LOVE' });
        await chi.del(`/api/v1/posts/${post.postId}/reaction`);
        await chi.put(`/api/v1/posts/${post.postId}/reaction`, { reaction: 'HAHA' });
        const list = await notifs(an);
        const reacts = list.items.filter(n => n.type === 'POST_REACTION');
        assert.equal(reacts.length, 1, 'đúng 1 thông báo cảm xúc');
        assert.equal(reacts[0].actor.displayName, 'Lê Chi');
        assert.equal(reacts[0].postId, post.postId);
        assert.equal(reacts[0].isRead, false);
        assert.ok(reacts[0].createdAt);
        const r = (await an.get(`/api/v1/posts/${post.postId}`)).body.reactions;
        assert.deepEqual([r.total, r.counts.HAHA], [1, 1], 'bộ đếm đúng sau thêm/đổi/gỡ đồng thời');
    });

    test('tự tương tác với bài của mình không tạo thông báo', async () => {
        const before = (await notifs(an)).items.length;
        await an.put(`/api/v1/posts/${post.postId}/reaction`, { reaction: 'LIKE' });
        await an.post(`/api/v1/posts/${post.postId}/comments`, { content: 'tự bình luận' });
        assert.equal((await notifs(an)).items.length, before);
    });

    test('bình luận -> chủ bài; phản hồi bình luận -> người được trả lời (không trùng người)', async () => {
        const c = (await chi.post(`/api/v1/posts/${post.postId}/comments`, { content: 'Hay đấy An' })).body.comment;
        assert.equal((await notifs(an)).items[0].type, 'POST_COMMENT');
        const reply = await binh.post(`/api/v1/posts/${post.postId}/comments`, { content: 'Đồng ý với Chi', replyToCommentId: c.commentId });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        assert.equal(reply.body.comment.replyTo.authorName, 'Lê Chi');
        const chiN = (await notifs(chi)).items[0];
        assert.deepEqual([chiN.type, chiN.commentId, chiN.preview], ['COMMENT_REPLY', reply.body.comment.commentId, 'Đồng ý với Chi']);
        assert.equal((await notifs(an)).items[0].type, 'POST_COMMENT', 'chủ bài vẫn được báo');
        // Chi tra loi chinh binh luan cua minh tren bai cua An: An chi nhan 1 thong bao
        const before = (await notifs(an)).items.length;
        await an.post(`/api/v1/posts/${post.postId}/comments`, { content: 'cảm ơn', replyToCommentId: c.commentId });
        assert.equal((await notifs(an)).items.length, before);
        assert.equal((await chi.post(`/api/v1/posts/${post.postId}/comments`, { content: 'x', replyToCommentId: '00000000-0000-1000-8000-000000000000' })).status, 404);
    });

    test('chia sẻ bài -> chủ bài nhận thông báo', async () => {
        await binh.post(`/api/v1/posts/${post.postId}/share`, { privacy: 'PUBLIC' });
        assert.equal((await notifs(an)).items[0].type, 'POST_SHARE');
    });

    test('lời mời và chấp nhận kết bạn', async () => {
        await linh.post('/api/v1/friends/requests', { targetUserId: 'user01' });
        await linh.post('/api/v1/friends/requests', { targetUserId: 'user01' }); // gui lai
        const req = (await notifs(an)).items.filter(n => n.type === 'FRIEND_REQUEST');
        assert.equal(req.length, 1);
        assert.equal(req[0].actor.userId, 'user07');
        await an.post('/api/v1/friends/requests/user07/accept');
        assert.equal((await notifs(linh)).items[0].type, 'FRIEND_ACCEPT');
    });

    test('tin nhắn mới: 1 thông báo / hội thoại, dồn lại khi chưa đọc, mở hội thoại = đã đọc', async () => {
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Tin 1' });
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Tin 2' });
        let m = (await notifs(an)).items.filter(n => n.type === 'MESSAGE' && n.conversationId === SMALL_ID);
        assert.equal(m.length, 1);
        assert.deepEqual([m[0].count, m[0].preview, m[0].isRead], [2, 'Tin 2', false]);
        assert.equal((await notifs(binh)).items.some(n => n.type === 'MESSAGE' && n.conversationId === SMALL_ID), false, 'người gửi không nhận');
        await an.post(`/api/v1/conversations/${SMALL_ID}/read`);
        m = (await notifs(an)).items.filter(n => n.type === 'MESSAGE' && n.conversationId === SMALL_ID);
        assert.equal(m[0].isRead, true);
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Tin 3' });
        m = (await notifs(an)).items.filter(n => n.type === 'MESSAGE' && n.conversationId === SMALL_ID);
        assert.equal(m.length, 2, 'đã đọc rồi -> thông báo mới');
        assert.equal(m[0].count, 1);
    });

    test('đánh dấu đã đọc / tất cả; badge cập nhật; không đọc được thông báo của người khác', async () => {
        const before = await unread(an);
        assert.ok(before > 0);
        const first = (await notifs(an)).items.find(n => !n.isRead);
        const r = await an.post(`/api/v1/notifications/${first.notificationId}/read`);
        assert.equal(r.body.unreadCount, before - 1);
        assert.equal((await chi.post(`/api/v1/notifications/${first.notificationId}/read`)).status, 404, 'id của An không có trong partition của Chi');
        assert.equal((await an.post('/api/v1/notifications/read-all')).body.unreadCount, 0);
        assert.equal((await ctx.agent().get('/api/v1/notifications')).status, 401);
    });

    test('phân trang thông báo 20 / trang, không trùng', async () => {
        for (let i = 0; i < 25; i++) {
            const p = (await an.post('/api/v1/posts', { content: `n${i}`, privacy: 'PUBLIC' })).body;
            await chi.put(`/api/v1/posts/${p.postId}/reaction`, { reaction: 'LIKE' });
        }
        const p1 = await notifs(an);
        assert.equal(p1.items.length, 20);
        const p2 = (await an.get(`/api/v1/notifications?pageToken=${encodeURIComponent(p1.nextPageToken)}`)).body;
        const ids = [...p1.items, ...p2.items].map(n => n.notificationId);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal((await chi.get(`/api/v1/notifications?pageToken=${encodeURIComponent(p1.nextPageToken)}`)).status, 400, 'token của người khác');
    });

    test('mọi lệnh ghi notification_keys là LWT', () => {
        const w = ctx.fake.log.filter(e => /^(INSERT INTO|UPDATE|DELETE FROM) notification_keys/.test(e.query));
        assert.ok(w.length > 5);
        w.forEach(e => assert.match(e.query, / IF /));
    });
});

test.describe('Tìm kiếm lịch sử', () => {
    test('từ khóa (không dấu, nhiều từ) trong các hội thoại của tôi; không trả hội thoại tôi không tham gia', async () => {
        await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Họp nhóm đồ án lúc 9 giờ sáng thứ Hai' });
        await chi.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Mình sẽ chuẩn bị slide đồ án' });
        const r = (await an.get('/api/v1/search/messages?q=' + encodeURIComponent('do an'))).body;
        assert.ok(r.items.length >= 2);
        assert.ok(r.items.every(i => /đồ án/i.test(i.snippet)));
        const two = (await an.get('/api/v1/search/messages?q=' + encodeURIComponent('họp đồ án'))).body;
        assert.deepEqual(two.items.map(i => i.snippet), ['Họp nhóm đồ án lúc 9 giờ sáng thứ Hai']);
        // Linh khong o GROUP_ID
        const l = (await linh.get('/api/v1/search/messages?q=' + encodeURIComponent('đồ án'))).body;
        assert.equal(l.items.some(i => i.conversationId === GROUP_ID), false);
        assert.equal((await linh.get(`/api/v1/search/messages?q=x1&conversationId=${GROUP_ID}`)).status, 403);
    });

    test('lọc người gửi, khoảng thời gian, hội thoại; bỏ tin đã thu hồi và tin xóa phía tôi', async () => {
        const bySender = (await an.get(`/api/v1/search/messages?q=${encodeURIComponent('đồ án')}&senderId=user03&conversationId=${GROUP_ID}`)).body;
        assert.deepEqual(bySender.items.map(i => i.senderId), ['user03']);
        const future = (await an.get(`/api/v1/search/messages?q=${encodeURIComponent('đồ án')}&from=2099-01-01`)).body;
        assert.equal(future.items.length, 0);
        const m = (await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'bí mật xyzabc' })).body;
        assert.equal((await an.get('/api/v1/search/messages?q=xyzabc')).body.items.length, 1);
        await an.post(`/api/v1/conversations/${GROUP_ID}/messages/${m.messageId}/hide`, { createdAt: m.createdAt });
        assert.equal((await an.get('/api/v1/search/messages?q=xyzabc')).body.items.length, 0, 'đã xóa phía tôi');
        assert.equal((await chi.get('/api/v1/search/messages?q=xyzabc')).body.items.length, 1, 'người khác vẫn thấy');
        await binh.del(`/api/v1/conversations/${GROUP_ID}/messages/${m.messageId}?createdAt=${encodeURIComponent(m.createdAt)}`);
        assert.equal((await chi.get('/api/v1/search/messages?q=xyzabc')).body.items.length, 0, 'đã thu hồi');
    });

    test('lọc loại nội dung / có tệp; tìm theo tên tệp', async () => {
        const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
        const up = await fetch(`${ctx.baseUrl}/api/v1/conversations/${GROUP_ID}/attachments`, {
            method: 'POST', body: PDF,
            headers: { Cookie: `chatott_sid=${an.cookies.chatott_sid}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/octet-stream', 'X-File-Name': 'bao-cao-tuan.pdf' }
        }).then(r => r.json());
        await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { attachmentIds: [up.attachmentId] });
        const byName = (await binh.get('/api/v1/search/messages?q=' + encodeURIComponent('báo cáo'))).body;
        assert.equal(byName.items[0].files[0].fileName, 'bao-cao-tuan.pdf');
        const files = (await binh.get(`/api/v1/search/messages?hasFile=1&conversationId=${GROUP_ID}`)).body;
        assert.ok(files.items.length >= 1 && files.items.every(i => i.messageType === 'ATTACHMENT'));
        const typeFile = (await binh.get(`/api/v1/search/messages?type=FILE&conversationId=${GROUP_ID}`)).body;
        assert.ok(typeFile.items.every(i => i.files.some(f => f.kind === 'FILE')));
        assert.equal((await binh.get('/api/v1/search/messages?type=BAD')).status, 400);
        assert.equal((await binh.get('/api/v1/search/messages')).status, 400, 'không từ khóa, không bộ lọc');
    });

    test('phân trang kết quả bằng con trỏ: 20 / trang, không lặp, không sót', async () => {
        for (let i = 0; i < 27; i++) await chi.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: `chủ đề benchmark số ${i}` });
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const r = (await an.get('/api/v1/search/messages?q=benchmark' + (cursor ? `&cursor=${cursor}` : ''))).body;
            seen.push(...r.items.map(i => i.snippet));
            cursor = r.nextCursor;
            pages += 1;
        } while (cursor && pages < 10);
        assert.equal(seen.length, 27);
        assert.equal(new Set(seen).size, 27);
        assert.equal(seen[0], 'chủ đề benchmark số 26', 'mới nhất trước');
    });

    test('không dùng ALLOW FILTERING; chỉ mục đọc theo (conversation_id, term)', () => {
        const q = ctx.fake.log.filter(e => /FROM message_terms_by_conversation/.test(e.query));
        assert.ok(q.length > 0);
        q.forEach(e => assert.match(e.query, /WHERE conversation_id = \? AND term = \?/));
    });
});

test.describe('Thống kê', () => {
    test('thống kê hội thoại từ bảng tổng hợp: tổng, theo ngày, giờ, loại, người gửi; người ngoài 403', async () => {
        const before = (await an.get(`/api/v1/conversations/${SMALL_ID}/analytics`)).body;
        await an.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'đếm tôi' });
        const after = (await an.get(`/api/v1/conversations/${SMALL_ID}/analytics`)).body;
        assert.equal(after.totalMessages, before.totalMessages + 1);
        assert.equal(after.participants, 2);
        assert.equal(after.hourly.length, 24);
        assert.ok(after.daily.length >= 1);
        assert.ok(after.topSenders.find(s => s.userId === 'user01').messages >= 1);
        assert.equal((await linh.get(`/api/v1/conversations/${SMALL_ID}/analytics`)).status, 403);
        const reads = ctx.fake.log.filter(e => /FROM conversation_daily_stats/.test(e.query));
        reads.forEach(e => assert.match(e.query, /WHERE conversation_id = \?/));
    });

    test('thống kê mạng xã hội tách riêng, chỉ của chính mình', async () => {
        const s = (await an.get('/api/v1/me/analytics')).body;
        assert.ok(s.posts >= 26);
        assert.ok(s.reactions_received >= 26);
        assert.ok(s.comments_received >= 2);
        assert.ok(s.shares_received >= 1);
    });
});

test.describe('AI tóm tắt', () => {
    test('chưa cấu hình: báo rõ, không tạo kết quả giả; ứng dụng vẫn chạy', async () => {
        const st = (await an.get('/api/v1/ai/status')).body;
        assert.equal(st.configured, false);
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/ai/summaries`, {});
        assert.equal(r.status, 503);
        assert.equal(r.body.error.code, 'AI_NOT_CONFIGURED');
        assert.equal((await an.get(`/api/v1/conversations/${GROUP_ID}/ai`)).body.summaries.length, 0);
    });

    test('có provider: lưu tóm tắt + công việc kèm source_message_ids hợp lệ (id lạ bị loại)', async () => {
        let seenPrompt = '';
        ai.setProvider(async ({ prompt }) => {
            seenPrompt = prompt;
            const ids = [...prompt.matchAll(/^\[([0-9a-f-]{36})\]/gm)].map(m => m[1]);
            return JSON.stringify({
                summary: 'Nhóm thống nhất họp đồ án sáng thứ Hai.',
                summary_source_ids: [ids[0], '11111111-1111-1111-1111-111111111111'],
                tasks: [
                    { title: 'Chuẩn bị slide', assignee_id: 'user03', due_date: '2026-11-02', source_message_ids: [ids[1]] },
                    { title: 'Không có nguồn', assignee_id: 'user99', due_date: 'mai', source_message_ids: ['bad'] }
                ]
            });
        });
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/ai/summaries`, { limit: 50 });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(seenPrompt.includes('bí mật xyzabc'), false, 'không gửi tin đã thu hồi cho AI');
        const s = r.body.summaries[0];
        assert.equal(s.summary, 'Nhóm thống nhất họp đồ án sáng thứ Hai.');
        assert.equal(s.sourceMessageIds.length, 1, 'id không thuộc hội thoại bị loại');
        assert.equal(r.body.tasks.length, 1, 'công việc không truy nguyên được bị loại');
        const t = r.body.tasks[0];
        assert.deepEqual([t.title, t.assigneeId, t.dueDate, t.status], ['Chuẩn bị slide', 'user03', '2026-11-02', 'SUGGESTED']);
        assert.equal(t.sourceMessageIds.length, 1);
    });

    test('người dùng sửa / xác nhận công việc; người ngoài không xem / không gọi được', async () => {
        const t = (await an.get(`/api/v1/conversations/${GROUP_ID}/ai`)).body.tasks[0];
        const u = await chi.patch(`/api/v1/conversations/${GROUP_ID}/ai/tasks/${t.taskId}`, { title: 'Chuẩn bị slide v2', status: 'CONFIRMED' });
        assert.equal(u.status, 200);
        assert.deepEqual([u.body.tasks[0].title, u.body.tasks[0].status, u.body.tasks[0].updatedBy], ['Chuẩn bị slide v2', 'CONFIRMED', 'Lê Chi']);
        assert.equal((await chi.patch(`/api/v1/conversations/${GROUP_ID}/ai/tasks/${t.taskId}`, { assigneeId: 'user07' })).status, 400);
        assert.equal((await linh.get(`/api/v1/conversations/${GROUP_ID}/ai`)).status, 403);
        assert.equal((await linh.post(`/api/v1/conversations/${GROUP_ID}/ai/summaries`, {})).status, 403);
        ai.setProvider(null);
    });
});

test('chat vẫn phân trang đúng 20 tin', async () => {
    const r = (await an.get(`/api/v1/conversations/${GROUP_ID}/messages`)).body;
    assert.equal(r.items.length, 20);
    assert.ok(r.nextPageToken);
});
