// Gan them hanh vi vao route CO SAN ma khong sua ma nguon route do.
//   afterJson(cb)      : chay cb(body, req, res) SAU khi route goc tra JSON 2xx (khong doi phan hoi).
//   decorateJson(fn)   : bien doi body truoc khi gui (vd. gan them truong moi); loi -> gui body goc.
//   beforeHandler(fn)  : chay fn(req) truoc route goc, ket qua de o req.extBefore (vd. doc trang thai cu).
function afterJson(cb) {
    return (req, res, next) => {
        const original = res.json.bind(res);
        res.json = body => {
            const out = original(body);
            if (res.statusCode < 300) {
                Promise.resolve()
                    .then(() => cb(body, req, res))
                    .catch(error => console.warn('[ext] Xử lý bổ sung lỗi:', error.message));
            }
            return out;
        };
        next();
    };
}

function decorateJson(transform) {
    return (req, res, next) => {
        const original = res.json.bind(res);
        res.json = body => {
            if (res.statusCode >= 300 || !body || typeof body !== 'object') return original(body);
            Promise.resolve()
                .then(() => transform(body, req, res))
                .then(result => original(result === undefined ? body : result))
                .catch(error => {
                    console.warn('[ext] Không bổ sung được phản hồi:', error.message);
                    original(body);
                });
            return res;
        };
        next();
    };
}

function beforeHandler(fn) {
    return async (req, res, next) => {
        try {
            req.extBefore = await fn(req);
        } catch {
            req.extBefore = null;
        }
        next();
    };
}

module.exports = { afterJson, decorateJson, beforeHandler };
