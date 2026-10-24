// Kiem thu migrate.js tren client gia lap (KHONG ket noi Cassandra that).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMigration, parsePlan } = require('../scripts/migrate');
const { createSchemaStub, isWrite } = require('./schemaStub');
const { pairKey } = require('../src/services/conversation.service');

const quiet = () => {};
const MIG_FILE = path.resolve(__dirname, '../../db/migrations/001_auth_and_chat_features.cql');
const MIG_002 = path.resolve(__dirname, '../../db/migrations/002_reply_reaction_attachment.cql');
// Cac test duoi day mo phong LICH SU migration 001 (chi file 001).
const ONLY_001 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig001-'));
fs.copyFileSync(MIG_FILE, path.join(ONLY_001, path.basename(MIG_FILE)));
// Thu muc chi co 001 + 002 (de kiem rieng 002 khi da co migration moi hon)
const UPTO_002 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig002-'));
fs.copyFileSync(MIG_FILE, path.join(UPTO_002, path.basename(MIG_FILE)));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/002_reply_reaction_attachment.cql'), path.join(UPTO_002, '002_reply_reaction_attachment.cql'));

test('file migration chỉ gồm CREATE TABLE IF NOT EXISTS và ALTER ADD, không có lệnh phá hủy', () => {
    const plan = parsePlan([MIG_FILE]);
    assert.deepEqual(plan.creates.map(c => c.def.table).sort(),
        ['accounts_by_email', 'conversation_state_by_user', 'direct_conversations', 'sessions', 'users_by_name_token']);
    assert.deepEqual(plan.alters.map(a => `${a.table}.${a.column}:${a.type}`).sort(),
        ['conversations.created_by:text', 'conversations_by_user.last_sender_id:text', 'users.email:text']);
    const raw = fs.readFileSync(MIG_FILE, 'utf8').replace(/--.*$/gm, '');
    assert.doesNotMatch(raw, /\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE)\b|compaction|default_time_to_live/i);
});

test('các bảng mới trong migration khớp schema.cql (cùng cột, cùng khóa)', () => {
    const { parseSchema } = require('./fakeCassandra');
    const schema = parseSchema(fs.readFileSync(path.resolve(__dirname, '../../schema.cql'), 'utf8'));
    for (const { def } of parsePlan([MIG_FILE]).creates) {
        const s = schema[def.table];
        assert.ok(s, def.table);
        assert.deepEqual(def.columns, s.columns, def.table);
        assert.deepEqual(def.partitionKey, s.partitionKey, def.table);
        assert.deepEqual(def.clustering.map(c => c[0]), s.clustering, def.table);
    }
});

test('DRY RUN không gửi bất kỳ lệnh ghi nào tới Cassandra', async () => {
    const client = createSchemaStub();
    const before = JSON.stringify([...client.fake.data.users.values()]);
    const result = await runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: ONLY_001 });
    assert.equal(client.received.filter(isWrite).length, 0, client.received.filter(isWrite).join('\n'));
    assert.ok(client.received.every(q => /^SELECT /i.test(q)));
    assert.equal(result.executedWrites, 0);
    assert.deepEqual(result.created.length, 5);
    assert.deepEqual(result.added.length, 3);
    assert.equal(result.backfill.direct.candidates, 7);
    assert.ok(result.backfill.nameTokens.rows >= 16);
    assert.equal(JSON.stringify([...client.fake.data.users.values()]), before);
    assert.equal(client.present.has('sessions'), false, 'dry-run không được tạo bảng');
});

test('chạy thật: tạo 5 bảng, thêm 3 cột, backfill; dữ liệu cũ giữ nguyên', async () => {
    const client = createSchemaStub();
    const snapshot = t => JSON.stringify([...client.fake.data[t].entries()]);
    const old = Object.fromEntries(['users', 'conversations', 'conversations_by_user', 'messages_by_conversation'].map(t => [t, snapshot(t)]));
    const result = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    assert.equal(result.created.length, 5);
    assert.equal(result.added.length, 3);
    for (const [t, snap] of Object.entries(old)) assert.equal(snapshot(t), snap, `bảng cũ ${t} bị thay đổi`);

    const writes = client.received.filter(isWrite);
    assert.ok(writes.every(q => /^(CREATE TABLE IF NOT EXISTS|ALTER TABLE \w+ ADD|INSERT INTO (direct_conversations|users_by_name_token))/i.test(q)),
        'chỉ được ghi DDL và vào 2 bảng mới');
    // Thu tu: moi CREATE/ALTER truoc moi INSERT backfill
    const lastDdl = Math.max(...writes.map((q, i) => (/^(CREATE|ALTER)/i.test(q) ? i : -1)));
    const firstInsert = writes.findIndex(q => /^INSERT/i.test(q));
    assert.ok(lastDdl < firstInsert);

    assert.equal(client.fake.data.direct_conversations.size, 7);
    const an = [...client.fake.data.users_by_name_token.values()].filter(r => r.user_id === 'user01').map(r => r.name_token).sort();
    assert.deepEqual(an, ['an', 'nguyen']);
});

test('chạy lại sau khi đã hoàn tất: bỏ qua DDL, backfill idempotent', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    const tokensBefore = client.fake.data.users_by_name_token.size;
    client.received.length = 0;
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    assert.equal(again.created.length, 0);
    assert.equal(again.added.length, 0);
    assert.equal(client.received.filter(q => /^(CREATE|ALTER)/i.test(q)).length, 0);
    assert.equal(again.backfill.direct.inserted, 0);
    assert.equal(again.backfill.direct.alreadyMapped, 7);
    assert.equal(client.fake.data.users_by_name_token.size, tokensBefore);
});

test('chạy lại sau khi dừng giữa chừng (mới tạo 2 bảng, chưa thêm cột) hoàn tất đúng', async () => {
    const client = createSchemaStub();
    client.present.set('accounts_by_email', new Set(Object.keys(client.fake.tables.accounts_by_email.columns)));
    client.present.set('sessions', new Set(Object.keys(client.fake.tables.sessions.columns)));
    const result = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    assert.deepEqual(result.created.sort(), ['conversation_state_by_user', 'direct_conversations', 'users_by_name_token']);
    assert.equal(result.added.length, 3);
});

test('bảng đã có nhưng sai cấu trúc: dừng TRƯỚC khi ghi bất cứ thứ gì', async () => {
    const client = createSchemaStub();
    client.present.set('sessions', new Set(['session_hash', 'user_id']));
    client.overrideColumns = {
        sessions: [
            { column_name: 'session_hash', type: 'text', kind: 'partition_key', position: 0, clustering_order: 'none' },
            { column_name: 'user_id', type: 'text', kind: 'regular', position: -1, clustering_order: 'none' }
        ]
    };
    await assert.rejects(() => runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 }), /khác thiết kế/);
    assert.equal(client.received.filter(isWrite).length, 0);
});

test('cột đã có nhưng sai kiểu: dừng, không ghi', async () => {
    const client = createSchemaStub();
    client.overrideColumns = {
        users: [
            { column_name: 'user_id', type: 'text', kind: 'partition_key', position: 0, clustering_order: 'none' },
            { column_name: 'email', type: 'int', kind: 'regular', position: -1, clustering_order: 'none' }
        ]
    };
    await assert.rejects(() => runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 }), /users\.email/);
    assert.equal(client.received.filter(isWrite).length, 0);
});

test('keyspace không tồn tại: không tự tạo', async () => {
    const client = createSchemaStub({ keyspace: 'ott_chat' });
    await assert.rejects(() => runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: ONLY_001 }), /không tồn tại/);
    assert.equal(client.received.filter(isWrite).length, 0);
});

test('file migration có lệnh ngoài phạm vi thì bị từ chối', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    for (const bad of [
        'DROP TABLE users;',
        'TRUNCATE messages_by_conversation;',
        "ALTER TABLE messages_by_conversation WITH compaction = {'class': 'TimeWindowCompactionStrategy'};",
        'CREATE TABLE IF NOT EXISTS x (a text PRIMARY KEY) WITH default_time_to_live = 10;'
    ]) {
        const f = path.join(dir, '002.cql');
        fs.writeFileSync(f, bad);
        assert.throws(() => parsePlan([f]), /Từ chối|không được hỗ trợ|phân tích/, bad);
    }
});

test('pair_key đối xứng: A–B và B–A cho cùng khóa, dùng chung trong backend và migration', () => {
    assert.equal(pairKey('user01', 'user02'), pairKey('user02', 'user01'));
    assert.equal(pairKey('user08', 'user01'), 'user01|user08');
    assert.notEqual(pairKey('user01', 'user02'), pairKey('user01', 'user03'));
});

test('DDL gửi không prepare; chờ schema agreement trước khi backfill', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    const ddl = client.calls.filter(c => /^(CREATE|ALTER)/i.test(c.query));
    assert.equal(ddl.length, 8);
    ddl.forEach(c => assert.equal(c.options.prepare, false, c.query));
    const lastDdl = client.calls.map(c => c.query).lastIndexOf(ddl[ddl.length - 1].query);
    const agreement = client.calls.findIndex(c => c.query === '<checkSchemaAgreement>');
    const firstInsert = client.calls.findIndex(c => /^INSERT/i.test(c.query));
    assert.ok(lastDdl < agreement && agreement < firstInsert, 'thứ tự: DDL -> schema agreement -> backfill');
    client.calls.filter(c => /^INSERT/i.test(c.query)).forEach(c => assert.equal(c.options.prepare, true));
});

test('backfill chỉ ghi vào direct_conversations và users_by_name_token, không cột thời gian/ID cũ nào bị sửa', async () => {
    const client = createSchemaStub();
    const deep = t => JSON.stringify([...client.fake.data[t].values()].map(r => Object.fromEntries(Object.entries(r).sort())));
    const before = Object.fromEntries(['users', 'conversations', 'conversations_by_user', 'messages_by_conversation'].map(t => [t, deep(t)]));
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    for (const [t, snap] of Object.entries(before)) assert.equal(deep(t), snap, t);
    const targets = new Set(client.calls.filter(c => /^INSERT INTO/i.test(c.query)).map(c => c.query.match(/^INSERT INTO (\w+)/i)[1]));
    assert.deepEqual([...targets].sort(), ['direct_conversations', 'users_by_name_token']);
    assert.equal(client.calls.filter(c => /^(UPDATE|DELETE|TRUNCATE|DROP)/i.test(c.query)).length, 0);
});

test('migration không chứa KEYSPACE / replication / TTL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig2-'));
    for (const bad of [
        "ALTER KEYSPACE chat_ott WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 3};",
        'CREATE TABLE IF NOT EXISTS y (a text PRIMARY KEY) WITH gc_grace_seconds = 0;'
    ]) {
        const f = path.join(dir, '003.cql');
        fs.writeFileSync(f, bad);
        assert.throws(() => parsePlan([f]), /Từ chối|không được hỗ trợ|phân tích/, bad);
    }
});

// ===== Migration 002 tren trang thai THAT hien tai (da co 001) =====
async function stubAfter001() {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: ONLY_001 });
    client.received.length = 0;
    client.calls.length = 0;
    return client;
}

test('002: file chỉ gồm 3 CREATE + 4 ALTER ADD, không có lệnh phá hủy', () => {
    const plan = parsePlan([MIG_002]);
    assert.deepEqual(plan.creates.map(c => c.def.table).sort(), ['attachments_by_conversation', 'hidden_messages_by_user', 'reactions_by_message']);
    assert.deepEqual(plan.alters.map(a => `${a.table}.${a.column}:${a.type}`).sort(), [
        'messages_by_conversation.attachment_ids:list<uuid>', 'messages_by_conversation.forwarded:boolean',
        'messages_by_conversation.reply_to_created_at:timestamp', 'messages_by_conversation.reply_to_id:timeuuid']);
    const hidden = plan.creates.find(c => c.def.table === 'hidden_messages_by_user').def;
    assert.deepEqual(hidden.partitionKey, ['user_id', 'conversation_id']);
    assert.deepEqual(hidden.clustering, [['message_id', 'DESC']]);
});

test('002 dry-run trên trạng thái đã có 001: 7 lệnh DDL, 0 lệnh backfill, 0 lệnh gửi đi', async () => {
    const client = await stubAfter001();
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: UPTO_002 });
    assert.equal(r.created.length, 3);
    assert.equal(r.added.length, 4);
    assert.equal(r.writeStatements, 7, 'backfill 001 đã đủ -> không ghi lại');
    assert.equal(client.received.filter(isWrite).length, 0);
});

test('002 chạy thật: chỉ DDL, không backfill lại, dữ liệu cũ giữ nguyên; chạy lại = 0 lệnh ghi', async () => {
    const client = await stubAfter001();
    const snap = t => JSON.stringify([...client.fake.data[t].entries()]);
    const old = Object.fromEntries(['users', 'conversations', 'conversations_by_user', 'messages_by_conversation',
        'direct_conversations', 'users_by_name_token'].map(t => [t, snap(t)]));
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_002 });
    assert.equal(r.executedWrites, 7);
    assert.ok(client.received.filter(isWrite).every(q => /^(CREATE TABLE IF NOT EXISTS|ALTER TABLE messages_by_conversation ADD)/.test(q)));
    for (const [t, v] of Object.entries(old)) assert.equal(snap(t), v, t);
    client.received.length = 0;
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_002 });
    assert.equal(again.executedWrites, 0);
    assert.equal(client.received.filter(isWrite).length, 0);
});

// ===== Migration 003 (mang xa hoi): chi them 7 bang moi =====
const MIG_003 = path.resolve(__dirname, '../../db/migrations/003_social_profile_friends.cql');

test('003: file chỉ gồm 7 CREATE TABLE IF NOT EXISTS, không ALTER / DROP / TRUNCATE', () => {
    const plan = parsePlan([MIG_003]);
    assert.equal(plan.creates.length, 7);
    assert.equal(plan.alters.length, 0);
    assert.doesNotMatch(fs.readFileSync(MIG_003, 'utf8').replace(/--.*$/gm, ''), /\b(DROP|TRUNCATE|DELETE|ALTER)\b/i);
});

test('003 chạy sau 002: tạo đúng 7 bảng, dữ liệu cũ giữ nguyên, chạy lại = 0 lệnh ghi', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_002 });
    const before = JSON.stringify([...client.fake.data.messages_by_conversation.values()].length);
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_003 });
    assert.deepEqual(r.created.sort(), ['blocked_users_by_user', 'friend_requests_by_receiver', 'friend_requests_by_sender',
        'friends_by_user', 'relationships', 'user_profiles', 'usernames']);
    assert.equal(r.added.length, 0);
    assert.equal(JSON.stringify([...client.fake.data.messages_by_conversation.values()].length), before);
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_003 });
    assert.equal(again.executedWrites, 0);
});

// ===== Migration 004 (bai dang): 5 bang moi + 1 cot moi =====
const UPTO_003 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig003-'));
for (const f of ['001_auth_and_chat_features.cql', '002_reply_reaction_attachment.cql', '003_social_profile_friends.cql']) {
    fs.copyFileSync(path.resolve(__dirname, '../../db/migrations', f), path.join(UPTO_003, f));
}

test('004 chạy sau 003: tạo 5 bảng + 1 cột, tin nhắn cũ giữ nguyên, cột mới null; chạy lại = 0 lệnh ghi', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_003 });
    const before = JSON.stringify([...client.fake.data.messages_by_conversation.values()]);
    const dry = await runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: UPTO_004 });
    assert.equal(dry.executedWrites, 0);
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_004 });
    assert.deepEqual(r.created.sort(), ['post_comments', 'post_media', 'post_reactions', 'posts', 'posts_by_author']);
    assert.deepEqual(r.added, ['messages_by_conversation.shared_post_id']);
    assert.equal(JSON.stringify([...client.fake.data.messages_by_conversation.values()]), before);
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_004 });
    assert.equal(again.executedWrites, 0);
});

// ===== Migration 005 (bang tin cong khai): backfill tu bai da co =====
const UPTO_004 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig004-'));
for (const f of fs.readdirSync(UPTO_003)) fs.copyFileSync(path.join(UPTO_003, f), path.join(UPTO_004, f));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/004_posts_reactions_comments.cql'), path.join(UPTO_004, '004_posts_reactions_comments.cql'));

const UPTO_005 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig005-'));
for (const f of fs.readdirSync(UPTO_004)) fs.copyFileSync(path.join(UPTO_004, f), path.join(UPTO_005, f));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/005_public_feed_shares.cql'), path.join(UPTO_005, '005_public_feed_shares.cql'));

test('005 sau 004: backfill chỉ bài PUBLIC chưa xóa vào bảng tin công khai + lượt chia sẻ cũ; bài cũ không đổi; chạy lại = 0 lệnh ghi', async () => {
    const { TimeUuid } = require('cassandra-driver').types;
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_004 });
    const ids = [0, 1, 2, 3].map(() => TimeUuid.now());
    const now = new Date();
    const seed = (id, privacy, extra = {}) => client.fake.seedRow('posts', {
        post_id: id, author_id: 'user01', content: 'x', privacy, created_at: now, updated_at: now, is_deleted: false, ...extra
    });
    seed(ids[0], 'PUBLIC');
    seed(ids[1], 'PRIVATE');
    seed(ids[2], 'PUBLIC', { is_deleted: true });
    seed(ids[3], 'FRIENDS', { shared_post_id: ids[0] });
    const postsBefore = JSON.stringify([...client.fake.data.posts.values()]);
    const dry = await runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: UPTO_005 });
    assert.equal(dry.executedWrites, 0);
    assert.deepEqual([dry.backfill.publicFeed.publicRows, dry.backfill.publicFeed.shareRows], [1, 1]);
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_005 });
    assert.deepEqual(r.created.sort(), ['post_shares', 'public_posts_by_month']);
    assert.deepEqual([...client.fake.data.public_posts_by_month.values()].map(x => String(x.post_id)), [ids[0].toString()]);
    assert.equal(client.fake.data.post_shares.size, 1);
    assert.equal(JSON.stringify([...client.fake.data.posts.values()]), postsBefore, 'bảng posts không bị ghi');
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_005 });
    assert.equal(again.executedWrites, 0);
});

// ===== Migration 006: thong bao, tim kiem, AI, thong ke =====
const UPTO_006 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig006-'));
for (const f of fs.readdirSync(UPTO_005)) fs.copyFileSync(path.join(UPTO_005, f), path.join(UPTO_006, f));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/006_notifications_search_ai_stats.cql'), path.join(UPTO_006, '006_notifications_search_ai_stats.cql'));

test('006 sau 005: 10 bảng + 1 cột; backfill chỉ mục + bộ đếm khớp nguồn; dữ liệu cũ giữ nguyên; chạy lại = 0 lệnh ghi', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_005 });
    const msgsBefore = JSON.stringify([...client.fake.data.messages_by_conversation.values()]);
    const dry = await runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: UPTO_006 });
    assert.equal(dry.executedWrites, 0);
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_006 });
    assert.equal(r.created.length, 10);
    assert.deepEqual(r.added, ['post_comments.reply_to_comment_id']);
    assert.equal(JSON.stringify([...client.fake.data.messages_by_conversation.values()]), msgsBefore, 'tin nhắn cũ không bị ghi');
    // Bo dem = so tin that trong nguon
    const total = [...client.fake.data.messages_by_conversation.values()].filter(m => m.conversation_id === '11111111-1111-1111-1111-111111111111').length;
    const typeRows = [...client.fake.data.conversation_type_stats.values()].filter(x => x.conversation_id === '11111111-1111-1111-1111-111111111111');
    assert.equal(typeRows.reduce((a, x) => a + x.messages, 0), total);
    assert.ok(client.fake.data.message_terms_by_conversation.size > 0, 'đã lập chỉ mục tìm kiếm');
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_006 });
    assert.equal(again.executedWrites, 0, 'chạy lại không cộng dồn bộ đếm');
});

test('backfill không được ghi vào bảng dữ liệu cũ', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../scripts/migrate.js'), 'utf8');
    assert.match(src, /BACKFILL_TABLES/);
    assert.doesNotMatch(src.match(/BACKFILL_TABLES = new Set\(\[([\s\S]*?)\]\)/)[1], /'(users|conversations|conversations_by_user|messages_by_conversation|posts)'/);
});

// ===== Migration 007: luong binh luan =====
const UPTO_007 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig007-'));
for (const f of fs.readdirSync(UPTO_006)) fs.copyFileSync(path.join(UPTO_006, f), path.join(UPTO_007, f));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/007_comment_threads_reaction_list.cql'), path.join(UPTO_007, '007_comment_threads_reaction_list.cql'));

test('007 sau 006: 3 bảng + 1 cột; backfill gốc / phản hồi từ bình luận cũ (kể cả trả lời phản hồi); post_comments không bị ghi; chạy lại = 0', async () => {
    const { TimeUuid } = require('cassandra-driver').types;
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_006 });
    const pid = TimeUuid.now();
    const now = new Date();
    client.fake.seedRow('posts', { post_id: pid, author_id: 'user01', content: 'x', privacy: 'PUBLIC', created_at: now, updated_at: now, is_deleted: false });
    const [c1, c2, c3, c4] = [0, 1, 2, 3].map(() => TimeUuid.now());
    const seed = (id, extra = {}) => client.fake.seedRow('post_comments', { post_id: pid, comment_id: id, author_id: 'user02', content: 'c', created_at: now, updated_at: now, is_deleted: false, ...extra });
    seed(c1);                                  // goc
    seed(c2, { reply_to_comment_id: c1 });     // tra loi goc
    seed(c3, { reply_to_comment_id: c2 });     // tra loi phan hoi -> van thuoc luong c1
    seed(c4, { is_deleted: true });            // goc da xoa
    const commentsBefore = JSON.stringify([...client.fake.data.post_comments.values()]);
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_007 });
    assert.deepEqual(r.created.sort(), ['comment_client_ids', 'comment_replies_by_root', 'root_comments_by_post']);
    assert.deepEqual(r.added, ['post_comments.root_comment_id']);
    assert.deepEqual([r.backfill.commentThreads.rootRows, r.backfill.commentThreads.replyRows], [2, 2]);
    const replies = [...client.fake.data.comment_replies_by_root.values()];
    assert.ok(replies.every(x => String(x.root_comment_id) === c1.toString()));
    assert.equal(JSON.stringify([...client.fake.data.post_comments.values()]), commentsBefore, 'không ghi vào post_comments');
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_007 });
    assert.equal(again.executedWrites, 0);
});


// Gioi han dung pham vi 008 (cac migration 009+ co kiem thu rieng trong extensions.test.js).
const UPTO_008 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig008-'));
for (const f of fs.readdirSync(UPTO_007)) fs.copyFileSync(path.join(UPTO_007, f), path.join(UPTO_008, f));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/008_pinned_messages.cql'), path.join(UPTO_008, '008_pinned_messages.cql'));
test('008 sau 007: chỉ tạo bảng ghim tin, không ghi dữ liệu; dữ liệu cũ giữ nguyên; chạy lại = 0', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_007 });
    const snap = () => JSON.stringify(Object.fromEntries(Object.entries(client.fake.data).filter(([k]) => k !== 'pinned_messages_by_conversation').map(([k, v]) => [k, [...v.values()]])));
    const before = snap();
    const dry = await runMigration(client, { keyspace: 'chat_ott', dryRun: true, log: quiet, migrationsDir: UPTO_008 });
    assert.deepEqual(dry.created, ['pinned_messages_by_conversation']);
    const r = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_008 });
    assert.deepEqual(r.created, ['pinned_messages_by_conversation']);
    assert.deepEqual(r.added, []);
    assert.equal(snap(), before, 'không ghi vào bảng cũ');
    assert.equal(client.fake.data.pinned_messages_by_conversation.size, 0);
    const again = await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet, migrationsDir: UPTO_008 });
    assert.deepEqual(again.created, []);
    assert.equal(again.executedWrites, 0);
});
