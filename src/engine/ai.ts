// AI 战队管理【E4 负责实现】
import type { Coach, GameState, Player, Region, Team, TrainingFocus } from './types';
import { REGIONS } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, type Rng } from './rng';
import { formatGold } from './util';
import { addNews } from './news';
import { trainTeam, adjustLoyalty } from './growth';
import { addFinance, roundWageBill } from './economy';
import { activeTeams, addPlayerToTeam, autoLineup, benchPlayers, lineupPlayers, teamPlayers } from './team';
import { computeSalary, effectiveAttr, marketValue, overallRating, playerRating, playerTier, tierIndex } from './player';
import { getPlayerIndex } from '../data/index';
import {
  aiSignFreeAgent, departToFreeAgency, executeTransfer, fillRosterFromMarket, freeAgents, pickAffordableFreeAgent,
  playerWillingness, roundFee, trimRoster,
} from './market';
import { generateAiTeam } from './generation';
import { allPendingDecisions } from './seat';
import { aiCoachCandidates, aiCoachPickWeight } from './coaches';
import { aiPursueMission, isRetainedMissionPlayer, missionAwareTrim, refreshMissions } from './missions';
import { aiLineupPriority, lineupPriorityLocks } from './lineupPriority';

const FOCI: TrainingFocus[] = ['power', 'mmr', 'insight', 'balanced'];

/** AI 战队（未解散、非玩家） */
function aiTeams(state: GameState): Team[] {
  return activeTeams(state).filter((t) => !t.isPlayer);
}

/** 正式阵容（不含临时替补） */
function roster(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament);
}

function randomFocus(rng: Rng): TrainingFocus {
  const w = CONFIG.ai.focusWeights;
  return rng.weighted(FOCI, FOCI.map((f) => w[f] ?? 0));
}

function isNotable(p: Player): boolean {
  return p.isReal || tierIndex(playerTier(p)) >= tierIndex('S');
}

function isNotableCoach(c: Coach): boolean {
  return !!c.formerPlayerId || tierIndex(c.tier) >= tierIndex('S');
}

/** 本回合参赛（正赛或封闭预选）的战队 id —— 与玩家一致：赛事回合不训练 */
function teamsPlayingInRound(state: GameState, roundIndex: number): Set<string> {
  const busy = new Set<string>();
  const ti = state.season?.ti;
  for (const t of Object.values(state.tournaments)) {
    if (!t || t.season !== ti || t.roundIndex !== roundIndex || t.status === 'scheduled') continue;
    for (const id of t.teamIds) busy.add(id);
    for (const id of t.qualifierTeamIds) busy.add(id);
  }
  return busy;
}

/**
 * 本赛季截至当前回合各战队的参赛比例 = 参赛回合数（正赛或封闭预选）/ 已进行的回合数（第 1 回合起）。
 * AI 战队据此在休赛回合加练（CONFIG.training.aiBusyExtraPerRound）：比赛成长压降后，参赛多、休赛少的强队不至于整体掉队。
 */
function seasonBusyShare(state: GameState): Map<string, number> {
  const ti = state.season?.ti;
  const cur = Math.max(1, Math.floor(state.roundIndex ?? 1));
  const rounds = new Map<string, Set<number>>();
  for (const t of Object.values(state.tournaments)) {
    if (!t || t.season !== ti || t.roundIndex > cur || t.roundIndex < 1 || t.status === 'scheduled') continue;
    for (const id of [...t.teamIds, ...t.qualifierTeamIds]) {
      let set = rounds.get(id);
      if (!set) rounds.set(id, (set = new Set()));
      set.add(t.roundIndex);
    }
  }
  const out = new Map<string, number>();
  for (const [id, set] of rounds) out.set(id, Math.min(1, set.size / cur));
  return out;
}

/**
 * 每回合结束：本回合没有参赛的 AI 战队进行 1 次训练（随机焦点，对应玩家休赛回合的免费训练；
 * CONFIG.training.aiTrainInEventRounds=true 时赛事回合也训练）。资金充裕（gold > 工资 × richWageMultiple）者
 * 额外训练 aiExtraTrainingsPerRound.rich 次（否则 .normal 次），另按本赛季参赛比例加练 aiBusyExtraPerRound × 比例次（小数部分按概率）。
 * 收益 × CONFIG.training.aiGainMult（AI 单独标定；成长重平衡后比赛只带来少量成长，AI 选手的赛季内成长与改动前大致相当）；
 * 加练与人类玩家的额外训练一样，天赋 / 韧性收益 × CONFIG.training.extraSessionAttrMult。
 */
export function aiTrainRound(state: GameState): void {
  const rng = rngOf(state);
  const t = CONFIG.training;
  const opts = { gainMult: t.aiGainMult };
  const extraOpts = { gainMult: t.aiGainMult, attrMult: t.extraSessionAttrMult }; // 加练：天赋 / 韧性与人类玩家的额外训练同样折算
  const busy = t.aiTrainInEventRounds ? new Set<string>() : teamsPlayingInRound(state, state.roundIndex);
  const busyExtra = Math.max(0, t.aiBusyExtraPerRound ?? 0);
  const share = busyExtra > 0 ? seasonBusyShare(state) : new Map<string, number>();
  for (const team of aiTeams(state)) {
    if (!team.playerIds.length || busy.has(team.id)) continue;
    trainTeam(state, team.id, randomFocus(rng), undefined, opts);
    const wage = roundWageBill(state, team.id);
    const rich = team.gold > wage * CONFIG.ai.richWageMultiple;
    const expected = Math.max(0, rich ? t.aiExtraTrainingsPerRound.rich : t.aiExtraTrainingsPerRound.normal)
      + busyExtra * (share.get(team.id) ?? 0);
    const whole = Math.floor(expected);
    const n = whole + (expected > whole && rng.chance(expected - whole) ? 1 : 0);
    for (let i = 0; i < n; i++) trainTeam(state, team.id, randomFocus(rng), undefined, extraOpts);
  }
}

// ---------------------------------------------------------------------------
// 转会窗口
// ---------------------------------------------------------------------------

/**
 * 补强：以更强的选手替换最弱首发。优先自由市场；找不到时挖角其他 AI 战队归属感低迷的选手（支付违约金）。
 * poachPool 为全联盟低归属感 AI 选手（按评分降序，窗口内一次性计算）。返回是否发生签约。
 * 首发优先级（lineupPriority.ts）锁定的位置（使命 / 巅峰选手打本位置）不在补强之列：按评分引进的人只会坐替补。
 */
function tryUpgrade(state: GameState, team: Team, pool: Player[], poachPool: Player[]): boolean {
  const all = lineupPlayers(state, team.id).filter((s) => s.player);
  if (all.length < 5) return false;
  const prio = aiLineupPriority(state, team.id);
  const slots = prio ? all.filter((s) => !lineupPriorityLocks(state, team.id, s.player, s.pos, null, prio)) : all;
  if (!slots.length) return false;
  let weakest = slots[0];
  let weakestRating = playerRating(weakest.player!, weakest.pos);
  for (const s of slots) {
    const r = playerRating(s.player!, s.pos);
    if (r < weakestRating) {
      weakest = s;
      weakestRating = r;
    }
  }
  const minRating = weakestRating * CONFIG.ai.upgradeMinGain;
  const cand = pickAffordableFreeAgent(state, team, pool, weakest.pos, minRating);
  if (cand) {
    aiSignFreeAgent(state, team, cand, pool);
    autoLineup(state, team.id);
    if (isNotable(cand)) {
      addNews(
        state,
        'transfer',
        `【转会】${team.name} 签下 ${cand.handle}`,
        `${team.name} 从自由市场签下 ${cand.handle}（${playerTier(cand)} 级 · ${POSITION_LABEL[cand.position]}），顶替 ${weakest.player!.handle} 的首发位置。`,
      );
    }
    return true;
  }
  return tryPoach(state, team, weakest.pos, minRating, pool, poachPool);
}

/** 挖角其他 AI 战队的低归属感选手 */
function tryPoach(
  state: GameState,
  team: Team,
  pos: Player['position'],
  minRating: number,
  pool: Player[],
  poachPool: Player[],
): boolean {
  const wage = roundWageBill(state, team.id);
  const [lo, hi] = CONFIG.market.poachFeeRange;
  for (let i = 0; i < poachPool.length; i++) {
    const p = poachPool[i];
    if (overallRating(p) <= minRating) return false; // 降序：后面只会更弱
    if (p.position !== pos || !p.teamId || p.teamId === team.id || p.status !== 'active') continue;
    // 俱乐部使命（第十波 #3）：使命俱乐部不放走自己的使命成员（留人）
    if (isRetainedMissionPlayer(state, p)) continue;
    const seller = state.teams[p.teamId];
    if (!seller || seller.isPlayer || seller.disbanded) continue;
    const fee = roundFee(marketValue(state, p) * (lo + hi) / 2);
    if (team.gold - fee < (wage + p.salary) * CONFIG.ai.signBudgetRounds) continue;
    if (playerWillingness(state, p.id, team.id) < CONFIG.ai.minWillingness) continue;
    executeTransfer(state, p.id, team.id, fee);
    poachPool.splice(i, 1);
    fillRosterFromMarket(state, seller.id, CONFIG.ai.minRoster, pool);
    autoLineup(state, team.id);
    if (isNotable(p)) {
      addNews(
        state,
        'transfer',
        `【挖角】${p.handle} 离开 ${seller.name}，加盟 ${team.name}`,
        `与老东家关系降至冰点的 ${p.handle} 被 ${team.name} 以 ${formatGold(fee)} 的违约金挖走。`,
      );
    }
    return true;
  }
  return false;
}

/** 资金充裕的队伍补一名替补（第 6 人） */
function maybeAddBench(state: GameState, team: Team, pool: Player[]): void {
  if (roster(state, team.id).length >= CONFIG.ai.minRoster + 1) return;
  const wage = roundWageBill(state, team.id);
  if (team.gold < wage * CONFIG.ai.benchTargetGoldRounds) return;
  const cand = pickAffordableFreeAgent(state, team, pool);
  if (cand) aiSignFreeAgent(state, team, cand, pool);
}

/** 本队目标教练等级（首发平均等级序号，四舍五入；没有首发时按全队） */
function coachTargetTier(state: GameState, team: Team): number {
  let list = lineupPlayers(state, team.id).map((s) => s.player).filter((p): p is Player => !!p);
  if (!list.length) list = roster(state, team.id);
  if (!list.length) return tierIndex('A');
  const avg = list.reduce((s, p) => s + tierIndex(playerTier(p)), 0) / list.length;
  return Number.isFinite(avg) ? Math.round(avg) : tierIndex('A');
}

/**
 * 无教练时按概率从教练市场签约（第九波克制，见 coaches.ts）：只在没有主教练时、以 CONFIG.ai.coachHireChance 概率出手；
 * 候选为负担得起（签字费 + 工资 × signBudgetRounds）且签下后市场不跌破保底的教练；按「与本队首发平均等级的差距」
 * 加权随机挑选（aiCoachPickWeight），不再总挑市场上最好的 —— 好教练不会被 AI 一扫而空。
 */
function maybeHireCoach(state: GameState, team: Team, coachPool: Coach[], rng: Rng): void {
  if (team.coachId && state.coaches[team.coachId]) return;
  if (!coachPool.length || !rng.chance(CONFIG.ai.coachHireChance)) return;
  const wage = roundWageBill(state, team.id);
  const feeOf = (c: Coach) => Math.round(Math.max(0, c.salary) * CONFIG.ai.coachFeeSalaryMult);
  const cands = aiCoachCandidates(coachPool, (c) => team.gold - feeOf(c) >= (wage + c.salary) * CONFIG.ai.signBudgetRounds);
  if (!cands.length) return;
  const target = coachTargetTier(state, team);
  const c = cands.length === 1 ? cands[0] : rng.weighted(cands, cands.map((x) => aiCoachPickWeight(x, target)));
  const fee = feeOf(c);
  c.teamId = team.id;
  team.coachId = c.id;
  if (fee > 0) addFinance(state, team.id, -fee, 'signing', `签约教练 ${c.name}`);
  const i = coachPool.indexOf(c);
  if (i >= 0) coachPool.splice(i, 1);
  if (isNotableCoach(c)) {
    addNews(state, 'transfer', `【教练】${c.name} 出任 ${team.name} 主教练`, `${team.name} 宣布 ${c.name}（${c.tier} 级教练）执掌帅印。`);
  }
}

/**
 * 资金为负：依次出售工资最高的替补（无买家则解约），直到资金转正或替补清空（首发不动，保证 ≥ 5 人）；
 * 仍为负则全员降薪（不低于 CONFIG.economy.minSalary）。
 */
function handleDebt(state: GameState, team: Team, rng: Rng): void {
  if (team.gold >= 0) return;
  for (let guard = CONFIG.team.maxRoster; guard > 0 && team.gold < 0; guard--) {
    if (roster(state, team.id).length <= CONFIG.ai.minRoster) break;
    const allBench = benchPlayers(state, team.id).filter((p) => !p.tempSubUntilTournament);
    if (!allBench.length) break;
    // 只出售位置有人顶替的替补：阵中唯一的本职选手（被客串者挤到替补席）不卖，避免出现缺本职位置的阵容（卖无可卖 → 降薪）
    const regulars = roster(state, team.id);
    const sellable = allBench.filter((p) => regulars.some((q) => q.id !== p.id && q.position === p.position));
    // 俱乐部使命：先卖非使命成员
    const nonMission = sellable.filter((p) => !isRetainedMissionPlayer(state, p));
    const bench = nonMission.length ? nonMission : sellable;
    if (!bench.length) break;
    let star = bench[0];
    for (const p of bench) if (p.salary > star.salary) star = p;
    const fee = roundFee(marketValue(state, star) * CONFIG.ai.distressSaleFeeMult);
    const buyers = aiTeams(state).filter(
      (t) =>
        t.id !== team.id &&
        roster(state, t.id).length < CONFIG.ai.maxRoster &&
        t.gold - fee >= (roundWageBill(state, t.id) + star.salary) * CONFIG.ai.signBudgetRounds,
    );
    if (buyers.length && fee > 0) {
      const buyer = rng.weighted(buyers, buyers.map((t) => Math.max(1, t.gold)));
      executeTransfer(state, star.id, buyer.id, fee);
      autoLineup(state, buyer.id);
      if (isNotable(star)) {
        addNews(state, 'transfer', `【甩卖】${team.name} 资金告急，${star.handle} 转投 ${buyer.name}`, `${team.name} 财政吃紧，以 ${formatGold(fee)} 将 ${star.handle} 出售给 ${buyer.name}。`);
      }
    } else {
      // 无人接盘：解约以节省工资
      executeRelease(state, team, star);
    }
  }
  if (team.gold < 0) {
    const floor = CONFIG.economy.minSalary;
    for (const p of roster(state, team.id)) {
      p.salary = Math.max(floor, Math.round(p.salary * CONFIG.ai.salaryCutMult));
      adjustLoyalty(p, CONFIG.ai.salaryCutLoyalty);
    }
  }
}

function executeRelease(state: GameState, team: Team, p: Player): void {
  if (p.teamId !== team.id) return;
  departToFreeAgency(state, p.id);
  if (isNotable(p)) {
    addNews(state, 'transfer', `【解约】${team.name} 与 ${p.handle} 解约`, `${team.name} 为削减开支与 ${p.handle} 解约，后者成为自由选手。`);
  }
}

/**
 * AI 转会窗口：
 * - 'preseason'：补齐至 5~7 人（自由选手/新秀/卡池外新人），以更强自由选手替换最弱首发（概率），签约教练（无教练时）
 * - 'midseason'：小概率补强；资金为负的战队出售/解约高薪选手
 * 所有 AI 操作写入转会新闻（只写知名/高等级选手）。最后对每队 team.autoLineup。
 * opts.upgrades=false：跳过「以更强选手替换最弱首发」（休赛期转会潮 shuffle.offseasonShuffle 已完成大规模换人时，
 * 赛季初窗口只做还债/补员/替补/教练等收尾）。
 */
export function aiTransferWindow(
  state: GameState,
  mode: 'preseason' | 'midseason',
  opts: { upgrades?: boolean } = {},
): void {
  if (state.gameOver) return;
  const rng = rngOf(state);
  const pool = freeAgents(state);
  const teams = rng.shuffle(aiTeams(state).slice());
  // 玩家战队退役选手转来的教练：玩家拥有优先签约权，决策未处理前 AI 不得签约
  const reserved = new Set<string>();
  for (const d of allPendingDecisions(state)) {
    if (d.kind !== 'retire') continue;
    if (typeof d.ctx?.coachId === 'string') reserved.add(d.ctx.coachId);
    if (typeof d.ctx?.playerId === 'string') reserved.add(`p:${d.ctx.playerId}`);
  }
  const coachPool =
    mode === 'preseason'
      ? Object.values(state.coaches)
          .filter((c) => !c.teamId && !reserved.has(c.id) && !(c.formerPlayerId && reserved.has(`p:${c.formerPlayerId}`)))
          .sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier) || b.insight - a.insight)
      : [];
  const upgradeChance = mode === 'preseason' ? CONFIG.ai.preseasonUpgradeChance : CONFIG.ai.midseasonUpgradeChance;
  // 全联盟低归属感 AI 选手（挖角目标），评分降序
  const poachPool: Player[] = [];
  for (const t of teams) {
    for (const p of roster(state, t.id)) {
      if (effectiveAttr(p, 'loyalty') < CONFIG.loyalty.leaveThreshold) poachPool.push(p);
    }
  }
  poachPool.sort((a, b) => overallRating(b) - overallRating(a));

  // 俱乐部使命（第十波 #3，missions.ts）：使命俱乐部先于其他操作引进缺失的现实巅峰阵容成员（自由身签下 / 溢价求购）
  for (const team of teams) if (!team.disbanded) aiPursueMission(state, team, pool, mode, rng);
  for (const team of teams) {
    if (team.disbanded) continue;
    handleDebt(state, team, rng);
    missionAwareTrim(state, team.id, CONFIG.ai.maxRoster);
    trimRoster(state, team.id, CONFIG.ai.maxRoster);
    fillRosterFromMarket(state, team.id, CONFIG.ai.minRoster, pool);
    if (opts.upgrades !== false && team.gold > 0 && rng.chance(upgradeChance)) tryUpgrade(state, team, pool, poachPool);
    if (mode === 'preseason') {
      maybeAddBench(state, team, pool);
      maybeHireCoach(state, team, coachPool, rng);
    }
    missionAwareTrim(state, team.id, CONFIG.ai.maxRoster);
    trimRoster(state, team.id, CONFIG.ai.maxRoster);
    autoLineup(state, team.id);
  }
  // 俱乐部使命：刷新进度（新集齐巅峰阵容的发新闻）
  refreshMissions(state);
}

/** 某战队在 pos 位置首发的评分（空位为 0） */
function starterRatingAt(state: GameState, teamId: string, pos: Player['position']): number {
  const slot = lineupPlayers(state, teamId).find((s) => s.pos === pos);
  return slot?.player ? playerRating(slot.player, pos) : 0;
}

/**
 * 【已停用】第八波起真实新秀通过赛季初的新秀选秀（rookieDraft.ts）加盟，AI 不再提前签下真实新秀，本函数不再被调用（仅为旧逻辑参考保留）。
 * 原逻辑：赛季开打（抽卡关闭）时：本赛季卡池里未被玩家抽走的真实新秀加盟 AI 战队，让真实新秀在其登场赛季就站上赛场
 * （否则要等下赛季作为自由选手才可能被签下）。优先加盟其真实出道战队（playerIndex.firstTeamId，须为现存 AI 战队；
 * 阵容已满时先放走最弱替补），否则加盟「该位置首发最弱、阵容有空位且付得起工资」的 AI 战队。新秀合同、新秀工资。
 */
export function aiSignRealRookies(state: GameState): void {
  if (!CONFIG.gacha.realRookiesJoinAi || state.gameOver) return;
  const rookies = (state.gachaPool ?? [])
    .map((id) => state.players[id])
    .filter((p): p is Player => !!p && p.isReal === true && !p.teamId && p.status === 'active')
    .sort((a, b) => overallRating(b) - overallRating(a));
  if (!rookies.length) return;
  let firstTeam = new Map<string, string | undefined>();
  try {
    firstTeam = new Map((getPlayerIndex() ?? []).map((e) => [e.id, e.firstTeamId]));
  } catch {
    /* 无索引：全部走通用分配 */
  }
  const maxRoster = CONFIG.ai.maxRoster;
  const signedIds = new Set<string>();
  const names: string[] = [];
  for (const p of rookies) {
    const salary = computeSalary(state, p, true);
    const home = state.teams[firstTeam.get(p.id) ?? ''];
    let team: Team | null = home && !home.isPlayer && !home.disbanded && home.playerIds.length > 0 ? home : null;
    if (team && roster(state, team.id).length >= maxRoster) trimRoster(state, team.id, maxRoster - 1);
    if (!team) {
      // 通用分配：付得起工资（放宽为只看新秀自身工资）的 AI 战队中，该位置首发最弱者；阵容已满时须强于其最弱替补
      const rating = overallRating(p);
      let best = -Infinity;
      for (const t of aiTeams(state)) {
        if (!t.playerIds.length || t.gold < salary * CONFIG.ai.signBudgetRounds) continue;
        const full = roster(state, t.id).length >= maxRoster;
        if (full) {
          const bench = benchPlayers(state, t.id).filter((b) => !b.tempSubUntilTournament);
          if (!bench.length || bench.every((b) => overallRating(b) >= rating)) continue;
        }
        const affordable = t.gold >= (roundWageBill(state, t.id) + salary) * CONFIG.ai.signBudgetRounds;
        const gap = playerRating(p, p.position) - starterRatingAt(state, t.id, p.position) - (full ? 5 : 0) - (affordable ? 0 : 10);
        if (gap > best) {
          best = gap;
          team = t;
        }
      }
      if (team && roster(state, team.id).length >= maxRoster) trimRoster(state, team.id, maxRoster - 1);
    }
    if (!team) continue;
    addPlayerToTeam(state, p.id, team.id, { salary, contractSeasons: CONFIG.gacha.rookieContractSeasons });
    if (p.teamId !== team.id) continue;
    autoLineup(state, team.id);
    signedIds.add(p.id);
    names.push(`${p.handle}（${team.name}）`);
  }
  if (!signedIds.size) return;
  state.gachaPool = state.gachaPool.filter((id) => !signedIds.has(id));
  addNews(
    state,
    'transfer',
    `【新秀】${names.length} 名新秀加盟职业战队`,
    `本赛季卡池中未被签下的新秀陆续找到了东家：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}。`,
  );
}

/** 保证所有 AI 战队至少 5 名可用选手（用自由选手或生成选手补齐）并 autoLineup；战队数 < CONFIG.team.minTeams 时生成新战队 */
export function aiEnsureRosters(state: GameState): void {
  const rng = rngOf(state);
  let pool: Player[] | null = null;
  for (const team of aiTeams(state)) {
    const n = roster(state, team.id).length;
    if (n < CONFIG.ai.minRoster) {
      pool ??= freeAgents(state);
      fillRosterFromMarket(state, team.id, CONFIG.ai.minRoster, pool);
    } else if (n > CONFIG.ai.maxRoster) {
      missionAwareTrim(state, team.id, CONFIG.ai.maxRoster);
      trimRoster(state, team.id, CONFIG.ai.maxRoster);
    }
    autoLineup(state, team.id);
  }

  let missing = CONFIG.team.minTeams - activeTeams(state).length;
  if (missing <= 0) return;
  const count = Object.fromEntries(REGIONS.map((r) => [r, 0])) as Record<Region, number>;
  for (const t of activeTeams(state)) count[t.region] = (count[t.region] ?? 0) + 1;
  const strengths = ['weak', 'mid', 'strong'] as const;
  const sw = CONFIG.ai.newTeamStrengthWeights;
  let guard = missing + 5;
  while (missing > 0 && guard-- > 0) {
    const min = Math.min(...REGIONS.map((r) => count[r]));
    const region = rng.pick(REGIONS.filter((r) => count[r] === min));
    const strength = rng.weighted(strengths, strengths.map((s) => sw[s] ?? 0));
    const team = generateAiTeam(state, region, strength);
    if (!team) break;
    count[region] += 1;
    missing -= 1;
    if (roster(state, team.id).length < CONFIG.ai.minRoster) fillRosterFromMarket(state, team.id, CONFIG.ai.minRoster);
    autoLineup(state, team.id);
  }
}
