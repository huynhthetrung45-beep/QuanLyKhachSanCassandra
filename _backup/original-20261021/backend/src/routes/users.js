
const express = require('express');
const router = express.Router();

const client = require('../config/cassandra');

// GET /api/v1/users
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT user_id, display_name, avatar_url, created_at
            FROM users
        `;

        const result = await client.execute(query);

        res.json({
            data: result.rows.map(user => ({
                userId: user.user_id,
                displayName: user.display_name,
                avatarUrl: user.avatar_url,
                createdAt: user.created_at
            }))
        });
    } catch (error) {
        console.error('Loi lay danh sach nguoi dung:', error.message);

        res.status(500).json({
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Khong the lay danh sach nguoi dung'
            }
        });
    }
});

module.exports = router;
