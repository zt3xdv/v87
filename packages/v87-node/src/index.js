import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { VMManager } from './vm-manager.js';
import { ImageManager } from './image-manager.js';

const PROTOCOL_VERSION = 1;

export class NodeDaemon {
    constructor(config) {
        this.config = {
            port: config.port || 7000,
            host: config.host || '0.0.0.0',
            secret: config.secret,
            dataDir: config.dataDir || './data',
            enableKvm: config.enableKvm || false
        };

        this.wss = null;
        this.panelConnection = null;
        this.vmManager = new VMManager({
            dataDir: this.config.dataDir,
            enableKvm: this.config.enableKvm
        });
        this.imageManager = new ImageManager({
            dataDir: this.config.dataDir
        });
        
        this.vmManager.on('vm-output', (serverId, data) => {
            this.sendToPanel('vm-output', { serverId, data });
        });
        
        this.vmManager.on('vm-status', (serverId, status) => {
            this.sendToPanel('vm-status', { serverId, status });
        });
    }

    log(message) {
        const now = new Date();
        const time = now.toTimeString().slice(0, 8);
        console.log(`\x1b[90m${time}\x1b[0m ${message}`);
    }

    start() {
        this.wss = new WebSocketServer({
            port: this.config.port,
            host: this.config.host
        });

        this.wss.on('listening', () => {
            this.log(`v87-node listening on ${this.config.host}:${this.config.port}`);
            this.log(`KVM: ${this.config.enableKvm ? 'enabled' : 'disabled'}`);
            this.log(`Data dir: ${this.config.dataDir}`);
        });

        this.wss.on('connection', (ws, req) => {
            this.log(`Connection from ${req.socket.remoteAddress}`);
            this.handleConnection(ws);
        });

        this.wss.on('error', (err) => {
            this.log(`Server error: ${err.message}`);
        });
    }

    handleConnection(ws) {
        ws.authenticated = false;
        ws.isPanel = false;

        const authTimeout = setTimeout(() => {
            if (!ws.authenticated) {
                ws.close(4001, 'Authentication timeout');
            }
        }, 10000);

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.handleMessage(ws, message);
            } catch (err) {
                this.sendError(ws, null, `Invalid message: ${err.message}`);
            }
        });

        ws.on('close', () => {
            clearTimeout(authTimeout);
            if (ws.isPanel && ws === this.panelConnection) {
                this.log('Panel disconnected');
                this.panelConnection = null;
            }
        });

        ws.on('error', (err) => {
            this.log(`WebSocket error: ${err.message}`);
        });
    }

    async handleMessage(ws, message) {
        const { type, id, payload } = message;

        if (type === 'auth') {
            return this.handleAuth(ws, id, payload);
        }

        if (!ws.authenticated) {
            return this.sendError(ws, id, 'Not authenticated');
        }

        switch (type) {
            case 'ping':
                return this.sendResponse(ws, id, 'pong', { time: Date.now() });

            case 'status':
                return this.sendResponse(ws, id, 'status', await this.getStatus());

            case 'download-image':
                return this.handleDownloadImage(ws, id, payload);

            case 'list-images':
                return this.sendResponse(ws, id, 'images', {
                    images: await this.imageManager.listImages()
                });

            case 'delete-image':
                return this.handleDeleteImage(ws, id, payload);

            case 'create-vm':
                return this.handleCreateVM(ws, id, payload);

            case 'start-vm':
                return this.handleStartVM(ws, id, payload);

            case 'stop-vm':
                return this.handleStopVM(ws, id, payload);

            case 'delete-vm':
                return this.handleDeleteVM(ws, id, payload);

            case 'vm-input':
                return this.handleVMInput(ws, id, payload);

            case 'vm-status':
                return this.handleVMStatus(ws, id, payload);

            case 'vm-stats':
                return this.handleVMStats(ws, id, payload);

            case 'list-vms':
                return this.sendResponse(ws, id, 'vms', {
                    vms: this.vmManager.listVMs()
                });

            case 'vnc-connect':
                return this.handleVNCConnect(ws, id, payload);

            case 'vnc-data':
                return this.handleVNCData(ws, payload);

            default:
                return this.sendError(ws, id, `Unknown command: ${type}`);
        }
    }

    handleAuth(ws, id, payload) {
        const { secret, clientType } = payload || {};

        if (!secret || !this.verifySecret(secret)) {
            ws.close(4003, 'Invalid secret');
            return;
        }

        ws.authenticated = true;
        ws.isPanel = clientType === 'panel';

        if (ws.isPanel) {
            if (this.panelConnection) {
                this.panelConnection.close(4002, 'Replaced by new panel connection');
            }
            this.panelConnection = ws;
            this.log('Panel authenticated and connected');
        }

        this.sendResponse(ws, id, 'auth-ok', {
            version: PROTOCOL_VERSION,
            nodeId: this.getNodeId()
        });
    }

    verifySecret(secret) {
        const expected = Buffer.from(this.config.secret);
        const received = Buffer.from(secret);
        if (expected.length !== received.length) return false;
        return crypto.timingSafeEqual(expected, received);
    }

    getNodeId() {
        return crypto.createHash('sha256')
            .update(this.config.secret + this.config.port)
            .digest('hex')
            .slice(0, 16);
    }

    async getStatus() {
        const vms = this.vmManager.listVMs();
        const images = await this.imageManager.listImages();
        
        return {
            nodeId: this.getNodeId(),
            version: PROTOCOL_VERSION,
            uptime: process.uptime(),
            kvm: this.config.enableKvm,
            vms: {
                total: vms.length,
                running: vms.filter(v => v.status === 'running').length
            },
            images: images.length,
            memory: process.memoryUsage(),
            platform: process.platform,
            arch: process.arch
        };
    }

    async handleDownloadImage(ws, id, payload) {
        const { imageId, url, name } = payload || {};

        if (!imageId || !url) {
            return this.sendError(ws, id, 'imageId and url required');
        }

        this.sendResponse(ws, id, 'download-started', { imageId });

        try {
            await this.imageManager.downloadImage(imageId, url, name, (progress) => {
                this.sendToPanel('download-progress', {
                    imageId,
                    ...progress
                });
            });

            this.sendToPanel('download-complete', { imageId });
        } catch (err) {
            this.sendToPanel('download-error', { imageId, error: err.message });
        }
    }

    async handleDeleteImage(ws, id, payload) {
        const { imageId } = payload || {};
        if (!imageId) {
            return this.sendError(ws, id, 'imageId required');
        }

        try {
            await this.imageManager.deleteImage(imageId);
            this.sendResponse(ws, id, 'image-deleted', { imageId });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleCreateVM(ws, id, payload) {
        const { serverId, userId, imageId, imageUrl, imageName, imageDefaultUser, ram, disk, cpuCores } = payload || {};

        if (!serverId || !userId || !imageId) {
            return this.sendError(ws, id, 'serverId, userId, imageId required');
        }

        try {
            // Check if image exists, if not download it
            const imageExists = await this.imageManager.imageExists(imageId);
            if (!imageExists) {
                if (!imageUrl) {
                    return this.sendError(ws, id, `Image ${imageId} not found and no URL provided`);
                }
                
                this.log(`Image ${imageId} not found, downloading from ${imageUrl}...`);
                this.sendToPanel('vm-output', { 
                    serverId, 
                    data: `Downloading image ${imageName || imageId}...\r\n` 
                });
                
                await this.imageManager.downloadImage(imageId, imageUrl, imageName, (progress) => {
                    if (progress.percent % 10 === 0) {
                        this.sendToPanel('vm-output', { 
                            serverId, 
                            data: `Download progress: ${progress.percent}%\r\n` 
                        });
                    }
                });
                
                // Save default user info
                if (imageDefaultUser) {
                    const metadata = await this.imageManager.getImage(imageId);
                    if (metadata) {
                        metadata.defaultUser = imageDefaultUser;
                        const fs = await import('node:fs/promises');
                        await fs.writeFile(
                            this.imageManager.getMetadataPath(imageId),
                            JSON.stringify(metadata, null, 2)
                        );
                    }
                }
                
                this.log(`Image ${imageId} downloaded successfully`);
                this.sendToPanel('vm-output', { 
                    serverId, 
                    data: `Image downloaded. Creating VM...\r\n` 
                });
            }

            const result = await this.vmManager.createVM({
                serverId,
                userId,
                imageId,
                ram: ram || 1024,
                disk: disk || '10G',
                cpuCores: cpuCores || 2
            }, this.imageManager);

            this.sendResponse(ws, id, 'vm-created', result);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleStartVM(ws, id, payload) {
        const { serverId, userId } = payload || {};

        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }

        try {
            await this.vmManager.startVM(serverId, userId);
            this.sendResponse(ws, id, 'vm-started', { serverId });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleStopVM(ws, id, payload) {
        const { serverId } = payload || {};

        if (!serverId) {
            return this.sendError(ws, id, 'serverId required');
        }

        try {
            await this.vmManager.stopVM(serverId);
            this.sendResponse(ws, id, 'vm-stopped', { serverId });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleDeleteVM(ws, id, payload) {
        const { serverId, userId } = payload || {};

        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }

        try {
            await this.vmManager.deleteVM(serverId, userId);
            this.sendResponse(ws, id, 'vm-deleted', { serverId });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    handleVMInput(ws, id, payload) {
        const { serverId, data } = payload || {};

        if (!serverId || typeof data !== 'string') {
            return this.sendError(ws, id, 'serverId and data required');
        }

        this.vmManager.sendInput(serverId, data);
    }

    handleVMStatus(ws, id, payload) {
        const { serverId } = payload || {};

        if (!serverId) {
            return this.sendError(ws, id, 'serverId required');
        }

        const status = this.vmManager.getStatus(serverId);
        this.sendResponse(ws, id, 'vm-status', { serverId, status });
    }

    async handleVMStats(ws, id, payload) {
        const { serverId } = payload || {};

        if (!serverId) {
            return this.sendError(ws, id, 'serverId required');
        }

        try {
            const stats = await this.vmManager.getStats(serverId);
            this.sendResponse(ws, id, 'vm-stats', { serverId, stats });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    handleVNCConnect(ws, id, payload) {
        const { serverId } = payload || {};

        if (!serverId) {
            return this.sendError(ws, id, 'serverId required');
        }

        try {
            const vncSocket = this.vmManager.getVNCSocket(serverId);
            if (!vncSocket) {
                return this.sendError(ws, id, 'VNC not available');
            }

            ws.vncServerId = serverId;
            ws.vncSocket = vncSocket;

            vncSocket.on('data', (data) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'vnc-data',
                        payload: { data: data.toString('base64') }
                    }));
                }
            });

            vncSocket.on('close', () => {
                ws.send(JSON.stringify({ type: 'vnc-disconnected' }));
            });

            this.sendResponse(ws, id, 'vnc-connected', { serverId });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    handleVNCData(ws, payload) {
        if (ws.vncSocket && payload.data) {
            ws.vncSocket.write(Buffer.from(payload.data, 'base64'));
        }
    }

    sendResponse(ws, id, type, payload) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type, id, payload }));
        }
    }

    sendError(ws, id, error) {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', id, payload: { error } }));
        }
    }

    sendToPanel(type, payload) {
        if (this.panelConnection && this.panelConnection.readyState === this.panelConnection.OPEN) {
            this.panelConnection.send(JSON.stringify({ type, payload }));
        }
    }

    shutdown() {
        this.log('Shutting down VMs...');
        this.vmManager.shutdown();
        
        if (this.wss) {
            this.wss.close();
        }
    }
}

export default NodeDaemon;
