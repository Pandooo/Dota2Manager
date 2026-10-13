// 局域网服务器（server/）：静态托管、消息校验、大厅流程、RPC 顺序与抢签、快讯、回合推进、节流、重连、持久化。
// 游戏逻辑用假的 MpEngine 注入（不依赖 multi.ts 的实现进度）；真实引擎的全流程见 scripts/mp-e2e.ts。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameState, MultiplayerInfo, NewsItem, OpResult, SeatState } from '../src/engine/types';
import type { MpNewGameOptions } from '../src/engine/multi';
import type { MpEngine, RealTeamInfo } from '../server/engine';
import { startServer, type RunningServer } from '../server/app';
import { TestClient, until } from '../server/testClient';
import { parseClientMsg, cleanText } from '../server/validate';
import { resolveSafePath } from '../server/static';
import { RoomStore, ROOM_FILE_FORMAT, type RoomFile } from '../server/persistence';
import { PROTOCOL_VERSION, mySeat } from '../src/shared/protocol';
import { registerNodeRosterLoader } from '../scripts/nodeData';

// ---------------------------------------------------------------------------
// 假引擎：最小 GameState + 座位私有字段 secret
// ---------------------------------------------------------------------------
interface FakeState {
  settings: { playerTeamId: string };
  season: { ti: number };
  roundIndex: number;
  news: NewsItem[];
  idCounter: number;
  teams: Record<string, { id: string; name: string }>;
  players: Record<string, { id: string; handle: string; teamId: string | null }>;
  gameOver: null | { reason: string; summary: string };
  multiplayer: MultiplayerInfo;
  /** 顶层私有字段（换入的座位） */
  secret?: string;
  blocked?: Record<string, boolean>;
}

const REAL: RealTeamInfo[] = [
  { id: 'og', name: 'OG', tag: 'OG', region: 'EU' },
  { id: 'lgd', name: 'PSG.LGD', tag: 'LGD', region: 'CN' },
  { id: 'secret', name: 'Team Secret', tag: 'SECRET', region: 'EU' },
];

function addNews(s: FakeState, title: string, visibility: 'public' | 'private', important = false, teamIds?: string[]): void {
  s.idCounter++;
  s.news.unshift({
    id: `n-${s.idCounter}`, season: s.season.ti, round: s.roundIndex, date: '', category: 'transfer', title, body: '', important, visibility,
    ...(teamIds ? { teamIds } : {}),
  });
}

function makeFakeEngine(): MpEngine & { calls: string[] } {
  const calls: string[] = [];
  const eng: MpEngine & { calls: string[] } = {
    calls,
    async createGame(opts: MpNewGameOptions) {
      const seats: Record<string, SeatState> = {};
      const teams: FakeState['teams'] = {};
      const order: string[] = [];
      opts.players.forEach((p, i) => {
        const teamId = p.teamId ?? `club-${i + 1}`;
        order.push(teamId);
        teams[teamId] = { id: teamId, name: p.newClub?.name ?? REAL.find((t) => t.id === p.teamId)?.name ?? teamId };
        seats[teamId] = { teamId, sessionId: p.sessionId, name: p.name, eliminated: false, ready: false, saved: { top: { secret: `secret-of-${teamId}` } } };
      });
      const s: FakeState = {
        settings: { playerTeamId: order[0] },
        season: { ti: opts.startTi },
        roundIndex: 0,
        news: [],
        idCounter: 0,
        teams,
        players: { ame: { id: 'ame', handle: 'Ame', teamId: null }, sccc: { id: 'sccc', handle: 'Sccc', teamId: null } },
        gameOver: null,
        multiplayer: { mode: opts.mode, hostTeamId: order[0], order, seats, activeSeat: null },
        blocked: {},
      };
      return s as unknown as GameState;
    },
    callAsSeat(state, teamId, fn, args) {
      const s = state as unknown as FakeState;
      calls.push(`${teamId}:${fn}`);
      if (fn === 'doTraining') throw new Error('引擎炸了');
      if (fn === 'setLineupSlot') return { ok: true, message: 'ok', teamArg: args[0] };
      if (fn === 'markNewsRead') return undefined;
      if (fn === 'signFreeAgent') {
        const p = s.players[String(args[0])];
        if (!p) return { ok: false, message: '选手不存在' };
        if (p.teamId) return { ok: false, message: `${p.handle} 已有东家，请通过转会报价求购` };
        p.teamId = teamId;
        // 真实引擎从标题推断相关战队（teamIds），快讯据此把新闻记在操作者名下
        addNews(s, `【官宣】${p.handle} 加盟 ${s.teams[teamId].name}`, 'public', true, [teamId]);
        addNews(s, `签字费支出 ${teamId}`, 'private');
        // 同一次操作连带产生的世界新闻：不记在操作者名下
        addNews(s, `世界新闻：${p.handle} 转会尘埃落定`, 'public');
        // 连带产生的、主角是另一名玩家的新闻（如他人操作结算出的「战罢」）：记在该玩家名下
        if (teamId !== 'og') addNews(s, 'OG 赛事战罢', 'public', false, ['og']);
        return { ok: true, message: `成功签下 ${p.handle}` };
      }
      if (fn === 'resolveDecision') {
        s.blocked![teamId] = false;
        return { ok: true, message: '已处理' };
      }
      return { ok: true, message: fn };
    },
    seatView(state, teamId) {
      const s = JSON.parse(JSON.stringify(state)) as FakeState;
      s.settings.playerTeamId = teamId;
      s.secret = String(s.multiplayer.seats[teamId].saved.top?.secret);
      for (const id of Object.keys(s.multiplayer.seats)) s.multiplayer.seats[id].saved = {};
      s.news = s.news.filter((n) => n.visibility !== 'private' || n.title.includes(teamId));
      return s as unknown as GameState;
    },
    setSeatReady(state, teamId, ready): OpResult {
      const s = state as unknown as FakeState;
      if (ready && s.blocked?.[teamId]) return { ok: false, message: '还有 1 项待处理事务' };
      s.multiplayer.seats[teamId].ready = ready;
      return { ok: true, message: '' };
    },
    allSeatsReady(state) {
      const s = state as unknown as FakeState;
      return Object.values(s.multiplayer.seats).every((x) => x.eliminated || x.ready);
    },
    advance(state): OpResult {
      const s = state as unknown as FakeState;
      s.roundIndex++;
      for (const x of Object.values(s.multiplayer.seats)) x.ready = false;
      for (let i = 0; i < 40; i++) addNews(s, `世界新闻 ${s.roundIndex}-${i}`, 'public', i === 39);
      addNews(s, `财务明细 ${s.roundIndex}`, 'private');
      if (s.roundIndex >= 3) s.gameOver = { reason: 'completed', summary: '执教生涯已结束' };
      return { ok: true, message: `第 ${s.roundIndex} 回合` };
    },
    autopilot(state, teamId): OpResult {
      const s = state as unknown as FakeState;
      calls.push(`${teamId}:autopilot`);
      const seat = s.multiplayer.seats[teamId];
      if (!seat || seat.eliminated || seat.ready) return { ok: true, message: '' };
      const notes: string[] = [];
      if (s.blocked?.[teamId]) {
        s.blocked[teamId] = false;
        notes.push('托管处理了待决事件');
      }
      seat.ready = true;
      notes.push('已准备');
      return { ok: true, message: notes.join('；') };
    },
    info: (state) => (state as unknown as FakeState).multiplayer ?? null,
    startTis: () => [9],
    realTeams: async (ti) => (ti === 9 ? REAL : []),
  };
  return eng;
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

let distDir = '';
beforeAll(() => {
  distDir = tmp('dist');
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>APP</body></html>');
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'assets', 'app-123.js'), `console.log(${JSON.stringify('x'.repeat(4000))});`);
  writeFileSync(join(distDir, 'assets', 'style.css'), 'body{color:red}');
});

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const running: RunningServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(running.splice(0).map((s) => s.close()));
});

async function boot(opts: {
  dataDir?: string | null; engine?: MpEngine; stateIntervalMs?: number; hostGraceMs?: number; maxRooms?: number;
  finishedRoomTtlMs?: number; idleRoomTtlMs?: number;
} = {}): Promise<RunningServer> {
  const s = await startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: opts.dataDir ?? null,
    distDir,
    engine: opts.engine ?? makeFakeEngine(),
    log: () => undefined,
    heartbeatMs: 0,
    persistDebounceMs: 20,
    stateIntervalMs: opts.stateIntervalMs,
    hostGraceMs: opts.hostGraceMs,
    maxRooms: opts.maxRooms,
    finishedRoomTtlMs: opts.finishedRoomTtlMs,
    idleRoomTtlMs: opts.idleRoomTtlMs,
  });
  running.push(s);
  return s;
}

let sessSeq = 0;
/** 只等待 error（不被其他玩家触发的广播误命中） */
const NEVER = () => false;
async function client(server: RunningServer, name: string, sessionId = `sess-${++sessSeq}-${Math.random().toString(36).slice(2, 8)}`): Promise<TestClient> {
  const c = new TestClient(server.wsUrl, { sessionId, name });
  clients.push(c);
  await c.hello();
  return c;
}

function get(server: RunningServer, path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers as Record<string, unknown>,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 建房 + 加入 + existing 模式选队 + 全员准备 + 开始 */
async function startGame(server: RunningServer, names: string[], teams = ['og', 'lgd', 'secret']): Promise<TestClient[]> {
  const cs: TestClient[] = [];
  for (const n of names) cs.push(await client(server, n));
  const [host, ...rest] = cs;
  const created = await host.request({ t: 'createRoom', name: '测试房', maxPlayers: 4 }, 'room', (m) => !!m.room);
  if (created.t !== 'room' || !created.room) throw new Error('建房失败');
  const roomId = created.room.id;
  for (const c of rest) {
    const r = await c.request({ t: 'joinRoom', roomId }, 'room', (m) => !!m.room);
    if (r.t !== 'room') throw new Error(`加入失败：${r.message}`);
  }
  await host.request({ t: 'updateSettings', settings: { mode: 'existing', startTi: 9, endTi: 10 } }, 'room', (m) => m.room?.settings.mode === 'existing');
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const r1 = await c.request({ t: 'updateSeat', teamId: teams[i] }, 'room', (m) => mySeat(m.room)?.teamId === teams[i]);
    if (r1.t !== 'room') throw new Error(r1.message);
    const r2 = await c.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!mySeat(m.room)?.lobbyReady);
    if (r2.t !== 'room') throw new Error(r2.message);
  }
  const states = cs.map((c) => c.waitFor('state'));
  host.send({ t: 'startGame' });
  await Promise.all(states);
  await Promise.all(cs.map((c) => until(() => !!c.roundStatus, 5000, 'roundStatus')));
  return cs;
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
describe('server · 校验与工具', () => {
  it('parseClientMsg 校验形状、白名单与长度', () => {
    expect(parseClientMsg('not json').ok).toBe(false);
    expect(parseClientMsg('[]').ok).toBe(false);
    expect(parseClientMsg('{"t":"nope"}').ok).toBe(false);
    expect(parseClientMsg('{"t":"hello","sessionId":"x","name":"a","protocol":1}').ok).toBe(false);
    expect(parseClientMsg('{"t":"call","reqId":1,"fn":"advance","args":[]}').ok).toBe(false);
    expect(parseClientMsg('{"t":"call","reqId":1,"fn":"constructor","args":[]}').ok).toBe(false);
    expect(parseClientMsg('{"t":"call","reqId":1,"fn":"doTraining","args":{}}').ok).toBe(false);
    const ok = parseClientMsg('{"t":"call","reqId":1,"fn":"doTraining"}');
    expect(ok.ok && ok.msg.t === 'call' && ok.msg.args.length === 0).toBe(true);
    const room = parseClientMsg('{"t":"createRoom","name":"  我的\\n房间  ","maxPlayers":99}');
    expect(room.ok && room.msg.t === 'createRoom' && room.msg.maxPlayers === 6 && room.msg.name === '我的 房间').toBe(true);
    expect(parseClientMsg('{"t":"joinRoom","roomId":"abc"}').ok).toBe(false);
    const join = parseClientMsg('{"t":"joinRoom","roomId":" ab12cd "}');
    expect(join.ok && join.msg.t === 'joinRoom' && join.msg.roomId === 'AB12CD').toBe(true);
    expect(parseClientMsg('{"t":"updateSeat","newClub":{"name":"A","tag":"x","region":"CN","color":"#fff"}}').ok).toBe(false);
    const seat = parseClientMsg('{"t":"updateSeat","newClub":{"name":"星火","tag":"spk","region":"CN","color":"#C23C2A"}}');
    expect(seat.ok && seat.msg.t === 'updateSeat' && seat.msg.newClub?.tag === 'SPK' && seat.msg.newClub.color === '#c23c2a').toBe(true);
    expect(parseClientMsg('{"t":"updateSettings","settings":{"difficulty":"insane"}}').ok).toBe(false);
    expect(parseClientMsg('{"t":"chat","text":"   "}').ok).toBe(false);
    expect(cleanText('a\u0000b‮c  d', 10)).toBe('abc d');
  });

  it('resolveSafePath 拒绝路径穿越', () => {
    expect(resolveSafePath('/srv/dist', '/assets/a.js')).toBe('/srv/dist/assets/a.js');
    expect(resolveSafePath('/srv/dist', '/../etc/passwd')).toBeNull();
    expect(resolveSafePath('/srv/dist', '/%2e%2e/etc/passwd')).toBeNull();
    expect(resolveSafePath('/srv/dist', '/a/%00')).toBeNull();
    expect(resolveSafePath('/srv/dist', '/..%5c..%5cwin.ini')).toBeNull();
    expect(resolveSafePath('/srv/dist', '/%E0%A4%A')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
describe('server · 静态托管', () => {
  it('托管 dist，SPA 回退，正确的 MIME，gzip，路径穿越 404', async () => {
    const s = await boot();
    const index = await get(s, '/');
    expect(index.status).toBe(200);
    expect(index.type).toContain('text/html');
    expect(index.body).toContain('APP');
    const spa = await get(s, '/lobby/ABCDEF', { accept: 'text/html' });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('APP');
    const js = await get(s, '/assets/app-123.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('text/javascript');
    expect(String(js.headers['cache-control'])).toContain('immutable');
    const gz = await get(s, '/assets/app-123.js', { 'accept-encoding': 'gzip' });
    expect(gz.headers['content-encoding']).toBe('gzip');
    const css = await get(s, '/assets/style.css');
    expect(css.type).toContain('text/css');
    expect((await get(s, '/assets/missing.js')).status).toBe(404);
    expect((await get(s, '/%2e%2e/package.json')).status).toBe(404);
    const health = await get(s, '/healthz');
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, protocol: PROTOCOL_VERSION, wsPath: '/ws' });
  });
});

// ---------------------------------------------------------------------------
// 连接与大厅
// ---------------------------------------------------------------------------
describe('server · 连接与大厅', () => {
  it('hello 之前的消息被拒绝；非法消息回复 error 且服务器继续工作', async () => {
    const s = await boot();
    const c = new TestClient(s.wsUrl, { sessionId: 'sess-raw-0001', name: '甲' });
    clients.push(c);
    await c.open();
    const e1 = c.waitFor('error');
    c.send({ t: 'listRooms' });
    expect((await e1).message).toContain('hello');
    const e2 = c.waitFor('error');
    c.sendRaw('{{{');
    expect((await e2).message).toContain('JSON');
    await c.hello();
    const e3 = c.waitFor('error');
    c.sendRaw(JSON.stringify({ t: 'kick', seatKey: 42 }));
    await e3;
    const list = await c.request({ t: 'listRooms' }, 'roomList');
    expect(list.t).toBe('roomList');
    // 非法的 call 也回复 callResult（客户端等待不会悬空）
    const cr = c.waitFor('callResult', (m) => m.reqId === 7);
    c.send({ t: 'call', reqId: 7, fn: 'advance', args: [] });
    expect((await cr).ok).toBe(false);
  });

  it('协议版本不一致 → error 并断开', async () => {
    const s = await boot();
    const c = new TestClient(s.wsUrl, { sessionId: 'sess-proto-01', name: '乙' });
    clients.push(c);
    await c.open();
    const e = c.waitFor('error');
    c.send({ t: 'hello', sessionId: c.sessionId, name: '乙', protocol: 999 });
    expect((await e).message).toContain('协议版本');
    await until(() => c.closed, 3000, '断开');
    expect(c.closeCode).toBe(4002);
  });

  it('建房、加入、房主权限、选队冲突、准备与开始条件、移出、房主移交', async () => {
    const s = await boot();
    const a = await client(s, '房主');
    const b = await client(s, '玩家B');
    const c = await client(s, '玩家C');
    const created = await a.request({ t: 'createRoom', name: '周末开黑', maxPlayers: 3 }, 'room', (m) => !!m.room);
    expect(created.t).toBe('room');
    const room = a.room!;
    expect(room.id).toMatch(/^[A-Z0-9]{6}$/);
    expect(room.hostSeatKey).toBe(room.yourSeatKey);
    expect(a.isHost).toBe(true);
    // 不在房间的连接收到房间列表推送
    await until(() => b.rooms.some((r) => r.id === room.id), 3000, '房间列表推送');
    expect(b.rooms.find((r) => r.id === room.id)).toMatchObject({ name: '周末开黑', hostName: '房主', players: 1, maxPlayers: 3, status: 'lobby' });

    expect((await b.request({ t: 'joinRoom', roomId: 'ZZZZZZ' }, 'room', NEVER)).t).toBe('error');
    expect((await b.request({ t: 'joinRoom', roomId: room.id.toLowerCase() }, 'room', (m) => !!m.room)).t).toBe('room');
    await until(() => a.room?.seats.length === 2, 3000, '房主看到新玩家');

    // 非房主不能改设置
    const notHost = await b.request({ t: 'updateSettings', settings: { difficulty: 'hard' } }, 'room', NEVER);
    expect(notHost.t === 'error' && notHost.message).toContain('房主');
    // 没有真实数据的 TI 不能用 existing
    const noData = await a.request({ t: 'updateSettings', settings: { mode: 'existing', startTi: 3 } }, 'room', NEVER);
    expect(noData.t).toBe('error');
    const set = await a.request({ t: 'updateSettings', settings: { mode: 'existing', startTi: 9, difficulty: 'hard' } }, 'room', (m) => m.room?.settings.mode === 'existing');
    expect(set.t).toBe('room');
    expect(a.room!.settings).toMatchObject({ mode: 'existing', startTi: 9, endTi: 16, difficulty: 'hard' });

    // 选队：不存在 / 冲突
    expect((await a.request({ t: 'updateSeat', teamId: 'nope' }, 'room', NEVER)).t).toBe('error');
    expect((await a.request({ t: 'updateSeat', teamId: 'og' }, 'room', (m) => !!m.room?.seats[0].teamId)).t).toBe('room');
    const clash = await b.request({ t: 'updateSeat', teamId: 'og' }, 'room', NEVER);
    expect(clash.t === 'error' && clash.message).toContain('已被');
    // existing 模式下准备前必须选队
    const notPicked = await b.request({ t: 'setLobbyReady', ready: true }, 'room', NEVER);
    expect(notPicked.t === 'error' && notPicked.message).toContain('选择');
    await b.request({ t: 'updateSeat', teamId: 'lgd' }, 'room', (m) => m.room?.seats[1].teamId === 'lgd');

    // 开始条件：未全员准备
    await a.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[0].lobbyReady);
    const early = a.waitFor('error', (m) => m.ref === 'startGame');
    a.send({ t: 'startGame' });
    // 被拒绝的开始请求带 ref（房间页据此复位「正在创建游戏…」按钮并显示原因）
    expect((await early).message).toContain('未准备');
    // 非房主的开始请求同样带 ref
    const bStart = b.waitFor('error', (m) => m.ref === 'startGame');
    b.send({ t: 'startGame' });
    expect((await bStart).message).toContain('房主');
    // 修改设置会取消全员准备
    await a.request({ t: 'updateSettings', settings: { difficulty: 'easy' } }, 'room', (m) => m.room?.settings.difficulty === 'easy');
    expect(a.room!.seats.every((x) => !x.lobbyReady)).toBe(true);

    // 第三人加入 → 满员 → 第四人被拒
    await c.request({ t: 'joinRoom', roomId: room.id }, 'room', (m) => !!m.room);
    const d = await client(s, '玩家D');
    const full = await d.request({ t: 'joinRoom', roomId: room.id }, 'room', NEVER);
    expect(full.t === 'error' && full.message).toContain('已满');

    // 非房主不能移出；房主按座位键移出 C，C 不能再加入
    const cKey = c.seat!.seatKey;
    expect((await b.request({ t: 'kick', seatKey: cKey }, 'room', NEVER)).t).toBe('error');
    const kicked = c.waitFor('room', (m) => m.room === null);
    a.send({ t: 'kick', seatKey: cKey });
    await kicked;
    expect(c.errors.some((m) => m.includes('移出'))).toBe(true);
    await until(() => a.room?.seats.length === 2, 3000, '移出后人数');
    expect((await c.request({ t: 'joinRoom', roomId: room.id }, 'room', NEVER)).t).toBe('error');

    // 房主离开 → 房主移交给 B
    const left = a.waitFor('room', (m) => m.room === null);
    a.send({ t: 'leaveRoom' });
    await left;
    await until(() => b.isHost, 3000, '房主移交');
    expect(b.room!.seats.map((x) => x.seatKey)).toEqual([b.room!.yourSeatKey]);
    // 最后一人离开 → 房间删除
    await b.request({ t: 'leaveRoom' }, 'room', (m) => m.room === null);
    await until(() => !s.rooms.roomIds().includes(room.id), 3000, '房间删除');
  });

  it('build 模式：俱乐部信息校验（与真实战队/其他玩家重名）', async () => {
    const s = await boot();
    const a = await client(s, '甲');
    const b = await client(s, '乙');
    await a.request({ t: 'createRoom', name: '', maxPlayers: 2 }, 'room', (m) => !!m.room);
    expect(a.room!.name).toBe('甲的房间');
    await b.request({ t: 'joinRoom', roomId: a.room!.id }, 'room', (m) => !!m.room);
    await a.request({ t: 'updateSettings', settings: { mode: 'build', startTi: 9 } }, 'room', (m) => m.room?.settings.startTi === 9);
    expect((await a.request({ t: 'setLobbyReady', ready: true }, 'room', NEVER)).t).toBe('error');
    const realClash = await a.request({ t: 'updateSeat', newClub: { name: 'og', tag: 'XX', region: 'CN', color: '#112233' } }, 'room', NEVER);
    expect(realClash.t === 'error' && realClash.message).toContain('重名');
    const ok = await a.request({ t: 'updateSeat', newClub: { name: '星火电竞', tag: 'SPK', region: 'CN', color: '#112233' } }, 'room', (m) => !!m.room?.seats[0].newClub);
    expect(ok.t).toBe('room');
    const dup = await b.request({ t: 'updateSeat', newClub: { name: '另一个', tag: 'SPK', region: 'EU', color: '#445566' } }, 'room', NEVER);
    expect(dup.t === 'error' && dup.message).toContain('简称');
    await b.request({ t: 'updateSeat', newClub: { name: '另一个', tag: 'ANO', region: 'EU', color: '#445566' } }, 'room', (m) => !!m.room?.seats[1].newClub);
    await a.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[0].lobbyReady);
    await b.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[1].lobbyReady);
    const st = a.waitFor('state');
    a.send({ t: 'startGame' });
    await st;
    expect(a.room!.status).toBe('playing');
    expect(a.room!.seats.map((x) => x.gameTeamId)).toEqual(['club-1', 'club-2']);
    // 开局后不能再改座位 / 加入
    expect((await a.request({ t: 'updateSeat', name: '新名字' }, 'room', NEVER)).t).toBe('error');
    const late = await client(s, '迟到');
    const lateJoin = await late.request({ t: 'joinRoom', roomId: a.room!.id }, 'room', NEVER);
    expect(lateJoin.t === 'error' && lateJoin.message).toContain('已经开始');
  });
});

// ---------------------------------------------------------------------------
// 游戏
// ---------------------------------------------------------------------------
describe('server · 游戏同步', () => {
  it('座位视图、抢签（先到者成功）、快讯只发给其他玩家、私有新闻不外泄、异常不崩溃', async () => {
    const s = await boot();
    const [a, b, c] = await startGame(s, ['阿明', '小红', '老王']);
    expect(a.teamId).toBe('og');
    expect(b.teamId).toBe('lgd');
    expect(c.teamId).toBe('secret');
    for (const x of [a, b, c]) {
      const view = x.state as unknown as FakeState;
      expect(view.secret).toBe(`secret-of-${x.teamId}`);
      expect(JSON.stringify(view)).not.toMatch(new RegExp(`secret-of-(?!${x.teamId})`));
    }
    expect(a.roundStatus).toMatchObject({ season: 9, round: 0, names: { og: '阿明', lgd: '小红', secret: '老王' } });

    // 抢签：B、C 几乎同时签同一人 → 先到服务器者成功，后到者得到明确的失败提示
    const pb = b.callAsync('signFreeAgent', 'ame');
    const pc = c.callAsync('signFreeAgent', 'ame');
    const [rb, rc] = await Promise.all([pb, pc]);
    expect([rb.ok, rc.ok].filter(Boolean)).toHaveLength(1);
    const [winner, loser, loserReply] = rb.ok ? [b, c, rc] : [c, b, rb];
    const winnerTeam = winner === b ? 'PSG.LGD' : 'Team Secret';
    expect(loserReply.message).toBe(`Ame 已被玩家「${winner.name}」的 ${winnerTeam} 签下`);
    // 调用者返回时视图已更新
    expect((winner.state as unknown as FakeState).players.ame.teamId).toBe(winner.teamId);
    // 快讯：其他玩家收到（只含公开新闻，带操作者），操作者自己不收
    await until(() => a.feeds.length > 0 && loser.feeds.length > 0, 3000, '快讯');
    expect(a.feeds).toHaveLength(3);
    expect(a.feeds[0]).toMatchObject({ title: `【官宣】Ame 加盟 ${winnerTeam}`, actorTeamId: winner.teamId, actorName: winner.name, important: true });
    // 同一次操作连带的世界新闻不记在操作者名下
    expect(a.feeds[1]).toMatchObject({ title: '世界新闻：Ame 转会尘埃落定' });
    expect(a.feeds[1].actorTeamId).toBeUndefined();
    expect(a.feeds[1].actorName).toBeUndefined();
    // 主角是 A 的连带新闻记在 A 名下（A 的客户端据此识别为自己的消息）
    expect(a.feeds[2]).toMatchObject({ title: 'OG 赛事战罢', actorTeamId: 'og', actorName: '阿明' });
    expect(winner.feeds).toHaveLength(0);
    // 其他玩家的视图里没有操作者的私有新闻
    await until(() => (a.state as unknown as FakeState).players.ame.teamId === winner.teamId, 3000, 'A 视图同步');
    expect((a.state as unknown as FakeState).news.some((n) => n.title.includes('签字费'))).toBe(false);
    expect((loser.state as unknown as FakeState).news.some((n) => n.title.includes('签字费'))).toBe(false);
    expect((winner.state as unknown as FakeState).news.some((n) => n.title.includes('签字费'))).toBe(true);

    // 引擎异常 → callResult 失败，服务器继续工作
    const boom = await a.call('doTraining');
    expect(boom.ok).toBe(false);
    expect(boom.message).toContain('引擎炸了');
    // 带 teamId 参数的 RPC 强制为调用者战队
    const forced = await a.call('setLineupSlot', 'lgd', 'C', 'ame');
    expect((forced.result as { teamArg: string }).teamArg).toBe('og');
    // 非白名单
    const bad = await a.call('advance');
    expect(bad.ok).toBe(false);
    // 无返回值的 RPC：ok=true
    expect((await a.call('markNewsRead', 'n-1')).ok).toBe(true);
  });

  it('其他玩家的视图推送被节流（≤ 4 次/秒），调用者本人立即收到', async () => {
    const s = await boot();
    const [a, b] = await startGame(s, ['甲', '乙']);
    const b0 = b.stateCount;
    const a0 = a.stateCount;
    const t0 = Date.now();
    const replies: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) replies.push(a.callAsync('hireCoach', `c${i}`));
    await Promise.all(replies);
    // 调用者：每次调用都有新视图
    expect(a.stateCount - a0).toBe(30);
    await new Promise((r) => setTimeout(r, 400));
    const elapsed = (Date.now() - t0) / 1000;
    const bCount = b.stateCount - b0;
    expect(bCount).toBeGreaterThanOrEqual(1);
    expect(bCount).toBeLessThanOrEqual(Math.ceil(elapsed * 4) + 1);
    // 最终一致：B 拿到最新版本
    expect(b.version).toBe(a.version);
  });

  it('回合准备：阻塞时不能准备；全员准备后推进并广播 state + feed + roundStatus；游戏结束', async () => {
    const eng = makeFakeEngine();
    const s = await boot({ engine: eng });
    const [a, b] = await startGame(s, ['甲', '乙']);
    const st = s.rooms.getRoomState(a.room!.id) as unknown as FakeState;
    st.blocked = { lgd: true };
    const r1 = await a.request({ t: 'setRoundReady', ready: true }, 'roundStatus', (m) => m.status.ready.og === true);
    expect(r1.t).toBe('roundStatus');
    await until(() => b.roundStatus?.ready.og === true, 3000, 'B 看到 A 已准备');
    const blocked = await b.request({ t: 'setRoundReady', ready: true }, 'roundStatus', NEVER);
    expect(blocked.t === 'error' && blocked.message).toContain('待处理');
    expect((await b.call('resolveDecision', 'd1', 'x')).ok).toBe(true);
    const aState = a.waitFor('state', (m) => m.state.roundIndex === 1);
    const bFeed = b.waitFor('feed', (m) => m.items.some((i) => i.title.startsWith('世界新闻 1-')));
    b.send({ t: 'setRoundReady', ready: true });
    await aState;
    const feed = await bFeed;
    // 快讯上限 30，按时间顺序，私有新闻不在其中
    expect(feed.items.length).toBe(30);
    expect(feed.items.some((i) => i.title.includes('财务'))).toBe(false);
    expect(feed.items.some((i) => i.important)).toBe(true);
    await until(() => a.roundStatus?.round === 1 && b.roundStatus?.round === 1, 3000, '回合状态');
    expect(a.roundStatus!.ready).toEqual({ og: false, lgd: false });
    // 推进到结束
    for (let round = 2; round <= 3; round++) {
      const w = a.waitFor('state', (m) => m.state.roundIndex === round);
      a.send({ t: 'setRoundReady', ready: true });
      await until(() => a.roundStatus?.ready.og === true, 3000, 'A 准备');
      b.send({ t: 'setRoundReady', ready: true });
      await w;
    }
    await until(() => a.room?.status === 'finished', 3000, '游戏结束');
    const over = await a.request({ t: 'setRoundReady', ready: true }, 'roundStatus', NEVER);
    expect(over.t === 'error' && over.message).toContain('结束');
  });

  it('托管离线玩家：仅房主、仅离线玩家；服务器代为处理并准备，在线玩家准备即推进；新回合继续托管；重连自动解除', async () => {
    const eng = makeFakeEngine();
    const s = await boot({ engine: eng });
    const [a, b] = await startGame(s, ['甲', '乙']);
    const st = s.rooms.getRoomState(a.room!.id) as unknown as FakeState;
    st.blocked = { lgd: true };
    const online = await a.request({ t: 'setAutopilot', teamId: 'lgd', on: true }, 'roundStatus', NEVER);
    expect(online.t === 'error' && online.message).toContain('在线');
    const notHost = await b.request({ t: 'setAutopilot', teamId: 'og', on: true }, 'roundStatus', NEVER);
    expect(notHost.t === 'error' && notHost.message).toContain('房主');
    expect(eng.calls).not.toContain('lgd:autopilot');

    await b.close();
    await until(() => a.roundStatus?.connected.lgd === false, 3000, '离线');
    const notice = a.waitFor('feed', (m) => m.items.some((i) => i.title.includes('托管了离线玩家')));
    a.send({ t: 'setAutopilot', teamId: 'lgd', on: true });
    await notice;
    await until(() => a.roundStatus?.autopilot?.lgd === true && a.roundStatus?.ready.lgd === true, 3000, '托管并准备');
    expect(st.blocked.lgd).toBe(false);
    expect(s.rooms.snapshot(a.room!.id)?.autopilot).toEqual(['lgd']);
    // 在线玩家准备 → 推进；新回合托管座位自动再次准备
    const adv = a.waitFor('state', (m) => m.state.roundIndex === 1);
    a.send({ t: 'setRoundReady', ready: true });
    await adv;
    await until(() => a.roundStatus?.round === 1 && a.roundStatus?.ready.lgd === true, 3000, '新回合自动准备');
    expect(a.roundStatus?.ready.og).toBe(false);
    // 玩家重连：解除托管并通知其他玩家
    const back = a.waitFor('feed', (m) => m.items.some((i) => i.title.includes('解除托管')));
    const b2 = new TestClient(s.wsUrl, { sessionId: b.sessionId, name: '乙' });
    clients.push(b2);
    await b2.hello();
    await back;
    await until(() => a.roundStatus?.connected.lgd === true && !a.roundStatus?.autopilot?.lgd, 3000, '重连解除托管');
  });

  it('断线重连回到原座位；同一会话的新连接顶替旧连接；主动离开后可重新加入', async () => {
    const s = await boot();
    const [a, b] = await startGame(s, ['甲', '乙']);
    const roomId = a.room!.id;
    await b.close();
    await until(() => a.roundStatus?.connected.lgd === false, 3000, '离线状态');
    expect(a.room!.seats.find((x) => x.gameTeamId === 'lgd')!.connected).toBe(false);

    const b2 = new TestClient(s.wsUrl, { sessionId: b.sessionId, name: '乙' });
    clients.push(b2);
    const st = b2.waitFor('state');
    await b2.hello();
    await st;
    expect(b2.room?.id).toBe(roomId);
    expect(b2.teamId).toBe('lgd');
    await until(() => !!b2.roundStatus && a.roundStatus?.connected.lgd === true, 3000, '重连');

    // 顶替
    const b3 = new TestClient(s.wsUrl, { sessionId: b.sessionId, name: '乙' });
    clients.push(b3);
    await b3.hello();
    await until(() => b2.closed, 3000, '旧连接断开');
    expect(b2.errors.some((m) => m.includes('其他页面'))).toBe(true);
    await until(() => b3.teamId === 'lgd', 3000, '新连接视图');
    expect(a.roundStatus?.connected.lgd).toBe(true);

    // 主动离开进行中的对局：保留座位；重连不会自动回到房间，但可以 joinRoom 回来
    await b3.request({ t: 'leaveRoom' }, 'room', (m) => m.room === null);
    await until(() => a.roundStatus?.connected.lgd === false, 3000, '离开后离线');
    await b3.close();
    const b4 = new TestClient(s.wsUrl, { sessionId: b.sessionId, name: '乙' });
    clients.push(b4);
    await b4.hello();
    await until(() => b4.rooms.length > 0, 3000, '房间列表');
    expect(b4.room).toBeNull();
    const back = b4.waitFor('state');
    b4.send({ t: 'joinRoom', roomId });
    await back;
    expect(b4.teamId).toBe('lgd');
  });

  it('聊天广播给房间内所有人', async () => {
    const s = await boot();
    const [a, b] = await startGame(s, ['甲', '乙']);
    const got = b.waitFor('chat');
    a.send({ t: 'chat', text: '  你好\n世界  ' });
    const m = await got;
    expect(m).toMatchObject({ from: '甲', text: '你好 世界' });
  });
});

// ---------------------------------------------------------------------------
// 审查回归：会话 ID 不外泄、房主离线移交、限流/繁忙的 call 有回复、已结束房间腾位
// ---------------------------------------------------------------------------
describe('server · 健壮性', () => {
  it('房间信息不包含任何会话 ID（防止冒充顶替座位）；座位键识别自己与房主，房主按座位键移出玩家', async () => {
    const s = await boot();
    const a = await client(s, '房主');
    const b = await client(s, '乙');
    const c = await client(s, '丙');
    await a.request({ t: 'createRoom', name: '座位键', maxPlayers: 3 }, 'room', (m) => !!m.room);
    const roomId = a.room!.id;
    await b.request({ t: 'joinRoom', roomId }, 'room', (m) => !!m.room);
    await c.request({ t: 'joinRoom', roomId }, 'room', (m) => !!m.room);
    await until(() => a.room?.seats.length === 3 && b.room?.seats.length === 3, 3000, '三人入座');
    const all = [a, b, c];
    for (const me of all) {
      const json = JSON.stringify(me.log.filter((m) => m.t === 'room' || m.t === 'roomList'));
      for (const o of all) expect(json).not.toContain(o.sessionId);
      expect(json).not.toContain('sessionId');
      // 自己的座位由 yourSeatKey 指出（客户端据此找到自己的座位 / 判断是否房主）
      expect(me.seat?.name).toBe(me.name);
    }
    // 座位键在房间内唯一，所有人看到的一致；房主座位键指向房主
    const keys = a.room!.seats.map((x) => x.seatKey);
    expect(new Set(keys).size).toBe(3);
    expect(b.room!.seats.map((x) => x.seatKey)).toEqual(keys);
    expect(a.isHost).toBe(true);
    expect(b.isHost).toBe(false);
    expect(b.room!.hostSeatKey).toBe(a.seat!.seatKey);
    // 座位键不是会话凭证：拿它当会话 ID 连接只会得到一个没有座位的新身份，房主不受影响
    const fake = new TestClient(s.wsUrl, { sessionId: b.room!.hostSeatKey, name: '冒充者' });
    clients.push(fake);
    await fake.hello();
    await until(() => fake.rooms.some((r) => r.id === roomId), 3000, '冒充者的房间列表');
    expect(fake.room).toBeNull();
    expect(fake.rooms.find((r) => r.id === roomId)?.mine).toBeUndefined();
    expect(a.closed).toBe(false);
    expect(s.rooms.getRoomInfo(roomId)!.hostSessionId).toBe(a.sessionId);
    // 房主按座位键移出丙
    const kicked = c.waitFor('room', (m) => m.room === null);
    a.send({ t: 'kick', seatKey: c.seat!.seatKey });
    await kicked;
    await until(() => a.room?.seats.length === 2, 3000, '移出');
    // 移出后丙不能再加入
    expect((await c.request({ t: 'joinRoom', roomId }, 'room', NEVER)).t).toBe('error');
    // 不能移出自己；不存在的座位键
    const self = await a.request({ t: 'kick', seatKey: a.room!.hostSeatKey }, 'room', NEVER);
    expect(self.t === 'error' && self.message).toContain('自己');
    const ghost = await a.request({ t: 'kick', seatKey: 'nobody-here' }, 'room', NEVER);
    expect(ghost.t === 'error' && ghost.message).toContain('不在房间');
  });

  it('房主离线超过宽限期 → 房主移交给在线玩家，新房主可以托管原房主（回合不会因房主掉线永远卡住）', async () => {
    const eng = makeFakeEngine();
    const s = await boot({ engine: eng, hostGraceMs: 60 });
    const [a, b] = await startGame(s, ['甲', '乙']);
    const roomId = a.room!.id;
    const st = s.rooms.getRoomState(roomId) as unknown as FakeState;
    st.blocked = { og: true };
    // 宽限期内重连：仍是房主
    await a.close();
    const a2 = new TestClient(s.wsUrl, { sessionId: a.sessionId, name: '甲' });
    clients.push(a2);
    await a2.hello();
    await new Promise((r) => setTimeout(r, 150));
    expect(s.rooms.getRoomInfo(roomId)!.hostSessionId).toBe(a.sessionId);
    // 真正掉线：宽限期后移交给乙，乙收到快讯
    const notice = b.waitFor('feed', (m) => m.items.some((i) => i.title.includes('新房主')));
    await a2.close();
    await notice;
    await until(() => b.isHost, 3000, '房主移交');
    expect(s.rooms.getRoomInfo(roomId)!.hostSessionId).toBe(b.sessionId);
    // 新房主托管原房主的座位 → 服务器代为处理并准备；乙准备即推进
    await until(() => b.roundStatus?.connected.og === false, 3000, '离线');
    b.send({ t: 'setAutopilot', teamId: 'og', on: true });
    await until(() => b.roundStatus?.autopilot?.og === true && b.roundStatus?.ready.og === true, 3000, '托管并准备');
    const adv = b.waitFor('state', (m) => m.state.roundIndex === 1);
    b.send({ t: 'setRoundReady', ready: true });
    await adv;
    // 原房主回来：解除托管，不再是房主
    const a3 = new TestClient(s.wsUrl, { sessionId: a.sessionId, name: '甲' });
    clients.push(a3);
    const back = a3.waitFor('state');
    await a3.hello();
    await back;
    await until(() => !!a3.room && !a3.isHost && a3.room.hostSeatKey === b.seat?.seatKey, 3000, '原房主看到新房主');
    await until(() => b.roundStatus?.connected.og === true && !b.roundStatus?.autopilot?.og, 3000, '解除托管');
  });

  it('房主主动离开进行中的对局 → 立即移交房主', async () => {
    const s = await boot({ hostGraceMs: 60_000 });
    const [a, b] = await startGame(s, ['甲', '乙']);
    await a.request({ t: 'leaveRoom' }, 'room', (m) => m.room === null);
    await until(() => b.isHost, 3000, '房主移交');
  });

  it('被限流的 call 也会收到 callResult（客户端不会等到超时）', async () => {
    const s = await boot();
    const [a] = await startGame(s, ['甲', '乙']);
    const replies = await Promise.all(Array.from({ length: 160 }, (_, i) => a.callAsync('hireCoach', `c${i}`)));
    expect(replies).toHaveLength(160);
    expect(replies.some((r) => !r.ok && r.message.includes('频繁'))).toBe(true);
    expect(replies.some((r) => r.ok)).toBe(true);
  });

  it('开始游戏时出现意外异常（如读取阵容出错）也回复带 ref 的错误，之后可以重新开始', async () => {
    const eng = makeFakeEngine();
    const realTeams = eng.realTeams;
    let broken = false;
    eng.realTeams = async (ti) => {
      if (broken) throw new Error('阵容数据读取失败');
      return realTeams(ti);
    };
    const s = await boot({ engine: eng });
    const a = await client(s, '甲');
    const b = await client(s, '乙');
    await a.request({ t: 'createRoom', name: '异常', maxPlayers: 2 }, 'room', (m) => !!m.room);
    await b.request({ t: 'joinRoom', roomId: a.room!.id }, 'room', (m) => !!m.room);
    await a.request({ t: 'updateSettings', settings: { mode: 'existing', startTi: 9 } }, 'room', (m) => m.room?.settings.mode === 'existing');
    for (const [c, team] of [[a, 'og'], [b, 'lgd']] as const) {
      await c.request({ t: 'updateSeat', teamId: team }, 'room', (m) => mySeat(m.room)?.teamId === team);
      await c.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!mySeat(m.room)?.lobbyReady);
    }
    broken = true;
    const rejected = a.waitFor('error', (m) => m.ref === 'startGame');
    a.send({ t: 'startGame' });
    expect((await rejected).message).toContain('阵容数据读取失败');
    broken = false;
    const started = a.waitFor('state');
    a.send({ t: 'startGame' });
    await started;
    expect(a.room?.status).toBe('playing');
  });

  it('已结束的对局不自动重连；房间数达到上限时清理无人在线的已结束对局，腾出位置建新房', async () => {
    const s = await boot({ maxRooms: 1 });
    const [a, b] = await startGame(s, ['甲', '乙']);
    const oldId = a.room!.id;
    for (let round = 1; round <= 3; round++) {
      const w = a.waitFor('state', (m) => m.state.roundIndex === round);
      a.send({ t: 'setRoundReady', ready: true });
      await until(() => a.roundStatus?.ready.og === true, 3000, 'A 准备');
      b.send({ t: 'setRoundReady', ready: true });
      await w;
    }
    await until(() => a.room?.status === 'finished', 3000, '游戏结束');
    // 已结束的对局：重新连接不会被自动拉回结束页（否则无法回到大厅建新房），但可以用房间码回去看结算
    await a.close();
    const a2 = new TestClient(s.wsUrl, { sessionId: a.sessionId, name: '甲' });
    clients.push(a2);
    await a2.hello();
    await until(() => a2.rooms.some((r) => r.id === oldId && r.status === 'finished'), 3000, '房间列表');
    expect(a2.room).toBeNull();
    const review = a2.waitFor('state');
    a2.send({ t: 'joinRoom', roomId: oldId });
    expect((await review).state.gameOver).toBeTruthy();
    await a2.close();
    const c = await client(s, '丙');
    // 还有人在线：不能清理
    const full = await c.request({ t: 'createRoom', name: '新房', maxPlayers: 2 }, 'room', NEVER);
    expect(full.t === 'error' && full.message).toContain('上限');
    await b.close();
    await until(() => s.rooms.getRoomInfo(oldId)!.seats.every((x) => !x.connected), 3000, '全员离线');
    const ok = await c.request({ t: 'createRoom', name: '新房', maxPlayers: 2 }, 'room', (m) => !!m.room);
    expect(ok.t).toBe('room');
    expect(s.rooms.roomIds()).toEqual([c.room!.id]);
  });
  it('房间数达到上限时也会清理无人在线的大厅房间', async () => {
    const s = await boot({ maxRooms: 1 });
    const a = await client(s, '甲');
    await a.request({ t: 'createRoom', name: '空房', maxPlayers: 2 }, 'room', (m) => !!m.room);
    const oldId = a.room!.id;
    // 有人在线：不能清理
    const b = await client(s, '乙');
    const full = await b.request({ t: 'createRoom', name: '新房', maxPlayers: 2 }, 'room', NEVER);
    expect(full.t === 'error' && full.message).toContain('上限');
    await a.close();
    await until(() => s.rooms.getRoomInfo(oldId)!.seats.every((x) => !x.connected), 3000, '离线');
    const ok = await b.request({ t: 'createRoom', name: '新房', maxPlayers: 2 }, 'room', (m) => !!m.room);
    expect(ok.t).toBe('room');
    expect(s.rooms.roomIds()).toEqual([b.room!.id]);
  });

  it('定期清理：已结束的对局过保留期、进行中的对局长时间无人在线 → 删除房间与存档；有人在线不删；已结束的对局只列给原座位玩家', async () => {
    const dataDir = tmp('sweep');
    const s = await boot({ dataDir, finishedRoomTtlMs: 60_000, idleRoomTtlMs: 3_600_000 });
    const [a, b] = await startGame(s, ['甲', '乙']);
    const finishedId = a.room!.id;
    for (let round = 1; round <= 3; round++) {
      const w = a.waitFor('state', (m) => m.state.roundIndex === round);
      a.send({ t: 'setRoundReady', ready: true });
      await until(() => a.roundStatus?.ready.og === true, 3000, 'A 准备');
      b.send({ t: 'setRoundReady', ready: true });
      await w;
    }
    await until(() => a.room?.status === 'finished', 3000, '游戏结束');
    // 路人看不到别人已结束的对局；原座位玩家离开后在列表里看到（mine，可回去查看结算）
    const d = await client(s, '路人');
    expect(d.rooms.some((r) => r.id === finishedId)).toBe(false);
    await a.request({ t: 'leaveRoom' }, 'room', (m) => m.room === null);
    await until(() => a.rooms.some((r) => r.id === finishedId && r.mine === true && r.status === 'finished'), 3000, '房间列表');
    // 另一局进行中的对局：路人能看到但不是自己的
    const [c, e] = await startGame(s, ['丙', '丁']);
    const playingId = c.room!.id;
    await until(() => d.rooms.some((r) => r.id === playingId && r.status === 'playing' && !r.mine), 3000, '路人的房间列表');
    await s.store!.flush();
    const file = (id: string) => join(dataDir, 'rooms', `${id}.json`);
    expect(existsSync(file(finishedId)) && existsSync(file(playingId))).toBe(true);
    // 有人在线：再久也不删
    expect(s.rooms.sweep(Date.now() + 10 * 3_600_000)).toBe(0);
    await Promise.all([b.close(), c.close(), e.close()]);
    const offline = (id: string) => s.rooms.getRoomInfo(id)!.seats.every((x) => !x.connected);
    await until(() => offline(finishedId) && offline(playingId), 3000, '全员离线');
    // 保留期内不删；已结束的对局过了保留期先删（进行中的对局还没到）
    expect(s.rooms.sweep()).toBe(0);
    expect(s.rooms.sweep(Date.now() + 120_000)).toBe(1);
    expect(s.rooms.roomIds()).toEqual([playingId]);
    await s.store!.flush();
    expect(existsSync(file(finishedId))).toBe(false);
    await until(() => !a.rooms.some((r) => r.id === finishedId), 3000, '列表移除已删除的房间');
    // 进行中的对局连续无人在线超过 idleRoomTtlMs
    expect(s.rooms.sweep(Date.now() + 2 * 3_600_000)).toBe(1);
    expect(s.rooms.roomIds()).toEqual([]);
    await s.store!.flush();
    expect(existsSync(file(playingId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
describe('server · 持久化', () => {
  it('房间与对局写入 server-data/rooms，重启后房主与玩家可继续', async () => {
    const dataDir = tmp('data');
    const eng = makeFakeEngine();
    const s1 = await boot({ dataDir, engine: eng });
    const [a, b] = await startGame(s1, ['甲', '乙']);
    const roomId = a.room!.id;
    await b.call('signFreeAgent', 'sccc');
    await s1.close();
    running.splice(running.indexOf(s1), 1);
    await until(() => a.closed && b.closed, 3000, '断开');
    const files = readdirSync(join(dataDir, 'rooms'));
    expect(files).toContain(`${roomId}.json`);

    const s2 = await boot({ dataDir, engine: eng });
    expect(s2.rooms.roomIds()).toContain(roomId);
    const info = s2.rooms.getRoomInfo(roomId)!;
    expect(info.status).toBe('playing');
    expect(info.seats.every((x) => !x.connected)).toBe(true);
    const a2 = new TestClient(s2.wsUrl, { sessionId: a.sessionId, name: '甲' });
    clients.push(a2);
    const st = a2.waitFor('state');
    await a2.hello();
    await st;
    expect(a2.teamId).toBe('og');
    expect((a2.state as unknown as FakeState).players.sccc.teamId).toBe('lgd');
    expect(a2.version).toBeGreaterThanOrEqual(2);
    // flushSync 写出
    expect(s2.flushSync()).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dataDir, 'rooms', `${roomId}.json`))).toBe(true);
  });

  it('重启载入进行中的房间时调用引擎的存档迁移（如真实生涯位置），迁移结果随状态下发', async () => {
    const dataDir = tmp('migrate');
    const eng = makeFakeEngine();
    const s1 = await boot({ dataDir, engine: eng });
    const [a] = await startGame(s1, ['甲', '乙']);
    const roomId = a.room!.id;
    await s1.close();
    running.splice(running.indexOf(s1), 1);
    await until(() => a.closed, 3000, '断开');

    const migrated: string[] = [];
    const eng2: MpEngine = {
      ...eng,
      migrate(state) {
        const s = state as unknown as FakeState & { roleDataVersion?: number };
        if (s.roleDataVersion) return false;
        s.roleDataVersion = 1;
        migrated.push(roomId);
        return true;
      },
    };
    const s2 = await boot({ dataDir, engine: eng2 });
    expect(migrated).toEqual([roomId]);
    const a2 = new TestClient(s2.wsUrl, { sessionId: a.sessionId, name: '甲' });
    clients.push(a2);
    const st = a2.waitFor('state');
    await a2.hello();
    await st;
    expect((a2.state as unknown as { roleDataVersion?: number }).roleDataVersion).toBe(1);
  });

  it('被移出的玩家与座位键随房间存档；重启后仍不能加入，座位键不变', async () => {
    const dataDir = tmp('kicked');
    const s1 = await boot({ dataDir });
    const a = await client(s1, '甲');
    const b = await client(s1, '乙');
    const c = await client(s1, '丙');
    await a.request({ t: 'createRoom', name: '存档', maxPlayers: 3 }, 'room', (m) => !!m.room);
    const roomId = a.room!.id;
    await b.request({ t: 'joinRoom', roomId }, 'room', (m) => !!m.room);
    await c.request({ t: 'joinRoom', roomId }, 'room', (m) => !!m.room);
    await until(() => a.room?.seats.length === 3, 3000, '三人入座');
    const kicked = c.waitFor('room', (m) => m.room === null);
    a.send({ t: 'kick', seatKey: c.seat!.seatKey });
    await kicked;
    await until(() => a.room?.seats.length === 2, 3000, '移出');
    const keys = a.room!.seats.map((x) => x.seatKey);
    await s1.close();
    running.splice(running.indexOf(s1), 1);
    const saved = JSON.parse(readFileSync(join(dataDir, 'rooms', `${roomId}.json`), 'utf8')) as RoomFile;
    expect(saved.kicked).toEqual([c.sessionId]);

    const s2 = await boot({ dataDir });
    const c2 = new TestClient(s2.wsUrl, { sessionId: c.sessionId, name: '丙' });
    clients.push(c2);
    await c2.hello();
    const denied = await c2.request({ t: 'joinRoom', roomId }, 'room', NEVER);
    expect(denied.t === 'error' && denied.message).toContain('移出');
    const a2 = new TestClient(s2.wsUrl, { sessionId: a.sessionId, name: '甲' });
    clients.push(a2);
    await a2.hello();
    await until(() => a2.room?.id === roomId, 3000, '回到房间');
    expect(a2.room!.seats.map((x) => x.seatKey)).toEqual(keys);
    expect(a2.isHost).toBe(true);
  });

  it('旧存档补齐座位键；无人在线时长只计服务器运行时间（关服期间不算），超过上限的对局启动时即清理', async () => {
    const dataDir = tmp('legacy');
    const dir = join(dataDir, 'rooms');
    mkdirSync(dir, { recursive: true });
    const legacy = (id: string, idleMs: number, savedAt: string) => ({
      format: ROOM_FILE_FORMAT,
      savedAt,
      version: 3,
      room: {
        id, name: id, hostSessionId: 'sess-old-host', maxPlayers: 2, status: 'playing', createdAt: savedAt,
        settings: { startTi: 9, endTi: 10, difficulty: 'normal', mode: 'existing' },
        seats: [
          { sessionId: 'sess-old-host', name: '甲', connected: true, lobbyReady: true, teamId: 'og', gameTeamId: 'og' },
          { sessionId: 'sess-old-b', name: '乙', connected: false, lobbyReady: true, teamId: 'lgd', gameTeamId: 'lgd' },
        ],
      },
      away: [],
      idleMs,
      state: { roundIndex: 0 },
    });
    const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    writeFileSync(join(dir, 'OLDAAA.json'), JSON.stringify(legacy('OLDAAA', 2 * 3_600_000, new Date().toISOString())));
    writeFileSync(join(dir, 'KEEPBB.json'), JSON.stringify(legacy('KEEPBB', 10 * 60_000, longAgo)));
    const s = await boot({ dataDir, idleRoomTtlMs: 3_600_000 });
    // 运行时间内累计无人在线 2 小时 > 1 小时 → 启动即删除（含文件）；关服 60 天、运行时间内只闲置 10 分钟的对局保留
    expect(s.rooms.roomIds()).toEqual(['KEEPBB']);
    await s.store!.flush();
    expect(existsSync(join(dir, 'OLDAAA.json'))).toBe(false);
    const info = s.rooms.getRoomInfoFor('KEEPBB', 'sess-old-b')!;
    expect(JSON.stringify(info)).not.toContain('sess-old');
    expect(info.seats.every((x) => /^[A-Za-z0-9_-]{4,40}$/.test(x.seatKey) && !x.connected)).toBe(true);
    expect(new Set(info.seats.map((x) => x.seatKey)).size).toBe(2);
    expect(info.hostSeatKey).toBe(info.seats[0].seatKey);
    expect(info.yourSeatKey).toBe(info.seats[1].seatKey);
    // 补齐的座位键随下次存档写出；之后接着计时
    expect(s.rooms.snapshot('KEEPBB')!.room.seats.map((x) => x.seatKey)).toEqual(info.seats.map((x) => x.seatKey));
    expect(s.rooms.snapshot('KEEPBB')!.idleMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(s.rooms.sweep(Date.now() + 40 * 60_000)).toBe(0);
    expect(s.rooms.sweep(Date.now() + 51 * 60_000)).toBe(1);
  });

  it('进行中的异步写入不会用旧快照覆盖 flushSync 写出的新快照', async () => {
    const dir = join(tmp('race'), 'rooms');
    const store = new RoomStore({ dir, debounceMs: 10 });
    let version = 1;
    const room = { id: 'RACE01', name: 'r', hostSessionId: 'host01', maxPlayers: 2, status: 'lobby', settings: { startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build' }, seats: [], createdAt: '' };
    store.attach({ snapshot: (id): RoomFile | null => (id === 'RACE01' ? { format: ROOM_FILE_FORMAT, savedAt: '', version, room: room as never, away: [], state: null } : null) });
    const pending = store.saveNow('RACE01');
    // 让异步写入取得快照（version 1）并开始写文件
    await Promise.resolve();
    await Promise.resolve();
    version = 2;
    expect(store.flushSync(['RACE01'])).toBe(1);
    await pending;
    await store.flush();
    const saved = JSON.parse(readFileSync(join(dir, 'RACE01.json'), 'utf8')) as RoomFile;
    expect(saved.version).toBe(2);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    store.close();
  });

  it('删除尚未落盘时 flushSync 同步删除存档，进行中的旧写入不会把已删除的房间写回', async () => {
    const dir = join(tmp('remove'), 'rooms');
    const store = new RoomStore({ dir, debounceMs: 10 });
    let alive = true;
    const room = { id: 'GONE01', name: 'r', hostSessionId: 'host01', maxPlayers: 2, status: 'finished', settings: { startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build' }, seats: [], createdAt: '' };
    store.attach({ snapshot: (id): RoomFile | null => (alive && id === 'GONE01' ? { format: ROOM_FILE_FORMAT, savedAt: '', version: 1, room: room as never, away: [], state: null } : null) });
    const file = join(dir, 'GONE01.json');
    await store.saveNow('GONE01');
    expect(existsSync(file)).toBe(true);
    // 一次异步写入已取得快照（删除之前），随后房间被清理、进程立即退出（Ctrl+C → flushSync）
    const pending = store.saveNow('GONE01');
    await Promise.resolve();
    await Promise.resolve();
    alive = false;
    void store.remove('GONE01');
    store.flushSync([]);
    expect(existsSync(file)).toBe(false);
    await pending;
    await store.flush();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    store.close();
  });

  it('损坏的房间文件被跳过并改名', async () => {
    const dataDir = tmp('bad');
    mkdirSync(join(dataDir, 'rooms'), { recursive: true });
    writeFileSync(join(dataDir, 'rooms', 'ABCDEF.json'), '{ broken');
    const s = await boot({ dataDir });
    expect(s.rooms.roomIds()).toEqual([]);
    expect(readdirSync(join(dataDir, 'rooms')).some((f) => f.startsWith('ABCDEF.json.corrupt-'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 真实引擎（src/engine/multi.ts）：开局 → 视图 → 操作 → 全员准备推进
// ---------------------------------------------------------------------------
describe('server · 真实引擎', () => {
  it('build 模式开局、座位视图隐私、RPC、全员准备后推进回合', async () => {
    registerNodeRosterLoader();
    const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, distDir, log: () => undefined, heartbeatMs: 0 });
    running.push(s);
    const a = await client(s, '甲');
    const b = await client(s, '乙');
    await a.request({ t: 'createRoom', name: '真实引擎', maxPlayers: 2 }, 'room', (m) => !!m.room);
    await b.request({ t: 'joinRoom', roomId: a.room!.id }, 'room', (m) => !!m.room);
    await a.request({ t: 'updateSettings', settings: { mode: 'build', startTi: 9, endTi: 9 } }, 'room', (m) => m.room?.settings.endTi === 9);
    await a.request({ t: 'updateSeat', newClub: { name: '测试一队', tag: 'TSA', region: 'CN', color: '#c23c2a' } }, 'room', (m) => !!m.room?.seats[0].newClub);
    await b.request({ t: 'updateSeat', newClub: { name: '测试二队', tag: 'TSB', region: 'EU', color: '#2a7bc2' } }, 'room', (m) => !!m.room?.seats[1].newClub);
    await a.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[0].lobbyReady);
    await b.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[1].lobbyReady);
    const sb = b.waitFor('state', () => true, 30_000);
    const started = await a.request({ t: 'startGame' }, 'state', () => true, 30_000);
    expect(started.t).toBe('state');
    await sb;
    const ta = a.room!.seats[0].gameTeamId!;
    const tb = a.room!.seats[1].gameTeamId!;
    expect(a.teamId).toBe(ta);
    expect(b.teamId).toBe(tb);
    for (const [c, me, other] of [[a, ta, tb], [b, tb, ta]] as const) {
      const v = c.state!;
      expect(v.teams[me].isPlayer).toBe(true);
      expect(v.multiplayer?.seats[other].saved).toEqual({});
      expect(v.multiplayer?.seats[other].sessionId).toBe('');
      expect(v.news.filter((n) => n.visibility === 'private').every((n) => !n.actorTeamId || n.actorTeamId === me)).toBe(true);
    }
    // 操作：设置训练重点（只影响自己）+ 报名一项开放赛事
    expect((await a.call('setTrainingFocus', 'mmr')).ok).toBe(true);
    expect(a.state!.trainingFocus).toBe('mmr');
    const open = a.state!.seasonTournamentIds.map((id) => a.state!.tournaments[id]).find((t) => t.tier !== 'ti' && t.playerStatus === 'open');
    if (open) await a.call('registerForTournament', open.id);
    await until(() => !!a.roundStatus && !!b.roundStatus, 3000, '回合状态');
    const round0 = a.roundStatus!.round;
    // 赛季初（无比赛/事件）两人准备 → 推进
    for (const c of [a, b]) {
      for (const d of c.state!.pendingDecisions) await c.call('resolveDecision', d.id, d.choices[0]?.id ?? '');
      const r = await c.request({ t: 'setRoundReady', ready: true }, 'roundStatus', (m) => m.status.ready[c.teamId!] === true || m.status.round !== round0);
      expect(r.t).toBe('roundStatus');
    }
    await until(() => a.roundStatus!.round !== round0 && b.roundStatus!.round !== round0, 10_000, '回合推进');
    await until(() => a.state!.roundIndex === a.roundStatus!.round && b.state!.roundIndex === b.roundStatus!.round, 5000, '视图同步');
    expect(a.roundStatus!.ready).toEqual({ [ta]: false, [tb]: false });
    expect(a.state!.trainingFocus).toBe('mmr');
    expect(b.violations).toEqual([]);
  }, 30_000);
});
