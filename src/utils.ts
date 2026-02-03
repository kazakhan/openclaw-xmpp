import path from "path";
import fs from "fs";
import { XmppConfig } from "./types.js";

export function getDefaultResource(cfg: XmppConfig): string {
  return cfg?.resource || cfg?.jid?.split("@")[0] || "clawdbot";
}

export function getDefaultNick(cfg: XmppConfig): string {
  return cfg.jid ? cfg.jid.split("@")[0] : "clawdbot";
}

export function resolveRoomJid(room: string, domain: string): string {
  if (room.includes('@')) {
    return room;
  }
  return `${room}@conference.${domain}`;
}

export function stripResource(jid: string): string {
  return jid.split('/')[0];
}

export async function downloadFile(url: string, tempDir: string): Promise<string> {
  console.log(`Downloading file from ${url}`);
  
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  const filename = path.basename(pathname) || `file_${Date.now()}.bin`;
  const filePath = path.join(tempDir, filename);
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    await fs.promises.writeFile(filePath, Buffer.from(buffer));
    
    console.log(`File downloaded to ${filePath} (${buffer.byteLength} bytes)`);
    return filePath;
  } catch (err) {
    console.error("File download failed:", err);
    throw err;
  }
}

export function createDebugLogger(prefix: string): (msg: string) => void {
  const logFile = path.join(process.cwd(), 'cli-debug.log');
  return (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${prefix}] ${msg}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch (err) {
      console.error('Failed to write debug log:', err);
    }
  };
}

export async function processInboundFiles(urls: string[], dataDir: string): Promise<string[]> {
  if (urls.length === 0) return [];
  
  const tempDir = path.join(dataDir, 'downloads');
  const localPaths: string[] = [];
  
  for (const url of urls) {
    try {
      const localPath = await downloadFile(url, tempDir);
      localPaths.push(localPath);
    } catch (err) {
      console.error(`Failed to download ${url}:`, err);
    }
  }
  
  return localPaths;
}

export function isGroupChatJid(jid: string): boolean {
  return jid.includes('@conference.') || jid.includes('/');
}

export function parseMessageBody(stanza: any): string | null {
  return stanza.getChildText("body");
}

export function parseMediaUrls(stanza: any): string[] {
  const urls: string[] = [];
  const oobElement = stanza.getChild('x', 'jabber:x:oob');
  if (oobElement) {
    const url = oobElement.getChildText('url');
    if (url) {
      urls.push(url);
    }
  }
  return urls;
}
