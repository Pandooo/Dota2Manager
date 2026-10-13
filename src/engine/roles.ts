// 位置：位置系数、副位置与真实生涯位置（第十三波；用户反馈 2026-10-12：「spirit 的 mira/miposhka/rue/notme 都是四号位……
// 至少有两个是 5 号位，或者是四号、五号位都可以，不然无法组建完整阵容」）
//
// 本模块是纯查询（不修改状态、不消耗随机数、只读静态数据并按选手 id 缓存），可被 player.ts 等底层模块安全引用；
// 修改状态的赛季同步 / 旧存档迁移 / 新闻在 roleSync.ts。
//
// 1. 位置系数 roleFactor(p, slot)：本位置 1 > 副位置 CONFIG.team.altRoleFactor（Player.altPositions）≥ 四五号位互换
//    supportSwapFactor（所有选手：4 号位打 5 号位或反之）> 其他非本位置 offRoleFactor；同时适用时取较高者。
//    player.playerRating 使用它 —— 比赛模拟、BP、自动排阵、AI 补强 / 转会的评分比较都经由 playerRating 一致生效。
// 2. 本职覆盖 playsNaturally / uncoveredPositions：本位置或副位置算「本职」（四五号位互换不算），AI 的位置需求
//    （缺哪个位置、卖谁不会留下空位）按一个选手只能打一个位置的二分匹配计算。
// 3. 真实生涯位置：src/data/trajectories.json 的 pos（游程压缩，scripts/build-trajectories.ts 生成）展开为逐届位置；
//    副位置 = 截至当届（含）真实生涯中担任过的其他位置（按最近担任的届次排序；未来才担任的位置不算，赛季同步时随届次增加）。
//    程序生成选手没有副位置（四五号位互换对所有人适用）。
import { CONFIG, POSITION_CN } from './config';
import { getTrajectory } from '../data/index';
import type { Player, PlayerTrajectory, Position } from './types';
import { POSITIONS } from './types';

/**
 * 真实生涯位置数据版本：读档 / 多人房间载入时低于此版本的存档执行一次迁移（roleSync.migrateRealRoles）。
 * 1 = 真实生涯位置同步 + 副位置；2 = 副位置只算截至当届担任过的位置。
 * 修改已打过的届次的 roster 位置数据（或副位置口径）时递增，让已有存档重新同步。
 */
export const ROLE_DATA_VERSION = 2;

// ---------------------------------------------------------------------------
// 位置系数
// ---------------------------------------------------------------------------

/** 选手打某位置的适配：本位置 / 副位置 / 四五号位互换 / 非本位置 */
export type RoleFit = 'main' | 'alt' | 'swap' | 'off';

export const ROLE_FIT_LABEL: Record<RoleFit, string> = {
  main: '本位置',
  alt: '副位置',
  swap: '四五号位互换',
  off: '非本位置',
};

type RoleHolder = Pick<Player, 'position' | 'altPositions'>;

/** 4 号位与 5 号位互换 */
export function isSupportSwap(main: Position, slot: Position): boolean {
  return (main === 'SS' && slot === 'HS') || (main === 'HS' && slot === 'SS');
}

function hasAlt(p: RoleHolder, slot: Position): boolean {
  const alt = p.altPositions;
  return Array.isArray(alt) && alt.length > 0 && alt.includes(slot);
}

/** 适配类别对应的系数 */
export function roleFitFactor(fit: RoleFit): number {
  const T = CONFIG.team;
  switch (fit) {
    case 'main':
      return 1;
    case 'alt':
      return Math.max(T.offRoleFactor, T.altRoleFactor);
    case 'swap':
      return Math.max(T.offRoleFactor, T.supportSwapFactor);
    default:
      return T.offRoleFactor;
  }
}

/**
 * 位置系数（热路径：playerRating 每次调用一次）：本位置 1；副位置 altRoleFactor；4/5 号位互换 supportSwapFactor；
 * 其余 offRoleFactor；多项适用取较高者。
 */
export function roleFactor(p: RoleHolder, slot: Position): number {
  const main = p.position;
  if (slot === main) return 1;
  const T = CONFIG.team;
  let f: number = T.offRoleFactor;
  if (T.altRoleFactor > f && hasAlt(p, slot)) f = T.altRoleFactor;
  if (T.supportSwapFactor > f && isSupportSwap(main, slot)) f = T.supportSwapFactor;
  return f;
}

/** 选手打某位置的适配类别（与 roleFactor 同口径：副位置与四五号位互换同时适用时取系数较高者，相同时算副位置） */
export function roleFit(p: RoleHolder, slot: Position): RoleFit {
  if (slot === p.position) return 'main';
  const alt = hasAlt(p, slot);
  const swap = isSupportSwap(p.position, slot);
  if (alt && swap) return roleFitFactor('alt') >= roleFitFactor('swap') ? 'alt' : 'swap';
  if (alt) return 'alt';
  if (swap) return 'swap';
  return 'off';
}

/** 「本职」：本位置或副位置（四五号位互换不算本职——AI 仍会为缺失的 5 号位引进真正的 5 号位） */
export function playsNaturally(p: RoleHolder, pos: Position): boolean {
  return p.position === pos || hasAlt(p, pos);
}

/** 本职位置：本位置在前，其后为副位置 */
export function naturalPositions(p: RoleHolder): Position[] {
  const out: Position[] = [p.position];
  if (Array.isArray(p.altPositions)) for (const q of p.altPositions) if (POSITIONS.includes(q) && !out.includes(q)) out.push(q);
  return out;
}

/**
 * 一组选手无法用「本职」覆盖的位置：每名选手只能打一个位置，求本职（本位置 / 副位置）的最大匹配（本位置优先），
 * 返回匹配不到的位置（按 POSITIONS 顺序）。例：两名 4 号位（其中一人副位置 5 号位）→ []；两名纯 4 号位 → ['C','M','O','HS']
 * 中除被覆盖者以外的位置。5 个位置 × 至多十几名选手，开销可忽略。
 */
export function uncoveredPositions(players: readonly RoleHolder[]): Position[] {
  const n = players.length;
  const adj: number[][] = POSITIONS.map((pos) => {
    const main: number[] = [];
    const alt: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = players[i];
      if (p.position === pos) main.push(i);
      else if (hasAlt(p, pos)) alt.push(i);
    }
    return main.concat(alt);
  });
  const posOfPlayer = new Array<number>(n).fill(-1);
  const augment = (k: number, seen: boolean[]): boolean => {
    for (const i of adj[k]) {
      if (seen[i]) continue;
      seen[i] = true;
      if (posOfPlayer[i] < 0 || augment(posOfPlayer[i], seen)) {
        posOfPlayer[i] = k;
        return true;
      }
    }
    return false;
  };
  const out: Position[] = [];
  for (let k = 0; k < POSITIONS.length; k++) if (!augment(k, new Array<boolean>(n).fill(false))) out.push(POSITIONS[k]);
  return out;
}

/** 位置文字：「四号位」或「四号位（可打五号位）」 */
export function positionText(p: RoleHolder): string {
  const alt = naturalPositions(p).slice(1);
  return alt.length ? `${POSITION_CN[p.position]}（可打${alt.map((q) => POSITION_CN[q]).join('、')}）` : POSITION_CN[p.position];
}

/** 选手打某位置的说明（界面提示）：「副位置 ×0.95」等 */
export function roleFitText(p: RoleHolder, slot: Position): string {
  const fit = roleFit(p, slot);
  return fit === 'main' ? ROLE_FIT_LABEL.main : `${ROLE_FIT_LABEL[fit]} ×${roleFitFactor(fit)}`;
}

// ---------------------------------------------------------------------------
// 真实生涯位置（静态数据）
// ---------------------------------------------------------------------------

/** 真实生涯中某一届的位置 */
export interface RoleStep {
  ti: number;
  pos: Position;
}

/** 把轨迹中游程压缩的 pos 展开为逐届位置（按 TI 升序；首届缺 pos 的异常数据跳过到第一个 pos） */
export function parseRoleHistory(raw: PlayerTrajectory | null | undefined): RoleStep[] {
  if (!raw || typeof raw !== 'object') return [];
  const tis = Object.keys(raw)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const out: RoleStep[] = [];
  let cur: Position | null = null;
  for (const ti of tis) {
    const pos = (raw as Record<string, { pos?: unknown } | undefined>)[ti]?.pos;
    if (typeof pos === 'string' && (POSITIONS as string[]).includes(pos)) cur = pos as Position;
    if (cur) out.push({ ti, pos: cur });
  }
  return out;
}

/** 静态数据只读：按选手 id 缓存（null = 无真实位置数据） */
const historyCache = new Map<string, RoleStep[] | null>();

/** 真实选手的逐届真实位置（无数据 / 数据层不可用返回 null） */
export function realRoleHistory(playerId: string): RoleStep[] | null {
  if (historyCache.has(playerId)) return historyCache.get(playerId) ?? null;
  let steps: RoleStep[] | null = null;
  try {
    const parsed = parseRoleHistory(getTrajectory(playerId));
    steps = parsed.length ? parsed : null;
  } catch {
    steps = null; // 数据层不可用（测试替身等）：视为没有真实位置数据
  }
  historyCache.set(playerId, steps);
  return steps;
}

/** 当届（恰有该届数据）的真实位置；没有该届数据返回 null */
export function realRoleExactAt(playerId: string, ti: number): Position | null {
  const steps = realRoleHistory(playerId);
  if (!steps) return null;
  for (const s of steps) if (s.ti === ti) return s.pos;
  return null;
}

/**
 * 某届应有的真实位置：恰有该届数据取当届；否则取此前最近一届；早于真实首届（本局提前出现）取首届。无数据返回 null。
 * 用于赛季中途创建的真实选手与旧存档迁移。
 */
export function realRoleFor(playerId: string, ti: number): Position | null {
  const steps = realRoleHistory(playerId);
  if (!steps) return null;
  let best: Position | null = null;
  for (const s of steps) {
    if (s.ti > ti) break;
    best = s.pos;
  }
  return best ?? steps[0].pos;
}

/**
 * 真实生涯中担任过的位置，按最近担任的届次排序（不重复）。maxTi：只算该届（含）及以前的届次（本局的「当届」；
 * 未来才担任的位置不算）；省略时为整个真实生涯。
 */
export function realRoles(playerId: string, maxTi?: number): Position[] {
  const steps = realRoleHistory(playerId);
  const out: Position[] = [];
  if (!steps) return out;
  const cap = maxTi ?? Infinity;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.ti <= cap && !out.includes(s.pos)) out.push(s.pos);
  }
  return out;
}

/**
 * 副位置：截至 ti（含）真实生涯中担任过、且不是 primary 的位置（按最近担任排序；无则为空数组）。
 * 本局中早于真实首届出现的选手没有副位置。
 */
export function realAltPositions(playerId: string, primary: Position, ti: number): Position[] {
  return realRoles(playerId, ti).filter((q) => q !== primary);
}

/**
 * 真实生涯位置变化（DotaPedia 选手页「真实生涯位置」）：相邻届次（中间没有缺席）的相同位置合并为一段 [起, 止]；
 * 缺席的届次断开（如 TI1–5、TI8 分为两段）。maxTi：只显示该届（含）及以前（不剧透本局尚未到来的届次）。
 */
export function realRoleSpans(playerId: string, maxTi?: number): { from: number; to: number; pos: Position }[] {
  const steps = realRoleHistory(playerId);
  if (!steps) return [];
  const cap = maxTi ?? Infinity;
  const out: { from: number; to: number; pos: Position }[] = [];
  for (const s of steps) {
    if (s.ti > cap) break;
    const last = out[out.length - 1];
    if (last && last.pos === s.pos && s.ti === last.to + 1) last.to = s.ti;
    else out.push({ from: s.ti, to: s.ti, pos: s.pos });
  }
  return out;
}

/** 两个副位置列表是否相同（避免无变化时重写存档字段） */
function sameList(a: readonly Position[] | undefined, b: readonly Position[]): boolean {
  if (!a) return b.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 按真实生涯写入副位置（真实选手：截至 ti 担任过的其他位置；无副位置时删除字段）。不改本位置。返回是否有改动。
 * 程序生成选手：清除异常残留的副位置。
 */
export function refreshAltPositions(p: Player, ti: number): boolean {
  if (!p.isReal) {
    if (p.altPositions === undefined) return false;
    delete p.altPositions;
    return true;
  }
  const alt = realAltPositions(p.id, p.position, ti);
  if (sameList(p.altPositions, alt)) {
    if (p.altPositions && !alt.length) delete p.altPositions;
    return false;
  }
  if (alt.length) p.altPositions = alt;
  else delete p.altPositions;
  return true;
}
