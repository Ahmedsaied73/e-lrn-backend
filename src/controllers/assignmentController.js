const prisma = require('../config/db');

/**
 * Create a new assignment (admin only)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const createAssignment = async (req, res) => {
  try {
    const { title, description, videoId, dueDate } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({ error: 'Assignment title is required' });
    }

    if (!videoId) {
      return res.status(400).json({ error: 'Video ID is required' });
    }

    // Verify the video exists
    const video = await prisma.video.findUnique({
      where: { id: parseInt(videoId) },
      select: { id: true, courseId: true }
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Create the assignment
    const assignment = await prisma.assignment.create({
      data: {
        title,
        description,
        videoId: parseInt(videoId),
        dueDate: dueDate ? new Date(dueDate) : null
      }
    });

    res.status(201).json({
      message: 'Assignment created successfully',
      assignment
    });
  } catch (error) {
    console.error('Error creating assignment:', error);
    res.status(500).json({ error: 'Failed to create assignment' });
  }
};

/**
 * Get an assignment by ID
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Fetch the assignment
    const assignment = await prisma.assignment.findUnique({
      where: { id: parseInt(id) },
      include: {
        video: {
          select: {
            id: true,
            title: true,
            courseId: true
          }
        }
      }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Check if user is enrolled in the course
    if (req.user.role !== 'ADMIN') {
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          userId: userId,
          courseId: assignment.video.courseId,
          isPaid: true
        }
      });

      if (!enrollment) {
        return res.status(403).json({
          error: 'You must be enrolled in this course to access this assignment'
        });
      }
    }

    // Check if the user has already submitted this assignment
    const submission = await prisma.submission.findUnique({
      where: {
        userId_assignmentId: {
          userId: userId,
          assignmentId: parseInt(id)
        }
      }
    });

    // Return assignment with submission status
    res.json({
      ...assignment,
      hasSubmitted: !!submission,
      submission: submission
    });
  } catch (error) {
    console.error('Error fetching assignment:', error);
    res.status(500).json({ error: 'Failed to fetch assignment' });
  }
};

/**
 * Submit an assignment
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const submitAssignment = async (req, res) => {
  try {
    const { assignmentId, content, fileUrl } = req.body;
    const userId = req.user.id;

    if (!assignmentId) {
      return res.status(400).json({ error: 'Assignment ID is required' });
    }

    if (!content && !fileUrl) {
      return res.status(400).json({ error: 'Content or file URL is required' });
    }

    // Verify the assignment exists
    const assignment = await prisma.assignment.findUnique({
      where: { id: parseInt(assignmentId) },
      include: {
        video: {
          select: {
            courseId: true
          }
        }
      }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Verify user is enrolled in the course
    if (req.user.role !== 'ADMIN') {
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          userId: userId,
          courseId: assignment.video.courseId,
          isPaid: true
        }
      });

      if (!enrollment) {
        return res.status(403).json({
          error: 'You must be enrolled in this course to submit assignments'
        });
      }
    }

    // Check if the assignment due date has passed
    if (assignment.dueDate && new Date() > new Date(assignment.dueDate)) {
      return res.status(400).json({
        error: 'The due date for this assignment has passed',
        dueDate: assignment.dueDate
      });
    }

    // Check if the user has already submitted this assignment
    const existingSubmission = await prisma.submission.findUnique({
      where: {
        userId_assignmentId: {
          userId: userId,
          assignmentId: parseInt(assignmentId)
        }
      }
    });

    let submission;

    if (existingSubmission) {
      // Update existing submission if it's still pending
      if (existingSubmission.status !== 'PENDING') {
        return res.status(400).json({
          error: 'This assignment has already been graded and cannot be resubmitted'
        });
      }

      submission = await prisma.submission.update({
        where: { id: existingSubmission.id },
        data: {
          content,
          fileUrl,
          submittedAt: new Date()
        }
      });
    } else {
      // Create new submission
      submission = await prisma.submission.create({
        data: {
          userId: userId,
          assignmentId: parseInt(assignmentId),
          content,
          fileUrl,
          status: 'PENDING'
        }
      });
    }

    res.json({
      message: 'Assignment submitted successfully',
      submission
    });
  } catch (error) {
    console.error('Error submitting assignment:', error);
    res.status(500).json({ error: 'Failed to submit assignment' });
  }
};

/**
 * Grade a submission (admin only)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const gradeSubmission = async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { grade, feedback, status } = req.body;

    if (!grade || isNaN(parseFloat(grade))) {
      return res.status(400).json({ error: 'Valid grade is required' });
    }

    // Verify the submission exists
    const submission = await prisma.submission.findUnique({
      where: { id: parseInt(submissionId) },
      include: {
        assignment: true
      }
    });

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Update the submission with grade and feedback
    const updatedSubmission = await prisma.submission.update({
      where: { id: parseInt(submissionId) },
      data: {
        grade: parseFloat(grade),
        feedback,
        status: status || 'GRADED',
        gradedAt: new Date()
      }
    });

    res.json({
      message: 'Submission graded successfully',
      submission: updatedSubmission
    });
  } catch (error) {
    console.error('Error grading submission:', error);
    res.status(500).json({ error: 'Failed to grade submission' });
  }
};

/**
 * Get all assignments for a video
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getVideoAssignments = async (req, res) => {
  try {
    const { videoId } = req.params;
    const userId = req.user.id;

    // Verify the video exists
    const video = await prisma.video.findUnique({
      where: { id: parseInt(videoId) },
      select: { id: true, courseId: true }
    });

    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    // Check if user is enrolled in the course
    if (req.user.role !== 'ADMIN') {
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          userId: userId,
          courseId: video.courseId,
          isPaid: true
        }
      });

      if (!enrollment) {
        return res.status(403).json({
          error: 'You must be enrolled in this course to access assignments'
        });
      }
    }

    // Get all assignments for the video
    const assignments = await prisma.assignment.findMany({
      where: { videoId: parseInt(videoId) },
      orderBy: { createdAt: 'desc' }
    });

    // Get user's submissions for these assignments
    const assignmentIds = assignments.map(a => a.id);
    const submissions = await prisma.submission.findMany({
      where: {
        userId: userId,
        assignmentId: { in: assignmentIds }
      }
    });

    // Create a map of assignment ID to submission
    const submissionMap = {};
    submissions.forEach(sub => {
      submissionMap[sub.assignmentId] = sub;
    });

    // Add submission info to each assignment
    const assignmentsWithSubmissions = assignments.map(assignment => ({
      ...assignment,
      hasSubmitted: !!submissionMap[assignment.id],
      submission: submissionMap[assignment.id] ? {
        id: submissionMap[assignment.id].id,
        status: submissionMap[assignment.id].status,
        grade: submissionMap[assignment.id].grade,
        submittedAt: submissionMap[assignment.id].submittedAt
      } : null
    }));

    res.json({
      assignments: assignmentsWithSubmissions
    });
  } catch (error) {
    console.error('Error fetching video assignments:', error);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
};

/**
 * Get all submissions for an assignment (admin only)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAssignmentSubmissions = async (req, res) => {
  try {
    const { assignmentId } = req.params;

    // Verify the assignment exists
    const assignment = await prisma.assignment.findUnique({
      where: { id: parseInt(assignmentId) }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Get all submissions for the assignment
    const submissions = await prisma.submission.findMany({
      where: { assignmentId: parseInt(assignmentId) },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      },
      orderBy: { submittedAt: 'desc' }
    });

    res.json({
      assignmentId: parseInt(assignmentId),
      title: assignment.title,
      submissionsCount: submissions.length,
      submissions
    });
  } catch (error) {
    console.error('Error fetching assignment submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};

/**
 * Get all submissions by the current user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getUserSubmissions = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all submissions by this user
    const submissions = await prisma.submission.findMany({
      where: { userId: userId },
      include: {
        assignment: {
          include: {
            video: {
              select: {
                id: true,
                title: true,
                courseId: true
              }
            }
          }
        }
      },
      orderBy: { submittedAt: 'desc' }
    });

    res.json({
      submissionsCount: submissions.length,
      submissions
    });
  } catch (error) {
    console.error('Error fetching user submissions:', error);
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
};

module.exports = {
  createAssignment,
  getAssignment,
  submitAssignment,
  gradeSubmission,
  getVideoAssignments,
  getAssignmentSubmissions,
  getUserSubmissions
};