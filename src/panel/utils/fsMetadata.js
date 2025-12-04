import fs from 'fs-extra';
import path from 'node:path';

/*
 * Binary Metadata Format
 * 
 * Header (8 bytes):
 *   - Magic: "V87M" (4 bytes)
 *   - Version: uint16 (2 bytes)
 *   - Entry count: uint16 (2 bytes)
 * 
 * Each entry:
 *   - Path length: uint16 (2 bytes)
 *   - Path: utf8 string (variable)
 *   - Data length: uint16 (2 bytes)  
 *   - Data: binary (variable)
 */

const MAGIC = Buffer.from('V87M');
const VERSION = 1;

// File type constants
export const FT_FILE = 0;
export const FT_DIR = 1;
export const FT_SYMLINK = 2;
export const FT_CHARDEV = 3;
export const FT_BLOCKDEV = 4;
export const FT_FIFO = 5;
export const FT_SOCKET = 6;

function encodePermsEntry(mode, uid, gid, mtime) {
    const buf = Buffer.alloc(14);
    buf.writeUInt16LE(mode, 0);
    buf.writeUInt32LE(uid, 2);
    buf.writeUInt32LE(gid, 6);
    buf.writeUInt32LE(mtime, 10);
    return buf;
}

function decodePermsEntry(buf) {
    return {
        mode: buf.readUInt16LE(0),
        uid: buf.readUInt32LE(2),
        gid: buf.readUInt32LE(6),
        mtime: buf.readUInt32LE(10)
    };
}

function encodeDeviceEntry(type, major, minor) {
    const buf = Buffer.alloc(5);
    buf.writeUInt8(type === 'char' ? 0 : 1, 0);
    buf.writeUInt16LE(major, 1);
    buf.writeUInt16LE(minor, 3);
    return buf;
}

function decodeDeviceEntry(buf) {
    return {
        type: buf.readUInt8(0) === 0 ? 'char' : 'block',
        major: buf.readUInt16LE(1),
        minor: buf.readUInt16LE(3)
    };
}

function writeMetadataFile(filePath, entries, encodeData) {
    const chunks = [MAGIC, Buffer.alloc(4)];
    chunks[1].writeUInt16LE(VERSION, 0);
    chunks[1].writeUInt16LE(Object.keys(entries).length, 2);
    
    for (const [key, value] of Object.entries(entries)) {
        const pathBuf = Buffer.from(key, 'utf8');
        const dataBuf = encodeData(value);
        
        const pathLenBuf = Buffer.alloc(2);
        pathLenBuf.writeUInt16LE(pathBuf.length, 0);
        
        const dataLenBuf = Buffer.alloc(2);
        dataLenBuf.writeUInt16LE(dataBuf.length, 0);
        
        chunks.push(pathLenBuf, pathBuf, dataLenBuf, dataBuf);
    }
    
    return fs.writeFile(filePath, Buffer.concat(chunks));
}

function readMetadataFile(filePath, decodeData) {
    const result = {};
    
    if (!fs.existsSync(filePath)) {
        return result;
    }
    
    const buf = fs.readFileSync(filePath);
    
    if (buf.length < 8) return result;
    if (!buf.subarray(0, 4).equals(MAGIC)) return result;
    
    const version = buf.readUInt16LE(4);
    if (version !== VERSION) return result;
    
    const count = buf.readUInt16LE(6);
    let offset = 8;
    
    for (let i = 0; i < count && offset < buf.length; i++) {
        if (offset + 2 > buf.length) break;
        const pathLen = buf.readUInt16LE(offset);
        offset += 2;
        
        if (offset + pathLen > buf.length) break;
        const pathStr = buf.subarray(offset, offset + pathLen).toString('utf8');
        offset += pathLen;
        
        if (offset + 2 > buf.length) break;
        const dataLen = buf.readUInt16LE(offset);
        offset += 2;
        
        if (offset + dataLen > buf.length) break;
        const dataBuf = buf.subarray(offset, offset + dataLen);
        offset += dataLen;
        
        result[pathStr] = decodeData(dataBuf);
    }
    
    return result;
}

// Permissions: mode, uid, gid, mtime
export function writePerms(filePath, perms) {
    return writeMetadataFile(filePath, perms, (v) => 
        encodePermsEntry(v.mode || 0, v.uid || 0, v.gid || 0, v.mtime || 0)
    );
}

export function readPerms(filePath) {
    return readMetadataFile(filePath, decodePermsEntry);
}

// Symlinks: path -> target
export function writeSymlinks(filePath, symlinks) {
    return writeMetadataFile(filePath, symlinks, (target) => 
        Buffer.from(target, 'utf8')
    );
}

export function readSymlinks(filePath) {
    return readMetadataFile(filePath, (buf) => buf.toString('utf8'));
}

// Devices: path -> { type, major, minor }
export function writeDevices(filePath, devices) {
    return writeMetadataFile(filePath, devices, (v) =>
        encodeDeviceEntry(v.type, v.major || 0, v.minor || 0)
    );
}

export function readDevices(filePath) {
    return readMetadataFile(filePath, decodeDeviceEntry);
}

// Special files: path -> { type }
export function writeSpecial(filePath, special) {
    return writeMetadataFile(filePath, special, (v) => {
        const typeMap = { fifo: FT_FIFO, socket: FT_SOCKET };
        const buf = Buffer.alloc(1);
        buf.writeUInt8(typeMap[v.type] || 0, 0);
        return buf;
    });
}

export function readSpecial(filePath) {
    return readMetadataFile(filePath, (buf) => {
        const typeMap = { [FT_FIFO]: 'fifo', [FT_SOCKET]: 'socket' };
        return { type: typeMap[buf.readUInt8(0)] || 'unknown' };
    });
}

// Types: path -> type (single byte)
export function writeTypes(filePath, types) {
    return writeMetadataFile(filePath, types, (v) => {
        const typeMap = {
            'file': FT_FILE,
            'dir': FT_DIR,
            'symlink': FT_SYMLINK,
            'chardev': FT_CHARDEV,
            'blockdev': FT_BLOCKDEV,
            'fifo': FT_FIFO,
            'socket': FT_SOCKET
        };
        const buf = Buffer.alloc(1);
        buf.writeUInt8(typeMap[v] || FT_FILE, 0);
        return buf;
    });
}

export function readTypes(filePath) {
    return readMetadataFile(filePath, (buf) => {
        const typeMap = {
            [FT_FILE]: 'file',
            [FT_DIR]: 'dir',
            [FT_SYMLINK]: 'symlink',
            [FT_CHARDEV]: 'chardev',
            [FT_BLOCKDEV]: 'blockdev',
            [FT_FIFO]: 'fifo',
            [FT_SOCKET]: 'socket'
        };
        return typeMap[buf.readUInt8(0)] || 'file';
    });
}

// Metadata class for runtime use with dirty tracking
export class MetadataStore {
    constructor(serverDir) {
        this.serverDir = serverDir;
        this.perms = {};
        this.symlinks = {};
        this.devices = {};
        this.special = {};
        this.types = {};
        this.dirty = { perms: false, symlinks: false, types: false };
    }
    
    getPath(name) {
        return path.join(this.serverDir, name);
    }
    
    load() {
        this.perms = readPerms(this.getPath('permissions.bin'));
        this.symlinks = readSymlinks(this.getPath('symlinks.bin'));
        this.devices = readDevices(this.getPath('devices.bin'));
        this.special = readSpecial(this.getPath('special.bin'));
        this.types = readTypes(this.getPath('types.bin'));
    }
    
    async save() {
        const promises = [];
        if (this.dirty.perms) {
            promises.push(writePerms(this.getPath('permissions.bin'), this.perms));
            this.dirty.perms = false;
        }
        if (this.dirty.symlinks) {
            promises.push(writeSymlinks(this.getPath('symlinks.bin'), this.symlinks));
            this.dirty.symlinks = false;
        }
        if (this.dirty.types) {
            promises.push(writeTypes(this.getPath('types.bin'), this.types));
            this.dirty.types = false;
        }
        await Promise.all(promises);
    }
    
    saveSync() {
        if (this.dirty.perms) {
            writePerms(this.getPath('permissions.bin'), this.perms);
            this.dirty.perms = false;
        }
        if (this.dirty.symlinks) {
            writeSymlinks(this.getPath('symlinks.bin'), this.symlinks);
            this.dirty.symlinks = false;
        }
        if (this.dirty.types) {
            writeTypes(this.getPath('types.bin'), this.types);
            this.dirty.types = false;
        }
    }
    
    getPerm(relPath) {
        return this.perms[relPath] || null;
    }
    
    setPerm(relPath, mode, uid = 0, gid = 0) {
        this.perms[relPath] = { mode: mode & 0o7777, uid, gid, mtime: Math.floor(Date.now() / 1000) };
        this.dirty.perms = true;
    }
    
    getSymlink(relPath) {
        return this.symlinks[relPath] || null;
    }
    
    setSymlink(relPath, target) {
        this.symlinks[relPath] = target;
        this.types[relPath] = 'symlink';
        this.dirty.symlinks = true;
        this.dirty.types = true;
    }
    
    getType(relPath) {
        return this.types[relPath] || null;
    }
    
    setType(relPath, type) {
        this.types[relPath] = type;
        this.dirty.types = true;
    }
    
    getDevice(relPath) {
        return this.devices[relPath] || null;
    }
    
    delete(relPath) {
        if (this.perms[relPath]) {
            delete this.perms[relPath];
            this.dirty.perms = true;
        }
        if (this.symlinks[relPath]) {
            delete this.symlinks[relPath];
            this.dirty.symlinks = true;
        }
        if (this.types[relPath]) {
            delete this.types[relPath];
            this.dirty.types = true;
        }
    }
    
    rename(oldPath, newPath) {
        if (this.perms[oldPath]) {
            this.perms[newPath] = this.perms[oldPath];
            delete this.perms[oldPath];
            this.dirty.perms = true;
        }
        if (this.symlinks[oldPath]) {
            this.symlinks[newPath] = this.symlinks[oldPath];
            delete this.symlinks[oldPath];
            this.dirty.symlinks = true;
        }
        if (this.types[oldPath]) {
            this.types[newPath] = this.types[oldPath];
            delete this.types[oldPath];
            this.dirty.types = true;
        }
    }
}
