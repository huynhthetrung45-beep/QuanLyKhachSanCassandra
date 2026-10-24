// Thoi gian cua timeuuid (v1) va bucket thang cho bang tin cong khai.
// Dung CHUNG cho backend va migrate.js (backfill) -> cung mot cach tinh bucket.

// Moc thoi gian 100ns cua timeuuid (BigInt) - dung thu tu nhu Cassandra so sanh timeuuid.
function ticksOf(id) {
    const s = String(id).toLowerCase();
    const [low, mid, hiVer] = s.split('-');
    return (BigInt('0x' + hiVer.slice(1)) << 48n) | (BigInt('0x' + mid) << 32n) | BigInt('0x' + low);
}

// So sanh giam dan (moi nhat truoc); hoa: so phan con lai cua chuoi de thu tu on dinh.
function compareDesc(a, b) {
    const ta = ticksOf(a);
    const tb = ticksOf(b);
    if (ta !== tb) return ta > tb ? -1 : 1;
    const sa = String(a);
    const sb = String(b);
    return sa === sb ? 0 : (sa > sb ? -1 : 1);
}

// 'YYYY-MM' theo UTC cua thoi diem tao timeuuid.
function bucketOf(id) {
    const d = id.getDate ? id.getDate() : new Date(Number((ticksOf(id) - 122192928000000000n) / 10000n));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function previousBucket(bucket) {
    const [y, m] = bucket.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

module.exports = { ticksOf, compareDesc, bucketOf, previousBucket };
