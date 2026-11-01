'use strict';
const serverless = require('serverless-http');
const app = require('../../app');

module.exports.handler = serverless(app, {
  request(req, event) {
    const clientIp =
      (event.headers && event.headers['x-nf-client-connection-ip']) ||
      (event.headers && event.headers['client-ip']) ||
      (event.headers && event.headers['x-forwarded-for'] ? event.headers['x-forwarded-for'].split(',')[0].trim() : '127.0.0.1');
    req.ip = clientIp;
  },
});
