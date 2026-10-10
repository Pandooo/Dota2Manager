// 数据校验：npx tsx scripts/validate-data.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HeroInfo, PatchInfo, RosterFile, TiInfo, TournamentTemplate } from '../src/engine/types';
import { POSITIONS, REGIONS } from '../src/engine/types';
import { ROSTER_DIR, readRosterSync } from './nodeData';

const DATA = join(ROSTER_DIR, '..');
const read = <T,>(f: string): T => JSON.parse(readFileSync(join(DATA, f), 'utf8')) as T;
const errors: string[] = [];
const warns: string[] = [];
const err = (m: string) => errors.push(m);
const warn = (m: string) => warns.push(m);

const heroes = read<HeroInfo[]>('heroes.json');
const heroIds = new Set(heroes.map((h) => h.id));
if (heroIds.size !== heroes.length) err('heroes: duplicate ids');
for (const h of heroes) {
  if (!h.cn) err(`hero ${h.id}: missing cn`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(h.releaseDate)) err(`hero ${h.id}: bad releaseDate`);
  for (const pos of POSITIONS) if (typeof h.positions?.[pos] !== 'number') err(`hero ${h.id}: positions.${pos}`);
}

const patches = read<PatchInfo[]>('patches.json');
let lastDate = '';
const versions = new Set<string>();
for (const p of patches) {
  if (versions.has(p.version)) err(`patch dup ${p.version}`);
  versions.add(p.version);
  if (p.date < lastDate) warn(`patch ${p.version} not sorted by date`);
  lastDate = p.date;
  for (const pos of POSITIONS) {
    const a = p.powerMult?.[pos], b = p.insightMult?.[pos];
    if (!(a >= 0.9 && a <= 1.1)) err(`patch ${p.version}: powerMult.${pos}=${a}`);
    if (!(b >= 0.9 && b <= 1.1)) err(`patch ${p.version}: insightMult.${pos}=${b}`);
  }
  for (const h of [...(p.heroBuffs ?? []), ...(p.heroNerfs ?? []), ...(p.newHeroes ?? [])]) if (!heroIds.has(h)) warn(`patch ${p.version}: unknown hero ${h}`);
}

const tis = read<TiInfo[]>('tis.json');
for (const t of tis) {
  const slots = Object.values(t.qualifierSlots ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  if (slots + t.directInvites !== t.teams) err(`TI${t.ti}: invites ${t.directInvites} + slots ${slots} != teams ${t.teams}`);
}

for (let n = 1; n <= 16; n++) {
  const f = `tournaments/season${n}.json`;
  if (!existsSync(join(DATA, f))) continue;
  const list = read<TournamentTemplate[]>(f);
  const ids = new Set<string>();
  for (const t of list) {
    if (ids.has(t.id)) err(`${f}: dup id ${t.id}`);
    ids.add(t.id);
    if (!REGIONS.includes(t.hostRegion)) err(`${f} ${t.id}: hostRegion ${t.hostRegion}`);
    if (t.teams < 4 || t.teams > 24) err(`${f} ${t.id}: teams ${t.teams}`);
    if (t.invites > t.teams) err(`${f} ${t.id}: invites > teams`);
    if ((t.tier as string) === 'ti') err(`${f} ${t.id}: tier ti not allowed`);
  }
  if (list.length && list.length < 8) warn(`${f}: only ${list.length} events`);
}

const rosterTis = readdirSync(ROSTER_DIR).map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1])).filter(Number.isFinite).sort((a, b) => a - b);
for (const ti of rosterTis) {
  const r: RosterFile = readRosterSync(ti);
  const seen = new Set<string>();
  const tag = `ti${ti}`;
  const tiInfo = tis.find((t) => t.ti === ti);
  const atTi = r.teams.filter((t) => t.atTI).length;
  if (tiInfo && atTi !== tiInfo.teams) warn(`${tag}: atTI teams ${atTi} vs tis.json ${tiInfo.teams}`);
  for (const team of r.teams) {
    if (team.players.length < 5) err(`${tag} ${team.id}: <5 players`);
    const pos = new Set(team.players.slice(0, 5).map((p) => p.position));
    if (pos.size !== 5) err(`${tag} ${team.id}: first 5 positions not unique (${[...pos].join(',')})`);
    if (!REGIONS.includes(team.region)) err(`${tag} ${team.id}: region ${team.region}`);
    for (const p of team.players) {
      if (seen.has(p.id)) err(`${tag}: duplicate player ${p.id}`);
      seen.add(p.id);
      for (const h of p.signatureHeroes ?? []) if (!heroIds.has(h)) warn(`${tag} ${p.id}: unknown hero ${h}`);
      if (!(p.power > 20 && p.power <= 100)) err(`${tag} ${p.id}: power ${p.power}`);
      if (!(p.mmr >= 3000 && p.mmr <= 20000)) err(`${tag} ${p.id}: mmr ${p.mmr}`);
    }
  }
  for (const p of r.freeAgents ?? []) {
    if (seen.has(p.id)) err(`${tag}: free agent duplicate ${p.id}`);
    seen.add(p.id);
  }
}

console.log(`heroes ${heroes.length}, patches ${patches.length}, tis ${tis.length}, rosters ${rosterTis.join(',')}`);
if (warns.length) console.log(`\nWARN (${warns.length}):\n` + warns.slice(0, 80).map((w) => '  ' + w).join('\n'));
if (errors.length) {
  console.log(`\nERROR (${errors.length}):\n` + errors.slice(0, 120).map((e) => '  ' + e).join('\n'));
  process.exit(1);
}
console.log('\n数据校验通过');
