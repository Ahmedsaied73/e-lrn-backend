import React, { useEffect, useState } from 'react';
import {
  Container,
  Typography,
  Box,
  Alert,
  Paper,
  CircularProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  IconButton,
  Tooltip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Snackbar
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import useAuthStore from '../store/authStore'; // To prevent admin from deleting themselves

import { getAllUsers, deleteUser, User } from '../services/userService';

const UserListPage: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); // For general page errors
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationSuccessMessage, setOperationSuccessMessage] = useState<string | null>(null);

  const [openDeleteDialog, setOpenDeleteDialog] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);

  const navigate = useNavigate();
  const currentUser = useAuthStore((state) => state.user);


  const fetchUsersData = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getAllUsers();
      setUsers(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch users.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsersData();
  }, []);

  const handleEditUser = (userId: number) => {
    navigate(`/admin/users/edit/${userId}`);
  };

  const handleOpenDeleteDialog = (user: User) => {
    if (currentUser && user.id === currentUser.id) {
        setOperationError("You cannot delete your own account.");
        return;
    }
    setUserToDelete(user);
    setOpenDeleteDialog(true);
  };

  const handleCloseDeleteDialog = () => {
    setUserToDelete(null);
    setOpenDeleteDialog(false);
  };

  const handleConfirmDelete = async () => {
    if (!userToDelete) return;
    setLoading(true);
    setOperationError(null);
    setOperationSuccessMessage(null);
    try {
      const response = await deleteUser(userToDelete.id);
      setOperationSuccessMessage(response.message || `User "${userToDelete.name}" deleted successfully.`);
      fetchUsersData();
    } catch (err: any) {
      setOperationError(err.message || `Failed to delete user "${userToDelete.name}".`);
    } finally {
      setLoading(false);
      handleCloseDeleteDialog();
    }
  };

  if (loading && users.length === 0) { // Show loader only on initial load
    return (
      <Container maxWidth="lg">
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
          <CircularProgress />
        </Box>
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxWidth="lg">
        <Alert severity="error" sx={{ mt: 3 }}>{error}</Alert>
      </Container>
    );
  }

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
          <Typography component="h1" variant="h4">
            User Management
          </Typography>
          {/* Optional: Add User Button if admin creation is implemented
          <Button variant="contained" color="primary" startIcon={<AddIcon />}>
            Add New User
          </Button> */}
        </Box>

        {operationError && <Alert severity="error" onClose={() => setOperationError(null)} sx={{mb:2}}>{operationError}</Alert>}
        {operationSuccessMessage && <Alert severity="success" onClose={() => setOperationSuccessMessage(null)} sx={{mb:2}}>{operationSuccessMessage}</Alert>}

        {users.length === 0 ? (
          <Typography sx={{mt: 2}}>No users found.</Typography>
        ) : (
          <TableContainer>
            <Table stickyHeader aria-label="users table">
              <TableHead>
                <TableRow>
                  <TableCell>ID</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Email</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Phone</TableCell>
                  <TableCell>Grade</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map((user) => (
                  <TableRow hover key={user.id}>
                    <TableCell>{user.id}</TableCell>
                    <TableCell>{user.name}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>{user.role}</TableCell>
                    <TableCell>{user.phoneNumber || 'N/A'}</TableCell>
                    <TableCell>{user.grade || 'N/A'}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit User">
                        <IconButton onClick={() => handleEditUser(user.id)} size="small" disabled={loading}>
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete User">
                        <span> {/* Span needed for disabled button tooltip */}
                          <IconButton
                            onClick={() => handleOpenDeleteDialog(user)}
                            size="small"
                            disabled={loading || (currentUser?.id === user.id)}
                          >
                            <DeleteIcon />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={openDeleteDialog}
        onClose={handleCloseDeleteDialog}
      >
        <DialogTitle>Confirm Delete User</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete the user "{userToDelete?.name}" (Email: {userToDelete?.email})? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDeleteDialog} color="inherit" disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleConfirmDelete} color="error" autoFocus disabled={loading}>
            {loading && userToDelete ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!operationSuccessMessage}
        autoHideDuration={6000}
        onClose={() => setOperationSuccessMessage(null)}
        message={operationSuccessMessage}
      />
      <Snackbar
        open={!!operationError} // Also show general operation errors here
        autoHideDuration={6000}
        onClose={() => setOperationError(null)}
        message={operationError}
      />
    </Container>
  );
};

export default UserListPage;
