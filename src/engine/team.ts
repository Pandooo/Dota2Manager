// 战队、阵容、战力【E1 负责实现】
import { CONFIG, POSITION_LABEL } from './config';
import { computeSalary, effectiveAttr, isAvailable, overallRating, playerRating } from './player';
import { rngOf } from './rng';
import { aiLineupPriority } from './lineupPriority';
import { teamMomentumMult } from './momentum';
import { naturalPositions } from './roles';
import { ownEntry } from './util';
import { listingClock, teamSeriesCount } from './listingRules';
import type { Coach, GameState, InMatchEvent, Player, Position, Team } from './types';
import { POSITIONS } from './types';

/** 暴力搜索阵容时的最大候选人数（10 人 → 30240 种排列，可接受） */
const AUTO_LINEUP_MAX_CANDIDATES = 10;

/**
 * 按 id 取战队（只认自有键）：teamId 可能来自网络（多人 RPC）或外部调用，'__proto__' / 'constructor' 等原型链上的键
 * 不能被当成战队——否则写首发（team.lineup = …）会写到 Object.prototype 上。本模块所有接受 teamId 的函数都经由这里取战队。
 */
export function teamOf(state: GameState, teamId: unknown): Team | undefined {
  return ownEntry(state.teams, teamId);
}

export function getPlayerTeam(state: GameState): Team {
  const team = teamOf(state, state.settings.playerTeamId);
  if (!team) throw new Error('找不到玩家战队');
  return team;
}

/** 战队全部 active 选手（不含 banned/retired） */
export function teamPlayers(state: GameState, teamId: string): Player[] {
  const team = teamOf(state, teamId);
  if (!team) return [];
  const out: Player[] = [];
  for (const id of team.playerIds) {
    const p = state.players[id];
    if (p && p.status === 'active') out.push(p);
  }
  return out;
}

/** 首发槽位上的合法选手（存在、active、属于本队），否则 null */
function slotPlayer(state: GameState, team: Team, pos: Position): Player | null {
  const id = team.lineup?.[pos];
  if (!id) return null;
  const p = state.players[id];
  if (!p || p.status !== 'active' || p.teamId !== team.id) return null;
  return p;
}

/** 五个位置的首发（可能为 null） */
export function lineupPlayers(state: GameState, teamId: string): { pos: Position; player: Player | null }[] {
  const team = teamOf(state, teamId);
  return POSITIONS.map((pos) => ({ pos, player: team ? slotPlayer(state, team, pos) : null }));
}

/** 替补（签约但不在首发中的 active 选手） */
export function benchPlayers(state: GameState, teamId: string): Player[] {
  const team = teamOf(state, teamId);
  if (!team) return [];
  const starters = new Set<string>();
  for (const pos of POSITIONS) {
    const id = team.lineup?.[pos];
    if (id) starters.add(id);
  }
  return teamPlayers(state, teamId).filter((p) => !starters.has(p.id));
}

/** 选手能否为某赛事出场（可用且非其他赛事的临时替补） */
function canPlayFor(p: Player, tournamentId?: string | null): boolean {
  if (!isAvailable(p, tournamentId)) return false;
  if (tournamentId && p.tempSubUntilTournament && p.tempSubUntilTournament !== tournamentId) return false;
  return true;
}

/**
 * 自动排首发：使首发 playerRating 之和最大——位置系数（roles.roleFactor）本位置 1 > 副位置 / 四五号位互换 > 其他非本位置，
 * 因此优先本位置评分最高者，其次副位置 / 四五号位互换，最后才用其他位置的选手填补空位（例：4 名四号位、没有五号位时，
 * 副位置是五号位或评分最高的四号位打五号位，阵容完整）。
 * tournamentId 给出时排除无法参加该赛事的选手。
 * AI 战队先按首发优先级（lineupPriority.aiLineupPriority：使命选手 → 巅峰选手）把优先选手排在各自的本位置
 * （同一位置先比优先级、再比综合评分，落选者回到候选中按评分竞争其余位置），其余位置再按评分排；人类玩家战队只按评分。
 * 实现：在候选（≤10 人）上对剩余位置做带剪枝的全排列搜索，使首发 playerRating 之和最大（有可出场的选手时不留空位）。
 */
export function autoLineup(state: GameState, teamId: string, tournamentId?: string | null): void {
  const team = teamOf(state, teamId);
  if (!team) return;
  if (!team.lineup) team.lineup = { C: null, M: null, O: null, SS: null, HS: null };

  let cands = teamPlayers(state, teamId).filter((p) => canPlayFor(p, tournamentId));
  // 稳定排序：综合评分降序，同分按 id，保证结果确定
  cands.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // AI 首发优先级：优先选手（已按评分降序）按优先级稳定排序后依次占据本位置
  const fixed = new Map<Position, Player>();
  const prio = aiLineupPriority(state, teamId);
  if (prio) {
    const ranked = cands.filter((p) => prio.has(p.id)).sort((a, b) => prio.get(a.id)! - prio.get(b.id)!);
    for (const p of ranked) if (POSITIONS.includes(p.position) && !fixed.has(p.position)) fixed.set(p.position, p);
    if (fixed.size) {
      const taken = new Set([...fixed.values()].map((p) => p.id));
      cands = cands.filter((p) => !taken.has(p.id));
    }
  }
  const open = fixed.size ? POSITIONS.filter((pos) => !fixed.has(pos)) : POSITIONS;

  if (cands.length > AUTO_LINEUP_MAX_CANDIDATES) {
    // 剪枝：每个（待排）位置评分前 2 + 综合前若干
    const keep = new Set<Player>();
    for (const pos of open) {
      cands
        .slice()
        .sort((a, b) => playerRating(b, pos) - playerRating(a, pos))
        .slice(0, 2)
        .forEach((p) => keep.add(p));
    }
    for (const p of cands) {
      if (keep.size >= AUTO_LINEUP_MAX_CANDIDATES) break;
      keep.add(p);
    }
    cands = cands.filter((p) => keep.has(p));
  }

  const n = cands.length;
  const slots = open.length;
  // r[s][i]：候选 i 打待排位置 s 的评分
  const r: number[][] = open.map((pos) => cands.map((p) => playerRating(p, pos)));
  const slotMax = r.map((row) => (row.length ? Math.max(...row) : 0));
  // suffixMax[s] = Σ_{s' ≥ s} slotMax[s']（上界剪枝）
  const suffixMax = new Array<number>(slots + 1).fill(0);
  for (let s = slots - 1; s >= 0; s--) suffixMax[s] = suffixMax[s + 1] + slotMax[s];

  const maxEmpty = Math.max(0, slots - n);
  const assign = new Array<number>(slots).fill(-1);
  const used = new Array<boolean>(n).fill(false);
  let best = -Infinity;
  let bestAssign = assign.slice();

  const dfs = (s: number, total: number, empties: number): void => {
    if (s === slots) {
      if (total > best + 1e-9) {
        best = total;
        bestAssign = assign.slice();
      }
      return;
    }
    if (total + suffixMax[s] <= best + 1e-9) return;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      assign[s] = i;
      dfs(s + 1, total + r[s][i], empties);
      used[i] = false;
    }
    if (empties < maxEmpty) {
      assign[s] = -1;
      dfs(s + 1, total, empties + 1);
    }
  };
  dfs(0, 0, 0);

  for (const [pos, p] of fixed) team.lineup[pos] = p.id;
  open.forEach((pos, s) => {
    const i = bestAssign[s];
    team.lineup[pos] = i >= 0 && i < n ? cands[i].id : null;
  });
}

/** 校验阵容，返回中文错误列表（空数组 = 合法）。tournamentId 给出时检查签证/禁赛等不可用 */
export function validateLineup(state: GameState, teamId: string, tournamentId?: string | null): string[] {
  const team = teamOf(state, teamId);
  if (!team) return ['战队不存在'];
  const errors: string[] = [];
  const seen = new Map<string, Position>();
  for (const pos of POSITIONS) {
    const id = team.lineup?.[pos];
    const label = POSITION_LABEL[pos];
    if (!id) {
      errors.push(`${label}空缺`);
      continue;
    }
    const p = state.players[id];
    if (!p) {
      errors.push(`${label}的选手不存在`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${p.handle} 被同时安排在${POSITION_LABEL[seen.get(id)!]}和${label}`);
      continue;
    }
    seen.set(id, pos);
    if (p.teamId !== teamId || !team.playerIds.includes(id)) {
      errors.push(`${p.handle} 不是本队选手`);
      continue;
    }
    if (p.status === 'banned') {
      errors.push(`${p.handle} 已被禁赛，无法上场`);
      continue;
    }
    if (p.status === 'retired') {
      errors.push(`${p.handle} 已退役`);
      continue;
    }
    if (tournamentId) {
      if (!isAvailable(p, tournamentId)) {
        errors.push(`${p.handle} 无法参加本项赛事（签证/伤病）`);
        continue;
      }
      if (p.tempSubUntilTournament && p.tempSubUntilTournament !== tournamentId) {
        errors.push(`${p.handle} 是其他赛事的临时替补，不能参加本项赛事`);
      }
    }
  }
  return errors;
}

/** 设置某位置首发；若该选手已在其他位置，则与该位置原选手互换 */
export function setLineupSlot(state: GameState, teamId: string, pos: Position, playerId: string | null): void {
  const team = teamOf(state, teamId);
  // 位置只接受五个首发位（参数可能来自网络 / 外部调用：'__proto__' 等键不能写进首发对象）
  if (!team || !(POSITIONS as readonly unknown[]).includes(pos)) return;
  if (!team.lineup) team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
  if (playerId === null) {
    team.lineup[pos] = null;
    return;
  }
  const p = ownEntry(state.players, playerId);
  if (!p || p.teamId !== teamId || !team.playerIds.includes(playerId)) return;
  const prev = team.lineup[pos];
  const otherPos = POSITIONS.find((q) => q !== pos && team.lineup[q] === playerId);
  team.lineup[pos] = playerId;
  if (otherPos) team.lineup[otherPos] = prev && prev !== playerId ? prev : null;
}

/** 教练评分加成 */
function coachRatingBonus(coach: Coach | null): number {
  if (!coach) return 0;
  const insight = Number.isFinite(coach.insight) ? coach.insight : 0;
  return Math.max(0, insight) * CONFIG.coach.ratingBonusPerInsight;
}

/**
 * 战队评分 = Σ 首发 playerRating(位置) × 局内事件倍数 × 荣誉势头乘子（momentum.teamMomentumMult，≈ 1 ± 2%）
 * + 教练加成（insight × CONFIG.coach.ratingBonusPerInsight）。首发空缺按 0 计（并在 UI 警示）。
 */
export function teamRating(state: GameState, teamId: string, incidents?: InMatchEvent[]): number {
  const team = teamOf(state, teamId);
  if (!team) return 0;
  let incidentMult: Map<string, number> | null = null;
  if (incidents && incidents.length > 0) {
    incidentMult = new Map();
    for (const ev of incidents) {
      if (!ev || !ev.playerId || !Number.isFinite(ev.powerMult)) continue;
      incidentMult.set(ev.playerId, (incidentMult.get(ev.playerId) ?? 1) * ev.powerMult);
    }
  }
  let total = 0;
  for (const pos of POSITIONS) {
    const p = slotPlayer(state, team, pos);
    if (!p) continue;
    let r = playerRating(p, pos);
    if (incidentMult) r *= Math.max(0, incidentMult.get(p.id) ?? 1);
    total += r;
  }
  return total * teamMomentumMult(team) + coachRatingBonus(getCoach(state, teamId));
}

/** 战队灵性 = 首发 insight 均值 × (1-w) + 教练 insight × w（无教练时只用首发） */
export function teamInsight(state: GameState, teamId: string): number {
  const team = teamOf(state, teamId);
  if (!team) return 0;
  let sumIns = 0;
  let n = 0;
  for (const pos of POSITIONS) {
    const p = slotPlayer(state, team, pos);
    if (!p) continue;
    sumIns += effectiveAttr(p, 'insight'); // 灵性也可能受修正器影响
    n++;
  }
  const coach = getCoach(state, teamId);
  const avgIns = n > 0 ? sumIns / n : 0;
  if (!coach) return avgIns;
  const w = CONFIG.coach.insightWeightInDraft;
  if (n === 0) return coach.insight;
  return avgIns * (1 - w) + coach.insight * w;
}

/**
 * 签入选手：设置 teamId/joinedSeason/salary/contractUntil，加入 playerIds；若首发有空位且本位置空则自动补位。
 * 非 active（禁赛/退役）选手、已解散战队一律忽略，保证战队名单只引用 active 选手。
 */
export function addPlayerToTeam(
  state: GameState,
  playerId: string,
  teamId: string,
  opts?: { salary?: number; contractSeasons?: number },
): void {
  const p = ownEntry(state.players, playerId);
  const team = teamOf(state, teamId);
  if (!p || !team || team.disbanded || p.status !== 'active') return;
  // 转入前从原队（含数据不一致时残留的其他战队名单/首发）移除，保证选手只属于一支战队
  if (p.teamId !== teamId) removePlayerFromTeam(state, playerId);

  const ti = state.season?.ti ?? state.settings.startTi;
  // 挂牌门槛的两个起点（listingRules.teamMatchesSinceJoin / transferRoundsSinceJoin）：任何途径换队都从 0 开始计——
  // 加盟时战队的累计系列赛场数与转会回合时钟。只有人类战队用得到（挂牌 / AI 求购人类选手），AI 战队的选手不记，省存档
  if (p.teamId !== teamId) {
    // 入场的公平窗口（v0.4.3，marketEntry.ts）只对自由选手有意义：加盟任何战队即清除
    delete p.marketEntry;
    if (team.isPlayer) {
      p.joinedTeamSeries = teamSeriesCount(team);
      p.joinedTeamClock = listingClock(state);
    } else {
      delete p.joinedTeamSeries;
      delete p.joinedTeamClock;
    }
  }
  p.teamId = teamId;
  p.joinedSeason = ti;
  p.benchRounds = 0;
  p.salary = opts?.salary !== undefined && Number.isFinite(opts.salary)
    ? Math.max(0, Math.round(opts.salary))
    : computeSalary(state, p, p.isRookie === true);

  let seasons = opts?.contractSeasons;
  if (seasons === undefined || !Number.isFinite(seasons)) {
    const [lo, hi] = CONFIG.economy.contractSeasons;
    seasons = rngOf(state).int(lo, hi);
  }
  // 合同含当前赛季：1 个赛季 = 本届 TI 后到期；临时替补只签到本赛季
  seasons = p.tempSubUntilTournament ? 1 : Math.max(1, Math.round(seasons));
  p.contractUntil = ti + seasons - 1;

  if (!team.playerIds.includes(playerId)) team.playerIds.push(playerId);
  if (!team.lineup) team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
  if (p.status === 'active' && !POSITIONS.some((q) => team.lineup[q] === playerId)) {
    const tid = p.tempSubUntilTournament;
    if (!tid) {
      // 本位置空着优先补本位置，否则补空着的副位置（第十三波，roles.naturalPositions）
      const hole = naturalPositions(p).find((q) => !slotPlayer(state, team, q));
      if (hole) team.lineup[hole] = playerId;
    } else {
      // 临时替补：顶替本位置 / 副位置（优先）或任意一个「空缺 / 无法参加该赛事」的首发位
      const natural = naturalPositions(p);
      const order: Position[] = [...natural, ...POSITIONS.filter((q) => !natural.includes(q))];
      const hole = order.find((q) => {
        const occ = slotPlayer(state, team, q);
        return !occ || !canPlayFor(occ, tid);
      });
      if (hole) team.lineup[hole] = playerId;
    }
  }
}

/**
 * 开局阵容（新游戏 / 多人开局在第一个赛季开始之前调用）：清除建队时 addPlayerToTeam 记下的挂牌门槛起点（随队场数 / 转会回合时钟），
 * 开局时已在队的选手与旧存档中已在队的选手一样不受挂牌门槛限制（CONFIG.squadOps.listingMinTeamMatches / listingMinTransferRounds）。
 */
export function clearFoundingJoinMarks(state: GameState): void {
  for (const id in state.players) {
    const p = state.players[id];
    if (!p) continue;
    if (p.joinedTeamSeries !== undefined) delete p.joinedTeamSeries;
    if (p.joinedTeamClock !== undefined) delete p.joinedTeamClock;
  }
}

/** 移出选手：teamId=null，从 playerIds 与 lineup 中移除（不改变 status） */
export function removePlayerFromTeam(state: GameState, playerId: string): void {
  const p = ownEntry(state.players, playerId);
  const strip = (team: Team) => {
    const idx = team.playerIds.indexOf(playerId);
    if (idx >= 0) team.playerIds.splice(idx, 1);
    if (team.lineup) {
      for (const pos of POSITIONS) if (team.lineup[pos] === playerId) team.lineup[pos] = null;
    }
  };
  // 扫描全部战队（≈30 队 × ≤9 人，开销可忽略）：即使 player.teamId 与名单不一致也不会留下悬空引用
  for (const id in state.teams) {
    const t = state.teams[id];
    if (t.playerIds.includes(playerId) || (t.lineup && POSITIONS.some((q) => t.lineup[q] === playerId))) strip(t);
  }
  if (p) {
    if (p.teamId) p.lastTeamId = p.teamId;
    p.teamId = null;
    p.benchRounds = 0;
    delete p.joinedTeamSeries;
    delete p.joinedTeamClock;
  }
}

/** 正式阵容人数（active 且非临时替补） */
export function rosterSize(state: GameState, teamId: string): number {
  let count = 0;
  for (const p of teamPlayers(state, teamId)) if (!p.tempSubUntilTournament) count++;
  return count;
}

/**
 * 距常规阵容上限（软上限 team.maxRoster）的剩余名额，临时替补不计；可为负（超出常规上限）。
 * 只是提示：人类玩家战队超出常规上限仍可签约 / 求购 / 选秀，也不阻塞推进（见 rosterSigningBlock / rosterOverflowNotice）。
 */
export function rosterRoom(state: GameState, teamId: string): number {
  const team = teamOf(state, teamId);
  if (!team) return 0;
  return CONFIG.team.maxRoster - rosterSize(state, teamId);
}

/** 距绝对上限（team.hardMaxRoster）的剩余名额（临时替补不计） */
export function rosterHardRoom(state: GameState, teamId: string): number {
  const team = teamOf(state, teamId);
  if (!team) return 0;
  return CONFIG.team.hardMaxRoster - rosterSize(state, teamId);
}

/**
 * 超出绝对上限（team.hardMaxRoster）的人数（临时替补不计；未超出为 0）。
 * 2026-10-15 用户决策「十连后本回合内退回到 12 人」：人类玩家的十连 / 单抽总是抽满，可以让正式阵容超过绝对上限；
 * 超编期间不能进入下一回合（game.getAdvanceBlockers 的 roster_over_cap），须在本回合内放弃本回合抽到的新秀（gacha.gachaDiscard）
 * 或解约 / 出售其他队员退回上限（挂牌不算，成交离队后才算）。AI 战队不会超编（按 ai.maxRoster 整理阵容）。
 */
export function rosterOverCap(state: GameState, teamId: string): number {
  if (!teamOf(state, teamId)) return 0;
  return Math.max(0, rosterSize(state, teamId) - CONFIG.team.hardMaxRoster);
}

/** 超编时的待处理说明（总览 / 新秀抽卡页 / 推进阻塞共用）；未超编返回 null */
export function rosterOverCapNotice(state: GameState, teamId: string): string | null {
  const over = rosterOverCap(state, teamId);
  if (over <= 0) return null;
  return `超编 ${over} 人：本回合内放弃新秀或解约 ${over} 人（降到 ${CONFIG.team.hardMaxRoster} 人以内）后才能进入下一回合`;
}

/** 人类玩家签约自由选手 / 求购选手时，阵容人数造成的阻止原因：只有达到绝对上限才阻止（null = 可以引进） */
export function rosterSigningBlock(state: GameState, teamId: string): string | null {
  if (!teamOf(state, teamId)) return '战队不存在';
  if (rosterHardRoom(state, teamId) > 0) return null;
  return `阵容已达绝对上限（${CONFIG.team.hardMaxRoster} 人），请先解约或出售选手`;
}

/** 阵容超出常规上限时的提示（不阻塞任何操作）；未超出返回 null */
export function rosterOverflowNotice(state: GameState, teamId: string): string | null {
  const n = rosterSize(state, teamId);
  if (n <= CONFIG.team.maxRoster) return null;
  return `阵容 ${n}/${CONFIG.team.maxRoster}：超出常规上限，替补归属感下降更快、工资照付`;
}

/** 再引进 1 人后将超出常规上限时的提示（签约 / 报价前展示）；不会超出、或已达绝对上限时返回 null */
export function rosterSigningNote(state: GameState, teamId: string): string | null {
  if (!teamOf(state, teamId) || rosterSigningBlock(state, teamId)) return null;
  const after = rosterSize(state, teamId) + 1;
  if (after <= CONFIG.team.maxRoster) return null;
  return `签下后阵容 ${after}/${CONFIG.team.maxRoster}，超出常规上限：替补归属感下降更快、工资照付（绝对上限 ${CONFIG.team.hardMaxRoster} 人）`;
}

/** 按 teamRating 降序排列的战队 id（默认全部未解散战队） */
export function rankTeamsByRating(state: GameState, teamIds?: string[]): string[] {
  const ids = teamIds ?? activeTeams(state).map((t) => t.id);
  const scored = ids.map((id) => ({ id, r: teamRating(state, id) }));
  scored.sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.map((s) => s.id);
}

export function getCoach(state: GameState, teamId: string): Coach | null {
  const team = teamOf(state, teamId);
  if (!team || !team.coachId) return null;
  return state.coaches[team.coachId] ?? null;
}

/** 当前未解散的全部战队 */
export function activeTeams(state: GameState): Team[] {
  return Object.values(state.teams).filter((t) => !t.disbanded);
}
