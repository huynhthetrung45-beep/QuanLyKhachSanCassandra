
const client = require('./src/config/cassandra');

async function testConnection() {
    try {
        await client.connect();

        console.log('Ket noi Cassandra thanh cong!');

        const result = await client.execute(
            'SELECT keyspace_name FROM system_schema.keyspaces'
        );

        console.log('Danh sach keyspace:');

        result.rows.forEach(row => {
            console.log('-', row.keyspace_name);
        });
    } catch (error) {
        console.error('Ket noi that bai:', error.message);
    } finally {
        await client.shutdown();
    }
}

testConnection();
