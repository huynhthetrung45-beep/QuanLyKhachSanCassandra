// Unit test cong cu benchmark (khong do hieu nang - chi kiem tra cach tinh va rao an toan).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const { percentile, summarize } = require('../scripts/lib/benchStats');

test('phân vị, thông lượng, tỷ lệ lỗi tính đúng', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepEqual([percentile(s, 50), percentile(s, 95), percentile(s, 99)], [50, 95, 99]);
    const r = summarize([10, 20, 30, 40], 1, 1000);
    assert.deepEqual([r.requests, r.errors, r.errorRate, r.throughputRps, r.p50], [5, 1, 20, 5, 20]);
    assert.equal(percentile([], 50), null);
});

test('bench:scale từ chối ghi vào keyspace dữ liệu thật', () => {
    const script = path.resolve(__dirname, '../scripts/bench-scale.js');
    let out = '';
    try {
        execFileSync(process.execPath, [script, '--confirm'], { env: { ...process.env, BENCH_KEYSPACE: 'chat_ott' }, encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
        out = String(e.stderr) + String(e.stdout);
    }
    assert.match(out, /Từ chối/);
    const dry = execFileSync(process.execPath, [script], { env: { ...process.env, BENCH_KEYSPACE: 'chat_ott_bench' }, encoding: 'utf8' });
    assert.match(dry, /Thêm --confirm để chạy/, 'không có --confirm thì không ghi gì');
});
