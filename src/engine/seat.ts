// ============================================================================
// 多人对战：座位上下文切换（底层实现，只依赖 types —— 其他引擎模块可安全引用，不受测试替身影响）
// 设计见 docs/MULTIPLAYER.md §5。公共 API 由 multi.ts 统一导出。
//
// GameState 顶层的「玩家私有字段」在执行某位玩家的操作前从 multiplayer.seats[teamId].saved 换入顶层、
// 执行后换出。没有座位换入时（activeSeat = null）顶层为「中性」状态：settings.playerTeamId = ''，
// 私有字段为空白默认值 —— 全局流程（AI、赛事推进……）在中性状态下运行，玩家相关部分显式按座位执行。
// 单机（state.multiplayer 为空）时本模块的函数全部退化为直接执行，行为与改造前完全一致。
// ============================================================================
import type { GameState, NewsItem, PendingDecision, SeatSaved, SeatState, Tournament } from './types';
import { ownEntry } from './util';

type Bag = Record<string, unknown>;

/** 顶层私有字段 → 中性默认值 */
const TOP_DEFAULTS: Record<string, () => unknown> = {
  freeTrainingUsed: () => false,
  extraTrainingAvailable: () => 0,
  extraTrainingBoughtThisRound: () => 0,
  trainingFocus: () => 'balanced',
  gachaPity: () => 0,
  pendingDecisions: () => [],
  activeMatch: () => null,
  finance: () => [],
  popups: () => [],
  tempSubCandidates: () => [],
  beefs: () => [],
};
export const SEAT_TOP_KEYS = Object.keys(TOP_DEFAULTS);

/** history 中的私有字段 */
const HISTORY_DEFAULTS: Record<string, () => unknown> = {
  playerSettlements: () => [],
  honor: () => [],
  gold: () => [],
  seasons: () => [],
  training: () => [],
  squadProgress: () => ({}),
};
export const SEAT_HISTORY_KEYS = Object.keys(HISTORY_DEFAULTS);

/** season 中的私有字段（按赛季：换入时赛季不同则取默认值） */
const SEASON_DEFAULTS: Record<string, () => unknown> = {
  registeredTournamentIds: () => [],
  extraTrainingsBought: () => 0,
  honorStart: () => undefined,
  goldStart: () => undefined,
};
export const SEAT_SEASON_KEYS = Object.keys(SEASON_DEFAULTS);

/** 赛事中的私有字段（playerStatus 缺省 'locked'，其余缺省为空；entryRound = 本座位报名 / 接受邀请所在的回合） */
export const SEAT_TOURNAMENT_KEYS = ['playerStatus', 'expectedRank', 'settlement', 'playerBeefHonor', 'entryRound'] as const;
const TOURNAMENT_STATUS_DEFAULT = 'locked';

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 是否为多人对局 */
export function isMultiplayer(state: GameState): boolean {
  return !!state?.multiplayer;
}

/** 当前换入顶层的座位（单机 = settings.playerTeamId；多人中性状态 = null） */
export function activeSeatId(state: GameState): string | null {
  const mp = state.multiplayer;
  if (!mp) return state.settings?.playerTeamId ?? null;
  return mp.activeSeat ?? null;
}

/** 全部玩家战队 id（单机 = [settings.playerTeamId]；多人 = 全部座位，含已出局） */
export function humanTeamIds(state: GameState): string[] {
  const mp = state.multiplayer;
  if (!mp) {
    const me = state.settings?.playerTeamId;
    return me ? [me] : [];
  }
  return (mp.order ?? Object.keys(mp.seats ?? {})).filter((id) => !!mp.seats?.[id]);
}

/** 某战队是否由人类玩家控制（多人：任一座位，含已出局；单机：settings.playerTeamId） */
export function isHumanTeam(state: GameState, teamId: string | null | undefined): boolean {
  if (!teamId) return false;
  const mp = state.multiplayer;
  if (!mp) return teamId === state.settings?.playerTeamId;
  return !!mp.seats?.[teamId];
}

/** 座位（多人）；单机或非座位返回 null */
export function seatOf(state: GameState, teamId: string | null | undefined): SeatState | null {
  if (!teamId) return null;
  return state.multiplayer?.seats?.[teamId] ?? null;
}

/** 座位是否仍在游戏中（未出局、战队未解散） */
export function seatInPlay(state: GameState, teamId: string): boolean {
  const seat = seatOf(state, teamId);
  if (!seat) return false;
  const team = ownEntry(state.teams, teamId);
  return !seat.eliminated && !!team && !team.disbanded;
}

/**
 * 仍在比赛中的玩家战队：多人 = 未出局且战队未解散的座位（按座位顺序）；
 * 单机 = [settings.playerTeamId]（战队存在时；解散判定沿用各调用方原有逻辑）。
 */
export function activeHumanIds(state: GameState): string[] {
  const mp = state.multiplayer;
  if (!mp) {
    const me = state.settings?.playerTeamId;
    return me && state.teams?.[me] ? [me] : [];
  }
  return humanTeamIds(state).filter((id) => seatInPlay(state, id));
}

// ---------------------------------------------------------------------------
// 换入 / 换出
// ---------------------------------------------------------------------------

/** 读取顶层（当前上下文）的私有字段 */
function detach(state: GameState): SeatSaved {
  const s = state as unknown as Bag;
  const top: Bag = {};
  for (const k of SEAT_TOP_KEYS) top[k] = s[k];
  const h = (state.history ?? {}) as unknown as Bag;
  const history: Bag = {};
  for (const k of SEAT_HISTORY_KEYS) history[k] = h[k];
  const se = (state.season ?? {}) as unknown as Bag;
  const season: SeatSaved['season'] = { ti: state.season?.ti ?? 0 };
  for (const k of SEAT_SEASON_KEYS) if (se[k] !== undefined) (season as Bag)[k] = se[k];
  const tournaments: Record<string, Bag> = {};
  for (const id in state.tournaments ?? {}) {
    const t = state.tournaments[id] as unknown as Bag;
    if (!t) continue;
    const e: Bag = {};
    for (const k of SEAT_TOURNAMENT_KEYS) if (t[k] !== undefined) e[k] = t[k];
    tournaments[id] = e;
  }
  const readNews: string[] = [];
  for (const n of state.news ?? []) if (n?.read) readNews.push(n.id);
  return {
    top,
    history,
    season,
    tournaments,
    settings: { managerName: state.settings?.managerName ?? '' },
    readNews,
  };
}

/** 把 saved 写入顶层（缺失字段取中性默认值），settings.playerTeamId = teamId */
function attach(state: GameState, saved: SeatSaved | undefined, teamId: string): void {
  const s = state as unknown as Bag;
  const top = (saved?.top ?? {}) as Bag;
  for (const k of SEAT_TOP_KEYS) s[k] = top[k] !== undefined ? top[k] : TOP_DEFAULTS[k]();

  if (!state.history) state.history = { tournaments: [], seasons: [], honor: [], gold: [], playerSettlements: [] };
  const h = state.history as unknown as Bag;
  const hist = (saved?.history ?? {}) as Bag;
  for (const k of SEAT_HISTORY_KEYS) h[k] = hist[k] !== undefined ? hist[k] : HISTORY_DEFAULTS[k]();

  if (state.season) {
    const se = state.season as unknown as Bag;
    const sameSeason = !!saved?.season && saved.season.ti === state.season.ti;
    const vals = (sameSeason ? saved!.season : {}) as Bag;
    for (const k of SEAT_SEASON_KEYS) {
      const v = vals[k] !== undefined ? vals[k] : SEASON_DEFAULTS[k]();
      if (v !== undefined) se[k] = v;
      else if (se[k] !== undefined) delete se[k];
    }
  }

  const tours = saved?.tournaments ?? {};
  for (const id in state.tournaments ?? {}) {
    const t = state.tournaments[id] as unknown as Bag;
    if (!t) continue;
    const e = (tours[id] ?? {}) as Bag;
    for (const k of SEAT_TOURNAMENT_KEYS) {
      const v = e[k] !== undefined ? e[k] : k === 'playerStatus' ? TOURNAMENT_STATUS_DEFAULT : undefined;
      if (v !== undefined) t[k] = v;
      else if (t[k] !== undefined) delete t[k];
    }
  }

  if (state.settings) {
    state.settings.playerTeamId = teamId;
    const name = saved?.settings?.managerName;
    state.settings.managerName = typeof name === 'string' ? name : '';
  }

  const read = new Set(saved?.readNews ?? []);
  for (const n of (state.news ?? []) as NewsItem[]) {
    if (!n) continue;
    const r = read.has(n.id);
    if (n.read !== r) n.read = r;
  }
}

/**
 * 在某座位上下文中执行 fn：换入该座位私有字段并设置 settings.playerTeamId，执行后换出并恢复之前的上下文。
 * 可嵌套；异常时也会正确换出（try/finally）。单机模式直接执行 fn。
 */
export function withSeat<T>(state: GameState, teamId: string, fn: () => T): T {
  const mp = state.multiplayer;
  if (!mp) return fn();
  const seat = mp.seats?.[teamId];
  if (!seat) throw new Error(`座位不存在：${teamId}`);
  const prev = mp.activeSeat ?? null;
  if (prev === teamId) return fn();
  const prevSaved = detach(state);
  const prevSeat = prev ? mp.seats[prev] : undefined;
  if (prevSeat) prevSeat.saved = prevSaved;
  attach(state, seat.saved, teamId);
  mp.activeSeat = teamId;
  try {
    return fn();
  } finally {
    seat.saved = detach(state);
    if (prevSeat) attach(state, prevSeat.saved, prev!);
    else attach(state, prevSaved, '');
    mp.activeSeat = prevSeat ? prev : null;
  }
}

/**
 * 若 teamId 是某个（非当前）座位，在其上下文中执行 fn；否则直接执行（单机 / AI 战队 / 已是当前座位）。
 * 用于把写入私有字段的副作用（账目、荣誉曲线、待决事件……）路由到所属座位。
 */
export function inSeatOf<T>(state: GameState, teamId: string | null | undefined, fn: () => T): T {
  const mp = state.multiplayer;
  if (!mp || !teamId || !mp.seats?.[teamId] || mp.activeSeat === teamId) return fn();
  return withSeat(state, teamId, fn);
}

/** 对每个未出局座位依次执行（单机 = 以当前玩家执行一次） */
export function forEachSeat(state: GameState, fn: (teamId: string) => void): void {
  const mp = state.multiplayer;
  if (!mp) {
    fn(state.settings?.playerTeamId ?? '');
    return;
  }
  for (const id of humanTeamIds(state)) {
    if (!seatInPlay(state, id)) continue;
    withSeat(state, id, () => fn(id));
  }
}

/** 回到中性状态（当前换入的座位换出；单机无操作） */
export function ensureNeutral(state: GameState): void {
  const mp = state.multiplayer;
  if (!mp || mp.activeSeat == null) return;
  const seat = mp.seats?.[mp.activeSeat];
  const saved = detach(state);
  if (seat) seat.saved = saved;
  attach(state, {}, '');
  mp.activeSeat = null;
}

/** 当前上下文是否为中性（多人且无座位换入） */
export function isNeutral(state: GameState): boolean {
  return !!state.multiplayer && state.multiplayer.activeSeat == null;
}

// ---------------------------------------------------------------------------
// 不换入即可读写的座位私有数据
// ---------------------------------------------------------------------------

/** 某座位在某赛事上的私有字段（不切换上下文；单机/当前座位直接读赛事对象） */
export function seatTournamentField<K extends (typeof SEAT_TOURNAMENT_KEYS)[number]>(
  state: GameState,
  teamId: string,
  t: Tournament,
  key: K,
): Tournament[K] {
  const mp = state.multiplayer;
  if (!mp || mp.activeSeat === teamId || !mp.seats?.[teamId]) return t[key];
  const e = mp.seats[teamId].saved?.tournaments?.[t.id] as Partial<Tournament> | undefined;
  const v = e?.[key];
  if (v === undefined && key === 'playerStatus') return TOURNAMENT_STATUS_DEFAULT as Tournament[K];
  return v as Tournament[K];
}

/** 全部座位的待决事件（当前上下文 + 其他座位已换出的） */
export function allPendingDecisions(state: GameState): PendingDecision[] {
  const out: PendingDecision[] = [...(state.pendingDecisions ?? [])];
  const mp = state.multiplayer;
  if (!mp) return out;
  for (const id of humanTeamIds(state)) {
    if (id === mp.activeSeat) continue;
    const list = mp.seats[id]?.saved?.top?.pendingDecisions;
    if (Array.isArray(list)) out.push(...(list as PendingDecision[]));
  }
  return out;
}

/** 从全部座位（当前上下文 + 其他座位）移除满足条件的待决事件 */
export function removePendingDecisionsEverywhere(state: GameState, pred: (d: PendingDecision) => boolean): void {
  if (state.pendingDecisions?.length) state.pendingDecisions = state.pendingDecisions.filter((d) => !pred(d));
  const mp = state.multiplayer;
  if (!mp) return;
  for (const id of humanTeamIds(state)) {
    if (id === mp.activeSeat) continue;
    const top = mp.seats[id]?.saved?.top;
    const list = top?.pendingDecisions;
    if (top && Array.isArray(list) && list.length) top.pendingDecisions = (list as PendingDecision[]).filter((d) => !pred(d));
  }
}

/** 全部座位的临时替补候选（当前上下文 + 其他座位已换出的） */
export function allTempSubCandidates(state: GameState): string[] {
  const out: string[] = [...(state.tempSubCandidates ?? [])];
  const mp = state.multiplayer;
  if (!mp) return out;
  for (const id of humanTeamIds(state)) {
    if (id === mp.activeSeat) continue;
    const list = mp.seats[id]?.saved?.top?.tempSubCandidates;
    if (Array.isArray(list)) out.push(...(list as string[]));
  }
  return out;
}
