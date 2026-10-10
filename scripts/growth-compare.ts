// 成长对照模拟（平衡性调试）：同一起点 / 同一种子，对比两种经营策略下本队选手的成长、花费与收入。
// 用法：npx tsx scripts/growth-compare.ts --ti 9 --seasons 4 [--seeds 3] [--seed 1] [--team new|<seedTeamId>]
//        [--extra 3] [--scrims 1] [--reserve 6] [--funds N] [--strategies train,tour,mix] [--quiet] [--json <file>]
//   train  「狂练」：不报名可选赛事并婉拒邀请（TI 预选 / 正赛照常），每个休赛回合用免费训练 + 加购 --extra 次额外训练
//          + 其中 --scrims 次改为训练赛（选当前倍数最高、付得起的对手）；只花「预计赛季末资金 − --reserve 回合工资」以内的钱（不欠薪）
//   tour   「只打比赛」：报名全部开放赛事、接受全部邀请，从不手动训练（休赛回合的免费训练在回合结束时自动完成）
//   mix    「大赛 + 狂练」（--strategies train,tour,mix 时运行）：只打 Major / 顶级赛事（报名 + 接受邀请，其余婉拒），休赛回合按 train 的方式训练
// 统计（按赛季）：
//   - 本队选手（赛季初在队的首发 / 替补）成长：赛季内 = 第 1 回合 → TI 回合结束前；
//     净成长 = 第 1 回合 → 下赛季第 1 回合（含年龄衰退、赛季自主成长与天梯校准；末季只有赛季内）。
//     分组：年轻高天赋（≤22 岁且天赋 ≥70）、年轻低天赋（≤22 岁且天赋 <55）、其余 ≤25 岁、26 岁以上。
//   - 本队财务：训练 + 训练赛花费、全部收入、赛季末资金、荣誉。
//   - 联赛：TI 回合首发 SS+ 占比、SSR 人数、首发有效战力前十均值；AI 战队首发赛季内成长（按年龄组）。
import { writeFileSync } from 'node:fs';
import { registerNodeRosterLoader } from './nodeData';
import type { GameState, NewGameOptions, Player, Tournament } from '../src/engine/types';
import { MAX_TI } from '../src/engine/config';
import { POSITIONS } from '../src/engine/types';
import {
  advance, buyExtraTraining, createNewGame, currentPlayerTournament, doScrim, doTraining, fillLineupWithTempSubs,
  getAdvanceBlockers, quickSimTournament, trainingBlockReason, trainingSessionsLeft,
} from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { registerForTournament, unregisterFromTournament } from '../src/engine/schedule';
import { extraTrainingCost, roundWageBill, scrimCost } from '../src/engine/economy';
import { seasonProjection } from '../src/engine/revenue';
import { scrimMultiplier } from '../src/engine/growth';
import { isScrimBooked } from '../src/engine/trainingLog';
import { roundKindForPlayer } from '../src/engine/calendar';
import { autoLineup, benchPlayers, lineupPlayers, rosterRoom, validateLineup } from '../src/engine/team';
import { ageOf, effectivePower, overallRating, tierIndex, tierOf } from '../src/engine/player';
import { draftedRookiesOf, releaseDraftedRookie } from '../src/engine/rookieDraft';
import { freeAgents, isTransferWindowOpen, releasePlayer, signFreeAgent, signingFee } from '../src/engine/market';
import { talkToPlayer, talkedThisRound } from '../src/engine/squadOps';
import { isHumanTeam } from '../src/engine/seat';
import { formatGold } from '../src/engine/util';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const num = (v: string | true | undefined, d: number) => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d);
const START_TI = Math.max(1, Math.min(MAX_TI, Math.round(num(args.ti, 9))));
const SEASONS = Math.max(1, Math.min(MAX_TI - START_TI + 1, Math.round(num(args.seasons, 4))));
const SEEDS = Math.max(1, Math.round(num(args.seeds, 3)));
const SEED0 = Math.round(num(args.seed, 1));
const TEAM = typeof args.team === 'string' ? args.team : 'new';
const EXTRA = Math.max(0, Math.round(num(args.extra, 3)));
const SCRIMS = Math.max(0, Math.round(num(args.scrims, 1)));
/** 狂练的资金安全垫：始终留足此数回合的工资 */
const RESERVE_ROUNDS = Math.max(0, num(args.reserve, 6));
/** 覆盖本队初始资金（两种策略相同；脱离经济约束单看训练效果） */
const FUNDS = typeof args.funds === 'string' && Number.isFinite(Number(args.funds)) ? Number(args.funds) : null;
const QUIET = args.quiet === true;
const JSON_OUT = typeof args.json === 'string' ? args.json : null;

type Strategy = 'train' | 'tour' | 'mix';
const STRATEGY_LABEL: Record<Strategy, string> = { train: '狂练', tour: '只打比赛', mix: '大赛 + 狂练' };
const STRATEGIES: Strategy[] = (typeof args.strategies === 'string' ? args.strategies.split(',') : ['train', 'tour'])
  .filter((x): x is Strategy => x in STRATEGY_LABEL);

// ---------------------------------------------------------------------------
// 统计结构
// ---------------------------------------------------------------------------
type Group = 'youngTalented' | 'youngLow' | 'mid' | 'vet';
const GROUPS: Group[] = ['youngTalented', 'youngLow', 'mid', 'vet'];
const GROUP_LABEL: Record<Group, string> = {
  youngTalented: '≤22岁·天赋≥70', youngLow: '≤22岁·天赋<55', mid: '其余≤25岁', vet: '26岁以上',
};

interface Snap {
  power: number;
  mmr: number;
  insight: number;
  resilience: number;
}
interface Delta extends Snap {
  n: number;
}
const zero = (): Delta => ({ n: 0, power: 0, mmr: 0, insight: 0, resilience: 0 });
const snapOf = (p: Player): Snap => ({ power: p.power, mmr: p.mmr, insight: p.insight, resilience: p.resilience });

interface Tracked {
  id: string;
  group: Group;
  starter: boolean;
  start: Snap;
  ti?: Snap;
}

interface SeasonStats {
  ti: number;
  /** 本队选手成长（首发 / 全部），赛季内与净成长 */
  inSeason: Record<Group, { starters: Delta; all: Delta }>;
  net: Record<Group, { starters: Delta; all: Delta }>;
  trainingSpend: number;
  income: number;
  goldEnd: number;
  honorEnd: number;
  sessions: number;
  extras: number;
  scrims: number;
  tournamentsPlayed: number;
  restRounds: number;
  /** 联赛（TI 回合） */
  league: { starters: number; ssPlus: number; ssr: number; top10: number; top10Ai: number; resilience: number };
  /** AI 战队首发的赛季内成长（按年龄组） */
  aiGrowth: Record<Group, Delta>;
  /** AI 战队首发的净成长（第 1 回合 → 下赛季第 1 回合，含年龄与自主成长） */
  aiNet: Record<Group, Delta>;
}

function emptyGroups(): Record<Group, { starters: Delta; all: Delta }> {
  return Object.fromEntries(GROUPS.map((g) => [g, { starters: zero(), all: zero() }])) as Record<Group, { starters: Delta; all: Delta }>;
}

function groupOf(age: number, talent: number): Group {
  if (age <= 22 && talent >= 70) return 'youngTalented';
  if (age <= 22 && talent < 55) return 'youngLow';
  if (age <= 25) return 'mid';
  return 'vet';
}

function addDelta(d: Delta, from: Snap, to: Snap): void {
  d.n++;
  d.power += to.power - from.power;
  d.mmr += to.mmr - from.mmr;
  d.insight += to.insight - from.insight;
  d.resilience += to.resilience - from.resilience;
}

// ---------------------------------------------------------------------------
// 自动经营
// ---------------------------------------------------------------------------
const me = (state: GameState) => state.teams[state.settings.playerTeamId];

function resolveAll(state: GameState): void {
  for (let guard = 0; guard < 50 && state.pendingDecisions.length; guard++) {
    const d = state.pendingDecisions[0];
    try {
      resolveDecision(state, d.id, d.choices[0]?.id ?? '');
    } catch {
      /* 交给下面移除 */
    }
    if (state.pendingDecisions[0] === d) state.pendingDecisions.shift();
  }
}

function trimRoster(state: GameState): void {
  const team = me(state);
  for (let guard = 0; guard < 10 && rosterRoom(state, team.id) < 0; guard++) {
    const victim = benchPlayers(state, team.id).filter((p) => !p.tempSubUntilTournament)
      .sort((a, b) => overallRating(a) - overallRating(b))[0];
    if (!victim) break;
    const free = victim.draft?.ti === state.season.ti && state.phase === 'preseason';
    const r = free ? releaseDraftedRookie(state, victim.id) : releasePlayer(state, victim.id);
    if (!r.ok) break;
  }
}

function fillEmptyPositions(state: GameState): void {
  const team = me(state);
  if (!team || !isTransferWindowOpen(state) || POSITIONS.every((pos) => team.lineup[pos])) return;
  const regulars = team.playerIds.map((id) => state.players[id])
    .filter((p) => p && p.status === 'active' && !p.tempSubUntilTournament && !p.isWildSub).length;
  if (regulars >= POSITIONS.length) {
    autoLineup(state, team.id);
    return;
  }
  for (const pos of POSITIONS) {
    if (team.lineup[pos] || rosterRoom(state, team.id) <= 0) continue;
    const reserve = roundWageBill(state, team.id) * 6;
    const pool = freeAgents(state).filter((p) => p.position === pos);
    const strong = pool.filter((p) => signingFee(state, p) + p.salary * 6 < team.gold - reserve).slice(0, 4);
    const cheap = pool.filter((p) => !strong.includes(p) && signingFee(state, p) <= team.gold)
      .sort((a, b) => signingFee(state, a) + a.salary - (signingFee(state, b) + b.salary)).slice(0, 4);
    for (const p of [...strong, ...cheap]) if (signFreeAgent(state, p.id).ok) break;
  }
  autoLineup(state, team.id);
}

const isTiPhase = (t: Tournament) => t.tier === 'ti' || !!t.advanceToTi;
/** 该策略要打的可选赛事（TI 阶段赛事必须参加，不在此列） */
const wants = (strategy: Strategy, t: Tournament) => strategy === 'tour' || (strategy === 'mix' && (t.tier === 'major' || t.tier === 'premier'));

/** 赛季初：tour 报名全部开放赛事；train 婉拒全部可选赛事。两者都只保留天赋 ≥ 60 或能进首发的新秀 */
function preseason(state: GameState, strategy: Strategy): void {
  const ts = state.seasonTournamentIds.map((id) => state.tournaments[id]).filter((t): t is Tournament => !!t && !isTiPhase(t));
  for (const t of ts.filter((x) => x.playerStatus === 'open' && wants(strategy, x)).sort((a, b) => b.prizePool - a.prizePool)) {
    registerForTournament(state, t.id);
  }
  const team = me(state);
  const starters = lineupPlayers(state, team.id).filter((s) => s.player).map((s) => overallRating(s.player!));
  const weakest = starters.length ? Math.min(...starters) : 0;
  for (const p of draftedRookiesOf(state, team.id)) {
    if (p.isReal || p.talent >= 60 || overallRating(p) >= weakest) continue;
    releaseDraftedRookie(state, p.id);
  }
  autoLineup(state, team.id);
  trimRoster(state);
}

/** train / mix：每回合把之后回合中不打算参加的可选赛事（邀请 / 报名）退掉 */
function declineOptional(state: GameState, strategy: Strategy): void {
  for (const id of state.seasonTournamentIds) {
    const t = state.tournaments[id];
    if (!t || isTiPhase(t) || t.status !== 'scheduled' || t.roundIndex <= state.roundIndex || wants(strategy, t)) continue;
    if (t.playerStatus === 'invited' || t.playerStatus === 'registered') unregisterFromTournament(state, t.id);
  }
}

function talkToUnhappy(state: GameState): void {
  const team = me(state);
  if (!team || state.gameOver) return;
  for (const id of team.playerIds) {
    const p = state.players[id];
    if (!p || p.status !== 'active' || p.tempSubUntilTournament || p.isWildSub || p.loyalty >= 60) continue;
    if (!talkedThisRound(state, id)) talkToPlayer(state, id);
  }
}

interface Counters {
  sessions: number;
  extras: number;
  scrims: number;
}

function trainHard(state: GameState, c: Counters): void {
  if (trainingBlockReason(state)) return;
  const team = me(state);
  // 可支配资金 = 预计赛季末资金（当前资金 + 剩余回合经常性收入 − 工资）− 安全垫（RESERVE_ROUNDS 回合工资）：不会因训练欠薪
  const spare = () => Math.min(team.gold, seasonProjection(state, team.id).projectedEnd) - roundWageBill(state, team.id) * RESERVE_ROUNDS;
  for (let i = 0; i < EXTRA; i++) {
    if (state.extraTrainingBoughtThisRound > i) continue;
    if (extraTrainingCost(state) >= spare() || !buyExtraTraining(state).ok) break;
    c.extras++;
  }
  for (let s = 0; s < SCRIMS && trainingSessionsLeft(state) > 0; s++) {
    const best = Object.values(state.teams)
      .filter((t) => !t.disbanded && t.id !== team.id && t.playerIds.length >= 5 && !isScrimBooked(state, t.id)) // 每支对手每回合限约次数
      .map((t) => ({ t, mult: scrimMultiplier(state, team.id, t.id), cost: scrimCost(state, t.id) }))
      .filter((x) => x.cost < spare())
      .sort((a, b) => b.mult - a.mult || a.cost - b.cost)[0];
    if (!best || !doScrim(state, best.t.id).ok) break;
    c.scrims++;
    c.sessions++;
  }
  for (let guard = 0; guard < 10 && trainingSessionsLeft(state) > 0; guard++) {
    if (!doTraining(state).ok) break;
    c.sessions++;
  }
}

function playTournament(state: GameState): void {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = currentPlayerTournament(state);
    if (!cur && !state.activeMatch) return;
    resolveAll(state);
    if (cur && validateLineup(state, state.settings.playerTeamId, cur.id).length) fillLineupWithTempSubs(state);
    const r = quickSimTournament(state);
    if (r.ok) return;
    if (/阵容|首发|替补/.test(r.message)) {
      if (!fillLineupWithTempSubs(state).ok) {
        autoLineup(state, state.settings.playerTeamId, currentPlayerTournament(state)?.id);
        if (attempt >= 2) return;
      }
    } else if (attempt >= 1) return;
  }
}

// ---------------------------------------------------------------------------
// 单局
// ---------------------------------------------------------------------------
function leagueStats(state: GameState): SeasonStats['league'] {
  const ps: Player[] = [];
  const aiPs: Player[] = [];
  for (const t of Object.values(state.teams)) {
    if (t.disbanded) continue;
    for (const pos of POSITIONS) {
      const p = t.lineup?.[pos] ? state.players[t.lineup[pos]!] : undefined;
      if (!p || p.status !== 'active') continue;
      ps.push(p);
      if (!isHumanTeam(state, t.id)) aiPs.push(p);
    }
  }
  const top10 = (xs: Player[]) => {
    const eff = xs.map((p) => effectivePower(p)).sort((a, b) => b - a).slice(0, 10);
    return eff.reduce((a, b) => a + b, 0) / Math.max(1, eff.length);
  };
  return {
    starters: ps.length,
    ssPlus: ps.filter((p) => tierIndex(tierOf(p.mmr)) >= tierIndex('SS')).length,
    ssr: ps.filter((p) => tierOf(p.mmr) === 'SSR').length,
    top10: top10(ps),
    top10Ai: top10(aiPs),
    resilience: ps.reduce((a, p) => a + p.resilience, 0) / Math.max(1, ps.length),
  };
}

function snapshotTeam(state: GameState): Tracked[] {
  const team = me(state);
  if (!team) return [];
  const starters = new Set(POSITIONS.map((pos) => team.lineup?.[pos]).filter(Boolean) as string[]);
  return team.playerIds.map((id) => state.players[id])
    .filter((p): p is Player => !!p && p.status === 'active' && !p.tempSubUntilTournament && !p.isWildSub)
    .map((p) => ({ id: p.id, group: groupOf(ageOf(state, p), p.talent), starter: starters.has(p.id), start: snapOf(p) }));
}

function snapshotAi(state: GameState): Map<string, { group: Group; start: Snap }> {
  const out = new Map<string, { group: Group; start: Snap }>();
  for (const t of Object.values(state.teams)) {
    if (t.disbanded || isHumanTeam(state, t.id)) continue;
    for (const pos of POSITIONS) {
      const p = t.lineup?.[pos] ? state.players[t.lineup[pos]!] : undefined;
      if (p && p.status === 'active') out.set(p.id, { group: groupOf(ageOf(state, p), p.talent), start: snapOf(p) });
    }
  }
  return out;
}

async function runOnce(seed: number, strategy: Strategy): Promise<SeasonStats[]> {
  const opts: NewGameOptions = {
    startTi: START_TI,
    seasons: SEASONS,
    difficulty: 'normal',
    managerName: '对照经理',
    seed,
    ...(TEAM === 'new'
      ? { newClub: { name: 'Headless Gaming', tag: 'HG', region: 'CN' as const, color: '#c23c2a' } }
      : { teamId: TEAM }),
  };
  const state = await createNewGame(opts);
  if (FUNDS !== null) {
    me(state).gold = Math.round(FUNDS);
    state.season.goldStart = me(state).gold;
  }
  const out: SeasonStats[] = [];
  let prepared = -1;
  let tracked: Tracked[] = [];
  let ai = new Map<string, { group: Group; start: Snap }>();
  let cur: SeasonStats | null = null;
  let c: Counters = { sessions: 0, extras: 0, scrims: 0 };
  let tourIds = new Set<string>();
  let rest = 0;
  let lastRound = -1;
  let stuck = 0;

  const closeNet = () => {
    // 上赛季的净成长：上赛季第 1 回合 → 本赛季第 1 回合
    const prev = out[out.length - 1];
    if (!prev) return;
    for (const [id, a] of ai) {
      const p = state.players[id];
      if (p && p.status === 'active') addDelta(prev.aiNet[a.group], a.start, snapOf(p));
    }
    for (const tr of tracked) {
      const p = state.players[tr.id];
      if (!p || p.status !== 'active') continue;
      addDelta(prev.net[tr.group].all, tr.start, snapOf(p));
      if (tr.starter) addDelta(prev.net[tr.group].starters, tr.start, snapOf(p));
    }
  };

  for (let steps = 0; !state.gameOver && steps < 6000; steps++) {
    state.popups.length = 0;
    resolveAll(state);
    if (state.phase === 'preseason' && prepared !== state.season.ti) {
      prepared = state.season.ti;
      preseason(state, strategy);
    }
    if (state.phase === 'regular' && state.roundIndex === 1 && (!cur || cur.ti !== state.season.ti)) {
      closeNet();
      tracked = snapshotTeam(state);
      ai = snapshotAi(state);
      c = { sessions: 0, extras: 0, scrims: 0 };
      tourIds = new Set();
      rest = 0;
      cur = {
        ti: state.season.ti, inSeason: emptyGroups(), net: emptyGroups(), trainingSpend: 0, income: 0, goldEnd: 0, honorEnd: 0,
        sessions: 0, extras: 0, scrims: 0, tournamentsPlayed: 0, restRounds: 0,
        league: { starters: 0, ssPlus: 0, ssr: 0, top10: 0, top10Ai: 0, resilience: 0 },
        aiGrowth: Object.fromEntries(GROUPS.map((g) => [g, zero()])) as Record<Group, Delta>,
        aiNet: Object.fromEntries(GROUPS.map((g) => [g, zero()])) as Record<Group, Delta>,
      };
      out.push(cur);
    }
    if (strategy !== 'tour' && state.phase === 'regular') declineOptional(state, strategy);
    fillEmptyPositions(state);
    talkToUnhappy(state);
    const kind = roundKindForPlayer(state, state.roundIndex);
    if ((kind === 'rest' || kind === 'ti_watch') && lastRound !== state.roundIndex) {
      rest++;
      lastRound = state.roundIndex;
      if (strategy !== 'tour') trainHard(state, c);
    }
    const t = currentPlayerTournament(state);
    if (t) tourIds.add(t.id);
    if (t || state.activeMatch) playTournament(state);

    if (cur && state.phase === 'ti' && state.roundIndex === state.season.rounds.length - 1) {
      for (const tr of tracked) {
        const p = state.players[tr.id];
        if (!p || p.status !== 'active' || p.teamId !== state.settings.playerTeamId) continue;
        tr.ti = snapOf(p);
        addDelta(cur.inSeason[tr.group].all, tr.start, tr.ti);
        if (tr.starter) addDelta(cur.inSeason[tr.group].starters, tr.start, tr.ti);
      }
      for (const [id, a] of ai) {
        const p = state.players[id];
        if (p && p.status === 'active') addDelta(cur.aiGrowth[a.group], a.start, snapOf(p));
      }
      cur.league = leagueStats(state);
      const ti = state.season.ti;
      const fin = state.finance.filter((f) => f.season === ti);
      cur.trainingSpend = -fin.filter((f) => f.category === 'training' || f.category === 'scrim').reduce((a, f) => a + f.amount, 0);
      cur.income = fin.filter((f) => f.amount > 0).reduce((a, f) => a + f.amount, 0);
      cur.sessions = c.sessions;
      cur.extras = c.extras;
      cur.scrims = c.scrims;
      cur.tournamentsPlayed = tourIds.size;
      cur.restRounds = rest;
    }

    const ti0 = state.season.ti;
    const r = advance(state);
    if (cur && cur.ti === ti0 && state.season.ti !== ti0 || (cur && state.gameOver && !cur.goldEnd)) {
      const s = state.history.seasons.find((x) => x.ti === cur!.ti);
      cur.goldEnd = s?.goldEnd ?? Math.round(me(state)?.gold ?? 0);
      cur.honorEnd = s?.honorEnd ?? Math.round(me(state)?.honor ?? 0);
    }
    if (r.ok) {
      stuck = 0;
      continue;
    }
    for (const b of getAdvanceBlockers(state)) {
      if (b.code === 'pending_decision') resolveAll(state);
      else if (b.code === 'tournament_running' || b.code === 'match_in_progress') playTournament(state);
      else if (b.code === 'lineup_invalid' && currentPlayerTournament(state)) fillLineupWithTempSubs(state);
    }
    if (++stuck > 25) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function mergeDelta(a: Delta, b: Delta): void {
  a.n += b.n;
  a.power += b.power;
  a.mmr += b.mmr;
  a.insight += b.insight;
  a.resilience += b.resilience;
}
const avg = (d: Delta) => (d.n ? { power: d.power / d.n, mmr: d.mmr / d.n, insight: d.insight / d.n, resilience: d.resilience / d.n } : null);
const fmtD = (d: Delta) => {
  const a = avg(d);
  if (!a) return '—'.padEnd(34);
  return `n${String(d.n).padEnd(3)} 战${a.power >= 0 ? '+' : ''}${a.power.toFixed(2)} 梯${a.mmr >= 0 ? '+' : ''}${Math.round(a.mmr)} 灵${a.insight >= 0 ? '+' : ''}${a.insight.toFixed(2)} 韧${a.resilience >= 0 ? '+' : ''}${a.resilience.toFixed(2)}`.padEnd(34);
};

async function main(): Promise<void> {
  registerNodeRosterLoader();
  const all: Record<Strategy, SeasonStats[][]> = { train: [], tour: [], mix: [] };
  for (let i = 0; i < SEEDS; i++) {
    for (const st of STRATEGIES) all[st].push(await runOnce(SEED0 + i, st));
  }

  const summary: Record<string, unknown> = {};
  console.log(`== 成长对照：TI${START_TI} 起 ${SEASONS} 季 · ${TEAM === 'new' ? '新俱乐部' : TEAM} · 种子 ${SEED0}..${SEED0 + SEEDS - 1} · 狂练加购 ${EXTRA} 次 / 训练赛 ${SCRIMS} 次`);
  for (const st of STRATEGIES) {
    const runs = all[st];
    const inS = emptyGroups();
    const net = emptyGroups();
    const aiG = Object.fromEntries(GROUPS.map((g) => [g, zero()])) as Record<Group, Delta>;
    const aiN = Object.fromEntries(GROUPS.map((g) => [g, zero()])) as Record<Group, Delta>;
    let spend = 0;
    let income = 0;
    let goldEnd = 0;
    let honorEnd = 0;
    let rows = 0;
    let sessions = 0;
    let extras = 0;
    let scrims = 0;
    let tours = 0;
    let rest = 0;
    const leagueBySeason = new Map<number, { n: number; ssPlus: number; ssr: number; top10: number; top10Ai: number; resilience: number }>();
    for (const run of runs) {
      for (const s of run) {
        for (const g of GROUPS) {
          mergeDelta(inS[g].starters, s.inSeason[g].starters);
          mergeDelta(inS[g].all, s.inSeason[g].all);
          mergeDelta(net[g].starters, s.net[g].starters);
          mergeDelta(net[g].all, s.net[g].all);
          mergeDelta(aiG[g], s.aiGrowth[g]);
          mergeDelta(aiN[g], s.aiNet[g]);
        }
        spend += s.trainingSpend;
        income += s.income;
        goldEnd += s.goldEnd;
        honorEnd += s.honorEnd;
        sessions += s.sessions;
        extras += s.extras;
        scrims += s.scrims;
        tours += s.tournamentsPlayed;
        rest += s.restRounds;
        rows++;
        if (!s.league.starters) continue; // 中途解散 / 卡住：没有 TI 回合统计
        const l = leagueBySeason.get(s.ti) ?? { n: 0, ssPlus: 0, ssr: 0, top10: 0, top10Ai: 0, resilience: 0 };
        l.n++;
        l.ssPlus += s.league.starters ? s.league.ssPlus / s.league.starters : 0;
        l.ssr += s.league.ssr;
        l.top10 += s.league.top10;
        l.top10Ai += s.league.top10Ai;
        l.resilience += s.league.resilience;
        leagueBySeason.set(s.ti, l);
      }
    }
    console.log(`\n【${STRATEGY_LABEL[st]}】每季平均：赛事 ${(tours / rows).toFixed(1)} 项 · 休赛回合 ${(rest / rows).toFixed(1)} · 手动训练 ${(sessions / rows).toFixed(1)} 次（加购 ${(extras / rows).toFixed(1)}，训练赛 ${(scrims / rows).toFixed(1)}）`);
    console.log(`  财务：训练+训练赛花费 ${formatGold(spend / rows)} · 收入 ${formatGold(income / rows)}（花费占收入 ${(income ? (spend / income) * 100 : 0).toFixed(0)}%）· 赛季末资金 ${formatGold(goldEnd / rows)} · 赛季末荣誉 ${(honorEnd / rows).toFixed(0)}`);
    console.log('  本队选手成长            赛季内（首发）                       净成长/季（首发，含年龄与自主成长）  赛季内（全部）');
    for (const g of GROUPS) {
      console.log(`  ${GROUP_LABEL[g].padEnd(12)} ${fmtD(inS[g].starters)} ${fmtD(net[g].starters)} ${fmtD(inS[g].all)}`);
    }
    console.log('  AI 战队首发赛季内成长：' + GROUPS.map((g) => `${GROUP_LABEL[g]} ${fmtD(aiG[g]).trim()}`).join(' | '));
    console.log('  AI 战队首发净成长/季：' + GROUPS.map((g) => `${GROUP_LABEL[g]} ${fmtD(aiN[g]).trim()}`).join(' | '));
    console.log('  联赛（TI 回合）：' + [...leagueBySeason.entries()].sort((a, b) => a[0] - b[0])
      .map(([ti, l]) => `TI${ti} SS+ ${((l.ssPlus / l.n) * 100).toFixed(0)}% SSR ${(l.ssr / l.n).toFixed(1)} 前十 ${(l.top10 / l.n).toFixed(1)}（AI ${(l.top10Ai / l.n).toFixed(1)}）韧性 ${(l.resilience / l.n).toFixed(0)}`).join(' · '));
    summary[st] = {
      perSeason: { spend: spend / rows, income: income / rows, goldEnd: goldEnd / rows, honorEnd: honorEnd / rows, sessions: sessions / rows, extras: extras / rows, scrims: scrims / rows, tournaments: tours / rows, restRounds: rest / rows },
      inSeason: Object.fromEntries(GROUPS.map((g) => [g, { starters: avg(inS[g].starters), all: avg(inS[g].all), n: inS[g].starters.n }])),
      net: Object.fromEntries(GROUPS.map((g) => [g, { starters: avg(net[g].starters), all: avg(net[g].all), n: net[g].starters.n }])),
      ai: Object.fromEntries(GROUPS.map((g) => [g, avg(aiG[g])])),
      aiNet: Object.fromEntries(GROUPS.map((g) => [g, avg(aiN[g])])),
      league: Object.fromEntries([...leagueBySeason.entries()].map(([ti, l]) => [ti, { ssPlus: l.ssPlus / l.n, ssr: l.ssr / l.n, top10: l.top10 / l.n, top10Ai: l.top10Ai / l.n, resilience: l.resilience / l.n }])),
    };
  }
  if (!QUIET) {
    const yt = (st: Strategy) => (summary[st] as { net: Record<Group, { starters: { power: number; mmr: number } | null }> } | undefined)
      ?.net.youngTalented.starters ?? null;
    const a = yt('train');
    const b = yt('tour');
    if (a && b) {
      console.log(`\n年轻高天赋首发净成长/季：狂练 战力 ${a.power.toFixed(2)} 天梯 ${Math.round(a.mmr)} · 只打比赛 战力 ${b.power.toFixed(2)} 天梯 ${Math.round(b.mmr)}`
        + ` · 倍数 战力 ×${(b.power > 0 ? a.power / b.power : NaN).toFixed(2)} 天梯 ×${(b.mmr > 0 ? a.mmr / b.mmr : NaN).toFixed(2)}`);
    }
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ args: { ti: START_TI, seasons: SEASONS, seeds: SEEDS, seed: SEED0, team: TEAM, extra: EXTRA, scrims: SCRIMS, funds: FUNDS, strategies: STRATEGIES }, summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
