const jwt = require('jsonwebtoken');

// JWT 'type' claim distinguishes access vs refresh tokens so a stolen refresh
// token can never authenticate API routes (middleware rejects type !== 'access').
function createToken(payload, secret, expiresIn = '1h') {
    return jwt.sign({ ...payload, type: 'access' }, secret, { expiresIn });
}
// Refresh token with a 7-day expiration and an explicit 'refresh' type claim
function createRefreshToken(payload, secret, expiresIn = '7d') {
    return jwt.sign({ ...payload, type: 'refresh' }, secret, { expiresIn });
}

module.exports = {
    createToken,
    createRefreshToken
};