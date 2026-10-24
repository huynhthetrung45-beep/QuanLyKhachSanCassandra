const cassandra = require('cassandra-driver');
const { FakeCassandra } = require('./fakeCassandra');

const { TimeUuid } = cassandra.types;

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const SMALL_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_GROUP_ID = '33333333-3333-3333-3333-333333333333';

// Du lieu giong seed-chat-data.js: 8 user, 10 hoi thoai, hoi thoai trong tam 200 tin.
function seedSampleData(fake) {
    const users = [
        ['user01', 'Nguyễn An'], ['user02', 'Trần Bình'], ['user03', 'Lê Chi'], ['user04', 'Phạm Dũng'],
        ['user05', 'Hoàng Giang'], ['user06', 'Vũ Huy'], ['user07', 'Đặng Linh'], ['user08', 'Bùi Minh']
    ];
    const names = Object.fromEntries(users);
    const { nameTokens, tokenBucket } = require('../src/utils/text');
    users.forEach(([id, name]) => {
        fake.seedRow('users', { user_id: id, display_name: name, created_at: new Date() });
        nameTokens(name).forEach(token => fake.seedRow('users_by_name_token', {
            token_prefix: tokenBucket(token), name_token: token, user_id: id, display_name: name
        }));
    });

    const conversations = [
        [GROUP_ID, 'Nhóm Đồ án NoSQL', 'GROUP', ['user01', 'user02', 'user03', 'user04', 'user05'], 200],
        ['22222222-2222-2222-2222-222222222222', 'Nhóm Backend', 'GROUP', ['user01', 'user02', 'user03', 'user06'], 30],
        [OTHER_GROUP_ID, 'Nhóm Frontend', 'GROUP', ['user02', 'user04', 'user05', 'user07', 'user08'], 30],
        [SMALL_ID, 'Nguyễn An - Trần Bình', 'DIRECT', ['user01', 'user02'], 7],
        ['55555555-5555-5555-5555-555555555555', 'Nguyễn An - Lê Chi', 'DIRECT', ['user01', 'user03'], 30],
        ['66666666-6666-6666-6666-666666666666', 'Phạm Dũng - Hoàng Giang', 'DIRECT', ['user04', 'user05'], 30],
        ['77777777-7777-7777-7777-777777777777', 'Vũ Huy - Đặng Linh', 'DIRECT', ['user06', 'user07'], 30],
        ['88888888-8888-8888-8888-888888888888', 'Bùi Minh - Nguyễn An', 'DIRECT', ['user08', 'user01'], 30],
        ['99999999-9999-9999-9999-999999999999', 'Trần Bình - Phạm Dũng', 'DIRECT', ['user02', 'user04'], 30],
        ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Lê Chi - Vũ Huy', 'DIRECT', ['user03', 'user06'], 30]
    ];

    const base = Date.now() - 30 * 24 * 3600 * 1000;
    conversations.forEach(([id, name, type, members, count]) => {
        let last = null;
        for (let i = 0; i < count; i++) {
            let createdAt = new Date(base + i * 60000 * 7);
            if (i === 31) createdAt = new Date(base + 30 * 60000 * 7); // trung created_at voi tin #031 (BR-07)
            const sender = members[i % members.length];
            const deleted = i % 20 === 0 && i > 0;
            fake.seedRow('messages_by_conversation', {
                conversation_id: id,
                created_at: createdAt,
                message_id: TimeUuid.fromDate(createdAt, i % 10000),
                sender_id: sender,
                sender_name: names[sender],
                content: deleted ? null : `#${String(i + 1).padStart(3, '0')} Tin nhắn mẫu`,
                message_type: 'TEXT',
                is_deleted: deleted
            });
            last = { createdAt, sender, content: `#${String(i + 1).padStart(3, '0')} Tin nhắn mẫu` };
        }
        fake.seedRow('conversations', {
            conversation_id: id, conversation_name: name, conversation_type: type,
            participant_ids: members, created_at: new Date(base), last_message_at: last.createdAt
        });
        members.forEach(m => fake.seedRow('conversations_by_user', {
            user_id: m, last_message_at: last.createdAt, conversation_id: id,
            conversation_name: name, conversation_type: type,
            last_message_preview: last.content, last_sender_name: names[last.sender]
        }));
    });
    return { users, conversations };
}

// Agent HTTP don gian co cookie jar rieng (mo phong mot trinh duyet).
class Agent {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.cookies = {};
        this.origin = 'http://localhost:5173';
    }

    async request(method, path, body, extraHeaders = {}) {
        const headers = { Origin: this.origin, ...extraHeaders };
        const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(this.baseUrl + path, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
        const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        for (const sc of setCookies) {
            const [pair] = sc.split(';');
            const [k, ...rest] = pair.split('=');
            const v = rest.join('=');
            if (!v || /Expires=Thu, 01 Jan 1970/i.test(sc)) delete this.cookies[k];
            else this.cookies[k] = v;
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        return { status: res.status, body: json, headers: res.headers, setCookies };
    }

    get(p, h) { return this.request('GET', p, undefined, h); }
    post(p, b = {}, h) { return this.request('POST', p, b, h); }
    put(p, b = {}, h) { return this.request('PUT', p, b, h); }
    patch(p, b = {}, h) { return this.request('PATCH', p, b, h); }
    del(p, h) { return this.request('DELETE', p, undefined, h); }
}

async function startTestServer() {
    process.env.LOG_REQUESTS = 'false';
    // Moi request test deu tu 127.0.0.1: noi gioi han theo IP de khong chan nham;
    // gioi han theo IP+email van giu mac dinh va co test rieng.
    process.env.LOGIN_IP_RATE_LIMIT = process.env.LOGIN_IP_RATE_LIMIT || '1000';
    const db = require('../src/db');
    const fake = new FakeCassandra();
    db.setClient(fake);
    const seed = seedSampleData(fake);
    const { createApp } = require('../src/app');
    const server = createApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { fake, server, baseUrl, seed, agent: () => new Agent(baseUrl) };
}

// Gan tai khoan dang nhap cho user mau (giong scripts/seed-demo-accounts.js).
async function linkAccount(fake, userId, email, password) {
    const { hashPassword } = require('../src/utils/password');
    fake.seedRow('accounts_by_email', {
        email, user_id: userId, password_hash: await hashPassword(password), status: 'ACTIVE', created_at: new Date()
    });
}

module.exports = { startTestServer, seedSampleData, linkAccount, Agent, GROUP_ID, SMALL_ID, OTHER_GROUP_ID };
