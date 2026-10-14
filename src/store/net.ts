// ============================================================================
// 多人对战（局域网 / 公网服务器）WebSocket 客户端
// - 身份：匿名会话 ID（store/session.getSession）；URL 参数 ?as=<名字> 时改用独立身份
//   （localStorage 键 d2m:session:<名字>），便于同一浏览器多标签模拟多名玩家（docs/MULTIPLAYER.md §7）。
// - 服务器地址：默认当前页面同源 + WS_PATH；可手动填写 ip:端口（记在 localStorage）。
// - 断线自动重连（指数退避），重连后重新发送 hello，服务器按 sessionId 把玩家放回原座位。
//   会话 ID 只发给服务器：房间信息里没有任何会话 ID，座位用服务器生成的座位键识别（RoomInfo.yourSeatKey / hostSeatKey）。
// - 消息收发均按 src/shared/protocol.ts 的类型约束。
// 本模块不依赖 React / store，store/gameStore.ts 订阅它的消息与状态。
// ============================================================================
import { DEFAULT_SERVER_PORT, PROTOCOL_VERSION, WS_PATH, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { getSession } from './session';

// ---------------------------------------------------------------------------
// localStorage 安全访问
// ---------------------------------------------------------------------------
function ls(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
function lsGet(key: string): string | null {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) ls()?.removeItem(key);
    else ls()?.setItem(key, value);
  } catch {
    /* 隐私模式等：本次会话内仍可用 */
  }
}

/** 页面地址（Node 环境下不存在；不直接引用 DOM 全局，便于 tests/ 在 Node 下导入 store） */
function pageLocation(): { search: string; protocol: string; host: string } | null {
  const loc = (globalThis as unknown as { location?: { search?: string; protocol?: string; host?: string } }).location;
  return loc && typeof loc.protocol === 'string' ? { search: loc.search ?? '', protocol: loc.protocol, host: loc.host ?? '' } : null;
}

/**
 * 随机 ID（会话 ID 是重连回座位的凭证）：优先 crypto.randomUUID；不安全上下文（如 http://公网 IP）中没有 randomUUID，
 * 改用同样不可预测的 crypto.getRandomValues（128 位）；两者都不可用时才退回 Math.random。
 */
function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const b = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* ignore */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// 身份
// ---------------------------------------------------------------------------
export interface NetIdentity {
  /** 发给服务器的会话 ID（断线重连回到原座位） */
  sessionId: string;
  /** 测试身份名（?as=<名字>）；null = 本浏览器默认会话 */
  alias: string | null;
  /** 默认昵称 */
  defaultName: string;
}

/** URL 参数 ?as=<名字>（多标签测试身份），最多 24 字 */
export function testAlias(): string | null {
  try {
    const loc = pageLocation();
    if (!loc) return null;
    const v = new URLSearchParams(loc.search).get('as');
    const t = v?.trim().slice(0, 24);
    return t ? t : null;
  } catch {
    return null;
  }
}

let cachedIdentity: NetIdentity | null = null;

/** 当前多人身份：默认 = 匿名会话；?as=<名字> → 独立身份 d2m:session:<名字> */
export function getNetIdentity(): NetIdentity {
  if (cachedIdentity) return cachedIdentity;
  const alias = testAlias();
  if (!alias) {
    const s = getSession();
    cachedIdentity = { sessionId: s.id, alias: null, defaultName: s.name };
    return cachedIdentity;
  }
  const key = `d2m:session:${alias}`;
  let id: string | null = null;
  try {
    const raw = lsGet(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { id?: unknown };
      if (parsed && typeof parsed.id === 'string') id = parsed.id;
    }
  } catch {
    /* 损坏则重建 */
  }
  if (!id) {
    id = randomId();
    lsSet(key, JSON.stringify({ id, kind: 'anonymous', name: alias, createdAt: new Date().toISOString() }));
  }
  cachedIdentity = { sessionId: id, alias, defaultName: alias };
  return cachedIdentity;
}

const NAME_KEY = () => {
  const alias = getNetIdentity().alias;
  return alias ? `d2m:mp:name:${alias}` : 'd2m:mp:name';
};
const SERVER_KEY = 'd2m:mp:server';

/** 多人昵称（记在本地；?as 身份各自独立） */
export function getPlayerName(): string {
  const saved = lsGet(NAME_KEY())?.trim();
  return saved ? saved.slice(0, 16) : getNetIdentity().defaultName.slice(0, 16);
}
export function savePlayerName(name: string): string {
  const n = name.trim().slice(0, 16);
  if (n) lsSet(NAME_KEY(), n);
  return n || getPlayerName();
}

// ---------------------------------------------------------------------------
// 断线恢复：在房间内时记下房间码（按身份），刷新 / 重新打开页面后自动回到多人模式，
// 服务器按会话 ID 把玩家放回原座位。主动离开房间 / 退出多人时清除。
// ---------------------------------------------------------------------------
const RESUME_TTL_MS = 24 * 60 * 60 * 1000;
const RESUME_KEY = () => {
  const alias = getNetIdentity().alias;
  return alias ? `d2m:mp:resume:${alias}` : 'd2m:mp:resume';
};

/** 上次所在的多人房间（24 小时内）；null = 无需恢复 */
export function getMpResume(): { roomId: string; at: number } | null {
  try {
    const raw = lsGet(RESUME_KEY());
    if (!raw) return null;
    const v = JSON.parse(raw) as { roomId?: unknown; at?: unknown };
    if (!v || typeof v.roomId !== 'string' || typeof v.at !== 'number') return null;
    if (Date.now() - v.at > RESUME_TTL_MS) return null;
    return { roomId: v.roomId, at: v.at };
  } catch {
    return null;
  }
}

export function setMpResume(roomId: string | null): void {
  lsSet(RESUME_KEY(), roomId ? JSON.stringify({ roomId, at: Date.now() }) : null);
}

// ---------------------------------------------------------------------------
// 服务器地址
// ---------------------------------------------------------------------------
/** 默认服务器：当前页面同源 + WS_PATH（开发服务器下由 vite 代理到本机 8686） */
export function defaultServerUrl(): string {
  try {
    const loc = pageLocation();
    if (loc && /^https?:$/.test(loc.protocol) && loc.host) {
      return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${WS_PATH}`;
    }
  } catch {
    /* ignore */
  }
  return `ws://localhost:${DEFAULT_SERVER_PORT}${WS_PATH}`;
}

/**
 * 把用户输入的地址规范化为 WebSocket URL：
 * 「192.168.1.5:8686」「192.168.1.5」「http://host:port」「ws://host:port/ws」均可。返回 null = 无法识别。
 */
export function normalizeServerAddress(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    if (!u.port && u.protocol === 'ws:') u.port = String(DEFAULT_SERVER_PORT);
    if (!u.pathname || u.pathname === '/') u.pathname = WS_PATH;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** 手动填写的服务器地址（原样，如 192.168.1.5:8686）；null = 使用默认 */
export function getManualServer(): string | null {
  const v = lsGet(SERVER_KEY)?.trim();
  return v ? v : null;
}
export function setManualServer(addr: string | null): void {
  lsSet(SERVER_KEY, addr && addr.trim() ? addr.trim() : null);
}

/** 当前应连接的服务器 URL */
export function resolveServerUrl(): string {
  const manual = getManualServer();
  return (manual && normalizeServerAddress(manual)) || defaultServerUrl();
}

/**
 * 邀请朋友打开的网页地址（不含任何服务器下发的内网地址）：使用默认服务器（本页同源）时为当前页面的 origin；
 * 手动填写了其他服务器时为该服务器的网页地址。
 */
export function invitePageUrl(): string {
  const manual = getManualServer();
  const manualWs = manual ? normalizeServerAddress(manual) : null;
  if (manualWs) return httpUrlOf(manualWs);
  const loc = pageLocation();
  if (loc && /^https?:$/.test(loc.protocol) && loc.host) return `${loc.protocol}//${loc.host}`;
  return httpUrlOf(defaultServerUrl());
}

/** 由 ws URL 推出给朋友打开的网页地址（http://host:port） */
export function httpUrlOf(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    return u.toString().replace(/\/$/, '');
  } catch {
    return wsUrl;
  }
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------
export type NetStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetState {
  status: NetStatus;
  url: string;
  /** 连续失败次数（重连中） */
  attempt: number;
  /** 下一次重连的时间戳（ms） */
  retryAt: number | null;
  /** 最近一次错误/关闭原因 */
  error: string | null;
  /** 服务器以「不应自动重连」的关闭码断开时的关闭码（4000 = 被其他页面顶替，4002 = 协议版本不一致） */
  closeCode?: number;
}

/** 服务器关闭码 → 不再自动重连的原因（server/rooms.ts） */
export const NO_RETRY_CLOSE: Record<number, string> = {
  4000: '同一身份已在其他页面连接，此页面已断开（为避免两个页面互相顶替，不再自动重连）',
  4002: '客户端与服务器版本不一致，请刷新页面后重试',
};

type MsgListener = (msg: ServerMsg) => void;
type StatusListener = (s: NetState) => void;

const BACKOFF_BASE_MS = 600;
const BACKOFF_MAX_MS = 15000;
const CONNECT_TIMEOUT_MS = 8000;

function isServerMsg(v: unknown): v is ServerMsg {
  return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

/** 去掉末尾的 undefined 参数（JSON 会把数组中的 undefined 变成 null，引擎可选参数需保持"未传"语义） */
export function trimArgs(args: unknown[]): unknown[] {
  const out = args.slice();
  while (out.length && out[out.length - 1] === undefined) out.pop();
  return out;
}

class NetClient {
  private ws: WebSocket | null = null;
  private msgListeners = new Set<MsgListener>();
  private statusListeners = new Set<StatusListener>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 用户主动断开后不再重连 */
  private wantOpen = false;
  private helloName = '';
  state: NetState = { status: 'idle', url: '', attempt: 0, retryAt: null, error: null };

  onMessage(fn: MsgListener): () => void {
    this.msgListeners.add(fn);
    return () => this.msgListeners.delete(fn);
  }
  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setState(patch: Partial<NetState>): void {
    this.state = { ...this.state, ...patch };
    this.statusListeners.forEach((fn) => fn(this.state));
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** 连接（或切换到）服务器；name = hello 时发送的昵称 */
  connect(url: string, name: string): void {
    this.helloName = name;
    this.wantOpen = true;
    if (this.ws && this.state.url === url && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.teardown();
    this.setState({ url, attempt: 0, retryAt: null, error: null, closeCode: undefined });
    this.open();
  }

  /** 主动断开（不再重连） */
  disconnect(): void {
    this.wantOpen = false;
    this.teardown();
    this.setState({ status: 'closed', attempt: 0, retryAt: null });
  }

  /** 立即重连（跳过退避等待） */
  reconnectNow(): void {
    if (!this.state.url) return;
    this.wantOpen = true;
    this.teardown();
    this.open();
  }

  /** 更新昵称：已连接时重新发送 hello */
  setName(name: string): void {
    this.helloName = name;
    if (this.isOpen) this.sendHello();
  }

  send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private sendHello(): void {
    const id = getNetIdentity();
    this.send({ t: 'hello', sessionId: id.sessionId, name: this.helloName || getPlayerName(), protocol: PROTOCOL_VERSION });
  }

  private teardown(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.retryTimer = null;
    this.connectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') {
      this.setState({ status: 'closed', error: '当前环境不支持 WebSocket' });
      return;
    }
    const url = this.state.url;
    this.setState({ status: this.state.attempt > 0 ? 'reconnecting' : 'connecting', retryAt: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.setState({ error: `地址无效：${(err as Error).message}` });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== 1) {
        this.setState({ error: '连接超时' });
        try {
          ws.close();
        } catch {
          /* onclose 中重连 */
        }
      }
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.setState({ status: 'open', attempt: 0, retryAt: null, error: null, closeCode: undefined });
      this.sendHello();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!isServerMsg(msg)) return;
      this.msgListeners.forEach((fn) => {
        try {
          fn(msg as ServerMsg);
        } catch (err) {
          console.error('[net]', err);
        }
      });
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.setState({ error: '无法连接到服务器' });
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.ws = null;
      // 不应自动重连的关闭：同一身份在其他页面连接（否则两个页面会互相顶替）/ 协议版本不一致（重连也无用）
      const fatal = NO_RETRY_CLOSE[ev.code];
      if (fatal) {
        this.wantOpen = false;
        this.setState({ status: 'closed', attempt: 0, retryAt: null, error: fatal, closeCode: ev.code });
        return;
      }
      if (ev.reason) this.setState({ error: ev.reason });
      if (this.wantOpen) this.scheduleRetry();
      else this.setState({ status: 'closed' });
    };
  }

  private scheduleRetry(): void {
    if (!this.wantOpen) return;
    const attempt = this.state.attempt + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)) * (0.85 + Math.random() * 0.3);
    this.setState({ status: 'reconnecting', attempt, retryAt: Date.now() + delay });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantOpen) this.open();
    }, delay);
  }
}

/** 全局唯一的连接 */
export const net = new NetClient();

/**
 * 订阅服务器对某类请求的拒绝（error 消息带 ref，如房主的 startGame 被拒绝），返回取消订阅函数。
 * 提示文字仍由 store 统一弹出；界面用它复位「处理中」的按钮并就地显示原因。
 */
export function onRequestError(ref: ClientMsg['t'], fn: (message: string) => void): () => void {
  return net.onMessage((msg) => {
    if (msg.t === 'error' && msg.ref === ref) fn(msg.message || '请求被服务器拒绝');
  });
}
