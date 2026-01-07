import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import BinaryDB from '../src/panel/utils/binarydb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.join(__dirname, 'test-data', 'test.db');

function cleanup() {
    const dir = path.dirname(TEST_DB_PATH);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
    }
}

describe('BinaryDB', () => {
    let db;

    before(() => {
        cleanup();
    });

    after(async () => {
        if (db) await db.close();
        cleanup();
    });

    beforeEach(async () => {
        cleanup();
        db = new BinaryDB(TEST_DB_PATH, {
            compactThreshold: 10,
            syncInterval: 100
        });
        await db.init();
    });

    describe('Basic Operations', () => {
        it('should insert a document', () => {
            const users = db.collection('users');
            const user = users.insert({ name: 'John', email: 'john@test.com' });
            
            assert.ok(user.id);
            assert.strictEqual(user.name, 'John');
            assert.strictEqual(user.email, 'john@test.com');
        });

        it('should find document by id', () => {
            const users = db.collection('users');
            const inserted = users.insert({ name: 'Jane', email: 'jane@test.com' });
            
            const found = users.findById(inserted.id);
            assert.strictEqual(found.name, 'Jane');
        });

        it('should find document by query', () => {
            const users = db.collection('users');
            users.insert({ name: 'Alice', role: 'admin' });
            users.insert({ name: 'Bob', role: 'user' });
            
            const admin = users.findOne({ role: 'admin' });
            assert.strictEqual(admin.name, 'Alice');
        });

        it('should find all documents matching query', () => {
            const users = db.collection('users');
            users.insert({ name: 'User1', role: 'user' });
            users.insert({ name: 'User2', role: 'user' });
            users.insert({ name: 'Admin1', role: 'admin' });
            
            const allUsers = users.find({ role: 'user' });
            assert.strictEqual(allUsers.length, 2);
        });

        it('should update a document', () => {
            const users = db.collection('users');
            const user = users.insert({ name: 'Test', email: 'test@test.com' });
            
            const updated = users.update(user.id, { email: 'updated@test.com' });
            assert.strictEqual(updated.email, 'updated@test.com');
            assert.strictEqual(updated.name, 'Test');
        });

        it('should delete a document', () => {
            const users = db.collection('users');
            const user = users.insert({ name: 'ToDelete' });
            
            const deleted = users.delete(user.id);
            assert.strictEqual(deleted, true);
            
            const found = users.findById(user.id);
            assert.strictEqual(found, null);
        });

        it('should count documents', () => {
            const users = db.collection('users');
            users.insert({ name: 'A' });
            users.insert({ name: 'B' });
            users.insert({ name: 'C' });
            
            assert.strictEqual(users.count(), 3);
        });
    });

    describe('Indexes', () => {
        it('should create and use index for fast lookup', () => {
            const users = db.collection('users');
            users.createIndex('email');
            
            users.insert({ name: 'Test1', email: 'test1@test.com' });
            users.insert({ name: 'Test2', email: 'test2@test.com' });
            users.insert({ name: 'Test3', email: 'test3@test.com' });
            
            const found = users.findOne({ email: 'test2@test.com' });
            assert.strictEqual(found.name, 'Test2');
        });

        it('should update index on document update', () => {
            const users = db.collection('users');
            users.createIndex('email');
            
            const user = users.insert({ name: 'Test', email: 'old@test.com' });
            users.update(user.id, { email: 'new@test.com' });
            
            const oldEmail = users.findOne({ email: 'old@test.com' });
            const newEmail = users.findOne({ email: 'new@test.com' });
            
            assert.strictEqual(oldEmail, null);
            assert.strictEqual(newEmail.name, 'Test');
        });

        it('should remove from index on delete', () => {
            const users = db.collection('users');
            users.createIndex('email');
            
            const user = users.insert({ name: 'Test', email: 'delete@test.com' });
            users.delete(user.id);
            
            const found = users.findOne({ email: 'delete@test.com' });
            assert.strictEqual(found, null);
        });
    });

    describe('Query Operators', () => {
        it('should support $gt operator', () => {
            const items = db.collection('items');
            items.insert({ name: 'A', price: 10 });
            items.insert({ name: 'B', price: 20 });
            items.insert({ name: 'C', price: 30 });
            
            const expensive = items.find({ price: { $gt: 15 } });
            assert.strictEqual(expensive.length, 2);
        });

        it('should support $lt operator', () => {
            const items = db.collection('items');
            items.insert({ name: 'A', price: 10 });
            items.insert({ name: 'B', price: 20 });
            items.insert({ name: 'C', price: 30 });
            
            const cheap = items.find({ price: { $lt: 25 } });
            assert.strictEqual(cheap.length, 2);
        });

        it('should support $in operator', () => {
            const items = db.collection('items');
            items.insert({ name: 'A', status: 'active' });
            items.insert({ name: 'B', status: 'pending' });
            items.insert({ name: 'C', status: 'inactive' });
            
            const result = items.find({ status: { $in: ['active', 'pending'] } });
            assert.strictEqual(result.length, 2);
        });

        it('should support $ne operator', () => {
            const items = db.collection('items');
            items.insert({ name: 'A', status: 'active' });
            items.insert({ name: 'B', status: 'inactive' });
            items.insert({ name: 'C', status: 'active' });
            
            const result = items.find({ status: { $ne: 'active' } });
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].name, 'B');
        });

        it('should support $regex operator', () => {
            const items = db.collection('items');
            items.insert({ name: 'Apple' });
            items.insert({ name: 'Banana' });
            items.insert({ name: 'Apricot' });
            
            const result = items.find({ name: { $regex: '^Ap' } });
            assert.strictEqual(result.length, 2);
        });
    });

    describe('Persistence', () => {
        it('should persist data after compaction', async () => {
            const users = db.collection('users');
            users.insert({ name: 'Persistent', email: 'persist@test.com' });
            
            await db.compact();
            await db.close();
            
            // Reopen database
            const db2 = new BinaryDB(TEST_DB_PATH);
            await db2.init();
            
            const found = db2.collection('users').findOne({ name: 'Persistent' });
            assert.ok(found);
            assert.strictEqual(found.email, 'persist@test.com');
            
            await db2.close();
        });

        it('should recover from WAL on crash', async () => {
            const users = db.collection('users');
            users.insert({ name: 'WALTest', email: 'wal@test.com' });
            
            // Simulate crash (don't call close, just flush WAL)
            db.flushWAL();
            
            // Create new instance (simulates restart)
            const db2 = new BinaryDB(TEST_DB_PATH);
            await db2.init();
            
            const found = db2.collection('users').findOne({ name: 'WALTest' });
            assert.ok(found);
            assert.strictEqual(found.email, 'wal@test.com');
            
            await db2.close();
        });
    });

    describe('Batch Operations', () => {
        it('should insert many documents', () => {
            const users = db.collection('users');
            const docs = [
                { name: 'User1' },
                { name: 'User2' },
                { name: 'User3' }
            ];
            
            const inserted = users.insertMany(docs);
            assert.strictEqual(inserted.length, 3);
            assert.strictEqual(users.count(), 3);
        });

        it('should delete many documents', () => {
            const users = db.collection('users');
            users.insert({ name: 'A', role: 'user' });
            users.insert({ name: 'B', role: 'user' });
            users.insert({ name: 'C', role: 'admin' });
            
            const deleted = users.deleteMany({ role: 'user' });
            assert.strictEqual(deleted, 2);
            assert.strictEqual(users.count(), 1);
        });

        it('should update many documents', () => {
            const users = db.collection('users');
            users.insert({ name: 'A', active: false });
            users.insert({ name: 'B', active: false });
            users.insert({ name: 'C', active: true });
            
            const updated = users.updateMany({ active: false }, { active: true });
            assert.strictEqual(updated.length, 2);
            
            const activeUsers = users.find({ active: true });
            assert.strictEqual(activeUsers.length, 3);
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty collection', () => {
            const empty = db.collection('empty');
            assert.strictEqual(empty.count(), 0);
            assert.deepStrictEqual(empty.findAll(), []);
            assert.strictEqual(empty.findOne({ any: 'query' }), null);
        });

        it('should handle special characters in data', () => {
            const items = db.collection('items');
            const doc = items.insert({
                name: 'Test "quotes" and \'apostrophes\'',
                unicode: '日本語 🎉 émojis',
                newlines: 'line1\nline2\r\nline3'
            });
            
            const found = items.findById(doc.id);
            assert.strictEqual(found.unicode, '日本語 🎉 émojis');
        });

        it('should handle large documents', () => {
            const items = db.collection('items');
            const largeData = 'x'.repeat(100000);
            
            const doc = items.insert({ data: largeData });
            const found = items.findById(doc.id);
            
            assert.strictEqual(found.data.length, 100000);
        });

        it('should handle nested objects', () => {
            const items = db.collection('items');
            const doc = items.insert({
                nested: {
                    level1: {
                        level2: {
                            value: 'deep'
                        }
                    }
                }
            });
            
            const found = items.findById(doc.id);
            assert.strictEqual(found.nested.level1.level2.value, 'deep');
        });

        it('should handle arrays', () => {
            const items = db.collection('items');
            const doc = items.insert({
                tags: ['a', 'b', 'c'],
                numbers: [1, 2, 3]
            });
            
            const found = items.findById(doc.id);
            assert.deepStrictEqual(found.tags, ['a', 'b', 'c']);
        });
    });

    describe('Performance', () => {
        it('should handle 1000 inserts efficiently', () => {
            const items = db.collection('perf');
            const start = Date.now();
            
            for (let i = 0; i < 1000; i++) {
                items.insert({ index: i, data: `item-${i}` });
            }
            
            const duration = Date.now() - start;
            assert.strictEqual(items.count(), 1000);
            assert.ok(duration < 5000, `Insert took ${duration}ms, expected < 5000ms`);
        });

        it('should find by index quickly', () => {
            const items = db.collection('indexed');
            items.createIndex('code');
            
            // Insert 1000 items
            for (let i = 0; i < 1000; i++) {
                items.insert({ code: `CODE-${i}`, value: i });
            }
            
            const start = Date.now();
            
            // Do 100 lookups
            for (let i = 0; i < 100; i++) {
                const idx = Math.floor(Math.random() * 1000);
                items.findOne({ code: `CODE-${idx}` });
            }
            
            const duration = Date.now() - start;
            assert.ok(duration < 100, `100 indexed lookups took ${duration}ms, expected < 100ms`);
        });
    });
});

describe('CRC32 Checksum', () => {
    it('should calculate correct CRC32', () => {
        const db = new BinaryDB('/tmp/crc-test.db');
        
        const testCases = [
            { input: Buffer.from('hello'), expected: 0x3610A686 },
            { input: Buffer.from(''), expected: 0x00000000 },
            { input: Buffer.from('123456789'), expected: 0xCBF43926 }
        ];
        
        for (const { input, expected } of testCases) {
            const result = db.crc32(input);
            assert.strictEqual(result, expected, `CRC32 of "${input}" should be ${expected.toString(16)}`);
        }
    });
});
