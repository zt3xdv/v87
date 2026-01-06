import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const ID_REGEX = /^[A-Za-z0-9_-]+$/;

function validateId(id) {
    return typeof id === 'string' && ID_REGEX.test(id) && id.length > 0 && id.length <= 64;
}

export class VMManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.dataDir = options.dataDir || './data';
        this.vmsDir = path.join(this.dataDir, 'vms');
        this.enableKvm = options.enableKvm || false;
        this.qemuPath = options.qemuPath || 'qemu-system-x86_64';
        
        this.processes = new Map();
    }

    async ensureDir(dir) {
        await fs.mkdir(dir, { recursive: true });
    }

    getVMPath(userId, serverId) {
        return path.join(this.vmsDir, userId, serverId);
    }

    getDiskPath(userId, serverId) {
        return path.join(this.getVMPath(userId, serverId), 'disk.qcow2');
    }

    getSocketPath(serverId, type) {
        return path.join(this.vmsDir, `${serverId}-${type}.sock`);
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

    async createVM(config, imageManager) {
        const { serverId, userId, imageId, ram, disk, cpuCores } = config;

        if (!validateId(serverId) || !validateId(userId) || !validateId(imageId)) {
            throw new Error('Invalid ID format');
        }

        const vmPath = this.getVMPath(userId, serverId);
        await this.ensureDir(vmPath);

        const imagePath = imageManager.getImagePath(imageId);
        const imageExists = await imageManager.imageExists(imageId);
        
        if (!imageExists) {
            throw new Error(`Image ${imageId} not found. Download it first.`);
        }

        const diskPath = this.getDiskPath(userId, serverId);
        
        await this.execCommand('qemu-img', [
            'create', '-f', 'qcow2',
            '-b', imagePath,
            '-F', 'qcow2',
            diskPath,
            disk || '10G'
        ]);

        const password = this.generatePassword();
        const imageData = await imageManager.getImage(imageId);

        await this.createCloudInit(vmPath, password, imageData?.defaultUser || 'root');

        const metadata = {
            serverId,
            userId,
            imageId,
            ram: ram || 1024,
            disk: disk || '10G',
            cpuCores: cpuCores || 2,
            password,
            createdAt: new Date().toISOString()
        };

        await fs.writeFile(
            path.join(vmPath, 'metadata.json'),
            JSON.stringify(metadata, null, 2)
        );

        return {
            serverId,
            userId,
            password,
            created: true
        };
    }

    async createCloudInit(vmPath, password, defaultUser = 'root') {
        const ciDir = path.join(vmPath, 'cloud-init');
        await this.ensureDir(ciDir);

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

        const isoPath = path.join(vmPath, 'cloud-init.iso');

        const isoTools = ['genisoimage', 'mkisofs', 'xorrisofs'];
        
        for (const tool of isoTools) {
            try {
                const args = tool === 'xorrisofs'
                    ? ['-o', isoPath, '-V', 'cidata', '-J', '-r', 
                       path.join(ciDir, 'user-data'), path.join(ciDir, 'meta-data')]
                    : ['-output', isoPath, '-volid', 'cidata', '-joliet', '-rock',
                       path.join(ciDir, 'user-data'), path.join(ciDir, 'meta-data')];
                
                await this.execCommand(tool, args);
                return;
            } catch {}
        }
    }

    async startVM(serverId, userId) {
        if (this.processes.has(serverId)) {
            throw new Error('VM already running');
        }

        const vmPath = this.getVMPath(userId, serverId);
        const diskPath = this.getDiskPath(userId, serverId);
        const metadataPath = path.join(vmPath, 'metadata.json');

        let metadata;
        try {
            metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));
        } catch {
            throw new Error('VM not found');
        }

        const serialSocket = this.getSocketPath(serverId, 'serial');
        const monitorSocket = this.getSocketPath(serverId, 'monitor');
        const qmpSocket = this.getSocketPath(serverId, 'qmp');
        const vncSocket = this.getSocketPath(serverId, 'vnc');

        for (const sock of [serialSocket, monitorSocket, qmpSocket, vncSocket]) {
            try { await fs.unlink(sock); } catch {}
        }

        const args = [
            '-name', `v87-${serverId}`,
            '-m', `${metadata.ram}`,
            '-smp', `${metadata.cpuCores}`,
            '-drive', `file=${diskPath},format=qcow2,if=virtio`,
            '-netdev', 'user,id=net0',
            '-device', 'virtio-net-pci,netdev=net0',
            '-serial', `unix:${serialSocket},server,nowait`,
            '-monitor', `unix:${monitorSocket},server,nowait`,
            '-qmp', `unix:${qmpSocket},server,nowait`,
            '-vnc', `unix:${vncSocket}`,
            '-nographic'
        ];

        if (this.enableKvm) {
            args.unshift('-enable-kvm');
            args.push('-cpu', 'host');
        }

        const ciIso = path.join(vmPath, 'cloud-init.iso');
        try {
            await fs.access(ciIso);
            args.push('-cdrom', ciIso);
        } catch {}

        const proc = spawn(this.qemuPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
        });

        this.processes.set(serverId, {
            process: proc,
            userId,
            metadata,
            serialSocket,
            monitorSocket,
            qmpSocket,
            vncSocket,
            startedAt: new Date().toISOString()
        });

        proc.on('exit', (code) => {
            this.processes.delete(serverId);
            this.emit('vm-status', serverId, 'stopped');
        });

        await new Promise(resolve => setTimeout(resolve, 500));

        this.connectSerial(serverId);
        
        this.emit('vm-status', serverId, 'running');
        
        return { started: true };
    }

    connectSerial(serverId) {
        const info = this.processes.get(serverId);
        if (!info) return;

        const connect = () => {
            const socket = net.createConnection(info.serialSocket);
            
            socket.on('connect', () => {
                info.serialConnection = socket;
            });

            socket.on('data', (data) => {
                this.emit('vm-output', serverId, data.toString());
            });

            socket.on('error', () => {
                setTimeout(() => {
                    if (this.processes.has(serverId)) {
                        connect();
                    }
                }, 1000);
            });

            socket.on('close', () => {
                if (this.processes.has(serverId)) {
                    setTimeout(connect, 1000);
                }
            });
        };

        setTimeout(connect, 500);
    }

    sendInput(serverId, data) {
        const info = this.processes.get(serverId);
        if (info?.serialConnection && !info.serialConnection.destroyed) {
            info.serialConnection.write(data);
        }
    }

    async stopVM(serverId) {
        const info = this.processes.get(serverId);
        if (!info) {
            throw new Error('VM not running');
        }

        try {
            await this.qmpCommand(serverId, 'system_powerdown');
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    info.process.kill('SIGKILL');
                    resolve();
                }, 30000);

                info.process.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        } catch {
            info.process.kill('SIGKILL');
        }

        this.processes.delete(serverId);
        this.emit('vm-status', serverId, 'stopped');
        
        return { stopped: true };
    }

    async deleteVM(serverId, userId) {
        if (this.processes.has(serverId)) {
            await this.stopVM(serverId);
        }

        const vmPath = this.getVMPath(userId, serverId);
        
        try {
            await fs.rm(vmPath, { recursive: true, force: true });
        } catch {}

        for (const type of ['serial', 'monitor', 'qmp', 'vnc']) {
            try {
                await fs.unlink(this.getSocketPath(serverId, type));
            } catch {}
        }

        return { deleted: true };
    }

    getStatus(serverId) {
        return this.processes.has(serverId) ? 'running' : 'stopped';
    }

    async getStats(serverId) {
        const info = this.processes.get(serverId);
        if (!info) {
            throw new Error('VM not running');
        }

        const stats = {
            pid: info.process.pid,
            startedAt: info.startedAt,
            uptime: Math.floor((Date.now() - new Date(info.startedAt).getTime()) / 1000),
            ram: info.metadata.ram,
            cpuCores: info.metadata.cpuCores
        };

        try {
            const balloon = await this.qmpCommand(serverId, 'query-balloon');
            if (balloon?.actual) {
                stats.actualMemory = Math.floor(balloon.actual / 1024 / 1024);
            }
        } catch {}

        return stats;
    }

    listVMs() {
        const vms = [];
        for (const [serverId, info] of this.processes) {
            vms.push({
                serverId,
                userId: info.userId,
                status: 'running',
                startedAt: info.startedAt,
                ram: info.metadata.ram,
                cpuCores: info.metadata.cpuCores
            });
        }
        return vms;
    }

    getVNCSocket(serverId) {
        const info = this.processes.get(serverId);
        if (!info) return null;

        return net.createConnection(info.vncSocket);
    }

    async qmpCommand(serverId, command, args = {}) {
        const info = this.processes.get(serverId);
        if (!info) throw new Error('VM not running');

        return new Promise((resolve, reject) => {
            const socket = net.createConnection(info.qmpSocket);
            let buffer = '';
            let initialized = false;

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
                        const msg = JSON.parse(line);
                        
                        if (msg.QMP && !initialized) {
                            initialized = true;
                            socket.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
                            return;
                        }

                        if (msg.return !== undefined && initialized) {
                            if (command === 'qmp_capabilities') {
                                return;
                            }
                            socket.write(JSON.stringify({ 
                                execute: command, 
                                arguments: args 
                            }) + '\n');
                            return;
                        }

                        if (msg.return !== undefined) {
                            clearTimeout(timeout);
                            socket.destroy();
                            resolve(msg.return);
                            return;
                        }

                        if (msg.error) {
                            clearTimeout(timeout);
                            socket.destroy();
                            reject(new Error(msg.error.desc || 'QMP error'));
                            return;
                        }
                    } catch {}
                }
            });

            socket.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
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
                    reject(new Error(stderr || `Exit code ${code}`));
                }
            });

            proc.on('error', reject);
        });
    }

    shutdown() {
        for (const [serverId, info] of this.processes) {
            try {
                info.process.kill('SIGTERM');
            } catch {}
        }
        this.processes.clear();
    }
}

export default VMManager;
