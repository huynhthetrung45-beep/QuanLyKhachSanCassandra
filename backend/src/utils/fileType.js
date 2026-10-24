// Nhan dien loai tep theo NOI DUNG THAT (magic bytes), khong tin phan mo rong hay
// Content-Type do trinh duyet gui. Chi chap nhan cac dinh dang trong ALLOWED.
// Khong chap nhan SVG / HTML / script (co the chay ma trong trinh duyet).

const ALLOWED = {
    jpg: { mime: 'image/jpeg', kind: 'IMAGE' },
    jpeg: { mime: 'image/jpeg', kind: 'IMAGE' },
    png: { mime: 'image/png', kind: 'IMAGE' },
    gif: { mime: 'image/gif', kind: 'IMAGE' },
    webp: { mime: 'image/webp', kind: 'IMAGE' },
    mp4: { mime: 'video/mp4', kind: 'VIDEO' },
    pdf: { mime: 'application/pdf', kind: 'FILE' },
    docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'FILE' },
    xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'FILE' },
    txt: { mime: 'text/plain; charset=utf-8', kind: 'FILE' },
    zip: { mime: 'application/zip', kind: 'FILE' }
};

const startsWith = (buf, bytes, offset = 0) =>
    buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf, start, end) => buf.subarray(start, end).toString('latin1');

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'dash', 'MSNV', 'mmp4']);

// Tra ve loai noi dung that: jpeg | png | gif | webp | mp4 | pdf | docx | xlsx | zip | txt | null
function sniff(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
    if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (/^GIF8[79]a$/.test(ascii(buf, 0, 6))) return 'gif';
    if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'webp';
    if (ascii(buf, 4, 8) === 'ftyp' && MP4_BRANDS.has(ascii(buf, 8, 12))) return 'mp4';
    if (ascii(buf, 0, 5) === '%PDF-') return 'pdf';
    if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
        // DOCX / XLSX la ZIP; ten muc trong ZIP luu khong nen nen tim duoc trong noi dung.
        const text = buf.toString('latin1');
        if (text.includes('[Content_Types].xml')) {
            if (text.includes('word/')) return 'docx';
            if (text.includes('xl/')) return 'xlsx';
        }
        return 'zip';
    }
    // Van ban: UTF-8 hop le, khong co byte NUL, khong co ky tu dieu khien la.
    if (!buf.includes(0)) {
        try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
            if (!/[\u0000-\u0008\u000e-\u001f\u007f]/.test(decoded)) return 'txt';
        } catch {
            return null;
        }
    }
    return null;
}

// Phan mo rong -> loai noi dung chap nhan duoc.
const EXT_TO_SNIFF = {
    jpg: ['jpeg'], jpeg: ['jpeg'], png: ['png'], gif: ['gif'], webp: ['webp'], mp4: ['mp4'],
    pdf: ['pdf'], docx: ['docx'], xlsx: ['xlsx'], txt: ['txt'], zip: ['zip', 'docx', 'xlsx']
};

// Ten tep an toan de HIEN THI / tai xuong (khong bao gio dung lam duong dan luu tru).
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

function sanitizeFileName(raw) {
    let name = String(raw || '').normalize('NFC');
    name = name.split(/[\\/]/).pop();                        // bo moi thanh phan duong dan
    // Bo ky tu dieu khien va ky tu dao chieu van ban (U+200B-U+200F, U+2028-U+202E, U+2066-U+2069).
    name = name.replace(CONTROL_CHARS, '');
    name = name.replace(/[<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
    if (name.length > 120) {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 ? name.slice(dot) : '';
        name = name.slice(0, 120 - ext.length) + ext;
    }
    return name || 'tep';
}

function extensionOf(name) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
}

// Kiem tra day du: phan mo rong trong danh sach + noi dung that khop phan mo rong.
function classify(fileName, buf) {
    const ext = extensionOf(fileName);
    const rule = ALLOWED[ext];
    if (!rule) return { ok: false, code: 'FILE_TYPE_NOT_ALLOWED', ext };
    const actual = sniff(buf);
    if (!actual || !EXT_TO_SNIFF[ext].includes(actual)) return { ok: false, code: 'FILE_TYPE_MISMATCH', ext, actual };
    const final = actual === ext || (ext === 'jpg' && actual === 'jpeg') ? rule : ALLOWED[actual === 'jpeg' ? 'jpg' : actual];
    return { ok: true, ext, actual, mime: final.mime, kind: final.kind };
}

module.exports = { sniff, classify, sanitizeFileName, extensionOf, ALLOWED };
