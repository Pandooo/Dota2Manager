import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PatchInfo } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makePlayer, makeTestState } from './helpers';

const mocks = vi.hoisted(() => ({ real: [] as unknown[] }));

vi.mock('../src/data/index', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/data/index')>();
  return { ...orig, getRealPatches: vi.fn(() => mocks.real) };
});
vi.mock('../src/engine/heroes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/engine/heroes')>();
  return { ...orig, generateHeroMeta: vi.fn(() => ({ axe: 1.5 })) };
});

import { allPatches, applyPatch, patchAt, patchByVersion, patchesInRange, resetPatchCache } from '../src/engine/patches';
import { addDays, compareDate, daysBetween } from '../src/engine/util';

function versionKey(v: string): number {
  const m = /^(\d+)\.(\d+)/.exec(v)!;
  return Number(m[1]) * 1000 + Number(m[2]);
}

function unit(v = 1) {
  return { C: v, M: v, O: v, SS: v, HS: v };
}

beforeEach(() => {
  mocks.real = [];
  resetPatchCache();
});

describe('patches: 版本列表', () => {
  it('无真实数据时使用离线版本史 + 推演，日期与版本号单调', () => {
    const all = allPatches();
    expect(all.length).toBeGreaterThan(40);
    expect(all[0].version).toBe('6.72');
    const versions = new Set<string>();
    for (let i = 0; i < all.length; i++) {
      const p = all[i];
      expect(versions.has(p.version)).toBe(false);
      versions.add(p.version);
      for (const pos of POSITIONS) {
        expect(p.powerMult[pos]).toBeGreaterThan(0);
        expect(p.insightMult[pos]).toBeGreaterThan(0);
      }
      if (i > 0) {
        expect(compareDate(p.date, all[i - 1].date)).toBeGreaterThan(0);
        expect(versionKey(p.version)).toBeGreaterThan(versionKey(all[i - 1].version));
      }
    }
    const last = all[all.length - 1];
    expect(compareDate(last.date, CONFIG.patch.futureUntil)).toBeLessThanOrEqual(0);
    expect(compareDate(addDays(last.date, CONFIG.patch.futureIntervalDays), CONFIG.patch.futureUntil)).toBeGreaterThan(0);
  });

  it('推演版本：间隔固定、倍数在区间内、projected', () => {
    const future = allPatches().filter((p) => p.projected);
    expect(future.length).toBeGreaterThan(5);
    const [lo, hi] = CONFIG.patch.futureMultRange;
    for (let i = 1; i < future.length; i++) {
      expect(daysBetween(future[i - 1].date, future[i].date)).toBe(CONFIG.patch.futureIntervalDays);
    }
    // 均值守恒（CONFIG.patch.meanPreserving）：倍数先在 [lo, hi] 内随机，再除以几何平均 →
    // 五个位置乘积 ≈ 1，最大/最小之比仍 ≤ hi/lo，单项最多偏出区间 (hi/lo)^(4/5) 倍
    const spread = hi / lo;
    for (const p of future) {
      const vals = POSITIONS.map((pos) => p.powerMult[pos]);
      const prod = vals.reduce((a, b) => a * b, 1);
      if (CONFIG.patch.meanPreserving) expect(Math.abs(prod - 1)).toBeLessThan(2e-3);
      expect(Math.max(...vals) / Math.min(...vals)).toBeLessThanOrEqual(spread + 1e-3);
      for (const v of vals) {
        expect(v).toBeGreaterThanOrEqual(lo / Math.pow(spread, 0.8) - 1e-3);
        expect(v).toBeLessThanOrEqual(hi * Math.pow(spread, 0.8) + 1e-3);
      }
      expect(p.title).toContain('推演');
    }
  });

  it('结果确定（重建缓存后完全一致）', () => {
    const a = JSON.stringify(allPatches());
    resetPatchCache();
    const b = JSON.stringify(allPatches());
    expect(a).toBe(b);
  });

  it('有真实数据时：按日期排序、补齐倍数、之后递增推演', () => {
    mocks.real = [
      { version: '7.36', date: '2024-05-22', title: '命石', summary: 's', powerMult: { ...unit(), O: 0.98 }, insightMult: unit() },
      { version: '7.35', date: '2023-12-14', title: 'x', summary: 's', powerMult: { C: 1.02 } as PatchInfo['powerMult'], insightMult: unit() },
      { version: 'bad', date: 'not-a-date' },
    ];
    const all = allPatches();
    expect(all[0].version).toBe('7.35');
    // 缺失位置补 1，再做均值守恒：相对强弱不变（C 比其他位置高 2%），五位置乘积 ≈ 1
    expect(all[0].powerMult.C / all[0].powerMult.M).toBeCloseTo(1.02, 3);
    expect(all[0].powerMult.M).toBe(all[0].powerMult.HS);
    const prod = POSITIONS.reduce((a, pos) => a * all[0].powerMult[pos], 1);
    expect(prod).toBeCloseTo(1, 3);
    expect(all[1].version).toBe('7.36');
    expect(all[2].version).toBe('7.37');
    expect(all[2].projected).toBe(true);
    expect(all.some((p) => p.version === 'bad')).toBe(false);
  });

  it('patchAt / patchesInRange / patchByVersion', () => {
    const all = allPatches();
    const p = patchAt('2019-01-01');
    expect(compareDate(p.date, '2019-01-01')).toBeLessThanOrEqual(0);
    const next = all[all.indexOf(p) + 1];
    expect(compareDate(next.date, '2019-01-01')).toBeGreaterThan(0);
    expect(patchAt('1990-01-01')).toBe(all[0]);
    const range = patchesInRange('2018-01-01', '2019-01-01');
    expect(range.length).toBeGreaterThan(0);
    for (const r of range) expect(r.date >= '2018-01-01' && r.date < '2019-01-01').toBe(true);
    expect(patchByVersion(p.version)).toBe(p);
    expect(patchByVersion('nope')).toBeUndefined();
  });
});

describe('patches: applyPatch', () => {
  it('按位置永久修改所有 active 选手（含自由选手），只应用一次', () => {
    mocks.real = [
      { version: '7.33', date: '2023-04-20', title: '新地形', summary: '地图扩大', powerMult: { ...unit(), C: 1.1, O: 0.9 }, insightMult: { ...unit(), HS: 1.05 }, major: true },
    ];
    const state = makeTestState(2);
    const fa = makePlayer({ id: 'fa', position: 'C', power: 50, insight: 40 });
    const retired = makePlayer({ id: 'old', position: 'C', power: 50, status: 'retired' });
    state.players.fa = fa;
    state.players.old = retired;
    const carryBefore = state.players['t0-C'].power;
    const offBefore = state.players['t0-O'].power;
    const hsInsight = state.players['t0-HS'].insight;
    const midBefore = state.players['t0-M'].power;

    // 实际倍数为均值守恒后的值（C/O 的相对加强削弱不变）
    const info = patchByVersion('7.33')!;
    expect(info.powerMult.C / info.powerMult.M).toBeCloseTo(1.1, 3);
    expect(info.powerMult.O / info.powerMult.M).toBeCloseTo(0.9, 3);
    applyPatch(state, '7.33');
    expect(state.players['t0-C'].power).toBeCloseTo(carryBefore * info.powerMult.C, 1);
    expect(state.players['t0-O'].power).toBeCloseTo(offBefore * info.powerMult.O, 1);
    expect(state.players['t0-M'].power).toBeCloseTo(midBefore * info.powerMult.M, 1);
    expect(state.players['t0-HS'].insight).toBeCloseTo(Math.min(100, hsInsight * info.insightMult.HS), 1);
    expect(fa.power).toBeCloseTo(50 * info.powerMult.C, 1);
    expect(retired.power).toBe(50);
    expect(state.currentPatch).toBe('7.33');
    expect(state.appliedPatches).toContain('7.33');
    expect(state.heroMeta).toEqual({ axe: 1.5 });
    expect(state.popups).toContainEqual({ kind: 'patch', version: '7.33' });
    expect(state.news[0].category).toBe('patch');
    expect(state.news[0].important).toBe(true);

    const after = state.players['t0-C'].power;
    applyPatch(state, '7.33');
    expect(state.players['t0-C'].power).toBe(after);
    expect(state.popups.filter((p) => p.kind === 'patch')).toHaveLength(1);
    // 未知版本：无操作
    applyPatch(state, '9.99');
    expect(state.currentPatch).toBe('7.33');
  });
});
