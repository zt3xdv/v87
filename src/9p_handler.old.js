import fs from "node:fs";
import path from "node:path";
import { Marshall, Unmarshall } from "../lib/marshall.js";

const ROOT = path.resolve("./root");

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

const fids = new Map(); // fid -> { path, fd, type, dirEntries, dirIndex }

function statToQid(stats) {
return {
type: stats.isDirectory() ? QTDIR : QTFILE,
version: Math.floor(stats.mtimeMs) & 0xFFFFFFFF, // Truncate to 32-bit
path: Number(stats.ino)
};
}

function getMode(stats) {
let mode = stats.mode & 0o777;
if (stats.isDirectory()) mode |= S_IFDIR;
else mode |= S_IFREG;
return mode;
}

export function handle9p(reqBuf, reply) {
const replyBuf = new Uint8Array(1024 * 1024); // 1MB buffer
const state = { offset: 0 };

// Helper to send replies
function sendReply(id, tag, types, values) {
    let size = 7; // size(4) + id(1) + tag(2)
    if (types) {
        size += Marshall(types, values, replyBuf, 7);
    }
    Marshall(["w", "b", "h"], [size, id, tag], replyBuf, 0);
    reply(replyBuf.subarray(0, size));
}

function sendError(tag, msg, errno) {
    // Rlerror: size[4] id[1] tag[2] errno[4]
    Marshall(["w", "b", "h", "w"], [7 + 4, 6 + 1, tag, errno], replyBuf, 0);
    reply(replyBuf.subarray(0, 7 + 4));
}

try {
    const header = Unmarshall(["w", "b", "h"], reqBuf, state);
    const size = header[0];
    const id = header[1];
    const tag = header[2];

    // console.log(`9P: op=${id} tag=${tag}`);

    switch (id) {
        case 100: // Tversion
            const [msize, version] = Unmarshall(["w", "s"], reqBuf, state);
            // Negotiate version. We support 9P2000.L
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
                // Prevent escaping ROOT
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
                // If we processed some but not all, sending what we got is valid in 9p?
                // Usually we error if 0 walked and error, or return partial.
                // For now, if 0 walked, return error (implied by library usually), or just empty?
                // The spec says: if nwqid < nwname, the walk was aborted.
                if (qids.length === 0 && wnames.length > 0) {
                    sendError(tag, "Not found", ENOENT);
                } else {
                    // Partial walk or 0-length walk (clone)
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
            const mode = getMode(gst);
            
            // Rgetattr: valid, qid, mode, uid, gid, nlink, rdev, size, blksize, blocks, atime, mtime, ctime, btime, gen, data_version
            sendReply(25, tag, 
                ["d", "Q", "w", "w", "w", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d", "d"],
                [
                    0x1FFF, // valid
                    qid,
                    mode,
                    0, // uid
                    0, // gid
                    1, // nlink
                    0, // rdev
                    Number(gst.size),
                    4096, // blksize
                    Math.ceil(gst.size / 512), // blocks
                    Math.floor(gst.atimeMs / 1000), (gst.atimeMs % 1000) * 1000000,
                    Math.floor(gst.mtimeMs / 1000), (gst.mtimeMs % 1000) * 1000000,
                    Math.floor(gst.ctimeMs / 1000), (gst.ctimeMs % 1000) * 1000000,
                    0, 0, // btime
                    0, // gen
                    0 // data_version
                ]
            );
            break;

        case 112: // Tlopen (9P2000.L)
        case 12:  // Tlopen (legacy/mistake?) - lib/9p handles both
            const [ofid, flags] = Unmarshall(["w", "w"], reqBuf, state);
            const oFidObj = fids.get(ofid);
            if (!oFidObj) {
                sendError(tag, "fid not found", ENOENT);
                break;
            }

            // Convert flags? 9p flags are similar to unix O_ flags.
            // We'll ignore flags for now and just rely on fs methods, or open if needed.
            // But for directories, we need to prepare for readdir.
            try {
                const st = fs.statSync(oFidObj.path);
                if (st.isDirectory()) {
                     oFidObj.dirEntries = fs.readdirSync(oFidObj.path);
                     oFidObj.dirIndex = 0;
                } else {
                    // Open file
                    const fd = fs.openSync(oFidObj.path, flags & 3); // simplistic flag mapping
                    oFidObj.fd = fd;
                }
                const qid2 = statToQid(st);
                sendReply(13, tag, ["Q", "w"], [qid2, 8192]); // iounit
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

            // Directory read logic
            if (Number(diroffset) === 0) {
                dirFidObj.dirIndex = 0;
            } else {
                // In a real implementation, offset is a cookie. 
                // Here we treat it as an index for simplicity, assuming client passes back what we sent.
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
                const type = (qid.type === QTDIR) ? 4 : 8; // 4=DT_DIR, 8=DT_REG
                
                // Rreaddir: qid[13] offset[8] type[1] name[s]
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
                // File read
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
            
            // Data follows wcount.
            // reqBuf index is at state.offset
            // But Unmarshall didn't extract data.
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
        
        case 14: // Tlcreate (14)
             // fid[4] name[s] flags[4] mode[4] gid[4]
             const [crfid, crname, crflags, crmode, crgid] = Unmarshall(["w", "s", "w", "w", "w"], reqBuf, state);
             const crFidObj = fids.get(crfid);
             if (!crFidObj) {
                 sendError(tag, "fid not found", ENOENT);
                 break;
             }
             const newPath = path.join(crFidObj.path, crname);
             try {
                 const fd = fs.openSync(newPath, "w+"); // simplified
                 fids.set(crfid, { path: newPath, fd: fd, type: QTFILE }); // Update fid to new file
                 const st = fs.statSync(newPath);
                 const qid = statToQid(st);
                 sendReply(15, tag, ["Q", "w"], [qid, 8192]);
             } catch(e) {
                 sendError(tag, e.message, EIO);
             }
             break;

        case 72: // Tmkdir
            // dfid[4] name[s] mode[4] gid[4]
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
            // console.log("Unknown op:", id);
            sendError(tag, "Not implemented", EINVAL);
            break;
    }

} catch (e) {
    console.error("9p Handler Error:", e);
    // try sending error if possible
    // sendError(header[2], e.message, EIO);
}

}