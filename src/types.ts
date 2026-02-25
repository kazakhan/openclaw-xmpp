export interface XmppConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  resource?: string;
  dataDir: string;
  adminJid?: string;
  rooms?: string[];
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

export interface XmppClient {
  xmpp: any;
  status?: string;
  send: (to: string, body: string) => Promise<void>;
  sendGroupchat: (to: string, body: string) => Promise<void>;
  joinRoom: (roomJid: string, nick?: string) => Promise<void>;
  leaveRoom: (roomJid: string, nick?: string) => Promise<void>;
  getJoinedRooms: () => string[];
  isInRoom: (roomJid: string) => boolean;
  iq: (to: string, type: string, payload?: any) => Promise<void>;
  sendFile: (to: string, filePath: string, text?: string, isGroupChat?: boolean) => Promise<void>;
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
