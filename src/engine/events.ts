// 随机事件【E4 负责实现】
import type { EventChoice, EventKind, GameState, OpResult, PendingDecision, Player, Position, Team } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, type Rng } from './rng';
import { addNews, pushPopup } from './news';
import { clamp, formatGold, nextId, ownEntry } from './util';
import { addModifier, effectiveAttr, eventImpactScale, marketValue, overallRating, playerTier, tierIndex } from './player';
import { activeTeams, autoLineup, getCoach, rankTeamsByRating, teamPlayers, validateLineup } from './team';
import { changeHonor, honorLuck } from './honor';
import { adjustLoyalty } from './growth';
import { addFinance, econ } from './economy';
import {
  createTransferOffer, departToFreeAgency, fillRosterFromMarket, generateTempSubCandidatesFor, isTransferWindowOpen,
  pickOfferBuyer, playerTeamOrNull, refreshContractDecisions, renewContract, respondToOffer, roundFee,
} from './market';
import { rollFunEvents, resolveFunDecision } from './funEvents';
import { inSeatOf, removePendingDecisionsEverywhere } from './seat';
import { syncSynergies } from './synergy';
import { resolveHomeRookieDecision } from './gacha';
import { resaleLocked } from './listingRules';
import {
  onRookieContract, salaryGap, salaryMoodLevel, salaryMoodOf, unhappyStarPoachChance,
} from './salary';

type Ctx = PendingDecision['ctx'];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 难度倍数：负面事件概率 × d，正面事件概率 ÷ d */
function difficulty(state: GameState): number {
  const d = CONFIG.events.difficultyMult[state.settings?.difficulty ?? 'normal'];
  return d && d > 0 ? d : 1;
}

/**
 * 当前是否为 TI 预选 / TI 正赛回合（第九波 #4：玩家战队负面事件大幅降频、禁赛类结果为 0）。
 * 以 state.phase 为准（enterRound 在滚动事件前设置）；缺失时按当前回合表推断。
 */
export function isTiEventRound(state: GameState): boolean {
  const phase = state.phase ?? state.season?.rounds?.[state.roundIndex]?.phase;
  return phase === 'ti_qualifier' || phase === 'ti';
}

/**
 * 人类战队（单机玩家 / 多人每个座位）负面事件的概率倍数：CONFIG.humanEvents.negativeMult，
 * TI 预选与 TI 正赛回合再 × tiNegativeMult。AI 战队不使用此倍数。
 */
export function humanNegativeEventMult(state: GameState): number {
  const h = CONFIG.humanEvents;
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 1);
  return pos(h?.negativeMult) * (isTiEventRound(state) ? pos(h?.tiNegativeMult) : 1);
}

/**
 * 人类战队此刻是否可能出现禁赛 / 缺阵类结果（个人假赛永久禁赛、全员假赛、签证被拒无法出战）：
 * TI 预选与 TI 正赛回合一律不可能（用户要求「禁赛等结果的事件降到 0」）
 */
export function humanBanAllowed(state: GameState): boolean {
  return !isTiEventRound(state);
}

function rangeOf(rng: Rng, r: readonly [number, number]): number {
  const lo = Math.min(r[0], r[1]);
  const hi = Math.max(r[0], r[1]);
  return rng.range(lo, hi);
}

function intOf(rng: Rng, r: readonly [number, number]): number {
  return rng.int(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function pushDecision(
  state: GameState,
  d: { kind: EventKind; title: string; body: string; choices: EventChoice[]; ctx: Ctx; blocking?: boolean },
): PendingDecision {
  const decision: PendingDecision = {
    id: nextId(state, 'd'),
    kind: d.kind,
    title: d.title,
    body: d.body,
    choices: d.choices,
    ctx: d.ctx,
    createdRound: state.roundIndex,
    blocking: d.blocking ?? true,
  };
  state.pendingDecisions.push(decision);
  return decision;
}

function hasPending(state: GameState, kind: EventKind, playerId?: string): boolean {
  return state.pendingDecisions.some((d) => d.kind === kind && (playerId === undefined || d.ctx?.playerId === playerId));
}

function hasPendingForPlayer(state: GameState, playerId: string): boolean {
  return state.pendingDecisions.some((d) => d.ctx?.playerId === playerId);
}

function ctxStr(ctx: Ctx, key: string): string | null {
  const v = ctx?.[key];
  return typeof v === 'string' && v ? v : null;
}

function ctxNum(ctx: Ctx, key: string, fallback = 0): number {
  const v = ctx?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** 正式队员（不含临时替补/野外替补） */
function rosterOf(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament && !p.isWildSub);
}

/** 永久禁赛：移出战队；AI 战队自动补员 */
function banPlayer(state: GameState, p: Player): void {
  const teamId = p.teamId;
  p.status = 'banned';
  if (teamId) {
    departToFreeAgency(state, p.id);
    const team = ownEntry(state.teams, teamId);
    if (team && !team.isPlayer && !team.disbanded) fillRosterFromMarket(state, teamId);
  }
  // 多人模式：涉事选手的离队/挖角/续约决策可能在其他座位
  removePendingDecisionsEverywhere(
    state,
    (d) => d.ctx?.playerId === p.id && (d.kind === 'leave_request' || d.kind === 'poach' || d.kind === 'contract'),
  );
}

/** 假赛风波冷却：同一战队在 CONFIG.events.matchFixingCooldownSeasons 个赛季内（含本赛季）发生过则不再触发 */
function matchFixingOnCooldown(state: GameState, team: Team): boolean {
  const last = team.lastMatchFixingSeason;
  const cd = Math.max(0, Math.floor(CONFIG.events.matchFixingCooldownSeasons ?? 0));
  if (last === undefined || !Number.isFinite(last) || cd <= 0) return false;
  return (state.season?.ti ?? 0) - last < cd;
}

/** 联盟明星：在队正式选手中综合评分前 matchFixingStarTop 名（只在假赛事件触发时计算） */
function leagueStarIds(state: GameState): Set<string> {
  const top = Math.max(0, Math.floor(CONFIG.events.matchFixingStarTop ?? 0));
  if (!top) return new Set();
  const list: Player[] = [];
  for (const id in state.players) {
    const p = state.players[id];
    if (p.status === 'active' && p.teamId && !p.tempSubUntilTournament && !p.isWildSub) list.push(p);
  }
  list.sort((a, b) => overallRating(b) - overallRating(a));
  return new Set(list.slice(0, top).map((p) => p.id));
}

/**
 * 涉事选手抽取权重：低归属感、低工资者嫌疑更大；真实选手 × matchFixingRealMult、联盟明星（评分前 N 或等级 ≥ SS）
 * × matchFixingStarMult——真实明星极少卷入（第六波：避免真实明星被大量永久禁赛）
 */
function matchFixingWeights(state: GameState, roster: Player[]): number[] {
  const ev = CONFIG.events;
  const avgSalary = roster.reduce((s, p) => s + Math.max(1, Number.isFinite(p.salary) ? p.salary : 1), 0) / Math.max(1, roster.length);
  const stars = leagueStarIds(state);
  const ssIdx = tierIndex('SS');
  return roster.map((p) => {
    const salary = Math.max(1, Number.isFinite(p.salary) ? p.salary : 1);
    let w = Math.max(1, 101 - effectiveAttr(p, 'loyalty')) * Math.sqrt(avgSalary / salary);
    if (p.isReal) w *= ev.matchFixingRealMult ?? 1;
    if (stars.has(p.id) || tierIndex(playerTier(p)) >= ssIdx) w *= ev.matchFixingStarMult ?? 1;
    return Number.isFinite(w) && w > 0 ? w : 1e-6;
  });
}

/**
 * 假赛扣分的荣誉缓冲：|扣分| ≤ max(honor.lossCushionFloor, 当前荣誉) × matchFixingMaxHonorShare × mult。
 * 小俱乐部不会因一次假赛风波直接解散；荣誉高的俱乐部仍按原值扣分。
 */
function cushionedFixingLoss(state: GameState, teamId: string, loss: number, mult = 1): number {
  if (!(loss < 0)) return loss;
  const team = ownEntry(state.teams, teamId);
  const share = CONFIG.events.matchFixingMaxHonorShare;
  if (!team || !(share > 0)) return loss;
  const base = Math.max(CONFIG.honor.lossCushionFloor, Number.isFinite(team.honor) ? team.honor : 0);
  return -Math.min(-loss, Math.max(1, Math.round(base * share * mult)));
}

/** 临时战力修正（mul），幅度按韧性缩放；返回实际百分比 */
function powerModifier(state: GameState, p: Player, source: string, magnitude: number, rounds: number | null, sign: 1 | -1): number {
  const x = Math.max(0, magnitude) * eventImpactScale(p);
  addModifier(state, p, { source, attr: 'power', kind: 'mul', value: round3(1 + sign * x), roundsLeft: rounds });
  return x;
}

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

// 事件描述均为中性陈述（搞笑/梗类内容只来自用户维护的 funEvents.ts 事件表）
const HEARTBREAK_TEXTS = [
  (h: string) => `${h} 近期个人生活出现变故，训练时注意力难以集中。`,
  (h: string) => `据悉 ${h} 近来情绪低落，排位赛表现明显下滑。`,
  (h: string) => `${h} 近期状态不佳，队友反映他在训练中频频走神。`,
];
const HOT_TEXTS = [
  (h: string) => `${h} 近期手感火热，天梯排位连胜不断。`,
  (h: string) => `${h} 在训练赛中表现出色，多项数据位居全队第一。`,
  (h: string) => `${h} 状态正佳，对线与团战处理都更加稳定。`,
];
const INJURY_TEXTS = [
  (h: string) => `${h} 长期高强度训练导致腱鞘炎复发，队医建议减少训练量。`,
  (h: string) => `${h} 手腕扭伤，需要一段时间休养恢复。`,
  (h: string) => `${h} 颈椎旧伤加重，每天能坚持的训练时长受限。`,
];
const SCANDAL_TEXTS = [
  (h: string) => `${h} 在直播中发表不当言论，相关截图在网络上广泛传播。`,
  (h: string) => `${h} 被曝在路人局中消极比赛并辱骂队友，录像在社区引发热议。`,
  (h: string) => `${h} 深夜发表不当言论引发争议，赞助商紧急致电俱乐部。`,
];
const BEEF_TEXTS = [
  (h: string, t: string) => `赛后采访中 ${h} 对 ${t} 的评价引发争议，两队粉丝在社交媒体上针锋相对。`,
  (h: string, t: string) => `${t} 的选手在直播中公开批评 ${h} 的比赛表现，${h} 随即回应：赛场上见。`,
  (h: string, t: string) => `${t} 临时取消了约好的训练赛，${h} 公开表达不满，双方关系急转直下。`,
];

// ---------------------------------------------------------------------------
// 回合事件
// ---------------------------------------------------------------------------

/**
 * 每个大回合开始时调用（版本更新之后）：按 CONFIG.events 概率（× difficultyMult）滚动玩家战队事件，
 * AI 战队只滚动简化版（假赛/丑闻/情感受挫）并发新闻。
 * 需求事件：假赛风波、情感受挫、签证问题（见 checkVisaForTournament）、丑闻、战队 beef、俱乐部欠薪（见 triggerUnpaidSalary）；
 * 其他：状态火热、赞助商注资、直播合约、伤病、粉丝见面会、低归属感离队申请（processLoyaltyDepartures）。
 * 带选项的事件写入 pendingDecisions（blocking=true），其余直接生效并写新闻。
 * 无阶段限制：赛季初（回合 0）、休赛/赛事回合、TI 预选与 TI 回合开始时都应调用；
 * 每次调用都会滚动无厘头事件（funEvents.rollFunEvents，内部自行处理 gameOver 与触发概率）。
 * 第九波 #4：玩家战队的负面事件概率再 × humanNegativeEventMult（整体降频，TI 预选 / 正赛回合大幅降低），
 * TI 预选 / 正赛回合不会出现禁赛类结果（假赛风波概率为 0，到期的调查结果公开顺延到 TI 之后）；AI 战队不变。
 */
export function rollRoundEvents(state: GameState): void {
  if (!state.gameOver) processDelayedEvents(state);
  if (!state.gameOver) {
    const rng = rngOf(state);
    const team = playerTeamOrNull(state);
    if (team) rollPlayerTeamEvents(state, team, rng);
    if (!state.gameOver) rollAiTeamEvents(state, rng);
  }
  rollFunEvents(state);
}

/**
 * 多人模式（multi.ts / season.ts）：回合事件的全局部分，每回合只执行一次 —— 到期延迟事件、AI 战队事件。
 * 玩家部分见 rollSeatRoundEvents（对每个座位在其上下文中执行）。单机仍使用 rollRoundEvents。
 */
export function rollGlobalRoundEvents(state: GameState): void {
  if (state.gameOver) return;
  processDelayedEvents(state);
  if (!state.gameOver) rollAiTeamEvents(state, rngOf(state));
}

/** 多人模式：当前座位（settings.playerTeamId）的回合事件 + 无厘头事件 */
export function rollSeatRoundEvents(state: GameState): void {
  if (state.gameOver) return;
  const team = playerTeamOrNull(state);
  if (!team) return;
  rollPlayerTeamEvents(state, team, rngOf(state));
  if (!state.gameOver && !team.disbanded) rollFunEvents(state);
}

function rollPlayerTeamEvents(state: GameState, team: Team, rng: Rng): void {
  const ev = CONFIG.events;
  const d = difficulty(state);
  // 负面事件：难度倍数 × 人类战队降频倍数（第九波 #4；TI 预选 / 正赛回合大幅降低）；正面事件不变
  const neg = d * humanNegativeEventMult(state);
  const roster = rosterOf(state, team.id);

  // 假赛风波：低归属感、低工资者嫌疑更大（真实明星极少卷入；同队冷却 matchFixingCooldownSeasons 个赛季）
  // TI 预选与 TI 正赛回合概率为 0（禁赛类结果，用户要求）；照常掷骰以保持随机序列一致
  if (roster.length && !hasPending(state, 'match_fixing') && !matchFixingOnCooldown(state, team)
    && rng.chance(humanBanAllowed(state) ? ev.matchFixingPerTeam * neg : 0)) {
    createMatchFixingDecision(state, team, rng.weighted(roster, matchFixingWeights(state, roster)));
  }

  for (const p of roster) {
    // 情感受挫
    if (rng.chance(ev.heartbreakPerPlayer * neg)) {
      const rounds = intOf(rng, ev.heartbreakRounds);
      const x = powerModifier(state, p, '情感受挫', rangeOf(rng, ev.heartbreakPower), rounds, -1);
      addNews(state, 'event', `【情感受挫】${p.handle} 状态低迷`, `${rng.pick(HEARTBREAK_TEXTS)(p.handle)}\n战斗力 -${pct(x)}，持续 ${rounds} 回合。`, true);
    }
    // 伤病
    if (rng.chance(ev.injuryPerPlayer * neg)) {
      const rounds = intOf(rng, ev.injuryRounds);
      const x = powerModifier(state, p, '伤病', rangeOf(rng, ev.injuryPower), rounds, -1);
      addNews(state, 'event', `【伤病】${p.handle} 带伤作战`, `${rng.pick(INJURY_TEXTS)(p.handle)}\n战斗力 -${pct(x)}，持续 ${rounds} 回合。`, true);
    }
    // 状态火热（正面）
    if (rng.chance(ev.hotStreakPerPlayer / d)) {
      const rounds = intOf(rng, ev.hotStreakRounds);
      const x = powerModifier(state, p, '状态火热', rangeOf(rng, ev.hotStreakPower), rounds, 1);
      addNews(state, 'event', `【状态火热】${p.handle} 状态出色`, `${rng.pick(HOT_TEXTS)(p.handle)}\n战斗力 +${pct(x)}，持续 ${rounds} 回合。`);
    }
  }

  // 丑闻
  if (roster.length && !hasPending(state, 'scandal') && rng.chance(ev.scandalPerTeam * neg)) {
    createScandalDecision(state, team, rng.pick(roster), rng);
  }

  // 战队 beef
  if (rng.chance(ev.beefPerRound * neg)) startBeef(state, team, rng);

  // 赞助商注资（正面）
  if (rng.chance(ev.sponsorPerRound / d)) {
    const amount = roundFee(Math.max(0, team.honor) * ev.sponsorGoldPerHonor * econ(state));
    if (amount > 0) {
      addFinance(state, team.id, amount, 'event', '赞助商注资');
      addNews(state, 'finance', `【赞助】新赞助商注资 ${formatGold(amount)}`, `某外设品牌看中了 ${team.name} 的人气（荣誉 ${Math.round(team.honor)}），签下赞助合同，首付款 ${formatGold(amount)} 已到账。`, true);
    }
  }

  // 直播合约（正面）
  if (roster.length && rng.chance(ev.streamDealPerRound / d)) {
    const star = roster.reduce((b, p) => (effectiveAttr(p, 'mmr') > effectiveAttr(b, 'mmr') ? p : b), roster[0]);
    const amount = roundFee(rangeOf(rng, ev.streamDealGold) * econ(state));
    addFinance(state, team.id, amount, 'event', `直播合约（${star.handle}）`);
    adjustLoyalty(star, ev.streamDealLoyalty);
    addNews(state, 'finance', `【直播合约】${star.handle} 签约直播平台`, `${star.handle} 与直播平台签下独家直播合约，俱乐部分成 ${formatGold(amount)}。${star.handle} 归属感 +${ev.streamDealLoyalty}。`);
  }

  // 粉丝见面会（正面）
  if (roster.length && rng.chance(ev.fanMeetingPerRound / d)) {
    const honor = intOf(rng, ev.fanMeetingHonor);
    for (const p of roster) adjustLoyalty(p, ev.fanMeetingLoyalty);
    changeHonor(state, team.id, honor, '粉丝见面会');
    addNews(state, 'event', `【粉丝见面会】${team.name} 举办线下见面会`, `线下粉丝见面会顺利举行，选手与到场粉丝合影签名。荣誉 +${honor}，全员归属感 +${ev.fanMeetingLoyalty}。`);
  }
}

function rollAiTeamEvents(state: GameState, rng: Rng): void {
  const ev = CONFIG.events;
  let stars: Set<string> | undefined;
  for (const team of activeTeams(state)) {
    if (team.isPlayer) continue;
    const roster = rosterOf(state, team.id);
    if (!roster.length) continue;

    if (!matchFixingOnCooldown(state, team) && rng.chance(ev.aiMatchFixingPerTeam ?? ev.matchFixingPerTeam)) {
      const p = rng.weighted(roster, matchFixingWeights(state, roster));
      team.lastMatchFixingSeason = state.season?.ti ?? 0;
      banPlayer(state, p);
      changeHonor(state, team.id, ev.matchFixingHonor, `假赛风波（${p.handle} 禁赛）`);
      addNews(state, 'event', `【假赛风波】${team.name} 选手 ${p.handle} 被永久禁赛`, `联盟调查认定 ${p.handle} 参与操纵比赛，处以永久禁赛。${team.name} 荣誉 ${ev.matchFixingHonor}，空缺将从自由市场补充。`, true);
      continue;
    }

    if (rng.chance(ev.scandalPerTeam)) {
      const p = rng.pick(roster);
      const honor = Math.round(rangeOf(rng, ev.scandalHonor));
      changeHonor(state, team.id, honor, `丑闻（${p.handle}）`);
      adjustLoyalty(p, ev.scandalLoyalty);
      powerModifier(state, p, '丑闻缠身', rangeOf(rng, ev.scandalPower), intOf(rng, ev.scandalRounds), -1);
      addNews(state, 'event', `【丑闻】${team.name} 的 ${p.handle} 陷入舆论风波`, rng.pick(SCANDAL_TEXTS)(p.handle));
    }

    for (const p of roster) {
      if (!rng.chance(ev.heartbreakPerPlayer)) continue;
      powerModifier(state, p, '情感受挫', rangeOf(rng, ev.heartbreakPower), intOf(rng, ev.heartbreakRounds), -1);
      // 八卦新闻只报道知名选手（真实选手且为联盟明星），避免每赛季几十条八卦刷屏（修正对所有选手生效）
      stars ??= leagueStarIds(state);
      if (p.isReal && stars.has(p.id)) {
        addNews(state, 'event', `【八卦】${team.name} 的 ${p.handle} 状态受私人事务影响`, rng.pick(HEARTBREAK_TEXTS)(p.handle));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 假赛 / 丑闻 / beef
// ---------------------------------------------------------------------------

function createMatchFixingDecision(state: GameState, team: Team, p: Player): void {
  const ev = CONFIG.events;
  team.lastMatchFixingSeason = state.season?.ti ?? 0;
  const honorCooperate = cushionedFixingLoss(state, team.id, ev.matchFixingHonorCooperate);
  const honorLeak = cushionedFixingLoss(state, team.id, ev.matchFixingHonor * 2, 2);
  pushDecision(state, {
    kind: 'match_fixing',
    title: `【假赛风波】${p.handle} 涉嫌打假赛`,
    body:
      `有证据显示 ${p.handle} 可能在近期比赛中故意输掉对局，联盟已介入调查。\n` +
      `· 配合调查：${p.handle} 将被永久禁赛，俱乐部荣誉 ${honorCooperate}。\n` +
      `· 冷处理：暂不表态，但有 ${pct(ev.matchFixingLeakChance)} 概率日后调查结果公开（荣誉约 ${honorLeak}，选手仍会被禁赛），${p.handle} 的归属感也会下降。`,
    choices: [
      { id: 'cooperate', label: '配合调查', description: `选手禁赛，荣誉 ${honorCooperate}` },
      { id: 'cover_up', label: '冷处理', description: '有风险：日后可能扣除更多荣誉' },
    ],
    ctx: { playerId: p.id, teamId: team.id, honorCooperate },
  });
  addNews(state, 'event', `【假赛风波】${p.handle} 涉嫌操纵比赛`, `联盟已介入调查，请在消息中心决定俱乐部的应对方式。`, true);
}

function createScandalDecision(state: GameState, team: Team, p: Player, rng: Rng): void {
  const ev = CONFIG.events;
  const honor = Math.round(rangeOf(rng, ev.scandalHonor));
  const x = powerModifier(state, p, '丑闻缠身', rangeOf(rng, ev.scandalPower), intOf(rng, ev.scandalRounds), -1);
  adjustLoyalty(p, ev.scandalLoyalty * eventImpactScale(p));
  const prCost = roundFee(ev.scandalPrCost * econ(state));
  const prHonor = Math.round(honor * ev.scandalPrHonorMult);
  const text = rng.pick(SCANDAL_TEXTS)(p.handle);
  pushDecision(state, {
    kind: 'scandal',
    title: `【丑闻】${p.handle} 陷入舆论风波`,
    body: `${text}\n${p.handle} 状态受影响（战斗力 -${pct(x)}），归属感下降。\n· 低调处理：不花钱，荣誉 ${honor}。\n· 公关处理：花费 ${formatGold(prCost)}，荣誉 ${prHonor}。`,
    choices: [
      { id: 'ignore', label: '低调处理', description: `荣誉 ${honor}` },
      { id: 'pr', label: '公关处理', description: `花费 ${formatGold(prCost)}，荣誉 ${prHonor}` },
    ],
    ctx: { playerId: p.id, teamId: team.id, honor, prCost, prHonor },
  });
  addNews(state, 'event', `【丑闻】${p.handle} 陷入舆论风波`, text, true);
}

function startBeef(state: GameState, team: Team, rng: Rng): void {
  const ev = CONFIG.events;
  const ti = state.season?.ti ?? 0;
  const current = state.beefs.filter((b) => b.season === ti);
  if (current.length >= ev.beefMaxPerSeason) return;
  const taken = new Set(current.map((b) => b.teamId));
  const ranked = rankTeamsByRating(state).filter((id) => {
    const t = state.teams[id];
    return t && !t.disbanded && (id === team.id || !t.isPlayer);
  });
  const me = ranked.indexOf(team.id);
  let cands = ranked.filter(
    (id, i) => id !== team.id && !taken.has(id) && (me < 0 || Math.abs(i - me) <= ev.beefRankWindow),
  );
  if (!cands.length) cands = ranked.filter((id) => id !== team.id && !taken.has(id));
  if (!cands.length) return;
  const rival = state.teams[rng.pick(cands)];
  state.beefs.push({ teamId: rival.id, season: ti, winHonor: CONFIG.honor.beefWin, loseHonor: CONFIG.honor.beefLose });
  const roster = rosterOf(state, team.id);
  const who = roster.length ? rng.pick(roster).handle : team.name;
  addNews(
    state,
    'event',
    `【战队 beef】${team.name} 与 ${rival.name} 结下梁子`,
    `${rng.pick(BEEF_TEXTS)(who, rival.name)}\n本赛季与 ${rival.name} 交手：每胜一场系列赛荣誉 +${CONFIG.honor.beefWin}，每负一场 ${CONFIG.honor.beefLose}。`,
    true,
  );
}

/**
 * 到期的延迟事件（假赛东窗事发等）。
 * 「假赛调查结果公开」会永久禁赛玩家战队选手：TI 预选与 TI 正赛回合不曝光，顺延到 TI 之后（下赛季首个回合）。
 */
function processDelayedEvents(state: GameState): void {
  const list = state.delayedEvents;
  if (!list?.length) return;
  const ti = state.season?.ti ?? 0;
  const banFree = !humanBanAllowed(state);
  const remaining = [];
  for (const de of list) {
    const due = de.season < ti || (de.season === ti && state.roundIndex >= de.round);
    if (!due || (banFree && de.kind === 'match_fixing')) {
      remaining.push(de);
      continue;
    }
    if (de.kind === 'match_fixing') {
      const teamId = ctxStr(de.ctx, 'teamId') ?? state.settings.playerTeamId;
      // 多人模式：在涉事战队所属座位的上下文中处理（新闻归属、荣誉曲线）
      inSeatOf(state, teamId, () => {
        const p = state.players[ctxStr(de.ctx, 'playerId') ?? ''];
        const handle = p?.handle ?? ctxStr(de.ctx, 'handle') ?? '涉事选手';
        if (p && p.status === 'active') banPlayer(state, p);
        const loss = cushionedFixingLoss(state, teamId, CONFIG.events.matchFixingHonor * 2, 2);
        if (ownEntry(state.teams, teamId)) changeHonor(state, teamId, loss, `假赛调查结果公开（${handle}）`);
        addNews(state, 'event', `【假赛风波】${handle} 假赛调查结果公开`, `联盟公布调查结果，${handle} 被永久禁赛；俱乐部此前未配合调查，荣誉 ${loss}。`, true);
      });
      if (state.gameOver) break;
    }
  }
  state.delayedEvents = remaining;
}

// ---------------------------------------------------------------------------
// 欠薪 / 签证 / 离队
// ---------------------------------------------------------------------------

/** 欠薪：荣誉 unpaidHonor、全员归属感 unpaidSalary，归属感低于阈值者可能直接离队；写新闻（important） */
export function triggerUnpaidSalary(state: GameState): void {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return;
  const ev = CONFIG.events;
  const rng = rngOf(state);
  changeHonor(state, team.id, ev.unpaidHonor, '俱乐部欠薪');
  const roster = rosterOf(state, team.id);
  for (const p of roster) adjustLoyalty(p, CONFIG.loyalty.unpaidSalary);
  const leavers: Player[] = [];
  if (!state.gameOver) {
    for (const p of roster) {
      if (effectiveAttr(p, 'loyalty') < CONFIG.loyalty.leaveThreshold && rng.chance(ev.unpaidLeaveChance)) {
        departToFreeAgency(state, p.id);
        leavers.push(p);
      }
    }
  }
  const leaveText = leavers.length ? `\n${leavers.map((p) => p.handle).join('、')} 因欠薪离队。` : '';
  // 奖金分成已在下限（默认 50%）时不再建议下调
  const share = typeof team.prizeShare === 'number' && Number.isFinite(team.prizeShare) ? team.prizeShare : CONFIG.prizeShare.initial;
  const canCut = share > CONFIG.prizeShare.min + 1e-9;
  const body =
    `账上资金 ${formatGold(team.gold)}，工资无法足额发放，选手对欠薪表达不满。\n` +
    `荣誉 ${ev.unpaidHonor}，全员归属感 ${CONFIG.loyalty.unpaidSalary}。${leaveText}\n建议尽快挂牌出售选手回笼资金，或${canCut ? '下调奖金分成、' : ''}削减开支（解约需支付补偿，短期内会加重负债）。`;
  addNews(state, 'finance', '【俱乐部欠薪】工资无法足额发放', body, true);
  const existing = state.pendingDecisions.find((d) => d.kind === 'unpaid_salary');
  if (existing) {
    existing.body = body;
    existing.createdRound = state.roundIndex;
  } else {
    pushDecision(state, {
      kind: 'unpaid_salary',
      title: '【俱乐部欠薪】',
      body,
      choices: [{ id: 'ack', label: '知道了' }],
      ctx: {},
      blocking: false,
    });
  }
}

/**
 * 玩家赛事开赛前（进入赛事回合时）检查签证：赛事 hostRegion==='NA' 且非线上 → 高风险选手按 visaPerPlayerNA 判定，
 * 其他线下赛按 visaPerPlayerOther；命中者加入 unavailableTournamentIds，生成 PendingDecision（visa），
 * 选项：从野外找替补（market.generateTempSubCandidates 后由 UI 雇佣）/ 用现有替补顶上。
 */
export function checkVisaForTournament(state: GameState, tournamentId: string): void {
  const t = state.tournaments[tournamentId];
  const team = playerTeamOrNull(state);
  if (!t || !team || t.online || state.gameOver) return;
  const ev = CONFIG.events;
  // 难度倍数 × 人类战队负面事件降频倍数（第九波 #4；TI 预选 / 正赛回合大幅降低）。
  // 签证被拒 = 选手无法出战该赛事，与禁赛同属「缺阵类」结果：TI 预选 / 正赛回合为 0（用户要求「禁赛等结果降到 0」；照常掷骰保持随机序列）
  const neg = difficulty(state) * humanNegativeEventMult(state) * (humanBanAllowed(state) ? 1 : 0);
  // 战队就在赛事举办地所在赛区：队员（含外籍队员）已在当地常驻、持有工作签证 / 居留，主场作战无签证风险
  if (team.region === t.hostRegion) return;
  const rng = rngOf(state);
  const hits: Player[] = [];
  for (const p of rosterOf(state, team.id)) {
    if (p.unavailableTournamentIds?.includes(t.id)) continue;
    const risky = ev.visaRiskRegions.includes(p.region);
    let chance = 0;
    if (t.hostRegion === 'NA') {
      if (risky) chance = ev.visaPerPlayerNA;
      else if (p.region !== 'NA') chance = ev.visaPerPlayerOther;
    } else if (p.region !== t.hostRegion) {
      chance = ev.visaPerPlayerOther * (risky ? 1 : ev.visaNonRiskMult);
    }
    if (chance > 0 && rng.chance(clamp(chance * neg, 0, 1))) hits.push(p);
  }
  if (!hits.length) return;
  for (const p of hits) p.unavailableTournamentIds = [...(p.unavailableTournamentIds ?? []), t.id];
  autoLineup(state, team.id, t.id);
  const lineupOk = validateLineup(state, team.id, t.id).length === 0;
  const names = hits.map((p) => p.handle).join('、');
  const body =
    `${names} 的签证申请被拒，无法前往 ${t.city} 参加「${t.name}」。` +
    (lineupOk ? '现有替补可以顶上，也可以招募临时替补。' : '现有替补凑不齐五人：开赛前需招募临时替补，否则首发不足 5 人的系列赛将弃权判负。');
  pushDecision(state, {
    kind: 'visa',
    title: `【签证问题】${names} 无法出征 ${t.city}`,
    body,
    choices: [
      { id: 'temp_sub', label: '去野外找替补', description: '生成候选，在 转会市场 → 临时替补 中雇佣' },
      { id: 'bench', label: '用现有替补顶上' },
    ],
    ctx: { tournamentId: t.id, playerIds: hits.map((p) => p.id).join(','), position: hits[0].position },
  });
  addNews(state, 'event', `【签证问题】${names} 签证被拒`, body, true);
}

/**
 * 每回合开始（当前座位的玩家战队）：
 * - 按当前行情刷新待处理的合同到期决策（market.refreshContractDecisions）；
 * - 薪资不满公开新闻（reportSalaryDiscontent，不受转会窗口限制）；
 * - 转会窗口开放时：低归属感（< leaveThreshold）选手按概率提出离队申请（PendingDecision leave_request）或被挖角，
 *   概率随隐藏的薪资差 g 提高（CONFIG.salary.poach.leaveGapMult / poachGapMult）；
 *   归属感尚可但对薪资强烈不满的明星，也可能被外部俱乐部趁机挖角（salary.unhappyStarPoachChance）。
 */
export function processLoyaltyDepartures(state: GameState): void {
  if (state.gameOver) return;
  const team = playerTeamOrNull(state);
  if (!team) return;
  // 赛季结算时生成的合同到期决策在新赛季才处理：按当前经济指数 / 近期热度重算要价
  refreshContractDecisions(state);
  reportSalaryDiscontent(state, team);
  if (!isTransferWindowOpen(state)) return;
  const rng = rngOf(state);
  const L = CONFIG.loyalty;
  const P = CONFIG.salary.poach;
  const pendingOffers = new Set(state.transferOffers.filter((o) => o.status === 'pending').map((o) => o.playerId));
  const key = roundKey(state);
  const calm = Math.max(0, Math.floor(CONFIG.salary.loyalty.retainCalmRounds));
  for (const p of rosterOf(state, team.id)) {
    if (hasPendingForPlayer(state, p.id)) continue;
    const loyalty = effectiveAttr(p, 'loyalty');
    const gap = Math.max(0, salaryGap(state, p));
    if (loyalty < L.leaveThreshold) {
      // 刚被挽留过：冷静期内不再提出离队申请（仍可能被挖角）
      const retained = p.salaryTrack?.retainKey;
      const calming = calm > 0 && typeof retained === 'number' && Number.isFinite(retained) && key - retained < calm;
      if (!calming && rng.chance(clamp(L.leaveChancePerRound * (1 + Math.max(0, P.leaveGapMult) * gap), 0, 1))) {
        createLeaveRequest(state, team, p, loyalty, gap);
      } else if (
        !pendingOffers.has(p.id) && !resaleLocked(state, p)
        && rng.chance(clamp(L.poachChancePerRound * (1 + Math.max(0, P.poachGapMult) * gap), 0, 1))
      ) {
        createPoach(state, team, p, rng);
      }
      continue;
    }
    // 对薪资强烈不满的明星：外部俱乐部趁机接触（同一选手本赛季内有冷却）；
    // 加盟门槛未满足（随队场数 / 入队转会回合）/ 抽卡新秀转售冷却中的选手不会被挖角（与挂牌、AI 随机求购同口径，listingRules.resaleLocked）
    if (pendingOffers.has(p.id) || recentlyPoached(state, p.id) || resaleLocked(state, p)) continue;
    const chance = unhappyStarPoachChance(p, loyalty, gap);
    if (chance > 0 && rng.chance(chance)) createPoach(state, team, p, rng, true);
  }
}

/** 回合键：赛季 × 100 + 回合（跨赛季的差值 ≥ 80，冷却自然结束） */
function roundKey(state: GameState): number {
  return (state.season?.ti ?? 0) * 100 + (Number.isFinite(state.roundIndex) ? state.roundIndex : 0);
}

/** 本赛季 CONFIG.salary.poach.unhappyStarCooldownRounds 个回合内是否已有针对该选手的挖角报价（含已拒绝 / 过期的） */
function recentlyPoached(state: GameState, playerId: string): boolean {
  const cd = Math.max(0, Math.floor(CONFIG.salary.poach.unhappyStarCooldownRounds));
  if (cd <= 0) return false;
  const ti = state.season?.ti;
  return (state.transferOffers ?? []).some(
    (o) => o.poach && o.playerId === playerId && o.season === ti && state.roundIndex - o.createdRound < cd,
  );
}

/** 记录离队申请被挽留的回合（冷静期起点） */
function markRetained(state: GameState, p: Player): void {
  if (!p.salaryTrack || typeof p.salaryTrack !== 'object') p.salaryTrack = {};
  p.salaryTrack.retainKey = roundKey(state);
}

/**
 * 「对薪资不满」公开新闻：玩家战队正式队员（非新秀合同）进入「强烈不满」时发布；仍强烈不满则每 newsCooldownRounds 回合再提一次。
 * 满意度好转后重置，之后再次恶化会重新报道。新闻只给定性描述，不透露预期薪资数值。
 * 合同已到期、正在等待续约决定的选手不报道（续约时按要价重新签约）。
 */
function reportSalaryDiscontent(state: GameState, team: Team): void {
  const cooldown = Math.max(1, Math.floor(CONFIG.salary.newsCooldownRounds));
  const key = roundKey(state);
  const ti = state.season?.ti;
  for (const p of rosterOf(state, team.id)) {
    if (onRookieContract(state, p)) continue;
    if (ti !== undefined && p.contractUntil < ti) continue;
    const level = salaryMoodLevel(salaryMoodOf(salaryGap(state, p)));
    const t = p.salaryTrack;
    if (level < 2) {
      if (t && t.newsLevel) t.newsLevel = level;
      continue;
    }
    const prevLevel = t?.newsLevel ?? 0;
    const lastKey = t?.newsKey;
    const due = prevLevel < 2 || lastKey === undefined || !Number.isFinite(lastKey) || key - lastKey >= cooldown;
    if (!due) continue;
    if (!p.salaryTrack) p.salaryTrack = {};
    p.salaryTrack.newsLevel = level;
    p.salaryTrack.newsKey = key;
    const star = p.isReal || tierIndex(playerTier(p)) >= tierIndex('S');
    addNews(
      state,
      'transfer',
      `【薪资风波】${p.handle} 对薪资不满`,
      prevLevel < 2
        ? `据多方消息，${team.name} 的 ${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）对目前的待遇颇有微词，认为薪水与自己的身价和俱乐部地位不相称。` +
          `若迟迟得不到改善，他的归属感将持续下滑，其他俱乐部也可能趁机接触。`
        : `${p.handle} 与 ${team.name} 的薪资分歧仍未解决，队内人士透露他对待遇依旧非常不满，外界对其去留的猜测越来越多。`,
      star,
      { teamIds: [team.id], playerIds: [p.id], visibility: 'public' },
    );
  }
}

function persuadeChance(team: Team): number {
  const ev = CONFIG.events;
  return clamp(ev.leavePersuadeBase + honorLuck(team.honor) * ev.leavePersuadeLuck, 0.05, 0.95);
}

function createLeaveRequest(state: GameState, team: Team, p: Player, loyalty: number, gap = 0): void {
  const ev = CONFIG.events;
  const raised = Math.round(p.salary * ev.leaveRaiseSalaryMult);
  const mood = salaryMoodOf(gap);
  const salaryText = mood === 'strong' ? '他对薪资待遇强烈不满。' : mood === 'mild' ? '他觉得薪水低于自己的身价。' : '';
  pushDecision(state, {
    kind: 'leave_request',
    title: `【离队申请】${p.handle} 想换个环境`,
    body:
      `${p.handle} 敲开了你的办公室："经理，我想走。"（归属感 ${Math.round(loyalty)}）${salaryText}\n` +
      `· 加薪挽留：工资 ${formatGold(p.salary)} → ${formatGold(raised)}/回合，归属感 +${ev.leaveRaiseLoyalty}。\n` +
      `· 尝试挽留：成功率约 ${pct(persuadeChance(team))}（取决于俱乐部荣誉），失败则直接离队。\n· 放行：以自由身离队。`,
    choices: [
      { id: 'raise', label: '加薪挽留', description: `工资 +${pct(ev.leaveRaiseSalaryMult - 1)}，必定留下` },
      { id: 'persuade', label: '尝试挽留', description: `成功率约 ${pct(persuadeChance(team))}，失败则离队` },
      { id: 'allow', label: '放行', description: '以自由身离队' },
    ],
    ctx: { playerId: p.id },
  });
}

function createPoach(state: GameState, team: Team, p: Player, rng: Rng, salaryUnhappy = false): void {
  const value = marketValue(state, p);
  const fee = roundFee(value * rangeOf(rng, CONFIG.market.poachFeeRange));
  if (fee <= 0) return;
  const buyer = pickOfferBuyer(state, fee, rng, [team.id]);
  if (!buyer) return;
  const offer = createTransferOffer(state, p, buyer, fee, true);
  const body =
    `${buyer.name} 私下接触了${salaryUnhappy ? '对薪资不满' : '归属感低迷'}的 ${p.handle}，并开出 ${formatGold(fee)} 的违约金（身价约 ${formatGold(value)}），` +
    `承诺工资 ${formatGold(offer.salary)}/回合。${p.handle} 显然动心了。\n拒绝的话，他的归属感会进一步下降。`;
  pushDecision(state, {
    kind: 'poach',
    title: `【挖角】${buyer.name} 盯上了 ${p.handle}`,
    body,
    choices: [
      { id: 'decline', label: '拒绝', description: '选手归属感进一步下降' },
      { id: 'accept', label: '接受报价', description: `收入 ${formatGold(fee)}` },
    ],
    ctx: { offerId: offer.id, playerId: p.id, buyerId: buyer.id },
  });
  addNews(state, 'transfer', `【挖角】${buyer.name} 盯上了 ${p.handle}`, body, true);
}

// ---------------------------------------------------------------------------
// 抉择
// ---------------------------------------------------------------------------

interface Outcome {
  ok: boolean;
  message: string;
  /** true = 保留决策（如资金不足无法执行所选项，让玩家改选） */
  keep?: boolean;
}

/**
 * 待决事件的默认选项（「下一回合」自动处理 autoRound.ts 与多人托管 multi.autopilotSeat 共用）：
 * 保守处理——不花钱、不卖人、不冒险、尽量留住选手。未列出的事件（含无厘头事件）取第一个选项。
 */
export const DEFAULT_DECISION_CHOICE: Readonly<Partial<Record<EventKind, string>>> = {
  match_fixing: 'cooperate', // 配合调查
  scandal: 'ignore',         // 低调处理（不花公关费）
  visa: 'bench',             // 现有替补顶上（凑不齐时由自动处理招募临时替补）
  leave_request: 'persuade', // 尝试挽留
  poach: 'decline',          // 拒绝报价
  contract: 'renew_1',       // 续约 1 赛季
  retire: 'decline',         // 不聘为教练
  rookie_home: 'sign',       // 签下按真实出道去向而来的真实新秀（同选秀时代的自动选秀）
  unpaid_salary: 'ack',
};

/**
 * 默认选项执行失败（事件保留）时自动处理改用的选项：真实出道新秀「签下」在阵容已达绝对上限时会被拦下，
 * 托管 / 懒人推进改为「放弃」，避免阻塞事件卡住回合（玩家手动处理时仍可先腾出位置再签下）。
 */
export const FALLBACK_DECISION_CHOICE: Readonly<Partial<Record<EventKind, string>>> = {
  rookie_home: 'decline',
};

/** 某待决事件的默认选项 id（无选项时为 'ack'） */
export function defaultDecisionChoice(decision: Pick<PendingDecision, 'kind' | 'choices'>): string {
  const ids = (decision.choices ?? []).map((c) => c.id);
  const pref = DEFAULT_DECISION_CHOICE[decision.kind];
  if (pref && ids.includes(pref)) return pref;
  return ids[0] ?? 'ack';
}

/**
 * 处理抉择：按 decision.kind 与 choiceId 执行效果，移出 pendingDecisions，写新闻。
 * 支持的 kind 至少包括：match_fixing（cooperate/cover_up）、visa（temp_sub/use_bench/…）、leave_request（allow/persuade/raise）、
 * poach、contract（renew_1/renew_2/release）、retire（hire_as_coach/decline）、scandal、beef、unpaid_salary 等。
 */
export function resolveDecision(state: GameState, decisionId: string, choiceId: string): OpResult {
  const decision = state.pendingDecisions.find((d) => d.id === decisionId);
  if (!decision) return { ok: false, message: '该事件已处理或已失效' };
  // 先校验选项（无效选项不移除决策，玩家可重选），再分派
  if (decision.choices?.length && !decision.choices.some((c) => c.id === choiceId)) {
    return { ok: false, message: '无效的选项' };
  }
  // 无厘头事件（funEvents.ts 生成，ctx.fun = 事件 id）
  if (decision.ctx?.fun != null && decision.ctx.fun !== '') return resolveFunDecision(state, decision, choiceId);
  const team = playerTeamOrNull(state);
  let out: Outcome;
  if (!team || state.gameOver) {
    out = { ok: true, message: '事件已结束' };
  } else {
    switch (decision.kind) {
      case 'match_fixing': out = resolveMatchFixing(state, team, decision, choiceId); break;
      case 'scandal': out = resolveScandal(state, team, decision, choiceId); break;
      case 'visa': out = resolveVisa(state, team, decision, choiceId); break;
      case 'leave_request': out = resolveLeave(state, team, decision, choiceId); break;
      case 'poach': out = resolvePoach(state, decision, choiceId); break;
      case 'contract': out = resolveContract(state, team, decision, choiceId); break;
      case 'retire': out = resolveRetire(state, team, decision, choiceId); break;
      case 'rookie_home': out = resolveHomeRookieDecision(state, team, decision, choiceId); break;
      case 'unpaid_salary': out = { ok: true, message: '已知悉，请尽快改善财务状况' }; break;
      default: out = { ok: true, message: '已处理' };
    }
  }
  if (!out.keep) state.pendingDecisions = state.pendingDecisions.filter((d) => d.id !== decision.id);
  // 羁绊（第十波 #5）：离队申请 / 合同到期 / 假赛禁赛等决策可能拆散羁绊，立即同步（幂等、不消耗随机数）
  syncSynergies(state);
  return { ok: out.ok, message: out.message };
}

function ctxPlayer(state: GameState, decision: PendingDecision): Player | null {
  const id = ctxStr(decision.ctx, 'playerId');
  return id ? state.players[id] ?? null : null;
}

function resolveMatchFixing(state: GameState, team: Team, decision: PendingDecision, choiceId: string): Outcome {
  const ev = CONFIG.events;
  const p = ctxPlayer(state, decision);
  if (!p || p.status !== 'active') return { ok: true, message: '涉事选手已离开，事件不了了之' };
  if (choiceId === 'cooperate') {
    const loss = ctxNum(decision.ctx, 'honorCooperate', ev.matchFixingHonorCooperate);
    banPlayer(state, p);
    changeHonor(state, team.id, loss, `假赛风波：配合调查（${p.handle} 禁赛）`);
    addNews(state, 'event', `【假赛风波】${p.handle} 被永久禁赛`, `${team.name} 配合联盟调查，${p.handle} 被处以永久禁赛，俱乐部荣誉 ${loss}。`, true);
    return { ok: true, message: `${p.handle} 被永久禁赛，荣誉 ${loss}` };
  }
  // 冷处理
  const rng = rngOf(state);
  adjustLoyalty(p, ev.matchFixingCoverLoyalty);
  if (rng.chance(ev.matchFixingLeakChance)) {
    if (!state.delayedEvents) state.delayedEvents = [];
    state.delayedEvents.push({
      id: nextId(state, 'de'),
      kind: 'match_fixing',
      season: state.season?.ti ?? 0,
      round: state.roundIndex + intOf(rng, ev.matchFixingLeakDelay),
      ctx: { playerId: p.id, teamId: team.id, handle: p.handle },
    });
  }
  addNews(state, 'event', '【假赛风波】俱乐部选择不予置评', `${team.name} 对假赛传闻不予置评，事件暂时平息，但联盟调查仍可能继续。${p.handle} 的归属感有所下降。`);
  return { ok: true, message: '已冷处理，事件暂时平息' };
}

function resolveScandal(state: GameState, team: Team, decision: PendingDecision, choiceId: string): Outcome {
  const honor = ctxNum(decision.ctx, 'honor', Math.round(CONFIG.events.scandalHonor[0]));
  if (choiceId === 'pr') {
    const cost = ctxNum(decision.ctx, 'prCost', roundFee(CONFIG.events.scandalPrCost * econ(state)));
    if (team.gold < cost) return { ok: false, message: `资金不足：公关需要 ${formatGold(cost)}`, keep: true };
    const prHonor = ctxNum(decision.ctx, 'prHonor', Math.round(honor * CONFIG.events.scandalPrHonorMult));
    addFinance(state, team.id, -cost, 'event', '丑闻公关');
    changeHonor(state, team.id, prHonor, '丑闻（公关处理）');
    return { ok: true, message: `公关团队连夜发声明，荣誉 ${prHonor}` };
  }
  changeHonor(state, team.id, honor, '丑闻（低调处理）');
  return { ok: true, message: `风波慢慢过去，荣誉 ${honor}` };
}

function resolveVisa(state: GameState, team: Team, decision: PendingDecision, choiceId: string): Outcome {
  const tid = ctxStr(decision.ctx, 'tournamentId');
  const t = tid ? state.tournaments[tid] : undefined;
  if (!t || t.status === 'finished') return { ok: true, message: '赛事已结束，事件失效' };
  const ids = (ctxStr(decision.ctx, 'playerIds') ?? '').split(',').filter(Boolean);
  const positions = [...new Set(ids.map((id) => state.players[id]?.position).filter((x): x is Position => !!x))];
  const openMarket = (): string => {
    const cands = generateTempSubCandidatesFor(state, positions);
    const posText = positions.map((p) => POSITION_LABEL[p]).join('、') || '空缺位置';
    pushPopup(state, {
      kind: 'message',
      title: '野外替补已就位',
      body: `已为「${t.name}」找到 ${cands.length} 名野外替补候选（${posText}），请前往 转会市场 → 临时替补 雇佣。`,
    });
    return `已生成 ${cands.length} 名野外替补候选，请前往 转会市场 → 临时替补 雇佣`;
  };
  if (choiceId === 'temp_sub') return { ok: true, message: openMarket() };
  autoLineup(state, team.id, t.id);
  const errors = validateLineup(state, team.id, t.id);
  if (errors.length) return { ok: true, message: `现有替补不足（${errors[0]}）。${openMarket()}` };
  return { ok: true, message: '替补已顶上首发位置' };
}

function resolveLeave(state: GameState, team: Team, decision: PendingDecision, choiceId: string): Outcome {
  const ev = CONFIG.events;
  const p = ctxPlayer(state, decision);
  if (!p || p.teamId !== team.id || p.status !== 'active') return { ok: true, message: '该选手已不在队中' };
  if (choiceId === 'allow') {
    departToFreeAgency(state, p.id);
    addNews(state, 'transfer', `【离队】${p.handle} 离开 ${team.name}`, `${team.name} 同意了 ${p.handle} 的离队申请，祝他前程似锦。`);
    return { ok: true, message: `${p.handle} 以自由身离队` };
  }
  if (choiceId === 'raise') {
    const old = p.salary;
    p.salary = Math.round(p.salary * ev.leaveRaiseSalaryMult);
    adjustLoyalty(p, ev.leaveRaiseLoyalty);
    markRetained(state, p);
    return { ok: true, message: `${p.handle} 工资 ${formatGold(old)} → ${formatGold(p.salary)}，决定留下` };
  }
  // 挽留
  const rng = rngOf(state);
  if (rng.chance(persuadeChance(team))) {
    adjustLoyalty(p, ev.leavePersuadeLoyalty);
    markRetained(state, p);
    addNews(state, 'transfer', `【挽留成功】${p.handle} 决定留在 ${team.name}`, `一番促膝长谈后，${p.handle} 收回了离队申请："为了那座冠军盾，再拼一年。"`);
    return { ok: true, message: `挽留成功！${p.handle} 归属感 +${ev.leavePersuadeLoyalty}` };
  }
  departToFreeAgency(state, p.id);
  addNews(state, 'transfer', `【离队】挽留失败，${p.handle} 离开 ${team.name}`, `${p.handle} 去意已决，以自由身离队。`);
  return { ok: true, message: `挽留失败，${p.handle} 离队` };
}

function resolvePoach(state: GameState, decision: PendingDecision, choiceId: string): Outcome {
  const offerId = ctxStr(decision.ctx, 'offerId');
  const offer = offerId ? state.transferOffers.find((o) => o.id === offerId) : undefined;
  if (!offer || offer.status !== 'pending') return { ok: true, message: '报价已失效' };
  const r = respondToOffer(state, offer.id, choiceId === 'accept');
  // 接受失败但报价仍有效：保留决策，让玩家改选
  const keep = !r.ok && offer.status === 'pending';
  return { ok: r.ok, message: r.message, keep };
}

function resolveContract(state: GameState, team: Team, decision: PendingDecision, choiceId: string): Outcome {
  const p = ctxPlayer(state, decision);
  if (!p || p.teamId !== team.id || p.status !== 'active') return { ok: true, message: '该选手已不在队中' };
  if (choiceId === 'release') {
    departToFreeAgency(state, p.id);
    addNews(state, 'transfer', `【合同到期】${p.handle} 离开 ${team.name}`, `${p.handle} 合同到期未续，成为自由选手。`);
    return { ok: true, message: `${p.handle} 合同到期离队` };
  }
  const seasons = choiceId === 'renew_2' ? 2 : 1;
  const r = renewContract(state, p.id, seasons);
  if (r.ok) return r;
  departToFreeAgency(state, p.id);
  addNews(state, 'transfer', `【续约失败】${p.handle} 离开 ${team.name}`, `${r.message}\n${p.handle} 以自由身离队。`);
  return { ok: true, message: `${r.message}，已以自由身离队` };
}

function resolveRetire(state: GameState, team: Team, decision: PendingDecision, choiceId: string): Outcome {
  const coachId = ctxStr(decision.ctx, 'coachId');
  const formerId = ctxStr(decision.ctx, 'playerId');
  let coach = coachId ? state.coaches[coachId] : undefined;
  if (!coach && formerId) coach = Object.values(state.coaches).find((c) => c.formerPlayerId === formerId);
  const name = coach?.name ?? (formerId ? state.players[formerId]?.handle : undefined) ?? '退役选手';
  if (choiceId !== 'hire_as_coach') return { ok: true, message: `${name} 进入教练市场` };
  if (!coach) return { ok: true, message: '该教练已不在市场中' };
  if (coach.teamId && coach.teamId !== team.id) return { ok: true, message: `${coach.name} 已被其他战队聘请` };
  if (coach.teamId === team.id) return { ok: true, message: `${coach.name} 已是你的主教练` };
  const current = getCoach(state, team.id);
  if (current && current.id !== coach.id) current.teamId = null;
  coach.teamId = team.id;
  team.coachId = coach.id;
  addNews(
    state,
    'transfer',
    `【新帅】${coach.name} 退役转型，执教 ${team.name}`,
    `昔日的队员 ${coach.name} 挂靴后留队担任主教练（${coach.tier} 级，灵性 ${Math.round(coach.insight)}）。${current && current.id !== coach.id ? `原主教练 ${current.name} 离任。` : ''}`,
    true,
  );
  return { ok: true, message: `${coach.name} 出任主教练（免签字费）` };
}
