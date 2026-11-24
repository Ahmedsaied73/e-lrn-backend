'use strict';

const express = require('express');
const { authenticateToken } = require('../../middlewares');
const controller = require('./controller');

const router = express.Router();

router.post('/extract', authenticateToken, controller.extract);

module.exports = router;
