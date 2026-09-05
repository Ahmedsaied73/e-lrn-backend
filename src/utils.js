const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

// JWT 'type' claim distinguishes access vs refresh tokens so a stolen refresh
// token can never authenticate API routes (middleware rejects type !== 'access').
function createToken(payload, secret, expiresIn = '1h') {
    return jwt.sign({ ...payload, type: 'access' }, secret, { expiresIn });
}
// Refresh token with a 7-day expiration and an explicit 'refresh' type claim.
// The random jti guarantees every issued refresh token is unique — without it,
// two signings within the same second yield identical tokens (same iat), which
// silently defeats token rotation (a rotated token would equal the old one).
function createRefreshToken(payload, secret, expiresIn = '7d') {
    return jwt.sign({ ...payload, type: 'refresh', jti: randomUUID() }, secret, { expiresIn });
}

module.exports = {
    createToken,
    createRefreshToken
};