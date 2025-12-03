import express from 'express';
import bcrypt from 'bcryptjs';
import http from 'node:http';
import { Server } from "socket.io";
import path from 'node:path';
import fs from 'fs-extra';
import zlib from 'node:zlib';
import multer from 'multer';
import db from './db.js';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { VMInstance } from './vm_runner.js';

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
const INITRD_PATH = path.join(__dirname, '../../vm/initrd/linux.img');

fs.ensureDirSync(USER_DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);

async function extractCpio(cpioData, destDir, perms, onProgress) {
    let offset = 0;
    let totalSize = cpioData.length;
    let fileCount = 0;
    
    while (offset < cpioData.length) {
        if (offset + 110 > cpioData.length) break;
        
        const magic = cpioData.toString('ascii', offset, offset + 6);
        if (magic !== '070701' && magic !== '070702') break;
        
        const uid = parseInt(cpioData.toString('ascii', offset + 22, offset + 30), 16);
        const gid = parseInt(cpioData.toString('ascii', offset + 30, offset + 38), 16);
        const nameSize = parseInt(cpioData.toString('ascii', offset + 94, offset + 102), 16);
        const mode = parseInt(cpioData.toString('ascii', offset + 14, offset + 22), 16);
        
        const headerSize = 110;
        const nameStart = offset + headerSize;
        const nameEnd = nameStart + nameSize - 1;
        const fileName = cpioData.toString('ascii', nameStart, nameEnd);
        
        if (fileName === 'TRAILER!!!') break;
        
        const namePadded = headerSize + nameSize;
        const namePaddedAligned = Math.ceil(namePadded / 4) * 4;
        const dataStart = offset + namePaddedAligned;
        
        const actualFileSize = parseInt(cpioData.toString('ascii', offset + 54, offset + 62), 16);
        const dataEnd = dataStart + actualFileSize;
        const dataPaddedAligned = Math.ceil((dataEnd - offset) / 4) * 4;
        
        if (fileName && fileName !== '.' && fileName !== '..') {
            const fullPath = path.join(destDir, fileName);
            const isDir = (mode & 0o170000) === 0o040000;
            const isFile = (mode & 0o170000) === 0o100000;
            const isSymlink = (mode & 0o170000) === 0o120000;
            
            perms[fileName] = { mode: mode & 0o7777, uid, gid };
            
            try {
                if (isDir) {
                    await fs.ensureDir(fullPath);
                } else if (isSymlink && actualFileSize > 0) {
                    const linkTarget = cpioData.toString('utf8', dataStart, dataStart + actualFileSize);
                    await fs.ensureDir(path.dirname(fullPath));
                    try {
                        await fs.symlink(linkTarget, fullPath);
                    } catch(e) {}
                } else if (isFile) {
                    await fs.ensureDir(path.dirname(fullPath));
                    const fileData = cpioData.subarray(dataStart, dataStart + actualFileSize);
                    await fs.writeFile(fullPath, fileData);
                }
            } catch(e) {}
            
            fileCount++;
            if (onProgress && fileCount % 50 === 0) {
                onProgress(Math.round((offset / totalSize) * 100), fileName);
            }
        }
        
        offset += dataPaddedAligned;
        if (offset <= 0) break;
    }
    
    if (onProgress) onProgress(100, 'Complete');
}

async function extractInitrd(serverDir, onProgress) {
    try {
        const destDir = path.join(serverDir, 'root');
        const permsFile = path.join(serverDir, 'permissions.json');
        
        if (onProgress) onProgress(5, 'Reading initrd...');
        const compressed = await fs.readFile(INITRD_PATH);
        
        if (onProgress) onProgress(15, 'Decompressing...');
        const decompressed = zlib.gunzipSync(compressed);
        
        if (onProgress) onProgress(25, 'Extracting files...');
        const perms = {};
        await extractCpio(decompressed, destDir, perms, (pct, file) => {
            if (onProgress) onProgress(25 + Math.round(pct * 0.70), file);
        });
        
        if (onProgress) onProgress(98, 'Saving permissions...');
        await fs.writeFile(permsFile, JSON.stringify(perms));
        
        if (onProgress) onProgress(100, 'Complete');
        return true;
    } catch(e) {
        log(`Error extracting initrd: ${e.message}`);
        return false;
    }
}

const creationProgress = new Map();

const runningVMs = new Map();

app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const upload = multer({ dest: UPLOADS_DIR });

// Limits Helper
let LIMITS = config.limits || { maxServers: 3, maxRam: 1024, maxStorage: 1024 };

// Get user-specific limits or fall back to global
function getUserLimits(user) {
    if (user.limits && Object.keys(user.limits).length > 0) {
        return {
            maxServers: user.limits.maxServers || LIMITS.maxServers,
            maxRam: user.limits.maxRam || LIMITS.maxRam,
            maxStorage: user.limits.maxStorage || LIMITS.maxStorage
        };
    }
    return LIMITS;
}

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
    const userLimits = getUserLimits(user);
    
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
            slotsMax: userLimits.maxServers,
            maxRam: userLimits.maxRam,
            maxStorage: userLimits.maxStorage
        }
    });
});

app.post('/api/server/create', requireAuth, async (req, res) => {
    const { name, description, ram, diskSize } = req.body;
    const user = db.findUserById(req.user.id);
    const servers = db.getUserServers(user.id);
    const ramNum = parseInt(ram);
    const userLimits = getUserLimits(user);
    
    if (req.user.role !== 'admin') {
        if (servers.length >= userLimits.maxServers) return res.status(400).json({ error: `Max ${userLimits.maxServers} servers reached` });
        
        const totalRam = servers.reduce((acc, s) => acc + s.ram, 0);
        if (totalRam + ramNum > userLimits.maxRam) return res.status(400).json({ error: `Max ${userLimits.maxRam}MB RAM limit reached` });
        if (ramNum < 512) return res.status(400).json({ error: `Virtual Machine needs atleast 512mb to run.` });
    }
    
    const server = {
        id: Date.now().toString(),
        ownerId: user.id,
        name,
        description,
        ram: ramNum,
        diskSize: parseInt(diskSize),
        created_at: new Date(),
        status: 'creating'
    };
    
    db.addServer(server);
    creationProgress.set(server.id, { percent: 0, status: 'Initializing...' });
    
    res.json({ success: true, server, creating: true });
    
    const serverPath = path.join(USER_DATA_DIR, user.username, 'servers', server.id);
    await fs.ensureDir(path.join(serverPath, 'root'));
    
    log(`Extracting initrd for server ${server.id}...`);
    await extractInitrd(serverPath, (percent, status) => {
        creationProgress.set(server.id, { percent, status });
    });
    log(`Server ${server.id} created successfully`);
    
    db.updateServer(server.id, { status: 'ready' });
    creationProgress.delete(server.id);
});

app.get('/api/server/:id/creation-progress', requireAuth, (req, res) => {
    const serverId = req.params.id;
    const server = db.getServer(serverId);
    if (!server) return res.status(404).json({ error: 'Not found' });
    if (server.ownerId !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    
    const progress = creationProgress.get(serverId);
    if (!progress) {
        return res.json({ complete: true, percent: 100, status: 'Ready' });
    }
    
    res.json({ complete: false, ...progress });
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
    
    // Check if server is suspended
    if (server.suspended) {
        return res.status(403).json({ error: 'Server suspended: ' + (server.suspendReason || 'Contact administrator') });
    }
    
    // Check if owner is suspended
    const owner = db.findUserById(server.ownerId);
    if (owner && owner.suspended) {
        return res.status(403).json({ error: 'Account suspended' });
    }
    
    if (runningVMs.has(serverId)) return res.status(400).json({ error: 'Already running' });
    
    const serverDir = path.join(USER_DATA_DIR, owner.username, 'servers', serverId);
    
    const vmInstance = new VMInstance({
        memorySize: server.ram,
        cwd: serverDir,
        onOutput: (chr) => {
            io.to(serverId).emit('term-data', chr);
        },
        onStats: async (msg) => {
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
                    cpu: msg.cpu || 0,
                    ips: msg.ips || 0,
                    disk: vm.lastDiskUsage,
                    netRx: msg.netRx,
                    netTx: msg.netTx
                });
            }
        },
        onClose: () => {
            runningVMs.delete(serverId);
            io.to(serverId).emit('vm-status', 'stopped');
        }
    });
    
    runningVMs.set(serverId, { instance: vmInstance, lastDiskUsage: 0, lastDiskCheck: 0 });
    
    vmInstance.start().catch(err => {
        log(`Error starting VM ${serverId}: ${err.message}`);
        runningVMs.delete(serverId);
        io.to(serverId).emit('vm-status', 'error');
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
        vm.instance.stop();
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
        const user = db.findUserById(req.user.id);
        const userLimits = getUserLimits(user);
        const servers = db.getUserServers(req.user.id);
        const totalRam = servers.reduce((acc, s) => acc + (s.id === serverId ? 0 : s.ram), 0);
        const newRam = parseInt(ram);
        
        if (totalRam + newRam > userLimits.maxRam) {
            return res.status(400).json({ error: `Max ${userLimits.maxRam}MB RAM limit reached` });
        }
        if (newRam < 512) {
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
        const user = db.findUserById(req.user.id);
        const userLimits = getUserLimits(user);
        const currentSize = await getDirSize(path.join(USER_DATA_DIR, owner.username));
        const maxBytes = userLimits.maxStorage * 1024 * 1024;
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

// =====================
// ADMIN ROUTES
// =====================

// Admin Stats
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const stats = db.getStats();
    stats.runningServers = runningVMs.size;
    res.json(stats);
});

// Admin Servers List
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

// Admin Users List
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

// Get Single User (Admin)
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
            isRunning: runningVMs.has(s.id)
        })),
        created_at: user.created_at
    });
});

// Update User (Admin)
app.post('/api/admin/user/:id', requireAdmin, (req, res) => {
    const { role, suspended, suspendReason, limits } = req.body;
    const user = db.findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Prevent self-demotion from admin
    if (user.id === req.user.id && role !== 'admin') {
        return res.status(400).json({ error: 'Cannot remove your own admin role' });
    }
    
    const updates = {};
    if (role !== undefined) updates.role = role;
    if (suspended !== undefined) updates.suspended = suspended;
    if (suspendReason !== undefined) updates.suspendReason = suspendReason;
    if (limits !== undefined) updates.limits = limits;
    
    const updated = db.updateUser(req.params.id, updates);
    
    // If user is suspended, stop all their running servers
    if (suspended) {
        const userServers = db.getUserServers(user.id);
        userServers.forEach(s => {
            const vm = runningVMs.get(s.id);
            if (vm) {
                vm.instance.stop();
                runningVMs.delete(s.id);
            }
        });
    }
    
    res.json({ success: true, user: updated });
});

// Delete User (Admin)
app.delete('/api/admin/user/:id', requireAdmin, async (req, res) => {
    const user = db.findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (user.id === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    
    // Stop and delete all user servers
    const userServers = db.getUserServers(user.id);
    for (const s of userServers) {
        const vm = runningVMs.get(s.id);
        if (vm) {
            vm.instance.stop();
            runningVMs.delete(s.id);
        }
        
        const serverDir = path.join(USER_DATA_DIR, user.username, 'servers', s.id);
        await fs.remove(serverDir);
    }
    
    // Delete user servers from DB
    db.deleteUserServers(user.id);
    
    // Delete user data directory
    const userDir = path.join(USER_DATA_DIR, user.username);
    await fs.remove(userDir);
    
    // Delete user
    db.deleteUser(user.id);
    
    res.json({ success: true });
});

// Suspend/Unsuspend Server (Admin)
app.post('/api/admin/server/:id/suspend', requireAdmin, (req, res) => {
    const { suspended, reason } = req.body;
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    // Stop server if suspending
    if (suspended) {
        const vm = runningVMs.get(server.id);
        if (vm) {
            vm.instance.stop();
            runningVMs.delete(server.id);
        }
    }
    
    const updated = db.updateServer(req.params.id, { 
        suspended: suspended,
        suspendReason: reason || ''
    });
    
    res.json({ success: true, server: updated });
});

// Admin Update Server
app.post('/api/admin/server/:id', requireAdmin, (req, res) => {
    const { name, description, ram, diskSize, ownerId } = req.body;
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (ram !== undefined) updates.ram = parseInt(ram);
    if (diskSize !== undefined) updates.diskSize = parseInt(diskSize);
    if (ownerId !== undefined) updates.ownerId = ownerId;
    
    const updated = db.updateServer(req.params.id, updates);
    res.json({ success: true, server: updated });
});

// Get Config (Admin)
app.get('/api/admin/config', requireAdmin, (req, res) => {
    res.json({
        port: config.port,
        limits: config.limits
    });
});

// Update Config (Admin)
app.post('/api/admin/config', requireAdmin, async (req, res) => {
    const { limits } = req.body;
    
    if (limits) {
        config.limits = { ...config.limits, ...limits };
    }
    
    // Save to config file
    try {
        const configPath = path.join(__dirname, '../../config.json');
        const currentConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
        currentConfig.limits = config.limits;
        await fs.writeFile(configPath, JSON.stringify(currentConfig, null, 2));
        
        // Update in-memory LIMITS
        Object.assign(LIMITS, config.limits);
        
        res.json({ success: true, config: { limits: config.limits } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Force Stop Server (Admin)
app.post('/api/admin/server/:id/force-stop', requireAdmin, (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    const vm = runningVMs.get(server.id);
    if (vm) {
        vm.instance.stop();
        runningVMs.delete(server.id);
    }
    
    res.json({ success: true });
});

// Admin Delete Server
app.delete('/api/admin/server/:id', requireAdmin, async (req, res) => {
    const server = db.getServer(req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    
    // Stop if running
    const vm = runningVMs.get(server.id);
    if (vm) {
        vm.instance.stop();
        runningVMs.delete(server.id);
    }
    
    // Delete files
    const owner = db.findUserById(server.ownerId);
    if (owner) {
        const serverDir = path.join(USER_DATA_DIR, owner.username, 'servers', server.id);
        await fs.remove(serverDir);
    }
    
    db.deleteServer(server.id);
    res.json({ success: true });
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
        vm.instance.stop();
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
            if (vm) vm.instance.write(data);
        }
    });
});

app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

server.listen(PORT, () => {
    log(`Panel running on port ${PORT}`);
});
