import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { log } from "./logger.js";

export interface QueuedMessage {
  id: string;
  from: string;
  body?: string;
  accountId?: string;
  timestamp: number;
  processed: boolean;
}

const QUEUE_FILE = "message-queue.json";
const MAX_QUEUE_SIZE = 100;
const DEAD_LETTER_FILE = "message-queue.dead-letter.json";
const DEAD_LETTER_MAX = 500;

export class PersistentQueue {
  private queue: QueuedMessage[] = [];
  private filePath: string;
  private dirty: boolean = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private deadLetter: QueuedMessage[] = [];
  private deadLetterPath: string;
  private deadLetterDirty: boolean = false;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, QUEUE_FILE);
    this.deadLetterPath = path.join(dataDir, DEAD_LETTER_FILE);
    this.load().catch(() => {});
  }

  private async load(): Promise<void> {
    try {
      const data = await fsp.readFile(this.filePath, "utf8");
      this.queue = JSON.parse(data);
      if (!Array.isArray(this.queue)) this.queue = [];
      this.queue = this.queue.filter((m: any) => m?.id && m?.timestamp);
      if (this.queue.length > MAX_QUEUE_SIZE) {
        this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
      }
    } catch { this.queue = []; }
    try {
      const dlData = await fsp.readFile(this.deadLetterPath, "utf8");
      const parsed = JSON.parse(dlData);
      this.deadLetter = Array.isArray(parsed) ? parsed : [];
    } catch { this.deadLetter = []; }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (this.dirty) await this.save();
      if (this.deadLetterDirty) await this.saveDeadLetter();
    }, 2000);
  }

  private async save(): Promise<void> {
    try {
      await fsp.writeFile(this.filePath, JSON.stringify(this.queue, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      log.error(`[PersistentQueue] failed to write ${this.filePath}:`, err);
    }
  }

  private async saveDeadLetter(): Promise<void> {
    try {
      await fsp.writeFile(this.deadLetterPath, JSON.stringify(this.deadLetter, null, 2), "utf8");
      this.deadLetterDirty = false;
    } catch (err) {
      log.error(`[PersistentQueue] failed to write dead-letter ${this.deadLetterPath}:`, err);
    }
  }

  push(message: Omit<QueuedMessage, 'id' | 'timestamp' | 'processed'>): string {
    const entry: QueuedMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      processed: false,
      ...message,
    };
    this.queue.push(entry);
    this.dirty = true;
    this.scheduleFlush();
    this.trim();
    return entry.id;
  }

  get all(): QueuedMessage[] { return this.queue; }

  getUnprocessed(accountId?: string): QueuedMessage[] {
    return this.queue.filter(m => !m.processed && (!accountId || m.accountId === accountId));
  }

  markProcessed(id: string): void {
    const msg = this.queue.find(m => m.id === id);
    if (msg) msg.processed = true;
    this.dirty = true;
    this.scheduleFlush();
  }

  clearOld(maxAgeMs: number = 86400000): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.queue.length;
    const survivors: QueuedMessage[] = [];
    const dead = this.deadLetter;
    let deadAppended = 0;
    for (const m of this.queue) {
      if (m.timestamp > cutoff) {
        survivors.push(m);
      } else if (!m.processed) {
        if (dead.length + deadAppended < DEAD_LETTER_MAX) {
          dead.push(m);
          deadAppended++;
        }
      }
    }
    this.queue = survivors;
    if (deadAppended > 0) {
      this.deadLetterDirty = true;
    }
    this.dirty = true;
    this.scheduleFlush();
    return before - this.queue.length;
  }

  getDeadLetter(): QueuedMessage[] { return this.deadLetter; }

  clearDeadLetter(): number {
    const before = this.deadLetter.length;
    this.deadLetter = [];
    this.deadLetterDirty = true;
    this.scheduleFlush();
    return before;
  }

  private trim(): void {
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
      this.dirty = true;
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.dirty) await this.save();
    if (this.deadLetterDirty) await this.saveDeadLetter();
  }
}
