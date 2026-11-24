'use strict';

/**
 * Unit tests for Bunny HLS caching, token quantization, cacheConfig, and telemetry.
 * Run: node --test tests/bunny-caching.test.js
 */

process.env.REDIS_ENABLED = 'false';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const https = require('https');
const { EventEmitter } = require('events');

const config = require('../src/config/env');
const cache = require('../src/integrations/redis/cache');
const bunnyClient = require('../src/integrations/bunny/bunnyStreamClient');
const bunnyVideoService = require('../src/services/bunnyVideoService');
const {
  getBunnyVideoPlayback,
  recordVideoTelemetry,
  validateTelemetryPayload,
} = require('../src/controllers/bunnyVideoController');

function createMockRes() {
  return {
    statusCode: 200,
    _json: null,
    _ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this._json = data;
      return this;
    },
    end() {
      this._ended = true;
      return this;
    },
  };
}

describe('Bunny token quantization', () => {
  it('quantizes expiresAt to 1-hour (3600s) boundaries and signs SHA256(key + id + expiresAt)', () => {
    const beforeSec = Math.floor(Date.now() / 1000);
    const ttl = 21600;
    const { token, expiresAt } = bunnyClient.generatePlaybackToken('vid-guid-123', ttl);
    const afterSec = Math.floor(Date.now() / 1000);

    assert.equal(expiresAt % 3600, 0);
    const minExpected = Math.ceil((beforeSec + ttl) / 3600) * 3600;
    const maxExpected = Math.ceil((afterSec + ttl) / 3600) * 3600;
    assert.ok(expiresAt >= minExpected && expiresAt <= maxExpected);

    const expectedToken = crypto
      .createHash('sha256')
      .update(process.env.BUNNY_STREAM_TOKEN_KEY + 'vid-guid-123' + expiresAt)
      .digest('hex');
    assert.equal(token, expectedToken);
  });
});

describe('fetchHlsPlaylistUrl hardening', () => {
  const origHttpsGet = https.get;
  const origFrontendUrl = process.env.FRONTEND_URL;
  const origWarn = console.warn;

  afterEach(() => {
    https.get = origHttpsGet;
    if (origFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = origFrontendUrl;
    console.warn = origWarn;
  });

  it('sends Referer header from FRONTEND_URL and extracts urlPlaylistUrl', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com, http://localhost:3000';
    let capturedOpts = null;

    https.get = (_url, opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      process.nextTick(() => {
        cb(res);
        res.emit('data', "<script>var urlPlaylistUrl = 'https://vz.b-cdn.net/vid/playlist.m3u8';</script>");
        res.emit('end');
      });
      return new EventEmitter();
    };

    const url = await bunnyClient.fetchHlsPlaylistUrl('123', 'vid-1', 'tok', 1900000000);
    assert.equal(capturedOpts.headers.Referer, 'https://app.example.com');
    assert.equal(url, 'https://vz.b-cdn.net/vid/playlist.m3u8');
  });

  it('logs structured warning and returns null on non-200 or regex mismatch', async () => {
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));

    https.get = (_url, _opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 403;
      res.resume = () => {};
      process.nextTick(() => cb(res));
      return new EventEmitter();
    };
    const r403 = await bunnyClient.fetchHlsPlaylistUrl('123', 'vid-2', 'tok', 1900000000);
    assert.equal(r403, null);
    assert.ok(warnings.some((w) => w.includes('bunny.hls_fetch_non_200')));

    https.get = (_url, _opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      process.nextTick(() => {
        cb(res);
        res.emit('data', '<html>no playlist here</html>');
        res.emit('end');
      });
      return new EventEmitter();
    };
    const rNoMatch = await bunnyClient.fetchHlsPlaylistUrl('123', 'vid-3', 'tok', 1900000000);
    assert.equal(rNoMatch, null);
    assert.ok(warnings.some((w) => w.includes('bunny.hls_fetch_no_match')));
  });
});

describe('resolveHlsUrl Redis caching & backward compatibility', () => {
  const origCacheGet = cache.get;
  const origCacheSet = cache.set;
  const origFetchHls = bunnyClient.fetchHlsPlaylistUrl;
  const origWarn = console.warn;

  afterEach(() => {
    cache.get = origCacheGet;
    cache.set = origCacheSet;
    bunnyClient.fetchHlsPlaylistUrl = origFetchHls;
    console.warn = origWarn;
  });

  it('stores { hlsUrl, hlsExpiresAt } with TTL = Math.max(60, remainingSeconds - 3600) and reads it back', async () => {
    const store = new Map();
    let capturedTtl = null;

    cache.get = async (k) => store.get(k) ?? null;
    cache.set = async (k, v, ttl) => {
      store.set(k, v);
      capturedTtl = ttl;
      return true;
    };
    bunnyClient.fetchHlsPlaylistUrl = async () => 'https://vz.b-cdn.net/v1/playlist.m3u8';

    const expiresAt = Math.floor(Date.now() / 1000) + 18000;
    const first = await bunnyVideoService.resolveHlsUrl('lib1', 'guid-1', 'tok', expiresAt);

    assert.deepEqual(first, {
      hlsUrl: 'https://vz.b-cdn.net/v1/playlist.m3u8',
      hlsExpiresAt: expiresAt,
    });
    assert.ok(capturedTtl >= 14390 && capturedTtl <= 14405);

    // Second call should hit Redis without calling fetchHlsPlaylistUrl
    bunnyClient.fetchHlsPlaylistUrl = async () => {
      throw new Error('should not fetch when cached');
    };
    const second = await bunnyVideoService.resolveHlsUrl('lib1', 'guid-1', 'tok', expiresAt + 3600);
    assert.deepEqual(second, {
      hlsUrl: 'https://vz.b-cdn.net/v1/playlist.m3u8',
      hlsExpiresAt: expiresAt,
    });
  });

  it('clamps Redis TTL to minimum 60 seconds when remainingSeconds < 3660', async () => {
    let capturedTtl = null;
    cache.get = async () => null;
    cache.set = async (_k, _v, ttl) => {
      capturedTtl = ttl;
      return true;
    };
    bunnyClient.fetchHlsPlaylistUrl = async () => 'https://vz.b-cdn.net/v2/playlist.m3u8';

    const expiresAt = Math.floor(Date.now() / 1000) + 1200;
    await bunnyVideoService.resolveHlsUrl('lib1', 'guid-2', 'tok', expiresAt);
    assert.equal(capturedTtl, 60);
  });

  it('gracefully handles legacy raw string in Redis', async () => {
    cache.get = async () => 'https://vz.b-cdn.net/legacy/playlist.m3u8';
    bunnyClient.fetchHlsPlaylistUrl = async () => {
      throw new Error('should not fetch');
    };

    const res = await bunnyVideoService.resolveHlsUrl('lib1', 'guid-legacy', 'tok', 1900000000);
    assert.deepEqual(res, {
      hlsUrl: 'https://vz.b-cdn.net/legacy/playlist.m3u8',
      hlsExpiresAt: null,
    });
  });

  it('logs structured warning when fetchHlsPlaylistUrl returns null', async () => {
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    cache.get = async () => null;
    bunnyClient.fetchHlsPlaylistUrl = async () => null;

    const res = await bunnyVideoService.resolveHlsUrl('lib1', 'guid-null', 'tok', 1900000000);
    assert.deepEqual(res, { hlsUrl: null, hlsExpiresAt: null });
    assert.ok(warnings.some((w) => w.includes('video.hls.resolve_failed')));
  });
});

describe('cacheConfig & playback controller payload', () => {
  const origResolveHls = bunnyVideoService.resolveHlsUrl;
  const origFindBySlug = bunnyVideoService.findBySlug;
  const origGenToken = bunnyClient.generatePlaybackToken;

  afterEach(() => {
    bunnyVideoService.resolveHlsUrl = origResolveHls;
    bunnyVideoService.findBySlug = origFindBySlug;
    bunnyClient.generatePlaybackToken = origGenToken;
  });

  it('exposes safe default segmentCache config in env.js', () => {
    assert.deepEqual(config.bunny.segmentCache, {
      enabled: false,
      maxBudgetMb: 300,
      ttlDays: 14,
    });
    assert.deepEqual(bunnyVideoService.getCacheConfig(), {
      enabled: false,
      maxBudgetMb: 300,
      ttlDays: 14,
    });
  });

  it('returns hlsExpiresAt and cacheConfig on ADMIN and gateVideo fast-paths', async () => {
    bunnyClient.generatePlaybackToken = () => ({ token: 'tok123', expiresAt: 1900000800 });
    bunnyVideoService.resolveHlsUrl = async () => ({
      hlsUrl: 'https://vz.b-cdn.net/v/playlist.m3u8',
      hlsExpiresAt: 1900000800,
    });
    bunnyVideoService.findBySlug = async () => ({
      id: 1,
      slug: 'abc123def456',
      bunnyVideoId: 'guid-a',
      bunnyLibraryId: '999',
      status: 'READY',
    });

    // ADMIN path
    const resAdmin = createMockRes();
    await getBunnyVideoPlayback(
      { params: { videoSlug: 'abc123def456' }, user: { id: 1, role: 'ADMIN' } },
      resAdmin,
      (err) => { throw err; }
    );
    assert.deepEqual(resAdmin._json.data, {
      videoSlug: 'abc123def456',
      playbackUrl: 'https://iframe.mediadelivery.net/embed/999/guid-a?token=tok123&expires=1900000800',
      hlsUrl: 'https://vz.b-cdn.net/v/playlist.m3u8',
      expiresAt: 1900000800,
      hlsExpiresAt: 1900000800,
      cacheConfig: { enabled: false, maxBudgetMb: 300, ttlDays: 14 },
    });

    // Student gateVideo fast-path
    const resGate = createMockRes();
    await getBunnyVideoPlayback(
      {
        params: { videoSlug: 'abc123def456' },
        user: { id: 2, role: 'STUDENT' },
        gateVideo: {
          id: 1,
          slug: 'abc123def456',
          bunnyVideoId: 'guid-a',
          bunnyLibraryId: '999',
          status: 'READY',
        },
      },
      resGate,
      (err) => { throw err; }
    );
    assert.deepEqual(resGate._json.data, resAdmin._json.data);
  });
});

describe('Video telemetry validation & handler', () => {
  const origLog = console.log;

  beforeEach(() => {
    console.log = origLog;
  });
  afterEach(() => {
    console.log = origLog;
  });

  const validBody = {
    videoSlug: 'abc123def456',
    playerMode: 'hls',
    deviceClass: 'desktop',
    cacheEnabled: true,
    segmentHits: 12,
    segmentMisses: 3,
    bytesFromCache: 5242880,
    bytesFromNetwork: 1048576,
    idbErrors: 0,
    ttffMs: 420,
    fallbackReason: null,
  };

  it('accepts valid telemetry payload and returns 204', () => {
    const logs = [];
    console.log = (...args) => logs.push(args.join(' '));

    const res = createMockRes();
    let nextErr = null;
    recordVideoTelemetry(
      { body: validBody, user: { id: 42 } },
      res,
      (err) => { nextErr = err; }
    );

    assert.equal(nextErr, null);
    assert.equal(res.statusCode, 204);
    assert.equal(res._ended, true);
    assert.ok(logs.some((l) => l.includes('[INFO] video.telemetry') && l.includes('"userId":42')));
  });

  it('rejects invalid payloads with 400 VALIDATION_ERROR', () => {
    const invalidCases = [
      null,
      [],
      { ...validBody, videoSlug: 'bad slug!' },
      { ...validBody, playerMode: 'dash' },
      { ...validBody, deviceClass: 'watch' },
      { ...validBody, cacheEnabled: 'true' },
      { ...validBody, segmentHits: -1 },
      { ...validBody, bytesFromCache: 1.5 },
      { ...validBody, ttffMs: -10 },
      { ...validBody, fallbackReason: 'x'.repeat(201) },
    ];

    for (const bad of invalidCases) {
      const check = validateTelemetryPayload(bad);
      assert.equal(check.ok, false);

      const res = createMockRes();
      let nextErr = null;
      recordVideoTelemetry({ body: bad, user: { id: 1 } }, res, (err) => { nextErr = err; });
      assert.equal(nextErr.statusCode, 400);
      assert.equal(nextErr.code, 'VALIDATION_ERROR');
    }
  });
});
