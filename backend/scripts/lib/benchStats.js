// Thong ke cho benchmark: phan vi, thong luong, ty le loi. Ham thuan (co unit test).
function percentile(samples, p) {
    if (!samples.length) return null;
    const s = [...samples].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[idx];
}

function summarize(latencies, errors, wallMs) {
    const total = latencies.length + errors;
    const round = v => (v == null ? null : Math.round(v * 100) / 100);
    return {
        requests: total,
        ok: latencies.length,
        errors,
        errorRate: total ? round((errors / total) * 100) : 0,
        throughputRps: wallMs > 0 ? round((total / wallMs) * 1000) : null,
        p50: round(percentile(latencies, 50)),
        p95: round(percentile(latencies, 95)),
        p99: round(percentile(latencies, 99)),
        max: round(latencies.length ? Math.max(...latencies) : null)
    };
}

module.exports = { percentile, summarize };
