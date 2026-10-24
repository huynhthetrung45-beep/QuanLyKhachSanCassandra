// Xem truoc lien ket (PT-21): may chu tai trang, doc og:title / og:description / og:image.
// Chong SSRF: chi http/https, cong 80/443, phan giai DNS va TU CHOI dia chi noi bo
// (loopback, mang rieng, link-local, multicast...), toi da 2 lan chuyen huong (kiem tra lai moi lan),
// het thoi gian 4 giay, doc toi da 300 KB. Tat bang LINK_PREVIEW=false.
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 300 * 1024;
const TIMEOUT_MS = Number(process.env.LINK_PREVIEW_TIMEOUT_MS || 4000);
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/i;

function enabled() {
    return process.env.LINK_PREVIEW !== 'false' && process.env.NODE_ENV !== 'test';
}

function firstUrl(text) {
    const m = URL_RE.exec(String(text || ''));
    if (!m) return null;
    return m[0].replace(/[),.;!?]+$/, '');
}

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function assertPublic(url) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme');
    if (u.port && !['80', '443'].includes(u.port)) throw new Error('port');
    if (u.username || u.password) throw new Error('credentials');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (addresses.length === 0 || addresses.some(isPrivateIp)) throw new Error('private address');
    return u;
}

const decode = s => String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();

function meta(html, names) {
    for (const name of names) {
        const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
        const tag = re.exec(html);
        if (tag) {
            const content = /content=["']([^"']*)["']/i.exec(tag[0]);
            if (content && content[1].trim()) return decode(content[1]);
        }
    }
    return null;
}

function parse(html, baseUrl) {
    const title = meta(html, ['og:title', 'twitter:title']) || decode((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1]);
    const description = meta(html, ['og:description', 'twitter:description', 'description']);
    let image = meta(html, ['og:image', 'twitter:image']);
    if (image) {
        try { image = new URL(image, baseUrl).toString(); } catch { image = null; }
        if (image && !/^https:\/\//i.test(image)) image = null; // chi anh https (tranh noi dung hon hop)
    }
    const site = meta(html, ['og:site_name']) || new URL(baseUrl).hostname;
    return {
        url: baseUrl,
        title: title ? title.slice(0, 200) : null,
        description: description ? description.slice(0, 300) : null,
        image: image ? image.slice(0, 1000) : null,
        site: site ? site.slice(0, 100) : null
    };
}

async function fetchPreview(rawUrl) {
    let url = rawUrl;
    for (let hop = 0; hop < 3; hop += 1) {
        await assertPublic(url);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                redirect: 'manual',
                signal: controller.signal,
                headers: { 'User-Agent': 'ChatOTT-LinkPreview/1.0', Accept: 'text/html' }
            });
            if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
                url = new URL(res.headers.get('location'), url).toString();
                continue;
            }
            if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) return null;
            const reader = res.body.getReader();
            const chunks = [];
            let size = 0;
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
                size += value.length;
                if (size >= MAX_BYTES) { controller.abort(); break; }
            }
            const html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
            const preview = parse(html, url);
            return preview.title || preview.description ? preview : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

module.exports = { enabled, firstUrl, fetchPreview, parse, isPrivateIp, assertPublic };
