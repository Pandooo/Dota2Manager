import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameRecord, GameState, Series, Tournament } from '../src/engine/types';
import { makePlayer, makeTestState } from './helpers';

// ---------------------------------------------------------------------------
// 依赖模块的最小 mock（保证本测试不依赖其他模块的实现进度）
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const state = {
    playerTournament: null as null | ((roundIndex: number) => unknown),
    script: [] as ('A' | 'B')[],
    recorded: [] as { seriesId: string; result: { winnerId: string; loserId: string; scoreA: number; scoreB: number; games: unknown[] } }[],
    finished: 0,
    simToEnd: 0,
    trainCalls: [] as { teamId: string; focus: string; mult?: number; attrMult?: number }[],
  };
  const makeRecord = (teamA: string, teamB: string, index: number, winner: 'A' | 'B') => ({
    index, teamA, teamB, radiant: 'A', draft: [],
    eval: { scoreA: 0, scoreB: 0, dotaPlusWinRateA: 0.5, notes: [] },
    strengthA: 1, strengthB: 1, winProbA: 0.5, winner, durationMin: 35, killsA: 20, killsB: 15,
    incidents: [], live: [], mvpPlayerId: undefined,
  });
  return { state, makeRecord };
});

vi.mock('../src/engine/schedule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/schedule')>()),
  playerTournamentInRound: vi.fn((_s: unknown, idx: number) => (h.state.playerTournament ? h.state.playerTournament(idx) : null)),
}));

vi.mock('../src/engine/tournament', async (importOriginal) => {
  const ME = 't0';
  const open = (state: GameState, tid: string) =>
    Object.values(state.tournaments[tid]?.series ?? {}).filter((s) => !s.result && (s.teamA === ME || s.teamB === ME));
  return {
    ...(await importOriginal<typeof import('../src/engine/tournament')>()),
    advanceTournamentUntilPlayer: vi.fn(),
    playerNextSeries: vi.fn((state: GameState, tid: string) => open(state, tid)[0] ?? null),
    isTeamEliminated: vi.fn((state: GameState, tid: string) => open(state, tid).length === 0),
    recordSeriesResult: vi.fn((state: GameState, tid: string, sid: string, result: never) => {
      state.tournaments[tid].series[sid].result = result;
      h.state.recorded.push({ seriesId: sid, result });
    }),
    simulateTournamentToEnd: vi.fn(() => {
      h.state.simToEnd++;
    }),
    finishTournament: vi.fn((state: GameState, tid: string) => {
      const t = state.tournaments[tid];
      t.status = 'finished';
      t.placements = [{ teamId: ME, rankFrom: 1, rankTo: 1, prize: 0, points: 0 }];
      h.state.finished++;
    }),
  };
});

vi.mock('../src/engine/match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/match')>()),
  simulateGame: vi.fn((_s: unknown, p: { teamA: string; teamB: string; gameIndex: number }) =>
    h.makeRecord(p.teamA, p.teamB, p.gameIndex, h.state.script.shift() ?? 'A')),
  computeWinProb: vi.fn(() => ({ strengthA: 100, strengthB: 100, share: 0.5, pWin: 0.6 })),
  seriesOutcome: vi.fn((bestOf: number, a: number, b: number) => {
    if (bestOf === 2) return a + b < 2 ? null : a > b ? 'A' : b > a ? 'B' : 'draw';
    const need = Math.floor(bestOf / 2) + 1;
    return a >= need ? 'A' : b >= need ? 'B' : null;
  }),
}));

vi.mock('../src/engine/draft', async (importOriginal) => {
  type D = { sequence: { side: 'A' | 'B'; type: 'ban' | 'pick' }[]; actions: { side: string; type: string; heroId: string }[]; available: string[]; done: boolean };
  const currentStep = (d: D) => (d.done ? null : d.sequence[d.actions.length] ?? null);
  const applyDraftAction = (_s: unknown, d: D, heroId: string) => {
    const step = currentStep(d);
    if (!step) throw new Error('BP 已结束');
    const i = d.available.indexOf(heroId);
    if (i < 0) throw new Error('英雄不可选');
    d.available.splice(i, 1);
    const a = { ...step, heroId };
    d.actions.push(a);
    if (d.actions.length >= d.sequence.length) d.done = true;
    return a;
  };
  return {
    ...(await importOriginal<typeof import('../src/engine/draft')>()),
    createDraft: vi.fn((): D => ({
      sequence: [{ side: 'A', type: 'ban' }, { side: 'B', type: 'ban' }, { side: 'A', type: 'pick' }, { side: 'B', type: 'pick' }],
      actions: [],
      available: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      done: false,
    })),
    currentStep: vi.fn(currentStep),
    applyDraftAction: vi.fn(applyDraftAction),
    runDraftUntil: vi.fn((s: unknown, d: D, _a: string, _b: string, side: 'A' | 'B' | null) => {
      while (!d.done) {
        const step = currentStep(d);
        if (!step || (side && step.side === side)) break;
        applyDraftAction(s, d, d.available[0]);
      }
    }),
    draftSuggestions: vi.fn((_s: unknown, d: D) => d.available.slice(0, 3).map((heroId) => ({ heroId, score: 50, reason: '测试推荐' }))),
  };
});

vi.mock('../src/engine/growth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/growth')>()),
  trainTeam: vi.fn((_s: unknown, teamId: string, focus: string, mult?: number, opts?: { attrMult?: number }) => {
    h.state.trainCalls.push({ teamId, focus, mult, attrMult: opts?.attrMult });
    return [{ playerId: 'x', handle: 'x', power: 0.5, mmr: 20, insight: 0.2, talent: 0, resilience: 0 }];
  }),
  scrimMultiplier: vi.fn(() => 1.5),
}));

vi.mock('../src/data/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/index')>()),
  getTiInfo: vi.fn(() => {
    throw new Error('no data');
  }),
}));

import {
  advance, buyExtraTraining, coachMarket, commitGame, currentPlayerTournament, doScrim, doTraining, fireCoach,
  getAdvanceBlockers, getDraftSuggestions, hireCoach, playGame, playerDraftAction, prepareNextMatch, quickSimSeries,
  quickSimTournament, setTrainingFocus, startDraft, trainingBlockReason, trainingSessionsLeft, dismissPopup,
  markAllNewsRead,
} from '../src/engine/game';
import { buildRounds, seasonStartDate, tiDates } from '../src/engine/calendar';
import { CONFIG } from '../src/engine/config';
import { makeCoach } from './helpers';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
function regularState(roundIndex = 2): GameState {
  const state = makeTestState(4);
  const start = seasonStartDate(9);
  const { startDate, endDate } = tiDates(9);
  state.season = { ...state.season, startDate: start, tiStartDate: startDate, rounds: buildRounds(9, start, startDate, endDate) };
  state.phase = 'regular';
  state.roundIndex = roundIndex;
  state.currentDate = state.season.rounds[roundIndex].startDate;
  return state;
}

function series(id: string, teamA: string, teamB: string, bestOf: Series['bestOf'], round = 1): Series {
  return { id, tournamentId: 'tour', stageId: 'st', label: `测试 ${id}`, teamA, teamB, bestOf, round };
}

function addTournament(state: GameState, ss: Series[], roundIndex = 2): Tournament {
  const t = {
    id: 'tour', seriesId: 'tour', name: '测试杯', tier: 'minor', season: 9, roundIndex, startDate: state.currentDate,
    city: '上海', hostRegion: 'CN', online: false, prizePool: 100000, appearanceFee: 0, format: 'se8',
    teamIds: ['t0', 't1', 't2', 't3'], invitedTeamIds: [], qualifierTeamIds: [], stages: [],
    series: Object.fromEntries(ss.map((s) => [s.id, s])), status: 'running', placements: [],
    playerStatus: 'registered', minHonor: 0,
  } as unknown as Tournament;
  state.tournaments.tour = t;
  state.seasonTournamentIds.push('tour');
  state.season.rounds[roundIndex].tournamentIds.push('tour');
  h.state.playerTournament = (idx) => (idx === roundIndex ? t : null);
  return t;
}

beforeEach(() => {
  h.state.playerTournament = null;
  h.state.script = [];
  h.state.recorded = [];
  h.state.finished = 0;
  h.state.simToEnd = 0;
  h.state.trainCalls = [];
});

// ---------------------------------------------------------------------------
describe('game: 推进阻塞', () => {
  it('赛季初无阻塞', () => {
    const state = makeTestState(4);
    expect(getAdvanceBlockers(state)).toEqual([]);
  });

  it('游戏结束时只返回 game_over，advance 失败且不改状态', () => {
    const state = regularState();
    state.gameOver = { reason: 'disbanded', summary: 'x' };
    const blockers = getAdvanceBlockers(state);
    expect(blockers.map((b) => b.code)).toEqual(['game_over']);
    const r = advance(state);
    expect(r.ok).toBe(false);
    expect(state.roundIndex).toBe(2);
  });

  it('待处理决策 / 比赛进行中（阵容超出常规上限不算阻塞）', () => {
    const state = makeTestState(4);
    state.pendingDecisions.push({
      id: 'd1', kind: 'other', title: 't', body: 'b', choices: [{ id: 'ok', label: '好' }], ctx: {}, createdRound: 0, blocking: true,
    });
    state.pendingDecisions.push({
      id: 'd2', kind: 'other', title: 't', body: 'b', choices: [{ id: 'ok', label: '好' }], ctx: {}, createdRound: 0, blocking: false,
    });
    state.tournaments.x = {
      id: 'x', name: '测试杯', series: { y: { id: 'y', teamA: 't0', teamB: 't1', bestOf: 3 } },
    } as unknown as Tournament;
    state.activeMatch = { tournamentId: 'x', seriesId: 'y', gameIndex: 0, draft: null, phase: 'pre', manualDraft: false };
    for (let i = 0; i < 4; i++) {
      const p = makePlayer({ id: `extra${i}`, teamId: 't0' });
      state.players[p.id] = p;
      state.teams.t0.playerIds.push(p.id);
    }
    const codes = getAdvanceBlockers(state).map((b) => b.code);
    expect(codes).toContain('pending_decision');
    expect(codes).toContain('match_in_progress');
    expect(codes).not.toContain('lineup_invalid');
    expect(getAdvanceBlockers(state).find((b) => b.code === 'pending_decision')!.message).toContain('1 项');
    const r = advance(state);
    expect(r.ok).toBe(false);
    expect(state.phase).toBe('preseason');
  });

  it('阵容人数：超出常规上限不阻塞；超出绝对上限（抽卡超编）须在本回合内退回 12 人才能推进（转会窗口锁定时不阻塞）', () => {
    const state = makeTestState(4);
    const add = (n: number) => {
      for (let i = 0; i < n; i++) {
        const p = makePlayer({ id: `big${state.teams.t0.playerIds.length}-${i}`, teamId: 't0' });
        state.players[p.id] = p;
        state.teams.t0.playerIds.push(p.id);
      }
    };
    add(CONFIG.team.hardMaxRoster - state.teams.t0.playerIds.length);
    expect(state.teams.t0.playerIds.length).toBe(CONFIG.team.hardMaxRoster);
    expect(getAdvanceBlockers(state)).toEqual([]); // 12 人（超出常规上限 8）不阻塞
    add(2);
    const bl = getAdvanceBlockers(state);
    expect(bl.map((b) => b.code)).toEqual(['roster_over_cap']);
    expect(bl[0].message).toBe(`超编 2 人：本回合内放弃新秀或解约 2 人（降到 ${CONFIG.team.hardMaxRoster} 人以内）后才能进入下一回合`);
    expect(advance(state).ok).toBe(false);
    expect(state.phase).toBe('preseason');
    // 转会窗口锁定（TI 阶段）时不阻塞：超编只会在窗口开放的回合因抽卡出现、且必须当回合处理完
    state.phase = 'ti';
    expect(getAdvanceBlockers(state).map((b) => b.code)).not.toContain('roster_over_cap');
    state.phase = 'preseason';
    // 退回 12 人后可以推进
    for (const id of state.teams.t0.playerIds.slice(-2)) {
      state.teams.t0.playerIds = state.teams.t0.playerIds.filter((x) => x !== id);
      state.players[id].teamId = null;
    }
    expect(getAdvanceBlockers(state)).toEqual([]);
    const r = advance(state);
    expect(r.ok, r.message).toBe(true);
  });

  it('失效的比赛状态（赛事/系列赛不存在或已出结果）不阻塞推进，advance 时清理', () => {
    const state = makeTestState(4);
    state.activeMatch = { tournamentId: 'gone', seriesId: 'y', gameIndex: 0, draft: null, phase: 'pre', manualDraft: false };
    expect(getAdvanceBlockers(state).map((b) => b.code)).not.toContain('match_in_progress');
    advance(state);
    expect(state.activeMatch).toBeNull();
  });

  it('本回合赛事未打完 → tournament_running；首发不合法 → lineup_invalid', () => {
    const state = regularState();
    addTournament(state, [series('s1', 't0', 't1', 3)]);
    let codes = getAdvanceBlockers(state).map((b) => b.code);
    expect(codes).toEqual(['tournament_running']);
    state.players['t0-C'].unavailableTournamentIds = ['tour'];
    codes = getAdvanceBlockers(state).map((b) => b.code);
    expect(codes).toEqual(['tournament_running', 'lineup_invalid']);
    expect(currentPlayerTournament(state)?.id).toBe('tour');
  });
});

// ---------------------------------------------------------------------------
describe('game: 训练', () => {
  it('赛季初与赛事回合不能训练', () => {
    const pre = makeTestState(4);
    expect(trainingBlockReason(pre)).toContain('赛季初');
    expect(doTraining(pre).ok).toBe(false);
    expect(trainingSessionsLeft(pre)).toBe(0);

    const st = regularState();
    addTournament(st, [series('s1', 't0', 't1', 3)]);
    expect(trainingBlockReason(st)).toContain('赛事回合');
    expect(buyExtraTraining(st).ok).toBe(false);
  });

  it('休赛回合：免费训练 → 购买额外训练 → 训练赛', () => {
    const state = regularState(3);
    setTrainingFocus(state, 'power');
    expect(state.trainingFocus).toBe('power');
    setTrainingFocus(state, 'bogus' as never);
    expect(state.trainingFocus).toBe('power');

    expect(trainingSessionsLeft(state)).toBe(1);
    const r1 = doTraining(state);
    expect(r1.ok).toBe(true);
    expect(r1.gains).toHaveLength(1);
    expect(h.state.trainCalls[0]).toMatchObject({ teamId: 't0', focus: 'power' });
    expect(h.state.trainCalls[0].attrMult).toBeUndefined(); // 每回合第一次（免费）训练：天赋 / 韧性全额
    expect(doTraining(state).ok).toBe(false);

    const gold = state.teams.t0.gold;
    const b = buyExtraTraining(state);
    expect(b.ok).toBe(true);
    expect(state.teams.t0.gold).toBeLessThan(gold);
    expect(state.season.extraTrainingsBought).toBe(1);
    expect(trainingSessionsLeft(state)).toBe(1);
    expect(state.finance.at(-1)?.category).toBe('training');

    const s = doScrim(state, 't3');
    expect(s.ok).toBe(true);
    expect(s.mult).toBe(1.5);
    expect(typeof s.won).toBe('boolean');
    expect(h.state.trainCalls.at(-1)?.mult).toBe(1.5);
    // 训练赛消耗的是已购额外次数（本回合第 2 次训练）：天赋 / 韧性收益 × extraSessionAttrMult
    expect(h.state.trainCalls.at(-1)?.attrMult).toBe(CONFIG.training.extraSessionAttrMult);
    expect(trainingSessionsLeft(state)).toBe(0);
    expect(doScrim(state, 't3').ok).toBe(false);
    expect(doScrim(state, 't0').ok).toBe(false);

    for (let i = 1; i < CONFIG.training.maxExtraPerRound; i++) expect(buyExtraTraining(state).ok).toBe(true);
    expect(buyExtraTraining(state).message).toContain('最多');
  });

  it('资金不足无法购买', () => {
    const state = regularState(3);
    state.teams.t0.gold = 0;
    expect(buyExtraTraining(state).message).toContain('资金不足');
  });
});

// ---------------------------------------------------------------------------
describe('game: 教练', () => {
  it('签约、替换、解雇', () => {
    const state = regularState(3);
    const a = makeCoach({ id: 'ca', tier: 'S', salary: 1000 });
    const b = makeCoach({ id: 'cb', tier: 'SS', salary: 2000 });
    state.coaches.ca = a;
    state.coaches.cb = b;
    expect(coachMarket(state).map((c) => c.id)).toEqual(['cb', 'ca']);
    expect(hireCoach(state, 'ca').ok).toBe(true);
    expect(state.teams.t0.coachId).toBe('ca');
    expect(hireCoach(state, 'ca').ok).toBe(false);
    expect(hireCoach(state, 'cb').ok).toBe(true);
    expect(a.teamId).toBeNull();
    expect(fireCoach(state).ok).toBe(true);
    expect(b.teamId).toBeNull();
    expect(fireCoach(state).ok).toBe(false);
    state.phase = 'ti';
    expect(hireCoach(state, 'ca').message).toContain('窗口');
  });
});

// ---------------------------------------------------------------------------
describe('game: 比赛流程', () => {
  it('玩家为 A 方：手动 BP → 直播 → 提交 → 快速模拟收尾', () => {
    const state = regularState();
    addTournament(state, [series('s1', 't0', 't1', 3)]);

    expect(getDraftSuggestions(state)).toEqual([]);
    expect(playGame(state).ok).toBe(false);

    const p = prepareNextMatch(state);
    expect(p.ok).toBe(true);
    expect(state.activeMatch).toMatchObject({ seriesId: 's1', phase: 'pre', gameIndex: 0 });
    expect(prepareNextMatch(state).ok).toBe(true); // 幂等
    expect(doTraining(state).ok).toBe(false);

    expect(startDraft(state, true).ok).toBe(true);
    const draft = state.activeMatch!.draft!;
    expect(draft.actions).toHaveLength(0); // A 先手 = 玩家
    expect(getDraftSuggestions(state).map((s) => s.heroId)).toEqual(['h1', 'h2', 'h3']);
    expect(playerDraftAction(state, 'zzz').ok).toBe(false);
    expect(playerDraftAction(state, 'h2').ok).toBe(true);
    expect(draft.actions.map((a) => a.side)).toEqual(['A', 'B']);
    expect(playGame(state).message).toContain('BP 尚未完成');
    expect(startDraft(state, true).ok).toBe(false);
    expect(playerDraftAction(state, 'h4').ok).toBe(true);
    expect(draft.done).toBe(true);
    expect(playerDraftAction(state, 'h5').ok).toBe(false);

    h.state.script = ['A', 'B', 'A'];
    expect(playGame(state).ok).toBe(true);
    expect(state.activeMatch!.phase).toBe('live');
    expect(state.activeMatch!.pendingGame?.winner).toBe('A');
    expect(getAdvanceBlockers(state).map((b) => b.code)).toContain('match_in_progress');

    const c = commitGame(state);
    expect(c.ok).toBe(true);
    expect(c.message).toContain('1:0');
    expect(state.activeMatch).toMatchObject({ phase: 'pre', gameIndex: 1, draft: null });
    expect(commitGame(state).ok).toBe(false);

    const q = quickSimSeries(state);
    expect(q.ok).toBe(true);
    expect(h.state.recorded).toHaveLength(1);
    const res = h.state.recorded[0].result;
    expect(res).toMatchObject({ winnerId: 't0', loserId: 't1', scoreA: 2, scoreB: 1 });
    expect(res.games).toHaveLength(3);
    expect(state.activeMatch).toBeNull();
    expect(h.state.finished).toBe(1);
    expect(state.tournaments.tour.status).toBe('finished');
    expect(q.message).toContain('冠军');
    expect(getAdvanceBlockers(state)).toEqual([]);
    expect(state.news.some((n) => n.category === 'match' && n.body.includes('2:1'))).toBe(true);
  });

  it('玩家为 B 方：BP 由 A 方 AI 先手；Bo2 可打平', () => {
    const state = regularState();
    addTournament(state, [series('s2', 't1', 't0', 2)]);
    expect(prepareNextMatch(state).ok).toBe(true);
    expect(startDraft(state, true).ok).toBe(true);
    const draft = state.activeMatch!.draft!;
    expect(draft.actions.map((a) => a.side)).toEqual(['A']);
    expect(getDraftSuggestions(state)).toHaveLength(3);
    expect(playerDraftAction(state, 'h3').ok).toBe(true);
    expect(draft.actions.map((a) => a.side)).toEqual(['A', 'B', 'A']);

    h.state.script = ['A', 'B'];
    const r = quickSimSeries(state);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('握手言和');
    expect(h.state.recorded[0].result).toMatchObject({ winnerId: 't1', loserId: 't0', scoreA: 1, scoreB: 1 });
  });

  it('自动 BP 后直接开打', () => {
    const state = regularState();
    addTournament(state, [series('s1', 't0', 't1', 1)]);
    expect(prepareNextMatch(state).ok).toBe(true);
    expect(startDraft(state, false).ok).toBe(true);
    expect(state.activeMatch!.draft!.done).toBe(true);
    h.state.script = ['B'];
    expect(playGame(state).ok).toBe(true);
    const r = commitGame(state);
    expect(r.ok).toBe(true);
    expect(h.state.recorded[0].result).toMatchObject({ winnerId: 't1', scoreA: 0, scoreB: 1 });
    expect(state.tournaments.tour.status).toBe('finished');
  });

  it('quickSimTournament 打完玩家全部系列赛', () => {
    const state = regularState();
    addTournament(state, [series('s1', 't0', 't1', 3), series('s2', 't2', 't0', 3, 2)]);
    h.state.script = ['A', 'A', 'B', 'B'];
    const r = quickSimTournament(state);
    expect(r.ok).toBe(true);
    expect(h.state.recorded.map((x) => x.seriesId)).toEqual(['s1', 's2']);
    expect(h.state.recorded[1].result.winnerId).toBe('t0');
    expect(h.state.finished).toBe(1);
    expect(quickSimTournament(state).ok).toBe(false);
  });

  it('待处理决策或首发残缺时不能开赛', () => {
    const state = regularState();
    addTournament(state, [series('s1', 't0', 't1', 3)]);
    state.pendingDecisions.push({
      id: 'd1', kind: 'visa', title: '签证', body: 'b', choices: [{ id: 'ok', label: '好' }], ctx: {}, createdRound: 2, blocking: true,
    });
    expect(prepareNextMatch(state).message).toContain('待办');
    state.pendingDecisions = [];
    // 移除两名首发且无替补
    for (const id of ['t0-C', 't0-M']) {
      state.teams.t0.playerIds = state.teams.t0.playerIds.filter((x) => x !== id);
      state.players[id].teamId = null;
    }
    state.teams.t0.lineup.C = null;
    state.teams.t0.lineup.M = null;
    const r = prepareNextMatch(state);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('首发不足 5 人');
    expect(r.message).toContain('弃权判负');
    expect(state.activeMatch).toBeNull();
    // 推进阻塞里有明确的弃权警告
    expect(getAdvanceBlockers(state).some((b) => b.code === 'lineup_invalid' && b.message.includes('弃权判负'))).toBe(true);
    // 快速模拟：首发凑不齐 5 人 → 本场弃权判负（不再残阵出战），不模拟任何对局
    const q = quickSimSeries(state);
    expect(q.ok).toBe(true);
    expect(q.message).toContain('弃权判负');
    const res = h.state.recorded[0].result as { winnerId: string; scoreA: number; scoreB: number; games: unknown[]; forfeit?: string };
    expect(res).toMatchObject({ winnerId: 't1', scoreA: 0, scoreB: 2, forfeit: 'A' });
    expect(res.games).toEqual([]);
    expect(state.news.some((n) => n.title.includes('弃权判负'))).toBe(true);
    expect(state.news.some((n) => n.title.includes('残阵出战'))).toBe(false);
  });
});

describe('game: 杂项', () => {
  it('popup 与新闻已读', () => {
    const state = makeTestState(2);
    state.popups.push({ kind: 'message', title: 'a', body: 'b' }, { kind: 'season_summary', ti: 9 });
    dismissPopup(state);
    expect(state.popups).toEqual([{ kind: 'season_summary', ti: 9 }]);
    state.news.push({ id: 'n', season: 9, round: 0, date: 'x', category: 'system', title: 't', body: 'b', read: false });
    markAllNewsRead(state);
    expect(state.news.every((n) => n.read)).toBe(true);
  });
});

// 防止 GameRecord 类型未使用告警
export type _G = GameRecord;
