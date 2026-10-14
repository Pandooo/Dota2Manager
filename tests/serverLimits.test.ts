// 公网服务器的限制与防护（v0.3 审查修复，2026-10-14）：同一来源地址的连接数 / 等待中房间 / 每小时开局、
// 房间数满时清理长时间无人在线的进行中对局、聊天限速、公网模式下引擎包装的内部异常、抽卡前混入服务器随机数、对局谈判密钥。
// 测试连接都来自 127.0.0.1：用 limitPrivateAddresses 让按地址的限制也作用于本机（默认只限制公网来源）。
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameState, MultiplayerInfo, OpResult, SeatState } from '../src/engine/types';
import type { MpNewGameOptions } from '../src/engine/multi';
import type { MpEngine } from '../server/engine';
import { startServer, type RunningServer, type ServerOptions } from '../server/app';
import { TestClient, until } from '../server/testClient';
import { clientAddress } from '../server/net';
import { mySeat } from '../src/shared/protocol';

interface FakeState {
  settings: { playerTeamId: string };
  season: { ti: number };
  roundIndex: number;
  rngState: number;
  news: unknown[];
  teams: Record<string, { id: string; name: string }>;
  players: Record<string, unknown>;
  gameOver: null;
  multiplayer: MultiplayerInfo;
}

function fakeEngine(): MpEngine & { seen: { fn: string; rng: number }[] } {
  const seen: { fn: string; rng: number }[] = [];
  return {
    seen,
    async createGame(opts: MpNewGameOptions) {
      const seats: Record<string, SeatState> = {};
      const teams: FakeState['teams'] = {};
      const order: string[] = [];
      opts.players.forEach((p, i) => {
        const teamId = `club-${i + 1}`;
        order.push(teamId);
        teams[teamId] = { id: teamId, name: p.newClub?.name ?? teamId };
        seats[teamId] = { teamId, sessionId: p.sessionId, name: p.name, eliminated: false, ready: false, saved: {} };
      });
      const s: FakeState = {
        settings: { playerTeamId: '' }, season: { ti: opts.startTi }, roundIndex: 0, rngState: 12345, news: [], teams, players: {},
        gameOver: null, multiplayer: { mode: opts.mode, hostTeamId: order[0], order, seats, activeSeat: null },
      };
      return s as unknown as GameState;
    },
    callAsSeat(state, _teamId, fn): OpResult {
      seen.push({ fn, rng: (state as unknown as FakeState).rngState });
      if (fn === 'doScrim') return { ok: false, message: "操作失败：Cannot read properties of undefined (reading 'x')" };
      if (fn === 'doTraining') return { ok: false, message: 'TypeError: x is not a function' };
      if (fn === 'talkToPlayer') return { ok: false, message: '该选手本回合已经谈过心了' };
      return { ok: true, message: fn };
    },
    seatView(state) {
      const v = JSON.parse(JSON.stringify(state)) as FakeState;
      v.rngState = 0;
      if (v.multiplayer.secret !== undefined) v.multiplayer.secret = '';
      return v as unknown as GameState;
    },
    setSeatReady(state, teamId, ready) {
      (state as unknown as FakeState).multiplayer.seats[teamId].ready = ready;
      return { ok: true, message: '' };
    },
    allSeatsReady: () => false,
    advance: () => ({ ok: true, message: '' }),
    autopilot: () => ({ ok: true, message: '' }),
    info: (state) => (state as unknown as FakeState).multiplayer ?? null,
    startTis: () => [9],
    realTeams: async () => [],
  };
}

const running: RunningServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(running.splice(0).map((s) => s.close()));
});

let distDir = '';
function dist(): string {
  if (!distDir) {
    distDir = mkdtempSync(join(tmpdir(), 'd2m-limits-dist-'));
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><html><body>APP</body></html>');
  }
  return distDir;
}

async function boot(opts: Partial<ServerOptions> = {}, engine: MpEngine = fakeEngine()): Promise<RunningServer> {
  const s = await startServer({
    port: 0, host: '127.0.0.1', dataDir: null, distDir: dist(), engine, log: () => undefined, heartbeatMs: 0, ...opts,
  });
  running.push(s);
  return s;
}

let seq = 0;
async function client(s: RunningServer, name: string): Promise<TestClient> {
  const c = new TestClient(s.wsUrl, { sessionId: `lim-${++seq}-${Math.random().toString(36).slice(2, 8)}`, name });
  clients.push(c);
  await c.hello();
  return c;
}

/** 两人建房、各自组建战队、准备、开始（返回房主与另一人） */
async function startTwo(s: RunningServer, tag: string): Promise<[TestClient, TestClient]> {
  const a = await client(s, `甲${tag}`);
  const b = await client(s, `乙${tag}`);
  const created = await a.request({ t: 'createRoom', name: `房${tag}`, maxPlayers: 2 }, 'room', (m) => !!m.room);
  if (created.t !== 'room' || !created.room) throw new Error(created.t === 'error' ? created.message : '建房失败');
  await b.request({ t: 'joinRoom', roomId: created.room.id }, 'room', (m) => !!m.room);
  let i = 0;
  for (const c of [a, b]) {
    const t = `${tag}${i++}`.toUpperCase().slice(0, 5).padEnd(2, 'X');
    await c.request({ t: 'updateSeat', newClub: { name: `Club ${tag}${i}`, tag: t, region: 'CN', color: '#112233' } }, 'room', (m) => !!mySeat(m.room)?.newClub);
    await c.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!mySeat(m.room)?.lobbyReady);
  }
  const st = a.waitFor('state');
  a.send({ t: 'startGame' });
  await st;
  return [a, b];
}

describe('server · 来源地址', () => {
  it('clientAddress：默认取套接字地址（忽略可伪造的转发头），--trust-proxy 时取 X-Forwarded-For 第一个地址；IPv4 映射写法还原', () => {
    expect(clientAddress('::ffff:203.0.113.9', { 'x-forwarded-for': '127.0.0.1' })).toBe('203.0.113.9');
    expect(clientAddress('127.0.0.1', { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, true)).toBe('198.51.100.7');
    expect(clientAddress('127.0.0.1', { 'x-forwarded-for': 'not-an-ip' }, true)).toBe('127.0.0.1');
    expect(clientAddress(undefined)).toBe('');
  });
});

describe('server · 同一来源地址的限制', () => {
  it('同时连接数超出上限 → HTTP 429；断开后可以再连', async () => {
    const s = await boot({ limitPrivateAddresses: true, maxConnectionsPerAddress: 2 });
    const a = await client(s, 'A');
    await client(s, 'B');
    const c = new TestClient(s.wsUrl, { sessionId: 'lim-over', name: 'C' });
    clients.push(c);
    await expect(c.hello()).rejects.toThrow();
    await a.close();
    await until(() => s.rooms.conns.size === 1, 3000, '断开');
    await client(s, 'D');
  });

  it('默认只限制公网来源：本机连接不受按地址的连接数限制', async () => {
    const s = await boot({ maxConnectionsPerAddress: 1 });
    await client(s, 'A');
    await client(s, 'B');
    expect(s.rooms.conns.size).toBe(2);
  });

  it('同一地址等待中的房间数有上限；每小时开局次数有上限', async () => {
    const s = await boot({ limitPrivateAddresses: true, maxLobbyRoomsPerAddress: 1, maxGamesPerAddressPerHour: 1 });
    const a = await client(s, 'A');
    const b = await client(s, 'B');
    await a.request({ t: 'createRoom', name: '一号', maxPlayers: 2 }, 'room', (m) => !!m.room);
    const refused = await b.request({ t: 'createRoom', name: '二号', maxPlayers: 2 }, 'room', () => false);
    expect(refused.t === 'error' && refused.message).toContain('等待中的房间');
    await a.request({ t: 'leaveRoom' }, 'room', (m) => m.room === null);
    // 开局一次后同一地址一小时内不能再开局
    await startTwo(s, 'g');
    const [c, d] = [await client(s, 'C'), await client(s, 'D')];
    const created = await c.request({ t: 'createRoom', name: '三号', maxPlayers: 2 }, 'room', (m) => !!m.room);
    expect(created.t).toBe('room');
    await d.request({ t: 'joinRoom', roomId: c.room!.id }, 'room', (m) => !!m.room);
    for (const [x, tag] of [[c, 'CC'], [d, 'DD']] as const) {
      await x.request({ t: 'updateSeat', newClub: { name: `Club ${tag}`, tag, region: 'CN', color: '#112233' } }, 'room', (m) => !!mySeat(m.room)?.newClub);
      await x.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!mySeat(m.room)?.lobbyReady);
    }
    const r = await c.request({ t: 'startGame' }, 'state', () => true);
    expect(r.t === 'error' && r.message).toContain('一小时内最多开始 1 局');
  });
});

describe('server · 房间位清理与聊天', () => {
  it('房间数满时：连续无人在线超过 abandonedRoomEvictMs 的进行中对局被清理，新玩家可以建房', async () => {
    const s = await boot({ maxRooms: 1, abandonedRoomEvictMs: 1 });
    const [a, b] = await startTwo(s, 'x');
    const oldId = a.room!.id;
    await a.close();
    await b.close();
    await until(() => s.rooms.getRoomInfo(oldId)!.seats.every((x) => !x.connected), 3000, '全员离线');
    await new Promise((r) => setTimeout(r, 5));
    const c = await client(s, 'C');
    const ok = await c.request({ t: 'createRoom', name: '新房', maxPlayers: 2 }, 'room', (m) => !!m.room);
    expect(ok.t).toBe('room');
    expect(s.rooms.roomIds()).toEqual([c.room!.id]);
  });

  it('进行中的对局有人在线时不清理；abandonedRoomEvictMs = 0 时不清理', async () => {
    const s = await boot({ maxRooms: 1, abandonedRoomEvictMs: 0 });
    const [a, b] = await startTwo(s, 'y');
    const id = a.room!.id;
    await a.close();
    await b.close();
    await until(() => s.rooms.getRoomInfo(id)!.seats.every((x) => !x.connected), 3000, '全员离线');
    const c = await client(s, 'C');
    const full = await c.request({ t: 'createRoom', name: '新房', maxPlayers: 2 }, 'room', () => false);
    expect(full.t === 'error' && full.message).toContain('上限');
  });

  it('聊天单独限速：连续 5 条之后提示「发言过于频繁」，其他人收不到多出的内容', async () => {
    const s = await boot();
    const a = await client(s, 'A');
    const b = await client(s, 'B');
    await a.request({ t: 'createRoom', name: '聊天', maxPlayers: 2 }, 'room', (m) => !!m.room);
    await b.request({ t: 'joinRoom', roomId: a.room!.id }, 'room', (m) => !!m.room);
    for (let i = 0; i < 12; i++) a.send({ t: 'chat', text: `第 ${i} 条` });
    await until(() => a.errors.some((e) => e.includes('发言过于频繁')), 3000, '限速提示');
    await new Promise((r) => setTimeout(r, 200));
    const got = b.log.filter((m) => m.t === 'chat').length;
    expect(got).toBeGreaterThanOrEqual(5);
    expect(got).toBeLessThan(8);
  });
});

describe('server · 公网模式与服务器端随机', () => {
  it('公网模式：引擎包装的内部异常与不含中文的失败文字换成通用提示，普通中文提示原样发送', async () => {
    const s = await boot({ publicMode: true });
    const [a] = await startTwo(s, 'p');
    const r1 = await a.call('doScrim');
    expect(r1.ok).toBe(false);
    expect(r1.message).toBe('操作失败：服务器内部错误，请稍后再试');
    const r2 = await a.call('doTraining');
    expect(r2.message).toBe('服务器内部错误，请稍后再试');
    const r3 = await a.call('talkToPlayer', 'x');
    expect(r3.message).toBe('该选手本回合已经谈过心了');
  });

  it('局域网模式不过滤；开局时写入谈判密钥（视图中为空）；抽卡前混入服务器随机数', async () => {
    const eng = fakeEngine();
    const s = await boot({}, eng);
    const [a] = await startTwo(s, 'r');
    const st = s.rooms.getRoomState(a.room!.id) as unknown as FakeState;
    expect(st.multiplayer.secret).toMatch(/^[0-9a-f]{32}$/);
    expect(a.state?.multiplayer?.secret).toBe('');
    expect((await a.call('doScrim')).message).toContain('Cannot read properties');
    await a.call('gachaPull', 1);
    const pull = eng.seen.find((x) => x.fn === 'gachaPull')!;
    expect(pull.rng).not.toBe(12345);
    // 其他操作不改动随机数状态
    const before = st.rngState;
    await a.call('markAllNewsRead');
    expect(st.rngState).toBe(before);
  });
});
