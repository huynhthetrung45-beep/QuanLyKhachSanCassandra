// Ho so, ket ban, chan. Moi route sau requireAuth: danh tinh lay tu phien, khong tu body.
const express = require('express');
const social = require('../services/social.service');

const router = express.Router();

router.get('/me/profile', async (req, res) => res.json(await social.getProfile(req.user, req.user.userId)));
router.patch('/me/profile', async (req, res) => res.json(await social.updateProfile(req.user, req.body || {})));
router.get('/users/:userId/profile', async (req, res) => res.json(await social.getProfile(req.user, req.params.userId)));

router.get('/friends', async (req, res) => res.json({ data: await social.listFriends(req.user) }));
router.delete('/friends/:userId', async (req, res) => res.json(await social.unfriend(req.user, req.params.userId)));

// direction=incoming (mac dinh) | outgoing
router.get('/friends/requests', async (req, res) =>
    res.json({ data: await social.listRequests(req.user, req.query.direction === 'outgoing' ? 'outgoing' : 'incoming') }));
router.post('/friends/requests', async (req, res) => res.status(201).json(await social.sendRequest(req.user, req.body?.targetUserId)));
router.delete('/friends/requests/:userId', async (req, res) => res.json(await social.cancelRequest(req.user, req.params.userId)));
router.post('/friends/requests/:userId/accept', async (req, res) => res.json(await social.acceptRequest(req.user, req.params.userId)));
router.post('/friends/requests/:userId/decline', async (req, res) => res.json(await social.declineRequest(req.user, req.params.userId)));

router.get('/blocks', async (req, res) => res.json({ data: await social.listBlocked(req.user) }));
router.post('/blocks', async (req, res) => res.status(201).json(await social.block(req.user, req.body?.targetUserId)));
router.delete('/blocks/:userId', async (req, res) => res.json(await social.unblock(req.user, req.params.userId)));

module.exports = router;
