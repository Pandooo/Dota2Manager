// AI 战队首发优先级（用户决策 2026-10-10：「首发优先使命选手和巅峰选手，然后再基于评分安排」）
//
// team.autoLineup 对 AI 战队先按优先级把选手排在各自的本位置，再对剩余位置按评分（全排列搜索）排首发：
//   1. 使命选手：本俱乐部现实巅峰阵容（俱乐部使命，missions.ts / clubIndex.json 的 peak）中目前在队的成员；
//      与 missions.missionOf 同口径（使命开关、非人类战队、真实组织有巅峰阵容），使命完成后仍然优先（他们仍是这家俱乐部的巅峰阵容）；
//   2. 巅峰选手：历届巅峰阵容（src/data/synergies.json：TI 冠军首发五人 + 标志性阵容）的成员，且该届真实 TI 已经打完
//      （与羁绊觉醒同口径 synergy.synergyAvailable：开局不会因为「未来的冠军」而让低评分新人首发）。
// 人类玩家战队不使用优先级（自动排阵仍只按评分，首发由经理决定）。
// AI 转会补强与之配套（lineupPriorityLocks）：被优先选手占据的本位置不再按评分引进 / 替换（引进的人只会坐替补、白花转会费与工资）。
// 只读查询，不修改状态、不消耗随机数；每次调用只做几次 Map 查找（autoLineup 调用频繁）。
import { CONFIG } from './config';
import { realOrgOf } from './clubIndex';
import { overallRating } from './player';
import { synergiesOfPlayer, synergyAvailable } from './synergy';
import { isHumanTeam } from './seat';
import type { GameState, Player, Position } from './types';

/** 优先级：1 = 使命选手，2 = 巅峰选手（数字越小越优先） */
export type LineupPriority = 1 | 2;

/** 是否为「巅峰选手」：属于某个已经打完的真实届次的巅峰阵容（羁绊阵容） */
export function isPeakRosterPlayer(state: GameState, playerId: string): boolean {
  for (const def of synergiesOfPlayer(playerId)) if (synergyAvailable(state, def)) return true;
  return false;
}

/**
 * AI 战队的首发优先级：在队正式队员 id → 1（使命选手）/ 2（巅峰选手）（赛事临时替补 / 野外替补不享有优先级）。
 * 人类玩家战队、已解散、开关关闭或队中没有优先选手时返回 null（autoLineup 直接按评分排阵）。
 */
export function aiLineupPriority(state: GameState, teamId: string): Map<string, LineupPriority> | null {
  const c = CONFIG.team.aiLineupPriority;
  if (!c || (!c.mission && !c.peak)) return null;
  const team = state.teams[teamId];
  if (!team || team.disbanded || team.isPlayer || isHumanTeam(state, teamId)) return null;
  const ids = team.playerIds ?? [];
  if (!ids.length) return null;
  // 只看正式队员（与使命进度同口径：赛事临时替补 / 野外替补不算）
  const regular = (id: string): boolean => {
    const p = state.players[id];
    return !!p && !p.tempSubUntilTournament && !p.isWildSub;
  };
  let out: Map<string, LineupPriority> | null = null;
  if (c.mission && CONFIG.missions?.enabled) {
    const peak = realOrgOf(state, teamId)?.peak?.players;
    if (peak) {
      for (const id of peak) {
        if (ids.includes(id) && regular(id)) (out ??= new Map()).set(id, 1);
      }
    }
  }
  if (c.peak) {
    for (const id of ids) {
      if (out?.has(id) || !regular(id)) continue;
      if (isPeakRosterPlayer(state, id)) (out ??= new Map()).set(id, 2);
    }
  }
  return out;
}

/** 选手若效力该 AI 战队可享有的首发优先级（引援判断用，不要求已在队；调用方已确认该队适用优先级） */
function candidatePriority(state: GameState, teamId: string, playerId: string): LineupPriority | null {
  const c = CONFIG.team.aiLineupPriority;
  if (c?.mission && CONFIG.missions?.enabled && realOrgOf(state, teamId)?.peak?.players.includes(playerId)) return 1;
  if (c?.peak && isPeakRosterPlayer(state, playerId)) return 2;
  return null;
}

/**
 * AI 转会补强 / 换人用：pos 位置的首发 starter 是否被首发优先级「锁定」——他是优先选手且打本位置，autoLineup 会继续让他首发，
 * 按评分引进的同位置选手只会坐替补（白花转会费与工资）。给出 candidate 时，候选人自身优先级更高、或同级且综合评分更高
 * （且同位置，autoLineup 会让他顶替）时不算锁定。人类玩家战队 / 优先级关闭 / CONFIG.team.aiLineupPriority.lockTransfers 关闭时总是 false。
 * prio 可传入已算好的 aiLineupPriority(state, teamId)（同一战队多次判断时省去重复计算）。
 */
export function lineupPriorityLocks(
  state: GameState,
  teamId: string,
  starter: Player | null | undefined,
  pos: Position,
  candidate?: Player | null,
  prio?: Map<string, LineupPriority> | null,
): boolean {
  if (!starter || starter.position !== pos || CONFIG.team.aiLineupPriority?.lockTransfers === false) return false;
  const map = prio === undefined ? aiLineupPriority(state, teamId) : prio;
  const sp = map?.get(starter.id);
  if (!sp) return false;
  if (candidate && candidate.id !== starter.id && candidate.position === pos) {
    const cp = candidatePriority(state, teamId, candidate.id);
    if (cp !== null && (cp < sp || (cp === sp && overallRating(candidate) > overallRating(starter)))) return false;
  }
  return true;
}
