'use strict';

module.exports = {
  config: require('./config'),
  routes: require('./routes'),
  service: require('./service'),
  controller: require('./controller'),
  guardrails: require('./guardrails'),
  imageProcessor: require('./imageProcessor'),
  geminiProvider: require('./geminiProvider'),
  prompt: require('./prompt'),
  schema: require('./schema'),
};
