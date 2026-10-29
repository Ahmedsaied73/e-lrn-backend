const express = require('express');
const { 
  getAllCourses, 
  getCourseById, 
  createCourse, 
  updateCourse, 
  deleteCourse,
  getUserEnrolledCourses,
  uploadCourseImage
} = require('../controllers/coursesController');
const { authenticateToken, optionalAuth, authorizeAdmin } = require('../middlewares/index');

const router = express.Router();

// Route to get all courses (public catalog / optional auth)
router.get('/', optionalAuth, getAllCourses);

// Route to get courses that the user is enrolled in
router.get('/enrolled', authenticateToken, getUserEnrolledCourses);

// Route to upload course image/thumbnail (admin only)
router.post('/images', authenticateToken, authorizeAdmin(), uploadCourseImage);

// Route to get a specific course by slug or numeric ID (public outline / optional auth)
router.get('/:slug', optionalAuth, getCourseById);

// Route to create a new course (admin only)
router.post('/', authenticateToken, authorizeAdmin, createCourse);

// Route to update a course (admin only)
router.put('/:slug', authenticateToken, authorizeAdmin, updateCourse);

// Route to delete a course (admin only)
router.delete('/:slug', authenticateToken, authorizeAdmin, deleteCourse);

module.exports = router;
