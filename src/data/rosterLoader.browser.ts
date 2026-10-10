// 浏览器端 roster 加载器：Vite import.meta.glob 懒加载 rosters/ti{n}.json
import type { RosterFile } from '../engine/types';
import { registerRosterLoader } from './index';

const modules = import.meta.glob('./rosters/ti*.json') as Record<string, () => Promise<{ default: RosterFile }>>;

const tis = Object.keys(modules)
  .map((k) => Number(/ti(\d+)\.json$/.exec(k)?.[1]))
  .filter((n) => Number.isFinite(n));

registerRosterLoader(async (ti) => {
  const key = `./rosters/ti${ti}.json`;
  const load = modules[key];
  if (!load) throw new Error(`缺少 TI${ti} 阵容数据`);
  const mod = await load();
  return mod.default;
}, tis);
