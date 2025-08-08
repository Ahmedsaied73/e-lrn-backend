# Mux Webhook Setup Guide

This guide explains how to set up and test Mux webhooks for the e-learning platform.

## Overview

Mux webhooks allow our application to receive real-time notifications about video processing events, such as when a video upload is complete, when processing is finished, or if errors occur. This enables us to update our database and provide users with accurate information about their video uploads.

## Prerequisites

- Mux account with API access
- API credentials (MUX_TOKEN_ID and MUX_TOKEN_SECRET)
- Webhook signing secret (MUX_WEBHOOK_SECRET)

## Configuration

### Environment Variables

Add the following to your `.env` file:

```
MUX_TOKEN_ID=your_token_id
MUX_TOKEN_SECRET=your_token_secret
MUX_WEBHOOK_SECRET=your_webhook_secret
```

### For Production

In production, the webhook URL will be automatically generated based on your domain:

```
https://your-domain.com/api/mux/webhooks
```

### For Development

For local development, you need to expose your local server to the internet using a tunneling service. Add this to your `.env` file:

```
DEV_TUNNEL_URL=https://your-tunnel-url
```

## Setting Up Tunneling for Local Development

You can use one of these tunneling tools:

### ngrok

```bash
ngrok http 3000  # Replace 3000 with your server port
```

After starting ngrok, it will display a forwarding URL like `https://abc123.ngrok.io`. Use this as your `DEV_TUNNEL_URL`.

### Localtunnel

```bash
npx localtunnel --port 3000  # Replace 3000 with your server port
```

## Using the Setup Utility

We've created a utility script to help you set up and test webhooks:

```bash
node scripts/setupMuxWebhook.js
```

This script will:

1. Check your Mux configuration
2. Help you test your webhook configuration
3. List existing webhooks
4. Create a new webhook

## Manual Setup in Mux Dashboard

1. Log in to your Mux dashboard
2. Go to Settings > Webhooks
3. Click "New Webhook"
4. Enter your webhook URL (production URL or tunnel URL for development)
5. Select the events you want to receive (at minimum: video.asset.ready, video.asset.errored, video.upload.asset_created)
6. Save the webhook
7. Copy the signing secret and add it to your `.env` file as `MUX_WEBHOOK_SECRET`

## Testing Webhooks

### Using the Mux Dashboard

1. Go to your webhook in the Mux dashboard
2. Click "Send test webhook"
3. Select an event type
4. Check your server logs to verify the webhook was received and processed

### Using the Setup Utility

Run the setup utility and select option 1 to test your webhook configuration:

```bash
node scripts/setupMuxWebhook.js
```

## Troubleshooting

### Webhook Not Receiving Events

- Verify your server is running and accessible at the webhook URL
- Check that the `MUX_WEBHOOK_SECRET` in your `.env` file matches the signing secret in the Mux dashboard
- Ensure your webhook URL is correctly configured in the Mux dashboard
- Check server logs for any errors in webhook processing

### Signature Verification Failed

If you see "Unauthorized" errors or signature verification failures:

- Double-check that your `MUX_WEBHOOK_SECRET` matches exactly with the secret in the Mux dashboard
- Ensure the webhook is being sent to the correct endpoint
- Verify that the request body is not being modified by middleware before reaching the webhook handler

## Supported Events

Our application currently handles these webhook events:

- `video.asset.ready`: When a video is ready for playback
- `video.asset.errored`: When video processing encounters an error
- `video.asset.deleted`: When a video asset is deleted
- `video.upload.asset_created`: When an upload is associated with a new asset

## Adding Support for New Events

To add support for new Mux webhook events:

1. Update the `supportedEvents` array in `src/config/muxConfig.js`
2. Add a handler function in `src/controllers/muxController.js`
3. Add a case for the new event type in the switch statement in the `handleMuxWebhook` function