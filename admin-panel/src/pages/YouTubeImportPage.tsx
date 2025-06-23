import React, { useState } from 'react';
import {
  TextField,
  Button,
  Container,
  Typography,
  Box,
  Alert,
  Paper,
  Grid,
  MenuItem,
  CircularProgress,
  Link
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { importYouTubePlaylist } from '../services/courseService';

type Grade = 'FIRST_SECONDARY' | 'SECOND_SECONDARY' | 'THIRD_SECONDARY';

const YouTubeImportPage: React.FC = () => {
  const [playlistId, setPlaylistId] = useState('');
  const [price, setPrice] = useState<number | string>(''); // Allow string for input flexibility
  const [grade, setGrade] = useState<Grade>('FIRST_SECONDARY');
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importedCourseId, setImportedCourseId] = useState<number | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setImportedCourseId(null);
    setLoading(true);

    if (!playlistId.trim()) {
      setError("Playlist ID is required.");
      setLoading(false);
      return;
    }

    const numericPrice = price === '' ? 0 : Number(price); // Default to 0 if empty
    if (isNaN(numericPrice) || numericPrice < 0) {
        setError("Price must be a valid non-negative number.");
        setLoading(false);
        return;
    }

    try {
      const response = await importYouTubePlaylist({
        playlistId: playlistId.trim(),
        price: numericPrice,
        grade,
      });
      setSuccessMessage(response.message + ` Course Title: ${response.course.title}`);
      setImportedCourseId(response.course.id);
      // Clear form
      setPlaylistId('');
      setPrice('');
      setGrade('FIRST_SECONDARY');
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred during import.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="md">
      <Paper sx={{ p: 3, mt: 3 }}>
        <Typography component="h1" variant="h4" gutterBottom>
          Import YouTube Playlist as Course
        </Typography>
        <Box component="form" onSubmit={handleSubmit} noValidate sx={{ mt: 2 }}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                margin="normal"
                required
                fullWidth
                id="playlistId"
                label="YouTube Playlist ID"
                name="playlistId"
                autoFocus
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value)}
                disabled={loading}
                helperText="Enter the ID of the YouTube playlist you want to import."
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                margin="normal"
                fullWidth
                name="price"
                label="Price (Optional, default 0)"
                type="number"
                id="price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                InputProps={{
                  inputProps: { min: 0, step: "0.01" }
                }}
                disabled={loading}
                helperText="Set a price for the course. Leave blank or 0 for free."
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                margin="normal"
                required
                fullWidth
                id="grade"
                select
                label="Grade Level"
                value={grade}
                onChange={(e) => setGrade(e.target.value as Grade)}
                disabled={loading}
                helperText="Select the target grade level for this course."
              >
                <MenuItem value="FIRST_SECONDARY">First Secondary</MenuItem>
                <MenuItem value="SECOND_SECONDARY">Second Secondary</MenuItem>
                <MenuItem value="THIRD_SECONDARY">Third Secondary</MenuItem>
              </TextField>
            </Grid>
          </Grid>

          {error && (
            <Alert severity="error" sx={{ mt: 2, width: '100%' }}>
              {error}
            </Alert>
          )}
          {successMessage && (
            <Alert severity="success" sx={{ mt: 2, width: '100%' }}>
              {successMessage}
              {importedCourseId && (
                <>
                  {' '}
                  <Link component={RouterLink} to={`/admin/courses/${importedCourseId}`}>
                    View imported course
                  </Link>
                </>
              )}
            </Alert>
          )}

          <Button
            type="submit"
            fullWidth
            variant="contained"
            sx={{ mt: 3, mb: 2 }}
            disabled={loading}
          >
            {loading ? <CircularProgress size={24} /> : 'Import Playlist'}
          </Button>
        </Box>
      </Paper>
    </Container>
  );
};

export default YouTubeImportPage;
