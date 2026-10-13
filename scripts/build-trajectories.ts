// 由全部 rosters/ti*.json 生成 src/data/trajectories.json（第九波「赛季自主成长」）：
// 真实选手 id → { TI 序号: { power, mmr, tier, pos? } }，记录该选手在每一届 TI 阵容数据（含替补与自由选手）中的水平。
// 引擎 development.ts 每个赛季开始时让真实选手向「当届真实水平」靠拢（相邻两届之间线性插值）。
// pos（第十三波「真实生涯位置」，roles.ts）：该届阵容数据中的位置，按「游程」压缩存储——只写在首届和位置发生变化的届次上，
// 其余届次沿用上一个出现的 pos（引擎 roles.realRoleHistory 展开）。全部 697 名真实选手约 1055 个 pos（2291 届次），比逐届写入少约 54%。
// 用法：npx tsx scripts/build-trajectories.ts（修改 rosters/ti*.json 后运行，见 AGENTS.md §4）
import { writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PlayerTrajectory, Position, SeedPlayer, TrajectoryPoint } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { tierOf } from '../src/engine/player';
import { ROSTER_DIR, readRosterSync } from './nodeData';

/** 由 roster 文件构建轨迹表（纯函数，测试可直接调用） */
export function buildTrajectories(rosters: { ti: number; players: SeedPlayer[] }[]): Record<string, PlayerTrajectory> {
  const out: Record<string, PlayerTrajectory> = {};
  /** 每一届的位置（游程压缩前） */
  const roles: Record<string, Record<number, Position>> = {};
  for (const { ti, players } of rosters.slice().sort((a, b) => a.ti - b.ti)) {
    for (const p of players) {
      if (!p?.id || !Number.isFinite(p.mmr) || !Number.isFinite(p.power)) continue;
      const traj = (out[p.id] ??= {});
      const prev = traj[ti];
      // 同一届重复出现（如同时列在战队与自由选手中）：取水平更高的记录（数据校验保证同一届位置一致）
      if (prev && prev.mmr + prev.power * 100 >= p.mmr + p.power * 100) continue;
      const point: TrajectoryPoint = { power: Math.round(p.power * 100) / 100, mmr: Math.round(p.mmr), tier: tierOf(p.mmr) };
      traj[ti] = point;
      if (POSITIONS.includes(p.position)) (roles[p.id] ??= {})[ti] = p.position;
    }
  }
  // 键排序，输出稳定；pos 只写在首届与位置变化的届次（游程压缩）
  const sorted: Record<string, PlayerTrajectory> = {};
  for (const id of Object.keys(out).sort()) {
    const traj: PlayerTrajectory = {};
    let last: Position | undefined;
    for (const k of Object.keys(out[id]).map(Number).sort((a, b) => a - b)) {
      const pos = roles[id]?.[k];
      traj[k] = pos && pos !== last ? { ...out[id][k], pos } : out[id][k];
      if (pos) last = pos;
    }
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
  const roles = ids.reduce((a, id) => a + Object.values(traj[id]).filter((x) => x.pos).length, 0);
  const changers = ids.filter((id) => new Set(Object.values(traj[id]).map((x) => x.pos).filter(Boolean)).size > 1).length;
  writeFileSync(join(ROSTER_DIR, '..', 'trajectories.json'), JSON.stringify(traj));
  console.log(`trajectories: ${ids.length} players, ${points} points, ${roles} role marks (${changers} players changed role) from TI ${tis.join(',')}`);
}

// 仅在直接运行时写文件（被测试 import 时不执行）
if (process.argv[1] && /build-trajectories\.ts$/.test(process.argv[1])) main();
