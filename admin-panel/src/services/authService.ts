import apiClient, { setAuthToken } from './api';
import useAuthStore from '../store/authStore';

interface LoginCredentials {
  email?: string;
  password?: string;
}

interface UserResponse {
  id: number;
  name: string;
  email: string;
  role: string;
  // Add any other fields your user object might have
}

interface LoginResponse {
  message: string;
  token: string;
  user: UserResponse;
}

export const loginUser = async (credentials: LoginCredentials): Promise<UserResponse> => {
  try {
    const response = await apiClient.post<LoginResponse>('/auth/login', credentials);
    const { token, user } = response.data;

    if (token && user) {
      // Store token and user data in Zustand store
      useAuthStore.getState().login(token, user);
      // Set token for future API calls
      setAuthToken(token);

      if (user.role !== 'ADMIN') {
        // Log out if the user is not an admin
        useAuthStore.getState().logout();
        setAuthToken(null);
        throw new Error('Access Denied: User is not an administrator.');
      }
      return user;
    } else {
      throw new Error('Login failed: No token or user data received.');
    }
  } catch (error: any) {
    // Log out on error to be safe
    useAuthStore.getState().logout();
    setAuthToken(null);

    console.error('Login error:', error.response?.data?.message || error.message);
    throw new Error(error.response?.data?.message || 'Login failed. Please try again.');
  }
};

export const logoutUser = () => {
  useAuthStore.getState().logout();
  setAuthToken(null);
  // Optionally, call a backend logout endpoint if it exists
  // apiClient.post('/auth/logout');
};

// Initialize token from store on app load
// This ensures that if the user was previously logged in and the token is in localStorage,
// it's loaded into axios headers when the app starts.
const storedToken = useAuthStore.getState().token;
if (storedToken) {
  setAuthToken(storedToken);
}

// Subscribe to authStore changes to update axios headers dynamically
useAuthStore.subscribe(
  (state) => state.token,
  (token) => {
    setAuthToken(token);
  }
);
