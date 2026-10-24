
const path = require('path');
require('dotenv').config({
    path: path.resolve(__dirname, '../../.env')
});

const cassandra = require('cassandra-driver');

const client = new cassandra.Client({
    contactPoints: process.env.CASSANDRA_HOSTS.split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DATACENTER,
    keyspace: process.env.CASSANDRA_KEYSPACE
});

module.exports = client;
