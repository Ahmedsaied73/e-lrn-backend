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

#### Upload Video (Admin Only)

```
POST /videos/course/:courseId
```

**Authentication Required:** Yes (Admin only)

**Request Body:** Form data with the following fields:

- `title`: Video title
- `description`: Video description
- `order`: Video order in the course
- `video`: Video file

**Response:**

```json
{
  "message": "Video uploaded successfully",
  "video": {
    "id": 3,
    "title": "Arrays and Objects",
    "description": "Working with complex data structures",
    "duration": 1800,
    "order": 3,
    "courseId": 1,
    "videoUrl": "/uploads/videos/arrays-objects.mp4",
    "thumbnailUrl": "/uploads/thumbnails/video3.jpg",
    "createdAt": "2023-04-12T14:30:00Z"
  }
}
```

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