// Client S3 toi gian (AWS S3, MinIO, Cloudflare R2...) dung fetch + chu ky AWS Signature Version 4.
// Khong can thu vien ngoai. Chi 3 thao tac can cho luu tep: PUT, GET, DELETE object.
// Khoa truy cap chi doc tu bien moi truong, khong ghi log, khong gui xuong trinh duyet.
const crypto = require('crypto');

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_SHA = sha256('');

// RFC 3986, giu "/" giua cac doan duong dan (S3 khong ma hoa 2 lan).
const encodePath = p => p.split('/').map(seg => encodeURIComponent(seg).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

// Tra ve header Authorization cho 1 request. headers: object chu thuong, phai co host, x-amz-date, x-amz-content-sha256.
function signRequest({ method, path, query = '', headers, payloadHash, accessKeyId, secretAccessKey, region, service = 's3' }) {
    const amzDate = headers['x-amz-date'];
    const day = amzDate.slice(0, 8);
    const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
    const canonicalHeaders = names.map(n => `${n}:${String(headers[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${day}/${region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function config(env = process.env) {
    const endpoint = env.S3_ENDPOINT || (env.S3_REGION ? `https://s3.${env.S3_REGION}.amazonaws.com` : '');
    return {
        endpoint: endpoint.replace(/\/+$/, ''),
        region: env.S3_REGION || 'us-east-1',
        bucket: env.S3_BUCKET || '',
        accessKeyId: env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
        // MinIO can path-style (http://host:9000/bucket/key); AWS ho tro ca 2.
        pathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
        timeoutMs: Number(env.S3_TIMEOUT_MS || 15000)
    };
}

function missing(cfg) {
    return ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].filter(k => !cfg[k]);
}

class S3Error extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.s3Code = code; }
}

function createClient(cfg = config()) {
    const base = new URL(cfg.endpoint);
    const target = key => {
        const objectPath = cfg.pathStyle ? `/${cfg.bucket}/${key}` : `/${key}`;
        const host = cfg.pathStyle ? base.host : `${cfg.bucket}.${base.host}`;
        const basePath = base.pathname.replace(/\/+$/, '');
        const path = encodePath(basePath + objectPath);
        return { host, path, url: `${base.protocol}//${host}${path}` };
    };

    async function send(method, key, body = null, extraHeaders = {}) {
        const { host, path, url } = target(key);
        const payloadHash = body ? sha256(body) : EMPTY_SHA;
        const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        const headers = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...extraHeaders };
        headers.authorization = signRequest({ method, path, headers, payloadHash, ...cfg });
        const { host: _h, ...sendHeaders } = headers;
        const res = await fetch(url, { method, headers: sendHeaders, body: body || undefined, signal: AbortSignal.timeout(cfg.timeoutMs) });
        if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
            const text = await res.text().catch(() => '');
            const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || `HTTP_${res.status}`;
            throw new S3Error(res.status, code, `S3 ${method} ${key}: ${code}`);
        }
        return res;
    }

    return {
        async putObject(key, buffer, contentType = 'application/octet-stream') {
            await send('PUT', key, buffer, { 'content-type': contentType, 'content-length': String(buffer.length) });
        },
        // Tra ve Buffer hoac null neu khong ton tai.
        async getObject(key) {
            try {
                const res = await send('GET', key);
                return Buffer.from(await res.arrayBuffer());
            } catch (error) {
                if (error.status === 404) return null;
                throw error;
            }
        },
        async deleteObject(key) { await send('DELETE', key); },
        target
    };
}

module.exports = { signRequest, createClient, config, missing, encodePath, S3Error, EMPTY_SHA };
