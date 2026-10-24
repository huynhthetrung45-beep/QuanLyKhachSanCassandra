// PT-24: lap chi muc hashtag cho bai viet DA CO truoc khi co chuc nang hashtag.
//   npm run hashtags:backfill            -> chi in ke hoach (dry-run)
//   npm run hashtags:backfill -- --apply -> ghi posts_by_hashtag / hashtags_by_post
// Chi DOC bang posts; chi GHI 2 bang moi (upsert, chay lai an toan).
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { hashtagsOf } = require('../src/extensions/social-extras.service');

async function main() {
    const apply = process.argv.includes('--apply');
    const client = require('../src/config/cassandra');
    const opts = { prepare: true };
    let posts = 0;
    let rows = 0;
    try {
        await client.connect();
        let pageState;
        do {
            const rs = await client.execute('SELECT post_id, author_id, content, is_deleted FROM posts', [], { ...opts, fetchSize: 200, pageState });
            for (const p of rs.rows) {
                posts += 1;
                if (p.is_deleted) continue;
                for (const tag of hashtagsOf(p.content)) {
                    rows += 1;
                    if (!apply) continue;
                    await client.execute('INSERT INTO posts_by_hashtag (hashtag, post_id, author_id) VALUES (?, ?, ?)', [tag, p.post_id, p.author_id], opts);
                    await client.execute('INSERT INTO hashtags_by_post (post_id, hashtag) VALUES (?, ?)', [p.post_id, tag], opts);
                }
            }
            pageState = rs.pageState;
        } while (pageState);
        console.log(`${apply ? 'Đã ghi' : 'DRY RUN - sẽ ghi'} ${rows} cặp hashtag từ ${posts} bài viết.${apply ? '' : ' Thêm --apply để ghi.'}`);
    } catch (error) {
        console.error('Lỗi:', error.message);
        process.exitCode = 1;
    } finally {
        await client.shutdown().catch(() => {});
    }
}

main();
