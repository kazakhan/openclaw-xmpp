export interface XmppConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  resource?: string;
  dataDir?: string;
  adminJid?: string;
  sftpPort?: number;
  autoJoinRooms?: string[];
  rooms?: string[];
  nick?: string;
  vcard?: VCardConfig;
}

export interface VCardConfig {
  fn?: string;
  nickname?: string;
  url?: string;
  desc?: string;
  avatarUrl?: string;
  bday?: string;
  org?: string;
  title?: string;
  role?: string;
}

export interface VCardName {
  family?: string;
  given?: string;
  middle?: string;
  prefix?: string;
  suffix?: string;
}

export interface VCardPhone {
  types: string[];
  number: string;
}

export interface VCardEmail {
  types: string[];
  userid: string;
}

export interface VCardAddress {
  types: string[];
  pobox?: string;
  extadd?: string;
  street?: string;
  locality?: string;
  region?: string;
  pcode?: string;
  ctry?: string;
}

export interface VCardOrg {
  orgname?: string;
  orgunit?: string[];
}

export interface VCardPhoto {
  type?: string;
  binval?: string;
  extval?: string;
}

export interface VCardData {
  version?: string;
  fn?: string;
  n?: VCardName;
  nickname?: string;
  photo?: VCardPhoto;
  bday?: string;
  tel?: VCardPhone[];
  email?: VCardEmail[];
  adr?: VCardAddress[];
  jabberid?: string;
  mailer?: string;
  tz?: string;
  geo?: { lat?: string; lon?: string };
  title?: string;
  role?: string;
  org?: VCardOrg;
  logo?: VCardPhoto;
  categories?: string[];
  note?: string;
  uid?: string;
  url?: string;
  desc?: string;
  rev?: string;
  prodid?: string;
  sortString?: string;

  // Legacy/extra aliases (backward compatibility)
  avatarUrl?: string;
  avatarMimeType?: string;
  avatarData?: string;
}

export interface QueuedMessage {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  accountId: string;
  processed: boolean;
}

export interface MessageOptions {
  type?: 'chat' | 'groupchat';
  room?: string;
  roomJid?: string;
  nick?: string;
  botNick?: string;
  mediaUrls?: string[];
  mediaPaths?: string[];
  whiteboardData?: WhiteboardData;
}

export interface WhiteboardPath {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  id?: string;
}

export interface WhiteboardMove {
  id: string;
  dx: number;
  dy: number;
}

export interface WhiteboardDelete {
  id: string;
}

export interface WhiteboardData {
  type: 'path' | 'move' | 'delete';
  paths?: WhiteboardPath[];
  moves?: WhiteboardMove[];
  deletes?: WhiteboardDelete[];
  rawXml?: string;
}

export interface SlashCommandContext {
  command: string;
  args: string[];
  from: string;
  fromBareJid: string;
  messageType: 'chat' | 'groupchat';
  roomJid: string | null;
  nick: string | null;
  sendReply: (text: string) => Promise<void>;
  checkAdminAccess: () => boolean;
}

export interface Contact {
  jid: string;
  name: string;
}

export interface ContactsData {
  contacts: Contact[];
  admins: string[];
}

export interface RoomInfo {
  roomJid: string;
  nick: string;
}

export interface IbbSession {
  sid: string;
  from: string;
  filename: string;
  size: number;
  data: Buffer;
  received: number;
}

export interface UploadSlot {
  putUrl: string;
  getUrl: string;
  headers?: Record<string, string>;
}

export interface StanzaElement {
  name: string;
  attrs: Record<string, string>;
  children: StanzaElement[];
  getText(): string;
  getChild(name: string, xmlns?: string): StanzaElement | null;
  getChildText(name: string, xmlns?: string): string;
  getChildren(name: string): StanzaElement[];
}

export interface XmppClient {
  send(to: string, body: string): Promise<void>;
  sendGroupchat(to: string, body: string): Promise<void>;
  send(stanza: StanzaElement | any): Promise<any>;
  sendFile(to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void>;
  joinRoom(roomJid: string, nick?: string): Promise<void>;
  leaveRoom(roomJid: string, nick?: string): Promise<void>;
  getJoinedRooms(): string[];
  isInRoom(roomJid: string): boolean;
  iq?(to: string, type: string, payload?: StanzaElement | any): Promise<any>;
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void);
  start(): Promise<any>;
  stop(): Promise<void>;
  roomNicks: Map<string, string>;
}

export interface PluginLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

export interface OnMessageCallback {
  (from: string, body: string, options?: MessageOptions): void;
}

// --- Runtime & Gateway types (Phase 2) ---

export interface AccountSnapshot {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  tokenSource: string;
  running?: boolean;
  lastStartAt?: string | null;
  lastStopAt?: string | null;
  lastError?: string | null;
}

export interface GatewayContext {
  account: {
    accountId: string;
    enabled: boolean;
    config: XmppConfig;
  };
  cfg: XmppConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log?: PluginLogger;
  setStatus: (next: Partial<AccountSnapshot>) => void;
  getStatus: () => AccountSnapshot;
  channelRuntime?: Record<string, unknown>;
}

export interface PluginRuntime {
  channel: {
    session: Record<string, unknown>;
    reply: Record<string, unknown>;
    text?: (session: string, params: Record<string, unknown>) => Promise<unknown>;
    message?: (session: string, params: Record<string, unknown>) => Promise<unknown>;
    activity: { record: (data: unknown) => void };
    [key: string]: unknown;
  };
  dispatchInboundMessage?: (params: Record<string, unknown>) => Promise<void>;
  [key: string]: unknown;
}

export interface SendTextParams {
  to: string;
  text: string;
  accountId?: string;
}

export interface SendMediaParams {
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string;
  deps?: { loadWebMedia?: (url: string) => Promise<{ path?: string; url?: string }> };
  replyToId?: string;
  [key: string]: unknown;
}
