# E-Learning Platform

A comprehensive e-learning platform with course management, video streaming, user progress tracking, and YouTube integration.

## Features

- **User Authentication**: Secure login, registration, and password reset functionality
- **Role-Based Access Control**: Different permissions for students, teachers, and administrators
- **Course Management**: Create, update, and delete courses with detailed information
- **Video Content**: Upload videos or integrate with YouTube playlists
- **Payment System**: Process payments for course enrollment
- **Progress Tracking**: Monitor student progress through courses and track video completion
- **Quiz System**: Create and manage quizzes for lectures and final exams with automatic grading
- **Assignment System**: Create and grade assignments for each video with file submission support
- **Sequential Learning**: Enforces structured learning path where students must complete prerequisites
  - Requires completion of current video before accessing the next
  - Mandatory quiz completion with passing score before proceeding
  - Required assignment submission and approval before moving to next video
  - 'Next Lecture' feature guides students through the course sequence
- **Search Functionality**: Advanced search with filtering options
- **Responsive Design**: Works on desktop and mobile devices

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- MySQL database
- YouTube API key (for YouTube integration)

### Required Packages

The following packages are required for the project:

```bash
# Core packages
npm install express prisma @prisma/client jsonwebtoken bcrypt

# Middleware and utilities
npm install cors dotenv multer morgan cookie-parser

# Validation
npm install zod
```

### Installation

1. Clone the repository
   ```bash
   git clone https://github.com/yourusername/e-learning-platform.git
   cd e-learning-platform
   ```

2. Install dependencies
   ```bash
   npm install
   ```

3. Set up environment variables
   ```bash
   cp .env.example .env
   ```
   Edit the `.env` file with your database credentials and other configuration options.

4. Run database migrations
   ```bash
   npx prisma migrate dev --name "add_quiz_and_video_progress"
   ```
   
   This will create the necessary database tables for:
   - VideoProgress: Tracks which videos a user has completed
   - Quiz: Stores quiz metadata (title, description, passing score)
   - Question: Stores individual quiz questions with options and correct answers
   - Answer: Records user responses to quiz questions

5. Start the server
   ```bash
   npm start
   ```
   For development:
   ```bash
   npm run dev
   ```

## Admin Access

Administrators have special privileges in the platform:

1. **Auto-enrollment in all courses**: Admins are automatically given access to all course content without requiring explicit enrollment.

2. **Course management**: Only admins can create, edit, and delete courses and videos.

### Default Admin Account

A default administrator account is automatically created when the application starts:

- **Email**: admin@elearning.com
- **Password**: admin123
- **Role**: ADMIN

This admin account is used to create and manage all courses on the platform.

## Enrollment and Payment Management

The platform includes scripts to manually manage enrollment and payment status:

### Mark Enrollment as Paid

To manually mark a user enrollment as paid:

```bash
npm run script:mark-paid -- --userId=<userId> --courseId=<courseId>
```

or:

```bash
npm run script:mark-paid -- --enrollmentId=<enrollmentId>
```

### Auto-Enroll Admins in All Courses

To automatically enroll all admin users in all courses:

```bash
npm run script:enroll-admins
```

Optional flags:
- `--markAsPaid=true|false` (default: true) - Mark all enrollments as paid
- `--force=true|false` (default: false) - Skip confirmation prompt

## YouTube Integration

The platform supports importing YouTube playlists as courses:

1. Ensure you have a valid YouTube API key in your `.env` file
2. Use the admin interface to import a playlist by its ID
3. Set a price for the course (optional)
4. The platform will automatically import all videos from the playlist

## API Documentation

For detailed information about available endpoints, request parameters, and response formats, see [API Documentation](API-DOCUMENTATION.md).

## License

This project is licensed under the MIT License - see the LICENSE file for details.
