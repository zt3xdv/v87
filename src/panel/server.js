import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'fs-extra';
import db from './db.js';
import os from 'os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { generateToken, verifyToken } from './utils/token.js';
import { requireAuth, requireAdmin, invalidateUserTokens } from './utils/authMiddleware.js';
import { NodeManager } from './utils/node-client.js';
import { getImages, getImage } from './utils/images.js';

const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

const symbols = {
    info: `${c.blue}●${c.reset}`,
    success: `${c.green}✓${c.reset}`,
    warn: `${c.yellow}⚠${c.reset}`,
    error: `${c.red}✗${c.reset}`,
    arrow: `${c.cyan}→${c.reset}`
};

function getTimestamp() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(message, type = 'info') {
    console.log(`  ${c.dim}${getTimestamp()}${c.reset}  ${symbols[type] || symbols.info}  ${message}`);
}

function logSuccess(message) { log(message, 'success'); }
function logWarn(message) { log(message, 'warn'); }
function logError(message) { log(message, 'error'); }

// Rate limiting store
const rateLimitStore = new Map();

function rateLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const record = rateLimitStore.get(key) || { attempts: 0, resetAt: now + windowMs };
    
    if (now > record.resetAt) {
        record.attempts = 0;
        record.resetAt = now + windowMs;
    }
    
    record.attempts++;
    rateLimitStore.set(key, record);
    
    return {
        allowed: record.attempts <= maxAttempts,
        remaining: Math.max(0, maxAttempts - record.attempts),
        resetAt: record.resetAt
    };
}

// Clean up rate limit store every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of rateLimitStore) {
        if (now > record.resetAt + 60000) {
            rateLimitStore.delete(key);
        }
    }
}, 300000);

let config;
try {
    config = require('../../config.json');
} catch (e) {
    logError('config.json not found');
    process.exit(1);
}

if (config.secretKey === 'v87-change-me-in-prod') {
    logWarn('Using default secretKey! Change it in config.json for production');
}

const nodeManager = new NodeManager();

function initializeNodes() {
    const nodes = db.getNodes();
    for (const node of nodes) {
        if (node.enabled) {
            nodeManager.addNode({
                id: node.id,
                url: node.url,
                secret: node.secret
            });
            log(`Connecting to node ${c.cyan}${node.name}${c.reset}`);
        }
    }
}

nodeManager.on('node-connected', (nodeId) => {
    const node = db.getNode(nodeId);
    logSuccess(`Node connected: ${c.cyan}${node?.name || nodeId}${c.reset}`);
    db.updateNode(nodeId, { lastSeen: new Date().toISOString(), status: 'online' });
});

nodeManager.on('node-disconnected', (nodeId) => {
    const node = db.getNode(nodeId);
    logWarn(`Node disconnected: ${c.yellow}${node?.name || nodeId}${c.reset}`);
    db.updateNode(nodeId, { status: 'offline' });
});

nodeManager.on('node-error', (nodeId, err) => {
    logError(`Node ${c.red}${nodeId}${c.reset}: ${err.message}`);
});

nodeManager.on('vm-output', (nodeId, serverId, data) => {
    io.to(`server:${serverId}`).emit('term-data', data);
});

nodeManager.on('vm-status', (nodeId, serverId, status) => {
    io.to(`server:${serverId}`).emit('vm-status', status === 'running' ? 'started' : 'stopped');
    db.updateServer(serverId, { status: status === 'running' ? 'running' : 'stopped' });
});

const DATA_DIR = path.join(__dirname, '../../data');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error('Authentication required'));
    }
    
    const user = verifyToken(token);
    if (!user) {
        return next(new Error('Invalid token'));
    }
    
    socket.user = user;
    next();
});

const VALID_ID_REGEX = /^[A-Za-z0-9_-]+$/;
function isValidId(id) {
    return typeof id === 'string' && VALID_ID_REGEX.test(id) && id.length > 0 && id.length <= 64;
}

// Track viewers per server for subscription management (bandwidth optimization)
const serverViewerCount = new Map(); // serverId -> { count, nodeId }

io.on('connection', (socket) => {
    // Track which servers this socket is viewing
    socket.viewingServers = new Set();

    socket.on('join-server', async (serverId) => {
        if (!isValidId(serverId)) return;
        
        const serverData = db.getServer(serverId);
        if (!serverData) return;
        
        if (serverData.ownerId !== socket.user.id && socket.user.role !== 'admin') {
            return socket.emit('error', 'Access denied');
        }
        
        socket.join(`server:${serverId}`);
        socket.viewingServers.add(serverId);
        
        if (!serverData.nodeId) {
            return socket.emit('error', 'Server has no node assigned');
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        
        // Subscribe to vm-output if this is the first viewer
        if (client && client.isConnected()) {
            const viewerInfo = serverViewerCount.get(serverId) || { count: 0, nodeId: serverData.nodeId };
            if (viewerInfo.count === 0) {
                try {
                    await client.subscribeVmOutput(serverId);
                } catch (e) {
                    log(`subscribeVmOutput failed: ${e.message}`);
                }
            }
            viewerInfo.count++;
            viewerInfo.nodeId = serverData.nodeId;
            serverViewerCount.set(serverId, viewerInfo);
        }
        
        let status = 'stopped';
        if (client && client.isConnected()) {
            try {
                const vmStatus = await client.getVMStatus(serverId);
                status = vmStatus.status || 'stopped';
            } catch {}
        } else {
            status = 'offline';
        }
        socket.emit('vm-status', status === 'running' ? 'started' : 'stopped');
    });
    
    socket.on('input', async (data) => {
        if (!data || typeof data !== 'object') return;
        const { serverId, data: inputData } = data;
        
        if (!isValidId(serverId)) return;
        if (typeof inputData !== 'string' || inputData.length > 8192) return;
        
        const serverData = db.getServer(serverId);
        if (!serverData || !serverData.nodeId) return;
        
        if (serverData.ownerId !== socket.user.id && socket.user.role !== 'admin') {
            return;
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (client && client.isConnected()) {
            client.sendVMInput(serverId, inputData);
        }
    });
    
    socket.on('leave-server', (serverId) => {
        if (!isValidId(serverId)) return;
        socket.leave(`server:${serverId}`);
        socket.viewingServers.delete(serverId);
        
        // Unsubscribe if no more viewers
        const viewerInfo = serverViewerCount.get(serverId);
        if (viewerInfo) {
            viewerInfo.count = Math.max(0, viewerInfo.count - 1);
            if (viewerInfo.count === 0) {
                const client = nodeManager.getClient(viewerInfo.nodeId);
                if (client && client.isConnected()) {
                    client.unsubscribeVmOutput(serverId).catch(() => {});
                }
                serverViewerCount.delete(serverId);
            }
        }
    });
    
    socket.on('disconnect', () => {
        // Clean up all subscriptions for this socket
        for (const serverId of socket.viewingServers) {
            const viewerInfo = serverViewerCount.get(serverId);
            if (viewerInfo) {
                viewerInfo.count = Math.max(0, viewerInfo.count - 1);
                if (viewerInfo.count === 0) {
                    const client = nodeManager.getClient(viewerInfo.nodeId);
                    if (client && client.isConnected()) {
                        client.unsubscribeVmOutput(serverId).catch(() => {});
                    }
                    serverViewerCount.delete(serverId);
                }
            }
        }
    });
});

// VNC WebSocket proxy
io.of('/vnc').use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error('Authentication required'));
    }
    
    const user = verifyToken(token);
    if (!user) {
        return next(new Error('Invalid token'));
    }
    
    socket.user = user;
    next();
});

io.of('/vnc').on('connection', async (socket) => {
    const serverId = socket.handshake.query?.serverId;
    
    log(`VNC connection attempt for server: ${serverId}`);
    
    if (!serverId || !isValidId(serverId)) {
        log(`VNC rejected: invalid server ID "${serverId}"`);
        socket.emit('error', 'Invalid server ID');
        socket.disconnect();
        return;
    }
    
    const serverData = db.getServer(serverId);
    if (!serverData) {
        socket.emit('error', 'Server not found');
        socket.disconnect();
        return;
    }
    
    if (serverData.ownerId !== socket.user.id && socket.user.role !== 'admin') {
        socket.emit('error', 'Access denied');
        socket.disconnect();
        return;
    }
    
    // Handle VNC for remote nodes
    if (serverData.nodeId) {
        const client = nodeManager.getClient(serverData.nodeId);
        if (!client || !client.isConnected()) {
            socket.emit('error', 'Node is offline');
            socket.disconnect();
            return;
        }
        
        try {
            await client.connectVNC(serverId);
            
            const onVncData = (data) => {
                // data.data is now a raw Buffer (binary optimization)
                const buffer = Buffer.isBuffer(data.data) ? data.data : Buffer.from(data.data, 'base64');
                socket.emit('vnc-data', buffer);
            };
            
            const onVncDisconnected = () => {
                socket.emit('vnc-disconnected');
                socket.disconnect();
            };
            
            client.on('vnc-data', onVncData);
            client.on('vnc-disconnected', onVncDisconnected);
            
            socket.emit('vnc-connected');
            
            socket.on('vnc-data', (data) => {
                // Send raw buffer to node (binary optimization)
                client.sendVNCData(Buffer.from(data));
            });
            
            socket.on('disconnect', () => {
                log(`VNC client disconnected for server: ${serverId} (remote)`);
                client.off('vnc-data', onVncData);
                client.off('vnc-disconnected', onVncDisconnected);
            });
        } catch (err) {
            log(`VNC error for ${serverId} (remote): ${err.message}`);
            socket.emit('error', 'VNC connection error: ' + err.message);
            socket.disconnect();
        }
        return;
    }
    
    socket.emit('error', 'VNC not available - server has no node');
    socket.disconnect();
});

const creationProgress = new Map();

const PORT = config.port || process.env.PORT || 3000;

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(DATA_DIR, 'users'));
fs.ensureDirSync(path.join(DATA_DIR, 'images'));

app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let LIMITS = config.limits || { 
    maxServers: 3, 
    maxRam: 4096,
    maxDisk: 10,
    maxCpu: 400,
    maxIo: 100
};

function getUserLimits(user) {
    const base = {
        maxServers: LIMITS.maxServers ?? 3,
        maxRam: LIMITS.maxRam ?? 4096,
        maxDisk: LIMITS.maxDisk ?? 10,
        maxCpu: LIMITS.maxCpu ?? 400,
        maxIo: LIMITS.maxIo ?? 100
    };
    
    if (user.limits && Object.keys(user.limits).length > 0) {
        return {
            ...base,
            maxServers: user.limits.maxServers ?? base.maxServers,
            maxRam: user.limits.maxRam ?? base.maxRam,
            maxDisk: user.limits.maxDisk ?? base.maxDisk,
            maxCpu: user.limits.maxCpu ?? base.maxCpu,
            maxIo: user.limits.maxIo ?? base.maxIo
        };
    }
    return base;
}

// =====================
// AUDIT & WEBHOOKS HELPERS
// =====================

function audit(userId, username, action, details = {}) {
    db.addAuditLog({ userId, username, action, ...details });
}

const WEBHOOK_EVENTS = ['vm_start', 'vm_stop', 'vm_create', 'vm_delete', 'alert_triggered'];

async function triggerWebhooks(event, data) {
    const webhooks = db.getWebhooksByEvent(event);
    
    for (const webhook of webhooks) {
        const payload = {
            event,
            timestamp: new Date().toISOString(),
            data
        };
        
        const headers = {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            'X-Webhook-Timestamp': payload.timestamp,
            'User-Agent': 'v87-webhook/1.0'
        };
        
        if (webhook.secret) {
            const signature = crypto
                .createHmac('sha256', webhook.secret)
                .update(JSON.stringify(payload))
                .digest('hex');
            headers['X-Webhook-Signature'] = `sha256=${signature}`;
        }
        
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            
            const response = await fetch(webhook.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            
            clearTimeout(timeout);
            
            if (response.ok) {
                log(`Webhook ${webhook.id} delivered: ${event} -> ${webhook.url}`);
            } else {
                log(`Webhook ${webhook.id} failed: ${response.status} ${response.statusText}`);
            }
        } catch (err) {
            log(`Webhook ${webhook.id} error: ${err.message}`);
        }
    }
}

async function testWebhook(webhook) {
    const payload = {
        event: 'test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test webhook from v87' }
    };
    
    const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': 'test',
        'X-Webhook-Timestamp': payload.timestamp,
        'User-Agent': 'v87-webhook/1.0'
    };
    
    if (webhook.secret) {
        const signature = crypto
            .createHmac('sha256', webhook.secret)
            .update(JSON.stringify(payload))
            .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
        const response = await fetch(webhook.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        return {
            success: response.ok,
            status: response.status,
            statusText: response.statusText
        };
    } catch (err) {
        clearTimeout(timeout);
        return {
            success: false,
            error: err.message
        };
    }
}

// =====================
// AUTH
// =====================

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Rate limit by IP: 5 attempts per 15 minutes
    const ipLimit = rateLimit(`login:ip:${ip}`, 5, 15 * 60 * 1000);
    if (!ipLimit.allowed) {
        const retryAfter = Math.ceil((ipLimit.resetAt - Date.now()) / 1000);
        res.set('Retry-After', retryAfter);
        return res.status(429).json({ 
            error: 'Too many login attempts. Try again later.',
            retryAfter 
        });
    }
    
    // Rate limit by username: 10 attempts per 15 minutes
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
    // Check if registration is disabled
    const settings = db.getSettings();
    const isFirstUser = db.getUsers().length === 0;
    
    if (settings.registrationDisabled && !isFirstUser) {
        return res.status(403).json({ error: 'Registration is currently disabled' });
    }
    
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    
    // Rate limit registrations: 3 per hour per IP
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
    // Invalidate all tokens for this user
    invalidateUserTokens(req.user.id);
    audit(req.user.id, req.user.username, 'logout');
    res.json({ success: true });
});

app.post('/api/revoke-tokens', requireAuth, (req, res) => {
    // Invalidate all sessions/tokens for current user
    invalidateUserTokens(req.user.id);
    audit(req.user.id, req.user.username, 'tokens_revoked');
    res.json({ success: true, message: 'All sessions have been logged out' });
});

// =====================
// IMAGES
// =====================

app.get('/api/images', (req, res) => {
    const images = getImages();
    res.json({ images });
});

app.get('/api/images/:id', (req, res) => {
    const image = getImage(req.params.id);
    if (!image) return res.status(404).json({ error: 'Image not found' });
    res.json({ image });
});

// =====================
// SERVERS (VMs)
// =====================

app.get('/api/dashboard', requireAuth, async (req, res) => {
    const user = db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const servers = db.getUserServers(user.id);
    const userLimits = getUserLimits(user);
    
    const totalRam = servers.reduce((acc, s) => acc + (s.ram || 0), 0);
    const totalCpu = servers.reduce((acc, s) => acc + (s.cpuLimit || 0), 0);
    const totalDisk = servers.reduce((acc, s) => acc + parseInt((s.diskSize || '0G').replace('G', '')), 0);
    
    const serversWithStatus = servers.map(s => ({
        ...s,
        status: s.status || 'stopped',
        image: getImage(s.imageId)?.name || 'Unknown'
    }));
    
    res.json({ 
        servers: serversWithStatus,
        stats: {
            totalRam,
            totalCpu,
            totalDisk,
            availableRam: Math.max(0, userLimits.maxRam - totalRam),
            availableCpu: Math.max(0, userLimits.maxCpu - totalCpu),
            availableDisk: Math.max(0, userLimits.maxDisk - totalDisk),
            slotsUsed: servers.length,
            slotsMax: userLimits.maxServers,
            maxRam: userLimits.maxRam,
            maxDisk: userLimits.maxDisk,
            maxCpu: userLimits.maxCpu,
            maxIo: userLimits.maxIo
        },
        defaults: {
            ram: config.vm?.defaultRam || 1024,
            disk: parseInt((config.vm?.defaultDisk || '10G').replace('G', '')),
            cpu: config.vm?.defaultCpu || 100,
            io: config.vm?.defaultIo || 0
        }
    });
});

app.post('/api/server/create', requireAuth, async (req, res, next) => {
    try {
        const { name, description, imageId, nodeId } = req.body;
        const user = db.findUserById(req.user.id);
        const servers = db.getUserServers(user.id);
        const userLimits = getUserLimits(user);
        
        const image = getImage(imageId || config.vm?.defaultImage || 'fedora-40');
        if (!image) return res.status(400).json({ error: 'Invalid image' });
        
        const totalRam = servers.reduce((acc, s) => acc + (s.ram || 0), 0);
        const totalCpu = servers.reduce((acc, s) => acc + (s.cpuLimit || 0), 0);
        const totalDisk = servers.reduce((acc, s) => acc + parseInt((s.diskSize || '0G').replace('G', '')), 0);
        
        const availableRam = userLimits.maxRam - totalRam;
        const availableCpu = userLimits.maxCpu - totalCpu;
        const availableDisk = userLimits.maxDisk - totalDisk;
        
        if (req.user.role !== 'admin') {
            if (servers.length >= userLimits.maxServers) {
                return res.status(400).json({ error: `Max ${userLimits.maxServers} servers reached` });
            }
        }
        
        let ram = parseInt(req.body.ram) || config.vm?.defaultRam || 1024;
        let cpuLimit = parseInt(req.body.cpuLimit) || config.vm?.defaultCpu || 100;
        let ioLimit = parseInt(req.body.ioLimit) || config.vm?.defaultIo || 0;
        
        let diskSizeNum = parseInt((req.body.diskSize || '10G').replace('G', ''));
        if (isNaN(diskSizeNum)) diskSizeNum = 10;
        
        if (req.user.role !== 'admin') {
            if (ram > availableRam) {
                return res.status(400).json({ error: `Not enough RAM. Available: ${availableRam}MB` });
            }
            if (cpuLimit > availableCpu) {
                return res.status(400).json({ error: `Not enough CPU. Available: ${availableCpu}%` });
            }
            if (diskSizeNum > availableDisk) {
                return res.status(400).json({ error: `Not enough storage. Available: ${availableDisk}GB` });
            }
            ioLimit = Math.min(ioLimit, userLimits.maxIo);
        }
        
        const diskSize = `${diskSizeNum}G`;
        const serverId = Date.now().toString();
        
        let selectedNode = null;
        const nodes = db.getNodes().filter(n => n.enabled);
        
        if (nodes.length > 0) {
            if (nodeId) {
                selectedNode = db.getNode(nodeId);
                if (!selectedNode || !selectedNode.enabled) {
                    return res.status(400).json({ error: 'Invalid or disabled node' });
                }
            } else {
                const cpuCores = Math.ceil(cpuLimit / 100);
                const availableNodes = nodes.filter(n => {
                    const usage = db.getNodeUsage(n.id);
                    return (
                        (n.maxRam - usage.ram) >= ram &&
                        (n.maxDisk - usage.disk) >= diskSizeNum &&
                        (n.maxCpu - usage.cpu) >= cpuCores &&
                        (n.maxServers - usage.count) >= 1 &&
                        nodeManager.isNodeConnected(n.id)
                    );
                });
                
                if (availableNodes.length === 0) {
                    return res.status(400).json({ error: 'No slots left. All nodes are at capacity.' });
                }
                
                selectedNode = availableNodes[0];
            }
            
            if (selectedNode) {
                const cpuCores = Math.ceil(cpuLimit / 100);
                const usage = db.getNodeUsage(selectedNode.id);
                const canFit = (
                    (selectedNode.maxRam - usage.ram) >= ram &&
                    (selectedNode.maxDisk - usage.disk) >= diskSizeNum &&
                    (selectedNode.maxCpu - usage.cpu) >= cpuCores &&
                    (selectedNode.maxServers - usage.count) >= 1
                );
                
                if (!canFit) {
                    return res.status(400).json({ error: 'No slots left on selected node.' });
                }
                
                if (!nodeManager.isNodeConnected(selectedNode.id)) {
                    return res.status(400).json({ error: 'Selected node is offline.' });
                }
            }
        }
        
        const serverData = {
            id: serverId,
            ownerId: user.id,
            name: name || 'My VM',
            description: description || '',
            imageId: image.id,
            ram,
            diskSize,
            cpuLimit,
            cpuCores: Math.ceil(cpuLimit / 100),
            ioLimit,
            nodeId: selectedNode?.id || null,
            nodeName: selectedNode?.name || null,
            created_at: new Date(),
            status: 'creating'
        };
        
        db.addServer(serverData);
        log(`Server ${serverId} creation started for user ${user.username}${selectedNode ? ` on node ${selectedNode.name}` : ''}`);
        audit(user.id, user.username, 'vm_create', { serverId, serverName: serverData.name, imageId: image.id, nodeId: selectedNode?.id });
        triggerWebhooks('vm_create', { serverId, serverName: serverData.name, userId: user.id, imageId: image.id, nodeId: selectedNode?.id });
        
        const client = nodeManager.getClient(selectedNode.id);
        client.createVM({
            serverId,
            userId: user.id,
            imageId: image.id,
            imageUrl: image.url,
            imageName: image.name,
            imageDefaultUser: image.defaultUser,
            ram: serverData.ram,
            disk: serverData.diskSize,
            cpuCores: serverData.cpuCores
        }).then((result) => {
            db.updateServer(serverId, { 
                status: 'stopped',
                password: result.password
            });
            log(`Server ${serverId} created on node ${selectedNode.name}`);
        }).catch((err) => {
            db.updateServer(serverId, { status: 'error', error: err.message });
            log(`Server ${serverId} creation failed on node: ${err.message}`);
        });
        
        res.json({ success: true, server: serverData });
        
    } catch (err) {
        next(err);
    }
});

app.get('/api/server/:id/creation-progress', requireAuth, (req, res) => {
    const serverId = req.params.id;
    const serverData = db.getServer(serverId);
    if (!serverData) return res.status(404).json({ error: 'Not found' });
    if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const progress = creationProgress.get(serverId) || { percent: 0, status: 'Starting...' };
    res.json(progress);
});

// VNC Bridge connection code
app.get('/api/server/:id/vnc-code', requireAuth, async (req, res) => {
    const serverData = db.getServer(req.params.id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!serverData.nodeId) {
        return res.status(400).json({ error: 'Server has no node assigned' });
    }
    
    const client = nodeManager.getClient(serverData.nodeId);
    if (!client || !client.isConnected()) {
        return res.status(400).json({ error: 'Node is offline' });
    }
    
    try {
        const vmStatus = await client.getVMStatus(serverData.id);
        if (vmStatus.status !== 'running') {
            return res.status(400).json({ error: 'VM must be running to get VNC code' });
        }
    } catch {
        return res.status(400).json({ error: 'Could not get VM status' });
    }
    
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host');
    const codeData = {
        url: `${protocol}://${host}`,
        token: req.headers.authorization?.replace('Bearer ', ''),
        serverId: serverData.id
    };
    
    const code = Buffer.from(JSON.stringify(codeData)).toString('base64');
    
    res.json({ code });
});

app.get('/api/server/:id', requireAuth, async (req, res) => {
    const serverData = db.getServer(req.params.id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const image = getImage(serverData.imageId);
    
    // Read credentials from metadata or server data (for remote nodes)
    let credentials = null;
    if (serverData.password) {
        credentials = {
            user: 'root',
            password: serverData.password
        };
    } else {
        try {
            const metadataPath = path.join(DATA_DIR, 'users', serverData.ownerId, serverData.id, 'metadata.json');
            const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
            if (metadata.password) {
                credentials = {
                    user: metadata.defaultUser || 'root',
                    password: metadata.password
                };
            }
        } catch {}
    }

    let status = serverData.status || 'stopped';
    if (serverData.nodeId) {
        const client = nodeManager.getClient(serverData.nodeId);
        if (client && client.isConnected()) {
            try {
                const vmStatus = await client.getVMStatus(req.params.id);
                status = vmStatus.status || 'stopped';
            } catch {}
        } else {
            status = 'offline';
        }
    }

    res.json({ 
        server: {
            ...serverData,
            status
        },
        image: image ? { id: image.id, name: image.name, description: image.description } : null,
        credentials
    });
});

app.post('/api/server/:id/start', requireAuth, async (req, res, next) => {
    try {
        const serverId = req.params.id;
        const serverData = db.getServer(serverId);
        if (!serverData) return res.status(404).json({ error: 'Not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (serverData.suspended) {
            return res.status(403).json({ error: 'Server suspended: ' + (serverData.suspendReason || 'Contact administrator') });
        }
        
        const owner = db.findUserById(serverData.ownerId);
        if (owner && owner.suspended) {
            return res.status(403).json({ error: 'Account suspended' });
        }
        
        log(`Starting VM ${serverId}`);
        
        if (!serverData.nodeId) {
            return res.status(400).json({ error: 'Server has no node assigned' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (!client || !client.isConnected()) {
            return res.status(400).json({ error: 'Node is offline' });
        }
        await client.startVM(serverId, serverData.ownerId);
        
        db.updateServer(serverId, { status: 'running' });
        io.to(`server:${serverId}`).emit('vm-status', 'started');
        audit(req.user.id, req.user.username, 'vm_start', { serverId, serverName: serverData.name });
        triggerWebhooks('vm_start', { serverId, serverName: serverData.name, userId: req.user.id });
        res.json({ status: 'started' });
    } catch (err) {
        next(err);
    }
});

app.post('/api/server/:id/stop', requireAuth, async (req, res, next) => {
    try {
        const serverId = req.params.id;
        const serverData = db.getServer(serverId);
        if (!serverData) return res.status(404).json({ error: 'Not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }

        if (!serverData.nodeId) {
            return res.status(400).json({ error: 'Server has no node assigned' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (client && client.isConnected()) {
            await client.stopVM(serverId);
        }
        
        db.updateServer(serverId, { status: 'stopped' });
        audit(req.user.id, req.user.username, 'vm_stop', { serverId, serverName: serverData.name });
        triggerWebhooks('vm_stop', { serverId, serverName: serverData.name, userId: req.user.id });
        res.json({ status: 'stopped' });
        
    } catch (err) {
        next(err);
    }
});

app.delete('/api/server/:id', requireAuth, async (req, res, next) => {
    try {
        const serverId = req.params.id;
        const serverData = db.getServer(serverId);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (!serverData.nodeId) {
            return res.status(400).json({ error: 'Server has no node assigned' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (client && client.isConnected()) {
            await client.deleteVM(serverId, serverData.ownerId);
        }
        
        db.deleteServer(serverId);
        audit(req.user.id, req.user.username, 'vm_delete', { serverId, serverName: serverData.name });
        triggerWebhooks('vm_delete', { serverId, serverName: serverData.name, userId: req.user.id });
        res.json({ success: true });
        
    } catch (err) {
        next(err);
    }
});



app.post('/api/server/:id/settings', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const { name, description } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        
        const updated = db.updateServer(req.params.id, updates);
        res.json({ success: true, server: updated });
    } catch (err) {
        next(err);
    }
});

app.get('/api/server/:id/limits', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        let limits = { ram: serverData.ram, cpuCores: serverData.cpuCores };
        if (serverData.nodeId) {
            const client = nodeManager.getClient(serverData.nodeId);
            if (client && client.isConnected()) {
                try {
                    limits = await client.getLimits(serverData.id, serverData.ownerId);
                } catch {}
            }
        }
        res.json(limits);
    } catch (err) {
        next(err);
    }
});

app.post('/api/server/:id/limits', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const { ram, cpuLimit, ioLimit, cpuCores } = req.body;
        
        if (!serverData.nodeId) {
            return res.status(400).json({ error: 'Server has no node assigned' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (!client || !client.isConnected()) {
            return res.status(400).json({ error: 'Node is offline' });
        }
        const result = await client.updateLimits(serverData.id, serverData.ownerId, { ram, cpuCores });
        
        if (ram !== undefined) {
            db.updateServer(req.params.id, { ram });
        }
        if (cpuCores !== undefined) {
            db.updateServer(req.params.id, { cpuCores });
        }
        
        res.json(result);
    } catch (err) {
        next(err);
    }
});

app.get('/api/server/:id/stats', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (!serverData.nodeId) {
            return res.json({ running: false, error: 'No node assigned' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (!client || !client.isConnected()) {
            return res.json({ running: false, nodeOffline: true });
        }
        
        try {
            const stats = await client.getVMStats(req.params.id);
            res.json({ running: true, ...stats.stats });
        } catch {
            res.json({ running: false });
        }
    } catch (err) {
        next(err);
    }
});

app.post('/api/server/:id/resize-disk', requireAuth, async (req, res, next) => {
    try {
        const { newSizeGB } = req.body;
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const user = db.findUserById(serverData.ownerId);
        const userLimits = getUserLimits(user);
        const servers = db.getUserServers(user.id);
        const otherDisk = servers.filter(s => s.id !== serverData.id)
            .reduce((acc, s) => acc + parseInt((s.diskSize || '0G').replace('G', '')), 0);
        
        if (req.user.role !== 'admin' && (otherDisk + newSizeGB) > userLimits.maxDisk) {
            return res.status(400).json({ error: `Exceeds disk quota. Available: ${userLimits.maxDisk - otherDisk}GB` });
        }
        
        if (!serverData.nodeId) {
            return res.status(400).json({ error: 'Server has no node assigned' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (!client || !client.isConnected()) {
            return res.status(400).json({ error: 'Node is offline' });
        }
        const result = await client.resizeDisk(serverData.id, serverData.ownerId, newSizeGB);
        
        db.updateServer(serverData.id, { diskSize: `${newSizeGB}G` });
        audit(req.user.id, req.user.username, 'disk_resize', { serverId: serverData.id, newSize: newSizeGB });
        
        res.json(result);
    } catch (err) {
        next(err);
    }
});



app.get('/api/server/:id/metrics', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const hours = parseInt(req.query.hours) || 1;
        const metrics = db.getMetrics(req.params.id);
        
        // Filter by time range
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const filtered = metrics.filter(m => new Date(m.timestamp) >= since);
        
        res.json({ metrics: filtered });
    } catch (err) {
        next(err);
    }
});

app.get('/api/server/:id/disk-info', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (!serverData.nodeId) {
            return res.json({ virtualSize: '-', actualSize: '-', format: '-' });
        }
        
        const client = nodeManager.getClient(serverData.nodeId);
        if (client && client.isConnected()) {
            try {
                const info = await client.getDiskInfo(serverData.id, serverData.ownerId);
                res.json({
                    virtualSize: formatBytes(info.virtualSize),
                    actualSize: formatBytes(info.actualSize),
                    format: info.format
                });
                return;
            } catch {}
        }
        res.json({ virtualSize: '-', actualSize: '-', format: '-' });
    } catch (err) {
        next(err);
    }
});

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// =====================
// ADMIN ROUTES
// =====================

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    const stats = db.getStats();
    
    let runningServers = 0;
    const servers = db.getServers();
    for (const s of servers) {
        if (s.nodeId) {
            const client = nodeManager.getClient(s.nodeId);
            if (client && client.isConnected()) {
                try {
                    const vmStatus = await client.getVMStatus(s.id);
                    if (vmStatus.status === 'running') runningServers++;
                } catch {}
            }
        }
    }
    
    res.json({ ...stats, runningServers });
});

app.get('/api/admin/servers', requireAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    
    let servers = db.getServers();
    
    if (search) {
        servers = servers.filter(s => 
            s.name.toLowerCase().includes(search.toLowerCase()) ||
            s.id.includes(search)
        );
    }
    
    const startIndex = (page - 1) * limit;
    const results = servers.slice(startIndex, startIndex + limit);
    
    const enrichedServers = results.map(s => {
        const owner = db.findUserById(s.ownerId);
        const image = getImage(s.imageId);
        return {
            ...s,
            status: s.status || 'stopped',
            ownerName: owner ? owner.username : 'Unknown',
            imageName: image?.name || 'Unknown'
        };
    });
    
    res.json({
        servers: enrichedServers,
        total: servers.length,
        page,
        totalPages: Math.ceil(servers.length / limit)
    });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = db.getUsers();
    const servers = db.getServers();
    
    const enrichedUsers = users.map(u => {
        const userServers = servers.filter(s => s.ownerId === u.id);
        return {
            id: u.id,
            username: u.username,
            role: u.role,
            suspended: u.suspended || false,
            limits: u.limits || null,
            serverCount: userServers.length,
            totalRam: userServers.reduce((acc, s) => acc + (s.ram || 0), 0),
            created_at: u.created_at
        };
    });
    
    res.json(enrichedUsers);
});

app.get('/api/admin/user/:id', requireAdmin, (req, res) => {
    const user = db.findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const servers = db.getUserServers(user.id);
    
    res.json({
        id: user.id,
        username: user.username,
        role: user.role,
        suspended: user.suspended || false,
        suspendReason: user.suspendReason || '',
        limits: user.limits || null,
        servers: servers.map(s => ({
            id: s.id,
            name: s.name,
            ram: s.ram,
            suspended: s.suspended || false,
            imageName: getImage(s.imageId)?.name || 'Unknown',
            status: s.status || 'stopped'
        })),
        created_at: user.created_at
    });
});

app.post('/api/admin/user/:id', requireAdmin, (req, res) => {
    const { role, suspended, suspendReason, limits } = req.body;
    const user = db.findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (user.id === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'Cannot remove your own admin role' });
    }
    
    const updates = {};
    if (role !== undefined) updates.role = role;
    if (suspended !== undefined) updates.suspended = suspended;
    if (suspendReason !== undefined) updates.suspendReason = suspendReason;
    if (limits !== undefined) updates.limits = limits;
    
    const updated = db.updateUser(req.params.id, updates);
    res.json({ success: true, user: updated });
});

app.delete('/api/admin/user/:id', requireAdmin, async (req, res, next) => {
    try {
        const user = db.findUserById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        if (user.id === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        
        const userServers = db.getUserServers(user.id);
        for (const s of userServers) {
            if (s.nodeId) {
                const client = nodeManager.getClient(s.nodeId);
                if (client && client.isConnected()) {
                    try {
                        await client.stopVM(s.id);
                        await client.deleteVM(s.id, user.id);
                    } catch {}
                }
            }
        }
        
        db.deleteUserServers(user.id);
        db.deleteUser(user.id);
        
        const userDir = path.join(DATA_DIR, 'users', user.id);
        if (fs.existsSync(userDir)) {
            await fs.remove(userDir);
        }
        
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

app.get('/api/admin/config', requireAdmin, (req, res) => {
    res.json({
        port: config.port,
        limits: config.limits,
        vm: config.vm,
        images: getImages().map(i => ({ id: i.id, name: i.name }))
    });
});

app.post('/api/admin/config', requireAdmin, async (req, res, next) => {
    try {
        const { limits, vm } = req.body;
        if (limits) {
            config.limits = { ...config.limits, ...limits };
            LIMITS = config.limits;
        }
        if (vm) {
            config.vm = { ...config.vm, ...vm };
        }
        res.json({ success: true, config: { limits: config.limits, vm: config.vm } });
    } catch (err) {
        next(err);
    }
});

app.get('/api/admin/server/:id', requireAdmin, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        const owner = db.findUserById(serverData.ownerId);
        const image = getImage(serverData.imageId);
        
        let status = serverData.status || 'stopped';
        if (serverData.nodeId) {
            const client = nodeManager.getClient(serverData.nodeId);
            if (client && client.isConnected()) {
                try {
                    const vmStatus = await client.getVMStatus(serverData.id);
                    status = vmStatus.status || 'stopped';
                } catch {}
            } else {
                status = 'offline';
            }
        }
        
        res.json({
            ...serverData,
            status,
            ownerName: owner?.username || 'Unknown',
            imageName: image?.name || 'Unknown'
        });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/server/:id', requireAdmin, async (req, res, next) => {
    try {
        const { name, description, ram, cpuLimit, ioLimit } = req.body;
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (ram !== undefined) updates.ram = ram;
        if (cpuLimit !== undefined) updates.cpuLimit = cpuLimit;
        if (ioLimit !== undefined) updates.ioLimit = ioLimit;
        
        const updated = db.updateServer(req.params.id, updates);
        
        if ((ram !== undefined || cpuLimit !== undefined || ioLimit !== undefined) && serverData.nodeId) {
            const client = nodeManager.getClient(serverData.nodeId);
            if (client && client.isConnected()) {
                await client.updateLimits(serverData.id, serverData.ownerId, { ram, cpuCores: Math.ceil((cpuLimit || 100) / 100) }).catch(() => {});
            }
        }
        
        res.json({ success: true, server: updated });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/stop-all', requireAdmin, async (req, res, next) => {
    try {
        const servers = db.getServers();
        let stopped = 0;
        
        for (const s of servers) {
            if (s.nodeId && s.status === 'running') {
                const client = nodeManager.getClient(s.nodeId);
                if (client && client.isConnected()) {
                    try {
                        await client.stopVM(s.id);
                        db.updateServer(s.id, { status: 'stopped' });
                        stopped++;
                    } catch {}
                }
            }
        }
        
        log(`Admin stopped all VMs (${stopped} total)`);
        res.json({ success: true, stopped });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/server/:id/suspend', requireAdmin, async (req, res, next) => {
    try {
        const { suspended, reason } = req.body;
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        const updates = { suspended: !!suspended };
        if (reason !== undefined) updates.suspendReason = reason;
        
        if (suspended && serverData.nodeId && serverData.status === 'running') {
            const client = nodeManager.getClient(serverData.nodeId);
            if (client && client.isConnected()) {
                try {
                    await client.stopVM(serverData.id);
                } catch {}
            }
            updates.status = 'stopped';
        }
        
        const updated = db.updateServer(req.params.id, updates);
        res.json({ success: true, server: updated });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/server/:id/force-stop', requireAdmin, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        if (serverData.nodeId) {
            const client = nodeManager.getClient(serverData.nodeId);
            if (client && client.isConnected()) {
                try {
                    await client.stopVM(serverData.id);
                } catch {}
            }
        }
        
        db.updateServer(req.params.id, { status: 'stopped' });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

app.delete('/api/admin/server/:id', requireAdmin, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        if (serverData.nodeId) {
            const client = nodeManager.getClient(serverData.nodeId);
            if (client && client.isConnected()) {
                try {
                    await client.stopVM(serverData.id);
                    await client.deleteVM(serverData.id, serverData.ownerId);
                } catch {}
            }
        }
        
        db.deleteServer(req.params.id);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/user/:id/revoke-tokens', requireAdmin, (req, res) => {
    const user = db.findUserById(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    invalidateUserTokens(req.params.id);
    audit(req.user.id, req.user.username, 'admin_revoke_tokens', { targetUser: user.username });
    log(`Admin ${req.user.username} revoked all tokens for user ${user.username}`);
    
    res.json({ success: true, message: `All sessions for ${user.username} have been logged out` });
});

// =====================
// NODES MANAGEMENT
// =====================

function calculateNodeAvailability(node) {
    const usage = db.getNodeUsage(node.id);
    return {
        ram: {
            used: usage.ram,
            total: node.maxRam || 0,
            available: Math.max(0, (node.maxRam || 0) - usage.ram)
        },
        disk: {
            used: usage.disk,
            total: node.maxDisk || 0,
            available: Math.max(0, (node.maxDisk || 0) - usage.disk)
        },
        cpu: {
            used: usage.cpu,
            total: node.maxCpu || 0,
            available: Math.max(0, (node.maxCpu || 0) - usage.cpu)
        },
        servers: {
            count: usage.count,
            max: node.maxServers || 0,
            available: Math.max(0, (node.maxServers || 0) - usage.count)
        }
    };
}

function canFitOnNode(node, ram, disk, cpu) {
    const availability = calculateNodeAvailability(node);
    return (
        availability.ram.available >= ram &&
        availability.disk.available >= disk &&
        availability.cpu.available >= cpu &&
        availability.servers.available >= 1
    );
}

function findAvailableNodes(ram, disk, cpu) {
    const nodes = db.getNodes().filter(n => n.enabled);
    return nodes.filter(n => canFitOnNode(n, ram, disk, cpu)).map(n => ({
        ...n,
        secret: undefined,
        availability: calculateNodeAvailability(n),
        online: nodeManager.isNodeConnected(n.id)
    }));
}

app.get('/api/admin/nodes', requireAdmin, async (req, res) => {
    const nodes = db.getNodes();
    const enriched = await Promise.all(nodes.map(async (node) => {
        const online = nodeManager.isNodeConnected(node.id);
        const availability = calculateNodeAvailability(node);
        
        let nodeStatus = null;
        if (online) {
            try {
                nodeStatus = await nodeManager.getNodeStatus(node.id);
            } catch {}
        }
        
        return {
            ...node,
            secret: '••••••••',
            online,
            availability,
            nodeStatus
        };
    }));
    
    res.json({ nodes: enriched });
});

app.post('/api/admin/nodes', requireAdmin, (req, res) => {
    const { name, url, secret, region, maxRam, maxDisk, maxCpu, maxServers } = req.body;
    
    if (!name || !url || !secret) {
        return res.status(400).json({ error: 'name, url, and secret are required' });
    }
    
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        return res.status(400).json({ error: 'URL must start with ws:// or wss://' });
    }
    
    const node = {
        id: crypto.randomBytes(8).toString('hex'),
        name,
        url,
        secret,
        region: region || 'default',
        maxRam: maxRam || 8192,
        maxDisk: maxDisk || 100,
        maxCpu: maxCpu || 8,
        maxServers: maxServers || 10,
        enabled: true,
        status: 'offline',
        createdAt: new Date().toISOString()
    };
    
    db.createNode(node);
    
    nodeManager.addNode({
        id: node.id,
        url: node.url,
        secret: node.secret
    });
    
    audit(req.user.id, req.user.username, 'node_created', { nodeId: node.id, nodeName: name });
    log(`Node created: ${name} (${node.id})`);
    
    res.json({ success: true, node: { ...node, secret: '••••••••' } });
});

app.get('/api/admin/nodes/:id', requireAdmin, async (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    const online = nodeManager.isNodeConnected(node.id);
    const availability = calculateNodeAvailability(node);
    const servers = db.getNodeServers(node.id);
    
    let nodeStatus = null;
    let images = [];
    
    if (online) {
        try {
            const client = nodeManager.getClient(node.id);
            nodeStatus = await client.getStatus();
            images = await client.listImages();
        } catch {}
    }
    
    res.json({
        ...node,
        secret: '••••••••',
        online,
        availability,
        nodeStatus,
        images,
        servers: servers.map(s => ({
            id: s.id,
            name: s.name,
            status: s.status,
            ram: s.ram,
            disk: s.disk
        }))
    });
});

app.put('/api/admin/nodes/:id', requireAdmin, (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    const { name, url, secret, region, maxRam, maxDisk, maxCpu, maxServers, enabled } = req.body;
    
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (url !== undefined) updates.url = url;
    if (secret !== undefined) updates.secret = secret;
    if (region !== undefined) updates.region = region;
    if (maxRam !== undefined) updates.maxRam = maxRam;
    if (maxDisk !== undefined) updates.maxDisk = maxDisk;
    if (maxCpu !== undefined) updates.maxCpu = maxCpu;
    if (maxServers !== undefined) updates.maxServers = maxServers;
    if (enabled !== undefined) updates.enabled = enabled;
    
    const updated = db.updateNode(req.params.id, updates);
    
    if (url !== undefined || secret !== undefined || enabled !== undefined) {
        nodeManager.removeNode(node.id);
        if (updated.enabled) {
            nodeManager.addNode({
                id: updated.id,
                url: updated.url,
                secret: updated.secret
            });
        }
    }
    
    audit(req.user.id, req.user.username, 'node_updated', { nodeId: node.id });
    
    res.json({ success: true, node: { ...updated, secret: '••••••••' } });
});

app.delete('/api/admin/nodes/:id', requireAdmin, (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    const servers = db.getNodeServers(node.id);
    if (servers.length > 0) {
        return res.status(400).json({ 
            error: `Cannot delete node with ${servers.length} servers. Migrate or delete them first.` 
        });
    }
    
    nodeManager.removeNode(node.id);
    db.deleteNode(node.id);
    
    audit(req.user.id, req.user.username, 'node_deleted', { nodeId: node.id, nodeName: node.name });
    log(`Node deleted: ${node.name} (${node.id})`);
    
    res.json({ success: true });
});

app.post('/api/admin/nodes/:id/reconnect', requireAdmin, (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    nodeManager.removeNode(node.id);
    nodeManager.addNode({
        id: node.id,
        url: node.url,
        secret: node.secret
    });
    
    res.json({ success: true, message: 'Reconnection initiated' });
});

app.post('/api/admin/nodes/:id/download-image', requireAdmin, async (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    const client = nodeManager.getClient(node.id);
    if (!client || !client.isConnected()) {
        return res.status(400).json({ error: 'Node is offline' });
    }
    
    const { imageId } = req.body;
    if (!imageId) {
        return res.status(400).json({ error: 'imageId required' });
    }
    
    const image = getImage(imageId);
    if (!image) {
        return res.status(400).json({ error: 'Image not found' });
    }
    
    try {
        await client.downloadImage(imageId, image.url, image.name);
        res.json({ success: true, message: 'Download started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/nodes/:id/images', requireAdmin, async (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    const client = nodeManager.getClient(node.id);
    if (!client || !client.isConnected()) {
        return res.status(400).json({ error: 'Node is offline' });
    }
    
    try {
        const images = await client.listImages();
        res.json({ images });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/nodes', requireAuth, (req, res) => {
    const { ram, disk, cpu } = req.query;
    
    const ramMb = parseInt(ram) || 1024;
    const diskGb = parseInt(disk) || 10;
    const cpuCores = parseInt(cpu) || 1;
    
    const available = findAvailableNodes(ramMb, diskGb, cpuCores);
    
    res.json({ 
        nodes: available.map(n => ({
            id: n.id,
            name: n.name,
            region: n.region,
            online: n.online,
            availability: n.availability
        }))
    });
});

app.get('/api/nodes/:id/availability', requireAuth, (req, res) => {
    const node = db.getNode(req.params.id);
    if (!node || !node.enabled) {
        return res.status(404).json({ error: 'Node not found' });
    }
    
    const availability = calculateNodeAvailability(node);
    const online = nodeManager.isNodeConnected(node.id);
    
    res.json({
        id: node.id,
        name: node.name,
        region: node.region,
        online,
        availability
    });
});

// =====================
// AUDIT LOG
// =====================

app.get('/api/admin/audit', requireAdmin, (req, res) => {
    const { userId, action, serverId, limit, offset } = req.query;
    const logs = db.getAuditLogs({
        userId,
        action,
        serverId,
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
    });
    res.json(logs);
});

app.get('/api/activity', requireAuth, (req, res) => {
    const { limit, offset } = req.query;
    const logs = db.getAuditLogs({
        userId: req.user.id,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0
    });
    res.json(logs);
});

// =====================
// API KEYS
// =====================

function generateApiKey() {
    return 'v87_' + crypto.randomBytes(32).toString('hex');
}

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

// API Key authentication middleware
app.use('/api/v1', (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    const keyData = db.getApiKeyByKey(apiKey);
    if (!keyData) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const user = db.findUserById(keyData.userId);
    if (!user || user.suspended) {
        return res.status(403).json({ error: 'Account suspended' });
    }
    
    db.updateApiKeyLastUsed(keyData.id);
    req.user = user;
    req.apiKey = keyData;
    next();
});

// API v1 endpoints (for programmatic access)
app.get('/api/v1/servers', (req, res) => {
    const servers = db.getUserServers(req.user.id).map(s => ({
        id: s.id,
        name: s.name,
        status: s.status || 'stopped',
        ram: s.ram,
        diskSize: s.diskSize
    }));
    res.json({ servers });
});

app.post('/api/v1/servers/:id/start', async (req, res) => {
    if (!req.apiKey.permissions.includes('write')) {
        return res.status(403).json({ error: 'Write permission required' });
    }
    
    const server = db.getServer(req.params.id);
    if (!server || server.ownerId !== req.user.id) {
        return res.status(404).json({ error: 'Server not found' });
    }
    
    if (!server.nodeId) {
        return res.status(400).json({ error: 'Server has no node assigned' });
    }
    
    const client = nodeManager.getClient(server.nodeId);
    if (!client || !client.isConnected()) {
        return res.status(400).json({ error: 'Node is offline' });
    }
    
    try {
        await client.startVM(server.id, server.ownerId);
        db.updateServer(server.id, { status: 'running' });
        audit(req.user.id, req.user.username, 'vm_started_api', { serverId: server.id });
        res.json({ success: true, status: 'running' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/v1/servers/:id/stop', async (req, res) => {
    if (!req.apiKey.permissions.includes('write')) {
        return res.status(403).json({ error: 'Write permission required' });
    }
    
    const server = db.getServer(req.params.id);
    if (!server || server.ownerId !== req.user.id) {
        return res.status(404).json({ error: 'Server not found' });
    }
    
    if (!server.nodeId) {
        return res.status(400).json({ error: 'Server has no node assigned' });
    }
    
    const client = nodeManager.getClient(server.nodeId);
    if (client && client.isConnected()) {
        try {
            await client.stopVM(server.id);
        } catch {}
    }
    
    db.updateServer(server.id, { status: 'stopped' });
    audit(req.user.id, req.user.username, 'vm_stopped_api', { serverId: server.id });
    res.json({ success: true, status: 'stopped' });
});

app.get('/api/v1/servers/:id/stats', async (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server || server.ownerId !== req.user.id) {
        return res.status(404).json({ error: 'Server not found' });
    }
    
    if (!server.nodeId) {
        return res.json({ running: false });
    }
    
    const client = nodeManager.getClient(server.nodeId);
    if (!client || !client.isConnected()) {
        return res.json({ running: false, nodeOffline: true });
    }
    
    try {
        const stats = await client.getVMStats(server.id);
        res.json({ running: true, ...stats.stats });
    } catch {
        res.json({ running: false });
    }
});

// =====================
// SCHEDULED ACTIONS
// =====================

app.get('/api/server/:id/schedules', requireAuth, (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const schedules = db.getServerSchedules(req.params.id);
    res.json({ schedules });
});

app.post('/api/server/:id/schedules', requireAuth, (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const { action, cronExpression, enabled } = req.body;
    
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
    }
    
    const userSchedules = db.getUserSchedules(req.user.id);
    if (userSchedules.length >= 10) {
        return res.status(400).json({ error: 'Maximum 10 schedules allowed' });
    }
    
    const schedule = {
        id: Date.now().toString(),
        userId: req.user.id,
        serverId: req.params.id,
        action,
        cronExpression: cronExpression || '0 0 * * *',
        enabled: enabled !== false,
        createdAt: new Date().toISOString(),
        lastRun: null
    };
    
    db.addSchedule(schedule);
    audit(req.user.id, req.user.username, 'schedule_created', { serverId: server.id, action });
    res.json({ success: true, schedule });
});

app.delete('/api/server/:id/schedules/:scheduleId', requireAuth, (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    db.deleteSchedule(req.params.scheduleId);
    res.json({ success: true });
});

// Schedule processor (runs every minute)
setInterval(() => {
    const now = new Date();
    const schedules = db.getSchedules().filter(s => s.enabled);
    
    for (const schedule of schedules) {
        try {
            const [minute, hour, dayOfMonth, month, dayOfWeek] = schedule.cronExpression.split(' ');
            
            const matches = (
                (minute === '*' || parseInt(minute) === now.getMinutes()) &&
                (hour === '*' || parseInt(hour) === now.getHours()) &&
                (dayOfMonth === '*' || parseInt(dayOfMonth) === now.getDate()) &&
                (month === '*' || parseInt(month) === now.getMonth() + 1) &&
                (dayOfWeek === '*' || parseInt(dayOfWeek) === now.getDay())
            );
            
            if (matches) {
                const server = db.getServer(schedule.serverId);
                if (!server || !server.nodeId) continue;
                
                const client = nodeManager.getClient(server.nodeId);
                if (!client || !client.isConnected()) continue;
                
                if (schedule.action === 'start') {
                    client.startVM(server.id, server.ownerId).catch(() => {});
                    db.updateServer(server.id, { status: 'running' });
                } else if (schedule.action === 'stop') {
                    client.stopVM(server.id).catch(() => {});
                    db.updateServer(server.id, { status: 'stopped' });
                } else if (schedule.action === 'restart') {
                    client.stopVM(server.id).then(() => {
                        setTimeout(() => {
                            client.startVM(server.id, server.ownerId).catch(() => {});
                            db.updateServer(server.id, { status: 'running' });
                        }, 5000);
                    }).catch(() => {});
                }
                
                db.updateSchedule(schedule.id, { lastRun: new Date().toISOString() });
                audit(schedule.userId, 'system', 'schedule_executed', { 
                    serverId: server.id, 
                    action: schedule.action 
                });
            }
        } catch (err) {}
    }
}, 60000);

// =====================
// VM NOTES & TAGS
// =====================

app.post('/api/server/:id/notes', requireAuth, async (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const { notes } = req.body;
    if (typeof notes !== 'string' || notes.length > 2000) {
        return res.status(400).json({ error: 'Notes must be a string under 2000 characters' });
    }
    
    db.updateServer(req.params.id, { notes });
    res.json({ success: true });
});

app.post('/api/server/:id/tags', requireAuth, async (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const { tags } = req.body;
    if (!Array.isArray(tags) || tags.length > 10) {
        return res.status(400).json({ error: 'Tags must be an array with max 10 items' });
    }
    
    const cleanTags = tags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim().slice(0, 20))
        .filter(t => t.length > 0);
    
    db.updateServer(req.params.id, { tags: cleanTags });
    res.json({ success: true, tags: cleanTags });
});

// =====================
// USER PREFERENCES
// =====================

app.get('/api/preferences', requireAuth, (req, res) => {
    const user = db.findUserById(req.user.id);
    res.json({ preferences: user.preferences || {} });
});

app.post('/api/preferences', requireAuth, (req, res) => {
    const { theme, terminalFontSize, defaultView, notifications } = req.body;
    
    const preferences = {};
    if (theme && ['dark', 'light', 'auto'].includes(theme)) {
        preferences.theme = theme;
    }
    if (terminalFontSize && terminalFontSize >= 10 && terminalFontSize <= 24) {
        preferences.terminalFontSize = terminalFontSize;
    }
    if (defaultView && ['console', 'stats', 'settings'].includes(defaultView)) {
        preferences.defaultView = defaultView;
    }
    if (typeof notifications === 'boolean') {
        preferences.notifications = notifications;
    }
    
    const user = db.findUserById(req.user.id);
    const updatedPrefs = { ...(user.preferences || {}), ...preferences };
    
    db.updateUser(req.user.id, { preferences: updatedPrefs });
    res.json({ success: true, preferences: updatedPrefs });
});

// =====================
// WEBHOOKS
// =====================

app.get('/api/webhooks', requireAuth, (req, res) => {
    const webhooks = db.getWebhooks(req.user.id).map(w => ({
        ...w,
        secret: w.secret ? '••••••••' : null
    }));
    res.json({ webhooks, availableEvents: WEBHOOK_EVENTS });
});

app.post('/api/webhooks', requireAuth, (req, res) => {
    const { name, url, events, secret } = req.body;
    
    if (!url || !url.startsWith('http')) {
        return res.status(400).json({ error: 'Invalid URL' });
    }
    
    const userWebhooks = db.getWebhooks(req.user.id);
    if (userWebhooks.length >= 5) {
        return res.status(400).json({ error: 'Maximum 5 webhooks allowed' });
    }
    
    const validEvents = (events || []).filter(e => WEBHOOK_EVENTS.includes(e));
    if (validEvents.length === 0) {
        return res.status(400).json({ error: 'At least one valid event required' });
    }
    
    const webhook = {
        id: Date.now().toString(),
        userId: req.user.id,
        name: name || 'Webhook',
        url,
        events: validEvents,
        secret: secret || null,
        enabled: true,
        createdAt: new Date().toISOString()
    };
    
    db.createWebhook(webhook);
    audit(req.user.id, req.user.username, 'webhook_created', { webhookId: webhook.id });
    res.json({ success: true, webhook: { ...webhook, secret: webhook.secret ? '••••••••' : null } });
});

app.put('/api/webhooks/:id', requireAuth, (req, res) => {
    const { name, url, events, secret, enabled } = req.body;
    
    const updates = {};
    if (name) updates.name = name;
    if (url && url.startsWith('http')) updates.url = url;
    if (events) updates.events = events.filter(e => WEBHOOK_EVENTS.includes(e));
    if (secret !== undefined) updates.secret = secret || null;
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    
    const updated = db.updateWebhook(req.params.id, req.user.id, updates);
    if (!updated) {
        return res.status(404).json({ error: 'Webhook not found' });
    }
    
    res.json({ success: true, webhook: { ...updated, secret: updated.secret ? '••••••••' : null } });
});

app.delete('/api/webhooks/:id', requireAuth, (req, res) => {
    db.deleteWebhook(req.params.id, req.user.id);
    res.json({ success: true });
});

app.post('/api/webhooks/:id/test', requireAuth, async (req, res) => {
    const webhooks = db.getWebhooks(req.user.id);
    const webhook = webhooks.find(w => w.id === req.params.id);
    
    if (!webhook) {
        return res.status(404).json({ error: 'Webhook not found' });
    }
    
    const result = await testWebhook(webhook);
    
    if (result.success) {
        res.json({ success: true, message: `Webhook delivered successfully (${result.status})` });
    } else {
        res.json({ success: false, error: result.error || `Failed with status ${result.status}: ${result.statusText}` });
    }
});

// =====================
// SCHEDULES
// =====================

app.get('/api/schedules', requireAuth, (req, res) => {
    const schedules = db.getUserSchedules(req.user.id);
    const enriched = schedules.map(s => {
        const server = db.getServer(s.serverId);
        return { ...s, serverName: server?.name || 'Unknown' };
    });
    res.json(enriched);
});

app.get('/api/server/:id/schedules', requireAuth, (req, res) => {
    const serverData = db.getServer(req.params.id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const schedules = db.getServerSchedules(req.params.id);
    res.json(schedules);
});

app.post('/api/server/:id/schedules', requireAuth, (req, res) => {
    const { action, hour, minute, days, name } = req.body;
    
    const serverData = db.getServer(req.params.id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!['start', 'stop', 'restart'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use: start, stop, restart' });
    }
    
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return res.status(400).json({ error: 'Invalid time' });
    }
    
    if (!Array.isArray(days) || days.length === 0 || days.some(d => d < 0 || d > 6)) {
        return res.status(400).json({ error: 'Invalid days. Use 0-6 (Sunday-Saturday)' });
    }
    
    const schedule = {
        id: Date.now().toString(),
        userId: req.user.id,
        serverId: req.params.id,
        name: name || `${action} at ${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`,
        action,
        hour: parseInt(hour),
        minute: parseInt(minute),
        days: days.map(d => parseInt(d)),
        enabled: true,
        createdAt: new Date().toISOString(),
        lastRun: null
    };
    
    db.addSchedule(schedule);
    audit(req.user.id, req.user.username, 'schedule_created', { scheduleId: schedule.id, serverId: req.params.id });
    res.json({ success: true, schedule });
});

app.put('/api/schedules/:id', requireAuth, (req, res) => {
    const { enabled, hour, minute, days } = req.body;
    
    const schedules = db.getUserSchedules(req.user.id);
    const schedule = schedules.find(s => s.id === req.params.id);
    if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
    }
    
    const updates = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (hour !== undefined) updates.hour = parseInt(hour);
    if (minute !== undefined) updates.minute = parseInt(minute);
    if (Array.isArray(days)) updates.days = days.map(d => parseInt(d));
    
    const updated = db.updateSchedule(req.params.id, updates);
    res.json({ success: true, schedule: updated });
});

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
    const schedules = db.getUserSchedules(req.user.id);
    const schedule = schedules.find(s => s.id === req.params.id);
    if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
    }
    
    db.deleteSchedule(req.params.id);
    res.json({ success: true });
});

// =====================
// ALERTS
// =====================

app.get('/api/alerts', requireAuth, (req, res) => {
    const alerts = db.getAlerts(req.user.id);
    res.json({ alerts });
});

app.post('/api/alerts', requireAuth, (req, res) => {
    const { serverId, metric, threshold, comparison, action } = req.body;
    
    const server = db.getServer(serverId);
    if (!server || (server.ownerId !== req.user.id && req.user.role !== 'admin')) {
        return res.status(404).json({ error: 'Server not found' });
    }
    
    if (!['cpu', 'memory'].includes(metric)) {
        return res.status(400).json({ error: 'Invalid metric. Use: cpu, memory' });
    }
    
    if (!['above', 'below'].includes(comparison)) {
        return res.status(400).json({ error: 'Invalid comparison. Use: above, below' });
    }
    
    const userAlerts = db.getAlerts(req.user.id);
    if (userAlerts.length >= 10) {
        return res.status(400).json({ error: 'Maximum 10 alerts allowed' });
    }
    
    const alert = {
        id: Date.now().toString(),
        userId: req.user.id,
        serverId,
        serverName: server.name,
        metric,
        threshold: parseFloat(threshold) || 80,
        comparison,
        action: action || 'notify',
        enabled: true,
        triggered: false,
        lastTriggered: null,
        createdAt: new Date().toISOString()
    };
    
    db.createAlert(alert);
    audit(req.user.id, req.user.username, 'alert_created', { alertId: alert.id, serverId });
    res.json({ success: true, alert });
});

app.put('/api/alerts/:id', requireAuth, (req, res) => {
    const { threshold, enabled } = req.body;
    
    const alerts = db.getAlerts(req.user.id);
    const alert = alerts.find(a => a.id === req.params.id);
    if (!alert) {
        return res.status(404).json({ error: 'Alert not found' });
    }
    
    const updates = {};
    if (threshold !== undefined) updates.threshold = parseFloat(threshold);
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    
    const updated = db.updateAlert(req.params.id, updates);
    res.json({ success: true, alert: updated });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
    db.deleteAlert(req.params.id);
    res.json({ success: true });
});

// =====================
// SCHEDULER - Runs every minute
// =====================

setInterval(async () => {
    const now = new Date();
    const currentDay = now.getDay(); // 0=Sunday, 1=Monday...
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    const schedules = db.getSchedules();
    
    for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        
        // Check if it's time to run
        const shouldRun = schedule.days.includes(currentDay) &&
            schedule.hour === currentHour &&
            schedule.minute === currentMinute;
        
        if (!shouldRun) continue;
        
        // Prevent running twice in the same minute
        const lastRun = schedule.lastRun ? new Date(schedule.lastRun) : null;
        if (lastRun && (now - lastRun) < 60000) continue;
        
        const server = db.getServer(schedule.serverId);
        if (!server) {
            db.deleteSchedule(schedule.id);
            continue;
        }
        
        if (!server.nodeId) continue;
        
        const client = nodeManager.getClient(server.nodeId);
        if (!client || !client.isConnected()) continue;
        
        const currentStatus = server.status || 'stopped';
        
        try {
            if (schedule.action === 'start' && currentStatus !== 'running') {
                await client.startVM(server.id, server.ownerId);
                db.updateServer(server.id, { status: 'running' });
                log(`Scheduler: Started VM ${server.name} (${server.id})`);
                audit('system', 'scheduler', 'scheduled_start', { serverId: server.id, scheduleId: schedule.id });
            } else if (schedule.action === 'stop' && currentStatus === 'running') {
                await client.stopVM(server.id);
                db.updateServer(server.id, { status: 'stopped' });
                log(`Scheduler: Stopped VM ${server.name} (${server.id})`);
                audit('system', 'scheduler', 'scheduled_stop', { serverId: server.id, scheduleId: schedule.id });
            } else if (schedule.action === 'restart' && currentStatus === 'running') {
                await client.stopVM(server.id);
                await new Promise(r => setTimeout(r, 3000));
                await client.startVM(server.id, server.ownerId);
                db.updateServer(server.id, { status: 'running' });
                log(`Scheduler: Restarted VM ${server.name} (${server.id})`);
                audit('system', 'scheduler', 'scheduled_restart', { serverId: server.id, scheduleId: schedule.id });
            }
            
            db.updateSchedule(schedule.id, { lastRun: now.toISOString() });
        } catch (err) {
            log(`Scheduler error for ${server.id}: ${err.message}`);
        }
    }
}, 60000); // Every minute

// =====================
// METRICS COLLECTOR - Every minute
// =====================

setInterval(async () => {
    const servers = db.getServers().filter(s => s.status === 'running' && s.nodeId);
    
    for (const server of servers) {
        try {
            const client = nodeManager.getClient(server.nodeId);
            if (!client || !client.isConnected()) continue;
            
            const result = await client.getVMStats(server.id);
            if (result && result.stats) {
                db.addMetric(server.id, {
                    cpu: result.stats.cpuUsage || 0,
                    memoryUsed: result.stats.memory?.actual || 0,
                    memoryTotal: result.stats.memory?.configured || 0,
                    uptime: result.stats.uptime || 0
                });
            }
        } catch {}
    }
}, 60000);

// Alert checker (runs every 30 seconds)
setInterval(async () => {
    const servers = db.getServers();
    
    for (const server of servers) {
        const alerts = db.getServerAlerts(server.id);
        if (alerts.length === 0) continue;
        
        if (!server.nodeId || server.status !== 'running') continue;
        
        const client = nodeManager.getClient(server.nodeId);
        if (!client || !client.isConnected()) continue;
        
        let stats = null;
        try {
            const result = await client.getVMStats(server.id);
            stats = result?.stats;
        } catch {}
        if (!stats) continue;
        
        for (const alert of alerts) {
            let value = 0;
            if (alert.metric === 'cpu') {
                value = stats.cpuUsage || 0;
            } else if (alert.metric === 'memory' && stats.memory) {
                value = (stats.memory.actual / stats.memory.configured) * 100;
            }
            
            const shouldTrigger = alert.comparison === 'above' 
                ? value > alert.threshold 
                : value < alert.threshold;
            
            if (shouldTrigger && !alert.triggered) {
                db.updateAlert(alert.id, { triggered: true, lastTriggered: new Date().toISOString() });
                
                triggerWebhooks('alert_triggered', {
                    alertId: alert.id,
                    serverId: server.id,
                    serverName: server.name,
                    metric: alert.metric,
                    value,
                    threshold: alert.threshold
                });
                
                audit(alert.userId, 'system', 'alert_triggered', {
                    alertId: alert.id,
                    serverId: server.id,
                    metric: alert.metric,
                    value
                });
                
                if (alert.action === 'stop') {
                    client.stopVM(server.id).catch(() => {});
                    db.updateServer(server.id, { status: 'stopped' });
                }
            } else if (!shouldTrigger && alert.triggered) {
                db.updateAlert(alert.id, { triggered: false });
            }
        }
    }
}, 30000);

// =====================
// TRANSFER VM (Admin)
// =====================

app.post('/api/admin/server/:id/transfer', requireAdmin, async (req, res) => {
    const { newOwnerId } = req.body;
    
    const server = db.getServer(req.params.id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }
    
    const newOwner = db.findUserById(newOwnerId);
    if (!newOwner) {
        return res.status(404).json({ error: 'New owner not found' });
    }
    
    if (server.status === 'running') {
        return res.status(400).json({ error: 'Stop the VM before transferring' });
    }
    
    const oldOwnerId = server.ownerId;
    const oldOwner = db.findUserById(oldOwnerId);
    
    // Move files
    const oldPath = path.join(DATA_DIR, 'users', oldOwnerId, server.id);
    const newPath = path.join(DATA_DIR, 'users', newOwnerId, server.id);
    
    try {
        await fs.ensureDir(path.join(DATA_DIR, 'users', newOwnerId));
        await fs.move(oldPath, newPath);
    } catch (err) {
        return res.status(500).json({ error: 'Failed to move VM files: ' + err.message });
    }
    
    db.updateServer(server.id, { ownerId: newOwnerId });
    
    audit(req.user.id, req.user.username, 'vm_transfer', {
        serverId: server.id,
        serverName: server.name,
        fromUser: oldOwner?.username,
        toUser: newOwner.username
    });
    
    res.json({ 
        success: true, 
        message: `VM transferred from ${oldOwner?.username} to ${newOwner.username}` 
    });
});

// =====================
// MAINTENANCE MODE
// =====================

app.get('/api/admin/settings', requireAdmin, (req, res) => {
    const settings = db.getSettings();
    res.json({
        registrationDisabled: settings.registrationDisabled || false,
        maintenance: settings.maintenance || false,
        maintenanceMessage: settings.maintenanceMessage || 'System is under maintenance'
    });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const { registrationDisabled } = req.body;
    
    const updates = {};
    if (typeof registrationDisabled === 'boolean') {
        updates.registrationDisabled = registrationDisabled;
    }
    
    db.updateSettings(updates);
    audit(req.user.id, req.user.username, 'settings_updated', updates);
    log(`Settings updated by ${req.user.username}: ${JSON.stringify(updates)}`);
    
    res.json({ success: true, ...db.getSettings() });
});

app.get('/api/admin/maintenance', requireAdmin, (req, res) => {
    const settings = db.getSettings();
    res.json({ 
        maintenance: settings.maintenance || false,
        message: settings.maintenanceMessage || 'System is under maintenance'
    });
});

app.post('/api/admin/maintenance', requireAdmin, (req, res) => {
    const { enabled, message, stopAllVms } = req.body;
    
    const updates = {
        maintenance: !!enabled,
        maintenanceMessage: message || 'System is under maintenance',
        maintenanceStarted: enabled ? new Date().toISOString() : null
    };
    
    db.updateSettings(updates);
    
    if (enabled && stopAllVms) {
        const servers = db.getServers().filter(s => s.status === 'running' && s.nodeId);
        let stopped = 0;
        for (const s of servers) {
            const client = nodeManager.getClient(s.nodeId);
            if (client && client.isConnected()) {
                client.stopVM(s.id).catch(() => {});
                db.updateServer(s.id, { status: 'stopped' });
                stopped++;
            }
        }
        log(`Maintenance mode: stopped ${stopped} VMs`);
    }
    
    audit(req.user.id, req.user.username, enabled ? 'maintenance_enabled' : 'maintenance_disabled');
    log(`Maintenance mode ${enabled ? 'ENABLED' : 'DISABLED'} by ${req.user.username}`);
    
    res.json({ success: true, ...updates });
});

// Maintenance mode middleware
app.use('/api', (req, res, next) => {
    // Skip for admin and auth routes
    if (req.path.startsWith('/api/admin') || 
        req.path === '/api/login' || 
        req.path === '/api/me' ||
        req.path === '/api/maintenance-status') {
        return next();
    }
    
    const settings = db.getSettings();
    if (settings.maintenance) {
        // Allow admins through
        if (req.user && req.user.role === 'admin') {
            return next();
        }
        return res.status(503).json({ 
            error: 'maintenance',
            message: settings.maintenanceMessage || 'System is under maintenance'
        });
    }
    next();
});

// Public maintenance status endpoint
app.get('/api/maintenance-status', (req, res) => {
    const settings = db.getSettings();
    res.json({ 
        maintenance: settings.maintenance || false,
        message: settings.maintenance ? (settings.maintenanceMessage || 'System is under maintenance') : null
    });
});

// =====================
// VM HTTP PROXY - /s/:serverId/*
// =====================

async function proxyToVm(req, res, serverId, useHttps = true) {
    const serverData = db.getServer(serverId);
    if (!serverData) {
        return res.status(404).json({ error: 'Server not found' });
    }
    
    if (serverData.status !== 'running') {
        return res.status(503).json({ error: 'VM is not running' });
    }
    
    if (!serverData.nodeId) {
        return res.status(503).json({ error: 'Server has no node assigned' });
    }
    
    // VM proxy not available for node-based servers through this endpoint
    if (serverData.nodeId) {
        return res.status(503).send(`<!DOCTYPE html>
<html><head><title>Proxy Not Ready</title>
<style>body{font-family:system-ui;max-width:600px;margin:50px auto;padding:20px;text-align:center}
h1{color:#e74c3c}code{background:#f1f1f1;padding:2px 8px;border-radius:4px}
button{margin-top:20px;padding:10px 20px;cursor:pointer}</style></head>
<body><h1>VM Proxy Not Ready</h1>
<p>The VM is not running or web server is not available.</p>
<p>Make sure your VM has a web server running on port 80:</p>
<ul style="text-align:left">
<li><code>python3 -m http.server 80</code></li>
<li><code>nginx</code> or <code>apache2</code></li>
</ul>
<button onclick="location.reload()">Retry</button>
</body></html>`);
    }
    
    const targetPath = req.url.replace(`/s/${serverId}`, '') || '/';
    
    const proxyOptions = {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers },
        rejectUnauthorized: false
    };
    
    delete proxyOptions.headers['host'];
    proxyOptions.headers['host'] = req.headers.host || `127.0.0.1:${proxyPort}`;
    proxyOptions.headers['x-forwarded-for'] = req.ip;
    proxyOptions.headers['x-forwarded-proto'] = req.protocol;
    proxyOptions.headers['x-real-ip'] = req.ip;
    proxyOptions.headers['x-forwarded-host'] = req.headers.host;
    proxyOptions.headers['x-forwarded-prefix'] = `/s/${serverId}`;
    
    const proxyReq = http.request(proxyOptions, (proxyRes) => {
        // Rewrite location headers for redirects
        const location = proxyRes.headers['location'];
        if (location && location.startsWith('/')) {
            proxyRes.headers['location'] = `/s/${serverId}${location}`;
        }
        
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
    });
    
    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.status(502).send(`<!DOCTYPE html>
<html><head><title>502 Bad Gateway</title>
<style>body{font-family:system-ui;max-width:600px;margin:50px auto;padding:20px;text-align:center}
h1{color:#e74c3c}pre{background:#f1f1f1;padding:10px;border-radius:4px;text-align:left;overflow:auto}</style></head>
<body><h1>502 Bad Gateway</h1>
<p>The VM is not responding on port 80.</p>
<pre>${err.message}</pre>
<button onclick="location.reload()">Retry</button>
</body></html>`);
        }
    });
    
    req.pipe(proxyReq);
}

app.use('/s/:serverId', async (req, res, next) => {
    if (req.path === '/' || req.path === '') {
        return proxyToVm(req, res, req.params.serverId);
    }
    return proxyToVm(req, res, req.params.serverId);
});

// =====================
// CATCH-ALL
// =====================

app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

// =====================
// GRACEFUL SHUTDOWN
// =====================

process.on('SIGTERM', () => {
    console.log();
    logWarn('Received SIGTERM, shutting down...');
    nodeManager.shutdown();
    server.close(() => {
        logSuccess('Panel stopped');
        console.log();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log();
    logWarn('Received SIGINT, shutting down...');
    nodeManager.shutdown();
    server.close(() => {
        logSuccess('Panel stopped');
        console.log();
        process.exit(0);
    });
});

function printBanner() {
    console.log();
    console.log(`  ${c.bold}${c.cyan}V87${c.reset} ${c.dim}Panel Server${c.reset}`);
    console.log(`  ${c.dim}────────────────────────────${c.reset}`);
    console.log();
    console.log(`  ${c.bold}Configuration${c.reset}`);
    console.log(`  ${c.dim}─────────────────────────────${c.reset}`);
    console.log(`  ${c.dim}Port${c.reset}      ${c.cyan}${PORT}${c.reset}`);
    console.log(`  ${c.dim}Nodes${c.reset}     ${c.cyan}${db.getNodes().filter(n => n.enabled).length}${c.reset} ${c.dim}enabled${c.reset}`);
    console.log();
}

server.listen(PORT, () => {
    printBanner();
    logSuccess(`Listening on ${c.cyan}http://localhost:${PORT}${c.reset}`);
    initializeNodes();
    console.log();
});
