
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../.env')
});

const cassandra = require('cassandra-driver');

// Driver mac dinh dung TokenAwarePolicy + DCAwareRoundRobinPolicy:
// truy van theo partition key duoc dinh tuyen thang toi replica giu partition.
const client = new cassandra.Client({
    contactPoints: (process.env.CASSANDRA_HOSTS || '127.0.0.1').split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER || 'datacenter1',
    keyspace: process.env.CASSANDRA_KEYSPACE || 'chat_ott',
    queryOptions: {
        consistency: cassandra.types.consistencies.localOne,
        prepare: true
    },
    socketOptions: {
        readTimeout: 12000
    }
});

// NFR-14 (them): muc nhat quan cau hinh duoc, vd. CASSANDRA_CONSISTENCY=localQuorum khi chay cum 3 nut.
const configuredConsistency = cassandra.types.consistencies[process.env.CASSANDRA_CONSISTENCY || ''];
if (configuredConsistency !== undefined) client.options.queryOptions.consistency = configuredConsistency;

module.exports = client;
