// ============================================================================
// 俱乐部品牌变迁（第十波 #4）
// - 数据：src/data/branding.json（真实组织按届次的名称 / 简称 / 品牌主色，事实性数据；口径见文件内 _meta）。
// - 赛季开始时（season.startSeason → applySeasonBranding）把该届有效的品牌套用到对应俱乐部：
//   · 开局赛季：只静默对齐名称 / 简称（阵容数据个别届次的写法与品牌数据不一致时以品牌数据为准），不改配色、不发新闻、不记沿革；
//   · 之后每个赛季：对齐名称 / 简称；换届当季（era.fromTi = 当前届次）才套用该时期给出的配色；
//     有变化时发布新闻「【品牌更新】{旧名} 更名为 {新名}」/「【品牌更新】{名称} 启用新视觉」，并记入 Team.brandHistory（DotaPedia 战队页）。
// - 已解散 / 除名的俱乐部不再更新品牌。纯数据驱动，不消耗随机数（确定性不受影响）。
// - 界面的风格化队徽（src/ui/components/TeamEmblem.tsx）按简称 + 品牌配色生成，换品牌后自然换成新队徽；
//   brandColor2For 给出该品牌时期的队徽辅色（数据未给出时由界面按主色推导）。
// ============================================================================
import type { GameState, Team, TeamBrandChange } from './types';
import { CONFIG } from './config';
import brandingJson from '../data/branding.json';
import { addNews } from './news';
import { ownEntry } from './util';

/** 一个品牌时期（branding.json orgs[].eras[]） */
export interface BrandEra {
  /** 从哪一届 TI 赛季起生效 */
  fromTi: number;
  name: string;
  tag: string;
  /** 品牌主色（#RRGGBB；只在配色有明显变化时给出） */
  color?: string;
  /** 队徽辅色（#RRGGBB；只用于界面生成的风格化队徽） */
  color2?: string;
  /** 新闻 / 沿革中的说明（中文，事实陈述） */
  note?: string;
}

/** 一个真实组织的品牌沿革 */
export interface BrandOrg {
  id: string;
  /** 本项目 roster 中属于该组织的战队 id（改名 / 冠名前后可能不同） */
  teamIds: string[];
  /** 按 fromTi 升序 */
  eras: BrandEra[];
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function cleanEra(raw: unknown): BrandEra | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const fromTi = Number(e.fromTi);
  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const tag = typeof e.tag === 'string' ? e.tag.trim() : '';
  if (!Number.isInteger(fromTi) || !name || !tag) return null;
  const era: BrandEra = { fromTi, name, tag };
  if (typeof e.color === 'string' && HEX_RE.test(e.color)) era.color = e.color.toUpperCase();
  if (typeof e.color2 === 'string' && HEX_RE.test(e.color2)) era.color2 = e.color2.toUpperCase();
  if (typeof e.note === 'string' && e.note.trim()) era.note = e.note.trim();
  return era;
}

function loadOrgs(): BrandOrg[] {
  const raw = (brandingJson as unknown as { orgs?: unknown[] })?.orgs;
  if (!Array.isArray(raw)) return [];
  const out: BrandOrg[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const teamIds = Array.isArray(r.teamIds) ? r.teamIds.filter((x): x is string => typeof x === 'string' && !!x) : [];
    const eras = (Array.isArray(r.eras) ? r.eras : []).map(cleanEra).filter((x): x is BrandEra => !!x);
    if (!id || !teamIds.length || !eras.length) continue;
    eras.sort((a, b) => a.fromTi - b.fromTi);
    out.push({ id, teamIds, eras });
  }
  return out;
}

const ORGS: BrandOrg[] = loadOrgs();
const ORG_BY_TEAM = new Map<string, BrandOrg>();
for (const o of ORGS) for (const tid of o.teamIds) if (!ORG_BY_TEAM.has(tid)) ORG_BY_TEAM.set(tid, o);

/** 全部品牌沿革（只读） */
export function brandOrgs(): readonly BrandOrg[] {
  return ORGS;
}

/** 战队 id 所属的品牌组织（无品牌数据返回 null） */
export function brandOrgOf(teamId: string | null | undefined): BrandOrg | null {
  return (teamId && ORG_BY_TEAM.get(teamId)) || null;
}

/**
 * 与该战队 id 属于同一真实组织的全部 roster 战队 id（含自身；无品牌数据时只有自身）。
 * 例如 lgd-gaming ↔ psg-lgd：一局游戏里同一组织只应有其中一支战队（新俱乐部涌现等逻辑可据此去重）。
 */
export function sameOrgTeamIds(teamId: string): string[] {
  const org = brandOrgOf(teamId);
  return org ? org.teamIds.slice() : [teamId];
}

/** 某届有效的品牌时期（fromTi ≤ ti 的最后一个；早于第一个时期返回 null） */
export function brandEraAt(teamId: string | null | undefined, ti: number): BrandEra | null {
  const org = brandOrgOf(teamId);
  if (!org) return null;
  let cur: BrandEra | null = null;
  for (const e of org.eras) if (e.fromTi <= ti) cur = e;
  return cur;
}

/**
 * 队徽辅色：品牌数据中简称（不区分大小写）与主色都相同的时期给出的 color2；没有返回 undefined（界面按主色推导）。
 * 只依赖静态数据（不需要游戏状态），新游戏向导等没有存档的界面也能得到同样的队徽。
 */
export function brandColor2For(tag: string, color: string): string | undefined {
  const t = (tag ?? '').trim().toLowerCase();
  const c = (color ?? '').trim().toUpperCase();
  if (!t || !c) return undefined;
  return COLOR2_INDEX.get(`${t}|${c}`);
}
const COLOR2_INDEX = new Map<string, string>();
for (const o of ORGS) {
  for (const e of o.eras) {
    if (e.color && e.color2) COLOR2_INDEX.set(`${e.tag.toLowerCase()}|${e.color}`, e.color2);
  }
}

/** 数据问题列表（空数组 = 合法）：tests/branding.test.ts 与数据校验使用 */
export function brandingProblems(raw: unknown = brandingJson): string[] {
  const out: string[] = [];
  const orgs = (raw as { orgs?: unknown })?.orgs;
  if (!Array.isArray(orgs)) return ['缺少 orgs 数组'];
  const seenOrg = new Set<string>();
  const seenTeam = new Map<string, string>();
  const maxTi = CONFIG.branding.maxTi;
  orgs.forEach((o, i) => {
    const r = (o ?? {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const where = id || `#${i}`;
    if (!id) out.push(`orgs[${i}] 缺少 id`);
    else if (seenOrg.has(id)) out.push(`组织 id 重复：${id}`);
    seenOrg.add(id);
    const teamIds = Array.isArray(r.teamIds) ? r.teamIds : [];
    if (!teamIds.length) out.push(`${where}：teamIds 为空`);
    for (const tid of teamIds) {
      if (typeof tid !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(tid)) out.push(`${where}：战队 id「${String(tid)}」不是 kebab-case`);
      else if (seenTeam.has(tid)) out.push(`战队 id ${tid} 同时属于 ${seenTeam.get(tid)} 与 ${where}`);
      else seenTeam.set(tid, where);
    }
    const eras = Array.isArray(r.eras) ? r.eras : [];
    if (!eras.length) out.push(`${where}：eras 为空`);
    let prev = 0;
    eras.forEach((e, j) => {
      const er = (e ?? {}) as Record<string, unknown>;
      const ti = Number(er.fromTi);
      if (!Number.isInteger(ti) || ti < 1 || ti > maxTi) out.push(`${where} eras[${j}]：fromTi 需为 1–${maxTi} 的整数`);
      else if (ti <= prev) out.push(`${where} eras[${j}]：fromTi 需严格递增`);
      else prev = ti;
      if (typeof er.name !== 'string' || !er.name.trim()) out.push(`${where} eras[${j}]：name 为空`);
      if (typeof er.tag !== 'string' || !er.tag.trim()) out.push(`${where} eras[${j}]：tag 为空`);
      else if (er.tag.trim().length > CONFIG.branding.maxTagLength) out.push(`${where} eras[${j}]：tag 超过 ${CONFIG.branding.maxTagLength} 个字符`);
      for (const k of ['color', 'color2'] as const) {
        if (er[k] !== undefined && !(typeof er[k] === 'string' && HEX_RE.test(er[k] as string))) {
          out.push(`${where} eras[${j}]：${k} 不是 #RRGGBB`);
        }
      }
      if (er.color2 !== undefined && er.color === undefined) out.push(`${where} eras[${j}]：给出 color2 时须同时给出 color`);
      if (j > 0 && er.note !== undefined && (typeof er.note !== 'string' || !er.note.trim())) out.push(`${where} eras[${j}]：note 为空`);
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 赛季开始时套用品牌
// ---------------------------------------------------------------------------

/** 本赛季的一次品牌变化（applySeasonBranding 的返回值） */
export interface BrandUpdate {
  teamId: string;
  change: TeamBrandChange;
  /** 是否发布了新闻（开局赛季的静默对齐为 false） */
  announced: boolean;
}

function changeKind(c: TeamBrandChange): 'rename' | 'visual' {
  return c.from.name !== c.to.name ? 'rename' : 'visual';
}

/** 新闻标题：「【品牌更新】LGD Gaming 更名为 PSG.LGD」/「【品牌更新】Natus Vincere 启用新视觉」 */
export function brandNewsTitle(c: TeamBrandChange): string {
  return changeKind(c) === 'rename'
    ? `【品牌更新】${c.from.name} 更名为 ${c.to.name}`
    : `【品牌更新】${c.to.name} 启用新视觉`;
}

/** 新闻正文（平实的事实陈述） */
export function brandNewsBody(c: TeamBrandChange): string {
  const parts: string[] = [];
  if (c.note) parts.push(c.note);
  const bits: string[] = [];
  if (c.from.name !== c.to.name) bits.push(`队名「${c.from.name}」→「${c.to.name}」`);
  if (c.from.tag !== c.to.tag) bits.push(`简称 ${c.from.tag} → ${c.to.tag}`);
  if (c.from.color.toUpperCase() !== c.to.color.toUpperCase()) bits.push('品牌主色更新');
  if (bits.length) parts.push(`自 TI${c.season} 赛季起：${bits.join('，')}。`);
  const emblem = c.from.tag !== c.to.tag || c.from.color.toUpperCase() !== c.to.color.toUpperCase();
  parts.push(emblem ? '队徽随之更新；俱乐部的荣誉、战绩与阵容不受影响。' : '俱乐部的荣誉、战绩与阵容不受影响。');
  return parts.join('');
}

/**
 * 赛季开始时套用该届有效的品牌（season.startSeason 调用；新游戏 / 多人开局的第一个赛季也会调用）。
 * 返回本次的变化（测试与调试用）。不消耗随机数。
 */
export function applySeasonBranding(state: GameState): BrandUpdate[] {
  if (!CONFIG.branding.enabled) return [];
  const ti = Number(state.season?.ti);
  if (!Number.isInteger(ti) || ti <= 0) return [];
  const startTi = Number(state.settings?.startTi);
  const opening = !Number.isFinite(startTi) || ti <= startTi;
  const out: BrandUpdate[] = [];
  for (const id of Object.keys(state.teams).sort()) {
    const team = state.teams[id];
    if (!team || team.disbanded || team.banned) continue;
    const era = brandEraAt(id, ti);
    if (!era) continue;
    // 本赛季才成立的俱乐部（新俱乐部涌现，clubs.ts 的 Team.founded）按开局处理：只静默对齐，不当作「更名」
    const fresh = opening || Number((team as { founded?: { ti?: unknown } }).founded?.ti) === ti;
    const curColor = typeof team.color === 'string' ? team.color : '';
    const to = {
      name: era.name,
      tag: era.tag,
      color: !fresh && era.fromTi === ti && era.color ? era.color : curColor,
    };
    const from = { name: String(team.name ?? ''), tag: String(team.tag ?? ''), color: curColor };
    if (from.name === to.name && from.tag === to.tag && from.color.toUpperCase() === to.color.toUpperCase()) continue;
    const change: TeamBrandChange = { season: ti, from, to };
    if (era.note && era.fromTi === ti) change.note = era.note;
    applyBrand(team, to);
    if (fresh) {
      out.push({ teamId: id, change, announced: false });
      continue;
    }
    recordBrandChange(team, change);
    const important = changeKind(change) === 'rename' ? CONFIG.branding.renameNewsImportant : CONFIG.branding.visualNewsImportant;
    addNews(state, 'event', brandNewsTitle(change), brandNewsBody(change), important, {
      teamIds: [id], visibility: 'public', tags: ['branding'], noInfer: true,
    });
    out.push({ teamId: id, change, announced: true });
  }
  return out;
}

function applyBrand(team: Team, to: { name: string; tag: string; color: string }): void {
  team.name = to.name;
  team.tag = to.tag;
  team.color = to.color;
}

function recordBrandChange(team: Team, change: TeamBrandChange): void {
  const list = Array.isArray(team.brandHistory) ? team.brandHistory : [];
  list.push(change);
  const max = Math.max(1, Math.floor(CONFIG.branding.historyMax));
  team.brandHistory = list.slice(-max);
}

/** 某支战队在本局中的品牌沿革（按时间升序；只读，DotaPedia 战队页使用） */
export function brandHistoryOf(state: GameState, teamId: string): TeamBrandChange[] {
  const list = ownEntry(state.teams, teamId)?.brandHistory;
  return Array.isArray(list) ? list.filter((c) => !!c && typeof c === 'object' && !!c.from && !!c.to) : [];
}
