// E4 测试替身：team.ts 的简化实现
import type { Coach, GameState, Player, Position, Team } from '../../src/engine/types';
import { POSITIONS } from '../../src/engine/types';
import { CONFIG } from '../../src/engine/config';
import { isAvailable, overallRating, playerRating } from './player';

export function getPlayerTeam(state: GameState): Team {
  return state.teams[state.settings.playerTeamId];
}
export function teamPlayers(state: GameState, teamId: string): Player[] {
  const t = state.teams[teamId];
  if (!t) return [];
  return t.playerIds.map((id) => state.players[id]).filter((p): p is Player => !!p && p.status === 'active');
}
export function lineupPlayers(state: GameState, teamId: string): { pos: Position; player: Player | null }[] {
  const t = state.teams[teamId];
  return POSITIONS.map((pos) => ({ pos, player: (t?.lineup[pos] && state.players[t.lineup[pos]!]) || null }));
}
export function benchPlayers(state: GameState, teamId: string): Player[] {
  const t = state.teams[teamId];
  const starters = new Set(POSITIONS.map((p) => t?.lineup[p]));
  return teamPlayers(state, teamId).filter((p) => !starters.has(p.id));
}
export function autoLineup(state: GameState, teamId: string, tournamentId?: string | null): void {
  const t = state.teams[teamId];
  if (!t) return;
  const cands = teamPlayers(state, teamId)
    .filter((p) => isAvailable(p, tournamentId))
    .sort((a, b) => overallRating(b) - overallRating(a));
  const used = new Set<string>();
  for (const pos of POSITIONS) {
    const p = cands.find((c) => c.position === pos && !used.has(c.id));
    t.lineup[pos] = p ? p.id : null;
    if (p) used.add(p.id);
  }
  for (const pos of POSITIONS) {
    if (t.lineup[pos]) continue;
    const p = cands.find((c) => !used.has(c.id));
    t.lineup[pos] = p ? p.id : null;
    if (p) used.add(p.id);
  }
}
export function validateLineup(state: GameState, teamId: string, tournamentId?: string | null): string[] {
  const t = state.teams[teamId];
  if (!t) return ['战队不存在'];
  const errs: string[] = [];
  for (const pos of POSITIONS) {
    const id = t.lineup[pos];
    const p = id ? state.players[id] : null;
    if (!p) errs.push(`${pos} 空缺`);
    else if (!isAvailable(p, tournamentId)) errs.push(`${p.handle} 无法参赛`);
  }
  return errs;
}
export function setLineupSlot(): void {}
export function teamRating(state: GameState, teamId: string): number {
  return lineupPlayers(state, teamId).reduce((s, x) => s + (x.player ? playerRating(x.player, x.pos) : 0), 0);
}
export function teamInsight(): number {
  return 50;
}
export function addPlayerToTeam(
  state: GameState,
  playerId: string,
  teamId: string,
  opts?: { salary?: number; contractSeasons?: number },
): void {
  const p = state.players[playerId];
  const t = state.teams[teamId];
  if (!p || !t) return;
  if (p.teamId && p.teamId !== teamId) removePlayerFromTeam(state, playerId);
  p.teamId = teamId;
  p.joinedSeason = state.season.ti;
  if (opts?.salary !== undefined) p.salary = opts.salary;
  p.contractUntil = state.season.ti + (opts?.contractSeasons ?? 2) - 1;
  if (!t.playerIds.includes(playerId)) t.playerIds.push(playerId);
  if (!t.lineup[p.position]) t.lineup[p.position] = playerId;
}
export function removePlayerFromTeam(state: GameState, playerId: string): void {
  const p = state.players[playerId];
  for (const t of Object.values(state.teams)) {
    const i = t.playerIds.indexOf(playerId);
    if (i >= 0) t.playerIds.splice(i, 1);
    for (const pos of POSITIONS) if (t.lineup[pos] === playerId) t.lineup[pos] = null;
  }
  if (p) {
    if (p.teamId) p.lastTeamId = p.teamId;
    p.teamId = null;
  }
}
export function rosterSize(state: GameState, teamId: string): number {
  return teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament).length;
}
export function rosterRoom(state: GameState, teamId: string): number {
  return CONFIG.team.maxRoster - rosterSize(state, teamId);
}
export function rosterHardRoom(state: GameState, teamId: string): number {
  return CONFIG.team.hardMaxRoster - rosterSize(state, teamId);
}
export function rosterSigningBlock(state: GameState, teamId: string): string | null {
  if (!state.teams[teamId]) return '战队不存在';
  return rosterHardRoom(state, teamId) > 0 ? null : `阵容已达绝对上限（${CONFIG.team.hardMaxRoster} 人），请先解约或出售选手`;
}
export function rosterOverflowNotice(state: GameState, teamId: string): string | null {
  const n = rosterSize(state, teamId);
  return n > CONFIG.team.maxRoster ? `阵容 ${n}/${CONFIG.team.maxRoster}：超出常规上限，替补归属感下降更快、工资照付` : null;
}
export function rosterSigningNote(): string | null {
  return null;
}
export function activeTeams(state: GameState): Team[] {
  return Object.values(state.teams).filter((t) => !t.disbanded);
}
export function rankTeamsByRating(state: GameState, teamIds?: string[]): string[] {
  const ids = teamIds ?? activeTeams(state).map((t) => t.id);
  return ids.slice().sort((a, b) => teamRating(state, b) - teamRating(state, a));
}
export function getCoach(state: GameState, teamId: string): Coach | null {
  const id = state.teams[teamId]?.coachId;
  return id ? state.coaches[id] ?? null : null;
}
