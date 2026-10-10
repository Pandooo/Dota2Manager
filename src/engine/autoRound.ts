// ============================================================================
// 「下一回合」自动处理（懒人玩法，用户反馈 2026-10-09：「最懒人的玩法就是可以直接一直点下方的『下一回合』按钮」）
//
// autoHandleRound(state)：在当前座位上下文中（单机 = 玩家；多人 = 已换入的座位）把本回合挡住推进的事务按保守默认处理完：
//   1) 待决事件：按 events.defaultDecisionChoice（与多人托管同一张表：配合调查 / 低调处理 / 替补顶上 / 尝试挽留 /
//      拒绝报价 / 续约 1 赛季 / 不聘用，其余含无厘头事件取第一项）；
//   2) 首发：本回合有比赛要打而首发不合法 → 自动补位 / 排阵（season.ensurePlayableLineup）；可出场选手不足 5 人 →
//      为空位招募「合格（B 级及以上）中最便宜」的临时替补（没有合格的就招最便宜的），负担不起则接受弃权判负；
//   3) 比赛：快速模拟本方在本回合赛事的全部剩余系列赛（与 quickSimTournament 相同）。
//      多人玩家对决：登记快速模拟（对手也自动推进 / 同意时立即结算）、选择自动 BP（对手想手动打也能打）、
//      看完对手开打的一局、双方都是自动 BP 时开打 —— 对手怎么打都不会互相卡死；
//   4) 其余不变（未用的训练在回合结束时本来就会按当前焦点自动使用）。
// 做了实质处理（事件 / 首发 / 比赛）时写入一条私有新闻「本回合自动处理：…」。
//
// previewAutoActions(state)：纯预览（不修改 state），用于「下一回合」按钮的提示，
// 例如「将自动：快速模拟 2 场比赛 · 默认处理 1 个事件 · 自动补齐首发」。
//
// 入口：game.advance(state, { auto: true })（单机）；multi.setSeatReady(state, teamId, true, { auto: true })（多人，
// 协议 setRoundReady 的 auto 标记）；multi.autopilotSeat（房主托管离线玩家）同样使用本模块。
// ============================================================================
import type { GameState, H2HMatch, PendingDecision, Player, Position, Series, Tier, Tournament } from './types';
import { POSITIONS } from './types';
import { CONFIG } from './config';
import {
  commitGame, currentPlayerTournament, dropStaleMatch, getAdvanceBlockers, h2hSwitchToAutoDraft, playGame,
  quickSimTournament, quickSimSeries, startDraft,
} from './game';
import { defaultDecisionChoice, resolveDecision } from './events';
import { ensurePlayableLineup } from './season';
import { teamPlayers, validateLineup } from './team';
import { clearTempSubCandidates, generateTempSubCandidates, hireTempSub, tempSubCost } from './market';
import { isAvailable, overallRating, playerTier, tierIndex } from './player';
import { isTeamEliminated, playerNextSeries } from './tournament';
import { currentStep } from './draft';
import { playerTournamentForRound } from './calendar';
import { econ } from './economy';
import { addNews } from './news';
import { formatGold, formatRank } from './util';
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
  /** 将快速模拟的、已排定对手的本方系列赛数（淘汰赛后续轮次视赛果而定，不计入） */
  series: number;
  /** 打完已排定的场次后还可能有比赛（晋级下一轮 / 下一阶段） */
  moreSeries: boolean;
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

function emptyReport(): AutoRoundReport {
  return {
    lines: [], decisions: 0, series: 0, wins: 0, losses: 0, draws: 0, forfeits: 0, lineupFixed: false, tempSubs: 0,
    tempSubCost: 0, h2hWaiting: false, waiting: null, progressed: false,
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

function handleDecisions(state: GameState, rep: AutoRoundReport): void {
  const tried = new Set<string>();
  for (let guardN = 0; guardN < 50 && canAct(state); guardN++) {
    const d: PendingDecision | undefined = state.pendingDecisions.find((x) => x.blocking && !tried.has(x.id));
    if (!d) return;
    tried.add(d.id);
    const choice = defaultDecisionChoice(d);
    const label = d.choices.find((c) => c.id === choice)?.label ?? '知道了';
    const title = d.title;
    const r = resolveDecision(state, d.id, choice);
    rep.progressed = true;
    const still = state.pendingDecisions.some((x) => x.id === d.id);
    if (still) {
      rep.lines.push(`${title}：默认选项「${label}」未能执行（${r.message}），请手动处理`);
      continue;
    }
    rep.decisions += 1;
    rep.lines.push(`${title} → ${label}${r.message ? `：${r.message}` : ''}`);
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
function compactItems(x: { series: number; moreSeries?: boolean; decisions: number; lineupFix: boolean; tempSubs: number; forfeits?: number }): string[] {
  const items: string[] = [];
  if (x.series > 0) items.push(`快速模拟 ${x.series}${x.moreSeries ? '+' : ''} 场比赛`);
  if (x.decisions > 0) items.push(`默认处理 ${x.decisions} 个事件`);
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

  handleDecisions(state, rep);
  if (canAct(state)) playMatches(state, rep);
  // 防御：比赛过程中出现的新待决事件（目前不会产生，保持「按一次即可推进」）
  if (canAct(state) && state.pendingDecisions.some((d) => d.blocking)) handleDecisions(state, rep);
  if (tid0) tallySeries(state, tid0, before, rep);
  if (rep.waiting) rep.lines.push(rep.waiting);

  const substantive = rep.decisions > 0 || rep.series > 0 || rep.lineupFixed || rep.tempSubs > 0;
  if (opts.news !== false && substantive) {
    const me = myTeamId(state);
    const items = compactItems({
      series: rep.series, decisions: rep.decisions, lineupFix: rep.lineupFixed, tempSubs: rep.tempSubs, forfeits: rep.forfeits,
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
 * 「下一回合」按钮的预览：将自动处理哪些事务（纯函数，不修改 state）。
 * 例：{ text: '将自动：快速模拟 2 场比赛 · 默认处理 1 个事件 · 自动补齐首发', ... }；无事可做时 text 为空串。
 */
export function previewAutoActions(state: GameState): AutoRoundPreview {
  const out: AutoRoundPreview = {
    decisions: 0, series: 0, moreSeries: false, lineupFix: false, tempSubs: 0, forfeitRisk: false, h2h: false,
    waiting: null, blocked: null, items: [], text: '',
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
          const short = Math.max(0, POSITIONS.length - fieldable(state, me, t.id).length);
          const room = Math.max(0, Math.floor(CONFIG.market.tempSubMax) - teamPlayers(state, me).filter((p) => p.tempSubUntilTournament).length);
          out.tempSubs = Math.min(short, room);
          out.forfeitRisk = short > room || team.gold < out.tempSubs * tierTempSubCost(state, 'C');
        }
      } else if (isMultiplayer(state)) {
        out.waiting = `「${t.name}」中你的下一场比赛尚未确定，需等待其他玩家完成比赛；按下后会在可以时自动处理并准备`;
      }
    }
    out.items = compactItems({ series: out.series, moreSeries: out.moreSeries, decisions: out.decisions, lineupFix: out.lineupFix, tempSubs: out.tempSubs });
    if (out.forfeitRisk) out.items.push('资金不足将弃权');
    if (out.h2h && out.series > 0) out.items.push('玩家对决需对手同意快速模拟');
    out.text = out.items.length ? `将自动：${out.items.join(' · ')}` : '';
  } catch (e) {
    console.error('[engine] previewAutoActions', e);
  }
  return out;
}
