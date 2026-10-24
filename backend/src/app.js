
require('dotenv').config({
    path: require('path').resolve(__dirname, '../.env')
});

const express = require('express');
const cors = require('cors');
const db = require('./db');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const conversationsRouter = require('./routes/conversations');
const eventsRouter = require('./routes/events');
const socialRouter = require('./routes/social');
const postsRouter = require('./routes/posts');
const notificationsRouter = require('./routes/notifications');
const insightsRouter = require('./routes/insights');
const { requireAuth, rejectSpoofedIdentity } = require('./middleware/auth');
const { allowedOrigins, originGuard } = require('./middleware/security');
const { requestLogger } = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errors');
// Chuc nang moi (PT-01..PT-26, NFR-13/16/18): xem backend/src/extensions/index.js
const extensions = require('./extensions');

const REQUIRED_TABLES = [
    'users',
    'conversations',
    'conversations_by_user',
    'messages_by_conversation',
    'accounts_by_email',
    'sessions',
    'direct_conversations',
    'conversation_state_by_user',
    'users_by_name_token',
    // migration 002
    'reactions_by_message',
    'attachments_by_conversation',
    'hidden_messages_by_user',
    // migration 003
    'user_profiles',
    'usernames',
    'relationships',
    'friend_requests_by_receiver',
    'friend_requests_by_sender',
    'friends_by_user',
    'blocked_users_by_user',
    // migration 004
    'posts',
    'posts_by_author',
    'post_media',
    'post_reactions',
    'post_comments',
    // migration 005
    'public_posts_by_month',
    'post_shares',
    // migration 006
    'notifications_by_user',
    'notification_keys',
    'message_terms_by_conversation',
    'ai_summaries_by_conversation',
    'ai_tasks_by_conversation',
    'conversation_daily_stats',
    'conversation_hourly_stats',
    'conversation_type_stats',
    'conversation_sender_stats',
    'user_social_stats',
    // migration 007
    'root_comments_by_post',
    'comment_replies_by_root',
    'comment_client_ids',
    'pinned_messages_by_conversation'
];
// migration 009-012 (chuc nang moi)
REQUIRED_TABLES.push(...extensions.REQUIRED_TABLES);

// Cot moi tren bang cu ma backend truy van (migration 001, 002).
const REQUIRED_COLUMNS = {
    users: ['email'],
    conversations: ['created_by'],
    conversations_by_user: ['last_sender_id'],
    messages_by_conversation: ['reply_to_id', 'reply_to_created_at', 'attachment_ids', 'forwarded', 'shared_post_id'],
    post_comments: ['reply_to_comment_id', 'root_comment_id']
};

// Tra ve danh sach bang / cot con thieu (chi doc system_schema).
async function checkSchema() {
    const keyspace = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
    const result = await db.execute(
        'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
        [keyspace]
    );
    const existing = new Set(result.rows.map(row => row.table_name));
    const missing = REQUIRED_TABLES.filter(table => !existing.has(table));
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
        if (!existing.has(table)) continue;
        const cols = await db.execute(
            'SELECT column_name FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?',
            [keyspace, table]
        );
        const have = new Set(cols.rows.map(row => row.column_name));
        columns.filter(c => !have.has(c)).forEach(c => missing.push(`${table}.${c}`));
    }
    return missing;
}

function createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');

    app.use(cors({ origin: allowedOrigins(), credentials: true }));
    app.use(express.json({ limit: '32kb' }));
    app.use(requestLogger);
    extensions.mountEarly(app);

    // Kiem tra ket noi Cassandra (khong can dang nhap)
    const health = async (req, res) => {
        try {
            const missingTables = await checkSchema();
            res.json({
                status: missingTables.length === 0 ? 'OK' : 'NEEDS_MIGRATION',
                message: missingTables.length === 0
                    ? 'Backend và Cassandra hoạt động bình thường'
                    : 'Thiếu bảng, hãy chạy: npm run migrate',
                keyspace: process.env.CASSANDRA_KEYSPACE || 'chat_ott',
                missingTables
            });
        } catch (error) {
            console.error('Lỗi kiểm tra Cassandra:', error.message);
            res.status(503).json({
                status: 'ERROR',
                error: { code: 'DB_UNAVAILABLE', message: 'Không thể truy vấn Cassandra' }
            });
        }
    };
    app.get('/api/health', health);
    app.get('/api/v1/health', health);
    extensions.mountUploads(app);

    app.use('/api', originGuard);
    extensions.mountPublic(app);

    // Cong khai: dang ky, dang nhap, dang xuat
    app.use('/api/v1/auth', authRouter);

    // Tu day tro xuong: bat buoc dang nhap, danh tinh lay tu phien
    app.use('/api/v1', requireAuth, rejectSpoofedIdentity);
    extensions.mountAuthed(app);
    app.use('/api/v1', eventsRouter);
    app.use('/api/v1', usersRouter);
    app.use('/api/v1', conversationsRouter);
    app.use('/api/v1', socialRouter);
    app.use('/api/v1', postsRouter);
    app.use('/api/v1', notificationsRouter);
    app.use('/api/v1', insightsRouter);

    app.use('/api', notFound);
    app.use(errorHandler);
    return app;
}

async function startServer() {
    const PORT = process.env.PORT || 3000;
    const client = db.getClient();
    try {
        await client.connect();
        const missing = await checkSchema();
        if (missing.length > 0) {
            // Khong chay nua voi: thieu bang/cot thi API se loi le te. Khong tu dong migrate.
            console.error(`Schema chưa đủ, thiếu: ${missing.join(', ')}.`);
            console.error('Hãy chạy "npm run deploy:migration" (hoặc npm run migrate:dry rồi npm run migrate) trước khi khởi động backend.');
            await client.shutdown().catch(() => {});
            process.exit(1);
        }
        createApp().listen(PORT, () => {
            console.log(`Backend đang chạy tại http://localhost:${PORT}`);
            extensions.startBackground();
        });
    } catch (error) {
        console.error('Không thể khởi động backend:', error.message);
        await client.shutdown().catch(() => {});
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

module.exports = { createApp, startServer, checkSchema, REQUIRED_TABLES, REQUIRED_COLUMNS };
