// 测试夹具：不依赖任何待实现模块，手工构造最小可用 GameState
import type { GameState, Player, Position, Region, Team, Coach } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { SAVE_VERSION } from '../src/engine/config';
import { ROLE_DATA_VERSION } from '../src/engine/roles';

let counter = 0;

export function makePlayer(over: Partial<Player> = {}): Player {
  counter += 1;
  const id = over.id ?? `p${counter}`;
  return {
    id,
    handle: over.handle ?? `Player${counter}`,
    nationality: 'CN',
    region: 'CN',
    birthYear: 1998,
    position: 'C',
    mmr: 9000,
    power: 75,
    talent: 60,
    resilience: 50,
    insight: 60,
    loyalty: 70,
    salary: 8000,
    contractUntil: 12,
    teamId: null,
    status: 'active',
    modifiers: [],
    signatureHeroes: [],
    stats: { matches: 0, wins: 0, titles: 0, tiTitles: 0, mvp: 0 },
    joinedSeason: 9,
    isReal: false,
    ...over,
  };
}

export function makeCoach(over: Partial<Coach> = {}): Coach {
  counter += 1;
  return {
    id: over.id ?? `c${counter}`,
    name: `Coach${counter}`,
    nationality: 'CN',
    birthYear: 1985,
    tier: 'S',
    insight: 80,
    talentBoost: 6,
    resilienceBoost: 6,
    salary: 6000,
    teamId: null,
    ...over,
  };
}

/** 构造一支 5 人战队并注册到 state */
export function addTeam(
  state: GameState,
  id: string,
  opts: { power?: number; mmr?: number; region?: Region; isPlayer?: boolean; honor?: number; gold?: number } = {},
): Team {
  const team: Team = {
    id,
    name: `Team ${id}`,
    tag: id.toUpperCase().slice(0, 4),
    region: opts.region ?? 'CN',
    color: '#888888',
    honor: opts.honor ?? 300,
    gold: opts.gold ?? 1_000_000,
    isPlayer: !!opts.isPlayer,
    playerIds: [],
    lineup: { C: null, M: null, O: null, SS: null, HS: null },
    coachId: null,
    points: 0,
  };
  state.teams[id] = team;
  POSITIONS.forEach((pos: Position, i) => {
    const p = makePlayer({
      id: `${id}-${pos}`,
      handle: `${id}_${pos}`,
      position: pos,
      power: opts.power ?? 75,
      mmr: opts.mmr ?? 9000,
      teamId: id,
      region: team.region,
      birthYear: 1996 + i,
    });
    state.players[p.id] = p;
    team.playerIds.push(p.id);
    team.lineup[pos] = p.id;
  });
  return team;
}

/** 最小 GameState：TI9 赛季（2019），preseason，含 N 支战队（第一支为玩家） */
export function makeTestState(teamCount = 8, seed = 12345): GameState {
  const state: GameState = {
    version: SAVE_VERSION,
    id: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    settings: {
      startTi: 9,
      seasons: 3,
      endTi: 11,
      difficulty: 'normal',
      playerTeamId: 't0',
      managerName: 'Tester',
    },
    rngState: seed,
    idCounter: 0,
    season: {
      ti: 9,
      year: 2019,
      startDate: '2018-09-01',
      tiStartDate: '2019-08-15',
      rounds: [],
      registeredTournamentIds: [],
      extraTrainingsBought: 0,
    },
    roundIndex: 0,
    phase: 'preseason',
    currentDate: '2018-09-01',
    currentPatch: '7.19',
    appliedPatches: ['7.19'],
    heroMeta: {},
    teams: {},
    players: {},
    coaches: {},
    tournaments: {},
    seasonTournamentIds: [],
    futureRookies: {},
    gachaPool: [],
    gachaPity: 0,
    transferOffers: [],
    tempSubCandidates: [],
    activeMatch: null,
    freeTrainingUsed: false,
    extraTrainingAvailable: 0,
    extraTrainingBoughtThisRound: 0,
    trainingFocus: 'balanced',
    beefs: [],
    pendingDecisions: [],
    news: [],
    finance: [],
    history: { tournaments: [], seasons: [], honor: [], gold: [], playerSettlements: [] },
    popups: [],
    gameOver: null,
    roleDataVersion: ROLE_DATA_VERSION, // 与新游戏一致：无需真实生涯位置迁移
  };
  for (let i = 0; i < teamCount; i++) {
    addTeam(state, `t${i}`, { isPlayer: i === 0, power: 70 + i, region: (['CN', 'EU', 'CIS', 'SEA', 'NA', 'SA'] as Region[])[i % 6] });
  }
  return state;
}
