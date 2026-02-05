import ftp from "basic-ftp";
import path from "path";
import fs from "fs";

interface XmppConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  ftpPort?: number;
}

interface FtpResult<T = void> {
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
        service: xmppAccount.service || `xmpp://${xmppAccount.domain}:5222`,
        domain: xmppAccount.domain,
        jid: xmppAccount.jid,
        password: xmppAccount.password,
        ftpPort: xmppAccount.ftpPort
      };
    }
  } catch (e) {
  }
  
  throw new Error('XMPP configuration not found');
}

export async function ftpUpload(localPath: string, remoteName?: string): Promise<FtpResult<string>> {
  const config = loadXmppConfig();
  const client = new ftp.Client();
  const ftpPort = config.ftpPort || 17323;
  const username = config.jid.split('@')[0];

  try {
    await client.access({
      host: config.domain,
      port: ftpPort,
      user: username,
      password: config.password,
      secure: false
    });

    const remoteFileName = (remoteName || path.basename(localPath));
    
    if (!fs.existsSync(localPath)) {
      return { ok: false, error: `Local file not found: ${localPath}` };
    }

    await client.uploadFrom(localPath, remoteFileName);
    client.close();
    return { ok: true, data: remoteFileName };
  } catch (err: any) {
    client.close();
    return { ok: false, error: err.message };
  }
}

export async function ftpDownload(remoteName: string, localPath?: string): Promise<FtpResult<string>> {
  const config = loadXmppConfig();
  const client = new ftp.Client();
  const ftpPort = config.ftpPort || 17323;
  const downloadDir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'xmpp', 'downloads');
  const username = config.jid.split('@')[0];
  
  try {
    await client.access({
      host: config.domain,
      port: ftpPort,
      user: username,
      password: config.password,
      secure: false
    });

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const localFileName = localPath || path.join(downloadDir, remoteName);
    await client.downloadTo(localFileName, remoteName);
    client.close();
    return { ok: true, data: localFileName };
  } catch (err: any) {
    client.close();
    return { ok: false, error: err.message };
  }
}

export async function ftpList(): Promise<FtpResult<string[]>> {
  const config = loadXmppConfig();
  const client = new ftp.Client();
  const ftpPort = config.ftpPort || 17323;
  const username = config.jid.split('@')[0];
  
  try {
    await client.access({
      host: config.domain,
      port: ftpPort,
      user: username,
      password: config.password,
      secure: false
    });

    const fileList = await client.list();
    const names = fileList.map(f => f.name);
    client.close();
    return { ok: true, data: names };
  } catch (err: any) {
    client.close();
    return { ok: false, error: err.message };
  }
}

export async function ftpDelete(remoteName: string): Promise<FtpResult> {
  const config = loadXmppConfig();
  const client = new ftp.Client();
  const ftpPort = config.ftpPort || 17323;
  const username = config.jid.split('@')[0];
  
  try {
    await client.access({
      host: config.domain,
      port: ftpPort,
      user: username,
      password: config.password,
      secure: false
    });

    await client.remove(remoteName);
    client.close();
    return { ok: true };
  } catch (err: any) {
    client.close();
    return { ok: false, error: err.message };
  }
}

export function ftpHelp(): string {
  return `FTP commands:
  openclaw xmpp ftp upload <local-path> [remote-name]  - Upload file to FTP (overwrites existing)
  openclaw xmpp ftp download <remote-name> [local-path] - Download file from FTP
  openclaw xmpp ftp ls                                - List files in your folder
  openclaw xmpp ftp rm <remote-name>                  - Delete a file
  openclaw xmpp ftp help                              - Show this help

FTP Configuration:
  - Host: Same as XMPP domain
  - Port: 17323 (configurable via "ftpPort" in xmpp account config)
  - User: Your XMPP JID
  - Password: Same as XMPP password
  - Files are stored in your personal folder (JID-based isolation)

Examples:
  openclaw xmpp ftp upload C:\\Users\\kazak\\Documents\\report.pdf
  openclaw xmpp ftp upload C:\\Users\\kazak\\Documents\\report.pdf custom-name.pdf
  openclaw xmpp ftp download report.pdf
  openclaw xmpp ftp ls
  openclaw xmpp ftp rm old-file.pdf`;
}
