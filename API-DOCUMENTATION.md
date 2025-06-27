# E-Learning Platform API Documentation

This document provides comprehensive information about the API endpoints available in the E-Learning Platform.

## Table of Contents

- [Authentication](#authentication)
- [Users](#users)
- [Courses](#courses)
- [Videos](#videos)
- [Enrollments](#enrollments)
- [Payments](#payments)
- [YouTube Integration](#youtube-integration)
- [Video Streaming](#video-streaming)
- [Search](#search)
- [Video Progress](#video-progress)
- [Assignments](#assignments)

## Base URL

All endpoints are relative to the base URL: `http://localhost:3005`

## Authentication

Most endpoints require authentication using a JWT token. The token can be provided in two ways:

1. As a cookie named `token`
2. In the Authorization header using the Bearer scheme: `Authorization: Bearer <token>`

### Endpoints

#### Login

```
POST /auth/login
```

**Request Body:**

```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**

```json
{
  "message": "Login successful",
  "token": "jwt_token_here",
  "user": {
    "id": 1,
    "name": "User Name",
    "email": "user@example.com",
    "role": "STUDENT"
  }
}
```

#### Register

```
POST /auth/register
```

**Request Body:**

```json
{
  "name": "New User",
  "email": "newuser@example.com",
  "password": "password123",
  "phoneNumber": "1234567890",
  "grade": "A"
}
```

**Response:**

```json
{
  "message": "Registration successful",
  "user": {
    "id": 2,
    "name": "New User",
    "email": "newuser@example.com",
    "role": "STUDENT"
  }
}
```

#### Logout

```
POST /auth/logout
```

**Response:**

```json
{
  "message": "Logged out successfully"
}
```

#### Refresh Token

```
POST /auth/refresh-token
```

**Response:**

```json
{
  "token": "new_jwt_token_here"
}
```

## Users

### Endpoints

#### Get Current User

```
GET /users/me
```

**Authentication Required:** Yes

**Response:**

```json
{
  "id": 1,
  "name": "User Name",
  "email": "user@example.com",
  "role": "STUDENT"
}
```

#### Update User

```
PUT /users/:userId
```

**Authentication Required:** Yes (User can only update their own data unless they are an admin)

**Request Body:**

```json
{
  "name": "Updated Name",
  "email": "updated@example.com",
  "password": "newpassword123"
}
```

**Response:**

```json
{
  "message": "User data updated successfully",
  "user": {
    "id": 1,
    "name": "Updated Name",
    "email": "updated@example.com",
    "role": "STUDENT"
  }
}
```

#### Get User by ID (Admin Only)

```
GET /users/:userId
```

**Authentication Required:** Yes (Admin only)

**Response:**

```json
{
  "id": 1,
  "name": "User Name",
  "email": "user@example.com",
  "role": "STUDENT"
}
```

#### Get All Users (Admin Only)

```
GET /users
```

**Authentication Required:** Yes (Admin only)

**Response:**

```json
[
  {
    "id": 1,
    "name": "User Name",
    "email": "user@example.com",
    "role": "STUDENT"
  },
  {
    "id": 2,
    "name": "Admin User",
    "email": "admin@example.com",
    "role": "ADMIN"
  }
]
```

#### Delete User (Admin Only)

```
DELETE /users/:userId
```

**Authentication Required:** Yes (Admin only)

**Response:**

```json
{
  "message": "User deleted successfully"
}
```

## Courses

### Endpoints

#### Get All Courses

```
GET /courses
```

**Authentication Required:** Yes

**Response:**

```json
[
  {
    "id": 1,
    "title": "Introduction to JavaScript",
    "description": "Learn the basics of JavaScript programming",
    "price": 49.99,
    "thumbnailUrl": "/uploads/thumbnails/js-intro.jpg",
    "createdAt": "2023-01-15T12:00:00Z"
  },
  {
    "id": 2,
    "title": "Advanced React",
    "description": "Master React and Redux",
    "price": 79.99,
    "thumbnailUrl": "/uploads/thumbnails/react-advanced.jpg",
    "createdAt": "2023-02-20T14:30:00Z"
  }
]
```

#### Get Enrolled Courses

```
GET /courses/enrolled
```

**Authentication Required:** Yes

**Response:**

```json
[
  {
    "id": 1,
    "title": "Introduction to JavaScript",
    "description": "Learn the basics of JavaScript programming",
    "thumbnailUrl": "/uploads/thumbnails/js-intro.jpg",
    "progress": 45,
    "enrolledAt": "2023-03-10T09:15:00Z"
  }
]
```

#### Get Course by ID

```
GET /courses/:id
```

**Authentication Required:** Yes

**Response:**

```json
{
  "id": 1,
  "title": "Introduction to JavaScript",
  "description": "Learn the basics of JavaScript programming",
  "price": 49.99,
  "thumbnailUrl": "/uploads/thumbnails/js-intro.jpg",
  "createdAt": "2023-01-15T12:00:00Z",
  "videos": [
    {
      "id": 1,
      "title": "Variables and Data Types",
      "description": "Understanding JavaScript variables",
      "duration": 1200,
      "order": 1
    },
    {
      "id": 2,
      "title": "Functions and Scope",
      "description": "Working with functions",
      "duration": 1500,
      "order": 2
    }
  ]
}
```

#### Create Course (Admin Only)

```
POST /courses
```

**Authentication Required:** Yes (Admin only)

**Request Body:** Form data with the following fields:

- `title`: Course title
- `description`: Course description
- `price`: Course price
- `thumbnail`: Course thumbnail image file

**Response:**

```json
{
  "message": "Course created successfully",
  "course": {
    "id": 3,
    "title": "Node.js Fundamentals",
    "description": "Server-side JavaScript with Node.js",
    "price": 59.99,
    "thumbnailUrl": "/uploads/thumbnails/nodejs-fundamentals.jpg",
    "createdAt": "2023-04-05T10:20:00Z"
  }
}
```

#### Update Course (Admin Only)

```
PUT /courses/:id
```

**Authentication Required:** Yes (Admin only)

**Request Body:** Form data with the following fields (all optional):

- `title`: Updated course title
- `description`: Updated course description
- `price`: Updated course price
- `thumbnail`: Updated course thumbnail image file

**Response:**

```json
{
  "message": "Course updated successfully",
  "course": {
    "id": 1,
    "title": "JavaScript Fundamentals",
    "description": "Updated description for JS course",
    "price": 54.99,
    "thumbnailUrl": "/uploads/thumbnails/js-fundamentals.jpg",
    "updatedAt": "2023-04-10T11:25:00Z"
  }
}
```

#### Delete Course (Admin Only)

```
DELETE /courses/:id
```

**Authentication Required:** Yes (Admin only)

**Response:**

```json
{
  "message": "Course deleted successfully"
}
```

## Videos

### Endpoints

#### Get Videos by Course

```
GET /videos/course/:courseId
```

**Authentication Required:** Yes

**Response:**

```json
[
  {
    "id": 1,
    "title": "Variables and Data Types",
    "description": "Understanding JavaScript variables",
    "duration": 1200,
    "order": 1,
    "thumbnailUrl": "/uploads/thumbnails/video1.jpg"
  },
  {
    "id": 2,
    "title": "Functions and Scope",
    "description": "Working with functions",
    "duration": 1500,
    "order": 2,
    "thumbnailUrl": "/uploads/thumbnails/video2.jpg"
  }
]
```

#### Get Video by ID

```
GET /videos/:id
```

**Authentication Required:** Yes

**Response:**

```json
{
  "id": 1,
  "title": "Variables and Data Types",
  "description": "Understanding JavaScript variables",
  "duration": 1200,
  "order": 1,
  "courseId": 1,
  "thumbnailUrl": "/uploads/thumbnails/video1.jpg",
  "createdAt": "2023-01-16T10:00:00Z"
}
```

#### Upload Video to Course (Admin Only)

```
POST /videos/course/:courseId
```

**Authentication Required:** Yes (Admin only)

**Request Body:**

- You can either upload a video file or register a video from a custom/absolute path.
- Use `multipart/form-data` for file uploads or `application/json` for custom path only (no thumbnail).

**Form Data Fields:**
- `title` (string, required): Video title
- `description` (string, optional): Video description
- `order` (integer, required): Video order in the course
- `duration` (number, optional): Duration in seconds
- `video` (file, required if not using `customPath`): The video file to upload
- `customPath` (string, required if not uploading a file): Absolute path to the video file on the server (e.g., `D:/media/lesson2.mp4`)
- `thumbnail` (file, optional): Thumbnail image for the video

**At least one of `video` or `customPath` is required.**

**Example: Upload a Video File**

```sh
curl -X POST http://localhost:3005/videos/course/1 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -F "title=Lecture 1" \
  -F "order=1" \
  -F "duration=600" \
  -F "video=@/path/to/video.mp4" \
  -F "thumbnail=@/path/to/thumb.jpg"
```

**Example: Register a Video from a Custom/Absolute Path**

```sh
curl -X POST http://localhost:3005/videos/course/1 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -F "title=Lecture 2" \
  -F "order=2" \
  -F "duration=900" \
  -F "customPath=D:/media/videos/lecture2.mp4" \
  -F "thumbnail=@/path/to/thumb.jpg"
```

Or, if you only want to send JSON (no thumbnail):

```sh
curl -X POST http://localhost:3005/videos/course/1 \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Lecture 2",
    "order": 2,
    "duration": 900,
    "customPath": "D:/media/videos/lecture2.mp4"
  }'
```

**Response:**

```json
{
  "message": "Video uploaded successfully",
  "video": {
    "id": 3,
    "title": "Lecture 2",
    "description": "...",
    "order": 2,
    "duration": 900,
    "courseId": 1,
    "videoUrl": "D:/media/videos/lecture2.mp4", // or a relative uploads path
    "thumbnailUrl": "/uploads/videos/thumb-...jpg",
    "createdAt": "2025-06-25T12:00:00Z"
  }
}
```

**Error Responses:**
- `400`: Missing required fields, invalid custom path, or no file provided
- `404`: Course not found
- `500`: Internal server error

**Notes:**
- If both `video` and `customPath` are provided, the uploaded file takes precedence.
- The backend checks if the file at `customPath` exists and is accessible.
- The `videoUrl` in the response will be the path used (either the uploaded file’s URL or the custom path).
- Only admins can upload/register videos.
- If you use `customPath`, the file must already exist on the server and be accessible to the backend.
- You can optionally upload a thumbnail image; otherwise, a default will be used.

**Security Requirements:**
- User must be authenticated
- User must have admin role
- Never expose sensitive server paths to the client
- Only allow trusted admins to use the `customPath` feature

#### Update Video (Admin Only)

```
PUT /videos/:id
```

**Authentication Required:** Yes (Admin only)

**Request Body:** Form data with the following fields (all optional):

- `title`: Updated video title
- `description`: Updated video description
- `order`: Updated video order
- `video`: Updated video file

**Response:**

```json
{
  "message": "Video updated successfully",
  "video": {
    "id": 1,
    "title": "JavaScript Variables and Data Types",
    "description": "Updated description for variables video",
    "duration": 1200,
    "order": 1,
    "courseId": 1,
    "videoUrl": "/uploads/videos/js-variables.mp4",
    "thumbnailUrl": "/uploads/thumbnails/video1.jpg",
    "updatedAt": "2023-04-15T09:45:00Z"
  }
}
```

#### Delete Video (Admin Only)

```
DELETE /videos/:id
```

**Authentication Required:** Yes (Admin only)

**Response:**

```json
{
  "message": "Video deleted successfully"
}
```

## Enrollments

### Endpoints

#### Enroll in Course

```
POST /api/enroll
```

**Authentication Required:** Yes

**Request Body:**

```json
{
  "courseId": 1
}
```

**Response:**

```json
{
  "message": "Enrolled successfully",
  "enrollment": {
    "id": 1,
    "userId": 1,
    "courseId": 1,
    "enrolledAt": "2023-04-20T11:30:00Z",
    "progress": 0
  }
}
```

#### Check Enrollment Status

```
POST /api/enrollment-status
```

**Authentication Required:** Yes

**Request Body:**

```json
{
  "courseId": 1
}
```

**Response:**

```json
{
  "enrolled": true,
  "enrollment": {
    "id": 1,
    "userId": 1,
    "courseId": 1,
    "enrolledAt": "2023-04-20T11:30:00Z",
    "progress": 45
  }
}
```

## Payments

### Endpoints

#### Process Course Payment

```
POST /payment/course/:courseId
```

**Authentication Required:** Yes

**Request Body:**

```json
{
  "paymentMethod": "credit_card",
  "cardDetails": {
    "number": "4111111111111111",
    "expMonth": 12,
    "expYear": 2025,
    "cvc": "123"
  }
}
```

**Response:**

```json
{
  "message": "Payment processed successfully",
  "payment": {
    "id": 1,
    "userId": 1,
    "courseId": 1,
    "amount": 49.99,
    "status": "completed",
    "paymentDate": "2023-04-20T11:25:00Z"
  },
  "enrollment": {
    "id": 1,
    "userId": 1,
    "courseId": 1,
    "enrolledAt": "2023-04-20T11:30:00Z"
  }
}
```

#### Get Payment History

```
GET /payment/history
```

**Authentication Required:** Yes

**Response:**

```json
[
  {
    "id": 1,
    "courseId": 1,
    "courseTitle": "Introduction to JavaScript",
    "amount": 49.99,
    "status": "completed",
    "paymentDate": "2023-04-20T11:25:00Z"
  },
  {
    "id": 2,
    "courseId": 2,
    "courseTitle": "Advanced React",
    "amount": 79.99,
    "status": "completed",
    "paymentDate": "2023-05-15T14:10:00Z"
  }
]
```

## YouTube Integration

### Endpoints

#### Import YouTube Playlist (Admin Only)

```
POST /youtube/import
```

**Authentication Required:** Yes (Admin only)

**Request Body:**

```json
{
  "playlistId": "PLillGF-RfqbbnEGy3ROiLWk7JMCuSyQtX",
  "title": "MERN Stack Course",
  "description": "Learn the MERN Stack - MongoDB, Express, React, Node",
  "price": 69.99
}
```

**Response:**

```json
{
  "message": "YouTube playlist imported successfully",
  "course": {
    "id": 4,
    "title": "MERN Stack Course",
    "description": "Learn the MERN Stack - MongoDB, Express, React, Node",
    "price": 69.99,
    "thumbnailUrl": "https://i.ytimg.com/vi/7CqJlxBYj-M/maxresdefault.jpg",
    "createdAt": "2023-05-20T09:00:00Z",
    "videos": [
      {
        "id": 10,
        "title": "Welcome To The MERN Stack Course",
        "description": "In this video we will talk about what we will be learning in this course",
        "youtubeId": "7CqJlxBYj-M",
        "order": 1
      },
      // More videos...
    ]
  }
}
```

#### Sync YouTube Course (Admin Only)

```
POST /youtube/sync/:id
```

**Authentication Required:** Yes (Admin only)

**Response:**

```json
{
  "message": "Course synced with YouTube playlist successfully",
  "course": {
    "id": 4,
    "title": "MERN Stack Course",
    "description": "Learn the MERN Stack - MongoDB, Express, React, Node",
    "videos": [
      // Updated video list
    ]
  }
}
```

## Video Streaming

### Endpoints

#### Get Video Stream URL

```
GET /stream/video/:videoId/url
```

**Authentication Required:** Yes (User must be enrolled in the course)

**Response:**

```json
{
  "streamUrl": "/uploads/videos/js-variables.mp4",
  "type": "mp4"
}
```

#### Get Video Embed Code

```
GET /stream/video/:videoId/embed
```

**Authentication Required:** Yes (User must be enrolled in the course)

**Response:**

```json
{
  "embedCode": "<iframe src=\"/player/video/1\" width=\"100%\" height=\"400\" frameborder=\"0\" allowfullscreen></iframe>"
}
```

#### Get Course Player

```
GET /stream/course/:courseId/player
```

**Authentication Required:** Yes (User must be enrolled in the course)

**Response:**

```json
{
  "courseId": 1,
  "title": "Introduction to JavaScript",
  "videos": [
    {
      "id": 1,
      "title": "Variables and Data Types",
      "duration": 1200,
      "order": 1,
      "watched": true
    },
    {
      "id": 2,
      "title": "Functions and Scope",
      "duration": 1500,
      "order": 2,
      "watched": false
    }
  ],
  "currentVideo": {
    "id": 1,
    "title": "Variables and Data Types",
    "description": "Understanding JavaScript variables",
    "streamUrl": "/uploads/videos/js-variables.mp4",
    "duration": 1200
  }
}
```

## Search

### Endpoints

#### Search Content

```
GET /search/content?query=javascript&type=course
```

**Authentication Required:** Yes

**Query Parameters:**

- `query`: Search term
- `type` (optional): Filter by content type ("course" or "video")
- `category` (optional): Filter by category
- `price_min` (optional): Minimum price
- `price_max` (optional): Maximum price

**Response:**

```json
{
  "courses": [
    {
      "id": 1,
      "title": "Introduction to JavaScript",
      "description": "Learn the basics of JavaScript programming",
      "price": 49.99,
      "thumbnailUrl": "/uploads/thumbnails/js-intro.jpg"
    }
  ],
  "videos": [
    {
      "id": 1,
      "title": "Variables and Data Types",
      "description": "Understanding JavaScript variables",
      "courseId": 1,
      "courseTitle": "Introduction to JavaScript"
    }
  ]
}
```

#### Get Trending Courses

```
GET /search/trending
```

**Authentication Required:** Yes

**Response:**

```json
[
  {
    "id": 2,
    "title": "Advanced React",
    "description": "Master React and Redux",
    "price": 79.99,
    "thumbnailUrl": "/uploads/thumbnails/react-advanced.jpg",
    "enrollmentCount": 120
  },
  {
    "id": 1,
    "title": "Introduction to JavaScript",
    "description": "Learn the basics of JavaScript programming",
    "price": 49.99,
    "thumbnailUrl": "/uploads/thumbnails/js-intro.jpg",
    "enrollmentCount": 95
  }
]
```

#### Get Recommended Courses

```
GET /search/recommended
```

**Authentication Required:** Yes

**Response:**

```json
[
  {
    "id": 3,
    "title": "Node.js Fundamentals",
    "description": "Server-side JavaScript with Node.js",
    "price": 59.99,
    "thumbnailUrl": "/uploads/thumbnails/nodejs-fundamentals.jpg",
    "relevanceScore": 0.85
  },
  {
    "id": 4,
    "title": "MERN Stack Course",
    "description": "Learn the MERN Stack - MongoDB, Express, React, Node",
    "price": 69.99,
    "thumbnailUrl": "https://i.ytimg.com/vi/7CqJlxBYj-M/maxresdefault.jpg",
    "relevanceScore": 0.78
  }
]
```

## Video Progress

### Endpoints

#### Mark Video as Completed

```
POST /progress/complete
```

**Authentication Required:** Yes

**Purpose:** Record when a user finishes watching a video

**Request Body:**

```json
{
  "videoId": 1
}
```

**Response:**

```json
{
  "message": "Video marked as completed",
  "videoProgress": {
    "id": 1,
    "userId": 1,
    "videoId": 1,
    "completed": true,
    "watchedAt": "2023-05-15T14:30:00Z",
    "updatedAt": "2023-05-15T14:30:00Z"
  }
}
```

**Security Requirements:**

**Security Requirements:**
- User must be authenticated

## Assignments

### Endpoints

#### Create Assignment (Admin Only)

```
POST /assignments
```

**Authentication Required:** Yes (Admin only)

**Purpose:** Create a new assignment for a specific video

**Request Body for Regular Assignment:**

```json
{
  "title": "JavaScript DOM Manipulation",
  "description": "Create a web page that demonstrates DOM manipulation techniques",
  "videoId": 1,
  "dueDate": "2023-07-15T23:59:59Z"
}
```

**Request Body for MCQ Assignment:**

```json
{
  "title": "JavaScript Fundamentals Quiz",
  "description": "Test your knowledge of JavaScript fundamentals",
  "videoId": 1,
  "dueDate": "2023-07-15T23:59:59Z",
  "isMCQ": true,
  "passingScore": 70.0,
  "questions": [
    {
      "text": "Which of the following is a primitive data type in JavaScript?",
      "options": ["Array", "Object", "String", "Function"],
      "correctOption": 2,
      "explanation": "String is a primitive data type in JavaScript",
      "points": 1
    },
    {
      "text": "What does the '====' operator do in JavaScript?",
      "options": ["Assigns a value", "Compares values and types", "Compares only values", "Logical AND"],
      "correctOption": 1,
      "explanation": "The strict equality operator (===) checks both value and type",
      "points": 2
    }
  ]
}
```

**Response for Regular Assignment:**

```json
{
  "message": "Assignment created successfully",
  "assignment": {
    "id": 1,
    "title": "JavaScript DOM Manipulation",
    "description": "Create a web page that demonstrates DOM manipulation techniques",
    "videoId": 1,
    "dueDate": "2023-07-15T23:59:59Z",
    "isMCQ": false,
    "createdAt": "2023-06-01T10:00:00Z",
    "updatedAt": "2023-06-01T10:00:00Z"
  }
}
```

**Response for MCQ Assignment:**

```json
{
  "message": "MCQ assignment created successfully",
  "assignment": {
    "id": 2,
    "title": "JavaScript Fundamentals Quiz",
    "description": "Test your knowledge of JavaScript fundamentals",
    "videoId": 1,
    "dueDate": "2023-07-15T23:59:59Z",
    "isMCQ": true,
    "passingScore": 70.0,
    "createdAt": "2023-06-01T10:00:00Z",
    "updatedAt": "2023-06-01T10:00:00Z",
    "questions": [
      {
        "id": 1,
        "assignmentId": 2,
        "text": "Which of the following is a primitive data type in JavaScript?",
        "options": ["Array", "Object", "String", "Function"],
        "correctOption": 2,
        "explanation": "String is a primitive data type in JavaScript",
        "points": 1
      },
      {
        "id": 2,
        "assignmentId": 2,
        "text": "What does the '====' operator do in JavaScript?",
        "options": ["Assigns a value", "Compares values and types", "Compares only values", "Logical AND"],
        "correctOption": 1,
        "explanation": "The strict equality operator (===) checks both value and type",
        "points": 2
      }
    ]
  }
}
```

**Security Requirements:**
- User must be authenticated
- User must have admin role

#### Get Assignment

```
GET /assignments/:id
```

**Authentication Required:** Yes

**Purpose:** Get assignment details

**Response for Regular Assignment:**

```json
{
  "id": 1,
  "title": "JavaScript DOM Manipulation",
  "description": "Create a web page that demonstrates DOM manipulation techniques",
  "videoId": 1,
  "dueDate": "2023-07-15T23:59:59Z",
  "isMCQ": false,
  "createdAt": "2023-06-01T10:00:00Z",
  "updatedAt": "2023-06-01T10:00:00Z",
  "video": {
    "id": 1,
    "title": "Variables and Data Types",
    "courseId": 1
  },
  "hasSubmitted": true,
  "submission": {
    "id": 3,
    "status": "PENDING",
    "submittedAt": "2023-06-10T14:30:00Z",
    "grade": null,
    "feedback": null
  }
}
```

**Response for MCQ Assignment:**

```json
{
  "id": 2,
  "title": "JavaScript Fundamentals Quiz",
  "description": "Test your knowledge of JavaScript fundamentals",
  "videoId": 1,
  "dueDate": "2023-07-15T23:59:59Z",
  "isMCQ": true,
  "passingScore": 70.0,
  "createdAt": "2023-06-01T10:00:00Z",
  "updatedAt": "2023-06-01T10:00:00Z",
  "video": {
    "id": 1,
    "title": "Variables and Data Types",
    "courseId": 1
  },
  "AssignmentQuestion": [
    {
      "id": 1,
      "text": "Which of the following is a primitive data type in JavaScript?",
      "options": ["Array", "Object", "String", "Function"],
      "correctOption": 2,
      "explanation": "String is a primitive data type in JavaScript",
      "points": 1,
      "userAnswer": {
        "selectedOption": 2,
        "isCorrect": true
      }
    },
    {
      "id": 2,
      "text": "What does the '====' operator do in JavaScript?",
      "options": ["Assigns a value", "Compares values and types", "Compares only values", "Logical AND"],
      "correctOption": 1,
      "explanation": "The strict equality operator (===) checks both value and type",
      "points": 2,
      "userAnswer": null
    }
  ],
  "hasSubmitted": true,
  "submission": {
    "id": 4,
    "status": "GRADED",
    "submittedAt": "2023-06-10T14:30:00Z",
    "grade": 85.5,
    "mcqScore": 85.5,
    "gradedAt": "2023-06-10T14:30:00Z"
  }
}
```

**Security Requirements:**
- User must be authenticated
- User must be enrolled in the course or be an admin

#### Get Video Assignments

```
GET /assignments/video/:videoId
```

**Authentication Required:** Yes

**Purpose:** Get all assignments for a specific video

**Response:**

```json
{
  "assignments": [
    {
      "id": 1,
      "title": "JavaScript DOM Manipulation",
      "description": "Create a web page that demonstrates DOM manipulation techniques",
      "videoId": 1,
      "dueDate": "2023-07-15T23:59:59Z",
      "isMCQ": false,
      "createdAt": "2023-06-01T10:00:00Z",
      "hasSubmitted": true,
      "submission": {
        "id": 3,
        "status": "PENDING",
        "submittedAt": "2023-06-10T14:30:00Z",
        "grade": null
      }
    },
    {
      "id": 2,
      "title": "JavaScript Fundamentals Quiz",
      "description": "Test your knowledge of JavaScript fundamentals",
      "videoId": 1,
      "dueDate": "2023-07-15T23:59:59Z",
      "isMCQ": true,
      "passingScore": 70.0,
      "createdAt": "2023-06-01T10:00:00Z",
      "hasSubmitted": false,
      "submission": null
    }
  ]
}
```

**Security Requirements:**
- User must be authenticated
- User must be enrolled in the course or be an admin

#### Submit Assignment

```
POST /assignments/submit
```

**Authentication Required:** Yes

**Purpose:** Submit completed assignment (works for both regular and MCQ assignments)

**Request Body for Regular Assignment:**

```json
{
  "assignmentId": 1,
  "content": "Here is my solution to the DOM manipulation assignment...",
  "fileUrl": "/uploads/assignments/user1/assignment1/dom-manipulation.zip"
}
```

**Request Body for MCQ Assignment:**

```json
{
  "assignmentId": 2,
  "answers": [
    {
      "questionId": 1,
      "selectedOption": 2
    },
    {
      "questionId": 2,
      "selectedOption": 1
    }
  ]
}
```

**Response for Regular Assignment:**

```json
{
  "message": "Assignment submitted successfully",
  "submission": {
    "id": 3,
    "userId": 1,
    "assignmentId": 1,
    "content": "Here is my solution to the DOM manipulation assignment...",
    "fileUrl": "/uploads/assignments/user1/assignment1/dom-manipulation.zip",
    "status": "PENDING",
    "submittedAt": "2023-06-10T14:30:00Z"
  }
}
```

**Response for MCQ Assignment:**

```json
{
  "message": "MCQ assignment passed",
  "submission": {
    "id": 4,
    "userId": 1,
    "assignmentId": 2,
    "mcqScore": 85.5,
    "status": "GRADED",
    "grade": 85.5,
    "submittedAt": "2023-06-10T14:30:00Z",
    "gradedAt": "2023-06-10T14:30:00Z"
  },
  "mcqScore": 85.5,
  "passed": true,
  "passingScore": 70.0
}
```

**Security Requirements:**
- User must be authenticated
- User must be enrolled in the course
- Assignment must not be past due date (unless late submissions are allowed)

#### Grade Assignment (Admin Only)

```
POST /assignments/submissions/:submissionId/grade
```

**Authentication Required:** Yes (Admin only)

**Purpose:** Grade a student's assignment submission (for non-MCQ assignments)

**Request Body:**

```json
{
  "grade": 92,
  "feedback": "Excellent work! Your DOM manipulation techniques were well implemented and clearly documented. For future assignments, consider adding error handling to your JavaScript functions.",
  "status": "GRADED"
}
```

**Response:**

```json
{
  "message": "Submission graded successfully",
  "submission": {
    "id": 3,
    "assignmentId": 1,
    "userId": 1,
    "status": "GRADED",
    "submittedAt": "2023-06-10T14:30:00Z",
    "gradedAt": "2023-06-12T09:45:00Z",
    "grade": 92,
    "feedback": "Excellent work! Your DOM manipulation techniques were well implemented and clearly documented. For future assignments, consider adding error handling to your JavaScript functions."
  }
}
```

**Security Requirements:**
- User must be authenticated
- User must have admin role

#### Get Assignment Submissions (Admin Only)

```
GET /assignments/:assignmentId/submissions
```

**Authentication Required:** Yes (Admin only)

**Purpose:** Get all submissions for a specific assignment

**Response:**

```json
{
  "assignmentId": 1,
  "title": "JavaScript DOM Manipulation",
  "submissionsCount": 2,
  "submissions": [
    {
      "id": 3,
      "assignmentId": 1,
      "userId": 1,
      "status": "GRADED",
      "submittedAt": "2023-06-10T14:30:00Z",
      "gradedAt": "2023-06-12T09:45:00Z",
      "grade": 92,
      "feedback": "Excellent work!",
      "user": {
        "id": 1,
        "name": "John Doe",
        "email": "john@example.com"
      }
    },
    {
      "id": 4,
      "assignmentId": 1,
      "userId": 2,
      "status": "PENDING",
      "submittedAt": "2023-06-11T10:15:00Z",
      "gradedAt": null,
      "grade": null,
      "feedback": null,
      "user": {
        "id": 2,
        "name": "Jane Smith",
        "email": "jane@example.com"
      }
    }
  ]
}
```

**Security Requirements:**
- User must be authenticated
- User must have admin role

#### Get User Submissions

```
GET /assignments/user/submissions
```

**Authentication Required:** Yes

**Purpose:** Get all submissions by the current user

**Response:**

```json
{
  "submissionsCount": 2,
  "submissions": [
    {
      "id": 3,
      "assignmentId": 1,
      "userId": 1,
      "status": "GRADED",
      "submittedAt": "2023-06-10T14:30:00Z",
      "gradedAt": "2023-06-12T09:45:00Z",
      "grade": 92,
      "feedback": "Excellent work!",
      "assignment": {
        "id": 1,
        "title": "JavaScript DOM Manipulation",
        "description": "Create a web page that demonstrates DOM manipulation techniques",
        "isMCQ": false,
        "video": {
          "id": 1,
          "title": "Variables and Data Types",
          "courseId": 1
        }
      }
    },
    {
      "id": 4,
      "assignmentId": 2,
      "userId": 1,
      "status": "GRADED",
      "submittedAt": "2023-06-11T10:15:00Z",
      "gradedAt": "2023-06-11T10:15:00Z",
      "grade": 85.5,
      "mcqScore": 85.5,
      "assignment": {
        "id": 2,
        "title": "JavaScript Fundamentals Quiz",
        "description": "Test your knowledge of JavaScript fundamentals",
        "isMCQ": true,
        "video": {
          "id": 1,
          "title": "Variables and Data Types",
          "courseId": 1
        }
      }
    }
  ]
}
```

**Security Requirements:**
- User must be authenticated
- User must have admin role

#### Get User Assignment Submissions

```
GET /assignments/submissions
```

**Authentication Required:** Yes

**Purpose:** Get all assignment submissions for the authenticated user

**Response:**

```json
[
  {
    "id": 3,
    "assignmentId": 1,
    "assignmentTitle": "JavaScript DOM Manipulation",
    "courseId": 1,
    "courseTitle": "Introduction to JavaScript",
    "status": "graded",
    "submittedAt": "2023-06-10T14:30:00Z",
    "gradedAt": "2023-06-12T09:45:00Z",
    "grade": 92,
    "totalPoints": 100,
    "feedback": "Excellent work! Your DOM manipulation techniques were well implemented and clearly documented. For future assignments, consider adding error handling to your JavaScript functions."
  },
  {
    "id": 5,
    "assignmentId": 2,
    "assignmentTitle": "Build a Calculator",
    "courseId": 1,
    "courseTitle": "Introduction to JavaScript",
    "status": "submitted",
    "submittedAt": "2023-06-20T16:15:00Z",
    "gradedAt": null,
    "grade": null,
    "totalPoints": 150,
    "feedback": null
  }
]
```

**Security Requirements:**
- User must be authenticated

## Quizzes

### Endpoints

#### Create Quiz (Admin Only)

```
POST /quizzes
```

**Authentication Required:** Yes (Admin only)

**Purpose:** Create a new quiz for a course or video

**Request Body:**

```json
{
  "title": "JavaScript Basics Quiz",
  "description": "Test your knowledge of JavaScript fundamentals",
  "isFinal": false,
  "videoId": 1,
  "passingScore": 70,
  "questions": [
    {
      "text": "Which of the following is a primitive data type in JavaScript?",
      "options": ["Array", "Object", "String", "Function"],
      "correctOption": 2,
      "explanation": "String is a primitive data type in JavaScript",
      "points": 1
    },
    {
      "text": "What does the '===' operator do in JavaScript?",
      "options": [
        "Assigns a value", 
        "Compares values and types", 
        "Compares only values", 
        "Logical AND"
      ],
      "correctOption": 1,
      "explanation": "The strict equality operator (===) checks both value and type",
      "points": 2
    }
  ]
}
```

#### Get All User Quiz Results

```
GET /quizzes/user/results
```

**Authentication Required:** Yes

**Purpose:** Retrieve all quiz results for the authenticated user

**Response:**

```json
{
  "message": "Quiz results retrieved successfully",
  "count": 2,
  "results": [
    {
      "quizId": 1,
      "title": "JavaScript Basics Quiz",
      "description": "Test your knowledge of JavaScript fundamentals",
      "isFinal": false,
      "passingScore": 70,
      "courseId": 1,
      "courseTitle": "Introduction to JavaScript",
      "videoId": 1,
      "videoTitle": "Variables and Data Types",
      "submittedAt": "2023-06-15T14:30:00Z",
      "correctAnswers": 2,
      "totalQuestions": 2,
      "earnedPoints": 3,
      "totalPoints": 3,
      "score": 100,
      "passed": true,
      "answers": [
        {
          "questionId": 1,
          "questionText": "Which of the following is a primitive data type in JavaScript?",
          "selectedOption": 2,
          "correctOption": 2,
          "isCorrect": true,
          "points": 1,
          "explanation": "String is a primitive data type in JavaScript"
        },
        {
          "questionId": 2,
          "questionText": "What does the '===' operator do in JavaScript?",
          "selectedOption": 1,
          "correctOption": 1,
          "isCorrect": true,
          "points": 2,
          "explanation": "The strict equality operator (===) checks both value and type"
        }
      ]
    },
    {
      "quizId": 2,
      "title": "React Fundamentals Quiz",
      "description": "Test your knowledge of React",
      "isFinal": true,
      "passingScore": 70,
      "courseId": 2,
      "courseTitle": "Advanced React",
      "videoId": null,
      "videoTitle": null,
      "submittedAt": "2023-06-10T11:15:00Z",
      "correctAnswers": 3,
      "totalQuestions": 5,
      "earnedPoints": 6,
      "totalPoints": 10,
      "score": 60,
      "passed": false,
      "answers": [
        // Array of answer objects similar to above
      ]
    }
  ]
}
```

**Response:**

```json
{
  "message": "Quiz created successfully",
  "quiz": {
    "id": 1,
    "title": "JavaScript Basics Quiz",
    "description": "Test your knowledge of JavaScript fundamentals",
    "isFinal": false,
    "passingScore": 70,
    "videoId": 1,
    "courseId": null,
    "createdAt": "2023-05-20T09:00:00Z",
    "updatedAt": "2023-05-20T09:00:00Z",
    "questions": [
      {
        "id": 1,
        "text": "Which of the following is a primitive data type in JavaScript?",
        "options": ["Array", "Object", "String", "Function"],
        "points": 1
      },
      {
        "id": 2,
        "text": "What does the '===' operator do in JavaScript?",
        "options": [
          "Assigns a value", 
          "Compares values and types", 
          "Compares only values", 
          "Logical AND"
        ],
        "points": 2
      }
    ]
  }
}
```

**Security Requirements:**
- User must be authenticated
- User must have admin role

#### Get Quiz

```
GET /quizzes/:id
```

**Authentication Required:** Yes

**Purpose:** Get quiz details and questions (without correct answers)

**Response:**

```json
{
  "id": 1,
  "title": "JavaScript Basics Quiz",
  "description": "Test your knowledge of JavaScript fundamentals",
  "isFinal": false,
  "passingScore": 70,
  "videoId": 1,
  "courseId": null,
  "video": {
    "id": 1,
    "title": "Variables and Data Types",
    "courseId": 1
  },
  "questions": [
    {
      "id": 1,
      "text": "Which of the following is a primitive data type in JavaScript?",
      "options": ["Array", "Object", "String", "Function"],
      "points": 1
    },
    {
      "id": 2,
      "text": "What does the '===' operator do in JavaScript?",
      "options": [
        "Assigns a value", 
        "Compares values and types", 
        "Compares only values", 
        "Logical AND"
      ],
      "points": 2
    }
  ]
}
```

**Security Requirements:**
- User must be authenticated
- For lecture quizzes, user must have completed the associated video
- For final exams, user must have completed all videos in the course

#### Submit Quiz Answers

```
POST /quizzes/submit
```

**Authentication Required:** Yes

**Purpose:** Submit answers for a quiz and get results

**Request Body:**

```json
{
  "quizId": 1,
  "answers": [
    {
      "questionId": 1,
      "selectedOption": 2
    },
    {
      "questionId": 2,
      "selectedOption": 1
    }
  ]
}
```

**Response:**

```json
{
  "message": "Quiz answers submitted successfully",
  "quizId": 1,
  "correctAnswers": 2,
  "totalQuestions": 2,
  "score": 100,
  "passingScore": 70,
  "passed": true,
  "results": [
    {
      "questionId": 1,
      "selectedOption": 2,
      "isCorrect": true
    },
    {
      "questionId": 2,
      "selectedOption": 1,
      "isCorrect": true
    }
  ]
}
```

**Security Requirements:**
- User must be authenticated
- User must be enrolled in the course
- User must not have already taken the quiz

#### Get Quiz Results

```
GET /quizzes/:quizId/results
```

**Authentication Required:** Yes

**Purpose:** Get detailed results for a previously taken quiz

**Response:**

```json
{
  "quizId": 1,
  "title": "JavaScript Basics Quiz",
  "correctAnswers": 2,
  "totalQuestions": 2,
  "score": 100,
  "passingScore": 70,
  "passed": true,
  "submittedAt": "2023-05-20T10:15:00Z",
  "results": [
    {
      "questionId": 1,
      "questionText": "Which of the following is a primitive data type in JavaScript?",
      "selectedOption": 2,
      "correctOption": 2,
      "isCorrect": true,
      "points": 1,
      "explanation": "String is a primitive data type in JavaScript"
    },
    {
      "questionId": 2,
      "questionText": "What does the '===' operator do in JavaScript?",
      "selectedOption": 1,
      "correctOption": 1,
      "isCorrect": true,
      "points": 2,
      "explanation": "The strict equality operator (===) checks both value and type"
    }
  ]
}
```

**Security Requirements:**
- User must be authenticated
- User must have taken the quiz

#### Get Course Quizzes

```
GET /quizzes/course/:courseId
```

**Authentication Required:** Yes

**Purpose:** Get all quizzes for a course with user's completion status

**Response:**

```json
[
  {
    "id": 1,
    "title": "JavaScript Basics Quiz",
    "description": "Test your knowledge of JavaScript fundamentals",
    "isFinal": false,
    "passingScore": 70,
    "videoId": 1,
    "videoTitle": "Variables and Data Types",
    "questionCount": 2,
    "createdAt": "2023-05-20T09:00:00Z",
    "status": {
      "taken": true,
      "score": 100,
      "passed": true,
      "submittedAt": "2023-05-20T10:15:00Z"
    }
  },
  {
    "id": 2,
    "title": "JavaScript Final Exam",
    "description": "Comprehensive test of all JavaScript concepts",
    "isFinal": true,
    "passingScore": 75,
    "videoId": null,
    "videoTitle": null,
    "questionCount": 10,
    "createdAt": "2023-05-21T11:30:00Z",
    "status": {
      "taken": false,
      "score": null,
      "passed": null
    }
  }
]
```

**Security Requirements:**
- User must be authenticated

## Error Responses

All endpoints may return the following error responses:

### 400 Bad Request

```json
{
  "message": "Invalid request parameters",
  "errors": [
    "Email is required",
    "Password must be at least 8 characters"
  ]
}
```

### 401 Unauthorized

```json
{
  "message": "Authentication required"
}
```

### 403 Forbidden

```json
{
  "message": "You do not have permission to access this resource"
}
```

### 404 Not Found

```json
{
  "message": "Resource not found"
}
```

### 500 Internal Server Error

```json
{
  "message": "An unexpected error occurred"
}
```