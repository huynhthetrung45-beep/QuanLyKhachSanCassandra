// Diem truy cap duy nhat toi Cassandra client.
// Cho phep test thay client that bang client gia lap (setClient).
let client = null;

function getClient() {
    if (!client) {
        client = require('../config/cassandra');
    }
    return client;
}

function setClient(newClient) {
    client = newClient;
}

function execute(query, params = [], options = {}) {
    return getClient().execute(query, params, { prepare: true, ...options });
}

function batch(queries, options = {}) {
    return getClient().batch(queries, { prepare: true, logged: true, ...options });
}

module.exports = { getClient, setClient, execute, batch };
