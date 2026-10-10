// 赛事赛制、推进与结算【E3 负责实现】
//
// 设计要点：
// - 赛事由若干 stage 组成：[qualifier 封闭预选(单败)] → [groups 小组循环] → [playoffs 单败/双败]。
//   所有 stage 外壳在 initTournamentStages 时创建；系列赛在该阶段「激活」时（上一阶段完成后）生成。
// - 淘汰赛先构建抽象对阵树（含轮空），再静态判定哪些节点是真实比赛、哪些是轮空直通，
//   只为真实比赛生成 Series，并把 winnerTo/loserTo 穿透轮空节点直接连到下一场真实比赛。
//   这样任意 2..24 队的单败/双败都不需要运行时处理轮空，名次区间也天然连续。
// - 名次：被淘汰时即写入 t.placements（奖金/积分在 finishTournament 中计算）。
//   正赛名次 1..N，小组淘汰者排在淘汰赛之后，封闭预选淘汰者排在全部正赛队之后。
import type {
  GameRecord, GameState, GroupStanding, Series, SeriesResult, Stage, Tournament, TournamentFormatPreset,
  TournamentSettlement, TournamentTier,
} from './types';
import { CONFIG } from './config';
import { rngOf } from './rng';
import { formatGold, formatRank, placementPercentile } from './util';
import { simulateSeries, applySeriesLoyalty } from './match';
import { applyBeefResult, applyHonorChange, computeHonorBreakdown, expectationScore } from './honor';
import { addFinance } from './economy';
import { awardedPrize, qualifierAppearanceFee, tournamentAppearanceFee } from './revenue';
import { payTournamentPrize, prizeSplitText } from './prizeShare';
import { applyTournamentGrowth, adjustLoyalty } from './growth';
import { releaseTempSubs } from './market';
import { addNews, pushPopup } from './news';
import { reportTiGroupStage, reportTournamentResult, reportTournamentUpsets } from './newsroom';
import { activeHumanIds, humanTeamIds, isMultiplayer, withSeat } from './seat';
import { recordPrizeSplit, recordSeriesStats, recordTournamentStats } from './stats';

// ===========================================================================
// 通用小工具
// ===========================================================================

function uniq(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function playerTeamId(state: GameState): string {
  return state.settings?.playerTeamId ?? '';
}

/**
 * 玩家战队集合：单机 = {settings.playerTeamId}；多人 = 仍在比赛中的全部座位（未出局、未解散）。
 * 用于「赛事自动推进在任一玩家的系列赛就绪时停下」。
 */
function humanSet(state: GameState): Set<string> {
  if (!isMultiplayer(state)) return new Set([playerTeamId(state)]);
  return new Set(activeHumanIds(state));
}

function teamName(state: GameState, id: string | null | undefined): string {
  if (!id) return '待定';
  return state.teams[id]?.name ?? id;
}

/** 标准种子对阵顺序（0 起）：size=8 → [0,7,3,4,1,6,2,5]，即 1v8、4v5、2v7、3v6 */
export function standardBracketOrder(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const n = order.length * 2;
    const next: number[] = [];
    for (const x of order) next.push(x, n - 1 - x);
    order = next;
  }
  return order;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function isBigFinal(tier: TournamentTier): boolean {
  return (CONFIG.tournament.bigFinalTiers as readonly TournamentTier[]).includes(tier);
}

function allStagesDone(t: Tournament): boolean {
  return t.stages.every((s) => s.done);
}

/** 当前进行中的阶段（第一个未完成阶段） */
function currentStageIndex(t: Tournament): number {
  return t.stages.findIndex((s) => !s.done);
}

function hasPlacement(t: Tournament, teamId: string): boolean {
  return t.placements.some((p) => p.teamId === teamId);
}

function addPlacement(t: Tournament, teamId: string, range: [number, number]): void {
  if (!teamId || hasPlacement(t, teamId)) return;
  t.placements.push({ teamId, rankFrom: range[0], rankTo: range[1], prize: 0, points: 0 });
}

/** 按赛前预期（或实时评分）给队伍排种子：强 → 弱 */
function seedOrder(state: GameState, t: Tournament, ids: string[]): string[] {
  const exp = t.expectedRanks ?? {};
  const score = new Map<string, number>();
  for (const id of ids) if (exp[id] === undefined) score.set(id, expectationScore(state, id));
  return ids.slice().sort((a, b) => {
    const ea = exp[a];
    const eb = exp[b];
    if (ea !== undefined && eb !== undefined && ea !== eb) return ea - eb;
    if (ea !== undefined && eb === undefined) return -1;
    if (ea === undefined && eb !== undefined) return 1;
    return (score.get(b) ?? 0) - (score.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  });
}

// ===========================================================================
// 赛制规划
// ===========================================================================

interface MainPlan {
  groups?: { count: number; ubPerGroup: number; lbPerGroup: number };
  playoffs?: { format: 'se' | 'de' };
}

/** 依据赛制与正赛队伍数 N 规划阶段（确定性，激活下一阶段时会再次调用） */
function mainPlan(format: TournamentFormatPreset, n: number): MainPlan {
  if (n < 2) return {};
  switch (format) {
    case 'se8':
      return { playoffs: { format: 'se' } };
    case 'de8':
      return { playoffs: { format: n >= 4 ? 'de' : 'se' } };
    case 'rr':
      return { groups: { count: 1, ubPerGroup: 0, lbPerGroup: 0 } };
    default: {
      const isTi = format === 'ti';
      let count: number;
      if (isTi) count = n <= 8 ? 1 : 2;
      else if (format === 'gsl_de8') count = n < 6 ? 1 : n <= 16 ? 2 : 4;
      else count = n <= 8 ? 1 : n <= 16 ? 2 : 4;
      let ub: number;
      let lb: number;
      if (isTi && n >= 16) { ub = 8; lb = 8; } else if (isTi && n >= 8) { ub = 4; lb = 4; } else {
        ub = n > 8 ? 8 : n > 4 ? 4 : 2;
        lb = 0;
      }
      const minGroup = Math.floor(n / count);
      let ubPer = Math.min(Math.floor(ub / count), minGroup);
      let lbPer = Math.min(Math.floor(lb / count), Math.max(0, minGroup - ubPer));
      if (ubPer < 1) ubPer = 1;
      // 败者组直通名额必须与胜者组规模一致，否则退化为普通双败
      if (lbPer !== ubPer) lbPer = 0;
      const total = (ubPer + lbPer) * count;
      const pFormat: 'se' | 'de' = format === 'groups_se' || total < 4 ? 'se' : 'de';
      return { groups: { count, ubPerGroup: ubPer, lbPerGroup: lbPer }, playoffs: { format: pFormat } };
    }
  }
}

function groupBestOf(t: Tournament, groupSize: number): 1 | 2 {
  const bo = CONFIG.tournament.bestOf;
  if (t.format !== 'ti' && groupSize >= CONFIG.tournament.groupBo1MinSize) return bo.groupsLarge as 1 | 2;
  return bo.groups as 1 | 2;
}

function makeStage(t: Tournament, idx: number, type: Stage['type'], format: Stage['format'], name: string): Stage {
  return { id: `${t.id}-st${idx}`, type, format, name, teamIds: [], seriesIds: [], done: false };
}

// ===========================================================================
// 初始化
// ===========================================================================

/**
 * 依据 format 与 teamIds（及 qualifierTeamIds）建立 stages 与 series：
 * - 若 qualifierTeamIds 非空：首个 stage 为 'qualifier'（单败，取 CONFIG.tournament.qualifierSlotsPerEvent 名晋级，晋级者加入正赛）
 * - 'se8' 单败（非 2 的幂用轮空），'de8' 双败，'groups_de'/'groups_se' 小组循环→淘汰赛（8 或 4 队），
 *   'rr' 单循环，'ti' 两组循环 Bo2 → 每组前 4 进胜者组、5-8 进败者组首轮(Bo1)、其余淘汰。
 * - Bo 数：小组 Bo2（组内 ≥7 队且非 TI 时 Bo1）；淘汰赛 Bo3；总决赛 Bo5（tier ti/major），其余 Bo3；预选 Bo1/Bo3。
 * - 淘汰赛 series 设置 winnerTo/loserTo/loserPlacement；小组淘汰者按组内名次给出名次区间。
 * 正赛阶段在前一阶段 done 后才填充队伍（预选/小组晋级）。
 */
export function initTournamentStages(state: GameState, tournamentId: string): void {
  const t = state.tournaments[tournamentId];
  if (!t) return;
  t.stages = [];
  t.series = {};
  t.placements = [];
  t.status = 'running';
  t.appearanceFee = tournamentAppearanceFee(state, t); // 开赛即按等级确定出场费（赛事中心展示实际发放额）

  let direct = uniq((t.teamIds ?? []).filter((id) => !!state.teams[id]));
  let quals = uniq((t.qualifierTeamIds ?? []).filter((id) => !!state.teams[id])).filter((id) => !direct.includes(id));
  const slots = Math.max(1, Math.floor(t.qualifierSlots || CONFIG.tournament.qualifierSlotsPerEvent));
  if (quals.length > 0 && quals.length <= slots) {
    // 预选队伍不超过名额：全部直接晋级，无需预选
    direct = direct.concat(quals);
    quals = [];
  }
  t.teamIds = direct;
  t.qualifierTeamIds = quals;
  t.qualifierSlots = quals.length > 0 ? slots : 0;
  const n = direct.length + (quals.length > 0 ? slots : 0);
  t.size = n;

  const plan = mainPlan(t.format, n);
  let idx = 0;
  if (quals.length > 0) t.stages.push(makeStage(t, idx++, 'qualifier', 'se', '封闭预选赛'));
  if (plan.groups) {
    t.stages.push(makeStage(t, idx++, 'groups', 'rr', plan.playoffs ? '小组赛' : (t.format === 'rr' ? '联赛' : '循环赛')));
  }
  if (plan.playoffs) {
    const de = plan.playoffs.format === 'de';
    t.stages.push(makeStage(t, idx++, 'playoffs', plan.playoffs.format, de ? '双败淘汰赛' : '单败淘汰赛'));
  }

  if (t.stages.length === 0) {
    // 不足 2 队：唯一队伍直接夺冠（若有）
    if (direct.length === 1) addPlacement(t, direct[0], [1, 1]);
    return;
  }
  activateStage(state, t, 0);
}

// ===========================================================================
// 阶段激活
// ===========================================================================

function activateStage(state: GameState, t: Tournament, idx: number): void {
  const stage = t.stages[idx];
  if (!stage) return;
  stage.done = false;
  stage.seriesIds = [];
  stage.advancedTeamIds = [];
  const n = t.size ?? t.teamIds.length;

  if (stage.type === 'qualifier') {
    const seeds = seedOrder(state, t, t.qualifierTeamIds);
    const slots = Math.max(1, t.qualifierSlots || CONFIG.tournament.qualifierSlotsPerEvent);
    stage.teamIds = seeds.slice();
    stage.advanceCount = slots;
    const losers = Math.max(0, seeds.length - slots);
    buildBracket(state, t, stage, idx, { format: 'se', seeds, lbSeeds: [], brackets: slots, rankBottom: n + losers, qualifier: true });
  } else if (stage.type === 'groups') {
    const plan = mainPlan(t.format, n).groups ?? { count: 1, ubPerGroup: 0, lbPerGroup: 0 };
    const seeds = seedOrder(state, t, t.teamIds);
    stage.teamIds = seeds.slice();
    stage.advanceCount = plan.ubPerGroup + plan.lbPerGroup;
    buildGroups(t, stage, idx, seeds, plan.count);
  } else {
    const plan = mainPlan(t.format, n);
    const format = plan.playoffs?.format ?? 'se';
    const prev = idx > 0 ? t.stages[idx - 1] : null;
    let ub: string[];
    let lb: string[] = [];
    if (prev && prev.type === 'groups' && plan.groups) {
      const ent = groupEntrants(prev, plan.groups.ubPerGroup, plan.groups.lbPerGroup);
      ub = ent.ub;
      lb = ent.lb;
    } else {
      ub = seedOrder(state, t, t.teamIds);
    }
    stage.teamIds = [...ub, ...lb];
    const useDe = format === 'de' && ub.length + lb.length >= 4;
    buildBracket(state, t, stage, idx, {
      format: useDe ? 'de' : 'se',
      seeds: useDe ? ub : [...ub, ...lb],
      lbSeeds: useDe ? lb : [],
      brackets: 1,
      rankBottom: ub.length + lb.length,
      qualifier: false,
    });
  }

  if (!stage.seriesIds.some((id) => !t.series[id]?.result)) completeStage(state, t, idx);
}

/** 小组 → 淘汰赛：按组内名次交错排种子（A1,B1,A2,B2,…），前 ub 名进胜者组，随后 lb 名进败者组首轮 */
function groupEntrants(stage: Stage, ubPer: number, lbPer: number): { ub: string[]; lb: string[] } {
  const groups = stage.groups ?? [];
  const ub: string[] = [];
  const lb: string[] = [];
  for (let pos = 0; pos < ubPer + lbPer; pos++) {
    for (const g of groups) {
      const row = g.standings[pos];
      if (!row) continue;
      (pos < ubPer ? ub : lb).push(row.teamId);
    }
  }
  return { ub, lb };
}

// ===========================================================================
// 小组循环
// ===========================================================================

const GROUP_NAMES = 'ABCDEFGH';

function blankStanding(teamId: string): GroupStanding {
  return { teamId, wins: 0, draws: 0, losses: 0, gameWins: 0, gameLosses: 0 };
}

function buildGroups(t: Tournament, stage: Stage, stageIdx: number, seeds: string[], groupCount: number): void {
  const count = Math.max(1, Math.min(groupCount, Math.floor(seeds.length / 2) || 1));
  const members: string[][] = Array.from({ length: count }, () => []);
  // 蛇形分组：1→A 2→B 3→B 4→A …
  seeds.forEach((id, i) => {
    const row = Math.floor(i / count);
    const col = row % 2 === 0 ? i % count : count - 1 - (i % count);
    members[col].push(id);
  });
  const single = count === 1;
  stage.groups = members.map((ids, gi) => ({
    name: single ? (t.format === 'rr' ? '联赛' : '小组') : GROUP_NAMES[gi] ?? String(gi + 1),
    teamIds: ids.slice(),
    standings: ids.map(blankStanding),
  }));
  let serial = 0;
  stage.groups.forEach((g) => {
    const bo = groupBestOf(t, g.teamIds.length);
    const prefix = single ? '' : `${g.name}组 `;
    for (const [r, a, b] of roundRobinPairs(g.teamIds)) {
      const id = `${t.id}-s${stageIdx}-${serial++}`;
      t.series[id] = {
        id, tournamentId: t.id, stageId: stage.id, label: `${prefix}第${r}轮`,
        teamA: a, teamB: b, bestOf: bo, round: r,
      };
      stage.seriesIds.push(id);
    }
  });
}

/** 圆圈法单循环：返回 [轮次(1 起), A, B] */
function roundRobinPairs(ids: string[]): [number, string, string][] {
  const arr: (string | null)[] = ids.slice();
  if (arr.length < 2) return [];
  if (arr.length % 2 === 1) arr.push(null);
  const m = arr.length;
  const out: [number, string, string][] = [];
  for (let r = 0; r < m - 1; r++) {
    for (let i = 0; i < m / 2; i++) {
      const a = arr[i];
      const b = arr[m - 1 - i];
      if (a && b) out.push(r % 2 === 0 ? [r + 1, a, b] : [r + 1, b, a]);
    }
    // 第一位固定，其余顺时针旋转
    const last = arr.pop() as string | null;
    arr.splice(1, 0, last);
  }
  return out;
}

const groupPoints = (s: GroupStanding) =>
  s.wins * CONFIG.tournament.groupPointsWin + s.draws * CONFIG.tournament.groupPointsDraw;
const gameDiff = (s: GroupStanding) => s.gameWins - s.gameLosses;

/** 展示用排序（不消耗随机数）：积分 → 小局净胜 → 小局胜 → id */
function sortStandingsForDisplay(rows: GroupStanding[]): void {
  rows.sort((a, b) => groupPoints(b) - groupPoints(a) || gameDiff(b) - gameDiff(a)
    || b.gameWins - a.gameWins || (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
}

/** 最终排序：积分 → 小局净胜 → 相互战绩 → 种子随机（rngOf） */
function finalizeGroupOrder(state: GameState, t: Tournament, stage: Stage, rows: GroupStanding[]): GroupStanding[] {
  const sorted = rows.slice().sort((a, b) => groupPoints(b) - groupPoints(a) || gameDiff(b) - gameDiff(a));
  const out: GroupStanding[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && groupPoints(sorted[j]) === groupPoints(sorted[i]) && gameDiff(sorted[j]) === gameDiff(sorted[i])) j++;
    const tie = sorted.slice(i, j);
    if (tie.length > 1) {
      const set = new Set(tie.map((s) => s.teamId));
      const h2h = new Map<string, number>();
      for (const sid of stage.seriesIds) {
        const s = t.series[sid];
        const res = s?.result;
        if (!s || !res || !s.teamA || !s.teamB || !set.has(s.teamA) || !set.has(s.teamB)) continue;
        if (res.scoreA === res.scoreB) {
          h2h.set(s.teamA, (h2h.get(s.teamA) ?? 0) + CONFIG.tournament.groupPointsDraw);
          h2h.set(s.teamB, (h2h.get(s.teamB) ?? 0) + CONFIG.tournament.groupPointsDraw);
        } else {
          h2h.set(res.winnerId, (h2h.get(res.winnerId) ?? 0) + CONFIG.tournament.groupPointsWin);
        }
      }
      const rng = rngOf(state);
      const key = new Map<string, number>();
      for (const s of tie) key.set(s.teamId, rng.next());
      tie.sort((a, b) => (h2h.get(b.teamId) ?? 0) - (h2h.get(a.teamId) ?? 0) || (key.get(a.teamId) ?? 0) - (key.get(b.teamId) ?? 0));
    }
    out.push(...tie);
    i = j;
  }
  return out;
}

function updateStandings(stage: Stage, s: Series, res: SeriesResult, isDraw: boolean): void {
  if (!s.teamA || !s.teamB) return;
  const g = (stage.groups ?? []).find((gr) => gr.teamIds.includes(s.teamA as string));
  if (!g) return;
  const rowOf = (id: string) => {
    let row = g.standings.find((x) => x.teamId === id);
    if (!row) { row = blankStanding(id); g.standings.push(row); }
    return row;
  };
  const a = rowOf(s.teamA);
  const b = rowOf(s.teamB);
  a.gameWins += res.scoreA; a.gameLosses += res.scoreB;
  b.gameWins += res.scoreB; b.gameLosses += res.scoreA;
  if (isDraw) { a.draws++; b.draws++; } else if (res.winnerId === s.teamA) { a.wins++; b.losses++; } else { b.wins++; a.losses++; }
  sortStandingsForDisplay(g.standings);
}

/** 小组赛结束：最终排序、出线、小组淘汰者名次（按组内名次跨组并列） */
function finalizeGroups(state: GameState, t: Tournament, stage: Stage, hasNext: boolean): void {
  const groups = stage.groups ?? [];
  for (const g of groups) g.standings = finalizeGroupOrder(state, t, stage, g.standings);
  const adv = hasNext ? Math.max(0, stage.advanceCount ?? 0) : 0;
  let cursor = 0;
  for (const g of groups) cursor += Math.min(adv, g.standings.length);
  const maxSize = groups.reduce((m, g) => Math.max(m, g.standings.length), 0);
  for (let pos = adv; pos < maxSize; pos++) {
    const ids = groups.filter((g) => g.standings.length > pos).map((g) => g.standings[pos].teamId);
    if (ids.length === 0) continue;
    for (const id of ids) addPlacement(t, id, [cursor + 1, cursor + ids.length]);
    cursor += ids.length;
  }
  const advanced: string[] = [];
  for (let pos = 0; pos < adv; pos++) for (const g of groups) if (g.standings[pos]) advanced.push(g.standings[pos].teamId);
  stage.advancedTeamIds = advanced;
}

// ===========================================================================
// 淘汰赛（单败/双败）对阵树
// ===========================================================================

type Src = { k: 'team'; id: string | null } | { k: 'win'; n: number } | { k: 'lose'; n: number };
type Lane = 'se' | 'ub' | 'lb' | 'gf';
interface BNode { a: Src; b: Src; lane: Lane; lround: number }

interface BracketOpts {
  format: 'se' | 'de';
  /** 单败/胜者组种子（强 → 弱） */
  seeds: string[];
  /** 直接进入败者组首轮的队伍（TI 赛制），强 → 弱 */
  lbSeeds: string[];
  /** 单败子树数（封闭预选 = 晋级名额，各子树冠军晋级） */
  brackets: number;
  /** 本阶段被淘汰者可获得的最差名次 */
  rankBottom: number;
  qualifier: boolean;
}

function buildBracket(state: GameState, t: Tournament, stage: Stage, stageIdx: number, o: BracketOpts): void {
  const nodes: BNode[] = [];
  const directAdvancers: string[] = [];
  const add = (a: Src, b: Src, lane: Lane, lround: number): Src => {
    nodes.push({ a, b, lane, lround });
    return { k: 'win', n: nodes.length - 1 };
  };
  const team = (id: string | null | undefined): Src => ({ k: 'team', id: id ?? null });
  let seMaxRound = 0;
  let ubRounds = 0;

  if (o.format === 'se') {
    const n = o.seeds.length;
    const B = Math.max(1, Math.min(o.brackets, n));
    const k = n <= B ? 0 : Math.ceil(Math.log2(n / B));
    const S = 2 ** k;
    seMaxRound = k;
    const subs: (string | null)[][] = Array.from({ length: B }, () => new Array<string | null>(S).fill(null));
    o.seeds.forEach((id, i) => { subs[i % B][Math.floor(i / B)] = id; });
    const order = standardBracketOrder(S);
    for (let b = 0; b < B; b++) {
      if (k === 0) {
        const only = subs[b][0];
        if (only) directAdvancers.push(only);
        continue;
      }
      let cur: Src[] = order.map((x) => team(subs[b][x]));
      for (let r = 1; r <= k; r++) {
        const next: Src[] = [];
        for (let j = 0; j + 1 < cur.length; j += 2) next.push(add(cur[j], cur[j + 1], 'se', r));
        cur = next;
      }
    }
  } else {
    // 双败：胜者组 U=2^k；败者组按「内部减半(minor) / 接收胜者组掉落(major)」交替
    const U = nextPow2(Math.max(2, o.seeds.length));
    const k = Math.round(Math.log2(U));
    ubRounds = k;
    const order = standardBracketOrder(U);
    let cur: Src[] = order.map((x) => team(o.seeds[x]));
    const ubNodes: number[][] = [[]];
    for (let r = 1; r <= k; r++) {
      const next: Src[] = [];
      ubNodes[r] = [];
      for (let j = 0; j + 1 < cur.length; j += 2) {
        const w = add(cur[j], cur[j + 1], 'ub', r) as { k: 'win'; n: number };
        ubNodes[r].push(w.n);
        next.push(w);
      }
      cur = next;
    }
    const ubFinal = cur[0];
    const losers = (r: number): Src[] => (ubNodes[r] ?? []).map((n) => ({ k: 'lose', n }) as Src);
    let lr = 0;
    const halve = (srcs: Src[]): Src[] => {
      if (srcs.length < 2) return srcs;
      lr++;
      const out: Src[] = [];
      for (let j = 0; j + 1 < srcs.length; j += 2) out.push(add(srcs[j], srcs[j + 1], 'lb', lr));
      if (srcs.length % 2 === 1) out.push(srcs[srcs.length - 1]);
      return out;
    };
    const major = (surv: Src[], drops: Src[]): Src[] => {
      if (drops.length === 0) return surv;
      if (surv.length === 0) return drops;
      lr++;
      const m = Math.min(surv.length, drops.length);
      const out: Src[] = [];
      for (let i = 0; i < m; i++) out.push(add(surv[i], drops[drops.length - 1 - i], 'lb', lr));
      return out;
    };
    let surv: Src[];
    if (o.lbSeeds.length > 0) {
      const lbOrder = standardBracketOrder(U);
      surv = halve(lbOrder.map((x) => team(o.lbSeeds[x])));
      surv = major(surv, losers(1));
    } else {
      surv = halve(losers(1));
    }
    for (let r = 2; r <= k; r++) {
      const drops = losers(r);
      while (surv.length > drops.length && surv.length > 1) surv = halve(surv);
      surv = major(surv, drops);
    }
    while (surv.length > 1) surv = halve(surv);
    if (surv.length === 1) add(ubFinal, surv[0], 'gf', 1);
  }

  compileBracket(state, t, stage, stageIdx, nodes, directAdvancers, o, seMaxRound, ubRounds);
}

function compileBracket(
  state: GameState,
  t: Tournament,
  stage: Stage,
  stageIdx: number,
  nodes: BNode[],
  directAdvancers: string[],
  o: BracketOpts,
  seMaxRound: number,
  ubRounds: number,
): void {
  const N = nodes.length;
  const winC: ({ n: number; s: 'A' | 'B' } | undefined)[] = new Array(N);
  const loseC: ({ n: number; s: 'A' | 'B' } | undefined)[] = new Array(N);
  nodes.forEach((nd, i) => {
    for (const [slot, src] of [['A', nd.a], ['B', nd.b]] as ['A' | 'B', Src][]) {
      if (src.k === 'win') winC[src.n] = { n: i, s: slot };
      else if (src.k === 'lose') loseC[src.n] = { n: i, s: slot };
    }
  });
  // 节点按拓扑序创建（来源总在前），可顺序计算「是否有真实胜者/败者」
  const realW: boolean[] = new Array(N).fill(false);
  const realL: boolean[] = new Array(N).fill(false);
  const real = (src: Src): boolean => (src.k === 'team' ? !!src.id : src.k === 'win' ? realW[src.n] : realL[src.n]);
  for (let i = 0; i < N; i++) {
    const a = real(nodes[i].a);
    const b = real(nodes[i].b);
    realW[i] = a || b;
    realL[i] = a && b;
  }
  const isMatch = realL;
  const forward = (n: number, s: 'A' | 'B'): { n: number; s: 'A' | 'B' } | null => {
    let cn = n;
    let cs = s;
    for (let guard = 0; guard <= N; guard++) {
      if (isMatch[cn]) return { n: cn, s: cs };
      const c = winC[cn];
      if (!c) return null;
      cn = c.n;
      cs = c.s;
    }
    return null;
  };

  // 名次分组：被淘汰（无败者去向）的真实比赛，按淘汰时机自下而上分配名次
  const loserDest: ({ n: number; s: 'A' | 'B' } | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    const lc = loseC[i];
    if (isMatch[i] && lc) loserDest[i] = forward(lc.n, lc.s);
  }
  const isElim = (i: number) => isMatch[i] && !loserDest[i];
  const groupKey = (nd: BNode) => (nd.lane === 'gf' ? 1e6 : nd.lane === 'lb' ? 1000 + nd.lround : nd.lround);
  const counts = new Map<number, number>();
  for (let i = 0; i < N; i++) if (isElim(i)) counts.set(groupKey(nodes[i]), (counts.get(groupKey(nodes[i])) ?? 0) + 1);
  const ranges = new Map<number, [number, number]>();
  let cursor = o.rankBottom;
  for (const key of Array.from(counts.keys()).sort((a, b) => a - b)) {
    const m = counts.get(key) ?? 0;
    ranges.set(key, [cursor - m + 1, cursor]);
    cursor -= m;
  }

  const lbMax = nodes.reduce((m, nd) => (nd.lane === 'lb' ? Math.max(m, nd.lround) : m), 0);
  const bo = CONFIG.tournament.bestOf;
  const big = isBigFinal(t.tier);
  const labelOf = (nd: BNode, terminal: boolean): string => {
    switch (nd.lane) {
      case 'se':
        if (o.qualifier) return nd.lround === seMaxRound ? '预选赛 晋级战' : `预选赛 第${nd.lround}轮`;
        if (terminal && nd.lround === seMaxRound) return '决赛';
        if (nd.lround === seMaxRound - 1) return '半决赛';
        if (nd.lround === seMaxRound - 2) return '四分之一决赛';
        return `第${nd.lround}轮`;
      case 'ub':
        if (nd.lround === ubRounds) return '胜者组决赛';
        if (nd.lround === ubRounds - 1) return '胜者组半决赛';
        return `胜者组第${nd.lround}轮`;
      case 'lb':
        return nd.lround === lbMax ? '败者组决赛' : `败者组第${nd.lround}轮`;
      default:
        return '总决赛';
    }
  };
  const bestOfFor = (nd: BNode, terminal: boolean): 1 | 2 | 3 | 5 => {
    if (o.qualifier) return (nd.lround === seMaxRound ? bo.qualifierDecider : bo.qualifier) as 1 | 3;
    if (nd.lane === 'gf' || (nd.lane === 'se' && terminal)) return (big ? bo.finalBig : bo.final) as 3 | 5;
    if (nd.lane === 'lb' && o.lbSeeds.length > 0 && nd.lround === 1) return bo.tiLowerFirst as 1 | 3;
    return bo.playoffs as 3;
  };

  const seriesOf: (string | undefined)[] = new Array(N);
  let serial = 0;
  for (let i = 0; i < N; i++) {
    if (!isMatch[i]) continue;
    const id = `${t.id}-s${stageIdx}-${serial++}`;
    seriesOf[i] = id;
    const terminal = !winC[i] || !forward(winC[i]!.n, winC[i]!.s);
    t.series[id] = {
      id, tournamentId: t.id, stageId: stage.id, label: labelOf(nodes[i], terminal),
      teamA: null, teamB: null, bestOf: bestOfFor(nodes[i], terminal), round: 1,
    };
    stage.seriesIds.push(id);
  }
  // 连线 + 名次
  const depth = new Map<string, number>();
  for (let i = 0; i < N; i++) {
    const sid = seriesOf[i];
    if (!sid) continue;
    const s = t.series[sid];
    const wc = winC[i];
    const wd = wc ? forward(wc.n, wc.s) : null;
    if (wd) s.winnerTo = { seriesId: seriesOf[wd.n] as string, slot: wd.s };
    const ld = loserDest[i];
    if (ld) s.loserTo = { seriesId: seriesOf[ld.n] as string, slot: ld.s };
    else if (isElim(i)) s.loserPlacement = ranges.get(groupKey(nodes[i]));
  }
  // 轮次 = 依赖深度（节点拓扑序保证前驱先处理）
  for (let i = 0; i < N; i++) {
    const sid = seriesOf[i];
    if (!sid) continue;
    const s = t.series[sid];
    const d = depth.get(sid) ?? 1;
    s.round = d;
    for (const to of [s.winnerTo, s.loserTo]) {
      if (to) depth.set(to.seriesId, Math.max(depth.get(to.seriesId) ?? 1, d + 1));
    }
  }
  // 初始队伍落位（穿透轮空）
  for (let i = 0; i < N; i++) {
    for (const [slot, src] of [['A', nodes[i].a], ['B', nodes[i].b]] as ['A' | 'B', Src][]) {
      if (src.k !== 'team' || !src.id) continue;
      const d = forward(i, slot);
      if (d) setSlot(t, { seriesId: seriesOf[d.n] as string, slot: d.s }, src.id);
      else directAdvancers.push(src.id);
    }
  }
  stage.advancedTeamIds = (stage.advancedTeamIds ?? []).concat(directAdvancers);
}

function setSlot(t: Tournament, to: { seriesId: string; slot: 'A' | 'B' }, teamId: string): void {
  const s = t.series[to.seriesId];
  if (!s) return;
  if (to.slot === 'A') s.teamA = teamId;
  else s.teamB = teamId;
}

// ===========================================================================
// 阶段完成 / 名次
// ===========================================================================

function completeStage(state: GameState, t: Tournament, idx: number): void {
  const stage = t.stages[idx];
  if (!stage || stage.done) return;
  stage.done = true;
  const hasNext = idx + 1 < t.stages.length;
  if (stage.type === 'qualifier') {
    for (const id of stage.advancedTeamIds ?? []) if (!t.teamIds.includes(id)) t.teamIds.push(id);
  } else if (stage.type === 'groups') {
    finalizeGroups(state, t, stage, hasNext);
  }
  if (hasNext) activateStage(state, t, idx + 1);
  else finalizePlacements(state, t);
  // TI 小组赛战罢新闻（晋级/出局名单、热门出局），在淘汰赛对阵生成后发布
  if (stage.type === 'groups' && hasNext && t.tier === 'ti') reportTiGroupStage(state, t, idx);
}

/** 全部阶段结束后：尚无名次的队伍（冠军、或轮空直通者）依次占据最前名次，保证名次连续覆盖全部参赛队 */
function finalizePlacements(state: GameState, t: Tournament): void {
  const participants = uniq([...t.teamIds, ...t.qualifierTeamIds]).filter((id) => state.teams[id]);
  const placed = new Set(t.placements.map((p) => p.teamId));
  const unplaced = participants.filter((id) => !placed.has(id));
  if (unplaced.length === 0) return;
  const last = t.stages[t.stages.length - 1];
  const advOrder = last?.advancedTeamIds ?? [];
  const exp = t.expectedRanks ?? {};
  unplaced.sort((a, b) => {
    const ia = advOrder.indexOf(a);
    const ib = advOrder.indexOf(b);
    if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    return (exp[a] ?? 1e9) - (exp[b] ?? 1e9);
  });
  // 已占用名次的最小值之前的空位
  let top = 1;
  const taken = new Set<number>();
  for (const p of t.placements) for (let r = p.rankFrom; r <= p.rankTo; r++) taken.add(r);
  for (const id of unplaced) {
    while (taken.has(top)) top++;
    addPlacement(t, id, [top, top]);
    taken.add(top);
  }
  t.placements.sort((a, b) => a.rankFrom - b.rankFrom || a.rankTo - b.rankTo);
}

// ===========================================================================
// 查询
// ===========================================================================

/** 已确定双方且未赛的系列赛（当前进行中的 stage，按 round 升序） */
export function readySeries(state: GameState, tournamentId: string): Series[] {
  const t = state.tournaments[tournamentId];
  if (!t || t.status !== 'running') return [];
  const idx = currentStageIndex(t);
  if (idx < 0) return [];
  const out: Series[] = [];
  for (const id of t.stages[idx].seriesIds) {
    const s = t.series[id];
    if (s && s.teamA && s.teamB && !s.result) out.push(s);
  }
  return out.sort((a, b) => a.round - b.round);
}

/** 玩家下一场已就绪的系列赛；无则 null */
export function playerNextSeries(state: GameState, tournamentId: string): Series | null {
  const pid = playerTeamId(state);
  if (!pid) return null;
  return readySeries(state, tournamentId).find((s) => s.teamA === pid || s.teamB === pid) ?? null;
}

/** 某队在该赛事是否已被淘汰（或赛事已结束） */
export function isTeamEliminated(state: GameState, tournamentId: string, teamId: string): boolean {
  const t = state.tournaments[tournamentId];
  if (!t || t.status === 'finished') return true;
  if (!t.teamIds.includes(teamId) && !t.qualifierTeamIds.includes(teamId)) return true;
  if (t.status === 'running' && t.stages.length > 0 && allStagesDone(t)) return true;
  return hasPlacement(t, teamId);
}

// ===========================================================================
// 写入结果 & 推进
// ===========================================================================

/** AI 对 AI 的对局只保留比分/时长等摘要，避免存档膨胀（TI 保留完整 BP） */
function compactGame(g: GameRecord): GameRecord {
  return { ...g, draft: [], live: [], incidents: [], eval: { ...g.eval, notes: [] } };
}

/**
 * 写入系列赛结果：更新小组积分（胜/平/负，Bo2 平局）、淘汰赛晋级/掉入败者组、记录被淘汰者名次；
 * 宿敌结算（honor.applyBeefResult）、归属感（match.applySeriesLoyalty）；
 * 阶段全部完成 → 计算晋级并填充下一阶段；全部阶段完成 → 计算 placements（不发奖，发奖在 finishTournament）。
 */
export function recordSeriesResult(state: GameState, tournamentId: string, seriesId: string, result: SeriesResult): void {
  const t = state.tournaments[tournamentId];
  const s = t?.series[seriesId];
  if (!t || !s || s.result || !s.teamA || !s.teamB || !result) return;
  const stageIdx = t.stages.findIndex((st) => st.id === s.stageId);
  const stage = stageIdx >= 0 ? t.stages[stageIdx] : null;
  const pid = playerTeamId(state);

  const scoreA = Math.max(0, Math.floor(result.scoreA) || 0);
  const scoreB = Math.max(0, Math.floor(result.scoreB) || 0);
  const isDraw = scoreA === scoreB && stage?.type === 'groups';
  let winnerId = result.winnerId;
  let loserId = result.loserId;
  if (isDraw) {
    winnerId = s.teamA;
    loserId = s.teamB;
  } else if ((winnerId !== s.teamA && winnerId !== s.teamB) || winnerId === loserId) {
    winnerId = scoreA >= scoreB ? s.teamA : s.teamB;
    loserId = winnerId === s.teamA ? s.teamB : s.teamA;
  } else {
    loserId = winnerId === s.teamA ? s.teamB : s.teamA;
  }
  const allHumans = isMultiplayer(state) ? new Set(humanTeamIds(state)) : null;
  const keepFull = s.teamA === pid || s.teamB === pid || t.tier === 'ti'
    || (!!allHumans && (allHumans.has(s.teamA) || allHumans.has(s.teamB)));
  const games = Array.isArray(result.games) ? result.games : [];
  const res: SeriesResult = { winnerId, loserId, scoreA, scoreB, games: keepFull ? games : games.map(compactGame) };
  if (result.forfeit === 'A' || result.forfeit === 'B') res.forfeit = result.forfeit;
  s.result = res;

  if (stage?.type === 'groups') updateStandings(stage, s, res, isDraw);
  recordSeriesStats(state, t, s, res, isDraw); // DotaPedia：系列赛胜平负（stats.ts）
  if (!isDraw) {
    if (isMultiplayer(state)) {
      // 多人模式：宿敌（beefs）与赛事累计宿敌荣誉都是座位私有字段 → 在双方各自的座位上下文中结算
      for (const id of [winnerId, loserId]) {
        if (!activeHumanIds(state).includes(id)) continue;
        withSeat(state, id, () => {
          const beef = applyBeefResult(state, winnerId, loserId);
          if (beef !== 0) t.playerBeefHonor = (t.playerBeefHonor ?? 0) + beef;
        });
      }
    } else {
      const beef = applyBeefResult(state, winnerId, loserId);
      if (beef !== 0) t.playerBeefHonor = (t.playerBeefHonor ?? 0) + beef;
    }
    applySeriesLoyalty(state, res);
  }
  if (stage && stage.type !== 'groups') {
    if (s.winnerTo) setSlot(t, s.winnerTo, winnerId);
    else (stage.advancedTeamIds ??= []).push(winnerId);
    if (s.loserTo) setSlot(t, s.loserTo, loserId);
    else if (s.loserPlacement) addPlacement(t, loserId, s.loserPlacement);
  }
  if (stage && !stage.done && stage.seriesIds.every((id) => !!t.series[id]?.result)) completeStage(state, t, stageIdx);
}

function simulateOne(state: GameState, t: Tournament, s: Series): void {
  if (s.result || !s.teamA || !s.teamB) return;
  const result = simulateSeries(state, s, t.tier, false);
  recordSeriesResult(state, t.id, s.id, result);
}

/** 依次模拟不含玩家的就绪系列赛，直到玩家下一场就绪、玩家已被淘汰后的全部比赛结束、或赛事结束 */
export function advanceTournamentUntilPlayer(state: GameState, tournamentId: string): void {
  const t = state.tournaments[tournamentId];
  if (!t || t.status !== 'running') return;
  // 多人模式：任一玩家的系列赛就绪即停（玩家之间的比赛由玩家自己打）
  const humans = humanSet(state);
  const isHuman = (s: Series) => (!!s.teamA && humans.has(s.teamA)) || (!!s.teamB && humans.has(s.teamB));
  for (let guard = 0; guard < CONFIG.tournament.seriesSimGuard; guard++) {
    const ready = readySeries(state, tournamentId);
    if (ready.length === 0) break;
    const mine = ready.find(isHuman) ?? null;
    const others = ready.filter((s) => !isHuman(s));
    const batch = mine ? others.filter((s) => s.round <= mine.round) : others;
    if (batch.length === 0) break;
    for (const s of batch) simulateOne(state, t, s);
  }
}

/** 模拟全部剩余比赛（含玩家比赛，此时自动 BP、无直播）直到赛事所有阶段完成 */
export function simulateTournamentToEnd(state: GameState, tournamentId: string): void {
  const t = state.tournaments[tournamentId];
  if (!t) return;
  if (t.status === 'scheduled') {
    if (t.teamIds.length + t.qualifierTeamIds.length === 0) return;
    initTournamentStages(state, tournamentId);
  }
  if (t.status !== 'running') return;
  for (let guard = 0; guard < CONFIG.tournament.seriesSimGuard; guard++) {
    const ready = readySeries(state, tournamentId);
    if (ready.length === 0) break;
    for (const s of ready) simulateOne(state, t, s);
  }
  if (!allStagesDone(t)) {
    // 防御：理论上不会发生（对阵树无悬空）；强制收尾以免卡死
    for (const st of t.stages) st.done = true;
  }
  finalizePlacements(state, t);
}

// ===========================================================================
// 奖金 / 积分
// ===========================================================================

/** 名次 → 奖金比例表：取 key ≥ teams 的最小表（无则最大表），截取前 teams 项并归一化 */
function shareTable(teams: number): number[] {
  const table = CONFIG.tournament.prizeShare;
  const keys = Object.keys(table).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (keys.length === 0 || teams <= 0) return new Array(Math.max(0, teams)).fill(teams > 0 ? 1 / teams : 0);
  const key = keys.find((k) => k >= teams) ?? keys[keys.length - 1];
  const raw = (table[key] ?? []).slice(0, teams);
  const total = raw.reduce((a, b) => a + b, 0);
  return total > 0 ? raw.map((v) => v / total) : raw;
}

/** 名次区间平均比例（区间内平分；超出表长的名次比例为 0） */
function rangeShare(teams: number, rankFrom: number, rankTo: number): number {
  const shares = shareTable(teams);
  const from = Math.max(1, Math.floor(rankFrom));
  const to = Math.max(from, Math.floor(rankTo));
  let s = 0;
  for (let r = from; r <= to; r++) s += shares[r - 1] ?? 0;
  return s / (to - from + 1);
}

/** 名次区间按基础比例表分得的奖金（区间内平分）。实际发放见 revenue.awardedPrize（压缩奖池 + 平摊比例） */
export function prizeForPlacement(prizePool: number, teams: number, rankFrom: number, rankTo: number): number {
  if (!(prizePool > 0) || !(teams > 0) || !Number.isFinite(rankFrom) || !Number.isFinite(rankTo)) return 0;
  if (rankFrom > teams) return 0;
  return Math.round(prizePool * rangeShare(Math.floor(teams), rankFrom, rankTo));
}

/** 巡回赛积分：championPoints[tier] × (区间平均比例 / 冠军比例) */
export function pointsForPlacement(tier: TournamentTier, teams: number, rankFrom: number, rankTo: number): number {
  const champ = CONFIG.tournament.championPoints[tier] ?? 0;
  if (!(champ > 0) || !(teams > 0) || rankFrom > teams) return 0;
  const first = shareTable(Math.floor(teams))[0] ?? 0;
  if (!(first > 0)) return 0;
  return Math.round((champ * rangeShare(Math.floor(teams), rankFrom, rankTo)) / first);
}

// ===========================================================================
// 结算
// ===========================================================================

/**
 * 赛事结算（status='finished'）：placements（含预选淘汰者）、奖金（CONFIG.tournament.prizeShare）、出场费、巡回赛积分；
 * 全部参赛队：economy.addFinance、成长（growth.applyTournamentGrowth）、荣誉（honor.computeHonorBreakdown + changeHonor）；
 * 冠军选手 stats.titles++（TI 另加 tiTitles）、归属感 +title；
 * 玩家：settlement 写入 t.settlement 与 history.playerSettlements，popups 推送 tournament_settlement，新闻；
 * TI 预选：前 N 名写入对应 TI 实例的 teamIds；
 * history.tournaments 记录；market.releaseTempSubs；清除选手 unavailableTournamentIds 中的本赛事。
 *
 * 荣誉口径：直邀/正赛队以正赛规模计名次百分位；参加封闭预选的队伍以「正赛 + 预选」总数计。
 * 玩家结算中 honor.beef 为本赛事逐场已结算的宿敌荣誉，honor.total 含该部分（展示用，不重复扣加）。
 */
export function finishTournament(state: GameState, tournamentId: string): void {
  const t = state.tournaments[tournamentId];
  if (!t || t.status === 'finished') return;
  if (t.status === 'scheduled' && t.teamIds.length + t.qualifierTeamIds.length === 0) {
    t.status = 'finished';
    return;
  }
  if (t.status !== 'running' || !allStagesDone(t)) simulateTournamentToEnd(state, tournamentId);
  finalizePlacements(state, t);

  const pid = playerTeamId(state);
  const quals = new Set(t.qualifierTeamIds);
  const mainSize = Math.max(1, t.size ?? t.teamIds.length);
  t.appearanceFee = tournamentAppearanceFee(state, t); // 出场费按赛事等级（× 年代经济指数），每支正赛队伍
  const total = Math.max(mainSize, uniq([...t.teamIds, ...t.qualifierTeamIds]).length);
  const played = new Map<string, number>();
  for (const s of Object.values(t.series)) {
    if (!s.result) continue;
    for (const id of [s.teamA, s.teamB]) if (id) played.set(id, (played.get(id) ?? 0) + 1);
  }

  t.placements.sort((a, b) => a.rankFrom - b.rankFrom || a.rankTo - b.rankTo);
  for (const pl of t.placements) {
    const inMain = pl.rankFrom <= mainSize;
    // 奖金：显示真实奖金池，发放压缩后的游戏内奖金（revenue.awardedPrize，按年代/等级换算，正赛全部名次有奖金）
    pl.prize = inMain ? awardedPrize(state, t, mainSize, pl.rankFrom, pl.rankTo) : 0;
    pl.points = inMain && !t.noCircuitPoints ? pointsForPlacement(t.tier, mainSize, pl.rankFrom, pl.rankTo) : 0;
  }
  const champion = t.placements.find((p) => p.rankFrom === 1 && p.rankTo === 1) ?? null;
  const runnerUp = t.placements.find((p) => p.rankFrom === 2 && p.rankTo === 2) ?? null;

  const histPlacements: Record<string, [number, number, number]> = {};
  let settlement: TournamentSettlement | null = null;
  // 多人模式：每位参赛玩家各自的结算（宿敌荣誉 playerBeefHonor 是座位私有字段，结算对象在其座位上下文中生成）
  const mp = isMultiplayer(state);
  const mpHumans = mp ? new Set(activeHumanIds(state)) : null;
  const mpSettle: { teamId: string; base: Omit<TournamentSettlement, 'honor'>; hb: TournamentSettlement['honor'] }[] = [];
  for (const pl of t.placements) {
    const team = state.teams[pl.teamId];
    if (!team) continue;
    const count = quals.has(pl.teamId) ? total : mainSize;
    histPlacements[pl.teamId] = [pl.rankFrom, pl.rankTo, count];
    const inMain = pl.rankFrom <= mainSize;
    const rankText = formatRank(pl.rankFrom, pl.rankTo);
    // 出场费：正赛队伍按等级全额（t.appearanceFee 已在上方写入）；封闭预选出局者领取预选补贴（revenue.qualifierAppearanceFee）
    const appearance = inMain ? Math.max(0, Math.round(t.appearanceFee || 0)) : quals.has(pl.teamId) ? qualifierAppearanceFee(state, t) : 0;
    // 奖金分成（第九波，prizeShare.ts）：俱乐部只拿 (1 − 分成比例)，其余分给队员（出场费全归俱乐部）
    const split = pl.prize > 0 ? payTournamentPrize(state, pl.teamId, pl.prize, `${t.name} ${rankText}`) : null;
    recordPrizeSplit(state, t, pl.teamId, pl.rankFrom, split); // DotaPedia：奖金（俱乐部 / 队员分成）
    const prizeSplit = split ? { prizeClub: split.club, prizePlayers: split.players, prizeShare: split.share } : {};
    if (appearance > 0) addFinance(state, pl.teamId, appearance, 'appearance', inMain ? `${t.name} 出场费` : `${t.name} 预选赛参赛补贴`);
    team.points = (team.points || 0) + pl.points;

    // 荣誉（必须在写入本赛事 history 之前计算，以便同比/环比取到往期）
    const hb = computeHonorBreakdown(state, pl.teamId, t, pl.rankFrom, pl.rankTo, count);
    const isMe = pl.teamId === pid;
    applyHonorChange(state, pl.teamId, hb.total, `${t.name} ${rankText}`, false);
    const growth = applyTournamentGrowth(
      state, pl.teamId, placementPercentile(pl.rankFrom, pl.rankTo, count), t.tier, played.get(pl.teamId) ?? 0,
    );
    if (mpHumans?.has(pl.teamId)) {
      mpSettle.push({
        teamId: pl.teamId,
        base: {
          tournamentId: t.id, rankFrom: pl.rankFrom, rankTo: pl.rankTo, teams: count, prize: pl.prize,
          appearanceFee: appearance, points: pl.points, playerGrowth: growth ?? [], ...prizeSplit,
        },
        hb,
      });
    } else if (isMe) {
      const beef = t.playerBeefHonor ?? 0;
      settlement = {
        tournamentId: t.id,
        rankFrom: pl.rankFrom,
        rankTo: pl.rankTo,
        teams: count,
        prize: pl.prize,
        appearanceFee: appearance,
        points: pl.points,
        honor: { ...hb, beef, total: hb.total + beef },
        playerGrowth: growth ?? [],
        ...prizeSplit,
      };
    }
  }

  // 冠军荣誉：选手头衔与归属感（预选赛级别的赛事——TI 赛区预选——不计冠军头衔，与赛季总结口径一致）
  if (champion) {
    const team = state.teams[champion.teamId];
    if (team) {
      const lineupIds = Object.values(team.lineup ?? {}).filter((x): x is string => !!x);
      const ids = lineupIds.length > 0 ? lineupIds : team.playerIds.slice(0, 5);
      for (const id of ids) {
        const p = state.players[id];
        if (!p || p.teamId !== team.id) continue;
        if (t.tier !== 'qualifier') p.stats.titles += 1;
        if (t.tier === 'ti') p.stats.tiTitles += 1;
        adjustLoyalty(p, CONFIG.loyalty.title);
      }
    }
  }

  // DotaPedia：冠亚军（TI 为全部正赛队伍）的当时首发（临时替补离队之前）
  recordTournamentStats(state, t);

  // TI 赛区预选：前 N 名晋级 TI
  if (t.advanceToTi) handleTiQualifierAdvance(state, t);

  state.history.tournaments.push({
    tournamentId: t.id,
    seriesId: t.seriesId,
    name: t.name,
    tier: t.tier,
    season: t.season,
    championId: champion?.teamId ?? '',
    placements: histPlacements,
  });

  t.status = 'finished';
  releaseTempSubs(state, t.id);
  for (const p of Object.values(state.players)) {
    const list = p.unavailableTournamentIds;
    if (list && list.includes(t.id)) {
      p.unavailableTournamentIds = list.filter((x) => x !== t.id);
      if (p.unavailableTournamentIds.length === 0) delete p.unavailableTournamentIds;
    }
  }

  // 新闻 & 玩家结算
  const meIn = !!settlement || mpSettle.length > 0;
  // TI 赛区预选的晋级/出局新闻由 handleTiQualifierAdvance 发布，这里不重复报道「夺冠」
  // 冠军（决赛比分/黑马/卫冕/TI 故事线）与爆冷新闻见 newsroom.ts
  if (champion && !t.advanceToTi) {
    reportTournamentResult(state, t, {
      championId: champion.teamId,
      runnerUpId: runnerUp?.teamId ?? null,
      prize: champion.prize,
      playerInvolved: meIn,
    });
    reportTournamentUpsets(state, t);
  }
  if (settlement) publishSettlement(state, t, settlement, pid);
  for (const x of mpSettle) {
    withSeat(state, x.teamId, () => {
      const beef = t.playerBeefHonor ?? 0;
      publishSettlement(state, t, { ...x.base, honor: { ...x.hb, beef, total: x.hb.total + beef } }, x.teamId);
    });
  }
}

/** 玩家（当前座位）的赛事结算：写入 t.settlement / history.playerSettlements、结算弹窗与新闻 */
function publishSettlement(state: GameState, t: Tournament, st: TournamentSettlement, pid: string): void {
  t.settlement = st;
  state.history.playerSettlements.push(st);
  pushPopup(state, { kind: 'tournament_settlement', tournamentId: t.id });
  const h = st.honor.total;
  const money: string[] = [];
  if (st.prize > 0) {
    money.push(typeof st.prizeClub === 'number' && typeof st.prizePlayers === 'number'
      ? prizeSplitText({ total: st.prize, club: st.prizeClub, players: st.prizePlayers })
      : `奖金 ${formatGold(st.prize)}`);
  }
  if (st.appearanceFee > 0) money.push(`出场费 ${formatGold(st.appearanceFee)}`);
  if (st.points > 0) money.push(`巡回赛积分 +${st.points}`);
  const preExp = t.expectedRanks?.[pid] ?? t.expectedRank ?? Math.round(st.honor.expected);
  addNews(
    state, 'tournament', `${t.name} 战罢：${formatRank(st.rankFrom, st.rankTo)}`,
    `${money.length ? `${money.join('，')}，` : ''}荣誉 ${h >= 0 ? '+' : ''}${h}（赛前预期第 ${preExp} 名左右）。`,
    st.rankFrom === 1 || h <= -30,
    { teamIds: [pid], tags: ['result', `level:${t.tier}`] },
  );
}

/** TI 赛区预选结束：前 slots 名写入 TI 名单（同名次并列时随机），并同步玩家 TI 状态 */
function handleTiQualifierAdvance(state: GameState, t: Tournament): void {
  const adv = t.advanceToTi;
  if (!adv) return;
  const tiT = state.tournaments[adv.tiId];
  const rng = rngOf(state);
  const ranked = t.placements
    .map((p) => ({ id: p.teamId, from: p.rankFrom, key: rng.next() }))
    .sort((a, b) => a.from - b.from || a.key - b.key);
  const qualified = ranked.slice(0, Math.max(0, adv.slots)).map((r) => r.id);
  const pid = playerTeamId(state);
  if (tiT) {
    for (const id of qualified) if (!tiT.teamIds.includes(id)) tiT.teamIds.push(id);
    if (tiT.teamIds.includes(pid)) tiT.playerStatus = 'invited';
  }
  const tiLabel = `TI${t.season}`;
  const names = qualified.map((id) => teamName(state, id)).join('、');
  if (isMultiplayer(state)) {
    // 多人模式：每位参加该预选的玩家在自己的座位上下文中同步 TI 状态并收到晋级/出局新闻
    const entrants = activeHumanIds(state).filter((h) => t.teamIds.includes(h));
    for (const h of entrants) {
      withSeat(state, h, () => {
        if (tiT && tiT.teamIds.includes(h)) tiT.playerStatus = 'invited';
        if (qualified.includes(h)) {
          addNews(state, 'tournament', `闯关成功！${teamName(state, h)} 晋级 ${tiLabel}`,
            `${t.name} 突围成功，我们将登上 ${tiLabel} 的舞台。本赛区晋级：${names}。`, true,
            { teamIds: [h, ...qualified.filter((id) => id !== h)], tags: ['ti-story'] });
        } else {
          addNews(state, 'tournament', `止步预选：${teamName(state, h)} 无缘 ${tiLabel}`,
            `${t.name} 出局，今年只能在屏幕前看 TI 了。本赛区晋级：${names}。`, true,
            { teamIds: [h, ...qualified], tags: ['ti-story'] });
        }
      });
    }
    if (!entrants.length && names) {
      addNews(state, 'tournament', `${t.name} 结束：${names} 晋级 ${tiLabel}`, `${names} 拿到 ${tiLabel} 门票。`, false,
        { teamIds: qualified, tags: ['ti-story', 'level:qualifier'] });
    }
    return;
  }
  if (qualified.includes(pid)) {
    addNews(state, 'tournament', `闯关成功！${teamName(state, pid)} 晋级 ${tiLabel}`,
      `${t.name} 突围成功，我们将登上 ${tiLabel} 的舞台。本赛区晋级：${names}。`, true,
      { teamIds: [pid, ...qualified.filter((id) => id !== pid)], tags: ['ti-story'] });
  } else if (t.teamIds.includes(pid)) {
    addNews(state, 'tournament', `止步预选：${teamName(state, pid)} 无缘 ${tiLabel}`,
      `${t.name} 出局，今年只能在屏幕前看 TI 了。本赛区晋级：${names}。`, true,
      { teamIds: [pid, ...qualified], tags: ['ti-story'] });
  } else if (names) {
    addNews(state, 'tournament', `${t.name} 结束：${names} 晋级 ${tiLabel}`, `${names} 拿到 ${tiLabel} 门票。`, false,
      { teamIds: qualified, tags: ['ti-story', 'level:qualifier'] });
  }
}
