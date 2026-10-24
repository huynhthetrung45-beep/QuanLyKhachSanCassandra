// NFR-18: so lieu Prometheus (GET /metrics) + log co cau truc dang JSON (LOG_FORMAT=json).
// Khong dung thu vien ngoai: tu sinh dinh dang text exposition cua Prometheus.
//   METRICS_TOKEN (tuy chon): yeu cau header Authorization: Bearer <token> khi doc /metrics.
const realtime = require('../services/realtime.service');

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const counters = new Map();   // "method|route|status" -> so request
const histograms = new Map(); // "method|route" -> { buckets[], sum, count }

function routeOf(req) {
    if (req.route && req.route.path) return (req.baseUrl || '') + req.route.path;
    return req.originalUrl.startsWith('/api') ? 'unmatched' : 'static';
}

function middleware() {
    const json = process.env.LOG_FORMAT === 'json';
    return (req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const seconds = Number(process.hrtime.bigint() - start) / 1e9;
            const route = routeOf(req);
            const cKey = `${req.method}|${route}|${res.statusCode}`;
            counters.set(cKey, (counters.get(cKey) || 0) + 1);
            const hKey = `${req.method}|${route}`;
            const h = histograms.get(hKey) || { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
            BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i] += 1; });
            h.sum += seconds;
            h.count += 1;
            histograms.set(hKey, h);
            if (json && req.originalUrl !== '/metrics') {
                process.stdout.write(JSON.stringify({
                    time: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
                    msg: 'request', method: req.method, route, path: req.originalUrl.split('?')[0], status: res.statusCode,
                    durationMs: Number((seconds * 1000).toFixed(1)), userId: req.user ? req.user.userId : null,
                    ...(res.locals.logExtra || {})
                }) + '\n');
            }
        });
        next();
    };
}

const esc = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function render() {
    const lines = [];
    lines.push('# HELP chatott_http_requests_total So request HTTP theo method, route, status.');
    lines.push('# TYPE chatott_http_requests_total counter');
    for (const [key, n] of counters) {
        const [method, route, status] = key.split('|');
        lines.push(`chatott_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${status}"} ${n}`);
    }
    lines.push('# HELP chatott_http_request_duration_seconds Thoi gian xu ly request.');
    lines.push('# TYPE chatott_http_request_duration_seconds histogram');
    for (const [key, h] of histograms) {
        const [method, route] = key.split('|');
        const labels = `method="${esc(method)}",route="${esc(route)}"`;
        BUCKETS.forEach((b, i) => lines.push(`chatott_http_request_duration_seconds_bucket{${labels},le="${b}"} ${h.buckets[i]}`));
        lines.push(`chatott_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.count}`);
        lines.push(`chatott_http_request_duration_seconds_sum{${labels}} ${h.sum.toFixed(6)}`);
        lines.push(`chatott_http_request_duration_seconds_count{${labels}} ${h.count}`);
    }
    const mem = process.memoryUsage();
    lines.push('# HELP chatott_sse_connections So ket noi realtime (SSE) dang mo.', '# TYPE chatott_sse_connections gauge',
        `chatott_sse_connections ${realtime.connectionCount()}`);
    lines.push('# HELP chatott_process_resident_memory_bytes Bo nho RSS.', '# TYPE chatott_process_resident_memory_bytes gauge',
        `chatott_process_resident_memory_bytes ${mem.rss}`);
    lines.push('# HELP chatott_process_heap_used_bytes Heap dang dung.', '# TYPE chatott_process_heap_used_bytes gauge',
        `chatott_process_heap_used_bytes ${mem.heapUsed}`);
    lines.push('# HELP chatott_process_uptime_seconds Thoi gian chay.', '# TYPE chatott_process_uptime_seconds gauge',
        `chatott_process_uptime_seconds ${Math.round(process.uptime())}`);
    return lines.join('\n') + '\n';
}

function handler(req, res) {
    const token = process.env.METRICS_TOKEN;
    if (token && req.headers.authorization !== `Bearer ${token}`) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Cần METRICS_TOKEN.' } });
    }
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.send(render());
}

module.exports = { middleware, handler, render };
