// Kiem thu phan he Cong viec & Lich, Nhac nho, Hop truc tuyen (Fake Cassandra, server that tren cong ngau nhien).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, linkAccount, GROUP_ID } = require('./helpers');

const PW = 'MatKhau123';
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
let ctx;
let A; let B; let C; let H; // user01 (an), user02 (binh), user03 (chi) cung nhom GROUP_ID; user06 (huy) ngoai nhom
const login = async email => {
    const a = ctx.agent();
    const r = await a.post('/api/v1/auth/login', { email, password: PW });
    assert.equal(r.status, 200, `đăng nhập ${email}: ${JSON.stringify(r.body)}`);
    await tick();
    return a;
};
// Moc thoi gian tuong lai co dinh (UTC), cach nhau theo ngay de cac test khong dam vao nhau.
const DAY = 86400000;
const base = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) + 3 * DAY);
const at = (dayOffset, h, m = 0) => new Date(base.getTime() + dayOffset * DAY + (h * 60 + m) * 60000).toISOString();

// Ghi lai su kien realtime (SSE) de kiem tra chuyen tiep tin hieu phong hop.
const realtime = require('../src/services/realtime.service');
const published = [];
const originalPublish = realtime.publish;

test.before(async () => {
    ctx = await startTestServer();
    for (const [u, e] of [['user01', 'an'], ['user02', 'binh'], ['user03', 'chi'], ['user06', 'huy']]) await linkAccount(ctx.fake, u, `${e}@chatott.demo`, PW);
    A = await login('an@chatott.demo');
    B = await login('binh@chatott.demo');
    C = await login('chi@chatott.demo');
    H = await login('huy@chatott.demo');
    realtime.publish = (userIds, event, data) => {
        published.push({ userIds: [...userIds], event, data });
        return originalPublish(userIds, event, data);
    };
});
test.after(() => {
    realtime.publish = originalPublish;
    require('../src/extensions/meeting.service')._resetRooms();
    ctx.server.close();
});

test('công việc cá nhân: tạo, xem, không giao cho người khác; lịch cá nhân có phiên làm việc', async () => {
    const r = await A.post('/api/v1/tasks', { title: 'Ôn thi NoSQL', start: at(0, 8), end: at(0, 9), dueAt: at(1, 0), priority: 'HIGH' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.scope, 'PERSONAL');
    assert.equal(r.body.status, 'NOT_STARTED');
    assert.deepEqual(r.body.assignees.map(a => a.userId), ['user01']);
    assert.equal(r.body.sessions.length, 1);
    const bad = await A.post('/api/v1/tasks', { title: 'X', assigneeIds: ['user02'] });
    assert.equal(bad.body.error.code, 'PERSONAL_TASK_SELF_ONLY');
    const badTime = await A.post('/api/v1/tasks', { title: 'X', start: at(0, 10), end: at(0, 9) });
    assert.equal(badTime.body.error.code, 'INVALID_TIME');
    const afterDue = await A.post('/api/v1/tasks', { title: 'X', start: at(0, 10), end: at(0, 12), dueAt: at(0, 11) });
    assert.equal(afterDue.body.error.code, 'INVALID_TIME');
    const list = await A.get('/api/v1/tasks');
    assert.ok(list.body.items.some(t => t.taskId === r.body.taskId));
    const calendar = await A.get(`/api/v1/calendar?from=${at(0, 0)}&to=${at(1, 0)}`);
    assert.ok(calendar.body.items.some(e => e.kind === 'TASK_SESSION' && e.taskId === r.body.taskId));
    // Nguoi khac khong xem duoc (404, khong lo su ton tai).
    assert.equal((await B.get(`/api/v1/tasks/${r.body.taskId}`)).status, 404);
});

test('công việc nhóm: giao nhiều người, người ngoài nhóm bị từ chối, quyền trạng thái, bình luận, lịch sử', async () => {
    const outsider = await A.post('/api/v1/tasks', { title: 'Báo cáo', conversationId: GROUP_ID, assigneeIds: ['user02', 'user06'] });
    assert.equal(outsider.body.error.code, 'ASSIGNEE_NOT_IN_GROUP');
    assert.equal((await H.post('/api/v1/tasks', { title: 'Báo cáo', conversationId: GROUP_ID })).status, 403, 'không phải thành viên thì không tạo được');
    const r = await A.post('/api/v1/tasks', { title: 'Viết chương 3', conversationId: GROUP_ID, assigneeIds: ['user02', 'user03'], leadId: 'user02',
        start: at(1, 8), end: at(1, 10), dueAt: at(2, 0) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.taskId;
    assert.equal(r.body.lead.userId, 'user02');
    // Thanh vien nhom xem duoc, nguoi ngoai nhom khong (IDOR).
    assert.equal((await C.get(`/api/v1/tasks/${id}`)).status, 200);
    assert.equal((await H.get(`/api/v1/tasks/${id}`)).status, 404);
    assert.equal((await H.patch(`/api/v1/tasks/${id}`, { title: 'Hack' })).status, 404);
    assert.equal((await H.post(`/api/v1/tasks/${id}/status`, { status: 'DONE' })).status, 404);
    // Nguoi thuc hien: dang thuc hien -> cho xac nhan; khong tu danh dau hoan thanh, khong sua.
    assert.equal((await B.post(`/api/v1/tasks/${id}/status`, { status: 'IN_PROGRESS' })).body.status, 'IN_PROGRESS');
    assert.equal((await B.post(`/api/v1/tasks/${id}/status`, { status: 'DONE' })).body.error.code, 'FORBIDDEN_TASK');
    assert.equal((await B.patch(`/api/v1/tasks/${id}`, { title: 'Đổi' })).body.error.code, 'FORBIDDEN_TASK');
    assert.equal((await B.post(`/api/v1/tasks/${id}/status`, { status: 'WAITING_REVIEW' })).body.status, 'WAITING_REVIEW');
    // Chuyen trang thai sai quy tac.
    assert.equal((await A.post(`/api/v1/tasks/${id}/status`, { status: 'PAUSED' })).body.error.code, 'INVALID_TRANSITION');
    const done = await A.post(`/api/v1/tasks/${id}/status`, { status: 'DONE' });
    assert.equal(done.body.status, 'DONE');
    assert.ok(done.body.completedAt);
    // Binh luan + lich su.
    const c = await C.post(`/api/v1/tasks/${id}/comments`, { content: 'Mình đã xem bản nháp' });
    assert.equal(c.status, 201);
    assert.equal(c.body.items[0].content, 'Mình đã xem bản nháp');
    assert.equal((await B.patch(`/api/v1/tasks/${id}/comments/${c.body.items[0].commentId}`, { content: 'sửa' })).status, 403);
    const h = await A.get(`/api/v1/tasks/${id}/history`);
    assert.ok(h.body.items.some(x => x.action === 'CREATED'));
    assert.ok(h.body.items.filter(x => x.action === 'STATUS').length >= 3);
    // Thong bao giao viec co ref de mo dung cong viec.
    const notes = await B.get('/api/v1/notifications');
    const n = notes.body.items.find(x => x.type === 'TASK_ASSIGNED');
    assert.ok(n, JSON.stringify(notes.body.items.map(x => x.type)));
    assert.deepEqual(n.ref, { type: 'TASK', id });
    // Danh sach cong viec cua nhom.
    const g = await C.get(`/api/v1/groups/${GROUP_ID}/tasks`);
    assert.ok(g.body.items.some(t => t.taskId === id));
    assert.equal((await H.get(`/api/v1/groups/${GROUP_ID}/tasks`)).status, 403);
});

test('chống trùng lịch: khoảng nửa mở, trả người bị trùng + gợi ý; sát giờ không tính trùng', async () => {
    const ev = await B.post('/api/v1/calendar/events', { title: 'Đi học', start: at(2, 9), end: at(2, 10) });
    assert.equal(ev.status, 201, JSON.stringify(ev.body));
    const conflict = await A.post('/api/v1/tasks', { title: 'Họp nhóm làm slide', conversationId: GROUP_ID, assigneeIds: ['user02', 'user03'],
        start: at(2, 9, 30), end: at(2, 10, 30) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'SCHEDULE_CONFLICT');
    const c = conflict.body.error.conflicts;
    assert.equal(c.length, 1);
    assert.equal(c[0].userId, 'user02');
    assert.equal(c[0].displayName, 'Trần Bình');
    // An khong co quyen xem lich ca nhan cua Binh -> chi thay "Dang ban".
    assert.equal(c[0].title, 'Đang bận');
    assert.ok(conflict.body.error.suggestions.length >= 1);
    for (const s of conflict.body.error.suggestions) {
        assert.ok(!(new Date(s.start) < new Date(at(2, 10)) && new Date(at(2, 9)) < new Date(s.end)), 'gợi ý không được trùng lịch bận');
    }
    // Khong ghi gi khi bi trung.
    assert.ok(!(await C.get('/api/v1/tasks')).body.items.some(t => t.title === 'Họp nhóm làm slide'));
    // Ket thuc 10:00 - bat dau 10:00: khong trung.
    const adjacent = await A.post('/api/v1/tasks', { title: 'Làm slide', conversationId: GROUP_ID, assigneeIds: ['user02'], start: at(2, 10), end: at(2, 11) });
    assert.equal(adjacent.status, 201, JSON.stringify(adjacent.body));
    // Kiem tra truoc (khong ghi).
    const check = await A.post('/api/v1/calendar/check', { start: at(2, 10, 30), end: at(2, 11, 30), userIds: ['user02'] });
    assert.equal(check.body.ok, false);
    // Huy lich -> khong con chiem cho.
    await B.del(`/api/v1/calendar/events/${ev.body.eventId}`);
    assert.equal((await A.post('/api/v1/calendar/check', { start: at(2, 9), end: at(2, 10), userIds: ['user02'] })).body.ok, true);
});

test('đồng thời: 2 yêu cầu cùng giờ cho cùng người -> đúng 1 thành công; Idempotency-Key không tạo trùng', async () => {
    const reqs = await Promise.all([
        A.post('/api/v1/tasks', { title: 'Song song 1', conversationId: GROUP_ID, assigneeIds: ['user03'], start: at(3, 14), end: at(3, 15) }),
        B.post('/api/v1/tasks', { title: 'Song song 2', conversationId: GROUP_ID, assigneeIds: ['user03'], start: at(3, 14, 30), end: at(3, 15, 30) })
    ]);
    assert.deepEqual(reqs.map(r => r.status).sort(), [201, 409], JSON.stringify(reqs.map(r => r.body)));
    const day = await C.get(`/api/v1/calendar?from=${at(3, 0)}&to=${at(4, 0)}`);
    assert.equal(day.body.items.filter(e => e.kind === 'TASK_SESSION').length, 1);

    const key = 'tao-viec-' + Date.now();
    const first = await A.post('/api/v1/tasks', { title: 'Gửi lại', start: at(3, 18), end: at(3, 19) }, { 'Idempotency-Key': key });
    const again = await A.post('/api/v1/tasks', { title: 'Gửi lại', start: at(3, 18), end: at(3, 19) }, { 'Idempotency-Key': key });
    assert.equal(first.status, 201);
    assert.equal(again.body.taskId, first.body.taskId);
    assert.equal(again.body.replayed, true);
    assert.equal((await A.get('/api/v1/tasks')).body.items.filter(t => t.title === 'Gửi lại').length, 1);
});

test('kéo thả trên lịch: dời phiên làm việc; dời vào giờ bận -> 409, lịch giữ nguyên', async () => {
    const t = await A.post('/api/v1/tasks', { title: 'Phiên kéo thả', conversationId: GROUP_ID, assigneeIds: ['user02'], start: at(4, 8), end: at(4, 9) });
    const blocker = await B.post('/api/v1/calendar/events', { title: 'Làm thêm', start: at(4, 13), end: at(4, 14) });
    assert.equal(blocker.status, 201);
    const eventId = t.body.sessions[0].eventId;
    const moved = await A.patch(`/api/v1/calendar/events/${eventId}`, { start: at(4, 10), end: at(4, 11) });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.start, at(4, 10));
    assert.equal((await A.get(`/api/v1/tasks/${t.body.taskId}`)).body.start, at(4, 10));
    const blocked = await A.patch(`/api/v1/calendar/events/${eventId}`, { start: at(4, 13, 30), end: at(4, 14, 30) });
    assert.equal(blocked.body.error.code, 'SCHEDULE_CONFLICT');
    const after = await B.get(`/api/v1/calendar?from=${at(4, 0)}&to=${at(5, 0)}`);
    assert.equal(after.body.items.find(e => e.eventId === eventId).start, at(4, 10));
    // Nguoi duoc giao khong duoc tu doi lich cong viec nhom.
    assert.equal((await B.patch(`/api/v1/calendar/events/${eventId}`, { start: at(4, 15), end: at(4, 16) })).body.error.code, 'FORBIDDEN_TASK');
    // Lich nhom thay phien lam viec.
    const gc = await C.get(`/api/v1/groups/${GROUP_ID}/calendar?from=${at(4, 0)}&to=${at(5, 0)}`);
    assert.ok(gc.body.items.some(e => e.eventId === eventId));
});

test('nhắc nhở: không gửi sớm, đến hạn gửi 1 lần, chạy lại / nhiều worker không trùng, đổi giờ, hủy, thử lại khi lỗi', async () => {
    const reminders = require('../src/extensions/reminder.service');
    const soon = new Date(Date.now() + 2 * 3600000);
    const t = await B.post('/api/v1/tasks', { title: 'Nộp bài', dueAt: soon.toISOString() });
    const r = await B.post('/api/v1/reminders', { targetType: 'TASK', targetId: t.body.taskId, anchor: 'DUE', offsetMinutes: 60 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const fireAt = new Date(r.body.fireAt);
    assert.equal(fireAt.getTime(), soon.getTime() - 3600000);
    // Nguoi khac khong dat nhac cho cong viec khong xem duoc.
    assert.equal((await H.post('/api/v1/reminders', { targetType: 'TASK', targetId: t.body.taskId })).status, 404);

    const count = async () => (await B.get('/api/v1/notifications')).body.items.filter(n => n.type === 'REMINDER' && n.preview.includes('Nộp bài')).length;
    let s = await reminders.processDue({ now: new Date(fireAt.getTime() - 60000) });
    assert.equal(s.sent, 0, 'chưa đến giờ không gửi');
    assert.equal(await count(), 0);
    const [s1, s2] = await Promise.all([
        reminders.processDue({ now: new Date(fireAt.getTime() + 1000), instance: 'w1' }),
        reminders.processDue({ now: new Date(fireAt.getTime() + 1000), instance: 'w2' })
    ]);
    assert.equal(s1.sent + s2.sent, 1, 'hai worker chỉ một lần gửi');
    s = await reminders.processDue({ now: new Date(fireAt.getTime() + 5000), instance: 'restart' });
    assert.equal(s.sent, 0, 'khởi động lại không gửi lại');
    assert.equal(await count(), 1);
    const n = (await B.get('/api/v1/notifications')).body.items.find(x => x.type === 'REMINDER');
    assert.deepEqual(n.ref, { type: 'TASK', id: t.body.taskId });
    assert.equal((await B.get('/api/v1/reminders')).body.items.find(x => x.reminderId === r.body.reminderId).status, 'SENT');
    // Chi nguoi dat nhac nhan duoc.
    assert.ok(!(await H.get('/api/v1/notifications')).body.items.some(x => x.type === 'REMINDER'));

    // Doi han -> nhac doi gio theo.
    const t2 = await B.post('/api/v1/tasks', { title: 'Đổi hạn', dueAt: new Date(Date.now() + 5 * 3600000).toISOString() });
    const r2 = await B.post('/api/v1/reminders', { targetType: 'TASK', targetId: t2.body.taskId, anchor: 'DUE', offsetMinutes: 30 });
    const newDue = new Date(Date.now() + 8 * 3600000);
    await B.patch(`/api/v1/tasks/${t2.body.taskId}`, { dueAt: newDue.toISOString() });
    const moved = (await B.get('/api/v1/reminders')).body.items.find(x => x.reminderId === r2.body.reminderId);
    assert.equal(new Date(moved.fireAt).getTime(), newDue.getTime() - 30 * 60000);
    // Huy cong viec -> nhac bi huy, khong gui.
    await B.del(`/api/v1/tasks/${t2.body.taskId}`);
    assert.equal((await B.get('/api/v1/reminders')).body.items.find(x => x.reminderId === r2.body.reminderId).status, 'CANCELLED');
    s = await reminders.processDue({ now: new Date(newDue.getTime()) });
    assert.ok(!(await B.get('/api/v1/notifications')).body.items.some(x => x.type === 'REMINDER' && x.preview.includes('Đổi hạn')));

    // Loi gui: thu lai co gioi han, sau 3 lan -> FAILED.
    const custom = await B.post('/api/v1/reminders', { targetType: 'CUSTOM', note: 'Uống nước', fireAt: new Date(Date.now() + 60000).toISOString() });
    reminders.setSender(async () => { throw new Error('mất kết nối giả lập'); });
    try {
        let now = Date.now() + 2 * 60000;
        for (let i = 0; i < 3; i++) {
            await reminders.processDue({ now: new Date(now) });
            now += 20 * 60000;
        }
    } finally {
        reminders.setSender(null);
    }
    const failed = (await B.get('/api/v1/reminders')).body.items.find(x => x.reminderId === custom.body.reminderId);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.attempts, 3);
    assert.match(failed.lastError, /mất kết nối/);
});

test('họp trực tuyến: lên lịch, mời, trùng lịch, phòng chưa mở, link mời, người ngoài không vào được', async () => {
    const busy = await C.post('/api/v1/calendar/events', { title: 'Bận', start: at(5, 9), end: at(5, 10) });
    assert.equal(busy.status, 201);
    const clash = await A.post('/api/v1/meetings', { title: 'Họp tuần', inviteeIds: ['user02', 'user03'], start: at(5, 9, 30), end: at(5, 10, 30) });
    assert.equal(clash.body.error.code, 'SCHEDULE_CONFLICT');
    const m = await A.post('/api/v1/meetings', { title: 'Họp tuần', inviteeIds: ['user02', 'user03'], start: at(5, 10), end: at(5, 11) });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const id = m.body.meetingId;
    assert.equal(m.body.status, 'SCHEDULED');
    // Nguoi duoc moi thay loi moi + thong bao; lich cua nguoi duoc moi co cuoc hop.
    assert.ok((await B.get('/api/v1/meetings?scope=invitations')).body.items.some(x => x.meetingId === id));
    const note = (await B.get('/api/v1/notifications')).body.items.find(x => x.type === 'MEETING_INVITE');
    assert.deepEqual(note.ref, { type: 'MEETING', id });
    assert.ok((await B.get(`/api/v1/calendar?from=${at(5, 0)}&to=${at(6, 0)}`)).body.items.some(e => e.meetingId === id));
    // Nguoi ngoai: 404; chua den gio: khong vao duoc phong.
    assert.equal((await H.get(`/api/v1/meetings/${id}`)).status, 404);
    assert.equal((await H.post(`/api/v1/meetings/${id}/join`)).status, 404);
    assert.equal((await B.post(`/api/v1/meetings/${id}/join`)).body.error.code, 'MEETING_NOT_OPEN');
    // Tu choi -> khoi lich cua nguoi do.
    await C.post(`/api/v1/meetings/${id}/respond`, { status: 'DECLINED' });
    assert.ok(!(await C.get(`/api/v1/calendar?from=${at(5, 0)}&to=${at(6, 0)}`)).body.items.some(e => e.meetingId === id));
    // Chi nguoi to chuc doi lich / huy / tao link.
    assert.equal((await B.patch(`/api/v1/meetings/${id}`, { start: at(5, 12), end: at(5, 13) })).body.error.code, 'FORBIDDEN_MEETING');
    const re = await A.patch(`/api/v1/meetings/${id}`, { start: at(5, 12), end: at(5, 13) });
    assert.equal(re.body.start, at(5, 12));
    assert.ok((await B.get('/api/v1/notifications')).body.items.some(x => x.type === 'MEETING_UPDATED'));
    const link = await A.post(`/api/v1/meetings/${id}/link`);
    assert.ok(link.body.inviteCode.length >= 16);
    assert.equal((await B.post(`/api/v1/meetings/${id}/link`)).status, 403);
    const viaLink = await H.post(`/api/v1/meetings/links/${link.body.inviteCode}`);
    assert.equal(viaLink.status, 200, JSON.stringify(viaLink.body));
    assert.equal((await H.get(`/api/v1/meetings/${id}`)).status, 200);
    await A.del(`/api/v1/meetings/${id}/link`);
    assert.equal((await C.post(`/api/v1/meetings/links/${link.body.inviteCode}`)).status, 404, 'link đã thu hồi');
    // Huy -> thong bao + khoi lich.
    const cancelled = await A.del(`/api/v1/meetings/${id}`);
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.ok((await B.get('/api/v1/notifications')).body.items.some(x => x.type === 'MEETING_CANCELLED'));
    assert.ok(!(await B.get(`/api/v1/calendar?from=${at(5, 0)}&to=${at(6, 0)}`)).body.items.some(e => e.meetingId === id));
});

test('phòng họp: vào phòng, mã tham gia gắn người dùng, chuyển tiếp tín hiệu WebRTC, chat, mic/camera, kết thúc bởi người tổ chức', async () => {
    const m = await A.post('/api/v1/meetings', { title: 'Họp nhanh', instant: true, conversationId: GROUP_ID, inviteeIds: ['user02'] });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    const id = m.body.meetingId;
    const ja = await A.post(`/api/v1/meetings/${id}/join`);
    assert.equal(ja.status, 200, JSON.stringify(ja.body));
    assert.ok(ja.body.token && ja.body.iceServers.length >= 1);
    assert.equal(ja.body.participants.length, 0);
    const jb = await B.post(`/api/v1/meetings/${id}/join`);
    assert.equal(jb.body.participants.length, 1);
    assert.equal(jb.body.meeting.status, 'LIVE');
    // Thanh vien nhom (join_policy GROUP) vao duoc du khong duoc moi; nguoi ngoai nhom khong.
    assert.equal((await H.post(`/api/v1/meetings/${id}/join`)).status, 404);

    published.length = 0;
    const offer = { type: 'offer', sdp: 'v=0 gia-lap' };
    const sent = await B.post(`/api/v1/meetings/${id}/signal`, { toSessionId: ja.body.sessionId, type: 'offer', payload: offer }, { 'X-Meeting-Token': jb.body.token });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const sig = published.find(p => p.event === 'meeting:signal');
    assert.deepEqual(sig.userIds, ['user01']);
    assert.equal(sig.data.fromSessionId, jb.body.sessionId);
    assert.deepEqual(sig.data.payload, offer);
    // Dung ma cua nguoi khac / khong co ma -> tu choi.
    assert.equal((await A.post(`/api/v1/meetings/${id}/signal`, { toSessionId: jb.body.sessionId, type: 'answer' }, { 'X-Meeting-Token': jb.body.token })).status, 403);
    assert.equal((await A.post(`/api/v1/meetings/${id}/signal`, { toSessionId: jb.body.sessionId, type: 'answer' })).status, 401);
    // Chat + trang thai mic.
    published.length = 0;
    await A.post(`/api/v1/meetings/${id}/chat`, { content: 'Chào mọi người' }, { 'X-Meeting-Token': ja.body.token });
    const chat = published.find(p => p.event === 'meeting:chat');
    assert.deepEqual([...chat.userIds].sort(), ['user01', 'user02']);
    assert.equal(chat.data.message.content, 'Chào mọi người');
    await B.post(`/api/v1/meetings/${id}/media`, { audio: false }, { 'X-Meeting-Token': jb.body.token });
    const live = await A.get(`/api/v1/meetings/${id}/participants`);
    assert.equal(live.body.items.find(p => p.userId === 'user02').audio, false);
    // Tai lai trang: vao lai voi phien cu -> phien cu bi thay, khong de lai "bong ma".
    const again = await B.post(`/api/v1/meetings/${id}/join`, { replaceSessionId: jb.body.sessionId });
    assert.equal(again.status, 200);
    assert.equal((await A.get(`/api/v1/meetings/${id}/participants`)).body.items.length, 2);
    // Khong the thay phien cua nguoi khac.
    await A.post(`/api/v1/meetings/${id}/join`, { replaceSessionId: again.body.sessionId });
    assert.equal((await A.get(`/api/v1/meetings/${id}/participants`)).body.items.filter(p => p.userId === 'user02').length, 1);
    // Chi nguoi to chuc ket thuc.
    assert.equal((await B.post(`/api/v1/meetings/${id}/end`)).status, 403);
    published.length = 0;
    const ended = await A.post(`/api/v1/meetings/${id}/end`);
    assert.equal(ended.body.status, 'ENDED');
    assert.ok(published.some(p => p.event === 'meeting:ended' && p.userIds.includes('user02')));
    assert.equal((await B.post(`/api/v1/meetings/${id}/join`)).body.error.code, 'MEETING_CLOSED');
    const hist = await A.get(`/api/v1/meetings/${id}/history`);
    assert.equal(hist.body.items.length, 4);
    assert.ok(hist.body.items.every(h => h.leftAt));
});

test('tổng quan công việc: việc được giao, sắp đến hạn, cuộc họp sắp tới', async () => {
    const r = await C.get('/api/v1/work/overview');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const k of ['assignedToMe', 'createdByMe', 'dueSoon', 'overdue', 'today', 'upcomingMeetings', 'upcomingReminders', 'newInGroups']) {
        assert.ok(Array.isArray(r.body[k]), k);
    }
});
