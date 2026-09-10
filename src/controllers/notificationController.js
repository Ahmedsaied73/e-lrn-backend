'use strict';

/**
 * notificationController.js
 * Thin HTTP adapters for the Notifications endpoints.
 * Ownership and audience resolution live in notificationService — user IDs
 * and recipient lists are never trusted from the client.
 */

const notificationService = require('../services/notifications/notificationService');

function sendError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  if (!error.statusCode) console.error('[NotificationController]', error);
  return res.status(statusCode).json({ success: false, error: error.message || fallback });
}

// ─── Student Endpoints (own rows only) ─────────────────────────────────────

async function listMine(req, res) {
  try {
    const result = await notificationService.listForUser(req.user.id, {
      page: req.query.page,
      limit: req.query.limit,
      unreadOnly: req.query.unreadOnly === 'true' || req.query.unreadOnly === '1',
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, 'Failed to list notifications');
  }
}

async function getUnreadCount(req, res) {
  try {
    const count = await notificationService.unreadCount(req.user.id);
    return res.json({ success: true, data: { count } });
  } catch (error) {
    return sendError(res, error, 'Failed to get unread count');
  }
}

async function markOneRead(req, res) {
  try {
    const result = await notificationService.markRead(req.user.id, req.params.id);
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, 'Failed to mark notification as read');
  }
}

async function markAllRead(req, res) {
  try {
    const result = await notificationService.markAllRead(req.user.id);
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, 'Failed to mark notifications as read');
  }
}

// ─── Admin Endpoints ───────────────────────────────────────────────────────

async function broadcast(req, res) {
  try {
    const { title, body, linkUrl, metadata, audience } = req.body || {};
    const userIds = await notificationService.resolveAudience(audience);
    const result = await notificationService.createForUsers({
      userIds,
      type: notificationService.NOTIFICATION_TYPES.ADMIN_BROADCAST,
      title,
      body,
      linkUrl,
      metadata: metadata && typeof metadata === 'object' ? metadata : null,
    });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, 'Failed to send broadcast');
  }
}

module.exports = {
  listMine,
  getUnreadCount,
  markOneRead,
  markAllRead,
  broadcast,
};
