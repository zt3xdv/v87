import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BinaryDB from './utils/binarydb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'v87.db');

// Initialize BinaryDB
const db = new BinaryDB(DB_PATH, {
    compactThreshold: 500,
    syncInterval: 2000,
    autoCompact: true
});

// Initialize database and create indexes
await db.init();

// Create indexes for fast lookups
db.collection('users').createIndex('username');
db.collection('users').createIndex('email');
db.collection('servers').createIndex('ownerId');
db.collection('servers').createIndex('nodeId');
db.collection('apikeys').createIndex('userId');
db.collection('apikeys').createIndex('key');
db.collection('schedules').createIndex('serverId');
db.collection('schedules').createIndex('userId');
db.collection('webhooks').createIndex('userId');
db.collection('alerts').createIndex('userId');
db.collection('alerts').createIndex('serverId');

// Collections
const users = db.collection('users');
const servers = db.collection('servers');
const audit = db.collection('audit');
const apikeys = db.collection('apikeys');
const schedules = db.collection('schedules');
const webhooks = db.collection('webhooks');
const alerts = db.collection('alerts');
const settings = db.collection('settings');
const metrics = db.collection('metrics');
const nodes = db.collection('nodes');

export default {
    // Users
    getUsers: () => users.findAll(),
    saveUsers: (data) => {
        // Clear and reinsert (for legacy compatibility)
        const existing = users.findAll();
        existing.forEach(u => users.delete(u.id));
        data.forEach(u => users.insert(u));
    },
    
    findUser: (username) => users.findOne({ username }),
    findUserById: (id) => users.findById(id),
    findUserByEmail: (email) => users.findOne({ email }),
    
    createUser: (user) => users.insert(user),
    
    createFirstAdmin: (user) => {
        if (users.count() > 0) {
            return null;
        }
        user.role = 'admin';
        return users.insert(user);
    },
    
    updateUser: (id, updates) => users.update(id, updates),
    
    deleteUser: (id) => {
        users.delete(id);
    },
    
    // Servers
    getServers: () => servers.findAll(),
    saveServers: (data) => {
        const existing = servers.findAll();
        existing.forEach(s => servers.delete(s.id));
        data.forEach(s => servers.insert(s));
    },
    
    getUserServers: (userId) => servers.find({ ownerId: userId }),
    getServer: (id) => servers.findById(id),
    
    addServer: (server) => servers.insert(server),
    
    updateServer: (id, updates) => servers.update(id, updates),
    
    deleteServer: (id) => {
        servers.delete(id);
    },
    
    deleteUserServers: (userId) => {
        servers.deleteMany({ ownerId: userId });
    },
    
    // Stats
    getStats: () => {
        const allUsers = users.findAll();
        const allServers = servers.findAll();
        return {
            totalUsers: allUsers.length,
            totalServers: allServers.length,
            totalRam: allServers.reduce((acc, s) => acc + (s.ram || 0), 0),
            suspendedUsers: allUsers.filter(u => u.suspended).length,
            suspendedServers: allServers.filter(s => s.suspended).length
        };
    },
    
    // Audit Log
    addAuditLog: (entry) => {
        const log = {
            timestamp: new Date().toISOString(),
            ...entry
        };
        audit.insert(log);
        
        // Keep only last 1000 entries
        const all = audit.findAll();
        if (all.length > 1000) {
            all.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            const toDelete = all.slice(0, all.length - 1000);
            toDelete.forEach(l => audit.delete(l.id));
        }
    },
    
    getAuditLogs: (options = {}) => {
        let logs = audit.findAll();
        
        if (options.userId) {
            logs = logs.filter(l => l.userId === options.userId);
        }
        if (options.action) {
            logs = logs.filter(l => l.action === options.action);
        }
        if (options.serverId) {
            logs = logs.filter(l => l.serverId === options.serverId);
        }
        
        logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        const limit = options.limit || 50;
        const offset = options.offset || 0;
        
        return {
            logs: logs.slice(offset, offset + limit),
            total: logs.length
        };
    },
    
    // API Keys
    getApiKeys: (userId) => apikeys.find({ userId }),
    
    getApiKeyByKey: (key) => apikeys.findOne({ key }),
    
    createApiKey: (apiKey) => apikeys.insert(apiKey),
    
    deleteApiKey: (id, userId) => {
        const key = apikeys.findOne({ id, userId });
        if (key) apikeys.delete(key.id);
    },
    
    updateApiKeyLastUsed: (id) => {
        apikeys.update(id, { lastUsed: new Date().toISOString() });
    },
    
    // Scheduled Actions
    getSchedules: () => schedules.findAll(),
    
    getServerSchedules: (serverId) => schedules.find({ serverId }),
    
    getUserSchedules: (userId) => schedules.find({ userId }),
    
    addSchedule: (schedule) => schedules.insert(schedule),
    
    deleteSchedule: (id) => {
        schedules.delete(id);
    },
    
    updateSchedule: (id, updates) => schedules.update(id, updates),
    
    // Webhooks
    getWebhooks: (userId) => webhooks.find({ userId }),
    
    getAllWebhooks: () => webhooks.findAll(),
    
    getWebhooksByEvent: (event) => {
        return webhooks.findAll().filter(w => w.enabled && w.events?.includes(event));
    },
    
    createWebhook: (webhook) => webhooks.insert(webhook),
    
    updateWebhook: (id, userId, updates) => {
        const webhook = webhooks.findOne({ id, userId });
        if (webhook) {
            return webhooks.update(webhook.id, updates);
        }
        return null;
    },
    
    deleteWebhook: (id, userId) => {
        const webhook = webhooks.findOne({ id, userId });
        if (webhook) webhooks.delete(webhook.id);
    },
    
    // Alerts
    getAlerts: (userId) => alerts.find({ userId }),
    
    getServerAlerts: (serverId) => alerts.find({ serverId, enabled: true }),
    
    createAlert: (alert) => alerts.insert(alert),
    
    updateAlert: (id, updates) => alerts.update(id, updates),
    
    deleteAlert: (id) => {
        alerts.delete(id);
    },
    
    // Global Settings
    getSettings: () => {
        const doc = settings.findOne({ _type: 'global' });
        return doc || {};
    },
    
    updateSettings: (updates) => {
        const existing = settings.findOne({ _type: 'global' });
        if (existing) {
            return settings.update(existing.id, updates);
        } else {
            return settings.insert({ _type: 'global', ...updates });
        }
    },
    
    // Metrics history
    getMetrics: (serverId) => {
        const doc = metrics.findOne({ serverId });
        return doc?.data || [];
    },
    
    addMetric: (serverId, metric) => {
        let doc = metrics.findOne({ serverId });
        const entry = {
            timestamp: new Date().toISOString(),
            ...metric
        };
        
        if (!doc) {
            metrics.insert({ serverId, data: [entry] });
        } else {
            let data = doc.data || [];
            data.push(entry);
            // Keep last 1440 entries (24 hours at 1 per minute)
            if (data.length > 1440) {
                data = data.slice(-1440);
            }
            metrics.update(doc.id, { data });
        }
    },
    
    clearMetrics: (serverId) => {
        const doc = metrics.findOne({ serverId });
        if (doc) metrics.delete(doc.id);
    },
    
    // Nodes
    getNodes: () => nodes.findAll(),
    
    getNode: (id) => nodes.findById(id),
    
    createNode: (node) => nodes.insert(node),
    
    updateNode: (id, updates) => nodes.update(id, updates),
    
    deleteNode: (id) => {
        nodes.delete(id);
    },
    
    getNodeServers: (nodeId) => servers.find({ nodeId }),
    
    getNodeUsage: (nodeId) => {
        const nodeServers = servers.find({ nodeId });
        return {
            ram: nodeServers.reduce((acc, s) => acc + (s.ram || 0), 0),
            disk: nodeServers.reduce((acc, s) => acc + (parseInt((s.diskSize || '0G').replace('G', '')) || 0), 0),
            cpu: nodeServers.reduce((acc, s) => acc + (s.cpuCores || 1), 0),
            count: nodeServers.length
        };
    },
    
    // Database management
    compact: () => db.compact(),
    close: () => db.close(),
    
    // Direct access for advanced queries
    _db: db
};
