// 单局/系列赛模拟【E2 负责实现】
import type {
  DraftAction, DraftEvaluation, DraftState, GameRecord, GameState, InMatchEvent, Player, Position, Series, SeriesResult,
  TournamentTier,
} from './types';
import { POSITIONS } from './types';
import { CONFIG } from './config';
import { rngOf } from './rng';
import type { Rng } from './rng';
import { clamp, ownEntry, round2 } from './util';
import { autoLineup, teamInsight, teamRating, validateLineup } from './team';
import { eventImpactScale, playerRating } from './player';
import { createDraft, draftLean, evaluateDraft, runDraftUntil } from './draft';
import { generateLive } from './commentary';
import { pediaEnabled, recordGameStats } from './stats';

// ---------------------------------------------------------------------------
// 局内突发事件
// ---------------------------------------------------------------------------
/** 每局最多突发事件数 */
const MAX_INCIDENTS = 2;
/** 突发事件发生的分钟区间（直播会夹到比赛时长内） */
const INCIDENT_MINUTE: [number, number] = [2, 35];
/** 突发事件幅度下限（避免出现「几乎无影响」的事件） */
const INCIDENT_MIN_MAGNITUDE = 0.03;
/** 文案档位：占 incidentPowerRange 端点的比例 */
const INCIDENT_SEVERE_FRAC = 0.55;
const INCIDENT_GREAT_FRAC = 0.5;

type IncidentText = (h: string, rng: Rng) => string;
const INCIDENT_TEXTS: Record<'severe' | 'mild' | 'good' | 'great', IncidentText[]> = {
  severe: [
    (h, r) => `${h} 网络掉线 ${r.int(1, 3)} 分钟`,
    (h) => `${h} 心态爆炸`,
    (h) => `${h} 外设故障，紧急暂停更换键盘`,
    (h) => `${h} 身体不适，操作明显变形`,
    (h) => `${h} 被对手重点针对，连续阵亡后状态下滑`,
  ],
  mild: [
    (h) => `${h} 关键技能放空`,
    (h) => `${h} 补刀节奏被打乱`,
    (h) => `${h} 走位失误被抓`,
    (h) => `${h} 的耳机出现杂音，团队交流受阻`,
    (h) => `${h} 买错装备，出装节奏慢了半拍`,
  ],
  good: [
    (h) => `${h} 手感火热`,
    (h) => `${h} 状态回暖，补刀行云流水`,
    (h) => `${h} 对线压制，打出优势`,
    (h) => `${h} 视野意识出众，连续识破对面游走`,
  ],
  great: [
    (h) => `${h} 打出神级操作`,
    (h) => `${h} 极限反杀，全场沸腾`,
    (h) => `${h} 灵性走位，丝血逃生`,
    (h) => `${h} 一手预判大招，瞬间改变战局`,
  ],
};

function lineupOf(state: GameState, teamId: string): { pos: Position; player: Player }[] {
  const team = ownEntry(state.teams, teamId);
  if (!team) return [];
  const res: { pos: Position; player: Player }[] = [];
  for (const pos of POSITIONS) {
    const pid = team.lineup?.[pos];
    const p = pid ? state.players[pid] : undefined;
    // 禁赛/退役选手视为空缺（与 team.lineupPlayers 一致）
    if (p && (!p.status || p.status === 'active')) res.push({ pos, player: p });
  }
  return res;
}

function safeImpactScale(p: Player): number {
  const v = eventImpactScale(p);
  return Number.isFinite(v) ? v : 1;
}

/** 局内突发事件（每局 0~2 个），powerMult 已按选手韧性缩放；text 为中文 */
export function rollIncidents(state: GameState, teamA: string, teamB: string): InMatchEvent[] {
  const M = CONFIG.match;
  const rng = rngOf(state);
  const res: InMatchEvent[] = [];
  const pool = [
    ...lineupOf(state, teamA).map((x) => ({ teamId: teamA, player: x.player })),
    ...lineupOf(state, teamB).map((x) => ({ teamId: teamB, player: x.player })),
  ];
  const [lo, hi] = M.incidentPowerRange;
  for (let i = 0; i < MAX_INCIDENTS && pool.length > 0; i++) {
    if (!rng.chance(M.incidentChancePerGame)) break;
    const idx = rng.int(0, pool.length - 1);
    const { teamId, player } = pool[idx];
    pool.splice(idx, 1); // 同一局同一选手只出一次事件
    // 先定方向（按区间两端比例），再定幅度
    const negShare = Math.abs(lo) / (Math.abs(lo) + Math.abs(hi) || 1);
    const negative = lo < 0 && (hi <= 0 || rng.chance(negShare));
    const end = negative ? Math.abs(lo) : Math.abs(hi);
    const mag = rng.range(Math.min(INCIDENT_MIN_MAGNITUDE, end), end);
    const raw = negative ? -mag : mag;
    const scaled = raw * safeImpactScale(player);
    let bucket: keyof typeof INCIDENT_TEXTS;
    if (negative) bucket = mag >= Math.abs(lo) * INCIDENT_SEVERE_FRAC ? 'severe' : 'mild';
    else bucket = mag >= Math.abs(hi) * INCIDENT_GREAT_FRAC ? 'great' : 'good';
    const text = rng.pick(INCIDENT_TEXTS[bucket])(player.handle, rng);
    res.push({
      minute: rng.int(INCIDENT_MINUTE[0], INCIDENT_MINUTE[1]),
      playerId: player.id,
      teamId,
      text,
      powerMult: Math.round((1 + scaled) * 1000) / 1000,
    });
  }
  return res;
}

// ---------------------------------------------------------------------------
// 胜率
// ---------------------------------------------------------------------------
function safeRating(state: GameState, teamId: string, incidents: InMatchEvent[]): number {
  if (!ownEntry(state.teams, teamId)) return 0;
  const v = teamRating(state, teamId, incidents);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function safeInsight(state: GameState, teamId: string): number {
  if (!ownEntry(state.teams, teamId)) return 50;
  const v = teamInsight(state, teamId);
  return Number.isFinite(v) ? v : 50;
}

/**
 * 最终胜率：pWin = wDraft × dotaPlusWR + wStrength × share，share = rA^γ/(rA^γ+rB^γ)，
 * rA/rB = team.teamRating(含 incidents)。夹在 [finalMin, finalMax]。
 */
export function computeWinProb(
  state: GameState,
  teamA: string,
  teamB: string,
  dotaPlusWinRateA: number,
  incidents: InMatchEvent[],
): { strengthA: number; strengthB: number; share: number; pWin: number } {
  const M = CONFIG.match;
  const inc = incidents ?? [];
  const strengthA = safeRating(state, teamA, inc.filter((i) => i.teamId === teamA));
  const strengthB = safeRating(state, teamB, inc.filter((i) => i.teamId === teamB));
  let share: number;
  if (strengthA <= 0 && strengthB <= 0) share = 0.5;
  else if (strengthA <= 0) share = 0;
  else if (strengthB <= 0) share = 1;
  // rA^γ/(rA^γ+rB^γ) = 1/(1+(rB/rA)^γ)，避免大数溢出
  else share = 1 / (1 + Math.pow(strengthB / strengthA, M.gamma));
  const dp = Number.isFinite(dotaPlusWinRateA) ? dotaPlusWinRateA : 0.5;
  const pWin = clamp(M.wDraft * dp + M.wStrength * share, M.finalMin, M.finalMax);
  return { strengthA: round2(strengthA), strengthB: round2(strengthB), share, pWin };
}

// ---------------------------------------------------------------------------
// 单局
// ---------------------------------------------------------------------------
/** 阵容偏前期时击杀数上浮比例（每单位 lean） */
const KILL_AGGRESSION = 0.15;
const KILL_SHARE_RANGE: [number, number] = [0.3, 0.95];

/**
 * 本赛季的年代基准（CONFIG.match.eraByTi：该届 TI 真实对局的平均时长 / 平均总击杀；表外赛季用 eraDefault）。
 * 只取决于赛季序号，不消耗随机数。
 */
export function eraMatchBaseline(state: Pick<GameState, 'season'> | null | undefined): { duration: number; kills: number } {
  const M = CONFIG.match;
  const ti = state?.season?.ti;
  const row = (typeof ti === 'number' ? M.eraByTi[ti] : undefined) ?? M.eraDefault;
  const ok = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return { duration: ok(row?.[0], M.eraDefault[0]), kills: ok(row?.[1], M.eraDefault[1]) };
}

/** AI 对 AI 快速路径：不做逐英雄 BP，用灵性 + 噪声近似大老师胜率 */
function fastEvaluation(state: GameState, teamA: string, teamB: string, rng: Rng): DraftEvaluation {
  const M = CONFIG.match;
  const insA = safeInsight(state, teamA);
  const insB = safeInsight(state, teamB);
  // 灵性越高 BP 噪声越小 → BP 评分差的期望向高灵性一方偏移（参数按完整 BP 实测标定）
  const diff = rng.normal(M.fastDraftInsightSlope * (insA - insB), M.fastDraftSigma);
  const wr = clamp(0.5 + diff * M.kDraft + (insA - insB) * M.kInsight, M.dotaPlusMin, M.dotaPlusMax);
  return { scoreA: round2(diff / 2), scoreB: round2(-diff / 2), dotaPlusWinRateA: Math.round(wr * 1000) / 1000, notes: [] };
}

/**
 * 时长（对数正态）：年代平均时长 × e^(阵容偏后期 + 势均力敌 + 爆冷 + N(−σ²/2, σ))。
 * 碾压局（胜率悬殊）更短、势均力敌 / 爆冷 / 双方后期阵容更长；总体 ln σ ≈ 0.28（真实 p10 ≈ 0.66×、p90 ≈ 1.4× 平均）。
 */
function rollDuration(
  rng: Rng, era: { duration: number }, lean: { leanA: number; leanB: number }, pWinA: number, pWinner: number,
): number {
  const M = CONFIG.match;
  const [lo, hi] = M.durationRange;
  const combinedLean = (lean.leanA + lean.leanB) / 2;
  const closeness = 1 - Math.abs(pWinA - 0.5) * 2;
  const upset = pWinner < 0.5;
  const shift = M.durationLeanShift * combinedLean
    + M.durationClosenessShift * (closeness - M.durationClosenessRef)
    + (upset ? M.durationUpsetShift : 0);
  const s = M.durationLogSigma;
  const d = era.duration * Math.exp(shift + rng.normal(-(s * s) / 2, s));
  return Math.round(clamp(Number.isFinite(d) ? d : era.duration, lo, hi));
}

/**
 * 总击杀与双方分配：总击杀 = 年代平均总击杀 × (时长 / 年代平均时长)^killsDurationExp × 阵容节奏 × 噪声
 * （长局击杀多但每分钟击杀少）；胜方占比随时长衰减（碾压局短且一边倒，长局比分接近，偶有胜方击杀更少）。
 * 噪声在对数尺度上均匀分布（标准差 killsLogSigma、均值归一，尾部有界，不会出现离谱的单局击杀）。
 * 随机数用量与改动前相同（1 个均匀数 + 1 个正态数）：快速模拟的主随机序列与标定前逐次对齐（胜负、事件等后续结果不变；
 * 有文字直播的对局，直播条目数随击杀数变化，之后的序列会不同）。
 */
function rollKills(
  rng: Rng,
  era: { duration: number; kills: number },
  durationMin: number,
  lean: { leanA: number; leanB: number },
  winner: 'A' | 'B',
  pWinner: number,
): { killsA: number; killsB: number } {
  const M = CONFIG.match;
  const aggression = -(lean.leanA + lean.leanB) / 2;
  const ratio = Math.max(0.1, durationMin / era.duration);
  const hw = Math.sqrt(3) * M.killsLogSigma;
  const u = rng.next();
  const noise = hw > 0 ? Math.exp(hw * (2 * u - 1)) * (hw / Math.sinh(hw)) : 1;
  const mean = era.kills * Math.pow(ratio, M.killsDurationExp) * Math.max(0.5, 1 + KILL_AGGRESSION * aggression);
  const raw = mean * noise;
  const total = Math.round(clamp(Number.isFinite(raw) ? raw : era.kills, M.killsRange[0], M.killsRange[1]));
  const edge = (M.winnerKillShare - 0.5) * Math.exp(-M.winnerKillShareDecay * (ratio - 1));
  const share = clamp(
    rng.normal(0.5 + edge + M.winnerKillSharePWin * (pWinner - 0.5), M.winnerKillShareSd),
    KILL_SHARE_RANGE[0], KILL_SHARE_RANGE[1],
  );
  const kw = Math.round(total * share);
  const kl = total - kw;
  return winner === 'A' ? { killsA: kw, killsB: kl } : { killsA: kl, killsB: kw };
}

/** 突发事件离比赛结束至少留出的分钟数（直播里事件之后还要有高地/GG） */
const INCIDENT_END_MARGIN = 3;

/**
 * 突发事件在定出时长之前就已生成：把发生分钟按比例压缩进本局时长，
 * 避免出现「22 分钟的比赛第 35 分钟掉线」（赛果卡片 / 直播里显示的分钟与时长矛盾）。
 */
function fitIncidentMinutes(incidents: InMatchEvent[], durationMin: number): void {
  const [lo, hi] = INCIDENT_MINUTE;
  const maxMinute = Math.max(lo, Math.min(hi, Math.floor(durationMin) - INCIDENT_END_MARGIN));
  if (maxMinute < hi) {
    for (const inc of incidents) {
      const m = clamp(inc.minute, lo, hi);
      inc.minute = Math.round(lo + ((m - lo) * (maxMinute - lo)) / Math.max(1, hi - lo));
    }
  }
  incidents.sort((a, b) => a.minute - b.minute);
}

/** 胜方表现最好的首发（评分 × 突发倍数 × 随机） */
function pickMvp(state: GameState, rng: Rng, teamId: string, incidents: InMatchEvent[]): string | undefined {
  let best: string | undefined;
  let bestScore = -Infinity;
  for (const { pos, player } of lineupOf(state, teamId)) {
    let r = playerRating(player, pos);
    if (!Number.isFinite(r)) r = player.power || 0;
    for (const inc of incidents) if (inc.playerId === player.id) r *= inc.powerMult;
    const perf = r * Math.max(0.1, rng.normal(1, CONFIG.match.mvpNoise));
    if (perf > bestScore) {
      bestScore = perf;
      best = player.id;
    }
  }
  return best;
}

function bumpStats(p: Player, win: boolean, mvp: boolean): void {
  if (!p.stats) p.stats = { matches: 0, wins: 0, titles: 0, tiTitles: 0, mvp: 0 };
  p.stats.matches += 1;
  if (win) p.stats.wins += 1;
  if (mvp) p.stats.mvp += 1;
}

/**
 * 模拟一局：若未提供已完成的 draft 则自动 BP；评估 → 突发事件 → 胜率 → 随机胜负 → 时长/击杀；
 * withLive=true 时调用 commentary.generateLive 生成文字直播。更新选手 stats（matches/wins/mvp）。
 */
export function simulateGame(
  state: GameState,
  p: { teamA: string; teamB: string; gameIndex: number; draft?: DraftState | null; withLive: boolean; tier: TournamentTier },
): GameRecord {
  const rng = rngOf(state);
  const { teamA, teamB } = p;
  const human = state.settings?.playerTeamId;
  // 多人模式：任一玩家战队（team.isPlayer）参与的对局都走完整 BP 评估（单机时只有玩家战队 isPlayer，结果不变）
  const involvesHuman = (!!human && (teamA === human || teamB === human))
    || !!state.teams[teamA]?.isPlayer || !!state.teams[teamB]?.isPlayer;
  const radiant: 'A' | 'B' = (p.gameIndex ?? 0) % 2 === 0 ? 'A' : 'B';

  // 1. BP / 大老师胜率（AI 对 AI 且无直播 → 快速路径）
  let draftActions: DraftAction[] = [];
  let evaluation: DraftEvaluation;
  let lean = { leanA: 0, leanB: 0 };
  const fast = !p.withLive && !involvesHuman && !p.draft;
  if (fast) {
    evaluation = fastEvaluation(state, teamA, teamB, rng);
  } else {
    const draft = p.draft ?? createDraft(state);
    if (!draft.done) runDraftUntil(state, draft, teamA, teamB, null);
    draftActions = draft.actions.map((a) => ({ ...a }));
    evaluation = evaluateDraft(state, draft, teamA, teamB);
    lean = draftLean(draftActions);
  }

  // 2. 突发事件 → 胜率 → 胜负
  const incidents = rollIncidents(state, teamA, teamB);
  const wp = computeWinProb(state, teamA, teamB, evaluation.dotaPlusWinRateA, incidents);
  const winner: 'A' | 'B' = rng.chance(wp.pWin) ? 'A' : 'B';
  const pWinner = winner === 'A' ? wp.pWin : 1 - wp.pWin;

  // 3. 时长 / 击杀 / MVP
  const era = eraMatchBaseline(state);
  const durationMin = rollDuration(rng, era, lean, wp.pWin, pWinner);
  fitIncidentMinutes(incidents, durationMin);
  const { killsA, killsB } = rollKills(rng, era, durationMin, lean, winner, pWinner);
  const winnerTeam = winner === 'A' ? teamA : teamB;
  const mvpPlayerId = pickMvp(state, rng, winnerTeam, incidents);

  // 4. 选手数据
  for (const [teamId, side] of [[teamA, 'A'], [teamB, 'B']] as const) {
    for (const { player } of lineupOf(state, teamId)) bumpStats(player, side === winner, player.id === mvpPlayerId);
  }

  const record: GameRecord = {
    index: p.gameIndex ?? 0,
    teamA,
    teamB,
    radiant,
    draft: draftActions,
    eval: evaluation,
    strengthA: wp.strengthA,
    strengthB: wp.strengthB,
    winProbA: Math.round(wp.pWin * 1000) / 1000,
    winner,
    durationMin,
    killsA,
    killsB,
    incidents,
    live: [],
    mvpPlayerId,
  };

  // 5. 文字直播（kdOut：直播中的个人击杀 / 阵亡，供 DotaPedia 统计与直播文本一致）
  const kd: Record<string, [number, number]> | undefined = p.withLive && pediaEnabled() ? {} : undefined;
  if (p.withLive) {
    record.live = generateLive(state, {
      kdOut: kd,
      teamA,
      teamB,
      radiant,
      draft: draftActions,
      winner,
      durationMin,
      killsA,
      killsB,
      incidents,
      winProbA: record.winProbA,
      mvpPlayerId,
      tier: p.tier,
      leanA: lean.leanA,
      leanB: lean.leanB,
    });
  }
  // 6. DotaPedia 统计（stats.ts：独立子随机流，不消耗主随机序列、不影响本局结果）
  recordGameStats(state, record, { A: lineupOf(state, teamA), B: lineupOf(state, teamB), tier: p.tier, kd });
  return record;
}

// ---------------------------------------------------------------------------
// 系列赛
// ---------------------------------------------------------------------------
/** 系列赛胜负判定：Bo2 可平局('draw')；未结束返回 null */
export function seriesOutcome(bestOf: number, winsA: number, winsB: number): 'A' | 'B' | 'draw' | null {
  if (bestOf === 2) {
    if (winsA + winsB < 2) return null;
    if (winsA > winsB) return 'A';
    if (winsB > winsA) return 'B';
    return 'draw';
  }
  const need = Math.floor(Math.max(1, bestOf) / 2) + 1;
  if (winsA >= need) return 'A';
  if (winsB >= need) return 'B';
  return null;
}

/**
 * 能否派出完整首发（5 名可出场的本队选手）。阵容不合法时先自动重排（用替补补位）再判断；
 * 仍凑不齐 5 人 → false（系列赛弃权判负，见 simulateSeries / game.quickSimSeries）。
 */
export function canFieldLineup(state: GameState, teamId: string, tournamentId?: string | null): boolean {
  if (!ownEntry(state.teams, teamId)) return false;
  if (!validateLineup(state, teamId, tournamentId).length) return true;
  autoLineup(state, teamId, tournamentId);
  return validateLineup(state, teamId, tournamentId).length === 0;
}

/** 弃权判负的系列赛结果：forfeitSide 方判负，对手记满胜局（Bo2 记 2:0），无对局记录 */
export function forfeitResult(series: Pick<Series, 'teamA' | 'teamB' | 'bestOf'>, forfeitSide: 'A' | 'B'): SeriesResult {
  const bestOf = series.bestOf || 1;
  const need = bestOf === 2 ? 2 : Math.floor(Math.max(1, bestOf) / 2) + 1;
  const a = series.teamA ?? '';
  const b = series.teamB ?? '';
  return forfeitSide === 'A'
    ? { winnerId: b, loserId: a, scoreA: 0, scoreB: need, games: [], forfeit: 'A' }
    : { winnerId: a, loserId: b, scoreA: need, scoreB: 0, games: [], forfeit: 'B' };
}

/**
 * 全自动模拟整个系列赛（AI 比赛 withLive=false）。Bo2 平局时 winnerId=teamA、loserId=teamB 且 scoreA===scoreB。
 * 首发凑不齐 5 人的一方弃权判负（双方都凑不齐时，可出场人数较少的一方判负；相同则 B 方判负）。
 */
export function simulateSeries(state: GameState, series: Series, tier: TournamentTier, withLive: boolean): SeriesResult {
  const teamA = series.teamA;
  const teamB = series.teamB;
  const bestOf = series.bestOf || 1;
  if (!teamA || !teamB) {
    // 一方空缺：另一方不战而胜（数据异常兜底）
    const present = teamA ?? teamB;
    if (!present) throw new Error('系列赛双方均未确定，无法模拟');
    const need = bestOf === 2 ? 2 : Math.floor(bestOf / 2) + 1;
    return {
      winnerId: present,
      loserId: (teamA ? teamB : teamA) ?? '',
      scoreA: teamA ? need : 0,
      scoreB: teamA ? 0 : need,
      games: [],
    };
  }
  const tid = series.tournamentId;
  const okA = canFieldLineup(state, teamA, tid);
  const okB = canFieldLineup(state, teamB, tid);
  if (!okA || !okB) {
    let side: 'A' | 'B' = okA ? 'B' : 'A';
    if (!okA && !okB) side = lineupOf(state, teamA).length < lineupOf(state, teamB).length ? 'A' : 'B';
    return forfeitResult(series, side);
  }
  const games: GameRecord[] = [];
  let winsA = 0;
  let winsB = 0;
  for (let i = 0; i < bestOf; i++) {
    if (seriesOutcome(bestOf, winsA, winsB)) break;
    const g = simulateGame(state, { teamA, teamB, gameIndex: i, draft: null, withLive, tier });
    games.push(g);
    if (g.winner === 'A') winsA++;
    else winsB++;
  }
  const outcome = seriesOutcome(bestOf, winsA, winsB) ?? (winsA > winsB ? 'A' : winsB > winsA ? 'B' : 'draw');
  const aWins = outcome === 'A' || outcome === 'draw';
  return {
    winnerId: aWins ? teamA : teamB,
    loserId: aWins ? teamB : teamA,
    scoreA: winsA,
    scoreB: winsB,
    games,
  };
}

/** 系列赛结束后的归属感变化（胜 +winSeries，负 +loseSeries），双方首发 */
export function applySeriesLoyalty(state: GameState, result: SeriesResult): void {
  if (!result || result.scoreA === result.scoreB) return; // 平局不变
  const max = CONFIG.player.maxAttr;
  const apply = (teamId: string, delta: number) => {
    for (const { player } of lineupOf(state, teamId)) {
      player.loyalty = clamp((player.loyalty ?? 0) + delta, 0, max);
    }
  };
  apply(result.winnerId, CONFIG.loyalty.winSeries);
  apply(result.loserId, CONFIG.loyalty.loseSeries);
}
