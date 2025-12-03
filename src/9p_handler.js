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

// File Types for mode
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xA000;

export function create9pHandler(rootPath, permsPath) {
    const ROOT = rootPath;
    const PERMS_FILE = permsPath;
    const fids = new Map();
    let permsCache = {};
    let permsDirty = false;

    function loadPerms() {
        try {
            if (fs.existsSync(PERMS_FILE)) {
                permsCache = JSON.parse(fs.readFileSync(PERMS_FILE, 'utf8'));
            }
        } catch(e) {
            permsCache = {};
        }
    }

    function savePerms() {
        if (!permsDirty) return;
        try {
            fs.writeFileSync(PERMS_FILE, JSON.stringify(permsCache));
            permsDirty = false;
        } catch(e) {}
    }

    function getRelPath(fullPath) {
        return path.relative(ROOT, fullPath) || '.';
    }

    function getPerm(fullPath) {
        const rel = getRelPath(fullPath);
        if (permsCache[rel]) {
            return permsCache[rel];
        }
        return null;
    }

    function setPerm(fullPath, mode, uid = 0, gid = 0) {
        const rel = getRelPath(fullPath);
        permsCache[rel] = { mode: mode & 0o7777, uid, gid };
        permsDirty = true;
        savePerms();
    }

    function deletePerm(fullPath) {
        const rel = getRelPath(fullPath);
        if (permsCache[rel]) {
            delete permsCache[rel];
            permsDirty = true;
            savePerms();
        }
    }

    function renamePerm(oldPath, newPath) {
        const oldRel = getRelPath(oldPath);
        const newRel = getRelPath(newPath);
        if (permsCache[oldRel]) {
            permsCache[newRel] = permsCache[oldRel];
            delete permsCache[oldRel];
            permsDirty = true;
            savePerms();
        }
    }

    loadPerms();

    function statToQid(stats) {
        return {
            type: stats.isDirectory() ? QTDIR : QTFILE,
            version: Math.floor(stats.mtimeMs) & 0xFFFFFFFF,
            path: Number(stats.ino)
        };
    }

    function getMode(stats, fullPath) {
        const perm = getPerm(fullPath);
        let mode = perm ? perm.mode : (stats.mode & 0o777);
        if (stats.isDirectory()) mode |= S_IFDIR;
        else if (stats.isSymbolicLink()) mode |= S_IFLNK;
        else mode |= S_IFREG;
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
                    if (!fs.existsSync(ROOT)) {
                        fs.mkdirSync(ROOT, { recursive: true });
                    }
                    const stats = fs.statSync(ROOT);
                    fids.set(fid, { path: ROOT, type: QTDIR });
                    sendReply(105, tag, ["Q"], [statToQid(stats)]);
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

                    let currentPath = fidObj.path;
                    const qids = [];
                    let walkSuccess = true;

                    for (const name of wnames) {
                        const nextPath = path.join(currentPath, name);
                        if (!nextPath.startsWith(ROOT)) {
                            walkSuccess = false;
                            break;
                        }
                        if (!fs.existsSync(nextPath)) {
                            walkSuccess = false;
                            break;
                        }
                        const st = fs.statSync(nextPath);
                        qids.push(statToQid(st));
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
                    const gst = fs.statSync(gFidObj.path);
                    const qid = statToQid(gst);
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

                case 112: // Tlopen (9P2000.L)
                case 12:
                    const [ofid, flags] = Unmarshall(["w", "w"], reqBuf, state);
                    const oFidObj = fids.get(ofid);
                    if (!oFidObj) {
                        sendError(tag, "fid not found", ENOENT);
                        break;
                    }

                    try {
                        const st = fs.statSync(oFidObj.path);
                        if (st.isDirectory()) {
                            oFidObj.dirEntries = fs.readdirSync(oFidObj.path);
                            oFidObj.dirIndex = 0;
                        } else {
                            const fd = fs.openSync(oFidObj.path, flags & 3);
                            oFidObj.fd = fd;
                        }
                        const qid2 = statToQid(st);
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
                            st = fs.statSync(childPath);
                        } catch(e) {
                            dirFidObj.dirIndex++;
                            continue;
                        }
                        
                        const qid = statToQid(st);
                        const type = (qid.type === QTDIR) ? 4 : 8;
                        
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
                        const fd = fs.openSync(newPath, "w+");
                        fids.set(crfid, { path: newPath, fd: fd, type: QTFILE });
                        const st = fs.statSync(newPath);
                        const qid = statToQid(st);
                        sendReply(15, tag, ["Q", "w"], [qid, 8192]);
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
                        const st = fs.statSync(newDirPath);
                        const qid = statToQid(st);
                        sendReply(73, tag, ["Q"], [qid]);
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
