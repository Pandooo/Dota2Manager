import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coach, GameState, Player, Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeCoach, makePlayer, makeTestState } from './helpers';

const h = vi.hoisted(() => ({
  playerTournament: null as null | ((roundIndex: number) => unknown),
  retire: null as null | ((state: GameState) => { retired: Player[]; newCoaches: Coach[] }),
  aiWindow: [] as { mode: string; round: number; coachTeams: Record<string, string | null> }[],
  trainCalls: 0,
  visa: [] as string[],
  advanceUntil: [] as string[],
  simToEnd: [] as string[],
  finished: [] as string[],
  setupTi: 0,
  startRound: [] as number[],
}));

vi.mock('../src/data/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/data/index')>()),
  getRealPatches: vi.fn(() => []),
  getTiInfo: vi.fn(() => {
    throw new Error('no data');
  }),
}));
vi.mock('../src/engine/heroes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/heroes')>()),
  generateHeroMeta: vi.fn(() => ({})),
}));
vi.mock('../src/engine/schedule', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/schedule')>()),
  buildSeasonTournaments: vi.fn(),
  setupTiPhase: vi.fn(() => {
    h.setupTi++;
  }),
  startRoundTournaments: vi.fn((_s: unknown, idx: number) => {
    h.startRound.push(idx);
  }),
  playerTournamentInRound: vi.fn((_s: unknown, idx: number) => (h.playerTournament ? h.playerTournament(idx) : null)),
}));
vi.mock('../src/engine/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/ai')>()),
  aiTrainRound: vi.fn(),
  aiEnsureRosters: vi.fn(),
  aiTransferWindow: vi.fn((state: GameState, mode: string) => {
    h.aiWindow.push({
      mode,
      round: state.roundIndex,
      coachTeams: Object.fromEntries(Object.values(state.coaches).map((c) => [c.id, c.teamId])),
    });
  }),
}));
vi.mock('../src/engine/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/events')>()),
  rollRoundEvents: vi.fn(),
  processLoyaltyDepartures: vi.fn(),
  triggerUnpaidSalary: vi.fn(),
  checkVisaForTournament: vi.fn((_s: unknown, id: string) => {
    h.visa.push(id);
  }),
}));
vi.mock('../src/engine/rookieDraft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/rookieDraft')>()),
  runRookieDraft: vi.fn(),
}));
vi.mock('../src/engine/market', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/market')>()),
  refreshFreeAgents: vi.fn(),
  generateAiOffers: vi.fn(),
  expireOffers: vi.fn(),
  processContractExpiry: vi.fn(),
}));
vi.mock('../src/engine/tournament', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/tournament')>()),
  advanceTournamentUntilPlayer: vi.fn((_s: unknown, id: string) => {
    h.advanceUntil.push(id);
  }),
  playerNextSeries: vi.fn(() => ({ id: 'next' })),
  isTeamEliminated: vi.fn(() => false),
  simulateTournamentToEnd: vi.fn((_s: unknown, id: string) => {
    h.simToEnd.push(id);
  }),
  finishTournament: vi.fn((state: GameState, id: string) => {
    state.tournaments[id].status = 'finished';
    h.finished.push(id);
  }),
}));
vi.mock('../src/engine/honor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/honor')>()),
  expectedRank: vi.fn(() => 4),
}));
vi.mock('../src/engine/growth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/growth')>()),
  trainTeam: vi.fn(() => {
    h.trainCalls++;
    return [];
  }),
  agePlayersAtSeasonEnd: vi.fn(),
  roundLoyaltyUpdate: vi.fn(),
  processRetirements: vi.fn((state: GameState) => (h.retire ? h.retire(state) : { retired: [], newCoaches: [] })),
}));

import { advance, getAdvanceBlockers } from '../src/engine/game';
import {
  computeSeasonRanking, endRound, ensurePlayableLineup, enterRound, fillEmptyLineupSlots, pruneCoachPool, settleSeason, startSeason,
} from '../src/engine/season';
import { tiDates } from '../src/engine/calendar';
import { resetPatchCache } from '../src/engine/patches';
import { rollRoundEvents } from '../src/engine/events';

const R = CONFIG.calendar.regularRounds;

function freshState(): GameState {
  const state = makeTestState(4);
  for (const t of Object.values(state.teams)) t.gold = 50_000_000;
  state.settings.endTi = 10;
  state.settings.seasons = 2;
  return state;
}

beforeEach(() => {
  resetPatchCache();
  vi.mocked(rollRoundEvents).mockReset();
  h.playerTournament = null;
  h.retire = null;
  h.aiWindow = [];
  h.trainCalls = 0;
  h.visa = [];
  h.advanceUntil = [];
  h.simToEnd = [];
  h.finished = [];
  h.setupTi = 0;
  h.startRound = [];
});

describe('season: 开季', () => {
  it('建立回合表、映射版本、重置积分并写入新闻/快照', () => {
    const state = freshState();
    state.teams.t1.points = 999;
    startSeason(state, 9);
    expect(state.season.ti).toBe(9);
    expect(state.season.year).toBe(2019);
    expect(state.season.rounds).toHaveLength(R + 3);
    expect(state.phase).toBe('preseason');
    expect(state.roundIndex).toBe(0);
    expect(state.currentDate).toBe(state.season.startDate);
    expect(state.season.tiStartDate).toBe(tiDates(9).startDate);
    expect(state.teams.t1.points).toBe(0);
    expect(state.season.honorStart).toBe(300);
    expect(state.history.honor).toEqual([{ season: 9, round: 0, value: 300 }]);
    expect(state.news.some((n) => n.title === 'TI9 赛季开始')).toBe(true);
    // 离线版本史：7.20/7.21/7.22 发布于 TI9 赛季内
    const mapped = state.season.rounds.flatMap((r) => r.patchVersions);
    expect(mapped).toEqual(expect.arrayContaining(['7.20', '7.21', '7.22']));
    expect(state.season.rounds[0].patchVersions).toEqual([]);
    expect(h.aiWindow.map((w) => w.mode)).toEqual(['preseason']);
  });
});

describe('season: 随机事件', () => {
  it('每个回合（含赛季初回合 0、TI 预选、TI 正赛）开始时都滚动随机事件', () => {
    const state = freshState();
    const calls: string[] = [];
    vi.mocked(rollRoundEvents).mockImplementation((s: GameState) => {
      calls.push(`${s.season.ti}:${s.roundIndex}:${s.phase}`);
    });
    startSeason(state, 9);
    expect(calls).toEqual(['9:0:preseason']);
    let guard = 0;
    while (state.season.ti === 9 && guard++ < 100) expect(advance(state).ok).toBe(true);
    const expected = ['9:0:preseason'];
    for (let i = 1; i <= R; i++) expected.push(`9:${i}:regular`);
    expected.push(`9:${R + 1}:ti_qualifier`, `9:${R + 2}:ti`, '10:0:preseason');
    expect(calls).toEqual(expected);
  });

  it('赛季初事件计入本赛季：honorStart 取事件前的值，曲线快照取事件后的值', () => {
    const state = freshState();
    vi.mocked(rollRoundEvents).mockImplementation((s: GameState) => {
      if (s.phase === 'preseason') s.teams.t0.honor += 50;
    });
    startSeason(state, 9);
    expect(state.season.honorStart).toBe(300);
    expect(state.history.honor.at(-1)).toEqual({ season: 9, round: 0, value: 350 });
  });

  it('赛季初事件导致解散：游戏结束，不再生成后续抉择', () => {
    const state = freshState();
    startSeason(state, 9);
    state.roundIndex = R + 2;
    state.phase = 'ti';
    vi.mocked(rollRoundEvents).mockImplementation((s: GameState) => {
      if (s.phase === 'preseason') s.gameOver = { reason: 'disbanded', summary: '解散了' };
    });
    settleSeason(state);
    expect(state.season.ti).toBe(10);
    expect(state.gameOver?.reason).toBe('disbanded');
    expect(state.pendingDecisions.filter((d) => d.kind === 'retire')).toEqual([]);
  });
});

describe('season: 回合推进', () => {
  it('完整赛季：每回合自动训练、版本生效、TI 结算后进入下赛季，期满游戏结束', () => {
    const state = freshState();
    startSeason(state, 9);
    expect(advance(state).ok).toBe(true);
    expect(state.phase).toBe('regular');
    expect(state.roundIndex).toBe(1);

    let guard = 0;
    while (state.season.ti === 9 && guard++ < 100) expect(advance(state).ok).toBe(true);
    expect(state.season.ti).toBe(10);
    expect(state.phase).toBe('preseason');
    expect(state.history.seasons).toHaveLength(1);
    const sum = state.history.seasons[0];
    expect(sum.ti).toBe(9);
    expect(sum.playerTiRank).toBeNull();
    expect(sum.finalRank).toBeGreaterThan(0);
    expect(state.popups).toContainEqual({ kind: 'season_summary', ti: 9 });
    // R 个常规赛 + 预选 + TI 回合全部为休赛/观赛 → 每回合自动训练 1 次
    expect(h.trainCalls).toBe(R + 2);
    expect(state.appliedPatches).toEqual(expect.arrayContaining(['7.20', '7.21', '7.22']));
    expect(h.setupTi).toBe(1);
    expect(h.startRound).toHaveLength(R + 2);
    // 中期转会窗口
    expect(h.aiWindow.some((w) => w.mode === 'midseason' && w.round === Math.round(R / 2))).toBe(true);
    // 曲线快照：每回合一点
    expect(state.history.gold.filter((g) => g.season === 9).length).toBe(R + 3);

    guard = 0;
    while (!state.gameOver && guard++ < 100) advance(state);
    expect(state.gameOver?.reason).toBe('completed');
    expect(state.gameOver?.summary).toContain('TI 冠军 0 次');
    expect(getAdvanceBlockers(state).map((b) => b.code)).toEqual(['game_over']);
    expect(advance(state).ok).toBe(false);
  });

  it('玩家赛事回合：签证检查、预期名次、推进到玩家比赛；回合结束时结算所有赛事', () => {
    const state = freshState();
    startSeason(state, 9);
    const t = {
      id: 'cup', name: '测试杯', tier: 'minor', season: 9, roundIndex: 3, city: '上海', online: false, prizePool: 1000,
      teamIds: ['t0', 't1'], qualifierTeamIds: [], playerStatus: 'registered', status: 'running', series: {}, stages: [],
      placements: [],
    } as unknown as Tournament;
    const ai = { ...t, id: 'ai-cup', playerStatus: 'open', teamIds: ['t2', 't3'] } as Tournament;
    state.tournaments.cup = t;
    state.tournaments['ai-cup'] = ai;
    state.seasonTournamentIds.push('cup', 'ai-cup');
    state.season.rounds[3].tournamentIds.push('cup', 'ai-cup');
    h.playerTournament = (idx) => (idx === 3 ? t : null);

    enterRound(state, 3);
    expect(h.visa).toEqual(['cup']);
    expect(t.expectedRank).toBe(4);
    expect(h.advanceUntil).toEqual(['cup']);
    expect(state.news.some((n) => n.title === '出征 测试杯')).toBe(true);
    expect(getAdvanceBlockers(state).map((b) => b.code)).toContain('tournament_running');

    // 玩家比赛结束后推进：两项赛事都应被结算，赛事回合不自动训练
    t.status = 'finished';
    t.placements = [{ teamId: 't0', rankFrom: 1, rankTo: 1, prize: 0, points: 0 }];
    endRound(state);
    expect(h.finished).toEqual(['ai-cup']);
    expect(h.trainCalls).toBe(0);
  });
});

describe('season: TI 结算', () => {
  it('排名 = 积分 + TI 名次加成', () => {
    const state = freshState();
    state.teams.t1.points = 1000;
    state.teams.t2.points = 1200;
    const tiT = {
      id: 'ti-9', teamIds: ['t0', 't1', 't2', 't3'],
      placements: [
        { teamId: 't0', rankFrom: 1, rankTo: 1, prize: 0, points: 0 },
        { teamId: 't1', rankFrom: 2, rankTo: 2, prize: 0, points: 0 },
        { teamId: 't2', rankFrom: 3, rankTo: 4, prize: 0, points: 0 },
        { teamId: 't3', rankFrom: 3, rankTo: 4, prize: 0, points: 0 },
      ],
    } as unknown as Tournament;
    expect(computeSeasonRanking(state, tiT)[0]).toBe('t0');
    expect(computeSeasonRanking(state, null)).toEqual(['t2', 't1', 't0', 't3'].sort((a, b) => {
      const p = (id: string) => state.teams[id].points;
      return p(b) - p(a) || state.teams[b].honor - state.teams[a].honor || a.localeCompare(b);
    }));
  });

  it('玩家旧部退役：转任教练在 AI 窗口期间被保留，并生成「聘为教练」决策', () => {
    const state = freshState();
    startSeason(state, 9);
    state.roundIndex = R + 2;
    state.phase = 'ti';
    const coach = makeCoach({ id: 'coach-retiree', tier: 'S', formerPlayerId: 't0-HS' });
    h.retire = (s) => {
      const p = s.players['t0-HS'];
      s.teams.t0.playerIds = s.teams.t0.playerIds.filter((id) => id !== p.id);
      s.teams.t0.lineup.HS = null;
      p.teamId = null;
      p.status = 'retired';
      s.coaches[coach.id] = coach;
      return { retired: [p], newCoaches: [coach] };
    };
    h.aiWindow = [];
    settleSeason(state);
    expect(state.season.ti).toBe(10);
    // 下赛季 AI 转会窗口期间：教练被玩家战队占位
    expect(h.aiWindow[0].coachTeams[coach.id]).toBe('t0');
    // 之后释放回市场，等待玩家决定
    expect(coach.teamId).toBeNull();
    const d = state.pendingDecisions.find((x) => x.kind === 'retire');
    expect(d).toBeDefined();
    expect(d!.ctx).toMatchObject({ playerId: 't0-HS', coachId: coach.id });
    expect(d!.choices.map((c) => c.id)).toEqual(['hire_as_coach', 'decline']);
    expect(state.history.seasons[0].retired).toContain('t0_HS');
    expect(getAdvanceBlockers(state).map((b) => b.code)).toContain('pending_decision');
  });

  it('最后一个赛季结算后游戏结束，不再开新赛季', () => {
    const state = freshState();
    state.settings.endTi = 9;
    startSeason(state, 9);
    state.roundIndex = R + 2;
    state.phase = 'ti';
    settleSeason(state);
    expect(state.gameOver?.reason).toBe('completed');
    expect(state.season.ti).toBe(9);
    expect(state.phase).toBe('season_end');
  });
});

describe('season: 阵容与存档整理', () => {
  it('只填补首发空位，不改动已有安排', () => {
    const state = freshState();
    const team = state.teams.t0;
    const sub = makePlayer({ id: 'sub-c', position: 'C', power: 60, teamId: 't0' });
    const subHs = makePlayer({ id: 'sub-hs', position: 'HS', power: 90, teamId: 't0' });
    state.players[sub.id] = sub;
    state.players[subHs.id] = subHs;
    team.playerIds.push(sub.id, subHs.id);
    // 1 号位退役留下空位；2 号位指向已离队选手
    team.lineup.C = null;
    team.playerIds = team.playerIds.filter((id) => id !== 't0-C');
    Object.assign(state.players['t0-C'], { teamId: null, status: 'retired' });
    state.players['t0-M'].teamId = null;
    fillEmptyLineupSlots(state, 't0');
    expect(team.lineup.C).toBe('sub-c');
    expect(team.lineup.M).toBe('sub-hs');
    expect(team.lineup.HS).toBe('t0-HS'); // 更强的替补不会挤掉现有首发
  });

  it('赛事阵容兜底：签证受阻的首发由同位置替补顶上，其余安排（含玩家的错位安排）保持不变', () => {
    const state = freshState();
    const team = state.teams.t0;
    const sub = makePlayer({ id: 'sub-m', position: 'M', power: 40, teamId: 't0' });
    state.players[sub.id] = sub;
    team.playerIds.push(sub.id);
    // 玩家把 1 号位与 3 号位互换（非最优，但应被尊重）
    team.lineup.C = 't0-O';
    team.lineup.O = 't0-C';
    state.players['t0-M'].unavailableTournamentIds = ['cup'];
    expect(ensurePlayableLineup(state, 'cup')).toEqual([]);
    expect(team.lineup.M).toBe('sub-m');
    expect(team.lineup.C).toBe('t0-O');
    expect(team.lineup.O).toBe('t0-C');
    // 不指定赛事时，签证受阻不算空位
    team.lineup.M = 't0-M';
    fillEmptyLineupSlots(state, 't0');
    expect(team.lineup.M).toBe('t0-M');
  });

  it('赛季初清理退役程序化选手，保留真实选手/玩家旧部/转任教练者', () => {
    const state = freshState();
    const mk = (id: string, over: Partial<Player>) => {
      state.players[id] = makePlayer({ id, status: 'retired', teamId: null, ...over });
    };
    mk('gen-old', { isReal: false, lastTeamId: 't1' });
    mk('real-old', { isReal: true, lastTeamId: 't1' });
    mk('my-old', { isReal: false, lastTeamId: 't0' });
    mk('coach-old', { isReal: false, lastTeamId: 't2' });
    state.coaches.cc = makeCoach({ id: 'cc', formerPlayerId: 'coach-old' });
    startSeason(state, 9);
    expect(state.players['gen-old']).toBeUndefined();
    expect(state.players['real-old']).toBeDefined();
    expect(state.players['my-old']).toBeDefined();
    expect(state.players['coach-old']).toBeDefined();
    expect(state.players['t0-C']).toBeDefined();
  });

  it('往届赛事：更早赛季删除、上赛季压缩 AI 对局', () => {
    const state = freshState();
    const game = { winner: 'A', live: [{ minute: 1 }] };
    const mkT = (id: string, season: number, teamA: string) => {
      state.tournaments[id] = {
        id, season, status: 'finished',
        series: { s: { id: 's', teamA, teamB: 't3', result: { games: [{ ...game, live: [...game.live] }] } } },
      } as unknown as Tournament;
    };
    mkT('old', 7, 't1');
    mkT('prev-ai', 8, 't1');
    mkT('prev-me', 8, 't0');
    startSeason(state, 9);
    expect(state.tournaments.old).toBeUndefined();
    expect(state.tournaments['prev-ai'].series.s.result!.games).toEqual([]);
    const mine = state.tournaments['prev-me'].series.s.result!.games;
    expect(mine).toHaveLength(1);
    expect(mine[0].live).toEqual([]);
  });
});

describe('season: 教练市场容量（第六波）', () => {
  it('自由教练超过上限时按等级/灵性保留最好的；超龄退出；在队/待决策/玩家旧部保留', () => {
    const state = freshState();
    const max = CONFIG.coach.freePoolMax;
    const tiers = ['C', 'B', 'A', 'S', 'SS'] as const;
    for (let i = 0; i < max + 25; i++) {
      const c = makeCoach({ id: `fc${i}`, teamId: null, tier: tiers[i % tiers.length], insight: 40 + (i % 50), birthYear: state.season.year - 35 });
      state.coaches[c.id] = c;
    }
    // 超龄教练
    const old = makeCoach({ id: 'old', teamId: null, tier: 'SSR', insight: 99, birthYear: state.season.year - CONFIG.coach.retireAge - 1 });
    state.coaches.old = old;
    // 在队教练、待决策引用的教练、玩家旧部转任的教练
    state.coaches.hired = makeCoach({ id: 'hired', teamId: 't1', tier: 'C', insight: 1 });
    state.coaches.pending = makeCoach({ id: 'pending', teamId: null, tier: 'C', insight: 1 });
    state.pendingDecisions.push({
      id: 'd-r', kind: 'retire', title: 't', body: 'b', choices: [{ id: 'x', label: 'x' }], ctx: { coachId: 'pending' }, createdRound: 0, blocking: true,
    });
    const former = makePlayer({ id: 'former', status: 'retired', lastTeamId: 't0' });
    state.players.former = former;
    state.coaches.alumni = makeCoach({ id: 'alumni', teamId: null, tier: 'C', insight: 1, formerPlayerId: 'former' });

    pruneCoachPool(state);
    const free = Object.values(state.coaches).filter((c) => !c.teamId && !['pending', 'alumni'].includes(c.id));
    expect(free.length).toBe(max);
    expect(state.coaches.old).toBeUndefined();
    expect(state.coaches.hired).toBeDefined();
    expect(state.coaches.pending).toBeDefined();
    expect(state.coaches.alumni).toBeDefined();
    // 保留的是高等级教练：被删掉的教练等级不高于任何保留者
    const keptMin = Math.min(...free.map((c) => tiers.indexOf(c.tier as (typeof tiers)[number])));
    expect(keptMin).toBeGreaterThanOrEqual(1);
  });
});
