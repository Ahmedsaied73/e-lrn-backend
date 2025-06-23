import React, { useState, useEffect } from 'react';
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
  Alert,
  Typography
} from '@mui/material';
import { updateVideoDetails, VideoPayload } from '../services/courseService';

interface EditVideoDialogProps {
  open: boolean;
  onClose: () => void;
  video: VideoPayload | null; // Video data to edit
  onVideoUpdated: (updatedVideo: VideoPayload) => void;
}

const EditVideoDialog: React.FC<EditVideoDialogProps> = ({ open, onClose, video, onVideoUpdated }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [order, setOrder] = useState<number | string>('');
  const [newVideoFile, setNewVideoFile] = useState<File | null>(null);
  const [currentVideoFileName, setCurrentVideoFileName] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (video) {
      setTitle(video.title || '');
      setDescription(video.description || '');
      setOrder(video.order?.toString() || '');
      // Assuming video.videoUrl might give a clue about the filename or just show placeholder
      setCurrentVideoFileName(video.videoUrl ? video.videoUrl.substring(video.videoUrl.lastIndexOf('/') + 1) : 'Current video exists');
      setNewVideoFile(null); // Reset file input on dialog open or video change
      setError(null);
    }
  }, [video, open]); // Re-populate form when dialog opens or video data changes

  const handleVideoFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setNewVideoFile(file);
    } else {
      setNewVideoFile(null);
    }
  };

  const handleCloseDialog = () => {
    // Don't reset form here if user might reopen for the same video
    // Resetting is handled by useEffect when 'video' prop changes or 'open' becomes true
    onClose();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!video) {
      setError("No video data to update.");
      return;
    }
    setError(null);

    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (!order || isNaN(Number(order)) || Number(order) <= 0) {
      setError("Order must be a positive number.");
      return;
    }
    if (newVideoFile && newVideoFile.size > 100 * 1024 * 1024) { // 100MB limit
        setError("New video file is too large. Maximum size is 100MB.");
        return;
    }

    setLoading(true);
    const formData = new FormData();
    formData.append('title', title.trim());
    formData.append('description', description.trim());
    formData.append('order', Number(order).toString());
    if (newVideoFile) {
      formData.append('video', newVideoFile); // API 'video' for file upload
    }
    // API PUT /videos/:id expects these fields.

    try {
      const response = await updateVideoDetails(video.id, formData);
      onVideoUpdated(response.video);
      handleCloseDialog();
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred while updating the video.');
    } finally {
      setLoading(false);
    }
  };

  if (!video) return null; // Or some placeholder if dialog is open without video

  return (
    <Dialog open={open} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
      <DialogTitle>Edit Video: {video.title}</DialogTitle>
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
                label="Video Description"
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
              <InputLabel shrink htmlFor="edit-video-file-upload" sx={{fontSize: '1rem', mb: 0.5}}>
                Replace Video File (Optional)
              </InputLabel>
              <Button
                variant="outlined"
                component="label"
                fullWidth
                disabled={loading}
              >
                Upload New Video
                <input
                  id="edit-video-file-upload"
                  type="file"
                  accept="video/*"
                  hidden
                  onChange={handleVideoFileChange}
                />
              </Button>
              {newVideoFile ? (
                <Typography variant="caption" display="block" sx={{mt:1}}>Selected: {newVideoFile.name}</Typography>
              ) : currentVideoFileName ? (
                 <Typography variant="caption" display="block" sx={{mt:1}}>Current: {currentVideoFileName}</Typography>
              ): null }
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: '16px 24px' }}>
          <Button onClick={handleCloseDialog} color="inherit" disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" color="primary" disabled={loading}>
            {loading ? <CircularProgress size={24} /> : 'Save Changes'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
};

export default EditVideoDialog;
