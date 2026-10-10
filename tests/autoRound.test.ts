// 「下一回合」自动处理（src/engine/autoRound.ts）：单机 advance(state, { auto: true })、按钮预览、
// 多人 setSeatReady(…, { auto: true })（含玩家对决：对手也自动推进 / 手动同意 / 房主托管 / 手动打完都不会卡住）、服务器 setRoundReady.auto
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameState, OpResult, PendingDecision, Tournament } from '../src/engine/types';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import * as M from '../src/engine/multi';
import {
  AUTO_ROUND_NEWS_TAG, advance, autoHandleRound, createNewGame, currentPlayerTournament, getAdvanceBlockers, previewAutoActions,
} from '../src/engine/game';
import { DEFAULT_DECISION_CHOICE, defaultDecisionChoice } from '../src/engine/events';
import { initTournamentStages, playerNextSeries } from '../src/engine/tournament';
import { teamPlayers, validateLineup } from '../src/engine/team';
import { currentStep } from '../src/engine/draft';
import { startServer, type RunningServer } from '../server/app';
import { TestClient, until } from '../server/testClient';
import { parseClientMsg } from '../server/validate';

beforeAll(() => {
  registerNodeRosterLoader();
});

const clone = <T>(v: T): T => structuredClone(v);

// ---------------------------------------------------------------------------
// 单机
// ---------------------------------------------------------------------------

/** 新俱乐部单机局：一路「下一回合（自动）」推进到第一个本方有比赛要打的赛事回合 */
async function gameAtTournamentRound(seed = 5): Promise<{ s: GameState; t: Tournament }> {
  const s = await createNewGame({
    startTi: 9, seasons: 2, difficulty: 'normal', managerName: '懒人', seed,
    newClub: { name: 'Auto Club', tag: 'AUT', region: 'CN', color: '#c23c2a' },
  });
  for (let i = 0; i < 30; i++) {
    const t = currentPlayerTournament(s);
    if (t && t.status === 'running' && playerNextSeries(s, t.id)) return { s, t };
    const r = advance(s, { auto: true });
    if (!r.ok) throw new Error(r.message);
  }
  throw new Error('30 个回合内没有赛事回合');
}

function decision(id: string, over: Partial<PendingDecision>): PendingDecision {
  return {
    id, kind: 'other', title: `测试事件 ${id}`, body: '', choices: [{ id: 'a', label: '选项一' }, { id: 'b', label: '选项二' }],
    ctx: {}, createdRound: 0, blocking: true, ...over,
  };
}

/** 赛事回合里制造阻塞：2 个待决事件 + 只剩 3 名可出场选手（首发不合法，需招募 2 名临时替补） */
function addBlockers(s: GameState, t: Tournament): void {
  const me = s.settings.playerTeamId;
  s.pendingDecisions.push(
    decision('d-scandal', {
      kind: 'scandal', title: '【丑闻】测试选手陷入舆论风波',
      choices: [{ id: 'pr', label: '公关处理' }, { id: 'ignore', label: '低调处理' }],
      ctx: { honor: -3, prCost: 50_000, prHonor: -1 },
    }),
    decision('d-fun', {}),
  );
  for (const p of teamPlayers(s, me).slice(3)) p.unavailableTournamentIds = [...(p.unavailableTournamentIds ?? []), t.id];
  expect(validateLineup(s, me, t.id).length).toBeGreaterThan(0);
}

describe('autoRound · 默认选项', () => {
  it('与多人托管同一张表；未列出的事件（含无厘头事件）取第一项', () => {
    expect(DEFAULT_DECISION_CHOICE.contract).toBe('renew_1');
    expect(DEFAULT_DECISION_CHOICE.leave_request).toBe('persuade');
    expect(DEFAULT_DECISION_CHOICE.match_fixing).toBe('cooperate');
    expect(DEFAULT_DECISION_CHOICE.visa).toBe('bench');
    expect(DEFAULT_DECISION_CHOICE.poach).toBe('decline');
    expect(defaultDecisionChoice(decision('x', { kind: 'scandal', choices: [{ id: 'pr', label: '' }, { id: 'ignore', label: '' }] }))).toBe('ignore');
    expect(defaultDecisionChoice(decision('x', { kind: 'other' }))).toBe('a');
    expect(defaultDecisionChoice(decision('x', { kind: 'contract', choices: [{ id: 'release', label: '' }] }))).toBe('release');
    expect(defaultDecisionChoice(decision('x', { kind: 'unpaid_salary', choices: [] }))).toBe('ack');
  });
});

describe('autoRound · 单机', () => {
  it('赛事回合：待决事件 + 首发不足 + 未打的系列赛，一次「下一回合（自动）」处理完并推进；预览与实际一致', async () => {
    const { s, t } = await gameAtTournamentRound();
    addBlockers(s, t);
    const codes = getAdvanceBlockers(s).map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(['pending_decision', 'tournament_running', 'lineup_invalid']));

    // 预览：纯函数
    const snap = JSON.stringify(s);
    const pv = previewAutoActions(s);
    expect(JSON.stringify(s)).toBe(snap);
    expect(pv.blocked).toBeNull();
    expect(pv.decisions).toBe(2);
    expect(pv.series).toBeGreaterThan(0);
    expect(pv.lineupFix).toBe(true);
    expect(pv.tempSubs).toBe(2);
    expect(pv.forfeitRisk).toBe(false);
    expect(pv.text).toMatch(/^将自动：/);
    expect(pv.text).toContain(`快速模拟 ${pv.series}`);
    expect(pv.text).toContain('默认处理 2 个事件');
    expect(pv.text).toContain('招募 2 名临时替补');

    // 预览与实际处理一致（在副本上只做自动处理、不推进）
    const c = clone(s);
    const rep = autoHandleRound(c);
    expect(rep.decisions).toBe(pv.decisions);
    expect(rep.tempSubs).toBe(pv.tempSubs);
    expect(rep.forfeits).toBe(0);
    expect(rep.series).toBeGreaterThanOrEqual(pv.series);
    if (!pv.moreSeries) expect(rep.series).toBe(pv.series);
    expect(rep.wins + rep.losses + rep.draws).toBe(rep.series);
    expect(rep.waiting).toBeNull();
    expect(getAdvanceBlockers(c)).toEqual([]);
    expect(c.tournaments[t.id].status).toBe('finished');
    expect(c.pendingDecisions.some((d) => d.blocking)).toBe(false);
    expect(previewAutoActions(c).text).toBe('');

    // 实际推进
    const round0 = s.roundIndex;
    const honor0 = s.teams[s.settings.playerTeamId].honor;
    const r = advance(s, { auto: true });
    expect(r.ok).toBe(true);
    expect(s.roundIndex).toBe(round0 + 1);
    expect(r.autoActions?.length).toBeGreaterThan(0);
    expect(r.autoActions!.some((l) => l.includes('低调处理'))).toBe(true); // 丑闻默认低调处理（不花公关费）
    expect(r.autoActions!.some((l) => l.includes('招募临时替补'))).toBe(true);
    expect(r.autoActions!.some((l) => l.startsWith(`快速模拟「${t.name}」`))).toBe(true);
    expect(s.tournaments[t.id].status).toBe('finished');
    expect(s.pendingDecisions.some((d) => d.id === 'd-scandal' || d.id === 'd-fun')).toBe(false);
    expect(s.finance.some((f) => f.category === 'temp_sub')).toBe(true);
    void honor0;
    // 一条私有新闻「本回合自动处理：…」
    const news = s.news.filter((n) => n.tags?.includes(AUTO_ROUND_NEWS_TAG));
    expect(news).toHaveLength(1);
    expect(news[0].title).toMatch(/^本回合自动处理：/);
    expect(news[0].visibility).toBe('private');
    expect(news[0].body).toContain('招募临时替补');
    // 招募后不保留其余候选、也不弹「野外替补已就位」
    expect(s.tempSubCandidates).toEqual([]);
    expect(s.popups.some((p) => p.kind === 'message' && p.title === '野外替补已就位')).toBe(false);
  });

  it('资金不足以招募临时替补：接受弃权判负，照常推进', async () => {
    const { s, t } = await gameAtTournamentRound();
    const me = s.settings.playerTeamId;
    for (const p of teamPlayers(s, me).slice(3)) p.unavailableTournamentIds = [...(p.unavailableTournamentIds ?? []), t.id];
    s.teams[me].gold = 0;
    const pv = previewAutoActions(s);
    expect(pv.lineupFix).toBe(true);
    expect(pv.forfeitRisk).toBe(true);
    expect(pv.items).toContain('资金不足将弃权');
    const c = clone(s);
    const rep = autoHandleRound(c);
    expect(rep.tempSubs).toBe(0);
    expect(rep.forfeits).toBe(rep.series);
    expect(rep.forfeits).toBeGreaterThan(0);
    expect(rep.lines.some((l) => l.includes('弃权'))).toBe(true);
    const r = advance(s, { auto: true });
    expect(r.ok).toBe(true);
    const mine = Object.values(s.tournaments[t.id].series).filter((x) => x.teamA === me || x.teamB === me);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.result?.forfeit === (x.teamA === me ? 'A' : 'B'))).toBe(true);
  });

  it('签证事件默认「用现有替补顶上」凑不齐：自动处理后撤掉过时的「野外替补已就位」与「首发不足 5 人」弹窗（招得起 / 招不起都撤）', async () => {
    for (const gold of [10_000_000, 0]) {
      const { s, t } = await gameAtTournamentRound();
      const me = s.settings.playerTeamId;
      const out = teamPlayers(s, me).slice(3);
      for (const p of out) p.unavailableTournamentIds = [...(p.unavailableTournamentIds ?? []), t.id];
      s.teams[me].gold = gold;
      s.pendingDecisions.push(decision('d-visa', {
        kind: 'visa', title: '【签证问题】测试',
        choices: [{ id: 'temp_sub', label: '去野外找替补' }, { id: 'bench', label: '用现有替补顶上' }],
        ctx: { tournamentId: t.id, playerIds: out.map((p) => p.id).join(','), position: out[0].position },
      }));
      // 进入赛事回合时的开赛提醒（season.preparePlayerTournament）与一条无关的消息弹窗
      s.popups.push({ kind: 'message', title: '首发不足 5 人', body: `出征「${t.name}」的首发不足 5 人：测试。` });
      s.popups.push({ kind: 'message', title: '无关提示', body: '保留' });
      const rep = autoHandleRound(s);
      expect(rep.decisions).toBe(1);
      expect(rep.lines.some((l) => l.includes('用现有替补顶上'))).toBe(true);
      if (gold) expect(rep.tempSubs).toBe(2);
      else expect(rep.forfeits).toBeGreaterThan(0);
      expect(s.tempSubCandidates).toEqual([]);
      const titles = s.popups.filter((p) => p.kind === 'message').map((p) => (p as { title: string }).title);
      expect(titles).not.toContain('野外替补已就位');
      expect(titles).not.toContain('首发不足 5 人');
      expect(titles).toContain('无关提示');
      expect(getAdvanceBlockers(s)).toEqual([]);
    }
  });

  it('advance(state) 不带选项与以前相同：有阻塞时失败且不改动状态；无阻塞时与自动推进结果一致', async () => {
    const { s, t } = await gameAtTournamentRound();
    addBlockers(s, t);
    const snap = JSON.stringify(s);
    const r = advance(s);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(getAdvanceBlockers(s).map((b) => b.message).join('；'));
    expect(r.autoActions).toBeUndefined();
    expect(JSON.stringify(s)).toBe(snap);
    // 自动处理后（无阻塞）：带不带 auto 推进结果完全相同（自动处理无事可做时不消耗随机数）
    autoHandleRound(s);
    expect(getAdvanceBlockers(s)).toEqual([]);
    const a = clone(s);
    const b = clone(s);
    const ra = advance(a);
    const rb = advance(b, { auto: true });
    expect(rb).toEqual(ra);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('确定性：同一种子一路自动推进两次结果一致，且一路不会被阻塞', async () => {
    const run = async () => {
      const s = await createNewGame({
        startTi: 9, seasons: 1, difficulty: 'hard', managerName: 'D', seed: 77,
        newClub: { name: 'Lazy Club', tag: 'LZY', region: 'EU', color: '#3a7bd5' },
      });
      for (let i = 0; i < 40 && !s.gameOver; i++) {
        const r = advance(s, { auto: true });
        if (!r.ok) throw new Error(`第 ${s.roundIndex} 回合推进失败：${r.message}`);
      }
      const { createdAt: _c, ...rest } = s;
      return JSON.stringify(rest);
    };
    expect(await run()).toBe(await run());
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 多人
// ---------------------------------------------------------------------------

const CLUBS = [
  { name: 'Alpha Club', tag: 'ALP', region: 'CN' as const, color: '#c23c2a' },
  { name: 'Beta Club', tag: 'BET', region: 'EU' as const, color: '#3a7bd5' },
  { name: 'Gamma Club', tag: 'GAM', region: 'SEA' as const, color: '#d4a017' },
];

async function buildGame(n = 2, seed = 11): Promise<GameState> {
  return M.createMultiplayerGame({
    startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed,
    players: CLUBS.slice(0, n).map((c, i) => ({ sessionId: `sess-${i}`, name: `玩家${i + 1}`, newClub: c })),
  });
}

const ids = (g: GameState) => g.multiplayer!.order;
const call = (g: GameState, id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
const inSeat = <T>(g: GameState, id: string, fn: () => T) => M.withSeat(g, id, fn);
const seat = (g: GameState, id: string) => g.multiplayer!.seats[id];

/** 婉拒第 1 回合的全部赛事并全员自动准备推进到第 1 回合 */
async function gameAtRound1(n: number, seed: number): Promise<GameState> {
  const g = await buildGame(n, seed);
  for (const id of ids(g)) {
    for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
      const t = g.tournaments[x];
      return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
    }))) call(g, id, 'unregisterFromTournament', tid);
  }
  for (const id of ids(g)) expect(M.setSeatReady(g, id, true, { auto: true }).ok).toBe(true);
  expect(M.allSeatsReady(g)).toBe(true);
  expect(M.advanceMultiplayer(g).ok).toBe(true);
  expect(g.roundIndex).toBe(1);
  for (const id of ids(g)) expect(seat(g, id).autoReady).toBeUndefined();
  return g;
}

function makeTournament(g: GameState, id: string, teams: string[], name = '测试自动杯'): Tournament {
  const t: Tournament = {
    id, seriesId: id, name, tier: 'major', season: g.season.ti,
    roundIndex: g.roundIndex, startDate: g.currentDate, city: '线上', hostRegion: 'CN', online: true, prizePool: 100000,
    appearanceFee: 0, format: 'se8', teamIds: teams.slice(), invitedTeamIds: teams.slice(), qualifierTeamIds: [], stages: [], series: {},
    status: 'scheduled', placements: [], playerStatus: 'locked', minHonor: 0, size: teams.length,
  };
  g.tournaments[t.id] = t;
  g.seasonTournamentIds.push(t.id);
  g.season.rounds[g.roundIndex].tournamentIds.push(t.id);
  t.expectedRanks = Object.fromEntries(teams.map((x, i) => [x, i + 1]));
  initTournamentStages(g, t.id);
  t.status = 'running';
  for (const x of teams) {
    if (!g.multiplayer!.seats[x]) continue;
    inSeat(g, x, () => {
      t.playerStatus = 'invited';
      t.expectedRank = t.expectedRanks![x];
    });
  }
  return t;
}

describe('autoRound · 多人座位自动准备', () => {
  it('待决事件与比赛：自动处理后准备；取消准备撤销意图；推进后清除', async () => {
    const g = await gameAtRound1(2, 41);
    const [A, B] = ids(g);
    inSeat(g, A, () => g.pendingDecisions.push(decision('d-mp', { title: '测试多人事件' })));
    expect(M.setSeatReady(g, A, true).ok).toBe(false); // 不带 auto：与以前相同
    const r = M.setSeatReady(g, A, true, { auto: true });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('测试多人事件');
    expect(seat(g, A).ready).toBe(true);
    expect(inSeat(g, A, () => g.pendingDecisions.length)).toBe(0);
    // 自动处理新闻只在本座位可见
    const n = g.news.find((x) => x.tags?.includes(AUTO_ROUND_NEWS_TAG));
    expect(n?.visibility).toBe('private');
    expect(M.seatView(g, A).news.some((x) => x.id === n!.id)).toBe(true);
    expect(M.seatView(g, B).news.some((x) => x.id === n!.id)).toBe(false);
    expect(M.setSeatReady(g, A, false).ok).toBe(true);
    expect(seat(g, A).autoReady).toBeUndefined();
    expect(g.settings.playerTeamId).toBe('');
  });

  it('玩家对决：一方自动推进只登记快速模拟并选择自动 BP（等待），另一方也自动推进时结算，双方都准备', async () => {
    const g = await gameAtRound1(2, 43);
    const [A, B] = ids(g);
    const t = makeTournament(g, 'test-auto-h2h', [A, B]);
    const series = Object.values(t.series).find((x) => x.teamA && x.teamB && !x.result)!;
    const pvA = inSeat(g, A, () => previewAutoActions(g));
    expect(pvA.h2h).toBe(true);
    expect(pvA.series).toBe(1);

    const ra = M.setSeatReady(g, A, true, { auto: true });
    expect(ra.ok).toBe(true);
    expect(ra.message).toContain('等待');
    expect(seat(g, A).ready).toBe(false);
    expect(seat(g, A).autoReady).toBe(true);
    const h = M.h2hMatch(g, series.id)!;
    expect(h.quickSim[A]).toBe(true);
    expect(h.mode[h.teamA === A ? 'A' : 'B']).toBe('auto');
    expect(series.result).toBeUndefined();

    const rb = M.setSeatReady(g, B, true, { auto: true });
    expect(rb.ok).toBe(true);
    expect(series.result).toBeTruthy();
    expect(seat(g, B).ready).toBe(true);
    expect(seat(g, A).ready).toBe(true); // A 的意图随之继续：结算后自动准备
    for (const id of [A, B]) expect(M.seatBlockers(g, id)).toEqual([]);
    expect(M.advanceMultiplayer(g).ok).toBe(true);
    for (const id of [A, B]) expect(seat(g, id).autoReady).toBeUndefined();
    expect(g.settings.playerTeamId).toBe('');
  });

  it('玩家对决：对手手动「快速模拟本场」同意 / 房主托管的离线对手，都会结算并让自动推进的一方准备', async () => {
    // 对手手动同意
    const g = await gameAtRound1(2, 47);
    const [A, B] = ids(g);
    const t = makeTournament(g, 'test-auto-h2h-agree', [A, B]);
    const series = Object.values(t.series).find((x) => x.teamA && x.teamB && !x.result)!;
    expect(M.setSeatReady(g, A, true, { auto: true }).ok).toBe(true);
    expect(seat(g, A).ready).toBe(false);
    expect(call(g, B, 'quickSimSeries').ok).toBe(true);
    expect(series.result).toBeTruthy();
    expect(seat(g, A).ready).toBe(true);
    expect(seat(g, B).ready).toBe(false); // B 没有请求准备
    expect(M.seatBlockers(g, B)).toEqual([]);

    // 房主托管的离线对手
    const g2 = await gameAtRound1(2, 53);
    const [A2, B2] = ids(g2);
    const t2 = makeTournament(g2, 'test-auto-h2h-autopilot', [A2, B2]);
    const s2 = Object.values(t2.series).find((x) => x.teamA && x.teamB && !x.result)!;
    expect(M.setSeatReady(g2, A2, true, { auto: true }).ok).toBe(true);
    expect(seat(g2, A2).ready).toBe(false);
    expect(M.autopilotSeat(g2, B2).ok).toBe(true);
    expect(s2.result).toBeTruthy();
    expect(seat(g2, B2).ready).toBe(true);
    expect(seat(g2, A2).ready).toBe(true);
    expect(M.advanceMultiplayer(g2).ok).toBe(true);
  });

  it('玩家对决：对手选择手动 BP 亲自打完，自动推进的一方由 AI 代为 BP、不会卡住', async () => {
    const g = await gameAtRound1(2, 59);
    const [A, B] = ids(g);
    const t = makeTournament(g, 'test-auto-h2h-manual', [A, B]);
    const series = Object.values(t.series).find((x) => x.teamA && x.teamB && !x.result)!;
    series.bestOf = 3;
    expect(M.setSeatReady(g, A, true, { auto: true }).ok).toBe(true);
    for (let game = 0; game < 5 && !series.result; game++) {
      const h = M.h2hMatch(g, series.id)!;
      if (!inSeat(g, B, () => g.activeMatch)) expect(call(g, B, 'prepareNextMatch').ok).toBe(true);
      expect(call(g, B, 'startDraft', true).ok).toBe(true);
      const sideB = h.teamA === B ? 'A' : 'B';
      for (let i = 0; i < 40 && h.draft && currentStep(h.draft); i++) {
        expect(currentStep(h.draft)!.side).toBe(sideB); // A 的回合已由 AI 代选
        expect(call(g, B, 'playerDraftAction', h.draft.available[0]).ok).toBe(true);
      }
      expect(call(g, B, 'playGame').ok).toBe(true);
      if (inSeat(g, B, () => g.activeMatch?.pendingGame)) call(g, B, 'commitGame');
    }
    expect(series.result).toBeTruthy();
    expect(M.h2hMatch(g, series.id)?.quickSim[B]).toBeFalsy(); // 手动方没有被迫快速模拟
    expect(seat(g, A).ready).toBe(true);
    expect(M.seatBlockers(g, A)).toEqual([]);
    expect(inSeat(g, A, () => g.activeMatch)).toBeNull();
  });

  it('下一场要等其他玩家的结果：保留意图，对手打完后自动继续（含随后的玩家对决），全员准备', async () => {
    const g = await gameAtRound1(2, 61);
    const [A, B] = ids(g);
    const ai = Object.values(g.teams).filter((x) => !x.isPlayer && !x.disbanded && x.playerIds.length >= 5).slice(0, 2).map((x) => x.id);
    // 两支 AI 战队实力极弱：A 晋级决赛后要等 B 的半决赛结果（决赛对手未定）
    for (const id of ai) for (const pid of g.teams[id].playerIds) Object.assign(g.players[pid], { power: 1, mmr: 1000, insight: 1 });
    const t = makeTournament(g, 'test-auto-wait', [A, B, ...ai]);
    const ra = M.setSeatReady(g, A, true, { auto: true });
    expect(ra.ok).toBe(true);
    expect(ra.message).toContain('快速模拟');
    expect(ra.message).toContain('将在可以时自动处理并准备');
    expect(seat(g, A).ready).toBe(false);
    expect(seat(g, A).autoReady).toBe(true);
    const pv = inSeat(g, A, () => previewAutoActions(g));
    expect(pv.waiting).toContain('等待其他玩家');
    expect(M.seatBlockers(g, A).map((b) => b.code)).toEqual(['tournament_running']);
    // B 打完半决赛 → A 的决赛对手确定（B 晋级则是玩家对决：B 登记快速模拟、A 的意图随之同意）→ A 自动打完决赛，双方准备
    expect(M.setSeatReady(g, B, true, { auto: true }).ok).toBe(true);
    const finalA = Object.values(g.tournaments[t.id].series).filter((x) => x.teamA === A || x.teamB === A);
    expect(finalA).toHaveLength(2);
    expect(finalA.every((x) => !!x.result)).toBe(true);
    // A 的两次自动处理（按下时打半决赛、之后自动继续打决赛）各有一条私有记录
    expect(g.news.filter((n) => n.tags?.includes(AUTO_ROUND_NEWS_TAG) && n.actorTeamId === A).length).toBeGreaterThanOrEqual(2);
    expect(g.tournaments[t.id].status).toBe('finished');
    expect(seat(g, A).ready).toBe(true);
    expect(seat(g, B).ready).toBe(true);
    expect(M.advanceMultiplayer(g).ok).toBe(true);
  });

  it('全部座位一直自动推进：跨过赛事、TI 与赛季结算不会卡住', async () => {
    const g = await buildGame(3, 67);
    const startTi = g.season.ti;
    for (let i = 0; i < 30 && !g.gameOver; i++) {
      for (const id of M.activeHumanIds(g)) {
        const r = M.setSeatReady(g, id, true, { auto: true });
        expect(r.ok).toBe(true);
      }
      expect(M.allSeatsReady(g)).toBe(true);
      expect(M.advanceMultiplayer(g).ok).toBe(true);
      expect(g.settings.playerTeamId).toBe('');
    }
    expect(g.season.ti).toBeGreaterThan(startTi);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 服务器（真实引擎）
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];
const running: RunningServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(running.splice(0).map((s) => s.close()));
});
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe('autoRound · 服务器 setRoundReady.auto', () => {
  it('校验：auto 可选且必须是布尔值', () => {
    const a = parseClientMsg('{"t":"setRoundReady","ready":true,"auto":true}');
    expect(a.ok && a.msg.t === 'setRoundReady' && a.msg.auto === true).toBe(true);
    const b = parseClientMsg('{"t":"setRoundReady","ready":true}');
    expect(b.ok && b.msg.t === 'setRoundReady' && b.msg.auto === undefined).toBe(true);
    expect(parseClientMsg('{"t":"setRoundReady","ready":true,"auto":"yes"}').ok).toBe(false);
  });

  it('两名玩家一直点「下一回合（自动）」：服务器自动处理并连续推进回合', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'd2m-auto-dist-'));
    tmpRoots.push(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><body>APP</body></html>');
    const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: null, distDir: dist, log: () => undefined, heartbeatMs: 0 });
    running.push(s);
    let seq = 0;
    const mk = async (name: string) => {
      const c = new TestClient(s.wsUrl, { sessionId: `sess-auto-${++seq}-${Math.random().toString(36).slice(2, 8)}`, name });
      clients.push(c);
      await c.hello();
      return c;
    };
    const a = await mk('甲');
    const b = await mk('乙');
    await a.request({ t: 'createRoom', name: '自动推进', maxPlayers: 2 }, 'room', (m) => !!m.room);
    await b.request({ t: 'joinRoom', roomId: a.room!.id }, 'room', (m) => !!m.room);
    await a.request({ t: 'updateSettings', settings: { mode: 'build', startTi: 9, endTi: 9 } }, 'room', (m) => m.room?.settings.endTi === 9);
    await a.request({ t: 'updateSeat', newClub: { name: '自动一队', tag: 'AT1', region: 'CN', color: '#c23c2a' } }, 'room', (m) => !!m.room?.seats[0].newClub);
    await b.request({ t: 'updateSeat', newClub: { name: '自动二队', tag: 'AT2', region: 'EU', color: '#2a7bc2' } }, 'room', (m) => !!m.room?.seats[1].newClub);
    await a.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[0].lobbyReady);
    await b.request({ t: 'setLobbyReady', ready: true }, 'room', (m) => !!m.room?.seats[1].lobbyReady);
    const sb = b.waitFor('state', () => true, 30_000);
    await a.request({ t: 'startGame' }, 'state', () => true, 30_000);
    await sb;
    await until(() => !!a.roundStatus && !!b.roundStatus, 5000, '回合状态');
    for (let i = 0; i < 8; i++) {
      const round0 = a.roundStatus!.round;
      for (const c of [a, b]) c.send({ t: 'setRoundReady', ready: true, auto: true });
      await until(() => a.roundStatus!.round !== round0 && b.roundStatus!.round !== round0, 20_000, `第 ${round0} 回合推进`);
    }
    await until(() => a.state!.roundIndex === a.roundStatus!.round, 5000, '视图同步');
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a.violations).toEqual([]);
    expect(a.state!.news.some((n) => n.tags?.includes(AUTO_ROUND_NEWS_TAG) && n.actorTeamId === b.teamId)).toBe(false);
  }, 120_000);
});
