import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';

import { getImage } from './images.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '../../data/users');
const CACHE_PATH = path.join(__dirname, '../../data/images');

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

    getServerPath(userId, serverId) {
        return path.join(DATA_PATH, userId, serverId);
    }

    getDiskPath(userId, serverId) {
        return path.join(this.getServerPath(userId, serverId), 'disk.qcow2');
    }

    getLogsPath(userId, serverId) {
        return path.join(this.getServerPath(userId, serverId), 'logs');
    }

    getCachedImagePath(imageId) {
        return path.join(CACHE_PATH, `${imageId}.qcow2`);
    }

    generatePassword(length = 12) {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let password = '';
        for (let i = 0; i < length; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
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
        const cpus = metadata.cpuCores || this.options.cpuCores;

        const logFile = path.join(logsPath, 'console.log');
        const logHandle = await fs.open(logFile, 'a');

        const cloudInitIso = path.join(serverPath, 'cloud-init.iso');
        
        const qemuArgs = [
            '-m', `${ram}`,
            '-smp', `${cpus}`,
            '-drive', `file=${diskPath},format=qcow2,if=virtio`,
            '-netdev', 'user,id=net0',
            '-device', 'virtio-net-pci,netdev=net0',
            '-nographic',
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
            const timestamp = new Date().toISOString();
            await logHandle.write(`[${timestamp}] ${text}`);
            this.emit('log', serverId, text);
        });

        proc.stderr.on('data', async (data) => {
            const text = data.toString();
            const timestamp = new Date().toISOString();
            await logHandle.write(`[${timestamp}] [ERR] ${text}`);
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
            logHandle
        });

        this.serverStatus.set(serverId, 'running');

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

    shutdown() {
        for (const serverId of this.processes.keys()) {
            this.stopServer(serverId);
        }
    }
}
