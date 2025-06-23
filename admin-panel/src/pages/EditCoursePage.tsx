import React, { useState, useEffect } from 'react';
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
  InputLabel
} from '@mui/material';
import { useNavigate, useParams } from 'react-router-dom';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { getCourseById, updateCourse } from '../services/courseService';

type Grade = 'FIRST_SECONDARY' | 'SECOND_SECONDARY' | 'THIRD_SECONDARY';

// Re-define Course interface or import if it's centrally defined
interface Course {
  id: number;
  title: string;
  description?: string;
  price: number;
  thumbnail?: string;
  isYoutube: boolean;
  youtubePlaylistId?: string;
  grade: string;
  videos: any[]; // Define more specifically if needed
}


const EditCoursePage: React.FC = () => {
  const { courseId } = useParams<{ courseId: string }>();
  const navigate = useNavigate();

  const [course, setCourse] = useState<Course | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState<number | string>('');
  const [grade, setGrade] = useState<Grade>('FIRST_SECONDARY');
  const [currentThumbnailUrl, setCurrentThumbnailUrl] = useState<string | null>(null);
  const [newThumbnail, setNewThumbnail] = useState<File | null>(null);
  const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); // For form submission
  const [pageLoading, setPageLoading] = useState(true); // For initial data fetch

  useEffect(() => {
    if (!courseId) {
      setError("Course ID is missing.");
      setPageLoading(false);
      return;
    }
    const fetchCourse = async () => {
      setPageLoading(true);
      try {
        const fetchedCourse = await getCourseById(courseId);
        setCourse(fetchedCourse);
        setTitle(fetchedCourse.title);
        setDescription(fetchedCourse.description || '');
        setPrice(fetchedCourse.price.toString());
        setGrade(fetchedCourse.grade as Grade); // Assuming grade from API matches Grade type
        setCurrentThumbnailUrl(fetchedCourse.thumbnail || null);
        setThumbnailPreview(fetchedCourse.thumbnail || null); // Show current thumbnail initially
      } catch (err: any) {
        setError(err.message || 'Failed to fetch course details.');
      } finally {
        setPageLoading(false);
      }
    };
    fetchCourse();
  }, [courseId]);

  const handleThumbnailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setNewThumbnail(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setThumbnailPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      // If user deselects file, revert to current or no preview if no current
      setNewThumbnail(null);
      setThumbnailPreview(currentThumbnailUrl);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!courseId) {
      setError("Course ID is missing for update.");
      return;
    }
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    if (!title.trim() || !description.trim()) {
      setError("Title and Description are required.");
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
    if (newThumbnail) { // Only append if a new thumbnail is selected
      formData.append('thumbnail', newThumbnail);
    }
    // The API for PUT /courses/:id in API-DOCUMENTATION.md expects these fields.
    // It does not mention changing isYoutube or youtubePlaylistId via this endpoint for existing courses.

    try {
      const updatedCourseData = await updateCourse(courseId, formData);
      setSuccessMessage(`Course "${updatedCourseData.title}" updated successfully!`);
      setCourse(updatedCourseData); // Update local state with new data
      setCurrentThumbnailUrl(updatedCourseData.thumbnail || null); // Update current thumbnail URL
      setThumbnailPreview(updatedCourseData.thumbnail || null);
      setNewThumbnail(null); // Reset new thumbnail
      // Optionally navigate or give more feedback
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred during course update.');
    } finally {
      setLoading(false);
    }
  };

  if (pageLoading) {
    return <Container sx={{display: 'flex', justifyContent: 'center', mt: 5}}><CircularProgress /></Container>;
  }

  if (!course && !pageLoading) { // If done loading and still no course (and no specific error yet from fetch)
    return <Container><Alert severity="error" sx={{mt: 2}}>{error || "Course not found or failed to load."}</Alert></Container>;
  }

   if (error && !course) { // If there was an error during fetch and no course data
    return <Container><Alert severity="error" sx={{mt: 2}}>{error}</Alert></Container>;
  }


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
          Edit Course: {course?.title}
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
                disabled={loading || pageLoading}
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
                disabled={loading || pageLoading}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                name="price"
                label="Price"
                type="number"
                id="price"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                InputProps={{ inputProps: { min: 0, step: "0.01" } }}
                disabled={loading || pageLoading}
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
                disabled={loading || pageLoading}
              >
                <MenuItem value="FIRST_SECONDARY">First Secondary</MenuItem>
                <MenuItem value="SECOND_SECONDARY">Second Secondary</MenuItem>
                <MenuItem value="THIRD_SECONDARY">Third Secondary</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12}>
              <InputLabel shrink htmlFor="thumbnail-upload" sx={{mb:1}}>
                Course Thumbnail (Leave unchanged or upload new)
              </InputLabel>
              <Button
                variant="outlined"
                component="label"
                fullWidth
                disabled={loading || pageLoading}
              >
                Upload New Thumbnail
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
                  <img src={thumbnailPreview} alt="Thumbnail preview" style={{ maxHeight: '200px', maxWidth: '100%', marginTop: '8px', border: '1px solid #ddd' }} />
                </Box>
              )}
            </Grid>
          </Grid>

          {error && !successMessage && ( // Only show general error if no success message
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
            disabled={loading || pageLoading}
          >
            {loading ? <CircularProgress size={24} /> : 'Save Changes'}
          </Button>
        </Box>
      </Paper>
    </Container>
  );
};

export default EditCoursePage;
