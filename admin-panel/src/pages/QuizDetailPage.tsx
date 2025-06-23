import React, { useEffect, useState } from 'react';
import {
  Container, Typography, Box, Paper, CircularProgress, Alert, Button,
  List, ListItem, ListItemText, Divider, Card, CardContent, Grid
} from '@mui/material';
import { useParams, useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';

import { getQuizById, Quiz, QuizQuestion } from '../services/quizService';

const QuizDetailPage: React.FC = () => {
  const { quizId } = useParams<{ quizId: string }>();
  const navigate = useNavigate();

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!quizId) {
      setError("Quiz ID is missing.");
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const quizData = await getQuizById(quizId);
        setQuiz(quizData);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch quiz details.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [quizId]);

  if (loading) {
    return <Container sx={{display: 'flex', justifyContent: 'center', mt: 5}}><CircularProgress /></Container>;
  }

  if (error) {
    return <Container><Alert severity="error" sx={{mt: 3}}>{error}</Alert></Container>;
  }

  if (!quiz) {
    return <Container><Alert severity="info" sx={{mt: 3}}>Quiz not found.</Alert></Container>;
  }

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={() => navigate(-1)} sx={{ mb: 2 }}>
          Back
        </Button>
        <Typography component="h1" variant="h4" gutterBottom>
          Quiz Details: {quiz.title}
        </Typography>
        <Grid container spacing={2} sx={{mb:2}}>
            <Grid item xs={12} sm={6}>
                <Typography variant="subtitle1"><strong>Type:</strong> {quiz.isFinal ? 'Final Exam' : 'Lecture Quiz'}</Typography>
                {quiz.courseId && quiz.course?.title && <Typography variant="body2"><strong>Course:</strong> {quiz.course.title} (ID: {quiz.courseId})</Typography>}
                {quiz.videoId && quiz.video?.title && <Typography variant="body2"><strong>Video:</strong> {quiz.video.title} (ID: {quiz.videoId})</Typography>}
            </Grid>
             <Grid item xs={12} sm={6}>
                <Typography variant="subtitle1"><strong>Passing Score:</strong> {quiz.passingScore}%</Typography>
                <Typography variant="body2"><strong>Description:</strong> {quiz.description || 'N/A'}</Typography>
            </Grid>
        </Grid>

        <Divider sx={{my:2}} />
        <Typography variant="h5" gutterBottom>Questions ({quiz.questions?.length || 0})</Typography>

        {quiz.questions && quiz.questions.length > 0 ? (
          <List>
            {quiz.questions.map((question, index) => (
              <Card key={question.id || index} sx={{ mb: 2 }} variant="outlined">
                <CardContent>
                  <Typography variant="h6" gutterBottom>Question {index + 1}: (Points: {question.points})</Typography>
                  <Typography sx={{whiteSpace: 'pre-wrap', mb:1}}>{question.text}</Typography>
                  <List dense sx={{pl:2}}>
                    {question.options.map((option, optIndex) => (
                      <ListItem key={optIndex} sx={{
                        pl:1,
                        borderLeft: optIndex === question.correctOption ? '4px solid green' : '4px solid transparent',
                        backgroundColor: optIndex === question.correctOption ? 'action.hover': 'inherit'
                        }}>
                        <ListItemText
                            primary={`${String.fromCharCode(65 + optIndex)}. ${option}`}
                            secondary={optIndex === question.correctOption ? '(Correct Answer)' : ''} />
                      </ListItem>
                    ))}
                  </List>
                  {question.explanation && (
                    <Typography variant="caption" display="block" sx={{mt:1, fontStyle: 'italic'}}>
                        <strong>Explanation:</strong> {question.explanation}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            ))}
          </List>
        ) : (
          <Typography>No questions found for this quiz.</Typography>
        )}
        {/* TODO: Add Edit Quiz button if API supports */}
      </Paper>
    </Container>
  );
};

export default QuizDetailPage;
