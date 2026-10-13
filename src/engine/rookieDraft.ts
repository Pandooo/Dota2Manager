// ============================================================================
// 新秀选秀（第八波：取代玩家抽卡）
// 每个赛季初（TI 结算的退役 / 年龄 / 合同之后，休赛期转会潮与赛程之前；新游戏的第一个赛季同样举行）：
//   1. 新秀池 = 本赛季登场的真实新秀（state.futureRookies 到期）+ 程序生成新秀（CONFIG.draft.generatedPerSeason）。
//      程序生成新秀等级按 A 15% / S 10% / SS 5% / SSR 1%（其余 C/B）；SSR 为伪随机分布并跨赛季保底：
//      每 ssrPityThreshold 名新秀至少 1 名 SSR（真实新秀保留数据等级，但计入保底计数，任何 SSR 出现即清零）。
//   2. 顺位：上赛季最终排名最差的若干支战队参加 NBA 式加权抽签，抽出首轮前 lotteryPicks 个顺位，
//      其余按排名倒序；第二轮起全部按排名倒序。首个赛季按初始实力 + 荣誉排名。
//   3. 每支战队（AI 与玩家）按顺位自动挑选（实力 + 位置需求 + 前几名中随机），没有「阵容已满放弃顺位」：
//      玩家战队保留全部选中的新秀（由经理决定首发与替补；只有空着的首发位会自动补上），阵容可以超出常规上限
//      （工资照付、替补归属感下降更快）；AI 战队选秀后若超出 ai.maxRoster，放走价值最低的非首发（进入自由市场）。
//      新秀合同 2–3 赛季，工资按新秀薪资表（按总顺位）。落选新秀进入自由市场。
//   4. 结果：每位玩家一个弹窗（kind 'rookie_draft'）+ 新闻（状元签、选秀大会、各玩家战队的新秀）。
// 玩家可在赛季初免费放弃本届选中的新秀（releaseDraftedRookie → 自由市场）。
// 选秀记录为全局世界状态（GameState.rookieDraft），多人模式下全局只举行一次，弹窗按座位推送。
// ============================================================================
import type {
  GameState, OpResult, Player, PlayerIndexEntry, Position, RookieDraftLotteryEntry, RookieDraftPick, RookieDraftRecord,
  RookieDraftState, Team, Tier,
} from './types';
import { POSITIONS, TIERS } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, type Rng } from './rng';
import { clamp, formatGold } from './util';
import { addNews, pushPopup } from './news';
import { ageOf, effectiveAttr, overallRating, playerRating, playerTier, seasonEconIndex, tierIndex } from './player';
import { naturalPositions } from './roles';
import { activeTeams, addPlayerToTeam, autoLineup, rankTeamsByRating } from './team';
import { generatePlayer, rookieFromIndex } from './generation';
import { departToFreeAgency } from './market';
import { syncSynergies } from './synergy';
import { prdConstant } from './gacha';
import { forEachSeat, isHumanTeam } from './seat';
import { getPlayerIndex } from '../data/index';

const ok = (message: string): OpResult => ({ ok: true, message });
const fail = (message: string): OpResult => ({ ok: false, message });

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 选秀状态（缺失 / 损坏时补默认值） */
export function rookieDraftState(state: GameState): RookieDraftState {
  const cur = state.rookieDraft;
  if (!cur || typeof cur !== 'object') {
    state.rookieDraft = { ssrPity: 0, history: [] };
    return state.rookieDraft;
  }
  if (!Number.isFinite(cur.ssrPity) || cur.ssrPity < 0) cur.ssrPity = 0;
  if (!Array.isArray(cur.history)) cur.history = [];
  return cur;
}

/** 某届（默认本赛季）选秀记录；未举行返回 null（只读，不修改 state） */
export function rookieDraftRecord(state: GameState, ti: number = state.season?.ti ?? 0): RookieDraftRecord | null {
  const list = state.rookieDraft?.history;
  if (!Array.isArray(list)) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.ti === ti) return list[i];
  return null;
}

/** 往届选秀（最新在前） */
export function rookieDraftHistory(state: GameState): RookieDraftRecord[] {
  const list = state.rookieDraft?.history;
  return Array.isArray(list) ? list.filter((r) => !!r).slice().reverse() : [];
}

// ---------------------------------------------------------------------------
// 等级分布与 SSR 伪随机保底
// ---------------------------------------------------------------------------

/** 程序生成新秀的名义等级概率（归一化，UI 展示用） */
export function rookieTierProbabilities(): Record<Tier, number> {
  const w = CONFIG.draft.tierWeights;
  const total = TIERS.reduce((s, t) => s + Math.max(0, num(w[t], 0)), 0);
  const out = {} as Record<Tier, number>;
  for (const t of TIERS) out[t] = total > 0 ? Math.max(0, num(w[t], 0)) / total : 1 / TIERS.length;
  return out;
}

function ssrThreshold(): number {
  return Math.max(1, Math.floor(num(CONFIG.draft.ssrPityThreshold, 100)));
}

/** 下一名程序生成新秀为 SSR 的实际概率（距上一名 SSR 已有 pity 名新秀）；到达保底线时为 1 */
export function nextRookieSsrChance(pity: number): number {
  const k = Math.max(0, Math.floor(num(pity, 0))) + 1;
  if (k >= ssrThreshold()) return 1;
  return Math.min(1, prdConstant(rookieTierProbabilities().SSR) * k);
}

/** 抽一名程序生成新秀的等级（SSR 先按伪随机判定，未中则在其余等级中按权重） */
function rollRookieTier(rng: Rng, pity: number): Tier {
  if (rng.chance(nextRookieSsrChance(pity))) return 'SSR';
  const w = CONFIG.draft.tierWeights;
  const rest = TIERS.filter((t) => t !== 'SSR');
  return rng.weighted(rest, rest.map((t) => Math.max(0, num(w[t], 0))));
}

/** 本赛季到期的真实新秀条目（含错过登场时机的旧条目），按登场赛季、id 排序（保证确定性） */
function dueRealRookies(state: GameState, ti: number): PlayerIndexEntry[] {
  const due = Object.entries(state.futureRookies ?? {})
    .filter(([, debut]) => num(debut, Infinity) <= ti)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!due.length) return [];
  let index: PlayerIndexEntry[] = [];
  try {
    index = getPlayerIndex() ?? [];
  } catch {
    index = [];
  }
  const byId = new Map(index.map((e) => [e.id, e]));
  const out: PlayerIndexEntry[] = [];
  for (const [id] of due) {
    delete state.futureRookies[id];
    if (state.players[id]) continue; // 已在世界中（如自由选手），不重复生成
    const e = byId.get(id);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 建本届新秀池：真实新秀在前，程序生成新秀补足（池子上限 poolMax，真实新秀优先）。
 * 保底：保底计数到达 ssrPityThreshold - 1 时，下一名程序生成新秀必为 SSR（若还有生成名额，会插在真实新秀之前）。
 */
export function buildRookiePool(state: GameState): { ids: string[]; realCount: number; generatedCount: number; ssrCount: number } {
  const cfg = CONFIG.draft;
  const ti = state.season?.ti ?? 0;
  const ds = rookieDraftState(state);
  const rng = rngOf(state);
  const poolMax = Math.max(0, Math.floor(num(cfg.poolMax, 70)));
  const T = ssrThreshold();

  const real: Player[] = [];
  for (const e of dueRealRookies(state, ti)) {
    if (real.length >= poolMax) break;
    const p = rookieFromIndex(state, e);
    if (!p || p.teamId || p.status !== 'active') continue;
    p.isRookie = true;
    real.push(p);
  }
  let genLeft = clamp(Math.floor(num(cfg.generatedPerSeason, 0)), 0, Math.max(0, poolMax - real.length));
  const generatedTotal = genLeft;
  const posOffset = rng.int(0, POSITIONS.length - 1);

  const ids: string[] = [];
  let ssrCount = 0;
  let realIdx = 0;
  let genIdx = 0;
  while (realIdx < real.length || genLeft > 0) {
    let p: Player;
    if (genLeft > 0 && (ds.ssrPity >= T - 1 || realIdx >= real.length)) {
      const tier: Tier = ds.ssrPity >= T - 1 ? 'SSR' : rollRookieTier(rng, ds.ssrPity);
      const position = POSITIONS[(posOffset + genIdx) % POSITIONS.length];
      genIdx++;
      genLeft--;
      p = generatePlayer(state, { tier, rookie: true, position });
      if (p.teamId) continue;
      p.isRookie = true;
    } else {
      p = real[realIdx++];
    }
    const ssr = playerTier(p) === 'SSR';
    if (ssr) ssrCount++;
    ds.ssrPity = ssr ? 0 : ds.ssrPity + 1;
    ids.push(p.id);
  }
  return { ids, realCount: real.length, generatedCount: generatedTotal, ssrCount };
}

// ---------------------------------------------------------------------------
// 顺位：排名与抽签
// ---------------------------------------------------------------------------

/**
 * 选秀依据的排名（1 = 最好）：上赛季最终排名（team.lastSeasonRank）；新游戏的第一个赛季（无上赛季成绩）按
 * 「实力排名 + 荣誉排名」之和。缺少排名的战队（赛季中新成立的组织等）排在最后，按荣誉、id 决定先后。
 */
export function draftStandings(state: GameState): { ranked: string[]; standing: Record<string, number>; firstSeason: boolean } {
  const teams = activeTeams(state);
  const firstSeason = (state.season?.ti ?? 0) === state.settings?.startTi;
  let ranked: string[];
  if (firstSeason) {
    const byRating = rankTeamsByRating(state, teams.map((t) => t.id));
    const rRank = new Map(byRating.map((id, i) => [id, i]));
    const byHonor = teams.slice().sort((a, b) => num(b.honor, 0) - num(a.honor, 0) || (a.id < b.id ? -1 : 1));
    const hRank = new Map(byHonor.map((t, i) => [t.id, i]));
    ranked = teams
      .map((t) => t.id)
      .sort((a, b) => (rRank.get(a)! + hRank.get(a)!) - (rRank.get(b)! + hRank.get(b)!) || rRank.get(a)! - rRank.get(b)! || (a < b ? -1 : 1));
  } else {
    const key = (t: Team) => (Number.isFinite(t.lastSeasonRank) && (t.lastSeasonRank as number) > 0 ? (t.lastSeasonRank as number) : Infinity);
    ranked = teams
      .slice()
      .sort((a, b) => key(a) - key(b) || num(b.honor, 0) - num(a.honor, 0) || (a.id < b.id ? -1 : 1))
      .map((t) => t.id);
  }
  const standing: Record<string, number> = {};
  ranked.forEach((id, i) => {
    standing[id] = i + 1;
  });
  return { ranked, standing, firstSeason };
}

const lotteryCache = new Map<string, number[][]>();

/**
 * 抽签概率矩阵：P[i][k] = 抽签前第 i 顺位（0 = 最差）的战队最终获得抽签区第 k 个顺位的概率。
 * 前 picks 个顺位按权重逐个不放回抽取，其余按抽签前顺位依次排列（精确枚举，n ≤ 16、picks ≤ 4 时 ≤ 4.4 万条路径）。
 */
export function lotteryProbabilities(weights: readonly number[], picks: number): number[][] {
  const n = weights.length;
  const k = clamp(Math.floor(num(picks, 0)), 0, Math.min(n, 4));
  const w = weights.map((x) => Math.max(0, num(x, 0)));
  const key = `${k}|${w.join(',')}`;
  const hit = lotteryCache.get(key);
  if (hit) return hit;
  const P: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const drawn: number[] = [];
  const dfs = (remaining: number[], prob: number) => {
    const total = remaining.reduce((s, i) => s + w[i], 0);
    if (drawn.length >= k || total <= 0 || !remaining.length) {
      drawn.forEach((idx, pos) => {
        P[idx][pos] += prob;
      });
      remaining.forEach((idx, j) => {
        P[idx][drawn.length + j] += prob;
      });
      return;
    }
    for (const idx of remaining) {
      if (w[idx] <= 0) continue;
      drawn.push(idx);
      dfs(remaining.filter((x) => x !== idx), (prob * w[idx]) / total);
      drawn.pop();
    }
  };
  dfs(Array.from({ length: n }, (_, i) => i), 1);
  lotteryCache.set(key, P);
  return P;
}

/** 抽签概率表（按抽签前顺位，1 = 上赛季排名最差）：状元签概率、进入前 lotteryPicks 的概率、各顺位分布 */
export function lotteryOddsTable(teamCount?: number): { seed: number; weight: number; oddsFirst: number; oddsTop: number; dist: number[] }[] {
  const odds = (CONFIG.draft.lotteryOdds ?? []).map((x) => Math.max(0, num(x, 0)));
  const n = Math.min(odds.length, Math.max(0, Math.floor(num(teamCount, odds.length))));
  const weights = odds.slice(0, n);
  const picks = Math.min(Math.max(0, Math.floor(num(CONFIG.draft.lotteryPicks, 0))), n);
  const P = lotteryProbabilities(weights, picks);
  return weights.map((weight, i) => ({
    seed: i + 1,
    weight,
    oddsFirst: P[i]?.[0] ?? 0,
    oddsTop: (P[i] ?? []).slice(0, picks).reduce((s, x) => s + x, 0),
    dist: P[i] ?? [],
  }));
}

/** 新秀薪资表：总顺位 pick（1 起）、共 totalPicks 个顺位 → 每回合工资（× 赛季经济指数，不低于最低工资） */
export function rookieSlotSalary(state: GameState, pick: number, totalPicks: number): number {
  const cfg = CONFIG.draft;
  const top = Math.max(1, num(cfg.salaryTop, 3000));
  const bottom = clamp(num(cfg.salaryBottom, top), 1, top);
  const n = Math.max(1, Math.floor(num(totalPicks, 1)));
  const t = n > 1 ? clamp((Math.floor(num(pick, 1)) - 1) / (n - 1), 0, 1) : 0;
  const base = top * Math.pow(bottom / top, t);
  return Math.max(CONFIG.economy.minSalary, Math.round(base * seasonEconIndex(state)));
}

/** 新秀合同赛季数（含当前赛季）：按轮次 */
export function rookieContractSeasons(round: number): number {
  const list = CONFIG.draft.contractSeasonsByRound ?? [];
  const v = list[Math.max(0, Math.floor(num(round, 1)) - 1)] ?? list[list.length - 1] ?? 2;
  return Math.max(1, Math.floor(num(v, 2)));
}

// ---------------------------------------------------------------------------
// 自动选人
// ---------------------------------------------------------------------------

function regulars(state: GameState, team: Team): Player[] {
  const out: Player[] = [];
  for (const id of team.playerIds ?? []) {
    const p = state.players[id];
    if (p && p.status === 'active' && p.teamId === team.id && !p.tempSubUntilTournament) out.push(p);
  }
  return out;
}

/**
 * 选秀之后的阵容整理上限：玩家战队 = null（保留全部新秀，选秀从不因阵容人数放弃顺位）；
 * AI 战队 = ai.maxRoster（超出时放走价值最低的非首发，与 AI 阵容管理一致）。
 */
export function postDraftRosterLimit(state: GameState, team: Team): number | null {
  const human = team.isPlayer || isHumanTeam(state, team.id);
  return human ? null : CONFIG.ai.maxRoster;
}

/**
 * AI 阵容整理时的「保留价值」：综合评分 + 天赋 / 年轻潜力（与选秀评分同权重），
 * 让 AI 选秀后优先放走潜力有限的老替补，而不是一律放走刚选中的新秀。
 */
export function aiKeepValue(state: GameState, p: Player): number {
  const cfg = CONFIG.draft;
  const age = ageOf(state, p);
  return overallRating(p)
    + effectiveAttr(p, 'talent') * num(cfg.talentWeight, 0)
    + (20 - (Number.isFinite(age) ? age : 20)) * num(cfg.youthWeight, 0);
}

/**
 * 选秀后 AI 战队超出 ai.maxRoster 时放走价值最低（aiKeepValue）的非首发，进入自由市场（无补偿）。
 * 被放走的本届新秀在选秀记录中标为 released。返回被放走的选手。
 */
function trimAiAfterDraft(state: GameState, team: Team, rec: { picks: RookieDraftPick[] }): Player[] {
  const limit = postDraftRosterLimit(state, team);
  if (limit == null) return [];
  const out: Player[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const roster = regulars(state, team);
    if (roster.length <= limit) break;
    const starters = new Set(POSITIONS.map((pos) => team.lineup?.[pos]).filter((x): x is string => !!x));
    const bench = roster.filter((p) => !starters.has(p.id));
    const pool = bench.length ? bench : roster;
    const victim = pool
      .map((p) => ({ p, v: aiKeepValue(state, p) }))
      .sort((a, b) => a.v - b.v || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))[0]?.p;
    if (!victim) break;
    departToFreeAgency(state, victim.id);
    if (victim.teamId) break; // 防御：未能离队
    const pick = rec.picks.find((x) => x.playerId === victim.id);
    if (pick) pick.released = true;
    out.push(victim);
  }
  return out;
}

/** 新秀对某战队的选秀评分：实力 + 天赋/年龄潜力 + 位置需求（+ AI 自家真实出道新秀） */
export function rookieDraftScore(
  state: GameState,
  team: Team,
  p: Player,
  roster: Player[] = regulars(state, team),
  homeTeam?: string,
): number {
  const cfg = CONFIG.draft;
  const age = ageOf(state, p);
  let score = overallRating(p)
    + effectiveAttr(p, 'talent') * num(cfg.talentWeight, 0)
    + (20 - (Number.isFinite(age) ? age : 20)) * num(cfg.youthWeight, 0);
  const pos: Position = p.position;
  // 位置需求：本职位置（本位置 / 副位置，第十三波）中需求最大的一个（首发空缺 > 能提升首发；副位置按打折后的评分）
  let need = 0;
  for (const q of naturalPositions(p)) {
    const starterId = team.lineup?.[q];
    const starter = starterId ? roster.find((x) => x.id === starterId) : undefined;
    if (!starter) {
      need = Math.max(need, num(cfg.needEmpty, 0));
    } else {
      const diff = playerRating(p, q) - playerRating(starter, q);
      if (diff > 0) need = Math.max(need, Math.min(num(cfg.needUpgradeMax, 0), diff * num(cfg.needUpgrade, 0)));
    }
  }
  score += need;
  const same = roster.filter((q) => q.position === pos).length;
  if (same >= 2) score -= num(cfg.depthPenalty, 0) * (same - 1);
  if (homeTeam && homeTeam === team.id && p.isReal && !team.isPlayer) score += num(cfg.homeTeamBonus, 0);
  return score;
}

/** 从新秀池中为战队挑一名新秀：评分前几名中按 topChoiceWeights 随机 */
function chooseRookie(state: GameState, team: Team, pool: Player[], rng: Rng, homeOf: Map<string, string | undefined>): Player | null {
  if (!pool.length) return null;
  const roster = regulars(state, team);
  const scored = pool
    .map((p) => ({ p, s: rookieDraftScore(state, team, p, roster, homeOf.get(p.id)) }))
    .sort((a, b) => b.s - a.s || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  const weights = (CONFIG.draft.topChoiceWeights ?? [1]).map((x) => Math.max(0, num(x, 0)));
  const top = scored.slice(0, Math.max(1, weights.length));
  const w = top.map((_, i) => weights[i] ?? 0);
  return rng.weighted(top, w).p;
}

// ---------------------------------------------------------------------------
// 选秀大会
// ---------------------------------------------------------------------------

function teamName(state: GameState, id: string | null | undefined): string {
  if (!id) return '未知战队';
  return state.teams[id]?.name ?? id;
}

/**
 * 举行本赛季选秀（season.startSeason 调用；同一赛季只举行一次）：建新秀池 → 排名与抽签 → 逐顺位自动选人 →
 * 落选新秀进入自由市场 → 新闻 + 每位玩家一个弹窗。返回本届记录（已举行过 / 没有战队时返回 null）。
 */
export function runRookieDraft(state: GameState): RookieDraftRecord | null {
  if (state.gameOver || !state.season) return null;
  const ti = state.season.ti;
  const ds = rookieDraftState(state);
  if (ds.history.some((r) => r?.ti === ti)) return null;
  // 旧版抽卡池：取消抽卡后不再使用（剩余选手本就无东家，移出即成为自由选手）
  state.gachaPool = [];

  const cfg = CONFIG.draft;
  const { ranked, standing, firstSeason } = draftStandings(state);
  if (!ranked.length) return null;
  const pool = buildRookiePool(state);
  const rng = rngOf(state);

  // 抽签：排名最差的若干支战队（worst-first）
  const worstFirst = ranked.slice().reverse();
  const odds = (cfg.lotteryOdds ?? []).map((x) => Math.max(0, num(x, 0)));
  const lotteryN = Math.min(odds.length, worstFirst.length);
  const lotteryPicks = Math.min(Math.max(0, Math.floor(num(cfg.lotteryPicks, 0))), lotteryN, 4);
  const lotteryTeams = worstFirst.slice(0, lotteryN);
  const weights = odds.slice(0, lotteryN);
  const P = lotteryProbabilities(weights, lotteryPicks);
  const winners: string[] = [];
  const remaining = lotteryTeams.map((id, i) => ({ id, w: weights[i] }));
  for (let k = 0; k < lotteryPicks; k++) {
    const live = remaining.filter((x) => x.w > 0 && !winners.includes(x.id));
    if (!live.length) break;
    winners.push(rng.weighted(live, live.map((x) => x.w)).id);
  }
  const round1 = [...winners, ...lotteryTeams.filter((id) => !winners.includes(id)), ...worstFirst.slice(lotteryN)];
  const lottery: RookieDraftLotteryEntry[] = lotteryTeams.map((id, i) => ({
    teamId: id,
    standing: standing[id] ?? 0,
    seed: i + 1,
    weight: weights[i],
    oddsFirst: P[i]?.[0] ?? 0,
    oddsTop: (P[i] ?? []).slice(0, lotteryPicks).reduce((s, x) => s + x, 0),
    finalPick: round1.indexOf(id) + 1,
    won: winners.includes(id),
  }));

  // 逐顺位选人
  const rounds = Math.max(1, Math.floor(num(cfg.rounds, 2)));
  const totalPicks = round1.length * rounds;
  let homeOf = new Map<string, string | undefined>();
  try {
    homeOf = new Map((getPlayerIndex() ?? []).map((e) => [e.id, e.firstTeamId]));
  } catch {
    /* 无索引：不加自家新秀加成 */
  }
  const available: Player[] = pool.ids
    .map((id) => state.players[id])
    .filter((p): p is Player => !!p && !p.teamId && p.status === 'active');
  const picks: RookieDraftPick[] = [];
  const draftedTeams = new Set<string>();
  let overall = 0;
  for (let r = 1; r <= rounds && available.length; r++) {
    const order = r === 1 ? round1 : worstFirst;
    for (const teamId of order) {
      if (!available.length) break;
      overall++;
      const team = state.teams[teamId];
      const pick: RookieDraftPick = { round: r, pick: overall, teamId };
      if (r === 1 && winners.includes(teamId)) pick.lottery = true;
      // 不论阵容人数，每支战队都按顺位选人（玩家战队超出常规上限也照选；AI 战队选秀后再整理阵容）
      const p = team && !team.disbanded ? chooseRookie(state, team, available, rng, homeOf) : null;
      if (!team || !p) {
        picks.push(pick); // 防御：战队已不存在（不会发生：顺位只含未解散战队）
        continue;
      }
      const salary = rookieSlotSalary(state, overall, totalPicks);
      addPlayerToTeam(state, p.id, team.id, { salary, contractSeasons: rookieContractSeasons(r) });
      if (p.teamId !== team.id) {
        picks.push(pick);
        continue;
      }
      available.splice(available.indexOf(p), 1);
      p.draft = { ti, round: r, pick: overall, teamId: team.id };
      delete p.gachaSeason;
      draftedTeams.add(team.id);
      Object.assign(pick, {
        playerId: p.id,
        handle: p.handle,
        tier: playerTier(p),
        position: p.position,
        isReal: !!p.isReal,
        power: Math.round(num(p.power, 0) * 10) / 10,
        talent: Math.round(num(p.talent, 0)),
        age: ageOf(state, p),
        salary: p.salary,
        contractUntil: p.contractUntil,
      });
      picks.push(pick);
    }
  }
  // AI 战队：新秀可能直接胜任首发 → 自动排阵，再把阵容整理回 ai.maxRoster（放走价值最低的非首发）；
  // 玩家战队保留全部新秀与原安排（只有空着的首发位由 addPlayerToTeam / 开季 fillEmptyLineupSlots 补上）
  for (const id of draftedTeams) {
    const t = state.teams[id];
    if (!t || t.isPlayer || isHumanTeam(state, id)) continue;
    autoLineup(state, id);
    if (trimAiAfterDraft(state, t, { picks }).length) autoLineup(state, id);
  }

  const record: RookieDraftRecord = {
    ti,
    rounds,
    firstSeason: firstSeason || undefined,
    order: round1,
    standings: standing,
    lotteryPicks,
    lottery,
    picks,
    realCount: pool.realCount,
    generatedCount: pool.generatedCount,
    ssrCount: pool.ssrCount,
    undrafted: available.map((p) => p.id),
  };
  ds.history.push(record);
  const keep = Math.max(1, Math.floor(num(cfg.historyMax, 20)));
  if (ds.history.length > keep) ds.history.splice(0, ds.history.length - keep);

  draftNews(state, record);
  forEachSeat(state, (me) => {
    if (state.teams[me]) pushPopup(state, { kind: 'rookie_draft', ti });
  });
  return record;
}

/** 选秀新闻：状元签、选秀大会（前几顺位 + 高等级/真实新秀）、各玩家战队的新秀 */
function draftNews(state: GameState, rec: RookieDraftRecord): void {
  const cfg = CONFIG.draft;
  const made = rec.picks.filter((p) => p.playerId);
  const label = (pk: RookieDraftPick) =>
    `${pk.handle ?? pk.playerId}（${pk.tier ?? '?'} · ${pk.position ? POSITION_LABEL[pk.position] : '?'}${pk.isReal ? ' · 真实新秀' : ''}）`;

  if (rec.lottery.length && rec.lotteryPicks > 0) {
    const first = rec.order[0];
    const e = rec.lottery.find((x) => x.teamId === first);
    const lines = rec.order.slice(0, rec.lotteryPicks).map((id, i) => {
      const le = rec.lottery.find((x) => x.teamId === id);
      return `${i + 1}. ${teamName(state, id)}（抽签前第 ${le?.seed ?? '?'} 顺位，状元签概率 ${((le?.oddsFirst ?? 0) * 100).toFixed(1)}%）`;
    });
    addNews(
      state,
      'transfer',
      `【选秀抽签】${teamName(state, first)} 抽中 TI${rec.ti} 状元签`,
      `${rec.firstSeason ? '按初始实力与荣誉排名' : '按上赛季最终排名'}，排名最差的 ${rec.lottery.length} 支战队参加了选秀抽签`
        + `（${teamName(state, first)} 赛前状元签概率 ${((e?.oddsFirst ?? 0) * 100).toFixed(1)}%）。前 ${rec.lotteryPicks} 顺位：\n${lines.join('\n')}`,
      true,
      { teamIds: rec.order.slice(0, rec.lotteryPicks), tags: ['draft'] },
    );
  }

  const top = Math.max(0, Math.floor(num(cfg.newsTopPicks, 5)));
  const notableIdx = tierIndex(cfg.notableTier ?? 'SS');
  const maxLines = Math.max(1, Math.floor(num(cfg.newsMaxLines, 16)));
  const lines: string[] = [];
  const listed = new Set<number>();
  let more = 0;
  for (const pk of made) {
    const notable = pk.pick <= top || (pk.tier && tierIndex(pk.tier) >= notableIdx) || pk.isReal;
    if (!notable) continue;
    if (lines.length >= maxLines) {
      more++;
      continue;
    }
    listed.add(pk.pick);
    lines.push(`第 ${pk.pick} 顺位 · ${teamName(state, pk.teamId)}：${label(pk)}`);
  }
  if (more) lines.push(`……另有 ${more} 名真实新秀 / 高等级新秀被选中，完整结果见「转会 › 新秀选秀」。`);
  const released = rec.picks.filter((p) => p.playerId && p.released).length;
  const firstPick = made[0];
  const summary = `新秀池 ${rec.realCount + rec.generatedCount} 人（真实新秀 ${rec.realCount} 人`
    + `${rec.ssrCount ? `，SSR ${rec.ssrCount} 人` : ''}），共 ${rec.rounds} 轮，选中 ${made.length} 人`
    + `${released ? `（其中 ${released} 人因所属战队阵容调整随即进入自由市场）` : ''}`
    + `${rec.undrafted.length ? `，${rec.undrafted.length} 人落选进入自由市场` : ''}。`;
  addNews(
    state,
    'transfer',
    firstPick
      ? `【选秀大会】TI${rec.ti} 新秀选秀落幕：状元 ${firstPick.handle} 加盟 ${teamName(state, firstPick.teamId)}`
      : `【选秀大会】TI${rec.ti} 新秀选秀落幕`,
    `${summary}${lines.length ? `\n${lines.join('\n')}` : ''}`,
    true,
    { teamIds: firstPick ? [firstPick.teamId] : [], playerIds: made.filter((p) => listed.has(p.pick)).map((p) => p.playerId!).slice(0, 20), tags: ['draft'] },
  );

  // 各玩家战队的新秀（公开）
  const humans = new Set(made.map((p) => p.teamId).filter((id) => state.teams[id]?.isPlayer || isHumanTeam(state, id)));
  for (const id of humans) {
    const mine = made.filter((p) => p.teamId === id);
    addNews(
      state,
      'transfer',
      `【选秀】${teamName(state, id)} 选中 ${mine.map((p) => p.handle).join('、')}`,
      `${teamName(state, id)} 在 TI${rec.ti} 新秀选秀中选中：\n${mine
        .map((p) => `第 ${p.round} 轮第 ${p.pick} 顺位 · ${label(p)}，工资 ${formatGold(p.salary ?? 0)}/回合，新秀合同至 TI${p.contractUntil}`)
        .join('\n')}\n新秀全部入队，首发与替补由主教练安排；赛季初（开始赛季前）可在「转会 › 新秀选秀」免费放弃不需要的新秀。`,
      false,
      { teamIds: [id], playerIds: mine.map((p) => p.playerId!), tags: ['draft'] },
    );
  }
}

// ---------------------------------------------------------------------------
// 玩家操作
// ---------------------------------------------------------------------------

/**
 * 选手是否仍以「选秀合同」效力于选中他的战队：被放弃（选秀记录 released）后即使又被原队从自由市场签回，
 * 也已是普通合同，不再算本届新秀（不能再免费放弃）。
 */
function onDraftContract(state: GameState, p: Player): boolean {
  const d = p.draft;
  if (!d || p.teamId !== d.teamId) return false;
  const pick = rookieDraftRecord(state, d.ti)?.picks.find((x) => x?.playerId === p.id);
  return !pick?.released;
}

/** 不能免费放弃该新秀的原因（null = 可以） */
export function draftedRookieReleaseBlock(state: GameState, p: Player | null | undefined): string | null {
  const me = state.settings?.playerTeamId;
  const team = me ? state.teams[me] : undefined;
  if (!team || team.disbanded) return '战队不存在';
  if (state.gameOver) return '游戏已结束';
  if (!p || p.teamId !== team.id) return '该选手不在你的战队';
  if (!p.draft || p.draft.ti !== state.season?.ti || p.draft.teamId !== team.id || !onDraftContract(state, p)) {
    return '只能放弃本届选秀中选中的新秀';
  }
  if (state.phase !== 'preseason') return '只能在赛季初（开始赛季前）免费放弃选中的新秀';
  return null;
}

/** 本届选秀中被某战队选中、仍以选秀合同在队的新秀 */
export function draftedRookiesOf(state: GameState, teamId: string, ti: number = state.season?.ti ?? 0): Player[] {
  const team = state.teams[teamId];
  if (!team) return [];
  return (team.playerIds ?? [])
    .map((id) => state.players[id])
    .filter((p): p is Player => !!p && p.teamId === teamId && p.status === 'active' && p.draft?.ti === ti && p.draft.teamId === teamId
      && onDraftContract(state, p))
    .sort((a, b) => (a.draft?.pick ?? 0) - (b.draft?.pick ?? 0));
}

/** 免费放弃本届选秀中选中的新秀（仅赛季初）：离队进入自由市场，无解约补偿、不扣荣誉 */
export function releaseDraftedRookie(state: GameState, playerId: string): OpResult {
  const p = typeof playerId === 'string' ? state.players[playerId] : undefined;
  const block = draftedRookieReleaseBlock(state, p);
  if (block || !p) return fail(block ?? '该选手不在你的战队');
  const team = state.teams[state.settings.playerTeamId];
  departToFreeAgency(state, p.id);
  if (p.teamId) return fail(`未能放弃 ${p.handle}`);
  const rec = rookieDraftRecord(state, p.draft!.ti);
  const pick = rec?.picks.find((x) => x.playerId === p.id);
  if (pick) pick.released = true;
  addNews(
    state,
    'transfer',
    `【新秀】${team.name} 放弃新秀 ${p.handle}`,
    `${team.name} 放弃了在 TI${p.draft!.ti} 选秀第 ${p.draft!.pick} 顺位选中的 ${p.handle}（${playerTier(p)} · ${POSITION_LABEL[p.position]}），他将以自由选手身份寻找新东家。`,
    false,
    { teamIds: [team.id], playerIds: [p.id], actorTeamId: team.id, tags: ['draft'] },
  );
  syncSynergies(state); // 羁绊（第十波 #5）：真实新秀也可能是羁绊成员，放弃后立即同步
  return ok(`已放弃 ${p.handle}（无费用），他已进入自由市场`);
}
