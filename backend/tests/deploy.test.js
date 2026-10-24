// Kiem thu logic anh chup / so sanh / backfill cua deploy-migration.js tren Cassandra GIA LAP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchemaStub } = require('./schemaStub');
const { runMigration } = require('../scripts/migrate');
const { takeSnapshot, compareSnapshots, expectedBackfill, verifyBackfill } = require('../scripts/lib/dbSnapshot');

const quiet = () => {};

test('migration trên giả lập: ảnh chụp trước/sau không khác, backfill khớp kỳ vọng tính từ nguồn', async () => {
    const client = createSchemaStub();
    const before = await takeSnapshot(client, 'chat_ott');
    assert.deepEqual(before.counts, { users: 8, conversations: 10, membershipRows: 28, messages: 447 });
    const exp = expectedBackfill(before);
    assert.equal(exp.pairs.size, 7);
    assert.equal(exp.tokens.length, 16);
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet });
    const after = await takeSnapshot(client, 'chat_ott');
    assert.deepEqual(compareSnapshots(before, after), []);
    assert.deepEqual(await verifyBackfill(client, exp), []);
});

test('ảnh chụp phát hiện thay đổi dữ liệu cũ (1 tin bị sửa nội dung)', async () => {
    const client = createSchemaStub();
    const before = await takeSnapshot(client, 'chat_ott');
    const row = [...client.fake.data.messages_by_conversation.values()].find(r => r.content);
    row.content = 'bị sửa';
    const after = await takeSnapshot(client, 'chat_ott');
    assert.ok(compareSnapshots(before, after).some(p => /messages/.test(p)));
});

test('ảnh chụp phát hiện thay đổi cấu hình bảng cũ', async () => {
    const client = createSchemaStub();
    const before = await takeSnapshot(client, 'chat_ott');
    const after = JSON.parse(JSON.stringify(before));
    after.tableOptions.users.default_time_to_live = 60;
    assert.ok(compareSnapshots(before, after).some(p => /TTL/.test(p)));
});

test('verifyBackfill báo thiếu khi backfill chưa chạy', async () => {
    const client = createSchemaStub();
    const exp = expectedBackfill(await takeSnapshot(client, 'chat_ott'));
    await runMigration(client, { keyspace: 'chat_ott', dryRun: false, log: quiet });
    client.fake.data.users_by_name_token.clear();
    const problems = await verifyBackfill(client, exp);
    assert.equal(problems.length, 16);
});

test('deploy-migration.js: hỏi xác nhận MIGRATE, chạy migrate một lần, không seed / integration', () => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../scripts/deploy-migration.js'), 'utf8');
    assert.match(src, /answer === 'MIGRATE'/);
    assert.equal((src.match(/\['run', 'migrate'\]/g) || []).length, 1, 'chỉ một lần chạy migrate');
    assert.doesNotMatch(src, /seed:accounts|test:integration|seed-demo|seed-chat/);
    assert.doesNotMatch(src, /--yes|--force/);
});
