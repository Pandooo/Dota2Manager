// 挂牌的加盟门槛（v0.3.1，均为【用户指定】）：
// - 随队场数（2026-10-15「增加签自由选手直接卖的难度，如果随队战绩10场以内，不需要上场，则无法挂牌」；用户确认按系列赛计、满 10 场可挂牌）：
//   选手加盟当前战队后，该战队完成的系列赛（任何赛事，含平局 / 弃权；不要求本人上场）不满 CONFIG.squadOps.listingMinTeamMatches 场；
// - 入队转会回合（2026-10-15「再加入队满 6 个转会回合」）：加盟后经过的转会回合（listingClock 之差，与交易抵价「刚签下」/ 抽卡转售冷却同一时钟）
//   不满 CONFIG.squadOps.listingMinTransferRounds 个。
// 两个条件都满足才能挂牌（单个 / 批量），AI 才会主动求购（普通随机求购、休赛期求购、使命求购、挖角两条路径）；任何途径加盟都从 0 开始计；
// 开局阵容、旧存档中已在队的选手与损坏的记录不受限；抽卡新秀的转售冷却另外叠加；交易抵价的「刚签下的自由选手」与「本队抽卡得到的新秀」口径同时看加盟门槛。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Player, Tournament, TournamentFormatPreset } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { addTeam, makePlayer, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { seededRng } from '../src/engine/rng';
import {
  listingMatchLockLeft, listingMinTeamMatches, resaleLockText, resaleLocked, teamMatchesSinceJoin, teamSeriesCount,
  listingRoundsPerSeason, gachaResaleLockLeft, listingClock, listingClockAt, listingMinTransferRounds, transferRoundsSinceJoin,
  listingRoundLockLeft, listingJoinLock, listingJoinLocked, listingJoinLockText, listingJoinLockTitle, listingJoinLockBrief,
  gachaListingRuleText, gachaResaleLockBrief, gachaResaleLockText,
} from '../src/engine/listingRules';
import { listPlayerForTransfer, listPlayersForTransfer, activeListing } from '../src/engine/squadOps';
import {
  bidForPlayer, departToFreeAgency, executeTransfer, freeAgents, generateAiOffers, refreshFreeAgents, releasePlayer,
  signFreeAgent, signingFee,
} from '../src/engine/market';
import { marketValue } from '../src/engine/player';
import { expectedSalary } from '../src/engine/salary';
import { tradeForPlayer, tradeHoldRoundsLabel, tradeValuation } from '../src/engine/trade';
import { addPlayerToTeam, lineupPlayers, teamPlayers } from '../src/engine/team';
import { initTournamentStages, readySeries, recordSeriesResult, simulateTournamentToEnd } from '../src/engine/tournament';
import { forfeitResult } from '../src/engine/match';
import { gachaPull, startGachaSeason, releaseRealRookieCards } from '../src/engine/gacha';
import { processLoyaltyDepartures, resolveDecision } from '../src/engine/events';
import { offseasonShuffle } from '../src/engine/shuffle';
import { advance, createNewGame } from '../src/engine/game';
import { exportSave, importSave } from '../src/engine/save';
import * as M from '../src/engine/multi';
import { RPC_WHITELIST } from '../src/shared/protocol';

beforeAll(() => {
  registerNodeRosterLoader();
});

const MIN = CONFIG.squadOps.listingMinTeamMatches;
const RMIN = CONFIG.squadOps.listingMinTransferRounds;

/** 一名不在任何战队的自由选手（注册到 state.players） */
function fa(s: GameState, over: Partial<Player> = {}): Player {
  const p = makePlayer({ position: 'C', power: 72, mmr: 8500, birthYear: 2000, loyalty: 70, ...over });
  s.players[p.id] = p;
  return p;
}

/** 谈判骰子按回合固定：换回合重试直到成功 */
function retry(s: GameState, fn: () => OpResult, limit = 40): OpResult {
  let r = fn();
  for (let i = 1; !r.ok && i < limit; i++) {
    s.roundIndex = i;
    r = fn();
  }
  return r;
}

/**
 * 签下自由选手：谈判骰子按回合固定，换回合重试；成功后回到原回合，并把加盟时钟（与「刚签下」时钟）按原回合重记——等同于在原回合签下，
 * 避免重试时跳到的回合让之后的回合序号倒退（起点晚于当前时钟会被当作损坏记录）。
 */
function sign(s: GameState, p: Player): void {
  const r0 = s.roundIndex;
  const r = retry(s, () => signFreeAgent(s, p.id));
  expect(r.ok, r.message).toBe(true);
  s.roundIndex = r0;
  p.joinedTeamClock = listingClock(s);
  if (p.freeAgentSignedClock !== undefined) p.freeAgentSignedClock = listingClock(s);
}

/** 人类战队 t0 荣誉极高（选手愿意加盟），赛季初（转会窗口开放） */
function prep(teams = 6): GameState {
  const s = makeTestState(teams);
  s.teams.t0.honor = 5000;
  for (let i = 1; i < teams; i++) s.teams[`t${i}`].honor = 2000;
  return s;
}

/** 常规赛第 round 回合（转会窗口开放） */
function regularRound(s: GameState, round = 2): void {
  s.phase = 'regular';
  s.roundIndex = round;
}

/** 让战队完成 n 场系列赛（只动计数，等同 recordSeriesResult 的计数部分） */
function playSeries(s: GameState, teamId: string, n: number): void {
  s.teams[teamId].seriesCount = teamSeriesCount(s.teams[teamId]) + n;
}

/** 常规赛内走 n 个转会回合（回合序号 +n，等同 n 个常规赛回合结束；只在常规赛内使用） */
function passRounds(s: GameState, n: number): void {
  expect(s.phase).toBe('regular');
  expect(s.roundIndex).toBeGreaterThanOrEqual(1);
  s.roundIndex += n;
  expect(s.roundIndex).toBeLessThanOrEqual(listingRoundsPerSeason());
}

/** 挂牌被拒的说明（两个条件都有记录时） */
function lockMsg(handle: string, matches: number, rounds: number): string {
  const miss = [matches < MIN ? `${MIN - matches} 场` : '', rounds < RMIN ? `${RMIN - rounds} 个转会回合` : ''].filter(Boolean).join('、');
  return `${handle} 加盟后随队 ${matches} 场、入队 ${rounds} 个转会回合，需随队满 ${MIN} 场且入队满 ${RMIN} 个转会回合才能挂牌（还差 ${miss}）`;
}

/** 仍在转售冷却中的本队抽卡新秀：加盟门槛未满足时，入队转会回合一项按冷却（CONFIG.gacha.resaleHoldRounds）报 */
function gachaLockMsg(handle: string, matches: number, rounds: number): string {
  const H = CONFIG.gacha.resaleHoldRounds;
  const miss = [matches < MIN ? `${MIN - matches} 场` : '', rounds < H ? `${H - rounds} 个转会回合` : ''].filter(Boolean).join('、');
  return `${handle} 加盟后随队 ${matches} 场、入队 ${rounds} 个转会回合，需随队满 ${MIN} 场且入队满 ${H} 个转会回合（本队抽卡得到的新秀）才能挂牌（还差 ${miss}）`;
}

function makeTournament(s: GameState, id: string, format: TournamentFormatPreset, teamIds: string[]): Tournament {
  const t = {
    id, seriesId: `${id}-series`, name: `测试赛 ${id}`, tier: 'major', season: s.season.ti, roundIndex: 1,
    startDate: '2018-10-01', city: '测试城', hostRegion: 'EU', online: false, prizePool: 1_000_000,
    appearanceFee: 0, format, teamIds: teamIds.slice(), invitedTeamIds: [], qualifierTeamIds: [],
    stages: [], series: {}, status: 'scheduled', placements: [], playerStatus: 'open', minHonor: 0,
  } as unknown as Tournament;
  s.tournaments[id] = t;
  return t;
}

const seriesOf = (t: Tournament, teamId: string) =>
  Object.values(t.series).filter((x) => !!x.result && (x.teamA === teamId || x.teamB === teamId));

// ---------------------------------------------------------------------------
describe('加盟门槛 · 配置', () => {
  it('随队 10 场、入队 6 个转会回合（均为【用户指定】）；非法值 / 0 = 不限制', () => {
    expect(MIN).toBe(10);
    expect(RMIN).toBe(6);
    expect(listingMinTeamMatches()).toBe(10);
    expect(listingMinTransferRounds()).toBe(6);
    withConfig('squadOps', { listingMinTeamMatches: 0 }, () => expect(listingMinTeamMatches()).toBe(0));
    withConfig('squadOps', { listingMinTeamMatches: Number.NaN }, () => expect(listingMinTeamMatches()).toBe(0));
    withConfig('squadOps', { listingMinTransferRounds: 0 }, () => expect(listingMinTransferRounds()).toBe(0));
    withConfig('squadOps', { listingMinTransferRounds: Number.NaN }, () => expect(listingMinTransferRounds()).toBe(0));
    withConfig('squadOps', { listingMinTransferRounds: -3 }, () => expect(listingMinTransferRounds()).toBe(0));
  });
});

// ---------------------------------------------------------------------------
describe('随队场数 · 计数', () => {
  it('每场系列赛双方各 +1（小组赛 Bo2 平局、淘汰赛、弃权都算）；全体队员同步计数，替补 / 从未上场也算', () => {
    const s = makeTestState(8);
    const me = s.teams.t0;
    me.seriesCount = 5;
    const bench = fa(s, { id: 'bench-newbie', position: 'C', power: 40, mmr: 3000 });
    addPlayerToTeam(s, bench.id, 't0'); // 一号位已有首发 → 替补
    expect(bench.joinedTeamSeries).toBe(5);
    expect(bench.joinedTeamClock).toBe(listingClock(s));
    expect(teamMatchesSinceJoin(s, bench)).toBe(0);
    expect(transferRoundsSinceJoin(s, bench)).toBe(0);
    expect(Object.values(me.lineup)).not.toContain(bench.id);

    const t = makeTournament(s, 'gd', 'groups_de', Object.keys(s.teams));
    initTournamentStages(s, t.id);
    expect(t.stages[0].type).toBe('groups');
    // 一场弃权、一场小组赛平局
    const [first, second] = readySeries(s, t.id);
    recordSeriesResult(s, t.id, first.id, forfeitResult(first, 'A'));
    recordSeriesResult(s, t.id, second.id, { winnerId: second.teamA!, loserId: second.teamB!, scoreA: 1, scoreB: 1, games: [] });
    expect(t.series[second.id].result?.scoreA).toBe(t.series[second.id].result?.scoreB);
    simulateTournamentToEnd(s, t.id);
    for (const id of Object.keys(s.teams)) {
      expect(teamSeriesCount(s.teams[id]), id).toBe((id === 't0' ? 5 : 0) + seriesOf(t, id).length);
    }
    expect(teamMatchesSinceJoin(s, bench)).toBe(seriesOf(t, 't0').length);
    expect(seriesOf(t, 't0').length).toBeGreaterThan(0);
    expect(bench.stats.matches).toBe(0); // 本人从未上场
    // 打比赛不走转会回合时钟（回合没有结束）
    expect(transferRoundsSinceJoin(s, bench)).toBe(0);
    // 开局阵容（夹具直接放入、没有记录）：不受限
    expect(teamMatchesSinceJoin(s, s.players['t0-C'])).toBeNull();
    expect(transferRoundsSinceJoin(s, s.players['t0-C'])).toBeNull();
    expect(listingMatchLockLeft(s, s.players['t0-C'])).toBe(0);
    expect(listingRoundLockLeft(s, s.players['t0-C'])).toBe(0);
    // 同一场系列赛不会重复计数
    const before = teamSeriesCount(me);
    const done = seriesOf(t, 't0')[0];
    recordSeriesResult(s, t.id, done.id, forfeitResult(done, 'B'));
    expect(teamSeriesCount(me)).toBe(before);
  });

  it('真实对局：随队场数 = 本队已出结果的系列赛、入队转会回合 = 已结束的常规赛回合；两个条件都满足的那一回合才能挂牌（逐回合核对文案）', async () => {
    const s = await createNewGame({ startTi: 9, seasons: 2, difficulty: 'normal', managerName: '计数', teamId: 'og', seed: 5 });
    const me = s.settings.playerTeamId;
    // 开局阵容没有记录
    for (const p of teamPlayers(s, me)) {
      expect(p.joinedTeamSeries).toBeUndefined();
      expect(p.joinedTeamClock).toBeUndefined();
    }
    s.teams[me].gold += 5_000_000;
    s.teams[me].honor = 3000;
    const cand = freeAgents(s).filter((p) => p.position === 'HS').sort((a, b) => signingFee(s, a) - signingFee(s, b));
    let signed: Player | null = null;
    for (const p of cand) if (signFreeAgent(s, p.id).ok) { signed = p; break; }
    expect(signed).toBeTruthy();
    const p = signed!;
    expect(s.phase).toBe('preseason');
    expect(p.joinedTeamSeries).toBe(0);
    expect(p.joinedTeamClock).toBe(listingClock(s));
    expect(p.freeAgentSignedClock).toBe(p.joinedTeamClock);
    expect(lineupPlayers(s, me).some((x) => x.player?.id === p.id)).toBe(false);
    const counted = () => s.seasonTournamentIds.map((id) => s.tournaments[id]).filter(Boolean)
      .reduce((n, t) => n + seriesOf(t, me).length, 0);
    let regularDone = 0;
    let sawBothLocked = false;
    let sawRoundsOnly = false;
    let sawOpen = false;
    for (let i = 0; i < 18 && s.season.ti === 9; i++) {
      const wasRegular = s.phase === 'regular';
      const r = advance(s, { auto: true });
      expect(r.ok, r.message).toBe(true);
      if (wasRegular) regularDone++;
      if (s.season.ti !== 9) break;
      expect(teamSeriesCount(s.teams[me])).toBe(counted());
      if (p.teamId !== me) break;
      expect(teamMatchesSinceJoin(s, p)).toBe(counted());
      expect(transferRoundsSinceJoin(s, p)).toBe(regularDone);
      if (s.phase !== 'regular') continue;
      const res = listPlayerForTransfer(s, p.id);
      const m = counted();
      if (m < MIN || regularDone < RMIN) {
        expect(res).toEqual({ ok: false, message: lockMsg(p.handle, m, regularDone) });
        expect(resaleLocked(s, p)).toBe(true);
        if (m < MIN) sawBothLocked = true;
        else sawRoundsOnly = true;
      } else {
        sawOpen = true;
        expect(res.ok, res.message).toBe(true);
        expect(regularDone).toBe(RMIN); // 场数早已打满：正好在入队满 6 个转会回合的那一回合解除
        break;
      }
    }
    expect(sawBothLocked).toBe(true);
    expect(sawRoundsOnly).toBe(true); // OG 场次多：随队 10 场先满足，仍要等满 6 个转会回合
    expect(sawOpen).toBe(true);
    // AI 战队的选手不记起点（只有人类战队用得到，省存档）
    const aiMarked = Object.values(s.players).filter(
      (x) => x.teamId && !s.teams[x.teamId]?.isPlayer && (x.joinedTeamSeries !== undefined || x.joinedTeamClock !== undefined),
    );
    expect(aiMarked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('入队转会回合 · 与交易抵价「刚签下」/ 抽卡转售冷却同一时钟', () => {
  it('跨 TI 与赛季：每个常规赛回合结束时 +1，TI 预选 / 正赛与赛季初不计；与 freeAgentSignedClock、抽卡转售冷却的读数一致', async () => {
    const s = await createNewGame({ startTi: 9, seasons: 2, difficulty: 'normal', managerName: '时钟', teamId: 'og', seed: 7 });
    const me = s.settings.playerTeamId;
    s.teams[me].gold += 20_000_000;
    s.teams[me].honor = 3000;
    const R = listingRoundsPerSeason();
    for (let i = 0; i < 40 && !(s.phase === 'regular' && s.roundIndex >= R - 3); i++) expect(advance(s, { auto: true }).ok).toBe(true);
    expect(s.phase).toBe('regular');
    const cand = freeAgents(s).sort((a, b) => signingFee(s, a) - signingFee(s, b));
    let p: Player | null = null;
    for (const c of cand) if (signFreeAgent(s, c.id).ok) { p = c; break; }
    expect(p).toBeTruthy();
    const pulled = gachaPull(s, 1) as OpResult & { results?: { playerId: string }[] };
    expect(pulled.ok, pulled.message).toBe(true);
    const rk = s.players[pulled.results![0].playerId];
    expect(rk.joinedTeamClock).toBe(listingClock(s));
    expect(listingClockAt(rk.gacha!.ti, rk.gacha!.round)).toBe(rk.joinedTeamClock);
    const hold = CONFIG.gacha.resaleHoldRounds;
    let expected = 0;
    const lockedPhases = new Set<string>();
    for (let i = 0; i < 30 && expected < RMIN + 1; i++) {
      const before = s.phase;
      expect(advance(s, { auto: true }).ok).toBe(true);
      if (before === 'regular') expected++;
      else lockedPhases.add(before);
      expect(p!.teamId).toBe(me);
      expect(transferRoundsSinceJoin(s, p!)).toBe(expected);
      expect(listingClock(s) - p!.freeAgentSignedClock!).toBe(expected);
      expect(listingRoundLockLeft(s, p!)).toBe(Math.max(0, RMIN - expected));
      if (rk.teamId === me) {
        expect(transferRoundsSinceJoin(s, rk)).toBe(expected);
        expect(gachaResaleLockLeft(s, rk)).toBe(hold - expected);
      }
    }
    // 中间经过了 TI 预选 / 正赛（转会锁定）与新赛季的赛季初，这些回合都没有计数
    expect(lockedPhases.has('ti')).toBe(true);
    expect(lockedPhases.has('preseason')).toBe(true);
    expect(s.season.ti).toBe(10);
    expect(expected).toBe(RMIN + 1);
  });
});

// ---------------------------------------------------------------------------
describe('加盟门槛 · 任何途径加盟都从 0 开始', () => {
  it('签自由选手 / 求购 / 交易（目标与抵价）/ 解约后重签 / 离队清除；加盟 AI 战队不记', () => {
    const s = prep();
    playSeries(s, 't0', 37);
    // 签自由选手
    const a = fa(s);
    expect(retry(s, () => signFreeAgent(s, a.id)).ok).toBe(true);
    expect(a.joinedTeamSeries).toBe(37);
    expect(a.joinedTeamClock).toBe(listingClock(s));
    expect(teamMatchesSinceJoin(s, a)).toBe(0);
    expect(transferRoundsSinceJoin(s, a)).toBe(0);
    playSeries(s, 't0', 4);
    expect(teamMatchesSinceJoin(s, a)).toBe(4);
    // 求购 AI 战队的选手
    const target = s.players['t1-M'];
    target.loyalty = 5;
    expect(retry(s, () => bidForPlayer(s, target.id, marketValue(s, target) * 3)).ok).toBe(true);
    expect(target.teamId).toBe('t0');
    expect(target.joinedTeamSeries).toBe(41);
    expect(target.joinedTeamClock).toBe(listingClock(s));
    expect(teamMatchesSinceJoin(s, target)).toBe(0);
    // 交易：目标重新计数；送走的抵价选手（开局阵容）去了 AI 战队，不记
    const t2 = s.players['t2-O'];
    t2.loyalty = 5;
    s.teams.t0.gold = 50_000_000;
    const chip = s.players['t0-SS'];
    const tr = retry(s, () => tradeForPlayer(s, t2.id, marketValue(s, t2) * 3, [chip.id]));
    expect(tr.ok, tr.message).toBe(true);
    expect(t2.joinedTeamSeries).toBe(41);
    expect(t2.joinedTeamClock).toBe(listingClock(s));
    expect(chip.teamId).toBe('t2');
    expect(chip.joinedTeamSeries).toBeUndefined();
    expect(chip.joinedTeamClock).toBeUndefined();
    // 解约 → 自由选手（记录清除）→ 重新签下，从当时的场数与时钟重新计
    playSeries(s, 't0', 20);
    regularRound(s, 2);
    a.joinedTeamClock = listingClock(s) - RMIN; // 已入队满 6 个转会回合
    expect(listingMatchLockLeft(s, a)).toBe(0);
    expect(listingRoundLockLeft(s, a)).toBe(0);
    expect(releasePlayer(s, a.id).ok).toBe(true);
    expect(a.teamId).toBeNull();
    expect(a.joinedTeamSeries).toBeUndefined();
    expect(a.joinedTeamClock).toBeUndefined();
    sign(s, a);
    expect(a.joinedTeamSeries).toBe(61);
    expect(listingMatchLockLeft(s, a)).toBe(MIN);
    expect(listingRoundLockLeft(s, a)).toBe(RMIN);
    // 转出到 AI 战队：记录清除，AI 战队不记
    executeTransfer(s, a.id, 't3', 0);
    expect(a.teamId).toBe('t3');
    expect(a.joinedTeamSeries).toBeUndefined();
    expect(a.joinedTeamClock).toBeUndefined();
    // 再从 AI 战队转回人类战队：重新计
    passRounds(s, 2);
    executeTransfer(s, a.id, 't0', 0);
    expect(a.joinedTeamSeries).toBe(61);
    expect(a.joinedTeamClock).toBe(listingClock(s));
    // 已在本队时再次 addPlayerToTeam 不重置
    playSeries(s, 't0', 3);
    passRounds(s, 2);
    addPlayerToTeam(s, a.id, 't0');
    expect(teamMatchesSinceJoin(s, a)).toBe(3);
    expect(transferRoundsSinceJoin(s, a)).toBe(2);
    // 离队成为自由选手：清除
    departToFreeAgency(s, a.id);
    expect(a.joinedTeamSeries).toBeUndefined();
    expect(a.joinedTeamClock).toBeUndefined();
    expect(teamMatchesSinceJoin(s, a)).toBeNull();
    expect(transferRoundsSinceJoin(s, a)).toBeNull();
  });

  it('抽卡新秀与从自由市场签下的真实新秀：同样从 0 开始；抽卡页的挂牌条件说明', () => {
    const s = makeTestState(6);
    startGachaSeason(s);
    s.teams.t0.gold = 100_000_000;
    playSeries(s, 't0', 12);
    const r = gachaPull(s, 1) as OpResult & { results?: { playerId: string }[] };
    expect(r.ok, r.message).toBe(true);
    const rk = s.players[r.results![0].playerId];
    expect(rk.joinedTeamSeries).toBe(12);
    expect(rk.joinedTeamClock).toBe(listingClock(s));
    expect(teamMatchesSinceJoin(s, rk)).toBe(0);
    expect(transferRoundsSinceJoin(s, rk)).toBe(0);

    // 真实新秀（TI11，OG 为人类战队）：v0.4.3 起未被抽走的真实新秀进入自由市场（不再发「签下」事件）；从自由市场签下时同样从 0 开始
    const g = makeTestState(4);
    g.season.ti = 11;
    g.season.year = 2022;
    g.settings.startTi = 11;
    g.teams.t0.isPlayer = false;
    const og = addTeam(g, 'og', { isPlayer: true });
    og.honor = 3000;
    og.gold = 100_000_000;
    g.settings.playerTeamId = 'og';
    addTeam(g, 'team-secret');
    for (const id of ['bzm', 'misha', 'yuragi', 'crystallis']) g.futureRookies[id] = 11;
    startGachaSeason(g);
    g.phase = 'regular';
    g.roundIndex = 1;
    og.seriesCount = 8;
    releaseRealRookieCards(g);
    expect(g.pendingDecisions.some((x) => x.kind === 'rookie_home')).toBe(false);
    expect(g.players.bzm.teamId).toBeNull();
    sign(g, g.players.bzm);
    expect(g.players.bzm.teamId).toBe('og');
    expect(g.players.bzm.joinedTeamSeries).toBe(8);
    expect(g.players.bzm.joinedTeamClock).toBe(listingClock(g));
    // 自由选手：不记
    expect(g.players.crystallis.teamId).toBeNull();
    expect(g.players.crystallis.joinedTeamSeries).toBeUndefined();
    expect(g.players.crystallis.joinedTeamClock).toBeUndefined();
    // 抽卡页规则说明（挂牌条件）：抽卡转售冷却 18 个转会回合长于一般新加盟选手的 6 个
    expect(gachaListingRuleText()).toBe(`入队满 ${CONFIG.gacha.resaleHoldRounds} 个转会回合（约一个赛季；其他新加盟选手为 ${RMIN} 个）且随队满 ${MIN} 场比赛`);
    // 规则说明随配置变化：入队门槛长于抽卡冷却时按入队门槛说，不再写「其他新加盟选手」
    withConfig('squadOps', { listingMinTransferRounds: 24 }, () =>
      expect(gachaListingRuleText()).toBe(`入队满 24 个转会回合且随队满 ${MIN} 场比赛`));
    withConfig('squadOps', { listingMinTransferRounds: 0, listingMinTeamMatches: 0 }, () =>
      expect(gachaListingRuleText()).toBe(`入队满 ${CONFIG.gacha.resaleHoldRounds} 个转会回合（约一个赛季）`));
  });
});

// ---------------------------------------------------------------------------
describe('挂牌门槛：两个条件都满足才能挂牌', () => {
  it('先满 10 场、后满 6 个转会回合：每一步的失败说明与按钮提示，满足的那一刻才能挂牌；不要求本人上场', () => {
    const s = prep();
    regularRound(s, 3);
    const p = fa(s);
    sign(s, p);
    const r0 = listPlayerForTransfer(s, p.id);
    expect(r0).toEqual({
      ok: false,
      message: `${p.handle} 加盟后随队 0 场、入队 0 个转会回合，需随队满 10 场且入队满 6 个转会回合才能挂牌（还差 10 场、6 个转会回合）`,
    });
    expect(listingJoinLockTitle(s, p)).toBe('随队满 10 场且入队满 6 个转会回合后可挂牌（已随队 0 场、入队 0 个转会回合）');
    expect(listingJoinLockBrief(s, p)).toBe('随队 0 / 10 场、入队 0 / 6 个转会回合');
    expect(resaleLocked(s, p)).toBe(true);
    expect(listingJoinLock(s, p)).toEqual({ locked: true, matches: 0, minMatches: 10, matchLeft: 10, rounds: 0, minRounds: 6, roundLeft: 6, gachaHold: false });
    // 打满 10 场：仍差转会回合
    playSeries(s, 't0', MIN);
    expect(listingMatchLockLeft(s, p)).toBe(0);
    expect(listingRoundLockLeft(s, p)).toBe(RMIN);
    const r10 = listPlayerForTransfer(s, p.id, marketValue(s, p));
    expect(r10).toEqual({
      ok: false,
      message: `${p.handle} 加盟后随队 10 场、入队 0 个转会回合，需随队满 10 场且入队满 6 个转会回合才能挂牌（还差 6 个转会回合）`,
    });
    expect(resaleLocked(s, p)).toBe(true);
    passRounds(s, RMIN - 1);
    expect(listPlayerForTransfer(s, p.id).message).toBe(lockMsg(p.handle, 10, 5));
    expect(listingJoinLockTitle(s, p)).toBe('随队满 10 场且入队满 6 个转会回合后可挂牌（已随队 10 场、入队 5 个转会回合）');
    expect(activeListing(s, p)).toBeNull();
    passRounds(s, 1);
    expect(listingJoinLocked(s, p)).toBe(false);
    expect(listingJoinLockText(s, p)).toBeNull();
    expect(listingJoinLockTitle(s, p)).toBeNull();
    expect(listingJoinLockBrief(s, p)).toBeNull();
    expect(resaleLockText(s, p)).toBeNull();
    expect(resaleLocked(s, p)).toBe(false);
    const ok = listPlayerForTransfer(s, p.id);
    expect(ok.ok, ok.message).toBe(true);
    expect(activeListing(s, p)).toBeTruthy();
    expect(p.stats.matches).toBe(0);
  });

  it('先满 6 个转会回合、后满 10 场：转会回合满了仍要等场数（打得少的战队）', () => {
    const s = prep();
    regularRound(s, 2);
    const p = fa(s);
    sign(s, p);
    passRounds(s, RMIN);
    expect(listingRoundLockLeft(s, p)).toBe(0);
    expect(listingMatchLockLeft(s, p)).toBe(MIN);
    expect(listPlayerForTransfer(s, p.id).message).toBe(
      `${p.handle} 加盟后随队 0 场、入队 6 个转会回合，需随队满 10 场且入队满 6 个转会回合才能挂牌（还差 10 场）`,
    );
    passRounds(s, 4); // 回合再多也不行
    playSeries(s, 't0', MIN - 1);
    expect(listPlayerForTransfer(s, p.id).message).toBe(lockMsg(p.handle, 9, 10));
    expect(listingJoinLockBrief(s, p)).toBe('随队 9 / 10 场、入队 10 / 6 个转会回合');
    expect(resaleLocked(s, p)).toBe(true);
    playSeries(s, 't0', 1);
    expect(resaleLocked(s, p)).toBe(false);
    expect(listPlayerForTransfer(s, p.id).ok).toBe(true);
  });

  it('开局阵容、旧存档（无记录）与损坏的记录不受限（两个条件各自判断）；解约照常（付补偿）', () => {
    const s = prep();
    regularRound(s, 2);
    expect(listPlayerForTransfer(s, 't0-C').ok).toBe(true);
    const p = s.players['t0-M'];
    p.joinedTeamSeries = Number.NaN;
    p.joinedTeamClock = Number.NaN;
    expect(teamMatchesSinceJoin(s, p)).toBeNull();
    expect(transferRoundsSinceJoin(s, p)).toBeNull();
    expect(listPlayerForTransfer(s, p.id).ok).toBe(true);
    // 起点大于战队当前累计场数 / 晚于当前时钟（改动 / 拼接过的存档）：同样按损坏处理，不受限（不会被锁到追上为止）
    const q = s.players['t0-O'];
    playSeries(s, 't0', 3);
    q.joinedTeamSeries = 500;
    expect(teamMatchesSinceJoin(s, q)).toBeNull();
    expect(listingMatchLockLeft(s, q)).toBe(0);
    expect(resaleLocked(s, q)).toBe(false);
    q.joinedTeamSeries = teamSeriesCount(s.teams.t0); // 起点 = 当前场数：正常记录，随队 0 场
    expect(teamMatchesSinceJoin(s, q)).toBe(0);
    expect(listingMatchLockLeft(s, q)).toBe(MIN);
    q.joinedTeamSeries = 500;
    q.joinedTeamClock = listingClock(s) + 3;
    expect(transferRoundsSinceJoin(s, q)).toBeNull();
    expect(listingRoundLockLeft(s, q)).toBe(0);
    q.joinedTeamClock = listingClock(s); // 起点 = 当前时钟：正常记录，入队 0 个转会回合
    expect(transferRoundsSinceJoin(s, q)).toBe(0);
    expect(listingRoundLockLeft(s, q)).toBe(RMIN);
    // 只有一个条件有记录：只说这一个条件
    expect(listPlayerForTransfer(s, q.id).message).toBe(`${q.handle} 加盟后入队 0 个转会回合，需入队满 6 个转会回合才能挂牌（还差 6 个转会回合）`);
    q.joinedTeamClock = listingClock(s) + 3;
    expect(listPlayerForTransfer(s, q.id).ok).toBe(true);
    // 刚签下也能解约，补偿规则不变
    const n = fa(s);
    sign(s, n);
    expect(listingMatchLockLeft(s, n)).toBe(MIN);
    expect(listingRoundLockLeft(s, n)).toBe(RMIN);
    const gold = s.teams.t0.gold;
    const rel = releasePlayer(s, n.id);
    expect(rel.ok, rel.message).toBe(true);
    expect(n.teamId).toBeNull();
    expect(s.teams.t0.gold).toBeLessThan(gold); // 解约补偿
  });

  it('批量挂牌：逐人跳过并写明原因（加盟门槛 / 已在挂牌 / 抽卡冷却），其余照常挂牌；全部不能挂牌时失败', () => {
    const s = prep();
    startGachaSeason(s);
    s.teams.t0.gold = 100_000_000;
    regularRound(s, 2);
    const rk = s.players[(gachaPull(s, 1) as OpResult & { results?: { playerId: string }[] }).results![0].playerId];
    const n = fa(s);
    sign(s, n);
    expect(listPlayerForTransfer(s, 't0-O').ok).toBe(true);
    playSeries(s, 't0', 4);
    passRounds(s, 1);
    const r = listPlayersForTransfer(s, ['t0-C', n.id, 't0-O', rk.id]);
    expect(r.ok).toBe(true);
    expect(activeListing(s, s.players['t0-C'])).toBeTruthy();
    expect(activeListing(s, n)).toBeNull();
    expect(r.message).toContain('已挂牌 1 人');
    expect(r.message).toContain('跳过 3 人');
    expect(r.message).toContain(lockMsg(n.handle, 4, 1));
    expect(r.message).toContain(gachaLockMsg(rk.handle, 4, 1));
    expect(r.message).toContain(`${s.players['t0-O'].handle} 已在挂牌名单中`);
    // 满 10 场、仍不满 6 个转会回合：两人都跳过
    playSeries(s, 't0', 6);
    const r2 = listPlayersForTransfer(s, [rk.id, n.id]);
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('挂牌失败（2 人）');
    expect(r2.message).toContain(lockMsg(n.handle, 10, 1));
    expect(r2.message).toContain(gachaLockMsg(rk.handle, 10, 1));
    // 满 6 个转会回合：自由选手可以挂牌，抽卡新秀仍受转售冷却
    passRounds(s, RMIN - 1);
    const r3 = listPlayersForTransfer(s, [rk.id, n.id]);
    expect(r3.ok).toBe(true);
    expect(activeListing(s, n)).toBeTruthy();
    expect(activeListing(s, rk)).toBeNull();
    expect(r3.message).toContain('跳过 1 人');
    expect(r3.message).toContain(`${rk.handle} 是本队抽卡得到的新秀`);
    // 全部不能挂牌
    const m = fa(s, { position: 'M' });
    sign(s, m);
    const r4 = listPlayersForTransfer(s, [m.id, rk.id]);
    expect(r4.ok).toBe(false);
    expect(r4.message).toContain('挂牌失败（2 人）');
    expect(r4.message).toContain(lockMsg(m.handle, 0, 0));
  });

  it('抽卡新秀：加盟门槛与转售冷却叠加——任一未满足都不能挂牌，加盟门槛的说明优先、回合数按冷却报（门槛满足前后同一读数）', () => {
    const H = CONFIG.gacha.resaleHoldRounds;
    const s = makeTestState(6);
    startGachaSeason(s);
    s.teams.t0.gold = 100_000_000;
    regularRound(s, 2);
    const rk = s.players[(gachaPull(s, 1) as OpResult & { results?: { playerId: string }[] }).results![0].playerId];
    // 加盟门槛未满足：入队转会回合按冷却报（18 个，不是一般新加盟选手的 6 个）
    expect(resaleLockText(s, rk)).toBe(gachaLockMsg(rk.handle, 0, 0));
    playSeries(s, 't0', MIN);
    expect(resaleLockText(s, rk)).toBe(gachaLockMsg(rk.handle, MIN, 0));
    passRounds(s, RMIN - 1);
    expect(listingJoinLocked(s, rk)).toBe(true);
    expect(listingRoundLockLeft(s, rk)).toBe(1);
    expect(listPlayerForTransfer(s, rk.id).message).toBe(gachaLockMsg(rk.handle, MIN, RMIN - 1));
    expect(listingJoinLock(s, rk)).toEqual({
      locked: true, matches: MIN, minMatches: MIN, matchLeft: 0, rounds: RMIN - 1, minRounds: H, roundLeft: H - RMIN + 1, gachaHold: true,
    });
    expect(listingJoinLockTitle(s, rk)).toBe(`随队满 ${MIN} 场且入队满 ${H} 个转会回合（本队抽卡得到的新秀）后可挂牌（已随队 ${MIN} 场、入队 ${RMIN - 1} 个转会回合）`);
    expect(listingJoinLockBrief(s, rk)).toBe(`随队 ${MIN} / ${MIN} 场、入队 ${RMIN - 1} / ${H} 个转会回合（抽卡新秀）`);
    // 再过一个转会回合：加盟门槛满足，转售冷却的说明从同一个数继续倒数（还差 13 → 12），不会跳成别的数
    passRounds(s, 1);
    expect(listingJoinLocked(s, rk)).toBe(false);
    expect(listingJoinLock(s, rk).locked).toBe(false);
    expect(listingJoinLockBrief(s, rk)).toBeNull();
    expect(gachaResaleLockLeft(s, rk)).toBe(H - RMIN);
    expect(resaleLockText(s, rk)).toBe(gachaResaleLockText(s, rk));
    expect(resaleLockText(s, rk)).toBe(`${rk.handle} 是本队抽卡得到的新秀，入队满 ${H} 个转会回合（约一个赛季）后才能挂牌出售（还差 ${H - RMIN} 个转会回合）`);
    expect(gachaResaleLockBrief(s, rk)).toBe(`入队 ${RMIN} / ${H} 个转会回合（抽卡新秀）`);
    expect(listPlayerForTransfer(s, rk.id).message).toContain('本队抽卡得到的新秀');
    // 只差随队场数（入队转会回合无记录，如 v0.3.1 开发版存档）：回合一项仍按冷却报
    const clock = rk.joinedTeamClock;
    const series = rk.joinedTeamSeries;
    rk.joinedTeamClock = undefined;
    rk.joinedTeamSeries = teamSeriesCount(s.teams.t0) - (MIN - 2);
    expect(resaleLockText(s, rk)).toBe(gachaLockMsg(rk.handle, MIN - 2, RMIN));
    // 入队门槛长于转售冷却（配置改动）：按入队门槛报，不标抽卡新秀
    rk.joinedTeamClock = clock;
    rk.joinedTeamSeries = series;
    withConfig('squadOps', { listingMinTransferRounds: H + 6 }, () => {
      expect(listingJoinLock(s, rk)).toMatchObject({ locked: true, rounds: RMIN, minRounds: H + 6, roundLeft: H + 6 - RMIN, gachaHold: false });
      expect(listingJoinLockBrief(s, rk)).toBe(`随队 ${MIN} / ${MIN} 场、入队 ${RMIN} / ${H + 6} 个转会回合`);
    });
    // 冷却已过、场数不足（打得少的战队）
    s.season.ti += Math.ceil(CONFIG.gacha.resaleHoldRounds / listingRoundsPerSeason());
    rk.joinedTeamSeries = teamSeriesCount(s.teams.t0) - 2;
    expect(gachaResaleLockLeft(s, rk)).toBe(0);
    const rounds = transferRoundsSinceJoin(s, rk)!;
    expect(rounds).toBe(RMIN + listingRoundsPerSeason());
    expect(listPlayerForTransfer(s, rk.id).message).toBe(lockMsg(rk.handle, 2, rounds));
    playSeries(s, 't0', 8);
    expect(listPlayerForTransfer(s, rk.id).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('AI 不主动求购未满足加盟门槛的选手', () => {
  it('普通随机求购（generateAiOffers）：只剩新加盟的选手时，任一条件未满足都不产生报价；两个条件都满足后可以被求购', () => {
    const s = prep();
    regularRound(s, 2);
    const news: Player[] = [];
    for (const pos of POSITIONS) {
      const p = fa(s, { position: pos });
      sign(s, p);
      news.push(p);
    }
    // 送走开局阵容：队里只剩新加盟的选手
    for (const pos of POSITIONS) departToFreeAgency(s, `t0-${pos}`);
    expect(teamPlayers(s, 't0').every((p) => news.includes(p))).toBe(true);
    const offersToMe = () => s.transferOffers.filter((o) => o.toTeamId === 't0' && o.status === 'pending').length;
    const roll = (k = 30) => withConfig('market', { aiOfferChancePerRound: 1 }, () => {
      for (let i = 0; i < k; i++) generateAiOffers(s);
    });
    roll();
    expect(offersToMe()).toBe(0);
    // 先满 10 场：仍不满 6 个转会回合
    playSeries(s, 't0', MIN);
    roll();
    expect(offersToMe()).toBe(0);
    // 反过来：满 6 个转会回合、场数从 0 重新计
    for (const p of news) p.joinedTeamSeries = teamSeriesCount(s.teams.t0);
    passRounds(s, RMIN);
    roll();
    expect(offersToMe()).toBe(0);
    // 两个条件都满足
    playSeries(s, 't0', MIN);
    roll(1);
    expect(offersToMe()).toBe(1);
  });

  it('挖角（低归属感）：任一条件未满足的新加盟选手不会被挖角，开局阵容照常', () => {
    const s = prep();
    regularRound(s, 2);
    const n = fa(s, { position: 'M' });
    sign(s, n);
    for (const p of teamPlayers(s, 't0')) p.loyalty = 5;
    const poachOnce = () => withConfig('loyalty', { leaveChancePerRound: 0, poachChancePerRound: 1 }, () => processLoyaltyDepartures(s));
    const poachedN = () => s.transferOffers.some((o) => o.poach && o.playerId === n.id);
    poachOnce();
    const poached = new Set(s.transferOffers.filter((o) => o.poach && o.toTeamId === 't0').map((o) => o.playerId));
    expect(poached.has(n.id)).toBe(false);
    expect(poached.size).toBeGreaterThan(0);
    const reset = () => {
      s.transferOffers = [];
      s.pendingDecisions = [];
    };
    // 只满 10 场
    reset();
    playSeries(s, 't0', MIN);
    poachOnce();
    expect(poachedN()).toBe(false);
    // 只满 6 个转会回合
    reset();
    n.joinedTeamSeries = teamSeriesCount(s.teams.t0);
    passRounds(s, RMIN);
    poachOnce();
    expect(poachedN()).toBe(false);
    // 两个条件都满足后照常
    reset();
    playSeries(s, 't0', MIN);
    poachOnce();
    expect(poachedN()).toBe(true);
  });

  it('挖角（薪资强烈不满的明星，归属感尚可）：任一条件未满足的新加盟明星不会被挖角，满足后照常', () => {
    const s = prep();
    regularRound(s, 2);
    for (const t of Object.values(s.teams)) if (!t.isPlayer) t.gold = 50_000_000;
    const star = fa(s, { position: 'M', power: 88, mmr: 10500 });
    sign(s, star);
    // 开局阵容都满意、归属感高：不会出现在任何挖角 / 离队路径里
    for (const p of teamPlayers(s, 't0')) {
      p.loyalty = 95;
      p.salary = Math.round(expectedSalary(s, p) * 1.2);
    }
    // 新加盟的明星：归属感高于离队线、低于明星挖角上限，薪资强烈不满
    star.loyalty = 50;
    expect(star.loyalty).toBeGreaterThanOrEqual(CONFIG.loyalty.leaveThreshold);
    expect(star.loyalty).toBeLessThan(CONFIG.salary.poach.unhappyStarLoyaltyMax);
    star.salary = Math.round(expectedSalary(s, star) * 0.55);
    const force = { ...CONFIG.salary.poach, unhappyStarPoachChance: 1, unhappyStarPoachMax: 1 };
    const poachOnce = () => withConfig('salary', { poach: force }, () =>
      withConfig('loyalty', { leaveChancePerRound: 0, poachChancePerRound: 0 }, () => processLoyaltyDepartures(s)));
    const starPoach = () => s.pendingDecisions.find((d) => d.kind === 'poach' && d.ctx.playerId === star.id);
    // 两个条件都未满足
    poachOnce();
    expect(starPoach()).toBeUndefined();
    expect(s.transferOffers.some((o) => o.poach)).toBe(false);
    // 只满 10 场
    playSeries(s, 't0', MIN);
    poachOnce();
    expect(starPoach()).toBeUndefined();
    // 只满 6 个转会回合
    star.joinedTeamSeries = teamSeriesCount(s.teams.t0);
    passRounds(s, RMIN);
    poachOnce();
    expect(starPoach()).toBeUndefined();
    // 两个条件都满足：薪资不满的明星挖角照常
    playSeries(s, 't0', MIN);
    poachOnce();
    const d = starPoach();
    expect(d).toBeTruthy();
    expect(d!.body).toContain('对薪资不满');
  });

  it('休赛期转会潮的求购（humanInterest）：任一条件未满足的新加盟选手不收到报价，其他队员照常', () => {
    const build = (): GameState => {
      const s = makeTestState(16, 11);
      s.settings.startTi = 9;
      s.season = { ...s.season, ti: 10, year: 2021 };
      const rng = seededRng(11 * 7919);
      for (const p of Object.values(s.players)) {
        p.mmr = 7000 + rng.int(0, 4500);
        p.birthYear = 1995;
        p.loyalty = 40;
        p.salary = 4000;
      }
      for (const t of Object.values(s.teams)) t.gold = 5_000_000;
      for (const pos of POSITIONS) Object.assign(s.players[`t0-${pos}`], { power: 96, mmr: 11000 });
      refreshFreeAgents(s);
      return s;
    };
    const cfg = { humanOfferChance: 1, humanMaxOffers: 5, humanLeaveChance: 0 };
    const control = build();
    withConfig('shuffle', cfg, () => offseasonShuffle(control));
    const ctl = control.transferOffers.filter((o) => o.toTeamId === 't0').map((o) => o.playerId);
    expect(ctl.length).toBeGreaterThan(1);
    const locked = ctl.slice(0, 2);
    // 只差随队场数 / 只差入队转会回合
    for (const by of ['matches', 'rounds'] as const) {
      const s = build();
      for (const id of locked) {
        const p = s.players[id];
        if (by === 'matches') {
          p.joinedTeamSeries = teamSeriesCount(s.teams.t0);
          p.joinedTeamClock = listingClock(s) - RMIN;
        } else {
          s.teams.t0.seriesCount = MIN;
          p.joinedTeamSeries = 0;
          p.joinedTeamClock = listingClock(s);
        }
        expect(resaleLocked(s, p), `${by} ${id}`).toBe(true);
      }
      withConfig('shuffle', cfg, () => offseasonShuffle(s));
      const got = s.transferOffers.filter((o) => o.toTeamId === 't0').map((o) => o.playerId);
      for (const id of locked) expect(got, by).not.toContain(id);
      expect(got.length).toBeGreaterThan(0);
    }
  });

  it('休赛期使命求购（missionOffersToHumans）：任一条件未满足的使命成员不收到报价，两个条件都满足后照常', () => {
    const OG_PEAK = ['ana', 'topson', 'ceb', 'jerax', 'n0tail'];
    const OG_POS = ['C', 'M', 'O', 'SS', 'HS'] as const;
    /** 16 队测试联赛（t0 为玩家）+ AI 真实俱乐部 og（TI8 巅峰阵容的使命生效）；ana 在玩家战队，其余四人在 og */
    const build = (matchesSinceJoin: number, roundsSinceJoin: number): GameState => {
      const s = makeTestState(16);
      s.settings.startTi = 8;
      s.settings.endTi = 16;
      s.season = { ...s.season, ti: 10, year: 2021 };
      for (const t of Object.values(s.teams)) t.gold = 3_000_000;
      addTeam(s, 'og', { region: 'EU', power: 72, gold: 3_000_000 });
      s.teams.og.name = 'OG';
      OG_PEAK.forEach((id, i) => {
        const teamId = i === 0 ? 't0' : 'og';
        const p = makePlayer({ id, handle: id, position: OG_POS[i], teamId, power: 80, isReal: true, contractUntil: 12 });
        s.players[p.id] = p;
        s.teams[teamId].playerIds.push(p.id);
      });
      s.teams.t0.seriesCount = 30;
      s.players.ana.joinedTeamSeries = 30 - matchesSinceJoin;
      s.players.ana.joinedTeamClock = listingClock(s) - roundsSinceJoin;
      refreshFreeAgents(s);
      return s;
    };
    const missionOffer = (s: GameState) => s.transferOffers.find((o) => o.playerId === 'ana' && o.fromTeamId === 'og');
    // 随队 5 场（入队 6 个转会回合）/ 随队 10 场（入队 5 个转会回合）：不收到使命报价（也不被其他俱乐部求购）
    for (const [m, r] of [[5, RMIN], [MIN, RMIN - 1]]) {
      const locked = build(m, r);
      expect(listingMatchLockLeft(locked, locked.players.ana)).toBe(MIN - m);
      expect(listingRoundLockLeft(locked, locked.players.ana)).toBe(RMIN - r);
      withConfig('missions', { humanOfferChance: 1 }, () => offseasonShuffle(locked));
      expect(locked.players.ana.teamId).toBe('t0');
      expect(missionOffer(locked)).toBeUndefined();
      expect(locked.transferOffers.some((o) => o.playerId === 'ana')).toBe(false);
    }
    // 两个条件都满足：照常收到使命报价
    const open = build(MIN, RMIN);
    expect(resaleLocked(open, open.players.ana)).toBe(false);
    withConfig('missions', { humanOfferChance: 1 }, () => offseasonShuffle(open));
    expect(missionOffer(open)?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
describe('交易抵价：刚签下的自由选手 / 本队抽卡新秀', () => {
  it('入队不满 18 个转会回合或未满足加盟门槛，任一成立都按签字费估值；买来的选手不受影响', () => {
    const T = CONFIG.market.trade;
    const s = prep(4);
    regularRound(s, 2);
    const p = fa(s, { position: 'M', power: 80, mmr: 9500 });
    sign(s, p);
    const at = listingClock(s);
    expect(p.freeAgentSignedClock).toBe(at);
    expect(p.joinedTeamClock).toBe(at);
    const factor = () => tradeValuation(s, 't1-M', [p.id]).items[0];
    expect(factor().factor).toBe(T.freeAgentSignedCap);
    // 满 18 个转会回合（两个时钟同一起点）、但随队不满 10 场（战队打得少）：仍按签字费估值
    p.freeAgentSignedClock = at - T.freeAgentHoldRounds;
    p.joinedTeamClock = at - T.freeAgentHoldRounds;
    expect(factor().factor).toBe(T.freeAgentSignedCap);
    expect(factor().notes.join('')).toContain(`入队不满 ${T.freeAgentHoldRounds} 个转会回合或随队不满 ${MIN} 场比赛`);
    // 说明里的回合数（引擎估值说明与界面规则文字共用 tradeHoldRoundsLabel）取持有期与入队门槛的较大值
    expect(tradeHoldRoundsLabel('freeAgent')).toBe(T.freeAgentHoldRounds);
    expect(tradeHoldRoundsLabel('gacha')).toBe(CONFIG.gacha.resaleHoldRounds);
    withConfig('squadOps', { listingMinTransferRounds: T.freeAgentHoldRounds + 6 }, () => {
      expect(tradeHoldRoundsLabel('freeAgent')).toBe(T.freeAgentHoldRounds + 6);
      expect(factor().notes.join('')).toContain(`入队不满 ${T.freeAgentHoldRounds + 6} 个转会回合`);
    });
    // 满 10 场、但不满 18 个转会回合：仍按签字费估值（不缩短原有持有期）
    p.freeAgentSignedClock = at;
    p.joinedTeamClock = at;
    playSeries(s, 't0', MIN);
    expect(factor().factor).toBe(T.freeAgentSignedCap);
    // 两个条件都满足：正常系数
    p.freeAgentSignedClock = at - T.freeAgentHoldRounds;
    p.joinedTeamClock = at - T.freeAgentHoldRounds;
    expect(factor().factor).toBeGreaterThan(T.freeAgentSignedCap);
    // 入队转会回合未满（只看加盟门槛的这一项）：同样封顶
    p.joinedTeamClock = at;
    expect(listingRoundLockLeft(s, p)).toBe(RMIN);
    expect(factor().factor).toBe(T.freeAgentSignedCap);
    // 求购来的选手未满足加盟门槛：不能挂牌，但抵价按正常系数（付过市场价，没有套利）
    const bought = s.players['t2-M'];
    bought.loyalty = 5;
    expect(retry(s, () => bidForPlayer(s, bought.id, marketValue(s, bought) * 3)).ok).toBe(true);
    expect(listingMatchLockLeft(s, bought)).toBe(MIN);
    expect(listingRoundLockLeft(s, bought)).toBe(RMIN);
    expect(tradeValuation(s, 't1-M', [bought.id]).items[0].factor).toBeGreaterThan(T.freeAgentSignedCap);
  });

  it('本队抽卡得到的新秀：转售冷却已过、未满足加盟门槛（随队场数或入队转会回合）仍按签字费估值，都满足后正常；离队后不受限', () => {
    const T = CONFIG.market.trade;
    const s = prep(4);
    regularRound(s, 2);
    const p = fa(s, { position: 'M', power: 80, mmr: 9500 });
    addPlayerToTeam(s, p.id, 't0');
    // 两个赛季前抽到：转售冷却（18 个转会回合）已过，入队时钟同为当时
    p.gacha = {
      ti: s.season.ti - 2, round: 1, teamId: 't0', tier: 'A', kind: 'fictional',
      mmr: p.mmr, power: p.power, talent: p.talent, insight: p.insight,
    } as NonNullable<Player['gacha']>;
    p.joinedTeamClock = listingClockAt(p.gacha.ti, p.gacha.round);
    expect(gachaResaleLockLeft(s, p)).toBe(0);
    expect(listingRoundLockLeft(s, p)).toBe(0);
    expect(listingMatchLockLeft(s, p)).toBe(MIN);
    expect(p.freeAgentSignedClock).toBeUndefined();
    const item = () => tradeValuation(s, 't1-M', [p.id]).items[0];
    expect(item().factor).toBe(T.freeAgentSignedCap);
    expect(item().notes.join('')).toContain(`本队抽卡得到的新秀（入队不满 ${CONFIG.gacha.resaleHoldRounds} 个转会回合或随队不满 ${MIN} 场比赛）`);
    playSeries(s, 't0', MIN);
    expect(item().factor).toBeGreaterThan(T.freeAgentSignedCap);
    expect(item().notes.join('')).not.toContain('抽卡得到的新秀');
    // 入队转会回合未满（只看加盟门槛的这一项）：同样封顶
    p.joinedTeamClock = listingClock(s);
    expect(item().factor).toBe(T.freeAgentSignedCap);
    // 不是本队抽到的（抽中他的是别的战队）：加盟门槛不影响抵价估值
    p.joinedTeamSeries = teamSeriesCount(s.teams.t0);
    p.gacha = { ...p.gacha!, teamId: 't3' };
    expect(listingMatchLockLeft(s, p)).toBe(MIN);
    expect(item().factor).toBeGreaterThan(T.freeAgentSignedCap);
  });
});

// ---------------------------------------------------------------------------
describe('旧存档与开局', () => {
  it('新游戏的开局阵容没有记录；读档 JSON 往返保留记录；旧存档（缺记录与累计场数）读档后不受限，之后新加盟的从读档时起计', async () => {
    const s = await createNewGame({ startTi: 9, seasons: 2, difficulty: 'normal', managerName: '旧档', teamId: 'og', seed: 3 });
    const me = s.settings.playerTeamId;
    for (const p of teamPlayers(s, me)) {
      expect(p.joinedTeamSeries).toBeUndefined();
      expect(p.joinedTeamClock).toBeUndefined();
    }
    s.teams[me].gold += 5_000_000;
    let signed: Player | null = null;
    for (const p of freeAgents(s).sort((a, b) => signingFee(s, a) - signingFee(s, b))) if (signFreeAgent(s, p.id).ok) { signed = p; break; }
    expect(signed).toBeTruthy();
    const id = signed!.id;
    expect(listingMatchLockLeft(s, signed!)).toBe(MIN);
    expect(listingRoundLockLeft(s, signed!)).toBe(RMIN);
    // 往返：记录保留
    const back = importSave(exportSave(s));
    expect(back.players[id].joinedTeamSeries).toBe(s.players[id].joinedTeamSeries);
    expect(back.players[id].joinedTeamClock).toBe(s.players[id].joinedTeamClock);
    expect(listingMatchLockLeft(back, back.players[id])).toBe(MIN);
    expect(listingRoundLockLeft(back, back.players[id])).toBe(RMIN);
    const strip = (keep: { series: boolean }) => {
      const raw = JSON.parse(exportSave(s));
      const run = (o: Record<string, unknown>) => {
        for (const p of Object.values(o.players as Record<string, Record<string, unknown>>)) {
          delete p.joinedTeamClock;
          if (!keep.series) delete p.joinedTeamSeries;
        }
        if (!keep.series) for (const t of Object.values(o.teams as Record<string, Record<string, unknown>>)) delete t.seriesCount;
      };
      if (raw.state) run(raw.state);
      else run(raw);
      return importSave(JSON.stringify(raw));
    };
    // v0.3.1 开发版存档：只有随队场数的记录 → 只看随队场数
    const dev = strip({ series: true });
    expect(dev.players[id].joinedTeamClock).toBeUndefined();
    expect(transferRoundsSinceJoin(dev, dev.players[id])).toBeNull();
    expect(listingMatchLockLeft(dev, dev.players[id])).toBe(MIN);
    expect(listPlayerForTransfer(dev, id).message).toBe(`${signed!.handle} 加盟后随队 0 场，需随队满 10 场才能挂牌（还差 10 场）`);
    // 模拟 v0.3.0 存档：没有任何记录
    const old = strip({ series: false });
    expect(old.players[id].joinedTeamSeries).toBeUndefined();
    expect(teamMatchesSinceJoin(old, old.players[id])).toBeNull();
    expect(transferRoundsSinceJoin(old, old.players[id])).toBeNull();
    expect(resaleLocked(old, old.players[id])).toBe(false);
    expect(listPlayerForTransfer(old, id).ok).toBe(true);
    // 读档后新签的：从 0 开始（战队累计场数从读档后开始累计，时钟照常）
    old.teams[me].gold += 5_000_000;
    let again: Player | null = null;
    for (const p of freeAgents(old).sort((a, b) => signingFee(old, a) - signingFee(old, b))) if (signFreeAgent(old, p.id).ok) { again = p; break; }
    expect(again!.joinedTeamSeries).toBe(0);
    expect(again!.joinedTeamClock).toBe(listingClock(old));
    expect(listingMatchLockLeft(old, again!)).toBe(MIN);
    expect(listingRoundLockLeft(old, again!)).toBe(RMIN);
  });
});

// ---------------------------------------------------------------------------
describe('多人：按座位生效', () => {
  it('座位签下的自由选手未满足加盟门槛不能挂牌（单个 / 批量），开局阵容可以；两个条件都满足后可以；两座位互不影响', async () => {
    expect(RPC_WHITELIST).toContain('listPlayerForTransfer');
    expect(RPC_WHITELIST).toContain('listPlayersForTransfer');
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 11,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    const call = (id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
    for (const id of [A, B]) {
      for (const p of teamPlayers(g, id)) {
        expect(p.joinedTeamSeries).toBeUndefined();
        expect(p.joinedTeamClock).toBeUndefined();
      }
    }
    g.teams[A].gold += 5_000_000;
    const cands = M.withSeat(g, A, () => freeAgents(g)).sort((a, b) => signingFee(g, a) - signingFee(g, b));
    let signed: Player | null = null;
    for (const p of cands) if (call(A, 'signFreeAgent', p.id).ok) { signed = p; break; }
    expect(signed).toBeTruthy();
    const p = g.players[signed!.id];
    expect(p.teamId).toBe(A);
    expect(p.joinedTeamClock).toBe(listingClock(g));
    const r = call(A, 'listPlayerForTransfer', p.id);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(lockMsg(p.handle, 0, 0));
    const founder = teamPlayers(g, A).find((x) => x.id !== p.id)!;
    const batch = call(A, 'listPlayersForTransfer', [founder.id, p.id]);
    expect(batch.ok).toBe(true);
    expect(batch.message).toContain('跳过 1 人');
    expect(batch.message).toContain('需随队满 10 场且入队满 6 个转会回合才能挂牌');
    // B 座位的战队打了很多场，不影响 A 的选手
    g.teams[B].seriesCount = 50;
    expect(call(A, 'listPlayerForTransfer', p.id).ok).toBe(false);
    g.teams[A].seriesCount = teamSeriesCount(g.teams[A]) + MIN;
    const r10 = call(A, 'listPlayerForTransfer', p.id);
    expect(r10.ok).toBe(false);
    expect(r10.message).toBe(lockMsg(p.handle, MIN, 0));
    // 经过 6 个转会回合（起点前移，等同 6 个常规赛回合结束）
    p.joinedTeamClock = listingClock(g) - RMIN;
    expect(call(A, 'listPlayerForTransfer', p.id).ok).toBe(true);
    // 别的座位不能替 A 挂牌
    expect(call(B, 'listPlayerForTransfer', founder.id).ok).toBe(false);
  });
});
