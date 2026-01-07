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

        // Bandwidth optimization: batching, throttling, subscriptions
        this.panelBatchQueue = [];
        this.panelBatchTimer = null;
        this.lastVmStatusByServer = new Map();
        this.subscribedVmOutput = new Set(); // Only send output for subscribed VMs
        
        this.vmManager.on('vm-output', (serverId, data) => {
            // Only queue if someone is watching this VM
            if (this.subscribedVmOutput.has(serverId)) {
                // Truncate very long output bursts to prevent flooding
                const truncatedData = typeof data === 'string' && data.length > 4096 
                    ? data.slice(0, 4096) 
                    : data;
                this.queuePanelEvent('vm-output', { serverId, data: truncatedData });
            }
        });
        
        this.vmManager.on('vm-status', (serverId, status) => {
            // Delta: only send if status changed
            const prev = this.lastVmStatusByServer.get(serverId);
            if (prev !== status) {
                this.lastVmStatusByServer.set(serverId, status);
                this.queuePanelEvent('vm-status', { serverId, status });
            }
        });
    }

    queuePanelEvent(type, payload) {
        const isHighPriority = (type === 'vm-status');
        this.panelBatchQueue.push({ type, payload, priority: isHighPriority ? 1 : 0 });

        if (!this.panelBatchTimer) {
            // Batch for 20ms to reduce message count
            this.panelBatchTimer = setTimeout(() => {
                this.flushPanelBatch();
            }, 20);
        }
    }

    flushPanelBatch() {
        this.panelBatchTimer = null;
        
        if (!this.panelConnection || this.panelConnection.readyState !== this.panelConnection.OPEN) {
            this.panelBatchQueue = [];
            return;
        }

        if (this.panelBatchQueue.length === 0) return;

        // Cap batch size to prevent overwhelming the connection
        const MAX_BATCH_MESSAGES = 500;
        const batch = this.panelBatchQueue.slice(0, MAX_BATCH_MESSAGES);
        this.panelBatchQueue = this.panelBatchQueue.slice(MAX_BATCH_MESSAGES);

        // Sort by priority (status events first)
        batch.sort((a, b) => b.priority - a.priority);

        // Send batched message
        this.panelConnection.send(JSON.stringify({
            type: 'batch',
            payload: { messages: batch.map(({ priority, ...m }) => m) }
        }));

        // If there are leftovers, schedule another flush
        if (this.panelBatchQueue.length > 0 && !this.panelBatchTimer) {
            this.panelBatchTimer = setTimeout(() => this.flushPanelBatch(), 5);
        }
    }

    log(message) {
        const now = new Date();
        const time = now.toTimeString().slice(0, 8);
        console.log(`\x1b[90m${time}\x1b[0m ${message}`);
    }

    start() {
        this.wss = new WebSocketServer({
            port: this.config.port,
            host: this.config.host,
            // Enable permessage-deflate compression for bandwidth reduction
            perMessageDeflate: {
                threshold: 512, // Compress messages larger than 512 bytes
                clientNoContextTakeover: true,
                serverNoContextTakeover: true,
                zlibDeflateOptions: {
                    level: 6 // Balanced compression
                }
            }
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

        ws.on('message', async (data, isBinary) => {
            try {
                // Handle binary VNC data from panel
                if (isBinary && Buffer.isBuffer(data)) {
                    this.handleBinaryMessage(ws, data);
                    return;
                }
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

            case 'resize-disk':
                return this.handleResizeDisk(ws, id, payload);

            case 'disk-info':
                return this.handleDiskInfo(ws, id, payload);

            case 'get-limits':
                return this.handleGetLimits(ws, id, payload);

            case 'update-limits':
                return this.handleUpdateLimits(ws, id, payload);

            case 'create-snapshot':
                return this.handleCreateSnapshot(ws, id, payload);

            case 'list-snapshots':
                return this.handleListSnapshots(ws, id, payload);

            case 'restore-snapshot':
                return this.handleRestoreSnapshot(ws, id, payload);

            case 'delete-snapshot':
                return this.handleDeleteSnapshot(ws, id, payload);

            // Subscription management for bandwidth optimization
            case 'subscribe-vm-output':
                return this.handleSubscribeVmOutput(ws, id, payload);

            case 'unsubscribe-vm-output':
                return this.handleUnsubscribeVmOutput(ws, id, payload);

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

            // VNC optimization: throttle to ~30fps, use binary frames
            const OPCODE_VNC_DATA = 0x01;
            const OPCODE_VNC_DISCONNECTED = 0x02;
            const MIN_FRAME_INTERVAL_MS = 33; // ~30fps cap
            
            let vncPendingBuffer = Buffer.alloc(0);
            let lastFrameTime = 0;
            let frameTimer = null;

            const sendVncFrame = () => {
                frameTimer = null;
                if (ws.readyState !== ws.OPEN) return;
                if (vncPendingBuffer.length === 0) return;

                const now = Date.now();
                const elapsed = now - lastFrameTime;
                
                if (elapsed < MIN_FRAME_INTERVAL_MS) {
                    // Schedule to send later
                    if (!frameTimer) {
                        frameTimer = setTimeout(sendVncFrame, MIN_FRAME_INTERVAL_MS - elapsed);
                    }
                    return;
                }

                lastFrameTime = now;
                const frameData = vncPendingBuffer;
                vncPendingBuffer = Buffer.alloc(0);

                // Send as binary frame with opcode prefix (no base64 overhead)
                const buf = Buffer.alloc(1 + frameData.length);
                buf.writeUInt8(OPCODE_VNC_DATA, 0);
                frameData.copy(buf, 1);
                ws.send(buf);
            };

            vncSocket.on('data', (data) => {
                vncPendingBuffer = Buffer.concat([vncPendingBuffer, data]);
                if (!frameTimer) {
                    sendVncFrame();
                }
            });

            vncSocket.on('close', () => {
                if (ws.readyState === ws.OPEN) {
                    const buf = Buffer.alloc(1);
                    buf.writeUInt8(OPCODE_VNC_DISCONNECTED, 0);
                    ws.send(buf);
                }
            });

            this.sendResponse(ws, id, 'vnc-connected', { serverId });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    handleBinaryMessage(ws, buffer) {
        if (buffer.length < 1) return;
        
        const OPCODE_VNC_DATA = 0x01;
        const opcode = buffer.readUInt8(0);
        const payload = buffer.subarray(1);

        if (opcode === OPCODE_VNC_DATA && ws.vncSocket) {
            ws.vncSocket.write(payload);
        }
    }

    handleVNCData(ws, payload) {
        if (ws.vncSocket && payload.data) {
            // Support both binary buffer and base64 string for backwards compatibility
            const data = Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(payload.data, 'base64');
            ws.vncSocket.write(data);
        }
    }

    async handleResizeDisk(ws, id, payload) {
        const { serverId, userId, newSizeGB } = payload || {};
        if (!serverId || !userId || !newSizeGB) {
            return this.sendError(ws, id, 'serverId, userId, newSizeGB required');
        }
        try {
            const result = await this.vmManager.resizeDisk(userId, serverId, newSizeGB);
            this.sendResponse(ws, id, 'disk-resized', result);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleDiskInfo(ws, id, payload) {
        const { serverId, userId } = payload || {};
        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }
        try {
            const info = await this.vmManager.getDiskInfo(userId, serverId);
            this.sendResponse(ws, id, 'disk-info', info);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleGetLimits(ws, id, payload) {
        const { serverId, userId } = payload || {};
        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }
        try {
            const limits = await this.vmManager.getServerLimits(userId, serverId);
            this.sendResponse(ws, id, 'limits', limits);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleUpdateLimits(ws, id, payload) {
        const { serverId, userId, limits } = payload || {};
        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }
        try {
            const result = await this.vmManager.updateServerLimits(userId, serverId, limits);
            this.sendResponse(ws, id, 'limits-updated', result);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleCreateSnapshot(ws, id, payload) {
        const { serverId, userId, name } = payload || {};
        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }
        try {
            const result = await this.vmManager.createSnapshot(userId, serverId, name);
            this.sendResponse(ws, id, 'snapshot-created', result);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleListSnapshots(ws, id, payload) {
        const { serverId, userId } = payload || {};
        if (!serverId || !userId) {
            return this.sendError(ws, id, 'serverId, userId required');
        }
        try {
            const snapshots = await this.vmManager.listSnapshots(userId, serverId);
            this.sendResponse(ws, id, 'snapshots', { snapshots });
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleRestoreSnapshot(ws, id, payload) {
        const { serverId, userId, snapshotId } = payload || {};
        if (!serverId || !userId || !snapshotId) {
            return this.sendError(ws, id, 'serverId, userId, snapshotId required');
        }
        try {
            const result = await this.vmManager.restoreSnapshot(userId, serverId, snapshotId);
            this.sendResponse(ws, id, 'snapshot-restored', result);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    async handleDeleteSnapshot(ws, id, payload) {
        const { serverId, userId, snapshotId } = payload || {};
        if (!serverId || !userId || !snapshotId) {
            return this.sendError(ws, id, 'serverId, userId, snapshotId required');
        }
        try {
            const result = await this.vmManager.deleteSnapshot(userId, serverId, snapshotId);
            this.sendResponse(ws, id, 'snapshot-deleted', result);
        } catch (err) {
            this.sendError(ws, id, err.message);
        }
    }

    handleSubscribeVmOutput(ws, id, payload) {
        const { serverId } = payload || {};
        if (!serverId) {
            return this.sendError(ws, id, 'serverId required');
        }
        this.subscribedVmOutput.add(serverId);
        this.sendResponse(ws, id, 'subscribed-vm-output', { serverId });
    }

    handleUnsubscribeVmOutput(ws, id, payload) {
        const { serverId } = payload || {};
        if (!serverId) {
            return this.sendError(ws, id, 'serverId required');
        }
        this.subscribedVmOutput.delete(serverId);
        this.sendResponse(ws, id, 'unsubscribed-vm-output', { serverId });
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
