# 🧭 Task Tracking: Admin Dashboard (Admin Console)

Source plan: `plans/admin-dashboard-plan.md` (EXECUTING)

## Status: EXECUTING — Phase 0 (T0.1 done; T0.0/T0.2 next)

---

## Phase 0 — Foundation: design system + admin namespace + shell + Overview

- [ ] **T0.0 [FE]** `.admin-console` scoped dark tokens in `globals.css` (ui-pro-max palette → shadcn tokens); Fira Code/Fira Sans for admin scope; student app stays light
- [x] **T0.1 [BE]** `src/routes/adminRoutes.js` mounted at `/admin` (`authenticateToken, authorizeAdmin()`); `adminController.getDashboardStats` → `GET /admin/dashboard` (counts, alerts, recent lists; parallel `prisma.count()`; `take: 5`) — **API test 12/12 PASS (401/403/200, counts numeric, status maps, arrays, no secret leaks)**
- [ ] **T0.2 [FE]** `app/admin/layout.tsx` + `<AdminSidebar>` (6 sections, active highlight) inside `.admin-console`; `app/admin/page.tsx` KPI `StatCard`s + alerts + recent lists with skeletons; `services/adminDashboardService.ts`; `types/api.ts`
- [ ] **T0.3 [FE]** restyle legacy quiz admin pages (authoring/exemptions/attempts) onto the design system; extract shared `StatusBadge`

**Checkpoint P0:** API script passes; Overview renders real data in browser; existing quiz admin pages restyled + still working behind the shell.

---

## Phase 1 — Students

- [ ] **T1.1 [BE]** Extend `userController.getAllUsers`: `?role=&grade=&search=&sort=` filters; verify/prune `password`/`refreshToken`; verify `deleteUser` cascade safety
- [ ] **T1.2 [FE]** `app/admin/students/page.tsx` w/ `DataTable<T>` (tanstack): filters, pagination, sort, view-detail dialog, edit (`react-hook-form`+`zod`+`ui/form`), delete (`ConfirmDialog`)

**Checkpoint P1:** user filter API test passes; student list/edit/delete verified in browser.

---

## Phase 2 — Content: Courses + Videos

- [ ] **T2.1 [FE]** `app/admin/courses/page.tsx`: courses table (counts via `_count`), create/edit dialog, delete confirm; `services/adminCoursesService.ts` (reuses existing `POST/PUT/DELETE /courses`)
- [ ] **T2.2 [FE]** `app/admin/courses/[id]/videos/page.tsx`: video status `StatusBadge`, upload, reorder, delete, re-upload from FAILED; `services/adminVideoService.ts` (check current `bunnyVideoService.ts` upload pattern first)

**Checkpoint P2:** course CRUD + video lifecycle verified in browser (against course #1), upload path verified.

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

- [ ] `@tanstack/react-table` added to FE `package.json`
- [ ] `types/api.ts` extended per section
- [ ] AGENTS.md + `plans/frontend-handoff.md` updated at the end
- [ ] No uncommitted FE WIP touched (`course/[id]/*`, `subscribe/*`, `video/[video]/page.tsx`, `bunnyVideoService.ts`, `next.config.js`)
- [ ] Full diff REVIEW (breaking changes, security, conventions) before P4