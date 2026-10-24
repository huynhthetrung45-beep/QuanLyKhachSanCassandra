// Cassandra gia lap trong bo nho, CHI dung cho kiem thu tu dong khi khong co Cassandra that.
// Doc luoc do tu schema.cql va mo phong cac quy tac quan trong cua Cassandra:
//  - WHERE phai co du partition key (=), clustering key theo dung tien to.
//  - Cam loc theo cot khong thuoc khoa, cam ALLOW FILTERING / OFFSET.
//  - Thu tu clustering (ASC/DESC), phan trang bang fetchSize + pageState mo.
//  - UPSERT, LWT (IF NOT EXISTS / IF cot = ?), TTL, set<text> (+ / -), LIMIT.
// Day KHONG thay the kiem thu tren Cassandra that (xem tests/integration.test.js).
const fs = require('fs');
const path = require('path');
const cassandra = require('cassandra-driver');

const { Uuid, TimeUuid } = cassandra.types;

class InvalidRequest extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResponseError';
    }
}

class NoHostAvailableError extends Error {
    constructor() {
        super('All host(s) tried for query failed');
        this.name = 'NoHostAvailableError';
    }
}

// Tu khoa DANH RIENG cua CQL (Cassandra docs, Appendix A - Reserved: yes).
// Khong duoc dung lam ten cot/bang neu khong dat trong dau ngoac kep.
// Vi du: cot ten "token" lam "SELECT token, ..." loi cu phap tren Cassandra that.
const RESERVED = new Set(('ADD ALLOW ALTER AND APPLY ASC AUTHORIZE BATCH BEGIN BY COLUMNFAMILY CREATE DELETE DESC '
    + 'DESCRIBE DROP ENTRIES EXECUTE FROM FULL GRANT IF IN INDEX INFINITY INSERT INTO IS KEYSPACE LIMIT '
    + 'MATERIALIZED MBEAN MBEANS MODIFY NAN NORECURSIVE NOT NULL OF ON OR ORDER PRIMARY RENAME REPLACE '
    + 'REVOKE SCHEMA SELECT SET TABLE TO TOKEN TRUNCATE UNLOGGED UPDATE USE USING VIEW WHERE WITH').split(' '));

function assertIdentifier(name, where) {
    if (RESERVED.has(String(name).toUpperCase())) {
        throw new InvalidRequest(`line 1: no viable alternative / syntax error: "${name}" là từ khóa CQL dành riêng (${where})`);
    }
}

function parseSchema(cql) {
    const tables = {};
    const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\)\s*(WITH CLUSTERING ORDER BY \(([\s\S]*?)\))?\s*;/gi;
    let match;
    while ((match = re.exec(cql))) {
        const [, name, body, , orderBody] = match;
        const columns = {};
        let partitionKey = [];
        let clustering = [];
        const lines = body.split('\n').map(l => l.replace(/--.*$/, '').trim()).filter(Boolean);
        for (const raw of lines) {
            const line = raw.replace(/,$/, '');
            const pk = line.match(/^PRIMARY KEY \(\((.*?)\)(?:,\s*(.*))?\)$/i);
            if (pk) {
                partitionKey = pk[1].split(',').map(s => s.trim().toLowerCase());
                clustering = pk[2] ? pk[2].split(',').map(s => s.trim().toLowerCase()) : [];
                continue;
            }
            const col = line.match(/^(\w+)\s+([\w<>]+)(\s+PRIMARY KEY)?$/i);
            if (col) {
                assertIdentifier(col[1], `CREATE TABLE ${name}`);
                columns[col[1].toLowerCase()] = col[2].toLowerCase();
                if (col[3]) partitionKey = [col[1].toLowerCase()];
            }
        }
        const order = {};
        clustering.forEach(c => (order[c] = 'asc'));
        if (orderBody) {
            orderBody.split(',').forEach(part => {
                const [c, dir] = part.trim().split(/\s+/);
                order[c.toLowerCase()] = dir.toLowerCase();
            });
        }
        tables[name.toLowerCase()] = { name, columns, partitionKey, clustering, order };
    }
    return tables;
}

// ---------- chuyen doi gia tri ----------
function normalize(type, value) {
    if (value === undefined || value === null) return null;
    switch (type) {
        case 'uuid':
        case 'timeuuid': {
            const s = value.toString().toLowerCase();
            if (!/^[0-9a-f-]{36}$/.test(s)) throw new InvalidRequest(`Invalid UUID: ${s}`);
            return s;
        }
        case 'timestamp': {
            const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
            if (Number.isNaN(t)) throw new InvalidRequest('Invalid timestamp');
            return t;
        }
        case 'boolean':
            return Boolean(value);
        case 'set<text>': {
            const arr = [...new Set([...(value instanceof Set ? value : value)].map(String))].sort();
            return arr.length ? arr : null;
        }
        // Them cho migration 010 (binh chon): list<text>, set<int>.
        case 'list<text>': {
            const arr = [...value].map(String);
            return arr.length ? arr : null;
        }
        case 'set<int>': {
            const arr = [...new Set([...value].map(Number))].sort((x, y) => x - y);
            return arr.length ? arr : null;
        }
        case 'list<uuid>':
        case 'list<timeuuid>': {
            const arr = [...value].map(v => v.toString().toLowerCase());
            return arr.length ? arr : null;
        }
        case 'bigint':
        case 'int':
        case 'counter':
            return Number(value);
        default:
            return String(value);
    }
}

function denormalize(type, value) {
    if (value === null || value === undefined) return null;
    switch (type) {
        case 'uuid': return Uuid.fromString(value);
        case 'timeuuid': return TimeUuid.fromString(value);
        case 'timestamp': return new Date(value);
        case 'set<text>': return [...value];
        case 'list<text>':
        case 'set<int>': return [...value];
        case 'list<uuid>': return value.map(v => Uuid.fromString(v));
        case 'list<timeuuid>': return value.map(v => TimeUuid.fromString(v));
        case 'counter': return require('cassandra-driver').types.Long.fromNumber(value);
        default: return value;
    }
}

function compare(type, a, b) {
    if (a === b) return 0;
    if (type === 'timestamp') return a - b;
    if (type === 'timeuuid') {
        const ta = TimeUuid.fromString(a).getDate().getTime();
        const tb = TimeUuid.fromString(b).getDate().getTime();
        if (ta !== tb) return ta - tb;
    }
    return a < b ? -1 : 1;
}

// ---------- tach cau lenh ----------
function splitTopLevel(text, sep = ',') {
    const out = [];
    let depth = 0, quote = false, cur = '';
    for (const ch of text) {
        if (ch === "'") quote = !quote;
        if (!quote && ch === '(') depth++;
        if (!quote && ch === ')') depth--;
        if (!quote && depth === 0 && ch === sep) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function makeBinder(params) {
    let i = 0;
    return token => {
        token = token.trim();
        if (token === '?') {
            if (i >= params.length) throw new InvalidRequest('Not enough bind parameters');
            return params[i++];
        }
        if (/^'.*'$/.test(token)) return token.slice(1, -1);
        if (/^(true|false)$/i.test(token)) return token.toLowerCase() === 'true';
        if (/^null$/i.test(token)) return null;
        if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
        if (/^[0-9a-f-]{36}$/i.test(token)) return token;
        throw new InvalidRequest(`Unsupported literal ${token}`);
    };
}

function parseConditions(text, bind) {
    if (!text) return [];
    return text.split(/\s+AND\s+/i).map(part => {
        const inMatch = part.trim().match(/^(\w+)\s+IN\s*\((.+)\)$/i);
        if (inMatch) {
            assertIdentifier(inMatch[1], 'WHERE IN');
            return { column: inMatch[1].toLowerCase(), op: 'IN', value: splitTopLevel(inMatch[2]).map(bind) };
        }
        const m = part.trim().match(/^(\w+)\s*(=|>=|<=|>|<)\s*(.+)$/);
        if (!m) throw new InvalidRequest(`Unsupported condition: ${part}`);
        assertIdentifier(m[1], 'WHERE/IF');
        return { column: m[1].toLowerCase(), op: m[2], value: bind(m[3]) };
    });
}

class ResultSet {
    constructor(rows = [], pageState = null) {
        this.rows = rows;
        this.rowLength = rows.length;
        this.pageState = pageState;
    }
    first() { return this.rows[0] || null; }
    wasApplied() {
        const row = this.rows[0];
        return row && Object.prototype.hasOwnProperty.call(row, '[applied]') ? row['[applied]'] : true;
    }
}

class FakeCassandra {
    constructor(schemaPath = path.resolve(__dirname, '../../schema.cql')) {
        this.tables = parseSchema(fs.readFileSync(schemaPath, 'utf8'));
        this.data = {};
        Object.keys(this.tables).forEach(t => (this.data[t] = new Map()));
        this.log = [];
        this.down = false;
        this.keyspace = 'chat_ott';
    }

    async connect() {}
    async shutdown() {}

    table(name) {
        const t = this.tables[name.toLowerCase()];
        if (!t) throw new InvalidRequest(`unconfigured table ${name}`);
        return t;
    }

    rowsOf(name) {
        const now = Date.now();
        const map = this.data[name.toLowerCase()];
        for (const [k, row] of map) if (row.__expires && row.__expires <= now) map.delete(k);
        return [...map.values()];
    }

    pkString(t, values) {
        return JSON.stringify([...t.partitionKey, ...t.clustering].map(c => values[c]));
    }

    // Kiem tra WHERE theo quy tac Cassandra, tra ve ham loc.
    checkWhere(t, conds, { requireFullKey }) {
        const byCol = {};
        for (const c of conds) {
            if (!(c.column in t.columns)) throw new InvalidRequest(`Undefined column ${c.column}`);
            if (!t.partitionKey.includes(c.column) && !t.clustering.includes(c.column)) {
                throw new InvalidRequest(
                    `Cannot execute this query as it might involve data filtering (non-key column ${c.column})`
                );
            }
            byCol[c.column] = c;
        }
        if (conds.length > 0 || requireFullKey) {
            for (const k of t.partitionKey) {
                if (!byCol[k] || !['=', 'IN'].includes(byCol[k].op)) {
                    throw new InvalidRequest(`Partition key ${k} must be restricted by =`);
                }
            }
        }
        let rangeSeen = false;
        t.clustering.forEach((c, idx) => {
            const cond = byCol[c];
            if (!cond) {
                if (t.clustering.slice(idx + 1).some(next => byCol[next])) {
                    throw new InvalidRequest(`Clustering column ${c} cannot be skipped`);
                }
                if (requireFullKey) throw new InvalidRequest(`Missing clustering column ${c}`);
                return;
            }
            if (rangeSeen) throw new InvalidRequest('Clustering after range restriction');
            if (!['=', 'IN'].includes(cond.op)) rangeSeen = true;
        });
        return row => conds.every(c => {
            const type = t.columns[c.column];
            if (c.op === 'IN') return c.value.map(v => normalize(type, v)).includes(row[c.column]);
            const v = normalize(type, c.value);
            const r = row[c.column];
            const cmp = compare(type, r, v);
            switch (c.op) {
                case '=': return r === v;
                case '>': return cmp > 0;
                case '<': return cmp < 0;
                case '>=': return cmp >= 0;
                case '<=': return cmp <= 0;
                default: return false;
            }
        });
    }

    sortRows(t, rows) {
        return rows.sort((a, b) => {
            const pa = JSON.stringify(t.partitionKey.map(c => a[c]));
            const pb = JSON.stringify(t.partitionKey.map(c => b[c]));
            if (pa !== pb) return pa < pb ? -1 : 1;
            for (const c of t.clustering) {
                const cmp = compare(t.columns[c], a[c], b[c]);
                if (cmp !== 0) return t.order[c] === 'desc' ? -cmp : cmp;
            }
            return 0;
        });
    }

    output(t, row, columns) {
        const out = {};
        for (const c of columns) out[c] = denormalize(t.columns[c], row[c] ?? null);
        return out;
    }

    async execute(query, params = [], options = {}) {
        if (this.down) throw new NoHostAvailableError();
        const q = query.replace(/\s+/g, ' ').trim().replace(/;$/, '');
        this.log.push({ query: q, params, options });
        // Tuy chon: ghi moi cau CQL nhan duoc ra file de kiem tra cu phap bang grammar cqlsh.
        if (process.env.CQL_CAPTURE_FILE) require('fs').appendFileSync(process.env.CQL_CAPTURE_FILE, q + '\n');
        if (/ALLOW FILTERING/i.test(q)) throw new InvalidRequest('ALLOW FILTERING bị cấm trong đồ án');
        if (/\bOFFSET\b/i.test(q)) throw new InvalidRequest('Cassandra không hỗ trợ OFFSET');
        const bind = makeBinder(params);

        if (/^SELECT/i.test(q)) return this.select(q, bind, options);
        if (/^INSERT/i.test(q)) return this.insert(q, bind);
        if (/^UPDATE/i.test(q)) return this.update(q, bind);
        if (/^DELETE/i.test(q)) return this.remove(q, bind);
        if (/^(CREATE|ALTER)/i.test(q)) return new ResultSet();
        throw new InvalidRequest(`Unsupported statement: ${q}`);
    }

    async batch(queries) {
        if (this.down) throw new NoHostAvailableError();
        for (const item of queries) await this.execute(item.query, item.params || []);
        return new ResultSet();
    }

    select(q, bind, options) {
        const m = q.match(/^SELECT (.+?) FROM ([\w.]+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\S+))?$/i);
        if (!m) throw new InvalidRequest(`Unsupported SELECT: ${q}`);
        const [, colText, tableName, whereText, orderText, limitRaw] = m;

        if (tableName.toLowerCase() === 'system_schema.tables') {
            bind('?');
            return new ResultSet(Object.keys(this.tables).map(name => ({ table_name: name })));
        }
        if (tableName.toLowerCase() === 'system_schema.columns') {
            const conds = parseConditions(whereText, bind);
            const tableCond = conds.find(c => c.column === 'table_name');
            const t = tableCond ? this.tables[String(tableCond.value).toLowerCase()] : null;
            if (!t) return new ResultSet([]);
            return new ResultSet(Object.entries(t.columns).map(([name, type]) => ({
                column_name: name,
                type,
                kind: t.partitionKey.includes(name) ? 'partition_key' : t.clustering.includes(name) ? 'clustering' : 'regular',
                position: t.partitionKey.includes(name) ? t.partitionKey.indexOf(name) : t.clustering.indexOf(name),
                clustering_order: t.clustering.includes(name) ? t.order[name] : 'none'
            })));
        }
        if (tableName.toLowerCase() === 'system_schema.keyspaces') {
            return new ResultSet([{ keyspace_name: this.keyspace }]);
        }

        const t = this.table(tableName);
        const conds = parseConditions(whereText, bind);
        const filter = this.checkWhere(t, conds, { requireFullKey: false });
        let rows = this.sortRows(t, this.rowsOf(t.name).filter(filter));
        const limitText = limitRaw ? String(bind(limitRaw)) : null;
        if (orderText) {
            // Nhu Cassandra: chi ORDER BY theo cot clustering (dung thu tu), partition key phai co '='; dao chieu toan bo.
            const parts = orderText.split(',').map(x => x.trim().split(/\s+/));
            parts.forEach(([col], i) => {
                if (t.clustering[i] !== col.toLowerCase()) throw new InvalidRequest(`Order by currently only supports the ordering of columns following their declared order`);
            });
            if (!t.partitionKey.every(k => conds.some(c => c.column === k && c.op === '='))) {
                throw new InvalidRequest('ORDER BY is only supported when the partition key is restricted by an EQ or an IN.');
            }
            const dirs = parts.map(([col, d]) => ((d || 'ASC').toLowerCase() === t.order[col.toLowerCase()] ? 1 : -1));
            if (dirs.some(d => d !== dirs[0])) throw new InvalidRequest('Unsupported order by relation');
            if (dirs[0] === -1) rows = rows.reverse();
        }

        if (/^COUNT\(\*\)/i.test(colText.trim())) {
            const alias = (colText.match(/AS (\w+)/i) || [, 'count'])[1];
            return new ResultSet([{ [alias]: rows.length }]);
        }

        if (limitText) rows = rows.slice(0, Number(limitText));
        const columns = colText.trim() === '*'
            ? Object.keys(t.columns)
            : splitTopLevel(colText).map(c => c.toLowerCase());
        for (const c of columns) {
            assertIdentifier(c, 'SELECT');
            if (!(c in t.columns)) throw new InvalidRequest(`Undefined column ${c}`);
        }

        const fetchSize = options.fetchSize || 5000;
        // Nhu Cassandra that: pageState ghi KHOA cua dong cuoi da tra ve (khong phai offset),
        // nen tin moi chen vao dau partition khong lam lech cac trang sau.
        let offset = 0;
        if (options.pageState) {
            let state;
            try {
                state = JSON.parse(Buffer.from(String(options.pageState), 'hex').toString('utf8'));
                if (state.q !== q) throw new Error('mismatch');
            } catch {
                throw new InvalidRequest('Invalid value for the paging state');
            }
            const idx = rows.findIndex(row => this.pkString(t, row) === state.lastKey);
            offset = idx >= 0 ? idx + 1 : rows.length;
        }
        const page = rows.slice(offset, offset + fetchSize);
        // Giong Cassandra that: trang day du (== fetchSize) luon kem pageState,
        // ke ca khi khong con dong nao (trang ke tiep se rong).
        const pageState = page.length === fetchSize
            ? Buffer.from(JSON.stringify({ q, lastKey: this.pkString(t, page[page.length - 1]) })).toString('hex')
            : null;
        return new ResultSet(page.map(row => this.output(t, row, columns)), pageState);
    }

    insert(q, bind) {
        const m = q.match(/^INSERT INTO (\w+) \((.+?)\) VALUES \((.+?)\)( IF NOT EXISTS)?(?: USING TTL (\S+))?$/i);
        if (!m) throw new InvalidRequest(`Unsupported INSERT: ${q}`);
        const [, tableName, colText, valText, ifNotExists, ttlText] = m;
        const t = this.table(tableName);
        const cols = colText.split(',').map(c => c.trim().toLowerCase());
        cols.forEach(c => assertIdentifier(c, 'INSERT'));
        const vals = splitTopLevel(valText).map(bind);
        const ttl = ttlText ? Number(bind(ttlText)) : 0;
        const row = {};
        cols.forEach((c, i) => {
            if (!(c in t.columns)) throw new InvalidRequest(`Undefined column ${c}`);
            row[c] = normalize(t.columns[c], vals[i]);
        });
        for (const k of [...t.partitionKey, ...t.clustering]) {
            if (row[k] === null || row[k] === undefined) throw new InvalidRequest(`Missing key ${k}`);
        }
        const key = this.pkString(t, row);
        const map = this.data[t.name.toLowerCase()];
        this.rowsOf(t.name);
        const existing = map.get(key);
        if (ifNotExists) {
            if (existing) {
                return new ResultSet([{ '[applied]': false, ...this.output(t, existing, Object.keys(t.columns)) }]);
            }
            map.set(key, { ...row, __expires: ttl ? Date.now() + ttl * 1000 : null });
            return new ResultSet([{ '[applied]': true }]);
        }
        map.set(key, { ...(existing || {}), ...row, __expires: ttl ? Date.now() + ttl * 1000 : null });
        return new ResultSet();
    }

    update(q, bind) {
        const m = q.match(/^UPDATE (\w+)(?: USING TTL (\S+))? SET (.+?) WHERE (.+?)(?: IF (.+))?$/i);
        if (!m) throw new InvalidRequest(`Unsupported UPDATE: ${q}`);
        const [, tableName, ttlText, setText, whereText, ifText] = m;
        const t = this.table(tableName);
        if (ttlText) bind(ttlText);
        const assignments = splitTopLevel(setText).map(part => {
            const am = part.match(/^(\w+)\s*=\s*(?:(\w+)\s*([+-])\s*)?(.+)$/);
            if (!am) throw new InvalidRequest(`Unsupported SET ${part}`);
            return { column: am[1].toLowerCase(), op: am[3] || null, value: bind(am[4]) };
        });
        const conds = parseConditions(whereText, bind);
        this.checkWhere(t, conds, { requireFullKey: true });
        const keyValues = {};
        conds.forEach(c => (keyValues[c.column] = normalize(t.columns[c.column], c.value)));
        const key = this.pkString(t, keyValues);
        const map = this.data[t.name.toLowerCase()];
        this.rowsOf(t.name);
        const current = map.get(key);
        if (ifText) {
            // LWT: UPDATE ... IF EXISTS | IF col = ? AND col = ?
            const ifConds = /^EXISTS$/i.test(ifText.trim()) ? [] : parseConditions(ifText, bind);
            const ok = current && ifConds.every(c => current[c.column] === normalize(t.columns[c.column], c.value));
            if (!ok) {
                return new ResultSet([{
                    '[applied]': false,
                    ...(current ? this.output(t, current, ifConds.map(c => c.column).concat(t.partitionKey)) : {})
                }]);
            }
        }
        const row = { ...(current || keyValues) };
        for (const a of assignments) {
            if (t.partitionKey.includes(a.column) || t.clustering.includes(a.column)) {
                throw new InvalidRequest(`PRIMARY KEY part ${a.column} found in SET part`);
            }
            const type = t.columns[a.column];
            if (!type) throw new InvalidRequest(`Undefined column ${a.column}`);
            if (a.op && type === 'counter') {
                row[a.column] = (row[a.column] || 0) + (a.op === '+' ? 1 : -1) * Number(a.value);
            } else if (a.op) {
                const current = new Set(row[a.column] || []);
                const delta = normalize(type, a.value) || [];
                delta.forEach(v => (a.op === '+' ? current.add(v) : current.delete(v)));
                row[a.column] = normalize(type, [...current]);
            } else {
                row[a.column] = normalize(type, a.value);
            }
        }
        map.set(key, row);
        return new ResultSet(ifText ? [{ '[applied]': true }] : []);
    }

    remove(q, bind) {
        const m = q.match(/^DELETE FROM (\w+) WHERE (.+?)(?: IF (.+))?$/i);
        if (!m) throw new InvalidRequest(`Unsupported DELETE: ${q}`);
        const [, tableName, whereText, ifText] = m;
        const t = this.table(tableName);
        const conds = parseConditions(whereText, bind);
        const filter = this.checkWhere(t, conds, { requireFullKey: true });
        const ifExists = Boolean(ifText) && /^EXISTS$/i.test(ifText.trim());
        const ifConds = ifText && !ifExists ? parseConditions(ifText, bind) : [];
        const map = this.data[t.name.toLowerCase()];
        this.rowsOf(t.name);
        let matched = 0;
        for (const [key, row] of map) {
            if (!filter(row)) continue;
            matched += 1;
            if (ifConds.some(c => row[c.column] !== normalize(t.columns[c.column], c.value))) {
                return new ResultSet([{ '[applied]': false }]);
            }
            map.delete(key);
        }
        // Nhu Cassandra: DELETE ... IF tren dong khong ton tai -> [applied] = false
        if (ifText) return new ResultSet([{ '[applied]': matched > 0 }]);
        return new ResultSet([]);
    }

    // Tien ich cho test: chen truc tiep
    seedRow(table, values) {
        const t = this.table(table);
        const row = {};
        for (const [c, v] of Object.entries(values)) row[c] = normalize(t.columns[c], v);
        this.data[table].set(this.pkString(t, row), row);
    }
}

module.exports = { FakeCassandra, parseSchema, NoHostAvailableError, RESERVED, assertIdentifier };
