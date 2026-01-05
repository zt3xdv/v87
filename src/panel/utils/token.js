import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let config;
try {
    config = require('../../../config.json');
} catch (e) {
    config = { secretKey: '' };
}

const SECRET_KEY = config.secretKey;
const TOKEN_EXPIRY_SECONDS = config.tokenExpiry || 86400 * 7; // 7 days default

if (!SECRET_KEY || SECRET_KEY.length < 32) {
    console.error('\x1b[31mWARNING: secretKey should be at least 32 characters for security\x1b[0m');
}

function generateToken(user) {
    const payload = {
        sub: user.id,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS,
        v: user.tokenVersion || 0
    };
    
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(`${header}.${body}`)
        .digest('base64url');
    
    return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [header, body, signature] = parts;
    
    const expectedSignature = crypto
        .createHmac('sha256', SECRET_KEY)
        .update(`${header}.${body}`)
        .digest('base64url');
    
    // Timing-safe comparison to prevent timing attacks
    if (!timingSafeEqual(signature, expectedSignature)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        
        // Check expiration
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
            return null;
        }
        
        // Check issued at (not in the future)
        if (payload.iat && payload.iat > Math.floor(Date.now() / 1000) + 60) {
            return null;
        }
        
        return {
            id: payload.sub,
            tokenVersion: payload.v || 0,
            iat: payload.iat,
            exp: payload.exp
        };
    } catch (e) {
        return null;
    }
}

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    
    if (bufA.length !== bufB.length) {
        // Still do comparison to maintain constant time
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    
    return crypto.timingSafeEqual(bufA, bufB);
}

function generateRefreshToken() {
    return crypto.randomBytes(32).toString('hex');
}

export { generateToken, verifyToken, generateRefreshToken };
