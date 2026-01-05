import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const APIKEYS_FILE = path.join(DATA_DIR, 'apikeys.json');
const SCHEDULES_FILE = path.join(DATA_DIR, 'schedules.json');
const WEBHOOKS_FILE = path.join(DATA_DIR, 'webhooks.json');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(SERVERS_FILE)) fs.writeFileSync(SERVERS_FILE, '[]');
if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, '[]');
if (!fs.existsSync(APIKEYS_FILE)) fs.writeFileSync(APIKEYS_FILE, '[]');
if (!fs.existsSync(SCHEDULES_FILE)) fs.writeFileSync(SCHEDULES_FILE, '[]');
if (!fs.existsSync(WEBHOOKS_FILE)) fs.writeFileSync(WEBHOOKS_FILE, '[]');
if (!fs.existsSync(ALERTS_FILE)) fs.writeFileSync(ALERTS_FILE, '[]');
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, '{}');
if (!fs.existsSync(METRICS_FILE)) fs.writeFileSync(METRICS_FILE, '{}');

function load(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export default {
    // Users
    getUsers: () => load(USERS_FILE),
    saveUsers: (users) => save(USERS_FILE, users),
    
    findUser: (username) => load(USERS_FILE).find(u => u.username === username),
    findUserById: (id) => load(USERS_FILE).find(u => u.id === id),
    
    createUser: (user) => {
        const users = load(USERS_FILE);
        users.push(user);
        save(USERS_FILE, users);
    },
    
    createFirstAdmin: (user) => {
        const users = load(USERS_FILE);
        if (users.length > 0) {
            return null;
        }
        user.role = 'admin';
        users.push(user);
        save(USERS_FILE, users);
        return user;
    },
    
    updateUser: (id, updates) => {
        const users = load(USERS_FILE);
        const index = users.findIndex(u => u.id === id);
        if (index !== -1) {
            users[index] = { ...users[index], ...updates };
            save(USERS_FILE, users);
            return users[index];
        }
        return null;
    },
    
    deleteUser: (id) => {
        const users = load(USERS_FILE).filter(u => u.id !== id);
        save(USERS_FILE, users);
    },
    
    // Servers
    getServers: () => load(SERVERS_FILE),
    saveServers: (servers) => save(SERVERS_FILE, servers),
    
    getUserServers: (userId) => load(SERVERS_FILE).filter(s => s.ownerId === userId),
    getServer: (id) => load(SERVERS_FILE).find(s => s.id === id),
    
    addServer: (server) => {
        const servers = load(SERVERS_FILE);
        servers.push(server);
        save(SERVERS_FILE, servers);
    },
    
    updateServer: (id, updates) => {
        const servers = load(SERVERS_FILE);
        const index = servers.findIndex(s => s.id === id);
        if (index !== -1) {
            servers[index] = { ...servers[index], ...updates };
            save(SERVERS_FILE, servers);
            return servers[index];
        }
        return null;
    },
    
    deleteServer: (id) => {
        const servers = load(SERVERS_FILE).filter(s => s.id !== id);
        save(SERVERS_FILE, servers);
    },
    
    deleteUserServers: (userId) => {
        const servers = load(SERVERS_FILE).filter(s => s.ownerId !== userId);
        save(SERVERS_FILE, servers);
    },
    
    // Stats
    getStats: () => {
        const users = load(USERS_FILE);
        const servers = load(SERVERS_FILE);
        return {
            totalUsers: users.length,
            totalServers: servers.length,
            totalRam: servers.reduce((acc, s) => acc + (s.ram || 0), 0),
            suspendedUsers: users.filter(u => u.suspended).length,
            suspendedServers: servers.filter(s => s.suspended).length
        };
    },
    
    // Audit Log
    addAuditLog: (entry) => {
        const logs = load(AUDIT_FILE);
        logs.push({
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            ...entry
        });
        // Keep only last 1000 entries
        if (logs.length > 1000) {
            logs.splice(0, logs.length - 1000);
        }
        save(AUDIT_FILE, logs);
    },
    
    getAuditLogs: (options = {}) => {
        let logs = load(AUDIT_FILE);
        
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
    getApiKeys: (userId) => load(APIKEYS_FILE).filter(k => k.userId === userId),
    
    getApiKeyByKey: (key) => load(APIKEYS_FILE).find(k => k.key === key),
    
    createApiKey: (apiKey) => {
        const keys = load(APIKEYS_FILE);
        keys.push(apiKey);
        save(APIKEYS_FILE, keys);
    },
    
    deleteApiKey: (id, userId) => {
        const keys = load(APIKEYS_FILE).filter(k => !(k.id === id && k.userId === userId));
        save(APIKEYS_FILE, keys);
    },
    
    updateApiKeyLastUsed: (id) => {
        const keys = load(APIKEYS_FILE);
        const index = keys.findIndex(k => k.id === id);
        if (index !== -1) {
            keys[index].lastUsed = new Date().toISOString();
            save(APIKEYS_FILE, keys);
        }
    },
    
    // Scheduled Actions
    getSchedules: () => load(SCHEDULES_FILE),
    
    getServerSchedules: (serverId) => load(SCHEDULES_FILE).filter(s => s.serverId === serverId),
    
    getUserSchedules: (userId) => load(SCHEDULES_FILE).filter(s => s.userId === userId),
    
    addSchedule: (schedule) => {
        const schedules = load(SCHEDULES_FILE);
        schedules.push(schedule);
        save(SCHEDULES_FILE, schedules);
    },
    
    deleteSchedule: (id) => {
        const schedules = load(SCHEDULES_FILE).filter(s => s.id !== id);
        save(SCHEDULES_FILE, schedules);
    },
    
    updateSchedule: (id, updates) => {
        const schedules = load(SCHEDULES_FILE);
        const index = schedules.findIndex(s => s.id === id);
        if (index !== -1) {
            schedules[index] = { ...schedules[index], ...updates };
            save(SCHEDULES_FILE, schedules);
            return schedules[index];
        }
        return null;
    },
    
    // Webhooks
    getWebhooks: (userId) => load(WEBHOOKS_FILE).filter(w => w.userId === userId),
    
    getAllWebhooks: () => load(WEBHOOKS_FILE),
    
    getWebhooksByEvent: (event) => load(WEBHOOKS_FILE).filter(w => w.enabled && w.events.includes(event)),
    
    createWebhook: (webhook) => {
        const webhooks = load(WEBHOOKS_FILE);
        webhooks.push(webhook);
        save(WEBHOOKS_FILE, webhooks);
    },
    
    updateWebhook: (id, userId, updates) => {
        const webhooks = load(WEBHOOKS_FILE);
        const index = webhooks.findIndex(w => w.id === id && w.userId === userId);
        if (index !== -1) {
            webhooks[index] = { ...webhooks[index], ...updates };
            save(WEBHOOKS_FILE, webhooks);
            return webhooks[index];
        }
        return null;
    },
    
    deleteWebhook: (id, userId) => {
        const webhooks = load(WEBHOOKS_FILE).filter(w => !(w.id === id && w.userId === userId));
        save(WEBHOOKS_FILE, webhooks);
    },
    
    // Alerts
    getAlerts: (userId) => load(ALERTS_FILE).filter(a => a.userId === userId),
    
    getServerAlerts: (serverId) => load(ALERTS_FILE).filter(a => a.serverId === serverId && a.enabled),
    
    createAlert: (alert) => {
        const alerts = load(ALERTS_FILE);
        alerts.push(alert);
        save(ALERTS_FILE, alerts);
    },
    
    updateAlert: (id, updates) => {
        const alerts = load(ALERTS_FILE);
        const index = alerts.findIndex(a => a.id === id);
        if (index !== -1) {
            alerts[index] = { ...alerts[index], ...updates };
            save(ALERTS_FILE, alerts);
            return alerts[index];
        }
        return null;
    },
    
    deleteAlert: (id) => {
        const alerts = load(ALERTS_FILE).filter(a => a.id !== id);
        save(ALERTS_FILE, alerts);
    },
    
    // Global Settings (maintenance mode, etc)
    getSettings: () => {
        try {
            return load(SETTINGS_FILE);
        } catch {
            return {};
        }
    },
    
    updateSettings: (updates) => {
        const settings = load(SETTINGS_FILE);
        const newSettings = { ...settings, ...updates };
        save(SETTINGS_FILE, newSettings);
        return newSettings;
    },
    
    // Metrics history
    getMetrics: (serverId) => {
        const metrics = load(METRICS_FILE);
        return metrics[serverId] || [];
    },
    
    addMetric: (serverId, metric) => {
        const metrics = load(METRICS_FILE);
        if (!metrics[serverId]) metrics[serverId] = [];
        metrics[serverId].push({
            timestamp: new Date().toISOString(),
            ...metric
        });
        // Keep last 1440 entries (24 hours at 1 per minute)
        if (metrics[serverId].length > 1440) {
            metrics[serverId] = metrics[serverId].slice(-1440);
        }
        save(METRICS_FILE, metrics);
    },
    
    clearMetrics: (serverId) => {
        const metrics = load(METRICS_FILE);
        delete metrics[serverId];
        save(METRICS_FILE, metrics);
    },
};
