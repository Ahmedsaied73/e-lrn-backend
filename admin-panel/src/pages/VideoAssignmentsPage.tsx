import React, { useEffect, useState } from 'react';
import {
  Container, Typography, Box, Paper, CircularProgress, Alert, Button,
  List, ListItem, ListItemText, Divider, IconButton, Tooltip
} from '@mui/material';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import VisibilityIcon from '@mui/icons-material/Visibility'; // To view submissions
// import EditIcon from '@mui/icons-material/Edit'; // If edit assignment is implemented
// import DeleteIcon from '@mui/icons-material/Delete'; // If delete assignment is implemented

import { getVideoAssignments, Assignment } from '../services/assignmentService';
import { getCourseById, Course } from '../services/courseService'; // To get course & video titles
import { getVideoById, Video } from '../services/videoService'; // Use the new service

// Minimal Video interface for context - can use imported Video type now
// interface VideoContext {
//     id: number;
//     title: string;
//     courseId?: number; // For breadcrumbs or back navigation to course
// }
// interface CourseContext {
//     id: number;
//     title: string;
// }
interface VideoContext {
    id: number;
    title: string;
    courseId?: number; // For breadcrumbs or back navigation to course
}
interface CourseContext {
    id: number;
    title: string;
}


const VideoAssignmentsPage: React.FC = () => {
  const { videoId } = useParams<{ videoId: string }>();
  const navigate = useNavigate();

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [videoDetails, setVideoDetails] = useState<Video | null>(null); // Use imported Video type
  const [courseDetails, setCourseDetails] = useState<Course | null>(null); // Use imported Course type
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoId) {
      setError("Video ID is missing.");
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // Fetch assignments
        const assignmentData = await getVideoAssignments(videoId);
        setAssignments(assignmentData.assignments);

        // Fetch video details
        const videoData = await getVideoById(videoId);
        setVideoDetails(videoData);

        // If videoData contains courseId, fetch course details too for breadcrumbs
        if (videoData.courseId) {
           const courseData = await getCourseById(videoData.courseId);
           setCourseDetails(courseData);
        }

      } catch (err: any) {
        setError(err.message || 'Failed to fetch page data.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [videoId]);

  if (loading) {
    return <Container sx={{display: 'flex', justifyContent: 'center', mt: 5}}><CircularProgress /></Container>;
  }

  if (error) {
    return <Container><Alert severity="error" sx={{mt: 3}}>{error}</Alert></Container>;
  }

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Box>
                {/* Breadcrumbs or back navigation - improve later */}
                {courseDetails && (
                     <Button variant="outlined" size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(`/admin/courses/${courseDetails.id}`)} sx={{ mr: 2 }}>
                        Back to Course: {courseDetails.title}
                    </Button>
                )}
                 <Button variant="outlined" size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(-1)} sx={{ mr: 2 }}>
                    Back
                </Button>
                <Typography component="h1" variant="h4" gutterBottom>
                    Assignments for {videoDetails?.title || `Video ID: ${videoId}`}
                </Typography>
            </Box>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            component={RouterLink}
            to={`/admin/assignments/create?videoId=${videoId}`} // Pass videoId to pre-fill in create form
          >
            Create New Assignment
          </Button>
        </Box>

        {assignments.length === 0 ? (
          <Typography sx={{mt: 2}}>No assignments found for this video.</Typography>
        ) : (
          <List>
            {assignments.map((assignment) => (
              <React.Fragment key={assignment.id}>
                <ListItem
                    secondaryAction={
                        <>
                            <Tooltip title="View Submissions">
                                <IconButton edge="end" aria-label="submissions" component={RouterLink} to={`/admin/assignments/${assignment.id}/submissions`}>
                                    <VisibilityIcon />
                                </IconButton>
                            </Tooltip>
                            {/* Add Edit/Delete buttons here if those features are built for assignments */}
                        </>
                    }
                >
                  <ListItemText
                    primary={`${assignment.title} (${assignment.isMCQ ? 'MCQ' : 'Standard'})`}
                    secondary={
                        <>
                            <Typography component="span" variant="body2" color="text.primary">
                                Due: {assignment.dueDate ? new Date(assignment.dueDate).toLocaleString() : 'Not set'}
                            </Typography>
                            <br />
                            {assignment.description}
                        </>
                    }
                  />
                </ListItem>
                <Divider component="li" />
              </React.Fragment>
            ))}
          </List>
        )}
      </Paper>
    </Container>
  );
};

export default VideoAssignmentsPage;
