// Kiem thu lenh don tep mo coi tren Cassandra GIA LAP + thu muc tam.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-cleanup-'));
const { startTestServer, linkAccount, GROUP_ID } = require('./helpers');
const { runCleanup } = require('../scripts/cleanup-attachments');

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
let ctx, an;

async function upload(name, buf) {
    const res = await fetch(`${ctx.baseUrl}/api/v1/conversations/${GROUP_ID}/attachments`, {
        method: 'POST',
        headers: { Cookie: `chatott_sid=${an.cookies.chatott_sid}`, Origin: 'http://localhost:5173',
            'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
        body: buf
    });
    return res.json();
}
const rowOf = aid => [...ctx.fake.data.attachments_by_conversation.values()].find(r => r.attachment_id.toString() === aid);
const fileOf = row => path.join(process.env.UPLOAD_DIR, ...row.storage_key.split('/'));
const age = row => { row.created_at = new Date(Date.now() - 48 * 3600 * 1000); };

test.before(async () => {
    ctx = await startTestServer();
    await linkAccount(ctx.fake, 'user01', 'an@chatott.demo', 'MatKhau123');
    an = ctx.agent();
    await an.post('/api/v1/auth/login', { email: 'an@chatott.demo', password: 'MatKhau123' });
});
test.after(() => ctx.server.close());

test('dry-run không xóa gì; --apply chỉ xóa tệp mồ côi, giữ tệp đã gửi và tệp PENDING mới', async () => {
    const oldPending = rowOf((await upload('cu.png', PNG)).attachmentId);
    age(oldPending);
    const freshPending = rowOf((await upload('moi.png', PNG)).attachmentId);
    const sentUp = await upload('da-gui.png', PNG);
    await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { attachmentIds: [sentUp.attachmentId] });
    const sent = rowOf(sentUp.attachmentId);
    age(sent);

    // tep tren dia khong co ban ghi + tep .part cu + tep la khong dung ten chuan
    const dir = path.dirname(fileOf(sent));
    const stray = path.join(dir, '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f');
    const part = path.join(dir, '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e.part');
    const foreign = path.join(dir, 'ghi-chu.txt');
    for (const f of [stray, part, foreign]) fs.writeFileSync(f, 'x');
    const past = new Date(Date.now() - 48 * 3600 * 1000);
    for (const f of [stray, part, foreign]) fs.utimesSync(f, past, past);

    const before = ctx.fake.data.attachments_by_conversation.size;
    const dry = await runCleanup({ log: () => {} });
    assert.equal(dry.pendingRemoved, 1);
    assert.equal(dry.filesRemoved, 3);
    assert.equal(ctx.fake.data.attachments_by_conversation.size, before, 'dry-run không ghi Cassandra');
    for (const f of [fileOf(oldPending), stray, part, foreign]) assert.ok(fs.existsSync(f), 'dry-run không xóa tệp');

    const real = await runCleanup({ apply: true, log: () => {} });
    assert.equal(real.pendingRemoved, 1);
    assert.equal(rowOf(oldPending.attachment_id.toString()), undefined);
    assert.equal(fs.existsSync(fileOf(oldPending)), false);
    assert.equal(fs.existsSync(stray), false);
    assert.equal(fs.existsSync(part), false);
    assert.ok(fs.existsSync(foreign), 'không đụng tệp không do ứng dụng tạo');
    assert.ok(fs.existsSync(fileOf(sent)), 'giữ tệp đã gửi');
    assert.ok(fs.existsSync(fileOf(freshPending)), 'giữ tệp PENDING mới');
    assert.equal(rowOf(sent.attachment_id.toString()).status, 'ATTACHED');

    const again = await runCleanup({ apply: true, log: () => {} });
    assert.equal(again.pendingRemoved + again.filesRemoved, 0, 'chạy lại không làm gì thêm');
});

test('ATTACHING kẹt: có tin thì hoàn tất ATTACHED, không có tin thì dọn', async () => {
    const a = rowOf((await upload('ket-1.png', PNG)).attachmentId);
    const b = rowOf((await upload('ket-2.png', PNG)).attachmentId);
    const m = (await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'có tin' })).body;
    Object.assign(a, { status: 'ATTACHING', message_id: m.messageId, message_created_at: new Date(m.createdAt) });
    Object.assign(b, { status: 'ATTACHING', message_id: a.attachment_id, message_created_at: new Date('2020-01-01') });
    age(a); age(b);
    const r = await runCleanup({ apply: true, log: () => {} });
    assert.equal(r.attachingFinalized, 1);
    assert.equal(r.attachingRemoved, 1);
    assert.equal(rowOf(a.attachment_id.toString()).status, 'ATTACHED');
    assert.ok(fs.existsSync(fileOf(a)));
    assert.equal(fs.existsSync(fileOf(b)), false);
});

test('lệnh ghi của cleanup đều là LWT', () => {
    ctx.fake.log.filter(e => /^(UPDATE|DELETE FROM) attachments_by_conversation/.test(e.query.trim()))
        .forEach(e => assert.match(e.query, / IF /));
});

test('ảnh bài viết: PENDING cũ bị dọn, ảnh đã đăng giữ nguyên; dry-run không xóa', async () => {
    const PNG2 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const up = async () => (await fetch(`${ctx.baseUrl}/api/v1/posts/media`, {
        method: 'POST', body: PNG2,
        headers: { Cookie: `chatott_sid=${an.cookies.chatott_sid}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.png' }
    })).json();
    const stale = await up();
    const used = await up();
    await an.post('/api/v1/posts', { privacy: 'PUBLIC', mediaIds: [used.mediaId] });
    const rowOfMedia = id => [...ctx.fake.data.post_media.values()].find(r => String(r.media_id) === id);
    const fileOfMedia = row => path.join(process.env.UPLOAD_DIR, 'posts', ...row.storage_key.split('/'));
    const staleRow = rowOfMedia(stale.mediaId);
    const usedRow = rowOfMedia(used.mediaId);
    staleRow.created_at = Date.now() - 48 * 3600 * 1000;
    usedRow.created_at = Date.now() - 48 * 3600 * 1000;
    const dry = await runCleanup({ log: () => {} });
    assert.equal(dry.postMediaPendingRemoved, 1);
    assert.ok(fs.existsSync(fileOfMedia(staleRow)));
    await runCleanup({ apply: true, log: () => {} });
    assert.equal(rowOfMedia(stale.mediaId), undefined);
    assert.equal(fs.existsSync(fileOfMedia(staleRow)), false);
    assert.ok(fs.existsSync(fileOfMedia(usedRow)), 'ảnh đã đăng giữ nguyên');
});
