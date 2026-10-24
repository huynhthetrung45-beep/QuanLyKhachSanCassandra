-- Migration 009: tai khoan & bao mat (PT-01, PT-02, PT-03, PT-04, PT-09, PT-17, NFR-16 2FA).
-- CHI THEM bang moi. Khong sua / xoa bang cu. TTL dat o cau lenh ghi (USING TTL), khong dat tren bang.

-- Trang thai bao mat cua tai khoan: vai tro, khoa, moc doi mat khau, xac minh email, 2FA.
CREATE TABLE IF NOT EXISTS account_security (
    user_id text PRIMARY KEY,
    email text,
    role text,
    locked boolean,
    locked_reason text,
    locked_at timestamp,
    locked_by text,
    password_changed_at timestamp,
    email_verified_at timestamp,
    verification_required boolean,
    totp_secret text,
    totp_enabled boolean,
    updated_at timestamp
);

-- PT-01, PT-17: cac phien dang nhap cua 1 nguoi (dang xuat tu xa, huy phien khi doi mat khau).
CREATE TABLE IF NOT EXISTS sessions_by_user (
    user_id text,
    session_hash text,
    created_at timestamp,
    last_seen_at timestamp,
    user_agent text,
    ip text,
    two_factor_ok boolean,
    PRIMARY KEY ((user_id), session_hash)
);

-- PT-02: token dat lai mat khau (chi luu SHA-256), ghi bang USING TTL 1800, dung mot lan.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash text PRIMARY KEY,
    user_id text,
    email text,
    created_at timestamp
);

-- PT-09: ma xac minh email (chi luu hash), ghi bang USING TTL.
CREATE TABLE IF NOT EXISTS email_verification_codes (
    user_id text PRIMARY KEY,
    code_hash text,
    email text,
    expires_at timestamp,
    attempts int
);

-- PT-04: anh dai dien / anh bia (noi dung tep tren o dia, Cassandra chi giu khoa luu tru).
CREATE TABLE IF NOT EXISTS user_media (
    user_id text PRIMARY KEY,
    avatar_key text,
    avatar_mime text,
    cover_key text,
    cover_mime text,
    updated_at timestamp
);

-- Han che 3.3: "lan cuoi truy cap" luu ben vung, khong mat khi khoi dong lai backend.
CREATE TABLE IF NOT EXISTS user_last_seen (
    user_id text PRIMARY KEY,
    last_seen_at timestamp
);
