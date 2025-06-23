import React from 'react';
import { Typography, Paper, Box, Button } from '@mui/material';
import useAuthStore from '../store/authStore';
import { logoutUser } from '../services/authService';
import { useNavigate } from 'react-router-dom';

const DashboardPage: React.FC = () => {
  const { user } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logoutUser();
    navigate('/login', { replace: true });
  };

  return (
    <Paper sx={{ padding: 3 }}>
      <Typography variant="h4" gutterBottom>
        Admin Dashboard
      </Typography>
      <Typography variant="h6">
        Welcome, {user?.name || 'Admin'}!
      </Typography>
      <Typography paragraph sx={{ mt: 2 }}>
        This is the main dashboard for the admin panel. From here, you can manage users, courses, and other platform settings.
      </Typography>
      <Box sx={{ mt: 3 }}>
        <Button variant="contained" color="primary" onClick={handleLogout}>
          Logout
        </Button>
      </Box>
    </Paper>
  );
};

export default DashboardPage;
