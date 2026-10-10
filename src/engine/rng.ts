// 可复现随机数：种子保存在 GameState.rngState。引擎内禁止使用 Math.random()。
import type { GameState } from './types';

export interface Rng {
  /** [0,1) */
  next(): number;
  /** [min, max) 浮点 */
  range(min: number, max: number): number;
  /** [min, max] 整数 */
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(arr: readonly T[]): T;
  /** 按权重选择，weights 与 items 等长 */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  shuffle<T>(arr: T[]): T[];
  /** 正态分布 */
  normal(mean: number, sd: number): number;
}

function mulberry32Step(s: number): [number, number] {
  let t = (s + 0x6d2b79f5) | 0;
  const nextState = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, nextState];
}

/** 基于任意状态读写器构造 Rng */
export function makeRng(get: () => number, set: (s: number) => void): Rng {
  const next = () => {
    const [v, s] = mulberry32Step(get());
    set(s);
    return v;
  };
  const rng: Rng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    chance: (p) => next() < p,
    pick: (arr) => {
      if (arr.length === 0) throw new Error('rng.pick on empty array');
      return arr[Math.floor(next() * arr.length)];
    },
    weighted: (items, weights) => {
      if (items.length === 0) throw new Error('rng.weighted on empty array');
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return items[Math.floor(next() * items.length)];
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i]);
        if (r < 0) return items[i];
      }
      return items[items.length - 1];
    },
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
    normal: (mean, sd) => {
      const u = Math.max(1e-9, next());
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
  return rng;
}

/** 绑定到 GameState 的 Rng（每次取数都会写回 state.rngState） */
export function rngOf(state: GameState): Rng {
  return makeRng(() => state.rngState, (s) => { state.rngState = s; });
}

/** 独立 Rng（用于测试、版本 meta 生成等与存档无关的确定性随机） */
export function seededRng(seed: number): Rng {
  let s = seed | 0;
  return makeRng(() => s, (v) => { s = v; });
}

/** 字符串 → 32 位种子 */
export function hashSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
