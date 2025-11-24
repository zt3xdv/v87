const crypto = require('crypto');
const path = require('path');

let config;
try {
    config = require('../../config.json');
} catch (e) {
    // Fallback if config doesn't exist or is invalid
    config = { secretKey: 'v87-fallback-secret' };
    console.warn('Warning: config.json not found or invalid, using fallback secret.');
}

const SECRET_KEY = config.secretKey;

function generateToken(user) {
    const payload = JSON.stringify({ id: user.id, username: user.username, role: user.role || 'user' });
    const base64Payload = Buffer.from(payload).toString('base64');
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(base64Payload).digest('hex');
    return `${base64Payload}.${signature}`;
}

function verifyToken(token) {
    if (!token) return null;
    const [base64Payload, signature] = token.split('.');
    if (!base64Payload || !signature) return null;

    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(base64Payload).digest('hex');
    if (signature !== expectedSignature) return null;

    try {
        return JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
    } catch (e) {
        return null;
    }
}

module.exports = { generateToken, verifyToken };
