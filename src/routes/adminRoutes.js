'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { getDashboardStats } = require('../controllers/adminController');

// Every admin route requires an authenticated ADMIN user.
router.use(authenticateToken, authorizeAdmin());

router.get('/dashboard', getDashboardStats);

module.exports = router;