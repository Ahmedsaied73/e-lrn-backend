const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Create upload directories if they don't exist
const createDirectories = () => {
  const directories = [
    './uploads',
    './uploads/courses',
    './uploads/videos'
  ];

  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

// Initialize directories
createDirectories();

// Configure storage for course thumbnails
const courseStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './uploads/courses');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    cb(null, 'course-' + uniqueSuffix + extension);
  }
});

// Configure storage for video files and thumbnails
const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, './uploads/videos');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    const prefix = file.fieldname === 'thumbnail' ? 'thumb-' : 'video-';
    cb(null, prefix + uniqueSuffix + extension);
  }
});

// File filter to validate image files
const imageFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const isValidType = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const isValidMimeType = allowedTypes.test(file.mimetype.split('/')[1]);

  if (isValidType && isValidMimeType) {
    return cb(null, true);
  }
  
  cb(new Error('Only image files are allowed!'));
};

// File filter to validate video files
const videoFilter = (req, file, cb) => {
  if (file.fieldname === 'thumbnail') {
    // For thumbnails, use image filter
    return imageFilter(req, file, cb);
  }

  const allowedTypes = /mp4|avi|mov|mkv|webm/;
  const isValidType = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  
  if (isValidType) {
    return cb(null, true);
  }
  
  cb(new Error('Only video files are allowed!'));
};

// Multer upload for course thumbnails
const uploadCourseThumbnail = multer({
  storage: courseStorage,
  fileFilter: imageFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
}).single('thumbnail');

// Multer upload for video files and thumbnails
const uploadVideo = multer({
  storage: videoStorage,
  fileFilter: videoFilter,
  limits: {
    fileSize: 1000 * 1024 * 1024 // 1GB limit for video files
  }
}).fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]);

// Middleware to handle course thumbnail uploads
const handleCourseThumbnailUpload = (req, res, next) => {
  uploadCourseThumbnail(req, res, function(err) {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      return res.status(400).json({ error: `Multer upload error: ${err.message}` });
    } else if (err) {
      // An unknown error occurred
      return res.status(500).json({ error: `Unknown upload error: ${err.message}` });
    }
    // Everything went fine
    next();
  });
};

// Middleware to handle video uploads
const handleVideoUpload = (req, res, next) => {
  uploadVideo(req, res, function(err) {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      return res.status(400).json({ error: `Multer upload error: ${err.message}` });
    } else if (err) {
      // An unknown error occurred
      return res.status(500).json({ error: `Unknown upload error: ${err.message}` });
    }
    // Everything went fine
    next();
  });
};

module.exports = {
  handleCourseThumbnailUpload,
  handleVideoUpload
}; 