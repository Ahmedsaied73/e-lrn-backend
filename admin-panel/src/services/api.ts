import axios from 'axios';

const apiClient = axios.create({
  // The proxy in vite.config.ts will handle routing these requests
  // to http://localhost:3005 during development.
  // For production, this baseURL might need to be configured differently,
  // e.g., pointing to the actual deployed backend URL.
  baseURL: '/', // Assuming proxy handles the full path
});

// Function to set the auth token for all requests
export const setAuthToken = (token: string | null) => {
  if (token) {
    apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    delete apiClient.defaults.headers.common['Authorization'];
  }
};

apiClient.interceptors.response.use(
  response => response,
  error => {
    // Handle errors globally if needed
    // For example, redirect to login on 401
    if (error.response && error.response.status === 401) {
      // Potentially redirect to login page or trigger a logout action
      console.error('Unauthorized, redirecting to login might be needed.');
      // window.location.href = '/login'; // Example, but better handled by routing logic
    }
    return Promise.reject(error);
  }
);

export default apiClient;
