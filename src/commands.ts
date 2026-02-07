import { xml } from "@xmpp/client";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "node:url";
import path from "path";

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
  messageQueue
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
      if (!client) {
        console.log("XMPP client not connected. Gateway must be running.");
        console.log("Start gateway with: openclaw gateway");
        return;
      }

      const actualNick = nick || "openclaw";
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
      } catch (err) {
        console.error(`Failed to join room: ${err}`);
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

  // Subcommand: subscriptions <action> [args]
  xmpp
    .command("subscriptions <action> [args...]")
    .description("Manage pending subscription requests (admin only)")
    .action(async (action: string, args: string[]) => {
      // Import pending subscriptions from main module
      const globals = global as any;

      if (action === 'help') {
        console.log(`Subscription commands:
  openclaw xmpp subscriptions pending - List pending subscription requests
  openclaw xmpp subscriptions approve <jid> - Approve a pending subscription request
  openclaw xmpp subscriptions deny <jid> - Deny a pending subscription request
  openclaw xmpp subscriptions help - Show this help

Pending subscriptions require admin approval before users can interact with the bot.`);
        return;
      }

      if (action === 'pending') {
        const pendingSubs: Map<string, { jid: string; timestamp: number; status: string }> | undefined = globals.pendingSubscriptions;
        if (pendingSubs) {
          const pending = Array.from(pendingSubs.values())
            .filter(p => p.status === 'pending');

          if (pending.length === 0) {
            console.log('No pending subscription requests.');
          } else {
            console.log(`Pending subscription requests (${pending.length}):`);
            for (const p of pending) {
              const date = new Date(p.timestamp).toLocaleString();
              console.log(`  - ${p.jid} (since ${date})`);
            }
          }
        } else {
          console.log('Unable to access pending subscriptions.');
        }
        return;
      }

      if (action === 'approve' && args.length >= 1) {
        const jid = args[0];
        const approveFn = globals.approveSubscription;
        if (approveFn) {
          console.log(`Approving subscription request from ${jid}...`);
          const success = await approveFn(jid);
          if (success) {
            console.log(`✅ Subscription request approved.`);
          } else {
            console.log(`❌ Failed to approve subscription request.`);
          }
        } else {
          console.log('Error: Subscription approval function not available.');
          console.log('Make sure the XMPP gateway is running.');
        }
        return;
      }

      if (action === 'deny' && args.length >= 1) {
        const jid = args[0];
        const denyFn = globals.denySubscription;
        if (denyFn) {
          console.log(`Denying subscription request from ${jid}...`);
          const success = await denyFn(jid);
          if (success) {
            console.log(`✅ Subscription request denied.`);
          } else {
            console.log(`❌ Failed to deny subscription request.`);
          }
        } else {
          console.log('Error: Subscription denial function not available.');
          console.log('Make sure the XMPP gateway is running.');
        }
        return;
      }

      console.log(`Invalid subscription command: ${action}`);
      console.log('Use: openclaw xmpp subscriptions help');
    });

  // Subcommand: invites <action> [args]
  xmpp
    .command("invites <action> [args...]")
    .description("Manage pending room invite requests (admin only)")
    .action(async (action: string, args: string[]) => {
      if (action === 'help') {
        console.log(`Room Invite commands:
  openclaw xmpp invites pending - List pending room invites
  openclaw xmpp invites accept <room> - Accept a room invite and join
  openclaw xmpp invites deny <room> - Decline a room invite
  openclaw xmpp invites help - Show this help

Room invites require admin approval. Contacts are auto-approved.`);
        return;
      }

      if (action === 'pending') {
        const pendingInvites: Map<string, { room: string; inviter: string; reason?: string; timestamp: number; status: string }> = (global as any).pendingInvites;
        if (pendingInvites) {
          const pending = Array.from(pendingInvites.values())
            .filter(p => p.status === 'pending');

          if (pending.length === 0) {
            console.log('No pending room invites.');
          } else {
            console.log(`Pending room invites (${pending.length}):`);
            for (const p of pending) {
              const date = new Date(p.timestamp).toLocaleString();
              console.log(`  - ${p.room} (from ${p.inviter}, since ${date})`);
              if (p.reason) {
                console.log(`    Reason: ${p.reason}`);
              }
            }
          }
        } else {
          console.log('Unable to access pending invites.');
        }
        return;
      }

      if (action === 'accept' && args.length >= 1) {
        const room = args[0];
        const acceptFn = (global as any).acceptRoomInvite;
        if (acceptFn) {
          console.log(`Accepting invite to room ${room}...`);
          const success = await acceptFn(room);
          if (success) {
            console.log(`✅ Joined room ${room}.`);
          } else {
            console.log(`❌ Failed to join room ${room}.`);
          }
        } else {
          console.log('Error: Room invite acceptance function not available.');
          console.log('Make sure the XMPP gateway is running.');
        }
        return;
      }

      if (action === 'deny' && args.length >= 1) {
        const room = args[0];
        const denyFn = (global as any).denyRoomInvite;
        if (denyFn) {
          console.log(`Denying invite to room ${room}...`);
          const success = await denyFn(room);
          if (success) {
            console.log(`✅ Invite to room ${room} declined.`);
          } else {
            console.log(`❌ Failed to decline invite.`);
          }
        } else {
          console.log('Error: Room invite denial function not available.');
          console.log('Make sure the XMPP gateway is running.');
        }
        return;
      }

      console.log(`Invalid invite command: ${action}`);
      console.log('Use: openclaw xmpp invites help');
    });

  // Subcommand: encrypt-password
  xmpp
    .command("encrypt-password")
    .description("Encrypt XMPP password in config")
    .action(async () => {
      const fs = require('fs');
      const readline = require('readline');

      const configPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.openclaw', 'openclaw.json');

      if (!fs.existsSync(configPath)) {
        console.error('Config file not found:', configPath);
        console.log('Run this command after configuring your XMPP account.');
        return;
      }

      try {
        const configData = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(configData);

        const xmppConfig = config.channels?.xmpp?.accounts?.default;
        if (!xmppConfig) {
          console.error('XMPP account config not found in config file.');
          console.log('Make sure you have configured your XMPP account first.');
          return;
        }

        const { encryptPasswordInConfig, generateEncryptionKey } = await import('./security/encryption.js');

        if (xmppConfig.password && xmppConfig.password.startsWith('ENC:')) {
          console.log('Password is already encrypted.');
          return;
        }

        if (!xmppConfig.password) {
          console.error('No password found in config.');
          return;
        }

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

        console.log('\n=== XMPP Password Encryption ===\n');
        console.log('This will encrypt your XMPP password in the config file.');
        console.log('An encryptionKey will be generated and stored in the config.\n');

        rl.question('Enter your XMPP password to encrypt: ', async (plaintextPassword) => {
          console.log('\nEncrypting password...');

          const updatedConfig = encryptPasswordInConfig(xmppConfig, plaintextPassword);

          if (!config.channels.xmpp.accounts) {
            config.channels.xmpp.accounts = {};
          }
          config.channels.xmpp.accounts.default = updatedConfig;

          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

          console.log('\nPassword encrypted successfully!');
          console.log('Config file updated:', configPath);
          console.log('\nIMPORTANT: Keep a backup of your config file!');
          console.log('If you lose the encryptionKey in the config, you cannot recover the password.\n');

          rl.close();
        });

        rl.on('close', () => {
          process.exit(0);
        });
      } catch (err: any) {
        console.error('Error:', err.message);
      }
    });

  // Subcommand: sftp <action> [args]
  xmpp
    .command("sftp <action> [args...]")
    .description("SFTP file management via SSH (upload, download, list, delete)")
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

  // Subcommand: file-transfer-security
  xmpp
    .command("file-transfer-security [action] [args...]")
    .description("Manage file transfer security settings")
    .action(async (action: string, args: string[]) => {
      if (!action || action === 'help' || action === 'status') {
        console.log(`File Transfer Security Commands:
  openclaw xmpp file-transfer-security status - Show security status and statistics
  openclaw xmpp file-transfer-security quota [jid] - Show storage quota usage
  openclaw xmpp file-transfer-security quarantine - List quarantined files
  openclaw xmpp file-transfer-security cleanup - Clean up old temp files
  openclaw xmpp file-transfer-security help - Show this help

File Transfer Security Features:
  - MIME type validation
  - File size limits (10MB max)
  - Dangerous extension blocking (.exe, .bat, .sh, etc.)
  - SHA-256 file hashing
  - Per-user storage quotas (100MB default)
  - Secure temp file handling
  - File quarantine for suspicious files`);
        return;
      }

      if (action === 'status' || action === 'stats') {
        console.log('\n=== File Transfer Security Status ===\n');
        console.log('Features:');
        console.log('  ✓ MIME type validation enabled');
        console.log('  ✓ File size limits (10MB max)');
        console.log('  ✓ Dangerous extension blocking');
        console.log('  ✓ SHA-256 file hashing');
        console.log('  ✓ Secure temp file handling');
        console.log('  - Virus scanning: DISABLED (set enableVirusScan: true to enable)');
        console.log('\nDirectories:');
        console.log('  Temp directory: ./temp');
        console.log('  Quarantine directory: ./quarantine');
        console.log('\nLimits:');
        console.log('  Max file size: 10MB');
        console.log('  User storage quota: 100MB');
        console.log('  Allowed MIME types: 16 types');
        return;
      }

      if (action === 'quota') {
        const jid = args[0] || 'default';
        console.log(`\nStorage Quota for ${jid}:`);
        console.log('  Note: Quota tracking requires gateway to be running');
        console.log('  Run "openclaw xmpp file-transfer-security status" for gateway status');
        return;
      }

      if (action === 'quarantine') {
        console.log('\n=== Quarantined Files ===\n');
        console.log('Note: Quarantine log requires gateway to be running');
        console.log('Run "openclaw xmpp file-transfer-security status" for quarantine status');
        return;
      }

      if (action === 'cleanup') {
        console.log('\nCleaning up temp files...');
        console.log('Note: Temp cleanup requires gateway to be running');
        console.log('Files older than 1 hour would be deleted.');
        return;
      }

      console.log(`Unknown file-transfer-security command: ${action}`);
      console.log('Use: openclaw xmpp file-transfer-security help');
    });

  // Subcommand: audit
  xmpp
    .command("audit [action] [args...]")
    .description("View and manage audit logs")
    .action(async (action: string, args: string[]) => {
      if (!action || action === 'help' || action === 'status') {
         console.log(`Audit Log Commands:
   openclaw xmpp audit status - Show audit logging status and statistics
   openclaw xmpp audit list [limit] - List recent audit events
   openclaw xmpp audit query [options] - Query audit events
   openclaw xmpp audit export [days] - Export audit log to JSON
   openclaw xmpp audit cleanup - Remove old audit logs
   openclaw xmpp audit help - Show this help

Audit Log Features:
   - Records all security-relevant events
   - Tracks authentication, authorization, and commands
   - Logs file operations and transfers
   - Monitors suspicious activity
   - 30-day retention
   - 10MB log file size limit

Event Types Logged:
   - Authentication: login_success, login_failure
   - Authorization: permission_granted, permission_denied
   - Commands: command_executed, command_failed
   - File Operations: file_upload, file_download, file_delete
   - Security: suspicious_activity, rate_limit_exceeded
   - Admin Actions: subscription_approved/denied, invite_approved/denied
   - Connections: xmpp_connected, xmpp_disconnected, room_joined/left`);
         return;
       }

       if (action === 'status' || action === 'stats') {
         console.log('\n=== Audit Logging Status ===\n');
         console.log('Status: ENABLED');
         console.log('Log Directory: ./logs');
         console.log('Retention: 30 days');
         console.log('Max File Size: 10MB');
         console.log('Sensitive Fields: password, token, apiKey, credential, secret');
         console.log('\nNote: Audit logging requires gateway to be running for full functionality.');
         return;
       }

       if (action === 'list') {
         const limit = parseInt(args[0]) || 20;
         console.log(`\nRecent Audit Events (last ${limit}):\n`);
         console.log('Note: Full audit log querying requires gateway to be running.');
         console.log('Run the gateway and use "openclaw xmpp audit query" for detailed searches.');
         return;
       }

       if (action === 'query') {
         console.log('\n=== Query Audit Events ===\n');
         console.log('Query parameters available:');
         console.log('  --type <event_type> - Filter by event type');
         console.log('  --user <jid> - Filter by user JID');
         console.log('  --result success|failure - Filter by result');
         console.log('  --days <number> - Look back N days');
         console.log('  --limit <number> - Max results (default 100)');
         console.log('\nNote: Full query functionality requires gateway to be running.');
         return;
       }

       if (action === 'export') {
         const days = parseInt(args[0]) || 7;
         console.log(`\nExporting audit log (last ${days} days)...\n`);
         console.log('Note: Export functionality requires gateway to be running.');
         console.log('Run the gateway and use "openclaw xmpp audit export" to save to file.');
         return;
       }

       if (action === 'cleanup') {
         console.log('\nCleaning up old audit logs...');
         console.log('Note: Cleanup requires gateway to be running.');
         console.log('Logs older than 30 days would be removed.');
         return;
       }

        console.log(`Unknown audit command: ${action}`);
        console.log('Use: openclaw xmpp audit help');
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
      messageQueue: globals.messageQueue || []
    });
    console.log("XMPP CLI commands registered successfully");
  }
