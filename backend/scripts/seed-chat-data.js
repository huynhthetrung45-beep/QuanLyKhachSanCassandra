
const path = require('path');

require('dotenv').config({
    path: path.resolve(__dirname, '../.env')
});

const cassandra = require('cassandra-driver');

const client = new cassandra.Client({
    contactPoints: (process.env.CASSANDRA_HOSTS || '127.0.0.1').split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1',
    keyspace: process.env.CASSANDRA_KEYSPACE || 'chat_ott'
});

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const DAY_MS = 24 * 60 * 60 * 1000;
const TOTAL_TARGET = 470;

const users = [
    { id: 'user01', name: 'Nguyễn An' },
    { id: 'user02', name: 'Trần Bình' },
    { id: 'user03', name: 'Lê Chi' },
    { id: 'user04', name: 'Phạm Dũng' },
    { id: 'user05', name: 'Hoàng Giang' },
    { id: 'user06', name: 'Vũ Huy' },
    { id: 'user07', name: 'Đặng Linh' },
    { id: 'user08', name: 'Bùi Minh' }
];

const conversations = [
    {
        id: GROUP_ID,
        name: 'Nhóm Đồ án NoSQL',
        type: 'GROUP',
        members: ['user01', 'user02', 'user03', 'user04', 'user05'],
        target: 200
    },
    {
        id: '22222222-2222-2222-2222-222222222222',
        name: 'Nhóm Backend',
        type: 'GROUP',
        members: ['user01', 'user02', 'user03', 'user06'],
        target: 30
    },
    {
        id: '33333333-3333-3333-3333-333333333333',
        name: 'Nhóm Frontend',
        type: 'GROUP',
        members: ['user02', 'user04', 'user05', 'user07', 'user08'],
        target: 30
    },
    {
        id: '44444444-4444-4444-4444-444444444444',
        name: 'Nguyễn An - Trần Bình',
        type: 'DIRECT',
        members: ['user01', 'user02'],
        target: 30
    },
    {
        id: '55555555-5555-5555-5555-555555555555',
        name: 'Nguyễn An - Lê Chi',
        type: 'DIRECT',
        members: ['user01', 'user03'],
        target: 30
    },
    {
        id: '66666666-6666-6666-6666-666666666666',
        name: 'Phạm Dũng - Hoàng Giang',
        type: 'DIRECT',
        members: ['user04', 'user05'],
        target: 30
    },
    {
        id: '77777777-7777-7777-7777-777777777777',
        name: 'Vũ Huy - Đặng Linh',
        type: 'DIRECT',
        members: ['user06', 'user07'],
        target: 30
    },
    {
        id: '88888888-8888-8888-8888-888888888888',
        name: 'Bùi Minh - Nguyễn An',
        type: 'DIRECT',
        members: ['user08', 'user01'],
        target: 30
    },
    {
        id: '99999999-9999-9999-9999-999999999999',
        name: 'Trần Bình - Phạm Dũng',
        type: 'DIRECT',
        members: ['user02', 'user04'],
        target: 30
    },
    {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'Lê Chi - Vũ Huy',
        type: 'DIRECT',
        members: ['user03', 'user06'],
        target: 30
    }
];

const messageTemplates = [
    'Mọi người cập nhật tiến độ giúp mình nhé.',
    'Mình đã hoàn thành phần được giao.',
    'Chúng ta kiểm tra lại dữ liệu trước khi nộp nhé.',
    'Mình vừa sửa xong lỗi kết nối cơ sở dữ liệu.',
    'Mọi người xem lại yêu cầu trong tài liệu SRS nhé.',
    'Phần này cần kiểm tra thêm một chút.',
    'Mình sẽ gửi kết quả sau khi chạy thử.',
    'Cảm ơn mọi người, mình đã nhận được thông tin.',
    'Chúng ta thống nhất cách triển khai này nhé.',
    'Mình đang kiểm tra lại API.',
    'Phần giao diện đã có bản cập nhật mới.',
    'Mình đã kiểm tra truy vấn Cassandra.',
    'Mọi người nhớ kiểm tra dữ liệu mẫu nhé.',
    'Mình sẽ cập nhật tài liệu trong hôm nay.',
    'Kết quả chạy thử đã ổn hơn rồi.',
    'Mình đề xuất kiểm tra thêm trường hợp dữ liệu trống.',
    'Chúng ta cần bảo đảm phân trang hoạt động đúng.',
    'Mình đã ghi lại các lỗi cần xử lý.',
    'Mọi người xem giúp mình phần này với.',
    'Tiến độ hiện tại vẫn theo đúng kế hoạch.'
];

function toUuid(value) {
    return cassandra.types.Uuid.fromString(value);
}

async function countMessages(conversationId) {
    const result = await client.execute(
        'SELECT COUNT(*) AS total FROM messages_by_conversation WHERE conversation_id = ?',
        [toUuid(conversationId)],
        { prepare: true }
    );

    return Number(result.first().total);
}

async function assertUsersExist() {
    const result = await client.execute('SELECT user_id FROM users');
    const existingIds = new Set(result.rows.map(row => row.user_id));
    const missing = users.filter(user => !existingIds.has(user.id));

    if (missing.length > 0) {
        throw new Error(
            'Thiếu người dùng: ' +
            missing.map(user => user.id).join(', ') +
            '. Script không tự tạo hoặc sửa bảng users.'
        );
    }
}

async function ensureConversation(conversation) {
    const id = toUuid(conversation.id);

    const existing = await client.execute(
        'SELECT conversation_id FROM conversations WHERE conversation_id = ?',
        [id],
        { prepare: true }
    );

    if (existing.rowLength === 0) {
        const now = new Date();

        await client.execute(
            `INSERT INTO conversations
             (conversation_id, conversation_name, conversation_type,
              created_at, last_message_at, participant_ids)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                id,
                conversation.name,
                conversation.type,
                new Date(now.getTime() - 30 * DAY_MS),
                now,
                conversation.members
            ],
            { prepare: true }
        );
    } else if (conversation.id !== GROUP_ID) {
        await client.execute(
            `UPDATE conversations
             SET conversation_name = ?,
                 conversation_type = ?,
                 participant_ids = ?
             WHERE conversation_id = ?`,
            [
                conversation.name,
                conversation.type,
                conversation.members,
                id
            ],
            { prepare: true }
        );
    }
}

function messageTime(slot, target, baseNow) {
    const start = baseNow - 30 * DAY_MS;
    const end = baseNow - 5 * 60 * 1000;
    const span = Math.max(1, target - 1);

    let time = new Date(
        start + ((end - start) * slot / span)
    );

    // Tạo các cặp timestamp trùng nhau để kiểm tra message_id.
    if (slot === 30 || slot === 31) {
        time = new Date(Date.UTC(2026, 9, 10, 10, 0, 0));
    } else if (slot === 40 || slot === 41) {
        time = new Date(Date.UTC(2026, 9, 12, 12, 0, 0));
    }

    return time;
}

async function insertMessage(conversation, slot, baseNow) {
    const senderId =
        conversation.members[slot % conversation.members.length];

    const sender = users.find(user => user.id === senderId);

    if (!sender) {
        throw new Error('Không tìm thấy tên người gửi: ' + senderId);
    }

    const createdAt = messageTime(
        slot,
        conversation.target,
        baseNow
    );

    const deleted = slot % 20 === 0;
    const content =
        messageTemplates[slot % messageTemplates.length];

    await client.execute(
        `INSERT INTO messages_by_conversation
         (conversation_id, created_at, message_id, sender_id,
          sender_name, content, message_type, is_deleted, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            toUuid(conversation.id),
            createdAt,
            cassandra.types.TimeUuid.now(),
            senderId,
            sender.name,
            deleted ? null : content,
            'TEXT',
            deleted,
            deleted ? new Date() : null
        ],
        { prepare: true }
    );
}

async function refreshConversationIndex(conversation) {
    const id = toUuid(conversation.id);

    const result = await client.execute(
        `SELECT created_at, sender_id, sender_name, content, is_deleted
         FROM messages_by_conversation
         WHERE conversation_id = ?`,
        [id],
        { prepare: true }
    );

    if (result.rowLength === 0) {
        console.warn(
            'Không có tin nhắn để cập nhật preview: ' +
            conversation.name
        );
        return;
    }

    const latest = result.rows.reduce((current, row) => {
        return row.created_at.getTime() > current.created_at.getTime()
            ? row
            : current;
    });

    await client.execute(
        `UPDATE conversations
         SET last_message_at = ?
         WHERE conversation_id = ?`,
        [latest.created_at, id],
        { prepare: true }
    );

    for (const memberId of conversation.members) {
        const rows = await client.execute(
            `SELECT last_message_at, conversation_id
             FROM conversations_by_user
             WHERE user_id = ?`,
            [memberId],
            { prepare: true }
        );

        for (const row of rows.rows) {
            if (row.conversation_id.toString() === conversation.id) {
                await client.execute(
                    `DELETE FROM conversations_by_user
                     WHERE user_id = ?
                       AND last_message_at = ?
                       AND conversation_id = ?`,
                    [
                        memberId,
                        row.last_message_at,
                        id
                    ],
                    { prepare: true }
                );
            }
        }

        await client.execute(
            `INSERT INTO conversations_by_user
             (user_id, last_message_at, conversation_id,
              conversation_name, conversation_type,
              last_message_preview, last_sender_name)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                memberId,
                latest.created_at,
                id,
                conversation.name,
                conversation.type,
                latest.is_deleted
                    ? 'Tin nhắn đã bị thu hồi'
                    : latest.content,
                latest.sender_name
            ],
            { prepare: true }
        );
    }
}

async function main() {
    await client.connect();
    console.log('Đã kết nối Cassandra.');

    await assertUsersExist();

    const initialCounts = {};

    for (const conversation of conversations) {
        initialCounts[conversation.id] =
            await countMessages(conversation.id);

        if (initialCounts[conversation.id] > conversation.target) {
            throw new Error(
                `Cuộc trò chuyện "${conversation.name}" đã có ` +
                `${initialCounts[conversation.id]} tin nhắn, vượt mục tiêu ` +
                `${conversation.target}. Script dừng để không tự ý xóa dữ liệu.`
            );
        }
    }

    const initialTotal = Object.values(initialCounts)
        .reduce((sum, count) => sum + count, 0);

    const expectedFinalTotal = conversations
        .reduce((sum, conversation) => sum + conversation.target, 0);

    if (expectedFinalTotal !== TOTAL_TARGET) {
        throw new Error(
            `Cấu hình mục tiêu sai: tổng dự kiến ${expectedFinalTotal}.`
        );
    }

    console.log(`Số tin nhắn trước khi seed: ${initialTotal}.`);
    console.log(`Tổng mục tiêu sau seed: ${TOTAL_TARGET}.`);

    const baseNow = Date.now();

    for (const conversation of conversations) {
        await ensureConversation(conversation);

        const current = await countMessages(conversation.id);
        const missing = conversation.target - current;

        console.log(
            `${conversation.name}: hiện có ${current}, bổ sung ${missing}.`
        );

        for (let i = 0; i < missing; i++) {
            await insertMessage(
                conversation,
                current + i,
                baseNow
            );
        }

        await refreshConversationIndex(conversation);
    }

    let finalTotal = 0;

    for (const conversation of conversations) {
        const count = await countMessages(conversation.id);
        finalTotal += count;

        console.log(
            `${conversation.name}: ${count}/${conversation.target} tin nhắn`
        );

        if (count !== conversation.target) {
            throw new Error(
                `Số tin nhắn không đúng mục tiêu tại "${conversation.name}".`
            );
        }
    }

    console.log(`Số cuộc trò chuyện được kiểm tra: ${conversations.length}`);
    console.log(`Tổng số tin nhắn: ${finalTotal}`);

    if (finalTotal !== TOTAL_TARGET) {
        throw new Error(
            `Tổng tin nhắn ${finalTotal}, khác mục tiêu ${TOTAL_TARGET}.`
        );
    }

    console.log(
        'Seed dữ liệu hoàn tất. Không xóa tin nhắn hoặc người dùng cũ.'
    );
}

main()
    .catch(error => {
        console.error('Lỗi seed dữ liệu:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await client.shutdown();
        } catch (error) {
            console.error(
                'Lỗi đóng kết nối Cassandra:',
                error.message
            );
        }
    });
