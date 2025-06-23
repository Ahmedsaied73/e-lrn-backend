import apiClient from './api';

// Interfaces based on API-DOCUMENTATION.md

export interface AssignmentQuestionOption {
  // Assuming options are just strings for now, adjust if structured differently
  text: string;
}

export interface AssignmentQuestionPayload { // For creating questions
  text: string;
  options: string[]; // Array of strings for options text
  correctOption: number; // Index of the correct option (0-based)
  explanation?: string;
  points: number;
}

export interface AssignmentQuestion extends AssignmentQuestionPayload { // For displaying questions
  id: number;
  assignmentId: number;
}

export interface CreateAssignmentPayload {
  title: string;
  description: string;
  videoId: number; // Link to a video
  dueDate?: string; // ISO Date string
  isMCQ?: boolean;
  passingScore?: number; // For MCQ
  questions?: AssignmentQuestionPayload[]; // For MCQ
}

export interface Assignment {
  id: number;
  title: string;
  description: string;
  videoId: number;
  dueDate?: string | null;
  isMCQ: boolean;
  passingScore?: number | null;
  createdAt: string;
  updatedAt: string;
  questions?: AssignmentQuestion[]; // Only if it's an MCQ and details are fetched
  video?: { // Optional: if video details are included by the backend
    id: number;
    title: string;
    courseId: number;
  };
  // hasSubmitted and submission fields are usually context-dependent (per user)
  // For admin view, we might get these via submission endpoints.
}

export interface SubmissionFile {
    fileName: string;
    url: string;
    size?: number; // Optional
}

export interface UserSubmission { // As part of AssignmentSubmission list
    id: number;
    name: string;
    email: string;
}

export interface AssignmentSubmission {
    id: number; // Submission ID
    assignmentId: number;
    userId: number;
    user?: UserSubmission; // User details
    content?: string; // For text submissions
    fileUrl?: string; // For file submissions - API docs show this
    files?: SubmissionFile[]; // If backend supports multiple files and provides structured data
    status: 'PENDING' | 'SUBMITTED' | 'GRADED' | 'REJECTED'; // Extend as needed
    submittedAt: string;
    gradedAt?: string | null;
    grade?: number | null;
    feedback?: string | null;
    mcqScore?: number | null; // If MCQ
    // For MCQ submissions, answers might be included if fetching a specific user's attempt detail
}

export interface GradeSubmissionPayload {
  grade: number;
  feedback: string;
  status: 'GRADED' | 'REJECTED'; // Or other relevant statuses
}

// API Functions

// POST /assignments (Admin Only)
export const createAssignment = async (payload: CreateAssignmentPayload): Promise<{ message: string, assignment: Assignment }> => {
  try {
    const response = await apiClient.post<{ message: string, assignment: Assignment }>('/assignments', payload);
    return response.data;
  } catch (error: any) {
    console.error('Error creating assignment:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to create assignment.');
  }
};

// GET /assignments/:id
export const getAssignmentById = async (assignmentId: number | string): Promise<Assignment> => {
  try {
    const response = await apiClient.get<Assignment>(`/assignments/${assignmentId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching assignment ${assignmentId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch assignment ${assignmentId}.`);
  }
};

// GET /assignments/video/:videoId
export const getVideoAssignments = async (videoId: number | string): Promise<{ assignments: Assignment[] }> => {
  try {
    // The API doc response shows: { assignments: [...] }
    const response = await apiClient.get<{ assignments: Assignment[] }>(`/assignments/video/${videoId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching assignments for video ${videoId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch assignments for video ${videoId}.`);
  }
};

// GET /assignments/:assignmentId/submissions (Admin Only)
export const getAssignmentSubmissions = async (assignmentId: number | string): Promise<{ assignmentId: number, title: string, submissionsCount: number, submissions: AssignmentSubmission[] }> => {
  try {
    const response = await apiClient.get<{ assignmentId: number, title: string, submissionsCount: number, submissions: AssignmentSubmission[] }>(`/assignments/${assignmentId}/submissions`);
    return response.data;
  } catch (error: any)
 {
    console.error(`Error fetching submissions for assignment ${assignmentId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch submissions for assignment ${assignmentId}.`);
  }
};

// POST /assignments/submissions/:submissionId/grade (Admin Only)
export const gradeSubmission = async (submissionId: number | string, payload: GradeSubmissionPayload): Promise<{ message: string, submission: AssignmentSubmission }> => {
  try {
    const response = await apiClient.post<{ message: string, submission: AssignmentSubmission }>(`/assignments/submissions/${submissionId}/grade`, payload);
    return response.data;
  } catch (error: any) {
    console.error(`Error grading submission ${submissionId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to grade submission ${submissionId}.`);
  }
};

// Note: Update and Delete for assignments are not in API docs.
// If needed, these would be:
// export const updateAssignment = async (assignmentId, payload) => { ... }
// export const deleteAssignment = async (assignmentId) => { ... }
