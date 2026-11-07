'use strict';
// Keep identical to the other repo's copy. Contract fixtures: rich-contract-fixtures.json.

const PLACEHOLDER = /\\placeholder(?:\[[^\]]*\])?\{[^{}]*\}/g;

function hasPlaceholder(latex) {
  if (typeof latex !== 'string') return false;
  return /\\placeholder\b/.test(latex);
}

/** Store only latex-expanded output from MathLive. Empty slots become {}. */
function normalizeMathLatex(latex) {
  if (typeof latex !== 'string') return '';
  return latex.replace(PLACEHOLDER, '{}').trim();
}

module.exports = {
  hasPlaceholder,
  normalizeMathLatex,
};
