const prisma = require('../config/db');
const bcrypt = require('bcrypt');

const selectWithoutPassword = {
  id: true,
  name: true,
  email: true,
  phoneNumber: true,
  grade: true,
  role: true,
  lastLoginAt: true,
  createdAt: true
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
  const userIdNum = parseInt(userId, 10);

  try {
    if (!Number.isSafeInteger(userIdNum) || userIdNum <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userIdNum }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // Prevent admin from deleting themselves
    if (userIdNum === req.user.id) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own admin account.' });
    }

    // Course owners must release their courses first (bulk delete would bypass
    // the Bunny remote-video cleanup in coursesController). Students never own
    // courses, so this only affects admins/teachers.
    const ownedCourses = await prisma.course.count({ where: { teacherId: userIdNum } });
    if (ownedCourses > 0) {
      return res.status(409).json({ success: false, error: 'User owns courses. Move or delete their courses before deleting the user.' });
    }

    // Transactional cascade: several child relations (Enrollment, Payment,
    // Certificate, VideoProgress, AssignmentAnswer, Submission) default to
    // Restrict — a raw user.delete would throw a P2003 FK failure for any user
    // with rows in those tables. Explicitly remove children first, then the user.
    await prisma.$transaction([
      prisma.quizAttempt.deleteMany({ where: { userId: userIdNum } }),
      prisma.gateExemption.deleteMany({ where: { userId: userIdNum } }),
      prisma.assignmentAnswer.deleteMany({ where: { userId: userIdNum } }),
      prisma.submission.deleteMany({ where: { userId: userIdNum } }),
      prisma.bunnyVideoProgress.deleteMany({ where: { userId: userIdNum } }),
      prisma.videoProgress.deleteMany({ where: { userId: userIdNum } }),
      prisma.enrollment.deleteMany({ where: { userId: userIdNum } }),
      prisma.payment.deleteMany({ where: { userId: userIdNum } }),
      prisma.certificate.deleteMany({ where: { userId: userIdNum } }),
      prisma.user.delete({ where: { id: userIdNum } })
    ]);

    res.json({ success: true, message: 'User deleted successfully.' });
  } catch (error) {
    handleError(res, error, 'Error deleting user:');
  }
};

// update user
const updateUser = async (req, res) => {
  const { userId } = req.params;
  const { name, email, password, grade, phoneNumber } = req.body;
  const requesterId = req.user.id;
  const requesterRole = req.user.role;
  const parsedUserId = parseInt(userId, 10);

  try {
    if (!Number.isSafeInteger(parsedUserId) || parsedUserId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid user ID.' });
    }

    // Check if the requester is the user themselves or an admin
    if (requesterId !== parsedUserId && requesterRole !== 'ADMIN') {
      return res.status(403).json({ success: false, error: "You do not have permission to update this user's data." });
    }

    const isAdmin = requesterRole === 'ADMIN';

    // Update user data
    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (password) updateData.password = await bcrypt.hash(password, 10);
    // Admin-only fields: students cannot self-edit grade / phoneNumber
    if (isAdmin) {
      const GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
      if (grade !== undefined) {
        if (!GRADES.includes(grade)) {
          return res.status(400).json({ success: false, error: 'Invalid grade value.' });
        }
        updateData.grade = grade;
      }
      if (phoneNumber !== undefined && phoneNumber !== null && String(phoneNumber).trim() !== '') {
        updateData.phoneNumber = String(phoneNumber).trim();
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: parsedUserId },
      data: updateData,
      select: selectWithoutPassword
    });

    res.json({ success: true, message: "User data updated successfully", data: updatedUser });
  } catch (error) {
    if (error && error.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Email or phone number already in use.' });
    }
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

// Get all users (admin only, with pagination, filters, sorting)
const getAllUsers = async (req, res) => {
  try {
    const ROLES = ['STUDENT', 'ADMIN'];
    const GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];

    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const take = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
    const skip = (page - 1) * take;

    const where = {};
    if (ROLES.includes(req.query.role)) where.role = req.query.role;
    if (GRADES.includes(req.query.grade)) where.grade = req.query.grade;
    const search = (req.query.search || '').trim();
    if (search) {
      // MySQL: contains is case-insensitive by default (no `mode` support).
      where.OR = [{ name: { contains: search } }, { email: { contains: search } }];
    }

    const orderBy = [];
    const rawSort = (req.query.sort || '').trim();
    if (['name', 'createdAt'].includes(rawSort.replace(/^-/, ''))) {
      const dir = rawSort.startsWith('-') ? 'desc' : 'asc';
      orderBy.push({ [rawSort.replace(/^-/, '')]: dir });
    }
    orderBy.push({ id: 'asc' });

    // Get all users data
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        skip,
        take,
        where,
        orderBy,
        select: selectWithoutPassword
      }),
      prisma.user.count({ where })
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