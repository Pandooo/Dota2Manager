// 招募、转会、报价、临时替补、合同【E4 负责实现】
import type { GameState, OpResult, PendingDecision, Player, Position, Team, Tier, TransferOffer } from './types';
import { POSITIONS, TIERS } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, seededRng, hashSeed, type Rng } from './rng';
import { clamp, formatGold, lerp, nextId, sigmoid } from './util';
import { addNews } from './news';
import {
  computeSalary, effectiveAttr, marketValue, overallRating, playerRating, playerTier, tierIndex,
} from './player';
import {
  addPlayerToTeam, autoLineup, lineupPlayers, removePlayerFromTeam, rosterSigningBlock, teamPlayers, activeTeams,
} from './team';
import { changeHonor, honorLuck } from './honor';
import { generatePlayer } from './generation';
import { adjustLoyalty } from './growth';
import { addFinance, econ, roundWageBill } from './economy';
import { luckAdjustedWeights } from './gacha';
// 循环引用（rookieDraft 也引用本模块的 departToFreeAgency）：两边都只在函数体内使用，模块初始化时不调用
import { draftedRookieReleaseBlock, releaseDraftedRookie } from './rookieDraft';
import {
  allTempSubCandidates, forEachSeat, inSeatOf, isMultiplayer, removePendingDecisionsEverywhere, seatInPlay,
} from './seat';
import {
  SALARY_MOOD_LABEL, aiOfferChance, endRookieContract, expectedSalary, offerGapWeight, playerSalaryMood, renewalAsk, salaryGap,
  signingSalary,
} from './salary';

/** 归属感中性值：低于此值的选手更愿意离开原队 */
const LOYALTY_NEUTRAL = 50;

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 玩家战队（不存在或已解散返回 null） */
export function playerTeamOrNull(state: GameState): Team | null {
  const t = state.teams[state.settings?.playerTeamId];
  return t && !t.disbanded ? t : null;
}

/** 金额取整到 CONFIG.market.feeRounding */
export function roundFee(v: number): number {
  const step = CONFIG.market.feeRounding;
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.max(step, Math.round(v / step) * step);
}

/**
 * 本回合内确定的「谈判骰子」：同一回合对同一选手重复操作得到相同结果（防止反复点击刷概率），
 * 由存档内容决定，可复现。
 */
function negotiationRoll(state: GameState, salt: string): number {
  return seededRng(hashSeed(`${state.id}|${state.season?.ti ?? 0}|${state.roundIndex}|${salt}`)).next();
}

function isTempOrWild(p: Player): boolean {
  return !!p.tempSubUntilTournament || !!p.isWildSub;
}

/** 战队正式阵容（active，不含临时替补） */
function regularRoster(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament);
}

function isHighProfile(p: Player): boolean {
  return p.isReal || tierIndex(playerTier(p)) >= tierIndex('S');
}

function contractLength(rng: Rng): number {
  const [a, b] = CONFIG.economy.contractSeasons;
  return rng.int(a, b);
}

function newSigningLoyalty(willingness: number): number {
  const [a, b] = CONFIG.market.newSigningLoyalty;
  return Math.round(lerp(a, b, clamp(willingness, 0, 1)));
}

function removeDecisions(state: GameState, pred: (d: PendingDecision) => boolean): void {
  // 多人模式：相关决策可能在其他座位（如 AI 报价过期时清理对应座位的挖角决策）
  removePendingDecisionsEverywhere(state, pred);
}

/** 移除与某报价关联的挖角决策 */
function removeOfferDecisions(state: GameState, offerId: string): void {
  removeDecisions(state, (d) => d.kind === 'poach' && d.ctx?.offerId === offerId);
}

/** 作废某选手的全部待处理报价 */
function expirePlayerOffers(state: GameState, playerId: string, exceptOfferId?: string): void {
  for (const o of state.transferOffers ?? []) {
    if (o.status === 'pending' && o.playerId === playerId && o.id !== exceptOfferId) {
      o.status = 'expired';
      removeOfferDecisions(state, o.id);
    }
  }
}

/** 选手离开原战队后：作废其待处理报价，移除与原战队相关的离队申请/挖角/续约决策，清除抽卡「可放弃」标记与挂牌状态 */
function clearDepartureState(state: GameState, p: Player): void {
  expirePlayerOffers(state, p.id);
  removeDecisions(
    state,
    (d) => d.ctx?.playerId === p.id && (d.kind === 'leave_request' || d.kind === 'poach' || d.kind === 'contract'),
  );
  delete p.gachaSeason;
  delete p.transferListing;
}

/** 选手在原队的重要度：头号首发 importanceStar / 首发 importanceStarter / 替补 0 */
export function importanceInTeam(state: GameState, p: Player): number {
  if (!p.teamId || !state.teams[p.teamId]) return 0;
  const slots = lineupPlayers(state, p.teamId).filter((s) => s.player);
  if (!slots.some((s) => s.player!.id === p.id)) return 0;
  let bestId = '';
  let bestRating = -Infinity;
  for (const s of slots) {
    const r = playerRating(s.player!, s.pos);
    if (r > bestRating) {
      bestRating = r;
      bestId = s.player!.id;
    }
  }
  return bestId === p.id ? CONFIG.market.importanceStar : CONFIG.market.importanceStarter;
}

/** 上届 TI 冠军 */
function isReigningChampion(state: GameState, teamId: string): boolean {
  const seasons = state.history?.seasons;
  if (seasons?.length) return seasons[seasons.length - 1].tiChampionId === teamId;
  if (!isMultiplayer(state)) return false;
  // 多人模式：赛季总结是座位私有的（中性上下文中为空）→ 按全局赛事历史中最近一届 TI 的冠军
  const tis = (state.history?.tournaments ?? []).filter((h) => h.tier === 'ti');
  return tis.length > 0 && tis[tis.length - 1].championId === teamId;
}

// ---------------------------------------------------------------------------
// 窗口与自由市场
// ---------------------------------------------------------------------------

/** 转会窗口：preseason / regular 开放；ti_qualifier / ti / season_end 锁定 */
export function isTransferWindowOpen(state: GameState): boolean {
  return state.phase === 'preseason' || state.phase === 'regular';
}

/** 自由选手（active、teamId=null、非抽卡池、非临时替补候选），按综合评分降序 */
export function freeAgents(state: GameState): Player[] {
  const gacha = new Set(state.gachaPool ?? []);
  // 多人模式：任何座位的临时替补候选都不在自由市场中（避免 AI / 其他玩家签走他人的候选）
  const temp = new Set(isMultiplayer(state) ? allTempSubCandidates(state) : state.tempSubCandidates ?? []);
  const list: { p: Player; r: number }[] = [];
  for (const p of Object.values(state.players)) {
    if (p.status !== 'active' || p.teamId) continue;
    if (isTempOrWild(p) || gacha.has(p.id) || temp.has(p.id)) continue;
    list.push({ p, r: overallRating(p) });
  }
  list.sort((a, b) => b.r - a.r);
  return list.map((x) => x.p);
}

/** 保证自由选手池 ≥ CONFIG.market.freeAgentPoolMin（不足时 generation.generatePlayer 补充，等级分布偏低） */
export function refreshFreeAgents(state: GameState): void {
  const m = CONFIG.market;
  const fas = freeAgents(state);

  // 池子过大：身价最低（综合等级/战力/年龄/天赋）的程序化选手退出职业圈（真实选手保留；
  // 本赛季的新秀——选秀落选后进入自由市场——在登场赛季内保留，isRookie 在赛季结算时清除）
  if (fas.length > m.freeAgentPoolMax) {
    let excess = fas.length - m.freeAgentPoolMax;
    const removable = fas
      .filter((p) => !p.isReal && !p.isRookie)
      .map((p) => ({ p, v: marketValue(state, p) }))
      .sort((a, b) => a.v - b.v);
    for (const { p } of removable) {
      if (excess <= 0) break;
      p.status = 'retired';
      excess -= 1;
    }
    return;
  }

  let need = m.freeAgentPoolMin - fas.length;
  if (need <= 0) return;
  const rng = rngOf(state);
  const posCount = Object.fromEntries(POSITIONS.map((pos) => [pos, 0])) as Record<Position, number>;
  for (const p of fas) posCount[p.position] = (posCount[p.position] ?? 0) + 1;
  const weights = TIERS.map((t) => m.freeAgentTierWeights[t] ?? 0);
  while (need-- > 0) {
    // 补最缺的位置
    let pos: Position = POSITIONS[0];
    for (const q of POSITIONS) if (posCount[q] < posCount[pos]) pos = q;
    const tier = rng.weighted(TIERS, weights);
    const p = generatePlayer(state, { tier, position: pos });
    if (p.teamId) continue;
    posCount[pos] += 1;
  }
}

/** 选手加盟意愿 0..1：sigmoid((teamHonor - tierHonorExpectation[tier]) / scale)，加薪/冠军队可提高 */
export function playerWillingness(state: GameState, playerId: string, teamId: string): number {
  const p = state.players[playerId];
  const team = state.teams[teamId];
  if (!p || !team || team.disbanded || p.status !== 'active') return 0;
  if (p.teamId === teamId) return 1;
  const m = CONFIG.market;
  const tier = playerTier(p);
  let x = (team.honor - (m.tierHonorExpectation[tier] ?? 0)) / m.playerWillingnessHonorScale;
  if (!p.teamId) x += m.freeAgentWillingnessBonus;
  else x += ((LOYALTY_NEUTRAL - effectiveAttr(p, 'loyalty')) / 100) * m.loyaltyWillingnessFactor;
  if (isReigningChampion(state, teamId)) x += m.championWillingnessBonus;
  x += willingnessJitter(state, playerId, teamId);
  const [lo, hi] = m.willingnessRange;
  return clamp(sigmoid(x), lo, hi);
}

/**
 * 选手对某俱乐部意愿的个体浮动（sigmoid 自变量偏移，三角分布 ±CONFIG.market.willingnessJitter）。
 * 由 存档 × 选手 × 俱乐部 × 赛季 哈希决定：同一赛季内稳定、可复现，不消耗主随机序列；新赛季重新浮动。
 */
export function willingnessJitter(state: GameState, playerId: string, teamId: string): number {
  const spread = CONFIG.market.willingnessJitter;
  if (!(spread > 0)) return 0;
  const key = `${state.id ?? ''}|${playerId}|${teamId}|${state.season?.ti ?? 0}`;
  const u1 = ((hashSeed(`${key}|a`) >>> 0) % 1_000_000) / 1_000_000;
  const u2 = ((hashSeed(`${key}|b`) >>> 0) % 1_000_000) / 1_000_000;
  return (u1 + u2 - 1) * spread; // 三角分布：集中在 0 附近，最大 ±spread
}

/** 签约自由选手的签字费 = 身价 × signingFeeRatio */
export function signingFee(state: GameState, p: Player): number {
  return roundFee(marketValue(state, p) * CONFIG.economy.signingFeeRatio);
}

/**
 * 签约自由选手：检查窗口/资金/意愿（按意愿概率判定），支付签字费，签约（honor.changeHonor 按等级加分）。
 * 阵容人数只在达到绝对上限（team.hardMaxRoster）时阻止；超出常规上限（team.maxRoster）照常签约（工资照付、替补归属感下降更快）。
 */
export function signFreeAgent(state: GameState, playerId: string): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  if (!isTransferWindowOpen(state)) return { ok: false, message: '转会窗口已关闭（TI 预选与正赛期间锁定）' };
  const p = state.players[playerId];
  if (!p) return { ok: false, message: '选手不存在' };
  if (p.status !== 'active') return { ok: false, message: `${p.handle} 当前无法签约` };
  if (p.teamId === team.id) return { ok: false, message: `${p.handle} 已经是你的队员了` };
  if (p.teamId && state.teams[p.teamId]?.isPlayer) {
    // 多人模式：先到先得 —— 已被其他玩家签下
    return { ok: false, message: `${p.handle} 已被 ${state.teams[p.teamId].name} 签下` };
  }
  if (p.teamId) return { ok: false, message: `${p.handle} 已有东家，请通过转会报价求购` };
  if (isTempOrWild(p) || state.gachaPool.includes(p.id) || state.tempSubCandidates.includes(p.id)) {
    return { ok: false, message: `${p.handle} 不在自由市场中` };
  }
  const full = rosterSigningBlock(state, team.id);
  if (full) return { ok: false, message: full };
  const fee = signingFee(state, p);
  if (team.gold < fee) return { ok: false, message: `资金不足：签字费需要 ${formatGold(fee)}` };

  const will = playerWillingness(state, p.id, team.id);
  if (negotiationRoll(state, `sign|${p.id}|${team.id}`) >= will) {
    return {
      ok: false,
      message: `${p.handle} 婉拒了邀约（加盟意愿 ${Math.round(will * 100)}%）。俱乐部荣誉越高越容易打动他，也可下回合再谈。`,
    };
  }

  const rng = rngOf(state);
  const tier = playerTier(p);
  addFinance(state, team.id, -fee, 'signing', `签约自由选手 ${p.handle}`);
  // 工资：按本俱乐部地位开价（salary.signingSalary：荣誉 / 明星系数，不低于市场工资）
  addPlayerToTeam(state, p.id, team.id, { salary: signingSalary(state, p, team.id), contractSeasons: contractLength(rng) });
  p.loyalty = newSigningLoyalty(will);
  const bonus = CONFIG.honor.transfer.signTierBonus[tier] ?? 0;
  if (bonus) changeHonor(state, team.id, bonus, `签下 ${tier} 级选手 ${p.handle}`);
  addNews(
    state,
    'transfer',
    `【官宣】${p.handle} 加盟 ${team.name}`,
    `${team.name} 以 ${formatGold(fee)} 签字费签下自由选手 ${p.handle}（${tier} 级 · ${POSITION_LABEL[p.position]}），工资 ${formatGold(p.salary)}/回合，合同至 TI${p.contractUntil}。`,
    isHighProfile(p),
  );
  return { ok: true, message: `成功签下 ${p.handle}，签字费 ${formatGold(fee)}` };
}

/** 建议转会费（身价 × 1.1~1.5，受选手在原队重要度影响） */
export function suggestedFee(state: GameState, playerId: string): number {
  const p = state.players[playerId];
  if (!p) return 0;
  const m = CONFIG.market;
  const importance = importanceInTeam(state, p);
  return roundFee(marketValue(state, p) * (m.suggestedFeeBase + importance * m.suggestedFeeImportanceMult));
}

/** AI 接受报价概率 = acceptBase + (fee/身价 - 1) × acceptSlope - 重要度 + 归属感修正 */
export function aiAcceptChance(state: GameState, p: Player, fee: number): number {
  const m = CONFIG.market;
  const value = Math.max(1, marketValue(state, p));
  const loyaltyTerm = ((LOYALTY_NEUTRAL - effectiveAttr(p, 'loyalty')) / 100) * m.acceptLoyaltyFactor;
  return clamp(m.acceptBase + (fee / value - 1) * m.acceptSlope - importanceInTeam(state, p) + loyaltyTerm, 0, 1);
}

/**
 * 执行转会（任意两队之间，或自由选手加盟）：双方账目、移出/签入、清理该选手其他报价、原队自动排阵。
 * 不处理荣誉与新闻（由调用方决定）。
 */
export function executeTransfer(
  state: GameState,
  playerId: string,
  toTeamId: string,
  fee: number,
  opts: { salary?: number; contractSeasons?: number; loyalty?: number } = {},
): boolean {
  const p = state.players[playerId];
  const to = state.teams[toTeamId];
  if (!p || !to || p.teamId === toTeamId) return false;
  const fromId = p.teamId;
  const from = fromId ? state.teams[fromId] : undefined;
  const amount = Math.max(0, Math.round(fee));
  if (amount > 0) {
    addFinance(state, to.id, -amount, 'transfer_in', `从 ${from?.name ?? '自由市场'} 购入 ${p.handle}`);
    if (from) addFinance(state, from.id, amount, 'transfer_out', `${p.handle} 转会至 ${to.name}`);
  }
  if (fromId) removePlayerFromTeam(state, p.id);
  clearDepartureState(state, p);
  const rng = rngOf(state);
  addPlayerToTeam(state, p.id, to.id, {
    salary: opts.salary ?? computeSalary(state, p),
    contractSeasons: opts.contractSeasons ?? contractLength(rng),
  });
  p.loyalty = clamp(opts.loyalty ?? newSigningLoyalty(0.5), 0, CONFIG.player.maxAttr);
  if (from && !from.disbanded) autoLineup(state, from.id);
  return true;
}

/**
 * 向 AI 战队求购：AI 接受概率 = acceptBase + (fee/身价 - 1) × acceptSlope - 重要度；选手意愿另判；
 * 成交：扣款、对方加款、转入（AI 原队若不足 5 人从自由选手补齐）、荣誉加分；失败返回原因。
 */
export function bidForPlayer(state: GameState, playerId: string, fee: number): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  if (!isTransferWindowOpen(state)) return { ok: false, message: '转会窗口已关闭（TI 预选与正赛期间锁定）' };
  const p = state.players[playerId];
  if (!p || p.status !== 'active') return { ok: false, message: '该选手无法转会' };
  if (!p.teamId) return { ok: false, message: `${p.handle} 是自由身，可直接签约` };
  if (p.teamId === team.id) return { ok: false, message: `${p.handle} 已经是你的队员了` };
  if (isTempOrWild(p)) return { ok: false, message: '临时替补无法转会' };
  const seller = state.teams[p.teamId];
  if (!seller || seller.disbanded) return { ok: false, message: '原战队不存在' };
  if (seller.isPlayer) return { ok: false, message: `${seller.name} 由其他玩家执教，暂不支持直接求购其选手` };
  const offer = Math.round(fee);
  if (!Number.isFinite(offer) || offer <= 0) return { ok: false, message: '报价金额无效' };
  if (team.gold < offer) return { ok: false, message: `资金不足：报价 ${formatGold(offer)}，账上仅 ${formatGold(team.gold)}` };
  // 阵容人数只在达到绝对上限时阻止（超出常规上限照常引进）
  const full = rosterSigningBlock(state, team.id);
  if (full) return { ok: false, message: full };

  const accept = aiAcceptChance(state, p, offer);
  if (negotiationRoll(state, `bid|${p.id}`) >= accept) {
    const ref = suggestedFee(state, p.id);
    const hint = offer < ref ? `对方认为报价太低（参考价约 ${formatGold(ref)}）` : '对方暂时不想放人，可提高报价或下回合再谈';
    return { ok: false, message: `${seller.name} 拒绝了对 ${p.handle} 的报价：${hint}` };
  }
  const will = playerWillingness(state, p.id, team.id);
  if (negotiationRoll(state, `bidwill|${p.id}|${team.id}`) >= will) {
    return {
      ok: false,
      message: `${seller.name} 同意放人，但 ${p.handle} 不愿加盟（意愿 ${Math.round(will * 100)}%）。提升荣誉会更有吸引力。`,
    };
  }

  const tier = playerTier(p);
  const rng = rngOf(state);
  executeTransfer(state, p.id, team.id, offer, {
    salary: signingSalary(state, p, team.id),
    contractSeasons: contractLength(rng),
    loyalty: newSigningLoyalty(will),
  });
  const bonus = CONFIG.honor.transfer.signTierBonus[tier] ?? 0;
  if (bonus) changeHonor(state, team.id, bonus, `引进 ${tier} 级选手 ${p.handle}`);
  // AI 原队补齐阵容
  fillRosterFromMarket(state, seller.id, CONFIG.ai.minRoster);
  addNews(
    state,
    'transfer',
    `【重磅转会】${p.handle} 从 ${seller.name} 加盟 ${team.name}`,
    `${team.name} 以 ${formatGold(offer)} 的转会费从 ${seller.name} 签下 ${p.handle}（${tier} 级 · ${POSITION_LABEL[p.position]}），合同至 TI${p.contractUntil}。`,
    isHighProfile(p),
  );
  return { ok: true, message: `转会成功！${p.handle} 正式加盟，转会费 ${formatGold(offer)}` };
}

// ---------------------------------------------------------------------------
// AI 补员 / 裁员（供 ai.ts、events.ts 复用）
// ---------------------------------------------------------------------------

/** 战队缺失的位置（无任何正式队员担任该位置） */
function missingPositions(state: GameState, teamId: string): Position[] {
  const have = new Set(regularRoster(state, teamId).map((p) => p.position));
  return POSITIONS.filter((pos) => !have.has(pos));
}

/** AI 能否负担：付完签字费后，余额仍能覆盖（现有工资 + 新增工资）× signBudgetRounds */
function canAfford(state: GameState, team: Team, fee: number, salary: number): boolean {
  return team.gold - fee >= (roundWageBill(state, team.id) + salary) * CONFIG.ai.signBudgetRounds;
}

/**
 * 从自由选手池中为 AI 战队挑选某位置的最佳可负担、愿意加盟的选手（pool 按评分降序）。
 * position 为空时不限位置。
 */
export function pickAffordableFreeAgent(
  state: GameState,
  team: Team,
  pool: Player[],
  position?: Position,
  minRating = 0,
): Player | null {
  for (const p of pool) {
    if (p.teamId || p.status !== 'active') continue;
    if (position && p.position !== position) continue;
    if (overallRating(p) <= minRating) return null; // 降序：后面只会更弱
    const fee = signingFee(state, p);
    if (!canAfford(state, team, fee, computeSalary(state, p))) continue;
    if (playerWillingness(state, p.id, team.id) < CONFIG.ai.minWillingness) continue;
    return p;
  }
  return null;
}

/** AI 签下自由选手（支付签字费），并从 pool 中移除 */
export function aiSignFreeAgent(state: GameState, team: Team, p: Player, pool?: Player[]): void {
  const fee = signingFee(state, p);
  const rng = rngOf(state);
  executeTransfer(state, p.id, team.id, 0, {
    salary: computeSalary(state, p),
    contractSeasons: contractLength(rng),
    loyalty: newSigningLoyalty(playerWillingness(state, p.id, team.id)),
  });
  if (fee > 0) addFinance(state, team.id, -fee, 'signing', `签约 ${p.handle}`);
  if (pool) {
    const i = pool.indexOf(p);
    if (i >= 0) pool.splice(i, 1);
  }
}

/** AI 补员时的程序化选手等级：略低于队内平均等级 */
function fallbackTier(state: GameState, teamId: string, rng: Rng): Tier {
  const roster = regularRoster(state, teamId);
  const avg = roster.length
    ? roster.reduce((s, p) => s + tierIndex(playerTier(p)), 0) / roster.length
    : tierIndex('B');
  const idx = clamp(Math.round(avg) - rng.int(0, 1), 0, TIERS.length - 1);
  return TIERS[idx];
}

/**
 * 补齐 AI 战队阵容至 target 人：优先补缺失位置，自由选手（可负担且愿意）优先，否则生成程序化选手。
 * pool 不传时内部计算一次 freeAgents。返回新加入的选手。
 */
export function fillRosterFromMarket(
  state: GameState,
  teamId: string,
  target: number = CONFIG.ai.minRoster,
  pool?: Player[],
): Player[] {
  const team = state.teams[teamId];
  if (!team || team.disbanded) return [];
  const rng = rngOf(state);
  const signed: Player[] = [];
  let count = regularRoster(state, teamId).length;
  if (count >= target) return signed;
  const fa = pool ?? freeAgents(state);
  let guard = target + 5;
  while (count < target && guard-- > 0) {
    const missing = missingPositions(state, teamId);
    const pos = missing.length ? missing[0] : rng.pick(POSITIONS);
    let p = pickAffordableFreeAgent(state, team, fa, pos);
    if (p) {
      aiSignFreeAgent(state, team, p, fa);
    } else {
      p = generatePlayer(state, { tier: fallbackTier(state, teamId, rng), position: pos, region: team.region });
      addPlayerToTeam(state, p.id, team.id, { salary: computeSalary(state, p), contractSeasons: contractLength(rng) });
      p.loyalty = newSigningLoyalty(0.5);
    }
    if (p.teamId !== team.id) break; // 防御：签约失败
    signed.push(p);
    count += 1;
  }
  autoLineup(state, teamId);
  return signed;
}

/** 将阵容裁到 max 人：释放评分最低的替补（不动首发、不动临时替补），返回被释放者 */
export function trimRoster(state: GameState, teamId: string, max: number = CONFIG.ai.maxRoster): Player[] {
  const team = state.teams[teamId];
  if (!team) return [];
  const released: Player[] = [];
  let roster = regularRoster(state, teamId);
  let guard = roster.length;
  while (roster.length > max && guard-- > 0) {
    const starters = new Set(
      lineupPlayers(state, teamId).map((s) => s.player?.id).filter((x): x is string => !!x),
    );
    const bench = roster.filter((p) => !starters.has(p.id));
    const pool = bench.length ? bench : roster;
    let worst = pool[0];
    for (const p of pool) if (overallRating(p) < overallRating(worst)) worst = p;
    removePlayerFromTeam(state, worst.id);
    clearDepartureState(state, worst);
    released.push(worst);
    roster = regularRoster(state, teamId);
  }
  if (released.length) autoLineup(state, teamId);
  return released;
}

/** 为报价挑选「更富有」的 AI 买家：资金足以支付并留有余量，按资金加权 */
export function pickOfferBuyer(state: GameState, fee: number, rng: Rng, excludeTeamIds: string[] = []): Team | null {
  const exclude = new Set(excludeTeamIds);
  const cands = activeTeams(state).filter(
    (t) => !t.isPlayer && !exclude.has(t.id) && t.gold - fee >= roundWageBill(state, t.id) * CONFIG.ai.signBudgetRounds,
  );
  if (!cands.length) return null;
  return rng.weighted(cands, cands.map((t) => Math.max(1, t.gold - fee)));
}

// ---------------------------------------------------------------------------
// 报价（AI → 玩家）
// ---------------------------------------------------------------------------

/** 创建 AI 对玩家选手的报价（写入 transferOffers） */
export function createTransferOffer(state: GameState, p: Player, buyer: Team, fee: number, poach = false): TransferOffer {
  const offer: TransferOffer = {
    id: nextId(state, 'of'),
    playerId: p.id,
    fromTeamId: buyer.id,
    toTeamId: p.teamId ?? '',
    fee: Math.round(fee),
    salary: Math.round(Math.max(p.salary, computeSalary(state, p)) * CONFIG.market.offerSalaryRaise),
    status: 'pending',
    createdRound: state.roundIndex,
    expiresRound: state.roundIndex + CONFIG.market.offerExpireRounds,
    season: state.season?.ti,
    poach,
  };
  state.transferOffers.push(offer);
  pruneOffers(state);
  return offer;
}

/** 保留全部待处理报价 + 最近 offerHistoryMax 条已处理报价 */
function pruneOffers(state: GameState): void {
  const max = CONFIG.market.offerHistoryMax;
  const done = state.transferOffers.filter((o) => o.status !== 'pending');
  if (done.length <= max) return;
  const drop = new Set(done.slice(0, done.length - max).map((o) => o.id));
  state.transferOffers = state.transferOffers.filter((o) => !drop.has(o.id));
}

function isOfferValid(state: GameState, o: TransferOffer): boolean {
  if (o.status !== 'pending') return false;
  if (o.season !== undefined && o.season !== state.season?.ti) return false;
  if (state.roundIndex >= o.expiresRound) return false;
  const p = state.players[o.playerId];
  if (!p || p.status !== 'active' || p.teamId !== o.toTeamId) return false;
  const buyer = state.teams[o.fromTeamId];
  return !!buyer && !buyer.disbanded;
}

/**
 * 每回合（窗口开放时）AI 对玩家选手发起报价，写入 transferOffers 与新闻。
 * 归属感低、薪资差 g 大（salary.ts，隐藏）的选手更易被盯上：报价概率 × (1 + k × 阵中最大 g)，目标权重 × (1 + k' × g)。
 */
export function generateAiOffers(state: GameState): void {
  if (state.gameOver || !isTransferWindowOpen(state)) return;
  const team = playerTeamOrNull(state);
  if (!team) return;
  const rng = rngOf(state);
  const pending = new Set(state.transferOffers.filter((o) => o.status === 'pending').map((o) => o.playerId));
  const cands = regularRoster(state, team.id).filter((p) => !isTempOrWild(p) && !pending.has(p.id));
  const gaps = cands.map((p) => Math.max(0, salaryGap(state, p)));
  const maxGap = gaps.reduce((m, g) => Math.max(m, g), 0);
  if (!rng.chance(aiOfferChance(CONFIG.market.aiOfferChancePerRound, maxGap))) return;
  if (!cands.length) return;
  const weights = cands.map(
    (p, i) => Math.sqrt(Math.max(1, marketValue(state, p)))
      * (1 + ((100 - effectiveAttr(p, 'loyalty')) / 100) * CONFIG.market.aiOfferLoyaltyWeight)
      * offerGapWeight(gaps[i]),
  );
  const target = rng.weighted(cands, weights);
  const [lo, hi] = CONFIG.market.aiOfferFeeRange;
  const fee = roundFee(marketValue(state, target) * rng.range(lo, hi));
  if (fee <= 0) return;
  const buyer = pickOfferBuyer(state, fee, rng, [team.id]);
  if (!buyer) return;
  const offer = createTransferOffer(state, target, buyer, fee, false);
  const wants = effectiveAttr(target, 'loyalty') < CONFIG.loyalty.leaveThreshold;
  addNews(
    state,
    'transfer',
    `【报价】${buyer.name} 求购 ${target.handle}`,
    `${buyer.name} 开出 ${formatGold(offer.fee)} 求购 ${target.handle}（身价约 ${formatGold(marketValue(state, target))}），并承诺工资 ${formatGold(offer.salary)}/回合。` +
      `${wants ? `${target.handle} 归属感偏低，似乎对这份报价很心动。` : ''}请在 转会市场 → 报价 中回应（${CONFIG.market.offerExpireRounds} 回合内有效）。`,
    true,
  );
}

/** 回应报价：接受 → 选手转出、收款、荣誉按等级扣分；拒绝 → 该选手归属感小幅下降（若其想走，或是被挖角的薪资强烈不满者） */
export function respondToOffer(state: GameState, offerId: string, accept: boolean): OpResult {
  const offer = state.transferOffers.find((o) => o.id === offerId);
  if (!offer) return { ok: false, message: '报价不存在' };
  if (offer.status !== 'pending') {
    removeOfferDecisions(state, offer.id);
    return { ok: false, message: '该报价已处理或已过期' };
  }
  const team = playerTeamOrNull(state);
  if (!team || offer.toTeamId !== team.id) return { ok: false, message: '这不是给你战队的报价' };
  if (!isOfferValid(state, offer)) {
    offer.status = 'expired';
    removeOfferDecisions(state, offer.id);
    return { ok: false, message: '报价已失效（过期或选手/买家状态变化）' };
  }
  const p = state.players[offer.playerId];
  const buyer = state.teams[offer.fromTeamId];

  if (!accept) {
    offer.status = 'rejected';
    removeOfferDecisions(state, offer.id);
    let extra = '';
    // 想走的选手（归属感低于离队阈值），或被挖角的、对薪资强烈不满的选手：拒绝会让他更失望
    const wantsOut = effectiveAttr(p, 'loyalty') < CONFIG.loyalty.leaveThreshold
      || (!!offer.poach && playerSalaryMood(state, p) === 'strong');
    if (wantsOut) {
      adjustLoyalty(p, CONFIG.market.declineLoyaltyPenalty);
      extra = `${p.handle} 对此颇为不满，归属感进一步下降。`;
    }
    return { ok: true, message: `已拒绝 ${buyer.name} 对 ${p.handle} 的报价。${extra}` };
  }

  if (!isTransferWindowOpen(state)) return { ok: false, message: '转会窗口已关闭，暂时无法完成交易' };
  if (buyer.gold < offer.fee) {
    offer.status = 'expired';
    removeOfferDecisions(state, offer.id);
    return { ok: false, message: `${buyer.name} 资金不足，报价作废` };
  }
  const tier = playerTier(p);
  executeTransfer(state, p.id, buyer.id, offer.fee, { salary: offer.salary });
  offer.status = 'accepted';
  removeOfferDecisions(state, offer.id);
  const penalty = CONFIG.honor.transfer.sellTierPenalty[tier] ?? 0;
  if (penalty) changeHonor(state, team.id, penalty, `出售 ${tier} 级选手 ${p.handle}`);
  trimRoster(state, buyer.id, CONFIG.ai.maxRoster);
  autoLineup(state, buyer.id);
  autoLineup(state, team.id);
  addNews(
    state,
    'transfer',
    `【官宣】${p.handle} 转会 ${buyer.name}`,
    `${team.name} 接受报价，${p.handle} 以 ${formatGold(offer.fee)} 的转会费加盟 ${buyer.name}。`,
    isHighProfile(p),
  );
  const short = regularRoster(state, team.id).length < POSITIONS.length;
  return {
    ok: true,
    message: `已将 ${p.handle} 以 ${formatGold(offer.fee)} 出售给 ${buyer.name}${short ? '（阵容不足 5 人，请尽快补强）' : ''}`,
  };
}

/** 处理过期报价（每回合） */
export function expireOffers(state: GameState): void {
  const nextPhase = state.season?.rounds?.[state.roundIndex + 1]?.phase;
  const windowClosingSoon = nextPhase !== undefined && nextPhase !== 'preseason' && nextPhase !== 'regular';
  for (const o of state.transferOffers) {
    if (o.status !== 'pending') continue;
    const stale =
      !isOfferValid(state, o) || state.roundIndex + 1 >= o.expiresRound || windowClosingSoon;
    if (stale) {
      o.status = 'expired';
      removeOfferDecisions(state, o.id);
    }
  }
  pruneOffers(state);
}

// ---------------------------------------------------------------------------
// 解约 / 离队 / 续约
// ---------------------------------------------------------------------------

/**
 * 选手以自由身离开当前战队（无补偿、无荣誉变化），清理相关报价与决策。
 * 临时替补：清除临时标记，程序化野外替补直接从 state.players 删除（与 releaseTempSubs 一致）。
 */
export function departToFreeAgency(state: GameState, playerId: string): void {
  const p = state.players[playerId];
  if (!p || !p.teamId) return;
  const teamId = p.teamId;
  removePlayerFromTeam(state, p.id);
  clearDepartureState(state, p);
  if (p.tempSubUntilTournament) {
    delete p.tempSubUntilTournament;
    if (p.isWildSub && !p.isReal) delete state.players[p.id];
    else delete p.isWildSub;
  }
  if (state.teams[teamId] && !state.teams[teamId].disbanded) autoLineup(state, teamId);
}

/** 解约补偿预估（与 releasePlayer 实际扣款一致；合同已到期为 0） */
export function releaseCompensation(state: GameState, playerId: string): number {
  const p = state.players[playerId];
  if (!p) return 0;
  // 本届选秀选中的新秀：赛季初可免费放弃（releasePlayer 转给 rookieDraft.releaseDraftedRookie）
  if (p.draft && draftedRookieReleaseBlock(state, p) === null) return 0;
  const ti = state.season?.ti ?? p.contractUntil;
  if (p.contractUntil < ti) return 0;
  const remaining = p.contractUntil - ti + 1;
  return Math.round(Math.max(0, p.salary) * CONFIG.market.releaseCompRoundsPerSeason * remaining);
}

/** 批量解约：逐个执行 releasePlayer，汇总结果（任一成功即 ok） */
export function releasePlayers(state: GameState, playerIds: string[]): OpResult {
  const done: string[] = [];
  const failed: string[] = [];
  let total = 0;
  for (const id of playerIds) {
    const p = state.players[id];
    if (!p) continue;
    const comp = releaseCompensation(state, id);
    const r = releasePlayer(state, id);
    if (r.ok) {
      done.push(p.handle);
      total += comp;
    } else {
      failed.push(`${p.handle}（${r.message}）`);
    }
  }
  if (!done.length) return { ok: false, message: failed.length ? `解约失败：${failed.join('；')}` : '未选择选手' };
  let message = `已解约 ${done.length} 人：${done.join('、')}，共支付补偿 ${formatGold(total)}`;
  if (failed.length) message += `\n未能解约：${failed.join('；')}`;
  return { ok: true, message };
}

/**
 * 解约：支付剩余合同赛季工资 × 2 回合作为补偿，荣誉 releasePenalty，选手成为自由选手。
 * 合同已到期（待续约）的选手：无补偿、不扣荣誉（等同「放他离开」）。
 */
export function releasePlayer(state: GameState, playerId: string): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  const p = state.players[playerId];
  if (!p || p.teamId !== team.id) return { ok: false, message: '该选手不在你的战队' };
  if (p.tempSubUntilTournament) return { ok: false, message: '临时替补会在赛事结束后自动离队' };
  // 本届选秀选中的新秀在赛季初免费放弃（无补偿、不扣荣誉），无论从哪个入口解约
  if (p.draft && draftedRookieReleaseBlock(state, p) === null) return releaseDraftedRookie(state, p.id);
  if (!isTransferWindowOpen(state)) return { ok: false, message: '转会窗口已关闭（TI 预选与正赛期间锁定）' };
  const ti = state.season?.ti ?? p.contractUntil;
  if (p.contractUntil < ti) {
    departToFreeAgency(state, p.id);
    addNews(state, 'transfer', `【合同到期】${p.handle} 离开 ${team.name}`, `${p.handle} 合同到期未续，成为自由选手。`);
    return { ok: true, message: `${p.handle} 合同已到期，已放他离开（无需补偿）` };
  }
  const remaining = p.contractUntil - ti + 1;
  const comp = Math.round(Math.max(0, p.salary) * CONFIG.market.releaseCompRoundsPerSeason * remaining);
  if (comp > 0) addFinance(state, team.id, -comp, 'other', `解约补偿 ${p.handle}`);
  departToFreeAgency(state, p.id);
  const penalty = CONFIG.honor.transfer.releasePenalty;
  if (penalty) changeHonor(state, team.id, penalty, `解约 ${p.handle}`);
  addNews(
    state,
    'transfer',
    `【解约】${team.name} 与 ${p.handle} 分道扬镳`,
    `${team.name} 宣布与 ${p.handle} 提前解约，支付补偿 ${formatGold(comp)}。${p.handle} 成为自由选手。`,
  );
  return { ok: true, message: `已与 ${p.handle} 解约，支付补偿 ${formatGold(comp)}` };
}

/**
 * 续约：选手要价 ≥ 隐藏的预期薪资（salary.renewalAsk：预期 × 小幅溢价，归属感低时更高）。
 * offeredSalary 缺省 = 满足要价；给出且低于预期薪资 → 拒绝（提示薪资低于心理预期，不透露数值）；
 * 介于预期与要价之间 → 接受但没有续约的归属感加成。归属感低于 renewRefuseLoyalty 时仍可能拒绝。
 */
export function renewContract(state: GameState, playerId: string, seasons: number, offeredSalary?: number | null): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  const p = state.players[playerId];
  if (!p || p.teamId !== team.id || p.status !== 'active') return { ok: false, message: '该选手不在你的战队' };
  if (p.tempSubUntilTournament) return { ok: false, message: '临时替补无法续约' };
  const [minS, maxS] = CONFIG.economy.contractSeasons;
  const n = clamp(Math.round(Number.isFinite(seasons) ? seasons : minS), minS, maxS);
  const ti = state.season?.ti ?? p.contractUntil;
  const base = Math.max(p.contractUntil, ti - 1);
  const until = Math.min(base + n, ti + maxS);
  if (until <= p.contractUntil) return { ok: false, message: `${p.handle} 的合同已达最长期限（TI${p.contractUntil}）` };

  const m = CONFIG.market;
  const ask = renewalAsk(state, p);
  const expected = expectedSalary(state, p, team.id);
  let offer = ask;
  if (offeredSalary !== undefined && offeredSalary !== null) {
    if (typeof offeredSalary !== 'number' || !Number.isFinite(offeredSalary) || offeredSalary <= 0) {
      return { ok: false, message: '续约报价无效：请输入大于 0 的工资' };
    }
    offer = Math.round(offeredSalary);
    if (offer < expected) {
      return {
        ok: false,
        message: `${p.handle} 拒绝了这份续约报价：薪资低于他的心理预期。可提高报价（他的要价为 ${formatGold(ask)}/回合），或先通过加薪、谈心改善关系。`,
      };
    }
  }
  const loyalty = effectiveAttr(p, 'loyalty');
  if (loyalty < m.renewRefuseLoyalty) {
    const refuse = (m.renewRefuseLoyalty - loyalty) / m.renewRefuseLoyalty;
    if (negotiationRoll(state, `renew|${p.id}`) < refuse) {
      return { ok: false, message: `${p.handle} 拒绝续约：「我想看看外面的世界。」（归属感 ${Math.round(loyalty)}）` };
    }
  }
  const oldSalary = p.salary;
  const salary = offer;
  p.salary = salary;
  p.contractUntil = until;
  endRookieContract(state, p);
  if (salary > oldSalary && salary >= ask) adjustLoyalty(p, m.renewLoyaltyGain);
  addNews(
    state,
    'transfer',
    `【续约】${p.handle} 与 ${team.name} 续约至 TI${until}`,
    `${p.handle} 续约 ${n} 个赛季，工资 ${formatGold(oldSalary)} → ${formatGold(salary)}/回合。`,
  );
  return { ok: true, message: `已与 ${p.handle} 续约至 TI${until}，工资 ${formatGold(salary)}/回合` };
}

// ---------------------------------------------------------------------------
// 临时替补（野外替补）
// ---------------------------------------------------------------------------

/** 清空临时替补候选：未被雇佣的程序化候选直接删除（已退役者可能已转任教练，只摘掉标记，交给赛季初清理） */
export function clearTempSubCandidates(state: GameState): void {
  for (const id of state.tempSubCandidates ?? []) {
    const p = state.players[id];
    if (!p || p.teamId || !p.isWildSub || p.isReal) continue;
    if (p.status === 'active') delete state.players[id];
    else delete p.isWildSub;
  }
  state.tempSubCandidates = [];
}

/**
 * 生成野外替补候选（CONFIG.tempSub.candidates 名，等级分布受荣誉影响，position 可指定），
 * 写入 state.tempSubCandidates（注册为自由选手但不出现在 freeAgents 中）
 */
export function generateTempSubCandidates(state: GameState, position?: Player['position']): Player[] {
  return generateTempSubCandidatesFor(state, position ? [position] : []);
}

/** 同 generateTempSubCandidates，可指定多个位置（候选按位置轮换；空数组 = 缺失位置或全部位置） */
export function generateTempSubCandidatesFor(state: GameState, positions: Position[]): Player[] {
  clearTempSubCandidates(state);
  const team = playerTeamOrNull(state);
  if (!team) return [];
  const rng = rngOf(state);
  const weights = luckAdjustedWeights(CONFIG.tempSub.baseWeights, honorLuck(team.honor));
  const tierWeights = TIERS.map((t) => weights[t]);
  const wanted = positions.filter((q) => POSITIONS.includes(q));
  const missing = missingPositions(state, team.id);
  const order: Position[] = wanted.length ? wanted : missing.length ? missing : POSITIONS;
  const realPool = freeAgents(state).filter((p) => p.isReal);
  const used = new Set<string>();
  const result: Player[] = [];
  for (let i = 0; i < CONFIG.tempSub.candidates; i++) {
    const pos = order[i % order.length];
    const tier = rng.weighted(TIERS, tierWeights);
    let p: Player | undefined;
    if (rng.chance(CONFIG.market.realTempSubChance)) {
      const reals = realPool.filter((r) => r.position === pos && playerTier(r) === tier && !used.has(r.id));
      if (reals.length) p = rng.pick(reals);
    }
    if (!p) {
      p = generatePlayer(state, { tier, position: pos, region: team.region });
      p.isWildSub = true;
    }
    used.add(p.id);
    result.push(p);
  }
  state.tempSubCandidates = result.map((p) => p.id);
  return result;
}

/** 临时替补费用 */
export function tempSubCost(state: GameState, playerId: string): number {
  const p = state.players[playerId];
  if (!p) return 0;
  const tier = playerTier(p);
  return Math.round((CONFIG.economy.salaryByTier[tier] ?? 0) * CONFIG.tempSub.costMult * econ(state));
}

/**
 * 雇佣临时替补：仅效力 tournamentId（tempSubUntilTournament），不占正式阵容名额、不受阵容人数上限限制
 * （同时在队的临时替补至多 market.tempSubMax 人）；扣费；自动补位。
 */
export function hireTempSub(state: GameState, playerId: string, tournamentId: string): OpResult {
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ok: false, message: '战队不存在或游戏已结束' };
  const p = state.players[playerId];
  if (!p || !state.tempSubCandidates.includes(playerId)) return { ok: false, message: '该替补已不在候选名单中' };
  if (p.teamId || p.status !== 'active') return { ok: false, message: `${p.handle} 当前无法雇佣` };
  const t = state.tournaments[tournamentId];
  if (!t) return { ok: false, message: '赛事不存在' };
  if (t.status === 'finished') return { ok: false, message: '赛事已结束' };
  const entered =
    t.playerStatus === 'invited' || t.playerStatus === 'registered' ||
    t.teamIds.includes(team.id) || t.qualifierTeamIds.includes(team.id);
  if (!entered) return { ok: false, message: `你的战队未参加「${t.name}」` };
  const tempMax = Math.max(1, Math.floor(CONFIG.market.tempSubMax));
  if (teamPlayers(state, team.id).filter((x) => x.tempSubUntilTournament).length >= tempMax) {
    return { ok: false, message: `临时替补已有 ${tempMax} 人，无需再招募` };
  }
  const cost = tempSubCost(state, p.id);
  if (team.gold < cost) return { ok: false, message: `资金不足：临时替补费用 ${formatGold(cost)}` };

  addFinance(state, team.id, -cost, 'temp_sub', `临时替补 ${p.handle}（${t.name}）`);
  // 先标记临时替补，addPlayerToTeam 会据此顶替空缺/无法参赛的首发位
  p.tempSubUntilTournament = tournamentId;
  addPlayerToTeam(state, p.id, team.id, { salary: p.salary, contractSeasons: 1 });
  p.contractUntil = state.season?.ti ?? p.contractUntil;
  state.tempSubCandidates = state.tempSubCandidates.filter((id) => id !== p.id);
  autoLineup(state, team.id, tournamentId);
  addNews(
    state,
    'transfer',
    `【野外替补】${p.handle} 临时驰援 ${team.name}`,
    `${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）将代表 ${team.name} 出战「${t.name}」，费用 ${formatGold(cost)}。赛事结束后自动离队。`,
  );
  return { ok: true, message: `已雇佣 ${p.handle} 出战「${t.name}」` };
}

/** 赛事结束后释放临时替补（回到自由选手池或删除程序化选手），并清空 tempSubCandidates */
export function releaseTempSubs(state: GameState, tournamentId: string): void {
  const touched = new Set<string>();
  for (const team of Object.values(state.teams)) {
    for (const id of team.playerIds.slice()) {
      const p = state.players[id];
      if (!p || p.tempSubUntilTournament !== tournamentId) continue;
      removePlayerFromTeam(state, id);
      delete p.tempSubUntilTournament;
      touched.add(team.id);
      if (p.isWildSub && !p.isReal) delete state.players[id];
      else delete p.isWildSub;
    }
  }
  clearTempSubCandidates(state);
  for (const id of touched) if (state.teams[id] && !state.teams[id].disbanded) autoLineup(state, id);
}

// ---------------------------------------------------------------------------
// 合同到期
// ---------------------------------------------------------------------------

/** 合同到期决策的正文（续约要价 + 定性薪资满意度 + 归属感；不含隐藏的预期薪资） */
function contractDecisionText(state: GameState, p: Player, expiringTi: number): { body: string; ask: number } {
  const loyalty = Math.round(effectiveAttr(p, 'loyalty'));
  const ask = renewalAsk(state, p);
  const mood = SALARY_MOOD_LABEL[playerSalaryMood(state, p)];
  const body =
    `${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）的合同在 TI${expiringTi} 后到期。` +
    `他的续约要价为 ${formatGold(ask)}/回合（现 ${formatGold(p.salary)}；目前对薪资${mood}）。当前归属感 ${loyalty}` +
    `${loyalty < CONFIG.market.renewRefuseLoyalty ? '，他可能会拒绝续约' : ''}。`;
  return { body, ask };
}

/**
 * 刷新当前座位待处理的合同到期决策（要价与满意度）：决策在赛季结算时生成，玩家在新赛季回合 0 才处理，
 * 而新赛季的经济指数、近期热度衰减、新秀合同到期都会改变要价 —— 回合开始时按当前状态重算，保证显示的要价与实际续约一致。
 */
export function refreshContractDecisions(state: GameState): void {
  const team = playerTeamOrNull(state);
  if (!team) return;
  for (const d of state.pendingDecisions ?? []) {
    if (d.kind !== 'contract' || !d.ctx) continue;
    const pid = d.ctx.playerId;
    const p = typeof pid === 'string' ? state.players[pid] : undefined;
    if (!p || p.teamId !== team.id || p.status !== 'active') continue;
    const exp = typeof d.ctx.expiringTi === 'number' && Number.isFinite(d.ctx.expiringTi) ? d.ctx.expiringTi : p.contractUntil;
    const { body, ask } = contractDecisionText(state, p, exp);
    d.body = body;
    d.ctx.newSalary = ask;
  }
}

/** 赛季结算：合同到期处理。玩家战队 → 生成续约 PendingDecision（kind 'contract'）；AI → 按归属感/评分续约或放出 */
export function processContractExpiry(state: GameState): void {
  const ti = state.season?.ti;
  if (ti === undefined) return;
  const rng = rngOf(state);

  // 残留的临时替补一律离队
  const lingering = new Set<string>();
  for (const team of Object.values(state.teams)) {
    for (const id of team.playerIds) {
      const t = state.players[id]?.tempSubUntilTournament;
      if (t) lingering.add(t);
    }
  }
  for (const t of lingering) releaseTempSubs(state, t);
  // 未雇佣的候选不跨赛季保留（候选名单是座位私有字段：多人模式每个座位各自清理）
  forEachSeat(state, () => clearTempSubCandidates(state));

  for (const team of Object.values(state.teams)) {
    if (team.disbanded) continue;
    let changed = false;
    const starters = new Set(
      lineupPlayers(state, team.id).map((s) => s.player?.id).filter((x): x is string => !!x),
    );
    for (const id of team.playerIds.slice()) {
      const p = state.players[id];
      if (!p || p.status !== 'active' || p.contractUntil > ti) continue;
      const newSalary = computeSalary(state, p);
      if (team.isPlayer) {
        if (state.gameOver) continue;
        if (isMultiplayer(state) && !seatInPlay(state, team.id)) continue;
        // 多人模式：续约决策写入该战队所属座位
        inSeatOf(state, team.id, () => {
          const exists = state.pendingDecisions.some((d) => d.kind === 'contract' && d.ctx?.playerId === p.id);
          if (exists) return;
          const { body, ask } = contractDecisionText(state, p, ti);
          state.pendingDecisions.push({
            id: nextId(state, 'd'),
            kind: 'contract',
            title: `【合同到期】${p.handle}`,
            body,
            choices: [
              { id: 'renew_1', label: '续约 1 赛季' },
              { id: 'renew_2', label: '续约 2 赛季' },
              { id: 'release', label: '放他离开', description: '合同到期自由离队，无需补偿' },
            ],
            ctx: { playerId: p.id, expiringTi: ti, newSalary: ask },
            createdRound: state.roundIndex,
            blocking: true,
          });
        });
        continue;
      }
      // AI：首发更容易续约，归属感越高越愿意留下
      const base = starters.has(p.id) ? CONFIG.ai.renewStarterChance : CONFIG.ai.renewBenchChance;
      const keep = clamp(base * (0.5 + effectiveAttr(p, 'loyalty') / 100), 0, 1);
      if (rng.chance(keep)) {
        p.contractUntil = ti + contractLength(rng);
        p.salary = newSalary;
      } else {
        removePlayerFromTeam(state, p.id);
        clearDepartureState(state, p);
        changed = true;
        if (isHighProfile(p)) {
          addNews(state, 'transfer', `【自由身】${p.handle} 合同到期离开 ${team.name}`, `${p.handle} 与 ${team.name} 的合同到期未续，成为自由选手，各路豪门闻风而动。`);
        }
      }
    }
    if (changed) autoLineup(state, team.id);
  }
}
