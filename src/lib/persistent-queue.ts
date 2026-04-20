import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";

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

export class PersistentQueue {
  private queue: QueuedMessage[] = [];
  private filePath: string;
  private dirty: boolean = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, QUEUE_FILE);
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
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (this.dirty) await this.save();
    }, 2000);
  }

  private async save(): Promise<void> {
    try {
      await fsp.writeFile(this.filePath, JSON.stringify(this.queue, null, 2), "utf8");
      this.dirty = false;
    } catch {}
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
    this.queue = this.queue.filter(m => m.timestamp > cutoff);
    this.dirty = true;
    this.scheduleFlush();
    return before - this.queue.length;
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
  }
}
