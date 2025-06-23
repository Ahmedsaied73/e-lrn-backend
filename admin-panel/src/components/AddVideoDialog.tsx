import React, { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Grid,
  CircularProgress,
  InputLabel,
  Alert
} from '@mui/material';
import { addVideoToCourse, VideoPayload } from '../services/courseService'; // Assuming VideoPayload is exported

interface AddVideoDialogProps {
  open: boolean;
  onClose: () => void;
  courseId: number | string;
  onVideoAdded: (newVideo: VideoPayload) => void; // Callback to update parent state
}

const AddVideoDialog: React.FC<AddVideoDialogProps> = ({ open, onClose, courseId, onVideoAdded }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [order, setOrder] = useState<number | string>(''); // Video order in course
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVideoFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setVideoFile(file);
    } else {
      setVideoFile(null);
    }
  };

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setOrder('');
    setVideoFile(null);
    setError(null);
  }

  const handleCloseDialog = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!order || isNaN(Number(order)) || Number(order) <= 0) {
      setError("Order must be a positive number.");
      return;
    }
    if (!videoFile) {
      setError("Video file is required.");
      return;
    }
    // Max file size check (e.g., 100MB) - This should ideally also be checked server-side
    if (videoFile.size > 100 * 1024 * 1024) {
        setError("File is too large. Maximum size is 100MB.");
        return;
    }


    setLoading(true);
    const formData = new FormData();
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    formData.append('order', Number(order).toString());
    formData.append('video', videoFile);
    // The API POST /videos/course/:courseId expects these fields as per API-DOCUMENTATION.md

    try {
      const response = await addVideoToCourse(courseId, formData);
      onVideoAdded(response.video); // Pass the newly added video back to parent
      handleCloseDialog();
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred while adding the video.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
      <DialogTitle>Add New Video to Course</DialogTitle>
      <form onSubmit={handleSubmit}>
        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                required
                fullWidth
                label="Video Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={loading}
                margin="dense"
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Video Description (Optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                multiline
                rows={3}
                disabled={loading}
                margin="dense"
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                required
                fullWidth
                label="Order in Course"
                type="number"
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                InputProps={{ inputProps: { min: 1 } }}
                disabled={loading}
                margin="dense"
              />
            </Grid>
            <Grid item xs={12} sm={6} sx={{ mt: 1 }}>
              <InputLabel shrink htmlFor="video-file-upload" sx={{fontSize: '1rem', mb: 0.5}}>
                Video File (Required)
              </InputLabel>
              <Button
                variant="outlined"
                component="label"
                fullWidth
                disabled={loading}
              >
                Upload Video File
                <input
                  id="video-file-upload"
                  type="file"
                  accept="video/*" // Accepts standard video formats
                  hidden
                  onChange={handleVideoFileChange}
                />
              </Button>
              {videoFile && <Typography variant="caption" display="block" sx={{mt:1}}>{videoFile.name}</Typography>}
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: '16px 24px' }}>
          <Button onClick={handleCloseDialog} color="inherit" disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" color="primary" disabled={loading}>
            {loading ? <CircularProgress size={24} /> : 'Add Video'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default AddVideoDialog;
