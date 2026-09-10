'use strict';

/**
 * notificationRoutes.js
 * In-app notifications (optional module).
 *
 * This router is mounted ONLY when the notifications module is enabled
 * (see app.js) — disabled means these paths do not exist at all.
 */

const express = require('express');
const router = express.Router();

const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const {
  listMine,
  getUnreadCount,
  markOneRead,
  markAllRead,
  broadcast,
} = require('../controllers/notificationController');

// All notification routes require valid authentication
router.use(authenticateToken);

// ─── Student Endpoints (own inbox only) ────────────────────────────────────
router.get('/', listMine);
router.get('/unread-count', getUnreadCount);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', markOneRead);

// ─── Admin Endpoints ───────────────────────────────────────────────────────
router.post('/broadcast', authorizeAdmin(), broadcast);

module.exports = router;
