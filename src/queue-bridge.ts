import { PersistentQueue, type QueuedMessage } from "./lib/persistent-queue.js";

// SECURITY (2.0.16): the old `messageQueue` module-level singleton
// ignored `dataDir` after the first call.  In a multi-account
// deployment the second account's messages would have been written
// to the first account's message-queue.json.  This is now a
// per-dataDir map so each account gets its own queue.
const queueByDir = new Map<string, PersistentQueue>();

function getQueue(dataDir?: string): PersistentQueue {
  const dir = dataDir || process.cwd();
  let q = queueByDir.get(dir);
  if (!q) {
    q = new PersistentQueue(dir);
    queueByDir.set(dir, q);
  }
  return q;
}

export function addToQueue(
  message: Omit<QueuedMessage, "id" | "timestamp" | "processed">,
  dataDir?: string,
): string {
  return getQueue(dataDir).push(message);
}

export function markAsProcessed(messageId: string, dataDir?: string): void {
  getQueue(dataDir).markProcessed(messageId);
}

export function getUnprocessedMessages(accountId?: string, dataDir?: string): QueuedMessage[] {
  return getQueue(dataDir).getUnprocessed(accountId);
}

export function clearOldMessages(
  maxAgeMs: number = 24 * 60 * 60 * 1000,
  dataDir?: string,
): number {
  return getQueue(dataDir).clearOld(maxAgeMs);
}

export function getMessageQueue(): PersistentQueue | null {
  // Returns the queue for the default dataDir (process.cwd()) if
  // one has been created.  Preserved for backward compatibility with
  // any caller that took a `PersistentQueue | null` return type.
  return queueByDir.get(process.cwd()) ?? null;
}

export async function flushQueue(dataDir?: string): Promise<void> {
  const queue = getQueue(dataDir);
  await queue.flush();
}
