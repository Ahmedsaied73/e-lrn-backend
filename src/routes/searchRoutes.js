const express = require('express');
const { authenticateToken } = require('../middlewares');
const {
  searchContent,
  getTrendingCourses,
  getRecommendedCourses
} = require('../controllers/searchController');

const router = express.Router();

// Search courses and videos
router.get('/content', authenticateToken, searchContent);

// Get trending courses
router.get('/trending', authenticateToken, getTrendingCourses);

// Get recommended courses for the user
router.get('/recommended', authenticateToken, getRecommendedCourses);

module.exports = router; 