-- =====================================================================
-- MIGRATION 005 - KIEM TRA TRUOC  (CHI DOC)
--   backend\scripts\verify-migration.cmd before 005
USE chat_ott;
-- Ky vong 24 bang; 2 bang cua 005 CHUA co (0 dong)
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott';
SELECT table_name, column_name FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name IN ('public_posts_by_month', 'post_shares');
SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = 'chat_ott';
SELECT table_name, compaction, default_time_to_live, gc_grace_seconds FROM system_schema.tables
 WHERE keyspace_name = 'chat_ott'
   AND table_name IN ('users', 'conversations', 'conversations_by_user', 'messages_by_conversation', 'posts');

-- ---------- B. Du lieu cu (moc doi chieu truoc = sau) ----------
-- users, conversations: quet ca bang nhung chi 8 / 10 dong (quy mo do an).
-- KHONG dung cach nay tren bang lon.
SELECT user_id, display_name FROM users;
SELECT conversation_id, conversation_type, last_message_at FROM conversations;
-- conversations_by_user theo tung partition user_id
SELECT COUNT(*) AS user01 FROM conversations_by_user WHERE user_id = 'user01';
SELECT COUNT(*) AS user02 FROM conversations_by_user WHERE user_id = 'user02';
SELECT COUNT(*) AS user03 FROM conversations_by_user WHERE user_id = 'user03';
SELECT COUNT(*) AS user04 FROM conversations_by_user WHERE user_id = 'user04';
SELECT COUNT(*) AS user05 FROM conversations_by_user WHERE user_id = 'user05';
SELECT COUNT(*) AS user06 FROM conversations_by_user WHERE user_id = 'user06';
SELECT COUNT(*) AS user07 FROM conversations_by_user WHERE user_id = 'user07';
SELECT COUNT(*) AS user08 FROM conversations_by_user WHERE user_id = 'user08';

-- messages_by_conversation theo tung partition
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
SELECT COUNT(*) AS c2222 FROM messages_by_conversation WHERE conversation_id = 22222222-2222-2222-2222-222222222222;
SELECT COUNT(*) AS c3333 FROM messages_by_conversation WHERE conversation_id = 33333333-3333-3333-3333-333333333333;
SELECT COUNT(*) AS c4444 FROM messages_by_conversation WHERE conversation_id = 44444444-4444-4444-4444-444444444444;
SELECT COUNT(*) AS c5555 FROM messages_by_conversation WHERE conversation_id = 55555555-5555-5555-5555-555555555555;
SELECT COUNT(*) AS c6666 FROM messages_by_conversation WHERE conversation_id = 66666666-6666-6666-6666-666666666666;
SELECT COUNT(*) AS c7777 FROM messages_by_conversation WHERE conversation_id = 77777777-7777-7777-7777-777777777777;
SELECT COUNT(*) AS c8888 FROM messages_by_conversation WHERE conversation_id = 88888888-8888-8888-8888-888888888888;
SELECT COUNT(*) AS c9999 FROM messages_by_conversation WHERE conversation_id = 99999999-9999-9999-9999-999999999999;
SELECT COUNT(*) AS caaaa FROM messages_by_conversation WHERE conversation_id = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa;
-- Hoi thoai trong tam: 3 dong dau partition
SELECT created_at, message_id, sender_name, is_deleted FROM messages_by_conversation
 WHERE conversation_id = 11111111-1111-1111-1111-111111111111 LIMIT 3;
SELECT conversation_id, last_message_at FROM conversations
 WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
SELECT last_message_at, conversation_id, last_message_preview FROM conversations_by_user
 WHERE user_id = 'user01';



-- Bai viet hien co (chi doc 5 dong dau, khong dem toan bang)
SELECT post_id, author_id, privacy, is_deleted FROM posts LIMIT 5;
