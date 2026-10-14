// 新秀抽卡（src/engine/gacha.ts，2026-10-14 用户决策：抽卡回归并取代选秀）与通用概率工具（gachaOdds.ts）：
// 卡池张数严格按【用户指定】比例（100 张时 = 百分比）、真实新秀先占名额（超出时按比例放大）、请神只匹配出道等级、每原型上限、
// 年代价格、SSR 保底、绝对上限、本回合退回、卡池关闭时真实新秀按出道去向加盟、AI 抽卡受资金约束、确定性、多人共享卡池。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Player, Tier } from '../src/engine/types';
import { TIERS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { getPlayerIndex, getTrajectory } from '../src/data/index';
import {
  aiGachaPulls, aiPullAllowance, closeGachaPool, createSummonRookie, currentGachaPool, gachaDiscard, gachaDiscardBlock,
  gachaDiscardRefund, gachaLog, gachaOverCapAfter, gachaPrice, gachaPriceForTi, gachaPull, gachaPullBlock, gachaView, luckAdjustedWeights,
  poolRemaining, prdConstant, startGachaSeason, teamGachaPull, tierCounts,
} from '../src/engine/gacha';
import { hofMember } from '../src/engine/hallOfFame';
import { roundWageBill } from '../src/engine/economy';
import { playerTier, tierOf } from '../src/engine/player';
import { rosterSize } from '../src/engine/team';
import { advance, createNewGame, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import * as M from '../src/engine/multi';
import { makePlayer, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** PRD 常数 c 对应的长期平均概率（1 / 期望次数） */
function prdAverage(c: number): number {
  let notYet = 1;
  let expected = 0;
  for (let k = 1; notYet > 1e-12; k++) {
    const pk = Math.min(1, c * k);
    expected += k * notYet * pk;
    notYet *= 1 - pk;
  }
  return 1 / expected;
}

describe('gachaOdds（通用概率工具）', () => {
  it('PRD 常数：长期平均概率 ≈ 名义概率，且 C < p', () => {
    for (const p of [0.01, 0.05, 0.25]) {
      const c = prdConstant(p);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(p);
      expect(prdAverage(c)).toBeCloseTo(p, 4);
    }
    expect(prdConstant(0)).toBe(0);
    expect(prdConstant(1)).toBe(1);
    expect(prdConstant(Number.NaN)).toBe(0);
  });

  it('荣誉幸运度修正：luck 0 为基础权重，luck 越高高等级权重越大', () => {
    const base = CONFIG.tempSub.baseWeights;
    const w0 = luckAdjustedWeights(base, 0);
    for (const t of TIERS) expect(w0[t]).toBeCloseTo(Math.max(0, base[t] ?? 0), 9);
    const hi = luckAdjustedWeights(base, 2);
    expect(hi.S / hi.C).toBeGreaterThan(w0.S / w0.C);
    expect(luckAdjustedWeights(base, Number.NaN)).toEqual(w0);
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 本届（TI9）登场的真实新秀：[id, 出道等级]（按 id 排序） */
function ti9Rookies(): [string, Tier][] {
  return getPlayerIndex()
    .filter((e) => e.firstTi === 9)
    .map((e) => [e.id, getTrajectory(e.id)![9].tier] as [string, Tier])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** 卡池各等级发出的张数合计 */
function madeTotal(s: GameState, t: Tier): number {
  const m = currentGachaPool(s)?.made[t] ?? [0, 0, 0];
  return m[0] + m[1] + m[2];
}

/** 把战队正式阵容裁到 n 人（测试用：直接移出名单） */
function trimTo(s: GameState, teamId: string, n: number): void {
  const t = s.teams[teamId];
  for (const id of t.playerIds.slice(n)) {
    s.players[id].teamId = null;
    for (const pos of Object.keys(t.lineup) as (keyof typeof t.lineup)[]) if (t.lineup[pos] === id) t.lineup[pos] = null;
  }
  t.playerIds = t.playerIds.slice(0, n);
}

describe('gacha · 卡池构成', () => {
  it('【用户指定】比例：100 张时各等级张数 = 百分比（SSR 5 / SS 10 / S 10 / A 15 / B 30 / C 30），20 张一档也全是整数', () => {
    expect(tierCounts(100)).toEqual({ C: 30, B: 30, A: 15, S: 10, SS: 10, SSR: 5 });
    expect(tierCounts(20)).toEqual({ C: 6, B: 6, A: 3, S: 2, SS: 2, SSR: 1 });
    expect(tierCounts(260)).toEqual({ C: 78, B: 78, A: 39, S: 26, SS: 26, SSR: 13 });
    const s = makeTestState(8);
    const pool = startGachaSeason(s)!;
    expect(pool.ti).toBe(9);
    expect(pool.size).toBe(100);
    expect(pool.base).toBe(100);
    expect(pool.enlargedBy).toBeUndefined();
    expect(poolRemaining(pool)).toBe(100);
    for (const t of TIERS) expect(madeTotal(s, t)).toBe(tierCounts(100)[t]);
    // 同一赛季只建一次
    expect(startGachaSeason(s)).toBe(pool);
  });

  it('非真实名额按 summonShare 放请神卡（受可用原型数与每原型上限约束），其余为虚构新秀；请神只匹配出道等级', () => {
    const s = makeTestState(8);
    const pool = startGachaSeason(s)!;
    for (const t of TIERS) {
      const [real, summon, fic] = pool.made[t] ?? [0, 0, 0];
      expect(real).toBe(0); // 新游戏第一个赛季：本届真实新秀都在开局阵容里
      const protos = (s.hallOfFame?.members ?? []).filter((m) => m.debutTier === t && m.src !== 'summon').length;
      const want = Math.round(CONFIG.gacha.summonShare * tierCounts(100)[t]);
      expect(summon).toBe(Math.min(want, protos * CONFIG.gacha.summonMaxPerPrototype));
      expect(fic).toBe(tierCounts(100)[t] - summon);
      for (const id of pool.summon[t] ?? []) expect(hofMember(s, id)?.debutTier).toBe(t);
    }
    // 初始名人堂（DotA1 时代传奇 + TI9 之前真实 SS / SSR 的开局补录）的出道等级都在 A 以上：B / C 没有请神卡
    expect(pool.made.SSR![1]).toBeGreaterThan(0);
    expect(pool.made.A![1]).toBeGreaterThan(0);
    expect(pool.made.B![1]).toBe(0);
    expect(pool.made.C![1]).toBe(0);
  });

  it('真实新秀先占各自等级的名额；超出时按 20 张一档放大卡池（比例不变）并记录', () => {
    const s = makeTestState(8);
    const rookies = ti9Rookies();
    const byTier = new Map<Tier, string[]>();
    for (const [id, t] of rookies) byTier.set(t, [...(byTier.get(t) ?? []), id]);
    // 全部本届真实新秀：S 级远超 10 张 → 放大
    for (const [id] of rookies) s.futureRookies[id] = 9;
    const pool = startGachaSeason(s)!;
    const sCount = byTier.get('S')!.length;
    expect(sCount).toBeGreaterThan(10);
    expect(pool.size % CONFIG.gacha.poolStep).toBe(0);
    expect(pool.size).toBe(Math.ceil(sCount / 2) * 20); // S 占 10%：每 20 张 2 张
    expect(pool.enlargedBy).toContain('S');
    for (const t of TIERS) {
      expect(madeTotal(s, t)).toBe(tierCounts(pool.size)[t]);
      expect(pool.made[t]![0]).toBe(byTier.get(t)?.length ?? 0);
      expect([...(pool.real[t] ?? [])].sort()).toEqual((byTier.get(t) ?? []).slice().sort());
    }
    // 卡池中的真实新秀尚未进入本局（保留在 futureRookies 中，抽中或卡池关闭时才生成）
    for (const [id] of rookies) {
      expect(s.players[id]).toBeUndefined();
      expect(s.futureRookies[id]).toBe(9);
    }
  });

  it('少量真实新秀：只占名额，其余名额照常放请神 / 虚构；抽中真实新秀 = 真实身份 + 出道届的真实水平 + 当届真实位置', () => {
    const s = makeTestState(8);
    const three = ti9Rookies().filter(([, t]) => t === 'S').slice(0, 3);
    for (const [id] of three) s.futureRookies[id] = 9;
    const pool = startGachaSeason(s)!;
    expect(pool.size).toBe(100);
    expect(pool.made.S).toEqual([3, Math.round(CONFIG.gacha.summonShare * 7), 7 - Math.round(CONFIG.gacha.summonShare * 7)]);
    // 只留真实卡，抽一张
    pool.summon = {};
    pool.fictional = {};
    const [res] = teamGachaPull(s, 't1', 1, { ai: true });
    const p = s.players[res.playerId];
    const id = res.playerId;
    expect(three.map((x) => x[0])).toContain(id);
    expect(res.kind).toBe('real');
    expect(p.isReal).toBe(true);
    expect(p.isRookie).toBe(true);
    expect(p.teamId).toBe('t1');
    const pt = getTrajectory(id)![9];
    expect(p.mmr).toBe(pt.mmr);
    expect(p.power).toBe(pt.power);
    expect(playerTier(p)).toBe(res.tier);
    expect(p.gacha).toMatchObject({ ti: 9, teamId: 't1', tier: res.tier, kind: 'real' });
    expect(p.contractUntil).toBe(9 + CONFIG.gacha.rookieContractSeasons - 1);
    expect(s.futureRookies[id]).toBeUndefined();
  });
});

describe('gacha · 抽卡', () => {
  it('卡池内均匀不放回：抽完 100 张恰好是卡池构成；再抽触发同比例的补充卡池（只含请神与虚构），每原型每赛季至多 2 张', () => {
    const s = makeTestState(4);
    startGachaSeason(s);
    const counts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
    const res = teamGachaPull(s, 't1', 100, { ai: true });
    for (const r of res) counts[r.tier]++;
    expect(counts).toEqual(tierCounts(100));
    const pool = currentGachaPool(s)!;
    expect(poolRemaining(pool)).toBe(0);
    expect(pool.drawn).toBe(100);
    const more = teamGachaPull(s, 't1', 150, { ai: true });
    expect(more).toHaveLength(150);
    expect(pool.refills).toBe(2);
    expect(pool.size).toBe(300);
    expect(poolRemaining(pool)).toBe(50);
    for (const [id, n] of Object.entries(pool.protoUsed)) expect(n, id).toBeLessThanOrEqual(CONFIG.gacha.summonMaxPerPrototype);
    // 补充卡池没有真实新秀
    for (const t of TIERS) expect(pool.made[t]![0]).toBe(0);
    // 请神新秀绑定原型、出道等级与卡相同
    for (const r of [...res, ...more].filter((x) => x.kind === 'summon')) {
      const p = s.players[r.playerId];
      expect(p.summon?.id).toBe(r.proto);
      expect(hofMember(s, r.proto)?.debutTier).toBe(r.tier);
      expect(playerTier(p)).toBe(r.tier);
    }
  });

  it('价格随年代缩放：单抽 = 1 万 × econIndex(年份) / econIndex(2011)，十连 = 10 × 单抽', () => {
    expect(gachaPriceForTi(1)).toEqual({ single: 10000, ten: 100000 });
    expect(gachaPriceForTi(9)).toEqual({ single: 40000, ten: 400000 });
    expect(gachaPriceForTi(13)).toEqual({ single: 24000, ten: 240000 });
    const s = makeTestState(4);
    expect(gachaPrice(s)).toEqual(gachaPriceForTi(9));
  });

  it('单抽扣款、新秀入队；十连 / 单抽总是抽满（可超出绝对上限，已超编时先退回才能再抽）；金币不足 / 窗口锁定同样拦下', () => {
    const s = makeTestState(4);
    startGachaSeason(s);
    const me = s.teams.t0;
    const { single, ten } = gachaPrice(s);
    expect(gachaPullBlock(s, 1)).toBeNull();
    // 2026-10-15 用户决策「十连后本回合内退回到 12 人」：5 + 10 > 12 也可以十连（抽完超编 3 人）
    expect(gachaPullBlock(s, 10)).toBeNull();
    expect(gachaOverCapAfter(s, 10)).toBe(3);
    expect(gachaOverCapAfter(s, 1)).toBe(0);
    const gold = me.gold;
    const r = gachaPull(s, 1);
    expect(r.ok).toBe(true);
    expect(me.gold).toBe(gold - single);
    expect(rosterSize(s, 't0')).toBe(6);
    expect(s.finance.some((f) => f.category === 'gacha' && f.amount === -single)).toBe(true);
    expect(gachaLog(s)).toHaveLength(1);
    // 阵容 2 人时可以十连
    trimTo(s, 't0', 2);
    expect(gachaPullBlock(s, 10)).toBeNull();
    const r10 = gachaPull(s, 10);
    expect(r10.ok).toBe(true);
    expect(r10.results).toHaveLength(10);
    expect(rosterSize(s, 't0')).toBe(12);
    // 阵容 12 人：单抽同样可以超出 1 人；超编后不能再抽
    expect(gachaPullBlock(s, 1)).toBeNull();
    expect(gachaOverCapAfter(s, 1)).toBe(1);
    const r13 = gachaPull(s, 1);
    expect(r13.ok).toBe(true);
    expect(r13.message).toContain('超编 1 人');
    expect(rosterSize(s, 't0')).toBe(13);
    expect(gachaPullBlock(s, 1)).toContain('超编');
    expect(gachaPullBlock(s, 10)).toContain('超编');
    expect(gachaPull(s, 1).ok).toBe(false);
    // 金币不足
    trimTo(s, 't0', 5);
    me.gold = single - 1;
    expect(gachaPullBlock(s, 1)).toContain('金币不足');
    me.gold = ten * 10;
    expect(gachaPullBlock(s, 3)).toBe('只能单抽或十连');
    // 转会窗口锁定
    s.phase = 'ti_qualifier';
    expect(gachaPullBlock(s, 1)).toContain('转会窗口');
  });

  it('SSR 保底：距上一张 SSR 第 100 抽必出 SSR（计数在战队上）；卡池已无 SSR 时补发一张', () => {
    const s = makeTestState(4);
    startGachaSeason(s);
    const t = s.teams.t1;
    t.gacha = { pity: CONFIG.gacha.pityThreshold - 1, pulls: 0 };
    const [r] = teamGachaPull(s, 't1', 1, { ai: true });
    expect(r.tier).toBe('SSR');
    expect(r.pity).toBe(true);
    expect(t.gacha.pity).toBe(0);
    // 卡池里没有 SSR 了
    const pool = currentGachaPool(s)!;
    delete pool.real.SSR;
    delete pool.summon.SSR;
    delete pool.fictional.SSR;
    t.gacha.pity = CONFIG.gacha.pityThreshold - 1;
    const [r2] = teamGachaPull(s, 't1', 1, { ai: true });
    expect(r2.tier).toBe('SSR');
    expect(pool.bonus).toBe(1);
    // 普通抽卡：非 SSR 计数 +1
    t.gacha.pity = 10;
    const [r3] = teamGachaPull(s, 't1', 1, { ai: true });
    expect(t.gacha.pity).toBe(r3.tier === 'SSR' ? 0 : 11);
  });

  it('本回合内退回：离队进入自由市场、返还单抽价格 × 20%，不扣荣誉；其他回合 / 他人新秀不能退回；releasePlayer 同样按退回处理', () => {
    const s = makeTestState(4);
    startGachaSeason(s);
    const me = s.teams.t0;
    const { single } = gachaPrice(s);
    const r = gachaPull(s, 1);
    const pid = r.results![0].playerId;
    const gold = me.gold;
    const honor = me.honor;
    expect(gachaDiscardRefund(s)).toBe(Math.round(single * CONFIG.gacha.discardRefundRatio));
    const d = gachaDiscard(s, pid);
    expect(d.ok).toBe(true);
    expect(s.players[pid].teamId).toBeNull();
    expect(me.gold).toBe(gold + gachaDiscardRefund(s));
    expect(me.honor).toBe(honor);
    expect(gachaLog(s)[0].discarded).toBe(true);
    expect(gachaDiscard(s, pid).ok).toBe(false);
    // 下一回合不能退回
    const r2 = gachaPull(s, 1);
    const pid2 = r2.results![0].playerId;
    s.roundIndex = 1;
    s.phase = 'regular';
    expect(gachaDiscardBlock(s, s.players[pid2])).toContain('同一回合');
    // 别队的新秀
    const [ai] = teamGachaPull(s, 't1', 1, { ai: true });
    expect(gachaDiscard(s, ai.playerId).ok).toBe(false);
    // releasePlayer（任何解约入口）对本回合抽到的新秀 = 退回
    const r3 = gachaPull(s, 1);
    const pid3 = r3.results![0].playerId;
    const g3 = me.gold;
    return import('../src/engine/market').then(({ releasePlayer, releaseCompensation }) => {
      expect(releaseCompensation(s, pid3)).toBe(0);
      expect(releasePlayer(s, pid3).ok).toBe(true);
      expect(me.gold).toBe(g3 + gachaDiscardRefund(s));
      expect(me.honor).toBe(honor);
    });
  });

  it('同一状态、同一操作序列结果完全一致（确定性）', () => {
    const run = () => {
      const s = makeTestState(6, 4242);
      for (const [id] of ti9Rookies().slice(0, 6)) s.futureRookies[id] = 9;
      startGachaSeason(s);
      const a = gachaPull(s, 1).results!.map((x) => `${x.tier}:${x.kind}:${x.handle}`);
      const b = teamGachaPull(s, 't2', 20, { ai: true }).map((x) => `${x.tier}:${x.kind}:${x.proto ?? ''}`);
      return { a, b, rng: s.rngState, pool: JSON.stringify(currentGachaPool(s)) };
    };
    expect(run()).toEqual(run());
  });
});

describe('gacha · AI 抽卡与卡池关闭', () => {
  it('AI 抽卡受资金盈余（留足 reserveRounds 回合工资）、阵容空位与每赛季上限约束；穷队不抽', () => {
    const s = makeTestState(6);
    startGachaSeason(s);
    s.phase = 'regular';
    s.roundIndex = 1;
    const price = gachaPrice(s).single;
    const rich = s.teams.t1;
    const poor = s.teams.t2;
    rich.gold = 50_000_000;
    poor.gold = roundWageBill(s, 't2') * CONFIG.gacha.ai.reserveRounds + price - 1; // 差 1 金币才够一抽
    expect(aiPullAllowance(s, poor, 'opening')).toBe(0);
    expect(aiPullAllowance(s, rich, 'opening')).toBe(Math.min(CONFIG.gacha.ai.openingMax, CONFIG.gacha.aiMaxPullsPerSeason));
    const before = { rich: rich.gold, poor: poor.gold };
    aiGachaPulls(s, 'opening');
    expect(poor.gold).toBe(before.poor);
    expect(poor.gacha?.pulls ?? 0).toBe(0);
    const n1 = rich.gacha!.seasonPulls!;
    expect(n1).toBeGreaterThan(0);
    expect(rich.gold).toBe(before.rich - n1 * price);
    // 赛季中期：补满本赛季上限
    aiGachaPulls(s, 'midseason');
    expect(rich.gacha!.seasonPulls).toBeLessThanOrEqual(CONFIG.gacha.aiMaxPullsPerSeason);
    aiGachaPulls(s, 'midseason');
    expect(rich.gacha!.seasonPulls).toBeLessThanOrEqual(CONFIG.gacha.aiMaxPullsPerSeason);
    // 抽完整理阵容：不超过 AI 阵容上限
    for (const t of Object.values(s.teams)) if (!t.isPlayer) expect(rosterSize(s, t.id)).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    // 人类玩家战队不被 AI 代抽
    expect(s.teams.t0.gacha?.pulls ?? 0).toBe(0);
    expect(currentGachaPool(s)!.aiDrawn).toBe(Object.values(s.teams).reduce((a, t) => a + (t.isPlayer ? 0 : t.gacha?.pulls ?? 0), 0));
  });

  it('卡池关闭（TI 预选赛转会锁定）：未被抽走的真实新秀全部进入本局，付得起的 AI 战队签下，否则进入自由市场；记录本届汇总', () => {
    const s = makeTestState(8);
    const rookies = ti9Rookies().slice(0, 8);
    for (const [id] of rookies) s.futureRookies[id] = 9;
    startGachaSeason(s);
    for (const t of Object.values(s.teams)) if (!t.isPlayer) t.gold = 5_000_000;
    s.teams.t7.gold = 0; // 付不起
    s.phase = 'ti_qualifier';
    const rec = closeGachaPool(s)!;
    expect(rec.ti).toBe(9);
    expect(rec.realJoined + rec.realFree).toBe(rookies.length);
    expect(s.gacha!.pool).toBeNull();
    expect(s.gacha!.history.at(-1)).toEqual(rec);
    for (const [id, tier] of rookies) {
      const p = s.players[id];
      expect(p, id).toBeTruthy();
      expect(s.futureRookies[id]).toBeUndefined();
      expect(p.gacha).toMatchObject({ kind: 'real', tier, placed: true });
      if (p.teamId) {
        expect(s.teams[p.teamId].isPlayer).toBe(false);
        expect(p.teamId).not.toBe('t7');
      }
    }
    expect(currentGachaPool(s)).toBeNull();
    expect(gachaView(s).open).toBe(false);
    expect(gachaPullBlock(s, 1)).toContain('转会窗口');
  });
});

describe('gacha · 请神新秀', () => {
  it('合成轨迹原型（2009）：复制出道战力 / 天梯 / 天赋 / 灵性 / 位置 / 招牌英雄 / 出道年龄；之后的成长目标按原型生涯平移', async () => {
    const { trajectoryOf, developmentTarget } = await import('../src/engine/development');
    const { rngOf } = await import('../src/engine/rng');
    const s = makeTestState(4);
    const m = hofMember(s, '2009')!;
    expect(m.src).toBe('seed');
    expect(m.debutTier).toBe('SS');
    const p = createSummonRookie(s, m, 'SS')!;
    expect(p.summon).toEqual({ id: '2009', handle: '2009', ti: 9 });
    expect(p.power).toBe(82);
    expect(p.mmr).toBe(CONFIG.ladder.thresholds.SS + CONFIG.gacha.seedTrajectory.mmrFracDebut * (CONFIG.ladder.thresholds.SSR - CONFIG.ladder.thresholds.SS));
    expect(tierOf(p.mmr)).toBe('SS');
    expect(p.talent).toBe(60);
    expect(p.insight).toBe(72);
    expect(p.position).toBe('C');
    expect(p.signatureHeroes).toEqual(['anti-mage', 'weaver', 'phantom-lancer']);
    expect(2019 - p.birthYear).toBe(CONFIG.gacha.seedTrajectory.seedDebutAge);
    expect(p.isReal).toBe(false);
    const steps = trajectoryOf(p, s)!;
    expect(steps[0]).toEqual({ ti: 9, mmr: p.mmr, power: 82 });
    expect(steps.find((x) => x.ti === 11)?.power).toBe(88); // 生涯第 3 年巅峰
    expect(steps.find((x) => x.ti === 14)?.power).toBe(88 - CONFIG.gacha.seedTrajectory.declinePowerPerYear); // 第 6 年起衰退
    expect(steps).toHaveLength(CONFIG.gacha.seedTrajectory.careerYears);
    const rng = rngOf(s);
    const at11 = developmentTarget(s, p, rng, 11);
    expect(at11).toMatchObject({ source: 'trajectory', power: 88 });
    // 原型数据结束后按潜力（普通选手的年龄 / 潜力规律）
    expect(developmentTarget(s, p, rng, 9 + CONFIG.gacha.seedTrajectory.careerYears).source).toBe('potential');
    // 没有 state 时不参照（trajectoryOf 的旧调用方式）
    expect(trajectoryOf(p)).toBeNull();
  });

  it('真实原型（Dendi）：复制 TI1 的真实出道水平，生涯第 k 年的成长目标 = 真实生涯第 k 年的水平', async () => {
    const { trajectoryOf, developmentTarget } = await import('../src/engine/development');
    const { rngOf } = await import('../src/engine/rng');
    const s = makeTestState(4);
    const m = hofMember(s, 'dendi')!;
    expect(m.src).toBe('real');
    const real = getTrajectory('dendi')!;
    const tis = Object.keys(real).map(Number).sort((a, b) => a - b);
    expect(m.debutTier).toBe(real[tis[0]].tier);
    const p = createSummonRookie(s, m, m.debutTier)!;
    expect(p.mmr).toBe(real[tis[0]].mmr);
    expect(p.power).toBe(real[tis[0]].power);
    expect(2019 - p.birthYear).toBe(2011 - 1989);
    const steps = trajectoryOf(p, s)!;
    for (const ti of tis) {
      const st = steps.find((x) => x.ti === 9 + (ti - tis[0]))!;
      expect(st.mmr).toBe(real[ti].mmr);
      expect(st.power).toBe(real[ti].power);
    }
    const k = tis[2];
    const target = developmentTarget(s, p, rngOf(s), 9 + (k - tis[0]));
    expect(target.source).toBe('trajectory');
    expect(target.mmr).toBe(real[k].mmr);
  });

  it('请神新秀经由赛季自主成长走原型的生涯（与真实选手同一通道）：数季后天梯 / 战力贴近原型同一生涯年份的水平', async () => {
    const { developPlayer } = await import('../src/engine/development');
    const { rngOf } = await import('../src/engine/rng');
    const s = makeTestState(4);
    const p = createSummonRookie(s, hofMember(s, '2009')!, 'SS')!;
    p.power = 70; // 远低于原型：自主成长向原型靠拢
    p.mmr = 9000;
    const rng = rngOf(s);
    for (let ti = 10; ti <= 12; ti++) {
      s.season.ti = ti;
      developPlayer(s, p, rng, ti);
    }
    expect(p.mmr).toBeGreaterThan(12500);
    expect(p.power).toBeGreaterThan(78);
  });
});

describe('gacha · 集成', () => {
  /** 懒人推进到满足条件（处理待决事件；玩家战队保持资金） */
  function playUntil(g: GameState, done: (g: GameState) => boolean, max = 400): void {
    for (let i = 0; i < max && !g.gameOver && !done(g); i++) {
      for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
        const d = g.pendingDecisions[0];
        resolveDecision(g, d.id, d.choices[0]?.id ?? '');
        if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
      }
      const me = g.teams[g.settings.playerTeamId];
      if (me && me.gold < 2_000_000) me.gold = 2_000_000;
      if (g.activeMatch) quickSimTournament(g);
      advance(g, { auto: true });
    }
  }

  it('新游戏：赛季初建池（不举行选秀）→ 玩家先抽 → 第 1 回合开始前 AI 抽卡 → TI 预选赛卡池关闭；次赛季本届真实新秀全部进入本局', async () => {
    const g = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 77,
      newClub: { name: 'Gacha Club', tag: 'GCH', region: 'CN', color: '#123456' },
    });
    expect(g.rookieDraft?.history ?? []).toHaveLength(0);
    expect(g.popups.some((p) => p.kind === 'rookie_draft')).toBe(false);
    const pool = currentGachaPool(g)!;
    expect(pool.ti).toBe(9);
    expect(pool.drawn).toBe(0);
    expect(g.hallOfFame!.members.length).toBeGreaterThan(30);
    const r = gachaPull(g, 1) as OpResult & { results?: { playerId: string }[] };
    expect(r.ok).toBe(true);
    // 玩家先抽：赛季初 AI 还没有抽卡
    expect(currentGachaPool(g)!.aiDrawn).toBe(0);
    const aiPulls = () => Object.values(g.teams).reduce((a, t) => a + (t.isPlayer || t.gacha?.seasonTi !== 9 ? 0 : t.gacha?.seasonPulls ?? 0), 0);
    playUntil(g, (x) => x.roundIndex >= 1);
    // 第 1 回合开始前 AI 按资金抽卡（开局 AI 资金约为 9~24 回合工资，大多不到 reserveRounds 的安全垫：抽得很少）
    expect(currentGachaPool(g)!.aiDrawn).toBe(aiPulls());
    playUntil(g, (x) => x.phase === 'ti_qualifier');
    expect(g.gacha!.pool).toBeNull();
    expect(g.gacha!.history.map((h) => h.ti)).toEqual([9]);
    // 赛季中期再抽一次：本赛季合计 = 各 AI 战队本赛季张数之和，且不超过每队上限
    const h9 = g.gacha!.history[0];
    expect(h9.aiDrawn).toBe(aiPulls());
    expect(h9.aiDrawn).toBeGreaterThan(0);
    for (const t of Object.values(g.teams)) if (!t.isPlayer) expect(t.gacha?.seasonPulls ?? 0).toBeLessThanOrEqual(CONFIG.gacha.aiMaxPullsPerSeason);
    // 赛季结算：SS / SSR 入选名人堂
    playUntil(g, (x) => x.season.ti === 10);
    expect(g.hallOfFame!.members.some((m) => m.source === 'inducted' && m.ti === 9)).toBe(true);
    // TI10 卡池含本届真实新秀；关闭后全部进入本局
    const pool10 = currentGachaPool(g)!;
    expect(pool10.ti).toBe(10);
    const realIds = TIERS.flatMap((t) => pool10.real[t] ?? []);
    expect(realIds.length).toBeGreaterThan(0);
    playUntil(g, (x) => x.phase === 'ti_qualifier' || x.season.ti > 10);
    for (const id of realIds) {
      const p = g.players[id] as Player | undefined;
      expect(p, id).toBeTruthy();
      expect(p!.gacha?.ti).toBe(10);
    }
    expect(Object.entries(g.futureRookies).filter(([, debut]) => debut <= 10)).toHaveLength(0);
  }, 60_000);

  it('多人：卡池全局共享、先到先得；保底计数与抽卡记录各座位独立', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build', seed: 9,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    const left = poolRemaining(g.gacha!.pool);
    const ra = M.callAsSeat(g, A, 'gachaPull', [1]) as OpResult;
    const rb = M.callAsSeat(g, B, 'gachaPull', [1]) as OpResult;
    expect(ra.ok && rb.ok).toBe(true);
    expect(poolRemaining(g.gacha!.pool)).toBe(left - 2);
    expect(g.teams[A].gacha?.log).toHaveLength(1);
    expect(g.teams[B].gacha?.log).toHaveLength(1);
    g.teams[A].gacha!.pity = 42;
    expect(g.teams[B].gacha!.pity).not.toBe(42);
    // 中性上下文没有残留
    expect(g.settings.playerTeamId).toBe('');
    // 非白名单 / 越权
    const pidA = g.teams[A].gacha!.log![0].playerId;
    expect((M.callAsSeat(g, B, 'gachaDiscard', [pidA]) as OpResult).ok).toBe(false);
    expect((M.callAsSeat(g, A, 'gachaDiscard', [pidA]) as OpResult).ok).toBe(true);
    expect((M.callAsSeat(g, A, 'gachaPull', [3]) as OpResult).ok).toBe(false);
  });
});

describe('gacha · 视图', () => {
  it('gachaView：剩余构成、下一抽概率合计为 1、剩余真实新秀与请神原型', () => {
    const s = makeTestState(4);
    for (const [id] of ti9Rookies().slice(0, 2)) s.futureRookies[id] = 9;
    startGachaSeason(s);
    const v = gachaView(s);
    expect(v.open).toBe(true);
    expect(v.remaining).toBe(100);
    expect(v.tiers.reduce((a, t) => a + t.chance, 0)).toBeCloseTo(1, 9);
    expect(v.realLeft).toHaveLength(2);
    expect(v.summonLeft.length).toBeGreaterThan(0);
    expect(v.single).toBe(40000);
    expect(v.pityThreshold).toBe(CONFIG.gacha.pityThreshold);
    const p = makePlayer();
    expect(gachaDiscardBlock(s, p)).toBe('该选手不在你的战队');
  });
});
