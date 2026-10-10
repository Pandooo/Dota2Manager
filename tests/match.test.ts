import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/engine/team', async () => (await import('./engineMocks')).teamMock);
vi.mock('../src/engine/player', async () => (await import('./engineMocks')).playerMock);

import {
  applySeriesLoyalty, computeWinProb, eraMatchBaseline, rollIncidents, seriesOutcome, simulateGame, simulateSeries,
} from '../src/engine/match';
import { applyDraftAction, createDraft, currentStep, runDraftUntil } from '../src/engine/draft';
import { heroName } from '../src/engine/heroes';
import { CONFIG } from '../src/engine/config';
import type { GameState, Series } from '../src/engine/types';
import { makeTestState } from './helpers';
import { setTeamAttr } from './engineMocks';

function series(teamA: string | null, teamB: string | null, bestOf: Series['bestOf']): Series {
  return { id: 's1', tournamentId: 'x', stageId: 'st', label: '测试', teamA, teamB, bestOf, round: 1 };
}

function lineupIds(s: GameState, teamId: string): string[] {
  return Object.values(s.teams[teamId].lineup).filter((x): x is string => !!x);
}

describe('match: 系列赛判定', () => {
  it('Bo1 / Bo2 / Bo3 / Bo5', () => {
    expect(seriesOutcome(1, 0, 0)).toBeNull();
    expect(seriesOutcome(1, 1, 0)).toBe('A');
    expect(seriesOutcome(1, 0, 1)).toBe('B');
    expect(seriesOutcome(2, 1, 0)).toBeNull(); // Bo2 两局都要打
    expect(seriesOutcome(2, 2, 0)).toBe('A');
    expect(seriesOutcome(2, 0, 2)).toBe('B');
    expect(seriesOutcome(2, 1, 1)).toBe('draw');
    expect(seriesOutcome(3, 1, 1)).toBeNull();
    expect(seriesOutcome(3, 2, 1)).toBe('A');
    expect(seriesOutcome(3, 0, 2)).toBe('B');
    expect(seriesOutcome(5, 2, 2)).toBeNull();
    expect(seriesOutcome(5, 3, 2)).toBe('A');
    expect(seriesOutcome(5, 1, 3)).toBe('B');
  });
});

describe('match: 胜率', () => {
  it('同等实力 + 大老师 50% → 50%', () => {
    const s = makeTestState(2);
    setTeamAttr(s, 't1', 'power', 70);
    setTeamAttr(s, 't0', 'power', 70);
    const r = computeWinProb(s, 't0', 't1', 0.5, []);
    expect(r.strengthA).toBe(350); // 使用测试替身（5 × 70），不依赖 team.ts 实现
    expect(r.share).toBeCloseTo(0.5, 6);
    expect(r.pWin).toBeCloseTo(0.5, 6);
  });

  it('随实力单调递增，并夹在 [finalMin, finalMax]', () => {
    const s = makeTestState(2);
    setTeamAttr(s, 't1', 'power', 75);
    let prev = -1;
    for (const pw of [50, 60, 70, 75, 80, 90, 110]) {
      setTeamAttr(s, 't0', 'power', pw);
      const r = computeWinProb(s, 't0', 't1', 0.5, []);
      expect(r.pWin).toBeGreaterThanOrEqual(prev);
      expect(r.pWin).toBeGreaterThanOrEqual(CONFIG.match.finalMin);
      expect(r.pWin).toBeLessThanOrEqual(CONFIG.match.finalMax);
      prev = r.pWin;
    }
    setTeamAttr(s, 't0', 'power', 75);
    const lo = computeWinProb(s, 't0', 't1', 0.3, []).pWin;
    const hi = computeWinProb(s, 't0', 't1', 0.7, []).pWin;
    expect(hi).toBeGreaterThan(lo);
  });

  it('局内事件只影响对应战队；空阵容不崩溃', () => {
    const s = makeTestState(2);
    setTeamAttr(s, 't0', 'power', 75);
    setTeamAttr(s, 't1', 'power', 75);
    const bad = [{ minute: 5, playerId: 't0-C', teamId: 't0', text: 'x', powerMult: 0.8 }];
    const r = computeWinProb(s, 't0', 't1', 0.5, bad);
    expect(r.strengthA).toBeLessThan(r.strengthB);
    expect(r.pWin).toBeLessThan(0.5);
    const ghost = computeWinProb(s, 't0', 'nobody', 0.5, []);
    expect(ghost.share).toBe(1);
    expect(ghost.pWin).toBeLessThanOrEqual(CONFIG.match.finalMax);
  });
});

describe('match: 局内突发事件', () => {
  it('每局 0~2 个，幅度受韧性缩放，文本含选手 ID', () => {
    const s = makeTestState(2, 7);
    const [lo, hi] = CONFIG.match.incidentPowerRange;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const inc = rollIncidents(s, 't0', 't1');
      expect(inc.length).toBeLessThanOrEqual(2);
      total += inc.length;
      for (const e of inc) {
        const p = s.players[e.playerId];
        expect(e.text).toContain(p.handle);
        expect(e.teamId).toBe(p.teamId);
        expect(e.powerMult).toBeGreaterThanOrEqual(1 + lo * 1.2 - 1e-9);
        expect(e.powerMult).toBeLessThanOrEqual(1 + hi * 1.2 + 1e-9);
      }
      if (inc.length === 2) expect(inc[0].playerId).not.toBe(inc[1].playerId);
    }
    expect(total).toBeGreaterThan(100);
    // 高韧性 → 影响小
    setTeamAttr(s, 't0', 'resilience', 150);
    setTeamAttr(s, 't1', 'resilience', 150);
    for (let i = 0; i < 100; i++) {
      for (const e of rollIncidents(s, 't0', 't1')) expect(Math.abs(e.powerMult - 1)).toBeLessThanOrEqual(Math.max(-lo, hi) * 0.2 + 1e-3);
    }
    // 没有选手的队伍
    s.teams.t0.lineup = { C: null, M: null, O: null, SS: null, HS: null };
    s.teams.t1.lineup = { C: null, M: null, O: null, SS: null, HS: null };
    expect(rollIncidents(s, 't0', 't1')).toEqual([]);
  });
});

describe('match: 单局模拟', () => {
  it('AI 对 AI 走快速路径：无 BP/直播，数据正确更新', () => {
    const s = makeTestState(3, 11);
    const before = Object.fromEntries(Object.values(s.players).map((p) => [p.id, { ...p.stats }]));
    const g = simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: 0, withLive: false, tier: 'minor' });
    expect(g.draft).toEqual([]);
    expect(g.live).toEqual([]);
    expect(g.radiant).toBe('A');
    expect(g.durationMin).toBeGreaterThanOrEqual(CONFIG.match.durationRange[0]);
    expect(g.durationMin).toBeLessThanOrEqual(CONFIG.match.durationRange[1]);
    expect(g.killsA + g.killsB).toBeGreaterThanOrEqual(CONFIG.match.killsRange[0]);
    expect(g.killsA + g.killsB).toBeLessThanOrEqual(CONFIG.match.killsRange[1]);
    const winTeam = g.winner === 'A' ? 't1' : 't2';
    let mvps = 0;
    for (const t of ['t1', 't2']) {
      for (const pid of lineupIds(s, t)) {
        const st = s.players[pid].stats;
        expect(st.matches).toBe(before[pid].matches + 1);
        expect(st.wins).toBe(before[pid].wins + (t === winTeam ? 1 : 0));
        mvps += st.mvp - before[pid].mvp;
      }
    }
    expect(mvps).toBe(1);
    expect(lineupIds(s, winTeam)).toContain(g.mvpPlayerId);
    // 玩家队不受影响
    for (const pid of lineupIds(s, 't0')) expect(s.players[pid].stats.matches).toBe(0);
  });

  it('玩家比赛：完整 BP + 文字直播', () => {
    const s = makeTestState(2, 21);
    const g = simulateGame(s, { teamA: 't0', teamB: 't1', gameIndex: 1, withLive: true, tier: 'major' });
    expect(g.radiant).toBe('B');
    expect(g.draft).toHaveLength(20);
    expect(g.eval.notes.length).toBeGreaterThanOrEqual(2);
    expect(g.live.length).toBeGreaterThanOrEqual(25);
    const last = g.live[g.live.length - 1];
    expect(last.type).toBe('gg');
    expect([last.killsA, last.killsB]).toEqual([g.killsA, g.killsB]);
    expect(last.minute).toBe(g.durationMin);
    // 快速模拟玩家系列赛（无直播）也做完整 BP
    const q = simulateGame(s, { teamA: 't1', teamB: 't0', gameIndex: 0, withLive: false, tier: 'major' });
    expect(q.draft).toHaveLength(20);
    expect(q.live).toEqual([]);
  });

  it('使用传入的未完成 BP 并自动补完', () => {
    const s = makeTestState(2, 5);
    const d = createDraft(s);
    runDraftUntil(s, d, 't0', 't1', 'B');
    expect(d.done).toBe(false);
    const g = simulateGame(s, { teamA: 't0', teamB: 't1', gameIndex: 0, draft: d, withLive: false, tier: 'minor' });
    expect(d.done).toBe(true);
    expect(g.draft).toHaveLength(20);
    expect(g.draft[0].heroId).toBe(d.actions[0].heroId);
  });

  it('手动 BP（玩家为 A 方或 B 方）→ 本局使用该 BP，直播英雄与 BP 一致', () => {
    for (const side of ['A', 'B'] as const) {
      for (let seed = 1; seed <= 4; seed++) {
        const s = makeTestState(2, seed * 13);
        const d = createDraft(s);
        runDraftUntil(s, d, 't0', 't1', side);
        for (let i = 0; i < 40 && !d.done; i++) {
          expect(currentStep(d)?.side).toBe(side);
          applyDraftAction(s, d, d.available[(i * 7) % d.available.length], 't0', 't1');
          runDraftUntil(s, d, 't0', 't1', side);
        }
        expect(d.done).toBe(true);
        const g = simulateGame(s, { teamA: 't0', teamB: 't1', gameIndex: seed, draft: d, withLive: true, tier: 'premier' });
        expect(g.draft.map((a) => a.heroId)).toEqual(d.actions.map((a) => a.heroId));
        expect(g.radiant).toBe(seed % 2 === 0 ? 'A' : 'B');
        const text = g.live.map((e) => e.text).join('\n');
        const banned = g.draft.filter((a) => a.type === 'ban').map((a) => heroName(a.heroId));
        for (const b of banned) expect(text).not.toContain(`（${b}）`);
        // 选手只会以本方英雄出现
        for (const a of g.draft) {
          if (a.type !== 'pick' || !a.playerId) continue;
          const handle = s.players[a.playerId].handle;
          for (const o of g.draft) {
            if (o.type === 'pick' && o.heroId !== a.heroId) expect(text).not.toContain(`${handle}（${heroName(o.heroId)}）`);
          }
        }
      }
    }
  });

  it('突发事件的分钟落在本局时长内且按时间排序（与直播条目对应）', () => {
    const s = makeTestState(3, 99);
    let seen = 0;
    for (let i = 0; i < 300; i++) {
      const g = simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: i, withLive: i % 10 === 0, tier: 'minor' });
      for (let k = 0; k < g.incidents.length; k++) {
        const inc = g.incidents[k];
        seen++;
        expect(inc.minute).toBeGreaterThanOrEqual(2);
        expect(inc.minute).toBeLessThanOrEqual(g.durationMin - 3);
        if (k > 0) expect(inc.minute).toBeGreaterThanOrEqual(g.incidents[k - 1].minute);
        if (g.live.length) {
          expect(g.live.some((e) => e.type === 'incident' && Math.abs(e.minute - inc.minute) <= 1)).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('同一种子结果可复现', () => {
    const a = makeTestState(2, 777);
    const b = makeTestState(2, 777);
    const ga = simulateGame(a, { teamA: 't0', teamB: 't1', gameIndex: 0, withLive: true, tier: 'ti' });
    const gb = simulateGame(b, { teamA: 't0', teamB: 't1', gameIndex: 0, withLive: true, tier: 'ti' });
    expect(ga).toEqual(gb);
  });

  it('强队胜率更高；胜方击杀通常更多', () => {
    const s = makeTestState(3, 31);
    setTeamAttr(s, 't1', 'power', 85);
    setTeamAttr(s, 't2', 'power', 70);
    let strongWins = 0;
    let winnerMoreKills = 0;
    const N = 600;
    for (let i = 0; i < N; i++) {
      const g = simulateGame(s, { teamA: 't1', teamB: 't2', gameIndex: i, withLive: false, tier: 'minor' });
      if (g.winner === 'A') strongWins++;
      const [w, l] = g.winner === 'A' ? [g.killsA, g.killsB] : [g.killsB, g.killsA];
      if (w > l) winnerMoreKills++;
    }
    expect(strongWins / N).toBeGreaterThan(0.6);
    expect(winnerMoreKills / N).toBeGreaterThan(0.75);
  });

  it('残缺阵容 / 不存在的战队不崩溃', () => {
    const s = makeTestState(2);
    s.teams.t1.lineup.C = null;
    s.teams.t1.lineup.M = null;
    s.players['t0-HS'].status = 'banned';
    expect(() => simulateGame(s, { teamA: 't0', teamB: 't1', gameIndex: 0, withLive: true, tier: 'minor' })).not.toThrow();
    expect(() => simulateGame(s, { teamA: 't1', teamB: 'ghost', gameIndex: 0, withLive: false, tier: 'minor' })).not.toThrow();
    expect(() => simulateGame(s, { teamA: 't0', teamB: 'ghost', gameIndex: 0, withLive: true, tier: 'minor' })).not.toThrow();
  });

  it('快速路径性能：2000 局 AI 比赛足够快', () => {
    const s = makeTestState(8, 3);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      simulateGame(s, { teamA: `t${1 + (i % 7)}`, teamB: `t${1 + ((i + 3) % 7)}`, gameIndex: i % 3, withLive: false, tier: 'minor' });
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('match: 系列赛', () => {
  it('Bo1/Bo3/Bo5 打到分出胜负，天辉方交替', () => {
    const s = makeTestState(3, 41);
    for (const bo of [1, 3, 5] as const) {
      for (let k = 0; k < 10; k++) {
        const r = simulateSeries(s, series('t1', 't2', bo), 'minor', false);
        const need = Math.floor(bo / 2) + 1;
        expect(Math.max(r.scoreA, r.scoreB)).toBe(need);
        expect(r.games).toHaveLength(r.scoreA + r.scoreB);
        expect(r.winnerId).toBe(r.scoreA > r.scoreB ? 't1' : 't2');
        expect(r.loserId).toBe(r.scoreA > r.scoreB ? 't2' : 't1');
        r.games.forEach((g, i) => {
          expect(g.index).toBe(i);
          expect(g.radiant).toBe(i % 2 === 0 ? 'A' : 'B');
        });
      }
    }
  });

  it('Bo2 两局打满，可平局', () => {
    const s = makeTestState(3, 43);
    setTeamAttr(s, 't1', 'power', 75);
    setTeamAttr(s, 't2', 'power', 75);
    let draws = 0;
    for (let k = 0; k < 60; k++) {
      const r = simulateSeries(s, series('t1', 't2', 2), 'minor', false);
      expect(r.games).toHaveLength(2);
      if (r.scoreA === r.scoreB) {
        draws++;
        expect(r.winnerId).toBe('t1');
        expect(r.loserId).toBe('t2');
      } else {
        expect(r.winnerId).toBe(r.scoreA > r.scoreB ? 't1' : 't2');
      }
    }
    expect(draws).toBeGreaterThan(0);
  });

  it('一方空缺时另一方晋级；双方空缺抛错', () => {
    const s = makeTestState(2);
    const r = simulateSeries(s, series('t1', null, 3), 'minor', false);
    expect(r.winnerId).toBe('t1');
    expect(r.scoreA).toBe(2);
    expect(r.games).toEqual([]);
    expect(() => simulateSeries(s, series(null, null, 3), 'minor', false)).toThrow();
  });

  it('首发凑不齐 5 人的一方弃权判负（替补可顶上时不判负）', () => {
    const s = makeTestState(3, 49);
    // t2 只剩 4 名选手、无替补 → 弃权
    const gone = 't2-C';
    s.teams.t2.playerIds = s.teams.t2.playerIds.filter((x) => x !== gone);
    s.players[gone].teamId = null;
    s.teams.t2.lineup.C = null;
    for (const bo of [1, 2, 3, 5] as const) {
      const r = simulateSeries(s, series('t1', 't2', bo), 'minor', false);
      expect(r.forfeit).toBe('B');
      expect(r.winnerId).toBe('t1');
      expect(r.loserId).toBe('t2');
      expect(r.games).toEqual([]);
      expect(r.scoreA).toBe(bo === 2 ? 2 : Math.floor(bo / 2) + 1);
      expect(r.scoreB).toBe(0);
    }
    const flipped = simulateSeries(s, series('t2', 't1', 3), 'minor', false);
    expect(flipped).toMatchObject({ forfeit: 'A', winnerId: 't1', scoreA: 0, scoreB: 2 });
    // 首发位置空着但有可用替补：自动补位后正常比赛
    const bench = makeTestState(3, 50);
    bench.teams.t1.lineup.M = null;
    const ok = simulateSeries(bench, series('t1', 't2', 3), 'minor', false);
    expect(ok.forfeit).toBeUndefined();
    expect(ok.games.length).toBeGreaterThan(0);
  });

  it('玩家系列赛带直播', () => {
    const s = makeTestState(2, 47);
    const r = simulateSeries(s, series('t0', 't1', 3), 'major', true);
    for (const g of r.games) expect(g.live.length).toBeGreaterThanOrEqual(25);
  });
});

describe('match: 击杀 / 时长按年代标定（真实 TI 对局数据，CONFIG.match.eraByTi）', () => {
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];

  it('年代基准：按赛季 TI 取表，表外用默认值', () => {
    expect(eraMatchBaseline({ season: { ti: 8 } } as GameState)).toEqual({ duration: 39.5, kills: 54.1 });
    expect(eraMatchBaseline({ season: { ti: 3 } } as GameState)).toEqual({ duration: 35.9, kills: 35.9 });
    const def = { duration: CONFIG.match.eraDefault[0], kills: CONFIG.match.eraDefault[1] };
    expect(eraMatchBaseline({ season: { ti: 99 } } as GameState)).toEqual(def);
    expect(eraMatchBaseline(null)).toEqual(def);
  });

  it('平均总击杀 / 时长贴近该届 TI；早期击杀少、2018 年击杀多；长局击杀多、碾压局短且一边倒；单队 55 杀以上罕见', () => {
    const byEra: Record<number, number> = {};
    for (const ti of [3, 8, 13]) {
      const s = makeTestState(6, 900 + ti);
      s.season.ti = ti;
      [85, 80, 76, 73, 70, 66].forEach((pw, i) => setTeamAttr(s, `t${i}`, 'power', pw));
      const kills: number[] = [];
      const dur: number[] = [];
      const shortShare: number[] = [];
      const longShare: number[] = [];
      let team55 = 0;
      const N = 1500;
      for (let i = 0; i < N; i++) {
        const a = 1 + (i % 5);
        const b = 1 + ((i * 3 + 1) % 5);
        const g = simulateGame(s, { teamA: `t${a}`, teamB: `t${b === a ? (a % 5) + 1 : b}`, gameIndex: i, withLive: false, tier: 'premier' });
        const k = g.killsA + g.killsB;
        kills.push(k);
        dur.push(g.durationMin);
        const w = g.winner === 'A' ? g.killsA : g.killsB;
        const era = eraMatchBaseline(s);
        if (g.durationMin < era.duration * 0.75) shortShare.push(w / Math.max(1, k));
        if (g.durationMin > era.duration * 1.3) longShare.push(w / Math.max(1, k));
        if (Math.max(g.killsA, g.killsB) > 55) team55++;
      }
      const [d0, k0] = CONFIG.match.eraByTi[ti];
      expect(mean(kills)).toBeGreaterThan(k0 * 0.88);
      expect(mean(kills)).toBeLessThan(k0 * 1.12);
      expect(mean(dur)).toBeGreaterThan(d0 * 0.9);
      expect(mean(dur)).toBeLessThan(d0 * 1.1);
      // 右偏分布：真实 p10 ≈ 0.66×、p90 ≈ 1.4× 平均时长
      expect(pct(dur, 0.1)).toBeLessThan(d0 * 0.8);
      expect(pct(dur, 0.9)).toBeGreaterThan(d0 * 1.25);
      // 碾压局（短）一边倒、长局比分接近
      expect(mean(shortShare)).toBeGreaterThan(0.72);
      expect(mean(longShare)).toBeLessThan(0.62);
      expect(team55 / N).toBeLessThan(ti === 8 ? 0.06 : 0.02);
      byEra[ti] = mean(kills);
    }
    expect(byEra[3]).toBeLessThan(byEra[13]);
    expect(byEra[13]).toBeLessThan(byEra[8]);
  });
});

describe('match: 归属感', () => {
  it('胜方 +winSeries，负方 +loseSeries，平局不变，夹在 0..100', () => {
    const s = makeTestState(2);
    for (const pid of lineupIds(s, 't0')) s.players[pid].loyalty = 50;
    for (const pid of lineupIds(s, 't1')) s.players[pid].loyalty = 50;
    applySeriesLoyalty(s, { winnerId: 't0', loserId: 't1', scoreA: 2, scoreB: 1, games: [] });
    for (const pid of lineupIds(s, 't0')) expect(s.players[pid].loyalty).toBeCloseTo(50 + CONFIG.loyalty.winSeries, 6);
    for (const pid of lineupIds(s, 't1')) expect(s.players[pid].loyalty).toBeCloseTo(50 + CONFIG.loyalty.loseSeries, 6);
    applySeriesLoyalty(s, { winnerId: 't0', loserId: 't1', scoreA: 1, scoreB: 1, games: [] });
    for (const pid of lineupIds(s, 't0')) expect(s.players[pid].loyalty).toBeCloseTo(50 + CONFIG.loyalty.winSeries, 6);
    s.players['t0-C'].loyalty = 100;
    s.players['t1-C'].loyalty = 0;
    applySeriesLoyalty(s, { winnerId: 't0', loserId: 't1', scoreA: 1, scoreB: 0, games: [] });
    expect(s.players['t0-C'].loyalty).toBe(100);
    expect(s.players['t1-C'].loyalty).toBe(0);
  });
});
