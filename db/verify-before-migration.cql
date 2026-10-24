-- =====================================================================
-- KIEM TRA TRUOC MIGRATION  (CHI DOC - khong INSERT/UPDATE/DELETE/DDL)
--   backend\scripts\verify-migration.cmd before
--   (hoac: docker exec -i chatott-cassandra cqlsh < db\verify-before-migration.cql)
--
-- Chi truy van bang/cot DANG TON TAI. Viec "chua co bang/cot moi" duoc kiem tra
-- qua system_schema (khong bao loi, chi tra 0 dong).
-- Khong dung COUNT(*) toan bang: Cassandra phai quet moi partition tren moi node
-- va gui canh bao "Aggregation query used without partition key". O day chi dem
-- trong MOT partition (WHERE partition key = ...), chi phi gioi han boi kich thuoc partition.
-- Gia tri ky vong ghi o comment = so lieu audit ngay 21/10/2026.
-- =====================================================================
USE chat_ott;

-- ---------- A. Schema hien co ----------
-- Ky vong 4 dong: conversations, conversations_by_user, messages_by_conversation, users
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott';

-- Cot moi CHUA ton tai: moi lenh ky vong (0 rows)
SELECT table_name, column_name FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'users' AND column_name = 'email';
SELECT table_name, column_name FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'conversations' AND column_name = 'created_by';
SELECT table_name, column_name FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'conversations_by_user' AND column_name = 'last_sender_id';

-- Bang moi CHUA ton tai: ky vong (0 rows)
SELECT table_name FROM system_schema.tables
 WHERE keyspace_name = 'chat_ott'
   AND table_name IN ('accounts_by_email', 'sessions', 'direct_conversations',
                      'conversation_state_by_user', 'users_by_name_token');

-- Cau hinh se giu nguyen (khong doi boi migration): SimpleStrategy RF=1
SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = 'chat_ott';
-- Ky vong: SizeTieredCompactionStrategy, default_time_to_live 0, gc_grace_seconds 864000
SELECT table_name, compaction, default_time_to_live, gc_grace_seconds FROM system_schema.tables
 WHERE keyspace_name = 'chat_ott'
   AND table_name IN ('users', 'conversations', 'conversations_by_user', 'messages_by_conversation');

-- ---------- B. Du lieu cu (moc doi chieu truoc = sau) ----------
-- users, conversations: quet ca bang nhung chi 8 / 10 dong (quy mo do an).
-- KHONG dung cach nay tren bang lon.
SELECT user_id, display_name FROM users;                                          -- (8 rows)
SELECT conversation_id, conversation_type, last_message_at FROM conversations;     -- (10 rows)

-- conversations_by_user theo tung partition user_id. Ky vong: 5,5,4,4,3,3,2,2 (tong 28)
SELECT COUNT(*) AS user01 FROM conversations_by_user WHERE user_id = 'user01';
SELECT COUNT(*) AS user02 FROM conversations_by_user WHERE user_id = 'user02';
SELECT COUNT(*) AS user03 FROM conversations_by_user WHERE user_id = 'user03';
SELECT COUNT(*) AS user04 FROM conversations_by_user WHERE user_id = 'user04';
SELECT COUNT(*) AS user05 FROM conversations_by_user WHERE user_id = 'user05';
SELECT COUNT(*) AS user06 FROM conversations_by_user WHERE user_id = 'user06';
SELECT COUNT(*) AS user07 FROM conversations_by_user WHERE user_id = 'user07';
SELECT COUNT(*) AS user08 FROM conversations_by_user WHERE user_id = 'user08';

-- messages_by_conversation theo tung partition. Ky vong 202 + 9 x 30 = 472
SELECT COUNT(*) AS c1111 FROM messages_by_conversation WHERE conversation_id = 11111111-1111-1111-1111-111111111111;  -- 202
SELECT COUNT(*) AS c2222 FROM messages_by_conversation WHERE conversation_id = 22222222-2222-2222-2222-222222222222;  -- 30
SELECT COUNT(*) AS c3333 FROM messages_by_conversation WHERE conversation_id = 33333333-3333-3333-3333-333333333333;  -- 30
SELECT COUNT(*) AS c4444 FROM messages_by_conversation WHERE conversation_id = 44444444-4444-4444-4444-444444444444;  -- 30
SELECT COUNT(*) AS c5555 FROM messages_by_conversation WHERE conversation_id = 55555555-5555-5555-5555-555555555555;  -- 30
SELECT COUNT(*) AS c6666 FROM messages_by_conversation WHERE conversation_id = 66666666-6666-6666-6666-666666666666;  -- 30
SELECT COUNT(*) AS c7777 FROM messages_by_conversation WHERE conversation_id = 77777777-7777-7777-7777-777777777777;  -- 30
SELECT COUNT(*) AS c8888 FROM messages_by_conversation WHERE conversation_id = 88888888-8888-8888-8888-888888888888;  -- 30
SELECT COUNT(*) AS c9999 FROM messages_by_conversation WHERE conversation_id = 99999999-9999-9999-9999-999999999999;  -- 30
SELECT COUNT(*) AS caaaa FROM messages_by_conversation WHERE conversation_id = aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa;  -- 30

-- Hoi thoai trong tam: 3 dong dau partition (ky vong 05:23:36 da thu hoi, 05:12:19 da thu hoi, 05:03:13)
SELECT created_at, message_id, sender_name, is_deleted FROM messages_by_conversation
 WHERE conversation_id = 11111111-1111-1111-1111-111111111111 LIMIT 3;
-- last_message_at ky vong 2026-10-21 05:03:13.440 (khac dong dau - hop le, xem README)
SELECT conversation_id, last_message_at FROM conversations
 WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
SELECT last_message_at, conversation_id, last_message_preview FROM conversations_by_user
 WHERE user_id = 'user01';
