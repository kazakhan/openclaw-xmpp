import { xml } from "@xmpp/client";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "node:url";
import path from "path";
import { joinRoom, leaveRoom, getJoinedRooms } from "./gateway-client.js";

// Simple roster functions without fs-extra
let roster: Record<string, { nick?: string }> = {};

function getRoster() {
  return roster;
}

function setNick(jid: string, nick: string) {
  roster[jid] = { nick };
}

async function saveRoster() {
  console.log("Roster saved (in-memory only)");
}



// Helper to call openclaw message send via gateway
async function sendViaGateway(jid: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("cmd.exe", ["/c", "openclaw", "message", "send", "--channel", "xmpp", "--target", jid, "--message", message], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`Message sent to ${jid}`);
        resolve(true);
      } else {
        console.error(`Failed to send message: ${stderr || stdout}`);
        resolve(false);
      }
    });

    proc.on('error', (err) => {
      console.error(`Failed to send message: ${err}`);
      resolve(false);
    });
  });
}

// Main CLI registration function following Commander.js pattern
export function registerXmppCli({
  program,
  getXmppClient,
  logger,
  getUnprocessedMessages,
  clearOldMessages,
  messageQueue,
  getContacts
}: any) {
  const xmpp = program
    .command("xmpp")
    .description("XMPP channel plugin commands");

  // Subcommand: start - Start the gateway in background
  xmpp
    .command("start")
    .description("Start the OpenClaw gateway in background")
    .action(() => {
      console.log("Starting OpenClaw gateway...");

      const gatewayProcess = spawn(process.execPath, [process.argv[0], "gateway"], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: { ...process.env }
      });

      gatewayProcess.unref();

      console.log("Gateway starting in background (pid:", gatewayProcess.pid + ")");
      console.log("Waiting for gateway to initialize...");
      setTimeout(() => {
        console.log("Gateway should be ready. Try: openclaw xmpp status");
      }, 3000);
    });

  // Subcommand: status
  xmpp
    .command("status")
    .description("Show XMPP connection status")
    .action(() => {
      const client = getXmppClient();
      if (client) {
        console.log(client.status || "Connected (no status available)");
      } else {
        console.log("XMPP client not connected. Gateway must be running.");
        console.log("Start gateway with: openclaw gateway");
        console.log("Or send messages directly: openclaw xmpp msg user@domain.com \"Hello\"");
      }
    });

  // Subcommand: msg <jid> <message> - routes through gateway
  xmpp
    .command("msg <jid> <message...>")
    .description("Send direct XMPP message (routes through gateway)")
    .action(async (jid: string, messageParts: string[]) => {
      const message = messageParts.join(" ");

      // Try to get direct client first (if gateway is running in same process)
      const client = getXmppClient();
      if (client) {
        try {
          await client.send(
            xml("message", { to: jid, type: "chat" },
              xml("body", {}, message)
            )
          );
          console.log(`Message sent to ${jid}`);
          return;
        } catch (err) {
          console.log("Direct send failed, trying via gateway...");
        }
      }

      // Route through gateway CLI
      await sendViaGateway(jid, message);
    });

  // Subcommand: roster
  xmpp
    .command("roster")
    .description("Show roster (in-memory)")
    .action(() => {
      const rosterData = getRoster();
      if (Object.keys(rosterData).length === 0) {
        console.log("No roster entries (in-memory only)");
      } else {
        console.log("Roster (in-memory):");
        Object.entries(rosterData).forEach(([jid, data]) => {
          console.log(`  ${jid}: ${data.nick || 'no nick'}`);
        });
      }
    });

  // Subcommand: nick <jid> <name>
  xmpp
    .command("nick <jid> <name>")
    .description("Set roster nickname (in-memory)")
    .action(async (jid: string, name: string) => {
      setNick(jid, name);
      await saveRoster();
      console.log(`Nickname set for ${jid}: ${name}`);
    });

  // Subcommand: join <room> [nick]
  xmpp
    .command("join <room> [nick]")
    .description("Join MUC room")
    .action(async (room: string, nick?: string) => {
      const client = getXmppClient();
      const actualNick = nick || "openclaw";

      if (client) {
        try {
          if (client.joinRoom) {
            await client.joinRoom(room, actualNick);
          } else {
            await client.send(
              xml("presence", {
                to: `${room}/${actualNick}`
              })
            );
          }
          console.log(`Joined room: ${room} as ${actualNick}`);
          return;
        } catch (err) {
          console.log("Direct join failed, trying via gateway RPC...");
        }
      }

      const success = await joinRoom(room, actualNick);
      if (!success) {
        console.error("Failed to join room: Gateway not running or XMPP client unavailable");
        console.error("Make sure the OpenClaw gateway is running with: openclaw gateway");
        process.exit(1);
      }
    });

  // Subcommand: rooms
  xmpp
    .command("rooms")
    .description("List joined MUC rooms")
    .action(async () => {
      const rooms = await getJoinedRooms();
      if (rooms.length === 0) {
        console.log("Not currently joined to any rooms.");
        console.log("Use: openclaw xmpp join <room> [nick]");
      } else {
        console.log(`Currently joined to ${rooms.length} room(s):`);
        rooms.forEach(r => {
          console.log(`  ${r.room} as ${r.nick || '(unknown nick)'}`);
        });
      }
    });

  // Subcommand: leave <room>
  xmpp
    .command("leave <room>")
    .description("Leave MUC room")
    .action(async (room: string) => {
      const success = await leaveRoom(room);
      if (success) {
        console.log(`Left room: ${room}`);
      } else {
        console.error("Failed to leave room");
        process.exit(1);
      }
    });

  // Subcommand: poll
  xmpp
    .command("poll")
    .description("Poll queued messages")
    .action(() => {
      const unprocessed = getUnprocessedMessages();
      if (unprocessed.length === 0) {
        console.log("No unprocessed messages in queue");
      } else {
        console.log(`Found ${unprocessed.length} unprocessed messages:`);
        unprocessed.forEach((msg, i) => {
          console.log(`${i+1}. [${msg.accountId}] ${msg.from}: ${msg.body}`);
        });
      }
    });

  // Subcommand: clear
  xmpp
    .command("clear")
    .description("Clear old messages from queue")
    .action(() => {
      const oldCount = messageQueue.length;
      clearOldMessages();
      console.log(`Cleared ${oldCount - messageQueue.length} old messages`);
    });

  // Subcommand: add <jid> [name]
  xmpp
    .command("add <jid> [name]")
    .description("Add contact to whitelist (required for bot responses)")
    .action(async (jid: string, name?: string) => {
      // Basic JID validation
      if (!jid || !jid.includes('@')) {
        console.error("Invalid JID format. Expected: user@domain.com");
        console.error("Usage: openclaw xmpp add <jid> [name]");
        return;
      }

      try {
        const contacts = getContacts?.();
        if (contacts?.add) {
          const success = contacts.add(jid, name);
          if (success) {
            const displayName = name || jid.split('@')[0];
            console.log(`✓ Contact added: ${jid}`);
            console.log(`  Name: ${displayName}`);
            console.log(`  Note: Bot will only respond to whitelisted contacts`);
          } else {
            console.error("Failed to add contact");
          }
        } else {
          // Fallback: direct Contacts class instantiation
          const path = await import('path');
          const fs = await import('fs');
          const dataDir = process.env.OPENCLAW_DATA || path.join(process.cwd(), 'data');
          
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }
          
          const { Contacts } = await import('./contacts.js');
          const contactsInstance = new Contacts(dataDir);
          
          if (contactsInstance.exists(jid)) {
            console.log(`Contact already exists: ${jid}`);
            const existingName = contactsInstance.getName(jid);
            if (existingName) {
              console.log(`  Current name: ${existingName}`);
            }
          } else {
            contactsInstance.add(jid, name);
            const displayName = name || jid.split('@')[0];
            console.log(`✓ Contact added: ${jid}`);
            console.log(`  Name: ${displayName}`);
            console.log(`  Note: Bot will only respond to whitelisted contacts`);
          }
        }
      } catch (err: any) {
        console.error(`Error adding contact: ${err.message}`);
      }
    });

  // Subcommand: contacts
  xmpp
    .command("contacts")
    .description("List whitelisted contacts")
    .action(async () => {
      try {
        const contacts = getContacts?.();
        if (contacts?.list) {
          const contactList = contacts.list();
          if (contactList.length === 0) {
            console.log("No contacts in whitelist");
            console.log("Add contacts with: openclaw xmpp add <jid> [name]");
          } else {
            console.log(`Whitelisted contacts (${contactList.length}):`);
            contactList.forEach((c: any) => {
              console.log(`  ${c.jid}: ${c.name || '(no name)'}`);
            });
          }
        } else {
          // Fallback: direct Contacts class instantiation
          const path = await import('path');
          const fs = await import('fs');
          const dataDir = process.env.OPENCLAW_DATA || path.join(process.cwd(), 'data');
          
          if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
          }
          
          const { Contacts } = await import('./contacts.js');
          const contactsInstance = new Contacts(dataDir);
          const contactList = contactsInstance.list();
          
          if (contactList.length === 0) {
            console.log("No contacts in whitelist");
            console.log("Add contacts with: openclaw xmpp add <jid> [name]");
          } else {
            console.log(`Whitelisted contacts (${contactList.length}):`);
            contactList.forEach((c: any) => {
              console.log(`  ${c.jid}: ${c.name || '(no name)'}`);
            });
          }
        }
      } catch (err: any) {
        console.error(`Error listing contacts: ${err.message}`);
      }
    });

  // Subcommand: queue
  xmpp
    .command("queue")
    .description("Show message queue status")
    .action(() => {
      console.log(`Message queue: ${messageQueue.length} total, ${getUnprocessedMessages().length} unprocessed`);
      messageQueue.slice(0, 5).forEach((msg, i) => {
        console.log(`${i+1}. ${msg.processed ? '✓' : '✗'} [${msg.accountId}] ${msg.from}: ${msg.body.substring(0, 50)}${msg.body.length > 50 ? '...' : ''}`);
      });
    });

  // Subcommand: vcard <action> [args]
  xmpp
    .command("vcard <action> [args...]")
    .description("Manage vCard profile")
    .action(async (action: string, args: string[]) => {
      if (action === 'help') {
        console.log(`vCard commands:
  openclaw xmpp vcard get - View current vCard
  openclaw xmpp vcard set fn <value> - Set Full Name
  openclaw xmpp vcard set nickname <value> - Set Nickname
  openclaw xmpp vcard set url <value> - Set URL
  openclaw xmpp vcard set desc <value> - Set Description
  openclaw xmpp vcard set avatarUrl <value> - Set Avatar URL

Examples:
  openclaw xmpp vcard get
  openclaw xmpp vcard set fn "My Bot"
  openclaw xmpp vcard set nickname "bot"
  openclaw xmpp vcard set url "https://github.com/anomalyco/openclaw"
  openclaw xmpp vcard set desc "AI Assistant"

Note: Commands connect directly to XMPP server.`);
      } else if (action === 'get') {
        try {
          const { getVCard } = await import('./vcard-cli.js');
          const result = await getVCard();
          if (result.ok && result.data) {
            console.log('Current vCard:');
            console.log(`  FN: ${result.data.fn || '(not set)'}`);
            console.log(`  Nickname: ${result.data.nickname || '(not set)'}`);
            console.log(`  URL: ${result.data.url || '(not set)'}`);
            console.log(`  Desc: ${result.data.desc || '(not set)'}`);
            console.log(`  Avatar URL: ${result.data.avatarUrl || '(not set)'}`);
          } else {
            console.log('Failed to get vCard:', result.error || 'Unknown error');
          }
        } catch (err: any) {
          console.log('Failed to get vCard:', err.message);
        }
      } else if (action === 'set' && args.length >= 1) {
        const field = args[0];
        const value = args.slice(1).join(' ');
        const validFields = ['fn', 'nickname', 'url', 'desc', 'avatarUrl'];

        if (!validFields.includes(field)) {
          console.log(`Invalid field: ${field}`);
          console.log(`Valid fields: ${validFields.join(', ')}`);
          console.log(`Use: openclaw xmpp vcard set <field> <value>`);
          return;
        }

        if (!value) {
          console.log(`Missing value for ${field}`);
          return;
        }

        try {
          const { setVCard } = await import('./vcard-cli.js');
          const result = await setVCard(field, value);
          if (result.ok) {
            console.log(`vCard field '${field}' updated successfully`);
          } else {
            console.log('Failed to update vCard:', result.error || 'Unknown error');
          }
        } catch (err: any) {
          console.log('Failed to update vCard:', err.message);
        }
      } else {
        console.log('Invalid vCard command');
        console.log('Use: openclaw xmpp vcard help');
      }
    });

  // Subcommand: sftp <action> [args]
  xmpp
    .command("sftp <action> [args...]")
    .description("SFTP file management (upload, download, list, delete)")
    .action(async (action: string, args: string[]) => {
      const { sftpUpload, sftpDownload, sftpList, sftpDelete, sftpHelp } = await import('./sftp.js');

      if (action === 'help') {
        console.log(sftpHelp());
        return;
      }

      if (action === 'upload' && args.length >= 1) {
        const localPath = args[0];
        const remoteName = args[1];
        console.log(`Uploading ${localPath}...`);
        const result = await sftpUpload(localPath, remoteName);
        if (result.ok) {
          console.log(`Uploaded: ${result.data}`);
        } else {
          console.error(`Upload failed: ${result.error}`);
        }
        return;
      }

      if (action === 'download' && args.length >= 1) {
        const remoteName = args[0];
        const localPath = args[1];
        console.log(`Downloading ${remoteName}...`);
        const result = await sftpDownload(remoteName, localPath);
        if (result.ok) {
          console.log(`Downloaded: ${result.data}`);
        } else {
          console.error(`Download failed: ${result.error}`);
        }
        return;
      }

      if (action === 'ls') {
        console.log('Listing files...');
        const result = await sftpList();
        if (result.ok && result.data) {
          if (result.data.length === 0) {
            console.log('No files in your folder');
          } else {
            result.data.forEach(f => console.log(`  ${f}`));
          }
        } else {
          console.error(`List failed: ${result.error}`);
        }
        return;
      }

      if (action === 'rm' && args.length >= 1) {
        const remoteName = args[0];
        console.log(`Deleting ${remoteName}...`);
        const result = await sftpDelete(remoteName);
        if (result.ok) {
          console.log('Deleted successfully');
        } else {
          console.error(`Delete failed: ${result.error}`);
        }
        return;
      }

      console.log(`Invalid SFTP command: ${action}`);
      console.log('Use: openclaw xmpp sftp help');
    });

  // Subcommand: encrypt-password
  xmpp
    .command("encrypt-password")
    .description("Encrypt password in config file")
    .action(async () => {
      const { encryptPasswordInConfig } = await import('./security/encryption.js');
      const fs = await import('fs');
      const path = await import('path');

      const configPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');
      let config: any = {};

      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
          console.error('Failed to read config file:', e);
          return;
        }
      } else {
        console.error('Config file not found:', configPath);
        return;
      }

      if (!config.channels?.xmpp?.accounts?.default) {
        console.error('XMPP account config not found at channels.xmpp.accounts.default');
        return;
      }

      console.log('Enter plaintext password (hidden): ');
      
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question('', (password: string) => {
        rl.close();
        if (!password) {
          console.error('Password cannot be empty');
          return;
        }

        const updatedXmppConfig = encryptPasswordInConfig(config.channels.xmpp.accounts.default, password);
        config.channels.xmpp.accounts.default = updatedXmppConfig;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('Password encrypted successfully!');
        console.log(`Config file: ${configPath}`);
        console.log('Updated fields: encryptionKey, password (ENC:...)');
      });
    });

}

// Legacy function for backward compatibility - now delegates to registerXmppCli
export function registerCommands(api: any, dataPath: string) {
  console.log("Registering XMPP CLI commands via registerCommands (legacy)");
  
  // Access globals from main module
  const globals = global as any;
  
  registerXmppCli({
    program: api.program,
    getXmppClient: () => {
      if (globals.xmppClients) {
        const clients = Array.from(globals.xmppClients.values());
        return clients.length > 0 ? clients[0] : null;
      }
      return null;
    },
    logger: console,
    getUnprocessedMessages: () => {
      return globals.getUnprocessedMessages ? globals.getUnprocessedMessages() : [];
    },
    clearOldMessages: () => {
      if (globals.clearOldMessages) globals.clearOldMessages();
    },
    messageQueue: globals.messageQueue || [],
    getContacts: () => globals.contactsStore?.get("default") || globals.contactsStore?.values().next().value || null
  });
  console.log("XMPP CLI commands registered successfully");
}
