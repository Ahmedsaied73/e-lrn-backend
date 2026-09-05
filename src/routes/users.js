const express = require('express');
const Userrouter = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares/index');
const { deleteUser , updateUser , getUser , getUserById , getAllUsers } = require('../controllers/userController');
const { getAchievements } = require('../controllers/achievementsController');
const prisma = require('../config/db');

// Get authenticated user data
Userrouter.get('/me', authenticateToken, getUser);

// Achievements aggregate: course progress + quiz results summary
Userrouter.get('/me/achievements', authenticateToken, getAchievements);
 
// Delete user (admin only)
Userrouter.delete('/:userId', authenticateToken, authorizeAdmin, deleteUser);

// update user
Userrouter.put('/:userId', authenticateToken, updateUser);

// Get user by ID (admin only)
Userrouter.get('/:userId', authenticateToken, authorizeAdmin, getUserById);

// Get all users (admin only)
Userrouter.get('/', authenticateToken, authorizeAdmin, getAllUsers);

module.exports = Userrouter;
