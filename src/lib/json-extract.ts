// SECURITY (2.15.1): robust JSON extraction from CLI/child stdout.
//
// The old gateway-client line scanner (bottom-up, "any line that is exactly
// `{`") returned a fragment of pretty-printed JSON whenever the payload
// contained a nested object whose opening brace sat alone on a line — e.g.
// the `email: [ { ... } ]` block in a vCard — producing
// `parse-failed: Unexpected non-whitespace character after JSON`.
//
// This scanner finds the FIRST complete JSON value (`{...}` or `[...]`) in the
// text using a string/escape-aware, brace-balanced walk, ignoring any preamble
// (like the `Gateway call: <method>` heading), ANSI colour codes, and any
// trailing log lines.

// Matches CSI/ANSI escape sequences (e.g. colour codes).
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Returns the first complete JSON object/array substring found in `text`,
 * or null when there is none.
 */
export function extractFirstJson(text: string): string | null {
  if (!text) return null;
  const s = stripAnsi(text);

  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{" || ch === "[") {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // unterminated
}

/** Parse the first complete JSON value from `text`, or null. */
export function parseFirstJson<T = any>(text: string): T | null {
  const raw = extractFirstJson(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
