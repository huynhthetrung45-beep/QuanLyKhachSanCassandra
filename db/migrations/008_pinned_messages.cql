-- MIGRATION 008 - GHIM TIN NHAN TRONG HOI THOAI (chi THEM bang, khong sua / xoa du lieu cu)
-- Truy van: danh sach ghim cua MOT hoi thoai = doc 1 partition (toi da 20 dong, gioi han o backend).
-- message_created_at luu de doc tin goc bang khoa chinh day du cua messages_by_conversation.
-- Chi ghi bang LWT (INSERT IF NOT EXISTS / DELETE IF EXISTS): ghim lai khi retry khong tao trung.
CREATE TABLE IF NOT EXISTS pinned_messages_by_conversation (
    conversation_id UUID,
    message_id TIMEUUID,
    message_created_at TIMESTAMP,
    pinned_by TEXT,
    pinned_at TIMESTAMP,
    PRIMARY KEY ((conversation_id), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
