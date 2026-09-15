// SECURITY (2.16.0, revised 2.16.1): gateway/SDK side of ask_user support.
//
// 2.16.1 fixes:
//   - Rendering must NOT do a gateway RPC: `question.get` during outbound
//     delivery blocked the prompt (no active request scope) and the answer
//     arrived after the ask_user timeout.  Capture is now synchronous; the
//     authoritative questions are fetched lazily at answer time.
//   - A late answer (question already terminal) is no longer swallowed: the
//     caller is told `closed` so it can note it and dispatch the message.

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

async function gatewayRequest(method: string, params: Record<string, unknown>): Promise<any> {
  const runtime: any = getPluginRuntime();
  const gateway = runtime?.gateway;
  if (gateway && typeof gateway.request === "function") {
    return await gateway.request(method, params);
  }
  throw new Error("gateway.request unavailable");
}

function isTerminalError(err: any): boolean {
  const reason = err?.details?.reason ?? err?.responsePayload?.error?.details?.reason;
  return reason === "QUESTION_ALREADY_TERMINAL" || reason === "QUESTION_NOT_FOUND";
}

function normalizeQuestions(raw: any): QuestionSpec[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: QuestionSpec[] = [];
  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const questionId = typeof q.questionId === "string" ? q.questionId : undefined;
    if (!questionId) continue;
    const options = Array.isArray(q.options)
      ? q.options
          .map((o: any) =>
            o && typeof o === "object" && typeof o.label === "string"
              ? { label: o.label, description: typeof o.description === "string" ? o.description : undefined }
              : undefined,
          )
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

/** Best-effort questions derived from the delivered presentation (no RPC). */
function questionsFromPayload(payload: any, recordId: string): QuestionSpec[] {
  const blocks = payload?.presentation?.blocks;
  if (!Array.isArray(blocks)) return [];
  const buttonsBlock = blocks.find((b: any) => b?.type === "buttons");
  const textBlocks = blocks.filter((b: any) => b?.type === "text" && typeof b.text === "string");
  if (!buttonsBlock || !Array.isArray(buttonsBlock.buttons)) return [];
  const labels = buttonsBlock.buttons
    .filter(
      (b: any) =>
        b?.action?.type === "question" && b.action.questionId === recordId && typeof b.action.optionValue === "string",
    )
    .map((b: any) => b.action.optionValue as string);
  if (labels.length === 0) return [];
  return [
    {
      questionId: recordId,
      question: textBlocks[0]?.text || "Agent question",
      options: labels.map((label) => ({ label })),
      isOther: true,
    },
  ];
}

export interface RegisterResult {
  handled: boolean;
  text?: string;
}

/**
 * Register an ask_user prompt synchronously (no network) and return the text to
 * render.  Safe to call from the delivery path.
 */
export function registerAskUser(payload: any, opts: { accountId: string; conversation: string }): RegisterResult {
  const recordId = readQuestionId(payload);
  if (!recordId) return { handled: false };

  const questions = questionsFromPayload(payload, recordId);
  registerPending(makePending({ recordId, questions, accountId: opts.accountId, conversation: opts.conversation }));

  const payloadText = typeof payload?.text === "string" ? payload.text.trim() : "";
  const text = payloadText || (questions.length > 0 ? formatPrompt(questions) : undefined);
  return { handled: true, text };
}

export interface AnswerResult {
  handled: boolean;
  reply?: string;
  error?: string;
  /** The question is gone (timed out/resolved) — note it and dispatch normally. */
  closed?: boolean;
}

/** Fetch authoritative questions; throws a terminal error when the record is gone. */
async function fetchQuestions(recordId: string): Promise<QuestionSpec[] | undefined> {
  const res = await gatewayRequest("question.get", { id: recordId });
  const record = res?.question;
  if (!record || record.status !== "pending") {
    const err: any = new Error("question is no longer pending");
    err.details = { reason: record ? "QUESTION_ALREADY_TERMINAL" : "QUESTION_NOT_FOUND" };
    throw err;
  }
  return normalizeQuestions(record.questions);
}

/**
 * If a question is pending for this conversation, resolve it from the reply.
 * `handled` = answered (reply to send). `closed` = question is gone (note + let
 * the caller dispatch the message). `handled:false` = no question pending.
 */
export async function tryAnswerPending(opts: {
  accountId: string;
  conversation: string;
  sender: string;
  body: string;
}): Promise<AnswerResult> {
  const q = getPending(opts.accountId, opts.conversation);
  if (!q) return { handled: false };

  let questions = q.questions;
  try {
    const fetched = await fetchQuestions(q.recordId);
    if (fetched && fetched.length > 0) questions = fetched;
  } catch (err) {
    if (isTerminalError(err)) {
      clearPending(opts.accountId, opts.conversation);
      return { handled: false, closed: true };
    }
    log.debug("ask_user: question.get failed at answer time; using stored questions", err);
  }

  const parsed = parseAnswer(opts.body, questions);
  if (!parsed) {
    return { handled: true, reply: `Sorry, I didn't understand that.\n\n${formatPrompt(questions)}` };
  }

  try {
    await gatewayRequest("question.resolve", buildResolveParams(q.recordId, parsed.answers, opts.sender));
    clearPending(opts.accountId, opts.conversation);
    return { handled: true, reply: `Answered: ${parsed.summary}` };
  } catch (err: any) {
    clearPending(opts.accountId, opts.conversation);
    if (isTerminalError(err)) return { handled: false, closed: true };
    return { handled: true, error: err?.message || String(err) };
  }
}
