import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeTestState } from './helpers';

const mocks = vi.hoisted(() => ({
  tiInfo: null as null | ((ti: number) => unknown),
  playerTournament: null as null | ((roundIndex: number) => unknown),
}));

vi.mock('../src/data/index', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/index')>();
  return {
    ...orig,
    getTiInfo: vi.fn((ti: number) => {
      if (mocks.tiInfo) return mocks.tiInfo(ti);
      throw new Error(`缺少 TI${ti} 的数据`);
    }),
  };
});

vi.mock('../src/engine/schedule', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/engine/schedule')>();
  return {
    ...orig,
    playerTournamentInRound: vi.fn((_s: unknown, idx: number) => (mocks.playerTournament ? mocks.playerTournament(idx) : null)),
  };
});

import {
  anyRoundIndexForDate, buildRounds, currentRound, regularRoundCount, roundIndexForDate, roundKindForPlayer,
  seasonStartDate, tiDates, tiYear,
} from '../src/engine/calendar';
import { addDays, compareDate, daysBetween } from '../src/engine/util';

const R = CONFIG.calendar.regularRounds;

function seasonFor(ti: number) {
  const start = seasonStartDate(ti);
  const { startDate, endDate } = tiDates(ti);
  return {
    ti,
    year: tiYear(ti),
    startDate: start,
    tiStartDate: startDate,
    rounds: buildRounds(ti, start, startDate, endDate),
    registeredTournamentIds: [],
    extraTrainingsBought: 0,
  };
}

beforeEach(() => {
  mocks.tiInfo = null;
  mocks.playerTournament = null;
});

describe('calendar: 年份与日期', () => {
  it('TI 序号 → 年份（2020 停办）', () => {
    expect(tiYear(1)).toBe(2011);
    expect(tiYear(9)).toBe(2019);
    expect(tiYear(10)).toBe(2021);
    expect(tiYear(16)).toBe(2027);
  });

  it('tis.json 缺失时使用内置兜底日期', () => {
    const d = tiDates(9);
    expect(d.startDate).toBe('2019-08-15');
    expect(compareDate(d.endDate, d.startDate)).toBeGreaterThan(0);
    // 表外推演
    const far = tiDates(20);
    expect(far.startDate.startsWith(String(tiYear(20)))).toBe(true);
  });

  it('优先使用 tis.json 的日期', () => {
    mocks.tiInfo = () => ({ startDate: '2019-08-20', endDate: '2019-08-25' });
    expect(tiDates(9)).toEqual({ startDate: '2019-08-20', endDate: '2019-08-25' });
    // 数据损坏 → 兜底
    mocks.tiInfo = () => ({ startDate: 'bad', endDate: '' });
    expect(tiDates(9).startDate).toBe('2019-08-15');
  });

  it('赛季开始日 = 上届 TI 结束 + gap；TI1 固定', () => {
    expect(seasonStartDate(1)).toBe('2011-03-01');
    expect(seasonStartDate(10)).toBe(addDays(tiDates(9).endDate, CONFIG.calendar.seasonStartGapDays));
  });
});

describe('calendar: 回合表', () => {
  it.each([1, 5, 9, 10, 13, 16])('TI%i 回合数与阶段正确，日期单调连续', (ti) => {
    const s = seasonFor(ti);
    expect(s.rounds).toHaveLength(R + 3);
    expect(s.rounds[0].phase).toBe('preseason');
    for (let i = 1; i <= R; i++) expect(s.rounds[i].phase).toBe('regular');
    expect(s.rounds[R + 1].phase).toBe('ti_qualifier');
    expect(s.rounds[R + 2].phase).toBe('ti');
    s.rounds.forEach((r, i) => {
      expect(r.index).toBe(i);
      expect(r.tournamentIds).toEqual([]);
      expect(r.patchVersions).toEqual([]);
      expect(compareDate(r.startDate, r.endDate)).toBeLessThanOrEqual(0);
      if (i > 0) {
        expect(r.startDate).toBe(s.rounds[i - 1].endDate);
        expect(compareDate(r.endDate, r.startDate)).toBeGreaterThan(0);
      }
    });
    expect(s.rounds[0].startDate).toBe(s.startDate);
    expect(s.rounds[R + 2].startDate).toBe(s.tiStartDate);
    expect(daysBetween(s.rounds[R + 1].startDate, s.tiStartDate)).toBe(CONFIG.calendar.tiQualifierLeadDays);
    expect(regularRoundCount(s)).toBe(R);
  });

  it('异常日期（TI 早于赛季开始）仍生成单调回合表', () => {
    const rounds = buildRounds(9, '2019-08-01', '2019-07-01', '2019-06-01');
    expect(rounds).toHaveLength(R + 3);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i].startDate).toBe(rounds[i - 1].endDate);
      expect(compareDate(rounds[i].endDate, rounds[i].startDate)).toBeGreaterThan(0);
    }
  });

  it('日期 → 常规赛回合（夹紧到 1..R）', () => {
    const s = seasonFor(9);
    expect(roundIndexForDate(s, '2000-01-01')).toBe(1);
    expect(roundIndexForDate(s, '2030-01-01')).toBe(R);
    const mid = s.rounds[7];
    expect(roundIndexForDate(s, mid.startDate)).toBe(7);
    expect(roundIndexForDate(s, addDays(mid.endDate, -1))).toBe(7);
    expect(roundIndexForDate(s, s.tiStartDate)).toBe(R);
  });

  it('任意日期 → 回合（版本映射）', () => {
    const s = seasonFor(9);
    expect(anyRoundIndexForDate(s, '2000-01-01')).toBe(0);
    expect(anyRoundIndexForDate(s, s.startDate)).toBe(0);
    expect(anyRoundIndexForDate(s, addDays(s.startDate, 1))).toBe(1);
    expect(anyRoundIndexForDate(s, s.tiStartDate)).toBe(R + 2);
    expect(anyRoundIndexForDate(s, '2030-01-01')).toBe(R + 2);
  });
});

describe('calendar: 玩家视角', () => {
  function stateWithSeason() {
    const state = makeTestState(4);
    state.season = seasonFor(9);
    return state;
  }

  it('currentRound 越界时返回占位回合', () => {
    const state = stateWithSeason();
    state.roundIndex = 3;
    expect(currentRound(state).index).toBe(3);
    state.roundIndex = 99;
    expect(currentRound(state).index).toBe(99);
  });

  it('preseason / 休赛 / 赛事回合', () => {
    const state = stateWithSeason();
    const t = { id: 'x', status: 'running', tier: 'major' } as unknown as Tournament;
    mocks.playerTournament = (idx) => (idx === 2 ? t : null);
    expect(roundKindForPlayer(state, 0)).toBe('preseason');
    expect(roundKindForPlayer(state, 1)).toBe('rest');
    expect(roundKindForPlayer(state, 2)).toBe('tournament');
  });

  it('报名的赛事被取消 / TI 预选报名不足直通：该回合对玩家是休赛回合', () => {
    const state = stateWithSeason();
    const cancelled = { id: 'c', status: 'finished', tier: 'minor', stages: [], series: {}, placements: [] } as unknown as Tournament;
    const played = {
      id: 'p', status: 'finished', tier: 'minor', stages: [{ id: 's' }], series: {},
      placements: [{ teamId: 't0', rankFrom: 1, rankTo: 1, prize: 0, points: 0 }],
    } as unknown as Tournament;
    const q = R + 1;
    const direct = { id: 'q', status: 'finished', tier: 'qualifier', stages: [], series: {}, placements: [] } as unknown as Tournament;
    mocks.playerTournament = (idx) => (idx === 2 ? cancelled : idx === 3 ? played : idx === q ? direct : null);
    expect(roundKindForPlayer(state, 2)).toBe('rest');
    expect(roundKindForPlayer(state, 3)).toBe('tournament');
    state.roundIndex = q;
    expect(roundKindForPlayer(state, q)).toBe('rest');
  });

  it('TI 预选与 TI：未知时显示为预选/TI，确定未晋级后为观赛', () => {
    const state = stateWithSeason();
    const q = R + 1;
    const ti = R + 2;
    state.roundIndex = 5;
    expect(roundKindForPlayer(state, q)).toBe('ti_qualifier');
    expect(roundKindForPlayer(state, ti)).toBe('ti');
    // 已到预选回合，玩家没有预选（直邀或无名额）→ 休赛
    state.roundIndex = q;
    expect(roundKindForPlayer(state, q)).toBe('rest');
    expect(roundKindForPlayer(state, ti)).toBe('ti_watch');
    // TI 回合仍不在名单 → 观赛
    state.roundIndex = ti;
    expect(roundKindForPlayer(state, ti)).toBe('ti_watch');
    // 经预选晋级：TI 实例 teamIds 含玩家（报名状态未同步）
    state.season.rounds[ti].tournamentIds = ['ti-9'];
    state.tournaments['ti-9'] = {
      id: 'ti-9', tier: 'ti', season: 9, teamIds: ['t0'], qualifierTeamIds: [], playerStatus: 'locked', status: 'running',
    } as unknown as Tournament;
    expect(roundKindForPlayer(state, ti)).toBe('ti');
  });
});
