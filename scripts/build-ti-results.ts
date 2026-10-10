// 由全部 rosters/ti*.json 生成 src/data/tiResults.json（DotaPedia「开局前（现实）」）：
// 每届 TI 的真实正赛名次（SeedTeam.tiResult）与当届首发，供 pedia.ts 在不加载 roster 的情况下
// 给出战队 / 选手在开局之前的真实 TI 履历（roster 文件按 TI 懒加载，引擎同步查询无法读取）。
// 用法：npx tsx scripts/build-ti-results.ts
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedTeam } from '../src/engine/types';
import { ROSTER_DIR, readRosterSync } from './nodeData';

/** 一支 TI 正赛队伍：[战队 id, 战队名, 名次（如 "1" "5-6"）, 当届首发 id] */
export type TiResultRow = [string, string, string, string[]];

/** 由某届 roster 的战队列表构建该届名次表（纯函数，测试可直接调用）：只取 atTI 且有名次的战队，按名次排序 */
export function buildTiResultRows(teams: SeedTeam[]): TiResultRow[] {
  const rows: TiResultRow[] = [];
  for (const t of teams ?? []) {
    if (!t?.id || !t.atTI || typeof t.tiResult !== 'string' || !/^\d+(-\d+)?$/.test(t.tiResult)) continue;
    const starters = (t.players ?? []).slice(0, 5).map((p) => p?.id).filter((x): x is string => typeof x === 'string' && !!x);
    rows.push([t.id, t.name ?? t.id, t.tiResult, starters]);
  }
  const from = (r: TiResultRow) => Number(r[2].split('-')[0]);
  rows.sort((a, b) => from(a) - from(b) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

function main(): void {
  const tis = readdirSync(ROSTER_DIR)
    .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const out: Record<string, TiResultRow[]> = {};
  let n = 0;
  for (const ti of tis) {
    const rows = buildTiResultRows(readRosterSync(ti).teams ?? []);
    out[String(ti)] = rows;
    n += rows.length;
  }
  const json = {
    _meta: {
      description: 'DotaPedia「开局前（现实）」：每届 TI 的真实正赛名次与当届首发（由 scripts/build-ti-results.ts 从 rosters/ti*.json 的 tiResult 生成，roster 变动后需重新生成）。',
      format: 'tis[TI 序号] = [[战队 id, 战队名, 名次, [首发 id × 5]], …]，按名次排序',
    },
    tis: out,
  };
  writeFileSync(join(ROSTER_DIR, '..', 'tiResults.json'), `${JSON.stringify(json)}\n`);
  console.log(`tiResults: ${n} rows from TI ${tis.join(',')}`);
}

// 仅在直接运行时写文件（被测试 import 时不执行）
if (process.argv[1] && /build-ti-results\.ts$/.test(process.argv[1])) main();
