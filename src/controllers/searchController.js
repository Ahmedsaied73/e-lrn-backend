const prisma = require('../config/db');
const cache = require('../integrations/redis/cache');

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

    // Whitelist the type filter (only 'courses' | 'videos' are valid) and the
    // grade enum — anything else is a client error, not a silent empty result.
    const VALID_GRADES = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
    if (type && type !== 'courses' && type !== 'videos') {
      return res.status(400).json({ error: 'Invalid type filter' });
    }
    if (grade && !VALID_GRADES.includes(grade)) {
      return res.status(400).json({ error: 'Invalid grade value' });
    }

    // Guard against NaN prices ("abc" or "1.5x" parse to NaN) — a Prisma range
    // filter on NaN rejects and would surface as a 500.
    const priceFilters = [];
    if (minPrice !== undefined) {
      const p = Number(minPrice);
      if (!Number.isFinite(p) || p < 0) {
        return res.status(400).json({ error: 'Invalid minPrice value' });
      }
      priceFilters.push({ price: { gte: p } });
    }
    if (maxPrice !== undefined) {
      const p = Number(maxPrice);
      if (!Number.isFinite(p) || p < 0) {
        return res.status(400).json({ error: 'Invalid maxPrice value' });
      }
      priceFilters.push({ price: { lte: p } });
    }

    // Clamp take 1..100 (house pattern): NaN/negative/huge limits either 500
    // in Prisma or become heavy scans.
    const parsedLimit = parseInt(limit);
    const take = Number.isSafeInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 20;
    
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
    if (priceFilters.length > 0) {
      courseWhereClause.AND.push(...priceFilters);
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
    
    // Cache-aside 60s (P1). Key = shortHash of the full filter vector so keys
    // stay bounded regardless of input length. RAW rows are cached (host-
    // independent — mirroring getAllCourses); thumbnail absolutization happens
    // after retrieval, per request. Staleness window: a new course/video shows
    // up within ~60s and a price/status edit within the same TTL.
    const { courses: rawCourses, videos: rawVideos } = await cache.withCache(
      cache.buildKey('search', 'content', cache.shortHash(
        JSON.stringify({ query, type, category, grade, minPrice, maxPrice, sortBy, take })
      )),
      60,
      async () => {
        let foundCourses = [];
        let foundVideos = [];

        // Search courses if type is not specified or type is 'courses'
        if (!type || type === 'courses') {
          foundCourses = await prisma.course.findMany({
            where: courseWhereClause,
            include: {
              teacher: {
                select: {
                  id: true,
                  slug: true,
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
            take: take
          });
        }

        // Search videos if type is not specified or type is 'videos'
        if (!type || type === 'videos') {
          // BunnyVideo is the only video system — only READY videos are searchable.
          const hasCourseFilters = category || grade || minPrice !== undefined || maxPrice !== undefined;

          foundVideos = await prisma.bunnyVideo.findMany({
            where: {
              AND: [
                { status: 'READY' },
                // BunnyVideo has no `description` — titles only.
                query
                  ? {
                      OR: [
                        { title: { contains: query, mode: 'insensitive' } }
                      ]
                    }
                  : {},
                hasCourseFilters ? { course: { is: courseWhereClause } } : {}
              ]
            },
            include: {
              course: {
                select: {
                  slug: true,
                  title: true,
                  thumbnail: true,
                  category: true,
                  grade: true,
                  price: true
                }
              }
            },
            take: take
          });
        }

        return { courses: foundCourses, videos: foundVideos };
      }
    );

    // ── Per-request shaping (host-dependent — never cached) ───────────────────

    // Add full URLs for thumbnails + flatten _count, then strip _count out
    courses = rawCourses.map(course => {
      const { id: _id, teacherId: _tid, _count, ...rest } = course;
      return {
        ...rest,
        videoCount: _count.videos,
        enrollmentCount: _count.enrollments,
        thumbnail: course.thumbnail && !course.thumbnail.startsWith('http')
          ? `${baseUrl}/${course.thumbnail}`
          : course.thumbnail
      };
    });

    // Add full URLs for thumbnails. No `url` is exposed here — playable links
    // are only issued per-request via the signed playback endpoint.
    videos = rawVideos.map(video => {
      const { id: _id, courseId: _cid, ...rest } = video;
      return {
        ...rest,
        thumbnail: video.thumbnailUrl && !video.thumbnailUrl.startsWith('http') ? `${baseUrl}/${video.thumbnailUrl}` : video.thumbnailUrl,
        course: {
          ...video.course,
          thumbnail: video.course.thumbnail && !video.course.thumbnail.startsWith('http')
            ? `${baseUrl}/${video.course.thumbnail}`
            : video.course.thumbnail
        }
      };
    });
    
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
      availableGrades: ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'],
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

    // Clamp take 1..100 (house pattern); key and query share the value.
    const parsedLimit = parseInt(limit);
    const take = Number.isSafeInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 10;

    // Build filter conditions
    const whereClause = {};

    if (category) {
      whereClause.category = category;
    }

    if (grade) {
      whereClause.grade = grade;
    }

    // Cache-aside, 10min TTL. Enrollment counts move constantly — TTL (not
    // invalidation) is the consistency mechanism; approximate trending is fine.
    // Raw rows cached (host-independent); thumbnail absolutization per request.
    const cacheKey = cache.buildKey(
      'search', 'trending',
      `l${take}`,
      `c${category ? cache.shortHash(category) : 'any'}`,
      `g${grade ? cache.shortHash(grade) : 'any'}`
    );
    const courses = await cache.withCache(cacheKey, 600, () => prisma.course.findMany({
      where: whereClause,
      take: take,
      include: {
        teacher: {
          select: {
            id: true,
            slug: true,
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
    }));
    
    // Add full URLs for thumbnails
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const formattedCourses = courses.map(course => ({
      slug: course.slug,
      title: course.title,
      description: course.description,
      price: course.price,
      category: course.category,
      grade: course.grade,
      thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
        ? `${baseUrl}/${course.thumbnail}` 
        : course.thumbnail,
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
            slug: true,
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
      slug: course.slug,
      title: course.title,
      description: course.description,
      price: course.price,
      category: course.category,
      grade: course.grade,
      thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
        ? `${baseUrl}/${course.thumbnail}` 
        : course.thumbnail,
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
 * Helper function to get a list of all available categories.
 * Cached 10min — categories only change on course create/update/delete,
 * which invalidate the `v1:search:cats` key.
 */
const getCategoriesList = async () => {
  const cacheKey = cache.buildKey('search', 'cats');
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
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

  const list = courses
    .map(course => course.category)
    .filter(Boolean) // Remove null or undefined
    .sort();
  await cache.set(cacheKey, list, 600);
  return list;
};

module.exports = {
  searchContent,
  getTrendingCourses,
  getRecommendedCourses
};