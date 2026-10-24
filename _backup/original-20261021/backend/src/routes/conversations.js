
const express = require('express');
const router = express.Router();

const client = require('../config/cassandra');
const cassandra = require('cassandra-driver');

// API 1: Danh sach cuoc tro chuyen cua nguoi dung
router.get('/users/:userId/conversations', async (req, res) => {
    const { userId } = req.params;

    try {
        const query = `
            SELECT
                user_id,
                last_message_at,
                conversation_id,
                conversation_name,
                conversation_type,
                last_message_preview,
                last_sender_name
            FROM conversations_by_user
            WHERE user_id = ?
        `;

        const result = await client.execute(
            query,
            [userId],
            { prepare: true }
        );

        res.json({
            userId,
            data: result.rows.map(row => ({
                conversationId: row.conversation_id.toString(),
                conversationName: row.conversation_name,
                conversationType: row.conversation_type,
                lastMessagePreview: row.last_message_preview,
                lastSenderName: row.last_sender_name,
                lastMessageAt: row.last_message_at
                    ? row.last_message_at.toISOString()
                    : null
            }))
        });
    } catch (error) {
        console.error(
            'Loi lay danh sach hoi thoai:',
            error.message
        );

        res.status(500).json({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Khong the lay danh sach hoi thoai'
            }
        });
    }
});

// API 2: Thong tin chi tiet cuoc tro chuyen
router.get('/conversations/:conversationId', async (req, res) => {
    const { conversationId } = req.params;

    try {
        const query = `
            SELECT
                conversation_id,
                conversation_name,
                conversation_type,
                participant_ids,
                created_at,
                last_message_at
            FROM conversations
            WHERE conversation_id = ?
        `;

        const result = await client.execute(
            query,
            [conversationId],
            { prepare: true }
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                error: {
                    code: 'CONVERSATION_NOT_FOUND',
                    message: 'Khong tim thay cuoc tro chuyen'
                }
            });
        }

        const row = result.rows[0];

        res.json({
            conversationId: row.conversation_id.toString(),
            conversationName: row.conversation_name,
            conversationType: row.conversation_type,
            participantIds: Array.from(row.participant_ids || []),
            createdAt: row.created_at
                ? row.created_at.toISOString()
                : null,
            lastMessageAt: row.last_message_at
                ? row.last_message_at.toISOString()
                : null
        });
    } catch (error) {
        console.error(
            'Loi lay thong tin hoi thoai:',
            error.message
        );

        res.status(500).json({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Khong the lay thong tin cuoc tro chuyen'
            }
        });
    }
});

// API 3: Lich su tin nhan co phan trang Cassandra
router.get(
    '/conversations/:conversationId/messages',
    async (req, res) => {
        const { conversationId } = req.params;
        const { userId, pageToken } = req.query;

        const limit = req.query.limit === undefined
            ? 20
            : Number(req.query.limit);

        if (!userId) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_USER_ID',
                    message: 'Tham so userId la bat buoc'
                }
            });
        }

        if (
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 50
        ) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_LIMIT',
                    message: 'limit phai la so nguyen tu 1 den 50'
                }
            });
        }

        try {
            // Kiem tra cuoc tro chuyen
            const conversationResult = await client.execute(
                `SELECT participant_ids
                 FROM conversations
                 WHERE conversation_id = ?`,
                [conversationId],
                { prepare: true }
            );

            if (conversationResult.rows.length === 0) {
                return res.status(404).json({
                    error: {
                        code: 'CONVERSATION_NOT_FOUND',
                        message: 'Khong tim thay cuoc tro chuyen'
                    }
                });
            }

            // Kiem tra nguoi dung co thuoc cuoc tro chuyen
            const participants =
                conversationResult.rows[0].participant_ids;

            const participantList = participants
                ? Array.from(participants)
                : [];

            if (!participantList.includes(userId)) {
                return res.status(403).json({
                    error: {
                        code: 'NOT_A_PARTICIPANT',
                        message:
                            'Nguoi dung khong thuoc cuoc tro chuyen nay'
                    }
                });
            }

            // Giai ma token phan trang neu co
            let pageState;

            if (pageToken) {
                let tokenData;

                try {
                    tokenData = JSON.parse(
                        Buffer.from(
                            pageToken,
                            'base64url'
                        ).toString('utf8')
                    );
                } catch (error) {
                    return res.status(400).json({
                        error: {
                            code: 'INVALID_PAGE_TOKEN',
                            message: 'pageToken khong hop le'
                        }
                    });
                }

                if (
                    !tokenData ||
                    tokenData.cid !== conversationId ||
                    typeof tokenData.ps !== 'string' ||
                    tokenData.ps.length === 0
                ) {
                    return res.status(400).json({
                        error: {
                            code: 'INVALID_PAGE_TOKEN',
                            message:
                                'pageToken khong hop le voi cuoc tro chuyen'
                        }
                    });
                }

                pageState = tokenData.ps;
            }

            // Truy van tin nhan theo partition key
            const query = `
                SELECT
                    conversation_id,
                    created_at,
                    message_id,
                    sender_id,
                    sender_name,
                    content,
                    message_type,
                    is_deleted
                FROM messages_by_conversation
                WHERE conversation_id = ?
            `;

            const startTime = process.hrtime.bigint();

            const result = await client.execute(
                query,
                [conversationId],
                {
                    prepare: true,
                    fetchSize: limit,
                    pageState
                }
            );

            const queryTimeMs = Number(
                process.hrtime.bigint() - startTime
            ) / 1e6;

            // Chuyen du lieu Cassandra thanh JSON
            const items = result.rows.map(row => ({
                messageId: row.message_id.toString(),
                createdAt: row.created_at.toISOString(),
                senderId: row.sender_id,
                senderName: row.sender_name,
                content: row.is_deleted ? null : row.content,
                messageType: row.message_type,
                isDeleted: row.is_deleted
            }));

            // Tao token cho trang tiep theo
            let nextPageToken = null;

            if (result.pageState) {
                nextPageToken = Buffer.from(
                    JSON.stringify({
                        cid: conversationId,
                        ps: result.pageState
                    })
                ).toString('base64url');
            }

            res.json({
                conversationId,
                items,
                count: items.length,
                hasMore: nextPageToken !== null,
                nextPageToken,
                queryTimeMs: Number(queryTimeMs.toFixed(2))
            });
        } catch (error) {
            console.error(
                'Loi doc lich su tin nhan:',
                error.message
            );

            res.status(500).json({
                error: {
                    code: 'INTERNAL_SERVER_ERROR',
                    message: 'Khong the doc lich su tin nhan'
                }
            });
        }
    }
);

module.exports = router;


/* API 4: Gui tin nhan moi */
router.post('/conversations/:conversationId/messages', async (req, res) => {
    const { conversationId } = req.params;
    const { userId, content, messageType = 'TEXT' } = req.body;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({
            error: { code: 'MISSING_USER_ID', message: 'userId la bat buoc' }
        });
    }

    if (typeof content !== 'string' || !content.trim() || content.length > 2000) {
        return res.status(400).json({
            error: { code: 'INVALID_CONTENT', message: 'Noi dung phai tu 1 den 2000 ky tu' }
        });
    }

    if (!['TEXT'].includes(messageType)) {
        return res.status(400).json({
            error: { code: 'INVALID_MESSAGE_TYPE', message: 'messageType khong hop le' }
        });
    }

    try {
        const conversationResult = await client.execute(
            'SELECT conversation_name, conversation_type, participant_ids FROM conversations WHERE conversation_id = ?',
            [conversationId],
            { prepare: true }
        );

        if (conversationResult.rowLength === 0) {
            return res.status(404).json({
                error: { code: 'CONVERSATION_NOT_FOUND', message: 'Khong tim thay cuoc tro chuyen' }
            });
        }

        const conversation = conversationResult.first();
        const members = Array.from(conversation.participant_ids || []);

        if (!members.includes(userId)) {
            return res.status(403).json({
                error: { code: 'NOT_A_PARTICIPANT', message: 'Nguoi dung khong thuoc cuoc tro chuyen nay' }
            });
        }

        const userResult = await client.execute(
            'SELECT display_name FROM users WHERE user_id = ?',
            [userId],
            { prepare: true }
        );

        if (userResult.rowLength === 0) {
            return res.status(404).json({
                error: { code: 'USER_NOT_FOUND', message: 'Khong tim thay nguoi dung' }
            });
        }

        const now = new Date();
        const messageId = cassandra.types.TimeUuid.now();
        const senderName = userResult.first().display_name;
        const cleanContent = content.trim();

        await client.execute(
            `INSERT INTO messages_by_conversation
             (conversation_id, created_at, message_id, sender_id, sender_name,
              content, message_type, is_deleted, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                cassandra.types.Uuid.fromString(conversationId),
                now,
                messageId,
                userId,
                senderName,
                cleanContent,
                messageType,
                false,
                null
            ],
            { prepare: true }
        );

        await client.execute(
            'UPDATE conversations SET last_message_at = ? WHERE conversation_id = ?',
            [now, cassandra.types.Uuid.fromString(conversationId)],
            { prepare: true }
        );

        const preview = cleanContent.length > 100
            ? cleanContent.slice(0, 100)
            : cleanContent;

        
        for (const memberId of members) {
            const oldRows = await client.execute(
                `SELECT last_message_at, conversation_id
                FROM conversations_by_user
                WHERE user_id = ?`,
                [memberId],
                { prepare: true }
            );

            for (const row of oldRows.rows) {
                if (row.conversation_id.toString() === conversationId) {
                    await client.execute(
                        `DELETE FROM conversations_by_user
                        WHERE user_id = ?
                        AND last_message_at = ?
                        AND conversation_id = ?`,
                        [
                            memberId,
                            row.last_message_at,
                            cassandra.types.Uuid.fromString(conversationId)
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
                    now,
                    cassandra.types.Uuid.fromString(conversationId),
                    conversation.conversation_name,
                    conversation.conversation_type,
                    preview,
                    senderName
                ],
                { prepare: true }
            );
        }


        return res.status(201).json({
            conversationId,
            message: {
                messageId: messageId.toString(),
                createdAt: now.toISOString(),
                senderId: userId,
                senderName,
                content: cleanContent,
                messageType,
                isDeleted: false
            }
        });
    } catch (error) {
        console.error('Loi gui tin nhan:', error);
        return res.status(500).json({
            error: { code: 'INTERNAL_SERVER_ERROR', message: 'Khong the gui tin nhan' }
        });
    }
});



/* API 5: Xoa mem tin nhan cua chinh minh */
router.delete(
    '/conversations/:conversationId/messages/:messageId',
    async (req, res) => {
        const { conversationId, messageId } = req.params;
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({
                error: {
                    code: 'MISSING_USER_ID',
                    message: 'userId la bat buoc'
                }
            });
        }

        try {
            const parsedConversationId =
                cassandra.types.Uuid.fromString(conversationId);

            const parsedMessageId =
                cassandra.types.TimeUuid.fromString(messageId);

            // 1. Kiem tra cuoc tro chuyen
            const conversationResult = await client.execute(
                `SELECT participant_ids
                 FROM conversations
                 WHERE conversation_id = ?`,
                [parsedConversationId],
                { prepare: true }
            );

            if (conversationResult.rowLength === 0) {
                return res.status(404).json({
                    error: {
                        code: 'CONVERSATION_NOT_FOUND',
                        message: 'Khong tim thay cuoc tro chuyen'
                    }
                });
            }

            const members = Array.from(
                conversationResult.first().participant_ids || []
            );

            if (!members.includes(userId)) {
                return res.status(403).json({
                    error: {
                        code: 'NOT_A_PARTICIPANT',
                        message: 'Nguoi dung khong thuoc cuoc tro chuyen nay'
                    }
                });
            }

            // 2. Tim tin nhan trong dung partition
            const messageResult = await client.execute(
                `SELECT created_at, message_id, sender_id, is_deleted
                 FROM messages_by_conversation
                 WHERE conversation_id = ?`,
                [parsedConversationId],
                { prepare: true, fetchSize: 5000 }
            );

            const message = messageResult.rows.find(
                row => row.message_id.toString() === parsedMessageId.toString()
            );

            if (!message) {
                return res.status(404).json({
                    error: {
                        code: 'MESSAGE_NOT_FOUND',
                        message: 'Khong tim thay tin nhan'
                    }
                });
            }

            // 3. Chi nguoi gui moi duoc xoa
            if (message.sender_id !== userId) {
                return res.status(403).json({
                    error: {
                        code: 'CANNOT_DELETE_MESSAGE',
                        message: 'Chi nguoi gui moi duoc xoa tin nhan'
                    }
                });
            }

            if (message.is_deleted) {
                return res.json({
                    messageId,
                    isDeleted: true,
                    message: 'Tin nhan da duoc xoa truoc do'
                });
            }

            // 4. Xoa mem, khong xoa ban ghi
            const deletedAt = new Date();

            await client.execute(
                `UPDATE messages_by_conversation
                 SET content = ?, is_deleted = ?, deleted_at = ?
                 WHERE conversation_id = ?
                   AND created_at = ?
                   AND message_id = ?`,
                [
                    null,
                    true,
                    deletedAt,
                    parsedConversationId,
                    message.created_at,
                    message.message_id
                ],
                { prepare: true }
            );
            await syncConversationPreview(conversationId, members);
            return res.json({
                messageId,
                isDeleted: true,
                deletedAt: deletedAt.toISOString()
            });

        } catch (error) {
            console.error('Loi xoa mem tin nhan:', error);

            if (
                error instanceof TypeError ||
                error.name === 'ArgumentError'
            ) {
                return res.status(400).json({
                    error: {
                        code: 'INVALID_ID',
                        message: 'conversationId hoac messageId khong hop le'
                    }
                });
            }

            return res.status(500).json({
                error: {
                    code: 'DELETE_FAILED',
                    message: 'Khong the xoa mem tin nhan'
                }
            });
        }
    }
);




async function syncConversationPreview(conversationId, members) {
    const conversationUuid =
        cassandra.types.Uuid.fromString(conversationId);

    // Lay thong tin hien tai cua cuoc tro chuyen
    const conversationResult = await client.execute(
        `SELECT conversation_name, conversation_type
         FROM conversations
         WHERE conversation_id = ?`,
        [conversationUuid],
        { prepare: true }
    );

    if (conversationResult.rowLength === 0) {
        throw new Error('Khong tim thay cuoc tro chuyen');
    }

    const conversation = conversationResult.first();

    // Tim tin nhan moi nhat chua bi xoa
    let latest = null;
    let pageState = null;

    do {
        const options = {
            prepare: true,
            fetchSize: 100
        };

        if (pageState) {
            options.pageState = pageState;
        }

        const result = await client.execute(
            `SELECT created_at, message_id, sender_name,
                    content, is_deleted
             FROM messages_by_conversation
             WHERE conversation_id = ?`,
            [conversationUuid],
            options
        );

        latest = result.rows.find(row => !row.is_deleted) || null;

        if (latest) {
            break;
        }

        pageState = result.pageState;
    } while (pageState);

    const lastMessageAt = latest ? latest.created_at : null;
    const preview = latest ? (latest.content || '') : '';
    const senderName = latest ? (latest.sender_name || '') : '';

    // Cap nhat thoi gian tin nhan cuoi
    await client.execute(
        `UPDATE conversations
         SET last_message_at = ?
         WHERE conversation_id = ?`,
        [lastMessageAt, conversationUuid],
        { prepare: true }
    );

    // Dong bo chi muc hoi thoai cua tung thanh vien
    for (const memberId of members) {
        const oldRows = await client.execute(
            `SELECT last_message_at, conversation_id
             FROM conversations_by_user
             WHERE user_id = ?`,
            [memberId],
            { prepare: true }
        );

        for (const row of oldRows.rows) {
            if (
                row.conversation_id.toString() ===
                conversationUuid.toString()
            ) {
                await client.execute(
                    `DELETE FROM conversations_by_user
                     WHERE user_id = ?
                       AND last_message_at = ?
                       AND conversation_id = ?`,
                    [
                        memberId,
                        row.last_message_at,
                        conversationUuid
                    ],
                    { prepare: true }
                );
            }
        }

        if (lastMessageAt) {
            await client.execute(
                `INSERT INTO conversations_by_user
                 (user_id, last_message_at, conversation_id,
                  conversation_name, conversation_type,
                  last_message_preview, last_sender_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    memberId,
                    lastMessageAt,
                    conversationUuid,
                    conversation.conversation_name,
                    conversation.conversation_type,
                    preview,
                    senderName
                ],
                { prepare: true }
            );
        }
    }
}
