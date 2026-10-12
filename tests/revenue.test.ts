// 第五波经济重做：奖金压缩、出场费、经常性收入（赞助 / 直播与内容 / 周边）、起始资金
import { describe, it, expect } from 'vitest';
import type { GameState, Tournament, TournamentTier } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import {
  econIndex, estimateNewClubStart, estimateNewClubStartingFunds, newClubGachaGrant, newClubStartingFunds, payRoundSalaries,
  realClubStartingFunds, roundWageBill,
} from '../src/engine/economy';
import {
  activeMerchBoosts, applyResultMerchBoosts, awardedPrize, awardedPrizePool, payTeamRevenue, payoutShare,
  qualifierAppearanceFee, remainingPaidRounds, roundRevenue, seasonProjection, sponsorContract, sponsorQuote,
  streamingIncome, tournamentAppearanceFee,
} from '../src/engine/revenue';
import { makePlayer, makeTestState } from './helpers';

function makeT(
  state: GameState,
  id: string,
  tier: TournamentTier,
  prizePool: number,
  over: Partial<Tournament> = {},
): Tournament {
  const t: Tournament = {
    id,
    seriesId: id,
    name: id,
    tier,
    season: state.season.ti,
    roundIndex: 1,
    startDate: '2018-10-01',
    city: '测试城',
    hostRegion: 'EU',
    online: false,
    prizePool,
    appearanceFee: 0,
    format: 'de8',
    teamIds: [],
    invitedTeamIds: [],
    qualifierTeamIds: [],
    stages: [],
    series: {},
    status: 'scheduled',
    placements: [],
    playerStatus: 'open',
    minHonor: 0,
    size: 8,
    ...over,
  };
  state.tournaments[id] = t;
  state.seasonTournamentIds.push(id);
  return t;
}

/** 给赛季配上 21 个回合（0 = 赛季初，1..20 付薪） */
function withRounds(state: GameState, n = 21): GameState {
  state.season.rounds = Array.from({ length: n }, (_, i) => ({
    index: i,
    phase: i === 0 ? 'preseason' : i === n - 1 ? 'ti' : i === n - 2 ? 'ti_qualifier' : 'regular',
    startDate: '2018-09-01',
    endDate: '2018-09-15',
    tournamentIds: [],
    patchVersions: [],
  }));
  return state;
}

describe('奖金压缩（awardedPrizePool）', () => {
  it('无奖金赛事为 0；TI 众筹奖池被大幅压缩但仍随真实奖池单调', () => {
    const s = makeTestState(4);
    expect(awardedPrizePool(s, makeT(s, 'zero', 'qualifier', 0))).toBe(0);
    const small = awardedPrizePool(s, makeT(s, 'ti-a', 'ti', 1_600_000, { season: 9 }));
    const big = awardedPrizePool(s, makeT(s, 'ti-b', 'ti', 40_000_000, { season: 9 }));
    expect(big).toBeGreaterThanOrEqual(small);
    // 真实奖池相差 25 倍，发放最多相差 tiMultRange 上下限之比
    const [lo, hi] = CONFIG.economy.prize.tiMultRange;
    expect(big / small).toBeLessThanOrEqual(hi / lo + 1e-9);
    // TI 冠军奖金（约 45%，队员 + 俱乐部合计）≈ 3~4.5 倍顶级战队年工资（econ=1 时顶级战队年工资约 90 万）；
    // 第九波起俱乐部只拿 (1 − 奖金分成)：默认 50% 分成（2026-10-10）时俱乐部约 1.5~2.2 倍年工资（第九波 QA 放大奖金池前为 2~3 倍全归俱乐部）
    const champ = awardedPrize(s, s.tournaments['ti-b'], 18, 1, 1);
    expect(champ).toBeGreaterThan(2_700_000);
    expect(champ).toBeLessThan(4_100_000);
    expect(champ * (1 - CONFIG.prizeShare.initial)).toBeGreaterThan(1_300_000);
    expect(champ * (1 - CONFIG.prizeShare.initial)).toBeLessThan(2_100_000);
  });

  it('同赛季同等级按真实奖池相对大小浮动，等级越高奖池越大', () => {
    const s = makeTestState(4);
    const m1 = makeT(s, 'major-a', 'major', 1_000_000);
    const m2 = makeT(s, 'major-b', 'major', 3_000_000);
    const p1 = makeT(s, 'premier-a', 'premier', 300_000);
    const mn = makeT(s, 'minor-a', 'minor', 100_000);
    const a = awardedPrizePool(s, m1);
    const b = awardedPrizePool(s, m2);
    expect(b).toBeGreaterThan(a);
    expect(b / a).toBeLessThan(3); // 幂次压缩：3 倍真实奖池 → 不到 3 倍发放
    expect(a).toBeGreaterThan(awardedPrizePool(s, p1));
    expect(awardedPrizePool(s, p1)).toBeGreaterThan(awardedPrizePool(s, mn));
  });

  it('赛季总预算归一：赛事越多，单项赛事发放越少（总额受控）', () => {
    const few = makeTestState(4);
    const many = makeTestState(4);
    for (let i = 0; i < 2; i++) makeT(few, `m${i}`, 'major', 1_000_000);
    for (let i = 0; i < 12; i++) makeT(many, `m${i}`, 'major', 1_000_000);
    const one = awardedPrizePool(few, few.tournaments.m0);
    const oneMany = awardedPrizePool(many, many.tournaments.m0);
    expect(oneMany).toBeLessThan(one);
    const total = Object.values(many.tournaments).reduce((a, t) => a + awardedPrizePool(many, t), 0);
    const p = CONFIG.economy.prize;
    // 赛季系数有下限（seasonScaleRange[0]）：总额 ≤ max(预算, 权重之和 × 下限)
    const cap = Math.max(p.seasonBudget, 12 * p.anchorPool.major * p.seasonScaleRange[0]);
    expect(total).toBeLessThanOrEqual(cap * 1.01);
    expect(total).toBeLessThan(12 * p.anchorPool.major * 0.5);
  });

  it('按赛季年份的经济指数缩放；线上公开赛按固定游戏内奖池', () => {
    const s = makeTestState(4);
    const t19 = makeT(s, 'ti-9', 'ti', 30_000_000, { season: 9 });
    const t3 = makeT(s, 'ti-3', 'ti', 30_000_000, { season: 3 });
    expect(awardedPrizePool(s, t3) / awardedPrizePool(s, t19)).toBeCloseTo(econIndex(2013) / econIndex(2019), 2);
    const filler = makeT(s, 'online-open-ti9-1', 'minor', 50_000, { seriesId: 'online-open-1' });
    expect(awardedPrizePool(s, filler)).toBeGreaterThan(0);
  });

  it('线上公开赛：奖池始终低于同赛季的典型 Minor，赛事多的赛季同步缩水，不计入赛季预算', () => {
    const light = makeTestState(4);
    const heavy = makeTestState(4);
    makeT(light, 'minor-a', 'minor', 100_000);
    makeT(heavy, 'minor-a', 'minor', 100_000);
    for (let i = 0; i < 12; i++) makeT(heavy, `major-${i}`, 'major', 1_000_000);
    const fl = makeT(light, 'online-open-x-1', 'minor', 50_000, { seriesId: 'online-open-1' });
    const fh = makeT(heavy, 'online-open-x-1', 'minor', 50_000, { seriesId: 'online-open-1' });
    expect(awardedPrizePool(light, fl)).toBeLessThan(awardedPrizePool(light, light.tournaments['minor-a']));
    expect(awardedPrizePool(heavy, fh)).toBeLessThan(awardedPrizePool(heavy, heavy.tournaments['minor-a']));
    expect(awardedPrizePool(heavy, fh)).toBeLessThan(awardedPrizePool(light, fl));
    // 公开赛本身不影响其他赛事的发放
    const before = awardedPrizePool(light, light.tournaments['minor-a']);
    for (let i = 2; i < 10; i++) makeT(light, `online-open-x-${i}`, 'minor', 50_000, { seriesId: `online-open-${i}` });
    expect(awardedPrizePool(light, light.tournaments['minor-a'])).toBe(before);
  });

  it('名次比例：全部名次之和 = 1，正赛每个名次都有奖金；TI 保持原表', () => {
    for (const n of [4, 8, 12, 16, 18, 20]) {
      let sum = 0;
      for (let r = 1; r <= n; r++) {
        const sh = payoutShare(n, r, r, 'major');
        expect(sh).toBeGreaterThan(0);
        sum += sh;
      }
      expect(sum).toBeCloseTo(1, 6);
      // 区间平分
      expect(payoutShare(n, 3, 4, 'major')).toBeCloseTo((payoutShare(n, 3, 3, 'major') + payoutShare(n, 4, 4, 'major')) / 2, 9);
      expect(payoutShare(n, n + 1, n + 1, 'major')).toBe(0);
    }
    const table = CONFIG.tournament.prizeShare[18];
    const total = table.reduce((a, b) => a + b, 0);
    expect(payoutShare(18, 1, 1, 'ti')).toBeCloseTo(table[0] / total, 9);
    // flatten 让第一名比例低于原表
    expect(payoutShare(16, 1, 1, 'major')).toBeLessThan(CONFIG.tournament.prizeShare[16][0]);
  });

  it('出场费按等级 × 经济指数；封闭预选出局补贴；无奖金赛事为 0', () => {
    const s = makeTestState(4);
    const ti = makeT(s, 'ti-x', 'ti', 30_000_000);
    const major = makeT(s, 'major-x', 'major', 1_000_000);
    const minor = makeT(s, 'minor-x', 'minor', 100_000);
    expect(tournamentAppearanceFee(s, ti)).toBe(CONFIG.economy.appearanceByTier.ti);
    expect(tournamentAppearanceFee(s, major)).toBeGreaterThan(tournamentAppearanceFee(s, minor));
    expect(qualifierAppearanceFee(s, minor)).toBeLessThan(tournamentAppearanceFee(s, minor));
    expect(qualifierAppearanceFee(s, minor)).toBeGreaterThan(0);
    expect(tournamentAppearanceFee(s, makeT(s, 'tiq', 'qualifier', 0))).toBe(0);
    const old = makeT(s, 'minor-2013', 'minor', 100_000, { season: 3 });
    expect(tournamentAppearanceFee(s, old)).toBe(Math.round((CONFIG.economy.appearanceByTier.minor * econIndex(2013)) / 100) * 100);
  });
});

describe('经常性收入（赞助 / 直播与内容 / 周边）', () => {
  it('赞助报价：荣誉越高、上赛季排名越好越高；同赛季确定，签约后赛季内固定，下赛季重新谈判', () => {
    const s = withRounds(makeTestState(4));
    const t = s.teams.t1;
    t.honor = 100;
    t.lastSeasonRank = 25;
    const low = sponsorQuote(s, t).perRound;
    expect(sponsorQuote(s, t).perRound).toBe(low); // 确定性
    t.honor = 2000;
    const mid = sponsorQuote(s, t).perRound;
    t.lastSeasonRank = 1;
    const high = sponsorQuote(s, t).perRound;
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
    expect(sponsorContract(s, t).signed).toBe(false);

    s.roundIndex = 1;
    payTeamRevenue(s, t);
    const signed = sponsorContract(s, t);
    expect(signed.signed).toBe(true);
    expect(signed.perRound).toBe(high);
    t.honor = 50; // 赛季内荣誉变化不改合同
    expect(roundRevenue(s, t).sponsor).toBe(high);
    s.season.ti = 10;
    s.season.year = 2021;
    expect(sponsorContract(s, t).signed).toBe(false);
    expect(sponsorContract(s, t).perRound).toBeLessThan(high);
  });

  it('直播与内容：选手等级越高越多，替补减半，荣誉加成有上限', () => {
    const s = makeTestState(2);
    const t = s.teams.t1;
    const base = streamingIncome(s, t);
    expect(base).toBe(Math.round(5 * CONFIG.economy.revenue.streaming.byTier.S * (1 + Math.min(CONFIG.economy.revenue.streaming.honorMaxBonus, t.honor / CONFIG.economy.revenue.streaming.honorDiv))));
    s.players[t.lineup.C!].mmr = 15500; // SSR
    expect(streamingIncome(s, t)).toBeGreaterThan(base);
    const bench = makePlayer({ id: 'bench-1', teamId: 't1', mmr: 9000 });
    s.players[bench.id] = bench;
    t.playerIds.push(bench.id);
    const withBench = streamingIncome(s, t);
    s.players[t.lineup.C!].mmr = 9000;
    const v = CONFIG.economy.revenue.streaming;
    t.honor = 1e9;
    const capped = streamingIncome(s, t);
    expect(capped).toBe(Math.round((5 + v.benchFactor) * v.byTier.S * (1 + v.honorMaxBonus)));
    expect(withBench).toBeGreaterThan(0);
  });

  it('周边热度：夺冠后加成按赛事去重、逐回合递减直至消失', () => {
    const s = withRounds(makeTestState(4));
    s.roundIndex = 3;
    const t = makeT(s, 'major-win', 'major', 1_000_000, { roundIndex: 3, status: 'finished' });
    t.placements = [
      { teamId: 't0', rankFrom: 1, rankTo: 1, prize: 0, points: 0 },
      { teamId: 't1', rankFrom: 2, rankTo: 2, prize: 0, points: 0 },
      { teamId: 't2', rankFrom: 3, rankTo: 4, prize: 0, points: 0 },
    ];
    applyResultMerchBoosts(s);
    applyResultMerchBoosts(s); // 去重
    const [amount, rounds] = CONFIG.economy.revenue.merch.boosts.major[1];
    expect(activeMerchBoosts(s.teams.t0)).toHaveLength(1);
    expect(activeMerchBoosts(s.teams.t0)[0]).toMatchObject({ perRound: amount, roundsLeft: rounds });
    expect(activeMerchBoosts(s.teams.t2)).toHaveLength(0);
    expect(activeMerchBoosts(s.teams.t0)[0].source).toBe('major-win 冠军');
    // Major 亚军也有热度加成，来源标注为「亚军」而不是「冠军」
    if (CONFIG.economy.revenue.merch.boosts.major[2]) {
      expect(activeMerchBoosts(s.teams.t1)).toHaveLength(1);
      expect(activeMerchBoosts(s.teams.t1)[0].source).toBe('major-win 亚军');
    }
    expect(s.news.some((n) => n.title.includes('周边热销'))).toBe(true); // 玩家战队有新闻
    const before = roundRevenue(s, s.teams.t0);
    expect(before.merchBoost).toBe(amount);
    for (let i = 0; i < rounds; i++) payTeamRevenue(s, s.teams.t0);
    expect(activeMerchBoosts(s.teams.t0)).toHaveLength(0);
    expect(roundRevenue(s, s.teams.t0).merchBoost).toBe(0);
  });

  it('回合结算：玩家按来源记账（赞助 / 直播 / 周边），AI 只改金币；人机同公式（难度倍数仅作用于玩家）', () => {
    const s = withRounds(makeTestState(3));
    s.roundIndex = 1;
    const ai = s.teams.t1;
    ai.gold = 0; // 低于储备：不触发 AI 盈余再投入
    const aiRev = roundRevenue(s, ai).total;
    const aiWage = roundWageBill(s, 't1');
    const me0 = s.teams.t0.gold;
    const meRev = roundRevenue(s, s.teams.t0).total;
    const meWage = roundWageBill(s, 't0');
    const r = payRoundSalaries(s);
    expect(r).toEqual({ total: meWage, paidInFull: true });
    expect(ai.gold).toBe(aiRev - aiWage);
    expect(s.teams.t0.gold).toBe(me0 + meRev - meWage);
    const cats = new Set(s.finance.map((f) => f.category));
    for (const c of ['sponsor', 'streaming', 'merch', 'salary'] as const) expect(cats.has(c)).toBe(true);
    expect(s.finance.some((f) => f.category === 'event' && f.note.includes('商业收入'))).toBe(false);
    expect(s.news.some((n) => n.title.startsWith('赞助合同签订'))).toBe(true);
    // 困难难度：玩家经常性收入更低
    const hard = withRounds(makeTestState(2));
    hard.settings.difficulty = 'hard';
    expect(roundRevenue(hard, hard.teams.t0).total).toBeLessThan(roundRevenue(hard, hard.teams.t1).total + 1);
  });

  it('AI 盈余再投入：资金远超工资储备的 AI 战队每回合有一部分资金离开联赛经济，玩家不受影响', () => {
    const s = withRounds(makeTestState(2));
    s.roundIndex = 1;
    const ai = s.teams.t1;
    ai.gold = 100_000_000;
    const rev = roundRevenue(s, ai).total;
    const wage = roundWageBill(s, 't1');
    payRoundSalaries(s);
    const c = CONFIG.ai.surplusReinvest;
    const afterWage = 100_000_000 + rev - wage;
    const expected = Math.round(afterWage - (afterWage - wage * c.reserveRounds) * c.rate);
    expect(ai.gold).toBe(expected);
    const me = withRounds(makeTestState(2));
    me.roundIndex = 1;
    me.teams.t0.gold = 100_000_000;
    const mrev = roundRevenue(me, me.teams.t0).total;
    const mwage = roundWageBill(me, 't0');
    payRoundSalaries(me);
    expect(me.teams.t0.gold).toBe(100_000_000 + mrev - mwage);
  });

  it('赛季预测：预计赛季末资金 = 当前资金 + 剩余回合经常性收入 − 工资', () => {
    const s = withRounds(makeTestState(2));
    expect(remainingPaidRounds(s)).toBe(20); // 赛季初：全部付薪回合
    s.roundIndex = 5;
    expect(remainingPaidRounds(s)).toBe(16);
    const p = seasonProjection(s, 't0');
    expect(p.roundsLeft).toBe(16);
    expect(p.recurringTotal).toBe(p.sponsorTotal + p.streamingTotal + p.merchTotal);
    expect(p.projectedEnd).toBe(s.teams.t0.gold + p.recurringTotal - p.wageTotal);
    expect(p.wageTotal).toBe(roundWageBill(s, 't0') * 16);
    expect(seasonProjection(s, 'missing').projectedEnd).toBe(0);
  });
});

describe('起始资金', () => {
  // 锚定额（TI1 新俱乐部 20 万 / 最强真实俱乐部 10 万）、年代折算、预览 = 实际：见 tests/startingFunds.test.ts
  it('真实俱乐部：最强俱乐部按锚定额 × 年代系数，玩家再 × 难度倍数；TI9 豪门约 10 回合 AI 工资', () => {
    expect(realClubStartingFunds(4_000_000, null, 9)).toBe(400_000);
    expect(realClubStartingFunds(4_000_000, 'easy', 9)).toBeGreaterThan(realClubStartingFunds(4_000_000, 'normal', 9));
    expect(realClubStartingFunds(4_000_000, 'hard', 9)).toBeLessThan(realClubStartingFunds(4_000_000, 'normal', 9));
    expect(realClubStartingFunds(NaN, 'normal', 9)).toBe(0);
    // TI9 豪门：每回合 AI 工资约 4 万 → 起始资金约 8~12 回合工资（原 × 0.2 时约 20 回合；2026-10-10 第二次调整）
    const rounds = realClubStartingFunds(4_000_000, 'normal', 9) / 40_000;
    expect(rounds).toBeGreaterThan(8);
    expect(rounds).toBeLessThan(12);
  });

  it('新俱乐部：锚定额与阵容无关；向导预估 = 实际，早期年代更低，困难不低于普通', () => {
    const est = estimateNewClubStartingFunds(9, 'normal');
    expect(est).toBe(newClubStartingFunds(9, 'normal'));
    expect(estimateNewClubStartingFunds(3, 'normal')).toBeLessThan(est); // 早期年代更低
    // 向导预估：起始资金 + 创立礼包（第八波取消抽卡后礼包关闭 → 总额 = 起始资金）
    const full = estimateNewClubStart(9, 'normal');
    expect(full.funds).toBe(est);
    expect(full.total).toBe(full.funds + full.grantGold);
    expect(full.grantGold).toBe(0);
    expect(full.grantPulls).toBe(0);
    expect(full.wagePerRound).toBeGreaterThan(0);
    expect(estimateNewClubStart(9, 'hard').total).toBeGreaterThanOrEqual(estimateNewClubStart(9, 'normal').total);
    expect(estimateNewClubStart(9, 'easy').total).toBeGreaterThanOrEqual(estimateNewClubStart(9, 'normal').total);
  });

  /** 旧版创立礼包的计算规则（第八波起 CONFIG.season.newClubGachaGrant = false，函数在关闭时恒为 0） */
  function withGrant<T>(fn: () => T): T {
    const season = CONFIG.season as { newClubGachaGrant: boolean };
    const prev = season.newClubGachaGrant;
    season.newClubGachaGrant = true;
    try {
      return fn();
    } finally {
      season.newClubGachaGrant = prev;
    }
  }

  it('创立礼包已关闭：新俱乐部改为在赛季初选秀中获得新秀', () => {
    expect(CONFIG.season.newClubGachaGrant).toBe(false);
    expect(newClubGachaGrant(3, 1_000_000)).toEqual({ pulls: 0, gold: 0 });
  });

  it('（旧规则）创立礼包：若干次单抽的资金，不超过阵容空位', () => withGrant(() => {
    const g = newClubGachaGrant(3);
    expect(g.pulls).toBeLessThanOrEqual(3);
    expect(g.gold).toBe(g.pulls * CONFIG.gacha.singleCost);
    expect(newClubGachaGrant(0)).toEqual({ pulls: 0, gold: 0 });
    expect(newClubGachaGrant(1).pulls).toBeLessThanOrEqual(1);
    expect(newClubGachaGrant(-2).pulls).toBe(0);
    expect(newClubGachaGrant(NaN).pulls).toBe(0);
  }));

  it('（旧规则）创立礼包按年代工资收缩：价值不超过约 N 回合工资，但至少 1 次单抽', () => withGrant(() => {
    const sf = CONFIG.economy.startingFunds;
    const single = CONFIG.gacha.singleCost;
    const max = Math.floor(sf.newClubGachaGrantPulls);
    // 工资足够高：按上限次数
    expect(newClubGachaGrant(8, 1_000_000).pulls).toBe(max);
    // 早期年代（每回合工资 3000）：礼包 ≤ maxWageRounds 回合工资，至少 1 次
    const early = newClubGachaGrant(8, 3000);
    expect(early.pulls).toBe(Math.max(1, Math.min(max, Math.floor((sf.newClubGachaGrantMaxWageRounds * 3000) / single))));
    expect(early.pulls).toBeGreaterThanOrEqual(1);
    expect(early.gold).toBe(early.pulls * single);
    // 阵容已满：0
    expect(newClubGachaGrant(0, 3000).pulls).toBe(0);
    // 工资缺失/非法：不按工资收缩
    expect(newClubGachaGrant(8, NaN).pulls).toBe(max);
  }));

  it('新游戏：新俱乐部起始资金 = 锚定额（与初始阵容工资无关），不再发放抽卡礼包', async () => {
    const { createNewGame } = await import('../src/engine/game');
    const { registerNodeRosterLoader } = await import('../scripts/nodeData');
    registerNodeRosterLoader();
    for (const startTi of [1, 9]) {
      const s = await createNewGame({
        startTi, seasons: 1, difficulty: 'normal', managerName: 't', seed: 11,
        newClub: { name: '测试俱乐部', tag: 'TST', region: 'CN', color: '#123456' },
      });
      const me = s.teams[s.settings.playerTeamId];
      const grant = s.finance.filter((f) => f.category === 'event' && f.note.includes('创立礼包')).reduce((a, f) => a + f.amount, 0);
      expect(grant).toBe(0);
      const gold0 = me.gold - s.finance.reduce((a, f) => a + f.amount, 0);
      expect(gold0).toBe(newClubStartingFunds(startTi, 'normal'));
      // 起始资金远多于初始阵容的工资（TI1 约 50 回合）：新俱乐部有钱运作和转会
      const rookieWage = me.playerIds.map((id) => s.players[id]).filter((p) => p?.draft).reduce((a, p) => a + p.salary, 0);
      expect(gold0 / (roundWageBill(s, me.id) - rookieWage)).toBeGreaterThan(20);
      expect(me.playerIds.length).toBeLessThanOrEqual(CONFIG.team.maxRoster);
    }
  });
});
