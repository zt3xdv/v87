import fs from "node:fs";
import path from "node:path";
import { Marshall, Unmarshall } from "../lib/marshall.js";

// 9P2000.L Error Codes
const EPERM = 1;
const ENOENT = 2;
const EIO = 5;
const EEXIST = 17;
const ENOTDIR = 20;
const EISDIR = 21;
const EINVAL = 22;

// QID Types
const QTDIR = 0x80;
const QTFILE = 0x00;
const QTSYMLINK = 0x02;

// File Types for mode
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

// Binary metadata format constants
const MAGIC = Buffer.from('V87M');
const VERSION = 1;
const FT_FILE = 0;
const FT_DIR = 1;
const FT_SYMLINK = 2;
const FT_CHARDEV = 3;
const FT_BLOCKDEV = 4;
const FT_FIFO = 5;
const FT_SOCKET = 6;

function readBinaryMetadata(filePath, decodeEntry) {
    const result = {};
    
    if (!fs.existsSync(filePath)) {
        return result;
    }
    
    try {
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
            
            result[pathStr] = decodeEntry(dataBuf);
        }
    } catch(e) {}
    
    return result;
}

// Fallback to read old JSON format
function readJsonFallback(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch(e) {}
    return {};
}

function writeBinaryMetadata(filePath, entries, encodeEntry) {
    const chunks = [MAGIC, Buffer.alloc(4)];
    const keys = Object.keys(entries);
    chunks[1].writeUInt16LE(VERSION, 0);
    chunks[1].writeUInt16LE(keys.length, 2);
    
    for (const key of keys) {
        const value = entries[key];
        const pathBuf = Buffer.from(key, 'utf8');
        const dataBuf = encodeEntry(value);
        
        const pathLenBuf = Buffer.alloc(2);
        pathLenBuf.writeUInt16LE(pathBuf.length, 0);
        
        const dataLenBuf = Buffer.alloc(2);
        dataLenBuf.writeUInt16LE(dataBuf.length, 0);
        
        chunks.push(pathLenBuf, pathBuf, dataLenBuf, dataBuf);
    }
    
    fs.writeFileSync(filePath, Buffer.concat(chunks));
}

export function create9pHandler(rootPath, serverDir) {
    const ROOT = rootPath;
    const SERVER_DIR = serverDir;
    const fids = new Map();
    
    // Metadata caches
    let permsCache = {};
    let symlinksCache = {};
    let devicesCache = {};
    let typesCache = {};
    let dirty = { perms: false, symlinks: false, types: false };

    function loadMetadata() {
        const binPerms = path.join(SERVER_DIR, 'permissions.bin');
        const binSymlinks = path.join(SERVER_DIR, 'symlinks.bin');
        const binDevices = path.join(SERVER_DIR, 'devices.bin');
        const binTypes = path.join(SERVER_DIR, 'types.bin');
        
        // Try binary format first, fallback to JSON
        if (fs.existsSync(binPerms)) {
            permsCache = readBinaryMetadata(binPerms, (buf) => ({
                mode: buf.readUInt16LE(0),
                uid: buf.readUInt32LE(2),
                gid: buf.readUInt32LE(6),
                mtime: buf.readUInt32LE(10)
            }));
        } else {
            // Fallback to old JSON format
            permsCache = readJsonFallback(path.join(SERVER_DIR, 'permissions.json'));
        }
        
        if (fs.existsSync(binSymlinks)) {
            symlinksCache = readBinaryMetadata(binSymlinks, (buf) => buf.toString('utf8'));
        } else {
            symlinksCache = readJsonFallback(path.join(SERVER_DIR, 'symlinks.json'));
        }
        
        if (fs.existsSync(binDevices)) {
            devicesCache = readBinaryMetadata(binDevices, (buf) => ({
                type: buf.readUInt8(0) === 0 ? 'char' : 'block',
                major: buf.readUInt16LE(1),
                minor: buf.readUInt16LE(3)
            }));
        } else {
            devicesCache = readJsonFallback(path.join(SERVER_DIR, 'devices.json'));
        }
        
        if (fs.existsSync(binTypes)) {
            typesCache = readBinaryMetadata(binTypes, (buf) => {
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
        } else {
            typesCache = readJsonFallback(path.join(SERVER_DIR, 'types.json'));
        }
    }

    function savePerms() {
        if (!dirty.perms) return;
        writeBinaryMetadata(
            path.join(SERVER_DIR, 'permissions.bin'),
            permsCache,
            (v) => {
                const buf = Buffer.alloc(14);
                buf.writeUInt16LE(v.mode || 0, 0);
                buf.writeUInt32LE(v.uid || 0, 2);
                buf.writeUInt32LE(v.gid || 0, 6);
                buf.writeUInt32LE(v.mtime || 0, 10);
                return buf;
            }
        );
        dirty.perms = false;
    }

    function saveSymlinks() {
        if (!dirty.symlinks) return;
        writeBinaryMetadata(
            path.join(SERVER_DIR, 'symlinks.bin'),
            symlinksCache,
            (target) => Buffer.from(target, 'utf8')
        );
        dirty.symlinks = false;
    }

    function saveTypes() {
        if (!dirty.types) return;
        const typeMap = {
            'file': FT_FILE,
            'dir': FT_DIR,
            'symlink': FT_SYMLINK,
            'chardev': FT_CHARDEV,
            'blockdev': FT_BLOCKDEV,
            'fifo': FT_FIFO,
            'socket': FT_SOCKET
        };
        writeBinaryMetadata(
            path.join(SERVER_DIR, 'types.bin'),
            typesCache,
            (v) => {
                const buf = Buffer.alloc(1);
                buf.writeUInt8(typeMap[v] || FT_FILE, 0);
                return buf;
            }
        );
        dirty.types = false;
    }

    function getRelPath(fullPath) {
        return path.relative(ROOT, fullPath) || '.';
    }

    function getPerm(fullPath) {
        const rel = getRelPath(fullPath);
        return permsCache[rel] || null;
    }

    function setPerm(fullPath, mode, uid = 0, gid = 0) {
        const rel = getRelPath(fullPath);
        permsCache[rel] = { mode: mode & 0o7777, uid, gid, mtime: Math.floor(Date.now() / 1000) };
        dirty.perms = true;
        savePerms();
    }

    function deleteMeta(fullPath) {
        const rel = getRelPath(fullPath);
        if (permsCache[rel]) {
            delete permsCache[rel];
            dirty.perms = true;
            savePerms();
        }
        if (symlinksCache[rel]) {
            delete symlinksCache[rel];
            dirty.symlinks = true;
            saveSymlinks();
        }
        if (typesCache[rel]) {
            delete typesCache[rel];
            dirty.types = true;
            saveTypes();
        }
    }

    function renameMeta(oldPath, newPath) {
        const oldRel = getRelPath(oldPath);
        const newRel = getRelPath(newPath);
        
        if (permsCache[oldRel]) {
            permsCache[newRel] = permsCache[oldRel];
            delete permsCache[oldRel];
            dirty.perms = true;
            savePerms();
        }
        if (symlinksCache[oldRel]) {
            symlinksCache[newRel] = symlinksCache[oldRel];
            delete symlinksCache[oldRel];
            dirty.symlinks = true;
            saveSymlinks();
        }
        if (typesCache[oldRel]) {
            typesCache[newRel] = typesCache[oldRel];
            delete typesCache[oldRel];
            dirty.types = true;
            saveTypes();
        }
    }

    function getSymlinkTarget(fullPath) {
        const rel = getRelPath(fullPath);
        // Check cache first
        if (symlinksCache[rel]) {
            return symlinksCache[rel];
        }
        // Try reading actual symlink from filesystem
        try {
            const target = fs.readlinkSync(fullPath);
            return target;
        } catch(e) {
            return null;
        }
    }

    function setSymlink(fullPath, target) {
        const rel = getRelPath(fullPath);
        symlinksCache[rel] = target;
        typesCache[rel] = 'symlink';
        dirty.symlinks = true;
        dirty.types = true;
        saveSymlinks();
        saveTypes();
    }

    function getFileType(fullPath) {
        const rel = getRelPath(fullPath);
        return typesCache[rel] || null;
    }

    function setFileType(fullPath, type) {
        const rel = getRelPath(fullPath);
        typesCache[rel] = type;
        dirty.types = true;
        saveTypes();
    }

    function getDevice(fullPath) {
        const rel = getRelPath(fullPath);
        return devicesCache[rel] || null;
    }

    function isSymlink(fullPath) {
        // Check cache first
        if (getFileType(fullPath) === 'symlink') {
            return true;
        }
        // Check actual filesystem
        try {
            const stats = fs.lstatSync(fullPath);
            return stats.isSymbolicLink();
        } catch(e) {
            return false;
        }
    }

    loadMetadata();

    function statToQid(stats, fullPath) {
        let type = QTFILE;
        if (stats.isDirectory()) type = QTDIR;
        else if (stats.isSymbolicLink()) type = QTSYMLINK;
        else if (isSymlink(fullPath)) type = QTSYMLINK;
        
        return {
            type,
            version: Math.floor(stats.mtimeMs) & 0xFFFFFFFF,
            path: Number(stats.ino)
        };
    }

    function getMode(stats, fullPath) {
        const perm = getPerm(fullPath);
        let mode = perm ? perm.mode : (stats.mode & 0o777);
        
        // Check actual stat first
        if (stats.isSymbolicLink()) mode |= S_IFLNK;
        else if (stats.isDirectory()) mode |= S_IFDIR;
        else {
            const fileType = getFileType(fullPath);
            if (fileType === 'symlink') mode |= S_IFLNK;
            else if (fileType === 'chardev') mode |= S_IFCHR;
            else if (fileType === 'blockdev') mode |= S_IFBLK;
            else if (fileType === 'fifo') mode |= S_IFIFO;
            else if (fileType === 'socket') mode |= S_IFSOCK;
            else mode |= S_IFREG;
        }
        
        return mode;
    }

    function getUidGid(fullPath) {
        const perm = getPerm(fullPath);
        return perm ? { uid: perm.uid || 0, gid: perm.gid || 0 } : { uid: 0, gid: 0 };
    }

    return function handle9p(reqBuf, reply) {
        const replyBuf = new Uint8Array(1024 * 1024);
        const state = { offset: 0 };

        function sendReply(id, tag, types, values) {
            let size = 7;
            if (types) {
                size += Marshall(types, values, replyBuf, 7);
            }
            Marshall(["w", "b", "h"], [size, id, tag], replyBuf, 0);
            reply(replyBuf.subarray(0, size));
        }

        function sendError(tag, msg, errno) {
            Marshall(["w", "b", "h", "w"], [7 + 4, 6 + 1, tag, errno], replyBuf, 0);
            reply(replyBuf.subarray(0, 7 + 4));
        }

        try {
            const header = Unmarshall(["w", "b", "h"], reqBuf, state);
            const size = header[0];
            const id = header[1];
            const tag = header[2];

            switch (id) {
                case 100: // Tversion
                    const [msize, version] = Unmarshall(["w", "s"], reqBuf, state);
                    sendReply(101, tag, ["w", "s"], [msize, "9P2000.L"]);
                    break;

                case 104: // Tattach
                    const [fid, afid, uname, aname] = Unmarshall(["w", "w", "s", "s"], reqBuf, state);
                    let n_uname = 0;
                    if (state.offset < size) {
                        [n_uname] = Unmarshall(["w"], reqBuf, state);
                    }
                    if (!fs.existsSync(ROOT)) {
                        fs.mkdirSync(ROOT, { recursive: true });
                    }
                    const stats = fs.statSync(ROOT);
                    fids.set(fid, { path: ROOT, type: QTDIR, uid: n_uname });
                    sendReply(105, tag, ["Q"], [statToQid(stats, ROOT)]);
                    break;

                case 108: // Tflush
                    sendReply(109, tag);
                    break;

                case 110: // Twalk
                    const [wfid, wnewfid, wnwname] = Unmarshall(["w", "w", "h"], reqBuf, state);
                    const wnames = Unmarshall(Array(wnwname).fill("s"), reqBuf, state);
                    
                    const fidObj = fids.get(wfid);
                    if (!fidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }

                    const rootResolved = path.resolve(ROOT);
                    let currentPath = fidObj.path;
                    const qids = [];
                    let walkSuccess = true;

                    for (const name of wnames) {
                        const nextPath = path.resolve(currentPath, name);
                        
                        if (nextPath !== rootResolved && !nextPath.startsWith(rootResolved + path.sep)) {
                            if (name === ".." && currentPath === rootResolved) {
                                continue;
                            }
                            walkSuccess = false;
                            break;
                        }
                        if (!fs.existsSync(nextPath)) {
                            walkSuccess = false;
                            break;
                        }
                        const st = fs.lstatSync(nextPath);
                        qids.push(statToQid(st, nextPath));
                        currentPath = nextPath;
                    }

                    if (walkSuccess) {
                        fids.set(wnewfid, { path: currentPath, type: qids.length > 0 ? qids[qids.length - 1].type : fidObj.type });
                        sendReply(111, tag, ["h", ...Array(qids.length).fill("Q")], [qids.length, ...qids]);
                    } else {
                        if (qids.length === 0 && wnames.length > 0) {
                            sendError(tag, "Not found", ENOENT);
                        } else {
                            if (qids.length === wnames.length) {
                                fids.set(wnewfid, { path: currentPath, type: qids.length > 0 ? qids[qids.length - 1].type : fidObj.type });
                            }
                            sendReply(111, tag, ["h", ...Array(qids.length).fill("Q")], [qids.length, ...qids]);
                        }
                    }
                    break;

                case 24: // Tgetattr
                    const [gfid, request_mask] = Unmarshall(["w", "d"], reqBuf, state);
                    const gFidObj = fids.get(gfid);
                    if (!gFidObj || !fs.existsSync(gFidObj.path)) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    const gst = fs.lstatSync(gFidObj.path);
                    const qid = statToQid(gst, gFidObj.path);
                    const mode = getMode(gst, gFidObj.path);
                    const { uid: gUid, gid: gGid } = getUidGid(gFidObj.path);
                    
                    sendReply(25, tag, 
                        ["d", "Q", "w", "w", "w", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d"],
                        [
                            0x1FFF,
                            qid,
                            mode,
                            gUid,
                            gGid,
                            1,
                            0,
                            Number(gst.size),
                            4096,
                            Math.ceil(gst.size / 512),
                            Math.floor(gst.atimeMs / 1000), (gst.atimeMs % 1000) * 1000000,
                            Math.floor(gst.mtimeMs / 1000), (gst.mtimeMs % 1000) * 1000000,
                            Math.floor(gst.ctimeMs / 1000), (gst.ctimeMs % 1000) * 1000000,
                            0, 0,
                            0,
                            0
                        ]
                    );
                    break;
                
                case 26: // Tsetattr
                    const [safid, savalid, samode, sauid, sagid, sasize] = Unmarshall(["w", "w", "w", "w", "w", "d"], reqBuf, state);
                    const saFidObj = fids.get(safid);
                    if (!saFidObj || !fs.existsSync(saFidObj.path)) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    try {
                        const currentPerm = getPerm(saFidObj.path) || { mode: 0o755, uid: 0, gid: 0 };
                        let newMode = currentPerm.mode;
                        let newUid = currentPerm.uid;
                        let newGid = currentPerm.gid;
                        
                        if (savalid & 1) newMode = samode & 0o7777;
                        if (savalid & 2) newUid = sauid;
                        if (savalid & 4) newGid = sagid;
                        if (savalid & 8) {
                            fs.truncateSync(saFidObj.path, Number(sasize));
                        }
                        
                        setPerm(saFidObj.path, newMode, newUid, newGid);
                        sendReply(27, tag);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 22: // Treadlink
                    const [rlfid] = Unmarshall(["w"], reqBuf, state);
                    const rlFidObj = fids.get(rlfid);
                    if (!rlFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    
                    const linkTarget = getSymlinkTarget(rlFidObj.path);
                    if (linkTarget) {
                        sendReply(23, tag, ["s"], [linkTarget]);
                    } else {
                        try {
                            const target = fs.readlinkSync(rlFidObj.path);
                            sendReply(23, tag, ["s"], [target]);
                        } catch(e) {
                            sendError(tag, "Not a symlink", EINVAL);
                        }
                    }
                    break;

                case 112: // Topen (9P2000)
                case 12: // Tlopen (9P2000.L)
                    const [ofid, oflags] = Unmarshall(["w", "w"], reqBuf, state);
                    const oFidObj = fids.get(ofid);
                    if (!oFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }

                    try {
                        const st = fs.lstatSync(oFidObj.path);
                        if (st.isDirectory()) {
                            oFidObj.dirEntries = fs.readdirSync(oFidObj.path);
                            oFidObj.dirIndex = 0;
                        } else if (isSymlink(oFidObj.path)) {
                            const qid2 = statToQid(st, oFidObj.path);
                            sendReply(13, tag, ["Q", "w"], [qid2, 8192]);
                            break;
                        } else {
                            const O_TRUNC = 0x200, O_APPEND = 0x400;
                            let nodeFlags = oflags & 3;
                            if (oflags & O_TRUNC) nodeFlags |= fs.constants.O_TRUNC;
                            if (oflags & O_APPEND) nodeFlags |= fs.constants.O_APPEND;
                            const fd = fs.openSync(oFidObj.path, nodeFlags);
                            oFidObj.fd = fd;
                        }
                        const qid2 = statToQid(st, oFidObj.path);
                        sendReply(13, tag, ["Q", "w"], [qid2, 8192]);
                    } catch (e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 40: // Treaddir
                    const [dirfid, diroffset, dircount] = Unmarshall(["w", "d", "w"], reqBuf, state);
                    const dirFidObj = fids.get(dirfid);
                    if (!dirFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    if (!dirFidObj.dirEntries) {
                        sendError(tag, "Not a directory", ENOTDIR);
                        break;
                    }

                    if (Number(diroffset) === 0) {
                        dirFidObj.dirIndex = 0;
                    } else {
                        dirFidObj.dirIndex = Number(diroffset);
                    }
                    
                    let dirDataSize = 0;
                    const dirEntriesList = [];
                    
                    while (dirFidObj.dirIndex < dirFidObj.dirEntries.length) {
                        const name = dirFidObj.dirEntries[dirFidObj.dirIndex];
                        const childPath = path.join(dirFidObj.path, name);
                        let st;
                        try {
                            st = fs.lstatSync(childPath);
                        } catch(e) {
                            dirFidObj.dirIndex++;
                            continue;
                        }
                        
                        const qid = statToQid(st, childPath);
                        let type = 8;
                        if (qid.type === QTDIR) type = 4;
                        else if (isSymlink(childPath)) type = 10;
                        
                        const nameLen = Buffer.byteLength(name);
                        const entrySize = 13 + 8 + 1 + 2 + nameLen;
                        
                        if (dirDataSize + entrySize > dircount) break;
                        
                        const nextOffset = dirFidObj.dirIndex + 1; 
                        
                        dirEntriesList.push({ qid, offset: nextOffset, type, name });
                        dirDataSize += entrySize;
                        dirFidObj.dirIndex++;
                    }

                    const dirDataBuf = new Uint8Array(dirDataSize);
                    let ptr = 0;
                    for (const ent of dirEntriesList) {
                        ptr += Marshall(["Q", "d", "b", "s"], [ent.qid, ent.offset, ent.type, ent.name], dirDataBuf, ptr);
                    }
                    
                    sendReply(41, tag, ["w", "B"], [dirDataSize, dirDataBuf]);
                    break;

                case 116: // Tread
                    const [rfid, roffset, rcount] = Unmarshall(["w", "d", "w"], reqBuf, state);
                    const rFidObj = fids.get(rfid);
                    if (!rFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }

                    if (isSymlink(rFidObj.path)) {
                        const target = getSymlinkTarget(rFidObj.path) || '';
                        const targetBuf = Buffer.from(target, 'utf8');
                        const start = Number(roffset);
                        const end = Math.min(start + rcount, targetBuf.length);
                        const slice = targetBuf.subarray(start, end);
                        sendReply(117, tag, ["w", "B"], [slice.length, slice]);
                        break;
                    }

                    if (rFidObj.fd !== undefined) {
                        const buf = new Uint8Array(rcount);
                        const bytesRead = fs.readSync(rFidObj.fd, buf, 0, rcount, Number(roffset));
                        sendReply(117, tag, ["w", "B"], [bytesRead, buf.subarray(0, bytesRead)]);
                    } else {
                        sendError(tag, "Is a directory", EISDIR);
                    }
                    break;

                case 118: // Twrite
                    const [wfid2, woffset, wcount] = Unmarshall(["w", "d", "w"], reqBuf, state);
                    const wFidObj = fids.get(wfid2);
                    if (!wFidObj || wFidObj.fd === undefined) {
                        sendError(tag, "fid not found or not open", EIO);
                        break;
                    }
                    
                    const data = reqBuf.subarray(state.offset, state.offset + wcount);
                    const bytesWritten = fs.writeSync(wFidObj.fd, data, 0, wcount, Number(woffset));
                    
                    sendReply(119, tag, ["w"], [bytesWritten]);
                    break;

                case 120: // Tclunk
                    const [cfid] = Unmarshall(["w"], reqBuf, state);
                    const cFidObj = fids.get(cfid);
                    if (cFidObj) {
                        if (cFidObj.fd !== undefined) {
                            fs.closeSync(cFidObj.fd);
                        }
                        fids.delete(cfid);
                    }
                    sendReply(121, tag);
                    break;
                
                case 14: // Tlcreate
                    const [crfid, crname, crflags, crmode, crgid] = Unmarshall(["w", "s", "w", "w", "w"], reqBuf, state);
                    const crFidObj = fids.get(crfid);
                    if (!crFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    const newPath = path.join(crFidObj.path, crname);
                    try {
                        let nodeFlags = 'w+';
                        const O_RDONLY = 0, O_WRONLY = 1, O_RDWR = 2;
                        const accessMode = crflags & 3;
                        if (accessMode === O_RDONLY) nodeFlags = 'r+';
                        else if (accessMode === O_WRONLY) nodeFlags = 'w';
                        else nodeFlags = 'w+';
                        
                        const fd = fs.openSync(newPath, nodeFlags, crmode & 0o777);
                        setPerm(newPath, crmode & 0o7777, 0, crgid);
                        setFileType(newPath, 'file');
                        fids.set(crfid, { path: newPath, fd: fd, type: QTFILE });
                        const st = fs.statSync(newPath);
                        const qid = statToQid(st, newPath);
                        sendReply(15, tag, ["Q", "w"], [qid, 8192]);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 16: // Tsymlink
                    const [slfid, slname, sltarget, slgid] = Unmarshall(["w", "s", "s", "w"], reqBuf, state);
                    const slFidObj = fids.get(slfid);
                    if (!slFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    const symlinkPath = path.join(slFidObj.path, slname);
                    try {
                        fs.writeFileSync(symlinkPath, '');
                        setSymlink(symlinkPath, sltarget);
                        setPerm(symlinkPath, 0o777, 0, slgid);
                        
                        const st = fs.statSync(symlinkPath);
                        const qid = { type: QTSYMLINK, version: 0, path: Number(st.ino) };
                        sendReply(17, tag, ["Q"], [qid]);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 72: // Tmkdir
                    const [mkfid, mkname, mkmode, mkgid] = Unmarshall(["w", "s", "w", "w"], reqBuf, state);
                    const mkFidObj = fids.get(mkfid);
                    if (!mkFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    const newDirPath = path.join(mkFidObj.path, mkname);
                    try {
                        fs.mkdirSync(newDirPath);
                        setPerm(newDirPath, mkmode & 0o7777, 0, mkgid);
                        setFileType(newDirPath, 'dir');
                        const st = fs.statSync(newDirPath);
                        const qid = statToQid(st, newDirPath);
                        sendReply(73, tag, ["Q"], [qid]);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 30: // Tremove
                    const [rmfid] = Unmarshall(["w"], reqBuf, state);
                    const rmFidObj = fids.get(rmfid);
                    if (!rmFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    try {
                        const st = fs.statSync(rmFidObj.path);
                        if (st.isDirectory()) {
                            fs.rmdirSync(rmFidObj.path);
                        } else {
                            fs.unlinkSync(rmFidObj.path);
                        }
                        deleteMeta(rmFidObj.path);
                        fids.delete(rmfid);
                        sendReply(31, tag);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 74: // Trenameat
                    const [rnoldfid, rnoldname, rnnewfid, rnnewname] = Unmarshall(["w", "s", "w", "s"], reqBuf, state);
                    const rnOldFidObj = fids.get(rnoldfid);
                    const rnNewFidObj = fids.get(rnnewfid);
                    if (!rnOldFidObj || !rnNewFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    try {
                        const oldPath = path.join(rnOldFidObj.path, rnoldname);
                        const newPath = path.join(rnNewFidObj.path, rnnewname);
                        fs.renameSync(oldPath, newPath);
                        renameMeta(oldPath, newPath);
                        sendReply(75, tag);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                case 76: // Tunlinkat
                    const [uafid, uaname, uaflags] = Unmarshall(["w", "s", "w"], reqBuf, state);
                    const uaFidObj = fids.get(uafid);
                    if (!uaFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }
                    try {
                        const targetPath = path.join(uaFidObj.path, uaname);
                        const st = fs.statSync(targetPath);
                        if (st.isDirectory()) {
                            fs.rmdirSync(targetPath);
                        } else {
                            fs.unlinkSync(targetPath);
                        }
                        deleteMeta(targetPath);
                        sendReply(77, tag);
                    } catch(e) {
                        sendError(tag, e.message, EIO);
                    }
                    break;

                default:
                    sendError(tag, "Not implemented", EINVAL);
                    break;
            }

        } catch (e) {
            console.error("9p Handler Error:", e);
        }
    };
}
