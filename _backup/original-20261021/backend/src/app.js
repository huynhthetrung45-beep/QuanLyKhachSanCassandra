
require('dotenv').config({
    path: require('path').resolve(__dirname, '../.env')
});

const express = require('express');
const cors = require('cors');
const client = require('./config/cassandra');

const usersRouter = require('./routes/users');
const conversationsRouter = require('./routes/conversations');

const app = express();

app.use(cors());
app.use(express.json());

// API danh sach nguoi dung
app.use('/api/v1/users', usersRouter);

// API danh sach cuoc tro chuyen
app.use('/api/v1', conversationsRouter);

// API kiem tra ket noi Cassandra
app.get('/api/health', async (req, res) => {
    try {
        await client.execute(
            'SELECT keyspace_name FROM system_schema.keyspaces'
        );

        res.json({
            status: 'OK',
            message: 'Backend va Cassandra hoat dong binh thuong',
            keyspace: process.env.CASSANDRA_KEYSPACE
        });
    } catch (error) {
        console.error('Loi kiem tra Cassandra:', error.message);

        res.status(500).json({
            status: 'ERROR',
            message: 'Khong the truy van Cassandra'
        });
    }
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        await client.connect();

        app.listen(PORT, () => {
            console.log(
                `Backend dang chay tai http://localhost:${PORT}`
            );
        });
    } catch (error) {
        console.error(
            'Khong the khoi dong backend:',
            error.message
        );

        await client.shutdown().catch(() => {});
        process.exit(1);
    }
}

startServer();
