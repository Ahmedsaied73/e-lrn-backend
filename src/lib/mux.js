const Mux = require('@mux/mux-node');
const muxConfig = require('../config/muxConfig');

// Initialize Mux with API credentials from configuration
const { tokenId, tokenSecret } = muxConfig.credentials;

// Check if Mux is properly configured
if (!muxConfig.isConfigured()) {
  throw new Error('Mux environment variables not set. Please check your .env file.');
}

// Initialize Mux client
const mux = new Mux(tokenId, tokenSecret);

module.exports = mux;