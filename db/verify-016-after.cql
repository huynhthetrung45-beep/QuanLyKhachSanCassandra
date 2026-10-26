-- MIGRATION 016 - KIEM TRA SAU (CHI DOC)
--   backend\scripts\verify-migration.cmd after 016
USE chat_ott;
-- Ky vong: 1 dong
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott' AND table_name IN ('comment_reactions');
-- Du lieu cu (phai giong nhau truoc / sau)
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
