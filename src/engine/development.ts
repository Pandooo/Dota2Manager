// 赛季自主成长（第九波 #2）：对应现实中选手的自主训练【H2】
//
// 每个赛季开始时（season.startSeason → runSeasonDevelopment；TI 结算的退役 / 年龄衰退之后、新秀选秀与休赛期转会潮之前），
// 全体在役选手（首发、替补、自由选手、AI 战队选手；不含野外替补候选）各执行一次。新游戏的第一个赛季不执行。
//   1. 参照水平：
//      - 真实选手：真实生涯轨迹（src/data/trajectories.json）中「当届」的天梯 / 战力（相邻两届之间线性插值，早于首届取首届），
//        并且永远不超过真实生涯峰值 + 余量（CONFIG.development.trajectory.peakMargin*）；
//      - 程序生成选手、真实选手最后一届真实数据之后、多人模式中被重置为新俱乐部水平的真实选手：隐藏潜力上限
//        （首次评估时 = 当时水平 + 天赋 / 年龄决定的成长空间，之后固定）。
//   2. 自主成长（只升不降）：低于参照水平时向其靠拢——天梯为主、战力少量；程序生成选手的速度随年龄递减，
//      已过位置巅峰的老将不再自主成长（只剩 TI 结算时的年龄衰退）。战队选手的目标扣除赛季内预期成长（训练 + 赛事），
//      使「自主成长 + 赛季内成长」≈ 当届参照水平；自由选手不训练也不比赛，目标不扣除。
//   3. 回落：高于参照水平（战队选手同样扣除赛季内预期成长）+ 容差时回落超出部分的一部分（天梯是相对排名：人人上分即
//      整体回落）。AI 战队与自由选手容差小，保证联赛整体等级分布稳定；人类玩家战队容差更大、回落更慢，并且经理花钱练出来的
//      部分（训练投入，天赋决定上限，investmentAllowance）不计入回落——训练是成长的主要来源，练出来的提升能留住。
// 只修改选手的基础 mmr / power 与隐藏记录 Player.development；随机数一律来自 rngOf(state)。
import { CONFIG } from './config';
import { getTrajectory } from '../data/index';
import { peakWindow, trendGrowthMult } from './form';
import { addNews } from './news';
import { ageOf, tierIndex, tierOf } from './player';
import type { Rng } from './rng';
import { rngOf } from './rng';
import { humanTeamIds, isHumanTeam } from './seat';
import type { GameState, Player, PlayerTrajectory, Position, Tier } from './types';
import { clamp, lerp, round2 } from './util';

// ---------------------------------------------------------------------------
// 真实生涯轨迹
// ---------------------------------------------------------------------------

/** 轨迹上的一点（按 TI 升序） */
export interface TrajectoryStep {
  ti: number;
  mmr: number;
  power: number;
}

/** 静态数据只读，按选手 id 缓存解析结果（null = 无轨迹） */
const trajectoryCache = new Map<string, TrajectoryStep[] | null>();

/** 把 JSON 轨迹解析为按 TI 升序的点（忽略异常数据） */
export function parseTrajectory(raw: PlayerTrajectory | null | undefined): TrajectoryStep[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: TrajectoryStep[] = [];
  for (const k of Object.keys(raw)) {
    const ti = Number(k);
    const v = (raw as Record<string, { mmr?: unknown; power?: unknown } | undefined>)[k];
    if (!Number.isFinite(ti) || !v) continue;
    const mmr = Number(v.mmr);
    const power = Number(v.power);
    if (!Number.isFinite(mmr) || !Number.isFinite(power)) continue;
    out.push({ ti, mmr, power });
  }
  return out.sort((a, b) => a.ti - b.ti);
}

/** 选手参照的真实轨迹：仅真实选手、未被重置（development.noTrajectory）且有数据时返回 */
export function trajectoryOf(p: Player | null | undefined): TrajectoryStep[] | null {
  if (!p || !p.isReal || p.development?.noTrajectory) return null;
  if (trajectoryCache.has(p.id)) return trajectoryCache.get(p.id) ?? null;
  let steps: TrajectoryStep[] | null = null;
  try {
    const parsed = parseTrajectory(getTrajectory(p.id));
    steps = parsed.length ? parsed : null;
  } catch {
    steps = null; // 数据层不可用（测试替身等）：按程序生成选手处理
  }
  trajectoryCache.set(p.id, steps);
  return steps;
}

/**
 * 某一届的真实水平：恰有该届数据取原值；落在两届之间线性插值（如 Ceb TI5 → TI8 之间的空档）；
 * 早于首届取首届；晚于最后一届返回 null（之后改按潜力成长）。
 */
export function trajectoryValueAt(steps: readonly TrajectoryStep[], ti: number): { mmr: number; power: number } | null {
  if (!steps.length || !Number.isFinite(ti)) return null;
  const last = steps[steps.length - 1];
  if (ti > last.ti) return null;
  if (ti <= steps[0].ti) return { mmr: steps[0].mmr, power: steps[0].power };
  for (let i = 1; i < steps.length; i++) {
    const b = steps[i];
    if (ti > b.ti) continue;
    const a = steps[i - 1];
    const t = b.ti === a.ti ? 1 : (ti - a.ti) / (b.ti - a.ti);
    return { mmr: lerp(a.mmr, b.mmr, t), power: lerp(a.power, b.power, t) };
  }
  return { mmr: last.mmr, power: last.power };
}

/** 真实生涯峰值（天梯 / 战力分别取最大） */
export function trajectoryPeak(steps: readonly TrajectoryStep[]): { mmr: number; power: number } {
  let mmr = -Infinity;
  let power = -Infinity;
  for (const s of steps) {
    if (s.mmr > mmr) mmr = s.mmr;
    if (s.power > power) power = s.power;
  }
  return { mmr, power };
}

/** 自主成长的硬上限：真实生涯峰值 + 余量（无轨迹 → 不限） */
function trajectoryCap(steps: readonly TrajectoryStep[] | null): { mmr: number; power: number } {
  if (!steps?.length) return { mmr: Infinity, power: Infinity };
  const T = CONFIG.development.trajectory;
  const peak = trajectoryPeak(steps);
  return { mmr: peak.mmr + T.peakMarginMmr, power: peak.power + T.peakMarginPower };
}

// ---------------------------------------------------------------------------
// 潜力（程序生成选手）
// ---------------------------------------------------------------------------

/**
 * 剩余成长年数：位置巅峰窗口起 + growthEndOffset − 年龄；巅峰窗口内至少 inWindowYears；已过巅峰为 0。
 * 例：1 号位（巅峰 21–25）18 岁 → 4 年，21 岁 → 1 年，23 岁 → 0.3 年，26 岁 → 0。
 */
export function growthYearsLeft(age: number, pos: Position | undefined): number {
  if (!Number.isFinite(age)) return 0;
  const P = CONFIG.development.potential;
  const [start, end] = peakWindow(pos);
  if (age > end) return 0;
  return Math.max(start + P.growthEndOffset - age, P.inWindowYears, 0);
}

/** 天赋系数：(max(0, 天赋 − pivot) / span)^exp，上限 talentMultMax（天赋 70 ≈ 1、90 ≈ 1.8、50 ≈ 0.4、≤ 25 为 0） */
export function talentGrowthMult(talent: number): number {
  const P = CONFIG.development.potential;
  const t = Number.isFinite(talent) ? talent : P.talentPivot;
  const x = Math.max(0, t - P.talentPivot) / Math.max(1, P.talentSpan);
  return Math.min(P.talentMultMax, Math.pow(x, P.talentExp));
}

/** 天梯越高成长空间越小（与训练相同的软上限：growth.mmrSoftCap） */
function mmrRoomMult(mmr: number): number {
  const g = CONFIG.growth;
  return clamp((g.mmrSoftCap - (Number.isFinite(mmr) ? mmr : 0)) / g.mmrSoftCapRange, g.mmrSoftCapMin, 1);
}

/** 战力越高成长空间越小（与训练相同的软上限：player.powerSoftCap*） */
function powerRoomMult(power: number): number {
  const c = CONFIG.player;
  return clamp((c.powerSoftCapStart - (Number.isFinite(power) ? power : 0)) / c.powerSoftCapRange, c.powerSoftCapMin, 1);
}

/** 成长空间（jitter = 1 为期望值）：perYear × 剩余年数^yearsExp × 天赋系数 × jitter × 软上限 */
export function growthHeadroom(
  age: number,
  pos: Position | undefined,
  talent: number,
  mmr: number,
  power: number,
  jitter = 1,
): { mmr: number; power: number } {
  const P = CONFIG.development.potential;
  const years = growthYearsLeft(age, pos);
  if (!(years > 0)) return { mmr: 0, power: 0 };
  const base = Math.pow(years, P.yearsExp) * talentGrowthMult(talent) * (Number.isFinite(jitter) ? Math.max(0, jitter) : 1);
  return {
    mmr: P.mmrPerYear * base * mmrRoomMult(mmr),
    power: P.powerPerYear * base * powerRoomMult(power),
  };
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampMmr = (v: number) => clamp(v, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr);

/**
 * 隐藏潜力上限：已评估过直接返回；否则按当前水平 + 成长空间（× U(jitter)）评估并保存（之后固定）。
 * cap：真实选手最后一届数据之后的硬上限（真实生涯峰值 + 余量）。
 */
export function ensurePotential(
  state: GameState,
  p: Player,
  rng: Rng,
  cap: { mmr: number; power: number } = { mmr: Infinity, power: Infinity },
): { mmr: number; power: number } {
  const d = (p.development ??= {});
  if (Number.isFinite(d.potentialMmr) && Number.isFinite(d.potentialPower)) {
    return { mmr: d.potentialMmr as number, power: d.potentialPower as number };
  }
  const P = CONFIG.development.potential;
  const mmr = num(p.mmr, CONFIG.ladder.thresholds.C);
  const power = num(p.power, 50);
  const jitter = rng.range(P.jitter[0], P.jitter[1]);
  const h = growthHeadroom(ageOf(state, p), p.position, num(p.talent, 50), mmr, power, jitter);
  d.potentialMmr = Math.round(clampMmr(Math.min(mmr + h.mmr, cap.mmr)));
  d.potentialPower = round2(Math.max(1, Math.min(power + h.power, cap.power)));
  return { mmr: d.potentialMmr, power: d.potentialPower };
}

/** 程序生成选手的自主成长速度年龄系数：巅峰前 1、巅峰窗口内 inWindowMult、已过巅峰 0 */
export function potentialAgeMult(age: number, pos: Position | undefined): number {
  const [start, end] = peakWindow(pos);
  if (!Number.isFinite(age) || age > end) return 0;
  return age < start ? 1 : CONFIG.development.potential.inWindowMult;
}

// ---------------------------------------------------------------------------
// 单名选手的赛季自主成长
// ---------------------------------------------------------------------------

/** 本赛季的参照水平与靠拢速度 */
export interface DevelopmentTarget {
  source: 'trajectory' | 'potential';
  mmr: number;
  power: number;
  /** 低于参照水平时每赛季靠拢差距的比例（不含随机） */
  mmrRate: number;
  powerRate: number;
}

/** 计算本赛季参照水平（可能首次评估并保存潜力上限，消耗随机数） */
export function developmentTarget(state: GameState, p: Player, rng: Rng, ti: number = state.season?.ti ?? 0): DevelopmentTarget {
  const steps = trajectoryOf(p);
  const cap = trajectoryCap(steps);
  if (steps) {
    const at = trajectoryValueAt(steps, ti);
    if (at) {
      const T = CONFIG.development.trajectory;
      return {
        source: 'trajectory',
        mmr: Math.min(at.mmr, cap.mmr),
        power: Math.min(at.power, cap.power),
        mmrRate: T.mmrRate,
        powerRate: T.powerRate,
      };
    }
  }
  const pot = ensurePotential(state, p, rng, cap);
  const P = CONFIG.development.potential;
  const ageMult = potentialAgeMult(ageOf(state, p), p.position) * trendGrowthMult(p);
  return {
    source: 'potential',
    mmr: Math.min(pot.mmr, cap.mmr),
    power: Math.min(pot.power, cap.power),
    mmrRate: P.mmrRate * ageMult,
    powerRate: P.powerRate * ageMult,
  };
}

/** 单项属性一次自主成长的参数 */
export interface DevelopmentDeltaParams {
  /** 自主成长的目标：低于它时靠拢差距 × upRate × jitter（不超过 maxUp，永不越过目标） */
  up: number;
  upRate: number;
  maxUp: number;
  /** 回落的参照：高于它 + tolerance 时回落超出部分 × downRate × jitter（不超过 maxDown）；down ≥ up */
  down: number;
  tolerance: number;
  downRate: number;
  maxDown: number;
  jitter?: number;
}

/** 单项属性的变化：低于成长目标 → 靠拢；高于回落参照 + 容差 → 回落；其间不变 */
export function developmentDelta(cur: number, k: DevelopmentDeltaParams): number {
  if (!Number.isFinite(cur) || !Number.isFinite(k.up) || !Number.isFinite(k.down)) return 0;
  const j = Number.isFinite(k.jitter) ? Math.max(0, k.jitter as number) : 1;
  if (cur < k.up) {
    const gap = k.up - cur;
    return Math.max(0, Math.min(gap, k.maxUp, gap * Math.max(0, k.upRate) * j));
  }
  const excess = cur - Math.max(k.up, k.down) - Math.max(0, k.tolerance);
  if (excess > 0) return -Math.max(0, Math.min(excess, k.maxDown, excess * Math.max(0, k.downRate) * j));
  return 0;
}

/**
 * 战队选手的赛季内预期成长（训练 + 赛事成长）：per × 年龄系数 ×（替补 benchMult）× 软上限（CONFIG.development.seasonAllowance）。
 * 自主成长的目标扣除这部分，使「自主成长 + 赛季内成长」≈ 当届参照水平；自由选手不训练、不比赛，不扣除。
 */
export function seasonGrowthAllowance(age: number, mmr: number, power: number, starter = true): { mmr: number; power: number } {
  const A = CONFIG.development.seasonAllowance;
  const table = A.byAge ?? [];
  let mult = table.length ? table[table.length - 1][1] : 0;
  for (const [maxAge, f] of table) {
    if (age <= maxAge) {
      mult = f;
      break;
    }
  }
  if (!starter) mult *= Number.isFinite(A.benchMult) ? Math.max(0, A.benchMult) : 1;
  if (!Number.isFinite(mult) || mult <= 0) return { mmr: 0, power: 0 };
  return { mmr: A.mmr * mult * mmrRoomMult(mmr), power: A.power * mult * powerRoomMult(power) };
}

/**
 * 训练投入保护（成长重平衡，2026-10-09；CONFIG.development.investment）：人类玩家战队选手高于参照水平的部分中，
 * 有多少是经理花钱练出来、不应在赛季初被「到顶回落」抹掉的。
 * 保护量 = min(训练投入 Player.development.trained*, 天赋决定的上限 max × (天赋/100)^talentExp)
 * （天赋 90 ≈ 上限 × 0.85、70 ≈ 0.57、50 ≈ 0.33、30 ≈ 0.15：天赋越高，越能被练到轨迹 / 潜力之上）。
 */
export function investmentAllowance(p: Player): { mmr: number; power: number } {
  const I = CONFIG.development.investment;
  const d = p.development;
  if (!I?.enabled || !d) return { mmr: 0, power: 0 };
  const t = clamp(num(p.talent, 50), 0, 100) / 100;
  const share = Math.pow(t, Math.max(0, num(I.talentExp, 1)));
  return {
    mmr: Math.max(0, Math.min(num(d.trainedMmr, 0), I.maxMmr * share)),
    power: Math.max(0, Math.min(num(d.trainedPower, 0), I.maxPower * share)),
  };
}

/** 训练投入是否「明显」（天梯相对校准最后才回落这些选手） */
export function hasTrainingInvestment(p: Player): boolean {
  const I = CONFIG.development.investment;
  return !!I?.enabled && num(p.development?.trainedMmr, 0) >= I.calibrationMinMmr;
}

/** 每个赛季自主成长之后，训练投入按 decay 衰减（不再继续训练的选手，保护会逐季减少） */
function decayInvestment(p: Player): void {
  const d = p.development;
  if (!d) return;
  const keep = 1 - clamp(num(CONFIG.development.investment?.decay, 0), 0, 1);
  if (Number.isFinite(d.trainedMmr)) {
    const v = Math.round((d.trainedMmr as number) * keep);
    if (v > 0) d.trainedMmr = v;
    else delete d.trainedMmr;
  }
  if (Number.isFinite(d.trainedPower)) {
    const v = round2((d.trainedPower as number) * keep);
    if (v > 0) d.trainedPower = v;
    else delete d.trainedPower;
  }
}

/** 一名选手本赛季的自主成长结果 */
export interface DevelopmentChange {
  playerId: string;
  mmr: number;
  power: number;
  tierBefore: Tier;
  tierAfter: Tier;
  source: DevelopmentTarget['source'];
}

/** 是否参与自主成长：在役、非野外替补候选 */
function develops(p: Player | null | undefined): p is Player {
  return !!p && p.status === 'active' && !p.isWildSub;
}

/**
 * 对一名选手执行本赛季的自主成长（同一赛季只执行一次：Player.development.ti）。返回变化（未执行返回 null）。
 */
export function developPlayer(state: GameState, p: Player, rng: Rng, ti: number = state.season?.ti ?? 0): DevelopmentChange | null {
  if (!develops(p)) return null;
  const D = CONFIG.development;
  const d = (p.development ??= {});
  if (d.ti === ti) return null;
  const target = developmentTarget(state, p, rng, ti);
  const human = isHumanTeam(state, p.teamId);
  const team = p.teamId ? state.teams[p.teamId] : undefined;
  const R = human ? D.regression.human : D.regression.ai;
  const [jLo, jHi] = D.jitter;
  const oldMmr = num(p.mmr, CONFIG.ladder.thresholds.C);
  const oldPower = num(p.power, 50);
  const tierBefore = tierOf(oldMmr);
  // 战队选手（AI 与人类同一基准）：目标与回落参照都扣除赛季内预期成长（训练 + 赛事），自由选手不扣除。
  // 人类玩家战队只是回落容差更大、回落更慢：经理比 AI 多练的部分（容差以内）会保留下来
  const onTeam = !!team && !team.disbanded;
  const starter = onTeam && Object.values(team!.lineup ?? {}).includes(p.id);
  const allow = onTeam ? seasonGrowthAllowance(ageOf(state, p), oldMmr, oldPower, starter) : { mmr: 0, power: 0 };
  // 人类玩家战队：经理花钱练出来的部分（训练投入，天赋决定上限）不计入回落
  const inv = human && onTeam ? investmentAllowance(p) : { mmr: 0, power: 0 };

  const dMmr = developmentDelta(oldMmr, {
    up: target.mmr - allow.mmr, upRate: target.mmrRate, maxUp: D.maxUpMmr,
    down: target.mmr - allow.mmr + inv.mmr, tolerance: R.mmrTolerance, downRate: R.mmrRate, maxDown: D.regression.maxDownMmr,
    jitter: rng.range(jLo, jHi),
  });
  const dPower = developmentDelta(oldPower, {
    up: target.power - allow.power, upRate: target.powerRate, maxUp: D.maxUpPower,
    down: target.power - allow.power + inv.power, tolerance: R.powerTolerance, downRate: R.powerRate, maxDown: D.regression.maxDownPower,
    jitter: rng.range(jLo, jHi),
  });
  p.mmr = Math.round(clampMmr(oldMmr + dMmr));
  p.power = round2(Math.max(1, oldPower + dPower));
  const change: DevelopmentChange = {
    playerId: p.id,
    mmr: p.mmr - oldMmr,
    power: round2(p.power - oldPower),
    tierBefore,
    tierAfter: tierOf(p.mmr),
    source: target.source,
  };
  d.ti = ti;
  d.mmr = change.mmr;
  d.power = change.power;
  decayInvestment(p);
  return change;
}

// ---------------------------------------------------------------------------
// 天梯相对校准（第九波 QA）
// ---------------------------------------------------------------------------

/** 一次校准回落 */
export interface LadderDemotion {
  playerId: string;
  /** 回落前 / 后天梯 */
  from: number;
  to: number;
  /** 触发回落的等级上限（SSR / SS 及以上） */
  cap: Tier;
}

/** 联赛在籍选手：未解散战队的正式队员（在役、非临时 / 野外替补） */
function rosteredPlayers(state: GameState): Player[] {
  const out: Player[] = [];
  for (const id in state.players) {
    const p = state.players[id];
    if (!p || p.status !== 'active' || p.isWildSub || p.tempSubUntilTournament || !p.teamId) continue;
    const team = state.teams?.[p.teamId];
    if (!team || team.disbanded) continue;
    out.push(p);
  }
  return out;
}

/** 本届是否有真实参照（有当届真实轨迹的真实选手不参与校准） */
function hasTrajectoryAt(p: Player, ti: number): boolean {
  const steps = trajectoryOf(p);
  return !!steps && trajectoryValueAt(steps, ti) !== null;
}

/** 选手本赛季的赛季内预期天梯成长（战队首发 / 替补；见 seasonGrowthAllowance） */
function seasonMmrAllowance(state: GameState, p: Player, mmr: number): number {
  const team = p.teamId ? state.teams?.[p.teamId] : undefined;
  if (!team || team.disbanded) return 0;
  const starter = Object.values(team.lineup ?? {}).includes(p.id);
  return seasonGrowthAllowance(ageOf(state, p), mmr, num(p.power, 50), starter).mmr;
}

/**
 * 天梯相对校准（CONFIG.development.ladder）：按「赛季内预期成长之后」的天梯（≈ 本届 TI 时的水平）统计，
 * 联赛在籍选手中 SSR / SS 及以上人数超过上限时，没有当届真实参照的选手按预期天梯从低到高回落（有明显训练投入的选手最后才回落），
 * 使其本届 TI 时约在该等级门槛 − margin（潜力上限同步下调，下赛季的自主成长不会再推回去）。
 * 确定性（不消耗随机数）；有当届真实轨迹的真实选手不参与。changes：同时更新本赛季自主成长记录（供简报新闻）。
 */
export function calibrateLadder(state: GameState, changes?: DevelopmentChange[], ti: number = state.season?.ti ?? 0): LadderDemotion[] {
  const L = CONFIG.development.ladder;
  if (!L?.enabled) return [];
  const th = CONFIG.ladder.thresholds;
  const margin = Math.max(1, num(L.margin, 150));
  const pool = rosteredPlayers(state);
  const n = pool.length;
  if (!n) return [];
  const byId = changes ? new Map(changes.map((c) => [c.playerId, c])) : null;
  const out: LadderDemotion[] = [];
  const caps: { tier: Tier; allowed: number }[] = [
    { tier: 'SSR', allowed: Math.max(Math.max(0, Math.floor(num(L.ssrMin, 0))), Math.floor(n * Math.max(0, num(L.ssrShare, 1)))) },
    { tier: 'SS', allowed: Math.floor(n * Math.max(0, num(L.ssPlusShare, 1))) },
  ];
  const projected = (p: Player) => num(p.mmr, 0) + seasonMmrAllowance(state, p, num(p.mmr, 0));
  for (const cap of caps) {
    const floor = th[cap.tier];
    const above = pool.filter((p) => projected(p) >= floor);
    let excess = above.length - cap.allowed;
    if (excess <= 0) continue;
    // 没有训练投入的选手先回落（按预期天梯从低到高）；人类玩家战队花钱练出来的选手排在最后，仍计入名额（联赛整体公平；
    // 被卖到 AI 战队的选手不再优先保护）
    const eligible = above
      .filter((p) => !hasTrajectoryAt(p, ti))
      .map((p) => ({ p, proj: projected(p), invested: hasTrainingInvestment(p) && isHumanTeam(state, p.teamId) ? 1 : 0 }))
      .sort((a, b) => a.invested - b.invested || a.proj - b.proj || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
    for (const { p } of eligible) {
      if (excess <= 0) break;
      const from = num(p.mmr, floor);
      const to = Math.round(clampMmr(floor - margin - seasonMmrAllowance(state, p, floor - margin)));
      if (from <= to) continue;
      p.mmr = to;
      const d = (p.development ??= {});
      if (Number.isFinite(d.potentialMmr)) d.potentialMmr = Math.min(d.potentialMmr as number, to);
      if (d.ti === ti) d.mmr = num(d.mmr, 0) + (to - from);
      const c = byId?.get(p.id);
      if (c) {
        c.mmr += to - from;
        c.tierAfter = tierOf(to);
      }
      out.push({ playerId: p.id, from, to, cap: cap.tier });
      excess--;
    }
  }
  return out;
}

/**
 * 赛季初：全体在役选手执行一次自主成长（新游戏的第一个赛季、或 CONFIG.development.enabled = false 时不执行），
 * 之后做一次天梯相对校准（calibrateLadder）。返回全部变化；人类玩家战队另发一条本队简报（私有新闻）。
 */
export function runSeasonDevelopment(state: GameState): DevelopmentChange[] {
  const D = CONFIG.development;
  const ti = state.season?.ti;
  if (!D?.enabled || !Number.isFinite(ti)) return [];
  const startTi = state.settings?.startTi;
  if (Number.isFinite(startTi) && (ti as number) <= startTi) return [];
  const rng = rngOf(state);
  const changes: DevelopmentChange[] = [];
  for (const id in state.players) {
    const c = developPlayer(state, state.players[id], rng, ti as number);
    if (c) changes.push(c);
  }
  calibrateLadder(state, changes, ti as number);
  if (D.newsForHumanTeams) developmentNews(state, changes);
  return changes;
}

// ---------------------------------------------------------------------------
// 新闻
// ---------------------------------------------------------------------------

function notable(c: DevelopmentChange): boolean {
  const D = CONFIG.development;
  return c.tierBefore !== c.tierAfter || Math.abs(c.mmr) >= D.newsMinMmr || Math.abs(c.power) >= D.newsMinPower;
}

function changeText(state: GameState, c: DevelopmentChange): string {
  const p = state.players[c.playerId];
  const parts: string[] = [];
  if (c.mmr) parts.push(`天梯 ${c.mmr > 0 ? '+' : ''}${c.mmr}`);
  // 战力按一位小数显示：|变化| < 0.05 时不列（避免「战力 +0.0」）
  if (Math.abs(c.power) >= 0.05) parts.push(`战力 ${c.power > 0 ? '+' : ''}${c.power.toFixed(1)}`);
  const tier = c.tierBefore !== c.tierAfter ? `，${c.tierBefore} → ${c.tierAfter}` : '';
  return `${p?.handle ?? c.playerId}（${parts.join('、')}${tier}）`;
}

/** 每支人类玩家战队一条本队自主成长简报（只列变化明显的正式队员；无明显变化不发） */
function developmentNews(state: GameState, changes: DevelopmentChange[]): void {
  if (!changes.length) return;
  const byId = new Map(changes.map((c) => [c.playerId, c]));
  for (const teamId of humanTeamIds(state)) {
    const team = state.teams[teamId];
    if (!team || team.disbanded) continue;
    const mine = (team.playerIds ?? [])
      .map((pid) => byId.get(pid))
      .filter((c): c is DevelopmentChange => !!c && notable(c));
    if (!mine.length) continue;
    const ups = mine.filter((c) => c.mmr > 0 || (c.mmr === 0 && c.power > 0))
      .sort((a, b) => tierIndex(b.tierAfter) - tierIndex(a.tierAfter) || b.mmr - a.mmr);
    const downs = mine.filter((c) => !ups.includes(c)).sort((a, b) => a.mmr - b.mmr);
    const body = (ups.length ? `明显进步：${ups.map((c) => changeText(state, c)).join('、')}。` : '')
      + (downs.length ? `新赛季天梯重新定级后回落：${downs.map((c) => changeText(state, c)).join('、')}。` : '')
      + '休赛期的自主训练以天梯为主：越年轻、天赋越高进步越快，已过巅峰的老将以保持状态为主。赛季内的成长主要靠休赛回合的训练（看天赋、花钱多），'
      + '比赛主要带来荣誉、金钱与韧性；经理练出来的提升大多会保留下来（天赋越高，能超出自身上限越多）。';
    addNews(state, 'season', `${team.name} 休赛期自主训练`, body, false, {
      teamIds: [team.id],
      playerIds: mine.map((c) => c.playerId),
      scope: 'mine',
      visibility: 'private',
    });
  }
}

// ---------------------------------------------------------------------------
// 界面：定性成长趋势（不暴露潜力数值）
// ---------------------------------------------------------------------------

export type GrowthOutlook = '仍有成长空间' | '接近巅峰' | '已过巅峰';
export const GROWTH_OUTLOOKS: GrowthOutlook[] = ['仍有成长空间', '接近巅峰', '已过巅峰'];

export const GROWTH_OUTLOOK_HINT: Record<GrowthOutlook, string> = {
  仍有成长空间: '仍处上升期：每个赛季开始时的自主训练还能明显提升天梯与战力（越年轻、天赋越高进步越快）。',
  接近巅峰: '已接近自身上限：自主训练以保持水平为主；经理花钱训练仍可突破上限（天赋越高突破越多），练出来的提升大多会保留。',
  已过巅峰: '已过位置巅峰年龄：自主训练难以再进步，能力会随年龄逐渐下滑。',
};

/**
 * 选手的定性成长趋势（只读，不修改状态、不消耗随机数）：比较当前水平与「上限」
 * （真实选手：之后各届真实水平的最高值，不超过生涯峰值 + 余量；程序生成选手：已评估的潜力，未评估时按期望值估算）。
 */
export function developmentOutlook(state: GameState, p: Player): GrowthOutlook {
  const O = CONFIG.development.outlook;
  const ti = state.season?.ti ?? 0;
  const age = ageOf(state, p);
  const [, peakEnd] = peakWindow(p.position);
  const mmr = num(p.mmr, CONFIG.ladder.thresholds.C);
  const power = num(p.power, 50);
  const steps = trajectoryOf(p);
  const cap = trajectoryCap(steps);

  let ceilMmr = mmr;
  let ceilPower = power;
  let rising = age <= peakEnd;
  const future = steps?.filter((s) => s.ti >= ti) ?? [];
  if (future.length) {
    for (const s of future) {
      ceilMmr = Math.max(ceilMmr, Math.min(s.mmr, cap.mmr));
      ceilPower = Math.max(ceilPower, Math.min(s.power, cap.power));
    }
    rising = ceilMmr > mmr || ceilPower > power;
  } else if (rising) {
    const d = p.development;
    if (Number.isFinite(d?.potentialMmr) && Number.isFinite(d?.potentialPower)) {
      ceilMmr = Math.max(ceilMmr, Math.min(d!.potentialMmr as number, cap.mmr));
      ceilPower = Math.max(ceilPower, Math.min(d!.potentialPower as number, cap.power));
    } else {
      const h = growthHeadroom(age, p.position, num(p.talent, 50), mmr, power);
      ceilMmr = Math.max(ceilMmr, Math.min(mmr + h.mmr, cap.mmr));
      ceilPower = Math.max(ceilPower, Math.min(power + h.power, cap.power));
    }
  }
  const room = Math.max(0, ceilMmr - mmr) + Math.max(0, ceilPower - power) * O.powerToMmr;
  if (rising && room >= O.roomHigh) return '仍有成长空间';
  if (age > peakEnd) return '已过巅峰';
  return '接近巅峰';
}
