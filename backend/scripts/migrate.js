// Ap dung migration KHONG PHA HUY cho CSDL dang chay.
//   npm run migrate:dry   (node backend/scripts/migrate.js --dry-run) -> CHI DOC, in ke hoach
//   npm run migrate       -> ap dung
//
// Quy trinh (giong nhau o ca hai che do, chi khac la dry-run KHONG goi lenh ghi):
//  1. Doc cac cau lenh trong db/migrations/*.cql. Chi chap nhan:
//       CREATE TABLE IF NOT EXISTS ...      va      ALTER TABLE <bang> ADD <cot> <kieu>
//     Bat ky tu khoa DROP / TRUNCATE / DELETE / UPDATE / INSERT / WITH compaction... -> tu choi.
//  2. Voi moi bang moi: neu chua co -> CREATE; neu da co -> so sanh cot, kieu, khoa voi
//     system_schema. Khop -> bo qua; khac -> DUNG LAI (khong tu sua).
//  3. Voi moi cot moi: neu chua co -> ALTER ADD; neu co va dung kieu -> bo qua; sai kieu -> DUNG.
//  4. Backfill (chi ghi vao bang MOI, moi lenh la upsert/LWT tat dinh -> chay lai an toan):
//       direct_conversations   <- cac hoi thoai DIRECT co 2 thanh vien  (INSERT ... IF NOT EXISTS)
//       users_by_name_token    <- token cua display_name moi user       (INSERT, khoa tat dinh)
//  5. Kiem tra lai toan bo cau truc sau khi chay (che do that).
const fs = require('fs');
const path = require('path');
const { pairKey } = require('../src/services/conversation.service');
const { nameTokens, tokenBucket } = require('../src/utils/text');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
// Tu khoa danh rieng CQL: khong cho dung lam ten bang/cot (tranh loi cu phap khi truy van).
const RESERVED = new Set(('ADD ALLOW ALTER AND APPLY ASC AUTHORIZE BATCH BEGIN BY COLUMNFAMILY CREATE DELETE DESC '
    + 'DESCRIBE DROP ENTRIES EXECUTE FROM FULL GRANT IF IN INDEX INFINITY INSERT INTO IS KEYSPACE LIMIT '
    + 'MATERIALIZED MBEAN MBEANS MODIFY NAN NORECURSIVE NOT NULL OF ON OR ORDER PRIMARY RENAME REPLACE '
    + 'REVOKE SCHEMA SELECT SET TABLE TO TOKEN TRUNCATE UNLOGGED UPDATE USE USING VIEW WHERE WITH').split(' '));
function checkIdentifier(name, context) {
    if (RESERVED.has(name.toUpperCase())) {
        throw new Error(`"${name}" là từ khóa CQL dành riêng, không dùng làm tên (${context}).`);
    }
}
// Tu choi moi thu ngoai pham vi: xoa/ghi du lieu, quyen, va moi thay doi cau hinh
// (TTL, compaction, gc_grace, replication / keyspace).
const FORBIDDEN = /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|BATCH|GRANT|REVOKE|KEYSPACE|TTL)\b|compaction|default_time_to_live|gc_grace|replication/i;

function statementsOf(file) {
    return fs.readFileSync(file, 'utf8')
        .split('\n').map(line => line.replace(/--.*$/, '')).join('\n')
        .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Phan tich CREATE TABLE -> { table, columns: {ten: kieu}, partitionKey, clustering: [[ten, ASC|DESC]] }
function parseCreate(stmt) {
    const m = stmt.match(/^CREATE TABLE IF NOT EXISTS (\w+) \((.+?)\)(?: WITH CLUSTERING ORDER BY \(([^)]+)\))?$/i);
    if (!m) throw new Error(`Không phân tích được CREATE TABLE: ${stmt}`);
    const [, table, body, orderText] = m;
    const columns = {};
    let partitionKey = [];
    let clustering = [];
    const pk = body.match(/PRIMARY KEY \(\((.+?)\)(?:, (.+?))?\)/i);
    const bodyNoPk = body.replace(/,?\s*PRIMARY KEY \(\(.+?\)(?:, .+?)?\)/i, '');
    for (const part of bodyNoPk.split(',').map(s => s.trim()).filter(Boolean)) {
        const col = part.match(/^(\w+) ([\w<>]+)( PRIMARY KEY)?$/i);
        if (!col) throw new Error(`Không phân tích được cột "${part}" của ${table}`);
        checkIdentifier(col[1], `bảng ${table}`);
        columns[col[1].toLowerCase()] = col[2].toLowerCase();
        if (col[3]) partitionKey = [col[1].toLowerCase()];
    }
    if (pk) {
        partitionKey = pk[1].split(',').map(s => s.trim().toLowerCase());
        clustering = pk[2] ? pk[2].split(',').map(s => [s.trim().toLowerCase(), 'ASC']) : [];
    }
    if (orderText) {
        const order = Object.fromEntries(orderText.split(',').map(s => s.trim().split(/\s+/)).map(([c, d]) => [c.toLowerCase(), d.toUpperCase()]));
        clustering = clustering.map(([c]) => [c, order[c] || 'ASC']);
    }
    return { table: table.toLowerCase(), columns, partitionKey, clustering };
}

function parsePlan(files) {
    const creates = [];
    const alters = [];
    for (const file of files) {
        for (const stmt of statementsOf(file)) {
            // Chi bo menh de "WITH CLUSTERING ORDER BY (...)" o cuoi; moi tuy chon khac
            // (compaction, TTL...) van bi kiem tra va tu choi.
            if (FORBIDDEN.test(stmt.replace(/ WITH CLUSTERING ORDER BY \([^)]*\)$/i, ''))) {
                throw new Error(`Từ chối câu lệnh ngoài phạm vi migration: ${stmt}`);
            }
            if (/^CREATE TABLE IF NOT EXISTS /i.test(stmt)) {
                creates.push({ stmt, def: parseCreate(stmt), file });
                continue;
            }
            const alter = stmt.match(/^ALTER TABLE (\w+) ADD (\w+) ([\w<>]+)$/i);
            if (alter) {
                checkIdentifier(alter[2], `ALTER TABLE ${alter[1]}`);
                alters.push({ stmt, table: alter[1].toLowerCase(), column: alter[2].toLowerCase(), type: alter[3].toLowerCase(), file });
                continue;
            }
            throw new Error(`Câu lệnh migration không được hỗ trợ: ${stmt}`);
        }
    }
    return { creates, alters };
}

async function runMigration(client, { keyspace, dryRun, log = console.log, migrationsDir = MIGRATIONS_DIR }) {
    const opts = { prepare: true };
    // DDL gui dang simple query (khong prepare): config/cassandra.js dat prepare = true mac dinh
    // nen phai ghi de ro rang. Driver tu cho schema agreement sau moi lenh DDL.
    const ddlOpts = { prepare: false };
    // Moi lenh ghi deu di qua ham nay; dry-run khong bao gio goi driver o day.
    const writes = [];
    // Backfill CHI duoc ghi vao cac bang dich nay (khong bao gio ghi vao bang du lieu cu).
    const BACKFILL_TABLES = new Set(['direct_conversations', 'users_by_name_token', 'public_posts_by_month', 'post_shares',
        'message_terms_by_conversation', 'conversation_daily_stats', 'conversation_hourly_stats', 'conversation_type_stats',
        'conversation_sender_stats', 'user_social_stats', 'root_comments_by_post', 'comment_replies_by_root']);
    const write = async (query, params = [], options = opts) => {
        const target = (/^\s*(?:INSERT INTO|UPDATE)\s+(\w+)/i.exec(query) || [])[1];
        const isDdl = /^\s*(CREATE|ALTER)\s+TABLE\b/i.test(query); // DDL da qua kiem tra FORBIDDEN
        if (!isDdl && (!target || !BACKFILL_TABLES.has(target.toLowerCase()))) {
            throw new Error(`Backfill không được ghi vào bảng "${target}" (chỉ ghi bảng mới).`);
        }
        writes.push(query);
        if (dryRun) return null;
        return client.execute(query, params, options);
    };

    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.cql')).sort()
        .map(f => path.join(migrationsDir, f));
    const plan = parsePlan(files);

    const tableCols = async table => {
        const rs = await client.execute(
            `SELECT column_name, kind, position, clustering_order, type FROM system_schema.columns
             WHERE keyspace_name = ? AND table_name = ?`, [keyspace, table], opts);
        return rs.rows;
    };

    const ks = await client.execute('SELECT keyspace_name FROM system_schema.keyspaces WHERE keyspace_name = ?', [keyspace], opts);
    if (ks.rowLength === 0) throw new Error(`Keyspace ${keyspace} không tồn tại. Migration không tạo keyspace.`);

    log(`Keyspace: ${keyspace}${dryRun ? '   [DRY RUN — chỉ đọc, không ghi]' : ''}`);
    const result = { created: [], skipped: [], added: [], mismatches: [], backfill: {} };

    // GIAI DOAN KIEM TRA (chi doc): xac dinh toan bo hanh dong TRUOC khi ghi bat cu thu gi.
    const actions = [];
    log('\n(1) Bảng mới');
    for (const { stmt, def } of plan.creates) {
        const cols = await tableCols(def.table);
        if (cols.length === 0) {
            actions.push({ stmt, label: `tạo bảng ${def.table}`, kind: 'created', name: def.table });
            log(`  + ${dryRun ? 'sẽ tạo' : 'tạo'} bảng ${def.table}`);
            continue;
        }
        const problems = compareTable(def, cols);
        if (problems.length) {
            result.mismatches.push(...problems.map(p => `${def.table}: ${p}`));
            log(`  ! bảng ${def.table} ĐÃ CÓ nhưng khác thiết kế: ${problems.join('; ')}`);
        } else {
            result.skipped.push(def.table);
            log(`  = bảng ${def.table} đã có, đúng cấu trúc — bỏ qua`);
        }
    }

    log('\n(2) Cột mới trên bảng cũ');
    for (const a of plan.alters) {
        const cols = await tableCols(a.table);
        // Bang duoc tao trong CUNG lan chay (migration truoc) -> lenh ALTER chay sau lenh CREATE do.
        const createdNow = cols.length === 0 && actions.some(x => x.kind === 'created' && x.name === a.table);
        if (createdNow) {
            actions.push({ stmt: a.stmt, label: `thêm cột ${a.table}.${a.column} ${a.type}`, kind: 'added', name: `${a.table}.${a.column}` });
            log(`  + ${dryRun ? 'sẽ thêm' : 'thêm'} cột ${a.table}.${a.column} ${a.type}  (bảng tạo trong lần chạy này)`);
            continue;
        }
        if (cols.length === 0) {
            result.mismatches.push(`${a.table}: bảng không tồn tại, không thể thêm cột ${a.column}`);
            log(`  ! bảng ${a.table} không tồn tại`);
            continue;
        }
        const existing = cols.find(c => c.column_name === a.column);
        if (!existing) {
            actions.push({ stmt: a.stmt, label: `thêm cột ${a.table}.${a.column} ${a.type}`, kind: 'added', name: `${a.table}.${a.column}` });
            log(`  + ${dryRun ? 'sẽ thêm' : 'thêm'} cột ${a.table}.${a.column} ${a.type}  (dòng cũ = null)`);
        } else if (existing.type !== a.type) {
            result.mismatches.push(`${a.table}.${a.column}: đã có kiểu ${existing.type}, thiết kế ${a.type}`);
            log(`  ! ${a.table}.${a.column} đã có nhưng kiểu ${existing.type} ≠ ${a.type}`);
        } else {
            result.skipped.push(`${a.table}.${a.column}`);
            log(`  = cột ${a.table}.${a.column} đã có — bỏ qua`);
        }
    }

    if (result.mismatches.length) {
        throw Object.assign(new Error(
            'Schema hiện có khác thiết kế, migration dừng lại TRƯỚC KHI ghi bất cứ thứ gì:\n  - ' + result.mismatches.join('\n  - ')
        ), { result });
    }

    // GIAI DOAN THUC HIEN: DDL theo dung thu tu (bang moi truoc, cot moi sau).
    for (const action of actions) {
        await write(action.stmt, [], ddlOpts);
        result[action.kind].push(action.name);
        if (!dryRun) log(`  ✓ ${action.label}`);
    }

    // Dam bao moi node (o day: 1 node) da thay schema moi truoc khi ghi vao bang vua tao.
    if (!dryRun && actions.length > 0) {
        const agreed = await client.metadata?.checkSchemaAgreement?.();
        if (agreed === false) throw new Error('Schema chưa đồng bộ giữa các node; dừng trước backfill. Chạy lại migration sau ít giây.');
    }

    // (3) Backfill - chi doc bang cu, chi ghi vao bang moi
    log('\n(3) Backfill (chỉ ghi vào bảng mới)');
    // Bang da ton tai truoc lan chay nay -> doc duoc de chi ghi phan con thieu.
    const readable = table => !dryRun || result.skipped.includes(table);
    result.backfill.direct = await backfillDirect(client, keyspace, write, dryRun, log, opts, readable('direct_conversations'));
    result.backfill.nameTokens = await backfillNameTokens(client, write, log, opts, readable('users_by_name_token'));
    // 005: chi chay khi bang posts DA ton tai (doc bai cu) va bang dich da / se duoc tao.
    const has = async table => (await tableCols(table)).length > 0 || result.created.includes(table);
    // 006: chi muc tim kiem + thong ke tu du lieu cu (chi khi cac bang dich da / se ton tai).
    if (await has('message_terms_by_conversation') && (await has('conversation_daily_stats'))) {
        result.backfill.searchStats = await backfillSearchAndStats(client, write, log, opts, {
            readIndex: readable('message_terms_by_conversation'),
            readStats: readable('conversation_daily_stats'),
            hasAttachments: (await tableCols('attachments_by_conversation')).length > 0
        });
    }
    // 007: chi muc luong binh luan tu post_comments cu.
    if (await has('root_comments_by_post') && (await has('comment_replies_by_root')) && (await tableCols('post_comments')).length > 0) {
        const commentCols = (await tableCols('post_comments')).map(c => c.column_name);
        result.backfill.commentThreads = await backfillCommentThreads(client, write, log, opts, {
            readRoots: readable('root_comments_by_post'), readReplies: readable('comment_replies_by_root'),
            hasReplyCol: commentCols.includes('reply_to_comment_id'), hasRootCol: commentCols.includes('root_comment_id')
        });
    }
    if (await has('user_social_stats') && (await tableCols('posts')).length > 0) {
        const exists = async t => (await tableCols(t)).length > 0;
        result.backfill.socialStats = await backfillSocialStats(client, write, log, opts, readable('user_social_stats'), {
            comments: await exists('post_comments'), reactions: await exists('post_reactions'), shares: await exists('post_shares')
        });
    }
    if (await has('posts') && (await has('public_posts_by_month')) && (await has('post_shares'))) {
        const postsReadable = (await tableCols('posts')).length > 0;
        result.backfill.publicFeed = postsReadable
            ? await backfillPublicFeed(client, write, log, opts, readable('public_posts_by_month'), readable('post_shares'))
            : { posts: 0, publicRows: 0, shareRows: 0, existing: 0 };
    }

    // (4) Kiem tra lai sau khi ap dung
    if (!dryRun) {
        await client.metadata?.checkSchemaAgreement?.();
        const after = [];
        for (const { def } of plan.creates) after.push(...compareTable(def, await tableCols(def.table)).map(p => `${def.table}: ${p}`));
        for (const a of plan.alters) {
            const c = (await tableCols(a.table)).find(col => col.column_name === a.column);
            if (!c || c.type !== a.type) after.push(`${a.table}.${a.column} chưa đúng sau migration`);
        }
        if (after.length) throw new Error('Kiểm tra sau migration thất bại:\n  - ' + after.join('\n  - '));
        log('\n(4) Kiểm tra lại cấu trúc sau migration: khớp thiết kế');
    }

    result.writeStatements = writes.length;
    result.executedWrites = dryRun ? 0 : writes.length;
    log(`\n${dryRun ? 'DRY RUN: kế hoạch có' : 'Đã thực thi'} ${writes.length} lệnh ghi`
        + `${dryRun ? ' (không lệnh nào được gửi tới Cassandra)' : ''}. Không có lệnh xóa dữ liệu.`);
    return result;
}

function compareTable(def, cols) {
    const problems = [];
    const byName = Object.fromEntries(cols.map(c => [c.column_name, c]));
    for (const [name, type] of Object.entries(def.columns)) {
        if (!byName[name]) problems.push(`thiếu cột ${name}`);
        else if (byName[name].type !== type) problems.push(`cột ${name} kiểu ${byName[name].type} ≠ ${type}`);
    }
    const pk = cols.filter(c => c.kind === 'partition_key').sort((a, b) => a.position - b.position).map(c => c.column_name);
    const ck = cols.filter(c => c.kind === 'clustering').sort((a, b) => a.position - b.position)
        .map(c => [c.column_name, String(c.clustering_order).toUpperCase()]);
    if (pk.join(',') !== def.partitionKey.join(',')) problems.push(`partition key (${pk}) ≠ (${def.partitionKey})`);
    if (JSON.stringify(ck) !== JSON.stringify(def.clustering)) problems.push(`clustering ${JSON.stringify(ck)} ≠ ${JSON.stringify(def.clustering)}`);
    return problems;
}

// Hoi thoai 1-1 cu -> direct_conversations. Dung CHUNG ham pairKey voi backend
// (sap xep 2 user_id, noi '|') nen A-B va B-A ra cung mot khoa.
// INSERT ... IF NOT EXISTS: neu hai hoi thoai cu cung mot cap, giu cai ghi truoc va bao lai.
async function backfillDirect(client, keyspace, write, dryRun, log, opts, canRead) {
    const stats = { candidates: 0, inserted: 0, alreadyMapped: 0, planned: 0, duplicatePairs: [] };
    const seen = new Map();
    let pageState;
    do {
        const rs = await client.execute(
            'SELECT conversation_id, conversation_type, participant_ids, created_at FROM conversations',
            [], { ...opts, fetchSize: 200, pageState });
        for (const row of rs.rows) {
            const members = [...(row.participant_ids || [])];
            if (row.conversation_type !== 'DIRECT' || members.length !== 2) continue;
            const key = pairKey(members[0], members[1]);
            const cid = row.conversation_id.toString();
            stats.candidates += 1;
            if (seen.has(key)) {
                stats.duplicatePairs.push(`${key}: ${seen.get(key)} và ${cid}`);
                continue;
            }
            seen.set(key, cid);
            // Doc truoc: cap da co -> khong ghi lai (chay lai migration = 0 lenh ghi).
            if (canRead) {
                const existing = (await client.execute(
                    'SELECT conversation_id FROM direct_conversations WHERE pair_key = ?', [key], opts)).first();
                if (existing) {
                    if (existing.conversation_id.toString() === cid) stats.alreadyMapped += 1;
                    else stats.duplicatePairs.push(`${key}: đã trỏ tới ${existing.conversation_id} (giữ nguyên), bỏ qua ${cid}`);
                    continue;
                }
            }
            stats.planned += 1;
            const res = await write(
                'INSERT INTO direct_conversations (pair_key, conversation_id, created_at) VALUES (?, ?, ?) IF NOT EXISTS',
                [key, row.conversation_id, row.created_at || new Date(0)]);
            if (dryRun) continue;
            if (res.wasApplied()) stats.inserted += 1;
            else if (res.first().conversation_id.toString() === cid) stats.alreadyMapped += 1;
            else stats.duplicatePairs.push(`${key}: đã trỏ tới ${res.first().conversation_id} (giữ nguyên), bỏ qua ${cid}`);
        }
        pageState = rs.pageState;
    } while (pageState);
    log(`  direct_conversations: ${stats.candidates} hội thoại 1-1`
        + (dryRun ? ` -> sẽ ghi ${stats.planned} dòng (IF NOT EXISTS), đã có ${stats.alreadyMapped}`
            : ` -> mới ${stats.inserted}, đã có ${stats.alreadyMapped}`));
    stats.duplicatePairs.forEach(d => log(`  ! cặp trùng: ${d}`));
    return stats;
}

// Token ten cua moi user -> users_by_name_token. Khoa (token_prefix, name_token, user_id)
// tat dinh tu ten hien tai nen ghi lai nhieu lan cho cung ket qua (idempotent).
// Bai cong khai cu -> public_posts_by_month; bai chia se cu -> post_shares (kind FEED).
// Chi DOC posts; chi GHI 2 bang moi; doc truoc khi ghi -> chay lai = 0 lenh ghi.
async function backfillPublicFeed(client, write, log, opts, canReadFeed, canReadShares) {
    const { bucketOf } = require('../src/utils/postTime');
    const stats = { posts: 0, publicRows: 0, shareRows: 0, existing: 0 };
    let pageState;
    do {
        const rs = await client.execute(
            'SELECT post_id, author_id, privacy, shared_post_id, is_deleted FROM posts', [], { ...opts, fetchSize: 200, pageState });
        for (const p of rs.rows) {
            stats.posts += 1;
            if (p.is_deleted) continue;
            if (p.privacy === 'PUBLIC') {
                const bucket = bucketOf(p.post_id);
                const have = canReadFeed && (await client.execute(
                    'SELECT post_id FROM public_posts_by_month WHERE bucket = ? AND post_id = ?', [bucket, p.post_id], opts)).first();
                if (have) stats.existing += 1;
                else {
                    await write('INSERT INTO public_posts_by_month (bucket, post_id, author_id) VALUES (?, ?, ?)', [bucket, p.post_id, p.author_id]);
                    stats.publicRows += 1;
                }
            }
            if (p.shared_post_id) {
                const have = canReadShares && (await client.execute(
                    'SELECT share_id FROM post_shares WHERE post_id = ? AND share_id = ?', [p.shared_post_id, p.post_id], opts)).first();
                if (have) stats.existing += 1;
                else {
                    await write("INSERT INTO post_shares (post_id, share_id, user_id, kind) VALUES (?, ?, ?, 'FEED')",
                        [p.shared_post_id, p.post_id, p.author_id]);
                    stats.shareRows += 1;
                }
            }
        }
        pageState = rs.pageState;
    } while (pageState);
    log(`  public_posts_by_month / post_shares: ${stats.posts} bài -> ghi ${stats.publicRows} bài công khai, ${stats.shareRows} lượt chia sẻ, đã có ${stats.existing}`);
    return stats;
}

// Counter: chi cong PHAN CHENH LECH (ky vong tu nguon - gia tri hien co) -> chay lai = 0 lenh ghi.
async function syncCounter(client, write, opts, canRead, { table, keyCols, keyVals, col, expected }) {
    const where = keyCols.map(c => `${c} = ?`).join(' AND ');
    let current = 0;
    if (canRead) {
        const row = (await client.execute(`SELECT ${col} FROM ${table} WHERE ${where}`, keyVals, opts)).first();
        current = row && row[col] != null ? Number(row[col].toString()) : 0;
    }
    const delta = expected - current;
    if (delta === 0) return 0;
    await write(`UPDATE ${table} SET ${col} = ${col} ${delta > 0 ? '+' : '-'} ? WHERE ${where}`, [Math.abs(delta), ...keyVals]);
    return 1;
}

// Tin cu -> message_terms_by_conversation + 4 bang thong ke. Duyet hoi thoai trong bang conversations
// (bang nho, chi lenh quan tri), moi hoi thoai doc partition tin theo trang 500 dong.
async function backfillSearchAndStats(client, write, log, opts, { readIndex, readStats, hasAttachments }) {
    const { termsOf, localParts } = require('../src/utils/searchTerms');
    const stats = { conversations: 0, messages: 0, indexRows: 0, indexExisting: 0, counterWrites: 0 };
    let convState;
    do {
        const convs = await client.execute('SELECT conversation_id FROM conversations', [], { ...opts, fetchSize: 100, pageState: convState });
        for (const { conversation_id: cid } of convs.rows) {
            stats.conversations += 1;
            const daily = new Map(); const hourly = new Map(); const types = new Map(); const senders = new Map();
            const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
            let pageState;
            do {
                const rs = await client.execute(
                    `SELECT created_at, message_id, sender_id, content, message_type, is_deleted, attachment_ids
                     FROM messages_by_conversation WHERE conversation_id = ?`, [cid], { ...opts, fetchSize: 500, pageState });
                for (const m of rs.rows) {
                    stats.messages += 1;
                    const { day, hour } = localParts(m.created_at);
                    inc(daily, day); inc(hourly, hour); inc(types, m.message_type || 'TEXT'); inc(senders, m.sender_id);
                    if (m.is_deleted || m.message_type === 'SYSTEM') continue;
                    let names = [];
                    const att = [...(m.attachment_ids || [])];
                    if (hasAttachments && att.length) {
                        for (const aid of att) {
                            const a = (await client.execute('SELECT file_name FROM attachments_by_conversation WHERE conversation_id = ? AND attachment_id = ?',
                                [cid, aid], opts)).first();
                            if (a) names.push(a.file_name);
                        }
                    }
                    for (const term of termsOf(m.content, ...names)) {
                        if (readIndex) {
                            const have = (await client.execute(
                                'SELECT message_id FROM message_terms_by_conversation WHERE conversation_id = ? AND term = ? AND created_at = ? AND message_id = ?',
                                [cid, term, m.created_at, m.message_id], opts)).first();
                            if (have) { stats.indexExisting += 1; continue; }
                        }
                        await write('INSERT INTO message_terms_by_conversation (conversation_id, term, created_at, message_id) VALUES (?, ?, ?, ?)',
                            [cid, term, m.created_at, m.message_id]);
                        stats.indexRows += 1;
                    }
                }
                pageState = rs.pageState;
            } while (pageState);
            const sync = (table, keyCol, map) => Promise.all([...map].map(([k, n]) => syncCounter(client, write, opts, readStats,
                { table, keyCols: ['conversation_id', keyCol], keyVals: [cid, k], col: 'messages', expected: n })));
            for (const done of [await sync('conversation_daily_stats', 'day', daily), await sync('conversation_hourly_stats', 'hour', hourly),
                await sync('conversation_type_stats', 'message_type', types), await sync('conversation_sender_stats', 'sender_id', senders)]) {
                stats.counterWrites += done.reduce((a, b) => a + b, 0);
            }
        }
        convState = convs.pageState;
    } while (convState);
    log(`  tìm kiếm / thống kê: ${stats.conversations} hội thoại, ${stats.messages} tin -> ghi ${stats.indexRows} dòng chỉ mục`
        + ` (đã có ${stats.indexExisting}), ${stats.counterWrites} lệnh cập nhật bộ đếm`);
    return stats;
}

// Binh luan cu -> root_comments_by_post / comment_replies_by_root. Goc = theo chuoi reply_to_comment_id.
// Chi DOC posts + post_comments; doc truoc khi ghi -> chay lai = 0 lenh ghi. Binh luan da xoa van vao chi muc
// (de phan hoi cua no van hien duoi placeholder "Bình luận đã bị xóa").
async function backfillCommentThreads(client, write, log, opts, { readRoots, readReplies, hasReplyCol, hasRootCol }) {
    const stats = { posts: 0, comments: 0, rootRows: 0, replyRows: 0, existing: 0 };
    const cols = ['comment_id', hasReplyCol ? 'reply_to_comment_id' : null, hasRootCol ? 'root_comment_id' : null].filter(Boolean).join(', ');
    let pageState;
    do {
        const posts = await client.execute('SELECT post_id FROM posts', [], { ...opts, fetchSize: 200, pageState });
        for (const { post_id: pid } of posts.rows) {
            stats.posts += 1;
            const rows = (await client.execute(`SELECT ${cols} FROM post_comments WHERE post_id = ?`, [pid], { ...opts, fetchSize: 5000 })).rows;
            const byId = new Map(rows.map(r => [r.comment_id.toString(), r]));
            const rootOf = r => {
                let cur = r;
                for (let hop = 0; hop < 20; hop++) {
                    if (cur.root_comment_id) return cur.root_comment_id;
                    const parent = cur.reply_to_comment_id && byId.get(cur.reply_to_comment_id.toString());
                    if (!parent) return cur.reply_to_comment_id ? cur.reply_to_comment_id : cur.comment_id;
                    cur = parent;
                }
                return cur.comment_id;
            };
            for (const r of rows) {
                stats.comments += 1;
                const isReply = Boolean(r.reply_to_comment_id);
                if (!isReply) {
                    if (readRoots && (await client.execute('SELECT comment_id FROM root_comments_by_post WHERE post_id = ? AND comment_id = ?', [pid, r.comment_id], opts)).first()) { stats.existing += 1; continue; }
                    await write('INSERT INTO root_comments_by_post (post_id, comment_id) VALUES (?, ?)', [pid, r.comment_id]);
                    stats.rootRows += 1;
                } else {
                    const root = rootOf(r);
                    if (readReplies && (await client.execute('SELECT comment_id FROM comment_replies_by_root WHERE post_id = ? AND root_comment_id = ? AND comment_id = ?', [pid, root, r.comment_id], opts)).first()) { stats.existing += 1; continue; }
                    await write('INSERT INTO comment_replies_by_root (post_id, root_comment_id, comment_id) VALUES (?, ?, ?)', [pid, root, r.comment_id]);
                    stats.replyRows += 1;
                }
            }
        }
        pageState = posts.pageState;
    } while (pageState);
    log(`  luồng bình luận: ${stats.posts} bài, ${stats.comments} bình luận -> ghi ${stats.rootRows} gốc, ${stats.replyRows} phản hồi, đã có ${stats.existing}`);
    return stats;
}

// Thong ke mang xa hoi theo nguoi dung, tinh tu posts / post_comments / post_reactions / post_shares.
async function backfillSocialStats(client, write, log, opts, canRead, src = { comments: true, reactions: true, shares: true }) {
    const per = new Map();
    const add = (u, metric, n = 1) => {
        if (!u) return;
        if (!per.has(u)) per.set(u, { posts: 0, comments_made: 0, comments_received: 0, reactions_made: 0, reactions_received: 0, shares_received: 0 });
        per.get(u)[metric] += n;
    };
    let pageState;
    let posts = 0;
    do {
        const rs = await client.execute('SELECT post_id, author_id, shared_post_id, is_deleted FROM posts', [], { ...opts, fetchSize: 200, pageState });
        for (const p of rs.rows) {
            if (p.is_deleted) continue;
            posts += 1;
            if (!p.shared_post_id) add(p.author_id, 'posts');
            const empty = { rows: [] };
            const comments = src.comments ? await client.execute('SELECT author_id, is_deleted FROM post_comments WHERE post_id = ?', [p.post_id], { ...opts, fetchSize: 5000 }) : empty;
            for (const c of comments.rows) {
                if (c.is_deleted) continue;
                add(c.author_id, 'comments_made');
                if (c.author_id !== p.author_id) add(p.author_id, 'comments_received');
            }
            const reactions = src.reactions ? await client.execute('SELECT user_id FROM post_reactions WHERE post_id = ?', [p.post_id], { ...opts, fetchSize: 5000 }) : empty;
            for (const r of reactions.rows) {
                add(r.user_id, 'reactions_made');
                if (r.user_id !== p.author_id) add(p.author_id, 'reactions_received');
            }
            const shares = src.shares ? await client.execute('SELECT user_id FROM post_shares WHERE post_id = ?', [p.post_id], { ...opts, fetchSize: 5000 }) : empty;
            for (const sh of shares.rows) if (sh.user_id !== p.author_id) add(p.author_id, 'shares_received');
        }
        pageState = rs.pageState;
    } while (pageState);
    let writes = 0;
    for (const [userId, metrics] of per) {
        for (const [metric, n] of Object.entries(metrics)) {
            writes += await syncCounter(client, write, opts, canRead,
                { table: 'user_social_stats', keyCols: ['user_id', 'metric'], keyVals: [userId, metric], col: 'amount', expected: n });
        }
    }
    log(`  thống kê mạng xã hội: ${posts} bài, ${per.size} người dùng -> ${writes} lệnh cập nhật bộ đếm`);
    return { posts, users: per.size, counterWrites: writes };
}

async function backfillNameTokens(client, write, log, opts, canRead) {
    const stats = { users: 0, rows: 0, existing: 0, usersWithoutTokens: [] };
    let pageState;
    do {
        const rs = await client.execute(
            'SELECT user_id, display_name, avatar_url FROM users', [], { ...opts, fetchSize: 200, pageState });
        for (const u of rs.rows) {
            stats.users += 1;
            const tokens = nameTokens(u.display_name);
            if (tokens.length === 0) stats.usersWithoutTokens.push(u.user_id);
            for (const token of tokens) {
                if (canRead) {
                    const row = (await client.execute(
                        'SELECT display_name FROM users_by_name_token WHERE token_prefix = ? AND name_token = ? AND user_id = ?',
                        [tokenBucket(token), token, u.user_id], opts)).first();
                    if (row && row.display_name === u.display_name) { stats.existing += 1; continue; }
                }
                await write(
                    `INSERT INTO users_by_name_token (token_prefix, name_token, user_id, display_name, avatar_url)
                     VALUES (?, ?, ?, ?, ?)`,
                    [tokenBucket(token), token, u.user_id, u.display_name, u.avatar_url || null]);
                stats.rows += 1;
            }
        }
        pageState = rs.pageState;
    } while (pageState);
    log(`  users_by_name_token: ${stats.users} người dùng -> ghi ${stats.rows} dòng token, đã có ${stats.existing}`);
    if (stats.usersWithoutTokens.length) log(`  ! không có token tìm được: ${stats.usersWithoutTokens.join(', ')}`);
    return stats;
}

async function main() {
    const client = require('../src/config/cassandra');
    const dryRun = process.argv.includes('--dry-run');
    try {
        await client.connect();
        await runMigration(client, { keyspace: process.env.CASSANDRA_KEYSPACE || 'chat_ott', dryRun });
    } catch (error) {
        console.error('\nLỗi migration:', error.message);
        process.exitCode = 1;
    } finally {
        await client.shutdown().catch(() => {});
    }
}

if (require.main === module) main();

module.exports = { runMigration, parsePlan, parseCreate, statementsOf, compareTable, RESERVED };
