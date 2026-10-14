// 赛季流程：开季、回合进入/结束、TI 结算【E5 负责实现】
import type { Coach, GameState, Player, SeasonSummary, Team, Tournament, TrainingFocus } from './types';
import { POSITIONS } from './types';
import { CONFIG, TOURNAMENT_TIER_LABEL } from './config';
import {
  buildRounds, findTiTournament, playerTournamentForRound, regularRoundCount, roundKindForPlayer, seasonStartDate,
  tiDates, tiYear,
} from './calendar';
import { allPatches, applyPatch, mapPatchesToRounds, patchAt, patchByVersion } from './patches';
import { generateHeroMeta } from './heroes';
import { buildSeasonTournaments, refreshSeasonInvites, setupTiPhase, startRoundTournaments } from './schedule';
import { runRookieDraft } from './rookieDraft';
import { aiGachaPulls, closeGachaPool, gachaHoldsRealRookie, releaseRealRookieCards, startGachaSeason } from './gacha';
import { ensureHallOfFame, inductHallOfFame } from './hallOfFame';
import { expireOffers, generateAiOffers, isTransferWindowOpen, processContractExpiry, refreshFreeAgents } from './market';
import { processTransferListings } from './squadOps';
import { aiEnsureRosters, aiTrainRound, aiTransferWindow } from './ai';
import { offseasonLeaveRequests, offseasonShuffle } from './shuffle';
import { autoLineup, benchPlayers, validateLineup } from './team';
import {
  checkVisaForTournament, processLoyaltyDepartures, rollGlobalRoundEvents, rollRoundEvents, rollSeatRoundEvents,
} from './events';
import {
  advanceTournamentUntilPlayer, finishTournament, isTeamEliminated, playerNextSeries, readySeries, simulateTournamentToEnd,
} from './tournament';
import { payRoundSalaries } from './economy';
import { checkBankruptcy } from './bankruptcy';
import { prizePoolLabel } from './revenue';
import { ageOf, isAvailable, playerRating, playerTier, tickModifiers, tierIndex } from './player';
import { adjustLoyalty, agePlayersAtSeasonEnd, processRetirements, roundLoyaltyUpdate, sessionTrainOptions, trainTeam } from './growth';
import { rollSeasonForm } from './form';
import { rollTeamMomentum, updateTeamMomentumRound } from './momentum';
import { runSeasonDevelopment } from './development';
import { syncSeasonRoles } from './roleSync';
import { playsNaturally } from './roles';
import { expectedRank } from './honor';
import { addNews, pushPopup } from './news';
import { formatGold, formatRank, nextId, ownEntry, placementPercentile } from './util';
import { pendingExtraSessionCost, recordTraining, snapshotSquad } from './trainingLog';
import { newsroomRoundEnd, newsroomRoundStart } from './newsroom';
import { fireDueClubScandals, rollClubScandals } from './scandal';
import { seasonCoachSupply } from './coaches';
import { foundSeasonClubs, signFoundedClubRookies } from './clubs';
import { missionContractRetention, missionSeasonEnd } from './missions';
import { recordLegacySeasonAll } from './legacy';
import { recordPediaSeasonEnd } from './stats';
import { syncSynergies } from './synergy';
import { ensurePrizeShares, prizeShareRoundUpdate } from './prizeShare';
import { applySeasonBranding } from './branding';
import {
  activeHumanIds, allPendingDecisions, forEachSeat, humanTeamIds, isHumanTeam, isMultiplayer, withSeat,
} from './seat';

/** 训练焦点中文名 */
export const TRAINING_FOCUS_LABEL: Record<TrainingFocus, string> = {
  power: '战斗力', mmr: '天梯', insight: '灵性', balanced: '均衡',
};

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function playerTeam(state: GameState): Team | null {
  return state.teams[state.settings?.playerTeamId] ?? null;
}

function resetRoundTraining(state: GameState): void {
  state.freeTrainingUsed = false;
  state.extraTrainingAvailable = 0;
  state.extraTrainingBoughtThisRound = 0;
}

/** 历史曲线快照：同一 (赛季, 回合) 只保留最后值 */
function upsertPoint(arr: { season: number; round: number; value: number }[], season: number, round: number, value: number): void {
  const last = arr[arr.length - 1];
  if (last && last.season === season && last.round === round) last.value = value;
  else arr.push({ season, round, value });
}

export function snapshotHistory(state: GameState): void {
  const team = playerTeam(state);
  if (!team) return;
  const ti = state.season.ti;
  upsertPoint(state.history.honor, ti, state.roundIndex, Math.round(team.honor));
  upsertPoint(state.history.gold, ti, state.roundIndex, Math.round(team.gold));
}

/**
 * 只填补首发中的空位（退役/禁赛/离队留下的洞），用替补中该位置评分最高者；不改动其余安排。
 * 指向非本队/非 active 选手、或重复安排的位置视为空位；给出 tournamentId 时，
 * 无法参加该赛事的首发（签证/伤病、其他赛事的临时替补）也视为空位。
 */
export function fillEmptyLineupSlots(state: GameState, teamId: string, tournamentId?: string | null): void {
  const team = ownEntry(state.teams, teamId);
  if (!team) return;
  team.lineup ??= { C: null, M: null, O: null, SS: null, HS: null };
  const seen = new Set<string>();
  const empty = POSITIONS.filter((pos) => {
    const id = team.lineup[pos];
    const p = id ? state.players[id] : undefined;
    const valid = !!p && p.teamId === teamId && p.status === 'active' && team.playerIds.includes(p.id) && !seen.has(p.id)
      && (!tournamentId
        || (isAvailable(p, tournamentId) && (!p.tempSubUntilTournament || p.tempSubUntilTournament === tournamentId)));
    if (valid) seen.add(p.id);
    else team.lineup[pos] = null;
    return !valid;
  });
  if (!empty.length) return;
  const used = new Set<string>();
  const bench = benchPlayers(state, teamId).filter(
    (p) => p.teamId === teamId && isAvailable(p, tournamentId)
      && (!p.tempSubUntilTournament || p.tempSubUntilTournament === tournamentId),
  );
  // 两轮：先用本职（本位置 / 副位置）替补补位，再用跨位置评分最高者补剩余空位（评分已含位置系数：四五号位互换优于其他非本位置）
  for (const naturalOnly of [true, false]) {
    for (const pos of empty) {
      if (team.lineup[pos]) continue;
      let best: Player | null = null;
      let bestR = -Infinity;
      for (const p of bench) {
        if (used.has(p.id) || (naturalOnly && !playsNaturally(p, pos))) continue;
        const r = playerRating(p, pos);
        if (r > bestR) {
          bestR = r;
          best = p;
        }
      }
      if (best) {
        team.lineup[pos] = best.id;
        used.add(best.id);
      }
    }
  }
}

/**
 * 玩家赛事开赛/每场系列赛前的阵容兜底：首发不合法时先只补空位（尽量保留玩家的安排），
 * 仍不合法再整体自动排阵。返回剩余的阵容错误（空数组 = 合法）。
 */
export function ensurePlayableLineup(state: GameState, tournamentId: string): string[] {
  const me = state.settings.playerTeamId;
  let errs = validateLineup(state, me, tournamentId);
  if (!errs.length) return errs;
  fillEmptyLineupSlots(state, me, tournamentId);
  errs = validateLineup(state, me, tournamentId);
  if (!errs.length) return errs;
  autoLineup(state, me, tournamentId);
  return validateLineup(state, me, tournamentId);
}

/** 中期转会窗口所在的常规赛回合 */
export function midseasonRoundIndex(state: GameState): number {
  return Math.max(1, Math.round(regularRoundCount(state.season) / 2));
}

/**
 * 版本基线：直接设为某日期生效的版本，不把倍数作用到选手（新游戏的阵容数据已对应当时版本）。
 */
export function initPatchBaseline(state: GameState, date: string): void {
  const p = patchAt(date);
  if (!p) return;
  state.currentPatch = p.version;
  state.appliedPatches = [p.version];
  state.heroMeta = generateHeroMeta(p, date);
}

/** 补齐 date（含）之前发布、晚于当前版本、尚未应用的版本 */
function catchUpPatches(state: GameState, date: string): void {
  const cur = state.currentPatch ? patchByVersion(state.currentPatch) : undefined;
  if (!cur) {
    initPatchBaseline(state, date);
    return;
  }
  for (const p of allPatches()) {
    if (p.date > date) break;
    if (p.date < cur.date || state.appliedPatches.includes(p.version)) continue;
    applyPatch(state, p.version);
  }
}

/** 赛季内（开始日之后、TI 结束前）发布的版本 → 所在回合（已应用的跳过） */
function mapSeasonPatches(state: GameState): void {
  const applied = new Set(state.appliedPatches ?? []);
  mapPatchesToRounds(state.season, (v) => applied.has(v));
}

/** 压缩已结束赛事：AI 之间的系列赛不保留单局记录；keepPlayerLive=false 时玩家对局也去掉文字直播 */
export function compactTournament(state: GameState, t: Tournament, keepPlayerLive: boolean): void {
  if (t.status !== 'finished') return;
  const me = state.settings.playerTeamId;
  const humans = isMultiplayer(state) ? new Set(humanTeamIds(state)) : null;
  for (const sid in t.series) {
    const r = t.series[sid]?.result;
    if (!r || !r.games?.length) continue;
    const s = t.series[sid];
    const involvesPlayer = s.teamA === me || s.teamB === me
      || (!!humans && ((!!s.teamA && humans.has(s.teamA)) || (!!s.teamB && humans.has(s.teamB))));
    if (!involvesPlayer) r.games = [];
    else if (!keepPlayerLive) for (const g of r.games) if (g.live?.length) g.live = [];
  }
}

/** 删除过旧赛季的赛事实例（history 中仍保留摘要），上赛季的压缩掉直播 */
function pruneOldTournaments(state: GameState, ti: number): void {
  const keep = CONFIG.season.keepTournamentSeasons;
  for (const id of Object.keys(state.tournaments)) {
    const t = state.tournaments[id];
    if (!t) continue;
    if (t.season < ti - keep) delete state.tournaments[id];
    else if (t.season < ti) compactTournament(state, t, false);
  }
}

/**
 * 清理已退役的程序化选手：非真实、无东家、未转任教练、最后效力的不是玩家战队。
 * 真实选手与玩家旧部保留（历史/结算界面可能引用）。
 */
function pruneRetiredPlayers(state: GameState): void {
  if (!CONFIG.season.pruneRetiredGeneratedPlayers) return;
  const me = state.settings.playerTeamId;
  const keep = new Set<string>();
  for (const id in state.coaches) {
    const f = state.coaches[id].formerPlayerId;
    if (f) keep.add(f);
  }
  for (const id in state.players) {
    const p = state.players[id];
    if (p.status !== 'retired' || p.isReal || p.teamId || p.lastTeamId === me || isHumanTeam(state, p.lastTeamId) || keep.has(id)) continue;
    delete state.players[id];
  }
}

/**
 * 教练市场清理（CONFIG.coach.freePoolMax / retireAge）：自由教练年龄 ≥ retireAge 时退出；
 * 仍多于 freePoolMax 时按「等级 → 灵性 → 提升幅度」保留最好的，其余退出教练市场（从 state.coaches 删除）。
 * 有东家的教练（含赛季交替时为玩家暂留的退役旧部）、待处理决策引用的教练、由任一人类战队旧部转任的教练保留。
 */
export function pruneCoachPool(state: GameState): void {
  const cfg = CONFIG.coach;
  const max = Math.max(0, Math.floor(cfg.freePoolMax ?? Infinity));
  const retireAge = Number.isFinite(cfg.retireAge) ? cfg.retireAge : Infinity;
  const humanTeams = new Set(Object.values(state.teams).filter((t) => t.isPlayer).map((t) => t.id));
  if (state.settings?.playerTeamId) humanTeams.add(state.settings.playerTeamId);
  const referenced = new Set<string>();
  for (const d of allPendingDecisions(state)) {
    const id = d.ctx?.coachId;
    if (typeof id === 'string') referenced.add(id);
  }
  const year = state.season?.year ?? 0;
  const candidates: Coach[] = [];
  for (const id in state.coaches) {
    const c = state.coaches[id];
    if (!c || c.teamId || referenced.has(id)) continue;
    const former = c.formerPlayerId ? state.players[c.formerPlayerId] : undefined;
    if (former?.lastTeamId && humanTeams.has(former.lastTeamId)) continue;
    if (Number.isFinite(c.birthYear) && year - c.birthYear >= retireAge) {
      delete state.coaches[id];
      continue;
    }
    candidates.push(c);
  }
  if (candidates.length <= max) return;
  const value = (c: Coach) => tierIndex(c.tier) * 1000 + (Number.isFinite(c.insight) ? c.insight : 0)
    + ((Number.isFinite(c.talentBoost) ? c.talentBoost : 0) + (Number.isFinite(c.resilienceBoost) ? c.resilienceBoost : 0)) * 0.5;
  candidates.sort((a, b) => value(b) - value(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of candidates.slice(max)) delete state.coaches[c.id];
}

/** 清理选手身上已结束/已删除赛事的「无法参赛」标记（签证/伤病），避免跨赛季无限累积 */
function pruneUnavailableMarks(state: GameState): void {
  for (const id in state.players) {
    const p = state.players[id];
    const list = p.unavailableTournamentIds;
    if (!list?.length) continue;
    const keep = list.filter((tid) => {
      const t = state.tournaments[tid];
      return !!t && t.status !== 'finished';
    });
    if (keep.length) p.unavailableTournamentIds = keep;
    else delete p.unavailableTournamentIds;
  }
}

/**
 * 每个回合开始时（含赛季初回合 0、TI 预选与 TI 正赛回合）都要经历的随机环节：
 * 随机事件（events.rollRoundEvents）→ AI 报价（转会窗口开放时）→ 低归属感离队申请；
 * 之后用替补填补因事件留下的首发空位。
 */
function rollRoundStart(state: GameState): void {
  if (isMultiplayer(state)) {
    // 多人模式：AI 事件 / 延迟事件全局一次，玩家事件、AI 报价、离队申请按座位各一次
    rollGlobalRoundEvents(state);
    forEachSeat(state, (me) => {
      rollSeatRoundEvents(state);
      if (state.gameOver || state.teams[me]?.disbanded) return;
      if (isTransferWindowOpen(state)) generateAiOffers(state);
      processLoyaltyDepartures(state);
      if (state.teams[me]?.disbanded) return;
      fillEmptyLineupSlots(state, me);
    });
    return;
  }
  rollRoundEvents(state);
  if (state.gameOver) return;
  if (isTransferWindowOpen(state)) generateAiOffers(state);
  processLoyaltyDepartures(state);
  if (state.gameOver) return;
  fillEmptyLineupSlots(state, state.settings.playerTeamId);
}

/** 本赛季中 roundIndex ≤ upTo 且仍在进行的赛事：模拟到底并结算 */
function finishRunningTournaments(state: GameState, upTo: number): void {
  const ids = new Set<string>(state.seasonTournamentIds ?? []);
  for (const r of state.season.rounds) if (r.index <= upTo) for (const id of r.tournamentIds) ids.add(id);
  for (const id of ids) {
    const t = state.tournaments[id];
    if (!t || t.status !== 'running' || t.roundIndex > upTo) continue;
    simulateTournamentToEnd(state, id);
    if (state.tournaments[id]?.status !== 'finished') finishTournament(state, id);
  }
}

/**
 * 玩家赛事收尾：玩家已无比赛可打（被淘汰/赛事打完/异常卡住）→ 模拟剩余比赛并结算。
 * 返回赛事是否已结束。
 */
export function finalizePlayerTournamentIfDone(state: GameState, tournamentId: string): boolean {
  const t = state.tournaments[tournamentId];
  if (!t) return true;
  if (t.status === 'finished') return true;
  if (t.status !== 'running') return false;
  if (isMultiplayer(state)) {
    // 多人模式：还有玩家未被淘汰 → 只推进 AI 比赛（在任一玩家的系列赛就绪时停下）；无玩家在比 → 模拟剩余并结算
    const stillIn = activeHumanIds(state).filter((h) => !isTeamEliminated(state, tournamentId, h));
    if (stillIn.length) {
      advanceTournamentUntilPlayer(state, tournamentId);
      const cur = state.tournaments[tournamentId];
      if (!cur || cur.status === 'finished') return true;
      if (readySeries(state, tournamentId).length > 0) return false;
      // 防御：仍有玩家在比却没有任何可进行的系列赛（不应发生）→ 收尾，避免卡死
    }
    simulateTournamentToEnd(state, tournamentId);
    if (state.tournaments[tournamentId]?.status !== 'finished') finishTournament(state, tournamentId);
    return true;
  }
  const me = state.settings.playerTeamId;
  if (isTeamEliminated(state, tournamentId, me) || !playerNextSeries(state, tournamentId)) {
    simulateTournamentToEnd(state, tournamentId);
    if (state.tournaments[tournamentId]?.status !== 'finished') finishTournament(state, tournamentId);
    return true;
  }
  return false;
}

/** 进入赛事回合时的玩家赛事准备 */
function preparePlayerTournament(state: GameState, idx: number): void {
  const me = state.settings.playerTeamId;
  const round = state.season.rounds[idx];
  // 经预选晋级 TI：同步报名状态，保证 schedule.playerTournamentInRound 能识别
  if (round?.phase === 'ti') {
    const tiT = findTiTournament(state);
    if (tiT && tiT.teamIds.includes(me) && tiT.playerStatus !== 'invited' && tiT.playerStatus !== 'registered') {
      tiT.playerStatus = 'invited';
    }
  }
  const t = playerTournamentForRound(state, idx);
  if (!t) {
    if (round?.phase === 'ti') {
      addNews(state, 'tournament', `无缘 TI${state.season.ti}`, '未能获得本届国际邀请赛参赛资格。TI 回合为休赛回合，可照常训练。');
    }
    return;
  }
  if (t.status !== 'running') return;

  checkVisaForTournament(state, t.id);
  const lineupErrs = ensurePlayableLineup(state, t.id);
  if (t.expectedRank == null) t.expectedRank = expectedRank(state, t, me);
  if (lineupErrs.length) {
    // 首发凑不齐 5 人：开赛前明确提醒（未补人就快速模拟 → 弃权判负）
    const body = `出征「${t.name}」的首发不足 5 人：${lineupErrs.join('；')}。`
      + '请在比赛前调整阵容或招募临时替补（转会市场 → 临时替补，或赛事页「一键补齐首发」），否则每场系列赛都将弃权判负。';
    addNews(state, 'tournament', '首发不足 5 人：需要临时替补', body, true, { teamIds: [me], tags: ['lineup-warning'] });
    pushPopup(state, { kind: 'message', title: '首发不足 5 人', body });
  }

  const total = t.teamIds.length + t.qualifierTeamIds.filter((id) => !t.teamIds.includes(id)).length;
  addNews(
    state,
    'tournament',
    `出征 ${t.name}`,
    `${TOURNAMENT_TIER_LABEL[t.tier]} · ${t.city}${t.online ? '（线上）' : ''} · 奖金池 ${prizePoolLabel(state, t)}。`
      + `共 ${total} 支队伍，赛前预期：第 ${t.expectedRank} 名左右。`
      + (t.qualifierTeamIds.includes(me) && !t.teamIds.includes(me) ? '我们需要先打封闭预选赛。' : ''),
    t.tier === 'ti' || t.tier === 'major',
  );

  advanceTournamentUntilPlayer(state, t.id);
  finalizePlayerTournamentIfDone(state, t.id);
}

// ---------------------------------------------------------------------------
// 赛季
// ---------------------------------------------------------------------------

/**
 * 开始赛季（新游戏后与每次 TI 结算后调用）：
 * season = {ti, year, startDate, tiStartDate, rounds(calendar.buildRounds), registeredTournamentIds: [], extraTrainingsBought: 0}；
 * roundIndex=0, phase='preseason', currentDate=startDate；
 * 版本映射到回合（round.patchVersions），应用赛季开始前（含当天）应生效的版本；
 * 所有战队 points=0；新秀卡池（gacha.startGachaSeason：本届真实新秀 + 请神 + 虚构新秀，2026-10-14 起取代选秀；
 * CONFIG.draft.enabled 时改为举行选秀 rookieDraft.runRookieDraft）；market.refreshFreeAgents；
 * shuffle.offseasonShuffle（休赛期转会潮，第二个赛季起）；ai.aiTransferWindow('preseason')；ai.aiEnsureRosters；
 * momentum.rollTeamMomentum（荣誉势头：本季初荣誉与同比，第十四波）；form.rollSeasonForm（赛季状态 + 隐藏趋势）；schedule.buildSeasonTournaments；
 * 免费训练状态重置；新闻（赛季开始、赛程公布、受邀赛事）；
 * 回合 0 同样滚动随机事件 / AI 报价 / 离队申请（与 enterRound 一致；honorStart/goldStart 取事件之前的值，
 * 因此赛季初事件计入本赛季的荣誉/资金变化）。事件可能导致解散（state.gameOver）。
 */
export function startSeason(state: GameState, ti: number): void {
  const year = tiYear(ti);
  const startDate = seasonStartDate(ti);
  const { startDate: tiStart, endDate: tiEnd } = tiDates(ti);
  const rounds = buildRounds(ti, startDate, tiStart, tiEnd);
  state.season = {
    ti,
    year,
    startDate,
    tiStartDate: rounds[rounds.length - 1].startDate,
    rounds,
    registeredTournamentIds: [],
    extraTrainingsBought: 0,
  };
  state.roundIndex = 0;
  state.phase = 'preseason';
  state.currentDate = startDate;
  forEachSeat(state, () => {
    state.activeMatch = null;
  });
  state.seasonTournamentIds = [];
  forEachSeat(state, () => resetRoundTraining(state));

  pruneOldTournaments(state, ti);
  pruneCoachPool(state);
  pruneRetiredPlayers(state);
  pruneUnavailableMarks(state);

  // 版本：先补齐休赛期发布的版本，再把赛季内版本映射到回合
  catchUpPatches(state, startDate);
  mapSeasonPatches(state);

  for (const id in state.teams) state.teams[id].points = 0;
  // 品牌变迁（第十波 #4，branding.ts）：选秀 / 转会新闻之前按真实历史套用该届的名称 / 简称 / 配色（开局赛季只静默对齐）
  applySeasonBranding(state);

  // 赛季自主成长（development.ts，第九波）：退役 / 年龄衰退已在 TI 结算中处理；选秀与转会潮之前，全体在役选手按天赋 / 真实轨迹自主训练
  // （新游戏的第一个赛季不执行）
  runSeasonDevelopment(state);
  // 真实生涯位置（第十三波，roleSync.ts）：当届有真实阵容数据的真实选手切换到当届真实位置、刷新副位置（AI 战队重新排阵）；
  // 放在新俱乐部 / 选秀 / 转会潮之前，AI 的位置需求按新位置计算
  syncSeasonRoles(state);
  // 新俱乐部涌现（第十波 #2，clubs.ts）：现实中在本届首次出现的真实俱乐部（及偶尔的虚构新组织）在选秀与转会潮之前成立并签回当届真实选手
  foundSeasonClubs(state);
  // 新秀（退役/年龄/合同已在 TI 结算中处理；多人模式全局一次）→ 自由选手 → AI 转会 → 补齐阵容 → 赛程。
  // 2026-10-14 起新秀只经由抽卡进入联赛（gacha.ts）：建本赛季卡池（本届真实新秀 + 请神 + 虚构新秀，名人堂为请神原型），
  // 人类玩家在赛季初即可抽卡，AI 战队在第 1 回合开始前（enterRound）抽；选秀保留一个版本（CONFIG.draft.enabled，默认关闭）
  ensureHallOfFame(state);
  if (CONFIG.draft.enabled) runRookieDraft(state);
  else startGachaSeason(state);
  // 错过登场时机的真实新秀条目清理（仍在本赛季卡池中待抽的除外：抽中或卡池关闭时才进入本局）
  for (const [id, debut] of Object.entries(state.futureRookies)) {
    if (debut < ti && !gachaHoldsRealRookie(state, id)) delete state.futureRookies[id];
  }
  // 教练供给（第九波 #3，coaches.ts）：随选秀向教练市场引入一批教练并保证可签约数量（在 AI 季前转会之前）
  seasonCoachSupply(state);
  refreshFreeAgents(state);
  // 本赛季成立的真实俱乐部：签回本届登场、被 AI 选中或落选的真实新秀（第十波 #2；抽卡模式下真实新秀第 1 回合前才离池，
  // 届时 enterRound 再调用一次）
  signFoundedClubRookies(state);
  // 休赛期转会潮（shuffle.ts；新游戏第一个赛季不触发）：大规模换人在前，AI 季前窗口只做补员/还债/教练等收尾
  const shuffled = offseasonShuffle(state) !== null;
  // 多人模式：休赛期离队申请是座位私有的待决事件，offseasonShuffle 只为当前座位（中性状态下无）调用 → 其余座位各自调用
  if (shuffled && isMultiplayer(state)) forEachSeat(state, () => { offseasonLeaveRequests(state); });
  aiTransferWindow(state, 'preseason', { upgrades: !shuffled });
  aiEnsureRosters(state);
  // AI 转会窗口会挑走自由市场上的大部分可用选手：再补一次，保证玩家赛季初也有可签的自由选手
  refreshFreeAgents(state);
  // 荣誉势头（第十四波，momentum.ts）：记录本季初荣誉、按同比计算全队赛季状态均值的平移（须在 rollSeasonForm 之前）
  rollTeamMomentum(state);
  // 赛季状态（form.ts）：隐藏趋势更新 + 全员赛季状态修正（持续到 TI 回合结束）。放在 AI 季前转会之后，季前转会不受本季状态影响
  rollSeasonForm(state);
  buildSeasonTournaments(state);
  // 俱乐部全员假赛（scandal.ts）：每队本赛季掷一次，命中则在随机常规赛回合曝光
  rollClubScandals(state);
  // 奖金分成（prizeShare.ts，第九波）：补齐新游戏 / 新组织 / 旧存档的分成比例（按战队 id 哈希，不消耗随机数）
  ensurePrizeShares(state);
  forEachSeat(state, (me) => {
    fillEmptyLineupSlots(state, me);
    const team = playerTeam(state);
    if (team) {
      state.season.honorStart = Math.round(team.honor);
      state.season.goldStart = Math.round(team.gold);
    }
  });
  seasonStartNews(state);
  rollRoundStart(state);
  // 羁绊（第十波 #5，synergy.ts）：选秀 / 转会潮 / AI 季前窗口 / 赛季初事件之后全量同步（新解锁的届次从本赛季起可觉醒）
  syncSynergies(state, { full: true });
  forEachSeat(state, () => {
    snapshotHistory(state);
    snapshotSquad(state); // 成长曲线的赛季起点（回合 0）：本赛季变化从赛季初算起，含第 1 回合的训练
  });
  newsroomRoundStart(state); // 新闻编辑部：赛季初周报特刊 + 回合要闻
}

function seasonStartNews(state: GameState): void {
  const s = state.season;
  const tiT = findTiTournament(state);
  const tiName = tiT?.name ?? `TI${s.ti}`;
  addNews(
    state,
    'season',
    `TI${s.ti} 赛季开始`,
    `${s.startDate} 起，新赛季正式打响，终点是 ${s.tiStartDate} 开幕的 ${tiName}。`
      + `本赛季共 ${s.rounds.length - 1} 个大回合（含 TI 预选与 TI 正赛）。`
      + (CONFIG.draft.enabled
        ? '新秀选秀已结束，转会窗口现已开放。'
        : '转会窗口现已开放，本赛季新秀卡池同时开放（真实新秀、请神新秀与虚构新秀；真实新秀只能在第 1 回合开始前抽，之后按真实出道去向加盟；转会窗口锁定时卡池关闭）。'),
    true,
  );
  const ts = (state.seasonTournamentIds ?? [])
    .map((id) => state.tournaments[id])
    .filter((t): t is Tournament => !!t && t.tier !== 'ti');
  const byTier = (tier: Tournament['tier']) => ts.filter((t) => t.tier === tier).length;
  addNews(
    state,
    'tournament',
    '新赛季赛程公布',
    `本赛季共 ${ts.length} 项赛事（Major ${byTier('major')} · 顶级赛事 ${byTier('premier')} · Minor ${byTier('minor')}）。`
      + '请在「赛事 › 赛程报名」中报名，每个回合最多参加一项，未报名的回合为休赛回合。',
  );
  // 受邀赛事：报名状态是座位私有字段（多人模式下每个座位各一条）
  forEachSeat(state, () => {
    const invited = ts.filter((t) => t.playerStatus === 'invited');
    if (invited.length) {
      addNews(
        state,
        'tournament',
        '收到赛事邀请',
        `${invited.map((t) => t.name).join('、')} 向你发出了邀请。受邀赛事已自动报名，开赛前可在「赛事 › 赛程报名」中婉拒（TI 与 TI 预选赛除外）。`,
        true,
      );
    }
  });
}

/**
 * 进入回合 idx：设置 roundIndex/phase/currentDate；应用本回合版本；
 * 若 phase==='ti_qualifier' 先 schedule.setupTiPhase；schedule.startRoundTournaments(idx)；
 * 玩家本回合赛事：events.checkVisaForTournament、team.autoLineup（若阵容非法）、tournament.advanceTournamentUntilPlayer；
 * 重置 freeTrainingUsed/extraTrainingAvailable/extraTrainingBoughtThisRound；
 * events.rollRoundEvents；market.generateAiOffers（窗口开放时）；events.processLoyaltyDepartures；
 * 中期（常规赛中点回合）ai.aiTransferWindow('midseason')。
 *
 * 实现顺序说明：阵容会变动的环节（中期转会、随机事件、离队申请）放在赛事开赛之前，
 * 避免赛事进行到一半时首发被抽走。
 */
export function enterRound(state: GameState, idx: number): void {
  if (state.gameOver) return;
  const round = state.season.rounds[idx];
  if (!round) return;
  state.roundIndex = idx;
  state.phase = round.phase;
  state.currentDate = round.startDate;
  forEachSeat(state, () => {
    state.activeMatch = null;
    resetRoundTraining(state);
  });

  for (const v of round.patchVersions) applyPatch(state, v);

  // 新秀抽卡（gacha.ts）：第 1 回合开始前，赛季初（人类玩家可先抽）没有被抽走的真实新秀卡离池、按真实出道去向加盟（出道战队为人类玩家时
  // 发待决事件；卡池同等级补入请神 / 虚构卡），本赛季成立的真实俱乐部签回其余本届登场的新秀，然后 AI 战队按空位与资金自动抽卡；
  // 赛季中期再抽一次（中期转会窗口之前）；进入 TI 预选赛（转会锁定）时卡池关闭
  if (round.phase === 'regular' && idx === 1) {
    if (releaseRealRookieCards(state) > 0) signFoundedClubRookies(state);
    aiGachaPulls(state, 'opening');
  }
  if (round.phase === 'regular' && idx === midseasonRoundIndex(state)) {
    if (idx !== 1) aiGachaPulls(state, 'midseason');
    aiTransferWindow(state, 'midseason');
  }
  if (round.phase === 'ti_qualifier') closeGachaPool(state);

  // 俱乐部全员假赛曝光（scandal.ts）：随机事件之前；单机玩家俱乐部被禁赛 → 游戏结束
  if (round.phase === 'regular') {
    fireDueClubScandals(state, idx);
    if (state.gameOver) return;
  }

  rollRoundStart(state);
  if (state.gameOver) return;
  // 羁绊（第十波 #5）：中期转会窗口 / 随机事件 / 离队申请之后、赛事开赛之前同步
  syncSynergies(state, { full: true });

  if (round.phase === 'ti_qualifier') setupTiPhase(state);
  startRoundTournaments(state, idx);
  forEachSeat(state, () => preparePlayerTournament(state, idx));
  newsroomRoundStart(state); // 新闻编辑部：回合要闻
}

/**
 * 结束当前回合：玩家赛事必须已结束（由 getAdvanceBlockers 保证）；本回合所有未结束赛事 simulateTournamentToEnd + finishTournament；
 * 未使用的免费训练自动按当前焦点执行（休赛回合）；ai.aiTrainRound；economy.payRoundSalaries；player.tickModifiers；
 * growth.roundLoyaltyUpdate；market.expireOffers；momentum.updateTeamMomentumRound（荣誉环比，第十四波）；
 * schedule.refreshSeasonInvites（赛季中补充邀请，第十四波）；history.honor/gold 快照。
 */
export function endRound(state: GameState): void {
  const idx = state.roundIndex;
  forEachSeat(state, () => {
    state.activeMatch = null;
  });

  finishRunningTournaments(state, idx);

  // 休赛回合：剩余训练（免费 + 已购）按当前焦点自动完成（多人模式：每个座位各自）
  forEachSeat(state, (me) => {
    const kind = roundKindForPlayer(state, idx);
    if ((kind === 'rest' || kind === 'ti_watch') && state.teams[me] && !state.gameOver) {
      const free = !state.freeTrainingUsed && CONFIG.training.freePerRestRound > 0 ? 1 : 0; // 与 game.consumeSession 一致
      const sessions = free + Math.max(0, state.extraTrainingAvailable);
      for (let i = 0; i < sessions; i++) {
        // 逐次扣减已购次数，以便按先买先用记录每次的购买价
        const sessionCost = i < free ? 0 : pendingExtraSessionCost(state);
        if (i >= free) state.extraTrainingAvailable = Math.max(0, state.extraTrainingAvailable - 1);
        const gains = trainTeam(state, me, state.trainingFocus, undefined, sessionTrainOptions(i < free ? 'free' : 'extra'));
        recordTraining(state, {
          kind: 'auto',
          focus: state.trainingFocus,
          mult: 1,
          cost: sessionCost,
          session: i < free ? 'free' : 'extra',
          sessionCost,
          gains,
        });
      }
      if (sessions > 0) {
        addNews(
          state,
          'system',
          '自动训练',
          `本回合剩余 ${sessions} 次训练已按「${TRAINING_FOCUS_LABEL[state.trainingFocus] ?? '均衡'}」焦点自动完成。`,
        );
      }
    }
    state.freeTrainingUsed = true;
    state.extraTrainingAvailable = 0;
  });

  aiTrainRound(state);
  payRoundSalaries(state);
  tickModifiers(state);
  roundLoyaltyUpdate(state);
  prizeShareRoundUpdate(state); // 奖金分成：补齐缺失值 + AI 战队偶尔调整（第九波）
  expireOffers(state);
  // 挂牌转会：AI 出价 / 倒计时 / 到期自动解约（须在 expireOffers 之后；多人模式每个座位各自处理）
  forEachSeat(state, () => processTransferListings(state));
  // 羁绊（第十波 #5）：回合末的挂牌出售 / 离队之后同步
  syncSynergies(state, { full: true });

  // 上一回合及更早的已结束赛事：压缩 AI 对局记录（本回合的留到下回合，便于赛事中心查看）
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (t && t.roundIndex < idx) compactTournament(state, t, true);
  }
  // 荣誉势头（第十四波）：本回合全部荣誉变化之后更新环比（全部战队）
  updateTeamMomentumRound(state);
  // 赛季中补充邀请（第十四波）：按本赛季积分榜 / 荣誉为尚未开赛的常规赛事补邀（人类战队收到总览通知 + 新闻）
  if (!state.gameOver) refreshSeasonInvites(state);
  forEachSeat(state, () => {
    snapshotHistory(state);
    snapshotSquad(state);
  });
  // 破产检查（第十波 #1，bankruptcy.ts）：本回合全部收支之后；单机玩家破产 → gameOver，多人座位出局
  checkBankruptcy(state);
  newsroomRoundEnd(state); // 新闻编辑部：赛事趋势/纪录、天梯变动、刀塔周报
}

// ---------------------------------------------------------------------------
// TI 结算
// ---------------------------------------------------------------------------

/** 赛季最终排名：巡回赛积分 + TI 名次加成，荣誉为次序 */
export function computeSeasonRanking(state: GameState, tiT: Tournament | null): string[] {
  const bonus = new Map<string, number>();
  if (tiT && tiT.placements.length) {
    const n = Math.max(tiT.placements.length, tiT.teamIds.length);
    for (const p of tiT.placements) {
      bonus.set(p.teamId, CONFIG.season.tiRankBonusMax * (1 - placementPercentile(p.rankFrom, p.rankTo, n)));
    }
  }
  const teams = Object.values(state.teams).filter((t) => !t.disbanded);
  const score = (t: Team) => (t.points ?? 0) + (bonus.get(t.id) ?? 0);
  teams.sort((a, b) => score(b) - score(a) || b.honor - a.honor || a.id.localeCompare(b.id));
  return teams.map((t) => t.id);
}

/** 本赛季夺得的冠军（不含 TI 预选/封闭预选这类 qualifier 级赛事） */
function seasonTitles(state: GameState, ti: number, teamId: string): string[] {
  const names = new Set<string>();
  for (const h of state.history.tournaments) {
    if (h.season === ti && h.championId === teamId && h.tier !== 'qualifier') names.add(h.name);
  }
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (!t || t.tier === 'qualifier' || t.status !== 'finished') continue;
    if (t.placements.some((p) => p.teamId === teamId && p.rankFrom === 1 && p.rankTo === 1)) names.add(t.name);
  }
  return [...names];
}

function teamName(state: GameState, id: string | null | undefined): string {
  if (!id) return '未知';
  return state.teams[id]?.name ?? id;
}

/** 生涯总结（游戏结束页）。endTi：执教区间的终点（默认当前赛季；多人模式中途出局的座位传出局赛季） */
export function careerSummary(state: GameState, endTi: number = state.season.ti): string {
  const me = state.settings.playerTeamId;
  const team = state.teams[me];
  const seasons = state.history.seasons;
  const tiWins = seasons.filter((s) => s.tiChampionId === me).length;
  const titles = seasons.reduce((a, s) => a + s.playerTitles.length, 0);
  let peak = team?.honor ?? 0;
  for (const h of state.history.honor) if (h.value > peak) peak = h.value;
  const lines = [
    `${state.settings.managerName} 执教 ${team?.name ?? '俱乐部'} ${seasons.length} 个赛季（TI${state.settings.startTi}–TI${endTi}）。`,
    `TI 冠军 ${tiWins} 次，各项赛事冠军共 ${titles} 个。`,
    `荣誉峰值 ${Math.round(peak)}，最终荣誉 ${Math.round(team?.honor ?? 0)}，最终资金 ${formatGold(team?.gold ?? 0)}。`,
    tiWins > 0 ? '目标达成：你带队捧起了不朽盾！' : '遗憾：始终未能捧起不朽盾。',
  ];
  return lines.join('\n');
}

function buildSummary(
  state: GameState,
  tiT: Tournament | null,
  myRetired: Player[],
  allRetired: Player[],
): SeasonSummary {
  const s = state.season;
  const me = state.settings.playerTeamId;
  const team = state.teams[me];
  const firstHonor = state.history.honor.find((h) => h.season === s.ti)?.value;
  const firstGold = state.history.gold.find((h) => h.season === s.ti)?.value;
  const honorStart = s.honorStart ?? firstHonor ?? Math.round(team?.honor ?? 0);
  const goldStart = s.goldStart ?? firstGold ?? Math.round(team?.gold ?? 0);
  const honorEnd = Math.round(team?.honor ?? 0);
  const goldEnd = Math.round(team?.gold ?? 0);

  const tiPlacement = tiT?.placements.find((p) => p.teamId === me) ?? null;
  const tiChampionId = tiT?.placements.find((p) => p.rankFrom === 1 && p.rankTo === 1)?.teamId
    ?? state.history.tournaments.find((h) => h.season === s.ti && h.tier === 'ti')?.championId
    ?? null;
  const titles = seasonTitles(state, s.ti, me);
  const finalRank = team?.lastSeasonRank ?? 0;

  const maxList = CONFIG.season.summaryRetiredMax;
  const retiredNames: string[] = myRetired.map((p) => p.handle);
  for (const p of allRetired) {
    if (retiredNames.length >= maxList) break;
    if (myRetired.includes(p)) continue;
    if (p.isReal || tierIndex(playerTier(p)) >= tierIndex('S')) retiredNames.push(p.handle);
  }

  const notes: string[] = [];
  notes.push(`巡回赛积分 ${team?.points ?? 0}，赛季综合排名第 ${finalRank} 位。`);
  if (tiPlacement) {
    notes.push(`TI${s.ti} 成绩：${formatRank(tiPlacement.rankFrom, tiPlacement.rankTo)}。`);
  } else {
    notes.push(`未能晋级 TI${s.ti}。`);
  }
  if (tiChampionId) {
    notes.push(tiChampionId === me ? '我们捧起了不朽盾！' : `TI${s.ti} 冠军：${teamName(state, tiChampionId)}。`);
  }
  notes.push(titles.length ? `本赛季夺得 ${titles.length} 个冠军：${titles.join('、')}。` : '本赛季未能夺冠。');
  const dh = honorEnd - honorStart;
  notes.push(`荣誉 ${honorStart} → ${honorEnd}（${dh >= 0 ? '+' : ''}${dh}）。`);
  notes.push(`资金 ${formatGold(goldStart)} → ${formatGold(goldEnd)}。`);
  if (myRetired.length) notes.push(`队内退役：${myRetired.map((p) => p.handle).join('、')}。`);

  return {
    ti: s.ti,
    year: s.year,
    tiChampionId,
    playerTiRank: tiPlacement ? [tiPlacement.rankFrom, tiPlacement.rankTo] : null,
    playerTitles: titles,
    honorStart,
    honorEnd,
    goldStart,
    goldEnd,
    finalRank,
    retired: retiredNames,
    notes,
  };
}

/**
 * TI 结算：赛季总结（SeasonSummary，popup 'season_summary'）、lastSeasonRank（积分榜 + TI 名次加权）、
 * growth.processRetirements（玩家战队退役者生成 retire 决策：是否聘为教练）、growth.agePlayersAtSeasonEnd、
 * market.processContractExpiry、beefs 清理、在队归属感 tenure；
 * 若 season.ti >= settings.endTi → gameOver={reason:'completed'}；否则 startSeason(ti+1)。
 */
export function settleSeason(state: GameState): void {
  if (state.gameOver) return;
  const ti = state.season.ti;
  const mp = isMultiplayer(state);
  state.phase = 'season_end';
  forEachSeat(state, () => {
    state.activeMatch = null;
  });

  // 防御：仍未结束的赛事（含 TI）全部结算
  finishRunningTournaments(state, Number.POSITIVE_INFINITY);
  if (state.gameOver) return;

  const tiT = findTiTournament(state);

  // 1. 赛季排名（下赛季邀请依据）
  computeSeasonRanking(state, tiT).forEach((id, i) => {
    state.teams[id].lastSeasonRank = i + 1;
  });
  // 生涯档案（legacy.ts）：TI 已结束、退役之前记录本季战力排名 / 名次 / 冠军 / 关键时刻 / 阵容
  // （含本次推进中刚出局、尚未收尾的座位：例如 TI 回合结束时荣誉跌破 0，这个赛季的 TI 成绩照样计入生涯）
  recordLegacySeasonAll(state);
  // DotaPedia（stats.ts）：全部战队的赛季末快照（荣誉 / 排名 / 阵容 / 教练）与选手巅峰，退役之前
  recordPediaSeasonEnd(state);
  // 名人堂（hallOfFame.ts，2026-10-14）：本赛季结算时为 SS / SSR 的在役选手入选（退役之前），下个赛季起可作为请神原型
  inductHallOfFame(state, ti);
  // 俱乐部使命（第十波 #3，missions.ts）：集齐巅峰阵容的俱乐部夺得 TI → 记录与新闻（退役之前）
  missionSeasonEnd(state, tiT);

  // 2. 退役（先记下各玩家阵容，processRetirements 会把退役者移出战队；多人模式每个座位各自统计）
  const humans = mp ? activeHumanIds(state) : [state.settings.playerTeamId];
  const rosterBefore = new Map(humans.map((h) => [h, new Set(state.teams[h]?.playerIds ?? [])]));
  const { retired, newCoaches } = processRetirements(state);
  const retiredBy = new Map(humans.map((h) => [h, retired.filter((p) => rosterBefore.get(h)!.has(p.id))]));
  const retiredAges = new Map<string, number>();
  for (const list of retiredBy.values()) for (const p of list) retiredAges.set(p.id, ageOf(state, p));

  // 3. 年龄 → 4. 合同 → 5. 宿敌清理 → 6. 在队归属感
  agePlayersAtSeasonEnd(state);
  missionContractRetention(state); // 俱乐部使命：AI 使命俱乐部大概率与到期的使命成员续约（第十波 #3）
  processContractExpiry(state);
  // 羁绊（第十波 #5）：退役 / 合同到期拆散的羁绊立即收回加成（届次未变，此处只会失效、不会新觉醒），
  // 避免下赛季初的自主成长与转会潮沿用已失效的加成
  syncSynergies(state, { full: true });
  forEachSeat(state, () => {
    state.beefs = state.beefs.filter((b) => b.season > ti);
  });
  for (const id in state.players) {
    const p = state.players[id];
    if (p.status === 'active' && p.teamId && !p.tempSubUntilTournament) adjustLoyalty(p, CONFIG.loyalty.tenurePerSeason);
  }

  // 7. 赛季总结（每个座位各一份）
  forEachSeat(state, (me) => {
    const summary = buildSummary(state, tiT, retiredBy.get(me) ?? [], retired);
    state.history.seasons.push(summary);
    pushPopup(state, { kind: 'season_summary', ti });
    addNews(state, 'season', `TI${ti} 赛季总结`, summary.notes.join('\n'), true);
  });

  // 8. 生涯结束 or 下一赛季
  if (ti >= state.settings.endTi) {
    const summary = mp ? multiplayerCareerSummary(state) : careerSummary(state);
    state.gameOver = { reason: 'completed', summary };
    addNews(state, 'system', '执教生涯落幕', state.gameOver.summary, true);
    return;
  }

  // 玩家战队退役者转任的教练：下赛季 AI 转会窗口期间临时占位，保证玩家的优先签约权
  const coachOf = (p: Player): Coach | undefined => newCoaches.find((c) => c.formerPlayerId === p.id);
  const reservedBy = new Map(humans.map((h) => [
    h, (retiredBy.get(h) ?? []).map(coachOf).filter((c): c is Coach => !!c && c.teamId === null),
  ]));
  for (const [h, list] of reservedBy) for (const c of list) c.teamId = h;
  try {
    startSeason(state, ti + 1);
  } finally {
    for (const [h, list] of reservedBy) {
      const myCoachId = state.teams[h]?.coachId;
      for (const c of list) if (c.teamId === h && myCoachId !== c.id) c.teamId = null;
    }
  }
  // 新赛季回合 0 的随机事件可能直接导致解散：不再生成退役抉择
  if (state.gameOver) return;

  forEachSeat(state, (me) => {
    for (const p of retiredBy.get(me) ?? []) {
      const c = coachOf(p);
      if (!c || c.teamId !== null) {
        addNews(state, 'transfer', `${p.handle} 退役`, `${p.handle} 宣布结束职业生涯，感谢他为俱乐部的付出。`);
        continue;
      }
      const hasCoach = !!state.teams[me]?.coachId;
      state.pendingDecisions.push({
        id: nextId(state, 'd'),
        kind: 'retire',
        title: `${p.handle} 宣布退役`,
        body: `${p.handle}（${retiredAges.get(p.id) ?? '?'} 岁）结束了职业生涯，可转型为 ${c.tier} 级教练`
          + `（灵性 ${Math.round(c.insight)}，天赋提升 ${c.talentBoost.toFixed(1)}，韧性提升 ${c.resilienceBoost.toFixed(1)}，`
          + `工资 ${formatGold(c.salary)}/回合）。作为老东家，你拥有优先签约权，免签字费。`,
        choices: [
          { id: 'hire_as_coach', label: '聘为主教练', description: hasCoach ? '现任主教练将离队' : '免签字费' },
          { id: 'decline', label: '不聘用', description: '他将进入教练市场' },
        ],
        ctx: { playerId: p.id, coachId: c.id },
        createdRound: state.roundIndex,
        blocking: true,
      });
    }
  });
}

/** 多人模式的生涯总结：每个座位一段 */
export function multiplayerCareerSummary(state: GameState): string {
  const parts: string[] = [];
  for (const id of humanTeamIds(state)) {
    const seat = state.multiplayer?.seats[id];
    // 中途出局的座位：执教区间止于出局赛季（荣誉曲线的最后一个点由出局时的荣誉变更写入）
    const text = withSeat(state, id, () => {
      const lastTi = seat?.eliminated ? state.history.honor[state.history.honor.length - 1]?.season : undefined;
      return careerSummary(state, typeof lastTi === 'number' && lastTi <= state.season.ti ? lastTi : state.season.ti);
    });
    parts.push(`【${seat?.name ?? id}${seat?.eliminated ? '（已出局）' : ''}】${text}`);
  }
  return parts.join('\n\n');
}
