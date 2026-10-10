// Dota2 版本更新【E5 负责实现】
// 真实版本来自 data/patches.json；之后按固定间隔推演未来版本。若真实数据缺失，使用内置的离线版本史（倍数推演）。
import type { GameState, PatchInfo, Position, Season } from './types';
import { POSITIONS } from './types';
import { CONFIG, POSITION_LABEL, POSITION_SHORT } from './config';
import { getRealPatches } from '../data/index';
import { hashSeed, seededRng, type Rng } from './rng';
import { addDays, clamp, compareDate, parseDate } from './util';
import { generateHeroMeta } from './heroes';
import { addNews, pushPopup } from './news';

/**
 * 离线版本史（patches.json 为空时的兜底）：[版本号, 发布日期(近似), 中文标题]。
 * 倍数由 seededRng(hashSeed(version)) 推演，结果确定。
 */
const OFFLINE_HISTORY: [string, string, string][] = [
  ['6.72', '2011-08-01', '经典 DotA 移植版本'],
  ['6.73', '2011-12-21', '物品与英雄平衡调整'],
  ['6.74', '2012-03-01', '野区与英雄数值调整'],
  ['6.75', '2012-09-29', '新英雄与机制调整'],
  ['6.76', '2012-12-18', '推进与防御塔调整'],
  ['6.77', '2013-05-01', '大量英雄重做'],
  ['6.78', '2013-07-24', '肉山与经济调整'],
  ['6.79', '2013-11-06', '金钱与经验平衡'],
  ['6.80', '2014-01-29', '辅助经济改动'],
  ['6.81', '2014-04-29', '物品合成路线调整'],
  ['6.82', '2014-09-24', '地图大改：野区与神符'],
  ['6.83', '2014-12-17', '英雄平衡与新物品'],
  ['6.84', '2015-04-30', '大量新物品上线'],
  ['6.85', '2015-09-24', '平衡性调整'],
  ['6.86', '2015-12-16', '新英雄与新物品'],
  ['6.87', '2016-04-25', '中期节奏调整'],
  ['6.88', '2016-06-12', '经验与击杀奖励调整'],
  ['7.00', '2016-12-12', '新纪元：天赋树与全新地图'],
  ['7.02', '2017-02-08', '天赋树平衡'],
  ['7.04', '2017-03-23', '经济与神符调整'],
  ['7.05', '2017-04-09', '英雄平衡调整'],
  ['7.06', '2017-05-15', '物品与英雄调整'],
  ['7.07', '2017-10-31', '双英雄更新与地图调整'],
  ['7.08', '2018-02-01', '前期节奏调整'],
  ['7.10', '2018-03-01', '平衡性调整'],
  ['7.13', '2018-04-12', '双周更新'],
  ['7.16', '2018-05-24', '双周更新'],
  ['7.19', '2018-07-29', 'TI8 版本'],
  ['7.20', '2018-11-19', '全英雄大改'],
  ['7.21', '2019-01-29', '野区与神符调整'],
  ['7.22', '2019-05-24', '新英雄与全面平衡'],
  ['7.23', '2019-11-26', '前哨与中立物品'],
  ['7.24', '2020-01-26', '平衡性调整'],
  ['7.25', '2020-03-17', '神符与赏金调整'],
  ['7.27', '2020-06-29', '中立物品重做'],
  ['7.28', '2020-12-17', '新英雄与地图扩展'],
  ['7.29', '2021-04-09', '新英雄与平衡'],
  ['7.30', '2021-08-18', 'TI10 版本'],
  ['7.31', '2022-02-23', '新英雄与平衡'],
  ['7.32', '2022-08-24', '新英雄与地图调整'],
  ['7.33', '2023-04-20', '新地形：地图大扩张'],
  ['7.34', '2023-08-08', 'TI12 前平衡'],
  ['7.35', '2023-12-14', '新英雄与全面平衡'],
  ['7.36', '2024-05-22', '先天技能与命石'],
  ['7.37', '2024-08-01', 'TI13 版本'],
  ['7.38', '2025-02-19', '地图与机制大改'],
  ['7.39', '2025-05-22', '新英雄与平衡'],
];

/** 推演版本主题 */
const FUTURE_THEMES = [
  '地图改动与野区重做', '物品平衡调整', '天赋与命石调整', '肉山与魔方调整', '经济系统改动',
  '中立物品更替', '兵线与防御塔调整', '新英雄登场', '神符机制调整', '全英雄平衡性更新',
];

let cache: PatchInfo[] | null = null;
let byVersion: Map<string, PatchInfo> | null = null;

/** 清空缓存（测试用 / 数据热更新后） */
export function resetPatchCache(): void {
  cache = null;
  byVersion = null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function unitMults(): Record<Position, number> {
  return { C: 1, M: 1, O: 1, SS: 1, HS: 1 };
}

/**
 * 均值守恒：各位置倍数除以其几何平均（五个位置的乘积 = 1），版本只改变位置间的相对强弱，
 * 多个版本累积也不会让全联盟战力/灵性整体通胀或通缩（CONFIG.patch.meanPreserving）。
 */
export function meanPreservingMults(m: Record<Position, number>): Record<Position, number> {
  if (!CONFIG.patch.meanPreserving) return m;
  let logSum = 0;
  for (const pos of POSITIONS) logSum += Math.log(m[pos] > 0 ? m[pos] : 1);
  const gm = Math.exp(logSum / POSITIONS.length);
  if (!Number.isFinite(gm) || gm <= 0 || Math.abs(gm - 1) < 1e-9) return m;
  const out = unitMults();
  for (const pos of POSITIONS) out[pos] = Math.round(((m[pos] > 0 ? m[pos] : 1) / gm) * 10000) / 10000;
  return out;
}

function rollMults(rng: Rng): Record<Position, number> {
  const [lo, hi] = CONFIG.patch.futureMultRange;
  const m = unitMults();
  for (const pos of POSITIONS) m[pos] = round3(rng.range(lo, hi));
  return meanPreservingMults(m);
}

function fmtMult(v: number): string {
  return `×${v.toFixed(2)}`;
}

/** 根据各位置倍数生成中文更新方向摘要 */
export function describePatchDirection(power: Record<Position, number>, insight: Record<Position, number>): string {
  const d = CONFIG.patch.notableDelta;
  const byPower = POSITIONS.slice().sort((a, b) => (power[b] ?? 1) - (power[a] ?? 1));
  const best = byPower[0];
  const worst = byPower[byPower.length - 1];
  const parts: string[] = [];
  if ((power[best] ?? 1) - 1 >= d) parts.push(`${POSITION_LABEL[best]}迎来加强（战力${fmtMult(power[best])}）`);
  if (1 - (power[worst] ?? 1) >= d) parts.push(`${POSITION_LABEL[worst]}遭到削弱（战力${fmtMult(power[worst])}）`);
  const bestIns = POSITIONS.slice().sort((a, b) => (insight[b] ?? 1) - (insight[a] ?? 1))[0];
  if ((insight[bestIns] ?? 1) - 1 >= d) parts.push(`${POSITION_LABEL[bestIns]}的 BP 价值提升`);
  return parts.length ? `${parts.join('；')}。` : '小幅平衡性调整，各位置影响轻微。';
}

function versionParts(v: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** "7.39e" → "7.40"；"7.09" → "7.10" */
function nextVersion(v: string): string {
  const parts = versionParts(v);
  if (!parts) return `${v}.1`;
  const [major, minor] = parts;
  return `${major}.${String(minor + 1).padStart(2, '0')}`;
}

/** 规范化补丁数据（补齐缺失倍数，过滤非法项） */
function normalizePatch(p: PatchInfo): PatchInfo | null {
  if (!p || typeof p.version !== 'string' || typeof p.date !== 'string') return null;
  if (!Number.isFinite(parseDate(p.date))) return null;
  const rawPower = { ...unitMults(), ...(p.powerMult ?? {}) };
  const rawInsight = { ...unitMults(), ...(p.insightMult ?? {}) };
  for (const pos of POSITIONS) {
    if (!Number.isFinite(rawPower[pos]) || rawPower[pos] <= 0) rawPower[pos] = 1;
    if (!Number.isFinite(rawInsight[pos]) || rawInsight[pos] <= 0) rawInsight[pos] = 1;
  }
  const powerMult = meanPreservingMults(rawPower);
  const insightMult = meanPreservingMults(rawInsight);
  return {
    ...p,
    title: p.title ?? `${p.version} 版本更新`,
    summary: p.summary ?? describePatchDirection(powerMult, insightMult),
    powerMult,
    insightMult,
  };
}

function offlineHistory(): PatchInfo[] {
  return OFFLINE_HISTORY.map(([version, date, title]) => {
    const rng = seededRng(hashSeed(version));
    const powerMult = rollMults(rng);
    const insightMult = rollMults(rng);
    return {
      version,
      date,
      title,
      summary: `${describePatchDirection(powerMult, insightMult)}（离线数据：倍数为推演）`,
      powerMult,
      insightMult,
      major: /\.00$/.test(version) || /大改|重做|新纪元/.test(title),
    };
  });
}

function futurePatch(version: string, date: string): PatchInfo {
  const rng = seededRng(hashSeed(`future:${version}`));
  const powerMult = rollMults(rng);
  const insightMult = rollMults(rng);
  const theme = FUTURE_THEMES[Math.floor(rng.next() * FUTURE_THEMES.length)];
  return {
    version,
    date,
    title: `${theme}（推演）`,
    summary: describePatchDirection(powerMult, insightMult),
    powerMult,
    insightMult,
    major: rng.chance(CONFIG.patch.futureMajorChance),
    projected: true,
  };
}

/**
 * 全部版本：真实版本（data/patches.json）+ 推演版本（最后一个真实版本之后每 futureIntervalDays 天一个，
 * 版本号递增 7.xx，倍数 seededRng(hashSeed(version)) 在 futureMultRange 内，projected=true），覆盖到 2028-12-31。结果缓存。
 */
export function allPatches(): PatchInfo[] {
  if (cache) return cache;
  let real: PatchInfo[] = [];
  try {
    real = (getRealPatches() ?? [])
      .map(normalizePatch)
      .filter((p): p is PatchInfo => p !== null);
  } catch {
    real = [];
  }
  // 版本号去重（保留首次出现）并按日期升序
  const seen = new Set<string>();
  const base = (real.length ? real : offlineHistory())
    .filter((p) => (seen.has(p.version) ? false : (seen.add(p.version), true)))
    .sort((a, b) => compareDate(a.date, b.date));

  const out = base.slice();
  const last = out[out.length - 1];
  let date = last.date;
  let version = last.version;
  const until = CONFIG.patch.futureUntil;
  const step = Math.max(1, Math.floor(CONFIG.patch.futureIntervalDays));
  for (;;) {
    date = addDays(date, step);
    if (compareDate(date, until) > 0) break;
    do version = nextVersion(version);
    while (seen.has(version));
    seen.add(version);
    out.push(futurePatch(version, date));
  }
  cache = out;
  byVersion = new Map(out.map((p) => [p.version, p]));
  return cache;
}

export function patchByVersion(version: string): PatchInfo | undefined {
  if (!byVersion) allPatches();
  return byVersion?.get(version);
}

/** 日期区间 [start, end) 内发布的版本（按日期升序） */
export function patchesInRange(startDate: string, endDate: string): PatchInfo[] {
  return allPatches().filter((p) => p.date >= startDate && p.date < endDate);
}

/**
 * 版本 → 回合映射（原地写入 round.patchVersions，按发布日期升序）：
 * 发布日期落在 (赛季开始日, TI 结束日) 内的版本映射到「日期所在的回合」[startDate, endDate)，在该回合开始时生效；
 * 一个赛季可有多次更新，也可能某些回合没有更新。发布日期 ≤ 赛季开始日（上届 TI 结束 ~ 本赛季开始的空档）
 * 的版本不在此列 —— 由赛季初（回合 0）直接应用。skip 返回 true 的版本（如已应用）跳过。
 */
export function mapPatchesToRounds(season: Season, skip?: (version: string) => boolean): void {
  const rounds = season.rounds ?? [];
  if (rounds.length < 2) return;
  for (const r of rounds) r.patchVersions ??= [];
  const last = rounds[rounds.length - 1];
  for (const p of patchesInRange(addDays(season.startDate, 1), last.endDate)) {
    if (skip?.(p.version)) continue;
    // 回合 0（赛季初）日期区间为空，从回合 1 起找第一个 endDate 晚于发布日的回合
    let target = last;
    for (let i = 1; i < rounds.length; i++) {
      if (compareDate(p.date, rounds[i].endDate) < 0) {
        target = rounds[i];
        break;
      }
    }
    if (!target.patchVersions.includes(p.version)) target.patchVersions.push(p.version);
  }
}

/** 某日期时生效的最新版本 */
export function patchAt(date: string): PatchInfo {
  const all = allPatches();
  let res = all[0];
  for (const p of all) {
    if (p.date <= date) res = p;
    else break;
  }
  return res;
}

/**
 * 应用版本：所有 active 选手 power ×= powerMult[位置]、insight ×= insightMult[位置]（永久写入基础值）；
 * state.currentPatch/appliedPatches 更新；heroMeta = heroes.generateHeroMeta；新闻 + popup('patch')。
 * 已应用过的版本跳过。
 */
export function applyPatch(state: GameState, version: string): void {
  if (!state.appliedPatches) state.appliedPatches = [];
  if (state.appliedPatches.includes(version)) return;
  const patch = patchByVersion(version);
  if (!patch) return;

  const maxAttr = CONFIG.player.maxAttr;
  for (const id in state.players) {
    const p = state.players[id];
    if (!p || p.status !== 'active') continue;
    const pm = patch.powerMult[p.position] ?? 1;
    const im = patch.insightMult[p.position] ?? 1;
    if (pm !== 1) p.power = Math.max(1, Math.round(p.power * pm * 100) / 100);
    if (im !== 1) p.insight = clamp(Math.round(p.insight * im * 100) / 100, 0, maxAttr);
  }

  state.currentPatch = version;
  state.appliedPatches.push(version);
  // 版本在所在回合开始时生效（回合开始日可能早于发布日）：随版本上线的新英雄同样纳入强度表
  const cur = state.currentDate || patch.date;
  state.heroMeta = generateHeroMeta(patch, compareDate(patch.date, cur) > 0 ? patch.date : cur);

  const effects = POSITIONS.map((pos) => `${POSITION_SHORT[pos]}号位 ${fmtMult(patch.powerMult[pos] ?? 1)}`).join(' / ');
  const tag = patch.projected ? '（推演版本）' : '';
  addNews(
    state,
    'patch',
    `${patch.major ? '大版本' : '版本'} ${patch.version} 上线：${patch.title}`,
    `${patch.summary}\n战力影响：${effects}${tag}`,
    !!patch.major,
  );
  pushPopup(state, { kind: 'patch', version: patch.version });
}
