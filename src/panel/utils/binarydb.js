import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * BinaryDB - A fast binary database for v87
 * 
 * Features:
 * - Binary serialization (smaller files, faster I/O)
 * - In-memory indexes for fast lookups
 * - Write-ahead log (WAL) for crash recovery
 * - Automatic compaction
 * - Batch operations
 */

const MAGIC_HEADER = Buffer.from('V87DB001'); // 8 bytes magic + version
const RECORD_TYPES = {
    INSERT: 0x01,
    UPDATE: 0x02,
    DELETE: 0x03
};

export class BinaryDB extends EventEmitter {
    constructor(dbPath, options = {}) {
        super();
        this.dbPath = dbPath;
        this.walPath = dbPath + '.wal';
        this.options = {
            compactThreshold: options.compactThreshold || 1000, // Compact after N operations
            syncInterval: options.syncInterval || 1000, // Sync WAL every N ms
            autoCompact: options.autoCompact !== false,
            ...options
        };

        this.collections = new Map(); // name -> { data: Map, indexes: Map }
        this.walBuffer = [];
        this.operationCount = 0;
        this.dirty = false;
        this.syncTimer = null;
        this.loaded = false;
    }

    async init() {
        if (this.loaded) return;

        // Create directory if needed
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Load existing database
        if (fs.existsSync(this.dbPath)) {
            await this.loadDatabase();
        }

        // Replay WAL if exists
        if (fs.existsSync(this.walPath)) {
            await this.replayWAL();
        }

        // Start sync timer
        this.syncTimer = setInterval(() => {
            this.flushWAL();
        }, this.options.syncInterval);

        this.loaded = true;
    }

    // ==================== Collection Management ====================

    collection(name) {
        if (!this.collections.has(name)) {
            this.collections.set(name, {
                data: new Map(),
                indexes: new Map()
            });
        }
        return new Collection(this, name);
    }

    createIndex(collectionName, field) {
        const col = this.collections.get(collectionName);
        if (!col) return;

        if (!col.indexes.has(field)) {
            col.indexes.set(field, new Map()); // value -> Set of ids
        }

        // Build index from existing data
        const index = col.indexes.get(field);
        for (const [id, doc] of col.data) {
            const value = doc[field];
            if (value !== undefined) {
                if (!index.has(value)) {
                    index.set(value, new Set());
                }
                index.get(value).add(id);
            }
        }
    }

    // ==================== Binary Serialization ====================

    encodeValue(value) {
        const json = JSON.stringify(value);
        const data = Buffer.from(json, 'utf8');
        const length = Buffer.alloc(4);
        length.writeUInt32LE(data.length, 0);
        return Buffer.concat([length, data]);
    }

    decodeValue(buffer, offset) {
        const length = buffer.readUInt32LE(offset);
        const data = buffer.subarray(offset + 4, offset + 4 + length);
        return {
            value: JSON.parse(data.toString('utf8')),
            bytesRead: 4 + length
        };
    }

    encodeRecord(type, collection, id, data) {
        const colBuf = Buffer.from(collection, 'utf8');
        const idBuf = Buffer.from(id, 'utf8');
        
        // Record format:
        // [type:1][colLen:1][col:N][idLen:2][id:N][dataLen:4][data:N][checksum:4]
        const parts = [
            Buffer.from([type]),
            Buffer.from([colBuf.length]),
            colBuf,
            Buffer.alloc(2),
            idBuf
        ];
        parts[3].writeUInt16LE(idBuf.length, 0);

        if (type !== RECORD_TYPES.DELETE) {
            const dataBuf = this.encodeValue(data);
            parts.push(dataBuf);
        }

        const record = Buffer.concat(parts);
        const checksum = this.crc32(record);
        const checksumBuf = Buffer.alloc(4);
        checksumBuf.writeUInt32LE(checksum, 0);

        return Buffer.concat([record, checksumBuf]);
    }

    decodeRecord(buffer, offset) {
        const type = buffer.readUInt8(offset);
        const colLen = buffer.readUInt8(offset + 1);
        const collection = buffer.subarray(offset + 2, offset + 2 + colLen).toString('utf8');
        
        const idLen = buffer.readUInt16LE(offset + 2 + colLen);
        const id = buffer.subarray(offset + 4 + colLen, offset + 4 + colLen + idLen).toString('utf8');
        
        let data = null;
        let bytesRead = 4 + colLen + idLen;

        if (type !== RECORD_TYPES.DELETE) {
            const decoded = this.decodeValue(buffer, offset + bytesRead);
            data = decoded.value;
            bytesRead += decoded.bytesRead;
        }

        // Skip checksum (4 bytes)
        bytesRead += 4;

        return { type, collection, id, data, bytesRead };
    }

    crc32(buffer) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buffer.length; i++) {
            crc ^= buffer[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    // ==================== WAL Operations ====================

    appendWAL(type, collection, id, data) {
        const record = this.encodeRecord(type, collection, id, data);
        this.walBuffer.push(record);
        this.dirty = true;
        this.operationCount++;

        // Auto compact if threshold reached
        if (this.options.autoCompact && this.operationCount >= this.options.compactThreshold) {
            this.compact();
        }
    }

    flushWAL() {
        if (!this.dirty || this.walBuffer.length === 0) return;

        const walData = Buffer.concat(this.walBuffer);
        fs.appendFileSync(this.walPath, walData);
        this.walBuffer = [];
        this.dirty = false;
    }

    async replayWAL() {
        if (!fs.existsSync(this.walPath)) return;

        const walData = fs.readFileSync(this.walPath);
        let offset = 0;

        while (offset < walData.length) {
            try {
                const record = this.decodeRecord(walData, offset);
                this.applyRecord(record);
                offset += record.bytesRead;
            } catch (err) {
                // Corrupted record, stop replay
                console.error('WAL replay error at offset', offset, err.message);
                break;
            }
        }

        // Compact after replay
        await this.compact();
    }

    applyRecord(record) {
        const { type, collection, id, data } = record;
        
        if (!this.collections.has(collection)) {
            this.collections.set(collection, {
                data: new Map(),
                indexes: new Map()
            });
        }

        const col = this.collections.get(collection);

        switch (type) {
            case RECORD_TYPES.INSERT:
            case RECORD_TYPES.UPDATE:
                // Update indexes
                const oldDoc = col.data.get(id);
                if (oldDoc) {
                    this.removeFromIndexes(col, id, oldDoc);
                }
                col.data.set(id, data);
                this.addToIndexes(col, id, data);
                break;

            case RECORD_TYPES.DELETE:
                const deleted = col.data.get(id);
                if (deleted) {
                    this.removeFromIndexes(col, id, deleted);
                }
                col.data.delete(id);
                break;
        }
    }

    addToIndexes(col, id, doc) {
        for (const [field, index] of col.indexes) {
            const value = doc[field];
            if (value !== undefined) {
                if (!index.has(value)) {
                    index.set(value, new Set());
                }
                index.get(value).add(id);
            }
        }
    }

    removeFromIndexes(col, id, doc) {
        for (const [field, index] of col.indexes) {
            const value = doc[field];
            if (value !== undefined && index.has(value)) {
                index.get(value).delete(id);
                if (index.get(value).size === 0) {
                    index.delete(value);
                }
            }
        }
    }

    // ==================== Database File Operations ====================

    async loadDatabase() {
        const data = fs.readFileSync(this.dbPath);
        
        // Check magic header
        if (data.length < 8 || !data.subarray(0, 8).equals(MAGIC_HEADER)) {
            throw new Error('Invalid database file');
        }

        let offset = 8;

        // Read number of collections
        const numCollections = data.readUInt16LE(offset);
        offset += 2;

        for (let i = 0; i < numCollections; i++) {
            // Read collection name
            const nameLen = data.readUInt8(offset);
            const name = data.subarray(offset + 1, offset + 1 + nameLen).toString('utf8');
            offset += 1 + nameLen;

            // Read number of documents
            const numDocs = data.readUInt32LE(offset);
            offset += 4;

            const col = {
                data: new Map(),
                indexes: new Map()
            };

            for (let j = 0; j < numDocs; j++) {
                // Read id
                const idLen = data.readUInt16LE(offset);
                const id = data.subarray(offset + 2, offset + 2 + idLen).toString('utf8');
                offset += 2 + idLen;

                // Read document
                const decoded = this.decodeValue(data, offset);
                col.data.set(id, decoded.value);
                offset += decoded.bytesRead;
            }

            this.collections.set(name, col);
        }
    }

    async saveDatabase() {
        const parts = [MAGIC_HEADER];

        // Number of collections
        const numColBuf = Buffer.alloc(2);
        numColBuf.writeUInt16LE(this.collections.size, 0);
        parts.push(numColBuf);

        for (const [name, col] of this.collections) {
            // Collection name
            const nameBuf = Buffer.from(name, 'utf8');
            parts.push(Buffer.from([nameBuf.length]));
            parts.push(nameBuf);

            // Number of documents
            const numDocsBuf = Buffer.alloc(4);
            numDocsBuf.writeUInt32LE(col.data.size, 0);
            parts.push(numDocsBuf);

            for (const [id, doc] of col.data) {
                // Document id
                const idBuf = Buffer.from(id, 'utf8');
                const idLenBuf = Buffer.alloc(2);
                idLenBuf.writeUInt16LE(idBuf.length, 0);
                parts.push(idLenBuf);
                parts.push(idBuf);

                // Document data
                parts.push(this.encodeValue(doc));
            }
        }

        const finalData = Buffer.concat(parts);
        
        // Write to temp file first, then rename (atomic)
        const tempPath = this.dbPath + '.tmp';
        fs.writeFileSync(tempPath, finalData);
        fs.renameSync(tempPath, this.dbPath);
    }

    async compact() {
        this.flushWAL();
        await this.saveDatabase();
        
        // Remove WAL after successful compaction
        if (fs.existsSync(this.walPath)) {
            fs.unlinkSync(this.walPath);
        }
        
        this.operationCount = 0;
        this.emit('compacted');
    }

    async close() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
        }
        this.flushWAL();
        await this.saveDatabase();
    }
}

/**
 * Collection - Interface for a single collection
 */
class Collection {
    constructor(db, name) {
        this.db = db;
        this.name = name;
    }

    get _col() {
        return this.db.collections.get(this.name);
    }

    generateId() {
        return crypto.randomBytes(12).toString('hex');
    }

    // Create index for faster lookups
    createIndex(field) {
        this.db.createIndex(this.name, field);
        return this;
    }

    // Insert a document
    insert(doc) {
        const id = doc.id || this.generateId();
        const fullDoc = { ...doc, id };
        
        this.db.applyRecord({
            type: RECORD_TYPES.INSERT,
            collection: this.name,
            id,
            data: fullDoc
        });
        
        this.db.appendWAL(RECORD_TYPES.INSERT, this.name, id, fullDoc);
        return fullDoc;
    }

    // Insert multiple documents
    insertMany(docs) {
        return docs.map(doc => this.insert(doc));
    }

    // Find by id
    findById(id) {
        return this._col?.data.get(id) || null;
    }

    // Find one document matching query
    findOne(query) {
        // Use index if available
        for (const [field, value] of Object.entries(query)) {
            const index = this._col?.indexes.get(field);
            if (index && index.has(value)) {
                const ids = index.get(value);
                for (const id of ids) {
                    const doc = this._col.data.get(id);
                    if (this.matchesQuery(doc, query)) {
                        return doc;
                    }
                }
                return null;
            }
        }

        // Full scan
        for (const doc of this._col?.data.values() || []) {
            if (this.matchesQuery(doc, query)) {
                return doc;
            }
        }
        return null;
    }

    // Find all documents matching query
    find(query = {}) {
        const results = [];
        
        // Use index if possible
        const queryFields = Object.keys(query);
        if (queryFields.length === 1) {
            const field = queryFields[0];
            const value = query[field];
            const index = this._col?.indexes.get(field);
            
            if (index && index.has(value)) {
                for (const id of index.get(value)) {
                    const doc = this._col.data.get(id);
                    if (doc) results.push(doc);
                }
                return results;
            }
        }

        // Full scan
        for (const doc of this._col?.data.values() || []) {
            if (this.matchesQuery(doc, query)) {
                results.push(doc);
            }
        }
        return results;
    }

    // Find all documents
    findAll() {
        return Array.from(this._col?.data.values() || []);
    }

    // Update a document
    update(id, updates) {
        const existing = this._col?.data.get(id);
        if (!existing) return null;

        const updated = { ...existing, ...updates, id };
        
        this.db.applyRecord({
            type: RECORD_TYPES.UPDATE,
            collection: this.name,
            id,
            data: updated
        });
        
        this.db.appendWAL(RECORD_TYPES.UPDATE, this.name, id, updated);
        return updated;
    }

    // Update documents matching query
    updateMany(query, updates) {
        const docs = this.find(query);
        return docs.map(doc => this.update(doc.id, updates));
    }

    // Delete a document
    delete(id) {
        if (!this._col?.data.has(id)) return false;

        this.db.applyRecord({
            type: RECORD_TYPES.DELETE,
            collection: this.name,
            id,
            data: null
        });
        
        this.db.appendWAL(RECORD_TYPES.DELETE, this.name, id, null);
        return true;
    }

    // Delete documents matching query
    deleteMany(query) {
        const docs = this.find(query);
        let count = 0;
        for (const doc of docs) {
            if (this.delete(doc.id)) count++;
        }
        return count;
    }

    // Count documents
    count(query = {}) {
        if (Object.keys(query).length === 0) {
            return this._col?.data.size || 0;
        }
        return this.find(query).length;
    }

    // Check if document matches query
    matchesQuery(doc, query) {
        if (!doc) return false;
        
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'object' && value !== null) {
                // Handle operators like $gt, $lt, $in, etc.
                for (const [op, opValue] of Object.entries(value)) {
                    switch (op) {
                        case '$gt':
                            if (!(doc[key] > opValue)) return false;
                            break;
                        case '$gte':
                            if (!(doc[key] >= opValue)) return false;
                            break;
                        case '$lt':
                            if (!(doc[key] < opValue)) return false;
                            break;
                        case '$lte':
                            if (!(doc[key] <= opValue)) return false;
                            break;
                        case '$ne':
                            if (doc[key] === opValue) return false;
                            break;
                        case '$in':
                            if (!opValue.includes(doc[key])) return false;
                            break;
                        case '$nin':
                            if (opValue.includes(doc[key])) return false;
                            break;
                        case '$exists':
                            if ((key in doc) !== opValue) return false;
                            break;
                        case '$regex':
                            if (!new RegExp(opValue).test(doc[key])) return false;
                            break;
                    }
                }
            } else if (doc[key] !== value) {
                return false;
            }
        }
        return true;
    }
}

export default BinaryDB;
