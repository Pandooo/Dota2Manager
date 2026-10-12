// AI 首发优先级（用户决策 2026-10-10「首发优先使命选手和巅峰选手，然后再基于评分安排」）：
// src/engine/lineupPriority.ts + team.autoLineup。使命选手 → 巅峰选手 → 评分；各自排在本位置；人类玩家战队不受影响。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Position } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { addTeam, makePlayer, makeTestState } from './helpers';
import { autoLineup, validateLineup } from '../src/engine/team';
import { aiLineupPriority, isPeakRosterPlayer, lineupPriorityLocks } from '../src/engine/lineupPriority';
import { missionOf } from '../src/engine/missions';
import * as clubs from '../src/engine/clubs';
import * as clubIndex from '../src/engine/clubIndex';
import { createNewGame } from '../src/engine/game';
import { createMultiplayerGame } from '../src/engine/multi';
import { registerNodeRosterLoader } from '../scripts/nodeData';

const PRIO = CONFIG.team.aiLineupPriority as { mission: boolean; peak: boolean; lockTransfers: boolean };
const saved = { ...PRIO };
afterEach(() => {
  PRIO.mission = saved.mission;
  PRIO.peak = saved.peak;
  PRIO.lockTransfers = saved.lockTransfers;
});

/** 把选手 id 放进战队（替换同 id 的旧对象），返回该选手 */
function put(s: GameState, teamId: string, id: string, position: Position, power: number) {
  const team = s.teams[teamId];
  const p = makePlayer({ id, handle: id, position, power, teamId });
  s.players[id] = p;
  if (!team.playerIds.includes(id)) team.playerIds.push(id);
  return p;
}

/** 清空战队，换成给定的 [id, 位置, 战力] 名单 */
function roster(s: GameState, teamId: string, list: [string, Position, number][]): void {
  const team = s.teams[teamId];
  for (const id of team.playerIds) delete s.players[id];
  team.playerIds = [];
  team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
  for (const [id, pos, power] of list) put(s, teamId, id, pos, power);
}

/** TI9 赛季（helpers 默认）：OG 的使命 = TI8 冠军阵容（ana / topson / ceb / jerax / n0tail） */
function withOg(): GameState {
  const s = makeTestState(3);
  addTeam(s, 'og');
  roster(s, 'og', [['ana', 'C', 70], ['topson', 'M', 70], ['ceb', 'O', 70], ['jerax', 'SS', 70], ['n0tail', 'HS', 70]]);
  return s;
}

describe('AI 首发优先级 · 使命选手与巅峰选手', () => {
  it('使命选手优先于评分更高的同位置非使命选手；关闭开关时恢复只按评分', () => {
    const s = withOg();
    put(s, 'og', 'og-star', 'M', 95);
    expect(aiLineupPriority(s, 'og')?.get('topson')).toBe(1);
    autoLineup(s, 'og');
    expect(s.teams.og.lineup.M).toBe('topson');
    expect(Object.values(s.teams.og.lineup)).not.toContain('og-star');
    PRIO.mission = false;
    PRIO.peak = false;
    expect(aiLineupPriority(s, 'og')).toBeNull();
    autoLineup(s, 'og');
    expect(s.teams.og.lineup.M).toBe('og-star');
  });

  it('同一位置两名使命选手：评分高者打本位置，另一人与其他选手按评分竞争剩余位置', () => {
    const s = withOg();
    s.players.n0tail.position = 'C';
    s.players.n0tail.power = 80;
    put(s, 'og', 'og-hs', 'HS', 75);
    autoLineup(s, 'og');
    expect(s.teams.og.lineup.C).toBe('n0tail');
    // ana 打 HS 是跨位置（× offRoleFactor），不如本位置的 og-hs
    expect(s.teams.og.lineup.HS).toBe('og-hs');
    expect(validateLineup(s, 'og')).toEqual([]);
  });

  it('使命选手优先于巅峰选手；巅峰选手优先于评分更高的普通选手', () => {
    const s = withOg();
    // miracle：TI7 Liquid 冠军阵容成员（TI9 赛季时 TI7 已打完 → 巅峰选手），不在 OG 的使命中
    put(s, 'og', 'miracle', 'M', 90);
    const prio = aiLineupPriority(s, 'og')!;
    expect(prio.get('topson')).toBe(1);
    expect(prio.get('miracle')).toBe(2);
    autoLineup(s, 'og');
    expect(s.teams.og.lineup.M).toBe('topson');

    // 没有使命的 AI 战队（虚构 id，不对应真实组织）：巅峰选手优先于评分更高的同位置选手
    const t = makeTestState(3);
    addTeam(t, 'zz-ai');
    put(t, 'zz-ai', 'miracle', 'M', 60);
    put(t, 'zz-ai', 'zz-star', 'M', 95);
    expect(missionOf(t, 'zz-ai')).toBeNull();
    autoLineup(t, 'zz-ai');
    expect(t.teams['zz-ai'].lineup.M).toBe('miracle');
  });

  it('巅峰选手要等对应届次的真实 TI 打完：TI9 赛季时 TI10 Spirit 的 Yatoro 还不算', () => {
    const s = makeTestState(3);
    addTeam(s, 'zz-ai');
    put(s, 'zz-ai', 'yatoro', 'C', 60);
    put(s, 'zz-ai', 'zz-ace', 'C', 95);
    expect(isPeakRosterPlayer(s, 'yatoro')).toBe(false);
    autoLineup(s, 'zz-ai');
    expect(s.teams['zz-ai'].lineup.C).toBe('zz-ace');
    s.season.ti = 11;
    expect(isPeakRosterPlayer(s, 'yatoro')).toBe(true);
    autoLineup(s, 'zz-ai');
    expect(s.teams['zz-ai'].lineup.C).toBe('yatoro');
  });

  it('人类玩家战队不使用优先级（自动排阵只按评分）', () => {
    const s = makeTestState(3);
    put(s, 't0', 'miracle', 'M', 60);
    put(s, 't0', 't0-star', 'M', 95);
    expect(s.teams.t0.isPlayer).toBe(true);
    expect(aiLineupPriority(s, 't0')).toBeNull();
    autoLineup(s, 't0');
    expect(s.teams.t0.lineup.M).toBe('t0-star');
  });

  it('有可出场的选手就不留空位；无法参加该赛事的优先选手不排进首发', () => {
    const s = withOg();
    // 五人里三人挤在 C：仍然排满 5 个位置
    roster(s, 'og', [['ana', 'C', 70], ['n0tail', 'C', 72], ['topson', 'C', 74], ['og-a', 'O', 60], ['og-b', 'SS', 60]]);
    autoLineup(s, 'og');
    expect(validateLineup(s, 'og')).toEqual([]);
    expect(s.teams.og.lineup.C).toBe('topson');
    // 赛事签证问题：该赛事不可出场的使命选手让位，替补补上
    put(s, 'og', 'og-c', 'C', 50);
    s.players.topson.unavailableTournamentIds = ['cup'];
    autoLineup(s, 'og', 'cup');
    expect(Object.values(s.teams.og.lineup)).not.toContain('topson');
    expect(s.teams.og.lineup.C).toBe('n0tail');
    expect(validateLineup(s, 'og', 'cup')).toEqual([]);
    for (const pos of POSITIONS) expect(s.teams.og.lineup[pos]).toBeTruthy();
  });
});

describe('AI 首发优先级 · 转会补强配套（lineupPriorityLocks）', () => {
  it('优先选手打本位置时锁定该位置：按评分引进的普通选手只会坐替补；客串其他位置、人类战队、开关关闭时不锁定', () => {
    const s = withOg();
    const topson = s.players.topson;
    const outsider = makePlayer({ id: 'fa-mid', handle: 'fa-mid', position: 'M', power: 99, teamId: null });
    s.players[outsider.id] = outsider;
    expect(lineupPriorityLocks(s, 'og', topson, 'M')).toBe(true);
    expect(lineupPriorityLocks(s, 'og', topson, 'M', outsider)).toBe(true);
    // 引进后 autoLineup 确实仍让使命选手首发（与锁定判断一致）
    put(s, 'og', 'fa-mid', 'M', 99);
    autoLineup(s, 'og');
    expect(s.teams.og.lineup.M).toBe('topson');
    // 客串其他位置（不是他的本位置）：不锁定
    expect(lineupPriorityLocks(s, 'og', topson, 'C')).toBe(false);
    // 普通首发不锁定
    expect(lineupPriorityLocks(s, 'og', s.players['fa-mid'], 'M')).toBe(false);
    PRIO.lockTransfers = false;
    expect(lineupPriorityLocks(s, 'og', topson, 'M')).toBe(false);
    PRIO.lockTransfers = true;
    PRIO.mission = false;
    PRIO.peak = false;
    expect(lineupPriorityLocks(s, 'og', topson, 'M')).toBe(false);
    // 人类玩家战队
    const h = makeTestState(3);
    put(h, 't0', 'miracle', 'M', 60);
    expect(lineupPriorityLocks(h, 't0', h.players.miracle, 'M')).toBe(false);
  });

  it('候选人优先级更高、或同级且综合评分更高时不锁定（autoLineup 会让他顶替）', () => {
    const s = makeTestState(3);
    addTeam(s, 'zz-ai');
    // TI9 赛季：miracle（TI7 Liquid）与 topson（TI8 OG）都是巅峰选手（优先级 2）
    const miracle = put(s, 'zz-ai', 'miracle', 'M', 60);
    const topsonHi = makePlayer({ id: 'topson', handle: 'topson', position: 'M', power: 90, teamId: null });
    const topsonLo = makePlayer({ id: 'topson', handle: 'topson', position: 'M', power: 40, teamId: null });
    const plain = makePlayer({ id: 'zz-plain', handle: 'zz-plain', position: 'M', power: 99, teamId: null });
    expect(aiLineupPriority(s, 'zz-ai')?.get('miracle')).toBe(2);
    expect(lineupPriorityLocks(s, 'zz-ai', miracle, 'M', topsonHi)).toBe(false);
    expect(lineupPriorityLocks(s, 'zz-ai', miracle, 'M', topsonLo)).toBe(true);
    expect(lineupPriorityLocks(s, 'zz-ai', miracle, 'M', plain)).toBe(true);
    // 使命俱乐部：使命成员（优先级 1）可顶替同位置的巅峰选手（优先级 2）
    const o = withOg();
    o.players.topson.position = 'C';
    const mir = put(o, 'og', 'miracle', 'M', 90);
    autoLineup(o, 'og');
    expect(o.teams.og.lineup.M).toBe('miracle');
    const topsonMid = makePlayer({ id: 'topson', handle: 'topson', position: 'M', power: 50, teamId: null });
    expect(lineupPriorityLocks(o, 'og', mir, 'M', topsonMid)).toBe(false);
  });
});

describe('AI 首发优先级 · 与使命 / 俱乐部索引同口径', () => {
  beforeAll(() => {
    registerNodeRosterLoader();
  });

  it('clubs.ts 转出的索引查询即 clubIndex.ts 的同一实现', () => {
    expect(clubs.realOrgOf).toBe(clubIndex.realOrgOf);
    expect(clubs.peakPlayerIdsOfTeam).toBe(clubIndex.peakPlayerIdsOfTeam);
    expect(clubs.clubOrgs).toBe(clubIndex.clubOrgs);
  });

  it('真实开局（TI9）：每支 AI 战队的使命选手 = missionOf 的巅峰阵容 ∩ 在队选手；人类战队为空；首发包含全部可排的使命选手', async () => {
    const g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: 't', seed: 7, teamId: 'team-liquid' });
    let withMission = 0;
    for (const team of Object.values(g.teams)) {
      if (team.disbanded) continue;
      const prio = aiLineupPriority(g, team.id);
      const missionIds = new Set((missionOf(g, team.id)?.peak.players ?? []).filter((id) => team.playerIds.includes(id)));
      const got = new Set([...(prio?.entries() ?? [])].filter(([, v]) => v === 1).map(([id]) => id));
      expect([...got].sort()).toEqual([...missionIds].sort());
      if (team.isPlayer) expect(prio).toBeNull();
      if (!missionIds.size) continue;
      withMission++;
      autoLineup(g, team.id);
      // 每个位置上至少有一名使命选手（本位置或评分更高的同位置使命选手）首发
      const starters = new Set(POSITIONS.map((pos) => team.lineup[pos]));
      for (const id of missionIds) {
        const p = g.players[id];
        if (!p || p.status !== 'active') continue;
        const holder = g.players[team.lineup[p.position] ?? ''];
        expect(starters.has(id) || (!!holder && missionIds.has(holder.id))).toBe(true);
      }
    }
    expect(withMission).toBeGreaterThan(5);
  }, 30_000);

  it('多人模式：人类玩家战队（existing 玩法接管真实俱乐部）不使用优先级', async () => {
    const g = await createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'existing', seed: 5,
      players: [{ sessionId: 's-a', name: '甲', teamId: 'og' }, { sessionId: 's-b', name: '乙', teamId: 'team-liquid' }],
    });
    expect(aiLineupPriority(g, 'og')).toBeNull();
    expect(aiLineupPriority(g, 'team-liquid')).toBeNull();
  }, 30_000);
});
