// NFR-15 (luu tep S3/MinIO), NFR-13 (gioi han toc do qua Redis), POST /auth/password/change (SRS muc 6.3).
// S3: may chu S3 GIA LAP chay that tren cong ngau nhien, KIEM TRA chu ky SigV4 cua tung request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const s3 = require('../src/extensions/lib/s3');

// ===== S3 gia lap (luu object trong bo nho) =====
const objects = new Map();
let s3Down = false;
let badSignatures = 0;
const S3_ENV = { accessKeyId: 'TESTKEYCHATOTT', secretAccessKey: 'test-secret-chi-dung-trong-kiem-thu', region: 'us-east-1' };
const fakeS3 = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (s3Down) { res.writeHead(500); return res.end('<Error><Code>InternalError</Code></Error>'); }
        // Kiem tra chu ky: tinh lai tu header nhan duoc.
        const auth = req.headers.authorization || '';
        const signed = (auth.match(/SignedHeaders=([^,]+)/) || [])[1] || '';
        const headers = Object.fromEntries(signed.split(';').map(h => [h, req.headers[h]]));
        const payloadHash = req.headers['x-amz-content-sha256'];
        const expected = s3.signRequest({ method: req.method, path: req.url, headers, payloadHash, ...S3_ENV });
        const realHash = crypto.createHash('sha256').update(body).digest('hex');
        if (auth !== expected || payloadHash !== realHash) { badSignatures += 1; res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
        const key = decodeURIComponent(req.url);
        if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200); return res.end(); }
        if (req.method === 'GET') {
            if (!objects.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
            res.writeHead(200); return res.end(objects.get(key));
        }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
        res.writeHead(405); return res.end();
    });
});

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-s3-'));
process.env.STORAGE_DRIVER = 's3';
process.env.S3_BUCKET = 'chatott-test';
process.env.S3_ACCESS_KEY_ID = S3_ENV.accessKeyId;
process.env.S3_SECRET_ACCESS_KEY = S3_ENV.secretAccessKey;
process.env.S3_PREFIX = 'chatott/';

const { startTestServer, linkAccount, GROUP_ID } = require('./helpers');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d30000000049454e44ae426082', 'hex');
let ctx, an, binh;

const raw = (agent, url, body, headers = {}) => fetch(ctx.baseUrl + url, {
    method: 'POST', body,
    headers: { Cookie: `chatott_sid=${agent.cookies.chatott_sid}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/octet-stream', ...headers }
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const download = (agent, url) => fetch(ctx.baseUrl + url, { headers: { Cookie: `chatott_sid=${agent.cookies.chatott_sid}` } })
    .then(async r => ({ status: r.status, buf: Buffer.from(await r.arrayBuffer()) }));
const rowOf = aid => [...ctx.fake.data.attachments_by_conversation.values()].find(r => r.attachment_id.toString() === aid);
const localOf = key => path.join(process.env.UPLOAD_DIR, ...key.split('/'));

test.before(async () => {
    await new Promise(r => fakeS3.listen(0, '127.0.0.1', r));
    process.env.S3_ENDPOINT = `http://127.0.0.1:${fakeS3.address().port}`;
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, 'MatKhau123');
    an = ctx.agent();
    await an.post('/api/v1/auth/login', { email: 'an@chatott.demo', password: 'MatKhau123' });
    binh = ctx.agent();
    await binh.post('/api/v1/auth/login', { email: 'binh@chatott.demo', password: 'MatKhau123' });
});
test.after(() => { ctx.server.close(); fakeS3.close(); });

test('SigV4: khớp ví dụ chuẩn trong tài liệu AWS S3 (GET Object có Range)', () => {
    const auth = s3.signRequest({
        method: 'GET', path: '/test.txt', payloadHash: s3.EMPTY_SHA, region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': s3.EMPTY_SHA, 'x-amz-date': '20130524T000000Z' }
    });
    assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
    assert.match(auth, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
});

test('NFR-15 tệp chat: lưu lên S3; mất bộ đệm cục bộ vẫn tải được; hủy tệp xóa trên S3', async () => {
    const up = await raw(an, `/api/v1/conversations/${GROUP_ID}/attachments`, PNG, { 'X-File-Name': 'anh.png' });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const key = rowOf(up.body.attachmentId).storage_key;
    assert.ok(objects.has(`/chatott-test/chatott/${key}`), [...objects.keys()].join(','));
    assert.equal(badSignatures, 0);
    // Gui tin kem tep, xoa ban cuc bo (gia lap backend khac / bo dem bi xoa) -> Binh van tai duoc tu S3.
    const sent = await an.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'ảnh', attachmentIds: [up.body.attachmentId] });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    fs.unlinkSync(localOf(key));
    const dl = await download(binh, `/api/v1/conversations/${GROUP_ID}/attachments/${up.body.attachmentId}/content`);
    assert.equal(dl.status, 200);
    assert.ok(dl.buf.equals(PNG));
    assert.ok(fs.existsSync(localOf(key)), 'tải về lại bộ đệm');

    const tmp = await raw(an, `/api/v1/conversations/${GROUP_ID}/attachments`, PNG, { 'X-File-Name': 'huy.png' });
    const tmpKey = rowOf(tmp.body.attachmentId).storage_key;
    assert.ok(objects.has(`/chatott-test/chatott/${tmpKey}`));
    assert.equal((await an.del(`/api/v1/conversations/${GROUP_ID}/attachments/${tmp.body.attachmentId}`)).status, 200);
    assert.ok(!objects.has(`/chatott-test/chatott/${tmpKey}`), 'hủy tệp -> xóa object');
});

test('NFR-15: S3 lỗi khi tải lên -> 503, không để lại bản ghi tệp', async () => {
    const before = ctx.fake.data.attachments_by_conversation.size;
    s3Down = true;
    try {
        const up = await raw(an, `/api/v1/conversations/${GROUP_ID}/attachments`, PNG, { 'X-File-Name': 'loi.png' });
        assert.equal(up.status, 503);
        assert.equal(up.body.error.code, 'STORAGE_UNAVAILABLE');
        const post = await raw(an, '/api/v1/posts/media', PNG, { 'X-File-Name': 'loi.png' });
        assert.equal(post.status, 503);
    } finally {
        s3Down = false;
    }
    assert.equal(ctx.fake.data.attachments_by_conversation.size, before);
});

test('NFR-15 ảnh bài viết và ảnh đại diện: lưu S3, xóa bộ đệm vẫn xem được', async () => {
    const media = await raw(an, '/api/v1/posts/media', PNG, { 'X-File-Name': 'bai.png' });
    assert.equal(media.status, 201, JSON.stringify(media.body));
    const row = [...ctx.fake.data.post_media.values()].find(r => String(r.media_id) === media.body.mediaId);
    assert.ok(objects.has(`/chatott-test/chatott/posts/${row.storage_key}`));
    const post = await an.post('/api/v1/posts', { privacy: 'PUBLIC', content: 'Ảnh lưu trên MinIO', mediaIds: [media.body.mediaId] });
    assert.equal(post.status, 201, JSON.stringify(post.body));
    fs.unlinkSync(path.join(process.env.UPLOAD_DIR, 'posts', ...row.storage_key.split('/')));
    const img = await download(binh, `/api/v1/posts/${post.body.postId}/media/${media.body.mediaId}`);
    assert.equal(img.status, 200);
    assert.ok(img.buf.equals(PNG));

    const av = await raw(an, '/api/v1/me/avatar', PNG);
    assert.equal(av.status, 201, JSON.stringify(av.body));
    const profileKeys = [...objects.keys()].filter(k => k.startsWith('/chatott-test/chatott/profiles/'));
    assert.equal(profileKeys.length, 1);
    fs.rmSync(path.join(process.env.UPLOAD_DIR, 'profiles'), { recursive: true, force: true });
    const avatar = await download(binh, '/api/v1/users/user01/avatar');
    assert.equal(avatar.status, 200);
    assert.ok(avatar.buf.equals(PNG));
    assert.equal(badSignatures, 0);
});

// ===== NFR-13: Redis gia lap (thuc thi dung logic script Lua: INCR + PEXPIRE + PTTL) =====
function fakeRedis() {
    const store = new Map();
    return {
        isReady: true, fail: false, calls: 0,
        async eval(script, { keys, arguments: args }) {
            this.calls += 1;
            if (this.fail) throw new Error('ECONNREFUSED');
            const now = Date.now();
            let e = store.get(keys[0]);
            if (!e || e.exp <= now) { e = { n: 0, exp: now + Number(args[0]) }; store.set(keys[0], e); }
            e.n += 1;
            return [e.n, e.exp - now];
        }
    };
}

function runLimiter(mw, id) {
    return new Promise(resolve => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
        mw({ id }, res, err => resolve({ err, retry: res.headers['Retry-After'] }));
    });
}

test('NFR-13: hai tiến trình dùng chung bộ đếm Redis; Redis lỗi -> đếm cục bộ, không chặn nhầm', async () => {
    const shared = require('../src/extensions/lib/redisRateLimit');
    const { rateLimit } = require('../src/middleware/security');
    const opts = { windowMs: 60000, max: 3, key: req => req.id, message: 'Chậm lại' };
    const redis = fakeRedis();
    shared.setClient(redis);
    try {
        const p1 = rateLimit(opts);
        assert.equal((await runLimiter(p1, 'u1')).err, undefined);
        assert.equal((await runLimiter(p1, 'u1')).err, undefined);
        // 2 tien trinh: cung ten bo gioi han -> cung khoa Redis; tong so lan vuot max thi bi chan o bat ky tien trinh nao.
        await new Promise(resolve => shared.limit('same', 'u9', opts, { setHeader() {} }, resolve));
        await new Promise(resolve => shared.limit('same', 'u9', opts, { setHeader() {} }, resolve));
        await new Promise(resolve => shared.limit('same', 'u9', opts, { setHeader() {} }, resolve));
        const blocked = await new Promise(resolve => shared.limit('same', 'u9', opts, { setHeader() {} }, resolve));
        assert.equal(blocked.status, 429, 'tiến trình khác dùng cùng khóa -> bị chặn');
        const third = await runLimiter(p1, 'u1');
        assert.equal(third.err, undefined);
        const fourth = await runLimiter(p1, 'u1');
        assert.equal(fourth.err.status, 429);
        assert.ok(Number(fourth.retry) >= 1);
        assert.ok(redis.calls >= 8, 'đếm qua Redis');
        // Redis loi: khong nem loi ra nguoi dung, chuyen sang dem cuc bo.
        redis.fail = true;
        const p2 = rateLimit({ ...opts, message: 'khác' });
        const r = await runLimiter(p2, 'u2');
        assert.equal(r.err, undefined);
    } finally {
        shared.setClient(null);
    }
    // Khong co Redis: hanh vi cu (bo dem trong bo nho).
    const p3 = rateLimit({ ...opts, message: 'không redis' });
    for (let i = 0; i < 3; i++) assert.equal((await runLimiter(p3, 'u3')).err, undefined);
    assert.equal((await runLimiter(p3, 'u3')).err.status, 429);
});

test('SRS 6.3: POST /auth/password/change — sai mật khẩu cũ bị từ chối, đổi xong phiên khác bị hủy', async () => {
    const other = ctx.agent();
    await other.post('/api/v1/auth/login', { email: 'binh@chatott.demo', password: 'MatKhau123' });
    assert.equal((await ctx.agent().post('/api/v1/auth/password/change', { currentPassword: 'x', newPassword: 'MoiMoi123', confirmPassword: 'MoiMoi123' })).status, 401);
    const bad = await binh.post('/api/v1/auth/password/change', { currentPassword: 'SaiMatKhau1', newPassword: 'MoiMoi123', confirmPassword: 'MoiMoi123' });
    assert.equal(bad.body.error.code, 'WRONG_PASSWORD');
    const ok = await binh.post('/api/v1/auth/password/change', { currentPassword: 'MatKhau123', newPassword: 'MoiMoi123', confirmPassword: 'MoiMoi123' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await binh.get('/api/v1/me/conversations')).status, 200);
    assert.equal((await other.get('/api/v1/me/conversations')).status, 401);
    assert.equal((await ctx.agent().post('/api/v1/auth/login', { email: 'binh@chatott.demo', password: 'MoiMoi123' })).status, 200);
});
