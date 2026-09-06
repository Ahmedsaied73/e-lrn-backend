const express = require('express');
const router = express.Router();
const { login, register, logout, refreshToken } = require('../controllers/authController');
const { optionalAuth } = require('../middlewares');

router.post('/login', login);
// optionalAuth lets register detect an existing session (e.g. admin adding a
// student) so it can avoid clobbering the caller's cookies.
router.post('/register', optionalAuth, register);
router.post('/logout', logout);
router.post('/refresh-token', refreshToken);

module.exports = router;
