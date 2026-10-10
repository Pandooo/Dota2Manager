// ============================================================================
// 组装 HTTP（静态前端）+ WebSocket（/ws）服务器。index.ts 是命令行入口；e2e/测试直接调用 startServer。
// ============================================================================
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_SERVER_PORT, PROTOCOL_VERSION, WS_PATH } from '../src/shared/protocol';
import { defaultEngine, type MpEngine } from './engine';
import { lanUrls as computeLanUrls } from './net';
import { RoomStore } from './persistence';
import { RoomManager, type Conn } from './rooms';
import { createStaticHandler } from './static';
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
}

export interface RunningServer {
  port: number;
  /** http://localhost:<port> */
  url: string;
  /** ws://localhost:<port>/ws */
  wsUrl: string;
  lanUrls: string[];
  rooms: RoomManager;
  store: RoomStore | null;
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
  let port = opts.port ?? DEFAULT_SERVER_PORT;

  const store = opts.dataDir === null
    ? null
    : new RoomStore({ dir: join(resolve(opts.dataDir ?? join(process.cwd(), 'server-data')), 'rooms'), debounceMs: opts.persistDebounceMs, log });

  // 局域网地址只在监听所有网卡时有意义：--host 127.0.0.1 时朋友无法访问，指定了具体地址时只给出该地址
  const wildcard = host === '0.0.0.0' || host === '::' || host === '';
  const loopback = /^(127\.|localhost$|::1$)/.test(host);
  const lanUrlsNow = (): string[] => (wildcard ? computeLanUrls(port) : loopback ? [] : [`http://${host.includes(':') ? `[${host}]` : host}:${port}`]);
  const rooms = new RoomManager({
    engine,
    store,
    serverName: opts.serverName ?? '刀塔经理服务器', // 不默认使用主机名（常含机主姓名，会发给局域网内所有客户端）
    lanUrls: lanUrlsNow,
    log,
    stateIntervalMs: opts.stateIntervalMs,
    hostGraceMs: opts.hostGraceMs,
    maxRooms: opts.maxRooms,
    finishedRoomTtlMs: opts.finishedRoomTtlMs,
    idleRoomTtlMs: opts.idleRoomTtlMs,
  });
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
      if (path === '/healthz' || path === '/api/info') {
        const body = JSON.stringify({
          ok: true,
          name: 'dota2-manager',
          protocol: PROTOCOL_VERSION,
          wsPath: WS_PATH,
          rooms: rooms.roomIds().length,
          connections: rooms.conns.size,
          frontend: serveStatic.hasIndex(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
        return;
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

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (rooms.conns.size >= maxConnections) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.on('error', () => undefined);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const connOf = new WeakMap<WebSocket, Conn>();
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    const conn = rooms.addConn(ws, ip);
    connOf.set(ws, conn);
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
    rooms,
    store,
    http,
    flushSync: () => (store ? store.flushSync(rooms.roomIds()) : 0),
    close: async () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      clearInterval(sweeper);
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
