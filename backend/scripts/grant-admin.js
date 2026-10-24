// Cap / go quyen quan tri vien (PT-08).
//   npm run admin:grant -- an@chatott.demo          -> role ADMIN
//   npm run admin:grant -- an@chatott.demo --revoke -> role USER
// Chi ghi bang moi account_security; khong sua bang cu.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { normalizeEmail } = require('../src/utils/validate');

async function main() {
    const email = normalizeEmail(process.argv[2]);
    const revoke = process.argv.includes('--revoke');
    if (!email) {
        console.error('Cách dùng: npm run admin:grant -- <email> [--revoke]');
        process.exitCode = 1;
        return;
    }
    const client = require('../src/config/cassandra');
    try {
        await client.connect();
        const acc = (await client.execute('SELECT user_id, status FROM accounts_by_email WHERE email = ?', [email], { prepare: true })).first();
        if (!acc) throw new Error(`Không có tài khoản ${email}.`);
        await client.execute('UPDATE account_security SET role = ?, email = ?, updated_at = ? WHERE user_id = ?',
            [revoke ? 'USER' : 'ADMIN', email, new Date(), acc.user_id], { prepare: true });
        console.log(`${revoke ? 'Đã gỡ' : 'Đã cấp'} quyền quản trị cho ${email} (${acc.user_id}).`);
    } catch (error) {
        console.error('Lỗi:', error.message);
        process.exitCode = 1;
    } finally {
        await client.shutdown().catch(() => {});
    }
}

main();
