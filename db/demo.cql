-- Bo lenh CQLSH dung khi demo (SRS muc 9.2). Keyspace thuc te: chat_ott
-- Chay: docker exec -it chatott-cassandra cqlsh
USE chat_ott;

-- (0) Luoc do bang trong tam
DESCRIBE TABLE messages_by_conversation;

-- (1) Token cua partition hoi thoai trong tam
SELECT token(conversation_id), conversation_id
FROM messages_by_conversation
WHERE conversation_id = 11111111-1111-1111-1111-111111111111 LIMIT 1;

-- (2) 5 tin moi nhat: tin vua gui tren web phai nam DONG DAU TIEN
SELECT created_at, sender_name, content, is_deleted
FROM messages_by_conversation
WHERE conversation_id = 11111111-1111-1111-1111-111111111111 LIMIT 5;

-- (3) Node chua partition (chay ngoai cqlsh, trong CMD):
-- docker exec -it chatott-cassandra nodetool getendpoints chat_ott messages_by_conversation 11111111-1111-1111-1111-111111111111

-- (4) Truy vet truy van mot trang: chi doc MOT partition
TRACING ON;
PAGING 20;
SELECT created_at, content FROM messages_by_conversation
WHERE conversation_id = 11111111-1111-1111-1111-111111111111;
TRACING OFF;
PAGING ON;

-- (5) So tin trong partition
SELECT COUNT(*) FROM messages_by_conversation
WHERE conversation_id = 11111111-1111-1111-1111-111111111111;

-- (6) Danh sach hoi thoai cua user01 (bang phi chuan hoa, 1 partition)
SELECT last_message_at, conversation_name, last_message_preview
FROM conversations_by_user WHERE user_id = 'user01';

-- (7) Tai khoan: email la partition key, mat khau chi luu dang bam
SELECT email, user_id, password_hash FROM accounts_by_email LIMIT 3;
