// SECURITY (2.16.0, revised 2.16.1/2.16.2): gateway side of ask_user support.
//
// 2.16.2 fixes: the gateway call must NOT use `runtime.gateway.request` — it
// does not work from the inbound/outbound paths (no active request context) and
// hangs, so answers were never resolved.  We use the in-process gateway client
// (`callGatewayRpc` -> `callGatewayFromCli`) with the `operator.questions`
// scope, which works.  Capture stays synchronous; questions are enriched in the
// background and fetched (with a timeout) at answer time.

import { log } from "./logger.js";
import { callGatewayRpc, type RpcResult } from "../gateway-client.js";
import {
  formatPrompt,
  registerPending,
  getPending,
  clearPending,
  makePending,
  updatePendingQuestions,
  updatePendingAnswers,
  parseAnswer,
  buildResolveParams,
  type QuestionSpec,
} from "./questions.js";

const QUESTION_RECORD_RE = /^ask_[a-f0-9]{32}$/;
const QUESTION_SCOPES = ["operator.questions"];
const QUESTION_RPC_TIMEOUT_MS = 10_000;

function readQuestionId(payload: any): string | undefined {
  const ask = payload?.channelData?.askUser;
  const id = ask && typeof ask === "object" && !Array.isArray(ask) ? ask.questionId : undefined;
  return typeof id === "string" && QUESTION_RECORD_RE.test(id) ? id : undefined;
}

/** Gateway RPC with a hard timeout so a stuck call can't hang the message. */
async function questionRpc(method: string, params: Record<string, unknown>): Promise<RpcResult<any>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<RpcResult<any>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), QUESTION_RPC_TIMEOUT_MS);
    if (typeof (timer as any).unref === "function") (timer as any).unref();
  });
  try {
    return await Promise.race([callGatewayRpc<any>(method, params, QUESTION_SCOPES), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTerminalRpc(rpc: RpcResult<any>): boolean {
  const reason = rpc?.details?.reason;
  if (reason === "QUESTION_ALREADY_TERMINAL" || reason === "QUESTION_NOT_FOUND") return true;
  return /already.?terminal|not.?found/i.test(rpc?.error || "");
}

function terminalError(): Error & { terminal?: boolean } {
  const err: any = new Error("question is no longer pending");
  err.terminal = true;
  return err;
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

async function fetchQuestions(recordId: string): Promise<QuestionSpec[] | undefined> {
  const rpc = await questionRpc("question.get", { id: recordId });
  if (!rpc.ok) {
    if (isTerminalRpc(rpc)) throw terminalError();
    return undefined;
  }
  const record = rpc.data?.question;
  if (!record || record.status !== "pending") throw terminalError();
  return normalizeQuestions(record.questions);
}

/** Background enrichment: fill in the real questions/options after registering. */
function enrichQuestions(recordId: string, accountId: string, conversation: string): void {
  void (async () => {
    try {
      const questions = await fetchQuestions(recordId);
      if (questions && questions.length > 0) updatePendingQuestions(accountId, conversation, questions);
    } catch (err) {
      log.debug("ask_user enrichment failed", err);
    }
  })();
}

export interface RegisterResult {
  handled: boolean;
  text?: string;
}

/** Register an ask_user prompt synchronously (no network) — safe in delivery. */
export function registerAskUser(payload: any, opts: { accountId: string; conversation: string }): RegisterResult {
  const recordId = readQuestionId(payload);
  if (!recordId) return { handled: false };

  const questions = questionsFromPayload(payload, recordId);
  registerPending(makePending({ recordId, questions, accountId: opts.accountId, conversation: opts.conversation }));
  enrichQuestions(recordId, opts.accountId, opts.conversation);

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

function remainingQuestions(questions: QuestionSpec[], answers: Record<string, string[]>): QuestionSpec[] {
  const rem = questions.filter((q) => !(q.questionId in (answers || {})));
  return rem.length > 0 ? rem : questions;
}

/**
 * If a question is pending for this conversation, resolve it from the reply.
 * Handles per-message (partial) answers and late (terminal) answers.
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
    if ((err as any)?.terminal) {
      clearPending(opts.accountId, opts.conversation);
      return { handled: false, closed: true };
    }
    log.debug("ask_user: question.get failed at answer time; using stored questions", err);
  }

  if (questions.length === 0) {
    return { handled: true, reply: "I couldn't load that question — please answer it from the dashboard." };
  }

  const parsed = parseAnswer(opts.body, questions, q.answers);
  if (!parsed) {
    return {
      handled: true,
      reply: `Sorry, I didn't understand that.\n\n${formatPrompt(remainingQuestions(questions, q.answers))}`,
    };
  }

  if (parsed.remaining.length > 0) {
    updatePendingAnswers(opts.accountId, opts.conversation, parsed.answers);
    return {
      handled: true,
      reply: `Got it: ${parsed.summary}\n\nStill need:\n${formatPrompt(parsed.remaining)}`,
    };
  }

  const rpc = await questionRpc("question.resolve", buildResolveParams(q.recordId, parsed.answers, opts.sender));
  if (!rpc.ok) {
    clearPending(opts.accountId, opts.conversation);
    if (isTerminalRpc(rpc)) return { handled: false, closed: true };
    return { handled: true, error: rpc.error || "unknown error" };
  }
  clearPending(opts.accountId, opts.conversation);
  return { handled: true, reply: `Answered: ${parsed.summary}` };
}
