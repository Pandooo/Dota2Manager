// 静态数据访问层。小文件静态导入；roster 文件较大，通过可注册的加载器异步加载
// （浏览器端在 src/data/rosterLoader.browser.ts 用 import.meta.glob 注册；Node 端在 scripts/nodeData.ts 用 fs 注册）。
import type { HeroInfo, PatchInfo, PlayerIndexEntry, PlayerTrajectory, RosterFile, TiInfo, TournamentTemplate } from '../engine/types';
import tisJson from './tis.json';
import patchesJson from './patches.json';
import heroesJson from './heroes.json';
import playerIndexJson from './playerIndex.json';
import trajectoriesJson from './trajectories.json';
import coachIndexJson from './coachIndex.json';
import s1 from './tournaments/season1.json';
import s2 from './tournaments/season2.json';
import s3 from './tournaments/season3.json';
import s4 from './tournaments/season4.json';
import s5 from './tournaments/season5.json';
import s6 from './tournaments/season6.json';
import s7 from './tournaments/season7.json';
import s8 from './tournaments/season8.json';
import s9 from './tournaments/season9.json';
import s10 from './tournaments/season10.json';
import s11 from './tournaments/season11.json';
import s12 from './tournaments/season12.json';
import s13 from './tournaments/season13.json';
import s14 from './tournaments/season14.json';
import s15 from './tournaments/season15.json';
import s16 from './tournaments/season16.json';

const TIS = tisJson as unknown as TiInfo[];
const PATCHES = (patchesJson as unknown as PatchInfo[]).slice().sort((a, b) => a.date.localeCompare(b.date));
const HEROES = heroesJson as unknown as HeroInfo[];
const PLAYER_INDEX = playerIndexJson as unknown as PlayerIndexEntry[];
const TOURNAMENTS: Record<number, TournamentTemplate[]> = {
  1: s1, 2: s2, 3: s3, 4: s4, 5: s5, 6: s6, 7: s7, 8: s8, 9: s9, 10: s10,
  11: s11, 12: s12, 13: s13, 14: s14, 15: s15, 16: s16,
} as unknown as Record<number, TournamentTemplate[]>;

export function getAllTiInfo(): TiInfo[] {
  return TIS;
}

export function getTiInfo(ti: number): TiInfo {
  const info = TIS.find((t) => t.ti === ti);
  if (!info) throw new Error(`缺少 TI${ti} 的数据`);
  return info;
}

/** 真实版本列表（按日期升序）。未来版本由 engine/patches.ts 推演生成 */
export function getRealPatches(): PatchInfo[] {
  return PATCHES;
}

export function getHeroes(): HeroInfo[] {
  return HEROES;
}

/** 该赛季真实赛事模板；无数据返回 [] */
export function getTournamentTemplates(ti: number): TournamentTemplate[] {
  return (TOURNAMENTS[ti] ?? []).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/** 最后一个有赛事数据的赛季 */
export function lastTournamentDataSeason(): number {
  let last = 0;
  for (const [k, v] of Object.entries(TOURNAMENTS)) if (v.length > 0) last = Math.max(last, Number(k));
  return last;
}

export function getPlayerIndex(): PlayerIndexEntry[] {
  return PLAYER_INDEX;
}

// 真实选手生涯轨迹（第九波自主成长；scripts/build-trajectories.ts 由 rosters/ti*.json 生成）：选手 id → { TI: { power, mmr, tier } }
const TRAJECTORIES = trajectoriesJson as unknown as Record<string, PlayerTrajectory>;

/** 全部真实选手的生涯轨迹（只读） */
export function getTrajectories(): Record<string, PlayerTrajectory> {
  return TRAJECTORIES;
}

/** 某名真实选手的生涯轨迹（无数据返回 undefined） */
export function getTrajectory(playerId: string): PlayerTrajectory | undefined {
  return Object.prototype.hasOwnProperty.call(TRAJECTORIES, playerId) ? TRAJECTORIES[playerId] : undefined;
}

/** 真实教练索引条目（第九波教练供给；scripts/build-coach-index.ts 由 rosters/ti*.json 生成） */
export interface CoachIndexEntry {
  id: string;
  name: string;
  nationality: string;
  birthYear: number;
  /** 出现在哪些届 roster（战队主教练或自由教练）：[TI, 当届等级, 当届灵性]，按 TI 升序 */
  apps: [number, string, number][];
}
const COACH_INDEX = coachIndexJson as unknown as CoachIndexEntry[];

/** 全部真实教练索引（只读；src/engine/coaches.ts 每赛季引入该届尚未进入游戏的真实教练） */
export function getCoachIndex(): CoachIndexEntry[] {
  return COACH_INDEX;
}

// ---------------------------------------------------------------------------
// Roster 加载
// ---------------------------------------------------------------------------
export type RosterLoader = (ti: number) => Promise<RosterFile>;
let rosterLoader: RosterLoader | null = null;
let availableRosterTis: number[] = [];

/** 注册 roster 加载器与可用 TI 列表 */
export function registerRosterLoader(loader: RosterLoader, tis: number[]): void {
  rosterLoader = loader;
  availableRosterTis = tis.slice().sort((a, b) => a - b);
}

/** 有 roster 数据、可作为起点的 TI 序号 */
export function availableStartTis(): number[] {
  return availableRosterTis;
}

export async function loadRoster(ti: number): Promise<RosterFile> {
  if (!rosterLoader) throw new Error('未注册 roster 加载器');
  return rosterLoader(ti);
}
