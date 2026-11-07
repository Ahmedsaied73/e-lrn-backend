// src/metrics/metrics.js
'use strict';
/**
 * In-process metrics: per-status request counters + duration histogram
 * (Prometheus text at GET /metrics). Zero external deps. Single-instance scope.
 * Extended for breakpoint load-testing: event-loop delay (p50/p99/max),
 * process CPU %, RSS & heap usage, in-flight requests, requests by route
 * template (req.route.path), and counters for Prisma pool / Redis timeouts.
 */
const { monitorEventLoopDelay } = require('perf_hooks');

const DURATION_BUCKETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const counters = { requests: new Map(), errors: new Map(), buckets: new Map(), sum: 0, count: 0 };
const routeCounters = new Map();
const startedAt = Date.now();

let inFlightRequests = 0;
let prismaPoolTimeouts = 0;
let redisCommandTimeouts = 0;

let eld = null;
try {
  eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
} catch (_err) {
  // Ignore if perf_hooks monitorEventLoopDelay is unavailable
}

let lastCpuUsage = process.cpuUsage();
let lastCpuTime = process.hrtime.bigint();

function getCpuPercent() {
  const currUsage = process.cpuUsage(lastCpuUsage);
  const currTime = process.hrtime.bigint();
  const elapsedMicros = Number(currTime - lastCpuTime) / 1000;
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = currTime;
  if (elapsedMicros <= 0) return 0;
  const totalMicros = currUsage.user + currUsage.system;
  return Number(((totalMicros / elapsedMicros) * 100).toFixed(2));
}

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

function recordRouteRequest(method, route) {
  const m = String(method || 'GET').toUpperCase();
  const r = String(route || 'unmatched');
  const key = `${m} ${r}`;
  routeCounters.set(key, (routeCounters.get(key) || 0) + 1);
}

function recordPrismaTimeout() {
  prismaPoolTimeouts += 1;
}

function recordRedisTimeout() {
  redisCommandTimeouts += 1;
}

function metricsMiddleware(req, res, next) {
  // Avoid observer bias on the scrape endpoint itself
  if (req.path === '/metrics') {
    return next();
  }

  inFlightRequests += 1;
  let finished = false;

  const onDone = () => {
    if (finished) return;
    finished = true;
    inFlightRequests = Math.max(0, inFlightRequests - 1);

    let route = 'unmatched';
    if (req.route && req.route.path) {
      const base = req.baseUrl || '';
      const rPath = req.route.path;
      route = (rPath === '/' && base) ? base : (base + rPath);
    } else if (req.path === '/healthz' || req.path === '/readyz' || req.path === '/health') {
      route = req.path;
    }
    recordRouteRequest(req.method, route);
  };

  res.on('finish', onDone);
  res.on('close', onDone);
  next();
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

  // Event loop delay
  let p50 = 0;
  let p99 = 0;
  let max = 0;
  if (eld) {
    const rawP50 = eld.percentile(50);
    const rawP99 = eld.percentile(99);
    const rawMax = eld.max;
    p50 = Number.isFinite(rawP50) ? Number((rawP50 / 1e6).toFixed(3)) : 0;
    p99 = Number.isFinite(rawP99) ? Number((rawP99 / 1e6).toFixed(3)) : 0;
    max = Number.isFinite(rawMax) ? Number((rawMax / 1e6).toFixed(3)) : 0;
    eld.reset();
  }
  lines.push('# TYPE nodejs_eventloop_delay_p50_ms gauge');
  lines.push(`nodejs_eventloop_delay_p50_ms ${p50}`);
  lines.push('# TYPE nodejs_eventloop_delay_p99_ms gauge');
  lines.push(`nodejs_eventloop_delay_p99_ms ${p99}`);
  lines.push('# TYPE nodejs_eventloop_delay_max_ms gauge');
  lines.push(`nodejs_eventloop_delay_max_ms ${max}`);

  // Process CPU %
  lines.push('# TYPE process_cpu_percent gauge');
  lines.push(`process_cpu_percent ${getCpuPercent()}`);

  // Memory usage
  const mem = process.memoryUsage();
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${mem.rss}`);
  lines.push('# TYPE process_heap_used_bytes gauge');
  lines.push(`process_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# TYPE process_heap_total_bytes gauge');
  lines.push(`process_heap_total_bytes ${mem.heapTotal}`);

  // In-flight requests
  lines.push('# TYPE http_in_flight_requests gauge');
  lines.push(`http_in_flight_requests ${inFlightRequests}`);

  // Requests by route template
  lines.push('# TYPE http_requests_by_route_total counter');
  for (const [key, n] of routeCounters) {
    const spaceIdx = key.indexOf(' ');
    const method = spaceIdx !== -1 ? key.slice(0, spaceIdx) : 'GET';
    const route = spaceIdx !== -1 ? key.slice(spaceIdx + 1) : key;
    lines.push(`http_requests_by_route_total{method="${method}",route="${route}"} ${n}`);
  }

  // Timeouts
  lines.push('# TYPE prisma_pool_timeouts_total counter');
  lines.push(`prisma_pool_timeouts_total ${prismaPoolTimeouts}`);
  lines.push('# TYPE redis_command_timeouts_total counter');
  lines.push(`redis_command_timeouts_total ${redisCommandTimeouts}`);

  return lines.join('\n') + '\n';
}

module.exports = {
  recordRequest,
  recordRouteRequest,
  recordPrismaTimeout,
  recordRedisTimeout,
  metricsMiddleware,
  renderPrometheus,
  DURATION_BUCKETS,
};
