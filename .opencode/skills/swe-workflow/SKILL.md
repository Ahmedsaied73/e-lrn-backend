---
name: swe-workflow
description: "Full SWE workflow: plan → grill → execute → review → verify. Use for any non-trivial task (bug fix, feature, refactor). Combines planning, grilling, execution, code review, and Playwright verification into a single disciplined workflow."
---

# SWE Workflow

A disciplined software engineering workflow that ensures quality through planning, grilling, execution, review, and verification.

## Workflow Order

```
1. New/ambiguous task arrives
        ↓
2. PLAN  (brainstorm → write-plan)
        ↓
3. GRILL  (expose gaps, challenge assumptions)
        ↓
4. EXECUTE  (implement the plan)
        ↓
5. REVIEW  (check diff, catch mistakes)
        ↓
6. VERIFY  (Playwright — test in browser)
```

Trivial one-off asks (typo fix, single-line change, answering a question) can skip to step 4.

## Phase 1: PLAN

Before writing code, create a concrete execution plan:

1. **Understand the task**: Read relevant files, understand the domain
2. **Identify scope**: What files need to change? What's the blast radius?
3. **Write the plan**: Break into 2-5 minute tasks with clear deliverables
4. **Identify risks**: What could break? What are the dependencies?

For complex tasks, use the `general` agent to research first, then write the plan.

## Phase 2: GRILL

Challenge the plan before executing:

1. **Load the grill-me skill** if available
2. **Ask hard questions**:
   - What am I assuming that might be wrong?
   - What edge cases exist?
   - What's the blast radius of this change?
   - Are there existing patterns I should follow?
   - What's the testing strategy?
3. **Expose gaps** before they become bugs

## Phase 3: EXECUTE

Implement the plan task-by-task:

1. **Work through tasks sequentially** — complete one before starting the next
2. **Follow existing conventions** — match code style, error handling patterns
3. **Make minimal changes** — touch only what the task requires
4. **Verify each task** — run relevant checks before moving on

## Phase 4: REVIEW

Before considering any task "finished":

1. **Review the diff** — what actually changed?
2. **Check for**:
   - Breaking changes to existing APIs
   - Missing error handling
   - Security issues (secrets, injection, auth bypass)
   - Performance regressions
   - Convention violations
3. **Run lint/typecheck** if available (none configured in this repo)

## Phase 5: VERIFY

For changes that affect the running app, test in the browser:

### Using Playwright Skill

```bash
# 1. Start the dev server
npm run dev

# 2. Load the playwright-skill
# The skill is installed at: ~/.agents/skills/playwright-skill

# 3. Detect running servers
node -e "require('C:/Users/Ahmed Saied/.agents/skills/playwright-skill/lib/helpers').detectDevServers().then(s => console.log(JSON.stringify(s)))"

# 4. Write and run a test script
# Example: test login flow
```

### Playwright Test Script Template

```javascript
const { chromium } = require('playwright');
const os = require('node:os');
const path = require('node:path');

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3005';
const artifactDir = process.env.PW_ARTIFACT_DIR || os.tmpdir();

(async () => {
  const browser = await chromium.launch({ headless: false });
  try {
    const page = await browser.newPage();
    
    // Navigate
    await page.goto(TARGET_URL);
    console.log('Page loaded:', await page.title());
    
    // Take screenshot
    await page.screenshot({ 
      path: path.join(artifactDir, 'screenshot.png'), 
      fullPage: true 
    });
    
    // Add your test steps here
    
  } finally {
    await browser.close();
  }
})();
```

### Run with Playwright Skill

```bash
node "C:/Users/Ahmed Saied/.agents/skills/playwright-skill/run.js" /tmp/playwright-test-*.js
```

## Skill Integration

This workflow integrates with:

| Skill | Phase | Purpose |
|-------|-------|---------|
| `grill-me` | Phase 2 | Challenge assumptions, expose gaps |
| `playwright-skill` | Phase 5 | Browser verification |
| `general` agent | Phase 1 | Research and planning |
| `task` tool | Phase 3 | Parallel execution of independent tasks |

## Project-Specific Notes

### E-Learning Platform

- **Dev server**: `npm run dev` (port 3005)
- **Database**: MySQL 8.0 — ensure it's running before tests
- **Auth**: JWT cookies — login via `POST /auth/login` with `{ email, password }`
- **Admin**: `admin@elearning.com` / `admin123` (auto-created on startup)
- **Bunny videos**: Upload requires Bunny.net credentials in `.env`

### Common Test Scenarios

1. **Login flow**: POST to `/auth/login`, verify cookie set
2. **Course listing**: GET `/courses/`, verify response
3. **Video playback**: GET `/videos/:id/playback`, verify signed URL
4. **Quiz flow**: POST `/quizzes/videos/:id/start`, submit answers
5. **Sequential access**: Try accessing video 2 before completing video 1

### Playwright for API Testing

Playwright can also test API endpoints directly:

```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Test login API
  const response = await page.request.post('http://localhost:3005/auth/login', {
    data: {
      email: 'admin@elearning.com',
      password: 'admin123'
    }
  });
  
  console.log('Status:', response.status());
  console.log('Body:', await response.json());
  
  await browser.close();
})();
```
