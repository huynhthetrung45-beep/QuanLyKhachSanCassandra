// NFR-14: chuyen keyspace sang cum 3 nut (NetworkTopologyStrategy, RF = 3).
// KHONG phai migration (migration khong duoc doi replication). Chay CHU DONG sau khi cum 3 nut da san sang:
//   docker compose -f docker-compose.cluster.yml up -d
//   npm run cluster:replication            -> in lenh se chay (dry-run)
//   npm run cluster:replication -- --apply -> ALTER KEYSPACE, sau do chay "nodetool repair" tren tung nut
// Ung dung dung muc nhat quan LOCAL_QUORUM khi dat CASSANDRA_CONSISTENCY=localQuorum trong backend/.env.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

async function main() {
    const keyspace = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
    const dc = process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1';
    const rf = Number(process.argv.find(a => /^--rf=\d$/.test(a))?.slice(5) || 3);
    const cql = `ALTER KEYSPACE ${keyspace} WITH replication = {'class': 'NetworkTopologyStrategy', '${dc}': ${rf}}`;
    if (!process.argv.includes('--apply')) {
        console.log('DRY RUN. Lệnh sẽ chạy:\n  ' + cql + '\nThêm --apply để thực hiện.');
        return;
    }
    const client = require('../src/config/cassandra');
    try {
        await client.connect();
        const hosts = client.hosts.values().filter(h => h.datacenter === dc);
        if (hosts.length < rf) throw new Error(`Datacenter ${dc} chỉ có ${hosts.length} nút, cần ít nhất ${rf}.`);
        await client.execute(cql);
        console.log(`Đã đặt RF=${rf} cho ${keyspace}. Hãy chạy "nodetool repair ${keyspace}" trên từng nút.`);
    } catch (error) {
        console.error('Lỗi:', error.message);
        process.exitCode = 1;
    } finally {
        await client.shutdown().catch(() => {});
    }
}

main();
