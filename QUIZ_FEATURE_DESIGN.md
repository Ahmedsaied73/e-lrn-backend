# QUIZ FEATURE DESIGN & FRONTEND INTEGRATION GUIDE

## 1. Overview & Architecture
The Quiz/Exam system has been completely rebuilt using **SurveyJS JSON** as the question definition standard.
The legacy implementation (models, controllers, routes, hardcoded gate queries) has been completely removed with zero dangling references.

### Architecture Highlights:
- **Server-Authoritative Timing**: Timers are enforced on the backend (`deadlineAt` calculated at start + 10s network grace period).
- **Strict Answer Key Isolation**: Student-facing SurveyJS schema is completely stripped of secret correct answers, model answers, and point allocations.
- **Auto-Grading & Manual Grading**: MCQs are auto-graded upon submission; essay questions are queued for manual grading against stored model answers with instructor feedback.
- **Multi-Attempt & Highest-Score Progression**: Students may retake quizzes; the highest score across completed attempts is used to unlock subsequent video gates.
- **Unified Access Gate**: `quizService.evaluateGate()` provides single-source-of-truth access control across streaming and navigation.

---

## 2. API Contract Summary

Base Route: `/quizzes` (All routes require Cookie-based JWT authentication)

### Student Endpoints
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/quizzes/videos/:videoId/meta` | Drives "بدء الاختبار" UI: unlock status, attempt count, best score, in-progress attempt. |
| `POST` | `/quizzes/videos/:videoId/start` | Starts new attempt or resumes active `IN_PROGRESS` attempt. Returns sanitized `surveyJson` & `deadlineAt`. |
| `POST` | `/quizzes/attempts/:id/submit` | Submits answers `{ answers: { [qName]: val }, autoSubmitted?: bool }`. |
| `GET` | `/quizzes/attempts/:id/result` | Detailed score breakdown, per-question correctness, model answers, and essay feedback. |
| `GET` | `/quizzes/videos/:videoId/attempts` | Full history of student attempts for this quiz. |

### Admin Endpoints (`authorizeAdmin()`)
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/quizzes/videos/:videoId` | Upserts quiz definition (`title`, `timeLimitSec`, `passingScore`, `surveyJson`, `answerKey`). |
| `DELETE` | `/quizzes/:quizId` | Deletes quiz and associated attempts. |
| `GET` | `/quizzes/:quizId/attempts` | Lists attempts / grading queue (supports `?status=GRADING`). |
| `PUT` | `/quizzes/attempts/:id/grade` | Grades essay responses (`{ essayScores: { [qName]: points }, essayFeedback?: { [qName]: string } }`). |
| `POST` | `/quizzes/attempts/:id/reset` | Deletes an attempt for manual reset. |
| `POST` | `/quizzes/videos/:videoId/exemptions` | Grants gate exemption to bypass quiz requirement for a student. |
| `DELETE` | `/quizzes/exemptions/:exemptionId` | Revokes a gate exemption. |

---

## 3. Frontend Integration Contract

### A. Student Taking Quiz (with SurveyJS React UI)

```tsx
import { Model } from 'survey-core';
import { Survey } from 'survey-react-ui';
import 'survey-core/defaultV2.min.css';

// 1. Fetch metadata on video finish
const metaRes = await axios.get(`/quizzes/videos/${videoId}/meta`, { withCredentials: true });
if (metaRes.data.data.unlocked) {
  // Enable "بدء الاختبار" button
}

// 2. Launch Quiz
const startRes = await axios.post(`/quizzes/videos/${videoId}/start`, {}, { withCredentials: true });
const { attemptId, deadlineAt, quiz } = startRes.data.data;

// 3. Initialize SurveyJS Model
const survey = new Model(quiz.surveyJson);

// Optional: Set client-side countdown timer if timeLimitSec exists
if (quiz.timeLimitSec) {
  survey.maxTimeToFinish = quiz.timeLimitSec;
}

// 4. Handle Submission
survey.onComplete.add(async (sender, options) => {
  options.showSaveInProgress();
  try {
    const submitRes = await axios.post(
      `/quizzes/attempts/${attemptId}/submit`,
      { answers: sender.data, autoSubmitted: sender.isAutoSubmitted },
      { withCredentials: true }
    );
    options.showSaveSuccess();
    // Redirect or display results
  } catch (err) {
    options.showSaveError();
  }
});
```

### B. Admin Authoring Quiz (with SurveyJS Creator)

When using `survey-creator-react`, the creator produces `creator.JSON`.
The admin UI splits this into:
1. `surveyJson`: The clean SurveyJS layout JSON.
2. `answerKey`: The point values, correct values for MCQs, and model answers for essays.

```json
{
  "title": "Lesson 1 Quiz",
  "timeLimitSec": 600,
  "passingScore": 50,
  "surveyJson": {
    "pages": [
      {
        "name": "page1",
        "elements": [
          {
            "type": "radiogroup",
            "name": "q1",
            "title": "What is 2 + 2?",
            "choices": ["3", "4", "5"]
          },
          {
            "type": "comment",
            "name": "q2",
            "title": "Explain photosynthesis."
          }
        ]
      }
    ]
  },
  "answerKey": {
    "q1": {
      "type": "radiogroup",
      "correctValue": "4",
      "points": 5
    },
    "q2": {
      "type": "comment",
      "modelAnswer": "Photosynthesis is the process by which green plants use sunlight to synthesize nutrients from CO2 and water.",
      "points": 10
    }
  }
}
```
