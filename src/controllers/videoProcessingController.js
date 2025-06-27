const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const prisma = require('../config/db');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'your-secret';

// 7. Upload video and convert to HLS
const uploadAndConvertVideo = async (req, res) => {
  try {
    const userId = req.user.id;
    const { title } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });
    if (!title) return res.status(400).json({ error: 'Title is required' });

    // Save video metadata to DB
    const video = await prisma.video.create({
      data: {
        title,
        uploaderId: userId,
        url: req.file.path, // temp, will update after HLS
        isHls: true
      }
    });

    const videoId = video.id;
    const outputDir = path.join('uploads', 'hls', String(videoId));
    fs.mkdirSync(outputDir, { recursive: true });
    const outputM3U8 = path.join(outputDir, 'index.m3u8');

    // Convert to HLS using fluent-ffmpeg
    ffmpeg(req.file.path)
      .outputOptions([
        '-c:v libx264',
        '-c:a aac',
        '-hls_time 10',
        '-hls_list_size 0',
        '-f hls'
      ])
      .output(outputM3U8)
      .on('end', async () => {
        await prisma.video.update({ where: { id: videoId }, data: { url: outputM3U8 } });
        res.json({ message: 'Video uploaded and converted', videoId, hlsPath: `/uploads/hls/${videoId}/index.m3u8` });
      })
      .on('error', (err) => {
        res.status(500).json({ error: 'HLS conversion failed', details: err.message });
      })
      .run();
  } catch (e) {
    res.status(500).json({ error: 'Failed to upload/convert video' });
  }
};

// 8. Generate temporary streaming URL
const getTemporaryStreamUrl = async (req, res) => {
  const { id } = req.params;
  // Optionally: check if user has access to this video
  const token = jwt.sign({ videoId: id }, SECRET, { expiresIn: '10m' });
  const url = `${req.protocol}://${req.get('host')}/videos/stream/${id}?token=${token}`;
  res.json({ url });
};

// 8b. Serve HLS playlist with JWT check
const serveHlsPlaylist = (req, res) => {
  const { id } = req.params;
  const { token } = req.query;
  try {
    jwt.verify(token, SECRET);
    const playlistPath = path.resolve(__dirname, `../../uploads/hls/${id}/index.m3u8`);
    if (!fs.existsSync(playlistPath)) return res.status(404).json({ error: 'Playlist not found' });
    res.sendFile(playlistPath);
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const processVideo = async (videoId, videoPath) => {
  try {
    const outputDir = path.join(__dirname, `../../uploads/videos/${videoId}`);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          '-c:v libx264',
          '-c:a aac',
          '-hls_time 10',
          '-hls_list_size 0',
          '-f hls'
        ])
        .output(path.join(outputDir, 'output.m3u8'))
        .on('end', () => {
          console.log('HLS conversion finished.');
          resolve();
        })
        .on('error', (err) => {
          console.error('Error during HLS conversion:', err);
          reject(err);
        })
        .run();
    });
  } catch (error) {
    console.error('Error processing video:', error);
    throw error;
  }
};

module.exports = {
  processVideo,
  uploadAndConvertVideo,
  getTemporaryStreamUrl,
  serveHlsPlaylist
};