# Mux Video Upload and Streaming Integration Guide

This document provides a comprehensive guide for integrating Mux video uploading and streaming in the e-learning platform, including detailed API specifications and implementation steps.

## 1. Overview

The Mux integration provides a robust and scalable solution for handling video content. Instead of processing and hosting videos on our own server, we use Mux's powerful infrastructure. This approach offers several advantages:

- **Direct-to-Mux Uploads**: The client-side application uploads video files directly to Mux, reducing the load on our server.
- **Automatic Transcoding**: Mux automatically transcodes uploaded videos into various formats and bitrates, ensuring optimal playback on different devices and network conditions.
- **Global CDN**: Mux delivers video content through a global content delivery network (CDN), providing fast and reliable streaming to users worldwide.
- **Detailed Analytics**: Mux provides detailed analytics on video performance and user engagement.
- **Secure Playback**: Videos are protected using signed playback URLs to prevent unauthorized access.

## 2. Prerequisites

### 2.1. Mux Account Setup

1. Create a Mux account at [https://mux.com/](https://mux.com/)
2. Generate API credentials in the Mux dashboard
3. Configure webhook endpoints to receive video processing status updates

### 2.2. Environment Variables

Add the following environment variables to your `.env` file:

```
# Mux API Credentials
MUX_TOKEN_ID=your_mux_token_id
MUX_TOKEN_SECRET=your_mux_token_secret

# Mux Webhook Secret
MUX_WEBHOOK_SECRET=your_mux_webhook_secret
```

## 3. Database Schema

The database schema includes a `MuxData` model to store Mux-specific information for each video:

```prisma
model Video {
  id          Int      @id @default(autoincrement())
  title       String
  url         String
  thumbnail   String
  course      Course   @relation(fields: [courseId], references: [id], onDelete: Cascade)
  courseId    Int
  duration    Int
  isYoutube   Boolean  @default(false)
  description String?
  createdAt   DateTime @default(now())
  muxData     MuxData?
}

model MuxData {
  id          Int     @id @default(autoincrement())
  assetId     String  @unique
  playbackId  String? @unique
  uploadId    String? @unique  // For direct upload tracking
  isProcessed Boolean @default(false)
  status      MuxAssetStatus @default(PREPARING)
  duration    Float?  // Video duration in seconds
  aspectRatio String? // e.g., "16:9"
  resolution  String? // e.g., "1920x1080"
  fileSize    BigInt? // File size in bytes
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  muxCreatedAt DateTime?
  muxUpdatedAt DateTime?
  errorMessage String? // Store any processing errors
  video       Video   @relation(fields: [videoId], references: [id], onDelete: Cascade)
  videoId     Int     @unique
}

enum MuxAssetStatus {
  PREPARING   // Asset is being prepared
  READY       // Asset is ready for playback
  ERRORED     // Asset processing failed
  DELETED     // Asset has been deleted
}
```

## 4. API Endpoints

### 4.1. Create Direct Upload URL

**Endpoint**: `POST /api/mux/uploads`

**Authentication**: Admin only

**Request Body**:
```json
{
  "courseId": "123",
  "title": "Introduction to JavaScript",
  "description": "Learn the basics of JavaScript programming" 
}
```

**Response (201 Created)**:
```json
{
  "success": true,
  "data": {
    "uploadUrl": "https://storage.mux.com/api/direct-uploads/1234abcd",
    "videoId": 456,
    "assetId": "asset_1234abcd",
    "uploadId": "upload_1234abcd"
  }
}
```

**Error Responses**:
- 400 Bad Request: Missing required fields
- 404 Not Found: Course not found
- 500 Internal Server Error: Server-side error

### 4.2. Get Video Streaming URL

**Endpoint**: `GET /api/mux/videos/:videoId/stream`

**Authentication**: Authenticated user with course access

**URL Parameters**:
- `videoId`: ID of the video to stream

**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "playbackUrl": "https://stream.mux.com/playback_id.m3u8?token=jwt_token",
    "thumbnailUrl": "https://image.mux.com/playback_id/thumbnail.jpg?token=jwt_token",
    "storyboardUrl": "https://image.mux.com/playback_id/storyboard.vtt?token=jwt_token",
    "duration": 320.5,
    "aspectRatio": "16:9",
    "resolution": "720p"
  }
}
```

**Error Responses**:
- 400 Bad Request: Video not ready for streaming
- 403 Forbidden: User doesn't have access to the video
- 404 Not Found: Video not found
- 500 Internal Server Error: Server-side error

### 4.3. Get Asset Information

**Endpoint**: `GET /api/mux/videos/:videoId/asset`

**Authentication**: Admin only

**URL Parameters**:
- `videoId`: ID of the video

**Response (200 OK)**:
```json
{
  "success": true,
  "data": {
    "assetId": "asset_1234abcd",
    "status": "ready",
    "duration": 320.5,
    "aspectRatio": "16:9",
    "resolution": "720p",
    "createdAt": "2023-05-15T10:30:00Z",
    "tracks": [...],
    "playbackIds": [...]
  }
}
```

**Error Responses**:
- 404 Not Found: Video or Mux data not found
- 500 Internal Server Error: Server-side error

### 4.4. Delete Video Asset

**Endpoint**: `DELETE /api/mux/videos/:videoId/asset`

**Authentication**: Admin only

**URL Parameters**:
- `videoId`: ID of the video to delete

**Response (200 OK)**:
```json
{
  "success": true,
  "message": "Video asset deleted successfully"
}
```

**Error Responses**:
- 404 Not Found: Video or Mux data not found
- 500 Internal Server Error: Server-side error

### 4.5. Mux Webhooks

**Endpoint**: `POST /api/mux/webhooks`

**Authentication**: Secured by Mux signature verification

**Request Headers**:
- `mux-signature`: Signature from Mux to verify the webhook

**Request Body**: Varies based on the event type

**Response**: 200 OK if processed successfully

**Supported Event Types**:
- `video.asset.ready`: Asset is ready for playback
- `video.asset.errored`: Asset processing failed
- `video.asset.deleted`: Asset was deleted
- `video.upload.asset_created`: Upload created an asset

## 5. Complete Implementation Workflow

### 5.1. Admin Uploads Video

1. **Request Upload URL**:
   - Admin initiates video upload from the dashboard
   - Frontend sends a POST request to `/api/mux/uploads` with course ID and video details
   - Server creates a direct upload URL using Mux API and creates a video record in the database
   - Server returns the upload URL and video ID to the frontend

2. **Upload Video File**:
   - Frontend uploads the video file directly to the Mux URL using a PUT request
   - Example code:
   ```javascript
   // After receiving the upload URL from the server
   async function uploadVideoToMux(file, uploadUrl) {
     try {
       const response = await fetch(uploadUrl, {
         method: 'PUT',
         body: file,
         headers: {
           'Content-Type': file.type
         }
       });
       
       if (response.ok) {
         console.log('Upload successful');
         return true;
       } else {
         throw new Error('Upload failed');
       }
     } catch (error) {
       console.error('Error uploading to Mux:', error);
       return false;
     }
   }
   ```

### 5.2. Mux Processes Video

1. **Asset Creation**:
   - Mux creates an asset from the uploaded file
   - Mux sends a `video.upload.asset_created` webhook to our server
   - Server updates the MuxData record with the asset ID

2. **Video Processing**:
   - Mux transcodes the video into multiple formats and bitrates
   - During processing, the video status remains as `PREPARING`

3. **Processing Complete**:
   - When processing is complete, Mux sends a `video.asset.ready` webhook
   - Server updates the MuxData record with playback ID, duration, and other metadata
   - Video status is updated to `READY`

### 5.3. User Streams Video

1. **Request Streaming URL**:
   - User navigates to a video page in the course
   - Frontend requests streaming URL from `/api/mux/videos/:videoId/stream`
   - Server verifies user has access to the course
   - Server generates signed JWT tokens for playback, thumbnails, and storyboards
   - Server returns the streaming URLs to the frontend

2. **Video Playback**:
   - Frontend uses an HLS-compatible player (like Video.js, Plyr, or HLS.js) to play the video
   - Example player implementation:
   ```javascript
   import Plyr from 'plyr';
   import Hls from 'hls.js';
   
   function setupVideoPlayer(playbackUrl) {
     const video = document.getElementById('player');
     
     // For browsers that support HLS natively (Safari)
     if (video.canPlayType('application/vnd.apple.mpegurl')) {
       video.src = playbackUrl;
     } 
     // For other browsers, use HLS.js
     else if (Hls.isSupported()) {
       const hls = new Hls();
       hls.loadSource(playbackUrl);
       hls.attachMedia(video);
       
       // Initialize Plyr player
       const player = new Plyr(video, {
         controls: ['play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'],
         settings: ['quality', 'speed', 'loop']
       });
     } else {
       console.error('HLS is not supported in this browser');
     }
   }
   ```

## 6. Security Considerations

### 6.1. Signed URLs

All video playback URLs are signed with JWT tokens to prevent unauthorized access:

- Tokens have a limited validity period (24 hours by default)
- Tokens are specific to a particular playback ID
- Tokens can be restricted by IP address or referrer for additional security

### 6.2. Webhook Verification

All webhooks from Mux are verified using the signature in the `mux-signature` header:

```javascript
const event = mux.webhooks.verifyHeader(JSON.stringify(req.body), signature, MUX_WEBHOOK_SECRET);
```

## 7. Best Practices

1. **Error Handling**:
   - Implement robust error handling for all Mux API interactions
   - Store error messages in the database for debugging
   - Implement retry mechanisms for failed uploads

2. **Video Player Configuration**:
   - Use an adaptive streaming player that supports HLS
   - Configure appropriate buffer sizes for different network conditions
   - Implement quality selection options for users

3. **Monitoring and Analytics**:
   - Monitor video processing status and errors
   - Track user engagement with videos
   - Analyze video quality and performance metrics

## 8. Advanced Features

### 8.1. Thumbnail Generation

Mux automatically generates thumbnails for videos. You can access them using:

```
https://image.mux.com/{playbackId}/thumbnail.jpg?token={thumbnailToken}
```

You can also specify time and dimensions:

```
https://image.mux.com/{playbackId}/thumbnail.jpg?time=15&width=640&token={thumbnailToken}
```

### 8.2. Video Chapters with Storyboards

Mux generates storyboards for video scrubbing. Access them using:

```
https://image.mux.com/{playbackId}/storyboard.vtt?token={storyboardToken}
```

### 8.3. Download Options

Mux supports MP4 downloads if enabled during asset creation:

```javascript
const upload = await mux.video.uploads.create({
  new_asset_settings: {
    playback_policy: ['signed'],
    mp4_support: 'standard' // Enables MP4 downloads
  }
});
```

## 9. Troubleshooting

### 9.1. Common Issues

1. **Video Processing Errors**:
   - Check Mux dashboard for detailed error messages
   - Verify file format and encoding are supported by Mux
   - Check file size limits

2. **Playback Issues**:
   - Verify the video status is `READY`
   - Check JWT token expiration
   - Ensure the player supports HLS streaming

3. **Webhook Problems**:
   - Verify webhook URL is accessible from the internet
   - Check webhook signature verification
   - Monitor webhook logs for delivery issues

### 9.2. Debugging Tools

1. **Mux Dashboard**: View asset details, processing status, and errors
2. **Server Logs**: Check for API errors and webhook processing issues
3. **Browser Developer Tools**: Monitor network requests and player errors

## 10. Resources

- [Mux API Documentation](https://docs.mux.com/api-reference)
- [Mux Node.js SDK](https://github.com/muxinc/mux-node-sdk)
- [HLS.js Player](https://github.com/video-dev/hls.js/)
- [Video.js Player](https://videojs.com/)
- [Plyr Player](https://plyr.io/)