import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import process from 'node:process';
import Qcow2FS from '../src/disk/Qcow2FS.js';

const DISK_NAME = 'temp_disk.qcow2';
const DISK_SIZE = '100M';

function createDisk(filename, size) {
    return new Promise((resolve, reject) => {
        console.log(`[INIT] Creating disk: ${filename} (${size})...`);
        
        const args = ['-N', `${filename}=fs:ext4:${size}`, 'exit'];
        const env = { ...process.env, LIBGUESTFS_BACKEND: 'direct' };

        const proc = spawn('guestfish', args, { env });

        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Disk creation failed. Code: ${code}`));
        });
    });
}

try {
    await createDisk(DISK_NAME, DISK_SIZE);
    
    const fs = new Qcow2FS(DISK_NAME);

    console.log('[OP] Creating directory structure...');
    await fs.mkdir('/data/logs', { recursive: true });

    console.log('[OP] Writing file...');
    await fs.writeFile('/data/logs/test.txt', 'This file lives inside the QCOW2 image.');

    console.log('[OP] verifying existence...');
    const files = await fs.readdir('/data/logs');
    console.log(`   -> Files found: [${files.join(', ')}]`);

    console.log('[OP] Reading content...');
    const content = await fs.readFile('/data/logs/test.txt', 'utf8');
    console.log(`   -> Content: "${content}"`);

} catch (error) {
    console.error('Error:', error);
} finally {
    try {
        await unlink(DISK_NAME);
    } catch (e) {
        console.error('Could not delete disk:', e.message);
    }
}
