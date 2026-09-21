import { registerXmppCli } from "./commands.js";
import { xmppClients, contactsStore } from "./state.js";
import {
  getUnprocessedMessages,
  clearOldMessages,
  defaultQueueDir,
} from "./queue-bridge.js";
import { loadXmppConfig } from "./lib/config-loader.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

// SECURITY (2.18.1): resolve the account dataDir for the injected queue
// helpers so they never fall back to process.cwd() (C:\Windows\System32 on
// Windows scheduled tasks).
function resolveQueueDataDir(): string {
  try {
    return loadXmppConfig()?.dataDir || defaultQueueDir();
  } catch {
    return defaultQueueDir();
  }
}

export function registerXmppCliMetadata(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program, logger }) => {
      const getXmppClient = () => {
        return xmppClients.get("default") || xmppClients.values().next().value;
      };

      registerXmppCli({
        program,
        getXmppClient,
        logger: logger ?? api.logger,
        getUnprocessedMessages: () => getUnprocessedMessages(undefined, resolveQueueDataDir()),
        clearOldMessages: () => clearOldMessages(undefined, resolveQueueDataDir()),
        getContacts: () =>
          contactsStore.get("default") || contactsStore.values().next().value || null,
      });
    },
    { commands: ["xmpp"] },
  );
}
