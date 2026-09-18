const express = require('express');
const Userrouter = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { deleteUser , updateUser , getUser , getUserById , getAllUsers } = require('../controllers/userController');
const { getAchievements } = require('../controllers/achievementsController');

// Get authenticated user data
Userrouter.get('/me', authenticateToken, getUser);

// Achievements aggregate: course progress + quiz results summary
Userrouter.get('/me/achievements', authenticateToken, getAchievements);
 
// Delete user (admin only)
Userrouter.delete('/:userSlug', authenticateToken, authorizeAdmin, deleteUser);

// update user
Userrouter.put('/:userSlug', authenticateToken, updateUser);

// Get user by slug (admin only)
Userrouter.get('/:userSlug', authenticateToken, authorizeAdmin, getUserById);

// Get all users (admin only)
Userrouter.get('/', authenticateToken, authorizeAdmin, getAllUsers);

module.exports = Userrouter;
