const prisma = require('../config/db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createToken, createRefreshToken } = require('../utils');

async function login(req, res) {
  try {
    const { email, password } = req.body;

    // [C-6] Validate inputs are non-empty strings
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() }
    });

    if (!user) {
      // Generic message to prevent user enumeration
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };

    const token = createToken(payload, process.env.JWTSECRET);
    const refreshToken = createRefreshToken(payload, process.env.JWTSECRET);

    return res.json({
      success: true,
      data: { user: payload, token, refreshToken }
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'An error occurred during login.' });
  }
}

async function register(req, res) {
  const { email, password, name, phoneNumber, grade } = req.body;

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ success: false, error: 'Email is required.' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'Password is required.' });
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ success: false, error: 'Name is required.' });
  }
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Phone number is required.' });
  }
  if (!grade) {
    return res.status(400).json({ success: false, error: 'Grade is required (FIRST_SECONDARY, SECOND_SECONDARY, or THIRD_SECONDARY).' });
  }

  const allowedGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
  if (!allowedGrades.includes(grade)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid grade value. Must be one of: FIRST_SECONDARY, SECOND_SECONDARY, THIRD_SECONDARY.'
    });
  }

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() }
    });

    if (existingUser) {
      return res.status(409).json({ success: false, error: 'Email already registered.' });
    }

    const existingPhone = await prisma.user.findUnique({
      where: { phoneNumber: phoneNumber.trim() }
    });

    if (existingPhone) {
      return res.status(409).json({ success: false, error: 'Phone number already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phoneNumber: phoneNumber.trim(),
        password: hashedPassword,
        grade
      }
    });

    const payload = {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      phoneNumber: newUser.phoneNumber,
      grade: newUser.grade,
      role: newUser.role
    };

    const token = createToken(payload, process.env.JWTSECRET);
    const refreshToken = createRefreshToken(payload, process.env.JWTSECRET);

    return res.status(201).json({
      success: true,
      message: 'User registered successfully.',
      data: { user: payload, token, refreshToken }
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, error: 'An error occurred during registration.' });
  }
}

async function logout(req, res) {
  return res.json({ success: true, message: 'Logged out successfully.' });
}

async function refreshToken(req, res) {
  const token = req.cookies.refreshToken;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Refresh token not provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWTSECRET);

    const payload = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      role: decoded.role
    };

    const newToken = createToken(payload, process.env.JWTSECRET);
    const newRefreshToken = createRefreshToken(payload, process.env.JWTSECRET);

    return res.json({
      success: true,
      message: 'Token refreshed successfully.',
      data: { token: newToken, refreshToken: newRefreshToken }
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    return res.status(401).json({ success: false, error: 'Invalid refresh token.' });
  }
}

module.exports = { login, register, logout, refreshToken };