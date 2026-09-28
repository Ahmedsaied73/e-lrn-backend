/**
 * This script tests if all required middleware and controller functions are properly defined
 * Run this to check if there are any undefined imports or exports that could cause errors
 */

console.log('Testing imports...');

try {
  // Test middleware imports
  const middlewares = require('../src/middlewares');
  console.log('Middleware exports:');
  Object.keys(middlewares).forEach(key => {
    console.log(`  - ${key}: ${typeof middlewares[key]}`);
  });
  
  // Test access control middleware
  const accessControl = require('../src/middlewares/accessControl');
  console.log('\nAccess control exports:');
  Object.keys(accessControl).forEach(key => {
    console.log(`  - ${key}: ${typeof accessControl[key]}`);
  });
  
  // Test video stream controller
  const videoStreamController = require('../src/controllers/videoStreamController');
  console.log('\nVideo stream controller exports:');
  Object.keys(videoStreamController).forEach(key => {
    console.log(`  - ${key}: ${typeof videoStreamController[key]}`);
  });
  
  // Test all route imports to verify they don't throw errors
  console.log('\nTesting route imports:');
  
  const authRoutes = require('../src/routes/auth');
  console.log('  ✓ Auth routes imported successfully');
  
  const userRoutes = require('../src/routes/users');
  console.log('  ✓ User routes imported successfully');
  
  const courseRoutes = require('../src/routes/courses');
  console.log('  ✓ Course routes imported successfully');
  
  const videoRoutes = require('../src/routes/videos');
  console.log('  ✓ Video routes imported successfully');
  
  const youtubeRoutes = require('../src/routes/youtubeRoutes');
  console.log('  ✓ YouTube routes imported successfully');
  
  const streamRoutes = require('../src/routes/streamRoutes');
  console.log('  ✓ Stream routes imported successfully');
  
  console.log('\nAll imports tested successfully!');
} catch (error) {
  console.error('Error testing imports:', error);
} 