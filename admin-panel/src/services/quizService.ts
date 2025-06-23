import apiClient from './api';

// Interfaces based on API-DOCUMENTATION.md for Quizzes

export interface QuizQuestionPayload { // For creating quiz questions
  text: string;
  options: string[]; // Array of strings for option text
  correctOption: number; // Index of the correct option (0-based)
  explanation?: string;
  points: number;
}

export interface QuizQuestion extends QuizQuestionPayload { // For displaying quiz questions
  id: number;
  // quizId might be implicitly linked or part of a nested structure from backend
}

export interface CreateQuizPayload {
  title: string;
  description?: string;
  isFinal: boolean; // True if it's a final exam for a course, false for a lecture quiz
  videoId?: number | null; // Required if isFinal is false
  courseId?: number | null; // Required if isFinal is true (though API doc example shows videoId for lecture quiz, not courseId directly for final)
                           // The API docs for POST /quizzes show 'videoId' or 'courseId' can be null.
                           // "Create a new quiz for a course or video"
                           // Example has: videoId: 1, courseId: null. This implies a lecture quiz.
                           // For a final exam, it should be courseId: X, videoId: null.
  passingScore: number; // Percentage
  questions: QuizQuestionPayload[];
}

export interface Quiz {
  id: number;
  title: string;
  description?: string | null;
  isFinal: boolean;
  passingScore: number;
  videoId?: number | null;
  courseId?: number | null; // Should be present if it's a final exam
  createdAt: string;
  updatedAt: string;
  questions: QuizQuestion[]; // Questions are part of the Quiz object on GET /quizzes/:id and on create response
  video?: { // Optional: if video details are included
    id: number;
    title: string;
    courseId: number;
  };
  course?: { // Optional: if course details are included
      id: number;
      title: string;
  }
}

// API Functions

// POST /quizzes (Admin Only)
export const createQuiz = async (payload: CreateQuizPayload): Promise<{ message: string, quiz: Quiz }> => {
  try {
    const response = await apiClient.post<{ message: string, quiz: Quiz }>('/quizzes', payload);
    return response.data;
  } catch (error: any) {
    console.error('Error creating quiz:', error.response?.data || error.message);
    const apiErrors = error.response?.data?.errors;
    const errorMessage = apiErrors ? apiErrors.join(', ') : (error.response?.data?.message || 'Failed to create quiz.');
    throw new Error(errorMessage);
  }
};

// GET /quizzes/:id
// Fetches quiz details and questions (without correct answers, as per API doc for general user)
// Admin might get correct answers - assuming admin get has full details.
export const getQuizById = async (quizId: number | string): Promise<Quiz> => {
  try {
    const response = await apiClient.get<Quiz>(`/quizzes/${quizId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching quiz ${quizId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch quiz ${quizId}.`);
  }
};

// GET /quizzes/course/:courseId
// Gets all quizzes for a course with user's completion status (for users).
// Admin might use this to see all quizzes associated with a course.
export interface QuizStatus {
    taken: boolean;
    score: number | null;
    passed: boolean | null;
    submittedAt?: string | null;
}
export interface CourseQuizListItem extends Omit<Quiz, 'questions' | 'course'> { // Questions might not be included in list view
    videoTitle?: string | null;
    questionCount: number;
    status?: QuizStatus; // This is user-specific, admin might not see this or see aggregated stats
}
export const getCourseQuizzes = async (courseId: number | string): Promise<CourseQuizListItem[]> => {
  try {
    const response = await apiClient.get<CourseQuizListItem[]>(`/quizzes/course/${courseId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching quizzes for course ${courseId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch quizzes for course ${courseId}.`);
  }
};


// GET /quizzes/:quizId/results (User specific) - Not directly for admin management list, but useful for understanding data.
// An admin equivalent might be needed to see all results for a quiz, e.g., GET /admin/quizzes/:quizId/all-results

// Note: Update and Delete for quizzes are not explicitly in API docs.
// If needed, these would be:
// export const updateQuiz = async (quizId, payload) => { ... }
// export const deleteQuiz = async (quizId) => { ... }
