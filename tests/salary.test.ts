// 第八波 · 隐藏的预期薪资与归属感多维模型（src/engine/salary.ts 及 growth / market / squadOps / events 的接入）
import { describe, expect, it } from 'vitest';
import type { GameState, Player } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { computeSalary } from '../src/engine/player';
import { roundLoyaltyUpdate } from '../src/engine/growth';
import { generateAiOffers, processContractExpiry, refreshContractDecisions, renewContract } from '../src/engine/market';
import { raiseSalaryPreview } from '../src/engine/squadOps';
import { processLoyaltyDepartures, resolveDecision } from '../src/engine/events';
import {
  aiOfferChance, expectedSalary, gapGrowthDelta, honorSalaryFactor, loyaltyEnvironment, offerGapWeight, onRookieContract,
  playerFame, playerMoodSummary, playerSalaryMood, recordSalaryGap, renewalAsk, salaryGap, salaryLoyaltyDelta, salaryMoodOf,
  starSalaryFactor, tenureSpeedMult, unhappyStarPoachChance, updateSalaryTrack, signingSalary, alignInitialSalaries,
} from '../src/engine/salary';
import { signFreeAgent } from '../src/engine/market';

const me = (s: GameState, pos = 'C'): Player => s.players[`t0-${pos}`];

/** 把工资设为「预期 × (1 − g)」，即薪资差恰为 g */
function setGap(s: GameState, p: Player, g: number): void {
  p.salary = Math.round(expectedSalary(s, p) * (1 - g));
}

function richAi(s: GameState): void {
  for (const t of Object.values(s.teams)) if (!t.isPlayer) t.gold = 50_000_000;
}

describe('salary · 预期薪资', () => {
  it('荣誉系数是凸函数：从 honorBase 起步（小俱乐部 < 1），荣誉越高增长越快，有上限', () => {
    expect(honorSalaryFactor(0)).toBe(CONFIG.salary.honorBase);
    expect(honorSalaryFactor(-500)).toBe(CONFIG.salary.honorBase);
    // 第八波平衡：新俱乐部（100 荣誉）低于市场、豪门（2000+）显著高于市场
    expect(honorSalaryFactor(100)).toBeLessThan(1);
    expect(honorSalaryFactor(2000)).toBeGreaterThan(1.3);
    withConfig('salary', { honorBase: 1 }, () => expect(honorSalaryFactor(0)).toBe(1));
    const xs = [0, 250, 500, 750, 1000, 1500, 2000, 2500, 3000];
    for (let i = 1; i < xs.length; i++) expect(honorSalaryFactor(xs[i])).toBeGreaterThan(honorSalaryFactor(xs[i - 1]));
    // 等距增量递增（凸）
    expect(honorSalaryFactor(1000) - honorSalaryFactor(500)).toBeGreaterThan(honorSalaryFactor(500) - honorSalaryFactor(0));
    expect(honorSalaryFactor(2500) - honorSalaryFactor(2000)).toBeGreaterThan(honorSalaryFactor(1000) - honorSalaryFactor(500));
    // 中点不等式
    for (const [a, b] of [[0, 1000], [500, 2500], [1000, 3000]]) {
      expect((honorSalaryFactor(a) + honorSalaryFactor(b)) / 2).toBeGreaterThanOrEqual(honorSalaryFactor((a + b) / 2));
    }
    expect(honorSalaryFactor(1e9)).toBe(CONFIG.salary.honorMaxFactor);
  });

  it('预期 = 市场工资 × 荣誉系数 × 明星系数；战队荣誉越高、等级越高预期越高', () => {
    const s = makeTestState(2);
    const p = me(s);
    const exp = expectedSalary(s, p);
    expect(exp).toBe(Math.round(computeSalary(s, p, false) * honorSalaryFactor(s.teams.t0.honor) * starSalaryFactor(s, p)));
    s.teams.t0.honor = 2000;
    expect(expectedSalary(s, p)).toBeGreaterThan(exp);
    const ss = me(s, 'M');
    ss.mmr = 12000; // SS
    expect(starSalaryFactor(s, ss)).toBeGreaterThan(starSalaryFactor(s, p));
    // 自由选手按 ×1 荣誉系数
    const fa = { ...p, teamId: null } as Player;
    expect(expectedSalary(s, fa)).toBe(Math.round(computeSalary(s, p, false) * starSalaryFactor(s, p)));
  });

  it('明星系数：近期冠军 / MVP 提高预期，按赛季衰减', () => {
    const s = makeTestState(2);
    const p = me(s);
    updateSalaryTrack(s, p); // 建立基线
    expect(playerFame(s, p)).toBe(0);
    const base = starSalaryFactor(s, p);
    p.stats.titles += 1;
    p.stats.tiTitles += 1;
    p.stats.mvp += 10;
    const F = CONFIG.salary.fame;
    const fame = F.title + F.tiTitle + 10 * F.mvp;
    expect(playerFame(s, p)).toBeCloseTo(fame);
    expect(starSalaryFactor(s, p)).toBeCloseTo(base * (1 + Math.min(F.maxBonus, fame * F.weight)));
    updateSalaryTrack(s, p);
    expect(playerFame(s, p)).toBeCloseTo(fame); // 计入后不重复计算
    s.season.ti += 1;
    expect(playerFame(s, p)).toBeCloseTo(fame * F.seasonDecay);
  });

  it('新秀合同期内不计薪资差，续约后结束', () => {
    const s = makeTestState(2);
    const p = me(s);
    p.isRookie = true;
    p.contractUntil = 11;
    setGap(s, p, 0.5);
    expect(salaryGap(s, p)).toBe(0);
    updateSalaryTrack(s, p);
    delete p.isRookie; // 登场赛季结束
    s.season.ti = 10;
    expect(onRookieContract(s, p)).toBe(true);
    expect(salaryGap(s, p)).toBe(0);
    expect(renewContract(s, p.id, 1).ok).toBe(true);
    expect(onRookieContract(s, p)).toBe(false);
  });
});

describe('salary · 归属感速度', () => {
  it('薪资差越大扣得越快（加速），宽限内为 0，薪水高于预期小幅加分', () => {
    const L = CONFIG.salary.loyalty;
    expect(salaryLoyaltyDelta(0)).toBe(0);
    expect(salaryLoyaltyDelta(L.gapGrace)).toBe(0);
    const d = [0.15, 0.25, 0.35, 0.45].map(salaryLoyaltyDelta);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThan(d[i - 1]);
    expect(d[1] - d[2]).toBeGreaterThan(d[0] - d[1]);
    expect(d[2] - d[3]).toBeGreaterThan(d[1] - d[2]);
    expect(salaryLoyaltyDelta(-0.5)).toBeGreaterThan(0);
  });

  it('roundLoyaltyUpdate：同等条件下薪资差越大，归属感下降越快', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 400; // S 级：无荣誉落差、无自豪加成
    const a = me(s, 'C');
    const b = me(s, 'M');
    const c = me(s, 'O');
    setGap(s, a, 0.15);
    setGap(s, b, 0.35);
    setGap(s, c, 0);
    roundLoyaltyUpdate(s);
    expect(c.loyalty).toBe(70);
    expect(a.loyalty).toBeLessThan(70);
    expect(b.loyalty).toBeLessThan(a.loyalty);
    expect(b.salaryTrack?.gap).toBeCloseTo(0.35, 2);
  });

  it('差距拉大（比上回合更大）时额外扣分', () => {
    expect(gapGrowthDelta(0.3, 0.2)).toBeLessThan(0);
    expect(gapGrowthDelta(0.3, 0.3)).toBe(0);
    expect(gapGrowthDelta(0.2, 0.3)).toBe(0);
    expect(gapGrowthDelta(0.3, undefined)).toBe(0);

    const s = makeTestState(2);
    s.teams.t0.honor = 400;
    const grow = me(s, 'C');
    const flat = me(s, 'M');
    setGap(s, grow, 0.3);
    setGap(s, flat, 0.3);
    recordSalaryGap(grow, 0.15, 't0');
    recordSalaryGap(flat, 0.3, 't0');
    expect(loyaltyEnvironment(s, grow).growth).toBeLessThan(0);
    expect(loyaltyEnvironment(s, flat).growth).toBe(0);
    roundLoyaltyUpdate(s);
    expect(grow.loyalty).toBeLessThan(flat.loyalty);
  });

  it('在队时长速度倍数：0.5 / 1 / 2 / 3（用户指定上限 ×3）', () => {
    expect([0, 1, 2, 3].map(tenureSpeedMult)).toEqual([0.5, 1, 2, 3]);
    expect(tenureSpeedMult(4)).toBe(CONFIG.salary.tenure.cap);
    expect(tenureSpeedMult(20)).toBe(CONFIG.salary.tenure.cap);
    withConfig('salary', { tenure: { firstSeasonMult: 0.5, growth: 2, cap: 3 } }, () => {
      expect(tenureSpeedMult(2)).toBe(2);
      expect(tenureSpeedMult(3)).toBe(3);
    });

    // 同样的薪资差，在队越久下降越快
    const s = makeTestState(2);
    s.teams.t0.honor = 400;
    const ps = ['C', 'M', 'O', 'SS'].map((pos) => me(s, pos));
    ps.forEach((p, i) => {
      p.joinedSeason = s.season.ti - i;
      setGap(s, p, 0.3);
    });
    roundLoyaltyUpdate(s);
    const drops = ps.map((p) => 70 - p.loyalty);
    expect(drops[0]).toBeGreaterThan(0);
    expect(drops[1] / drops[0]).toBeCloseTo(2, 1);
    expect(drops[2] / drops[0]).toBeCloseTo(4, 1);
    expect(drops[3] / drops[0]).toBeCloseTo(6, 1); // 上限 ×3（= 第一季 ×0.5 的 6 倍）
  });

  it('AI 战队沿用简化版：只有固定的荣誉落差扣分（不受薪资与在队时长影响）', () => {
    const s = makeTestState(2);
    s.teams.t1.honor = 10;
    const p = s.players['t1-C'];
    p.joinedSeason = s.season.ti - 5;
    setGap(s, p, 0.5);
    roundLoyaltyUpdate(s);
    expect(p.loyalty).toBeCloseTo(70 + CONFIG.loyalty.honorGapPenalty);
  });

  it('多人模式（中性上下文）：所有座位战队都按人类模型结算', () => {
    const s = makeTestState(3);
    s.teams.t1.isPlayer = true;
    s.settings.playerTeamId = '';
    const seat = (teamId: string) => ({ teamId, sessionId: teamId, name: teamId, eliminated: false, ready: false, saved: {} });
    s.multiplayer = { mode: 'build', hostTeamId: 't0', order: ['t0', 't1'], seats: { t0: seat('t0'), t1: seat('t1') }, activeSeat: null };
    for (const t of ['t0', 't1', 't2']) s.teams[t].honor = 400;
    const human = s.players['t1-C'];
    const ai = s.players['t2-C'];
    setGap(s, human, 0.35);
    setGap(s, ai, 0.35);
    roundLoyaltyUpdate(s);
    expect(human.loyalty).toBeLessThan(70);
    expect(ai.loyalty).toBe(70);
  });
});

describe('salary · 续约', () => {
  it('要价 ≥ 预期；报价低于预期被拒绝（不透露预期数值），满足要价则续约', () => {
    const s = makeTestState(2);
    const p = me(s);
    p.contractUntil = 9;
    setGap(s, p, 0.3);
    const exp = expectedSalary(s, p);
    const ask = renewalAsk(s, p);
    expect(ask).toBeGreaterThanOrEqual(exp);

    const low = renewContract(s, p.id, 1, Math.round(exp * 0.9));
    expect(low.ok).toBe(false);
    expect(low.message).toContain('心理预期');
    expect(low.message).not.toContain(String(exp));
    expect(p.contractUntil).toBe(9);

    const r = renewContract(s, p.id, 1);
    expect(r.ok).toBe(true);
    expect(p.salary).toBe(ask);
    expect(p.contractUntil).toBe(10);
    expect(playerSalaryMood(s, p)).toBe('satisfied');

    // 不低于预期的报价可以接受
    const q = me(s, 'M');
    q.contractUntil = 9;
    setGap(s, q, 0.2);
    const qExp = expectedSalary(s, q);
    expect(renewContract(s, q.id, 1, qExp).ok).toBe(true);
    expect(q.salary).toBe(qExp);
    expect(renewContract(s, q.id, 1, Number.NaN).ok).toBe(false);
  });

  it('归属感低时要价更高；合同到期决策给出要价与定性满意度', () => {
    const s = makeTestState(2);
    const p = me(s);
    p.loyalty = 80;
    const high = renewalAsk(s, p);
    p.loyalty = 20;
    expect(renewalAsk(s, p)).toBeGreaterThan(high);

    p.contractUntil = 9;
    setGap(s, p, 0.4);
    processContractExpiry(s);
    const d = s.pendingDecisions.find((x) => x.kind === 'contract' && x.ctx.playerId === p.id)!;
    expect(d.ctx.newSalary).toBe(renewalAsk(s, p));
    expect(d.body).toContain('强烈不满');
  });
});

describe('salary · 续约（复核）', () => {
  it('要价含隐藏浮动：始终 ≥ 预期且有上限，同一赛季固定；低薪选手不会因取整多要太多', () => {
    const R = CONFIG.salary.renew;
    const s = makeTestState(4);
    for (const t of ['t0', 't1', 't2', 't3']) {
      for (const pos of ['C', 'M', 'O', 'SS', 'HS']) {
        const p = s.players[`${t}-${pos}`];
        p.teamId = 't0';
        p.loyalty = 90; // 无低归属感溢价
        const exp = expectedSalary(s, p, 't0');
        const ask = renewalAsk(s, p);
        expect(ask).toBeGreaterThanOrEqual(exp);
        // 上限：markup + jitter，再加不超过两位有效数字的取整
        expect(ask).toBeLessThanOrEqual(exp * (1 + R.askMarkup + R.askJitter) * 1.1 + 1);
        expect(renewalAsk(s, p)).toBe(ask);
      }
    }
    // 低薪：最低工资附近的预期，要价涨幅不超过 markup + jitter + 2%
    const low = me(s, 'HS');
    low.loyalty = 90;
    low.mmr = 1000;
    low.power = 40;
    const lowExp = expectedSalary(s, low);
    expect(renewalAsk(s, low)).toBeLessThanOrEqual(Math.ceil(lowExp * (1 + R.askMarkup + R.askJitter + 0.02)));
    // 不同选手的浮动不同（要价 / 预期 的比值不全相同）
    const ratios = new Set(['C', 'M', 'O', 'SS'].map((pos) => {
      const p = me(s, pos);
      return Math.round((renewalAsk(s, p) / expectedSalary(s, p)) * 1000);
    }));
    expect(ratios.size).toBeGreaterThan(1);
  });

  it('合同到期决策在新赛季回合开始时按当前行情刷新要价，与实际续约一致', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    const p = me(s);
    p.contractUntil = 9;
    p.loyalty = 90;
    processContractExpiry(s);
    const d = s.pendingDecisions.find((x) => x.kind === 'contract' && x.ctx.playerId === p.id)!;
    const oldAsk = d.ctx.newSalary as number;
    // 进入新赛季：经济指数变化（2021 → 2022 指数下降）
    s.season.ti = 11;
    s.season.year = 2022;
    expect(renewalAsk(s, p)).not.toBe(oldAsk);
    processLoyaltyDepartures(s);
    expect(d.ctx.newSalary).toBe(renewalAsk(s, p));
    expect(d.body).toContain(`TI9 后到期`);
    refreshContractDecisions(s); // 幂等
    expect(d.ctx.newSalary).toBe(renewalAsk(s, p));
    const want = renewalAsk(s, p);
    expect(resolveDecision(s, d.id, 'renew_1').ok).toBe(true);
    expect(p.salary).toBe(want);
  });

  it('新秀合同只认选中他的战队：被别队选中后转投本队（按市场工资）照常计算薪资差', () => {
    const s = makeTestState(2);
    const own = me(s, 'C');
    const other = me(s, 'M');
    for (const p of [own, other]) {
      p.isRookie = true;
      p.contractUntil = 11;
      setGap(s, p, 0.5);
    }
    own.draft = { ti: 9, round: 1, pick: 3, teamId: 't0' };
    other.draft = { ti: 9, round: 1, pick: 4, teamId: 't1' };
    expect(onRookieContract(s, own)).toBe(true);
    expect(onRookieContract(s, other)).toBe(false);
    expect(salaryGap(s, other)).toBeCloseTo(0.5, 2);
    roundLoyaltyUpdate(s);
    expect(own.salaryTrack?.rookieTeamId).toBe('t0');
    expect(other.salaryTrack?.rookieTeamId).toBeUndefined();
    expect(onRookieContract(s, own)).toBe(true);
    expect(onRookieContract(s, other)).toBe(false);
  });

  it('合同已到期、等待续约决定的选手不上「对薪资不满」新闻', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    s.roundIndex = 2;
    const p = me(s);
    setGap(s, p, 0.5);
    p.contractUntil = s.season.ti - 1;
    processLoyaltyDepartures(s);
    expect(s.news.some((n) => n.title.includes(`${p.handle} 对薪资不满`))).toBe(false);
  });

  it('拒绝对薪资强烈不满者的挖角报价：归属感下降（与决策提示一致）', () => {
    const s = makeTestState(4);
    s.phase = 'regular';
    s.roundIndex = 2;
    richAi(s);
    const target = me(s, 'C');
    target.loyalty = 50;
    setGap(s, target, 0.45);
    const force = { ...CONFIG.salary.poach, unhappyStarPoachChance: 1, unhappyStarPoachMax: 1 };
    withConfig('salary', { poach: force }, () => processLoyaltyDepartures(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'poach' && x.ctx.playerId === target.id)!;
    expect(d).toBeTruthy();
    expect(resolveDecision(s, d.id, 'decline').ok).toBe(true);
    expect(target.loyalty).toBeCloseTo(50 + CONFIG.market.declineLoyaltyPenalty);
    expect(target.teamId).toBe('t0');
  });
});

describe('salary · 加薪', () => {
  it('预览给出加薪前后的定性满意度；对薪资不满时加薪的归属感收益更高', () => {
    const s = makeTestState(2);
    const unhappy = me(s, 'C');
    const happy = me(s, 'M');
    unhappy.loyalty = 60;
    happy.loyalty = 60;
    setGap(s, unhappy, 0.4);
    setGap(s, happy, -0.2);
    const pu = raiseSalaryPreview(s, unhappy.id, 30);
    const ph = raiseSalaryPreview(s, happy.id, 30);
    expect(pu.moodBefore).toBe('strong');
    expect(pu.moodAfter).not.toBe('strong');
    expect(ph.moodBefore).toBe('satisfied');
    expect(ph.moodAfter).toBe('satisfied');
    expect(pu.loyaltyGain).toBeGreaterThan(ph.loyaltyGain);
    expect(ph.loyaltyGain).toBeCloseTo(CONFIG.squadOps.raiseLoyalty[30] * (1 - 60 / CONFIG.squadOps.loyaltyDiminishDivisor), 1);
  });
});

describe('salary · 外部兴趣与不满', () => {
  it('AI 报价权重与概率随薪资差提高', () => {
    expect(offerGapWeight(0)).toBe(1);
    expect(offerGapWeight(0.2)).toBeGreaterThan(offerGapWeight(0.1));
    expect(offerGapWeight(-0.5)).toBe(1);
    const base = CONFIG.market.aiOfferChancePerRound;
    expect(aiOfferChance(base, 0)).toBeCloseTo(base);
    expect(aiOfferChance(base, 0.3)).toBeGreaterThan(aiOfferChance(base, 0.1));
    expect(aiOfferChance(base, 1)).toBeLessThanOrEqual(Math.max(base, CONFIG.salary.poach.offerChanceMax));
  });

  it('generateAiOffers：对薪资不满的选手更常成为报价目标', () => {
    const count = (gap: number): number => {
      let hits = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const s = makeTestState(4, seed * 7919);
        richAi(s);
        const target = me(s, 'C');
        for (const pos of ['C', 'M', 'O', 'SS', 'HS']) setGap(s, me(s, pos), 0);
        setGap(s, target, gap);
        withConfig('market', { aiOfferChancePerRound: 1 }, () => generateAiOffers(s));
        if (s.transferOffers[0]?.playerId === target.id) hits++;
      }
      return hits;
    };
    const base = count(0);
    const unhappy = count(0.4);
    expect(base).toBeGreaterThan(20);
    expect(unhappy).toBeGreaterThan(base * 1.5);
  });

  it('挖角：薪资强烈不满的明星（归属感尚可）也会被盯上；满意者不会', () => {
    const p = { mmr: 9000 } as Player;
    expect(unhappyStarPoachChance({ ...p, modifiers: [] } as Player, 50, 0.1)).toBe(0);
    const star = makeTestState(2).players['t0-C'];
    const strong = CONFIG.salary.mood.strongGap;
    expect(unhappyStarPoachChance(star, 50, strong + 0.1)).toBeGreaterThan(unhappyStarPoachChance(star, 50, strong));
    expect(unhappyStarPoachChance(star, CONFIG.salary.poach.unhappyStarLoyaltyMax, 0.5)).toBe(0);
    const low = { ...star, mmr: 5600 } as Player;
    expect(unhappyStarPoachChance(low, 50, 0.5)).toBe(0);

    const s = makeTestState(4);
    s.phase = 'regular';
    richAi(s);
    const target = me(s, 'C');
    const fine = me(s, 'M');
    target.loyalty = 50;
    fine.loyalty = 50;
    setGap(s, target, 0.45);
    setGap(s, fine, 0);
    withConfig('salary', { poach: { ...CONFIG.salary.poach, unhappyStarPoachChance: 1, unhappyStarPoachMax: 1 } }, () =>
      processLoyaltyDepartures(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'poach');
    expect(d?.ctx.playerId).toBe(target.id);
    expect(d?.body).toContain('对薪资不满');
    expect(s.pendingDecisions.some((x) => x.ctx.playerId === fine.id)).toBe(false);
  });

  it('冷却：同一选手的「薪资不满挖角」本赛季内有间隔；离队申请被挽留后有冷静期', () => {
    const s = makeTestState(4);
    s.phase = 'regular';
    s.roundIndex = 2;
    richAi(s);
    const target = me(s, 'C');
    target.loyalty = 50;
    setGap(s, target, 0.45);
    const force = { ...CONFIG.salary.poach, unhappyStarPoachChance: 1, unhappyStarPoachMax: 1 };
    const poachOnce = () => withConfig('salary', { poach: force }, () => processLoyaltyDepartures(s));
    poachOnce();
    const d = s.pendingDecisions.find((x) => x.kind === 'poach')!;
    expect(d).toBeTruthy();
    expect(resolveDecision(s, d.id, 'decline').ok).toBe(true);
    s.roundIndex += 1;
    poachOnce();
    expect(s.pendingDecisions.some((x) => x.kind === 'poach')).toBe(false);
    s.roundIndex += CONFIG.salary.poach.unhappyStarCooldownRounds;
    poachOnce();
    expect(s.pendingDecisions.some((x) => x.kind === 'poach' && x.ctx.playerId === target.id)).toBe(true);

    const s2 = makeTestState(2);
    s2.phase = 'regular';
    s2.roundIndex = 2;
    const p = me(s2);
    p.loyalty = 5;
    const leaveOnce = () => withConfig('loyalty', { leaveChancePerRound: 1, poachChancePerRound: 0 }, () => processLoyaltyDepartures(s2));
    leaveOnce();
    const lr = s2.pendingDecisions.find((x) => x.kind === 'leave_request')!;
    expect(resolveDecision(s2, lr.id, 'raise').ok).toBe(true);
    p.loyalty = 5;
    s2.roundIndex += 1;
    leaveOnce();
    expect(s2.pendingDecisions.some((x) => x.kind === 'leave_request')).toBe(false);
    s2.roundIndex += CONFIG.salary.loyalty.retainCalmRounds;
    leaveOnce();
    expect(s2.pendingDecisions.some((x) => x.kind === 'leave_request' && x.ctx.playerId === p.id)).toBe(true);
  });

  it('低归属感时，薪资差越大越容易提出离队申请', () => {
    const run = (gap: number): number => {
      let n = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const s = makeTestState(2, seed * 104729);
        s.phase = 'regular';
        const p = me(s);
        p.loyalty = 10;
        setGap(s, p, gap);
        withConfig('loyalty', { poachChancePerRound: 0 }, () => processLoyaltyDepartures(s));
        if (s.pendingDecisions.some((d) => d.kind === 'leave_request' && d.ctx.playerId === p.id)) n++;
      }
      return n;
    };
    expect(run(0.4)).toBeGreaterThan(run(0) * 1.3);
  });

  it('「对薪资不满」公开新闻：进入强烈不满时发布，冷却期内不重复', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    s.roundIndex = 2;
    const p = me(s);
    setGap(s, p, 0.45);
    processLoyaltyDepartures(s);
    const hits = () => s.news.filter((n) => n.title.includes(`${p.handle} 对薪资不满`));
    expect(hits()).toHaveLength(1);
    expect(hits()[0].visibility).toBe('public');
    expect(hits()[0].playerIds).toContain(p.id);
    processLoyaltyDepartures(s);
    expect(hits()).toHaveLength(1);
    s.roundIndex += CONFIG.salary.newsCooldownRounds;
    processLoyaltyDepartures(s);
    expect(hits()).toHaveLength(2);
    // 满意的选手不上新闻
    expect(s.news.some((n) => n.title.includes(`${me(s, 'M').handle} 对薪资不满`))).toBe(false);
  });

  it('界面情绪只给定性描述，不含数值', () => {
    const s = makeTestState(2);
    const p = me(s);
    for (const g of [0, 0.15, 0.4]) {
      setGap(s, p, g);
      const m = playerMoodSummary(s, p);
      expect(m.salary).toBe(salaryMoodOf(g));
      for (const text of [m.salaryLabel, m.overallLabel, ...m.notes]) expect(text).not.toMatch(/\d/);
    }
    expect(playerMoodSummary(s, p).salaryLabel).toBe('强烈不满');
  });
});

describe('salary · 第八波平衡（签约工资 / 开局工资对齐）', () => {
  it('signingSalary：小俱乐部按市场工资；高荣誉俱乐部按地位开价（≥ 预期，含隐藏浮动），同一赛季固定', () => {
    const s = makeTestState(2);
    const p = me(s, 'C');
    const fa = { ...p, id: 'fa-x', teamId: null } as Player;
    s.players[fa.id] = fa;
    const market = computeSalary(s, fa, false);
    s.teams.t0.honor = 100;
    expect(signingSalary(s, fa, 't0')).toBe(market);
    s.teams.t0.honor = 2400;
    const sal = signingSalary(s, fa, 't0');
    const exp = expectedSalary(s, fa, 't0');
    const R = CONFIG.salary.renew;
    expect(sal).toBeGreaterThanOrEqual(exp);
    expect(sal).toBeGreaterThan(market);
    expect(sal).toBeLessThanOrEqual(Math.ceil(exp * (1 + R.askMarkup + R.askJitter)) + R.askRounding);
    expect(signingSalary(s, fa, 't0')).toBe(sal);
    expect(signingSalary(s, fa, 'missing-team')).toBe(market);
  });

  it('高荣誉俱乐部签下自由选手：按 signingSalary 定薪，新援不会一加盟就对薪资不满', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 2400;
    s.teams.t0.gold = 50_000_000;
    // 腾出一个名额，并把一名 AI 选手转为自由身（意愿拉满）
    const src = s.players['t1-C'];
    s.teams.t1.playerIds = s.teams.t1.playerIds.filter((id) => id !== src.id);
    s.teams.t1.lineup.C = null;
    src.teamId = null;
    const want = signingSalary(s, src, 't0');
    const res = withConfig('market', { willingnessRange: [1, 1] }, () => signFreeAgent(s, src.id));
    expect(res.ok).toBe(true);
    expect(src.teamId).toBe('t0');
    expect(src.salary).toBe(want);
    expect(salaryGap(s, src)).toBeLessThanOrEqual(0);
    expect(playerSalaryMood(s, src)).toBe('satisfied');
  });

  it('alignInitialSalaries：接管豪门时工资对齐到预期 × initialPay.range（只上调，新秀合同除外）', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 2200;
    const ps = ['C', 'M', 'O', 'SS', 'HS'].map((pos) => me(s, pos));
    for (const p of ps) p.salary = computeSalary(s, p, false);
    const rookie = ps[4];
    rookie.isRookie = true; // 无选秀记录的新秀 = 新秀合同期
    const rookieSalary = rookie.salary;
    const rich = ps[3];
    rich.salary = expectedSalary(s, rich) * 2;
    const before = ps.map((p) => p.salary);
    const n = alignInitialSalaries(s, 't0');
    expect(n).toBe(3);
    const [lo] = CONFIG.salary.initialPay.range;
    for (const p of ps.slice(0, 3)) {
      expect(salaryGap(s, p)).toBeLessThanOrEqual(1 - lo + 0.001);
      expect(playerSalaryMood(s, p)).not.toBe('strong');
    }
    ps.forEach((p, i) => expect(p.salary).toBeGreaterThanOrEqual(before[i]));
    expect(rookie.salary).toBe(rookieSalary);
    // 确定性：重复调用不再变化
    const after = ps.map((p) => p.salary);
    alignInitialSalaries(s, 't0');
    expect(ps.map((p) => p.salary)).toEqual(after);
  });

  it('createNewGame 接管高荣誉真实俱乐部：开局没有选手对薪资强烈不满；新俱乐部工资不变', async () => {
    const { registerNodeRosterLoader } = await import('../scripts/nodeData');
    const { createNewGame } = await import('../src/engine/game');
    registerNodeRosterLoader();
    const g = await createNewGame({ startTi: 13, seasons: 1, difficulty: 'normal', managerName: 't', seed: 7, teamId: 'team-liquid' });
    const team = g.teams['team-liquid'];
    expect(team.honor).toBeGreaterThan(2000);
    const regs = team.playerIds.map((id) => g.players[id]).filter((p) => p && p.status === 'active' && !p.tempSubUntilTournament);
    expect(regs.length).toBeGreaterThanOrEqual(5);
    for (const p of regs) expect(playerSalaryMood(g, p)).not.toBe('strong');
    const n = await createNewGame({
      startTi: 13, seasons: 1, difficulty: 'normal', managerName: 't', seed: 7,
      newClub: { name: 'Pay Test', tag: 'PT', region: 'CN', color: '#123456' },
    });
    const nt = n.teams[n.settings.playerTeamId];
    for (const id of nt.playerIds) {
      const p = n.players[id];
      if (p && !p.draft) expect(p.salary).toBe(computeSalary(n, p));
    }
  });
});
