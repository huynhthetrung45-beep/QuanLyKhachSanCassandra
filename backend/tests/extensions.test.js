// Kiem thu cac chuc nang moi (PT-01..PT-26, NFR-16/18) tren Cassandra GIA LAP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SEND_RATE_LIMIT = '1000';
process.env.ACCOUNT_RATE_LIMIT = '1000';
process.env.FORGOT_RATE_LIMIT = '1000';
process.env.ADMIN_EMAILS = 'an@chatott.demo';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chatott-ext-'));
const { startTestServer, linkAccount, GROUP_ID, SMALL_ID } = require('./helpers');
const { createSchemaStub } = require('./schemaStub');
const { runMigration } = require('../scripts/migrate');
const totp = require('../src/extensions/lib/totp');
const mailer = require('../src/extensions/lib/mailer');

const PW = 'MatKhau123';
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
let ctx;
const login = async (email, password = PW) => {
    const a = ctx.agent();
    const r = await a.post('/api/v1/auth/login', { email, password });
    assert.equal(r.status, 200, `đăng nhập ${email}: ${JSON.stringify(r.body)}`);
    await tick();
    return a;
};
const raw = (agent, url, buffer, headers = {}) => fetch(ctx.baseUrl + url, {
    method: 'POST', body: buffer,
    headers: { Origin: 'http://localhost:5173', Cookie: `chatott_sid=${agent.cookies.chatott_sid}`, 'Content-Type': 'application/octet-stream', ...headers }
}).then(async res => ({ status: res.status, body: await res.json().catch(() => null) }));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

const ACCOUNTS = [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user04', 'dung'], ['user05', 'giang'], ['user06', 'huy'], ['user07', 'linh'], ['user08', 'minh']];

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of ACCOUNTS) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
});
test.after(() => ctx.server.close());

test('migration 009-012: chỉ tạo bảng mới, không ghi bảng cũ, chạy lại = 0 lệnh ghi', async () => {
    const dir = path.resolve(__dirname, '../../db/migrations');
    const upto008 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-upto008-'));
    fs.readdirSync(dir).filter(f => f < '009').forEach(f => fs.copyFileSync(path.join(dir, f), path.join(upto008, f)));
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {}, migrationsDir: upto008 });
    const extTables = require('../src/extensions').REQUIRED_TABLES;
    const snap = () => JSON.stringify(Object.fromEntries(Object.entries(client.fake.data).filter(([k]) => !extTables.includes(k)).map(([k, v]) => [k, [...v.values()]])));
    const before = snap();
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {} });
    assert.deepEqual([...r.created].sort(), [...extTables].sort());
    assert.equal(snap(), before);
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {} });
    assert.equal(again.executedWrites, 0);
});

test('PT-01 đổi mật khẩu: sai mật khẩu cũ bị từ chối; đổi xong phiên khác bị hủy, phiên hiện tại giữ', async () => {
    const a1 = await login('huy@chatott.demo');
    const a2 = await login('huy@chatott.demo');
    assert.equal((await a2.get('/api/v1/me/conversations')).status, 200);
    const bad = await a1.post('/api/v1/me/password', { currentPassword: 'SaiMatKhau1', newPassword: 'MoiMoi123', confirmPassword: 'MoiMoi123' });
    assert.equal(bad.body.error.code, 'WRONG_PASSWORD');
    const ok = await a1.post('/api/v1/me/password', { currentPassword: PW, newPassword: 'MoiMoi123', confirmPassword: 'MoiMoi123' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await a1.get('/api/v1/me/conversations')).status, 200, 'phiên hiện tại vẫn dùng được');
    assert.equal((await a2.get('/api/v1/me/conversations')).status, 401, 'phiên khác bị đăng xuất');
    assert.equal((await ctx.agent().post('/api/v1/auth/login', { email: 'huy@chatott.demo', password: PW })).status, 401);
    await login('huy@chatott.demo', 'MoiMoi123');
});

test('PT-02 quên mật khẩu: không lộ email; link dùng một lần; đăng nhập bằng mật khẩu mới', async () => {
    const anon = ctx.agent();
    const ghost = await anon.post('/api/v1/auth/password/forgot', { email: 'khongco@chatott.demo' });
    const real = await anon.post('/api/v1/auth/password/forgot', { email: 'minh@chatott.demo' });
    assert.equal(ghost.status, 200);
    assert.equal(ghost.body.message, real.body.message, 'cùng một thông báo');
    const mail = mailer.sentMails().reverse().find(m => m.to === 'minh@chatott.demo');
    const token = /reset=([A-Za-z0-9_-]+)/.exec(mail.text)[1];
    const r = await anon.post('/api/v1/auth/password/reset', { token, newPassword: 'DatLai123', confirmPassword: 'DatLai123' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const reuse = await anon.post('/api/v1/auth/password/reset', { token, newPassword: 'DatLai456', confirmPassword: 'DatLai456' });
    assert.equal(reuse.body.error.code, 'INVALID_RESET_TOKEN');
    await login('minh@chatott.demo', 'DatLai123');
});

test('PT-03 đổi tên hiển thị: chỉ mục tìm tên cập nhật, hội thoại 1-1 hiện tên mới', async () => {
    const binh = await login('binh@chatott.demo');
    const an = await login('an@chatott.demo');
    const r = await binh.patch('/api/v1/me/display-name', { displayName: 'Trần Bình Minh Quân' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const found = await an.get('/api/v1/users/search?q=quan');
    assert.ok(found.body.data.some(u => u.userId === 'user02'));
    const list = await an.get('/api/v1/me/conversations');
    assert.equal(list.body.data.find(c => c.conversationId === SMALL_ID).displayName, 'Trần Bình Minh Quân');
    await binh.patch('/api/v1/me/display-name', { displayName: 'Trần Bình' });
});

test('PT-04 ảnh đại diện: tải PNG, tra cứu url, tải về; từ chối tệp không phải ảnh', async () => {
    const chi = await login('chi@chatott.demo');
    const up = await raw(chi, '/api/v1/me/avatar', PNG);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const look = await chi.get('/api/v1/avatars?ids=user03,user04');
    assert.match(look.body.avatars.user03, /\/api\/v1\/users\/user03\/avatar\?v=/);
    assert.equal(look.body.avatars.user04, null);
    const img = await fetch(ctx.baseUrl + '/api/v1/users/user03/avatar', { headers: { Cookie: `chatott_sid=${chi.cookies.chatott_sid}` } });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const bad = await raw(chi, '/api/v1/me/avatar', Buffer.from('<svg></svg>'));
    assert.equal(bad.status, 415);
});

test('PT-06 sửa tin trong 15 phút: lịch sử, nhãn đã sửa trong danh sách; người khác không sửa được', async () => {
    const an = await login('an@chatott.demo');
    const binh = await login('binh@chatott.demo');
    const m = (await an.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Họp lúc 9h' })).body;
    const r = await an.patch(`/api/v1/conversations/${SMALL_ID}/messages/${m.messageId}`, { createdAt: m.createdAt, content: 'Họp lúc 10h' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const forbid = await binh.patch(`/api/v1/conversations/${SMALL_ID}/messages/${m.messageId}`, { createdAt: m.createdAt, content: 'hack' });
    assert.equal(forbid.status, 403);
    const page = await binh.get(`/api/v1/conversations/${SMALL_ID}/messages`);
    const item = page.body.items.find(x => x.messageId === m.messageId);
    assert.equal(item.content, 'Họp lúc 10h');
    assert.ok(item.extra.editedAt);
    const hist = await binh.get(`/api/v1/conversations/${SMALL_ID}/messages/${m.messageId}/edits`);
    assert.equal(hist.body.items[0].previousContent, 'Họp lúc 9h');
    const search = await an.get(`/api/v1/search/messages?q=10h&conversationId=${SMALL_ID}`);
    assert.equal(search.status, 200);
});

test('PT-05 vai trò: nhận quyền nhóm cũ, bổ nhiệm phó nhóm, phó nhóm đổi tên/xóa thành viên, chuyển quyền', async () => {
    const an = await login('an@chatott.demo');
    const binh = await login('binh@chatott.demo');
    const roles0 = await an.get(`/api/v1/conversations/${GROUP_ID}/roles`);
    assert.equal(roles0.body.canClaimOwner, true);
    assert.equal((await an.post(`/api/v1/conversations/${GROUP_ID}/claim-owner`)).status, 200);
    assert.equal((await binh.post(`/api/v1/conversations/${GROUP_ID}/claim-owner`)).status, 409);
    const dep = await an.put(`/api/v1/conversations/${GROUP_ID}/members/user02/role`, { role: 'DEPUTY' });
    assert.equal(dep.body.roles.user02, 'DEPUTY');
    const rename = await binh.patch(`/api/v1/conversations/${GROUP_ID}`, { name: 'Nhóm NoSQL (phó nhóm đổi)' });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    assert.equal(rename.body.conversationName, 'Nhóm NoSQL (phó nhóm đổi)');
    assert.equal((await binh.del(`/api/v1/conversations/${GROUP_ID}/members/user01`)).status, 403, 'phó nhóm không xóa trưởng nhóm');
    const kick = await binh.del(`/api/v1/conversations/${GROUP_ID}/members/user05`);
    assert.equal(kick.status, 200);
    assert.ok(!kick.body.participantIds.includes('user05'));
    const transfer = await an.put(`/api/v1/conversations/${GROUP_ID}/members/user02/role`, { role: 'OWNER' });
    assert.equal(transfer.body.ownerId, 'user02');
    assert.equal(transfer.body.roles.user01, 'DEPUTY');
});

test('PT-10, PT-11: mô tả nhóm; tắt thông báo -> không có thông báo tin nhắn; lưu trữ', async () => {
    const binh = await login('binh@chatott.demo');
    const chi = await login('chi@chatott.demo');
    const p = await binh.patch(`/api/v1/conversations/${GROUP_ID}/profile`, { description: 'Nhóm làm đồ án Cassandra' });
    assert.equal(p.body.description, 'Nhóm làm đồ án Cassandra');
    assert.equal((await chi.patch(`/api/v1/conversations/${GROUP_ID}/profile`, { description: 'x' })).status, 403);
    await chi.put(`/api/v1/conversations/${GROUP_ID}/prefs`, { mute: '8h', archived: true });
    const prefs = await chi.get('/api/v1/me/conversation-prefs');
    const pref = prefs.body.items.find(x => x.conversationId === GROUP_ID);
    assert.equal(pref.muted, true);
    assert.equal(pref.archived, true);
    await chi.post('/api/v1/notifications/read-all');
    await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: 'Tin trong lúc chi tắt thông báo' });
    await tick();
    assert.equal((await chi.get('/api/v1/notifications/unread-count')).body.unreadCount, 0);
    await chi.put(`/api/v1/conversations/${GROUP_ID}/prefs`, { mute: 'off' });
});

test('PT-13 @mention: người được nhắc nhận thông báo MENTION và thấy trong danh sách nhắc', async () => {
    const binh = await login('binh@chatott.demo');
    const chi = await login('chi@chatott.demo');
    const m = await binh.post(`/api/v1/conversations/${GROUP_ID}/messages`, { content: '@Lê Chi xem giúp mình', mentions: ['user03'] });
    assert.equal(m.status, 201);
    await tick(80);
    const notifs = await chi.get('/api/v1/notifications');
    assert.ok(notifs.body.items.some(n => n.type === 'MENTION'));
    assert.ok((await chi.get('/api/v1/me/mentions')).body.items.some(x => x.messageId === m.body.messageId));
    const page = await chi.get(`/api/v1/conversations/${GROUP_ID}/messages`);
    assert.deepEqual(page.body.items.find(x => x.messageId === m.body.messageId).extra.mentions, ['user03']);
});

test('PT-20, PT-21: bình chọn (bỏ phiếu, kết quả), sticker', async () => {
    const binh = await login('binh@chatott.demo');
    const chi = await login('chi@chatott.demo');
    const poll = await binh.post(`/api/v1/conversations/${GROUP_ID}/polls`, { question: 'Họp ngày nào?', options: ['Thứ 2', 'Thứ 4'] });
    assert.equal(poll.status, 201, JSON.stringify(poll.body));
    assert.deepEqual(poll.body.extra.poll.options.map(o => o.text), ['Thứ 2', 'Thứ 4']);
    const pid = poll.body.extra.poll.pollId;
    const v = await chi.put(`/api/v1/conversations/${GROUP_ID}/polls/${pid}/vote`, { choices: [1] });
    assert.equal(v.body.options[1].count, 1);
    assert.deepEqual(v.body.myChoices, [1]);
    assert.equal((await chi.put(`/api/v1/conversations/${GROUP_ID}/polls/${pid}/vote`, { choices: [0, 1] })).status, 400);
    assert.equal((await binh.post(`/api/v1/conversations/${SMALL_ID}/polls`, { question: 'x', options: ['a', 'b'] })).status, 400, 'chỉ trong nhóm');
    const st = await chi.post(`/api/v1/conversations/${GROUP_ID}/stickers`, { stickerId: 'hello' });
    assert.equal(st.body.extra.sticker.id, 'hello');
});

test('PT-12 tin nhắn thoại: tải WEBM, tin có tệp AUDIO; từ chối định dạng lạ', async () => {
    const an = await login('an@chatott.demo');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 2)]);
    const r = await raw(an, `/api/v1/conversations/${SMALL_ID}/voice`, webm, { 'X-Duration-Ms': '4200' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.attachments[0].kind, 'AUDIO');
    assert.equal(r.body.extra.voiceMs, 4200);
    assert.equal((await raw(an, `/api/v1/conversations/${SMALL_ID}/voice`, Buffer.alloc(50, 3), { 'X-Duration-Ms': '1000' })).status, 415);
});

test('PT-19 link mời: tham gia trực tiếp và cần duyệt', async () => {
    const an = await login('an@chatott.demo');
    const linh = await login('linh@chatott.demo');
    const g = await an.post('/api/v1/conversations/groups', { name: 'Nhóm link mời', memberIds: ['user02', 'user03'] });
    const cid = g.body.conversationId;
    const inv = await an.post(`/api/v1/conversations/${cid}/invites`, {});
    const code = inv.body.items[0].code;
    const preview = await linh.get(`/api/v1/invites/${code}`);
    assert.equal(preview.body.isMember, false);
    assert.equal((await linh.post(`/api/v1/invites/${code}/join`)).body.joined, true);
    const strict = await an.post(`/api/v1/conversations/${cid}/invites`, { requireApproval: true });
    const code2 = strict.body.items.find(i => i.requireApproval).code;
    const dung = await login('dung@chatott.demo');
    assert.equal((await dung.post(`/api/v1/invites/${code2}/join`)).body.pending, true);
    assert.equal((await dung.get(`/api/v1/conversations/${cid}`)).status, 403);
    const approved = await an.post(`/api/v1/conversations/${cid}/join-requests/user04/approve`);
    assert.equal(approved.body.requests.length, 0);
    assert.equal((await dung.get(`/api/v1/conversations/${cid}`)).status, 200);
    await an.del(`/api/v1/conversations/${cid}/invites/${code}`);
    assert.equal((await ctx.agent().get(`/api/v1/invites/${code}`)).status, 401);
    assert.equal((await dung.get(`/api/v1/invites/${code}`)).status, 404, 'link đã thu hồi');
});

test('PT-22, PT-24: lưu bài, hashtag', async () => {
    const an = await login('an@chatott.demo');
    const binh = await login('binh@chatott.demo');
    const post = await an.post('/api/v1/posts', { content: 'Học #Cassandra và #NoSQL cùng nhau', privacy: 'PUBLIC' });
    assert.equal(post.status, 201);
    await tick(50);
    await binh.put(`/api/v1/posts/${post.body.postId}/save`);
    const saved = await binh.get('/api/v1/me/saved-posts');
    assert.equal(saved.body.items[0].postId, post.body.postId);
    const one = await binh.get(`/api/v1/posts/${post.body.postId}`);
    assert.equal(one.body.saved, true);
    assert.deepEqual(one.body.hashtags, ['cassandra', 'nosql']);
    const tag = await binh.get('/api/v1/hashtags/cassandra/posts');
    assert.equal(tag.body.items[0].postId, post.body.postId);
    await binh.del(`/api/v1/posts/${post.body.postId}/save`);
    assert.equal((await binh.get('/api/v1/me/saved-posts')).body.items.length, 0);
});

test('PT-23 story 24 giờ: bạn bè xem được, người lạ không; đếm lượt xem', async () => {
    const giang = await login('giang@chatott.demo');
    const dung = await login('dung@chatott.demo');
    const linh = await login('linh@chatott.demo');
    await giang.post('/api/v1/friends/requests', { targetUserId: 'user04' });
    await dung.post('/api/v1/friends/requests/user05/accept');
    const s = await giang.post('/api/v1/stories', { content: 'Chào buổi sáng', background: 'sunset' });
    assert.equal(s.status, 201);
    const feed = await dung.get('/api/v1/stories');
    const grp = feed.body.groups.find(gr => gr.author.userId === 'user05');
    assert.equal(grp.items[0].content, 'Chào buổi sáng');
    await dung.post(`/api/v1/stories/user05/${s.body.storyId}/view`);
    assert.equal((await giang.get(`/api/v1/stories/mine/${s.body.storyId}/viewers`)).body.items[0].userId, 'user04');
    assert.ok(!(await linh.get('/api/v1/stories')).body.groups.some(gr => gr.author.userId === 'user05'));
    assert.equal((await linh.post(`/api/v1/stories/user05/${s.body.storyId}/view`)).status, 404);
});

test('PT-18 gợi ý kết bạn theo số bạn chung', async () => {
    const giang = await login('giang@chatott.demo');
    const linh = await login('linh@chatott.demo');
    await linh.post('/api/v1/friends/requests', { targetUserId: 'user05' });
    await giang.post('/api/v1/friends/requests/user07/accept');
    const sug = await linh.get('/api/v1/friends/suggestions');
    const d = sug.body.data.find(x => x.userId === 'user04');
    assert.ok(d, JSON.stringify(sug.body));
    assert.equal(d.mutualCount, 1);
});

test('PT-25 cài đặt thông báo: tắt loại FRIEND_REQUEST', async () => {
    const huyNew = await login('huy@chatott.demo', 'MoiMoi123');
    const chi = await login('chi@chatott.demo');
    await huyNew.put('/api/v1/me/notification-settings', { types: { FRIEND_REQUEST: false } });
    await huyNew.post('/api/v1/notifications/read-all');
    await chi.post('/api/v1/friends/requests', { targetUserId: 'user06' });
    await tick();
    assert.equal((await huyNew.get('/api/v1/notifications/unread-count')).body.unreadCount, 0);
    assert.equal((await huyNew.get('/api/v1/me/notification-settings')).body.types.FRIEND_REQUEST, false);
});

test('PT-07, PT-08: báo cáo bài, admin ẩn & khôi phục; khóa tài khoản hủy phiên và chặn đăng nhập', async () => {
    const an = await login('an@chatott.demo');
    const chi = await login('chi@chatott.demo');
    const linh = await login('linh@chatott.demo');
    assert.equal((await chi.get('/api/v1/admin/overview')).status, 403);
    const post = await linh.post('/api/v1/posts', { content: 'Quảng cáo lừa đảo', privacy: 'PUBLIC' });
    const rep = await chi.post('/api/v1/reports', { targetType: 'POST', targetId: post.body.postId, reason: 'SCAM' });
    assert.equal(rep.status, 201, JSON.stringify(rep.body));
    assert.equal((await chi.post('/api/v1/reports', { targetType: 'POST', targetId: post.body.postId, reason: 'SCAM' })).body.duplicate, true);
    const sec = await an.get('/api/v1/me/security');
    assert.equal(sec.body.isAdmin, true);
    const list = await an.get('/api/v1/admin/reports?status=OPEN');
    assert.ok(list.body.items.some(r => r.reportId === rep.body.reportId));
    await an.post(`/api/v1/admin/reports/${rep.body.reportId}/resolve`, { action: 'HIDE', note: 'Lừa đảo' });
    assert.equal((await chi.get(`/api/v1/posts/${post.body.postId}`)).status, 404, 'bài đã bị ẩn');
    await an.post('/api/v1/admin/content/restore', { targetType: 'POST', targetId: post.body.postId });
    assert.equal((await chi.get(`/api/v1/posts/${post.body.postId}`)).status, 200, 'đã khôi phục');
    const lock = await an.post('/api/v1/admin/users/user07/lock', { reason: 'Spam' });
    assert.equal(lock.status, 200, JSON.stringify(lock.body));
    assert.equal((await linh.get('/api/v1/me/conversations')).status, 401);
    const relog = await ctx.agent().post('/api/v1/auth/login', { email: 'linh@chatott.demo', password: PW });
    assert.equal(relog.body.error.code, 'ACCOUNT_DISABLED');
    await an.post('/api/v1/admin/users/user07/unlock');
    await login('linh@chatott.demo');
    const overview = await an.get('/api/v1/admin/overview');
    assert.equal(overview.body.users, 8);
    assert.ok(overview.body.messagesPerDay.length === 14);
    assert.ok((await an.get('/api/v1/admin/moderation-log')).body.items.length >= 3);
});

test('PT-17 thiết bị: liệt kê phiên, đăng xuất từ xa', async () => {
    const a1 = await login('dung@chatott.demo');
    const a2 = await login('dung@chatott.demo');
    await a2.get('/api/v1/me/conversations');
    await tick();
    const list = await a1.get('/api/v1/me/sessions');
    const other = list.body.items.find(s => !s.current);
    assert.ok(other);
    assert.equal((await a1.del(`/api/v1/me/sessions/${other.sessionId}`)).status, 200);
    assert.equal((await a2.get('/api/v1/me/conversations')).status, 401);
});

test('NFR-16 2FA TOTP: bật, phiên mới phải nhập mã, nhập đúng thì dùng được', async () => {
    const a = await login('giang@chatott.demo');
    const setup = await a.post('/api/v1/me/2fa/setup');
    const code = () => totp.codeAt(setup.body.secret, Math.floor(Date.now() / 30000));
    assert.equal((await a.post('/api/v1/me/2fa/enable', { code: '000000' === code() ? '111111' : '000000' })).status, 400);
    assert.equal((await a.post('/api/v1/me/2fa/enable', { code: code() })).status, 200);
    assert.equal((await a.get('/api/v1/me/conversations')).status, 200, 'phiên vừa bật vẫn dùng được');
    const b = await login('giang@chatott.demo');
    const blocked = await b.get('/api/v1/me/conversations');
    assert.equal(blocked.body.error.code, 'TWO_FACTOR_REQUIRED');
    assert.equal((await b.get('/api/v1/auth/me')).status, 403);
    assert.equal((await b.post('/api/v1/auth/2fa/verify', { code: code() })).status, 200);
    assert.equal((await b.get('/api/v1/me/conversations')).status, 200);
    await a.post('/api/v1/me/2fa/disable', { code: code() });
});

test('PT-09 xác minh email bằng mã 6 số', async () => {
    const a = await login('dung@chatott.demo');
    const r = await a.post('/api/v1/me/email/verification');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mail = mailer.sentMails().reverse().find(m => m.to === 'dung@chatott.demo');
    const code = /(\d{6})/.exec(mail.text)[1];
    assert.equal((await a.post('/api/v1/me/email/verify', { code: '999999' === code ? '000000' : '999999' })).status, 400);
    assert.equal((await a.post('/api/v1/me/email/verify', { code })).status, 200);
    assert.equal((await a.get('/api/v1/me/security')).body.emailVerified, true);
});

test('PT-26 AI gợi ý trả lời và dịch (provider giả lập)', async () => {
    require('../src/extensions/ai-extras.service').setProvider(async ({ system }) => (/gợi ý/i.test(system)
        ? '{"suggestions":["Ok bạn","Để mình xem","Cảm ơn nhé"]}' : '{"translation":"Meeting at 10","sourceLang":"vi"}'));
    const an = await login('an@chatott.demo');
    const s = await an.post(`/api/v1/conversations/${SMALL_ID}/ai/reply-suggestions`);
    assert.equal(s.body.suggestions.length, 3);
    const m = (await an.post(`/api/v1/conversations/${SMALL_ID}/messages`, { content: 'Họp lúc 10h' })).body;
    const t = await an.post(`/api/v1/conversations/${SMALL_ID}/messages/${m.messageId}/translate`, { createdAt: m.createdAt, targetLang: 'en' });
    assert.equal(t.body.translation, 'Meeting at 10');
});

test('PT-15 nhắc hạn công việc AI đã xác nhận', async () => {
    const { TimeUuid } = require('cassandra-driver').types;
    const notifyx = require('../src/extensions/notify-extras.service');
    const { localParts } = require('../src/utils/searchTerms');
    const tid = TimeUuid.now();
    ctx.fake.seedRow('ai_tasks_by_conversation', {
        conversation_id: SMALL_ID, task_id: tid, title: 'Nộp báo cáo', assignee_id: 'user02', due_date: localParts(Date.now()).day, status: 'SUGGESTED'
    });
    const an = await login('an@chatott.demo');
    const binh = await login('binh@chatott.demo');
    await binh.post('/api/v1/notifications/read-all');
    const r = await an.patch(`/api/v1/conversations/${SMALL_ID}/ai/tasks/${tid}`, { status: 'CONFIRMED' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await tick(50);
    const run = await notifyx.runReminders();
    assert.equal(run.sent, 1);
    assert.equal((await notifyx.runReminders()).sent, 0, 'không nhắc lặp');
    const n = await binh.get('/api/v1/notifications');
    assert.ok(n.body.items.some(x => x.type === 'TASK_DUE'));
});

test('NFR-18 /metrics theo định dạng Prometheus', async () => {
    const res = await fetch(ctx.baseUrl + '/metrics');
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /chatott_http_requests_total\{method="GET"/);
    assert.match(text, /chatott_sse_connections \d+/);
});

// ===== Bo sung: thong bao ban be dang bai / tin, cam xuc - tra loi - chia se tin, tro ly Gemini =====
test('Thông báo bạn bè: đăng bài (Công khai/Bạn bè) và đăng tin; bài Riêng tư không thông báo', async () => {
    const binh = await login('binh@chatott.demo');
    const chi = await login('chi@chatott.demo');
    await binh.post('/api/v1/friends/requests', { targetUserId: 'user03' });
    await chi.post('/api/v1/friends/requests/user02/accept');
    await chi.post('/api/v1/notifications/read-all');
    const post = await binh.post('/api/v1/posts', { content: 'Bài mới cho bạn bè', privacy: 'FRIENDS' });
    await binh.post('/api/v1/posts', { content: 'Bài riêng tư', privacy: 'PRIVATE' });
    await tick(80);
    const list = (await chi.get('/api/v1/notifications')).body.items;
    const fp = list.filter(n => n.type === 'FRIEND_POST');
    assert.equal(fp.length, 1, 'chỉ 1 thông báo (bài riêng tư không thông báo)');
    assert.equal(fp[0].postId, post.body.postId);
    assert.equal(fp[0].actor.userId, 'user02');
    await binh.post('/api/v1/stories', { content: 'Tin thứ nhất' });
    await binh.post('/api/v1/stories', { content: 'Tin thứ hai' });
    await tick(80);
    const fs2 = (await chi.get('/api/v1/notifications')).body.items.filter(n => n.type === 'FRIEND_STORY');
    assert.equal(fs2.length, 1, 'tối đa 1 thông báo đăng tin / ngày');
});

test('Tin: kiểu chữ, cảm xúc, trả lời bằng tin nhắn, chia sẻ lên tin của mình và vào chat', async () => {
    const binh = await login('binh@chatott.demo');
    const chi = await login('chi@chatott.demo');
    const s = await binh.post('/api/v1/stories', { content: 'Tin có kiểu chữ', background: 'ocean', font: 'headline', textColor: '#ffee00', textAlign: 'left' });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    assert.equal(s.body.font, 'headline');
    assert.equal(s.body.textColor, '#ffee00');
    const sid = s.body.storyId;
    assert.equal((await chi.put(`/api/v1/stories/user02/${sid}/reaction`, { reaction: 'LOVE' })).body.reaction, 'LOVE');
    assert.equal((await binh.put(`/api/v1/stories/user02/${sid}/reaction`, { reaction: 'LOVE' })).status, 400, 'không tự thả cảm xúc');
    const viewers = await binh.get(`/api/v1/stories/mine/${sid}/viewers`);
    assert.equal(viewers.body.items.find(v => v.userId === 'user03').reaction, 'LOVE');
    await tick(50);
    assert.ok((await binh.get('/api/v1/notifications')).body.items.some(n => n.type === 'STORY_REACTION'));
    const reply = await chi.post(`/api/v1/stories/user02/${sid}/reply`, { content: 'Đẹp quá!' });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const msgs = await binh.get(`/api/v1/conversations/${reply.body.conversationId}/messages`);
    assert.match(msgs.body.items[0].content, /Trả lời tin “Tin có kiểu chữ”: Đẹp quá!/);
    const re = await chi.post(`/api/v1/stories/user02/${sid}/share`, { target: 'story' });
    assert.equal(re.body.story.sharedFrom.userId, 'user02');
    assert.equal(re.body.story.font, 'headline');
    const toChat = await chi.post(`/api/v1/stories/user02/${sid}/share`, { target: 'chat', conversationId: GROUP_ID });
    assert.equal(toChat.status, 201, JSON.stringify(toChat.body));
    const feed = await chi.get('/api/v1/stories');
    const binhGroup = feed.body.groups.find(g => g.author.userId === 'user02');
    assert.equal(binhGroup.items.find(i => i.storyId === sid).myReaction, 'LOVE');
    const linh = await login('linh@chatott.demo');
    assert.equal((await linh.put(`/api/v1/stories/user02/${sid}/reaction`, { reaction: 'LIKE' })).status, 404, 'người không phải bạn bè');
});

test('Trợ lý AI Gemini: chưa có khóa -> 503; có khóa -> trả lời, lưu lịch sử, gửi kèm ngữ cảnh, xóa lịch sử', async () => {
    const gemini = require('../src/extensions/lib/gemini');
    const an = await login('an@chatott.demo');
    const before = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    gemini.setGenerator(null);
    assert.equal((await an.get('/api/v1/assistant')).body.configured, false);
    assert.equal((await an.post('/api/v1/assistant/messages', { content: 'Xin chào' })).status, 503);
    const seen = [];
    gemini.setGenerator(async ({ system, messages }) => { seen.push({ system, messages }); return `Trả lời #${messages.length}`; });
    const r1 = await an.post('/api/v1/assistant/messages', { content: 'Cassandra là gì?' });
    assert.equal(r1.status, 201, JSON.stringify(r1.body));
    assert.equal(r1.body.answer.content, 'Trả lời #1');
    await an.post('/api/v1/assistant/messages', { content: 'Giải thích thêm' });
    assert.equal(seen[1].messages.length, 3, 'gửi kèm câu hỏi + trả lời trước làm ngữ cảnh');
    assert.match(seen[0].system, /Nguyễn An/);
    const h = await an.get('/api/v1/assistant');
    assert.deepEqual(h.body.items.map(i => i.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal((await an.del('/api/v1/assistant')).body.cleared, 4);
    assert.equal((await an.get('/api/v1/assistant')).body.items.length, 0);
    gemini.setGenerator(null);
    if (before) process.env.GEMINI_API_KEY = before;
});
