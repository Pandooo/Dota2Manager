// 由全部 rosters/ti*.json 生成 src/data/coachIndex.json（第九波 #3 教练供给）：
// 每名真实教练（各届战队主教练 + 自由教练）出现在哪些届 roster、当届等级与灵性。
// 引擎在每个赛季开始时把「该届 roster 中尚未进入游戏的真实教练」引入教练市场（src/engine/coaches.ts），
// roster 文件体积较大且为异步加载，故预先生成这份同步可读的小索引。
// 用法：npx tsx scripts/build-coach-index.ts
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedCoach } from '../src/engine/types';
import type { CoachIndexEntry } from '../src/data/index';
import { ROSTER_DIR, readRosterSync } from './nodeData';

const tis = readdirSync(ROSTER_DIR)
  .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

const index = new Map<string, CoachIndexEntry>();
const conflicts: string[] = [];

for (const ti of tis) {
  const roster = readRosterSync(ti);
  const all: SeedCoach[] = [
    ...roster.teams.map((t) => t.coach).filter((c): c is SeedCoach => !!c && !!c.id),
    ...(roster.freeCoaches ?? []).filter((c) => !!c?.id),
  ];
  const seen = new Set<string>();
  for (const c of all) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const prev = index.get(c.id);
    if (!prev) {
      index.set(c.id, { id: c.id, name: c.name, nationality: c.nationality, birthYear: c.birthYear, apps: [[ti, c.tier, c.insight]] });
    } else {
      if (prev.birthYear !== c.birthYear) conflicts.push(`${c.id}: birthYear ${prev.birthYear} vs ${c.birthYear} (TI${ti})`);
      prev.name = c.name; // 最新名字
      prev.apps.push([ti, c.tier, c.insight]);
    }
  }
}

const out = [...index.values()].sort((a, b) => a.apps[0][0] - b.apps[0][0] || a.id.localeCompare(b.id));
writeFileSync(join(ROSTER_DIR, '..', 'coachIndex.json'), JSON.stringify(out, null, 0));
console.log(`coachIndex: ${out.length} coaches from TI ${tis.join(',')}`);
if (conflicts.length) {
  console.log(`\n${conflicts.length} identity conflicts:`);
  for (const c of conflicts) console.log('  ' + c);
}
