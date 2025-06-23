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
  Snackbar // For success/error messages after delete
} from '@mui/material';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import SyncIcon from '@mui/icons-material/Sync';
import { MenuItem, TextField } from '@mui/material'; // For grade selection in sync dialog

import { getAllCourses, deleteCourse, syncYouTubeCourse } from '../services/courseService'; // Added syncYouTubeCourse

// Define Course type locally if not imported, matching the service's Course type
// Add type for Grade if not already present
type Grade = 'FIRST_SECONDARY' | 'SECOND_SECONDARY' | 'THIRD_SECONDARY';
interface Course {
  id: number;
  title: string;
  description?: string;
  price: number;
  thumbnail?: string;
  isYoutube: boolean;
  youtubePlaylistId?: string;
  grade: string;
  createdAt?: string; // Assuming createdAt is available from API
  // Add other course properties as needed
}

const CourseListPage: React.FC = () => {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); // For general page errors
  const [deleteError, setDeleteError] = useState<string | null>(null); // For delete operation errors
  const [deleteSuccessMessage, setDeleteSuccessMessage] = useState<string | null>(null); // For delete success
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncSuccessMessage, setSyncSuccessMessage] = useState<string | null>(null);
  const [openDeleteDialog, setOpenDeleteDialog] = useState(false);
  const [courseToDelete, setCourseToDelete] = useState<Course | null>(null);
  const [openSyncDialog, setOpenSyncDialog] = useState(false);
  const [courseToSync, setCourseToSync] = useState<Course | null>(null);
  const [selectedGradeForSync, setSelectedGradeForSync] = useState<Grade | ''>('');
  const [isSyncing, setIsSyncing] = useState(false);

  const navigate = useNavigate();

  const fetchCoursesData = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getAllCourses();
      setCourses(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch courses.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCoursesData();
  }, []);

  const handleOpenDeleteDialog = (course: Course) => {
    setCourseToDelete(course);
    setOpenDeleteDialog(true);
  };

  const handleCloseDeleteDialog = () => {
    setCourseToDelete(null);
    setOpenDeleteDialog(false);
  };

  const handleConfirmDelete = async () => {
    if (!courseToDelete) return;
    setLoading(true); // Use main loading indicator for simplicity or add a specific delete loading state
    setDeleteError(null);
    setDeleteSuccessMessage(null);
    try {
      await deleteCourse(courseToDelete.id);
      setDeleteSuccessMessage(`Course "${courseToDelete.title}" deleted successfully.`);
      // Refresh course list
      fetchCoursesData(); // Re-fetch courses
    } catch (err: any) {
      setDeleteError(err.message || `Failed to delete course "${courseToDelete.title}".`);
    } finally {
      setLoading(false);
      handleCloseDeleteDialog();
    }
  };

  // Remove the duplicate useEffect for fetching courses here
  // The first one `useEffect(() => { fetchCoursesData(); }, []);` is correct.

  const handleViewDetails = (courseId: number) => {
    navigate(`/admin/courses/${courseId}`);
  };

  const handleEditCourse = (courseId: number) => {
    navigate(`/admin/courses/edit/${courseId}`);
  };

  const handleOpenSyncDialog = (course: Course) => {
    setCourseToSync(course);
    setSelectedGradeForSync(course.grade as Grade); // Pre-fill current grade
    setOpenSyncDialog(true);
  };

  const handleCloseSyncDialog = () => {
    setCourseToSync(null);
    setOpenSyncDialog(false);
    setSelectedGradeForSync('');
  };

  const handleConfirmSync = async () => {
    if (!courseToSync) return;
    setIsSyncing(true);
    setSyncError(null);
    setSyncSuccessMessage(null);
    try {
      // Pass undefined for grade if it hasn't changed from the course's current grade
      const gradeToUpdate = selectedGradeForSync !== courseToSync.grade ? selectedGradeForSync : undefined;
      const response = await syncYouTubeCourse(courseToSync.id, gradeToUpdate || undefined);

      let message = response.message || `Course "${courseToSync.title}" synced successfully.`;
      if (response.stats) {
        message += ` Added: ${response.stats.added || 0}, Updated: ${response.stats.updated || 0} videos.`;
      }
      setSyncSuccessMessage(message);
      fetchCoursesData(); // Re-fetch courses to reflect potential changes
    } catch (err: any) {
      setSyncError(err.message || `Failed to sync course "${courseToSync.title}".`);
    } finally {
      setIsSyncing(false);
      handleCloseSyncDialog();
    }
  };


  if (loading) {
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
            Course Management
          </Typography>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            component={RouterLink}
            to="/admin/courses/create" // Route for creating a new course (to be created)
          >
            Create New Course
          </Button>
        </Box>

        {deleteError && <Alert severity="error" onClose={() => setDeleteError(null)} sx={{mb:2}}>{deleteError}</Alert>}
        {deleteSuccessMessage && <Alert severity="success" onClose={() => setDeleteSuccessMessage(null)} sx={{mb:2}}>{deleteSuccessMessage}</Alert>}
        {syncError && <Alert severity="error" onClose={() => setSyncError(null)} sx={{mb:2}}>{syncError}</Alert>}
        {syncSuccessMessage && <Alert severity="success" onClose={() => setSyncSuccessMessage(null)} sx={{mb:2}}>{syncSuccessMessage}</Alert>}


        {courses.length === 0 && !loading ? (
          <Typography sx={{mt: 2}}>No courses found. Start by creating a new course or importing one from YouTube.</Typography>
        ) : (
          <TableContainer>
            <Table stickyHeader aria-label="courses table">
              <TableHead>
                <TableRow>
                  <TableCell>Title</TableCell>
                  <TableCell>Price</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Grade</TableCell>
                  <TableCell>Created At</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {courses.map((course) => (
                  <TableRow hover key={course.id}>
                    <TableCell>
                        <Typography variant="subtitle2" noWrap>{course.title}</Typography>
                    </TableCell>
                    <TableCell>${course.price.toFixed(2)}</TableCell>
                    <TableCell>{course.isYoutube ? 'YouTube' : 'Standard'}</TableCell>
                    <TableCell>{course.grade}</TableCell>
                    <TableCell>
                      {course.createdAt ? new Date(course.createdAt).toLocaleDateString() : 'N/A'}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title="View Details">
                        <IconButton onClick={() => handleViewDetails(course.id)} size="small">
                          <VisibilityIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit Course">
                        <IconButton onClick={() => handleEditCourse(course.id)} size="small">
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      {course.isYoutube && (
                        <Tooltip title="Sync YouTube Course">
                          <IconButton onClick={() => handleOpenSyncDialog(course)} size="small" disabled={isSyncing}>
                            <SyncIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                       <Tooltip title="Delete Course">
                        <IconButton onClick={() => handleOpenDeleteDialog(course)} size="small">
                          <DeleteIcon />
                        </IconButton>
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
        aria-labelledby="alert-dialog-title"
        aria-describedby="alert-dialog-description"
      >
        <DialogTitle id="alert-dialog-title">
          {"Confirm Delete Course"}
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="alert-dialog-description">
            Are you sure you want to delete the course "{courseToDelete?.title}"? This action cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDeleteDialog} color="primary">
            Cancel
          </Button>
          <Button onClick={handleConfirmDelete} color="error" autoFocus disabled={loading}>
            {loading && courseToDelete ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar for feedback */}
      <Snackbar
        open={!!deleteSuccessMessage}
        autoHideDuration={6000}
        onClose={() => setDeleteSuccessMessage(null)}
        message={deleteSuccessMessage}
      />
      <Snackbar
        open={!!deleteError}
        autoHideDuration={6000}
        onClose={() => setDeleteError(null)}
        message={deleteError} // Or wrap in an Alert component for better styling
      />

      {/* Sync Confirmation Dialog */}
      <Dialog
        open={openSyncDialog}
        onClose={handleCloseSyncDialog}
        aria-labelledby="sync-dialog-title"
      >
        <DialogTitle id="sync-dialog-title">
          Sync YouTube Playlist: {courseToSync?.title}
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{mb: 2}}>
            This will update the course details and video list from the linked YouTube playlist.
            You can also choose to update the grade level for this course.
          </DialogContentText>
          <TextField
            margin="dense"
            id="gradeForSync"
            select
            label="Grade Level (Optional)"
            value={selectedGradeForSync}
            onChange={(e) => setSelectedGradeForSync(e.target.value as Grade)}
            fullWidth
            variant="outlined"
            helperText={selectedGradeForSync === courseToSync?.grade ? "Current grade selected. Choose a different grade to update." : "New grade will be applied."}
          >
            <MenuItem value="FIRST_SECONDARY">First Secondary</MenuItem>
            <MenuItem value="SECOND_SECONDARY">Second Secondary</MenuItem>
            <MenuItem value="THIRD_SECONDARY">Third Secondary</MenuItem>
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseSyncDialog} color="primary" disabled={isSyncing}>
            Cancel
          </Button>
          <Button onClick={handleConfirmSync} color="primary" autoFocus disabled={isSyncing}>
            {isSyncing ? <CircularProgress size={24} /> : 'Confirm Sync'}
          </Button>
        </DialogActions>
      </Dialog>

       <Snackbar
        open={!!syncSuccessMessage}
        autoHideDuration={6000}
        onClose={() => setSyncSuccessMessage(null)}
        message={syncSuccessMessage}
      />
      <Snackbar
        open={!!syncError}
        autoHideDuration={6000}
        onClose={() => setSyncError(null)}
        message={syncError}
      />

    </Container>
  );
};

export default CourseListPage;
