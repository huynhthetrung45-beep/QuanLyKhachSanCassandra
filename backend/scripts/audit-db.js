// KIEM TRA CSDL CHI DOC (read-only). Khong co INSERT / UPDATE / DELETE / DDL.
// Chay tu thu muc goc:  node backend\scripts\audit-db.js
// In ra: keyspace & replication, toan bo bang/cot/khoa, index, view, tuy chon bang,
// so luong ban ghi, tinh nhat quan giua bang chinh va bang phi chuan hoa, kiem tra paging.
const client = require('../src/config/cassandra');

const KS = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
const FOCUS = '11111111-1111-1111-1111-111111111111';
const opts = { prepare: true };

// Cac bang/cot ma backend hien tai truy van (doi chieu voi schema that)
const USED_BY_CODE = {
    users: ['user_id', 'display_name', 'avatar_url', 'email', 'created_at'],
    conversations: ['conversation_id', 'conversation_name', 'conversation_type', 'participant_ids', 'created_by', 'created_at', 'last_message_at'],
    conversations_by_user: ['user_id', 'last_message_at', 'conversation_id', 'conversation_name', 'conversation_type', 'last_message_preview', 'last_sender_name', 'last_sender_id'],
    messages_by_conversation: ['conversation_id', 'created_at', 'message_id', 'sender_id', 'sender_name', 'content', 'message_type', 'is_deleted', 'deleted_at'],
    accounts_by_email: ['email', 'user_id', 'password_hash', 'status', 'created_at'],
    sessions: ['session_hash', 'user_id', 'created_at', 'expires_at'],
    direct_conversations: ['pair_key', 'conversation_id', 'created_at'],
    conversation_state_by_user: ['user_id', 'conversation_id', 'last_read_at', 'pinned'],
    users_by_name_token: ['token_prefix', 'name_token', 'user_id', 'display_name', 'avatar_url']
};

const line = (t = '') => console.log(t);
const h = t => { line(); line('='.repeat(78)); line(t); line('='.repeat(78)); };
const ms = d => (d ? new Date(d).getTime() : null);
const issues = [];
const warn = msg => { issues.push(msg); line('  [!] ' + msg); };

async function schema() {
    h('1. KEYSPACE');
    const ks = (await client.execute(
        'SELECT keyspace_name, durable_writes, replication FROM system_schema.keyspaces WHERE keyspace_name = ?', [KS], opts)).first();
    if (!ks) throw new Error(`Không tìm thấy keyspace ${KS}`);
    line(`  ${ks.keyspace_name} | durable_writes=${ks.durable_writes} | replication=${JSON.stringify(ks.replication)}`);

    h('2. BẢNG, CỘT, KHÓA');
    const tables = (await client.execute(
        `SELECT table_name, default_time_to_live, gc_grace_seconds, compaction, comment
         FROM system_schema.tables WHERE keyspace_name = ?`, [KS], opts)).rows
        .sort((a, b) => a.table_name.localeCompare(b.table_name));
    const real = {};
    for (const t of tables) {
        const cols = (await client.execute(
            `SELECT column_name, kind, position, clustering_order, type
             FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?`, [KS, t.table_name], opts)).rows;
        real[t.table_name] = new Set(cols.map(c => c.column_name));
        const pk = cols.filter(c => c.kind === 'partition_key').sort((a, b) => a.position - b.position);
        const ck = cols.filter(c => c.kind === 'clustering').sort((a, b) => a.position - b.position);
        const regular = cols.filter(c => c.kind === 'regular' || c.kind === 'static').sort((a, b) => a.column_name.localeCompare(b.column_name));
        line();
        line(`  TABLE ${t.table_name}`);
        line(`    PRIMARY KEY ((${pk.map(c => c.column_name).join(', ')})${ck.length ? ', ' + ck.map(c => c.column_name).join(', ') : ''})`);
        if (ck.length) line(`    CLUSTERING ORDER BY (${ck.map(c => `${c.column_name} ${c.clustering_order.toUpperCase()}`).join(', ')})`);
        [...pk, ...ck, ...regular].forEach(c => line(`      ${c.column_name.padEnd(22)} ${c.type.padEnd(14)} ${c.kind}`));
        line(`    default_ttl=${t.default_time_to_live} gc_grace=${t.gc_grace_seconds} compaction=${t.compaction?.class}`);
    }

    h('3. INDEX / MATERIALIZED VIEW / UDT');
    const idx = (await client.execute('SELECT table_name, index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = ?', [KS], opts)).rows;
    line(`  Secondary index: ${idx.length ? idx.map(i => `${i.table_name}.${i.index_name} (${i.kind})`).join(', ') : 'không có'}`);
    const views = (await client.execute('SELECT view_name, base_table_name FROM system_schema.views WHERE keyspace_name = ?', [KS], opts)).rows;
    line(`  Materialized view: ${views.length ? views.map(v => `${v.view_name} <- ${v.base_table_name}`).join(', ') : 'không có'}`);
    const types = (await client.execute('SELECT type_name FROM system_schema.types WHERE keyspace_name = ?', [KS], opts)).rows;
    line(`  User-defined type: ${types.length ? types.map(t => t.type_name).join(', ') : 'không có'}`);

    h('4. ĐỐI CHIẾU CỘT MÀ BACKEND TRUY VẤN');
    for (const [table, cols] of Object.entries(USED_BY_CODE)) {
        if (!real[table]) { line(`  ${table.padEnd(28)} CHƯA CÓ BẢNG (migration 001 sẽ tạo)`); continue; }
        const missing = cols.filter(c => !real[table].has(c));
        const extra = [...real[table]].filter(c => !cols.includes(c));
        line(`  ${table.padEnd(28)} ${missing.length ? 'THIẾU CỘT: ' + missing.join(', ') : 'đủ cột'}${extra.length ? ' | cột không dùng: ' + extra.join(', ') : ''}`);
    }
    return real;
}

async function data(real) {
    h('5. DỮ LIỆU (chỉ đọc)');
    const users = (await client.execute('SELECT user_id, display_name FROM users', [], { ...opts, fetchSize: 1000 })).rows;
    const userIds = new Set(users.map(u => u.user_id));
    const names = new Map(users.map(u => [u.user_id, u.display_name]));
    line(`  users: ${users.length} dòng`);

    const convs = (await client.execute(
        'SELECT conversation_id, conversation_name, conversation_type, participant_ids, last_message_at FROM conversations',
        [], { ...opts, fetchSize: 1000 })).rows;
    line(`  conversations: ${convs.length} dòng`);

    let total = 0;
    const membership = new Map(); // user -> Set(cid)
    for (const c of convs) {
        const cid = c.conversation_id.toString();
        const members = [...(c.participant_ids || [])];
        members.forEach(m => {
            if (!membership.has(m)) membership.set(m, new Set());
            membership.get(m).add(cid);
            if (!userIds.has(m)) warn(`${cid}: thành viên ${m} không có trong users`);
        });
        const count = Number((await client.execute(
            'SELECT COUNT(*) AS n FROM messages_by_conversation WHERE conversation_id = ?', [c.conversation_id], opts)).first().n);
        total += count;
        const head = (await client.execute(
            `SELECT created_at, message_id, sender_id, sender_name, content, is_deleted
             FROM messages_by_conversation WHERE conversation_id = ? LIMIT 1`, [c.conversation_id], opts)).first();
        line(`  ${cid} ${String(count).padStart(4)} tin | ${members.length} TV | ${c.conversation_type.padEnd(6)} | ${c.conversation_name}`);

        // Nhat quan: conversations.last_message_at so voi tin dau partition
        if (head && ms(c.last_message_at) !== ms(head.created_at)) {
            line(`      conversations.last_message_at=${c.last_message_at?.toISOString()} khác tin mới nhất=${head.created_at.toISOString()}${head.is_deleted ? ' (tin mới nhất đã thu hồi)' : ''}`);
        }
        if (head && head.sender_id && names.has(head.sender_id) && names.get(head.sender_id) !== head.sender_name) {
            line(`      sender_name "${head.sender_name}" khác users.display_name "${names.get(head.sender_id)}" (bản sao phi chuẩn hóa)`);
        }
        c._head = head;
    }
    line(`  Tổng tin nhắn: ${total}`);

    h('6. NHẤT QUÁN conversations_by_user  <->  conversations');
    let indexRows = 0;
    const byId = new Map(convs.map(c => [c.conversation_id.toString(), c]));
    const allUsers = new Set([...userIds, ...membership.keys()]);
    for (const u of [...allUsers].sort()) {
        const rows = (await client.execute(
            `SELECT last_message_at, conversation_id, conversation_name, last_message_preview, last_sender_name
             FROM conversations_by_user WHERE user_id = ?`, [u], opts)).rows;
        indexRows += rows.length;
        const seen = new Map();
        rows.forEach(r => {
            const cid = r.conversation_id.toString();
            seen.set(cid, (seen.get(cid) || 0) + 1);
            const c = byId.get(cid);
            if (!c) return warn(`${u}: dòng trỏ tới hội thoại không tồn tại ${cid}`);
            if (!(c.participant_ids || []).includes(u)) warn(`${u}: còn dòng của hội thoại ${cid} nhưng không còn là thành viên`);
            if (ms(r.last_message_at) !== ms(c.last_message_at)) {
                warn(`${u}/${cid}: last_message_at ${r.last_message_at?.toISOString()} ≠ conversations ${c.last_message_at?.toISOString()}`);
            }
        });
        for (const [cid, n] of seen) if (n > 1) warn(`${u}: hội thoại ${cid} xuất hiện ${n} lần (trùng)`);
        for (const cid of membership.get(u) || []) if (!seen.has(cid)) warn(`${u}: là thành viên ${cid} nhưng thiếu dòng trong danh sách`);
        line(`  ${u.padEnd(10)} ${rows.length} dòng`);
    }
    line(`  Tổng dòng conversations_by_user: ${indexRows}`);

    h('7. PHÂN TRANG Q2 TRÊN HỘI THOẠI TRỌNG TÂM (fetchSize 20, không LIMIT)');
    const Q2 = `SELECT conversation_id, created_at, message_id, sender_id, sender_name, content, message_type, is_deleted
                FROM messages_by_conversation WHERE conversation_id = ?`;
    let pageState;
    let page = 0;
    const ids = new Set();
    let prev = null;
    let ordered = true;
    const sizes = [];
    do {
        const t0 = process.hrtime.bigint();
        const rs = await client.execute(Q2, [FOCUS], { ...opts, fetchSize: 20, pageState });
        const took = Number(process.hrtime.bigint() - t0) / 1e6;
        page += 1;
        sizes.push(rs.rowLength);
        rs.rows.forEach(r => {
            const key = [ms(r.created_at), r.message_id.toString()];
            if (prev && (key[0] > prev[0] || (key[0] === prev[0] && key[1] === prev[1]))) ordered = false;
            prev = key;
            ids.add(r.message_id.toString());
        });
        if (page <= 2 || !rs.pageState) {
            line(`  trang ${String(page).padStart(2)}: ${rs.rowLength} dòng, pageState ${rs.pageState ? 'có' : 'null'}, ${took.toFixed(2)} ms`);
        }
        pageState = rs.pageState;
    } while (pageState && page < 100);
    const focusCount = Number((await client.execute(
        'SELECT COUNT(*) AS n FROM messages_by_conversation WHERE conversation_id = ?', [FOCUS], opts)).first().n);
    line(`  Số trang: ${page} | kích thước: ${sizes.join(',')}`);
    line(`  Tổng đọc qua trang: ${ids.size} id duy nhất | COUNT(*): ${focusCount} | thứ tự giảm dần: ${ordered ? 'đúng' : 'SAI'}`);
    if (ids.size !== focusCount) warn('Duyệt trang không khớp COUNT(*)');
    if (sizes.slice(0, -1).some(s => s !== 20)) warn('Có trang giữa không đủ 20 dòng');

    h('8. TIN TRÙNG created_at (BR-07) VÀ TIN ĐÃ THU HỒI');
    // Chi doc partition trong tam (nho) de thong ke.
    const all = (await client.execute(
        'SELECT created_at, is_deleted, content FROM messages_by_conversation WHERE conversation_id = ?',
        [FOCUS], { ...opts, fetchSize: 500 })).rows;
    const byTs = new Map();
    all.forEach(r => byTs.set(ms(r.created_at), (byTs.get(ms(r.created_at)) || 0) + 1));
    line(`  Cặp/nhóm trùng created_at: ${[...byTs.values()].filter(n => n > 1).length}`);
    line(`  Tin đã thu hồi: ${all.filter(r => r.is_deleted).length}; thu hồi nhưng còn content: ${all.filter(r => r.is_deleted && r.content).length}`);

    if (real.accounts_by_email) {
        h('9. BẢNG TÀI KHOẢN (đã có)');
        const acc = (await client.execute('SELECT email, user_id, status, created_at FROM accounts_by_email', [], { ...opts, fetchSize: 1000 })).rows;
        const byStatus = {};
        acc.forEach(a => (byStatus[a.status || 'null'] = (byStatus[a.status || 'null'] || 0) + 1));
        line(`  accounts_by_email: ${acc.length} dòng ${JSON.stringify(byStatus)}`);
        acc.filter(a => a.status === 'PENDING').forEach(a => line(
            `   PENDING ${a.email} -> ${a.user_id} (${a.created_at?.toISOString()}) hồ sơ: ${userIds.has(a.user_id) ? 'CÓ (sẽ kích hoạt khi đăng nhập)' : 'CHƯA (có thể chiếm lại sau ngưỡng)'}`));
        acc.filter(a => a.status === 'ACTIVE' && !userIds.has(a.user_id)).forEach(a => warn(`ACTIVE ${a.email} trỏ tới user không tồn tại ${a.user_id}`));
        const owners = new Set(acc.map(a => a.user_id));
        [...userIds].filter(id => id.startsWith('u_') && !owners.has(id))
            .forEach(id => warn(`hồ sơ ${id} không có tài khoản trỏ tới (mồ côi do đăng ký lỗi?)`));
    }
    if (real.users_by_name_token) {
        h('10. TOKEN TÌM TÊN');
        const { nameTokens, tokenBucket } = require('../src/utils/text');
        let missing = 0;
        for (const u of users) {
            for (const token of nameTokens(u.display_name)) {
                const r = (await client.execute(
                    'SELECT user_id, display_name FROM users_by_name_token WHERE token_prefix = ? AND name_token = ? AND user_id = ?',
                    [tokenBucket(token), token, u.user_id], opts)).first();
                if (!r) { missing += 1; warn(`thiếu token "${token}" của ${u.user_id}`); }
                else if (r.display_name !== u.display_name) warn(`token "${token}" của ${u.user_id} còn tên cũ "${r.display_name}"`);
            }
        }
        line(`  Kiểm tra token của ${users.length} người dùng: thiếu ${missing}`);
    }
}

async function main() {
    await client.connect();
    const v = (await client.execute('SELECT release_version, cluster_name FROM system.local')).first();
    line(`Cassandra ${v.release_version} | cluster ${v.cluster_name} | keyspace ${KS} | chế độ: CHỈ ĐỌC`);
    const real = await schema();
    await data(real);
    h('TÓM TẮT');
    line(issues.length ? `  ${issues.length} vấn đề cần xem:` : '  Không phát hiện bất nhất.');
    issues.forEach(i => line('   - ' + i));
}

main()
    .catch(e => {
        console.error(`\n[LỖI] ${e.name}: ${String(e.message).split('\n')[0].slice(0, 300)}`);
        process.exitCode = 1;
    })
    .finally(() => client.shutdown().catch(() => {}));
