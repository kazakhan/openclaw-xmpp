// SECURITY (2.16.0): ask_user support for XMPP.
//
// OpenClaw's `ask_user` tool blocks the run until `question.resolve` is called.
// The dashboard answers it; text-only channels must render the prompt and turn
// the user's reply into a resolve call.  This module holds the pure logic
// (pending-question store + prompt rendering + answer parsing) so it is
// dependency-free and unit-testable; the gateway/SDK calls live in ask-user.ts.

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  /** Per-question id used in the resolve answers map. */
  questionId: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface PendingQuestion {
  /** Gateway question record id (`ask_<hex>`). */
  recordId: string;
  questions: QuestionSpec[];
  accountId: string;
  /** Bare JID (direct) or room JID (groupchat) the prompt was delivered to. */
  conversation: string;
  createdAt: number;
  expiresAt: number;
}

export interface ParsedAnswer {
  /** questionId -> submitted values. */
  answers: Record<string, string[]>;
  /** Human-readable echo (secret values masked). */
  summary: string;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const pending = new Map<string, PendingQuestion>();

function keyFor(accountId: string, conversation: string): string {
  return `${accountId}\u0000${conversation}`;
}

export function registerPending(q: PendingQuestion): void {
  pending.set(keyFor(q.accountId, q.conversation), q);
}

export function getPending(accountId: string, conversation: string, now = Date.now()): PendingQuestion | undefined {
  const key = keyFor(accountId, conversation);
  const q = pending.get(key);
  if (!q) return undefined;
  if (q.expiresAt <= now) {
    pending.delete(key);
    return undefined;
  }
  return q;
}

export function clearPending(accountId: string, conversation: string): void {
  pending.delete(keyFor(accountId, conversation));
}

/** Test helper. */
export function _resetPendingForTests(): void {
  pending.clear();
}

export function makePending(params: {
  recordId: string;
  questions: QuestionSpec[];
  accountId: string;
  conversation: string;
  ttlMs?: number;
  now?: number;
}): PendingQuestion {
  const now = params.now ?? Date.now();
  return {
    recordId: params.recordId,
    questions: params.questions,
    accountId: params.accountId,
    conversation: params.conversation,
    createdAt: now,
    expiresAt: now + (params.ttlMs ?? DEFAULT_TTL_MS),
  };
}

const TYPE_YOUR_OWN = "Type your own answer";

/** Render the questions + numbered options as a plain-text XMPP message. */
export function formatPrompt(questions: QuestionSpec[]): string {
  const lines: string[] = ["Agent needs input:"];
  const multi = questions.length > 1;
  questions.forEach((q, qi) => {
    lines.push("");
    if (multi) lines.push(`${qi + 1}. ${q.header || `Question ${qi + 1}`}`);
    else if (q.header) lines.push(q.header);
    lines.push(q.question);
    q.options.forEach((opt, oi) => {
      lines.push(`  ${oi + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`);
    });
    if (q.multiSelect) lines.push(`  (choose one or more, comma-separated)`);
    if (q.isOther !== false) lines.push(`  ${q.options.length + 1}. ${TYPE_YOUR_OWN}`);
    if (q.isSecret) lines.push(`  (this answer may be visible to others)`);
  });
  lines.push("");
  lines.push(
    multi
      ? `Reply like "1: 2, 2: 1" (question: option), or type your own answer.`
      : `Reply with a number, the option text, or type your own answer.`,
  );
  return lines.join("\n");
}

function matchOption(body: string, q: QuestionSpec): string | undefined {
  const trimmed = body.trim();
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1].label;
  const lower = trimmed.toLowerCase();
  const exact = q.options.find((o) => o.label.toLowerCase() === lower);
  if (exact) return exact.label;
  return undefined;
}

/** Parse a single question's value(s) from a free-text reply. */
function parseSingle(body: string, q: QuestionSpec): string[] {
  const trimmed = body.trim();
  if (q.multiSelect) {
    const parts = trimmed.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const values: string[] = [];
    for (const part of parts) {
      values.push(matchOption(part, q) ?? part);
    }
    return values.length > 0 ? values : [trimmed];
  }
  const opt = matchOption(trimmed, q);
  return [opt ?? trimmed];
}

/**
 * Parse a user reply against the pending questions.
 * Returns null when a multi-question reply cannot be understood (re-prompt).
 */
export function parseAnswer(body: string, questions: QuestionSpec[]): ParsedAnswer | null {
  const text = (body ?? "").trim();
  if (!text) return null;

  if (questions.length === 1) {
    const q = questions[0];
    const values = parseSingle(text, q);
    return { answers: { [q.questionId]: values }, summary: summarize(questions, { [q.questionId]: values }) };
  }

  // Multiple questions: expect "1: 2, 2: 1" / "q1: B" / "1. yes".
  const answers: Record<string, string[]> = {};
  const segments = text.split(/\n|;/).flatMap((line) => line.split(/,(?=\s*(?:q(?:uestion)?\s*)?\d+\s*[:.)-])/i));
  for (const segment of segments) {
    const m = segment.match(/^\s*(?:q(?:uestion)?\s*)?(\d+)\s*[:.)-]\s*(.+)$/i);
    if (!m) continue;
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 1 || idx > questions.length) continue;
    const q = questions[idx - 1];
    answers[q.questionId] = parseSingle(m[2], q);
  }
  if (Object.keys(answers).length === questions.length) {
    return { answers, summary: summarize(questions, answers) };
  }
  return null;
}

function summarize(questions: QuestionSpec[], answers: Record<string, string[]>): string {
  const parts: string[] = [];
  for (const q of questions) {
    const values = answers[q.questionId];
    if (!values) continue;
    const shown = q.isSecret ? "••••" : values.join(", ");
    parts.push(questions.length > 1 ? `${q.header || "Answer"}: ${shown}` : shown);
  }
  return parts.join(" | ");
}

/** Build the `question.resolve` params payload. */
export function buildResolveParams(
  recordId: string,
  answers: Record<string, string[]>,
  resolvedBy?: string,
): { id: string; answers: { answers: Record<string, string[]> }; resolvedBy?: string } {
  return {
    id: recordId,
    answers: { answers },
    ...(resolvedBy ? { resolvedBy } : {}),
  };
}
