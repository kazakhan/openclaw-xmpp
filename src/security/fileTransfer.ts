import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface FileTransferConfig {
  maxFileSizeMB: number;
  maxUploadSizeMB: number;
  maxDownloadSizeMB: number;
  allowedMimeTypes: string[];
  quarantineDir: string;
  enableVirusScan: boolean;
  userQuotaMB: number;
  tempDir: string;
}

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  fileId?: string;
  hash?: string;
  size?: number;
  mimeType?: string;
  quarantined?: boolean;
}

export interface QuarantineEntry {
  fileId: string;
  originalPath: string;
  quarantinePath: string;
  timestamp: number;
  reason: string;
  hash: string;
  size: number;
}

const DEFAULT_CONFIG: FileTransferConfig = {
  maxFileSizeMB: 10,
  maxUploadSizeMB: 10,
  maxDownloadSizeMB: 10,
  allowedMimeTypes: [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'text/html',
    'text/csv',
    'application/json',
    'application/zip',
    'audio/mpeg',
    'audio/wav',
    'video/mp4',
    'video/webm'
  ],
  quarantineDir: './quarantine',
  enableVirusScan: false,
  userQuotaMB: 100,
  tempDir: './temp'
};

const MIME_TYPE_MAP: Record<string, string[]> = {
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
  '.pdf': ['application/pdf'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown'],
  '.html': ['text/html'],
  '.htm': ['text/html'],
  '.csv': ['text/csv'],
  '.json': ['application/json'],
  '.zip': ['application/zip'],
  '.mp3': ['audio/mpeg'],
  '.wav': ['audio/wav'],
  '.mp4': ['video/mp4'],
  '.webm': ['video/webm']
};

export class SecureFileTransfer {
  private config: FileTransferConfig;
  private userUsage: Map<string, { used: number; timestamp: number }> = new Map();
  private quarantineLog: QuarantineEntry[] = [];
  private tempDir: string;

  constructor(config: Partial<FileTransferConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tempDir = this.config.tempDir;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    if (!fs.existsSync(this.config.quarantineDir)) {
      fs.mkdirSync(this.config.quarantineDir, { recursive: true });
    }
  }

  async calculateHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  async calculateHashFromBuffer(buffer: Buffer): Promise<string> {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  detectMimeType(filename: string, buffer?: Buffer): string {
    const ext = path.extname(filename).toLowerCase();

    if (MIME_TYPE_MAP[ext]) {
      return MIME_TYPE_MAP[ext][0];
    }

    if (buffer && buffer.length >= 4) {
      const signatures: Record<string, string[]> = {
        'image/jpeg': ['ffd8'],
        'image/png': ['89504e47'],
        'image/gif': ['47494638'],
        'application/pdf': ['25504446'],
        'application/zip': ['504b34'],
        'audio/wav': ['52494646'],
        'video/webm': ['1a45dfa3']
      };

      const hex = buffer.slice(0, 4).toString('hex');
      for (const [mime, sigs] of Object.entries(signatures)) {
        if (sigs.some(sig => hex.startsWith(sig))) {
          return mime;
        }
      }
    }

    return 'application/octet-stream';
  }

  isAllowedMimeType(mimeType: string): boolean {
    return this.config.allowedMimeTypes.includes(mimeType.toLowerCase());
  }

  getFileExtension(filename: string): string {
    return path.extname(filename).toLowerCase();
  }

  validateFilename(filename: string): FileValidationResult {
    if (!filename || typeof filename !== 'string') {
      return { valid: false, error: 'Filename must be a non-empty string' };
    }

    const basename = path.basename(filename);
    if (basename.length === 0) {
      return { valid: false, error: 'Invalid filename' };
    }

    const dangerousExtensions = ['.exe', '.bat', '.cmd', '.sh', '.php', '.js', '.py', '.pif', '.msi', '.dll', '.scr', '.jar'];
    const ext = this.getFileExtension(filename);
    if (dangerousExtensions.includes(ext)) {
      return { valid: false, error: `Dangerous file extension not allowed: ${ext}` };
    }

    const sanitized = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (sanitized !== basename) {
      return { valid: true, fileId: sanitized, error: 'Filename was sanitized' };
    }

    return { valid: true, fileId: basename };
  }

  validateFileSize(size: number, isUpload: boolean = true): FileValidationResult {
    const maxSize = isUpload ? this.config.maxUploadSizeMB : this.config.maxDownloadSizeMB;
    const maxBytes = maxSize * 1024 * 1024;

    if (typeof size !== 'number' || isNaN(size)) {
      return { valid: false, error: 'Invalid file size' };
    }

    if (size > maxBytes) {
      return {
        valid: false,
        error: `File too large: ${(size / 1024 / 1024).toFixed(2)}MB > ${maxSize}MB limit`
      };
    }

    if (size === 0) {
      return { valid: false, error: 'File is empty' };
    }

    return { valid: true, size };
  }

  async validateIncomingFile(
    filePath: string,
    metadata: { size: number; mimeType?: string; userId: string }
  ): Promise<FileValidationResult> {
    const sizeValidation = this.validateFileSize(metadata.size, false);
    if (!sizeValidation.valid) {
      return { valid: false, error: sizeValidation.error };
    }

    const filename = path.basename(filePath);
    const filenameValidation = this.validateFilename(filename);
    if (!filenameValidation.valid) {
      return { valid: false, error: filenameValidation.error };
    }

    let mimeType = metadata.mimeType || this.detectMimeType(filename);
    if (mimeType === 'application/octet-stream') {
      try {
        const buffer = fs.readFileSync(filePath);
        mimeType = this.detectMimeType(filename, buffer);
      } catch {
        mimeType = 'application/octet-stream';
      }
    }

    if (!this.isAllowedMimeType(mimeType)) {
      const quarantineResult = await this.quarantineFile(filePath, `Rejected MIME type: ${mimeType}`);
      return {
        valid: false,
        error: `MIME type not allowed: ${mimeType}`,
        quarantined: true
      };
    }

    const hash = await this.calculateHash(filePath);

    const userUsage = this.userUsage.get(metadata.userId) || { used: 0, timestamp: Date.now() };
    const quotaBytes = this.config.userQuotaMB * 1024 * 1024;

    if (userUsage.used + metadata.size > quotaBytes) {
      return {
        valid: false,
        error: `Storage quota exceeded. Used: ${(userUsage.used / 1024 / 1024).toFixed(2)}MB, Limit: ${this.config.userQuotaMB}MB`
      };
    }

    this.userUsage.set(metadata.userId, {
      used: userUsage.used + metadata.size,
      timestamp: Date.now()
    });

    return {
      valid: true,
      fileId: filenameValidation.fileId,
      hash,
      size: metadata.size,
      mimeType
    };
  }

  async quarantineFile(filePath: string, reason: string): Promise<void> {
    const timestamp = Date.now();
    const fileId = `${timestamp}_${path.basename(filePath)}`;
    const quarantinePath = path.join(this.config.quarantineDir, fileId);

    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, quarantinePath);
      }

      const hash = await this.calculateHash(quarantinePath);
      const stats = fs.statSync(quarantinePath);

      this.quarantineLog.push({
        fileId,
        originalPath: filePath,
        quarantinePath,
        timestamp,
        reason,
        hash,
        size: stats.size
      });

      console.log(`[QUARANTINE] File quarantined: ${fileId} (${reason})`);
    } catch (err) {
      console.error(`[QUARANTINE] Failed to quarantine file: ${filePath}`, err);
    }
  }

  getQuarantineLog(): QuarantineEntry[] {
    return [...this.quarantineLog];
  }

  clearQuarantineLog(): void {
    this.quarantineLog = [];
  }

  async scanForMalware(filePath: string): Promise<{ clean: boolean; details?: string }> {
    if (!this.config.enableVirusScan) {
      return { clean: true };
    }

    const suspiciousPatterns = [
      /eval\s*\(\s*base64_decode/i,
      /\$_(?:GET|POST|REQUEST)\s*\[/,
      /<script[^>]*>.*?base64.*?<\/script>/gis,
      /chmod\s*\(\s*\d+/,
      /exec\s*\(\s*\$_(?:GET|POST|REQUEST)/i,
      /shell_exec\s*\(/i,
      /system\s*\(\s*\$_(?:GET|POST|REQUEST)/i,
      /passthru\s*\(\s*\$_(?:GET|POST|REQUEST)/i
    ];

    try {
      const content = fs.readFileSync(filePath, 'utf8');

      for (const pattern of suspiciousPatterns) {
        if (pattern.test(content)) {
          await this.quarantineFile(filePath, 'Suspicious pattern detected');
          return { clean: false, details: 'Suspicious code pattern detected' };
        }
      }

      return { clean: true };
    } catch {
      return { clean: true };
    }
  }

  createTempFile(prefix: string = 'file'): string {
    const tempFile = path.join(this.tempDir, `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`);
    return tempFile;
  }

  async secureDeleteFile(filePath: string): Promise<boolean> {
    try {
      if (!fs.existsSync(filePath)) {
        return true;
      }

      const stats = fs.statSync(filePath);
      const buffer = Buffer.alloc(stats.size, 0);
      const fd = fs.openSync(filePath, 'r+');
      fs.writeSync(fd, buffer);
      fs.closeSync(fd);

      fs.unlinkSync(filePath);

      return true;
    } catch (err) {
      console.error(`[SECURITY] Failed to securely delete file: ${filePath}`, err);
      return false;
    }
  }

  getUserUsage(userId: string): { usedMB: number; limitMB: number; percentage: number } {
    const usage = this.userUsage.get(userId);
    const usedMB = usage ? usage.used / 1024 / 1024 : 0;
    return {
      usedMB: Math.round(usedMB * 100) / 100,
      limitMB: this.config.userQuotaMB,
      percentage: Math.round((usedMB / (this.config.userQuotaMB * 1024 * 1024)) * 10000) / 100
    };
  }

  cleanupOldTempFiles(maxAgeMs: number = 3600000): number {
    const now = Date.now();
    let deleted = 0;

    if (fs.existsSync(this.tempDir)) {
      const files = fs.readdirSync(this.tempDir);
      for (const file of files) {
        const filePath = path.join(this.tempDir, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAgeMs) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch {
        }
      }
    }

    return deleted;
  }

  getStats(): {
    config: { maxFileSizeMB: number; allowedMimeTypesCount: number; enableVirusScan: boolean; userQuotaMB: number };
    quarantineCount: number;
    tempDirExists: boolean;
    quarantineDirExists: boolean;
  } {
    return {
      config: {
        maxFileSizeMB: this.config.maxFileSizeMB,
        allowedMimeTypesCount: this.config.allowedMimeTypes.length,
        enableVirusScan: this.config.enableVirusScan,
        userQuotaMB: this.config.userQuotaMB
      },
      quarantineCount: this.quarantineLog.length,
      tempDirExists: fs.existsSync(this.tempDir),
      quarantineDirExists: fs.existsSync(this.config.quarantineDir)
    };
  }
}

export function createSecureFileTransfer(config?: Partial<FileTransferConfig>): SecureFileTransfer {
  return new SecureFileTransfer(config);
}
