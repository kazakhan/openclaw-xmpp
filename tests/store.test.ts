import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { JsonStore } from '../src/jsonStore.js';
import { PersistentQueue, QueuedMessage } from '../src/lib/persistent-queue.js';

describe('JsonStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-test-'));
    storePath = path.join(tmpDir, 'test-store.json');
  });

  it('creates with defaults when file missing', async () => {
    const store = new JsonStore<{ name: string; count: number }>({
      filePath: storePath,
      defaults: { name: 'test', count: 0 }
    });
    const data = await store.get();
    assert.equal(data.name, 'test');
    assert.equal(data.count, 0);
  });

  it('persists set() across instances', async () => {
    const s1 = new JsonStore<{ val: number }>({ filePath: storePath, defaults: { val: 0 } });
    await s1.set({ val: 42 });
    
    const s2 = new JsonStore<{ val: number }>({ filePath: storePath, defaults: { val: 0 } });
    const data = await s2.get();
    assert.equal(data.val, 42);
  });

  it('update() modifies data correctly', async () => {
    const store = new JsonStore<{ items: string[] }>({
      filePath: storePath,
      defaults: { items: [] }
    });
    await store.update(d => { d.items.push('hello') });
    const data = await store.get();
    assert.deepEqual(data.items, ['hello']);
  });

  it('clear() resets to defaults', async () => {
    const store = new JsonStore<{ x: string }>({ filePath: storePath, defaults: { x: 'init' } });
    await store.set({ x: 'changed' });
    await store.clear();
    const data = await store.get();
    assert.equal(data.x, 'init');
  });
});

describe('PersistentQueue', () => {
  let tmpDir: string;
  let queue: PersistentQueue;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xmpp-queue-test-'));
    queue = new PersistentQueue(tmpDir);
    // Await async constructor (load from disk)
    await new Promise(r => setTimeout(r, 100));
  });

  it('pushes and retrieves messages', () => {
    const id = queue.push({ from: 'user@test.com', body: 'hello', accountId: 'default' });
    assert.ok(id.length > 0, 'should return non-empty id');
    
    const all = queue.all;
    assert.equal(all.length, 1);
    assert.equal(all[0].from, 'user@test.com');
    assert.equal(all[0].body, 'hello');
    assert.equal(all[0].processed, false);
  });

  it('filters unprocessed by account', () => {
    queue.push({ from: 'a@b.com', body: 'msg1', accountId: 'acct1' });
    queue.push({ from: 'c@d.com', body: 'msg2', accountId: 'acct2' });
    queue.push({ from: 'e@f.com', body: 'msg3', accountId: 'acct1' });
    
    const acct1 = queue.getUnprocessed('acct1');
    assert.equal(acct1.length, 2);
    
    const acct2 = queue.getUnprocessed('acct2');
    assert.equal(acct2.length, 1);
  });

  it('marks messages as processed', () => {
    const id = queue.push({ from: 'a@b.com', body: 'test', accountId: 'd' });
    queue.markProcessed(id);
    
    const unprocessed = queue.getUnprocessed();
    assert.equal(unprocessed.length, 0);
  });

  it('trims to max size on push', () => {
    for (let i = 0; i < 110; i++) {
      queue.push({ from: `user${i}@test.com`, body: `msg${i}`, accountId: 'd' });
    }
    assert.ok(queue.all.length <= 100, `should be <= 100 but got ${queue.all.length}`);
  });

  it('clearOld removes expired entries', () => {
    // Push entries then manually expire them via internal queue
    for (let i = 0; i < 5; i++) {
      queue.push({ from: 'old@test.com', body: 'old', accountId: 'd' });
    }
    // Set maxAgeMs=0 so ALL entries are "expired" (>0ms old)
    const removed = queue.clearOld(0);
    assert.equal(removed, 5);
    assert.equal(queue.all.length, 0);
  });

  it('deduplicates via addToQueue wrapper', () => {
    // The dedup logic is in index.ts addToQueue which wraps queue.push
    // Test that push itself doesn't dedup (that's the wrapper's job)
    const id1 = queue.push({ from: 'dup@test.com', body: 'same', accountId: 'd' });
    const id2 = queue.push({ from: 'dup@test.com', body: 'same', accountId: 'd' });
    assert.notEqual(id1, id2, 'different messages should get different IDs even with same content');
    assert.equal(queue.all.length, 2);
  });
});
