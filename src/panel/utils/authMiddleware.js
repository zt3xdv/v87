import { verifyToken } from './token.js';
import db from '../db.js';

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const tokenData = verifyToken(token);

    if (!tokenData) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Fetch fresh user data from database
    const user = db.findUserById(tokenData.id);
    
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    
    // Check if token was invalidated (token version mismatch)
    if ((user.tokenVersion || 0) !== tokenData.tokenVersion) {
        return res.status(401).json({ error: 'Token has been revoked' });
    }
    
    // Check if user is suspended
    if (user.suspended) {
        return res.status(403).json({ error: 'Account suspended: ' + (user.suspendReason || 'Contact administrator') });
    }

    // Set minimal user info on request (role comes from DB, not token)
    req.user = {
        id: user.id,
        username: user.username,
        role: user.role || 'user'
    };
    
    next();
}

function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const tokenData = verifyToken(token);

    if (!tokenData) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = db.findUserById(tokenData.id);
    
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    
    if ((user.tokenVersion || 0) !== tokenData.tokenVersion) {
        return res.status(401).json({ error: 'Token has been revoked' });
    }
    
    if (user.suspended) {
        return res.status(403).json({ error: 'Account suspended' });
    }
    
    // Check admin role from database
    if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }

    req.user = {
        id: user.id,
        username: user.username,
        role: user.role
    };
    
    next();
}

// Invalidate all tokens for a user by incrementing their tokenVersion
function invalidateUserTokens(userId) {
    const user = db.findUserById(userId);
    if (user) {
        const newVersion = (user.tokenVersion || 0) + 1;
        db.updateUser(userId, { tokenVersion: newVersion });
        return newVersion;
    }
    return null;
}

export { requireAuth, requireAdmin, invalidateUserTokens };
