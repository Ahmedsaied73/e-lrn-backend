import React, { useEffect, useState } from 'react';
import {
  Container, Typography, Box, Paper, CircularProgress, Alert, Button,
  List, ListItem, ListItemText, Divider, IconButton, Tooltip
} from '@mui/material';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import VisibilityIcon from '@mui/icons-material/Visibility'; // To view quiz details/results

import { getCourseQuizzes, CourseQuizListItem } from '../services/quizService';
import { getCourseById, Course } from '../services/courseService'; // To get course title

const CourseQuizzesPage: React.FC = () => {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();

  const [quizzes, setQuizzes] = useState<CourseQuizListItem[]>([]);
  const [courseDetails, setCourseDetails] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!courseId) {
      setError("Course ID is missing.");
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const [courseData, quizzesData] = await Promise.all([
          getCourseById(courseId),
          getCourseQuizzes(courseId)
        ]);
        setCourseDetails(courseData);
        setQuizzes(quizzesData);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch quiz data for the course.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [courseId]);

  const handleViewQuizDetails = (quizId: number) => {
      // Navigate to a QuizDetailPage (to be created) which shows questions
      // and potentially aggregated results for admins.
      navigate(`/admin/quizzes/${quizId}/details`);
  };


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
                <Button variant="outlined" size="small" startIcon={<ArrowBackIcon />} onClick={() => navigate(`/admin/courses/${courseId}`)} sx={{ mr: 2 }}>
                    Back to Course: {courseDetails?.title || `ID ${courseId}`}
                </Button>
                <Typography component="h1" variant="h4" gutterBottom>
                    Quizzes for {courseDetails?.title || `Course ID: ${courseId}`}
                </Typography>
            </Box>
          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            component={RouterLink}
            // Link to create a quiz, pre-filling courseId and isFinal=true
            to={`/admin/quizzes/create?courseId=${courseId}&isFinal=true`}
          >
            Create New Final Exam
          </Button>
        </Box>
        <Typography variant="body2" color="textSecondary" sx={{mb:2}}>
            Lecture quizzes (associated with individual videos) can be created from the video's specific management page.
        </Typography>


        {quizzes.length === 0 ? (
          <Typography sx={{mt: 2}}>No quizzes found for this course. You can create a Final Exam above, or lecture quizzes via video management.</Typography>
        ) : (
          <List>
            {quizzes.filter(q => q.isFinal).map((quiz) => ( // Initially only show Final Exams here
              <React.Fragment key={quiz.id}>
                <ListItem
                    secondaryAction={
                        <>
                            <Tooltip title="View Quiz Details & Questions">
                                <IconButton edge="end" aria-label="details" onClick={() => handleViewQuizDetails(quiz.id)}>
                                    <VisibilityIcon />
                                </IconButton>
                            </Tooltip>
                            {/* Add Edit/Delete buttons here if those features are built for quizzes */}
                        </>
                    }
                >
                  <ListItemText
                    primary={`${quiz.title} (${quiz.isFinal ? 'Final Exam' : 'Lecture Quiz'})`}
                    secondary={
                        <>
                            <Typography component="span" variant="body2" color="text.primary">
                                Passing Score: {quiz.passingScore}% | Questions: {quiz.questionCount}
                            </Typography>
                            <br />
                            {quiz.description}
                            {quiz.videoId && quiz.videoTitle && <><br/>For Lecture: {quiz.videoTitle}</>}
                        </>
                    }
                  />
                </ListItem>
                <Divider component="li" />
              </React.Fragment>
            ))}
             {quizzes.filter(q => !q.isFinal).length > 0 && (
                <Typography variant="subtitle1" sx={{mt:2, mb:1}}>Lecture Quizzes (managed via video details):</Typography>
            )}
            {quizzes.filter(q => !q.isFinal).map((quiz) => ( // List lecture quizzes separately
              <React.Fragment key={quiz.id}>
                <ListItem
                    secondaryAction={
                        <>
                            <Tooltip title="View Quiz Details & Questions">
                                <IconButton edge="end" aria-label="details" onClick={() => handleViewQuizDetails(quiz.id)}>
                                    <VisibilityIcon />
                                </IconButton>
                            </Tooltip>
                        </>
                    }
                >
                  <ListItemText
                    primary={`${quiz.title} (Lecture Quiz)`}
                    secondary={
                        <>
                            <Typography component="span" variant="body2" color="text.primary">
                                For Video: {quiz.videoTitle || `ID ${quiz.videoId}`} | Passing Score: {quiz.passingScore}% | Questions: {quiz.questionCount}
                            </Typography>
                            <br/>
                            {quiz.description}
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

export default CourseQuizzesPage;
