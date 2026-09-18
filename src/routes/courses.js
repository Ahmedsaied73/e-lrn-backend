const express = require('express');
const { 
  getAllCourses, 
  getCourseById, 
  createCourse, 
  updateCourse, 
  deleteCourse,
  getUserEnrolledCourses
} = require('../controllers/coursesController');
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');

const router = express.Router();

// Route to get all courses (with authentication)
router.get('/', authenticateToken, getAllCourses);

// Route to get courses that the user is enrolled in
router.get('/enrolled', authenticateToken, getUserEnrolledCourses);

// Route to get a specific course by slug (with authentication)
router.get('/:slug', authenticateToken, getCourseById);

// Route to create a new course (admin only)
router.post('/', authenticateToken, authorizeAdmin, createCourse);

// Route to update a course (admin only)
router.put('/:slug', authenticateToken, authorizeAdmin, updateCourse);

// Route to delete a course (admin only)
router.delete('/:slug', authenticateToken, authorizeAdmin, deleteCourse);

module.exports = router;
