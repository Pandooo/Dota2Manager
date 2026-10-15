// ============================================================================
// 「下一回合」自动处理（懒人玩法，用户反馈 2026-10-09：「最懒人的玩法就是可以直接一直点下方的『下一回合』按钮」）
//
// autoHandleRound(state)：在当前座位上下文中（单机 = 玩家；多人 = 已换入的座位）把本回合挡住推进的事务按保守默认处理完：
//   1) 待决事件：按 events.defaultDecisionChoice（与多人托管同一张表：配合调查 / 低调处理 / 替补顶上 / 尝试挽留 /
//      拒绝报价 / 续约 1 赛季 / 不聘用，其余含无厘头事件取第一项）；
//   1a) 超编（2026-10-15 用户决策「十连后本回合内退回到 12 人」；planOverCapTrim）：抽卡让正式阵容超出绝对上限（12 人）时，
//      先退回本回合抽到的新秀中评分最低者（gacha.gachaDiscard，返还单抽价格 × discardRefundRatio），仍超编才解约替补中
//      「放走代价」（解约补偿 + 身价）最低者（market.releasePlayer，正常补偿与荣誉规则），直到降到 12 人以内；
//   1b) 补员（v0.3 选秀取消后，只按「下一回合」的人类战队不再自动得到新秀；planRosterFill，DESIGN.md 3.4.2）：转会窗口开放期间，
//      正式阵容（不含临时 / 野外替补）不能覆盖五个位置（roles.uncoveredPositions，含副位置）或少于 CONFIG.autoRound.minRosterFill 人时，
//      先为缺失的位置、再为替补深度签下负担得起（余额留足工资；先在签下后经常性收入仍付得起工资的人选中挑，
//      没有时才允许首发入不敷出且缺口有上限）、本回合不会婉拒的最强自由选手（market.signFreeAgent，同一枚谈判骰子）；
//      不超过常规阵容上限 team.maxRoster；本回合因事件离队的选手不签回。
//      没有合适人选时不做别的（赛事照常由临时替补顶上），预览中说明原因。不自动抽卡（花钱抽随机卡是玩家的选择）；
//   2) 首发：本回合有比赛要打而首发不合法 → 自动补位 / 排阵（season.ensurePlayableLineup）；可出场选手不足 5 人 →
//      为空位招募「合格（B 级及以上）中最便宜」的临时替补（没有合格的就招最便宜的），负担不起则接受弃权判负；
//   3) 比赛：快速模拟本方在本回合赛事的全部剩余系列赛（与 quickSimTournament 相同）。
//      多人玩家对决：登记快速模拟（对手也自动推进 / 同意时立即结算）、选择自动 BP（对手想手动打也能打）、
//      看完对手开打的一局、双方都是自动 BP 时开打 —— 对手怎么打都不会互相卡死；
//   4) 其余不变（未用的训练在回合结束时本来就会按当前焦点自动使用）。
// 做了实质处理（事件 / 超编 / 补员 / 首发 / 比赛）时写入一条私有新闻「本回合自动处理：…」。
//
// previewAutoActions(state)：纯预览（不修改 state），用于「下一回合」按钮的提示，
// 例如「将自动：快速模拟 2 场比赛 · 默认处理 1 个事件 · 自动补齐首发」；超编处理与补员逐人列出（与实际执行一致：
// 有待决事件或超编时先在状态副本上按默认选项处理事件、处理超编，再按处理后的阵容与账面计划补员）。
//
// 入口：game.advance(state, { auto: true })（单机）；multi.setSeatReady(state, teamId, true, { auto: true })（多人，
// 协议 setRoundReady 的 auto 标记）；multi.autopilotSeat（房主托管离线玩家）同样使用本模块。
// ============================================================================
import type { GameState, H2HMatch, PendingDecision, Player, Position, Series, Tier, Tournament } from './types';
import { POSITIONS } from './types';
import { CONFIG, POSITION_CN } from './config';
import {
  commitGame, currentPlayerTournament, dropStaleMatch, getAdvanceBlockers, h2hSwitchToAutoDraft, playGame,
  quickSimTournament, quickSimSeries, startDraft,
} from './game';
import { FALLBACK_DECISION_CHOICE, defaultDecisionChoice, resolveDecision } from './events';
import { ensurePlayableLineup, fillEmptyLineupSlots } from './season';
import { rosterOverCap, rosterSize, setLineupSlot, teamPlayers, validateLineup } from './team';
import {
  clearTempSubCandidates, freeAgents, generateTempSubCandidates, hireTempSub, isTempOrWild, isTransferWindowOpen, negotiationPredictable,
  negotiationRoll, playerWillingness, releaseCompensation, releasePlayer, signFreeAgent, signingFee, tempSubCost,
} from './market';
import { gachaDiscard, gachaDiscardBlock, gachaDiscardRefund } from './gacha';
import { isAvailable, marketValue, overallRating, playerRating, playerTier, tierIndex } from './player';
import { playsNaturally, uncoveredPositions } from './roles';
import { signingSalary } from './salary';
import { isTeamEliminated, playerNextSeries } from './tournament';
import { currentStep } from './draft';
import { playerTournamentForRound } from './calendar';
import { econ, roundWageBill } from './economy';
import { roundRevenue } from './revenue';
import { addNews } from './news';
import { formatGold, formatRank, ownEntry } from './util';
import { isMultiplayer, seatInPlay } from './seat';

/** 自动招募临时替补的「合格」门槛：B 级及以上（没有负担得起的合格人选时退而求其次招最便宜的，总比弃权好） */
const AUTO_TEMP_SUB_MIN_TIER = 'B' as const;
/** 野外替补就位提示（签证事件「用现有替补顶上」凑不齐时弹出）：自动处理过首发后撤掉（候选已招募或已清空），减少弹窗 */
const TEMP_SUB_POPUP_TITLE = '野外替补已就位';
/** 开赛前的「首发不足 5 人」提醒（season.preparePlayerTournament）：自动处理过该赛事的首发后已过时，一并撤掉 */
const LINEUP_SHORT_POPUP_TITLE = '首发不足 5 人';
/** 自动处理新闻的标签（UI 可据此识别） */
export const AUTO_ROUND_NEWS_TAG = 'auto_round';

/** 一次自动处理的结果 */
export interface AutoRoundReport {
  /** 中文摘要（每项一行；无事可做时为空） */
  lines: string[];
  /** 按默认选项处理的待决事件数 */
  decisions: number;
  /** 快速模拟（含弃权）出结果的本方系列赛数 */
  series: number;
  wins: number;
  losses: number;
  draws: number;
  /** 其中首发不足 5 人弃权判负的场数 */
  forfeits: number;
  /** 超编处理（退回本回合抽到的新秀 / 解约替补，见 planOverCapTrim） */
  trims: OverCapTrim[];
  /** 自动处理后仍超编的人数（没有可退回 / 可解约的人选，需手动处理；正常为 0） */
  overCapLeft: number;
  /** 自动签下的自由选手（补员，见 planRosterFill） */
  signings: AutoSigning[];
  /** 自动补员花费的签字费合计 */
  signingFees: number;
  /** 补员后阵容仍凑不齐五个位置 / 5 人的说明（planRosterFill.shortfall），无则 null */
  rosterShortfall: string | null;
  /** 自动调整了首发（补位 / 排阵，不含招募） */
  lineupFixed: boolean;
  /** 招募的临时替补人数与花费 */
  tempSubs: number;
  tempSubCost: number;
  /** 多人玩家对决：已登记快速模拟，等待对手同意（或等对手手动打完） */
  h2hWaiting: boolean;
  /** 仍需等待的原因（多人：对手 / 其他玩家），无则 null */
  waiting: string | null;
  /** 状态有任何变化（含玩家对决的视图推进、登记、选择自动 BP 等） */
  progressed: boolean;
}

/** 「下一回合」按钮的预览（不修改 state） */
export interface AutoRoundPreview {
  /** 将按默认选项处理的待决事件数（只计会挡住推进的） */
  decisions: number;
  /** 超编人数（正式阵容超出绝对上限 team.hardMaxRoster；0 = 未超编） */
  overCap: number;
  /** 将处理超编：退回本回合抽到的新秀 / 解约替补（与 autoHandleRound 同一份计划） */
  trims: OverCapTrim[];
  /** 自动处理后仍超编的人数（正常为 0） */
  overCapLeft: number;
  /** 将快速模拟的、已排定对手的本方系列赛数（淘汰赛后续轮次视赛果而定，不计入） */
  series: number;
  /** 打完已排定的场次后还可能有比赛（晋级下一轮 / 下一阶段） */
  moreSeries: boolean;
  /** 将自动签下的自由选手（补员；多人客户端视图无法预知婉拒时为首选人选，见 rosterFillExact） */
  signings: AutoSigning[];
  /** false：多人客户端视图不知道服务器的谈判密钥，无法预知选手是否婉拒（婉拒则顺延下一人选） */
  rosterFillExact: boolean;
  /** 阵容仍凑不齐五个位置的说明（如「缺五号位：资金不足：…」），无则 null */
  rosterShortfall: string | null;
  /** rosterShortfall 的原因（RosterFillPlan.shortfallReason），无则 null */
  rosterShortfallReason: RosterShortfallReason | null;
  /** 首发不合法，将自动补位 / 排阵 */
  lineupFix: boolean;
  /** 可出场选手不足 5 人，将招募的临时替补人数 */
  tempSubs: number;
  /** 资金可能不够招募临时替补（不足则弃权判负） */
  forfeitRisk: boolean;
  /** 多人玩家对决：快速模拟需对手同意（对手也点「下一回合」或同意快速模拟时结算） */
  h2h: boolean;
  /** 多人：自动处理后仍需等待（如下一场要等其他玩家的结果），按下后会在可以时自动准备 */
  waiting: string | null;
  /** 自动处理也无法推进的原因（游戏结束 / 观战），null = 可以按 */
  blocked: string | null;
  /** 将自动处理的事项（短语，如「快速模拟 2 场比赛」） */
  items: string[];
  /** 「将自动：…」；无事可做时为空串 */
  text: string;
}

/**
 * 超编处理的一项：discard = 退回本回合抽到的新秀（gacha.gachaDiscard，返还 amount = 单抽价格 × discardRefundRatio，无补偿、不扣荣誉）；
 * release = 解约替补（market.releasePlayer，支付解约补偿 amount、扣荣誉；合同已到期的无补偿、不扣荣誉，expired = true）
 */
export interface OverCapTrim {
  playerId: string;
  handle: string;
  tier: Tier;
  position: Position;
  action: 'discard' | 'release';
  amount: number;
  expired?: boolean;
}

/** 自动补员签下（或计划签下）的一名自由选手 */
export interface AutoSigning {
  playerId: string;
  handle: string;
  tier: Tier;
  /** 补位：为该位置签下（本职，含副位置）；其余：选手的本位置 */
  position: Position;
  /**
   * cover = 为缺失的位置补一名本职选手；fill = 正式阵容不足 5 人且缺失的位置没有合适的本职人选，签一名跨位置首发
   * （按空缺位置的评分选）；depth = 补替补深度（已有 5 人，少于 minRosterFill）
   */
  reason: 'cover' | 'fill' | 'depth';
  /** 签字费 */
  fee: number;
  /** 工资（每回合，按本俱乐部开价 salary.signingSalary） */
  salary: number;
  /** 加盟意愿 0..1 */
  willingness: number;
  /** 补位时替下的跨位置首发（该位置首发不打本职、评分低于新签选手）；无则缺省 */
  replaces?: { playerId: string; handle: string };
}

function emptyReport(): AutoRoundReport {
  return {
    lines: [], decisions: 0, series: 0, wins: 0, losses: 0, draws: 0, forfeits: 0, trims: [], overCapLeft: 0, signings: [], signingFees: 0,
    rosterShortfall: null,
    lineupFixed: false, tempSubs: 0, tempSubCost: 0, h2hWaiting: false, waiting: null, progressed: false,
  };
}

function myTeamId(state: GameState): string {
  return state.settings?.playerTeamId ?? '';
}

/** 当前座位是否还能操作（战队存在、未解散、多人未出局、游戏未结束） */
function canAct(state: GameState): boolean {
  if (state.gameOver) return false;
  const me = myTeamId(state);
  const team = me ? state.teams[me] : undefined;
  if (!team || team.disbanded) return false;
  return !isMultiplayer(state) || seatInPlay(state, me);
}

function liveH2HOf(state: GameState, seriesId: string | null | undefined): H2HMatch | null {
  if (!seriesId) return null;
  const h = state.multiplayer?.h2h?.[seriesId];
  return h && !h.done ? h : null;
}

/** 系列赛双方都是仍在比赛中的玩家（多人模式；与 game.isH2HSeries 同口径） */
function isH2HSeries(state: GameState, s: Series | null | undefined): boolean {
  if (!s || !isMultiplayer(state) || !s.teamA || !s.teamB) return false;
  return seatInPlay(state, s.teamA) && seatInPlay(state, s.teamB);
}

function involves(s: Series, me: string): boolean {
  return s.teamA === me || s.teamB === me;
}

/** 本回合本方的赛事（进行中的比赛优先） */
function roundTournament(state: GameState): Tournament | null {
  const am = state.activeMatch;
  const fromMatch = am ? state.tournaments[am.tournamentId] : undefined;
  if (fromMatch && fromMatch.status !== 'finished') return fromMatch;
  if (state.phase === 'preseason' || state.phase === 'season_end') return null;
  const t = playerTournamentForRound(state, state.roundIndex);
  return t && t.status !== 'finished' ? t : null;
}

/** 可为该赛事出场的本队选手（含本赛事的临时替补；与 ActionBar / team.autoLineup 同口径） */
function fieldable(state: GameState, me: string, tid: string): Player[] {
  return teamPlayers(state, me).filter(
    (p) => isAvailable(p, tid) && (!p.tempSubUntilTournament || p.tempSubUntilTournament === tid),
  );
}

/** 某等级临时替补的费用（与 market.tempSubCost 同法；预览用） */
function tierTempSubCost(state: GameState, tier: Tier): number {
  return Math.round((CONFIG.economy.salaryByTier[tier] ?? 0) * CONFIG.tempSub.costMult * econ(state));
}

// ---------------------------------------------------------------------------
// 1) 待决事件
// ---------------------------------------------------------------------------

/**
 * 按默认选项处理待决事件，返回因此离开本队的选手（离队申请挽留失败、合同到期未续约、退役等）：
 * 同一回合的自动补员不把他们签回来（autoHandleRound 与 previewAutoActions 共用）。
 */
function handleDecisionsTracked(state: GameState, rep: AutoRoundReport): Set<string> {
  const me = myTeamId(state);
  const before = (me && state.teams[me]?.playerIds.slice()) || [];
  handleDecisions(state, rep);
  const now = new Set((me && state.teams[me]?.playerIds) || []);
  return new Set(before.filter((id) => !now.has(id)));
}

function handleDecisions(state: GameState, rep: AutoRoundReport): void {
  const tried = new Set<string>();
  for (let guardN = 0; guardN < 50 && canAct(state); guardN++) {
    const d: PendingDecision | undefined = state.pendingDecisions.find((x) => x.blocking && !tried.has(x.id));
    if (!d) return;
    tried.add(d.id);
    const choice = defaultDecisionChoice(d);
    const label = d.choices.find((c) => c.id === choice)?.label ?? '知道了';
    const title = d.title;
    let r = resolveDecision(state, d.id, choice);
    rep.progressed = true;
    let still = state.pendingDecisions.some((x) => x.id === d.id);
    const fallback = FALLBACK_DECISION_CHOICE[d.kind];
    if (still && fallback && fallback !== choice && d.choices.some((c) => c.id === fallback)) {
      const first = r.message;
      r = resolveDecision(state, d.id, fallback);
      still = state.pendingDecisions.some((x) => x.id === d.id);
      if (!still) {
        rep.decisions += 1;
        rep.lines.push(`${title} → ${d.choices.find((c) => c.id === fallback)?.label ?? fallback}（默认选项未能执行：${first}）${r.message ? `：${r.message}` : ''}`);
        continue;
      }
    }
    if (still) {
      rep.lines.push(`${title}：默认选项「${label}」未能执行（${r.message}），请手动处理`);
      continue;
    }
    rep.decisions += 1;
    rep.lines.push(`${title} → ${label}${r.message ? `：${r.message}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1a) 超编：退回本回合抽到的新秀 / 解约替补，退回绝对上限（2026-10-15 用户决策「十连后本回合内退回到 12 人」）
// ---------------------------------------------------------------------------

/** 超编处理的计划（纯函数，不修改 state） */
export interface OverCapPlan {
  /** 超编人数（0 = 未超编或转会窗口关闭） */
  over: number;
  /** 依次处理的人选 */
  trims: OverCapTrim[];
  /** 计划执行后仍超编的人数（没有更多可退回 / 可解约的人选） */
  left: number;
}

const byIdAsc = (a: Player, b: Player) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 超编处理计划：转会窗口开放且正式阵容超出绝对上限时，先退回本回合抽到、仍可退回的新秀中综合评分最低者（返还部分抽卡费用）；
 * 仍超编时解约替补（不在首发中的正式队员）中「放走代价」最低者：解约补偿（market.releaseCompensation）+ 身价（player.marketValue），
 * 即同时取「价值最低、补偿最少」（合同已到期的无补偿）。exclude：不考虑的人选（执行时意外失败的）。
 */
export function planOverCapTrim(state: GameState, exclude: ReadonlySet<string> = new Set()): OverCapPlan {
  const me = myTeamId(state);
  const team = me ? state.teams[me] : undefined;
  const plan: OverCapPlan = { over: 0, trims: [], left: 0 };
  if (!team || team.disbanded || state.gameOver || !isTransferWindowOpen(state)) return plan;
  const over = rosterOverCap(state, me);
  plan.over = over;
  if (over <= 0) return plan;
  let need = over;
  const roster = regularMembers(state, me).filter((p) => !exclude.has(p.id));
  const discardable = roster.filter((p) => gachaDiscardBlock(state, p) === null);
  const refund = gachaDiscardRefund(state);
  const chosen = new Set<string>();
  for (const p of discardable.slice().sort((a, b) => overallRating(a) - overallRating(b) || byIdAsc(a, b))) {
    if (need <= 0) break;
    plan.trims.push({ playerId: p.id, handle: p.handle, tier: playerTier(p), position: p.position, action: 'discard', amount: refund });
    chosen.add(p.id);
    need--;
  }
  if (need > 0) {
    const starters = new Set(POSITIONS.map((q) => team.lineup?.[q]).filter((x): x is string => !!x));
    const ti = state.season?.ti ?? 0;
    const bench = roster
      .filter((p) => !chosen.has(p.id) && !starters.has(p.id) && !discardable.includes(p))
      .map((p) => {
        const comp = releaseCompensation(state, p.id);
        return { p, comp, cost: comp + marketValue(state, p) };
      })
      .sort((a, b) => a.cost - b.cost || a.comp - b.comp || byIdAsc(a.p, b.p));
    for (const { p, comp } of bench) {
      if (need <= 0) break;
      const expired = p.contractUntil < ti;
      plan.trims.push({
        playerId: p.id, handle: p.handle, tier: playerTier(p), position: p.position, action: 'release', amount: comp,
        ...(expired ? { expired: true } : {}),
      });
      need--;
    }
  }
  plan.left = need;
  return plan;
}

/** 一项超编处理的文字（结果；预览去掉「自动」） */
function trimLine(x: OverCapTrim, preview = false): string {
  const who = `${x.handle}（${x.tier} 级 · ${POSITION_CN[x.position]}）`;
  if (x.action === 'discard') return `${preview ? '' : '超编：自动'}退回本回合抽到的新秀 ${who}，返还 ${formatGold(x.amount)}`;
  return `${preview ? '' : '超编：自动'}解约替补 ${who}${x.expired ? '（合同已到期，无补偿）' : `，支付补偿 ${formatGold(x.amount)}`}`;
}

/** 超编处理的简短事项（预览 / 新闻标题）：「退回 3 名新秀」「解约 1 人」 */
function trimItems(trims: readonly OverCapTrim[]): string[] {
  const d = trims.filter((x) => x.action === 'discard').length;
  const r = trims.length - d;
  const out: string[] = [];
  if (d) out.push(`退回 ${d} 名新秀`);
  if (r) out.push(`解约 ${r} 人`);
  return out;
}

/** 执行超编处理（按 planOverCapTrim 逐个退回 / 解约；意外失败的人选排除后重新计划一次）。返回离队的选手 */
function trimOverCap(state: GameState, rep: AutoRoundReport): Set<string> {
  const me = myTeamId(state);
  const gone = new Set<string>();
  const failed = new Set<string>();
  for (let pass = 0; pass < 2 && canAct(state); pass++) {
    const plan = planOverCapTrim(state, failed);
    if (!plan.trims.length) break;
    let miss = false;
    for (const x of plan.trims) {
      const r = x.action === 'discard' ? gachaDiscard(state, x.playerId) : releasePlayer(state, x.playerId);
      if (!r.ok || state.players[x.playerId]?.teamId === me) {
        failed.add(x.playerId);
        miss = true;
        continue;
      }
      gone.add(x.playerId);
      rep.progressed = true;
      rep.trims.push(x);
      rep.lines.push(trimLine(x));
    }
    if (!miss) break;
  }
  // 放走的人若在首发：用现有队员补上空着的首发位（其余首发不动）
  if (gone.size && emptyLineupSlots(state, me).length) fillEmptyLineupSlots(state, me, null);
  rep.overCapLeft = isTransferWindowOpen(state) ? rosterOverCap(state, me) : 0;
  if (rep.overCapLeft > 0) {
    rep.lines.push(`仍超编 ${rep.overCapLeft} 人：没有可自动退回或解约的人选，请手动放弃新秀或解约 ${rep.overCapLeft} 人（降到 ${CONFIG.team.hardMaxRoster} 人以内）后才能进入下一回合`);
  }
  return gone;
}

// ---------------------------------------------------------------------------
// 1b) 补员：签下负担得起的自由选手（懒人模式不自动抽卡）
// ---------------------------------------------------------------------------

/**
 * 补员后仍凑不齐时的原因：cap = 已达常规阵容上限；deficit = 有愿意加盟、资金也够的人选，但签下后入不敷出（首发缺口超过余额可覆盖的回合数，
 * 或只能当替补）；funds = 愿意加盟的人选付不起签字费或付完后余额不足 reserveRounds 回合工资；unwilling = 人选都婉拒；
 * none = 自由市场没有该位置的人选；limit = 本回合已签满 maxSigningsPerRound 人。
 */
export type RosterShortfallReason = 'cap' | 'deficit' | 'funds' | 'unwilling' | 'none' | 'limit';

/** 自动补员的计划（纯函数，不修改 state） */
export interface RosterFillPlan {
  /** 需要补员：转会窗口开放，且正式阵容不能覆盖五个位置或少于 minRosterFill 人 */
  needed: boolean;
  /** 补员前的正式阵容人数（不含临时 / 野外替补） */
  roster: number;
  /** 补员前未覆盖的位置（本位置 / 副位置，roles.uncoveredPositions） */
  missing: Position[];
  /** 依次签下的人选 */
  picks: AutoSigning[];
  /** 补员后仍有未覆盖的位置或不足 5 人时的说明（赛事由临时替补 / 现有队员顶上），无则 null */
  shortfall: string | null;
  /** shortfall 的原因（多个空缺取优先级最高的一个），无则 null */
  shortfallReason: RosterShortfallReason | null;
  /** 是否预知了婉拒（见 market.negotiationPredictable）；false 时 picks 为各空缺的首选人选 */
  exact: boolean;
}

/** 正式阵容（active，不含临时替补与野外替补） */
function regularMembers(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !isTempOrWild(p));
}

/** 首发位空着的位置：无人、不是本队正式队员（含只效力本项赛事的临时替补）、或已禁赛 / 退役 */
function emptyLineupSlots(state: GameState, teamId: string): Position[] {
  const team = ownEntry(state.teams, teamId);
  if (!team) return [];
  return POSITIONS.filter((q) => {
    const id = team.lineup?.[q];
    const p = id ? state.players[id] : undefined;
    return !p || p.teamId !== teamId || p.status !== 'active' || !team.playerIds.includes(p.id) || isTempOrWild(p);
  });
}

/** 某位置的首发是跨位置顶替的正式队员（不打本职，如离队后自动排阵顶上的替补）：返回他，否则 null */
function offRoleStarter(state: GameState, teamId: string, pos: Position): Player | null {
  const id = ownEntry(state.teams, teamId)?.lineup?.[pos];
  const p = id ? state.players[id] : undefined;
  if (!p || p.teamId !== teamId || p.status !== 'active' || isTempOrWild(p)) return null;
  return playsNaturally(p, pos) ? null : p;
}

/** 补员一名人选的签字费 / 工资与预算推演（CONFIG.autoRound；见 withinIncome / affordable） */
interface SigningTerms {
  fee: number;
  /** 工资（每回合，按本俱乐部开价） */
  salary: number;
  /** 付完签字费后的余额 */
  left: number;
  /** 签约后的每回合工资 */
  wages: number;
  /** 签约后每回合工资超出经常性收入的部分（≤ 0 = 收入付得起） */
  deficit: number;
  /** 资金够：付得起签字费，且付完后余额 ≥ 签约后工资 × reserveRounds */
  funds: boolean;
}

function signingTerms(state: GameState, p: Player, me: string, budget: { gold: number; wages: number; income: number }): SigningTerms {
  const fee = signingFee(state, p);
  const salary = signingSalary(state, p, me);
  const left = budget.gold - fee;
  const wages = budget.wages + salary;
  const funds = fee <= budget.gold && left >= wages * Math.max(0, CONFIG.autoRound.reserveRounds);
  return { fee, salary, left, wages, deficit: wages - budget.income, funds };
}

/** 签约后经常性收入仍付得起工资（不入不敷出）：补员先在这些人选中挑 */
function withinIncome(t: SigningTerms): boolean {
  return t.funds && t.deficit <= 0;
}

/** 入不敷出时首发要求余额覆盖的缺口：deficit × coverDeficitRounds */
function deficitCover(t: SigningTerms): number {
  return Math.max(0, t.deficit) * Math.max(0, CONFIG.autoRound.coverDeficitRounds);
}

/**
 * 预算允许：资金够（见 SigningTerms.funds），且签约后经常性收入付得起工资；付不起时只允许首发（starter：补上空着的首发位，
 * 或补位时顶替该位置跨位置首发的队员），并要求余额还能覆盖 coverDeficitRounds 个回合的缺口，替补不允许入不敷出。
 */
function affordable(t: SigningTerms, starter: boolean): boolean {
  return t.funds && (t.deficit <= 0 || (starter && t.left >= deficitCover(t)));
}

/** 每回合经常性收入（赞助 + 直播 + 周边；不含夺冠热度的临时加成与奖金） */
function recurringIncome(state: GameState, teamId: string): number {
  const team = ownEntry(state.teams, teamId);
  if (!team) return 0;
  const r = roundRevenue(state, team);
  return Math.max(0, r.total - r.merchBoost);
}

/** 某个空缺没有签到人的原因（优先级从高到低，多个空缺取最高的一个说明） */
const SHORTFALL_PRIORITY: RosterShortfallReason[] = ['cap', 'deficit', 'funds', 'unwilling', 'none', 'limit'];

interface ShortfallNote {
  reason: RosterShortfallReason;
  /** reason = deficit：所需缺口最小的人选（签约后工资、经常性收入、需覆盖的缺口；替补为 null） */
  wages?: number;
  income?: number;
  cover?: number | null;
  /** reason = none：空缺的位置（null = 跨位置补首发） */
  pos?: Position | null;
}

function shortfallText(n: ShortfallNote, softCap: number): string {
  const C = CONFIG.autoRound;
  switch (n.reason) {
    case 'cap':
      return `阵容已达常规上限 ${softCap} 人，未自动签人`;
    case 'deficit':
      return `入不敷出：签下后工资 ${formatGold(n.wages ?? 0)}/回合高于经常性收入 ${formatGold(n.income ?? 0)}/回合，`
        + (n.cover == null ? '替补不自动签' : `自动补员需余额覆盖 ${C.coverDeficitRounds} 回合的缺口 ${formatGold(n.cover)}`)
        + '，赛事由临时替补或现有队员顶上';
    case 'funds':
      return `资金不足：付完签字费后余额需留足 ${C.reserveRounds} 回合工资，赛事由临时替补或现有队员顶上`;
    case 'unwilling':
      return '没有愿意加盟的自由选手（本回合都婉拒），赛事由临时替补或现有队员顶上';
    case 'limit':
      return `本回合已自动签下 ${Math.max(0, Math.floor(C.maxSigningsPerRound))} 人，其余下回合再补`;
    default:
      return `自由市场没有${n.pos ? `打${POSITION_CN[n.pos]}的` : '可签的'}选手，赛事由临时替补或现有队员顶上`;
  }
}

/**
 * 自动补员计划：先为未覆盖的位置（按位置顺序）各签一名本职（本位置 / 副位置）选手，再补替补深度到 minRosterFill 人。
 * 每个空缺分两轮挑人：先在签下后经常性收入仍付得起工资的人选中取「该位置评分（替补深度：综合评分）最高、不会婉拒」者；
 * 没有时才在其余人选中按评分挑预算允许者（入不敷出只允许首发，且缺口有上限，见 affordable）。
 * 婉拒按 market.signFreeAgent 的同一枚谈判骰子判定（同一回合结果固定）。按虚拟账面（资金 − 签字费、工资 + 新签工资）与虚拟阵容逐个推演，
 * 不超过常规阵容上限 team.maxRoster。exclude：不考虑的人选（本回合因事件离队的本队选手、执行时意外失败的人选）。
 */
export function planRosterFill(state: GameState, exclude: ReadonlySet<string> = new Set()): RosterFillPlan {
  const me = myTeamId(state);
  const team = me ? state.teams[me] : undefined;
  const plan: RosterFillPlan = {
    needed: false, roster: 0, missing: [], picks: [], shortfall: null, shortfallReason: null, exact: negotiationPredictable(state),
  };
  if (!team || team.disbanded || state.gameOver) return plan;
  const roster = regularMembers(state, me);
  const C = CONFIG.autoRound;
  const target = Math.max(0, Math.floor(C.minRosterFill));
  plan.roster = roster.length;
  plan.missing = uncoveredPositions(roster);
  if (!isTransferWindowOpen(state) || (!plan.missing.length && roster.length >= target)) return plan;
  plan.needed = true;

  const softCap = CONFIG.team.maxRoster;
  let size = rosterSize(state, me);
  const budget = { gold: Number.isFinite(team.gold) ? team.gold : 0, wages: roundWageBill(state, me), income: recurringIncome(state, me) };
  const virtual: Player[] = roster.slice();
  const emptySlots = new Set<Position>(emptyLineupSlots(state, me));
  /** 已为之签人的位置（不再考虑顶替该位置的首发） */
  const resolved = new Set<Position>();
  const taken = new Set<string>(exclude);
  const unfillable = new Set<Position>();
  const pool = freeAgents(state); // 按综合评分降序
  const maxPicks = Math.max(0, Math.floor(C.maxSigningsPerRound));
  const byRating = (a: { p: Player; r: number }, b: { p: Player; r: number }) => b.r - a.r || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0);
  const failed: { note: ShortfallNote | null } = { note: null };
  const noteFail = (n: ShortfallNote) => {
    const cur = failed.note;
    if (!cur || SHORTFALL_PRIORITY.indexOf(n.reason) < SHORTFALL_PRIORITY.indexOf(cur.reason)) failed.note = n;
  };
  for (;;) {
    const uncovered = uncoveredPositions(virtual);
    const missing = uncovered.filter((q) => !unfillable.has(q));
    const pos: Position | null = missing.length ? missing[0] : null;
    if (!pos && virtual.length >= target) break;
    // 新签选手会首发：补上空着的首发位（本职位置空着，或阵容不足 5 人），或补位时顶替该位置跨位置首发的队员（评分更高时）；
    // 否则只是替补（替补深度不改动首发）
    const short = virtual.length < POSITIONS.length;
    const reason: AutoSigning['reason'] = pos ? 'cover' : short ? 'fill' : 'depth';
    // 只有补位 / 补足首发没签到人才是「凑不齐」的原因（替补深度没签到不影响说明）
    const counts = reason !== 'depth';
    if (size >= softCap || size >= CONFIG.team.hardMaxRoster || plan.picks.length >= maxPicks) {
      if (counts) noteFail({ reason: plan.picks.length >= maxPicks ? 'limit' : 'cap' });
      break;
    }
    const occupant = pos && !emptySlots.has(pos) && !resolved.has(pos) ? offRoleStarter(state, me, pos) : null;
    // 跨位置补首发：按第一个仍空着（或未覆盖）的位置评分（含位置系数）选人
    const firstEmpty = POSITIONS.find((q) => emptySlots.has(q)) ?? uncovered[0] ?? null;
    const slot: Position | null = pos ?? (short ? firstEmpty : null);
    const cands = pool
      .filter((p) => !taken.has(p.id) && !p.teamId && p.status === 'active' && (!pos || playsNaturally(p, pos)))
      .map((p) => ({ p, r: slot ? playerRating(p, slot) : overallRating(p), t: signingTerms(state, p, me, budget) }));
    // 两轮：先挑签下后经常性收入仍付得起工资的人选，没有（都婉拒 / 都入不敷出）时才考虑其余人选
    const ordered = [...cands.filter((c) => withinIncome(c.t)).sort(byRating), ...cands.filter((c) => !withinIncome(c.t)).sort(byRating)];
    let pick: AutoSigning | null = null;
    // 没签到人时的原因：愿意加盟、只差入不敷出规则的人选（取所需缺口最小者）> 愿意加盟、只差资金 > 都不愿加盟 > 没有人选
    let deficitNote: ShortfallNote | null = null;
    let fundsBlocked = false;
    for (const { p, r, t } of ordered) {
      const replaces = !!occupant && r > playerRating(occupant, pos!);
      const starter = short || (!!pos && emptySlots.has(pos)) || replaces;
      const ok = affordable(t, starter);
      // 与 signFreeAgent 同一枚谈判骰子：本回合会婉拒的人选跳过（多人客户端视图无法预知，按首选人选列出）
      const will = () => playerWillingness(state, p.id, me);
      const accepts = (w: number) => !plan.exact || negotiationRoll(state, `sign|${p.id}|${me}`) < w;
      if (!ok) {
        if (t.funds) {
          const cover = starter ? deficitCover(t) : null;
          const better = !deficitNote || (cover ?? Infinity) < (deficitNote.cover ?? Infinity);
          if (better && accepts(will())) deficitNote = { reason: 'deficit', wages: t.wages, income: budget.income, cover };
        } else if (!fundsBlocked && !deficitNote && accepts(will())) fundsBlocked = true;
        continue;
      }
      const w = will();
      if (!accepts(w)) continue;
      pick = {
        playerId: p.id, handle: p.handle, tier: playerTier(p), position: pos ?? p.position, reason, fee: t.fee, salary: t.salary,
        willingness: w, ...(replaces ? { replaces: { playerId: occupant!.id, handle: occupant!.handle } } : {}),
      };
      break;
    }
    if (!pick) {
      if (counts) noteFail(deficitNote ?? { reason: fundsBlocked ? 'funds' : cands.length ? 'unwilling' : 'none', pos });
      if (pos) {
        unfillable.add(pos);
        continue;
      }
      break;
    }
    plan.picks.push(pick);
    if (pos) resolved.add(pos);
    if (pos && emptySlots.has(pos)) emptySlots.delete(pos);
    else if (short && firstEmpty) emptySlots.delete(firstEmpty); // 不足 5 人：多一人就少一个空位（替下的队员也会补空位）
    taken.add(pick.playerId);
    virtual.push(state.players[pick.playerId]);
    size += 1;
    budget.gold -= pick.fee;
    budget.wages += pick.salary;
  }
  // 补员后仍凑不齐五个位置 / 5 人：说明原因（赛事由临时替补或现有队员跨位置顶上）
  const left = uncoveredPositions(virtual);
  if (virtual.length < POSITIONS.length || left.length) {
    const what = virtual.length < POSITIONS.length
      ? `正式阵容 ${virtual.length} 人`
      : `缺${left.map((q) => POSITION_CN[q]).join('、')}`;
    const n: ShortfallNote = failed.note ?? { reason: 'none', pos: null };
    plan.shortfallReason = n.reason;
    plan.shortfall = `${what}：${shortfallText(n, softCap)}`;
  }
  return plan;
}

/**
 * 一名补员的文字：结果「自动签下自由选手 X（S 级 · 三号位）补位，签字费 2.0万，工资 5,000/回合」；
 * 预览（preview = true，前面已有「将自动：」）去掉开头的「自动」，无法预知婉拒时注明意愿与顺延。
 */
function signingLine(x: AutoSigning, preview = false, exact = true): string {
  const what = x.reason === 'cover' ? '补位' : x.reason === 'fill' ? '补足首发' : '补充替补';
  const swap = x.replaces ? `（替下跨位置首发的 ${x.replaces.handle}）` : '';
  return `${preview ? '' : '自动'}签下自由选手 ${x.handle}（${x.tier} 级 · ${POSITION_CN[x.position]}）${what}${swap}，签字费 ${formatGold(x.fee)}，工资 ${formatGold(x.salary)}/回合`
    + (exact ? '' : `（加盟意愿 ${Math.round(x.willingness * 100)}%，婉拒则顺延下一人选）`);
}

/** 执行自动补员（按 planRosterFill 的计划逐个 signFreeAgent；意外失败的人选排除后重新计划一次）。exclude：本回合因事件离队的选手 */
function fillRoster(state: GameState, rep: AutoRoundReport, exclude: ReadonlySet<string> = new Set()): void {
  const me = myTeamId(state);
  const failed = new Set<string>(exclude);
  for (let pass = 0; pass < 2 && canAct(state); pass++) {
    const plan = planRosterFill(state, failed);
    rep.rosterShortfall = plan.needed ? plan.shortfall : null;
    if (!plan.needed || !plan.picks.length) return;
    let miss = false;
    for (const x of plan.picks) {
      const r = signFreeAgent(state, x.playerId);
      if (!r.ok) {
        failed.add(x.playerId);
        miss = true;
        continue;
      }
      rep.progressed = true;
      const p = state.players[x.playerId];
      // 补位：顶替该位置跨位置首发的队员（他回到替补席）
      const lineup = state.teams[me]?.lineup;
      if (x.replaces && lineup?.[x.position] === x.replaces.playerId && p?.teamId === me) setLineupSlot(state, me, x.position, p.id);
      const done: AutoSigning = { ...x, salary: p?.salary ?? x.salary };
      rep.signings.push(done);
      rep.signingFees += done.fee;
      rep.lines.push(signingLine(done));
    }
    // 新签选手补上空着的首发位（其余首发不动）
    if (emptyLineupSlots(state, me).length) fillEmptyLineupSlots(state, me, null);
    if (!miss) return;
  }
}

// ---------------------------------------------------------------------------
// 2) 首发
// ---------------------------------------------------------------------------

/** 本方现在有比赛要打（进行中的比赛或已就绪的系列赛） */
function hasMatchNow(state: GameState, t: Tournament): boolean {
  if (state.activeMatch?.tournamentId === t.id) return true;
  return t.status === 'running' && !!playerNextSeries(state, t.id);
}

/** 为一个空缺 / 无法出场的首发位招募临时替补：合格（≥ B 级）中最便宜的，没有就最便宜的；同价取评分高者 */
function pickTempSub(state: GameState, cands: Player[], gold: number): Player | null {
  const affordable = cands.filter((c) => tempSubCost(state, c.id) <= gold);
  if (!affordable.length) return null;
  const minTier = tierIndex(AUTO_TEMP_SUB_MIN_TIER);
  const adequate = affordable.filter((c) => tierIndex(playerTier(c)) >= minTier);
  const pool = adequate.length ? adequate : affordable;
  return pool.slice().sort((a, b) => tempSubCost(state, a.id) - tempSubCost(state, b.id)
    || overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/**
 * 自动处理过该赛事的首发后撤掉其提示弹窗：「首发不足 5 人」开赛提醒（已自动补位 / 招募 / 接受弃权）与签证事件的
 * 「野外替补已就位」（已补齐首发无需再招；或其候选已被自动招募清空，留着会指向不存在的候选）。其余弹窗不动。
 */
function dropLineupPopups(state: GameState, t: Tournament): void {
  state.popups = state.popups.filter((p) => p.kind !== 'message'
    || !((p.title === TEMP_SUB_POPUP_TITLE || p.title === LINEUP_SHORT_POPUP_TITLE) && p.body.includes(`「${t.name}」`)));
}

function fixLineup(state: GameState, t: Tournament, rep: AutoRoundReport, tried: Set<string>): void {
  const me = myTeamId(state);
  const team = state.teams[me];
  if (!team || tried.has(t.id) || !hasMatchNow(state, t)) return;
  if (!validateLineup(state, me, t.id).length) return;
  // 每项赛事每次只尝试一次（招不起替补时不反复招募 / 重复提示，之后的系列赛照常弃权判负）
  tried.add(t.id);
  const errs = ensurePlayableLineup(state, t.id);
  rep.progressed = true;
  if (!errs.length) {
    if (!rep.lineupFixed) rep.lines.push(`首发自动补位（${t.name}）`);
    rep.lineupFixed = true;
    dropLineupPopups(state, t);
    return;
  }
  // 可出场选手不足 5 人：逐个空位招募临时替补
  const hired: string[] = [];
  let spent = 0;
  let reason = '';
  for (let i = 0; i < POSITIONS.length && validateLineup(state, me, t.id).length; i++) {
    // 与 team.validateLineup 同口径：空缺 / 非本队 / 无法参赛（禁赛、退役、签证、伤病）/ 其他赛事的临时替补
    const pos: Position | undefined = POSITIONS.find((p) => {
      const id = team.lineup[p];
      const pl = id ? state.players[id] : null;
      return !pl || pl.teamId !== me || !isAvailable(pl, t.id)
        || (!!pl.tempSubUntilTournament && pl.tempSubUntilTournament !== t.id);
    });
    if (!pos) break;
    const pick = pickTempSub(state, generateTempSubCandidates(state, pos), team.gold);
    if (!pick) {
      reason = '资金不足';
      break;
    }
    const cost = tempSubCost(state, pick.id);
    const r = hireTempSub(state, pick.id, t.id);
    if (!r.ok) {
      reason = r.message;
      break;
    }
    hired.push(`${pick.handle}（${playerTier(pick)} 级）`);
    spent += cost;
  }
  // 自动招募后不保留其余候选（候选名单是本座位的临时数据）；指向这些候选的「野外替补已就位」与开赛的「首发不足 5 人」
  // 提醒都已过时（已招募，或招不起而接受弃权），一并撤掉
  clearTempSubCandidates(state);
  dropLineupPopups(state, t);
  if (hired.length) {
    rep.tempSubs += hired.length;
    rep.tempSubCost += spent;
    rep.lines.push(`首发不足 5 人：招募临时替补 ${hired.join('、')}，花费 ${formatGold(spent)}（${t.name}）`);
  }
  const left = validateLineup(state, me, t.id);
  if (left.length) {
    rep.lines.push(`首发仍不足 5 人（${reason || left[0]}）：「${t.name}」的系列赛将弃权判负`);
  } else if (!hired.length && !rep.lineupFixed) {
    rep.lineupFixed = true;
    rep.lines.push(`首发自动补位（${t.name}）`);
  }
}

// ---------------------------------------------------------------------------
// 3) 比赛
// ---------------------------------------------------------------------------

/** 进度签名：比赛视图、玩家对决、本赛事已出结果的系列赛数（不变 = 无进展，避免空转） */
function progressSig(state: GameState, tid: string | null): string {
  const me = myTeamId(state);
  const am = state.activeMatch;
  const h = am ? state.multiplayer?.h2h?.[am.seriesId] : undefined;
  const t = tid ? state.tournaments[tid] : undefined;
  let results = 0;
  if (t) for (const id in t.series) if (t.series[id]?.result) results++;
  const hs = h
    ? `${h.games.length}|${h.done ? 1 : 0}|${h.quickSim?.[me] ? 1 : 0}|${h.mode?.A ?? ''}${h.mode?.B ?? ''}|${h.draft ? (h.draft.done ? 2 : 1) : 0}`
    : '';
  return [am?.seriesId ?? '', am?.phase ?? '', am?.pendingGame ? 1 : 0, am?.games?.length ?? 0, hs, t?.status ?? '', results, state.pendingDecisions.length].join('/');
}

function draftFinished(h: H2HMatch): boolean {
  return !!h.draft && (h.draft.done || currentStep(h.draft) === null);
}

/** 玩家对决的一步：看完对手开打的一局 → 登记快速模拟 → 选择自动 BP（手动改自动）→ 双方自动 BP 完成后开打 */
function h2hStep(state: GameState, h: H2HMatch, rep: AutoRoundReport): void {
  const me = myTeamId(state);
  const side: 'A' | 'B' = h.teamA === me ? 'A' : 'B';
  if (state.activeMatch?.pendingGame) commitGame(state);
  if (h.done || !state.activeMatch) return;
  if (!h.quickSim?.[me]) {
    const r = quickSimSeries(state);
    if (!r.ok || h.done) return;
  }
  rep.h2hWaiting = true;
  if (state.activeMatch?.pendingGame) return;
  if (!h.mode?.[side]) startDraft(state, false);
  else if (h.mode[side] === 'manual' && h.draft && !draftFinished(h)) h2hSwitchToAutoDraft(state);
  // 双方都是自动 BP 且 BP 已完成（如对手只选了自动 BP、未点开始）：开打本局。
  // 对手手动 BP 时由对手自己点「开始本局」（不替在线对手开打，避免打断其操作）
  if (!h.done && h.draft && draftFinished(h) && h.mode?.A === 'auto' && h.mode?.B === 'auto' && !state.activeMatch?.pendingGame) {
    playGame(state);
  }
}

/** 已出结果的玩家对决，本方视图还停在最后一局的回放：直接关闭（自动推进不看回放） */
function closeFinishedH2HView(state: GameState, rep: AutoRoundReport): void {
  const am = state.activeMatch;
  if (!am?.pendingGame) return;
  const h = state.multiplayer?.h2h?.[am.seriesId];
  if (!h?.done) return;
  commitGame(state);
  rep.progressed = true;
}

function playMatches(state: GameState, rep: AutoRoundReport): void {
  const lineupTried = new Set<string>();
  for (let guardN = 0; guardN < 80 && canAct(state); guardN++) {
    closeFinishedH2HView(state, rep);
    const bl = getAdvanceBlockers(state);
    if (!bl.some((b) => b.code === 'match_in_progress' || b.code === 'tournament_running')) {
      rep.waiting = null;
      rep.h2hWaiting = false;
      return;
    }
    if (bl.some((b) => b.code === 'pending_decision')) return; // 默认选项未能处理的事件挡住了比赛
    const t = roundTournament(state);
    const tid = state.activeMatch?.tournamentId ?? t?.id ?? null;
    const sig0 = progressSig(state, tid);
    if (t) fixLineup(state, t, rep, lineupTried);
    const am = state.activeMatch;
    const h = am ? liveH2HOf(state, am.seriesId) : null;
    if (am && h && isH2HSeries(state, state.tournaments[h.tournamentId]?.series[h.seriesId])) {
      h2hStep(state, h, rep);
    } else {
      const r = quickSimTournament(state);
      if (!r.ok) rep.waiting = r.message;
    }
    if (progressSig(state, tid) === sig0) break; // 无进展：等待对手 / 其他玩家
    rep.progressed = true;
  }
  closeFinishedH2HView(state, rep);
  // 仍被比赛挡住：说明原因（多人：等待对手 / 其他玩家的比赛结果）
  const left = getAdvanceBlockers(state).filter((b) => b.code === 'match_in_progress' || b.code === 'tournament_running');
  if (!left.length) {
    rep.waiting = null;
    rep.h2hWaiting = false;
    return;
  }
  const am = state.activeMatch;
  const h = am ? liveH2HOf(state, am.seriesId) : null;
  if (h) {
    const opp = h.teamA === myTeamId(state) ? h.teamB : h.teamA;
    const oppName = state.multiplayer?.seats?.[opp]?.name || state.teams[opp]?.name || '对手';
    rep.h2hWaiting = true;
    rep.waiting = `玩家对决：已请求快速模拟并选择自动 BP，等待「${oppName}」同意快速模拟或打完本场`;
  } else if (!rep.waiting) {
    rep.waiting = left.map((b) => b.message).join('；');
  }
}

/** 本赛事中本方已出结果的系列赛 id */
function myResolvedSeries(state: GameState, tid: string | null): Set<string> {
  const me = myTeamId(state);
  const out = new Set<string>();
  const t = tid ? state.tournaments[tid] : undefined;
  if (t) for (const id in t.series) if (t.series[id]?.result && involves(t.series[id], me)) out.add(id);
  return out;
}

function tallySeries(state: GameState, tid: string, before: Set<string>, rep: AutoRoundReport): void {
  const me = myTeamId(state);
  const t = state.tournaments[tid];
  if (!t) return;
  let n = 0;
  for (const id in t.series) {
    const s = t.series[id];
    const res = s?.result;
    if (!res || before.has(id) || !involves(s, me)) continue;
    n++;
    const mySide = s.teamA === me ? 'A' : 'B';
    if (res.forfeit) {
      if (res.forfeit === mySide) {
        rep.forfeits++;
        rep.losses++;
      } else rep.wins++;
    } else if (res.scoreA === res.scoreB) rep.draws++;
    else if (res.winnerId === me) rep.wins++;
    else rep.losses++;
  }
  if (!n) return;
  rep.series += n;
  const pl = t.status === 'finished' ? t.placements.find((p) => p.teamId === me) : undefined;
  const parts = [`${rep.wins} 胜`, `${rep.losses} 负`];
  if (rep.draws) parts.push(`${rep.draws} 平`);
  rep.lines.push(
    `快速模拟「${t.name}」${n} 场：${parts.join(' ')}${rep.forfeits ? `（弃权 ${rep.forfeits} 场）` : ''}`
      + (t.status === 'finished' ? `，赛事结束${pl ? `，最终 ${formatRank(pl.rankFrom, pl.rankTo)}` : ''}` : ''),
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 自动处理的简短事项（新闻标题 / 预览共用） */
function compactItems(x: {
  series: number; moreSeries?: boolean; decisions: number; trims?: readonly OverCapTrim[]; signings?: number; lineupFix: boolean; tempSubs: number;
  forfeits?: number;
}): string[] {
  const items: string[] = [];
  if (x.series > 0) items.push(`快速模拟 ${x.series}${x.moreSeries ? '+' : ''} 场比赛`);
  if (x.decisions > 0) items.push(`默认处理 ${x.decisions} 个事件`);
  if (x.trims?.length) items.push(`处理超编：${trimItems(x.trims).join('、')}`);
  if (x.signings) items.push(`签下 ${x.signings} 名自由选手`);
  if (x.tempSubs > 0) items.push(`招募 ${x.tempSubs} 名临时替补`);
  else if (x.lineupFix) items.push('自动补齐首发');
  if (x.forfeits) items.push(`弃权 ${x.forfeits} 场`);
  return items;
}

/**
 * 为当前座位自动处理本回合挡住推进的事务（见文件头）。返回处理摘要；不推进回合。
 * opts.news=false 不写私有新闻；opts.source='autopilot' 表示由房主托管代为处理（新闻正文注明）。
 */
export function autoHandleRound(state: GameState, opts: { news?: boolean; source?: 'auto' | 'autopilot' } = {}): AutoRoundReport {
  const rep = emptyReport();
  if (!canAct(state)) return rep;
  dropStaleMatch(state);
  const t0 = roundTournament(state);
  const tid0 = t0?.id ?? null;
  const before = myResolvedSeries(state, tid0);

  const departed = handleDecisionsTracked(state, rep);
  // 超编（抽卡后超出绝对上限）：先退回本回合抽到的新秀、仍超编才解约替补；放走的人同一回合不签回
  if (canAct(state)) for (const id of trimOverCap(state, rep)) departed.add(id);
  // 补员在比赛之前：新签的选手本回合就能补上空着的首发位（本回合因事件离队的选手不签回）
  if (canAct(state)) fillRoster(state, rep, departed);
  if (canAct(state)) playMatches(state, rep);
  // 防御：比赛过程中出现的新待决事件（目前不会产生，保持「按一次即可推进」）
  if (canAct(state) && state.pendingDecisions.some((d) => d.blocking)) handleDecisions(state, rep);
  if (tid0) tallySeries(state, tid0, before, rep);
  if (rep.waiting) rep.lines.push(rep.waiting);

  const substantive = rep.decisions > 0 || rep.series > 0 || rep.trims.length > 0 || rep.signings.length > 0 || rep.lineupFixed || rep.tempSubs > 0;
  // 阵容仍凑不齐（没有负担得起的自由选手等）：有其他处理时一并写进摘要（只有这一句时不单独提示，每回合都会重复）
  if (substantive && rep.rosterShortfall) rep.lines.push(rep.rosterShortfall);
  if (opts.news !== false && substantive) {
    const me = myTeamId(state);
    const items = compactItems({
      series: rep.series, decisions: rep.decisions, trims: rep.trims, signings: rep.signings.length, lineupFix: rep.lineupFixed,
      tempSubs: rep.tempSubs, forfeits: rep.forfeits,
    });
    addNews(
      state,
      'system',
      `本回合自动处理：${items.join(' · ')}`,
      (opts.source === 'autopilot' ? '房主托管期间由系统代为处理（保守选项）：\n' : '')
        + rep.lines.map((l) => `· ${l}`).join('\n'),
      false,
      {
        teamIds: me ? [me] : [], scope: 'mine', visibility: 'private', actorTeamId: me || undefined,
        tags: [AUTO_ROUND_NEWS_TAG], noInfer: true,
      },
    );
  }
  return rep;
}

/**
 * 预览用的超编处理与补员计划：有待决事件或超编、且转会窗口开放时，先在状态副本上按默认选项处理事件（离队申请挽留失败、
 * 合同到期未续约会让人离队，续约会改变工资）、处理超编（退回 / 解约，与执行同一函数），再按处理后的阵容与账面计划补员——
 * 与 autoHandleRound 的执行顺序相同，单机与服务器端逐人一致（事件结果走 rngOf，副本与实际执行同一序列；超编处理不用随机数）。
 * 副本失败时退回按当前状态计划。
 */
function previewRosterPlans(state: GameState, decisionsPending: boolean): { fill: RosterFillPlan; trim: OverCapPlan } {
  const overCap = isTransferWindowOpen(state) ? rosterOverCap(state, myTeamId(state)) : 0;
  if ((decisionsPending || overCap > 0) && isTransferWindowOpen(state)) {
    try {
      const c = structuredClone(state);
      const rep = emptyReport();
      const departed = handleDecisionsTracked(c, rep);
      const over = isTransferWindowOpen(c) ? rosterOverCap(c, myTeamId(c)) : 0;
      for (const id of trimOverCap(c, rep)) departed.add(id);
      return { fill: planRosterFill(c, departed), trim: { over, trims: rep.trims, left: rep.overCapLeft } };
    } catch (e) {
      console.error('[engine] previewRosterPlans', e);
    }
  }
  return { fill: planRosterFill(state), trim: planOverCapTrim(state) };
}

/**
 * 「下一回合」按钮的预览：将自动处理哪些事务（纯函数，不修改 state）。
 * 例：{ text: '将自动：快速模拟 2 场比赛 · 默认处理 1 个事件 · 自动补齐首发', ... }；无事可做时 text 为空串。
 */
export function previewAutoActions(state: GameState): AutoRoundPreview {
  const out: AutoRoundPreview = {
    decisions: 0, overCap: 0, trims: [], overCapLeft: 0,
    series: 0, moreSeries: false, signings: [], rosterFillExact: true, rosterShortfall: null, rosterShortfallReason: null,
    lineupFix: false, tempSubs: 0,
    forfeitRisk: false, h2h: false, waiting: null, blocked: null, items: [], text: '',
  };
  try {
    if (state.gameOver) {
      out.blocked = '游戏已结束';
      return out;
    }
    const me = myTeamId(state);
    const team = me ? state.teams[me] : undefined;
    if (!team) {
      out.blocked = '战队不存在';
      return out;
    }
    if (team.disbanded || (isMultiplayer(state) && !seatInPlay(state, me))) {
      out.blocked = '战队已解散，当前为观战模式';
      return out;
    }
    out.decisions = (state.pendingDecisions ?? []).filter((d) => d.blocking).length;
    // 超编处理与补员（与 autoHandleRound 同一份计划）
    const { fill, trim } = previewRosterPlans(state, out.decisions > 0);
    out.overCap = trim.over;
    out.trims = trim.trims;
    out.overCapLeft = trim.left;
    if (fill.needed) {
      out.signings = fill.picks;
      out.rosterFillExact = fill.exact;
      out.rosterShortfall = fill.shortfall;
      out.rosterShortfallReason = fill.shortfallReason;
    }

    const t = roundTournament(state);
    const am = state.activeMatch;
    const matchLive = !!am && !!t && am.tournamentId === t.id && !t.series[am.seriesId]?.result;
    if (t && t.status === 'running' && (matchLive || !isTeamEliminated(state, t.id, me))) {
      const mine = Object.values(t.series).filter((s) => involves(s, me) && !s.result && s.teamA && s.teamB);
      out.series = mine.length;
      out.moreSeries = !isTeamEliminated(state, t.id, me)
        && (Object.values(t.series).some((s) => !s.result && (!s.teamA || !s.teamB)) || t.stages.some((st) => !st.done && !st.seriesIds.length));
      const next = playerNextSeries(state, t.id);
      const liveH = matchLive ? liveH2HOf(state, am!.seriesId) : null;
      out.h2h = !!liveH || isH2HSeries(state, next) || mine.some((s) => isH2HSeries(state, s));
      if (matchLive || next) {
        if (validateLineup(state, me, t.id).length) {
          out.lineupFix = true;
          // 先补员：计划签下的自由选手本回合就能出场
          const short = Math.max(0, POSITIONS.length - fieldable(state, me, t.id).length - out.signings.length);
          const room = Math.max(0, Math.floor(CONFIG.market.tempSubMax) - teamPlayers(state, me).filter((p) => p.tempSubUntilTournament).length);
          const goldLeft = team.gold - out.signings.reduce((a, x) => a + x.fee, 0);
          out.tempSubs = Math.min(short, room);
          out.forfeitRisk = short > room || goldLeft < out.tempSubs * tierTempSubCost(state, 'C');
        }
      } else if (isMultiplayer(state)) {
        out.waiting = `「${t.name}」中你的下一场比赛尚未确定，需等待其他玩家完成比赛；按下后会在可以时自动处理并准备`;
      }
    }
    // 超编处理（逐人）与补员逐人列出（排在比赛 / 事件之后、首发之前）
    const trimText = out.trims.length
      ? [`处理超编 ${out.overCap} 人：${out.trims.map((x) => trimLine(x, true)).join('、')}`]
      : [];
    if (out.overCapLeft > 0) trimText.push(`仍超编 ${out.overCapLeft} 人（需手动处理）`);
    const signItems = out.signings.map((x) => signingLine(x, true, out.rosterFillExact));
    if (out.rosterShortfall) signItems.push(out.rosterShortfall);
    out.items = [
      ...compactItems({ series: out.series, moreSeries: out.moreSeries, decisions: out.decisions, lineupFix: false, tempSubs: 0 }),
      ...trimText,
      ...signItems,
      ...compactItems({ series: 0, decisions: 0, lineupFix: out.lineupFix, tempSubs: out.tempSubs }),
    ];
    if (out.forfeitRisk) out.items.push('资金不足将弃权');
    if (out.h2h && out.series > 0) out.items.push('玩家对决需对手同意快速模拟');
    out.text = out.items.length ? `将自动：${out.items.join(' · ')}` : '';
  } catch (e) {
    console.error('[engine] previewAutoActions', e);
  }
  return out;
}
