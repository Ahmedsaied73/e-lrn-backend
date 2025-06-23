import apiClient from './api';

// Interface for a single video, adjust as needed based on actual API response for GET /videos/:id
// This should be compatible with the Video type used in CourseDetailPage and VideoPayload in courseService
export interface Video {
  id: number;
  title: string;
  description?: string;
  order?: number; // or position
  courseId: number;
  videoUrl?: string;
  thumbnailUrl?: string;
  duration?: number;
  isYoutube?: boolean;
  youtubeId?: string;
  createdAt?: string;
  updatedAt?: string;
  // Any other relevant fields
}

// GET /videos/:id
export const getVideoById = async (videoId: string | number): Promise<Video> => {
  try {
    const response = await apiClient.get<Video>(`/videos/${videoId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching video ${videoId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch video ${videoId}.`);
  }
};

// GET /videos/course/:courseId - already in API docs, might be useful elsewhere
export const getVideosByCourse = async (courseId: string | number): Promise<Video[]> => {
    try {
        const response = await apiClient.get<Video[]>(`/videos/course/${courseId}`);
        return response.data;
    } catch (error: any) {
        console.error(`Error fetching videos for course ${courseId}:`, error.response?.data || error.message);
        throw new Error(error.response?.data?.message || `Failed to fetch videos for course ${courseId}.`);
    }
};
