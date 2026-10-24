// TRIEN KHAI MIGRATION CO KIEM SOAT (chay MOT lan tren may Windows):
//   cd /d D:\ChatOTT
//   npm run deploy:migration
//
// A. Moi truong (chi doc): thu muc, Docker, container, ket noi driver, backend dang chay?
// B. Truoc khi ghi (chi doc): anh chup du lieu cu, dry-run, verify "before".
// C. Hoi xac nhan: phai go dung MIGRATE. Khong co tuy chon bo qua.
// D. Ghi: chay "npm run migrate" DUNG MOT LAN. That bai -> dung, khong chay lai, khong seed.
// E. Sau migration (chi doc): anh chup lan 2 + so sanh, kiem tra backfill tinh tu du lieu nguon,
//    npm run audit:db, verify "after".
// F. Ung dung (khong ghi Cassandra): npm test (gia lap), khoi dong backend tam o cong rieng va
//    goi /api/health + 1 API can dang nhap, build frontend.
// Toan bo output va ma thoat ghi vao logs\deploy-<thoi diem>\ (khong co mat khau / token).
const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const CONTAINER = process.env.CASSANDRA_CONTAINER || 'chatott-cassandra';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_DIR = path.join(ROOT, 'logs', `deploy-${stamp}`);
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'deploy.log');

// Migration moi nhat (so lon nhat trong db/migrations) va file kiem tra tuong ung.
const MIGRATION_ID = fs.readdirSync(path.join(ROOT, 'db/migrations'))
    .map(f => (f.match(/^(\d{3})_.*\.cql$/) || [])[1]).filter(Boolean).sort().pop();
const verifyFile = mode => (MIGRATION_ID === '001'
    ? `db/verify-${mode}-migration.cql`
    : `db/verify-${MIGRATION_ID}-${mode}.cql`);

const results = [];
function log(text = '') {
    process.stdout.write(text + '\n');
    fs.appendFileSync(LOG_FILE, text + '\n');
}
function record(stage, name, ok, detail = '') {
    results.push({ stage, name, ok, detail });
    log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
    return ok;
}
function header(t) { log(''); log('='.repeat(78)); log(t); log('='.repeat(78)); }

function run(label, cmd, args, { input, env, cwd = ROOT } = {}) {
    log(`\n$ ${cmd} ${args.join(' ')}`);
    const res = spawnSync(cmd, args, {
        cwd, input, encoding: 'utf8', shell: process.platform === 'win32' && cmd !== 'docker',
        env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024
    });
    const out = (res.stdout || '') + (res.stderr ? `\n[stderr]\n${res.stderr}` : '');
    const file = path.join(LOG_DIR, `${label}.txt`);
    fs.writeFileSync(file, out + `\n[exit code] ${res.status}\n`);
    out.split('\n').forEach(line => log('    ' + line));
    log(`  -> mã thoát ${res.status}${res.error ? ' (' + res.error.message + ')' : ''}; lưu tại ${path.relative(ROOT, file)}`);
    return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', error: res.error };
}

function httpGet(url, timeoutMs = 2000) {
    return new Promise(resolve => {
        const req = http.get(url, res => {
            let body = '';
            res.on('data', c => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    });
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, a => { rl.close(); fs.appendFileSync(LOG_FILE, `${question}${a}\n`); resolve(a.trim()); }));
}

function cqlshFile(label, file) {
    const res = run(label, 'docker', ['exec', '-i', CONTAINER, 'cqlsh'], { input: fs.readFileSync(path.join(ROOT, file), 'utf8') });
    const errors = (res.stdout + '\n' + res.stderr).split('\n')
        .filter(l => /(SyntaxException|InvalidRequest|ServerError|Error from server|Unauthorized|<stdin>:\d+:)/.test(l));
    return { ...res, errors };
}

function finish(code) {
    header('TÓM TẮT');
    for (const r of results) log(`  ${r.ok ? 'PASS' : 'FAIL'}  [${r.stage}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    const failed = results.filter(r => !r.ok).length;
    log(`\n${results.length - failed}/${results.length} kiểm tra đạt. Log đầy đủ: ${path.relative(ROOT, LOG_DIR)}`);
    fs.writeFileSync(path.join(LOG_DIR, 'summary.json'), JSON.stringify({ code, results }, null, 2));
    process.exitCode = code;
}

async function main() {
    log(`ChatOTT - triển khai migration có kiểm soát | ${new Date().toISOString()}`);
    log(`Thư mục: ${ROOT}`);

    // ---------------- A. MOI TRUONG ----------------
    header('A. Kiểm tra môi trường (chỉ đọc)');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const filesOk = ['backend/scripts/migrate.js', 'backend/scripts/audit-db.js', verifyFile('before'), verifyFile('after')]
        .every(f => fs.existsSync(path.join(ROOT, f)));
    if (!record('A', 'Đúng thư mục dự án và đủ script', pkg.name === 'chatott' && filesOk && Boolean(pkg.scripts.migrate),
        `package ${pkg.name}, migration mới nhất ${MIGRATION_ID}, kiểm tra ${verifyFile('before')} / ${verifyFile('after')}`)) return finish(1);

    const insp = run('A-docker-inspect', 'docker', ['inspect', '-f', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}', CONTAINER]);
    const state = insp.stdout.trim();
    if (!record('A', `Container ${CONTAINER} đang chạy`, insp.status === 0 && state.startsWith('running'), state || insp.stderr.trim())) return finish(1);

    const backend = await httpGet('http://127.0.0.1:3000/api/health');
    if (!record('A', 'Backend cổng 3000 đã dừng (tránh chạy song song với migration)', backend === null,
        backend ? `đang chạy (HTTP ${backend.status}) - hãy dừng backend rồi chạy lại` : 'không có tiến trình lắng nghe')) return finish(1);

    const client = require('../src/config/cassandra');
    const keyspace = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
    try {
        await client.connect();
        const v = (await client.execute('SELECT release_version, cluster_name FROM system.local')).first();
        record('A', 'Kết nối Cassandra qua driver backend', true, `Cassandra ${v.release_version}, cluster ${v.cluster_name}, keyspace ${keyspace}`);
    } catch (e) {
        record('A', 'Kết nối Cassandra qua driver backend', false, `${e.name}: ${String(e.message).split('\n')[0]}`);
        return finish(1);
    }

    const { runMigration } = require('./migrate');
    const { takeSnapshot, compareSnapshots, expectedBackfill, verifyBackfill } = require('./lib/dbSnapshot');

    try {
        // ---------------- B. TRUOC KHI GHI ----------------
        header('B. Đánh giá trước khi ghi (chỉ đọc)');
        const before = await takeSnapshot(client, keyspace);
        fs.writeFileSync(path.join(LOG_DIR, 'snapshot-before.json'), JSON.stringify(before, null, 2));
        record('B', 'Ảnh chụp dữ liệu cũ', true,
            `users=${before.counts.users}, conversations=${before.counts.conversations}, membership=${before.counts.membershipRows}, messages=${before.counts.messages}`);

        const exp = expectedBackfill(before);
        record('B', 'Kỳ vọng backfill tính từ dữ liệu nguồn', true,
            `direct_conversations=${exp.pairs.size}${exp.duplicatePairs.length ? ` (cặp trùng: ${exp.duplicatePairs.join(', ')})` : ''}, users_by_name_token=${exp.tokens.length}`);

        const dryLines = [];
        let plan;
        try {
            plan = await runMigration(client, { keyspace, dryRun: true, log: l => { dryLines.push(l); log('    ' + l); } });
        } catch (e) {
            fs.writeFileSync(path.join(LOG_DIR, 'B-dry-run.txt'), dryLines.join('\n') + '\n' + e.message);
            record('B', 'Dry-run migration', false, e.message.split('\n').join(' | '));
            return finish(1);
        }
        fs.writeFileSync(path.join(LOG_DIR, 'B-dry-run.txt'), dryLines.join('\n'));
        record('B', 'Dry-run migration', plan.executedWrites === 0,
            `tạo ${plan.created.length} bảng, thêm ${plan.added.length} cột, đã có: ${plan.skipped.length}, ${plan.writeStatements} lệnh ghi dự kiến, 0 lệnh đã gửi`);
        const partial = plan.skipped.length > 0;
        if (partial) log(`  ! Schema đã có một phần (${plan.skipped.join(', ')}) - migration sẽ chỉ làm phần còn thiếu.`);

        const vb = cqlshFile('B-verify-before', verifyFile('before'));
        record('B', `verify-migration before ${MIGRATION_ID} (cqlsh)`, vb.status === 0 && vb.errors.length === 0,
            vb.errors.length ? vb.errors.slice(0, 3).join(' | ') : `mã thoát ${vb.status}`);

        // ---------------- C. XAC NHAN ----------------
        header('C. Xác nhận ghi vào Cassandra thật');
        log(`  Sẽ chạy MỘT lần: npm run migrate  ->  keyspace ${keyspace}`);
        log(`  Thay đổi: ${plan.created.length} bảng mới (${plan.created.join(', ') || 'không'}), ${plan.added.length} cột mới (${plan.added.join(', ') || 'không'}) - dòng cũ = null.`);
        log(`  Lệnh ghi dự kiến: ${plan.writeStatements} (backfill chỉ ghi phần còn thiếu vào bảng mới).`);
        if (plan.writeStatements === 0) {
            record('C', 'Có thay đổi cần áp dụng', false, 'schema đã đầy đủ - không có gì để migrate');
            return finish(0);
        }
        log('  Không DROP / TRUNCATE / DELETE; không đổi replication, TTL, compaction, gc_grace.');
        log('  Không có bản sao lưu (theo quyết định của bạn).');
        const answer = await ask('\n  Gõ MIGRATE (chữ hoa) để tiếp tục, phím khác để dừng: ');
        if (!record('C', 'Người dùng xác nhận', answer === 'MIGRATE', answer === 'MIGRATE' ? 'đã gõ MIGRATE' : 'không xác nhận - dừng, không ghi gì')) return finish(2);

        // ---------------- D. GHI ----------------
        header('D. Chạy migration thật (một lần)');
        await client.shutdown().catch(() => {});
        const mig = run('D-npm-run-migrate', 'npm', ['run', 'migrate']);
        if (!record('D', 'npm run migrate', mig.status === 0, `mã thoát ${mig.status}`)) {
            log('  Migration thất bại: KHÔNG chạy lại, KHÔNG seed. Trạng thái schema hiện tại (chỉ đọc):');
            run('D-state-after-failure', 'npm', ['run', 'migrate:dry']);
            return finish(1);
        }

        // ---------------- E. SAU MIGRATION ----------------
        header('E. Xác minh sau migration (chỉ đọc)');
        const cassandra = require('cassandra-driver');
        const client2 = new cassandra.Client({
            contactPoints: (process.env.CASSANDRA_HOSTS || '127.0.0.1').split(','),
            localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1',
            keyspace
        });
        await client2.connect();
        try {
            const again = await runMigration(client2, { keyspace, dryRun: true, log: () => {} });
            record('E', 'Schema khớp thiết kế (dry-run lần 2: không còn gì để tạo)',
                again.created.length === 0 && again.added.length === 0 && again.mismatches.length === 0,
                `tạo ${again.created.length}, thêm ${again.added.length}, đã có ${again.skipped.length}`);

            const after = await takeSnapshot(client2, keyspace);
            fs.writeFileSync(path.join(LOG_DIR, 'snapshot-after.json'), JSON.stringify(after, null, 2));
            const diff = compareSnapshots(before, after);
            record('E', 'Dữ liệu cũ, cột/khóa cũ, replication, TTL, compaction, gc_grace không đổi', diff.length === 0,
                diff.length ? diff.join('; ') : `users=${after.counts.users}, conversations=${after.counts.conversations}, membership=${after.counts.membershipRows}, messages=${after.counts.messages}`);

            const bf = await verifyBackfill(client2, exp);
            record('E', 'Backfill đúng theo dữ liệu nguồn', bf.length === 0,
                bf.length ? bf.slice(0, 5).join('; ') : `${exp.pairs.size} cặp 1-1, ${exp.tokens.length} token`);
        } finally {
            await client2.shutdown().catch(() => {});
        }

        const audit = run('E-audit-db', 'npm', ['run', 'audit:db']);
        record('E', 'npm run audit:db', audit.status === 0 && /Không phát hiện bất nhất/.test(audit.stdout),
            audit.status === 0 ? (audit.stdout.match(/\d+ vấn đề cần xem/) || ['không phát hiện bất nhất'])[0] : `mã thoát ${audit.status}`);

        const va = cqlshFile('E-verify-after', verifyFile('after'));
        record('E', `verify-migration after ${MIGRATION_ID} (cqlsh)`, va.status === 0 && va.errors.length === 0,
            va.errors.length ? va.errors.slice(0, 3).join(' | ') : `mã thoát ${va.status}`);

        // ---------------- F. UNG DUNG (khong ghi Cassandra) ----------------
        header('F. Kiểm tra ứng dụng (không ghi Cassandra thật)');
        const unit = run('F-npm-test-mock', 'npm', ['test']);
        const m = unit.stdout.match(/# pass (\d+)[\s\S]*?# fail (\d+)/);
        record('F', 'npm test (Cassandra GIẢ LẬP)', unit.status === 0, m ? `${m[1]} đạt, ${m[2]} lỗi` : `mã thoát ${unit.status}`);

        const port = '3999';
        log(`\n$ node backend/src/app.js  (PORT=${port}, tạm thời, chỉ gọi API đọc)`);
        const server = spawn(process.execPath, ['backend/src/app.js'], {
            cwd: ROOT, env: { ...process.env, PORT: port, LOG_REQUESTS: 'false' }
        });
        let serverOut = '';
        server.stdout.on('data', d => (serverOut += d));
        server.stderr.on('data', d => (serverOut += d));
        let health = null;
        for (let i = 0; i < 40 && !health; i++) {
            await new Promise(r => setTimeout(r, 500));
            health = await httpGet(`http://127.0.0.1:${port}/api/health`);
        }
        const protectedApi = health ? await httpGet(`http://127.0.0.1:${port}/api/v1/me/conversations`) : null;
        server.kill();
        fs.writeFileSync(path.join(LOG_DIR, 'F-backend.txt'), serverOut + `\nhealth: ${JSON.stringify(health)}\nprotected: ${JSON.stringify(protectedApi)}\n`);
        serverOut.split('\n').forEach(l => log('    ' + l));
        let healthBody = {};
        try { healthBody = JSON.parse(health ? health.body : '{}'); } catch { /* bo qua */ }
        record('F', 'Backend khởi động, /api/health = OK, không thiếu bảng', Boolean(health) && health.status === 200 && healthBody.status === 'OK',
            health ? `HTTP ${health.status}, status=${healthBody.status}, missingTables=${JSON.stringify(healthBody.missingTables)}` : 'không phản hồi');
        record('F', 'API chat chặn khi chưa đăng nhập', Boolean(protectedApi) && protectedApi.status === 401,
            protectedApi ? `HTTP ${protectedApi.status}` : 'không phản hồi');

        const fe = run('F-frontend-build', 'npm', ['--prefix', 'frontend', 'run', 'build']);
        record('F', 'Build frontend', fe.status === 0, `mã thoát ${fe.status}`);

        return finish(results.every(r => r.ok) ? 0 : 1);
    } finally {
        await client.shutdown().catch(() => {});
    }
}

main().catch(e => {
    log(`\n[LỖI KHÔNG MONG ĐỢI] ${e.name}: ${String(e.message).split('\n')[0]}`);
    finish(1);
});
