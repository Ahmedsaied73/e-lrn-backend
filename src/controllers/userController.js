const prisma = require('../config/db');
const bcrypt = require('bcrypt');

// Helper function to find a user by ID
const findUserById = async (id) => {
  return await prisma.user.findUnique({
    where: { id: parseInt(id, 10) }
  });
};

// Helper function to handle errors
const handleError = (res, error, message) => {
  console.error(message, error);
  res.status(500).json({ error: 'Internal server error.' });
};

// get my data as a user
const getUser = async (req, res) => {
  try {
    const user = await findUserById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const data = { phoneNumber: user.phoneNumber, createdAt: user.createdAt, updatedAt: user.updatedAt, email: user.email, name:user.name, role: user.role, id: user.id, grade: user.grade }
    res.json(data);
  } catch (error) {
    handleError(res, error, 'Error fetching user data:');
  }
};

// delete user
const deleteUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await findUserById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Prevent admin from deleting themselves
    if (parseInt(userId, 10) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own admin account.' });
    }

    // Delete the user
    await prisma.user.delete({
      where: { id: parseInt(userId, 10) }
    });

    res.json({ message: 'User deleted successfully.' });
  } catch (error) {
    handleError(res, error, 'Error deleting user:');
  }
};

// update user
async function updateUser(req, res) {
  const { userId } = req.params;
  const { name, email, password } = req.body;
  const requesterId = req.user.id; // Assuming req.user is set by authentication middleware
  const requesterRole = req.user.role; // Assuming req.user.role is set by authentication middleware

  try {
    // Check if the requester is the user themselves or an admin
    if (requesterId !== parseInt(userId) && requesterRole !== 'ADMIN') {
      return res.status(403).json({ message: "You do not have permission to update this user's data." });
    }

    // Update user data
    const updatedUser = await prisma.user.update({
      where: { id: parseInt(userId) },
      data: {
        name: name || undefined,
        email: email || undefined,
        password: password ? await bcrypt.hash(password, 10) : undefined
      }
    });

    res.json({ message: "User data updated successfully", user: updatedUser });
  } catch (error) {
    handleError(res, error, 'An error occurred while updating user data');
  }
};

// Get user by ID (admin only)
const getUserById = async (req, res) => {
  const { userId } = req.params;

  try {
    // Check if the requester is an admin
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: "You do not have permission to access this user's data." });
    }

    // Get user data
    const user = await findUserById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    res.json({ user });
  } catch (error) {
    handleError(res, error, 'An error occurred while retrieving user data');
  }
}

// Get all users (admin only)
const getAllUsers = async (req, res) => {
  try {
    // Check if the requester is an admin
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: "You do not have permission to access all users' data." });
    }

    // Get all users data
    const users = await prisma.user.findMany();

    res.json({ users });
  } catch (error) {
    handleError(res, error, 'An error occurred while retrieving users data');
  }
}

module.exports = {
  deleteUser,
  updateUser,
  getUser,
  getUserById,
  getAllUsers
};