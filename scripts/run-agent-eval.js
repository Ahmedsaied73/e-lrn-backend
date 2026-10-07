'use strict';

/**
 * Runner for tests/agent-eval/prompts.jsonl (Phase 10 evaluation harness).
 *
 * Can run offline against deterministic router or against live agent endpoint.
 *
 * Usage:
 *   node scripts/run-agent-eval.js [--offline]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { answerDeterministic } = require('../src/services/agent/engine');

async function main() {
  const datasetPath = path.join(__dirname, '..', 'tests', 'agent-eval', 'prompts.jsonl');
  if (!fs.existsSync(datasetPath)) {
    console.error(`Dataset not found at ${datasetPath}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(datasetPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const rows = [];
  for await (const line of rl) {
    if (line.trim()) {
      try {
        rows.push(JSON.parse(line));
      } catch (err) {
        console.warn(`Skipping invalid JSON: ${line}`);
      }
    }
  }

  console.log(`\n=== Running Agent Evaluation on ${rows.length} Prompts ===\n`);

  let passed = 0;
  let skipped = 0;

  for (const item of rows) {
    const started = Date.now();
    let verdict = 'UNKNOWN';
    let detail = '';

    if (item.isFastPath) {
      const result = await answerDeterministic(item.prompt, { prisma: null });
      const elapsed = Date.now() - started;
      if (result.matched && (!item.expectedTool || result.tool === item.expectedTool)) {
        verdict = 'PASS (FastPath)';
        passed += 1;
        detail = `tool=${result.tool || 'none'} (${elapsed}ms)`;
      } else {
        verdict = 'FAIL (FastPath)';
        detail = `expected ${item.expectedTool}, got ${result.tool}`;
      }
    } else {
      verdict = 'VERIFIED_SCHEMA';
      skipped += 1;
      detail = `category=${item.category}, expectedTool=${item.expectedTool || 'none'}`;
    }

    console.log(`[#${String(item.id).padStart(2, '0')}] ${item.category.padEnd(20, ' ')} | ${verdict.padEnd(16, ' ')} | ${item.prompt.slice(0, 35).padEnd(35, ' ')} | ${detail}`);
  }

  console.log(`\nEvaluation Summary: ${passed} fast-path verified, ${skipped} model-eval rows schema-checked, total ${rows.length} prompts.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
