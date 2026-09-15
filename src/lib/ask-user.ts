// SECURITY (2.16.0): gateway/SDK side of ask_user support (see questions.ts for
// the pure store/parser).  Captures question prompts delivered to XMPP,
// registers them, and turns a user's reply into a `question.resolve` call.

import { getPluginRuntime } from "../state.js";
import { log } from "./logger.js";
import {
  formatPrompt,
  registerPending,
  getPending,
  clearPending,
  makePending,
  parseAnswer,
  buildResolveParams,
  type QuestionSpec,
} from "./questions.js";

const QUESTION_RECORD_RE = /^ask_[a-f0-9]{32}$/;

function readQuestionId(payload: any): string | undefined {
  const ask = payload?.channelData?.askUser;
  const id = ask && typeof ask === "object" && !Array.isArray(ask) ? ask.questionId : undefined;
  return typeof id === "string" && QUESTION_RECORD_RE.test(id) ? id : undefined;
}

function stripXmpp(to: string): string {
  return String(to || "").replace(/^xmpp:/, "").split("/")[0];
}

async function gatewayRequest(method: string, params: Record<string, unknown>): Promise<any> {
  const runtime: any = getPluginRuntime();
  const gateway = runtime?.gateway;
  if (gateway && typeof gateway.request === "function") {
    return await gateway.request(method, params);
  }
  throw new Error("gateway.request unavailable");
}

/** Map a gateway question record into our QuestionSpec[] (best effort). */
function normalizeQuestions(raw: any): QuestionSpec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: QuestionSpec[] = [];
  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const questionId = typeof q.questionId === "string" ? q.questionId : undefined;
    if (!questionId) continue;
    const options = Array.isArray(q.options)
      ? q.options
          .map((o: any) => (o && typeof o === "object" && typeof o.label === "string" ? { label: o.label, description: typeof o.description === "string" ? o.description : undefined } : undefined))
          .filter(Boolean)
      : [];
    out.push({
      questionId,
      header: typeof q.header === "string" ? q.header : undefined,
      question: typeof q.question === "string" ? q.question : "Agent question",
      options: options as QuestionSpec["options"],
      multiSelect: q.multiSelect === true,
      isOther: q.isOther !== false,
      isSecret: q.isSecret === true,
    });
  }
  return out;
}

/** Fallback: derive a single question from the delivered presentation buttons. */
function deriveFromPayload(payload: any, recordId: string): QuestionSpec[] | undefined {
  const blocks = payload?.presentation?.blocks;
  if (!Array.isArray(blocks)) return undefined;
  const buttonsBlock = blocks.find((b: any) => b?.type === "buttons");
  const textBlock = blocks.find((b: any) => b?.type === "text" && typeof b.text === "string");
  if (!buttonsBlock || !Array.isArray(buttonsBlock.buttons)) return undefined;
  const labels = buttonsBlock.buttons
    .filter((b: any) => b?.action?.type === "question" && b.action.questionId === recordId && typeof b.action.optionValue === "string")
    .map((b: any) => b.action.optionValue as string);
  if (labels.length === 0) return undefined;
  return [
    {
      questionId: recordId,
      question: textBlock?.text || "Agent question",
      options: labels.map((label) => ({ label })),
      isOther: true,
    },
  ];
}

export interface CaptureResult {
  handled: boolean;
  text?: string;
  recordId?: string;
}

/**
 * Register an ask_user prompt for `conversation` and return the text to render.
 * Safe to call more than once for the same payload.
 */
export async function captureAskUser(
  payload: any,
  opts: { accountId: string; conversation: string },
): Promise<CaptureResult> {
  const recordId = readQuestionId(payload);
  if (!recordId) return { handled: false };

  let questions: QuestionSpec[] = [];
  try {
    const res = await gatewayRequest("question.get", { id: recordId });
    const record = res?.question;
    if (!record || record.status !== "pending") return { handled: false };
    questions = normalizeQuestions(record.questions);
  } catch (err) {
    log.debug("ask_user: question.get failed, deriving from payload", err);
  }
  if (questions.length === 0) {
    questions = deriveFromPayload(payload, recordId) ?? [];
  }
  if (questions.length === 0) return { handled: false };

  registerPending(
    makePending({ recordId, questions, accountId: opts.accountId, conversation: opts.conversation }),
  );
  return { handled: true, text: formatPrompt(questions), recordId };
}

export interface AnswerResult {
  handled: boolean;
  reply?: string;
  error?: string;
}

/**
 * If a question is pending for this conversation, resolve it from the reply.
 * Returns handled=true (with a reply to send) or handled=false (dispatch normally).
 */
export async function tryAnswerPending(opts: {
  accountId: string;
  conversation: string;
  sender: string;
  body: string;
}): Promise<AnswerResult> {
  const q = getPending(opts.accountId, opts.conversation);
  if (!q) return { handled: false };

  const parsed = parseAnswer(opts.body, q.questions);
  if (!parsed) {
    return { handled: true, reply: `Sorry, I didn't understand that.\n\n${formatPrompt(q.questions)}` };
  }

  try {
    await gatewayRequest("question.resolve", buildResolveParams(q.recordId, parsed.answers, opts.sender));
    clearPending(opts.accountId, opts.conversation);
    return { handled: true, reply: `Answered: ${parsed.summary}` };
  } catch (err: any) {
    clearPending(opts.accountId, opts.conversation);
    return { handled: true, error: err?.message || String(err) };
  }
}
