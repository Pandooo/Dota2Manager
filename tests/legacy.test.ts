// 生涯总结 / 传奇值（src/engine/legacy.ts，第八波 #7）：历史参照表与 tis.json 一致、传奇值排序、称号与历史俱乐部匹配、
// 赛季档案记录、整局集成（生涯期满 / 解散 / 禁赛三种结局）
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, LegacySeasonRecord, OpResult, TiInfo } from '../src/engine/types';
import * as M from '../src/engine/multi';
import tisJson from '../src/data/tis.json';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import {
  backToBackCount, clubStats, computeAllLegacyReports, computeLegacyReport, legacyClubs, legacyEndingOf, legacyRecordsOf,
  legacyScore, legacyTitleOf, matchHistoricalClub, recordLegacyPartial, recordLegacySeason, strengthPoints,
  type LegacyStats,
} from '../src/engine/legacy';
import { banClub } from '../src/engine/scandal';
import { advance, createNewGame, fillLineupWithTempSubs, getAdvanceBlockers, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { applyHonorChange } from '../src/engine/honor';
import { makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const TIS = tisJson as unknown as TiInfo[];
const club = (id: string) => legacyClubs().find((c) => c.id === id)!;
const histScore = (id: string) => legacyScore(clubStats(club(id)), { history: true }).total;

function stats(over: Partial<LegacyStats> = {}): LegacyStats {
  const s: LegacyStats = {
    tiTitles: [], tiRunnerUp: [], tiTop4: [], tiTop8: [], tiAppearances: 0, backToBack: 0, majors: 0, premiers: 0, minors: 0,
    seasons: 5, strength: [], topSeasons: 0, honorPeak: null, ...over,
  };
  s.backToBack = over.backToBack ?? backToBackCount(s.tiTitles);
  return s;
}

describe('legacy · 历史俱乐部参照表（事实数据）', () => {
  it('规模 20–31 家；字段自洽', () => {
    const clubs = legacyClubs();
    expect(clubs.length).toBeGreaterThanOrEqual(20);
    expect(clubs.length).toBeLessThanOrEqual(31);
    for (const c of clubs) {
      const placed = [...c.tiTitles, ...c.tiRunnerUp, ...c.tiTop4, ...c.tiTop8];
      expect(new Set(placed).size).toBe(placed.length);
      expect(placed.length).toBeLessThanOrEqual(c.tiAppearances);
      for (const ti of placed) {
        expect(ti).toBeGreaterThanOrEqual(c.firstTi);
        expect(ti).toBeLessThanOrEqual(c.lastTi);
      }
      expect(c.majorList.length).toBe(c.majors);
    }
    // Valve Major 2015–2023 共 28 届，表中冠军数之和不超过 28
    expect(clubs.reduce((a, c) => a + c.majors, 0)).toBeLessThanOrEqual(28);
  });

  it('与 src/data/tis.json 交叉校验：每届冠军 / 亚军恰好对应表中一家俱乐部', () => {
    const clubs = legacyClubs();
    for (const info of TIS) {
      if (info.projected || !info.champion) continue;
      const champs = clubs.filter((c) => c.tiTitles.includes(info.ti));
      expect(champs, `TI${info.ti} 冠军`).toHaveLength(1);
      expect(champs[0].teamIds).toContain(info.champion);
      const ru = clubs.filter((c) => c.tiRunnerUp.includes(info.ti));
      expect(ru.length, `TI${info.ti} 亚军`).toBeLessThanOrEqual(1);
      if (info.runnerUp) {
        expect(ru, `TI${info.ti} 亚军 ${info.runnerUp}`).toHaveLength(1);
        expect(ru[0].teamIds).toContain(info.runnerUp);
      }
    }
    // 表中的冠军 / 亚军也都能在 tis.json 中找到
    for (const c of clubs) {
      for (const ti of c.tiTitles) expect(c.teamIds).toContain(TIS.find((t) => t.ti === ti)?.champion);
      for (const ti of c.tiRunnerUp) expect(c.teamIds).toContain(TIS.find((t) => t.ti === ti)?.runnerUp);
    }
  });

  it('代表性事实：Spirit 三冠（TI10/TI12/TI15）、OG 两连冠（TI8/TI9）、Liquid 两冠（TI7/TI13）', () => {
    expect(club('team-spirit').tiTitles).toEqual([10, 12, 15]);
    expect(club('og').tiTitles).toEqual([8, 9]);
    expect(club('team-liquid').tiTitles).toEqual([7, 13]);
    for (const id of ['natus-vincere', 'invictus-gaming', 'alliance', 'newbee', 'evil-geniuses', 'wings-gaming', 'tundra-esports', 'team-falcons']) {
      expect(club(id).tiTitles, id).toHaveLength(1);
    }
  });
});

describe('legacy · 传奇值与称号', () => {
  it('历史排行：三冠 > 两冠 > 单冠；多冠王朝高于任何单冠 / 无冠俱乐部', () => {
    expect(histScore('team-spirit')).toBeGreaterThan(histScore('og'));
    expect(histScore('team-spirit')).toBeGreaterThan(histScore('team-liquid'));
    const multi = ['team-spirit', 'og', 'team-liquid'].map(histScore);
    const others = legacyClubs().filter((c) => c.tiTitles.length < 2).map((c) => histScore(c.id));
    expect(Math.min(...multi)).toBeGreaterThan(Math.max(...others));
    // 单冠王者 > 同样只进过一次总决赛的无冕之王
    expect(histScore('wings-gaming')).toBeGreaterThan(histScore('digital-chaos'));
  });

  it('单调：其余相同时，多一个 TI 冠军 > 多一个亚军 > 多一次前四 > 多一次前八；禁赛折半', () => {
    const base = stats({ tiAppearances: 4, tiTop8: [3] });
    const s0 = legacyScore(base).total;
    const withTitle = legacyScore(stats({ ...base, tiTitles: [5], tiAppearances: 5 })).total;
    const withFinal = legacyScore(stats({ ...base, tiRunnerUp: [5], tiAppearances: 5 })).total;
    const withTop4 = legacyScore(stats({ ...base, tiTop4: [5], tiAppearances: 5 })).total;
    const withTop8 = legacyScore(stats({ ...base, tiTop8: [3, 5], tiAppearances: 5 })).total;
    expect(withTitle).toBeGreaterThan(withFinal);
    expect(withFinal).toBeGreaterThan(withTop4);
    expect(withTop4).toBeGreaterThan(withTop8);
    expect(withTop8).toBeGreaterThan(s0);
    const t1 = legacyScore(stats({ tiTitles: [5] })).total;
    const t2 = legacyScore(stats({ tiTitles: [5, 7] })).total;
    const t3 = legacyScore(stats({ tiTitles: [5, 7, 9] })).total;
    expect(t3 - t2).toBeGreaterThan(t2 - t1); // 逐冠递增
    expect(legacyScore(stats({ tiTitles: [5, 6] })).total).toBeGreaterThan(t2); // 卫冕加成
    const banned = legacyScore(stats({ tiTitles: [5, 7] }), { banned: true });
    expect(banned.total).toBeCloseTo(t2 * 0.5, 0);
  });

  it('动态平衡：只有实力没有奖杯（16 个赛季战力第一）也不会压过单冠王者', () => {
    const strongOnly = stats({ strength: Array.from({ length: 16 }, (_, i) => ({ ti: i + 1, rank: 1, teams: 30 })), topSeasons: 16, seasons: 16 });
    const sc = legacyScore(strongOnly);
    expect(sc.strength).toBeLessThan(sc.strengthRaw);
    expect(sc.total).toBeLessThan(histScore('wings-gaming'));
    // 联盟规模归一：30 队第 1 与 10 队第 1 同分；30 队第 15 名不如 10 队第 3 名
    expect(strengthPoints(1, 30)).toBe(strengthPoints(1, 10));
    expect(strengthPoints(15, 30)).toBeLessThan(strengthPoints(3, 10));
  });

  it('称号：与历史俱乐部同一判定', () => {
    const t = (id: string) => legacyTitleOf(clubStats(club(id))).name;
    expect(t('team-spirit')).toBe('三冠王朝');
    expect(t('og')).toBe('两连冠王朝');
    expect(t('team-liquid')).toBe('双冠豪门');
    expect(t('wings-gaming')).toBe('单冠王者');
    expect(t('gaimin-gladiators')).toBe('亚军之王');
    expect(t('lgd')).toBe('亚军之王');
    expect(t('team-secret')).toBe('常青豪门');
    expect(t('virtus-pro')).toBe('常青豪门');
    expect(t('digital-chaos')).toBe('无冕之王');
    expect(t('fnatic')).toBe('一时劲旅');
    expect(t('mousesports')).toBe('默默无闻');
    expect(legacyTitleOf(stats({ tiTitles: [1, 3, 5, 7] })).name).toBe('不朽神话');
  });

  it('最接近的历史俱乐部：按称号与成就距离匹配', () => {
    const m = (s: LegacyStats) => matchHistoricalClub(s, legacyScore(s).total)?.club.id;
    expect(m(stats({ tiTitles: [3, 6, 9], tiAppearances: 6 }))).toBe('team-spirit');
    expect(m(stats({ tiTitles: [4, 5], tiAppearances: 6, majors: 4 }))).toBe('og');
    expect(m(stats({ tiTitles: [4, 9], tiRunnerUp: [6], tiTop4: [7, 8], tiAppearances: 10 }))).toBe('team-liquid');
    expect(m(stats({ tiTitles: [2], tiRunnerUp: [3, 4], tiAppearances: 6 }))).toBe('natus-vincere');
    expect(m(stats({ tiTitles: [6], tiAppearances: 1 }))).toBe('wings-gaming');
    expect(m(stats({ tiRunnerUp: [5, 6], majors: 3, tiAppearances: 3 }))).toBe('gaimin-gladiators');
    expect(m(stats({ tiTop8: [2, 3, 4, 5, 6], majors: 5, tiAppearances: 7 }))).toBe('virtus-pro');
    expect(m(stats({ tiAppearances: 3 }))).toBe('mousesports');
    // 四冠以上：现实中无同类，退回全表最接近的（三冠的 Spirit）
    expect(m(stats({ tiTitles: [1, 2, 3, 4], tiAppearances: 6 }))).toBe('team-spirit');
  });
});

// ---------------------------------------------------------------------------
// 报告（构造的存档）
// ---------------------------------------------------------------------------

function tiEntry(season: number, ranks: Record<string, [number, number]>) {
  const n = 16;
  return {
    tournamentId: `ti-${season}`, seriesId: 'ti', name: `The International ${season}`, tier: 'ti' as const, season,
    championId: Object.keys(ranks).find((k) => ranks[k][0] === 1 && ranks[k][1] === 1) ?? '',
    placements: Object.fromEntries(Object.entries(ranks).map(([k, v]) => [k, [v[0], v[1], n] as [number, number, number]])),
  };
}

function rec(ti: number, over: Partial<LegacySeasonRecord> = {}): LegacySeasonRecord {
  return {
    ti, year: 2010 + ti, strengthRank: 2, strengthTeams: 30, finalRank: 2, tiRank: null, tiTeams: 16, titles: [],
    honorEnd: 500, goldEnd: 100000, moments: [], squad: [{ id: 'ghost-1', handle: 'Ace', position: 'C', rating: 88, tier: 'SS' }], ...over,
  };
}

describe('legacy · 报告', () => {
  it('由全局赛事史与档案计算：TI 名次、Major、排行榜插入名次、时间线、最佳选手', () => {
    const state = makeTestState(6);
    state.history.tournaments.push(
      tiEntry(9, { t0: [1, 1], t1: [2, 2] }),
      tiEntry(10, { t0: [1, 1], t1: [3, 4] }),
      { tournamentId: 'm1', seriesId: 'm', name: 'Some Major', tier: 'major', season: 9, championId: 't0', placements: {} },
      { tournamentId: 'p1', seriesId: 'p', name: 'Some Premier', tier: 'premier', season: 10, championId: 't0', placements: {} },
      { tournamentId: 'q1', seriesId: 'q', name: 'Qualifier', tier: 'qualifier', season: 10, championId: 't0', placements: {} },
    );
    state.legacyLog = { t0: [rec(9, { tiRank: [1, 1], strengthRank: 1, moments: ['TI9 夺冠，捧起不朽盾'] }), rec(10, { tiRank: [1, 1] })] };
    state.season.ti = 10;
    state.gameOver = { reason: 'completed', summary: '' };
    const r = computeLegacyReport(state, 't0');
    expect(r.ending).toBe('completed');
    expect(r.stats.tiTitles).toEqual([9, 10]);
    expect(r.stats.backToBack).toBe(1);
    expect(r.stats.majors).toBe(1);
    expect(r.stats.premiers).toBe(1);
    expect(r.title.name).toBe('两连冠王朝');
    expect(r.match?.club.id).toBe('og');
    expect(r.timeline.map((x) => x.tiLabel)).toEqual(['冠军', '冠军']);
    expect(r.moments[0].text).toContain('TI9');
    expect(r.bestPlayers[0]).toMatchObject({ handle: 'Ace', seasons: 2, tiTitles: 2, status: 'unknown' }); // 档案中的选手已不在存档：用记录的 ID
    // 排行榜：本俱乐部插入其名次，名次 = 比它高分的俱乐部数 + 1
    const self = r.board.find((x) => x.kind === 'self')!;
    expect(r.rank).toBe(r.board.filter((x) => x.score > self.score).length + 1);
    expect(r.boardSize).toBe(legacyClubs().length + 1);
  });

  it('结局：生涯期满 / 解散 / 禁赛', () => {
    const s1 = makeTestState(4);
    s1.gameOver = { reason: 'completed', summary: '' };
    expect(legacyEndingOf(s1, 't0')).toBe('completed');
    const s2 = makeTestState(4);
    applyHonorChange(s2, 't0', -(s2.teams.t0.honor + 5), '测试', true);
    expect(legacyEndingOf(s2, 't0')).toBe('disbanded');
    const r2 = computeLegacyReport(s2, 't0');
    expect(r2.epilogue.join('')).toContain('解散');
    // 单机赛季中解散：当季的部分记录标记结局，且不沿用上赛季的积分榜名次
    expect(r2.timeline[r2.timeline.length - 1]).toMatchObject({ partial: true, ending: 'disbanded', finalRank: 0 });
    const s3 = makeTestState(4);
    banClub(s3, 't0');
    const r3 = computeLegacyReport(s3, 't0');
    expect(r3.ending).toBe('banned');
    expect(r3.ban?.players.length).toBe(5);
    expect(r3.epilogue.join('')).toContain('操纵比赛');
    expect(r3.score.mult).toBe(0.5);
  });

  it('档案记录：赛季记录幂等；出局冻结后不再追加当前赛季', () => {
    const state = makeTestState(4);
    recordLegacySeason(state, 't0');
    recordLegacySeason(state, 't0');
    expect(state.legacyLog!.t0).toHaveLength(1);
    expect(state.legacyLog!.t0[0].squad).toHaveLength(5);
    expect(state.legacyLog!.t0[0].strengthTeams).toBe(4);
    state.season.ti = 10;
    state.roundIndex = 3;
    expect(legacyRecordsOf(state, 't0').map((r) => r.ti)).toEqual([9, 10]); // 当季未结算：补一条部分赛季
    recordLegacyPartial(state, 't0', 'disbanded');
    recordLegacyPartial(state, 't0', 'banned'); // 已冻结：不覆盖
    expect(state.legacyLog!.t0.map((r) => [r.ti, r.ending ?? null])).toEqual([[9, null], [10, 'disbanded']]);
    state.season.ti = 11;
    expect(legacyRecordsOf(state, 't0').map((r) => r.ti)).toEqual([9, 10]);
  });

  it('旧存档：档案之前的赛季由赛季总结补齐；损坏的档案记录被丢弃 / 补齐字段', () => {
    const state = makeTestState(4);
    state.settings.startTi = 7;
    state.history.seasons.push(
      { ti: 7, year: 2017, finalRank: 3, playerTiRank: [5, 6], playerTitles: ['Old Cup'], honorEnd: 300, goldEnd: 1000 } as unknown as GameState['history']['seasons'][number],
      { ti: 8, year: 2018, finalRank: 2, playerTiRank: null, playerTitles: [], honorEnd: 350, goldEnd: 2000 } as unknown as GameState['history']['seasons'][number],
    );
    state.legacyLog = { t0: [rec(8), rec(9, { titles: undefined as unknown as LegacySeasonRecord['titles'] }), null as unknown as LegacySeasonRecord] };
    state.gameOver = { reason: 'completed', summary: '' };
    const recs = legacyRecordsOf(state, 't0');
    expect(recs.map((r) => r.ti)).toEqual([7, 8, 9]); // TI7 来自赛季总结；TI8 以档案为准
    expect(recs[0].tiRank).toEqual([5, 6]);
    expect(recs[2].titles).toEqual([]);
    expect(() => computeLegacyReport(state, 't0')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 整局集成
// ---------------------------------------------------------------------------

function step(g: GameState): void {
  for (let i = 0; i < 20 && g.pendingDecisions.length; i++) {
    const d = g.pendingDecisions[0];
    if (!resolveDecision(g, d.id, d.choices[0]?.id ?? '').ok) g.pendingDecisions.shift();
  }
  for (let i = 0; i < 5; i++) {
    const bl = getAdvanceBlockers(g);
    if (!bl.length) break;
    if (bl.some((b) => b.code === 'lineup_invalid')) fillLineupWithTempSubs(g);
    quickSimTournament(g);
  }
  advance(g);
}

describe('legacy · 整局集成', () => {
  it('多人：TI 回合结束时荣誉跌破 0 出局 → 档案记在出局赛季（含 TI 成绩），不会多出下赛季的空记录', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 11, difficulty: 'normal', mode: 'build', seed: 11,
      players: [
        { sessionId: 's0', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    const call = (id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
    const prepare = () => {
      for (let pass = 0; pass < 4; pass++) {
        for (const id of M.activeHumanIds(g)) {
          for (let i = 0; i < 20; i++) {
            const d = M.withSeat(g, id, () => g.pendingDecisions[0]);
            if (!d) break;
            if (!call(id, 'resolveDecision', d.id, d.choices[0]?.id ?? '').ok) M.withSeat(g, id, () => g.pendingDecisions.shift());
          }
          call(id, 'fillLineupWithTempSubs');
          call(id, 'quickSimTournament');
        }
      }
      for (const id of M.activeHumanIds(g)) M.setSeatReady(g, id, true);
    };
    const last = g.season.rounds.length - 1;
    for (let i = 0; i < 40 && !(g.season.ti === 9 && g.roundIndex === last); i++) {
      prepare();
      M.advanceMultiplayer(g);
    }
    expect(g.season.ti).toBe(9);
    expect(g.roundIndex).toBe(last);
    prepare();
    // 模拟 TI 回合结束时（endRound 内）荣誉跌破 0：出局标记已打上，但出局收尾要等本次推进（含赛季结算、新赛季开始）之后
    applyHonorChange(g, B, -(g.teams[B].honor + 5), '测试', true);
    expect(g.multiplayer!.seats[B].eliminated).toBe(true);
    expect(M.advanceMultiplayer(g).ok).toBe(true);
    expect(g.season.ti).toBe(10);
    const log = g.legacyLog?.[B] ?? [];
    expect(log.map((r) => [r.ti, r.ending ?? null])).toEqual([[9, 'disbanded']]);
    expect(log[0].squad.length).toBeGreaterThanOrEqual(5); // 阵容在选手离队前记录
    const r = computeLegacyReport(M.seatView(g, B), B);
    expect(r.ending).toBe('disbanded');
    expect(r.endTi).toBe(9);
    // 仍在比赛的座位照常记录
    expect((g.legacyLog?.[A] ?? []).map((x) => x.ti)).toEqual([9]);
  }, 60_000);

  it('完整一个赛季：赛季结算写入档案，结算页报告可算、排行榜含全部历史俱乐部', async () => {
    const g = await createNewGame({ startTi: 8, seasons: 1, difficulty: 'normal', managerName: 'T', teamId: 'og', seed: 21 });
    for (let i = 0; i < 60 && !g.gameOver; i++) step(g);
    expect(g.gameOver?.reason).toBe('completed');
    const log = g.legacyLog?.og ?? [];
    expect(log).toHaveLength(1);
    expect(log[0].ti).toBe(8);
    expect(log[0].strengthRank).toBeGreaterThanOrEqual(1);
    expect(log[0].squad.length).toBeGreaterThanOrEqual(5);
    const r = computeLegacyReport(g, 'og');
    expect(r.seasonsPlayed).toBe(1);
    expect(r.timeline[0].tiChampion).not.toBeNull();
    expect(r.board.filter((x) => x.kind === 'history')).toHaveLength(legacyClubs().length);
    expect(r.honorCurve.length).toBeGreaterThan(5);
    expect(computeAllLegacyReports(g)).toHaveLength(1);
  }, 30_000);
});
