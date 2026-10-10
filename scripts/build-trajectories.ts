// 由全部 rosters/ti*.json 生成 src/data/trajectories.json（第九波「赛季自主成长」）：
// 真实选手 id → { TI 序号: { power, mmr, tier } }，记录该选手在每一届 TI 阵容数据（含替补与自由选手）中的水平。
// 引擎 development.ts 每个赛季开始时让真实选手向「当届真实水平」靠拢（相邻两届之间线性插值）。
// 用法：npx tsx scripts/build-trajectories.ts
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerTrajectory, SeedPlayer, TrajectoryPoint } from '../src/engine/types';
import { tierOf } from '../src/engine/player';
import { ROSTER_DIR, readRosterSync } from './nodeData';

/** 由 roster 文件构建轨迹表（纯函数，测试可直接调用） */
export function buildTrajectories(rosters: { ti: number; players: SeedPlayer[] }[]): Record<string, PlayerTrajectory> {
  const out: Record<string, PlayerTrajectory> = {};
  for (const { ti, players } of rosters.slice().sort((a, b) => a.ti - b.ti)) {
    for (const p of players) {
      if (!p?.id || !Number.isFinite(p.mmr) || !Number.isFinite(p.power)) continue;
      const traj = (out[p.id] ??= {});
      const prev = traj[ti];
      // 同一届重复出现（如同时列在战队与自由选手中）：取水平更高的记录
      if (prev && prev.mmr + prev.power * 100 >= p.mmr + p.power * 100) continue;
      const point: TrajectoryPoint = { power: Math.round(p.power * 100) / 100, mmr: Math.round(p.mmr), tier: tierOf(p.mmr) };
      traj[ti] = point;
    }
  }
  // 键排序，输出稳定
  const sorted: Record<string, PlayerTrajectory> = {};
  for (const id of Object.keys(out).sort()) {
    const traj: PlayerTrajectory = {};
    for (const k of Object.keys(out[id]).map(Number).sort((a, b) => a - b)) traj[k] = out[id][k];
    sorted[id] = traj;
  }
  return sorted;
}

function main(): void {
  const tis = readdirSync(ROSTER_DIR)
    .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const rosters = tis.map((ti) => {
    const r = readRosterSync(ti);
    return { ti, players: [...(r.teams ?? []).flatMap((t) => t.players ?? []), ...(r.freeAgents ?? [])] };
  });
  const traj = buildTrajectories(rosters);
  const ids = Object.keys(traj);
  const points = ids.reduce((a, id) => a + Object.keys(traj[id]).length, 0);
  writeFileSync(join(ROSTER_DIR, '..', 'trajectories.json'), JSON.stringify(traj));
  console.log(`trajectories: ${ids.length} players, ${points} points from TI ${tis.join(',')}`);
}

// 仅在直接运行时写文件（被测试 import 时不执行）
if (process.argv[1] && /build-trajectories\.ts$/.test(process.argv[1])) main();
