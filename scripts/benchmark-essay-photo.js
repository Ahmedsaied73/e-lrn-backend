'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { processImage } = require('../src/modules/essay-photo/imageProcessor');
const { createGeminiProvider } = require('../src/modules/essay-photo/geminiProvider');
const { countUnreadable } = require('../src/modules/essay-photo/service');

function parseArgs(argv) {
  const args = argv.slice(2);
  const compare = args.includes('--compare');
  const folder = args.find((a) => !a.startsWith('--'));
  return { folder, compare };
}

async function main() {
  const { folder, compare } = parseArgs(process.argv);
  if (!folder) {
    console.error('Usage: node scripts/benchmark-essay-photo.js <images-folder> [--compare]');
    process.exit(1);
  }

  const absFolder = path.resolve(folder);
  const files = fs
    .readdirSync(absFolder)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(absFolder, f));

  if (files.length === 0) {
    console.error('No JPEG/PNG/WebP images found in:', absFolder);
    process.exit(1);
  }

  const models = compare
    ? ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']
    : [process.env.ESSAY_PHOTO_MODEL || 'gemini-3.1-flash-lite'];

  const provider = createGeminiProvider();

  for (const file of files) {
    const raw = fs.readFileSync(file);
    const { buffer, mimeType } = await processImage(raw);
    console.log(`\n=== ${path.basename(file)} ===`);

    for (const model of models) {
      try {
        const res = await provider.extract({ imageBuffer: buffer, mimeType, model });
        const unreadable = countUnreadable(res.text);
        console.log(
          `[${model}] latency=${res.latencyMs}ms in=${res.inputTokens} out=${res.outputTokens} think=${res.thinkingTokens} cost=$${res.estimatedCostUsd} [?]=${unreadable} quality=${res.imageQuality}`
        );
        console.log(res.text);
      } catch (err) {
        console.error(`[${model}] ERROR (${err.code || err.statusCode}): ${err.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
