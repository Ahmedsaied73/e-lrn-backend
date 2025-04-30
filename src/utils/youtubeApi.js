const axios = require('axios');
const config = require('../config/env');
const { getAdvancedEmbedUrl } = require('./youtubePlayerUtils');

// Base URL for YouTube API requests
const BASE_URL = 'https://www.googleapis.com/youtube/v3';

/**
 * Utility functions for interacting with the YouTube API
 * To use this, you'll need a YouTube API key (https://developers.google.com/youtube/v3/getting-started)
 * Set the API key in your .env file: YOUTUBE_API_KEY=your_api_key
 */

/**
 * Get details of a YouTube playlist
 * @param {string} playlistId - The ID of the YouTube playlist
 * @returns {object} Playlist details including title, description, thumbnail
 */
async function getPlaylistDetails(playlistId) {
  try {
    // Debug logging - don't log the full API key for security, just check if it exists
    console.log('YouTube API Key exists:', !!config.youtube.apiKey);
    console.log('YouTube API Key type:', typeof config.youtube.apiKey);
    console.log('YouTube API Key length:', config.youtube.apiKey ? config.youtube.apiKey.length : 0);
    
    // Check if API key exists
    if (!config.youtube.apiKey) {
      throw new Error('YouTube API key not found. Please set YOUTUBE_API_KEY in your environment variables.');
    }
    
    // Check if the API key is still the placeholder (more flexible check)
    const apiKeyStr = String(config.youtube.apiKey).toLowerCase().trim();
    if (apiKeyStr.includes('your_youtube_api_key_here') || apiKeyStr === '') {
      throw new Error('Please replace the placeholder YouTube API key with a real YouTube API key in your .env file.');
    }

    const response = await axios.get(`${BASE_URL}/playlists`, {
      params: {
        part: 'snippet',
        id: playlistId,
        key: config.youtube.apiKey
      }
    });

    if (!response.data.items || response.data.items.length === 0) {
      throw new Error(`Playlist not found with ID: ${playlistId}. Please verify the playlist ID and make sure it's public or unlisted.`);
    }

    const playlist = response.data.items[0];
    const snippet = playlist.snippet;
    
    return {
      title: snippet.title,
      description: snippet.description,
      thumbnail: snippet.thumbnails.maxres?.url || 
                snippet.thumbnails.high?.url || 
                snippet.thumbnails.medium?.url || 
                snippet.thumbnails.default?.url
    };
  } catch (error) {
    // Enhanced error logging
    if (error.response) {
      // The request was made and the server responded with a status code outside of 2xx range
      console.error('YouTube API error:', {
        status: error.response.status,
        data: error.response.data
      });
      
      // Check for API key issues
      if (error.response.status === 400 || error.response.status === 403) {
        if (error.response.data.error && error.response.data.error.errors) {
          const apiErrors = error.response.data.error.errors;
          if (apiErrors.some(e => e.reason === 'keyInvalid')) {
            throw new Error('Invalid YouTube API key. Please check your API key in the .env file.');
          }
        }
      }
    }
    
    console.error('Error fetching playlist details:', error.message);
    throw error;
  }
}

/**
 * Get all videos from a YouTube playlist
 * @param {string} playlistId - The ID of the YouTube playlist
 * @returns {Array} Array of video objects with details
 */
async function getPlaylistVideos(playlistId) {
  try {
    // Check if API key exists
    if (!config.youtube.apiKey) {
      throw new Error('YouTube API key not found. Please set YOUTUBE_API_KEY in your environment variables.');
    }
    
    // Check if the API key is still the placeholder (more flexible check)
    const apiKeyStr = String(config.youtube.apiKey).toLowerCase().trim();
    if (apiKeyStr.includes('your_youtube_api_key_here') || apiKeyStr === '') {
      throw new Error('Please replace the placeholder YouTube API key with a real YouTube API key in your .env file.');
    }

    let videos = [];
    let nextPageToken = null;
    
    // Paginate through all playlist items
    do {
      const playlistResponse = await axios.get(`${BASE_URL}/playlistItems`, {
        params: {
          part: 'snippet,contentDetails',
          playlistId: playlistId,
          maxResults: 50, // Maximum allowed per request
          pageToken: nextPageToken,
          key: config.youtube.apiKey
        }
      });
      
      if (!playlistResponse.data.items || playlistResponse.data.items.length === 0) {
        break;
      }
      
      // Get video IDs for detailed video information
      const videoIds = playlistResponse.data.items.map(item => item.contentDetails.videoId).join(',');
      
      const videoResponse = await axios.get(`${BASE_URL}/videos`, {
        params: {
          part: 'snippet,contentDetails,statistics',
          id: videoIds,
          key: config.youtube.apiKey
        }
      });
      
      // Map video details with position in the playlist
      const videosWithPosition = playlistResponse.data.items.map((item, index) => {
        const position = index + videos.length + 1;
        const videoId = item.contentDetails.videoId;
        
        // Find detailed video info from the second response
        const videoDetails = videoResponse.data.items.find(v => v.id === videoId);
        
        if (!videoDetails) return null;
        
        return {
          title: videoDetails.snippet.title,
          description: videoDetails.snippet.description,
          thumbnail: videoDetails.snippet.thumbnails.maxres?.url || 
                     videoDetails.snippet.thumbnails.high?.url ||
                     videoDetails.snippet.thumbnails.medium?.url ||
                     videoDetails.snippet.thumbnails.default?.url,
          duration: parseDuration(videoDetails.contentDetails.duration),
          viewCount: videoDetails.statistics.viewCount,
          youtubeId: videoId,
          position: position
        };
      }).filter(Boolean); // Remove any null entries
      
      videos = [...videos, ...videosWithPosition];
      nextPageToken = playlistResponse.data.nextPageToken;
    } while (nextPageToken);
    
    return videos;
  } catch (error) {
    // Enhanced error logging
    if (error.response) {
      console.error('YouTube API error:', {
        status: error.response.status,
        data: error.response.data
      });
    }
    
    console.error('Error fetching playlist videos:', error.message);
    throw error;
  }
}

/**
 * Parse YouTube's duration format (ISO 8601) to seconds
 * @param {string} duration - Duration in ISO 8601 format (e.g., PT1H30M15S)
 * @returns {number} Duration in seconds
 */
function parseDuration(duration) {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Get a YouTube stream URL for embedding with HLS support
 * @param {string} videoId - The YouTube video ID
 * @param {Object} options - Options for the player
 * @returns {string} Embeddable YouTube URL
 */
function getYoutubeStreamUrl(videoId, options = {}) {
  // Default options for optimal HLS streaming experience
  const defaultOptions = {
    autoplay: 0,
    controls: 1, 
    showInfo: 1,
    modestBranding: 1,
    enableHLS: true,
    playbackQuality: 'hd720' // Default to HD quality
  };
  
  // Merge provided options with defaults
  const mergedOptions = { ...defaultOptions, ...options };
  
  // Use the advanced embed URL with HLS support
  return getAdvancedEmbedUrl(videoId, mergedOptions);
}

/**
 * Get raw HLS stream information from a YouTube video
 * Note: This is an advanced technique and may not be allowed by YouTube's terms of service
 * This is provided for educational purposes only.
 * 
 * @param {string} videoId - The YouTube video ID
 * @returns {Object} Information about available formats
 */
async function getHLSStreamInfo(videoId) {
  try {
    console.warn('WARNING: Directly accessing YouTube stream info may violate YouTube\'s Terms of Service');
    console.warn('It is recommended to use the iframe embed approach instead');
    
    // This is not officially supported and may break at any time
    const response = await axios.get(`https://www.youtube.com/get_video_info?video_id=${videoId}&el=embedded&ps=default&eurl=&gl=US&hl=en`);
    
    // Parse the response - this is simplified and may not work with YouTube's current API
    const decodedData = decodeURIComponent(response.data);
    const parsedData = new URLSearchParams(decodedData);
    const playerResponse = JSON.parse(parsedData.get('player_response') || '{}');
    
    if (!playerResponse.streamingData) {
      throw new Error('Unable to retrieve streaming data');
    }
    
    return {
      // HLS manifest URL (if available)
      hlsManifestUrl: playerResponse.streamingData.hlsManifestUrl,
      // Available formats
      formats: playerResponse.streamingData.formats,
      // Adaptive formats (different resolutions)
      adaptiveFormats: playerResponse.streamingData.adaptiveFormats
    };
  } catch (error) {
    console.error('Error getting HLS stream info:', error.message);
    throw new Error('Unable to get direct stream information. Use the embed URL instead.');
  }
}

module.exports = {
  getPlaylistDetails,
  getPlaylistVideos,
  parseDuration,
  getYoutubeStreamUrl,
  getHLSStreamInfo // This is for advanced users only
}; 