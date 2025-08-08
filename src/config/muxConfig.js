/**
 * Mux Configuration Utility
 * 
 * This module provides a centralized configuration for Mux integration,
 * making it easier to manage and update webhook settings.
 */

const path = require('path');

// Load environment variables
const {
  MUX_TOKEN_ID,
  MUX_TOKEN_SECRET,
  MUX_WEBHOOK_SECRET,
  NODE_ENV
} = process.env;

// Base URL configuration for webhooks
const getWebhookBaseUrl = () => {
  // For production, use the actual domain
  if (NODE_ENV === 'production') {
    return process.env.APP_URL || 'https://your-production-domain.com';
  }
  
  // For development, check if a tunnel URL is configured
  if (process.env.DEV_TUNNEL_URL) {
    return process.env.DEV_TUNNEL_URL;
  }
  
  // Default fallback for local development
  return 'http://localhost:3005';
};

// Webhook path configuration
const WEBHOOK_PATH = '/api/mux/webhooks';

// Export configuration
module.exports = {
  // Credentials
  credentials: {
    tokenId: MUX_TOKEN_ID,
    tokenSecret: MUX_TOKEN_SECRET,
    webhookSecret: MUX_WEBHOOK_SECRET
  },
  
  // Webhook configuration
  webhooks: {
    // Get the full webhook URL
    getWebhookUrl: () => `${getWebhookBaseUrl()}${WEBHOOK_PATH}`,
    
    // Path where webhooks are received
    path: WEBHOOK_PATH,
    
    // Supported webhook event types
    supportedEvents: [
      'video.asset.ready',
      'video.asset.errored',
      'video.asset.deleted',
      'video.upload.asset_created'
    ]
  },
  
  // Upload configuration
  uploads: {
    // Default settings for direct uploads
    defaultDirectUploadOptions: {
      cors_origin: NODE_ENV !== 'production' ? '*' : undefined,
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard'
      }
    }
  },
  
  // Helper to check if all required environment variables are set
  isConfigured: () => {
    return !!MUX_TOKEN_ID && !!MUX_TOKEN_SECRET && !!MUX_WEBHOOK_SECRET;
  },
  
  // Development helpers
  isDevelopment: NODE_ENV !== 'production',
  
  // Instructions for setting up tunneling in development
  developmentInstructions: {
    ngrok: 'ngrok http 3005',
    localtunnel: 'npx localtunnel --port 3005',
    cloudflared: 'cloudflared tunnel --url http://localhost:3005'
  }
};