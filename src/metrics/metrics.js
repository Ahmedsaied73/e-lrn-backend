// src/metrics/metrics.js
'use strict';
/**
 * In-process metrics: per-status request counters + duration histogram
 * (Prometheus text at GET /metrics). Zero deps — the format is a few lines
 * of text. Single-instance scope (per-replica counters) is the accepted V1
 * limitation; aggregates arrive when a scraper is wired (Task 5).
 */
const DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const counters = { requests: new Map(), errors: new Map(), buckets: new Map(), sum: 0, count: 0 };
const startedAt = Date.now();

function recordRequest(status, durationMs) {
  const s = String(status);
  counters.requests.set(s, (counters.requests.get(s) || 0) + 1);
  if (Number(status) >= 500) counters.errors.set(s, (counters.errors.get(s) || 0) + 1);
  const d = Number(durationMs) || 0;
  counters.sum += d;
  counters.count += 1;
  for (const b of DURATION_BUCKETS) {
    if (d <= b) counters.buckets.set(b, (counters.buckets.get(b) || 0) + 1);
  }
}

function renderPrometheus() {
  const lines = [];
  lines.push('# TYPE http_requests_total counter');
  for (const [status, n] of counters.requests) lines.push(`http_requests_total{status="${status}"} ${n}`);
  let errors = 0;
  for (const [, n] of counters.errors) errors += n;
  lines.push('# TYPE http_errors_5xx_total counter');
  lines.push(`http_errors_5xx_total ${errors}`);
  lines.push('# TYPE http_request_duration_ms histogram');
  for (const b of DURATION_BUCKETS) {
    lines.push(`http_request_duration_ms_bucket{le="${b}"} ${counters.buckets.get(b) || 0}`);
  }
  lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${counters.count}`);
  lines.push(`http_request_duration_ms_sum ${counters.sum}`);
  lines.push(`http_request_duration_ms_count ${counters.count}`);
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);
  return lines.join('\n') + '\n';
}

module.exports = { recordRequest, renderPrometheus, DURATION_BUCKETS };
