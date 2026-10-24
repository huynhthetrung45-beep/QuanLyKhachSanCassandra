// Do do tre truy van Q2 (NFR-01, NFR-03) tren Cassandra that. CHI DOC.
//   npm run bench                (mac dinh 100 lan / trang)
//   npm run bench -- 200         (so lan tuy chon)
const client = require('../src/config/cassandra');

const CID = process.env.BENCH_CONVERSATION_ID || '11111111-1111-1111-1111-111111111111';
const RUNS = Number(process.argv[2] || 100);
const Q2 = `SELECT conversation_id, created_at, message_id, sender_id, sender_name,
                   content, message_type, is_deleted
            FROM messages_by_conversation WHERE conversation_id = ?`;

const pct = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function timePage(pageState) {
    const t0 = process.hrtime.bigint();
    const rs = await client.execute(Q2, [CID], { prepare: true, fetchSize: 20, pageState });
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, rs };
}

async function main() {
    await client.connect();
    // Lay pageState cua moi trang (doc theo trang, khong tai ca partition).
    const states = [undefined];
    let state;
    for (let i = 1; i < 10; i++) {
        const { rs } = await timePage(state);
        if (!rs.pageState) break;
        state = rs.pageState;
        states.push(state);
    }
    await timePage(); // khoi dong (prepare + cache)

    console.log(`Hội thoại ${CID}, fetchSize 20, ${RUNS} lần mỗi trang\n`);
    console.log('Trang | p50 (ms) | p95 (ms) | max (ms)');
    const p95s = [];
    for (const [i, ps] of states.entries()) {
        const samples = [];
        for (let r = 0; r < RUNS; r++) samples.push((await timePage(ps)).ms);
        p95s.push(pct(samples, 95));
        console.log(`${String(i + 1).padStart(5)} | ${pct(samples, 50).toFixed(2).padStart(8)} | ${pct(samples, 95).toFixed(2).padStart(8)} | ${Math.max(...samples).toFixed(2).padStart(8)}`);
    }
    const first = p95s[0];
    const last = p95s[p95s.length - 1];
    console.log(`\nNFR-01 (p95 trang 1 ≤ 50 ms): ${first.toFixed(2)} ms -> ${first <= 50 ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
    console.log(`NFR-03 (p95 trang ${p95s.length} so với trang 1): ${((last / first - 1) * 100).toFixed(1)}%`);
    console.log('Lưu ý: số liệu dao động theo máy; khi lệch nhỏ dưới 1 ms, tỉ lệ % dễ bị nhiễu.');
}

main()
    .catch(e => { console.error('Lỗi:', e.message); process.exitCode = 1; })
    .finally(() => client.shutdown().catch(() => {}));
