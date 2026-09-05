const jwt = require('jsonwebtoken');
// Function to create a JWT
function createToken(payload, secret, expiresIn = '1h') {
    return jwt.sign(payload, secret, { expiresIn });
}
// Function to create a refresh token with a 7-day expiration
function createRefreshToken(payload, secret) {
    return createToken(payload, secret, '7d');
}

module.exports = {
    createToken,
    createRefreshToken
};