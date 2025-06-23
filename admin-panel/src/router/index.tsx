import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';

import LoginPage from '../pages/LoginPage';
import DashboardPage from '../pages/DashboardPage';
import YouTubeImportPage from '../pages/YouTubeImportPage';
import CourseListPage from '../pages/CourseListPage';
import CourseDetailPage from '../pages/CourseDetailPage';
import CreateCoursePage from '../pages/CreateCoursePage';
import EditCoursePage from '../pages/EditCoursePage';
import UserListPage from '../pages/UserListPage';
import EditUserPage from '../pages/EditUserPage';
import CreateAssignmentPage from '../pages/CreateAssignmentPage';
import VideoAssignmentsPage from '../pages/VideoAssignmentsPage';
import AssignmentSubmissionsPage from '../pages/AssignmentSubmissionsPage';
import GradeSubmissionPage from '../pages/GradeSubmissionPage';
import CreateQuizPage from '../pages/CreateQuizPage';
import CourseQuizzesPage from '../pages/CourseQuizzesPage';
import QuizDetailPage from '../pages/QuizDetailPage';
import AdminLayout from '../layouts/AdminLayout';
import PlaceholderPage from '../pages/PlaceholderPage';

import useAuthStore from '../store/authStore';
import { setAuthToken } from '../services/api'; // To initialize token from store

// Initialize token from store on app load
// This ensures that if the user was previously logged in and the token is in localStorage,
// it's loaded into zustand store and then set for axios headers when the app starts.
const InitializeAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useEffect(() => {
    const token = useAuthStore.getState().token;
    if (token) {
      setAuthToken(token);
      // Optionally, you could add a call here to verify the token with the backend
      // and fetch user details if they are not persisted or to ensure validity.
      // For now, we assume the persisted token and user data are valid if present.
    }
  }, []);
  return <>{children}</>;
};


const ProtectedRoute: React.FC = () => {
  const { isAuthenticated, isAdmin } = useAuthStore();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (!isAdmin) {
    // If authenticated but not an admin, logout and redirect to login with an error message or a specific "access denied" page.
    // For simplicity, redirecting to login. The login page or authService can handle displaying a message.
    useAuthStore.getState().logout();
    setAuthToken(null);
    return <Navigate to="/login" state={{ from: location, error: "Access Denied: Admin role required." }} replace />;
  }

  return (
    <AdminLayout>
      <Outlet /> {/* Child routes will render here */}
    </AdminLayout>
  );
};

const AppRouter: React.FC = () => {
  return (
    <BrowserRouter>
      <InitializeAuth>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route path="/admin" element={<ProtectedRoute />}>
            {/* Routes inside AdminLayout */}
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="youtube-import" element={<YouTubeImportPage />} />
            <Route path="courses" element={<CourseListPage />} />
            <Route path="courses/create" element={<CreateCoursePage />} />
            <Route path="courses/edit/:courseId" element={<EditCoursePage />} />
            <Route path="courses/:courseId" element={<CourseDetailPage />} />

            <Route path="users" element={<UserListPage />} />
            <Route path="users/edit/:userId" element={<EditUserPage />} />

            {/* Assignment Routes */}
            {/* General link from sidebar might go to a page that lists videos/courses to pick from, or a general assignments list */}
            {/* For now, CreateAssignmentPage is general, but VideoAssignmentsPage is specific to a video */}
            <Route path="assignments/create" element={<CreateAssignmentPage />} />
            <Route path="videos/:videoId/assignments" element={<VideoAssignmentsPage />} />
            <Route path="assignments/:assignmentId/submissions" element={<AssignmentSubmissionsPage />} />
            <Route path="submissions/:submissionId/grade" element={<GradeSubmissionPage />} />
            {/* Placeholder for a general assignments overview page if needed */}
            <Route path="assignments" element={<PlaceholderPage />} />

            {/* Quiz Routes */}
            <Route path="quizzes/create" element={<CreateQuizPage />} />
            <Route path="courses/:courseId/quizzes" element={<CourseQuizzesPage />} />
            {/* It might be better to have /admin/videos/:videoId/quiz for a single lecture quiz */}
            {/* For now, CourseQuizzesPage can list both final and lecture quizzes for a course. */}
            {/* Individual lecture quiz creation can be linked from video management with ?videoId= prefill */}
            <Route path="quizzes/:quizId/details" element={<QuizDetailPage />} />
            {/* Placeholder for a general quizzes overview page if needed */}
            <Route path="quizzes" element={<PlaceholderPage />} />


            {/* Add more admin routes here, e.g., settings */}
            <Route index element={<Navigate to="dashboard" replace />} /> {/* Default admin page */}
          </Route>

          {/* Redirect root path or any other non-matched paths */}
          {/* If logged in and admin, go to dashboard, otherwise to login */}
          <Route
            path="/"
            element={
              useAuthStore.getState().isAuthenticated && useAuthStore.getState().isAdmin
              ? <Navigate to="/admin/dashboard" replace />
              : <Navigate to="/login" replace />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} /> {/* Fallback for any other unmatched route */}
        </Routes>
      </InitializeAuth>
    </BrowserRouter>
  );
};

export default AppRouter;
