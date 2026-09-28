/**
 * YouTube Player Utilities
 * 
 * This file contains functions for different methods of streaming and
 * embedding YouTube videos in your application.
 */

/**
 * Basic YouTube Embed URL
 * 
 * This is the simplest approach - generates a standard embed URL for an iframe
 * 
 * @param {string} videoId - The YouTube video ID
 * @param {Object} options - Optional parameters
 * @returns {string} YouTube embed URL
 */
function getBasicEmbedUrl(videoId, options = {}) {
  const {
    autoplay = 0,
    controls = 1,
    showInfo = 1,
    start = 0,
    enableHLS = true
  } = options;
  
  // Base URL for embedding
  let url = `https://www.youtube.com/embed/${videoId}?`;
  
  // Add parameters
  const params = [
    `autoplay=${autoplay ? 1 : 0}`,
    `controls=${controls ? 1 : 0}`,
    `showinfo=${showInfo ? 1 : 0}`,
    `start=${start}`,
    `rel=0` // Don't show related videos
  ];
  
  // Add HLS specific parameters
  if (enableHLS) {
    params.push('html5=1'); // Force HTML5 player which uses HLS
  }
  
  return url + params.join('&');
}

/**
 * Advanced YouTube Embed with custom parameters
 * 
 * This provides more control over the player appearance and behavior
 * 
 * @param {string} videoId - The YouTube video ID
 * @param {Object} options - Customization options
 * @returns {string} YouTube embed URL with parameters
 */
function getAdvancedEmbedUrl(videoId, options = {}) {
  const {
    autoplay = 0,
    controls = 1,
    showInfo = 1,
    loop = 0,
    modestBranding = 1,
    start = 0,
    end = 0,
    mute = 0,
    enableHLS = true,
    playbackQuality = 'default', // Can be: small, medium, large, hd720, hd1080, highres, default
    playbackRate = 1,
    showCaptions = 0,
    disableKeyboard = 0
  } = options;
  
  // Base URL for embedding
  let url = `https://www.youtube.com/embed/${videoId}?`;
  
  // Build parameters list
  const params = [
    `autoplay=${autoplay ? 1 : 0}`,
    `controls=${controls ? 1 : 0}`,
    `showinfo=${showInfo ? 1 : 0}`,
    `loop=${loop ? 1 : 0}`,
    `modestbranding=${modestBranding ? 1 : 0}`,
    `rel=0`,
    `mute=${mute ? 1 : 0}`
  ];
  
  // Add optional start and end times
  if (start > 0) params.push(`start=${start}`);
  if (end > 0) params.push(`end=${end}`);
  
  // Add HLS specific parameters
  if (enableHLS) {
    params.push('html5=1'); // Force HTML5 player which uses HLS
    
    // Only add these parameters if HLS is enabled
    if (playbackQuality !== 'default') {
      params.push(`vq=${playbackQuality}`);
    }
    params.push(`playbackRate=${playbackRate}`);
    
    if (showCaptions) {
      params.push('cc_load_policy=1');
    }
    
    if (disableKeyboard) {
      params.push('disablekb=1');
    }
  }
  
  return url + params.join('&');
}

/**
 * Generate client-side YouTube Player setup code
 * 
 * Returns JavaScript code to include in your front-end for more
 * programmatic control over the YouTube player.
 * 
 * Note: The client needs to also include the YouTube IFrame API:
 * <script src="https://www.youtube.com/iframe_api"></script>
 * 
 * @param {string} containerId - The HTML element ID where the player will be embedded
 * @param {string} videoId - The YouTube video ID
 * @returns {string} JavaScript code to initialize the YouTube player
 */
function generatePlayerScript(containerId, videoId) {
  return `
// This code should be included in your client-side JavaScript
let player;

// This function is called when the YouTube IFrame API is ready
function onYouTubeIframeAPIReady() {
  player = new YT.Player('${containerId}', {
    videoId: '${videoId}',
    playerVars: {
      'autoplay': 0,
      'controls': 1,
      'rel': 0,
      'modestbranding': 1,
      'html5': 1 // Enables HLS streaming
    },
    events: {
      'onReady': onPlayerReady,
      'onStateChange': onPlayerStateChange
    }
  });
}

// This function is called when the player is ready
function onPlayerReady(event) {
  // You can add custom logic here
  // For example, event.target.playVideo();
}

// This function is called when the player state changes
function onPlayerStateChange(event) {
  // You can track player states:
  // -1: unstarted
  // 0: ended
  // 1: playing
  // 2: paused
  // 3: buffering
  // 5: video cued
}

// Example of controlling the player programmatically
function playVideo() {
  player.playVideo();
}

function pauseVideo() {
  player.pauseVideo();
}

function seekTo(seconds) {
  player.seekTo(seconds, true);
}

function changeQuality(quality) {
  // quality can be: small, medium, large, hd720, hd1080, highres, default
  player.setPlaybackQuality(quality);
}
`;
}

/**
 * Generate HTML for embedding a YouTube player
 * 
 * @param {string} videoId - The YouTube video ID
 * @param {Object} options - Player options
 * @returns {string} HTML code to embed the player
 */
function generatePlayerHTML(videoId, options = {}) {
  const {
    width = 640,
    height = 360,
    containerId = 'youtube-player',
    useAPI = false
  } = options;
  
  if (useAPI) {
    // If using the IFrame API, return container only
    return `
<div id="${containerId}" style="width: ${width}px; height: ${height}px;"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<!-- Include your custom scripts that call the functions from generatePlayerScript() -->
`;
  } else {
    // Simple iframe embedding
    const embedUrl = getAdvancedEmbedUrl(videoId, options);
    return `
<iframe 
  width="${width}" 
  height="${height}" 
  src="${embedUrl}" 
  frameborder="0" 
  allowfullscreen
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
></iframe>
`;
  }
}

module.exports = {
  getBasicEmbedUrl,
  getAdvancedEmbedUrl,
  generatePlayerScript,
  generatePlayerHTML
}; 