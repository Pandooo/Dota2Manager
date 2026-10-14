// ============================================================================
// 名人堂与请神原型（2026-10-14 用户需求：「系统引入名人堂：TI1 之前搜集 DotA1 的已存在历史名人构建初始名人堂，
// 每个赛季将该赛季的 SSR 选手引入名人堂并开放给本赛季新秀抽卡用」；用户决策：名人堂收录 SSR 与 SS 选手）
//
// - 初始成员（src/data/hallOfFame.json）：DotA1 时代传奇。source = roster 的成员是真实阵容数据中的选手，
//   以真实生涯轨迹（trajectories.json）为原型，出道等级 = 首届 TI 的等级；source = seed 的成员不在任何阵容数据中，
//   按 JSON 中的数值生成合成轨迹（CONFIG.gacha.seedTrajectory）。
// - 开局补录（2026-10-15 用户决策「补录」）：开局届晚于 TI1 时，建名人堂即补录真实数据（trajectories.json 的等级）中在开局届之前
//   任一届达到过 SS / SSR 的全部真实选手（DotA1 时代传奇除外，保持种子身份）：source = backfill，ti = 首次达到 SS / SSR 的届次，
//   出道等级 = 首届真实轨迹的等级，巅峰等级只取开局届及之前的数据（开局届的等级就是开局阵容里的等级；不剧透未来）；
//   原型轨迹与本局入选的真实选手相同（完整真实生涯）。DotA1 时代传奇中的真实选手同样只登记开局届及之前的巅峰。
//   旧存档 / 旧房间在读档迁移中补录一次（backfillVersion），并补录当前在役的 SS / SSR（赛季结算规则本应收录的）。
// - 真实成员（src = real，含 DotA1 传奇中的真实选手）仍在役时，每个赛季结算按本局等级更新巅峰等级。
// - 每个赛季结算（season.settleSeason，退役之前）：全体在役选手中当时为 SS / SSR、尚未入选的全部入选。
//   真实选手以真实生涯轨迹为原型（src = real）；程序生成选手以本局记录的生涯为原型（src = game：出道点（抽卡出身时）
//   + 入选及之后每个赛季末的天梯 / 战力）；请神新秀入选只作记录（src = summon），不再作为原型（避免「请神的请神」）。
// - 请神（gacha.ts）：卡池中某等级的请神卡只匹配「出道等级」等于该等级的原型。请神新秀出道时复制原型的出道水平
//   （天梯 / 战力 / 天赋 / 灵性 / 位置 / 招牌英雄 / 出道年龄），之后每个赛季的自主成长经由 development.trajectoryOf
//   按原型的生涯轨迹（按出道届次平移：生涯第 k 年 ↔ 原型生涯第 k 年）走，原型数据结束后按普通选手的潜力 / 年龄规律。
// 名人堂为全局公开数据（多人模式所有座位共享，不进座位交换列表）。本模块的查询不消耗随机数。
// ============================================================================
import type { GameState, HallOfFameMember, HallOfFameState, Player, Position, Tier } from './types';
import { POSITIONS, TIERS } from './types';
import { CONFIG, TI_YEAR } from './config';
import { getHallOfFameSeeds, getPlayerIndex, getTrajectories, getTrajectory, type HallOfFameSeed } from '../data/index';
import { playerTier } from './player';
import { realRoleFor } from './roles';
import { addNews } from './news';
import { clamp, lerp, ownEntry, round2 } from './util';
import type { PlayerIndexEntry } from './types';

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// 等级换算（与 player.tierOf / tierIndex 同口径；本模块自带，初始成员的构建不依赖 player 模块——测试替身中也可用）
function tierIndex(t: Tier): number {
  const i = TIERS.indexOf(t);
  return i < 0 ? 0 : i;
}
function tierOf(mmr: number): Tier {
  const th = CONFIG.ladder.thresholds;
  if (!Number.isFinite(mmr)) return 'C';
  for (let i = TIERS.length - 1; i >= 0; i--) if (mmr >= th[TIERS[i]]) return TIERS[i];
  return 'C';
}

/** 原型生涯的一点：off = 距出道的赛季数（0 = 出道届） */
export interface PrototypeStep {
  off: number;
  mmr: number;
  power: number;
}

/** 原型的出道属性（请神新秀复制） */
export interface PrototypeDebut {
  mmr: number;
  power: number;
  talent: number;
  insight: number;
  position: Position;
  heroes: string[];
  /** 出道年龄 */
  age: number;
}

/** TI 序号 → 年份（超出数据范围时按最后一届顺延） */
function yearOfTi(ti: number): number {
  const y = TI_YEAR[ti];
  if (Number.isFinite(y)) return y;
  const keys = Object.keys(TI_YEAR).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const last = keys[keys.length - 1] ?? 16;
  return (TI_YEAR[last] ?? 2027) + (ti - last);
}

let INDEX: Map<string, PlayerIndexEntry> | null = null;
function indexEntry(id: string): PlayerIndexEntry | undefined {
  if (!INDEX) {
    INDEX = new Map();
    try {
      for (const e of getPlayerIndex() ?? []) if (e?.id) INDEX.set(e.id, e);
    } catch {
      /* 数据层不可用（测试替身）：没有真实选手原型 */
    }
  }
  return INDEX.get(id);
}

function seedById(id: string): HallOfFameSeed | undefined {
  try {
    return (getHallOfFameSeeds() ?? []).find((s) => s?.id === id);
  } catch {
    return undefined;
  }
}

function isTier(t: unknown): t is Tier {
  return typeof t === 'string' && (TIERS as string[]).includes(t);
}

// ---------------------------------------------------------------------------
// 原型轨迹
// ---------------------------------------------------------------------------

/** 真实生涯轨迹（按 TI 升序）：[TI, 天梯, 战力] */
function realSteps(id: string): [number, number, number][] {
  let raw;
  try {
    raw = getTrajectory(id);
  } catch {
    raw = undefined;
  }
  if (!raw) return [];
  const out: [number, number, number][] = [];
  for (const k of Object.keys(raw)) {
    const ti = Number(k);
    const v = (raw as Record<string, { mmr?: unknown; power?: unknown }>)[k];
    const mmr = Number(v?.mmr);
    const power = Number(v?.power);
    if (Number.isFinite(ti) && Number.isFinite(mmr) && Number.isFinite(power)) out.push([ti, mmr, power]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 真实生涯每届的等级（按 TI 升序）：取 trajectories.json 的 tier（缺失 / 非法时按天梯换算） */
function realTierSteps(id: string): [number, Tier][] {
  let raw;
  try {
    raw = getTrajectory(id);
  } catch {
    raw = undefined;
  }
  if (!raw) return [];
  const out: [number, Tier][] = [];
  for (const k of Object.keys(raw)) {
    const ti = Number(k);
    const v = (raw as Record<string, { mmr?: unknown; tier?: unknown }>)[k];
    if (!Number.isFinite(ti)) continue;
    const tier = isTier(v?.tier) ? v.tier : Number.isFinite(Number(v?.mmr)) ? tierOf(Number(v?.mmr)) : null;
    if (tier) out.push([ti, tier]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 一组等级中的最高者（空时取 fallback） */
function maxTier(tiers: Iterable<Tier>, fallback: Tier): Tier {
  let best = fallback;
  for (const t of tiers) if (tierIndex(t) > tierIndex(best)) best = t;
  return best;
}

/** 等级区间内的天梯：门槛 + frac × 区间宽度（最高等级的宽度取 topTierSpan） */
function mmrInTier(tier: Tier, frac: number): number {
  const th = CONFIG.ladder.thresholds;
  const i = tierIndex(tier);
  const next = TIERS[i + 1];
  const span = next ? th[next] - th[tier] : CONFIG.gacha.seedTrajectory.topTierSpan;
  return Math.round(clamp(th[tier] + clamp(frac, 0, 1) * span, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr));
}

const seedStepCache = new Map<string, PrototypeStep[]>();

/**
 * 合成轨迹（source = seed 的种子）：生涯第 1 年出道 → 第 peakYear 年巅峰（线性）→ 保持到 declineFromYear − 1 → 之后每年衰退，
 * 共 careerYears 年。天梯：出道 = 出道等级区间的 mmrFracDebut 处，巅峰 = 巅峰等级区间的 mmrFracPeak 处，衰退期每年 −declineMmrPerYear。
 */
export function seedTrajectorySteps(seed: HallOfFameSeed): PrototypeStep[] {
  const hit = seedStepCache.get(seed.id);
  if (hit) return hit;
  const T = CONFIG.gacha.seedTrajectory;
  const pw = seed.power;
  const debutTier: Tier = isTier(seed.debutTier) ? seed.debutTier : 'S';
  const peakTier: Tier = isTier(seed.peakTier) ? seed.peakTier : debutTier;
  const out: PrototypeStep[] = [];
  if (pw && Number.isFinite(pw.debut) && Number.isFinite(pw.peak)) {
    const years = Math.max(1, Math.floor(num(T.careerYears, 10)));
    const peakYear = clamp(Math.floor(num(pw.peakYear, 1)), 1, years);
    const declineFrom = Math.max(peakYear + 1, Math.floor(num(pw.declineFromYear, years + 1)));
    const mDebut = mmrInTier(debutTier, T.mmrFracDebut);
    const mPeak = Math.max(mDebut, mmrInTier(peakTier, T.mmrFracPeak));
    for (let k = 1; k <= years; k++) {
      let power: number;
      let mmr: number;
      if (k <= peakYear) {
        const t = peakYear > 1 ? (k - 1) / (peakYear - 1) : 1;
        power = lerp(pw.debut, pw.peak, t);
        mmr = lerp(mDebut, mPeak, t);
      } else if (k < declineFrom) {
        power = pw.peak;
        mmr = mPeak;
      } else {
        const d = k - declineFrom + 1;
        power = pw.peak - d * T.declinePowerPerYear;
        mmr = mPeak - d * T.declineMmrPerYear;
      }
      out.push({ off: k - 1, mmr: Math.round(clamp(mmr, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr)), power: round2(Math.max(1, power)) });
    }
  }
  seedStepCache.set(seed.id, out);
  return out;
}

/** 原型的生涯轨迹（按距出道的赛季数升序）；不能作为原型（请神新秀入选 / 数据缺失）返回 [] */
export function prototypeSteps(member: HallOfFameMember | null | undefined): PrototypeStep[] {
  if (!member) return [];
  switch (member.src) {
    case 'real': {
      const steps = realSteps(member.id);
      if (!steps.length) return [];
      const first = steps[0][0];
      return steps.map(([ti, mmr, power]) => ({ off: ti - first, mmr, power }));
    }
    case 'seed': {
      const seed = seedById(member.id);
      return seed ? seedTrajectorySteps(seed) : [];
    }
    case 'game': {
      const traj = Array.isArray(member.traj) ? member.traj.filter((x) => Array.isArray(x) && x.length >= 3) : [];
      if (!traj.length) return [];
      const sorted = traj.slice().sort((a, b) => a[0] - b[0]);
      const first = sorted[0][0];
      return sorted.map(([ti, mmr, power]) => ({ off: ti - first, mmr: num(mmr, 0), power: num(power, 0) }));
    }
    default:
      return [];
  }
}

/** 原型的出道属性（请神新秀复制）；不能作为原型返回 null */
export function prototypeDebut(member: HallOfFameMember | null | undefined): PrototypeDebut | null {
  if (!member) return null;
  const steps = prototypeSteps(member);
  if (!steps.length) return null;
  const first = steps[0];
  switch (member.src) {
    case 'real': {
      const e = indexEntry(member.id);
      const firstTi = realSteps(member.id)[0]?.[0] ?? e?.firstTi ?? 1;
      return {
        mmr: first.mmr,
        power: first.power,
        talent: num(e?.peakTalent, 60),
        insight: num(e?.insight, 50),
        position: realRoleFor(member.id, firstTi) ?? (e && POSITIONS.includes(e.position) ? e.position : member.position),
        heroes: (e?.signatureHeroes ?? []).slice(),
        age: yearOfTi(firstTi) - num(e?.birthYear ?? member.birthYear, yearOfTi(firstTi) - 20),
      };
    }
    case 'seed': {
      const seed = seedById(member.id);
      return {
        mmr: first.mmr,
        power: first.power,
        talent: num(seed?.talent, 60),
        insight: num(seed?.insight, 60),
        position: member.position,
        heroes: (seed?.signatureHeroes ?? []).slice(),
        age: Math.round(num(seed?.debutAge, CONFIG.gacha.seedTrajectory.seedDebutAge)),
      };
    }
    case 'game': {
      const firstTi = (member.traj ?? []).reduce((m, x) => Math.min(m, num(x?.[0], Infinity)), Infinity);
      return {
        mmr: first.mmr,
        power: first.power,
        talent: num(member.talent, 60),
        insight: num(member.insight, 50),
        position: member.position,
        heroes: (member.heroes ?? []).slice(),
        age: Number.isFinite(firstTi) ? yearOfTi(firstTi) - member.birthYear : 20,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 名人堂状态
// ---------------------------------------------------------------------------

/**
 * 由种子数据构建初始成员（数据缺失的跳过）。startTi：开局届——阵容数据中的传奇（src = real）的巅峰等级只取开局届及之前的真实数据
 * （首届真实轨迹晚于开局届时取首届，即出道等级），不剧透未来；缺省 = 整个真实生涯（只用于测试替身 / 旧口径对照）。
 */
export function seedMembers(startTi?: number): HallOfFameMember[] {
  let seeds: HallOfFameSeed[] = [];
  try {
    seeds = getHallOfFameSeeds() ?? [];
  } catch {
    seeds = [];
  }
  const out: HallOfFameMember[] = [];
  const seen = new Set<string>();
  for (const s of seeds) {
    if (!s?.id || seen.has(s.id)) continue;
    if (s.source === 'roster') {
      const steps = realSteps(s.id);
      const e = indexEntry(s.id);
      if (!steps.length || !e) continue;
      const firstTi = steps[0][0];
      const cutoff = startTi !== undefined && Number.isFinite(startTi) ? Math.max(Math.floor(startTi), firstTi) : Infinity;
      let peak: Tier = 'C';
      for (const [ti, mmr] of steps) if (ti <= cutoff && tierIndex(tierOf(mmr)) > tierIndex(peak)) peak = tierOf(mmr);
      out.push({
        id: s.id,
        handle: s.handle || e.handle || s.id,
        source: 'seed',
        era: 'dota1',
        ti: 0,
        debutTier: tierOf(steps[0][1]),
        peakTier: peak,
        position: realRoleFor(s.id, firstTi) ?? (POSITIONS.includes(e.position) ? e.position : 'C'),
        nationality: (e.nationality || 'EU').toUpperCase(),
        birthYear: num(e.birthYear, 1990),
        src: 'real',
      });
    } else {
      if (!isTier(s.debutTier) || !seedTrajectorySteps(s).length) continue;
      out.push({
        id: s.id,
        handle: s.handle || s.id,
        source: 'seed',
        era: 'dota1',
        ti: 0,
        debutTier: s.debutTier,
        peakTier: isTier(s.peakTier) ? s.peakTier : s.debutTier,
        position: POSITIONS.includes(s.position as Position) ? (s.position as Position) : 'C',
        nationality: (s.nationality || 'EU').toUpperCase(),
        birthYear: num(s.birthYear, 1990),
        src: 'seed',
      });
    }
    seen.add(s.id);
  }
  return out;
}

/**
 * 名人堂数据的版本：旧存档 / 旧房间的名人堂缺失或落后于此时，读档迁移一次（migrateHallOfFame）。
 * 1 = 开局补录；2 = 真实成员（DotA1 传奇中的真实选手 / 本局入选 / 补录）的巅峰等级改为只取截止届及之前的真实数据 + 本局等级
 * （v0.3 开发版存档按整个真实生涯登记，含未来数据）。
 */
export const HOF_BACKFILL_VERSION = 2;

/** 达到即入选名人堂的等级（与赛季结算 hofEligible 同口径） */
function hofTier(t: Tier): boolean {
  return t === 'SS' || t === 'SSR';
}

const backfillCache = new Map<number, HallOfFameMember[]>();

/**
 * 开局补录（2026-10-15 用户决策「补录」）：真实数据中在 startTi 之前任一届达到过 SS / SSR 的真实选手（按 id 排序）。
 * ti = 首次达到 SS / SSR 的届次；出道等级 = 首届真实轨迹的等级；巅峰等级只取 startTi 及之前的数据（开局届的等级即开局阵容中的等级，
 * 不剧透未来）；
 * 位置 = 出道届的真实位置；原型轨迹为完整真实生涯（src = real，与本局入选的真实选手相同）。exclude：已在名人堂中的成员（种子等）。
 * 返回新对象（调用方可修改）。
 */
export function backfillMembers(startTi: number, exclude: ReadonlySet<string> = new Set()): HallOfFameMember[] {
  const start = Math.floor(num(startTi, 1));
  let base = backfillCache.get(start);
  if (!base) {
    base = [];
    let all: Record<string, unknown> = {};
    try {
      all = getTrajectories() ?? {};
    } catch {
      all = {};
    }
    for (const id of Object.keys(all).sort()) {
      const steps = realTierSteps(id);
      const first = steps.find(([ti, t]) => ti < start && hofTier(t));
      if (!first) continue;
      const e = indexEntry(id);
      if (!e) continue;
      const firstTi = steps[0][0];
      base.push({
        id,
        handle: e.handle || id,
        source: 'backfill',
        ti: first[0],
        debutTier: steps[0][1],
        peakTier: maxTier(steps.filter(([ti]) => ti <= start).map(([, t]) => t), first[1]),
        position: realRoleFor(id, firstTi) ?? (POSITIONS.includes(e.position) ? e.position : 'C'),
        nationality: (e.nationality || 'EU').toUpperCase(),
        birthYear: num(e.birthYear, 1990),
        src: 'real',
      });
    }
    backfillCache.set(start, base);
  }
  return base.filter((m) => !exclude.has(m.id)).map((m) => ({ ...m }));
}

/** 新游戏的初始名人堂：DotA1 时代传奇 + 开局补录（startTi 之前的真实 SS / SSR）；真实成员的巅峰只取 startTi 及之前的数据 */
export function initialHallOfFame(startTi: number): HallOfFameState {
  const members = seedMembers(Math.floor(num(startTi, 1)));
  const seen = new Set(members.map((m) => m.id));
  members.push(...backfillMembers(startTi, seen));
  return { members, backfillVersion: HOF_BACKFILL_VERSION };
}

/** 名人堂（缺失时以初始成员 + 开局补录创建；新游戏在第一个赛季初创建） */
export function ensureHallOfFame(state: GameState): HallOfFameState {
  const cur = state.hallOfFame;
  if (cur && typeof cur === 'object' && Array.isArray(cur.members)) return cur;
  state.hallOfFame = initialHallOfFame(state.settings?.startTi ?? 1);
  return state.hallOfFame;
}

const initialCache = new Map<number, HallOfFameMember[]>();

/** 名人堂成员（只读；未创建时返回初始成员 + 开局补录的缓存副本） */
export function hallOfFameMembers(state: GameState): HallOfFameMember[] {
  const list = state.hallOfFame?.members;
  if (Array.isArray(list)) return list;
  const start = Math.floor(num(state.settings?.startTi, 1));
  let hit = initialCache.get(start);
  if (!hit) {
    hit = initialHallOfFame(start).members;
    initialCache.set(start, hit);
  }
  return hit;
}

/** 按 id 查成员 */
export function hofMember(state: GameState, id: string | null | undefined): HallOfFameMember | null {
  if (!id) return null;
  return hallOfFameMembers(state).find((m) => m?.id === id) ?? null;
}

/** 能否作为请神原型（请神新秀入选的成员不行；数据缺失的不行） */
export function isSummonable(member: HallOfFameMember | null | undefined): boolean {
  return !!member && member.src !== 'summon' && prototypeSteps(member).length > 0;
}

/** 出道等级为 tier 的可用原型（按 id 排序，保证确定性） */
export function summonPrototypes(state: GameState, tier: Tier): HallOfFameMember[] {
  return hallOfFameMembers(state)
    .filter((m) => m && m.debutTier === tier && isSummonable(m))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 请神新秀的轨迹（development.trajectoryOf 使用）
// ---------------------------------------------------------------------------

const summonCache = new Map<string, { ti: number; mmr: number; power: number }[]>();

/**
 * 请神新秀的参照轨迹：原型生涯第 k 年（off）↔ 本局 summon.ti + off 届。原型为本局记录（game）时每次现算（随原型继续记录而延长），
 * 其余按「原型 id + 出道届次」缓存（静态数据）。原型缺失返回 null（之后按普通选手的潜力规律）。
 */
export function summonTrajectory(state: GameState, p: Player | null | undefined): { ti: number; mmr: number; power: number }[] | null {
  const s = p?.summon;
  if (!s || !s.id || !Number.isFinite(s.ti)) return null;
  const member = hofMember(state, s.id);
  if (!member) return null;
  const key = `${member.src}:${member.id}:${s.ti}`;
  if (member.src !== 'game') {
    const hit = summonCache.get(key);
    if (hit) return hit.length ? hit : null;
  }
  const steps = prototypeSteps(member).map((x) => ({ ti: s.ti + x.off, mmr: x.mmr, power: x.power }));
  if (member.src !== 'game') summonCache.set(key, steps);
  return steps.length ? steps : null;
}

/** 某原型当前在役的请神新秀 */
export function livingSummonsOf(state: GameState, protoId: string): Player[] {
  const out: Player[] = [];
  for (const id in state.players) {
    const p = state.players[id];
    if (p && p.status === 'active' && !p.isWildSub && p.summon?.id === protoId) out.push(p);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 各原型在役请神新秀人数（一次遍历） */
export function livingSummonCounts(state: GameState): Map<string, number> {
  const m = new Map<string, number>();
  for (const id in state.players) {
    const p = state.players[id];
    if (p && p.status === 'active' && !p.isWildSub && p.summon?.id) m.set(p.summon.id, (m.get(p.summon.id) ?? 0) + 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// 入选（赛季结算）
// ---------------------------------------------------------------------------

/** 入选标准：当时的天梯等级为 SS 或 SSR */
export function hofEligible(p: Player | null | undefined): p is Player {
  if (!p || p.status !== 'active' || p.isWildSub) return false;
  const t = playerTier(p);
  return t === 'SS' || t === 'SSR';
}

/** 由一名选手构建入选记录 */
function memberFromPlayer(state: GameState, p: Player, ti: number): HallOfFameMember {
  const tierNow = playerTier(p);
  const base = {
    id: p.id,
    handle: p.handle,
    source: 'inducted' as const,
    ti,
    position: p.position,
    nationality: p.nationality,
    birthYear: p.birthYear,
  };
  if (p.summon) {
    return { ...base, debutTier: p.gacha?.tier ?? tierNow, peakTier: tierNow, src: 'summon', of: p.summon.id };
  }
  const real = p.isReal ? realSteps(p.id) : [];
  if (real.length) {
    // 巅峰等级：本届等级与入选届及之前的真实数据（不剧透未来；之后的赛季结算按本局等级更新，见 inductHallOfFame）
    const peak = maxTier(realTierSteps(p.id).filter(([t]) => t <= ti).map(([, t]) => t), tierNow);
    const firstTi = real[0][0];
    return {
      ...base,
      debutTier: tierOf(real[0][1]),
      peakTier: peak,
      position: realRoleFor(p.id, firstTi) ?? p.position,
      src: 'real',
    };
  }
  // 本局记录：出道点（抽卡出身且早于本届时）+ 本届
  const traj: [number, number, number][] = [];
  const g = p.gacha;
  if (g && Number.isFinite(g.ti) && g.ti < ti && Number.isFinite(g.mmr) && Number.isFinite(g.power)) {
    traj.push([g.ti, Math.round(g.mmr), round2(g.power)]);
  }
  traj.push([ti, Math.round(num(p.mmr, 0)), round2(num(p.power, 0))]);
  return {
    ...base,
    debutTier: tierOf(traj[0][1]),
    peakTier: tierNow,
    src: 'game',
    traj,
    talent: round2(num(g?.talent, num(p.talent, 50))),
    insight: round2(num(g?.insight, num(p.insight, 50))),
    heroes: (p.signatureHeroes ?? []).slice(0, 4),
  };
}

/**
 * 赛季结算（退役之前）：在役选手中当时为 SS / SSR、尚未入选的全部入选；本局记录生涯的成员（src = game）若仍在役，
 * 追加本届的天梯 / 战力（并更新巅峰等级）；真实成员（DotA1 传奇中的真实选手 / 开局补录 / 本局入选）若仍在役，巅峰等级按本局等级更新。
 * 确定性（不消耗随机数）。返回新入选成员；有新成员时发一条公开新闻。
 * opts.extend = false：只补录新成员，不追加 / 更新已有成员（读档迁移在赛季中途调用，本届的记录留给赛季结算）。
 */
export function inductHallOfFame(
  state: GameState, ti: number = state.season?.ti ?? 0, opts: { news?: boolean; extend?: boolean } = {},
): HallOfFameMember[] {
  const hof = ensureHallOfFame(state);
  const byId = new Map(hof.members.map((m) => [m.id, m]));
  const max = Math.max(2, Math.floor(num(CONFIG.gacha.hofTrajMax, 20)));
  // 已入选的真实选手（DotA1 传奇中的真实选手 / 开局补录 / 本局入选）：巅峰等级按本局等级更新（伍声等合成轨迹的传奇不在本局，按登记数据）
  for (const m of opts.extend === false ? [] : hof.members) {
    if (m.src !== 'real') continue;
    const p = state.players[m.id];
    if (!p || p.status !== 'active' || p.isWildSub) continue;
    const t = playerTier(p);
    if (tierIndex(t) > tierIndex(m.peakTier)) m.peakTier = t;
  }
  // 已入选的本局记录成员：追加本届
  for (const m of opts.extend === false ? [] : hof.members) {
    if (m.src !== 'game') continue;
    const p = state.players[m.id];
    if (!p || p.status !== 'active') continue;
    const traj = (m.traj ??= []);
    const last = traj[traj.length - 1];
    if (last && last[0] >= ti) continue;
    traj.push([ti, Math.round(num(p.mmr, 0)), round2(num(p.power, 0))]);
    if (traj.length > max) traj.splice(1, traj.length - max); // 保留出道点
    const t = playerTier(p);
    if (tierIndex(t) > tierIndex(m.peakTier)) m.peakTier = t;
  }
  const fresh: HallOfFameMember[] = [];
  const ids = Object.keys(state.players).sort();
  for (const id of ids) {
    const p = state.players[id];
    if (!hofEligible(p) || byId.has(p.id)) continue;
    const m = memberFromPlayer(state, p, ti);
    hof.members.push(m);
    byId.set(m.id, m);
    fresh.push(m);
  }
  if (fresh.length && opts.news !== false) hallOfFameNews(state, fresh, ti);
  return fresh;
}

function hallOfFameNews(state: GameState, fresh: HallOfFameMember[], ti: number): void {
  const sorted = fresh.slice().sort((a, b) => tierIndex(b.peakTier) - tierIndex(a.peakTier) || (a.handle < b.handle ? -1 : 1));
  const ssr = sorted.filter((m) => m.peakTier === 'SSR');
  const shown = sorted.slice(0, 12).map((m) => `${m.handle}（${m.peakTier}${m.src === 'summon' ? ` · 请神 ${hofMember(state, m.of)?.handle ?? m.of}` : ''}）`);
  addNews(
    state,
    'season',
    `【名人堂】TI${ti} 赛季 ${fresh.length} 名选手入选名人堂`,
    `本赛季结算时天梯等级为 SS / SSR 的选手入选名人堂${ssr.length ? `（其中 SSR ${ssr.length} 人）` : ''}：${shown.join('、')}`
      + `${sorted.length > shown.length ? ` 等` : ''}。下个赛季起，名人堂成员可作为新秀抽卡的「请神」原型（出道等级与卡的等级相同）。`,
    false,
    { playerIds: sorted.slice(0, 12).map((m) => m.id).filter((id) => !!state.players[id]), tags: ['hall-of-fame'], noInfer: true },
  );
}

/** 名人堂需要读档迁移：缺失，或开局补录的版本落后（multi.migrateRoomState 的快速判断） */
export function hallOfFameNeedsMigration(state: GameState): boolean {
  const hof = state.hallOfFame;
  return !hof || typeof hof !== 'object' || !Array.isArray(hof.members) || !(num(hof.backfillVersion, 0) >= HOF_BACKFILL_VERSION);
}

/** 本局中该选手的等级证据：当前在役的等级与 DotaPedia 记录的本局巅峰等级（赛季末快照）中的较高者；都没有时 null */
function inGamePeakTier(state: GameState, id: string): Tier | null {
  let best = -1;
  const p = ownEntry(state.players, id);
  if (p && p.status === 'active' && !p.isWildSub) best = tierIndex(playerTier(p));
  const pt = Number(ownEntry(state.pedia?.players, id)?.pt);
  if (Number.isInteger(pt) && pt >= 0 && pt < TIERS.length && pt > best) best = pt;
  return best >= 0 ? TIERS[best] : null;
}

/**
 * 读档迁移（版本 2）：按现行口径重算真实成员（src = real）的巅峰等级——真实数据只取截止届及之前（DotA1 传奇 / 补录：开局届，
 * 首届真实轨迹更晚时取首届；本局入选：入选届，且入选时至少 SS），再加上本局的等级证据（inGamePeakTier）。
 * v0.3 开发版按整个真实生涯登记（含未来数据，可能降低）；补录成员旧口径不含开局届（只会抬高）。返回改动的成员数。
 */
function normalizeRealPeaks(state: GameState): number {
  const members = state.hallOfFame?.members;
  if (!Array.isArray(members)) return 0;
  const start = Math.floor(num(state.settings?.startTi, 1));
  let changed = 0;
  for (const m of members) {
    if (!m || m.src !== 'real') continue;
    const steps = realTierSteps(m.id);
    if (!steps.length) continue;
    const cutoff = m.source === 'inducted' ? num(m.ti, start) : Math.max(start, steps[0][0]);
    let bound = maxTier(steps.filter(([t]) => t <= cutoff).map(([, t]) => t), steps[0][1]);
    if (m.source === 'inducted') bound = maxTier(['SS'], bound);
    const seen = inGamePeakTier(state, m.id);
    if (seen) bound = maxTier([seen], bound);
    const next = m.source === 'backfill' && isTier(m.peakTier) ? maxTier([m.peakTier], bound) : bound;
    if (m.peakTier !== next) {
      m.peakTier = next;
      changed++;
    }
  }
  return changed;
}

/**
 * 旧存档迁移（save.upgradeLoadedState / multi.migrateRoomState；幂等，按 backfillVersion 只执行一次）：
 * - 没有名人堂：以初始成员 + 开局补录创建（同新游戏），并补录当前在役的 SS / SSR 选手（记为当前赛季入选，migratedTi）；
 * - 有名人堂但没有开局补录（v0.3 开发版存档，版本 < 1）：补录开局届（settings.startTi）之前的真实 SS / SSR（已在名人堂的不重复），
 *   并补录当前在役的 SS / SSR（已打过的赛季结算本应收录的；backfilledTi）；
 * - 版本 < 2：真实成员的巅峰等级按现行口径重算（normalizeRealPeaks：只取截止届及之前的真实数据 + 本局等级，去掉未来数据）；
 *   已是版本 1 的存档只做这一步（不再补录当前在役的 SS / SSR：赛季中途新晋的留给赛季结算）。
 * 不发新闻、不消耗随机数。返回是否迁移。
 */
export function migrateHallOfFame(state: GameState): boolean {
  if (!hallOfFameNeedsMigration(state)) return false;
  const ti = state.season?.ti ?? 0;
  const fresh = !state.hallOfFame || typeof state.hallOfFame !== 'object' || !Array.isArray(state.hallOfFame.members);
  // 补录（版本 < 1）：开局届之前的真实 SS / SSR + 当前在役的 SS / SSR。版本 1 的存档已补录过：只重算巅峰，不在赛季中途提前收录本赛季新晋的 SS / SSR
  let backfill = fresh;
  if (fresh) {
    delete state.hallOfFame;
    ensureHallOfFame(state);
    state.hallOfFame!.migratedTi = ti;
  } else {
    const hof = state.hallOfFame!;
    hof.members = hof.members.filter((m) => !!m && typeof m === 'object' && typeof m.id === 'string');
    if (!(num(hof.backfillVersion, 0) >= 1)) {
      const seen = new Set(hof.members.map((m) => m.id));
      hof.members.push(...backfillMembers(state.settings?.startTi ?? 1, seen));
      hof.backfilledTi = ti;
      backfill = true;
    }
    hof.backfillVersion = HOF_BACKFILL_VERSION;
  }
  normalizeRealPeaks(state);
  if (backfill) inductHallOfFame(state, ti, { news: false, extend: false });
  return true;
}

// ---------------------------------------------------------------------------
// DotaPedia / 界面（只读）
// ---------------------------------------------------------------------------

export interface HallOfFameRow {
  id: string;
  handle: string;
  source: HallOfFameMember['source'];
  era: 'dota1' | null;
  ti: number;
  debutTier: Tier;
  peakTier: Tier;
  position: Position;
  nationality: string;
  src: HallOfFameMember['src'];
  /** 能否作为请神原型 */
  summonable: boolean;
  /** 在役请神新秀人数 */
  livingSummons: number;
  /** 请神新秀入选：其原型 */
  ofId: string | null;
  ofHandle: string | null;
  /** 本局中的选手状态（在役 / 退役 / 不在本局） */
  inGame: 'active' | 'retired' | 'absent';
}

/** 名人堂成员来源的显示顺序：DotA1 时代 → 真实数据补录 → 本局入堂 */
const SOURCE_ORDER: Record<HallOfFameMember['source'], number> = { seed: 0, backfill: 1, inducted: 2 };

/** 名人堂成员来源的中文名 */
export const HOF_SOURCE_LABEL: Record<HallOfFameMember['source'], string> = {
  seed: 'DotA1 时代',
  backfill: '真实数据补录',
  inducted: '本局入堂',
};

/** 名人堂列表：DotA1 时代在前，其次真实数据补录、本局入堂，各自按入选赛季、巅峰等级 */
export function hallOfFameRows(state: GameState): HallOfFameRow[] {
  const counts = livingSummonCounts(state);
  const rows = hallOfFameMembers(state).filter((m) => !!m).map((m): HallOfFameRow => {
    const p = state.players[m.id];
    return {
      id: m.id,
      handle: m.handle,
      source: m.source,
      era: m.era ?? null,
      ti: num(m.ti, 0),
      debutTier: m.debutTier,
      peakTier: m.peakTier,
      position: m.position,
      nationality: m.nationality,
      src: m.src,
      summonable: isSummonable(m),
      livingSummons: counts.get(m.id) ?? 0,
      ofId: m.of ?? null,
      ofHandle: m.of ? hofMember(state, m.of)?.handle ?? m.of : null,
      inGame: p ? (p.status === 'active' ? 'active' : 'retired') : 'absent',
    };
  });
  return rows.sort((a, b) => (SOURCE_ORDER[a.source] ?? 3) - (SOURCE_ORDER[b.source] ?? 3)
    || a.ti - b.ti
    || tierIndex(b.peakTier) - tierIndex(a.peakTier)
    || (a.handle.toLowerCase() < b.handle.toLowerCase() ? -1 : 1));
}
