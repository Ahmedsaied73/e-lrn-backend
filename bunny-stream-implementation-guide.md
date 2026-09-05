# Implementation Guide — Bunny Stream on Express + Prisma + MySQL

Companion to `bunny-stream-integration-spec.md`. That file is the requirements/architecture spec (and the project always wins if the two disagree). This file is the concrete build order with real code for your stack. Paths below are examples — drop the code into wherever your project already keeps routes/controllers/services, don't create a parallel structure.

API details below are verified against Bunny's current docs (Aug 2026): Stream API reference, Webhooks, and Embed Token Authentication.

---

## 0. Bunny Dashboard Setup (one-time, before any code)

1. Create a Stream video library (or use an existing one) at dash.bunny.net.
2. From the library's **API** section, copy:
   - **Library ID**
   - **Stream API key** (full access — creates/uploads/deletes videos)
   - **Read-Only API key** — this doubles as your **webhook signing secret**. Don't confuse it with the full API key.
3. From the library's **Security** section, copy the **Token Authentication Key**, and turn on **Embed View Token Authentication**. Without this toggle, signed URLs aren't enforced and anyone with a video ID can watch it.
4. Under **Webhooks**, set the callback URL to your public endpoint, e.g. `https://api.yourapp.com/api/v1/webhooks/bunny/stream`. In dev, tunnel it (ngrok/Cloudflare Tunnel) — Bunny needs a reachable HTTPS URL.

## 1. Environment Variables

Add to your existing `.env` / config module — don't hardcode, don't log these:

```
BUNNY_STREAM_LIBRARY_ID=
BUNNY_STREAM_API_KEY=
BUNNY_STREAM_READ_ONLY_API_KEY=
BUNNY_STREAM_TOKEN_KEY=
BUNNY_VIDEO_MAX_BYTES=5368709120   # 5GB, adjust to your plan/needs
```

If your app already validates required env vars at boot, add these four to that list.

## 2. Prisma Schema (MySQL)

Check for an existing `Video` model first — extend it, don't duplicate it. If none exists:

```prisma
enum VideoStatus {
  PENDING
  UPLOADING
  PROCESSING
  READY
  FAILED
}

model Video {
  id                 String      @id @default(uuid())
  courseId           String
  title              String
  bunnyVideoId       String      @unique
  bunnyLibraryId     String
  status             VideoStatus @default(PENDING)
  duration           Int?
  width              Int?
  height             Int?
  processingProgress Int?        @default(0)
  thumbnailUrl       String?
  failureReason      String?     @db.Text
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt

  course Course @relation(fields: [courseId], references: [id], onDelete: Cascade)

  @@index([courseId])
  @@index([status])
}
```

`bunnyVideoId` is non-nullable: by design, the row is only inserted *after* the Bunny video object exists (see §5), so there's never a valid local row without one.

```bash
npx prisma migrate dev --name add_bunny_video_fields
```

Review the generated SQL before running against anything shared — confirm the unique index and enum map cleanly to your existing MySQL version.

## 3. Bunny Integration Client

One file, no Bunny calls anywhere else in the app.

```js
// integrations/bunny/bunnyStreamClient.js
const https = require('https');
const crypto = require('crypto');

const HOST = 'video.bunnycdn.com';
const libId = () => process.env.BUNNY_STREAM_LIBRARY_ID;

class BunnyApiError extends Error {
  constructor(statusCode, body) {
    super(`Bunny API error ${statusCode}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

async function createVideo({ title, collectionId }) {
  const res = await fetch(`https://${HOST}/library/${libId()}/videos`, {
    method: 'POST',
    headers: {
      AccessKey: process.env.BUNNY_STREAM_API_KEY,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, collectionId }),
  });
  if (!res.ok) throw new BunnyApiError(res.status, await res.text());
  return res.json(); // { guid, ... }
}

async function getVideo(videoId) {
  const res = await fetch(`https://${HOST}/library/${libId()}/videos/${videoId}`, {
    headers: { AccessKey: process.env.BUNNY_STREAM_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) throw new BunnyApiError(res.status, await res.text());
  return res.json();
}

async function deleteVideo(videoId) {
  const res = await fetch(`https://${HOST}/library/${libId()}/videos/${videoId}`, {
    method: 'DELETE',
    headers: { AccessKey: process.env.BUNNY_STREAM_API_KEY },
  });
  if (!res.ok) throw new BunnyApiError(res.status, await res.text());
}

// Streams the incoming file straight through to Bunny — no buffering.
function uploadVideoStream({ videoId, fileStream }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: HOST,
        path: `/library/${libId()}/videos/${videoId}`,
        method: 'PUT',
        headers: {
          AccessKey: process.env.BUNNY_STREAM_API_KEY,
          'Content-Type': 'application/octet-stream',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(body));
          else reject(new BunnyApiError(res.statusCode, body));
        });
      }
    );
    req.on('error', reject);
    fileStream.on('error', (err) => {
      req.destroy();
      reject(err);
    });
    fileStream.pipe(req);
  });
}

// SHA256_HEX(token_key + videoId + expires) — Bunny Embed Token Auth
function generatePlaybackToken(videoId, ttlSeconds = 3600) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = crypto
    .createHash('sha256')
    .update(process.env.BUNNY_STREAM_TOKEN_KEY + videoId + expires)
    .digest('hex');
  return { token, expires };
}

// Signing secret is the library's Read-Only API key, per Bunny's webhook docs.
function verifyWebhookSignature({ rawBody, signature, version, algorithm }) {
  if (version !== 'v1' || algorithm !== 'hmac-sha256') return false;
  const expected = crypto
    .createHmac('sha256', process.env.BUNNY_STREAM_READ_ONLY_API_KEY)
    .update(rawBody, 'utf8')
    .digest('hex');
  if (typeof signature !== 'string' || signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
}

module.exports = {
  createVideo,
  getVideo,
  deleteVideo,
  uploadVideoStream,
  generatePlaybackToken,
  verifyWebhookSignature,
  BunnyApiError,
};
```

Uses Node's global `fetch` (Node 18+) for JSON calls, and `https.request` for the streamed binary PUT — streaming a request body through `fetch` needs `duplex: 'half'` and is less predictable across Node versions, so raw `https` is the safer pick here.

## 4. Create Video Flow

`POST /courses/:courseId/videos` — Bunny object created first, then the local row. If the DB insert fails, compensate by deleting the orphaned Bunny video.

```js
// services/videoService.js
async function createVideo({ courseId, title, requestedBy }) {
  await courseService.assertCanManage(courseId, requestedBy); // your existing ownership check

  const bunnyVideo = await bunnyClient.createVideo({ title });

  try {
    return await videoRepository.create({
      courseId,
      title,
      bunnyVideoId: bunnyVideo.guid,
      bunnyLibraryId: process.env.BUNNY_STREAM_LIBRARY_ID,
      status: 'PENDING',
    });
  } catch (err) {
    await bunnyClient.deleteVideo(bunnyVideo.guid).catch((cleanupErr) =>
      logger.error('bunny.cleanup.failed', { bunnyVideoId: bunnyVideo.guid, cleanupErr: cleanupErr.message })
    );
    throw err;
  }
}
```

Controller stays thin: extract `courseId`/`title`, call the service, map to your response envelope.

## 5. Upload Flow (streamed, no buffering)

`POST /videos/:videoId/upload` — parse multipart with `busboy` (streaming parser) and pipe the file part directly into the Bunny client. Don't use `multer`'s default disk/memory storage here; it buffers.

```bash
npm install busboy
```

```js
// routes/videos.js
const busboy = require('busboy');

const ALLOWED_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/x-matroska'];
const MAX_BYTES = Number(process.env.BUNNY_VIDEO_MAX_BYTES);

router.post('/videos/:videoId/upload', authenticate, loadVideoAndAuthorizeOwner, async (req, res, next) => {
  const video = req.video; // set by loadVideoAndAuthorizeOwner
  if (!['PENDING', 'FAILED'].includes(video.status)) {
    return next(new InvalidVideoStateError(video.status));
  }

  await videoService.transitionStatus(video.id, 'UPLOADING');

  const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1 } });
  let handledFile = false;

  bb.on('file', (fieldName, fileStream, info) => {
    if (fieldName !== 'video' || !ALLOWED_MIME_TYPES.includes(info.mimeType)) {
      fileStream.resume(); // drain and ignore
      return;
    }
    handledFile = true;

    fileStream.on('limit', () => bb.destroy(new Error('VIDEO_TOO_LARGE')));

    bunnyClient
      .uploadVideoStream({ videoId: video.bunnyVideoId, fileStream })
      .then(() => videoService.transitionStatus(video.id, 'PROCESSING'))
      .then(() => res.json({ success: true, data: { videoId: video.id, status: 'PROCESSING' } }))
      .catch(async (err) => {
        await videoService.markFailed(video.id, err.message);
        next(err);
      });
  });

  bb.on('error', async (err) => {
    await videoService.markFailed(video.id, err.message);
    next(err);
  });

  req.on('aborted', () => videoService.markFailed(video.id, 'Client aborted upload'));

  bb.on('finish', () => {
    if (!handledFile) next(new InvalidVideoFileError('No "video" file field found'));
  });

  req.pipe(bb);
});
```

**Nginx / proxy note:** confirm `client_max_body_size` (Nginx) or your load balancer's equivalent is raised to match `BUNNY_VIDEO_MAX_BYTES`, and that proxy/upstream read timeouts are long enough for large uploads on slow connections. This is usually the silent killer of "uploads randomly fail at ~1GB."

## 6. Webhook Handler

**Critical ordering gotcha:** this route needs the *raw* body, so it must get `express.raw()` scoped to just this path, and it must be wired before your global `express.json()` swallows the body app-wide.

```js
// app.js
app.post(
  '/api/v1/webhooks/bunny/stream',
  express.raw({ type: 'application/json', limit: '2mb' }),
  webhookController.handleBunnyWebhook
);

// ...mounted after, applies to everything else
app.use(express.json());
```

```js
// controllers/webhookController.js
async function handleBunnyWebhook(req, res) {
  const rawBody = req.body.toString('utf8');
  const valid = bunnyClient.verifyWebhookSignature({
    rawBody,
    signature: req.headers['x-bunnystream-signature'],
    version: req.headers['x-bunnystream-signature-version'],
    algorithm: req.headers['x-bunnystream-signature-algorithm'],
  });

  if (!valid) {
    logger.warn('bunny.webhook.rejected', { reason: 'invalid_signature' });
    return res.status(401).send();
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).send();
  }

  logger.info('bunny.webhook.received', { videoGuid: payload.VideoGuid, status: payload.Status });
  await videoService.applyBunnyStatus(payload.VideoGuid, payload.Status);
  res.status(200).send();
}
```

```js
// services/videoService.js
const STATUS_MAP = {
  0: 'PROCESSING', // Queued
  1: 'PROCESSING', // Processing
  2: 'PROCESSING', // Encoding
  3: 'READY',      // Finished
  4: 'READY',      // Resolution finished (first one = playable)
  5: 'FAILED',     // Failed
  // 6-10: presigned-upload lifecycle / captions / title generation — ignored unless you need them
};

async function applyBunnyStatus(bunnyVideoId, bunnyStatus) {
  const domainStatus = STATUS_MAP[bunnyStatus];
  if (!domainStatus) return;

  const video = await videoRepository.findByBunnyId(bunnyVideoId);
  if (!video) {
    logger.warn('bunny.webhook.unknown_video', { bunnyVideoId });
    return;
  }

  // Idempotency: once terminal, don't let a stale/duplicate/out-of-order event move it.
  if (video.status === 'READY' || video.status === 'FAILED') return;

  await videoRepository.updateStatus(video.id, domainStatus, {
    failureReason: domainStatus === 'FAILED' ? 'Bunny encoding failed' : undefined,
  });
}
```

## 7. Reconciliation Job

Catches videos stuck in `PROCESSING` if a webhook never arrives (dropped delivery, tunnel down in dev, etc). Use your existing job runner if you have one (Bull/BullMQ/Agenda/cron table) — only reach for `node-cron` if there's nothing already in place.

```js
// jobs/reconcileStaleVideos.js
const cron = require('node-cron');
const STALE_MINUTES = 30;

async function reconcileStaleVideos() {
  const stale = await videoRepository.findStaleProcessing(STALE_MINUTES);
  for (const video of stale) {
    try {
      const remote = await bunnyClient.getVideo(video.bunnyVideoId);
      const domainStatus = STATUS_MAP[remote.status];
      if (domainStatus && domainStatus !== video.status) {
        await videoRepository.updateStatus(video.id, domainStatus);
        logger.info('video.reconciled', { videoId: video.id, from: video.status, to: domainStatus });
      }
    } catch (err) {
      logger.error('video.reconcile.failed', { videoId: video.id, err: err.message });
    }
  }
}

cron.schedule('*/10 * * * *', reconcileStaleVideos);
```

## 8. Playback Endpoint

```js
// routes/videos.js
router.get('/videos/:videoId/playback', authenticate, async (req, res, next) => {
  try {
    const video = await videoRepository.findById(req.params.videoId);
    if (!video) throw new VideoNotFoundError();

    const enrolled = await enrollmentService.isEnrolled(req.user.id, video.courseId);
    if (!enrolled) throw new VideoAccessDeniedError();

    if (video.status !== 'READY') throw new VideoNotReadyError();

    const { token, expires } = bunnyClient.generatePlaybackToken(video.bunnyVideoId);
    const playbackUrl = `https://iframe.mediadelivery.net/embed/${video.bunnyLibraryId}/${video.bunnyVideoId}?token=${token}&expires=${expires}`;

    logger.info('video.playback.authorized', { videoId: video.id, userId: req.user.id });
    res.json({ success: true, data: { videoId: video.id, playbackUrl, expiresAt: expires } });
  } catch (err) {
    logger.info('video.playback.denied', { videoId: req.params.videoId, userId: req.user?.id, reason: err.code });
    next(err);
  }
});
```

`req.user.id` must come from your existing auth middleware's decoded token — never from params/body.

## 9. Testing

Mock `bunnyStreamClient` at the module boundary; nothing in these tests should make a real network call.

```js
// __tests__/webhook.test.js
jest.mock('../integrations/bunny/bunnyStreamClient');
const bunnyClient = require('../integrations/bunny/bunnyStreamClient');

test('rejects webhook with invalid signature', async () => {
  bunnyClient.verifyWebhookSignature.mockReturnValue(false);
  const res = await request(app)
    .post('/api/v1/webhooks/bunny/stream')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ VideoGuid: 'abc', Status: 3 }));
  expect(res.status).toBe(401);
});

test('duplicate READY events are a no-op', async () => {
  bunnyClient.verifyWebhookSignature.mockReturnValue(true);
  // seed video as already READY, send Status: 3 again, assert no second update call / no error
});
```

Cover the rest per the testing matrix in the spec file (upload failure paths, playback IDOR, state-machine transitions).

## 10. Build Order

1. Migration (`Video` model)
2. Bunny client (`bunnyStreamClient.js`)
3. Create-video flow
4. Upload flow
5. Webhook handler (get the raw-body middleware ordering right *before* wiring the route into the real app)
6. Reconciliation job
7. Playback endpoint
8. Tests
9. Docs
10. Security/perf pass — re-run the checklist in the spec file

Commit after each numbered step, per the spec's git discipline section.

## 11. Pre-Launch Checklist

- [ ] Nginx/LB `client_max_body_size` and proxy timeouts match your max upload size
- [ ] Webhook URL registered in Bunny dashboard and reachable over HTTPS from the public internet
- [ ] Embed View Token Authentication toggle is **on** in Bunny's Security settings — otherwise signed URLs aren't enforced
- [ ] All four env vars present in every environment (dev/staging/prod), none checked into git
- [ ] Alerting on a spike in `bunny.webhook.rejected` (signature failures) and on reconciliation job errors
- [ ] MySQL connection isn't held open for the duration of a large upload — only borrow one for the status-transition writes, not while streaming
