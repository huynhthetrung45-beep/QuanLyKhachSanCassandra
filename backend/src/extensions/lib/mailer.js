// Gui email (PT-02 quen mat khau, PT-09 xac minh email).
//  - Co SMTP_URL (vd. smtps://user:pass@smtp.gmail.com:465) va da cai nodemailer: gui that.
//  - Khong co: CHE DO PHAT TRIEN - in thu ra console va luu file .eml trong storage/outbox
//    (khong bao gio tra noi dung thu / link ve API).
const fs = require('fs');
const path = require('path');

let transport = null;
let transportTried = false;
const sent = []; // chi giu trong bo nho cho kiem thu tu dong (toi da 50 thu gan nhat)

function getTransport() {
    if (transportTried) return transport;
    transportTried = true;
    if (!process.env.SMTP_URL) return null;
    try {
        // eslint-disable-next-line global-require
        const nodemailer = require('nodemailer');
        transport = nodemailer.createTransport(process.env.SMTP_URL);
    } catch (error) {
        console.warn('[mail] Có SMTP_URL nhưng chưa cài nodemailer (npm install nodemailer):', error.message);
        transport = null;
    }
    return transport;
}

function outboxDir() {
    return path.resolve(process.env.MAIL_OUTBOX_DIR || path.resolve(__dirname, '../../../../storage/outbox'));
}

async function sendMail({ to, subject, text }) {
    const from = process.env.MAIL_FROM || 'ChatOTT <no-reply@chatott.local>';
    sent.push({ to, subject, text, at: new Date() });
    if (sent.length > 50) sent.shift();
    const t = getTransport();
    if (t) {
        await t.sendMail({ from, to, subject, text });
        return { delivered: true };
    }
    if (process.env.NODE_ENV === 'test' || process.env.MAIL_SILENT === 'true') return { delivered: false };
    console.log(`\n[mail - chế độ phát triển] Tới: ${to}\nTiêu đề: ${subject}\n${text}\n`);
    try {
        const dir = outboxDir();
        await fs.promises.mkdir(dir, { recursive: true });
        const file = path.join(dir, `${Date.now()}-${String(to).replace(/[^a-z0-9@._-]/gi, '_')}.eml`);
        await fs.promises.writeFile(file, `From: ${from}\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`, 'utf8');
    } catch (error) {
        console.warn('[mail] Không lưu được thư vào outbox:', error.message);
    }
    return { delivered: false };
}

const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');

module.exports = { sendMail, appUrl, sentMails: () => sent.slice() };
