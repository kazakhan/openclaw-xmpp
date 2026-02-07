import { Client } from "ssh2";
import path from "path";
import fs from "fs";

interface XmppConfig {
  domain: string;
  jid: string;
  password: string;
  sftpPort?: number;
}

interface SftpResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

function loadXmppConfig(): XmppConfig {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
  
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    const xmppAccount = config.channels?.xmpp?.accounts?.default;
    
    if (xmppAccount) {
      return {
        domain: xmppAccount.domain,
        jid: xmppAccount.jid,
        password: xmppAccount.password,
        sftpPort: xmppAccount.sftpPort
      };
    }
  } catch (e) {
  }
  
  throw new Error('XMPP configuration not found');
}

function connectSftp(): Promise<Client> {
  const config = loadXmppConfig();
  
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      resolve(conn);
    }).on('error', (err) => {
      reject(err);
    }).connect({
      host: config.domain,
      port: config.sftpPort || 2211,
      username: config.jid.split('@')[0],
      password: config.password
    });
  });
}

export async function sftpUpload(localPath: string, remoteName?: string): Promise<SftpResult<string>> {
  const config = loadXmppConfig();
  const remoteFileName = remoteName || path.basename(localPath);
  
  if (!fs.existsSync(localPath)) {
    return { ok: false, error: `Local file not found: ${localPath}` };
  }
  
  try {
    const conn = await connectSftp() as any;
    
    return new Promise((resolve) => {
      conn.sftp((err: any, sftp: any) => {
        if (err) {
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }
        
        sftp.fastPut(localPath, remoteFileName, (putErr: any) => {
          sftp.end();
          conn.end();
          
          if (putErr) {
            resolve({ ok: false, error: putErr.message });
          } else {
            resolve({ ok: true, data: remoteFileName });
          }
        });
      });
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sftpDownload(remoteName: string, localPath?: string): Promise<SftpResult<string>> {
  const config = loadXmppConfig();
  const downloadDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'xmpp', 'downloads');
  const localFileName = localPath || path.join(downloadDir, remoteName);
  
  try {
    const conn = await connectSftp() as any;
    
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    return new Promise((resolve) => {
      conn.sftp((err: any, sftp: any) => {
        if (err) {
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }
        
        sftp.fastGet(remoteName, localFileName, (getErr: any) => {
          sftp.end();
          conn.end();
          
          if (getErr) {
            resolve({ ok: false, error: getErr.message });
          } else {
            resolve({ ok: true, data: localFileName });
          }
        });
      });
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sftpList(): Promise<SftpResult<string[]>> {
  try {
    const conn = await connectSftp() as any;
    
    return new Promise((resolve) => {
      conn.sftp((err: any, sftp: any) => {
        if (err) {
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }
        
        sftp.readdir('.', (readErr: any, list: any[]) => {
          sftp.end();
          conn.end();
          
          if (readErr) {
            resolve({ ok: false, error: readErr.message });
          } else {
            const names = list.map((item: any) => item.filename);
            resolve({ ok: true, data: names });
          }
        });
      });
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function sftpDelete(remoteName: string): Promise<SftpResult> {
  try {
    const conn = await connectSftp() as any;
    
    return new Promise((resolve) => {
      conn.sftp((err: any, sftp: any) => {
        if (err) {
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }
        
        sftp.unlink(remoteName, (unlinkErr: any) => {
          sftp.end();
          conn.end();
          
          if (unlinkErr) {
            resolve({ ok: false, error: unlinkErr.message });
          } else {
            resolve({ ok: true });
          }
        });
      });
    });
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function sftpHelp(): string {
  return `SFTP commands:
  openclaw xmpp sftp upload <local-path> [remote-name]  - Upload file to SFTP (overwrites existing)
  openclaw xmpp sftp download <remote-name> [local-path] - Download file from SFTP
  openclaw xmpp sftp ls                                - List files in your folder
  openclaw xmpp sftp rm <remote-name>                  - Delete a file
  openclaw xmpp sftp help                              - Show this help

SFTP Configuration:
  - Host: Same as XMPP domain
  - Port: 2211 (SSH/SFTP, configurable via "sftpPort" in xmpp account config)
  - User: Your XMPP JID
  - Password: Same as XMPP password
  - Files are stored in your personal folder (JID-based isolation)

Examples:
  openclaw xmpp sftp upload C:\\Users\\kazak\\Documents\\report.pdf
  openclaw xmpp sftp upload C:\\Users\\kazak\\Documents\\report.pdf custom-name.pdf
  openclaw xmpp sftp download report.pdf
  openclaw xmpp sftp ls
  openclaw xmpp sftp rm old-file.pdf`;
}
