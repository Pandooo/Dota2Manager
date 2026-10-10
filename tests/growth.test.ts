import { describe, expect, it } from 'vitest';
import { expectedSalary, honorLoyaltyDelta, tenureSpeedMult } from '../src/engine/salary';
import { CONFIG } from '../src/engine/config';
import {
  adjustLoyalty, ageFactor, agePlayersAtSeasonEnd, applyTournamentGrowth, insightSoftCap, mmrSoftCap, powerSoftCap,
  overRosterBenchPenalty, processRetirements, rollGain, roundLoyaltyUpdate, scrimMultiplier, sessionTrainOptions, trainTeam,
} from '../src/engine/growth';
import { playerTier } from '../src/engine/player';
import { seededRng } from '../src/engine/rng';
import { addPlayerToTeam } from '../src/engine/team';
import type { GameState } from '../src/engine/types';
import { makeCoach, makePlayer, makeTestState } from './helpers';

/** 单年间隔赛季（TI11=2022 → TI12=2023），避免 TI9→TI10 的两年跨度干扰 */
function oneYearState(teams = 1, seed = 1): GameState {
  const s = makeTestState(teams, seed);
  s.season.ti = 11;
  s.season.year = 2022;
  return s;
}

function setTeam(s: GameState, teamId: string, over: { age?: number; talent?: number; power?: number; mmr?: number }) {
  for (const id of s.teams[teamId].playerIds) {
    const p = s.players[id];
    if (over.age !== undefined) p.birthYear = s.season.year - over.age;
    if (over.talent !== undefined) p.talent = over.talent;
    if (over.power !== undefined) p.power = over.power;
    if (over.mmr !== undefined) p.mmr = over.mmr;
  }
}

describe('growth: 基础公式', () => {
  it('ageFactor 按年龄表', () => {
    expect(ageFactor(17)).toBe(1.25);
    expect(ageFactor(19)).toBe(1.25);
    expect(ageFactor(21)).toBe(1.0);
    expect(ageFactor(24)).toBe(0.8);
    expect(ageFactor(26)).toBe(0.55);
    expect(ageFactor(28)).toBe(0.35);
    expect(ageFactor(35)).toBe(0.2);
  });

  it('rollGain：天赋只拉高上限（非线性）', () => {
    const rng = seededRng(42);
    const base = { min: 1, spread: 10 };
    for (let i = 0; i < 200; i++) {
      const g0 = rollGain(rng, base, 0);
      expect(g0).toBeCloseTo(1);
      const g = rollGain(rng, base, 100);
      expect(g).toBeGreaterThanOrEqual(1);
      expect(g).toBeLessThanOrEqual(11);
      const g50 = rollGain(rng, base, 50);
      expect(g50).toBeLessThanOrEqual(1 + 10 * Math.pow(0.5, CONFIG.growth.talentExponent) + 1e-9);
    }
  });

  it('软上限单调递减', () => {
    expect(powerSoftCap(60)).toBe(1);
    expect(powerSoftCap(90)).toBeLessThan(powerSoftCap(80));
    expect(powerSoftCap(200)).toBe(CONFIG.player.powerSoftCapMin);
    expect(mmrSoftCap(15000)).toBeLessThan(mmrSoftCap(9000));
    expect(insightSoftCap(95)).toBeLessThan(insightSoftCap(60));
  });
});

describe('growth: 训练', () => {
  it('trainTeam 返回每名选手的变化，按焦点分配', () => {
    const s = oneYearState(1);
    setTeam(s, 't0', { age: 20, talent: 70 });
    const before = { ...s.players['t0-C'] };
    const gains = trainTeam(s, 't0', 'power');
    expect(gains).toHaveLength(5);
    const g = gains.find((x) => x.playerId === 't0-C')!;
    expect(g.handle).toBe(before.handle);
    expect(g.power).toBeGreaterThan(0);
    expect(s.players['t0-C'].power).toBeCloseTo(before.power + g.power, 5);
    expect(Number.isInteger(g.mmr)).toBe(true);
    expect(Math.round(g.power * 100) / 100).toBe(g.power);
    expect(g.resilience).toBe(0); // 无教练
  });

  it('替补收益更低（统计意义）', () => {
    let starter = 0;
    let bench = 0;
    for (let t = 0; t < 60; t++) {
      const s = oneYearState(1, 100 + t);
      setTeam(s, 't0', { age: 21, talent: 70 });
      const sub = makePlayer({ id: 'sub', position: 'C', birthYear: 2001, talent: 70, power: 75, mmr: 9000 });
      s.players.sub = sub;
      addPlayerToTeam(s, 'sub', 't0', { contractSeasons: 1 });
      const gains = trainTeam(s, 't0', 'power');
      starter += gains.find((x) => x.playerId === 't0-C')!.power;
      bench += gains.find((x) => x.playerId === 'sub')!.power;
    }
    expect(bench).toBeLessThan(starter);
    expect(bench / starter).toBeGreaterThan(CONFIG.growth.benchTrainingMult * 0.7);
    expect(bench / starter).toBeLessThan(CONFIG.growth.benchTrainingMult * 1.3);
  });

  it('≥24 岁无教练时天赋不提升；教练提升天赋与韧性', () => {
    const s = oneYearState(1);
    setTeam(s, 't0', { age: 27, talent: 50 });
    trainTeam(s, 't0', 'balanced');
    expect(s.players['t0-C'].talent).toBe(50);

    s.coaches.co = makeCoach({ id: 'co', talentBoost: 6, resilienceBoost: 6, teamId: 't0' });
    s.teams.t0.coachId = 'co';
    const res0 = s.players['t0-C'].resilience;
    const gains = trainTeam(s, 't0', 'balanced');
    const g = gains.find((x) => x.playerId === 't0-C')!;
    expect(g.talent).toBeGreaterThan(0);
    expect(g.resilience).toBeGreaterThan(0);
    expect(s.players['t0-C'].resilience).toBeGreaterThan(res0);
  });

  it('同一回合第 2 次起的训练（attrMult）：天赋 / 韧性收益按比例折算，战力 / 天梯 / 灵性不受影响', () => {
    const mk = () => {
      const s = oneYearState(1, 4242);
      setTeam(s, 't0', { age: 20, talent: 60 });
      s.coaches.co = makeCoach({ id: 'co', talentBoost: 6, resilienceBoost: 6, teamId: 't0' });
      s.teams.t0.coachId = 'co';
      return s;
    };
    const a = mk();
    const b = mk();
    const full = trainTeam(a, 't0', 'balanced');
    const part = trainTeam(b, 't0', 'balanced', undefined, sessionTrainOptions('extra'));
    const k = CONFIG.training.extraSessionAttrMult;
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(1);
    for (const g of full) {
      const h = part.find((x) => x.playerId === g.playerId)!;
      expect(h.power).toBe(g.power); // 同一随机序列：战力 / 天梯 / 灵性完全相同
      expect(h.mmr).toBe(g.mmr);
      expect(h.insight).toBe(g.insight);
      expect(h.resilience).toBeCloseTo(g.resilience * k, 1);
      expect(h.talent).toBeLessThan(g.talent);
    }
    expect(sessionTrainOptions('free')).toBeUndefined();
    expect(sessionTrainOptions(null)).toBeUndefined();
  });

  it('年轻选手训练自然增长天赋', () => {
    const s = oneYearState(1);
    setTeam(s, 't0', { age: 18, talent: 50 });
    let total = 0;
    for (let i = 0; i < 10; i++) total += trainTeam(s, 't0', 'balanced').reduce((a, g) => a + g.talent, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('不存在的战队/空战队返回空数组', () => {
    const s = oneYearState(0);
    expect(trainTeam(s, 'nope', 'power')).toEqual([]);
  });

  it('scrimMultiplier：约练强队收益更高，约弱队也高于普通训练（下限 > 1），夹紧', () => {
    const s = makeTestState(6); // t0 战力 70 … t5 战力 75
    expect(scrimMultiplier(s, 't0', 't5')).toBeGreaterThan(scrimMultiplier(s, 't5', 't0'));
    expect(scrimMultiplier(s, 't5', 't0')).toBeGreaterThan(1);
    expect(scrimMultiplier(s, 't0', 't0')).toBeCloseTo(CONFIG.training.scrimMultBase);
    s.players['t5-C'].power = 500;
    expect(scrimMultiplier(s, 't0', 't5')).toBe(CONFIG.training.scrimMultMax);
    expect(scrimMultiplier(s, 't5', 't0')).toBe(CONFIG.training.scrimMultMin);
  });
});

describe('growth: 赛事成长', () => {
  it('冠军收益高于垫底；未出场无成长', () => {
    let champ = 0;
    let last = 0;
    for (let t = 0; t < 40; t++) {
      const a = oneYearState(1, 300 + t);
      setTeam(a, 't0', { age: 21, talent: 70 });
      champ += applyTournamentGrowth(a, 't0', 0, 'major', 6).reduce((x, g) => x + g.power, 0);
      const b = oneYearState(1, 300 + t);
      setTeam(b, 't0', { age: 21, talent: 70 });
      last += applyTournamentGrowth(b, 't0', 1, 'major', 6).reduce((x, g) => x + g.power, 0);
    }
    expect(champ).toBeGreaterThan(last * 2);
    const s = oneYearState(1);
    expect(applyTournamentGrowth(s, 't0', 0, 'ti', 0)).toEqual([]);
    const growth = applyTournamentGrowth(s, 't0', 0.5, 'ti', 4);
    expect(growth).toHaveLength(5);
    expect(growth[0]).toHaveProperty('mmr');
  });
});

describe('growth: 成长重平衡（训练为主、比赛主要带来韧性，2026-10-09）', () => {
  it('赛事成长：战力 / 天梯 / 灵性很少，主要涨韧性；TI 与深入的名次涨得更多', () => {
    let tiChamp = 0;
    let minorLast = 0;
    for (let t = 0; t < 40; t++) {
      const a = oneYearState(1, 900 + t);
      setTeam(a, 't0', { age: 21, talent: 70 });
      for (const id of a.teams.t0.playerIds) a.players[id].resilience = 40;
      tiChamp += applyTournamentGrowth(a, 't0', 0, 'ti', 8).reduce((x, g) => x + (g.resilience ?? 0), 0);
      const b = oneYearState(1, 900 + t);
      setTeam(b, 't0', { age: 21, talent: 70 });
      for (const id of b.teams.t0.playerIds) b.players[id].resilience = 40;
      minorLast += applyTournamentGrowth(b, 't0', 1, 'minor', 2).reduce((x, g) => x + (g.resilience ?? 0), 0);
    }
    expect(tiChamp).toBeGreaterThan(minorLast * 3);
    const s = oneYearState(1);
    setTeam(s, 't0', { age: 21, talent: 70 });
    const res0 = s.players['t0-C'].resilience;
    const g = applyTournamentGrowth(s, 't0', 0.5, 'premier', 4).find((x) => x.playerId === 't0-C')!;
    expect(g.resilience).toBeGreaterThan(0);
    expect(s.players['t0-C'].resilience).toBeCloseTo(res0 + g.resilience!, 5);
  });

  it('一次训练的战力 / 天梯收益是一项中等赛事的数倍（均值）', () => {
    let train = { power: 0, mmr: 0 };
    let tour = { power: 0, mmr: 0 };
    for (let t = 0; t < 60; t++) {
      const a = oneYearState(1, 1300 + t);
      setTeam(a, 't0', { age: 20, talent: 75, power: 72, mmr: 8000 });
      for (const g of trainTeam(a, 't0', 'balanced')) { train.power += g.power; train.mmr += g.mmr; }
      const b = oneYearState(1, 1300 + t);
      setTeam(b, 't0', { age: 20, talent: 75, power: 72, mmr: 8000 });
      for (const g of applyTournamentGrowth(b, 't0', 0.5, 'premier', 3)) { tour.power += g.power; tour.mmr += g.mmr; }
    }
    // 复核（2026-10-09）：单次训练收回约 1/4（免费训练不再白送大部分成长），天梯约为一项中等赛事的 3.5~4 倍
    expect(train.power).toBeGreaterThan(tour.power * 4);
    expect(train.mmr).toBeGreaterThan(tour.mmr * 3);
  });

  /** 一个赛季：sessions 次训练（均衡）+ tournaments 项中游赛事（各 3 场系列赛），不含年龄衰退 */
  function inSeason(talent: number, sessions: number, tournaments: number, trials = 80) {
    let power = 0;
    let mmr = 0;
    for (let t = 0; t < trials; t++) {
      const s = oneYearState(1, 7000 + t);
      setTeam(s, 't0', { age: 20, talent, power: 72, mmr: 8000 });
      const p = s.players['t0-C'];
      const p0 = { power: p.power, mmr: p.mmr };
      for (let i = 0; i < sessions; i++) trainTeam(s, 't0', 'balanced');
      for (let i = 0; i < tournaments; i++) applyTournamentGrowth(s, 't0', 0.5, 'premier', 3);
      power += p.power - p0.power;
      mmr += p.mmr - p0.mmr;
    }
    return { power: power / trials, mmr: mmr / trials };
  }

  it('一直训练（每个休赛回合免费 + 3 次额外）远快于只打比赛；低天赋即使训练也长得慢', () => {
    const trainHard = inSeason(80, 60, 1);
    const tourOnly = inSeason(80, 1, 19);
    const lowTalent = inSeason(40, 60, 1);
    expect(trainHard.power).toBeGreaterThan(tourOnly.power * 5);
    expect(trainHard.mmr).toBeGreaterThan(tourOnly.mmr * 5);
    expect(tourOnly.power).toBeLessThan(1.6); // 改动前同样 19 项赛事约 +3.5 战力
    expect(lowTalent.power).toBeLessThan(trainHard.power * 0.65);
    expect(lowTalent.mmr).toBeLessThan(trainHard.mmr * 0.65);
  });

  it('AI 战队训练按 CONFIG.training.aiGainMult 单独缩放（gainMult 只作用于战力 / 天梯 / 灵性）', () => {
    let full = 0;
    let half = 0;
    for (let t = 0; t < 40; t++) {
      const a = oneYearState(2, 2100 + t);
      full += trainTeam(a, 't1', 'balanced').reduce((x, g) => x + g.power, 0);
      const b = oneYearState(2, 2100 + t);
      half += trainTeam(b, 't1', 'balanced', undefined, { gainMult: { power: 0.5, mmr: 0.5, insight: 0.5 } }).reduce((x, g) => x + g.power, 0);
    }
    expect(half / full).toBeGreaterThan(0.45);
    expect(half / full).toBeLessThan(0.55);
  });
});

describe('growth: 平衡目标', () => {
  function seasonGain(
    age: number, talent: number, power: number, focus: 'power' | 'balanced', slot: 'C' | 'HS' = 'C', trials = 120,
  ) {
    let sum = 0;
    for (let t = 0; t < trials; t++) {
      const s = oneYearState(1, 5000 + t);
      setTeam(s, 't0', { age, talent, power, mmr: 9000 });
      const p = s.players[`t0-${slot}`];
      const p0 = p.power;
      for (let i = 0; i < 14; i++) trainTeam(s, 't0', focus);
      for (let i = 0; i < 5; i++) applyTournamentGrowth(s, 't0', 0.5, 'premier', 5);
      agePlayersAtSeasonEnd(s);
      sum += p.power - p0;
    }
    return sum / trials;
  }

  // 第五波（E3）：战力软上限起点 97 → 95.5（赛季状态 ±7% 抬高了有效战力），年轻选手同样训练量的涨幅略降
  it('天赋 70 的 21 岁选手一个赛季约 +2.3~+6 战力（专项训练高于均衡）', () => {
    const balanced = seasonGain(21, 70, 75, 'balanced');
    const power = seasonGain(21, 70, 75, 'power');
    expect(balanced).toBeGreaterThan(2.3);
    expect(power).toBeLessThan(6.5);
    expect(power).toBeGreaterThan(balanced);
  });

  // 第五波（E3）：加强年龄衰退、巅峰年龄按位置区分（1 号位 21–25，辅助 23–28）
  it('30 岁 1 号位一个赛季（含年龄衰减）约 -3.5~-6 战力', () => {
    const d = seasonGain(30, 55, 82, 'balanced', 'C');
    expect(d).toBeLessThan(-3.5);
    expect(d).toBeGreaterThan(-6);
  });

  it('30 岁 5 号位衰退更慢：约 -1~-3 战力', () => {
    const c = seasonGain(30, 55, 82, 'balanced', 'C');
    const hs = seasonGain(30, 55, 82, 'balanced', 'HS');
    expect(hs).toBeLessThan(-1);
    expect(hs).toBeGreaterThan(-3);
    expect(hs).toBeGreaterThan(c);
  });

  it('27 岁 1 号位：刚过巅峰，温和下滑（不是断崖）', () => {
    const d = seasonGain(27, 55, 82, 'balanced', 'C');
    expect(d).toBeLessThan(0);
    expect(d).toBeGreaterThan(-3);
  });
});

describe('growth: 年龄与退役', () => {
  it('agePlayersAtSeasonEnd：老将衰减、韧性灵性提升、年轻人战力不衰减', () => {
    const s = oneYearState(0);
    s.players.old = makePlayer({ id: 'old', birthYear: 1990, power: 80, mmr: 10000, talent: 50, resilience: 50, insight: 50 });
    s.players.kid = makePlayer({ id: 'kid', birthYear: 2004, power: 60, mmr: 7000, talent: 70, resilience: 30, insight: 40 });
    s.players.gone = makePlayer({ id: 'gone', birthYear: 1980, power: 80, status: 'retired' });
    agePlayersAtSeasonEnd(s);
    const old = s.players.old;
    expect(old.power).toBeLessThan(80);
    expect(old.mmr).toBeLessThan(10000);
    expect(old.talent).toBeLessThanOrEqual(50);
    expect(old.resilience).toBeGreaterThan(50);
    expect(old.insight).toBeGreaterThan(50);
    expect(s.players.kid.power).toBe(60);
    expect(s.players.kid.mmr).toBe(7000);
    expect(s.players.kid.talent).toBe(70);
    expect(s.players.gone.power).toBe(80);
  });

  it('TI9 → TI10 跨两年：衰减两次', () => {
    let one = 0;
    let two = 0;
    for (let t = 0; t < 40; t++) {
      const a = oneYearState(0, t + 1);
      a.players.x = makePlayer({ id: 'x', birthYear: a.season.year - 30, power: 80 });
      agePlayersAtSeasonEnd(a);
      one += 80 - a.players.x.power;
      const b = makeTestState(0, t + 1); // TI9 2019
      b.players.x = makePlayer({ id: 'x', birthYear: b.season.year - 30, power: 80 });
      agePlayersAtSeasonEnd(b);
      two += 80 - b.players.x.power;
    }
    expect(two).toBeGreaterThan(one * 1.6);
  });

  it('processRetirements：>25 岁按概率退役，转教练，记录原战队', () => {
    const s = oneYearState(1);
    // 40 岁 C 级：p = min(0.85, 0.06×15 + 0.15) = 0.85
    const vets: string[] = [];
    for (let i = 0; i < 30; i++) {
      const p = makePlayer({ id: `v${i}`, birthYear: 1982, mmr: 4000, isReal: true, insight: 77 });
      s.players[p.id] = p;
      vets.push(p.id);
    }
    // 年轻人不会退役
    s.players.young = makePlayer({ id: 'young', birthYear: 2000 });
    // 队内老将
    const tp = s.players['t0-C'];
    tp.birthYear = 1982;
    tp.mmr = 4000;
    const { retired, newCoaches } = processRetirements(s);
    expect(retired.length).toBeGreaterThan(15);
    expect(retired.every((p) => p.status === 'retired' && p.teamId === null)).toBe(true);
    expect(retired.find((p) => p.id === 'young')).toBeUndefined();
    expect(newCoaches.length).toBe(retired.length); // 真实/在队选手全部转教练
    for (const c of newCoaches) {
      const from = s.players[c.formerPlayerId!];
      expect(c.tier).toBe(playerTier(from));
      expect(c.insight).toBe(from.insight);
      expect(c.teamId).toBeNull();
      expect(s.coaches[c.id]).toBe(c);
    }
    if (tp.status === 'retired') {
      expect(tp.lastTeamId).toBe('t0');
      expect(s.teams.t0.playerIds).not.toContain(tp.id);
      expect(s.teams.t0.lineup.C).toBeNull();
    }
  });

  it('程序化低等级自由选手退役不生成教练', () => {
    const s = oneYearState(0, 9);
    for (let i = 0; i < 40; i++) {
      s.players[`g${i}`] = makePlayer({ id: `g${i}`, birthYear: 1982, mmr: 4000, isReal: false });
    }
    const { retired, newCoaches } = processRetirements(s);
    expect(retired.length).toBeGreaterThan(20);
    expect(newCoaches).toHaveLength(0);
  });

  it('野外替补候选（一次性程序化选手）不参与退役/转教练', () => {
    const s = oneYearState(0, 5);
    for (let i = 0; i < 30; i++) {
      s.players[`w${i}`] = makePlayer({ id: `w${i}`, birthYear: 1982, mmr: 16000, isWildSub: true });
      s.tempSubCandidates.push(`w${i}`);
    }
    const { retired, newCoaches } = processRetirements(s);
    expect(retired).toHaveLength(0);
    expect(newCoaches).toHaveLength(0);
  });

  it('赛季结算清除新秀标记（新秀身份只持续一个赛季）', () => {
    const s = oneYearState(1);
    s.players['t0-C'].isRookie = true;
    s.players.fa = makePlayer({ id: 'fa', isRookie: true, birthYear: 2004 });
    s.players.gone = makePlayer({ id: 'gone', isRookie: true, status: 'retired' });
    agePlayersAtSeasonEnd(s);
    expect(s.players['t0-C'].isRookie).toBeUndefined();
    expect(s.players.fa.isRookie).toBeUndefined();
    expect(s.players.gone.isRookie).toBeUndefined();
  });
});

describe('growth: 归属感', () => {
  it('adjustLoyalty 夹在 0..100', () => {
    const p = makePlayer({ loyalty: 95 });
    adjustLoyalty(p, 20);
    expect(p.loyalty).toBe(100);
    adjustLoyalty(p, -500);
    expect(p.loyalty).toBe(0);
  });

  it('roundLoyaltyUpdate：长期替补扣分、荣誉落差扣分（人类战队按在队时长加速）、自由选手回归', () => {
    const s = oneYearState(1); // TI11；初始队员 TI9 加盟 → 第三个赛季（速度 ×2）
    s.teams.t0.honor = 10000; // 无荣誉落差
    const sub = makePlayer({ id: 'sub', loyalty: 70, mmr: 9000 });
    s.players.sub = sub;
    addPlayerToTeam(s, 'sub', 't0', { contractSeasons: 1 }); // 本赛季加盟 → ×0.5
    const fa = makePlayer({ id: 'fa', loyalty: 20 });
    s.players.fa = fa;
    // 工资 = 隐藏的预期薪资：薪资维度为 0，只剩荣誉维度（荣誉远超期待 → 小幅自豪加成）
    const pin = () => {
      for (const id of s.teams.t0.playerIds) s.players[id].salary = expectedSalary(s, s.players[id]);
    };
    pin();
    const proud = CONFIG.salary.loyalty.honorProudBonus;

    roundLoyaltyUpdate(s);
    expect(sub.benchRounds).toBe(1);
    expect(sub.loyalty).toBeCloseTo(70 + proud * tenureSpeedMult(0)); // 替补宽限期内不扣
    roundLoyaltyUpdate(s);
    expect(sub.benchRounds).toBe(2);
    expect(sub.loyalty).toBeCloseTo(70 + 2 * proud * tenureSpeedMult(0) + CONFIG.loyalty.benchPerRound);
    expect(s.players['t0-C'].benchRounds).toBe(0);
    expect(s.players['t0-C'].loyalty).toBeCloseTo(70 + 2 * proud * tenureSpeedMult(2));
    expect(fa.loyalty).toBeGreaterThan(20);
    expect(fa.loyalty).toBeLessThan(CONFIG.loyalty.freeAgentTarget);

    // 荣誉显著低于 SS 选手期待：落差越大扣得越多，× 在队时长速度倍数
    s.teams.t0.honor = 50;
    const m = s.players['t0-M'];
    m.mmr = 12000;
    m.loyalty = 70;
    pin();
    roundLoyaltyUpdate(s);
    expect(honorLoyaltyDelta(50, 'SS')).toBeLessThan(0);
    expect(m.loyalty).toBeCloseTo(70 + honorLoyaltyDelta(50, 'SS') * tenureSpeedMult(2));
    // B 级选手期待低，不扣
    const o = s.players['t0-O'];
    o.mmr = 5600;
    o.loyalty = 70;
    pin();
    roundLoyaltyUpdate(s);
    expect(o.loyalty).toBe(70);
  });

  it('roundLoyaltyUpdate：阵容超出常规上限时，长期替补的归属感下降更快（每多 1 人更快，有上限），首发不受影响', () => {
    const per = CONFIG.loyalty.overRosterBenchPerRound;
    expect(per).toBeLessThan(0);
    expect(overRosterBenchPenalty(CONFIG.team.maxRoster)).toBe(0);
    expect(overRosterBenchPenalty(3)).toBe(0);
    expect(overRosterBenchPenalty(CONFIG.team.maxRoster + 1)).toBeCloseTo(per);
    expect(overRosterBenchPenalty(CONFIG.team.maxRoster + 2)).toBeCloseTo(2 * per);
    expect(overRosterBenchPenalty(99)).toBeCloseTo(CONFIG.loyalty.overRosterBenchMaxExcess * per);

    /** 阵容 size 人（首发 5 人 + 替补），返回同一名长期替补与一名首发在一回合后的归属感 */
    const run = (size: number) => {
      const s = oneYearState(1);
      s.teams.t0.honor = 10000;
      for (let i = 0; s.teams.t0.playerIds.length < size; i++) {
        const p = makePlayer({ id: `b${i}`, loyalty: 70, mmr: 9000, position: 'SS' });
        s.players[p.id] = p;
        addPlayerToTeam(s, p.id, 't0', { contractSeasons: 2 });
      }
      for (const id of s.teams.t0.playerIds) s.players[id].salary = expectedSalary(s, s.players[id]);
      const sub = s.players.b0;
      sub.loyalty = 70;
      sub.benchRounds = 5; // 已过替补宽限期
      const starter = s.players['t0-C'];
      starter.loyalty = 70;
      roundLoyaltyUpdate(s);
      return { sub: sub.loyalty, starter: starter.loyalty };
    };
    const normal = run(CONFIG.team.maxRoster);
    const big = run(CONFIG.team.maxRoster + 2);
    const huge = run(CONFIG.team.hardMaxRoster);
    expect(normal.sub).toBeLessThan(70); // 常规替补扣分照旧
    expect(big.sub - normal.sub).toBeCloseTo(2 * per);
    expect(huge.sub).toBeLessThan(big.sub);
    expect(big.starter).toBeCloseTo(normal.starter);
  });
});
