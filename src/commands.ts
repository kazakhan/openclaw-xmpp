import { xml } from "@xmpp/client";
import { spawn } from "child_process";
import { joinRoom, leaveRoom, getJoinedRooms, inviteToRoom, removeContact } from "./gateway-client.js";
import { getContactsInstance } from "./lib/contact-factory.js";
import { RosterStore } from "./roster-store.js";

// Type for the spawn function so tests can inject a mock.  In production
// this defaults to the real `child_process.spawn`.
export type SpawnFn = (
  command: string,
  args: string[],
  options: {
    detached: boolean;
    stdio: "ignore" | "pipe" | "inherit";
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  }
) => { pid?: number; unref: () => void; on: (event: string, cb: (err: Error) => void) => void };

let _spawnOverride: SpawnFn | null = null;
export function _setSpawnForTests(fn: SpawnFn | null): void { _spawnOverride = fn; }

/**
 * Start the OpenClaw gateway as a detached background process.
 *
 * SECURITY (2.0.15): the previous version called
 *   spawn(process.execPath, [process.argv[0], "gateway"], …)
 * which translates to `node.exe node.exe gateway …` because
 * `process.execPath` is the path to the Node.js binary and
 * `process.argv[0]` is the same binary.  The second `node.exe` was
 * interpreted as a script name, which fails at startup.
 *
 * The new implementation spawns the `openclaw` CLI directly, with a
 * `cmd.exe /c` wrapper on Windows so that PATH lookup works.  The
 * function returns a result object (rather than throwing) so that
 * the caller (the CLI action handler) can print a clean error and
 * exit with a non-zero code if the spawn fails (e.g. `openclaw`
 * not on PATH).
 */
export function startGateway(): { ok: true; pid?: number } | { ok: false; error: string } {
  const isWin = process.platform === "win32";
  const command = isWin ? "cmd.exe" : "openclaw";
  const args = isWin ? ["/c", "openclaw", "gateway"] : ["gateway"];

  const spawnOptions = {
    detached: true,
    stdio: "ignore" as const,
    cwd: process.cwd(),
    env: { ...process.env },
    ...(isWin ? { windowsHide: true } : {}),
  };

  const doSpawn = _spawnOverride ?? (spawn as unknown as SpawnFn);
  try {
    const gatewayProcess = doSpawn(command, args, spawnOptions);
    gatewayProcess.unref();
    return { ok: true, pid: gatewayProcess.pid };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// SECURITY (2.0.17, M8): roster is now persisted to
// `<dataDir>/xmpp-roster.json` via the `RosterStore` helper
// (src/roster-store.ts).  The previous in-memory-only implementation
// silently lost every `xmpp nick` invocation on restart.

function getRosterStore(dataDir: string): RosterStore {
  return new RosterStore(dataDir);
}

// SECURITY (2.0.18, L12): extract the JID-shape check that
// previously appeared inline at multiple subcommand sites.  The
// check is intentionally permissive (just `jid.includes('@')`)
// because some valid JIDs in this codebase use resource parts and
// the validation is purely a "looks like a JID" sanity check, not
// a full RFC-6122 parse.  For strict validation, callers can also
// use `validators.isValidJid(jid)` from `src/security/validation.ts`.
function requireJid(jid: string | undefined, usage: string): boolean {
  if (!jid || !jid.includes('@')) {
    console.error(`Invalid JID. ${usage}`);
    return false;
  }
  return true;
}



// Helper to send XMPP message via gateway RPC instead of openclaw message send
// This bypasses the CLI plugin loading issue
async function sendViaGatewayRpc(jid: string, message: string): Promise<boolean> {
  const { callGatewayRpc } = await import("./gateway-client.js");
  
  try {
    const result = await callGatewayRpc<{ ok: boolean; error?: string }>("xmpp.sendMessage", { jid, message });
    if (result?.ok) {
      console.log(`Message sent to ${jid}`);
      return true;
    } else {
      console.error(`Failed to send message: ${result?.error || 'Unknown error'}`);
      return false;
    }
  } catch (err: any) {
    console.error(`Failed to send message: ${err.message || String(err)}`);
    return false;
  }
}

// Helper to call openclaw message send via gateway (deprecated - use sendViaGatewayRpc)
async function sendViaGateway(jid: string, message: string): Promise<boolean> {
  return sendViaGatewayRpc(jid, message);
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

      const result = startGateway();
      if (result.ok === false) {
        console.error(`Failed to start gateway: ${result.error}`);
        process.exit(1);
      }

      console.log("Gateway starting in background (pid:", (result.pid ?? "unknown") + ")");
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
    .description("Show roster (persisted to <dataDir>/xmpp-roster.json)")
    .action(async () => {
      const dataDir = process.env.OPENCLAW_DATA_DIR || process.cwd();
      const store = getRosterStore(dataDir);
      const entries = await store.list();
      if (entries.length === 0) {
        console.log("No roster entries");
      } else {
        console.log("Roster:");
        for (const entry of entries) {
          console.log(`  ${entry.jid}: ${entry.nick}`);
        }
      }
    });

  // Subcommand: nick <jid> <name>
  xmpp
    .command("nick <jid> <name>")
    .description("Set roster nickname (persisted)")
    .action(async (jid: string, name: string) => {
      const dataDir = process.env.OPENCLAW_DATA_DIR || process.cwd();
      const store = getRosterStore(dataDir);
      await store.setNick(jid, name);
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
      // Basic JID validation (L12)
      if (!requireJid(jid, "Usage: openclaw xmpp add <jid> [name]")) return;

      try {
        const contacts = getContacts?.();
        if (contacts?.add) {
          const success = await contacts.add(jid, name);
          if (success) {
            const displayName = name || jid.split('@')[0];
            console.log(`✓ Contact added: ${jid}`);
            console.log(`  Name: ${displayName}`);
            console.log(`  Note: Bot will only respond to whitelisted contacts`);
          } else {
            console.error("Failed to add contact");
          }
        } else {
          const contactsInstance = await getContactsInstance();
          
          if (await contactsInstance.exists(jid)) {
            console.log(`Contact already exists: ${jid}`);
            const existingName = await contactsInstance.getName(jid);
            if (existingName) {
              console.log(`  Current name: ${existingName}`);
            }
          } else {
            await contactsInstance.add(jid, name);
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

  // Subcommand: remove <jid>
  xmpp
    .command("remove <jid>")
    .description("Remove contact from whitelist")
    .action(async (jid: string) => {
      // Basic JID validation (L12)
      if (!requireJid(jid, "Usage: openclaw xmpp remove <jid>")) return;

      try {
        const contacts = getContacts?.();
        if (contacts?.remove) {
          const removed = await contacts.remove(jid);
          if (removed) {
            console.log(`✓ Contact removed: ${jid}`);
          } else {
            console.error("Contact not found in whitelist");
          }
        } else {
          const contactsInstance = await getContactsInstance();
          
          const removed = await contactsInstance.remove(jid);
          if (removed) {
            console.log(`✓ Contact removed: ${jid}`);
          } else {
            console.error("Contact not found in whitelist");
          }
        }
      } catch (err: any) {
        console.error(`Error removing contact: ${err.message}`);
      }
    });

  // Subcommand: invite <contact> <room> [reason] [--password <password>]
  xmpp
    .command("invite <contact> <room> [reason]")
    .description("Invite contact to MUC room via direct invitation")
    .option("--password <password>", "Room password (optional)")
    .action(async (contact: string, room: string, reason: string | undefined, options: { password?: string }) => {
      if (!contact || !contact.includes('@')) {
        console.error("Invalid contact JID format. Expected: user@domain.com");
        console.error("Usage: openclaw xmpp invite <contact> <room> [reason] [--password <password>]");
        return;
      }

      const password = options.password;

      // Try direct client first
      const client = getXmppClient();
      if (client && client.inviteToRoom) {
        try {
          await client.inviteToRoom(contact, room, reason, password);
          console.log(`Invite sent to ${contact} for room ${room}`);
          return;
        } catch (err) {
          console.log("Direct send failed, trying via gateway...");
        }
      }

      // Fall back to gateway RPC
      const success = await inviteToRoom(contact, room, reason);
      if (!success) {
        console.error("Failed to invite contact. Make sure the gateway is running.");
        process.exit(1);
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
          const contactList = await contacts.list();
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
          const contactsInstance = await getContactsInstance();
          const contactList = await contactsInstance.list();
          
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
  openclaw xmpp vcard set avatar <url-or-path> - Upload image as avatar
  openclaw xmpp vcard set birthday <YYYY-MM-DD> - Set Birthday
  openclaw xmpp vcard set title <value> - Set Job Title
  openclaw xmpp vcard set role <value> - Set Job Role
  openclaw xmpp vcard set timezone <value> - Set Timezone
  openclaw xmpp vcard name <family> <given> [middle] [prefix] [suffix] - Set structured name
  openclaw xmpp vcard phone add <number> [type...] - Add phone (types: home work voice fax cell video pager msg)
  openclaw xmpp vcard phone remove <index> - Remove phone by index
  openclaw xmpp vcard email add <address> [type...] - Add email (types: home work internet pref)
  openclaw xmpp vcard email remove <index> - Remove email by index
  openclaw xmpp vcard address add <street> <city> <region> <postal> <country> [type...] - Add address (types: home work postal parcel)
  openclaw xmpp vcard address remove <index> - Remove address by index
  openclaw xmpp vcard org <orgname> [orgunit...] - Set organization

Examples:
  openclaw xmpp vcard get
  openclaw xmpp vcard set fn "My Bot"
  openclaw xmpp vcard set nickname "bot"
  openclaw xmpp vcard set birthday "1990-05-15"
  openclaw xmpp vcard set title "Software Engineer"
  openclaw xmpp vcard name "Smith" "John" "David" "Mr." "III"
  openclaw xmpp vcard phone add "+1234567890" cell
  openclaw xmpp vcard phone add "+0987654321" work voice
  openclaw xmpp vcard email add "john@example.com" home
  openclaw xmpp vcard email add "work@example.com" work pref
  openclaw xmpp vcard address add "123 Main St" "Boston" "MA" "02101" "USA" home
  openclaw xmpp vcard org "Acme Inc" "Engineering"
  openclaw xmpp vcard set avatar https://example.com/avatar.png

Note: Commands connect directly to XMPP server.`);
      } else if (action === 'get') {
        try {
          const { getVCard } = await import('./vcard-cli.js');
          const result = await getVCard();
          if (result.ok && result.data) {
            console.log('Current vCard:');
            console.log(`  FN: ${result.data.fn || '(not set)'}`);

            // Structured Name (N)
            if (result.data.n) {
              const n = result.data.n;
              const nameParts = [n.prefix, n.given, n.middle, n.family, n.suffix].filter(Boolean);
              console.log(`  Name: ${nameParts.join(' ') || '(not set)'}`);
            }

            console.log(`  Nickname: ${result.data.nickname || '(not set)'}`);
            console.log(`  Birthday: ${result.data.bday || '(not set)'}`);
            console.log(`  Title: ${result.data.title || '(not set)'}`);
            console.log(`  Role: ${result.data.role || '(not set)'}`);
            console.log(`  Timezone: ${result.data.tz || '(not set)'}`);
            console.log(`  URL: ${result.data.url || '(not set)'}`);
            console.log(`  Desc: ${result.data.desc || '(not set)'}`);
            console.log(`  Avatar URL: ${result.data.avatarUrl || '(not set)'}`);

            // Phone numbers (multi-value)
            if (result.data.tel && result.data.tel.length > 0) {
              result.data.tel.forEach((phone, idx) => {
                console.log(`  Phone ${idx + 1}: ${phone.number} (${phone.types.join(', ') || 'default'})`);
              });
            }

            // Emails (multi-value)
            if (result.data.email && result.data.email.length > 0) {
              result.data.email.forEach((email, idx) => {
                console.log(`  Email ${idx + 1}: ${email.userid} (${email.types.join(', ') || 'default'})`);
              });
            }

            // Addresses (multi-value)
            if (result.data.adr && result.data.adr.length > 0) {
              result.data.adr.forEach((adr, idx) => {
                const parts = [adr.street, adr.locality, adr.region, adr.pcode, adr.ctry].filter(Boolean);
                console.log(`  Address ${idx + 1}: ${parts.join(', ')} (${adr.types.join(', ') || 'default'})`);
              });
            }

            // Organization
            if (result.data.org) {
              const orgStr = result.data.org.orgname + (result.data.org.orgunit ? ' (' + result.data.org.orgunit.join(', ') + ')' : '');
              console.log(`  Organization: ${orgStr || '(not set)'}`);
            }
          } else {
            console.log('Failed to get vCard:', result.error || 'Unknown error');
          }
        } catch (err: any) {
          console.log('Failed to get vCard:', err.message);
        }
      } else if (action === 'set' && args.length >= 1) {
        const field = args[0];
        const value = args.slice(1).join(' ');
        const validFields = ['fn', 'nickname', 'url', 'desc', 'avatar', 'birthday', 'title', 'role', 'timezone'];

        if (!validFields.includes(field)) {
          console.log(`Invalid field: ${field}`);
          console.log(`Valid fields: ${validFields.join(', ')}`);
          console.log(`Use: openclaw xmpp vcard set <field> <value>`);
          return;
        }

        // Handle avatar upload specially
        if (field === 'avatar') {
          if (!value) {
            console.log(`Missing value for ${field}`);
            console.log(`Usage: openclaw xmpp vcard set avatar <url-or-path>`);
            console.log(`Example: openclaw xmpp vcard set avatar https://example.com/image.png`);
            console.log(`Example: openclaw xmpp vcard set avatar C:\\Users\\me\\avatar.png`);
            return;
          }

          try {
            const { setVCardAvatar } = await import('./vcard-cli.js');
            const result = await setVCardAvatar(value);
            if (result.ok) {
              console.log(`Avatar updated successfully!`);
              console.log(`URL: ${result.url}`);
            } else {
              console.log('Failed to update avatar:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to update avatar:', err.message);
          }
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
      } else if (action === 'name' && args.length >= 2) {
        // openclaw xmpp vcard name <family> <given> [middle] [prefix] [suffix]
        const family = args[0];
        const given = args[1];
        const middle = args[2];
        const prefix = args[3];
        const suffix = args[4];

        try {
          const { setVCardName } = await import('./vcard-cli.js');
          const result = await setVCardName(family, given, middle, prefix, suffix);
          if (result.ok) {
            console.log(`vCard name updated: ${prefix || ''} ${given} ${middle || ''} ${family} ${suffix || ''}`.replace(/\s+/g, ' ').trim());
          } else {
            console.log('Failed to update vCard name:', result.error || 'Unknown error');
          }
        } catch (err: any) {
          console.log('Failed to update vCard name:', err.message);
        }
      } else if (action === 'phone' && args.length >= 2) {
        // openclaw xmpp vcard phone add <number> [type...]
        // openclaw xmpp vcard phone remove <index>
        const subaction = args[0];

        if (subaction === 'add' && args.length >= 2) {
          const number = args[1];
          const types: string[] = [];
          for (let i = 2; i < args.length; i++) {
            const arg = args[i].toLowerCase();
            if (['home', 'work', 'voice', 'fax', 'cell', 'video', 'pager', 'msg'].includes(arg)) {
              types.push(arg.toUpperCase());
            }
          }

          try {
            const { addVCardPhone } = await import('./vcard-cli.js');
            const result = await addVCardPhone(types, number);
            if (result.ok) {
              console.log(`vCard phone added: ${number} (${types.join(', ') || 'default'})`);
            } else {
              console.log('Failed to add phone:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to add phone:', err.message);
          }
        } else if (subaction === 'remove') {
          const index = parseInt(args[1], 10);
          if (isNaN(index)) {
            console.log('Invalid index. Usage: openclaw xmpp vcard phone remove <index>');
            return;
          }

          try {
            const { removeVCardPhone } = await import('./vcard-cli.js');
            const result = await removeVCardPhone(index);
            if (result.ok) {
              console.log(`vCard phone removed at index ${index}`);
            } else {
              console.log('Failed to remove phone:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to remove phone:', err.message);
          }
        } else {
          console.log('Invalid phone command. Use: openclaw xmpp vcard phone add <number> [--type] or phone remove <index>');
        }
      } else if (action === 'email' && args.length >= 2) {
        // openclaw xmpp vcard email add <address> [type...]
        // openclaw xmpp vcard email remove <index>
        const subaction = args[0];

        if (subaction === 'add' && args.length >= 2) {
          const address = args[1];
          const types: string[] = [];
          for (let i = 2; i < args.length; i++) {
            const arg = args[i].toLowerCase();
            if (['home', 'work', 'internet', 'pref'].includes(arg)) {
              types.push(arg.toUpperCase());
            }
          }

          try {
            const { addVCardEmail } = await import('./vcard-cli.js');
            const result = await addVCardEmail(types, address);
            if (result.ok) {
              console.log(`vCard email added: ${address} (${types.join(', ') || 'default'})`);
            } else {
              console.log('Failed to add email:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to add email:', err.message);
          }
        } else if (subaction === 'remove') {
          const index = parseInt(args[1], 10);
          if (isNaN(index)) {
            console.log('Invalid index. Usage: openclaw xmpp vcard email remove <index>');
            return;
          }

          try {
            const { removeVCardEmail } = await import('./vcard-cli.js');
            const result = await removeVCardEmail(index);
            if (result.ok) {
              console.log(`vCard email removed at index ${index}`);
            } else {
              console.log('Failed to remove email:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to remove email:', err.message);
          }
        } else {
          console.log('Invalid email command. Use: openclaw xmpp vcard email add <address> [--type] or email remove <index>');
        }
      } else if (action === 'address' && args.length >= 2) {
        // openclaw xmpp vcard address add <street> <city> <region> <postal> <country> [--home|--work]
        // openclaw xmpp vcard address remove <index>
        const subaction = args[0];

        if (subaction === 'add' && args.length >= 6) {
          const street = args[1];
          const locality = args[2];
          const region = args[3];
          const pcode = args[4];
          const ctry = args[5];
          const types: string[] = [];
          for (let i = 6; i < args.length; i++) {
            const arg = args[i].toLowerCase();
            if (['home', 'work', 'postal', 'parcel'].includes(arg)) {
              types.push(arg.toUpperCase());
            }
          }

          try {
            const { addVCardAddress } = await import('./vcard-cli.js');
            const result = await addVCardAddress(types, street, locality, region, pcode, ctry);
            if (result.ok) {
              console.log(`vCard address added: ${street}, ${locality}, ${region} ${pcode}, ${ctry} (${types.join(', ') || 'default'})`);
            } else {
              console.log('Failed to add address:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to add address:', err.message);
          }
        } else if (subaction === 'remove') {
          const index = parseInt(args[1], 10);
          if (isNaN(index)) {
            console.log('Invalid index. Usage: openclaw xmpp vcard address remove <index>');
            return;
          }

          try {
            const { removeVCardAddress } = await import('./vcard-cli.js');
            const result = await removeVCardAddress(index);
            if (result.ok) {
              console.log(`vCard address removed at index ${index}`);
            } else {
              console.log('Failed to remove address:', result.error || 'Unknown error');
            }
          } catch (err: any) {
            console.log('Failed to remove address:', err.message);
          }
        } else {
          console.log('Invalid address command. Use: openclaw xmpp vcard address add <street> <city> <region> <postal> <country> [--type] or address remove <index>');
        }
      } else if (action === 'org' && args.length >= 1) {
        // openclaw xmpp vcard org <orgname> [orgunit...]
        const orgname = args[0];
        const orgunits = args.slice(1);

        try {
          const { setVCardOrg } = await import('./vcard-cli.js');
          const result = await setVCardOrg(orgname, ...orgunits);
          if (result.ok) {
            console.log(`vCard org updated: ${orgname}${orgunits.length > 0 ? ' (' + orgunits.join(', ') + ')' : ''}`);
          } else {
            console.log('Failed to update org:', result.error || 'Unknown error');
          }
        } catch (err: any) {
          console.log('Failed to update org:', err.message);
        }
      } else {
        console.log('Invalid vCard command');
        console.log('Use: openclaw xmpp vcard help');
      }
    });

  // Subcommand: vcard4 <action> [args]
  // SECURITY (2.14.5): XEP-0292 vCard4 over PEP (node `urn:xmpp:vcard4`).
  xmpp
    .command("vcard4 [action]")
    .description("vCard4 (XEP-0292) over PEP: get | publish")
    .action(async (action?: string) => {
      const act = (action || "get").toLowerCase();
      if (act === "get") {
        const { getVCard4 } = await import('./vcard-cli.js');
        const result = await getVCard4();
        if (!result.ok) { console.error('vCard4 get failed:', result.error || 'unknown'); process.exit(1); }
        if (!result.data || Object.keys(result.data).length === 0) {
          console.log('No vCard4 published in the PEP node.');
        } else {
          console.log('vCard4 (XEP-0292, urn:xmpp:vcard4):');
          console.log(JSON.stringify(result.data, null, 2));
        }
      } else if (act === "publish") {
        const { publishVCard4Now } = await import('./vcard-cli.js');
        const result = await publishVCard4Now();
        if (!result.ok) { console.error('vCard4 publish failed:', result.error || 'unknown'); process.exit(1); }
        console.log('vCard4 published to PEP node urn:xmpp:vcard4.');
      } else {
        console.log('Usage: openclaw xmpp vcard4 [get|publish]');
      }
    });

  // Subcommand: sftp <action> [args]
  // SECURITY (2.14.0): SFTP re-added with REQUIRED, pinned host-key
  // fingerprint verification (the 2.0.15 removal was because the old code
  // disabled host key verification entirely).
  xmpp
    .command("sftp <action> [args...]")
    .description("SFTP (pinned host key): upload | download | ls | rm")
    .action(async (action: string, args: string[]) => {
      const { loadSftpConfigFromDisk, sftpUpload, sftpDownload, sftpList, sftpRemove } =
        await import('./sftp.js');
      let cfg;
      try {
        cfg = loadSftpConfigFromDisk();
      } catch (err: any) {
        console.error("SFTP config error:", err?.message || String(err));
        process.exit(1);
      }
      const act = (action || "").toLowerCase();
      try {
        if (act === "upload") {
          if (!args[0]) { console.error("Usage: openclaw xmpp sftp upload <local-path> [remote-name]"); process.exit(1); }
          const r = await sftpUpload(cfg, args[0], args[1]);
          if (!r.ok) throw new Error(r.error);
          console.log(`Uploaded: ${args[0]} -> ${r.data}`);
        } else if (act === "download") {
          if (!args[0]) { console.error("Usage: openclaw xmpp sftp download <remote-name> [local-path]"); process.exit(1); }
          const r = await sftpDownload(cfg, args[0], args[1]);
          if (!r.ok) throw new Error(r.error);
          console.log(`Downloaded: ${args[0]} -> ${r.data}`);
        } else if (act === "ls" || act === "list") {
          const r = await sftpList(cfg, args[0] || ".");
          if (!r.ok) throw new Error(r.error);
          for (const f of (r.data || [])) console.log(f);
        } else if (act === "rm" || act === "delete") {
          if (!args[0]) { console.error("Usage: openclaw xmpp sftp rm <remote-name>"); process.exit(1); }
          const r = await sftpRemove(cfg, args[0]);
          if (!r.ok) throw new Error(r.error);
          console.log(`Removed: ${r.data}`);
        } else {
          console.log("Usage: openclaw xmpp sftp <upload|download|ls|rm> [args]");
          console.log("  upload <local-path> [remote-name]");
          console.log("  download <remote-name> [local-path]");
          console.log("  ls [dir]");
          console.log("  rm <remote-name>");
        }
      } catch (err: any) {
        console.error("SFTP error:", err?.message || String(err));
        process.exit(1);
      }
    });

  // Subcommand: encrypt-password
  // SECURITY (2.0.16): the previous implementation used
  // readline.createInterface() with output: process.stdout — the
  // password was echoed character by character to the terminal.  It
  // also used fs.readFileSync / fs.writeFileSync which is fragile.
  // The new implementation reads the password from stdin (the
  // argv path is kept for backward-compatibility but emits a
  // deprecation warning) and delegates the actual encryption to
  // the same helper that src/cli-encrypt.ts uses.
  xmpp
    .command("encrypt-password")
    .description("Encrypt password in config file (reads from stdin)")
    .action(async () => {
      const path = await import('path');
      const { updateConfigWithEncryptedPassword } = await import('./security/encryption.js');

      // Parse --config / -c flag.
      const args = process.argv.slice(2);
      let configPath = path.join(
        process.env.USERPROFILE || process.env.HOME || '',
        '.openclaw',
        'openclaw.json',
      );
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--config' || args[i] === '-c') && args[i + 1]) {
          configPath = args[++i];
        }
      }

      // Skip the first two args: 'xmpp' (the program name) and
      // 'encrypt-password' (the subcommand).  The next positional
      // arg is the optional argv password (deprecated).
      const positional = args.filter((a) => !a.startsWith('-') && a !== 'xmpp' && a !== 'encrypt-password');
      let password = positional[0];

      if (password) {
        // SECURITY: warn that argv-passwords are visible in process
        // listings and shell history.  Operators should switch to
        // stdin.
        process.stderr.write(
          '[commands.ts] WARNING: passing the password on the command line ' +
          'is deprecated.  Pipe via stdin instead.  (Removed in 2.1.0.)\n',
        );
      } else {
        if (process.stdin.isTTY) {
          console.error('No password provided on stdin and stdin is a TTY.');
          console.error('Usage: echo "mypassword" | openclaw xmpp encrypt-password');
          process.exit(1);
        }
        const chunks: Buffer[] = [];
        process.stdin.setEncoding('utf8');
        for await (const chunk of process.stdin) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '').trim();
        if (!password) {
          console.error('Empty password read from stdin.');
          process.exit(1);
        }
      }

      // Delegate to the same helper that src/cli-encrypt.ts uses.
      // The helper reads the config file, encrypts the password,
      // and writes the result back.  We use the result type
      // ({ success, error }) to surface a clean error.
      const result = updateConfigWithEncryptedPassword(configPath, password);
      if (!result.success) {
        console.error('Failed to encrypt password:', result.error || 'Unknown error');
        process.exit(1);
      }
      console.log('Password encrypted successfully!');
      console.log(`Config file: ${configPath}`);
      console.log('Updated fields: encryptionKey, password (ENC:...)');
    });

  // Subcommand: setup — interactive onboaring
  // SECURITY (2.11.1): an interactive, cross-platform onboarding wizard
  // that prompts for user + server info, encrypts the password (using
  // the same path as encrypt-password), and asks to keep / override the
  // existing account config if one is present.  Delegates to
  // src/onboarding.ts so it is testable and reusable by the installers.
  xmpp
    .command("setup")
    .description("Interactive onboarding: configure XMPP account and encrypt the password")
    .option("--config <path>", "Override the openclaw.json config path")
    .option("--skip-install", "Do not run clone/npm/build/register — only config + password")
    .option("--account <id>", "Account id to configure (default: default)")
    .action(async (options: any) => {
      const { runXmppOnboarding } = await import('./onboarding.js');
      const result = await runXmppOnboarding({
        configPath: options?.config,
        skipInstall: !!options?.skipInstall,
        account: options?.account || "default",
      });
      if (!result.ok) {
        console.error('XMPP onboarding failed:', result.error || 'Unknown error');
        process.exit(1);
      }
    });

  // Subcommand: doctor — diagnose the plugin install/runtime readiness
  // SECURITY (2.11.2): OpenClaw launches a `.ts` extension with
  // `node --import tsx`.  `tsx` is only a devDependency of openclaw,
  // so it is not guaranteed to be installed.  If `dist/` is missing,
  // the plugin falls back to `index.ts` and needs tsx — otherwise
  // OpenClaw crashes at startup with the cryptic `Cannot find package
  // 'tsx'`.  `doctor` surfaces that condition with clear, actionable
  // advice and can rebuild the missing dist/ automatically.
  xmpp
    .command("doctor")
    .description("Diagnose the XMPP plugin install (missing dist/ or tsx) and show how to fix it")
    .option("--config <path>", "Override the openclaw.json config path")
    .option("--fix", "Rebuild the missing dist/ output automatically")
    .action(async (options: any) => {
      const { diagnosePluginState, ensureDistBuilt } = await import('./onboarding.js');
      const report = diagnosePluginState(undefined, options?.config);
      console.log('XMPP plugin diagnostics');
      console.log(`  Plugin directory:  ${report.pluginDir}`);
      console.log(`  dist/ present:     ${report.distExists ? "yes" : "NO"}`);
      console.log(`  tsx available:     ${report.tsxAvailable ? "yes" : "NO"}`);
      console.log(`  entry OpenClaw uses: ${report.entryKind === "dist" ? "dist/index.js (compiled JS)" : "index.ts (needs tsx)"}`);
      for (const p of report.problems) console.log(`  - ${p}`);
      for (const f of report.fixes) console.log(`      ${f}`);

      if (options?.fix && !report.distExists) {
        console.log("\nRunning: npx tsc ...");
        try {
          const { built } = await ensureDistBuilt();
          console.log(built ? "  dist/ rebuilt." : "  nothing to do.");
          console.log("  Restart the gateway to load the plugin.");
        } catch (err: any) {
          console.error('  Failed to rebuild dist/:', err?.message || String(err));
          process.exit(1);
        }
      }
    });

  // Subcommand: update-check — compare current vs latest GitHub release
  xmpp
    .command("update-check")
    .description("Check the GitHub repo for a newer release")
    .option("--tag <tag>", "Override the current version (testing)")
    .action(async (options: any) => {
      const { checkForUpdate, getCurrentVersion } = await import('./updater.js');
      const info = await checkForUpdate();
      console.log(`Current version: v${info.current}`);
      console.log(`Latest release:  v${info.latest}`);
      if (info.error) {
        console.error(`  (could not reach GitHub: ${info.error})`);
      } else if (info.updateAvailable) {
        console.log('  A newer version is available. Run: openclaw xmpp update');
      } else {
        console.log('  Already up to date.');
      }
    });

  // Subcommand: update — download + install the latest release
  xmpp
    .command("update")
    .description("Update the XMPP plugin to the latest GitHub release (preserves data/config)")
    .option("--yes", "Skip confirmation")
    .option("--dry-run", "Report what would change without installing")
    .action(async (options: any) => {
      const { performUpdate } = await import('./updater.js');
      const yes = !!options?.yes;
      const dryRun = !!options?.dryRun;
      if (!yes && !dryRun && process.stdout.isTTY) {
        // Confirm before installing (uses readline/promises — the confirmation
        // is not a secret, unlike the password path which deliberately avoids
        // readline because it echoes).
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question('Install the latest release? [y/N]: ')).trim().toLowerCase();
        rl.close();
        if (!['y', 'yes'].includes(answer)) {
          console.log('Aborted.');
          process.exit(0);
        }
      }
      const result = await performUpdate({ dryRun });
      if (result.ok) {
        console.log(result.message);
        if (result.toVersion && !dryRun) {
          console.log('Note: restart the gateway to apply the update (openclaw gateway restart).');
        }
      } else {
        console.error(result.message);
        process.exit(1);
      }
    });

}
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
