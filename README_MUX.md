# Mux Video Integration Guide

## Overview

This guide explains how to use Mux video integration in the e-learning platform. Mux provides video hosting, streaming, and processing capabilities that allow us to deliver high-quality video content to our users.

## Features

- **Direct uploads**: Upload videos directly from the browser to Mux
- **Adaptive streaming**: Videos automatically adapt to the viewer's connection speed
- **Webhook integration**: Receive real-time notifications about video processing status
- **Secure playback**: Control who can view your videos with signed URLs
- **Video analytics**: Track viewer engagement and performance metrics

## Setup

### Prerequisites

1. A Mux account (sign up at [mux.com](https://mux.com))
2. API access credentials (Token ID and Token Secret)
3. A webhook signing secret

### Environment Variables

Add the following to your `.env` file:

```
MUX_TOKEN_ID=your_token_id
MUX_TOKEN_SECRET=your_token_secret
MUX_WEBHOOK_SECRET=your_webhook_secret

# For development with tunneling
DEV_TUNNEL_URL=https://your-tunnel-url
```

## Architecture

The Mux integration consists of several components:

1. **Configuration** (`src/config/muxConfig.js`): Centralizes all Mux-related settings
2. **API Client** (`src/lib/mux.js`): Initializes the Mux SDK
3. **Controller** (`src/controllers/muxController.js`): Handles API endpoints and webhook events
4. **Routes** (`src/routes/muxRoutes.js`): Defines API routes for Mux functionality

## Video Upload Flow

1. Frontend requests a direct upload URL from `/api/mux/uploads`
2. Backend creates a Mux upload and returns the URL
3. Frontend uploads the video directly to Mux using the URL
4. Mux processes the video and sends webhook events
5. Backend updates the database based on webhook events

## Webhook Events

The platform handles these webhook events:

- `video.asset.ready`: When a video is ready for playback
- `video.asset.errored`: When video processing encounters an error
- `video.asset.deleted`: When a video asset is deleted
- `video.upload.asset_created`: When an upload is associated with a new asset

## Development Tools

We provide several tools to help with development and testing:

### Setup Utility

```bash
node scripts/setupMuxWebhook.js
```

This utility helps you:
- Check your Mux configuration
- Test your webhook setup
- List existing webhooks
- Create new webhooks

### Webhook Test Script

```bash
node scripts/testMuxWebhook.js [event_type]
```

This script simulates a Mux webhook event to test your webhook handler. You can specify an event type as an argument (defaults to `video.asset.ready`).

## Local Development with Webhooks

To receive webhooks during local development, you need to expose your local server to the internet using a tunneling service:

### Using ngrok

```bash
ngrok http 3005
```

After starting ngrok, update your `.env` file:

```
DEV_TUNNEL_URL=https://your-ngrok-url
```

### Using localtunnel

```bash
npx localtunnel --port 3005
```

Then update your `.env` file with the provided URL.

## Troubleshooting

### Common Issues

1. **Webhook verification fails**
   - Ensure `MUX_WEBHOOK_SECRET` matches the secret in the Mux dashboard
   - Check that the webhook URL is correctly configured

2. **Videos not appearing after upload**
   - Check server logs for webhook processing errors
   - Verify that the webhook URL is accessible from the internet
   - Test with the webhook test script

3. **Playback issues**
   - Check that the video asset is in the "ready" state
   - Verify that the playback policy is correctly set
   - Check for browser console errors

## Resources

- [Mux API Documentation](https://docs.mux.com/api-reference)
- [Mux Node.js SDK](https://github.com/muxinc/mux-node-sdk)
- [Webhook Setup Guide](./docs/MUX_WEBHOOK_SETUP.md)

## Extending the Integration

### Adding Support for New Events

1. Add the event type to `supportedEvents` in `src/config/muxConfig.js`
2. Create a handler function in `src/controllers/muxController.js`
3. Add a case for the new event in the switch statement in `handleMuxWebhook`

### Customizing Upload Settings

Modify the `defaultDirectUploadOptions` in `src/config/muxConfig.js` to change default upload settings.

### Adding Analytics

Mux provides detailed analytics through their dashboard and API. To integrate analytics:

1. Use the Mux Data API to fetch viewer metrics
2. Create endpoints to expose these metrics to your frontend
3. Build dashboards to visualize the data