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
  InputLabel // For file input styling
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { createCourse } from '../services/courseService';

type Grade = 'FIRST_SECONDARY' | 'SECOND_SECONDARY' | 'THIRD_SECONDARY';

const CreateCoursePage: React.FC = () => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState<number | string>('');
  const [grade, setGrade] = useState<Grade>('FIRST_SECONDARY');
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleThumbnailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setThumbnail(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setThumbnailPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      setThumbnail(null);
      setThumbnailPreview(null);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    if (!title.trim()) {
      setError("Title is required.");
      setLoading(false);
      return;
    }
    if (!description.trim()) {
      setError("Description is required.");
      setLoading(false);
      return;
    }
     if (!thumbnail) {
      setError("Thumbnail image is required.");
      setLoading(false);
      return;
    }

    const numericPrice = price === '' ? 0 : Number(price);
    if (isNaN(numericPrice) || numericPrice < 0) {
        setError("Price must be a valid non-negative number.");
        setLoading(false);
        return;
    }

    const formData = new FormData();
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    formData.append('price', numericPrice.toString());
    formData.append('grade', grade);
    if (thumbnail) {
      formData.append('thumbnail', thumbnail);
    }
    // Note: The API for POST /courses in API-DOCUMENTATION.md expects 'thumbnail' as a file.
    // It does not list 'isYoutube' or 'youtubePlaylistId' for this endpoint.

    try {
      const createdCourse = await createCourse(formData);
      setSuccessMessage(`Course "${createdCourse.title}" created successfully!`);
      // Clear form or navigate
      setTitle('');
      setDescription('');
      setPrice('');
      setGrade('FIRST_SECONDARY');
      setThumbnail(null);
      setThumbnailPreview(null);
      setTimeout(() => {
        navigate(`/admin/courses/${createdCourse.id}`);
      }, 1500); // Navigate after a short delay
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred during course creation.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxWidth="md">
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
          Create New Course
        </Typography>
        <Box component="form" onSubmit={handleSubmit} noValidate sx={{ mt: 2 }}>
          <Grid container spacing={3}>
            <Grid item xs={12}>
              <TextField
                required
                fullWidth
                id="title"
                label="Course Title"
                name="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={loading}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                required
                fullWidth
                id="description"
                label="Course Description"
                name="description"
                multiline
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                name="price"
                label="Price (Optional, default 0)"
                type="number"
                id="price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                InputProps={{ inputProps: { min: 0, step: "0.01" } }}
                disabled={loading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                required
                fullWidth
                id="grade"
                select
                label="Grade Level"
                value={grade}
                onChange={(e) => setGrade(e.target.value as Grade)}
                disabled={loading}
              >
                <MenuItem value="FIRST_SECONDARY">First Secondary</MenuItem>
                <MenuItem value="SECOND_SECONDARY">Second Secondary</MenuItem>
                <MenuItem value="THIRD_SECONDARY">Third Secondary</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12}>
              <InputLabel shrink htmlFor="thumbnail-upload" sx={{mb:1}}>
                Course Thumbnail (Required)
              </InputLabel>
              <Button
                variant="outlined"
                component="label"
                fullWidth
                disabled={loading}
              >
                Upload Thumbnail
                <input
                  id="thumbnail-upload"
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={handleThumbnailChange}
                />
              </Button>
              {thumbnailPreview && (
                <Box mt={2} textAlign="center">
                  <Typography variant="subtitle2">Preview:</Typography>
                  <img src={thumbnailPreview} alt="Thumbnail preview" style={{ maxHeight: '200px', maxWidth: '100%', marginTop: '8px' }} />
                </Box>
              )}
            </Grid>
          </Grid>

          {error && (
            <Alert severity="error" sx={{ mt: 3, width: '100%' }}>
              {error}
            </Alert>
          )}
          {successMessage && (
            <Alert severity="success" sx={{ mt: 3, width: '100%' }}>
              {successMessage}
            </Alert>
          )}

          <Button
            type="submit"
            fullWidth
            variant="contained"
            color="primary"
            sx={{ mt: 3, mb: 2 }}
            disabled={loading}
          >
            {loading ? <CircularProgress size={24} /> : 'Create Course'}
          </Button>
        </Box>
      </Paper>
    </Container>
  );
};

export default CreateCoursePage;
