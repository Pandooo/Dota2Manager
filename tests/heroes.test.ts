import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeroInfo, PatchInfo } from '../src/engine/types';

// 用可变的数据源模拟 heroes.json（heroes.ts 按数组引用失效缓存）
const holder = vi.hoisted(() => ({ heroes: [] as unknown[] }));
vi.mock('../src/data', () => ({ getHeroes: () => holder.heroes }));

import {
  FALLBACK_HEROES, MIN_HERO_POOL, availableHeroes, fillHeroMeta, generateHeroMeta, heroById, heroMetaValue, heroName,
  usingFallbackHeroes,
} from '../src/engine/heroes';

const ONES = { C: 1, M: 1, O: 1, SS: 1, HS: 1 };
function patch(over: Partial<PatchInfo> = {}): PatchInfo {
  return { version: '7.20', date: '2018-11-01', title: '测试', summary: '', powerMult: ONES, insightMult: ONES, ...over };
}

function hero(id: string, cn: string, releaseDate: string): HeroInfo {
  return {
    id, name: id, cn, attr: 'agi', positions: { C: 1, M: 0.2, O: 0, SS: 0, HS: 0 }, styles: ['late'], releaseDate, complexity: 1,
  };
}

describe('heroes: 空数据兜底', () => {
  beforeEach(() => {
    holder.heroes = [];
  });

  it('heroes.json 为空时使用内置英雄表', () => {
    expect(FALLBACK_HEROES.length).toBeGreaterThanOrEqual(30);
    const list = availableHeroes('2011-08-01');
    expect(list.length).toBeGreaterThanOrEqual(MIN_HERO_POOL);
    expect(usingFallbackHeroes()).toBe(true);
    expect(new Set(list.map((h) => h.id)).size).toBe(list.length);
    expect(heroName('anti-mage')).toBe('敌法师');
    expect(heroName('natures-prophet')).toBe('先知');
    expect(heroById('invoker')?.positions.M).toBe(1);
  });

  it('未知 id 返回 id 本身', () => {
    expect(heroName('no-such-hero')).toBe('no-such-hero');
    expect(heroById('no-such-hero')).toBeUndefined();
  });
});

describe('heroes: 真实数据', () => {
  it('按上线日期过滤，数量不足时以兜底英雄补齐', () => {
    holder.heroes = [hero('alpha', '阿尔法', '2010-01-01'), hero('beta', '贝塔', '2020-05-01')];
    const early = availableHeroes('2015-01-01').map((h) => h.id);
    expect(early).toContain('alpha');
    expect(early).not.toContain('beta');
    expect(early.length).toBeGreaterThanOrEqual(MIN_HERO_POOL);
    expect(availableHeroes('2021-01-01').map((h) => h.id)).toContain('beta');
    expect(heroName('beta')).toBe('贝塔');
    expect(usingFallbackHeroes()).toBe(false);
  });

  it('早期日期（如 2011 年初）只补到 MIN_HERO_POOL，且优先补最早即将上线的真实英雄', () => {
    // 真实数据覆盖全部兜底英雄：前 20 个 2011-01-01 上线，其余逐月上线
    holder.heroes = FALLBACK_HEROES.map((h, i) => ({
      ...h,
      releaseDate: i < 20 ? '2011-01-01' : `${2011 + Math.floor((i - 20) / 9)}-${String(((i - 20) % 9) + 3).padStart(2, '0')}-15`,
    }));
    const list = availableHeroes('2011-02-01');
    expect(list.length).toBe(MIN_HERO_POOL);
    const early = list.filter((h) => h.releaseDate > '2011-02-01').map((h) => h.releaseDate).sort();
    expect(early).toHaveLength(MIN_HERO_POOL - 20);
    // 补进来的是最早上线的那几个（不会出现一两年后才上线的英雄）
    const upcoming = (holder.heroes as HeroInfo[]).map((h) => h.releaseDate).filter((d) => d > '2011-02-01').sort();
    expect(early).toEqual(upcoming.slice(0, MIN_HERO_POOL - 20));
    expect(new Set(list.map((h) => h.id)).size).toBe(list.length);
    // 足够多时不补
    expect(availableHeroes('2014-01-01').every((h) => h.releaseDate <= '2014-01-01')).toBe(true);
  });

  it('数据缺字段不崩溃', () => {
    holder.heroes = [{ id: 'weird', name: 'Weird' }];
    expect(heroName('weird')).toBe('Weird');
    const h = heroById('weird');
    expect(h?.positions.C).toBe(0);
    expect(h?.styles).toEqual([]);
  });
});

describe('heroes: 版本强度', () => {
  beforeEach(() => {
    holder.heroes = [];
  });

  it('确定性、范围 -2..2、只含已上线英雄', () => {
    const a = generateHeroMeta(patch(), '2018-11-01');
    const b = generateHeroMeta(patch(), '2018-11-01');
    expect(a).toEqual(b);
    const ids = Object.keys(a);
    expect(ids.length).toBe(availableHeroes('2018-11-01').length);
    for (const v of Object.values(a)) {
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThanOrEqual(2);
    }
    const other = generateHeroMeta(patch({ version: '7.21' }), '2018-11-01');
    expect(other).not.toEqual(a);
  });

  it('单个英雄的强度与当时有哪些英雄已上线无关；fillHeroMeta 补齐版本期间新上线的英雄', () => {
    holder.heroes = FALLBACK_HEROES.map((h, i) => ({ ...h, releaseDate: i < 35 ? '2018-01-01' : '2018-12-01' }));
    const p = patch({ newHeroes: [FALLBACK_HEROES[36].id] });
    const early = generateHeroMeta(p, '2018-11-01');
    const late = generateHeroMeta(p, '2019-01-01');
    expect(Object.keys(early).length).toBeLessThan(Object.keys(late).length);
    for (const [id, v] of Object.entries(early)) expect(late[id]).toBe(v);
    for (const [id, v] of Object.entries(late)) expect(heroMetaValue(p, id)).toBe(v);
    // 补齐：缺失的英雄得到与完整生成相同的数值（含新英雄加成），已有数值不变
    const meta = { ...early };
    expect(fillHeroMeta(meta, p, '2019-01-01')).toBe(Object.keys(late).length - Object.keys(early).length);
    expect(meta).toEqual(late);
    expect(fillHeroMeta(meta, p, '2019-01-01')).toBe(0);
    // 空表 = 无版本强度数据，不补
    const empty: Record<string, number> = {};
    expect(fillHeroMeta(empty, p, '2019-01-01')).toBe(0);
    expect(empty).toEqual({});
  });

  it('加强/削弱/新英雄修正', () => {
    const ids = availableHeroes('2018-11-01').map((h) => h.id);
    const first = ids[0]; // 按 id 排序的第一个英雄：之前没有额外随机消耗，基础值相同
    const base = generateHeroMeta(patch(), '2018-11-01')[first];
    const buffed = generateHeroMeta(patch({ heroBuffs: [first] }), '2018-11-01')[first];
    const nerfed = generateHeroMeta(patch({ heroNerfs: [first] }), '2018-11-01')[first];
    const fresh = generateHeroMeta(patch({ newHeroes: [first] }), '2018-11-01')[first];
    expect(buffed).toBeGreaterThanOrEqual(Math.min(2, base + 0.79));
    expect(nerfed).toBeLessThanOrEqual(Math.max(-2, base - 0.79));
    expect(fresh).toBeCloseTo(Math.min(2, base + 1), 1);
  });
});
