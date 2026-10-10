// 由全部 rosters/ti*.json 生成 src/data/playerIndex.json：
// 每名真实选手的首次出现 TI、首次战力、峰值战力/天赋等，用于「真实新秀」在未来赛季登场。
// 用法：npx tsx scripts/build-player-index.ts
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerIndexEntry, SeedPlayer } from '../src/engine/types';
import { ROSTER_DIR, readRosterSync } from './nodeData';

const tis = readdirSync(ROSTER_DIR)
  .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

const index = new Map<string, PlayerIndexEntry>();
const conflicts: string[] = [];

for (const ti of tis) {
  const roster = readRosterSync(ti);
  const teamOf = new Map<string, string>();
  for (const t of roster.teams) for (const p of t.players) teamOf.set(p.id, t.id);
  const all: SeedPlayer[] = [...roster.teams.flatMap((t) => t.players), ...(roster.freeAgents ?? [])];
  for (const p of all) {
    const prev = index.get(p.id);
    if (!prev) {
      index.set(p.id, {
        id: p.id,
        handle: p.handle,
        name: p.name,
        nationality: p.nationality,
        birthYear: p.birthYear,
        firstTi: ti,
        position: p.position,
        firstPower: p.power,
        peakPower: p.power,
        peakTalent: p.talent,
        insight: p.insight,
        signatureHeroes: p.signatureHeroes ?? [],
        ...(teamOf.has(p.id) ? { firstTeamId: teamOf.get(p.id) } : {}),
      });
    } else {
      if (prev.birthYear !== p.birthYear) conflicts.push(`${p.id}: birthYear ${prev.birthYear} (TI${prev.firstTi}) vs ${p.birthYear} (TI${ti})`);
      if (prev.nationality !== p.nationality) conflicts.push(`${p.id}: nationality ${prev.nationality} vs ${p.nationality} (TI${ti})`);
      prev.peakPower = Math.max(prev.peakPower, p.power);
      prev.peakTalent = Math.max(prev.peakTalent, p.talent);
      prev.handle = p.handle; // 最新 handle
    }
  }
}

const out = [...index.values()].sort((a, b) => a.firstTi - b.firstTi || a.id.localeCompare(b.id));
writeFileSync(join(ROSTER_DIR, '..', 'playerIndex.json'), JSON.stringify(out, null, 0));
console.log(`playerIndex: ${out.length} players from TI ${tis.join(',')}`);
if (conflicts.length) {
  console.log(`\n${conflicts.length} identity conflicts:`);
  for (const c of conflicts) console.log('  ' + c);
}
