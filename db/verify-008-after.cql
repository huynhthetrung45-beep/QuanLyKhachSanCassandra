-- MIGRATION 008 - KIEM TRA SAU (CHI DOC)
--   backend\scripts\verify-migration.cmd after 008
USE chat_ott;
-- Ky vong: bang moi co 5 cot; khoa (conversation_id) + clustering message_id DESC
SELECT column_name, kind, position, clustering_order, type FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'pinned_messages_by_conversation';
SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = 'chat_ott';
SELECT table_name, compaction, default_time_to_live, gc_grace_seconds FROM system_schema.tables
 WHERE keyspace_name = 'chat_ott' AND table_name IN ('users', 'conversations', 'messages_by_conversation', 'pinned_messages_by_conversation');
-- Du lieu cu khong doi (so voi file before)
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
-- Bang moi bat dau rong (migration khong ghi du lieu)
SELECT COUNT(*) AS pins_1111 FROM pinned_messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
