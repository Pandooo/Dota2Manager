import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import { playerRating } from '../src/engine/player';
import {
  activeTeams, addPlayerToTeam, autoLineup, benchPlayers, getCoach, getPlayerTeam, lineupPlayers, rankTeamsByRating,
  removePlayerFromTeam, rosterHardRoom, rosterOverflowNotice, rosterRoom, rosterSigningBlock, rosterSigningNote, rosterSize,
  setLineupSlot, teamInsight, teamPlayers, teamRating, validateLineup,
} from '../src/engine/team';
import type { GameState, Player } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { addTeam, makeCoach, makePlayer, makeTestState } from './helpers';

function sign(s: GameState, p: Player, teamId: string) {
  s.players[p.id] = p;
  addPlayerToTeam(s, p.id, teamId, { contractSeasons: 1 });
}

describe('team: 基础查询', () => {
  it('getPlayerTeam / teamPlayers / lineupPlayers / benchPlayers', () => {
    const s = makeTestState(3);
    expect(getPlayerTeam(s).id).toBe('t0');
    const sub = makePlayer({ id: 'sub1', position: 'M' });
    sign(s, sub, 't0');
    expect(teamPlayers(s, 't0')).toHaveLength(6);
    expect(benchPlayers(s, 't0').map((p) => p.id)).toEqual(['sub1']);
    s.players['t0-C'].status = 'banned';
    expect(teamPlayers(s, 't0')).toHaveLength(5);
    const lp = lineupPlayers(s, 't0');
    expect(lp.map((x) => x.pos)).toEqual(POSITIONS);
    expect(lp[0].player).toBeNull(); // banned 首发视为空缺
    expect(teamPlayers(s, 'nope')).toEqual([]);
    expect(activeTeams(s)).toHaveLength(3);
    s.teams.t2.disbanded = true;
    expect(activeTeams(s)).toHaveLength(2);
  });
});

describe('team: autoLineup', () => {
  it('最大化首发评分之和（含跨位置补位）', () => {
    const s = makeTestState(0);
    addTeam(s, 'x');
    const team = s.teams.x;
    // 把中单换成两个 1 号位：强 C 打 1 号位，次强 C 补中路
    removePlayerFromTeam(s, 'x-M');
    sign(s, makePlayer({ id: 'c2', position: 'C', power: 85 }), 'x');
    s.players['x-C'].power = 90;
    team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
    autoLineup(s, 'x');
    expect(team.lineup.C).toBe('x-C');
    expect(team.lineup.M).toBe('c2');
    expect(team.lineup.O).toBe('x-O');
    // 校验确为最优：枚举两种 1/2 号位安排
    const a = playerRating(s.players['x-C'], 'C') + playerRating(s.players.c2, 'M');
    const b = playerRating(s.players.c2, 'C') + playerRating(s.players['x-C'], 'M');
    expect(a).toBeGreaterThanOrEqual(b);
  });

  it('本位置强者优先，弱替补坐板凳', () => {
    const s = makeTestState(1);
    sign(s, makePlayer({ id: 'weakO', position: 'O', power: 40 }), 't0');
    sign(s, makePlayer({ id: 'starO', position: 'O', power: 95 }), 't0');
    autoLineup(s, 't0');
    expect(s.teams.t0.lineup.O).toBe('starO');
    expect(Object.values(s.teams.t0.lineup)).not.toContain('weakO');
  });

  it('赛事不可用（签证）与禁赛选手被排除；人数不足时留空', () => {
    const s = makeTestState(1);
    s.players['t0-HS'].unavailableTournamentIds = ['major-1'];
    s.players['t0-C'].status = 'banned';
    autoLineup(s, 't0', 'major-1');
    const l = s.teams.t0.lineup;
    expect(Object.values(l)).not.toContain('t0-HS');
    expect(Object.values(l)).not.toContain('t0-C');
    expect(Object.values(l).filter(Boolean)).toHaveLength(3);
    // 其余三人在本位置
    expect(l.M).toBe('t0-M');
    expect(l.O).toBe('t0-O');
    expect(l.SS).toBe('t0-SS');
    // 不指定赛事时 HS 回归
    autoLineup(s, 't0');
    expect(l.HS).toBe('t0-HS');
  });

  it('其他赛事的临时替补不上场', () => {
    const s = makeTestState(1);
    const temp = makePlayer({ id: 'tmp', position: 'C', power: 99, tempSubUntilTournament: 'other-cup' });
    sign(s, temp, 't0');
    autoLineup(s, 't0', 'major-1');
    expect(s.teams.t0.lineup.C).toBe('t0-C');
    autoLineup(s, 't0', 'other-cup');
    expect(s.teams.t0.lineup.C).toBe('tmp');
  });

  it('空战队/不存在战队不崩溃；10 人以上候选也能快速完成', () => {
    const s = makeTestState(0);
    autoLineup(s, 'missing');
    addTeam(s, 'big');
    for (let i = 0; i < 7; i++) sign(s, makePlayer({ id: `b${i}`, position: POSITIONS[i % 5], power: 60 + i }), 'big');
    const t0 = performance.now();
    autoLineup(s, 'big');
    expect(performance.now() - t0).toBeLessThan(500);
    const ids = Object.values(s.teams.big.lineup);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every(Boolean)).toBe(true);
  });
});

describe('team: 阵容校验与设置', () => {
  it('validateLineup 返回中文错误', () => {
    const s = makeTestState(1);
    expect(validateLineup(s, 't0')).toEqual([]);
    s.teams.t0.lineup.SS = null;
    s.players['t0-C'].unavailableTournamentIds = ['ti-9'];
    s.players['t0-M'].status = 'banned';
    const errs = validateLineup(s, 't0', 'ti-9');
    expect(errs).toHaveLength(3);
    expect(errs.join('|')).toMatch(/空缺/);
    expect(errs.join('|')).toMatch(/签证/);
    expect(errs.join('|')).toMatch(/禁赛/);
    expect(validateLineup(s, 'nope')).toEqual(['战队不存在']);
  });

  it('setLineupSlot 互换位置 / 置空', () => {
    const s = makeTestState(1);
    const l = s.teams.t0.lineup;
    setLineupSlot(s, 't0', 'C', 't0-M');
    expect(l.C).toBe('t0-M');
    expect(l.M).toBe('t0-C');
    setLineupSlot(s, 't0', 'HS', null);
    expect(l.HS).toBeNull();
    // 非本队选手被忽略
    setLineupSlot(s, 't0', 'O', 'ghost');
    expect(l.O).toBe('t0-O');
  });
});

describe('team: 评分与灵性', () => {
  it('teamRating = Σ首发评分 × 事件倍数 + 教练加成', () => {
    const s = makeTestState(1);
    const base = POSITIONS.reduce((acc, pos) => acc + playerRating(s.players[`t0-${pos}`], pos), 0);
    expect(teamRating(s, 't0')).toBeCloseTo(base);
    const withIncident = teamRating(s, 't0', [
      { minute: 10, playerId: 't0-C', teamId: 't0', text: '掉线', powerMult: 0.5 },
    ]);
    expect(withIncident).toBeCloseTo(base - playerRating(s.players['t0-C'], 'C') * 0.5);
    const coach = makeCoach({ id: 'co', insight: 80, teamId: 't0' });
    s.coaches.co = coach;
    s.teams.t0.coachId = 'co';
    expect(getCoach(s, 't0')?.id).toBe('co');
    expect(teamRating(s, 't0')).toBeCloseTo(base + 80 * CONFIG.coach.ratingBonusPerInsight);
    s.teams.t0.lineup.C = null;
    expect(teamRating(s, 't0')).toBeLessThan(base);
    expect(teamRating(s, 'nope')).toBe(0);
  });

  it('teamInsight 混合教练灵性', () => {
    const s = makeTestState(1);
    expect(teamInsight(s, 't0')).toBeCloseTo(60);
    s.coaches.co = makeCoach({ id: 'co', insight: 100 });
    s.teams.t0.coachId = 'co';
    const w = CONFIG.coach.insightWeightInDraft;
    expect(teamInsight(s, 't0')).toBeCloseTo(60 * (1 - w) + 100 * w);
  });

  it('rankTeamsByRating 降序', () => {
    const s = makeTestState(6); // power 70..75
    const ranked = rankTeamsByRating(s);
    expect(ranked[0]).toBe('t5');
    expect(ranked[ranked.length - 1]).toBe('t0');
    expect(rankTeamsByRating(s, ['t1', 't3'])).toEqual(['t3', 't1']);
  });
});

describe('team: 签入/移出', () => {
  it('addPlayerToTeam 设置合同/工资并补位本位置空缺', () => {
    const s = makeTestState(1);
    removePlayerFromTeam(s, 't0-SS');
    expect(s.teams.t0.lineup.SS).toBeNull();
    expect(s.players['t0-SS'].teamId).toBeNull();
    expect(s.players['t0-SS'].lastTeamId).toBe('t0');
    expect(rosterRoom(s, 't0')).toBe(CONFIG.team.maxRoster - 4);

    const fa = makePlayer({ id: 'fa', position: 'SS', salary: 1 });
    s.players.fa = fa;
    addPlayerToTeam(s, 'fa', 't0', { contractSeasons: 2 });
    expect(fa.teamId).toBe('t0');
    expect(fa.joinedSeason).toBe(9);
    expect(fa.contractUntil).toBe(10);
    expect(fa.salary).toBeGreaterThan(1000);
    expect(s.teams.t0.lineup.SS).toBe('fa');
    expect(s.teams.t0.playerIds).toContain('fa');

    // 位置已有人 → 不抢首发
    const fa2 = makePlayer({ id: 'fa2', position: 'SS' });
    s.players.fa2 = fa2;
    addPlayerToTeam(s, 'fa2', 't0', { salary: 1234 });
    expect(fa2.salary).toBe(1234);
    expect(s.teams.t0.lineup.SS).toBe('fa');
    expect(fa2.contractUntil).toBeGreaterThanOrEqual(9);
    expect(fa2.contractUntil).toBeLessThanOrEqual(11);
  });

  it('转队时从原队移除', () => {
    const s = makeTestState(2);
    addPlayerToTeam(s, 't1-M', 't0', { contractSeasons: 1 });
    expect(s.teams.t1.playerIds).not.toContain('t1-M');
    expect(s.teams.t1.lineup.M).toBeNull();
    expect(s.players['t1-M'].teamId).toBe('t0');
    expect(s.players['t1-M'].lastTeamId).toBe('t1');
  });

  it('临时替补自动顶替无法参赛的首发（优先本位置，其次任意缺口）', () => {
    const s = makeTestState(1);
    s.players['t0-O'].unavailableTournamentIds = ['major-1'];
    // 本位置是 C（C 首发可用）→ 顶替 O 的缺口
    sign(s, makePlayer({ id: 'tmp1', position: 'C', tempSubUntilTournament: 'major-1' }), 't0');
    expect(s.teams.t0.lineup.C).toBe('t0-C');
    expect(s.teams.t0.lineup.O).toBe('tmp1');
    expect(validateLineup(s, 't0', 'major-1')).toEqual([]);
  });

  it('阵容人数：常规上限只是提示（可超出），只有绝对上限阻止签约；临时替补不计', () => {
    const s = makeTestState(1);
    const fill = (n: number) => {
      for (let i = 0; rosterSize(s, 't0') < n; i++) sign(s, makePlayer({ id: `x${n}-${i}`, position: 'SS' }), 't0');
    };
    expect(rosterSize(s, 't0')).toBe(5);
    expect(rosterSigningBlock(s, 't0')).toBeNull();
    expect(rosterOverflowNotice(s, 't0')).toBeNull();
    expect(rosterSigningNote(s, 't0')).toBeNull(); // 签到第 6 人仍在常规上限内

    fill(CONFIG.team.maxRoster);
    expect(rosterRoom(s, 't0')).toBe(0);
    expect(rosterSigningBlock(s, 't0')).toBeNull();
    expect(rosterOverflowNotice(s, 't0')).toBeNull();
    expect(rosterSigningNote(s, 't0')).toContain(`签下后阵容 ${CONFIG.team.maxRoster + 1}/${CONFIG.team.maxRoster}`);

    fill(CONFIG.team.maxRoster + 2);
    expect(rosterRoom(s, 't0')).toBe(-2);
    expect(rosterOverflowNotice(s, 't0')).toBe(
      `阵容 ${CONFIG.team.maxRoster + 2}/${CONFIG.team.maxRoster}：超出常规上限，替补归属感下降更快、工资照付`,
    );
    expect(rosterSigningBlock(s, 't0')).toBeNull();

    fill(CONFIG.team.hardMaxRoster);
    expect(rosterHardRoom(s, 't0')).toBe(0);
    expect(rosterSigningBlock(s, 't0')).toBe(`阵容已达绝对上限（${CONFIG.team.hardMaxRoster} 人），请先解约或出售选手`);
    expect(rosterSigningNote(s, 't0')).toBeNull();
    // 临时替补不计入
    sign(s, makePlayer({ id: 'tmp-x', tempSubUntilTournament: 'x' }), 't0');
    expect(rosterSize(s, 't0')).toBe(CONFIG.team.hardMaxRoster);
  });

  it('临时替补不占名额', () => {
    const s = makeTestState(1);
    const before = rosterRoom(s, 't0');
    sign(s, makePlayer({ id: 'tmp', tempSubUntilTournament: 'x' }), 't0');
    expect(rosterRoom(s, 't0')).toBe(before);
    expect(s.players.tmp.contractUntil).toBe(9);
  });

  it('禁赛/退役选手、已解散战队不能签入（名单只引用 active 选手）', () => {
    const s = makeTestState(2);
    removePlayerFromTeam(s, 't0-C');
    const banned = makePlayer({ id: 'bn', position: 'C', status: 'banned' });
    const retired = makePlayer({ id: 'rt', position: 'C', status: 'retired' });
    sign(s, banned, 't0');
    sign(s, retired, 't0');
    expect(s.teams.t0.playerIds).not.toContain('bn');
    expect(s.teams.t0.playerIds).not.toContain('rt');
    expect(banned.teamId).toBeNull();
    expect(s.teams.t0.lineup.C).toBeNull();

    s.teams.t1.disbanded = true;
    const fa = makePlayer({ id: 'fa' });
    sign(s, fa, 't1');
    expect(fa.teamId).toBeNull();
    expect(s.teams.t1.playerIds).not.toContain('fa');
  });

  it('removePlayerFromTeam 清理所有战队中的悬空引用（teamId 与名单不一致时）', () => {
    const s = makeTestState(2);
    // 人为制造不一致：t1-M 的 teamId 指向 t0，但仍在 t1 名单/首发里
    s.players['t1-M'].teamId = 't0';
    removePlayerFromTeam(s, 't1-M');
    expect(s.teams.t1.playerIds).not.toContain('t1-M');
    expect(s.teams.t1.lineup.M).toBeNull();
    expect(s.players['t1-M'].teamId).toBeNull();
    expect(s.players['t1-M'].lastTeamId).toBe('t0');
  });
});
