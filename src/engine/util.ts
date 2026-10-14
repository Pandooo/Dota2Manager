// 通用工具函数
import type { GameState } from './types';

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
export const avg = (arr: number[]) => (arr.length ? sum(arr) / arr.length : 0);
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * 按 id 取记录（只认自有属性）：RPC 参数可能是 '__proto__'、'constructor' 等原型上的键，
 * 直接 state.players[id] 会拿到内置对象并绕过「找不到」的判断。
 */
export function ownEntry<T>(rec: Record<string, T> | null | undefined, id: unknown): T | undefined {
  return rec && typeof id === 'string' && Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : undefined;
}

/** 生成状态内唯一 id */
export function nextId(state: GameState, prefix: string): string {
  state.idCounter += 1;
  return `${prefix}-${state.idCounter.toString(36)}`;
}

/** 名次百分位：0 = 冠军，1 = 垫底；并列区间取中点 */
export function placementPercentile(rankFrom: number, rankTo: number, teams: number): number {
  if (teams <= 1) return 0;
  const mid = (rankFrom + rankTo) / 2;
  return clamp((mid - 1) / (teams - 1), 0, 1);
}

/** 名次区间显示：1 → "冠军"，2 → "亚军"，[5,6] → "5-6名" */
export function formatRank(rankFrom: number, rankTo: number): string {
  if (rankFrom === 1 && rankTo === 1) return '冠军';
  if (rankFrom === 2 && rankTo === 2) return '亚军';
  if (rankFrom === 3 && rankTo === 3) return '季军';
  return rankFrom === rankTo ? `第${rankFrom}名` : `${rankFrom}-${rankTo}名`;
}

/** 金币格式化：1234567 → "123.5万" */
export function formatGold(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  return `${sign}${Math.round(a)}`;
}

// ---------------------------------------------------------------------------
// 日期（字符串 YYYY-MM-DD，按 UTC 计算）
// ---------------------------------------------------------------------------
export function parseDate(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(d: string, days: number): string {
  return formatDate(parseDate(d) + days * 86400000);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
export function compareDate(a: string, b: string): number {
  return parseDate(a) - parseDate(b);
}
export function yearOf(d: string): number {
  return Number(d.slice(0, 4));
}
