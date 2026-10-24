// Kiem thu 2 file kiem tra migration (db/verify-*-migration.cql) tren Cassandra GIA LAP.
// Chi chung minh: moi cau lenh la SELECT, dung bang/cot ton tai o dung che do, cu phap
// nam trong tap CQL ma gia lap hieu (kem kiem tra tu khoa danh rieng), ket qua dung ky vong.
// KHONG thay the viec chay that bang cqlsh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createSchemaStub } = require('./schemaStub');
const { runMigration } = require('../scripts/migrate');
const os = require('os');
// verify-*-migration.cql (khong so) la file kiem tra cua migration 001.
const ONLY_001 = fs.mkdtempSync(path.join(os.tmpdir(), 'v001-'));
fs.copyFileSync(path.resolve(__dirname, '../../db/migrations/001_auth_and_chat_features.cql'),
    path.join(ONLY_001, '001_auth_and_chat_features.cql'));

const DB = path.resolve(__dirname, '../../db');
const CQLSH_COMMANDS = /^(USE|PAGING|CONSISTENCY|TRACING|EXPAND|CAPTURE|SOURCE)\b/i;

function statements(file) {
    return fs.readFileSync(path.join(DB, file), 'utf8')
        .split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
        .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function runFile(client, file) {
    const out = [];
    for (const stmt of statements(file)) {
        if (CQLSH_COMMANDS.test(stmt)) continue;
        assert.match(stmt, /^SELECT /i, `${file}: chỉ được có SELECT: ${stmt}`);
        assert.doesNotMatch(stmt, /ALLOW FILTERING/i);
        assert.ok(!/^SELECT COUNT\(\*\)/i.test(stmt) || / WHERE \w+ = /i.test(stmt),
            `${file}: COUNT(*) phải giới hạn trong một partition: ${stmt}`);
        try {
            out.push({ stmt, rs: await client.execute(stmt, []) });
        } catch (error) {
            throw new Error(`${file}: lỗi ở "${stmt}": ${error.message}`);
        }
    }
    return out;
}

const find = (results, re) => results.filter(r => re.test(r.stmt));

test('verify-before: chạy được trên schema CŨ (4 bảng), chỉ đọc, không chạm bảng/cột mới', async () => {
    const client = createSchemaStub();
    const results = await runFile(client, 'verify-before-migration.cql');
    for (const r of results) {
        assert.doesNotMatch(r.stmt, /FROM (accounts_by_email|sessions|direct_conversations|conversation_state_by_user|users_by_name_token)\b/);
        assert.doesNotMatch(r.stmt.replace(/FROM system_schema.*$/i, ''), /\b(email|created_by|last_sender_id)\b/);
    }
    assert.equal(find(results, /column_name = '(email|created_by|last_sender_id)'/).every(r => r.rs.rowLength === 0), true);
    assert.equal(find(results, /table_name IN \('accounts_by_email'/)[0].rs.rowLength, 0);
    assert.equal(results[0].rs.rowLength, 4);
});

test('verify-after: chạy được sau migration, kết quả backfill đúng kỳ vọng', async () => {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {}, migrationsDir: ONLY_001 });
    const results = await runFile(client, 'verify-after-migration.cql');
    assert.equal(results[0].rs.rowLength, 9, '9 bảng');
    for (const r of find(results, /column_name = '(email|created_by|last_sender_id)'/)) {
        assert.equal(r.rs.rowLength, 1);
        assert.equal(r.rs.rows[0].type, 'text');
    }
    const keys = find(results, /table_name IN \('accounts_by_email'/)[0].rs.rows;
    const tokenKeys = keys.filter(k => k.table_name === 'users_by_name_token' && k.kind !== 'regular').map(k => `${k.column_name}:${k.kind}`);
    assert.deepEqual(tokenKeys.sort(), ['name_token:clustering', 'token_prefix:partition_key', 'user_id:clustering']);

    assert.equal(find(results, /FROM direct_conversations WHERE pair_key IN/)[0].rs.rowLength, 7);
    assert.equal(find(results, /pair_key = 'user02\|user01'/)[0].rs.rowLength, 0, 'không có khóa ngược');
    assert.equal(find(results, /FROM users_by_name_token WHERE token_prefix IN/)[0].rs.rowLength, 16);
    const search = find(results, /name_token >= 'nguy'/)[0].rs.rows;
    assert.deepEqual(search.map(r => [r.name_token, r.user_id]), [['nguyen', 'user01']]);

    assert.equal(find(results, /FROM users WHERE user_id = 'user01'/)[0].rs.rows[0].email, null);
    assert.ok(find(results, /created_by FROM conversations WHERE/)[0].rs.rows.every(r => r.created_by === null));
    assert.ok(find(results, /last_sender_id FROM conversations_by_user/)[0].rs.rows.every(r => r.last_sender_id === null));
    for (const r of find(results, /LIMIT 1$/).filter(r => /accounts_by_email|sessions|conversation_state_by_user/.test(r.stmt))) {
        assert.equal(r.rs.rowLength, 0);
    }
});

test('phần B (dữ liệu cũ) của before và after giống hệt nhau và cho cùng kết quả', async () => {
    const before = statements('verify-before-migration.cql');
    const after = statements('verify-after-migration.cql');
    const partB = list => list.filter(s => /FROM (users|conversations|conversations_by_user|messages_by_conversation)\b/.test(s)
        && !/\b(email|created_by|last_sender_id)\b/.test(s));
    assert.deepEqual(partB(after), partB(before));

    const client = createSchemaStub();
    const run = async () => Promise.all(partB(before).map(q => client.execute(q, []).then(rs => JSON.stringify(rs.rows))));
    const r1 = await run();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {}, migrationsDir: ONLY_001 });
    const r2 = await run();
    assert.deepEqual(r2, r1, 'migration không được thay đổi dữ liệu cũ');
});

test('chạy verify-after trên schema CŨ thì báo lỗi (đúng: phải dùng chế độ before)', async () => {
    await assert.rejects(() => runFile(createSchemaStub(), 'verify-after-migration.cql'), /unconfigured table|Undefined column/);
});

test('cột tên "token" (từ khóa CQL) bị phát hiện ở cả giả lập và migrate.js', () => {
    const { FakeCassandra } = require('./fakeCassandra');
    const fake = new FakeCassandra();
    assert.throws(() => fake.select('SELECT token, user_id FROM users_by_name_token WHERE token_prefix = ?', () => 'ng', {}), /từ khóa CQL/);
    const { parseCreate } = require('../scripts/migrate');
    assert.throws(() => parseCreate('CREATE TABLE IF NOT EXISTS x (a text, token text, PRIMARY KEY ((a), token))'), /từ khóa CQL/);
    assert.doesNotThrow(() => parseCreate('CREATE TABLE IF NOT EXISTS x (a text, name_token text, PRIMARY KEY ((a), name_token))'));
});

test('mã nguồn backend và file CQL không còn dùng cột "token" không trích dẫn', () => {
    const files = [
        ...['schema.cql', 'db/migrations/001_auth_and_chat_features.cql', 'db/verify-before-migration.cql', 'db/verify-after-migration.cql']
            .map(f => path.resolve(__dirname, '../..', f)),
        ...['src/services/user.service.js', 'src/services/auth.service.js', 'scripts/migrate.js', 'scripts/audit-db.js']
            .map(f => path.resolve(__dirname, '..', f))
    ];
    for (const f of files) {
        const code = fs.readFileSync(f, 'utf8').replace(/--.*$/gm, '').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(code, /SELECT token\s*,|AND token\s*(=|>|<)|\(token_prefix, token,|^\s*token\s+text/im, f);
    }
});

// ===== File kiem tra migration 002 =====
async function after001() {
    const client = createSchemaStub();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {}, migrationsDir: ONLY_001 });
    return client;
}

test('verify-002-before chạy được trên trạng thái thật hiện tại (đã có 001, chưa có 002)', async () => {
    const client = await after001();
    const results = await runFile(client, 'verify-002-before.cql');
    assert.equal(results[0].rs.rowLength, 9);
    find(results, /column_name = '(reply_to_id|reply_to_created_at|attachment_ids|forwarded)'/)
        .forEach(r => assert.equal(r.rs.rowLength, 0));
    assert.equal(find(results, /table_name IN \('reactions_by_message'/)[0].rs.rowLength, 0);
});

const UPTO_002 = (() => {
    const os = require('os'), fsx = require('fs'), px = require('path');
    const d = fsx.mkdtempSync(px.join(os.tmpdir(), 'v002-'));
    for (const f of ['001_auth_and_chat_features.cql', '002_reply_reaction_attachment.cql']) {
        fsx.copyFileSync(px.resolve(__dirname, '../../db/migrations', f), px.join(d, f));
    }
    return d;
})();

test('verify-002-after: 12 bảng, 4 cột đúng kiểu, khóa bảng mới đúng; phần dữ liệu cũ trùng khớp trước/sau', async () => {
    const client = await after001();
    const partB = list => list.filter(s => / FROM (users|conversations|conversations_by_user|messages_by_conversation) /.test(s + ' ')
        && !/reply_to|attachment_ids|forwarded/.test(s));
    const run = async () => Promise.all(partB(statements('verify-002-before.cql')).map(q => client.execute(q, []).then(r => JSON.stringify(r.rows))));
    const r1 = await run();
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: () => {}, migrationsDir: UPTO_002 });
    const results = await runFile(client, 'verify-002-after.cql');
    assert.equal(results[0].rs.rowLength, 12);
    const types = find(results, /column_name = '(reply_to_id|reply_to_created_at|attachment_ids|forwarded)'/).map(r => r.rs.rows[0].type);
    assert.deepEqual(types, ['timeuuid', 'timestamp', 'list<uuid>', 'boolean']);
    const keys = find(results, /table_name IN \('reactions_by_message'/)[0].rs.rows.filter(k => k.kind !== 'regular')
        .map(k => `${k.table_name}.${k.column_name}:${k.kind}`).sort();
    assert.deepEqual(keys, [
        'attachments_by_conversation.attachment_id:clustering', 'attachments_by_conversation.conversation_id:partition_key',
        'hidden_messages_by_user.conversation_id:partition_key', 'hidden_messages_by_user.message_id:clustering',
        'hidden_messages_by_user.user_id:partition_key',
        'reactions_by_message.conversation_id:partition_key', 'reactions_by_message.message_id:clustering',
        'reactions_by_message.user_id:clustering']);
    assert.deepEqual(partB(statements('verify-002-after.cql')), partB(statements('verify-002-before.cql')));
    assert.deepEqual(await run(), r1, 'migration 002 không được thay đổi dữ liệu cũ');
    find(results, /LIMIT 1$/).forEach(r => assert.equal(r.rs.rowLength, 0));
});
