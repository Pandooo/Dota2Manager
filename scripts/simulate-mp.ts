// 多人对战无头模拟（MP1 引擎验证）
// 用法：npx tsx scripts/simulate-mp.ts [--ti 9] [--seasons 3] [--seed 7] [--mode both|build|existing] [--quiet] [--no-determinism]
//
// 3 个座位（与服务器相同，全部操作经 multi.callAsSeat 白名单 RPC）：每回合各座位以随机交错的顺序做随机的合法操作
// （训练 / 训练赛 / 签自由选手——含两名玩家抢签同一名自由选手的先到先得校验 / 求购 AI 选手 / 报名 / 赛季初放弃选秀新秀 / 谈心 /
// 挂牌 / 回应报价 / 篡改他队阵容的越权调用……），然后打完各自的比赛（快速模拟、手动 BP、玩家对玩家系列赛：
// 双方各自 BP 或双方都请求快速模拟），全部准备后推进回合。
// 每次 RPC 后检查不变量（中性上下文、名单/首发一致、无引擎异常），每回合结束检查座位隔离（视图不泄露其他座位
// 私有数据）与赛事收尾；existing 玩法中途让一名玩家出局，验证其余玩家继续。最后以同一种子重跑校验确定性。
import { performance } from 'node:perf_hooks';
import { readRosterSync, registerNodeRosterLoader } from './nodeData';
import type { GameState, Player, Team } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import * as M from '../src/engine/multi';
import { seededRng, type Rng } from '../src/engine/rng';
import { freeAgents, isTransferWindowOpen, signingFee, suggestedFee } from '../src/engine/market';
import { rosterHardRoom, rosterRoom, validateLineup } from '../src/engine/team';
import { effectiveAttr, marketValue } from '../src/engine/player';
import { draftedRookiesOf } from '../src/engine/rookieDraft';
import { newsIsMine } from '../src/engine/news';
import { applyHonorChange } from '../src/engine/honor';
import { currentStep } from '../src/engine/draft';
import { draftSuggestions } from '../src/engine/draft';
import { coachMarket, coachSigningFee, trainingSessionsLeft } from '../src/engine/game';
import { extraTrainingCost } from '../src/engine/economy';
import { computeLegacyReport } from '../src/engine/legacy';

registerNodeRosterLoader();

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
const START_TI = Math.round(num(args.ti, 9));
const SEASONS = Math.max(1, Math.round(num(args.seasons, 3)));
const SEED = Math.round(num(args.seed, 7));
const MODE = typeof args.mode === 'string' ? args.mode : 'both';
const QUIET = args.quiet === true;
const CHECK_DETERMINISM = args['no-determinism'] !== true;

const log = (...a: unknown[]) => {
  if (!QUIET) console.log(...a);
};

// 引擎内部异常（guard/callAsSeat 捕获后以 console.error 打印）计为失败
let engineErrors = 0;
const origError = console.error;
console.error = (...a: unknown[]) => {
  if (typeof a[0] === 'string' && a[0].startsWith('[engine]')) engineErrors++;
  origError(...a);
};

class Fail extends Error {}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Fail(msg);
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------
interface Stats {
  rpc: number;
  rpcOk: number;
  signings: number;
  /** 超出常规阵容上限后仍成功签下的次数（软上限） */
  overSoftSignings: number;
  races: number;
  raceLosersRejected: number;
  bids: number;
  bidsOk: number;
  trainings: number;
  manualGames: number;
  h2hSeries: number;
  h2hManualGames: number;
  h2hQuickSims: number;
  forbiddenRejected: number;
  rounds: number;
  /** 模拟脚本强制制造的出局（existing 玩法第二赛季） */
  forcedEliminations: number;
  /** 全部出局座位（含荣誉自然跌破 0） */
  eliminated: number;
}
const newStats = (): Stats => ({
  rpc: 0, rpcOk: 0, signings: 0, overSoftSignings: 0, races: 0, raceLosersRejected: 0, bids: 0, bidsOk: 0, trainings: 0, manualGames: 0,
  h2hSeries: 0, h2hManualGames: 0, h2hQuickSims: 0, forbiddenRejected: 0, rounds: 0, forcedEliminations: 0, eliminated: 0,
});

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

/** 不变量检查开关（确定性重跑时关闭以节省时间；检查本身只读，不影响模拟结果） */
let CHECKS = true;
/** 模拟服务器持久化/重启：比赛进行中与每回合推进后把整个状态经 JSON 往返一次（原地替换），结果必须与不往返时一致 */
let ROUNDTRIP = true;

function jsonRoundTrip(g: GameState): void {
  if (!ROUNDTRIP) return;
  const copy = JSON.parse(JSON.stringify(g)) as GameState;
  const bag = g as unknown as Record<string, unknown>;
  for (const k of Object.keys(bag)) delete bag[k];
  Object.assign(g, copy);
}

/** 每次 RPC 之后：中性上下文、名单/首发一致 */
function checkCheap(g: GameState, where: string): void {
  if (!CHECKS) return;
  const mp = g.multiplayer!;
  check(mp.activeSeat === null, `${where}: 上下文未回到中性（activeSeat=${mp.activeSeat}）`);
  check(g.settings.playerTeamId === '', `${where}: 中性上下文 playerTeamId 应为空`);
  check(g.activeMatch === null && g.pendingDecisions.length === 0 && g.popups.length === 0 && g.finance.length === 0,
    `${where}: 中性上下文的私有字段不为空`);
  const owner = new Map<string, string>();
  for (const t of Object.values(g.teams)) {
    for (const pid of t.playerIds) {
      const p = g.players[pid];
      check(!!p, `${where}: ${t.id} 名单中的选手 ${pid} 不存在`);
      check(p.teamId === t.id, `${where}: ${p.handle} 在 ${t.id} 名单中但 teamId=${p.teamId}`);
      check(!owner.has(pid), `${where}: ${p.handle} 同时属于 ${owner.get(pid)} 和 ${t.id}`);
      owner.set(pid, t.id);
    }
    const seen = new Set<string>();
    for (const pos of POSITIONS) {
      const id = t.lineup?.[pos];
      if (!id) continue;
      check(!seen.has(id), `${where}: ${t.id} 首发重复 ${id}`);
      seen.add(id);
      if (!t.disbanded && g.players[id]?.status === 'active') check(t.playerIds.includes(id), `${where}: ${t.id} 首发 ${id} 不在名单中`);
    }
  }
  for (const p of Object.values(g.players)) {
    if (p.teamId && g.teams[p.teamId]) check(g.teams[p.teamId].playerIds.includes(p.id), `${where}: ${p.handle} teamId=${p.teamId} 但不在名单中`);
  }
  check(engineErrors === 0, `${where}: 出现引擎内部异常`);
}

/** 各座位账目的基准（开局资金 − 开局账目合计）：之后始终有 资金 = 基准 + 账目合计（账目被正确路由到所属座位） */
const ledgerBase = new Map<string, number>();
const ledgerSum = (g: GameState) => g.finance.reduce((a, f) => a + f.amount, 0);

/** 每回合：各座位视图的隔离与一致性 */
function checkSeatViews(g: GameState, where: string): void {
  if (!CHECKS) return;
  const mp = g.multiplayer!;
  for (const id of mp.order) {
    if (!ledgerBase.has(id)) ledgerBase.set(id, M.withSeat(g, id, () => g.teams[id].gold - ledgerSum(g)));
    if (!mp.seats[id].eliminated) {
      const [gold, sum, lastHonor] = M.withSeat(g, id, () => [g.teams[id].gold, ledgerSum(g), g.history.honor.at(-1)?.value] as const);
      check(gold === ledgerBase.get(id)! + sum, `${where}: ${id} 资金 ${gold} ≠ 基准 + 账目合计 ${ledgerBase.get(id)! + sum}（账目串座）`);
      check(lastHonor === Math.round(g.teams[id].honor), `${where}: ${id} 荣誉曲线末值 ${lastHonor} ≠ 当前荣誉 ${g.teams[id].honor}`);
    }
    const v = M.seatView(g, id);
    const vmp = v.multiplayer!;
    check(v.settings.playerTeamId === id, `${where}: ${id} 视图 playerTeamId 错误`);
    for (const other of vmp.order) {
      check(Object.keys(vmp.seats[other].saved ?? {}).length === 0, `${where}: ${id} 视图泄露了 ${other} 的私有数据`);
      if (other !== id) check(vmp.seats[other].sessionId === '', `${where}: ${id} 视图泄露了 ${other} 的会话 id`);
    }
    for (const n of v.news) {
      if (n.visibility === 'private') check(newsIsMine(v, n, id), `${where}: ${id} 视图包含他人的私有新闻「${n.title}」`);
    }
    for (const st of v.history.playerSettlements) {
      const t = v.tournaments[st.tournamentId];
      if (t) check(t.placements.some((p) => p.teamId === id), `${where}: ${id} 的赛事结算 ${t.name} 不含本队`);
    }
    for (const t of Object.values(v.tournaments)) {
      if (t.settlement) check(t.placements.some((p) => p.teamId === id), `${where}: ${id} 视图中 ${t.name} 的结算不属于本队`);
      if (t.expectedRank != null && t.expectedRanks?.[id] != null) {
        check(t.expectedRank === t.expectedRanks[id], `${where}: ${id} 视图中 ${t.name} 的赛前预期不是本队的`);
      }
    }
    for (const tid of v.season.registeredTournamentIds) {
      const t = v.tournaments[tid];
      if (t) check(['registered', 'invited', 'declined'].includes(t.playerStatus), `${where}: ${id} 已报名 ${t.name} 但状态为 ${t.playerStatus}`);
    }
    for (const d of v.pendingDecisions) {
      const pid = typeof d.ctx?.playerId === 'string' ? d.ctx.playerId : null;
      const p = pid ? v.players[pid] : null;
      if ((d.kind === 'contract' || d.kind === 'leave_request') && p?.teamId) {
        check(p.teamId === id, `${where}: ${id} 收到了他队选手 ${p.handle} 的 ${d.kind} 决策`);
      }
      if (d.kind === 'retire' && p) check(p.lastTeamId === id, `${where}: ${id} 收到了他队退役选手 ${p.handle} 的决策`);
      if (d.kind === 'poach') {
        const o = v.transferOffers.find((x) => x.id === d.ctx?.offerId);
        if (o && o.status === 'pending') check(o.toTeamId === id, `${where}: ${id} 收到了他队选手的挖角决策`);
      }
    }
    for (const pop of v.popups) {
      if (pop.kind === 'tournament_settlement') {
        const t = v.tournaments[pop.tournamentId];
        if (t) check(t.placements.some((p) => p.teamId === id), `${where}: ${id} 收到了未参加的赛事 ${t.name} 的结算弹窗`);
      }
    }
    if (v.activeMatch) {
      const s = v.tournaments[v.activeMatch.tournamentId]?.series[v.activeMatch.seriesId];
      if (s) check(s.teamA === id || s.teamB === id, `${where}: ${id} 的比赛视图不是本队的系列赛`);
    }
    for (const h of Object.values(vmp.h2h ?? {})) check(h.teamA === id || h.teamB === id, `${where}: ${id} 视图包含他人的玩家对决`);
  }
}

// ---------------------------------------------------------------------------
// 座位操作
// ---------------------------------------------------------------------------
type Res = { ok: boolean; message: string } & Record<string, unknown>;

function rpc(g: GameState, st: Stats, id: string, fn: string, ...a: unknown[]): Res {
  st.rpc++;
  const r = M.callAsSeat(g, id, fn, a) as Res | undefined;
  checkCheap(g, `RPC ${id}.${fn}`);
  const res: Res = r && typeof r === 'object' && 'ok' in r ? r : { ok: true, message: '' };
  if (res.ok) st.rpcOk++;
  return res;
}

/** 在座位上下文中只读查询 */
function read<T>(g: GameState, id: string, fn: () => T): T {
  return M.withSeat(g, id, fn);
}

function live(g: GameState): string[] {
  return M.activeHumanIds(g);
}

function resolveDecisions(g: GameState, st: Stats, id: string, rnd: Rng): void {
  for (let guard = 0; guard < 30; guard++) {
    const d = read(g, id, () => g.pendingDecisions[0] ? { ...g.pendingDecisions[0] } : null);
    if (!d) return;
    const choices = d.choices.map((c) => c.id);
    const first = choices.length ? rnd.pick(choices) : '';
    let r = rpc(g, st, id, 'resolveDecision', d.id, first);
    if (!r.ok && read(g, id, () => g.pendingDecisions.some((x) => x.id === d.id))) {
      for (const c of choices) {
        r = rpc(g, st, id, 'resolveDecision', d.id, c);
        if (!read(g, id, () => g.pendingDecisions.some((x) => x.id === d.id))) break;
      }
    }
    check(!read(g, id, () => g.pendingDecisions.some((x) => x.id === d.id)), `决策 ${d.kind}「${d.title}」无法处理：${r.message}`);
  }
}

function myTeam(g: GameState, id: string): Team {
  return g.teams[id];
}

/** 两名玩家抢签同一名自由选手：先到先得 */
function raceForFreeAgent(g: GameState, st: Stats, rnd: Rng): void {
  const seats = rnd.shuffle(live(g).slice());
  if (seats.length < 2 || !isTransferWindowOpen(g)) return;
  const [a, b] = seats;
  const fas = read(g, a, () => freeAgents(g)).filter((p) => {
    const fee = signingFee(g, p);
    return fee <= myTeam(g, a).gold * 0.4 && fee <= myTeam(g, b).gold * 0.4
      && rosterRoom(g, a) > 0 && rosterRoom(g, b) > 0;
  });
  if (!fas.length) return;
  const target = rnd.pick(fas.slice(0, 15));
  const r1 = rpc(g, st, a, 'signFreeAgent', target.id);
  if (!r1.ok) return; // 被婉拒（加盟意愿），不构成抢签
  st.races++;
  st.signings++;
  check(g.players[target.id].teamId === a, `抢签：${target.handle} 应归 ${a}`);
  const r2 = rpc(g, st, b, 'signFreeAgent', target.id);
  check(!r2.ok && r2.message.includes('已被'), `抢签：后到的 ${b} 应收到「已被签下」，实际：${r2.message}`);
  check(g.players[target.id].teamId === a, `抢签：${target.handle} 被后到者抢走`);
  st.raceLosersRejected++;
}

function randomActions(g: GameState, st: Stats, id: string, rnd: Rng): void {
  const team = () => myTeam(g, id);
  const actions: (() => void)[] = [
    // 训练
    () => {
      if (g.phase === 'preseason') return;
      rpc(g, st, id, 'setTrainingFocus', rnd.pick(['power', 'mmr', 'insight', 'balanced']));
      if (read(g, id, () => trainingSessionsLeft(g)) > 0 && rpc(g, st, id, 'doTraining').ok) st.trainings++;
      const cost = read(g, id, () => extraTrainingCost(g));
      if (team().gold > cost * 6 && rnd.chance(0.4) && rpc(g, st, id, 'buyExtraTraining').ok && rpc(g, st, id, 'doTraining').ok) st.trainings++;
    },
    // 训练赛
    () => {
      if (!rnd.chance(0.25)) return;
      const ai = Object.values(g.teams).filter((t) => !t.isPlayer && !t.disbanded);
      if (ai.length) rpc(g, st, id, 'doScrim', rnd.pick(ai).id);
    },
    // 签自由选手（常规上限内较常签；偶尔超出常规上限签人：只有绝对上限才会被拒）
    () => {
      if (!isTransferWindowOpen(g)) return;
      const soft = rosterRoom(g, id) > 0;
      if (!(soft ? rnd.chance(0.35) : rnd.chance(0.04))) return;
      const fas = read(g, id, () => freeAgents(g)).filter((p) => signingFee(g, p) <= team().gold * 0.3);
      if (!fas.length) return;
      const hardFull = rosterHardRoom(g, id) <= 0;
      const r = rpc(g, st, id, 'signFreeAgent', rnd.pick(fas.slice(0, 20)).id);
      if (r.ok) {
        st.signings++;
        if (!soft) st.overSoftSignings++;
      }
      check(hardFull ? !r.ok && r.message.includes('绝对上限') : !r.message.includes('上限'),
        `阵容软上限：${id}（${CONFIG.team.maxRoster - rosterRoom(g, id)} 人）签约结果不符：${r.message}`);
    },
    // 求购 AI 选手（以及越权：求购其他玩家的选手）
    () => {
      if (!isTransferWindowOpen(g) || rosterRoom(g, id) <= 0 || !rnd.chance(0.2)) return;
      const cands = Object.values(g.players).filter((p) => p.teamId && p.status === 'active' && !g.teams[p.teamId].isPlayer
        && !p.tempSubUntilTournament && marketValue(g, p) * 1.6 < team().gold * 0.5);
      if (cands.length) {
        const p = rnd.pick(cands);
        st.bids++;
        if (rpc(g, st, id, 'bidForPlayer', p.id, Math.round(suggestedFee(g, p.id) * rnd.range(0.9, 1.5))).ok) st.bidsOk++;
      }
      const others = live(g).filter((x) => x !== id);
      if (others.length) {
        const victim = myTeam(g, rnd.pick(others)).playerIds[0];
        if (victim) {
          const before = g.players[victim].teamId;
          const r = rpc(g, st, id, 'bidForPlayer', victim, 1e9);
          check(!r.ok && g.players[victim].teamId === before, '求购其他玩家的选手应被拒绝');
          st.forbiddenRejected++;
        }
      }
    },
    // 报名（赛季初）
    () => {
      if (g.phase !== 'preseason') return;
      const ids = read(g, id, () => g.seasonTournamentIds.filter((tid) => g.tournaments[tid]?.playerStatus === 'open'));
      for (const tid of ids) if (rnd.chance(0.8)) rpc(g, st, id, 'registerForTournament', tid);
      const reg = read(g, id, () => g.season.registeredTournamentIds.slice());
      if (reg.length && rnd.chance(0.2)) rpc(g, st, id, 'unregisterFromTournament', rnd.pick(reg));
    },
    // 新秀选秀（赛季初）：阵容超出常规上限时放弃多余的新秀（机器人策略，引擎不强制）；否则随机免费放弃一名
    () => {
      if (g.phase !== 'preseason') return;
      check(!M.seatBlockers(g, id).some((b) => b.message.includes('阵容超出')), `阵容人数不应阻塞推进：${id}`);
      const mine = read(g, id, () => draftedRookiesOf(g, id).map((p) => p.id));
      if (!mine.length) return;
      const extra = Math.max(0, -rosterRoom(g, id));
      const n = extra > 0 ? (rnd.chance(0.7) ? Math.min(extra, mine.length) : 0) : rnd.chance(0.3) ? 1 : 0;
      for (const pid of rnd.shuffle(mine.slice()).slice(0, n)) {
        const r = rpc(g, st, id, 'releaseDraftedRookie', pid);
        if (r.ok) check(!g.players[pid]?.teamId, `放弃选秀新秀后仍在队：${pid}`);
      }
    },
    // 谈心 / 团建 / 加薪
    () => {
      const low = team().playerIds.map((pid) => g.players[pid]).filter((p): p is Player => !!p && effectiveAttr(p, 'loyalty') < 45);
      if (low.length) rpc(g, st, id, 'talkToPlayer', rnd.pick(low).id);
      if (rnd.chance(0.1)) rpc(g, st, id, 'teamBuilding');
    },
    // 选手奖金分成（第九波）：偶尔调整一档；只改本队，每回合最多一次
    () => {
      if (!rnd.chance(0.08)) return;
      const cur = team().prizeShare ?? 0.7;
      const others = Object.keys(g.teams).filter((t) => t !== id).map((t) => [t, g.teams[t].prizeShare] as const);
      const to = Math.round(Math.min(1, Math.max(0.5, cur + (rnd.chance(0.5) ? 0.05 : -0.05))) * 100) / 100;
      if (rpc(g, st, id, 'setPrizeShare', to).ok) {
        check(team().prizeShare === to, `奖金分成：${id} 调整为 ${to} 后实际为 ${team().prizeShare}`);
        check(!rpc(g, st, id, 'setPrizeShare', cur).ok, `奖金分成：${id} 同一回合调整了两次`);
      }
      for (const [t, v] of others) check(g.teams[t].prizeShare === v, `奖金分成：${id} 的调整改动了 ${t}`);
    },
    // 报价回应 / 挂牌
    () => {
      const offers = g.transferOffers.filter((o) => o.status === 'pending' && o.toTeamId === id);
      for (const o of offers) rpc(g, st, id, 'respondToOffer', o.id, rnd.chance(0.3));
      if (isTransferWindowOpen(g) && rnd.chance(0.05) && team().playerIds.length > 5) {
        const bench = team().playerIds.filter((pid) => !Object.values(team().lineup).includes(pid));
        if (bench.length) rpc(g, st, id, 'listPlayerForTransfer', rnd.pick(bench));
      }
    },
    // 教练
    () => {
      if (team().coachId || !isTransferWindowOpen(g) || !rnd.chance(0.3)) return;
      const c = coachMarket(g).find((x) => coachSigningFee(x) < team().gold * 0.15);
      if (c) rpc(g, st, id, 'hireCoach', c.id);
    },
    // 越权：替其他玩家排阵（服务器强制 teamId = 调用者）
    () => {
      const others = live(g).filter((x) => x !== id);
      if (!others.length) return;
      const victim = rnd.pick(others);
      const before = JSON.stringify(myTeam(g, victim).lineup);
      rpc(g, st, id, 'autoLineup', victim, null);
      rpc(g, st, id, 'setLineupSlot', victim, 'C', null);
      check(JSON.stringify(myTeam(g, victim).lineup) === before, `越权排阵改动了 ${victim} 的阵容`);
      st.forbiddenRejected++;
      rpc(g, st, id, 'autoLineup', id, null);
    },
    // 消息 / 弹窗
    () => {
      const first = read(g, id, () => g.news[0]?.id);
      if (first) rpc(g, st, id, 'markNewsRead', first);
      if (rnd.chance(0.5)) rpc(g, st, id, 'markAllNewsRead');
      const n = read(g, id, () => g.popups.length);
      if (n) rpc(g, st, id, 'dismissPopups', n);
    },
  ];
  for (const act of rnd.shuffle(actions)) act();
}

// ---------------------------------------------------------------------------
// 比赛
// ---------------------------------------------------------------------------

function hasMatchBlocker(g: GameState, id: string): boolean {
  return M.seatBlockers(g, id).some((b) => b.code === 'tournament_running' || b.code === 'match_in_progress');
}

/** 座位在比赛上前进一步；返回是否做了操作 */
function matchStep(g: GameState, st: Stats, id: string, rnd: Rng, forceQuick: boolean): boolean {
  const am = read(g, id, () => (g.activeMatch ? { ...g.activeMatch } : null));
  if (!am) {
    const lineupBad = read(g, id, () => {
      const t = g.tournaments[g.season.registeredTournamentIds.find((x) => g.tournaments[x]?.status === 'running') ?? ''];
      return t ? validateLineup(g, id, t.id).length > 0 : false;
    });
    if (lineupBad) rpc(g, st, id, 'fillLineupWithTempSubs');
    if (forceQuick || rnd.chance(0.5)) return rpc(g, st, id, 'quickSimTournament').ok || true;
    const r = rpc(g, st, id, 'prepareNextMatch');
    if (!r.ok) rpc(g, st, id, 'quickSimTournament');
    return true;
  }
  if (am.pendingGame) {
    rpc(g, st, id, 'commitGame');
    return true;
  }
  const h = M.h2hMatch(g, am.seriesId);
  if (h && !h.done) {
    // 玩家对决
    const side = h.teamA === id ? 'A' : 'B';
    if (forceQuick || rnd.chance(0.3)) {
      const r = rpc(g, st, id, 'quickSimSeries');
      if (M.h2hMatch(g, am.seriesId)?.done || !g.multiplayer!.h2h?.[am.seriesId]) st.h2hQuickSims++;
      return r.ok;
    }
    if (!h.mode[side]) return rpc(g, st, id, 'startDraft', rnd.chance(0.5)).ok;
    const d = h.draft;
    if (!d) return false;
    const step = currentStep(d);
    if (step && step.side === side && h.mode[side] === 'manual') {
      const hero = read(g, id, () => draftSuggestions(g, d, h.teamA, h.teamB)[0]?.heroId) ?? d.available[0];
      return rpc(g, st, id, 'playerDraftAction', hero).ok;
    }
    if (d.done || !step) {
      const before = h.games.length;
      const r = rpc(g, st, id, 'playGame');
      if (r.ok && (M.h2hMatch(g, am.seriesId)?.games.length ?? before + 1) > before) st.h2hManualGames++;
      return r.ok;
    }
    return false; // 等待对手
  }
  // 对 AI：手动打一局
  const s1 = rpc(g, st, id, 'startDraft', true);
  if (!s1.ok) {
    rpc(g, st, id, 'quickSimSeries');
    return true;
  }
  for (let guard = 0; guard < 40; guard++) {
    const draft = read(g, id, () => g.activeMatch?.draft ?? null);
    if (!draft || draft.done) break;
    const hero = read(g, id, () => {
      const am2 = g.activeMatch!;
      const s = g.tournaments[am2.tournamentId].series[am2.seriesId];
      return draftSuggestions(g, am2.draft!, s.teamA!, s.teamB!)[0]?.heroId ?? am2.draft!.available[0];
    });
    if (!rpc(g, st, id, 'playerDraftAction', hero).ok) break;
  }
  if (rpc(g, st, id, 'playGame').ok) st.manualGames++;
  rpc(g, st, id, 'commitGame');
  return true;
}

function playMatches(g: GameState, st: Stats, rnd: Rng): void {
  const h2hSeen = new Set<string>();
  for (let iter = 0; iter < 600; iter++) {
    const pending = live(g).filter((id) => hasMatchBlocker(g, id));
    for (const sid of Object.keys(g.multiplayer!.h2h ?? {})) h2hSeen.add(sid);
    if (!pending.length) break;
    const forceQuick = iter > 300;
    if (iter % 3 === 1) jsonRoundTrip(g);
    let progressed = false;
    for (const id of rnd.shuffle(pending.slice())) {
      resolveDecisions(g, st, id, rnd);
      if (matchStep(g, st, id, rnd, forceQuick)) progressed = true;
    }
    check(iter < 590, `比赛无法推进（${pending.join('、')}）：${pending.map((id) => M.seatBlockers(g, id).map((b) => b.message).join('；')).join(' | ')}`);
    void progressed;
  }
  st.h2hSeries += h2hSeen.size;
}

// ---------------------------------------------------------------------------
// 一局
// ---------------------------------------------------------------------------

interface RunOut {
  state: GameState;
  stats: Stats;
  ms: number;
}

async function runGame(mode: 'build' | 'existing', seed: number, verbose: boolean): Promise<RunOut> {
  const t0 = performance.now();
  const rnd = seededRng(seed * 7919 + (mode === 'build' ? 1 : 2));
  const st = newStats();
  const players = mode === 'build'
    ? [
      { sessionId: 's-a', name: '小明', newClub: { name: '星火电竞', tag: 'SPK', region: 'CN' as const, color: '#c23c2a' } },
      { sessionId: 's-b', name: '小红', newClub: { name: 'Nordic Wolves', tag: 'NW', region: 'EU' as const, color: '#3a7bd5' } },
      { sessionId: 's-c', name: '小刚', newClub: { name: '龙城战队', tag: 'LCD', region: 'CN' as const, color: '#d4a017' } },
    ]
    : (() => {
      // 起始 TI 的前三支真实战队（roster 按实力排序）
      const real = readRosterSync(START_TI).teams.slice(0, 3).map((t) => t.id);
      return [
        { sessionId: 's-a', name: '小明', teamId: real[0] },
        { sessionId: 's-b', name: '小红', teamId: real[1] },
        { sessionId: 's-c', name: '小刚', teamId: real[2] },
      ];
    })();
  const g = await M.createMultiplayerGame({
    startTi: START_TI, endTi: START_TI + SEASONS - 1, difficulty: 'normal', mode, players, seed,
  });
  ledgerBase.clear();
  checkCheap(g, '开局');
  checkSeatViews(g, '开局');
  const ids = g.multiplayer!.order.slice();
  if (mode === 'existing') {
    for (const id of ids) {
      const t = g.teams[id];
      // 荣誉重置为新俱乐部标准；赛季初的随机事件（如粉丝见面会 +3）可能已让它小幅变动
      check(t.isPlayer && Math.abs(t.honor - CONFIG.team.newClubHonor) <= 15 && !t.coachId,
        `existing：${id} 未重置为新俱乐部标准（荣誉 ${t.honor}，主教练 ${t.coachId ?? '无'}）`);
      const real = t.playerIds.map((pid) => g.players[pid]).filter((p) => p.isReal);
      check(real.length >= 5, `existing：${id} 应保留真实选手身份`);
    }
  }
  const eliminateAt = mode === 'existing' && SEASONS >= 2 ? { ti: START_TI + 1, round: 3 } : null;

  for (let step = 0; step < 400 && !g.gameOver; step++) {
    // 1. 随机交错的回合操作
    for (const id of rnd.shuffle(live(g).slice())) {
      resolveDecisions(g, st, id, rnd);
      randomActions(g, st, id, rnd);
    }
    raceForFreeAgent(g, st, rnd);
    // 2. 比赛
    playMatches(g, st, rnd);
    // 3. 出局测试：existing 玩法第二赛季让一名玩家荣誉跌破 0
    // 只在至少还有两名玩家时制造出局（最后一名玩家出局 = 游戏结束，不是「其余玩家继续」）
    if (eliminateAt && g.season.ti === eliminateAt.ti && g.roundIndex === eliminateAt.round && st.forcedEliminations === 0
      && !g.gameOver && live(g).length >= 2 && live(g).includes(ids[2])) {
      const victim = ids[2];
      applyHonorChange(g, victim, -(g.teams[victim].honor + 50), '模拟：连续丑闻', true);
      check(g.multiplayer!.seats[victim].eliminated && g.teams[victim].disbanded && !g.gameOver, '出局：座位应出局且游戏继续');
      M.callAsSeat(g, ids[0], 'markAllNewsRead', []); // 触发出局收尾
      check(g.teams[victim].playerIds.length === 0, '出局：选手应成为自由选手');
      const r = M.callAsSeat(g, victim, 'doTraining', []) as Res;
      check(!r.ok, '出局：观战座位不能再操作');
      st.forcedEliminations++;
      if (verbose) log(`  ✗ ${g.multiplayer!.seats[victim].name} 出局（${g.teams[victim].name} 解散），其余玩家继续`);
    }
    // 全部玩家出局（荣誉自然跌破 0）→ 游戏提前结束
    if (g.gameOver) break;
    // 4. 准备
    for (let guard = 0; guard < 20; guard++) {
      let all = true;
      for (const id of live(g)) {
        resolveDecisions(g, st, id, rnd);
        const r = M.setSeatReady(g, id, true);
        if (!r.ok) {
          all = false;
          if (hasMatchBlocker(g, id)) playMatches(g, st, rnd);
          else if (guard > 15) throw new Fail(`${id} 无法准备：${r.message}`);
        }
      }
      if (all) break;
    }
    check(M.allSeatsReady(g), '全部座位应已准备');
    const prevTi = g.season.ti;
    const r = M.advanceMultiplayer(g);
    check(r.ok, `推进失败：${r.message}`);
    st.rounds++;
    jsonRoundTrip(g);
    checkCheap(g, `推进后 TI${g.season.ti} R${g.roundIndex}`);
    checkSeatViews(g, `推进后 TI${g.season.ti} R${g.roundIndex}`);
    if (g.season.ti !== prevTi || g.gameOver) {
      // 赛季结束：上赛季全部赛事已收尾（全部玩家中途出局 / 全员假赛除名而提前结束时，本赛季赛事停在当时的状态，不检查）
      const ended = g.gameOver as GameState['gameOver']; // 循环条件把 gameOver 收窄成了 null，这里重新取类型
      if (g.season.ti !== prevTi || ended?.reason === 'completed') {
        for (const t of Object.values(g.tournaments)) {
          if (t.season === prevTi) check(t.status === 'finished', `TI${prevTi} 赛事 ${t.name} 未结束（${t.status}）`);
        }
      }
      if (verbose) {
        const parts = ids.map((id) => {
          const t = g.teams[id];
          const seat = g.multiplayer!.seats[id];
          const sum = read(g, id, () => g.history.seasons[g.history.seasons.length - 1]);
          return `${seat.name}·${t.tag} ${seat.eliminated ? '出局' : `荣誉 ${Math.round(t.honor)} 资金 ${Math.round(t.gold / 1000)}k`}`
            + (sum && !seat.eliminated ? ` TI:${sum.playerTiRank ? `${sum.playerTiRank[0]}-${sum.playerTiRank[1]}` : '未进'}` : '');
        });
        log(`  TI${prevTi} 结束 | ${parts.join(' | ')}`);
      }
    }
  }
  check(!!g.gameOver, '模拟未在步数上限内结束');
  st.eliminated = ids.filter((id) => g.multiplayer!.seats[id].eliminated).length;
  // 正常结束（到达终点 TI），或全部玩家出局（每个座位都已出局、战队解散）
  const allOut = ids.every((id) => g.multiplayer!.seats[id].eliminated && g.teams[id].disbanded);
  check(g.gameOver.reason === 'completed' || ((g.gameOver.reason === 'disbanded' || g.gameOver.reason === 'banned') && allOut),
    `游戏应正常结束或全部出局（${g.gameOver.reason}，出局 ${st.eliminated}/${ids.length}）`);
  if (g.gameOver.reason === 'disbanded' && verbose) log(`  全部玩家出局，游戏提前结束（TI${g.season.ti} 第 ${g.roundIndex} 回合）`);
  // 生涯档案（legacy.ts）：每个座位按赛季递增、无重复；出局座位恰好冻结一次且是最后一条；结算页报告可算
  for (const id of ids) {
    const seat = g.multiplayer!.seats[id];
    const log = g.legacyLog?.[id] ?? [];
    const tis = log.map((r) => r.ti);
    check(tis.every((t, i) => i === 0 || t > tis[i - 1]), `${seat.name} 生涯档案赛季不递增：${tis.join(',')}`);
    check(tis.every((t) => t >= g.settings.startTi && t <= g.season.ti), `${seat.name} 生涯档案赛季越界：${tis.join(',')}`);
    const ends = log.filter((r) => r.ending);
    if (seat.eliminated) {
      check(ends.length === 1 && log[log.length - 1] === ends[0], `${seat.name} 出局后生涯档案应恰好冻结一次（${ends.length}）`);
    } else {
      check(ends.length === 0, `${seat.name} 未出局却有冻结的档案`);
      if (g.gameOver.reason === 'completed') {
        check(log.length === g.settings.endTi - g.settings.startTi + 1, `${seat.name} 生涯档案赛季数 ${log.length} 与执教区间不符`);
      }
    }
    try {
      const r = computeLegacyReport(M.seatView(g, id), id, ids);
      check(r.board.some((b) => b.kind === 'self') && r.board.filter((b) => b.kind === 'human').length === ids.length - 1,
        `${seat.name} 结算页排行榜应含全部人类俱乐部`);
      check(r.ending === (g.teams[id].banned ? 'banned' : seat.eliminated ? 'disbanded' : 'completed'), `${seat.name} 结局判定错误（${r.ending}）`);
    } catch (e) {
      if (e instanceof Fail) throw e;
      check(false, `${seat.name} 生涯总结计算失败：${String(e)}`);
    }
  }
  return { state: g, stats: st, ms: performance.now() - t0 };
}

/** 键顺序无关的 JSON（座位换入换出会改变对象键的插入顺序） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** 对局指纹：各座位视图（座位私有数据已换入、表示形式已规范化）的规范 JSON */
function fingerprint(g: GameState): string {
  return g.multiplayer!.order.map((id) => {
    const { createdAt: _c, ...rest } = M.seatView(g, id);
    return canonical(rest);
  }).join('\n');
}

async function main(): Promise<void> {
  const modes: ('build' | 'existing')[] = MODE === 'both' ? ['build', 'existing'] : [MODE as 'build' | 'existing'];
  const t0 = performance.now();
  let races = 0;
  let h2h = 0;
  const ran: string[] = [];
  for (const mode of modes) {
    if (mode === 'existing') {
      try {
        readRosterSync(START_TI);
      } catch {
        log(`== 跳过「选择已有战队」：TI${START_TI} 没有真实阵容数据`);
        continue;
      }
    }
    ran.push(mode);
    log(`== 多人模拟：${mode === 'build' ? '各自组建战队' : '选择已有战队'} · TI${START_TI} 起 ${SEASONS} 个赛季 · 3 名玩家 · 种子 ${SEED}`);
    const out = await runGame(mode, SEED, true);
    const s = out.stats;
    log(`   回合 ${s.rounds} · RPC ${s.rpc}（成功 ${s.rpcOk}）· 训练 ${s.trainings} · 签约 ${s.signings}（超出常规上限 ${s.overSoftSignings}；抢签 ${s.races} 次，后到者均被拒）`
      + ` · 求购 ${s.bidsOk}/${s.bids} · 手动对局 ${s.manualGames} · 玩家对决 ${s.h2hSeries} 场（手动局 ${s.h2hManualGames}，双方快速模拟 ${s.h2hQuickSims}）`
      + ` · 越权调用被拦截 ${s.forbiddenRejected} · 出局 ${s.eliminated}（其中模拟制造 ${s.forcedEliminations}） · ${Math.round(out.ms)}ms`);
    races += s.races;
    h2h += s.h2hSeries;
    if (CHECK_DETERMINISM) {
      CHECKS = false;
      ROUNDTRIP = false;
      const again = await runGame(mode, SEED, false);
      CHECKS = true;
      ROUNDTRIP = true;
      check(fingerprint(again.state) === fingerprint(out.state), '同一种子两次模拟结果不一致（确定性被破坏）');
      log(`   确定性：同一种子重跑（不做检查、不做 JSON 往返）结果一致 · ${Math.round(again.ms)}ms`);
    }
  }
  check(races > 0, '没有发生抢签（先到先得未被验证）');
  check(h2h > 0, '没有发生玩家对决（H2H 未被验证）');
  console.log(`OK 多人模拟通过（${ran.join(' + ')}）· 总耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e instanceof Fail ? `FAIL ${e.message}` : e);
  process.exit(1);
});
