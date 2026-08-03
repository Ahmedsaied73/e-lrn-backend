const prisma = require('../config/db');
const bcrypt = require('bcrypt');

const selectWithoutPassword = {
  id: true,
  name: true,
  email: true,
  phoneNumber: true,
  grade: true,
  role: true,
  createdAt: true,
  updatedAt: true
};

// Helper function to handle errors
const handleError = (res, error, message) => {
  console.error(message, error);
  res.status(500).json({ success: false, error: 'Internal server error.' });
};

// get my data as a user
const getUser = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: selectWithoutPassword
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    handleError(res, error, 'Error fetching user data:');
  }
};

// delete user
const deleteUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(userId, 10) }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Prevent admin from deleting themselves
    if (parseInt(userId, 10) === req.user.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own admin account.' });
    }

    // Delete the user
    await prisma.user.delete({
      where: { id: parseInt(userId, 10) }
    });

    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (error) {
    handleError(res, error, 'Error deleting user:');
  }
};

// update user
const updateUser = async (req, res) => {
  const { userId } = req.params;
  const { name, email, password } = req.body;
  const requesterId = req.user.id;
  const requesterRole = req.user.role;

  try {
    // Check if the requester is the user themselves or an admin
    if (requesterId !== parseInt(userId) && requesterRole !== 'ADMIN') {
      return res.status(403).json({ success: false, error: "You do not have permission to update this user's data." });
    }

    // Update user data
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (password) updateData.password = await bcrypt.hash(password, 10);

    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: updateData,
      select: selectWithoutPassword
    });

    res.json({ success: true, message: "User data updated successfully", data: updatedUser });
  } catch (error) {
    handleError(res, error, 'An error occurred while updating user data');
  }
};

// Get user by ID (admin only)
const getUserById = async (req, res) => {
  const { userId } = req.params;

  try {
    // Get user data
    const user = await prisma.user.findUnique({
      where: { id: parseInt(userId, 10) },
      select: selectWithoutPassword
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    handleError(res, error, 'An error occurred while retrieving user data');
  }
};

// Get all users (admin only, with pagination)
const getAllUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const take = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * take;

    // Get all users data
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip,
        take,
        select: selectWithoutPassword
      }),
      prisma.user.count()
    ]);

    res.json({ 
      success: true, 
      data: users,
      meta: {
        total,
        page,
        limit: take,
        totalPages: Math.ceil(total / take)
      }
    });
  } catch (error) {
    handleError(res, error, 'An error occurred while retrieving users data');
  }
};

module.exports = {
  deleteUser,
  updateUser,
  getUser,
  getUserById,
  getAllUsers
};