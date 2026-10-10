// BP/比赛/直播测试用的 team / player 简化实现（让测试不依赖其他模块的完成度）
import type { GameState, InMatchEvent, Player, Position } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';

function starters(state: GameState, teamId: string): { pos: Position; p: Player }[] {
  const t = state.teams[teamId];
  if (!t) return [];
  const res: { pos: Position; p: Player }[] = [];
  for (const pos of POSITIONS) {
    const id = t.lineup[pos];
    const p = id ? state.players[id] : undefined;
    if (p && p.status === 'active') res.push({ pos, p });
  }
  return res;
}

export const teamMock = {
  teamRating(state: GameState, teamId: string, incidents?: InMatchEvent[]): number {
    let sum = 0;
    for (const { pos, p } of starters(state, teamId)) {
      let r = p.power * (p.position === pos ? 1 : 0.85);
      for (const i of incidents ?? []) if (i.playerId === p.id) r *= i.powerMult;
      sum += r;
    }
    return sum;
  },
  teamInsight(state: GameState, teamId: string): number {
    const s = starters(state, teamId);
    return s.length ? s.reduce((a, x) => a + x.p.insight, 0) / s.length : 0;
  },
  /** 简化版：空位 / 非本队 / 非 active 的首发计为错误 */
  validateLineup(state: GameState, teamId: string): string[] {
    const t = state.teams[teamId];
    if (!t) return ['战队不存在'];
    const errs: string[] = [];
    for (const pos of POSITIONS) {
      const id = t.lineup[pos];
      const p = id ? state.players[id] : undefined;
      if (!p || p.status !== 'active' || p.teamId !== teamId || !t.playerIds.includes(p.id)) errs.push(`${pos} 空缺`);
    }
    return errs;
  },
  /** 简化版：用未上场的本队 active 选手按顺序补空位 */
  autoLineup(state: GameState, teamId: string): void {
    const t = state.teams[teamId];
    if (!t) return;
    const valid = (id: string | null) => {
      const p = id ? state.players[id] : undefined;
      return !!p && p.status === 'active' && p.teamId === teamId && t.playerIds.includes(p.id);
    };
    const used = new Set(POSITIONS.map((pos) => t.lineup[pos]).filter((id): id is string => valid(id)));
    const bench = t.playerIds.filter((id) => valid(id) && !used.has(id));
    for (const pos of POSITIONS) {
      if (valid(t.lineup[pos])) continue;
      t.lineup[pos] = bench.shift() ?? null;
    }
  },
};

export const playerMock = {
  eventImpactScale(p: Player): number {
    return Math.max(0.2, Math.min(1.2, 1 - p.resilience / 150));
  },
  playerRating(p: Player, slot: Position): number {
    return p.power * (p.position === slot ? 1 : 0.85);
  },
};

/** 把整队首发的某属性设为同一值 */
export function setTeamAttr(state: GameState, teamId: string, attr: 'insight' | 'power' | 'resilience', value: number): void {
  for (const pid of state.teams[teamId].playerIds) state.players[pid][attr] = value;
}
