import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/engine/player', () => import('./e4-fakes/player'));
vi.mock('../src/engine/team', () => import('./e4-fakes/team'));
vi.mock('../src/engine/honor', () => import('./e4-fakes/others'));
vi.mock('../src/engine/generation', () => import('./e4-fakes/others'));
vi.mock('../src/engine/growth', () => import('./e4-fakes/others'));
vi.mock('../src/engine/funEvents', () => import('./e4-fakes/others'));
vi.mock('../src/data/index', () => import('./e4-fakes/others'));

import { makeTestState, makeCoach } from './helpers';
import { CONFIG } from '../src/engine/config';
import {
  addFinance, aiCommercialIncome, econ, econIndex, extraTrainingCost, extraTrainingCostAt, payRoundSalaries, playerCommercialIncome, roundWageBill,
  scrimCost,
} from '../src/engine/economy';

describe('economy', () => {
  it('econIndex 取表值，超出范围取最近年份', () => {
    expect(econIndex(2019)).toBe(1);
    expect(econIndex(2011)).toBe(0.25);
    expect(econIndex(2005)).toBe(0.25);
    expect(econIndex(2040)).toBe(CONFIG.economy.econIndexByYear[2027]);
    expect(econIndex(NaN)).toBeGreaterThan(0);
    const s = makeTestState(2);
    expect(econ(s)).toBe(1);
    s.season.year = 2012;
    expect(econ(s)).toBe(0.3);
  });

  it('addFinance：玩家写账目，AI 只改金币', () => {
    const s = makeTestState(2);
    const g0 = s.teams.t0.gold;
    addFinance(s, 't0', -1234.4, 'training', '额外训练');
    expect(s.teams.t0.gold).toBe(g0 - 1234);
    expect(s.finance).toHaveLength(1);
    expect(s.finance[0]).toMatchObject({ amount: -1234, category: 'training', season: 9 });
    const a0 = s.teams.t1.gold;
    addFinance(s, 't1', 5000, 'prize', '奖金');
    expect(s.teams.t1.gold).toBe(a0 + 5000);
    expect(s.finance).toHaveLength(1);
    addFinance(s, 'nope', 100, 'other', 'x'); // 不存在的战队不崩溃
  });

  it('工资单 = 非禁赛选手工资（含临时替补）+ 教练工资', () => {
    const s = makeTestState(2);
    const team = s.teams.t0;
    const coach = makeCoach({ teamId: 't0', salary: 7000 });
    s.coaches[coach.id] = coach;
    team.coachId = coach.id;
    const base = team.playerIds.reduce((sum, id) => sum + s.players[id].salary, 0);
    expect(roundWageBill(s, 't0')).toBe(base + 7000);
    s.players[team.playerIds[0]].status = 'banned';
    expect(roundWageBill(s, 't0')).toBe(base - s.players[team.playerIds[0]].salary + 7000);
    s.players[team.playerIds[1]].tempSubUntilTournament = 'x';
    expect(roundWageBill(s, 't0')).toBe(base - s.players[team.playerIds[0]].salary + 7000);
    expect(roundWageBill(s, 'missing')).toBe(0);
  });

  it('支付工资：足额 / 欠薪触发事件', () => {
    const s = makeTestState(3);
    const bill = roundWageBill(s, 't0');
    const aiBill = roundWageBill(s, 't1');
    const ai0 = s.teams.t1.gold;
    const aiIncome = aiCommercialIncome(s, s.teams.t1);
    expect(aiIncome).toBeGreaterThan(0);
    const r = payRoundSalaries(s);
    expect(r).toEqual({ total: bill, paidInFull: true });
    expect(s.teams.t1.gold).toBe(ai0 + aiIncome - aiBill);
    expect(s.finance.some((f) => f.category === 'salary')).toBe(true);

    s.teams.t0.gold = 10;
    const honor0 = s.teams.t0.honor;
    // 人机共用经常性收入（赞助 / 直播 / 周边）：先入账再付工资
    const income = playerCommercialIncome(s, s.teams.t0);
    expect(income).toBeGreaterThan(0);
    expect(10 + income).toBeLessThan(bill);
    const r2 = payRoundSalaries(s);
    expect(r2.paidInFull).toBe(false);
    expect(s.teams.t0.gold).toBe(10 + income - bill);
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.events.unpaidHonor);
    const unpaid = s.pendingDecisions.filter((d) => d.kind === 'unpaid_salary');
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0].blocking).toBe(false);
    // 再欠一次：不重复堆叠决策
    payRoundSalaries(s);
    expect(s.pendingDecisions.filter((d) => d.kind === 'unpaid_salary')).toHaveLength(1);
  });

  it('AI 经常性收入：随荣誉增长（有上限）、随年代缩放；人类战队另按难度计算', () => {
    const s = makeTestState(3);
    const ai = s.teams.t1;
    ai.honor = 0;
    const low = aiCommercialIncome(s, ai);
    expect(low).toBeGreaterThan(0);
    ai.honor = 400;
    const mid = aiCommercialIncome(s, ai);
    expect(mid).toBeGreaterThan(low);
    const sp = CONFIG.economy.revenue.sponsor;
    ai.honor = sp.honorCap * 10;
    const capped = aiCommercialIncome(s, ai);
    ai.honor = sp.honorCap * 20;
    expect(aiCommercialIncome(s, ai)).toBe(capped);
    ai.honor = NaN;
    expect(aiCommercialIncome(s, ai)).toBe(low);
    // 年代缩放（econIndex 2011 = 0.25）
    ai.honor = 400;
    s.season.year = 2011;
    const early = aiCommercialIncome(s, ai);
    expect(early).toBeGreaterThan(mid * 0.2);
    expect(early).toBeLessThan(mid * 0.3);
    // aiCommercialIncome 只对 AI：人类玩家战队返回 0（人类战队收入走 playerCommercialIncome）
    expect(aiCommercialIncome(s, s.teams.t0)).toBe(0);
    expect(playerCommercialIncome(s, s.teams.t0)).toBeGreaterThan(0);
    // AI 资金为 NaN 时修复为有限值
    ai.gold = NaN;
    payRoundSalaries(s);
    expect(Number.isFinite(ai.gold)).toBe(true);
  });

  // 成长重平衡（2026-10-09）：同一回合内逐次加价（× extraCostGrowth^本回合已购），本赛季累计缓慢上涨（+extraSeasonStep / 次，有上限）
  it('额外训练价格：同一回合内逐次加价、赛季内缓慢上涨，并随年代缩放', () => {
    const t = CONFIG.training;
    const s = makeTestState(2);
    const c0 = extraTrainingCost(s);
    expect(c0).toBe(t.extraBaseCost);
    // 本回合已购 2 次（本赛季也是 2 次）
    s.extraTrainingBoughtThisRound = 2;
    s.season.extraTrainingsBought = 2;
    expect(extraTrainingCost(s)).toBe(Math.round(t.extraBaseCost * t.extraCostGrowth ** 2 * (1 + t.extraSeasonStep * 2)));
    // 新回合（本回合已购清零）：只剩赛季累计的小幅上涨
    s.extraTrainingBoughtThisRound = 0;
    s.season.extraTrainingsBought = 10;
    expect(extraTrainingCost(s)).toBe(Math.round(t.extraBaseCost * (1 + t.extraSeasonStep * 10)));
    // 赛季累计有上限
    s.season.extraTrainingsBought = 1000;
    expect(extraTrainingCost(s)).toBe(Math.round(t.extraBaseCost * t.extraSeasonMaxMult));
    expect(extraTrainingCostAt(s, 1, 0)).toBe(Math.round(t.extraBaseCost * t.extraCostGrowth));
    s.season.year = 2011;
    s.season.extraTrainingsBought = 0;
    expect(extraTrainingCost(s)).toBe(Math.round(t.extraBaseCost * 0.25));
  });

  it('狂练很花钱：每个休赛回合加满额外训练，一个赛季的花费远超常规训练', () => {
    const t = CONFIG.training;
    const s = makeTestState(2); // econ 1（2019）
    let heavy = 0;
    let light = 0;
    for (let round = 0; round < 12; round++) {
      for (let k = 0; k < t.maxExtraPerRound; k++) heavy += extraTrainingCostAt(s, k, round * t.maxExtraPerRound + k);
      light += extraTrainingCostAt(s, 0, round);
    }
    // 12 个休赛回合每回合加满 3 次 ≈ 每回合 1 次的 3.5 倍以上，单季约 60 万（不含训练赛；再每回合约一场训练赛约 80~110 万：
    // 豪门一个赛季收入的一半左右、中游俱乐部收入的 1.5 倍以上——复核 2026-10-09：首版约 90 万 + 训练赛 130~190 万，几乎没人买得起）
    expect(heavy).toBeGreaterThan(light * 3.5);
    expect(heavy).toBeGreaterThan(500000);
    expect(heavy).toBeLessThan(800000);
  });

  it('训练赛费用：目标越强越贵', () => {
    const s = makeTestState(8); // t0 战力 70 … t7 战力 77
    const weak = makeTestState(1);
    expect(scrimCost(s, 't7')).toBeGreaterThan(scrimCost(s, 't1'));
    // 同等实力：ratio=1 → base + 0.2 × k
    const self = scrimCost(s, 't0');
    expect(self).toBe(Math.round(CONFIG.training.scrimBaseCost + 0.2 * CONFIG.training.scrimCostPerStrengthRatio));
    expect(scrimCost(weak, 'missing')).toBe(CONFIG.training.scrimBaseCost);
  });
});
