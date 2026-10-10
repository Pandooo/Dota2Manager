import { describe, expect, it, vi } from 'vitest';
import type { GameState, Tournament } from '../src/engine/types';
import { makeTestState } from './helpers';

vi.mock('../src/engine/team', () => ({
  teamRating: (state: GameState, id: string) => {
    const t = state.teams[id];
    if (!t) return 0;
    let s = 0;
    for (const pid of Object.values(t.lineup)) if (pid && state.players[pid]) s += state.players[pid].power;
    return s;
  },
}));

import {
  applyBeefResult, calibratedPercentile, changeHonor, computeExpectedRanks, computeHonorBreakdown, expectationZeroSumShift,
  expectedRank, honorLuck,
} from '../src/engine/honor';
import { CONFIG } from '../src/engine/config';
import { placementPercentile } from '../src/engine/util';

/** 预期项参照（校准 + 零和平移），与 honor.computeHonorBreakdown 同口径 */
const calExp = (p: number, n: number) => Math.min(1, Math.max(0, calibratedPercentile(p, CONFIG.honor.expectationShrink) - expectationZeroSumShift(n)));
/** 同比/环比参照（校准） */
const calHist = (p: number) => calibratedPercentile(p, CONFIG.honor.historyShrink);

function makeT(state: GameState, over: Partial<Tournament> = {}): Tournament {
  const t: Tournament = {
    id: 'evt-2019', seriesId: 'evt', name: '测试 Major', tier: 'major', season: 9, roundIndex: 3, startDate: '2019-01-01',
    city: 'X', hostRegion: 'EU', online: false, prizePool: 1_000_000, appearanceFee: 0, format: 'de8',
    teamIds: Object.keys(state.teams), invitedTeamIds: [], qualifierTeamIds: [], stages: [], series: {},
    status: 'running', placements: [], playerStatus: 'invited', minHonor: 0, ...over,
  };
  state.tournaments[t.id] = t;
  return t;
}

describe('honorLuck', () => {
  it('log10(1 + honor/100)，夹在 [0, luckCap]', () => {
    expect(honorLuck(0)).toBe(0);
    expect(honorLuck(-500)).toBe(0);
    expect(honorLuck(900)).toBeCloseTo(1, 10);
    expect(honorLuck(1e9)).toBe(CONFIG.honor.luckCap);
    expect(honorLuck(Number.NaN)).toBe(0);
  });
});

describe('expectedRank', () => {
  it('按 评分 × 荣誉修正 排名（最强 = 1）', () => {
    const state = makeTestState(8);
    const t = makeT(state);
    expect(expectedRank(state, t, 't7')).toBe(1);
    expect(expectedRank(state, t, 't0')).toBe(8);
  });
  it('荣誉可以抬高同战力队伍的预期', () => {
    const state = makeTestState(2);
    for (const p of Object.values(state.players)) p.power = 70;
    state.teams.t0.honor = 2000;
    state.teams.t1.honor = 100;
    const t = makeT(state);
    expect(expectedRank(state, t, 't0')).toBe(1);
  });
  it('预选队在全部队伍中排名；直邀队在正赛规模内排名', () => {
    const state = makeTestState(10);
    const ids = Object.keys(state.teams);
    // 预选：t0..t3（较弱）；直邀：t4..t9；2 个名额 → 正赛 8 队
    const t = makeT(state, { teamIds: ids.slice(4), qualifierTeamIds: ids.slice(0, 4), qualifierSlots: 2 });
    const ranks = computeExpectedRanks(state, t);
    expect(ranks.t0).toBe(10);
    expect(ranks.t3).toBe(7);
    expect(ranks.t9).toBe(1);
    expect(ranks.t4).toBe(6); // 正赛池 = 6 直邀 + 预计晋级 t3、t2
    expect(Math.max(...ids.slice(4).map((id) => ranks[id]))).toBeLessThanOrEqual(8);
  });
});

describe('computeHonorBreakdown', () => {
  it('预期/同比/环比/名次奖励 按公式合成（未触及上限）', () => {
    const state = makeTestState(8);
    const t = makeT(state, { tier: 'minor', expectedRanks: { t1: 4 } });
    state.history.tournaments.push(
      { tournamentId: 'evt-2018', seriesId: 'evt', name: '去年', tier: 'major', season: 8, championId: 't5', placements: { t1: [5, 6, 8] } },
      { tournamentId: 'other', seriesId: 'other', name: '上一项', tier: 'minor', season: 9, championId: 't1', placements: { t1: [2, 2, 16] } },
    );
    const hb = computeHonorBreakdown(state, 't1', t, 1, 1, 8);
    const h = CONFIG.honor;
    const pAct = 0;
    const pExp = calExp(placementPercentile(4, 4, 8), 8);
    const pYoY = calHist(placementPercentile(5, 6, 8));
    const pMoM = calHist(placementPercentile(2, 2, 16));
    const raw = h.tierBase.minor * (h.wExp * (pExp - pAct) + h.wYoY * (pYoY - pAct) + h.wMoM * (pMoM - pAct) + h.placeBonus[1]);
    expect(Math.abs(raw)).toBeLessThan(h.maxDeltaByTier.minor);
    expect(hb.total).toBe(Math.round(raw));
    expect(hb.tierBase).toBe(h.tierBase.minor);
    expect(hb.expected).toBe(4);
    expect(hb.actual).toBe(1);
    expect(hb.placeBonus).toBe(h.placeBonus[1]);
    expect(hb.beef).toBe(0);
    expect(hb.expTerm).toBeCloseTo(h.wExp * pExp, 3);
    expect(hb.yoyTerm).toBeCloseTo(h.wYoY * pYoY, 3);
    expect(hb.momTerm).toBeCloseTo(h.wMoM * pMoM, 3);
  });
  it('单项赛事荣誉夹在 maxDeltaByTier 内，分项等比缩放后仍可加总为合计', () => {
    const h = CONFIG.honor;
    const state = makeTestState(16);
    // 爆冷夺冠：赛前预期垫底，上赛季同系列垫底，上一项赛事垫底
    const ti = makeT(state, { id: 'ti-9', seriesId: 'ti', tier: 'ti', expectedRanks: { t0: 16 } });
    state.history.tournaments.push(
      { tournamentId: 'ti-8', seriesId: 'ti', name: 'TI8', tier: 'ti', season: 8, championId: 't5', placements: { t0: [16, 16, 16] } },
      { tournamentId: 'prev', seriesId: 'prev', name: '上一项', tier: 'minor', season: 9, championId: 't5', placements: { t0: [8, 8, 8] } },
    );
    const up = computeHonorBreakdown(state, 't0', ti, 1, 1, 16);
    expect(up.total).toBe(h.maxDeltaByTier.ti);
    const sumUp = up.tierBase * (up.expTerm + up.yoyTerm + up.momTerm + up.placeBonus);
    expect(Math.abs(sumUp - up.total)).toBeLessThanOrEqual(1);
    expect(up.placeBonus).toBeLessThan(h.placeBonus[1]);
    // 大热出局：预期第 1，实际垫底
    const flopT = makeT(state, { id: 'major-x', seriesId: 'major-x', tier: 'major', expectedRanks: { t9: 1 } });
    const down = computeHonorBreakdown(state, 't9', flopT, 16, 16, 16);
    expect(down.total).toBeGreaterThanOrEqual(-h.maxDeltaByTier.major);
    expect(down.total).toBeLessThan(0);
    // 全等级：任意名次/预期组合都不超上限
    for (const tier of ['ti', 'major', 'premier', 'minor', 'qualifier'] as const) {
      const tt = makeT(state, { id: `cap-${tier}`, seriesId: `cap-${tier}`, tier, expectedRanks: {} });
      for (let exp = 1; exp <= 16; exp += 5) {
        for (let rank = 1; rank <= 16; rank += 3) {
          tt.expectedRanks = { t3: exp };
          const hb = computeHonorBreakdown(state, 't3', tt, rank, rank, 16);
          expect(Math.abs(hb.total)).toBeLessThanOrEqual(h.maxDeltaByTier[tier]);
        }
      }
    }
  });
  it('预期名次按实际并列档位取中点：垫底预期队伍落在垫底并列区间不再「输也加分」', () => {
    const state = makeTestState(16);
    const h = CONFIG.honor;
    // 14 队：1..8 正赛名次，9-10、11-14 为预选淘汰并列区间
    const ranges: [number, number][] = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 6], [5, 6], [7, 8], [7, 8], [9, 10], [9, 10], [11, 14], [11, 14], [11, 14], [11, 14]];
    const ids = Object.keys(state.teams).slice(0, 14);
    const t = makeT(state, { tier: 'minor', teamIds: ids, expectedRanks: { t13: 14, t12: 12, t9: 10, t0: 1 } });
    t.placements = ranges.map(([f, to], i) => ({ teamId: ids[i], rankFrom: f, rankTo: to, prize: 0, points: 0 }));
    const bottom = computeHonorBreakdown(state, 't13', t, 11, 14, 14);
    expect(bottom.expected).toBe(12.5);
    expect(bottom.actual).toBe(12.5);
    // 冷门半区不校准，只有零和平移带来的极小扣分（远小于旧版「输也加分」的幅度）
    expect(bottom.expTerm).toBeCloseTo(-h.wExp * expectationZeroSumShift(14), 3);
    expect(bottom.total).toBeLessThanOrEqual(0);
    expect(bottom.total).toBeGreaterThanOrEqual(-2);
    expect(computeHonorBreakdown(state, 't12', t, 11, 14, 14).total).toBeLessThanOrEqual(0);
    // 预期 9-10 档却止步 11-14 → 扣分；预期 9-10 档打进 5-6 → 加分
    const under = computeHonorBreakdown(state, 't9', t, 11, 14, 14);
    expect(under.expected).toBe(9.5);
    expect(under.total).toBe(Math.round(h.tierBase.minor * h.wExp * (calExp(placementPercentile(9, 10, 14), 14) - placementPercentile(11, 14, 14))));
    expect(under.total).toBeLessThan(0);
    expect(computeHonorBreakdown(state, 't9', t, 5, 6, 14).total).toBeGreaterThan(0);
    // 单一名次档位不受影响
    expect(computeHonorBreakdown(state, 't0', t, 1, 1, 14).expected).toBe(1);
  });
  it('无往期记录 → 同比/环比为 0；不达预期扣分', () => {
    const state = makeTestState(8);
    const t = makeT(state, { expectedRanks: { t7: 1 } });
    const hb = computeHonorBreakdown(state, 't7', t, 7, 8, 8);
    expect(hb.yoyTerm).toBe(0);
    expect(hb.momTerm).toBe(0);
    expect(hb.placeBonus).toBe(0);
    expect(hb.total).toBeLessThan(0);
    expect(hb.total).toBe(Math.round(CONFIG.honor.tierBase.major * CONFIG.honor.wExp * (calExp(0, 8) - placementPercentile(7, 8, 8))));
  });
  it('3-4 名并列取季军奖励，5-6 名无奖励，亚军单列', () => {
    const state = makeTestState(8);
    const t = makeT(state, { expectedRanks: { t3: 3 } });
    expect(computeHonorBreakdown(state, 't3', t, 3, 4, 8).placeBonus).toBe(CONFIG.honor.placeBonus[3]);
    expect(computeHonorBreakdown(state, 't3', t, 5, 6, 8).placeBonus).toBe(0);
    expect(computeHonorBreakdown(state, 't3', t, 2, 2, 8).placeBonus).toBe(CONFIG.honor.placeBonus[2]);
  });
  it('同比只取「同系列 + 上赛季」，环比跳过本赛事自身记录', () => {
    const state = makeTestState(4);
    const t = makeT(state, { expectedRanks: { t2: 2 } });
    state.history.tournaments.push(
      { tournamentId: 'evt-2017', seriesId: 'evt', name: '前年', tier: 'major', season: 7, championId: 't2', placements: { t2: [1, 1, 4] } },
      { tournamentId: 'evt-2019', seriesId: 'evt', name: '本赛事', tier: 'major', season: 9, championId: 't2', placements: { t2: [1, 1, 4] } },
    );
    const hb = computeHonorBreakdown(state, 't2', t, 2, 2, 4);
    expect(hb.yoyTerm).toBe(0);
    // 环比取到前年那条（跳过本赛事）
    expect(hb.momTerm).toBeCloseTo(CONFIG.honor.wMoM * (calHist(0) - placementPercentile(2, 2, 4)), 3);
  });
});

describe('computeHonorBreakdown · 第六波校准', () => {
  it('赛前大热（预期第 1）拿到亚军/季军不再扣分；冷门半区参照不变', () => {
    const state = makeTestState(16);
    const t = makeT(state, { tier: 'major', expectedRanks: { t15: 1, t0: 16 } });
    expect(computeHonorBreakdown(state, 't15', t, 2, 2, 16).total).toBeGreaterThan(0);
    expect(computeHonorBreakdown(state, 't15', t, 3, 3, 16).total).toBeGreaterThan(0);
    // 中游名次仍扣分
    expect(computeHonorBreakdown(state, 't15', t, 9, 9, 16).total).toBeLessThan(0);
    // 冷门参照未校准：预期垫底、打进中游照样加分
    expect(computeHonorBreakdown(state, 't0', t, 8, 8, 16).total).toBeGreaterThan(0);
    expect(calibratedPercentile(0.9, CONFIG.honor.expectationShrink)).toBeCloseTo(
      0.5 + CONFIG.honor.expectationShrink.underdog * 0.4, 6,
    );
  });

  it('预期项在一项赛事内近似零和（校准不额外抬高联盟荣誉）', () => {
    for (const n of [4, 8, 14, 16, 20]) {
      let sum = 0;
      for (let r = 1; r <= n; r++) {
        const p = placementPercentile(r, r, n);
        sum += calExp(p, n) - p;
      }
      expect(Math.abs(sum)).toBeLessThan(1e-9); // 精确零和（未触及 0/1 夹紧时）
    }
  });

  it('低荣誉减损：荣誉越低单项赛事扣分越少，加分不受影响', () => {
    const h = CONFIG.honor;
    const state = makeTestState(16);
    const t = makeT(state, { tier: 'premier', expectedRanks: { t3: 3 } });
    state.teams.t3.honor = 1000;
    const full = computeHonorBreakdown(state, 't3', t, 12, 12, 16);
    state.teams.t3.honor = 100;
    const low = computeHonorBreakdown(state, 't3', t, 12, 12, 16);
    expect(full.total).toBeLessThan(0);
    const k = h.lowHonorLossMinMult + (1 - h.lowHonorLossMinMult) * (100 / h.lowHonorLossRef);
    expect(low.total).toBe(Math.round(full.total * k));
    expect(Math.abs(low.tierBase * (low.expTerm + low.yoyTerm + low.momTerm + low.placeBonus) - low.total)).toBeLessThanOrEqual(1);
    // 加分不受荣誉高低影响
    state.teams.t3.honor = 1000;
    const winHigh = computeHonorBreakdown(state, 't3', t, 1, 1, 16).total;
    state.teams.t3.honor = 100;
    expect(computeHonorBreakdown(state, 't3', t, 1, 1, 16).total).toBe(winHigh);
  });
});

describe('changeHonor', () => {
  it('玩家：写新闻与 history；跌破 0 解散并结束游戏', () => {
    const state = makeTestState(4);
    state.teams.t0.honor = 20;
    changeHonor(state, 't0', 10, '测试加分');
    expect(state.teams.t0.honor).toBe(30);
    expect(state.news[0].body).toContain('测试加分');
    expect(state.history.honor.at(-1)?.value).toBe(30);
    // 同一回合多次变化只保留一个点（最后值）；换回合则新增
    changeHonor(state, 't0', 5, '再加分');
    expect(state.history.honor.length).toBe(1);
    expect(state.history.honor.at(-1)?.value).toBe(35);
    state.roundIndex = 1;
    changeHonor(state, 't0', -5, '扣分');
    expect(state.history.honor.length).toBe(2);
    changeHonor(state, 't0', -31, '假赛风波');
    expect(state.teams.t0.honor).toBe(-1);
    expect(state.teams.t0.disbanded).toBe(true);
    expect(state.gameOver?.reason).toBe('disbanded');
  });
  it('AI：荣誉最低夹到 aiMinHonor，不写新闻', () => {
    const state = makeTestState(4);
    state.teams.t1.honor = 50;
    changeHonor(state, 't1', -500, '丑闻');
    expect(state.teams.t1.honor).toBe(CONFIG.honor.aiMinHonor);
    expect(state.news.length).toBe(0);
    expect(state.gameOver).toBeNull();
  });
});

describe('applyBeefResult', () => {
  it('仅对本赛季宿敌生效', () => {
    const state = makeTestState(4);
    state.teams.t0.honor = 100;
    state.beefs.push({ teamId: 't1', season: 9, winHonor: 7, loseHonor: -5 });
    state.beefs.push({ teamId: 't2', season: 8, winHonor: 7, loseHonor: -5 });
    expect(applyBeefResult(state, 't0', 't1')).toBe(7);
    expect(state.teams.t0.honor).toBe(107);
    expect(applyBeefResult(state, 't1', 't0')).toBe(-5);
    expect(state.teams.t0.honor).toBe(102);
    expect(applyBeefResult(state, 't0', 't2')).toBe(0);
    expect(applyBeefResult(state, 't1', 't3')).toBe(0);
  });
});
