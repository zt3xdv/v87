import { verifyToken } from './token.js';

function requireAuth(req, res, next, admin = false) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const user = verifyToken(token);

    if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    if (!admin) next();
}

function requireAdmin(req, res, next) {
    // We should define req.user before require admin
    requireAuth(req, res, next, true);
    
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

export { requireAuth, requireAdmin };
