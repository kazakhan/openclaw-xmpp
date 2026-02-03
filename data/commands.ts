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



// Helper to call clawdbot message send via gateway
async function sendViaGateway(jid: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("cmd.exe", ["/c", "clawdbot", "message", "send", "--channel", "xmpp", "--target", jid, "--message", message], {
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
    .description("Start the ClawdBot gateway in background")
    .action(() => {
      console.log("Starting ClawdBot gateway...");

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
        console.log("Gateway should be ready. Try: clawdbot xmpp status");
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
        console.log("Start gateway with: clawdbot gateway");
        console.log("Or send messages directly: clawdbot xmpp msg user@domain.com \"Hello\"");
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
        console.log("Start gateway with: clawdbot gateway");
        return;
      }

      const actualNick = nick || "clawdbot";
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
  clawdbot xmpp vcard get - View current vCard
  clawdbot xmpp vcard set fn <value> - Set Full Name
  clawdbot xmpp vcard set nickname <value> - Set Nickname
  clawdbot xmpp vcard set url <value> - Set URL
  clawdbot xmpp vcard set desc <value> - Set Description
  clawdbot xmpp vcard set avatarUrl <value> - Set Avatar URL

Examples:
  clawdbot xmpp vcard get
  clawdbot xmpp vcard set fn "My Bot"
  clawdbot xmpp vcard set nickname "bot"
  clawdbot xmpp vcard set url "https://github.com/anomalyco/clawdbot"
  clawdbot xmpp vcard set desc "AI Assistant"

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
          console.log(`Use: clawdbot xmpp vcard set <field> <value>`);
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
        console.log('Use: clawdbot xmpp vcard help');
      }
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
