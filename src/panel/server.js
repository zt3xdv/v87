import express from 'express';
import bcrypt from 'bcryptjs';
import http from 'node:http';
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
import { requireAuth, requireAdmin } from './utils/authMiddleware.js';
import { SandboxManager } from '../sandbox/sandbox-manager.js';
import { getImages, getImage } from '../sandbox/images.js';

const TERM_GRAY = "\x1b[90m";
const TERM_RESET = "\x1b[0m";

function log(message) {
    const now = new Date();
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = String(now.getFullYear()).slice(-2);
    const H = String(now.getHours()).padStart(2, '0');
    const M = String(now.getMinutes()).padStart(2, '0');
    const S = String(now.getSeconds()).padStart(2, '0');
    
    console.log(`${TERM_GRAY}${H}:${M}:${S} ${d}/${m}/${y} ${TERM_RESET}${message}`);
}

let config;
try {
    config = require('../../config.json');
} catch (e) {
    config = { 
        port: 3000,
        limits: { maxServers: 3, maxRam: 2048, maxDisk: 50 },
        vm: { defaultImage: 'fedora-40', defaultRam: 1024, defaultDisk: '10G' }
    };
    log('Warning: config.json not found, using defaults.');
}

if (config.secretKey === 'v87-change-me-in-prod') {
    log('\x1b[33m⚠️  WARNING: Using default secretKey! Change it in config.json for production.\x1b[0m');
}

const sandboxManager = new SandboxManager({
    maxMemoryMB: config.vm?.maxMemoryMB || 1024,
    cpuCores: config.vm?.cpuCores || 2,
    timeout: config.vm?.timeout || 0,
    qemuPath: config.vm?.qemuPath || 'qemu-system-x86_64',
    enableKvm: config.vm?.enableKvm === true
});

let DATA_DIR = path.join(__dirname, '../../data');

if (os.platform() === 'android') {
    log('Running on android: using home path due to software limitations.');
    DATA_DIR = path.join(os.homedir(), './v87/data');
}

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

io.on('connection', (socket) => {
    log(`Socket connected: ${socket.user.username} (${socket.id})`);
    
    socket.on('join-server', async (serverId) => {
        const serverData = db.getServer(serverId);
        if (!serverData) return;
        
        if (serverData.ownerId !== socket.user.id && socket.user.role !== 'admin') {
            return socket.emit('error', 'Access denied');
        }
        
        socket.join(`server:${serverId}`);
        log(`${socket.user.username} joined server ${serverId}`);
        
        const status = sandboxManager.getServerStatus(serverId);
        socket.emit('vm-status', status === 'running' ? 'started' : 'stopped');
        
        try {
            const logs = await sandboxManager.getServerLogs(serverId, 100);
            if (logs) {
                socket.emit('term-data', logs);
            }
        } catch (err) {}
    });
    
    socket.on('input', async (data) => {
        const { serverId, data: inputData } = data;
        const serverData = db.getServer(serverId);
        if (!serverData) return;
        
        if (serverData.ownerId !== socket.user.id && socket.user.role !== 'admin') {
            return;
        }
        
        sandboxManager.sendInput(serverId, inputData);
    });
    
    socket.on('leave-server', (serverId) => {
        socket.leave(`server:${serverId}`);
    });
    
    socket.on('disconnect', () => {
        log(`Socket disconnected: ${socket.user.username}`);
    });
});

sandboxManager.on('log', (serverId, data) => {
    io.to(`server:${serverId}`).emit('term-data', data);
});

sandboxManager.on('exit', (serverId, code) => {
    io.to(`server:${serverId}`).emit('vm-status', 'stopped');
    io.to(`server:${serverId}`).emit('term-data', `\r\n[VM exited with code ${code}]\r\n`);
    db.updateServer(serverId, { status: 'stopped' });
});

sandboxManager.on('error', (serverId, error) => {
    io.to(`server:${serverId}`).emit('term-data', `\r\n[Error: ${error}]\r\n`);
});

const creationProgress = new Map();

sandboxManager.on('creation-progress', (serverId, progress) => {
    creationProgress.set(serverId, progress);
});

const PORT = config.port || process.env.PORT || 3000;

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(DATA_DIR, 'users'));
fs.ensureDirSync(path.join(DATA_DIR, 'images'));

app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let LIMITS = config.limits || { maxServers: 3, maxRam: 2048, maxDisk: 50 };

function getUserLimits(user) {
    if (user.limits && Object.keys(user.limits).length > 0) {
        return {
            maxServers: user.limits.maxServers || LIMITS.maxServers,
            maxRam: user.limits.maxRam || LIMITS.maxRam,
            maxDisk: user.limits.maxDisk || LIMITS.maxDisk
        };
    }
    return LIMITS;
}

// =====================
// AUTH
// =====================

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.findUser(username);
    if (user && bcrypt.compareSync(password, user.password)) {
        if (user.suspended) {
            return res.status(403).json({ error: 'Account suspended: ' + (user.suspendReason || 'Contact administrator') });
        }
        const token = generateToken(user);
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role }, token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (db.findUser(username)) {
        return res.status(400).json({ error: 'Username taken' });
    }
    const hashedPassword = bcrypt.hashSync(password, 10);
    const isFirstUser = db.getUsers().length === 0;
    const user = {
        id: Date.now().toString(),
        username,
        password: hashedPassword,
        role: isFirstUser ? 'admin' : 'user',
        created_at: new Date()
    };
    db.createUser(user);
    fs.ensureDirSync(path.join(DATA_DIR, 'users', user.id));
    
    const token = generateToken(user);
    res.json({ success: true, user: { id: user.id, username: user.username }, token });
});

app.post('/api/logout', (req, res) => {
    res.json({ success: true });
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
    
    const totalRam = servers.reduce((acc, s) => acc + (s.ram || 1024), 0);
    
    const serversWithStatus = servers.map(s => ({
        ...s,
        status: sandboxManager.getServerStatus(s.id),
        image: getImage(s.imageId)?.name || 'Unknown'
    }));
    
    res.json({ 
        servers: serversWithStatus,
        stats: {
            totalRam,
            slotsUsed: servers.length,
            slotsMax: userLimits.maxServers,
            maxRam: userLimits.maxRam,
            maxDisk: userLimits.maxDisk
        }
    });
});

app.post('/api/server/create', requireAuth, async (req, res, next) => {
    try {
        const { name, description, imageId, ram, diskSize } = req.body;
        const user = db.findUserById(req.user.id);
        const servers = db.getUserServers(user.id);
        const userLimits = getUserLimits(user);
        
        const image = getImage(imageId || config.vm?.defaultImage || 'fedora-40');
        if (!image) return res.status(400).json({ error: 'Invalid image' });
        
        if (req.user.role !== 'admin') {
            if (servers.length >= userLimits.maxServers) {
                return res.status(400).json({ error: `Max ${userLimits.maxServers} servers reached` });
            }
        }
        
        const serverId = Date.now().toString();
        const serverData = {
            id: serverId,
            ownerId: user.id,
            name: name || 'My VM',
            description: description || '',
            imageId: image.id,
            ram: ram || config.vm?.defaultRam || 1024,
            diskSize: diskSize || config.vm?.defaultDisk || '10G',
            created_at: new Date(),
            status: 'creating'
        };
        
        db.addServer(serverData);
        log(`Server ${serverId} creation started for user ${user.username}`);
        
        sandboxManager.createServer(user.id, serverId, {
            imageId: image.id,
            ram: serverData.ram,
            diskSize: serverData.diskSize
        }).then(() => {
            db.updateServer(serverId, { status: 'stopped' });
            log(`Server ${serverId} created successfully`);
        }).catch((err) => {
            db.updateServer(serverId, { status: 'error', error: err.message });
            log(`Server ${serverId} creation failed: ${err.message}`);
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

app.get('/api/server/:id', requireAuth, async (req, res) => {
    const serverData = db.getServer(req.params.id);
    if (!serverData) return res.status(404).json({ error: 'Server not found' });
    if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    const image = getImage(serverData.imageId);
    
    // Read credentials from metadata
    let credentials = null;
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

    res.json({ 
        server: {
            ...serverData,
            status: sandboxManager.getServerStatus(serverData.id)
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
        await sandboxManager.startServer(serverData.ownerId, serverId);
        
        db.updateServer(serverId, { status: 'running' });
        io.to(`server:${serverId}`).emit('vm-status', 'started');
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

        sandboxManager.stopServer(serverId);
        
        db.updateServer(serverId, { status: 'stopped' });
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
        
        sandboxManager.stopServer(serverId);
        await sandboxManager.deleteServer(serverData.ownerId, serverId);
        
        db.deleteServer(serverId);
        res.json({ success: true });
        
    } catch (err) {
        next(err);
    }
});

app.get('/api/server/:id/logs', requireAuth, async (req, res, next) => {
    try {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const logs = await sandboxManager.getServerLogs(req.params.id);
        res.json({ logs });
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

// =====================
// ADMIN ROUTES
// =====================

app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const stats = db.getStats();
    const runningServers = sandboxManager.getRunningServers().length;
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
            status: sandboxManager.getServerStatus(s.id),
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
            status: sandboxManager.getServerStatus(s.id)
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
            sandboxManager.stopServer(s.id);
            await sandboxManager.deleteServer(user.id, s.id);
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
        
        res.json({
            ...serverData,
            status: sandboxManager.getServerStatus(serverData.id),
            ownerName: owner?.username || 'Unknown',
            imageName: image?.name || 'Unknown'
        });
    } catch (err) {
        next(err);
    }
});

app.post('/api/admin/server/:id', requireAdmin, async (req, res, next) => {
    try {
        const { name, description } = req.body;
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        
        const updated = db.updateServer(req.params.id, updates);
        res.json({ success: true, server: updated });
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
        
        if (suspended && sandboxManager.getServerStatus(serverData.id) === 'running') {
            sandboxManager.stopServer(serverData.id);
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
        
        sandboxManager.stopServer(serverData.id);
        
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
        
        sandboxManager.stopServer(serverData.id);
        await sandboxManager.deleteServer(serverData.ownerId, serverData.id);
        
        db.deleteServer(req.params.id);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// =====================
// CATCH-ALL
// =====================

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

// =====================
// GRACEFUL SHUTDOWN
// =====================

process.on('SIGTERM', () => {
    log('SIGTERM received, shutting down...');
    sandboxManager.shutdown();
    server.close(() => {
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    log('SIGINT received, shutting down...');
    sandboxManager.shutdown();
    server.close(() => {
        process.exit(0);
    });
});

server.listen(PORT, () => {
    log(`V87 Panel running on port ${PORT}`);
    log(`VM mode: QEMU + virt-builder`);
    log(`Available images: ${getImages().map(i => i.id).join(', ')}`);
});
