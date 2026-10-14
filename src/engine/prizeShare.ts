// ============================================================================
// 选手奖金分成（第九波 · 用户决策）【H1-prize-share】
//
// - 每支战队有奖金分成比例 Team.prizeShare ∈ [0.50, 1.00]：赛事奖金的该比例分给队员，俱乐部只拿剩余部分
//   （出场费与每回合的赞助 / 直播 / 周边收入全归俱乐部）。人机共用。
// - 初始比例：全部战队 50%（用户决策 2026-10-10「比赛奖金默认调整为 50% 给队员，剩下 50% 给俱乐部」；原为真实俱乐部按 id 哈希
//   55%–85%、新俱乐部 70%）。startSeason / endRound 补齐缺失值（新组织、旧存档；已有比例的旧存档保持原值）。
// - 玩家调整：setPrizeShare（步长 5%，每回合最多一次，多人模式为白名单 RPC）。即时影响正式队员归属感：
//   上调小幅提升、下调明显下降（损失厌恶，上下限同比例），按幅度与在队时长速度倍数（salary.tenureSpeedMult）缩放；
//   下调后约一个赛季内把比例调回下调前的水平不带来即时加成（只有超出原水平的部分算上调）。调整发公开新闻。
// - 持续影响：每回合环境项（salary.prizeShareLoyaltyDelta，高于默认的 50% 小幅加分）；
//   发奖金时每名分到奖金的正式队员按「分得金额 / 每回合工资」提升归属感，并记入近期奖金收入（按每回合折算全额计入薪资满意度，
//   salary.prizeSalaryCredit；预期薪资仍不显示）。
// - AI 战队偶尔调整：队员不满或资金充裕时上调，资金紧张时再下调（不低于下限 50%）。
// 确定性：初始值为常数（不消耗 state.rng）；AI 调整用 rngOf(state)。
// ============================================================================
import type { GameState, OpResult, Player, PrizeShareChange, Team } from './types';
import { POSITIONS } from './types';
import { CONFIG } from './config';
import { rngOf } from './rng';
import { clamp, formatGold, ownEntry, round1, round2 } from './util';
import { addNews } from './news';
import { addFinance } from './economy';
import { adjustLoyalty } from './growth';
import { prizeShareLoyaltyDelta, recordPrizeIncome, tenureSeasons, tenureSpeedMult } from './salary';
import { isHumanTeam } from './seat';

export { prizeShareLoyaltyDelta } from './salary';

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function C() {
  return CONFIG.prizeShare;
}

function stepOf(): number {
  const s = num(C().step, 0.05);
  return s > 0 ? s : 0.05;
}

/** 回合键：赛季 × 100 + 回合（与 squadOps.squadRoundKey 一致） */
function roundKeyOf(state: GameState): number {
  return num(state.season?.ti, 0) * 100 + Math.max(0, Math.floor(num(state.roundIndex, 0)));
}

/** 两个回合键之间经过的回合数（跨赛季按每赛季回合数估算） */
function roundsBetween(state: GameState, fromKey: number, toKey: number): number {
  const perSeason = Math.max(1, state.season?.rounds?.length || CONFIG.calendar.regularRounds + 3);
  const tiA = Math.floor(fromKey / 100);
  const tiB = Math.floor(toKey / 100);
  return (tiB - tiA) * perSeason + ((toKey % 100) - (fromKey % 100));
}

/** 比例 → 百分比文本（0.7 → 「70%」） */
export function formatPrizeShare(share: number): string {
  return `${Math.round(num(share) * 100)}%`;
}

/** 夹在 [min, max] 并取整到步长（非法值按默认值） */
export function normalizePrizeShare(v: unknown): number {
  const c = C();
  const step = stepOf();
  const x = typeof v === 'number' && Number.isFinite(v) ? v : num(c.initial, 0.5);
  const snapped = Math.round(x / step) * step;
  return round2(clamp(snapped, num(c.min, 0.5), num(c.max, 1)));
}

/**
 * 战队的初始（默认）分成比例：全部战队一律 CONFIG.prizeShare.initial（50%，用户决策 2026-10-10），
 * 新俱乐部 / 真实俱乐部 / AI 战队 / 多人模式玩家战队相同（参数保留以兼容调用方）。
 */
export function defaultPrizeShare(_state: GameState, _team?: Team | null): number {
  return normalizePrizeShare(C().initial);
}

/** 战队当前的分成比例（缺失时按默认值，不写入状态） */
export function prizeShareOf(state: GameState, teamOrId: Team | string | null | undefined): number {
  const team = typeof teamOrId === 'string' ? ownEntry(state.teams, teamOrId) : teamOrId;
  if (!team) return defaultPrizeShare(state, null);
  if (typeof team.prizeShare === 'number' && Number.isFinite(team.prizeShare)) return normalizePrizeShare(team.prizeShare);
  return defaultPrizeShare(state, team);
}

/** 补齐（并规范化）一支战队的分成比例，返回当前值 */
export function ensurePrizeShare(state: GameState, team: Team): number {
  if (!team) return defaultPrizeShare(state, null);
  const v = prizeShareOf(state, team);
  if (team.prizeShare !== v) team.prizeShare = v;
  return v;
}

/** 补齐所有战队缺失的分成比例（赛季初 / 每回合结束：新组织、旧存档）。返回补齐的数量 */
export function ensurePrizeShares(state: GameState): number {
  let n = 0;
  for (const id in state.teams ?? {}) {
    const team = state.teams[id];
    if (!team) continue;
    const had = typeof team.prizeShare === 'number' && Number.isFinite(team.prizeShare);
    ensurePrizeShare(state, team);
    if (!had) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 奖金拆分与发放
// ---------------------------------------------------------------------------

export interface PrizeCut {
  playerId: string;
  amount: number;
}

export interface PrizeSplit {
  /** 名次奖金总额 */
  total: number;
  /** 俱乐部实得 */
  club: number;
  /** 队员分得合计 */
  players: number;
  /** 使用的分成比例 */
  share: number;
  /** 每名队员分得的金额 */
  cuts: PrizeCut[];
}

interface Recipient {
  p: Player;
  weight: number;
}

/** 分奖金的队员：在队 active 选手（含临时替补）；赛事结束时的首发权重 1，其余 benchWeight */
function prizeRecipients(state: GameState, team: Team): Recipient[] {
  const starters = new Set<string>();
  for (const pos of POSITIONS) {
    const id = team.lineup?.[pos];
    if (id) starters.add(id);
  }
  const bench = clamp(num(C().benchWeight, 0.5), 0, 1);
  const out: Recipient[] = [];
  const seen = new Set<string>();
  for (const id of team.playerIds ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = state.players?.[id];
    if (!p || p.status !== 'active' || p.teamId !== team.id) continue;
    const weight = starters.has(id) ? 1 : bench;
    if (weight > 0) out.push({ p, weight });
  }
  return out;
}

/**
 * 奖金拆分（纯函数，不写入状态）：队员分得 round(总额 × 分成比例)，按权重分给队员（取整余数给权重最高者），
 * 俱乐部实得其余。没有可分配的队员时全归俱乐部。
 */
export function splitPrize(state: GameState, teamId: string, prize: number): PrizeSplit {
  const total = Math.max(0, Math.round(num(prize)));
  const team = ownEntry(state.teams, teamId);
  const share = team ? prizeShareOf(state, team) : 0;
  if (!team || total <= 0) return { total, club: total, players: 0, share, cuts: [] };
  const rec = prizeRecipients(state, team);
  const weightSum = rec.reduce((a, r) => a + r.weight, 0);
  if (!(weightSum > 0)) return { total, club: total, players: 0, share, cuts: [] };
  const players = Math.min(total, Math.max(0, Math.round(total * share)));
  const cuts: PrizeCut[] = rec.map((r) => ({ playerId: r.p.id, amount: Math.floor((players * r.weight) / weightSum) }));
  const given = cuts.reduce((a, c) => a + c.amount, 0);
  if (players - given > 0 && cuts.length) {
    let best = 0;
    for (let i = 1; i < rec.length; i++) if (rec[i].weight > rec[best].weight) best = i;
    cuts[best].amount += players - given;
  }
  return { total, club: total - players, players, share, cuts };
}

/** 账目 / 新闻用的奖金文本：「奖金 45.0万（俱乐部 13.5万 / 队员 31.5万）」 */
export function prizeSplitText(split: Pick<PrizeSplit, 'total' | 'club' | 'players'>): string {
  return `奖金 ${formatGold(split.total)}（俱乐部 ${formatGold(split.club)} / 队员 ${formatGold(split.players)}）`;
}

/**
 * 分到奖金的归属感加成（纯函数）：prizeMax × (1 − e^(−分得 / 每回合工资 / prizeRef))。
 * 工资按 CONFIG.economy.minSalary 兜底。
 */
export function prizeCutLoyaltyGain(cut: number, salary: number): number {
  const L = C().loyalty;
  const c = num(cut);
  if (!(c > 0)) return 0;
  const s = Math.max(CONFIG.economy.minSalary, num(salary));
  const v = Math.max(0, num(L.prizeMax)) * (1 - Math.exp(-(c / s) / Math.max(1e-6, num(L.prizeRef, 6))));
  return Number.isFinite(v) ? round2(Math.max(0, v)) : 0;
}

/**
 * 发放一项赛事的名次奖金（tournament.finishTournament 调用）：俱乐部入账 (1 − 分成) 部分（账目说明
 * 「{label} 奖金 X（俱乐部 Y / 队员 Z）」；全部分给队员时也记一条 0 金额的账目），队员分得其余；
 * 每名分到奖金的正式队员（非临时 / 野外替补）提升归属感并记入近期奖金收入。返回拆分结果。
 */
export function payTournamentPrize(state: GameState, teamId: string, prize: number, label: string): PrizeSplit {
  const team = ownEntry(state.teams, teamId);
  if (team) ensurePrizeShare(state, team);
  const split = splitPrize(state, teamId, prize);
  if (!team || split.total <= 0) return split;
  const note = `${label} ${prizeSplitText(split)}`;
  addFinance(state, teamId, split.club, 'prize', note, { keepZero: true });
  for (const c of split.cuts) {
    if (!(c.amount > 0)) continue;
    const p = state.players?.[c.playerId];
    if (!p || p.tempSubUntilTournament || p.isWildSub) continue;
    const gain = prizeCutLoyaltyGain(c.amount, p.salary);
    if (gain > 0) adjustLoyalty(p, gain);
    recordPrizeIncome(state, p, c.amount, teamId);
  }
  return split;
}

// ---------------------------------------------------------------------------
// 调整比例
// ---------------------------------------------------------------------------

/**
 * 调整比例的即时归属感影响（每名正式队员；纯函数）：每 5% 上调 +raisePerStep、下调 −cutPerStep（损失厌恶），
 * × 在队时长速度倍数；上调至多 +maxImmediateRaise、下调至多 −maxImmediate（两个上限同比例，大幅调整时仍保持损失厌恶）。
 * raiseFloor：下调后冷静期内的「下调前水平」——上调时只有超出该水平的部分计入（调回原水平队员并不领情）；
 * true = 上调完全没有加成。
 */
export function prizeShareChangeLoyalty(from: number, to: number, tenureMult: number, raiseFloor?: number | boolean | null): number {
  const L = C().loyalty;
  const f = num(from);
  const t = num(to);
  const d = t - f;
  if (Math.abs(d) < 1e-9) return 0;
  const m = Math.max(0, num(tenureMult, 1));
  const step = stepOf();
  if (d > 0) {
    if (raiseFloor === true) return 0;
    const base = typeof raiseFloor === 'number' && Number.isFinite(raiseFloor) ? Math.max(f, raiseFloor) : f;
    const steps = Math.max(0, t - base) / step;
    if (!(steps > 1e-6)) return 0;
    const cap = Math.max(0, num(L.maxImmediateRaise, num(L.maxImmediate, 25)));
    return round2(Math.min(cap, Math.max(0, num(L.raisePerStep)) * steps * m));
  }
  const cap = Math.max(0, num(L.maxImmediate, 25));
  return round2(-Math.min(cap, Math.max(0, num(L.cutPerStep)) * (-d / step) * m));
}

/** 下调后冷静期剩余回合（期间把比例调回下调前的水平没有即时加成）；0 = 不在冷静期 */
export function raiseCooldownLeft(state: GameState, team: Team): number {
  const key = team?.prizeShareCutKey;
  if (typeof key !== 'number' || !Number.isFinite(key)) return 0;
  const cd = Math.max(0, Math.floor(num(C().loyalty.raiseCooldownRounds)));
  const elapsed = roundsBetween(state, key, roundKeyOf(state));
  return elapsed >= 0 && elapsed < cd ? cd - elapsed : 0;
}

/** 冷静期内的「下调前水平」：上调到该水平以内没有即时加成；不在冷静期（或无记录）为 null */
export function prizeShareRestoreLevel(state: GameState, team: Team): number | null {
  if (!team || raiseCooldownLeft(state, team) <= 0) return null;
  const v = team.prizeShareCutFrom;
  return typeof v === 'number' && Number.isFinite(v) ? normalizePrizeShare(v) : null;
}

/** 正式队员（active、非临时 / 野外替补） */
function regularMembers(state: GameState, team: Team): Player[] {
  const out: Player[] = [];
  for (const id of team.playerIds ?? []) {
    const p = state.players?.[id];
    if (!p || p.status !== 'active' || p.teamId !== team.id || p.tempSubUntilTournament || p.isWildSub) continue;
    out.push(p);
  }
  return out;
}

export interface PrizeShareMemberEffect {
  playerId: string;
  handle: string;
  /** 在队时长速度倍数 */
  mult: number;
  /** 即时归属感变化（实际值受 0..100 截断） */
  delta: number;
}

/** 调整的即时影响（每名正式队员）；floor = 冷静期内的下调前水平（prizeShareRestoreLevel） */
function memberEffects(state: GameState, team: Team, from: number, to: number, floor: number | null): PrizeShareMemberEffect[] {
  return regularMembers(state, team).map((p) => {
    const mult = tenureSpeedMult(tenureSeasons(state, p));
    return { playerId: p.id, handle: p.handle, mult, delta: prizeShareChangeLoyalty(from, to, mult, floor) };
  });
}

/** 上调中是否有一部分只是「调回下调前的水平」（没有即时加成） */
function restorePartial(from: number, to: number, floor: number | null): boolean {
  return to > from + 1e-9 && floor !== null && floor > from + 1e-9;
}

/** 写入新比例、调整记录、即时归属感影响与新闻（人机共用） */
function applyShareChange(
  state: GameState,
  team: Team,
  to: number,
  opts: { reason?: string; human: boolean },
): { from: number; to: number; effects: PrizeShareMemberEffect[] } {
  const from = ensurePrizeShare(state, team);
  const next = normalizePrizeShare(to);
  const key = roundKeyOf(state);
  const floor = prizeShareRestoreLevel(state, team);
  const effects = memberEffects(state, team, from, next, floor);
  for (const e of effects) {
    const p = state.players[e.playerId];
    if (p && e.delta) adjustLoyalty(p, e.delta);
  }
  team.prizeShare = next;
  team.prizeShareRoundKey = key;
  if (next < from) {
    // 下调：记下「下调前水平」（冷静期内连续下调取最高），冷静期从本次下调起算
    team.prizeShareCutFrom = floor !== null ? Math.max(floor, from) : from;
    team.prizeShareCutKey = key;
  } else if (floor !== null && next >= floor - 1e-9) {
    // 已调回（或超过）下调前水平：冷静期结束
    delete team.prizeShareCutFrom;
    delete team.prizeShareCutKey;
  }
  const log: PrizeShareChange[] = Array.isArray(team.prizeShareLog) ? team.prizeShareLog : [];
  const entry: PrizeShareChange = { season: num(state.season?.ti, 0), round: Math.max(0, num(state.roundIndex, 0)), from, to: next };
  if (opts.reason) entry.reason = opts.reason;
  log.push(entry);
  const max = Math.max(1, Math.floor(num(C().logMax, 8)));
  if (log.length > max) log.splice(0, log.length - max);
  team.prizeShareLog = log;

  const notable = opts.human || num(team.honor) >= num(C().ai.newsMinHonor, Infinity);
  if (notable) {
    const up = next > from;
    const why = opts.reason ? `（${opts.reason}）` : '';
    addNews(
      state, 'finance',
      `${team.name} 将奖金分成${up ? '提高到' : '下调至'} ${formatPrizeShare(next)}`,
      `${team.name} 宣布调整选手奖金分成${why}：今后赛事奖金的 ${formatPrizeShare(next)} 分给队员（此前 ${formatPrizeShare(from)}），`
        + `俱乐部保留 ${formatPrizeShare(1 - next)}。${up ? '队员们对此表示欢迎。' : '队员们对此颇有微词。'}`,
      opts.human && Math.abs(next - from) >= 0.1 - 1e-9,
      { teamIds: [team.id], visibility: 'public', actorTeamId: opts.human ? team.id : undefined, noInfer: true },
    );
  }
  return { from, to: next, effects };
}

export interface PrizeSharePreview {
  from: number;
  to: number;
  allowed: boolean;
  /** 不允许时的中文原因 */
  reason: string;
  /** 每名正式队员的即时归属感变化 */
  members: PrizeShareMemberEffect[];
  avgDelta: number;
  /** 调整前 / 后每名队员的每回合环境项 */
  roundDeltaBefore: number;
  roundDeltaAfter: number;
  /** 下调后的冷静期内上调：调回下调前水平（restoreLevel）以内的部分没有即时加成 */
  raiseSuppressed: boolean;
  /** 冷静期内的下调前水平（不在冷静期为 null） */
  restoreLevel: number | null;
}

/** 参数 → 比例：接受 0.5..1 的小数或 50..100 的百分数；非法返回 null */
function parseShare(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v > 1 + 1e-9 ? v / 100 : v;
}

/** 调整预览（本队，UI 用）：是否允许、各队员的即时影响、调整前后的每回合环境项 */
export function prizeSharePreview(state: GameState, share: number): PrizeSharePreview {
  const team = state.teams?.[state.settings?.playerTeamId];
  const cur = team ? prizeShareOf(state, team) : defaultPrizeShare(state, null);
  const base: PrizeSharePreview = {
    from: cur, to: cur, allowed: false, reason: '', members: [], avgDelta: 0,
    roundDeltaBefore: prizeShareLoyaltyDelta(cur), roundDeltaAfter: prizeShareLoyaltyDelta(cur), raiseSuppressed: false,
    restoreLevel: team ? prizeShareRestoreLevel(state, team) : null,
  };
  if (!team || team.disbanded || state.gameOver) return { ...base, reason: '战队不存在或游戏已结束' };
  const v = parseShare(share);
  if (v === null) return { ...base, reason: '分成比例无效' };
  const c = C();
  const step = stepOf();
  if (v < num(c.min, 0.5) - 1e-9 || v > num(c.max, 1) + 1e-9) {
    return { ...base, reason: `分成比例需在 ${formatPrizeShare(c.min)}–${formatPrizeShare(c.max)} 之间` };
  }
  if (Math.abs(v / step - Math.round(v / step)) > 1e-6) return { ...base, reason: `分成比例的步长为 ${formatPrizeShare(step)}` };
  const to = normalizePrizeShare(v);
  const floor = base.restoreLevel;
  const suppressed = restorePartial(cur, to, floor);
  const members = memberEffects(state, team, cur, to, floor);
  const avgDelta = members.length ? round1(members.reduce((a, m) => a + m.delta, 0) / members.length) : 0;
  const pv: PrizeSharePreview = {
    ...base, to, members, avgDelta, roundDeltaAfter: prizeShareLoyaltyDelta(to), raiseSuppressed: suppressed,
  };
  if (Math.abs(to - cur) < 1e-9) return { ...pv, reason: '与当前分成比例相同' };
  if (team.prizeShareRoundKey === roundKeyOf(state)) return { ...pv, reason: '本回合已调整过奖金分成（每回合最多一次）' };
  return { ...pv, allowed: true };
}

/**
 * 玩家操作：设置本队的选手奖金分成比例（0.5–1，步长 0.05；也接受 50–100 的百分数），每回合最多一次。
 * 即时影响正式队员归属感（上调小幅提升、下调明显下降，按在队时长放大），发公开新闻。
 */
export function setPrizeShare(state: GameState, share: number): OpResult {
  const pv = prizeSharePreview(state, share);
  if (!pv.allowed) return { ok: false, message: pv.reason || '无法调整奖金分成' };
  const team = state.teams[state.settings.playerTeamId];
  const r = applyShareChange(state, team, pv.to, { human: true });
  const up = r.to > r.from;
  const avg = r.effects.length ? round1(r.effects.reduce((a, e) => a + e.delta, 0) / r.effects.length) : 0;
  // 冷静期内上调：调回下调前水平以内的部分没有即时加成
  const floor = pv.raiseSuppressed ? pv.restoreLevel : null;
  let effect = '';
  if (r.effects.length && avg !== 0) {
    effect = `；队员归属感平均 ${avg > 0 ? '+' : ''}${avg}${floor !== null ? `（只有超出下调前 ${formatPrizeShare(floor)} 的部分才算上调）` : ''}`;
  } else if (r.effects.length && floor !== null) {
    effect = `；只是调回下调前的 ${formatPrizeShare(floor)} 以内，队员们并不领情，归属感没有变化`;
  }
  return {
    ok: true,
    message: `奖金分成已${up ? '提高到' : '下调至'} ${formatPrizeShare(r.to)}（此前 ${formatPrizeShare(r.from)}）${effect}`,
  };
}

export interface PrizeShareStatus {
  teamId: string;
  share: number;
  min: number;
  max: number;
  step: number;
  /** 本回合能否调整 */
  canChange: boolean;
  reason: string;
  /** 下调后的冷静期剩余回合（期间调回下调前水平 restoreLevel 以内没有即时加成） */
  raiseCooldownLeft: number;
  /** 冷静期内的下调前水平（不在冷静期为 null） */
  restoreLevel: number | null;
  /** 当前比例下每名队员的每回合环境项 */
  roundDelta: number;
  /** 最近的调整（最新在前） */
  log: PrizeShareChange[];
}

/** 战队的奖金分成状态（UI；默认本队） */
export function prizeShareStatus(state: GameState, teamId?: string | null): PrizeShareStatus {
  const c = C();
  const id = teamId ?? state.settings?.playerTeamId ?? '';
  const team = ownEntry(state.teams, id);
  const share = team ? prizeShareOf(state, team) : defaultPrizeShare(state, null);
  let reason = '';
  if (!team || team.disbanded || state.gameOver) reason = '战队不存在或游戏已结束';
  else if (team.prizeShareRoundKey === roundKeyOf(state)) reason = '本回合已调整过奖金分成（每回合最多一次）';
  return {
    teamId: id,
    share,
    min: normalizePrizeShare(c.min),
    max: normalizePrizeShare(c.max),
    step: stepOf(),
    canChange: !reason,
    reason,
    raiseCooldownLeft: team ? raiseCooldownLeft(state, team) : 0,
    restoreLevel: team ? prizeShareRestoreLevel(state, team) : null,
    roundDelta: prizeShareLoyaltyDelta(share),
    log: Array.isArray(team?.prizeShareLog) ? team!.prizeShareLog!.slice().reverse() : [],
  };
}

// ---------------------------------------------------------------------------
// AI 调整 / 每回合
// ---------------------------------------------------------------------------

/** 每回合工资（选手 + 教练；不 import economy.roundWageBill，便于赛事单测替身） */
function wageBill(state: GameState, team: Team): number {
  let total = 0;
  for (const id of team.playerIds ?? []) {
    const p = state.players?.[id];
    if (p && p.status === 'active') total += Math.max(0, num(p.salary));
  }
  const coach = team.coachId ? state.coaches?.[team.coachId] : undefined;
  if (coach) total += Math.max(0, num(coach.salary));
  return total;
}

/** 首发平均归属感（无首发时 null） */
function starterLoyalty(state: GameState, team: Team): number | null {
  let s = 0;
  let n = 0;
  for (const pos of POSITIONS) {
    const id = team.lineup?.[pos];
    const p = id ? state.players?.[id] : undefined;
    if (!p || p.teamId !== team.id || p.status !== 'active') continue;
    s += num(p.loyalty, 50);
    n++;
  }
  return n ? s / n : null;
}

/**
 * AI 战队偶尔调整分成（每回合结束）：资金 < 工资 × brokeWageRounds → 以 cutChance 下调一档（资金紧张）；
 * 首发平均归属感 < unhappyLoyalty → 上调（安抚队员）；资金 > 工资 × richWageRounds → 上调（资金充裕）：以 raiseChance，至多 ai.max。
 * 概率用 rngOf（只为满足条件的战队取数）。返回调整的战队数。
 */
export function aiAdjustPrizeShares(state: GameState): number {
  const c = C();
  const A = c.ai;
  const step = stepOf();
  const lo = normalizePrizeShare(c.min);
  const hi = Math.min(normalizePrizeShare(c.max), normalizePrizeShare(A.max));
  let rng: ReturnType<typeof rngOf> | null = null;
  let n = 0;
  for (const id of Object.keys(state.teams ?? {})) {
    const team = state.teams[id];
    if (!team || team.disbanded || team.isPlayer || isHumanTeam(state, id)) continue;
    const cur = ensurePrizeShare(state, team);
    const wage = wageBill(state, team);
    const gold = num(team.gold);
    let target: number | null = null;
    let reason = '';
    let chance = num(A.raiseChance);
    if (wage > 0 && gold < wage * Math.max(0, num(A.brokeWageRounds))) {
      if (cur > lo + 1e-9) {
        target = cur - step;
        reason = '资金紧张';
        chance = num(A.cutChance);
      }
    } else {
      const loyalty = starterLoyalty(state, team);
      if (loyalty !== null && loyalty < num(A.unhappyLoyalty, 0)) {
        if (cur < hi - 1e-9) {
          target = cur + step;
          reason = '安抚队员';
        }
      } else if (wage > 0 && gold > wage * Math.max(0, num(A.richWageRounds, Infinity))) {
        if (cur < hi - 1e-9) {
          target = cur + step;
          reason = '资金充裕';
        }
      }
    }
    if (target === null) continue;
    rng ??= rngOf(state);
    if (!rng.chance(clamp(chance, 0, 1))) continue;
    applyShareChange(state, team, clamp(target, lo, hi), { reason, human: false });
    n++;
  }
  return n;
}

/** 每回合结束（season.endRound）：补齐缺失的分成比例 + AI 调整 */
export function prizeShareRoundUpdate(state: GameState): void {
  ensurePrizeShares(state);
  aiAdjustPrizeShares(state);
}
