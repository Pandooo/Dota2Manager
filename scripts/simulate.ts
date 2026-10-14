// 无头全流程模拟（平衡性调试）
// 用法：npx tsx scripts/simulate.ts --ti 9 --seasons 3 [--team <seedTeamId|new>] [--seed 42] [--runs N] [--quiet]
//        [--difficulty normal] [--keep-rookies] [--pulls 2] [--extra 1] [--verbose] [--funds N] [--dump <file>] [--json <file>]
//   --keep-rookies  保留赛季初抽到的全部新秀（默认本回合退回不能顶替最弱首发的虚构新秀；选秀开启时为免费放弃选秀新秀）
//   --pulls N     赛季初新秀抽卡的单抽次数上限（默认 2；资金需留足 20 回合工资；0 = 不抽卡）
//   --team <id>   接管真实战队（startTi 届 roster 中的 team id，如 og / team-spirit）；new = 新建俱乐部（默认）
//   --runs N      用种子 seed..seed+N-1 重复 N 局，最后输出汇总：解散率、每赛季平均荣誉/资金、TI 冠军、选手战力分位数
//   --quiet       不输出每赛季明细（多局时也不输出每局一行），只输出最终结果/汇总
//   --extra N     休赛回合每回合最多加购 N 次额外训练（默认 1；0 = 不加购）
//   --min-tier T  赛季初只报名等级 ≥ T 的开放赛事（qualifier < minor < premier < major；默认全部报名）
//   --funds N     覆盖玩家初始资金（脱离经济平衡做长线压力测试）
//   --dump <file> 结束时写出（最后一局的）完整存档 JSON；--json <file> 写出每局结果与汇总（供平衡性分析）
// 自动经营策略（模拟「普通玩家」）：决策一律选第一项；赛季初按赛事等级报名所有不冲突的开放赛事；
// 正式队员不足 5 人时（转会窗口开放）从自由市场签下负担得起的选手；赛事前首发凑不齐时招募临时替补；
// 每回合与归属感偏低的选手一对一谈心（免费）；休赛回合训练（资金充裕时加购）；所有比赛快速模拟。
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { readRosterSync, registerNodeRosterLoader } from './nodeData';
import type { GameOverReason, GameState, NewGameOptions, SeasonSummary, Tournament, TournamentTier } from '../src/engine/types';
import { MAX_TI, POSITION_SHORT } from '../src/engine/config';
import { POSITIONS } from '../src/engine/types';
import {
  advance, buyExtraTraining, createNewGame, currentPlayerTournament, doTraining, fillLineupWithTempSubs,
  getAdvanceBlockers, quickSimTournament, trainingBlockReason, trainingSessionsLeft,
} from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { registerForTournament } from '../src/engine/schedule';
import { extraTrainingCost, roundWageBill } from '../src/engine/economy';
import { roundKindForPlayer } from '../src/engine/calendar';
import { autoLineup, benchPlayers, lineupPlayers, rosterRoom, validateLineup } from '../src/engine/team';
import { effectivePower, overallRating, playerTier } from '../src/engine/player';
import { draftedRookiesOf, releaseDraftedRookie } from '../src/engine/rookieDraft';
import { gachaDiscard, gachaPrice, gachaPull, gachaPullBlock } from '../src/engine/gacha';
import { freeAgents, isTransferWindowOpen, releasePlayer, signFreeAgent, signingFee } from '../src/engine/market';
import { talkToPlayer, talkedThisRound } from '../src/engine/squadOps';
import { playerSalaryMood } from '../src/engine/salary';
import { formatGold, formatRank } from '../src/engine/util';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const num = (v: string | true | undefined, d: number) => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: string | true | undefined, d: string) => (typeof v === 'string' ? v : d);
const flag = (v: string | true | undefined) => v === true || v === 'true' || v === '1';

const START_TI = Math.max(1, Math.min(MAX_TI, Math.round(num(args.ti, 9))));
const SEASONS = Math.max(1, Math.min(MAX_TI - START_TI + 1, Math.round(num(args.seasons, 3))));
const TEAM = str(args.team, 'new');
const SEED = Math.round(num(args.seed, 20190825));
const RUNS = Math.max(1, Math.round(num(args.runs, 1)));
const DIFFICULTY = (['easy', 'normal', 'hard'].includes(str(args.difficulty, 'normal')) ? str(args.difficulty, 'normal') : 'normal') as NewGameOptions['difficulty'];
const KEEP_ROOKIES = flag(args['keep-rookies']);
const PULLS = Math.max(0, Math.round(num(args.pulls, 2)));
const QUIET = flag(args.quiet);
const VERBOSE = flag(args.verbose) && !QUIET;
const EXTRA_PER_ROUND = Math.max(0, Math.round(num(args.extra, 1)));
const MIN_TIER = str(args['min-tier'], 'qualifier') as TournamentTier;
const DUMP = typeof args.dump === 'string' ? args.dump : null;
const JSON_OUT = typeof args.json === 'string' ? args.json : null;
const FUNDS = typeof args.funds === 'string' && Number.isFinite(Number(args.funds)) ? Number(args.funds) : null;
/** 多局时每局一行概要；单局时输出每赛季明细（均受 --quiet 抑制） */
const PER_SEASON = !QUIET && RUNS === 1;
const PER_RUN = !QUIET && RUNS > 1;

const TIER_RANK: Record<TournamentTier, number> = { ti: 5, major: 4, premier: 3, minor: 2, qualifier: 1 };
if (!(MIN_TIER in TIER_RANK)) {
  console.error(`--min-tier 无效：${MIN_TIER}（可选 qualifier / minor / premier / major）`);
  process.exit(1);
}

const vlog = (...a: unknown[]) => {
  if (VERBOSE) console.log('  ·', ...a);
};

// ---------------------------------------------------------------------------
// 统计结构
// ---------------------------------------------------------------------------
interface PowerStats {
  /** 统计人数（已签约战队的正式选手） */
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** 前 10 名平均 */
  top10: number;
}

interface SeasonRow {
  ti: number;
  honorStart: number;
  honorEnd: number;
  goldStart: number;
  goldEnd: number;
  tiRank: [number, number] | null;
  tiChampion: boolean;
  titles: number;
  finalRank: number;
  /** TI 回合（赛季结算前）全联赛选手战力分位数 */
  power: PowerStats | null;
  /** 同一时刻玩家首发平均战力 */
  myStarterPower: number | null;
  /** 同一时刻（TI 回合）玩家战队每回合工资与正式队员的薪资情绪 / 归属感（第八波） */
  squad: SquadMood | null;
  ms: number;
}

interface SquadMood {
  wage: number;
  strong: number;
  mild: number;
  satisfied: number;
  loyaltyAvg: number;
  loyaltyMin: number;
}

interface RunResult {
  seed: number;
  teamName: string;
  ending: GameOverReason | 'stuck' | 'unfinished';
  seasons: SeasonRow[];
  finalHonor: number;
  finalGold: number;
  /** 未完成赛季的回合（解散/卡住时） */
  abortedAt: string | null;
  warnings: number;
  ms: number;
  saveMB: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function powerStats(state: GameState): PowerStats | null {
  const vals: number[] = [];
  for (const p of Object.values(state.players)) {
    if (p.status !== 'active' || !p.teamId || p.tempSubUntilTournament || p.isWildSub) continue;
    vals.push(effectivePower(p));
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const top = vals.slice(-10);
  return {
    n: vals.length,
    p50: quantile(vals, 0.5),
    p90: quantile(vals, 0.9),
    p99: quantile(vals, 0.99),
    max: vals[vals.length - 1],
    top10: top.reduce((a, b) => a + b, 0) / top.length,
  };
}

/** 玩家战队每回合工资与正式队员的薪资情绪（满意 / 略有不满 / 强烈不满）、归属感 */
function squadMood(state: GameState): SquadMood | null {
  const team = me(state);
  if (!team) return null;
  const regs = team.playerIds.map((id) => state.players[id])
    .filter((p) => p && p.status === 'active' && !p.tempSubUntilTournament && !p.isWildSub);
  const out: SquadMood = { wage: roundWageBill(state, team.id), strong: 0, mild: 0, satisfied: 0, loyaltyAvg: 0, loyaltyMin: 100 };
  for (const p of regs) {
    const m = playerSalaryMood(state, p);
    if (m === 'strong') out.strong++;
    else if (m === 'mild') out.mild++;
    else out.satisfied++;
    out.loyaltyAvg += p.loyalty / regs.length;
    out.loyaltyMin = Math.min(out.loyaltyMin, p.loyalty);
  }
  if (!regs.length) out.loyaltyMin = 0;
  return out;
}

function starterPower(state: GameState): number | null {
  const ps = lineupPlayers(state, state.settings.playerTeamId).map((s) => s.player).filter((p) => !!p);
  if (!ps.length) return null;
  return ps.reduce((a, p) => a + effectivePower(p!), 0) / POSITIONS.length;
}

// ---------------------------------------------------------------------------
// 自动经营
// ---------------------------------------------------------------------------
function me(state: GameState) {
  return state.teams[state.settings.playerTeamId];
}

interface Ctx {
  preparedSeason: number;
  warnings: number;
  /** 新秀抽卡张数（本队） */
  pulls: number;
}

/** 所有待处理决策选第一项；无法处理的直接移除，防止死循环 */
function resolveAll(state: GameState, ctx: Ctx): void {
  for (let guard = 0; guard < 50 && state.pendingDecisions.length; guard++) {
    const d = state.pendingDecisions[0];
    const choice = d.choices[0]?.id ?? '';
    let res = { ok: false, message: '' };
    try {
      res = resolveDecision(state, d.id, choice);
    } catch (e) {
      res = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    vlog(`决策「${d.title}」→ ${d.choices[0]?.label ?? '?'}：${res.message}`);
    if (state.pendingDecisions[0] === d) {
      ctx.warnings++;
      if (!QUIET) console.warn(`  ! 决策无法处理，已移除：${d.kind}「${d.title}」 ${res.message}`);
      state.pendingDecisions.shift();
    }
  }
}

/**
 * 机器人的阵容管理（引擎不再强制：超出常规上限只是工资照付、替补归属感下降更快）：
 * 超出常规上限时先免费放弃本届选秀新秀（赛季初），再解约最弱替补，把阵容控制在常规上限内。
 */
function trimRoster(state: GameState): void {
  const team = me(state);
  for (let guard = 0; guard < 10 && rosterRoom(state, team.id) < 0; guard++) {
    const bench = benchPlayers(state, team.id).filter((p) => !p.tempSubUntilTournament)
      .sort((a, b) => overallRating(a) - overallRating(b));
    const victim = bench[0];
    if (!victim) break;
    const free = victim.draft?.ti === state.season.ti && state.phase === 'preseason';
    const r = free ? releaseDraftedRookie(state, victim.id) : releasePlayer(state, victim.id);
    vlog(`阵容超员，移出 ${victim.handle}：${r.message}`);
    if (!r.ok) break;
  }
}

/**
 * 首发有空位且转会窗口开放时，从自由市场签下该位置负担得起的最强选手（保留 6 回合工资作为安全垫）；
 * 都负担不起时退而求其次：签字费付得起的最便宜选手（残阵出战比动用安全垫更糟）。
 */
function fillEmptyPositions(state: GameState): void {
  const team = me(state);
  if (!team || !isTransferWindowOpen(state) || POSITIONS.every((pos) => team.lineup[pos])) return;
  // 正式队员已有 5 人：空位来自签证/伤病等临时缺阵，重排首发即可（赛事前再招临时替补），不花大钱签人
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
    const cheap = pool
      .filter((p) => !strong.includes(p) && signingFee(state, p) <= team.gold)
      .sort((a, b) => signingFee(state, a) + a.salary - (signingFee(state, b) + b.salary))
      .slice(0, 4);
    for (const p of [...strong, ...cheap]) {
      const r = signFreeAgent(state, p.id);
      vlog(`补位 ${pos}：${r.message}`);
      if (r.ok) break;
    }
  }
  autoLineup(state, team.id);
}

function preseason(state: GameState, ctx: Ctx): void {
  if (ctx.preparedSeason === state.season.ti) return;
  ctx.preparedSeason = state.season.ti;
  const open = state.seasonTournamentIds
    .map((id) => state.tournaments[id])
    .filter((t): t is Tournament => !!t && t.tier !== 'ti' && t.playerStatus === 'open' && TIER_RANK[t.tier] >= TIER_RANK[MIN_TIER])
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.prizePool - a.prizePool);
  let n = 0;
  for (const t of open) {
    const r = registerForTournament(state, t.id);
    if (r.ok) n++;
  }
  vlog(`报名 ${n}/${open.length} 项开放赛事`);
  // 赛季初选秀（模拟普通玩家）：保留真实新秀与能顶替最弱首发的新秀，其余免费放弃（节省工资）；保留的新秀按评分排进首发
  if (!KEEP_ROOKIES) {
    const team = me(state);
    const starters = lineupPlayers(state, team.id).filter((s) => s.player).map((s) => overallRating(s.player!));
    const weakest = starters.length ? Math.min(...starters) : 0;
    for (const p of draftedRookiesOf(state, team.id)) {
      if (p.isReal || overallRating(p) >= weakest) continue;
      const r = releaseDraftedRookie(state, p.id);
      vlog(`放弃新秀 ${p.handle}（${playerTier(p)}）：${r.message}`);
    }
  }
  if (draftedRookiesOf(state, me(state).id).length) autoLineup(state, me(state).id);
  // 赛季初新秀抽卡（2026-10-14 取代选秀；模拟普通玩家）：资金留足 20 回合工资时单抽至多 PULLS 张；
  // 真实 / 请神新秀与能顶替最弱首发的新秀留下，其余本回合退回（返还部分费用）
  {
    const team = me(state);
    for (let i = 0; i < PULLS; i++) {
      const price = gachaPrice(state).single;
      if (team.gold - price < roundWageBill(state, team.id) * 20 || gachaPullBlock(state, 1)) break;
      const r = gachaPull(state, 1);
      vlog(`新秀抽卡：${r.message}`);
      if (!r.ok) break;
      ctx.pulls++;
      const starters = lineupPlayers(state, team.id).filter((x) => x.player).map((x) => overallRating(x.player!));
      const weakest = starters.length ? Math.min(...starters) : 0;
      for (const res of r.results ?? []) {
        const p = state.players[res.playerId];
        if (!p || KEEP_ROOKIES || res.kind !== 'fictional' || overallRating(p) >= weakest) continue;
        const d = gachaDiscard(state, p.id);
        vlog(`退回新秀 ${p.handle}（${res.tier}）：${d.message}`);
      }
    }
    autoLineup(state, team.id);
  }
  trimRoster(state);
}

/** 每回合与归属感偏低（< 60）的正式队员谈心（免费，每人每回合一次），避免合同到期时集体拒绝续约 */
function talkToUnhappy(state: GameState): void {
  const team = me(state);
  if (!team || state.gameOver) return;
  for (const id of team.playerIds) {
    const p = state.players[id];
    if (!p || p.status !== 'active' || p.tempSubUntilTournament || p.isWildSub || p.loyalty >= 60) continue;
    if (talkedThisRound(state, id)) continue;
    const r = talkToPlayer(state, id);
    vlog(`谈心 ${p.handle}：${r.message}`);
  }
}

function trainRound(state: GameState): void {
  if (trainingBlockReason(state)) return;
  const team = me(state);
  // 安全垫：留足本赛季剩余回合的工资 + 4 回合
  const roundsLeft = Math.max(0, state.season.rounds.length - 1 - state.roundIndex);
  const reserve = roundWageBill(state, team.id) * (roundsLeft + 4);
  for (let i = 0; i < EXTRA_PER_ROUND; i++) {
    if (state.extraTrainingBoughtThisRound > i) continue;
    if (team.gold - extraTrainingCost(state) <= reserve || !buyExtraTraining(state).ok) break;
  }
  for (let guard = 0; guard < 10 && trainingSessionsLeft(state) > 0; guard++) {
    if (!doTraining(state).ok) break;
  }
}

function playTournament(state: GameState, ctx: Ctx): void {
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = currentPlayerTournament(state);
    if (!cur && !state.activeMatch) return;
    resolveAll(state, ctx);
    // 首发凑不齐 5 人时先招募临时替补（否则快速模拟 = 弃权判负）
    if (cur && validateLineup(state, state.settings.playerTeamId, cur.id).length) {
      const f = fillLineupWithTempSubs(state);
      vlog(`赛前补齐首发：${f.message}`);
    }
    const r = quickSimTournament(state);
    if (r.ok) {
      vlog(r.message);
      return;
    }
    if (/阵容|首发|替补/.test(r.message)) {
      const f = fillLineupWithTempSubs(state);
      vlog(`补齐阵容：${f.message}`);
      if (!f.ok) {
        autoLineup(state, state.settings.playerTeamId, currentPlayerTournament(state)?.id);
        if (attempt >= 2) return;
      }
    } else {
      vlog(`快速模拟失败：${r.message}`);
      if (attempt >= 1) return;
    }
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const FIN_LABEL: Record<string, string> = {
  prize: '奖金', appearance: '出场费', transfer_in: '引援转会费', event: '事件', salary: '工资', coach_salary: '教练',
  transfer_out: '出售选手', signing: '签约', training: '训练', scrim: '训练赛', gacha: '抽卡', temp_sub: '替补', other: '其他',
  sponsor: '赞助', streaming: '直播与内容', merch: '周边',
};

function financeLine(state: GameState, ti: number): string {
  const byCat = new Map<string, number>();
  for (const f of state.finance) if (f.season === ti) byCat.set(f.category, (byCat.get(f.category) ?? 0) + f.amount);
  const fmt = (pos: boolean) => [...byCat.entries()]
    .filter(([, v]) => (pos ? v > 0 : v < 0))
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => `${FIN_LABEL[k] ?? k} ${formatGold(Math.abs(v))}`)
    .join(' · ') || '-';
  return `   财务 收入：${fmt(true)} | 支出：${fmt(false)}`;
}

const f1 = (v: number) => v.toFixed(1);

function printSeason(state: GameState, s: SeasonSummary, row: SeasonRow): void {
  const tiRes = s.playerTiRank ? formatRank(s.playerTiRank[0], s.playerTiRank[1]) : '未进 TI';
  const champ = s.tiChampionId ? (state.teams[s.tiChampionId]?.name ?? s.tiChampionId) : '-';
  const titles = s.playerTitles.length ? `${s.playerTitles.length}（${s.playerTitles.join('、')}）` : '0';
  console.log(
    `TI${s.ti} (${s.year}) | 荣誉 ${s.honorStart}→${s.honorEnd} | 金币 ${formatGold(s.goldStart)}→${formatGold(s.goldEnd)}`
      + ` | TI: ${tiRes} | 冠军 ${titles} | 排名 #${s.finalRank} | TI 冠军: ${champ} | ${row.ms.toFixed(0)}ms`,
  );
  const lineup = lineupPlayers(state, state.settings.playerTeamId)
    .map(({ pos, player }) => (player ? `${POSITION_SHORT[pos]}:${player.handle}(${playerTier(player)} ${effectivePower(player).toFixed(1)})` : `${POSITION_SHORT[pos]}:空`))
    .join(' ');
  console.log(`   本队首发 ${lineup}`);
  console.log(financeLine(state, s.ti));
  if (row.squad) {
    const q = row.squad;
    console.log(
      `   薪资 工资 ${formatGold(q.wage)}/回合 · 薪资情绪 强烈不满 ${q.strong} / 略有不满 ${q.mild} / 满意 ${q.satisfied}`
        + ` · 归属感均值 ${q.loyaltyAvg.toFixed(0)}（最低 ${q.loyaltyMin.toFixed(0)}）`,
    );
  }
  if (row.power) {
    const pw = row.power;
    console.log(
      `   TI 时选手战力（${pw.n} 人）p50 ${f1(pw.p50)} · p90 ${f1(pw.p90)} · p99 ${f1(pw.p99)} · 最高 ${f1(pw.max)} · 前十均 ${f1(pw.top10)}`
        + (row.myStarterPower !== null ? ` | 本队首发均 ${f1(row.myStarterPower)}` : ''),
    );
  }
  const top = Object.values(state.players)
    .filter((p) => p.status === 'active')
    .sort((a, b) => overallRating(b) - overallRating(a))
    .slice(0, 5)
    .map((p) => `${p.handle}@${p.teamId ? (state.teams[p.teamId]?.tag ?? p.teamId) : '自由'}(${playerTier(p)} ${overallRating(p).toFixed(1)})`)
    .join(' · ');
  console.log(`   联赛最强（结算后）${top}`);
}

// ---------------------------------------------------------------------------
// 单局
// ---------------------------------------------------------------------------
function validateTeam(): void {
  if (TEAM === 'new') return;
  let ids: string[] = [];
  try {
    ids = (readRosterSync(START_TI).teams ?? []).map((t) => t.id);
  } catch {
    console.error(`缺少 TI${START_TI} 阵容数据，无法接管真实战队。可用 --team new 以程序化联赛运行。`);
    process.exit(1);
  }
  if (!ids.includes(TEAM)) {
    console.error(`TI${START_TI} 阵容中没有战队「${TEAM}」。可选：${ids.join(', ')}`);
    process.exit(1);
  }
}

async function runOnce(seed: number): Promise<{ result: RunResult; state: GameState }> {
  const opts: NewGameOptions = {
    startTi: START_TI,
    seasons: SEASONS,
    difficulty: DIFFICULTY,
    managerName: '模拟经理',
    seed,
    ...(TEAM === 'new'
      ? { newClub: { name: 'Headless Gaming', tag: 'HG', region: 'CN' as const, color: '#c23c2a' } }
      : { teamId: TEAM }),
  };

  const t0 = performance.now();
  const state = await createNewGame(opts);
  const team = me(state);
  if (FUNDS !== null) {
    team.gold = Math.round(FUNDS);
    state.season.goldStart = team.gold;
  }
  if (PER_SEASON) {
    console.log(
      `== Dota2 经理无头模拟：TI${START_TI} 起 ${SEASONS} 个赛季 · ${team.name}（${team.tag}）· 难度 ${DIFFICULTY} · 种子 ${seed}`
        + ` · 战队 ${Object.keys(state.teams).length} 支 · 选手 ${Object.keys(state.players).length} 名 · 建档 ${(performance.now() - t0).toFixed(0)}ms`,
    );
  }

  const ctx: Ctx = { preparedSeason: -1, warnings: 0, pulls: 0 };
  const rows: SeasonRow[] = [];
  const powerAtTi = new Map<number, { power: PowerStats | null; mine: number | null; squad: SquadMood | null }>();
  let seasonT = performance.now();
  let printed = state.history.seasons.length;
  let stuck = 0;
  let steps = 0;
  let stuckOut = false;
  const MAX_STEPS = 5000;
  while (!state.gameOver && steps++ < MAX_STEPS) {
    state.popups.length = 0;
    resolveAll(state, ctx);
    if (state.phase === 'preseason') preseason(state, ctx);
    fillEmptyPositions(state);
    talkToUnhappy(state);
    const kind = roundKindForPlayer(state, state.roundIndex);
    if (kind === 'rest' || kind === 'ti_watch') trainRound(state);
    if (currentPlayerTournament(state) || state.activeMatch) playTournament(state, ctx);
    // TI 回合（最后一回合）推进前：记录赛季结算前的战力分布
    if (state.phase === 'ti' && state.roundIndex === state.season.rounds.length - 1) {
      powerAtTi.set(state.season.ti, { power: powerStats(state), mine: starterPower(state), squad: squadMood(state) });
    }

    const r = advance(state);
    while (state.history.seasons.length > printed) {
      const now = performance.now();
      const s = state.history.seasons[printed];
      const pw = powerAtTi.get(s.ti);
      const row: SeasonRow = {
        ti: s.ti,
        honorStart: s.honorStart,
        honorEnd: s.honorEnd,
        goldStart: s.goldStart,
        goldEnd: s.goldEnd,
        tiRank: s.playerTiRank,
        tiChampion: s.tiChampionId === state.settings.playerTeamId,
        titles: s.playerTitles.length,
        finalRank: s.finalRank,
        power: pw?.power ?? null,
        myStarterPower: pw?.mine ?? null,
        squad: pw?.squad ?? null,
        ms: now - seasonT,
      };
      rows.push(row);
      if (PER_SEASON) printSeason(state, s, row);
      seasonT = now;
      printed++;
    }
    if (r.ok) {
      stuck = 0;
      vlog(r.message);
      continue;
    }
    stuck++;
    vlog(`无法推进：${r.message}`);
    for (const b of getAdvanceBlockers(state)) {
      if (b.code === 'pending_decision') resolveAll(state, ctx);
      else if (b.code === 'tournament_running' || b.code === 'match_in_progress') playTournament(state, ctx);
      else if (b.code === 'lineup_invalid') {
        // 首发不足 5 人（阵容人数本身不再产生阻塞）
        if (currentPlayerTournament(state)) fillLineupWithTempSubs(state);
      }
    }
    if (stuck > 25) {
      console.error(`推进卡住（种子 ${seed}，TI${state.season.ti} 第 ${state.roundIndex} 回合）：${r.message}`);
      stuckOut = true;
      break;
    }
  }

  const json = JSON.stringify(state);
  const finished = state.history.seasons.some((x) => x.ti === state.season.ti);
  const t = me(state);
  const result: RunResult = {
    seed,
    teamName: t?.name ?? '?',
    ending: state.gameOver ? state.gameOver.reason : stuckOut ? 'stuck' : 'unfinished',
    seasons: rows,
    finalHonor: Math.round(t?.honor ?? 0),
    finalGold: Math.round(t?.gold ?? 0),
    abortedAt: finished ? null : `TI${state.season.ti} R${state.roundIndex}`,
    warnings: ctx.warnings,
    ms: performance.now() - t0,
    saveMB: json.length / 1024 / 1024,
  };

  if (PER_SEASON) {
    console.log('== 结束');
    if (state.gameOver) {
      console.log(`结局：${state.gameOver.reason === 'completed' ? '执教期满' : state.gameOver.reason === 'banned' ? '全员假赛除名'
        : state.gameOver.reason === 'bankrupt' ? '俱乐部破产' : '俱乐部解散'}`);
      console.log(state.gameOver.summary);
    } else {
      console.log(`未结束（步数 ${steps}，阶段 ${state.phase}，回合 ${state.roundIndex}）`);
    }
    if (!finished) {
      console.log(`TI${state.season.ti} 赛季中止于第 ${state.roundIndex} 回合 | 荣誉 ${Math.round(t.honor)} | 金币 ${formatGold(t.gold)}`);
      console.log(financeLine(state, state.season.ti));
    }
    console.log(
      `总耗时 ${(result.ms / 1000).toFixed(2)}s · 平均每赛季 ${(result.ms / Math.max(1, rows.length)).toFixed(0)}ms`
        + ` · 存档体积 ${result.saveMB.toFixed(2)}MB · 选手 ${Object.keys(state.players).length}`
        + ` · 赛事实例 ${Object.keys(state.tournaments).length} · 新闻 ${state.news.length}`
        + ` · 本队抽卡 ${ctx.pulls} 张 · 名人堂 ${state.hallOfFame?.members.length ?? 0} 人`
        + ` · 在役请神新秀 ${Object.values(state.players).filter((p) => p.status === 'active' && p.summon).length} 人`,
    );
  }
  return { result, state };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const ENDING_LABEL: Record<RunResult['ending'], string> = {
  completed: '期满', disbanded: '解散', banned: '全员禁赛', bankrupt: '破产', stuck: '卡住', unfinished: '未完',
};

function runLine(r: RunResult): string {
  const tiWins = r.seasons.filter((s) => s.tiChampion).length;
  const tiApps = r.seasons.filter((s) => s.tiRank).length;
  const titles = r.seasons.reduce((a, s) => a + s.titles, 0);
  const last = r.seasons[r.seasons.length - 1];
  return `种子 ${r.seed} | ${ENDING_LABEL[r.ending]}${r.abortedAt ? `@${r.abortedAt}` : ''} | 完成 ${r.seasons.length} 季`
    + ` | 荣誉 ${r.finalHonor} | 金币 ${formatGold(r.finalGold)} | TI 参赛 ${tiApps} 冠军 ${tiWins} | 冠军 ${titles}`
    + (last ? ` | 末季排名 #${last.finalRank}` : '') + ` | ${(r.ms / 1000).toFixed(1)}s`;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

interface SeasonAgg {
  ti: number;
  runs: number;
  honorEnd: number;
  honorDelta: number;
  goldEnd: number;
  goldDelta: number;
  tiReach: number;
  tiWins: number;
  titles: number;
  finalRank: number;
  power: { p50: number; p90: number; p99: number; max: number; top10: number } | null;
  myStarterPower: number | null;
  /** TI 回合时的每回合工资、强烈不满人数、归属感均值（第八波） */
  wage: number | null;
  strong: number | null;
  loyalty: number | null;
}

function aggregate(results: RunResult[]) {
  const n = results.length;
  const count = (e: RunResult['ending']) => results.filter((r) => r.ending === e).length;
  const bySeason = new Map<number, SeasonRow[]>();
  for (const r of results) for (const s of r.seasons) bySeason.set(s.ti, [...(bySeason.get(s.ti) ?? []), s]);
  const seasons: SeasonAgg[] = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([ti, rows]) => {
    const pw = rows.map((r) => r.power).filter((p): p is PowerStats => !!p);
    const mine = rows.map((r) => r.myStarterPower).filter((v): v is number => v !== null);
    const sq = rows.map((r) => r.squad).filter((v): v is SquadMood => !!v);
    return {
      ti,
      runs: rows.length,
      honorEnd: mean(rows.map((r) => r.honorEnd)),
      honorDelta: mean(rows.map((r) => r.honorEnd - r.honorStart)),
      goldEnd: mean(rows.map((r) => r.goldEnd)),
      goldDelta: mean(rows.map((r) => r.goldEnd - r.goldStart)),
      tiReach: rows.filter((r) => r.tiRank).length / rows.length,
      tiWins: rows.filter((r) => r.tiChampion).length,
      titles: mean(rows.map((r) => r.titles)),
      finalRank: mean(rows.map((r) => r.finalRank)),
      power: pw.length
        ? {
          p50: mean(pw.map((p) => p.p50)), p90: mean(pw.map((p) => p.p90)), p99: mean(pw.map((p) => p.p99)),
          max: mean(pw.map((p) => p.max)), top10: mean(pw.map((p) => p.top10)),
        }
        : null,
      myStarterPower: mine.length ? mean(mine) : null,
      wage: sq.length ? mean(sq.map((q) => q.wage)) : null,
      strong: sq.length ? mean(sq.map((q) => q.strong)) : null,
      loyalty: sq.length ? mean(sq.map((q) => q.loyaltyAvg)) : null,
    };
  });
  const allRows = results.flatMap((r) => r.seasons);
  return {
    runs: n,
    completed: count('completed'),
    disbanded: count('disbanded'),
    bankrupt: count('bankrupt'),
    stuck: count('stuck'),
    unfinished: count('unfinished'),
    disbandRate: n ? count('disbanded') / n : 0,
    avgSeasonsCompleted: mean(results.map((r) => r.seasons.length)),
    tiWins: allRows.filter((s) => s.tiChampion).length,
    runsWithTiWin: results.filter((r) => r.seasons.some((s) => s.tiChampion)).length,
    avgHonorEnd: mean(allRows.map((s) => s.honorEnd)),
    avgHonorDelta: mean(allRows.map((s) => s.honorEnd - s.honorStart)),
    avgGoldEnd: mean(allRows.map((s) => s.goldEnd)),
    avgGoldDelta: mean(allRows.map((s) => s.goldEnd - s.goldStart)),
    avgTitles: mean(allRows.map((s) => s.titles)),
    warnings: results.reduce((a, r) => a + r.warnings, 0),
    avgRunSec: mean(results.map((r) => r.ms / 1000)),
    maxSaveMB: Math.max(...results.map((r) => r.saveMB)),
    seasons,
  };
}

function printAggregate(agg: ReturnType<typeof aggregate>): void {
  const teamLabel = TEAM === 'new' ? '新建俱乐部' : TEAM;
  console.log(
    `== 汇总：${agg.runs} 局 · TI${START_TI} 起 ${SEASONS} 季 · ${teamLabel} · 难度 ${DIFFICULTY} · 种子 ${SEED}..${SEED + agg.runs - 1}`,
  );
  console.log(
    `结局 期满 ${agg.completed} · 解散 ${agg.disbanded}（解散率 ${pct(agg.disbandRate)}）· 破产 ${agg.bankrupt}`
      + (agg.stuck ? ` · 卡住 ${agg.stuck}` : '') + (agg.unfinished ? ` · 未完 ${agg.unfinished}` : '')
      + ` · 平均完成 ${agg.avgSeasonsCompleted.toFixed(2)} 季`,
  );
  console.log(
    `TI 冠军 ${agg.tiWins} 次（${agg.runsWithTiWin}/${agg.runs} 局至少一冠）· 每季平均：荣誉 ${agg.avgHonorEnd.toFixed(0)}（Δ${agg.avgHonorDelta >= 0 ? '+' : ''}${agg.avgHonorDelta.toFixed(0)}）`
      + ` · 资金 ${formatGold(agg.avgGoldEnd)}（Δ${agg.avgGoldDelta >= 0 ? '+' : '-'}${formatGold(Math.abs(agg.avgGoldDelta))}）· 冠军 ${agg.avgTitles.toFixed(2)} 个`,
  );
  console.log('赛季  局数  荣誉末(Δ)        资金末(Δ)                 进TI  TI冠  冠军  排名   | 选手战力 p50 / p90 / p99 / 最高 / 前十均 | 本队首发均 | 工资/回合 · 强烈不满 · 归属感');
  for (const s of agg.seasons) {
    const pw = s.power;
    const honor = `${s.honorEnd.toFixed(0)}(${s.honorDelta >= 0 ? '+' : ''}${s.honorDelta.toFixed(0)})`;
    const gold = `${formatGold(s.goldEnd)}(${s.goldDelta >= 0 ? '+' : '-'}${formatGold(Math.abs(s.goldDelta))})`;
    console.log(
      `TI${String(s.ti).padEnd(3)} ${String(s.runs).padStart(4)}  ${honor.padEnd(15)} ${gold.padEnd(24)} ${pct(s.tiReach).padStart(4)}  ${String(s.tiWins).padStart(4)}  ${s.titles.toFixed(2)}  ${s.finalRank.toFixed(1).padStart(5)}  | `
        + (pw ? `${f1(pw.p50)} / ${f1(pw.p90)} / ${f1(pw.p99)} / ${f1(pw.max)} / ${f1(pw.top10)}` : '-')
        + ` | ${s.myStarterPower !== null ? f1(s.myStarterPower) : '-'}`
        + ` | ${s.wage !== null ? formatGold(s.wage) : '-'} · ${s.strong !== null ? s.strong.toFixed(2) : '-'} · ${s.loyalty !== null ? s.loyalty.toFixed(0) : '-'}`,
    );
  }
  console.log(
    `平均每局 ${agg.avgRunSec.toFixed(2)}s · 最大存档 ${agg.maxSaveMB.toFixed(2)}MB`
      + (agg.warnings ? ` · 无法处理的决策 ${agg.warnings} 次` : ''),
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const tis = registerNodeRosterLoader();
  if (TEAM !== 'new' && !tis.includes(START_TI)) {
    console.error(`缺少 TI${START_TI} 阵容数据（可用：${tis.length ? tis.join(', ') : '无'}）。可用 --team new 以程序化联赛运行。`);
    process.exit(1);
  }
  validateTeam();

  const results: RunResult[] = [];
  let lastState: GameState | null = null;
  for (let i = 0; i < RUNS; i++) {
    const { result, state } = await runOnce(SEED + i);
    results.push(result);
    lastState = state;
    if (PER_RUN) console.log(runLine(result));
  }
  if (DUMP && lastState) writeFileSync(DUMP, JSON.stringify(lastState));

  const agg = aggregate(results);
  if (RUNS > 1) {
    printAggregate(agg);
  } else if (QUIET) {
    console.log(runLine(results[0]));
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({
      args: {
        ti: START_TI, seasons: SEASONS, team: TEAM, seed: SEED, runs: RUNS, difficulty: DIFFICULTY, keepRookies: KEEP_ROOKIES,
        extra: EXTRA_PER_ROUND, minTier: MIN_TIER,
      },
      aggregate: agg,
      runs: results,
    }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
