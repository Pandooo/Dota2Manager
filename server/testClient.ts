// ============================================================================
// 测试/脚本用的协议客户端（Node，ws）：收集消息、按条件等待、RPC 调用。
// tests/server.test.ts 与 scripts/mp-e2e.ts 共用。
// ============================================================================
import { WebSocket } from 'ws';
import type { GameState } from '../src/engine/types';
import { PROTOCOL_VERSION, isRoomHost, mySeat } from '../src/shared/protocol';
import type { ClientMsg, FeedItem, RoomInfo, RoomSeat, RoomSummary, RoundStatus, ServerMsg } from '../src/shared/protocol';

type Waiter = { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface CallReply {
  ok: boolean;
  message: string;
  result?: unknown;
}

export class TestClient {
  readonly ws: WebSocket;
  readonly label: string;
  sessionId: string;
  name: string;
  /** 收到的全部消息（按顺序） */
  readonly log: ServerMsg[] = [];
  room: RoomInfo | null = null;
  rooms: RoomSummary[] = [];
  state: GameState | null = null;
  version = -1;
  roundStatus: RoundStatus | null = null;
  feeds: FeedItem[] = [];
  errors: string[] = [];
  /** 校验失败记录（onState 抛出的错误、版本倒退等） */
  violations: string[] = [];
  stateCount = 0;
  /** state 消息的累计/最大字节数（未压缩的 JSON） */
  stateBytes = 0;
  maxStateBytes = 0;
  closed = false;
  closeCode: number | null = null;
  /** 每次收到 state 时调用（隐私检查等） */
  onState: ((state: GameState, client: TestClient) => void) | null = null;
  /** 每次收到非空 room 时调用（抛出的错误记入 violations） */
  onRoom: ((room: RoomInfo, client: TestClient) => void) | null = null;
  private waiters: Waiter[] = [];
  private reqSeq = 0;
  private opened: Promise<void>;

  constructor(url: string, opts: { sessionId: string; name: string; label?: string }) {
    this.sessionId = opts.sessionId;
    this.name = opts.name;
    this.label = opts.label ?? opts.name;
    this.ws = new WebSocket(url, { perMessageDeflate: true });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ws.on('message', (data) => this.onMessage(String(data)));
    this.ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`[${this.label}] 连接已关闭（${code}）`));
      }
    });
    this.ws.on('error', () => undefined);
  }

  private onMessage(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    this.log.push(msg);
    switch (msg.t) {
      case 'room':
        this.room = msg.room;
        if (msg.room) {
          try {
            this.onRoom?.(msg.room, this);
          } catch (err) {
            this.violations.push((err as Error).message);
          }
        }
        break;
      case 'roomList':
        this.rooms = msg.rooms;
        break;
      case 'state':
        if (msg.version < this.version) this.violations.push(`收到旧版本视图 ${msg.version} < ${this.version}`);
        this.state = msg.state;
        this.version = msg.version;
        this.stateCount++;
        this.stateBytes += raw.length;
        this.maxStateBytes = Math.max(this.maxStateBytes, raw.length);
        try {
          this.onState?.(msg.state, this);
        } catch (err) {
          this.violations.push((err as Error).message);
        }
        break;
      case 'roundStatus':
        this.roundStatus = msg.status;
        break;
      case 'feed':
        this.feeds.push(...msg.items);
        break;
      case 'error':
        this.errors.push(msg.message);
        break;
      default:
        break;
    }
    for (const w of [...this.waiters]) {
      let hit = false;
      try {
        hit = w.pred(msg);
      } catch {
        hit = false;
      }
      if (hit) {
        clearTimeout(w.timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  }

  async open(): Promise<void> {
    await this.opened;
  }

  send(msg: ClientMsg | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** 等待满足条件的下一条消息（只看之后收到的消息） */
  waitFor<T extends ServerMsg['t']>(
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Extract<ServerMsg, { t: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`[${this.label}] 等待 ${t} 超时`));
      }, timeoutMs);
      const w: Waiter = {
        pred: (m) => m.t === t && pred(m as Extract<ServerMsg, { t: T }>),
        resolve: (m) => resolve(m as Extract<ServerMsg, { t: T }>),
        reject,
        timer,
      };
      this.waiters.push(w);
    });
  }

  /** 发送并等待某类回复（或 error，先到者为准） */
  request<T extends ServerMsg['t']>(
    msg: ClientMsg | Record<string, unknown>,
    t: T,
    pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Extract<ServerMsg, { t: T }> | { t: 'error'; message: string }> {
    const p = new Promise<ServerMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`[${this.label}] 等待 ${t} 超时`));
      }, timeoutMs);
      const w: Waiter = {
        pred: (m) => m.t === 'error' || (m.t === t && pred(m as Extract<ServerMsg, { t: T }>)),
        resolve,
        reject,
        timer,
      };
      this.waiters.push(w);
    });
    this.send(msg);
    return p as Promise<Extract<ServerMsg, { t: T }> | { t: 'error'; message: string }>;
  }

  async hello(): Promise<void> {
    await this.open();
    const r = await this.request({ t: 'hello', sessionId: this.sessionId, name: this.name, protocol: PROTOCOL_VERSION }, 'welcome');
    if (r.t === 'error') throw new Error(`[${this.label}] hello 失败：${r.message}`);
  }

  /** RPC 调用：等待 callResult（服务器先推送新视图再回复，因此返回时 this.state 已是最新） */
  async call(fn: string, ...args: unknown[]): Promise<CallReply> {
    const reqId = ++this.reqSeq;
    const p = this.waitFor('callResult', (m) => m.reqId === reqId, 60_000);
    this.send({ t: 'call', reqId, fn, args });
    const r = await p;
    return { ok: r.ok, message: r.message, result: r.result };
  }

  /** 发送 call 但不等待（用于抢签等并发场景），返回等待结果的 Promise */
  callAsync(fn: string, ...args: unknown[]): Promise<CallReply> {
    const reqId = ++this.reqSeq;
    const p = this.waitFor('callResult', (m) => m.reqId === reqId, 60_000);
    this.send({ t: 'call', reqId, fn, args });
    return p.then((r) => ({ ok: r.ok, message: r.message, result: r.result }));
  }

  /** 当前视图中的自己战队 id */
  get teamId(): string | null {
    return this.state?.settings?.playerTeamId ?? null;
  }

  /** 房间信息中自己的座位（按 yourSeatKey） */
  get seat(): RoomSeat | undefined {
    return mySeat(this.room);
  }

  /** 自己是否为房主 */
  get isHost(): boolean {
    return isRoomHost(this.room);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
      setTimeout(resolve, 1000).unref?.();
    });
  }
}

/** 等待直到条件成立（轮询） */
export async function until(cond: () => boolean, timeoutMs = 10_000, what = '条件'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待${what}超时`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
