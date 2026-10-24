// Gan tai khoan dang nhap cho 8 nguoi dung mau (user01..user08) de demo.
// Mat khau KHONG nam trong ma nguon: doc tu bien moi truong DEMO_PASSWORD.
//   Windows CMD (2 dong rieng, dung dau ngoac kep de khong dinh khoang trang):
//     set "DEMO_PASSWORD=MatKhauCuaBan123"
//     npm run seed:accounts
// Chi them ban ghi (INSERT ... IF NOT EXISTS, status ACTIVE vi ho so users da co san)
// va ghi cot MOI users.email cua 8 user mau; khong xoa, khong sua cot cu. Chay lai: bo qua email da co.
// Can chay SAU "npm run migrate".
const client = require('../src/config/cassandra');
const { hashPassword } = require('../src/utils/password');

const ACCOUNTS = [
    ['user01', 'an@chatott.demo'],
    ['user02', 'binh@chatott.demo'],
    ['user03', 'chi@chatott.demo'],
    ['user04', 'dung@chatott.demo'],
    ['user05', 'giang@chatott.demo'],
    ['user06', 'huy@chatott.demo'],
    ['user07', 'linh@chatott.demo'],
    ['user08', 'minh@chatott.demo']
];

async function main() {
    const password = process.env.DEMO_PASSWORD || '';
    if (password !== password.trim()) {
        throw new Error('DEMO_PASSWORD có khoảng trắng ở đầu/cuối (thường do "set X=... && ..." trong CMD). '
            + 'Hãy đặt lại bằng: set "DEMO_PASSWORD=MatKhau123" rồi chạy npm run seed:accounts ở dòng riêng.');
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw new Error('Hãy đặt biến DEMO_PASSWORD (≥ 8 ký tự, có chữ và số) trước khi chạy.');
    }
    await client.connect();
    for (const [userId, email] of ACCOUNTS) {
        const user = (await client.execute('SELECT user_id, display_name FROM users WHERE user_id = ?',
            [userId], { prepare: true })).first();
        if (!user) { console.log(`- ${userId}: không có trong bảng users, bỏ qua`); continue; }
        const res = await client.execute(
            `INSERT INTO accounts_by_email (email, user_id, password_hash, status, created_at)
             VALUES (?, ?, ?, 'ACTIVE', ?) IF NOT EXISTS`,
            [email, userId, await hashPassword(password), new Date()], { prepare: true });
        if (!res.wasApplied()) {
            console.log(`= ${email}: đã có tài khoản, giữ nguyên`);
            continue;
        }
        // Chi ghi o cot email MOI (dang null); khong dong vao display_name / avatar / created_at.
        await client.execute('UPDATE users SET email = ? WHERE user_id = ?', [email, userId], { prepare: true });
        console.log(`+ ${email} -> ${userId} (${user.display_name})`);
    }
    console.log('\nXong. Đăng nhập bằng các email trên với mật khẩu trong DEMO_PASSWORD.');
}

main()
    .catch(e => { console.error('Lỗi:', e.message); process.exitCode = 1; })
    .finally(() => client.shutdown().catch(() => {}));
