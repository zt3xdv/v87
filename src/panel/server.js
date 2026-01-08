import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'fs-extra';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Utils
import { c, log, logSuccess, logWarn, logError } from './utils/logger.js';
import { isValidId } from './utils/validation.js';
import { verifyToken } from './utils/token.js';
import { invalidateUserTokens } from './utils/authMiddleware.js';
import { NodeManager } from './utils/node-client.js';
import { startSchedulers } from './utils/scheduler.js';
import { triggerWebhooks, createWebhookHelper } from './utils/webhooks.js';

// Routes
import { setupAuthRoutes } from './routes/auth.js';
import { setupServerRoutes } from './routes/servers.js';
import { setupAdminRoutes } from './routes/admin.js';
import { setupApiV1Routes } from './routes/api-v1.js';
import { setupWebhooksRoutes } from './routes/webhooks.js';
import { setupAlertsRoutes } from './routes/alerts.js';
import { setupSchedulesRoutes } from './routes/schedules.js';
import { setupPreferencesRoutes } from './routes/preferences.js';

import db from './db.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const PORT = config.port || process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '../../data');

// =====================
// NODE MANAGER SETUP
// =====================

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

// =====================
// EXPRESS & SOCKET.IO SETUP
// =====================

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// VM output/status events -> broadcast to socket rooms
nodeManager.on('vm-output', (nodeId, serverId, data) => {
    io.to(`server:${serverId}`).emit('term-data', data);
});

nodeManager.on('vm-status', (nodeId, serverId, status) => {
    io.to(`server:${serverId}`).emit('vm-status', status === 'running' ? 'started' : 'stopped');
    db.updateServer(serverId, { status: status === 'running' ? 'running' : 'stopped' });
});

// Socket.io authentication middleware
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

// Track viewers per server for subscription management
const serverViewerCount = new Map();

io.on('connection', (socket) => {
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

// =====================
// VNC WEBSOCKET PROXY
// =====================

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
    
    if (!serverData.nodeId) {
        socket.emit('error', 'VNC not available - server has no node');
        socket.disconnect();
        return;
    }
    
    const client = nodeManager.getClient(serverData.nodeId);
    if (!client || !client.isConnected()) {
        socket.emit('error', 'Node is offline');
        socket.disconnect();
        return;
    }
    
    try {
        await client.connectVNC(serverId);
        
        const onVncData = (data) => {
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
});

// =====================
// MIDDLEWARE
// =====================

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(path.join(DATA_DIR, 'users'));
fs.ensureDirSync(path.join(DATA_DIR, 'images'));

app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// =====================
// HELPERS
// =====================

function audit(userId, username, action, details = {}) {
    db.addAuditLog({ userId, username, action, ...details });
}

// =====================
// SETUP ROUTES
// =====================

setupAuthRoutes(app, db, config);
setupServerRoutes(app, db, nodeManager, io, DATA_DIR);
setupAdminRoutes(app, db, nodeManager, config, invalidateUserTokens);
setupApiV1Routes(app, db, nodeManager, audit);
setupWebhooksRoutes(app, db, audit);
setupAlertsRoutes(app, db, audit);
setupSchedulesRoutes(app, db, audit);
setupPreferencesRoutes(app, db);

// =====================
// START SCHEDULERS
// =====================

startSchedulers(db, nodeManager, createWebhookHelper(db));

// =====================
// HTTP PROXY TO VMs (/s/:serverId)
// =====================

async function proxyToVm(req, res, serverId) {
    if (!isValidId(serverId)) {
        return res.status(400).send('Invalid server ID');
    }
    
    const serverData = db.getServer(serverId);
    if (!serverData) {
        return res.status(404).send('Server not found');
    }
    
    if (!serverData.nodeId) {
        return res.status(400).send('Server has no node');
    }
    
    const client = nodeManager.getClient(serverData.nodeId);
    if (!client || !client.isConnected()) {
        return res.status(503).send('Node is offline');
    }
    
    let proxyPort = 80;
    const portMatch = req.query.port;
    if (portMatch && /^\d+$/.test(portMatch)) {
        proxyPort = parseInt(portMatch);
    }
    
    let targetIp;
    try {
        const vmInfo = await client.getVMInfo(serverId);
        targetIp = vmInfo.ip;
    } catch (err) {
        return res.status(500).send('Failed to get VM info: ' + err.message);
    }
    
    if (!targetIp) {
        return res.status(500).send('VM has no IP address');
    }
    
    const proxyPath = req.originalUrl.replace(`/s/${serverId}`, '') || '/';
    
    const proxyOptions = {
        hostname: targetIp,
        port: proxyPort,
        path: proxyPath,
        method: req.method,
        headers: { ...req.headers }
    };
    
    delete proxyOptions.headers['host'];
    proxyOptions.headers['host'] = req.headers.host || `127.0.0.1:${proxyPort}`;
    proxyOptions.headers['x-forwarded-for'] = req.ip;
    proxyOptions.headers['x-forwarded-proto'] = req.protocol;
    proxyOptions.headers['x-real-ip'] = req.ip;
    proxyOptions.headers['x-forwarded-host'] = req.headers.host;
    proxyOptions.headers['x-forwarded-prefix'] = `/s/${serverId}`;
    
    const proxyReq = http.request(proxyOptions, (proxyRes) => {
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
<p>The VM is not responding on port ${proxyPort}.</p>
<pre>${err.message}</pre>
<button onclick="location.reload()">Retry</button>
</body></html>`);
        }
    });
    
    req.pipe(proxyReq);
}

app.use('/s/:serverId', async (req, res, next) => {
    return proxyToVm(req, res, req.params.serverId);
});

// =====================
// CATCH-ALL FOR SPA
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

// =====================
// START SERVER
// =====================

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
