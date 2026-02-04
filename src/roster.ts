import fs from "fs-extra";

let roster: Record<string, { nick?: string }> = {};

export async function loadRoster(path: string) {
  roster = (await fs.readJSON(path, { throws: false })) || {};
}

export async function saveRoster(path: string) {
  await fs.writeJSON(path, roster, { spaces: 2 });
}

export function getRoster() {
  return roster;
}

export function setNick(jid: string, nick: string) {
  roster[jid] = { nick };
}
