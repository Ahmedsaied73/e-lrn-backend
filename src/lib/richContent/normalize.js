'use strict';
// Keep identical to the other repo's copy. Contract fixtures: rich-contract-fixtures.json.

const PLACEHOLDER = /\\placeholder(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g;

function hasPlaceholder(latex) {
  if (typeof latex !== 'string') return false;
  return /\\placeholder\b/.test(latex);
}

function replaceDisplaylines(latex) {
  if (typeof latex !== 'string' || !latex.includes('\\displaylines{')) return latex;
  let out = latex;
  let idx = 0;
  while ((idx = out.indexOf('\\displaylines{', idx)) !== -1) {
    let depth = 1;
    let end = -1;
    for (let i = idx + 14; i < out.length; i++) {
      if (out[i] === '\\') {
        i++;
        continue;
      }
      if (out[i] === '{') depth++;
      else if (out[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) {
      const inner = out.substring(idx + 14, end);
      out = out.substring(0, idx) + '\\begin{gathered}' + inner + '\\end{gathered}' + out.substring(end + 1);
      idx += 16 + inner.length + 14;
    } else {
      break;
    }
  }
  return out;
}

function normalizePrimes(tex) {
  if (typeof tex !== 'string') return '';
  let out = tex;

  // 1. Convert consecutive escaped primes \'\'... into ^{\prime...}
  out = out.replace(/(?:\\')+/g, (m) => {
    const count = m.length / 2;
    return '^{' + '\\prime'.repeat(count) + '}';
  });

  // 2. Collapse adjacent superscripts of primes: ^{\prime...}^{\prime...}
  while (/\^\{((?:\\prime)+)\}\s*\^\{((?:\\prime)+)\}/.test(out)) {
    out = out.replace(/\^\{((?:\\prime)+)\}\s*\^\{((?:\\prime)+)\}/g, (m, p1, p2) => '^{' + p1 + p2 + '}');
  }

  // 3. Collapse prime superscript followed by literal quote: ^{\prime...}'
  while (/\^\{((?:\\prime)+)\}'/.test(out)) {
    out = out.replace(/\^\{((?:\\prime)+)\}'/g, '^{$1\\prime}');
  }

  // 4. Collapse literal quote(s) followed by prime superscript: '^{\prime...}
  while (/('+)\s*\^\{((?:\\prime)+)\}/.test(out)) {
    out = out.replace(/('+)\s*\^\{((?:\\prime)+)\}/g, (m, quotes, primes) => {
      return '^{' + '\\prime'.repeat(quotes.length) + primes + '}';
    });
  }

  // 5. Collapse bare ^\prime ^\prime or combination with ^{\prime...}
  while (/\^\\prime(?:\s*\^\\prime)+/.test(out)) {
    out = out.replace(/\^\\prime(?:\s*\^\\prime)+/g, (m) => {
      const count = (m.match(/\\prime/g) || []).length;
      return '^{' + '\\prime'.repeat(count) + '}';
    });
  }

  // 6. Fix MathLive bug with extra closing bracket in superscripts like ^{\prime}} or ^{\prime\prime}}
  out = out.replace(/\^\{((?:\\prime)+)\}\}/g, '^{$1}');

  return out;
}

/**
 * Store only latex-expanded output from MathLive.
 * Empty slots become {}.
 * Substitutes MathLive non-standard macros with KaTeX-compatible equivalents:
 * - \differentialD -> \mathrm{d}
 * - \exponentialE  -> \mathrm{e}
 * - \imaginaryI    -> \mathrm{i}
 * - \displaylines{...} -> \begin{gathered}...\end{gathered}
 * - \placeholder   -> {}
 */
function normalizeMathLatex(latex) {
  if (typeof latex !== 'string') return '';
  let out = latex;

  // Substitute MathLive non-standard macros
  out = out
    .replace(/\\differentialD\b/g, '\\mathrm{d}')
    .replace(/\\exponentialE\b/g, '\\mathrm{e}')
    .replace(/\\imaginaryI\b/g, '\\mathrm{i}');

  // Convert MathLive \displaylines{...} multiline math to \begin{gathered}...\end{gathered}
  out = replaceDisplaylines(out);

  // Normalize all prime / derivative notations and collapse double superscripts
  out = normalizePrimes(out);

  // Replace placeholders with empty braces
  out = out.replace(PLACEHOLDER, '{}');

  // Fallback for any remaining bare \placeholder
  out = out.replace(/\\placeholder\b/g, '{}');

  return out.trim();
}

module.exports = {
  hasPlaceholder,
  normalizeMathLatex,
  replaceDisplaylines,
  normalizePrimes,
};

