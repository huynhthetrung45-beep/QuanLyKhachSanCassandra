// BENCHMARK QUA HTTP tren backend DANG CHAY (Cassandra that). CHI DOC: chi goi API GET.
//   set "BENCH_EMAIL=an@chatott.demo"
//   set "BENCH_PASSWORD=..."
//   npm run bench:api                 (mac dinh 100 request / kich ban / muc dong thoi)
//   npm run bench:api -- 300 1,5,20   (so request, cac muc dong thoi)
// Do: p50/p95/p99/max (ms), thong luong (req/s), ty le loi, CPU/RAM cua tien trinh do.
// Bao cao JSON: logs/bench-api-<thoi diem>.json (kem cau hinh moi truong). Khong ghi mat khau vao bao cao.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { summarize } = require('./lib/benchStats');

const BASE = (process.env.BENCH_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const REQUESTS = Number(process.argv[2] || 100);
const LEVELS = String(process.argv[3] || '1,5,20').split(',').map(Number).filter(n => n > 0);
const ORIGIN = process.env.BENCH_ORIGIN || 'http://localhost:5173';

let cookie = '';
async function call(pathname) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(BASE + '/api/v1' + pathname, { headers: { Cookie: cookie, Origin: ORIGIN } });
    const body = await res.json().catch(() => null);
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, ok: res.ok, status: res.status, body };
}

async function login() {
    const email = process.env.BENCH_EMAIL;
    const password = process.env.BENCH_PASSWORD;
    if (!email || !password) throw new Error('Thiếu BENCH_EMAIL / BENCH_PASSWORD (tài khoản thật để đo).');
    const res = await fetch(BASE + '/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email, password })
    });
    if (!res.ok) throw new Error(`Đăng nhập thất bại (HTTP ${res.status}).`);
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}

async function runScenario(name, makePath, level) {
    const latencies = [];
    let errors = 0;
    let next = 0;
    const t0 = Date.now();
    const worker = async () => {
        while (next < REQUESTS) {
            const i = next++;
            try {
                const r = await call(await makePath(i));
                if (r.ok) latencies.push(r.ms); else errors += 1;
            } catch {
                errors += 1;
            }
        }
    };
    await Promise.all(Array.from({ length: level }, worker));
    return { scenario: name, concurrency: level, ...summarize(latencies, errors, Date.now() - t0) };
}

async function main() {
    await login();
    const health = (await call('/../health').catch(() => null))?.body || null;
    const convs = (await call('/me/conversations')).body?.data || [];
    if (!convs.length) throw new Error('Tài khoản đo không có hội thoại nào.');
    // Hoi thoai lon nhat theo thong ke (neu da co migration 006), mac dinh hoi thoai dau tien.
    let target = convs[0].conversationId;
    let best = -1;
    for (const c of convs.slice(0, 20)) {
        const a = (await call(`/conversations/${c.conversationId}/analytics`)).body;
        if (a && a.totalMessages > best) { best = a.totalMessages; target = c.conversationId; }
    }
    // Chuan bi token cac trang sau (de do phan trang sau).
    const tokens = [];
    let tok = null;
    for (let i = 0; i < 10; i++) {
        const r = (await call(`/conversations/${target}/messages${tok ? `?pageToken=${encodeURIComponent(tok)}` : ''}`)).body;
        if (!r?.nextPageToken) break;
        tok = r.nextPageToken;
        tokens.push(tok);
    }
    const scenarios = [
        ['chat: trang 1 (20 tin)', () => `/conversations/${target}/messages`],
        ['chat: trang sâu (theo pageToken)', i => (tokens.length ? `/conversations/${target}/messages?pageToken=${encodeURIComponent(tokens[i % tokens.length])}` : `/conversations/${target}/messages`)],
        ['danh sách hội thoại', () => '/me/conversations'],
        ['bảng tin trang 1', () => '/feed'],
        ['tìm kiếm từ khóa', () => `/search/messages?q=${encodeURIComponent(process.env.BENCH_QUERY || 'tin')}`],
        ['thông báo trang 1', () => '/notifications'],
        ['thống kê hội thoại', () => `/conversations/${target}/analytics`]
    ];
    const cpu0 = process.cpuUsage();
    const results = [];
    console.log(`Benchmark HTTP ${BASE} | ${REQUESTS} request / kịch bản | đồng thời ${LEVELS.join(', ')}`);
    console.log(`Hội thoại đo: ${target} (${best >= 0 ? best + ' tin' : 'không rõ số tin'}), ${tokens.length} trang sâu\n`);
    console.log('Kịch bản                          | đồng thời | p50 ms | p95 ms | p99 ms | req/s | lỗi %');
    for (const [name, mk] of scenarios) {
        for (const level of LEVELS) {
            const r = await runScenario(name, mk, level);
            results.push(r);
            console.log(`${name.padEnd(34)}| ${String(level).padStart(9)} | ${String(r.p50).padStart(6)} | ${String(r.p95).padStart(6)} | ${String(r.p99).padStart(6)} | ${String(r.throughputRps).padStart(5)} | ${r.errorRate}`);
        }
    }
    const cpu = process.cpuUsage(cpu0);
    const report = {
        kind: 'BENCHMARK THẬT qua HTTP (không phải mock)',
        takenAt: new Date().toISOString(),
        environment: {
            baseUrl: BASE, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`,
            cpus: `${os.cpus().length} × ${os.cpus()[0]?.model || '?'}`, totalMemGB: Math.round(os.totalmem() / 1e9 * 10) / 10,
            backendHealth: health ? { status: health.status, keyspace: health.keyspace } : null,
            requestsPerScenario: REQUESTS, concurrencyLevels: LEVELS, conversationId: target, conversationMessages: best
        },
        clientResources: { cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000), rssMB: Math.round(process.memoryUsage().rss / 1e6) },
        note: 'Đo từ máy chạy lệnh tới backend; tài nguyên phía server cần xem bằng docker stats / Task Manager trong lúc đo.',
        results
    };
    const dir = path.resolve(__dirname, '../../logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `bench-api-${report.takenAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nĐã lưu báo cáo: ${file}`);
}

main().catch(e => { console.error(`[LỖI] ${e.message}`); process.exitCode = 1; });
