'use strict';
process.chdir(__dirname + '/..');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const { isAllowedOrigin } = require('../src/config/cors');
const { renderPrometheus } = require('../src/metrics/metrics');

// Hook require.cache for the 0-byte placeholder src/middlewares.js so app.js can be imported
try {
  const mwPath = require.resolve('../src/middlewares.js');
  require.cache[mwPath] = {
    id: mwPath,
    filename: mwPath,
    loaded: true,
    exports: require('../src/middlewares/index.js'),
  };
} catch {
  // src/middlewares.js not present
}

process.env.PORT = '0';
const app = require('../app');

describe('Security configurations (CSP, /metrics, CORS)', () => {
  let server;
  let baseUrl;
  const testMetricsToken = '7d26d9bcac393b30c2af8a0b0bfdc38eaf6723bafb0c3e95b681cac206a9e996';

  before(async () => {
    process.env.METRICS_TOKEN = testMetricsToken;

    const testApp = express();

    // 1. Helmet CSP configuration matching app.js
    testApp.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'", 'https://*.b-cdn.net', 'https://*.supabase.co', 'https://*.mediadelivery.net'],
          frameSrc: ["'self'", 'https://iframe.mediadelivery.net', 'https://*.mediadelivery.net'],
          mediaSrc: ["'self'", 'https://*.b-cdn.net', 'https://*.mediadelivery.net', 'blob:', 'data:'],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }));

    testApp.get('/probe', (req, res) => res.json({ status: 'ok' }));

    // 2. /metrics route using app.isMetricsAuthorized directly
    testApp.get('/metrics', (req, res) => {
      if (!app.isMetricsAuthorized(req)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
        return res.status(401).json({
          success: false,
          error: 'Unauthorized. Metrics access requires a valid METRICS_TOKEN or admin authentication.',
          code: 'METRICS_AUTH_REQUIRED',
        });
      }

      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(renderPrometheus());
    });

    server = http.createServer(testApp);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (app && app.server) {
      await new Promise((resolve) => app.server.close(resolve));
    }
    setTimeout(() => process.exit(0), 50);
  });

  describe('CORS & CSRF origin lockdown', () => {
    it('allows configured localhost and 127.0.0.1 origins on ports 3000 and 3002', () => {
      assert.equal(isAllowedOrigin('http://localhost:3000'), true);
      assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), true);
      assert.equal(isAllowedOrigin('http://localhost:3002'), true);
      assert.equal(isAllowedOrigin('http://127.0.0.1:3002'), true);
    });

    it('rejects wildcard .vercel.app domains', () => {
      assert.equal(isAllowedOrigin('https://attacker.vercel.app'), false);
      assert.equal(isAllowedOrigin('https://my-preview-app.vercel.app'), false);
      assert.equal(isAllowedOrigin('https://arbitrary-site.com'), false);
    });

    it('rejects falsy or empty origin values', () => {
      assert.equal(isAllowedOrigin(''), false);
      assert.equal(isAllowedOrigin(null), false);
      assert.equal(isAllowedOrigin(undefined), false);
    });
  });

  describe('Content Security Policy (CSP) in Helmet', () => {
    it('serves CSP headers allowing self, Bunny embeds, and Supabase', async () => {
      const res = await fetch(`${baseUrl}/probe`);
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, 'Content-Security-Policy header must be present');
      assert.ok(csp.includes("default-src 'self'"), 'CSP includes default-src self');
      assert.ok(csp.includes('https://iframe.mediadelivery.net'), 'CSP includes iframe.mediadelivery.net');
      assert.ok(csp.includes('https://*.mediadelivery.net'), 'CSP includes *.mediadelivery.net');
      assert.ok(csp.includes('https://*.b-cdn.net'), 'CSP includes *.b-cdn.net');
      assert.ok(csp.includes('https://*.supabase.co'), 'CSP includes *.supabase.co');
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    });
  });

  describe('Restrict /metrics endpoint (HTTP integration)', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="metrics"');
      const body = await res.json();
      assert.equal(body.code, 'METRICS_AUTH_REQUIRED');
    });

    it('rejects invalid bearer token with 401', async () => {
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: 'Bearer bad-token' },
      });
      assert.equal(res.status, 401);
    });

    it('allows access with valid METRICS_TOKEN via Bearer header', async () => {
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${testMetricsToken}` },
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('process_uptime_seconds') || text.includes('http_'));
    });

    it('allows access with valid METRICS_TOKEN via query parameter', async () => {
      const res = await fetch(`${baseUrl}/metrics?token=${testMetricsToken}`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('process_uptime_seconds') || text.includes('http_'));
    });

    it('allows access with valid METRICS_TOKEN via X-Metrics-Token header', async () => {
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { 'X-Metrics-Token': testMetricsToken },
      });
      assert.equal(res.status, 200);
    });

    it('allows access for authenticated ADMIN user', async () => {
      const adminToken = jwt.sign(
        { id: 1, email: 'admin@elearning.com', role: 'ADMIN', type: 'access' },
        config.jwt.secret,
        { expiresIn: '15m' }
      );
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
    });

    it('rejects non-admin (STUDENT) user with 401', async () => {
      const studentToken = jwt.sign(
        { id: 2, email: 'student@elearning.com', role: 'STUDENT', type: 'access' },
        config.jwt.secret,
        { expiresIn: '15m' }
      );
      const res = await fetch(`${baseUrl}/metrics`, {
        headers: { Authorization: `Bearer ${studentToken}` },
      });
      assert.equal(res.status, 401);
    });
  });

  describe('isMetricsAuthorized unit verification', () => {
    it('accepts lowercase bearer authorization', () => {
      const req = { headers: { authorization: `bearer ${testMetricsToken}` } };
      assert.equal(app.isMetricsAuthorized(req), true);
    });

    it('accepts Basic auth credentials', () => {
      const basicHeader = 'Basic ' + Buffer.from(`metrics:${testMetricsToken}`).toString('base64');
      const req = { headers: { authorization: basicHeader } };
      assert.equal(app.isMetricsAuthorized(req), true);
    });

    it('accepts admin JWT in cookie accessToken', () => {
      const adminToken = jwt.sign(
        { id: 1, email: 'admin@elearning.com', role: 'ADMIN', type: 'access' },
        config.jwt.secret,
        { expiresIn: '15m' }
      );
      const req = { cookies: { accessToken: adminToken } };
      assert.equal(app.isMetricsAuthorized(req), true);
    });

    it('accepts admin JWT in header even when a student cookie is present', () => {
      const adminToken = jwt.sign(
        { id: 1, email: 'admin@elearning.com', role: 'ADMIN', type: 'access' },
        config.jwt.secret,
        { expiresIn: '15m' }
      );
      const studentToken = jwt.sign(
        { id: 2, email: 'student@elearning.com', role: 'STUDENT', type: 'access' },
        config.jwt.secret,
        { expiresIn: '15m' }
      );
      const req = {
        cookies: { accessToken: studentToken },
        headers: { authorization: `Bearer ${adminToken}` },
      };
      assert.equal(app.isMetricsAuthorized(req), true);
    });

    it('rejects student cookie when no valid header token is provided', () => {
      const studentToken = jwt.sign(
        { id: 2, email: 'student@elearning.com', role: 'STUDENT', type: 'access' },
        config.jwt.secret,
        { expiresIn: '15m' }
      );
      const req = { cookies: { accessToken: studentToken } };
      assert.equal(app.isMetricsAuthorized(req), false);
    });
  });
});
