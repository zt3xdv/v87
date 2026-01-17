import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { requireAuth, requireAdmin } from '../utils/authMiddleware.js';
import { getImages, getImage } from '../utils/images.js';
import { log } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../../config.json');

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

export function setupServerRoutes(app, db, nodeManager, io, DATA_DIR) {
    
    function audit(userId, username, action, data = {}) {
        db.addAuditLog({ userId, username, action, ...data, createdAt: new Date().toISOString() });
    }

    function getUserLimits(user) {
        const config = loadConfig();
        const base = config.limits || {
            maxServers: 3,
            maxRam: 4096,
            maxDisk: 50,
            maxCpu: 400,
            maxIo: 0
        };
        if (user && user.limits) {
            return {
                maxServers: user.limits.maxServers ?? base.maxServers,
                maxRam: user.limits.maxRam ?? base.maxRam,
                maxDisk: user.limits.maxDisk ?? base.maxDisk,
                maxCpu: user.limits.maxCpu ?? base.maxCpu,
                maxIo: user.limits.maxIo ?? base.maxIo
            };
        }
        return base;
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // =====================
    // DASHBOARD
    // =====================

    app.get('/api/dashboard', requireAuth, async (req, res) => {
        const user = db.findUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const config = loadConfig();
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

    // =====================
    // SERVER CREATION
    // =====================

    app.post('/api/server/create', requireAuth, async (req, res, next) => {
        try {
            const config = loadConfig();
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

    // =====================
    // SERVER DETAILS
    // =====================

    app.get('/api/server/:id', requireAuth, async (req, res) => {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const image = getImage(serverData.imageId);
        
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

    app.get('/api/server/:id/creation-progress', requireAuth, (req, res) => {
        const serverId = req.params.id;
        const serverData = db.getServer(serverId);
        if (!serverData) return res.status(404).json({ error: 'Not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        res.json({ percent: 0, status: serverData.status === 'creating' ? 'Creating...' : 'Ready' });
    });

    // =====================
    // SERVER ACTIONS
    // =====================

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
            res.json({ status: 'stopped' });
            
        } catch (err) {
            next(err);
        }
    });

    app.post('/api/server/:id/restart', requireAuth, async (req, res, next) => {
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
            if (!client || !client.isConnected()) {
                return res.status(400).json({ error: 'Node is offline' });
            }

            await client.stopVM(serverId);
            db.updateServer(serverId, { status: 'stopped' });
            
            setTimeout(async () => {
                try {
                    await client.startVM(serverId, serverData.ownerId);
                    db.updateServer(serverId, { status: 'running' });
                    io.to(`server:${serverId}`).emit('vm-status', 'started');
                } catch {}
            }, 3000);
            
            audit(req.user.id, req.user.username, 'vm_restart', { serverId, serverName: serverData.name });
            res.json({ status: 'restarting' });
            
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
            res.json({ success: true });
            
        } catch (err) {
            next(err);
        }
    });

    // =====================
    // SERVER SETTINGS
    // =====================

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
    // SERVER LIMITS
    // =====================

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

    // =====================
    // SERVER RESIZE
    // =====================

    app.post('/api/server/:id/resize', requireAuth, async (req, res, next) => {
        try {
            const { ram, cpuLimit, diskSize } = req.body;
            const serverData = db.getServer(req.params.id);
            if (!serverData) return res.status(404).json({ error: 'Server not found' });
            if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Access denied' });
            }
            
            const updates = {};
            if (ram !== undefined) updates.ram = ram;
            if (cpuLimit !== undefined) {
                updates.cpuLimit = cpuLimit;
                updates.cpuCores = Math.ceil(cpuLimit / 100);
            }
            if (diskSize !== undefined) updates.diskSize = diskSize;
            
            if (serverData.nodeId && (ram !== undefined || cpuLimit !== undefined)) {
                const client = nodeManager.getClient(serverData.nodeId);
                if (client && client.isConnected()) {
                    await client.updateLimits(serverData.id, serverData.ownerId, { 
                        ram: ram || serverData.ram, 
                        cpuCores: updates.cpuCores || serverData.cpuCores 
                    });
                }
            }
            
            const updated = db.updateServer(req.params.id, updates);
            audit(req.user.id, req.user.username, 'vm_resize', { serverId: req.params.id, ...updates });
            res.json({ success: true, server: updated });
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

    // =====================
    // SERVER STATS & METRICS
    // =====================

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

    app.get('/api/server/:id/metrics', requireAuth, async (req, res, next) => {
        try {
            const serverData = db.getServer(req.params.id);
            if (!serverData) return res.status(404).json({ error: 'Server not found' });
            if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Access denied' });
            }
            
            const hours = parseInt(req.query.hours) || 1;
            const metrics = db.getMetrics(req.params.id);
            
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

    // =====================
    // VNC
    // =====================

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

    // =====================
    // NOTES & TAGS
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
    // SERVER SCHEDULES
    // =====================

    app.get('/api/server/:id/schedules', requireAuth, (req, res) => {
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        const schedules = db.getServerSchedules(req.params.id);
        res.json({ schedules });
    });

    app.post('/api/server/:id/schedules', requireAuth, (req, res) => {
        const { action, hour, minute, days, name, cronExpression, enabled } = req.body;
        
        const serverData = db.getServer(req.params.id);
        if (!serverData) return res.status(404).json({ error: 'Server not found' });
        if (serverData.ownerId !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (!['start', 'stop', 'restart'].includes(action)) {
            return res.status(400).json({ error: 'Invalid action. Use: start, stop, restart' });
        }
        
        const userSchedules = db.getUserSchedules(req.user.id);
        if (userSchedules.length >= 10) {
            return res.status(400).json({ error: 'Maximum 10 schedules allowed' });
        }
        
        let schedule;
        
        if (cronExpression) {
            schedule = {
                id: Date.now().toString(),
                userId: req.user.id,
                serverId: req.params.id,
                action,
                cronExpression: cronExpression || '0 0 * * *',
                enabled: enabled !== false,
                createdAt: new Date().toISOString(),
                lastRun: null
            };
        } else {
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                return res.status(400).json({ error: 'Invalid time' });
            }
            
            if (!Array.isArray(days) || days.length === 0 || days.some(d => d < 0 || d > 6)) {
                return res.status(400).json({ error: 'Invalid days. Use 0-6 (Sunday-Saturday)' });
            }
            
            schedule = {
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
        }
        
        db.addSchedule(schedule);
        audit(req.user.id, req.user.username, 'schedule_created', { scheduleId: schedule.id, serverId: req.params.id, action });
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
}
