'use strict';
// Keep identical to the other repo's copy. Contract fixtures: rich-contract-fixtures.json.

const ENVELOPE_PREFIX = '{"v":1,"blocks":[';

function looksRich(raw) {
  return typeof raw === 'string' && (raw.startsWith(ENVELOPE_PREFIX) || /^\{"v":\d+,"blocks":\[/.test(raw));
}

function sanitizeBlocks(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const b of input) {
    if (!b || typeof b !== 'object') return null;
    const { t, v } = b;
    if ((t === 'text' || t === 'math' || t === 'chem') && typeof v === 'string') {
      out.push({ t, v });
    } else {
      return null;
    }
  }
  return out;
}

/** Plain strings (legacy or text-only) become a single text block. Never throws. */
function parseRich(raw) {
  if (!raw) return { v: 1, blocks: [] };
  if (looksRich(raw)) {
    try {
      const data = JSON.parse(raw);
      const blocks = data && data.v === 1 ? sanitizeBlocks(data.blocks) : null;
      if (blocks) return { v: 1, blocks };
    } catch {
      /* fall through: treat as plain text */
    }
  }
  return { v: 1, blocks: [{ t: 'text', v: raw }] };
}

function isEmptyRich(raw) {
  return parseRich(raw).blocks.every((b) => b.v.trim() === '');
}

function hasMath(raw) {
  return parseRich(raw).blocks.some((b) => b.t !== 'text');
}

module.exports = {
  ENVELOPE_PREFIX,
  looksRich,
  sanitizeBlocks,
  parseRich,
  isEmptyRich,
  hasMath,
};
