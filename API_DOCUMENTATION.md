# E-Learning Platform — Comprehensive API Documentation

Welcome to the official API Documentation for the **E-Learning Platform Backend**. This guide is designed according to OpenAPI/REST standards to help the Frontend engineering team easily integrate and update UI interactions.

---

## 🔑 Global Configuration & Standards

### 1. Base URL & Port
- **Default Development Base URL**: `http://localhost:3005` (configurable via `process.env.PORT`).

### 2. Authentication Strategy
Authentication relies on **JSON Web Tokens (JWT)**.
- **Header Method**: `Authorization: Bearer <your_jwt_token>`
- **Cookie Method**: `token=<your_jwt_token>` (parsed automatically via `cookie-parser`)

### 3. Global Error Response Format
All errors returned by the API follow a predictable structure:
```json
{
  "success": false,
  "error": "Detailed error message string"
}
```

### 4. HTTP Status Code Conventions
| Status Code | Meaning | Context |
| :--- | :--- | :--- |
| **`200 OK`** | Success | Request succeeded with data returned. |
| **`201 Created`** | Created | Resource successfully created. |
| **`400 Bad Request`** | Client Error | Missing required body parameters or invalid input format. |
| **`401 Unauthorized`** | Auth Error | Missing or expired JWT token. |
| **`403 Forbidden`** | Access Denied | Insufficient permissions (e.g., student calling admin route) or prerequisite not met. |
| **`404 Not Found`** | Resource Missing | Item ID does not exist in database. |
| **`429 Too Many Requests`** | Rate Limited | IP exceeded rate limit threshold. |
| **`500 Internal Server Error`** | Server Error | Internal server error (error stack is suppressed in production). |

### 5. Rate Limiting Limits
- **Global API Limit**: Maximum **100 requests per 15 minutes** per IP.
- **Auth Limit**: Maximum **10 login attempts per 15 minutes** per IP on `/auth/login`.

---

## 📡 Endpoints Specification

---

### 1. Authentication Routes (`/auth`)

#### `POST /auth/register`
- **Auth**: Public
- **Request Body** (`application/json`):
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `name` | `string` | Yes | Full name |
  | `email` | `string` | Yes | Unique email address |
  | `password` | `string` | Yes | Plaintext password |
  | `phoneNumber` | `string` | No | Contact phone number |
  | `grade` | `enum` | Yes | Options: `FIRST_SECONDARY`, `SECOND_SECONDARY`, `THIRD_SECONDARY` |

- **Response (`201 Created`)**:
  ```json
  {
    "message": "User registered successfully",
    "token": "eyJhbGciOiJIUzI1Ni..."
  }
  ```

#### `POST /auth/login`
- **Auth**: Public (Rate-limited: 10 req / 15 min)
- **Request Body** (`application/json`):
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `email` | `string` | Yes | User email |
  | `password` | `string` | Yes | User password |

- **Response (`200 OK`)**:
  ```json
  {
    "message": "Login successful",
    "token": "eyJhbGciOiJIUzI1Ni..."
  }
  ```

#### `POST /auth/logout`
- **Auth**: Authenticated
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Logged out successfully"
  }
  ```

---

### 2. User Routes (`/user`)

#### `GET /user/me`
- **Auth**: Authenticated (Student / Admin)
- **Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "data": {
      "id": 1,
      "name": "John Doe",
      "email": "john@example.com",
      "phoneNumber": "01000000000",
      "grade": "FIRST_SECONDARY",
      "role": "STUDENT",
      "createdAt": "2026-08-03T10:00:00.000Z"
    }
  }
  ```
  *(Note: Password hash is strictly excluded from payload).*

#### `GET /user`
- **Auth**: Admin Only
- **Query Parameters**:
  - `page` (`integer`, optional, default: `1`)
  - `limit` (`integer`, optional, default: `20`)
- **Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "data": [ /* Array of User Objects */ ],
    "meta": {
      "total": 45,
      "page": 1,
      "limit": 20,
      "totalPages": 3
    }
  }
  ```

---

### 3. Courses Routes (`/courses`)

#### `GET /courses`
- **Auth**: Public / Authenticated
- **Query Parameters**:
  - `page` (`integer`, optional, default: `1`)
  - `limit` (`integer`, optional, default: `20`)
- **Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "data": [
      {
        "id": 1,
        "title": "Secondary Physics 101",
        "description": "Comprehensive Physics Course",
        "price": 150.0,
        "thumbnail": "https://example.com/thumb.jpg",
        "grade": "FIRST_SECONDARY"
      }
    ],
    "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
  }
  ```

#### `POST /courses`
- **Auth**: Admin Only
- **Request Body** (`application/json`):
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `title` | `string` | Yes | Course title |
  | `description` | `string` | Yes | Course description |
  | `price` | `number` | Yes | Course price |
  | `thumbnail` | `string` | Yes | Direct image URL string |
  | `grade` | `enum` | Yes | `FIRST_SECONDARY`, `SECOND_SECONDARY`, `THIRD_SECONDARY` |

---

### 4. Videos Routes (`/videos`)

#### `GET /videos/course/:courseId`
- **Auth**: Authenticated (Enrolled Student / Admin)
- **Query Parameters**: `?page=1&limit=20`

#### `POST /videos/course/:courseId`
- **Auth**: Admin Only
- **Request Body** (`application/json`):
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `title` | `string` | Yes | Video title |
  | `url` | `string` | Yes | Direct video URL string |
  | `thumbnail` | `string` | Yes | Direct thumbnail URL string |
  | `duration` | `integer` | Yes | Duration in seconds |
  | `description` | `string` | No | Lecture details |

---

### 5. Enrollment Routes (`/enroll`)

#### `POST /enroll/`
- **Auth**: Authenticated
- **Request Body** (`application/json`):
  ```json
  {
    "courseId": 1
  }
  ```
- **Response (`200 OK`)**:
  ```json
  {
    "message": "Enrollment request submitted successfully",
    "enrollment": {
      "id": 10,
      "userId": 1,
      "courseId": 1,
      "isPaid": false
    }
  }
  ```

#### `POST /enroll/status`
- **Auth**: Authenticated
- **Request Body** (`application/json`):
  ```json
  {
    "courseId": 1
  }
  ```

---

### 6. Video Progress Routes (`/progress`)

#### `POST /progress/mark`
- **Auth**: Authenticated
- **Request Body**:
  ```json
  {
    "videoId": 5,
    "completed": true
  }
  ```

#### `GET /progress/course/:courseId`
- **Auth**: Authenticated
- **Response (`200 OK`)**: Returns completed video status and progress percentage.

---

### 7. Quiz & Assignment Submissions (`/quizzes` & `/assignments`)

#### `POST /quizzes/submit`
- **Auth**: Authenticated
- **Request Body**:
  ```json
  {
    "quizId": 1,
    "answers": [
      { "questionId": 10, "selectedOption": 1 },
      { "questionId": 11, "selectedOption": 3 }
    ]
  }
  ```

#### `POST /assignments/submit`
- **Auth**: Authenticated
- **Request Body** (MCQ):
  ```json
  {
    "assignmentId": 1,
    "answers": [{ "questionId": 5, "selectedOption": 0 }]
  }
  ```
- **Request Body** (Open Answer):
  ```json
  {
    "assignmentId": 2,
    "content": "My written solution",
    "fileUrl": "https://example.com/submission.pdf"
  }
  ```

---

## 🛠 Frontend Checklist Summary

1. **JSON Payload Conversion**: Remove form-data/multer uploads. Send `thumbnail` and `url` as JSON string URLs.
2. **Handle Pagination Structure**: Standardize data table fetching to parse `{ data, meta }`.
3. **Handle Rate Limiting**: Intercept `429 Too Many Requests` status codes and prompt the user to wait.
4. **Header Interceptor**: Attach `Authorization: Bearer <token>` to all HTTP requests via your HTTP client (Axios/Fetch).
