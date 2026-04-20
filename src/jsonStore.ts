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

  async get(): Promise<T> {
    await this.whenReady();
    if (Array.isArray(this.data)) {
      return [...this.data] as unknown as T;
    }
    return { ...this.data };
  }

  async set(updates: Partial<T>): Promise<void> {
    await this.whenReady();
    Object.assign(this.data, updates);
    await this.save();
  }

  async update(fn: (data: T) => void): Promise<void> {
    await this.whenReady();
    fn(this.data);
    await this.save();
  }

  async clear(): Promise<void> {
    await this.whenReady();
    this.data = { ...this.defaults } as T;
    await this.save();
  }
}
