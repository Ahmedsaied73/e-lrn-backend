const jwt = require('jsonwebtoken');
const { createHash, randomUUID } = require('crypto');

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

// SHA-256 hash of a refresh token. The DB stores ONLY this hash (never the raw
// JWT), so a database leak cannot be replayed against the refresh endpoint.
// 64-char hex strings are unambiguous on the read side, which lets the refresh
// handler transparently upgrade legacy plaintext rows on their next rotation.
function hashRefreshToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

// A refresh-token "family" groups a user's rotated refresh tokens so a replayed
// (already-rotated) token can be detected and the whole family revoked.
function createRefreshTokenFamily() {
    return randomUUID();
}

module.exports = {
    createToken,
    createRefreshToken,
    hashRefreshToken,
    createRefreshTokenFamily
};