// 英雄池与版本强度【E2 负责实现】
import type { HeroInfo, HeroStyle, PatchInfo, Position } from './types';
import { POSITIONS } from './types';
import { getHeroes } from '../data';
import { hashSeed, seededRng } from './rng';
import { clamp, round2 } from './util';

// ---------------------------------------------------------------------------
// 内置兜底英雄（heroes.json 为空或某日期可用英雄过少时使用，保证 BP 能完成）
// ---------------------------------------------------------------------------

/** 兜底英雄上线日期：早于 TI1，任何赛季均可用 */
const FALLBACK_RELEASE = '2010-01-01';

/** BP 至少需要 10 禁 10 选，留一些余量 */
export const MIN_HERO_POOL = 30;

type FB = [id: string, name: string, cn: string, attr: HeroInfo['attr'], fit: [number, number, number, number, number], styles: HeroStyle[], complexity: 1 | 2 | 3];

const FALLBACK_RAW: FB[] = [
  ['anti-mage', 'Anti-Mage', '敌法师', 'agi', [1, 0.2, 0, 0, 0], ['late', 'splitpush'], 2],
  ['phantom-assassin', 'Phantom Assassin', '幻影刺客', 'agi', [1, 0.4, 0.1, 0, 0], ['late', 'pickoff'], 1],
  ['juggernaut', 'Juggernaut', '主宰', 'agi', [1, 0.3, 0, 0, 0], ['late', 'sustain', 'push'], 1],
  ['faceless-void', 'Faceless Void', '虚空假面', 'agi', [0.95, 0.3, 0.3, 0, 0], ['late', 'teamfight', 'control'], 2],
  ['spectre', 'Spectre', '幽鬼', 'agi', [1, 0.1, 0.2, 0, 0], ['late', 'teamfight'], 1],
  ['medusa', 'Medusa', '美杜莎', 'agi', [1, 0.4, 0, 0, 0], ['late', 'teamfight'], 2],
  ['morphling', 'Morphling', '变体精灵', 'agi', [1, 0.5, 0, 0, 0], ['late', 'tempo'], 3],
  ['luna', 'Luna', '露娜', 'agi', [1, 0.3, 0, 0, 0], ['push', 'teamfight'], 1],
  ['naga-siren', 'Naga Siren', '娜迦海妖', 'agi', [0.9, 0, 0, 0.2, 0.3], ['late', 'splitpush', 'push'], 2],
  ['drow-ranger', 'Drow Ranger', '卓尔游侠', 'agi', [0.9, 0.3, 0, 0, 0], ['push', 'tempo'], 1],
  ['shadow-fiend', 'Shadow Fiend', '影魔', 'agi', [0.6, 1, 0, 0, 0], ['tempo', 'late', 'teamfight'], 2],
  ['templar-assassin', 'Templar Assassin', '圣堂刺客', 'agi', [0.6, 1, 0, 0, 0], ['early', 'tempo', 'push'], 2],
  ['invoker', 'Invoker', '祈求者', 'int', [0.2, 1, 0, 0, 0], ['teamfight', 'control', 'tempo'], 3],
  ['queen-of-pain', 'Queen of Pain', '痛苦女王', 'int', [0.2, 1, 0, 0, 0], ['gank', 'tempo', 'early'], 2],
  ['storm-spirit', 'Storm Spirit', '风暴之灵', 'int', [0.2, 1, 0, 0, 0], ['pickoff', 'tempo', 'late'], 3],
  ['puck', 'Puck', '帕克', 'int', [0, 1, 0.3, 0, 0], ['control', 'teamfight', 'tempo'], 3],
  ['tinker', 'Tinker', '修补匠', 'int', [0, 1, 0, 0, 0], ['splitpush', 'tempo', 'late'], 3],
  ['tidehunter', 'Tidehunter', '潮汐猎人', 'str', [0, 0, 1, 0.2, 0.2], ['teamfight', 'control'], 1],
  ['axe', 'Axe', '斧王', 'str', [0, 0, 1, 0.4, 0], ['early', 'control', 'teamfight'], 1],
  ['sand-king', 'Sand King', '沙王', 'str', [0, 0, 0.9, 0.6, 0], ['teamfight', 'control'], 2],
  ['dark-seer', 'Dark Seer', '黑暗贤者', 'int', [0, 0, 1, 0, 0], ['teamfight', 'control'], 2],
  ['bristleback', 'Bristleback', '钢背兽', 'str', [0.5, 0.2, 1, 0, 0], ['sustain', 'late'], 1],
  ['natures-prophet', "Nature's Prophet", '先知', 'int', [0.5, 0.3, 0.6, 0.6, 0.2], ['push', 'splitpush'], 2],
  ['enigma', 'Enigma', '谜团', 'int', [0, 0, 0.7, 0.6, 0.4], ['teamfight', 'control'], 2],
  ['batrider', 'Batrider', '蝙蝠骑士', 'int', [0, 0.4, 0.8, 0.5, 0], ['pickoff', 'control'], 3],
  ['earthshaker', 'Earthshaker', '撼地者', 'str', [0, 0, 0.6, 1, 0.4], ['teamfight', 'control'], 2],
  ['rubick', 'Rubick', '拉比克', 'int', [0, 0.1, 0, 1, 0.5], ['control', 'pickoff'], 3],
  ['mirana', 'Mirana', '米拉娜', 'agi', [0.3, 0.3, 0, 1, 0.4], ['pickoff', 'gank'], 2],
  ['spirit-breaker', 'Spirit Breaker', '裂魂人', 'str', [0, 0, 0.3, 1, 0.3], ['gank', 'pickoff'], 1],
  ['pudge', 'Pudge', '帕吉', 'str', [0, 0.5, 0.3, 0.8, 0.3], ['gank', 'pickoff'], 2],
  ['lion', 'Lion', '莱恩', 'int', [0, 0, 0, 0.8, 0.9], ['pickoff', 'control', 'gank'], 1],
  ['vengeful-spirit', 'Vengeful Spirit', '复仇之魂', 'agi', [0, 0, 0, 0.8, 0.9], ['early', 'pickoff', 'push'], 1],
  ['crystal-maiden', 'Crystal Maiden', '水晶室女', 'int', [0, 0, 0, 0.6, 1], ['teamfight', 'early'], 1],
  ['lich', 'Lich', '巫妖', 'int', [0, 0, 0, 0.6, 1], ['early', 'teamfight'], 1],
  ['shadow-shaman', 'Shadow Shaman', '暗影萨满', 'int', [0, 0, 0, 0.8, 1], ['push', 'control'], 1],
  ['witch-doctor', 'Witch Doctor', '巫医', 'int', [0, 0, 0, 0.7, 1], ['teamfight', 'sustain'], 1],
  ['dazzle', 'Dazzle', '戴泽', 'agi', [0, 0, 0, 0.6, 1], ['sustain', 'teamfight'], 2],
  ['io', 'Io', '艾欧', 'str', [0, 0, 0, 0.7, 0.9], ['tempo', 'sustain'], 3],
  ['chen', 'Chen', '陈', 'int', [0, 0, 0, 0.6, 0.8], ['push', 'early', 'sustain'], 3],
  ['treant-protector', 'Treant Protector', '树精卫士', 'str', [0, 0, 0.2, 0.6, 0.9], ['sustain', 'early'], 1],
];

export const FALLBACK_HEROES: HeroInfo[] = FALLBACK_RAW.map(([id, name, cn, attr, fit, styles, complexity]) => ({
  id,
  name,
  cn,
  attr,
  positions: { C: fit[0], M: fit[1], O: fit[2], SS: fit[3], HS: fit[4] },
  styles,
  releaseDate: FALLBACK_RELEASE,
  complexity,
}));

// ---------------------------------------------------------------------------
// 缓存（数据源引用变化时自动失效，便于测试 mock）
// ---------------------------------------------------------------------------
let cacheSource: HeroInfo[] | null = null;
let heroMap = new Map<string, HeroInfo>();
let sortedAll: HeroInfo[] = [];
let fallbackOnly = true;
const availableCache = new Map<string, HeroInfo[]>();
const AVAILABLE_CACHE_MAX = 64;

/** 按 id 码点排序（不用 localeCompare：不同运行环境的排序规则可能不同，会影响版本强度的可复现性） */
function byId(a: HeroInfo, b: HeroInfo): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 规范化一条英雄数据（缺字段时补默认值，避免下游崩溃） */
function normalizeHero(h: HeroInfo): HeroInfo {
  const positions = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const v = Number(h.positions?.[pos]);
    positions[pos] = Number.isFinite(v) ? clamp(v, 0, 1) : 0;
  }
  return {
    ...h,
    cn: h.cn || h.name || h.id,
    name: h.name || h.id,
    positions,
    styles: Array.isArray(h.styles) ? h.styles : [],
    releaseDate: typeof h.releaseDate === 'string' && h.releaseDate.length >= 10 ? h.releaseDate : FALLBACK_RELEASE,
  };
}

function ensureCache(): void {
  let source: HeroInfo[];
  try {
    const raw = getHeroes();
    source = Array.isArray(raw) ? raw : [];
  } catch {
    source = [];
  }
  if (source === cacheSource) return;
  cacheSource = source;
  availableCache.clear();
  heroMap = new Map();
  // 兜底先入，真实数据覆盖（同 id 以真实数据为准）
  for (const h of FALLBACK_HEROES) heroMap.set(h.id, h);
  const real: HeroInfo[] = [];
  for (const raw of source) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    const h = normalizeHero(raw);
    heroMap.set(h.id, h);
    real.push(h);
  }
  // 真实数据为空 → 全部使用兜底；否则只用真实数据（兜底仅在可用英雄不足时补充）
  fallbackOnly = real.length === 0;
  sortedAll = (fallbackOnly ? FALLBACK_HEROES.slice() : real).sort(byId);
}

/** 是否正在使用内置兜底英雄表 */
export function usingFallbackHeroes(): boolean {
  ensureCache();
  return fallbackOnly;
}

export function heroById(id: string): HeroInfo | undefined {
  ensureCache();
  return heroMap.get(id);
}

/** 中文名（未知 id 返回 id） */
export function heroName(id: string): string {
  ensureCache();
  return heroMap.get(id)?.cn ?? id;
}

/**
 * 指定日期已上线的英雄（按 id 排序；返回的数组为缓存共享，调用方不得修改）。
 * 已上线英雄不足 MIN_HERO_POOL 时（如 2011 年初 Dota 2 测试期）只补到 MIN_HERO_POOL，保证 BP 可完成：
 * 先补真实数据中没有的内置兜底英雄（无上线日期概念），再补「最早即将上线」的真实英雄（时代错位最小）。
 * 真实数据覆盖了全部兜底英雄时，不会出现提前数月甚至数年「上线」的英雄。
 */
export function availableHeroes(date: string): HeroInfo[] {
  ensureCache();
  const key = date || '';
  const cached = availableCache.get(key);
  if (cached) return cached;
  let list = key ? sortedAll.filter((h) => h.releaseDate <= key) : sortedAll.slice();
  if (list.length < MIN_HERO_POOL) {
    const have = new Set(list.map((h) => h.id));
    const realIds = new Set(sortedAll.map((h) => h.id));
    const timeless = fallbackOnly ? [] : FALLBACK_HEROES.filter((h) => !realIds.has(h.id));
    const upcoming = sortedAll
      .filter((h) => !have.has(h.id))
      .sort((a, b) => (a.releaseDate < b.releaseDate ? -1 : a.releaseDate > b.releaseDate ? 1 : byId(a, b)));
    const extra: HeroInfo[] = [];
    for (const h of [...timeless, ...upcoming]) {
      if (list.length + extra.length >= MIN_HERO_POOL) break;
      if (have.has(h.id)) continue;
      extra.push(h);
      have.add(h.id);
    }
    list = list.concat(extra).sort(byId);
  }
  if (availableCache.size >= AVAILABLE_CACHE_MAX) availableCache.clear();
  availableCache.set(key, list);
  return list;
}

// ---------------------------------------------------------------------------
// 版本强度
// ---------------------------------------------------------------------------
const META = {
  /** 英雄固有强度（跨版本稳定）权重 */
  intrinsicSd: 0.35,
  /** 版本随机波动 σ */
  patchSd: 0.6,
  buffRange: [0.8, 1.5] as [number, number],
  nerfRange: [0.8, 1.5] as [number, number],
  newHeroBonus: 1,
  min: -2,
  max: 2,
};

/**
 * 单个英雄在某版本的强度（-2..+2）：固有强度 + 版本波动（种子 = 版本号 + 英雄 id），
 * heroBuffs +0.8~1.5、heroNerfs -0.8~1.5，新英雄 +1。与其他英雄是否已上线无关，
 * 因此版本期间才上线的英雄也能得到与「版本生效时就已上线」完全相同的数值。
 */
export function heroMetaValue(patch: PatchInfo | undefined, heroId: string): number {
  const version = String(patch?.version ?? '');
  // 固有强度：每个英雄独立种子，跨版本保持一定延续性
  const intrinsic = seededRng(hashSeed(`hero:${heroId}`)).normal(0, META.intrinsicSd);
  const rng = seededRng(hashSeed(`${version}|${heroId}`));
  let v = intrinsic + rng.normal(0, META.patchSd);
  if (patch?.heroBuffs?.includes(heroId)) v += rng.range(META.buffRange[0], META.buffRange[1]);
  if (patch?.heroNerfs?.includes(heroId)) v -= rng.range(META.nerfRange[0], META.nerfRange[1]);
  if (patch?.newHeroes?.includes(heroId)) v += META.newHeroBonus;
  return round2(clamp(v, META.min, META.max));
}

/**
 * 生成版本英雄强度表（-2..+2，见 heroMetaValue）；只包含 date 时已上线英雄。
 * 版本期间新上线的英雄由 fillHeroMeta 补齐（BP 开始时自动调用）。
 */
export function generateHeroMeta(patch: PatchInfo, date: string): Record<string, number> {
  const meta: Record<string, number> = {};
  for (const h of availableHeroes(date)) meta[h.id] = heroMetaValue(patch, h.id);
  return meta;
}

/**
 * 为 meta 表补齐 date 时已上线、但表中缺失的英雄（版本生效后才上线的英雄），原地修改并返回补齐数量。
 * 空表视为「无版本强度数据」（全部按 0 处理），不补齐。
 */
export function fillHeroMeta(meta: Record<string, number>, patch: PatchInfo | undefined, date: string): number {
  if (!meta || !patch || Object.keys(meta).length === 0) return 0;
  let n = 0;
  for (const h of availableHeroes(date)) {
    if (Number.isFinite(meta[h.id])) continue;
    meta[h.id] = heroMetaValue(patch, h.id);
    n++;
  }
  return n;
}
