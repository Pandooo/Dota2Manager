// 训练记录与成长快照：玩家战队每次训练（免费/额外/训练赛/回合末自动）写入 history.training，
// 每回合结束为玩家战队选手记录属性快照（history.squadProgress），供训练页做进度分析。
// 纯函数 + 原地修改 state；不使用随机数，不影响模拟结果。
import type {
  GameState, SquadProgressPoint, TrainingFocus, TrainingGain, TrainingRecord, TrainingRecordKind,
} from './types';
import { CONFIG } from './config';
import { extraTrainingCostAt } from './economy';
import { teamPlayers } from './team';

const FOCUSES: TrainingFocus[] = ['power', 'mmr', 'insight', 'balanced'];
const KINDS: TrainingRecordKind[] = ['free', 'extra', 'scrim', 'auto'];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(num(v) * f) / f;
};

// ---------------------------------------------------------------------------
// 训练记录
// ---------------------------------------------------------------------------

/** recordTraining 的入参：赛季/回合/日期缺省时取当前状态 */
export type TrainingRecordInput = Omit<TrainingRecord, 'season' | 'round' | 'date'> &
  Partial<Pick<TrainingRecord, 'season' | 'round' | 'date'>>;

/** 训练收益存档精度（控制存档体积）：战力/灵性 3 位小数，天赋/韧性 2 位，天梯取整 */
function compactGain(g: TrainingGain): TrainingGain {
  return {
    playerId: g.playerId,
    handle: g.handle,
    power: round(g.power, 3),
    mmr: Math.round(num(g.mmr)),
    insight: round(g.insight, 3),
    talent: round(g.talent, 2),
    resilience: round(g.resilience, 2),
  };
}

/** 全部训练记录（按时间；旧存档为空数组）。给出 season 时只返回该赛季 */
export function trainingRecords(state: GameState, season?: number): TrainingRecord[] {
  const raw = state.history?.training;
  const list = Array.isArray(raw) ? raw : [];
  return season === undefined ? list : list.filter((r) => r?.season === season);
}

/** 追加一条训练记录（超过 CONFIG.training.logMaxRecords 时丢弃最旧的），返回写入的记录 */
export function recordTraining(state: GameState, rec: TrainingRecordInput): TrainingRecord {
  const cost = Math.max(0, Math.round(num(rec.cost)));
  const out: TrainingRecord = {
    season: rec.season ?? state.season?.ti ?? 0,
    round: rec.round ?? state.roundIndex ?? 0,
    date: rec.date ?? state.currentDate ?? '',
    kind: KINDS.includes(rec.kind) ? rec.kind : 'free',
    focus: FOCUSES.includes(rec.focus) ? rec.focus : 'balanced',
    mult: num(rec.mult) > 0 ? round(rec.mult, 3) : 1,
    cost,
    gains: (rec.gains ?? []).map(compactGain),
  };
  if (rec.scrimTargetId) out.scrimTargetId = rec.scrimTargetId;
  if (rec.scrimWon !== undefined) out.scrimWon = !!rec.scrimWon;
  if (num(rec.insightMult) > 0 && rec.insightMult !== 1) out.insightMult = round(rec.insightMult as number, 3);
  if (rec.session) out.session = rec.session;
  if (rec.sessionCost !== undefined) out.sessionCost = Math.min(cost, Math.max(0, Math.round(num(rec.sessionCost))));

  state.history ??= { tournaments: [], seasons: [], honor: [], gold: [], playerSettlements: [] };
  if (!Array.isArray(state.history.training)) state.history.training = [];
  const list = state.history.training;
  list.push(out);
  const max = Math.max(1, CONFIG.training.logMaxRecords);
  if (list.length > max) list.splice(0, list.length - max);
  return out;
}

/** 下一次消耗训练次数时用的是免费还是已购额外次数（与 game.consumeSession 的顺序一致）；无可用次数返回 null */
export function nextTrainingSession(state: GameState): 'free' | 'extra' | null {
  if (!state.freeTrainingUsed && CONFIG.training.freePerRestRound > 0) return 'free';
  if ((state.extraTrainingAvailable ?? 0) > 0) return 'extra';
  return null;
}

/**
 * 即将消耗的一次已购额外训练的购买价（须在扣减 extraTrainingAvailable 之前调用）。
 * 按先买先用：本回合第 k 次使用对应本回合第 k 次购买，其价格由 economy.extraTrainingCostAt 按当时的本回合 / 本赛季购买序号复算。
 */
export function pendingExtraSessionCost(state: GameState): number {
  const bought = Math.max(0, state.extraTrainingBoughtThisRound ?? 0);
  const avail = Math.max(0, state.extraTrainingAvailable ?? 0);
  if (bought <= 0 || avail <= 0) return 0;
  const used = Math.max(0, bought - avail);
  if (used >= bought) return 0;
  const seasonBought = Math.max(0, state.season?.extraTrainingsBought ?? 0);
  const n = Math.max(0, seasonBought - bought + used);
  return extraTrainingCostAt(state, used, n);
}

// ---------------------------------------------------------------------------
// 训练赛预约（每支对手每回合最多约练 CONFIG.training.scrimPerOpponentPerRound 次）
// ---------------------------------------------------------------------------

/** 回合键：赛季 × 100 + 回合（与 squadOps.squadRoundKey / prizeShare 一致） */
function scrimRoundKey(state: GameState): number {
  return num(state.season?.ti) * 100 + Math.max(0, Math.floor(num(state.roundIndex)));
}

/** 每支对手每回合的约练上限（非法配置按 1） */
function scrimLimit(): number {
  const v = CONFIG.training.scrimPerOpponentPerRound;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/**
 * 某战队本回合已约练过的对手 id（按约练顺序，可能重复计次；缺省 = 当前座位 / 单机玩家战队）。
 * Team.scrimBookings 的回合键与当前回合不符（上回合的旧记录）时视为空。
 */
export function scrimBookedIds(state: GameState, teamId?: string): string[] {
  const id = teamId ?? state.settings?.playerTeamId;
  const b = id ? state.teams?.[id]?.scrimBookings : undefined;
  if (!b || b.key !== scrimRoundKey(state) || !Array.isArray(b.teamIds)) return [];
  return b.teamIds.filter((x): x is string => typeof x === 'string');
}

/** 本回合是否已不能再约该对手（已约满 scrimPerOpponentPerRound 次） */
export function isScrimBooked(state: GameState, targetTeamId: string, teamId?: string): boolean {
  let n = 0;
  for (const x of scrimBookedIds(state, teamId)) if (x === targetTeamId) n++;
  return n >= scrimLimit();
}

/** 记下一次约练（旧回合的记录先清空）。不消耗随机数 */
export function bookScrim(state: GameState, targetTeamId: string, teamId?: string): void {
  const id = teamId ?? state.settings?.playerTeamId;
  const team = id ? state.teams?.[id] : undefined;
  if (!team) return;
  const key = scrimRoundKey(state);
  const ids = scrimBookedIds(state, id);
  team.scrimBookings = { key, teamIds: [...ids, targetTeamId] };
}

/** 回合结束时清除全部战队的训练赛预约（game.advanceRound，单机 / 多人共用；不消耗随机数） */
export function clearScrimBookings(state: GameState): void {
  for (const id in state.teams ?? {}) {
    const t = state.teams[id];
    if (t && t.scrimBookings !== undefined) delete t.scrimBookings;
  }
}

// ---------------------------------------------------------------------------
// 成长快照
// ---------------------------------------------------------------------------

const pointKey = (p: { season: number; round: number }) => p.season * 1000 + p.round;

/** 选手的成长快照（按时间；无记录为空数组） */
export function squadProgressOf(state: GameState, playerId: string): SquadProgressPoint[] {
  const arr = state.history?.squadProgress?.[playerId];
  return Array.isArray(arr) ? arr : [];
}

/**
 * 记录玩家战队全部正式选手（不含临时/野外替补）当前属性快照；同一 (赛季, 回合) 只保留最后一次。
 * 每名选手最多 CONFIG.training.progressMaxPointsPerPlayer 个点；选手总数超过 progressMaxPlayers 时，
 * 优先删除已离队且最久未更新的选手。
 */
export function snapshotSquad(state: GameState): void {
  const teamId = state.settings?.playerTeamId;
  const team = teamId ? state.teams?.[teamId] : undefined;
  if (!team || !state.history) return;
  const h = state.history;
  if (!h.squadProgress || typeof h.squadProgress !== 'object' || Array.isArray(h.squadProgress)) h.squadProgress = {};
  const prog = h.squadProgress;
  const season = state.season?.ti ?? 0;
  const roundIdx = state.roundIndex ?? 0;
  const maxPts = Math.max(1, CONFIG.training.progressMaxPointsPerPlayer);

  for (const p of teamPlayers(state, team.id)) {
    if (p.isWildSub || p.tempSubUntilTournament) continue;
    const pt: SquadProgressPoint = {
      season,
      round: roundIdx,
      power: round(p.power, 2),
      mmr: Math.round(num(p.mmr)),
      insight: round(p.insight, 2),
      talent: round(p.talent, 2),
      resilience: round(p.resilience, 2),
      loyalty: round(p.loyalty, 1),
    };
    if (!Array.isArray(prog[p.id])) prog[p.id] = [];
    const arr = prog[p.id];
    const last = arr[arr.length - 1];
    if (last && last.season === season && last.round === roundIdx) arr[arr.length - 1] = pt;
    else arr.push(pt);
    if (arr.length > maxPts) arr.splice(0, arr.length - maxPts);
  }

  const maxPlayers = Math.max(1, CONFIG.training.progressMaxPlayers);
  const ids = Object.keys(prog);
  if (ids.length <= maxPlayers) return;
  const current = new Set(team.playerIds);
  const lastKey = (id: string) => {
    const arr = prog[id];
    return Array.isArray(arr) && arr.length ? pointKey(arr[arr.length - 1]) : -1;
  };
  const removable = ids.filter((id) => !current.has(id)).sort((a, b) => lastKey(a) - lastKey(b) || a.localeCompare(b));
  let count = ids.length;
  for (const id of removable) {
    if (count <= maxPlayers) break;
    delete prog[id];
    count--;
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export interface TrainingGainTotals {
  power: number;
  mmr: number;
  insight: number;
  talent: number;
  resilience: number;
}

export interface PlayerTrainingTotals extends TrainingGainTotals {
  playerId: string;
  handle: string;
  /** 参与的训练次数 */
  sessions: number;
}

export interface FocusTrainingStats {
  sessions: number;
  /** 平均收益倍数（训练赛 > 1） */
  avgMult: number;
  /** 每次训练的全队合计收益（平均） */
  avg: TrainingGainTotals;
  /** 每次训练每名队员的收益（平均） */
  avgPerPlayer: TrainingGainTotals;
}

export interface TrainingSummary {
  /** 统计的赛季（undefined = 全部记录） */
  season?: number;
  sessions: number;
  byKind: Record<TrainingRecordKind, number>;
  /** 额外训练花费（含被训练赛消耗的已购次数） */
  trainingSpend: number;
  /** 训练赛约练费用 */
  scrimSpend: number;
  totalSpend: number;
  scrims: number;
  scrimWins: number;
  /** 全部训练的全队合计收益 */
  totals: TrainingGainTotals;
  /** 各选手累计收益，按战力收益降序 */
  players: PlayerTrainingTotals[];
  byFocus: Record<TrainingFocus, FocusTrainingStats>;
}

const zero = (): TrainingGainTotals => ({ power: 0, mmr: 0, insight: 0, talent: 0, resilience: 0 });

function addGain(t: TrainingGainTotals, g: TrainingGain): void {
  t.power += num(g.power);
  t.mmr += num(g.mmr);
  t.insight += num(g.insight);
  t.talent += num(g.talent);
  t.resilience += num(g.resilience);
}

function divide(t: TrainingGainTotals, d: number): TrainingGainTotals {
  if (!(d > 0)) return zero();
  return { power: t.power / d, mmr: t.mmr / d, insight: t.insight / d, talent: t.talent / d, resilience: t.resilience / d };
}

/** 训练汇总：选手累计收益、花费、各焦点平均收益。season 缺省 = 全部记录 */
export function trainingSummary(state: GameState, season?: number): TrainingSummary {
  const records = trainingRecords(state, season);
  const byKind = { free: 0, extra: 0, scrim: 0, auto: 0 } as Record<TrainingRecordKind, number>;
  const totals = zero();
  const players = new Map<string, PlayerTrainingTotals>();
  const focusAcc = {} as Record<TrainingFocus, { sessions: number; mult: number; sum: TrainingGainTotals; gains: number }>;
  for (const f of FOCUSES) focusAcc[f] = { sessions: 0, mult: 0, sum: zero(), gains: 0 };
  let trainingSpend = 0;
  let scrimSpend = 0;
  let scrimWins = 0;

  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const kind = KINDS.includes(r.kind) ? r.kind : 'free';
    byKind[kind] += 1;
    const cost = Math.max(0, num(r.cost));
    const sessionCost = Math.min(cost, Math.max(0, num(r.sessionCost)));
    if (kind === 'scrim') {
      scrimSpend += cost - sessionCost;
      trainingSpend += sessionCost;
      if (r.scrimWon) scrimWins += 1;
    } else {
      trainingSpend += cost;
    }
    const fa = focusAcc[FOCUSES.includes(r.focus) ? r.focus : 'balanced'];
    fa.sessions += 1;
    fa.mult += num(r.mult) > 0 ? r.mult : 1;
    for (const g of Array.isArray(r.gains) ? r.gains : []) {
      if (!g || typeof g !== 'object') continue;
      addGain(totals, g);
      addGain(fa.sum, g);
      fa.gains += 1;
      let pt = players.get(g.playerId);
      if (!pt) {
        pt = { playerId: g.playerId, handle: state.players?.[g.playerId]?.handle ?? g.handle, sessions: 0, ...zero() };
        players.set(g.playerId, pt);
      }
      pt.sessions += 1;
      addGain(pt, g);
    }
  }

  const byFocus = {} as Record<TrainingFocus, FocusTrainingStats>;
  for (const f of FOCUSES) {
    const a = focusAcc[f];
    byFocus[f] = {
      sessions: a.sessions,
      avgMult: a.sessions > 0 ? a.mult / a.sessions : 0,
      avg: divide(a.sum, a.sessions),
      avgPerPlayer: divide(a.sum, a.gains),
    };
  }

  return {
    season,
    sessions: byKind.free + byKind.extra + byKind.scrim + byKind.auto,
    byKind,
    trainingSpend,
    scrimSpend,
    totalSpend: trainingSpend + scrimSpend,
    scrims: byKind.scrim,
    scrimWins,
    totals,
    players: [...players.values()].sort((a, b) => b.power - a.power || b.mmr - a.mmr || a.handle.localeCompare(b.handle)),
    byFocus,
  };
}
