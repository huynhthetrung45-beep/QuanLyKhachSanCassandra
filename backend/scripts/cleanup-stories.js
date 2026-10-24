// PT-23: dong story trong Cassandra tu het han (TTL 24h); tep anh tren o dia thi khong.
// Lenh nay xoa tep anh story cu hon 25 gio trong <UPLOAD_DIR>/stories.
//   npm run stories:cleanup            -> chi liet ke (dry-run)
//   npm run stories:cleanup -- --apply -> xoa
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { areaRoot } = require('../src/extensions/lib/storage');

const apply = process.argv.includes('--apply');
const cutoff = Date.now() - 25 * 3600 * 1000;
let found = 0;

function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.statSync(full).mtimeMs < cutoff) {
            found += 1;
            if (apply) fs.unlinkSync(full);
        }
    }
}

walk(areaRoot('stories'));
console.log(`${apply ? 'Đã xóa' : 'DRY RUN - sẽ xóa'} ${found} tệp ảnh story hết hạn.${apply ? '' : ' Thêm --apply để xóa.'}`);
