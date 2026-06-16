import { registerXmppCli } from "./commands.js";
import { xmppClients, contactsStore } from "./state.js";
import {
  getMessageQueue,
  getUnprocessedMessages,
  clearOldMessages,
} from "./queue-bridge.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

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
        getUnprocessedMessages,
        clearOldMessages,
        messageQueue: getMessageQueue(),
        getContacts: () =>
          contactsStore.get("default") || contactsStore.values().next().value || null,
      });
    },
    { commands: ["xmpp"] },
  );
}
