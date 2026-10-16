// 成长：训练、训练赛、赛事成长、年龄、退役、教练效果、归属感【E1 负责实现】
import { CONFIG, TI_YEAR } from './config';
import { coachFromRetiredPlayer } from './generation';
import { addNews } from './news';
import { ageOf, effectiveAttr, playerTier, seasonYear, tierIndex } from './player';
import type { Rng } from './rng';
import { rngOf } from './rng';
import { getCoach, lineupPlayers, removePlayerFromTeam, teamPlayers, teamRating } from './team';
import type { Coach, GameState, Player, Position, TournamentSettlement, TournamentTier, TrainingFocus, TrainingGain } from './types';
import { POSITIONS } from './types';
import { positionAgeGrowthMult, trendDeclineMult, trendGrowthMult, yearsPastPeak } from './form';
import { clamp, lerp, ownEntry, round2 } from './util';
import { isHumanTeam } from './seat';
import { loyaltyEnvironment, prizeShareLoyaltyDelta, recordSalaryGap, updateSalaryTrack } from './salary';
import { retirementProtected } from './realCareer';

// ---------------------------------------------------------------------------
// 基础公式
// ---------------------------------------------------------------------------

/**
 * 年龄成长系数（CONFIG.growth.ageFactor 表）。给出位置时，已过该位置巅峰窗口（CONFIG.aging.peakWindow）的选手
 * 再 × aging.postPeakGrowthMult：核心 26 岁起、辅助 29 岁起成长明显放缓（辅助巅峰更晚）。
 */
export function ageFactor(age: number, pos?: Position): number {
  const table = CONFIG.growth.ageFactor;
  const posMult = pos ? positionAgeGrowthMult(age, pos) : 1;
  for (const [maxAge, f] of table) {
    if (age <= maxAge) return f * posMult;
  }
  return (table.length ? table[table.length - 1][1] : 1) * posMult;
}

/** 天赋随机：U(min, min + spread × (talent/100)^talentExponent) */
export function rollGain(rng: Rng, base: { min: number; spread: number }, talent: number): number {
  const t = clamp(Number.isFinite(talent) ? talent : 0, 0, 100) / 100;
  const hi = base.min + base.spread * Math.pow(t, CONFIG.growth.talentExponent);
  return rng.range(base.min, Math.max(base.min, hi));
}

/** 战力软上限：clamp((start - power)/range, min, 1) */
export function powerSoftCap(power: number): number {
  const { powerSoftCapStart, powerSoftCapRange, powerSoftCapMin } = CONFIG.player;
  return clamp((powerSoftCapStart - power) / powerSoftCapRange, powerSoftCapMin, 1);
}

/** 天梯软上限：clamp((mmrSoftCap - mmr)/range, min, 1) */
export function mmrSoftCap(mmr: number): number {
  const g = CONFIG.growth;
  return clamp((g.mmrSoftCap - mmr) / g.mmrSoftCapRange, g.mmrSoftCapMin, 1);
}

/** 灵性软上限 */
export function insightSoftCap(insight: number): number {
  const g = CONFIG.growth;
  return clamp((g.insightSoftCapStart - insight) / g.insightSoftCapRange, g.insightSoftCapMin, 1);
}

/** 天赋/韧性（教练提升）软上限 */
function attrSoftCap(v: number): number {
  const g = CONFIG.growth;
  return clamp((CONFIG.player.maxAttr - v) / g.coachBoostSoftCapRange, g.coachBoostSoftCapMin, 1);
}

const MAX_ATTR = () => CONFIG.player.maxAttr;

/** 在基础值上加成长并取整存储，返回实际变化（2 位小数） */
function bump2(p: Player, attr: 'power' | 'insight' | 'talent' | 'resilience', delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const old = Number.isFinite(p[attr]) ? p[attr] : 0;
  let next = round2(old + delta);
  next = attr === 'power' ? Math.max(1, next) : clamp(next, 0, MAX_ATTR());
  p[attr] = next;
  return round2(next - old);
}

function bumpMmr(p: Player, delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const old = Number.isFinite(p.mmr) ? p.mmr : CONFIG.ladder.thresholds.C;
  const next = Math.round(clamp(old + delta, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr));
  p.mmr = next;
  return next - old;
}

function starterIdSet(state: GameState, teamId: string): Set<string> {
  const team = ownEntry(state.teams, teamId);
  const set = new Set<string>();
  if (!team?.lineup) return set;
  for (const pos of POSITIONS) {
    const id = team.lineup[pos];
    if (id) set.add(id);
  }
  return set;
}

// ---------------------------------------------------------------------------
// 训练
// ---------------------------------------------------------------------------

/** trainTeam 的可选参数 */
export interface TrainOptions {
  /**
   * 按属性的收益倍数（AI 战队传 CONFIG.training.aiGainMult：AI 参赛多、训练少，单独缩放，联赛整体分布不随玩家训练加强而通胀）。
   * 缺省 = 1（人类玩家战队）
   */
  gainMult?: { power?: number; mmr?: number; insight?: number };
  /**
   * 天赋 / 韧性（年轻选手训练时的天赋自然增长 + 教练提升）的收益倍数。同一休赛回合第 2 次起的训练（额外训练、训练赛加练、
   * 回合末自动完成的已购次数、AI 加练）传 CONFIG.training.extraSessionAttrMult：天赋与韧性主要按「每个休赛回合一次」成长，
   * 狂练只加快战力 / 天梯 / 灵性，不会把天赋（成长快慢的决定因素）或韧性练上天。缺省 = 1。
   */
  attrMult?: number;
}

const positiveOr1 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 1);

/**
 * 人类玩家一次训练的 trainTeam 选项：消耗已购额外次数（同一休赛回合第 2 次起）时，天赋 / 韧性收益 × CONFIG.training.extraSessionAttrMult
 * （天赋与韧性主要按每回合一次成长；狂练只加快战力 / 天梯 / 灵性）。免费次数（每回合第一次）按全额。
 */
export function sessionTrainOptions(session: 'free' | 'extra' | null | undefined): TrainOptions | undefined {
  return session === 'extra' ? { attrMult: CONFIG.training.extraSessionAttrMult } : undefined;
}

/**
 * 记录人类玩家战队的训练投入（Player.development.trainedMmr / trainedPower）：经理花钱练出来的成长。
 * 赛季自主成长的「到顶回落」与天梯相对校准据此保护这部分提升（development.ts，CONFIG.development.investment）。
 */
function bankTraining(p: Player, mmr: number, power: number): void {
  if (!(mmr > 0) && !(power > 0)) return;
  const d = (p.development ??= {});
  if (mmr > 0) d.trainedMmr = Math.round((Number.isFinite(d.trainedMmr) ? (d.trainedMmr as number) : 0) + mmr);
  if (power > 0) d.trainedPower = round2((Number.isFinite(d.trainedPower) ? (d.trainedPower as number) : 0) + power);
}

/**
 * 对战队执行一次训练：首发全额、替补 × benchTrainingMult；
 * 按焦点分配 power/mmr/insight 收益，乘 ageFactor、softCap、mult（训练赛倍数等）与 opts.gainMult（AI 缩放）；
 * 教练存在时提升 talent/resilience（CONFIG.coach；连同年轻选手的天赋自然增长 × opts.attrMult，同一回合第 2 次起的训练传
 * CONFIG.training.extraSessionAttrMult）；年龄 ≥24 的选手天赋不因训练提升超过当前值+教练效果。
 * 人类玩家战队的战力 / 天梯收益记入选手的训练投入（bankTraining）。
 * 返回每名选手的变化（玩家战队用于 UI 报告）。
 */
export function trainTeam(state: GameState, teamId: string, focus: TrainingFocus, mult?: number, opts?: TrainOptions): TrainingGain[] {
  const team = ownEntry(state.teams, teamId);
  if (!team) return [];
  const players = teamPlayers(state, teamId);
  if (players.length === 0) return [];

  const rng = rngOf(state);
  const g = CONFIG.growth;
  const [fPower, fMmr, fInsight] = g.focus[focus] ?? g.focus.balanced;
  const m = mult !== undefined && Number.isFinite(mult) && mult > 0 ? mult : 1;
  const gm = opts?.gainMult;
  const mPower = positiveOr1(gm?.power);
  const mMmr = positiveOr1(gm?.mmr);
  const mInsight = positiveOr1(gm?.insight);
  const mAttr = positiveOr1(opts?.attrMult);
  const human = isHumanTeam(state, teamId);
  const starters = starterIdSet(state, teamId);
  const coach = getCoach(state, teamId);
  const talentAgeLimit = CONFIG.aging.talentDeclineStartAge;

  const gains: TrainingGain[] = [];
  for (const p of players) {
    const benchMult = starters.has(p.id) ? 1 : g.benchTrainingMult;
    const age = ageOf(state, p);
    const af = ageFactor(age, p.position);
    const tg = trendGrowthMult(p); // 隐藏趋势（form.ts）：爆发赛季成长更快，衰退期成长更慢
    const talent = effectiveAttr(p, 'talent');

    let dPower = 0;
    let dMmr = 0;
    let dInsight = 0;
    let dTalent = 0;
    let dRes = 0;

    if (fPower > 0) {
      const v = rollGain(rng, g.training.power, talent) * af * tg * fPower * m * mPower * benchMult * powerSoftCap(p.power);
      dPower = bump2(p, 'power', v);
    }
    if (fMmr > 0) {
      const v = rollGain(rng, g.training.mmr, talent) * af * tg * fMmr * m * mMmr * benchMult * mmrSoftCap(p.mmr);
      dMmr = bumpMmr(p, v);
    }
    if (fInsight > 0) {
      // 灵性随年龄提升，不受年龄成长系数压制
      const v = rollGain(rng, g.training.insight, talent) * fInsight * m * mInsight * benchMult * insightSoftCap(p.insight);
      dInsight = bump2(p, 'insight', v);
    }
    if (human && !p.tempSubUntilTournament && !p.isWildSub) bankTraining(p, dMmr, dPower);

    // 天赋：年轻选手训练自然增长；≥ talentDeclineStartAge 只能依靠教练
    // （同一休赛回合第 2 次起的训练 × opts.attrMult：天赋 / 韧性主要按每回合一次成长）
    let talentDelta = 0;
    if (age < talentAgeLimit) {
      const [lo, hi] = g.youngTalentGain;
      talentDelta += rng.range(lo, hi) * af * benchMult * mAttr * attrSoftCap(p.talent);
    }
    if (coach) {
      talentDelta += Math.max(0, coach.talentBoost) * CONFIG.coach.talentPerTraining * benchMult * mAttr * attrSoftCap(p.talent);
      const resDelta = Math.max(0, coach.resilienceBoost) * CONFIG.coach.resiliencePerTraining * benchMult * mAttr * attrSoftCap(p.resilience);
      dRes = bump2(p, 'resilience', resDelta);
    }
    dTalent = bump2(p, 'talent', talentDelta);

    gains.push({
      playerId: p.id,
      handle: p.handle,
      power: dPower,
      mmr: dMmr,
      insight: dInsight,
      talent: dTalent,
      resilience: dRes,
    });
  }
  return gains;
}

/**
 * 训练赛倍数：clamp(scrimMultBase + (目标评分-本队评分)/本队评分 × scrimK, scrimMultMin, scrimMultMax)。
 * 下限 > 1：约练实力不如自己的队伍也比普通训练收益高（花了钱）；对手越强越高（默认 ×1.25 ~ ×2.5，同等实力 ×1.5）。
 */
export function scrimMultiplier(state: GameState, teamId: string, targetTeamId: string): number {
  const t = CONFIG.training;
  const lo = Number.isFinite(t.scrimMultMin) ? t.scrimMultMin : 1;
  const hi = Math.max(lo, Number.isFinite(t.scrimMultMax) ? t.scrimMultMax : lo);
  const base = Number.isFinite(t.scrimMultBase) ? t.scrimMultBase : 1;
  const k = Number.isFinite(t.scrimK) ? t.scrimK : 0;
  const own = teamRating(state, teamId);
  const target = teamRating(state, targetTeamId);
  if (!(own > 0)) return target > 0 ? hi : clamp(base, lo, hi);
  return clamp(base + ((target - own) / own) * k, lo, hi);
}

/** 训练赛的灵性额外倍数（交流 BP，CONFIG.training.scrimInsightMult；非法值按 1） */
export function scrimInsightMult(): number {
  const v = CONFIG.training.scrimInsightMult;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * 人类玩家一次训练赛的 trainTeam 选项：在 sessionTrainOptions（消耗已购次数时天赋 / 韧性 × extraSessionAttrMult）之上，
 * 灵性收益另 × scrimInsightMult（双方交流 BP；与训练赛倍数相乘，对任何焦点都生效）。
 */
export function scrimTrainOptions(session: 'free' | 'extra' | null | undefined): TrainOptions {
  return { ...sessionTrainOptions(session), gainMult: { insight: scrimInsightMult() } };
}

// ---------------------------------------------------------------------------
// 赛事成长
// ---------------------------------------------------------------------------

/**
 * 赛事结算成长：参赛首发（含临时替补）按名次百分位 percentile(0=冠军) 与赛事等级获得成长，使用天赋随机公式；
 * seriesPlayed 越多收益越高（sqrt 缩放）。成长重平衡（2026-10-09）：比赛只带来少量 power/mmr/insight，主要提升**韧性**
 * （大赛压力：名次越靠前打得越久、赛事越大越多，TI 最多；CONFIG.growth.tournament.resilience*）。返回增长明细。
 */
export function applyTournamentGrowth(
  state: GameState,
  teamId: string,
  percentile: number,
  tier: TournamentTier,
  seriesPlayed: number,
): TournamentSettlement['playerGrowth'] {
  if (!ownEntry(state.teams, teamId) || !(seriesPlayed > 0)) return [];
  const tg = CONFIG.growth.tournament;
  const rng = rngOf(state);
  const pct = clamp(Number.isFinite(percentile) ? percentile : 1, 0, 1);
  const placeMult = lerp(tg.placeMultBest, tg.placeMultWorst, pct);
  const tierMult = tg.tierMult[tier] ?? 1;
  const [sfMin, sfMax] = tg.seriesFactorRange;
  const seriesFactor = clamp(Math.sqrt(seriesPlayed / Math.max(1, tg.seriesRef)), sfMin, sfMax);
  const scale = placeMult * tierMult * seriesFactor;
  const resScale = lerp(tg.resiliencePlaceBest, tg.resiliencePlaceWorst, pct) * (tg.resilienceTierMult[tier] ?? 1) * seriesFactor;

  const out: TournamentSettlement['playerGrowth'] = [];
  for (const { player: p } of lineupPlayers(state, teamId)) {
    if (!p) continue;
    const af = ageFactor(ageOf(state, p), p.position) * trendGrowthMult(p);
    const talent = effectiveAttr(p, 'talent');
    const vPower = rollGain(rng, tg.power, talent) * scale * af * powerSoftCap(p.power);
    const vMmr = rollGain(rng, tg.mmr, talent) * scale * af * mmrSoftCap(p.mmr);
    const vInsight = rollGain(rng, tg.insight, talent) * scale * insightSoftCap(p.insight);
    const vRes = rollGain(rng, tg.resilience, talent) * resScale * attrSoftCap(p.resilience);
    out.push({
      playerId: p.id,
      power: bump2(p, 'power', vPower),
      mmr: bumpMmr(p, vMmr),
      insight: bump2(p, 'insight', vInsight),
      resilience: bump2(p, 'resilience', vRes),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 年龄 & 退役
// ---------------------------------------------------------------------------

/** 本赛季到下赛季跨越的年数（TI9 → TI10 因 2020 停办为 2 年；至少 1） */
function yearsUntilNextSeason(state: GameState): number {
  const ti = state.season?.ti;
  const year = seasonYear(state);
  const nextYear = ti !== undefined ? TI_YEAR[ti + 1] : undefined;
  if (nextYear === undefined) return 1;
  return Math.max(1, nextYear - year);
}

/**
 * 巅峰后单赛季战力衰减的期望值（不含随机抖动与隐藏趋势）：y = 年龄 - 位置巅峰止，
 * base × y^exp（≤ max）；仍在巅峰窗口内或更年轻时为 0。
 */
export function expectedPowerDecline(age: number, pos: Position): number {
  const a = CONFIG.aging;
  const y = yearsPastPeak(age, pos);
  if (!(y > 0)) return 0;
  return Math.min(a.postPeakDeclineMax, a.postPeakDeclineBase * Math.pow(y, a.postPeakDeclineExp));
}

/** 巅峰后单赛季天梯分衰减的期望值：y' = 年龄 - 位置巅峰止 + lead（≥ 1 才衰减），perYear × y'（≤ max） */
export function expectedMmrDecline(age: number, pos: Position): number {
  const a = CONFIG.aging;
  const y = yearsPastPeak(age + a.mmrDeclineLead, pos);
  if (!(y > 0)) return 0;
  return Math.min(a.mmrDeclineMax, a.mmrDeclinePerYear * y);
}

/**
 * TI 结算时对所有 active 选手执行年龄效果（衰减战力/天梯/天赋，提升韧性/灵性）。年龄由 season.year 推进隐含 +1，此函数只处理属性变化。
 * 战力/天梯：按位置巅峰窗口（CONFIG.aging.peakWindow），过巅峰后逐季加速衰减，× 隐藏趋势倍数（form.trendDeclineMult）。
 * 同时清除新秀标记：新秀身份只持续登场的那一个赛季（下赛季的新秀由 rookieDraft.buildRookiePool 重新标记）。
 */
export function agePlayersAtSeasonEnd(state: GameState): void {
  const a = CONFIG.aging;
  const rng = rngOf(state);
  const years = yearsUntilNextSeason(state);
  for (const id in state.players) {
    const p = state.players[id];
    if (p.isRookie) delete p.isRookie;
    if (p.status !== 'active') continue;
    const baseAge = ageOf(state, p);
    const trendMult = trendDeclineMult(p);
    for (let k = 0; k < years; k++) {
      const age = baseAge + k; // 刚结束赛季的年龄（跨两年时第二年 +1）
      const dPower = expectedPowerDecline(age, p.position);
      if (dPower > 0) {
        bump2(p, 'power', -dPower * rng.range(a.postPeakDeclineJitter[0], a.postPeakDeclineJitter[1]) * trendMult);
      }
      const dMmr = expectedMmrDecline(age, p.position);
      if (dMmr > 0) {
        bumpMmr(p, -dMmr * rng.range(a.mmrDeclineJitter[0], a.mmrDeclineJitter[1]) * trendMult);
      }
      if (age >= a.talentDeclineStartAge) {
        bump2(p, 'talent', -rng.range(a.talentDecline[0], a.talentDecline[1]));
      }
      bump2(p, 'resilience', rng.range(a.resilienceGain[0], a.resilienceGain[1]));
      bump2(p, 'insight', rng.range(a.insightGain[0], a.insightGain[1]));
    }
  }
}

/** 退役后是否转为教练：真实选手、在队选手一律转；程序化自由选手只有高等级才转 */
function becomesCoach(p: Player, wasOnTeam: boolean): boolean {
  if (p.isReal || wasOnTeam) return true;
  return tierIndex(playerTier(p)) >= tierIndex(CONFIG.generation.retiredCoachMinTier);
}

/**
 * TI 结算退役：年龄 >25（按位置后移 CONFIG.aging.retireAgeShift，辅助更晚）的 active 选手按概率退役
 * （status='retired'，移出战队）；仍保持高战力的选手概率折减（retireStar*）。
 * 真实生涯保护（v0.4.2，CONFIG.aging.protectRealCareer，realCareer.retirementProtected）：真实阵容数据中还有晚于本届记录的
 * 真实选手不退役（不掷骰），最后一届真实数据之后照旧。
 * 每名退役选手按其天梯等级生成教练（generation.coachFromRetiredPlayer），返回列表。
 * 不处理玩家战队的"是否聘为教练"决策（由 season.ts 生成 PendingDecision）。
 * 退役选手的原战队记录在 player.lastTeamId。
 */
export function processRetirements(state: GameState): { retired: Player[]; newCoaches: Coach[] } {
  const a = CONFIG.aging;
  const rng = rngOf(state);
  const retired: Player[] = [];
  const newCoaches: Coach[] = [];
  const anchor = a.retireMinAge - 1; // 公式中的 (age - 25)
  for (const id in state.players) {
    const p = state.players[id];
    if (p.status !== 'active') continue;
    if (p.tempSubUntilTournament) continue; // 临时替补由赛事结束释放后再判定
    if (p.isWildSub) continue; // 野外替补候选是一次性程序化选手（未雇佣即删除），不参与退役/转教练
    const age = ageOf(state, p) - (a.retireAgeShift[p.position] ?? 0); // 辅助职业生涯更长
    if (age < a.retireMinAge) continue;
    if (retirementProtected(state, p)) continue; // 现实中的职业生涯仍在继续（之后的届次还有真实阵容数据）
    const tier = playerTier(p);
    const star = clamp(((Number.isFinite(p.power) ? p.power : 0) - a.retireStarFrom) / Math.max(1e-6, a.retireStarRange), 0, 1);
    const prob = Math.min(a.retireMax, a.retireBase * (age - anchor) + (a.retireLowTierBonus[tier] ?? 0))
      * lerp(1, a.retireStarMult, star);
    if (!rng.chance(prob)) continue;

    const wasOnTeam = !!p.teamId;
    if (p.teamId) removePlayerFromTeam(state, p.id);
    p.status = 'retired';
    delete p.transferListing; // 挂牌期跨赛季：挂牌中的选手退役时挂牌随之结束
    delete p.listingStaleMemo;
    p.modifiers = [];
    p.unavailableTournamentIds = undefined;
    retired.push(p);
    if (becomesCoach(p, wasOnTeam)) newCoaches.push(coachFromRetiredPlayer(state, p));
  }

  // 只为知名选手（真实/高等级/玩家旧部）发新闻，避免刷屏
  const playerTeamId = state.settings?.playerTeamId;
  const notable = retired.filter(
    (p) => p.isReal || p.lastTeamId === playerTeamId || isHumanTeam(state, p.lastTeamId) || tierIndex(playerTier(p)) >= tierIndex('S'),
  );
  if (notable.length > 0) {
    const shown = notable.slice(0, 8).map((p) => p.handle).join('、');
    const more = notable.length > 8 ? ` 等 ${notable.length} 人` : '';
    addNews(
      state,
      'season',
      `${notable.length} 名选手宣布退役`,
      `TI 结束后，${shown}${more}宣布结束职业生涯，部分退役选手已转型为教练。`,
    );
  }
  return { retired, newCoaches };
}

// ---------------------------------------------------------------------------
// 归属感
// ---------------------------------------------------------------------------

/** 修改归属感（夹在 0..100） */
export function adjustLoyalty(p: Player, delta: number): void {
  if (!p || !Number.isFinite(delta)) return;
  const cur = Number.isFinite(p.loyalty) ? p.loyalty : CONFIG.loyalty.freeAgentTarget;
  p.loyalty = round2(clamp(cur + delta, 0, CONFIG.player.maxAttr));
}

/**
 * 阵容超出常规上限（team.maxRoster）时，长期替补每回合额外的归属感变化（≤ 0）：
 * 每超出 1 人 × loyalty.overRosterBenchPerRound，最多按 overRosterBenchMaxExcess 人计。regular = 正式阵容人数（不含临时替补）。
 */
export function overRosterBenchPenalty(regular: number): number {
  const L = CONFIG.loyalty;
  const excess = Math.min(Math.max(0, Math.floor(L.overRosterBenchMaxExcess)), Math.max(0, Math.floor(regular) - CONFIG.team.maxRoster));
  return excess > 0 ? Math.min(0, L.overRosterBenchPerRound) * excess : 0;
}

/**
 * 每大回合结束：替补回合计数、荣誉落差、薪资预期等对归属感的影响（全部战队）。
 * 长期替补每回合 loyalty.benchPerRound；阵容超出常规上限时另加 overRosterBenchPenalty（每超出 1 人更快）。
 * - 人类玩家战队（多人模式为全部座位，中性上下文中也能识别）：多维环境模型 salary.loyaltyEnvironment ——
 *   (荣誉维度 + 薪资差维度 + 差距拉大惩罚) × 在队时长速度倍数（第一个赛季 ×0.5，之后每赛季翻倍，上限 CONFIG.salary.tenure.cap）；
 *   并记录本回合薪资差（下回合判断差距是否拉大）。
 * - AI 战队：简化版，沿用固定的荣誉落差扣分（loyalty.honorGapPenalty）。
 * - 全部 active 选手：更新近期荣誉热度（冠军 / MVP）与新秀合同标记（salary.updateSalaryTrack）。
 * 替补、胜负、冠军、谈心、团建等原有因素不变。
 */
export function roundLoyaltyUpdate(state: GameState): void {
  const L = CONFIG.loyalty;
  const expectation = CONFIG.market.tierHonorExpectation;

  // 先收集全部首发 id（O(战队数)）与各队正式阵容人数（超出常规上限时替补归属感下降更快）
  const starters = new Set<string>();
  const regularCount = new Map<string, number>();
  for (const tid in state.teams) {
    const t = state.teams[tid];
    let n = 0;
    for (const id of t.playerIds ?? []) {
      const q = state.players[id];
      if (q && q.status === 'active' && q.teamId === tid && !q.tempSubUntilTournament) n++;
    }
    regularCount.set(tid, n);
    if (!t.lineup) continue;
    for (const pos of POSITIONS) {
      const id = t.lineup[pos];
      if (id) starters.add(id);
    }
  }

  for (const id in state.players) {
    const p = state.players[id];
    if (p.status !== 'active') continue;
    const team = p.teamId ? state.teams[p.teamId] : undefined;

    if (!team || team.disbanded) {
      // 自由选手（或战队已解散/数据缺失）：归属感缓慢回归中性值
      const cur = Number.isFinite(p.loyalty) ? p.loyalty : L.freeAgentTarget;
      adjustLoyalty(p, (L.freeAgentTarget - cur) * L.freeAgentRegression);
      p.benchRounds = 0;
      updateSalaryTrack(state, p);
      continue;
    }
    if (p.tempSubUntilTournament) continue; // 临时替补不计

    // 替补回合
    if (starters.has(p.id)) {
      p.benchRounds = 0;
    } else {
      p.benchRounds = (p.benchRounds ?? 0) + 1;
      if (p.benchRounds > L.benchGraceRounds) adjustLoyalty(p, L.benchPerRound + overRosterBenchPenalty(regularCount.get(team.id) ?? 0));
    }

    if (isHumanTeam(state, team.id) && !p.isWildSub) {
      // 人类玩家战队：荣誉 / 薪资预期 × 在队时长速度倍数（salary.ts）
      const env = loyaltyEnvironment(state, p, team);
      if (env.total) adjustLoyalty(p, env.total);
      recordSalaryGap(p, env.gap, team.id);
    } else {
      // AI 战队（简化版）：俱乐部荣誉显著低于选手身价期待
      const exp = expectation[playerTier(p)] ?? 0;
      if (exp > 0 && team.honor < exp * L.honorGapRatio) adjustLoyalty(p, L.honorGapPenalty);
      // 奖金分成环境项（第九波，人机共用；人类玩家战队已计入 loyaltyEnvironment.total）
      const ps = prizeShareLoyaltyDelta(team.prizeShare);
      if (ps) adjustLoyalty(p, ps);
    }
    updateSalaryTrack(state, p);
  }
}
