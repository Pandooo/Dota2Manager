// ============================================================================
// DotaPedia 查询（纯函数，UI 在渲染时调用；数据由 stats.ts 记录在 GameState.pedia）
//
// - 总览（pediaDashboard）：历史总数据、TI 冠军（含开局前的真实 TI）、各类排行榜（冠军、KDA、MVP、胜率、奖金、连胜、击杀）、单局纪录、历史地位榜。
// - 战队页（pediaTeamPage）：仿 Liquipedia —— 阵容 / 教练、生涯与分赛季战绩（系列赛胜平负、小局、击杀）、冠军与名次、TI 成绩、奖金、
//   历代队员、实时历史地位（传奇值 / 称号 / 最接近的历史俱乐部 / 本局与历史排名）与「开局前（现实）」成就。
// - 选手页（pediaPlayerPage）：生涯与分赛季 K/D/A、战队履历、成就（TI / 各级冠军 / 决赛 / MVP）、奖金、常用英雄、巅峰等级、开局前的真实 TI 履历、历史地位。
// - 赛事（pediaTournaments / pediaTournament）、英雄（pediaHeroStats / pediaHeroTrend）、搜索（pediaSearch）。逐局个人数据不存储（只有聚合与单局纪录）。
//
// 历史地位（「不必等结束」）：沿用 legacy.ts 的传奇值口径。战队 = 开局前真实成就（legacyClubs.json + tiResults.json，TI 序号 < 起始 TI）
// + 本局成就（赛事史 + 赛季末实力排名快照 + 当季实时实力），人类战队的本局部分与结算页（computeLegacyReport）一致。
// 所有查询共用一份按状态修订号缓存的索引（WeakMap），一次构建 O(选手 + 赛事)，之后每次查询只做排序 / 切片。
// ============================================================================
import type {
  GameState, PediaPlayerSeason, PediaState, PediaTeamSeason, Player, Position, Region, Team, Tier,
  TournamentHistoryEntry, TournamentTier,
} from './types';
import { TIERS } from './types';
import { CONFIG, POSITION_SHORT, TOURNAMENT_TIER_LABEL } from './config';
import { formatRank } from './util';
import { tiYear } from './calendar';
import { ageOf, overallRating, playerTier, tierIndex } from './player';
import { rankTeamsByRating } from './team';
import { heroById, heroName } from './heroes';
import { pediaOf, pediaRevision } from './stats';
import {
  backToBackCount, clubLine, clubStats, legacyClubs, legacyGrade, legacyScore, legacyTitleOf, matchHistoricalClub,
  teamLegacyStats,
} from './legacy';
import type { LegacyClubRef, LegacyScore, LegacyStats, LegacyTitle } from './legacy';
import { getAllTiInfo, getTournamentTemplates, lastTournamentDataSeason } from '../data/index';
import tiResultsJson from '../data/tiResults.json';

const P = () => CONFIG.pedia;
const TIER_ORDER: Record<TournamentTier, number> = { ti: 0, major: 1, premier: 2, minor: 3, qualifier: 4 };
const ALL_TIERS: TournamentTier[] = ['ti', 'major', 'premier', 'minor', 'qualifier'];

// ===========================================================================
// 对外类型
// ===========================================================================

/** 个人数据合计（生涯 / 赛季 / 某战队） */
export interface PediaStatTotals {
  games: number;
  wins: number;
  losses: number;
  /** 胜率 0..1（0 局时为 0） */
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  /** KDA = (击杀 + 助攻) / max(1, 阵亡) */
  kda: number;
  avgKills: number;
  avgDeaths: number;
  avgAssists: number;
  mvps: number;
}

/** 选手合计（PediaStatTotals + 系列赛战绩 / 奖金 / 连胜 / 活跃赛季） */
export interface PediaPlayerTotals extends PediaStatTotals {
  seriesWins: number;
  seriesDraws: number;
  seriesLosses: number;
  /** 分到的赛事奖金（队员分成，金币） */
  prize: number;
  seasonsActive: number;
  bestStreak: number;
  currentStreak: number;
}

/** 战队合计 */
export interface PediaTeamTotals {
  seriesWins: number;
  seriesDraws: number;
  seriesLosses: number;
  /** 系列赛胜率 = 胜 / (胜 + 平 + 负) */
  seriesWinRate: number;
  games: number;
  gameWins: number;
  gameLosses: number;
  gameWinRate: number;
  kills: number;
  deaths: number;
  /** 击杀 / 阵亡 */
  kd: number;
  /** 场均时长（分钟；无记录时 0） */
  avgDuration: number;
  prizeClub: number;
  prizePlayers: number;
  prizeTotal: number;
  titles: number;
  tiTitles: number;
}

/** 一个冠军 / 名次的赛事引用 */
export interface PediaTitleRef {
  tournamentId: string;
  name: string;
  tier: TournamentTier;
  tierLabel: string;
  season: number;
}

/** 战队的一项赛事名次 */
export interface PediaPlacementRow extends PediaTitleRef {
  rankFrom: number;
  rankTo: number;
  teams: number;
  label: string;
  /** 名次奖金 [俱乐部所得, 队员分成]（只记录前四名；更早的赛事 / 其他名次为 null） */
  prize: [number, number] | null;
}

/** 排行榜一行 */
export interface PediaBoardRow {
  rank: number;
  kind: 'team' | 'player' | 'hero';
  id: string;
  name: string;
  /** 选手所属 / 最近效力的战队（选手榜） */
  teamId?: string;
  teamName?: string;
  value: number;
  /** 展示文本（如「4.32」「63.5%」「128 万」） */
  display: string;
  /** 补充说明（如「320 局」「TI ×2 · Major ×3」） */
  sub?: string;
}

export interface PediaBoard {
  id: string;
  title: string;
  /** 门槛 / 口径说明 */
  note?: string;
  rows: PediaBoardRow[];
}

/** 单局纪录（展示用） */
export interface PediaRecordRow {
  kind: string;
  label: string;
  value: number;
  display: string;
  playerId?: string;
  playerName?: string;
  heroId?: string;
  heroName?: string;
  teamId: string;
  teamName: string;
  oppId: string;
  oppName: string;
  ti: number;
  date: string;
  tierLabel: string;
}

/** TI 冠军（real = 开局前的真实历史） */
export interface PediaTiChampionRow {
  ti: number;
  year: number;
  championId: string | null;
  championName: string;
  runnerUpId: string | null;
  runnerUpName: string;
  real: boolean;
}

/** 开局前（现实）的成就（战队） */
export interface PediaPreGame {
  startTi: number;
  /** 对应的历史俱乐部（legacyClubs.json；无则 null） */
  clubId: string | null;
  clubName: string | null;
  /** 俱乐部的现实一句话（只在其现实履历全部早于起始 TI 时给出，避免剧透；否则 null） */
  highlight: string | null;
  tiResults: { ti: number; year: number; teamName: string; rankFrom: number; rankTo: number; label: string }[];
  /** 开局前的 Valve Major 冠军（按赛事所在赛季过滤） */
  majors: { name: string; ti: number }[];
  stats: LegacyStats;
  /** 按历史俱乐部口径的传奇值（声望按成就估计） */
  score: number;
  title: LegacyTitle;
  /** 一句话（如「TI8 冠军 · Major 冠军 ×4 · TI 参赛 6 次」） */
  summary: string;
}

/** 战队实时历史地位 */
export interface PediaTeamLegacy {
  teamId: string;
  name: string;
  tag: string;
  color: string;
  active: boolean;
  human: boolean;
  /** 综合传奇值（开局前真实成就与本局成就合并后重新计分：声望只按当前荣誉峰值计一次、赛季实力上限按合并后的成就，所以不等于下面两项之和） */
  score: number;
  /** 单算本局成就（人类战队与结算页一致） */
  inGameScore: number;
  /** 单算开局前（历史俱乐部口径，声望按成就估计） */
  preGameScore: number;
  title: LegacyTitle;
  grade: string;
  /** 本局全部战队中的名次（按综合传奇值） */
  rank: number;
  total: number;
  /** 插入历史排行榜（legacyClubs 全部真实俱乐部）后的名次 / 总数 */
  historyRank: number;
  historySize: number;
  /** 最接近的历史俱乐部 */
  match: { clubId: string; name: string; line: string; score: number; title: LegacyTitle } | null;
  stats: LegacyStats;
  inGameStats: LegacyStats;
  preGame: PediaPreGame | null;
  parts: LegacyScore['parts'];
  /** 一句话（如「两连冠王朝 · 传奇值 420 · 本局第 1 / 30 · 历史第 3 / 32」） */
  summary: string;
}

/** 选手历史地位（简化版） */
export interface PediaPlayerStanding {
  playerId: string;
  score: number;
  rank: number;
  total: number;
  title: string;
  parts: { label: string; value: number }[];
}

export interface PediaOverview {
  /** 开始记录的赛季 / 回合（旧存档从中途开始） */
  since: { ti: number; round: number };
  /** 统计覆盖整个执教生涯（新游戏从第一局开始记录，PediaState.full）；false 时 UI 应提示「统计始于 TI{since.ti}」 */
  complete: boolean;
  startTi: number;
  currentTi: number;
  seasonsRecorded: number;
  games: number;
  kills: number;
  avgKills: number;
  avgDuration: number;
  series: number;
  tournaments: number;
  activeTeams: number;
  playersWithGames: number;
}

export interface PediaDashboard {
  /** 筛选的赛季（undefined = 全部） */
  ti?: number;
  /** 有数据的赛季（筛选器选项，新 → 旧） */
  seasons: number[];
  overview: PediaOverview;
  tiChampions: PediaTiChampionRow[];
  boards: PediaBoard[];
  records: PediaRecordRow[];
  legacy: PediaTeamLegacy[];
}

export interface PediaTeamSeasonView {
  ti: number;
  year: number;
  seriesWins: number;
  seriesDraws: number;
  seriesLosses: number;
  gameWins: number;
  gameLosses: number;
  gameWinRate: number;
  kills: number;
  deaths: number;
  /** 场均时长（分钟） */
  avgDuration: number;
  prizeClub: number;
  prizePlayers: number;
  titles: PediaTitleRef[];
  tiResult: { rankFrom: number; rankTo: number; teams: number; label: string } | null;
  finalRank: number | null;
  strengthRank: number | null;
  strengthTeams: number | null;
  honorEnd: number | null;
  roster: { id: string; handle: string }[];
  coach: { id: string; name: string } | null;
  /** 赛季尚未结算（无赛季末快照） */
  partial: boolean;
}

export interface PediaTeamPage {
  id: string;
  name: string;
  tag: string;
  color: string;
  region: Region | null;
  status: 'active' | 'disbanded' | 'banned' | 'unknown';
  statusLabel: string;
  human: boolean;
  honor: number | null;
  lastSeasonRank: number | null;
  coach: { id: string; name: string; tier: Tier } | null;
  roster: { id: string; handle: string; position: Position; tier: Tier; starter: boolean; games: number }[];
  totals: PediaTeamTotals;
  seasons: PediaTeamSeasonView[];
  titles: { total: number; byTier: Record<TournamentTier, number>; list: PediaTitleRef[] };
  placements: PediaPlacementRow[];
  tiResults: { ti: number; rankFrom: number; rankTo: number; teams: number; label: string }[];
  /** 历任主教练（按赛季末快照，连续赛季合并） */
  coaches: { id: string; name: string; fromTi: number; toTi: number }[];
  /** 历代队员（为本队出场过的选手，按局数） */
  players: { id: string; handle: string; position: Position | null; games: number; wins: number; kda: number; mvps: number; seasons: number[]; current: boolean }[];
  streaks: { series: { current: number; best: number }; games: { current: number; best: number } };
  legacy: PediaTeamLegacy | null;
  preGame: PediaPreGame | null;
  since: { ti: number; round: number };
}

export interface PediaPlayerSeasonView extends PediaStatTotals {
  ti: number;
  year: number;
  teamId: string;
  teamName: string;
  prize: number;
  seriesWins: number;
  seriesDraws: number;
  seriesLosses: number;
}

export interface PediaPlayerTiResult {
  ti: number;
  teamId: string;
  teamName: string;
  rankFrom: number;
  rankTo: number;
  label: string;
  /** 开局前的真实历史 */
  real: boolean;
}

export interface PediaPlayerPage {
  id: string;
  handle: string;
  name: string | null;
  nationality: string | null;
  region: Region | null;
  position: Position | null;
  age: number | null;
  tier: Tier | null;
  peakTier: Tier | null;
  rating: number | null;
  peakRating: number | null;
  status: 'active' | 'free' | 'retired' | 'banned' | 'coach' | 'unknown';
  statusLabel: string;
  teamId: string | null;
  teamName: string | null;
  isReal: boolean | null;
  totals: PediaPlayerTotals;
  seasons: PediaPlayerSeasonView[];
  /** 战队履历（连续赛季合并为一段；同一赛季转会时两段都会出现） */
  teams: { teamId: string; teamName: string; fromTi: number; toTi: number; seasons: number[]; games: number; wins: number }[];
  achievements: {
    /** 全部 TI 名次（real = 开局前的真实历史） */
    tiResults: PediaPlayerTiResult[];
    /** 全部 TI 冠军（含开局前的真实 TI 冠军，real 标记） */
    tiTitles: { ti: number; teamId: string; teamName: string; real: boolean }[];
    titles: (PediaTitleRef & { teamId: string; teamName: string })[];
    /** 本局的亚军（决赛失利） */
    finals: (PediaTitleRef & { teamId: string; teamName: string })[];
    /** 本局冠军按等级计数（开局前的真实 TI 冠军见 tiTitles） */
    titleCounts: Record<TournamentTier, number>;
    mvps: number;
  };
  heroes: { heroId: string; name: string; games: number; wins: number; winRate: number }[];
  heroOther: { games: number; wins: number } | null;
  /** 开局前（现实）的 TI 履历 */
  preGame: { tiResults: PediaPlayerTiResult[] } | null;
  standing: PediaPlayerStanding | null;
  since: { ti: number; round: number };
}

export interface PediaTournamentRow {
  id: string;
  name: string;
  tier: TournamentTier;
  tierLabel: string;
  season: number;
  year: number;
  date: string;
  status: 'finished' | 'running' | 'scheduled';
  championId: string | null;
  championName: string;
  runnerUpId: string | null;
  runnerUpName: string;
  teams: number;
  /** 显示用真实奖金池（美元；更早赛季的未完成数据为 null） */
  prizePool: number | null;
}

export interface PediaTournamentPage extends PediaTournamentRow {
  placements: {
    teamId: string;
    teamName: string;
    rankFrom: number;
    rankTo: number;
    label: string;
    prize: [number, number] | null;
    /** 当时的首发（冠亚军；TI 为全部正赛队伍） */
    lineup: { id: string; handle: string }[] | null;
  }[];
}

export interface PediaHeroRow {
  heroId: string;
  name: string;
  cn: string;
  picks: number;
  wins: number;
  winRate: number;
  bans: number;
  /** 出场率 = 出场 / 对局数 */
  pickRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
}

export interface PediaSearchHit {
  kind: 'team' | 'player' | 'tournament' | 'hero';
  id: string;
  label: string;
  sub: string;
}

// ===========================================================================
// 静态数据：开局前的真实 TI 名次（tiResults.json）与 Valve Major 所在赛季
// ===========================================================================

type TiRow = [string, string, string, string[]];
const TI_RESULTS: Record<string, TiRow[]> = ((tiResultsJson as unknown as { tis?: Record<string, TiRow[]> }).tis ?? {});

function parseRank(s: string): [number, number] | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
}

function tiRowsOf(ti: number): TiRow[] {
  const rows = TI_RESULTS[String(ti)];
  return Array.isArray(rows) ? rows : [];
}

/** 选手 id → 真实 TI 履历（全部届次） */
let playerTiCache: Map<string, { ti: number; teamId: string; teamName: string; from: number; to: number; n: number }[]> | null = null;
function realPlayerTis(): Map<string, { ti: number; teamId: string; teamName: string; from: number; to: number; n: number }[]> {
  if (playerTiCache) return playerTiCache;
  const map = new Map<string, { ti: number; teamId: string; teamName: string; from: number; to: number; n: number }[]>();
  for (const key of Object.keys(TI_RESULTS)) {
    const ti = Number(key);
    const rows = tiRowsOf(ti);
    for (const [teamId, teamName, res, ids] of rows) {
      const r = parseRank(res);
      if (!r) continue;
      for (const id of ids ?? []) {
        let list = map.get(id);
        if (!list) map.set(id, (list = []));
        list.push({ ti, teamId, teamName, from: r[0], to: r[1], n: rows.length });
      }
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.ti - b.ti);
  playerTiCache = map;
  return map;
}

let realNameCache: Map<string, string> | null = null;
/** 真实 TI 名次表中某战队的名称（最近一届；tiResults.json） */
function realTeamName(teamId: string): string | null {
  if (!realNameCache) {
    realNameCache = new Map();
    const keys = Object.keys(TI_RESULTS).map(Number).sort((a, b) => a - b);
    for (const ti of keys) for (const r of tiRowsOf(ti)) realNameCache.set(r[0], r[1]);
  }
  return realNameCache.get(teamId) ?? null;
}

const majorSeasonCache = new Map<string, number>();
function nameTokens(s: string): string[] {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((t) => t && !/^(19|20)\d\d$/.test(t) && !['the', 'major', 'season'].includes(t));
}

/** Valve Major 名称（如「Kiev Major 2017」）→ 所在赛季（TI 序号）：按同年的赛事模板名称匹配，找不到时按年份近似 */
export function majorSeasonOf(name: string): number {
  const hit = majorSeasonCache.get(name);
  if (hit !== undefined) return hit;
  const year = Number(/(19|20)\d\d(?!.*(19|20)\d\d)/.exec(name)?.[0] ?? NaN);
  const want = nameTokens(name);
  let best = 0;
  let bestScore = 0;
  let bestMajor = false;
  const last = Math.max(1, lastTournamentDataSeason());
  for (let s = 1; s <= last; s++) {
    for (const t of getTournamentTemplates(s)) {
      if (Number.isFinite(year) && Number(t.startDate.slice(0, 4)) !== year) continue;
      const have = new Set(nameTokens(t.name));
      let score = 0;
      for (const w of want) if (have.has(w)) score++;
      const major = t.tier === 'major';
      // 共同词最多者；同分时 Major 级模板优先，其次更早的赛季
      if (score > 0 && (score > bestScore || (score === bestScore && major && !bestMajor))) {
        bestScore = score;
        best = s;
        bestMajor = major;
      }
    }
  }
  if (!best && Number.isFinite(year)) {
    // 无模板：同年 TI 的赛季（TI 之前的 Major 属于该赛季）
    const info = getAllTiInfo().find((x) => x.year === year);
    best = info?.ti ?? 0;
  }
  majorSeasonCache.set(name, best);
  return best;
}

// ===========================================================================
// 基础工具
// ===========================================================================

function emptyTotals(): PediaStatTotals {
  return { games: 0, wins: 0, losses: 0, winRate: 0, kills: 0, deaths: 0, assists: 0, kda: 0, avgKills: 0, avgDeaths: 0, avgAssists: 0, mvps: 0 };
}

function finishTotals<T extends PediaStatTotals>(t: T): T {
  t.losses = Math.max(0, t.games - t.wins);
  t.winRate = t.games > 0 ? t.wins / t.games : 0;
  t.kda = (t.kills + t.assists) / Math.max(1, t.deaths);
  t.avgKills = t.games > 0 ? t.kills / t.games : 0;
  t.avgDeaths = t.games > 0 ? t.deaths / t.games : 0;
  t.avgAssists = t.games > 0 ? t.assists / t.games : 0;
  return t;
}

function addRow(t: PediaStatTotals, r: PediaPlayerSeason): void {
  t.games += r[2] || 0;
  t.wins += r[3] || 0;
  t.kills += r[4] || 0;
  t.deaths += r[5] || 0;
  t.assists += r[6] || 0;
  t.mvps += r[7] || 0;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fix2 = (v: number) => v.toFixed(2);

/** 金币（与 util.formatGold 同口径，避免循环引用） */
function gold(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(a >= 1e6 ? 0 : 1)}万`;
  return `${sign}${Math.round(a)}`;
}

function sinceOf(ps: PediaState | null, state: GameState): { ti: number; round: number } {
  const s = ps?.since;
  if (Array.isArray(s) && Number.isFinite(s[0])) return { ti: s[0], round: Number.isFinite(s[1]) ? s[1] : 0 };
  return { ti: state.settings?.startTi ?? state.season?.ti ?? 0, round: 0 };
}

function titleRef(h: TournamentHistoryEntry): PediaTitleRef {
  return { tournamentId: h.tournamentId, name: h.name, tier: h.tier, tierLabel: TOURNAMENT_TIER_LABEL[h.tier] ?? h.tier, season: h.season };
}

function tierCounts(): Record<TournamentTier, number> {
  return { ti: 0, major: 0, premier: 0, minor: 0, qualifier: 0 };
}

// ===========================================================================
// 索引（按状态修订号缓存）
// ===========================================================================

interface TeamIdx {
  id: string;
  seasons: PediaTeamSeason[];
  m: number;
  sw: number;
  sd: number;
  sl: number;
  gw: number;
  gl: number;
  k: number;
  d: number;
  pc: number;
  pp: number;
  titles: PediaTitleRef[];
  placements: (PediaTitleRef & { from: number; to: number; n: number })[];
  ti: { ti: number; from: number; to: number; n: number }[];
}

interface PlayerIdx {
  id: string;
  name: string;
  pos: Position | null;
  rows: PediaPlayerSeason[];
  totals: PediaStatTotals;
  prize: number;
  sw: number;
  sd: number;
  sl: number;
  seasons: Set<number>;
  titles: (PediaTitleRef & { teamId: string })[];
  finals: (PediaTitleRef & { teamId: string })[];
  ti: { ti: number; teamId: string; from: number; to: number; n: number }[];
  /** 赛季末阵容快照：[赛季, 战队] */
  rosters: [number, string][];
  /** 最近效力的战队（按数据行） */
  lastTeamId: string | null;
}

interface Index {
  key: string;
  ps: PediaState | null;
  hist: Map<string, TournamentHistoryEntry>;
  teams: Map<string, TeamIdx>;
  players: Map<string, PlayerIdx>;
  /** 当季实时实力排名（AI 战队部分赛季实力分） */
  liveRank: Map<string, number> | null;
  liveTeams: number;
  legacy: Map<string, PediaTeamLegacy> | null;
  standings: Map<string, PediaPlayerStanding> | null;
}

const cache = new WeakMap<GameState, Index>();

/**
 * 缓存键：统计写入修订号（stats.pediaRevision，含弃权 / 奖金 / 赛季末快照等不产生对局的写入）+ 存档中的统计序号
 * + 回合 / 赛事史 + 回合内的世界变化（新闻 / 财务 / id 计数：转会、事件荣誉、训练等会改变实时实力排名与历史地位的操作）。
 */
function indexKey(state: GameState): string {
  const ps = state.pedia;
  return [
    state.id, pediaRevision(), ps?.seq ?? 0, ps?.v ?? 0, Object.keys(ps?.teams ?? {}).length, state.history?.tournaments?.length ?? 0,
    state.season?.ti ?? 0, state.roundIndex ?? 0, state.phase ?? '', Object.keys(state.teams ?? {}).length,
    state.idCounter ?? 0, state.news?.length ?? 0, state.finance?.length ?? 0, Object.keys(state.players ?? {}).length,
  ].join('|');
}

function newTeamIdx(id: string): TeamIdx {
  return { id, seasons: [], m: 0, sw: 0, sd: 0, sl: 0, gw: 0, gl: 0, k: 0, d: 0, pc: 0, pp: 0, titles: [], placements: [], ti: [] };
}

function newPlayerIdx(id: string, name: string, pos: Position | null): PlayerIdx {
  return {
    id, name, pos, rows: [], totals: emptyTotals(), prize: 0, sw: 0, sd: 0, sl: 0, seasons: new Set(), titles: [], finals: [], ti: [],
    rosters: [], lastTeamId: null,
  };
}

function buildIndex(state: GameState, key: string): Index {
  const ps = pediaOf(state);
  const hist = new Map<string, TournamentHistoryEntry>();
  const teams = new Map<string, TeamIdx>();
  const players = new Map<string, PlayerIdx>();
  const team = (id: string) => {
    let t = teams.get(id);
    if (!t) teams.set(id, (t = newTeamIdx(id)));
    return t;
  };
  for (const h of state.history?.tournaments ?? []) {
    if (!h || typeof h.tournamentId !== 'string') continue;
    hist.set(h.tournamentId, h);
    const ref = titleRef(h);
    for (const [teamId, pl] of Object.entries(h.placements ?? {})) {
      if (!Array.isArray(pl)) continue;
      const t = team(teamId);
      t.placements.push({ ...ref, from: pl[0], to: pl[1], n: pl[2] });
      if (h.tier === 'ti') t.ti.push({ ti: h.season, from: pl[0], to: pl[1], n: pl[2] });
    }
    if (h.championId && h.tier !== 'qualifier') team(h.championId).titles.push(ref);
  }
  for (const id in state.teams) team(id);
  if (ps) {
    for (const [id, e] of Object.entries(ps.teams)) {
      if (!e || !Array.isArray(e.s)) continue;
      const t = team(id);
      t.seasons = e.s;
      for (const r of e.s) {
        t.sw += r.sw || 0;
        t.sd += r.sd || 0;
        t.sl += r.sl || 0;
        t.gw += r.gw || 0;
        t.gl += r.gl || 0;
        t.k += r.k || 0;
        t.d += r.d || 0;
        t.m += r.m || 0;
        t.pc += r.pc || 0;
        t.pp += r.pp || 0;
      }
    }
    for (const [id, e] of Object.entries(ps.players)) {
      if (!e || !Array.isArray(e.s)) continue;
      const p = newPlayerIdx(id, state.players[id]?.handle ?? e.n ?? id, state.players[id]?.position ?? e.p ?? null);
      p.rows = e.s;
      for (const r of e.s) {
        addRow(p.totals, r);
        p.prize += r[8] || 0;
        p.sw += r[9] || 0;
        p.sd += r[10] || 0;
        p.sl += r[11] || 0;
        if ((r[2] || 0) > 0) {
          p.seasons.add(r[0]);
          p.lastTeamId = r[1];
        }
      }
      // 现役选手显示当前东家（同赛季转会后又回到原队时，数据行的先后不代表最近效力的战队）
      const sp = state.players[id];
      if (sp?.teamId && sp.status === 'active' && !sp.tempSubUntilTournament && !sp.isWildSub) p.lastTeamId = sp.teamId;
      finishTotals(p.totals);
      players.set(id, p);
    }
    const player = (id: string) => {
      let p = players.get(id);
      if (!p) {
        const sp = state.players[id];
        players.set(id, (p = newPlayerIdx(id, sp?.handle ?? id, sp?.position ?? null)));
      }
      return p;
    };
    for (const [teamId, e] of Object.entries(ps.teams)) {
      for (const r of e?.s ?? []) for (const id of r.r ?? []) player(id).rosters.push([r.ti, teamId]);
    }
    for (const [tid, tour] of Object.entries(ps.tours)) {
      const h = hist.get(tid);
      if (!h || !tour || !Array.isArray(tour.top)) continue;
      const ref = titleRef(h);
      for (const [teamId, from, to, ids] of tour.top) {
        for (const id of ids ?? []) {
          const p = player(id);
          if (from === 1 && to === 1 && h.tier !== 'qualifier') p.titles.push({ ...ref, teamId });
          else if (from === 2 && to === 2 && h.tier !== 'qualifier') p.finals.push({ ...ref, teamId });
          if (h.tier === 'ti') p.ti.push({ ti: h.season, teamId, from, to, n: Object.keys(h.placements ?? {}).length });
        }
      }
    }
  }
  return { key, ps, hist, teams, players, liveRank: null, liveTeams: 0, legacy: null, standings: null };
}

function indexOf(state: GameState): Index {
  const key = indexKey(state);
  const hit = cache.get(state);
  if (hit && hit.key === key) return hit;
  const idx = buildIndex(state, key);
  cache.set(state, idx);
  return idx;
}

function teamName(state: GameState, idx: Index | null, id: string | null | undefined): string {
  if (!id) return '—';
  return state.teams[id]?.name ?? idx?.ps?.teams?.[id]?.n ?? realTeamName(id) ?? id;
}

function playerName(state: GameState, idx: Index | null, id: string): string {
  return state.players[id]?.handle ?? idx?.ps?.players?.[id]?.n ?? id;
}

// ===========================================================================
// 历史地位（战队）
// ===========================================================================

const preGameCache = new Map<string, PediaPreGame | null>();
let historyBoardCache: { id: string; score: number }[] | null = null;

/** 历史排行榜（legacyClubs 全部真实俱乐部）的传奇值，降序 */
function historyBoard(): { id: string; score: number }[] {
  if (historyBoardCache) return historyBoardCache;
  historyBoardCache = legacyClubs().map((c) => ({ id: c.id, score: legacyScore(clubStats(c), { history: true }).total }))
    .sort((a, b) => b.score - a.score);
  return historyBoardCache;
}

function emptyStats(): LegacyStats {
  return {
    tiTitles: [], tiRunnerUp: [], tiTop4: [], tiTop8: [], tiAppearances: 0, backToBack: 0, majors: 0, premiers: 0, minors: 0,
    seasons: 0, strength: [], topSeasons: 0, honorPeak: null,
  };
}

/** 以 TI 名次近似实力排名（与 legacy.clubStats 同口径） */
function approxRank(from: number): number {
  return from === 1 ? 1 : from === 2 ? 2 : from <= 4 ? 3 : from <= 8 ? 6 : 12;
}

function pushTi(st: LegacyStats, ti: number, from: number): void {
  st.tiAppearances += 1;
  if (from === 1) st.tiTitles.push(ti);
  else if (from === 2) st.tiRunnerUp.push(ti);
  else if (from <= 4) st.tiTop4.push(ti);
  else if (from <= 8) st.tiTop8.push(ti);
}

/**
 * 战队开局前（现实）的成就：TI 序号 < 起始 TI 的真实 TI 名次（tiResults.json，按 legacyClubs 的同组织 id 合并）
 * 与 Valve Major 冠军（legacyClubs.json，按赛事所在赛季过滤）。无任何记录时为 null。
 */
export function pediaPreGameOf(startTi: number, teamId: string): PediaPreGame | null {
  const ck = `${startTi}|${teamId}`;
  if (preGameCache.has(ck)) return preGameCache.get(ck) ?? null;
  const club: LegacyClubRef | null = legacyClubs().find((c) => c.teamIds.includes(teamId)) ?? null;
  const aliases = new Set([teamId, ...(club?.teamIds ?? [])]);
  const st = emptyStats();
  const tiResults: PediaPreGame['tiResults'] = [];
  const seen = new Set<number>();
  for (let ti = 1; ti < startTi; ti++) {
    let best: { name: string; r: [number, number] } | null = null;
    for (const row of tiRowsOf(ti)) {
      if (!aliases.has(row[0])) continue;
      const r = parseRank(row[2]);
      if (r && (!best || r[0] < best.r[0])) best = { name: row[1], r };
    }
    if (!best) continue;
    seen.add(ti);
    pushTi(st, ti, best.r[0]);
    st.strength.push({ ti, rank: approxRank(best.r[0]), teams: 0 });
    tiResults.push({ ti, year: tiYear(ti), teamName: best.name, rankFrom: best.r[0], rankTo: best.r[1], label: tiLabel(best.r[0], best.r[1]) });
  }
  // 参照表中有、名次表中缺失的届次（防御：名次表与参照表不一致时以参照表补齐）
  if (club) {
    const add = (list: number[], from: number) => {
      for (const ti of list) {
        if (ti >= startTi || seen.has(ti)) continue;
        seen.add(ti);
        pushTi(st, ti, from);
        st.strength.push({ ti, rank: approxRank(from), teams: 0 });
        tiResults.push({ ti, year: tiYear(ti), teamName: club.name, rankFrom: from, rankTo: from <= 2 ? from : from === 3 ? 4 : 8, label: tiLabel(from, from <= 2 ? from : from === 3 ? 4 : 8) });
      }
    };
    add(club.tiTitles, 1);
    add(club.tiRunnerUp, 2);
    add(club.tiTop4, 3);
    add(club.tiTop8, 5);
  }
  const majors = (club?.majorList ?? []).map((name) => ({ name, ti: majorSeasonOf(name) })).filter((m) => m.ti > 0 && m.ti < startTi);
  st.majors = majors.length;
  tiResults.sort((a, b) => a.ti - b.ti);
  for (const k of ['tiTitles', 'tiRunnerUp', 'tiTop4', 'tiTop8'] as const) st[k].sort((a, b) => a - b);
  st.backToBack = backToBackCount(st.tiTitles);
  st.topSeasons = st.tiTitles.length + st.tiRunnerUp.length + st.tiTop4.length;
  st.seasons = tiResults.length;
  if (!tiResults.length && !majors.length) {
    preGameCache.set(ck, null);
    return null;
  }
  const bits: string[] = [];
  if (st.tiTitles.length) bits.push(`${st.tiTitles.map((t) => `TI${t}`).join('/')} 冠军`);
  if (st.tiRunnerUp.length) bits.push(`${st.tiRunnerUp.map((t) => `TI${t}`).join('/')} 亚军`);
  if (st.tiTop4.length) bits.push(`TI 前四 ×${st.tiTop4.length}`);
  if (majors.length) bits.push(`Major 冠军 ×${majors.length}`);
  bits.push(`TI 参赛 ${st.tiAppearances} 次`);
  // 俱乐部一句话描述的是它完整的现实履历；起始 TI 之后还有现实成绩时（如 TI9 开局的 OG「TI8–TI9 两连冠」）不显示，避免剧透本局尚未发生的历史
  const spoiler = !!club && (club.lastTi >= startTi || club.majorList.some((name) => majorSeasonOf(name) >= startTi));
  const res: PediaPreGame = {
    startTi,
    clubId: club?.id ?? null,
    clubName: club?.name ?? null,
    highlight: club && !spoiler && club.highlight ? club.highlight : null,
    tiResults,
    majors,
    stats: st,
    score: legacyScore(st, { history: true }).total,
    title: legacyTitleOf(st),
    summary: bits.join(' · '),
  };
  preGameCache.set(ck, res);
  return res;
}

function tiLabel(from: number, to: number): string {
  if (from === 1 && to === 1) return '冠军';
  if (from === 2 && to === 2) return '亚军';
  return formatRank(from, to);
}

/** 当季实时实力排名（AI 战队当季尚未结算时的部分赛季实力分） */
function ensureLiveRank(state: GameState, idx: Index): void {
  if (idx.liveRank) return;
  const ids = Object.values(state.teams).filter((t) => !t.disbanded && (t.playerIds?.length ?? 0) > 0).map((t) => t.id);
  let order: string[] = [];
  try {
    order = rankTeamsByRating(state, ids);
  } catch {
    order = ids;
  }
  idx.liveRank = new Map(order.map((id, i) => [id, i + 1]));
  idx.liveTeams = order.length;
}

/** 本局成就（AI 战队：赛事史 + 赛季末实力快照 + 当季实时实力；人类战队：legacy.teamLegacyStats，与结算页一致） */
function inGameStats(state: GameState, idx: Index, teamId: string): LegacyStats {
  const team = state.teams[teamId];
  const log = state.legacyLog?.[teamId];
  if (team && (team.isPlayer || (Array.isArray(log) && log.length > 0))) {
    try {
      return teamLegacyStats(state, teamId);
    } catch {
      /* 回落到通用口径 */
    }
  }
  const t = idx.teams.get(teamId);
  const st = emptyStats();
  if (!t) return st;
  const tiSeen = new Set<number>();
  for (const r of t.ti.slice().sort((a, b) => a.ti - b.ti)) {
    if (tiSeen.has(r.ti)) continue;
    tiSeen.add(r.ti);
    pushTi(st, r.ti, r.from);
  }
  for (const x of t.titles) {
    if (x.tier === 'major') st.majors++;
    else if (x.tier === 'premier') st.premiers++;
    else if (x.tier !== 'ti') st.minors++;
  }
  const cur = state.season?.ti ?? 0;
  let peak: number | null = null;
  const snapSeasons = new Set<number>();
  for (const r of t.seasons) {
    if (Number.isFinite(r.sr) && Number.isFinite(r.st)) {
      st.strength.push({ ti: r.ti, rank: r.sr as number, teams: r.st as number });
      snapSeasons.add(r.ti);
    }
    if (Number.isFinite(r.h)) peak = Math.max(peak ?? -Infinity, r.h as number);
  }
  if (team && !team.disbanded && !snapSeasons.has(cur) && (state.roundIndex ?? 0) > 0) {
    ensureLiveRank(state, idx);
    const rank = idx.liveRank?.get(teamId);
    if (rank) st.strength.push({ ti: cur, rank, teams: idx.liveTeams });
  }
  if (team && !team.disbanded && Number.isFinite(team.honor)) peak = Math.max(peak ?? -Infinity, team.honor);
  st.seasons = st.strength.length;
  st.topSeasons = st.strength.filter((s) => s.rank >= 1 && s.rank <= 3).length;
  st.backToBack = backToBackCount(st.tiTitles);
  st.honorPeak = peak === null || !Number.isFinite(peak) ? null : Math.round(peak);
  return st;
}

function mergeStats(pre: LegacyStats | null, cur: LegacyStats): LegacyStats {
  if (!pre) return cur;
  const cat = (a: number[], b: number[]) => [...a, ...b].sort((x, y) => x - y);
  const tiTitles = cat(pre.tiTitles, cur.tiTitles);
  return {
    tiTitles,
    tiRunnerUp: cat(pre.tiRunnerUp, cur.tiRunnerUp),
    tiTop4: cat(pre.tiTop4, cur.tiTop4),
    tiTop8: cat(pre.tiTop8, cur.tiTop8),
    tiAppearances: pre.tiAppearances + cur.tiAppearances,
    backToBack: backToBackCount(tiTitles),
    majors: pre.majors + cur.majors,
    premiers: pre.premiers + cur.premiers,
    minors: pre.minors + cur.minors,
    seasons: pre.seasons + cur.seasons,
    strength: [...pre.strength, ...cur.strength],
    topSeasons: pre.topSeasons + cur.topSeasons,
    honorPeak: cur.honorPeak,
  };
}

function legacyFor(state: GameState, idx: Index, teamId: string): Omit<PediaTeamLegacy, 'rank' | 'total' | 'summary'> {
  const team = state.teams[teamId];
  const startTi = state.settings?.startTi ?? state.season?.ti ?? 1;
  const pre = pediaPreGameOf(startTi, teamId);
  const inGame = inGameStats(state, idx, teamId);
  const stats = mergeStats(pre?.stats ?? null, inGame);
  const banned = !!team?.banned;
  const score = legacyScore(stats, { banned });
  const inScore = legacyScore(inGame, { banned });
  const title = legacyTitleOf(stats);
  // 真实俱乐部（如 OG）在本局中就是它自己：历史排行榜与「最接近的历史俱乐部」都不再与它的现实条目比较
  const ownClub = pre?.clubId ?? legacyClubs().find((c) => c.teamIds.includes(teamId))?.id ?? null;
  const board = ownClub ? historyBoard().filter((c) => c.id !== ownClub) : historyBoard();
  let historyRank = 1;
  for (const c of board) if (c.score >= score.total) historyRank++;
  const m = matchHistoricalClub(stats, score.total, ownClub);
  return {
    teamId,
    name: teamName(state, idx, teamId),
    tag: team?.tag ?? idx.ps?.teams?.[teamId]?.tag ?? '',
    color: team?.color ?? '#888888',
    active: !!team && !team.disbanded,
    human: !!team?.isPlayer,
    score: score.total,
    inGameScore: inScore.total,
    preGameScore: pre?.score ?? 0,
    title,
    grade: legacyGrade(score.total),
    historyRank,
    historySize: board.length + 1,
    match: m ? { clubId: m.club.id, name: m.club.name, line: clubLine(m.club), score: m.score, title: m.title } : null,
    stats,
    inGameStats: inGame,
    preGame: pre,
    parts: score.parts,
  };
}

function ensureLegacy(state: GameState, idx: Index): Map<string, PediaTeamLegacy> {
  if (idx.legacy) return idx.legacy;
  const rows: Omit<PediaTeamLegacy, 'rank' | 'total' | 'summary'>[] = [];
  for (const id of idx.teams.keys()) {
    const team = state.teams[id];
    const known = !!team || !!idx.ps?.teams?.[id];
    if (!known) continue;
    const row = legacyFor(state, idx, id);
    // 已解散且没有任何成就的组织不进入历史地位榜
    if (!row.active && !(row.score > 0) && !row.human) continue;
    rows.push(row);
  }
  rows.sort((a, b) => b.score - a.score || b.inGameScore - a.inGameScore || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const map = new Map<string, PediaTeamLegacy>();
  rows.forEach((r, i) => {
    const summary = `${r.title.name} · 传奇值 ${r.score} · 本局第 ${i + 1} / ${rows.length} · 历史第 ${r.historyRank} / ${r.historySize}`;
    map.set(r.teamId, { ...r, rank: i + 1, total: rows.length, summary });
  });
  idx.legacy = map;
  return map;
}

/** 全部战队的实时历史地位（按综合传奇值降序；含已解散但有成就的战队） */
export function pediaLegacyBoard(state: GameState, limit?: number): PediaTeamLegacy[] {
  const list = [...ensureLegacy(state, indexOf(state)).values()].sort((a, b) => a.rank - b.rank);
  return typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
}

/** 某战队的实时历史地位（不存在时 null） */
export function pediaTeamLegacy(state: GameState, teamId: string): PediaTeamLegacy | null {
  return ensureLegacy(state, indexOf(state)).get(teamId) ?? null;
}

// ===========================================================================
// 历史地位（选手，简化版）
// ===========================================================================

function playerTiResults(state: GameState, idx: Index, id: string): PediaPlayerTiResult[] {
  const startTi = state.settings?.startTi ?? 1;
  const out: PediaPlayerTiResult[] = [];
  for (const r of realPlayerTis().get(id) ?? []) {
    if (r.ti >= startTi) continue;
    out.push({ ti: r.ti, teamId: r.teamId, teamName: r.teamName, rankFrom: r.from, rankTo: r.to, label: tiLabel(r.from, r.to), real: true });
  }
  const p = idx.players.get(id);
  const seen = new Set(out.map((r) => r.ti));
  for (const r of (p?.ti ?? []).slice().sort((a, b) => a.ti - b.ti)) {
    if (seen.has(r.ti)) continue;
    seen.add(r.ti);
    out.push({ ti: r.ti, teamId: r.teamId, teamName: teamName(state, idx, r.teamId), rankFrom: r.from, rankTo: r.to, label: tiLabel(r.from, r.to), real: false });
  }
  return out.sort((a, b) => a.ti - b.ti);
}

function standingScore(state: GameState, idx: Index, id: string): { score: number; title: string; parts: { label: string; value: number }[] } {
  const S = P().playerScore;
  const T = P().playerTitles;
  const parts: { label: string; value: number }[] = [];
  const add = (label: string, v: number) => {
    if (v) parts.push({ label, value: Math.round(v * 10) / 10 });
    return v;
  };
  const tis = playerTiResults(state, idx, id);
  const tiWins = tis.filter((r) => r.rankFrom === 1 && r.rankTo === 1).length;
  const ru = tis.filter((r) => r.rankFrom === 2).length;
  const top4 = tis.filter((r) => r.rankFrom >= 3 && r.rankFrom <= 4).length;
  const top8 = tis.filter((r) => r.rankFrom >= 5 && r.rankFrom <= 8).length;
  const p = idx.players.get(id);
  const counts = tierCounts();
  for (const t of p?.titles ?? []) counts[t.tier]++;
  let score = 0;
  score += add(`TI 冠军 × ${tiWins}`, tiWins * S.tiTitle);
  score += add(`TI 亚军 × ${ru}`, ru * S.tiRunnerUp);
  score += add(`TI 前四 × ${top4}`, top4 * S.tiTop4);
  score += add(`TI 前八 × ${top8}`, top8 * S.tiTop8);
  score += add(`TI 参赛 × ${tis.length}`, tis.length * S.tiAppearance);
  score += add(`Major 冠军 × ${counts.major}`, counts.major * S.major);
  score += add(`顶级赛事冠军 × ${counts.premier}`, counts.premier * S.premier);
  score += add(`其他冠军 × ${counts.minor}`, counts.minor * S.minor);
  const mvps = p?.totals.mvps ?? 0;
  score += add(`MVP × ${mvps}`, Math.min(S.mvpCap, mvps * S.mvp));
  const seasons = p?.seasons.size ?? 0;
  score += add(`赛季 × ${seasons}`, seasons * S.season);
  const sp = state.players[id];
  const e = idx.ps?.players?.[id];
  const peakIdx = Math.max(e?.pt ?? -1, sp ? tierIndex(playerTier(sp)) : -1);
  const peak = peakIdx >= 0 ? TIERS[peakIdx] : null;
  if (peak) score += add(`巅峰等级 ${peak}`, S.peakTier[peak] ?? 0);
  const title = tiWins >= T.legendTi ? '不朽传奇'
    : tiWins >= T.doubleTi ? '双冠名宿'
      : tiWins >= 1 ? '不朽盾得主'
        : counts.major >= 1 ? '大赛冠军'
          : counts.premier + counts.minor >= 1 ? '冠军选手'
            : '职业选手';
  return { score: Math.round(score * 10) / 10, title, parts };
}

function ensureStandings(state: GameState, idx: Index): Map<string, PediaPlayerStanding> {
  if (idx.standings) return idx.standings;
  const startTi = state.settings?.startTi ?? 1;
  const ids = new Set<string>(idx.players.keys());
  // 开局前有真实 TI 履历、仍在本局中的选手（尚未出场也参与排名）
  for (const [id, list] of realPlayerTis()) if (state.players[id] && list.some((r) => r.ti < startTi)) ids.add(id);
  const rows = [...ids].map((id) => ({ id, ...standingScore(state, idx, id) }));
  rows.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const map = new Map<string, PediaPlayerStanding>();
  rows.forEach((r, i) => map.set(r.id, { playerId: r.id, score: r.score, rank: i + 1, total: rows.length, title: r.title, parts: r.parts }));
  idx.standings = map;
  return map;
}

/** 选手的历史地位（简化版传奇值：TI 名次 + 冠军 + MVP + 赛季 + 巅峰等级，含开局前真实 TI） */
export function pediaPlayerStanding(state: GameState, playerId: string): PediaPlayerStanding | null {
  return ensureStandings(state, indexOf(state)).get(playerId) ?? null;
}

/** 选手历史地位榜（按分数降序） */
export function pediaPlayerStandingBoard(state: GameState, limit?: number): PediaPlayerStanding[] {
  const list = [...ensureStandings(state, indexOf(state)).values()].sort((a, b) => a.rank - b.rank);
  return typeof limit === 'number' && limit > 0 ? list.slice(0, limit) : list;
}

// ===========================================================================
// 总览
// ===========================================================================

/** 有数据的赛季（新 → 旧） */
export function pediaSeasons(state: GameState): number[] {
  const ps = pediaOf(state);
  const set = new Set<number>();
  for (const k of Object.keys(ps?.seasons ?? {})) if (Number.isFinite(Number(k))) set.add(Number(k));
  for (const h of state.history?.tournaments ?? []) if (Number.isFinite(h.season)) set.add(h.season);
  return [...set].sort((a, b) => b - a);
}

/** TI 冠军：开局前的真实 TI（tis.json）+ 本局已结束的 TI */
export function pediaTiChampions(state: GameState): PediaTiChampionRow[] {
  const idx = indexOf(state);
  const startTi = state.settings?.startTi ?? 1;
  const out: PediaTiChampionRow[] = [];
  for (const info of getAllTiInfo()) {
    if (info.ti >= startTi || !info.champion) continue;
    out.push({
      ti: info.ti,
      year: info.year,
      championId: info.champion,
      championName: realTeamNameAt(info.ti, info.champion) ?? teamName(state, idx, info.champion),
      runnerUpId: info.runnerUp ?? null,
      runnerUpName: info.runnerUp ? realTeamNameAt(info.ti, info.runnerUp) ?? teamName(state, idx, info.runnerUp) : '—',
      real: true,
    });
  }
  for (const h of state.history?.tournaments ?? []) {
    if (h.tier !== 'ti') continue;
    const ru = Object.entries(h.placements ?? {}).find(([, pl]) => pl[0] === 2 && pl[1] === 2)?.[0] ?? null;
    out.push({
      ti: h.season,
      year: tiYear(h.season),
      championId: h.championId || null,
      championName: teamName(state, idx, h.championId),
      runnerUpId: ru,
      runnerUpName: teamName(state, idx, ru),
      real: false,
    });
  }
  return out.sort((a, b) => b.ti - a.ti);
}

function realTeamNameAt(ti: number, teamId: string): string | null {
  return tiRowsOf(ti).find((r) => r[0] === teamId)?.[1] ?? null;
}

function overviewOf(state: GameState, idx: Index): PediaOverview {
  const ps = idx.ps;
  let games = 0;
  let kills = 0;
  let minutes = 0;
  for (const v of Object.values(ps?.seasons ?? {})) {
    games += v?.[0] || 0;
    kills += v?.[1] || 0;
    minutes += v?.[2] || 0;
  }
  let series = 0;
  for (const t of idx.teams.values()) series += t.sw + t.sd + t.sl;
  let playersWithGames = 0;
  for (const p of idx.players.values()) if (p.totals.games > 0) playersWithGames++;
  const since = sinceOf(ps, state);
  const startTi = state.settings?.startTi ?? since.ti;
  return {
    since,
    complete: ps?.full === 1 || (since.ti === startTi && since.round <= 0),
    startTi: state.settings?.startTi ?? since.ti,
    currentTi: state.season?.ti ?? since.ti,
    seasonsRecorded: Object.keys(ps?.seasons ?? {}).length,
    games,
    kills,
    avgKills: games > 0 ? kills / games : 0,
    avgDuration: games > 0 ? minutes / games : 0,
    series: Math.round(series / 2),
    tournaments: (state.history?.tournaments ?? []).filter((h) => h.tier !== 'qualifier').length,
    activeTeams: Object.values(state.teams).filter((t) => !t.disbanded).length,
    playersWithGames,
  };
}

/** 选手某赛季（或全部）的合计 */
function playerTotalsIn(p: PlayerIdx, ti?: number): { t: PediaStatTotals; prize: number; teamId: string | null } {
  if (ti === undefined) return { t: p.totals, prize: p.prize, teamId: p.lastTeamId };
  const t = emptyTotals();
  let prize = 0;
  let teamId: string | null = null;
  let best = -1;
  for (const r of p.rows) {
    if (r[0] !== ti) continue;
    addRow(t, r);
    prize += r[8] || 0;
    if ((r[2] || 0) > best) {
      best = r[2] || 0;
      teamId = r[1];
    }
  }
  return { t: finishTotals(t), prize, teamId };
}

function teamTotalsIn(t: TeamIdx, ti?: number): { sw: number; sd: number; sl: number; gw: number; gl: number; k: number; d: number; pc: number; pp: number } {
  if (ti === undefined) return t;
  const r = t.seasons.find((x) => x.ti === ti);
  return r ? r : { sw: 0, sd: 0, sl: 0, gw: 0, gl: 0, k: 0, d: 0, pc: 0, pp: 0 };
}

function top<T>(items: T[], limit: number, score: (x: T) => number, tie: (a: T, b: T) => number): T[] {
  return items.slice().sort((a, b) => score(b) - score(a) || tie(a, b)).slice(0, limit);
}

/**
 * DotaPedia 总览：历史总数据、TI 冠军、排行榜、单局纪录、历史地位榜。
 * opts.ti：只看某赛季（排行榜按该赛季数据；连胜 / 单局纪录 / 历史地位为生涯口径不随筛选变化）。
 */
export function pediaDashboard(state: GameState, opts: { ti?: number; limit?: number } = {}): PediaDashboard {
  const idx = indexOf(state);
  const C = P();
  const limit = Math.max(1, opts.limit ?? C.boardRows);
  const ti = typeof opts.ti === 'number' && Number.isFinite(opts.ti) ? opts.ti : undefined;
  const minGames = ti === undefined ? C.minGames : C.minSeasonGames;
  const minSeries = ti === undefined ? C.minTeamSeries : C.minTeamSeasonSeries;
  const boards: PediaBoard[] = [];
  const players = [...idx.players.values()].map((p) => ({ p, ...playerTotalsIn(p, ti) })).filter((x) => x.t.games > 0 || x.prize > 0);
  const teamsAll = [...idx.teams.values()].map((t) => ({ t, ...teamTotalsIn(t, ti) }));
  const byName = <T extends { p: PlayerIdx }>(a: T, b: T) => (a.p.name < b.p.name ? -1 : a.p.name > b.p.name ? 1 : 0);
  const prow = (x: { p: PlayerIdx; teamId: string | null }, i: number, value: number, display: string, sub?: string): PediaBoardRow => ({
    rank: i + 1, kind: 'player', id: x.p.id, name: x.p.name,
    ...(x.teamId ? { teamId: x.teamId, teamName: teamName(state, idx, x.teamId) } : {}),
    value, display, ...(sub ? { sub } : {}),
  });

  // 战队冠军榜（TI > Major > 顶级 > Minor）
  const titleRows = teamsAll.map((x) => {
    const list = x.t.titles.filter((h) => ti === undefined || h.season === ti);
    const c = tierCounts();
    for (const h of list) c[h.tier]++;
    return { x, c, n: list.length };
  }).filter((r) => r.n > 0);
  titleRows.sort((a, b) => b.n - a.n || b.c.ti - a.c.ti || b.c.major - a.c.major || b.c.premier - a.c.premier
    || (a.x.t.id < b.x.t.id ? -1 : 1));
  boards.push({
    id: 'teamTitles', title: '冠军最多的战队', note: '冠军总数（不含预选赛）；同数按 TI → Major → 顶级赛事',
    rows: titleRows.slice(0, limit).map((r, i) => ({
      rank: i + 1, kind: 'team', id: r.x.t.id, name: teamName(state, idx, r.x.t.id), value: r.n, display: `${r.n} 冠`,
      sub: [r.c.ti ? `TI ×${r.c.ti}` : '', r.c.major ? `Major ×${r.c.major}` : '', r.c.premier ? `顶级 ×${r.c.premier}` : '', r.c.minor ? `Minor ×${r.c.minor}` : '']
        .filter(Boolean).join(' · '),
    })),
  });

  const qual = players.filter((x) => x.t.games >= minGames);
  boards.push({
    id: 'playerKda', title: 'KDA 最高的选手', note: `至少 ${minGames} 局；KDA = (击杀 + 助攻) / 阵亡`,
    rows: top(qual, limit, (x) => x.t.kda, byName).map((x, i) => prow(x, i, x.t.kda, fix2(x.t.kda),
      `${x.t.games} 局 · 场均 ${x.t.avgKills.toFixed(1)}/${x.t.avgDeaths.toFixed(1)}/${x.t.avgAssists.toFixed(1)}`)),
  });
  boards.push({
    id: 'playerMvp', title: 'MVP 最多的选手',
    rows: top(players.filter((x) => x.t.mvps > 0), limit, (x) => x.t.mvps, byName).map((x, i) => prow(x, i, x.t.mvps, `${x.t.mvps} 次`, `${x.t.games} 局`)),
  });
  boards.push({
    id: 'playerWinRate', title: '胜率最高的选手', note: `至少 ${minGames} 局`,
    rows: top(qual, limit, (x) => x.t.winRate + x.t.games * 1e-9, byName).map((x, i) => prow(x, i, x.t.winRate, pct(x.t.winRate), `${x.t.wins} 胜 ${x.t.losses} 负`)),
  });
  boards.push({
    id: 'playerKills', title: '击杀最多的选手',
    rows: top(players.filter((x) => x.t.kills > 0), limit, (x) => x.t.kills, byName).map((x, i) => prow(x, i, x.t.kills, `${x.t.kills}`, `${x.t.games} 局 · 场均 ${x.t.avgKills.toFixed(1)}`)),
  });
  boards.push({
    id: 'playerPrize', title: '奖金最多的选手', note: '队员分成部分（金币）',
    rows: top(players.filter((x) => x.prize > 0), limit, (x) => x.prize, byName).map((x, i) => prow(x, i, x.prize, gold(x.prize))),
  });
  const teamQual = teamsAll.filter((x) => x.sw + x.sd + x.sl >= minSeries);
  const tname = (x: { t: TeamIdx }) => teamName(state, idx, x.t.id);
  const tieT = (a: { t: TeamIdx }, b: { t: TeamIdx }) => (a.t.id < b.t.id ? -1 : 1);
  boards.push({
    id: 'teamWinRate', title: '系列赛胜率最高的战队', note: `至少 ${minSeries} 场系列赛；平局计入场次`,
    rows: top(teamQual, limit, (x) => x.sw / Math.max(1, x.sw + x.sd + x.sl), tieT).map((x, i) => {
      const n = x.sw + x.sd + x.sl;
      const wr = x.sw / Math.max(1, n);
      return { rank: i + 1, kind: 'team' as const, id: x.t.id, name: tname(x), value: wr, display: pct(wr), sub: `${x.sw} 胜 ${x.sd} 平 ${x.sl} 负` };
    }),
  });
  boards.push({
    id: 'teamPrize', title: '奖金最多的战队', note: '名次奖金合计（俱乐部所得 + 队员分成）',
    rows: top(teamsAll.filter((x) => x.pc + x.pp > 0), limit, (x) => x.pc + x.pp, tieT).map((x, i) => ({
      rank: i + 1, kind: 'team' as const, id: x.t.id, name: tname(x), value: x.pc + x.pp, display: gold(x.pc + x.pp),
      sub: `俱乐部 ${gold(x.pc)} · 队员 ${gold(x.pp)}`,
    })),
  });
  if (ti === undefined) {
    const ps = idx.ps;
    boards.push({
      id: 'playerStreak', title: '最长连胜（选手，局）',
      rows: top(players.filter((x) => (ps?.players[x.p.id]?.bs ?? 0) > 0), limit, (x) => ps?.players[x.p.id]?.bs ?? 0, byName)
        .map((x, i) => {
          const e = ps?.players[x.p.id];
          return prow(x, i, e?.bs ?? 0, `${e?.bs ?? 0} 连胜`, e && e.cs > 0 ? `当前 ${e.cs} 连胜` : undefined);
        }),
    });
    boards.push({
      id: 'teamStreak', title: '最长连胜（战队，系列赛）',
      rows: top(teamsAll.filter((x) => (ps?.teams[x.t.id]?.sbs ?? 0) > 0), limit, (x) => ps?.teams[x.t.id]?.sbs ?? 0, tieT).map((x, i) => {
        const e = ps?.teams[x.t.id];
        return {
          rank: i + 1, kind: 'team' as const, id: x.t.id, name: tname(x), value: e?.sbs ?? 0, display: `${e?.sbs ?? 0} 连胜`,
          sub: `小局最长 ${e?.gbs ?? 0} 连胜${e && e.scs > 0 ? ` · 当前 ${e.scs} 连胜` : ''}`,
        };
      }),
    });
  }
  const heroes = pediaHeroStats(state, { ti });
  boards.push({
    id: 'heroPicks', title: '最热门英雄',
    rows: heroes.slice(0, limit).map((h, i) => ({
      rank: i + 1, kind: 'hero', id: h.heroId, name: h.cn, value: h.picks, display: `${h.picks} 场`, sub: `胜率 ${pct(h.winRate)} · 出场率 ${pct(h.pickRate)}`,
    })),
  });
  const heroQual = heroes.filter((h) => h.picks >= C.minHeroPicks);
  boards.push({
    id: 'heroWinRate', title: '胜率最高的英雄', note: `至少 ${C.minHeroPicks} 场`,
    rows: top(heroQual, limit, (h) => h.winRate, (a, b) => (a.heroId < b.heroId ? -1 : 1)).map((h, i) => ({
      rank: i + 1, kind: 'hero', id: h.heroId, name: h.cn, value: h.winRate, display: pct(h.winRate), sub: `${h.picks} 场`,
    })),
  });

  return {
    ...(ti !== undefined ? { ti } : {}),
    seasons: pediaSeasons(state),
    overview: overviewOf(state, idx),
    tiChampions: pediaTiChampions(state),
    boards,
    records: pediaRecords(state),
    legacy: pediaLegacyBoard(state, C.legacyRows),
  };
}

export const PEDIA_RECORD_LABEL: Record<string, string> = {
  kills: '单局个人击杀最多',
  assists: '单局个人助攻最多',
  deaths: '单局个人阵亡最多',
  teamKills: '单局战队击杀最多',
  totalKills: '单局双方击杀最多',
  longest: '最长对局',
  shortest: '最短对局',
};

/** 单局纪录 */
export function pediaRecords(state: GameState): PediaRecordRow[] {
  const idx = indexOf(state);
  const recs = idx.ps?.records ?? {};
  const out: PediaRecordRow[] = [];
  for (const kind of Object.keys(PEDIA_RECORD_LABEL)) {
    const r = recs[kind as keyof typeof recs];
    if (!r || !Number.isFinite(r.v)) continue;
    const minutes = kind === 'longest' || kind === 'shortest';
    out.push({
      kind,
      label: PEDIA_RECORD_LABEL[kind],
      value: r.v,
      display: minutes ? `${r.v} 分钟` : `${r.v}`,
      ...(r.p ? { playerId: r.p, playerName: playerName(state, idx, r.p) } : {}),
      ...(r.h ? { heroId: r.h, heroName: heroName(r.h) } : {}),
      teamId: r.t,
      teamName: teamName(state, idx, r.t),
      oppId: r.o,
      oppName: teamName(state, idx, r.o),
      ti: r.ti,
      date: r.d,
      tierLabel: TOURNAMENT_TIER_LABEL[r.tier] ?? r.tier,
    });
  }
  return out;
}

// ===========================================================================
// 战队页
// ===========================================================================

function teamStatus(team: Team | undefined): { status: PediaTeamPage['status']; label: string } {
  if (!team) return { status: 'unknown', label: '已不在联赛' };
  if (team.banned) return { status: 'banned', label: `因全员假赛被除名（TI${team.banned.season}）` };
  if (team.bankrupt) return { status: 'disbanded', label: `已破产（TI${team.bankrupt.season}）` }; // 第十波 #1（bankruptcy.ts）
  if (team.disbanded) return { status: 'disbanded', label: '已解散' };
  return { status: 'active', label: '现役' };
}

/** 战队页（仿 Liquipedia）；未知战队 id 返回 null */
export function pediaTeamPage(state: GameState, teamId: string): PediaTeamPage | null {
  const idx = indexOf(state);
  const team = state.teams[teamId];
  const t = idx.teams.get(teamId);
  if (!team && !t && !idx.ps?.teams?.[teamId]) return null;
  const ti = t ?? newTeamIdx(teamId);
  const pe = idx.ps?.teams?.[teamId];
  const { status, label } = teamStatus(team);

  // 阵容
  const starters = new Set(Object.values(team?.lineup ?? {}).filter((x): x is string => !!x));
  const roster = (team?.playerIds ?? [])
    .map((id) => state.players[id])
    .filter((p): p is Player => !!p && p.teamId === teamId && !p.isWildSub)
    .map((p) => ({
      id: p.id, handle: p.handle, position: p.position, tier: playerTier(p), starter: starters.has(p.id),
      games: idx.players.get(p.id)?.rows.filter((r) => r[1] === teamId).reduce((a, r) => a + (r[2] || 0), 0) ?? 0,
    }))
    .sort((a, b) => Number(b.starter) - Number(a.starter) || ['C', 'M', 'O', 'SS', 'HS'].indexOf(a.position) - ['C', 'M', 'O', 'SS', 'HS'].indexOf(b.position));
  const coachObj = team?.coachId ? state.coaches[team.coachId] : undefined;

  // 名次 / 冠军 / TI
  const prizeOf = (tid: string): [number, number] | null => {
    const v = idx.ps?.tours?.[tid]?.pz?.[teamId];
    return Array.isArray(v) ? [v[0], v[1]] : null;
  };
  const placements: PediaPlacementRow[] = ti.placements.map((p) => ({
    tournamentId: p.tournamentId, name: p.name, tier: p.tier, tierLabel: p.tierLabel, season: p.season,
    rankFrom: p.from, rankTo: p.to, teams: p.n, label: tiLabel(p.from, p.to), prize: prizeOf(p.tournamentId),
  }));
  placements.sort((a, b) => b.season - a.season || TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.rankFrom - b.rankFrom);
  const titleList = ti.titles.slice().sort((a, b) => b.season - a.season || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const byTier = tierCounts();
  for (const x of titleList) byTier[x.tier]++;
  const tiResults = ti.ti.slice().sort((a, b) => a.ti - b.ti)
    .map((r) => ({ ti: r.ti, rankFrom: r.from, rankTo: r.to, teams: r.n, label: tiLabel(r.from, r.to) }));

  // 分赛季
  const seasonSet = new Set<number>(ti.seasons.map((r) => r.ti));
  for (const p of ti.placements) seasonSet.add(p.season);
  const seasons: PediaTeamSeasonView[] = [...seasonSet].sort((a, b) => b - a).map((s) => {
    const r = ti.seasons.find((x) => x.ti === s);
    const tr = ti.ti.find((x) => x.ti === s);
    const n = r ? r.gw + r.gl : 0;
    return {
      ti: s,
      year: tiYear(s),
      seriesWins: r?.sw ?? 0,
      seriesDraws: r?.sd ?? 0,
      seriesLosses: r?.sl ?? 0,
      gameWins: r?.gw ?? 0,
      gameLosses: r?.gl ?? 0,
      gameWinRate: n > 0 ? (r?.gw ?? 0) / n : 0,
      kills: r?.k ?? 0,
      deaths: r?.d ?? 0,
      avgDuration: n > 0 && r?.m ? r.m / n : 0,
      prizeClub: r?.pc ?? 0,
      prizePlayers: r?.pp ?? 0,
      titles: titleList.filter((x) => x.season === s),
      tiResult: tr ? { rankFrom: tr.from, rankTo: tr.to, teams: tr.n, label: tiLabel(tr.from, tr.to) } : null,
      finalRank: Number.isFinite(r?.fr) && (r?.fr ?? 0) > 0 ? (r?.fr as number) : null,
      strengthRank: Number.isFinite(r?.sr) ? (r?.sr as number) : null,
      strengthTeams: Number.isFinite(r?.st) ? (r?.st as number) : null,
      honorEnd: Number.isFinite(r?.h) ? (r?.h as number) : null,
      roster: (r?.r ?? []).map((id) => ({ id, handle: playerName(state, idx, id) })),
      coach: r?.c ? { id: r.c[0], name: r.c[1] } : null,
      partial: !r || r.h === undefined,
    };
  });

  // 历任主教练（赛季末快照）
  const coaches: PediaTeamPage['coaches'] = [];
  for (const r of ti.seasons.slice().sort((a, b) => a.ti - b.ti)) {
    if (!r.c) continue;
    const last = coaches[coaches.length - 1];
    if (last && last.id === r.c[0] && r.ti === last.toTi + 1) last.toTi = r.ti;
    else coaches.push({ id: r.c[0], name: r.c[1], fromTi: r.ti, toTi: r.ti });
  }

  // 历代队员
  const members = new Map<string, { games: number; wins: number; k: number; d: number; a: number; mvps: number; seasons: Set<number> }>();
  for (const p of idx.players.values()) {
    for (const r of p.rows) {
      if (r[1] !== teamId || !(r[2] > 0)) continue;
      let m = members.get(p.id);
      if (!m) members.set(p.id, (m = { games: 0, wins: 0, k: 0, d: 0, a: 0, mvps: 0, seasons: new Set() }));
      m.games += r[2];
      m.wins += r[3];
      m.k += r[4];
      m.d += r[5];
      m.a += r[6];
      m.mvps += r[7];
      m.seasons.add(r[0]);
    }
  }
  const players = [...members.entries()].map(([id, m]) => ({
    id, handle: playerName(state, idx, id), position: state.players[id]?.position ?? idx.ps?.players?.[id]?.p ?? null,
    games: m.games, wins: m.wins, kda: (m.k + m.a) / Math.max(1, m.d), mvps: m.mvps, seasons: [...m.seasons].sort((a, b) => a - b),
    current: !!team && team.playerIds.includes(id),
  })).sort((a, b) => b.games - a.games || (a.handle < b.handle ? -1 : 1));

  const games = ti.gw + ti.gl;
  const seriesN = ti.sw + ti.sd + ti.sl;
  const totals: PediaTeamTotals = {
    seriesWins: ti.sw,
    seriesDraws: ti.sd,
    seriesLosses: ti.sl,
    seriesWinRate: seriesN > 0 ? ti.sw / seriesN : 0,
    games,
    gameWins: ti.gw,
    gameLosses: ti.gl,
    gameWinRate: games > 0 ? ti.gw / games : 0,
    kills: ti.k,
    deaths: ti.d,
    kd: ti.k / Math.max(1, ti.d),
    avgDuration: games > 0 && ti.m > 0 ? ti.m / games : 0,
    prizeClub: ti.pc,
    prizePlayers: ti.pp,
    prizeTotal: ti.pc + ti.pp,
    titles: titleList.length,
    tiTitles: byTier.ti,
  };
  const legacy = pediaTeamLegacy(state, teamId) ?? { ...legacyFor(state, idx, teamId), rank: 0, total: 0, summary: '' };
  return {
    id: teamId,
    name: teamName(state, idx, teamId),
    tag: team?.tag ?? pe?.tag ?? '',
    color: team?.color ?? '#888888',
    region: team?.region ?? null,
    status,
    statusLabel: label,
    human: !!team?.isPlayer,
    honor: team && !team.disbanded ? Math.round(team.honor) : null,
    lastSeasonRank: team?.lastSeasonRank ?? null,
    coach: coachObj ? { id: coachObj.id, name: coachObj.name, tier: coachObj.tier } : null,
    roster,
    totals,
    seasons,
    titles: { total: titleList.length, byTier, list: titleList },
    placements,
    tiResults,
    coaches,
    players,
    streaks: { series: { current: pe?.scs ?? 0, best: pe?.sbs ?? 0 }, games: { current: pe?.gcs ?? 0, best: pe?.gbs ?? 0 } },
    legacy,
    preGame: legacy.preGame,
    since: sinceOf(idx.ps, state),
  };
}

// ===========================================================================
// 选手页
// ===========================================================================

function playerStatus(state: GameState, id: string, p: Player | undefined): { status: PediaPlayerPage['status']; label: string } {
  for (const c of Object.values(state.coaches ?? {})) if (c?.formerPlayerId === id) return { status: 'coach', label: '已退役，转任教练' };
  if (!p) return { status: 'unknown', label: '已退役' };
  if (p.status === 'banned') return { status: 'banned', label: '已被永久禁赛' };
  if (p.status === 'retired') return { status: 'retired', label: '已退役' };
  if (!p.teamId) return { status: 'free', label: '自由选手' };
  return { status: 'active', label: p.tempSubUntilTournament ? '临时替补' : '现役' };
}

/** 选手页（仿 Liquipedia）；完全未知的选手 id 返回 null */
export function pediaPlayerPage(state: GameState, playerId: string): PediaPlayerPage | null {
  const idx = indexOf(state);
  const p = state.players[playerId];
  const e = idx.ps?.players?.[playerId];
  const pi = idx.players.get(playerId);
  const realTis = realPlayerTis().get(playerId);
  if (!p && !e && !pi && !realTis) return null;
  const startTi = state.settings?.startTi ?? 1;
  const { status, label } = playerStatus(state, playerId, p);
  const rows = (pi?.rows ?? []).slice();

  // 分赛季
  const seasons: PediaPlayerSeasonView[] = rows.filter((r) => (r[2] || 0) > 0 || (r[8] || 0) > 0)
    .sort((a, b) => b[0] - a[0])
    .map((r) => {
      const t = emptyTotals();
      addRow(t, r);
      finishTotals(t);
      return {
        ...t, ti: r[0], year: tiYear(r[0]), teamId: r[1], teamName: teamName(state, idx, r[1]), prize: r[8] || 0,
        seriesWins: r[9] || 0, seriesDraws: r[10] || 0, seriesLosses: r[11] || 0,
      };
    });

  // 战队履历：出场数据 + 赛季末阵容快照 + 当前东家
  const stints = new Map<string, Map<number, { games: number; wins: number }>>();
  const touch = (teamId: string, ti: number, games: number, wins: number) => {
    if (!teamId) return;
    let m = stints.get(teamId);
    if (!m) stints.set(teamId, (m = new Map()));
    const v = m.get(ti) ?? { games: 0, wins: 0 };
    v.games += games;
    v.wins += wins;
    m.set(ti, v);
  };
  for (const r of rows) if ((r[2] || 0) > 0) touch(r[1], r[0], r[2], r[3]);
  for (const [ti, teamId] of pi?.rosters ?? []) touch(teamId, ti, 0, 0);
  if (p?.teamId && !p.tempSubUntilTournament && !p.isWildSub) touch(p.teamId, state.season?.ti ?? 0, 0, 0);
  const teams: PediaPlayerPage['teams'] = [];
  for (const [teamId, m] of stints) {
    const list = [...m.keys()].sort((a, b) => a - b);
    let cur: PediaPlayerPage['teams'][number] | null = null;
    for (const s of list) {
      const v = m.get(s)!;
      if (cur && s === cur.toTi + 1) {
        cur.toTi = s;
        cur.seasons.push(s);
        cur.games += v.games;
        cur.wins += v.wins;
      } else {
        cur = { teamId, teamName: teamName(state, idx, teamId), fromTi: s, toTi: s, seasons: [s], games: v.games, wins: v.wins };
        teams.push(cur);
      }
    }
  }
  teams.sort((a, b) => a.fromTi - b.fromTi || a.toTi - b.toTi);

  // 成就
  const tiResults = playerTiResults(state, idx, playerId);
  const counts = tierCounts();
  const titles = (pi?.titles ?? []).map((x) => ({ ...x, teamName: teamName(state, idx, x.teamId) }))
    .sort((a, b) => b.season - a.season || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  for (const x of titles) counts[x.tier]++;
  const finals = (pi?.finals ?? []).map((x) => ({ ...x, teamName: teamName(state, idx, x.teamId) }))
    .sort((a, b) => b.season - a.season || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  const tiTitles = tiResults.filter((r) => r.rankFrom === 1 && r.rankTo === 1)
    .map((r) => ({ ti: r.ti, teamId: r.teamId, teamName: r.teamName, real: r.real }));

  // 英雄
  const heroes = Object.entries(e?.h ?? {})
    .map(([heroId, v]) => ({ heroId, name: heroName(heroId), games: v[0], wins: v[1], winRate: v[0] > 0 ? v[1] / v[0] : 0 }))
    .sort((a, b) => b.games - a.games || b.wins - a.wins || (a.heroId < b.heroId ? -1 : 1));

  const totals: PediaPlayerTotals = {
    ...(pi?.totals ?? finishTotals(emptyTotals())),
    seriesWins: pi?.sw ?? 0,
    seriesDraws: pi?.sd ?? 0,
    seriesLosses: pi?.sl ?? 0,
    prize: pi?.prize ?? 0,
    seasonsActive: pi?.seasons.size ?? 0,
    bestStreak: e?.bs ?? 0,
    currentStreak: e?.cs ?? 0,
  };
  const curTierIdx = p ? tierIndex(playerTier(p)) : -1;
  const peakIdx = Math.max(curTierIdx, e?.pt ?? -1);
  const rating = p ? Math.round(overallRating(p) * 10) / 10 : null;
  const real = tiResults.filter((r) => r.real);
  return {
    id: playerId,
    handle: p?.handle ?? e?.n ?? pi?.name ?? playerId,
    name: p?.name ?? null,
    nationality: p?.nationality ?? null,
    region: p?.region ?? null,
    position: p?.position ?? e?.p ?? pi?.pos ?? null,
    age: p ? ageOf(state, p) : null,
    tier: p ? playerTier(p) : null,
    peakTier: peakIdx >= 0 ? TIERS[peakIdx] : null,
    rating,
    peakRating: e ? Math.max(e.pr ?? 0, rating ?? 0) : rating,
    status,
    statusLabel: label,
    teamId: p?.teamId ?? null,
    teamName: p?.teamId ? teamName(state, idx, p.teamId) : null,
    isReal: p ? p.isReal : realTis ? true : null,
    totals,
    seasons,
    teams,
    achievements: { tiResults, tiTitles, titles, finals, titleCounts: counts, mvps: totals.mvps },
    heroes,
    heroOther: e?.ho && e.ho[0] > 0 ? { games: e.ho[0], wins: e.ho[1] } : null,
    preGame: real.length ? { tiResults: real.filter((r) => r.ti < startTi) } : null,
    standing: pediaPlayerStanding(state, playerId),
    since: sinceOf(idx.ps, state),
  };
}

// ===========================================================================
// 赛事
// ===========================================================================

/** 赛事列表：已结束（赛事史，全部赛季）+ 本赛季未结束的赛事。按赛季、日期新 → 旧 */
export function pediaTournaments(state: GameState, opts: { ti?: number; tier?: TournamentTier } = {}): PediaTournamentRow[] {
  const idx = indexOf(state);
  const out: PediaTournamentRow[] = [];
  const seen = new Set<string>();
  const ok = (season: number, tier: TournamentTier) => (opts.ti === undefined || season === opts.ti) && (!opts.tier || tier === opts.tier);
  for (const h of state.history?.tournaments ?? []) {
    if (!ok(h.season, h.tier)) continue;
    seen.add(h.tournamentId);
    const live = state.tournaments[h.tournamentId];
    const tour = idx.ps?.tours?.[h.tournamentId];
    const ru = Object.entries(h.placements ?? {}).find(([, pl]) => pl[0] === 2 && pl[1] === 2)?.[0] ?? null;
    out.push({
      id: h.tournamentId,
      name: h.name,
      tier: h.tier,
      tierLabel: TOURNAMENT_TIER_LABEL[h.tier] ?? h.tier,
      season: h.season,
      year: tiYear(h.season),
      date: live?.startDate ?? tour?.d ?? '',
      status: 'finished',
      championId: h.championId || null,
      championName: teamName(state, idx, h.championId),
      runnerUpId: ru,
      runnerUpName: teamName(state, idx, ru),
      teams: Object.keys(h.placements ?? {}).length,
      prizePool: live?.prizePool ?? tour?.pool ?? null,
    });
  }
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    // 已结束却不在赛事史中的 = 无人参赛而取消的赛事，不列出
    if (!t || seen.has(id) || t.status === 'finished' || !ok(t.season, t.tier)) continue;
    out.push({
      id,
      name: t.name,
      tier: t.tier,
      tierLabel: TOURNAMENT_TIER_LABEL[t.tier] ?? t.tier,
      season: t.season,
      year: tiYear(t.season),
      date: t.startDate,
      status: t.status === 'running' ? 'running' : 'scheduled',
      championId: null,
      championName: '—',
      runnerUpId: null,
      runnerUpName: '—',
      teams: Math.max(t.teamIds.length, t.size ?? 0),
      prizePool: t.prizePool,
    });
  }
  out.sort((a, b) => b.season - a.season || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) || TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  return out;
}

/** 赛事详情（名次、奖金、冠亚军 / TI 全部正赛队伍的首发）；未知赛事返回 null */
export function pediaTournament(state: GameState, tournamentId: string): PediaTournamentPage | null {
  const idx = indexOf(state);
  const row = pediaTournaments(state).find((r) => r.id === tournamentId);
  if (!row) return null;
  const h = idx.hist.get(tournamentId);
  const live = state.tournaments[tournamentId];
  const tour = idx.ps?.tours?.[tournamentId];
  const lineupOf = (teamId: string) => {
    const x = tour?.top?.find((r) => r[0] === teamId);
    return x ? x[3].map((id) => ({ id, handle: playerName(state, idx, id) })) : null;
  };
  const list: [string, number, number][] = h
    ? Object.entries(h.placements ?? {}).map(([id, pl]) => [id, pl[0], pl[1]])
    : (live?.placements ?? []).map((pl) => [pl.teamId, pl.rankFrom, pl.rankTo]);
  const placements = list.sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([teamId, from, to]) => {
    const pz = tour?.pz?.[teamId];
    return {
      teamId, teamName: teamName(state, idx, teamId), rankFrom: from, rankTo: to, label: tiLabel(from, to),
      prize: Array.isArray(pz) ? [pz[0], pz[1]] as [number, number] : null,
      lineup: lineupOf(teamId),
    };
  });
  return { ...row, placements };
}

// ===========================================================================
// 英雄
// ===========================================================================

/** 英雄数据（某赛季或全部赛季合计），按出场降序 */
export function pediaHeroStats(state: GameState, opts: { ti?: number } = {}): PediaHeroRow[] {
  const ps = pediaOf(state);
  if (!ps) return [];
  const agg = new Map<string, [number, number, number, number, number, number]>();
  let games = 0;
  for (const [k, map] of Object.entries(ps.heroes ?? {})) {
    if (opts.ti !== undefined && Number(k) !== opts.ti) continue;
    games += ps.seasons?.[k]?.[0] ?? 0;
    for (const [heroId, v] of Object.entries(map ?? {})) {
      const a = agg.get(heroId) ?? [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < 6; i++) a[i] += v?.[i] || 0;
      agg.set(heroId, a);
    }
  }
  const rows: PediaHeroRow[] = [];
  for (const [heroId, v] of agg) {
    const h = heroById(heroId);
    rows.push({
      heroId, name: h?.name ?? heroId, cn: h?.cn ?? heroId, picks: v[0], wins: v[1], winRate: v[0] > 0 ? v[1] / v[0] : 0, bans: v[5],
      pickRate: games > 0 ? v[0] / games : 0, kills: v[2], deaths: v[3], assists: v[4], kda: (v[2] + v[4]) / Math.max(1, v[3]),
    });
  }
  return rows.sort((a, b) => b.picks - a.picks || b.bans - a.bans || (a.heroId < b.heroId ? -1 : 1));
}

/** 某英雄的分赛季数据（旧 → 新） */
export function pediaHeroTrend(state: GameState, heroId: string): { ti: number; picks: number; wins: number; winRate: number; bans: number; pickRate: number }[] {
  const ps = pediaOf(state);
  if (!ps) return [];
  const out: { ti: number; picks: number; wins: number; winRate: number; bans: number; pickRate: number }[] = [];
  for (const [k, map] of Object.entries(ps.heroes ?? {})) {
    const v = map?.[heroId];
    if (!v) continue;
    const games = ps.seasons?.[k]?.[0] ?? 0;
    out.push({ ti: Number(k), picks: v[0], wins: v[1], winRate: v[0] > 0 ? v[1] / v[0] : 0, bans: v[5], pickRate: games > 0 ? v[0] / games : 0 });
  }
  return out.sort((a, b) => a.ti - b.ti);
}

// ===========================================================================
// 搜索
// ===========================================================================

/** 搜索战队 / 选手 / 赛事 / 英雄（名称、简称、id、英雄中英文名；不区分大小写；前缀匹配优先） */
export function pediaSearch(state: GameState, query: string, limit: number = P().searchLimit): PediaSearchHit[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const idx = indexOf(state);
  const hits: (PediaSearchHit & { s: number })[] = [];
  const score = (...texts: (string | undefined | null)[]): number => {
    let best = 0;
    for (const t of texts) {
      const x = String(t ?? '').toLowerCase();
      if (!x) continue;
      if (x === q) best = Math.max(best, 3);
      else if (x.startsWith(q)) best = Math.max(best, 2);
      else if (x.includes(q)) best = Math.max(best, 1);
    }
    return best;
  };
  const teamIds = new Set<string>([...Object.keys(state.teams), ...Object.keys(idx.ps?.teams ?? {})]);
  for (const id of teamIds) {
    const t = state.teams[id];
    const name = teamName(state, idx, id);
    const tag = t?.tag ?? idx.ps?.teams?.[id]?.tag ?? '';
    const s = score(name, tag, id);
    if (s) hits.push({ kind: 'team', id, label: name, sub: [tag, t ? (t.disbanded ? '已解散' : '现役') : '历史战队'].filter(Boolean).join(' · '), s: s + 0.3 });
  }
  const playerIds = new Set<string>([...Object.keys(state.players), ...Object.keys(idx.ps?.players ?? {})]);
  for (const id of playerIds) {
    const p = state.players[id];
    if (p?.isWildSub && !idx.ps?.players?.[id]) continue;
    const handle = p?.handle ?? idx.ps?.players?.[id]?.n ?? id;
    const s = score(handle, p?.name, id);
    if (!s) continue;
    const teamId = p?.teamId ?? idx.players.get(id)?.lastTeamId ?? null;
    // 位置写成「4号位」（位置代码 SS / HS 容易与天梯等级 SS 混淆）
    const pos = p?.position ?? idx.ps?.players?.[id]?.p;
    const posText = pos && POSITION_SHORT[pos] ? `${POSITION_SHORT[pos]}号位` : '';
    hits.push({ kind: 'player', id, label: handle, sub: [posText, teamId ? teamName(state, idx, teamId) : (p ? '自由选手' : '已退役')].filter(Boolean).join(' · '), s: s + 0.2 });
  }
  for (const r of pediaTournaments(state)) {
    const s = score(r.name, r.id);
    if (s) hits.push({ kind: 'tournament', id: r.id, label: r.name, sub: `TI${r.season} 赛季 · ${r.tierLabel}`, s: s + 0.1 });
  }
  const heroIds = new Set<string>();
  for (const map of Object.values(idx.ps?.heroes ?? {})) for (const id of Object.keys(map ?? {})) heroIds.add(id);
  for (const id of heroIds) {
    const h = heroById(id);
    const s = score(h?.cn, h?.name, id);
    if (s) hits.push({ kind: 'hero', id, label: h?.cn ?? id, sub: h?.name ?? id, s });
  }
  hits.sort((a, b) => b.s - a.s || a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
  return hits.slice(0, Math.max(1, limit)).map(({ s: _s, ...rest }) => rest);
}

/** 赛事等级排序（UI 筛选器） */
export const PEDIA_TIERS: readonly TournamentTier[] = ALL_TIERS;
