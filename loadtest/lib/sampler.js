'use strict';

/**
 * loadtest/lib/sampler.js
 *
 * Background metrics sampler: polls /metrics and /readyz every 5 seconds
 * and appends rows to a CSV file with UTC timestamps.
 * Also tracks generator CPU and memory so generator saturation can be proven/ruled out.
 *
 * Usage:
 *   node loadtest/lib/sampler.js [--out loadtest/results/sampler.csv] [--interval 5000]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3005';
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
const INTERVAL_MS = Number(process.env.SAMPLER_INTERVAL_MS) || 5000;
const OUT_FILE = process.env.SAMPLER_OUT || path.join(__dirname, '..', 'results', 'sampler.csv');

let lastGenCpu = process.cpuUsage();
let lastGenTime = process.hrtime.bigint();

function getGeneratorCpuPercent() {
  const currCpu = process.cpuUsage(lastGenCpu);
  const currTime = process.hrtime.bigint();
  const elapsedMicros = Number(currTime - lastGenTime) / 1000;
  lastGenCpu = process.cpuUsage();
  lastGenTime = currTime;
  if (elapsedMicros <= 0) return 0;
  const totalMicros = currCpu.user + currCpu.system;
  const cpus = os.cpus().length || 1;
  return Number(((totalMicros / elapsedMicros) * 100 / cpus).toFixed(2));
}

function parsePrometheusText(text) {
  const metrics = {};
  if (!text) return metrics;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const spaceIdx = trimmed.lastIndexOf(' ');
    if (spaceIdx === -1) continue;
    const key = trimmed.slice(0, spaceIdx);
    const val = Number(trimmed.slice(spaceIdx + 1));
    if (!Number.isNaN(val)) {
      metrics[key] = val;
    }
  }
  return metrics;
}

async function sampleOnce(baseUrl = BASE_URL, token = METRICS_TOKEN) {
  const timestamp = new Date().toISOString();
  let readyzStatus = 0;
  let readyzMs = 0;

  // 1. Probe /readyz
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(4000) });
    readyzStatus = res.status;
    readyzMs = Date.now() - t0;
  } catch (_e) {
    readyzStatus = 0;
    readyzMs = Date.now() - t0;
  }

  // 2. Probe /metrics
  let promMetrics = {};
  try {
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['X-Metrics-Token'] = token;
    }
    const res = await fetch(`${baseUrl}/metrics`, { headers, signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const text = await res.text();
      promMetrics = parsePrometheusText(text);
    }
  } catch (_e) {
    // /metrics unavailable
  }

  // 3. Generator resource usage
  const genCpuPct = getGeneratorCpuPercent();
  const genMem = process.memoryUsage();
  const genRssMb = Number((genMem.rss / (1024 * 1024)).toFixed(2));

  // Extract Prometheus values
  const requestsTotal = promMetrics['http_requests_total{status="200"}'] || promMetrics['http_request_duration_ms_count'] || 0;
  const errors5xx = promMetrics['http_errors_5xx_total'] || 0;
  const inFlight = promMetrics['http_in_flight_requests'] || 0;
  const eld50 = promMetrics['nodejs_eventloop_delay_p50_ms'] || 0;
  const eld99 = promMetrics['nodejs_eventloop_delay_p99_ms'] || 0;
  const eldMax = promMetrics['nodejs_eventloop_delay_max_ms'] || 0;
  const serverCpuPct = promMetrics['process_cpu_percent'] || 0;
  const serverRssMb = promMetrics['process_resident_memory_bytes']
    ? Number((promMetrics['process_resident_memory_bytes'] / (1024 * 1024)).toFixed(2))
    : 0;
  const serverHeapMb = promMetrics['process_heap_used_bytes']
    ? Number((promMetrics['process_heap_used_bytes'] / (1024 * 1024)).toFixed(2))
    : 0;
  const prismaPoolTimeouts = promMetrics['prisma_pool_timeouts_total'] || 0;
  const redisTimeouts = promMetrics['redis_command_timeouts_total'] || 0;

  return {
    timestamp_utc: timestamp,
    readyz_status: readyzStatus,
    readyz_ms: readyzMs,
    requests_total: requestsTotal,
    errors_5xx: errors5xx,
    in_flight: inFlight,
    eventloop_p50_ms: eld50,
    eventloop_p99_ms: eld99,
    eventloop_max_ms: eldMax,
    server_cpu_pct: serverCpuPct,
    server_rss_mb: serverRssMb,
    server_heap_mb: serverHeapMb,
    prisma_pool_timeouts: prismaPoolTimeouts,
    redis_timeouts: redisTimeouts,
    generator_cpu_pct: genCpuPct,
    generator_rss_mb: genRssMb,
  };
}

const CSV_HEADER = [
  'timestamp_utc',
  'readyz_status',
  'readyz_ms',
  'requests_total',
  'errors_5xx',
  'in_flight',
  'eventloop_p50_ms',
  'eventloop_p99_ms',
  'eventloop_max_ms',
  'server_cpu_pct',
  'server_rss_mb',
  'server_heap_mb',
  'prisma_pool_timeouts',
  'redis_timeouts',
  'generator_cpu_pct',
  'generator_rss_mb',
].join(',');

function initCsv(filePath = OUT_FILE) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, CSV_HEADER + '\n', 'utf8');
  }
}

function appendSample(sample, filePath = OUT_FILE) {
  const row = [
    sample.timestamp_utc,
    sample.readyz_status,
    sample.readyz_ms,
    sample.requests_total,
    sample.errors_5xx,
    sample.in_flight,
    sample.eventloop_p50_ms,
    sample.eventloop_p99_ms,
    sample.eventloop_max_ms,
    sample.server_cpu_pct,
    sample.server_rss_mb,
    sample.server_heap_mb,
    sample.prisma_pool_timeouts,
    sample.redis_timeouts,
    sample.generator_cpu_pct,
    sample.generator_rss_mb,
  ].join(',');
  fs.appendFileSync(filePath, row + '\n', 'utf8');
}

// Standalone execution loop
if (require.main === module) {
  initCsv(OUT_FILE);
  console.log(`[sampler] Sampling ${BASE_URL} every ${INTERVAL_MS}ms into ${OUT_FILE}`);

  let running = true;
  const onStop = () => {
    running = false;
    console.log('[sampler] Stopped.');
    process.exit(0);
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  (async () => {
    while (running) {
      try {
        const sample = await sampleOnce();
        appendSample(sample);
      } catch (err) {
        console.warn(`[sampler] Sample error: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  })();
}

module.exports = {
  sampleOnce,
  initCsv,
  appendSample,
  parsePrometheusText,
};
