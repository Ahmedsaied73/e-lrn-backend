const jwt = require('jsonwebtoken');
// Function to create a JWT
function createToken(payload, secret, expiresIn = '1h') {
    return jwt.sign(payload, secret, { expiresIn });
}
// Function to create a refresh token with a 7-day expiration
function createRefreshToken(payload, secret) {
    return createToken(payload, secret, '7d');
}

// Function to get cookie configuration based on environment
function getCookieConfig(isRefreshToken = false) {
    // Check if we're in production mode
    const isProduction = process.env.NODE_ENV === 'production';
    
    // Base cookie configuration
    const cookieConfig = {
        httpOnly: true,
        sameSite: 'strict',
        // Only set secure: true in production
        secure: isProduction,
        // Set appropriate expiry time
        maxAge: isRefreshToken 
            ? 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds for refresh token
            : 60 * 60 * 1000 // 1 hour in milliseconds for access token
    };
    
    return cookieConfig;
}

module.exports = {
    createToken,
    createRefreshToken,
    getCookieConfig
};