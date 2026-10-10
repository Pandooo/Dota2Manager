// E4 测试替身：honor / generation / growth / funEvents / data 的简化实现
import type {
  Coach, GameState, OpResult, PendingDecision, Player, PlayerIndexEntry, Position, Region, Team, Tier, TrainingGain,
} from '../../src/engine/types';
import { POSITIONS, TIERS } from '../../src/engine/types';
import { CONFIG } from '../../src/engine/config';
import { computeSalary } from './player';
import { addPlayerToTeam, autoLineup } from './team';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------- honor ----------------
export function honorLuck(honor: number): number {
  return clamp(Math.log10(1 + Math.max(0, honor) / 100), 0, CONFIG.honor.luckCap);
}
export function changeHonor(state: GameState, teamId: string, delta: number): void {
  const t = state.teams[teamId];
  if (!t) return;
  t.honor += Math.round(delta);
  if (!t.isPlayer) t.honor = Math.max(30, t.honor);
  else if (t.honor < 0 && !state.gameOver) {
    t.disbanded = true;
    state.gameOver = { reason: 'disbanded', summary: '解散' };
  }
}
export function applyBeefResult(): number {
  return 0;
}
export function expectedRank(): number {
  return 1;
}

// ---------------- generation ----------------
let gen = 0;
const MID_MMR: Record<Tier, number> = { C: 4800, B: 6000, A: 7200, S: 9500, SS: 13000, SSR: 16000 };
const POWER: Record<Tier, number> = { C: 50, B: 57, A: 64, S: 72, SS: 80, SSR: 88 };

export function generatePlayer(
  state: GameState,
  opts?: { tier?: Tier; position?: Position; age?: number; region?: Region; rookie?: boolean },
): Player {
  gen += 1;
  const tier = opts?.tier ?? 'B';
  const p: Player = {
    id: `gen${gen}`,
    handle: `Gen${gen}`,
    nationality: 'CN',
    region: opts?.region ?? 'CN',
    birthYear: (state.season?.year ?? 2019) - (opts?.age ?? (opts?.rookie ? 18 : 22)),
    position: opts?.position ?? POSITIONS[gen % 5],
    mmr: MID_MMR[tier],
    power: POWER[tier],
    talent: 60,
    resilience: 40,
    insight: 50,
    loyalty: 60,
    salary: 0,
    contractUntil: state.season?.ti ?? 9,
    teamId: null,
    status: 'active',
    modifiers: [],
    signatureHeroes: [],
    stats: { matches: 0, wins: 0, titles: 0, tiTitles: 0, mvp: 0 },
    joinedSeason: state.season?.ti ?? 9,
    isReal: false,
    isRookie: opts?.rookie || undefined,
  };
  p.salary = computeSalary(state, p, opts?.rookie);
  state.players[p.id] = p;
  return p;
}
export function randomTier(): Tier {
  return 'B';
}
export function generateCoach(state: GameState, opts?: { tier?: Tier }): Coach {
  gen += 1;
  const c: Coach = {
    id: `gc${gen}`, name: `Coach${gen}`, nationality: 'CN', birthYear: 1985, tier: opts?.tier ?? 'A', insight: 60,
    talentBoost: 4, resilienceBoost: 4, salary: 4000, teamId: null,
  };
  state.coaches[c.id] = c;
  return c;
}
export function generateAiTeam(state: GameState, region: Region, strength: 'weak' | 'mid' | 'strong'): Team {
  gen += 1;
  const id = `gt${gen}`;
  const team: Team = {
    id, name: `GenTeam${gen}`, tag: `G${gen}`, region, color: '#fff', honor: 150, gold: 600000, isPlayer: false,
    playerIds: [], lineup: { C: null, M: null, O: null, SS: null, HS: null }, coachId: null, points: 0,
  };
  state.teams[id] = team;
  const tier: Tier = strength === 'strong' ? 'S' : strength === 'mid' ? 'A' : 'B';
  for (const pos of POSITIONS) {
    const p = generatePlayer(state, { tier, position: pos, region });
    addPlayerToTeam(state, p.id, id, { salary: p.salary, contractSeasons: 2 });
  }
  autoLineup(state, id);
  return team;
}
export function rookieFromIndex(state: GameState, entry: PlayerIndexEntry): Player {
  const p = generatePlayer(state, { tier: 'A', position: entry.position, rookie: true });
  delete state.players[p.id];
  p.id = entry.id;
  p.handle = entry.handle;
  p.isReal = true;
  p.isRookie = true;
  state.players[p.id] = p;
  return p;
}
export function coachFromRetiredPlayer(state: GameState, p: Player): Coach {
  const c = generateCoach(state, { tier: 'A' });
  c.formerPlayerId = p.id;
  c.name = p.handle;
  return c;
}
export { TIERS };

// ---------------- growth ----------------
export const trainCalls: { teamId: string; focus: string; gainMult?: { power?: number; mmr?: number; insight?: number }; attrMult?: number }[] = [];
export function trainTeam(
  _state: GameState, teamId: string, focus: string, _mult?: number,
  opts?: { gainMult?: { power?: number; mmr?: number; insight?: number }; attrMult?: number },
): TrainingGain[] {
  trainCalls.push({ teamId, focus, gainMult: opts?.gainMult, attrMult: opts?.attrMult });
  return [];
}
export function sessionTrainOptions(session: 'free' | 'extra' | null | undefined): { attrMult: number } | undefined {
  return session === 'extra' ? { attrMult: CONFIG.training.extraSessionAttrMult } : undefined;
}
export function adjustLoyalty(p: Player, delta: number): void {
  p.loyalty = clamp(p.loyalty + delta, 0, 100);
}

// ---------------- funEvents ----------------
/** 调用记录：events 测试据此断言 rollRoundEvents 每次都滚动无厘头事件、resolveDecision 正确转交 */
export const funCalls: { roll: number; resolved: { decisionId: string; choiceId: string }[] } = { roll: 0, resolved: [] };
export function rollFunEvents(): void {
  funCalls.roll += 1;
}
export function resolveFunDecision(state: GameState, decision: PendingDecision, choiceId?: string): OpResult {
  funCalls.resolved.push({ decisionId: decision.id, choiceId: choiceId ?? '' });
  state.pendingDecisions = state.pendingDecisions.filter((d) => d.id !== decision.id);
  return { ok: true, message: 'fun' };
}

// ---------------- data ----------------
export const playerIndex: PlayerIndexEntry[] = [];
export function getPlayerIndex(): PlayerIndexEntry[] {
  return playerIndex;
}
