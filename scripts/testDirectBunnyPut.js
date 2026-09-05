'use strict';

const https = require('https');
const fs = require('fs');
const config = require('../src/config/env');

const bunnyVideoId = '4d1307f8-3201-4167-b83b-8afab2836fdd';
const file1 = 'C:\\Users\\os\\Downloads\\22222222222.mp4';
const fileStats = fs.statSync(file1);

console.log(`Testing direct PUT to Bunny for video ${bunnyVideoId} (size: ${fileStats.size} bytes)...`);

const req = https.request(
  {
    hostname: 'video.bunnycdn.com',
    path: `/library/${config.bunny.libraryId}/videos/${bunnyVideoId}`,
    method: 'PUT',
    headers: {
      AccessKey: config.bunny.apiKey,
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileStats.size,
    },
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      console.log(`Bunny response status: ${res.statusCode}`);
      console.log(`Bunny response body: ${body}`);
    });
  }
);

req.on('error', (err) => {
  console.error('Request error:', err);
});

const readStream = fs.createReadStream(file1);
readStream.pipe(req);
