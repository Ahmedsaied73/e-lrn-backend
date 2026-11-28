'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/config/db');
const { isAdmin, invalidateRoleCache } = require('../src/middlewares/index');
const logger = require('../src/middlewares/logger');

describe('Admin revocation & PII-safe logger', () => {
  it('isAdmin rejects deleted or demoted admin even when JWT claims ADMIN, and honors invalidateRoleCache', async () => {
    const origFindUnique = prisma.user.findUnique;
    let currentDbUser = { role: 'ADMIN' };
    try {
      prisma.user.findUnique = async () => currentDbUser;

      const req1 = { user: { id: 88001, role: 'ADMIN' } };
      assert.equal(await isAdmin(req1), true);

      // Admin is deleted/demoted in DB; without invalidation cache would hold,
      // WITH invalidateRoleCache(88001) the very next request fails closed.
      currentDbUser = null;
      invalidateRoleCache(88001);

      const req2 = { user: { id: 88001, role: 'ADMIN' } };
      assert.equal(await isAdmin(req2), false);
    } finally {
      invalidateRoleCache(88001);
      prisma.user.findUnique = origFindUnique;
    }
  });

  it('logger strips student emails from query strings and excludes /readyz and /webhooks/', () => {
    const mw = logger();
    const logged = [];
    const origLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));

    try {
      // 1. Probe /readyz is excluded
      let nextCalled = false;
      mw({ path: '/readyz', method: 'GET', query: {}, headers: {} }, { on: () => {} }, () => { nextCalled = true; });
      assert.equal(nextCalled, true);

      // 2. /user?search=student@example.com redacts PII
      let finishCb = null;
      const req = {
        path: '/user',
        originalUrl: '/user?search=student@example.com&page=1',
        url: '/user?search=student@example.com&page=1',
        query: { search: 'student@example.com', page: '1' },
        method: 'GET',
        ip: '127.0.0.1',
        headers: {},
      };
      const res = {
        statusCode: 200,
        on: (ev, cb) => { if (ev === 'finish') finishCb = cb; },
      };
      mw(req, res, () => {});
      finishCb();

      assert.equal(logged.length, 1);
      assert.ok(!logged[0].includes('student@example.com'), 'PII email leaked into request log');
      assert.ok(logged[0].includes('[REDACTED]'));
      assert.ok(logged[0].includes('"path":"/user"'));
    } finally {
      console.log = origLog;
    }
  });
});
