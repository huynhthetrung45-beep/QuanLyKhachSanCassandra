// NFR-13: chay NHIEU tien trinh backend - dong bo su kien realtime qua Redis pub/sub.
// Bat bang REDIS_URL=redis://localhost:6379 (can "npm install redis"). Khong dat -> giu nguyen hanh vi 1 tien trinh.
// Moi lenh publish: gui cho ket noi SSE cua tien trinh nay + day len kenh Redis; tien trinh khac nhan
// va gui cho ket noi SSE cua chung. Moi tien trinh co id rieng de khong gui lap lai.
const crypto = require('crypto');
const realtime = require('../services/realtime.service');

const CHANNEL = process.env.REDIS_CHANNEL || 'chatott:realtime';
const instanceId = crypto.randomUUID();
let installed = false;

async function installRedisBridge() {
    if (installed || !process.env.REDIS_URL) return false;
    let redis;
    try {
        // eslint-disable-next-line global-require
        redis = require('redis');
    } catch {
        console.warn('[redis] Có REDIS_URL nhưng chưa cài thư viện redis (npm install redis). Realtime chỉ chạy trong 1 tiến trình.');
        return false;
    }
    const pub = redis.createClient({ url: process.env.REDIS_URL });
    const sub = pub.duplicate();
    pub.on('error', e => console.warn('[redis] pub:', e.message));
    sub.on('error', e => console.warn('[redis] sub:', e.message));
    await pub.connect();
    await sub.connect();

    const localPublish = realtime.publish;
    const localPublishAll = realtime.publishAll;
    realtime.publish = (userIds, event, data) => {
        localPublish(userIds, event, data);
        pub.publish(CHANNEL, JSON.stringify({ from: instanceId, userIds: [...new Set(userIds)], event, data })).catch(() => {});
    };
    realtime.publishAll = (event, data) => {
        localPublishAll(event, data);
        pub.publish(CHANNEL, JSON.stringify({ from: instanceId, all: true, event, data })).catch(() => {});
    };
    await sub.subscribe(CHANNEL, raw => {
        try {
            const msg = JSON.parse(raw);
            if (msg.from === instanceId) return;
            if (msg.all) localPublishAll(msg.event, msg.data);
            else localPublish(msg.userIds || [], msg.event, msg.data);
        } catch { /* bo qua goi tin loi */ }
    });
    installed = true;
    console.log(`[redis] Realtime đồng bộ qua Redis (${CHANNEL}), tiến trình ${instanceId.slice(0, 8)}.`);
    return true;
}

module.exports = { installRedisBridge, instanceId };
