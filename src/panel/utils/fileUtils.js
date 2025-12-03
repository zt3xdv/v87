import fs from 'fs-extra';
import path from 'node:path';

async function getDirSize(dir) {
    if (!fs.existsSync(dir)) return 0;
    const files = await fs.readdir(dir);
    const stats = await Promise.all(
        files.map(async file => {
            const filePath = path.join(dir, file);
            try {
                const stat = await fs.lstat(filePath);
                if (stat.isSymbolicLink()) return 0;
                if (stat.isDirectory()) return getDirSize(filePath);
                return stat.size;
            } catch (e) {
                return 0;
            }
        })
    );
    return stats.reduce((acc, size) => acc + size, 0);
}

export { getDirSize };
