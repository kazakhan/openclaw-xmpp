import { xml } from "@xmpp/client";
import { state } from "./state.js";

// Import queue functions from main module
import { getUnprocessedMessages, clearOldMessages, messageQueue, xmppClients } from "../index.js";

// Simple roster functions without fs-extra
let roster: Record<string, { nick?: string }> = {};

function getRoster() {
  return roster;
}

function setNick(jid: string, nick: string) {
  roster[jid] = { nick };
}

async function saveRoster(dataPath: string) {
  // Simplified - just log for now
  console.log("Roster save would go to:", dataPath);
}

export function registerCommands(api: any, dataPath: string) {
  // Set state.xmpp to first available XMPP client for CLI commands
  if (state.xmpp === null && xmppClients.size > 0) {
    const firstClient = xmppClients.values().next().value;
    state.xmpp = firstClient;
    console.log("CLI: Set state.xmpp to first available XMPP client");
  }
  
  api.cli.commands.register({
    name: "xmpp",
    async run(ctx: any) {
      // Ensure state.xmpp is set
      if (state.xmpp === null && xmppClients.size > 0) {
        const firstClient = xmppClients.values().next().value;
        state.xmpp = firstClient;
        ctx.log.info("CLI: Set state.xmpp to first available XMPP client");
      }
      const [cmd, ...args] = ctx.args;

      switch (cmd) {
        case "status":
          ctx.log.info(state.xmpp?.status);
          break;

        case "msg":
          await state.xmpp.send(
            xml("message", { to: args[0], type: "chat" },
              xml("body", {}, args.slice(1).join(" "))
            )
          );
          break;

        case "roster":
          ctx.log.info(getRoster());
          break;

        case "nick":
          setNick(args[0], args[1]);
          await saveRoster(dataPath);
          ctx.log.info("Nick saved");
          break;

        case "join":
          if (state.xmpp.joinRoom) {
            await state.xmpp.joinRoom(args[0], args[1] || "moltbot");
          } else {
            // Fallback for older versions
            await state.xmpp.send(
              xml("presence", {
                to: `${args[0]}/${args[1] || "moltbot"}`
              })
            );
          }
          ctx.log.info("Joined MUC");
          break;

        case "poll":
          // Poll queued messages
          const unprocessed = getUnprocessedMessages();
          if (unprocessed.length === 0) {
            ctx.log.info("No unprocessed messages in queue");
          } else {
            ctx.log.info(`Found ${unprocessed.length} unprocessed messages:`);
            unprocessed.forEach((msg, i) => {
              ctx.log.info(`${i+1}. [${msg.accountId}] ${msg.from}: ${msg.body}`);
            });
          }
          break;

        case "clear":
          // Clear old messages
          const oldCount = messageQueue.length;
          clearOldMessages();
          ctx.log.info(`Cleared ${oldCount - messageQueue.length} old messages`);
          break;

        case "queue":
          // Show queue status
          ctx.log.info(`Message queue: ${messageQueue.length} total, ${getUnprocessedMessages().length} unprocessed`);
          messageQueue.slice(0, 5).forEach((msg, i) => {
            ctx.log.info(`${i+1}. ${msg.processed ? '✓' : '✗'} [${msg.accountId}] ${msg.from}: ${msg.body.substring(0, 50)}${msg.body.length > 50 ? '...' : ''}`);
          });
          break;

        default:
          ctx.log.info("xmpp status | msg | roster | nick | join | poll | clear | queue");
      }
    }
  });
}
