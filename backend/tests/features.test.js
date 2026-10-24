// Kiem thu chuc nang moi (tra loi, cam xuc, chuyen tiep, xoa phia toi, tep, dang nhap, da xem,
// online, so chua doc) tren Cassandra GIA LAP. Khong chung minh tich hop Cassandra that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-upload-'));
const { startTestServer, linkAccount, GROUP_ID, SMALL_ID } = require('./helpers');

const PW = 'MatKhau123';
const OTHER_GROUP = '22222222-2222-2222-2222-222222222222'; // user01, 02, 03, 06
let ctx;
let an;   // user01
let binh; // user02
let linh; // user07 - khong thuoc GROUP_ID

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d30000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function login(email) {
    const agent = ctx.agent();
    const r = await agent.post('/api/v1/auth/login', { email, password: PW });
    assert.equal(r.status, 200);
    return agent;
}

async function upload(agent, cid, name, buf, extra = {}) {
    const cookie = Object.entries(agent.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${ctx.baseUrl}/api/v1/conversations/${cid}/attachments`, {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'http://localhost:5173', 'Content-Type': 'application/octet-stream',
            'X-File-Name': encodeURIComponent(name), ...extra },
        body: buf
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

async function download(agent, cid, aid, inline = false) {
    const cookie = Object.entries(agent.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${ctx.baseUrl}/api/v1/conversations/${cid}/attachments/${aid}/content${inline ? '?inline=1' : ''}`,
        { headers: { Cookie: cookie } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf };
}

async function firstPage(agent, cid) {
    const r = await agent.get(`/api/v1/conversations/${cid}/messages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
}

function sse(agent) {
    const controller = new AbortController();
    let buffer = '';
    const ready = fetch(`${ctx.baseUrl}/api/v1/events`, {
        headers: { Cookie: `chatott_sid=${agent.cookies.chatott_sid}` }, signal: controller.signal
    }).then(async res => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        (async () => {
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value);
                }
            } catch { /* da dong */ }
        })();
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
    await linkAccount(ctx.fake, 'user01', 'an@chatott.demo', PW);
    await linkAccount(ctx.fake, 'user02', 'binh@chatott.demo', PW);
    await linkAccount(ctx.fake, 'user07', 'linh@chatott.demo', PW);
    an = await login('an@chatott.demo');
    binh = await login('binh@chatott.demo');
    linh = await login('linh@chatott.demo');
});
test.after(() => ctx.server.close());

// ================= Tra loi =================
test.describe('Trả lời tin nhắn', () => {
    let original;
    let reply;

    test('trả lời lưu tham chiếu ổn định và hiển thị đoạn trích sau khi tải lại', async () => {
        const o = await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Tin gốc để trả lời' });
        original = o.body;
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, {
            content: 'Đây là câu trả lời', replyTo: { messageId: original.messageId, createdAt: original.createdAt }
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        reply = r.body;
        assert.equal(reply.replyTo.messageId, original.messageId);
        assert.equal(reply.replyTo.excerpt, 'Tin gốc để trả lời');
        assert.equal(reply.replyTo.senderName, 'Trần Bình');

        // "tai lai trang": doc lai tu Cassandra
        const page = await firstPage(binh, GROUP_ID);
        const again = page.items.find(m => m.messageId === reply.messageId);
        assert.deepEqual(again.replyTo.messageId, original.messageId);
        const row = [...ctx.fake.data.messages_by_conversation.values()].find(m => m.message_id === reply.messageId);
        assert.equal(row.reply_to_id, original.messageId, 'lưu ID tin gốc, không chỉ đoạn văn bản');
        assert.equal(row.content, 'Đây là câu trả lời');
    });

    test('tin gốc bị thu hồi: đoạn trích hiển thị đã thu hồi, không lộ nội dung', async () => {
        await binh.del(`/api/v1/conversations/${GROUP_ID}/messages/${original.messageId}?createdAt=${encodeURIComponent(original.createdAt)}`);
        const page = await firstPage(an, GROUP_ID);
        const r = page.items.find(m => m.messageId === reply.messageId);
        assert.equal(r.replyTo.isDeleted, true);
        assert.equal(r.replyTo.excerpt, null);
        assert.equal(JSON.stringify(r).includes('Tin gốc để trả lời'), false);
    });

    test('không trả lời được tin đã thu hồi', async () => {
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, {
            content: 'x', replyTo: { messageId: original.messageId, createdAt: original.createdAt }
        });
        assert.equal(r.status, 400);
        assert.equal(r.body.error.code, 'REPLY_TARGET_RECALLED');
    });

    test('không cho trả lời tin của hội thoại khác (kể cả khi là thành viên cả hai)', async () => {
        const other = await an.post(`/api/v1/conversations/${OTHER_GROUP}/messages`, { content: 'Tin ở nhóm Backend' });
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, {
            content: 'trả lời chéo', replyTo: { messageId: other.body.messageId, createdAt: other.body.createdAt }
        });
        assert.equal(r.status, 404);
        assert.equal(r.body.error.code, 'REPLY_TARGET_NOT_FOUND');
    });

    test('tham chiếu trả lời sai định dạng bị 400', async () => {
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'x', replyTo: { messageId: 'abc', createdAt: 'x' } });
        assert.equal(r.status, 400);
    });
});

// ================= Cam xuc =================
test.describe('Thả cảm xúc', () => {
    let msg;
    test.before(async () => {
        msg = (await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Thả cảm xúc vào đây' })).body;
    });
    const url = () => `/api/v1/conversations/${GROUP_ID}/messages/${msg.messageId}/reaction`;
    const rowsFor = user => [...ctx.fake.data.reactions_by_message.values()].filter(r => r.message_id === msg.messageId && r.user_id === user);

    test('thả, đổi, thả lại cùng emoji: mỗi người đúng 1 bản ghi', async () => {
        const watch = sse(binh);
        await watch.ready;
        let r = await an.put(url(), { emoji: '👍', createdAt: msg.createdAt });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.reactions, [{ emoji: '👍', count: 1, userIds: ['user01'] }]);
        assert.ok(await watch.waitFor('reaction:updated'), 'đồng bộ realtime cho thành viên khác');
        watch.close();

        r = await an.put(url(), { emoji: '❤️', createdAt: msg.createdAt });
        assert.deepEqual(r.body.reactions.map(x => x.emoji), ['❤️']);
        await Promise.all([1, 2, 3].map(() => an.put(url(), { emoji: '❤️', createdAt: msg.createdAt })));
        assert.equal(rowsFor('user01').length, 1, 'không trùng khi bấm nhiều lần / retry');

        await binh.put(url(), { emoji: '❤️', createdAt: msg.createdAt });
        const page = await firstPage(an, GROUP_ID);
        const m = page.items.find(x => x.messageId === msg.messageId);
        assert.deepEqual(m.reactions, [{ emoji: '❤️', count: 2, userIds: ['user01', 'user02'] }]);
    });

    test('gỡ cảm xúc của chính mình', async () => {
        const r = await an.del(`${url()}?createdAt=${encodeURIComponent(msg.createdAt)}`);
        assert.equal(r.status, 200);
        assert.equal(rowsFor('user01').length, 0);
        assert.equal(rowsFor('user02').length, 1, 'không gỡ được của người khác');
    });

    test('emoji ngoài danh sách, người ngoài nhóm, tin không tồn tại', async () => {
        assert.equal((await an.put(url(), { emoji: '💩', createdAt: msg.createdAt })).status, 400);
        assert.equal((await an.put(url(), { emoji: '<script>', createdAt: msg.createdAt })).status, 400);
        const out = await linh.put(url(), { emoji: '👍', createdAt: msg.createdAt });
        assert.equal(out.status, 403);
        assert.equal(out.body.error.code, 'NOT_A_MEMBER');
        const missing = await an.put(url(), { emoji: '👍', createdAt: '2020-01-01T00:00:00.000Z' });
        assert.equal(missing.status, 404);
        assert.equal((await ctx.agent().put(url(), { emoji: '👍', createdAt: msg.createdAt })).status, 401);
    });

    test('không thả cảm xúc vào tin đã thu hồi; tin thu hồi không trả cảm xúc', async () => {
        await binh.del(`/api/v1/conversations/${GROUP_ID}/messages/${msg.messageId}?createdAt=${encodeURIComponent(msg.createdAt)}`);
        const r = await an.put(url(), { emoji: '👍', createdAt: msg.createdAt });
        assert.equal(r.status, 400);
        const page = await firstPage(an, GROUP_ID);
        assert.deepEqual(page.items.find(x => x.messageId === msg.messageId).reactions, []);
    });

    test('đọc cảm xúc của một trang bằng message_id IN (...) trong một partition', () => {
        const q = ctx.fake.log.filter(e => /FROM reactions_by_message/.test(e.query)).pop();
        assert.match(q.query, /WHERE conversation_id = \? AND message_id IN \(/);
    });
});

// ================= Chuyen tiep / Xoa phia toi =================
test.describe('Chuyển tiếp và xóa phía tôi', () => {
    test('chuyển tiếp sang hội thoại khác: đánh dấu forwarded, cần là thành viên cả hai', async () => {
        const src = (await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Nội dung cần chuyển tiếp' })).body;
        const r = await an.post(`/api/v1/conversations/${SMALL_ID}/forward`, {
            source: { conversationId: GROUP_ID, messageId: src.messageId, createdAt: src.createdAt }
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.forwarded, true);
        assert.equal(r.body.content, 'Nội dung cần chuyển tiếp');
        assert.equal(r.body.senderId, 'user01');

        // Linh khong thuoc GROUP_ID -> khong chuyen tiep tin cua nhom do duoc
        const direct = await linh.post('/api/v1/conversations/direct', { targetUserId: 'user01' });
        const denied = await linh.post(`/api/v1/conversations/${direct.body.conversationId}/forward`, {
            source: { conversationId: GROUP_ID, messageId: src.messageId, createdAt: src.createdAt }
        });
        assert.equal(denied.status, 403);
    });

    test('xóa phía tôi: chỉ ẩn với tôi, người khác vẫn thấy; tin của người khác cũng ẩn được', async () => {
        const m = (await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Tin sẽ bị ẩn phía An' })).body;
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages/${m.messageId}/hide`, { createdAt: m.createdAt });
        assert.equal(r.status, 200);
        assert.equal((await firstPage(an, GROUP_ID)).items.some(x => x.messageId === m.messageId), false);
        assert.equal((await firstPage(binh, GROUP_ID)).items.some(x => x.messageId === m.messageId), true);
        const anList = await an.get('/api/v1/me/conversations');
        assert.equal(anList.body.data.find(c => c.conversationId === GROUP_ID).lastMessagePreview, 'Bạn đã xóa một tin nhắn');
        const binhList = await binh.get('/api/v1/me/conversations');
        assert.equal(binhList.body.data.find(c => c.conversationId === GROUP_ID).lastMessagePreview, 'Tin sẽ bị ẩn phía An');
    });

    test('ẩn tin vẫn giữ phân trang: trang báo rowsRead và hiddenCount', async () => {
        const page = await firstPage(an, GROUP_ID);
        assert.equal(page.rowsRead, 20);
        assert.equal(page.count + page.hiddenCount, 20);
        assert.ok(page.nextPageToken);
    });

    test('người ngoài không ẩn được tin của nhóm', async () => {
        const page = await firstPage(an, GROUP_ID);
        const m = page.items[0];
        const r = await linh.post(`/api/v1/conversations/${GROUP_ID}/messages/${m.messageId}/hide`, { createdAt: m.createdAt });
        assert.equal(r.status, 403);
    });
});

// ================= Tep =================
test.describe('Tệp đính kèm', () => {
    let png;

    test('tải ảnh PNG thật lên: PENDING, tên lưu trữ do server sinh, không lưu nội dung vào Cassandra', async () => {
        const r = await upload(an, GROUP_ID, 'anh-demo.png', PNG);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        png = r.body;
        assert.equal(png.kind, 'IMAGE');
        assert.equal(png.mimeType, 'image/png');
        assert.equal(png.status, 'PENDING');
        const row = [...ctx.fake.data.attachments_by_conversation.values()].find(a => a.attachment_id === png.attachmentId);
        assert.match(row.storage_key, /^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
        assert.equal(Object.values(row).some(v => typeof v === 'string' && v.length > 1000), false);
        assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, ...row.storage_key.split('/'))));
    });

    test('tệp PENDING chỉ người tải lên xem được', async () => {
        assert.equal((await download(an, GROUP_ID, png.attachmentId)).status, 200);
        assert.equal((await download(binh, GROUP_ID, png.attachmentId)).status, 404);
    });

    test('gửi tin kèm tệp; thành viên khác tải được, header an toàn', async () => {
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Ảnh đây', attachmentIds: [png.attachmentId] });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.attachments.length, 1);
        assert.equal(r.body.attachments[0].attachmentId, png.attachmentId);
        assert.equal(JSON.stringify(r.body).includes('storage_key') || JSON.stringify(r.body).includes(process.env.UPLOAD_DIR), false);

        const d = await download(binh, GROUP_ID, png.attachmentId, true);
        assert.equal(d.status, 200);
        assert.ok(d.buf.equals(PNG));
        assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
        assert.match(d.headers.get('content-disposition'), /^inline; filename\*=UTF-8''anh-demo\.png/);
        assert.match(d.headers.get('content-security-policy'), /sandbox/);

        const list = await an.get(`/api/v1/conversations/${GROUP_ID}/messages?limit=1`);
        assert.equal(list.body.items[0].attachments[0].fileName, 'anh-demo.png');
    });

    test('không gắn lại tệp đã gửi; không gắn tệp của người khác', async () => {
        const again = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'lại', attachmentIds: [png.attachmentId] });
        assert.equal(again.status, 409);
        const mine = await upload(an, GROUP_ID, 'tai-lieu.pdf', PDF);
        const steal = await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'x', attachmentIds: [mine.body.attachmentId] });
        assert.equal(steal.status, 409);
        const ok = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { attachmentIds: [mine.body.attachmentId] });
        assert.equal(ok.status, 201, 'tin chỉ có tệp, không cần chữ');
        const list = await binh.get('/api/v1/me/conversations');
        assert.equal(list.body.data.find(c => c.conversationId === GROUP_ID).lastMessagePreview, '[Tệp] tai-lieu.pdf');
    });

    test('người ngoài không tải lên / tải xuống / liệt kê được; chưa đăng nhập 401', async () => {
        assert.equal((await upload(linh, GROUP_ID, 'x.png', PNG)).status, 403);
        assert.equal((await download(linh, GROUP_ID, png.attachmentId)).status, 403);
        assert.equal((await linh.get(`/api/v1/conversations/${GROUP_ID}/attachments`)).status, 403);
        const guest = await fetch(`${ctx.baseUrl}/api/v1/conversations/${GROUP_ID}/attachments/${png.attachmentId}/content`);
        assert.equal(guest.status, 401);
    });

    test('tệp không hợp lệ bị từ chối: sai nội dung, định dạng cấm, rỗng, quá lớn', async () => {
        const fake = await upload(an, GROUP_ID, 'gia.png', PDF);
        assert.equal(fake.status, 415);
        assert.equal(fake.body.error.code, 'FILE_TYPE_MISMATCH');
        const svg = await upload(an, GROUP_ID, 'x.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
        assert.equal(svg.status, 415);
        assert.equal(svg.body.error.code, 'FILE_TYPE_NOT_ALLOWED');
        const html = await upload(an, GROUP_ID, 'x.txt.html', Buffer.from('<script>alert(1)</script>'));
        assert.equal(html.status, 415);
        const exe = await upload(an, GROUP_ID, 'virus.exe', Buffer.from('MZ\x90\x00'));
        assert.equal(exe.status, 415);
        assert.equal((await upload(an, GROUP_ID, 'rong.txt', Buffer.alloc(0))).status, 400);
        const big = await upload(an, GROUP_ID, 'lon.txt', Buffer.alloc(20 * 1024 * 1024 + 10, 0x61));
        assert.equal(big.status, 413);
    });

    test('tên tệp có đường dẫn / ký tự điều khiển được làm sạch, không ảnh hưởng nơi lưu', async () => {
        const r = await upload(an, GROUP_ID, '..\\..\\windows/system32/‮bad\u0007.txt', Buffer.from('xin chào'));
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.fileName, 'bad.txt');
        const row = [...ctx.fake.data.attachments_by_conversation.values()].find(a => a.attachment_id === r.body.attachmentId);
        assert.equal(row.storage_key.includes('..'), false);
    });

    test('hủy tệp chưa gửi xóa metadata và tệp trên đĩa; tệp đã gửi không hủy được', async () => {
        const r = await upload(an, GROUP_ID, 'huy.txt', Buffer.from('hủy tôi'));
        const row = [...ctx.fake.data.attachments_by_conversation.values()].find(a => a.attachment_id === r.body.attachmentId);
        const file = path.join(process.env.UPLOAD_DIR, ...row.storage_key.split('/'));
        assert.ok(fs.existsSync(file));
        const c = await an.del(`/api/v1/conversations/${GROUP_ID}/attachments/${r.body.attachmentId}`);
        assert.equal(c.status, 200);
        assert.equal(fs.existsSync(file), false);
        assert.equal((await an.del(`/api/v1/conversations/${GROUP_ID}/attachments/${png.attachmentId}`)).status, 409);
    });

    test('thu hồi tin có tệp: không ai tải được nữa, tin không còn trả tệp', async () => {
        const up = await upload(an, GROUP_ID, 'thu-hoi.png', PNG);
        const m = (await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { attachmentIds: [up.body.attachmentId] })).body;
        assert.equal((await download(binh, GROUP_ID, up.body.attachmentId)).status, 200);
        await an.del(`/api/v1/conversations/${GROUP_ID}/messages/${m.messageId}?createdAt=${encodeURIComponent(m.createdAt)}`);
        assert.equal((await download(binh, GROUP_ID, up.body.attachmentId)).status, 404);
        assert.equal((await download(an, GROUP_ID, up.body.attachmentId)).status, 404);
        const page = await firstPage(binh, GROUP_ID);
        assert.deepEqual(page.items.find(x => x.messageId === m.messageId).attachments, []);
    });

    test('chuyển tiếp tin có tệp: thành viên hội thoại đích tải được qua bản ghi mới', async () => {
        const up = await upload(binh, GROUP_ID, 'chia-se.pdf', PDF);
        const m = (await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { attachmentIds: [up.body.attachmentId] })).body;
        const f = await an.post(`/api/v1/conversations/${SMALL_ID}/forward`, {
            source: { conversationId: GROUP_ID, messageId: m.messageId, createdAt: m.createdAt }
        });
        assert.equal(f.status, 201, JSON.stringify(f.body));
        const copy = f.body.attachments[0];
        assert.notEqual(copy.attachmentId, up.body.attachmentId);
        const d = await download(binh, SMALL_ID, copy.attachmentId);
        assert.equal(d.status, 200);
        assert.ok(d.buf.equals(PDF));
    });

    test('tab ảnh/tệp liệt kê đúng loại, mới nhất trước', async () => {
        const media = await an.get(`/api/v1/conversations/${GROUP_ID}/attachments?kind=media`);
        assert.equal(media.status, 200);
        assert.ok(media.body.items.length >= 1);
        assert.ok(media.body.items.every(i => ['IMAGE', 'VIDEO'].includes(i.kind) && i.status === 'ATTACHED'));
        const files = await an.get(`/api/v1/conversations/${GROUP_ID}/attachments?kind=file`);
        assert.ok(files.body.items.every(i => i.kind === 'FILE'));
    });

    test('tối đa 5 tệp / tin', async () => {
        const ids = [];
        for (let i = 0; i < 6; i++) ids.push((await upload(an, GROUP_ID, `t${i}.txt`, Buffer.from('a' + i))).body.attachmentId);
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { attachmentIds: ids });
        assert.equal(r.status, 400);
        assert.equal(r.body.error.code, 'TOO_MANY_FILES');
    });

    test('tải lên từ Origin lạ bị chặn', async () => {
        const r = await upload(an, GROUP_ID, 'x.png', PNG, { Origin: 'http://evil.example' });
        assert.equal(r.status, 403);
    });

    test('mọi lệnh ghi vào attachments_by_conversation đều là LWT', () => {
        const writes = ctx.fake.log.filter(e => /^(INSERT INTO|UPDATE|DELETE FROM) attachments_by_conversation/.test(e.query));
        assert.ok(writes.length > 5);
        writes.forEach(e => assert.match(e.query, / IF /, e.query));
    });
});

// ================= Realtime: dang nhap, da xem, online, so chua doc =================
test.describe('Đang nhập, đã xem, online, số chưa đọc', () => {
    test('đang nhập chỉ gửi cho thành viên khác; người ngoài bị 403', async () => {
        const watch = sse(binh);
        await watch.ready;
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/typing`);
        assert.equal(r.status, 200);
        assert.ok(await watch.waitFor('event: typing'));
        watch.close();
        assert.equal((await linh.post(`/api/v1/conversations/${GROUP_ID}/typing`)).status, 403);
    });

    test('đã xem: sự kiện read + lastReadAt thật của thành viên trong chi tiết hội thoại', async () => {
        const watch = sse(an);
        await watch.ready;
        await binh.post(`/api/v1/conversations/${SMALL_ID}/read`);
        assert.ok(await watch.waitFor('event: read'));
        watch.close();
        const detail = await an.get(`/api/v1/conversations/${SMALL_ID}`);
        const binhMember = detail.body.members.find(m => m.userId === 'user02');
        assert.ok(binhMember.lastReadAt);
    });

    test('online dựa trên kết nối realtime thật', async () => {
        const watch = sse(binh);
        await watch.ready;
        await new Promise(r => setTimeout(r, 50));
        let detail = await an.get(`/api/v1/conversations/${SMALL_ID}`);
        assert.equal(detail.body.members.find(m => m.userId === 'user02').online, true);
        watch.close();
        await new Promise(r => setTimeout(r, 100));
        detail = await an.get(`/api/v1/conversations/${SMALL_ID}`);
        const b = detail.body.members.find(m => m.userId === 'user02');
        assert.equal(b.online, false);
        assert.ok(b.lastSeenAt);
    });

    test('số tin chưa đọc đếm tin của người khác sau mốc đã đọc; gửi tin của mình không tính', async () => {
        await an.post(`/api/v1/conversations/${SMALL_ID}/read`);
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Một' });
        await binh.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Hai' });
        await an.post(`/api/v1/conversations/${OTHER_GROUP}/messages`, { content: 'tin của tôi ở nhóm khác' });
        const list = await an.get('/api/v1/me/conversations');
        const small = list.body.data.find(c => c.conversationId === SMALL_ID);
        assert.equal(small.unread, true);
        assert.equal(small.unreadCount, 2);
        const backend = list.body.data.find(c => c.conversationId === OTHER_GROUP);
        assert.equal(backend.unread, false);
    });
});

test.describe('Nội dung có HTML được lưu và trả đúng như văn bản', () => {
    test('API trả nguyên chuỗi; frontend hiển thị dạng text (không dangerouslySetInnerHTML)', async () => {
        const xss = '<img src=x onerror=alert(1)>';
        const r = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: xss });
        assert.equal(r.body.content, xss);
        const src = fs.readdirSync(path.resolve(__dirname, '../../frontend/src/components'))
            .map(f => fs.readFileSync(path.resolve(__dirname, '../../frontend/src/components', f), 'utf8')).join('\n');
        assert.equal(src.includes('dangerouslySetInnerHTML'), false);
    });
});
