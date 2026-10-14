// 赛季自主成长（第九波 #2，src/engine/development.ts）
import { describe, expect, it } from 'vitest';
import type { GameState, Player, SeedPlayer, Tier } from '../src/engine/types';
import { TIERS } from '../src/engine/types';
import { CONFIG, TI_YEAR } from '../src/engine/config';
import {
  calibrateLadder, seasonGrowthAllowance, developPlayer, developmentDelta, developmentOutlook, developmentTarget, growthHeadroom, growthYearsLeft,
  hasTrainingInvestment, investmentAllowance, parseTrajectory, runSeasonDevelopment, talentGrowthMult, trajectoryOf, trajectoryPeak,
  trajectoryValueAt,
} from '../src/engine/development';
import { trainTeam } from '../src/engine/growth';
import { getTrajectories, getTrajectory } from '../src/data/index';
import { rngOf, seededRng } from '../src/engine/rng';
import { playerTier, tierIndex, tierOf } from '../src/engine/player';
import { buildTrajectories } from '../scripts/build-trajectories';
import { readRosterSync } from '../scripts/nodeData';
import { makePlayer, makeTestState } from './helpers';

/** 把测试状态切到某一届赛季（只改赛季序号 / 年份，自主成长只依赖这两项） */
function setSeason(s: GameState, ti: number): void {
  s.season.ti = ti;
  s.season.year = TI_YEAR[ti];
  s.currentDate = `${TI_YEAR[ti] - 1}-09-01`;
}

/** TI1 起的测试状态（自主成长从 TI2 开始执行） */
function stateFrom(startTi: number, seed = 777): GameState {
  const s = makeTestState(4, seed);
  s.settings.startTi = startTi;
  s.settings.endTi = 16;
  setSeason(s, startTi);
  return s;
}

function addPlayer(s: GameState, over: Partial<Player>): Player {
  const p = makePlayer(over);
  s.players[p.id] = p;
  if (p.teamId && s.teams[p.teamId] && !s.teams[p.teamId].playerIds.includes(p.id)) s.teams[p.teamId].playerIds.push(p.id);
  return p;
}

/** 与真实新秀登场时一致的 Ceb：TI2 以低一档（A 级）天梯、约 0.93 倍战力登场，之后无人签约、也不训练 */
function addCeb(s: GameState, teamId: string | null = null): Player {
  return addPlayer(s, {
    id: 'ceb', handle: 'Ceb', isReal: true, birthYear: 1992, position: 'HS', mmr: 7300, power: 67, talent: 84, teamId,
    nationality: 'FR', region: 'EU',
  });
}

const seed = (over: Partial<SeedPlayer>): SeedPlayer => ({
  id: 'x', handle: 'X', nationality: 'CN', birthYear: 1995, position: 'C', mmr: 9000, power: 75, talent: 60, resilience: 50,
  insight: 60, loyalty: 70, signatureHeroes: [], ...over,
});

describe('development: 真实生涯轨迹数据', () => {
  it('buildTrajectories：每届记录 power / mmr / tier，同届重复取更高，键按 TI 排序', () => {
    const traj = buildTrajectories([
      { ti: 3, players: [seed({ id: 'a', mmr: 11200, power: 85 }), seed({ id: 'b', mmr: 5200, power: 50 })] },
      { ti: 1, players: [seed({ id: 'a', mmr: 7000, power: 70 }), seed({ id: 'a', mmr: 8100, power: 72 })] },
      { ti: 2, players: [seed({ id: 'c', mmr: Number.NaN, power: 60 })] },
    ]);
    expect(Object.keys(traj)).toEqual(['a', 'b']);
    expect(Object.keys(traj.a)).toEqual(['1', '3']);
    // pos（第十三波真实生涯位置）游程压缩：首届写入，位置不变的届次省略
    expect(traj.a[1]).toEqual({ power: 72, mmr: 8100, tier: 'S', pos: 'C' });
    expect(traj.a[3]).toEqual({ power: 85, mmr: 11200, tier: 'SS' });
    expect(traj.b[3].tier).toBe('C');
    expect(traj.b[3].pos).toBe('C');
  });

  it('trajectories.json 与全部 roster 文件一致（Ceb：TI2 S 级 → TI8 SS 级）', () => {
    const all = getTrajectories();
    let points = 0;
    for (const ti of [1, 5, 9, 15]) {
      const r = readRosterSync(ti);
      for (const p of [...r.teams.flatMap((t) => t.players), ...(r.freeAgents ?? [])]) {
        const pt = all[p.id]?.[ti];
        expect(pt, `${p.id}@TI${ti}`).toBeDefined();
        expect(pt.mmr).toBeGreaterThanOrEqual(p.mmr);
        expect(pt.tier).toBe(tierOf(pt.mmr));
        points++;
      }
    }
    expect(points).toBeGreaterThan(500);
    const ceb = getTrajectory('ceb')!;
    expect(ceb[2]).toMatchObject({ mmr: 8500, tier: 'S' });
    expect(ceb[8]).toMatchObject({ mmr: 11500, tier: 'SS' });
    expect(ceb[6]).toBeUndefined(); // 现实中 TI6 / TI7 不在 TI 阵容中：靠插值
    expect(getTrajectory('no-such-player')).toBeUndefined();
  });

  it('插值：两届之间线性插值，早于首届取首届，晚于最后一届为 null；峰值分别取最大', () => {
    const steps = parseTrajectory(getTrajectory('ceb'));
    expect(steps[0].ti).toBe(2);
    const at6 = trajectoryValueAt(steps, 6)!;
    const at7 = trajectoryValueAt(steps, 7)!;
    expect(at6.mmr).toBeCloseTo(9000 + (11500 - 9000) / 3, 5);
    expect(at7.power).toBeCloseTo(72 + (88 - 72) * 2 / 3, 5);
    expect(trajectoryValueAt(steps, 1)).toEqual({ mmr: 8500, power: 73 });
    expect(trajectoryValueAt(steps, 8)).toEqual({ mmr: 11500, power: 88 });
    expect(trajectoryValueAt(steps, 16)).toBeNull();
    expect(trajectoryPeak(steps)).toEqual({ mmr: 12200, power: 90 });
    expect(parseTrajectory(undefined)).toEqual([]);
  });

  it('只有真实且未被重置的选手参照轨迹', () => {
    const s = stateFrom(1);
    const ceb = addCeb(s);
    expect(trajectoryOf(ceb)?.length).toBeGreaterThan(5);
    expect(trajectoryOf({ ...ceb, isReal: false })).toBeNull();
    expect(trajectoryOf({ ...ceb, development: { noTrajectory: true } })).toBeNull();
  });
});

describe('development: 真实选手向当届真实水平靠拢', () => {
  it('Ceb：TI2 以 A 级登场，即使一直是无人训练的自由选手，TI8 前后也接近 / 达到 SS，TI9 稳定在 SS', () => {
    const s = stateFrom(1);
    const ceb = addCeb(s);
    const seen: Record<number, { mmr: number; power: number; tier: Tier }> = {};
    for (let ti = 3; ti <= 9; ti++) {
      setSeason(s, ti);
      runSeasonDevelopment(s);
      seen[ti] = { mmr: ceb.mmr, power: ceb.power, tier: playerTier(ceb) };
    }
    expect(tierIndex(seen[3].tier)).toBeLessThanOrEqual(tierIndex('S'));
    expect(seen[4].tier).toBe('S');
    for (let ti = 4; ti <= 9; ti++) expect(seen[ti].mmr).toBeGreaterThanOrEqual(seen[ti - 1].mmr);
    expect(seen[8].mmr).toBeGreaterThan(10500);
    expect(seen[9].tier).toBe('SS');
    // 战力只少量靠拢：仍明显低于真实的 88~90（经理 / AI 的训练与比赛在赛季内补上）
    expect(seen[9].power).toBeGreaterThan(75);
    expect(seen[9].power).toBeLessThan(90);
    // 永不超过真实生涯峰值 + 余量
    for (let ti = 10; ti <= 16; ti++) {
      setSeason(s, ti);
      runSeasonDevelopment(s);
      expect(ceb.mmr).toBeLessThanOrEqual(12200 + CONFIG.development.trajectory.peakMarginMmr);
      expect(ceb.power).toBeLessThanOrEqual(90 + CONFIG.development.trajectory.peakMarginPower);
    }
  });

  it('同样的 Ceb 在 AI 战队打满赛季（赛季内成长）时，TI8 正赛时已是 SS', () => {
    const s = stateFrom(1);
    const ceb = addCeb(s, 't1');
    for (let ti = 3; ti <= 8; ti++) {
      setSeason(s, ti);
      runSeasonDevelopment(s);
      // 赛季内的 AI 训练 + 赛事成长（取 CONFIG 中的预期值）
      const a = seasonGrowthAllowance(TI_YEAR[ti] - 1992, ceb.mmr, ceb.power);
      ceb.mmr += Math.round(a.mmr);
      ceb.power += a.power;
    }
    expect(playerTier(ceb)).toBe('SS');
    expect(ceb.power).toBeGreaterThan(78);
  });

  it('自主成长不把选手推到参照水平之上；高于参照 + 容差时回落，人类玩家战队容差更大', () => {
    const s = stateFrom(1);
    setSeason(s, 8);
    const target = trajectoryValueAt(parseTrajectory(getTrajectory('ceb')), 8)!;
    // 刚好在参照水平：不变
    const at = addCeb(s);
    at.mmr = Math.round(target.mmr);
    at.power = target.power;
    const c0 = developPlayer(s, at, seededRng(1), 8)!;
    expect(c0.mmr).toBe(0);
    expect(c0.power).toBe(0);
    // AI 战队：明显高于参照 → 回落
    const aiP = addPlayer(s, { ...at, id: 'ceb', teamId: 't1', mmr: 12600, power: 91, development: undefined });
    const cAi = developPlayer(s, aiP, seededRng(2), 8)!;
    expect(cAi.mmr).toBeLessThan(0);
    expect(cAi.power).toBeLessThan(0);
    // 人类玩家战队（t0）：同样的超出，回落更少
    const huP = addPlayer(s, { ...at, id: 'ceb', teamId: 't0', mmr: 12600, power: 91, development: undefined });
    const cHu = developPlayer(s, huP, seededRng(2), 8)!;
    expect(cHu.mmr).toBeLessThan(0);
    expect(cHu.mmr).toBeGreaterThan(cAi.mmr);
    expect(cHu.power).toBeGreaterThan(cAi.power);
  });
});

describe('development: 训练投入保护（成长重平衡，2026-10-09）', () => {
  it('investmentAllowance = min(训练投入, 上限 × (天赋/100)^exp)：天赋越高保护越多；没有投入为 0', () => {
    const I = CONFIG.development.investment;
    const hi = makePlayer({ id: 'hi', talent: 90, development: { trainedMmr: 99999, trainedPower: 99 } });
    const lo = makePlayer({ id: 'lo', talent: 40, development: { trainedMmr: 99999, trainedPower: 99 } });
    const part = makePlayer({ id: 'part', talent: 90, development: { trainedMmr: 300, trainedPower: 0.8 } });
    expect(investmentAllowance(hi).mmr).toBeCloseTo(I.maxMmr * Math.pow(0.9, I.talentExp), 5);
    expect(investmentAllowance(hi).power).toBeCloseTo(I.maxPower * Math.pow(0.9, I.talentExp), 5);
    expect(investmentAllowance(lo).mmr).toBeLessThan(investmentAllowance(hi).mmr * 0.4);
    expect(investmentAllowance(part)).toEqual({ mmr: 300, power: 0.8 });
    expect(investmentAllowance(makePlayer({ id: 'none', talent: 90 }))).toEqual({ mmr: 0, power: 0 });
    expect(hasTrainingInvestment(hi)).toBe(true);
    expect(hasTrainingInvestment(part)).toBe(false);
  });

  it('人类玩家战队训练记入训练投入；AI 战队不记', () => {
    const s = stateFrom(1);
    setSeason(s, 9);
    trainTeam(s, 't0', 'balanced');
    trainTeam(s, 't1', 'balanced');
    const mine = s.players['t0-C'].development;
    expect(mine?.trainedMmr ?? 0).toBeGreaterThan(0);
    expect(mine?.trainedPower ?? 0).toBeGreaterThan(0);
    expect(s.players['t1-C'].development?.trainedMmr).toBeUndefined();
  });

  it('练到参照水平之上：人类玩家战队的训练投入在天赋决定的范围内不回落；没有投入 / AI 战队照常回落；投入逐季衰减', () => {
    const s = stateFrom(1);
    setSeason(s, 8);
    const target = trajectoryValueAt(parseTrajectory(getTrajectory('ceb')), 8)!;
    const base = { mmr: Math.round(target.mmr) + 2500, power: target.power + 5 };
    // 人类玩家战队，没有训练投入
    const plain = addPlayer(s, { ...base, id: 'ceb', handle: 'Ceb', isReal: true, birthYear: 1992, position: 'HS', talent: 84, teamId: 't0' });
    const cPlain = developPlayer(s, plain, seededRng(5), 8)!;
    // 人类玩家战队，经理练出来的（投入远超保护上限）
    const trained = addPlayer(s, {
      ...base, id: 'ceb', handle: 'Ceb', isReal: true, birthYear: 1992, position: 'HS', talent: 84, teamId: 't0',
      development: { trainedMmr: 6000, trainedPower: 12 },
    });
    const prot = investmentAllowance(trained);
    const cTrained = developPlayer(s, trained, seededRng(5), 8)!;
    expect(cPlain.mmr).toBeLessThan(0);
    expect(cTrained.mmr).toBeGreaterThan(cPlain.mmr);
    expect(cTrained.power).toBeGreaterThan(cPlain.power);
    // 保护范围内的部分不回落：回落量 ≤ (超出 − 保护 − 容差) × 回落率
    const R = CONFIG.development.regression.human;
    const allow = seasonGrowthAllowance(TI_YEAR[8] - 1992, base.mmr, base.power, false);
    const excessMmr = base.mmr - (target.mmr - allow.mmr) - prot.mmr - R.mmrTolerance;
    expect(-cTrained.mmr).toBeLessThanOrEqual(Math.max(0, excessMmr) * R.mmrRate * CONFIG.development.jitter[1] + 1);
    // 训练投入逐季衰减
    expect(trained.development!.trainedMmr).toBe(Math.round(6000 * (1 - CONFIG.development.investment.decay)));
    // AI 战队：训练投入不起作用
    const ai = addPlayer(s, {
      ...base, id: 'ceb', handle: 'Ceb', isReal: true, birthYear: 1992, position: 'HS', talent: 84, teamId: 't1',
      development: { trainedMmr: 6000, trainedPower: 12 },
    });
    const cAi = developPlayer(s, ai, seededRng(5), 8)!;
    expect(cAi.mmr).toBeLessThan(cTrained.mmr);
  });

  it('天梯相对校准：有训练投入的选手最后才回落（仍计入名额）', () => {
    const s = stateFrom(3);
    setSeason(s, 9);
    const teams = Object.keys(s.teams);
    for (let i = 0; i < 8; i++) addPlayer(s, { id: `ssr${i}`, mmr: 15100 + i * 200, power: 85, birthYear: 1990, teamId: teams[i % teams.length] });
    // 天梯最低的 ssr0（人类玩家战队）有明显训练投入：应保留，改由其后的选手回落
    s.players.ssr0.development = { trainedMmr: 5000 };
    // ssr1 在 AI 战队（例如被卖走的旧部）：训练投入不再优先保护，照常按天梯从低到高回落
    expect(s.players.ssr1.teamId).not.toBe(s.settings.playerTeamId);
    s.players.ssr1.development = { trainedMmr: 5000 };
    const n = Object.values(s.players).filter((p) => p.status === 'active' && p.teamId).length;
    const allowed = Math.max(CONFIG.development.ladder.ssrMin, Math.floor(n * CONFIG.development.ladder.ssrShare));
    const out = calibrateLadder(s);
    expect(out.map((d) => d.playerId)).not.toContain('ssr0');
    expect(out.map((d) => d.playerId)).toContain('ssr1');
    expect(s.players.ssr0.mmr).toBe(15100);
    expect(Object.values(s.players).filter((p) => p.teamId && p.mmr >= CONFIG.ladder.thresholds.SSR)).toHaveLength(allowed);
  });
});

describe('development: 程序生成选手的潜力上限', () => {
  it('成长年数与天赋系数', () => {
    expect(growthYearsLeft(18, 'C')).toBe(4);
    expect(growthYearsLeft(21, 'C')).toBe(1);
    expect(growthYearsLeft(23, 'C')).toBe(CONFIG.development.potential.inWindowYears);
    expect(growthYearsLeft(26, 'C')).toBe(0);
    expect(growthYearsLeft(26, 'HS')).toBe(CONFIG.development.potential.inWindowYears); // 辅助巅峰更晚
    expect(talentGrowthMult(70)).toBeCloseTo(1, 5);
    expect(talentGrowthMult(90)).toBeGreaterThan(1.7);
    expect(talentGrowthMult(20)).toBe(0);
    expect(talentGrowthMult(100)).toBeLessThanOrEqual(CONFIG.development.potential.talentMultMax);
    // 越接近顶端空间越小
    const low = growthHeadroom(18, 'C', 80, 6000, 55);
    const high = growthHeadroom(18, 'C', 80, 15500, 90);
    expect(high.mmr).toBeLessThan(low.mmr * 0.35);
    expect(high.power).toBeLessThan(low.power * 0.4);
    expect(growthHeadroom(30, 'C', 99, 6000, 55)).toEqual({ mmr: 0, power: 0 });
  });

  it('年轻高天赋选手逐季成长并停在潜力上限；天赋低的上限低；老将不再自主成长', () => {
    const s = stateFrom(1);
    const star = addPlayer(s, { id: 'g-star', birthYear: 2012 - 18, position: 'M', mmr: 5200, power: 52, talent: 92 });
    const dull = addPlayer(s, { id: 'g-dull', birthYear: 2012 - 18, position: 'M', mmr: 5200, power: 52, talent: 40 });
    const vet = addPlayer(s, { id: 'g-vet', birthYear: 2012 - 29, position: 'C', mmr: 9000, power: 75, talent: 90 });
    const hist: number[] = [];
    for (let ti = 2; ti <= 12; ti++) {
      setSeason(s, ti);
      runSeasonDevelopment(s);
      hist.push(star.mmr);
    }
    const potStar = star.development!.potentialMmr!;
    const potDull = dull.development!.potentialMmr!;
    expect(potStar - 5200).toBeGreaterThan(2000);
    expect(potDull - 5200).toBeLessThan(1200);
    expect(star.mmr).toBeLessThanOrEqual(potStar);
    expect(dull.mmr).toBeLessThanOrEqual(potDull);
    expect(star.mmr).toBeGreaterThan(potStar - 400); // 已基本长满
    for (let i = 1; i < hist.length; i++) expect(hist[i]).toBeGreaterThanOrEqual(hist[i - 1]);
    expect(star.power).toBeGreaterThan(55);
    expect(star.power).toBeLessThanOrEqual(star.development!.potentialPower!);
    // 29 岁（已过巅峰）：潜力 = 当前水平，不涨
    expect(vet.development!.potentialMmr).toBe(9000);
    expect(vet.mmr).toBe(9000);
    expect(vet.power).toBe(75);
  });

  it('按用户指定的新秀等级分布生成的一届新秀，长满之后不会人人 SSR（SSR 仍然稀有，等级分布只整体上移约一档）', () => {
    const s = stateFrom(1, 4242);
    const rng = seededRng(99);
    const weights = CONFIG.draft.tierWeights;
    const tierCount = (ps: Player[]) => {
      const c: Record<Tier, number> = { C: 0, B: 0, A: 0, S: 0, SS: 0, SSR: 0 };
      for (const p of ps) c[playerTier(p)]++;
      return c;
    };
    const rookies: Player[] = [];
    for (let i = 0; i < 400; i++) {
      const tier = rng.weighted(TIERS, TIERS.map((t) => weights[t]));
      const th = CONFIG.ladder.thresholds;
      const lo = th[tier];
      const hi = tier === 'SSR' ? lo + 3000 : th[TIERS[tierIndex(tier) + 1]];
      rookies.push(addPlayer(s, {
        id: `r${i}`, birthYear: TI_YEAR[1] - rng.int(17, 19), position: rng.pick(['C', 'M', 'O', 'SS', 'HS']),
        mmr: Math.round(rng.range(Math.max(4500, lo), hi - 1)), power: CONFIG.generation.powerByTier[tier][0],
        talent: Math.round(Math.min(96, Math.max(8, rng.normal(70, 11)))),
      }));
    }
    const before = tierCount(rookies);
    for (let ti = 2; ti <= 9; ti++) {
      setSeason(s, ti);
      runSeasonDevelopment(s);
    }
    const after = tierCount(rookies);
    expect(after.SSR / rookies.length).toBeLessThan(0.08);
    expect(after.SSR + after.SS).toBeLessThan((before.SSR + before.SS) * 2.5);
    expect(after.C).toBeLessThan(before.C); // 低等级新秀普遍进步
    expect(after.C + after.B).toBeGreaterThan(rookies.length * 0.15); // 但不是人人都能成材
  });

  it('潜力只评估一次并保存（不在界面显示数值）；developmentOutlook 只读、不消耗随机数', () => {
    const s = stateFrom(1);
    const p = addPlayer(s, { id: 'g1', birthYear: TI_YEAR[1] - 18, position: 'O', mmr: 6000, power: 58, talent: 80 });
    const rng0 = s.rngState;
    expect(developmentOutlook(s, p)).toBe('仍有成长空间');
    expect(p.development).toBeUndefined();
    expect(s.rngState).toBe(rng0);
    setSeason(s, 2);
    developmentTarget(s, p, rngOf(s));
    const pot = p.development!.potentialMmr;
    developmentTarget(s, p, rngOf(s));
    expect(p.development!.potentialMmr).toBe(pot);
  });
});

describe('development: 赛季流程', () => {
  it('首发、替补、自由选手、AI 战队选手都自主成长；野外替补候选、退役 / 禁赛选手不参与；同一赛季只执行一次', () => {
    const s = stateFrom(1);
    setSeason(s, 2);
    const young = { birthYear: TI_YEAR[2] - 18, position: 'C' as const, mmr: 6000, power: 58, talent: 85 };
    const fa = addPlayer(s, { id: 'fa', ...young });
    const bench = addPlayer(s, { id: 'bench', ...young, teamId: 't2' });
    const starter = s.players[s.teams.t3.lineup.C!];
    Object.assign(starter, { birthYear: TI_YEAR[2] - 18, mmr: 6000, power: 58, talent: 85 });
    const wild = addPlayer(s, { id: 'wild', ...young, isWildSub: true });
    const retired = addPlayer(s, { id: 'ret', ...young, status: 'retired' });
    const banned = addPlayer(s, { id: 'ban', ...young, status: 'banned' });
    const changes = runSeasonDevelopment(s);
    const ids = new Set(changes.map((c) => c.playerId));
    for (const p of [fa, bench, starter]) {
      expect(ids.has(p.id)).toBe(true);
      expect(p.mmr).toBeGreaterThan(6000);
      expect(p.development?.ti).toBe(2);
    }
    for (const p of [wild, retired, banned]) {
      expect(ids.has(p.id)).toBe(false);
      expect(p.mmr).toBe(6000);
    }
    // AI 战队选手扣除赛季内预期成长：自主成长少于同条件的自由选手
    expect(bench.mmr - 6000).toBeLessThan(fa.mmr - 6000 + 1);
    const snapshot = JSON.stringify(s.players);
    expect(runSeasonDevelopment(s)).toEqual([]);
    expect(JSON.stringify(s.players)).toBe(snapshot);
  });

  it('新游戏的第一个赛季不执行；关闭开关时不执行', () => {
    const s = stateFrom(5);
    const p = addPlayer(s, { id: 'g', birthYear: TI_YEAR[5] - 18, mmr: 6000, power: 58, talent: 85 });
    expect(runSeasonDevelopment(s)).toEqual([]);
    expect(p.mmr).toBe(6000);
    setSeason(s, 6);
    const D = CONFIG.development as { enabled: boolean };
    D.enabled = false;
    try {
      expect(runSeasonDevelopment(s)).toEqual([]);
    } finally {
      D.enabled = true;
    }
    expect(runSeasonDevelopment(s).length).toBeGreaterThan(0);
  });

  it('确定性：相同种子与状态得到完全相同的结果', () => {
    const build = () => {
      const s = stateFrom(1, 31337);
      addCeb(s);
      for (let i = 0; i < 30; i++) {
        addPlayer(s, { id: `g${i}`, birthYear: TI_YEAR[1] - 17 - (i % 12), mmr: 5000 + i * 300, power: 50 + i, talent: 40 + i * 2 });
      }
      for (let ti = 2; ti <= 7; ti++) {
        setSeason(s, ti);
        runSeasonDevelopment(s);
      }
      return s;
    };
    // makePlayer 的默认显示名带全局计数器：只比较自主成长涉及的字段
    const view = (s: GameState) => Object.values(s.players).map((p) => [p.id, p.mmr, p.power, p.development]);
    const a = build();
    const b = build();
    expect(view(a)).toEqual(view(b));
    expect(a.rngState).toBe(b.rngState);
    expect(a.players.ceb.mmr).toBeGreaterThan(7300); // 确实发生了自主成长
  });

  it('玩家战队的本队简报（私有新闻，只列变化明显的队员）', () => {
    const s = stateFrom(1);
    setSeason(s, 2);
    const p = addPlayer(s, { id: 'mine', birthYear: TI_YEAR[2] - 18, mmr: 6000, power: 58, talent: 92, teamId: 't0' });
    runSeasonDevelopment(s);
    const n = s.news.find((x) => x.title.includes('休赛期自主训练'));
    expect(n).toBeDefined();
    expect(n!.body).toContain(p.handle);
    expect(n!.visibility).toBe('private');
    expect(n!.body).not.toMatch(/潜力上限|potential/);
  });

  it('developmentDelta：低于目标只升不越过、高于回落参照 + 容差才回落', () => {
    const k = { up: 2000, upRate: 0.5, maxUp: 10000, down: 2000, tolerance: 100, downRate: 0.5, maxDown: 10000 };
    expect(developmentDelta(1000, k)).toBe(500);
    expect(developmentDelta(1000, { ...k, upRate: 2 })).toBe(1000); // 不越过目标
    expect(developmentDelta(1000, { ...k, maxUp: 300 })).toBe(300); // 单季上限
    expect(developmentDelta(2050, k)).toBe(0); // 容差内
    expect(developmentDelta(2300, k)).toBe(-100);
    expect(developmentDelta(2300, { ...k, down: 2500 })).toBe(0); // 人类玩家战队：回落参照更高
    expect(developmentDelta(Number.NaN, k)).toBe(0);
  });

  it('成长趋势标签：年轻高天赋 → 仍有成长空间；老将 → 已过巅峰；长满的巅峰期选手 → 接近巅峰', () => {
    const s = stateFrom(1);
    setSeason(s, 5);
    const young = addPlayer(s, { id: 'y', birthYear: TI_YEAR[5] - 18, position: 'M', mmr: 6000, power: 58, talent: 85 });
    const old = addPlayer(s, { id: 'o', birthYear: TI_YEAR[5] - 30, position: 'M', mmr: 12000, power: 85, talent: 60 });
    const prime = addPlayer(s, {
      id: 'pr', birthYear: TI_YEAR[5] - 24, position: 'M', mmr: 12000, power: 85, talent: 70,
      development: { potentialMmr: 12100, potentialPower: 85.5 },
    });
    expect(developmentOutlook(s, young)).toBe('仍有成长空间');
    expect(developmentOutlook(s, old)).toBe('已过巅峰');
    expect(developmentOutlook(s, prime)).toBe('接近巅峰');
    // 真实选手：之后的真实生涯仍会上升 → 仍有成长空间
    const ceb = addCeb(s);
    expect(developmentOutlook(s, ceb)).toBe('仍有成长空间');
  });
});

interface LeagueRow {
  ti: number;
  all: number;
  ssr: number;
  rostered: number;
  starters: number;
  top10: number;
  max: number;
  /** 有当届真实数据的真实首发：平均（当前 − 当届真实水平）；无此类首发时为 NaN */
  realDMmr: number;
  realDPow: number;
  realN: number;
}

/**
 * 无头推进整局（决策选第一项、比赛快速模拟、玩家战队资金兜底），每届 TI 正赛回合（赛季结算前）测量一次联赛分布；
 * 同时检查：上届 TI 时在役、跨赛季后仍在役的选手本赛季恰好自主成长一次。
 */
async function runLeague(opts: { startTi: number; seasons: number; teamId: string; seed: number }): Promise<{ g: GameState; rows: LeagueRow[] }> {
  const { registerNodeRosterLoader } = await import('../scripts/nodeData');
  const { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimTournament } = await import('../src/engine/game');
  const { resolveDecision } = await import('../src/engine/events');
  registerNodeRosterLoader();
  const g = await createNewGame({ startTi: opts.startTi, seasons: opts.seasons, difficulty: 'easy', managerName: 'T', teamId: opts.teamId, seed: opts.seed });
  const rows: LeagueRow[] = [];
  const measure = () => {
    const active = Object.values(g.players).filter((p) => p.status === 'active' && !p.isWildSub && !p.tempSubUntilTournament);
    const elite = (ps: Player[]) => ps.filter((p) => tierIndex(playerTier(p)) >= tierIndex('SS')).length / Math.max(1, ps.length);
    const starters: Player[] = [];
    for (const t of Object.values(g.teams)) {
      if (t.disbanded) continue;
      for (const id of Object.values(t.lineup)) if (id && g.players[id]?.status === 'active') starters.push(g.players[id]);
    }
    const pw = starters.map((p) => p.power).sort((a, b) => b - a);
    let dm = 0;
    let dp = 0;
    let n = 0;
    for (const p of starters) {
      const real = trajectoryOf(p) ? getTrajectory(p.id)?.[g.season.ti] : undefined;
      if (!real) continue;
      dm += p.mmr - real.mmr;
      dp += p.power - real.power;
      n++;
    }
    rows.push({
      ti: g.season.ti,
      all: elite(active),
      ssr: active.filter((p) => playerTier(p) === 'SSR').length / active.length,
      rostered: elite(active.filter((p) => !!p.teamId)),
      starters: elite(starters),
      top10: pw.slice(0, 10).reduce((a, b) => a + b, 0) / 10,
      max: pw[0],
      realDMmr: n ? dm / n : Number.NaN,
      realDPow: n ? dp / n : Number.NaN,
      realN: n,
    });
  };
  let lastTi = g.season.ti;
  let measured = -1;
  let beforeIds: string[] = [];
  for (let step = 0; step < 4000 && !g.gameOver; step++) {
    g.popups.length = 0;
    for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
      const d = g.pendingDecisions[0];
      resolveDecision(g, d.id, d.choices[0]?.id ?? '');
      if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
    }
    const me = g.teams[g.settings.playerTeamId];
    if (me && g.phase === 'preseason' && me.gold < 2_000_000) me.gold = 2_000_000; // 只测联赛分布，不让玩家战队破产
    if (currentPlayerTournament(g) || g.activeMatch) {
      if (!quickSimTournament(g).ok) fillLineupWithTempSubs(g);
    }
    // 每届 TI 正赛回合（赛季结算前）测量一次
    if (g.phase === 'ti' && g.roundIndex === g.season.rounds.length - 1 && measured !== g.season.ti) {
      measured = g.season.ti;
      measure();
      beforeIds = Object.values(g.players).filter((p) => p.status === 'active' && !p.isWildSub).map((p) => p.id);
    }
    advance(g);
    if (!g.gameOver && g.season.ti !== lastTi) {
      lastTi = g.season.ti;
      // 上届 TI 时在役、跨赛季后仍在役的选手（未退役 / 禁赛）本赛季恰好自主成长一次；本赛季新加入联赛的选手下赛季才开始
      for (const id of beforeIds) {
        const p = g.players[id];
        if (!p || p.status !== 'active' || p.isWildSub) continue;
        expect(p.development?.ti, `${p.id}@TI${g.season.ti}`).toBe(g.season.ti);
      }
    }
  }
  if (process.env.DEV_DEBUG) {
    console.log(rows.map((x) => `TI${x.ti} 全体 SS+ ${(x.all * 100).toFixed(1)}% SSR ${(x.ssr * 100).toFixed(1)}% 签约 SS+ ${(x.rostered * 100).toFixed(1)}%`
      + ` | 首发 SS+ ${(x.starters * 100).toFixed(1)}% 前十战力 ${x.top10.toFixed(1)} 最高 ${x.max.toFixed(1)}`
      + ` | 真实首发 vs 当届真实水平（${x.realN} 人）天梯 ${x.realDMmr.toFixed(0)} 战力 ${x.realDPow.toFixed(1)}`).join('\n'));
  }
  return { g, rows };
}

describe('development: 联赛等级分布稳定（多赛季集成）', () => {
  // 首发前十战力的下限（第十四波复核）：同一种子下的值随任何改变赛程 / 战绩的引擎改动而小幅漂移（赛季中补充邀请与荣誉势头上线后
  // 本用例 TI2 88.1 → 87.97、下一用例 TI14 87.5 → 86.96）。110 个种子（TI1 起 8 季，懒人推进）的分布改动前后一致：
  // TI2 均值 87.50 / 87.55、种子间标准差 ≈ 0.4，TI3–TI8 标准差 0.5–0.8 —— 下限按「均值 − 约 1 个标准差」取 87.5 / 86.5，只拦截整体性的下滑。
  // 抽卡取代选秀（2026-10-14）后复核（40 个种子，测的是每局 8 届中最低的一届）：TI1 起各届均值与选秀时相当（最低一届均值 88.47、
  // 标准差 0.44，40 局中 1 局低于 87.5），下限不变；TI9 起 TI12 均值 88.0 → 87.4（只合入抽卡时同样如此），
  // 最低一届均值 87.35、标准差 0.64，41 局中 4 局低于 86.5（与只合入抽卡时相同，与赛季中报名 / 荣誉势头没有叠加效应）——第二个用例的下限改为 86.0（均值 − 2 个标准差）。
  // v0.3 审查修复（2026-10-14：真实新秀第 1 回合前离池、AI 超编抽卡门槛、新秀工资上限）后复核「全体 SS+ 占比相对首届的最大跌幅」
  // （本用例同口径，每局取 8 届中最低的一届）：TI9 起 30 局均值 −0.104（标准差约 0.015），修复前 −0.106，30 局中各有 6 局跌幅超过 0.12；
  // TI1 起 20 局 −0.104 / −0.102（修复后 / 前）。0.12 的下限离均值只有约 1 个标准差，同一种子随任何改动的随机分叉就会越线，
  // 两个用例都放宽到 0.14（均值 − 约 2.5 个标准差），首发前十战力下限不变（TI9 起 30 局最低 86.36，TI1 起 20 局最低 88.14）。
  it('TI1 → TI8：每届 TI 时全体在役选手的 SS/SSR 占比稳定、SSR 稀有，首发顶级选手战力在 87.5~100 之间', async () => {
    const { g, rows } = await runLeague({ startTi: 1, seasons: 8, teamId: 'natus-vincere', seed: 5 });
    expect(g.gameOver?.reason).toBe('completed');
    expect(rows.map((x) => x.ti)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 对照（关闭自主成长，多赛季模拟实测）：首发 SS+ 占比 TI7 约 72%、首发前十战力约 93~94、全体等级分布持续上浮
    const first = rows[0];
    for (const x of rows) {
      expect(x.all, `TI${x.ti} 全体 SS+ 占比`).toBeLessThan(first.all + 0.05);
      expect(x.all, `TI${x.ti} 全体 SS+ 占比`).toBeGreaterThan(first.all - 0.14);
      expect(x.ssr, `TI${x.ti} 全体 SSR 占比`).toBeLessThan(0.05);
      expect(x.rostered, `TI${x.ti} 签约选手 SS+ 占比`).toBeLessThan(0.45);
      expect(x.starters, `TI${x.ti} 首发 SS+ 占比`).toBeLessThan(0.56);
      expect(x.top10, `TI${x.ti} 首发前十战力`).toBeGreaterThanOrEqual(87.5);
      expect(x.top10, `TI${x.ti} 首发前十战力`).toBeLessThan(93);
      expect(x.max, `TI${x.ti} 首发最高战力`).toBeLessThanOrEqual(100);
    }
  }, 60000);

  it('TI9 → TI16：后半段同样稳定，真实首发贴近当届真实水平（TI16 无真实数据，全部按潜力）', async () => {
    const { g, rows } = await runLeague({ startTi: 9, seasons: 8, teamId: 'og', seed: 5 });
    expect(g.gameOver?.reason).toBe('completed');
    expect(rows.map((x) => x.ti)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    // 对照（关闭自主成长，同种子）：首发 SS+ 占比 TI12 起约 57~63%、全体 SSR 约 5%、真实首发高出当届真实水平约 +1100~1500 天梯 / +6.5~8.5 战力、
    // 首发前十战力约 93~94。只有自主成长时首发 SS+ 占比仍会缓慢上升（约 41% → 56%）：来自选秀按用户指定分布（SS 5% / SSR 3%）生成、
    // 长期在役的程序生成新秀；第九波 QA 的天梯相对校准（calibrateLadder）之后同种子约 39%~48%、全体 SSR 1.4%~2.9%。
    const first = rows[0];
    for (const x of rows) {
      expect(x.all, `TI${x.ti} 全体 SS+ 占比`).toBeLessThan(first.all + 0.05);
      expect(x.all, `TI${x.ti} 全体 SS+ 占比`).toBeGreaterThan(first.all - 0.14);
      expect(x.ssr, `TI${x.ti} 全体 SSR 占比`).toBeLessThan(0.04);
      expect(x.starters, `TI${x.ti} 首发 SS+ 占比`).toBeLessThan(0.52);
      expect(x.top10, `TI${x.ti} 首发前十战力`).toBeGreaterThanOrEqual(86);
      expect(x.top10, `TI${x.ti} 首发前十战力`).toBeLessThan(93);
      expect(x.max, `TI${x.ti} 首发最高战力`).toBeLessThanOrEqual(100);
      // 自主成长接管之后（第二个赛季起），有当届真实数据的真实首发平均贴近当届真实水平
      if (x.ti > first.ti && x.realN >= 20) {
        expect(Math.abs(x.realDMmr), `TI${x.ti} 真实首发天梯偏差`).toBeLessThan(700);
        expect(x.realDPow, `TI${x.ti} 真实首发战力偏差`).toBeGreaterThan(-1.5);
        expect(x.realDPow, `TI${x.ti} 真实首发战力偏差`).toBeLessThan(3);
      }
    }
    expect(rows.filter((x) => x.ti > first.ti && x.realN >= 20).length).toBeGreaterThanOrEqual(5);
  }, 60000);
});

// ---------------------------------------------------------------------------
// 天梯相对校准（第九波 QA，CONFIG.development.ladder）
// ---------------------------------------------------------------------------
describe('development: 天梯相对校准（calibrateLadder）', () => {
  /** 某届有真实轨迹数据的真实选手 id */
  function realIdAt(ti: number): string {
    const all = getTrajectories();
    const id = Object.keys(all).find((k) => all[k]?.[ti]);
    if (!id) throw new Error(`no trajectory at TI${ti}`);
    return id;
  }

  /** 4 支战队（20 名 S 级首发）+ 每队若干替补：n 名 SSR、m 名 SS（程序生成） */
  function league(ssr: number, ss: number): GameState {
    const s = stateFrom(3);
    setSeason(s, 9);
    const teams = Object.keys(s.teams);
    for (let i = 0; i < ssr; i++) {
      addPlayer(s, { id: `ssr${i}`, mmr: 15100 + i * 200, power: 85, birthYear: 1990, teamId: teams[i % teams.length] });
    }
    for (let i = 0; i < ss; i++) {
      addPlayer(s, { id: `ss${i}`, mmr: 11100 + i * 100, power: 80, birthYear: 1990, teamId: teams[i % teams.length] });
    }
    return s;
  }

  const L = () => CONFIG.development.ladder;
  const rostered = (s: GameState) => Object.values(s.players).filter((p) => p.status === 'active' && p.teamId);
  const count = (s: GameState, floor: number) => rostered(s).filter((p) => p.mmr >= floor).length;

  it('SSR 超过上限：程序生成选手按天梯从低到高回落到门槛之下（潜力同步下调），最高的保留', () => {
    const s = league(8, 0);
    for (const p of Object.values(s.players)) if (p.id.startsWith('ssr')) p.development = { potentialMmr: p.mmr + 500, potentialPower: 90 };
    const n = rostered(s).length;
    const allowed = Math.max(L().ssrMin, Math.floor(n * L().ssrShare));
    const out = calibrateLadder(s);
    const th = CONFIG.ladder.thresholds.SSR;
    expect(count(s, th)).toBe(allowed);
    expect(out.filter((d) => d.cap === 'SSR')).toHaveLength(8 - allowed);
    // 回落的是天梯最低的几名；回落后约在门槛 − margin − 赛季内预期成长，潜力不高于新天梯
    for (let i = 0; i < 8; i++) {
      const p = s.players[`ssr${i}`];
      if (i < 8 - allowed) {
        expect(p.mmr).toBeLessThan(th - L().margin + 1);
        expect(p.development?.potentialMmr).toBeLessThanOrEqual(p.mmr);
      } else {
        expect(p.mmr).toBe(15100 + i * 200);
      }
    }
  });

  it('有当届真实轨迹的真实选手不参与（即使天梯最低）；不超过上限时不变；确定性', () => {
    const s = league(5, 0);
    const rid = realIdAt(9);
    const team = Object.keys(s.teams)[0];
    addPlayer(s, { id: rid, isReal: true, mmr: 15010, power: 88, teamId: team });
    const before = JSON.stringify(s.players);
    const copy = JSON.parse(before) as GameState['players'];
    calibrateLadder(s);
    expect(s.players[rid].mmr).toBe(15010);
    // 同样输入再算一次结果一致
    const s2 = league(5, 0);
    s2.players = copy;
    for (const t of Object.values(s2.teams)) t.playerIds = Object.values(copy).filter((p) => p.teamId === t.id).map((p) => p.id);
    calibrateLadder(s2);
    expect(JSON.stringify(s2.players)).toBe(JSON.stringify(s.players));
    // 不超过上限：无变化
    const s3 = league(2, 0);
    const snap = JSON.stringify(s3.players);
    expect(calibrateLadder(s3)).toEqual([]);
    expect(JSON.stringify(s3.players)).toBe(snap);
  });

  it('SS 及以上超过上限：最低的 SS 回落到 S；关闭开关时不处理；runSeasonDevelopment 会执行校准', () => {
    const s = league(0, 20);
    const n = rostered(s).length;
    const allowed = Math.floor(n * L().ssPlusShare);
    calibrateLadder(s);
    expect(count(s, CONFIG.ladder.thresholds.SS)).toBe(allowed);
    expect(s.players.ss0.mmr).toBeLessThan(CONFIG.ladder.thresholds.SS);
    expect(s.players.ss19.mmr).toBe(11100 + 19 * 100);

    const off = league(0, 20);
    const snap = JSON.stringify(off.players);
    const prev = L().enabled;
    (CONFIG.development.ladder as { enabled: boolean }).enabled = false;
    try {
      expect(calibrateLadder(off)).toEqual([]);
    } finally {
      (CONFIG.development.ladder as { enabled: boolean }).enabled = prev;
    }
    expect(JSON.stringify(off.players)).toBe(snap);

    const dev = league(10, 0);
    runSeasonDevelopment(dev);
    expect(count(dev, CONFIG.ladder.thresholds.SSR)).toBeLessThanOrEqual(Math.max(L().ssrMin, Math.floor(rostered(dev).length * L().ssrShare)));
  });
});
