// ============================================================================
// 组装 HTTP（静态前端 + /healthz、/api/info、/api/status（仅本机））+ WebSocket（/ws）服务器。
// index.ts 是命令行入口；e2e/测试直接调用 startServer。
// ============================================================================
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_SERVER_PORT, PROTOCOL_VERSION, WS_PATH } from '../src/shared/protocol';
import { defaultEngine, type MpEngine } from './engine';
import { clientAddress, isLoopbackRequest, isPrivateAddress, isPrivateOrigin, lanUrls as computeLanUrls } from './net';
import { RoomStore } from './persistence';
import { RoomManager, type Conn } from './rooms';
import { createStaticHandler } from './static';
import { ServerStats } from './stats';
import { LIMITS } from './validate';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '..');

export interface ServerOptions {
  /** 端口（0 = 随机） */
  port?: number;
  /** 监听地址（默认 0.0.0.0，局域网可访问） */
  host?: string;
  /** 数据目录（房间存档在 <dataDir>/rooms）；null = 不持久化 */
  dataDir?: string | null;
  /** 前端构建产物目录（默认 <项目>/dist） */
  distDir?: string;
  engine?: MpEngine;
  serverName?: string;
  log?: (msg: string) => void;
  /** 视图推送最小间隔（毫秒，默认 250） */
  stateIntervalMs?: number;
  /** 持久化防抖（毫秒） */
  persistDebounceMs?: number;
  /** 心跳间隔（毫秒，默认 20000；0 = 关闭） */
  heartbeatMs?: number;
  /** WebSocket 压缩（默认开启，局域网 Wi-Fi 下快照可缩小约 5–10 倍） */
  compression?: boolean;
  maxConnections?: number;
  /** 房主离线多久后移交给在线玩家（毫秒，默认 30000） */
  hostGraceMs?: number;
  /** 房间数上限（默认 64；满了会先清理无人在线的已结束对局，其次无人在线的大厅房间） */
  maxRooms?: number;
  /** 已结束的对局在无人在线后保留多久（毫秒，默认 2 小时） */
  finishedRoomTtlMs?: number;
  /** 进行中的对局连续无人在线多久后删除（毫秒，只计服务器运行时间；默认 14 天，0 = 永不删除） */
  idleRoomTtlMs?: number;
  /**
   * 公网模式（--public / D2M_PUBLIC=1）：不向客户端发送任何内网地址（welcome.lanUrls 为空并标记 publicServer），
   * 发给客户端的错误信息不含内部细节。非公网模式下，局域网地址也只发给来自回环 / 私有网段的连接。
   */
  publicMode?: boolean;
  /** 局域网访问地址（默认按网卡与监听地址计算；测试用） */
  lanUrls?: () => string[];
  /** 在线统计日志间隔（毫秒，默认 10 分钟；0 = 不定期输出） */
  statsLogIntervalMs?: number;
  /** 在线统计推送给客户端的最小间隔（毫秒，默认 2000） */
  statsPushIntervalMs?: number;
  /** 在线人数「创新高」日志的最小间隔（毫秒，默认 5 分钟） */
  statsPeakLogMinMs?: number;
  /** 同一来源地址最多同时保持的 WebSocket 连接数（默认 16；0 = 不限）。超出时回复 HTTP 429 */
  maxConnectionsPerAddress?: number;
  /** 同一来源地址每分钟最多新建的 WebSocket 连接数（默认 60；0 = 不限） */
  connectionsPerAddressPerMinute?: number;
  /**
   * 按来源地址的限制（连接数、建房、开局次数）是否也作用于回环 / 局域网地址（默认 false：只限制公网来源，
   * 局域网聚会与本机测试不受影响）。
   */
  limitPrivateAddresses?: boolean;
  /**
   * 信任反向代理（--trust-proxy）：来源地址取 X-Forwarded-For 的第一个地址（只在服务器部署在本机反向代理后面时使用；
   * 直接对外监听时转发头可被客户端伪造，默认 false，一律用套接字地址）。
   */
  trustProxy?: boolean;
  /** 房间数满时可清理的「无人在线的进行中对局」的最短无人在线时长（毫秒，默认 60 分钟；0 = 不清理） */
  abandonedRoomEvictMs?: number;
  /** 同一来源地址最多同时拥有的等待中房间数（默认 3） */
  maxLobbyRoomsPerAddress?: number;
  /** 同一来源地址每小时最多开局次数（默认 6） */
  maxGamesPerAddressPerHour?: number;
}

export interface RunningServer {
  port: number;
  /** http://localhost:<port> */
  url: string;
  /** ws://localhost:<port>/ws */
  wsUrl: string;
  /** 局域网访问地址（公网模式下为空，不打印也不发给客户端） */
  lanUrls: string[];
  publicMode: boolean;
  rooms: RoomManager;
  store: RoomStore | null;
  /** 在线统计（GET /api/status） */
  stats: ServerStats;
  http: Server;
  /** 同步写出所有未落盘的房间 */
  flushSync(): number;
  /** 关闭服务器（保存房间、断开连接） */
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`));
  const host = opts.host ?? '0.0.0.0';
  const engine = opts.engine ?? defaultEngine;
  const distDir = opts.distDir ?? join(PROJECT_ROOT, 'dist');
  const maxConnections = opts.maxConnections ?? 256;
  const maxPerAddress = Math.max(0, Math.floor(opts.maxConnectionsPerAddress ?? 16));
  const perAddressPerMin = Math.max(0, Math.floor(opts.connectionsPerAddressPerMinute ?? 60));
  const limitPrivate = !!opts.limitPrivateAddresses;
  const trustProxy = !!opts.trustProxy;
  let port = opts.port ?? DEFAULT_SERVER_PORT;

  const publicMode = !!opts.publicMode;
  const dataRoot = opts.dataDir === null ? null : resolve(opts.dataDir ?? join(process.cwd(), 'server-data'));
  const store = dataRoot === null ? null : new RoomStore({ dir: join(dataRoot, 'rooms'), debounceMs: opts.persistDebounceMs, log });
  const stats = new ServerStats({
    dir: dataRoot === null ? null : join(dataRoot, 'stats'),
    log,
    logIntervalMs: opts.statsLogIntervalMs,
    pushIntervalMs: opts.statsPushIntervalMs,
    peakLogMinMs: opts.statsPeakLogMinMs,
  });

  // 局域网地址只在监听所有网卡时有意义：--host 127.0.0.1 时朋友无法访问，指定了具体地址时只给出该地址；公网模式不提供
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  const loopback = /^(127\.|localhost$|::1$)/.test(host);
  const computeNow = (): string[] => (wildcard ? computeLanUrls(port) : loopback ? [] : [`http://${host.includes(':') ? `[${host}]` : host}:${port}`]);
  const lanUrlsNow = publicMode ? (): string[] => [] : (opts.lanUrls ?? computeNow);
  const rooms = new RoomManager({
    engine,
    store,
    serverName: opts.serverName ?? '刀塔经理服务器', // 不默认使用主机名（常含机主姓名，会发给局域网内所有客户端）
    lanUrls: lanUrlsNow,
    publicMode,
    stats,
    log,
    stateIntervalMs: opts.stateIntervalMs,
    hostGraceMs: opts.hostGraceMs,
    maxRooms: opts.maxRooms,
    finishedRoomTtlMs: opts.finishedRoomTtlMs,
    idleRoomTtlMs: opts.idleRoomTtlMs,
    abandonedRoomEvictMs: opts.abandonedRoomEvictMs,
    maxLobbyRoomsPerAddress: opts.maxLobbyRoomsPerAddress,
    maxGamesPerAddressPerHour: opts.maxGamesPerAddressPerHour,
  });
  stats.attach({ counts: () => rooms.onlineCounts(), sessions: () => rooms.onlineSessions(), push: (data) => rooms.pushStats(data) });
  if (store) {
    const loaded = rooms.loadRooms(store.loadAll());
    if (loaded) log(`已载入 ${loaded} 个房间（${store.dir}）`);
    // 启动时先清理一次（已过保留期的已结束对局等），房间列表与存档目录保持干净
    const swept = rooms.sweep();
    if (swept) log(`已清理 ${swept} 个过期房间`);
  }

  const serveStatic = createStaticHandler(distDir);
  const http = createServer((req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      const json = (data: unknown, code = 200) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data));
      };
      if (path === '/healthz' || path === '/api/info') {
        const base = {
          ok: true,
          name: 'dota2-manager',
          protocol: PROTOCOL_VERSION,
          wsPath: WS_PATH,
          rooms: rooms.roomIds().length,
          connections: rooms.conns.size,
          frontend: serveStatic.hasIndex(),
        };
        if (path === '/healthz') return json(base);
        // /api/info 另附当前在线人数（大厅也向所有人显示这几个数）；峰值、每日汇总等详细统计只在 /api/status（仅本机）
        const c = rooms.onlineCounts();
        return json({ ...base, online: c.online, inGame: c.inGame, playing: c.rooms.active });
      }
      // 在线统计：只有人数与时间（不含昵称、会话 ID、IP）；只回答服务器本机的请求（2026-10-15 用户决策），
      // 只看套接字地址，转发头不能冒充本机（经本机反向代理转发的外部请求带有非回环的转发来源，同样拒绝）
      if (path === '/api/status') {
        if (!isLoopbackRequest(req.socket.remoteAddress, req.headers)) {
          return json({ ok: false, error: '在线统计只允许在服务器本机访问' }, 403);
        }
        return json(stats.status());
      }
      serveStatic(req, res);
    } catch (err) {
      log(`HTTP 处理出错：${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('服务器内部错误');
    }
  });
  http.on('clientError', (_err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxPayload,
    perMessageDeflate: opts.compression === false
      ? false
      : { zlibDeflateOptions: { level: 1 }, threshold: 8 * 1024, concurrencyLimit: 4, serverNoContextTakeover: true, clientNoContextTakeover: true },
  });

  // 同一来源地址的连接数与新建速率（默认只限制公网来源）：一个客户端不能占满全部连接 / 房间
  const liveByAddr = new Map<string, number>();
  const recentByAddr = new Map<string, number[]>();
  const limitedAddr = (addr: string) => !!addr && (limitPrivate || !isPrivateAddress(addr));
  const reject = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) return reject(socket, '404 Not Found');
    if (rooms.conns.size >= maxConnections) return reject(socket, '503 Service Unavailable');
    const addr = clientAddress(req.socket.remoteAddress, req.headers, trustProxy);
    if (limitedAddr(addr)) {
      if (maxPerAddress > 0 && (liveByAddr.get(addr) ?? 0) >= maxPerAddress) return reject(socket, '429 Too Many Requests');
      if (perAddressPerMin > 0) {
        const now = Date.now();
        const recent = (recentByAddr.get(addr) ?? []).filter((t) => now - t < 60_000);
        if (recent.length >= perAddressPerMin) {
          recentByAddr.set(addr, recent);
          return reject(socket, '429 Too Many Requests');
        }
        recent.push(now);
        recentByAddr.set(addr, recent);
      }
    }
    socket.on('error', () => undefined);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  // 过期的新建记录定期清掉（地址很多时不常驻内存）
  const addrSweeper = setInterval(() => {
    const now = Date.now();
    for (const [addr, list] of recentByAddr) {
      const keep = list.filter((t) => now - t < 60_000);
      if (keep.length) recentByAddr.set(addr, keep);
      else recentByAddr.delete(addr);
    }
  }, 60_000);
  addrSweeper.unref?.();

  const connOf = new WeakMap<WebSocket, Conn>();
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // 来源地址：默认取套接字地址（直接对外监听时转发头可被伪造）；--trust-proxy 时取 X-Forwarded-For 的第一个地址
    const ip = clientAddress(req.socket.remoteAddress, req.headers, trustProxy);
    // 来源是否为局域网：套接字地址与转发头声明的来源都必须是回环 / 私有地址（转发头可被伪造，不能单独信任）
    const conn = rooms.addConn(ws, ip, isPrivateOrigin(req.socket.remoteAddress, req.headers), limitedAddr(ip));
    connOf.set(ws, conn);
    if (limitedAddr(ip)) liveByAddr.set(ip, (liveByAddr.get(ip) ?? 0) + 1);
    // hello 超时
    const helloTimer = setTimeout(() => {
      if (!conn.sessionId && !conn.closed) {
        try {
          ws.close(4001, 'hello timeout');
        } catch {
          /* ignore */
        }
      }
    }, 20_000);
    helloTimer.unref?.();
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        rooms.handleRaw(conn, '{}');
        return;
      }
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
      rooms.handleRaw(conn, text);
    });
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (limitedAddr(ip)) {
        const n = (liveByAddr.get(ip) ?? 1) - 1;
        if (n > 0) liveByAddr.set(ip, n);
        else liveByAddr.delete(ip);
      }
      rooms.removeConn(conn);
    });
    ws.on('error', (err) => {
      log(`连接 #${conn.id} 出错：${err.message}`);
    });
  });

  // 心跳：断网/休眠的客户端在两个周期内被识别为离线
  const heartbeatMs = opts.heartbeatMs ?? 20_000;
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => {
      for (const ws of wss.clients) {
        const conn = connOf.get(ws);
        if (!conn) continue;
        if (!conn.alive) {
          ws.terminate();
          continue;
        }
        conn.alive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, heartbeatMs)
    : null;
  heartbeat?.unref?.();
  const sweeper = setInterval(() => rooms.sweep(), 60_000);
  sweeper.unref?.();

  await new Promise<void>((resolveListen, reject) => {
    const onError = (err: Error) => {
      http.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      http.off('error', onError);
      resolveListen();
    };
    http.once('error', onError);
    http.once('listening', onListening);
    http.listen(port, host);
  });
  const addr = http.address();
  if (addr && typeof addr === 'object') port = addr.port;
  http.on('error', (err) => log(`HTTP 服务器错误：${err.message}`));

  let closed = false;
  const running: RunningServer = {
    port,
    url: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}${WS_PATH}`,
    lanUrls: lanUrlsNow(),
    publicMode,
    rooms,
    store,
    stats,
    http,
    flushSync: () => {
      stats.flush();
      return store ? store.flushSync(rooms.roomIds()) : 0;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      // 先同步写出在线统计（当天截至目前的汇总），之后断开连接引起的人数变化不再计入
      stats.close();
      if (heartbeat) clearInterval(heartbeat);
      clearInterval(sweeper);
      clearInterval(addrSweeper);
      rooms.shutdown();
      if (store) {
        await store.flush();
        store.close();
      }
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => {
        http.close(() => r());
        http.closeAllConnections?.();
      });
    },
  };
  return running;
}
