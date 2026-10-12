// 由全部 rosters/ti*.json 生成 src/data/clubIndex.json（第十波 #2 新俱乐部涌现 / #3 俱乐部使命）：
// 以「组织」为单位汇总真实俱乐部：首次出现的届次、每届出现时的品牌（名称 / 简称 / 赛区 / 配色）、荣誉 / 资金评级、
// 当届阵容与主教练（新俱乐部成立时使用），以及现实中的巅峰阵容（使命目标）与最好的 TI 成绩。
// 引擎按 TI 懒加载 roster 文件，赛季初的同步流程无法读取，所以把需要的字段预先汇总到这里。
// 用法：npx tsx scripts/build-club-index.ts（roster 变动后重新生成）
import { existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Position, Region, RosterFile, SeedCoach, SeedTeam } from '../src/engine/types';
import { ROSTER_DIR, readRosterSync } from './nodeData';

/**
 * 同一组织的不同战队 id（改名 / 冠名）：legacyClubs.json 与品牌变迁数据 branding.json（第十波 #4）的 teamIds 分组，另补充以下别名
 * （均为同一组织的更名，事实性数据）：
 * Team Nigma → Nigma Galaxy、mousesports → MOUZ、BOOM ID → BOOM Esports、Thunder Predator → Thunder Awaken。
 * 二队（LGD.Forever Young、VG.Reborn、iG.Vitality 等）与合作冠名的其他组织（PSG.Quest）按独立俱乐部处理。
 */
export const EXTRA_ORG_ALIASES: Record<string, string> = {
  'nigma-galaxy': 'team-nigma',
  mouz: 'mousesports',
  'boom-esports': 'boom-id',
  'thunder-awaken': 'thunder-predator',
};

/**
 * 一届出现：[TI, 战队 id, 名称, 简称, 赛区, 主色, 荣誉, 资金, 是否 TI 正赛队 (1/0), 名次（如 "1" "5-6" "DNQ"，缺省为 ""）,
 *  全部队员 id（首发 5 人在前）, 主教练（无则 null）, 队员当届位置（与队员 id 一一对应）]
 */
export type ClubAppRow = [
  number, string, string, string, Region, string, number, number, 0 | 1, string, string[], SeedCoach | null, Position[],
];

/** 现实巅峰阵容（使命目标） */
export interface ClubPeak {
  ti: number;
  teamId: string;
  /** 当届名称（如 PSG.LGD） */
  name: string;
  /** 当届名次（"1" / "2" / "5-6" / "DNQ"） */
  result: string;
  players: string[];
  positions: Position[];
  /** 同一套五人阵容夺得的全部 TI（如 OG：[8, 9]） */
  titles: number[];
}

export interface ClubIndexOrg {
  id: string;
  /** 最近一次出现时的名称 */
  name: string;
  teamIds: string[];
  /** 首次出现在 roster 数据中的 TI */
  first: number;
  apps: ClubAppRow[];
  peak: ClubPeak | null;
  /** 现实 TI 冠军届次 */
  titles: number[];
  /** 最好的 TI 正赛名次（起始名次，如 5-6 → 5）与取得该名次的届次；从未进入 TI 正赛为 null */
  best: [number, number[]] | null;
}

/** 组织分组（legacyClubs.json / branding.json 的 { id, teamIds }） */
interface LegacyClubLite {
  id: string;
  teamIds: string[];
}

function rankOf(result: string | undefined): number | null {
  if (typeof result !== 'string' || !/^\d+(-\d+)?$/.test(result)) return null;
  return Number(result.split('-')[0]);
}

function starters(team: SeedTeam): string[] {
  return (team.players ?? []).slice(0, 5).map((p) => p?.id).filter((x): x is string => typeof x === 'string' && !!x);
}

function rosterPower(team: SeedTeam): number {
  return (team.players ?? []).slice(0, 5).reduce((a, p) => a + (Number.isFinite(p?.power) ? p.power : 0), 0);
}

/**
 * 由全部 roster 构建组织索引（纯函数，测试可直接调用）。groups 依次为 legacyClubs.json、branding.json 的分组（并查集合并：
 * 任一分组把两个战队 id 归为同一组织即合并）；组织 id 取第一个包含它的分组的 id（legacyClubs 优先），否则为战队 id。
 */
export function buildClubIndex(rosters: RosterFile[], legacy: LegacyClubLite[], branding: LegacyClubLite[] = []): ClubIndexOrg[] {
  // 并查集：战队 id → 组织代表
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const named = new Map<string, string>(); // 代表 → 组织 id（先到先得）
  const groups = [...legacy, ...branding].filter((g) => g?.id && Array.isArray(g.teamIds) && g.teamIds.length);
  for (const g of groups) for (const tid of g.teamIds.slice(1)) union(g.teamIds[0], tid);
  for (const [alias, main] of Object.entries(EXTRA_ORG_ALIASES)) union(main, alias);
  for (const g of groups) {
    const r = find(g.teamIds[0]);
    if (!named.has(r)) named.set(r, g.id);
  }
  const org = (teamId: string) => {
    const r = find(teamId);
    return named.get(r) ?? r;
  };

  type Acc = { id: string; apps: { row: ClubAppRow; team: SeedTeam }[] };
  const orgs = new Map<string, Acc>();
  for (const r of rosters.slice().sort((a, b) => a.ti - b.ti)) {
    const seen = new Set<string>();
    for (const t of r.teams ?? []) {
      if (!t?.id) continue;
      const oid = org(t.id);
      // 同一届同一组织出现两支队（不应发生）：只取第一支
      if (seen.has(oid)) continue;
      seen.add(oid);
      let acc = orgs.get(oid);
      if (!acc) orgs.set(oid, (acc = { id: oid, apps: [] }));
      const coach = t.coach && t.coach.id
        ? { id: t.coach.id, name: t.coach.name, nationality: t.coach.nationality, birthYear: t.coach.birthYear, tier: t.coach.tier, insight: t.coach.insight }
        : null;
      const seeds = (t.players ?? []).filter((p) => typeof p?.id === 'string' && !!p.id);
      const players = seeds.map((p) => p.id);
      const positions = seeds.map((p) => p.position);
      acc.apps.push({
        team: t,
        row: [
          r.ti, t.id, t.name ?? t.id, t.tag ?? '', t.region, t.color ?? '', Math.round(t.honor ?? 0), Math.round(t.funds ?? 0),
          t.atTI ? 1 : 0, typeof t.tiResult === 'string' ? t.tiResult : '', players, coach, positions,
        ],
      });
    }
  }

  const out: ClubIndexOrg[] = [];
  for (const acc of orgs.values()) {
    const apps = acc.apps;
    const titles = apps.filter((a) => a.row[8] && rankOf(a.row[9]) === 1).map((a) => a.row[0]);
    // 巅峰阵容：TI 冠军阵容（同一套五人夺冠次数最多者，再取最早）；否则最好名次（同名次取当届首发战力之和最高者，再取最早）；
    // 从未进入 TI 正赛：当届首发战力之和最高的一届
    let peakApp: { row: ClubAppRow; team: SeedTeam } | null = null;
    let peakTitles: number[] = [];
    if (titles.length) {
      const groups = new Map<string, { app: { row: ClubAppRow; team: SeedTeam }; tis: number[] }>();
      for (const a of apps) {
        if (!a.row[8] || rankOf(a.row[9]) !== 1) continue;
        const key = starters(a.team).slice().sort().join(',');
        const g = groups.get(key);
        if (g) g.tis.push(a.row[0]);
        else groups.set(key, { app: a, tis: [a.row[0]] });
      }
      const best = [...groups.values()].sort((x, y) => y.tis.length - x.tis.length || x.app.row[0] - y.app.row[0])[0];
      peakApp = best.app;
      peakTitles = best.tis.slice().sort((a, b) => a - b);
    } else {
      const placed = apps.filter((a) => a.row[8] && rankOf(a.row[9]) !== null);
      const pool = placed.length ? placed : apps;
      const sorted = pool.slice().sort((x, y) => (placed.length ? (rankOf(x.row[9])! - rankOf(y.row[9])!) : 0)
        || rosterPower(y.team) - rosterPower(x.team) || x.row[0] - y.row[0]);
      peakApp = sorted[0] ?? null;
    }
    let peak: ClubPeak | null = null;
    if (peakApp) {
      const five = (peakApp.team.players ?? []).slice(0, 5).filter((p) => p?.id);
      if (five.length === 5) {
        peak = {
          ti: peakApp.row[0],
          teamId: peakApp.row[1],
          name: peakApp.row[2],
          result: peakApp.row[8] ? peakApp.row[9] || 'DNQ' : 'DNQ',
          players: five.map((p) => p.id),
          positions: five.map((p) => p.position),
          titles: peakTitles,
        };
      }
    }
    const ranked = apps.filter((a) => a.row[8] && rankOf(a.row[9]) !== null);
    let best: [number, number[]] | null = null;
    if (ranked.length) {
      const top = Math.min(...ranked.map((a) => rankOf(a.row[9])!));
      best = [top, ranked.filter((a) => rankOf(a.row[9]) === top).map((a) => a.row[0])];
    }
    const last = apps[apps.length - 1].row;
    out.push({
      id: acc.id,
      name: last[2],
      teamIds: [...new Set(apps.map((a) => a.row[1]))],
      first: apps[0].row[0],
      apps: apps.map((a) => a.row),
      peak,
      titles,
      best,
    });
  }
  out.sort((a, b) => a.first - b.first || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function main(): void {
  const tis = readdirSync(ROSTER_DIR)
    .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const rosters = tis.map((ti) => readRosterSync(ti));
  const legacy = (JSON.parse(readFileSync(join(ROSTER_DIR, '..', 'legacyClubs.json'), 'utf8')) as { clubs: LegacyClubLite[] }).clubs;
  const brandingPath = join(ROSTER_DIR, '..', 'branding.json');
  const branding = existsSync(brandingPath)
    ? ((JSON.parse(readFileSync(brandingPath, 'utf8')) as { orgs?: LegacyClubLite[] }).orgs ?? [])
    : [];
  const orgs = buildClubIndex(rosters, legacy, branding);
  const json = {
    _meta: {
      description: '真实俱乐部（组织）索引：第十波新俱乐部涌现（首次出现的届次、各届品牌 / 荣誉 / 资金 / 阵容 / 主教练）与俱乐部使命（现实巅峰阵容、最好成绩）。'
        + '由 scripts/build-club-index.ts 从 rosters/ti*.json、legacyClubs.json 与 branding.json（组织分组）生成，任一变动后需重新生成。',
      format: 'orgs[] = { id, name, teamIds, first, apps: [[TI, 战队 id, 名称, 简称, 赛区, 主色, 荣誉, 资金, TI 正赛 1/0, 名次, [队员 id，首发在前], 主教练|null, [队员当届位置]]], '
        + 'peak: { ti, teamId, name, result, players[5], positions[5], titles[] } | null, titles[], best: [最好名次, [届次]] | null }',
      peakRule: '巅峰阵容 = TI 冠军阵容（同一套五人夺冠最多者，再取最早）；未夺冠取最好名次（同名次取首发战力之和最高者，再取最早）；从未进入 TI 正赛取首发战力之和最高的一届。',
      aliases: EXTRA_ORG_ALIASES,
    },
    orgs,
  };
  writeFileSync(join(ROSTER_DIR, '..', 'clubIndex.json'), `${JSON.stringify(json)}\n`);
  const withPeak = orgs.filter((o) => o.peak).length;
  console.log(`clubIndex: ${orgs.length} orgs (${withPeak} with peak roster) from TI ${tis.join(',')}`);
}

// 仅在直接运行时写文件（被测试 import 时不执行）
if (process.argv[1] && /build-club-index\.ts$/.test(process.argv[1])) main();
