-- MIGRATION 014-015 - KIEM TRA TRUOC (CHI DOC)
--   backend\scripts\verify-migration.cmd before 015
USE chat_ott;
-- Ky vong: 0 dong (21 bang moi chua ton tai)
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott' AND table_name IN ('tasks', 'tasks_by_user', 'tasks_by_group', 'task_comments_by_task', 'task_history_by_task', 'calendar_events', 'events_by_user_day', 'events_by_group_day', 'schedule_locks', 'idempotency_keys', 'reminders', 'reminders_by_user', 'reminders_by_target', 'reminders_due', 'notification_refs', 'meetings', 'meetings_by_user', 'meetings_by_group', 'meeting_invitations', 'meeting_links', 'meeting_participation');
-- Du lieu cu (phai giong nhau truoc / sau)
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
