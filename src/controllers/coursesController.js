const prisma = require('../config/db');
const fs = require('fs');
const path = require('path');

// Get all courses
const getAllCourses = async (req, res) => {
  try {
    const courses = await prisma.course.findMany({
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        videos: {
          select: {
            id: true,
            title: true,
            duration: true
          }
        }
      }
    });

    // Add full URL for thumbnails
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const coursesWithUrls = courses.map(course => ({
      ...course,
      thumbnail: course.thumbnail && !course.thumbnail.startsWith('http') 
        ? `${baseUrl}/${course.thumbnail}` 
        : course.thumbnail
    }));

    res.json(coursesWithUrls);
  } catch (error) {
    console.error('Error fetching courses:', error);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
};

// Get a specific course by ID
const getCourseById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const course = await prisma.course.findUnique({
      where: { id: parseInt(id) },
      include: {
        teacher: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        videos: {
          select: {
            id: true,
            title: true,
            url: true,
            thumbnail: true,
            duration: true
          }
        },
        enrollments: {
          select: {
            id: true,
            userId: true,
            createdAt: true
          }
        }
      }
    });

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Add full URLs for thumbnails and videos
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    // Process course thumbnail
    if (course.thumbnail && !course.thumbnail.startsWith('http')) {
      course.thumbnail = `${baseUrl}/${course.thumbnail}`;
    }
    
    // Process video URLs and thumbnails
    if (course.videos) {
      course.videos = course.videos.map(video => ({
        ...video,
        url: video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url,
        thumbnail: video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail
      }));
    }

    res.json(course);
  } catch (error) {
    console.error('Error fetching course:', error);
    res.status(500).json({ error: 'Failed to fetch course' });
  }
};

// Create a new course (automatically linked to the admin/teacher)
const createCourse = async (req, res) => {
  try {
    const { title, description, price, grade } = req.body;

    // Validate required fields
    if (!title || !description || !price || !grade) {
      return res.status(400).json({ error: 'Title, description, price, and grade are required' });
    }

    // Validate grade is one of the allowed values
    const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
    if (!validGrades.includes(grade)) {
      return res.status(400).json({ 
        error: 'Invalid grade value', 
        validValues: validGrades 
      });
    }

    // Find the admin user
    const admin = await prisma.user.findFirst({
      where: {
        role: 'ADMIN'
      }
    });

    if (!admin) {
      return res.status(500).json({ error: 'Administrator account not found' });
    }

    // Get thumbnail path from file upload if available
    let thumbnailPath = null;
    if (req.file) {
      thumbnailPath = `uploads/courses/${req.file.filename}`;
    }

    // Create the course with the admin as the teacher
    const course = await prisma.course.create({
      data: {
        title,
        description,
        price: parseFloat(price),
        grade,
        thumbnail: thumbnailPath || 'uploads/courses/default-course.jpg', // Default image if none provided
        teacherId: admin.id
      }
    });

    // Add the full URL for the thumbnail
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    course.thumbnail = `${baseUrl}/${course.thumbnail}`;

    res.status(201).json({ message: 'Course created successfully', course });
  } catch (error) {
    console.error('Error creating course:', error);
    res.status(500).json({ error: 'Failed to create course' });
  }
};

// Update an existing course
const updateCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, price, grade } = req.body;

    // Check if course exists
    const existingCourse = await prisma.course.findUnique({
      where: { id: parseInt(id) }
    });

    if (!existingCourse) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Validate grade if provided
    if (grade) {
      const validGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
      if (!validGrades.includes(grade)) {
        return res.status(400).json({ 
          error: 'Invalid grade value', 
          validValues: validGrades 
        });
      }
    }

    // Get update data
    const updateData = {
      title: title || undefined,
      description: description || undefined,
      price: price ? parseFloat(price) : undefined,
      grade: grade || undefined,
    };

    // Handle thumbnail update if a new file was uploaded
    if (req.file) {
      // Delete old thumbnail if it exists and is not the default
      if (existingCourse.thumbnail && 
          !existingCourse.thumbnail.includes('default-course.jpg') &&
          existingCourse.thumbnail.startsWith('uploads/')) {
        const oldThumbPath = path.join(__dirname, '../../', existingCourse.thumbnail);
        if (fs.existsSync(oldThumbPath)) {
          fs.unlinkSync(oldThumbPath);
        }
      }
      
      // Set new thumbnail path
      updateData.thumbnail = `uploads/courses/${req.file.filename}`;
    }

    // Update the course
    const updatedCourse = await prisma.course.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    // Add the full URL for the thumbnail
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    updatedCourse.thumbnail = `${baseUrl}/${updatedCourse.thumbnail}`;

    res.json({ message: 'Course updated successfully', course: updatedCourse });
  } catch (error) {
    console.error('Error updating course:', error);
    res.status(500).json({ error: 'Failed to update course' });
  }
};

// Delete a course
const deleteCourse = async (req, res) => {
  try {
    console.log(req.params);
    const { id } = req.params;
    const courseId = parseInt(id);

    console.log(`Starting deletion process for course ID: ${courseId}`);

    // Check if course exists but with minimal data
    const existingCourse = await prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        title: true,
        isYoutube: true,
        thumbnail: true,
        _count: {
          select: {
            videos: true,
            enrollments: true,
            certificates: true
          }
        }
      }
    });

    if (!existingCourse) {
      return res.status(404).json({ error: 'Course not found' });
    }

    console.log(`Deleting course: ${existingCourse.title} (ID: ${existingCourse.id})`);
    console.log(`Related counts - Videos: ${existingCourse._count.videos}, Enrollments: ${existingCourse._count.enrollments}, Certificates: ${existingCourse._count.certificates}`);
    
    // For YouTube courses, we only need to delete the thumbnail if it's stored locally
    if (!existingCourse.isYoutube) {
      // For local courses, delete the thumbnail if it exists and is stored locally
      if (existingCourse.thumbnail && !existingCourse.thumbnail.startsWith('http')) {
        const thumbPath = path.join(__dirname, '../../', existingCourse.thumbnail);
        try {
          if (fs.existsSync(thumbPath)) {
            fs.unlinkSync(thumbPath);
            console.log(`Deleted course thumbnail: ${existingCourse.thumbnail}`);
          }
        } catch (fileErr) {
          console.error(`Error deleting course thumbnail: ${fileErr.message}`);
          // Continue with deletion even if file operation fails
        }
      }
    }

    // For YouTube courses, we can skip fetching and processing video files
    // since they're hosted on YouTube
    if (!existingCourse.isYoutube && existingCourse._count.videos > 0) {
      // Only for non-YouTube courses, fetch video details to delete files
      const videos = await prisma.video.findMany({
        where: { courseId: courseId },
        select: {
          id: true,
          url: true,
          thumbnail: true,
          isYoutube: true
        }
      });
      
      // For each non-YouTube video, try to delete local files
      for (const video of videos) {
        if (!video.isYoutube) {
          try {
            // Delete video file
            if (video.url && !video.url.startsWith('http')) {
              const videoPath = path.join(__dirname, '../../', video.url);
              if (fs.existsSync(videoPath)) {
                fs.unlinkSync(videoPath);
                console.log(`Deleted video file: ${video.url}`);
              }
            }
            
            // Delete video thumbnail
            if (video.thumbnail && !video.thumbnail.startsWith('http')) {
              const videoThumbPath = path.join(__dirname, '../../', video.thumbnail);
              if (fs.existsSync(videoThumbPath)) {
                fs.unlinkSync(videoThumbPath);
                console.log(`Deleted video thumbnail: ${video.thumbnail}`);
              }
            }
          } catch (fileErr) {
            console.error(`Error deleting video files: ${fileErr.message}`);
            // Continue with deletion even if file operations fail
          }
        }
      }
    } else {
      console.log(`Course ${existingCourse.id} is a YouTube course or has no videos, skipping video file deletion operations`);
    }

    // Use a transaction to ensure atomic operations - delete everything in the proper order
    console.log(`Executing database deletion operations for course ${courseId}`);
    await prisma.$transaction(async (prisma) => {
      // Delete videos first to avoid any FK constraints issues
      if (existingCourse._count.videos > 0) {
        await prisma.video.deleteMany({
          where: { courseId: courseId }
        });
        console.log(`Deleted ${existingCourse._count.videos} videos for course ${courseId}`);
      }
      
      // Delete enrollments
      if (existingCourse._count.enrollments > 0) {
        await prisma.enrollment.deleteMany({
          where: { courseId: courseId }
        });
        console.log(`Deleted ${existingCourse._count.enrollments} enrollments for course ${courseId}`);
      }
      
      // Delete certificates
      if (existingCourse._count.certificates > 0) {
        await prisma.certificate.deleteMany({
          where: { courseId: courseId }
        });
        console.log(`Deleted ${existingCourse._count.certificates} certificates for course ${courseId}`);
      }
      
      // Break course associations with learning paths if any
      await prisma.learningPath.update({
        where: {
          courses: {
            some: {
              id: courseId
            }
          }
        },
        data: {
          courses: {
            disconnect: {
              id: courseId
            }
          }
        }
      });
      
      // Finally delete the course
      await prisma.course.delete({
        where: { id: courseId }
      });
    }, {
      timeout: 20000 // Increase timeout for large operations
    });

    console.log(`Course ${id} deleted successfully`);
    res.json({ message: 'Course deleted successfully' });
  } catch (error) {
    console.error('Error deleting course:', error);
    res.status(500).json({ error: 'Failed to delete course', details: error.message });
  }
};

// Get courses that a user is enrolled in
const getUserEnrolledCourses = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all enrollments for this user and include the associated courses
    const enrollments = await prisma.enrollment.findMany({
      where: {
        userId: userId
      },
      select: {
        id: true,
        createdAt: true,
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            price: true,
            grade: true,
            thumbnail: true,
            teacher: {
              select: {
                id: true,
                name: true,
                email: true
              }
            },
            videos: {
              select: {
                id: true,
                title: true,
                url: true,
                thumbnail: true,
                duration: true
              }
            }
          }
        }
      }
    });

    // Add full URLs for thumbnails and videos
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const enrolledCourses = enrollments.map(enrollment => {
      const course = enrollment.course;
      if (course.thumbnail && !course.thumbnail.startsWith('http')) {
        course.thumbnail = `${baseUrl}/${course.thumbnail}`;
      }
      if (course.videos) {
        course.videos = course.videos.map(video => ({
          ...video,
          url: video.url && !video.url.startsWith('http') ? `${baseUrl}/${video.url}` : video.url,
          thumbnail: video.thumbnail && !video.thumbnail.startsWith('http') ? `${baseUrl}/${video.thumbnail}` : video.thumbnail
        }));
      }
      return {
        id: enrollment.id,
        createdAt: enrollment.createdAt,
        course
      };
    });

    res.json(enrolledCourses);
  } catch (error) {
    console.error('Error fetching enrolled courses:', error);
    res.status(500).json({ error: 'Failed to fetch enrolled courses' });
  }
};

module.exports = {
  getAllCourses,
  getCourseById,
  createCourse,
  updateCourse,
  deleteCourse,
  getUserEnrolledCourses
};
