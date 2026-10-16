// 真实俱乐部（组织）索引：src/data/clubIndex.json（scripts/build-club-index.ts 生成）的类型与只读查询【J1-clubs-missions】
// 从 clubs.ts 拆出：本模块只依赖数据与类型（不 import 其他引擎模块），team.ts 的 AI 首发优先级（lineupPriority.ts）可以直接使用而不形成循环依赖；
// clubs.ts 原样转出这些导出，原有调用方不变。
import clubIndexJson from '../data/clubIndex.json';
import type { GameState, Position, Region, SeedCoach } from './types';
import { REGIONS } from './types';
import { ownEntry } from './util';

// ---------------------------------------------------------------------------
// 俱乐部索引（src/data/clubIndex.json，scripts/build-club-index.ts 生成）
// ---------------------------------------------------------------------------

/** 一届出现：当届品牌、荣誉 / 资金评级、阵容与主教练 */
export interface ClubApp {
  ti: number;
  teamId: string;
  name: string;
  tag: string;
  region: Region;
  color: string;
  honor: number;
  funds: number;
  /** 当届 TI 正赛队 */
  atTI: boolean;
  /** 当届 TI 名次（"1" / "5-6" / "DNQ"；缺省为 ""） */
  result: string;
  /** 全部队员 id（首发 5 人在前） */
  players: string[];
  coach: SeedCoach | null;
  /** 队员当届位置（与 players 一一对应；旧数据缺失时为空） */
  positions: Position[];
}

/** 现实巅峰阵容（俱乐部使命的目标） */
export interface ClubPeak {
  ti: number;
  teamId: string;
  name: string;
  result: string;
  players: string[];
  positions: Position[];
  titles: number[];
}

/** 真实俱乐部（组织） */
export interface ClubOrg {
  id: string;
  name: string;
  teamIds: string[];
  /** 首次出现在 roster 数据中的 TI */
  first: number;
  apps: ClubApp[];
  peak: ClubPeak | null;
  titles: number[];
  /** 最好的 TI 正赛名次与取得该名次的届次（从未进入 TI 正赛为 null） */
  best: { rank: number; tis: number[] } | null;
}

type RawApp = [number, string, string, string, Region, string, number, number, number, string, string[], SeedCoach | null, Position[]?];
interface RawOrg {
  id: string;
  name: string;
  teamIds: string[];
  first: number;
  apps: RawApp[];
  peak: ClubPeak | null;
  titles: number[];
  best: [number, number[]] | null;
}

interface ClubIndexCache {
  orgs: ClubOrg[];
  byId: Map<string, ClubOrg>;
  byTeam: Map<string, ClubOrg>;
  /** 选手 id → 巅峰阵容包含该选手的组织 */
  byPeakPlayer: Map<string, ClubOrg[]>;
}

let INDEX: ClubIndexCache | null = null;

function index(): ClubIndexCache {
  if (INDEX) return INDEX;
  const raw = ((clubIndexJson as unknown as { orgs?: RawOrg[] }).orgs ?? []);
  const orgs: ClubOrg[] = [];
  for (const o of raw) {
    if (!o?.id || !Array.isArray(o.apps)) continue;
    const apps: ClubApp[] = o.apps
      .filter((a) => Array.isArray(a) && a.length >= 11)
      .map((a) => ({
        ti: a[0], teamId: a[1], name: a[2], tag: a[3], region: REGIONS.includes(a[4]) ? a[4] : 'EU', color: a[5],
        honor: a[6], funds: a[7], atTI: a[8] === 1, result: a[9] ?? '', players: Array.isArray(a[10]) ? a[10] : [], coach: a[11] ?? null,
        positions: Array.isArray(a[12]) ? a[12] : [],
      }));
    if (!apps.length) continue;
    const peak = o.peak && Array.isArray(o.peak.players) && o.peak.players.length === 5 ? o.peak : null;
    orgs.push({
      id: o.id,
      name: o.name,
      teamIds: Array.isArray(o.teamIds) ? o.teamIds : [],
      first: o.first,
      apps,
      peak,
      titles: Array.isArray(o.titles) ? o.titles : [],
      best: Array.isArray(o.best) ? { rank: o.best[0], tis: o.best[1] ?? [] } : null,
    });
  }
  const byId = new Map(orgs.map((o) => [o.id, o]));
  const byTeam = new Map<string, ClubOrg>();
  const byPeakPlayer = new Map<string, ClubOrg[]>();
  for (const o of orgs) {
    for (const tid of o.teamIds) if (!byTeam.has(tid)) byTeam.set(tid, o);
    for (const pid of o.peak?.players ?? []) {
      const list = byPeakPlayer.get(pid);
      if (list) list.push(o);
      else byPeakPlayer.set(pid, [o]);
    }
  }
  INDEX = { orgs, byId, byTeam, byPeakPlayer };
  return INDEX;
}

/** 全部真实俱乐部（只读） */
export function clubOrgs(): ClubOrg[] {
  return index().orgs;
}

export function clubOrg(orgId: string | null | undefined): ClubOrg | undefined {
  return orgId ? index().byId.get(orgId) : undefined;
}

/** roster 战队 id → 所属组织（改名 / 冠名战队归入同一组织） */
export function orgOfTeamId(teamId: string | null | undefined): ClubOrg | undefined {
  return teamId ? index().byTeam.get(teamId) : undefined;
}

/** 巅峰阵容包含该选手的组织 */
export function peakOrgsOfPlayer(playerId: string): ClubOrg[] {
  return index().byPeakPlayer.get(playerId) ?? [];
}

/** 组织在某届的出现记录 */
export function orgAppAt(org: ClubOrg, ti: number): ClubApp | undefined {
  return org.apps.find((a) => a.ti === ti);
}

/** 本局中某支战队对应的真实组织（虚构 / 程序化战队返回 undefined） */
export function realOrgOf(state: GameState, teamId: string | null | undefined): ClubOrg | undefined {
  if (!teamId) return undefined;
  const team = ownEntry(state.teams, teamId);
  if (team?.founded) return team.founded.kind === 'real' ? clubOrg(team.founded.orgId) ?? orgOfTeamId(teamId) : undefined;
  return orgOfTeamId(teamId);
}

/** 某战队（真实组织）的现实巅峰阵容成员 id；虚构战队 / 无巅峰数据为空 */
export function peakPlayerIdsOfTeam(state: GameState, teamId: string | null | undefined): string[] {
  return realOrgOf(state, teamId)?.peak?.players ?? [];
}

// 选手某届所在的真实组织（入场的下一回合 AI 接手的「当届真实战队」，entryPass.ts）：首次查询时按全部出现记录建索引
let PLAYER_ORG_AT: Map<number, Map<string, { org: ClubOrg; idx: number }>> | null = null;

/**
 * 选手在某届真实阵容数据中效力的组织（只看战队名单，不含当届自由选手）。同一届出现在多支战队名单中时（数据中极少），
 * 首发（名单前 5 人）优先，其余按索引顺序取第一个。没有记录返回 undefined。
 */
export function realOrgOfPlayerAt(playerId: string | null | undefined, ti: number): ClubOrg | undefined {
  if (!playerId || !Number.isFinite(ti)) return undefined;
  if (!PLAYER_ORG_AT) {
    PLAYER_ORG_AT = new Map();
    for (const org of index().orgs) {
      for (const app of org.apps) {
        let byPlayer = PLAYER_ORG_AT.get(app.ti);
        if (!byPlayer) PLAYER_ORG_AT.set(app.ti, (byPlayer = new Map()));
        app.players.forEach((pid, idx) => {
          const cur = byPlayer!.get(pid);
          if (!cur || (idx < 5 && cur.idx >= 5)) byPlayer!.set(pid, { org, idx });
        });
      }
    }
  }
  return PLAYER_ORG_AT.get(ti)?.get(playerId)?.org;
}
