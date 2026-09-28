'use strict';

/**
 * snapshot.js — plain Node.js CLI (NOT k6). Usage:
 *   node loadtest/lib/snapshot.js <label>
 *
 * Appends /metrics + /readyz payloads to loadtest/results/metrics-<label>.txt
 * and prints a one-line summary. NEVER exits non-zero — snapshots must not
 * block a test stage.
 */

const fs = require('fs');
const path = require('path');

const label = process.argv[2] || 'unlabeled';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3005'; // never `localhost`: resolves ::1 (no listener) on this box
const resultsDir = path.join(__dirname, '..', 'results');
const outFile = path.join(resultsDir, `metrics-${label}.txt`);

fs.mkdirSync(resultsDir, { recursive: true });

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function summarize(metricsText) {
  // Do NOT anchor-match a "http_requests_total" prefix line: renderPrometheus
  // emits "# TYPE http_requests_total counter" first, so the anchored exec
  // guard silently zeroed valid payloads. Parse the value lines directly.
  let total = 0;
  let five = 0;
  for (const line of metricsText.split('\n')) {
    if (line.startsWith('http_requests_total') && !line.startsWith('#')) {
      const v = Number(line.split(/\s+/).pop());
      if (Number.isFinite(v)) total += v;
    }
  }
  const mm = /http_errors_5xx_total\s+(\d+)/.exec(metricsText);
  if (mm) five = Number(mm[1]);
  return `total_requests=${total} 5xx=${five}`;
}

(async () => {
  const header = `\n===== ${new Date().toISOString()} =====\n`;
  let metricsText = '';
  try {
    metricsText = await fetchWithTimeout(`${baseUrl}/metrics`);
    fs.appendFileSync(outFile, header + `--- /metrics ---\n` + metricsText + '\n');
  } catch (e) {
    fs.appendFileSync(outFile, header + `--- /metrics --- FETCH FAILED: ${e.message}\n`);
    console.warn(`[WARN] /metrics fetch failed (${e.message}) — snapshot recorded, continuing.`);
  }
  try {
    const readyz = await fetchWithTimeout(`${baseUrl}/readyz`);
    fs.appendFileSync(outFile, `--- /readyz ---\n` + readyz + '\n');
  } catch (e) {
    fs.appendFileSync(outFile, `--- /readyz --- FETCH FAILED: ${e.message}\n`);
    console.warn(`[WARN] /readyz fetch failed (${e.message}) — snapshot recorded, continuing.`);
  }
  console.log(`[snapshot ${label}] ${metricsText ? summarize(metricsText) : 'no metrics payload'} → ${outFile}`);
  process.exit(0);
})();
