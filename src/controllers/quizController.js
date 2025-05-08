const prisma = require('../config/db');
const { performance } = require('perf_hooks');

/**
 * Custom logger for API requests
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requestLogger = (req, res, next) => {
  // Store the start time
  const startTime = performance.now();
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  
  // Store original end method
  const originalEnd = res.end;
  
  // Get request details
  const { method, originalUrl, ip } = req;
  const userAgent = req.get('user-agent') || 'unknown';
  const userId = req.user ? req.user.id : 'unauthenticated';
  
  // Log request start
  console.log(`[${new Date().toISOString()}] [${requestId}] ${method} ${originalUrl} - Started - User: ${userId} - IP: ${ip}`);
  
  // Override end method to log response
  res.end = function(chunk, encoding) {
    // Calculate request duration
    const duration = performance.now() - startTime;
    
    // Log response details
    console.log(
      `[${new Date().toISOString()}] [${requestId}] ${method} ${originalUrl} - ${res.statusCode} - ${duration.toFixed(2)}ms - User: ${userId}`
    );
    
    // Call original end method
    return originalEnd.call(this, chunk, encoding);
  };
  
  next();
};

/**
 * Get all quiz results for the authenticated user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const getUserQuizResults = async (req, res) => {
  try {
    const user = req.user.id;
    // Verify user authentication
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'Unauthorized - User not authenticated'
      });
    }

    const userId = req.user.id;
    if (isNaN(userId)) {
      return res.status(400).json({
        error: 'Invalid user ID format'
      });
    }

    // Get all answers submitted by this user, grouped by quiz
    const userAnswers = await prisma.answer.findMany({
      where: {
        userId: userId
      },
      include: {
        question: {
          include: {
            quiz: {
              include: {
                course: {
                  select: {
                    id: true,
                    title: true
                  }
                },
                video: {
                  select: {
                    id: true,
                    title: true,
                    courseId: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: {
        submittedAt: 'desc'
      }
    });

    if (!userAnswers || userAnswers.length === 0) {
      return res.status(404).json({
        message: 'No quiz results found',
        count: 0,
        results: []
    });
    }

    // Group answers by quiz
    const quizResults = {};
    
    for (const answer of userAnswers) {
      const quizId = answer.question.quizId;
      
      if (!quizResults[quizId]) {
        // Initialize quiz result object
        const quiz = answer.question.quiz;
        quizResults[quizId] = {
          quizId: quizId,
          title: quiz.title,
          description: quiz.description,
          isFinal: quiz.isFinal,
          passingScore: quiz.passingScore,
          courseId: quiz.courseId || (quiz.video ? quiz.video.courseId : null),
          courseTitle: quiz.course ? quiz.course.title : (quiz.video ? quiz.video.title : null),
          videoId: quiz.videoId,
          videoTitle: quiz.video ? quiz.video.title : null,
          submittedAt: answer.submittedAt,
          answers: [],
          correctAnswers: 0,
          totalQuestions: 0,
          earnedPoints: 0,
          totalPoints: 0,
          score: 0,
          passed: false
        };
      }
      
      // Add answer to the quiz result
      quizResults[quizId].answers.push({
        questionId: answer.questionId,
        questionText: answer.question.text,
        selectedOption: answer.selectedOption,
        correctOption: answer.question.correctOption,
        isCorrect: answer.isCorrect,
        points: answer.question.points,
        explanation: answer.question.explanation
      });
      
      // Update statistics
      if (answer.isCorrect) {
        quizResults[quizId].correctAnswers++;
        quizResults[quizId].earnedPoints += answer.question.points;
      }
      quizResults[quizId].totalQuestions++;
      quizResults[quizId].totalPoints += answer.question.points;
    }
    
    // Calculate scores and determine pass/fail status
    for (const quizId in quizResults) {
      const result = quizResults[quizId];
      result.score = result.totalPoints > 0 ? (result.earnedPoints / result.totalPoints) * 100 : 0;
      result.passed = result.score >= result.passingScore;
    }

    // Convert to array and sort by submission date (newest first)
    const resultsArray = Object.values(quizResults).sort((a, b) => 
      new Date(b.submittedAt) - new Date(a.submittedAt)
    );

    res.json({
      message: 'Quiz results retrieved successfully',
      count: resultsArray.length,
      results: resultsArray
    });
  } catch (error) {
    console.error('Error getting user quiz results:', error);
    res.status(500).json({ error: 'Failed to get quiz results' });
  }
};

/**
 * Create a new quiz (admin only)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const createQuiz = async (req, res) => {
  try {
    const { 
      title, 
      description, 
      isFinal, 
      courseId, 
      videoId, 
      passingScore,
      questions 
    } = req.body;

    // Validate required fields
    if (!title) {
      return res.status(400).json({ error: 'Quiz title is required' });
    }

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'At least one question is required' });
    }

    // A quiz must be associated with either a course (final exam) or a video (lecture quiz)
    if (isFinal && !courseId) {
      return res.status(400).json({ error: 'Course ID is required for final exams' });
    }

    if (!isFinal && !videoId) {
      return res.status(400).json({ error: 'Video ID is required for lecture quizzes' });
    }

    // Prepare validation queries
    const validationPromises = [];
    
    if (courseId) {
      validationPromises.push(
        prisma.course.findUnique({
          where: { id: parseInt(courseId) },
          select: { id: true } // Only select ID for faster query
        }).then(course => {
          if (!course) throw new Error('Course not found');
          return true;
        })
      );
    }
    
    if (videoId) {
      validationPromises.push(
        prisma.video.findUnique({
          where: { id: parseInt(videoId) },
          select: { id: true } // Only select ID for faster query
        }).then(video => {
          if (!video) throw new Error('Video not found');
          return true;
        })
      );
    }
    
    // Run validation queries in parallel
    await Promise.all(validationPromises);

    // Validate all questions before transaction
    questions.forEach((question, index) => {
      if (!question.text || !question.options || !Array.isArray(question.options)) {
        throw new Error(`Question at index ${index} must have text and an array of options`);
      }

      if (question.correctOption === undefined || question.correctOption < 0 || 
          question.correctOption >= question.options.length) {
        throw new Error(`Question at index ${index} must have a valid correctOption index`);
      }
    });

    // Create the quiz using a transaction with optimized batch operations
    const quiz = await prisma.$transaction(async (prisma) => {
      // Create the quiz
      const newQuiz = await prisma.quiz.create({
        data: {
          title,
          description,
          isFinal: isFinal || false,
          passingScore: passingScore ? parseFloat(passingScore) : 70.0,
          courseId: courseId ? parseInt(courseId) : null,
          videoId: videoId ? parseInt(videoId) : null
        }
      });

      // Prepare question data for batch creation
      const questionData = questions.map(question => ({
        quizId: newQuiz.id,
        text: question.text,
        options: question.options,
        correctOption: question.correctOption,
        explanation: question.explanation || null,
        points: question.points || 1
      }));

      // Create all questions in a single batch operation
      await prisma.question.createMany({
        data: questionData
      });

      return newQuiz;
    });

    // Fetch the created quiz with its questions
    const quizWithQuestions = await prisma.quiz.findUnique({
      where: { id: quiz.id },
      include: {
        questions: {
          select: {
            id: true,
            text: true,
            options: true,
            points: true,
            // Don't include correctOption in the response
          }
        }
      }
    });

    res.status(201).json({
      message: 'Quiz created successfully',
      quiz: quizWithQuestions
    });
  } catch (error) {
    console.error('Error creating quiz:', error);
    res.status(500).json({ error: 'Failed to create quiz', details: error.message });
  }
};

/**
 * Get a quiz by ID (without correct answers)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getQuiz = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Fetch the quiz
    const quiz = await prisma.quiz.findUnique({
      where: { id: parseInt(id) },
      include: {
        questions: {
          select: {
            id: true,
            text: true,
            options: true,
            points: true
            // Don't include correctOption in the response
          }
        },
        course: {
          select: {
            id: true,
            title: true
          }
        },
        video: {
          select: {
            id: true,
            title: true,
            courseId: true
          }
        }
      }
    });

    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // For lecture quizzes, verify the user has completed the video
    if (!quiz.isFinal && quiz.videoId) {
      // Get the user's role
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true }
      });

      const isAdmin = user && user.role === 'ADMIN';

      if (!isAdmin) {
        // Check if the user has completed the video
        const videoProgress = await prisma.videoProgress.findUnique({
          where: {
            userId_videoId: {
              userId: userId,
              videoId: quiz.videoId
            }
          }
        });

        if (!videoProgress || !videoProgress.completed) {
          return res.status(403).json({
            error: 'You must complete the video before taking the quiz',
            videoId: quiz.videoId
          });
        }
      }
    }

    // For final exams, verify the user has completed all videos in the course
    if (quiz.isFinal && quiz.courseId) {
      // Get the user's role
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true }
      });

      const isAdmin = user && user.role === 'ADMIN';

      if (!isAdmin) {
        // Get all videos in the course
        const courseVideos = await prisma.video.findMany({
          where: { courseId: quiz.courseId },
          select: { id: true }
        });

        const videoIds = courseVideos.map(v => v.id);

        // Count completed videos for this user in this course
        const completedVideosCount = await prisma.videoProgress.count({
          where: {
            userId: userId,
            videoId: { in: videoIds },
            completed: true
          }
        });

        // If the user hasn't completed all videos, don't allow access to the final exam
        if (completedVideosCount < videoIds.length) {
          return res.status(403).json({
            error: 'You must complete all videos before taking the final exam',
            completedVideos: completedVideosCount,
            totalVideos: videoIds.length
          });
        }
      }
    }

    // Check if the user has already taken this quiz
    const userAnswers = await prisma.answer.findMany({
      where: {
        userId: userId,
        question: {
          quizId: parseInt(id)
        }
      },
      include: {
        question: true
      }
    });

    // If the user has already answered some questions, include that information
    if (userAnswers.length > 0) {
      // Calculate the score
      const totalPoints = quiz.questions.reduce((sum, q) => sum + q.points, 0);
      const earnedPoints = userAnswers.reduce((sum, a) => a.isCorrect ? sum + a.question.points : sum, 0);
      const score = totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : 0;

      return res.json({
        ...quiz,
        alreadyTaken: true,
        score: score,
        passed: score >= quiz.passingScore
      });
    }

    res.json(quiz);
  } catch (error) {
    console.error('Error fetching quiz:', error);
    res.status(500).json({ error: 'Failed to fetch quiz' });
  }
};

/**
 * Submit answers for a quiz
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const submitQuizAnswers = async (req, res) => {
  try {
    const { quizId, answers } = req.body;
    const userId = req.user.id;

    if (!quizId || !answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Quiz ID and answers array are required' });
    }

    // Verify the quiz exists
    const quiz = await prisma.quiz.findUnique({
      where: { id: parseInt(quizId) },
      include: {
        questions: true,
        course: true,
        video: true
      }
    });

    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Verify user is enrolled in the course
    let courseId = quiz.courseId;
    if (!courseId && quiz.video) {
      courseId = quiz.video.courseId;
    }

    if (courseId) {
      // Get the user's role
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true }
      });

      const isAdmin = user && user.role === 'ADMIN';

      if (!isAdmin) {
        const enrollment = await prisma.enrollment.findFirst({
          where: {
            userId: userId,
            courseId: courseId,
            isPaid: true
          }
        });

        if (!enrollment) {
          return res.status(403).json({
            error: 'You must be enrolled in this course to take quizzes'
          });
        }
      }
    }

    // Check if the user has already taken this quiz
    const existingAnswers = await prisma.answer.count({
      where: {
        userId: userId,
        question: {
          quizId: parseInt(quizId)
        }
      }
    });

    if (existingAnswers > 0) {
      return res.status(400).json({ error: 'You have already taken this quiz' });
    }

    // Create a map of question IDs to their correct answers
    const questionMap = {};
    quiz.questions.forEach(q => {
      questionMap[q.id] = {
        correctOption: q.correctOption,
        points: q.points
      };
    });

    // Process and save each answer
    const results = [];
    let correctAnswers = 0;
    let totalPoints = 0;
    let earnedPoints = 0;

    for (const answer of answers) {
      if (!answer.questionId || answer.selectedOption === undefined) {
        return res.status(400).json({
          error: 'Each answer must include questionId and selectedOption'
        });
      }

      const questionId = parseInt(answer.questionId);
      const question = questionMap[questionId];

      if (!question) {
        return res.status(400).json({
          error: `Question with ID ${questionId} is not part of this quiz`
        });
      }

      const isCorrect = answer.selectedOption === question.correctOption;
      if (isCorrect) {
        correctAnswers++;
        earnedPoints += question.points;
      }
      totalPoints += question.points;

      // Save the answer
      const savedAnswer = await prisma.answer.create({
        data: {
          userId: userId,
          questionId: questionId,
          selectedOption: answer.selectedOption,
          isCorrect: isCorrect
        }
      });

      results.push({
        questionId: questionId,
        selectedOption: answer.selectedOption,
        isCorrect: isCorrect
      });
    }

    // Calculate the score
    const score = totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : 0;
    const passed = score >= quiz.passingScore;

    res.json({
      message: 'Quiz answers submitted successfully',
      quizId: parseInt(quizId),
      correctAnswers,
      totalQuestions: quiz.questions.length,
      score,
      passingScore: quiz.passingScore,
      passed,
      results
    });
  } catch (error) {
    console.error('Error submitting quiz answers:', error);
    res.status(500).json({ error: 'Failed to submit quiz answers' });
  }
};

/**
 * Get quiz results for a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getQuizResults = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all answers submitted by this user, grouped by quiz
    const userAnswers = await prisma.answer.findMany({
      where: {
        userId: userId
      },
      include: {
        question: {
          include: {
            quiz: {
              include: {
                course: {
                  select: {
                    id: true,
                    title: true
                  }
                },
                video: {
                  select: {
                    id: true,
                    title: true,
                    courseId: true
                  }
                }
              }
            }
          }
        }
      },
      orderBy: {
        submittedAt: 'desc'
      }
    });

    if (!userAnswers || userAnswers.length === 0) {
      return res.status(404).json({
        message: 'No quiz results found',
        count: 0,
        results: []
      });
    }

    // Group answers by quiz
    const quizResults = {};
    
    for (const answer of userAnswers) {
      const quizId = answer.question.quizId;
      
      if (!quizResults[quizId]) {
        // Initialize quiz result object
        const quiz = answer.question.quiz;
        quizResults[quizId] = {
          quizId: quizId,
          title: quiz.title,
          description: quiz.description,
          isFinal: quiz.isFinal,
          passingScore: quiz.passingScore,
          courseId: quiz.courseId || (quiz.video ? quiz.video.courseId : null),
          courseTitle: quiz.course ? quiz.course.title : (quiz.video ? quiz.video.title : null),
          videoId: quiz.videoId,
          videoTitle: quiz.video ? quiz.video.title : null,
          submittedAt: answer.submittedAt,
          answers: [],
          correctAnswers: 0,
          totalQuestions: 0,
          earnedPoints: 0,
          totalPoints: 0,
          score: 0,
          passed: false
        };
      }
      
      // Add answer to the quiz result
      quizResults[quizId].answers.push({
        questionId: answer.questionId,
        questionText: answer.question.text,
        selectedOption: answer.selectedOption,
        correctOption: answer.question.correctOption,
        isCorrect: answer.isCorrect,
        points: answer.question.points,
        explanation: answer.question.explanation
      });
      
      // Update statistics
      if (answer.isCorrect) {
        quizResults[quizId].correctAnswers++;
        quizResults[quizId].earnedPoints += answer.question.points;
      }
      quizResults[quizId].totalQuestions++;
      quizResults[quizId].totalPoints += answer.question.points;
    }
    
    // Calculate scores and determine pass/fail status
    for (const quizId in quizResults) {
      const result = quizResults[quizId];
      result.score = result.totalPoints > 0 ? (result.earnedPoints / result.totalPoints) * 100 : 0;
      result.passed = result.score >= result.passingScore;
    }

    // Filter only passed quizzes and sort by submission date (newest first)
    const passedQuizzes = Object.values(quizResults)
      .filter(result => result.passed)
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.json({
      message: 'Passed quiz results retrieved successfully',
      count: passedQuizzes.length,
      results: passedQuizzes
    });
  } catch (error) {
    console.error('Error getting quiz results:', error);
    res.status(500).json({ error: 'Failed to get quiz results' });
  }
};

/**
 * Get all quizzes for a course
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getCourseQuizzes = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user.id;

    // Verify the course exists
    const course = await prisma.course.findUnique({
      where: { id: parseInt(courseId) }
    });

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Get all quizzes for this course (both course-level and video-level)
    const quizzes = await prisma.quiz.findMany({
      where: {
        OR: [
          { courseId: parseInt(courseId) },
          {
            video: {
              courseId: parseInt(courseId)
            }
          }
        ]
      },
      include: {
        video: {
          select: {
            id: true,
            title: true
          }
        },
        _count: {
          select: { questions: true }
        }
      },
      orderBy: [
        { isFinal: 'desc' },
        { createdAt: 'asc' }
      ]
    });

    // For each quiz, check if the user has taken it
    const quizzesWithStatus = await Promise.all(quizzes.map(async (quiz) => {
      // Check if the user has taken this quiz
      const userAnswers = await prisma.answer.findMany({
        where: {
          userId: userId,
          question: {
            quizId: quiz.id
          }
        },
        include: {
          question: true
        }
      });

      let status = {
        taken: userAnswers.length > 0,
        score: null,
        passed: null
      };

      if (userAnswers.length > 0) {
        // Calculate the score
        const questions = await prisma.question.findMany({
          where: { quizId: quiz.id }
        });
        
        const totalPoints = questions.reduce((sum, q) => sum + q.points, 0);
        const earnedPoints = userAnswers.reduce((sum, a) => a.isCorrect ? sum + a.question.points : sum, 0);
        const score = totalPoints > 0 ? (earnedPoints / totalPoints) * 100 : 0;
        
        status.score = score;
        status.passed = score >= quiz.passingScore;
        status.submittedAt = userAnswers[0].submittedAt;
      }

      return {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        isFinal: quiz.isFinal,
        passingScore: quiz.passingScore,
        videoId: quiz.videoId,
        videoTitle: quiz.video ? quiz.video.title : null,
        questionCount: quiz._count.questions,
        createdAt: quiz.createdAt,
        status
      };
    }));

    res.json(quizzesWithStatus);
  } catch (error) {
    console.error('Error getting course quizzes:', error);
    res.status(500).json({ error: 'Failed to get course quizzes' });
  }
};

/**
 * Get status of a specific quiz for the current user
 * @param {Object} req - Express request object with authenticated user
 * @param {Object} res - Express response object
 */
const getQuizStatus = async (req, res) => {
  try {
    const { quizId } = req.params;
    const userId = req.user.id;

    // Validate quizId
    const parsedQuizId = parseInt(quizId, 10);
    if (isNaN(parsedQuizId)) {
      return res.status(400).json({ error: 'Invalid quiz ID format' });
    }

    // Verify the quiz exists
    const quiz = await prisma.quiz.findUnique({
      where: { id: parsedQuizId },
      select: {
        id: true,
        title: true,
        description: true,
        isFinal: true,
        passingScore: true,
        courseId: true,
        videoId: true
      }
    });

    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    // Get user's answers for this quiz
    const userAnswers = await prisma.answer.findMany({
      where: {
        userId: userId,
        question: {
          quizId: parsedQuizId
        }
      },
      include: {
        question: true
      },
      orderBy: {
        submittedAt: 'desc'
      }
    });

    // If user hasn't taken the quiz
    if (userAnswers.length === 0) {
      return res.json({
        quizId: parsedQuizId,
        title: quiz.title,
        taken: false,
        status: 'NOT_ATTEMPTED',
        message: 'User has not attempted this quiz yet'
      });
    }

    // Calculate the score
    const totalPoints = await prisma.question.aggregate({
      where: { quizId: parsedQuizId },
      _sum: { points: true }
    });
    
    const earnedPoints = userAnswers.reduce((sum, a) => a.isCorrect ? sum + a.question.points : sum, 0);
    const totalPointsValue = totalPoints._sum.points || 0;
    const score = totalPointsValue > 0 ? (earnedPoints / totalPointsValue) * 100 : 0;
    const passed = score >= quiz.passingScore;
    
    // Get the submission time from the first answer (they should all have the same timestamp)
    const submittedAt = userAnswers.length > 0 ? userAnswers[0].submittedAt : null;

    res.json({
      quizId: parsedQuizId,
      title: quiz.title,
      taken: true,
      status: passed ? 'PASSED' : 'FAILED',
      score: score,
      passingScore: quiz.passingScore,
      passed: passed,
      submittedAt: submittedAt,
      correctAnswers: userAnswers.filter(a => a.isCorrect).length,
      totalQuestions: userAnswers.length
    });
  } catch (error) {
    console.error('Error getting quiz status:', error);
    res.status(500).json({ error: 'Failed to get quiz status' });
  }
};

module.exports = {
  createQuiz,
  getQuiz,
  submitQuizAnswers,
  getQuizResults,
  getCourseQuizzes,
  getUserQuizResults,
  getQuizStatus,
  requestLogger
};