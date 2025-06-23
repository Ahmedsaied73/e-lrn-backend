import React, { useEffect, useState } from 'react';
import {
  Container, Typography, Box, Paper, CircularProgress, Alert, Button,
  TextField, Grid, Link as MuiLink, FormControl, InputLabel, Select, MenuItem, SelectChangeEvent
} from '@mui/material';
import { useParams, useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import DownloadIcon from '@mui/icons-material/Download';

import { getAssignmentSubmissions, gradeSubmission, AssignmentSubmission, GradeSubmissionPayload, getAssignmentById, Assignment } from '../services/assignmentService';

const GradeSubmissionPage: React.FC = () => {
  const { submissionId } = useParams<{ submissionId: string }>();
  const navigate = useNavigate();

  const [submission, setSubmission] = useState<AssignmentSubmission | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [grade, setGrade] = useState<string | number>('');
  const [feedback, setFeedback] = useState('');
  const [status, setStatus] = useState<'GRADED' | 'REJECTED'>('GRADED'); // Default status

  const [loading, setLoading] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!submissionId) {
      setError("Submission ID is missing.");
      setLoading(false);
      return;
    }

    const fetchSubmissionDetails = async () => {
      setLoading(true);
      setError(null);
      try {
        // To get full submission details, we might need a dedicated endpoint
        // GET /assignments/submissions/:submissionId/details (if it existed)
        // For now, we fetch all submissions for the assignment and find the one.
        // This is inefficient if there are many submissions.
        // A better approach would be an API endpoint: GET /submissions/:submissionId

        // First, try to find which assignment this submission belongs to.
        // This is a workaround: iterate all assignments if needed, or expect assignmentId from route.
        // For now, assuming we can't directly fetch a single submission by its ID without knowing its assignment.
        // This part of the logic needs to be improved if the app scales.
        // Let's assume the `submission` object we'd get from `getAssignmentSubmissions` has enough detail.
        // The current API `getAssignmentSubmissions` is for an *assignment*, not a single submission.
        // The API doc `POST /assignments/submissions/:submissionId/grade` implies submissionId is globally unique.
        // This page is slightly problematic without a GET /submission/:id endpoint.

        // Temporary: For now, cannot fetch submission details directly.
        // This page would typically be reached from AssignmentSubmissionsPage, which has the context.
        // We'll mock fetching submission details or assume they are passed via route state.
        // This is a known limitation based on current API docs.
        // setError("Cannot fetch individual submission details with current API structure. This page needs context or a dedicated API endpoint for GET /submission/:submissionId.");
        // setLoading(false);
        // return;

        // Let's assume for now the backend returns enough info or we can make it work.
        // The gradeSubmission endpoint implies submissionId is enough.
        // To display details, we'd ideally fetch the submission and its related assignment.
        // This is a placeholder for fetching logic. If submission details are needed:
        // const subData = await getSingleSubmissionById(submissionId); // This function doesn't exist yet
        // setSubmission(subData);
        // setGrade(subData.grade || '');
        // setFeedback(subData.feedback || '');
        // if (subData.assignmentId) {
        //    const assgnData = await getAssignmentById(subData.assignmentId);
        //    setAssignment(assgnData);
        // }
        // For now, we allow grading without displaying full details if API for GET /submission/:id is missing.
        // This means we can't pre-fill student name, file URLs etc. unless passed via state.

        // For demo purposes, if submission data was passed via state:
        // const location = useLocation();
        // if (location.state?.submission) {
        //    setSubmission(location.state.submission as AssignmentSubmission);
        //    setAssignment(location.state.assignment as Assignment);
        //    setGrade(location.state.submission.grade || '');
        //    setFeedback(location.state.submission.feedback || '');
        // } else {
        //    setError("Submission details not available to grade.");
        // }

        // The API `POST /assignments/submissions/:submissionId/grade` takes grade, feedback, status.
        // We don't actually *need* to fetch the submission to grade it, but we *should* to display it.
        // For now, focus on the grading form. Displaying submission details is TBD based on API.
        // This is a critical point: How do we get details of submission `submissionId` to display?
        // The API docs don't have `GET /submission/:submissionId`.
        // The `getAssignmentSubmissions` takes `assignmentId`.
        // This page should probably be linked with `assignmentId` and `submissionId` in the route,
        // or `submission` object passed via state.
        // Let's assume for now this page is a stub until submission fetching is clarified.
        setError("NOTE: Displaying full submission details here requires a GET /submissions/:submissionId endpoint or data passed via route state. Currently focusing on the grading form itself.");

      } catch (err: any) {
        setError(err.message || 'Failed to prepare grading form.');
      } finally {
        setLoading(false);
      }
    };
    fetchSubmissionDetails();
  }, [submissionId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!submissionId) {
      setError("Submission ID is missing.");
      return;
    }
    if (grade === '' || isNaN(Number(grade)) || Number(grade) < 0 || Number(grade) > 100) {
      setError("Grade must be a number between 0 and 100.");
      return;
    }
    if (!feedback.trim()) {
        setError("Feedback is required.");
        return;
    }


    setFormLoading(true);
    setError(null);
    setSuccessMessage(null);

    const payload: GradeSubmissionPayload = {
      grade: Number(grade),
      feedback: feedback.trim(),
      status,
    };

    try {
      const response = await gradeSubmission(submissionId, payload);
      setSuccessMessage(response.message || "Submission graded successfully!");
      // Optionally navigate back or update local state
      setTimeout(() => {
        // navigate(`/admin/assignments/${response.submission.assignmentId}/submissions`);
        navigate(-1); // Go back to submissions list
      }, 1500);
    } catch (err: any) {
      setError(err.message || 'Failed to grade submission.');
    } finally {
      setFormLoading(false);
    }
  };

  const getFileNameFromUrl = (url: string): string => {
    try {
      const parsedUrl = new URL(url);
      const pathSegments = parsedUrl.pathname.split('/');
      return decodeURIComponent(pathSegments[pathSegments.length - 1]);
    } catch (e) { return "download"; }
  };

  if (loading && !submission) { // Initial loading for submission details (if any were fetched)
    return <Container sx={{display: 'flex', justifyContent: 'center', mt: 5}}><CircularProgress /></Container>;
  }

  // If submission details couldn't be fetched (due to API limitations mentioned above)
  // we still render the grading form but without specific submission content.
  // The admin would need to know which submission ID they are grading.

  return (
    <Container maxWidth="md">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={() => navigate(-1)} sx={{ mb: 2 }}>
          Back
        </Button>
        <Typography component="h1" variant="h4" gutterBottom>
          Grade Submission (ID: {submissionId})
        </Typography>

        {/* Placeholder for displaying submission content - Requires fetching actual submission */}
        {submission ? (
            <Box mb={3} p={2} border={1} borderColor="grey.300" borderRadius={1}>
                <Typography variant="h6">Submission Details:</Typography>
                <Typography><strong>Student:</strong> {submission.user?.name || 'N/A'} ({submission.user?.email || 'N/A'})</Typography>
                <Typography><strong>Submitted At:</strong> {new Date(submission.submittedAt).toLocaleString()}</Typography>
                {submission.content && <Typography sx={{mt:1, whiteSpace: 'pre-wrap'}}><strong>Content:</strong><br/>{submission.content}</Typography>}
                {submission.fileUrl && (
                     <Button
                        startIcon={<DownloadIcon />}
                        href={submission.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        download={getFileNameFromUrl(submission.fileUrl)}
                        sx={{mt:1}}
                    >
                        Download Submitted File: {getFileNameFromUrl(submission.fileUrl)}
                    </Button>
                )}
            </Box>
        ) : (
            <Alert severity="info" sx={{mb:2}}>
                Displaying submission content (like text or file links) requires fetching the specific submission.
                The current API documentation does not specify an endpoint like GET /submissions/:submissionId.
                This form allows grading based on the Submission ID directly.
            </Alert>
        )}


        <form onSubmit={handleSubmit}>
          <Grid container spacing={3}>
            <Grid item xs={12} sm={6}>
              <TextField
                required fullWidth label="Grade (0-100)" type="number" value={grade}
                onChange={(e) => setGrade(e.target.value)} disabled={formLoading}
                InputProps={{ inputProps: { min: 0, max: 100 } }}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
                <FormControl fullWidth required disabled={formLoading}>
                    <InputLabel id="status-select-label">Status</InputLabel>
                    <Select
                        labelId="status-select-label"
                        id="status"
                        value={status}
                        label="Status"
                        onChange={(e: SelectChangeEvent<'GRADED' | 'REJECTED'>) => setStatus(e.target.value as 'GRADED' | 'REJECTED')}
                    >
                        <MenuItem value="GRADED">Graded</MenuItem>
                        <MenuItem value="REJECTED">Rejected</MenuItem>
                        {/* Add more relevant statuses if backend supports */}
                    </Select>
                </FormControl>
            </Grid>
            <Grid item xs={12}>
              <TextField
                required fullWidth label="Feedback" value={feedback} multiline rows={5}
                onChange={(e) => setFeedback(e.target.value)} disabled={formLoading}
              />
            </Grid>
          </Grid>

          {error && <Alert severity="error" sx={{ mt: 3 }}>{error}</Alert>}
          {successMessage && <Alert severity="success" sx={{ mt: 3 }}>{successMessage}</Alert>}

          <Button type="submit" variant="contained" color="primary" sx={{ mt: 4 }} disabled={formLoading} fullWidth>
            {formLoading ? <CircularProgress size={24} /> : 'Submit Grade'}
          </Button>
        </form>
      </Paper>
    </Container>
  );
};

export default GradeSubmissionPage;
