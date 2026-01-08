import { log } from '../utils/logger.js';

export function setupApiV1Routes(app, db, nodeManager, audit) {
    // =====================
    // API Key Authentication Middleware
    // =====================

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

    // =====================
    // API v1 Endpoints
    // =====================

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
}
