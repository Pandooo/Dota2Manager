// 数据校验：npx tsx scripts/validate-data.ts
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HeroInfo, PatchInfo, PlayerIndexEntry, PlayerTrajectory, Position, RosterFile, TiInfo, TournamentTemplate } from '../src/engine/types';
import { POSITIONS, REGIONS } from '../src/engine/types';
import { ROSTER_DIR, readRosterSync } from './nodeData';
import { brandOrgs, brandingProblems } from '../src/engine/branding';
import { buildTrajectories } from './build-trajectories';

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

// 真实生涯位置（第十三波，src/data/trajectories.json 的 pos，游程压缩）与生涯轨迹：与全部 roster 一致（由 scripts/build-trajectories.ts 生成，
// 不要手改）；每名选手首届必有 pos；playerIndex.position（首次出现时的位置）= 首届 pos；同一届同一选手位置一致
{
  const trajFile = read<Record<string, PlayerTrajectory>>('trajectories.json');
  const rebuilt = buildTrajectories(rosterTis.map((ti) => {
    const r = readRosterSync(ti);
    return { ti, players: [...r.teams.flatMap((t) => t.players), ...(r.freeAgents ?? [])] };
  }));
  if (JSON.stringify(rebuilt) !== JSON.stringify(trajFile)) err('trajectories.json 与 rosters 不一致：请运行 npx tsx scripts/build-trajectories.ts');
  const index = read<PlayerIndexEntry[]>('playerIndex.json');
  const byId = new Map(index.map((e) => [e.id, e]));
  let changers = 0;
  for (const [id, traj] of Object.entries(trajFile)) {
    const tis2 = Object.keys(traj).map(Number).sort((a, b) => a - b);
    if (!tis2.length) { err(`trajectories ${id}: 没有任何届次`); continue; }
    const first = traj[tis2[0]];
    if (!first.pos) err(`trajectories ${id}: 首届 TI${tis2[0]} 缺少 pos`);
    const roles = new Set<Position>();
    for (const k of tis2) {
      const pos = traj[k].pos;
      if (pos === undefined) continue;
      if (!POSITIONS.includes(pos)) err(`trajectories ${id} TI${k}: pos ${pos} 无效`);
      roles.add(pos);
    }
    if (roles.size > 1) changers++;
    const e = byId.get(id);
    if (!e) err(`trajectories ${id}: playerIndex 中没有该选手`);
    else if (first.pos && e.position !== first.pos) err(`playerIndex ${id}: position ${e.position} ≠ 首届位置 ${first.pos}`);
  }
  for (const e of index) if (!trajFile[e.id]) err(`playerIndex ${e.id}: trajectories 中没有该选手`);
  // 同一届同一选手（同时列在战队与自由选手中）位置必须一致，否则「当届真实位置」有歧义
  for (const ti of rosterTis) {
    const r = readRosterSync(ti);
    const posOf = new Map<string, Position>();
    for (const p of [...r.teams.flatMap((t) => t.players), ...(r.freeAgents ?? [])]) {
      const prev = posOf.get(p.id);
      if (prev && prev !== p.position) err(`ti${ti} ${p.id}: 同一届位置不一致（${prev} / ${p.position}）`);
      posOf.set(p.id, p.position);
    }
  }
  console.log(`真实生涯位置：${Object.keys(trajFile).length} 名选手，其中 ${changers} 名在真实生涯中换过位置`);
  // clubIndex.json（新俱乐部签回真实选手时优先用其中的当届位置，clubs.bringBackRealPlayer）与逐届真实位置一致：
  // roster 位置变动后若只重建了轨迹、没有重建俱乐部索引，这里会报错
  const exact = new Map<string, Map<number, Position>>();
  for (const [id, traj] of Object.entries(trajFile)) {
    const m = new Map<number, Position>();
    let cur: Position | undefined;
    for (const k of Object.keys(traj).map(Number).sort((a, b) => a - b)) {
      cur = traj[k].pos ?? cur;
      if (cur) m.set(k, cur);
    }
    exact.set(id, m);
  }
  type ClubApp = [number, string, string, string, string, string, number, number, number, string, string[], string | null, Position[]];
  const clubs = read<{ orgs: { id: string; apps: ClubApp[] }[] }>('clubIndex.json');
  let clubChecked = 0;
  for (const org of clubs.orgs ?? []) {
    for (const app of org.apps ?? []) {
      const [ti, teamId, , , , , , , , , players, , positions] = app;
      (players ?? []).forEach((pid, i) => {
        const want = exact.get(pid)?.get(ti);
        if (!want || !positions?.[i]) return;
        clubChecked++;
        if (positions[i] !== want) err(`clubIndex ${org.id} TI${ti} ${teamId} ${pid}: 位置 ${positions[i]} ≠ 当届真实位置 ${want}（请运行 npx tsx scripts/build-club-index.ts）`);
      });
    }
  }
  console.log(`俱乐部索引位置：核对 ${clubChecked} 条`);
}

// 俱乐部品牌变迁（第十波 #4，src/data/branding.json）：结构合法，teamIds 都是 roster 中出现过的战队 id
{
  for (const p of brandingProblems()) err(`branding: ${p}`);
  const known = new Set<string>();
  for (const ti of rosterTis) for (const t of readRosterSync(ti).teams) known.add(t.id);
  for (const org of brandOrgs()) for (const id of org.teamIds) if (!known.has(id)) err(`branding ${org.id}: 战队 id ${id} 不在任何 roster 中`);
}

// 名人堂初始成员（src/data/hallOfFame.json，2026-10-14 抽卡回归）：id 不重复；source = roster 的 id 必须是真实选手且有生涯轨迹
// （handle 与 playerIndex 一致）；source = seed 的 id 不能与任何真实选手重名（可以是真实教练：如 2009 在阵容数据中是教练，
// 选手与教练是不同的命名空间），等级合法、合成轨迹数值完整、招牌英雄存在
{
  type HofSeed = {
    id?: string; handle?: string; era?: string; source?: string; name?: string; nationality?: string; birthYear?: number;
    position?: string; debutTier?: string; peakTier?: string; talent?: number; insight?: number; resilience?: number;
    power?: { debut?: number; peak?: number; peakYear?: number; declineFromYear?: number }; signatureHeroes?: string[];
  };
  const TIER_LIST = ['C', 'B', 'A', 'S', 'SS', 'SSR'];
  const hof = read<{ seeds?: HofSeed[] }>('hallOfFame.json');
  const seeds = Array.isArray(hof.seeds) ? hof.seeds : [];
  if (!seeds.length) err('hallOfFame.json: seeds 为空');
  const index = read<PlayerIndexEntry[]>('playerIndex.json');
  const byId = new Map(index.map((e) => [e.id, e]));
  const traj = read<Record<string, PlayerTrajectory>>('trajectories.json');
  const seen = new Set<string>();
  for (const s of seeds) {
    const tag = `hallOfFame ${s?.id ?? '?'}`;
    if (!s?.id || typeof s.id !== 'string') { err(`${tag}: 缺少 id`); continue; }
    if (seen.has(s.id)) err(`${tag}: id 重复`);
    seen.add(s.id);
    if (!s.handle) err(`${tag}: 缺少 handle`);
    if (s.era !== 'dota1') err(`${tag}: era 应为 dota1`);
    if (s.source === 'roster') {
      const e = byId.get(s.id);
      if (!e) err(`${tag}: source=roster 但不是真实选手（playerIndex 中没有）`);
      else if (e.handle !== s.handle) warn(`${tag}: handle ${s.handle} 与 playerIndex 的 ${e.handle} 不一致`);
      if (!traj[s.id] || !Object.keys(traj[s.id]).length) err(`${tag}: 没有真实生涯轨迹（trajectories.json）`);
    } else if (s.source === 'seed') {
      if (byId.has(s.id)) err(`${tag}: source=seed 但与真实选手 id 重名`);
      if (!s.debutTier || !TIER_LIST.includes(s.debutTier)) err(`${tag}: debutTier 无效`);
      if (!s.peakTier || !TIER_LIST.includes(s.peakTier)) err(`${tag}: peakTier 无效`);
      else if (s.debutTier && TIER_LIST.indexOf(s.peakTier) < TIER_LIST.indexOf(s.debutTier)) err(`${tag}: peakTier 低于 debutTier`);
      if (!s.position || !(POSITIONS as string[]).includes(s.position)) err(`${tag}: position 无效`);
      if (!s.nationality || !/^[A-Z]{2}$/.test(s.nationality)) err(`${tag}: nationality 应为两位大写国家代码`);
      if (!Number.isFinite(s.birthYear) || s.birthYear! < 1970 || s.birthYear! > 2010) err(`${tag}: birthYear 无效`);
      const pw = s.power;
      if (!pw || ![pw.debut, pw.peak, pw.peakYear, pw.declineFromYear].every((v) => Number.isFinite(v))) err(`${tag}: power 需要 debut / peak / peakYear / declineFromYear`);
      else {
        if (pw.peak! < pw.debut!) err(`${tag}: power.peak 低于 debut`);
        if (pw.peakYear! < 1 || pw.declineFromYear! <= pw.peakYear!) err(`${tag}: 需要 1 ≤ peakYear < declineFromYear`);
      }
      for (const k of ['talent', 'insight', 'resilience'] as const) {
        const v = s[k];
        if (v !== undefined && (!Number.isFinite(v) || v < 0 || v > 100)) err(`${tag}: ${k} 应在 0..100`);
      }
      for (const h of s.signatureHeroes ?? []) if (!heroIds.has(h)) err(`${tag}: 招牌英雄 ${h} 不在 heroes.json 中`);
    } else {
      err(`${tag}: source 应为 roster 或 seed`);
    }
  }
  console.log(`名人堂初始成员：${seeds.length} 人`);
}

console.log(`heroes ${heroes.length}, patches ${patches.length}, tis ${tis.length}, rosters ${rosterTis.join(',')}`);
if (warns.length) console.log(`\nWARN (${warns.length}):\n` + warns.slice(0, 80).map((w) => '  ' + w).join('\n'));
if (errors.length) {
  console.log(`\nERROR (${errors.length}):\n` + errors.slice(0, 120).map((e) => '  ' + e).join('\n'));
  process.exit(1);
}
console.log('\n数据校验通过');
