// ============================================================================
// 多人对战：座位（Seat）与上下文切换【MP1】
// 设计见 docs/MULTIPLAYER.md §5 / §8。核心思想：
//   GameState 顶层的「玩家私有字段」（训练次数、待决事件、比赛、财务、弹窗……）在执行某位玩家的操作前
//   从 multiplayer.seats[teamId] 换入顶层、执行后换出，因此现有单机引擎函数几乎不用改（底层实现见 seat.ts）。
//   全局流程（AI、赛事推进、回合推进）在「中性」上下文中运行，玩家相关部分由 season.ts 等按座位执行。
//   单机模式（state.multiplayer 为空）下所有函数退化为单座位，行为与改造前完全一致。
// ============================================================================
import type {
  AdvanceBlocker, GameState, H2HMatch, NewGameOptions, OpResult, PendingDecision, Popup, Region, RosterFile, SeatState,
  Tier,
} from './types';
import { POSITIONS, REGIONS } from './types';
import { CONFIG, MAX_TI } from './config';
import { RPC_TEAM_ARG, RPC_WHITELIST, type RpcName } from '../shared/protocol';
import { loadRoster, getPlayerIndex } from '../data/index';
import { hashSeed, rngOf } from './rng';
import { formatGold, ownEntry } from './util';
import { addNews, newsIsMine } from './news';
import {
  activeHumanIds, ensureNeutral, forEachSeat, humanTeamIds, isMultiplayer, seatInPlay, withSeat,
} from './seat';
import {
  advanceRound, buyExtraTraining, clubSlug, commitGame, createBlankState, createNewClubTeam, dismissPopup, doScrim,
  doTraining, dropStaleMatch, fillLineupWithTempSubs, fireCoach, getAdvanceBlockers, hireCoach,
  markAllNewsRead,
  playGame, playerDraftAction, prepareNextMatch, quickSimSeries, quickSimTournament, setTrainingFocus, startDraft,
} from './game';
import {
  autoArrangeLineup, autoDraftAndPlay, dismissPopups, markNewsRead, setPlayerAsStarter, talkWithPlayer,
} from './uiActions';
import { finalizePlayerTournamentIfDone, initPatchBaseline, multiplayerCareerSummary, startSeason } from './season';
import { advanceTournamentUntilPlayer, readySeries } from './tournament';
import { coachFromSeed, generatePlayer, playerFromSeed, teamFromSeed } from './generation';
import { aiEnsureRosters } from './ai';
import { autoLineup, rosterOverCap, setLineupSlot } from './team';
import { ROLE_DATA_VERSION } from './roles';
import { migrateRealRoles } from './roleSync';
import { computeSalary } from './player';
import { newClubStartingFunds, seedTeamStartingFunds } from './economy';
import { registerForTournament, unregisterFromTournament } from './schedule';
import {
  bidForPlayer, departToFreeAgency, generateTempSubCandidates, hireTempSub, releasePlayer, releasePlayers,
  renewContract, respondToOffer, signFreeAgent,
} from './market';
import {
  listPlayerForTransfer, listPlayersForTransfer, raiseSalary, talkToPlayer, teamBuilding, unlistPlayer,
} from './squadOps';
import { tradeForPlayer } from './trade';
import { releaseDraftedRookie } from './rookieDraft';
import { gachaDiscard, gachaPull } from './gacha';
import { hallOfFameNeedsMigration, migrateHallOfFame } from './hallOfFame';
import { setPrizeShare } from './prizeShare';
import { resolveDecision } from './events';
import { autoHandleRound, type AutoRoundReport } from './autoRound';
import { tiYear } from './calendar';
import { recordLegacyPartial } from './legacy';

export type { MpMode, SeatState, MultiplayerInfo, H2HMatch, SeatSaved } from './types';
export {
  isMultiplayer, humanTeamIds, isHumanTeam, withSeat, forEachSeat, inSeatOf, activeHumanIds, seatInPlay, ensureNeutral,
} from './seat';

export interface MpPlayerSpec {
  sessionId: string;
  name: string;
  /** existing 模式：选择的真实战队 */
  teamId?: string;
  /** build 模式：新俱乐部 */
  newClub?: { name: string; tag: string; region: Region; color: string };
}

export interface MpNewGameOptions {
  startTi: number;
  endTi: number;
  difficulty: NewGameOptions['difficulty'];
  mode: 'build' | 'existing';
  players: MpPlayerSpec[];
  seed?: number;
}

/** 多人对局最多座位数（protocol：房间 2–6 人；引擎允许 1 人以便测试） */
export const MP_MAX_SEATS = 6;

const ok = (message: string): OpResult => ({ ok: true, message });
const fail = (message: string): OpResult => ({ ok: false, message });

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function deepClone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}

function seatName(state: GameState, teamId: string): string {
  return state.multiplayer?.seats[teamId]?.name || ownEntry(state.teams, teamId)?.name || teamId;
}

// ---------------------------------------------------------------------------
// 创建对局
// ---------------------------------------------------------------------------

function validateOptions(opts: MpNewGameOptions): string | null {
  if (!opts || typeof opts !== 'object') return '多人对局参数缺失';
  if (!Number.isInteger(opts.startTi) || opts.startTi < 1 || opts.startTi > MAX_TI) return `起始赛季需为 TI1–TI${MAX_TI}`;
  if (!Number.isInteger(opts.endTi) || opts.endTi < opts.startTi) return '终点 TI 不能早于起始 TI';
  if (!['easy', 'normal', 'hard'].includes(opts.difficulty)) return '难度设置无效';
  if (opts.mode !== 'build' && opts.mode !== 'existing') return '玩法无效';
  const players = Array.isArray(opts.players) ? opts.players : [];
  if (players.length < 1) return '至少需要 1 名玩家';
  if (players.length > MP_MAX_SEATS) return `最多 ${MP_MAX_SEATS} 名玩家`;
  const sessions = new Set<string>();
  for (const p of players) {
    if (!p || typeof p.sessionId !== 'string' || !p.sessionId) return '玩家身份缺失';
    if (sessions.has(p.sessionId)) return '同一玩家不能占用多个座位';
    sessions.add(p.sessionId);
    if (opts.mode === 'build') {
      if (!p.newClub || !(p.newClub.name ?? '').trim()) return `请为玩家「${p.name}」填写俱乐部名称`;
      if (!REGIONS.includes(p.newClub.region)) return `玩家「${p.name}」的俱乐部赛区无效`;
    } else if (typeof p.teamId !== 'string' || !p.teamId) {
      return `请为玩家「${p.name}」选择战队`;
    }
  }
  if (opts.mode === 'existing') {
    const ids = players.map((p) => p.teamId);
    if (new Set(ids).size !== ids.length) return '同一支战队不能被多名玩家选择';
  }
  return null;
}

/**
 * existing 玩法：玩家接管的真实战队重置为「新俱乐部」水平 —— 现役选手属性按新俱乐部初始选手的分布重新生成
 * （首发按新俱乐部的 S/A/B 等级构成随机分配，替补为 B 级），只保留 ID、显示名（handle/name）与天赋；
 * 国籍/赛区/位置/招牌英雄作为选手身份保留。俱乐部荣誉、资金重置为新俱乐部标准；主教练离队进入教练市场（保证公平）。
 */
function resetToNewClubLevel(state: GameState, teamId: string, difficulty: string): void {
  const team = ownEntry(state.teams, teamId);
  if (!team) return;
  team.isPlayer = true;
  team.honor = CONFIG.team.newClubHonor;
  if (team.coachId) {
    const c = state.coaches[team.coachId];
    if (c) c.teamId = null;
    team.coachId = null;
  }
  autoLineup(state, teamId);
  const rng = rngOf(state);
  const order = rng.shuffle(POSITIONS.slice());
  const sCount = CONFIG.season.newClubSTierCount[difficulty] ?? CONFIG.season.newClubSTierCount.normal;
  const aCount = CONFIG.season.newClubATierCount[difficulty] ?? CONFIG.season.newClubATierCount.normal;
  const tierAt = new Map(order.map((pos, i) => [pos, (i < sCount ? 'S' : i < sCount + aCount ? 'A' : 'B') as Tier]));
  const ti = state.season?.ti ?? state.settings.startTi;
  for (const id of team.playerIds.slice()) {
    const p = state.players[id];
    if (!p || p.status !== 'active') continue;
    const slot = POSITIONS.find((pos) => team.lineup[pos] === p.id);
    const tier: Tier = slot ? tierAt.get(slot) ?? 'B' : 'B';
    const g = generatePlayer(state, { tier, position: p.position, region: team.region });
    delete state.players[g.id];
    p.mmr = g.mmr;
    p.power = g.power;
    p.resilience = g.resilience;
    p.insight = g.insight;
    p.loyalty = g.loyalty;
    p.birthYear = g.birthYear;
    p.modifiers = [];
    delete p.formTrend;
    delete p.isRookie;
    // 自主成长（development.ts）：被重置的真实选手不再参照真实生涯轨迹，按天赋 / 年龄重新评估潜力
    p.development = { noTrajectory: true };
    p.salary = computeSalary(state, p);
    p.contractUntil = ti + Math.max(1, CONFIG.season.newClubContractSeasons) - 1;
    p.joinedSeason = ti;
  }
  autoLineup(state, teamId);
  // 资金重置为新俱乐部标准（economy.newClubStartingFunds：TI1 普通难度 20 万 × 年代系数 × 难度倍数，与「各自组建」相同，座位之间公平）
  team.gold = newClubStartingFunds(ti, difficulty);
}

/**
 * 创建多人对局：加载起始 TI 阵容；
 * - build：为每位玩家创建新俱乐部（与单机新俱乐部相同规则）；
 * - existing：玩家接管所选真实战队，队内现役选手属性重置为「组建战队时的水平」（与新俱乐部初始选手同分布），
 *   只保留姓名（handle/name）、ID 与天赋（talent）；俱乐部荣誉与资金重置为新俱乐部标准。
 * 所有玩家战队 isPlayer = true；初始化各座位私有状态；startSeason。返回的 state 处于中性上下文。
 */
export async function createMultiplayerGame(opts: MpNewGameOptions): Promise<GameState> {
  const invalid = validateOptions(opts);
  if (invalid) throw new Error(invalid);
  const startTi = opts.startTi;
  const endTi = Math.min(MAX_TI, Math.max(startTi, Math.floor(opts.endTi)));

  let roster: RosterFile;
  try {
    roster = await loadRoster(startTi);
  } catch (e) {
    if (opts.mode === 'existing') throw new Error(`无法加载 TI${startTi} 阵容数据：${errMsg(e)}`);
    roster = { ti: startTi, year: tiYear(startTi), teams: [], freeAgents: [], freeCoaches: [] };
  }
  const seedTeams = Array.isArray(roster?.teams) ? roster.teams : [];

  // 玩家战队 id：真实战队沿用；新俱乐部按名称生成，不与真实战队/其他玩家冲突
  const ids: string[] = [];
  const taken = new Set(seedTeams.map((t) => t?.id));
  for (const p of opts.players) {
    if (opts.mode === 'existing') {
      if (!seedTeams.some((t) => t?.id === p.teamId)) throw new Error(`TI${startTi} 阵容中找不到战队「${p.teamId}」`);
      ids.push(p.teamId!);
    } else {
      const base = `club-${clubSlug(p.newClub!.name) || 'player'}`;
      let id = base;
      for (let i = 2; taken.has(id) || ids.includes(id); i++) id = `${base}-${i}`;
      ids.push(id);
    }
  }

  const createdAt = new Date().toISOString(); // 仅此处使用真实时间（存档时间戳/默认种子）
  const seed = (opts.seed ?? hashSeed(`${createdAt}|${ids.join(',')}`)) | 0;
  const state = createBlankState({
    seed, createdAt, startTi, endTi, difficulty: opts.difficulty, managerName: '', playerTeamId: '',
  });
  state.id = `mp-${(seed >>> 0).toString(36)}`;
  const seats: Record<string, SeatState> = {};
  opts.players.forEach((p, i) => {
    const name = (p.name ?? '').trim() || `玩家${i + 1}`;
    seats[ids[i]] = {
      teamId: ids[i], sessionId: p.sessionId, name, eliminated: false, ready: false,
      saved: { settings: { managerName: name } },
    };
  });
  state.multiplayer = { mode: opts.mode, hostTeamId: ids[0], order: ids.slice(), seats, activeSeat: null, h2h: {} };

  initPatchBaseline(state, state.season.startDate);

  // 真实战队（AI 资金按真实俱乐部口径 economy.seedTeamStartingFunds，与单机同一公式；玩家接管的随后重置为新俱乐部标准）
  for (const st of seedTeams) {
    if (!st?.id || state.teams[st.id]) continue;
    const human = opts.mode === 'existing' && ids.includes(st.id);
    const team = teamFromSeed(state, st, human);
    team.isPlayer = human;
    team.gold = seedTeamStartingFunds(st, startTi, null);
  }
  for (const fa of roster.freeAgents ?? []) if (fa?.id && !state.players[fa.id]) playerFromSeed(state, fa, null);
  for (const c of roster.freeCoaches ?? []) if (c?.id && !state.coaches[c.id]) coachFromSeed(state, c, null);

  if (opts.mode === 'build') opts.players.forEach((p, i) => createNewClubTeam(state, ids[i], p.newClub!, opts.difficulty));
  else for (const id of ids) resetToNewClubLevel(state, id, opts.difficulty);

  // 真实新秀：未来首次登场、且不在本届名单中的选手
  let index: ReturnType<typeof getPlayerIndex> = [];
  try {
    index = getPlayerIndex() ?? [];
  } catch {
    index = [];
  }
  for (const e of index) {
    if (!e?.id || state.players[e.id]) continue;
    if (e.firstTi > startTi && e.firstTi <= MAX_TI) state.futureRookies[e.id] = e.firstTi;
  }

  // 补足的程序化 AI 战队：资金在 generation.generateAiTeam 中按真实俱乐部同一公式折算
  aiEnsureRosters(state);
  Object.values(state.teams)
    .filter((t) => !t.disbanded)
    .sort((a, b) => b.honor - a.honor || a.id.localeCompare(b.id))
    .forEach((t, i) => {
      t.lastSeasonRank = i + 1;
    });
  for (const id of ids) autoLineup(state, id);

  startSeason(state, startTi);

  forEachSeat(state, (id) => {
    const team = state.teams[id];
    const name = seatName(state, id);
    addNews(
      state, 'system', `欢迎上任，${name}！`,
      `你已成为 ${team.name} 的经理。目标：在 TI${endTi} 之前捧起不朽盾。当前荣誉 ${Math.round(team.honor)}，资金 ${formatGold(team.gold)}。`,
      true,
    );
    // 欢迎弹窗排在最前（赛季初选秀的结果弹窗随后）
    state.popups.unshift({
      kind: 'message',
      title: '欢迎来到刀塔经理 · 多人对战',
      body: `${team.name}（${team.tag}）的征程从 TI${startTi} 赛季开始，共 ${endTi - startTi + 1} 个赛季，与 ${ids.length - 1} 名玩家同场竞技。\n`
        + '所有玩家共享同一个大回合：回合内各自操作（训练、转会、报名、比赛……），操作按到达服务器的先后实时结算；'
        + '完成本回合事务后点击「准备」，全部玩家准备后进入下一回合。\n'
        + '玩家之间的系列赛：双方都进入比赛后开始，BP 各自操作；快速模拟需双方都同意。',
    });
  });
  drainNeutral(state);
  return state;
}

// ---------------------------------------------------------------------------
// 中性上下文的收尾 / 出局处理
// ---------------------------------------------------------------------------

/**
 * 全局流程（中性上下文）写入顶层私有字段的内容按座位分发：弹窗（如版本更新）广播给每个未出局座位；
 * 待决事件按 ctx.teamId 路由到对应座位；其余中性私有数据清空。
 */
function drainNeutral(state: GameState): void {
  if (!isMultiplayer(state)) return;
  ensureNeutral(state);
  const popups: Popup[] = (state.popups ?? []).splice(0);
  const decisions: PendingDecision[] = (state.pendingDecisions ?? []).splice(0);
  if (popups.length) forEachSeat(state, () => { state.popups.push(...deepClone(popups)); });
  for (const d of decisions) {
    const tid = d.ctx?.teamId;
    if (typeof tid === 'string' && seatInPlay(state, tid)) withSeat(state, tid, () => { state.pendingDecisions.push(d); });
  }
  state.finance = [];
  state.activeMatch = null;
  state.beefs = [];
  const h = state.history;
  if (h) {
    h.playerSettlements = [];
    h.honor = [];
    h.gold = [];
    h.seasons = [];
    h.training = [];
    h.squadProgress = {};
  }
}

/**
 * 出局处理：荣誉跌破 0 的座位（honor.applyHonorChange 已标记 eliminated / disbanded）、破产的座位（bankruptcy.declareBankruptcy）——
 * 选手离队成为自由选手、主教练进入市场、清空该座位的待办与比赛；全部玩家出局 → 游戏结束。
 */
function processEliminations(state: GameState): void {
  const mp = state.multiplayer;
  if (!mp) return;
  for (const id of humanTeamIds(state)) {
    const seat = mp.seats[id];
    const team = state.teams[id];
    if (!seat || !team || !(seat.eliminated || team.disbanded)) continue;
    seat.eliminated = true;
    seat.ready = false;
    delete seat.autoReady;
    team.disbanded = true;
    // 未完成的玩家对决：对手的比赛退化为普通比赛（对阵已解散的战队），共享对局作废
    // （否则对手的视图仍按共享对局同步、托管仍按玩家对决处理）。幂等，每次都检查。
    for (const sid of Object.keys(mp.h2h ?? {})) {
      const h = mp.h2h![sid];
      if (h && !h.done && (h.teamA === id || h.teamB === id)) delete mp.h2h![sid];
    }
    // 观战座位不再有待办与比赛（只在确有残留时切换上下文，避免每次 RPC 都换入已出局座位）
    const top = seat.saved?.top;
    const stale = mp.activeSeat === id
      || (Array.isArray(top?.pendingDecisions) && top.pendingDecisions.length > 0) || !!top?.activeMatch;
    if (stale) {
      withSeat(state, id, () => {
        state.pendingDecisions = [];
        state.activeMatch = null;
      });
    }
    if (team.playerIds.length || team.coachId) { // 首次处理（之后名单为空、无教练）
      // 生涯档案（legacy.ts）：选手离队前冻结截至出局时的赛季（全员假赛禁赛已由 scandal.banClub 冻结）。
      // 出局收尾在整次推进之后执行：TI 回合结束时出局的座位此时已进入下一赛季，出局赛季取荣誉曲线的最后一点
      // （出局那次荣誉变更写入；之后该座位不再记录曲线，与 season.multiplayerCareerSummary 同口径）。
      try {
        withSeat(state, id, () => {
          const hist = state.history?.honor;
          const lastTi = Array.isArray(hist) && hist.length ? hist[hist.length - 1]?.season : undefined;
          recordLegacyPartial(
            state, id, team.banned ? 'banned' : team.bankrupt ? 'bankrupt' : 'disbanded', typeof lastTi === 'number' ? lastTi : undefined,
          );
        });
      } catch (e) {
        console.error('[engine] recordLegacyPartial', e);
      }
      for (const pid of team.playerIds.slice()) departToFreeAgency(state, pid);
      team.playerIds = [];
      team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
      if (team.coachId) {
        const c = state.coaches[team.coachId];
        if (c && c.teamId === id) c.teamId = null;
        team.coachId = null;
      }
      // 破产（bankruptcy.ts）的座位同样在这里收尾（选手离队、教练进入市场）
      addNews(state, 'system', `【出局】${team.name} ${team.bankrupt ? '破产' : '解散'}`,
        `玩家「${seat.name}」执教的 ${team.name} ${team.bankrupt ? '资金链断裂宣告破产' : '荣誉跌破 0，俱乐部解散'}，选手成为自由选手。该玩家转为观战，其余玩家继续。`,
        true, { teamIds: [id], visibility: 'public' });
    }
    nudgeTournamentsOf(state, id);
  }
  if (!state.gameOver && humanTeamIds(state).length > 0 && humanTeamIds(state).every((id) => mp.seats[id]?.eliminated)) {
    // 全部因全员假赛被除名 → 'banned'；全部破产 → 'bankrupt'；否则（含部分解散）→ 'disbanded'（各座位结算页按自己的结局展示，见 legacy.legacyEndingOf）
    const allBanned = humanTeamIds(state).every((id) => !!state.teams[id]?.banned);
    const allBankrupt = !allBanned && humanTeamIds(state).every((id) => !!state.teams[id]?.bankrupt);
    state.gameOver = {
      reason: allBanned ? 'banned' : allBankrupt ? 'bankrupt' : 'disbanded',
      summary: `${allBanned ? '所有玩家的俱乐部都因全员假赛被永久除名' : allBankrupt ? '所有玩家的俱乐部都已破产'
        : humanTeamIds(state).some((id) => !!state.teams[id]?.banned) ? '所有玩家的俱乐部都已解散或被除名'
          : humanTeamIds(state).some((id) => !!state.teams[id]?.bankrupt) ? '所有玩家的俱乐部都已解散或破产' : '所有玩家的俱乐部都已解散'}，游戏结束。\n\n${multiplayerCareerSummary(state)}`,
    };
    addNews(state, 'system', '游戏结束', state.gameOver.summary, true);
  }
}

/**
 * 出局座位在进行中的赛事里还有就绪的系列赛：赛事自动推进原本停在这场「玩家比赛」上，出局后它改由 AI 代打，
 * 但不会有人再触发推进 —— 其他玩家会一直停在「下一场比赛尚未确定，请等待其他玩家」而无法准备。
 * 这里重新推进（幂等：之后该队已没有就绪的系列赛，或被仍在比赛的玩家的系列赛挡住、由其完赛后推进）。
 */
function nudgeTournamentsOf(state: GameState, teamId: string): void {
  for (const tid of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[tid];
    if (!t || t.status !== 'running') continue;
    if (!readySeries(state, tid).some((s) => s.teamA === teamId || s.teamB === teamId)) continue;
    advanceTournamentUntilPlayer(state, tid);
    finalizePlayerTournamentIfDone(state, tid);
  }
}

/** 已出结果 / 赛事已结束的玩家对决共享对局 */
function pruneH2H(state: GameState): void {
  const h2h = state.multiplayer?.h2h;
  if (!h2h) return;
  for (const id of Object.keys(h2h)) {
    const h = h2h[id];
    const t = state.tournaments[h?.tournamentId ?? ''];
    if (!h || h.done || !t || t.status === 'finished' || !!t.series[h.seriesId]?.result) delete h2h[id];
  }
}

/**
 * 有座位的准备状态因新的阻塞失效（如对手刚打完一场、出现新的待决事件）时取消准备。
 * 以自动处理请求的准备（seat.autoReady）保留意图：随后的 pumpAutoReady 会自动处理新的阻塞并重新准备。
 */
function refreshReadiness(state: GameState): void {
  const mp = state.multiplayer;
  if (!mp) return;
  for (const id of humanTeamIds(state)) {
    const seat = mp.seats[id];
    if (!seat?.ready) continue;
    if (!seatInPlay(state, id) || seatBlockers(state, id).length) seat.ready = false;
  }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/**
 * 生成发送给某玩家的视图：深拷贝、该座位私有字段已换入顶层、settings.playerTeamId = 该战队，
 * 其他座位的私有数据（财务、待决事件、弹窗等）被剥离，private 新闻只保留与该玩家相关的。
 */
export function seatView(state: GameState, teamId: string): GameState {
  const mp = state.multiplayer;
  if (!mp) return deepClone(state);
  if (!mp.seats[teamId]) throw new Error(`座位不存在：${teamId}`);
  const view = withSeat(state, teamId, () => deepClone(state));
  const vmp = view.multiplayer!;
  for (const id of Object.keys(vmp.seats)) {
    const s = vmp.seats[id];
    s.saved = {};
    if (id !== teamId) s.sessionId = '';
  }
  vmp.activeSeat = teamId;
  if (vmp.h2h) {
    for (const sid of Object.keys(vmp.h2h)) {
      const h = vmp.h2h[sid];
      if (!h || (h.teamA !== teamId && h.teamB !== teamId)) delete vmp.h2h[sid];
    }
    syncViewWithH2H(view, teamId);
  }
  view.news = (view.news ?? []).filter((n) => n.visibility !== 'private' || newsIsMine(view, n, teamId));
  // 新秀抽卡（gacha.ts）：其他战队的逐张抽卡记录与保底进度是私有的（卡池与各队阵容本身公开）
  for (const id of Object.keys(view.teams ?? {})) {
    const g = view.teams[id]?.gacha;
    if (id === teamId || !g) continue;
    delete g.log;
    delete (g as Partial<typeof g>).pity;
  }
  // 随机数状态与谈判密钥只留在服务器：客户端拿到 rngState 就能用自带的引擎算出下一张卡（卡池公开），
  // 拿到密钥就能算出谈判骰子（2026-10-14 审查）。客户端界面不使用这两个值
  view.rngState = 0;
  if (vmp.secret !== undefined) vmp.secret = '';
  // 尚未曝光的全员假赛计划不下发（只保留已曝光的历史档案）
  if (view.clubScandals) view.clubScandals = { plans: [], history: view.clubScandals.history ?? [] };
  view.delayedEvents = (view.delayedEvents ?? []).filter((d) => d.ctx?.teamId === teamId);
  return view;
}

/** 视图中的玩家对决：比赛视图不在回放时与共享对局对齐（BP 进度、已赛局数） */
function syncViewWithH2H(view: GameState, teamId: string): void {
  const am = view.activeMatch;
  const h: H2HMatch | undefined = am ? view.multiplayer?.h2h?.[am.seriesId] : undefined;
  if (!am || !h || am.pendingGame) return;
  if (h.done) {
    // 对手弃权 / 快速模拟等已结束的对决：视图中不再显示比赛（引擎状态在该座位下次操作时清理）
    view.activeMatch = null;
    return;
  }
  const side = h.teamA === teamId ? 'A' : 'B';
  am.games = h.games.slice();
  am.gameIndex = h.games.length;
  am.draft = h.draft;
  // 与 game.syncH2HViews 一致：尚未选择 BP 方式时停留在赛前准备
  am.phase = h.draft && h.mode[side] ? 'draft' : 'pre';
  am.manualDraft = h.mode[side] === 'manual';
}

// ---------------------------------------------------------------------------
// 回合准备 / 推进
// ---------------------------------------------------------------------------

/** 某座位推进前的阻塞（在其上下文中调用 game.getAdvanceBlockers） */
export function seatBlockers(state: GameState, teamId: string): AdvanceBlocker[] {
  const mp = state.multiplayer;
  if (!mp) return getAdvanceBlockers(state);
  const seat = mp.seats[teamId];
  if (!seat) return [{ code: 'game_over', message: '座位不存在' }];
  if (seat.eliminated) return [{ code: 'game_over', message: '战队已解散，当前为观战模式' }];
  return withSeat(state, teamId, () => {
    dropStaleMatch(state);
    return getAdvanceBlockers(state);
  });
}

/** 只需等待（对手 / 其他玩家）的阻塞：自动处理后仍剩这些时保留自动准备的意图 */
const WAITABLE_BLOCKERS = new Set<AdvanceBlocker['code']>(['match_in_progress', 'tournament_running']);

/**
 * 在座位上下文中执行自动处理（autoRound.autoHandleRound），随后处理出局 / 失效的准备。
 * 不标记准备；返回处理摘要（座位不在游戏中时为空摘要）。
 */
function autoHandleSeat(state: GameState, teamId: string, opts: Parameters<typeof autoHandleRound>[1] = {}): AutoRoundReport | null {
  if (state.gameOver || !seatInPlay(state, teamId)) return null;
  let rep: AutoRoundReport | null = null;
  try {
    rep = withSeat(state, teamId, () => autoHandleRound(state, opts));
  } finally {
    processEliminations(state);
    refreshReadiness(state);
  }
  return rep;
}

/**
 * 以自动处理请求准备、但当时仍需等待的座位（seat.autoReady 且未准备）：继续自动处理，无阻塞即准备。
 * 在任何玩家的操作（callAsSeat）、准备（setSeatReady）之后调用；一名座位的进展可能让另一名座位可以继续（如玩家对决），
 * 因此重复到没有新进展为止（有上限）。不推进回合（由调用方 / 服务器在全员准备后推进）。
 */
export function pumpAutoReady(state: GameState): void {
  const mp = state.multiplayer;
  if (!mp || state.gameOver) return;
  try {
    ensureNeutral(state);
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const id of humanTeamIds(state)) {
        const seat = mp.seats[id];
        if (!seat?.autoReady || seat.ready) continue;
        if (state.gameOver) return;
        if (!seatInPlay(state, id)) {
          delete seat.autoReady;
          continue;
        }
        const rep = autoHandleSeat(state, id);
        if (rep?.progressed) changed = true;
        if (seatInPlay(state, id) && !state.gameOver && !seatBlockers(state, id).length) {
          seat.ready = true;
          changed = true;
        }
      }
      if (!changed) break;
    }
  } catch (e) {
    console.error('[engine] pumpAutoReady', e);
    ensureNeutral(state);
  }
}

/**
 * 设置回合准备：有阻塞时不能准备（返回原因）；取消准备总是允许（同时撤销自动处理的意图）。
 * opts.auto（「下一回合」按钮，协议 setRoundReady.auto）：先在该座位上下文中自动处理本回合事务
 * （默认处理待决事件、补齐首发、快速模拟本方剩余比赛；玩家对决登记快速模拟并选择自动 BP），再标记准备。
 * 自动处理后只剩「等待对手 / 其他玩家」类阻塞时返回成功并保留意图（seat.autoReady）：之后任何玩家的操作后自动继续，
 * 可以时自动准备；对手也自动推进（或同意快速模拟、或是房主托管的离线座位）时玩家对决即结算，不会互相卡住。
 */
export function setSeatReady(state: GameState, teamId: string, ready: boolean, opts: { auto?: boolean } = {}): OpResult {
  const seat = state.multiplayer?.seats[teamId];
  if (!seat) return fail('座位不存在');
  if (!ready) {
    seat.ready = false;
    delete seat.autoReady;
    return ok('已取消准备');
  }
  if (state.gameOver) return fail('游戏已结束');
  if (seat.eliminated) return fail('战队已解散，当前为观战模式');
  let lines: string[] = [];
  let waiting: string | null = null;
  if (opts.auto) {
    const rep = autoHandleSeat(state, teamId);
    waiting = rep?.waiting ?? null;
    lines = (rep?.lines ?? []).filter((l) => l !== rep?.waiting);
    if (state.gameOver) return ok(lines.length ? `${lines.join('；')}。游戏已结束` : '游戏已结束');
    if (seat.eliminated) return ok(`${lines.join('；')}${lines.length ? '。' : ''}战队已解散，当前为观战模式`);
  }
  const done = lines.length ? `已自动处理：${lines.join('；')}。` : '';
  const blockers = seatBlockers(state, teamId);
  if (blockers.length) {
    seat.ready = false;
    if (opts.auto && blockers.every((b) => WAITABLE_BLOCKERS.has(b.code))) {
      seat.autoReady = true;
      // 本座位的自动处理可能让其他等待中的座位可以继续（如登记快速模拟后对手的请求随之结算）
      pumpAutoReady(state);
      if (seat.ready) return ok(`${done}${allSeatsReady(state) ? '全部玩家已准备' : '已准备，等待其他玩家'}`);
      return ok(`${done}${waiting ?? blockers.map((b) => b.message).join('；')}。将在可以时自动处理并准备`);
    }
    return fail(`${done}${blockers.map((b) => b.message).join('；')}`);
  }
  seat.ready = true;
  if (opts.auto) {
    seat.autoReady = true;
    pumpAutoReady(state);
  }
  return ok(`${done}${allSeatsReady(state) ? '全部玩家已准备' : '已准备，等待其他玩家'}`);
}

/** 全部未出局座位都已准备 */
export function allSeatsReady(state: GameState): boolean {
  const mp = state.multiplayer;
  if (!mp || state.gameOver) return false;
  const live = humanTeamIds(state).filter((id) => !mp.seats[id]?.eliminated);
  return live.length > 0 && live.every((id) => mp.seats[id]?.ready);
}

/**
 * 多人房间的存档迁移（服务器载入房间时由 server/rooms.ts 经 MpEngine.migrate 调用；回合推进与 RPC 前再兜底一次——幂等，
 * 已是最新版本时只做一次版本比较）。真实生涯位置（第十三波，roleSync.migrateRealRoles：旧房间的真实选手同步到当届
 * 真实位置、补齐副位置，各人类玩家战队收到一条私有的修正汇总）；名人堂与开局补录（hallOfFame.migrateHallOfFame）。在中性上下文中执行。返回是否执行了迁移。
 */
export function migrateRoomState(state: GameState): boolean {
  if (!state?.multiplayer) return false;
  const roles = !(Number(state.roleDataVersion) >= ROLE_DATA_VERSION);
  // 名人堂（2026-10-14 抽卡回归，hallOfFame.migrateHallOfFame）：旧房间没有名人堂 → 以初始成员 + 开局补录创建并补录当前 SS / SSR；
  // 有名人堂但没有开局补录（2026-10-15「补录」之前的房间）→ 补录开局届之前的真实 SS / SSR 与当前 SS / SSR（按 backfillVersion 一次）
  const hof = hallOfFameNeedsMigration(state);
  if (!roles && !hof) return false;
  ensureNeutral(state);
  if (roles) migrateRealRoles(state);
  if (hof) migrateHallOfFame(state);
  return true;
}

/**
 * 全员准备后推进回合：全局部分执行一次、玩家相关部分对每个座位执行一次（season.ts 已用 forEachSeat 拆分）；
 * 推进后清空 ready；处理出局（荣誉 < 0 的座位 eliminated=true，其余继续）；全部出局或到达终点 → gameOver。
 * opts.force：不要求全员准备（房主强制推进；各座位的阻塞仍须清空）。
 */
export function advanceMultiplayer(state: GameState, opts: { force?: boolean } = {}): OpResult {
  const mp = state.multiplayer;
  if (!mp) return fail('不是多人对局');
  if (state.gameOver) return fail('游戏已结束');
  try {
    ensureNeutral(state);
    migrateRoomState(state);
    if (!opts.force && !allSeatsReady(state)) {
      const waiting = activeHumanIds(state).filter((id) => !mp.seats[id]?.ready).map((id) => seatName(state, id));
      return fail(`还有玩家未准备：${waiting.join('、')}`);
    }
    const blocked: string[] = [];
    for (const id of activeHumanIds(state)) {
      const bl = seatBlockers(state, id);
      if (bl.length) {
        mp.seats[id].ready = false;
        blocked.push(`${seatName(state, id)}：${bl.map((b) => b.message).join('；')}`);
      }
    }
    if (blocked.length) return fail(`无法推进回合：${blocked.join(' | ')}`);

    const r = advanceRound(state);
    pruneH2H(state);
    drainNeutral(state);
    processEliminations(state);
    for (const id of humanTeamIds(state)) {
      mp.seats[id].ready = false;
      delete mp.seats[id].autoReady; // 自动处理的意图只对一个回合有效
    }
    return r;
  } catch (e) {
    console.error('[engine] advanceMultiplayer', e);
    ensureNeutral(state);
    return fail(`推进失败：${errMsg(e)}`);
  }
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EngineFn = (state: GameState, ...args: any[]) => unknown;

/** 白名单 RPC → 引擎函数（satisfies 保证与 protocol.RPC_WHITELIST 一一对应） */
const RPC_IMPL = {
  setTrainingFocus, doTraining, buyExtraTraining, doScrim,
  hireCoach, fireCoach,
  prepareNextMatch, startDraft, playerDraftAction, playGame, commitGame, quickSimSeries, quickSimTournament,
  setLineupSlot, autoLineup, fillLineupWithTempSubs,
  registerForTournament, unregisterFromTournament,
  signFreeAgent, bidForPlayer, respondToOffer, releasePlayer, releasePlayers, renewContract,
  generateTempSubCandidates, hireTempSub,
  listPlayerForTransfer, unlistPlayer,
  tradeForPlayer,
  raiseSalary, talkToPlayer, teamBuilding,
  setPrizeShare,
  releaseDraftedRookie,
  gachaPull, gachaDiscard,
  resolveDecision, dismissPopup, markAllNewsRead, markNewsRead,
  dismissPopups, setPlayerAsStarter, talkWithPlayer, autoDraftAndPlay, autoArrangeLineup,
  listPlayersForTransfer,
} satisfies Record<RpcName, EngineFn>;

/** 参数为选手 id 数组的批量 RPC（参数序号） */
const RPC_ARRAY_ARG: Partial<Record<RpcName, number>> = {
  releasePlayers: 0,
  listPlayersForTransfer: 0,
  tradeForPlayer: 2,
};

/** 游戏结束 / 观战时仍允许的 RPC（只影响本座位的显示状态） */
const PASSIVE_RPC = new Set<string>(['dismissPopup', 'dismissPopups', 'markAllNewsRead', 'markNewsRead']);

/** 只影响调用者自己的 RPC（与服务器 rooms.ts 的 SELF_ONLY_RPCS 一致）：之后不必继续其他座位的自动处理 */
const SELF_ONLY_RPC = new Set<string>([...PASSIVE_RPC, 'setTrainingFocus']);

/** 在座位上下文中执行一个白名单 RPC（服务器调用）：返回引擎函数的返回值；未知函数抛错 */
export function callAsSeat(state: GameState, teamId: string, fn: string, args: unknown[]): unknown {
  if (!(RPC_WHITELIST as readonly string[]).includes(fn)) throw new Error(`未知操作：${fn}`);
  const mp = state.multiplayer;
  if (!mp) throw new Error('不是多人对局');
  const seat = mp.seats[teamId];
  if (!seat) throw new Error(`座位不存在：${teamId}`);
  const name = fn as RpcName;
  const impl = RPC_IMPL[name] as EngineFn;
  const list = Array.isArray(args) ? args.slice() : [];
  const teamArg = RPC_TEAM_ARG[name];
  if (teamArg !== undefined) {
    // 带 teamId 参数的函数：强制为调用者战队
    while (list.length <= teamArg) list.push(undefined);
    list[teamArg] = teamId;
  }
  if (name === 'setLineupSlot' && !(POSITIONS as readonly unknown[]).includes(list[1])) return fail('位置无效');
  // 批量操作的 id 列表：参数来自网络，非数组时引擎会在遍历时抛错 → 先校验，只保留字符串 id
  const arrayArg = RPC_ARRAY_ARG[name];
  if (arrayArg !== undefined) {
    const v = list[arrayArg];
    if (!Array.isArray(v)) return fail('操作参数无效');
    list[arrayArg] = v.filter((x): x is string => typeof x === 'string');
  }
  if (!PASSIVE_RPC.has(fn)) {
    if (state.gameOver) return fail('游戏已结束');
    if (seat.eliminated || ownEntry(state.teams, teamId)?.disbanded) return fail('战队已解散，当前为观战模式');
  }
  migrateRoomState(state); // 旧房间（服务器载入时未迁移）兜底；已迁移时只是一次版本比较
  let result: unknown;
  try {
    result = withSeat(state, teamId, () => impl(state, ...list));
  } catch (e) {
    console.error('[engine] callAsSeat', fn, e);
    result = fail(`操作失败：${errMsg(e)}`);
  }
  try {
    processEliminations(state);
    refreshReadiness(state);
    // 抽卡后超编（2026-10-15「十连后本回合内退回到 12 人」）：撤销本座位「下一回合」自动准备的意图——否则下面的自动处理会立刻
    // 退回刚抽到的新秀。玩家手动退回 / 解约，或再按「下一回合」（自动退回评分最低的新秀）
    if (name === 'gachaPull' && seat.autoReady && rosterOverCap(state, teamId) > 0) delete seat.autoReady;
    // 以自动处理请求准备、仍在等待的座位：本次操作可能让它们可以继续（如对手同意快速模拟、下一场对手已确定）
    if (!SELF_ONLY_RPC.has(fn)) pumpAutoReady(state);
  } catch (e) {
    console.error('[engine] callAsSeat post', e);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 托管（玩家离线时由房主开启，服务器代为操作，避免一名玩家掉线后整个房间无法推进）
// ---------------------------------------------------------------------------

/**
 * 托管一个座位本回合的事务（服务器在该玩家离线、房主开启托管时调用；在中性上下文调用）：
 * 与「下一回合」自动处理相同（autoRound.autoHandleRound；待决事件的默认选项见 events.DEFAULT_DECISION_CHOICE：
 * 配合调查 / 低调处理 / 现有替补顶上 / 尝试挽留 / 拒绝报价 / 续约 1 赛季 / 不聘用，其余取第一项）→
 * 补齐首发后快速模拟本回合可打的比赛（玩家对决：看完对手开打的一局、登记快速模拟、选择自动 BP，手动 BP 改为自动，
 * 对手同意 / 也自动处理时结算）→ 没有阻塞时标记准备。
 * 不推进回合；返回处理摘要（无事可做时 message 为空串，服务器据此不重复推送视图；ok=false 表示座位不存在等错误）。
 */
export function autopilotSeat(state: GameState, teamId: string): OpResult {
  const mp = state.multiplayer;
  if (!mp) return fail('不是多人对局');
  const seat = mp.seats[teamId];
  if (!seat) return fail(`座位不存在：${teamId}`);
  if (state.gameOver || !seatInPlay(state, teamId)) return ok('战队已出局或游戏已结束');
  const notes: string[] = [];
  try {
    ensureNeutral(state);
    migrateRoomState(state); // 旧房间（服务器载入时未迁移）兜底，与 callAsSeat / advanceMultiplayer 一致；已迁移时只是一次版本比较
    const rep = autoHandleSeat(state, teamId, { source: 'autopilot' });
    // 只是在等待（对手 / 其他玩家）时不产生摘要
    if (rep?.progressed) notes.push(...rep.lines);
    // 托管方的进展可能让以自动处理请求准备的在线玩家可以继续
    pumpAutoReady(state);
    if (!seat.ready && seatInPlay(state, teamId) && !state.gameOver && !seatBlockers(state, teamId).length) {
      seat.ready = true;
      notes.push('已准备');
    }
  } catch (e) {
    console.error('[engine] autopilotSeat', e);
    ensureNeutral(state);
    return fail(`托管失败：${errMsg(e)}`);
  }
  return ok(notes.join('；'));
}

/** 玩家对决共享对局（供 UI/服务器查询；无则 null） */
export function h2hMatch(state: GameState, seriesId: string): H2HMatch | null {
  return state.multiplayer?.h2h?.[seriesId] ?? null;
}
