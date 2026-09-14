import fsp from "fs/promises";
import path from "path";

// Minimal logger surface (injected, so this module stays dependency-free and
// directly unit-testable under `node --test`).
export interface PresenceLogger {
  debug: (...args: any[]) => void;
}
const NOOP_LOGGER: PresenceLogger = { debug: () => {} };

// SECURITY (2.15.0): XMPP presence/status manager.
//
// Supports:
//   - built-in shows (available/chat/away/xa/dnd) + friendly aliases
//   - custom status messages
//   - a manual override (set by the agent/human) that wins over auto-activity
//     until cleared or until `manualTtlSeconds`
//   - auto-activity ("busy while thinking / running a tool") driven by the
//     OpenClaw agent lifecycle hooks, with coalescing + throttling so a
//     multi-step tool loop does not storm the roster with presence stanzas
//   - persistence, so a custom status survives reconnect/restart

export type PresenceShow = "available" | "chat" | "away" | "xa" | "dnd";
export const PRESENCE_SHOWS: PresenceShow[] = ["available", "chat", "away", "xa", "dnd"];

const SHOW_ALIASES: Record<string, PresenceShow> = {
  online: "available",
  available: "available",
  free: "chat",
  chat: "chat",
  "free-for-chat": "chat",
  away: "away",
  idle: "away",
  xa: "xa",
  "extended-away": "xa",
  dnd: "dnd",
  busy: "dnd",
  "do-not-disturb": "dnd",
};

/** Normalize a user-supplied show value to a valid XMPP show, or null. */
export function normalizeShow(input?: string | null): PresenceShow | null {
  if (!input) return null;
  return SHOW_ALIASES[String(input).trim().toLowerCase()] || null;
}

export type PresenceSource = "default" | "manual" | "auto";

export interface PresenceConfig {
  enabled?: boolean;
  defaultShow?: string;
  defaultStatus?: string;
  thinkingShow?: string;
  thinkingStatus?: string;
  toolShow?: string;
  toolStatus?: string;
  minIntervalSeconds?: number;
  manualTtlSeconds?: number;
  restoreOnReconnect?: boolean;
}

export interface EffectivePresence {
  show: PresenceShow;
  status: string;
  priority?: number;
  source: PresenceSource;
}

export interface PresenceSnapshot extends EffectivePresence {
  autoActive: boolean;
  manualActive: boolean;
  manualExpiresAt?: number;
}

interface ManualOverride {
  show: PresenceShow;
  status: string;
  priority?: number;
  expiresAt?: number;
}

interface PersistedState {
  manual?: ManualOverride | null;
  since?: number;
}

export interface ActivityEvent {
  type: "run-start" | "run-end" | "thinking-start" | "thinking-end" | "tool-start" | "tool-end" | "clear";
  runId?: string;
  toolName?: string;
}

export interface PresenceManagerDeps {
  dataDir: string;
  cfg?: PresenceConfig;
  /** Sends a presence stanza. `show` omits the <show/> element when "available". */
  send: (show?: string, status?: string, priority?: number) => Promise<void>;
  /** Optional logger (defaults to a no-op so the module is dependency-free). */
  log?: PresenceLogger;
}

const DEFAULTS = {
  enabled: true,
  defaultShow: "available" as PresenceShow,
  defaultStatus: "",
  thinkingShow: "dnd" as PresenceShow,
  thinkingStatus: "Thinking…",
  toolShow: "dnd" as PresenceShow,
  toolStatus: "Running {tool}…",
  minIntervalSeconds: 5,
  manualTtlSeconds: 0,
  restoreOnReconnect: true,
};

function pickShow(value: string | undefined, fallback: PresenceShow): PresenceShow {
  const normalized = normalizeShow(value);
  return normalized || fallback;
}

export class PresenceManager {
  private cfg: typeof DEFAULTS;
  private dataDir: string;
  private sendFn: PresenceManagerDeps["send"];
  private log: PresenceLogger = NOOP_LOGGER;

  private manual: ManualOverride | null = null;
  private manualTimer: ReturnType<typeof setTimeout> | null = null;

  // Auto-activity tracking
  private activeRuns = new Set<string>();
  private thinkingCalls = 0;
  private activeTools = 0;
  private lastToolName = "";

  // Throttle / coalesce
  private lastSent: { show: PresenceShow; status: string; priority?: number } | null = null;
  private lastSentAt = 0;
  private pending: EffectivePresence | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  private ready: Promise<void>;

  constructor(deps: PresenceManagerDeps) {
    this.dataDir = deps.dataDir;
    this.sendFn = deps.send;
    this.log = deps.log || NOOP_LOGGER;
    const c = deps.cfg || {};
    this.cfg = {
      enabled: c.enabled ?? DEFAULTS.enabled,
      defaultShow: pickShow(c.defaultShow, DEFAULTS.defaultShow),
      defaultStatus: c.defaultStatus ?? DEFAULTS.defaultStatus,
      thinkingShow: pickShow(c.thinkingShow, DEFAULTS.thinkingShow),
      thinkingStatus: c.thinkingStatus ?? DEFAULTS.thinkingStatus,
      toolShow: pickShow(c.toolShow, DEFAULTS.toolShow),
      toolStatus: c.toolStatus ?? DEFAULTS.toolStatus,
      minIntervalSeconds:
        typeof c.minIntervalSeconds === "number" && c.minIntervalSeconds >= 0
          ? c.minIntervalSeconds
          : DEFAULTS.minIntervalSeconds,
      manualTtlSeconds:
        typeof c.manualTtlSeconds === "number" && c.manualTtlSeconds >= 0
          ? c.manualTtlSeconds
          : DEFAULTS.manualTtlSeconds,
      restoreOnReconnect: c.restoreOnReconnect ?? DEFAULTS.restoreOnReconnect,
    };
    this.ready = this.load();
  }

  private get stateFile(): string {
    return path.join(this.dataDir || ".", "xmpp-presence.json");
  }

  private async load(): Promise<void> {
    try {
      await fsp.mkdir(this.dataDir || ".", { recursive: true });
      const raw = await fsp.readFile(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      const m = parsed?.manual;
      if (m && (!m.expiresAt || m.expiresAt > Date.now())) {
        const show = normalizeShow(m.show);
        if (show) {
          this.manual = { show, status: m.status || "", priority: m.priority, expiresAt: m.expiresAt };
          this.scheduleManualExpiry();
        }
      }
    } catch {
      /* no prior state — fine */
    }
  }

  private persist(): void {
    const state: PersistedState = { manual: this.manual, since: Date.now() };
    fsp
      .mkdir(this.dataDir || ".", { recursive: true })
      .then(() => fsp.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8"))
      .catch((err) => this.log.debug("presence persist failed", err));
  }

  private scheduleManualExpiry(): void {
    if (this.manualTimer) {
      clearTimeout(this.manualTimer);
      this.manualTimer = null;
    }
    if (this.manual?.expiresAt) {
      const delay = Math.max(0, this.manual.expiresAt - Date.now());
      this.manualTimer = setTimeout(() => {
        this.manualTimer = null;
        this.manual = null;
        this.persist();
        void this.emit();
      }, delay);
      if (this.manualTimer.unref) this.manualTimer.unref();
    }
  }

  private manualIsActive(now = Date.now()): boolean {
    if (!this.manual) return false;
    if (this.manual.expiresAt && this.manual.expiresAt <= now) return false;
    return true;
  }

  private autoIsActive(): boolean {
    return this.activeRuns.size > 0 || this.thinkingCalls > 0 || this.activeTools > 0;
  }

  private getDefault(): EffectivePresence {
    return { show: this.cfg.defaultShow, status: this.cfg.defaultStatus, source: "default" };
  }

  /** Compute the effective presence (manual > auto > default). */
  getEffective(now = Date.now()): EffectivePresence {
    if (this.manualIsActive(now)) {
      return {
        show: this.manual!.show,
        status: this.manual!.status,
        priority: this.manual!.priority,
        source: "manual",
      };
    }
    if (this.cfg.enabled && this.autoIsActive()) {
      if (this.activeTools > 0) {
        const status = this.cfg.toolStatus.replace(/\{tool\}/g, this.lastToolName || "a tool");
        return { show: this.cfg.toolShow, status, source: "auto" };
      }
      return { show: this.cfg.thinkingShow, status: this.cfg.thinkingStatus, source: "auto" };
    }
    return this.getDefault();
  }

  getSnapshot(): PresenceSnapshot {
    const eff = this.getEffective();
    return {
      ...eff,
      autoActive: this.autoIsActive(),
      manualActive: this.manualIsActive(),
      manualExpiresAt: this.manual?.expiresAt,
    };
  }

  /**
   * Send presence immediately (used on connect/probe).
   * Honours `restoreOnReconnect`: when false, the default presence is sent
   * instead of a restored manual/auto one.
   */
  async announce(): Promise<void> {
    await this.ready;
    const eff = this.cfg.restoreOnReconnect ? this.getEffective() : this.getDefault();
    this.lastSent = { show: eff.show, status: eff.status, priority: eff.priority };
    this.lastSentAt = Date.now();
    await this.doSend(eff);
  }

  /** Set the manual override (agent/human). */
  async setManual(show: string, status?: string, priority?: number, ttlSeconds?: number): Promise<EffectivePresence> {
    await this.ready;
    const normalized = normalizeShow(show);
    if (!normalized) throw new Error(`Invalid presence show: ${show}`);
    const ttl = typeof ttlSeconds === "number" ? ttlSeconds : this.cfg.manualTtlSeconds;
    this.manual = {
      show: normalized,
      status: status ?? "",
      priority,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : undefined,
    };
    this.scheduleManualExpiry();
    this.persist();
    await this.emit(true);
    return this.getEffective();
  }

  /** Clear the manual override, reverting to auto/default. */
  async clearManual(): Promise<EffectivePresence> {
    await this.ready;
    this.manual = null;
    if (this.manualTimer) {
      clearTimeout(this.manualTimer);
      this.manualTimer = null;
    }
    this.persist();
    await this.emit(true);
    return this.getEffective();
  }

  /** Feed an OpenClaw agent-lifecycle event into the auto-activity state. */
  notifyActivity(event: ActivityEvent): void {
    switch (event.type) {
      case "run-start":
        this.activeRuns.add(event.runId || `run-${this.activeRuns.size + 1}`);
        break;
      case "run-end":
        if (event.runId) this.activeRuns.delete(event.runId);
        else this.activeRuns.clear();
        break;
      case "thinking-start":
        this.thinkingCalls++;
        break;
      case "thinking-end":
        this.thinkingCalls = Math.max(0, this.thinkingCalls - 1);
        break;
      case "tool-start":
        this.activeTools++;
        if (event.toolName) this.lastToolName = event.toolName;
        break;
      case "tool-end":
        this.activeTools = Math.max(0, this.activeTools - 1);
        break;
      case "clear":
        this.activeRuns.clear();
        this.thinkingCalls = 0;
        this.activeTools = 0;
        break;
    }
    void this.emit();
  }

  /** Coalesce + throttle; sends only when the effective presence changed. */
  private async emit(force = false): Promise<void> {
    await this.ready;
    const eff = this.getEffective();
    if (!force && this.lastSent && this.same(eff, this.lastSent)) {
      // Reverted to the last-sent value before the trailing flush — cancel it.
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
        this.pending = null;
      }
      return;
    }
    const minMs = this.cfg.minIntervalSeconds * 1000;
    const elapsed = Date.now() - this.lastSentAt;
    if (!force && elapsed < minMs) {
      this.pending = eff;
      if (!this.pendingTimer) {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          const p = this.pending;
          this.pending = null;
          if (p) void this.flushPending();
        }, minMs - elapsed);
        if (this.pendingTimer.unref) this.pendingTimer.unref();
      }
      return;
    }
    await this.doFlush(eff);
  }

  private async flushPending(): Promise<void> {
    const eff = this.getEffective();
    if (this.lastSent && this.same(eff, this.lastSent)) return;
    await this.doFlush(eff);
  }

  private async doFlush(eff: EffectivePresence): Promise<void> {
    this.lastSent = { show: eff.show, status: eff.status, priority: eff.priority };
    this.lastSentAt = Date.now();
    await this.doSend(eff);
  }

  private async doSend(eff: EffectivePresence): Promise<void> {
    try {
      const show = eff.show === "available" ? undefined : eff.show;
      await this.sendFn(show, eff.status || undefined, eff.priority);
    } catch (err) {
      this.log.debug("presence send failed", err);
    }
  }

  private same(
    a: { show: string; status?: string; priority?: number },
    b: { show: string; status?: string; priority?: number },
  ): boolean {
    return (a.show || "") === (b.show || "") && (a.status || "") === (b.status || "") && a.priority === b.priority;
  }

  /** Cancel timers (tests / shutdown). */
  dispose(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.manualTimer) clearTimeout(this.manualTimer);
    this.pendingTimer = null;
    this.manualTimer = null;
  }
}

/** Read the per-account presence config, falling back to defaults. */
export function readPresenceConfig(accountCfg: any): PresenceConfig {
  return (accountCfg && accountCfg.presence) || {};
}

/** Validate + summarize persisted presence for diagnostics. */
export function describePresence(snapshot: PresenceSnapshot): string {
  const flags: string[] = [snapshot.source];
  if (snapshot.autoActive) flags.push("auto-active");
  if (snapshot.manualActive) flags.push("manual");
  return `${snapshot.show}${snapshot.status ? ` (${snapshot.status})` : ""} [${flags.join(", ")}]`;
}
