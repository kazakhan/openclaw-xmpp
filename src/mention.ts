// SECURITY (2.13.0): groupchat mention detection helpers.
//
// A message counts as mentioning the bot when it contains `@` immediately
// followed by one of the bot's mention tokens: its room nick, its vCard
// nickname/full name, or its JID local part.  Matching is case-insensitive
// and requires a word boundary after the token, so `@othernick` never matches
// the bot and bare names without `@` do not count.

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MentionTokenSources {
  botNick?: string | null;
  jid?: string | null;
  nickname?: string | null;
  fullName?: string | null;
}

export function buildMentionTokens(sources: MentionTokenSources): string[] {
  const tokens = new Set<string>();
  const add = (v: string | null | undefined) => {
    const t = (v || "").trim();
    if (t) tokens.add(t);
  };
  add(sources.botNick);
  add(sources.nickname);
  add(sources.fullName);
  add(String(sources.jid || "").split("@")[0]);
  return Array.from(tokens);
}

export function wasBotMentioned(body: string | null | undefined, tokens: string[]): boolean {
  if (!body || !tokens || tokens.length === 0) return false;
  for (const t of tokens) {
    if (!t) continue;
    // `@token` with a boundary that is not another word/JID char.
    const re = new RegExp(`@${escapeRegex(t)}(?![\\w@.-])`, "i");
    if (re.test(body)) return true;
  }
  return false;
}
