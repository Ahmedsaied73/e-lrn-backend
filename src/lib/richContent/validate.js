'use strict';
const katex = require('katex');
require('katex/contrib/mhchem');
const { RICH_LIMITS } = require('./types');
const { looksRich, sanitizeBlocks } = require('./parse');

const FORBIDDEN =
  /\\(href|url|includegraphics|input|include|write|read|openin|openout|def|edef|gdef|xdef|let|newcommand|renewcommand|providecommand|catcode|csname|htmlClass|htmlId|htmlStyle|htmlData|special)(?![a-zA-Z])/;

function balancedBraces(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

function validateRich(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'RICH_BAD_FORMAT' };
  if (raw.length > RICH_LIMITS.maxTotalChars) return { ok: false, code: 'RICH_TOO_LARGE' };
  if (!looksRich(raw)) return { ok: true }; // plain text is always acceptable (size already checked)

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'RICH_BAD_FORMAT' };
  }

  const blocks = data && data.v === 1 && Object.keys(data).length === 2 ? sanitizeBlocks(data.blocks) : null;
  if (!blocks) return { ok: false, code: 'RICH_BAD_FORMAT' };
  if (blocks.length > RICH_LIMITS.maxBlocks) return { ok: false, code: 'RICH_TOO_LARGE' };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const max =
      b.t === 'text'
        ? RICH_LIMITS.maxTextChars
        : b.t === 'math'
          ? RICH_LIMITS.maxMathChars
          : RICH_LIMITS.maxChemChars;
    if (b.v.length > max) return { ok: false, code: 'RICH_TOO_LARGE', blockIndex: i };
    if (b.t === 'text') continue;
    if (b.t === 'chem' && !balancedBraces(b.v)) return { ok: false, code: 'RICH_BAD_MATH', blockIndex: i };
    const tex = b.t === 'chem' ? `\\ce{${b.v}}` : b.v;
    if (FORBIDDEN.test(tex)) return { ok: false, code: 'RICH_FORBIDDEN_COMMAND', blockIndex: i };
    try {
      katex.renderToString(tex, { throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000 });
    } catch {
      return { ok: false, code: 'RICH_BAD_MATH', blockIndex: i };
    }
  }
  return { ok: true };
}

module.exports = {
  validateRich,
  balancedBraces,
  FORBIDDEN,
};
