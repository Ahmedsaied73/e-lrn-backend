# 🛡️ Express Backend Cookie & CORS Authentication Implementation Guide

> **Target Audience**: Backend Engineering Team (Node.js / Express)  
> **Objective**: Resolve `TypeError: Failed to fetch` CORS errors during registration/login, implement Dual HttpOnly Cookie authentication (Access Token + Refresh Token), and ensure seamless security alignment with the Next.js Frontend.

---

## 🎯 Executive Summary & Root Cause Analysis

### Why `TypeError: Failed to fetch` Occurred
When attempting registration or login, the browser threw `TypeError: Failed to fetch` because of an invalid CORS header combination on the Express server:

```javascript
// ❌ INVALID CONFIGURATION — BROWSERS REJECT THIS
app.use(cors({
    origin: '*',          // Wildcard origin
    credentials: true,    // Credentials requested
}));
```

According to W3C CORS Specifications & MDN rules:
> When a request is made with credentials (`credentials: 'include'`), the response header `Access-Control-Allow-Origin` **MUST NOT be the wildcard `'*'`**. It must specify an exact, explicit origin (e.g., `http://localhost:3000`).

When the browser sees `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true`, it immediately blocks the network response and throws `TypeError: Failed to fetch` on the frontend.

---

## 🔧 Step-by-Step Backend Implementation

### Step 1: Install Required Dependencies
Ensure `cors` and `cookie-parser` are installed in your Express project:

```bash
npm install cors cookie-parser dotenv jsonwebtoken
```

---

### Step 2: Fix Express CORS Configuration

Replace your existing CORS middleware in `server.js` or `app.js` with the following production-ready configuration:

```javascript
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();

// Parse cookies attached to incoming requests
app.use(cookieParser());

// Define allowed frontend origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL, // e.g., https://your-production-app.com
].filter(Boolean);

// ✅ CORRECT CORS CONFIGURATION FOR COOKIES
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error(`CORS policy does not allow access from ${origin}`));
    }
  },
  credentials: true, // Allow cookies & authorization headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Set-Cookie'],
  maxAge: 86400 // Cache preflight (OPTIONS) response for 24 hours
}));

app.use(express.json());
```

---

### Step 3: Cookie Security Options Matrix

Define standardized cookie options based on the environment (Development vs Production):

```javascript
// config/cookie.js
const isProduction = process.env.NODE_ENV === 'production';

// Options for Short-Lived Access Token (15 Minutes)
const accessTokenCookieOptions = {
  httpOnly: true,                                      // Prevents XSS script access
  secure: isProduction,                                // Required HTTPS in Production
  sameSite: isProduction ? 'strict' : 'lax',           // CSRF protection
  maxAge: 15 * 60 * 1000,                              // 15 Minutes
  path: '/',
};

// Options for Long-Lived Refresh Token (7 Days)
const refreshTokenCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,                     // 7 Days
  path: '/auth',                                       // Restrict refresh token to auth routes
};

module.exports = {
  accessTokenCookieOptions,
  refreshTokenCookieOptions,
};
```

---

### Step 4: Authentication Controller Implementation

#### 1. Register Handler (`POST /auth/register`)

```javascript
const { accessTokenCookieOptions, refreshTokenCookieOptions } = require('../config/cookie');
const { generateAccessToken, generateRefreshToken } = require('../utils/jwt');

exports.register = async (req, res) => {
  try {
    const { name, email, phoneNumber, grade, password } = req.body;

    // Validate inputs & check existing user...
    const newUser = await User.create({ name, email, phoneNumber, grade, password });

    // Generate JWT Tokens
    const accessToken = generateAccessToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    // Save refreshToken in DB/Redis for revocation support
    await newUser.update({ refreshToken });

    // Set HttpOnly Cookies on Response
    res.cookie('accessToken', accessToken, accessTokenCookieOptions);
    res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        phoneNumber: newUser.phoneNumber,
        grade: newUser.grade,
        role: newUser.role,
      }
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};
```

#### 2. Login Handler (`POST /auth/login`)

```javascript
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ where: { email } });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ success: false, error: 'بيانات الدخول غير صحيحة' });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    await user.update({ refreshToken });

    // Set HttpOnly Cookies
    res.cookie('accessToken', accessToken, accessTokenCookieOptions);
    res.cookie('refreshToken', refreshToken, refreshTokenCookieOptions);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber,
        grade: user.grade,
        role: user.role,
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'حدث خطأ في الخادم' });
  }
};
```

#### 3. Token Refresh Handler (`POST /auth/refresh`)

```javascript
exports.refreshToken = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ success: false, error: 'Refresh token missing' });
    }

    // Verify token & look up user
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findById(decoded.id);

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ success: false, error: 'Invalid refresh token' });
    }

    // Generate new Access Token
    const newAccessToken = generateAccessToken(user);

    // Set new Access Token cookie
    res.cookie('accessToken', newAccessToken, accessTokenCookieOptions);

    return res.status(200).json({ success: true, message: 'Token refreshed successfully' });
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Expired or invalid token' });
  }
};
```

#### 4. Logout Handler (`POST /auth/logout`)

```javascript
exports.logout = async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (refreshToken) {
      // Invalidate refresh token in database
      await User.update({ refreshToken: null }, { where: { refreshToken } });
    }

    // Clear cookies
    res.clearCookie('accessToken', { ...accessTokenCookieOptions, maxAge: 0 });
    res.clearCookie('refreshToken', { ...refreshTokenCookieOptions, maxAge: 0 });

    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Logout failed' });
  }
};
```

---

### Step 5: Authentication Middleware (`middleware/auth.js`)

Extract the Access Token from either the `HttpOnly` cookie or the `Authorization` header:

```javascript
const jwt = require('jsonwebtoken');

const authenticateUser = (req, res, next) => {
  // 1. Try reading token from HttpOnly cookie
  let token = req.cookies.accessToken;

  // 2. Fallback to Bearer token in Authorization header if present
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, error: 'غير مصرح بالدخول — يجب تسجيل الدخول' });
  }

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'انتهت صلاحية الجلسة' });
  }
};

module.exports = { authenticateUser };
```

---

## 🔗 Next.js Frontend Alignment Instructions

Once the backend developer implements the steps above:

1. **Credentials Header**: The frontend HTTP client (`lib/api-client.ts`) will set `credentials: 'include'` on all `fetch()` requests.
2. **Automatic Cookie Transmission**: Browsers will automatically store and send `accessToken` and `refreshToken` cookies with every API request.
3. **No LocalStorage Tokens**: The frontend will no longer store JWT tokens in `localStorage` (protecting the app against XSS attacks).
4. **CORS Success**: Preflight `OPTIONS` requests will succeed with HTTP 200 without throwing `TypeError: Failed to fetch`.

---

## ✅ Testing Checklist for Backend Developer

| Test Case | Method | Endpoint | Expected Result |
| :--- | :--- | :--- | :--- |
| **CORS Preflight** | `OPTIONS` | `/auth/register` | `200 OK` with `Access-Control-Allow-Origin: http://localhost:3000` & `Access-Control-Allow-Credentials: true` |
| **User Register** | `POST` | `/auth/register` | `201 Created` with `Set-Cookie` headers for `accessToken` & `refreshToken` |
| **User Login** | `POST` | `/auth/login` | `200 OK` with `Set-Cookie` headers |
| **Get Profile** | `GET` | `/user/me` | `200 OK` when `accessToken` cookie is automatically sent |
| **Silent Refresh** | `POST` | `/auth/refresh` | `200 OK` with new `accessToken` cookie |
| **User Logout** | `POST` | `/auth/logout` | `200 OK` with `Set-Cookie` max-age=0 (cleared) |
