const express = require('express');
const Userrouter = express.Router();
const { authenticateToken, authorizeAdmin } = require('../middlewares');
const { deleteUser , updateUser , getUser , getUserById , getAllUsers } = require('../controllers/userController');
const prisma = require('../config/db');

// Get authenticated user data
Userrouter.get('/me', authenticateToken, getUser);
 
// Delete user (admin only)
Userrouter.delete('/:userId', authenticateToken, authorizeAdmin, deleteUser);

// update user
Userrouter.put('/:userId', authenticateToken, updateUser);

// Get user by ID (admin only)
Userrouter.get('/:userId', authenticateToken, authorizeAdmin, getUserById);

// Get all users (admin only)
Userrouter.get('/', authenticateToken, authorizeAdmin, getAllUsers);

module.exports = Userrouter;