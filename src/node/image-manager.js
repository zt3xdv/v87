import fs from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

export class ImageManager {
    constructor(options = {}) {
        this.dataDir = path.resolve(options.dataDir || './data');
        this.imagesDir = path.join(this.dataDir, 'images');
        this.downloads = new Map();
    }

    async ensureDir() {
        await fs.mkdir(this.imagesDir, { recursive: true });
    }

    getImagePath(imageId) {
        return path.resolve(this.imagesDir, `${imageId}.qcow2`);
    }

    getMetadataPath(imageId) {
        return path.resolve(this.imagesDir, `${imageId}.json`);
    }

    async listImages() {
        await this.ensureDir();
        
        try {
            const files = await fs.readdir(this.imagesDir);
            const images = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const data = JSON.parse(
                            await fs.readFile(path.join(this.imagesDir, file), 'utf-8')
                        );
                        const qcowPath = this.getImagePath(data.id);
                        
                        try {
                            const stat = await fs.stat(qcowPath);
                            data.size = stat.size;
                            data.exists = true;
                        } catch {
                            data.exists = false;
                        }
                        
                        images.push(data);
                    } catch {}
                }
            }

            return images;
        } catch {
            return [];
        }
    }

    async imageExists(imageId) {
        try {
            await fs.access(this.getImagePath(imageId));
            return true;
        } catch {
            return false;
        }
    }

    async getImage(imageId) {
        try {
            const metadata = JSON.parse(
                await fs.readFile(this.getMetadataPath(imageId), 'utf-8')
            );
            return metadata;
        } catch {
            return null;
        }
    }

    async downloadImage(imageId, url, name, onProgress) {
        await this.ensureDir();

        if (this.downloads.has(imageId)) {
            throw new Error('Download already in progress');
        }

        const destPath = this.getImagePath(imageId);
        const tempPath = `${destPath}.tmp`;

        this.downloads.set(imageId, { status: 'downloading', progress: 0 });

        try {
            await this.downloadFile(url, tempPath, (progress) => {
                this.downloads.set(imageId, { status: 'downloading', ...progress });
                if (onProgress) onProgress(progress);
            });

            await fs.rename(tempPath, destPath);

            const stat = await fs.stat(destPath);
            const metadata = {
                id: imageId,
                name: name || imageId,
                url,
                size: stat.size,
                downloadedAt: new Date().toISOString()
            };

            await fs.writeFile(
                this.getMetadataPath(imageId),
                JSON.stringify(metadata, null, 2)
            );

            this.downloads.delete(imageId);
            return metadata;
        } catch (err) {
            this.downloads.delete(imageId);
            try {
                await fs.unlink(tempPath);
            } catch {}
            throw err;
        }
    }

    downloadFile(url, dest, onProgress) {
        return new Promise((resolve, reject) => {
            const file = createWriteStream(dest);
            const protocol = url.startsWith('https') ? https : http;

            const request = (currentUrl, redirects = 0) => {
                if (redirects > 10) {
                    reject(new Error('Too many redirects'));
                    return;
                }

                protocol.get(currentUrl, { 
                    headers: { 'User-Agent': 'v87-node/1.0' }
                }, (response) => {
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                        const redirectUrl = response.headers.location.startsWith('http')
                            ? response.headers.location
                            : new URL(response.headers.location, currentUrl).href;
                        request(redirectUrl, redirects + 1);
                        return;
                    }

                    if (response.statusCode !== 200) {
                        reject(new Error(`HTTP ${response.statusCode}`));
                        return;
                    }

                    const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
                    let downloadedBytes = 0;
                    let lastProgress = 0;

                    response.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        const percent = totalBytes > 0 
                            ? Math.floor((downloadedBytes / totalBytes) * 100) 
                            : 0;

                        if (percent !== lastProgress) {
                            lastProgress = percent;
                            if (onProgress) {
                                onProgress({
                                    percent,
                                    downloadedBytes,
                                    totalBytes
                                });
                            }
                        }
                    });

                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });

                    file.on('error', (err) => {
                        file.close();
                        reject(err);
                    });
                }).on('error', reject);
            };

            request(url);
        });
    }

    async deleteImage(imageId) {
        const imagePath = this.getImagePath(imageId);
        const metaPath = this.getMetadataPath(imageId);

        try {
            await fs.unlink(imagePath);
        } catch {}

        try {
            await fs.unlink(metaPath);
        } catch {}

        return true;
    }

    getDownloadStatus(imageId) {
        return this.downloads.get(imageId) || null;
    }
}

export default ImageManager;
