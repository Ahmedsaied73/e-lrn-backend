const prisma = require('../config/db');

/**
 * Search across courses and videos
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const searchContent = async (req, res) => {
  try {
    const { 
      query, 
      type, 
      category, 
      grade, 
      minPrice, 
      maxPrice, 
      sortBy = 'relevance',
      limit = 20
    } = req.query;
    
    if (!query && !category && !grade) {
      return res.status(400).json({ error: 'Either search query, category, or grade filter must be provided' });
    }
    
    // Base URL for full URLs in the response
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    // Search results containers
    let courses = [];
    let videos = [];
    
    // Build the where clause for courses
    const courseWhereClause = {
      AND: []
    };
    
    // Add search terms if provided
    if (query) {
      courseWhereClause.AND.push({
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } }
        ]
      });
    }
    
    // Add category filter if provided
    if (category) {
      courseWhereClause.AND.push({
        category: category
      });
    }
    
    // Add grade filter if provided
    if (grade) {
      courseWhereClause.AND.push({
        grade: grade
      });
    }
    
    // Add price range filters if provided
    if (minPrice !== undefined) {
      courseWhereClause.AND.push({
        price: { gte: parseFloat(minPrice) }
      });
    }
    
    if (maxPrice !== undefined) {
      courseWhereClause.AND.push({
        price: { lte: parseFloat(maxPrice) }
      });
    }
    
    // If no filters were added, reset the where clause
    if (courseWhereClause.AND.length === 0) {
      delete courseWhereClause.AND;
    }
    
    // Determine sort order
    let orderBy = {};
    switch (sortBy) {
      case 'price_low':
        orderBy = { price: 'asc' };
        break;
      case 'price_high':
        orderBy = { price: 'desc' };
        break;
      case 'newest':
        orderBy = { createdAt: 'desc' };
        break;
      case 'popularity':
        orderBy = {
          enrollments: {
            _count: 'desc'
          }
        };
        break;
      default:
        // Default relevance sorting (handled by database when using text search)
        orderBy = { createdAt: 'desc' };
    }
    
    // Search courses if type is not specified or type is 'courses'
    if (!type || type === 'courses') {
      courses = await prisma.course.findMany({
        where: courseWhereClause,
        include: {
          teacher: {
            select: {
              id: true,
              name: true,
              email: true
            }
          },
          _count: {
            select: { 
              videos: true,
              enrollments: true
            }
          }
        },
        orderBy,
        take: parseInt(limit)
      });
      
      // Add full URLs for thumbnails
      courses = courses.map(course => ({
        ...course,
        videoCount: course._count.videos,
        enrollmentCount: course._count.enrollments,
        thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
          ? `${baseUrl}/${course.thumbnail}` 
          : course.thumbnail
      }));
      
      // Remove _count field from response
      courses = courses.map(course => {
        const { _count, ...rest } = course;
        return rest;
      });
    }
    
    // Search videos if type is not specified or type is 'videos'
    if (!type || type === 'videos') {
      // For videos, we need to join with courses to apply the same filters
      const videoWhereClause = {
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } }
        ],
        course: {}
      };
      
      // Copy applicable course filters to the video query
      if (category || grade || minPrice !== undefined || maxPrice !== undefined) {
        videoWhereClause.course = { ...courseWhereClause };
      }
      
      videos = await prisma.video.findMany({
        where: query ? videoWhereClause : { course: courseWhereClause },
        include: {
          course: {
            select: {
              id: true,
              title: true,
              thumbnail: true,
              category: true,
              grade: true,
              price: true
            }
          }
        },
        take: parseInt(limit)
      });
      
      // Add full URLs for thumbnails and videos
      videos = videos.map(video => ({
        ...video,
        url: video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url,
        thumbnail: video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail,
        course: {
          ...video.course,
          thumbnail: video.course.thumbnail && !video.course.thumbnail.startsWith('http')
            ? `${baseUrl}/${video.course.thumbnail}`
            : video.course.thumbnail
        }
      }));
    }
    
    // Get categories for filtering
    const categories = await getCategoriesList();
    
    res.json({
      query,
      filters: {
        category,
        grade,
        minPrice,
        maxPrice,
        sortBy
      },
      totalResults: courses.length + videos.length,
      availableCategories: categories,
      availableGrades: Object.values(await prisma.$enum.values.Grade),
      courses,
      videos
    });
  } catch (error) {
    console.error('Error searching content:', error);
    res.status(500).json({ error: 'Failed to search content' });
  }
};

/**
 * Get trending courses based on enrollment and view counts
 */
const getTrendingCourses = async (req, res) => {
  try {
    const { limit = 10, category, grade } = req.query;
    
    // Build filter conditions
    const whereClause = {};
    
    if (category) {
      whereClause.category = category;
    }
    
    if (grade) {
      whereClause.grade = grade;
    }
    
    // Get courses with enrollment counts
    const courses = await prisma.course.findMany({
      where: whereClause,
      take: parseInt(limit),
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        _count: {
          select: { 
            enrollments: true,
            videos: true 
          }
        }
      },
      orderBy: {
        enrollments: {
          _count: 'desc'
        }
      }
    });
    
    // Add full URLs for thumbnails
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formattedCourses = courses.map(course => ({
      id: course.id,
      title: course.title,
      description: course.description,
      price: course.price,
      category: course.category,
      grade: course.grade,
      thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
        ? `${baseUrl}/${course.thumbnail}` 
        : course.thumbnail,
      isYoutube: course.isYoutube,
      teacherId: course.teacherId,
      teacher: course.teacher,
      enrollmentCount: course._count.enrollments,
      videoCount: course._count.videos
    }));
    
    res.json({
      trending: formattedCourses
    });
  } catch (error) {
    console.error('Error fetching trending courses:', error);
    res.status(500).json({ error: 'Failed to fetch trending courses' });
  }
};

/**
 * Get course recommendations for a user based on their enrollments
 */
const getRecommendedCourses = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user's enrolled courses
    const userEnrollments = await prisma.enrollment.findMany({
      where: { userId },
      select: { 
        courseId: true,
        course: {
          select: {
            category: true,
            grade: true
          }
        }
      }
    });
    
    const enrolledCourseIds = userEnrollments.map(enrollment => enrollment.courseId);
    
    // Get categories and grades from enrolled courses for better recommendations
    const userCategories = userEnrollments
      .map(enrollment => enrollment.course.category)
      .filter(Boolean);
    
    const userGrades = userEnrollments
      .map(enrollment => enrollment.course.grade)
      .filter(Boolean);
    
    // Find similar courses (not enrolled) based on categories and grades
    const recommendedCourses = await prisma.course.findMany({
      where: {
        id: { notIn: enrolledCourseIds },
        OR: [
          { category: { in: userCategories } },
          { grade: { in: userGrades } }
        ]
      },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        _count: {
          select: { videos: true }
        }
      },
      take: 10
    });
    
    // Add full URLs for thumbnails
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formattedCourses = recommendedCourses.map(course => ({
      id: course.id,
      title: course.title,
      description: course.description,
      price: course.price,
      category: course.category,
      grade: course.grade,
      thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
        ? `${baseUrl}/${course.thumbnail}` 
        : course.thumbnail,
      isYoutube: course.isYoutube,
      teacherId: course.teacherId,
      teacher: course.teacher,
      videoCount: course._count.videos
    }));
    
    res.json({
      recommendations: formattedCourses
    });
  } catch (error) {
    console.error('Error fetching recommended courses:', error);
    res.status(500).json({ error: 'Failed to fetch recommended courses' });
  }
};

/**
 * Helper function to get a list of all available categories
 */
const getCategoriesList = async () => {
  const courses = await prisma.course.findMany({
    select: {
      category: true
    },
    where: {
      category: {
        not: null
      }
    },
    distinct: ['category']
  });
  
  return courses
    .map(course => course.category)
    .filter(Boolean) // Remove null or undefined
    .sort();
};

module.exports = {
  searchContent,
  getTrendingCourses,
  getRecommendedCourses
};