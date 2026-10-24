
const path = require('path');

require('dotenv').config({
    path: path.resolve(__dirname, '.env')
});

const cassandra = require('cassandra-driver');

const client = new cassandra.Client({
    contactPoints: process.env.CASSANDRA_HOSTS.split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER,
    keyspace: process.env.CASSANDRA_KEYSPACE
});

const CONVERSATION_ID =
    '11111111-1111-1111-1111-111111111111';

const USERS = [
    { id: 'user01', name: 'Nguyễn An' },
    { id: 'user02', name: 'Trần Bình' },
    { id: 'user03', name: 'Lê Chi' },
    { id: 'user04', name: 'Phạm Dũng' },
    { id: 'user05', name: 'Hoàng Giang' }
];

async function main() {
    try {
        await client.connect();

        // Tránh chèn trùng nếu chạy lại script.
        const countResult = await client.execute(
            `SELECT COUNT(*) AS total
             FROM messages_by_conversation
             WHERE conversation_id = ?`,
            [cassandra.types.Uuid.fromString(CONVERSATION_ID)],
            { prepare: true }
        );

        const total = Number(countResult.rows[0].total);

        if (total > 0) {
            console.log(
                `Đã có ${total} tin nhắn. Không chèn thêm để tránh trùng dữ liệu.`
            );
            return;
        }

        const insertQuery = `
            INSERT INTO messages_by_conversation (
                conversation_id,
                created_at,
                message_id,
                sender_id,
                sender_name,
                content,
                message_type,
                is_deleted,
                deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        // Tạo 25 tin nhắn với thời gian cách nhau 1 phút.
        // Tin nhắn gần nhất sẽ xuất hiện trước do thứ tự DESC.
        const baseTime = Date.now() - 25 * 60 * 1000;

        for (let i = 0; i < 25; i++) {
            const user = USERS[i % USERS.length];
            const createdAt = new Date(baseTime + i * 60 * 1000);
            const messageId = cassandra.types.TimeUuid.now();

            await client.execute(
                insertQuery,
                [
                    cassandra.types.Uuid.fromString(CONVERSATION_ID),
                    createdAt,
                    messageId,
                    user.id,
                    user.name,
                    `Tin nhắn thử nghiệm số ${i + 1}`,
                    'TEXT',
                    false,
                    null
                ],
                { prepare: true }
            );
        }

        console.log('Đã thêm thành công 25 tin nhắn thử nghiệm.');
    } catch (error) {
        console.error('Lỗi nạp dữ liệu:', error.message);
        process.exitCode = 1;
    } finally {
        await client.shutdown();
    }
}

main();
