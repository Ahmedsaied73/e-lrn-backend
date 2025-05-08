const prisma = require('../config/db');

/**
 * Create a new assignment (admin only)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const createAssignment = async (req, res) => {
  try {
    const { title, description, videoId, dueDate, isMCQ, passingScore, questions } = req.body;

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
        dueDate: dueDate ? new Date(dueDate) : null,
        isMCQ: isMCQ === true,
        passingScore: isMCQ === true ? parseFloat(passingScore) || 70.0 : 70.0, // Default value for non-MCQ assignments
        video: {
          connect: { id: parseInt(videoId) }
        }
      }
    });

    // If it's an MCQ assignment, create the questions
    if (isMCQ === true && Array.isArray(questions) && questions.length > 0) {
      // Create questions for the MCQ assignment
      const createdQuestions = await Promise.all(
        questions.map(async (question) => {
          return await prisma.assignmentQuestion.create({
            data: {
              assignmentId: assignment.id,
              text: question.text,
              options: question.options,
              correctOption: question.correctOption,
              explanation: question.explanation,
              points: question.points || 1
            }
          });
        })
      );

      // Return the assignment with questions
      return res.status(201).json({
        message: 'MCQ assignment created successfully',
        assignment: {
          ...assignment,
          questions: createdQuestions
        }
      });
    }

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
      where: { id: parseInt(id, 10) },
      include: {
        video: {
          select: {
            id: true,
            title: true,
            courseId: true
          }
        },
        AssignmentQuestion: true // Include MCQ questions if it's an MCQ assignment
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

    // For MCQ assignments, get the user's answers if they exist
    let userAnswers = [];
    if (assignment.isMCQ && assignment.AssignmentQuestion.length > 0) {
      const questionIds = assignment.AssignmentQuestion.map(q => q.id);
      userAnswers = await prisma.assignmentAnswer.findMany({
        where: {
          userId: userId,
          questionId: { in: questionIds }
        }
      });

      // Map user answers to questions
      assignment.AssignmentQuestion = assignment.AssignmentQuestion.map(question => {
        const userAnswer = userAnswers.find(a => a.questionId === question.id);
        return {
          ...question,
          userAnswer: userAnswer ? {
            selectedOption: userAnswer.selectedOption,
            isCorrect: userAnswer.isCorrect
          } : null
        };
      });
    }

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
    const { assignmentId, content, fileUrl, answers } = req.body;
    const userId = req.user.id;

    if (!assignmentId) {
      return res.status(400).json({ error: 'Assignment ID is required' });
    }

    // Verify the assignment exists
    const assignment = await prisma.assignment.findUnique({
      where: { id: parseInt(assignmentId, 10) },
      include: {
        video: {
          select: {
            courseId: true
          }
        },
        AssignmentQuestion: true // Include questions for MCQ assignments
      }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Validate input based on assignment type
    if (assignment.isMCQ) {
      if (!Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ error: 'Answers are required for MCQ assignments' });
      }
    } else {
      if (!content && !fileUrl) {
        return res.status(400).json({ error: 'Content or file URL is required for non-MCQ assignments' });
      }
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

    // Check if the assignment has a due date and if it has passed
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
    let mcqScore = null;

    // Handle MCQ assignment submission
    if (assignment.isMCQ) {
      // Process MCQ answers
      let correctAnswers = 0;
      let totalPoints = 0;
      
      // Delete any existing answers if resubmitting
      if (existingSubmission) {
        await prisma.assignmentAnswer.deleteMany({
          where: {
            userId: userId,
            questionId: {
              in: assignment.AssignmentQuestion.map(q => q.id)
            }
          }
        });
      }

      // Create answers for each question
      for (const answer of answers) {
        const question = assignment.AssignmentQuestion.find(q => q.id === parseInt(answer.questionId));
        
        if (!question) continue;
        
        const isCorrect = parseInt(answer.selectedOption) === question.correctOption;
        
        await prisma.assignmentAnswer.create({
          data: {
            userId: userId,
            questionId: question.id,
            selectedOption: parseInt(answer.selectedOption),
            isCorrect: isCorrect
          }
        });

        if (isCorrect) {
          correctAnswers += question.points;
        }
        totalPoints += question.points;
      }

      // Calculate score as percentage
      mcqScore = totalPoints > 0 ? (correctAnswers / totalPoints) * 100 : 0;
    }

    if (existingSubmission) {
      // Update existing submission
      if (existingSubmission.status !== 'PENDING') {
        return res.status(400).json({
          error: 'This assignment has already been graded and cannot be resubmitted'
        });
      }

      submission = await prisma.submission.update({
        where: { id: existingSubmission.id },
        data: {
          content: assignment.isMCQ ? null : content,
          fileUrl: assignment.isMCQ ? null : fileUrl,
          mcqScore: assignment.isMCQ ? mcqScore : null,
          submittedAt: new Date(),
          // Auto-grade MCQ assignments
          status: assignment.isMCQ ? 'GRADED' : 'PENDING',
          grade: assignment.isMCQ ? mcqScore : null,
          gradedAt: assignment.isMCQ ? new Date() : null
        }
      });
    } else {
      // Create new submission
      submission = await prisma.submission.create({
        data: {
          userId: userId,
          assignmentId: parseInt(assignmentId),
          content: assignment.isMCQ ? null : content,
          fileUrl: assignment.isMCQ ? null : fileUrl,
          mcqScore: assignment.isMCQ ? mcqScore : null,
          status: assignment.isMCQ ? 'GRADED' : 'PENDING',
          grade: assignment.isMCQ ? mcqScore : null,
          gradedAt: assignment.isMCQ ? new Date() : null
        }
      });
    }

    // For MCQ assignments, include the score and whether it passed
    if (assignment.isMCQ) {
      const passed = mcqScore >= assignment.passingScore;
      return res.json({
        message: `MCQ assignment ${passed ? 'passed' : 'failed'}`,
        submission,
        mcqScore,
        passed,
        passingScore: assignment.passingScore
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

    // Validate assignmentId is provided and is a valid number
    if (!assignmentId || isNaN(parseInt(assignmentId, 10))) {
      return res.status(400).json({ error: 'Valid assignment ID is required' });
    }

    const assignmentIdInt = parseInt(assignmentId, 10);

    // Verify the assignment exists
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentIdInt }
    });

    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Get all submissions for the assignment
    const submissions = await prisma.submission.findMany({
      where: { assignmentId: assignmentIdInt },
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
      assignmentId: assignmentIdInt,
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

/**
 * Get status of a specific assignment for the current user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAssignmentStatus = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const userId = req.user.id;

    // Validate assignmentId
    const parsedAssignmentId = parseInt(assignmentId, 10);
    if (isNaN(parsedAssignmentId)) {
      return res.status(400).json({ error: 'Invalid assignment ID format' });
    }

    // Verify the assignment exists
    const assignment = await prisma.assignment.findUnique({
      where: { id: parsedAssignmentId },
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

    // Check if the user has submitted this assignment
    const submission = await prisma.submission.findUnique({
      where: {
        userId_assignmentId: {
          userId: userId,
          assignmentId: parsedAssignmentId
        }
      }
    });

    // If no submission found
    if (!submission) {
      return res.json({
        assignmentId: parsedAssignmentId,
        title: assignment.title,
        submitted: false,
        status: 'NOT_SUBMITTED',
        message: 'User has not submitted this assignment yet',
        dueDate: assignment.dueDate,
        isPastDue: assignment.dueDate ? new Date() > new Date(assignment.dueDate) : false
      });
    }

    // For MCQ assignments, include score details
    let mcqDetails = null;
    if (assignment.isMCQ) {
      mcqDetails = {
        score: submission.mcqScore,
        passingScore: assignment.passingScore,
        passed: submission.mcqScore >= assignment.passingScore
      };
    }

    res.json({
      assignmentId: parsedAssignmentId,
      title: assignment.title,
      submitted: true,
      submittedAt: submission.submittedAt,
      status: submission.status,
      grade: submission.grade,
      feedback: submission.feedback,
      isMCQ: assignment.isMCQ,
      mcq: mcqDetails,
      gradedAt: submission.gradedAt,
      dueDate: assignment.dueDate,
      isPastDue: assignment.dueDate ? new Date() > new Date(assignment.dueDate) : false
    });
  } catch (error) {
    console.error('Error getting assignment status:', error);
    res.status(500).json({ error: 'Failed to get assignment status' });
  }
};

module.exports = {
  createAssignment,
  getAssignment,
  submitAssignment,
  gradeSubmission,
  getVideoAssignments,
  getAssignmentSubmissions,
  getUserSubmissions,
  getAssignmentStatus
};