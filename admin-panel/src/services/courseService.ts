import apiClient from './api';

interface YouTubeImportPayload {
  playlistId: string;
  price?: number; // Optional, defaults to 0 on backend if not provided
  grade: 'FIRST_SECONDARY' | 'SECOND_SECONDARY' | 'THIRD_SECONDARY';
}

// Define a basic structure for the course object returned by the API
// This should match the structure in your API-DOCUMENTATION.md
interface Video {
  id: number;
  title: string;
  youtubeId?: string;
  position: number;
  // Add other video properties as needed
}

interface Course {
  id: number;
  title: string;
  description?: string;
  price: number;
  thumbnail?: string;
  isYoutube: boolean;
  youtubePlaylistId?: string;
  grade: string;
  videos: Video[];
  teacher?: {
    id: number;
    name: string;
  };
  // Add other course properties as needed
}

interface ImportYouTubePlaylistResponse {
  message: string;
  course: Course;
}

export const importYouTubePlaylist = async (payload: YouTubeImportPayload): Promise<ImportYouTubePlaylistResponse> => {
  try {
    const response = await apiClient.post<ImportYouTubePlaylistResponse>('/youtube/import', payload);
    return response.data;
  } catch (error: any) {
    console.error('Error importing YouTube playlist:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || error.response?.data?.message || 'Failed to import YouTube playlist.');
  }
};

// Add other course-related service functions here later (CRUD for regular courses, etc.)

export const getAllCourses = async (): Promise<Course[]> => {
  try {
    const response = await apiClient.get<Course[]>('/courses');
    // It's good practice to ensure the response is actually an array.
    // The backend is expected to send an array based on API-DOCUMENTATION.md
    return Array.isArray(response.data) ? response.data : [];
  } catch (error: any) {
    console.error('Error fetching courses:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to fetch courses.');
  }
};

// Placeholder for fetching a single course, to be used by CourseDetailPage
export const getCourseById = async (id: string | number): Promise<Course> => {
  try {
    const response = await apiClient.get<Course>(`/courses/${id}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching course with ID ${id}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch course ${id}.`);
  }
};

export const createCourse = async (formData: FormData): Promise<Course> => {
  try {
    const response = await apiClient.post<ImportYouTubePlaylistResponse>('/courses', formData, { // Re-using ImportYouTubePlaylistResponse for now if structure is similar
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data.course; // Assuming the response for create is similar to import { message, course }
  } catch (error: any) {
    console.error('Error creating course:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to create course.');
  }
};

export const updateCourse = async (id: string | number, formData: FormData): Promise<Course> => {
  try {
    // The API doc says PUT /courses/:id returns { message, course }
    const response = await apiClient.put<{message: string, course: Course}>(`/courses/${id}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data.course;
  } catch (error: any) {
    console.error(`Error updating course ${id}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to update course ${id}.`);
  }
};

export const deleteCourse = async (id: string | number): Promise<{ message: string }> => {
  try {
    const response = await apiClient.delete<{ message: string }>(`/courses/${id}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error deleting course ${id}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to delete course ${id}.`);
  }
};

export const syncYouTubeCourse = async (id: string | number, grade?: 'FIRST_SECONDARY' | 'SECOND_SECONDARY' | 'THIRD_SECONDARY'): Promise<{ message: string, course: Course, stats?: { added: number, updated: number } }> => {
  try {
    const payload: any = {};
    if (grade) {
      payload.grade = grade;
    }
    // The API doc response: { message, course: { id, title, description, videos: [...] } }
    // The youtubeController also returns stats: { added, updated }
    const response = await apiClient.post<{ message: string, course: Course, stats?: { added: number, updated: number } }>(`/youtube/sync/${id}`, payload);
    return response.data;
  } catch (error: any) {
    console.error(`Error syncing YouTube course ${id}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.error || error.response?.data?.message || `Failed to sync YouTube course ${id}.`);
  }
};

// Interface for the video object based on API docs for video creation/update
export interface VideoPayload { // Renaming from Video in Course to avoid conflict, or ensure they are compatible
  id: number;
  title: string;
  description?: string;
  order: number;
  courseId: number;
  videoUrl?: string; // From backend after upload
  thumbnailUrl?: string; // From backend if generated
  duration?: number; // From backend if extracted
  isYoutube?: boolean;
  youtubeId?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface VideoResponse {
  message: string;
  video: VideoPayload;
}

export const addVideoToCourse = async (courseId: string | number, formData: FormData): Promise<VideoResponse> => {
  try {
    const response = await apiClient.post<VideoResponse>(`/videos/course/${courseId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  } catch (error: any) {
    console.error(`Error adding video to course ${courseId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to add video to course ${courseId}.`);
  }
};

export const updateVideoDetails = async (videoId: string | number, formData: FormData): Promise<VideoResponse> => {
  try {
    const response = await apiClient.put<VideoResponse>(`/videos/${videoId}`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  } catch (error: any) {
    console.error(`Error updating video ${videoId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to update video ${videoId}.`);
  }
};

export const removeVideo = async (videoId: string | number): Promise<{ message: string }> => {
  try {
    const response = await apiClient.delete<{ message: string }>(`/videos/${videoId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error deleting video ${videoId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to delete video ${videoId}.`);
  }
};
// etc.
