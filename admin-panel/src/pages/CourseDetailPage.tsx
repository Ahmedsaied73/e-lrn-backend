import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Container,
  Typography,
  Box,
  Alert,
  Paper,
  CircularProgress,
  Button,
  Grid,
  Card,
  CardMedia,
  CardContent,
  List,
  ListItem,
  ListItemText,
  Divider,
  TableContainer,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  IconButton,
  Tooltip,
  Dialog as ConfirmationDialog,
  DialogActions as ConfirmationDialogActions,
  DialogContent as ConfirmationDialogContent,
  DialogContentText as ConfirmationDialogContentText,
  DialogTitle as ConfirmationDialogTitle,
  Snackbar
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AssignmentIcon from '@mui/icons-material/Assignment';
import QuizIcon from '@mui/icons-material/Quiz'; // Import QuizIcon


// Updated imports from courseService
import { getCourseById, removeVideo, VideoPayload } from '../services/courseService';
import AddVideoDialog from '../components/AddVideoDialog';
import EditVideoDialog from '../components/EditVideoDialog';

// Define Course and Video types locally if not imported, matching the service's types
// The Video interface here is for display. VideoPayload might be more detailed for forms.
interface Video { // This is the Video type used for display within a Course
  id: number;
  title: string;
  youtubeId?: string;
  position: number;
  thumbnail?: string;
  duration?: number; // Assuming duration is in seconds
  videoUrl?: string; // May be needed for EditVideoDialog to show current video filename hint
  description?: string; // Needed for EditVideoDialog
  order?: number; // Alias for position, often used in forms
  // Add other video properties as needed
}

interface Course {
  id: number;
  title: string;
  description?: string;
  price: number;
  thumbnail?: string;
  isYoutube: boolean;
  youtubePlaylistId?: string;
  grade: string;
  createdAt?: string;
  videos: Video[];
  teacher?: {
    id: number;
    name: string;
    email?: string;
  };
  // Add other course properties as needed
}

const CourseDetailPage: React.FC = () => {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();
  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true); // For page load
  const [error, setError] = useState<string | null>(null); // For page load error
  const [operationLoading, setOperationLoading] = useState(false); // For add/edit/delete video operations
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operationSuccess, setOperationSuccess] = useState<string | null>(null);


  // State for dialogs
  const [addVideoOpen, setAddVideoOpen] = useState(false);
  const [editVideoOpen, setEditVideoOpen] = useState(false);
  const [deleteVideoConfirmOpen, setDeleteVideoConfirmOpen] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<VideoPayload | null>(null); // VideoPayload for forms

  const fetchCourseDetails = async () => {
    if (!courseId) {
      setError('Course ID is missing.');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const data = await getCourseById(courseId);
      setCourse(data);
    } catch (err: any) {
      setError(err.message || `Failed to fetch course details for ID ${courseId}.`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCourseDetails();
  }, [courseId]);

  const handleVideoAdded = (newVideo: VideoPayload) => {
    setOperationSuccess(`Video "${newVideo.title}" added successfully.`);
    fetchCourseDetails(); // Refresh course details to show new video
    setOperationError(null);
  };

  const handleVideoUpdated = (updatedVideo: VideoPayload) => {
    setOperationSuccess(`Video "${updatedVideo.title}" updated successfully.`);
    fetchCourseDetails(); // Refresh course details
    setOperationError(null);
  };

  const openEditVideoDialog = (video: Video) => {
    // Map display Video to VideoPayload for the dialog if necessary, or ensure types are compatible
    const videoPayload: VideoPayload = {
        ...video,
        order: video.position, // map position to order for the form
        courseId: course?.id || 0, // ensure courseId is present
    };
    setSelectedVideo(videoPayload);
    setEditVideoOpen(true);
  };

  const openDeleteVideoDialog = (video: Video) => {
     const videoPayload: VideoPayload = {
        ...video,
        order: video.position,
        courseId: course?.id || 0,
    };
    setSelectedVideo(videoPayload);
    setDeleteVideoConfirmOpen(true);
  };

  const handleConfirmDeleteVideo = async () => {
    if (!selectedVideo || !selectedVideo.id) return;
    setOperationLoading(true);
    setOperationError(null);
    setOperationSuccess(null);
    try {
      await removeVideo(selectedVideo.id);
      setOperationSuccess(`Video "${selectedVideo.title}" deleted successfully.`);
      fetchCourseDetails(); // Refresh
    } catch (err: any) {
      setOperationError(err.message || "Failed to delete video.");
    } finally {
      setOperationLoading(false);
      setDeleteVideoConfirmOpen(false);
      setSelectedVideo(null);
    }
  };


  if (loading) {
    return (
      <Container maxWidth="md">
        <Box display="flex" justifyContent="center" alignItems="center" minHeight="50vh">
          <CircularProgress />
        </Box>
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxWidth="md">
        <Alert severity="error" sx={{ mt: 3 }}>{error}</Alert>
        <Button
            variant="outlined"
            startIcon={<ArrowBackIcon />}
            onClick={() => navigate('/admin/courses')}
            sx={{ mt: 2 }}
        >
            Back to Courses
        </Button>
      </Container>
    );
  }

  if (!course) {
    return (
      <Container maxWidth="md">
        <Alert severity="info" sx={{ mt: 3 }}>Course not found.</Alert>
         <Button
            variant="outlined"
            startIcon={<ArrowBackIcon />}
            onClick={() => navigate('/admin/courses')}
            sx={{ mt: 2 }}
        >
            Back to Courses
        </Button>
      </Container>
    );
  }

  const defaultThumbnail = 'https://via.placeholder.com/300x170.png?text=No+Thumbnail';

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Button
          variant="outlined"
          startIcon={<ArrowBackIcon />}
          onClick={() => navigate('/admin/courses')}
          sx={{ mb: 2 }}
        >
          Back to Courses List
        </Button>
        <Typography component="h1" variant="h4" gutterBottom>
          {course.title}
        </Typography>

        <Grid container spacing={3}>
          <Grid item xs={12} md={4}>
            <Card>
              <CardMedia
                component="img"
                height="200"
                image={course.thumbnail || defaultThumbnail}
                alt={course.title}
              />
              <CardContent>
                <Typography variant="h6">Course Details</Typography>
                <Typography variant="body2" color="text.secondary">
                  <strong>ID:</strong> {course.id}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  <strong>Price:</strong> ${course.price.toFixed(2)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  <strong>Grade:</strong> {course.grade}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  <strong>Type:</strong> {course.isYoutube ? `YouTube (Playlist ID: ${course.youtubePlaylistId || 'N/A'})` : 'Standard'}
                </Typography>
                 <Typography variant="body2" color="text.secondary">
                  <strong>Created:</strong> {course.createdAt ? new Date(course.createdAt).toLocaleString() : 'N/A'}
                </Typography>
                {course.teacher && (
                     <Typography variant="body2" color="text.secondary">
                        <strong>Teacher:</strong> {course.teacher.name} (ID: {course.teacher.id})
                    </Typography>
                )}
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={8}>
            <Typography variant="h5" gutterBottom>Description</Typography>
            <Typography paragraph>
              {course.description || 'No description provided.'}
            </Typography>
            <Button
                component={RouterLink}
                to={`/admin/courses/${courseId}/quizzes`}
                variant="outlined"
                startIcon={<QuizIcon />}
                sx={{my: 2}}
            >
                Manage Course Quizzes (e.g., Final Exam)
            </Button>

            <Divider sx={{ my: 2 }} />

            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="h5">
                Videos ({course.videos?.length || 0})
              </Typography>
              {!course.isYoutube && ( // Only allow adding videos to non-YouTube courses
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => setAddVideoOpen(true)}
                  disabled={operationLoading}
                >
                  Add Video
                </Button>
              )}
            </Box>

            {operationError && <Alert severity="error" onClose={() => setOperationError(null)} sx={{mb:2}}>{operationError}</Alert>}
            {operationSuccess && <Alert severity="success" onClose={() => setOperationSuccess(null)} sx={{mb:2}}>{operationSuccess}</Alert>}

            {course.videos && course.videos.length > 0 ? (
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Order</TableCell>
                      <TableCell>Title</TableCell>
                      <TableCell>Type</TableCell>
                      <TableCell>Duration</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {course.videos.sort((a, b) => a.position - b.position).map((video) => (
                      <TableRow hover key={video.id}>
                        <TableCell>{video.position}</TableCell>
                        <TableCell>{video.title}</TableCell>
                        <TableCell>{video.youtubeId ? 'YouTube' : 'Uploaded'}</TableCell>
                        <TableCell>
                          {video.duration ? `${Math.floor(video.duration / 60)}m ${video.duration % 60}s` : 'N/A'}
                        </TableCell>
                        <TableCell align="right">
                          {!video.youtubeId && ( // Don't allow edit/delete for YouTube videos here directly
                            <>
                              <Tooltip title="Edit Video">
                                <IconButton onClick={() => openEditVideoDialog(video)} size="small" disabled={operationLoading}>
                                  <EditIcon />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Delete Video">
                                <IconButton onClick={() => openDeleteVideoDialog(video)} size="small" disabled={operationLoading}>
                                  <DeleteIcon />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Manage Assignments">
                                <IconButton component={RouterLink} to={`/admin/videos/${video.id}/assignments`} size="small" disabled={operationLoading}>
                                  <AssignmentIcon />
                                </IconButton>
                              </Tooltip>
                               <Tooltip title="Manage Lecture Quiz">
                                {/* This ideally links to a page showing the quiz for this video, or create if not exists */}
                                {/* For now, linking to create quiz page with videoId pre-filled */}
                                <IconButton component={RouterLink} to={`/admin/quizzes/create?videoId=${video.id}&isFinal=false`} size="small" disabled={operationLoading}>
                                  <QuizIcon />
                                </IconButton>
                              </Tooltip>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : (
              <Typography>No videos found for this course. {!course.isYoutube && "Click 'Add Video' to upload."}</Typography>
            )}
          </Grid>
        </Grid>
      </Paper>

      {/* Add Video Dialog */}
      {courseId && !course?.isYoutube && (
        <AddVideoDialog
          open={addVideoOpen}
          onClose={() => setAddVideoOpen(false)}
          courseId={courseId}
          onVideoAdded={handleVideoAdded}
        />
      )}

      {/* Edit Video Dialog */}
      {selectedVideo && !course?.isYoutube && (
        <EditVideoDialog
          open={editVideoOpen}
          onClose={() => { setEditVideoOpen(false); setSelectedVideo(null); }}
          video={selectedVideo}
          onVideoUpdated={handleVideoUpdated}
        />
      )}

      {/* Delete Video Confirmation Dialog */}
      <ConfirmationDialog
        open={deleteVideoConfirmOpen}
        onClose={() => { setDeleteVideoConfirmOpen(false); setSelectedVideo(null);}}
      >
        <ConfirmationDialogTitle>Confirm Delete Video</ConfirmationDialogTitle>
        <ConfirmationDialogContent>
          <ConfirmationDialogContentText>
            Are you sure you want to delete the video "{selectedVideo?.title}"? This action cannot be undone.
          </ConfirmationDialogContentText>
        </ConfirmationDialogContent>
        <ConfirmationDialogActions>
          <Button onClick={() => { setDeleteVideoConfirmOpen(false); setSelectedVideo(null);}} color="inherit" disabled={operationLoading}>
            Cancel
          </Button>
          <Button onClick={handleConfirmDeleteVideo} color="error" disabled={operationLoading}>
            {operationLoading && selectedVideo ? 'Deleting...' : 'Delete'}
          </Button>
        </ConfirmationDialogActions>
      </ConfirmationDialog>

      <Snackbar
          open={!!operationSuccess}
          autoHideDuration={6000}
          onClose={() => setOperationSuccess(null)}
          message={operationSuccess}
      />
      <Snackbar
          open={!!operationError}
          autoHideDuration={6000}
          onClose={() => setOperationError(null)}
          message={operationError}
      />

    </Container>
  );
};

export default CourseDetailPage;
