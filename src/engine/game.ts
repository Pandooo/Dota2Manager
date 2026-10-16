// 游戏门面（Store/UI 只调用本文件与 index.ts 导出的函数）【E5 负责实现】
// 约定：面向玩家的操作一律返回 OpResult（中文 message），不因用户操作错误而抛异常。
import type {
  AdvanceBlocker, Coach, DraftState, GameRecord, GameState, H2HMatch, NewGameOptions, OpResult, Position, RosterFile, Series,
  SeriesResult, Team, Tournament, TrainingFocus, TrainingGain,
} from './types';
import { POSITIONS, REGIONS } from './types';
import { CONFIG, MAX_TI, SAVE_VERSION, TOURNAMENT_TIER_LABEL } from './config';
import type { DraftSuggestion } from './draft';
import { aiDraftStep, applyDraftAction, createDraft, currentStep, draftSuggestions, runDraftUntil } from './draft';
import { computeWinProb, forfeitResult, seriesOutcome, simulateGame } from './match';
import { advanceTournamentUntilPlayer, isTeamEliminated, playerNextSeries, recordSeriesResult } from './tournament';
import { getPlayerIndex, loadRoster } from '../data/index';
import { aiEnsureRosters } from './ai';
import { coachFromSeed, generatePlayer, playerFromSeed, teamFromSeed } from './generation';
import { addPlayerToTeam, autoLineup, clearFoundingJoinMarks, lineupPlayers, rosterOverCapNotice, validateLineup } from './team';
import {
  addFinance, extraTrainingCost, newClubStartingFunds, scrimCost, seedTeamStartingFunds,
} from './economy';
import { scrimInsightMult, scrimMultiplier, scrimTrainOptions, sessionTrainOptions, trainTeam } from './growth';
import { generateTempSubCandidates, hireTempSub, isTransferWindowOpen, tempSubCost } from './market';
import { isAvailable, overallRating, tierIndex } from './player';
import { ROLE_DATA_VERSION } from './roles';
import { REAL_CAREER_VERSION, comebackAfterCoachRelease, comebackReleaseNote } from './realCareer';
import { heroName } from './heroes';
import { hashSeed, rngOf } from './rng';
import {
  ROUND_KIND_LABEL, playerTournamentForRound, roundKindForPlayer, seasonStartDate, tiDates, tiYear,
} from './calendar';
import {
  TRAINING_FOCUS_LABEL, careerSummary, compactTournament, endRound, ensurePlayableLineup, enterRound,
  finalizePlayerTournamentIfDone, initPatchBaseline, multiplayerCareerSummary, settleSeason, startSeason,
} from './season';
import { addNews } from './news';
import { formatGold, formatRank, ownEntry } from './util';
import type { TrainingRecord } from './types';
import {
  bookScrim, clearScrimBookings, isScrimBooked, nextTrainingSession, pendingExtraSessionCost, recordTraining,
} from './trainingLog';
import { inSeatOf, isMultiplayer, seatInPlay, seatOf } from './seat';
import { alignInitialSalaries } from './salary';
import { autoHandleRound } from './autoRound';

export { TRAINING_FOCUS_LABEL } from './season';
export { ROUND_KIND_LABEL } from './calendar';

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const ok = (message: string): OpResult => ({ ok: true, message });
const fail = (message: string): OpResult => ({ ok: false, message });

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 包装面向 UI 的操作：内部异常转为失败结果（并打印堆栈便于排查），避免 UI 崩溃 */
function guard<T extends OpResult>(fn: () => T): T | OpResult {
  try {
    return fn();
  } catch (e) {
    console.error('[engine]', e);
    return fail(`操作失败：${errMsg(e)}`);
  }
}

function myTeamId(state: GameState): string {
  return state.settings.playerTeamId;
}

function myTeam(state: GameState): Team | null {
  return state.teams[myTeamId(state)] ?? null;
}

function teamTag(state: GameState, id: string | null | undefined): string {
  if (!id) return '待定';
  const t = state.teams[id];
  return t ? t.tag || t.name : id;
}

function teamName(state: GameState, id: string | null | undefined): string {
  if (!id) return '待定';
  return state.teams[id]?.name ?? id;
}

/** 读取 gameOver（引擎调用会原地修改 state，避免 TS 的控制流收窄误判） */
function gameOverOf(state: GameState): GameState['gameOver'] {
  return state.gameOver;
}

function hasBlockingDecisions(state: GameState): boolean {
  return state.pendingDecisions.some((d) => d.blocking);
}

// ---------------------------------------------------------------------------
// 新游戏
// ---------------------------------------------------------------------------

/** 俱乐部 id 用的 slug（多人模式创建新俱乐部时复用） */
export function clubSlug(s: string): string {
  return slugify(s);
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function emptyLineup() {
  return { C: null, M: null, O: null, SS: null, HS: null };
}

/** 空白存档（多人模式 multi.createMultiplayerGame 复用） */
export function createBlankState(opts: Parameters<typeof blankState>[0]): GameState {
  return blankState(opts);
}

function blankState(opts: {
  seed: number; createdAt: string; startTi: number; endTi: number; difficulty: GameState['settings']['difficulty'];
  managerName: string; playerTeamId: string;
}): GameState {
  const startDate = seasonStartDate(opts.startTi);
  return {
    version: SAVE_VERSION,
    id: `g-${(opts.seed >>> 0).toString(36)}`,
    createdAt: opts.createdAt,
    settings: {
      startTi: opts.startTi,
      seasons: opts.endTi - opts.startTi + 1,
      endTi: opts.endTi,
      difficulty: opts.difficulty,
      playerTeamId: opts.playerTeamId,
      managerName: opts.managerName,
    },
    rngState: opts.seed,
    idCounter: 0,
    // 占位赛季（startSeason 会重建）：保证建队/新闻阶段 season.ti/year 可用
    season: {
      ti: opts.startTi,
      year: tiYear(opts.startTi),
      startDate,
      tiStartDate: tiDates(opts.startTi).startDate,
      rounds: [],
      registeredTournamentIds: [],
      extraTrainingsBought: 0,
    },
    roundIndex: 0,
    phase: 'preseason',
    currentDate: startDate,
    currentPatch: '',
    appliedPatches: [],
    heroMeta: {},
    teams: {},
    players: {},
    coaches: {},
    tournaments: {},
    seasonTournamentIds: [],
    futureRookies: {},
    gachaPool: [],
    gachaPity: 0,
    transferOffers: [],
    tempSubCandidates: [],
    activeMatch: null,
    freeTrainingUsed: false,
    extraTrainingAvailable: 0,
    extraTrainingBoughtThisRound: 0,
    trainingFocus: 'balanced',
    beefs: [],
    pendingDecisions: [],
    delayedEvents: [],
    news: [],
    finance: [],
    history: { tournaments: [], seasons: [], honor: [], gold: [], playerSettlements: [] },
    popups: [],
    gameOver: null,
    // 真实生涯位置（第十三波）：新游戏的真实选手在创建时即按当届真实位置 / 副位置生成，无需迁移
    roleDataVersion: ROLE_DATA_VERSION,
    // 真实生涯保护（v0.4.2）：新游戏从开局就受保护，无需复出迁移
    realCareerVersion: REAL_CAREER_VERSION,
  };
}

/** 新建俱乐部（与单机新游戏同规则；多人模式 multi.createMultiplayerGame 复用） */
export function createNewClubTeam(
  state: GameState,
  id: string,
  club: NonNullable<NewGameOptions['newClub']>,
  difficulty: string,
): Team {
  return createNewClub(state, id, club, difficulty);
}

function createNewClub(
  state: GameState,
  id: string,
  club: NonNullable<NewGameOptions['newClub']>,
  difficulty: string,
): Team {
  const region = REGIONS.includes(club.region) ? club.region : 'CN';
  const name = (club.name ?? '').trim() || '新俱乐部';
  const team: Team = {
    id,
    name,
    tag: ((club.tag ?? '').trim() || name.slice(0, 4) || 'NEW').slice(0, 6),
    region,
    color: (club.color ?? '').trim() || '#c23c2a',
    honor: CONFIG.team.newClubHonor,
    // 起始资金 = 【用户指定】锚定额（TI1 普通难度 20 万）× 年代系数 × 难度倍数（economy.newClubStartingFunds，与新游戏向导 / 多人房间预览同一函数）。
    // 第八波取消玩家抽卡：不再发放抽卡礼包，新俱乐部在赛季初的新秀选秀中获得新秀（rookieDraft.ts）
    gold: newClubStartingFunds(state.season?.ti ?? state.settings.startTi, difficulty),
    isPlayer: true,
    playerIds: [],
    lineup: emptyLineup(),
    coachId: null,
    points: 0,
  };
  state.teams[id] = team;

  // 5 名程序化选手：每个位置一人，S/A/B 级混合（S、A 级人数随难度，其余 B 级）
  const rng = rngOf(state);
  const order = rng.shuffle(POSITIONS.slice());
  const sCount = CONFIG.season.newClubSTierCount[difficulty] ?? CONFIG.season.newClubSTierCount.normal;
  const aCount = CONFIG.season.newClubATierCount[difficulty] ?? CONFIG.season.newClubATierCount.normal;
  order.forEach((pos, i) => {
    const tier = i < sCount ? 'S' : i < sCount + aCount ? 'A' : 'B';
    const p = generatePlayer(state, { tier, position: pos, region });
    addPlayerToTeam(state, p.id, id, { contractSeasons: CONFIG.season.newClubContractSeasons });
  });
  autoLineup(state, id);
  return team;
}

function validateNewGameOptions(opts: NewGameOptions): string | null {
  if (!opts || typeof opts !== 'object') return '新游戏参数缺失';
  if (!Number.isInteger(opts.startTi) || opts.startTi < 1 || opts.startTi > MAX_TI) {
    return `起始赛季需为 TI1–TI${MAX_TI}`;
  }
  if (!Number.isFinite(opts.seasons) || opts.seasons < 1) return '赛季数至少为 1';
  if (!['easy', 'normal', 'hard'].includes(opts.difficulty)) return '难度设置无效';
  if (!opts.newClub && !opts.teamId) return '请选择要接管的战队，或新建俱乐部';
  if (opts.newClub) {
    if (!(opts.newClub.name ?? '').trim()) return '请填写俱乐部名称';
    if (!REGIONS.includes(opts.newClub.region)) return '俱乐部赛区无效';
  }
  return null;
}

/**
 * 新游戏：loadRoster(startTi) → 战队/选手/教练/自由选手；接管真实战队（资金 = economy.seedTeamStartingFunds：数据资金 × 0.2 封顶于强队锚定额
 * TI1 10 万 × 年代系数、不低于数据阵容 N 回合工资，再 × 难度倍数；AI 战队同一公式、不乘难度倍数）或新建俱乐部（荣誉 100，
 * 资金 = economy.newClubStartingFunds：TI1 普通难度 20 万 × 年代系数 × 难度倍数，
 * 初始阵容 = 5 名 S/A/B 级程序化选手（各等级人数随难度）；第一个赛季同样开放新秀卡池（CONFIG.draft.enabled 时为新秀选秀），新俱乐部借此补充新秀）；
 * futureRookies：playerIndex 中 firstTi > startTi 且未在本 roster 出现的选手 → 登场 TI = firstTi；
 * 战队不足 CONFIG.team.minTeams 时生成 AI 战队；rngState = seed ?? 基于时间；
 * startSeason(startTi)；lastSeasonRank 按初始荣誉排名；欢迎新闻。
 */
export async function createNewGame(opts: NewGameOptions): Promise<GameState> {
  const invalid = validateNewGameOptions(opts);
  if (invalid) throw new Error(invalid);
  const startTi = opts.startTi;
  // 赛季数超出 TI16 时夹紧
  const endTi = Math.min(MAX_TI, startTi + Math.floor(opts.seasons) - 1);

  let roster: RosterFile;
  let rosterMissing = false;
  try {
    roster = await loadRoster(startTi);
  } catch (e) {
    if (!opts.newClub) throw new Error(`无法加载 TI${startTi} 阵容数据：${errMsg(e)}`);
    // 新建俱乐部时允许在无阵容数据的情况下以程序化联赛开局
    roster = { ti: startTi, year: tiYear(startTi), teams: [], freeAgents: [], freeCoaches: [] };
    rosterMissing = true;
  }
  const seedTeams = Array.isArray(roster?.teams) ? roster.teams : [];
  if (!opts.newClub && !seedTeams.some((t) => t?.id === opts.teamId)) {
    throw new Error(`TI${startTi} 阵容中找不到战队「${opts.teamId}」`);
  }

  // 玩家战队 id：真实战队沿用；新俱乐部按名称生成且不与真实战队冲突
  let playerTeamId = opts.teamId ?? '';
  if (opts.newClub) {
    const taken = new Set(seedTeams.map((t) => t?.id));
    const base = `club-${slugify(opts.newClub.name) || 'player'}`;
    playerTeamId = base;
    for (let i = 2; taken.has(playerTeamId); i++) playerTeamId = `${base}-${i}`;
  }

  const createdAt = new Date().toISOString(); // 仅此处使用真实时间（存档时间戳/默认种子）
  const seed = (opts.seed ?? hashSeed(createdAt)) | 0;
  const managerName = (opts.managerName ?? '').trim() || '经理';
  const state = blankState({
    seed, createdAt, startTi, endTi, difficulty: opts.difficulty, managerName, playerTeamId,
  });

  // 版本基线（不对初始阵容施加倍数）
  initPatchBaseline(state, state.season.startDate);

  // 真实战队
  for (const st of seedTeams) {
    if (!st?.id || state.teams[st.id]) continue;
    const isPlayer = !opts.newClub && st.id === opts.teamId;
    const team = teamFromSeed(state, st, isPlayer);
    team.isPlayer = isPlayer;
    // 起始资金 = min(锚定额 × 年代系数, 数据资金 × 0.2)，不低于数据阵容工资 × N 回合（economy.seedTeamStartingFunds；玩家接管再 × 难度倍数）：
    // 最强真实俱乐部 TI1 普通难度 10 万（【用户指定】），与新游戏向导的战队卡片同一函数
    team.gold = seedTeamStartingFunds(st, startTi, isPlayer ? opts.difficulty : null);
  }
  // 自由选手 / 自由教练
  for (const fa of roster.freeAgents ?? []) if (fa?.id && !state.players[fa.id]) playerFromSeed(state, fa, null);
  for (const c of roster.freeCoaches ?? []) if (c?.id && !state.coaches[c.id]) coachFromSeed(state, c, null);

  if (opts.newClub) createNewClub(state, playerTeamId, opts.newClub, opts.difficulty);

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

  // 开局补足的程序化 AI 战队：资金在 generation.generateAiTeam 中按真实俱乐部同一公式折算（下限按实际阵容工资）
  aiEnsureRosters(state);
  // 初始「上赛季排名」：按荣誉
  Object.values(state.teams)
    .filter((t) => !t.disbanded)
    .sort((a, b) => b.honor - a.honor || a.id.localeCompare(b.id))
    .forEach((t, i) => {
      t.lastSeasonRank = i + 1;
    });
  autoLineup(state, playerTeamId);
  // 接管真实俱乐部：工资对齐到隐藏的预期薪资附近（数据工资不含荣誉 / 明星系数，第八波平衡）
  if (!opts.newClub) alignInitialSalaries(state, playerTeamId);
  // 开局阵容不受挂牌的加盟门槛限制（随队场数与入队转会回合的起点都清除；之后任何途径加盟的选手从 0 开始计）
  clearFoundingJoinMarks(state);

  startSeason(state, startTi);

  const team = state.teams[playerTeamId];
  if (rosterMissing) {
    addNews(state, 'system', '阵容数据缺失', `未找到 TI${startTi} 的真实阵容数据，本局联赛由程序化战队组成。`, true);
  }
  addNews(
    state,
    'system',
    `欢迎上任，${managerName}！`,
    `你已成为 ${team.name} 的经理。目标：在 TI${endTi} 之前捧起不朽盾。`
      + `当前荣誉 ${Math.round(team.honor)}，资金 ${formatGold(team.gold)}。`,
    true,
  );
  // 欢迎弹窗排在最前（选秀开启时，赛季初选秀的结果弹窗随后）
  state.popups.unshift({
    kind: 'message',
    title: '欢迎来到刀塔经理',
    body: `${team.name}（${team.tag}）的征程从 TI${startTi} 赛季开始，共 ${endTi - startTi + 1} 个赛季。\n`
      + '赛季初：在「赛事 › 赛程报名」报名赛事、在「转会 › 转会市场」补强阵容；'
      + (CONFIG.draft.enabled
        ? '每个赛季初都会举行新秀选秀，所有战队按顺位自动挑选新秀，选中的新秀可在「转会 › 新秀选秀」中保留或免费放弃。'
        : '每个赛季「转会 › 新秀抽卡」都会开放新秀卡池（真实新秀、请神新秀与虚构新秀），可以单抽或十连，'
          + '抽到的新秀立即入队，不想要的可在同一回合内退回。')
      + '准备就绪后点击底部的「开始赛季」进入第 1 回合。'
      + '\n资金有限：工资每回合支付，收入来自赞助、直播与内容、周边、赛事奖金与出场费，详见「俱乐部 › 财务」。',
  });
  return state;
}

// ---------------------------------------------------------------------------
// 回合推进
// ---------------------------------------------------------------------------

/**
 * 推进前的阻塞原因：未处理的 blocking 决策、玩家赛事未结束/比赛进行中、首发不足（有赛事时）、游戏结束、
 * 正式阵容超出绝对上限（抽卡超编，转会窗口开放时；超出常规上限不阻塞）
 */
export function getAdvanceBlockers(state: GameState): AdvanceBlocker[] {
  if (state.gameOver) {
    return [{
      code: 'game_over',
      message: state.gameOver.reason === 'disbanded' ? '俱乐部已解散，游戏结束'
        : state.gameOver.reason === 'banned' ? '俱乐部因全员假赛被永久除名，游戏结束'
          : state.gameOver.reason === 'bankrupt' ? '俱乐部已破产，游戏结束' : '执教生涯已结束',
    }];
  }
  if (isMultiplayer(state)) {
    const me0 = myTeamId(state);
    const seat = seatOf(state, me0);
    if (seat?.eliminated || state.teams[me0]?.disbanded) {
      return [{
        code: 'game_over',
        message: state.teams[me0]?.banned ? '俱乐部因全员假赛被永久除名，当前为观战模式'
          : state.teams[me0]?.bankrupt ? '俱乐部已破产，当前为观战模式' : '战队已解散，当前为观战模式',
      }];
    }
  }
  const out: AdvanceBlocker[] = [];
  const pending = state.pendingDecisions.filter((d) => d.blocking).length;
  if (pending > 0) {
    out.push({ code: 'pending_decision', message: `还有 ${pending} 项待处理事务，请先在消息中心做出决定` });
  }
  // 失效的比赛状态（如读档后系列赛已有结果）不算进行中，advance 时会被清理
  if (state.activeMatch && typeof matchCtx(state) !== 'string') {
    out.push({ code: 'match_in_progress', message: '比赛进行中，请先打完当前对局' });
  }
  const me = myTeamId(state);
  if (state.phase !== 'preseason' && state.phase !== 'season_end') {
    const t = playerTournamentForRound(state, state.roundIndex);
    if (t && t.status === 'running' && playerNextSeries(state, t.id)) {
      out.push({ code: 'tournament_running', message: `「${t.name}」尚未结束，请完成比赛（可快速模拟）` });
      const errs = validateLineup(state, me, t.id);
      if (errs.length) {
        out.push({
          code: 'lineup_invalid',
          message: `首发不足 5 人：${errs.join('；')}。请调整阵容或临时招募替补，否则本场将弃权判负`,
        });
      }
    } else if (isMultiplayer(state) && t && t.status === 'running' && !isTeamEliminated(state, t.id, me)) {
      // 多人模式：下一场对手要等其他玩家的系列赛结果
      out.push({ code: 'tournament_running', message: `「${t.name}」中你的下一场比赛尚未确定，请等待其他玩家完成比赛` });
    }
  }
  // 超出常规上限（team.maxRoster）只是提示（工资照付、替补归属感下降更快，见 team.rosterOverflowNotice）；
  // 超出绝对上限（team.hardMaxRoster，只会因新秀抽卡出现：十连 / 单抽总是抽满）须在本回合内退回（2026-10-15 用户决策「十连后本回合内退回到 12 人」）。
  // 只在转会窗口开放时阻塞（抽卡只在窗口开放时可用、本回合内必须处理完，不会带进锁定期；放弃新秀 / 解约也只在窗口开放时可用）
  const overCap = isTransferWindowOpen(state) ? rosterOverCapNotice(state, me) : null;
  if (overCap) out.push({ code: 'roster_over_cap', message: overCap });
  return out;
}

/** 多人模式（中性上下文）的回合提示：没有「本队」视角，按赛季阶段描述 */
const MP_PHASE_LABEL: Record<string, string> = {
  preseason: '赛季初', regular: '常规赛季', ti_qualifier: 'TI 预选赛', ti: 'TI 正赛', season_end: '赛季结算',
};

function roundMessage(state: GameState): string {
  if (isMultiplayer(state) && !state.teams[myTeamId(state)]) {
    const total = state.season.rounds.length - 1;
    return `TI${state.season.ti} 第 ${state.roundIndex}/${total} 回合 · ${MP_PHASE_LABEL[state.phase] ?? ''}`;
  }
  const kind = roundKindForPlayer(state, state.roundIndex);
  const t = playerTournamentForRound(state, state.roundIndex);
  const label = ROUND_KIND_LABEL[kind] ?? '';
  const total = state.season.rounds.length - 1;
  return `第 ${state.roundIndex}/${total} 回合 · ${label}${t && kind !== 'rest' && kind !== 'ti_watch' ? `：${t.name}` : ''}`;
}

/**
 * 底部「下一步」按钮（开始赛季 / 下一回合 / TI 结算）：
 * preseason → enterRound(1)；常规/TI 回合 → endRound + (最后一回合 ? settleSeason : enterRound(next))。
 * 有阻塞时不做任何事并返回 ok=false；失效的 activeMatch（赛事/系列赛已不存在或已出结果）先被清理。
 * opts.auto（懒人玩法，autoRound.ts）：先自动处理本回合挡住推进的事务（默认处理待决事件、补齐首发、快速模拟本方剩余比赛），
 * 再照常推进；能自动处理的阻塞不再挡住推进。返回值的 autoActions 为自动处理摘要（无则缺省）。
 * 不带 opts 时行为与以前完全相同。
 */
export function advance(state: GameState, opts?: { auto?: boolean }): OpResult & { autoActions?: string[] } {
  return guard(() => {
    if (isMultiplayer(state)) return fail('多人模式下需全员准备后由服务器推进回合');
    if (state.activeMatch && typeof matchCtx(state) === 'string') state.activeMatch = null;
    let autoActions: string[] | undefined;
    if (opts?.auto) {
      const rep = autoHandleRound(state);
      if (rep.lines.length) autoActions = rep.lines;
    }
    const blockers = getAdvanceBlockers(state);
    if (blockers.length) {
      const r = fail(blockers.map((b) => b.message).join('；'));
      return autoActions ? { ...r, autoActions } : r;
    }
    const r = advanceRound(state);
    return autoActions ? { ...r, autoActions } : r;
  });
}

// 「下一回合」自动处理（懒人玩法）：按钮预览 + 自动处理（多人见 multi.setSeatReady 的 auto 选项）
export { autoHandleRound, previewAutoActions, AUTO_ROUND_NEWS_TAG } from './autoRound';
export type { AutoRoundPreview, AutoRoundReport, OverCapTrim } from './autoRound';

/** 清理失效的比赛状态（赛事/系列赛已不存在或已出结果；玩家对决的回放视图除外） */
export function dropStaleMatch(state: GameState): void {
  const am = state.activeMatch;
  if (!am || typeof matchCtx(state) !== 'string') return;
  const h = h2hOf(state, am.seriesId);
  if (h?.done && am.pendingGame) return;
  state.activeMatch = null;
}

/**
 * 推进一步（不检查阻塞）：preseason → enterRound(1)；常规/TI 回合 → endRound + (最后一回合 ? settleSeason : enterRound(next))。
 * 单机由 advance 调用；多人模式由 multi.advanceMultiplayer 在中性上下文中调用（玩家相关部分在 season.ts 中按座位执行）。
 */
export function advanceRound(state: GameState): OpResult {
  {
    if (!state.season?.rounds?.length) {
      startSeason(state, state.season?.ti ?? state.settings.startTi);
      return ok(`TI${state.season.ti} 赛季已就绪`);
    }
    if (state.phase === 'season_end') {
      // 正常流程中 settleSeason 会直接进入下赛季；此处兜底异常中断后的状态
      const next = state.season.ti + 1;
      if (next > state.settings.endTi) {
        state.gameOver ??= {
          reason: 'completed',
          summary: isMultiplayer(state) ? multiplayerCareerSummary(state) : careerSummary(state),
        };
        return ok('执教生涯已结束');
      }
      startSeason(state, next);
      const ended = gameOverOf(state);
      if (ended) return ok(ended.summary);
      return ok(`TI${next} 赛季开始！`);
    }
    if (state.phase === 'preseason') {
      enterRound(state, 1);
      const ended = gameOverOf(state);
      if (ended) return ok(ended.summary);
      return ok(`赛季开战！${roundMessage(state)}`);
    }

    const last = state.season.rounds.length - 1;
    const ti = state.season.ti;
    endRound(state);
    clearScrimBookings(state); // 训练赛预约只对本回合有效（每支对手每回合限约次数）
    let over = gameOverOf(state);
    if (over) return ok(over.summary);
    if (state.roundIndex >= last) {
      settleSeason(state);
      over = gameOverOf(state);
      if (over) return ok(over.reason === 'completed' ? `TI${ti} 赛季结算完成，执教生涯落幕` : over.summary);
      return ok(`TI${ti} 赛季结算完成，TI${state.season.ti} 赛季开始！`);
    }
    enterRound(state, state.roundIndex + 1);
    over = gameOverOf(state);
    if (over) return ok(over.summary);
    return ok(roundMessage(state));
  }
}

/** 玩家当前回合参加的赛事（进行中或本回合待赛） */
export function currentPlayerTournament(state: GameState): Tournament | null {
  if (state.phase === 'preseason' || state.phase === 'season_end') return null;
  const t = playerTournamentForRound(state, state.roundIndex);
  return t && t.status !== 'finished' ? t : null;
}

// ---------------- 训练 ----------------

/** 当前不能训练的原因（null = 可以训练） */
export function trainingBlockReason(state: GameState): string | null {
  if (state.gameOver) return '游戏已结束';
  if (!myTeam(state)) return '战队不存在';
  if (state.phase === 'preseason') return '赛季初无法训练，开始赛季后可在休赛回合训练';
  if (state.phase === 'season_end') return '赛季已结束';
  if (state.activeMatch) return '比赛进行中，无法训练';
  const kind = roundKindForPlayer(state, state.roundIndex);
  if (kind === 'tournament' || kind === 'ti_qualifier' || kind === 'ti') return '赛事回合无法训练，专心打比赛吧';
  return null;
}

export function setTrainingFocus(state: GameState, focus: TrainingFocus): void {
  // 只接受自有键（多人 RPC 参数来自网络：'toString' / ['power'] 等不能通过 in 检查混入）
  if (typeof focus === 'string' && Object.prototype.hasOwnProperty.call(TRAINING_FOCUS_LABEL, focus)) state.trainingFocus = focus;
}

/** 消耗一次训练次数（免费优先） */
function consumeSession(state: GameState): boolean {
  if (!state.freeTrainingUsed && CONFIG.training.freePerRestRound > 0) {
    state.freeTrainingUsed = true;
    return true;
  }
  if (state.extraTrainingAvailable > 0) {
    state.extraTrainingAvailable -= 1;
    return true;
  }
  return false;
}

function gainSummary(gains: TrainingGain[]): string {
  let power = 0;
  let mmr = 0;
  let insight = 0;
  for (const g of gains) {
    power += g.power;
    mmr += g.mmr;
    insight += g.insight;
  }
  return `全队战力 +${power.toFixed(1)}，天梯 +${Math.round(mmr)}，灵性 +${insight.toFixed(1)}`;
}

/** 执行一次训练：优先消耗免费次数，其次已购额外次数；赛事回合/preseason 不可训练 */
export function doTraining(state: GameState): OpResult & { gains?: TrainingGain[]; record?: TrainingRecord } {
  return guard(() => {
    const why = trainingBlockReason(state);
    if (why) return fail(why);
    const session = nextTrainingSession(state);
    const sessionCost = session === 'extra' ? pendingExtraSessionCost(state) : 0;
    if (!consumeSession(state)) return fail('本回合训练次数已用完，可购买额外训练');
    const gains = trainTeam(state, myTeamId(state), state.trainingFocus, undefined, sessionTrainOptions(session));
    const record = recordTraining(state, {
      kind: session === 'extra' ? 'extra' : 'free',
      focus: state.trainingFocus,
      mult: 1,
      cost: sessionCost,
      session: session ?? 'free',
      sessionCost,
      gains,
    });
    const label = TRAINING_FOCUS_LABEL[state.trainingFocus] ?? '均衡';
    return { ok: true, message: `完成一次「${label}」训练：${gainSummary(gains)}`, gains, record };
  });
}

/** 购买 1 次额外训练（价格递增，每回合上限） */
export function buyExtraTraining(state: GameState): OpResult {
  return guard(() => {
    const why = trainingBlockReason(state);
    if (why) return fail(why);
    const max = CONFIG.training.maxExtraPerRound;
    if (state.extraTrainingBoughtThisRound >= max) return fail(`每回合最多购买 ${max} 次额外训练`);
    const team = myTeam(state)!;
    const cost = extraTrainingCost(state);
    if (team.gold < cost) return fail(`资金不足：额外训练需要 ${formatGold(cost)}`);
    addFinance(state, team.id, -cost, 'training', `购买额外训练（本赛季第 ${state.season.extraTrainingsBought + 1} 次）`);
    state.season.extraTrainingsBought += 1;
    state.extraTrainingBoughtThisRound += 1;
    state.extraTrainingAvailable += 1;
    return ok(`已购买 1 次额外训练，花费 ${formatGold(cost)}（下次 ${formatGold(extraTrainingCost(state))}）`);
  });
}

// 训练赛战报（平实陈述，不含玩笑/梗；梗类内容只来自用户维护的 funEvents.ts）
const SCRIM_WIN_LINES = [
  '中路取得对线优势，约三十分钟推上高地',
  '肉山团战以少换多，随后推平对方基地',
  '前期处于劣势，后期团战逆转取胜',
  '运营节奏稳定，全程保持经济领先',
  '辅助视野布置到位，多次成功抓人',
];
const SCRIM_LOSE_LINES = [
  '对手四保一阵容拖入后期，后期团战不敌',
  '对线期劣势明显，约二十五分钟被推上高地',
  '关键团战先手技能被躲开，随后团灭',
  '高地团战缺少买活，被对手推平基地',
  '对手针对性禁用，我方常用英雄被禁',
];

/**
 * 训练赛：付费 + 消耗 1 次训练次数，训练收益 × scrimMultiplier（下限 > 1，对手越强越高），灵性另 × scrimInsightMult（交流 BP），
 * 生成一条训练赛战报（胜负按胜率随机）。每支对手每回合最多约 CONFIG.training.scrimPerOpponentPerRound 次（Team.scrimBookings）。
 */
export function doScrim(
  state: GameState,
  targetTeamId: string,
): OpResult & { gains?: TrainingGain[]; won?: boolean; mult?: number; insightMult?: number; record?: TrainingRecord } {
  return guard(() => {
    const why = trainingBlockReason(state);
    if (why) return fail(why);
    const me = myTeamId(state);
    const target = typeof targetTeamId === 'string' && Object.prototype.hasOwnProperty.call(state.teams, targetTeamId)
      ? state.teams[targetTeamId]
      : undefined;
    if (!target || target.disbanded) return fail('约练对象不存在');
    if (targetTeamId === me) return fail('不能和自己打训练赛');
    // 与界面（TrainingShared.scrimOptions / scrimReason）一致：双方都要有首发。训练赛倍数下限 > 1 后，
    // 约练没有首发的空壳战队也能拿到 ×scrimMultMin，本队没有首发时倍数按上限（全员按替补训练）——都不应允许
    if (!lineupPlayers(state, me).some((x) => x.player)) return fail('首发阵容为空，无法约练');
    if (!lineupPlayers(state, targetTeamId).some((x) => x.player)) return fail(`${target.name} 当前没有首发阵容，无法约练`);
    if (isScrimBooked(state, targetTeamId)) {
      const limit = Math.max(1, Math.floor(CONFIG.training.scrimPerOpponentPerRound) || 1);
      return fail(`本回合已与 ${target.name} 约过训练赛：每支战队每回合只能约练 ${limit} 次，换个对手或下回合再约吧`);
    }
    if (trainingSessionsLeft(state) <= 0) return fail('训练次数不足：训练赛需要消耗 1 次训练次数');
    const team = myTeam(state)!;
    const cost = scrimCost(state, targetTeamId);
    if (team.gold < cost) return fail(`资金不足：与 ${target.name} 约练需要 ${formatGold(cost)}`);

    addFinance(state, me, -cost, 'scrim', `与 ${target.name} 的训练赛`);
    const session = nextTrainingSession(state);
    const sessionCost = session === 'extra' ? pendingExtraSessionCost(state) : 0;
    consumeSession(state);
    bookScrim(state, targetTeamId);
    const mult = scrimMultiplier(state, me, targetTeamId);
    const insightMult = scrimInsightMult();
    const gains = trainTeam(state, me, state.trainingFocus, mult, scrimTrainOptions(session));
    const { pWin } = computeWinProb(state, me, targetTeamId, 0.5, []);
    const rng = rngOf(state);
    const won = rng.chance(pWin);
    const line = rng.pick(won ? SCRIM_WIN_LINES : SCRIM_LOSE_LINES);
    const record = recordTraining(state, {
      kind: 'scrim',
      focus: state.trainingFocus,
      mult,
      scrimTargetId: targetTeamId,
      scrimWon: won,
      insightMult,
      cost: cost + sessionCost,
      session: session ?? 'free',
      sessionCost,
      gains,
    });
    const insightText = insightMult !== 1 ? `，灵性另 ×${insightMult.toFixed(1)}（交流 BP）` : '';
    addNews(
      state,
      'match',
      `训练赛：${team.tag} vs ${target.tag}（${won ? '胜' : '负'}）`,
      `${line}。赛前胜率约 ${Math.round(pWin * 100)}%，训练收益倍数 ×${mult.toFixed(2)}${insightText}，费用 ${formatGold(cost)}。`,
    );
    return {
      ok: true,
      message: `训练赛${won ? '获胜' : '告负'}（${line}），收益 ×${mult.toFixed(2)}${insightText}：${gainSummary(gains)}`,
      gains,
      won,
      mult,
      insightMult,
      record,
    };
  });
}

/** 剩余可用训练次数（免费 + 已购未用） */
export function trainingSessionsLeft(state: GameState): number {
  if (trainingBlockReason(state)) return 0;
  const free = !state.freeTrainingUsed && CONFIG.training.freePerRestRound > 0 ? 1 : 0;
  return free + Math.max(0, state.extraTrainingAvailable);
}

// ---------------- 教练 ----------------
/** 教练市场（teamId=null 的教练） */
export function coachMarket(state: GameState): Coach[] {
  return Object.values(state.coaches)
    .filter((c) => c.teamId === null)
    .sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier) || b.insight - a.insight || a.id.localeCompare(b.id));
}

/** 签约教练的签字费 */
export function coachSigningFee(coach: Coach): number {
  return Math.round(Math.max(0, coach.salary) * CONFIG.season.coachSigningFeeSalaryMult);
}

/** 签约教练（签字费 = 工资 × 4；替换现任时现任离队） */
export function hireCoach(state: GameState, coachId: string): OpResult {
  return guard(() => {
    if (state.gameOver) return fail('游戏已结束');
    if (!isTransferWindowOpen(state)) return fail('转会窗口已关闭（TI 阶段锁定），无法签约教练');
    const team = myTeam(state);
    if (!team) return fail('战队不存在');
    const coach = ownEntry(state.coaches, coachId);
    if (!coach) return fail('教练不存在');
    if (coach.teamId !== null) return fail(coach.teamId === team.id ? '他已经是你的教练了' : `${coach.name} 已有东家`);
    const fee = coachSigningFee(coach);
    if (team.gold < fee) return fail(`资金不足：签字费 ${formatGold(fee)}`);

    if (fee > 0) addFinance(state, team.id, -fee, 'signing', `签约教练 ${coach.name}`);
    const old = team.coachId ? state.coaches[team.coachId] : null;
    if (old) old.teamId = null;
    coach.teamId = team.id;
    team.coachId = coach.id;
    addNews(
      state,
      'transfer',
      `${team.name} 签约主教练 ${coach.name}`,
      `${coach.tier} 级教练，灵性 ${Math.round(coach.insight)}，工资 ${formatGold(coach.salary)}/回合。`
        + (old ? `前任主教练 ${old.name} 离队。` : ''),
    );
    // 前任是读档时因在本队执教而暂不复出的退役真实选手（真实生涯仍在继续）：离任后以自由身复出（realCareer.ts）
    const back = comebackAfterCoachRelease(state, old);
    return ok(`签约 ${coach.name} 成功，签字费 ${formatGold(fee)}${comebackReleaseNote(back)}`);
  });
}

export function fireCoach(state: GameState): OpResult {
  return guard(() => {
    if (state.gameOver) return fail('游戏已结束');
    if (!isTransferWindowOpen(state)) return fail('转会窗口已关闭（TI 阶段锁定），无法更换教练');
    const team = myTeam(state);
    if (!team || !team.coachId) return fail('当前没有主教练');
    const coach = state.coaches[team.coachId];
    team.coachId = null;
    if (coach) coach.teamId = null;
    // 读档时因在本队执教而暂不复出的退役真实选手（真实生涯仍在继续）：解雇后以自由身复出（realCareer.ts）
    const back = comebackAfterCoachRelease(state, coach);
    addNews(
      state,
      'transfer',
      `${team.name} 与主教练分道扬镳`,
      back ? `${coach?.name ?? back} 离开球队，以选手身份复出。` : `${coach?.name ?? '主教练'} 离开球队，进入教练市场。`,
    );
    return ok(`已解雇 ${coach?.name ?? '主教练'}${comebackReleaseNote(back)}`);
  });
}

// ---------------- 比赛流程（小回合） ----------------

interface MatchCtx {
  t: Tournament;
  series: Series;
  teamA: string;
  teamB: string;
  mySide: 'A' | 'B';
  games: GameRecord[];
}

/** 解析当前 activeMatch；无效时返回中文错误 */
function matchCtx(state: GameState): MatchCtx | string {
  const am = state.activeMatch;
  if (!am) return '当前没有进行中的比赛';
  const t = state.tournaments[am.tournamentId];
  if (!t) return '赛事不存在';
  const series = t.series[am.seriesId];
  if (!series) return '系列赛不存在';
  if (!series.teamA || !series.teamB) return '对阵尚未确定';
  if (series.result) return '该系列赛已结束';
  const me = myTeamId(state);
  const mySide = series.teamA === me ? 'A' : series.teamB === me ? 'B' : null;
  if (!mySide) return '你的战队不在这场比赛中';
  am.games ??= [];
  return { t, series, teamA: series.teamA, teamB: series.teamB, mySide, games: am.games };
}

function draftDone(draft: DraftState | null): boolean {
  return !!draft && (draft.done || currentStep(draft) === null);
}

function winsOf(games: GameRecord[]): [number, number] {
  let a = 0;
  let b = 0;
  for (const g of games) if (g.winner === 'A') a++; else b++;
  return [a, b];
}

/** 系列赛判定（防御：局数达到上限仍未分胜负时按胜局数强制判定） */
function outcomeOf(bestOf: number, games: GameRecord[]): 'A' | 'B' | 'draw' | null {
  const [a, b] = winsOf(games);
  const o = seriesOutcome(bestOf, a, b);
  if (o !== null || games.length < Math.max(1, bestOf)) return o;
  return a > b ? 'A' : b > a ? 'B' : 'draw';
}

// ---------------- 玩家对玩家系列赛（多人模式 H2H，docs/MULTIPLAYER.md §8） ----------------
// 共享对局存于 multiplayer.h2h[seriesId]：BP 双方各自操作（选择自动 BP 的一方由 AI 代选），
// 对局记录生成即计入系列赛进度；双方的 activeMatch 是各自的「视图」（各自回放、各自继续），快速模拟需双方都请求。

function h2hOf(state: GameState, seriesId: string | null | undefined): H2HMatch | null {
  if (!seriesId) return null;
  return state.multiplayer?.h2h?.[seriesId] ?? null;
}

/** 系列赛双方都是仍在比赛中的玩家（多人模式） */
function isH2HSeries(state: GameState, series: Series | null | undefined): boolean {
  if (!series || !isMultiplayer(state) || !series.teamA || !series.teamB) return false;
  return seatInPlay(state, series.teamA) && seatInPlay(state, series.teamB);
}

function ensureH2H(state: GameState, t: Tournament, series: Series): H2HMatch {
  const mp = state.multiplayer!;
  mp.h2h ??= {};
  let h = mp.h2h[series.id];
  if (!h) {
    h = {
      seriesId: series.id, tournamentId: t.id, teamA: series.teamA!, teamB: series.teamB!,
      games: [], draft: null, mode: {}, joined: {}, quickSim: {},
    };
    mp.h2h[series.id] = h;
  }
  return h;
}

/** AI 代选：当前步骤所属一方选择了自动 BP 时由 AI 执行，直到轮到手动方 / 未选择方式的一方或 BP 结束 */
function pumpH2HDraft(state: GameState, h: H2HMatch): void {
  const d = h.draft;
  if (!d) return;
  let guardN = d.sequence.length + 1;
  while (!d.done && guardN-- > 0) {
    const step = currentStep(d);
    if (!step) {
      d.done = true;
      break;
    }
    if (h.mode[step.side] !== 'auto') break;
    if (d.available.length === 0) {
      d.done = true;
      break;
    }
    aiDraftStep(state, d, h.teamA, h.teamB);
  }
}

/** 把共享对局同步到双方的比赛视图（正在回放上一局的一方不打断） */
function syncH2HViews(state: GameState, h: H2HMatch): void {
  for (const [id, side] of [[h.teamA, 'A'], [h.teamB, 'B']] as const) {
    if (!seatOf(state, id)) continue;
    inSeatOf(state, id, () => {
      const am = state.activeMatch;
      if (!am || am.seriesId !== h.seriesId || am.pendingGame || h.done) return;
      am.games = h.games.slice();
      am.gameIndex = h.games.length;
      am.draft = h.draft;
      // 尚未选择 BP 方式的一方停留在赛前准备（客户端在此选择手动 / 自动 BP），即使对手已开始 BP
      am.phase = h.draft && h.mode[side] ? 'draft' : 'pre';
      am.manualDraft = h.mode[side] === 'manual';
    });
  }
}

/** 多人玩家对决：本座位的比赛是进行中的共享 BP 且尚未完成（对手手动 BP 中或尚未选择 BP 方式） */
export function h2hDraftPending(state: GameState): boolean {
  const am = state.activeMatch;
  const h = am ? h2hOf(state, am.seriesId) : null;
  return !!h && !h.done && !!h.draft && !draftDone(h.draft);
}

/**
 * 多人玩家对决：本方（当前座位）由手动 BP 改为自动 BP，AI 立即代选到对手回合或 BP 结束。
 * 供服务器托管离线玩家使用（不在 RPC 白名单中）：选了手动 BP 后掉线的玩家不会让对手一直等待。
 */
export function h2hSwitchToAutoDraft(state: GameState): OpResult {
  return guard(() => {
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') return fail(ctx);
    const h = liveH2H(state, ctx);
    if (!h || !h.draft || draftDone(h.draft)) return fail('当前不在玩家对决的 BP 中');
    if (state.activeMatch?.pendingGame) return fail('请先看完上一局的直播');
    if (h.mode[ctx.mySide] !== 'manual') return fail('本方未选择手动 BP');
    h.mode[ctx.mySide] = 'auto';
    pumpH2HDraft(state, h);
    syncH2HViews(state, h);
    return ok(`已改为自动 BP：${h2hDraftStatus(h, ctx.mySide)}`);
  });
}

function h2hDraftStatus(h: H2HMatch, mySide: 'A' | 'B'): string {
  const d = h.draft;
  if (!d || draftDone(d)) return 'BP 已完成，任一方可开始本局';
  const step = currentStep(d);
  if (!step) return 'BP 已完成，任一方可开始本局';
  if (step.side === mySide) return h.mode[mySide] === 'manual' ? 'BP 开始，轮到你了' : 'BP 进行中';
  return h.mode[step.side] ? '等待对手 BP' : '等待对手选择 BP 方式（手动或自动）';
}

/** 玩家对决系列赛出结果：写入系列赛、推进赛事（双方视图保留到各自看完回放） */
function finalizeH2H(state: GameState, h: H2HMatch, t: Tournament, series: Series, outcome: 'A' | 'B' | 'draw'): void {
  const [winsA, winsB] = winsOf(h.games);
  const teamA = h.teamA;
  const teamB = h.teamB;
  const result: SeriesResult = outcome === 'B'
    ? { winnerId: teamB, loserId: teamA, scoreA: winsA, scoreB: winsB, games: h.games.slice() }
    : { winnerId: teamA, loserId: teamB, scoreA: winsA, scoreB: winsB, games: h.games.slice() };
  h.done = true;
  h.draft = null;
  recordSeriesResult(state, t.id, series.id, result);
  const winnerText = outcome === 'draw' ? '双方握手言和' : `${teamName(state, outcome === 'A' ? teamA : teamB)} 胜出`;
  addNews(
    state, 'match', `${t.name} · ${series.label}（玩家对决）`,
    `${teamName(state, teamA)} ${winsA}:${winsB} ${teamName(state, teamB)}，${winnerText}。`,
    false, { teamIds: [teamA, teamB] },
  );
  const summary: Record<string, string> = {};
  for (const [id, side] of [[teamA, 'A'], [teamB, 'B']] as const) {
    const my = side === 'A' ? winsA : winsB;
    const opp = side === 'A' ? winsB : winsA;
    const oppId = side === 'A' ? teamB : teamA;
    const verdict = outcome === 'draw' ? '握手言和' : outcome === side ? '拿下比赛！' : '遗憾落败';
    summary[id] = `${series.label}：${teamTag(state, id)} ${my}:${opp} ${teamTag(state, oppId)}，${verdict}`;
  }
  h.summary = summary;
  afterPlayerSeries(state, t.id);
  const done = state.tournaments[t.id];
  if (done?.status === 'finished') {
    for (const id of [teamA, teamB]) {
      const pl = done.placements.find((p) => p.teamId === id);
      summary[id] += `。${t.name} 落幕${pl ? `，最终 ${formatRank(pl.rankFrom, pl.rankTo)}` : ''}`;
    }
  }
}

/** 玩家对决：结束本方视图（已出结果的系列赛） */
function closeH2HView(state: GameState, h: H2HMatch): OpResult {
  state.activeMatch = null;
  return ok(h.summary?.[myTeamId(state)] ?? '系列赛已结束');
}

/** 当前视图指向的、仍在进行的玩家对决（ctx 已校验） */
function liveH2H(state: GameState, ctx: MatchCtx): H2HMatch | null {
  const h = h2hOf(state, ctx.series.id);
  return h && !h.done && isH2HSeries(state, ctx.series) ? h : null;
}

/** 系列赛结束：写入结果、推进赛事、必要时结算 */
function finalizeSeries(state: GameState, ctx: MatchCtx, outcome: 'A' | 'B' | 'draw'): OpResult {
  const { t, series, teamA, teamB, mySide, games } = ctx;
  const [winsA, winsB] = winsOf(games);
  const result: SeriesResult = outcome === 'B'
    ? { winnerId: teamB, loserId: teamA, scoreA: winsA, scoreB: winsB, games: games.slice() }
    : { winnerId: teamA, loserId: teamB, scoreA: winsA, scoreB: winsB, games: games.slice() };
  state.activeMatch = null;
  recordSeriesResult(state, t.id, series.id, result);

  const myScore = mySide === 'A' ? winsA : winsB;
  const oppScore = mySide === 'A' ? winsB : winsA;
  const opp = mySide === 'A' ? teamB : teamA;
  const verdict = outcome === 'draw' ? '握手言和' : outcome === mySide ? '拿下比赛！' : '遗憾落败';
  const summary = `${series.label}：${teamTag(state, myTeamId(state))} ${myScore}:${oppScore} ${teamTag(state, opp)}，${verdict}`;
  addNews(state, 'match', `${t.name} · ${series.label}`, `${teamName(state, myTeamId(state))} ${myScore}:${oppScore} ${teamName(state, opp)}，${verdict}`);

  afterPlayerSeries(state, t.id);
  const done = state.tournaments[t.id];
  if (done?.status === 'finished') {
    const pl = done.placements.find((p) => p.teamId === myTeamId(state));
    return ok(`${summary}。${t.name} 落幕${pl ? `，最终 ${formatRank(pl.rankFrom, pl.rankTo)}` : ''}`);
  }
  return ok(summary);
}

/** 玩家一场系列赛结束后：推进 AI 比赛；玩家无后续比赛 → 模拟剩余并结算 */
function afterPlayerSeries(state: GameState, tournamentId: string): void {
  const t = state.tournaments[tournamentId];
  if (!t || t.status === 'finished') return;
  advanceTournamentUntilPlayer(state, tournamentId);
  if (finalizePlayerTournamentIfDone(state, tournamentId)) {
    const fin = state.tournaments[tournamentId];
    if (fin) compactTournament(state, fin, true);
  }
}

/**
 * 弃权判负：玩家首发凑不齐 5 人（且未招募临时替补）时，本场系列赛直接判负（对手记满胜局），
 * 推进赛事（被淘汰则模拟剩余比赛并结算）。返回结果说明。
 */
function forfeitPlayerSeries(state: GameState, t: Tournament, series: Series, errs: string[]): OpResult & { forfeited: true } {
  const me = myTeamId(state);
  const side: 'A' | 'B' = series.teamA === me ? 'A' : 'B';
  const opp = side === 'A' ? series.teamB : series.teamA;
  state.activeMatch = null;
  recordSeriesResult(state, t.id, series.id, forfeitResult(series, side));
  const h = h2hOf(state, series.id);
  if (h && !h.done) {
    // 玩家对决中弃权：共享对局结束
    h.done = true;
    h.draft = null;
    const text = `${series.label}：${teamTag(state, me)} 首发不足 5 人弃权，${teamTag(state, opp)} 获胜`;
    h.summary = { [me]: text, ...(opp ? { [opp]: text } : {}) };
  }
  addNews(
    state,
    'match',
    `${teamTag(state, me)} 弃权判负`,
    `${t.name} · ${series.label}：首发不足 5 人（${errs.join('；')}），且未招募临时替补，本场系列赛判 ${teamName(state, opp)} 获胜。`,
    true,
    { teamIds: [me, ...(opp ? [opp] : [])], tags: ['forfeit'] },
  );
  afterPlayerSeries(state, t.id);
  const done = state.tournaments[t.id];
  const pl = done?.status === 'finished' ? done.placements.find((p) => p.teamId === me) : undefined;
  const tail = done?.status === 'finished' ? `。${t.name} 落幕${pl ? `，最终 ${formatRank(pl.rankFrom, pl.rankTo)}` : ''}` : '';
  return {
    ok: true,
    forfeited: true,
    message: `${series.label}：首发不足 5 人，弃权判负（${errs.join('；')}）${tail}`,
  };
}

/**
 * 准备下一场系列赛（内部实现）。
 * 首发凑不齐 5 人时：手动比赛（allowShorthanded=false）返回失败并提示补人；
 * 快速模拟（allowShorthanded=true）时本场弃权判负（第六波：不再「残阵出战」），避免没钱请替补时整个赛季卡死。
 */
function prepareMatch(state: GameState, allowShorthanded: boolean): OpResult & { forfeited?: boolean; noSeries?: boolean } {
  if (state.gameOver) return fail('游戏已结束');
  if (state.activeMatch) {
    const ctx = matchCtx(state);
    if (typeof ctx !== 'string') return ok('继续进行中的比赛');
    state.activeMatch = null; // 失效的比赛状态（如读档后数据不一致），丢弃
  }
  if (hasBlockingDecisions(state)) return fail('请先处理消息中心的待办事项');
  const t = currentPlayerTournament(state);
  if (!t) return fail('本回合没有需要你出战的比赛');
  if (t.status !== 'running') return fail(`「${t.name}」尚未开赛`);

  const me = myTeamId(state);
  advanceTournamentUntilPlayer(state, t.id);
  const series = playerNextSeries(state, t.id);
  if (!series) {
    finalizePlayerTournamentIfDone(state, t.id);
    // 多人模式：赛事仍在进行且本方未出局 → 下一场要等其他玩家的系列赛结果（单机此时赛事必已结算）
    const waiting = isMultiplayer(state) && state.tournaments[t.id]?.status === 'running' && !isTeamEliminated(state, t.id, me);
    return {
      ...fail(waiting ? `「${t.name}」中你的下一场比赛尚未确定，请等待其他玩家完成比赛` : `你在「${t.name}」的比赛已全部结束`),
      noSeries: true,
    };
  }
  const errs = ensurePlayableLineup(state, t.id);
  if (errs.length) {
    if (!allowShorthanded) {
      return fail(`首发不足 5 人：${errs.join('；')}。请调整阵容或临时招募替补；直接快速模拟将弃权判负`);
    }
    return forfeitPlayerSeries(state, t, series, errs);
  }
  if (isH2HSeries(state, series)) {
    // 玩家对决：进入（或加入）共享对局
    const h = ensureH2H(state, t, series);
    h.joined[me] = true;
    state.activeMatch = {
      tournamentId: t.id,
      seriesId: series.id,
      gameIndex: h.games.length,
      draft: null,
      phase: 'pre',
      manualDraft: false,
      games: h.games.slice(),
    };
    syncH2HViews(state, h);
    const opp = series.teamA === me ? series.teamB : series.teamA;
    return ok(`${t.name} · ${series.label}：${teamName(state, series.teamA)} vs ${teamName(state, series.teamB)}（BO${series.bestOf} · 玩家对决）`
      + (opp && h.joined[opp] ? '' : '。等待对手进入比赛'));
  }
  state.activeMatch = {
    tournamentId: t.id,
    seriesId: series.id,
    gameIndex: 0,
    draft: null,
    phase: 'pre',
    manualDraft: false,
    games: [],
  };
  return ok(`${t.name} · ${series.label}：${teamName(state, series.teamA)} vs ${teamName(state, series.teamB)}（BO${series.bestOf}）`);
}

/** 准备玩家下一场系列赛：activeMatch = {phase:'pre', gameIndex: 已赛局数}；无就绪比赛返回失败 */
export function prepareNextMatch(state: GameState): OpResult {
  return guard(() => prepareMatch(state, false));
}

/** 开始本局 BP：manual=true 时 AI 先手执行到玩家回合；false 时全自动完成 BP。phase='draft' */
export function startDraft(state: GameState, manual: boolean): OpResult {
  return guard(() => {
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') return fail(ctx);
    const am = state.activeMatch!;
    const h = liveH2H(state, ctx);
    if (h) {
      if (am.pendingGame) return fail('请先看完上一局的直播');
      if (h.mode[ctx.mySide]) return fail('BP 已在进行中');
      if (!h.draft) {
        const draft = createDraft(state);
        if (draft.available.length === 0) return fail('英雄数据缺失，无法进行 BP，请快速模拟');
        h.draft = draft;
      }
      h.mode[ctx.mySide] = manual ? 'manual' : 'auto';
      h.joined[myTeamId(state)] = true;
      pumpH2HDraft(state, h);
      syncH2HViews(state, h);
      return ok(h2hDraftStatus(h, ctx.mySide));
    }
    if (am.phase === 'live' || am.pendingGame) return fail('本局已经开打');
    if (am.phase === 'draft' && am.draft && !draftDone(am.draft)) return fail('BP 已在进行中');
    const draft = createDraft(state);
    if (draft.available.length === 0) return fail('英雄数据缺失，无法进行 BP，请直接开打或快速模拟');
    am.draft = draft;
    am.manualDraft = manual;
    am.phase = 'draft';
    am.gameIndex = ctx.games.length;
    runDraftUntil(state, draft, ctx.teamA, ctx.teamB, manual ? ctx.mySide : null);
    if (!manual) return ok('BP 已自动完成');
    return ok(draftDone(draft) ? 'BP 已完成' : 'BP 开始，轮到你了');
  });
}

/** 当前 BP 推荐（玩家回合时） */
export function getDraftSuggestions(state: GameState): DraftSuggestion[] {
  try {
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') return [];
    const am = state.activeMatch!;
    if (am.phase !== 'draft' || !am.draft || draftDone(am.draft)) return [];
    const step = currentStep(am.draft);
    if (!step || step.side !== ctx.mySide) return [];
    return draftSuggestions(state, am.draft, ctx.teamA, ctx.teamB);
  } catch (e) {
    console.error('[engine]', e);
    return [];
  }
}

/** 玩家 BP 操作（ban 或 pick 当前步骤），随后 AI 执行到玩家下一回合或结束 */
export function playerDraftAction(state: GameState, heroId: string): OpResult {
  return guard(() => {
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') return fail(ctx);
    const am = state.activeMatch!;
    const h = liveH2H(state, ctx);
    if (h) {
      const d = h.draft;
      if (!d || am.pendingGame) return fail('当前不在 BP 阶段');
      if (draftDone(d)) return fail('BP 已结束');
      const st = currentStep(d);
      if (!st) return fail('BP 已结束');
      if (st.side !== ctx.mySide) return fail('还没轮到你');
      if (h.mode[ctx.mySide] !== 'manual') return fail('你选择了自动 BP');
      if (!d.available.includes(heroId)) return fail(`${heroName(heroId)} 不可选（已被禁用/选择或尚未上线）`);
      try {
        applyDraftAction(state, d, heroId, ctx.teamA, ctx.teamB);
      } catch (e) {
        return fail(errMsg(e));
      }
      pumpH2HDraft(state, h);
      syncH2HViews(state, h);
      return ok(`${st.type === 'ban' ? '禁用' : '选择'} ${heroName(heroId)}${draftDone(d) ? '，BP 完成' : ''}`);
    }
    if (am.phase !== 'draft' || !am.draft) return fail('当前不在 BP 阶段');
    const draft = am.draft;
    if (draftDone(draft)) return fail('BP 已结束');
    const step = currentStep(draft);
    if (!step) return fail('BP 已结束');
    if (step.side !== ctx.mySide) return fail('还没轮到你');
    if (!draft.available.includes(heroId)) return fail(`${heroName(heroId)} 不可选（已被禁用/选择或尚未上线）`);
    try {
      applyDraftAction(state, draft, heroId, ctx.teamA, ctx.teamB);
    } catch (e) {
      return fail(errMsg(e));
    }
    runDraftUntil(state, draft, ctx.teamA, ctx.teamB, ctx.mySide);
    const verb = step.type === 'ban' ? '禁用' : '选择';
    return ok(`${verb} ${heroName(heroId)}${draftDone(draft) ? '，BP 完成' : ''}`);
  });
}

/** 结束 BP 并模拟本局（含直播）：activeMatch.pendingGame、phase='live' */
export function playGame(state: GameState): OpResult {
  return guard(() => {
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') return fail(ctx);
    const am = state.activeMatch!;
    if (am.pendingGame) return ok('本局正在直播中');
    const h = liveH2H(state, ctx);
    if (h) {
      const d = h.draft;
      if (!d) return fail('请先开始 BP（双方各自选择手动或自动 BP）');
      if (!draftDone(d)) {
        const st = currentStep(d);
        return fail(st && !h.mode[st.side] ? '等待对手选择 BP 方式' : 'BP 尚未完成');
      }
      const gameIndex = h.games.length;
      const g = simulateGame(state, { teamA: h.teamA, teamB: h.teamB, gameIndex, draft: d, withLive: true, tier: ctx.t.tier });
      // 对局记录生成即计入系列赛进度；双方视图各自回放
      h.games.push(g);
      h.draft = null;
      h.mode = {};
      h.quickSim = {};
      for (const id of [h.teamA, h.teamB]) {
        if (!seatOf(state, id)) continue;
        inSeatOf(state, id, () => {
          const v = state.activeMatch;
          if (!v || v.seriesId !== h.seriesId) return;
          v.pendingGame = g;
          v.phase = 'live';
          v.gameIndex = gameIndex;
          v.draft = d;
          v.games = h.games.slice(0, gameIndex);
        });
      }
      const outcome = outcomeOf(ctx.series.bestOf, h.games);
      if (outcome !== null) finalizeH2H(state, h, ctx.t, ctx.series, outcome);
      return ok(`第 ${gameIndex + 1} 局开始！`);
    }
    let draft: DraftState | null = null;
    if (am.phase === 'draft' && am.draft) {
      if (!draftDone(am.draft)) {
        if (am.manualDraft) return fail('BP 尚未完成');
        runDraftUntil(state, am.draft, ctx.teamA, ctx.teamB, null);
      }
      draft = am.draft;
    }
    const gameIndex = ctx.games.length;
    am.gameIndex = gameIndex;
    am.pendingGame = simulateGame(state, {
      teamA: ctx.teamA,
      teamB: ctx.teamB,
      gameIndex,
      draft,
      withLive: true,
      tier: ctx.t.tier,
    });
    am.phase = 'live';
    return ok(`第 ${gameIndex + 1} 局开始！`);
  });
}

/**
 * 直播播放完毕后提交本局：写入系列赛进度；系列赛结束 → tournament.recordSeriesResult + advanceTournamentUntilPlayer，
 * 玩家被淘汰或赛事结束 → simulateTournamentToEnd + finishTournament；activeMatch=null。
 * 系列赛未结束 → activeMatch.gameIndex+1，phase='pre'。
 */
export function commitGame(state: GameState): OpResult {
  return guard(() => {
    const amH = state.activeMatch;
    const h = amH ? h2hOf(state, amH.seriesId) : null;
    // 仍在进行的玩家对决（或已出结果、视图待关闭）走共享对局；对手中途出局后退化为普通比赛（下方常规流程），
    // 否则本方手动打出的对局不会写入共享对局，系列赛永远打不完
    if (amH && h && (h.done || isH2HSeries(state, state.tournaments[h.tournamentId]?.series[h.seriesId]))) {
      // 玩家对决：只推进本方视图
      const g = amH.pendingGame;
      if (!g) {
        if (h.done) return closeH2HView(state, h);
        return fail('没有待提交的对局');
      } else {
        amH.pendingGame = undefined;
        amH.games = h.games.slice(0, g.index + 1);
        if (h.done) return closeH2HView(state, h);
        amH.phase = 'pre';
        amH.draft = null;
        amH.gameIndex = h.games.length;
        syncH2HViews(state, h);
        const [a, b] = winsOf(amH.games);
        const winnerId = g.winner === 'A' ? h.teamA : h.teamB;
        return ok(`第 ${amH.games.length} 局 ${teamTag(state, winnerId)} 获胜，当前比分 ${teamTag(state, h.teamA)} ${a}:${b} ${teamTag(state, h.teamB)}`);
      }
    }
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') return fail(ctx);
    const am = state.activeMatch!;
    const g = am.pendingGame;
    if (!g) return fail('没有待提交的对局');
    ctx.games.push(g);
    am.pendingGame = undefined;
    const outcome = outcomeOf(ctx.series.bestOf, ctx.games);
    if (outcome !== null) return finalizeSeries(state, ctx, outcome);

    am.gameIndex = ctx.games.length;
    am.phase = 'pre';
    am.draft = null;
    const [a, b] = winsOf(ctx.games);
    const winnerId = g.winner === 'A' ? ctx.teamA : ctx.teamB;
    return ok(`第 ${ctx.games.length} 局 ${teamTag(state, winnerId)} 获胜，当前比分 ${teamTag(state, ctx.teamA)} ${a}:${b} ${teamTag(state, ctx.teamB)}`);
  });
}

/** 快速模拟玩家当前整场系列赛（自动 BP、无直播），然后与 commitGame 相同的后续处理 */
export function quickSimSeries(state: GameState): OpResult {
  return guard(() => {
    if (!state.activeMatch) {
      const r = prepareMatch(state, true);
      if (!r.ok || r.forfeited) return r;
    }
    const hDone = h2hOf(state, state.activeMatch?.seriesId);
    if (hDone?.done) return closeH2HView(state, hDone);
    const ctx = matchCtx(state);
    if (typeof ctx === 'string') {
      state.activeMatch = null;
      return fail(ctx);
    }
    const am = state.activeMatch!;
    const h = liveH2H(state, ctx);
    if (h) return h2hQuickSim(state, h, ctx);
    // 已生成待直播的一局先计入；进行中的 BP 自动补完用于下一局
    let draft: DraftState | null = null;
    if (am.pendingGame) {
      ctx.games.push(am.pendingGame);
      am.pendingGame = undefined;
    } else if (am.phase === 'draft' && am.draft) {
      if (!draftDone(am.draft)) runDraftUntil(state, am.draft, ctx.teamA, ctx.teamB, null);
      draft = am.draft;
    }
    let outcome = outcomeOf(ctx.series.bestOf, ctx.games);
    for (let guardN = 0; outcome === null && guardN <= ctx.series.bestOf; guardN++) {
      ctx.games.push(simulateGame(state, {
        teamA: ctx.teamA,
        teamB: ctx.teamB,
        gameIndex: ctx.games.length,
        draft,
        withLive: false,
        tier: ctx.t.tier,
      }));
      draft = null;
      outcome = outcomeOf(ctx.series.bestOf, ctx.games);
    }
    if (outcome === null) {
      const [a, b] = winsOf(ctx.games);
      outcome = a > b ? 'A' : b > a ? 'B' : 'draw';
    }
    return finalizeSeries(state, ctx, outcome);
  });
}

/** 玩家对决的快速模拟：双方都请求后，自动 BP、无直播地打完剩余对局 */
function h2hQuickSim(state: GameState, h: H2HMatch, ctx: MatchCtx): OpResult {
  const me = myTeamId(state);
  h.quickSim[me] = true;
  h.joined[me] = true;
  const opp = ctx.mySide === 'A' ? ctx.teamB : ctx.teamA;
  if (!h.quickSim[opp]) return ok('已请求快速模拟，等待对手同意');
  let draft: DraftState | null = h.draft;
  if (draft && !draftDone(draft)) runDraftUntil(state, draft, h.teamA, h.teamB, null);
  let outcome = outcomeOf(ctx.series.bestOf, h.games);
  for (let guardN = 0; outcome === null && guardN <= ctx.series.bestOf; guardN++) {
    h.games.push(simulateGame(state, {
      teamA: h.teamA, teamB: h.teamB, gameIndex: h.games.length, draft, withLive: false, tier: ctx.t.tier,
    }));
    draft = null;
    outcome = outcomeOf(ctx.series.bestOf, h.games);
  }
  if (outcome === null) {
    const [a, b] = winsOf(h.games);
    outcome = a > b ? 'A' : b > a ? 'B' : 'draw';
  }
  finalizeH2H(state, h, ctx.t, ctx.series, outcome);
  // 快速模拟无直播：双方视图直接结束
  for (const id of [h.teamA, h.teamB]) {
    if (!seatOf(state, id)) continue;
    inSeatOf(state, id, () => {
      if (state.activeMatch?.seriesId === h.seriesId) state.activeMatch = null;
    });
  }
  return ok(h.summary?.[me] ?? '系列赛已结束');
}

/** 快速模拟玩家在当前赛事的全部剩余比赛 */
export function quickSimTournament(state: GameState): OpResult {
  return guard(() => {
    const t = currentPlayerTournament(state);
    if (!t && !state.activeMatch) return fail('本回合没有需要你出战的比赛');
    const tid = state.activeMatch?.tournamentId ?? t!.id;
    let last: OpResult = ok('');
    let played = 0;
    // 上限：任何赛制下玩家系列赛数都远小于此
    for (let i = 0; i < 64; i++) {
      const cur = state.tournaments[tid];
      if (!cur || cur.status === 'finished') break;
      if (!state.activeMatch) {
        const r = prepareMatch(state, true);
        if (!r.ok) {
          if (state.tournaments[tid]?.status === 'finished') break;
          // 多人模式：本方比赛已打完（出局或等待其他玩家的比赛结果），赛事因其他玩家仍在进行 → 本次模拟成功
          if (played && r.noSeries) return ok(`已模拟 ${played} 场；${r.message}`);
          return played ? fail(`已模拟 ${played} 场；${r.message}`) : r;
        }
      }
      last = quickSimSeries(state);
      if (!last.ok) return last;
      // 玩家对决：等待对手同意快速模拟
      const waiting = h2hOf(state, state.activeMatch?.seriesId);
      if (waiting && !waiting.done) return last;
      played++;
    }
    const fin = state.tournaments[tid];
    const pl = fin?.placements.find((p) => p.teamId === myTeamId(state));
    if (fin?.status === 'finished') {
      return ok(`${fin.name} 结束（模拟 ${played} 场）${pl ? `，最终 ${formatRank(pl.rankFrom, pl.rankTo)}` : ''}`);
    }
    return last.message ? last : ok(`已模拟 ${played} 场`);
  });
}

// ---------------- 临时替补 ----------------

/**
 * 一键补齐首发：先自动排阵，仍有空位时为每个空位从野外招募评分最高、负担得起的临时替补。
 * 仅在本回合有赛事时可用。
 */
export function fillLineupWithTempSubs(state: GameState): OpResult {
  return guard(() => {
    if (state.gameOver) return fail('游戏已结束');
    const t = currentPlayerTournament(state);
    if (!t) return fail('本回合没有你的赛事，无需临时替补');
    const me = myTeamId(state);
    const team = myTeam(state);
    if (!team) return fail('战队不存在');
    autoLineup(state, me, t.id);
    const hired: string[] = [];
    for (let i = 0; i < POSITIONS.length; i++) {
      if (!validateLineup(state, me, t.id).length) break;
      const pos: Position | undefined = POSITIONS.find((p) => {
        const id = team.lineup[p];
        const pl = id ? state.players[id] : null;
        return !pl || !isAvailable(pl, t.id);
      });
      if (!pos) break;
      const cands = generateTempSubCandidates(state, pos)
        .filter((c) => tempSubCost(state, c.id) <= team.gold)
        .sort((a, b) => overallRating(b) - overallRating(a));
      if (!cands.length) {
        return fail(hired.length ? `资金不足，仅招募到 ${hired.join('、')}` : '资金不足，无法招募临时替补');
      }
      const r = hireTempSub(state, cands[0].id, t.id);
      if (!r.ok) return fail(hired.length ? `已招募 ${hired.join('、')}；${r.message}` : r.message);
      hired.push(cands[0].handle);
      autoLineup(state, me, t.id);
    }
    const errs = validateLineup(state, me, t.id);
    if (errs.length) return fail(`仍无法凑齐首发：${errs.join('；')}`);
    return ok(hired.length ? `已临时招募：${hired.join('、')}` : '首发阵容已完整');
  });
}

// ---------------- 杂项 ----------------
export function dismissPopup(state: GameState): void {
  state.popups.shift();
}

export function markAllNewsRead(state: GameState): void {
  for (const n of state.news) n.read = true;
}

/** 赛事等级中文名（UI 便捷导出） */
export function tournamentTierLabel(t: Tournament): string {
  return TOURNAMENT_TIER_LABEL[t.tier] ?? t.tier;
}
