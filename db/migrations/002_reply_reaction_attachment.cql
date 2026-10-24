-- Migration 002 - Tra loi tin nhan, tha cam xuc, chuyen tiep, xoa phia toi, tep dinh kem.
-- CHI THEM: 4 cot moi tren messages_by_conversation (dong cu = null) va 3 bang moi.
-- Khong doi khoa chinh, khong doi TTL / compaction / gc_grace / replication, khong backfill.
-- Chay qua: npm run deploy:migration  (hoac npm run migrate:dry / npm run migrate)

-- (1) Bang moi ---------------------------------------------------------------

-- Cam xuc: MOI NGUOI TOI DA 1 cam xuc / tin (khoa chinh chong trung, doi emoji = ghi de).
-- Truy van: reaction cua mot trang tin  ->  WHERE conversation_id = ? AND message_id IN (...)
--           reaction cua mot tin        ->  WHERE conversation_id = ? AND message_id = ?
CREATE TABLE IF NOT EXISTS reactions_by_message (
    conversation_id uuid,
    message_id timeuuid,
    user_id text,
    emoji text,
    reacted_at timestamp,
    PRIMARY KEY ((conversation_id), message_id, user_id)
) WITH CLUSTERING ORDER BY (message_id DESC, user_id ASC);

-- Metadata tep (noi dung tep nam ngoai Cassandra, o UPLOAD_DIR; storage_key la ten UUID).
-- Truy van: tai xuong     ->  WHERE conversation_id = ? AND attachment_id = ?
--           tin nhan      ->  WHERE conversation_id = ? AND attachment_id IN (...)
--           tab anh/tep   ->  WHERE conversation_id = ?  (moi nhat truoc, phan trang)
-- status: PENDING (vua tai len) -> ATTACHING (dang gan vao tin) -> ATTACHED
CREATE TABLE IF NOT EXISTS attachments_by_conversation (
    conversation_id uuid,
    attachment_id timeuuid,
    uploader_id text,
    message_id timeuuid,
    message_created_at timestamp,
    kind text,
    mime_type text,
    file_name text,
    size_bytes bigint,
    sha256 text,
    storage_key text,
    status text,
    created_at timestamp,
    PRIMARY KEY ((conversation_id), attachment_id)
) WITH CLUSTERING ORDER BY (attachment_id DESC);

-- Xoa phia toi: tin bi an CHI voi mot nguoi.
-- Truy van: loc mot trang tin -> WHERE user_id = ? AND conversation_id = ? AND message_id IN (...)
CREATE TABLE IF NOT EXISTS hidden_messages_by_user (
    user_id text,
    conversation_id uuid,
    message_id timeuuid,
    hidden_at timestamp,
    PRIMARY KEY ((user_id, conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);

-- (2) Cot moi tren bang tin nhan (dong cu = null) ------------------------------

-- Tra loi: tham chieu ON DINH toi tin goc (khoa chinh day du), khong chi luu doan trich.
ALTER TABLE messages_by_conversation ADD reply_to_id timeuuid;
ALTER TABLE messages_by_conversation ADD reply_to_created_at timestamp;
-- Tep dinh kem: danh sach attachment_id (metadata o attachments_by_conversation).
ALTER TABLE messages_by_conversation ADD attachment_ids list<uuid>;
-- Tin duoc chuyen tiep tu hoi thoai khac.
ALTER TABLE messages_by_conversation ADD forwarded boolean;
