
-- =====================================================
-- Chat OTT - Apache Cassandra 4.1
-- Keyspace: chat_ott
-- Dung cho moi truong demo 1 node, RF = 1
-- =====================================================

CREATE KEYSPACE IF NOT EXISTS chat_ott
WITH replication = {
    'class': 'SimpleStrategy',
    'replication_factor': 1
};

USE chat_ott;

-- 1. Danh sach nguoi dung
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMP
);

-- 2. Thong tin cuoc tro chuyen
CREATE TABLE IF NOT EXISTS conversations (
    conversation_id UUID PRIMARY KEY,
    conversation_name TEXT,
    conversation_type TEXT,
    participant_ids SET<TEXT>,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP
);

-- 3. Danh sach cuoc tro chuyen theo nguoi dung
CREATE TABLE IF NOT EXISTS conversations_by_user (
    user_id TEXT,
    last_message_at TIMESTAMP,
    conversation_id UUID,
    conversation_name TEXT,
    conversation_type TEXT,
    last_message_preview TEXT,
    last_sender_name TEXT,
    PRIMARY KEY ((user_id), last_message_at, conversation_id)
) WITH CLUSTERING ORDER BY (
    last_message_at DESC,
    conversation_id ASC
);

-- 4. Lich su tin nhan theo cuoc tro chuyen
CREATE TABLE IF NOT EXISTS messages_by_conversation (
    conversation_id UUID,
    created_at TIMESTAMP,
    message_id TIMEUUID,
    sender_id TEXT,
    sender_name TEXT,
    content TEXT,
    message_type TEXT,
    is_deleted BOOLEAN,
    deleted_at TIMESTAMP,
    PRIMARY KEY ((conversation_id), created_at, message_id)
) WITH CLUSTERING ORDER BY (
    created_at DESC,
    message_id DESC
);
