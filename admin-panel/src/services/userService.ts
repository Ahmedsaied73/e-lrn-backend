import apiClient from './api';

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'STUDENT' | 'ADMIN' | string; // Allow string for other potential roles, but focus on STUDENT/ADMIN
  phoneNumber?: string;
  grade?: string; // As per registration API
  createdAt?: string;
  updatedAt?: string;
  // password field is not typically returned by GET requests
}

export interface UserUpdatePayload {
  name?: string;
  email?: string;
  role?: 'STUDENT' | 'ADMIN';
  password?: string; // Only if changing
  phoneNumber?: string;
  grade?: string;
}

// Response for GET /users
// Based on API docs, it's an array of User objects
export const getAllUsers = async (): Promise<User[]> => {
  try {
    const response = await apiClient.get<User[]>('/users');
    return response.data;
  } catch (error: any) {
    console.error('Error fetching all users:', error.response?.data || error.message);
    throw new Error(error.response?.data?.message || 'Failed to fetch users.');
  }
};

// Response for GET /users/:userId
// Based on API docs, it's a single User object
export const getUserById = async (userId: string | number): Promise<User> => {
  try {
    const response = await apiClient.get<User>(`/users/${userId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error fetching user ${userId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to fetch user ${userId}.`);
  }
};

// Response for PUT /users/:userId
// Based on API docs: { message, user: User }
interface UpdateUserResponse {
  message: string;
  user: User;
}

export const updateUser = async (userId: string | number, userData: UserUpdatePayload): Promise<UpdateUserResponse> => {
  try {
    const response = await apiClient.put<UpdateUserResponse>(`/users/${userId}`, userData);
    return response.data;
  } catch (error: any) {
    console.error(`Error updating user ${userId}:`, error.response?.data || error.message);
    const apiErrors = error.response?.data?.errors;
    const errorMessage = apiErrors ? apiErrors.join(', ') : (error.response?.data?.message || `Failed to update user ${userId}.`);
    throw new Error(errorMessage);
  }
};

// Response for DELETE /users/:userId
// Based on API docs: { message: "User deleted successfully" }
interface DeleteUserResponse {
  message: string;
}

export const deleteUser = async (userId: string | number): Promise<DeleteUserResponse> => {
  try {
    const response = await apiClient.delete<DeleteUserResponse>(`/users/${userId}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error deleting user ${userId}:`, error.response?.data || error.message);
    throw new Error(error.response?.data?.message || `Failed to delete user ${userId}.`);
  }
};
