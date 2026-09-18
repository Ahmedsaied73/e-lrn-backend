# Bunny.net Video Streaming Integration — Engineering Spec

## Role
Senior/Staff Software Engineer (20+ yrs), acting as backend architect. Own correctness, security, reliability, maintainability, observability, and testing — not just "make it work."

## Operating Principle
**Plan → Implement → Test → Document → Commit**, per milestone. Never skip repo analysis, tests, or docs. Extend the existing architecture; don't fork a parallel one without a documented reason.

**Conflict rule:** if anything in this spec conflicts with the project's existing architecture, conventions, or patterns, **the project wins, not this spec.** This document states intent and requirements — it is not a mandate to override how the codebase already works. When a conflict shows up, flag it, explain the trade-off in one line, and default to the existing convention unless there's a clear, documented engineering reason to deviate.

## Objective
Implement the full Bunny Stream video lifecycle: admin creates video → backend creates Bunny video object → backend streams upload to Bunny → Bunny encodes → webhook confirms → local state updates → READY → student requests playback → auth + enrollment + course/video checks → signed Bunny embed access → frontend renders player.

---

## Phase 0 — Repository Analysis (required before any code)
Inspect and document before implementing:
- Framework, language, module layout
- Auth/authz architecture
- DB + ORM (check for an existing `Video` model — extend, don't duplicate)
- Error handling, validation, logging, testing, API-doc conventions
- Related domains: courses, enrollments, users/roles, existing uploads
- Reusable infra vs. gaps

Produce a short implementation plan before writing feature code.

---

## Data Model

### Video Lifecycle (state machine — enforced in the domain/service layer, never in controllers)
| State | Meaning | Valid transitions |
|---|---|---|
| PENDING | Record created, no upload yet | → UPLOADING, → FAILED |
| UPLOADING | Binary streaming to Bunny | → PROCESSING, → FAILED |
| PROCESSING | Bunny encoding | → READY, → FAILED |
| READY | Playable | terminal |
| FAILED | Terminal error state | terminal (may allow re-upload per business rule) |

Upload success ≠ playback-ready — track upload state and Bunny processing state as distinct concerns.

### Video entity (extend existing model if one exists)
`id, courseId, title, bunnyVideoId (unique), bunnyLibraryId, status, duration, width, height, processingProgress, thumbnailUrl, failureReason, createdAt, updatedAt`

Add FKs, a unique constraint on `bunnyVideoId`, and indexes matched to real query patterns (e.g. `courseId`, `status`). Ship a reviewed, non-destructive migration.

---

## Bunny Integration Layer
Isolate all Bunny HTTP calls behind a client abstraction — no raw `fetch()` in controllers or services.

```
Application Service → BunnyStreamClient → Bunny API
```

Client methods: `createVideo() · uploadVideo() · getVideo() · deleteVideo() · generatePlaybackToken() · verifyWebhookSignature()`. Use typed request/response models where the codebase supports typing, so the provider could be swapped later without touching the rest of the app.

**Config** (existing env/config system only — never hardcoded, never logged):
`BUNNY_STREAM_LIBRARY_ID · BUNNY_STREAM_API_KEY · BUNNY_STREAM_READ_ONLY_API_KEY · BUNNY_STREAM_TOKEN_KEY`. Per Bunny's current docs, the webhook signing secret **is** the library's Read-Only API key — there's no separate webhook secret to generate. Validate all four at startup if that's the project's pattern.

Use **current official Bunny Stream docs** as source of truth. Study only what's relevant per milestone, in order: Quickstart → Auth → HTTP Upload → Video API → Webhooks → Embed Player → Token Auth → TUS → Security Options.

---

## API Surface

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /courses/:courseId/videos` | Create video record + Bunny video object | Admin/Teacher, course ownership |
| `POST /videos/:videoId/upload` | Stream binary to Bunny | Admin/Teacher, video ownership, valid state |
| `POST /webhooks/bunny/stream` | Bunny status callback | HMAC signature only (internal, not user-facing) |
| `GET /videos/:videoId/playback` | Issue signed playback access | Student, enrollment + course/video relation + READY |

Layering: **Route → Middleware (auth/authz/validation/rate-limit) → Controller (HTTP only) → Service (business rules) → Repository/Integration (DB/Bunny)**. No business logic in controllers, no Bunny calls in repositories.

### Create Video
Authenticate → authorize course ownership → validate input → create Bunny video object → persist local record with Bunny IDs → return clean response (no Bunny secrets).

### Upload
- Never trust filename, extension, client-reported MIME/size, or client-supplied ownership IDs — validate server-side.
- Stream, don't buffer: no full-file memory loads, no base64 re-encoding, binary passthrough to Bunny.
- Enforce size/type limits; check Node/proxy/Nginx/LB request and timeout limits.
- Transition `PENDING → UPLOADING` before send; on Bunny failure, disconnect, or timeout, destroy the stream and record `FAILED` with a reason.
- Current Bunny HTTP upload has no resume — document TUS as the migration path for files >2GB or unstable connections.

### Distributed Failure Handling
Two systems, no shared transaction — define explicit compensation:
- Bunny create succeeds, DB insert fails → attempt Bunny cleanup (delete), log clearly.
- DB record exists, Bunny upload fails → mark `FAILED`, preserve for retry/inspection.

Document the consistency model. Note (don't necessarily build) the path toward an outbox/retry-queue/reconciliation job if scale later demands it.

### Webhook (`POST /webhooks/bunny/stream`)
1. Read the **raw** body — never parse before verifying.
2. Check `X-BunnyStream-Signature-Version: v1` and `-Algorithm: hmac-sha256`.
3. Verify `HMAC-SHA256(rawBody, webhookSecret)` with **constant-time** comparison.
4. Only then parse JSON and validate payload shape.
5. Look up the local video by `bunnyVideoId`; map Bunny's numeric `Status` (0–10) → domain status — treat 3/4 (Finished/Resolution finished) as READY, 5 (Failed) as FAILED, 0–2 as PROCESSING, ignore 6–10 (presigned-upload/caption/metadata events) unless you need them; update metadata.
6. **Idempotent**: repeated identical events (e.g. duplicate `READY`) must not corrupt state.
7. Respond safely; never trust the payload pre-verification.

### Reconciliation
Videos stuck in `PROCESSING` past a threshold should be reconcilable: scheduled job → Bunny `GET video` → compare and repair local status. Implement if job infra exists; otherwise document the requirement and expected behavior.

### Playback
Authenticate (server-side identity only — never trust body/query `userId`) → load video → load course → verify enrollment → verify video belongs to course → verify `status === READY` → generate signed Bunny embed access → return a minimal payload:

```json
{ "success": true, "data": { "videoId": "...", "playbackUrl": "...", "expiresAt": 1737000000 } }
```

Match the existing response envelope if one exists. Never return Bunny API keys or token-signing secrets. Re-check authorization on every request — guard explicitly against IDOR; a guessable ID must never imply access.

---

## Security Checklist
- [ ] Every endpoint enforces authN; sensitive ones enforce authZ (ownership/enrollment)
- [ ] All input validated: body, params, query, file metadata, size
- [ ] Upload: size/type limits, abort/timeout handling, no memory blowup
- [ ] No secrets in code, logs, responses, or frontend bundle
- [ ] Webhook: version + algorithm pinned, raw-body HMAC, constant-time compare
- [ ] No client-supplied ownership/user IDs trusted anywhere

## Error Handling
Use the existing centralized error framework — no ad-hoc `res.status(500)` scattered across controllers. Stable, machine-readable codes, e.g.:
`VIDEO_NOT_FOUND · COURSE_NOT_FOUND · VIDEO_ACCESS_DENIED · COURSE_ACCESS_DENIED · VIDEO_NOT_READY · INVALID_VIDEO_STATE · VIDEO_UPLOAD_FAILED · BUNNY_API_ERROR · BUNNY_WEBHOOK_INVALID_SIGNATURE · INVALID_VIDEO_FILE · VIDEO_TOO_LARGE`
Never leak provider secrets or infra details in error responses.

## Logging
Use the existing logger. Emit: `video.created · video.upload.started/completed/failed · video.processing.started/completed/failed · bunny.webhook.received/rejected · video.playback.authorized/denied`, tagged with `videoId, courseId, userId, bunnyVideoId`. Never log API keys, JWTs, auth headers, or playback tokens.

## Performance
Index for real query patterns, avoid N+1s, stream uploads (no buffering), watch Bunny call latency/timeouts. No speculative caching without a justified case.

---

## Testing Matrix
| Layer | Cover |
|---|---|
| Unit | course ownership, enrollment checks, state-machine transitions, file validation |
| Integration | service + repository + DB |
| API | 200/201/400/401/403/404/409/422/500 as applicable |
| Webhook | valid/invalid/missing signature, wrong version/algorithm, malformed body, unknown video, READY/FAILED events, duplicate delivery |
| Upload | valid file, oversized, wrong type, Bunny failure, client disconnect, stream failure, DB failure post-Bunny-create |
| Playback | unauthenticated, not enrolled, not READY, authorized success, IDOR attempt |

## API Documentation
For every new/changed endpoint, document: purpose, method, URL, auth, authz, path/query params, headers, request body + content-type, multipart fields/allowed types/max size, success + error responses with codes, example request/response. Document the webhook as an internal provider callback, not a public API. Spec the playback response precisely enough for the frontend to wire up the Bunny Embed Player directly.

## Git Discipline
Commit per logical milestone, not one giant commit; each commit compiles and passes relevant tests. Conventional messages, e.g.:
`feat(video): add bunny stream video creation` · `feat(video): add backend upload flow` · `feat(video): add webhook processing` · `feat(video): add secure playback endpoint` · `test(video): cover playback authorization` · `docs(api): document video streaming endpoints`

Never commit `.env`, credentials, tokens, or large test media. Inspect diff, run tests, and lint before each commit.

Suggested milestones: schema/migration → Bunny client → create-video flow → upload flow → webhook → playback → security hardening → tests → docs.

---

## Definition of Done
- [ ] Repo architecture inspected and reused (not forked)
- [ ] Schema/migration reviewed, non-destructive
- [ ] Bunny calls isolated in the integration layer
- [ ] Secrets config-driven, never logged or returned
- [ ] Create, upload, webhook, and playback flows implemented end-to-end
- [ ] State machine enforced centrally; webhook idempotent
- [ ] Reconciliation path implemented or explicitly documented
- [ ] IDOR/authZ verified on playback and upload
- [ ] Centralized error codes; no ad-hoc HTTP error handling
- [ ] Logging in place without leaking secrets
- [ ] Unit, integration, API, webhook, upload, and playback tests passing
- [ ] API docs updated for all new endpoints
- [ ] Milestone commits clean; no secrets or unrelated changes committed
- [ ] Full end-to-end scenario verified: admin create → upload → webhook → READY → student playback

## Final Report (required on completion)
Summarize: changes made, files touched, DB changes, endpoints added/changed, Bunny integration points, security decisions, tests added, docs updated, known limitations, future improvements, commit/milestone log. Only report what was actually verified in the repo — no unverified claims.
