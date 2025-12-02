import express from 'express';
import bcrypt from 'bcryptjs';
import http from 'node:http';
import { Server } from "socket.io";
import path from 'node:path';
import fs from 'fs-extra';
import multer from 'multer';
import { spawn } from 'node:child_process';
import db from './db.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { getDirSize } from './utils/fileUtils.js';
import { generateToken, verifyToken } from './utils/token.js';
import { requireAuth, requireAdmin } from './utils/authMiddleware.js';

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

// Load Config
let config;
try {
    config = require('../../config.json');
} catch (e) {
    config = { 
        port: 3000, 
        limits: { maxServers: 3, maxRam: 1024, maxStorage: 1024 } 
    };
    log('Warning: config.json not found, using defaults.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = config.port || process.env.PORT || 3000;

// Fixed Data Directories
const USER_DATA_DIR = path.join(__dirname, '../../data/users_data');
const UPLOADS_DIR = path.join(__dirname, '../../data/uploads');

fs.ensureDirSync(USER_DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);

const runningVMs = new Map();

app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({ dest: UPLOADS_DIR });

// Limits Helper
const LIMITS = config.limits || { maxServers: 3, maxRam: 1024, maxStorage: 1024 };

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.findUser(username);
    if (user && bcrypt.compareSync(password, user.password)) {
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
    fs.ensureDirSync(path.join(USER_DATA_DIR, user.username));
    
    const token = generateToken(user);
    res.json({ success: true, user: { id: user.id, username: user.username }, token });
});

app.post('/api/logout', (req, res) => {
    res.json({ success: true });
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
    const user = db.findUserById(req.user.id);
    const servers = db.getUserServers(user.id);
    
    const totalRam = servers.reduce((acc, s) => acc + s.ram, 0);
    let totalStorage = 0;
    for (const s of servers) {
        const serverDir = path.join(USER_DATA_DIR, user.username, 'servers', s.id, 'root');
        totalStorage += await getDirSize(serverDir);
    }
    
    res.json({ 
        servers: servers.map(s => ({...s, isRunning: runningVMs.has(s.id)})),
        stats: {
            totalRam,
            totalStorage,
            slotsUsed: servers.length,
            slotsMax: LIMITS.maxServers
        }
    });
});

app.post('/api/server/create', requireAuth, async (req, res) => {
    const { name, description, ram, diskSize } = req.body;
    const user = db.findUserById(req.user.id);
    const servers = db.getUserServers(user.id);
    const ramNum = parseInt(ram);
    
    if (req.user.role !== 'admin') {
        if (servers.length >= LIMITS.maxServers) return res.status(400).json({ error: `Max ${LIMITS.maxServers} servers reached` });
        
        const totalRam = servers.reduce((acc, s) => acc + s.ram, 0);
        if (totalRam + ramNum > LIMITS.maxRam) return res.status(400).json({ error: `Max ${LIMITS.maxRam}MB RAM limit reached` });
        if (ramNum < 512) return res.status(400).json({ error: `Virtual Machine needs atleast 512mb to run.` });
    }
    
    const server = {
        id: Date.now().toString(),
        ownerId: user.id,
        name,
        description,
        ram: ramNum,
        diskSize: parseInt(diskSize),
        created_at: new Date()
    };
    
    const serverPath = path.join(USER_DATA_DIR, user.username, 'servers', server.id);
    await fs.ensureDir(path.join(serverPath, 'root'));
    await fs.ensureDir(path.join(serverPath, 'vm'));
    
    db.addServer(server);
    res.json({ success: true, server });
});

app.get('/api/server/:id', requireAuth, async (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    
    const owner = db.findUserById(server.ownerId);
    const serverDir = path.join(USER_DATA_DIR, owner.username, 'servers', server.id, 'root');
    const diskUsed = await getDirSize(serverDir);

    res.json({ 
        server: { ...server, diskUsed }, 
        isRunning: runningVMs.has(server.id) 
    });
});

app.post('/api/server/:id/start', requireAuth, (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    
    if (runningVMs.has(serverId)) return res.status(400).json({ error: 'Already running' });
    
    const owner = db.findUserById(server.ownerId);
    const serverDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId);
    
    const vmRunner = path.join(__dirname, 'vm_runner.js');
    const child = spawn('node', [vmRunner, server.ram.toString()], {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    
    runningVMs.set(serverId, { process: child, lastDiskUsage: 0, lastDiskCheck: 0 });
    
    child.stdout.on('data', (data) => {
        io.to(serverId).emit('term-data', data.toString());
    });
    
    child.stderr.on('data', (data) => {
        io.to(serverId).emit('term-data', data.toString());
    });
    
    child.on('message', async (msg) => {
        if (msg.type === 'stats') {
            const vm = runningVMs.get(serverId);
            if (vm) {
                const now = Date.now();
                if (now - vm.lastDiskCheck > 10000) {
                    try {
                        const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
                        vm.lastDiskUsage = await getDirSize(rootDir);
                        vm.lastDiskCheck = now;
                    } catch (e) {}
                }
                
                io.to(serverId).emit('stats', {
                    ram: msg.ram,
                    disk: vm.lastDiskUsage,
                    netRx: msg.netRx,
                    netTx: msg.netTx
                });
            }
        }
    });

    child.on('close', (code) => {
        runningVMs.delete(serverId);
        io.to(serverId).emit('vm-status', 'stopped');
    });
    
    res.json({ status: 'started' });
});

app.post('/api/server/:id/stop', requireAuth, (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

    const vm = runningVMs.get(serverId);
    if (vm) {
        vm.process.kill();
    }
    res.json({ status: 'stopped' });
});

app.post('/api/server/:id/startup', requireAuth, async (req, res) => {
    const serverId = req.params.id;
    const { ram, diskSize } = req.body;
    
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

    if (runningVMs.has(serverId)) return res.status(400).json({ error: 'Cannot update startup settings while server is running' });

    // Validate RAM limit
    if (req.user.role !== 'admin') {
        const servers = db.getUserServers(req.user.id);
        const totalRam = servers.reduce((acc, s) => acc + (s.id === serverId ? 0 : s.ram), 0);
        const newRam = parseInt(ram);
        
        if (totalRam + newRam > LIMITS.maxRam) {
            return res.status(400).json({ error: `Max ${LIMITS.maxRam}MB RAM limit reached` });
        }
        if (ramNum < 512) {
          return res.status(400).json({ error: `Virtual Machine needs atleast 512mb to run.` });
        }
    }

    const updates = {
        ram: parseInt(ram),
        diskSize: parseInt(diskSize) // We update the record, though physical resize logic isn't implemented yet
    };
    
    const updated = db.updateServer(serverId, updates);
    res.json({ success: true, server: updated });
});

app.post('/api/server/:id/settings', requireAuth, (req, res) => {
    const serverId = req.params.id;
    const { name, description } = req.body;
    
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

    const updates = { name, description };
    const updated = db.updateServer(serverId, updates);
    res.json({ success: true, server: updated });
});

app.get('/api/server/:id/files', requireAuth, async (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    
    const owner = db.findUserById(server.ownerId);
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    const relPath = req.query.path || '';
    const targetDir = path.join(rootDir, relPath);
    
    if (!targetDir.startsWith(rootDir)) return res.status(403).json({ error: 'Traversal detected' });
    
    try {
        if (!fs.existsSync(targetDir)) {
             return res.json([]);
        }
        const files = await fs.readdir(targetDir, { withFileTypes: true });
        const fileList = files.map(f => ({
            name: f.name,
            isDirectory: f.isDirectory(),
            size: f.isDirectory() ? 0 : fs.statSync(path.join(targetDir, f.name)).size
        }));
        res.json(fileList);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/server/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    
    const owner = db.findUserById(server.ownerId);
    
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    const relPath = req.body.path || '';
    const targetPath = path.join(rootDir, relPath, req.file.originalname);
    
    if (!targetPath.startsWith(rootDir)) return res.status(403).json({ error: 'Access denied' });

    // Bypass quota for admin
    if (req.user.role !== 'admin') {
        const currentSize = await getDirSize(path.join(USER_DATA_DIR, owner.username));
        const maxBytes = LIMITS.maxStorage * 1024 * 1024;
        if (currentSize + req.file.size > maxBytes) {
            await fs.unlink(req.file.path);
            return res.status(400).json({ error: 'Quota exceeded' });
        }
    }
    
    await fs.move(req.file.path, targetPath, { overwrite: true });
    res.json({ success: true });
});

app.get('/api/server/:id/download', requireAuth, (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });

    const owner = db.findUserById(server.ownerId);
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    const filePath = req.query.path || '';
    const fullPath = path.join(rootDir, filePath);

    if (!fullPath.startsWith(rootDir) || !fs.existsSync(fullPath)) {
        return res.status(404).send('File not found');
    }
    
    res.download(fullPath);
});

app.get('/api/server/:id/read-file', requireAuth, async (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Denied' });

    const owner = db.findUserById(server.ownerId);
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    const filePath = req.query.path || '';
    const fullPath = path.join(rootDir, filePath);

    if (!fullPath.startsWith(rootDir)) return res.status(403).json({ error: 'Denied' });
    
    try {
        if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'Not found' });
        const stat = await fs.stat(fullPath);
        if (stat.size > 1024 * 1024 * 5) return res.status(400).json({ error: 'File too large to edit' });
        
        const content = await fs.readFile(fullPath, 'utf8');
        res.json({ content });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/server/:id/save-file', requireAuth, async (req, res) => {
    const { path: filePath, content } = req.body;
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Denied' });

    const owner = db.findUserById(server.ownerId);
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    const fullPath = path.join(rootDir, filePath);

    if (!fullPath.startsWith(rootDir)) return res.status(403).json({ error: 'Denied' });

    try {
        await fs.writeFile(fullPath, content, 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/server/:id/create-entry', requireAuth, async (req, res) => {
    const { type, name, path: currentPath } = req.body; 
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Denied' });

    const owner = db.findUserById(server.ownerId);
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    const fullPath = path.join(rootDir, currentPath, name);

    if (!fullPath.startsWith(rootDir)) return res.status(403).json({ error: 'Denied' });

    try {
        if (fs.existsSync(fullPath)) return res.status(400).json({ error: 'Exists already' });
        
        if (type === 'folder') {
            await fs.ensureDir(fullPath);
        } else {
            await fs.writeFile(fullPath, '');
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/server/:id/file-action', requireAuth, async (req, res) => {
    const { action, path: filePath, newPath } = req.body;
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Denied' });

    const owner = db.findUserById(server.ownerId);
    const rootDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId, 'root');
    
    const fullPath = path.join(rootDir, filePath);
    if (!fullPath.startsWith(rootDir)) return res.status(403).json({ error: 'Denied' });
    
    try {
        if (action === 'delete') {
            await fs.remove(fullPath);
        } else if (action === 'rename') {
             const fullNewPath = path.join(rootDir, newPath);
             if (!fullNewPath.startsWith(rootDir)) return res.status(403).json({ error: 'Denied' });
             await fs.rename(fullPath, fullNewPath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin Routes
app.get('/api/admin/servers', requireAdmin, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const servers = db.getServers();
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const results = servers.slice(startIndex, endIndex);
    
    // Enrich with owner info
    const enrichedServers = results.map(s => {
        const owner = db.findUserById(s.ownerId);
        return {
            ...s,
            ownerName: owner ? owner.username : 'Unknown',
            isRunning: runningVMs.has(s.id)
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
    res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at })));
});

app.delete('/api/server/:id', requireAuth, async (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    // Stop if running
    const vm = runningVMs.get(serverId);
    if (vm) {
        vm.process.kill();
        runningVMs.delete(serverId);
    }
    
    // Delete files
    const owner = db.findUserById(server.ownerId);
    if (owner) {
        const serverDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId);
        await fs.remove(serverDir);
    }
    
    db.deleteServer(serverId);
    res.json({ success: true });
});

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("unauthorized"));
    const user = verifyToken(token);
    if (!user) return next(new Error("unauthorized"));
    socket.user = user;
    next();
});

io.on('connection', (socket) => {
    socket.on('join-server', (serverId) => {
         const server = db.getServer(serverId);
         if (server && (server.ownerId === socket.user.id || socket.user.role === 'admin')) {
            socket.join(serverId);
         }
    });
    socket.on('input', ({ serverId, data }) => {
        const server = db.getServer(serverId);
        if (server && (server.ownerId === socket.user.id || socket.user.role === 'admin')) {
            const vm = runningVMs.get(serverId);
            if (vm) vm.process.stdin.write(data);
        }
    });
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

server.listen(PORT, () => {
    log(`Panel running on port ${PORT}`);
});
