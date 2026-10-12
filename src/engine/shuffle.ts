// 休赛期转会潮【第五波 E2-shuffle】
// 每届 TI 结算后（退役 / 年龄 / 合同到期之后）、新赛季赛程生成之前执行一次（season.startSeason 调用）：
//   1. 上赛季满意度：名次 vs 赛前预期（荣誉变化的主要来源）、赛季最终排名 vs 战力排名、TI 成绩
//   2. 不满意的队计划换 1~3 名首发；争冠队 / 卫冕冠军 0~1；长期核心与高归属感选手更难被换
//   3. 选手意愿：弱队 / 不满意队里的明星求变、强队明星寻求新挑战（顶级战队之间横向流动）、低归属感选手求去、
//      强队老将下放二线队（只去更弱的队）、欠薪队甩卖
//   4. 市场：求变 / 新挑战的明星先由符合条件的强队争夺（placeStars），之后强队先挑：自由选手（含选秀落选的新秀）/
//      挂牌选手 / 挖角（付转会费，影响 AI 资金），多轮连锁；本窗口刚引进的选手不会再被替换或解约
//   5. 罕见事件：资金或荣誉见底的 AI 战队解散，新组织接手部分核心（每届至多 1 支）
//   6. 玩家战队：只收到更频繁的 AI 报价（transferOffers）与离队申请（leave_request），不会被直接搬走选手
//   7. 新闻：【传闻】（真假参半，日期在休赛期）→ 每笔知名转会一条 → 【转会窗口】汇总
// 只动 AI 战队（team.isPlayer 一律跳过），多人模式下所有玩家战队同样只会收到报价。
// 第十波 #3 俱乐部使命（missions.ts）：使命俱乐部在明星去向之前优先引进缺失的使命成员（溢价求购 / 顶掉同位置的非使命首发，pursueMissions），
// 使命成员更难被换下、挂牌、挖走与裁掉；玩家战队里的使命成员只会收到报价（玩家可拒绝）。
import type { GameState, NewsItem, Player, Position, Team } from './types';
import { POSITIONS } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, type Rng } from './rng';
import { addDays, clamp, formatGold, lerp, nextId, placementPercentile } from './util';
import { addNews } from './news';
import { activeTeams, autoLineup, lineupPlayers, teamPlayers, teamRating } from './team';
import {
  ageOf, computeSalary, effectiveAttr, marketValue, overallRating, playerRating, playerTier, tierIndex,
} from './player';
import {
  aiSignFreeAgent, createTransferOffer, departToFreeAgency, executeTransfer, fillRosterFromMarket, freeAgents,
  playerWillingness, releaseCompensation, roundFee, signingFee, trimRoster,
} from './market';
import { addFinance, econ, roundWageBill } from './economy';
import { colorFromId, generateTeamName } from './generation';
import { honorLuck } from './honor';
import {
  isMissionPlayerOf, missionAwareTrim, missionBidFee, missionCanAfford, missionInEffect, missionSellChance, missionTargets,
  missionWillingness, missionsEnabled,
} from './missions';
import { orgTeam, peakOrgsOfPlayer } from './clubs';
import { lineupPriorityLocks } from './lineupPriority';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ShuffleMoveKind = 'transfer' | 'signing' | 'release';
export type ShuffleReason =
  | 'upgrade' | 'need' | 'ambition' | 'challenge' | 'loyalty' | 'veteran' | 'surplus' | 'distress' | 'poach' | 'disband'
  /** 俱乐部使命：引进现实巅峰阵容的成员（第十波 #3） */
  | 'mission';

export interface ShuffleMove {
  playerId: string;
  handle: string;
  kind: ShuffleMoveKind;
  fromTeamId: string | null;
  toTeamId: string | null;
  fee: number;
  reason: ShuffleReason;
  notable: boolean;
}

export interface ShuffleReport {
  ti: number;
  moves: ShuffleMove[];
  rumors: number;
  disbandedTeamId: string | null;
  newTeamId: string | null;
  humanOffers: number;
  humanLeaveRequests: number;
  /** 各 AI 战队：战力排名、满意度、计划主动换人数、实际引进人数 */
  teams: { teamId: string; rank: number; satisfaction: number; planned: number; signed: number }[];
}

interface TeamCtx {
  team: Team;
  /** 战力排名（转会前，1 = 最强，含玩家战队） */
  rank: number;
  /** 上赛季满意度 -1..1 */
  sat: number;
  unhappy: boolean;
  contender: boolean;
  champion: boolean;
  /** 剩余主动换人次数 */
  budget: number;
  minGain: number;
  /** 首发按「该换」程度降序 */
  replaceOrder: string[];
  /** 被挖走首发留下的位置（下一轮补强） */
  vacancies: Position[];
  planned: number;
  signed: number;
  /** 本窗口已引进一名明星（placeStars：每队至多一名） */
  starSigned: boolean;
}

interface Listing {
  playerId: string;
  sellerId: string;
  reason: ShuffleReason;
  fee: number;
  /** 选手本人想走（意愿加成） */
  wantsOut: boolean;
  /** 只接受战力排名 ≤ 此值的买家（明星求变 / 寻求新挑战） */
  maxBuyerRank?: number;
  /** 只接受战力排名 ≥ 此值的买家（老将下放二线队） */
  minBuyerRank?: number;
}

interface Candidate {
  p: Player;
  source: 'listing' | 'fa' | 'poach';
  fee: number;
  reason: ShuffleReason;
  will: number;
}

interface World {
  state: GameState;
  rng: Rng;
  ti: number;
  nTeams: number;
  ctxs: Map<string, TeamCtx>;
  rankOf: Map<string, number>;
  listings: Map<string, Listing>;
  fa: Player[];
  moves: ShuffleMove[];
  movedIds: Set<string>;
  stars: Set<string>;
  rumored: Set<string>;
  /** 联盟首发评分百分位（0 = 最强） */
  starterPct: Map<string, number>;
  sat: Map<string, { sat: number; champion: boolean }>;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const S = () => CONFIG.shuffle;

function regular(state: GameState, teamId: string): Player[] {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament && !p.isWildSub);
}

function starterPos(team: Team, playerId: string): Position | null {
  for (const pos of POSITIONS) if (team.lineup?.[pos] === playerId) return pos;
  return null;
}

function starterAt(state: GameState, team: Team, pos: Position): Player | null {
  const id = team.lineup?.[pos];
  const p = id ? state.players[id] : undefined;
  return p && p.teamId === team.id && p.status === 'active' ? p : null;
}

function rangeOf(rng: Rng, r: readonly [number, number]): number {
  return rng.range(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
}

function intOf(rng: Rng, r: readonly [number, number]): number {
  return rng.int(Math.min(r[0], r[1]), Math.max(r[0], r[1]));
}

function signingLoyalty(will: number): number {
  const [a, b] = CONFIG.market.newSigningLoyalty;
  return Math.round(lerp(a, b, clamp(will, 0, 1)));
}

function contractSeasons(rng: Rng): number {
  return intOf(rng, CONFIG.economy.contractSeasons);
}

/** 付完费用后，余额仍能覆盖（现有工资 + 新增工资）× budgetRounds 回合 */
function canAfford(state: GameState, team: Team, fee: number, salary: number): boolean {
  return team.gold - fee >= (roundWageBill(state, team.id) + salary) * S().budgetRounds;
}

/** 选手是 team 的使命成员（留人加成；missions.ts） */
function isOwnMission(w: World, p: Player, teamId: string): boolean {
  return isMissionPlayerOf(w.state, p.id, teamId);
}

function isNotable(w: World, p: Player): boolean {
  return tierIndex(playerTier(p)) >= tierIndex('S') || w.stars.has(p.id);
}

function teamNameOf(state: GameState, id: string | null): string {
  if (!id) return '自由身';
  return state.teams[id]?.name ?? id;
}

/** 转会类新闻：显式给出关联战队/选手与标签（供新闻编辑部归类、链接与要闻评分） */
function postNews(
  state: GameState, title: string, body: string, important: boolean,
  teamIds: (string | null)[], playerIds: string[], tags: string[],
): NewsItem {
  const tids = [...new Set(teamIds.filter((x): x is string => !!x && !!state.teams[x]))];
  return addNews(state, 'transfer', title, body, important, { teamIds: tids, playerIds: [...new Set(playerIds)], tags });
}

// ---------------------------------------------------------------------------
// 上赛季满意度
// ---------------------------------------------------------------------------

interface PerfRecord {
  sum: number;
  w: number;
  ti?: { pAct: number; pExp: number | null; champion: boolean };
}

/** 上赛季各队「名次 vs 赛前预期」（history.tournaments + 赛事实例上的 expectedRanks） */
function lastSeasonPerformance(state: GameState, prevTi: number): { perf: Map<string, PerfRecord>; hasTi: boolean } {
  const perf = new Map<string, PerfRecord>();
  let hasTi = false;
  const weights = S().tierWeight;
  for (const h of state.history?.tournaments ?? []) {
    if (h.season !== prevTi) continue;
    if (h.tier === 'ti') hasTi = true;
    const expMap = state.tournaments[h.tournamentId]?.expectedRanks;
    for (const [teamId, pl] of Object.entries(h.placements ?? {})) {
      if (!Array.isArray(pl) || pl.length < 3) continue;
      const [from, to, n] = pl;
      const pAct = placementPercentile(from, to, n);
      const exp = expMap?.[teamId];
      const pExp = typeof exp === 'number' && Number.isFinite(exp) ? placementPercentile(exp, exp, n) : null;
      let rec = perf.get(teamId);
      if (!rec) {
        rec = { sum: 0, w: 0 };
        perf.set(teamId, rec);
      }
      const w = weights[h.tier] ?? 1;
      if (pExp !== null) {
        rec.sum += w * (pExp - pAct);
        rec.w += w;
      }
      if (h.tier === 'ti') rec.ti = { pAct, pExp, champion: from === 1 && to === 1 };
    }
  }
  return { perf, hasTi };
}

/** 战力排名（1 = 最强；全部未解散战队，含玩家战队） */
function strengthRanks(state: GameState): Map<string, number> {
  const rated = activeTeams(state).map((t) => ({ id: t.id, r: teamRating(state, t.id) }));
  rated.sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(rated.map((x, i) => [x.id, i + 1]));
}

function satisfactionOf(
  team: Team, rank: number, nTeams: number, rec: PerfRecord | undefined, hasTi: boolean,
): { sat: number; champion: boolean } {
  const c = S();
  const perfTerm = rec && rec.w > 0 ? rec.sum / rec.w : 0;
  const last = team.lastSeasonRank;
  const rankTerm = last ? clamp((rank - last) / Math.max(c.rankScaleMin, nTeams * c.rankScaleShare), -1, 1) : 0;
  let tiTerm = 0;
  const champion = !!rec?.ti?.champion;
  if (rec?.ti) {
    tiTerm = (rec.ti.pExp !== null ? rec.ti.pExp - rec.ti.pAct : 0) + (champion ? c.tiChampionBonus : 0);
  } else if (hasTi && rank <= c.tiMissRank) {
    tiTerm = -c.tiMissPenalty * (1 - (rank - 1) / c.tiMissRank);
  }
  const sat = c.wPerf * perfTerm + c.wRank * rankTerm + c.wTi * tiTerm;
  return { sat: Number.isFinite(sat) ? sat : 0, champion };
}

/**
 * 全部未解散战队的满意度（夹在 -1..1）。「名次 vs 预期」以百分位计，强队天然只能持平或落后于预期、弱队反之；
 * 按战力百分位做线性回归，扣除 satDebias × 趋势（保留联盟均值），使满意度反映「相对同档队伍」的表现。
 */
function satisfactionMap(state: GameState, ranks: Map<string, number>): Map<string, { sat: number; champion: boolean }> {
  const c = S();
  const n = ranks.size;
  const { perf, hasTi } = lastSeasonPerformance(state, (state.season?.ti ?? 1) - 1);
  const rows = activeTeams(state).map((t) => {
    const rank = ranks.get(t.id) ?? n;
    const r = satisfactionOf(t, rank, n, perf.get(t.id), hasTi);
    return { id: t.id, x: n > 1 ? (rank - 1) / (n - 1) : 0, sat: r.sat, champion: r.champion };
  });
  let slope = 0;
  let mx = 0;
  if (rows.length >= 3 && c.satDebias > 0) {
    mx = rows.reduce((a, r) => a + r.x, 0) / rows.length;
    const my = rows.reduce((a, r) => a + r.sat, 0) / rows.length;
    let cov = 0;
    let vx = 0;
    for (const r of rows) {
      cov += (r.x - mx) * (r.sat - my);
      vx += (r.x - mx) ** 2;
    }
    slope = vx > 0 ? cov / vx : 0;
  }
  const out = new Map<string, { sat: number; champion: boolean }>();
  for (const r of rows) {
    const sat = clamp(r.sat - c.satDebias * slope * (r.x - mx), -1, 1);
    out.set(r.id, { sat: Number.isFinite(sat) ? sat : 0, champion: r.champion });
  }
  return out;
}

/**
 * 各战队对上赛季的满意度（-1..1，负 = 不满意）。基于 season.ti - 1 的赛事记录；
 * 可供 UI / 其他模块展示「董事会满意度」。
 */
export function lastSeasonSatisfaction(state: GameState): Map<string, number> {
  const out = new Map<string, number>();
  if (!state.season) return out;
  for (const [id, v] of satisfactionMap(state, strengthRanks(state))) out.set(id, v.sat);
  return out;
}

// ---------------------------------------------------------------------------
// 计划：换人预算 / 挂牌
// ---------------------------------------------------------------------------

function replaceOrder(w: World, team: Team): string[] {
  const c = S();
  const { state, rng, ti } = w;
  const slots = lineupPlayers(state, team.id).filter((s) => s.player);
  if (!slots.length) return [];
  let total = 0;
  for (const s of slots) total += playerRating(s.player!, s.pos);
  const avgRating = total / slots.length || 1;
  const scored = slots.map((s) => {
    const p = s.player!;
    const rel = playerRating(p, s.pos) / avgRating;
    const age = ageOf(state, p);
    const loyalty = effectiveAttr(p, 'loyalty');
    const tenure = Math.max(0, ti - (p.joinedSeason ?? ti));
    const sticky = Math.min(c.tenureMax, tenure * c.tenureStep * (rel >= c.coreRatio ? 1 : 0.5))
      + (loyalty >= c.highLoyalty ? c.highLoyaltySticky : 0)
      + (isOwnMission(w, p, team.id) ? CONFIG.missions.replaceSticky : 0);
    const score = c.weakness * (1 - rel)
      + c.ageStep * Math.max(0, age - c.ageFrom + 1)
      + c.lowLoyalty * Math.max(0, (50 - loyalty) / 50)
      + (p.position !== s.pos ? c.offRole : 0)
      - sticky
      + rng.normal(0, c.replaceNoise);
    return { id: p.id, score };
  });
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return scored.map((x) => x.id);
}

function buildContexts(w: World): void {
  const c = S();
  const { state, rng } = w;
  for (const team of activeTeams(state)) {
    if (team.isPlayer) continue;
    const rank = w.rankOf.get(team.id) ?? w.nTeams;
    const { sat, champion } = w.sat.get(team.id) ?? { sat: 0, champion: false };
    const unhappy = sat <= c.unhappyBelow;
    const contender = rank <= c.contenderRank && sat >= 0;
    let lambda = c.changesBase + c.changesDissatisfied * Math.max(0, -sat) - c.changesSatisfied * Math.max(0, sat);
    if (contender) lambda = Math.min(lambda, c.contenderMaxChanges);
    if (champion) lambda = Math.min(lambda, c.championMaxChanges);
    lambda = clamp(lambda, c.changesMin, c.changesMax);
    const n = Math.max(1, c.maxChangesPerTeam);
    let budget = 0;
    for (let i = 0; i < n; i++) if (rng.chance(lambda / n)) budget++;
    // 争冠队 / 卫冕冠军：主动换人至多 1 名（被挖走首发后的补位另计）
    if (contender || champion) budget = Math.min(budget, Math.max(0, Math.ceil(c.contenderMaxChanges)));
    w.ctxs.set(team.id, {
      team,
      rank,
      sat,
      unhappy,
      contender,
      champion,
      budget,
      minGain: contender ? c.minGainContender : unhappy ? c.minGainUnhappy : c.minGainNormal,
      replaceOrder: budget > 0 ? replaceOrder(w, team) : [],
      vacancies: [],
      planned: budget,
      signed: 0,
      starSigned: false,
    });
  }
}

function addListing(
  w: World, p: Player, sellerId: string, reason: ShuffleReason, feeRange: readonly [number, number], wantsOut: boolean,
  bounds: { max?: number; min?: number } = {},
): void {
  if (w.listings.has(p.id)) return;
  const fee = roundFee(marketValue(w.state, p) * rangeOf(w.rng, feeRange));
  w.listings.set(p.id, { playerId: p.id, sellerId, reason, fee, wantsOut, maxBuyerRank: bounds.max, minBuyerRank: bounds.min });
}

/** 买家战力排名是否满足挂牌条件（明星只去更强 / 同档的队，老将只去更弱的队） */
function buyerRankOk(l: Listing, rank: number): boolean {
  if (l.maxBuyerRank !== undefined && rank > l.maxBuyerRank) return false;
  if (l.minBuyerRank !== undefined && rank < l.minBuyerRank) return false;
  return true;
}

/** 求变 / 低归属感 / 老将下放 / 甩卖：哪些 AI 选手本休赛期「可以买」 */
function buildListings(w: World): void {
  const c = S();
  const { state, rng } = w;
  const N = Math.max(2, w.nTeams);
  for (const ctx of w.ctxs.values()) {
    const team = ctx.team;
    const roster = regular(state, team.id);
    if (!roster.length) continue;
    const tPct = (ctx.rank - 1) / (N - 1);
    let bestId = '';
    let bestR = -Infinity;
    for (const p of roster) {
      const r = overallRating(p);
      if (r > bestR) {
        bestR = r;
        bestId = p.id;
      }
    }
    for (const p of roster) {
      const loyalty = effectiveAttr(p, 'loyalty');
      // 使命成员：各类挂牌概率 × missions.listMult（留人）
      const keepMult = isOwnMission(w, p, team.id) ? CONFIG.missions.listMult : 1;
      if (loyalty < CONFIG.loyalty.leaveThreshold) {
        if (rng.chance(c.lowLoyaltyLeaveChance * keepMult)) addListing(w, p, team.id, 'loyalty', c.feeLoyalty, true);
        continue;
      }
      const pos = starterPos(team, p.id);
      if (!pos) continue;
      const pPct = w.starterPct.get(p.id) ?? 1;
      const gap = tPct - pPct;
      const eligible = tierIndex(playerTier(p)) >= tierIndex(c.ambitionMinTier) || pPct <= c.ambitionTopShare;
      const tenure = Math.max(0, w.ti - (p.joinedSeason ?? w.ti));
      const coreSticky = Math.min(c.tenureMax, tenure * c.tenureStep);
      if (eligible && gap >= c.ambitionMinGap) {
        const loyalF = loyalty >= c.highLoyalty ? c.ambitionLoyalSticky : Math.max(0.2, 1.2 - loyalty / 100);
        const chance = c.ambitionChance
          * Math.min(1, c.ambitionFloor + (gap - c.ambitionMinGap) / Math.max(0.01, c.ambitionGapSpan))
          * (1 + c.ambitionUnhappyBoost * Math.max(0, -ctx.sat))
          * loyalF
          * (1 - coreSticky)
          * keepMult;
        if (rng.chance(chance)) {
          addListing(w, p, team.id, 'ambition', c.feeAmbition, true, { max: Math.max(1, ctx.rank - c.ambitionMinRankGain) });
          continue;
        }
      }
      // 强队（战力前 challengeTopRank）的明星：去同档的争冠队也算「新挑战」，否则只去更强的队
      const top = ctx.rank <= c.challengeTopRank;
      const starBuyers = { max: Math.max(1, ctx.rank - 1, top ? c.challengeBuyerRank : 0) };
      if (ctx.unhappy && pPct <= c.unhappyStarShare && rng.chance(c.unhappyStarChance * (1 - coreSticky) * keepMult)) {
        addListing(w, p, team.id, top ? 'challenge' : 'ambition', c.feeAmbition, true, starBuyers);
        continue;
      }
      // 豪门明星寻求新挑战（顶级战队之间的横向流动）：成绩不达预期、合同进入最后一年或长期效力后，可能转投其他争冠队
      if (top && w.stars.has(p.id)) {
        const chance = (c.challengeBase
          + c.challengeUnhappy * Math.max(0, -ctx.sat)
          + (p.contractUntil <= w.ti ? c.challengeContractBonus : 0)
          + Math.min(c.challengeTenureMax, c.challengeTenureStep * Math.max(0, tenure - c.challengeTenureFrom)))
          * (loyalty >= c.highLoyalty ? c.challengeLoyalMult : 1)
          * (ctx.champion ? c.challengeChampionMult : 1)
          * keepMult;
        if (rng.chance(chance)) {
          addListing(w, p, team.id, 'challenge', c.feeAmbition, true, starBuyers);
          continue;
        }
      }
      // 老将下放：只去战力更弱的队（二线队）
      if (ageOf(state, p) >= c.veteranAge && ctx.rank <= c.veteranTopRank && p.id !== bestId
        && rng.chance(c.veteranStepDownChance * keepMult)) {
        addListing(w, p, team.id, 'veteran', c.feeVeteran, false, { min: ctx.rank + 1 });
      }
    }
    // 欠薪：挂牌工资最高的首发
    if (team.gold < 0 && rng.chance(c.distressSellChance)) {
      let pick: Player | null = null;
      for (const p of roster) {
        if (!starterPos(team, p.id) || w.listings.has(p.id) || isOwnMission(w, p, team.id)) continue;
        if (!pick || p.salary > pick.salary) pick = p;
      }
      if (pick) addListing(w, pick, team.id, 'distress', c.feeDistress, false);
    }
  }
}

// ---------------------------------------------------------------------------
// 传闻
// ---------------------------------------------------------------------------

function rumorDate(w: World): string {
  const start = w.state.season?.startDate ?? w.state.currentDate;
  try {
    return addDays(start, -intOf(w.rng, S().rumorDaysBefore));
  } catch {
    return start;
  }
}

function postRumor(w: World, title: string, body: string, teamIds: (string | null)[], playerIds: string[]): void {
  const item = postNews(w.state, title, body, false, teamIds, playerIds, ['rumor', 'gossip']);
  item.date = rumorDate(w);
}

/** 休赛期初的传闻：部分来自真实的挂牌/换人计划，部分纯属捕风捉影 */
function postRumors(w: World): number {
  const c = S();
  const { state, rng } = w;
  let count = 0;
  type Item = { p: Player; kind: 'ambition' | 'challenge' | 'loyalty' | 'distress' | 'replace'; team: Team };
  const pool: Item[] = [];
  for (const l of w.listings.values()) {
    const p = state.players[l.playerId];
    const team = state.teams[l.sellerId];
    if (!p || !team || !isNotable(w, p)) continue;
    if (l.reason === 'ambition' || l.reason === 'challenge' || l.reason === 'loyalty' || l.reason === 'distress') {
      pool.push({ p, kind: l.reason, team });
    }
  }
  for (const ctx of w.ctxs.values()) {
    if (!ctx.unhappy || ctx.budget <= 0 || !ctx.replaceOrder.length || ctx.rank > c.rumorTeamRank) continue;
    const p = state.players[ctx.replaceOrder[0]];
    if (p && isNotable(w, p) && !w.listings.has(p.id)) pool.push({ p, kind: 'replace', team: ctx.team });
  }
  pool.sort((a, b) => overallRating(b.p) - overallRating(a.p) || (a.p.id < b.p.id ? -1 : 1));
  for (const it of pool.slice(0, Math.max(0, c.rumorTrueMax))) {
    const { p, team } = it;
    const label = `${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}`;
    if (it.kind === 'ambition') {
      postRumor(w, `【传闻】${p.handle} 有意离开 ${team.name}`,
        `据多方消息，${team.name} 的 ${p.handle}（${label}）希望在休赛期加盟更具竞争力的队伍，已有俱乐部与其接触。`, [team.id], [p.id]);
    } else if (it.kind === 'challenge') {
      postRumor(w, `【传闻】${p.handle} 或将离开 ${team.name}`,
        `据多方消息，${p.handle}（${label}）有意在休赛期离开 ${team.name}、寻求新的挑战，多支一线战队已表达兴趣。`, [team.id], [p.id]);
    } else if (it.kind === 'loyalty') {
      postRumor(w, `【传闻】${p.handle} 与 ${team.name} 关系疏远`,
        `${p.handle}（${label}）与俱乐部的关系持续降温，休赛期离队的可能性较大。`, [team.id], [p.id]);
    } else if (it.kind === 'distress') {
      postRumor(w, `【传闻】${team.name} 资金紧张，或出售 ${p.handle}`,
        `据悉 ${team.name} 账面吃紧，正在为 ${p.handle}（${label}）寻找买家以缓解财务压力。`, [team.id], [p.id]);
    } else {
      postRumor(w, `【传闻】${team.name} 计划调整阵容`,
        `据悉 ${team.name} 对上赛季的成绩并不满意，休赛期将对阵容做出调整，${p.handle}（${label}）的首发位置可能不保。`, [team.id], [p.id]);
    }
    w.rumored.add(p.id);
    count++;
  }
  // 假传闻：知名选手被「联系」到另一支强队
  const nFalse = intOf(rng, c.rumorFalse);
  const stars = [...w.stars]
    .map((id) => state.players[id])
    .filter((p): p is Player => !!p && !!p.teamId && !state.teams[p.teamId]?.isPlayer && !w.listings.has(p.id) && !w.rumored.has(p.id));
  const strong = [...w.ctxs.values()].filter((x) => x.rank <= c.rumorTeamRank);
  for (let i = 0; i < nFalse && stars.length && strong.length; i++) {
    const p = stars.splice(rng.int(0, stars.length - 1), 1)[0];
    const buyers = strong.filter((x) => x.team.id !== p.teamId);
    if (!buyers.length) continue;
    const buyer = rng.pick(buyers).team;
    const seller = state.teams[p.teamId!];
    postRumor(w, `【传闻】${buyer.name} 有意引进 ${p.handle}`,
      `有消息称 ${buyer.name} 正在关注 ${seller?.name ?? '原东家'} 的 ${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}），目前双方俱乐部均未回应。`,
      [buyer.id, p.teamId], [p.id]);
    w.rumored.add(p.id);
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// 解散 / 新组织（罕见）
// ---------------------------------------------------------------------------

function uniqueTeamId(state: GameState, name: string): string {
  const base = `org-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team'}`;
  if (!state.teams[base]) return base;
  let n = 2;
  while (state.teams[`${base}-${n}`]) n++;
  return `${base}-${n}`;
}

/** 新组织启动资金：联盟 AI 战队资金中位数 × U(newOrgFundsMedianMult) */
function newOrgFunds(w: World): number {
  const { state, rng } = w;
  const golds = activeTeams(state).filter((t) => !t.isPlayer).map((t) => t.gold).sort((a, b) => a - b);
  const median = golds.length ? golds[Math.floor(golds.length / 2)] : 0;
  const base = median > 0 ? median : rangeOf(rng, CONFIG.generation.aiTeam.funds.mid) * econ(state);
  return Math.round((base * rangeOf(rng, S().newOrgFundsMedianMult)) / 1000) * 1000;
}

function maybeDisband(w: World, report: ShuffleReport): void {
  const c = S();
  const { state, rng } = w;
  if (!(c.disbandChance > 0)) return;
  const cands: { ctx: TeamCtx; score: number; broke: boolean }[] = [];
  for (const ctx of w.ctxs.values()) {
    const t = ctx.team;
    if (t.isPlayer || t.disbanded || !regular(state, t.id).length) continue;
    const wage = Math.max(1, roundWageBill(state, t.id));
    const broke = t.gold < -c.disbandDebtWageRounds * wage;
    const lowHonor = t.honor <= c.disbandHonorMax;
    if (!broke && !lowHonor) continue;
    cands.push({ ctx, broke, score: (broke ? 1 : 0) + (lowHonor ? 1 : 0) - t.honor / 1000 + Math.min(0, t.gold / wage) / 100 });
  }
  if (!cands.length || !rng.chance(c.disbandChance)) return;
  cands.sort((a, b) => b.score - a.score || (a.ctx.team.id < b.ctx.team.id ? -1 : 1));
  const { ctx: oldCtx, broke } = cands[0];
  const old = oldCtx.team;
  const roster = regular(state, old.id).sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  const core = roster.slice(0, Math.min(roster.length, intOf(rng, c.disbandCoreCount)));
  const others = roster.slice(core.length);

  const { name, tag } = generateTeamName(state, old.region);
  const id = uniqueTeamId(state, name);
  const team: Team = {
    id,
    name,
    tag,
    region: old.region,
    color: colorFromId(id),
    honor: intOf(rng, c.newOrgHonor),
    gold: newOrgFunds(w),
    isPlayer: false,
    playerIds: [],
    lineup: { C: null, M: null, O: null, SS: null, HS: null },
    coachId: null,
    points: 0,
    lastSeasonRank: old.lastSeasonRank,
    founded: { ti: w.ti, kind: 'fictional' }, // 第十波 #2：DotaPedia 信息框显示成立赛季
  };
  state.teams[id] = team;

  for (const p of others) {
    departToFreeAgency(state, p.id);
    w.listings.delete(p.id);
    if (p.status === 'active' && !p.teamId) w.fa.push(p);
    w.movedIds.add(p.id);
    w.moves.push({ playerId: p.id, handle: p.handle, kind: 'release', fromTeamId: old.id, toTeamId: null, fee: 0, reason: 'disband', notable: isNotable(w, p) });
  }
  for (const p of core) {
    w.listings.delete(p.id);
    executeTransfer(state, p.id, team.id, 0, { contractSeasons: intOf(rng, [2, 3]), loyalty: signingLoyalty(0.6) });
    w.movedIds.add(p.id);
    w.moves.push({ playerId: p.id, handle: p.handle, kind: 'transfer', fromTeamId: old.id, toTeamId: team.id, fee: 0, reason: 'disband', notable: isNotable(w, p) });
  }
  const coach = old.coachId ? state.coaches[old.coachId] : undefined;
  if (coach) {
    coach.teamId = team.id;
    team.coachId = coach.id;
  }
  old.coachId = null;
  for (const pid of old.playerIds.slice()) {
    const p = state.players[pid];
    if (p) departToFreeAgency(state, pid);
  }
  old.playerIds = [];
  old.lineup = { C: null, M: null, O: null, SS: null, HS: null };
  old.disbanded = true;
  autoLineup(state, team.id);

  w.ctxs.delete(old.id);
  w.rankOf.set(team.id, oldCtx.rank);
  w.ctxs.set(team.id, {
    team,
    rank: oldCtx.rank,
    sat: 0,
    unhappy: false,
    contender: false,
    champion: false,
    budget: 0,
    minGain: c.minGainNormal,
    replaceOrder: [],
    vacancies: [],
    planned: 0,
    signed: 0,
    starSigned: false,
  });
  report.disbandedTeamId = old.id;
  report.newTeamId = team.id;

  const why = broke ? '长期入不敷出、资金链断裂' : '成绩低迷、赞助商相继撤资';
  const freed = others.map((p) => p.handle);
  postNews(
    state,
    `【解散】${old.name} 宣布解散`,
    `${old.name} 因${why}，在休赛期宣布解散。`
      + (freed.length ? `${freed.slice(0, 6).join('、')}${freed.length > 6 ? ' 等' : ''}成为自由选手。` : ''),
    true,
    [old.id],
    others.map((p) => p.id),
    ['disband'],
  );
  postNews(
    state,
    `【新军】${team.name} 成立`,
    `新组织 ${team.name}（${team.tag}）宣布成立，接手 ${old.name} 的核心选手 ${core.map((p) => p.handle).join('、') || '—'}`
      + `${coach ? `与主教练 ${coach.name}` : ''}，将以新身份征战 TI${w.ti} 赛季。`,
    true,
    [team.id, old.id],
    core.map((p) => p.id),
    ['disband'],
  );
}

// ---------------------------------------------------------------------------
// 市场
// ---------------------------------------------------------------------------

/**
 * 为 team 的 pos 位置找新援：挂牌选手 / 自由选手（含选秀落选的新秀）中评分最高者，均不满足时尝试挖角。
 * 门槛：挂牌与挖角 > base × (1 + gain)（AI 之间的零和流动）；自由选手 > base × (1 + max(gain, faMinGain))
 * （新增人才进入联盟，门槛更高，避免联盟整体实力逐季膨胀）；mandatory（空缺/无本职选手）时只需 > base。
 */
function findCandidate(
  w: World, ctx: TeamCtx, pos: Position, base: number, gain: number, mandatory: boolean, allowPoach: boolean,
): Candidate | null {
  const c = S();
  const { state, rng } = w;
  const team = ctx.team;
  const minWill = CONFIG.ai.minWillingness;
  const minRating = base * (1 + gain);
  const faMin = mandatory ? base : base * (1 + Math.max(gain, c.faMinGain));
  let best: Candidate | null = null;
  let bestScore = -Infinity;
  const consider = (p: Player, source: Candidate['source'], fee: number, reason: ShuffleReason, bonus: number) => {
    const r = overallRating(p);
    if (!(r > (source === 'listing' ? minRating : faMin))) return;
    const salary = computeSalary(state, p);
    if (!canAfford(state, team, fee, salary)) return;
    const will = playerWillingness(state, p.id, team.id) + bonus;
    if (will < minWill) return;
    let score = r * (1 + rng.range(0, c.pickNoise));
    if (ctx.unhappy && ageOf(state, p) <= c.youthAge) score *= 1 + c.youthBonus;
    if (score > bestScore) {
      bestScore = score;
      best = { p, source, fee, reason, will: clamp(will, 0, 1) };
    }
  };
  for (const l of w.listings.values()) {
    if (l.sellerId === team.id || !buyerRankOk(l, ctx.rank)) continue;
    const p = state.players[l.playerId];
    if (!p || p.status !== 'active' || p.teamId !== l.sellerId || p.position !== pos) continue;
    consider(p, 'listing', l.fee, l.reason, l.wantsOut ? c.wantsOutWillingnessBonus : 0);
  }
  for (const p of w.fa) {
    if (p.teamId || p.status !== 'active' || p.position !== pos) continue;
    consider(p, 'fa', signingFee(state, p), 'upgrade', 0);
  }
  if (best) return best;
  if (!allowPoach || ctx.rank > c.poachMaxBuyerRank) return null;

  // 挖角：强于卖家的队伍按评分从高到低尝试（最多 poachTries 名）
  const targets: Player[] = [];
  for (const other of w.ctxs.values()) {
    if (other.team.id === team.id || other.team.disbanded || other.rank <= ctx.rank) continue;
    for (const p of regular(state, other.team.id)) {
      if (p.position !== pos || w.movedIds.has(p.id) || w.listings.has(p.id)) continue;
      if (overallRating(p) > minRating) targets.push(p);
    }
  }
  targets.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  let tries = 0;
  for (const p of targets) {
    if (tries >= c.poachTries) break;
    const seller = w.ctxs.get(p.teamId ?? '');
    if (!seller) continue;
    const fee = roundFee(marketValue(state, p) * rangeOf(rng, c.poachFee));
    if (!canAfford(state, team, fee, computeSalary(state, p))) continue;
    const will = playerWillingness(state, p.id, team.id);
    if (will < minWill) continue;
    tries++;
    let sellerBest = true;
    const r = overallRating(p);
    for (const q of regular(state, seller.team.id)) if (q.id !== p.id && overallRating(q) > r) sellerBest = false;
    const accept = c.poachAccept
      + (seller.unhappy ? c.poachAcceptUnhappy : 0)
      - (sellerBest ? c.poachStarPenalty : 0)
      - (isOwnMission(w, p, seller.team.id) ? CONFIG.missions.poachPenalty : 0)
      + ((50 - effectiveAttr(p, 'loyalty')) / 100) * c.poachLoyaltyFactor;
    if (rng.chance(clamp(accept, 0, 1))) return { p, source: 'poach', fee, reason: 'poach', will };
  }
  return null;
}

/** AI 阵容满员时腾位：放走最弱的非首发（优先已挂牌的冗余选手） */
/**
 * AI 阵容满员时腾位：放走最弱的非首发（优先已挂牌的冗余选手）。本窗口刚引进的选手不放（避免刚签下就解约）；
 * 无人可放时返回 false（放弃这笔引援）。
 */
function makeRoom(w: World, team: Team, forMission = false): boolean {
  const { state } = w;
  // 俱乐部使命：使命成员最后才放；为引进使命成员腾位时也可以放走非使命首发（位置调整），阵容超员时连续腾位
  for (let guard = 0; guard < CONFIG.ai.maxRoster + 6; guard++) {
    const roster = regular(state, team.id);
    if (roster.length < CONFIG.ai.maxRoster) return true;
    const all = roster.filter((p) => !starterPos(team, p.id) && !w.movedIds.has(p.id));
    const nonMission = all.filter((p) => !isOwnMission(w, p, team.id));
    let bench = nonMission.length ? nonMission : all;
    if (forMission && !nonMission.length) {
      const starters = roster.filter((p) => !!starterPos(team, p.id) && !w.movedIds.has(p.id) && !isOwnMission(w, p, team.id));
      if (starters.length) bench = starters;
    }
    if (!bench.length) return false;
    bench.sort((a, b) => (w.listings.has(b.id) ? 1 : 0) - (w.listings.has(a.id) ? 1 : 0)
      || overallRating(a) - overallRating(b) || (a.id < b.id ? -1 : 1));
    releasePlayer(w, team, bench[0], 'surplus');
    if (!forMission) return regular(state, team.id).length < CONFIG.ai.maxRoster;
  }
  return regular(state, team.id).length < CONFIG.ai.maxRoster;
}

function releasePlayer(w: World, team: Team, p: Player, reason: ShuffleReason): void {
  const { state } = w;
  if (p.teamId !== team.id) return;
  const comp = Math.round(releaseCompensation(state, p.id) * S().releaseCompMult);
  if (comp > 0) addFinance(state, team.id, -comp, 'other', `解约补偿 ${p.handle}`);
  departToFreeAgency(state, p.id);
  w.listings.delete(p.id);
  if (p.status === 'active' && !p.teamId) w.fa.push(p);
  w.moves.push({ playerId: p.id, handle: p.handle, kind: 'release', fromTeamId: team.id, toTeamId: null, fee: 0, reason, notable: isNotable(w, p) });
}

/** 执行引援；返回是否成功（阵容满员且无人可放、或签约失败时为 false） */
function acquire(w: World, ctx: TeamCtx, cand: Candidate, replaced: Player | null): boolean {
  const { state, rng } = w;
  const team = ctx.team;
  const p = cand.p;
  if (!makeRoom(w, team, cand.reason === 'mission')) return false;
  const fromId = p.teamId;
  let move: ShuffleMove;
  if (cand.source === 'listing' || cand.source === 'poach') {
    const seller = fromId ? state.teams[fromId] : undefined;
    const sellerPos = seller ? starterPos(seller, p.id) : null;
    executeTransfer(state, p.id, team.id, cand.fee, {
      salary: computeSalary(state, p),
      contractSeasons: contractSeasons(rng),
      loyalty: signingLoyalty(cand.will),
    });
    if (p.teamId !== team.id) return false; // 防御：转会失败
    w.listings.delete(p.id);
    const sellerCtx = fromId ? w.ctxs.get(fromId) : undefined;
    if (sellerCtx && sellerPos) sellerCtx.vacancies.push(sellerPos);
    move = { playerId: p.id, handle: p.handle, kind: 'transfer', fromTeamId: fromId, toTeamId: team.id, fee: cand.fee, reason: cand.reason, notable: isNotable(w, p) };
  } else {
    const fee = signingFee(state, p);
    const last = p.lastTeamId ?? null;
    aiSignFreeAgent(state, team, p, w.fa);
    if (p.teamId !== team.id) return false;
    move = { playerId: p.id, handle: p.handle, kind: 'signing', fromTeamId: last && state.teams[last] ? last : null, toTeamId: team.id, fee, reason: cand.reason, notable: isNotable(w, p) };
  }
  w.moves.push(move);
  w.movedIds.add(p.id);
  ctx.signed += 1;
  autoLineup(state, team.id);
  // 被顶替的首发 → 冗余（挂牌，二线队可接手；老将另记）
  if (replaced && replaced.teamId === team.id && !starterPos(team, replaced.id) && !w.movedIds.has(replaced.id)) {
    const c = S();
    const veteran = ageOf(state, replaced) >= c.veteranAge;
    addListing(w, replaced, team.id, veteran ? 'veteran' : 'surplus', veteran ? c.feeVeteran : c.feeSurplus, true,
      veteran ? { min: ctx.rank + 1 } : {});
  }
  return true;
}

/** 本位置没有本职首发（空缺或由其他位置的选手客串） */
function needsNatural(w: World, team: Team, pos: Position): boolean {
  const s = starterAt(w.state, team, pos);
  if (s && s.position === pos) return false;
  // 阵中已有本职选手（autoLineup 会让他回到本位）
  return !regular(w.state, team.id).some((p) => p.position === pos);
}

function processTeam(w: World, ctx: TeamCtx, lastPass: boolean): boolean {
  const { state } = w;
  const team = ctx.team;
  if (team.disbanded) return false;
  let acted = false;
  // 1. 必需：空缺 / 无本职选手的位置
  for (const pos of POSITIONS) {
    if (!needsNatural(w, team, pos)) continue;
    const cur = starterAt(state, team, pos);
    const cand = findCandidate(w, ctx, pos, cur ? playerRating(cur, pos) : 0, 0, true, false);
    if (cand && acquire(w, ctx, cand, cur && cur.position === pos ? cur : null)) acted = true;
  }
  // 2. 被挖走首发的位置：在替补顶上后尝试补强（连锁转会）
  const vac = ctx.vacancies.splice(0);
  for (const pos of vac) {
    const cur = starterAt(state, team, pos);
    if (!cur || cur.position !== pos) continue; // 已在步骤 1 处理
    if (w.movedIds.has(cur.id)) continue; // 本窗口已引进新援补上（不再替换刚签下的选手）
    if (lineupPriorityLocks(state, team.id, cur, pos)) continue; // 首发优先级锁定（顶上的是使命 / 巅峰选手）：引进的人只会坐替补
    const cand = findCandidate(w, ctx, pos, playerRating(cur, pos), S().minGainNormal, false, true);
    if (cand && acquire(w, ctx, cand, cur)) {
      acted = true;
    } else if (!lastPass) {
      ctx.vacancies.push(pos);
    }
  }
  // 3. 主动换人
  let attempts = 0;
  for (const id of ctx.replaceOrder) {
    if (ctx.budget <= 0 || attempts > ctx.budget) break;
    const p = state.players[id];
    if (!p || p.teamId !== team.id) continue;
    const pos = starterPos(team, p.id);
    if (!pos) continue;
    if (lineupPriorityLocks(state, team.id, p, pos)) continue; // 使命 / 巅峰选手打本位置：autoLineup 仍会让他首发，不换
    attempts++;
    const cand = findCandidate(w, ctx, pos, playerRating(p, pos), ctx.minGain, false, true);
    if (!cand || !acquire(w, ctx, cand, p)) continue;
    ctx.budget -= 1;
    acted = true;
  }
  return acted;
}

/**
 * 俱乐部使命（第十波 #3，missions.ts）：明星去向之前，AI 使命俱乐部按战力排名先后引进缺失的使命成员（每队至多 missions.maxBuys.shuffle 名）。
 * 自由身 → 签下；其他 AI 战队 → 溢价求购（已挂牌的直接按挂牌成交，否则卖家按 missionSellChance 放人）；人类玩家战队的成员不在此处理（见 humanInterest 的报价）。
 * 同位置的非使命首发被顶下后挂牌（位置调整），卖家的空缺进入连锁补位。不受主动换人预算限制。
 */
function pursueMissions(w: World): void {
  if (!missionsEnabled()) return;
  const { state, rng } = w;
  const limit = Math.max(0, Math.floor(CONFIG.missions.maxBuys.shuffle ?? 0));
  if (limit <= 0) return;
  const minWill = CONFIG.ai.minWillingness;
  const order = [...w.ctxs.values()].sort((a, b) => a.rank - b.rank || (a.team.id < b.team.id ? -1 : 1));
  for (const ctx of order) {
    const team = ctx.team;
    if (team.disbanded || !missionInEffect(state, team.id)) continue;
    let bought = 0;
    for (const p of missionTargets(state, team.id)) {
      if (bought >= limit) break;
      if (p.teamId && w.movedIds.has(p.id)) continue; // 本窗口刚转会的选手不再搬动
      const listing = p.teamId ? w.listings.get(p.id) : undefined;
      const will = missionWillingness(state, p, team.id) + (listing?.wantsOut ? S().wantsOutWillingnessBonus : 0);
      if (will < minWill) continue;
      const salary = computeSalary(state, p);
      let cand: Candidate;
      if (!p.teamId) {
        const fee = signingFee(state, p);
        if (!missionCanAfford(state, team, fee, salary)) continue;
        cand = { p, source: 'fa', fee, reason: 'mission', will: clamp(will, 0, 1) };
      } else {
        const seller = w.ctxs.get(p.teamId);
        if (!seller || seller.team.disbanded) continue;
        const fee = listing ? Math.max(listing.fee, roundFee(marketValue(state, p))) : missionBidFee(state, p, rng);
        if (!missionCanAfford(state, team, fee, salary)) continue;
        if (!listing && !rng.chance(missionSellChance(state, p, seller.team.id))) continue;
        cand = { p, source: listing ? 'listing' : 'poach', fee, reason: 'mission', will: clamp(will, 0, 1) };
      }
      const cur = starterAt(state, team, p.position);
      const replaced = cur && cur.position === p.position && !isOwnMission(w, cur, team.id) ? cur : null;
      const before = w.moves.length;
      if (!acquire(w, ctx, cand, replaced)) continue;
      for (let i = before; i < w.moves.length; i++) if (w.moves[i].reason === 'mission') w.moves[i].notable = true;
      bought++;
    }
  }
}

/**
 * 明星去向（市场开始前）：求变 / 寻求新挑战的明星（联盟前 starTopN）由符合条件的买家争夺——
 * 买家战力排名满足挂牌条件、该位置首发评分 < 明星评分 / (1 + max(starMinGain, 买家门槛))、付得起、选手愿意；
 * 按「提升幅度 / √战力排名」加权随机挑选（强队与急需该位置的队更可能得手）。不受主动换人预算限制（每队至多一名），
 * 有预算的队扣 1 次。卖家的空缺进入连锁补位。
 */
function placeStars(w: World): void {
  const c = S();
  const { state, rng } = w;
  const minWill = CONFIG.ai.minWillingness;
  const listed = [...w.listings.values()]
    .filter((l) => l.wantsOut && (l.reason === 'ambition' || l.reason === 'challenge') && w.stars.has(l.playerId))
    .map((l) => ({ l, p: state.players[l.playerId] }))
    .filter((x): x is { l: Listing; p: Player } => !!x.p && x.p.status === 'active' && x.p.teamId === x.l.sellerId)
    .sort((a, b) => overallRating(b.p) - overallRating(a.p) || (a.p.id < b.p.id ? -1 : 1));
  for (const { l, p } of listed) {
    if (!w.listings.has(p.id) || p.teamId !== l.sellerId) continue;
    const r = overallRating(p);
    const salary = computeSalary(state, p);
    const opts: { ctx: TeamCtx; cur: Player | null; will: number; wt: number }[] = [];
    for (const ctx of w.ctxs.values()) {
      if (ctx.team.id === l.sellerId || ctx.team.disbanded || ctx.starSigned || !buyerRankOk(l, ctx.rank)) continue;
      const cur = starterAt(state, ctx.team, p.position);
      if (cur && w.movedIds.has(cur.id)) continue;
      if (lineupPriorityLocks(state, ctx.team.id, cur, p.position, p)) continue; // 该位置被首发优先级锁定，明星来了也只能坐替补
      const base = cur ? playerRating(cur, p.position) : 0;
      if (!(r > base * (1 + Math.max(c.starMinGain, ctx.minGain)))) continue;
      if (!canAfford(state, ctx.team, l.fee, salary)) continue;
      const will = playerWillingness(state, p.id, ctx.team.id) + c.wantsOutWillingnessBonus;
      if (will < minWill) continue;
      const gain = base > 0 ? r / base - 1 : 1;
      // 使命成员：本俱乐部更积极（权重 × missions.starWeightMult）
      const missionMult = isMissionPlayerOf(state, p.id, ctx.team.id) ? CONFIG.missions.starWeightMult : 1;
      opts.push({ ctx, cur, will, wt: ((gain + 0.05) / Math.sqrt(Math.max(1, ctx.rank))) * missionMult });
    }
    if (!opts.length) continue;
    const pick = rng.weighted(opts, opts.map((o) => o.wt));
    const replaced = pick.cur && pick.cur.position === p.position ? pick.cur : null;
    if (!acquire(w, pick.ctx, { p, source: 'listing', fee: l.fee, reason: l.reason, will: clamp(pick.will, 0, 1) }, replaced)) continue;
    pick.ctx.starSigned = true;
    if (pick.ctx.budget > 0) pick.ctx.budget -= 1;
  }
}

function runMarket(w: World): void {
  const order = [...w.ctxs.values()].sort((a, b) => a.rank - b.rank || (a.team.id < b.team.id ? -1 : 1));
  const passes = Math.max(1, S().passes);
  for (let pass = 0; pass < passes; pass++) {
    w.fa.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
    let progress = false;
    for (const ctx of order) {
      if (!w.ctxs.has(ctx.team.id)) continue;
      if (processTeam(w, ctx, pass === passes - 1)) progress = true;
    }
    if (!progress) break;
  }
}

/** market.fillRosterFromMarket（缺失位置优先；自由选手不够时生成新人）并记录变动，返回签入人数 */
function fillFromMarket(w: World, team: Team, target: number): number {
  const { state } = w;
  const pool = new Set(w.fa.map((p) => p.id));
  const signed = fillRosterFromMarket(state, team.id, target, w.fa);
  for (const p of signed) {
    w.movedIds.add(p.id);
    const fromFa = pool.has(p.id);
    const last = fromFa && p.lastTeamId && state.teams[p.lastTeamId] ? p.lastTeamId : null;
    w.moves.push({
      playerId: p.id, handle: p.handle, kind: 'signing', fromTeamId: last, toTeamId: team.id,
      fee: fromFa ? signingFee(state, p) : 0, reason: 'need', notable: isNotable(w, p),
    });
  }
  w.fa = w.fa.filter((p) => !p.teamId);
  return signed.length;
}

/** 收尾：冗余选手解约、阵容 5~7 人、五个位置都有本职选手、自动排阵 */
function cleanup(w: World): void {
  const { state } = w;
  const c = S();
  for (const ctx of w.ctxs.values()) {
    const team = ctx.team;
    if (team.disbanded) continue;
    // 未卖出的冗余首发：阵容偏大时解约
    for (const l of [...w.listings.values()]) {
      if (l.sellerId !== team.id || (l.reason !== 'surplus' && l.reason !== 'veteran')) continue;
      const p = state.players[l.playerId];
      if (!p || p.teamId !== team.id || starterPos(team, p.id) || isOwnMission(w, p, team.id)) continue;
      if (regular(state, team.id).length > c.keepRoster) releasePlayer(w, team, p, l.reason);
    }
    // 超员：先放走非使命替补（missions.missionAwareTrim），再按原规则裁剪
    for (const p of [...missionAwareTrim(state, team.id, CONFIG.ai.maxRoster), ...trimRoster(state, team.id, CONFIG.ai.maxRoster)]) {
      if (p.status === 'active' && !p.teamId) w.fa.push(p);
      w.moves.push({ playerId: p.id, handle: p.handle, kind: 'release', fromTeamId: team.id, toTeamId: null, fee: 0, reason: 'surplus', notable: isNotable(w, p) });
    }
    // 五个位置都要有本职选手
    for (let guard = 0; guard < POSITIONS.length; guard++) {
      const have = new Set(regular(state, team.id).map((p) => p.position));
      if (POSITIONS.every((pos) => have.has(pos))) break;
      const roster = regular(state, team.id);
      if (roster.length >= CONFIG.ai.maxRoster) {
        // 腾位：放走一名位置重复的最弱替补
        const counts = new Map<Position, number>();
        for (const p of roster) counts.set(p.position, (counts.get(p.position) ?? 0) + 1);
        const dup = roster
          .filter((p) => (counts.get(p.position) ?? 0) > 1 && !starterPos(team, p.id) && !isOwnMission(w, p, team.id))
          .sort((a, b) => (w.movedIds.has(a.id) ? 1 : 0) - (w.movedIds.has(b.id) ? 1 : 0)
            || overallRating(a) - overallRating(b) || (a.id < b.id ? -1 : 1))[0];
        if (!dup) break;
        releasePlayer(w, team, dup, 'surplus');
      }
      const signed = fillFromMarket(w, team, regular(state, team.id).length + 1);
      if (!signed) break;
    }
    if (regular(state, team.id).length < CONFIG.ai.minRoster) fillFromMarket(w, team, CONFIG.ai.minRoster);
    autoLineup(state, team.id);
  }
}

// ---------------------------------------------------------------------------
// 玩家战队：报价 / 离队申请（不直接搬走选手）
// ---------------------------------------------------------------------------

function persuadeChance(team: Team): number {
  const ev = CONFIG.events;
  return clamp(ev.leavePersuadeBase + honorLuck(team.honor) * ev.leavePersuadeLuck, 0.05, 0.95);
}

function humanInterest(w: World, report: ShuffleReport): void {
  const c = S();
  const { state, rng } = w;
  const pending = new Set((state.transferOffers ?? []).filter((o) => o.status === 'pending').map((o) => o.playerId));
  const buyers = [...w.ctxs.values()].filter((x) => !x.team.disbanded);
  for (const team of activeTeams(state)) {
    if (!team.isPlayer || team.disbanded) continue;
    const sat = w.sat.get(team.id)?.sat ?? 0;
    const roster = rng.shuffle(regular(state, team.id).filter((p) => !p.transferListing && !pending.has(p.id)));
    let offers = 0;
    for (const p of roster) {
      if (offers >= c.humanMaxOffers) break;
      const loyalty = effectiveAttr(p, 'loyalty');
      const chance = c.humanOfferChance * (c.humanOfferTierMult[playerTier(p)] ?? 1)
        * (1 + Math.max(0, -sat)) * (1 + (100 - loyalty) / 100);
      if (!rng.chance(chance)) continue;
      const value = marketValue(state, p);
      const fee = roundFee(value * rangeOf(rng, c.humanOfferFee));
      if (fee <= 0) continue;
      const r = overallRating(p);
      const salary = computeSalary(state, p);
      const fits = buyers.filter((b) => {
        const s = starterAt(state, b.team, p.position);
        return (!s || playerRating(s, p.position) < r * c.humanOfferFit) && canAfford(state, b.team, fee, salary)
          && !lineupPriorityLocks(state, b.team.id, s, p.position, p); // 首发优先级锁定的位置不求购（买来也只能坐替补）
      });
      if (!fits.length) continue;
      const buyer = rng.weighted(fits, fits.map((b) => 1 / b.rank)).team;
      const offer = createTransferOffer(state, p, buyer, fee, false);
      offers++;
      report.humanOffers++;
      const wants = loyalty < CONFIG.loyalty.leaveThreshold;
      postNews(
        state,
        `【报价】${buyer.name} 求购 ${p.handle}`,
        `转会窗口开启，${buyer.name} 开出 ${formatGold(offer.fee)} 求购 ${team.name} 的 ${p.handle}（身价约 ${formatGold(value)}），`
          + `并承诺工资 ${formatGold(offer.salary)}/回合。${wants ? `${p.handle} 归属感偏低，对这份报价颇为心动。` : ''}`
          + `请在 转会市场 → 报价 中回应（${CONFIG.market.offerExpireRounds} 回合内有效）。`,
        true,
        [team.id, buyer.id], [p.id], ['transfer'],
      );
    }
  }
  missionOffersToHumans(w, report);
  // 离队申请：只给当前座位（pendingDecisions 是座位私有字段；多人模式下其余座位在各自上下文中调用 offseasonLeaveRequests）
  report.humanLeaveRequests += offseasonLeaveRequests(state);
}

/**
 * 俱乐部使命（第十波 #3）：玩家战队里的使命成员只会收到报价（溢价，玩家在转会市场 → 报价中决定，可拒绝），从不强制带走。
 * 每支玩家战队每个休赛期至多 1 份使命报价，按 missions.humanOfferChance 出手。
 */
function missionOffersToHumans(w: World, report: ShuffleReport): void {
  if (!missionsEnabled()) return;
  const mc = CONFIG.missions;
  const { state, rng } = w;
  const pending = new Set((state.transferOffers ?? []).filter((o) => o.status === 'pending').map((o) => o.playerId));
  for (const team of activeTeams(state)) {
    if (!team.isPlayer || team.disbanded) continue;
    let sent = false;
    for (const p of regular(state, team.id)) {
      if (sent) break;
      if (p.transferListing || pending.has(p.id)) continue;
      for (const org of peakOrgsOfPlayer(p.id)) {
        const buyer = orgTeam(state, org);
        if (!buyer || buyer.id === team.id || !w.ctxs.has(buyer.id) || !missionInEffect(state, buyer.id)) continue;
        if (!rng.chance(mc.humanOfferChance)) continue;
        const [a, b] = mc.humanOfferFee;
        const value = marketValue(state, p);
        const fee = roundFee(value * rng.range(Math.min(a, b), Math.max(a, b)));
        if (fee <= 0 || !missionCanAfford(state, buyer, fee, computeSalary(state, p))) continue;
        const offer = createTransferOffer(state, p, buyer, fee, false);
        pending.add(p.id);
        report.humanOffers++;
        postNews(
          state,
          `【报价】${buyer.name} 求购 ${p.handle}`,
          `${buyer.name} 希望重组 TI${org.peak?.ti ?? ''} 巅峰阵容，开出 ${formatGold(offer.fee)} 求购 ${team.name} 的 ${p.handle}（身价约 ${formatGold(value)}），`
            + `并承诺工资 ${formatGold(offer.salary)}/回合。是否放人由你决定：请在 转会市场 → 报价 中回应（${CONFIG.market.offerExpireRounds} 回合内有效）。`,
          true,
          [team.id, buyer.id], [p.id], ['transfer', 'mission'],
        );
        sent = true;
        break;
      }
    }
  }
}

/** 联盟首发评分百分位（0 = 最强；全部未解散战队的首发） */
function starterPercentiles(state: GameState): Map<string, number> {
  const starters: Player[] = [];
  for (const t of activeTeams(state)) {
    for (const s of lineupPlayers(state, t.id)) if (s.player) starters.push(s.player);
  }
  starters.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  const out = new Map<string, number>();
  starters.forEach((p, i) => out.set(p.id, starters.length > 1 ? i / (starters.length - 1) : 0));
  return out;
}

/**
 * 休赛期离队申请（当前座位 settings.playerTeamId 的玩家战队）：等级 ≥ ambitionMinTier、归属感 < humanLeaveLoyalty、
 * 联盟首发百分位明显好于战队战力百分位的明星按 humanLeaveChance 提出 leave_request（与 events 的离队申请同一套选项：
 * 加薪挽留 / 尝试挽留 / 放行），每赛季至多 1 份。offseasonShuffle 会为当前座位调用；多人模式下由各座位在自己的上下文中调用。
 * 仅在第二个赛季起的季前（preseason 回合 0）生效。返回新增申请数。
 */
export function offseasonLeaveRequests(state: GameState): number {
  const c = S();
  if (!c?.enabled || state.gameOver || !state.season || state.phase !== 'preseason' || state.roundIndex !== 0) return 0;
  if (!(state.season.ti > (state.settings?.startTi ?? state.season.ti))) return 0;
  const team = state.teams[state.settings?.playerTeamId];
  if (!team || !team.isPlayer || team.disbanded) return 0;
  if (!Array.isArray(state.pendingDecisions)) state.pendingDecisions = [];
  if (state.pendingDecisions.some((d) => d.kind === 'leave_request' && d.ctx?.offseason === state.season.ti)) return 0;
  const rng = rngOf(state);
  const ranks = strengthRanks(state);
  const N = Math.max(2, ranks.size);
  const starterPct = starterPercentiles(state);
  const decided = new Set(state.pendingDecisions.map((d) => d.ctx?.playerId).filter((x): x is string => typeof x === 'string'));
  const tPct = ((ranks.get(team.id) ?? N) - 1) / (N - 1);
  for (const p of regular(state, team.id)) {
    if (decided.has(p.id) || p.transferListing) continue;
    const loyalty = effectiveAttr(p, 'loyalty');
    if (loyalty >= c.humanLeaveLoyalty || tierIndex(playerTier(p)) < tierIndex(c.ambitionMinTier)) continue;
    const pPct = starterPct.get(p.id);
    if (pPct === undefined || tPct - pPct < c.ambitionMinGap) continue;
    if (!rng.chance(c.humanLeaveChance)) continue;
    const ev = CONFIG.events;
    const raised = Math.round(p.salary * ev.leaveRaiseSalaryMult);
    const pc = Math.round(persuadeChance(team) * 100);
    state.pendingDecisions.push({
      id: nextId(state, 'd'),
      kind: 'leave_request',
      title: `【离队申请】${p.handle} 希望转投更强的队伍`,
      body:
        `转会窗口开启，${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）认为球队的竞争力配不上自己的水平，希望在休赛期离队。（归属感 ${Math.round(loyalty)}）\n`
        + `· 加薪挽留：工资 ${formatGold(p.salary)} → ${formatGold(raised)}/回合，归属感 +${ev.leaveRaiseLoyalty}。\n`
        + `· 尝试挽留：成功率约 ${pc}%（取决于俱乐部荣誉），失败则以自由身离队。\n· 放行：以自由身离队。`,
      choices: [
        { id: 'raise', label: '加薪挽留', description: `工资 +${Math.round((ev.leaveRaiseSalaryMult - 1) * 100)}%，必定留下` },
        { id: 'persuade', label: '尝试挽留', description: `成功率约 ${pc}%，失败则离队` },
        { id: 'allow', label: '放行', description: '以自由身离队' },
      ],
      ctx: { playerId: p.id, offseason: state.season.ti },
      createdRound: state.roundIndex,
      blocking: true,
    });
    postNews(
      state,
      `【离队申请】${p.handle} 希望离开 ${team.name}`,
      `${p.handle} 向俱乐部提交了离队申请，希望在休赛期加盟更具竞争力的队伍。请在消息中心做出决定。`,
      true,
      [team.id], [p.id], ['transfer'],
    );
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 新闻
// ---------------------------------------------------------------------------

const REASON_NOTE: Partial<Record<ShuffleReason, (h: string, from: string) => string>> = {
  ambition: (h) => `此前 ${h} 明确表示希望加盟更具竞争力的队伍。`,
  challenge: (h, from) => `${h} 选择离开 ${from}，寻求新的挑战。`,
  loyalty: (h, from) => `${h} 与 ${from} 的关系早已疏远。`,
  veteran: (h) => `老将 ${h} 转投新东家，寻求更多上场时间。`,
  surplus: (h, from) => `${h} 在 ${from} 失去了首发位置。`,
  distress: (_h, from) => `${from} 因资金紧张出售选手。`,
  poach: (_h, from) => `买家开出高于身价的转会费，${from} 最终放人。`,
  disband: (h, from) => `${from} 解散后，${h} 随核心班底加盟新组织。`,
  mission: (h) => `${h} 是新东家现实巅峰阵容的成员，引进他是俱乐部使命的一部分。`,
};

function moveNews(w: World, m: ShuffleMove): void {
  const { state } = w;
  const p = state.players[m.playerId];
  if (!p) return;
  const label = `${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}`;
  const from = teamNameOf(state, m.fromTeamId);
  const to = teamNameOf(state, m.toTeamId);
  const rumor = w.rumored.has(p.id) ? '此前的转会传闻得到证实。' : '';
  const note = REASON_NOTE[m.reason]?.(p.handle, from) ?? '';
  let title: string;
  let body: string;
  if (m.kind === 'transfer') {
    title = `【转会】${p.handle} 从 ${from} 加盟 ${to}`;
    body = m.fee > 0
      ? `${to} 以 ${formatGold(m.fee)} 的转会费从 ${from} 签下 ${p.handle}（${label}），合同至 TI${p.contractUntil}。${note}${rumor}`
      : `${p.handle}（${label}）从 ${from} 加盟 ${to}，合同至 TI${p.contractUntil}。${note}${rumor}`;
  } else if (m.kind === 'signing') {
    title = `【签约】${to} 签下 ${p.handle}`;
    body = `${to} 签下自由选手 ${p.handle}（${label}）${m.fee > 0 ? `，签字费 ${formatGold(m.fee)}` : ''}，合同至 TI${p.contractUntil}。`
      + `${m.fromTeamId ? `${p.handle} 曾效力于 ${from}。` : ''}${rumor}`;
  } else {
    title = `【离队】${p.handle} 离开 ${from}`;
    body = m.reason === 'disband'
      ? `${from} 解散，${p.handle}（${label}）成为自由选手。`
      : `${from} 与 ${p.handle}（${label}）解约，后者成为自由选手。${note}`;
  }
  const big = m.kind === 'transfer' && (tierIndex(playerTier(p)) >= tierIndex('SS') || m.fee >= S().bigTransferFee * econ(state));
  const important = big || w.stars.has(p.id);
  postNews(state, title, body, important, [m.toTeamId, m.fromTeamId], [p.id], big ? ['transfer', 'big-transfer'] : ['transfer']);
}

function summaryNews(w: World, report: ShuffleReport): void {
  const { state } = w;
  const moves = report.moves;
  const transfers = moves.filter((m) => m.kind === 'transfer');
  const signings = moves.filter((m) => m.kind === 'signing');
  const releases = moves.filter((m) => m.kind === 'release');
  const totalFee = transfers.reduce((a, m) => a + m.fee, 0);
  const lines: string[] = [];
  lines.push(
    `TI${w.ti - 1} 落幕后的休赛期共发生 ${moves.length} 笔人员变动：转会 ${transfers.length} 笔（总转会费 ${formatGold(totalFee)}）、`
      + `签约自由选手 ${signings.length} 人、离队 ${releases.length} 人。`,
  );
  if (report.disbandedTeamId) {
    lines.push(`${teamNameOf(state, report.disbandedTeamId)} 宣布解散，${teamNameOf(state, report.newTeamId)} 接手其核心选手。`);
  }
  const tierOf = (m: ShuffleMove) => {
    const p = state.players[m.playerId];
    return p ? playerTier(p) : '?';
  };
  if (transfers.length) {
    lines.push('', '【转会】');
    for (const m of transfers) {
      lines.push(`· ${m.handle}（${tierOf(m)}）：${teamNameOf(state, m.fromTeamId)} → ${teamNameOf(state, m.toTeamId)}${m.fee > 0 ? `，${formatGold(m.fee)}` : ''}`);
    }
  }
  if (signings.length) {
    lines.push('', '【签约】');
    for (const m of signings) {
      lines.push(`· ${m.handle}（${tierOf(m)}${state.players[m.playerId]?.isRookie ? ' · 新秀' : ''}）→ ${teamNameOf(state, m.toTeamId)}`);
    }
  }
  if (releases.length) {
    lines.push('', '【离队】');
    for (const m of releases) lines.push(`· ${m.handle}（${tierOf(m)}）：离开 ${teamNameOf(state, m.fromTeamId)}`);
  }
  const teamIds = new Set<string>();
  for (const m of moves) {
    if (m.fromTeamId) teamIds.add(m.fromTeamId);
    if (m.toTeamId) teamIds.add(m.toTeamId);
  }
  postNews(
    state,
    '【转会窗口】本届休赛期转会汇总',
    lines.join('\n'),
    true,
    [...teamIds],
    moves.filter((m) => m.notable).map((m) => m.playerId),
    ['transfer', 'transfer-window'],
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 休赛期转会潮。由 season.startSeason 在新秀选秀 / 自由选手刷新之后、AI 赛季初转会窗口与赛程生成之前调用；
 * 新游戏的第一个赛季（season.ti ≤ settings.startTi）不触发（保留真实初始阵容）。
 * 流程：满意度与换人预算 → 挂牌（求变 / 新挑战 / 低归属感 / 老将 / 甩卖）→ 传闻 → 罕见解散 → 明星去向 → 多轮市场 → 收尾
 * → 玩家战队报价（全部 isPlayer 战队）与离队申请（当前座位；多人模式下其余座位各自调用 offseasonLeaveRequests）→ 新闻。
 * 返回本次转会汇总（未触发时 null）。
 */
export function offseasonShuffle(state: GameState): ShuffleReport | null {
  const c = S();
  if (!c?.enabled || state.gameOver || !state.season) return null;
  const ti = state.season.ti;
  if (!(ti > (state.settings?.startTi ?? ti))) return null;
  const rng = rngOf(state);
  const rankOf = strengthRanks(state);

  // 联盟首发评分百分位（明星求变）与明星名单
  const starterPct = starterPercentiles(state);
  const stars = new Set<string>();
  const ranked = Object.values(state.players)
    .filter((p) => p.status === 'active' && !p.isWildSub && !p.tempSubUntilTournament)
    .sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  for (const p of ranked.slice(0, Math.max(0, c.starTopN))) stars.add(p.id);

  const w: World = {
    state,
    rng,
    ti,
    nTeams: rankOf.size,
    ctxs: new Map(),
    rankOf,
    listings: new Map(),
    fa: freeAgents(state),
    moves: [],
    movedIds: new Set(),
    stars,
    rumored: new Set(),
    starterPct,
    sat: satisfactionMap(state, rankOf),
  };
  const report: ShuffleReport = {
    ti, moves: w.moves, rumors: 0, disbandedTeamId: null, newTeamId: null, humanOffers: 0, humanLeaveRequests: 0, teams: [],
  };

  buildContexts(w);
  buildListings(w);
  report.rumors = postRumors(w);
  maybeDisband(w, report);
  pursueMissions(w);
  placeStars(w);
  runMarket(w);
  cleanup(w);
  humanInterest(w, report);
  for (const x of w.ctxs.values()) {
    report.teams.push({ teamId: x.team.id, rank: x.rank, satisfaction: Math.round(x.sat * 100) / 100, planned: x.planned, signed: x.signed });
  }
  report.teams.sort((a, b) => a.rank - b.rank);

  // 逐条新闻（知名选手，按等级/转会费排序，上限 maxMoveNews）→ 汇总。
  // 被解约后在本窗口又加盟新队的选手只发加盟新闻（签约新闻会注明其前东家），不重复发离队新闻
  const joined = new Set(w.moves.filter((m) => m.kind !== 'release' && m.toTeamId).map((m) => m.playerId));
  const notable = w.moves
    .filter((m) => m.notable && m.reason !== 'disband' && !(m.kind === 'release' && joined.has(m.playerId)))
    .map((m) => {
      const p = state.players[m.playerId];
      return { m, k: (p ? tierIndex(playerTier(p)) : 0) * 1e9 + m.fee };
    })
    .sort((a, b) => b.k - a.k)
    .slice(0, Math.max(0, c.maxMoveNews))
    .map((x) => x.m);
  const keep = new Set(notable);
  for (const m of w.moves) if (keep.has(m)) moveNews(w, m);
  if (w.moves.length) summaryNews(w, report);
  // 俱乐部使命的进度在紧随其后的 AI 季前窗口（ai.aiTransferWindow）结束时统一刷新（missions.refreshMissions）：
  // 转会潮与季前窗口是同一个休赛期窗口，只在窗口结束时判定「集齐」，避免成员在两段之间离队又被买回时误发「再次集齐」新闻
  return report;
}
