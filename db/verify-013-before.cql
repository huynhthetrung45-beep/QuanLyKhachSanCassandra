-- MIGRATION 013 - KIEM TRA TRUOC (CHI DOC)
--   backend\scripts\verify-migration.cmd before 013
USE chat_ott;
-- Ky vong: 0 dong (3 bang moi chua ton tai)
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott' AND table_name IN ('story_reactions', 'story_styles', 'ai_chat_by_user');
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
