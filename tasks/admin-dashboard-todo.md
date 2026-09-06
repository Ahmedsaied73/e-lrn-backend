# 🧭 Task Tracking: Admin Dashboard (Admin Console)

Source plan: `plans/admin-dashboard-plan.md` (EXECUTING)

## Status: EXECUTING — P1 + P2 COMPLETE; P3 Quiz ops + Enrollments NEXT

---

## ⚠️ Incident log (this workspace session)

**Data-loss incident — 2026-09-06:** A browser CRUD test for the courses page accidentally deleted course #1 ("Sequential Access Test Course"). Root cause: `GET /courses` had **no `?search=` support** (the admin page sent it, backend silently ignored it), so the table showed ALL courses and edit/delete hit the first row. FK cascade also removed its 3 Bunny videos (local + remote), quizzes, attempts, certificates, and 14 enrollments (users survived).

**Fixed:** added `?search=` (title contains) to `getAllCourses` (commit `0d2f5fd`).

**Recovered:** `scripts/uploadDemoVideos.js` recreated course #8 "Sequential Access Test Course" with 3 READY Bunny videos (bunnyVideo ids 4/5/6) + re-enrolled the `seqaccess@localhost.test` test student — **10/10 sequential-access assertions PASS**. Quizzes on the videos were cascade-deleted and are **NOT restored** (manual re-creation via quiz authoring UI if wanted). The accidental CRUD-test course (id 4) was deleted. Leftover `UI Upload Test *` videos from UI lifecycle tests cleaned via API (remote + DB).

**Lesson:** any new admin table exposing delete MUST verify server-side search/filter works FIRST; never run a delete-scripted browser test against an unfiltered first row.

---

## Phase 0 — Foundation: design system + admin namespace + shell + Overview

- [x] **T0.1 [BE]** `src/routes/adminRoutes.js` mounted at `/admin` (`authenticateToken, authorizeAdmin()`); `adminController.getDashboardStats` → `GET /admin/dashboard` (counts, alerts, recent lists; parallel `prisma.count()`; `take: 5`) — **API test 12/12 PASS (401/403/200, counts numeric, status maps, arrays, no secret leaks); commit `1e6db02` (BE)**
- [x] **T0.2 [FE]** `app/admin/layout.tsx` + `<AdminSidebar>` (6 sections, active highlight) inside `.admin-console`; `app/admin/page.tsx` KPI `StatCard`s + alerts + recent lists with skeletons; `services/adminDashboardService.ts`; `types/api.ts` — **Playwright PASS (shell, dark console, nav items, KPIs; student redirected off /admin); commit `021f036` (FE)**
- [x] **T0.3 [FE]** restyle legacy quiz admin pages (authoring/exemptions/attempts) onto the design system — **Playwright PASS on `/admin/quizzes/3`, `/admin/quizzes/3/access`, `/admin/quizzes/quiz/3/attempts`** (dark cards render, 3 GRADING attempts listed, no page errors)

**Checkpoint P0:** API script passes; Overview renders real data in browser; existing quiz admin pages restyled + still working behind the shell. ✅

---

## Phase 1 — Students

- [x] **T1.1 [BE]** `getAllUsers` gained `?role=&grade=&search=&sort=` filters (`search` case-insensitive on MySQL, no `mode`), `lastLoginAt` in safe select; `deleteUser` = transactional cascade (quizAttempt, gateExemption, assignmentAnswer, submission, bunnyVideoProgress, videoProgress, enrollment, payment, certificate, then user) + **409-guard** course owners — **scripts/testAdminUsers.js 11/11 PASS; commit `b67e395` (BE)**
- [x] **T1.2 [FE]** `app/admin/students/page.tsx` — TanStack DataTable (id/name/email/grade/role/lastLogin/createdAt), server filters (role/grade/search) + sort + pagination, edit dialog (`PUT /user/:id`), delete via `ConfirmDialog` (`DELETE /user/:id`); shared `DataTable`/`ConfirmDialog`; `adminUsersService`; `apiClient.getFull()` for paginated `meta`; **@tanstack/react-table v9 → v8 (stable API)** — **Playwright 12/12 PASS; commit `317ad20` (FE)**

**Checkpoint P1:** API filter test passes; student CRUD verified in browser. ✅

---

## Phase 2 — Content: Courses + Videos

- [x] **T2.1 [BE+FE]** `GET /courses` gains `_count{videos,enrollments}` + `category` create/update support (commit `784d438`, `testAdminCourses.js` 13/13) then `?search=` title filter (commit `0d2f5fd`, 14/14); FE `app/admin/courses/page.tsx` + `services/adminCoursesService.ts` + `AdminCourse` types — **Playwright 12/12 smoke + 5/5 CRUD-through-UI (create → search → edit → delete, only tagged row touched); commit `6bbd357` (FE)**
- [x] **T2.2 [FE]** `app/admin/courses/[id]/videos/page.tsx` + `services/adminVideoService.ts` — status `StatusBadge` + progress + `failureReason`, create, **binary upload via new `apiClient.postFormData` (FormData, no JSON Content-Type)**, reorder (up/down), delete w/ remote Bunny cleanup, re-upload path from FAILED — **Playwright 9/9 lifecycle PASS (create → upload real 2MB clip → row appears → reorder → delete → server-side confirm = 3 READY remain, no page errors); commit `de3c58f` (FE)**
- [x] **Recovery:** demo course restored via `scripts/uploadDemoVideos.js` (course #8, 3 READY videos, 10/10 assertions)

**Checkpoint P2:** course CRUD + video lifecycle verified in browser; demo course restored. ✅

---

## Phase 3 — Quiz ops + Enrollments

- [ ] **T3.1 [BE]** `quizController.listAllQuizzes` (`GET /admin/quizzes`, searchable, paginated, counts); `quizController.listAllAttempts` (`GET /admin/attempts`, `?status=`, paginated, student name/email + quiz title; NO `answerKey` leak)
- [ ] **T3.2 [BE]** `enrollmentController.listAllEnrollments` (`GET /admin/enrollments`, filters course/student/paid/completed, pruned)
- [ ] **T3.3 [FE]** `app/admin/quizzes/page.tsx` (index → drill into existing authoring/attempts pages); `app/admin/grading/page.tsx` (global GRADING inbox, shared grading form)
- [ ] **T3.4 [FE]** `app/admin/enrollments/page.tsx` (table + filters, badges); ensure every sidebar link (incl. existing exemption page) resolves

**Checkpoint P3:** all 6 sections functional in browser; BE scripts pass; no student quiz-flow regression.

---

## Phase 4 — Polish (nice-to-haves)

- [ ] **T4.1 [FE]** Overview charts (recharts + `ui/chart.tsx`, `next/dynamic`)
- [ ] **T4.2 [FE]** DataTable column filters/sort polish; CSV export (papaparse) for users/enrollments
- [ ] **T4.3 [FE+BE?]** Assignments admin + certificates admin (deferred — only on request)
- [ ] **T4.4 [FE+BE?]** Admin user management / password reset (deferred)

**Checkpoint P4:** full console reviewed end-to-end (REVIEW + Playwright); FE handoff doc updated with any cross-feature contract changes.

---

## Cross-cutting

- [x] `@tanstack/react-table@^8.21.3` added to FE `package.json`
- [x] `types/api.ts` + `types/admin.ts` extended per section
- [ ] AGENTS.md + `plans/frontend-handoff.md` updated at the end
- [x] No uncommitted FE WIP touched (`course/[id]/*`, `subscribe/*`, `video/[video]/page.tsx`, `bunnyVideoService.ts`, `next.config.js`)
- [ ] Full diff REVIEW (breaking changes, security, conventions) before P4

## Active session notes

- **BE dev server**: no supervisor; `Start-Process node app.js -Redirect* server*.log` from repo root; rate limiter (100 req/15min global) resets on restart; keep request counts low when probing. Current listener ~PID from `netstat -ano | findstr :3005`.
- **Playwright**: `node "C:/Users/Ahmed Saied/.agents/skills/playwright-skill/run.js" <test>` with workdir `L:\E-LRN-FRONTEND\a-e-lrn-frontend`; FE dev on :3000.
- **Test artifacts to avoid**: seeded `pw_*`/`probe_*` users cleaned via `cleanup-users.js`; upload-test videos cleaned via API.