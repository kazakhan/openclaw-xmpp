import fs from "fs/promises";
import path from "path";

export interface JsonStoreOptions<T> {
  filePath: string;
  defaults?: T;
  onLoad?: (data: T) => T;
  onSave?: (data: T) => T;
}

export class JsonStore<T extends object> {
  private filePath: string;
  private data: T;
  private defaults: T;
  private onLoad?: (data: T) => T;
  private onSave?: (data: T) => T;
  private initialized: Promise<void> | null = null;
  // SECURITY (2.0.17, M4): per-instance write-chain serialises
  // set/update/clear callers.  Without this, two concurrent callers
  // (e.g. two simultaneous contact-add from two inbound messages)
  // can race: each loads the same baseline, each mutates, the second
  // `save()` overwrites the first.  The chain runs each write step
  // in order, so each caller's mutation is applied to the state
  // produced by the previous caller's write.  Inner promise errors
  // are swallowed by the chain (they don't kill subsequent steps)
  // but the outer returned promise still rejects so the caller can
  // see the failure.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: JsonStoreOptions<T>) {
    this.filePath = options.filePath;
    this.defaults = options.defaults || {} as T;
    this.onLoad = options.onLoad;
    this.onSave = options.onSave;

    const parentDir = path.dirname(this.filePath);
    this.initialized = fs.mkdir(parentDir, { recursive: true })
      .then(() => this.load())
      .then((d) => { this.data = d; });
  }

  private async whenReady(): Promise<void> {
    if (this.initialized) {
      await this.initialized;
      this.initialized = null;
    }
  }

  private async load(): Promise<T> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      return this.onLoad ? this.onLoad(parsed) : parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet, return defaults
        if (Array.isArray(this.defaults)) {
          return [...this.defaults] as unknown as T;
        }
        return { ...this.defaults };
      }
      // Parse error or other issue
      if (Array.isArray(this.defaults)) {
        return [...this.defaults] as unknown as T;
      }
      return { ...this.defaults };
    }
  }

  private async save(): Promise<void> {
    try {
      const dataToSave = this.onSave ? this.onSave(this.data) : this.data;
      await fs.writeFile(this.filePath, JSON.stringify(dataToSave, null, 2), "utf8");
    } catch (err) {
      console.error(`Failed to save ${this.filePath}:`, err);
    }
  }

  // SECURITY (2.0.17, M4): enqueue a write step on the per-instance
  // chain.  Returns a promise that resolves when this specific step
  // completes.  Inner steps never see another step's `await`; the
  // chain itself is fail-open (one step throwing does not poison
  // subsequent steps).  Callers can `await this.enqueueWrite(...)`
  // to know their write hit disk.
  private enqueueWrite(step: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(step, step);
    // Keep the chain alive even if a step rejects, so future steps
    // still run.  We return a separate promise so the caller still
    // sees the rejection.
    this.writeChain = next.catch(() => {});
    return next;
  }

  async get(): Promise<T> {
    await this.whenReady();
    if (Array.isArray(this.data)) {
      return [...this.data] as unknown as T;
    }
    return { ...this.data };
  }

  async set(updates: Partial<T>): Promise<void> {
    await this.whenReady();
    return this.enqueueWrite(async () => {
      Object.assign(this.data, updates);
      await this.save();
    });
  }

  async update(fn: (data: T) => void): Promise<void> {
    await this.whenReady();
    return this.enqueueWrite(async () => {
      fn(this.data);
      await this.save();
    });
  }

  async clear(): Promise<void> {
    await this.whenReady();
    return this.enqueueWrite(async () => {
      this.data = { ...this.defaults } as T;
      await this.save();
    });
  }
}
