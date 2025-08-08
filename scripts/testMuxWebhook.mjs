/**
 * Mux Webhook Test Script
 * 
 * This script simulates a Mux webhook event to test the webhook handler.
 * It creates a signed webhook payload and sends it to the local webhook endpoint.
 */

import 'dotenv/config';
import crypto from 'crypto';
import axios from 'axios';
import muxConfig from '../src/config/muxConfig.js';

// Check if webhook secret is configured
if (!muxConfig.credentials.webhookSecret) {
  console.error('Error: MUX_WEBHOOK_SECRET is not configured in .env file');
  process.exit(1);
}

// Get webhook URL from config or use localhost
const webhookUrl = process.env.TEST_WEBHOOK_URL || 'http://localhost:3005/api/mux/webhooks';

// Create a sample webhook payload
const createSamplePayload = (eventType) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const assetId = `asset_${crypto.randomBytes(8).toString('hex')}`;
  
  switch (eventType) {
    case 'video.asset.ready':
      return {
        type: eventType,
        object: {
          type: 'asset',
          id: assetId
        },
        data: {
          id: assetId,
          status: 'ready',
          playback_ids: [{
            id: `playback_${crypto.randomBytes(8).toString('hex')}`,
            policy: 'signed'
          }],
          duration: 120.5,
          aspect_ratio: '16:9',
          created_at: new Date().toISOString()
        },
        created_at: timestamp.toString()
      };
      
    case 'video.asset.errored':
      return {
        type: eventType,
        object: {
          type: 'asset',
          id: assetId
        },
        data: {
          id: assetId,
          status: 'errored',
          errors: {
            type: 'invalid_file',
            message: 'The file could not be processed'
          },
          created_at: new Date().toISOString()
        },
        created_at: timestamp.toString()
      };
      
    case 'video.upload.asset_created':
      return {
        type: eventType,
        object: {
          type: 'upload',
          id: `upload_${crypto.randomBytes(8).toString('hex')}`
        },
        data: {
          id: `upload_${crypto.randomBytes(8).toString('hex')}`,
          asset_id: assetId,
          status: 'asset_created',
          created_at: new Date().toISOString()
        },
        created_at: timestamp.toString()
      };
      
    default:
      return {
        type: eventType,
        object: {
          type: 'asset',
          id: assetId
        },
        data: {
          id: assetId,
          created_at: new Date().toISOString()
        },
        created_at: timestamp.toString()
      };
  }
};

// Create a signed webhook payload
const createSignedWebhook = (payload) => {
  const jsonPayload = JSON.stringify(payload);
  const signature = crypto
    .createHmac('sha256', muxConfig.credentials.webhookSecret)
    .update(jsonPayload)
    .digest('hex');
  
  return {
    payload: jsonPayload,
    signature: `t=1,v1=${signature}`
  };
};

// Send the webhook to the local endpoint
const sendWebhook = async (eventType) => {
  try {
    console.log(`Sending test webhook for event: ${eventType}`);
    
    const payload = createSamplePayload(eventType);
    const { payload: jsonPayload, signature } = createSignedWebhook(payload);
    
    console.log('Webhook payload:', JSON.parse(jsonPayload));
    console.log('Signature:', signature);
    console.log(`Sending to: ${webhookUrl}`);
    
    const response = await axios.post(webhookUrl, JSON.parse(jsonPayload), {
      headers: {
        'Content-Type': 'application/json',
        'mux-signature': signature
      }
    });
    
    console.log('Response status:', response.status);
    console.log('Response data:', response.data);
    console.log('Webhook test completed successfully!');
    
    return response;
  } catch (error) {
    console.error('Error sending webhook:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
};

// Main function
const main = async () => {
  // Get event type from command line arguments or use default
  const eventType = process.argv[2] || 'video.asset.ready';
  
  // Check if event type is supported
  if (!muxConfig.webhooks.supportedEvents.includes(eventType)) {
    console.warn(`Warning: Event type '${eventType}' is not in the list of supported events.`);
    console.warn(`Supported events: ${muxConfig.webhooks.supportedEvents.join(', ')}`);
    console.warn('Continuing anyway for testing purposes...');
  }
  
  try {
    await sendWebhook(eventType);
  } catch (error) {
    console.error('Test failed!');
    process.exit(1);
  }
};

// Run the main function
main();