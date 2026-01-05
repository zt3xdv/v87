import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let config;
try {
    config = require('../../../config.json');
} catch (e) {
    // let server say it
    config = { secretKey: '' };
}

const SECRET_KEY = config.secretKey;
const TOKEN_EXPIRY_SECONDS = config.tokenExpiry || 86400 * 7; // 7 days default

function generateToken(user) {
    const payload = JSON.stringify({ 
        id: user.id, 
        username: user.username, 
        role: user.role || 'user',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS
    });
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
        const payload = JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
        
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
            return null;
        }
        
        return payload;
    } catch (e) {
        return null;
    }
}

export { generateToken, verifyToken };
