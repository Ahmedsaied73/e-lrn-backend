const express = require('express');
const { 
  getAllCourses, 
  getCourseById, 
  createCourse, 
  updateCourse, 
  deleteCourse,
  getUserEnrolledCourses
} = require('../controllers/coursesController');
const { authenticateToken, authorizeAdmin } = require('../middlewares');
const { handleCourseThumbnailUpload } = require('../utils/fileUpload');

const router = express.Router();

// Route to get all courses (with authentication)
router.get('/', authenticateToken, getAllCourses);

// Route to get courses that the user is enrolled in
router.get('/enrolled', authenticateToken, getUserEnrolledCourses);

// Route to get a specific course by ID (with authentication)
router.get('/:id', authenticateToken, getCourseById);

// Route to create a new course with thumbnail upload (admin only)
router.post('/', authenticateToken, authorizeAdmin, handleCourseThumbnailUpload, createCourse);

// Route to update a course with thumbnail upload (admin only)
router.put('/:id', authenticateToken, authorizeAdmin, handleCourseThumbnailUpload, updateCourse);

// Route to delete a course (admin only)
router.delete('/:id', authenticateToken, authorizeAdmin, deleteCourse);

module.exports = router;
