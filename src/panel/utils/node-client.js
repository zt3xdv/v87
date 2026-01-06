import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class NodeClient extends EventEmitter {
    constructor(nodeConfig) {
        super();
        this.nodeId = nodeConfig.id;
        this.url = nodeConfig.url;
        this.secret = nodeConfig.secret;
        this.ws = null;
        this.connected = false;
        this.authenticated = false;
        this.wasAuthenticated = false;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.authFailed = false;
        this.pingInterval = null;
    }

    connect() {
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
        }

        this.authFailed = false;

        try {
            this.ws = new WebSocket(this.url);
        } catch (err) {
            this.emit('error', err);
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.authenticate();
        });

        this.ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                this.handleMessage(message);
            } catch (err) {
                this.emit('error', new Error('Invalid message from node'));
            }
        });

        this.ws.on('close', (code) => {
            this.stopPing();
            const wasAuth = this.authenticated;
            this.connected = false;
            this.authenticated = false;
            
            // Only emit disconnected if we were previously authenticated
            if (this.wasAuthenticated) {
                this.emit('disconnected');
            }
            
            this.rejectPendingRequests('Connection closed');
            
            // Don't reconnect if auth failed (wrong secret)
            if (code === 4003 || this.authFailed) {
                this.emit('error', new Error('Authentication failed - check node secret'));
                return;
            }
            
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            this.emit('error', err);
        });
    }

    authenticate() {
        this.send('auth', {
            secret: this.secret,
            clientType: 'panel'
        }).then((response) => {
            this.authenticated = true;
            this.wasAuthenticated = true;
            this.emit('connected');
            this.startPing();
        }).catch((err) => {
            this.authFailed = true;
            this.emit('error', new Error('Authentication failed: ' + err.message));
            if (this.ws) {
                this.ws.close();
            }
        });
    }

    startPing() {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 30000);
    }

    stopPing() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        if (this.authFailed) return;
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.emit('max-reconnect-attempts');
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * this.reconnectAttempts, 60000);
        
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    handleMessage(message) {
        const { type, id, payload } = message;

        if (id && this.pendingRequests.has(id)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(id);
            clearTimeout(timeout);
            this.pendingRequests.delete(id);

            if (type === 'error') {
                reject(new Error(payload?.error || 'Unknown error'));
            } else {
                resolve(payload);
            }
            return;
        }

        switch (type) {
            case 'vm-output':
                this.emit('vm-output', payload.serverId, payload.data);
                break;
            case 'vm-status':
                this.emit('vm-status', payload.serverId, payload.status);
                break;
            case 'download-progress':
                this.emit('download-progress', payload);
                break;
            case 'download-complete':
                this.emit('download-complete', payload);
                break;
            case 'download-error':
                this.emit('download-error', payload);
                break;
            case 'vnc-data':
                this.emit('vnc-data', payload);
                break;
            case 'vnc-disconnected':
                this.emit('vnc-disconnected');
                break;
            default:
                this.emit('message', message);
        }
    }

    send(type, payload = {}, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Not connected'));
                return;
            }

            const id = (++this.requestId).toString();
            
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error('Request timeout'));
            }, timeoutMs);

            this.pendingRequests.set(id, { resolve, reject, timeout });

            try {
                this.ws.send(JSON.stringify({ type, id, payload }));
            } catch (err) {
                clearTimeout(timeout);
                this.pendingRequests.delete(id);
                reject(err);
            }
        });
    }

    rejectPendingRequests(reason) {
        for (const [id, { reject, timeout }] of this.pendingRequests) {
            clearTimeout(timeout);
            reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    async getStatus() {
        return this.send('status');
    }

    async downloadImage(imageId, url, name) {
        return this.send('download-image', { imageId, url, name });
    }

    async listImages() {
        const result = await this.send('list-images');
        return result.images || [];
    }

    async deleteImage(imageId) {
        return this.send('delete-image', { imageId });
    }

    async createVM(config) {
        // VM creation can take a long time (disk creation, etc.)
        return this.send('create-vm', config, 300000);
    }

    async startVM(serverId, userId) {
        return this.send('start-vm', { serverId, userId });
    }

    async stopVM(serverId) {
        return this.send('stop-vm', { serverId });
    }

    async deleteVM(serverId, userId) {
        return this.send('delete-vm', { serverId, userId });
    }

    sendVMInput(serverId, data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'vm-input',
                payload: { serverId, data }
            }));
        }
    }

    async getVMStatus(serverId) {
        return this.send('vm-status', { serverId });
    }

    async getVMStats(serverId) {
        return this.send('vm-stats', { serverId });
    }

    async listVMs() {
        const result = await this.send('list-vms');
        return result.vms || [];
    }

    async connectVNC(serverId) {
        return this.send('vnc-connect', { serverId });
    }

    sendVNCData(data) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'vnc-data',
                payload: { data }
            }));
        }
    }

    disconnect() {
        this.stopPing();
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        
        this.connected = false;
        this.authenticated = false;
    }

    isConnected() {
        return this.connected && this.authenticated;
    }
}

export class NodeManager extends EventEmitter {
    constructor() {
        super();
        this.clients = new Map();
    }

    addNode(nodeConfig) {
        if (this.clients.has(nodeConfig.id)) {
            this.removeNode(nodeConfig.id);
        }

        const client = new NodeClient(nodeConfig);
        
        client.on('connected', () => {
            this.emit('node-connected', nodeConfig.id);
        });

        client.on('disconnected', () => {
            this.emit('node-disconnected', nodeConfig.id);
        });

        client.on('error', (err) => {
            this.emit('node-error', nodeConfig.id, err);
        });

        client.on('vm-output', (serverId, data) => {
            this.emit('vm-output', nodeConfig.id, serverId, data);
        });

        client.on('vm-status', (serverId, status) => {
            this.emit('vm-status', nodeConfig.id, serverId, status);
        });

        this.clients.set(nodeConfig.id, client);
        client.connect();
        
        return client;
    }

    removeNode(nodeId) {
        const client = this.clients.get(nodeId);
        if (client) {
            client.disconnect();
            this.clients.delete(nodeId);
        }
    }

    getClient(nodeId) {
        return this.clients.get(nodeId);
    }

    isNodeConnected(nodeId) {
        const client = this.clients.get(nodeId);
        return client ? client.isConnected() : false;
    }

    async getNodeStatus(nodeId) {
        const client = this.clients.get(nodeId);
        if (!client || !client.isConnected()) {
            return { online: false };
        }
        
        try {
            const status = await client.getStatus();
            return { online: true, ...status };
        } catch {
            return { online: false };
        }
    }

    getAllConnectedNodes() {
        const connected = [];
        for (const [nodeId, client] of this.clients) {
            if (client.isConnected()) {
                connected.push(nodeId);
            }
        }
        return connected;
    }

    shutdown() {
        for (const client of this.clients.values()) {
            client.disconnect();
        }
        this.clients.clear();
    }
}

export default NodeManager;
