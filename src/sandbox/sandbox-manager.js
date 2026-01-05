import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

import { getImage } from './images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '../../data/users');
const CACHE_PATH = path.join(__dirname, '../../data/images');

const ID_REGEX = /^[A-Za-z0-9_-]+$/;

function validateId(id) {
    return typeof id === 'string' && ID_REGEX.test(id) && id.length > 0 && id.length <= 64;
}

function safeJoin(base, ...segments) {
    for (const seg of segments) {
        if (!validateId(seg)) {
            throw new Error('Invalid path segment');
        }
    }
    const full = path.resolve(base, ...segments);
    if (!full.startsWith(path.resolve(base) + path.sep)) {
        throw new Error('Path traversal detected');
    }
    return full;
}

export class SandboxManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.processes = new Map();
        this.serverStatus = new Map();
        this.options = {
            maxMemoryMB: options.maxMemoryMB || 1024,
            cpuCores: options.cpuCores || 2,
            timeout: options.timeout || 0,
            qemuPath: options.qemuPath || 'qemu-system-x86_64',
            enableKvm: options.enableKvm === true
        };
    }
    
    generateQemuCpuArgs(cpuLimit) {
        const rawValue = parseFloat(cpuLimit.toString().replace('%', ''));

        if (isNaN(rawValue) || rawValue <= 0) {
            return ['-smp', '1,sockets=1,cores=1,threads=1'];
        }

        let cores = Math.ceil(rawValue / 100);
        if (cores < 1) cores = 1;

        const topology = `${cores},sockets=1,cores=${cores},threads=1`;
        const args = ['-smp', topology];

        const throttlePercent = rawValue % 100;
        if (throttlePercent > 0 && throttlePercent < 100) {
            const period = 100000;
            const quota = Math.floor(period * (throttlePercent / 100));
            args.push('-cpu', `max,throttle-period=${period},throttle-quota=${quota}`);
        }

        return args;
    }

    async updateServerLimits(userId, serverId, limits = {}) {
        const serverPath = this.getServerPath(userId, serverId);
        const metadataPath = path.join(serverPath, 'metadata.json');
        
        let metadata = {};
        try {
            const data = await fs.readFile(metadataPath, 'utf-8');
            metadata = JSON.parse(data);
        } catch {
            throw new Error('Server metadata not found');
        }

        if (limits.ram !== undefined) {
            metadata.ram = Math.max(128, Math.min(limits.ram, 65536));
        }
        if (limits.cpuLimit !== undefined) {
            metadata.cpuLimit = Math.max(10, Math.min(limits.cpuLimit, 1600));
        }
        if (limits.ioLimit !== undefined) {
            metadata.ioLimit = Math.max(0, limits.ioLimit);
        }
        if (limits.cpuCores !== undefined) {
            metadata.cpuCores = Math.max(1, Math.min(limits.cpuCores, 16));
        }

        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        
        return {
            serverId,
            updated: true,
            limits: {
                ram: metadata.ram,
                cpuLimit: metadata.cpuLimit,
                cpuCores: metadata.cpuCores,
                ioLimit: metadata.ioLimit
            },
            requiresRestart: this.processes.has(serverId)
        };
    }

    async getServerLimits(userId, serverId) {
        const serverPath = this.getServerPath(userId, serverId);
        const metadataPath = path.join(serverPath, 'metadata.json');
        
        try {
            const data = await fs.readFile(metadataPath, 'utf-8');
            const metadata = JSON.parse(data);
            return {
                ram: metadata.ram || this.options.maxMemoryMB,
                cpuLimit: metadata.cpuLimit || 100,
                cpuCores: metadata.cpuCores || this.options.cpuCores,
                ioLimit: metadata.ioLimit || 0
            };
        } catch {
            return {
                ram: this.options.maxMemoryMB,
                cpuLimit: 100,
                cpuCores: this.options.cpuCores,
                ioLimit: 0
            };
        }
    }

    getServerPath(userId, serverId) {
        return safeJoin(DATA_PATH, userId, serverId);
    }

    getDiskPath(userId, serverId) {
        return path.join(this.getServerPath(userId, serverId), 'disk.qcow2');
    }

    getLogsPath(userId, serverId) {
        return path.join(this.getServerPath(userId, serverId), 'logs');
    }

    getCachedImagePath(imageId) {
        if (!validateId(imageId)) {
            throw new Error('Invalid image ID');
        }
        return path.join(CACHE_PATH, `${imageId}.qcow2`);
    }

    generatePassword(length = 12) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const bytes = crypto.randomBytes(length);
        let password = '';
        for (let i = 0; i < length; i++) {
            password += chars[bytes[i] % chars.length];
        }
        return password;
    }

    async createCloudInit(serverPath, password, defaultUser = 'root') {
        const ciDir = path.join(serverPath, 'cloud-init');
        await fs.mkdir(ciDir, { recursive: true });

        // Configure both root and default user with same password
        const userData = `#cloud-config
users:
  - name: root
    lock_passwd: false
    plain_text_passwd: ${password}
    shell: /bin/bash
  - name: ${defaultUser}
    lock_passwd: false
    plain_text_passwd: ${password}
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: sudo, wheel

chpasswd:
  expire: false
  list: |
    root:${password}
    ${defaultUser}:${password}

ssh_pwauth: true
disable_root: false

runcmd:
  - echo "root:${password}" | chpasswd
  - echo "${defaultUser}:${password}" | chpasswd 2>/dev/null || true
`;

        const metaData = `instance-id: v87-${Date.now()}
local-hostname: v87-vm
`;

        await fs.writeFile(path.join(ciDir, 'user-data'), userData);
        await fs.writeFile(path.join(ciDir, 'meta-data'), metaData);

        // Create cloud-init ISO using genisoimage or mkisofs
        const isoPath = path.join(serverPath, 'cloud-init.iso');
        
        try {
            await this.execCommand('genisoimage', [
                '-output', isoPath,
                '-volid', 'cidata',
                '-joliet',
                '-rock',
                path.join(ciDir, 'user-data'),
                path.join(ciDir, 'meta-data')
            ]);
        } catch {
            // Try mkisofs as fallback
            try {
                await this.execCommand('mkisofs', [
                    '-output', isoPath,
                    '-volid', 'cidata',
                    '-joliet',
                    '-rock',
                    path.join(ciDir, 'user-data'),
                    path.join(ciDir, 'meta-data')
                ]);
            } catch {
                // Try xorriso as last fallback
                try {
                    await this.execCommand('xorrisofs', [
                        '-o', isoPath,
                        '-V', 'cidata',
                        '-J',
                        '-r',
                        path.join(ciDir, 'user-data'),
                        path.join(ciDir, 'meta-data')
                    ]);
                } catch {
                    // No ISO tool available, skip cloud-init
                    console.log('Warning: No ISO tool available for cloud-init');
                }
            }
        }
    }

    async downloadFile(url, dest, onProgress) {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        
        const maxRedirects = 10;
        let redirectCount = 0;
        
        const doRequest = (currentUrl) => {
            return new Promise((resolve, reject) => {
                const protocol = currentUrl.startsWith('https') ? https : http;
                
                const req = protocol.get(currentUrl, { 
                    headers: { 'User-Agent': 'V87-Panel/3.0' }
                }, (response) => {
                    // Handle redirects
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        redirectCount++;
                        if (redirectCount > maxRedirects) {
                            reject(new Error('Too many redirects'));
                            return;
                        }
                        let redirectUrl = response.headers.location;
                        // Handle relative URLs
                        if (redirectUrl.startsWith('/')) {
                            const urlObj = new URL(currentUrl);
                            redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
                        }
                        resolve(doRequest(redirectUrl));
                        return;
                    }
                    
                    if (response.statusCode !== 200) {
                        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
                        return;
                    }

                    const file = createWriteStream(dest);
                    const totalSize = parseInt(response.headers['content-length'], 10);
                    let downloaded = 0;

                    response.on('data', (chunk) => {
                        downloaded += chunk.length;
                        if (onProgress && totalSize) {
                            const percent = Math.round((downloaded / totalSize) * 100);
                            onProgress(percent, downloaded, totalSize);
                        }
                    });

                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                    
                    file.on('error', (err) => {
                        file.close();
                        fs.unlink(dest).catch(() => {});
                        reject(err);
                    });
                });
                
                req.on('error', (err) => {
                    reject(err);
                });
            });
        };
        
        return doRequest(url);
    }

    async createServer(userId, serverId, options = {}) {
        const serverPath = this.getServerPath(userId, serverId);
        const logsPath = this.getLogsPath(userId, serverId);
        const diskPath = this.getDiskPath(userId, serverId);

        await fs.mkdir(serverPath, { recursive: true });
        await fs.mkdir(logsPath, { recursive: true });
        await fs.mkdir(CACHE_PATH, { recursive: true });

        const imageId = options.imageId || 'debian-12';
        const image = getImage(imageId);
        if (!image) {
            throw new Error(`Unknown image: ${imageId}`);
        }

        const cachedImage = this.getCachedImagePath(imageId);
        
        // Check if image is cached and valid
        let needsDownload = true;
        try {
            await fs.access(cachedImage);
            // Verify it's actually qcow2
            const info = await this.execCommand('qemu-img', ['info', '--output=json', cachedImage]);
            const parsed = JSON.parse(info);
            if (parsed.format === 'qcow2') {
                this.emit('creation-progress', serverId, { percent: 50, status: 'Using cached image...' });
                needsDownload = false;
            } else {
                // Invalid cache, delete it
                await fs.unlink(cachedImage).catch(() => {});
            }
        } catch {
            // Cache doesn't exist or is invalid
            await fs.unlink(cachedImage).catch(() => {});
        }
        
        if (needsDownload) {
            // Download image
            this.emit('creation-progress', serverId, { percent: 5, status: `Downloading ${image.name}...` });
            
            const tempDownload = cachedImage + '.download';
            
            try {
                await this.downloadFile(image.url, tempDownload, (percent) => {
                    const adjustedPercent = Math.round(5 + (percent * 0.40)); // 5-45%
                    this.emit('creation-progress', serverId, { 
                        percent: adjustedPercent, 
                        status: `Downloading ${image.name}... ${percent}%` 
                    });
                });
            } catch (err) {
                await fs.unlink(tempDownload).catch(() => {});
                throw new Error(`Failed to download image: ${err.message}`);
            }
            
            // Convert to qcow2 format
            this.emit('creation-progress', serverId, { percent: 48, status: 'Converting to qcow2...' });
            
            try {
                // Detect format first
                const infoOutput = await this.execCommand('qemu-img', ['info', '--output=json', tempDownload]);
                const info = JSON.parse(infoOutput);
                const srcFormat = info.format || 'raw';
                
                if (srcFormat === 'qcow2') {
                    // Already qcow2, just rename
                    await fs.rename(tempDownload, cachedImage);
                } else {
                    // Convert to qcow2
                    await this.execCommand('qemu-img', ['convert', '-f', srcFormat, '-O', 'qcow2', tempDownload, cachedImage]);
                    await fs.unlink(tempDownload).catch(() => {});
                }
            } catch (err) {
                // If detection fails, try raw conversion
                try {
                    await this.execCommand('qemu-img', ['convert', '-O', 'qcow2', tempDownload, cachedImage]);
                    await fs.unlink(tempDownload).catch(() => {});
                } catch {
                    await fs.unlink(tempDownload).catch(() => {});
                    throw new Error(`Failed to convert image: ${err.message}`);
                }
            }
            
            // Verify conversion worked
            try {
                const verifyInfo = await this.execCommand('qemu-img', ['info', '--output=json', cachedImage]);
                const verifyParsed = JSON.parse(verifyInfo);
                if (verifyParsed.format !== 'qcow2') {
                    await fs.unlink(cachedImage).catch(() => {});
                    throw new Error('Image conversion failed - not qcow2 format');
                }
            } catch (verifyErr) {
                await fs.unlink(cachedImage).catch(() => {});
                throw new Error(`Image verification failed: ${verifyErr.message}`);
            }
        }

        this.emit('creation-progress', serverId, { percent: 55, status: 'Creating VM disk...' });

        // Create disk from cached image using qemu-img
        const diskSize = options.diskSize || '10G';
        
        // Always create a full copy (more reliable than backing files)
        try {
            await this.execCommand('qemu-img', ['convert', '-f', 'qcow2', '-O', 'qcow2', cachedImage, diskPath]);
        } catch (err) {
            throw new Error(`Failed to create disk: ${err.message}`);
        }
        
        // Resize the disk
        this.emit('creation-progress', serverId, { percent: 75, status: 'Resizing disk...' });
        try {
            await this.execCommand('qemu-img', ['resize', diskPath, diskSize]);
        } catch {
            // Ignore resize errors - some images don't support it
        }

        this.emit('creation-progress', serverId, { percent: 90, status: 'Finalizing...' });

        // Generate random password
        const password = this.generatePassword();
        
        // Create cloud-init config
        this.emit('creation-progress', serverId, { percent: 85, status: 'Configuring VM...' });
        await this.createCloudInit(serverPath, password, image.defaultUser);

        const metadata = {
            userId,
            serverId,
            createdAt: new Date().toISOString(),
            imageId,
            diskSize,
            ram: options.ram || this.options.maxMemoryMB,
            cpuCores: options.cpuCores || this.options.cpuCores,
            cpuLimit: options.cpuLimit || 100,
            ioLimit: options.ioLimit || 0,
            defaultUser: image.defaultUser,
            password: password
        };

        await fs.writeFile(
            path.join(serverPath, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
        );

        this.serverStatus.set(serverId, 'stopped');
        this.emit('creation-progress', serverId, { percent: 100, status: 'Complete', complete: true });

        return { serverPath, diskPath, logsPath };
    }

    execCommand(cmd, args) {
        return new Promise((resolve, reject) => {
            const proc = spawn(cmd, args);
            let stdout = '';
            let stderr = '';
            
            proc.stdout.on('data', (data) => { stdout += data; });
            proc.stderr.on('data', (data) => { stderr += data; });
            
            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(stderr || `Command failed with code ${code}`));
                }
            });
            
            proc.on('error', reject);
        });
    }

    async startServer(userId, serverId) {
        if (this.processes.has(serverId)) {
            throw new Error(`Server ${serverId} is already running`);
        }

        const serverPath = this.getServerPath(userId, serverId);
        const diskPath = this.getDiskPath(userId, serverId);
        const logsPath = this.getLogsPath(userId, serverId);

        await fs.access(diskPath).catch(() => {
            throw new Error(`Server ${serverId} disk not found`);
        });

        const metadataPath = path.join(serverPath, 'metadata.json');
        let metadata = {};
        try {
            const data = await fs.readFile(metadataPath, 'utf-8');
            metadata = JSON.parse(data);
        } catch {
            metadata = { ram: this.options.maxMemoryMB, cpuCores: this.options.cpuCores };
        }

        const ram = metadata.ram || this.options.maxMemoryMB;
        const cpuLimit = metadata.cpuLimit || 100;
        const ioLimit = metadata.ioLimit || 0;

        const logFile = path.join(logsPath, 'console.log');
        const logHandle = await fs.open(logFile, 'a');

        const cloudInitIso = path.join(serverPath, 'cloud-init.iso');
        
        const cpuArgs = this.generateQemuCpuArgs(cpuLimit);
        const qmpSocketPath = path.join(serverPath, 'qmp.sock');
        
        try {
            await fs.unlink(qmpSocketPath);
        } catch {}
        
        const vncSocketPath = path.join(serverPath, 'vnc.sock');
        
        try {
            await fs.unlink(vncSocketPath);
        } catch {}
        
        const qemuArgs = [
            '-m', `${ram}`,
            ...cpuArgs,
            '-drive', `file=${diskPath},format=qcow2,if=virtio${ioLimit > 0 ? `,throttling.bps-total=${ioLimit * 1024 * 1024}` : ''}`,
            '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:0-:443,hostfwd=tcp:127.0.0.1:0-:80`,
            '-device', 'virtio-net-pci,netdev=net0',
            '-device', 'virtio-balloon-pci,id=balloon0',
            '-qmp', `unix:${qmpSocketPath},server,nowait`,
            '-vnc', `unix:${vncSocketPath}`,
            '-vga', 'virtio',
            '-display', 'none',
            '-serial', 'mon:stdio'
        ];

        // Add cloud-init ISO if exists
        try {
            await fs.access(cloudInitIso);
            qemuArgs.push('-drive', `file=${cloudInitIso},format=raw,if=virtio,readonly=on`);
        } catch {
            // No cloud-init ISO
        }

        // KVM only if explicitly enabled in config
        if (this.options.enableKvm) {
            qemuArgs.push('-enable-kvm');
        }

        const proc = spawn(this.options.qemuPath, qemuArgs, {
            cwd: serverPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });

        proc.stdout.on('data', async (data) => {
            const text = data.toString();
            await logHandle.write(text);
            this.emit('log', serverId, text);
        });

        proc.stderr.on('data', async (data) => {
            const text = data.toString();
            await logHandle.write(text);
            this.emit('log', serverId, text);
        });

        proc.on('exit', async (code, signal) => {
            this.processes.delete(serverId);
            this.serverStatus.set(serverId, 'stopped');
            await logHandle.close().catch(() => {});
            this.emit('exit', serverId, code);
        });

        proc.on('error', async (err) => {
            this.processes.delete(serverId);
            this.serverStatus.set(serverId, 'stopped');
            await logHandle.close().catch(() => {});
            this.emit('error', serverId, err.message);
        });

        this.processes.set(serverId, {
            process: proc,
            userId,
            startedAt: new Date().toISOString(),
            logHandle,
            qmpSocketPath,
            vncSocketPath,
            ram,
            proxyPort: null
        });

        this.serverStatus.set(serverId, 'running');

        // Detect proxy port after 2 seconds
        setTimeout(async () => {
            try {
                const port = await this.getVmProxyPort(serverId);
                if (port) {
                    this.setProxyPort(serverId, port);
                }
            } catch {}
        }, 2000);

        if (this.options.timeout > 0) {
            setTimeout(() => {
                if (this.processes.has(serverId)) {
                    this.stopServer(serverId);
                }
            }, this.options.timeout * 1000);
        }

        return {
            pid: proc.pid,
            serverId,
            status: 'running'
        };
    }

    stopServer(serverId) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo) {
            return { serverId, status: 'already_stopped' };
        }

        const { process: proc } = serverInfo;

        // Send ACPI shutdown via monitor (Ctrl+A X for quit)
        try {
            proc.stdin.write('\x01x'); // Ctrl+A x = quit QEMU
        } catch {}

        // Force kill after 10 seconds
        setTimeout(() => {
            try {
                proc.kill('SIGTERM');
                setTimeout(() => {
                    try { proc.kill('SIGKILL'); } catch {}
                }, 5000);
            } catch {}
        }, 10000);

        this.processes.delete(serverId);
        this.serverStatus.set(serverId, 'stopped');

        return { serverId, status: 'stopped' };
    }

    async deleteServer(userId, serverId) {
        this.stopServer(serverId);

        const serverPath = this.getServerPath(userId, serverId);
        await fs.rm(serverPath, { recursive: true, force: true });
        this.serverStatus.delete(serverId);

        return { serverId, deleted: true };
    }

    getServerStatus(serverId) {
        if (this.processes.has(serverId)) {
            return 'running';
        }
        return this.serverStatus.get(serverId) || 'stopped';
    }

    async getServerLogs(serverId, lines = 200) {
        for (const [sid, info] of this.processes) {
            if (sid === serverId) {
                const logsPath = this.getLogsPath(info.userId, serverId);
                const logFile = path.join(logsPath, 'console.log');

                try {
                    const content = await fs.readFile(logFile, 'utf-8');
                    const allLines = content.split('\n');
                    return allLines.slice(-lines).join('\n');
                } catch {
                    return '';
                }
            }
        }

        try {
            const userDirs = await fs.readdir(DATA_PATH);
            for (const userId of userDirs) {
                const serverPath = path.join(DATA_PATH, userId, serverId);
                try {
                    await fs.access(serverPath);
                    const logFile = path.join(serverPath, 'logs', 'console.log');
                    const content = await fs.readFile(logFile, 'utf-8');
                    const allLines = content.split('\n');
                    return allLines.slice(-lines).join('\n');
                } catch {
                    continue;
                }
            }
        } catch {}

        return '';
    }

    sendInput(serverId, input) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo) {
            return false;
        }

        try {
            serverInfo.process.stdin.write(input);
            return true;
        } catch {
            return false;
        }
    }

    getRunningServers() {
        const servers = [];
        for (const [serverId, info] of this.processes) {
            servers.push({
                serverId,
                userId: info.userId,
                startedAt: info.startedAt,
                pid: info.process.pid
            });
        }
        return servers;
    }

    getVncSocketPath(serverId) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo || !serverInfo.vncSocketPath) {
            return null;
        }
        return serverInfo.vncSocketPath;
    }

    async qmpCommand(serverId, command, args = {}) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo || !serverInfo.qmpSocketPath) {
            throw new Error('Server not running or QMP not available');
        }

        return new Promise((resolve, reject) => {
            const socket = net.createConnection(serverInfo.qmpSocketPath);
            let buffer = '';
            let negotiated = false;
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error('QMP timeout'));
            }, 5000);

            socket.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const response = JSON.parse(line);
                        
                        if (response.QMP && !negotiated) {
                            negotiated = true;
                            socket.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
                        } else if (response.return !== undefined && negotiated) {
                            if (command === 'qmp_capabilities') {
                                return;
                            }
                            clearTimeout(timeout);
                            socket.end();
                            resolve(response.return);
                        } else if (response.error) {
                            clearTimeout(timeout);
                            socket.end();
                            reject(new Error(response.error.desc || 'QMP error'));
                        } else if (negotiated && command !== 'qmp_capabilities') {
                            socket.write(JSON.stringify({ execute: command, arguments: args }) + '\n');
                        }
                    } catch {}
                }
            });

            socket.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            socket.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }

    async getServerStats(serverId) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo) {
            return null;
        }

        const stats = {
            pid: serverInfo.process.pid,
            startedAt: serverInfo.startedAt,
            uptime: Math.floor((Date.now() - new Date(serverInfo.startedAt).getTime()) / 1000),
            configuredRam: serverInfo.ram,
            memory: null,
            cpu: null,
            block: null
        };

        try {
            const balloon = await this.qmpCommand(serverId, 'query-balloon');
            if (balloon && balloon.actual) {
                stats.memory = {
                    actual: Math.floor(balloon.actual / 1024 / 1024),
                    configured: serverInfo.ram
                };
            }
        } catch {}

        try {
            const cpus = await this.qmpCommand(serverId, 'query-cpus-fast');
            if (cpus && Array.isArray(cpus)) {
                stats.cpu = {
                    count: cpus.length,
                    cpus: cpus.map(c => ({
                        index: c['cpu-index'],
                        halted: c.halted || false
                    }))
                };
            }
        } catch {}

        try {
            const blocks = await this.qmpCommand(serverId, 'query-block');
            if (blocks && Array.isArray(blocks)) {
                stats.block = blocks
                    .filter(b => b.inserted)
                    .map(b => ({
                        device: b.device,
                        file: b.inserted?.file,
                        bytesWritten: b.inserted?.wr_bytes || 0,
                        bytesRead: b.inserted?.rd_bytes || 0,
                        opsWritten: b.inserted?.wr_operations || 0,
                        opsRead: b.inserted?.rd_operations || 0
                    }));
            }
        } catch {}

        try {
            const procStat = await fs.readFile(`/proc/${serverInfo.process.pid}/stat`, 'utf-8');
            const parts = procStat.split(' ');
            const utime = parseInt(parts[13]) || 0;
            const stime = parseInt(parts[14]) || 0;
            const starttime = parseInt(parts[21]) || 0;
            
            const uptime = await fs.readFile('/proc/uptime', 'utf-8');
            const uptimeSecs = parseFloat(uptime.split(' ')[0]);
            const hertz = 100;
            
            const totalTime = utime + stime;
            const seconds = uptimeSecs - (starttime / hertz);
            const cpuUsage = seconds > 0 ? ((totalTime / hertz) / seconds) * 100 : 0;
            
            stats.cpuUsage = Math.round(cpuUsage * 10) / 10;
        } catch {}

        return stats;
    }

    async getVmProxyPort(serverId, targetPort = 443) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo) return null;
        
        // Check if we already cached the port
        const cacheKey = `port_${targetPort}`;
        if (serverInfo[cacheKey]) {
            return serverInfo[cacheKey];
        }
        
        // Try to get port from QMP info
        try {
            const netInfo = await this.qmpCommand(serverId, 'human-monitor-command', 
                { 'command-line': 'info usernet' });
            
            // Parse output to find hostfwd port
            // Format: "TCP[HOST_FORWARD] 127.0.0.1:XXXXX -> 10.0.2.15:443"
            // or: "HOST_FORWARD 127.0.0.1 XXXXX 10.0.2.15 443"
            const lines = netInfo.split('\n');
            for (const line of lines) {
                // Match format: TCP[HOST_FORWARD] host:port -> guest:targetPort
                const match1 = line.match(/TCP.*HOST_FORWARD.*?127\.0\.0\.1[:\s]+(\d+).*?[:\s]+(\d+)\s*$/);
                if (match1 && parseInt(match1[2]) === targetPort) {
                    const port = parseInt(match1[1]);
                    serverInfo[cacheKey] = port;
                    return port;
                }
                
                // Alternative format with arrow
                const match2 = line.match(/127\.0\.0\.1:(\d+)\s*->\s*[\d\.]+:(\d+)/);
                if (match2 && parseInt(match2[2]) === targetPort) {
                    const port = parseInt(match2[1]);
                    serverInfo[cacheKey] = port;
                    return port;
                }
                
                // Simple format: just find port -> targetPort pattern
                const match3 = line.match(/:(\d+)\s*(?:->|to)\s*.*?:(\d+)/i);
                if (match3 && parseInt(match3[2]) === targetPort) {
                    const port = parseInt(match3[1]);
                    serverInfo[cacheKey] = port;
                    return port;
                }
            }
        } catch (err) {
            // QMP command failed
        }
        
        return null;
    }
    
    async getVmProxyPort80(serverId) {
        return this.getVmProxyPort(serverId, 80);
    }

    getProxyInfo(serverId) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo) return null;
        return {
            running: true,
            proxyPort: serverInfo.proxyPort
        };
    }

    setProxyPort(serverId, port) {
        const serverInfo = this.processes.get(serverId);
        if (serverInfo) {
            serverInfo.proxyPort = port;
        }
    }

    shutdown() {
        for (const serverId of this.processes.keys()) {
            this.stopServer(serverId);
        }
    }

    async createSnapshot(userId, serverId, snapshotName) {
        const diskPath = this.getDiskPath(userId, serverId);
        const snapshotsDir = path.join(this.getServerPath(userId, serverId), 'snapshots');
        await fs.mkdir(snapshotsDir, { recursive: true });
        
        const snapshotId = Date.now().toString();
        const snapshotFile = path.join(snapshotsDir, `${snapshotId}.qcow2`);
        
        await this.execCommand('qemu-img', [
            'create', '-f', 'qcow2',
            '-b', diskPath, '-F', 'qcow2',
            snapshotFile
        ]);
        
        const metaFile = path.join(snapshotsDir, `${snapshotId}.json`);
        await fs.writeFile(metaFile, JSON.stringify({
            id: snapshotId,
            name: snapshotName || `Snapshot ${new Date().toLocaleString()}`,
            createdAt: new Date().toISOString(),
            parentDisk: diskPath
        }, null, 2));
        
        return { id: snapshotId, name: snapshotName };
    }

    async listSnapshots(userId, serverId) {
        const snapshotsDir = path.join(this.getServerPath(userId, serverId), 'snapshots');
        
        try {
            const files = await fs.readdir(snapshotsDir);
            const snapshots = [];
            
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const data = JSON.parse(await fs.readFile(path.join(snapshotsDir, file), 'utf-8'));
                    const qcowFile = path.join(snapshotsDir, `${data.id}.qcow2`);
                    try {
                        const stat = await fs.stat(qcowFile);
                        data.size = stat.size;
                    } catch {}
                    snapshots.push(data);
                }
            }
            
            return snapshots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } catch {
            return [];
        }
    }

    async restoreSnapshot(userId, serverId, snapshotId) {
        if (this.processes.has(serverId)) {
            throw new Error('Stop the VM before restoring a snapshot');
        }
        
        const snapshotsDir = path.join(this.getServerPath(userId, serverId), 'snapshots');
        const snapshotFile = path.join(snapshotsDir, `${snapshotId}.qcow2`);
        const diskPath = this.getDiskPath(userId, serverId);
        const backupPath = diskPath + '.backup';
        
        try {
            await fs.access(snapshotFile);
        } catch {
            throw new Error('Snapshot not found');
        }
        
        await fs.rename(diskPath, backupPath);
        
        try {
            await this.execCommand('qemu-img', [
                'create', '-f', 'qcow2',
                '-b', snapshotFile, '-F', 'qcow2',
                diskPath
            ]);
            await fs.unlink(backupPath);
        } catch (err) {
            await fs.rename(backupPath, diskPath);
            throw err;
        }
        
        return { restored: true, snapshotId };
    }

    async deleteSnapshot(userId, serverId, snapshotId) {
        const snapshotsDir = path.join(this.getServerPath(userId, serverId), 'snapshots');
        const snapshotFile = path.join(snapshotsDir, `${snapshotId}.qcow2`);
        const metaFile = path.join(snapshotsDir, `${snapshotId}.json`);
        
        try {
            await fs.unlink(snapshotFile);
        } catch {}
        try {
            await fs.unlink(metaFile);
        } catch {}
        
        return { deleted: true };
    }

    async resizeDisk(userId, serverId, newSizeGB) {
        if (this.processes.has(serverId)) {
            throw new Error('Stop the VM before resizing disk');
        }
        
        const diskPath = this.getDiskPath(userId, serverId);
        const newSize = `${newSizeGB}G`;
        
        const info = await this.execCommand('qemu-img', ['info', '--output=json', diskPath]);
        const parsed = JSON.parse(info);
        const currentSizeGB = Math.ceil(parsed['virtual-size'] / (1024 * 1024 * 1024));
        
        if (newSizeGB < currentSizeGB) {
            throw new Error(`Cannot shrink disk. Current: ${currentSizeGB}GB, requested: ${newSizeGB}GB`);
        }
        
        await this.execCommand('qemu-img', ['resize', diskPath, newSize]);
        
        const serverPath = this.getServerPath(userId, serverId);
        const metadataPath = path.join(serverPath, 'metadata.json');
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        metadata.diskSize = newSize;
        await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
        
        return { success: true, newSize, previousSize: `${currentSizeGB}G` };
    }

    async hotplugRam(serverId, newRamMB) {
        const serverInfo = this.processes.get(serverId);
        if (!serverInfo) {
            throw new Error('VM must be running for RAM hotplug');
        }
        
        const targetBytes = newRamMB * 1024 * 1024;
        await this.qmpCommand(serverId, 'balloon', { value: targetBytes });
        
        return { success: true, requestedRam: newRamMB };
    }
}
