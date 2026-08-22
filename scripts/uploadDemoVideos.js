'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config/env');

const BASE_URL = 'http://localhost:3005';

const file1 = 'C:\\Users\\os\\Downloads\\22222222222.mp4';
const file2 = 'C:\\Users\\os\\Downloads\\YTDown.com_YouTube_1-Minute-of-Blank-Screen-HD-720p_Media_-Pg819il8lY_001_360p.mp4';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer() {
  console.log('Connecting to server at http://localhost:3005 ...');
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok || res.status === 200 || res.status === 404) {
        console.log('✓ Server is ready and responding.');
        return;
      }
    } catch (e) {
      // server is booting up, wait
    }
    await sleep(1500);
  }
  throw new Error('Server did not respond in time at http://localhost:3005');
}

async function main() {
  await waitForServer();

  console.log('\n1. Checking video files existence...');
  if (!fs.existsSync(file1)) throw new Error(`File 1 not found: ${file1}`);
  console.log(`✓ Found file 1: ${path.basename(file1)} (${(fs.statSync(file1).size / (1024 * 1024)).toFixed(2)} MB)`);

  if (!fs.existsSync(file2)) throw new Error(`File 2 not found: ${file2}`);
  console.log(`✓ Found file 2: ${path.basename(file2)} (${(fs.statSync(file2).size / (1024 * 1024)).toFixed(2)} MB)`);

  console.log('\n2. Logging in as Admin...');
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: config.admin.email,
      password: config.admin.password,
    }),
  });

  const loginData = await loginRes.json();
  if (!loginData.success) {
    throw new Error(`Login failed: ${JSON.stringify(loginData)}`);
  }
  const token = loginData.data.token;
  console.log(`✓ Logged in successfully. Token acquired.`);

  console.log('\n3. Creating Course in DB...');
  const coursePayload = {
    title: 'Bunny Stream Video Course',
    description: 'Course containing sample Bunny.net Stream uploaded lessons.',
    price: 200,
    grade: 'THIRD_SECONDARY',
    thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=800',
  };

  const courseRes = await fetch(`${BASE_URL}/courses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(coursePayload),
  });

  const courseData = await courseRes.json();
  if (!courseData.success) {
    throw new Error(`Course creation failed: ${JSON.stringify(courseData)}`);
  }
  const courseId = courseData.data.id;
  console.log(`✓ Created Course ID: ${courseId} ("${courseData.data.title}")`);

  // --- Video 1 ---
  console.log('\n4. Creating BunnyVideo 1 record...');
  const v1CreateRes = await fetch(`${BASE_URL}/courses/${courseId}/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: 'Lesson 1 - 22222222222' }),
  });
  const v1CreateData = await v1CreateRes.json();
  if (!v1CreateData.success) {
    throw new Error(`BunnyVideo 1 creation failed: ${JSON.stringify(v1CreateData)}`);
  }
  const video1Id = v1CreateData.data.id;
  console.log(`✓ Video 1 registered. ID: ${video1Id} (Bunny GUID: ${v1CreateData.data.bunnyVideoId})`);

  console.log(`   Uploading ${path.basename(file1)} to /videos/${video1Id}/upload ...`);
  const v1FormData = new FormData();
  const v1Blob = new Blob([fs.readFileSync(file1)], { type: 'video/mp4' });
  v1FormData.append('video', v1Blob, path.basename(file1));

  const v1UploadRes = await fetch(`${BASE_URL}/videos/${video1Id}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: v1FormData,
  });
  const v1UploadData = await v1UploadRes.json();
  if (!v1UploadData.success) {
    throw new Error(`Video 1 upload failed: ${JSON.stringify(v1UploadData)}`);
  }
  console.log(`✓ Video 1 Upload result:`, v1UploadData.data);

  // --- Video 2 ---
  console.log('\n5. Creating BunnyVideo 2 record...');
  const v2CreateRes = await fetch(`${BASE_URL}/courses/${courseId}/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title: 'Lesson 2 - Blank Screen HD 720p' }),
  });
  const v2CreateData = await v2CreateRes.json();
  if (!v2CreateData.success) {
    throw new Error(`BunnyVideo 2 creation failed: ${JSON.stringify(v2CreateData)}`);
  }
  const video2Id = v2CreateData.data.id;
  console.log(`✓ Video 2 registered. ID: ${video2Id} (Bunny GUID: ${v2CreateData.data.bunnyVideoId})`);

  console.log(`   Uploading ${path.basename(file2)} to /videos/${video2Id}/upload ...`);
  const v2FormData = new FormData();
  const v2Blob = new Blob([fs.readFileSync(file2)], { type: 'video/mp4' });
  v2FormData.append('video', v2Blob, path.basename(file2));

  const v2UploadRes = await fetch(`${BASE_URL}/videos/${video2Id}/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: v2FormData,
  });
  const v2UploadData = await v2UploadRes.json();
  if (!v2UploadData.success) {
    throw new Error(`Video 2 upload failed: ${JSON.stringify(v2UploadData)}`);
  }
  console.log(`✓ Video 2 Upload result:`, v2UploadData.data);

  console.log('\n6. Fetching course bunny videos list to verify...');
  const listRes = await fetch(`${BASE_URL}/courses/${courseId}/bunny-videos`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listData = await listRes.json();
  console.log('✓ Course Videos in DB:');
  console.dir(listData.data, { depth: null });

  console.log('\n===========================================');
  console.log(' COURSE AND VIDEOS SUCCESSFULLY UPLOADED! ');
  console.log(` Course ID: ${courseId}`);
  console.log(` Video 1 ID: ${video1Id}`);
  console.log(` Video 2 ID: ${video2Id}`);
  console.log('===========================================\n');
}

main().catch((err) => {
  console.error('\n❌ Execution Error:', err);
  process.exit(1);
});
