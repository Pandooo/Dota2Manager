// ============================================================================
// 房间与连接管理（权威服务器核心）
// - 连接：hello 绑定会话 ID；同一会话的新连接顶替旧连接（断线重连回到原座位）。
// - 大厅：listRooms / createRoom / joinRoom / leaveRoom / updateSettings / updateSeat / setLobbyReady / kick / startGame。
// - 游戏：call（白名单 RPC）按到达顺序在房间的串行队列中执行 → callResult + 其他玩家的 feed + 各座位视图；
//         setRoundReady → 全员准备后 advanceMultiplayer → 全员 state + feed + roundStatus。
// - 视图推送节流：每个客户端 ≤ 1000/stateIntervalMs 次/秒，操作者本人的更新立即发送。
// - 任何异常都不会让进程崩溃：消息处理全部 try/catch，引擎异常转为错误回复。
// - 会话 ID 只在服务器内部（StoredRoom）：发给客户端的房间信息用每个房间独立的随机座位键（seatKey）识别座位。
// - 定期清理（sweep）：无人在线的大厅房间、无人在线超过宽限期的已结束对局、长时间无人在线的进行中对局（删除存档文件）。
// ============================================================================
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { GameState, NewsItem, OpResult } from '../src/engine/types';
import type { MpNewGameOptions, MpPlayerSpec } from '../src/engine/multi';
import { MAX_TI } from '../src/engine/config';
import { PROTOCOL_VERSION, RPC_TEAM_ARG } from '../src/shared/protocol';
import type {
  ClientMsg, FeedItem, RoomInfo, RoomSeat, RoomSettings, RoomSummary, RoundStatus, RpcName, ServerMsg,
} from '../src/shared/protocol';
import type { MpEngine } from './engine';
import { seatsOf } from './engine';
import { ROOM_FILE_FORMAT, type RoomFile, type RoomStore, type StoredRoom, type StoredSeat } from './persistence';
import { LIMITS, cleanText, parseClientMsg, parseNewClub } from './validate';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** WebSocket 的最小接口（便于测试替身） */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Conn {
  id: number;
  ws: SocketLike;
  ip: string;
  sessionId: string | null;
  name: string;
  /** 当前所在房间 */
  roomId: string | null;
  connectedAt: number;
  closed: boolean;
  /** 心跳 */
  alive: boolean;
  // 视图推送节流
  lastStateAt: number;
  sentVersion: number;
  sentRoomId: string | null;
  stateTimer: ReturnType<typeof setTimeout> | null;
  // 限流（令牌桶）
  tokens: number;
  tokensAt: number;
  lastThrottleWarn: number;
}

interface Room {
  /** 服务器内部的房间信息（含会话 ID）；发给客户端前经 roomInfoFor 转换 */
  info: StoredRoom;
  state: GameState | null;
  version: number;
  /** 主动离开进行中对局的会话（重连时不自动回到该房间，joinRoom 可回来） */
  away: Set<string>;
  /** 被房主移出的会话（大厅阶段不可再加入） */
  kicked: Set<string>;
  /** 由服务器托管的离线玩家战队（房主开启；玩家重连后自动解除） */
  autopilot: Set<string>;
  /** 串行任务队列（严格按到达顺序执行） */
  tasks: (() => void | Promise<void>)[];
  running: boolean;
  starting: boolean;
  lastActive: number;
  /** teamId -> 已序列化的 state 消息（同一版本复用） */
  viewCache: Map<string, { version: number; json: string }>;
  /** 房主离线后的移交计时器（宽限期内房主回来则取消） */
  hostTimer: ReturnType<typeof setTimeout> | null;
}

export interface RoomManagerOptions {
  engine: MpEngine;
  store?: RoomStore | null;
  serverName?: string;
  /** welcome 中的局域网地址 */
  lanUrls?: () => string[];
  log?: (msg: string) => void;
  /** 两次视图推送的最小间隔（毫秒），默认 250（≤ 4 次/秒） */
  stateIntervalMs?: number;
  maxRooms?: number;
  /** 无人在线的大厅房间保留时长（毫秒），默认 30 分钟 */
  lobbyIdleMs?: number;
  /** 已结束的对局在无人在线后保留多久（毫秒，默认 2 小时；期间原座位玩家可回去查看结算） */
  finishedRoomTtlMs?: number;
  /**
   * 进行中的对局连续无人在线多久后删除（毫秒，默认 14 天；0 = 永不删除）。
   * 只计服务器运行的时间（随房间存档保存），房主关掉服务器、过几周再开也能继续。
   */
  idleRoomTtlMs?: number;
  /** 一次回合推进广播的快讯上限 */
  roundFeedMax?: number;
  /**
   * 房主离线多久后把房主移交给在线玩家（毫秒，默认 30 秒）。否则房主掉线后：大厅无人能开始游戏；
   * 对局中无人能托管离线玩家（包括房主自己的座位），整个房间永远无法推进回合。
   */
  hostGraceMs?: number;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 已结束对局无人在线后的保留时长默认值 */
export const DEFAULT_FINISHED_ROOM_TTL_MS = 2 * 60 * 60 * 1000;
/** 进行中对局连续无人在线（服务器运行时间）的保留时长默认值 */
export const DEFAULT_IDLE_ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** 每个房间记住的被移出会话上限（随房间存档） */
const KICKED_MAX = 200;
const OPEN = 1; // WebSocket.OPEN
/** 发送缓冲超过该值时推迟视图推送（慢客户端） */
const MAX_BUFFERED = 24 * 1024 * 1024;
/** 令牌桶：容量 / 每秒补充 */
const RATE_CAPACITY = 80;
const RATE_REFILL = 40;
const MAX_QUEUE = 500;
const CALL_FEED_MAX = 20;
/** 只影响调用者自己视图的 RPC：不给其他玩家推送新快照（下一次变更时一并同步） */
const SELF_ONLY_RPCS: ReadonlySet<string> = new Set([
  'markNewsRead', 'markAllNewsRead', 'dismissPopup', 'dismissPopups', 'setTrainingFocus',
]);

function isOpResult(v: unknown): v is OpResult {
  return !!v && typeof v === 'object' && typeof (v as OpResult).ok === 'boolean' && typeof (v as OpResult).message === 'string';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 可以安全放进 callResult 的返回值（可序列化且不过大） */
function safeResult(v: unknown): unknown {
  if (v === undefined || typeof v === 'function') return undefined;
  try {
    const s = JSON.stringify(v);
    if (s === undefined || s.length > 256 * 1024) return undefined;
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// RoomManager
// ---------------------------------------------------------------------------
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  readonly conns = new Set<Conn>();
  private readonly bySession = new Map<string, Conn>();
  private readonly engine: MpEngine;
  private readonly store: RoomStore | null;
  private readonly serverName: string;
  private readonly lanUrls: () => string[];
  private readonly log: (msg: string) => void;
  private readonly stateIntervalMs: number;
  private readonly maxRooms: number;
  private readonly lobbyIdleMs: number;
  private readonly finishedRoomTtlMs: number;
  private readonly idleRoomTtlMs: number;
  private readonly roundFeedMax: number;
  private readonly hostGraceMs: number;
  private connSeq = 0;
  private feedSeq = 0;
  private roomListTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(opts: RoomManagerOptions) {
    this.engine = opts.engine;
    this.store = opts.store ?? null;
    this.serverName = opts.serverName ?? '刀塔经理服务器';
    this.lanUrls = opts.lanUrls ?? (() => []);
    this.log = opts.log ?? (() => undefined);
    this.stateIntervalMs = Math.max(0, opts.stateIntervalMs ?? 250);
    this.maxRooms = opts.maxRooms ?? 64;
    this.lobbyIdleMs = opts.lobbyIdleMs ?? 30 * 60 * 1000;
    this.finishedRoomTtlMs = Math.max(0, opts.finishedRoomTtlMs ?? DEFAULT_FINISHED_ROOM_TTL_MS);
    this.idleRoomTtlMs = Math.max(0, opts.idleRoomTtlMs ?? DEFAULT_IDLE_ROOM_TTL_MS);
    this.roundFeedMax = opts.roundFeedMax ?? 30;
    this.hostGraceMs = Math.max(0, opts.hostGraceMs ?? 30_000);
    this.store?.attach({ snapshot: (id) => this.snapshot(id) });
  }

  // =========================================================================
  // 连接
  // =========================================================================
  addConn(ws: SocketLike, ip = ''): Conn {
    const conn: Conn = {
      id: ++this.connSeq,
      ws,
      ip,
      sessionId: null,
      name: '',
      roomId: null,
      connectedAt: Date.now(),
      closed: false,
      alive: true,
      lastStateAt: 0,
      sentVersion: -1,
      sentRoomId: null,
      stateTimer: null,
      tokens: RATE_CAPACITY,
      tokensAt: Date.now(),
      lastThrottleWarn: 0,
    };
    this.conns.add(conn);
    return conn;
  }

  /** 连接关闭：座位标记离线（不释放座位） */
  removeConn(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    if (conn.stateTimer) clearTimeout(conn.stateTimer);
    conn.stateTimer = null;
    const sid = conn.sessionId;
    if (!sid || this.bySession.get(sid) !== conn) return; // 已被新连接顶替
    this.bySession.delete(sid);
    const room = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!room) return;
    const seat = this.seatOf(room, sid);
    if (!seat) return;
    seat.connected = false;
    if (room.info.status === 'lobby') seat.lobbyReady = false;
    room.lastActive = Date.now();
    this.touch(room);
    this.broadcastRoom(room);
    this.broadcastRoundStatus(room);
    this.checkHost(room);
    // 房间里没人在线了：释放已序列化的视图缓存（每个座位约 1MB，闲置房间不必常驻内存）
    if (!this.roomConns(room).length) room.viewCache.clear();
  }

  /** 收到一条原始消息（不会抛出） */
  handleRaw(conn: Conn, raw: string): void {
    try {
      if (conn.closed) return;
      if (!this.takeToken(conn)) {
        // 被限流的 call 也回复 callResult，客户端的等待不会悬空到超时；被限流的开始游戏请求带 ref（房间页复位按钮）。
        // 这两种已有专门的回复，不再另发通用提示（否则客户端同一件事弹两条）；其余消息的通用提示每秒最多一条
        const type = raw.length <= LIMITS.maxPayload ? this.peekType(raw) : null;
        const reqId = type === 'call' ? this.peekReqId(raw) : null;
        if (reqId !== null) this.send(conn, { t: 'callResult', reqId, ok: false, message: '操作过于频繁，请稍后再试' });
        else if (type === 'startGame') this.error(conn, '操作过于频繁，请稍后再试', 'startGame');
        else if (Date.now() - conn.lastThrottleWarn > 1000) {
          conn.lastThrottleWarn = Date.now();
          this.error(conn, '操作过于频繁，请稍后再试');
        }
        return;
      }
      if (raw.length > LIMITS.maxPayload) return this.error(conn, '消息过大');
      const parsed = parseClientMsg(raw);
      if (!parsed.ok) {
        // 带 reqId 的非法 call 也回复 callResult，客户端的等待不会悬空
        const reqId = this.peekReqId(raw);
        if (reqId !== null) return this.send(conn, { t: 'callResult', reqId, ok: false, message: parsed.error });
        return this.error(conn, parsed.error);
      }
      this.handle(conn, parsed.msg);
    } catch (err) {
      this.log(`处理消息出错（连接 #${conn.id}）：${errMsg(err)}`);
      this.error(conn, `服务器处理消息出错：${errMsg(err)}`);
    }
  }

  private peekType(raw: string): string | null {
    try {
      const d = JSON.parse(raw) as { t?: unknown };
      return d && typeof d.t === 'string' ? d.t : null;
    } catch {
      return null;
    }
  }

  private peekReqId(raw: string): number | null {
    try {
      const d = JSON.parse(raw) as { t?: unknown; reqId?: unknown };
      return d && d.t === 'call' && typeof d.reqId === 'number' && Number.isFinite(d.reqId) ? d.reqId : null;
    } catch {
      return null;
    }
  }

  private takeToken(conn: Conn): boolean {
    const now = Date.now();
    conn.tokens = Math.min(RATE_CAPACITY, conn.tokens + ((now - conn.tokensAt) / 1000) * RATE_REFILL);
    conn.tokensAt = now;
    if (conn.tokens >= 1) {
      conn.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 处理一条已校验的消息 */
  handle(conn: Conn, msg: ClientMsg): void {
    if (msg.t === 'hello') return this.onHello(conn, msg);
    if (!conn.sessionId) return this.error(conn, '请先发送 hello');
    switch (msg.t) {
      case 'listRooms':
        return this.sendRoomList(conn);
      case 'createRoom':
        return this.onCreateRoom(conn, msg.name, msg.maxPlayers);
      case 'joinRoom':
        return this.onJoinRoom(conn, msg.roomId);
      case 'leaveRoom':
        return this.withRoom(conn, (room) => this.onLeaveRoom(conn, room), () => {
          this.send(conn, { t: 'room', room: null });
          this.sendRoomList(conn);
        });
      case 'updateSettings':
        return this.withRoom(conn, (room) => this.onUpdateSettings(conn, room, msg.settings));
      case 'updateSeat':
        return this.withRoom(conn, (room) => this.onUpdateSeat(conn, room, msg));
      case 'setLobbyReady':
        return this.withRoom(conn, (room) => this.onLobbyReady(conn, room, msg.ready));
      case 'kick':
        return this.withRoom(conn, (room) => this.onKick(conn, room, msg.seatKey));
      case 'startGame':
        // 开始游戏的每一种拒绝都带 ref，房间页据此复位「正在创建游戏…」按钮并显示原因
        return this.withRoom(
          conn,
          (room) => this.onStartGame(conn, room),
          () => this.error(conn, '你不在任何房间中', 'startGame'),
          () => this.error(conn, '服务器繁忙，请稍后再试', 'startGame'),
        );
      case 'call':
        return this.withRoom(
          conn,
          (room) => this.onCall(conn, room, msg.reqId, msg.fn, msg.args),
          () => this.send(conn, { t: 'callResult', reqId: msg.reqId, ok: false, message: '你不在任何房间中' }),
          () => this.send(conn, { t: 'callResult', reqId: msg.reqId, ok: false, message: '服务器繁忙，请稍后再试' }),
        );
      case 'setRoundReady':
        return this.withRoom(conn, (room) => this.onRoundReady(conn, room, msg.ready, msg.auto === true));
      case 'setAutopilot':
        return this.withRoom(conn, (room) => this.onSetAutopilot(conn, room, msg.teamId, msg.on));
      case 'chat':
        return this.withRoom(conn, (room) => this.onChat(conn, room, msg.text));
      default:
        return this.error(conn, '未知的消息类型');
    }
  }

  /** 在连接所在房间的串行队列中执行（不在房间时调用 otherwise 或回复错误；队列已满时调用 busy 或回复错误） */
  private withRoom(conn: Conn, task: (room: Room) => void | Promise<void>, otherwise?: () => void, busy?: () => void): void {
    const room = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (!room) {
      conn.roomId = null;
      if (otherwise) otherwise();
      else this.error(conn, '你不在任何房间中');
      return;
    }
    this.enqueue(room, conn, () => {
      // 排队期间可能已离开房间
      if (conn.closed || conn.roomId !== room.info.id || !this.rooms.has(room.info.id)) {
        if (otherwise) otherwise();
        return;
      }
      return task(room);
    }, busy);
  }

  /** 加入房间的串行队列；队列已满返回 false（调用 busy，或给 conn 回复错误） */
  private enqueue(room: Room, conn: Conn | null, task: () => void | Promise<void>, busy?: () => void): boolean {
    if (room.tasks.length >= MAX_QUEUE) {
      if (busy) busy();
      else if (conn) this.error(conn, '服务器繁忙，请稍后再试');
      return false;
    }
    room.tasks.push(task);
    if (!room.running) void this.drain(room);
    return true;
  }

  private async drain(room: Room): Promise<void> {
    room.running = true;
    try {
      while (room.tasks.length) {
        const task = room.tasks.shift()!;
        try {
          const r = task();
          if (r && typeof (r as Promise<void>).then === 'function') await r;
        } catch (err) {
          this.log(`房间 ${room.info.id} 任务出错：${errMsg(err)}`);
        }
      }
    } finally {
      room.running = false;
    }
  }

  // =========================================================================
  // hello / 重连
  // =========================================================================
  private onHello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.error(conn, `客户端协议版本（v${msg.protocol}）与服务器（v${PROTOCOL_VERSION}）不一致，请刷新页面后重试`);
      try {
        conn.ws.close(4002, 'protocol mismatch');
      } catch {
        /* ignore */
      }
      return;
    }
    if (conn.sessionId && conn.sessionId !== msg.sessionId) return this.error(conn, '同一连接不能切换会话');
    const sid = msg.sessionId;
    conn.sessionId = sid;
    // 缺省昵称取会话 ID 的散列（昵称会发给房间里的所有人，不能含会话 ID 本身的任何字符）
    conn.name = msg.name || conn.name || `玩家-${createHash('sha256').update(sid).digest('hex').slice(0, 4).toUpperCase()}`;

    // 同一会话的旧连接被顶替
    const old = this.bySession.get(sid);
    if (old && old !== conn) {
      this.error(old, '你已在其他页面连接，此页面已断开');
      if (old.stateTimer) clearTimeout(old.stateTimer);
      old.stateTimer = null;
      old.roomId = null;
      old.sessionId = null;
      try {
        old.ws.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    this.bySession.set(sid, conn);
    this.send(conn, { t: 'welcome', sessionId: sid, serverName: this.serverName, lanUrls: this.lanUrls() });

    // 回到原房间：当前所在房间优先；否则已有座位、且没有主动离开的房间（进行中优先，其次最近活跃）。
    // 已结束的对局不自动回去：游戏结束页只有「返回主菜单」（不发 leaveRoom），否则每次进入多人大厅都会被拉回结束页、
    // 无法再建房 / 加入新房间；想再看结算可在房间列表中重新加入。
    const current = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    const candidates = [...this.rooms.values()]
      .filter((r) => r.info.status !== 'finished' && !r.away.has(sid) && !!this.seatOf(r, sid))
      .sort((a, b) => (a.info.status === 'playing' ? 0 : 1) - (b.info.status === 'playing' ? 0 : 1) || b.lastActive - a.lastActive);
    const room = current && this.seatOf(current, sid) ? current : candidates[0];
    if (room) {
      // 大厅阶段：hello 中的昵称同步到座位（游戏开始后昵称固定）
      const seat = this.seatOf(room, sid);
      if (seat && msg.name && room.info.status === 'lobby' && !room.starting) seat.name = msg.name;
      this.attach(conn, room);
      return;
    }
    conn.roomId = null;
    this.send(conn, { t: 'room', room: null });
    this.sendRoomList(conn);
  }

  /** 把连接挂到房间的已有座位上（标记在线，发送房间与游戏状态） */
  private attach(conn: Conn, room: Room): void {
    const sid = conn.sessionId!;
    const seat = this.seatOf(room, sid);
    if (!seat) return;
    conn.roomId = room.info.id;
    conn.sentVersion = -1;
    conn.sentRoomId = null;
    room.away.delete(sid);
    seat.connected = true;
    room.lastActive = Date.now();
    // 玩家回来了：解除托管（准备状态保留，之后由玩家自己决定）
    if (seat.gameTeamId && room.autopilot.delete(seat.gameTeamId)) {
      this.log(`房间 ${room.info.id}：${seat.name} 重新连接，解除托管`);
      for (const c of this.roomConns(room)) {
        if (c !== conn) this.send(c, { t: 'feed', items: [this.systemFeed(`${seat.name} 回来了，已解除托管`)] });
      }
    }
    this.touch(room);
    this.broadcastRoom(room);
    // 房主回来了 → 取消移交；房主仍离线、现在有人在线 → 开始移交倒计时（如服务器重启后先回来的是其他玩家）
    this.checkHost(room);
    if (room.state && seat.gameTeamId) {
      this.pushState(conn, room, true);
      const st = this.roundStatus(room);
      if (st) this.send(conn, { t: 'roundStatus', status: st });
      this.broadcastRoundStatus(room, conn);
      // 有在线玩家了：托管中的离线座位处理本回合事务（如服务器重启后首次有人连接）
      if (room.autopilot.size) this.enqueue(room, null, () => this.runAutopilot(room));
    }
    this.scheduleRoomList();
  }

  // =========================================================================
  // 大厅
  // =========================================================================
  private defaultSettings(): RoomSettings {
    const tis = this.engine.startTis();
    return { startTi: tis.length ? tis[0] : 1, endTi: MAX_TI, difficulty: 'normal', mode: 'build' };
  }

  private newRoomId(): string {
    for (let guard = 0; guard < 1000; guard++) {
      let id = '';
      for (let i = 0; i < 6; i++) id += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      if (!this.rooms.has(id)) return id;
    }
    throw new Error('无法生成房间码');
  }

  /** 新的座位键：随机、不透明、房间内唯一（与会话 ID 无关，不能用来冒充座位） */
  private newSeatKey(seats: readonly { seatKey?: string }[]): string {
    for (;;) {
      const key = randomBytes(9).toString('base64url');
      if (!seats.some((s) => s.seatKey === key)) return key;
    }
  }

  private newSeat(conn: Conn, seats: readonly StoredSeat[]): StoredSeat {
    return { seatKey: this.newSeatKey(seats), sessionId: conn.sessionId!, name: conn.name, connected: true, lobbyReady: false };
  }

  private onCreateRoom(conn: Conn, name: string, maxPlayers: number): void {
    if (this.rooms.size >= this.maxRooms && !this.evictIdleRoom()) return this.error(conn, '服务器房间数已达上限');
    const cur = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
    if (cur && !this.leave(conn, cur)) return;
    const id = this.newRoomId();
    const info: StoredRoom = {
      id,
      name: name || `${conn.name}的房间`,
      hostSessionId: conn.sessionId!,
      maxPlayers,
      status: 'lobby',
      settings: this.defaultSettings(),
      seats: [this.newSeat(conn, [])],
      createdAt: new Date().toISOString(),
    };
    const room: Room = {
      info, state: null, version: 0, away: new Set(), kicked: new Set(), autopilot: new Set(), tasks: [], running: false,
      starting: false, lastActive: Date.now(), viewCache: new Map(), hostTimer: null,
    };
    this.rooms.set(id, room);
    conn.roomId = id;
    this.log(`创建房间 ${id}「${info.name}」（房主 ${conn.name}）`);
    this.touch(room);
    this.broadcastRoom(room);
    this.scheduleRoomList();
  }

  private onJoinRoom(conn: Conn, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return this.error(conn, `房间 ${roomId} 不存在`);
    this.enqueue(room, conn, () => {
      if (conn.closed || !conn.sessionId || !this.rooms.has(roomId)) return;
      const sid = conn.sessionId;
      if (conn.roomId === roomId) {
        // 已在房间内：重发房间与状态
        conn.sentVersion = -1;
        this.sendRoom(conn, room);
        if (room.state) {
          this.pushState(conn, room, true);
          const st = this.roundStatus(room);
          if (st) this.send(conn, { t: 'roundStatus', status: st });
        }
        return;
      }
      const existing = this.seatOf(room, sid);
      if (!existing) {
        if (room.info.status !== 'lobby') return this.error(conn, '该房间的游戏已经开始，无法加入');
        if (room.starting) return this.error(conn, '该房间正在开始游戏，请稍候');
        if (room.kicked.has(sid)) return this.error(conn, '你已被房主移出该房间');
        if (room.info.seats.length >= room.info.maxPlayers) return this.error(conn, '房间已满');
      }
      const cur = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
      if (cur && cur !== room && !this.leave(conn, cur)) return;
      if (!existing) {
        room.info.seats.push(this.newSeat(conn, room.info.seats));
        this.log(`${conn.name} 加入房间 ${roomId}`);
      }
      this.attach(conn, room);
    });
  }

  /**
   * 离开房间（同步，不发送 room:null）：大厅阶段释放座位（房主离开 → 房主移交给下一位；无人 → 删除房间）；
   * 进行中的对局保留座位与战队（标记离线 + away）。返回 false 表示当前不能离开。
   */
  private leave(conn: Conn, room: Room): boolean {
    const sid = conn.sessionId;
    conn.roomId = null;
    conn.sentVersion = -1;
    conn.sentRoomId = null;
    if (conn.stateTimer) clearTimeout(conn.stateTimer);
    conn.stateTimer = null;
    if (!sid) return true;
    const idx = room.info.seats.findIndex((s) => s.sessionId === sid);
    if (idx < 0) return true;
    if (room.info.status === 'lobby') {
      if (room.starting) {
        conn.roomId = room.info.id;
        this.error(conn, '游戏正在开始，暂时不能离开房间');
        return false;
      }
      room.info.seats.splice(idx, 1);
      if (!room.info.seats.length) {
        this.deleteRoom(room, '所有玩家已离开');
        return true;
      }
      if (room.info.hostSessionId === sid) {
        const next = room.info.seats.find((s) => s.connected) ?? room.info.seats[0];
        room.info.hostSessionId = next.sessionId;
        this.log(`房间 ${room.info.id} 房主移交给 ${next.name}`);
      }
      this.touch(room);
      this.broadcastRoom(room);
    } else {
      room.info.seats[idx].connected = false;
      room.away.add(sid);
      room.lastActive = Date.now();
      // 房主主动离开进行中的对局：立即把房主移交给在线玩家（否则无人能托管离线玩家，回合可能永远卡住）
      if (room.info.hostSessionId === sid) this.handOverHost(room, '离开了对局');
      this.touch(room);
      this.broadcastRoom(room);
      this.broadcastRoundStatus(room);
    }
    this.checkHost(room);
    this.scheduleRoomList();
    return true;
  }

  /**
   * 房主离线时：宽限期（hostGraceMs）后若仍离线，且有其他在线玩家，则把房主移交给在线玩家。
   * 房主回来 / 没有可移交的在线玩家时取消计时（之后有人连上会再次检查）。
   */
  private checkHost(room: Room): void {
    if (this.rooms.get(room.info.id) !== room || this.shuttingDown) return;
    const hostSid = room.info.hostSessionId;
    const host = this.seatOf(room, hostSid);
    const candidate = room.info.seats.some((s) => s.connected && s.sessionId !== hostSid);
    if (host?.connected || !candidate) {
      if (room.hostTimer) clearTimeout(room.hostTimer);
      room.hostTimer = null;
      return;
    }
    if (room.hostTimer) return;
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      if (this.rooms.get(room.info.id) !== room) return;
      this.enqueue(room, null, () => {
        this.handOverHost(room, '已离线');
      });
    }, this.hostGraceMs);
    room.hostTimer.unref?.();
  }

  /** 房主（离线 / 离开）→ 移交给第一位在线玩家；返回是否移交 */
  private handOverHost(room: Room, why: string): boolean {
    const oldSid = room.info.hostSessionId;
    const old = this.seatOf(room, oldSid);
    if (old?.connected) return false;
    const next = room.info.seats.find((s) => s.connected && s.sessionId !== oldSid);
    if (!next) return false;
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = null;
    room.info.hostSessionId = next.sessionId;
    const oldName = old?.name ?? '房主';
    this.log(`房间 ${room.info.id}：房主 ${oldName} ${why}，房主移交给 ${next.name}`);
    room.lastActive = Date.now();
    this.touch(room);
    this.broadcastRoom(room);
    if (room.info.status !== 'lobby') {
      const item = this.systemFeed(
        `房主 ${oldName} ${why}，${next.name} 成为新房主`,
        room.info.status === 'playing' ? '新房主可以托管离线的玩家（顶栏玩家旁的「托管」），避免回合卡住。' : undefined,
      );
      for (const c of this.roomConns(room)) this.send(c, { t: 'feed', items: [item] });
    }
    this.scheduleRoomList();
    return true;
  }

  /**
   * 房间数达到上限时腾位置：先清理最久没有活动、无人在线的已结束对局，其次是无人在线的大厅房间
   * （进行中的对局不在此清理，由 sweep 按 idleRoomTtlMs 处理）；返回是否腾出了位置。
   */
  private evictIdleRoom(): boolean {
    const idle = [...this.rooms.values()].filter((r) => !r.running && !r.starting && !r.info.seats.some((s) => s.connected));
    const pick = (status: RoomInfo['status']) => idle.filter((r) => r.info.status === status).sort((a, b) => a.lastActive - b.lastActive)[0];
    const finished = pick('finished');
    if (finished) {
      this.deleteRoom(finished, '房间数已达上限，清理已结束且无人在线的对局');
      return true;
    }
    const lobby = pick('lobby');
    if (lobby) {
      this.deleteRoom(lobby, '房间数已达上限，清理无人在线的大厅房间');
      return true;
    }
    return false;
  }

  private onLeaveRoom(conn: Conn, room: Room): void {
    if (!this.leave(conn, room)) return;
    this.send(conn, { t: 'room', room: null });
    this.sendRoomList(conn);
  }

  private requireLobbyHost(conn: Conn, room: Room, what: string, ref?: ClientMsg['t']): boolean {
    if (room.info.hostSessionId !== conn.sessionId) {
      this.error(conn, `只有房主可以${what}`, ref);
      return false;
    }
    if (room.info.status !== 'lobby') {
      this.error(conn, `游戏已开始，不能${what}`, ref);
      return false;
    }
    if (room.starting) {
      this.error(conn, '游戏正在开始，请稍候', ref);
      return false;
    }
    return true;
  }

  private onUpdateSettings(conn: Conn, room: Room, patch: Partial<RoomSettings>): void {
    if (!this.requireLobbyHost(conn, room, '修改房间设置')) return;
    const cur = room.info.settings;
    const next: RoomSettings = { ...cur, ...patch };
    if (next.startTi < 1 || next.startTi > MAX_TI) return this.error(conn, `起始 TI 需为 TI1–TI${MAX_TI}`);
    if (patch.startTi !== undefined && patch.endTi === undefined && next.endTi < next.startTi) next.endTi = next.startTi;
    if (next.endTi < next.startTi || next.endTi > MAX_TI) return this.error(conn, `终点 TI 需在 TI${next.startTi}–TI${MAX_TI} 之间`);
    if (next.mode === 'existing' && !this.engine.startTis().includes(next.startTi)) {
      return this.error(conn, `TI${next.startTi} 没有真实战队数据，无法使用「选择已有战队」玩法`);
    }
    const changed = (Object.keys(next) as (keyof RoomSettings)[]).some((k) => next[k] !== cur[k]);
    if (!changed) return this.broadcastRoom(room);
    const teamsInvalid = next.startTi !== cur.startTi || next.mode !== cur.mode;
    room.info.settings = next;
    for (const s of room.info.seats) {
      s.lobbyReady = false;
      if (teamsInvalid) delete s.teamId;
    }
    this.touch(room);
    this.broadcastRoom(room);
    this.scheduleRoomList();
  }

  private async onUpdateSeat(conn: Conn, room: Room, msg: Extract<ClientMsg, { t: 'updateSeat' }>): Promise<void> {
    const seat = this.seatOf(room, conn.sessionId!);
    if (!seat) return this.error(conn, '你不在该房间的座位上');
    if (room.info.status !== 'lobby') return this.error(conn, '游戏已开始，不能修改座位');
    if (room.starting) return this.error(conn, '游戏正在开始，请稍候');
    const others = room.info.seats.filter((s) => s !== seat);
    const { mode, startTi } = room.info.settings;

    if (msg.teamId !== undefined && msg.teamId !== null) {
      if (mode !== 'existing') return this.error(conn, '当前玩法为「各自组建战队」，不能选择已有战队');
      const teams = await this.engine.realTeams(startTi);
      // 等待数据期间设置可能已变化
      if (room.info.settings.mode !== 'existing' || room.info.settings.startTi !== startTi) {
        return this.error(conn, '房间设置已变化，请重新选择战队');
      }
      const team = teams.find((t) => t.id === msg.teamId);
      if (!team) return this.error(conn, `TI${startTi} 没有这支战队`);
      const taken = room.info.seats.find((s) => s !== seat && s.teamId === msg.teamId);
      if (taken) return this.error(conn, `「${team.name}」已被「${taken.name}」选择`);
    }
    if (msg.newClub) {
      const club = msg.newClub;
      const dupName = others.find((s) => s.newClub && s.newClub.name.toLowerCase() === club.name.toLowerCase());
      if (dupName) return this.error(conn, `俱乐部名称与「${dupName.name}」的俱乐部重复`);
      const dupTag = others.find((s) => s.newClub && s.newClub.tag === club.tag);
      if (dupTag) return this.error(conn, `俱乐部简称与「${dupTag.name}」的俱乐部重复`);
      const real = await this.engine.realTeams(room.info.settings.startTi);
      const clash = this.realClubClash(club, real);
      if (clash) return this.error(conn, clash);
    }

    if (msg.name !== undefined) {
      seat.name = msg.name;
      conn.name = msg.name;
    }
    if (msg.teamId !== undefined) {
      if (msg.teamId === null) delete seat.teamId;
      else seat.teamId = msg.teamId;
    }
    if (msg.newClub !== undefined) {
      if (msg.newClub === null) delete seat.newClub;
      else seat.newClub = { ...msg.newClub };
    }
    if (msg.teamId !== undefined || msg.newClub !== undefined) seat.lobbyReady = false;
    this.touch(room);
    this.broadcastRoom(room);
    if (msg.name !== undefined && room.info.hostSessionId === seat.sessionId) this.scheduleRoomList();
  }

  private realClubClash(club: { name: string; tag: string }, real: { name: string; tag: string }[]): string | null {
    const n = real.find((t) => (t.name ?? '').toLowerCase() === club.name.toLowerCase());
    if (n) return `俱乐部名称与现有战队「${n.name}」重名`;
    const g = real.find((t) => (t.tag ?? '').toUpperCase() === club.tag.toUpperCase());
    if (g) return `俱乐部简称与现有战队「${g.name}」重复`;
    return null;
  }

  private onLobbyReady(conn: Conn, room: Room, ready: boolean): void {
    const seat = this.seatOf(room, conn.sessionId!);
    if (!seat) return this.error(conn, '你不在该房间的座位上');
    if (room.info.status !== 'lobby') return this.error(conn, '游戏已开始');
    if (room.starting) return this.error(conn, '游戏正在开始，请稍候');
    if (ready) {
      const { mode } = room.info.settings;
      if (mode === 'existing' && !seat.teamId) return this.error(conn, '请先选择要接管的战队');
      if (mode === 'build' && !seat.newClub) return this.error(conn, '请先填写俱乐部信息');
    }
    seat.lobbyReady = ready;
    this.touch(room);
    this.broadcastRoom(room);
  }

  private onKick(conn: Conn, room: Room, seatKey: string): void {
    if (!this.requireLobbyHost(conn, room, '移出玩家')) return;
    const idx = room.info.seats.findIndex((s) => s.seatKey === seatKey);
    if (idx < 0) return this.error(conn, '该玩家不在房间中');
    if (room.info.seats[idx].sessionId === conn.sessionId) return this.error(conn, '不能移出自己');
    const [seat] = room.info.seats.splice(idx, 1);
    const targetSid = seat.sessionId;
    // 记住被移出的会话（随房间存档，服务器重启后仍不能再加入）
    room.kicked.delete(targetSid);
    room.kicked.add(targetSid);
    while (room.kicked.size > KICKED_MAX) room.kicked.delete(room.kicked.values().next().value as string);
    const tc = this.bySession.get(targetSid);
    if (tc && tc.roomId === room.info.id) {
      tc.roomId = null;
      this.error(tc, `你已被房主移出房间「${room.info.name}」`);
      this.send(tc, { t: 'room', room: null });
      this.sendRoomList(tc);
    }
    this.log(`房间 ${room.info.id}：${seat.name} 被移出`);
    this.touch(room);
    this.broadcastRoom(room);
    this.scheduleRoomList();
  }

  /** 校验开局条件（不含异步数据）；返回错误信息或 null */
  private startError(room: Room): string | null {
    const seats = room.info.seats;
    if (seats.length < LIMITS.minPlayers) return `至少需要 ${LIMITS.minPlayers} 名玩家才能开始`;
    if (seats.length > LIMITS.maxPlayers) return `最多 ${LIMITS.maxPlayers} 名玩家`;
    const notReady = seats.filter((s) => !s.lobbyReady || !s.connected);
    if (notReady.length) return `还有玩家未准备：${notReady.map((s) => s.name).join('、')}`;
    const { mode, startTi, endTi } = room.info.settings;
    if (endTi < startTi) return '终点 TI 不能早于起始 TI';
    if (mode === 'existing') {
      if (!this.engine.startTis().includes(startTi)) return `TI${startTi} 没有真实战队数据`;
      const missing = seats.filter((s) => !s.teamId);
      if (missing.length) return `还有玩家未选择战队：${missing.map((s) => s.name).join('、')}`;
      const ids = seats.map((s) => s.teamId);
      if (new Set(ids).size !== ids.length) return '有玩家选择了同一支战队';
    } else {
      const missing = seats.filter((s) => !s.newClub);
      if (missing.length) return `还有玩家未填写俱乐部信息：${missing.map((s) => s.name).join('、')}`;
      for (const s of seats) {
        const c = parseNewClub(s.newClub);
        if (!c.ok) return `「${s.name}」的俱乐部信息无效：${c.error}`;
      }
      const names = seats.map((s) => s.newClub!.name.toLowerCase());
      if (new Set(names).size !== names.length) return '有玩家的俱乐部重名';
      const tags = seats.map((s) => s.newClub!.tag.toUpperCase());
      if (new Set(tags).size !== tags.length) return '有玩家的俱乐部简称重复';
    }
    return null;
  }

  private async onStartGame(conn: Conn, room: Room): Promise<void> {
    if (!this.requireLobbyHost(conn, room, '开始游戏', 'startGame')) return;
    const err = this.startError(room);
    if (err) return this.error(conn, err, 'startGame');
    // 从这里起座位冻结（离开/移出/改座位都会被拒绝或排队），直到开局完成或失败
    room.starting = true;
    let state: GameState;
    let seats: StoredSeat[];
    const t0 = Date.now();
    try {
      const { mode, startTi, endTi, difficulty } = room.info.settings;
      const real = await this.engine.realTeams(startTi);
      if (mode === 'existing') {
        const bad = room.info.seats.find((s) => !real.some((t) => t.id === s.teamId));
        if (bad) return this.error(conn, `「${bad.name}」选择的战队不在 TI${startTi} 名单中`, 'startGame');
      } else {
        for (const s of room.info.seats) {
          const clash = this.realClubClash(s.newClub!, real);
          if (clash) return this.error(conn, `「${s.name}」：${clash}`, 'startGame');
        }
      }
      seats = room.info.seats.map((s) => ({ ...s }));
      const players: MpPlayerSpec[] = seats.map((s) => ({
        sessionId: s.sessionId,
        name: s.name,
        ...(mode === 'existing' ? { teamId: s.teamId } : { newClub: { ...s.newClub! } }),
      }));
      const opts: MpNewGameOptions = { startTi, endTi, difficulty, mode, players, seed: randomInt(1, 2 ** 31 - 1) };
      this.log(`房间 ${room.info.id} 开始游戏：TI${startTi}→TI${endTi} · ${mode === 'existing' ? '选择已有战队' : '各自组建战队'} · ${players.length} 人`);
      try {
        state = await this.engine.createGame(opts);
      } catch (e) {
        this.log(`房间 ${room.info.id} 创建游戏失败：${errMsg(e)}`);
        for (const c of this.roomConns(room)) this.error(c, `创建游戏失败：${errMsg(e)}`, c === conn ? 'startGame' : undefined);
        this.broadcastRoom(room);
        return;
      }
    } catch (e) {
      // 其他意外（如读取阵容数据出错）：同样回复带 ref 的错误，房间页的「正在创建游戏…」按钮不会一直卡住
      this.log(`房间 ${room.info.id} 开始游戏出错：${errMsg(e)}`);
      this.error(conn, `开始游戏失败：${errMsg(e)}`, 'startGame');
      return;
    } finally {
      room.starting = false;
    }
    // 座位 → 战队
    const mpSeats = seatsOf(this.engine.info(state));
    const mapping = new Map<string, string>();
    seats.forEach((s, i) => {
      const bySid = mpSeats.find((m) => m.sessionId === s.sessionId);
      const teamId = bySid?.teamId ?? mpSeats[i]?.teamId;
      if (teamId) mapping.set(s.sessionId, teamId);
    });
    if (mapping.size !== seats.length || new Set(mapping.values()).size !== seats.length) {
      this.log(`房间 ${room.info.id} 座位映射失败（引擎返回 ${mpSeats.length} 个座位）`);
      for (const c of this.roomConns(room)) this.error(c, '创建游戏失败：座位与战队无法对应', c === conn ? 'startGame' : undefined);
      return;
    }
    for (const s of room.info.seats) {
      const teamId = mapping.get(s.sessionId);
      if (teamId) s.gameTeamId = teamId;
    }
    room.state = state;
    room.version = 1;
    room.viewCache.clear();
    room.info.status = state.gameOver ? 'finished' : 'playing';
    room.lastActive = Date.now();
    this.log(`房间 ${room.info.id} 游戏已创建（${Date.now() - t0}ms）`);
    this.touch(room);
    void this.store?.saveNow(room.info.id);
    this.broadcastRoom(room);
    for (const c of this.roomConns(room)) this.pushState(c, room, true);
    this.broadcastRoundStatus(room);
    this.scheduleRoomList();
  }

  // =========================================================================
  // 游戏
  // =========================================================================
  private onCall(conn: Conn, room: Room, reqId: number, fn: string, rawArgs: unknown[]): void {
    const reply = (ok: boolean, message: string, result?: unknown) => {
      const msg: ServerMsg = { t: 'callResult', reqId, ok, message };
      if (result !== undefined) msg.result = result;
      this.send(conn, msg);
    };
    const seat = this.seatOf(room, conn.sessionId!);
    const state = room.state;
    if (room.info.status === 'lobby' || !state) return reply(false, '游戏尚未开始');
    if (!seat?.gameTeamId) return reply(false, '你不在本局游戏中');
    const teamId = seat.gameTeamId;
    const args = rawArgs.slice();
    const teamArg = RPC_TEAM_ARG[fn as RpcName];
    if (teamArg !== undefined) {
      while (args.length <= teamArg) args.push(undefined);
      args[teamArg] = teamId;
    }

    const before = this.newsIds(state);
    const statusBefore = this.seatFlagsKey(state);
    let value: unknown;
    let thrown: unknown = null;
    try {
      value = this.engine.callAsSeat(state, teamId, fn, args);
    } catch (e) {
      thrown = e;
    }
    const fresh = this.freshNews(state, before);
    room.version++;
    room.viewCache.clear();
    room.lastActive = Date.now();
    this.touch(room);

    let ok: boolean;
    let message: string;
    if (thrown) {
      ok = false;
      message = `操作失败：${errMsg(thrown)}`;
      this.log(`房间 ${room.info.id} ${seat.name} 调用 ${fn} 出错：${errMsg(thrown)}`);
    } else if (isOpResult(value)) {
      ok = value.ok;
      message = value.ok ? value.message : this.explainFailure(state, teamId, fn, args, value.message);
    } else {
      ok = true;
      message = '';
    }

    // 调用者：先发新视图再回复结果（客户端收到结果时状态已是最新）
    this.pushState(conn, room, true);
    reply(ok, message, thrown ? undefined : safeResult(value));

    // 其他玩家：公开新闻 → 快讯；视图节流推送
    const feed = this.toFeed(room, fresh, { teamId, name: seat.name }, CALL_FEED_MAX);
    // 失败的操作也可能已改动状态（如快速模拟打完几场后才报错），因此除只影响自己的 RPC 外都同步给其他玩家
    const changedForOthers = !SELF_ONLY_RPCS.has(fn);
    for (const c of this.roomConns(room)) {
      if (c === conn) continue;
      if (feed.length) this.send(c, { t: 'feed', items: feed });
      if (changedForOthers) this.pushState(c, room, false);
    }
    if (this.checkFinished(room)) return;
    // 操作可能改变准备/出局状态（新的阻塞取消准备、荣誉跌破 0 出局）→ 广播；出局后可能已全员准备
    if (this.seatFlagsKey(state) !== statusBefore) {
      this.broadcastRoundStatus(room);
      let all = false;
      try {
        all = this.engine.allSeatsReady(state);
      } catch {
        all = false;
      }
      if (all) return this.advanceRound(room);
    }
    // 托管中的离线玩家：本次操作可能让其比赛就绪 / 产生新的阻塞（如对手刚打完一场）
    this.runAutopilot(room);
  }

  /** 座位准备/出局标记的签名（用于发现操作引起的变化） */
  private seatFlagsKey(state: GameState): string {
    try {
      return seatsOf(this.engine.info(state)).map((s) => `${s.teamId}:${s.ready ? 1 : 0}${s.eliminated ? 1 : 0}${s.autoReady ? 1 : 0}`).join('|');
    } catch {
      return '';
    }
  }

  /** 抢签失败时给出「已被 XX 签下」的明确提示 */
  private explainFailure(state: GameState, teamId: string, fn: string, args: unknown[], message: string): string {
    if (fn !== 'signFreeAgent' || typeof args[0] !== 'string') return message;
    const p = state.players?.[args[0]];
    const owner = p?.teamId;
    if (!p || !owner || owner === teamId) return message;
    const seat = seatsOf(this.engine.info(state)).find((s) => s.teamId === owner);
    if (!seat) return message;
    const team = state.teams?.[owner];
    return `${p.handle} 已被玩家「${seat.name}」的 ${team?.name ?? owner} 签下`;
  }

  private onRoundReady(conn: Conn, room: Room, ready: boolean, auto = false): void {
    const seat = this.seatOf(room, conn.sessionId!);
    const state = room.state;
    if (room.info.status === 'lobby' || !state) return this.error(conn, '游戏尚未开始');
    if (room.info.status === 'finished' || state.gameOver) return this.error(conn, '游戏已结束');
    if (!seat?.gameTeamId) return this.error(conn, '你不在本局游戏中');
    const withAuto = auto && ready;
    const before = withAuto ? this.newsIds(state) : null;
    const autoFlag = () => {
      try {
        return !!seatsOf(this.engine.info(state)).find((x) => x.teamId === seat.gameTeamId)?.autoReady;
      } catch {
        return false;
      }
    };
    const autoBefore = autoFlag();
    let r: OpResult;
    try {
      r = withAuto
        ? this.engine.setSeatReady(state, seat.gameTeamId, ready, { auto: true })
        : this.engine.setSeatReady(state, seat.gameTeamId, ready);
    } catch (e) {
      r = { ok: false, message: `操作失败：${errMsg(e)}` };
    }
    this.touch(room);
    if (withAuto || autoFlag() !== autoBefore) {
      // 自动处理（autoRound）可能改动了状态：快速模拟、处理事件、招募替补，也可能让其他等待中的玩家继续 → 推送视图与快讯
      // （取消准备撤销自动处理意图时同样推送，视图中的座位标记保持一致）
      const fresh = before ? this.freshNews(state, before) : [];
      room.version++;
      room.viewCache.clear();
      room.lastActive = Date.now();
      this.pushState(conn, room, true);
      const feed = this.toFeed(room, fresh, { teamId: seat.gameTeamId, name: seat.name }, CALL_FEED_MAX);
      for (const c of this.roomConns(room)) {
        if (c === conn) continue;
        if (feed.length) this.send(c, { t: 'feed', items: feed });
        this.pushState(c, room, false);
      }
      if (this.checkFinished(room)) return;
    }
    if (!r.ok) {
      this.error(conn, r.message || '暂时不能准备');
      const st = this.roundStatus(room);
      if (st) this.send(conn, { t: 'roundStatus', status: st });
      return;
    }
    this.broadcastRoundStatus(room);
    let all = false;
    try {
      all = ready && this.engine.allSeatsReady(state);
    } catch (e) {
      this.log(`房间 ${room.info.id} allSeatsReady 出错：${errMsg(e)}`);
    }
    if (all) return this.advanceRound(room);
    // 托管中的离线玩家可能还没准备（如服务器重启后）：先替他处理，全员准备则推进
    if (ready) this.runAutopilot(room);
  }

  /** 房主托管 / 取消托管一名离线玩家 */
  private onSetAutopilot(conn: Conn, room: Room, teamId: string, on: boolean): void {
    const state = room.state;
    if (room.info.hostSessionId !== conn.sessionId) return this.error(conn, '只有房主可以托管离线玩家');
    if (room.info.status !== 'playing' || !state) return this.error(conn, '游戏未在进行中');
    const seat = room.info.seats.find((s) => s.gameTeamId === teamId);
    const mpSeat = seatsOf(this.engine.info(state)).find((s) => s.teamId === teamId);
    if (!seat || !mpSeat) return this.error(conn, '该玩家不在本局游戏中');
    const host = this.seatOf(room, conn.sessionId!)?.name ?? '房主';
    if (!on) {
      if (room.autopilot.delete(teamId)) {
        this.log(`房间 ${room.info.id}：${host} 取消托管 ${seat.name}`);
        for (const c of this.roomConns(room)) this.send(c, { t: 'feed', items: [this.systemFeed(`${host} 取消了对 ${seat.name} 的托管`)] });
      }
      this.touch(room);
      this.broadcastRoundStatus(room);
      return;
    }
    if (seat.connected) return this.error(conn, `${seat.name} 在线，不能托管`);
    if (mpSeat.eliminated) return this.error(conn, `${seat.name} 的战队已解散，无需托管`);
    if (!room.autopilot.has(teamId)) {
      room.autopilot.add(teamId);
      this.log(`房间 ${room.info.id}：${host} 托管离线玩家 ${seat.name}`);
      const item = this.systemFeed(
        `${host} 托管了离线玩家 ${seat.name}`,
        '服务器将代为处理待决事件（保守选项）、快速模拟比赛并准备；玩家重连后自动解除托管。',
      );
      for (const c of this.roomConns(room)) this.send(c, { t: 'feed', items: [item] });
    }
    this.touch(room);
    this.broadcastRoundStatus(room);
    this.runAutopilot(room);
  }

  /**
   * 托管：为托管中的离线座位处理本回合事务（待决事件、比赛、准备）；之后全员准备则推进回合。
   * 只在仍有在线且未托管的玩家在比赛时自动推进，避免无人时服务器自己打完整局。
   */
  private runAutopilot(room: Room): void {
    const state = room.state;
    if (!state || room.info.status !== 'playing' || !room.autopilot.size || state.gameOver) return;
    let seats;
    try {
      seats = seatsOf(this.engine.info(state));
    } catch {
      return;
    }
    let acted = false;
    for (const teamId of [...room.autopilot]) {
      const rs = room.info.seats.find((x) => x.gameTeamId === teamId);
      const ms = seats.find((x) => x.teamId === teamId);
      if (!rs || !ms || rs.connected || ms.eliminated) {
        room.autopilot.delete(teamId);
        acted = true;
        continue;
      }
      if (ms.ready) continue;
      const before = this.newsIds(state);
      let r: OpResult;
      try {
        r = this.engine.autopilot(state, teamId);
      } catch (e) {
        r = { ok: false, message: `托管出错：${errMsg(e)}` };
      }
      // 无事可做（如等待其他玩家的比赛结果）时不产生新版本，避免每次操作都多推一次视图
      if (r.ok && !r.message) continue;
      acted = true;
      this.log(`房间 ${room.info.id} 托管 ${rs.name}：${r.ok ? '' : '失败 '}${r.message.slice(0, 160)}`);
      const feed = this.toFeed(room, this.freshNews(state, before), { teamId, name: rs.name }, CALL_FEED_MAX);
      if (feed.length) for (const c of this.roomConns(room)) this.send(c, { t: 'feed', items: feed });
    }
    if (!acted) return;
    room.version++;
    room.viewCache.clear();
    room.lastActive = Date.now();
    this.touch(room);
    for (const c of this.roomConns(room)) this.pushState(c, room, false);
    if (this.checkFinished(room)) return;
    this.broadcastRoundStatus(room);
    const humanOnline = seats.some((x) => !x.eliminated && !room.autopilot.has(x.teamId)
      && room.info.seats.some((rs) => rs.gameTeamId === x.teamId && rs.connected));
    let all = false;
    try {
      all = this.engine.allSeatsReady(state);
    } catch {
      all = false;
    }
    if (all && humanOnline) this.advanceRound(room);
  }

  /** 服务器系统快讯（托管等） */
  private systemFeed(title: string, body?: string): FeedItem {
    const item: FeedItem = { id: `sys-${Date.now().toString(36)}-${(++this.feedSeq).toString(36)}`, at: new Date().toISOString(), title, important: true };
    if (body) item.body = body;
    return item;
  }

  /** 全员准备 → 推进回合并广播 */
  private advanceRound(room: Room): void {
    const state = room.state;
    if (!state) return;
    const before = this.newsIds(state);
    const t0 = Date.now();
    let r: OpResult;
    try {
      r = this.engine.advance(state);
    } catch (e) {
      r = { ok: false, message: `推进回合失败：${errMsg(e)}` };
    }
    const fresh = this.freshNews(state, before);
    room.version++;
    room.viewCache.clear();
    room.lastActive = Date.now();
    this.touch(room);
    this.log(`房间 ${room.info.id} 推进回合：${r.ok ? '成功' : '失败'} ${r.message}（${Date.now() - t0}ms）→ TI${state.season?.ti ?? '?'} 第 ${state.roundIndex} 回合`);
    const finished = this.checkFinished(room, false);
    const conns = this.roomConns(room);
    for (const c of conns) this.pushState(c, room, true);
    const feed = this.toFeed(room, fresh, null, this.roundFeedMax);
    if (feed.length) for (const c of conns) this.send(c, { t: 'feed', items: feed });
    this.broadcastRoundStatus(room);
    if (!r.ok) for (const c of conns) this.error(c, r.message || '推进回合失败');
    if (finished) {
      this.broadcastRoom(room);
      this.scheduleRoomList();
      return;
    }
    // 新回合：托管中的离线玩家先处理本回合事务
    if (r.ok) this.runAutopilot(room);
  }

  /** 游戏结束 → 房间状态 finished；返回是否刚结束 */
  private checkFinished(room: Room, broadcast = true): boolean {
    if (room.info.status !== 'playing' || !room.state?.gameOver) return false;
    room.info.status = 'finished';
    this.log(`房间 ${room.info.id} 游戏结束：${room.state.gameOver.summary.split('\n')[0]}`);
    this.touch(room);
    if (broadcast) {
      this.broadcastRoom(room);
      this.scheduleRoomList();
    }
    return true;
  }

  private onChat(conn: Conn, room: Room, text: string): void {
    const seat = this.seatOf(room, conn.sessionId!);
    if (!seat) return this.error(conn, '你不在该房间的座位上');
    const msg: ServerMsg = { t: 'chat', from: seat.name, text: cleanText(text, LIMITS.chatMax), at: new Date().toISOString() };
    for (const c of this.roomConns(room)) this.send(c, msg);
  }

  // =========================================================================
  // 新闻 → 快讯
  // =========================================================================
  private newsIds(state: GameState): Set<string> {
    const set = new Set<string>();
    for (const n of state.news ?? []) if (n?.id) set.add(n.id);
    return set;
  }

  private freshNews(state: GameState, before: Set<string>): NewsItem[] {
    return (state.news ?? []).filter((n) => n?.id && !before.has(n.id));
  }

  /** 公开新闻 → 快讯（按时间先后）；超出上限时优先保留重要新闻 */
  private toFeed(room: Room, items: NewsItem[], actor: { teamId: string; name: string } | null, cap: number): FeedItem[] {
    const pub = items.filter((n) => n.visibility !== 'private');
    let pick = pub;
    if (pub.length > cap) {
      const keep = new Set<NewsItem>(pub.filter((n) => n.important).slice(0, cap));
      for (const n of pub) {
        if (keep.size >= cap) break;
        keep.add(n);
      }
      pick = pub.filter((n) => keep.has(n));
    }
    const names = new Map<string, string>();
    for (const s of room.info.seats) if (s.gameTeamId) names.set(s.gameTeamId, s.name);
    const at = new Date().toISOString();
    // 操作者只用于引擎没有标注触发者、且与操作者战队相关（相关战队或本队选手）的新闻：
    // 一次操作可能连带产生其他玩家的消息（如打完决赛后每个参赛玩家的「战罢」）与世界新闻（冠军），不能都记在操作者名下
    const roster = new Set<string>(actor ? room.state?.teams?.[actor.teamId]?.playerIds ?? [] : []);
    const concernsActor = (n: NewsItem): boolean =>
      !!actor && (!!n.teamIds?.includes(actor.teamId) || !!n.playerIds?.some((pid) => roster.has(pid)));
    // 其次：主角（首个相关战队）是某位玩家的新闻记在该玩家名下（如他人操作连带结算出的「X 战罢：第 5 名」），
    // 该玩家的客户端据此识别为自己的消息、不再弹出快讯
    const primarySeat = (n: NewsItem): string | undefined => {
      const first = n.teamIds?.[0];
      return first && names.has(first) ? first : undefined;
    };
    // state.news 新的在前 → 反转为时间顺序
    return pick.slice().reverse().map((n) => {
      const actorTeamId = n.actorTeamId ?? (concernsActor(n) ? actor!.teamId : primarySeat(n));
      const actorName = actorTeamId ? (actor && actorTeamId === actor.teamId ? actor.name : names.get(actorTeamId)) : undefined;
      const item: FeedItem = { id: n.id, at, title: n.title };
      if (actorTeamId) item.actorTeamId = actorTeamId;
      if (actorName) item.actorName = actorName;
      if (n.body) item.body = n.body;
      if (n.important) item.important = true;
      return item;
    });
  }

  // =========================================================================
  // 推送
  // =========================================================================
  private send(conn: Conn, msg: ServerMsg): void {
    this.sendRaw(conn, JSON.stringify(msg));
  }

  private sendRaw(conn: Conn, data: string): void {
    if (conn.closed || conn.ws.readyState !== OPEN) return;
    try {
      conn.ws.send(data);
    } catch (err) {
      this.log(`发送失败（连接 #${conn.id}）：${errMsg(err)}`);
    }
  }

  private error(conn: Conn, message: string, ref?: ClientMsg['t']): void {
    this.send(conn, ref ? { t: 'error', message, ref } : { t: 'error', message });
  }

  /** 房间内在线的连接 */
  private roomConns(room: Room): Conn[] {
    const out: Conn[] = [];
    for (const s of room.info.seats) {
      const c = this.bySession.get(s.sessionId);
      if (c && !c.closed && c.roomId === room.info.id) out.push(c);
    }
    return out;
  }

  /**
   * 发给某个会话的房间信息：会话 ID 是重连回座位的凭证（发给其他玩家后对方可以用它发 hello 顶替座位），
   * 因此一律不发送；座位用随机的座位键识别，房主与接收者自己的座位分别由 hostSeatKey / yourSeatKey 指出。
   * 逐个字段构造（不展开内部对象），内部新增的字段不会意外发给客户端。
   */
  roomInfoFor(room: Room | StoredRoom, viewer: string | null): RoomInfo {
    const info = 'info' in room ? room.info : room;
    const seats: RoomSeat[] = info.seats.map((s) => {
      const out: RoomSeat = { seatKey: s.seatKey, name: s.name, connected: s.connected, lobbyReady: s.lobbyReady };
      if (s.teamId !== undefined) out.teamId = s.teamId;
      if (s.newClub !== undefined) out.newClub = { ...s.newClub };
      if (s.gameTeamId !== undefined) out.gameTeamId = s.gameTeamId;
      return out;
    });
    const host = info.seats.find((s) => s.sessionId === info.hostSessionId);
    const you = viewer ? info.seats.find((s) => s.sessionId === viewer) : undefined;
    return {
      id: info.id,
      name: info.name,
      hostSeatKey: host?.seatKey ?? '',
      yourSeatKey: you?.seatKey ?? null,
      maxPlayers: info.maxPlayers,
      status: info.status,
      settings: { ...info.settings },
      seats,
      createdAt: info.createdAt,
    };
  }

  private sendRoom(conn: Conn, room: Room): void {
    this.send(conn, { t: 'room', room: this.roomInfoFor(room, conn.sessionId) });
  }

  private broadcastRoom(room: Room): void {
    for (const c of this.roomConns(room)) this.sendRoom(c, room);
  }

  private broadcastRoundStatus(room: Room, except?: Conn): void {
    const st = this.roundStatus(room);
    if (!st) return;
    const data = JSON.stringify({ t: 'roundStatus', status: st } satisfies ServerMsg);
    for (const c of this.roomConns(room)) if (c !== except) this.sendRaw(c, data);
  }

  /**
   * 推送座位视图：urgent（操作者本人/回合推进）立即发送；否则节流（两次推送间隔 ≥ stateIntervalMs，合并为最新版本）。
   */
  private pushState(conn: Conn, room: Room, urgent: boolean): void {
    if (conn.closed || conn.roomId !== room.info.id || !room.state) return;
    if (conn.sentRoomId === room.info.id && conn.sentVersion === room.version) {
      if (conn.stateTimer) clearTimeout(conn.stateTimer);
      conn.stateTimer = null;
      return;
    }
    const wait = conn.lastStateAt + this.stateIntervalMs - Date.now();
    if (!urgent && wait > 0) {
      if (!conn.stateTimer) {
        conn.stateTimer = setTimeout(() => {
          conn.stateTimer = null;
          const r = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
          if (r) this.pushState(conn, r, true);
        }, wait);
      }
      return;
    }
    if (conn.stateTimer) clearTimeout(conn.stateTimer);
    conn.stateTimer = null;
    if (conn.ws.bufferedAmount > MAX_BUFFERED) {
      // 慢客户端：稍后再推（届时发送最新版本）
      conn.stateTimer = setTimeout(() => {
        conn.stateTimer = null;
        const r = conn.roomId ? this.rooms.get(conn.roomId) : undefined;
        if (r) this.pushState(conn, r, true);
      }, Math.max(200, this.stateIntervalMs));
      return;
    }
    const seat = this.seatOf(room, conn.sessionId ?? '');
    const teamId = seat?.gameTeamId;
    if (!teamId) return;
    let cached = room.viewCache.get(teamId);
    if (!cached || cached.version !== room.version) {
      try {
        const view = this.engine.seatView(room.state, teamId);
        cached = { version: room.version, json: JSON.stringify({ t: 'state', version: room.version, state: view } satisfies ServerMsg) };
      } catch (e) {
        this.log(`房间 ${room.info.id} 生成视图失败（${teamId}）：${errMsg(e)}`);
        this.error(conn, `生成游戏视图失败：${errMsg(e)}`);
        return;
      }
      room.viewCache.set(teamId, cached);
    }
    this.sendRaw(conn, cached.json);
    conn.lastStateAt = Date.now();
    conn.sentVersion = room.version;
    conn.sentRoomId = room.info.id;
  }

  // =========================================================================
  // 房间列表 / 状态
  // =========================================================================
  private seatOf(room: Room, sessionId: string): StoredSeat | undefined {
    return room.info.seats.find((s) => s.sessionId === sessionId);
  }

  /**
   * 房间列表（按接收者）：已结束的对局只列给原座位玩家（可回去查看结算），大厅里不堆积别人打完的对局；
   * mine 标出接收者有座位的房间（进行中的对局只有原座位玩家能重新加入）。
   */
  roomSummaries(viewer: string | null = null): RoomSummary[] {
    const order = { lobby: 0, playing: 1, finished: 2 } as const;
    const out: RoomSummary[] = [];
    const rooms = [...this.rooms.values()]
      .sort((a, b) => order[a.info.status] - order[b.info.status] || b.info.createdAt.localeCompare(a.info.createdAt));
    for (const r of rooms) {
      const mine = !!viewer && !!this.seatOf(r, viewer);
      if (r.info.status === 'finished' && !mine) continue;
      const item: RoomSummary = {
        id: r.info.id,
        name: r.info.name,
        hostName: this.seatOf(r, r.info.hostSessionId)?.name ?? '',
        players: r.info.seats.length,
        maxPlayers: r.info.maxPlayers,
        status: r.info.status,
        settings: { ...r.info.settings },
      };
      if (mine) item.mine = true;
      out.push(item);
    }
    return out;
  }

  private sendRoomList(conn: Conn): void {
    this.send(conn, { t: 'roomList', rooms: this.roomSummaries(conn.sessionId) });
  }

  /** 推送房间列表给不在房间内的连接（合并 100ms 内的变化；列表按接收者生成，内容相同的复用序列化结果） */
  private scheduleRoomList(): void {
    if (this.roomListTimer || this.shuttingDown) return;
    this.roomListTimer = setTimeout(() => {
      this.roomListTimer = null;
      const cache = new Map<string, string>();
      for (const c of this.conns) {
        if (!c.sessionId || c.roomId) continue;
        const rooms = this.roomSummaries(c.sessionId);
        const key = rooms.map((r) => (r.mine ? `${r.id}*` : r.id)).join(',');
        let data = cache.get(key);
        if (data === undefined) {
          data = JSON.stringify({ t: 'roomList', rooms } satisfies ServerMsg);
          cache.set(key, data);
        }
        this.sendRaw(c, data);
      }
    }, 100);
  }

  roundStatus(room: Room): RoundStatus | null {
    const state = room.state;
    if (!state || room.info.status === 'lobby') return null;
    let mpSeats;
    try {
      mpSeats = seatsOf(this.engine.info(state));
    } catch {
      return null;
    }
    const st: RoundStatus = {
      season: state.season?.ti ?? 0,
      round: state.roundIndex ?? 0,
      ready: {},
      names: {},
      connected: {},
      eliminated: {},
    };
    for (const s of mpSeats) {
      st.ready[s.teamId] = !!s.ready;
      st.names[s.teamId] = s.name;
      st.eliminated[s.teamId] = !!s.eliminated;
      st.connected[s.teamId] = false;
    }
    for (const rs of room.info.seats) {
      if (!rs.gameTeamId) continue;
      st.connected[rs.gameTeamId] = rs.connected;
      st.names[rs.gameTeamId] ??= rs.name;
    }
    st.autopilot = {};
    for (const id of room.autopilot) st.autopilot[id] = true;
    st.autoPending = {};
    for (const s of mpSeats) if (s.autoReady && !s.ready && !s.eliminated) st.autoPending[s.teamId] = true;
    return st;
  }

  // =========================================================================
  // 持久化 / 维护
  // =========================================================================
  private touch(room: Room): void {
    if (this.rooms.get(room.info.id) === room) this.store?.markDirty(room.info.id);
  }

  private deleteRoom(room: Room, reason: string): void {
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = null;
    this.rooms.delete(room.info.id);
    void this.store?.remove(room.info.id);
    for (const c of this.conns) {
      if (c.roomId === room.info.id) {
        c.roomId = null;
        this.send(c, { t: 'room', room: null });
      }
    }
    this.log(`删除房间 ${room.info.id}（${reason}）`);
    this.scheduleRoomList();
  }

  /** 生成房间的持久化快照 */
  snapshot(roomId: string): RoomFile | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const online = room.info.seats.some((s) => s.connected);
    return {
      format: ROOM_FILE_FORMAT,
      savedAt: new Date().toISOString(),
      version: room.version,
      room: room.info,
      away: [...room.away],
      autopilot: [...room.autopilot],
      kicked: [...room.kicked],
      idleMs: online ? 0 : Math.max(0, Date.now() - room.lastActive),
      state: room.state,
    };
  }

  /** 启动时载入持久化的房间（全部座位标记离线；旧存档缺少的座位键在此补齐） */
  loadRooms(files: RoomFile[]): number {
    let n = 0;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    for (const f of files) {
      if (this.rooms.has(f.room.id)) continue;
      const seats: StoredSeat[] = [];
      for (const s of f.room.seats ?? []) {
        if (!s || typeof s.sessionId !== 'string' || seats.some((x) => x.sessionId === s.sessionId)) continue;
        const key = typeof s.seatKey === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(s.seatKey) && !seats.some((x) => x.seatKey === s.seatKey)
          ? s.seatKey
          : this.newSeatKey(seats);
        seats.push({
          ...s,
          seatKey: key,
          name: cleanText(s.name, LIMITS.playerNameMax) || '玩家',
          connected: false,
          lobbyReady: f.room.status === 'lobby' ? false : !!s.lobbyReady,
        });
      }
      const info: StoredRoom = {
        ...f.room,
        maxPlayers: Math.max(LIMITS.minPlayers, Math.min(LIMITS.maxPlayers, Number(f.room.maxPlayers) || 4)),
        settings: { ...this.defaultSettings(), ...(f.room.settings ?? {}) },
        seats,
      };
      if (!info.seats.length) continue;
      let state = f.state ?? null;
      if (info.status !== 'lobby' && !state) {
        // 损坏：对局状态丢失 → 回到大厅
        info.status = 'lobby';
        for (const s of info.seats) delete s.gameTeamId;
      }
      if (info.status === 'lobby') state = null;
      if (!info.seats.some((s) => s.sessionId === info.hostSessionId)) info.hostSessionId = info.seats[0].sessionId;
      // 无人在线的时长只计服务器运行时间：从存档时的累计值接着计时（服务器关闭期间不算）
      const idleMs = Math.max(0, Math.min(Number(f.idleMs) || 0, 10 * 365 * 24 * 3600_000));
      this.rooms.set(info.id, {
        info, state, version: Math.max(1, Number(f.version) || 1), away: new Set(strings(f.away)),
        kicked: new Set(strings(f.kicked).slice(-KICKED_MAX)),
        autopilot: new Set(info.status === 'playing' ? strings(f.autopilot) : []),
        tasks: [], running: false, starting: false, lastActive: Date.now() - idleMs, viewCache: new Map(), hostTimer: null,
      });
      n++;
    }
    return n;
  }

  /**
   * 定期维护（启动后立即一次，之后每分钟）：删除房间并删除其存档文件——
   * 无人在线超过 lobbyIdleMs 的大厅房间；无人在线超过 finishedRoomTtlMs 的已结束对局；
   * 连续无人在线超过 idleRoomTtlMs（只计服务器运行时间）的进行中对局。返回删除的房间数。
   */
  sweep(now = Date.now()): number {
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      if (room.starting || room.running) continue;
      if (!room.info.seats.length) {
        this.deleteRoom(room, '房间为空');
        removed++;
        continue;
      }
      if (room.info.seats.some((s) => s.connected)) continue;
      const idle = now - room.lastActive;
      const { status } = room.info;
      if (status === 'lobby' && idle > this.lobbyIdleMs) this.deleteRoom(room, '长时间无人在线');
      else if (status === 'finished' && idle > this.finishedRoomTtlMs) this.deleteRoom(room, '对局已结束且无人在线');
      else if (status === 'playing' && this.idleRoomTtlMs > 0 && idle > this.idleRoomTtlMs) {
        this.deleteRoom(room, `对局已连续 ${Math.round(idle / 86_400_000)} 天无人在线`);
      } else continue;
      removed++;
    }
    return removed;
  }

  /** 关闭：通知并断开所有连接 */
  shutdown(): void {
    this.shuttingDown = true;
    if (this.roomListTimer) clearTimeout(this.roomListTimer);
    this.roomListTimer = null;
    for (const room of this.rooms.values()) {
      if (room.hostTimer) clearTimeout(room.hostTimer);
      room.hostTimer = null;
    }
    for (const c of [...this.conns]) {
      if (c.stateTimer) clearTimeout(c.stateTimer);
      c.stateTimer = null;
      this.error(c, '服务器已关闭，进度已保存。房主重新启动服务器后可继续游戏');
      try {
        c.ws.close(1001, 'server shutdown');
      } catch {
        /* ignore */
      }
    }
  }

  /** 房间是否存在（测试/脚本） */
  getRoomState(roomId: string): GameState | null {
    return this.rooms.get(roomId)?.state ?? null;
  }

  /** 服务器内部的房间信息（含会话 ID，仅测试/脚本使用；发给客户端的是 roomInfoFor） */
  getRoomInfo(roomId: string): StoredRoom | null {
    return this.rooms.get(roomId)?.info ?? null;
  }

  /** 某个会话视角的房间信息（测试/脚本） */
  getRoomInfoFor(roomId: string, viewer: string | null): RoomInfo | null {
    const room = this.rooms.get(roomId);
    return room ? this.roomInfoFor(room, viewer) : null;
  }

  /** 所有房间 id */
  roomIds(): string[] {
    return [...this.rooms.keys()];
  }
}
