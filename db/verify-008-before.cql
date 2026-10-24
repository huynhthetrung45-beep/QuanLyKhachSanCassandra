-- MIGRATION 008 - KIEM TRA TRUOC (CHI DOC)
--   backend\scripts\verify-migration.cmd before 008
-- Chi doc system_schema va cac bang/cot co tu truoc (chay duoc ca khi 006/007 chua ap dung).
USE chat_ott;
-- Ky vong: bang pinned_messages_by_conversation CHUA co (0 dong)
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott';
SELECT table_name, column_name FROM system_schema.columns WHERE keyspace_name = 'chat_ott' AND table_name = 'pinned_messages_by_conversation';
SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = 'chat_ott';
SELECT table_name, compaction, default_time_to_live, gc_grace_seconds FROM system_schema.tables
 WHERE keyspace_name = 'chat_ott' AND table_name IN ('users', 'conversations', 'messages_by_conversation');
-- Moc du lieu cu (bang nho cua do an)
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
