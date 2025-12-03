import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(SERVERS_FILE)) fs.writeFileSync(SERVERS_FILE, '[]');

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
    }
};
