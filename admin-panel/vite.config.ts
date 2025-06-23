import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc' // Using swc for speed

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3006, // Admin panel runs on a different port than the backend
    proxy: {
      '/auth': {
        target: 'http://localhost:3005', // Backend API URL
        changeOrigin: true,
      },
      '/users': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/courses': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/videos': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/youtube': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/payment': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      // Proxy for paths starting with /api, like /api/enroll and /api/enrollment-status
      '/api': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/assignments': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/quizzes': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/search': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/progress': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/stream': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      }
    }
  }
})
