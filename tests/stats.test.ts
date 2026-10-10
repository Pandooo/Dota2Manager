// DotaPedia 统计记录（src/engine/stats.ts）：K/D/A 与比分一致、英雄归属、确定性、记录开关不影响比赛结果、
// 聚合与 Player.stats 一致、不存逐局明细（旧存档的 GameRecord.box 升级时清除）、性能（16 个赛季）与存档体积
import { beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import type { GameRecord, GameState, PediaPlayer, Position, Tournament } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { simulateGame } from '../src/engine/match';
import { generateLive } from '../src/engine/commentary';
import {
  allocateSideKda, apportion, compactHeroes, PEDIA_VERSION, pediaGameRng, pediaOf, pediaRevision, recordPediaSeasonEnd,
  recordPrizeSplit, stripLegacyGameBoxes,
} from '../src/engine/stats';
import { pediaDashboard } from '../src/engine/pedia';
import type { StatSlot } from '../src/engine/stats';
import { createDraft, runDraftUntil } from '../src/engine/draft';
import { seededRng } from '../src/engine/rng';
import { importSave } from '../src/engine/save';
import { makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const cfg = CONFIG.pedia as { enabled: boolean };

function withPedia<T>(on: boolean, fn: () => T): T {
  const prev = cfg.enabled;
  cfg.enabled = on;
  try {
    return fn();
  } finally {
    cfg.enabled = prev;
  }
}

async function withPediaAsync<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = cfg.enabled;
  cfg.enabled = on;
  try {
    return await fn();
  } finally {
    cfg.enabled = prev;
  }
}

/** 无头推进（决策选第一项、比赛快速模拟、玩家战队资金兜底），每次进入新赛季时回调 */
async function runGame(opts: { startTi: number; seasons: number; teamId: string; seed: number; onSeason?: (g: GameState) => void }): Promise<GameState> {
  const g = await createNewGame({ startTi: opts.startTi, seasons: opts.seasons, difficulty: 'easy', managerName: 'T', teamId: opts.teamId, seed: opts.seed });
  let ti = g.season.ti;
  for (let step = 0; step < 8000 && !g.gameOver; step++) {
    g.popups.length = 0;
    for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
      const d = g.pendingDecisions[0];
      resolveDecision(g, d.id, d.choices[0]?.id ?? '');
      if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
    }
    const me = g.teams[g.settings.playerTeamId];
    if (me && g.phase === 'preseason' && me.gold < 2_000_000) me.gold = 2_000_000;
    if (currentPlayerTournament(g) || g.activeMatch) {
      if (!quickSimTournament(g).ok) fillLineupWithTempSubs(g);
    }
    advance(g);
    if (g.season.ti !== ti) {
      ti = g.season.ti;
      opts.onSeason?.(g);
    }
  }
  return g;
}

/** 去掉 DotaPedia 数据（pedia）后的存档 JSON：用于比较「记录开 / 关」的比赛结果（逐局记录不含任何统计字段） */
function withoutPedia(g: GameState): string {
  const c = JSON.parse(JSON.stringify(g)) as GameState;
  delete c.pedia;
  delete (c as { createdAt?: string }).createdAt;
  return JSON.stringify(c);
}

/** 对局中出现的所有 GameRecord（赛事系列赛 + 进行中的比赛） */
function allGames(g: GameState): GameRecord[] {
  const out: GameRecord[] = [];
  for (const t of Object.values(g.tournaments)) for (const s of Object.values(t.series)) out.push(...(s.result?.games ?? []));
  for (const v of [g.activeMatch?.pendingGame, ...(g.activeMatch?.games ?? [])]) if (v) out.push(v);
  return out;
}

function slotsOf(s: GameState, teamId: string): StatSlot[] {
  const t = s.teams[teamId];
  return POSITIONS.map((pos) => ({ pos, player: s.players[t.lineup[pos] as string] })).filter((x) => !!x.player);
}

/** 选手的 DotaPedia 累计：[局数, 击杀, 阵亡, 助攻] + 英雄出场表 */
function snapPlayer(s: GameState, id: string): { t: [number, number, number, number]; h: Record<string, number> } {
  const e = pediaOf(s)?.players?.[id];
  const t: [number, number, number, number] = [0, 0, 0, 0];
  for (const r of e?.s ?? []) {
    t[0] += r[2];
    t[1] += r[4];
    t[2] += r[5];
    t[3] += r[6];
  }
  const h: Record<string, number> = {};
  for (const [hero, v] of Object.entries(e?.h ?? {})) h[hero] = v[0];
  return { t, h };
}

interface GameLine { id: string; hero: string; k: number; d: number; a: number }

/**
 * 模拟一局并从 DotaPedia 聚合的增量还原本局个人数据（逐局明细不再存储）：
 * 返回双方出场选手的 [英雄, K, D, A]（按首发位置顺序）。
 */
function playAndDiff(s: GameState, run: () => GameRecord, teamA: string, teamB: string): { g: GameRecord; A: GameLine[]; B: GameLine[] } {
  const ids = (t: string) => POSITIONS.map((pos) => s.teams[t]?.lineup[pos]).filter((id): id is string => {
    const p = id ? s.players[id] : undefined;
    return !!p && (!p.status || p.status === 'active');
  });
  const before = new Map<string, ReturnType<typeof snapPlayer>>();
  const la = ids(teamA);
  const lb = ids(teamB);
  for (const id of [...la, ...lb]) before.set(id, snapPlayer(s, id));
  const g = run();
  const line = (id: string): GameLine => {
    const b = before.get(id)!;
    const a = snapPlayer(s, id);
    expect(a.t[0] - b.t[0]).toBe(1); // 每名出场选手恰好记 1 局
    const heroes = Object.keys(a.h).filter((h) => a.h[h] !== (b.h[h] ?? 0));
    return { id, hero: heroes[0] ?? '', k: a.t[1] - b.t[1], d: a.t[2] - b.t[2], a: a.t[3] - b.t[3] };
  };
  return { g, A: la.map(line), B: lb.map(line) };
}

/** 本局个人数据与比分一致：A 方击杀之和 = killsA、阵亡之和 = killsB；助攻 + 击杀 ≤ 本队击杀；英雄不重复；不存逐局明细 */
function checkGame(r: { g: GameRecord; A: GameLine[]; B: GameLine[] }, n = 10): void {
  const { g, A, B } = r;
  const sum = (rows: GameLine[], f: (x: GameLine) => number) => rows.reduce((x, l) => x + f(l), 0);
  expect(sum(A, (l) => l.k)).toBe(g.killsA);
  expect(sum(B, (l) => l.k)).toBe(g.killsB);
  expect(sum(A, (l) => l.d)).toBe(g.killsB); // A 方阵亡 = B 方击杀
  expect(sum(B, (l) => l.d)).toBe(g.killsA);
  for (const [side, kills] of [[A, g.killsA], [B, g.killsB]] as const) {
    for (const l of side) {
      expect(l.a).toBeGreaterThanOrEqual(0);
      expect(l.k + l.a).toBeLessThanOrEqual(kills); // 击杀参与率 ≤ 100%
    }
  }
  const heroes = [...A, ...B].map((l) => l.hero).filter(Boolean);
  expect(new Set(heroes).size).toBe(heroes.length); // 同局英雄不重复
  expect(heroes).toHaveLength(n);
  expect('box' in g).toBe(false); // 逐局个人数据不写入对局记录
}

describe('stats · 分配工具', () => {
  it('apportion：总和不变、按权重、遵守上限', () => {
    expect(apportion(10, [1, 1, 1, 1, 1])).toEqual([2, 2, 2, 2, 2]);
    expect(apportion(7, [3, 1, 0, 0, 0]).reduce((a, b) => a + b, 0)).toBe(7);
    expect(apportion(7, [3, 1, 0, 0, 0])[2]).toBe(0);
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(5, [0, 0, 0])).toEqual([2, 2, 1]); // 权重全 0 → 平均
    const capped = apportion(20, [10, 1, 1, 1, 1], [3, 9, 9, 9, 9]);
    expect(capped[0]).toBe(3);
    expect(capped.reduce((a, b) => a + b, 0)).toBe(20);
    // 上限之和不足 → 填满上限
    expect(apportion(50, [1, 1], [4, 6])).toEqual([4, 6]);
    for (let seed = 1; seed < 200; seed++) {
      const r = seededRng(seed);
      const n = r.int(1, 6);
      const w = Array.from({ length: n }, () => r.range(0, 3));
      const caps = Array.from({ length: n }, () => r.int(0, 12));
      const total = r.int(0, 40);
      const out = apportion(total, w, caps);
      out.forEach((v, i) => expect(v).toBeLessThanOrEqual(caps[i]));
      expect(out.reduce((a, b) => a + b, 0)).toBe(Math.min(total, caps.reduce((a, b) => a + b, 0)));
    }
  });

  it('allocateSideKda：击杀 / 阵亡与比分一致，核心位击杀多、辅助助攻多，MVP 数据更好', () => {
    const s = makeTestState(2);
    const slots = slotsOf(s, 't0');
    const tot: Record<Position, { k: number; d: number; a: number }> = {} as never;
    for (const pos of POSITIONS) tot[pos] = { k: 0, d: 0, a: 0 };
    let mvpK = 0;
    let otherK = 0;
    for (let i = 1; i <= 400; i++) {
      const rng = pediaGameRng('t', i);
      const kills = 10 + (i % 30);
      const deaths = 8 + (i % 25);
      const mvp = slots[i % 5].player.id;
      const r = allocateSideKda(rng, slots, kills, deaths, mvp);
      expect(r.kills.reduce((a, b) => a + b, 0)).toBe(kills);
      expect(r.deaths.reduce((a, b) => a + b, 0)).toBe(deaths);
      r.assists.forEach((a, j) => expect(a + r.kills[j]).toBeLessThanOrEqual(kills));
      const total = r.assists.reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(Math.floor(kills * CONFIG.pedia.assistsPerKill[0]) - 1);
      slots.forEach((x, j) => {
        tot[x.pos].k += r.kills[j];
        tot[x.pos].d += r.deaths[j];
        tot[x.pos].a += r.assists[j];
        if (x.player.id === mvp) mvpK += r.kills[j];
        else otherK += r.kills[j] / 4;
      });
    }
    expect(tot.M.k).toBeGreaterThan(tot.SS.k);
    expect(tot.C.k).toBeGreaterThan(tot.HS.k);
    expect(tot.HS.a).toBeGreaterThan(tot.C.a);
    expect(tot.HS.d).toBeGreaterThan(tot.C.d);
    expect(mvpK).toBeGreaterThan(otherK);
    // 直播数据（与比分一致）直接采用
    const kd: Record<string, [number, number]> = {};
    slots.forEach((x, j) => { kd[x.player.id] = [j, 4 - j]; });
    const r = allocateSideKda(pediaGameRng('t', 1), slots, 10, 10, undefined, kd);
    expect(r.kills).toEqual([0, 1, 2, 3, 4]);
    expect(r.deaths).toEqual([4, 3, 2, 1, 0]);
    // 与比分不一致的直播数据被忽略
    const r2 = allocateSideKda(pediaGameRng('t', 1), slots, 12, 10, undefined, kd);
    expect(r2.kills.reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('allocateSideKda：阵亡 / 助攻比击杀更平均（真实 TI：击杀参与率 > 90% 约 4%，与击杀同用 0.32 的噪声时约 7%）', () => {
    const s = makeTestState(2);
    const slots = slotsOf(s, 't0');
    let highKp = 0;
    let n = 0;
    for (let i = 1; i <= 3000; i++) {
      const kills = 12 + (i % 37);
      const deaths = 10 + ((i * 7) % 35);
      const r = allocateSideKda(pediaGameRng('kp', i), slots, kills, deaths, i % 3 === 0 ? slots[0].player.id : undefined);
      for (let j = 0; j < slots.length; j++) {
        n++;
        if ((r.kills[j] + r.assists[j]) / kills > 0.9) highKp++;
      }
    }
    expect(CONFIG.pedia.deathNoiseSigma).toBeLessThan(CONFIG.pedia.noiseSigma);
    expect(CONFIG.pedia.assistNoiseSigma).toBeLessThan(CONFIG.pedia.noiseSigma);
    expect(highKp / n).toBeGreaterThan(0.01);
    expect(highKp / n).toBeLessThan(0.05);
  });

  it('compactHeroes：只保留局数最多的英雄，其余并入「其他」', () => {
    const e: PediaPlayer = { n: 'x', p: 'C', s: [], h: { a: [5, 3], b: [1, 1], c: [9, 2], d: [2, 0] }, cs: 0, bs: 0, pt: -1, pr: 0 };
    compactHeroes(e, 2);
    expect(Object.keys(e.h).sort()).toEqual(['a', 'c']);
    expect(e.ho).toEqual([3, 1]);
  });
});

describe('stats · 单局记录', () => {
  it('AI 快速模拟：个人 K/D/A（由聚合增量还原）与比分一致、英雄不重复、不存逐局明细；不消耗主随机序列', () => {
    const s = makeTestState(4);
    s.teams.t0.isPlayer = false;
    s.settings.playerTeamId = 'none';
    for (let i = 0; i < 60; i++) {
      const before = s.rngState;
      const off = JSON.parse(JSON.stringify(s)) as GameState;
      const r = playAndDiff(s, () => simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: i, draft: null, withLive: false, tier: 'premier' }), 't1', 't2');
      checkGame(r);
      const g = r.g;
      // 同一状态关闭记录重放：结果与主随机序列完全相同，对局记录逐字节相同（记录不在对局上留任何字段）
      const g2 = withPedia(false, () => simulateGame(off, { teamA: 't1', teamB: 't2', gameIndex: i, draft: null, withLive: false, tier: 'premier' }));
      expect(g2.winner).toBe(g.winner);
      expect(g2.killsA).toBe(g.killsA);
      expect(g2.durationMin).toBe(g.durationMin);
      expect(off.rngState).toBe(s.rngState);
      expect(s.rngState).not.toBe(before);
      expect(JSON.stringify(g2)).toBe(JSON.stringify(g));
    }
    const ps = pediaOf(s)!;
    expect(ps.seq).toBe(60);
    const rows = Object.values(ps.players).flatMap((p) => p.s);
    const games = rows.reduce((a, r) => a + r[2], 0);
    expect(games).toBe(600);
    const k = rows.reduce((a, r) => a + r[4], 0);
    const d = rows.reduce((a, r) => a + r[5], 0);
    expect(k).toBe(d); // 每个击杀对应一次阵亡
    const team = ps.teams.t1.s[0];
    expect(team.gw + team.gl).toBe(60);
    // Player.stats 与 DotaPedia 一致
    for (const id of Object.keys(ps.players)) {
      const p = s.players[id];
      const tot = ps.players[id].s.reduce((a, r) => [a[0] + r[2], a[1] + r[3], a[2] + r[7]], [0, 0, 0]);
      expect(tot).toEqual([p.stats.matches, p.stats.wins, p.stats.mvp]);
    }
  });

  it('文字直播对局：BP 对局取 BP 的英雄；直播输出的个人击杀 / 阵亡覆盖 10 人且与比分一致（统计直接采用）', () => {
    const s = makeTestState(4);
    for (let i = 0; i < 12; i++) {
      const d = createDraft(s);
      runDraftUntil(s, d, 't0', 't1', null);
      const r = playAndDiff(s, () => simulateGame(s, { teamA: 't0', teamB: 't1', gameIndex: i, draft: d, withLive: true, tier: 'major' }), 't0', 't1');
      checkGame(r);
      const g = r.g;
      const lines = [...r.A, ...r.B];
      for (const a of d.actions) {
        if (a.type !== 'pick' || !a.playerId) continue;
        expect(lines.find((l) => l.id === a.playerId)?.hero).toBe(a.heroId);
      }
      // 直播的 kdOut：10 名出场选手都有计数，A 方击杀之和 = killsA、A 方阵亡之和 = killsB（stats 因此采用直播计数而非重新分配）
      const kd: Record<string, [number, number]> = {};
      generateLive(JSON.parse(JSON.stringify(s)) as GameState, {
        teamA: 't0', teamB: 't1', radiant: g.radiant, draft: g.draft, winner: g.winner, durationMin: g.durationMin,
        killsA: g.killsA, killsB: g.killsB, incidents: g.incidents, winProbA: g.winProbA, mvpPlayerId: g.mvpPlayerId, kdOut: kd,
      });
      const ids = Object.keys(kd);
      expect(ids).toHaveLength(10);
      const onA = ids.filter((id) => s.players[id].teamId === 't0');
      expect(onA.reduce((a, id) => a + kd[id][0], 0)).toBe(g.killsA);
      expect(onA.reduce((a, id) => a + kd[id][1], 0)).toBe(g.killsB);
    }
    const last = playAndDiff(s, () => simulateGame(s, { teamA: 't0', teamB: 't1', gameIndex: 0, withLive: true, tier: 'ti' }), 't0', 't1');
    checkGame(last);
    expect(last.g.live[last.g.live.length - 1].killsA).toBe(last.g.killsA);
  });
});

describe('stats · 健壮性（审查补充）', () => {
  it('跨赛季写入（赛事赛季早于已追加的行）：不重复建行，数据行按赛季排序', () => {
    const s = makeTestState(4);
    s.teams.t0.isPlayer = false;
    s.settings.playerTeamId = 'none';
    simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    const pid = s.teams.t1.lineup.C as string;
    // 上赛季（TI8）赛事的奖金在 TI9 的行之后才写入
    const cut = { playerId: pid, amount: 500 };
    recordPrizeSplit(s, { id: 'old', season: 8, startDate: '', prizePool: 0 } as unknown as Tournament, 't1', 1,
      { club: 1000, players: 500, cuts: [cut] });
    simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 1, draft: null, withLive: false, tier: 'premier' });
    const rows = pediaOf(s)!.players[pid].s;
    expect(rows.map((r) => `${r[0]}|${r[1]}`)).toEqual(['8|t1', '9|t1']);
    expect(rows[1][2]).toBe(2);
    expect(rows[0][8]).toBe(500);
    expect(pediaOf(s)!.teams.t1.s.map((r) => r.ti)).toEqual([8, 9]);
  });

  it('首发不足 5 人：4 名出场选手的击杀 / 阵亡之和仍与比分一致，空缺选手不记录', () => {
    const s = makeTestState(4);
    s.teams.t0.isPlayer = false;
    s.settings.playerTeamId = 'none';
    const missing = s.teams.t1.lineup.HS as string;
    s.players[missing].status = 'banned'; // 禁赛选手视为空缺（match.lineupOf）
    const r = playAndDiff(s, () => simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 0, draft: null, withLive: false, tier: 'premier' }), 't1', 't2');
    expect(r.A).toHaveLength(4);
    expect(r.B).toHaveLength(5);
    checkGame(r, 9);
    expect(pediaOf(s)!.players[missing]).toBeUndefined();
  });

  it('旧存档（统计格式 v1）：逐局明细 GameRecord.box 在读档或第一次写入统计时清除，聚合保留', () => {
    const s = makeTestState(4);
    s.teams.t0.isPlayer = false;
    s.settings.playerTeamId = 'none';
    const g0 = simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    const ps = pediaOf(s)!;
    expect(ps.v).toBe(PEDIA_VERSION);
    // 构造旧存档：v1 统计 + 赛事系列赛 / 进行中比赛里的逐局 box
    const legacyBox = [['x', 'npc_dota_hero_axe', 3, 1, 4], ['', '', 0, 0, 0]];
    const old = JSON.parse(JSON.stringify(s)) as GameState;
    (old.pedia as { v: number }).v = 1;
    old.tournaments.tx = {
      id: 'tx', series: { s1: { result: { games: [{ ...g0, box: legacyBox }, { ...g0 }] } } },
    } as unknown as GameState['tournaments'][string];
    old.activeMatch = { games: [{ ...g0, box: legacyBox }], pendingGame: { ...g0, box: legacyBox } } as unknown as GameState['activeMatch'];
    const players = JSON.stringify(old.pedia!.players);
    expect(JSON.stringify(old)).toContain('"box"');
    simulateGame(old, { teamA: 't1', teamB: 't3', gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    expect(JSON.stringify(old)).not.toContain('"box"');
    expect(old.pedia!.v).toBe(PEDIA_VERSION);
    expect(old.pedia!.seq).toBe(2);
    expect(JSON.stringify(old.pedia!.players)).not.toBe(players); // 继续累加
    // 直接调用（如读档时）：返回清除的对局数；没有残留时为 0
    const again = JSON.parse(JSON.stringify(old)) as GameState;
    (again.tournaments.tx.series.s1.result!.games[0] as unknown as { box: unknown }).box = legacyBox;
    expect(stripLegacyGameBoxes(again)).toBe(1);
    expect(stripLegacyGameBoxes(again)).toBe(0);
    expect(stripLegacyGameBoxes({} as GameState)).toBe(0);
    // 读档（save.importSave）即清除，不必等下一局
    const file = JSON.parse(JSON.stringify(old)) as GameState;
    file.settings.playerTeamId = 't0';
    (file.pedia as { v: number }).v = 1;
    (file.tournaments.tx.series.s1.result!.games[1] as unknown as { box: unknown }).box = legacyBox;
    file.activeMatch = { games: [{ ...g0, box: legacyBox }], pendingGame: { ...g0, box: legacyBox } } as unknown as GameState['activeMatch'];
    expect(JSON.stringify(file)).toContain('"box"');
    const loaded = importSave(JSON.stringify(file));
    expect(JSON.stringify(loaded)).not.toContain('"box"');
    expect(JSON.stringify(loaded.pedia!.players)).toBe(JSON.stringify(file.pedia!.players));
  });

  it('损坏的统计数据不影响比赛：结果与主随机序列与关闭记录时相同，统计写入修订号递增', () => {
    const s = makeTestState(4);
    s.teams.t0.isPlayer = false;
    s.settings.playerTeamId = 'none';
    simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    const ps = pediaOf(s)!;
    (ps.seasons as Record<string, unknown>)['9'] = 5; // 手工编辑 / 截断的存档
    const off = JSON.parse(JSON.stringify(s)) as GameState;
    const rev = pediaRevision();
    const err = console.error;
    console.error = () => {};
    try {
      const g = simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 1, draft: null, withLive: false, tier: 'premier' });
      const g2 = withPedia(false, () => simulateGame(off, { teamA: 't1', teamB: 't2', gameIndex: 1, draft: null, withLive: false, tier: 'premier' }));
      expect(g.winner).toBe(g2.winner);
      expect(g.killsA).toBe(g2.killsA);
      expect(s.rngState).toBe(off.rngState);
    } finally {
      console.error = err;
    }
    expect(pediaRevision()).toBeGreaterThan(rev);
  });

  it('新游戏：统计覆盖整个执教生涯（full）；旧存档中途开始记录则不完整', () => {
    const s = makeTestState(4);
    s.teams.t0.isPlayer = false;
    s.settings.playerTeamId = 'none';
    s.roundIndex = 3;
    simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    expect(pediaOf(s)!.full).toBe(1);
    expect(pediaDashboard(s).overview.complete).toBe(true);
    const old = JSON.parse(JSON.stringify(s)) as GameState;
    delete old.pedia;
    simulateGame(old, { teamA: 't1', teamB: 't3', gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    expect(pediaOf(old)!.full).toBeUndefined();
    expect(pediaDashboard(old).overview.complete).toBe(false);
  });
});

describe('stats · 整局集成', () => {
  it('确定性：同一种子两次的统计完全相同；关闭记录时比赛结果、主随机序列与存档（除统计外）完全相同', async () => {
    const opts = { startTi: 9, seasons: 1, teamId: 'og', seed: 21 };
    const a = await withPediaAsync(true, () => runGame(opts));
    const b = await withPediaAsync(true, () => runGame(opts));
    const off = await withPediaAsync(false, () => runGame(opts));
    expect(JSON.stringify(a.pedia)).toBe(JSON.stringify(b.pedia));
    expect(off.pedia).toBeUndefined();
    expect(off.rngState).toBe(a.rngState);
    expect(off.idCounter).toBe(a.idCounter);
    expect(withoutPedia(off)).toBe(withoutPedia(a));
    // 不存逐局明细：玩家战队的系列赛对局（随赛事保留）也没有个人数据
    const kept = allGames(a);
    expect(kept.length).toBeGreaterThan(0);
    for (const g of kept) expect('box' in g).toBe(false);
  }, 120000);

  it('聚合：与 Player.stats / 赛事史一致，K 与 D 守恒，奖金分成可追溯', async () => {
    const g = await runGame({ startTi: 13, seasons: 2, teamId: 'team-liquid', seed: 5 });
    const ps = pediaOf(g)!;
    expect(ps.seq).toBeGreaterThan(1000);
    // 选手：局数 / 胜局 / MVP 与 Player.stats 一致（新游戏开局全部为 0）
    for (const [id, p] of Object.entries(g.players)) {
      const e = ps.players[id];
      const tot = (e?.s ?? []).reduce((x, r) => [x[0] + r[2], x[1] + r[3], x[2] + r[7]], [0, 0, 0]);
      expect(tot).toEqual([p.stats.matches, p.stats.wins, p.stats.mvp]);
    }
    // 击杀 = 阵亡（全联盟）；战队击杀之和 = 战队阵亡之和；选手击杀之和 = 战队击杀之和（被清理的野外替补也保留在统计中）
    let pk = 0;
    let pd = 0;
    for (const e of Object.values(ps.players)) for (const r of e.s) { pk += r[4]; pd += r[5]; }
    let tk = 0;
    let td = 0;
    let gw = 0;
    let gl = 0;
    let sw = 0;
    let sl = 0;
    let sd = 0;
    let pp = 0;
    for (const e of Object.values(ps.teams)) for (const r of e.s) {
      tk += r.k; td += r.d; gw += r.gw; gl += r.gl; sw += r.sw; sl += r.sl; sd += r.sd; pp += r.pp;
    }
    expect(pk).toBe(pd);
    expect(tk).toBe(td);
    expect(pk).toBe(tk);
    expect(gw).toBe(gl);
    expect(gw).toBe(ps.seq);
    expect(sw).toBe(sl);
    expect(sd % 2).toBe(0);
    let seasonsGames = 0;
    for (const v of Object.values(ps.seasons)) seasonsGames += v[0];
    expect(seasonsGames).toBe(ps.seq);
    // 选手奖金 ≤ 战队队员分成（差额 = 已被清理的野外替补），且绝大部分可追溯到选手
    let playerPrize = 0;
    for (const e of Object.values(ps.players)) for (const r of e.s) playerPrize += r[8];
    expect(playerPrize).toBeLessThanOrEqual(pp);
    expect(playerPrize).toBeGreaterThan(pp * 0.9);
    // 赛季末快照：每个赛季都有荣誉 / 排名 / 阵容
    const me = ps.teams[g.settings.playerTeamId];
    const snaps = me.s.filter((r) => r.h !== undefined);
    expect(snaps.length).toBe(2);
    for (const r of snaps) {
      expect(r.sr).toBeGreaterThanOrEqual(1);
      expect(r.st).toBeGreaterThan(10);
      expect((r.r ?? []).length).toBeGreaterThanOrEqual(5);
    }
    // 英雄表已压缩、巅峰等级已快照
    for (const e of Object.values(ps.players)) expect(Object.keys(e.h).length).toBeLessThanOrEqual(CONFIG.pedia.heroesPerPlayer + 40);
    const starters = Object.values(g.teams[g.settings.playerTeamId].lineup).filter((x): x is string => !!x);
    for (const id of starters) expect(ps.players[id]?.pt ?? -1).toBeGreaterThanOrEqual(0);
    // 冠亚军首发（DotaPedia）与 Player.stats.titles 同口径
    const titles = new Map<string, number>();
    for (const [tid, tour] of Object.entries(ps.tours)) {
      const h = g.history.tournaments.find((x) => x.tournamentId === tid);
      if (!h || h.tier === 'qualifier') continue;
      for (const [, from, to, ids] of tour.top) if (from === 1 && to === 1) for (const id of ids) titles.set(id, (titles.get(id) ?? 0) + 1);
    }
    for (const [id, p] of Object.entries(g.players)) {
      if (p.isWildSub) continue;
      expect(titles.get(id) ?? 0).toBe(p.stats.titles);
    }
    // 幂等：同一状态连续两次赛季末快照，第二次不改变任何数据
    const g2 = JSON.parse(JSON.stringify(g)) as GameState;
    recordPediaSeasonEnd(g2);
    const once = JSON.stringify(g2.pedia);
    recordPediaSeasonEnd(g2);
    expect(JSON.stringify(g2.pedia)).toBe(once);
  }, 120000);
});

describe('stats · 性能与存档体积', () => {
  it('TI1 → TI16（16 个赛季）：记录开销与存档体积在目标以内（体积按「记录开 / 关」两份完整存档比较；不存逐局明细）', async () => {
    // 第 10 个赛季结束（进入 TI11 赛季）时测量完整存档体积（同一种子，开 / 关两次运行的比赛完全相同）
    const at10: { on: number; off: number; pedia: number } = { on: 0, off: 0, pedia: 0 };
    const t0 = performance.now();
    const on = await withPediaAsync(true, () => runGame({
      startTi: 1, seasons: 16, teamId: 'natus-vincere', seed: 7,
      onSeason: (g) => {
        if (g.season.ti === 11 && !at10.on) {
          at10.on = JSON.stringify(g).length;
          at10.pedia = JSON.stringify(g.pedia ?? {}).length;
        }
      },
    }));
    const tOn = performance.now() - t0;
    const t1 = performance.now();
    const off = await withPediaAsync(false, () => runGame({
      startTi: 1, seasons: 16, teamId: 'natus-vincere', seed: 7,
      onSeason: (g) => {
        if (g.season.ti === 11 && !at10.off) at10.off = JSON.stringify(g).length;
      },
    }));
    const tOff = performance.now() - t1;
    expect(on.rngState).toBe(off.rngState);
    const ps = pediaOf(on)!;
    const full = JSON.stringify(on).length;
    const fullOff = JSON.stringify(off).length;
    const pedia = JSON.stringify(ps).length;
    const g10 = at10.on / Math.max(1, at10.off) - 1;
    const g16 = full / fullOff - 1;
    console.log(
      `[pedia] 16 季 ${ps.seq} 局：记录开 ${(tOn / 1000).toFixed(1)}s / 关 ${(tOff / 1000).toFixed(1)}s`
      + `（${(((tOn - tOff) / Math.max(1, ps.seq)) * 1000).toFixed(1)}µs/局，机器负载会使单次测量偏高）；`
      + `存档 10 季 +${(g10 * 100).toFixed(1)}%（+${((at10.on - at10.off) / 1024).toFixed(0)} KB，其中 pedia ${(at10.pedia / 1024).toFixed(0)} KB / ${(at10.on / 1024).toFixed(0)} KB）`
      + `，16 季 +${(g16 * 100).toFixed(1)}%（+${((full - fullOff) / 1024).toFixed(0)} KB / ${(full / 1024).toFixed(0)} KB，pedia ${(pedia / 1024).toFixed(0)} KB）`,
    );
    expect(on.season.ti).toBe(16);
    expect(at10.on).toBeGreaterThan(0);
    expect(at10.off).toBeGreaterThan(0);
    expect(g10).toBeLessThanOrEqual(0.25);
    expect(g16).toBeLessThanOrEqual(0.3);
    // 时间：只设宽松上限（机器差异大）；逐局记录约 10~20µs
    expect(tOn).toBeLessThan(Math.max(tOff * 1.6, tOff + 8000));
  }, 240000);
});
