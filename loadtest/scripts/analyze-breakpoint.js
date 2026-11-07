'use strict';

/**
 * scripts/analyze-breakpoint.js
 *
 * Correlates k6 JSON metric stream (--out json=...) and sampler.csv
 * to reconstruct the per-step breakpoint analysis table.
 *
 * Usage:
 *   node scripts/analyze-breakpoint.js [--k6 loadtest/results/k6-out.json] [--sampler loadtest/results/sampler.csv] [--out loadtest/results/breakpoint-analysis.json]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { onlineStudentsForRps, sensitivityTable } = require('../loadtest/lib/profile.js');

const argv = process.argv.slice(2);
function getArg(flag, def) {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1] : def;
}

const K6_FILE = getArg('--k6', path.join(__dirname, '..', 'loadtest', 'results', 'k6-out.json'));
const SAMPLER_FILE = getArg('--sampler', path.join(__dirname, '..', 'loadtest', 'results', 'sampler.csv'));
const OUT_FILE = getArg('--out', path.join(__dirname, '..', 'loadtest', 'results', 'breakpoint-analysis.json'));

const SLO = {
  p95Max: 1000,
  gateP95Max: 2000,
  errorRateMax: 0.01,
  max429: 0,
  eventLoopP99Max: 100,
  generatorMaxCpu: 85,
};

function parseSamplerCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  if (lines.length <= 1) return [];
  const header = lines[0].split(',');
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < header.length) continue;
    const rec = {};
    for (let h = 0; h < header.length; h++) {
      const val = cols[h];
      rec[header[h]] = header[h].includes('timestamp') ? val : Number(val);
    }
    records.push(rec);
  }
  return records;
}

async function analyzeK6Stream(k6Path) {
  if (!fs.existsSync(k6Path)) {
    return null;
  }

  const fileStream = fs.createReadStream(k6Path);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const rawPoints = []; // { time, metric, value, tags }

  for await (const line of rl) {
    if (!line || !line.startsWith('{')) continue;
    try {
      const point = JSON.parse(line);
      if (point.type === 'Point' && point.data) {
        rawPoints.push({
          time: new Date(point.data.time).getTime(),
          metric: point.metric,
          value: point.data.value,
          tags: point.data.tags || {},
        });
      }
    } catch (_e) {
      // skip unparseable lines
    }
  }

  return rawPoints;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function computeStepStats(points, startTime, endTime, targetRps) {
  const windowPoints = points.filter((p) => p.time >= startTime && p.time < endTime);
  const durations = [];
  const gateDurations = [];
  let reqCount = 0;
  let failCount = 0;
  let status429Count = 0;
  let goodputCount = 0;

  for (const p of windowPoints) {
    if (p.metric === 'http_req_duration') {
      durations.push(p.value);
      if (p.tags && p.tags.kind === 'gate') {
        gateDurations.push(p.value);
      }
    } else if (p.metric === 'http_reqs') {
      reqCount += p.value;
      const status = Number(p.tags && p.tags.status);
      if (status === 429) status429Count += 1;
      // Goodput: 2xx, 403, 409
      if ((status >= 200 && status < 300) || status === 403 || status === 409) {
        goodputCount += 1;
      }
    } else if (p.metric === 'http_req_failed') {
      if (p.value > 0) failCount += 1;
    }
  }

  durations.sort((a, b) => a - b);
  gateDurations.sort((a, b) => a - b);

  const durationSec = Math.max(1, (endTime - startTime) / 1000);
  const achievedRps = Number((reqCount / durationSec).toFixed(1));
  const goodputRps = Number((goodputCount / durationSec).toFixed(1));
  const errorRate = reqCount > 0 ? Number((failCount / reqCount).toFixed(4)) : 0;

  return {
    targetRps,
    achievedRps,
    goodputRps,
    reqCount,
    failCount,
    status429Count,
    errorPct: Number((errorRate * 100).toFixed(2)),
    p50: Number(quantile(durations, 0.5).toFixed(1)),
    p95: Number(quantile(durations, 0.95).toFixed(1)),
    p99: Number(quantile(durations, 0.99).toFixed(1)),
    gateP95: Number(quantile(gateDurations, 0.95).toFixed(1)),
  };
}

function correlateSampler(samplerRecords, startTime, endTime) {
  const windowRecs = samplerRecords.filter((r) => {
    const t = new Date(r.timestamp_utc).getTime();
    return t >= startTime && t < endTime;
  });

  if (windowRecs.length === 0) {
    return {
      eventloop_p99_ms: 0,
      server_cpu_pct: 0,
      server_rss_mb: 0,
      prisma_pool_timeouts: 0,
      redis_timeouts: 0,
      generator_cpu_pct: 0,
      readyz_ok: true,
    };
  }

  let sumEld99 = 0;
  let maxEld99 = 0;
  let sumCpu = 0;
  let maxCpu = 0;
  let maxRss = 0;
  let maxPrisma = 0;
  let maxRedis = 0;
  let sumGenCpu = 0;
  let allReadyzOk = true;

  for (const r of windowRecs) {
    sumEld99 += r.eventloop_p99_ms || 0;
    maxEld99 = Math.max(maxEld99, r.eventloop_p99_ms || 0);
    sumCpu += r.server_cpu_pct || 0;
    maxCpu = Math.max(maxCpu, r.server_cpu_pct || 0);
    maxRss = Math.max(maxRss, r.server_rss_mb || 0);
    maxPrisma = Math.max(maxPrisma, r.prisma_pool_timeouts || 0);
    maxRedis = Math.max(maxRedis, r.redis_timeouts || 0);
    sumGenCpu += r.generator_cpu_pct || 0;
    if (r.readyz_status !== 200) allReadyzOk = false;
  }

  const n = windowRecs.length;
  return {
    eventloop_p99_ms: Number((sumEld99 / n).toFixed(1)),
    eventloop_max_ms: Number(maxEld99.toFixed(1)),
    server_cpu_pct: Number((sumCpu / n).toFixed(1)),
    server_cpu_max: Number(maxCpu.toFixed(1)),
    server_rss_mb: Number(maxRss.toFixed(1)),
    prisma_pool_timeouts: maxPrisma,
    redis_timeouts: maxRedis,
    generator_cpu_pct: Number((sumGenCpu / n).toFixed(1)),
    readyz_ok: allReadyzOk,
  };
}

async function runAnalysis() {
  const samplerRecords = parseSamplerCsv(SAMPLER_FILE);
  const k6Points = await analyzeK6Stream(K6_FILE);

  console.log(`[analyze] Loaded ${samplerRecords.length} sampler ticks, ${k6Points ? k6Points.length : 0} k6 points.`);

  // If raw points exist, slice into steps. Otherwise produce the benchmark model structure.
  const PLANNED_STEPS = [100, 250, 500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000];
  const stepRows = [];

  // When live data is present, segment by step windows
  if (k6Points && k6Points.length > 0) {
    // Detect start and duration
    const minTime = k6Points[0].time;
    let cursor = minTime;
    const holdMs = 180 * 1000; // 3m hold
    const rampMs = 30 * 1000;  // 30s ramp

    for (const target of PLANNED_STEPS) {
      cursor += rampMs;
      const stepStart = cursor;
      const stepEnd = cursor + holdMs;
      cursor = stepEnd;

      const k6Stats = computeStepStats(k6Points, stepStart, stepEnd, target);
      const samplerStats = correlateSampler(samplerRecords, stepStart, stepEnd);

      const combined = { ...k6Stats, ...samplerStats };
      stepRows.push(combined);

      // Break if tests stopped early
      if (stepEnd > k6Points[k6Points.length - 1].time) break;
    }
  }

  // Evaluate Breakpoint & Bottlenecks
  let maxSustainable = null;
  let breakpoint = null;
  let hardBreak = null;
  let knee = null;
  let baselineP95 = null;

  for (const step of stepRows) {
    if (baselineP95 === null && step.p95 > 0) {
      baselineP95 = step.p95;
    }

    // Knee detection: p95 > 2x baseline
    if (!knee && baselineP95 && step.p95 >= 2 * baselineP95) {
      knee = step.targetRps;
    }

    // SLO Check
    const passesSlo =
      step.p95 <= SLO.p95Max &&
      (step.gateP95 === 0 || step.gateP95 <= SLO.gateP95Max) &&
      step.errorPct < 1.0 &&
      step.status429Count === 0 &&
      step.eventloop_p99_ms < SLO.eventLoopP99Max &&
      step.generator_cpu_pct < SLO.generatorMaxCpu;

    if (passesSlo) {
      maxSustainable = step.targetRps;
    } else if (!breakpoint) {
      breakpoint = step.targetRps;
    }

    // Hard break check
    const isHardBreak = step.errorPct >= 5.0 || step.p95 >= 5000 || !step.readyz_ok;
    if (isHardBreak && !hardBreak) {
      hardBreak = step.targetRps;
    }
  }

  // Bottleneck attribution
  let bottleneck = 'None';
  if (breakpoint) {
    const bpStep = stepRows.find((s) => s.targetRps === breakpoint) || stepRows[stepRows.length - 1];
    if (bpStep.generator_cpu_pct >= SLO.generatorMaxCpu) {
      bottleneck = 'Generator CPU Saturated (load-generator ceiling, not app limit)';
    } else if (bpStep.server_cpu_pct >= 90 || bpStep.eventloop_p99_ms >= SLO.eventLoopP99Max) {
      bottleneck = 'Node.js Event Loop / Container CPU Bound';
    } else if (bpStep.prisma_pool_timeouts > 0 || !bpStep.readyz_ok) {
      bottleneck = 'Supabase Postgres Connection Pool Bound (Prisma P2024 / Pool Exhaustion)';
    } else if (bpStep.redis_timeouts > 0) {
      bottleneck = 'Upstash Redis Latency / Limiter EVAL Bound';
    } else if (bpStep.status429Count > 0) {
      bottleneck = 'Rate Limiter Hard Ceiling Triggered';
    } else {
      bottleneck = 'Network Latency / Upstream Database Round-Trip Inflation';
    }
  }

  const analysis = {
    evaluatedAt: new Date().toISOString(),
    sloThresholds: SLO,
    baselineP95,
    maxSustainableRps: maxSustainable,
    breakpointRps: breakpoint,
    hardBreakRps: hardBreak,
    kneeRps: knee,
    firstBottleneck: bottleneck,
    studentsSupportedAtMaxSustainable: maxSustainable ? onlineStudentsForRps(maxSustainable) : 0,
    sensitivity: sensitivityTable(maxSustainable || 1000),
    steps: stepRows,
  };

  const outDir = path.dirname(OUT_FILE);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(analysis, null, 2), 'utf8');
  console.log(`[analyze] Analysis written to ${OUT_FILE}`);

  return analysis;
}

if (require.main === module) {
  runAnalysis().catch((err) => {
    console.error('[analyze] Error:', err);
    process.exit(1);
  });
}

module.exports = {
  runAnalysis,
  parseSamplerCsv,
  computeStepStats,
  correlateSampler,
};
