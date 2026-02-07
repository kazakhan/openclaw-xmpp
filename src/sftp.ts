import { Client } from 'ssh2';
import path from 'path';
import fs from 'fs';
import { decryptPasswordFromConfig } from './security/encryption.js';

interface XmppConfig {
  service: string;
  domain: string;
  jid: string;
  password?: string;
  passwordEncrypted?: string;
  encryptionKey?: string;
}

interface SftpResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

const SFTP_PORT = 2211;
const SFTP_HOST = 'kazakhan.com';

function loadXmppConfig(): XmppConfig {
  const configPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
  
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);
    const xmppAccount = config.channels?.xmpp?.accounts?.default;
    
    if (xmppAccount) {
      return {
        service: xmppAccount.service || `xmpp://${xmppAccount.domain}:5222`,
        domain: xmppAccount.domain,
        jid: xmppAccount.jid,
        password: xmppAccount.password,
        passwordEncrypted: xmppAccount.passwordEncrypted,
        encryptionKey: xmppAccount.encryptionKey
      };
    }
  } catch (e) {
  }
  
  throw new Error('XMPP configuration not found');
}

interface SftpOperationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function withSftp<T>(operation: (sftp: any) => Promise<T>): Promise<SftpOperationResult<T>> {
  const config = loadXmppConfig();
  
  let password: string;
  try {
    password = decryptPasswordFromConfig(config);
  } catch (err) {
    return { ok: false, error: 'Failed to decrypt XMPP password for SFTP' };
  }

  const username = config.jid.split('@')[0];
  const conn = new Client();

  return new Promise<SftpOperationResult<T>>((resolve) => {
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          resolve({ ok: false, error: err.message });
          return;
        }

        operation(sftp)
          .then((result) => {
            sftp.end();
            conn.end();
            resolve({ ok: true, data: result });
          })
          .catch((err) => {
            sftp.end();
            conn.end();
            resolve({ ok: false, error: err.message });
          });
      });
    }).on('error', (err) => {
      resolve({ ok: false, error: err.message });
    }).connect({
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: username,
      password: password
    });
  });
}

export async function sftpUpload(localPath: string, remoteName?: string): Promise<SftpResult<string>> {
  if (!fs.existsSync(localPath)) {
    return { ok: false, error: `Local file not found: ${localPath}` };
  }

  const remoteFilename = remoteName || path.basename(localPath);
  const remotePath = `./${remoteFilename}`;

  return withSftp(async (sftp) => {
    return new Promise<string>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err: any) => {
        if (err) reject(err);
        else resolve(remotePath);
      });
    });
  });
}

export async function sftpDownload(remoteName: string, localPath?: string): Promise<SftpResult<string>> {
  const config = loadXmppConfig();
  const downloadDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'xmpp', 'downloads');
  
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const localFilename = localPath || path.join(downloadDir, remoteName);
  const remotePath = `./${remoteName}`;

  return withSftp(async (sftp) => {
    return new Promise<string>((resolve, reject) => {
      sftp.fastGet(remotePath, localFilename, (err: any) => {
        if (err) reject(err);
        else resolve(localFilename);
      });
    });
  });
}

export async function sftpList(): Promise<SftpResult<string[]>> {
  return withSftp(async (sftp) => {
    return new Promise<string[]>((resolve, reject) => {
      sftp.readdir('./', (err: any, list: any) => {
        if (err) reject(err);
        else resolve(list.map((item: any) => {
          const filename = item.filename;
          const isDir = item.attrs && (item.attrs.mode & 0o40000) !== 0;
          return `${isDir ? 'DIR' : 'FILE'} ${filename}`;
        }));
      });
    });
  });
}

export async function sftpDelete(remoteName: string): Promise<SftpResult> {
  return withSftp(async (sftp) => {
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(`./${remoteName}`, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

export function sftpHelp(): string {
  return `SFTP commands (via SSH on ${SFTP_HOST}:${SFTP_PORT}):
  openclaw xmpp sftp upload <local-path> [remote-name] - Upload file to SFTP server
  openclaw xmpp sftp download <remote-name> [local-path] - Download file from SFTP server
  openclaw xmpp sftp ls                            - List files on SFTP server
  openclaw xmpp sftp rm <remote-name>              - Delete file from SFTP server
  openclaw xmpp sftp help                         - Show this help

SFTP Configuration:
  - Host: ${SFTP_HOST}
  - Port: ${SFTP_PORT}
  - User: Your XMPP JID (username part)
  - Password: Same as XMPP password (encrypted at rest)
  - Files are stored in your home directory

Examples:
  openclaw xmpp sftp upload C:\\Users\\kazak\\Documents\\report.pdf
  openclaw xmpp sftp upload C:\\Users\\kazak\\Documents\\report.pdf custom-name.pdf
  openclaw xmpp sftp download report.pdf
  openclaw xmpp sftp ls
  openclaw xmpp sftp rm old-file.pdf`;
}
