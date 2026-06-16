import type { PluginRuntime, XmppClient } from "./types.js";
import type { Contacts } from "./contacts.js";

export const xmppClients = new Map<string, XmppClient>();
export const contactsStore = new Map<string, Contacts>();

let pluginRuntime: PluginRuntime | null = null;
let pluginRegistered = false;

export function getPluginRuntime(): PluginRuntime | null {
  return pluginRuntime;
}

export function isPluginRegistered(): boolean {
  return pluginRegistered;
}

export function markPluginRegistered(): void {
  pluginRegistered = true;
}

export function setXmppRuntime(runtime: PluginRuntime | null): void {
  pluginRuntime = runtime;
}
