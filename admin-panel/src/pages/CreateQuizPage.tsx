import React, { useState, useEffect } from 'react';
import {
  Container, Typography, Box, Paper, Grid, TextField, Button,
  CircularProgress, Alert, Switch, FormControlLabel, IconButton, Divider,
  RadioGroup, Radio, FormLabel, MenuItem
} from '@mui/material';
import { useNavigate, useLocation } from 'react-router-dom';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { createQuiz, CreateQuizPayload, QuizQuestionPayload } from '../services/quizService';
// Ideally, fetch courses and videos for selectors
// import { getAllCourses, Course } from '../services/courseService';
// import { getVideosByCourse, Video } from '../services/videoService';

const CreateQuizPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation(); // To get query params like courseId or videoId

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [quizType, setQuizType] = useState<'LECTURE' | 'FINAL'>('LECTURE');
  const [linkedId, setLinkedId] = useState<string | number>(''); // Course ID or Video ID
  const [passingScore, setPassingScore] = useState<string | number>(70); // Default 70%
  const [questions, setQuestions] = useState<Partial<QuizQuestionPayload>[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Pre-fill from query params
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const courseId = searchParams.get('courseId');
    const videoId = searchParams.get('videoId');

    if (courseId) {
      setQuizType('FINAL');
      setLinkedId(courseId);
    } else if (videoId) {
      setQuizType('LECTURE');
      setLinkedId(videoId);
    }
  }, [location.search]);


  // Question Handlers (similar to CreateAssignmentPage for MCQs)
  const handleAddQuestion = () => {
    setQuestions([...questions, { text: '', options: ['', ''], correctOption: 0, points: 1, explanation: '' }]);
  };

  const handleRemoveQuestion = (index: number) => {
    setQuestions(questions.filter((_, qIndex) => qIndex !== index));
  };

  const handleQuestionChange = (index: number, field: keyof QuizQuestionPayload, value: any) => {
    const newQuestions = [...questions];
    newQuestions[index] = { ...newQuestions[index], [field]: value };
    setQuestions(newQuestions);
  };

  const handleOptionChange = (qIndex: number, optIndex: number, value: string) => {
    const newQuestions = [...questions];
    const currentOptions = newQuestions[qIndex].options ? [...newQuestions[qIndex].options!] : [];
    currentOptions[optIndex] = value;
    newQuestions[qIndex].options = currentOptions;
    setQuestions(newQuestions);
  };

  const handleAddOption = (qIndex: number) => {
    const newQuestions = [...questions];
    const currentOptions = newQuestions[qIndex].options ? [...newQuestions[qIndex].options!] : [];
    if (currentOptions.length < 6) { // Max 6 options for example
        newQuestions[qIndex].options = [...currentOptions, ''];
        setQuestions(newQuestions);
    }
  }

  const handleRemoveOption = (qIndex: number, optIndex: number) => {
     const newQuestions = [...questions];
    const currentOptions = newQuestions[qIndex].options ? [...newQuestions[qIndex].options!] : [];
    if (currentOptions.length > 2) {
        newQuestions[qIndex].options = currentOptions.filter((_, i) i !== optIndex);
        if(newQuestions[qIndex].correctOption! >= newQuestions[qIndex].options!.length){
            newQuestions[qIndex].correctOption = newQuestions[qIndex].options!.length -1;
        }
        setQuestions(newQuestions);
    } else {
        setError("Quiz questions must have at least two options.")
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!title.trim() || !linkedId) {
      setError(`Title and ${quizType === 'LECTURE' ? 'Video ID' : 'Course ID'} are required.`);
      return;
    }
    if (passingScore === '' || isNaN(Number(passingScore)) || Number(passingScore) < 0 || Number(passingScore) > 100) {
      setError("Passing Score must be a number between 0 and 100.");
      return;
    }
    if (!questions.length || questions.some(q => !q.text?.trim() || q.options?.some(opt => !opt.trim()) || q.options?.length < 2 || q.correctOption === undefined || q.points === undefined || q.points <= 0)) {
        setError("At least one question is required. Each question must have text, at least two non-empty options, a valid correct option index, and points greater than 0.");
        return;
    }
    questions.forEach(q => {
        if(q.correctOption! >= q.options!.length) {
            setError(`A question has an invalid correct option index. Max index is ${q.options!.length - 1}.`);
            return; // exit early
        }
    });
    if(error) return; // If error was set in the loop


    setLoading(true);
    const payload: CreateQuizPayload = {
      title: title.trim(),
      description: description.trim() || undefined,
      isFinal: quizType === 'FINAL',
      videoId: quizType === 'LECTURE' ? Number(linkedId) : null,
      courseId: quizType === 'FINAL' ? Number(linkedId) : null,
      passingScore: Number(passingScore),
      questions: questions.map(q => ({
        text: q.text!,
        options: q.options!.map(opt => opt.trim()),
        correctOption: Number(q.correctOption!),
        explanation: q.explanation?.trim() || '',
        points: Number(q.points!),
      })) as QuizQuestionPayload[],
    };

    try {
      const response = await createQuiz(payload);
      setSuccessMessage(response.message || "Quiz created successfully!");
      setTimeout(() => {
        // TODO: Navigate to where quizzes are listed (e.g., course detail or video detail page)
        navigate(-1); // Go back for now
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to create quiz.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="lg">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={() => navigate(-1)} sx={{ mb: 2 }}>
          Back
        </Button>
        <Typography component="h1" variant="h4" gutterBottom>
          Create New Quiz
        </Typography>
        <form onSubmit={handleSubmit}>
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <TextField required fullWidth label="Quiz Title" value={title}
                onChange={(e) => setTitle(e.target.value)} disabled={loading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth label="Description (Optional)" value={description} multiline rows={2}
                onChange={(e) => setDescription(e.target.value)} disabled={loading}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <FormControlLabel control={
                <Switch
                    checked={quizType === 'FINAL'}
                    onChange={(e) => setQuizType(e.target.checked ? 'FINAL' : 'LECTURE')}
                    disabled={loading || !!location.search} // Disable if pre-filled by query param
                />
                }
                label="Is this a Final Exam (for a Course)?"
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField required fullWidth label={quizType === 'LECTURE' ? "Video ID" : "Course ID"}
                type="number" value={linkedId}
                onChange={(e) => setLinkedId(e.target.value)} disabled={loading || !!location.search}
                helperText={!!location.search ? "Pre-filled from previous page." : `ID of the ${quizType === 'LECTURE' ? 'video' : 'course'}.`}
                // TODO: Replace with a proper selector component
              />
            </Grid>
            <Grid item xs={12} sm={4}>
                <TextField required fullWidth label="Passing Score (%)" type="number" value={passingScore}
                    onChange={(e) => setPassingScore(e.target.value)} disabled={loading}
                    InputProps={{ inputProps: { min: 0, max: 100 } }}
                />
            </Grid>

            <Grid item xs={12}><Divider sx={{my:1}}><Typography variant="h6">Quiz Questions</Typography></Divider></Grid>
            {questions.map((q, qIndex) => (
              <Grid item xs={12} key={qIndex} container spacing={1} component={Paper} variant="outlined" sx={{ p: 2, mb: 2, ml:2}}>
                <Grid item xs={12} display="flex" justifyContent="space-between" alignItems="center">
                    <Typography variant="subtitle1">Question {qIndex + 1}</Typography>
                    <IconButton onClick={() => handleRemoveQuestion(qIndex)} color="error" disabled={loading}><RemoveCircleOutlineIcon /></IconButton>
                </Grid>
                <Grid item xs={12}><TextField required fullWidth label="Question Text" value={q.text || ''} multiline onChange={(e) => handleQuestionChange(qIndex, 'text', e.target.value)} disabled={loading}/></Grid>

                <Grid item xs={12}><FormLabel component="legend" sx={{mt:1}}>Options (select correct one):</FormLabel></Grid>
                <RadioGroup
                    value={q.correctOption !== undefined ? q.correctOption.toString() : ""}
                    onChange={(e) => handleQuestionChange(qIndex, 'correctOption', parseInt(e.target.value, 10))}
                >
                    {q.options?.map((opt, optIndex) => (
                    <Grid item xs={12} key={optIndex} display="flex" alignItems="center" sx={{mb:0.5}}>
                        <FormControlLabel value={optIndex.toString()} control={<Radio disabled={loading}/>} label="" sx={{mr:0}}/>
                        <TextField required fullWidth label={`Option ${optIndex + 1}`} value={opt} variant="standard"
                        onChange={(e) => handleOptionChange(qIndex, optIndex, e.target.value)} disabled={loading}
                        />
                        {q.options && q.options.length > 2 && (
                            <IconButton onClick={() => handleRemoveOption(qIndex, optIndex)} color="warning" size="small" sx={{ml:0.5}} disabled={loading}><RemoveCircleOutlineIcon fontSize="inherit"/></IconButton>
                        )}
                    </Grid>
                    ))}
                </RadioGroup>
                <Grid item xs={12}>
                    <Button startIcon={<AddCircleOutlineIcon />} onClick={() => handleAddOption(qIndex)} size="small" disabled={loading || (q.options?.length || 0) >= 6}>Add Option</Button>
                </Grid>

                <Grid item xs={12} sm={6} sx={{mt:1}}>
                    <TextField required fullWidth label="Points" type="number" value={q.points ?? ''}
                    onChange={(e) => handleQuestionChange(qIndex, 'points', parseInt(e.target.value,10))}
                    InputProps={{inputProps: {min:1}}} disabled={loading}
                    />
                </Grid>
                <Grid item xs={12} sm={6} sx={{mt:1}}>
                    <TextField fullWidth label="Explanation (Optional)" value={q.explanation || ''} multiline
                    onChange={(e) => handleQuestionChange(qIndex, 'explanation', e.target.value)} disabled={loading}
                    />
                </Grid>
              </Grid>
            ))}
            <Grid item xs={12}>
              <Button startIcon={<AddCircleOutlineIcon />} onClick={handleAddQuestion} variant="outlined" disabled={loading}>Add Question</Button>
            </Grid>
          </Grid>

          {error && <Alert severity="error" sx={{ mt: 3 }}>{error}</Alert>}
          {successMessage && <Alert severity="success" sx={{ mt: 3 }}>{successMessage}</Alert>}

          <Button type="submit" variant="contained" color="primary" sx={{ mt: 4 }} disabled={loading} fullWidth>
            {loading ? <CircularProgress size={24} /> : 'Create Quiz'}
          </Button>
        </form>
      </Paper>
    </Container>
  );
};

export default CreateQuizPage;
