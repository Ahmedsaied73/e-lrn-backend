'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/index');
const { chat } = require('../controllers/aiStudentController');

router.post('/chat', authenticateToken, chat);

module.exports = router;
