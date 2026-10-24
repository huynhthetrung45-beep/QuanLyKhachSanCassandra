// BENCHMARK THEO KICH THUOC DU LIEU tren Cassandra that, trong keyspace RIENG (mac dinh chat_ott_bench).
// KHONG BAO GIO ghi vao keyspace du lieu that: tu choi neu BENCH_KEYSPACE = CASSANDRA_KEYSPACE / chat_ott.
//   npm run bench:scale -- --confirm                       (kich thuoc 1000,10000,50000 tin / partition)
//   npm run bench:scale -- --confirm --sizes=1000,100000 --runs=50
// Do phan trang 20 tin (trang 1 va trang sau bang Paging State) o moi kich thuoc: p50/p95, thong luong ghi.
// Du lieu sinh ra chi nam trong keyspace bench (xoa bang tay khi khong can: lenh do khong co trong script nay).
const fs = require('fs');
const path = require('path');
const cassandra = require('cassandra-driver');
const { summarize } = require('./lib/benchStats');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const opt = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1];
const KS = process.env.BENCH_KEYSPACE || 'chat_ott_bench';
const MAIN_KS = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
const SIZES = (opt('sizes') || '1000,10000,50000').split(',').map(Number).filter(n => n > 0);
const RUNS = Number(opt('runs') || 30);

async function main() {
    if (!args.includes('--confirm')) {
        console.log(`Lệnh này TẠO keyspace "${KS}" (nếu chưa có) và GHI dữ liệu thử vào đó (${SIZES.join(', ')} tin).`);
        console.log(`Không đụng tới "${MAIN_KS}". Thêm --confirm để chạy.`);
        return;
    }
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(KS) || KS === MAIN_KS || KS === 'chat_ott') {
        throw new Error(`Từ chối: keyspace benchmark "${KS}" trùng hoặc không hợp lệ (dữ liệu thật là "${MAIN_KS}").`);
    }
    const client = new cassandra.Client({
        contactPoints: (process.env.CASSANDRA_HOSTS || '127.0.0.1').split(','),
        localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1'
    });
    await client.connect();
    try {
        await client.execute(`CREATE KEYSPACE IF NOT EXISTS ${KS} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`);
        await client.execute(`CREATE TABLE IF NOT EXISTS ${KS}.messages_by_conversation (
            conversation_id uuid, created_at timestamp, message_id timeuuid, sender_id text, content text,
            PRIMARY KEY ((conversation_id), created_at, message_id)) WITH CLUSTERING ORDER BY (created_at DESC, message_id DESC)`);
        await client.metadata.checkSchemaAgreement();
        const results = [];
        for (const size of SIZES) {
            // 1 partition / kich thuoc; id co dinh theo kich thuoc -> chay lai khong nhan doi (ghi de cung khoa).
            const cid = cassandra.types.Uuid.fromString(`00000000-0000-4000-8000-${String(size).padStart(12, '0')}`);
            const have = (await client.execute(`SELECT COUNT(*) AS n FROM ${KS}.messages_by_conversation WHERE conversation_id = ?`, [cid], { prepare: true })).first().n.toNumber();
            let writeRps = null;
            if (have < size) {
                const t0 = Date.now();
                const base = Date.UTC(2025, 0, 1);
                const insert = `INSERT INTO ${KS}.messages_by_conversation (conversation_id, created_at, message_id, sender_id, content) VALUES (?, ?, ?, ?, ?)`;
                for (let i = have; i < size; i += 200) {
                    await Promise.all(Array.from({ length: Math.min(200, size - i) }, (_, k) => {
                        const at = new Date(base + (i + k) * 1000);
                        return client.execute(insert, [cid, at, cassandra.types.TimeUuid.fromDate(at, i + k), `u${(i + k) % 10}`, `Tin thử số ${i + k}`], { prepare: true });
                    }));
                }
                writeRps = Math.round(((size - have) / (Date.now() - t0)) * 1000);
            }
            const q = `SELECT created_at, message_id, sender_id, content FROM ${KS}.messages_by_conversation WHERE conversation_id = ?`;
            const page = async ps => {
                const t = process.hrtime.bigint();
                const rs = await client.execute(q, [cid], { prepare: true, fetchSize: 20, pageState: ps });
                return { ms: Number(process.hrtime.bigint() - t) / 1e6, rs };
            };
            let deep;
            let ps;
            for (let i = 0; i < 50; i++) { const { rs } = await page(ps); if (!rs.pageState) break; ps = rs.pageState; deep = ps; }
            const first = [];
            const later = [];
            const t0 = Date.now();
            for (let i = 0; i < RUNS; i++) { first.push((await page()).ms); later.push((await page(deep)).ms); }
            const wall = Date.now() - t0;
            const r = { size, writeRps, firstPage: summarize(first, 0, wall / 2), deepPage: summarize(later, 0, wall / 2) };
            results.push(r);
            console.log(`${String(size).padStart(7)} tin | trang 1 p50 ${r.firstPage.p50} ms p95 ${r.firstPage.p95} ms | trang thứ 51 p50 ${r.deepPage.p50} ms p95 ${r.deepPage.p95} ms`
                + (writeRps ? ` | ghi ${writeRps} tin/s` : ''));
        }
        const v = (await client.execute('SELECT release_version FROM system.local')).first();
        const report = { kind: 'BENCHMARK THẬT theo kích thước dữ liệu (keyspace riêng)', takenAt: new Date().toISOString(),
            environment: { cassandra: v.release_version, keyspace: KS, runs: RUNS, node: process.version }, results };
        const dir = path.resolve(__dirname, '../../logs');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `bench-scale-${report.takenAt.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
        console.log(`Đã lưu báo cáo: ${file}`);
    } finally {
        await client.shutdown();
    }
}

main().catch(e => { console.error(`[LỖI] ${e.message}`); process.exitCode = 1; });
