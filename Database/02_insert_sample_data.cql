---USER 1 — Hiển thị các phòng còn có thể đặt
SELECT 
    hotel_id, 
    status, 
    room_number, 
    room_type, 
    price_per_night 
FROM rooms_by_hotel_status 
WHERE hotel_id = 'HOTEL001' AND status = 'Available';

---USER 2 — Kiểm tra phòng có bị trùng lịch đặt hay không
SELECT 
    room_number, 
    check_in_date, 
    check_out_date, 
    status 
FROM bookings_by_hotel_date 
WHERE hotel_id = 'HOTEL001';

---USER 3 — Ghi một booking mới
Ghi vào bảng theo khách hàng:
INSERT INTO bookings_by_guest 
(
    guest_id, 
    check_in_date, 
    booking_id, 
    hotel_id, 
    hotel_name, 
    room_number, 
    check_out_date, 
    total_amount, 
    status
) 
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

Ghi vào bảng theo khách sạn:
INSERT INTO bookings_by_hotel_date 
(
    hotel_id, 
    check_in_date, 
    booking_id, 
    guest_id, 
    guest_name, 
    room_number, 
    check_out_date, 
    total_amount, 
    status
) 
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);

---USER 4 — Tra cứu lịch sử booking của khách hàng
SELECT 
    guest_id, 
    check_in_date, 
    booking_id, 
    hotel_id, 
    hotel_name, 
    room_number, 
    check_out_date, 
    total_amount, 
    status 
FROM bookings_by_guest 
WHERE guest_id = ?;

---ADMIN 1 — Lấy thông tin khách sạn
SELECT 
    hotel_id, 
    hotel_name, 
    city, 
    address, 
    star_rating, 
    phone 
FROM hotels 
WHERE hotel_id = 'HOTEL001';

---ADMIN 2 — Quản lý danh sách phòng
SELECT 
    hotel_id, 
    room_number, 
    room_type, 
    price_per_night, 
    status 
FROM rooms_by_hotel 
WHERE hotel_id = 'HOTEL001';

---ADMIN 3 — Quản lý khách hàng
Lấy toàn bộ khách hàng:
SELECT 
    guest_id, 
    full_name, 
    phone, 
    email, 
    national_id 
FROM guests;

Lấy chi tiết một khách hàng:
SELECT 
    guest_id, 
    full_name, 
    phone, 
    email, 
    national_id 
FROM guests 
WHERE guest_id = ?;

---ADMIN 4 — Xem danh sách booking của khách sạn
SELECT 
    hotel_id, 
    check_in_date, 
    booking_id, 
    guest_id, 
    guest_name, 
    room_number, 
    check_out_date, 
    total_amount, 
    status 
FROM bookings_by_hotel_date 
WHERE hotel_id = 'HOTEL001';

---ADMIN 5 — Xem hóa đơn theo khách sạn
Bước 1: Lấy các booking của khách sạn
SELECT 
    hotel_id, 
    check_in_date, 
    booking_id, 
    guest_id, 
    guest_name, 
    room_number, 
    check_out_date, 
    total_amount, 
    status 
FROM bookings_by_hotel_date 
WHERE hotel_id = 'HOTEL001';

Bước 2: Lấy hóa đơn dựa trên booking_id
SELECT 
    booking_id, 
    invoice_id, 
    guest_id, 
    hotel_id, 
    room_charge, 
    service_charge, 
    tax, 
    total_amount, 
    payment_status, 
    issued_at 
FROM invoices_by_booking 
WHERE booking_id = ?;

---ADMIN 6 — Tạo hóa đơn tiền phòng
Lấy giá phòng:
SELECT 
    hotel_id, 
    room_number, 
    room_type, 
    price_per_night, 
    status 
FROM rooms_by_hotel 
WHERE hotel_id = 'HOTEL001' AND room_number = ?;

Tạo hóa đơn:
INSERT INTO invoices_by_booking 
(
    booking_id, 
    invoice_id, 
    guest_id, 
    hotel_id, 
    room_charge, 
    service_charge, 
    tax, 
    total_amount, 
    payment_status, 
    issued_at
) 
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

---DASHBOARD ADMIN — Truy vấn thống kê mới
1. Đếm tổng số lượng Booking:
SELECT COUNT(*) AS booking_count 
FROM bookings_by_hotel_date 
WHERE hotel_id = 'HOTEL001';

2. Truy vấn dữ liệu doanh thu theo tháng (Ví dụ tháng 9/2026):
SELECT 
    hotel_id, 
    year_month, 
    revenue_date, 
    revenue_amount 
FROM revenue_by_hotel_month 
WHERE hotel_id = 'HOTEL001' AND year_month = '2026-09';

---ADMIN / USER — Hủy đặt phòng

BEGIN BATCH
  UPDATE bookings_by_hotel_date 
  SET status = 'CANCELLED' 
  WHERE hotel_id = 'HOTEL001' AND check_in_date = '2026-10-15' AND booking_id = 123e4567-e89b-12d3-a456-426614174000;
Query:
  UPDATE bookings_by_guest 
  SET status = 'CANCELLED' 
  WHERE guest_id = 'GUEST001' AND check_in_date = '2026-10-15' AND booking_id = 123e4567-e89b-12d3-a456-426614174000;

  UPDATE bookings_by_phone 
  SET status = 'CANCELLED' 
  WHERE phone = '0123456789' AND check_in_date = '2026-10-15' AND booking_id = 123e4567-e89b-12d3-a456-426614174000;
APPLY BATCH;

---ADMIN — Cập nhật trạng thái phòng
Querry:
UPDATE rooms_by_hotel
SET status = 'Maintenance'
WHERE hotel_id = 'HOTEL001' AND room_number = 105;

---Tính năng mới — Xem Đánh giá/Review của khách sạn
code tạo bảng:
CREATE TABLE reviews_by_hotel (
    hotel_id TEXT,
    created_at TIMESTAMP,
    review_id UUID,
    guest_name TEXT,
    rating INT,
    comment TEXT,
    PRIMARY KEY (hotel_id, created_at, review_id)
)
WITH CLUSTERING ORDER BY (created_at DESC);

Querry:

SELECT rating, guest_name, comment, created_at
FROM reviews_by_hotel
WHERE hotel_id = 'HOTEL001';