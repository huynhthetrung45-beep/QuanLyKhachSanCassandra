// Don tep dinh kem mo coi. MAC DINH CHI XEM (dry-run): khong xoa gi, chi in ra se lam gi.
//   npm run attachments:cleanup                 -> dry-run
//   npm run attachments:cleanup -- --apply      -> thuc hien
//   them --older-than-hours=N (mac dinh 24), --purge-recalled (xoa ca noi dung tep cua tin da thu hoi)
//
// Xu ly:
//   1. Ban ghi PENDING cu hon N gio (tai len nhung khong gui) -> xoa ban ghi (LWT IF status='PENDING') + tep.
//   2. Ban ghi ATTACHING cu hon N gio (backend dung giua chung khi gui):
//        tin da ton tai -> chuyen ATTACHED; khong co tin -> xoa ban ghi (LWT IF status='ATTACHING') + tep.
//   3. Tep tren dia khong ban ghi nao tham chieu, va tep .part, cu hon N gio -> xoa tep.
//   4. (--purge-recalled) tep CHI con ban ghi RECALLED tham chieu -> xoa tep (ban ghi giu nguyen).
//   5. Anh bai viet (UPLOAD_DIR/posts): ban ghi post_media PENDING cu hon N gio -> xoa ban ghi (LWT) + tep;
//      tep anh khong ban ghi nao tham chieu, cu hon N gio -> xoa tep. Anh ATTACHED khong bao gio bi dong toi.
// Khong bao gio xoa tep con ban ghi PENDING moi / ATTACHING moi / ATTACHED tham chieu.
// Liet ke hoi thoai bang "SELECT conversation_id FROM conversations" (quet bang nho, chi dung cho
// lenh quan tri nay; API khong dung). Moi bang khac doc theo partition key.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { uploadDir, storagePath } = require('../src/services/attachment.service');

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function* pages(query, params, fetchSize) {
    let pageState;
    do {
        const rs = await db.execute(query, params, { fetchSize, pageState });
        yield rs.rows;
        pageState = rs.pageState;
    } while (pageState);
}

function walkDisk(root) {
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const y of fs.readdirSync(root)) {
        if (!/^\d{4}$/.test(y)) continue;
        for (const m of fs.readdirSync(path.join(root, y))) {
            if (!/^\d{2}$/.test(m)) continue;
            const dir = path.join(root, y, m);
            for (const f of fs.readdirSync(dir)) {
                const full = path.join(dir, f);
                const st = fs.statSync(full);
                if (!st.isFile()) continue;
                out.push({ full, name: f, key: `${y}/${m}/${f}`, mtime: st.mtimeMs, size: st.size });
            }
        }
    }
    return out;
}

async function runCleanup({ apply = false, olderThanHours = 24, purgeRecalled = false, log = console.log } = {}) {
    const cutoff = Date.now() - olderThanHours * 3600 * 1000;
    const verb = apply ? 'đã' : 'sẽ';
    const report = { conversations: 0, rows: 0, pendingRemoved: 0, attachingFinalized: 0, attachingRemoved: 0,
        lwtSkipped: 0, filesRemoved: 0, bytesFreed: 0 };
    const refs = new Map(); // storage_key -> Set(status) cua cac ban ghi CON GIU lai
    const toUnlink = new Set();
    const ref = (key, status) => { if (!refs.has(key)) refs.set(key, new Set()); refs.get(key).add(status); };

    for await (const convRows of pages('SELECT conversation_id FROM conversations', [], 100)) {
        for (const { conversation_id: cid } of convRows) {
            report.conversations += 1;
            for await (const rows of pages(
                `SELECT attachment_id, message_id, message_created_at, storage_key, status, created_at
                 FROM attachments_by_conversation WHERE conversation_id = ?`, [cid], 200)) {
                for (const r of rows) {
                    report.rows += 1;
                    const old = r.created_at && new Date(r.created_at).getTime() < cutoff;
                    const id = `${cid}/${r.attachment_id}`;
                    if (r.status === 'PENDING' && old) {
                        log(`  [PENDING cũ] ${id} -> ${verb} xóa bản ghi và tệp`);
                        if (apply) {
                            const rs = await db.execute(
                                `DELETE FROM attachments_by_conversation WHERE conversation_id = ? AND attachment_id = ?
                                 IF status = 'PENDING'`, [cid, r.attachment_id]);
                            if (!rs.wasApplied()) { report.lwtSkipped += 1; ref(r.storage_key, 'CHANGED'); continue; }
                        }
                        report.pendingRemoved += 1;
                        toUnlink.add(r.storage_key);
                        continue;
                    }
                    if (r.status === 'ATTACHING' && old) {
                        const msg = r.message_id && r.message_created_at ? (await db.execute(
                            `SELECT is_deleted FROM messages_by_conversation
                             WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
                            [cid, r.message_created_at, r.message_id])).first() : null;
                        if (msg) {
                            const next = msg.is_deleted ? 'RECALLED' : 'ATTACHED';
                            log(`  [ATTACHING kẹt, tin có thật] ${id} -> ${verb} chuyển ${next}`);
                            if (apply) {
                                const rs = await db.execute(
                                    `UPDATE attachments_by_conversation SET status = ?
                                     WHERE conversation_id = ? AND attachment_id = ? IF status = 'ATTACHING'`,
                                    [next, cid, r.attachment_id]);
                                if (!rs.wasApplied()) report.lwtSkipped += 1;
                            }
                            report.attachingFinalized += 1;
                            ref(r.storage_key, next);
                        } else {
                            log(`  [ATTACHING kẹt, không có tin] ${id} -> ${verb} xóa bản ghi và tệp`);
                            if (apply) {
                                const rs = await db.execute(
                                    `DELETE FROM attachments_by_conversation WHERE conversation_id = ? AND attachment_id = ?
                                     IF status = 'ATTACHING'`, [cid, r.attachment_id]);
                                if (!rs.wasApplied()) { report.lwtSkipped += 1; ref(r.storage_key, 'CHANGED'); continue; }
                            }
                            report.attachingRemoved += 1;
                            toUnlink.add(r.storage_key);
                        }
                        continue;
                    }
                    ref(r.storage_key, r.status);
                }
            }
        }
    }

    const root = uploadDir();
    for (const f of walkDisk(root)) {
        const isPart = f.name.endsWith('.part');
        const key = isPart ? f.key.replace(/\.part$/, '') : f.key;
        if (!isPart && !KEY_RE.test(f.name)) continue; // tep la do nguoi khac dat vao: khong dung toi
        const statuses = refs.get(key);
        let reason = null;
        if (isPart) reason = f.mtime < cutoff ? 'tệp tạm .part cũ' : null;
        else if (toUnlink.has(key) && !statuses) reason = 'bản ghi đã dọn';
        else if (!statuses) reason = f.mtime < cutoff ? 'không bản ghi nào tham chiếu' : null;
        else if (purgeRecalled && [...statuses].every(s => s === 'RECALLED')) reason = 'chỉ còn tin đã thu hồi';
        if (!reason) continue;
        log(`  [tệp] ${f.key} (${f.size} byte, ${reason}) -> ${verb} xóa`);
        if (apply) {
            const full = isPart ? f.full : storagePath(key);
            await fs.promises.unlink(full).catch(e => log(`    không xóa được: ${e.code}`));
        }
        report.filesRemoved += 1;
        report.bytesFreed += f.size;
    }
    if (await tableExists('post_media')) Object.assign(report, await cleanupPostMedia({ apply, cutoff, verb, log }));
    return report;
}

async function tableExists(table) {
    const ks = process.env.CASSANDRA_KEYSPACE || 'chat_ott';
    const rs = await db.execute('SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?', [ks, table]);
    return rs.rows.length > 0;
}

// Anh bai viet: quet bang post_media (chi lenh quan tri) + thu muc posts.
async function cleanupPostMedia({ apply, cutoff, verb, log }) {
    const out = { postMediaRows: 0, postMediaPendingRemoved: 0, postMediaFilesRemoved: 0 };
    const keep = new Set();
    const drop = new Set();
    for await (const rows of pages('SELECT media_id, owner_id, status, storage_key, created_at FROM post_media', [], 200)) {
        for (const m of rows) {
            out.postMediaRows += 1;
            const old = m.created_at && new Date(m.created_at).getTime() < cutoff;
            if (m.status === 'PENDING' && old) {
                log(`  [ảnh bài PENDING cũ] ${m.media_id} -> ${verb} xóa bản ghi và tệp`);
                if (apply) {
                    const rs = await db.execute(`DELETE FROM post_media WHERE media_id = ? IF status = 'PENDING' AND owner_id = ?`, [m.media_id, m.owner_id]);
                    if (!rs.wasApplied()) { keep.add(m.storage_key); continue; }
                }
                out.postMediaPendingRemoved += 1;
                drop.add(m.storage_key);
                continue;
            }
            keep.add(m.storage_key);
        }
    }
    const root = path.join(uploadDir(), 'posts');
    for (const f of walkDisk(root)) {
        const isPart = f.name.endsWith('.part');
        const key = isPart ? f.key.replace(/\.part$/, '') : f.key;
        if (!isPart && !KEY_RE.test(f.name)) continue;
        if (keep.has(key)) continue;
        if (!drop.has(key) && f.mtime >= cutoff) continue;
        log(`  [ảnh bài] posts/${f.key} (${f.size} byte) -> ${verb} xóa`);
        if (apply) await fs.promises.unlink(f.full).catch(e => log(`    không xóa được: ${e.code}`));
        out.postMediaFilesRemoved += 1;
    }
    return out;
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const purgeRecalled = args.includes('--purge-recalled');
    const hoursArg = args.find(a => a.startsWith('--older-than-hours='));
    const olderThanHours = hoursArg ? Number(hoursArg.split('=')[1]) : 24;
    if (!Number.isFinite(olderThanHours) || olderThanHours < 1) {
        console.error('--older-than-hours phải >= 1');
        process.exit(2);
    }
    const client = db.getClient();
    (async () => {
        await client.connect();
        console.log(`Dọn tệp đính kèm | thư mục: ${uploadDir()} | cũ hơn ${olderThanHours} giờ | ${apply ? 'THỰC HIỆN' : 'CHỈ XEM (dry-run)'}`);
        const r = await runCleanup({ apply, olderThanHours, purgeRecalled });
        console.log(`\nĐã quét ${r.conversations} hội thoại, ${r.rows} bản ghi tệp.`);
        console.log(`PENDING xóa: ${r.pendingRemoved} | ATTACHING hoàn tất: ${r.attachingFinalized} | ATTACHING xóa: ${r.attachingRemoved}` +
            ` | bỏ qua do đổi trạng thái: ${r.lwtSkipped} | tệp xóa: ${r.filesRemoved} (${(r.bytesFreed / 1048576).toFixed(2)} MB)`);
        if (r.postMediaRows !== undefined) {
            console.log(`Ảnh bài viết: ${r.postMediaRows} bản ghi | PENDING xóa: ${r.postMediaPendingRemoved} | tệp xóa: ${r.postMediaFilesRemoved}`);
        }
        if (!apply) console.log('Chưa xóa gì. Thêm --apply để thực hiện.');
    })()
        .catch(e => { console.error(`[LỖI] ${e.message.split('\n')[0]}`); process.exitCode = 1; })
        .finally(() => client.shutdown().catch(() => {}));
}

module.exports = { runCleanup };
