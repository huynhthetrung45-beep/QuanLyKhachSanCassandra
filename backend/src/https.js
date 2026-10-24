// NFR-16: chay backend qua HTTPS (bat buoc HTTPS + HSTS).
//   npm run start:https
// Can TLS_CERT_FILE va TLS_KEY_FILE trong backend/.env (vd. tao bang mkcert cho localhost).
// HTTP_REDIRECT_PORT (tuy chon): mo them cong HTTP chi de chuyen huong 301 sang HTTPS.
// Cookie phien tu dat Secure khi COOKIE_SECURE=true (nen bat cung luc).
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const http = require('http');
const https = require('https');
const db = require('./db');
const { createApp, checkSchema } = require('./app');
const extensions = require('./extensions');

async function main() {
    const cert = process.env.TLS_CERT_FILE;
    const key = process.env.TLS_KEY_FILE;
    if (!cert || !key) {
        console.error('Thiếu TLS_CERT_FILE / TLS_KEY_FILE trong backend/.env.');
        process.exit(1);
    }
    const port = Number(process.env.HTTPS_PORT || 3443);
    const client = db.getClient();
    try {
        await client.connect();
        const missing = await checkSchema();
        if (missing.length) {
            console.error(`Schema chưa đủ, thiếu: ${missing.join(', ')}. Hãy chạy "npm run deploy:migration".`);
            process.exit(1);
        }
        const app = createApp();
        const secureApp = (req, res) => {
            res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
            app(req, res);
        };
        https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, secureApp).listen(port, () => {
            console.log(`Backend HTTPS đang chạy tại https://localhost:${port}`);
            extensions.startBackground();
        });
        if (process.env.HTTP_REDIRECT_PORT) {
            http.createServer((req, res) => {
                const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
                res.writeHead(301, { Location: `https://${host}:${port}${req.url}` });
                res.end();
            }).listen(Number(process.env.HTTP_REDIRECT_PORT));
        }
    } catch (error) {
        console.error('Không thể khởi động backend HTTPS:', error.message);
        await client.shutdown().catch(() => {});
        process.exit(1);
    }
}

main();
