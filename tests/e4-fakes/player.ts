// E4 测试替身：player.ts 的简化实现（与真实实现解耦，保证 E4 单测独立可跑）
import type { GameState, ModAttr, Modifier, Player, Position, Region, Tier } from '../../src/engine/types';
import { TIERS } from '../../src/engine/types';
import { CONFIG } from '../../src/engine/config';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function tierOf(mmr: number): Tier {
  let t: Tier = 'C';
  for (const k of TIERS) if (mmr >= CONFIG.ladder.thresholds[k]) t = k;
  return t;
}
export function tierIndex(t: Tier): number {
  return TIERS.indexOf(t);
}
export function ladderMult(t: Tier): number {
  return CONFIG.ladder.multipliers[t];
}
export function ageOf(state: GameState, p: { birthYear: number }): number {
  return (state.season?.year ?? 2019) - p.birthYear;
}
export function effectiveAttr(p: Player, attr: ModAttr): number {
  let add = 0;
  let mul = 1;
  for (const m of p.modifiers ?? []) {
    if (m.attr !== attr) continue;
    if (m.kind === 'add') add += m.value;
    else mul *= m.value;
  }
  const v = ((p[attr] as number) + add) * mul;
  if (attr === 'power') return Math.max(1, v);
  if (attr === 'mmr') return clamp(v, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr);
  return clamp(v, 0, 100);
}
export function effectivePower(p: Player): number {
  return effectiveAttr(p, 'power');
}
export function playerTier(p: Player): Tier {
  return tierOf(effectiveAttr(p, 'mmr'));
}
export function playerRating(p: Player, slot: Position): number {
  return effectivePower(p) * ladderMult(playerTier(p)) * (slot === p.position ? 1 : CONFIG.team.offRoleFactor);
}
export function overallRating(p: Player): number {
  return playerRating(p, p.position);
}
export function eventImpactScale(p: Player): number {
  return clamp(1 - effectiveAttr(p, 'resilience') / 150, 0.2, 1.2);
}
let modCounter = 0;
export function addModifier(_state: GameState, p: Player, mod: Omit<Modifier, 'id'>): Modifier {
  const m = { ...mod, id: `m${++modCounter}` };
  p.modifiers.push(m);
  return m;
}
export function tickModifiers(): void {}
export function computeSalary(_state: GameState, p: Player, rookie?: boolean): number {
  return Math.round(CONFIG.economy.salaryByTier[tierOf(p.mmr)] * (rookie ? CONFIG.economy.rookieSalaryMult : 1));
}
export function marketValue(state: GameState, p: Player): number {
  return computeSalary(state, p) * CONFIG.economy.marketValueMult;
}
export function regionOfNationality(): Region {
  return 'CN';
}
export function clampPlayerAttrs(): void {}
export function isAvailable(p: Player, tournamentId?: string | null): boolean {
  return p.status === 'active' && !(tournamentId && p.unavailableTournamentIds?.includes(tournamentId));
}
