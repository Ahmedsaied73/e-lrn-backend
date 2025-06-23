import React, { useEffect, useState } from 'react';
import {
  Container, Typography, Box, Paper, CircularProgress, Alert, Button,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, IconButton
} from '@mui/material';
import { useParams, useNavigate, Link as RouterLink } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import GradeIcon from '@mui/icons-material/Grade'; // For grading action
import DownloadIcon from '@mui/icons-material/Download';

import { getAssignmentSubmissions, AssignmentSubmission, getAssignmentById, Assignment } from '../services/assignmentService';

const AssignmentSubmissionsPage: React.FC = () => {
  const { assignmentId } = useParams<{ assignmentId: string }>();
  const navigate = useNavigate();

  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [submissions, setSubmissions] = useState<AssignmentSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!assignmentId) {
      setError("Assignment ID is missing.");
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        const [assignmentData, submissionsData] = await Promise.all([
          getAssignmentById(assignmentId),
          getAssignmentSubmissions(assignmentId)
        ]);
        setAssignment(assignmentData);
        setSubmissions(submissionsData.submissions);
      } catch (err: any) {
        setError(err.message || 'Failed to fetch assignment submissions.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [assignmentId]);

  const handleGradeSubmission = (submissionId: number) => {
    // Navigate to a new page or open a dialog for grading
    // For MCQ, it's auto-graded. For others, manual grading UI is needed.
    if (assignment?.isMCQ) {
        // Optionally show MCQ results if available on submission object
        alert("MCQ assignments are auto-graded. Viewing detailed MCQ results by admin is not yet implemented here.");
    } else {
        navigate(`/admin/submissions/${submissionId}/grade`);
    }
  };

  if (loading) {
    return <Container sx={{display: 'flex', justifyContent: 'center', mt: 5}}><CircularProgress /></Container>;
  }

  if (error) {
    return <Container><Alert severity="error" sx={{mt: 3}}>{error}</Alert></Container>;
  }

  const getFileNameFromUrl = (url: string): string => {
    try {
      const parsedUrl = new URL(url);
      const pathSegments = parsedUrl.pathname.split('/');
      return decodeURIComponent(pathSegments[pathSegments.length - 1]);
    } catch (e) {
      return "download"; // fallback
    }
  };


  return (
    <Container maxWidth="xl"> {/* Use xl for wider tables */}
      <Paper sx={{ p: 3, mt: 3 }}>
        <Button variant="outlined" startIcon={<ArrowBackIcon />} onClick={() => navigate(-1)} sx={{ mb: 2 }}>
          Back
        </Button>
        <Typography component="h1" variant="h4" gutterBottom>
          Submissions for: {assignment?.title || `Assignment ID: ${assignmentId}`}
        </Typography>
        <Typography variant="subtitle1" gutterBottom>
            Type: {assignment?.isMCQ ? 'MCQ Quiz' : 'Standard Assignment'}
            {assignment?.isMCQ && assignment.passingScore && ` (Passing Score: ${assignment.passingScore}%)`}
        </Typography>


        {submissions.length === 0 ? (
          <Typography sx={{mt: 2}}>No submissions found for this assignment yet.</Typography>
        ) : (
          <TableContainer>
            <Table stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Submission ID</TableCell>
                  <TableCell>Student Name</TableCell>
                  <TableCell>Student Email</TableCell>
                  <TableCell>Submitted At</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Grade</TableCell>
                  {assignment?.isMCQ && <TableCell>MCQ Score</TableCell>}
                  <TableCell>Content/File</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {submissions.map((sub) => (
                  <TableRow hover key={sub.id}>
                    <TableCell>{sub.id}</TableCell>
                    <TableCell>{sub.user?.name || 'N/A'}</TableCell>
                    <TableCell>{sub.user?.email || 'N/A'}</TableCell>
                    <TableCell>{new Date(sub.submittedAt).toLocaleString()}</TableCell>
                    <TableCell>{sub.status}</TableCell>
                    <TableCell>{sub.grade !== null && sub.grade !== undefined ? `${sub.grade}%` : 'Not Graded'}</TableCell>
                    {assignment?.isMCQ && <TableCell>{sub.mcqScore !== null && sub.mcqScore !== undefined ? `${sub.mcqScore}%` : 'N/A'}</TableCell>}
                    <TableCell>
                        {sub.content ? (
                            <Tooltip title={sub.content}>
                                <Typography noWrap sx={{maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis'}}>
                                    {sub.content}
                                </Typography>
                            </Tooltip>
                        ): sub.fileUrl ? (
                            <Button
                                startIcon={<DownloadIcon />}
                                href={sub.fileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                download={getFileNameFromUrl(sub.fileUrl)} // Suggest filename
                            >
                                {getFileNameFromUrl(sub.fileUrl)}
                            </Button>
                        ) : 'No content/file'}
                    </TableCell>
                    <TableCell align="right">
                      {sub.status !== 'GRADED' && !assignment?.isMCQ && ( // Only show grade for non-MCQ if not graded
                        <Tooltip title="Grade Submission">
                          <IconButton onClick={() => handleGradeSubmission(sub.id)} size="small">
                            <GradeIcon />
                          </IconButton>
                        </Tooltip>
                      )}
                       {assignment?.isMCQ && sub.status === 'GRADED' && ( // For MCQs, maybe a "View Details" if results are complex
                        <Tooltip title="MCQ Auto-graded. View details (NYI)">
                           <IconButton size="small" disabled>
                                <VisibilityIcon/>
                           </IconButton>
                        </Tooltip>
                       )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
    </Container>
  );
};

export default AssignmentSubmissionsPage;
