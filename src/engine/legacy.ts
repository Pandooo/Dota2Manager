// ============================================================================
// 生涯总结 / 传奇值（第八波 #7，类似《文明》的结算页）
//
// 记录：每个赛季结算时（season.settleSeason）为每个人类战队写入一条 LegacySeasonRecord（战力排名、TI 名次、冠军、
// 关键时刻、阵容……）到 state.legacyLog[teamId]；中途出局 / 全员假赛禁赛时冻结截至当时的部分赛季（recordLegacyPartial）。
// legacyLog 是按战队记录的公开数据（不随座位换入换出），多人模式每个座位的视图都能计算所有人类俱乐部的总结。
//
// 计算（computeLegacyReport，纯函数，UI 在渲染时调用）：
//   成就分（TI 冠军 / 亚军 / 前四 / 前八 / 参赛、Major、顶级赛事）+ 实力分（各赛季战力排名，按联盟规模归一）
//   + 声望（荣誉峰值）→ 传奇值；与历史俱乐部参照表（src/data/legacyClubs.json，同一口径计分）比较：
//   称号（三冠王朝 / 两连冠王朝 / 单冠王者 / 常青豪门 / 亚军之王 / 一时劲旅 / 默默无闻……）、最接近的历史俱乐部、
//   历史排行榜名次、赛季时间线、关键时刻、最佳选手、荣誉与资金曲线、结局叙述。
// 「动态平衡」：多冠王朝逐冠递增；实力分按联盟规模归一并以成就分为上限（只有实力没有奖杯不会压过冠军）；
//   声望设上限；全员假赛禁赛按 CONFIG.legacy.bannedScoreMult 折算。所有参数见 CONFIG.legacy。
// ============================================================================
import type {
  ClubBanRecord, FinanceEntry, GameOverReason, GameState, LegacySeasonRecord, Player, Tier, Tournament, TournamentTier,
} from './types';
import { CONFIG } from './config';
import legacyClubsJson from '../data/legacyClubs.json';
import { overallRating, playerTier } from './player';
import { rankTeamsByRating } from './team';
import { formatGold, formatRank } from './util';
import { humanTeamIds, inSeatOf, isMultiplayer, seatOf } from './seat';
import { tiYear } from './calendar';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 历史俱乐部参照（legacyClubs.json） */
export interface LegacyClubRef {
  id: string;
  name: string;
  region: string;
  teamIds: string[];
  firstTi: number;
  lastTi: number;
  tiTitles: number[];
  tiRunnerUp: number[];
  tiTop4: number[];
  tiTop8: number[];
  tiAppearances: number;
  majors: number;
  majorList: string[];
  highlight: string;
}

/** 计分用的成就统计（玩家俱乐部与历史俱乐部同一口径） */
export interface LegacyStats {
  tiTitles: number[];
  tiRunnerUp: number[];
  tiTop4: number[];
  tiTop8: number[];
  tiAppearances: number;
  /** 连续两届夺冠的段数（TI8–TI9 记 1） */
  backToBack: number;
  majors: number;
  premiers: number;
  /** 其他冠军（minor 等，不计分，只展示） */
  minors: number;
  seasons: number;
  /** 各赛季战力排名（排名, 队伍数）；历史俱乐部以 TI 名次近似 */
  strength: { ti: number; rank: number; teams: number }[];
  /** 战力前三的赛季数（历史俱乐部 = TI 前四次数） */
  topSeasons: number;
  honorPeak: number | null;
}

export interface LegacyScore {
  total: number;
  achievements: number;
  strength: number;
  strengthRaw: number;
  prestige: number;
  /** 禁赛折算倍数（未禁赛 = 1） */
  mult: number;
  parts: { label: string; value: number }[];
}

export type LegacyTitleId =
  | 'immortal' | 'triple' | 'double_streak' | 'double' | 'single' | 'runner_king' | 'evergreen' | 'uncrowned'
  | 'contender' | 'unknown';

export interface LegacyTitle {
  id: LegacyTitleId;
  name: string;
  desc: string;
}

export interface LegacyBoardRow {
  key: string;
  name: string;
  score: number;
  title: LegacyTitle;
  tiTitles: number[];
  tiRunnerUp: number[];
  tiTop4: number;
  majors: number;
  /** 历史俱乐部 = 'history'；本俱乐部 = 'self'；其他人类俱乐部 = 'human' */
  kind: 'history' | 'self' | 'human';
  teamId?: string;
  span: string;
  highlight?: string;
}

export interface LegacyTimelineRow {
  ti: number;
  year: number;
  tiLabel: string;
  tiRank: [number, number] | null;
  tiChampion: string | null;
  titles: { name: string; tier: TournamentTier }[];
  finalRank: number;
  strengthRank: number;
  strengthTeams: number;
  honorEnd: number;
  goldEnd: number;
  partial: boolean;
  ending?: GameOverReason;
}

export interface LegacyMoment {
  ti: number;
  text: string;
}

export interface LegacyBestPlayer {
  id: string;
  handle: string;
  position: string;
  seasons: number;
  peakRating: number;
  tier: Tier;
  titles: number;
  tiTitles: number;
  status: Player['status'] | 'unknown';
}

export interface LegacyReport {
  teamId: string;
  teamName: string;
  tag: string;
  color: string;
  managerName: string;
  ending: GameOverReason;
  startTi: number;
  endTi: number;
  seasonsPlayed: number;
  stats: LegacyStats;
  score: LegacyScore;
  title: LegacyTitle;
  grade: string;
  /** 最接近的历史俱乐部 */
  match: { club: LegacyClubRef; score: number; title: LegacyTitle; line: string } | null;
  /** 历史排行榜（含本俱乐部；多人模式含其他人类俱乐部） */
  board: LegacyBoardRow[];
  /** 本俱乐部在排行榜中的名次（1 起）与总数 */
  rank: number;
  boardSize: number;
  timeline: LegacyTimelineRow[];
  moments: LegacyMoment[];
  bestPlayers: LegacyBestPlayer[];
  honorCurve: number[];
  goldCurve: number[];
  /** 结局叙述（禁赛 / 解散 / 圆满） */
  epilogue: string[];
  /** 禁赛档案（ending = banned） */
  ban: ClubBanRecord | null;
}

// ---------------------------------------------------------------------------
// 参照表
// ---------------------------------------------------------------------------

const RAW_CLUBS = ((legacyClubsJson as unknown as { clubs?: LegacyClubRef[] }).clubs ?? []);

function cleanClub(c: LegacyClubRef): LegacyClubRef | null {
  if (!c || typeof c.id !== 'string' || typeof c.name !== 'string') return null;
  const nums = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is number => Number.isFinite(x)) : []);
  return {
    id: c.id,
    name: c.name,
    region: typeof c.region === 'string' ? c.region : '',
    teamIds: Array.isArray(c.teamIds) ? c.teamIds.filter((x) => typeof x === 'string') : [],
    firstTi: Number.isFinite(c.firstTi) ? c.firstTi : 0,
    lastTi: Number.isFinite(c.lastTi) ? c.lastTi : 0,
    tiTitles: nums(c.tiTitles),
    tiRunnerUp: nums(c.tiRunnerUp),
    tiTop4: nums(c.tiTop4),
    tiTop8: nums(c.tiTop8),
    tiAppearances: Number.isFinite(c.tiAppearances) ? c.tiAppearances : 0,
    majors: Number.isFinite(c.majors) ? c.majors : 0,
    majorList: Array.isArray(c.majorList) ? c.majorList.filter((x) => typeof x === 'string') : [],
    highlight: typeof c.highlight === 'string' ? c.highlight : '',
  };
}

const CLUBS: LegacyClubRef[] = RAW_CLUBS.map(cleanClub).filter((c): c is LegacyClubRef => !!c);

/** 历史俱乐部参照表（只读） */
export function legacyClubs(): readonly LegacyClubRef[] {
  return CLUBS;
}

/** 连续两届夺冠的段数（TI 序号升序；TI9 → TI10 相邻） */
export function backToBackCount(titles: readonly number[]): number {
  const s = [...new Set(titles)].sort((a, b) => a - b);
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i] === s[i - 1] + 1) n++;
  return n;
}

/** 历史俱乐部 → 计分统计（实力以当届 TI 名次近似） */
export function clubStats(c: LegacyClubRef): LegacyStats {
  const strength: LegacyStats['strength'] = [];
  for (const ti of c.tiTitles) strength.push({ ti, rank: 1, teams: 0 });
  for (const ti of c.tiRunnerUp) strength.push({ ti, rank: 2, teams: 0 });
  for (const ti of c.tiTop4) strength.push({ ti, rank: 3, teams: 0 });
  for (const ti of c.tiTop8) strength.push({ ti, rank: 6, teams: 0 });
  const placed = c.tiTitles.length + c.tiRunnerUp.length + c.tiTop4.length + c.tiTop8.length;
  for (let i = 0; i < Math.max(0, c.tiAppearances - placed); i++) strength.push({ ti: 0, rank: 12, teams: 0 });
  return {
    tiTitles: c.tiTitles.slice(),
    tiRunnerUp: c.tiRunnerUp.slice(),
    tiTop4: c.tiTop4.slice(),
    tiTop8: c.tiTop8.slice(),
    tiAppearances: c.tiAppearances,
    backToBack: backToBackCount(c.tiTitles),
    majors: c.majors,
    premiers: 0,
    minors: 0,
    seasons: Math.max(1, c.lastTi - c.firstTi + 1),
    strength,
    topSeasons: c.tiTitles.length + c.tiRunnerUp.length + c.tiTop4.length,
    honorPeak: null,
  };
}

// ---------------------------------------------------------------------------
// 计分 / 称号
// ---------------------------------------------------------------------------

const L = () => CONFIG.legacy;

/** 排名 → 实力分档（teams > 0 时先按联盟规模归一到 strengthLeagueRef） */
export function strengthPoints(rank: number, teams: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  let r = rank;
  const ref = Math.max(2, L().strengthLeagueRef);
  if (Number.isFinite(teams) && teams >= 2) r = 1 + ((rank - 1) / (teams - 1)) * (ref - 1);
  for (const [limit, pts] of L().strengthBands) if (r <= limit + 1e-9) return pts;
  return 0;
}

/** 第 k 座 TI 冠军（1 起）的分值：逐冠递增（多冠王朝） */
function tiTitlePoints(count: number): number {
  const base = L().tiTitle;
  const step = L().tiTitleDynastyStep;
  let total = 0;
  for (let k = 1; k <= count; k++) total += base * (1 + step * (k - 1));
  return total;
}

export function legacyScore(stats: LegacyStats, opts: { history?: boolean; banned?: boolean } = {}): LegacyScore {
  const c = L();
  const parts: { label: string; value: number }[] = [];
  const add = (label: string, value: number) => {
    if (value) parts.push({ label, value: Math.round(value * 10) / 10 });
    return value;
  };
  let a = 0;
  a += add(`TI 冠军 × ${stats.tiTitles.length}`, tiTitlePoints(stats.tiTitles.length));
  a += add(`卫冕 × ${stats.backToBack}`, stats.backToBack * c.tiBackToBack);
  a += add(`TI 亚军 × ${stats.tiRunnerUp.length}`, stats.tiRunnerUp.length * c.tiRunnerUp);
  a += add(`TI 前四 × ${stats.tiTop4.length}`, stats.tiTop4.length * c.tiTop4);
  a += add(`TI 前八 × ${stats.tiTop8.length}`, stats.tiTop8.length * c.tiTop8);
  a += add(`TI 参赛 × ${stats.tiAppearances}`, stats.tiAppearances * c.tiAppearance);
  a += add(`Major 冠军 × ${stats.majors}`, Math.min(c.majorCap, stats.majors * c.majorTitle));
  a += add(`顶级赛事冠军 × ${stats.premiers}`, Math.min(c.premierCap, stats.premiers * c.premierTitle));
  let sRaw = 0;
  for (const s of stats.strength) sRaw += strengthPoints(s.rank, s.teams);
  const sCap = c.strengthCapBase + c.strengthCapShare * a;
  const s = Math.min(sRaw, sCap);
  add('赛季实力', s);
  let pr = 0;
  if (opts.history) pr = Math.min(c.prestigeCap, Math.max(0, (a + s) / Math.max(1, c.prestigeHistDiv)));
  else if (stats.honorPeak !== null && Number.isFinite(stats.honorPeak)) {
    pr = Math.min(c.prestigeCap, Math.max(0, (stats.honorPeak - c.prestigeHonorRef) / Math.max(1, c.prestigeHonorPer)));
  }
  add('声望', pr);
  const mult = opts.banned ? c.bannedScoreMult : 1;
  const total = Math.round((a + s + pr) * mult * 10) / 10;
  const cut = Math.round((total - (a + s + pr)) * 10) / 10;
  if (mult !== 1 && cut !== 0) parts.push({ label: `假赛禁赛 × ${mult}`, value: cut });
  return {
    total,
    achievements: Math.round(a * 10) / 10,
    strength: Math.round(s * 10) / 10,
    strengthRaw: Math.round(sRaw * 10) / 10,
    prestige: Math.round(pr * 10) / 10,
    mult,
    parts,
  };
}

/** 成就 → 称号（与历史俱乐部同一判定） */
export function legacyTitleOf(stats: LegacyStats): LegacyTitle {
  const c = L();
  const t = stats.tiTitles.length;
  const ru = stats.tiRunnerUp.length;
  if (t >= 4) return { id: 'immortal', name: '不朽神话', desc: `${t} 夺不朽盾——现实中还没有任何俱乐部做到。` };
  if (t === 3) return { id: 'triple', name: '三冠王朝', desc: '三度捧起不朽盾，跻身刀塔历史最顶端。' };
  if (t === 2 && stats.backToBack >= 1) return { id: 'double_streak', name: '两连冠王朝', desc: '连续两届登顶 TI，卫冕的难度只有极少数人懂。' };
  if (t === 2) return { id: 'double', name: '双冠豪门', desc: '两度捧起不朽盾，跨越不同时代的强队。' };
  if (t === 1) return { id: 'single', name: '单冠王者', desc: '捧起过不朽盾，名字永远刻在奖杯上。' };
  if (ru >= 2) return { id: 'runner_king', name: '亚军之王', desc: `${ru} 次闯入 TI 总决赛，却总差最后一步。` };
  if (stats.tiTop4.length >= c.evergreenTop4 || stats.tiTop8.length + stats.tiTop4.length >= c.evergreenTop8
    || stats.majors >= c.evergreenMajors || stats.topSeasons >= c.evergreenTopSeasons) {
    return { id: 'evergreen', name: '常青豪门', desc: '常年位列顶级强队，是每届 TI 的热门之一。' };
  }
  if (ru === 1) return { id: 'uncrowned', name: '无冕之王', desc: '打进过 TI 总决赛，距离不朽盾只差一步。' };
  if (stats.majors >= 1 || stats.premiers >= c.contenderPremiers || stats.tiTop4.length + stats.tiTop8.length >= 1
    || stats.topSeasons >= 1) {
    return { id: 'contender', name: '一时劲旅', desc: '有过高光时刻，曾让强队不敢轻视。' };
  }
  return { id: 'unknown', name: '默默无闻', desc: '这段生涯没有留下太多印记，但每一次训练都算数。' };
}

/** 传奇值 → 评级 */
export function legacyGrade(score: number): string {
  for (const [min, g] of L().gradeBands) if (score >= min) return g;
  return 'D';
}

/** 两份成就统计的距离（越小越接近） */
function statDistance(a: LegacyStats, b: LegacyStats): number {
  const w = L().matchWeights;
  return w.titles * Math.abs(a.tiTitles.length - b.tiTitles.length)
    + w.backToBack * Math.abs(a.backToBack - b.backToBack)
    + w.runnerUp * Math.abs(a.tiRunnerUp.length - b.tiRunnerUp.length)
    + w.top4 * Math.abs(a.tiTop4.length - b.tiTop4.length)
    + w.top8 * Math.abs(a.tiTop8.length - b.tiTop8.length)
    + w.majors * Math.abs(a.majors - b.majors)
    + w.appearances * Math.abs(a.tiAppearances - b.tiAppearances);
}

const tiList = (list: readonly number[]) => list.map((t) => `TI${t}`).join('/');

/** 历史俱乐部一句话（如「Team Spirit（TI10/TI12/TI15）」） */
export function clubLine(c: LegacyClubRef): string {
  if (c.tiTitles.length) return `${c.name}（${tiList(c.tiTitles)} 冠军）`;
  if (c.tiRunnerUp.length) return `${c.name}（${tiList(c.tiRunnerUp)} 亚军${c.majors ? `，${c.majors} 个 Major` : ''}）`;
  return `${c.name}（${c.highlight}）`;
}

/**
 * 最接近的历史俱乐部：优先同称号，其次全表；按成就距离、再按传奇值差。
 * excludeId：不参与比较的参照俱乐部（DotaPedia：真实俱乐部本身不作为自己的「最接近」）。
 */
export function matchHistoricalClub(
  stats: LegacyStats, score: number, excludeId?: string | null,
): { club: LegacyClubRef; score: number; title: LegacyTitle } | null {
  const clubs = excludeId ? CLUBS.filter((c) => c.id !== excludeId) : CLUBS;
  if (!clubs.length) return null;
  const title = legacyTitleOf(stats);
  const all = clubs.map((club) => {
    const st = clubStats(club);
    return { club, st, title: legacyTitleOf(st), score: legacyScore(st, { history: true }).total };
  });
  const same = all.filter((x) => x.title.id === title.id);
  const pool = same.length ? same : all;
  let best = pool[0];
  let bestD = Infinity;
  for (const x of pool) {
    const d = statDistance(stats, x.st) + Math.abs(score - x.score) / 100;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && x.club.id < best.club.id)) {
      best = x;
      bestD = d;
    }
  }
  return { club: best.club, score: best.score, title: best.title };
}

// ---------------------------------------------------------------------------
// 记录（引擎调用）
// ---------------------------------------------------------------------------

function logOf(state: GameState, teamId: string): LegacySeasonRecord[] {
  if (!state.legacyLog || typeof state.legacyLog !== 'object') state.legacyLog = {};
  const list = state.legacyLog[teamId];
  if (Array.isArray(list)) {
    // 手工编辑 / 截断的存档：丢弃无效记录
    if (list.some((r) => !r || typeof r !== 'object' || !Number.isFinite(r.ti))) {
      state.legacyLog[teamId] = list.filter((r) => !!r && typeof r === 'object' && Number.isFinite(r.ti));
    }
    return state.legacyLog[teamId];
  }
  state.legacyLog[teamId] = [];
  return state.legacyLog[teamId];
}

/** 本赛季冠军（不含预选赛级别；history.tournaments + 本赛季已结束赛事） */
function seasonTitlesOf(state: GameState, ti: number, teamId: string): { name: string; tier: TournamentTier }[] {
  const out = new Map<string, { name: string; tier: TournamentTier }>();
  for (const h of state.history?.tournaments ?? []) {
    if (h.season === ti && h.championId === teamId && h.tier !== 'qualifier') out.set(h.tournamentId, { name: h.name, tier: h.tier });
  }
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (!t || t.tier === 'qualifier' || t.status !== 'finished' || t.season !== ti || out.has(t.id)) continue;
    if (t.placements.some((p) => p.teamId === teamId && p.rankFrom === 1 && p.rankTo === 1)) out.set(t.id, { name: t.name, tier: t.tier });
  }
  const order: Record<string, number> = { ti: 0, major: 1, premier: 2, minor: 3, qualifier: 4 };
  return [...out.values()].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9));
}

/** 本赛季 TI 实例（含已结束 / 进行中） */
function tiTournamentOf(state: GameState, ti: number): Tournament | null {
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (t && t.tier === 'ti' && t.season === ti) return t;
  }
  for (const t of Object.values(state.tournaments ?? {})) if (t && t.tier === 'ti' && t.season === ti) return t;
  return null;
}

function tiPlacementOf(state: GameState, ti: number, teamId: string): { rank: [number, number] | null; teams: number } {
  const t = tiTournamentOf(state, ti);
  const p = t?.placements?.find((x) => x.teamId === teamId);
  if (t && p) return { rank: [p.rankFrom, p.rankTo], teams: Math.max(t.placements.length, t.teamIds.length) };
  for (const h of state.history?.tournaments ?? []) {
    if (h.season !== ti || h.tier !== 'ti') continue;
    const pl = h.placements?.[teamId];
    if (pl) return { rank: [pl[0], pl[1]], teams: pl[2] };
    return { rank: null, teams: Object.keys(h.placements ?? {}).length };
  }
  return { rank: null, teams: t ? Math.max(t.placements.length, t.teamIds.length) : 0 };
}

/** 赛季关键时刻（在该战队所属座位上下文中调用：读取座位私有的赛事结算与账目） */
function seasonMoments(
  state: GameState, teamId: string, ti: number, tiRank: [number, number] | null,
  titles: { name: string; tier: TournamentTier }[], strengthRank: number,
): string[] {
  const c = L();
  const out: { p: number; text: string }[] = [];
  if (tiRank && tiRank[0] === 1 && tiRank[1] === 1) out.push({ p: 100, text: `TI${ti} 夺冠，捧起不朽盾` });
  else if (tiRank && tiRank[0] === 2) out.push({ p: 80, text: `TI${ti} 亚军，与不朽盾一步之遥` });
  else if (tiRank && tiRank[0] <= 4) out.push({ p: 45, text: `TI${ti} 打进前四（${formatRank(tiRank[0], tiRank[1])}）` });
  for (const t of titles) {
    if (t.tier === 'ti' || !c.momentTiers.includes(t.tier)) continue;
    out.push({ p: t.tier === 'major' ? 70 : 50, text: `夺得 ${t.name}` });
  }
  // 爆冷 / 热门翻车（座位私有的赛事结算）
  const me = state.settings?.playerTeamId;
  if (me === teamId) {
    for (const s of state.history?.playerSettlements ?? []) {
      const t = state.tournaments[s.tournamentId];
      const h = t ? undefined : state.history.tournaments.find((x) => x.tournamentId === s.tournamentId);
      const season = t?.season ?? h?.season;
      const tier = t?.tier ?? h?.tier;
      // 只记 TI / Major / 顶级赛事的爆冷（线上公开赛、Minor 不算关键战役）
      if (season !== ti || !tier || !c.momentTiers.includes(tier)) continue;
      const name = t?.name ?? h?.name ?? s.tournamentId;
      const exp = Math.round(s.honor?.expected ?? 0);
      if (!(exp > 0)) continue;
      if (exp - s.rankFrom >= c.upsetRankGap && s.rankFrom <= 3) {
        out.push({ p: s.rankFrom === 1 ? 75 : 55, text: `${name}：赛前预期第 ${exp} 名，最终${s.rankFrom === 1 ? '夺冠' : `获得${formatRank(s.rankFrom, s.rankTo)}`}——爆冷之旅` });
      } else if (exp <= 2 && s.rankFrom >= 9) {
        out.push({ p: 35, text: `${name}：赛前头号热门（预期第 ${exp} 名），却止步${formatRank(s.rankFrom, s.rankTo)}` });
      }
    }
    // 大额转会（座位私有账目）
    const wage = Math.max(1, wageBill(state, teamId));
    const big = (state.finance ?? [])
      .filter((f: FinanceEntry) => f.season === ti && (f.category === 'transfer_in' || f.category === 'transfer_out' || f.category === 'signing')
        && Math.abs(f.amount) >= wage * c.bigTransferWageRounds)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 2);
    for (const f of big) {
      out.push({ p: 40, text: f.amount < 0 ? `${f.note}（${formatGold(-f.amount)}）` : `${f.note}，进账 ${formatGold(f.amount)}` });
    }
  }
  if (strengthRank === 1) out.push({ p: 42, text: '赛季末实力榜第一' });
  out.sort((a, b) => b.p - a.p);
  return out.slice(0, Math.max(1, c.momentsPerSeasonMax)).map((x) => x.text);
}

/** 每回合工资总额（选手 + 教练；只用于「大额转会」阈值） */
function wageBill(state: GameState, teamId: string): number {
  const team = state.teams[teamId];
  if (!team) return 0;
  let sum = 0;
  for (const id of team.playerIds) {
    const p = state.players[id];
    if (p && Number.isFinite(p.salary)) sum += Math.max(0, p.salary);
  }
  const coach = team.coachId ? state.coaches[team.coachId] : undefined;
  if (coach && Number.isFinite(coach.salary)) sum += Math.max(0, coach.salary);
  return sum;
}

/** 构建某战队当前赛季（opts.ti：指定更早的赛季，赛事成绩取自赛事史）的档案（不写入） */
export function buildSeasonRecord(
  state: GameState, teamId: string, opts: { partial?: boolean; ending?: GameOverReason; ti?: number } = {},
): LegacySeasonRecord {
  const team = state.teams[teamId];
  const cur = state.season?.ti ?? 0;
  const ti = typeof opts.ti === 'number' && Number.isFinite(opts.ti) ? opts.ti : cur;
  const order = safeRank(state, teamId);
  const rankIdx = order.indexOf(teamId);
  const { rank: tiRank, teams: tiTeams } = tiPlacementOf(state, ti, teamId);
  const titles = seasonTitlesOf(state, ti, teamId);
  const strengthRank = rankIdx >= 0 ? rankIdx + 1 : order.length + 1;
  const squad = (team?.playerIds ?? [])
    .map((id) => state.players[id])
    .filter((p): p is Player => !!p && !p.tempSubUntilTournament && !p.isWildSub)
    .map((p) => ({ id: p.id, handle: p.handle, position: p.position, rating: Math.round(overallRating(p) * 10) / 10, tier: playerTier(p) }))
    .sort((a, b) => b.rating - a.rating);
  return {
    ti,
    year: ti === cur ? state.season?.year ?? tiYear(ti) : tiYear(ti),
    strengthRank,
    strengthTeams: Math.max(order.length, rankIdx >= 0 ? order.length : order.length + 1),
    // 赛季综合排名在赛季结算时才更新：部分赛季（出局 / 禁赛 / 赛季中结束）不沿用上赛季的名次
    finalRank: opts.partial ? 0 : team?.lastSeasonRank ?? 0,
    tiRank,
    tiTeams,
    titles,
    honorEnd: Math.round(team?.honor ?? 0),
    goldEnd: Math.round(team?.gold ?? 0),
    moments: seasonMoments(state, teamId, ti, tiRank, titles, rankIdx >= 0 ? rankIdx + 1 : 0),
    squad,
    ...(opts.partial ? { partial: true } : {}),
    ...(opts.ending ? { ending: opts.ending } : {}),
  };
}

function safeRank(state: GameState, teamId: string): string[] {
  try {
    const team = state.teams[teamId];
    const ids = Object.values(state.teams).filter((t) => !t.disbanded || t.id === teamId)
      .filter((t) => t.id === teamId ? (team?.playerIds?.length ?? 0) > 0 : t.playerIds.length > 0)
      .map((t) => t.id);
    return rankTeamsByRating(state, ids);
  } catch {
    return [];
  }
}

/**
 * 赛季结算时记录（season.settleSeason 在每个座位上下文中调用；TI 已结束、退役之前）：
 * 同一赛季重复调用会覆盖（幂等）。
 */
export function recordLegacySeason(state: GameState, teamId: string): void {
  if (!teamId || !state.teams[teamId]) return;
  const log = logOf(state, teamId);
  const rec = buildSeasonRecord(state, teamId);
  const i = log.findIndex((r) => r.ti === rec.ti);
  if (i >= 0) log[i] = rec;
  else log.push(rec);
  log.sort((a, b) => a.ti - b.ti);
}

/**
 * 赛季结算时为全部人类战队记录（season.settleSeason 调用；在各自座位上下文中执行）。
 * 除仍在比赛的座位外，也包括本次推进中刚出局、尚未由 multi.processEliminations 收尾的座位
 * （例如 TI 回合结束时荣誉跌破 0：这个赛季连同 TI 成绩已经打完，应计入生涯）；已冻结 / 已收尾 / 被禁赛的跳过。
 */
export function recordLegacySeasonAll(state: GameState): void {
  for (const id of humanTeamIds(state)) {
    const team = state.teams[id];
    if (!team || team.banned) continue;
    const log = state.legacyLog?.[id];
    if (Array.isArray(log) && log.some((r) => r?.ending)) continue;
    if (team.disbanded && !(team.playerIds?.length > 0)) continue; // 出局已收尾（选手已离队）
    try {
      inSeatOf(state, id, () => recordLegacySeason(state, id));
    } catch (e) {
      console.error('[engine] recordLegacySeason', e);
    }
  }
}

/**
 * 出局 / 禁赛时冻结截至当时的赛季档案（banClub、multi.processEliminations 调用；须在选手离队之前）。
 * 已冻结（任一记录带 ending）时不再重复；该赛季已有完整记录时只标记 ending。
 * atTi：出局发生的赛季（默认当前赛季）。多人模式的出局收尾在整次推进之后执行，TI 回合结束时出局的座位
 * 收尾时已进入下一赛季 —— 此时应标记出局赛季的记录，而不是为一个从未参加的赛季补记。
 */
export function recordLegacyPartial(state: GameState, teamId: string, ending: GameOverReason, atTi?: number): void {
  if (!teamId || !state.teams[teamId]) return;
  const log = logOf(state, teamId);
  if (log.some((r) => r?.ending)) return;
  const cur = state.season?.ti ?? 0;
  const ti = typeof atTi === 'number' && Number.isFinite(atTi) && atTi <= cur ? atTi : cur;
  const existing = log.find((r) => r?.ti === ti);
  if (existing) {
    existing.ending = ending;
    return;
  }
  log.push(buildSeasonRecord(state, teamId, { partial: true, ending, ti }));
  log.sort((a, b) => a.ti - b.ti);
}

// ---------------------------------------------------------------------------
// 报告（UI 调用；纯计算）
// ---------------------------------------------------------------------------

/** 某人类战队的结局 */
export function legacyEndingOf(state: GameState, teamId: string): GameOverReason {
  const team = state.teams[teamId];
  if (team?.banned) return 'banned';
  if (team?.bankrupt) return 'bankrupt'; // 第十波 #1（bankruptcy.ts）
  const log = state.legacyLog?.[teamId];
  const frozen = Array.isArray(log) ? log.find((r) => r?.ending)?.ending : undefined;
  if (frozen) return frozen;
  if (isMultiplayer(state)) {
    if (seatOf(state, teamId)?.eliminated || team?.disbanded) return 'disbanded';
    return state.gameOver?.reason === 'banned' ? 'completed' : (state.gameOver?.reason ?? 'completed');
  }
  if (state.gameOver?.reason) return state.gameOver.reason;
  return team?.disbanded ? 'disbanded' : 'completed';
}

/** 生涯档案（含尚未结算的当前赛季：未冻结且仍在执教时按当前状态补一条部分赛季） */
export function legacyRecordsOf(state: GameState, teamId: string): LegacySeasonRecord[] {
  const raw = state.legacyLog?.[teamId];
  let recs = (Array.isArray(raw) ? raw : []).map(cleanRecord).filter((r): r is LegacySeasonRecord => !!r)
    .sort((a, b) => a.ti - b.ti);
  const me = state.settings?.playerTeamId;
  if (teamId === me) {
    // 旧存档（第八波之前开始的生涯）：档案之前的赛季由玩家的赛季总结近似补齐
    const firstTi = recs.length ? recs[0].ti : Infinity;
    const older = fromSeasonSummaries(state, teamId).filter((r) => r.ti < firstTi);
    if (older.length) recs = [...older, ...recs];
  }
  const frozen = recs.some((r) => r.ending);
  const ti = state.season?.ti ?? 0;
  const lastTi = recs.length ? recs[recs.length - 1].ti : -Infinity;
  const eliminated = isMultiplayer(state) && !!seatOf(state, teamId)?.eliminated;
  const startTi = state.settings?.startTi ?? ti;
  if (!frozen && !eliminated && lastTi < ti && ti >= startTi && state.teams[teamId] && !state.teams[teamId].banned) {
    // 当季尚未结算：有任何比赛成绩或游戏已在本季结束时补记（单机赛季中解散：标记结局）
    const over = !isMultiplayer(state) && state.gameOver && state.gameOver.reason !== 'completed' ? state.gameOver.reason : undefined;
    const live = buildSeasonRecord(state, teamId, { partial: true, ...(over ? { ending: over } : {}) });
    if (state.gameOver || live.titles.length || live.tiRank || state.roundIndex > 0) recs.push(live);
  }
  return recs;
}

/** 存档中的档案记录（手工编辑 / 截断的存档）：缺失的集合字段补空，无效记录丢弃 */
function cleanRecord(r: unknown): LegacySeasonRecord | null {
  if (!r || typeof r !== 'object') return null;
  const x = r as LegacySeasonRecord;
  if (typeof x.ti !== 'number' || !Number.isFinite(x.ti)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    ...x,
    year: num(x.year) || tiYear(x.ti),
    strengthRank: num(x.strengthRank),
    strengthTeams: num(x.strengthTeams),
    finalRank: num(x.finalRank),
    tiRank: Array.isArray(x.tiRank) && x.tiRank.length >= 2 ? x.tiRank : null,
    tiTeams: num(x.tiTeams),
    titles: Array.isArray(x.titles) ? x.titles.filter((t) => !!t && typeof t.name === 'string') : [],
    honorEnd: num(x.honorEnd),
    goldEnd: num(x.goldEnd),
    moments: Array.isArray(x.moments) ? x.moments.filter((m) => typeof m === 'string') : [],
    squad: Array.isArray(x.squad) ? x.squad.filter((s) => !!s && typeof s.id === 'string') : [],
  };
}

/** 旧存档（无 legacyLog）：由玩家的赛季总结近似（战力排名以赛季综合排名代替） */
function fromSeasonSummaries(state: GameState, teamId: string): LegacySeasonRecord[] {
  const teams = Object.values(state.teams).filter((t) => !t.disbanded).length;
  return (state.history?.seasons ?? []).filter((s) => !!s && Number.isFinite(s.ti)).map((s) => ({
    ti: s.ti,
    year: s.year,
    strengthRank: s.finalRank || teams,
    strengthTeams: teams,
    finalRank: s.finalRank,
    tiRank: s.playerTiRank ?? null,
    tiTeams: 0,
    titles: (s.playerTitles ?? []).map((name) => ({
      name,
      tier: (state.history.tournaments.find((h) => h.season === s.ti && h.name === name)?.tier ?? 'premier') as TournamentTier,
    })),
    honorEnd: s.honorEnd,
    goldEnd: s.goldEnd,
    moments: [],
    squad: [],
  })).filter((r) => r.ti >= (state.settings?.startTi ?? 0) && !!teamId);
}

/** 由档案 + 全局赛事史得出计分统计 */
export function teamLegacyStats(state: GameState, teamId: string, recs: LegacySeasonRecord[] = legacyRecordsOf(state, teamId)): LegacyStats {
  const seasons = new Set(recs.map((r) => r.ti));
  const tiTitles: number[] = [];
  const tiRunnerUp: number[] = [];
  const tiTop4: number[] = [];
  const tiTop8: number[] = [];
  let apps = 0;
  const tiSeen = new Set<number>();
  let majors = 0;
  let premiers = 0;
  let minors = 0;
  const countedTitles = new Set<string>();
  for (const h of state.history?.tournaments ?? []) {
    if (!seasons.has(h.season)) continue;
    if (h.tier === 'ti') {
      const pl = h.placements?.[teamId];
      if (!pl || tiSeen.has(h.season)) continue;
      tiSeen.add(h.season);
      apps++;
      if (pl[0] === 1 && pl[1] === 1) tiTitles.push(h.season);
      else if (pl[0] === 2) tiRunnerUp.push(h.season);
      else if (pl[0] <= 4) tiTop4.push(h.season);
      else if (pl[0] <= 8) tiTop8.push(h.season);
      continue;
    }
    if (h.championId !== teamId || h.tier === 'qualifier') continue;
    countedTitles.add(h.tournamentId);
    if (h.tier === 'major') majors++;
    else if (h.tier === 'premier') premiers++;
    else minors++;
  }
  // 档案中有但赛事史缺失的（防御：赛事史被裁剪的旧存档）
  for (const r of recs) {
    if (r.tiRank && !tiSeen.has(r.ti)) {
      tiSeen.add(r.ti);
      apps++;
      if (r.tiRank[0] === 1 && r.tiRank[1] === 1) tiTitles.push(r.ti);
      else if (r.tiRank[0] === 2) tiRunnerUp.push(r.ti);
      else if (r.tiRank[0] <= 4) tiTop4.push(r.ti);
      else if (r.tiRank[0] <= 8) tiTop8.push(r.ti);
    }
  }
  const strength = recs.map((r) => ({ ti: r.ti, rank: r.strengthRank, teams: r.strengthTeams }));
  let honorPeak: number | null = null;
  for (const r of recs) if (Number.isFinite(r.honorEnd)) honorPeak = Math.max(honorPeak ?? -Infinity, r.honorEnd);
  const team = state.teams[teamId];
  if (team && !team.disbanded && Number.isFinite(team.honor)) honorPeak = Math.max(honorPeak ?? -Infinity, team.honor);
  if (teamId === state.settings?.playerTeamId) {
    for (const h of state.history?.honor ?? []) if (Number.isFinite(h.value)) honorPeak = Math.max(honorPeak ?? -Infinity, h.value);
  }
  tiTitles.sort((a, b) => a - b);
  return {
    tiTitles,
    tiRunnerUp: tiRunnerUp.sort((a, b) => a - b),
    tiTop4: tiTop4.sort((a, b) => a - b),
    tiTop8: tiTop8.sort((a, b) => a - b),
    tiAppearances: apps,
    backToBack: backToBackCount(tiTitles),
    majors,
    premiers,
    minors,
    seasons: recs.length,
    strength,
    topSeasons: recs.filter((r) => r.strengthRank >= 1 && r.strengthRank <= 3).length,
    honorPeak: honorPeak === null || !Number.isFinite(honorPeak) ? null : Math.round(honorPeak),
  };
}

function tiLabel(r: LegacySeasonRecord): string {
  if (!r.tiRank) return r.partial ? '赛季未完成' : '未参加 TI';
  const [a, b] = r.tiRank;
  if (a === 1 && b === 1) return '冠军';
  if (a === 2) return '亚军';
  return formatRank(a, b);
}

function bestPlayersOf(state: GameState, recs: LegacySeasonRecord[]): LegacyBestPlayer[] {
  const agg = new Map<string, LegacyBestPlayer & { score: number }>();
  for (const r of recs) {
    const titleCount = r.titles.length;
    const tiWin = r.tiRank && r.tiRank[0] === 1 && r.tiRank[1] === 1 ? 1 : 0;
    for (const s of r.squad ?? []) {
      let a = agg.get(s.id);
      if (!a) {
        const p = state.players[s.id];
        a = {
          id: s.id, handle: p?.handle ?? s.handle, position: s.position, seasons: 0, peakRating: 0, tier: s.tier,
          titles: 0, tiTitles: 0, status: p?.status ?? 'unknown', score: 0,
        };
        agg.set(s.id, a);
      }
      a.seasons += 1;
      if (s.rating > a.peakRating) {
        a.peakRating = s.rating;
        a.tier = s.tier;
      }
      a.titles += titleCount;
      a.tiTitles += tiWin;
    }
  }
  const list = [...agg.values()];
  for (const a of list) a.score = a.peakRating / 10 + a.seasons * 2 + a.titles * 3 + a.tiTitles * 10;
  list.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return list.slice(0, Math.max(1, L().bestPlayers)).map(({ score: _s, ...rest }) => rest);
}

function epilogueOf(
  state: GameState, teamId: string, ending: GameOverReason, stats: LegacyStats, title: LegacyTitle,
  recs: LegacySeasonRecord[], ban: ClubBanRecord | null, mult: number, rank: number, boardSize: number,
): string[] {
  const team = state.teams[teamId];
  const name = team?.name ?? teamId;
  const trophies = stats.tiTitles.length + stats.majors + stats.premiers + stats.minors;
  const lastTi = recs.length ? recs[recs.length - 1].ti : state.season?.ti ?? 0;
  if (ending === 'banned' && ban) {
    return [
      `TI${ban.season} 赛季第 ${ban.round} 回合（${ban.date}），调查结果公之于众：${name} 在多场比赛中操纵比赛结果。`,
      `俱乐部被永久除名${ban.players.length ? `，${ban.players.join('、')} 终身禁赛` : ''}。`,
      trophies
        ? `${recs.length} 个赛季里赢下的 ${trophies} 座冠军奖杯${stats.tiTitles.length ? `（含 ${stats.tiTitles.length} 座不朽盾）` : ''}，从此蒙上无法洗去的污点。`
        : `${recs.length} 个赛季的努力就此付诸东流。`,
      `传奇值按 ${Math.round(mult * 100)}% 折算。`,
    ];
  }
  if (ending === 'bankrupt') {
    // 第十波 #1（bankruptcy.ts）：资金持续为负 / 负债过高
    const b = team?.bankrupt;
    return [
      b
        ? `TI${b.season} 赛季第 ${b.round} 回合（${b.date}），${name} ${b.rule === 'debt'
          ? `负债 ${formatGold(Math.abs(b.gold))} 超过 ${CONFIG.bankruptcy.debtWageRounds} 个回合的工资`
          : `资金连续 ${b.negativeRounds} 个回合为负`}，无力偿还债务，宣告破产。`
        : `资金链断裂，${name} 在 TI${lastTi} 赛季宣告破产。`,
      trophies ? `留下的 ${trophies} 座冠军奖杯，是这支队伍存在过的证明。` : '没有奖杯，资金链断裂后俱乐部无以为继。',
    ];
  }
  if (ending === 'disbanded') {
    return [
      `荣誉跌破 0，${name} 在 TI${lastTi} 赛季宣告解散。`,
      trophies ? `留下的 ${trophies} 座冠军奖杯，是这支队伍存在过的证明。` : '没有奖杯，也没有告别赛——电竞之路从不平坦。',
    ];
  }
  const firstTi = recs.length ? recs[0].ti : state.settings?.startTi ?? lastTi;
  const lines = [
    `${seatOf(state, teamId)?.name || (teamId === state.settings?.playerTeamId ? state.settings?.managerName : '') || '经理'} 带领 ${name} 走完了 ${recs.length} 个赛季（TI${firstTi}–TI${lastTi}）。`,
  ];
  if (stats.tiTitles.length) {
    lines.push(`捧起 ${stats.tiTitles.length} 座不朽盾（${tiList(stats.tiTitles)}）${stats.majors ? `，外加 ${stats.majors} 个 Major` : ''}${stats.premiers ? `、${stats.premiers} 个顶级赛事冠军` : ''}。`);
  } else if (stats.tiAppearances) {
    const deepRuns = stats.tiRunnerUp.length + stats.tiTop4.length + stats.tiTop8.length;
    lines.push(deepRuns
      ? `${stats.tiAppearances} 次站上 TI 舞台，最好成绩${stats.tiRunnerUp.length ? '是亚军' : stats.tiTop4.length ? '打进前四' : '打进前八'}，可惜始终没能捧起不朽盾。`
      : stats.tiAppearances === 1 ? '站上过一次 TI 舞台，但没能走得更远。' : `${stats.tiAppearances} 次站上 TI 舞台，但都没能走得更远。`);
  } else {
    lines.push(trophies ? `赢下 ${trophies} 座冠军奖杯，却始终没能踏上 TI 的舞台。` : '没有奖杯，也没能踏上 TI 的舞台。');
  }
  if (rank > 0 && boardSize > 1) lines.push(`在历史排行榜中位列第 ${rank} / ${boardSize}（${title.name}）。`);
  return lines;
}

/**
 * 计算某人类战队的生涯总结（UI 在结算页调用；纯计算，不修改 state）。
 * others：同时放进历史排行榜的其他人类战队（多人模式对比）。
 */
export function computeLegacyReport(state: GameState, teamId: string, others: string[] = []): LegacyReport {
  const team = state.teams[teamId];
  const recs = legacyRecordsOf(state, teamId);
  const ending = legacyEndingOf(state, teamId);
  const stats = teamLegacyStats(state, teamId, recs);
  const banned = ending === 'banned';
  const score = legacyScore(stats, { banned });
  const title = legacyTitleOf(stats);
  const m = matchHistoricalClub(stats, score.total);
  const match = m ? { ...m, line: clubLine(m.club) } : null;

  // 排行榜：历史俱乐部 + 本俱乐部（+ 其他人类俱乐部）
  const board: LegacyBoardRow[] = CLUBS.map((club) => {
    const st = clubStats(club);
    return {
      key: `h:${club.id}`,
      name: club.name,
      score: legacyScore(st, { history: true }).total,
      title: legacyTitleOf(st),
      tiTitles: club.tiTitles,
      tiRunnerUp: club.tiRunnerUp,
      tiTop4: club.tiTop4.length,
      majors: club.majors,
      kind: 'history' as const,
      span: club.firstTi === club.lastTi ? `TI${club.firstTi}` : `TI${club.firstTi}–TI${club.lastTi}`,
      highlight: club.highlight,
    };
  });
  const spanOf = (rs: LegacySeasonRecord[]) => (rs.length
    ? (rs[0].ti === rs[rs.length - 1].ti ? `TI${rs[0].ti}` : `TI${rs[0].ti}–TI${rs[rs.length - 1].ti}`)
    : '—');
  board.push({
    key: `p:${teamId}`,
    name: team?.name ?? teamId,
    score: score.total,
    title,
    tiTitles: stats.tiTitles,
    tiRunnerUp: stats.tiRunnerUp,
    tiTop4: stats.tiTop4.length,
    majors: stats.majors,
    kind: 'self',
    teamId,
    span: spanOf(recs),
  });
  for (const id of others) {
    if (id === teamId || !state.teams[id]) continue;
    const r = legacyRecordsOf(state, id);
    const st = teamLegacyStats(state, id, r);
    board.push({
      key: `p:${id}`,
      name: state.teams[id].name,
      score: legacyScore(st, { banned: legacyEndingOf(state, id) === 'banned' }).total,
      title: legacyTitleOf(st),
      tiTitles: st.tiTitles,
      tiRunnerUp: st.tiRunnerUp,
      tiTop4: st.tiTop4.length,
      majors: st.majors,
      kind: 'human',
      teamId: id,
      span: spanOf(r),
    });
  }
  // 同分：历史俱乐部在前（需要超越而不是追平）
  const kindOrder = { history: 0, human: 1, self: 2 } as const;
  board.sort((a, b) => b.score - a.score || kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name));
  const rank = board.findIndex((r) => r.key === `p:${teamId}`) + 1;

  // 时间线
  const champOf = (ti: number): string | null => {
    const h = (state.history?.tournaments ?? []).find((x) => x.season === ti && x.tier === 'ti');
    const id = h?.championId;
    return id ? state.teams[id]?.name ?? id : null;
  };
  const timeline: LegacyTimelineRow[] = recs.map((r) => ({
    ti: r.ti,
    year: r.year,
    tiLabel: tiLabel(r),
    tiRank: r.tiRank,
    tiChampion: champOf(r.ti),
    titles: r.titles,
    finalRank: r.finalRank,
    strengthRank: r.strengthRank,
    strengthTeams: r.strengthTeams,
    honorEnd: r.honorEnd,
    goldEnd: r.goldEnd,
    partial: !!r.partial,
    ...(r.ending ? { ending: r.ending } : {}),
  }));

  const ban = (state.clubScandals?.history ?? []).filter((b) => b.teamId === teamId).slice(-1)[0] ?? null;
  const moments: LegacyMoment[] = [];
  for (const r of recs) for (const text of r.moments ?? []) moments.push({ ti: r.ti, text });
  if (ban) moments.push({ ti: ban.season, text: `全员假赛东窗事发，俱乐部被永久除名` });

  // 曲线：本座位用逐回合历史；其他俱乐部用赛季末档案
  const own = teamId === state.settings?.playerTeamId;
  const honorCurve = own && state.history?.honor?.length ? state.history.honor.map((h) => h.value) : recs.map((r) => r.honorEnd);
  const goldCurve = own && state.history?.gold?.length ? state.history.gold.map((h) => h.value) : recs.map((r) => r.goldEnd);

  const startTi = recs.length ? recs[0].ti : state.settings?.startTi ?? 0;
  const endTi = recs.length ? recs[recs.length - 1].ti : state.season?.ti ?? startTi;
  const seat = seatOf(state, teamId);
  return {
    teamId,
    teamName: team?.name ?? teamId,
    tag: team?.tag ?? '',
    color: team?.color ?? '#888888',
    managerName: seat?.name ?? (own ? state.settings?.managerName ?? '' : ''),
    ending,
    startTi,
    endTi,
    seasonsPlayed: recs.length,
    stats,
    score,
    title,
    grade: banned ? `${legacyGrade(score.total)}` : legacyGrade(score.total),
    match,
    board,
    rank,
    boardSize: board.length,
    timeline,
    moments,
    bestPlayers: bestPlayersOf(state, recs),
    honorCurve,
    goldCurve,
    epilogue: epilogueOf(state, teamId, ending, stats, title, recs, ban, score.mult, rank, board.length),
    ban,
  };
}

/** 多人模式：全部人类战队的总结（按传奇值降序；每份报告的排行榜都含全部人类俱乐部） */
export function computeAllLegacyReports(state: GameState): LegacyReport[] {
  const ids = humanTeamIds(state).filter((id) => !!state.teams[id]);
  return ids.map((id) => computeLegacyReport(state, id, ids)).sort((a, b) => b.score.total - a.score.total || a.teamId.localeCompare(b.teamId));
}

/** 简短的生涯总结文本（gameOver.summary 用） */
export function legacyCareerSummary(state: GameState, teamId: string, ending: GameOverReason = legacyEndingOf(state, teamId)): string {
  const r = computeLegacyReport(state, teamId);
  const s = r.stats;
  const lines = [
    `${r.managerName || '经理'} 执教 ${r.teamName} ${r.seasonsPlayed} 个赛季（TI${r.startTi}–TI${r.endTi}）。`,
    `TI 冠军 ${s.tiTitles.length} 次${s.tiRunnerUp.length ? `，亚军 ${s.tiRunnerUp.length} 次` : ''}；Major 冠军 ${s.majors} 个，顶级赛事冠军 ${s.premiers} 个。`,
    `传奇值 ${r.score.total}（${r.title.name}${ending === 'banned' ? '，因假赛禁赛折算' : ''}）`
      + (r.match ? `，最接近的历史俱乐部：${r.match.line}。` : '。'),
  ];
  return lines.join('\n');
}
