import fs from "fs";
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
  
  constructor(options: JsonStoreOptions<T>) {
    this.filePath = options.filePath;
    this.defaults = options.defaults || {} as T;
    this.onLoad = options.onLoad;
    this.onSave = options.onSave;
    
    const parentDir = path.dirname(this.filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    
    this.data = this.load();
  }
  
  private load(): T {
    if (!fs.existsSync(this.filePath)) {
      return { ...this.defaults };
    }
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      return this.onLoad ? this.onLoad(parsed) : parsed;
    } catch {
      return { ...this.defaults };
    }
  }
  
  private save(): void {
    try {
      const dataToSave = this.onSave ? this.onSave(this.data) : this.data;
      fs.writeFileSync(this.filePath, JSON.stringify(dataToSave, null, 2));
    } catch (err) {
      console.error(`Failed to save ${this.filePath}:`, err);
    }
  }
  
  get(): T {
    return { ...this.data };
  }
  
  set(updates: Partial<T>): void {
    Object.assign(this.data, updates);
    this.save();
  }
  
  update(fn: (data: T) => void): void {
    fn(this.data);
    this.save();
  }
  
  clear(): void {
    this.data = { ...this.defaults } as T;
    this.save();
  }
}
