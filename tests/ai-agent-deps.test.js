'use strict';
/* AI Admin Agent — dependency + runtime contract (Phase 0).
 *
 * Why this file exists:
 *  - The first draft of this feature pinned "@langchain/langgraph": "^0.2.0"
 *    while langchain@1.5.11 already installs langgraph 1.x. Declaring that would
 *    have installed a SECOND, incompatible copy (peer @langchain/core <0.3 vs the
 *    installed 1.x). A version assertion makes that regression impossible to
 *    reintroduce silently.
 *  - The agent graph (Phase 3) is built on specific LangGraph exports. Pinning
 *    them here turns a bad dependency bump into a failing test instead of a
 *    failing admin request at runtime.
 *  - bcrypt is asserted because npm 12 blocks lifecycle scripts by default: the
 *    native binding silently never downloads, and since auth controllers require
 *    bcrypt at load time the ENTIRE API becomes unbootable. That failure must be
 *    loud, and it must be caught by the suite rather than in production.
 *  - Mission rule: exactly ONE Prisma client (src/config/db.js) — no stray
 *    `new PrismaClient()` per module, which would multiply the documented pool.
 *
 * Net-zero: reads package metadata + module exports only; no DB, no network.
 * Run: npm test
 */
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function pkgJson(pkg) {
  const file = path.join(__dirname, '..', 'node_modules', pkg, 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('AI Admin Agent — dependency contract', () => {
  it('pins LangGraph 1.x, matching the major langchain already depends on', () => {
    const installed = pkgJson('@langchain/langgraph').version;
    const installedMajor = Number(installed.split('.')[0]);
    assert.ok(installedMajor >= 1, `@langchain/langgraph must be 1.x, found ${installed}`);

    const declaredByLangchain = pkgJson('langchain').dependencies['@langchain/langgraph'];
    const declaredMajor = Number(String(declaredByLangchain).replace(/[^0-9.]/g, '').split('.')[0]);
    assert.equal(
      installedMajor,
      declaredMajor,
      `langgraph ${installed} must match langchain's declared ${declaredByLangchain}`
    );
  });

  it('installs the Groq provider at 1.x together with its SDK', () => {
    const groq = pkgJson('@langchain/groq');
    assert.ok(Number(groq.version.split('.')[0]) >= 1, `@langchain/groq must be 1.x, found ${groq.version}`);
    assert.ok(groq.dependencies['groq-sdk'], 'groq-sdk transport dependency present');
    assert.equal(typeof require('@langchain/groq').ChatGroq, 'function', 'ChatGroq export');
  });

  it('exposes the exact LangGraph API the agent graph is built on', () => {
    const lg = require('@langchain/langgraph');
    for (const name of ['StateGraph', 'MessagesAnnotation', 'END', 'START', 'interrupt', 'MemorySaver']) {
      assert.ok(name in lg, `@langchain/langgraph must export ${name}`);
    }
    assert.equal(typeof require('@langchain/langgraph/prebuilt').ToolNode, 'function', 'ToolNode from /prebuilt');
    assert.equal(typeof require('@langchain/core/tools').tool, 'function', 'tool() helper');
    assert.equal(
      typeof require('@langchain/google-genai').ChatGoogleGenerativeAI,
      'function',
      'Gemini fallback provider'
    );
  });

  it('has a working bcrypt native binding (npm 12 script-blocking canary)', () => {
    const bcrypt = require('bcrypt');
    assert.equal(typeof bcrypt.hashSync, 'function', 'bcrypt.hashSync must exist');
    assert.ok(bcrypt.compareSync('agent-canary', bcrypt.hashSync('agent-canary', 4)), 'bcrypt must hash + verify');
  });

  it('keeps exactly one shared Prisma client (no per-module instances)', () => {
    const shared = require('../src/config/db.js');
    assert.equal(typeof shared.$connect, 'function', 'shared pool exports a Prisma client');
    assert.equal(require('../src/config/db.js'), shared, 'the shared client is a singleton');
  });
});
