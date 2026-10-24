-- =====================================================================
-- KIEM TRA SAU MIGRATION  (CHI DOC - khong INSERT/UPDATE/DELETE/DDL)
--   backend\scripts\verify-migration.cmd after
--   (hoac: docker exec -i chatott-cassandra cqlsh < db\verify-after-migration.cql)
--
-- Chi chay SAU "npm run migrate" thanh cong. Phan B lap lai dung phan B cua
-- verify-before-migration.cql: ket qua phai GIONG HET (du lieu cu khong doi).
-- Khong COUNT(*) toan bang (xem giai thich trong file "before").
-- Lenh dung IN tren partition key = doc nhieu partition; chap nhan vi chi vai
-- partition co dinh cua bo du lieu mau.
-- =====================================================================
USE chat_ott;

-- ---------- A. Schema moi ----------
-- Ky vong 9 dong: 4 bang cu + accounts_by_email, conversation_state_by_user,
-- direct_conversations, sessions, users_by_name_token
SELECT table_name FROM system_schema.tables WHERE keyspace_name = 'chat_ott';

-- 3 cot moi: moi lenh ky vong 1 dong, type = text, kind = regular
SELECT table_name, column_name, kind, type FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'users' AND column_name = 'email';
SELECT table_name, column_name, kind, type FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'conversations' AND column_name = 'created_by';
SELECT table_name, column_name, kind, type FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott' AND table_name = 'conversations_by_user' AND column_name = 'last_sender_id';

-- Khoa cua bang moi. Ky vong:
--  accounts_by_email          email (partition_key)
--  sessions                   session_hash (partition_key)
--  direct_conversations       pair_key (partition_key)
--  conversation_state_by_user user_id (partition_key), conversation_id (clustering asc)
--  users_by_name_token        token_prefix (partition_key), name_token (clustering asc), user_id (clustering asc)
SELECT table_name, column_name, kind, position, clustering_order, type FROM system_schema.columns
 WHERE keyspace_name = 'chat_ott'
   AND table_name IN ('accounts_by_email', 'sessions', 'direct_conversations',
                      'conversation_state_by_user', 'users_by_name_token');

-- Bang cu KHONG doi cau hinh (giong ket qua "before")
SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name = 'chat_ott';
SELECT table_name, compaction, default_time_to_live, gc_grace_seconds FROM system_schema.tables
 WHERE keyspace_name = 'chat_ott'
   AND table_name IN ('users', 'conversations', 'conversations_by_user', 'messages_by_conversation');

-- ---------- B. Du lieu cu khong doi (so voi "before") ----------
SELECT user_id, display_name FROM users;                                          -- (8 rows)
SELECT conversation_id, conversation_type, last_message_at FROM conversations;     -- (10 rows)
SELECT COUNT(*) AS user01 FROM conversations_by_user WHERE user_id = 'user01';     -- 5
SELECT COUNT(*) AS user02 FROM conversations_by_user WHERE user_id = 'user02';     -- 5
SELECT COUNT(*) AS user03 FROM conversations_by_user WHERE user_id = 'user03';     -- 4
SELECT COUNT(*) AS user04 FROM conversations_by_user WHERE user_id = 'user04';     -- 4
SELECT COUNT(*) AS user05 FROM conversations_by_user WHERE user_id = 'user05';     -- 3
SELECT COUNT(*) AS user06 FROM conversations_by_user WHERE user_id = 'user06';     -- 3
SELECT COUNT(*) AS user07 FROM conversations_by_user WHERE user_id = 'user07';     -- 2
SELECT COUNT(*) AS user08 FROM conversations_by_user WHERE user_id = 'user08';     -- 2
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
SELECT created_at, message_id, sender_name, is_deleted FROM messages_by_conversation
 WHERE conversation_id = 11111111-1111-1111-1111-111111111111 LIMIT 3;
SELECT conversation_id, last_message_at FROM conversations
 WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
SELECT last_message_at, conversation_id, last_message_preview FROM conversations_by_user
 WHERE user_id = 'user01';

-- ---------- C. Cot moi tren dong cu = null (khong backfill) ----------
-- Ky vong email = null cho user01 (cho toi khi chay seed:accounts duoc duyet)
SELECT user_id, email FROM users WHERE user_id = 'user01';
-- Ky vong created_by = null cho ca 3 nhom cu (quyet dinh B)
SELECT conversation_id, conversation_name, created_by FROM conversations
 WHERE conversation_id IN (11111111-1111-1111-1111-111111111111,
                           22222222-2222-2222-2222-222222222222,
                           33333333-3333-3333-3333-333333333333);
-- Ky vong last_sender_id = null tren 5 dong cua user01
SELECT conversation_id, last_message_at, last_sender_id FROM conversations_by_user WHERE user_id = 'user01';

-- ---------- D. Backfill direct_conversations ----------
-- Ky vong 7 dong; moi pair_key = hai user_id da sap xep, noi bang '|':
--  user01|user02 -> 4444..., user01|user03 -> 5555..., user01|user08 -> 8888...,
--  user02|user04 -> 9999..., user03|user06 -> aaaa..., user04|user05 -> 6666..., user06|user07 -> 7777...
SELECT pair_key, conversation_id FROM direct_conversations
 WHERE pair_key IN ('user01|user02', 'user01|user03', 'user01|user08', 'user02|user04',
                    'user03|user06', 'user04|user05', 'user06|user07');
-- Thu tu nguoc (user02|user01) KHONG duoc ton tai: ky vong (0 rows)
SELECT pair_key FROM direct_conversations WHERE pair_key = 'user02|user01';

-- ---------- E. Backfill users_by_name_token ----------
-- Ky vong 16 dong, 2 token / nguoi (ten bo dau, chu thuong):
--  an, nguyen (user01) | binh, tran (user02) | chi, le (user03) | dung, pham (user04)
--  giang, hoang (user05) | huy, vu (user06) | dang, linh (user07) | bui, minh (user08)
SELECT token_prefix, name_token, user_id, display_name FROM users_by_name_token
 WHERE token_prefix IN ('an', 'ng', 'bi', 'tr', 'ch', 'le', 'du', 'ph',
                        'gi', 'ho', 'hu', 'vu', 'da', 'li', 'bu', 'mi');
-- Dung truy van tim kiem cua backend (1 partition, lat cat clustering): ky vong user01 / nguyen
SELECT name_token, user_id, display_name FROM users_by_name_token
 WHERE token_prefix = 'ng' AND name_token >= 'nguy' AND name_token < 'nguy~';

-- ---------- F. Bang moi chua co du lieu nghiep vu ----------
-- LIMIT 1 tren bang rong dung ngay, khong quet. Ky vong (0 rows) cho toi khi
-- seed:accounts / dang ky / dang nhap duoc phep chay.
SELECT email, user_id, status FROM accounts_by_email LIMIT 1;
SELECT user_id, expires_at FROM sessions LIMIT 1;
SELECT user_id, conversation_id FROM conversation_state_by_user LIMIT 1;
