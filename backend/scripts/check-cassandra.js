// Kiem tra ket noi Cassandra CHI DOC (khong tao, khong sua, khong xoa gi).
// Chay tu thu muc goc du an:  node backend\scripts\check-cassandra.js
const client = require('../src/config/cassandra');

const KS = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
const FOCUS = '11111111-1111-1111-1111-111111111111';

async function main() {
    console.log(`Driver: cassandra-driver ${require('cassandra-driver/package.json').version}`);
    console.log(`Contact points: ${process.env.CASSANDRA_HOSTS} | DC: ${process.env.CASSANDRA_LOCAL_DATACENTER} | keyspace: ${KS}`);

    await client.connect();
    const host = client.getState().getConnectedHosts()[0];
    const ver = await client.execute('SELECT release_version, cluster_name, data_center FROM system.local');
    const v = ver.first();
    console.log(`\n[OK] Đã kết nối qua driver backend tới ${host ? host.address : '?'}`);
    console.log(`     Cassandra ${v.release_version} | cluster ${v.cluster_name} | DC ${v.data_center}`);

    const tables = await client.execute(
        'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?', [KS], { prepare: true });
    console.log(`\nBảng trong ${KS}: ${tables.rows.map(r => r.table_name).sort().join(', ')}`);

    const cols = await client.execute(
        `SELECT column_name, kind, clustering_order, position, type FROM system_schema.columns
         WHERE keyspace_name = ? AND table_name = 'messages_by_conversation'`, [KS], { prepare: true });
    const keys = cols.rows.filter(r => r.kind !== 'regular')
        .sort((a, b) => (a.kind > b.kind ? -1 : 1) || a.position - b.position)
        .map(r => `${r.column_name} (${r.kind}${r.clustering_order !== 'none' ? ' ' + r.clustering_order : ''})`);
    console.log(`Khóa messages_by_conversation: ${keys.join(', ')}`);

    const users = await client.execute('SELECT user_id, display_name FROM users', [], { fetchSize: 500 });
    console.log(`\nusers: ${users.rowLength} dòng -> ${users.rows.map(r => r.user_id).sort().join(', ')}`);

    const convs = await client.execute(
        'SELECT conversation_id, conversation_name, conversation_type FROM conversations', [], { fetchSize: 500 });
    console.log(`conversations: ${convs.rowLength} hội thoại`);

    let total = 0;
    for (const c of convs.rows) {
        const n = await client.execute(
            'SELECT COUNT(*) AS total FROM messages_by_conversation WHERE conversation_id = ?',
            [c.conversation_id], { prepare: true });
        const count = Number(n.first().total);
        total += count;
        console.log(`   ${c.conversation_id}  ${String(count).padStart(4)} tin  [${c.conversation_type}] ${c.conversation_name}`);
    }
    console.log(`   Tổng: ${total} tin nhắn`);

    const latest = await client.execute(
        `SELECT created_at, sender_name, content, is_deleted FROM messages_by_conversation
         WHERE conversation_id = ? LIMIT 3`, [FOCUS], { prepare: true });
    console.log(`\n3 tin mới nhất của hội thoại ${FOCUS}:`);
    latest.rows.forEach(r => console.log(`   ${r.created_at.toISOString()} | ${r.sender_name} | ${r.is_deleted ? '(đã thu hồi)' : r.content}`));

    const page = await client.execute(
        'SELECT message_id FROM messages_by_conversation WHERE conversation_id = ?',
        [FOCUS], { prepare: true, fetchSize: 20 });
    console.log(`\nThử paging: trang 1 có ${page.rowLength} dòng, pageState ${page.pageState ? 'có' : 'không có'}`);

    const cbu = await client.execute(
        'SELECT conversation_id FROM conversations_by_user WHERE user_id = ?', ['user01'], { prepare: true });
    console.log(`conversations_by_user của user01: ${cbu.rowLength} dòng`);
}

main()
    .catch(e => {
        console.error(`\n[LỖI] ${e.name}: ${String(e.message).split('\n')[0].slice(0, 300)}`);
        if (e.innerErrors) {
            for (const [h, ie] of Object.entries(e.innerErrors)) {
                console.error(`   ${h} -> ${ie.code || ie.name || ''} ${String(ie.message).split('\n')[0].slice(0, 200)}`);
            }
        }
        process.exitCode = 1;
    })
    .finally(() => client.shutdown().catch(() => {}));
