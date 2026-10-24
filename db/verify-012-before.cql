-- MIGRATION 009-012 - KIEM TRA TRUOC (CHI DOC)
--   backend\scripts\verify-migration.cmd before 012
USE chat_ott;
-- Ky vong: 0 dong (32 bang moi chua ton tai)
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott' AND table_name IN ('account_security', 'sessions_by_user', 'password_reset_tokens', 'email_verification_codes', 'user_media', 'user_last_seen', 'message_meta_by_conversation', 'message_edits_by_message', 'conversation_members', 'group_owner_claims', 'group_profiles', 'conversation_prefs_by_user', 'mentions_by_user', 'group_invite_links', 'invite_links_by_conversation', 'group_join_requests', 'polls_by_conversation', 'poll_votes', 'saved_posts_by_user', 'saved_post_keys', 'stories_by_author', 'story_views', 'posts_by_hashtag', 'hashtags_by_post', 'notification_settings_by_user', 'push_subscriptions_by_user', 'task_reminders_by_day', 'reports', 'reports_by_status', 'report_keys', 'moderation_log', 'moderation_state');
SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = 'chat_ott';
-- Du lieu cu (so voi file after)
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
