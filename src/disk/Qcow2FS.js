import { spawn } from 'node:child_process';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';

export default class Qcow2FS {
    constructor(imagePath, partition = '/dev/sda1') {
        this.imagePath = path.resolve(imagePath);
        this.partition = partition;

        this.env = { ...process.env, LIBGUESTFS_BACKEND: 'direct' };
    }

    async _exec(commands) {
        return new Promise((resolve, reject) => {
            const args = ['--rw', '-a', this.imagePath];
            const proc = spawn('guestfish', args, { env: this.env });
            
            let stdoutChunks = [];
            let stderrChunks = [];

            proc.stdin.write(`run\n`);
            proc.stdin.write(`mount ${this.partition} /\n`);
            
            commands.forEach(cmd => proc.stdin.write(`${cmd}\n`));
            
            proc.stdin.write(`exit\n`);
            proc.stdin.end();

            proc.stdout.on('data', chunk => stdoutChunks.push(chunk));
            proc.stderr.on('data', chunk => stderrChunks.push(chunk));

            proc.on('close', code => {
                const stderr = Buffer.concat(stderrChunks).toString();
                const realErrors = stderr.split('\n').filter(l => l && !l.includes('warning:'));

                if (code !== 0 && realErrors.length > 0) {
                    reject(new Error(`Qcow2FS Error: ${realErrors.join('\n')}`));
                } else {
                    resolve(Buffer.concat(stdoutChunks));
                }
            });
        });
    }

    async readFile(filePath, options) {
        const encoding = typeof options === 'string' ? options : options?.encoding;
        const buffer = await this._exec([`cat "${filePath}"`]);
        
        if (encoding) return buffer.toString(encoding);
        return buffer;
    }

    async writeFile(filePath, data) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        const b64 = buffer.toString('base64');
        const tempPath = `${filePath}.tmp_${Date.now()}`;

        await this._exec([
            `write "${tempPath}" "${b64}"`,
            `base64-decode "${tempPath}" "${filePath}"`,
            `rm "${tempPath}"`
        ]);
    }

    async appendFile(filePath, data) {
        const strData = String(data).replace(/"/g, '\\"');
        await this._exec([`write-append "${filePath}" "${strData}"`]);
    }

    async readdir(dirPath) {
        const output = await this._exec([`ls "${dirPath}"`]);
        return output.toString().split('\n').filter(Boolean);
    }

    async mkdir(dirPath, options = {}) {
        const cmd = options.recursive ? `mkdir-p "${dirPath}"` : `mkdir "${dirPath}"`;
        await this._exec([cmd]);
    }

    async unlink(filePath) {
        await this._exec([`rm "${filePath}"`]);
    }

    async rm(targetPath, options = {}) {
        const cmd = options.recursive ? `rm-rf "${targetPath}"` : `rm "${targetPath}"`;
        await this._exec([cmd]);
    }

    async rename(oldPath, newPath) {
        await this._exec([`mv "${oldPath}" "${newPath}"`]);
    }

    async copyFile(src, dest) {
        await this._exec([`cp "${src}" "${dest}"`]);
    }

    async chmod(filePath, mode) {
        await this._exec([`chmod ${mode} "${filePath}"`]);
    }

    async exists(filePath) {
        const out = await this._exec([`exists "${filePath}"`]);
        return out.toString().trim() === 'true';
    }

    async stat(filePath) {
        const out = await this._exec([`stat "${filePath}"`]);
        const lines = out.toString().split('\n');
        const stats = {};

        lines.forEach(line => {
            const [key, ...val] = line.split(': ');
            if (key) stats[key.trim()] = val.join(': ').trim();
        });

        const modeNum = parseInt(stats.mode || 0);

        return {
            size: parseInt(stats.size || 0),
            mode: modeNum,
            uid: parseInt(stats.uid || 0),
            gid: parseInt(stats.gid || 0),
            isFile: () => !stats.mode?.includes('directory'),
            isDirectory: () => stats.mode?.includes('directory') || (modeNum & 0o040000) === 0o040000,
            _raw: stats
        };
    }
}