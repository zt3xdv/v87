import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { generateToken, verifyToken } from '../utils/token.js';
import { requireAuth, requireAdmin, invalidateUserTokens } from '../utils/authMiddleware.js';
import { rateLimit } from '../utils/rateLimit.js';
import { log } from '../utils/logger.js';

export function setupAuthRoutes(app, db, config) {
    const DATA_DIR = path.join(import.meta.dirname, '../../../data');

    function audit(userId, username, action, data = {}) {
        db.addAuditLog({ userId, username, action, ...data, createdAt: new Date().toISOString() });
    }

    function generateApiKey() {
        return 'v87_' + crypto.randomBytes(32).toString('hex');
    }

    // =====================
    // AUTH ROUTES
    // =====================

    app.get('/api/me', requireAuth, (req, res) => {
        res.json({ user: req.user });
    });

    app.post('/api/login', (req, res) => {
        const { username, password } = req.body;
        const ip = req.ip || req.connection.remoteAddress || 'unknown';

        const ipLimit = rateLimit(`login:ip:${ip}`, 5, 15 * 60 * 1000);
        if (!ipLimit.allowed) {
            const retryAfter = Math.ceil((ipLimit.resetAt - Date.now()) / 1000);
            res.set('Retry-After', retryAfter);
            return res.status(429).json({ 
                error: 'Too many login attempts. Try again later.',
                retryAfter 
            });
        }

        if (username) {
            const userLimit = rateLimit(`login:user:${username}`, 10, 15 * 60 * 1000);
            if (!userLimit.allowed) {
                const retryAfter = Math.ceil((userLimit.resetAt - Date.now()) / 1000);
                res.set('Retry-After', retryAfter);
                return res.status(429).json({ 
                    error: 'Too many login attempts for this account. Try again later.',
                    retryAfter 
                });
            }
        }

        const user = db.findUser(username);
        if (user && bcrypt.compareSync(password, user.password)) {
            if (user.suspended) {
                audit(user.id, username, 'login_failed_suspended');
                return res.status(403).json({ error: 'Account suspended: ' + (user.suspendReason || 'Contact administrator') });
            }
            audit(user.id, username, 'login');
            const token = generateToken(user);
            res.json({ success: true, user: { id: user.id, username: user.username, role: user.role }, token });
        } else {
            audit(null, username || 'unknown', 'login_failed');
            res.status(401).json({ error: 'Invalid credentials' });
        }
    });

    app.post('/api/register', (req, res) => {
        const settings = db.getSettings();
        const isFirstUser = db.getUsers().length === 0;

        if (settings.registrationDisabled && !isFirstUser) {
            return res.status(403).json({ error: 'Registration is currently disabled' });
        }

        const ip = req.ip || req.connection.remoteAddress || 'unknown';

        const limit = rateLimit(`register:${ip}`, 3, 60 * 60 * 1000);
        if (!limit.allowed) {
            const retryAfter = Math.ceil((limit.resetAt - Date.now()) / 1000);
            res.set('Retry-After', retryAfter);
            return res.status(429).json({ 
                error: 'Too many registration attempts. Try again later.',
                retryAfter 
            });
        }

        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
        if (username.length < 3 || username.length > 32) {
            return res.status(400).json({ error: 'Username must be 3-32 characters' });
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
            return res.status(400).json({ error: 'Username can only contain letters, numbers, _ and -' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        if (db.findUser(username)) {
            return res.status(400).json({ error: 'Username taken' });
        }

        const hashedPassword = bcrypt.hashSync(password, 10);

        let user = {
            id: Date.now().toString(),
            username,
            password: hashedPassword,
            role: 'user',
            created_at: new Date()
        };

        if (isFirstUser) {
            const created = db.createFirstAdmin(user);
            if (created) {
                user = created;
            } else {
                db.createUser(user);
            }
        } else {
            db.createUser(user);
        }

        fs.ensureDirSync(path.join(DATA_DIR, 'users', user.id));
        audit(user.id, user.username, 'register', { role: user.role });

        const token = generateToken(user);
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role }, token });
    });

    app.post('/api/logout', requireAuth, (req, res) => {
        invalidateUserTokens(req.user.id);
        audit(req.user.id, req.user.username, 'logout');
        res.json({ success: true });
    });

    app.post('/api/revoke-tokens', requireAuth, (req, res) => {
        invalidateUserTokens(req.user.id);
        audit(req.user.id, req.user.username, 'tokens_revoked');
        res.json({ success: true, message: 'All sessions have been logged out' });
    });

    app.post('/api/change-password', requireAuth, (req, res) => {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        const user = db.findUserById(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!bcrypt.compareSync(currentPassword, user.password)) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        db.updateUser(req.user.id, { password: hashedPassword });

        invalidateUserTokens(req.user.id);
        audit(req.user.id, req.user.username, 'password_changed');

        res.json({ success: true, message: 'Password changed. Please log in again.' });
    });

    // =====================
    // API KEYS
    // =====================

    app.get('/api/keys', requireAuth, (req, res) => {
        const keys = db.getApiKeys(req.user.id).map(k => ({
            id: k.id,
            name: k.name,
            prefix: k.key.substring(0, 8) + '...',
            createdAt: k.createdAt,
            lastUsed: k.lastUsed,
            permissions: k.permissions
        }));
        res.json({ keys });
    });

    app.post('/api/keys', requireAuth, (req, res) => {
        const { name, permissions } = req.body;

        const userKeys = db.getApiKeys(req.user.id);
        if (userKeys.length >= 5) {
            return res.status(400).json({ error: 'Maximum 5 API keys allowed' });
        }

        const key = generateApiKey();
        const apiKey = {
            id: Date.now().toString(),
            userId: req.user.id,
            name: name || 'API Key',
            key,
            permissions: permissions || ['read'],
            createdAt: new Date().toISOString(),
            lastUsed: null
        };

        db.createApiKey(apiKey);
        audit(req.user.id, req.user.username, 'api_key_created', { keyName: name });

        res.json({ success: true, key, id: apiKey.id });
    });

    app.delete('/api/keys/:id', requireAuth, (req, res) => {
        db.deleteApiKey(req.params.id, req.user.id);
        audit(req.user.id, req.user.username, 'api_key_deleted', { keyId: req.params.id });
        res.json({ success: true });
    });
}
