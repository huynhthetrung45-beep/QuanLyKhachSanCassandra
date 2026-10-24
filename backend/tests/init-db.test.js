// Khoi tao CSDL cho may moi (npm run db:init) - client GHI LAI cau lenh, khong ket noi Cassandra that.
const test = require('node:test');
const assert = require('node:assert/strict');
const { initDb, schemaStatements, SAMPLE_USERS } = require('../scripts/init-db');

function stub({ keyspaceExists, tables = [] }) {
    const sent = [];
    const R = rows => ({ rows, rowLength: rows.length, wasApplied: () => true });
    return {
        sent,
        async execute(q, params = []) {
            sent.push({ q, params });
            if (/system_schema\.keyspaces/i.test(q)) return R(keyspaceExists ? [{ keyspace_name: params[0] }] : []);
            if (/system_schema\.tables/i.test(q)) return R(tables.map(t => ({ table_name: t })));
            return R([]);
        }
    };
}
const writes = c => c.sent.filter(s => !/^SELECT/i.test(s.q.trim()));

test('CSDL đang có bảng: không ghi bất kỳ lệnh nào (không ghi đè, không seed)', async () => {
    const c = stub({ keyspaceExists: true, tables: ['users', 'messages_by_conversation'] });
    const r = await initDb(c, { log: () => {} });
    assert.equal(r.skipped, true);
    assert.deepEqual(writes(c), []);
});

test('máy mới (chưa có keyspace): chỉ CREATE ... IF NOT EXISTS + 8 hồ sơ mẫu INSERT IF NOT EXISTS', async () => {
    const c = stub({ keyspaceExists: false });
    const r = await initDb(c, { log: () => {} });
    const w = writes(c);
    assert.equal(r.skipped, false);
    assert.match(w[0].q, /^CREATE KEYSPACE IF NOT EXISTS chat_ott/);
    const creates = w.filter(s => /^CREATE TABLE IF NOT EXISTS chat_ott\.\w+/.test(s.q));
    assert.equal(creates.length, schemaStatements().length - 1);
    const inserts = w.filter(s => /^INSERT INTO chat_ott\.users .* IF NOT EXISTS$/.test(s.q));
    assert.equal(inserts.length, SAMPLE_USERS.length);
    assert.equal(w.length, 1 + creates.length + inserts.length);
    assert.ok(w.every(s => !/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/i.test(s.q)));
    assert.equal(JSON.stringify(inserts).toLowerCase().includes('password'), false, 'không ghi mật khẩu');
});

test('keyspace có nhưng rỗng (lần init trước dừng giữa chừng): chạy tiếp an toàn bằng IF NOT EXISTS', async () => {
    const c = stub({ keyspaceExists: true, tables: [] });
    const r = await initDb(c, { log: () => {} });
    assert.equal(r.skipped, false);
    assert.ok(writes(c).every(s => /IF NOT EXISTS/.test(s.q)));
});

test('từ chối schema có lệnh phá hủy hoặc sai keyspace', async () => {
    await assert.rejects(initDb(stub({ keyspaceExists: false }), { log: () => {}, statements: ['DROP TABLE users'] }));
    await assert.rejects(initDb(stub({ keyspaceExists: false }), { log: () => {}, statements: ["CREATE KEYSPACE IF NOT EXISTS khac WITH replication = {'class':'SimpleStrategy','replication_factor':1}"] }));
});
