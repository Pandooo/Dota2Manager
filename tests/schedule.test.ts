import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState, RoundInfo, TiInfo, TournamentTemplate } from '../src/engine/types';
import { makeTestState } from './helpers';

// ---------------------------------------------------------------------------
// 依赖模块桩
// ---------------------------------------------------------------------------
vi.mock('../src/data/index', () => ({
  getTournamentTemplates: vi.fn(() => []),
  getTiInfo: vi.fn(() => { throw new Error('缺少 TI 数据'); }),
  lastTournamentDataSeason: vi.fn(() => 0),
}));
vi.mock('../src/engine/calendar', () => ({
  roundIndexForDate: (season: { rounds: RoundInfo[] }, date: string) => {
    let last = 1;
    for (const r of season.rounds) {
      if (r.phase !== 'regular') continue;
      last = r.index;
      if (date < r.endDate) return r.index;
    }
    return last;
  },
  regularRoundCount: (season: { rounds: RoundInfo[] }) => season.rounds.filter((r) => r.phase === 'regular').length || 18,
}));
vi.mock('../src/engine/team', () => ({
  teamRating: (state: GameState, id: string) => {
    const t = state.teams[id];
    if (!t) return 0;
    let s = 0;
    for (const pid of Object.values(t.lineup)) if (pid && state.players[pid]) s += state.players[pid].power;
    return s;
  },
}));
vi.mock('../src/engine/match', () => {
  const rating = (state: GameState, id: string) => {
    let s = 0;
    for (const pid of Object.values(state.teams[id]?.lineup ?? {})) if (pid && state.players[pid]) s += state.players[pid].power;
    return s;
  };
  return {
    simulateSeries: (state: GameState, series: { teamA: string; teamB: string; bestOf: number }) => {
      const a = series.teamA;
      const b = series.teamB;
      const need = series.bestOf === 2 ? 2 : Math.floor(series.bestOf / 2) + 1;
      const aWins = rating(state, a) >= rating(state, b);
      return aWins
        ? { winnerId: a, loserId: b, scoreA: need, scoreB: 0, games: [] }
        : { winnerId: b, loserId: a, scoreA: 0, scoreB: need, games: [] };
    },
    applySeriesLoyalty: () => {},
  };
});
vi.mock('../src/engine/economy', () => ({
  addFinance: (state: GameState, teamId: string, amount: number) => {
    const t = state.teams[teamId];
    if (t) t.gold += Math.round(amount);
  },
  econ: () => 1,
  econIndex: () => 1,
}));
vi.mock('../src/engine/growth', () => ({ applyTournamentGrowth: () => [], adjustLoyalty: () => {} }));
vi.mock('../src/engine/market', () => ({ releaseTempSubs: () => {} }));

import * as data from '../src/data/index';
import {
  buildSeasonTournaments, cloneTemplatesForFutureSeason, computePlayerEntryStatus, isFillerCup, playerTournamentInRound,
  registerForTournament, roundCounts, seasonStandings, setupTiPhase, startRoundTournaments, unregisterFromTournament,
} from '../src/engine/schedule';
import { finishTournament, simulateTournamentToEnd } from '../src/engine/tournament';
import { CONFIG } from '../src/engine/config';

// ---------------------------------------------------------------------------
// 夹具：6 个常规回合（每回合 ~50 天）+ TI 预选(7) + TI(8)
// ---------------------------------------------------------------------------
const R = 6;
function buildRounds(): RoundInfo[] {
  const ends = ['2018-10-20', '2018-12-10', '2019-01-30', '2019-03-20', '2019-05-10', '2019-07-10'];
  const rounds: RoundInfo[] = [{ index: 0, phase: 'preseason', startDate: '2018-09-01', endDate: '2018-09-01', tournamentIds: [], patchVersions: [] }];
  let prev = '2018-09-01';
  ends.forEach((end, i) => {
    rounds.push({ index: i + 1, phase: 'regular', startDate: prev, endDate: end, tournamentIds: [], patchVersions: [] });
    prev = end;
  });
  rounds.push({ index: R + 1, phase: 'ti_qualifier', startDate: '2019-07-10', endDate: '2019-08-15', tournamentIds: [], patchVersions: [] });
  rounds.push({ index: R + 2, phase: 'ti', startDate: '2019-08-15', endDate: '2019-08-25', tournamentIds: [], patchVersions: [] });
  return rounds;
}

function tpl(over: Partial<TournamentTemplate> & { id: string; startDate: string }): TournamentTemplate {
  return {
    seriesId: over.id.replace(/-\d{4}$/, ''), name: over.id, tier: 'minor', endDate: over.startDate, city: '城市',
    hostRegion: 'EU', prizePool: 300000, teams: 8, invites: 4, format: 'de8', ...over,
  };
}

const TEMPLATES: TournamentTemplate[] = [
  tpl({ id: 'big-major-2018', name: 'Big Major 2018', tier: 'major', startDate: '2018-10-05', teams: 8, invites: 4, format: 'groups_de' }),
  tpl({ id: 'small-minor-2018', name: 'Small Minor 2018', tier: 'minor', startDate: '2018-10-08', teams: 8, invites: 4 }),
  tpl({ id: 'eu-league-2019', name: 'EU League 2019', tier: 'premier', startDate: '2019-01-05', teams: 6, invites: 2, regionLocked: 'EU', format: 'rr' }),
  tpl({ id: 'spring-cup-2019', name: 'Spring Cup 2019', tier: 'minor', startDate: '2019-02-10', teams: 8, invites: 0 }),
  tpl({ id: 'spring-open-2019', name: 'Spring Open 2019', tier: 'minor', startDate: '2019-02-20', teams: 8, invites: 0, format: 'se8' }),
  tpl({ id: 'elite-2019', name: 'Elite 2019', tier: 'major', startDate: '2019-04-01', teams: 8, invites: 0 }),
];

const TI9: TiInfo = {
  ti: 9, year: 2019, name: 'The International 2019', city: '上海', country: 'CN', hostRegion: 'CN',
  startDate: '2019-08-15', endDate: '2019-08-25', prizePool: 30_000_000, teams: 8, directInvites: 4,
  qualifierSlots: { CN: 2, EU: 2 },
};

function setup(teamCount = 16): GameState {
  const state = makeTestState(teamCount);
  state.season.rounds = buildRounds();
  state.season.tiStartDate = '2019-08-15';
  Object.values(state.teams).forEach((t, i) => { t.lastSeasonRank = i + 1; });
  return state;
}

/** 本赛季非补位赛事 / 补位线上公开赛 */
const realIds = (state: GameState) => state.seasonTournamentIds.filter((id) => !isFillerCup(state.tournaments[id]));
const fillerIds = (state: GameState) => state.seasonTournamentIds.filter((id) => isFillerCup(state.tournaments[id]));

beforeEach(() => {
  vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? TEMPLATES.slice() : []));
  vi.mocked(data.lastTournamentDataSeason).mockReturnValue(9);
  vi.mocked(data.getTiInfo).mockImplementation((ti: number) => {
    if (ti === 9) return TI9;
    throw new Error('缺少 TI 数据');
  });
});

// ---------------------------------------------------------------------------
describe('cloneTemplatesForFutureSeason', () => {
  it('复制最近有数据赛季：日期/名称/id 按年份平移', () => {
    const out = cloneTemplatesForFutureSeason(11); // 2022 - 2019 = 3 年
    expect(out.length).toBe(TEMPLATES.length);
    const major = out.find((t) => t.seriesId === 'big-major')!;
    expect(major.id).toBe('big-major-2021');
    expect(major.name).toBe('Big Major 2021');
    expect(major.startDate).toBe('2021-10-05');
    expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
  });
  it('无年份的系列名：届数按「本系列届数」递增，不与往届重名', () => {
    vi.mocked(data.lastTournamentDataSeason).mockReturnValue(15);
    const src: TournamentTemplate[] = [
      tpl({ id: 'pgl-wallachia-6', seriesId: 'pgl-wallachia', name: 'PGL Wallachia Season 6', startDate: '2025-11-15' }),
      tpl({ id: 'pgl-wallachia-7', seriesId: 'pgl-wallachia', name: 'PGL Wallachia Season 7', startDate: '2026-03-07' }),
      tpl({ id: 'blast-slam-4', seriesId: 'blast-slam', name: 'BLAST Slam IV', startDate: '2025-10-14' }),
      tpl({ id: 'blast-slam-5', seriesId: 'blast-slam', name: 'BLAST Slam V', startDate: '2025-11-25' }),
      tpl({ id: 'fissure-universe-7', seriesId: 'fissure-universe', name: 'FISSURE Universe: Episode 7', startDate: '2025-10-05' }),
      tpl({ id: 'premier-series-1', seriesId: 'premier-series', name: 'PREMIER SERIES', startDate: '2026-04-01' }),
      tpl({ id: '1win-essence-1', seriesId: '1win-essence', name: '1win Essence I', startDate: '2026-05-02' }),
      tpl({ id: 'dl-div2-3', seriesId: 'dl-div2', name: 'DreamLeague Division 2 Season 3', startDate: '2026-02-04' }),
      tpl({ id: 'ewc-2026', seriesId: 'ewc', name: 'Esports World Cup 2026', startDate: '2026-07-07' }),
    ];
    vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 15 ? src.slice() : []));
    const out = cloneTemplatesForFutureSeason(16);
    const names = out.map((t) => t.name).sort();
    expect(names).toEqual([
      '1win Essence II', 'BLAST Slam VI', 'BLAST Slam VII', 'DreamLeague Division 2 Season 4', 'Esports World Cup 2027',
      'FISSURE Universe: Episode 8', 'PGL Wallachia Season 8', 'PGL Wallachia Season 9', 'PREMIER SERIES 2027',
    ].sort());
    const prev = new Set(src.map((t) => t.name));
    for (const t of out) expect(prev.has(t.name)).toBe(false);
    expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
  });
  it('无任何赛季数据 → 内置通用赛历（约 12 项，覆盖多等级/赛区）', () => {
    vi.mocked(data.lastTournamentDataSeason).mockReturnValue(0);
    const out = cloneTemplatesForFutureSeason(16);
    expect(out.length).toBeGreaterThanOrEqual(10);
    expect(new Set(out.map((t) => t.tier)).size).toBeGreaterThanOrEqual(3);
    expect(out.some((t) => t.regionLocked)).toBe(true);
    for (const t of out) {
      expect(t.teams).toBeGreaterThanOrEqual(4);
      expect(t.teams).toBeLessThanOrEqual(24);
      expect(t.startDate >= '2026-09-01' && t.startDate <= '2027-08-01').toBe(true);
    }
  });
});

describe('buildSeasonTournaments', () => {
  it('生成实例、受邀、同回合冲突只保留高等级、TI 实例', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    const minor = state.tournaments['small-minor-2018'];
    expect(major.roundIndex).toBe(1);
    expect(minor.roundIndex).toBe(1);
    expect(major.invitedTeamIds).toEqual(['t0', 't1', 't2', 't3']);
    expect(major.playerStatus).toBe('invited');
    expect(minor.playerStatus).toBe('declined');
    expect(state.season.registeredTournamentIds).toEqual(['big-major-2018']);
    expect(major.minHonor).toBe(CONFIG.tournament.minHonor.major);
    expect(major.appearanceFee).toBeGreaterThan(0);
    // 赛区锁定：只邀请本赛区
    const eu = state.tournaments['eu-league-2019'];
    expect(eu.invitedTeamIds.every((id) => state.teams[id].region === 'EU')).toBe(true);
    expect(eu.invitedTeamIds.length).toBe(2);
    expect(eu.playerStatus).toBe('locked');
    // TI
    const ti = state.tournaments['ti-9'];
    expect(ti.tier).toBe('ti');
    expect(ti.roundIndex).toBe(R + 2);
    expect(ti.prizePool).toBe(30_000_000);
    expect(state.season.rounds[R + 2].tournamentIds).toContain('ti-9');
    expect(state.season.rounds[1].tournamentIds).toEqual(expect.arrayContaining(['big-major-2018', 'small-minor-2018']));
    expect(realIds(state).length).toBe(TEMPLATES.length + 1);
  });
  it('重复调用幂等', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const fillers = fillerIds(state).length;
    buildSeasonTournaments(state);
    expect(realIds(state).length).toBe(TEMPLATES.length + 1);
    expect(fillerIds(state).length).toBe(fillers);
    expect(state.season.rounds[1].tournamentIds.length).toBe(2);
    for (const r of state.season.rounds) expect(new Set(r.tournamentIds).size).toBe(r.tournamentIds.length);
  });
  it('无模板数据也能生成（通用赛历）', () => {
    const state = setup();
    vi.mocked(data.getTournamentTemplates).mockReturnValue([]);
    vi.mocked(data.lastTournamentDataSeason).mockReturnValue(0);
    buildSeasonTournaments(state);
    expect(state.seasonTournamentIds.length).toBeGreaterThan(5);
  });
});

describe('线上公开赛（补位）', () => {
  it('玩家无赛可打的常规回合补一项开放报名的线上赛：无赛事 / 赛区锁定 / 荣誉不足', () => {
    const state = setup();
    state.teams.t0.honor = 100; // Elite Major（第 5 回合）荣誉不足
    buildSeasonTournaments(state);
    const fillers = fillerIds(state).map((id) => state.tournaments[id]);
    // 第 1 回合受邀 Major、第 4 回合两项 Minor 可报名；2（无赛事）、3（EU 锁定）、5（荣誉不足）、6（无赛事）补位
    expect(fillers.map((t) => t.roundIndex).sort()).toEqual([2, 3, 5, 6]);
    for (const t of fillers) {
      expect(t.playerStatus).toBe('open');
      expect(computePlayerEntryStatus(state, t)).toBe('open');
      expect(t.invitedTeamIds).toEqual([]);
      expect(t.minHonor).toBe(0);
      expect(t.online).toBe(true);
      expect(t.regionLocked).toBeUndefined();
      expect(t.size).toBe(CONFIG.tournament.fillerCup.teams);
      expect(t.season).toBe(9);
      expect(state.season.rounds[t.roundIndex].tournamentIds).toContain(t.id);
      const r = state.season.rounds[t.roundIndex];
      expect(t.startDate >= r.startDate && t.startDate < r.endDate).toBe(true);
      expect(t.name).toMatch(/线上公开赛/);
      expect(t.noCircuitPoints).toBe(true);
    }
    // 每个常规回合都至少有一项可参加的赛事
    for (let r = 1; r <= R; r++) {
      const ok = state.seasonTournamentIds.map((id) => state.tournaments[id])
        .some((t) => t.roundIndex === r && ['open', 'invited', 'registered'].includes(computePlayerEntryStatus(state, t)));
      expect(ok).toBe(true);
    }
    expect(state.news.some((n) => n.title.includes('线上公开赛'))).toBe(true);
  });
  it('荣誉仅勉强够门槛的回合也补位（赛季中荣誉波动后仍有赛可打）', () => {
    const state = setup();
    state.teams.t0.honor = CONFIG.tournament.minHonor.major + 10; // Elite Major 可报名，但余量不足
    buildSeasonTournaments(state);
    expect(state.tournaments['elite-2019'].playerStatus).toBe('open');
    expect(fillerIds(state).map((id) => state.tournaments[id].roundIndex)).toContain(5);
    state.teams.t0.honor = CONFIG.tournament.minHonor.major + CONFIG.tournament.fillerCup.honorMargin;
    buildSeasonTournaments(state);
    expect(fillerIds(state).map((id) => state.tournaments[id].roundIndex)).not.toContain(5);
  });
  it('补位赛事不发邀请（含高荣誉 AI），玩家报名走封闭预选，与同回合其他赛事不重复参赛', () => {
    const state = setup(30);
    state.teams.t0.honor = 100;
    state.teams.t5.honor = 5000; // 高于所有 inviteHonor
    buildSeasonTournaments(state);
    const filler = fillerIds(state).map((id) => state.tournaments[id]).find((t) => t.roundIndex === 5)!;
    expect(filler).toBeTruthy();
    expect(filler.invitedTeamIds).toEqual([]);
    expect(state.tournaments['elite-2019'].invitedTeamIds).toContain('t5');
    expect(registerForTournament(state, filler.id).ok).toBe(true);
    startRoundTournaments(state, 5);
    const elite = state.tournaments['elite-2019'];
    expect(elite.status).toBe('running');
    expect(filler.status).toBe('running');
    expect(filler.qualifierTeamIds).toContain('t0');
    const a = new Set([...elite.teamIds, ...elite.qualifierTeamIds]);
    const b = [...filler.teamIds, ...filler.qualifierTeamIds];
    expect(b.some((id) => a.has(id))).toBe(false);
    expect(new Set(b).size).toBe(b.length);
    simulateTournamentToEnd(state, filler.id);
    finishTournament(state, filler.id);
    expect(filler.settlement).toBeTruthy();
    // 只发奖金，不计巡回赛积分
    expect(filler.placements.every((p) => p.points === 0)).toBe(true);
    expect(filler.placements.find((p) => p.rankFrom === 1)!.prize).toBeGreaterThan(0);
    for (const id of [...filler.teamIds, ...filler.qualifierTeamIds]) expect(state.teams[id].points).toBe(0);
  });
  it('规模按同回合空闲队伍估算；大赛占满全部战队的回合不补位', () => {
    const state = setup(16); // 玩家 + 15 支 AI
    state.teams.t0.honor = 100; // Major 荣誉门槛 250 → 锁定
    vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? [
      tpl({ id: 'full-major-2018', tier: 'major', startDate: '2018-11-01', teams: 16, invites: 0 }), // 第 2 回合：15 队全被占用
      tpl({ id: 'mid-major-2019', tier: 'major', startDate: '2019-01-05', teams: 12, invites: 0 }), // 第 3 回合：剩 3 队
    ] : []));
    buildSeasonTournaments(state);
    const byRound = new Map(fillerIds(state).map((id) => [state.tournaments[id].roundIndex, state.tournaments[id]]));
    expect(byRound.has(2)).toBe(false);
    expect(byRound.get(3)?.size).toBe(4);
    expect(byRound.get(1)?.size).toBe(CONFIG.tournament.fillerCup.teams);
  });
  it('高荣誉战队每回合都有受邀/可报名赛事时不补位；无玩家战队时不补位', () => {
    const state = setup();
    state.teams.t0.honor = 600;
    vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? [
      ...TEMPLATES,
      tpl({ id: 'r2-cup-2018', startDate: '2018-11-01', invites: 0 }),
      tpl({ id: 'r3-cup-2019', startDate: '2018-12-20', invites: 0 }),
      tpl({ id: 'r6-cup-2019', startDate: '2019-06-01', invites: 0 }),
    ] : []));
    buildSeasonTournaments(state);
    expect(fillerIds(state)).toEqual([]);
    const none = setup();
    none.settings.playerTeamId = 'nobody';
    buildSeasonTournaments(none);
    expect(fillerIds(none)).toEqual([]);
  });
});

describe('报名规则', () => {
  it('open → registered；同回合冲突、受邀不可退、赛区/荣誉锁定、TI 不可报名、开赛后不可改', () => {
    const state = setup();
    state.teams.t0.honor = 100;
    buildSeasonTournaments(state);
    const cup = state.tournaments['spring-cup-2019'];
    const open = state.tournaments['spring-open-2019'];
    expect(cup.roundIndex).toBe(open.roundIndex);
    expect(computePlayerEntryStatus(state, cup)).toBe('open');

    expect(registerForTournament(state, cup.id).ok).toBe(true);
    expect(cup.playerStatus).toBe('registered');
    expect(registerForTournament(state, cup.id).ok).toBe(false);
    const clash = registerForTournament(state, open.id);
    expect(clash.ok).toBe(false);
    expect(clash.message).toContain('同一回合');

    expect(unregisterFromTournament(state, 'ti-9').ok).toBe(false); // TI 必须参加
    expect(registerForTournament(state, 'eu-league-2019').ok).toBe(false); // 赛区锁定
    const elite = state.tournaments['elite-2019'];
    expect(elite.playerStatus).toBe('locked'); // 荣誉 100 < major 门槛
    expect(registerForTournament(state, elite.id).message).toContain('荣誉不足');
    expect(registerForTournament(state, 'ti-9').ok).toBe(false);

    expect(unregisterFromTournament(state, cup.id).ok).toBe(true);
    expect(cup.playerStatus).toBe('open');
    expect(state.season.registeredTournamentIds).not.toContain(cup.id);
    expect(registerForTournament(state, open.id).ok).toBe(true);

    // 赛事所在回合已到 → 不可再改
    state.roundIndex = open.roundIndex;
    state.phase = 'regular';
    expect(unregisterFromTournament(state, open.id).ok).toBe(false);
    expect(registerForTournament(state, cup.id).ok).toBe(false);
  });
  it('playerTournamentInRound / roundCounts', () => {
    const state = setup();
    buildSeasonTournaments(state);
    expect(playerTournamentInRound(state, 1)?.id).toBe('big-major-2018');
    expect(playerTournamentInRound(state, 2)).toBeNull();
    const c = roundCounts(state);
    expect(c.total).toBe(R + 2);
    // 受邀 Major 1 个 + TI 阶段未定（2 个）
    expect(c.tournamentRounds).toBe(3);
    expect(c.restRounds).toBe(c.total - 3);
  });
});

describe('婉拒邀请 / 重新接受', () => {
  it('受邀 → 婉拒（无荣誉惩罚、新闻、不再计入赛事回合）→ 重新接受', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    expect(major.playerStatus).toBe('invited');
    expect(roundCounts(state).tournamentRounds).toBe(3);
    const honor = state.teams.t0.honor;
    const gold = state.teams.t0.gold;

    const res = unregisterFromTournament(state, major.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('婉拒');
    expect(major.playerStatus).toBe('declined');
    expect(computePlayerEntryStatus(state, major)).toBe('declined');
    expect(state.season.registeredTournamentIds).not.toContain(major.id);
    expect(major.invitedTeamIds).toContain('t0'); // 仍在受邀名单中，可重新接受
    expect(state.teams.t0.honor).toBe(honor);
    expect(state.teams.t0.gold).toBe(gold);
    expect(state.news[0].title).toContain('【婉拒邀请】');
    expect(playerTournamentInRound(state, 1)).toBeNull();
    expect(roundCounts(state).tournamentRounds).toBe(2);
    // 重复婉拒 → 失败
    expect(unregisterFromTournament(state, major.id).ok).toBe(false);

    const back = registerForTournament(state, major.id);
    expect(back.ok).toBe(true);
    expect(major.playerStatus).toBe('invited');
    expect(computePlayerEntryStatus(state, major)).toBe('invited');
    expect(state.season.registeredTournamentIds).toContain(major.id);
    expect(playerTournamentInRound(state, 1)?.id).toBe(major.id);
    expect(roundCounts(state).tournamentRounds).toBe(3);
    // 已受邀 → 再次报名失败
    expect(registerForTournament(state, major.id).ok).toBe(false);
  });

  it('同回合冲突：自动婉拒的邀请需先婉拒保留的那项才能改打；已报名的开放赛事需先取消', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    const minor = state.tournaments['small-minor-2018'];
    expect(state.news.some((n) => n.title.includes('【婉拒邀请】') && n.title.includes(minor.name))).toBe(true);

    const clash = registerForTournament(state, minor.id);
    expect(clash.ok).toBe(false);
    expect(clash.message).toContain('同一回合');
    expect(clash.message).toContain(major.name);
    expect(clash.message).toContain('婉拒');
    expect(minor.playerStatus).toBe('declined');

    // 切换：婉拒 Major → 接受 Minor
    expect(unregisterFromTournament(state, major.id).ok).toBe(true);
    expect(registerForTournament(state, minor.id).ok).toBe(true);
    expect(minor.playerStatus).toBe('invited');
    expect(playerTournamentInRound(state, 1)?.id).toBe(minor.id);
    const back = registerForTournament(state, major.id);
    expect(back.ok).toBe(false);
    expect(back.message).toContain(minor.name);
    expect(major.playerStatus).toBe('declined');

    // 婉拒邀请后报名同回合的开放赛事 → 重新接受邀请需先取消该报名
    const s2 = setup();
    vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? [
      tpl({ id: 'inv-premier-2019', tier: 'premier', startDate: '2019-02-10', invites: 4 }),
      tpl({ id: 'open-minor-2019', tier: 'minor', startDate: '2019-02-20', invites: 0 }),
    ] : []));
    buildSeasonTournaments(s2);
    const prem = s2.tournaments['inv-premier-2019'];
    const open = s2.tournaments['open-minor-2019'];
    expect(prem.roundIndex).toBe(open.roundIndex);
    expect(prem.playerStatus).toBe('invited');
    expect(registerForTournament(s2, open.id).message).toContain('同一回合');
    expect(unregisterFromTournament(s2, prem.id).ok).toBe(true);
    expect(registerForTournament(s2, open.id).ok).toBe(true);
    expect(open.playerStatus).toBe('registered');
    const re = registerForTournament(s2, prem.id);
    expect(re.ok).toBe(false);
    expect(re.message).toContain('取消该报名');
    expect(unregisterFromTournament(s2, open.id).ok).toBe(true);
    expect(registerForTournament(s2, prem.id).ok).toBe(true);
    expect(prem.playerStatus).toBe('invited');
    expect(roundCounts(s2).tournamentRounds).toBe(3);
  });

  it('婉拒后开赛：玩家不在任何参赛名单中，空出的席位由 AI 递补', () => {
    const state = setup(20);
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    const minor = state.tournaments['small-minor-2018'];
    expect(unregisterFromTournament(state, major.id).ok).toBe(true);
    startRoundTournaments(state, 1);
    expect(major.status).toBe('running');
    expect(minor.status).toBe('running');
    expect(major.teamIds.length).toBe(8);
    expect(minor.teamIds.length).toBe(8);
    for (const t of [major, minor]) {
      expect(t.teamIds).not.toContain('t0');
      expect(t.qualifierTeamIds).not.toContain('t0');
      expect(t.playerStatus).toBe('declined');
    }
    expect(major.teamIds).toEqual(expect.arrayContaining(['t1', 't2', 't3'])); // 其余受邀队照常参赛
    expect(minor.teamIds.some((id) => major.teamIds.includes(id))).toBe(false);
    expect(playerTournamentInRound(state, 1)).toBeNull();
    // 开赛后不能再改
    expect(registerForTournament(state, major.id).ok).toBe(false);
    expect(unregisterFromTournament(state, major.id).ok).toBe(false);
  });

  it('改打低等级邀请：开赛时玩家进入 Minor 正赛（受邀免预选），Major 由 AI 补满', () => {
    const state = setup(20);
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    const minor = state.tournaments['small-minor-2018'];
    expect(unregisterFromTournament(state, major.id).ok).toBe(true);
    expect(registerForTournament(state, minor.id).ok).toBe(true);
    startRoundTournaments(state, 1);
    expect(minor.teamIds).toContain('t0');
    expect(minor.qualifierTeamIds).toEqual([]);
    expect(minor.teamIds.length).toBe(8);
    expect(major.teamIds).not.toContain('t0');
    expect(major.teamIds.length).toBe(8);
    expect(playerTournamentInRound(state, 1)?.id).toBe(minor.id);
  });

  it('所在回合已到（未开赛）也不能再婉拒/重新接受', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    const minor = state.tournaments['small-minor-2018'];
    state.roundIndex = 1;
    state.phase = 'regular';
    const res = unregisterFromTournament(state, major.id);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('已开赛');
    expect(major.playerStatus).toBe('invited');
    expect(registerForTournament(state, minor.id).ok).toBe(false);
    expect(minor.playerStatus).toBe('declined');
  });

  it('TI 与 TI 赛区预选赛必须参加：不可婉拒，也不可手动报名', () => {
    const state = setup(24);
    buildSeasonTournaments(state);
    Object.values(state.teams).forEach((t, i) => { t.points = i * 100; });
    setupTiPhase(state);
    const cn = state.tournaments['tiq-9-CN'];
    expect(cn.playerStatus).toBe('invited');
    const res = unregisterFromTournament(state, cn.id);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('必须参加');
    expect(cn.playerStatus).toBe('invited');
    expect(state.season.registeredTournamentIds).toContain(cn.id);
    expect(computePlayerEntryStatus(state, cn)).toBe('invited');
    expect(registerForTournament(state, cn.id).ok).toBe(false);

    const s2 = setup(16);
    buildSeasonTournaments(s2);
    s2.teams.t0.points = 99999;
    setupTiPhase(s2);
    const ti = s2.tournaments['ti-9'];
    expect(ti.playerStatus).toBe('invited');
    const r2 = unregisterFromTournament(s2, ti.id);
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('必须参加');
    expect(ti.playerStatus).toBe('invited');
    expect(computePlayerEntryStatus(s2, ti)).toBe('invited');
  });

  it('非法输入返回中文错误而不是抛错', () => {
    const state = setup();
    buildSeasonTournaments(state);
    expect(unregisterFromTournament(state, 'nope').ok).toBe(false);
    expect(registerForTournament(state, 'nope').ok).toBe(false);
    expect(unregisterFromTournament(state, 'spring-cup-2019').message).toContain('尚未报名');
  });

  it('未参加的 TI 阶段赛事：婉拒提示「尚未获得参赛资格」而不是「必须参加」', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const res = unregisterFromTournament(state, 'ti-9');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('尚未获得');
    expect(res.message).not.toContain('必须参加');
  });

  it('受邀后荣誉跌破门槛：邀请仍有效，可婉拒后重新接受', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const major = state.tournaments['big-major-2018'];
    expect(major.playerStatus).toBe('invited');
    expect(unregisterFromTournament(state, major.id).ok).toBe(true);
    state.teams.t0.honor = 10; // < major 门槛
    const back = registerForTournament(state, major.id);
    expect(back.ok).toBe(true);
    expect(major.playerStatus).toBe('invited');
  });

  it('不在受邀名单中的「已婉拒」（旧存档等）→ 按普通报名处理：荣誉/赛区校验后变为 registered', () => {
    const state = setup();
    state.teams.t0.honor = 100;
    buildSeasonTournaments(state);
    const cup = state.tournaments['spring-cup-2019'];
    expect(cup.invitedTeamIds).not.toContain('t0');
    cup.playerStatus = 'declined';
    expect(computePlayerEntryStatus(state, cup)).toBe('declined');
    expect(unregisterFromTournament(state, cup.id).message).toContain('尚未报名');
    const res = registerForTournament(state, cup.id);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('封闭预选');
    expect(cup.playerStatus).toBe('registered');
    expect(state.season.registeredTournamentIds).toContain(cup.id);

    const elite = state.tournaments['elite-2019'];
    elite.playerStatus = 'declined';
    const locked = registerForTournament(state, elite.id);
    expect(locked.ok).toBe(false);
    expect(locked.message).toContain('荣誉不足');
    expect(elite.playerStatus).toBe('declined');
  });

  it('已结束（被取消）的已婉拒赛事：提示已结束，不可修改', () => {
    const state = setup();
    buildSeasonTournaments(state);
    const minor = state.tournaments['small-minor-2018'];
    expect(minor.playerStatus).toBe('declined');
    minor.status = 'finished';
    expect(unregisterFromTournament(state, minor.id).message).toContain('已结束');
    expect(registerForTournament(state, minor.id).message).toContain('已结束');
  });

  it('婉拒状态随存档持久化：导出/导入后仍为已婉拒，且可重新接受', async () => {
    const { exportSave, importSave } = await import('../src/engine/save');
    const state = setup();
    buildSeasonTournaments(state);
    expect(unregisterFromTournament(state, 'big-major-2018').ok).toBe(true);
    const loaded = importSave(exportSave(state));
    const major = loaded.tournaments['big-major-2018'];
    expect(major.playerStatus).toBe('declined');
    expect(loaded.season.registeredTournamentIds).not.toContain(major.id);
    expect(roundCounts(loaded).tournamentRounds).toBe(2);
    expect(registerForTournament(loaded, major.id).ok).toBe(true);
    expect(major.playerStatus).toBe('invited');
  });
});

describe('startRoundTournaments', () => {
  it('高等级先选、一队一回合只参加一项、受邀优先', () => {
    const state = setup(20);
    buildSeasonTournaments(state);
    startRoundTournaments(state, 1);
    const major = state.tournaments['big-major-2018'];
    const minor = state.tournaments['small-minor-2018'];
    expect(major.status).toBe('running');
    expect(minor.status).toBe('running');
    expect(major.teamIds.length).toBe(8);
    expect(major.teamIds).toEqual(expect.arrayContaining(['t0', 't1', 't2', 't3']));
    expect(minor.teamIds.length).toBe(8);
    expect(minor.teamIds.some((id) => major.teamIds.includes(id))).toBe(false);
    expect(minor.teamIds).not.toContain('t0');
    expect(major.expectedRank).toBeGreaterThanOrEqual(1);
    expect(Object.keys(major.expectedRanks ?? {}).length).toBe(8);
    expect(major.stages.length).toBeGreaterThan(0);
  });
  it('报名未受邀 → 封闭预选（玩家 + 7 支 AI，2 个名额）', () => {
    const state = setup(24);
    buildSeasonTournaments(state);
    const cup = state.tournaments['spring-cup-2019'];
    expect(registerForTournament(state, cup.id).ok).toBe(true);
    startRoundTournaments(state, cup.roundIndex);
    expect(cup.qualifierTeamIds[0]).toBe('t0');
    expect(cup.qualifierTeamIds.length).toBe(CONFIG.tournament.qualifierTeams);
    expect(cup.qualifierSlots).toBe(CONFIG.tournament.qualifierSlotsPerEvent);
    expect(cup.teamIds.length).toBe(8 - CONFIG.tournament.qualifierSlotsPerEvent);
    expect(cup.teamIds.some((id) => cup.qualifierTeamIds.includes(id))).toBe(false);
    expect(cup.stages[0].type).toBe('qualifier');
    simulateTournamentToEnd(state, cup.id);
    finishTournament(state, cup.id);
    expect(cup.placements.length).toBe(8 + 6);
    expect(cup.settlement).toBeTruthy();
  });
  it('赛区锁定赛事只取本赛区队伍；队伍不足时缩小规模', () => {
    const state = setup(16);
    buildSeasonTournaments(state);
    const eu = state.tournaments['eu-league-2019'];
    startRoundTournaments(state, eu.roundIndex);
    expect(eu.teamIds.every((id) => state.teams[id].region === 'EU')).toBe(true);
    expect(eu.teamIds.length).toBe(3); // 16 队中 EU 只有 t1/t7/t13
    expect(eu.status).toBe('running');
  });
});

describe('赛事取消', () => {
  it('参赛不足 2 队 → 取消：清空名单、撤销玩家报名（本回合按休赛处理）、清除不可用标记', () => {
    const state = setup(16);
    vi.mocked(data.getTournamentTemplates).mockImplementation((ti: number) => (ti === 9 ? [
      tpl({ id: 'cn-solo-2018', startDate: '2018-11-01', invites: 0, regionLocked: 'CN', format: 'rr' }),
    ] : []));
    buildSeasonTournaments(state);
    const solo = state.tournaments['cn-solo-2018'];
    expect(registerForTournament(state, solo.id).ok).toBe(true);
    // 其余 CN 战队（t6/t12）解散 → 只剩玩家
    state.teams.t6.disbanded = true;
    state.teams.t12.disbanded = true;
    state.players['t0-C'].unavailableTournamentIds = [solo.id];
    startRoundTournaments(state, solo.roundIndex);
    expect(solo.status).toBe('finished');
    expect(solo.teamIds).toEqual([]);
    expect(solo.qualifierTeamIds).toEqual([]);
    expect(solo.playerStatus).toBe('declined');
    expect(state.season.registeredTournamentIds).not.toContain(solo.id);
    expect(playerTournamentInRound(state, solo.roundIndex)?.id).not.toBe(solo.id);
    expect(state.players['t0-C'].unavailableTournamentIds).toBeUndefined();
    expect(state.news.some((n) => n.title.includes('取消'))).toBe(true);
  });
});

describe('TI 阶段', () => {
  it('积分榜直邀 + 玩家所在赛区预选（强制）→ 预选晋级写入 TI → TI 开赛', () => {
    const state = setup(24);
    buildSeasonTournaments(state);
    // 积分：t23 > t22 > … ；玩家 t0 积分 0
    Object.values(state.teams).forEach((t, i) => { t.points = i * 100; });
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    expect(ti.invitedTeamIds).toEqual(['t23', 't22', 't21', 't20']);
    expect(ti.playerStatus).toBe('locked');
    const cn = state.tournaments['tiq-9-CN'];
    const eu = state.tournaments['tiq-9-EU'];
    expect(cn).toBeTruthy();
    expect(eu).toBeTruthy();
    expect(cn.teamIds).toContain('t0');
    expect(cn.playerStatus).toBe('invited');
    expect(cn.roundIndex).toBe(R + 1);
    expect(cn.advanceToTi).toEqual({ tiId: 'ti-9', slots: 2 });
    // 无名额的 SEA 并入中国预选
    expect(cn.teamIds.every((id) => ['CN', 'SEA'].includes(state.teams[id].region))).toBe(true);
    expect(cn.teamIds.some((id) => state.teams[id].region === 'SEA')).toBe(true);
    expect(cn.name).toContain('中国');
    expect(cn.teamIds.length).toBeLessThanOrEqual(CONFIG.tournament.qualifierTeams);
    expect(playerTournamentInRound(state, R + 1)?.id).toBe('tiq-9-CN');
    expect(state.news.some((n) => n.title.includes('直邀名单'))).toBe(true);
    // 幂等
    setupTiPhase(state);
    expect(Object.keys(state.tournaments).filter((id) => id.startsWith('tiq-')).length).toBe(2);

    startRoundTournaments(state, R + 1);
    for (const id of ['tiq-9-CN', 'tiq-9-EU']) {
      simulateTournamentToEnd(state, id);
      finishTournament(state, id);
    }
    expect(ti.teamIds.length).toBe(8);
    startRoundTournaments(state, R + 2);
    expect(ti.status).toBe('running');
    expect(ti.teamIds.length).toBe(8);
    simulateTournamentToEnd(state, ti.id);
    finishTournament(state, ti.id);
    expect(ti.placements.length).toBe(8);
    expect(state.history.tournaments.at(-1)?.tier).toBe('ti');
  });
  it('无竞争的预选（报名队伍 ≤ 名额）连同名额并入邻近预选，不白送 TI 门票', () => {
    const state = setup(16);
    const info: TiInfo = { ...TI9, teams: 12, directInvites: 4, qualifierSlots: { CN: 2, EU: 2, SEA: 1, CIS: 1, NA: 1, SA: 1 } };
    vi.mocked(data.getTiInfo).mockImplementation(() => info);
    buildSeasonTournaments(state);
    Object.values(state.teams).forEach((t, i) => { t.points = i * 100; });
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    // CN 剩 t0/t6 争 2 个名额 → 并入东南亚预选（t3/t9），共 4 队争 3 个名额
    expect(state.tournaments['tiq-9-CN']).toBeUndefined();
    const sea = state.tournaments['tiq-9-SEA'];
    expect(sea.teamIds.sort()).toEqual(['t0', 't3', 't6', 't9']);
    expect(sea.advanceToTi?.slots).toBe(3);
    expect(sea.playerStatus).toBe('invited');
    expect(ti.teamIds).not.toContain('t0');
    // EU 同理并入独联体
    expect(state.tournaments['tiq-9-CIS'].advanceToTi?.slots).toBe(3);
    const quals = Object.values(state.tournaments).filter((t) => t.advanceToTi);
    for (const q of quals) expect(q.teamIds.length).toBeGreaterThan(q.advanceToTi!.slots);
    expect(quals.reduce((a, q) => a + q.advanceToTi!.slots, 0)).toBe(info.teams - info.directInvites);
    expect(state.news.some((n) => n.body.includes('并入'))).toBe(true);
  });
  it('无处可并的无竞争预选 → 全部直通 TI（玩家同样适用）', () => {
    const state = setup(4); // t0 CN · t1 EU · t2 CIS · t3 SEA
    vi.mocked(data.getTiInfo).mockImplementation(() => ({ ...TI9, teams: 4, directInvites: 2, qualifierSlots: { CN: 1, EU: 1 } }));
    buildSeasonTournaments(state);
    state.teams.t3.points = 300;
    state.teams.t2.points = 200;
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    expect(Object.values(state.tournaments).some((t) => t.advanceToTi)).toBe(false);
    expect(ti.teamIds.sort()).toEqual(['t0', 't1', 't2', 't3']);
    expect(ti.playerStatus).toBe('invited');
    expect(playerTournamentInRound(state, R + 2)?.id).toBe('ti-9');
  });
  it('玩家积分领先 → 直邀 TI，不参加任何预选', () => {
    const state = setup(16);
    buildSeasonTournaments(state);
    state.teams.t0.points = 99999;
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    expect(ti.invitedTeamIds).toContain('t0');
    expect(ti.playerStatus).toBe('invited');
    const quals = Object.values(state.tournaments).filter((t) => t.advanceToTi);
    expect(quals.some((q) => q.teamIds.includes('t0'))).toBe(false);
    expect(playerTournamentInRound(state, R + 2)?.id).toBe('ti-9');
  });
  it('玩家所在赛区无名额 → 并入邻近赛区预选（不再凭空获得名额/直通）', () => {
    const state = setup(16);
    buildSeasonTournaments(state);
    Object.values(state.teams).forEach((t, i) => { t.points = i * 100; });
    state.teams.t0.region = 'SA';
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    // SA → 北美（无名额）→ 西欧：与 EU/CIS/NA/SA 的未受邀队伍同场
    expect(state.tournaments['tiq-9-SA']).toBeUndefined();
    const eu = state.tournaments['tiq-9-EU'];
    expect(eu.teamIds).toContain('t0');
    expect(eu.playerStatus).toBe('invited');
    expect(eu.advanceToTi?.slots).toBe(2);
    expect(eu.teamIds.length).toBe(CONFIG.tournament.qualifierTeams);
    expect(eu.regionLocked).toBeUndefined();
    expect(eu.name).toContain('南美');
    expect(ti.teamIds).not.toContain('t0');
    expect(ti.playerStatus).toBe('locked');
    // 名额总数不变：直邀 4 + 预选 4 = 8
    const quals = Object.values(state.tournaments).filter((t) => t.advanceToTi);
    expect(quals.reduce((a, q) => a + (q.advanceToTi?.slots ?? 0), 0) + ti.teamIds.length).toBe(TI9.teams);
    expect(state.news.some((n) => n.body.includes('跨区'))).toBe(true);
  });
  it('全邀请制（无预选名额）→ 不建预选、TI 不超额，未获直邀的玩家无缘 TI', () => {
    const state = setup(16);
    vi.mocked(data.getTiInfo).mockImplementation(() => ({ ...TI9, teams: 8, directInvites: 8, qualifierSlots: {} }));
    buildSeasonTournaments(state);
    Object.values(state.teams).forEach((t, i) => { t.points = i * 100; });
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    expect(Object.values(state.tournaments).some((t) => t.advanceToTi)).toBe(false);
    expect(ti.teamIds.length).toBe(8);
    expect(ti.teamIds).not.toContain('t0');
    expect(ti.playerStatus).toBe('locked');
    expect(playerTournamentInRound(state, R + 1)).toBeNull();
    expect(state.news.some((n) => n.body.includes('全邀请制'))).toBe(true);
  });
  it('赛区名额多于该赛区剩余队伍 → 多出的名额转给队伍富余的赛区，TI 名额全部由直邀 + 预选决出', () => {
    const state = setup(24);
    const info: TiInfo = { ...TI9, teams: 12, directInvites: 4, qualifierSlots: { CN: 2, EU: 2, SEA: 1, CIS: 1, NA: 1, SA: 1 } };
    vi.mocked(data.getTiInfo).mockImplementation(() => info);
    buildSeasonTournaments(state);
    // EU 全部 4 队（t1/t7/t13/t19）直邀 → EU 2 个名额无人可用
    for (const id of ['t1', 't7', 't13', 't19']) state.teams[id].points = 5000;
    setupTiPhase(state);
    const ti = state.tournaments['ti-9'];
    expect(ti.invitedTeamIds.sort()).toEqual(['t1', 't13', 't19', 't7']);
    const quals = Object.values(state.tournaments).filter((t) => t.advanceToTi);
    expect(quals.some((q) => q.hostRegion === 'EU')).toBe(false);
    const slots = quals.reduce((a, q) => a + (q.advanceToTi?.slots ?? 0), 0) + (ti.teamIds.length - ti.invitedTeamIds.length);
    expect(slots).toBe(info.teams - info.directInvites);
    for (const q of quals) expect(q.advanceToTi!.slots).toBeLessThan(q.teamIds.length);
    startRoundTournaments(state, R + 1);
    for (const q of quals) {
      simulateTournamentToEnd(state, q.id);
      finishTournament(state, q.id);
    }
    expect(ti.teamIds.length).toBe(info.teams);
  });
  it('tis.json 缺失时使用兜底参数', () => {
    const state = setup(30);
    vi.mocked(data.getTiInfo).mockImplementation(() => { throw new Error('缺少'); });
    buildSeasonTournaments(state);
    const ti = state.tournaments['ti-9'];
    expect(ti.size).toBe(CONFIG.tournament.tiFallback.teams);
    setupTiPhase(state);
    expect(ti.invitedTeamIds.length).toBe(CONFIG.tournament.tiFallback.directInvites);
    const quals = Object.values(state.tournaments).filter((t) => t.advanceToTi);
    const slots = quals.reduce((a, q) => a + (q.advanceToTi?.slots ?? 0), 0);
    expect(slots).toBe(CONFIG.tournament.tiFallback.teams - CONFIG.tournament.tiFallback.directInvites);
  });
});

describe('seasonStandings', () => {
  it('积分降序，荣誉为次序，排除解散战队', () => {
    const state = setup(4);
    state.teams.t1.points = 500;
    state.teams.t2.points = 500;
    state.teams.t2.honor = 999;
    state.teams.t3.disbanded = true;
    expect(seasonStandings(state).map((t) => t.id)).toEqual(['t2', 't1', 't0']);
  });
});
