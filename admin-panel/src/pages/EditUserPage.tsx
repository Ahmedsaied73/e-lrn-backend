import React, { useState, useEffect } from 'react';
import {
  TextField,
  Button,
  Container,
  Typography,
  Box,
  Alert,
  Paper,
  Grid,
  MenuItem,
  CircularProgress,
  FormControlLabel,
  Checkbox
} from '@mui/material';
import { useNavigate, useParams } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { getUserById, updateUser, User, UserUpdatePayload } from '../services/userService';

type UserRole = 'STUDENT' | 'ADMIN'; // Define more roles if app supports

const EditUserPage: React.FC = () => {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('STUDENT');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [grade, setGrade] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); // For form submission
  const [pageLoading, setPageLoading] = useState(true); // For initial data fetch

  useEffect(() => {
    if (!userId) {
      setError("User ID is missing.");
      setPageLoading(false);
      return;
    }
    const fetchUser = async () => {
      setPageLoading(true);
      try {
        const fetchedUser = await getUserById(userId);
        setUser(fetchedUser);
        setName(fetchedUser.name);
        setEmail(fetchedUser.email);
        setRole(fetchedUser.role as UserRole); // Assuming role from API matches UserRole
        setPhoneNumber(fetchedUser.phoneNumber || '');
        setGrade(fetchedUser.grade || '');
        setPassword(''); // Keep password fields blank by default
        setConfirmPassword('');
      } catch (err: any) {
        setError(err.message || 'Failed to fetch user details.');
      } finally {
        setPageLoading(false);
      }
    };
    fetchUser();
  }, [userId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId) {
      setError("User ID is missing for update.");
      return;
    }
    setError(null);
    setSuccessMessage(null);

    if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
    }

    setLoading(true);
    const payload: UserUpdatePayload = {
      name: name.trim(),
      email: email.trim(),
      role,
      phoneNumber: phoneNumber.trim() || undefined, // Send undefined if empty to potentially clear
      grade: grade.trim() || undefined,       // Send undefined if empty
    };

    if (password) { // Only include password if it's being changed
      payload.password = password;
    }

    try {
      const response = await updateUser(userId, payload);
      setSuccessMessage(response.message || `User "${response.user.name}" updated successfully!`);
      setUser(response.user); // Update local state with new data
      setPassword(''); // Clear password fields after successful update
      setConfirmPassword('');
      // Optionally navigate or give more feedback
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred during user update.');
    } finally {
      setLoading(false);
    }
  };

  if (pageLoading) {
    return <Container sx={{display: 'flex', justifyContent: 'center', mt: 5}}><CircularProgress /></Container>;
  }

  if (!user && !pageLoading) {
    return <Container><Alert severity="error" sx={{mt: 2}}>{error || "User not found or failed to load."}</Alert></Container>;
  }

   if (error && !user) {
    return <Container><Alert severity="error" sx={{mt: 2}}>{error}</Alert></Container>;
  }

  return (
    <Container maxWidth="md">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Button
          variant="outlined"
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/admin/users')}
          sx={{ mb: 2 }}
        >
          Back to Users List
        </Button>
        <Typography component="h1" variant="h4" gutterBottom>
          Edit User: {user?.name} (ID: {user?.id})
        </Typography>
        <Box component="form" onSubmit={handleSubmit} noValidate sx={{ mt: 2 }}>
          <Grid container spacing={3}>
            <Grid item xs={12} sm={6}>
              <TextField
                required
                fullWidth
                id="name"
                label="Full Name"
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={loading || pageLoading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                required
                fullWidth
                id="email"
                label="Email Address"
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading || pageLoading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                required
                fullWidth
                id="role"
                select
                label="Role"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
                disabled={loading || pageLoading || (user?.id === useAuthStore.getState().user?.id && user?.role === 'ADMIN')} // Prevent admin from changing own role easily
              >
                <MenuItem value="STUDENT">STUDENT</MenuItem>
                <MenuItem value="ADMIN">ADMIN</MenuItem>
              </TextField>
               {user?.id === useAuthStore.getState().user?.id && user?.role === 'ADMIN' && (
                <Typography variant="caption" color="textSecondary">
                    Admins cannot change their own role.
                </Typography>
            )}
            </Grid>
             <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                id="phoneNumber"
                label="Phone Number (Optional)"
                name="phoneNumber"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={loading || pageLoading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                id="grade"
                label="Grade (Optional)"
                name="grade"
                value={grade}
                onChange={(e) => setGrade(e.target.value)}
                disabled={loading || pageLoading}
              />
            </Grid>
            <Grid item xs={12}>
                <Typography variant="subtitle1" sx={{mt:1, mb:1}}>Change Password (Optional)</Typography>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                name="password"
                label="New Password"
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading || pageLoading}
                helperText="Leave blank to keep current password."
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                name="confirmPassword"
                label="Confirm New Password"
                type="password"
                id="confirmPassword"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading || pageLoading}
                error={password !== confirmPassword && confirmPassword !== ''}
                helperText={password !== confirmPassword && confirmPassword !== '' ? "Passwords do not match." : ""}
              />
            </Grid>
          </Grid>

          {error && !successMessage && (
            <Alert severity="error" sx={{ mt: 3, width: '100%' }}>
              {error}
            </Alert>
          )}
          {successMessage && (
            <Alert severity="success" sx={{ mt: 3, width: '100%' }}>
              {successMessage}
            </Alert>
          )}

          <Button
            type="submit"
            fullWidth
            variant="contained"
            color="primary"
            sx={{ mt: 3, mb: 2 }}
            disabled={loading || pageLoading}
          >
            {loading ? <CircularProgress size={24} /> : 'Save Changes'}
          </Button>
        </Box>
      </Paper>
    </Container>
  );
};

export default EditUserPage;
