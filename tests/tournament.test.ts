import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GameState, Tournament, TournamentFormatPreset, TournamentTier } from '../src/engine/types';
import { makeTestState } from './helpers';

// ---------------------------------------------------------------------------
// 依赖模块桩：强者必胜的确定性系列赛；战队评分 = 首发战力之和
// ---------------------------------------------------------------------------
vi.mock('../src/engine/team', () => ({
  teamRating: (state: GameState, id: string) => {
    const t = state.teams[id];
    if (!t) return 0;
    let s = 0;
    for (const pos of ['C', 'M', 'O', 'SS', 'HS'] as const) {
      const pid = t.lineup[pos];
      const p = pid ? state.players[pid] : undefined;
      if (p) s += p.power;
    }
    return s;
  },
}));
vi.mock('../src/engine/match', () => {
  const rating = (state: GameState, id: string) => {
    const t = state.teams[id];
    let s = 0;
    for (const pid of Object.values(t?.lineup ?? {})) if (pid && state.players[pid]) s += state.players[pid].power;
    return s;
  };
  return {
    simulateSeries: (state: GameState, series: { id: string; teamA: string; teamB: string; bestOf: number }) => {
      const a = series.teamA;
      const b = series.teamB;
      let ra = rating(state, a);
      let rb = rating(state, b);
      if ((globalThis as { __chaos?: boolean }).__chaos) {
        // 爆冷模式：按系列赛 id 哈希决定胜负（含 Bo2 平局）
        let h = 0;
        for (const ch of series.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        ra = h % 3;
        rb = (h >> 3) % 3;
      }
      const need = Math.floor(series.bestOf / 2) + 1;
      if (series.bestOf === 2) {
        if (ra === rb) return { winnerId: a, loserId: b, scoreA: 1, scoreB: 1, games: [] };
        return ra > rb
          ? { winnerId: a, loserId: b, scoreA: 2, scoreB: 0, games: [] }
          : { winnerId: b, loserId: a, scoreA: 0, scoreB: 2, games: [] };
      }
      return ra >= rb
        ? { winnerId: a, loserId: b, scoreA: need, scoreB: need - 1, games: [] }
        : { winnerId: b, loserId: a, scoreA: need - 1, scoreB: need, games: [] };
    },
    applySeriesLoyalty: () => {},
  };
});
vi.mock('../src/engine/economy', () => ({
  addFinance: (state: GameState, teamId: string, amount: number) => {
    const t = state.teams[teamId];
    if (t) t.gold += Math.round(amount);
  },
  econ: () => 1,
  econIndex: () => 1,
}));
vi.mock('../src/engine/growth', () => ({
  applyTournamentGrowth: () => [],
  adjustLoyalty: (p: { loyalty: number }, d: number) => { p.loyalty = Math.max(0, Math.min(100, p.loyalty + d)); },
}));
vi.mock('../src/engine/market', () => ({ releaseTempSubs: () => {} }));

import {
  advanceTournamentUntilPlayer, finishTournament, initTournamentStages, isTeamEliminated, playerNextSeries,
  pointsForPlacement, prizeForPlacement, readySeries, recordSeriesResult, simulateTournamentToEnd,
  standardBracketOrder,
} from '../src/engine/tournament';
import { simulateSeries } from '../src/engine/match';
import { CONFIG } from '../src/engine/config';
import { awardedPrizePool, tournamentAppearanceFee } from '../src/engine/revenue';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function makeTournament(
  state: GameState,
  id: string,
  format: TournamentFormatPreset,
  teamIds: string[],
  opts: { tier?: TournamentTier; prize?: number; quals?: string[]; slots?: number } = {},
): Tournament {
  const t: Tournament = {
    id, seriesId: `${id}-series`, name: `测试赛 ${id}`, tier: opts.tier ?? 'major', season: 9, roundIndex: 1,
    startDate: '2018-10-01', city: '测试城', hostRegion: 'EU', online: false, prizePool: opts.prize ?? 1_000_000,
    appearanceFee: 0, format, teamIds: teamIds.slice(), invitedTeamIds: [], qualifierTeamIds: (opts.quals ?? []).slice(),
    stages: [], series: {}, status: 'scheduled', placements: [], playerStatus: 'open', minHonor: 0,
    qualifierSlots: opts.slots,
  };
  state.tournaments[id] = t;
  return t;
}

/** 名次互不重叠、并列区间人数 = 区间宽度、连续覆盖 1..total */
function expectContiguous(t: Tournament, total: number): void {
  const ids = new Set(t.placements.map((p) => p.teamId));
  expect(ids.size).toBe(t.placements.length);
  expect(t.placements.length).toBe(total);
  const byRange = new Map<string, number>();
  for (const p of t.placements) {
    expect(p.rankFrom).toBeGreaterThanOrEqual(1);
    expect(p.rankTo).toBeGreaterThanOrEqual(p.rankFrom);
    const k = `${p.rankFrom}-${p.rankTo}`;
    byRange.set(k, (byRange.get(k) ?? 0) + 1);
  }
  const covered = new Array(total + 1).fill(0);
  for (const [k, c] of byRange) {
    const [f, to] = k.split('-').map(Number);
    expect(c, `区间 ${k} 人数`).toBe(to - f + 1);
    for (let r = f; r <= to; r++) covered[r]++;
  }
  for (let r = 1; r <= total; r++) expect(covered[r], `名次 ${r}`).toBe(1);
}

function strongest(state: GameState, ids: string[]): string {
  return ids.slice().sort((a, b) => state.players[`${b}-C`].power - state.players[`${a}-C`].power)[0];
}

function run(state: GameState, t: Tournament): void {
  initTournamentStages(state, t.id);
  simulateTournamentToEnd(state, t.id);
}

const FORMATS: TournamentFormatPreset[] = ['se8', 'de8', 'gsl_de8', 'groups_de', 'groups_se', 'rr', 'ti'];

// ---------------------------------------------------------------------------
describe('standardBracketOrder', () => {
  it('8 强种子对阵 1v8 4v5 2v7 3v6', () => {
    expect(standardBracketOrder(8)).toEqual([0, 7, 3, 4, 1, 6, 2, 5]);
    expect(standardBracketOrder(1)).toEqual([0]);
    expect(standardBracketOrder(4)).toEqual([0, 3, 1, 2]);
  });
});

describe('赛制：所有规模的名次完整且连续', () => {
  for (const format of FORMATS) {
    it(`${format}：2..24 队`, () => {
      for (let n = 2; n <= 24; n++) {
        const state = makeTestState(n, 1000 + n);
        const ids = Object.keys(state.teams);
        const t = makeTournament(state, `${format}-${n}`, format, ids);
        run(state, t);
        expect(t.stages.every((s) => s.done), `${format}/${n} 阶段完成`).toBe(true);
        expect(Object.values(t.series).every((s) => !!s.result), `${format}/${n} 全部比赛已赛`).toBe(true);
        expectContiguous(t, n);
        const champ = t.placements.find((p) => p.rankFrom === 1);
        expect(champ?.rankTo).toBe(1);
        expect(champ?.teamId, `${format}/${n} 冠军为最强队`).toBe(strongest(state, ids));
        expect(isTeamEliminated(state, t.id, ids[0])).toBe(true);
      }
    });
  }
});

describe('爆冷/平局 + 封闭预选：任意规模不卡死、名次连续', () => {
  it('全部赛制 × 正赛 2..20 × 预选 0..9 队', () => {
    (globalThis as { __chaos?: boolean }).__chaos = true;
    try {
      for (const format of FORMATS) {
        for (let d = 2; d <= 20; d += 3) {
          for (const q of [0, 1, 3, 5, 9]) {
            for (const slots of [1, 2, 3]) {
              const state = makeTestState(d + q, d * 100 + q * 7 + slots);
              const ids = Object.keys(state.teams);
              const t = makeTournament(state, `c-${format}-${d}-${q}-${slots}`, format, ids.slice(0, d), {
                quals: ids.slice(d), slots,
              });
              run(state, t);
              const tag = `${format} d=${d} q=${q} slots=${slots}`;
              expect(t.stages.every((s) => s.done), tag).toBe(true);
              expect(Object.values(t.series).every((s) => !!s.result), tag).toBe(true);
              expectContiguous(t, d + q);
              finishTournament(state, t.id);
              expect(t.status, tag).toBe('finished');
            }
          }
        }
      }
    } finally {
      (globalThis as { __chaos?: boolean }).__chaos = false;
    }
  });
});

describe('单败', () => {
  it('8 队：1/2/3-4/5-8', () => {
    const state = makeTestState(8);
    const t = makeTournament(state, 'se', 'se8', Object.keys(state.teams), { tier: 'premier' });
    run(state, t);
    const ranges = t.placements.map((p) => `${p.rankFrom}-${p.rankTo}`).sort();
    expect(ranges).toEqual(['1-1', '2-2', '3-4', '3-4', '5-8', '5-8', '5-8', '5-8']);
    const final = Object.values(t.series).find((s) => !s.winnerTo);
    expect(final?.label).toBe('决赛');
    expect(final?.bestOf).toBe(3);
  });
  it('6 队有轮空：头号种子直接进入第二轮，且不生成轮空比赛', () => {
    const state = makeTestState(6);
    const t = makeTournament(state, 'se6', 'se8', Object.keys(state.teams));
    initTournamentStages(state, t.id);
    expect(Object.keys(t.series).length).toBe(5); // n-1 场真实比赛
    const r1 = Object.values(t.series).filter((s) => s.round === 1);
    expect(r1.length).toBe(2);
    expect(r1.every((s) => s.teamA && s.teamB)).toBe(true);
    simulateTournamentToEnd(state, t.id);
    expectContiguous(t, 6);
  });
  it('Major 决赛 Bo5', () => {
    const state = makeTestState(4);
    const t = makeTournament(state, 'mj', 'se8', Object.keys(state.teams), { tier: 'major' });
    initTournamentStages(state, t.id);
    const final = Object.values(t.series).find((s) => !s.winnerTo);
    expect(final?.bestOf).toBe(5);
  });
});

describe('双败', () => {
  it('8 队：败者组逐轮名次 + 总决赛', () => {
    const state = makeTestState(8);
    const t = makeTournament(state, 'de', 'de8', Object.keys(state.teams), { tier: 'premier' });
    initTournamentStages(state, t.id);
    expect(Object.keys(t.series).length).toBe(2 * 8 - 2); // 无复活赛重置：2n-2 场
    const gf = Object.values(t.series).find((s) => s.label === '总决赛');
    expect(gf).toBeTruthy();
    expect(gf?.loserPlacement).toEqual([2, 2]);
    simulateTournamentToEnd(state, t.id);
    const ranges = t.placements.map((p) => `${p.rankFrom}-${p.rankTo}`).sort();
    expect(ranges).toEqual(['1-1', '2-2', '3-3', '4-4', '5-6', '5-6', '7-8', '7-8']);
  });
  it('胜者组败者掉入败者组', () => {
    const state = makeTestState(8);
    const t = makeTournament(state, 'de2', 'de8', Object.keys(state.teams));
    initTournamentStages(state, t.id);
    const ub1 = Object.values(t.series).filter((s) => s.label.startsWith('胜者组') && s.round === 1);
    expect(ub1.length).toBe(4);
    expect(ub1.every((s) => !!s.loserTo && !s.loserPlacement)).toBe(true);
  });
});

describe('TI 赛制', () => {
  it('18 队：两组 Bo2 → 胜者组 8 + 败者组首轮 8(Bo1) → 总决赛 Bo5', () => {
    const state = makeTestState(18);
    const t = makeTournament(state, 'ti9', 'ti', Object.keys(state.teams), { tier: 'ti', prize: 30_000_000 });
    initTournamentStages(state, t.id);
    const groups = t.stages[0];
    expect(groups.type).toBe('groups');
    expect(groups.groups?.length).toBe(2);
    expect(groups.groups?.map((g) => g.teamIds.length)).toEqual([9, 9]);
    expect(groups.seriesIds.every((id) => t.series[id].bestOf === 2)).toBe(true);
    simulateTournamentToEnd(state, t.id);
    const playoffs = t.stages[1];
    const lb1 = playoffs.seriesIds.map((id) => t.series[id]).filter((s) => s.label === '败者组第1轮');
    expect(lb1.length).toBe(4);
    expect(lb1.every((s) => s.bestOf === 1)).toBe(true);
    const gf = playoffs.seriesIds.map((id) => t.series[id]).find((s) => s.label === '总决赛');
    expect(gf?.bestOf).toBe(5);
    const ranges = t.placements.map((p) => `${p.rankFrom}-${p.rankTo}`);
    const count = (r: string) => ranges.filter((x) => x === r).length;
    expect(count('1-1')).toBe(1);
    expect(count('3-3')).toBe(1);
    expect(count('4-4')).toBe(1);
    expect(count('5-6')).toBe(2);
    expect(count('7-8')).toBe(2);
    expect(count('9-12')).toBe(4);
    expect(count('13-16')).toBe(4);
    expect(count('17-18')).toBe(2);
    expectContiguous(t, 18);
  });
});

describe('小组循环', () => {
  it('Bo2 平局计积分，排名按积分', () => {
    const state = makeTestState(4);
    // 全部战力相同 → 所有 Bo2 都是平局
    for (const p of Object.values(state.players)) p.power = 70;
    const t = makeTournament(state, 'rr4', 'rr', Object.keys(state.teams), { tier: 'minor' });
    run(state, t);
    const g = t.stages[0].groups![0];
    expect(g.standings.every((s) => s.draws === 3 && s.wins === 0)).toBe(true);
    expectContiguous(t, 4);
  });
  it('8 队以上非 TI 小组改 Bo1（组内 ≥7 队）', () => {
    const state = makeTestState(8);
    const t = makeTournament(state, 'rr8', 'rr', Object.keys(state.teams), { tier: 'minor' });
    initTournamentStages(state, t.id);
    expect(Object.values(t.series).every((s) => s.bestOf === 1)).toBe(true);
    expect(Object.keys(t.series).length).toBe(28);
  });
});

describe('封闭预选', () => {
  it('6 直邀 + 8 队预选（2 个名额）→ 正赛 8 队，预选淘汰者排 9-14', () => {
    const state = makeTestState(14);
    const ids = Object.keys(state.teams);
    const qualFinal = ids.slice(0, 8); // 8 支较弱队伍打预选
    const directFinal = ids.slice(8); // 6 支直邀
    const t = makeTournament(state, 'q', 'se8', directFinal, { quals: qualFinal, slots: 2 });
    initTournamentStages(state, t.id);
    expect(t.stages[0].type).toBe('qualifier');
    const qs = t.stages[0].seriesIds.map((id) => t.series[id]);
    expect(qs.length).toBe(6); // 8 → 2：6 场
    expect(qs.filter((s) => s.label === '预选赛 晋级战').every((s) => s.bestOf === 3)).toBe(true);
    expect(qs.filter((s) => s.label !== '预选赛 晋级战').every((s) => s.bestOf === 1)).toBe(true);
    simulateTournamentToEnd(state, t.id);
    expect(t.teamIds.length).toBe(8);
    expectContiguous(t, 14);
    const qualLosers = t.placements.filter((p) => p.rankFrom > 8);
    expect(qualLosers.length).toBe(6);
    expect(qualLosers.every((p) => qualFinal.includes(p.teamId))).toBe(true);
  });
  it('预选队伍不超过名额时直接进入正赛', () => {
    const state = makeTestState(8);
    const ids = Object.keys(state.teams);
    const t = makeTournament(state, 'q2', 'de8', ids.slice(0, 6), { quals: ids.slice(6), slots: 2 });
    initTournamentStages(state, t.id);
    expect(t.stages.some((s) => s.type === 'qualifier')).toBe(false);
    expect(t.teamIds.length).toBe(8);
    expect(t.qualifierTeamIds).toEqual([]);
  });
});

describe('推进与玩家比赛', () => {
  it('advanceTournamentUntilPlayer 在玩家比赛就绪时停下', () => {
    const state = makeTestState(8);
    const t = makeTournament(state, 'adv', 'se8', Object.keys(state.teams));
    initTournamentStages(state, t.id);
    advanceTournamentUntilPlayer(state, t.id);
    const mine = playerNextSeries(state, t.id);
    expect(mine).toBeTruthy();
    expect(mine?.round).toBe(1);
    // 其他首轮比赛已打完（更晚轮次的 AI 比赛等待玩家）
    const others = readySeries(state, t.id).filter((s) => s !== mine && s.round <= mine!.round);
    expect(others.length).toBe(0);
    expect(Object.values(t.series).filter((s) => s.round === 1 && s.result).length).toBe(3);
    // 玩家（最弱）输掉 → 其余比赛全部模拟
    const res = simulateSeries(state, mine!, t.tier, false);
    recordSeriesResult(state, t.id, mine!.id, res);
    expect(isTeamEliminated(state, t.id, 't0')).toBe(true);
    advanceTournamentUntilPlayer(state, t.id);
    expect(t.stages.every((s) => s.done)).toBe(true);
  });
  it('重复写入同一系列赛结果被忽略', () => {
    const state = makeTestState(4);
    const t = makeTournament(state, 'dup', 'se8', Object.keys(state.teams));
    initTournamentStages(state, t.id);
    const s = readySeries(state, t.id)[0];
    const res = simulateSeries(state, s, t.tier, false);
    recordSeriesResult(state, t.id, s.id, res);
    const placements = t.placements.length;
    recordSeriesResult(state, t.id, s.id, res);
    expect(t.placements.length).toBe(placements);
  });
});

describe('奖金与积分', () => {
  it('全部名次奖金之和 ≈ 奖金池（2..24 队）', () => {
    for (let n = 2; n <= 24; n++) {
      for (const format of ['se8', 'de8', 'ti'] as TournamentFormatPreset[]) {
        const state = makeTestState(n, 77 + n);
        const t = makeTournament(state, `p${n}${format}`, format, Object.keys(state.teams), { prize: 1_234_567 });
        run(state, t);
        let total = 0;
        for (const p of t.placements) total += prizeForPlacement(t.prizePool, n, p.rankFrom, p.rankTo);
        expect(Math.abs(total - 1_234_567), `${format}/${n}`).toBeLessThanOrEqual(n);
      }
    }
  });
  it('并列区间平分；超出队伍数为 0', () => {
    const pool = 1_000_000;
    const shares = CONFIG.tournament.prizeShare[8];
    expect(prizeForPlacement(pool, 8, 1, 1)).toBe(Math.round(pool * shares[0]));
    expect(prizeForPlacement(pool, 8, 5, 8)).toBe(Math.round((pool * (shares[4] + shares[5] + shares[6] + shares[7])) / 4));
    expect(prizeForPlacement(pool, 8, 9, 9)).toBe(0);
    expect(prizeForPlacement(0, 8, 1, 1)).toBe(0);
    // 6 队用 8 队表前 6 项归一化
    const s6 = shares.slice(0, 6);
    const sum6 = s6.reduce((a, b) => a + b, 0);
    expect(prizeForPlacement(pool, 6, 1, 1)).toBe(Math.round((pool * s6[0]) / sum6));
  });
  it('积分 = 冠军积分 × 区间比例 / 冠军比例', () => {
    expect(pointsForPlacement('major', 8, 1, 1)).toBe(CONFIG.tournament.championPoints.major);
    const s = CONFIG.tournament.prizeShare[8];
    expect(pointsForPlacement('major', 8, 2, 2)).toBe(Math.round((CONFIG.tournament.championPoints.major * s[1]) / s[0]));
    expect(pointsForPlacement('ti', 8, 1, 1)).toBe(0);
  });
});

describe('finishTournament', () => {
  let state: GameState;
  beforeEach(() => {
    state = makeTestState(8);
  });
  it('发奖、积分、history、玩家结算与弹窗', () => {
    const ids = Object.keys(state.teams);
    const t = makeTournament(state, 'fin', 'de8', ids, { tier: 'major', prize: 1_000_000 });
    t.appearanceFee = 5000;
    const goldBefore = Object.fromEntries(ids.map((id) => [id, state.teams[id].gold]));
    run(state, t);
    finishTournament(state, t.id);
    expect(t.status).toBe('finished');
    const champ = t.placements.find((p) => p.rankFrom === 1)!;
    expect(champ.teamId).toBe('t7');
    expect(champ.points).toBe(CONFIG.tournament.championPoints.major);
    expect(state.teams.t7.points).toBe(champ.points);
    // 出场费开赛时按赛事等级重算（revenue.tournamentAppearanceFee），覆盖赛程预估值
    expect(t.appearanceFee).toBe(tournamentAppearanceFee(state, t));
    // 第九波奖金分成：俱乐部只拿 (1 − 分成比例) 的奖金，出场费全归俱乐部
    const share = state.teams.t7.prizeShare!;
    expect(share).toBeGreaterThanOrEqual(CONFIG.prizeShare.min);
    expect(share).toBeLessThanOrEqual(CONFIG.prizeShare.max);
    expect(state.teams.t7.gold - goldBefore.t7).toBe(champ.prize - Math.round(champ.prize * share) + t.appearanceFee);
    // 发放压缩后的游戏内奖金池（revenue.awardedPrizePool），全部名次合计 ≈ 奖池
    const pool = awardedPrizePool(state, t);
    expect(pool).toBeGreaterThan(0);
    const totalPrize = t.placements.reduce((a, p) => a + p.prize, 0);
    expect(Math.abs(totalPrize - pool)).toBeLessThanOrEqual(8);
    expect(t.placements.every((p) => p.prize > 0)).toBe(true);
    // 冠军选手头衔
    expect(state.players['t7-C'].stats.titles).toBe(1);
    // history
    const h = state.history.tournaments.at(-1)!;
    expect(h.tournamentId).toBe('fin');
    expect(h.championId).toBe('t7');
    expect(Object.keys(h.placements).length).toBe(8);
    expect(h.placements.t0[2]).toBe(8);
    // 玩家结算
    expect(t.settlement).toBeTruthy();
    // 奖金分成：结算记录俱乐部 / 队员两部分，战报新闻同样给出拆分
    const st = t.settlement!;
    expect(st.prizeClub! + st.prizePlayers!).toBe(st.prize);
    expect(st.prizeShare).toBe(state.teams.t0.prizeShare);
    expect(state.news.some((n) => n.title.includes('战罢') && n.body.includes('俱乐部') && n.body.includes('队员'))).toBe(true);
    expect(state.history.playerSettlements.length).toBe(1);
    expect(state.popups.some((p) => p.kind === 'tournament_settlement')).toBe(true);
    expect(state.news.some((n) => n.title.includes('战罢'))).toBe(true);
    // 幂等
    finishTournament(state, t.id);
    expect(state.history.tournaments.length).toBe(1);
  });
  it('未开赛也可直接结算（自动初始化并模拟）', () => {
    const t = makeTournament(state, 'auto', 'se8', Object.keys(state.teams), { tier: 'minor' });
    finishTournament(state, t.id);
    expect(t.status).toBe('finished');
    expectContiguous(t, 8);
  });
  it('TI 预选：前 N 名写入 TI 名单并更新玩家 TI 状态', () => {
    // 让玩家最强，必然出线
    for (const pos of ['C', 'M', 'O', 'SS', 'HS']) state.players[`t0-${pos}`].power = 99;
    const tiT = makeTournament(state, 'ti-9', 'ti', [], { tier: 'ti' });
    tiT.playerStatus = 'locked';
    const q = makeTournament(state, 'tiq-9-CN', 'de8', Object.keys(state.teams), { tier: 'qualifier', prize: 0 });
    q.advanceToTi = { tiId: 'ti-9', slots: 2 };
    run(state, q);
    finishTournament(state, q.id);
    expect(tiT.teamIds.length).toBe(2);
    expect(tiT.teamIds).toContain('t0');
    expect(tiT.playerStatus).toBe('invited');
    // 赛区预选不计冠军头衔；不发「问鼎/0 奖金」的夺冠新闻（由晋级新闻代替）；结算新闻不罗列 0 奖金/0 积分
    expect(state.players['t0-C'].stats.titles).toBe(0);
    expect(state.news.some((n) => n.title.includes('问鼎'))).toBe(false);
    expect(state.news.some((n) => n.title.includes('闯关成功'))).toBe(true);
    const fin = state.news.find((n) => n.title.includes('战罢'))!;
    expect(fin.body).not.toContain('奖金 0');
    expect(fin.body).toContain('荣誉');
  });
  it('清除选手本赛事的不可用标记', () => {
    state.players['t1-C'].unavailableTournamentIds = ['visa-t', 'other'];
    const t = makeTournament(state, 'visa-t', 'se8', Object.keys(state.teams));
    run(state, t);
    finishTournament(state, t.id);
    expect(state.players['t1-C'].unavailableTournamentIds).toEqual(['other']);
  });
});
