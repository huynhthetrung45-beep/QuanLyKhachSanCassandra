// Khoi tao CSDL cho MAY MOI (vua clone tu Git, Cassandra trong).
//   npm run db:init
// An toan voi CSDL dang co du lieu:
//   - Keyspace da co bang -> KHONG lam gi, in huong dan dung "npm run migrate" (khong ghi de, khong seed).
//   - Keyspace chua co / rong -> chay cac lenh CREATE KEYSPACE / CREATE TABLE IF NOT EXISTS trong schema.cql,
//     roi them 8 ho so nguoi dung mau (INSERT ... IF NOT EXISTS) de "npm run seed" va "npm run seed:accounts" dung duoc.
// Khong bao gio chay DROP / TRUNCATE / DELETE / UPDATE; khong ghi mat khau.
const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.resolve(__dirname, '../../schema.cql');
const SAMPLE_USERS = [
    ['user01', 'Nguyễn An'], ['user02', 'Trần Bình'], ['user03', 'Lê Chi'], ['user04', 'Phạm Dũng'],
    ['user05', 'Hoàng Giang'], ['user06', 'Vũ Huy'], ['user07', 'Đặng Linh'], ['user08', 'Bùi Minh']
];
const FORBIDDEN = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|BATCH|GRANT|REVOKE|ALTER)\b/i;

// Tach schema.cql thanh tung cau lenh (bo comment "--", bo USE).
function schemaStatements(text = fs.readFileSync(SCHEMA_FILE, 'utf8')) {
    const noComments = text.split('\n').map(line => line.replace(/--.*$/, '')).join('\n');
    return noComments.split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).filter(s => !/^USE\b/i.test(s));
}

function checkStatements(statements, keyspace) {
    for (const s of statements) {
        if (FORBIDDEN.test(s)) throw new Error(`schema.cql có câu lệnh không được phép: ${s.slice(0, 80)}`);
        if (!/^CREATE (KEYSPACE|TABLE) IF NOT EXISTS\b/i.test(s)) throw new Error(`Chỉ chấp nhận CREATE ... IF NOT EXISTS: ${s.slice(0, 80)}`);
        const ks = s.match(/^CREATE KEYSPACE IF NOT EXISTS (\w+)/i);
        if (ks && ks[1] !== keyspace) throw new Error(`schema.cql tạo keyspace ${ks[1]}, khác CASSANDRA_KEYSPACE=${keyspace}.`);
    }
}

// client: driver da connect (KHONG gan keyspace). Tra ve bao cao; khong ghi gi neu CSDL da co bang.
async function initDb(client, { keyspace = 'chat_ott', log = console.log, statements = schemaStatements() } = {}) {
    checkStatements(statements, keyspace);
    const opts = { prepare: true };
    const ks = await client.execute('SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?', [keyspace], opts);
    const tables = ks.rowLength
        ? (await client.execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [keyspace], opts)).rows
        : [];
    if (tables.length > 0) {
        log(`Keyspace ${keyspace} đã có ${tables.length} bảng -> KHÔNG khởi tạo lại (không ghi đè dữ liệu).`);
        log('Với CSDL đang dùng, hãy chạy: npm run migrate:dry  rồi  npm run migrate');
        return { skipped: true, tables: tables.length, created: 0, usersInserted: 0 };
    }
    let created = 0;
    for (const s of statements) {
        const q = /^CREATE TABLE/i.test(s) ? s.replace(/^CREATE TABLE IF NOT EXISTS (\w+)/i, `CREATE TABLE IF NOT EXISTS ${keyspace}.$1`) : s;
        await client.execute(q);
        created += 1;
    }
    log(`Đã tạo keyspace ${keyspace} và ${created - 1} bảng từ schema.cql.`);
    let usersInserted = 0;
    for (const [id, name] of SAMPLE_USERS) {
        const rs = await client.execute(
            `INSERT INTO ${keyspace}.users (user_id, display_name, created_at) VALUES (?, ?, ?) IF NOT EXISTS`,
            [id, name, new Date()], opts);
        if (rs.wasApplied()) usersInserted += 1;
    }
    log(`Đã thêm ${usersInserted} hồ sơ người dùng mẫu (user01..user08).`);
    return { skipped: false, tables: 0, created, usersInserted };
}

if (require.main === module) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
    const cassandra = require('cassandra-driver');
    const keyspace = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
    const client = new cassandra.Client({
        contactPoints: (process.env.CASSANDRA_HOSTS || '127.0.0.1').split(','),
        localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1'
    });
    (async () => {
        await client.connect();
        const r = await initDb(client, { keyspace });
        if (!r.skipped) {
            console.log('\nTiếp theo: npm run seed  ->  npm run migrate  ->  set DEMO_PASSWORD=...  ->  npm run seed:accounts');
        }
    })()
        .catch(e => {
            console.error(`[LỖI] ${e.message.split('\n')[0]}`);
            if (/NoHostAvailable|ECONNREFUSED|All host/i.test(e.message)) console.error('Cassandra chưa sẵn sàng: chờ container "healthy" (1-2 phút sau docker compose up -d) rồi chạy lại.');
            process.exitCode = 1;
        })
        .finally(() => client.shutdown().catch(() => {}));
}

module.exports = { initDb, schemaStatements, SAMPLE_USERS };
