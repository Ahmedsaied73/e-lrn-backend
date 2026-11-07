'use strict';

/**
 * prompt.js — System prompt builder for the admin chat agent.
 *
 * Appends guidelines for rich content authoring (math LaTeX, chem mhchem)
 * so that when the agent creates or edits quiz questions, reference answers,
 * or essay grading feedback, it formats equations cleanly into rich blocks.
 */

const { buildSystemPrompt } = require('./graph');

const RICH_AGENT_INSTRUCTIONS = [
  '- استخدم مقاطع math مع كود LaTeX للمعادلات الرياضية.',
  '- استخدم مقاطع chem مع صيغة mhchem للمعادلات الكيميائية.',
  '- لا تخلط أبداً بين الشرح اللغوي والمعادلات داخل مقطع math أو chem؛ اكتب الشرح في مقاطع text مستقلة والمعادلات فقط داخل math أو chem.',
].join('\n');

module.exports = {
  buildSystemPrompt,
  RICH_AGENT_INSTRUCTIONS,
};
