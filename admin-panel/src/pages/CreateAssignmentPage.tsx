import React, { useState } from 'react';
import {
  Container, Typography, Box, Paper, Grid, TextField, Button,
  CircularProgress, Alert, Switch, FormControlLabel, IconButton, Divider
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { createAssignment, CreateAssignmentPayload, AssignmentQuestionPayload } from '../services/assignmentService';

const CreateAssignmentPage: React.FC = () => {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [videoId, setVideoId] = useState<string | number>(''); // Should be a selector ideally
  const [dueDate, setDueDate] = useState(''); // Format: YYYY-MM-DDTHH:mm
  const [isMCQ, setIsMCQ] = useState(false);
  const [passingScore, setPassingScore] = useState<string | number>('');
  const [questions, setQuestions] = useState<Partial<AssignmentQuestionPayload>[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // MCQ Question Handlers
  const handleAddQuestion = () => {
    setQuestions([...questions, { text: '', options: ['', '', '', ''], correctOption: 0, points: 1 }]);
  };

  const handleRemoveQuestion = (index: number) => {
    const newQuestions = questions.filter((_, qIndex) => qIndex !== index);
    setQuestions(newQuestions);
  };

  const handleQuestionChange = (index: number, field: keyof AssignmentQuestionPayload, value: any) => {
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
    newQuestions[qIndex].options = [...currentOptions, ''];
    setQuestions(newQuestions);
  }

  const handleRemoveOption = (qIndex: number, optIndex: number) => {
     const newQuestions = [...questions];
    const currentOptions = newQuestions[qIndex].options ? [...newQuestions[qIndex].options!] : [];
    if (currentOptions.length > 2) { // Keep at least two options
        newQuestions[qIndex].options = currentOptions.filter((_, i) => i !== optIndex);
        // Adjust correctOption if it's out of bounds after removing an option
        if(newQuestions[qIndex].correctOption! >= newQuestions[qIndex].options!.length){
            newQuestions[qIndex].correctOption = newQuestions[qIndex].options!.length -1;
        }
        setQuestions(newQuestions);
    } else {
        setError("MCQ questions must have at least two options.")
    }
  }


  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!title.trim() || !videoId) {
      setError("Title and Video ID are required.");
      return;
    }
    if (isMCQ && (!questions.length || questions.some(q => !q.text || q.options?.some(opt => !opt.trim()) || q.options?.length < 2 || q.correctOption === undefined || q.points === undefined))) {
        setError("For MCQ, at least one question with text, at least two non-empty options, a correct option, and points are required.");
        return;
    }
     if (isMCQ && (passingScore === '' || isNaN(Number(passingScore)) || Number(passingScore) < 0 || Number(passingScore) > 100)) {
      setError("MCQ Passing Score must be a number between 0 and 100.");
      return;
    }


    setLoading(true);
    const payload: CreateAssignmentPayload = {
      title: title.trim(),
      description: description.trim(),
      videoId: Number(videoId),
      dueDate: dueDate || undefined,
      isMCQ,
    };

    if (isMCQ) {
      payload.passingScore = Number(passingScore);
      payload.questions = questions.map(q => ({
        text: q.text!,
        options: q.options!.map(opt => opt.trim()),
        correctOption: Number(q.correctOption!),
        explanation: q.explanation || '',
        points: Number(q.points!),
      })) as AssignmentQuestionPayload[];
    }

    try {
      const response = await createAssignment(payload);
      setSuccessMessage(response.message || "Assignment created successfully!");
      // Reset form or navigate
      setTimeout(() => {
        // TODO: Navigate to where assignments are listed, e.g., video detail page or assignment list page
        // navigate(`/admin/videos/${videoId}/assignments` or similar);
        navigate(-1); // Go back for now
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to create assignment.');
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
          Create New Assignment
        </Typography>
        <form onSubmit={handleSubmit}>
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <TextField
                required fullWidth label="Assignment Title" value={title}
                onChange={(e) => setTitle(e.target.value)} disabled={loading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth label="Description" value={description} multiline rows={3}
                onChange={(e) => setDescription(e.target.value)} disabled={loading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                required fullWidth label="Video ID" type="number" value={videoId}
                onChange={(e) => setVideoId(e.target.value)} disabled={loading}
                helperText="ID of the video this assignment belongs to." // TODO: Replace with a video selector component
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth label="Due Date (Optional)" type="datetime-local" value={dueDate}
                onChange={(e) => setDueDate(e.target.value)} disabled={loading}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12}>
              <FormControlLabel
                control={<Switch checked={isMCQ} onChange={(e) => setIsMCQ(e.target.checked)} />}
                label="Is this an MCQ (Multiple Choice Question) Assignment?"
                disabled={loading}
              />
            </Grid>

            {isMCQ && (
              <>
                <Grid item xs={12} sm={6}>
                    <TextField
                        required fullWidth label="MCQ Passing Score (%)" type="number" value={passingScore}
                        onChange={(e) => setPassingScore(e.target.value)} disabled={loading}
                        InputProps={{ inputProps: { min: 0, max: 100 } }}
                    />
                </Grid>
                <Grid item xs={12}><Divider sx={{ my: 1 }}><Typography variant="h6">MCQ Questions</Typography></Divider></Grid>
                {questions.map((q, qIndex) => (
                  <Grid item xs={12} key={qIndex} container spacing={1} component={Paper} variant="outlined" sx={{ p: 2, mb: 2, ml:2 }}>
                    <Grid item xs={12} display="flex" justifyContent="space-between" alignItems="center">
                        <Typography variant="subtitle1">Question {qIndex + 1}</Typography>
                        <IconButton onClick={() => handleRemoveQuestion(qIndex)} color="error" disabled={loading}>
                            <RemoveCircleOutlineIcon />
                        </IconButton>
                    </Grid>
                    <Grid item xs={12}>
                      <TextField required fullWidth label="Question Text" value={q.text || ''} multiline
                        onChange={(e) => handleQuestionChange(qIndex, 'text', e.target.value)} disabled={loading}
                      />
                    </Grid>
                    {q.options?.map((opt, optIndex) => (
                      <Grid item xs={12} sm={6} key={optIndex} display="flex" alignItems="center">
                        <TextField required fullWidth label={`Option ${optIndex + 1}`} value={opt}
                          onChange={(e) => handleOptionChange(qIndex, optIndex, e.target.value)} disabled={loading}
                        />
                        {q.options && q.options.length > 2 && (
                             <IconButton onClick={() => handleRemoveOption(qIndex, optIndex)} color="warning" size="small" sx={{ml:1}} disabled={loading}>
                                <RemoveCircleOutlineIcon fontSize="small"/>
                            </IconButton>
                        )}
                      </Grid>
                    ))}
                     <Grid item xs={12}>
                        <Button startIcon={<AddCircleOutlineIcon />} onClick={() => handleAddOption(qIndex)} size="small" disabled={loading || (q.options?.length || 0) >= 6 }>
                           {/* Limit options, e.g., to 6 */}
                            Add Option
                        </Button>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField required fullWidth label="Correct Option (Index)" type="number" value={q.correctOption ?? ''}
                        onChange={(e) => handleQuestionChange(qIndex, 'correctOption', parseInt(e.target.value,10))}
                        InputProps={{inputProps: {min:0, max: (q.options?.length || 1) -1 }}} disabled={loading}
                        helperText={`Enter 0 for Option 1, 1 for Option 2, etc. Max: ${(q.options?.length || 1) -1}`}
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField required fullWidth label="Points for this question" type="number" value={q.points ?? ''}
                        onChange={(e) => handleQuestionChange(qIndex, 'points', parseInt(e.target.value,10))}
                        InputProps={{inputProps: {min:1}}} disabled={loading}
                      />
                    </Grid>
                    <Grid item xs={12}>
                      <TextField fullWidth label="Explanation (Optional)" value={q.explanation || ''} multiline
                        onChange={(e) => handleQuestionChange(qIndex, 'explanation', e.target.value)} disabled={loading}
                      />
                    </Grid>
                  </Grid>
                ))}
                <Grid item xs={12}>
                  <Button startIcon={<AddCircleOutlineIcon />} onClick={handleAddQuestion} variant="outlined" disabled={loading}>
                    Add Question
                  </Button>
                </Grid>
              </>
            )}
          </Grid>

          {error && <Alert severity="error" sx={{ mt: 3 }}>{error}</Alert>}
          {successMessage && <Alert severity="success" sx={{ mt: 3 }}>{successMessage}</Alert>}

          <Button type="submit" variant="contained" color="primary" sx={{ mt: 4 }} disabled={loading} fullWidth>
            {loading ? <CircularProgress size={24} /> : 'Create Assignment'}
          </Button>
        </form>
      </Paper>
    </Container>
  );
};

export default CreateAssignmentPage;
