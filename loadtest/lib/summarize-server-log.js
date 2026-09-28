'use strict';

/**
 * summarize-server-log.js
 * Reads a server log file that contains the logger.js `[RESPONSE] {json}` one-liners
 * and prints per-path latency percentiles + a status breakdown.
 *
 * Usage: node loadtest/lib/summarize-server-log.js loadtest/results/server-l1.log
 *
 * This is a read-only analysis helper for the load-test stages: it answers
 * "which endpoint was slow under load" from data the app already emitted.
 */

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('usage: node loadtest/lib/summarize-server-log.js <server-log>');
  process.exit(1);
}

const abs = path.resolve(process.cwd(), file);
const text = fs.readFileSync(abs, 'utf8');

const rows = [];
for (const line of text.split(/\r?\n/)) {
  if (!line.startsWith('[RESPONSE]') && !line.startsWith('[ERROR]')) continue;
  const brace = line.indexOf('{');
  if (brace === -1) continue;
  try {
    rows.push(JSON.parse(line.slice(brace)));
  } catch {
    /* skip malformed line */
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return Math.round(sorted[idx]);
}

const byPath = new Map();
for (const r of rows) {
  const key = `${r.method || '?'} ${String(r.path || '?').replace(/\/[a-z0-9]{10,}$/i, '/:slug')}`;
  if (!byPath.has(key)) byPath.set(key, []);
  byPath.get(key).push({ ms: Number(r.durationMs) || 0, status: r.status });
}

console.log(`\nfile: ${abs}`);
console.log(`parsed ${rows.length} request lines\n`);

const summary = [...byPath.entries()]
  .map(([key, list]) => {
    const sorted = list.map((x) => x.ms).sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
    const errors = list.filter((x) => x.status >= 500).length;
    return {
      endpoint: key,
      n: sorted.length,
      avgMs: avg,
      medMs: pct(sorted, 0.5),
      p95Ms: pct(sorted, 0.95),
      maxMs: sorted[sorted.length - 1],
      errors5xx: errors,
    };
  })
  .sort((a, b) => b.p95Ms - a.p95Ms);

console.log('endpoint'.padEnd(46), 'n'.padStart(5), 'avg'.padStart(7), 'med'.padStart(7), 'p95'.padStart(7), 'max'.padStart(7), '5xx'.padStart(5));
for (const s of summary) {
  console.log(
    s.endpoint.padEnd(46),
    String(s.n).padStart(5),
    String(s.avgMs).padStart(7),
    String(s.medMs).padStart(7),
    String(s.p95Ms).padStart(7),
    String(s.maxMs).padStart(7),
    String(s.errors5xx).padStart(5)
  );
}

const statuses = new Map();
for (const r of rows) statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
console.log('\nstatus breakdown:', [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}=${v}`).join(' '));

const allSorted = rows.map((r) => Number(r.durationMs) || 0).sort((a, b) => a - b);
console.log(`overall: avg=${Math.round(allSorted.reduce((s, v) => s + v, 0) / (allSorted.length || 1))}ms med=${pct(allSorted, 0.5)}ms p95=${pct(allSorted, 0.95)}ms max=${allSorted[allSorted.length - 1]}ms`);

// Auth sanity: a cookie-authenticated run must carry a userId on the
// authenticated routes. All-null userIds mean the mix measured 401 paths.
const authed = rows.filter((r) => r.userId !== null && r.userId !== undefined);
console.log(`authenticated (userId present): ${authed.length}/${rows.length} (${((authed.length / (rows.length || 1)) * 100).toFixed(1)}%)`);
const byPathAuth = new Map();
for (const r of authed) byPathAuth.set(r.path, (byPathAuth.get(r.path) || 0) + 1);
console.log('authenticated paths:', [...byPathAuth.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
