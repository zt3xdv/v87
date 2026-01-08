import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { requireAdmin } from '../utils/authMiddleware.js';
import { log } from '../utils/logger.js';
import { getImages, getImage } from '../utils/images.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = path.join(__dirname, '../../../data');

function audit(db, userId, username, action, details = {}) {
    db.addAuditLog({ userId, username, action, ...details });
}

function calculateNodeAvailability(db, node) {
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

function canFitOnNode(db, node, ram, disk, cpu) {
    const availability = calculateNodeAvailability(db, node);
    return (
        availability.ram.available >= ram &&
        availability.disk.available >= disk &&
        availability.cpu.available >= cpu &&
        availability.servers.available >= 1
    );
}

function findAvailableNodes(db, nodeManager, ram, disk, cpu) {
    const nodes = db.getNodes().filter(n => n.enabled);
    return nodes.filter(n => canFitOnNode(db, n, ram, disk, cpu)).map(n => ({
        ...n,
        secret: undefined,
        availability: calculateNodeAvailability(db, n),
        online: nodeManager.isNodeConnected(n.id)
    }));
}

export function setupAdminRoutes(app, db, nodeManager, config, invalidateUserTokens) {
    let LIMITS = config.limits;

    // =====================
    // ADMIN STATS
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

    // =====================
    // ADMIN SERVERS
    // =====================

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

    // =====================
    // ADMIN USERS
    // =====================

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

    app.post('/api/admin/user/:id/revoke-tokens', requireAdmin, (req, res) => {
        const user = db.findUserById(req.params.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        invalidateUserTokens(req.params.id);
        audit(db, req.user.id, req.user.username, 'admin_revoke_tokens', { targetUser: user.username });
        log(`Admin ${req.user.username} revoked all tokens for user ${user.username}`);
        
        res.json({ success: true, message: `All sessions for ${user.username} have been logged out` });
    });

    // =====================
    // ADMIN NODES
    // =====================

    app.get('/api/admin/nodes', requireAdmin, async (req, res) => {
        const nodes = db.getNodes();
        const enriched = await Promise.all(nodes.map(async (node) => {
            const online = nodeManager.isNodeConnected(node.id);
            const availability = calculateNodeAvailability(db, node);
            
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
        
        audit(db, req.user.id, req.user.username, 'node_created', { nodeId: node.id, nodeName: name });
        log(`Node created: ${name} (${node.id})`);
        
        res.json({ success: true, node: { ...node, secret: '••••••••' } });
    });

    app.get('/api/admin/nodes/:id', requireAdmin, async (req, res) => {
        const node = db.getNode(req.params.id);
        if (!node) {
            return res.status(404).json({ error: 'Node not found' });
        }
        
        const online = nodeManager.isNodeConnected(node.id);
        const availability = calculateNodeAvailability(db, node);
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
        
        audit(db, req.user.id, req.user.username, 'node_updated', { nodeId: node.id });
        
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
        
        audit(db, req.user.id, req.user.username, 'node_deleted', { nodeId: node.id, nodeName: node.name });
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

    // =====================
    // ADMIN CONFIG
    // =====================

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

    // =====================
    // PUBLIC NODE ROUTES (for users)
    // =====================

    return {
        calculateNodeAvailability: (node) => calculateNodeAvailability(db, node),
        findAvailableNodes: (ram, disk, cpu) => findAvailableNodes(db, nodeManager, ram, disk, cpu),
        audit: (userId, username, action, details) => audit(db, userId, username, action, details)
    };
}
