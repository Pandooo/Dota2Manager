// ============================================================================
// 局域网多人端到端测试：在进程内启动服务器（随机端口），3 个 WebSocket 客户端走完整流程。
// 用法：npx tsx scripts/mp-e2e.ts [--mode existing|build|both] [--ti 9] [--seasons 1] [--verbose] [--keep]
//   - 建房 / 加入 / 房间设置 / 选队（existing）或填写俱乐部（build）/ 冲突校验 / 准备 / 开始；
//   - 两名玩家同时抢签同一名自由选手 → 恰好一人成功，另一人收到「已被 XX 签下」，其他玩家收到快讯；
//   - 训练 / 报名 / 处理事件 / 手动打一场系列赛（BP → 开打 → 提交）/ 快速模拟，所有人准备 → 服务器推进回合，
//     至少打完一个完整赛季；中途一名玩家断线重连；
//   - 每个客户端收到的每一份座位视图都检查：主视角正确、其他座位的私有数据（财务、待决事件、弹窗……）不外泄；
//   - 赛季结束后重启服务器（同一数据目录），全员重连继续推进一回合；
//   - 结束时关闭服务器。任何检查失败 → 退出码 1。
// ============================================================================
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readRosterSync, registerNodeRosterLoader } from './nodeData';
import type { GameState, Player } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import {
  currentPlayerTournament, getAdvanceBlockers, trainingBlockReason, trainingSessionsLeft,
} from '../src/engine/game';
import { benchPlayers, rosterRoom, validateLineup } from '../src/engine/team';
import { freeAgents, isTransferWindowOpen, playerWillingness, signingFee } from '../src/engine/market';
import { playerNextSeries } from '../src/engine/tournament';
import { hashSeed, seededRng } from '../src/engine/rng';
import { startServer, type RunningServer } from '../server/app';
import { TestClient, until } from '../server/testClient';
import { mySeat } from '../src/shared/protocol';
import type { NewClubSpec, RoomSettings } from '../src/shared/protocol';

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
const TI = Number(typeof args.ti === 'string' ? args.ti : 9);
const SEASONS = Math.max(1, Number(typeof args.seasons === 'string' ? args.seasons : 1));
const MODES: RoomSettings['mode'][] = args.mode === 'existing' ? ['existing'] : args.mode === 'build' ? ['build'] : ['existing', 'build'];
const VERBOSE = !!args.verbose;
const KEEP = !!args.keep;
const MAX_ROUNDS = 120 * SEASONS;

registerNodeRosterLoader();

// ---------------------------------------------------------------------------
// 断言 / 日志
// ---------------------------------------------------------------------------
const failures: string[] = [];
const warnings: string[] = [];
let checks = 0;
function check(cond: unknown, what: string): void {
  checks++;
  if (!cond) {
    failures.push(what);
    console.log(`  ✗ ${what}`);
  } else if (VERBOSE) console.log(`  ✓ ${what}`);
}
function warn(what: string): void {
  warnings.push(what);
  console.log(`  ! ${what}`);
}
function vlog(...a: unknown[]): void {
  if (VERBOSE) console.log('   ·', ...a);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 隐私检查：每一份座位视图
// ---------------------------------------------------------------------------
const PRIVATE_TOP = ['finance', 'pendingDecisions', 'popups', 'activeMatch', 'tempSubCandidates', 'beefs'];

function nonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** 返回违规描述（空 = 通过） */
function viewViolations(view: GameState, me: string): string[] {
  const out: string[] = [];
  if (view.settings?.playerTeamId !== me) out.push(`主视角错误：settings.playerTeamId=${view.settings?.playerTeamId}，应为 ${me}`);
  const mp = view.multiplayer;
  if (!mp) {
    out.push('视图缺少 multiplayer');
    return out;
  }
  const humans = Object.keys(mp.seats ?? {});
  if (!humans.includes(me)) out.push(`multiplayer.seats 中没有自己的战队 ${me}`);
  for (const t of humans) {
    if (t === me) continue;
    const saved = (mp.seats[t]?.saved ?? {}) as Record<string, unknown>;
    const top = (saved.top ?? {}) as Record<string, unknown>;
    for (const k of PRIVATE_TOP) if (nonEmpty(top[k])) out.push(`其他座位 ${t} 的私有字段 saved.top.${k} 外泄`);
    if (nonEmpty(saved.history)) out.push(`其他座位 ${t} 的 saved.history 外泄`);
    if (nonEmpty(saved.tournaments)) out.push(`其他座位 ${t} 的 saved.tournaments 外泄`);
  }
  for (const n of view.news ?? []) {
    if (n.visibility !== 'private') continue;
    if (n.actorTeamId && n.actorTeamId !== me && humans.includes(n.actorTeamId)) {
      out.push(`其他玩家（${n.actorTeamId}）的私有新闻外泄：${n.title}`);
    } else if (!n.actorTeamId && n.teamIds?.length && humans.includes(n.teamIds[0]) && n.teamIds[0] !== me && !n.teamIds.includes(me)) {
      out.push(`其他玩家（${n.teamIds[0]}）的私有新闻外泄：${n.title}`);
    }
  }
  return out;
}

/** 与服务器权威状态对照：其他座位的待决事件 id 不出现在我的视图中 */
function crossCheck(server: RunningServer, roomId: string, players: Seat[]): void {
  const state = server.rooms.getRoomState(roomId);
  if (!state?.multiplayer) return;
  for (const p of players) {
    const view = p.c.state;
    if (!view) continue;
    const json = JSON.stringify(view);
    for (const other of players) {
      if (other === p || !other.c.state) continue;
      for (const d of other.c.state.pendingDecisions ?? []) {
        if (json.includes(`"${d.id}"`) && !(view.pendingDecisions ?? []).some((x) => x.id === d.id)) {
          failures.push(`${p.name} 的视图包含 ${other.name} 的待决事件 ${d.id}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 玩家（客户端 + 自动经营状态）
// ---------------------------------------------------------------------------
interface Seat {
  name: string;
  sessionId: string;
  c: TestClient;
  team: string;
  registeredSeason: number;
  manualPlayed: number;
  calls: number;
  failedCalls: number;
  callMs: number;
  /** 断线中、由服务器托管 */
  offline?: boolean;
  /** 开局时设置的训练重点（座位私有）：之后收到的每一份视图都必须是自己的 */
  focus?: string;
}

function view(p: Seat): GameState {
  if (!p.c.state) throw new Error(`${p.name} 还没有收到游戏视图`);
  return p.c.state;
}

async function call(p: Seat, fn: string, ...a: unknown[]): Promise<{ ok: boolean; message: string; result?: unknown }> {
  const t0 = performance.now();
  const r = await p.c.call(fn, ...a);
  p.calls++;
  p.callMs += performance.now() - t0;
  if (!r.ok) p.failedCalls++;
  vlog(`${p.name} ${fn}(${a.map((x) => JSON.stringify(x)).join(', ')}) → ${r.ok ? 'ok' : '失败'} ${r.message}`);
  return r;
}

/** 每一份座位视图的检查（p.focus 在开局设置训练重点后才有值，因此每次读取） */
function viewChecker(p: { name: string; focus?: string }): (state: GameState, client: TestClient) => void {
  return (state, client) => {
    const me = client.seat?.gameTeamId ?? state.settings?.playerTeamId;
    const v = viewViolations(state, me);
    // 座位私有字段换错（视图里是其他座位的训练重点）
    if (p.focus && state.trainingFocus !== p.focus) v.push(`训练重点应为 ${p.focus}，视图中为 ${state.trainingFocus}`);
    if (v.length) throw new Error(`[${p.name}] ${v.join('；')}`);
  };
}

function makeClient(url: string, p: { name: string; sessionId: string; focus?: string }): TestClient {
  const c = new TestClient(url, { sessionId: p.sessionId, name: p.name, label: p.name });
  c.onState = viewChecker(p);
  c.onRoom = (room, client) => {
    // 房间信息不含任何会话 ID（会话 ID 是重连凭证，泄露后可被冒充），座位用座位键识别
    const json = JSON.stringify(room);
    if ([...ALL_SESSIONS].some((sid) => json.includes(sid))) throw new Error(`[${p.name}] 房间信息包含会话 ID`);
    if (!mySeat(room) || !room.seats.some((s) => s.seatKey === room.hostSeatKey)) {
      throw new Error(`[${p.name}] 房间信息中找不到自己的座位或房主座位（${client.label}）`);
    }
  };
  return c;
}
/** 本次 e2e 所有玩家的真实会话 ID */
const ALL_SESSIONS = new Set<string>();
/** 已被替换（断线重连 / 重启）的客户端记录的违规，汇总时一并检查 */
const retiredViolations: string[] = [];
function replaceClient(p: Seat, c: TestClient): void {
  retiredViolations.push(...p.c.violations.map((v) => `${p.name}：${v}`));
  p.c = c;
}

/** 签约自由选手的成功判定（与 market.signFreeAgent 的意愿掷骰一致：确定性） */
function wouldAccept(v: GameState, p: Player, teamId: string): boolean {
  const will = playerWillingness(v, p.id, teamId);
  const roll = seededRng(hashSeed(`${v.id}|${v.season?.ti ?? 0}|${v.roundIndex}|sign|${p.id}|${teamId}`)).next();
  return roll < will;
}

// ---------------------------------------------------------------------------
// 自动经营（每个客户端一轮操作）
// ---------------------------------------------------------------------------
async function resolveDecisions(p: Seat): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    const d = view(p).pendingDecisions?.[0];
    if (!d) return;
    const r = await call(p, 'resolveDecision', d.id, d.choices[0]?.id ?? '');
    if (!r.ok && view(p).pendingDecisions?.[0]?.id === d.id) {
      warn(`${p.name} 无法处理事件「${d.title}」：${r.message}`);
      return;
    }
  }
}

async function dismissPopups(p: Seat): Promise<void> {
  for (let guard = 0; guard < 10 && (view(p).popups?.length ?? 0) > 0; guard++) await call(p, 'dismissPopup');
}

async function preseason(p: Seat): Promise<void> {
  const v = view(p);
  if (v.phase !== 'preseason' || p.registeredSeason === v.season.ti) return;
  p.registeredSeason = v.season.ti;
  const tierRank: Record<string, number> = { ti: 5, major: 4, premier: 3, minor: 2, qualifier: 1 };
  const open = v.seasonTournamentIds
    .map((id) => v.tournaments[id])
    .filter((t) => t && t.tier !== 'ti' && t.playerStatus === 'open')
    .sort((a, b) => tierRank[b.tier] - tierRank[a.tier]);
  let n = 0;
  for (const t of open) if ((await call(p, 'registerForTournament', t.id)).ok) n++;
  vlog(`${p.name} 报名 ${n}/${open.length} 项赛事`);
}

async function fixRoster(p: Seat): Promise<void> {
  const v = view(p);
  const team = v.teams[p.team];
  if (!team) return;
  // 机器人策略：超出常规上限（引擎不强制，只是工资照付、替补归属感下降更快）时解约最弱的替补
  for (let guard = 0; guard < 4 && rosterRoom(view(p), p.team) < 0; guard++) {
    const bench = benchPlayers(view(p), p.team).filter((x) => !x.tempSubUntilTournament);
    const victim = bench.sort((a, b) => a.power - b.power)[0];
    if (!victim) break;
    const vv = view(p);
    const free = victim.draft?.ti === vv.season.ti && victim.draft.teamId === p.team && vv.phase === 'preseason';
    await call(p, free ? 'releaseDraftedRookie' : 'releasePlayer', victim.id);
  }
  // 正式队员不足 5 人且窗口开放：签下负担得起的自由选手
  const regulars = team.playerIds.map((id) => v.players[id]).filter((x) => x && x.status === 'active' && !x.tempSubUntilTournament && !x.isWildSub).length;
  if (regulars < POSITIONS.length && isTransferWindowOpen(v)) {
    for (const pos of POSITIONS) {
      const vv = view(p);
      if (vv.teams[p.team].lineup[pos] || rosterRoom(vv, p.team) <= 0) continue;
      const pool = freeAgents(vv).filter((x) => x.position === pos && signingFee(vv, x) <= vv.teams[p.team].gold)
        .sort((a, b) => signingFee(vv, a) - signingFee(vv, b)).slice(0, 3);
      for (const x of pool) if ((await call(p, 'signFreeAgent', x.id)).ok) break;
    }
    await call(p, 'autoLineup', p.team);
  }
}

async function train(p: Seat): Promise<void> {
  const v = view(p);
  if (trainingBlockReason(v) || trainingSessionsLeft(v) <= 0) return;
  await call(p, 'doTraining');
}

/** 手动打一整场系列赛：准备 → 自动 BP → 开打 → 提交（对手为 AI 时） */
async function manualSeries(p: Seat, tid: string): Promise<boolean> {
  const v = view(p);
  const s = playerNextSeries(v, tid);
  if (!s) return false;
  const opp = s.teamA === p.team ? s.teamB : s.teamA;
  if (!opp || v.multiplayer?.seats?.[opp]) return false; // 玩家对玩家的系列赛交给快速模拟
  const prep = await call(p, 'prepareNextMatch');
  if (!prep.ok || !view(p).activeMatch) return false;
  let games = 0;
  for (let guard = 0; guard < 8 && view(p).activeMatch; guard++) {
    const d = await call(p, 'startDraft', false);
    if (!d.ok) break;
    const g = await call(p, 'playGame');
    if (!g.ok) break;
    check(!!view(p).activeMatch?.pendingGame?.live?.length, `${p.name} 手动对局生成了直播事件`);
    const c = await call(p, 'commitGame');
    if (!c.ok) break;
    games++;
  }
  if (view(p).activeMatch) await call(p, 'quickSimSeries');
  p.manualPlayed++;
  console.log(`  · ${p.name} 手动打完一场系列赛（${games} 局）：${v.tournaments[tid]?.name ?? tid}`);
  return games > 0;
}

/** 玩家对玩家的系列赛（seriesId → 描述 / 赛事 / 双方） */
const h2hSeen = new Map<string, string>();
const h2hInfo = new Map<string, { tid: string; a: string; b: string; checked: boolean }>();

/** 已结束的玩家对决：双方视图中的结果一致 */
function checkH2HResults(seats: Seat[]): void {
  for (const [sid, h] of h2hInfo) {
    if (h.checked) continue;
    const pa = seats.find((p) => p.team === h.a);
    const pb = seats.find((p) => p.team === h.b);
    // 一方离线（托管中）时没有它的最新视图：等它重连后再比对（赛事压缩只清对局记录，结果保留）
    if (!pa || !pb) continue;
    const ra = pa?.c.state?.tournaments[h.tid]?.series[sid]?.result;
    const rb = pb?.c.state?.tournaments[h.tid]?.series[sid]?.result;
    if (!ra && !rb) continue;
    h.checked = true;
    check(!!ra && !!rb && ra.winnerId === rb.winnerId && ra.scoreA === rb.scoreA && ra.scoreB === rb.scoreB,
      `玩家对决结果双方一致（${h2hSeen.get(sid)}：${ra ? `${ra.scoreA}:${ra.scoreB}` : '?'} / ${rb ? `${rb.scoreA}:${rb.scoreB}` : '?'}）`);
  }
}

async function playMatches(p: Seat): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const v = view(p);
    const t = currentPlayerTournament(v);
    if (!t && !v.activeMatch) return;
    const next = t ? playerNextSeries(v, t.id) : null;
    if (t && next) {
      const opp = next.teamA === p.team ? next.teamB : next.teamA;
      if (opp && v.multiplayer?.seats?.[opp] && !h2hSeen.has(next.id)) {
        h2hSeen.set(next.id, `${t.name} ${v.teams[next.teamA ?? ""]?.tag} vs ${v.teams[next.teamB ?? ""]?.tag}`);
        h2hInfo.set(next.id, { tid: t.id, a: next.teamA!, b: next.teamB!, checked: false });
        console.log(`  · 玩家对决：${h2hSeen.get(next.id)}`);
      }
    }
    await resolveDecisions(p);
    if (t && validateLineup(view(p), p.team, t.id).length) await call(p, 'fillLineupWithTempSubs');
    if (t && p.manualPlayed === 0 && !view(p).activeMatch && playerNextSeries(view(p), t.id)) {
      const before = p.manualPlayed;
      await manualSeries(p, t.id);
      // 玩家对玩家的系列赛（或无法开赛）时 manualSeries 不打：交给下方的快速模拟，否则首场就是玩家对决的座位永远不会请求快速模拟（回合卡死）
      if (p.manualPlayed > before) continue;
    }
    const r = await call(p, 'quickSimTournament');
    if (r.ok) continue;
    if (/阵容|首发|替补/.test(r.message)) await call(p, 'fillLineupWithTempSubs');
    else return; // 例如等待对手同意快速模拟：下一轮再试
  }
}

async function autopilot(p: Seat): Promise<void> {
  const st = p.c.roundStatus;
  if (st?.eliminated?.[p.team] || view(p).gameOver) return;
  await dismissPopups(p);
  await resolveDecisions(p);
  await preseason(p);
  await fixRoster(p);
  await train(p);
  await playMatches(p);
  await resolveDecisions(p);
}

/** 请求准备：返回 null = 成功，否则错误信息 */
async function ready(p: Seat): Promise<string | null> {
  const st = p.c.roundStatus;
  if (st?.ready?.[p.team]) return null;
  const key = `${st?.season}|${st?.round}`;
  const r = await p.c.request(
    { t: 'setRoundReady', ready: true },
    'roundStatus',
    (m) => m.status.ready[p.team] === true || `${m.status.season}|${m.status.round}` !== key,
    20_000,
  );
  return r.t === 'error' ? r.message : null;
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------
async function lobby(server: RunningServer, mode: RoomSettings['mode'], seats: Seat[]): Promise<string> {
  const [host, ...rest] = seats;
  for (const p of seats) await p.c.hello();
  const created = await host.c.request({ t: 'createRoom', name: `E2E · ${mode}`, maxPlayers: 4 }, 'room', (m) => !!m.room);
  if (created.t !== 'room' || !created.room) throw new Error(`建房失败：${created.t === 'error' ? created.message : ''}`);
  const roomId = created.room.id;
  check(/^[A-Z0-9]{6}$/.test(roomId), `房间码为 6 位大写字母数字（${roomId}）`);
  await until(() => rest.every((p) => p.c.rooms.some((r) => r.id === roomId)), 5000, '房间列表推送');
  for (const p of rest) {
    const r = await p.c.request({ t: 'joinRoom', roomId }, 'room', (m) => !!mySeat(m.room));
    check(r.t === 'room', `${p.name} 加入房间`);
  }
  // 非房主不能改设置
  const nh = await rest[0].c.request({ t: 'updateSettings', settings: { difficulty: 'hard' } }, 'room', () => false);
  check(nh.t === 'error', '非房主修改设置被拒绝');
  const settings: Partial<RoomSettings> = { mode, startTi: TI, endTi: Math.min(16, TI + SEASONS), difficulty: 'normal' };
  const set = await host.c.request({ t: 'updateSettings', settings }, 'room', (m) => m.room?.settings.mode === mode && m.room.settings.startTi === TI);
  check(set.t === 'room', `房主设置：${mode} · TI${TI}→TI${settings.endTi}`);
  await until(() => rest.every((p) => p.c.room?.settings.mode === mode), 5000, '设置同步');

  if (mode === 'existing') {
    const roster = readRosterSync(TI);
    const teams = roster.teams.filter((t) => t.atTI).slice(0, seats.length);
    if (teams.length < seats.length) teams.push(...roster.teams.filter((t) => !teams.includes(t)).slice(0, seats.length - teams.length));
    for (let i = 0; i < seats.length; i++) {
      const p = seats[i];
      const r = await p.c.request({ t: 'updateSeat', teamId: teams[i].id }, 'room', (m) => mySeat(m.room)?.teamId === teams[i].id);
      check(r.t === 'room', `${p.name} 选择 ${teams[i].name}`);
      if (i === 0) await until(() => rest.every((q) => q.c.room?.seats.some((s) => s.teamId === teams[0].id)), 5000, '选队同步');
    }
    const clash = await rest[0].c.request({ t: 'updateSeat', teamId: teams[0].id }, 'room', () => false);
    check(clash.t === 'error' && clash.message.includes('已被'), `重复选队被拒绝（${clash.t === 'error' ? clash.message : ''}）`);
  } else {
    const clubs: NewClubSpec[] = [
      { name: '星火电竞', tag: 'SPK', region: 'CN', color: '#c23c2a' },
      { name: 'Aurora Five', tag: 'AUR', region: 'CN', color: '#2a7bc2' },
      { name: '北境之狼', tag: 'NWLF', region: 'CN', color: '#3aa35b' },
    ];
    for (let i = 0; i < seats.length; i++) {
      const p = seats[i];
      const r = await p.c.request({ t: 'updateSeat', newClub: clubs[i] }, 'room', (m) => mySeat(m.room)?.newClub?.tag === clubs[i].tag);
      check(r.t === 'room', `${p.name} 填写俱乐部 ${clubs[i].name}`);
    }
    await until(() => rest.every((q) => q.c.room?.seats.every((s) => !!s.newClub)), 5000, '俱乐部同步');
    const dup = await rest[0].c.request({ t: 'updateSeat', newClub: { ...clubs[1], tag: clubs[0].tag } }, 'room', () => false);
    check(dup.t === 'error', `俱乐部简称重复被拒绝（${dup.t === 'error' ? dup.message : ''}）`);
  }

  // 准备（最后一人准备前尝试开始 → 被拒）
  for (let i = 0; i < seats.length; i++) {
    const p = seats[i];
    if (i === seats.length - 1) {
      const early = await host.c.request({ t: 'startGame' }, 'state', () => false);
      check(early.t === 'error' && early.message.includes('未准备'), '未全员准备时不能开始');
    }
    const r = await p.c.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!mySeat(m.room)?.lobbyReady);
    check(r.t === 'room', `${p.name} 准备`);
  }
  await until(() => host.c.room?.seats.every((s) => s.lobbyReady) ?? false, 5000, '全员准备');
  const t0 = performance.now();
  const states = rest.map((p) => p.c.waitFor('state', () => true, 120_000));
  const started = await host.c.request({ t: 'startGame' }, 'state', () => true, 120_000);
  if (started.t === 'error') {
    for (const s of states) s.catch(() => undefined);
    throw new Error(`开始游戏失败：${started.message}`);
  }
  await Promise.all(states);
  await until(() => seats.every((p) => !!p.c.roundStatus), 10_000, '回合状态');
  console.log(`  · 开局完成（${(performance.now() - t0).toFixed(0)}ms）`);
  for (const p of seats) {
    const seat = p.c.seat;
    p.team = seat?.gameTeamId ?? '';
    check(!!p.team && p.c.state?.settings.playerTeamId === p.team, `${p.name} 的视图以自己的战队为主视角（${p.team}）`);
    check(!!p.c.state?.teams[p.team]?.isPlayer, `${p.name} 的战队标记为玩家战队`);
  }
  check(new Set(seats.map((p) => p.team)).size === seats.length, '每位玩家控制不同的战队');
  // 新秀选秀：全局只举行一次，每位玩家各收到一个选秀结果弹窗；赛季初可免费放弃选中的新秀
  for (const p of seats) {
    const v = view(p);
    const rec = (v.rookieDraft?.history ?? []).filter((r) => r.ti === v.season.ti);
    check(rec.length === 1, `${p.name} 的视图中本赛季选秀恰好举行一次`);
    check((v.popups ?? []).filter((x) => x.kind === 'rookie_draft').length === 1, `${p.name} 收到一个选秀结果弹窗`);
  }
  {
    const p = seats[0];
    const v = view(p);
    const rookie = v.teams[p.team]?.playerIds.map((id) => v.players[id]).find((x) => x?.draft?.ti === v.season.ti && x.draft.teamId === p.team);
    if (rookie) {
      const r = await call(p, 'releaseDraftedRookie', rookie.id);
      check(r.ok && !view(p).players[rookie.id]?.teamId, `${p.name} 免费放弃选秀新秀 ${rookie.handle}`);
      await until(() => !view(seats[1]).players[rookie.id]?.teamId, 5_000, '其他玩家的视图同步放弃结果');
    }
    const other = seats[1];
    const ov = view(other);
    const theirs = ov.teams[other.team]?.playerIds.map((id) => ov.players[id]).find((x) => x?.draft?.ti === ov.season.ti);
    if (theirs) {
      const r = await call(p, 'releaseDraftedRookie', theirs.id);
      check(!r.ok && view(p).players[theirs.id]?.teamId === other.team, '不能放弃其他玩家选中的新秀');
    }
  }
  // 每位玩家设置不同的训练重点（座位私有）；之后每一份视图都校验是自己的
  const focuses = ['power', 'mmr', 'insight'];
  for (let i = 0; i < seats.length; i++) {
    const p = seats[i];
    const r = await call(p, 'setTrainingFocus', focuses[i % focuses.length]);
    check(r.ok && view(p).trainingFocus === focuses[i % focuses.length], `${p.name} 设置训练重点 ${focuses[i % focuses.length]}`);
    p.focus = focuses[i % focuses.length];
    p.c.onState = viewChecker(p);
  }
  return roomId;
}

/** 两名玩家同时签同一名自由选手 */
async function race(seats: Seat[]): Promise<boolean> {
  const [a, b, c] = seats;
  const v = view(b);
  if (!isTransferWindowOpen(v)) return false;
  const cands = freeAgents(v)
    .filter((p) => [b, c].every((s) => rosterRoom(v, s.team) > 0 && v.teams[s.team].gold >= signingFee(v, p)))
    .map((p) => ({ p, both: wouldAccept(v, p, b.team) && wouldAccept(v, p, c.team), fee: signingFee(v, p) }))
    .sort((x, y) => Number(y.both) - Number(x.both) || x.fee - y.fee);
  const target = cands[0];
  if (!target) return false;
  if (!target.both) warn(`没有双方都会接受的自由选手，抢签目标 ${target.p.handle} 可能婉拒`);
  const handle = target.p.handle;
  const feedA0 = a.c.feeds.length;
  const pb = b.c.callAsync('signFreeAgent', target.p.id);
  const pc = c.c.callAsync('signFreeAgent', target.p.id);
  const [rb, rc] = await Promise.all([pb, pc]);
  console.log(`  · 抢签 ${handle}：${b.name} → ${rb.ok ? '成功' : rb.message}；${c.name} → ${rc.ok ? '成功' : rc.message}`);
  check(!(rb.ok && rc.ok), '同一名自由选手不会被两人同时签下');
  if (target.both) check(rb.ok !== rc.ok, '抢签恰好一人成功');
  const winner = rb.ok ? b : rc.ok ? c : null;
  const loser = winner === b ? c : b;
  const loserReply = winner === b ? rc : rb;
  if (!winner) return true;
  check(loserReply.message.includes(`已被玩家「${winner.name}」`), `后到者收到明确的失败提示（${loserReply.message}）`);
  check(view(winner).players[target.p.id]?.teamId === winner.team, '成功者的视图立即包含新签选手');
  await until(() => a.c.feeds.length > feedA0, 5000, '快讯').catch(() => undefined);
  const item = a.c.feeds.slice(feedA0).find((f) => f.actorName === winner.name && f.title.includes(handle));
  check(!!item, `其他玩家收到快讯：${item ? item.title : '（无）'}`);
  check(!winner.c.feeds.some((f) => f.title.includes(handle) && f.actorName === winner.name), '操作者自己不收到自己的快讯');
  await until(() => view(loser).players[target.p.id]?.teamId === winner.team, 5000, '失败者视图同步').catch(() => undefined);
  check(view(loser).players[target.p.id]?.teamId === winner.team, '失败者的视图同步了签约结果');
  return true;
}

/** 推进一个回合：所有人自动经营 + 准备，直到服务器推进 */
async function playRound(seats: Seat[], label: string): Promise<{ ms: number; feeds: number }> {
  const host = seats[0];
  const st0 = host.c.roundStatus!;
  const key = `${st0.season}|${st0.round}`;
  const changed = () => seats.every((p) => p.c.roundStatus && `${p.c.roundStatus.season}|${p.c.roundStatus.round}` !== key);
  const feeds0 = host.c.feeds.length;
  const t0 = performance.now();
  let lastErr: Record<string, string> = {};
  for (let pass = 0; pass < 8 && !changed(); pass++) {
    lastErr = {};
    for (const p of seats) {
      if (changed()) break;
      if (p.c.roundStatus?.ready?.[p.team] || p.c.roundStatus?.eliminated?.[p.team]) continue;
      await autopilot(p);
      const err = await ready(p);
      if (err) lastErr[p.name] = err;
    }
    if (!changed()) await sleep(30);
  }
  if (!changed()) await until(changed, 10_000, '回合推进').catch(() => undefined);
  if (!changed()) {
    for (const p of seats) {
      const b = p.c.state ? getAdvanceBlockers(p.c.state).map((x) => x.message).join('；') : '';
      console.log(`    ${p.name} 准备=${p.c.roundStatus?.ready?.[p.team]} 阻塞：${b || '无'} ${lastErr[p.name] ?? ''}`);
    }
    throw new Error(`${label}：回合无法推进`);
  }
  checkH2HResults(seats);
  // 推进后的视图与回合状态一致
  await until(() => seats.every((p) => p.c.state?.roundIndex === p.c.roundStatus?.round && p.c.state?.season?.ti === p.c.roundStatus?.season), 5000, '视图同步')
    .catch(() => failures.push(`${label}：推进后视图与回合状态不一致`));
  return { ms: performance.now() - t0, feeds: host.c.feeds.length - feeds0 };
}

async function reconnect(server: RunningServer, seats: Seat[], idx: number): Promise<void> {
  const p = seats[idx];
  const other = seats[(idx + 1) % seats.length];
  await p.c.close();
  await until(() => other.c.roundStatus?.connected?.[p.team] === false, 5000, '离线状态').catch(() => undefined);
  check(other.c.roundStatus?.connected?.[p.team] === false, `${p.name} 断线后其他玩家看到离线`);
  const c2 = makeClient(server.wsUrl, p);
  const st = c2.waitFor('state', () => true, 20_000);
  await c2.hello();
  await st;
  await until(() => !!c2.roundStatus, 5000, '回合状态');
  replaceClient(p, c2);
  check(c2.state?.settings.playerTeamId === p.team, `${p.name} 重连后回到原座位（${p.team}）`);
  await until(() => other.c.roundStatus?.connected?.[p.team] === true, 5000, '在线状态').catch(() => undefined);
  check(other.c.roundStatus?.connected?.[p.team] === true, `${p.name} 重连后其他玩家看到在线`);
}

/** 玩家断线 → 房主托管：之后其余玩家照常推进，服务器代该玩家处理事务、打比赛并准备 */
async function startAutopilot(seats: Seat[], idx: number): Promise<void> {
  const p = seats[idx];
  const host = seats[0];
  await p.c.close();
  await until(() => host.c.roundStatus?.connected?.[p.team] === false, 5000, '离线状态').catch(() => undefined);
  const denied = await seats[1].c.request({ t: 'setAutopilot', teamId: p.team, on: true }, 'roundStatus', () => false);
  check(denied.t === 'error' && denied.message.includes('房主'), '非房主不能托管');
  const notice = host.c.waitFor('feed', (m) => m.items.some((i) => i.title.includes('托管了离线玩家')), 10_000);
  host.c.send({ t: 'setAutopilot', teamId: p.team, on: true });
  await notice;
  await until(() => host.c.roundStatus?.autopilot?.[p.team] === true, 5000, '托管状态').catch(() => undefined);
  check(host.c.roundStatus?.autopilot?.[p.team] === true, `房主托管离线玩家 ${p.name}`);
  p.offline = true;
}

async function endAutopilot(server: RunningServer, seats: Seat[], idx: number, roundsPlayed: number): Promise<void> {
  const p = seats[idx];
  const host = seats[0];
  check(roundsPlayed > 0, `托管期间回合照常推进（${roundsPlayed} 个回合）`);
  replaceClient(p, makeClient(server.wsUrl, p));
  const st = p.c.waitFor('state', () => true, 20_000);
  await p.c.hello();
  await st;
  await until(() => !!p.c.roundStatus, 5000, '回合状态');
  p.offline = false;
  await until(() => host.c.roundStatus?.connected?.[p.team] === true && !host.c.roundStatus?.autopilot?.[p.team], 5000, '解除托管').catch(() => undefined);
  check(!host.c.roundStatus?.autopilot?.[p.team], `${p.name} 重连后自动解除托管`);
  check(p.c.state?.settings.playerTeamId === p.team, `${p.name} 托管结束后回到原座位`);
}

async function scenario(mode: RoomSettings['mode']): Promise<void> {
  console.log(`\n== 场景：${mode === 'existing' ? '选择已有战队' : '各自组建战队'}（TI${TI} 起，${SEASONS} 个赛季）`);
  const dataDir = mkdtempSync(join(tmpdir(), `d2m-mp-e2e-${mode}-`));
  let server = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: VERBOSE ? (m) => console.log(`   [server] ${m}`) : () => undefined, heartbeatMs: 0 });
  const tag = Math.random().toString(36).slice(2, 8);
  const seats: Seat[] = ['阿明', '小红', '老王'].map((name, i) => {
    const sessionId = `e2e-${mode}-${i}-${tag}`;
    ALL_SESSIONS.add(sessionId);
    return { name, sessionId, c: makeClient(server.wsUrl, { name, sessionId }), team: '', registeredSeason: -1, manualPlayed: 0, calls: 0, failedCalls: 0, callMs: 0 };
  });
  const t0 = performance.now();
  try {
    const roomId = await lobby(server, mode, seats);
    let raced = false;
    let rounds = 0;
    let advanceMs = 0;
    let feedTotal = 0;
    const endSeason = TI + SEASONS;
    while (rounds < MAX_ROUNDS) {
      const st = seats[0].c.roundStatus!;
      if (st.season >= endSeason || seats[0].c.state?.gameOver) break;
      if (!raced) raced = await race(seats);
      if (rounds === 3) await reconnect(server, seats, 1);
      if (rounds === 6) await startAutopilot(seats, 2);
      if (rounds === 10) await endAutopilot(server, seats, 2, rounds - 6);
      if (rounds % 5 === 0 && rounds !== 6 && rounds !== 10) crossCheck(server, roomId, seats.filter((p) => !p.offline));
      const r = await playRound(seats.filter((p) => !p.offline), `TI${st.season} 第 ${st.round} 回合`);
      rounds++;
      advanceMs += r.ms;
      feedTotal += r.feeds;
      const now = seats[0].c.roundStatus!;
      const line = `  · TI${st.season} 第 ${st.round} 回合 → TI${now.season} 第 ${now.round} 回合（${r.ms.toFixed(0)}ms，快讯 ${r.feeds} 条）`;
      if (VERBOSE || now.season !== st.season || rounds % 10 === 0) console.log(line);
    }
    check(raced, '完成抢签测试（转会窗口内找到了抢签目标）');
    check(seats[0].c.roundStatus!.season >= endSeason || !!seats[0].c.state?.gameOver, `打完至少一个完整赛季（${rounds} 个回合）`);
    check(feedTotal > 0, `回合推进时广播了快讯（共 ${feedTotal} 条）`);
    check(seats.some((p) => p.manualPlayed > 0), '至少手动打了一场系列赛');
    if (h2hSeen.size) console.log(`  · 玩家对决共 ${h2hSeen.size} 场（双方都请求快速模拟后结算）`);
    else warn('本赛季没有出现玩家对玩家的系列赛');
    check([...h2hInfo.values()].every((h) => h.checked), '所有玩家对决都已结算');
    h2hSeen.clear();
    h2hInfo.clear();
    crossCheck(server, roomId, seats);

    // 持久化：重启服务器后全员重连并继续推进一回合
    const saved = server.flushSync();
    const file = join(dataDir, 'rooms', `${roomId}.json`);
    check(saved >= 1 && existsSync(file), `房间已写入 ${file}`);
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as { room: { status: string }; state: GameState | null };
    check(persisted.room.status !== 'lobby' && !!persisted.state?.multiplayer, '存档包含对局状态');
    const before = seats[0].c.roundStatus!;
    for (const p of seats) await p.c.close();
    await server.close();
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir, log: VERBOSE ? (m) => console.log(`   [server] ${m}`) : () => undefined, heartbeatMs: 0 });
    check(server.rooms.roomIds().includes(roomId), '重启后载入房间');
    for (const p of seats) {
      replaceClient(p, makeClient(server.wsUrl, p));
      const st = p.c.waitFor('state', () => true, 20_000);
      await p.c.hello();
      await st;
    }
    await until(() => seats.every((p) => !!p.c.roundStatus), 5000, '重连回合状态');
    check(seats.every((p) => p.c.state?.settings.playerTeamId === p.team), '重启后全员回到原座位');
    const after = seats[0].c.roundStatus!;
    check(after.season === before.season && after.round === before.round, `重启后回合一致（TI${after.season} 第 ${after.round} 回合）`);
    if (!seats[0].c.state?.gameOver) {
      const r = await playRound(seats, '重启后');
      console.log(`  · 重启后继续推进一回合（${r.ms.toFixed(0)}ms）`);
    }

    // 汇总
    const violations = [...retiredViolations.splice(0), ...seats.flatMap((p) => p.c.violations.map((v) => `${p.name}：${v}`))];
    for (const v of violations.slice(0, 10)) failures.push(v);
    check(violations.length === 0, `所有座位视图均未泄露其他玩家的私有数据（${seats.reduce((a, p) => a + p.c.stateCount, 0)} 份视图）`);
    const unexpected = seats.flatMap((p) => p.c.errors.filter((e) => /服务器处理消息出错|生成游戏视图失败|推进回合失败/.test(e)));
    check(unexpected.length === 0, `没有服务器内部错误${unexpected.length ? `：${unexpected[0]}` : ''}`);
    const calls = seats.reduce((a, p) => a + p.calls, 0);
    const callMs = seats.reduce((a, p) => a + p.callMs, 0);
    const maxKb = Math.max(...seats.map((p) => p.c.maxStateBytes)) / 1024;
    console.log(
      `  · ${rounds} 个回合 · 平均每回合 ${(advanceMs / Math.max(1, rounds)).toFixed(0)}ms · RPC ${calls} 次（失败 ${seats.reduce((a, p) => a + p.failedCalls, 0)}，平均 ${(callMs / Math.max(1, calls)).toFixed(1)}ms）`
        + ` · 视图最大 ${maxKb.toFixed(0)}KB · 用时 ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    for (const p of seats) await p.c.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`  · 数据目录保留在 ${dataDir}`);
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  for (const mode of MODES) {
    try {
      await scenario(mode);
    } catch (err) {
      failures.push(`[${mode}] ${(err as Error).stack ?? String(err)}`);
      console.log(`  ✗ 场景中断：${(err as Error).message}`);
    }
  }
  console.log(`\n== 结果：${checks} 项检查，失败 ${failures.length}，警告 ${warnings.length} · ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
