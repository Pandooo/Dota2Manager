// ============================================================================
// 选手交易：向 AI 战队求购时，报价 = 现金 + 本队若干名选手抵价（用户需求 2026-10-14：
// 「我的报价可以通过现金 + 本队队员身价（可多个）× 一定比例折溢价来达到目标队员报价进而完成交易」）。
//
// - 卖方对每名抵价选手的估值 = 身价 × 系数 × 意愿修正（tradeValuation，只读，供界面实时显示）：
//     系数 = CONFIG.market.trade.baseRatio × 需求修正，夹在 ratioRange 内。需求按卖方「目标离队后」的阵容评估：
//     该选手的本职位置（本位置 / 副位置）上没有可用首发 → 溢价（needMult）；评分高于该位置首发 → 溢价（upgradeMult）；
//     只能当替补（位置重叠） → 折价（overlapMult）；超过所打位置的巅峰年龄 → 折价；天梯等级低于该位置首发 → 折价。
//     对方首发被首发优先级锁定（使命 / 巅峰选手，lineupPriority）时视为位置重叠。同一位置的第二名抵价选手与前一名比较。
//     意愿：抵价选手对卖方的加盟意愿低于 minWillingness → 卖方拒收（失败原因点名该选手）；否则按意愿线性折价。
//     刚从自由市场签下的选手（Player.freeAgentSignedClock，不满 freeAgentHoldRounds 个转会回合，或未满足挂牌的加盟门槛——
//     随队 CONFIG.squadOps.listingMinTeamMatches 场 / 入队 listingMinTransferRounds 个转会回合）：系数最多 freeAgentSignedCap（= 签字费比例），
//     「签自由选手 → 立即抵价」无利可图。本队抽卡得到的新秀（抽卡转售冷却 CONFIG.gacha.resaleHoldRounds 未满，或未满足加盟门槛，与挂牌同口径）同样封顶。
// - 报价总额 = 现金 + Σ 估值；对方接受概率沿用 market.aiAcceptChance（fee := 总额）；目标选手加盟意愿照旧另判。
//   谈判骰子与 bidForPlayer 同一组盐值：同一回合里现金报价与交易报价掷的是同一枚骰子（不能靠切换方式刷概率）。
// - 卖方限制：一次最多 maxPlayers 名；卖方阵容在目标离队后超过 CONFIG.ai.maxRoster 时，同回合放走保留价值最低的替补
//   （rookieDraft.aiKeepValue；不放首发、不放顶替目标位置的替补、不放使命成员、不放刚收下的抵价选手——避免「抵价 → 对方放走 → 低价签回」），
//   可放走的替补不够时拒绝并说明；新增工资高于离队者（目标 + 被放走的替补）工资时卖方须能负担（market.canAfford 同口径）。
// - 成交：目标 executeTransfer 到我队（转会费 = 现金）；每名抵价选手 executeTransfer 到卖方（费用 0，账目与新闻写明抵价金额）；
//   卖方超员时放走替补（departToFreeAgency，与 trimRoster 同口径：无补偿、成为自由选手）；
//   引进按 CONFIG.honor.transfer.signTierBonus 加荣誉，送走的选手不扣荣誉；挂牌 / 报价 / 决策由 executeTransfer 清理；
//   卖方自动排阵、不足最少人数时补齐；一条「【交易】」新闻列出双方选手、现金与被放走的替补。
// - 可抵价：本队 active 正式队员（含本赛季抽卡抽到 / 选秀 / 签下 / 购入的选手）；只有临时替补 / 野外替补（含伤病期间招募的赛事临时替补）不可。
// - 多人：只能用调用者座位战队的选手抵价（settings.playerTeamId 为调用者）；目标属于其他人类战队时与 bidForPlayer 同样拒绝。
// ============================================================================
import type { GameState, OpResult, Player, Position, Team } from './types';
import { CONFIG, POSITION_CN, POSITION_LABEL } from './config';
import { rngOf } from './rng';
import { clamp, formatGold, lerp, ownEntry } from './util';
import { addNews } from './news';
import { ageOf, computeSalary, marketValue, overallRating, playerRating, playerTier, tierIndex } from './player';
import { naturalPositions, playsNaturally } from './roles';
import { autoLineup, lineupPlayers, rosterSize } from './team';
import { changeHonor } from './honor';
import { addFinance, roundWageBill } from './economy';
import { syncSynergies } from './synergy';
import { aiKeepValue } from './rookieDraft';
import { aiLineupPriority, lineupPriorityLocks } from './lineupPriority';
import { isMissionPlayerOf } from './missions';
import { gachaResaleLockLeft, listingClock, listingJoinLocked, listingMinTeamMatches, listingMinTransferRounds } from './listingRules';
import { signingSalary } from './salary';
import {
  aiAcceptChance, bidForPlayer, contractLength, departToFreeAgency, executeTransfer, fillRosterFromMarket, isHighProfile,
  isTempOrWild, isTransferWindowOpen, negotiationRoll, newSigningLoyalty, playerTeamOrNull, playerWillingness, regularRoster,
  roundFee, suggestedFee,
} from './market';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 一名抵价选手的估值 */
export interface TradeItem {
  playerId: string;
  handle: string;
  /** 身价 */
  marketValue: number;
  /** 卖方会让他打的位置（本职位置中需求最大的一个） */
  slot: Position;
  /** 需求修正后的身价系数（已夹在 ratioRange 内，不含意愿修正） */
  ratio: number;
  /** 对卖方的加盟意愿 0..1 */
  willingness: number;
  /** 意愿修正（0..1） */
  willMult: number;
  /** 实际系数 = ratio × willMult（界面「身价 × 系数 ≈ 估值」） */
  factor: number;
  /** 估值（身价 × factor，取整到 CONFIG.market.feeRounding；拒收时 0） */
  value: number;
  /** 不能抵价 / 卖方拒收的原因（null = 可以） */
  refused: string | null;
  /** 说明（如「对方缺三号位」「可顶替对方一号位首发」「位置重叠」「年龄偏大」「等级低于其首发」「意愿一般」） */
  notes: string[];
}

/** 一组抵价选手的估值 */
export interface TradeValuation {
  /** 整体不可用的原因（目标无法交易等；此时 items 为空） */
  error: string | null;
  targetId: string;
  sellerId: string | null;
  items: TradeItem[];
  /** Σ 可接收选手的估值 */
  playersValue: number;
  /** 卖方在目标离队后不必放人就能接收的人数（CONFIG.ai.maxRoster − 剩余人数，不小于 0） */
  freeSlots: number;
  /** 卖方为接收抵价选手可以放走的替补 id（按放走顺序：保留价值从低到高；不含首发 / 顶替目标位置的替补 / 使命成员） */
  releasable: string[];
  /** 卖方最多能接收几名选手 = freeSlots + 可放走的替补人数（可为 0） */
  maxIncoming: number;
}

/** 完整报价（现金 + 抵价选手）的评估 */
export interface TradeQuote extends TradeValuation {
  cash: number;
  /** 报价总额 = 现金 + Σ 估值 */
  total: number;
  /** 对方接受概率（market.aiAcceptChance，fee := 总额；有 block 时为 0） */
  accept: number;
  /** 目标选手对我方的加盟意愿 */
  targetWillingness: number;
  /** 成交后卖方要放走的替补 id（阵容超出 CONFIG.ai.maxRoster 时；releasable 的前若干名） */
  releases: string[];
  /** 不能提交的原因（null = 可以提交） */
  block: string | null;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function fail(message: string): OpResult {
  return { ok: false, message };
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** 去重、只保留字符串 id（参数可能来自网络） */
function cleanIds(ids: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(ids)) return out;
  for (const x of ids) if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  return out;
}

/** 目标选手是否可被求购（与 bidForPlayer 的校验一致），返回原因或 { target, seller } */
function targetCheck(state: GameState, team: Team, playerId: string): string | { target: Player; seller: Team } {
  const p = ownEntry(state.players, playerId);
  if (!p || p.status !== 'active') return '该选手无法转会';
  if (!p.teamId) return `${p.handle} 是自由身，可直接签约`;
  if (p.teamId === team.id) return `${p.handle} 已经是你的队员了`;
  if (isTempOrWild(p)) return '临时替补无法转会';
  const seller = state.teams[p.teamId];
  if (!seller || seller.disbanded) return '原战队不存在';
  if (seller.isPlayer) return `${seller.name} 由其他玩家执教，暂不支持直接求购其选手`;
  return { target: p, seller };
}

/** 本队选手不能用于抵价的原因（null = 可以） */
export function tradeOfferBlock(state: GameState, p: Player | null | undefined, team: Team): string | null {
  if (!p) return '选手不存在';
  if (p.teamId !== team.id || p.status !== 'active') return `${p.handle} 不是你的正式队员`;
  if (isTempOrWild(p)) return `${p.handle} 是临时替补，不能抵价`;
  return null;
}

/**
 * 刚从自由市场签下：signFreeAgent 记下的转会回合时钟距今不满 freeAgentHoldRounds，或未满足挂牌的加盟门槛
 * （随队 CONFIG.squadOps.listingMinTeamMatches 场 / 入队 listingMinTransferRounds 个转会回合，与挂牌同一计数；2026-10-15）
 * ——任一成立即按签字费估值（离队时记录清除）。入队转会回合与 freeAgentHoldRounds 同一时钟、同一起点，18 ≥ 6 时实际由 18 回合决定。
 */
function freshFreeAgentSigning(state: GameState, p: Player): boolean {
  const at = p.freeAgentSignedClock;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return listingClock(state) - at < CONFIG.market.trade.freeAgentHoldRounds || listingJoinLocked(state, p);
}

/**
 * 本队抽卡得到的新秀仍受转售限制（与挂牌同口径）：入队不满 gacha.resaleHoldRounds 个转会回合，或未满足挂牌的加盟门槛
 * （随队场数 / 入队转会回合）——任一成立即按签字费估值。只看抽中他的战队（离队后不再受限）。
 */
function gachaRookieResaleLocked(state: GameState, p: Player): boolean {
  if (gachaResaleLockLeft(state, p) > 0) return true;
  return !!p.gacha && !!p.teamId && p.gacha.teamId === p.teamId && listingJoinLocked(state, p);
}

/**
 * 抵价说明里的「入队不满 N 个转会回合」：持有期与加盟门槛的入队转会回合取较长者（默认 18 ≥ 6，即持有期本身）。
 * kind = 'freeAgent'：刚从自由市场签下（market.trade.freeAgentHoldRounds）；'gacha'：本队抽卡得到的新秀（gacha.resaleHoldRounds）。
 * 引擎的估值说明与界面的规则文字（报价弹窗、规则说明）共用，配置改动后两边不会对不上。
 */
export function tradeHoldRoundsLabel(kind: 'freeAgent' | 'gacha'): number {
  const hold = kind === 'gacha' ? CONFIG.gacha.resaleHoldRounds : CONFIG.market.trade.freeAgentHoldRounds;
  return Math.max(Math.floor(Number(hold) || 0), listingMinTransferRounds());
}

/** 卖方某位置的比较基准（首发 / 目标离队后顶上的替补 / 已接收的抵价选手） */
interface Baseline {
  player: Player;
  rating: number;
  /** 首发被首发优先级锁定（使命 / 巅峰选手）：抵价选手不会顶替他 */
  locked: boolean;
}

/**
 * 卖方在目标离队后的各位置基准：首发（不是目标）→ 首发本人；目标的位置 → 剩余替补中打该位置（本职）评分最高者；都没有 → null。
 */
function sellerBaselines(state: GameState, seller: Team, target: Player): Partial<Record<Position, Baseline>> {
  const out: Partial<Record<Position, Baseline>> = {};
  const starters = lineupPlayers(state, seller.id);
  const starterIds = new Set(starters.map((s) => s.player?.id).filter((x): x is string => !!x));
  const bench = regularRoster(state, seller.id).filter((p) => p.id !== target.id && !starterIds.has(p.id));
  const prio = aiLineupPriority(state, seller.id);
  for (const { pos, player } of starters) {
    if (player && player.id !== target.id) {
      out[pos] = { player, rating: playerRating(player, pos), locked: lineupPriorityLocks(state, seller.id, player, pos, null, prio) };
      continue;
    }
    let best: Player | null = null;
    let bestRating = -Infinity;
    for (const c of bench) {
      if (!playsNaturally(c, pos)) continue;
      const r = playerRating(c, pos);
      if (r > bestRating) {
        best = c;
        bestRating = r;
      }
    }
    if (best) out[pos] = { player: best, rating: bestRating, locked: false };
  }
  return out;
}

/**
 * 卖方为接收抵价选手可以放走的替补（按放走顺序：保留价值 aiKeepValue 从低到高，同值按 id）：
 * 不含目标、首发、目标离队后顶上其位置的替补（baselines 中的选手）、临时 / 野外替补与使命成员。
 */
function releasableBench(state: GameState, seller: Team, target: Player, baselines: Partial<Record<Position, Baseline>>): Player[] {
  const keep = new Set<string>([target.id]);
  for (const s of lineupPlayers(state, seller.id)) if (s.player) keep.add(s.player.id);
  for (const b of Object.values(baselines)) if (b) keep.add(b.player.id);
  return regularRoster(state, seller.id)
    .filter((p) => !keep.has(p.id) && !p.isWildSub && !isMissionPlayerOf(state, p.id, seller.id))
    .map((p) => ({ p, v: aiKeepValue(state, p) }))
    .sort((a, b) => a.v - b.v || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))
    .map((x) => x.p);
}

/** 位置说明（中文数字，与新闻一致）：本位置直接写位置名，副位置加注 */
function slotText(p: Player, pos: Position): string {
  return pos === p.position ? POSITION_CN[pos] : `${POSITION_CN[pos]}（副位置）`;
}

/** 年龄修正：超过所打位置巅峰窗口的年份 × (1 − agePenaltyPerYear)，不低于 ageMinMult */
function ageMultOf(state: GameState, p: Player, pos: Position): { mult: number; age: number; over: number } {
  const T = CONFIG.market.trade;
  const age = ageOf(state, p);
  const peakEnd = CONFIG.aging.peakWindow[pos]?.[1] ?? CONFIG.aging.peakWindow[p.position]?.[1] ?? 99;
  const over = Math.max(0, age - peakEnd);
  const mult = over > 0 ? Math.max(T.ageMinMult, 1 - T.agePenaltyPerYear * over) : 1;
  return { mult, age, over };
}

/** 意愿修正：低于 minWillingness 拒收（null）；介于 minWillingness..willingnessFullAt 之间按 willingnessMinMult..1 线性 */
function willMultOf(w: number): number | null {
  const T = CONFIG.market.trade;
  if (w < T.minWillingness) return null;
  const span = Math.max(1e-9, T.willingnessFullAt - T.minWillingness);
  return lerp(T.willingnessMinMult, 1, clamp((w - T.minWillingness) / span, 0, 1));
}

// ---------------------------------------------------------------------------
// 估值（只读）
// ---------------------------------------------------------------------------

/**
 * 卖方对一组抵价选手的估值（只读，不消耗随机数）：每人的身价系数、说明、是否拒收、估值与合计。
 * 同一位置的多名抵价选手按评分从高到低依次评估，后一名与前一名比较（不会都拿到「缺该位置」的溢价）。
 */
export function tradeValuation(state: GameState, targetPlayerId: string, offeredPlayerIds: readonly string[]): TradeValuation {
  const base: TradeValuation = {
    error: null, targetId: targetPlayerId, sellerId: null, items: [], playersValue: 0, freeSlots: 0, releasable: [], maxIncoming: 0,
  };
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return { ...base, error: '战队不存在或游戏已结束' };
  const tc = targetCheck(state, team, targetPlayerId);
  if (typeof tc === 'string') return { ...base, error: tc };
  const { target, seller } = tc;
  base.sellerId = seller.id;
  const baselines = sellerBaselines(state, seller, target);
  base.freeSlots = Math.max(0, CONFIG.ai.maxRoster - (regularRoster(state, seller.id).length - 1));
  base.releasable = releasableBench(state, seller, target, baselines).map((p) => p.id);
  base.maxIncoming = base.freeSlots + base.releasable.length;

  const T = CONFIG.market.trade;
  const [lo, hi] = T.ratioRange;
  const ids = cleanIds(offeredPlayerIds);
  const players = ids.map((id) => ownEntry(state.players, id));
  // 评估顺序：评分从高到低（同分按 id），与 id 的给出顺序无关
  const order = players
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p && a.p ? overallRating(b.p) - overallRating(a.p) || a.p.id.localeCompare(b.p.id) : a.i - b.i));
  const items: TradeItem[] = [];
  for (const { p, i } of order) {
    const id = ids[i];
    const blank: TradeItem = {
      playerId: id, handle: p?.handle ?? id, marketValue: 0, slot: p?.position ?? 'C', ratio: 0, willingness: 0, willMult: 0,
      factor: 0, value: 0, refused: null, notes: [],
    };
    const block = tradeOfferBlock(state, p, team);
    if (block || !p) {
      items.push({ ...blank, refused: block ?? '选手不存在' });
      continue;
    }
    const mv = Math.max(0, marketValue(state, p));
    // 需求：在本职位置中挑需求最大的一个（无首发 > 可顶替 > 位置重叠）
    let slot: Position = p.position;
    let bestKind: 'need' | 'upgrade' | 'overlap' = 'overlap';
    let bestR = -Infinity;
    let bestBase: Baseline | null = null;
    for (const q of naturalPositions(p)) {
      const b = baselines[q];
      if (!b) {
        if (bestKind !== 'need') {
          slot = q;
          bestKind = 'need';
          bestR = Infinity;
          bestBase = null;
        }
        continue;
      }
      if (bestKind === 'need') continue;
      let r = b.rating > 0 ? playerRating(p, q) / b.rating : 2;
      if (b.locked && r >= 1) r = 0.999; // 首发被优先级锁定：不会被顶替，只能算替补
      const kind: 'upgrade' | 'overlap' = r >= 1 ? 'upgrade' : 'overlap';
      if (r > bestR) {
        slot = q;
        bestKind = kind;
        bestR = r;
        bestBase = b;
      }
    }
    const notes: string[] = [];
    let demand: number;
    if (bestKind === 'need') {
      demand = T.needMult;
      notes.push(`对方缺${slotText(p, slot)}`);
    } else if (bestKind === 'upgrade') {
      demand = lerp(T.upgradeMult[0], T.upgradeMult[1], clamp((bestR - 1) / Math.max(1e-9, T.upgradeFullGain), 0, 1));
      notes.push(`可顶替对方${slotText(p, slot)}首发（评分 +${Math.round((bestR - 1) * 100)}%）`);
    } else {
      demand = lerp(T.overlapMult[0], T.overlapMult[1], clamp((bestR - T.overlapFloorRatio) / Math.max(1e-9, 1 - T.overlapFloorRatio), 0, 1));
      notes.push(bestBase?.locked && bestR >= 0.999
        ? `对方${slotText(p, slot)}首发为核心成员，他只能当替补`
        : `与对方${slotText(p, slot)}首发位置重叠，只能当替补`);
    }
    let tierMult = 1;
    if (bestBase && tierIndex(playerTier(p)) < tierIndex(playerTier(bestBase.player))) {
      tierMult = T.tierBelowMult;
      notes.push(`等级低于其首发（${playerTier(p)} < ${playerTier(bestBase.player)}）`);
    }
    const ageInfo = ageMultOf(state, p, slot);
    if (ageInfo.over > 0) notes.push(`年龄偏大（${ageInfo.age} 岁）`);
    const ratio = clamp(T.baseRatio * demand * tierMult * ageInfo.mult, lo, hi);

    const w = playerWillingness(state, p.id, seller.id);
    const willMult = willMultOf(w);
    if (willMult === null) {
      items.push({
        ...blank, marketValue: mv, slot, ratio, willingness: w, willMult: 0, factor: 0, value: 0, notes,
        refused: `${p.handle} 不愿加盟 ${seller.name}（意愿 ${pct(w)}），对方拒收`,
      });
      continue;
    }
    if (willMult < 1) notes.push(`意愿一般（${pct(w)}）`);
    let factor = ratio * willMult;
    if (freshFreeAgentSigning(state, p) && factor > T.freeAgentSignedCap) {
      factor = T.freeAgentSignedCap;
      notes.push(`刚从自由市场签下（入队不满 ${tradeHoldRoundsLabel('freeAgent')} 个转会回合或随队不满 ${listingMinTeamMatches()} 场比赛），对方按签字费估值（身价 × ${T.freeAgentSignedCap}）`);
    } else if (gachaRookieResaleLocked(state, p) && factor > T.freeAgentSignedCap) {
      // 抽卡新秀转售限制（CONFIG.gacha.resaleHoldRounds / 加盟门槛）：堵住「抽卡 → 立即抵价」的套利
      factor = T.freeAgentSignedCap;
      notes.push(`本队抽卡得到的新秀（入队不满 ${tradeHoldRoundsLabel('gacha')} 个转会回合或随队不满 ${listingMinTeamMatches()} 场比赛），对方按签字费估值（身价 × ${T.freeAgentSignedCap}）`);
    }
    const value = roundFee(mv * factor);
    items.push({ ...blank, marketValue: mv, slot, ratio, willingness: w, willMult, factor, value, notes });
    // 成为该位置的新基准（只有真正顶上去的人才改变基准）
    if (bestKind !== 'overlap') baselines[slot] = { player: p, rating: playerRating(p, slot), locked: false };
  }
  // 按给出的顺序返回
  items.sort((a, b) => ids.indexOf(a.playerId) - ids.indexOf(b.playerId));
  const playersValue = items.reduce((s, it) => s + (it.refused ? 0 : it.value), 0);
  return { ...base, items, playersValue };
}

/**
 * 评估一份完整报价（现金 + 抵价选手）：估值、总额、接受概率与不能提交的原因。tradeForPlayer 用同一函数校验，界面显示与实际一致。
 */
export function tradeQuote(state: GameState, targetPlayerId: string, cash: number, offeredPlayerIds: readonly string[]): TradeQuote {
  const v = tradeValuation(state, targetPlayerId, offeredPlayerIds);
  const money = Number.isFinite(cash) ? Math.max(0, Math.round(cash)) : NaN;
  const quote: TradeQuote = {
    ...v, cash: Number.isFinite(money) ? money : 0, total: 0, accept: 0, targetWillingness: 0, releases: [], block: null,
  };
  if (v.error) return { ...quote, block: v.error };
  const team = playerTeamOrNull(state)!;
  const target = state.players[v.targetId];
  const seller = state.teams[v.sellerId!];
  quote.targetWillingness = playerWillingness(state, target.id, team.id);
  const T = CONFIG.market.trade;
  const n = v.items.length;
  // 卖方超员时放走的替补：接收人数超出空余名额的部分（最多 n 名；对方原本就超员的部分不由这笔交易处理）
  quote.releases = v.releasable.slice(0, Math.max(0, n - v.freeSlots));
  const block = ((): string | null => {
    if (!isTransferWindowOpen(state)) return '转会窗口已关闭（TI 预选与正赛期间锁定）';
    if (!n) return '请选择至少一名抵价选手（纯现金请使用普通报价）';
    if (n > T.maxPlayers) return `一次最多用 ${T.maxPlayers} 名选手抵价`;
    const refused = v.items.find((it) => it.refused);
    if (refused) return refused.refused;
    if (n > v.maxIncoming) {
      const cap = CONFIG.ai.maxRoster;
      return v.maxIncoming <= 0
        ? `${seller.name} 阵容已满（AI 阵容上限 ${cap} 人），且没有可以放走的替补（不会为此放走首发或使命成员），无法接收抵价选手`
        : `${seller.name} 最多只能接收 ${v.maxIncoming} 名选手（AI 阵容上限 ${cap} 人，可放走的替补 ${v.releasable.length} 名；不会为此放走首发或使命成员）`;
    }
    if (!Number.isFinite(money)) return '现金金额无效';
    if (money + v.playersValue <= 0) return '报价总额必须大于 0';
    if (team.gold < money) return `资金不足：现金部分 ${formatGold(money)}，账上仅 ${formatGold(team.gold)}`;
    // 我方阵容：换入 1 人、换出 n 人（n ≥ 1 时人数不增，这里与 team.rosterSigningBlock 同口径以防万一）
    if (rosterSize(state, team.id) - n + 1 > CONFIG.team.hardMaxRoster) {
      return `阵容已达绝对上限（${CONFIG.team.hardMaxRoster} 人），请先解约或出售选手`;
    }
    // 卖方工资：新增工资高于离队者（目标 + 被放走的替补）工资时须能负担
    // （market.canAfford 同口径：余额覆盖 (现有 − 离队 + 新增) × signBudgetRounds）
    const incoming = v.items.reduce((s, it) => s + computeSalary(state, state.players[it.playerId]), 0);
    const outgoing = Math.max(0, target.salary) + quote.releases.reduce((s, id) => s + Math.max(0, state.players[id]?.salary ?? 0), 0);
    if (incoming > outgoing) {
      const wage = roundWageBill(state, seller.id) - outgoing + incoming;
      if (seller.gold + money < wage * CONFIG.ai.signBudgetRounds) {
        return `${seller.name} 无法负担抵价选手的工资（可提高现金部分或减少抵价人数）`;
      }
    }
    return null;
  })();
  quote.total = (Number.isFinite(money) ? money : 0) + v.playersValue;
  quote.block = block;
  quote.accept = block ? 0 : aiAcceptChance(state, target, quote.total);
  return quote;
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/**
 * 向 AI 战队求购，报价 = 现金 + 本队若干名选手抵价。抵价选手为空时等同 bidForPlayer（纯现金）。
 * 对方按总额决定是否放人（aiAcceptChance），目标选手再按加盟意愿决定；成交后目标加盟我队、抵价选手加盟对方。
 */
export function tradeForPlayer(state: GameState, targetPlayerId: string, cash: number, offeredPlayerIds: string[]): OpResult {
  const ids = cleanIds(offeredPlayerIds);
  if (!ids.length) return bidForPlayer(state, targetPlayerId, cash);
  const team = playerTeamOrNull(state);
  if (!team || state.gameOver) return fail('战队不存在或游戏已结束');
  const q = tradeQuote(state, targetPlayerId, cash, ids);
  if (q.block) return fail(q.block);
  const target = state.players[q.targetId];
  const seller = state.teams[q.sellerId!];
  const money = q.cash;

  if (negotiationRoll(state, `bid|${target.id}`) >= q.accept) {
    const ref = suggestedFee(state, target.id);
    const hint = q.total < ref
      ? `对方认为报价太低（参考价约 ${formatGold(ref)}）`
      : '对方暂时不想放人，可提高现金部分、更换抵价选手或下回合再谈';
    return fail(`${seller.name} 拒绝了对 ${target.handle} 的交易报价（总额 ${formatGold(q.total)}）：${hint}`);
  }
  const will = q.targetWillingness;
  if (negotiationRoll(state, `bidwill|${target.id}|${team.id}`) >= will) {
    return fail(`${seller.name} 同意交易，但 ${target.handle} 不愿加盟（意愿 ${pct(will)}）。提升荣誉会更有吸引力。`);
  }

  const tier = playerTier(target);
  const rng = rngOf(state);
  const offered = q.items.map((it) => ({ p: state.players[it.playerId], it }));
  executeTransfer(state, target.id, team.id, money, {
    salary: signingSalary(state, target, team.id),
    contractSeasons: contractLength(rng),
    loyalty: newSigningLoyalty(will),
  });
  for (const { p, it } of offered) {
    executeTransfer(state, p.id, seller.id, 0, {
      salary: computeSalary(state, p),
      contractSeasons: contractLength(rng),
      loyalty: newSigningLoyalty(it.willingness),
    });
  }
  // 卖方超员：放走保留价值最低的替补（与 trimRoster 同口径：无补偿，成为自由选手；刚收下的抵价选手不在其中）
  const released: Player[] = [];
  for (const id of q.releases) {
    const r = state.players[id];
    if (!r || r.teamId !== seller.id) continue;
    departToFreeAgency(state, r.id);
    if (!r.teamId) released.push(r);
  }
  const releasedNames = released.map((r) => r.handle).join('、');
  const names = offered.map(({ p, it }) => `${p.handle}（抵价 ${formatGold(it.value)}）`).join('、');
  // 账目：抵价部分不产生现金流，记一条 0 金额的说明，财务页能看到这笔交易的构成
  addFinance(state, team.id, 0, 'transfer_out', `交易 ${target.handle}：以 ${names} 抵价，合计 ${formatGold(q.playersValue)}`, { keepZero: true });
  const bonus = CONFIG.honor.transfer.signTierBonus[tier] ?? 0;
  if (bonus) changeHonor(state, team.id, bonus, `引进 ${tier} 级选手 ${target.handle}`);
  // 卖方阵容：补齐最少人数（通常不需要），重新排阵
  fillRosterFromMarket(state, seller.id, CONFIG.ai.minRoster);
  autoLineup(state, seller.id);
  const important = isHighProfile(target) || offered.some(({ p }) => isHighProfile(p));
  addNews(
    state,
    'transfer',
    `【交易】${target.handle} 加盟 ${team.name}，${offered.map(({ p }) => p.handle).join('、')} 转投 ${seller.name}`,
    `${team.name} 与 ${seller.name} 完成选手交易：${target.handle}（${tier} 级 · ${POSITION_LABEL[target.position]}）加盟 ${team.name}，合同至 TI${target.contractUntil}；` +
      `${team.name} 付出现金 ${formatGold(money)}，并送出 ${names}，报价总额约 ${formatGold(q.total)}（${target.handle} 身价约 ${formatGold(marketValue(state, target))}）。` +
      (released.length ? `${seller.name} 阵容超出上限，放走替补 ${releasedNames}（成为自由选手）。` : ''),
    important,
    {
      teamIds: [team.id, seller.id],
      playerIds: [target.id, ...offered.map(({ p }) => p.id), ...released.map((r) => r.id)],
      actorTeamId: team.id,
    },
  );
  syncSynergies(state); // 羁绊（第十波 #5）：双方阵容都变了
  return {
    ok: true,
    message: `交易成功！${target.handle} 正式加盟（现金 ${formatGold(money)} + ${offered.length} 名选手抵价 ${formatGold(q.playersValue)}）` +
      (released.length ? `；${seller.name} 阵容超员，放走替补 ${releasedNames}` : ''),
  };
}
