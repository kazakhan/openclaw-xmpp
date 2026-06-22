import type { WhiteboardPath, WhiteboardMove, WhiteboardDelete } from './types.js';

export interface WhiteboardSession {
  jid: string;
  createdAt: number;
  lastActivity: number;
  instructionsSent: boolean;
  autoDrawSent?: boolean;
  paths: WhiteboardPath[];
  moves: WhiteboardMove[];
  deletes: WhiteboardDelete[];
  incomingTimer: NodeJS.Timeout | null;
  protocol: 'swb' | 'sxe';
  sessionId?: string;
  sxeNodes: Record<string, { name: string; parent: string }>;
  sxeAttrs: Record<string, { parent: string; name: string; chdata: string }>;
  svgParentRid?: string;
  ridOffset: number;
}

export class WhiteboardSessionManager {
  private sessions: Map<string, WhiteboardSession>;
  private cleanupInterval: NodeJS.Timeout | null;
  private sessionTimeoutMs: number;

  constructor(sessionTimeoutMs: number = 30 * 60 * 1000) {
    this.sessions = new Map();
    this.sessionTimeoutMs = sessionTimeoutMs;
    this.cleanupInterval = null;
  }

  hasSession(jid: string): boolean {
    return this.sessions.has(jid);
  }

  getSession(jid: string): WhiteboardSession | undefined {
    return this.sessions.get(jid);
  }

  createSession(jid: string, protocol: 'swb' | 'sxe' = 'swb', sessionId?: string): WhiteboardSession {
    const session: WhiteboardSession = {
      jid,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      instructionsSent: false,
      paths: [],
      moves: [],
      deletes: [],
      incomingTimer: null,
      protocol,
      sessionId,
      sxeNodes: {},
      sxeAttrs: {},
      ridOffset: 0
    };
    this.sessions.set(jid, session);
    return session;
  }

  updateSession(jid: string, data: {
    paths?: WhiteboardPath[];
    moves?: WhiteboardMove[];
    deletes?: WhiteboardDelete[];
  }): void {
    const session = this.sessions.get(jid);
    if (!session) {
      return;
    }

    if (data.paths) {
      session.paths.push(...data.paths);
    }

    if (data.moves) {
      session.moves.push(...data.moves);
    }

    if (data.deletes) {
      session.deletes.push(...data.deletes);
    }

    session.lastActivity = Date.now();
  }

  deleteSession(jid: string): void {
    const session = this.sessions.get(jid);
    if (session?.incomingTimer) {
      clearTimeout(session.incomingTimer);
    }
    this.sessions.delete(jid);
  }

  setIncomingTimer(jid: string, callback: () => Promise<void>, delayMs: number): void {
    const session = this.sessions.get(jid);
    if (!session) {
      return;
    }

    if (session.incomingTimer) {
      clearTimeout(session.incomingTimer);
    }

    session.incomingTimer = setTimeout(async () => {
      try {
        await callback();
      } catch (err) {
        console.error(`[WhiteboardSession] Timer callback error for ${jid}:`, err);
      } finally {
        const s = this.sessions.get(jid);
        if (s) s.incomingTimer = null;
      }
    }, delayMs);
  }

  clearIncomingTimer(jid: string): void {
    const session = this.sessions.get(jid);
    if (session?.incomingTimer) {
      clearTimeout(session.incomingTimer);
      session.incomingTimer = null;
    }
  }

  updateActivity(jid: string): void {
    const session = this.sessions.get(jid);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  cleanupStaleSessions(): number {
    const now = Date.now();
    const staleJids: string[] = [];

    for (const [jid, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTimeoutMs) {
        staleJids.push(jid);
      }
    }

    for (const jid of staleJids) {
      this.deleteSession(jid);
    }

    return staleJids.length;
  }

  startCleanup(intervalMs: number): void {
    if (this.cleanupInterval) {
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupStaleSessions();
    }, intervalMs);
  }

  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  destroy(): void {
    this.stopCleanup();
    for (const [jid, session] of this.sessions.entries()) {
      if (session.incomingTimer) {
        clearTimeout(session.incomingTimer);
      }
    }
    this.sessions.clear();
  }

  listSessions(): Array<{ jid: string; session: WhiteboardSession }> {
    const result: Array<{ jid: string; session: WhiteboardSession }> = [];
    for (const [jid, session] of this.sessions.entries()) {
      result.push({ jid, session });
    }
    return result;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
