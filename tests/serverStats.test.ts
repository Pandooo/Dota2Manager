// 公网服务器：在线统计（人数、峰值、/api/status、节流推送、日志、每日汇总文件）与内网地址不外泄
// （公网模式不发局域网地址、非公网模式只发给局域网来源、错误信息不含内部细节）。
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameState, MultiplayerInfo, OpResult, SeatState } from '../src/engine/types';
import type { MpNewGameOptions } from '../src/engine/multi';
import type { MpEngine } from '../server/engine';
import { startServer, type RunningServer, type ServerOptions } from '../server/app';
import { TestClient, until } from '../server/testClient';
import {
  GENERIC_SERVER_ERROR, httpOrigin, isLoopbackAddress, isLoopbackRequest, isPrivateAddress, isPrivateOrigin, lanAddresses, publicSafeErrorText,
} from '../server/net';
import { ServerStats, dayKeyOf, zeroCounts, type OnlineCounts, type StatsSource } from '../server/stats';
import { mySeat } from '../src/shared/protocol';

// ---------------------------------------------------------------------------
// 假引擎（最小实现：existing 玩法开局、RPC、准备）
// ---------------------------------------------------------------------------
interface FakeState {
  settings: { playerTeamId: string };
  season: { ti: number };
  roundIndex: number;
  news: [];
  gameOver: null;
  multiplayer: MultiplayerInfo;
}

const LEAK_PATH = '/opt/dota2manager/secret/rosters/ti9.json';

function fakeEngine(): MpEngine {
  return {
    async createGame(opts: MpNewGameOptions) {
      const seats: Record<string, SeatState> = {};
      const order: string[] = [];
      opts.players.forEach((p, i) => {
        const teamId = p.teamId ?? `club-${i + 1}`;
        order.push(teamId);
        seats[teamId] = { teamId, sessionId: p.sessionId, name: p.name, eliminated: false, ready: false, saved: {} };
      });
      const s: FakeState = {
        settings: { playerTeamId: order[0] }, season: { ti: opts.startTi }, roundIndex: 0, news: [], gameOver: null,
        multiplayer: { mode: opts.mode, hostTeamId: order[0], order, seats, activeSeat: null },
      };
      return s as unknown as GameState;
    },
    callAsSeat(_state, _teamId, fn) {
      if (fn === 'doTraining') throw new Error(`ENOENT: no such file or directory, open '${LEAK_PATH}'`);
      if (fn === 'buyExtraTraining') throw new TypeError("Cannot read properties of undefined (reading 'secretField')");
      if (fn === 'playerDraftAction') throw new Error('英雄不可选：帕克');
      return { ok: true, message: fn };
    },
    seatView(state, teamId) {
      const s = JSON.parse(JSON.stringify(state)) as FakeState;
      s.settings.playerTeamId = teamId;
      for (const id of Object.keys(s.multiplayer.seats)) s.multiplayer.seats[id].sessionId = '';
      return s as unknown as GameState;
    },
    setSeatReady(state, teamId, ready): OpResult {
      (state as unknown as FakeState).multiplayer.seats[teamId].ready = ready;
      return { ok: true, message: '' };
    },
    allSeatsReady: () => false,
    advance: () => ({ ok: true, message: '' }),
    autopilot: () => ({ ok: true, message: '' }),
    info: (state) => (state as unknown as FakeState).multiplayer ?? null,
    startTis: () => [9],
    realTeams: async (ti) => (ti === 9 ? [
      { id: 'og', name: 'OG', tag: 'OG', region: 'EU' },
      { id: 'lgd', name: 'PSG.LGD', tag: 'LGD', region: 'CN' },
      { id: 'secret', name: 'Team Secret', tag: 'SECRET', region: 'EU' },
    ] : []),
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `d2m-${prefix}-`));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const running: RunningServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(running.splice(0).map((s) => s.close()));
});

const logs: string[] = [];
async function boot(opts: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: null,
    distDir: tmp('dist'),
    engine: fakeEngine(),
    log: (m) => logs.push(m),
    heartbeatMs: 0,
    persistDebounceMs: 20,
    statsPushIntervalMs: 150,
    ...opts,
  });
  running.push(s);
  return s;
}

let seq = 0;
async function client(server: RunningServer, name: string, opts: { sessionId?: string; headers?: Record<string, string> } = {}): Promise<TestClient> {
  const c = new TestClient(server.wsUrl, { sessionId: opts.sessionId ?? `sid-${++seq}-${Math.random().toString(36).slice(2, 10)}`, name, headers: opts.headers });
  clients.push(c);
  await c.hello();
  return c;
}

function get(server: RunningServer, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 任意来源地址 / 请求头的 GET（localAddress：从指定网卡发起，服务器看到的套接字地址即该地址） */
function httpGet(o: { port: number; path: string; host?: string; localAddress?: string; headers?: Record<string, string>; method?: string }): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: o.host ?? '127.0.0.1', port: o.port, path: o.path, localAddress: o.localAddress, headers: o.headers, method: o.method ?? 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] ?? '') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function status(server: RunningServer): Promise<ReturnType<RunningServer['stats']['status']>> {
  const r = await get(server, '/api/status');
  expect(r.status).toBe(200);
  return JSON.parse(r.body);
}

/** 建房 + 加入 + 选队 + 全员准备 + 开局（existing 玩法） */
async function startGame(server: RunningServer, cs: TestClient[]): Promise<string> {
  const teams = ['og', 'lgd', 'secret'];
  const [host, ...rest] = cs;
  const created = await host.request({ t: 'createRoom', name: '统计房', maxPlayers: 4 }, 'room', (m) => !!m.room);
  if (created.t !== 'room' || !created.room) throw new Error('建房失败');
  const roomId = created.room.id;
  for (const c of rest) await c.request({ t: 'joinRoom', roomId }, 'room', (m) => !!m.room);
  await host.request({ t: 'updateSettings', settings: { mode: 'existing', startTi: 9, endTi: 10 } }, 'room', (m) => m.room?.settings.mode === 'existing');
  for (let i = 0; i < cs.length; i++) {
    await cs[i].request({ t: 'updateSeat', teamId: teams[i] }, 'room', (m) => mySeat(m.room)?.teamId === teams[i]);
    await cs[i].request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!mySeat(m.room)?.lobbyReady);
  }
  const states = cs.map((c) => c.waitFor('state'));
  host.send({ t: 'startGame' });
  await Promise.all(states);
  return roomId;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
describe('net · 网页地址写法', () => {
  it('80 端口不写端口号（公网服务器 http://地址/），其他端口照写；IPv6 加方括号', () => {
    expect(httpOrigin('203.0.113.7', 80)).toBe('http://203.0.113.7');
    expect(httpOrigin('localhost', 80)).toBe('http://localhost');
    expect(httpOrigin('192.168.1.5', 8686)).toBe('http://192.168.1.5:8686');
    expect(httpOrigin('::1', 8686)).toBe('http://[::1]:8686');
    expect(httpOrigin('[::1]', 80)).toBe('http://[::1]');
  });
});

describe('net · 内网来源判断与错误过滤', () => {
  it('回环 / 私有 / 链路本地地址（含 IPv4 映射、方括号、端口、区域标识）', () => {
    for (const ip of [
      '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.3.4',
      '::1', '[::1]', '[::1]:8686', '::ffff:127.0.0.1', '::ffff:192.168.0.9', '::ffff:7f00:1', '::ffff:c0a8:105',
      'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'febf::1', '192.168.1.5:51234',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.1', '11.0.0.1', '::ffff:8.8.8.8',
      '2001:db8::1', '2400:3200::1', 'fec0::1', '::', '', 'unknown', 'localhost', '_hidden', '999.1.1.1', '[::1', undefined, null,
    ]) expect(isPrivateAddress(ip as string), String(ip)).toBe(false);
  });

  it('来源判断：套接字与每个转发来源都必须是内网（转发头不能把公网连接伪装成内网）', () => {
    expect(isPrivateOrigin('127.0.0.1')).toBe(true);
    expect(isPrivateOrigin('::ffff:192.168.1.7', {})).toBe(true);
    expect(isPrivateOrigin('8.8.8.8', { 'x-forwarded-for': '127.0.0.1' })).toBe(false);
    // 本机反向代理转发公网客户端
    expect(isPrivateOrigin('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).toBe(false);
    expect(isPrivateOrigin('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' })).toBe(false);
    expect(isPrivateOrigin('127.0.0.1', { 'x-real-ip': '203.0.113.9' })).toBe(false);
    expect(isPrivateOrigin('127.0.0.1', { forwarded: 'for="[2001:db8::1]:4711";proto=https' })).toBe(false);
    expect(isPrivateOrigin('127.0.0.1', { forwarded: 'for=unknown' })).toBe(false);
    // 局域网内经代理
    expect(isPrivateOrigin('127.0.0.1', { 'x-forwarded-for': '192.168.1.20, 10.0.0.2' })).toBe(true);
    expect(isPrivateOrigin('127.0.0.1', { forwarded: 'for=192.168.1.20;proto=http' })).toBe(true);
    expect(isPrivateOrigin(undefined, {})).toBe(false);
  });

  it('公网模式的错误文字：保留中文提示，去掉路径、调用栈、系统错误码与程序异常', () => {
    expect(publicSafeErrorText('英雄不可选：帕克')).toBe('英雄不可选：帕克');
    expect(publicSafeErrorText('座位不存在：club-1')).toBe('座位不存在：club-1');
    expect(publicSafeErrorText('TI 阵容中找不到战队「og」')).toBe('TI 阵容中找不到战队「og」');
    for (const m of [
      `ENOENT: no such file or directory, open '${LEAK_PATH}'`,
      `无法加载 TI9 阵容数据：ENOENT: no such file or directory, open '${LEAK_PATH}'`,
      `读取失败：${LEAK_PATH}`,
      '读取失败：C:\\Users\\someone\\dota\\ti9.json',
      "Cannot read properties of undefined (reading 'x')",
      'rng.pick on empty array',
      '出错了\n    at Object.<anonymous> (/srv/app/server/rooms.ts:12:3)',
      '出错了 at foo (node:internal/fs:1:1)',
      '无法加载 file:///srv/app/a 数据',
      '无法读取 roster.json',
      '',
    ]) expect(publicSafeErrorText(m), m).toBe(GENERIC_SERVER_ERROR);
  });
});

// ---------------------------------------------------------------------------
// 在线统计（真实服务器）
// ---------------------------------------------------------------------------
describe('server · 在线统计', () => {
  it('连接 / 加入 / 开局 / 断线时的人数、房间数与峰值；/api/status 只有数字', async () => {
    const s = await boot();
    const st0 = await status(s);
    expect(st0).toMatchObject({ ok: true, online: 0, connections: 0, inLobby: 0, inRoom: 0, inGame: 0 });
    expect(st0.rooms).toEqual({ total: 0, waiting: 0, playing: 0, active: 0, finished: 0 });

    const a = await client(s, '甲玩家');
    const b = await client(s, '乙玩家');
    let st = await status(s);
    expect(st).toMatchObject({ online: 2, connections: 2, inLobby: 2, inRoom: 0, inGame: 0 });
    expect(st.peak.online).toBe(2);
    expect(st.today.uniquePlayers).toBe(2);
    expect(st.today.totalConnections).toBe(2);

    // 建房：房主进入房间
    const created = await a.request({ t: 'createRoom', name: '房', maxPlayers: 4 }, 'room', (m) => !!m.room);
    if (created.t !== 'room' || !created.room) throw new Error('建房失败');
    st = await status(s);
    expect(st).toMatchObject({ online: 2, inLobby: 1, inRoom: 1, inGame: 0 });
    expect(st.rooms).toMatchObject({ total: 1, waiting: 1, playing: 0, active: 0 });
    await b.request({ t: 'joinRoom', roomId: created.room.id }, 'room', (m) => !!m.room);
    st = await status(s);
    expect(st).toMatchObject({ online: 2, inLobby: 0, inRoom: 2 });

    // 离开大厅房间：座位释放、回到大厅
    await b.request({ t: 'leaveRoom' }, 'roomList');
    st = await status(s);
    expect(st).toMatchObject({ online: 2, inLobby: 1, inRoom: 1 });
    await a.close();
    await until(() => s.rooms.conns.size === 1, 3000, '断线');
    st = await status(s);
    expect(st).toMatchObject({ online: 1, connections: 1, inLobby: 1, inRoom: 0 });
    // 房主断线：大厅房间保留（无人在线 30 分钟后才清理）
    expect(st.rooms).toMatchObject({ total: 1, waiting: 1 });
    expect(st.peak.online).toBe(2);
    expect(st.peak.at).toEqual(expect.any(String));

    // 开局：对局中玩家与进行中的对局
    const c1 = await client(s, '丙');
    const c2 = await client(s, '丁');
    await startGame(s, [c1, c2]);
    st = await status(s);
    expect(st).toMatchObject({ online: 3, inLobby: 1, inRoom: 2, inGame: 2 });
    expect(st.rooms).toMatchObject({ total: 2, waiting: 1, playing: 1, active: 1, finished: 0 });
    expect(st.today.gamesStarted).toBe(1);
    expect(st.sinceStart.gamesStarted).toBe(1);
    expect(st.peak.online).toBe(3);
    expect(st.peak.inGame).toBe(2);
    expect(st.today.uniquePlayers).toBe(4);
    // 对局中的玩家都断线：对局仍在进行，但不再算「有人在线」
    await c1.close();
    await c2.close();
    await until(() => s.rooms.conns.size === 1, 3000, '断线');
    st = await status(s);
    expect(st).toMatchObject({ online: 1, inGame: 0 });
    expect(st.rooms).toMatchObject({ playing: 1, active: 0 });

    // /api/status 与 /api/info 不含会话 ID、昵称、IP
    const raw = (await get(s, '/api/status')).body + (await get(s, '/api/info')).body + (await get(s, '/healthz')).body;
    for (const c of [a, b, c1, c2]) {
      expect(raw).not.toContain(c.sessionId);
      expect(raw).not.toContain(c.name);
    }
    expect(raw).not.toMatch(/127\.0\.0\.1|::1|192\.168\.|"ip"|sessionId|"name":"(?!dota2-manager)/);
    const info = JSON.parse((await get(s, '/api/info')).body);
    expect(info).toMatchObject({ ok: true, online: 1, inGame: 0, playing: 0 });
    // /healthz 保持原有字段（向后兼容）
    expect(Object.keys(JSON.parse((await get(s, '/healthz')).body)).sort()).toEqual(['connections', 'frontend', 'name', 'ok', 'protocol', 'rooms', 'wsPath']);
  });

  it('推送：hello 后立即收到一次；之后只在变化时推送，且相邻两次至少间隔 pushIntervalMs', async () => {
    const s = await boot({ statsPushIntervalMs: 400 });
    const a = await client(s, '观察者');
    await until(() => a.stats !== null, 2000, 'hello 后的统计');
    expect(a.stats).toEqual({ online: 1, inGame: 0, rooms: 0, playing: 0 });
    const times: number[] = [];
    const seen: string[] = [];
    a.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as { t: string };
      if (m.t === 'serverStats') {
        times.push(Date.now());
        seen.push(String(d));
      }
    });
    // 连续变化：6 个玩家陆续上线
    for (let i = 0; i < 6; i++) {
      await client(s, `路人${i}`);
      await new Promise((r) => setTimeout(r, 60));
    }
    await until(() => a.stats?.online === 7, 4000, '统计更新到 7 人');
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(380);
    // 6 次变化合并为更少的推送
    expect(times.length).toBeGreaterThanOrEqual(1);
    expect(times.length).toBeLessThan(6);
    // 相同内容不重复推送
    expect(new Set(seen).size).toBe(seen.length);
    // 不改变人数的消息不触发推送
    const before = times.length;
    a.send({ t: 'listRooms' });
    await a.waitFor('roomList');
    await new Promise((r) => setTimeout(r, 600));
    expect(times.length).toBe(before);
    // 新连接只收到 hello 后的一次（随后的广播内容相同，不重复发给它）
    const late = await client(s, '新人');
    await new Promise((r) => setTimeout(r, 700));
    expect(late.statsCount).toBe(1);
    expect(late.stats?.online).toBe(8);
  });

  it('日志：定期一行（只在变化时）与创新高；每日汇总文件只有数字，重启后同一天继续累计', async () => {
    const dataDir = tmp('stats');
    logs.length = 0;
    const s = await boot({ dataDir, statsLogIntervalMs: 200, statsPeakLogMinMs: 0 });
    const sid = 'raw-session-id-should-never-be-stored-0001';
    const a = await client(s, '张三', { sessionId: sid });
    const b = await client(s, '李四');
    await startGame(s, [a, b]);
    await until(() => logs.some((l) => /^在线 2 人（峰值 2，\d\d:\d\d）· 对局中 1 局 · 房间 1 个$/.test(l)), 3000, '定期统计日志');
    expect(logs.some((l) => l.startsWith('在线人数创新高：2 人'))).toBe(true);
    // 没有变化时不重复输出
    const n = logs.filter((l) => l.startsWith('在线 ')).length;
    await new Promise((r) => setTimeout(r, 600));
    expect(logs.filter((l) => l.startsWith('在线 ')).length).toBe(n);

    await a.close();
    await b.close();
    running.splice(running.indexOf(s), 1);
    await s.close();
    const dir = join(dataDir, 'stats');
    const month = dayKeyOf(Date.now()).slice(0, 7);
    const file = join(dir, `online-${month}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({
      date: dayKeyOf(Date.now()), peakOnline: 2, peakInGame: 2, uniquePlayers: 2, totalConnections: 2, gamesStarted: 1, partial: true,
    });
    // 统计文件不含会话 ID、昵称、IP
    const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(all).not.toContain(sid);
    expect(all).not.toContain(b.sessionId);
    expect(all).not.toMatch(/张三|李四|127\.0\.0\.1/);

    // 重启：同一天继续累计（同一会话不重复计入独立玩家）
    const s2 = await boot({ dataDir });
    await client(s2, '张三', { sessionId: sid });
    let st = await status(s2);
    expect(st.today).toMatchObject({ uniquePlayers: 2, totalConnections: 3, gamesStarted: 1, peakOnline: 2 });
    await client(s2, '王五');
    st = await status(s2);
    expect(st.today.uniquePlayers).toBe(3);
  });

  it('--no-save（dataDir = null）不写统计文件', async () => {
    const cwdStats = join(process.cwd(), 'server-data', 'stats');
    const existed = existsSync(cwdStats);
    const s = await boot({ dataDir: null });
    await client(s, '甲');
    running.splice(running.indexOf(s), 1);
    await s.close();
    expect(existsSync(cwdStats)).toBe(existed);
    expect(s.stats.dir).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ServerStats 单元：换日、日志节流
// ---------------------------------------------------------------------------
describe('stats · 换日与日志', () => {
  function fakeSource(counts: () => OnlineCounts, sessions: () => string[] = () => []): StatsSource & { pushed: string[] } {
    const pushed: string[] = [];
    return { counts, sessions, push: (d) => pushed.push(d), pushed };
  }

  it('跨零点：追加前一天的汇总并从当前在线状态开始新的一天', () => {
    const dir = join(tmp('rollover'), 'stats');
    const out: string[] = [];
    let now = new Date(2026, 9, 14, 23, 50).getTime();
    let c: OnlineCounts = { ...zeroCounts(), online: 3, inLobby: 1, inRoom: 2, inGame: 2 };
    const stats = new ServerStats({ dir, log: (m) => out.push(m), now: () => now, timers: false, logIntervalMs: 0 });
    stats.attach(fakeSource(() => c, () => ['s1', 's2', 's3']));
    for (const sid of ['s1', 's2', 's3', 's4']) {
      stats.connection();
      stats.session(sid);
    }
    stats.gameStarted();
    stats.changed();
    expect(stats.status().today).toMatchObject({ date: '2026-10-14', peakOnline: 3, peakInGame: 2, uniquePlayers: 4, totalConnections: 4, gamesStarted: 1 });

    now = new Date(2026, 9, 15, 0, 1).getTime();
    c = { ...zeroCounts(), online: 2, inLobby: 2 };
    stats.tick();
    const lines = readFileSync(join(dir, 'online-2026-10.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      date: '2026-10-14', peakOnline: 3, peakAt: new Date(2026, 9, 14, 23, 50).toISOString(), peakInGame: 2,
      uniquePlayers: 4, totalConnections: 4, gamesStarted: 1,
    });
    expect(out.some((l) => l.startsWith('在线统计 2026-10-14：峰值 3 人（23:50）'))).toBe(true);
    const today = stats.status().today;
    // 新的一天：当前在线的 3 个会话计入独立玩家，峰值从当前人数开始
    expect(today).toMatchObject({ date: '2026-10-15', peakOnline: 2, uniquePlayers: 3, totalConnections: 0, gamesStarted: 0 });
    // 当天累计文件只有散列
    const cur = readFileSync(join(dir, 'current.json'), 'utf8');
    expect(cur).not.toMatch(/"s[1-4]"/);

    // 跨月：写入新月份的文件
    now = new Date(2026, 10, 1, 0, 5).getTime();
    stats.tick();
    expect(existsSync(join(dir, 'online-2026-10.jsonl'))).toBe(true);
    stats.close();
    expect(existsSync(join(dir, 'online-2026-11.jsonl'))).toBe(true);
    const nov = readFileSync(join(dir, 'online-2026-11.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(nov.at(-1)).toMatchObject({ date: '2026-11-01', partial: true });
  });

  it('启动时发现更早日期的当天累计（跨零点时未运行）：作为该日汇总追加', () => {
    const dir = join(tmp('restore'), 'stats');
    let now = new Date(2026, 9, 14, 12, 0).getTime();
    const a = new ServerStats({ dir, now: () => now, timers: false });
    a.attach(fakeSource(() => ({ ...zeroCounts(), online: 5 })));
    a.connection();
    a.session('x');
    a.changed();
    a.flush();
    now = new Date(2026, 9, 16, 9, 0).getTime();
    const b = new ServerStats({ dir, now: () => now, timers: false });
    const lines = readFileSync(join(dir, 'online-2026-10.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ date: '2026-10-14', peakOnline: 5, uniquePlayers: 1, totalConnections: 1 });
    expect(lines.at(-1).partial).toBeUndefined();
    expect(b.status().today).toMatchObject({ date: '2026-10-16', uniquePlayers: 0, totalConnections: 0 });
    a.close();
    b.close();
  });

  it('定期日志只在变化时输出；创新高日志节流', () => {
    const out: string[] = [];
    let now = new Date(2026, 9, 14, 20, 0).getTime();
    let online = 0;
    const stats = new ServerStats({ dir: null, log: (m) => out.push(m), now: () => now, timers: false, logIntervalMs: 60_000, peakLogMinMs: 300_000 });
    stats.attach(fakeSource(() => ({ ...zeroCounts(), online, inLobby: online })));
    now += 60_000;
    stats.tick();
    expect(out).toEqual([]); // 无人在线、无变化：不输出
    online = 1;
    stats.changed();
    expect(out).toEqual(['在线人数创新高：1 人（自启动以来，20:01）']);
    online = 5;
    now += 1000;
    stats.changed(); // 5 分钟内的新高：推迟输出
    expect(out).toHaveLength(1);
    now += 59_000;
    stats.tick();
    expect(out.at(-1)).toBe('在线 5 人（峰值 5，20:01）· 对局中 0 局 · 房间 0 个');
    now += 60_000;
    stats.tick();
    expect(out.filter((l) => l.startsWith('在线 '))).toHaveLength(1);
    online = 4;
    stats.changed();
    now += 60_000;
    stats.tick();
    expect(out.at(-1)).toBe('在线 4 人（峰值 5，20:01）· 对局中 0 局 · 房间 0 个');
    stats.close();
  });
});

// ---------------------------------------------------------------------------
// 兼容端口（--also-port）：公网服务器改用 80 端口后，旧地址 :8686 仍是同一个服务器
// ---------------------------------------------------------------------------
describe('server · 兼容端口（--also-port）', () => {
  it('另一个端口是同一个服务器：网页与接口相同、玩家在同一批房间里；关闭时一起关闭', async () => {
    const s = await boot({ extraPorts: [0] });
    expect(s.extraPorts).toHaveLength(1);
    const extra = s.extraPorts[0];
    expect(extra).toBeGreaterThan(0);
    expect(extra).not.toBe(s.port);
    expect(s.extraHttp[0].listening).toBe(true);
    const info = await httpGet({ port: extra, path: '/api/info' });
    expect(info.status).toBe(200);
    expect(JSON.parse(info.body)).toMatchObject({ ok: true, name: 'dota2-manager' });
    // /api/status 在兼容端口上同样只回答本机
    expect((await httpGet({ port: extra, path: '/api/status' })).status).toBe(200);
    const fwd = await httpGet({ port: extra, path: '/api/status', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(fwd.status).toBe(403);
    expect(JSON.parse(fwd.body)).toEqual({ ok: false, error: '在线统计只允许在服务器本机访问' });
    // 静态前端在兼容端口上同样提供
    expect((await httpGet({ port: extra, path: '/' })).status).toBe((await httpGet({ port: s.port, path: '/' })).status);
    // 一人从主端口、一人从兼容端口进入：在同一个大厅里
    const a = await client(s, '新地址');
    const b = new TestClient(`ws://127.0.0.1:${extra}/ws`, { sessionId: `sid-also-${++seq}`, name: '旧地址' });
    clients.push(b);
    await b.hello();
    await until(() => s.rooms.onlineCounts().online === 2, 5000, '两人都在线');
    a.send({ t: 'createRoom', name: '过渡房间', maxPlayers: 4 });
    await until(() => !!a.room, 5000, '建房');
    b.send({ t: 'listRooms' });
    await until(() => b.rooms.some((r) => r.name === '过渡房间'), 5000, '旧地址看到新地址建的房间');
    running.splice(running.indexOf(s), 1);
    await s.close();
    expect(s.http.listening).toBe(false);
    expect(s.extraHttp[0].listening).toBe(false);
  });

  it('兼容端口被占用时启动失败（报 EADDRINUSE 与该端口，命令行据此提示）', async () => {
    const blocker = await boot();
    await expect(startServer({
      port: 0, host: '127.0.0.1', dataDir: null, distDir: tmp('dist'), engine: fakeEngine(), log: () => undefined, heartbeatMs: 0,
      extraPorts: [blocker.port],
    })).rejects.toMatchObject({ code: 'EADDRINUSE', port: blocker.port });
  });
});

// ---------------------------------------------------------------------------
// 内网地址与内部细节不外泄
// ---------------------------------------------------------------------------
describe('server · 公网模式与局域网地址', () => {
  const LAN = ['http://192.168.1.5:8686', 'http://10.0.0.8:8686'];

  it('非公网模式：只有来自局域网的连接收到局域网地址，经代理的公网连接收不到', async () => {
    const s = await boot({ lanUrls: () => LAN });
    expect(s.publicMode).toBe(false);
    const local = await client(s, '本机');
    expect(local.welcome?.lanUrls).toEqual(LAN);
    expect(local.welcome?.publicServer).toBeUndefined();
    const proxied = await client(s, '公网', { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    expect(proxied.welcome?.lanUrls).toEqual([]);
    const lanProxied = await client(s, '内网代理', { headers: { 'X-Forwarded-For': '192.168.1.30' } });
    expect(lanProxied.welcome?.lanUrls).toEqual(LAN);
  });

  it('公网模式：任何连接都收不到内网地址，welcome 标记 publicServer；错误信息不含路径与程序细节', async () => {
    const s = await boot({ publicMode: true, lanUrls: () => LAN });
    expect(s.publicMode).toBe(true);
    expect(s.lanUrls).toEqual([]);
    const a = await client(s, '甲');
    const b = await client(s, '乙');
    expect(a.welcome?.lanUrls).toEqual([]);
    expect(a.welcome?.publicServer).toBe(true);
    await startGame(s, [a, b]);
    const r1 = await a.call('doTraining');
    expect(r1.ok).toBe(false);
    expect(r1.message).toBe(`操作失败：${GENERIC_SERVER_ERROR}`);
    const r2 = await a.call('buyExtraTraining');
    expect(r2.message).toBe(`操作失败：${GENERIC_SERVER_ERROR}`);
    // 给玩家看的中文提示照常显示
    const r3 = await a.call('playerDraftAction', 'puck');
    expect(r3.message).toBe('操作失败：英雄不可选：帕克');
    // 服务器关闭的提示不提「房主」
    const bye = a.waitFor('error');
    running.splice(running.indexOf(s), 1);
    await s.close();
    expect((await bye).message).not.toContain('房主');
    // 发给客户端的全部消息里没有内网地址与路径
    const sent = JSON.stringify([...a.log, ...b.log]);
    for (const u of LAN) expect(sent).not.toContain(u.replace('http://', ''));
    expect(sent).not.toContain(LAN_PATH_FRAGMENT);
    expect(sent).not.toContain('secretField');
  });

  it('非公网模式保留详细的错误信息（便于房主排查）', async () => {
    const s = await boot();
    const a = await client(s, '甲');
    const b = await client(s, '乙');
    await startGame(s, [a, b]);
    const r = await a.call('doTraining');
    expect(r.message).toContain(LEAK_PATH);
    expect(a.welcome?.publicServer).toBeUndefined();
  });
});

const LAN_PATH_FRAGMENT = '/opt/dota2manager/secret';

// ---------------------------------------------------------------------------
// /api/status 只允许服务器本机访问（2026-10-15 用户决策）
// ---------------------------------------------------------------------------
const STATUS_DENIED = { ok: false, error: '在线统计只允许在服务器本机访问' };
/** 本机的一个非回环 IPv4 地址（没有可用网卡时跳过真实网卡用例） */
const LAN_IP = lanAddresses()[0] ?? null;

describe('server · /api/status 只允许服务器本机访问', () => {
  it('地址判断：只有回环地址算本机（局域网私有地址不算）；转发头只能让请求变成「非本机」，不能冒充本机', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '127.255.255.254', '::1', '[::1]', '[::1]:8686', '::ffff:127.0.0.1', '::ffff:127.1.2.3', '::ffff:7f00:1', '127.0.0.1:51234', '0:0:0:0:0:0:0:1']) {
      expect(isLoopbackAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '10.1.2.3', '192.168.1.5', '172.16.0.1', '169.254.3.4', '::ffff:192.168.0.9', '::ffff:c0a8:105', 'fe80::1', 'fe80::1%lo0', 'fc00::1',
      '8.8.8.8', '128.0.0.1', '126.255.255.255', '::2', '::', '::ffff:8.8.8.8', '', 'localhost', 'unknown', '[::1', undefined, null,
    ]) expect(isLoopbackAddress(ip as string), String(ip)).toBe(false);

    expect(isLoopbackRequest('127.0.0.1')).toBe(true);
    expect(isLoopbackRequest('::1', {})).toBe(true);
    expect(isLoopbackRequest('::ffff:127.0.0.1', {})).toBe(true);
    // 局域网内的其他电脑不算本机
    expect(isLoopbackRequest('192.168.1.20', {})).toBe(false);
    expect(isLoopbackRequest(undefined, {})).toBe(false);
    // 伪造的转发头不能冒充本机（X-Forwarded-For 不被信任）
    expect(isLoopbackRequest('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' })).toBe(false);
    expect(isLoopbackRequest('192.168.1.20', { 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' })).toBe(false);
    // 本机反向代理转发的外部请求（套接字是回环，转发来源不是）
    expect(isLoopbackRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).toBe(false);
    expect(isLoopbackRequest('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' })).toBe(false);
    expect(isLoopbackRequest('127.0.0.1', { 'x-forwarded-for': '192.168.1.20' })).toBe(false);
    expect(isLoopbackRequest('::1', { forwarded: 'for="[2001:db8::1]:4711"' })).toBe(false);
    expect(isLoopbackRequest('127.0.0.1', { forwarded: 'for=unknown' })).toBe(false);
    // 在服务器上经本机代理访问
    expect(isLoopbackRequest('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })).toBe(true);
  });

  it('本机 200；带外部转发来源的请求 403 与中文说明（--trust-proxy 也一样）；/healthz、/api/info 不受影响，/api/info 不含峰值与每日汇总', async () => {
    const s = await boot({ trustProxy: true });
    const ok = await httpGet({ port: s.port, path: '/api/status' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ ok: true, online: 0 });
    expect(JSON.parse(ok.body)).toHaveProperty('peak');
    expect(JSON.parse(ok.body)).toHaveProperty('today');

    for (const headers of <Record<string, string>[]>[
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
      { 'x-real-ip': '198.51.100.7' },
      { forwarded: 'for=192.168.1.20;proto=https' },
    ]) {
      const r = await httpGet({ port: s.port, path: '/api/status', headers });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.type).toContain('application/json');
      expect(JSON.parse(r.body)).toEqual(STATUS_DENIED);
    }
    const head = await httpGet({ port: s.port, path: '/api/status', method: 'HEAD', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(head.status).toBe(403);
    expect(head.body).toBe('');
    // 查询串不影响判断
    expect((await httpGet({ port: s.port, path: '/api/status?x=1', headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(403);

    // /healthz 与 /api/info 对外照常（大厅向所有人显示的在线人数可以留在 /api/info）
    const ext = { 'x-forwarded-for': '203.0.113.9' };
    const health = await httpGet({ port: s.port, path: '/healthz', headers: ext });
    expect(health.status).toBe(200);
    expect(Object.keys(JSON.parse(health.body)).sort()).toEqual(['connections', 'frontend', 'name', 'ok', 'protocol', 'rooms', 'wsPath']);
    const info = await httpGet({ port: s.port, path: '/api/info', headers: ext });
    expect(info.status).toBe(200);
    expect(Object.keys(JSON.parse(info.body)).sort()).toEqual(
      ['connections', 'frontend', 'inGame', 'name', 'ok', 'online', 'playing', 'protocol', 'rooms', 'wsPath'],
    );
    expect(info.body).not.toMatch(/peak|today|sinceStart|uptime|startedAt|uniquePlayers/);
  });

  it.runIf(!!LAN_IP)('来自非回环网卡的真实请求 403，伪造 X-Forwarded-For / X-Real-IP / Forwarded 为 127.0.0.1 也一样（含 --trust-proxy）', async () => {
    const ip = LAN_IP as string;
    for (const trustProxy of [false, true]) {
      const s = await boot({ host: ip, trustProxy });
      const plain = await httpGet({ host: ip, localAddress: ip, port: s.port, path: '/api/status' });
      expect(plain.status).toBe(403);
      expect(JSON.parse(plain.body)).toEqual(STATUS_DENIED);
      const spoofed = await httpGet({
        host: ip, localAddress: ip, port: s.port, path: '/api/status',
        headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1' },
      });
      expect(spoofed.status).toBe(403);
      // 同一来源的 /api/info 照常
      expect((await httpGet({ host: ip, localAddress: ip, port: s.port, path: '/api/info' })).status).toBe(200);
    }
  });
});
