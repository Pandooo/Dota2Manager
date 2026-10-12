// 选手奖金分成（第九波，src/engine/prizeShare.ts）：拆分发放、初始比例、玩家调整（范围 / 步长 / 每回合一次）、
// 损失厌恶、发奖时的归属感、奖金计入薪资满意度、每回合环境项、AI 调整、多人 RPC
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makePlayer, makeTestState } from './helpers';
import {
  aiAdjustPrizeShares, defaultPrizeShare, ensurePrizeShares, normalizePrizeShare, payTournamentPrize, prizeCutLoyaltyGain,
  prizeShareChangeLoyalty, prizeShareOf, prizeSharePreview, prizeShareStatus, raiseCooldownLeft, setPrizeShare, splitPrize,
} from '../src/engine/prizeShare';
import {
  loyaltyEnvironment, prizeSalaryCredit, prizeShareLoyaltyDelta, recentPrizeEarned, salaryGap, tenureSpeedMult,
} from '../src/engine/salary';
import { roundLoyaltyUpdate } from '../src/engine/growth';
import { RPC_WHITELIST } from '../src/shared/protocol';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import * as M from '../src/engine/multi';

const PS = CONFIG.prizeShare;

function state(): GameState {
  const s = makeTestState(4);
  s.roundIndex = 3;
  s.phase = 'regular';
  return s;
}

/** 把 t0 的分成比例设为 share，并给出一名替补（首发权重 1、替补 benchWeight） */
function withBench(s: GameState, share: number): string {
  const team = s.teams.t0;
  team.prizeShare = share;
  const sub = makePlayer({ id: 't0-sub', handle: 't0_sub', teamId: 't0', position: 'C', salary: 4000, joinedSeason: 9 });
  s.players[sub.id] = sub;
  team.playerIds.push(sub.id);
  return sub.id;
}

describe('prizeShare · 拆分与发放', () => {
  it('俱乐部只拿 (1 − 分成)，队员按首发 1 / 替补 benchWeight 分配，合计守恒', () => {
    const s = state();
    const sub = withBench(s, 0.7);
    const split = splitPrize(s, 't0', 100_000);
    expect(split.players).toBe(70_000);
    expect(split.club).toBe(30_000);
    expect(split.cuts.reduce((a, c) => a + c.amount, 0)).toBe(70_000);
    const starter = split.cuts.find((c) => c.playerId === 't0-C')!.amount;
    const bench = split.cuts.find((c) => c.playerId === sub)!.amount;
    expect(bench / starter).toBeCloseTo(PS.benchWeight, 1);
  });

  it('发放：金币只增加俱乐部部分，账目说明「奖金 X（俱乐部 Y / 队员 Z）」', () => {
    const s = state();
    s.teams.t0.prizeShare = 0.6;
    const gold = s.teams.t0.gold;
    const split = payTournamentPrize(s, 't0', 50_000, '测试杯 冠军');
    expect(s.teams.t0.gold - gold).toBe(split.club);
    expect(split.club).toBe(20_000);
    const entry = s.finance.find((f) => f.category === 'prize')!;
    expect(entry.amount).toBe(20_000);
    expect(entry.note).toBe('测试杯 冠军 奖金 5.0万（俱乐部 2.0万 / 队员 3.0万）');
  });

  it('全部分给队员（100%）时仍记一条 0 金额的奖金账目；没有队员时全归俱乐部', () => {
    const s = state();
    s.teams.t0.prizeShare = 1;
    payTournamentPrize(s, 't0', 40_000, '公开赛 冠军');
    const entry = s.finance.find((f) => f.category === 'prize')!;
    expect(entry.amount).toBe(0);
    expect(entry.note).toContain('俱乐部 0 / 队员 4.0万');
    const empty = state();
    for (const id of empty.teams.t1.playerIds) empty.players[id].teamId = null;
    const split = splitPrize(empty, 't1', 10_000);
    expect(split.club).toBe(10_000);
    expect(split.players).toBe(0);
  });

  it('AI 战队同样拆分（只改金币，不写账目）', () => {
    const s = state();
    s.teams.t2.prizeShare = 0.8;
    const gold = s.teams.t2.gold;
    payTournamentPrize(s, 't2', 100_000, 'X');
    expect(s.teams.t2.gold - gold).toBe(20_000);
    expect(s.finance.length).toBe(0);
  });
});

describe('prizeShare · 初始比例', () => {
  it('全部战队默认 50%（新俱乐部 / 真实俱乐部 / 豪门 / AI 战队相同，用户决策 2026-10-10），且在范围内、是步长的整数倍', () => {
    const s = state();
    expect(PS.initial).toBe(0.5);
    s.teams['club-new'] = { ...s.teams.t1, id: 'club-new', isPlayer: true, prizeShare: undefined };
    expect(defaultPrizeShare(s, s.teams['club-new'])).toBe(PS.initial);
    for (let i = 0; i < 20; i++) {
      const team = { ...s.teams.t1, id: `real-${i}`, honor: 300 + i * 150, prizeShare: undefined };
      expect(defaultPrizeShare(s, team)).toBe(PS.initial);
      expect(prizeShareOf(s, team)).toBe(PS.initial);
    }
    expect(PS.initial).toBeGreaterThanOrEqual(PS.min);
    expect(PS.initial).toBeLessThanOrEqual(PS.max);
    expect(Math.abs(PS.initial / PS.step - Math.round(PS.initial / PS.step))).toBeLessThan(1e-6);
    // 默认比例即为每回合环境项的中性点
    expect(prizeShareLoyaltyDelta(PS.initial)).toBe(0);
  });

  it('ensurePrizeShares 补齐缺失值并规范化异常值；prizeShareOf 不写入', () => {
    const s = state();
    expect(s.teams.t1.prizeShare).toBeUndefined();
    const v = prizeShareOf(s, 't1');
    expect(s.teams.t1.prizeShare).toBeUndefined();
    s.teams.t2.prizeShare = 0.73;
    s.teams.t3.prizeShare = 3;
    expect(ensurePrizeShares(s)).toBe(2); // t0、t1 缺失
    expect(s.teams.t1.prizeShare).toBe(v);
    expect(s.teams.t2.prizeShare).toBe(0.75);
    expect(s.teams.t3.prizeShare).toBe(PS.max);
    expect(normalizePrizeShare(Number.NaN)).toBe(PS.initial);
    expect(normalizePrizeShare(0.1)).toBe(PS.min);
  });
});

describe('prizeShare · 玩家调整', () => {
  it('范围、步长、相同值与每回合一次；也接受百分数', () => {
    const s = state();
    s.teams.t0.prizeShare = 0.7;
    for (const bad of [0.45, 1.05, 0.72, Number.NaN, 'abc' as unknown as number, 101]) {
      const r = setPrizeShare(s, bad);
      expect(r.ok, String(bad)).toBe(false);
    }
    expect(setPrizeShare(s, 0.7).ok).toBe(false);
    expect(s.teams.t0.prizeShare).toBe(0.7);
    const r = setPrizeShare(s, 0.8);
    expect(r.ok).toBe(true);
    expect(s.teams.t0.prizeShare).toBe(0.8);
    const again = setPrizeShare(s, 0.85);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('每回合最多一次');
    expect(prizeShareStatus(s).canChange).toBe(false);
    s.roundIndex += 1;
    expect(setPrizeShare(s, 75).ok).toBe(true); // 百分数
    expect(s.teams.t0.prizeShare).toBe(0.75);
    const log = s.teams.t0.prizeShareLog!;
    expect(log.map((x) => [x.from, x.to])).toEqual([[0.7, 0.8], [0.8, 0.75]]);
    // 公开新闻
    const news = s.news.find((n) => n.title.includes('将奖金分成提高到 80%'))!;
    expect(news.visibility).toBe('public');
    expect(news.actorTeamId).toBe('t0');
  });

  it('损失厌恶：同幅下调的归属感损失明显大于上调收益，并按在队时长放大', () => {
    const up = prizeShareChangeLoyalty(0.7, 0.8, 1);
    const down = prizeShareChangeLoyalty(0.7, 0.6, 1);
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
    expect(-down).toBeGreaterThan(up * 2);
    expect(prizeShareChangeLoyalty(0.7, 0.9, 1)).toBeCloseTo(up * 2, 6);
    expect(prizeShareChangeLoyalty(0.7, 0.6, 2)).toBeCloseTo(down * 2, 6);
    expect(prizeShareChangeLoyalty(1, 0.5, 100)).toBe(-PS.loyalty.maxImmediate);
    // 上调的上限与下调同比例：大幅调整时损失厌恶依然成立（在队时长 ×3 的老队员 50% ↔ 100%）
    expect(prizeShareChangeLoyalty(0.5, 1, 100)).toBe(PS.loyalty.maxImmediateRaise);
    const bigUp = prizeShareChangeLoyalty(0.5, 1, 3);
    const bigDown = prizeShareChangeLoyalty(1, 0.5, 3);
    expect(-bigDown).toBeGreaterThanOrEqual(bigUp * 2.4);
    for (let steps = 1; steps <= 10; steps++) {
      for (const mult of [0.5, 1, 2, 3]) {
        const u = prizeShareChangeLoyalty(0.5, 0.5 + steps * PS.step, mult);
        const dn = prizeShareChangeLoyalty(0.5 + steps * PS.step, 0.5, mult);
        expect(-dn, `${steps} 档 ×${mult}`).toBeGreaterThan(u * 2);
      }
    }

    const s = state();
    s.teams.t0.prizeShare = 0.7;
    const veteran = s.players['t0-C'];
    const rookie = s.players['t0-M'];
    veteran.joinedSeason = 6; // 第 4 个赛季 → 速度倍数更高
    rookie.joinedSeason = 9;
    veteran.loyalty = 70;
    rookie.loyalty = 70;
    const pv = prizeSharePreview(s, 0.6);
    expect(pv.allowed).toBe(true);
    expect(setPrizeShare(s, 0.6).ok).toBe(true);
    const dv = veteran.loyalty - 70;
    const dr = rookie.loyalty - 70;
    expect(dr).toBeLessThan(0);
    expect(dv).toBeLessThan(dr);
    expect(dv / dr).toBeCloseTo(tenureSpeedMult(3) / tenureSpeedMult(0), 1);
    expect(pv.members.find((m) => m.playerId === veteran.id)!.delta).toBeCloseTo(dv, 1);
  });

  it('下调后冷静期内把比例调回原水平没有即时加成，只有超出原水平的部分才算上调', () => {
    const s = state();
    s.teams.t0.prizeShare = 0.8;
    const p = s.players['t0-C'];
    p.joinedSeason = 8; // 第二个赛季 → 速度倍数 1
    p.loyalty = 60;
    expect(setPrizeShare(s, 0.6).ok).toBe(true); // 80% → 60%
    const afterCut = p.loyalty;
    expect(afterCut).toBeLessThan(60);
    expect(s.teams.t0.prizeShareCutFrom).toBe(0.8);
    // 继续下调：下调前水平取最高（仍为 80%）
    s.roundIndex += 1;
    expect(setPrizeShare(s, 0.55).ok).toBe(true);
    expect(s.teams.t0.prizeShareCutFrom).toBe(0.8);
    const l1 = p.loyalty;
    // 冷静期内调回 70%：没有加成
    s.roundIndex += 1;
    const pv = prizeSharePreview(s, 0.7);
    expect(pv.raiseSuppressed).toBe(true);
    expect(pv.restoreLevel).toBe(0.8);
    expect(pv.avgDelta).toBe(0);
    const r = setPrizeShare(s, 0.7);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('并不领情');
    expect(p.loyalty).toBe(l1);
    expect(prizeShareStatus(s).restoreLevel).toBe(0.8);
    // 冷静期内上调到 90%：只有 80% → 90% 两档计入
    s.roundIndex += 1;
    const mult = tenureSpeedMult(1);
    const l2 = p.loyalty;
    expect(setPrizeShare(s, 0.9).ok).toBe(true);
    expect(p.loyalty - l2).toBeCloseTo(prizeShareChangeLoyalty(0.8, 0.9, mult), 6);
    // 已超过原水平：冷静期结束
    expect(raiseCooldownLeft(s, s.teams.t0)).toBe(0);
    expect(s.teams.t0.prizeShareCutFrom).toBeUndefined();
    // 「赛前压低、赛后调回」不划算：下调损失 > 调回 + 一个赛季后再上调的收益
    const down = prizeShareChangeLoyalty(0.8, 0.5, 3);
    const backUp = prizeShareChangeLoyalty(0.5, 0.8, 3, 0.8);
    expect(backUp).toBe(0);
    expect(-down).toBeGreaterThan(prizeShareChangeLoyalty(0.5, 0.8, 3) * 2);
  });

  it('下调后冷静期内再上调没有即时加成', () => {
    const s = state();
    s.teams.t0.prizeShare = 0.7;
    expect(setPrizeShare(s, 0.6).ok).toBe(true);
    s.roundIndex += 1;
    expect(raiseCooldownLeft(s, s.teams.t0)).toBeGreaterThan(0);
    const before = s.players['t0-C'].loyalty;
    const r = setPrizeShare(s, 0.7);
    expect(r.ok).toBe(true);
    expect(s.players['t0-C'].loyalty).toBe(before);
    s.roundIndex += PS.loyalty.raiseCooldownRounds + 1;
    expect(raiseCooldownLeft(s, s.teams.t0)).toBe(0);
    const b2 = s.players['t0-C'].loyalty;
    expect(setPrizeShare(s, 0.8).ok).toBe(true);
    expect(s.players['t0-C'].loyalty).toBeGreaterThan(b2);
  });

  it('游戏结束 / 战队不存在时拒绝', () => {
    const s = state();
    s.gameOver = { reason: 'completed', summary: '' };
    expect(setPrizeShare(s, 0.8).ok).toBe(false);
  });
});

describe('prizeShare · 归属感与薪资满意度', () => {
  it('每回合环境项：默认 50% 为中性、越高加分越多（中性点以下扣分更陡），缺失为 0；计入 loyaltyEnvironment', () => {
    expect(prizeShareLoyaltyDelta(undefined)).toBe(0);
    expect(PS.loyalty.norm).toBe(PS.initial);
    expect(prizeShareLoyaltyDelta(PS.loyalty.norm)).toBe(0);
    expect(prizeShareLoyaltyDelta(PS.min)).toBe(0);
    expect(prizeShareLoyaltyDelta(0.7)).toBeGreaterThan(0);
    expect(prizeShareLoyaltyDelta(1)).toBeGreaterThan(prizeShareLoyaltyDelta(0.7));
    // 公式本身仍支持中性点以下扣分（损失厌恶，更陡）；当前中性点即下限，实际不会出现
    expect(prizeShareLoyaltyDelta(PS.loyalty.norm - 0.1)).toBeLessThan(0);
    expect(-prizeShareLoyaltyDelta(PS.loyalty.norm - 0.1)).toBeGreaterThan(prizeShareLoyaltyDelta(PS.loyalty.norm + 0.1));
    const s = state();
    s.teams.t0.prizeShare = 1;
    const p = s.players['t0-C'];
    const env = loyaltyEnvironment(s, p, s.teams.t0);
    expect(env.prize).toBeCloseTo(prizeShareLoyaltyDelta(1), 6);
    s.teams.t0.prizeShare = PS.loyalty.norm;
    expect(loyaltyEnvironment(s, p, s.teams.t0).total).toBeCloseTo(env.total - prizeShareLoyaltyDelta(1), 6);
  });

  it('AI 战队选手同样受环境项影响（每回合）', () => {
    const s = state();
    s.teams.t1.prizeShare = 0.9;
    s.teams.t2.prizeShare = PS.loyalty.norm;
    const a = s.players['t1-C'];
    const b = s.players['t2-C'];
    a.loyalty = 60;
    b.loyalty = 60;
    roundLoyaltyUpdate(s);
    expect(prizeShareLoyaltyDelta(0.9)).toBeGreaterThan(0);
    expect(a.loyalty - 60).toBeCloseTo(prizeShareLoyaltyDelta(0.9) + (b.loyalty - 60), 6);
  });

  it('发奖金：分到的越多（相对工资）归属感提升越多；临时替补不计；记入近期奖金收入', () => {
    expect(prizeCutLoyaltyGain(0, 5000)).toBe(0);
    expect(prizeCutLoyaltyGain(50_000, 5000)).toBeGreaterThan(prizeCutLoyaltyGain(10_000, 5000));
    expect(prizeCutLoyaltyGain(10_000, 2000)).toBeGreaterThan(prizeCutLoyaltyGain(10_000, 8000));
    expect(prizeCutLoyaltyGain(1e9, 1000)).toBeLessThanOrEqual(PS.loyalty.prizeMax);

    const s = state();
    s.teams.t0.prizeShare = 0.8;
    const p = s.players['t0-C'];
    const temp = s.players['t0-M'];
    temp.tempSubUntilTournament = 'cup';
    p.loyalty = 50;
    temp.loyalty = 50;
    const split = payTournamentPrize(s, 't0', 200_000, '大赛 冠军');
    const cut = split.cuts.find((c) => c.playerId === p.id)!.amount;
    expect(p.loyalty).toBeCloseTo(50 + prizeCutLoyaltyGain(cut, p.salary), 1);
    expect(temp.loyalty).toBe(50);
    expect(recentPrizeEarned(s, p)).toBe(cut);
    expect(recentPrizeEarned(s, temp)).toBe(0);
  });

  it('近期奖金全额计入薪资满意度：差距缩小、按回合衰减、各回合补贴合计 ≈ 奖金本身、换队后不再计入', () => {
    const s = state();
    s.teams.t0.prizeShare = 0.8;
    const p = s.players['t0-C'];
    p.salary = 3000;
    const gapBefore = salaryGap(s, p);
    payTournamentPrize(s, 't0', 400_000, '大赛 冠军');
    const earned = recentPrizeEarned(s, p);
    const W = PS.salary.windowRounds;
    const credit = prizeSalaryCredit(s, p);
    expect(PS.salary.weight).toBe(1);
    expect(credit).toBe(Math.round((earned / W) * PS.salary.weight));
    // 不再有「至多工资 × 30%」的上限：大额奖金可以超过工资本身
    expect(credit).toBeGreaterThan(p.salary * 0.3);
    expect(salaryGap(s, p)).toBeLessThan(gapBefore);
    // 每回合 × (1 − 1/W)；跨赛季按每赛季回合数计算
    s.roundIndex += 4;
    expect(recentPrizeEarned(s, p)).toBeCloseTo(earned * Math.pow(1 - 1 / W, 4), 0);
    const perSeason = s.season.rounds.length || CONFIG.calendar.regularRounds + 3;
    s.season.ti += 1;
    expect(recentPrizeEarned(s, p)).toBeCloseTo(earned * Math.pow(1 - 1 / W, 4 + perSeason), 0);
    s.season.ti -= 1;
    s.roundIndex -= 4;
    // 一笔奖金折算到之后各回合的补贴合计 ≈ 奖金本身（余额低于最低工资后视为 0）
    let total = 0;
    const r0 = s.roundIndex;
    const ti0 = s.season.ti;
    for (let k = 0; k < 400; k++) {
      s.season.ti = ti0 + Math.floor((r0 + k) / perSeason);
      s.roundIndex = (r0 + k) % perSeason;
      total += prizeSalaryCredit(s, p);
    }
    expect(total).toBeGreaterThan(earned * 0.97);
    expect(total).toBeLessThanOrEqual(earned * 1.01);
    s.season.ti = ti0;
    s.roundIndex = r0;
    expect(recentPrizeEarned(s, p, 't1')).toBe(0);
    expect(prizeSalaryCredit(s, p, 't1')).toBe(0);
  });

  it('旧存档只记录了赛季（无回合键）：按该赛季第 0 回合起衰减', () => {
    const s = state();
    const p = s.players['t0-C'];
    p.salaryTrack = { prizeEarned: 100_000, prizeTi: s.season.ti, prizeTeamId: 't0' };
    const W = PS.salary.windowRounds;
    expect(recentPrizeEarned(s, p)).toBeCloseTo(100_000 * Math.pow(1 - 1 / W, s.roundIndex), 0);
  });
});

describe('prizeShare · AI 调整', () => {
  // 测试内临时改概率（CONFIG 为只读类型）
  const AI = PS.ai as unknown as Record<string, number>;
  const saved = { ...AI };
  afterEach(() => {
    Object.assign(AI, saved);
  });

  it('资金紧张的 AI 下调、资金充裕的上调（不越界）；玩家战队不受影响', () => {
    AI.cutChance = 1;
    AI.raiseChance = 1;
    const s = state();
    ensurePrizeShares(s);
    s.teams.t0.prizeShare = 0.7;
    s.teams.t1.prizeShare = 0.7;
    s.teams.t1.gold = 0; // 资金紧张
    s.teams.t2.prizeShare = 0.7;
    s.teams.t2.gold = 1e9; // 资金充裕
    s.teams.t3.prizeShare = PS.min;
    s.teams.t3.gold = 0; // 已在下限
    s.teams.t0.gold = 0;
    const n = aiAdjustPrizeShares(s);
    expect(n).toBe(2);
    expect(s.teams.t0.prizeShare).toBe(0.7);
    expect(s.teams.t1.prizeShare).toBe(0.65);
    expect(s.teams.t2.prizeShare).toBe(0.75);
    expect(s.teams.t3.prizeShare).toBe(PS.min);
    expect(s.teams.t1.prizeShareLog?.[0]?.reason).toBe('资金紧张');
    for (let i = 0; i < 30; i++) {
      s.roundIndex += 1;
      aiAdjustPrizeShares(s);
    }
    expect(s.teams.t1.prizeShare).toBe(PS.min);
    expect(s.teams.t2.prizeShare).toBe(normalizePrizeShare(PS.ai.max));
    expect(s.teams.t2.prizeShareLog!.length).toBeLessThanOrEqual(PS.logMax);
  });

  it('概率为 0 时不调整；无条件的战队不消耗随机数', () => {
    AI.cutChance = 0;
    AI.raiseChance = 0;
    const s = state();
    s.teams.t1.gold = 0;
    s.teams.t1.prizeShare = 0.7;
    expect(aiAdjustPrizeShares(s)).toBe(0);
    expect(s.teams.t1.prizeShare).toBe(0.7);
    const calm = state();
    ensurePrizeShares(calm);
    // 每回合工资 5 × 8000：资金介于「紧张」与「充裕」两条线之间
    const wage = 5 * 8000;
    for (const t of Object.values(calm.teams)) t.gold = wage * Math.round((PS.ai.brokeWageRounds + PS.ai.richWageRounds) / 2);
    const rng = calm.rngState;
    aiAdjustPrizeShares(calm);
    expect(calm.rngState).toBe(rng);
  });
});

describe('prizeShare · 多人模式', () => {
  beforeAll(() => {
    registerNodeRosterLoader();
  });

  it('白名单 RPC 在调用者座位执行；玩家战队初始 50%（existing 玩法同样重置）；每回合一次按战队计', async () => {
    expect((RPC_WHITELIST as readonly string[]).includes('setPrizeShare')).toBe(true);
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'existing', seed: 5,
      players: [{ sessionId: 's-a', name: '甲', teamId: 'og' }, { sessionId: 's-b', name: '乙', teamId: 'team-liquid' }],
    });
    const [a, b] = g.multiplayer!.order;
    expect(g.teams[a].prizeShare).toBe(PS.initial);
    expect(g.teams[b].prizeShare).toBe(PS.initial);
    const call = (id: string, ...args: unknown[]) => M.callAsSeat(g, id, 'setPrizeShare', args) as OpResult;
    expect(call(a, 0.9).ok).toBe(true);
    expect(g.teams[a].prizeShare).toBe(0.9);
    expect(g.teams[b].prizeShare).toBe(PS.initial);
    expect(call(a, 0.85).ok).toBe(false);
    expect(call(b, 0.6).ok).toBe(true);
    expect(g.teams[b].prizeShare).toBe(0.6);
    expect(call(b, 'x').ok).toBe(false);
    expect(g.multiplayer!.activeSeat).toBeNull();
    // 公开新闻记在操作者名下
    const n = g.news.find((x) => x.title.includes('将奖金分成提高到 90%'))!;
    expect(n.actorTeamId).toBe(a);
    expect(n.visibility).toBe('public');
  });
});
