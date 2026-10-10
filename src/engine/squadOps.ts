// 球员管理操作（提高归属感：加薪 / 一对一谈心 / 团建）与挂牌转会【F1-squad-ops】
// 约定：面向玩家的操作均为 (state, ...args) 形式的命名动作函数，参数可 JSON 序列化，返回 OpResult（中文 message），
// 不因用户操作错误而抛异常（便于未来多人服务器按函数名 RPC 调用）。
import type { GameState, OpResult, Player, Team, TransferListing, TransferOffer } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, type Rng } from './rng';
import { clamp, formatGold, lerp, round1, round2 } from './util';
import { addNews } from './news';
import { computeSalary, effectiveAttr, marketValue, overallRating, playerRating, playerTier, tierIndex } from './player';
import { activeTeams, teamPlayers } from './team';
import { honorLuck } from './honor';
import { adjustLoyalty } from './growth';
import { addFinance, econ, roundWageBill } from './economy';
import { createTransferOffer, departToFreeAgency, isTransferWindowOpen, playerTeamOrNull, roundFee } from './market';
import { SALARY_MOOD_LABEL, raiseGapMultiplier, salaryGap, salaryMoodOf, type SalaryMood } from './salary';

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 回合键：赛季 × 100 + 回合（「每回合一次」类操作的标记值） */
export function squadRoundKey(state: GameState): number {
  return (state.season?.ti ?? 0) * 100 + (Number.isFinite(state.roundIndex) ? state.roundIndex : 0);
}

/** 归属感收益递减系数：1 - 有效归属感 / divisor（越接近 100 收益越小） */
function loyaltyDiminish(p: Player): number {
  const l = effectiveAttr(p, 'loyalty');
  const d = CONFIG.squadOps.loyaltyDiminishDivisor > 0 ? CONFIG.squadOps.loyaltyDiminishDivisor : 150;
  return clamp(1 - l / d, 0, 1);
}

function isHighProfile(p: Player): boolean {
  return p.isReal || tierIndex(playerTier(p)) >= tierIndex('S');
}

/** 正式队员（active、非临时替补） */
function regularMembers(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament && !p.isWildSub);
}

/** 校验：玩家战队的正式队员（active、非临时替补）；失败返回中文原因 */
function ownRegularPlayer(state: GameState, playerId: string): { team: Team; p: Player } | string {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return '战队不存在或游戏已结束';
  const p = typeof playerId === 'string' ? state.players[playerId] : undefined;
  if (!p || p.teamId !== team.id) return '该选手不在你的战队';
  if (p.status !== 'active') return `${p.handle} 当前状态无法进行此操作`;
  if (p.tempSubUntilTournament || p.isWildSub) return '临时替补不适用此操作';
  return { team, p };
}

// ---------------------------------------------------------------------------
// 加薪
// ---------------------------------------------------------------------------

export interface RaisePreview {
  /** 加薪后的每回合工资 */
  newSalary: number;
  /** 预计归属感增量（实际增量受 100 上限截断） */
  loyaltyGain: number;
  allowed: boolean;
  /** 不允许时的中文原因 */
  reason: string;
  /** 加薪前 / 后的薪资满意度（定性；隐藏的预期薪资不以数值展示） */
  moodBefore: SalaryMood;
  moodAfter: SalaryMood;
}

/**
 * 加薪预览：新工资、归属感增量、是否允许（每名选手每赛季限一次），以及加薪前后的薪资满意度（定性）。
 * 归属感增量 = 基础值 × 递减系数 × (1 + gapBonus × 被弥补的薪资差)：对薪资不满的选手，加薪更能打动他。
 */
export function raiseSalaryPreview(state: GameState, playerId: string, pct: number): RaisePreview {
  const ctx = ownRegularPlayer(state, playerId);
  if (typeof ctx === 'string') {
    return { newSalary: 0, loyaltyGain: 0, allowed: false, reason: ctx, moodBefore: 'satisfied', moodAfter: 'satisfied' };
  }
  const { p } = ctx;
  const S = CONFIG.squadOps;
  const salary = Number.isFinite(p.salary) ? Math.max(0, p.salary) : 0;
  const gapBefore = salaryGap(state, p, salary);
  const moodBefore = salaryMoodOf(gapBefore);
  const base = S.raisePcts.includes(pct) ? S.raiseLoyalty[pct] : undefined;
  if (!base) {
    return {
      newSalary: p.salary, loyaltyGain: 0, allowed: false, reason: `加薪幅度只能是 ${S.raisePcts.join('% / ')}%`,
      moodBefore, moodAfter: moodBefore,
    };
  }
  const newSalary = Math.round(salary * (1 + pct / 100));
  const gapAfter = salaryGap(state, p, newSalary);
  const moodAfter = salaryMoodOf(gapAfter);
  const loyaltyGain = round1(base * loyaltyDiminish(p) * raiseGapMultiplier(gapBefore, gapAfter));
  const ti = state.season?.ti ?? 0;
  if (p.lastRaiseSeason === ti) {
    return {
      newSalary, loyaltyGain, allowed: false, reason: `本赛季已为 ${p.handle} 加过薪（每名选手每赛季限一次）`, moodBefore, moodAfter,
    };
  }
  return { newSalary, loyaltyGain, allowed: true, reason: '', moodBefore, moodAfter };
}

/** 加薪 10% / 20% / 30%：工资永久上调（续约时按要价重算），缩小薪资差、提升归属感（每名选手每赛季限一次） */
export function raiseSalary(state: GameState, playerId: string, pct: number): OpResult {
  const pv = raiseSalaryPreview(state, playerId, pct);
  if (!pv.allowed) return { ok: false, message: pv.reason };
  const team = playerTeamOrNull(state)!;
  const p = state.players[playerId];
  const oldSalary = p.salary;
  const before = p.loyalty;
  p.salary = pv.newSalary;
  p.lastRaiseSeason = state.season?.ti ?? 0;
  adjustLoyalty(p, pv.loyaltyGain);
  const gained = round1(p.loyalty - before);
  addNews(
    state,
    'transfer',
    `【加薪】${team.name} 为 ${p.handle} 加薪 ${pct}%`,
    `${team.name} 宣布将 ${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）的工资由 ${formatGold(oldSalary)} 上调至 ${formatGold(p.salary)}/回合，以示对其表现的认可。`,
  );
  const moodText = pv.moodBefore !== pv.moodAfter
    ? `；薪资满意度：${SALARY_MOOD_LABEL[pv.moodBefore]} → ${SALARY_MOOD_LABEL[pv.moodAfter]}`
    : `；薪资满意度：${SALARY_MOOD_LABEL[pv.moodAfter]}`;
  return {
    ok: true,
    message: `已为 ${p.handle} 加薪 ${pct}%：工资 ${formatGold(oldSalary)} → ${formatGold(p.salary)}/回合，归属感 +${gained}${moodText}`,
  };
}

// ---------------------------------------------------------------------------
// 一对一谈心
// ---------------------------------------------------------------------------

/** 谈心成功率 = base + 教练灵性/250 + 荣誉幸运度/10，夹在 [0.3, 0.9] */
export function talkSuccessChance(state: GameState): number {
  const c = CONFIG.squadOps.talk;
  const team = playerTeamOrNull(state);
  const coach = team?.coachId ? state.coaches[team.coachId] : undefined;
  const insight = coach && Number.isFinite(coach.insight) ? Math.max(0, coach.insight) : 0;
  const luck = honorLuck(team?.honor ?? 0);
  const v = c.base + insight / c.coachInsightDivisor + luck / c.honorLuckDivisor;
  return clamp(Number.isFinite(v) ? v : c.base, c.chanceRange[0], c.chanceRange[1]);
}

/** 本回合是否已与该选手谈过心 */
export function talkedThisRound(state: GameState, playerId: string): boolean {
  return state.players[playerId]?.lastTalkRound === squadRoundKey(state);
}

/**
 * 一对一谈心（免费，每名选手每回合一次）：按成功率判定；成功归属感 +3~6（递减），
 * 失败仅在归属感低于 30 时 -1。结果 ok=true 表示谈心已进行，success 表示是否成功。
 */
export function talkToPlayer(state: GameState, playerId: string): OpResult & { success?: boolean; loyaltyDelta?: number } {
  const ctx = ownRegularPlayer(state, playerId);
  if (typeof ctx === 'string') return { ok: false, message: ctx };
  const { p } = ctx;
  const key = squadRoundKey(state);
  if (p.lastTalkRound === key) return { ok: false, message: `本回合已经和 ${p.handle} 谈过心了，下回合再聊吧` };

  const c = CONFIG.squadOps.talk;
  const chance = talkSuccessChance(state);
  const rng = rngOf(state);
  p.lastTalkRound = key;
  const before = p.loyalty;
  if (rng.chance(chance)) {
    const [lo, hi] = c.successGain;
    adjustLoyalty(p, rng.range(lo, hi) * loyaltyDiminish(p));
    const d = round1(p.loyalty - before);
    return {
      ok: true,
      success: true,
      loyaltyDelta: d,
      message: `与 ${p.handle} 的一对一谈心很顺利，他感受到了俱乐部的重视。归属感 +${d}`,
    };
  }
  if (effectiveAttr(p, 'loyalty') < c.failPenaltyBelow) {
    adjustLoyalty(p, c.failPenalty);
    const d = round1(p.loyalty - before);
    return {
      ok: true,
      success: false,
      loyaltyDelta: d,
      message: `与 ${p.handle} 的谈心没有谈拢，他对现状依然不满。归属感 ${d}`,
    };
  }
  return {
    ok: true,
    success: false,
    loyaltyDelta: 0,
    message: `与 ${p.handle} 聊了聊，但他有些心不在焉，这次谈心没有明显效果。`,
  };
}

// ---------------------------------------------------------------------------
// 团建
// ---------------------------------------------------------------------------

/** 团建费用 = teamBuildingCost × econIndex */
export function teamBuildingCost(state: GameState): number {
  return Math.max(0, Math.round(CONFIG.squadOps.teamBuildingCost * econ(state)));
}

/** 本回合是否已组织过团建 */
export function teamBuildingDoneThisRound(state: GameState): boolean {
  const team = playerTeamOrNull(state);
  return !!team && team.lastTeamBuildingRound === squadRoundKey(state);
}

/** 团建（每回合一次，花费金币）：全体正式队员归属感 +4~8（递减），韧性 +0.5 */
export function teamBuilding(state: GameState): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  const key = squadRoundKey(state);
  if (team.lastTeamBuildingRound === key) return { ok: false, message: '本回合已经组织过团建了，下回合再安排吧' };
  const members = regularMembers(state, team.id);
  if (!members.length) return { ok: false, message: '队中没有可参加团建的正式队员' };
  const cost = teamBuildingCost(state);
  if (team.gold < cost) return { ok: false, message: `资金不足：团建需要 ${formatGold(cost)}，账上仅 ${formatGold(team.gold)}` };

  const S = CONFIG.squadOps;
  if (cost > 0) addFinance(state, team.id, -cost, 'other', '全队团建');
  team.lastTeamBuildingRound = key;
  const rng = rngOf(state);
  const [lo, hi] = S.teamBuildingLoyalty;
  let total = 0;
  for (const p of members) {
    const before = p.loyalty;
    adjustLoyalty(p, rng.range(lo, hi) * loyaltyDiminish(p));
    total += p.loyalty - before;
    const res = Number.isFinite(p.resilience) ? p.resilience : 50;
    p.resilience = round2(clamp(res + S.teamBuildingResilience, 0, CONFIG.player.maxAttr));
  }
  const avgGain = round1(total / members.length);
  addNews(
    state,
    'event',
    `【团建】${team.name} 组织全队团建`,
    `${team.name} 组织了一次全队团建活动，${members.length} 名队员参加，队内氛围更加融洽。`,
  );
  return {
    ok: true,
    message: `团建完成（花费 ${formatGold(cost)}）：${members.length} 名队员归属感平均 +${avgGain}，韧性 +${S.teamBuildingResilience}`,
  };
}

// ---------------------------------------------------------------------------
// 挂牌转会
// ---------------------------------------------------------------------------

/** 选手当前有效的挂牌（须仍是玩家战队的 active 正式队员），否则 null */
export function activeListing(state: GameState, p: Player | undefined | null): TransferListing | null {
  if (!p || !p.transferListing || typeof p.transferListing !== 'object') return null;
  const team = playerTeamOrNull(state);
  if (!team || p.teamId !== team.id || p.status !== 'active' || p.tempSubUntilTournament) return null;
  return p.transferListing;
}

/** 玩家战队全部挂牌中的选手 */
export function listedPlayers(state: GameState): Player[] {
  const team = playerTeamOrNull(state);
  if (!team) return [];
  return regularMembers(state, team.id).filter((p) => !!activeListing(state, p));
}

/** 标价允许范围 [min, max]（身价 × listingPriceRange，取整到 feeRounding） */
export function listingPriceRange(state: GameState, playerId: string): [number, number] {
  const p = state.players[playerId];
  if (!p) return [0, 0];
  const mv = Math.max(0, marketValue(state, p));
  const [a, b] = CONFIG.squadOps.listingPriceRange;
  return [roundFee(mv * a), roundFee(mv * b)];
}

/** 本回合结束后的下一回合转会窗口是否开放（无日历数据时按当前阶段） */
function nextRoundWindowOpen(state: GameState): boolean {
  const rounds = state.season?.rounds;
  if (!rounds?.length) return isTransferWindowOpen(state);
  const next = rounds[state.roundIndex + 1];
  return !!next && (next.phase === 'preseason' || next.phase === 'regular');
}

/** 挂牌选手的待处理报价（发给玩家战队） */
export function listingOffers(state: GameState, playerId: string): TransferOffer[] {
  const p = state.players[playerId];
  if (!p || !p.teamId) return [];
  return (state.transferOffers ?? []).filter((o) => o.status === 'pending' && o.playerId === playerId && o.toTeamId === p.teamId);
}

/**
 * 挂牌：选手进入转会名单，等待 AI 俱乐部报价（标价默认 = 身价，允许身价 50%~200%）。
 * 需转会窗口开放；临时替补不可挂牌；同一选手不可重复挂牌。
 */
export function listPlayerForTransfer(state: GameState, playerId: string, askingPrice?: number | null): OpResult {
  const ctx = ownRegularPlayer(state, playerId);
  if (typeof ctx === 'string') return { ok: false, message: ctx };
  const { team, p } = ctx;
  if (!isTransferWindowOpen(state)) return { ok: false, message: '转会窗口已关闭（TI 预选与正赛期间锁定），暂时无法挂牌' };
  if (activeListing(state, p)) return { ok: false, message: `${p.handle} 已在挂牌名单中` };

  const mv = Math.max(0, marketValue(state, p));
  const step = CONFIG.market.feeRounding;
  let price: number;
  if (askingPrice === undefined || askingPrice === null) {
    price = roundFee(mv) || step;
  } else {
    if (typeof askingPrice !== 'number' || !Number.isFinite(askingPrice) || askingPrice <= 0) {
      return { ok: false, message: '标价无效：请输入大于 0 的金额' };
    }
    const [a, b] = CONFIG.squadOps.listingPriceRange;
    const lo = mv * a;
    const hi = mv * b;
    if (askingPrice < lo - step || askingPrice > hi + step) {
      return {
        ok: false,
        message: `标价需在身价的 ${Math.round(a * 100)}%~${Math.round(b * 100)}% 之间（${formatGold(roundFee(lo))} ~ ${formatGold(roundFee(hi))}）`,
      };
    }
    price = roundFee(askingPrice) || step;
  }

  const n = CONFIG.squadOps.listingRounds;
  p.transferListing = {
    season: state.season?.ti ?? 0,
    listedRound: state.roundIndex,
    roundsLeft: n,
    askingPrice: price,
  };
  addNews(
    state,
    'transfer',
    `【挂牌】${team.name} 将 ${p.handle} 挂牌出售，标价 ${formatGold(price)}`,
    `${team.name} 将 ${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）挂上转会名单，标价 ${formatGold(price)}（身价约 ${formatGold(mv)}）。` +
      `有意的俱乐部可在 ${n} 个转会回合内报价。`,
    isHighProfile(p),
  );
  return {
    ok: true,
    message: `已将 ${p.handle} 挂牌，标价 ${formatGold(price)}。${n} 个回合内若无人报价，将自动解约（不支付补偿）。`,
  };
}

/** 批量挂牌（标价 = 各自身价），汇总结果（任一成功即 ok） */
export function listPlayersForTransfer(state: GameState, playerIds: string[]): OpResult {
  const ids = Array.isArray(playerIds) ? playerIds.filter((x): x is string => typeof x === 'string') : [];
  const done: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    const p = state.players[id];
    if (!p) continue;
    const r = listPlayerForTransfer(state, id);
    if (r.ok) done.push(p.handle);
    else failed.push(`${p.handle}（${r.message}）`);
  }
  if (!done.length) return { ok: false, message: failed.length ? `挂牌失败：${failed.join('；')}` : '未选择选手' };
  let message = `已挂牌 ${done.length} 人：${done.join('、')}（标价 = 身价）。${CONFIG.squadOps.listingRounds} 个回合内无人报价将自动解约（不支付补偿）。`;
  if (failed.length) message += `\n未能挂牌：${failed.join('；')}`;
  return { ok: true, message };
}

/** 撤销挂牌（已收到的报价不受影响，仍可在「收到的报价」中处理） */
export function unlistPlayer(state: GameState, playerId: string): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  const p = typeof playerId === 'string' ? state.players[playerId] : undefined;
  if (!p || p.teamId !== team.id) return { ok: false, message: '该选手不在你的战队' };
  if (!p.transferListing) return { ok: false, message: `${p.handle} 不在挂牌名单中` };
  delete p.transferListing;
  addNews(state, 'transfer', `【撤牌】${team.name} 撤销 ${p.handle} 的挂牌`, `${team.name} 将 ${p.handle} 从转会名单中撤下，他将继续留队效力。`);
  const pending = listingOffers(state, p.id).length;
  return {
    ok: true,
    message: `已撤销 ${p.handle} 的挂牌${pending ? `（仍有 ${pending} 份报价可在「收到的报价」中处理）` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// 挂牌：AI 出价
// ---------------------------------------------------------------------------

/** 出价概率曲线（标价/身价 → 基础概率，线性插值） */
function curveChance(ratio: number): number {
  const pts = CONFIG.squadOps.bidChanceCurve;
  if (!pts.length) return 0;
  if (!Number.isFinite(ratio)) return pts[pts.length - 1][1];
  if (ratio <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (ratio <= x1) {
      const [x0, y0] = pts[i - 1];
      return x1 > x0 ? lerp(y0, y1, (ratio - x0) / (x1 - x0)) : y1;
    }
  }
  return pts[pts.length - 1][1];
}

/** AI 报价附带的新工资（与 market.createTransferOffer 一致） */
function offerSalary(state: GameState, p: Player): number {
  return Math.round(Math.max(p.salary || 0, computeSalary(state, p)) * CONFIG.market.offerSalaryRaise);
}

/** 对挂牌选手感兴趣、且负担得起的 AI 俱乐部及兴趣权重 */
function listingBuyers(state: GameState, p: Player, askingPrice: number): { team: Team; interest: number }[] {
  const S = CONFIG.squadOps;
  const mv = Math.max(1, marketValue(state, p));
  const ratio = askingPrice / mv;
  const rating = overallRating(p);
  const salary = offerSalary(state, p);
  const minFee = askingPrice * S.bidFeeRange[0];
  const out: { team: Team; interest: number }[] = [];
  for (const t of activeTeams(state)) {
    if (t.isPlayer || t.id === p.teamId || t.id === state.settings?.playerTeamId) continue;
    if (!Number.isFinite(t.gold)) continue;
    // 资金：付完最低出价后仍能覆盖（现有工资 + 新增工资）× signBudgetRounds
    if (t.gold - minFee < (roundWageBill(state, t.id) + salary) * CONFIG.ai.signBudgetRounds) continue;
    const starterId = t.lineup?.[p.position];
    const starter = starterId ? state.players[starterId] : undefined;
    let interest = 0;
    if (!starter || starter.status !== 'active' || starter.teamId !== t.id) interest = 1;
    else if (rating >= playerRating(starter, p.position) * S.bidUpgradeRatio) interest = 1;
    else if (regularMembers(state, t.id).length < CONFIG.ai.maxRoster) interest = S.bidBargainInterest * depthFade(ratio);
    if (interest > 0) out.push({ team: t, interest });
  }
  return out;
}

/** 板凳深度兴趣的价格系数：≤ bidBargainRatio 为 1，至 bidDepthMaxRatio 线性降到 0 */
function depthFade(ratio: number): number {
  const S = CONFIG.squadOps;
  if (!Number.isFinite(ratio)) return 0;
  if (ratio <= S.bidBargainRatio) return 1;
  const span = S.bidDepthMaxRatio - S.bidBargainRatio;
  if (!(span > 0)) return 0;
  return clamp((S.bidDepthMaxRatio - ratio) / span, 0, 1);
}

export interface ListingBidOutlook {
  /** 每回合收到出价的概率 */
  chance: number;
  /** 感兴趣且负担得起的俱乐部数 */
  interested: number;
  /** 标价 / 身价 */
  ratio: number;
}

/** 挂牌出价前景（UI 展示/测试用）：askingPrice 缺省时用当前标价或身价 */
export function listingBidOutlook(state: GameState, playerId: string, askingPrice?: number): ListingBidOutlook {
  const p = state.players[playerId];
  if (!p) return { chance: 0, interested: 0, ratio: 0 };
  const mv = Math.max(1, marketValue(state, p));
  const price = askingPrice !== undefined && Number.isFinite(askingPrice) && askingPrice > 0
    ? askingPrice
    : p.transferListing?.askingPrice ?? mv;
  const ratio = price / mv;
  const buyers = listingBuyers(state, p, price);
  return { chance: bidChanceFor(p, ratio, buyers), interested: buyers.length, ratio };
}

function bidChanceFor(p: Player, ratio: number, buyers: { interest: number }[]): number {
  if (!buyers.length) return 0;
  const S = CONFIG.squadOps;
  const sumInterest = buyers.reduce((s, b) => s + b.interest, 0);
  const demand = clamp(sumInterest / Math.max(0.01, S.bidDemandRef), 0, 1);
  const [dLo, dHi] = S.bidDemandMult;
  const tierMult = S.bidTierMult[playerTier(p)] ?? 1;
  const v = curveChance(ratio) * tierMult * lerp(dLo, dHi, demand);
  return clamp(Number.isFinite(v) ? v : 0, 0, S.bidMaxChance);
}

/** 尝试为挂牌选手生成一份 AI 出价（写入 transferOffers，出现在「收到的报价」中），返回报价或 null */
function rollListingBid(state: GameState, team: Team, p: Player, L: TransferListing, rng: Rng): TransferOffer | null {
  const mv = Math.max(1, marketValue(state, p));
  const pendingBuyers = new Set(listingOffers(state, p.id).map((o) => o.fromTeamId));
  const buyers = listingBuyers(state, p, L.askingPrice).filter((b) => !pendingBuyers.has(b.team.id));
  const chance = bidChanceFor(p, L.askingPrice / mv, buyers);
  if (chance <= 0 || !rng.chance(chance)) return null;
  const buyer = rng.weighted(
    buyers.map((b) => b.team),
    buyers.map((b) => b.interest * Math.sqrt(Math.max(1, b.team.gold))),
  );
  const [lo, hi] = CONFIG.squadOps.bidFeeRange;
  let fee = roundFee(L.askingPrice * rng.range(lo, hi));
  // 不超出买家的承受能力（保留工资储备）
  const reserve = (roundWageBill(state, buyer.id) + offerSalary(state, p)) * CONFIG.ai.signBudgetRounds;
  const cap = Math.floor((buyer.gold - reserve) / CONFIG.market.feeRounding) * CONFIG.market.feeRounding;
  fee = Math.min(fee, cap);
  if (!(fee > 0)) return null;

  const offer = createTransferOffer(state, p, buyer, fee, false);
  offer.listing = true;
  // 回合结束时生成：从下一回合起有效 offerExpireRounds 个回合（与回合开始时生成的普通报价一致）
  offer.expiresRound = state.roundIndex + 1 + CONFIG.market.offerExpireRounds;
  addNews(
    state,
    'transfer',
    `【挂牌报价】${buyer.name} 求购挂牌中的 ${p.handle}`,
    `${buyer.name} 对 ${team.name} 挂牌出售的 ${p.handle} 开出 ${formatGold(offer.fee)}（标价 ${formatGold(L.askingPrice)}），并承诺工资 ${formatGold(offer.salary)}/回合。` +
      `请在 转会市场 → 我的挂牌 中回应（${CONFIG.market.offerExpireRounds} 回合内有效）。`,
    true,
  );
  return offer;
}

/** 挂牌到期且无人报价：自动解约（无补偿、不扣荣誉） */
function releaseUnsoldListing(state: GameState, team: Team, p: Player): void {
  delete p.transferListing;
  departToFreeAgency(state, p.id);
  const short = regularMembers(state, team.id).length < 5;
  addNews(
    state,
    'transfer',
    `【挂牌到期】${p.handle} 以自由身离开 ${team.name}`,
    `${p.handle} 挂牌期满仍未成交，${team.name} 与其解除合同，${p.handle} 成为自由选手（不支付解约补偿，俱乐部荣誉不受影响）。` +
      `${short ? '注意：阵容已不足 5 人，请尽快补强。' : ''}`,
    true,
  );
}

/**
 * 每回合结束时（season.endRound）处理玩家战队的挂牌：
 * - 清理失效挂牌（选手已离队/退役/成为临时替补）；
 * - 转会窗口锁定（本回合或下一回合）时倒计时暂停、不产生出价；
 * - 否则 AI 俱乐部按「标价/身价、等级、需求、资金」概率出价（创建 TransferOffer），剩余回合 -1；
 * - 剩余回合归零且没有待处理报价：整个挂牌期从未收到报价 → 自动解约（无补偿、不扣荣誉）；收到过报价 → 挂牌结束、选手留队。
 */
export function processTransferListings(state: GameState): void {
  if (state.gameOver) return;
  const team = playerTeamOrNull(state);
  const listed: Player[] = [];
  for (const id in state.players) {
    const p = state.players[id];
    if (!p?.transferListing) continue;
    // 失效挂牌：选手已离开人类玩家战队 / 非 active / 临时替补 / 数据损坏。
    // 仅以「所在战队是否为人类玩家战队」判定，而不是「是否为当前玩家战队」，
    // 以免多人模式下按座位逐一调用时误删其他座位的挂牌。
    const owner = p.teamId ? state.teams[p.teamId] : undefined;
    if (
      typeof p.transferListing !== 'object' || !owner || owner.disbanded
      || !(owner.isPlayer || owner.id === state.settings?.playerTeamId)
      || p.status !== 'active' || p.tempSubUntilTournament
    ) {
      delete p.transferListing;
      continue;
    }
    if (team && owner.id === team.id) listed.push(p);
  }
  if (!team || !listed.length) return;
  if (!isTransferWindowOpen(state)) return; // 窗口锁定：倒计时暂停

  const canBid = nextRoundWindowOpen(state);
  const rng = rngOf(state);
  for (const p of listed) {
    const L = p.transferListing!;
    // 数据损坏的剩余回合：重置为完整等待期（宁可多等，也不因坏数据立即解约）
    if (!Number.isFinite(L.roundsLeft)) L.roundsLeft = CONFIG.squadOps.listingRounds;
    if (!Number.isFinite(L.askingPrice) || L.askingPrice <= 0) L.askingPrice = roundFee(marketValue(state, p)) || CONFIG.market.feeRounding;
    if (L.roundsLeft > 0 && canBid) {
      rollListingBid(state, team, p, L, rng);
      if (listingOffers(state, p.id).length > 0) L.hadBids = true;
      L.roundsLeft -= 1;
      if (L.roundsLeft === 1 && listingOffers(state, p.id).length === 0) {
        addNews(
          state,
          'transfer',
          `【挂牌】${p.handle} 挂牌仅剩最后 1 个回合`,
          `${p.handle} 挂牌至今尚无俱乐部报价。若下回合结束时仍无人出价，${team.name} 将与其自动解约（不支付补偿）。可考虑降低标价或撤销挂牌。`,
        );
      }
    }
    if (L.roundsLeft <= 0 && listingOffers(state, p.id).length === 0) {
      if (L.hadBids) {
        // 用户规则：只有「等不到报价」才自动解约；收到过报价但未成交 → 挂牌结束，选手留队
        delete p.transferListing;
        addNews(
          state,
          'transfer',
          `【挂牌结束】${p.handle} 留在 ${team.name}`,
          `${p.handle} 的挂牌期已满。期间收到过报价但未成交，挂牌自动结束，${p.handle} 继续留队。`,
        );
      } else {
        releaseUnsoldListing(state, team, p);
      }
    }
  }
}
