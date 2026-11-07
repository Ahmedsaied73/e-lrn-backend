'use strict';
// Keep identical in API to the other repo's copy. Contract fixtures: rich-contract-fixtures.json.

const types = require('./types');
const parse = require('./parse');
const serialize = require('./serialize');
const normalize = require('./normalize');
const grader = require('./grader');
const validate = require('./validate');

module.exports = {
  ...types,
  ...parse,
  ...serialize,
  ...normalize,
  ...grader,
  ...validate,
};
