// 赛季赛程、报名、邀请、TI 资格【E3 负责实现】
import type {
  GameState, OpResult, PlayerEntryStatus, Region, Team, TiInfo, Tournament, TournamentFormatPreset, TournamentTemplate,
  TournamentTier,
} from './types';
import { REGIONS } from './types';
import { CONFIG, REGION_LABEL, TI_YEAR } from './config';
import { getTiInfo, getTournamentTemplates, lastTournamentDataSeason } from '../data/index';
import { regularRoundCount, roundIndexForDate } from './calendar';
import { econIndex } from './economy';
import { awardedPrizePool, prizePoolLabel, tournamentAppearanceFee } from './revenue';
import { teamRating } from './team';
import { initTournamentStages } from './tournament';
import { computeExpectedRanks } from './honor';
import { addNews } from './news';
import { releaseTempSubs } from './market';
import { rngOf } from './rng';
import { addDays, clamp, daysBetween, formatGold } from './util';
import { activeHumanIds, forEachSeat, humanTeamIds, isMultiplayer, seatTournamentField, withSeat } from './seat';

// ===========================================================================
// 常量 & 小工具
// ===========================================================================

/** 赛事等级优先级（越小越高） */
export const TIER_ORDER: Record<TournamentTier, number> = { ti: 0, major: 1, premier: 2, minor: 3, qualifier: 4 };

const FORMATS: TournamentFormatPreset[] = ['se8', 'de8', 'gsl_de8', 'groups_de', 'groups_se', 'rr', 'ti'];
const MIN_EVENT_TEAMS = 4;
const MAX_EVENT_TEAMS = 24;

function playerTeamId(state: GameState): string {
  return state.settings?.playerTeamId ?? '';
}

/** 参与报名/赛程的玩家战队：单机 = [settings.playerTeamId]；多人 = 仍在比赛中的全部座位（与当前上下文无关） */
function humansOf(state: GameState): string[] {
  return isMultiplayer(state) ? activeHumanIds(state) : [playerTeamId(state)];
}

/** 某玩家对赛事的报名状态（多人模式下读取该座位的私有字段，不切换上下文） */
function statusOf(state: GameState, teamId: string, t: Tournament): PlayerEntryStatus {
  return seatTournamentField(state, teamId, t, 'playerStatus');
}

function uniq(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function tiYearOf(ti: number): number {
  return TI_YEAR[ti] ?? (ti < 10 ? 2010 + ti : 2011 + ti);
}

/** TI 赛事实例 id */
export function tiTournamentId(ti: number): string {
  return `ti-${ti}`;
}

/** 是否为 TI 赛区预选赛 */
export function isTiQualifier(t: Tournament): boolean {
  return !!t.advanceToTi;
}

/** 是否为 TI 或 TI 预选（赛季收官，必须参加：不可手动报名/退出/婉拒） */
function isTiPhaseEvent(t: Tournament): boolean {
  return t.tier === 'ti' || isTiQualifier(t);
}

/** 报名/婉拒是否仍可修改：本赛季、尚未开赛（scheduled）且所在回合还没到（回合一开始即开赛） */
function entryEditable(state: GameState, t: Tournament): boolean {
  return t.season === state.season?.ti && t.status === 'scheduled' && t.roundIndex > state.roundIndex;
}

/** tis.json 缺失时的兜底 TI 信息 */
function safeTiInfo(state: GameState, ti: number): TiInfo {
  let info: TiInfo | null = null;
  try {
    info = getTiInfo(ti);
  } catch {
    info = null;
  }
  const fb = CONFIG.tournament.tiFallback;
  const year = tiYearOf(ti);
  const startDate = info?.startDate ?? state.season?.tiStartDate ?? `${year}-08-15`;
  const teams = clamp(Math.floor(info?.teams ?? fb.teams) || fb.teams, MIN_EVENT_TEAMS, MAX_EVENT_TEAMS);
  return {
    ti,
    year: info?.year ?? year,
    name: info?.name ?? `The International ${year}`,
    city: info?.city ?? '待定',
    country: info?.country ?? '',
    hostRegion: info?.hostRegion ?? 'EU',
    startDate,
    endDate: info?.endDate ?? addDays(startDate, 10),
    prizePool: Math.max(0, Math.round(info?.prizePool ?? fb.prizePool * econIndex(year))),
    teams,
    directInvites: clamp(Math.floor(info?.directInvites ?? fb.directInvites), 0, teams),
    qualifierSlots: info?.qualifierSlots ?? {},
    projected: info?.projected ?? !info,
  };
}

function tiQualifierRoundIdx(state: GameState): number {
  const r = (state.season?.rounds ?? []).find((x) => x.phase === 'ti_qualifier');
  return r ? r.index : regularRoundCount(state.season) + 1;
}

function tiRoundIdx(state: GameState): number {
  const r = (state.season?.rounds ?? []).find((x) => x.phase === 'ti');
  return r ? r.index : regularRoundCount(state.season) + 2;
}

/** 出场费（每队）：奖金池 × share，不低于 minAppearanceFee × econ；无奖金赛事为 0 */
/**
 * 赛程公布时写入的出场费（每支正赛队伍）：与开赛/结算时实际发放的口径一致（revenue.tournamentAppearanceFee：按赛事等级 × 年代经济指数），
 * 赛程页 / 赛事中心在开赛前显示的就是实际会发放的金额。
 */
function appearanceFeeFor(state: GameState, t: Pick<Tournament, 'prizePool' | 'tier' | 'season' | 'seriesId'>): number {
  return tournamentAppearanceFee(state, t);
}

function attachToRound(state: GameState, t: Tournament): void {
  const round = state.season.rounds?.[t.roundIndex];
  if (round && !round.tournamentIds.includes(t.id)) round.tournamentIds.push(t.id);
}

function registerInstance(state: GameState, t: Tournament): void {
  state.tournaments[t.id] = t;
  if (!state.seasonTournamentIds.includes(t.id)) state.seasonTournamentIds.push(t.id);
  attachToRound(state, t);
}

/** 战队是否可参赛（未解散且有选手） */
function canCompete(team: Team | undefined): team is Team {
  return !!team && !team.disbanded && team.playerIds.length > 0;
}

// ===========================================================================
// 未来赛季模板
// ===========================================================================

interface GenericEvent {
  slug: string;
  name: string;
  tier: Exclude<TournamentTier, 'ti'>;
  /** 相对 TI 年份：-1 = 上一年（秋冬），0 = TI 当年 */
  yearOffset: -1 | 0;
  monthDay: string;
  days: number;
  city: string;
  hostRegion: Region;
  online?: boolean;
  /** 基础奖金（econIndex = 1 时） */
  prize: number;
  teams: number;
  invites: number;
  regionLocked?: Region;
  format: TournamentFormatPreset;
}

/** 无任何赛季数据时使用的通用赛历（跨等级/赛区的 12 项赛事） */
const GENERIC_EVENTS: GenericEvent[] = [
  { slug: 'cn-autumn-league', name: '中国秋季联赛', tier: 'minor', yearOffset: -1, monthDay: '10-06', days: 14, city: '上海', hostRegion: 'CN', online: true, prize: 200000, teams: 8, invites: 4, regionLocked: 'CN', format: 'rr' },
  { slug: 'eu-autumn-league', name: '欧洲秋季联赛', tier: 'minor', yearOffset: -1, monthDay: '10-13', days: 14, city: '柏林', hostRegion: 'EU', online: true, prize: 200000, teams: 8, invites: 4, regionLocked: 'EU', format: 'rr' },
  { slug: 'autumn-minor', name: '秋季 Minor', tier: 'minor', yearOffset: -1, monthDay: '11-03', days: 6, city: '吉隆坡', hostRegion: 'SEA', prize: 300000, teams: 8, invites: 4, format: 'de8' },
  { slug: 'winter-major', name: '冬季 Major', tier: 'major', yearOffset: -1, monthDay: '12-01', days: 10, city: '汉堡', hostRegion: 'EU', prize: 1000000, teams: 16, invites: 10, format: 'groups_de' },
  { slug: 'cis-cup', name: '独联体杯', tier: 'minor', yearOffset: 0, monthDay: '01-12', days: 5, city: '莫斯科', hostRegion: 'CIS', prize: 250000, teams: 8, invites: 4, regionLocked: 'CIS', format: 'se8' },
  { slug: 'americas-invitational', name: '美洲邀请赛', tier: 'premier', yearOffset: 0, monthDay: '01-26', days: 7, city: '洛杉矶', hostRegion: 'NA', prize: 500000, teams: 8, invites: 6, format: 'de8' },
  { slug: 'spring-masters', name: '春季大师赛', tier: 'premier', yearOffset: 0, monthDay: '02-18', days: 8, city: '成都', hostRegion: 'CN', prize: 600000, teams: 12, invites: 8, format: 'groups_se' },
  { slug: 'spring-major', name: '春季 Major', tier: 'major', yearOffset: 0, monthDay: '03-16', days: 11, city: '西雅图', hostRegion: 'NA', prize: 1000000, teams: 18, invites: 12, format: 'groups_de' },
  { slug: 'sea-league', name: '东南亚联赛', tier: 'minor', yearOffset: 0, monthDay: '04-06', days: 12, city: '马尼拉', hostRegion: 'SEA', online: true, prize: 150000, teams: 6, invites: 4, regionLocked: 'SEA', format: 'rr' },
  { slug: 'summer-minor', name: '夏季 Minor', tier: 'minor', yearOffset: 0, monthDay: '04-20', days: 6, city: '利马', hostRegion: 'SA', prize: 300000, teams: 8, invites: 4, format: 'gsl_de8' },
  { slug: 'summer-major', name: '夏季 Major', tier: 'major', yearOffset: 0, monthDay: '05-18', days: 11, city: '斯德哥尔摩', hostRegion: 'EU', prize: 1000000, teams: 16, invites: 10, format: 'groups_de' },
  { slug: 'elite-cup', name: '精英杯', tier: 'premier', yearOffset: 0, monthDay: '06-15', days: 8, city: '利雅得', hostRegion: 'EU', prize: 800000, teams: 12, invites: 8, format: 'gsl_de8' },
];

function genericTemplates(ti: number): TournamentTemplate[] {
  const tiY = tiYearOf(ti);
  return GENERIC_EVENTS.map((g) => {
    const y = tiY + g.yearOffset;
    const startDate = `${y}-${g.monthDay}`;
    return {
      id: `${g.slug}-${y}`,
      seriesId: g.slug,
      name: `${g.name} ${y}`,
      tier: g.tier,
      startDate,
      endDate: addDays(startDate, g.days),
      city: g.city,
      hostRegion: g.hostRegion,
      online: g.online,
      prizePool: Math.round(g.prize * econIndex(y)),
      teams: g.teams,
      invites: g.invites,
      regionLocked: g.regionLocked,
      format: g.format,
    };
  });
}

/** 日期平移整年（2 月 29 日 → 2 月 28 日） */
function shiftYears(date: string, years: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) return date;
  const y = Number(m[1]) + years;
  let md = `${m[2]}-${m[3]}`;
  if (md === '02-29') md = '02-28';
  return `${y}-${md}`;
}

function shiftYearsInText(text: string, years: number): string {
  return text.replace(/(19|20)\d{2}/g, (s) => String(Number(s) + years));
}

const YEAR_RE = /(19|20)\d{2}/;
const ROMAN_TABLE: [number, string][] = [[40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

function toRoman(n: number): string {
  let v = Math.max(1, Math.floor(n));
  let out = '';
  for (const [k, s] of ROMAN_TABLE) while (v >= k) { out += s; v -= k; }
  return out;
}

/** 罗马数字 → 整数（仅 1..49 的规范写法，否则 NaN） */
function fromRoman(s: string): number {
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = map[s[i]];
    if (!v) return Number.NaN;
    const next = map[s[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 0 && total < 50 && toRoman(total) === s ? total : Number.NaN;
}

/**
 * 未来赛季赛事名称的届数递增：
 * - 「Season N / Episode N / #N / 第N届」+ step；
 * - 名称无年份也无上述标记时，末尾的数字/罗马数字 + step（如 BLAST Slam VII → XI），
 *   仍无法识别则在末尾追加年份，避免与往届同名。
 */
function bumpEditionName(name: string, step: number, year: number): string {
  if (!(step > 0)) return name;
  let bumped = false;
  const out = name
    .replace(/\b(Season|Episode)\s+(\d+)/gi, (_s, w: string, n: string) => { bumped = true; return `${w} ${Number(n) + step}`; })
    .replace(/#(\d+)/g, (_s, n: string) => { bumped = true; return `#${Number(n) + step}`; })
    .replace(/第(\d+)届/g, (_s, n: string) => { bumped = true; return `第${Number(n) + step}届`; });
  if (bumped || YEAR_RE.test(out)) return out;
  const m = /^(.*\S)\s+(\d{1,2}|[IVXL]+)$/.exec(out);
  if (m && !/dota$/i.test(m[1])) {
    const arabic = /^\d+$/.test(m[2]);
    const v = arabic ? Number(m[2]) : fromRoman(m[2]);
    if (Number.isFinite(v) && v > 0) return `${m[1]} ${arabic ? v + step : toRoman(v + step)}`;
  }
  return `${out} ${year}`;
}

/**
 * 未来赛季：复制最近有数据赛季的模板，日期按年份平移，名称中的年份/届数递增，id 以新年份重命名。
 * 同系列一个赛季内有多届（如 PGL Wallachia Season 6/7/8）时，届数按「赛季差 × 本系列届数」递增，避免与往届重名。
 */
export function cloneTemplatesForFutureSeason(ti: number): TournamentTemplate[] {
  const last = lastTournamentDataSeason();
  const source = last > 0 ? getTournamentTemplates(last).filter((t) => t.tier !== ('ti' as TournamentTier)) : [];
  if (source.length === 0) return genericTemplates(ti);
  const years = tiYearOf(ti) - tiYearOf(last);
  const editions = ti - last;
  const perSeries = new Map<string, number>();
  for (const tpl of source) {
    const key = tpl.seriesId || tpl.id;
    perSeries.set(key, (perSeries.get(key) ?? 0) + 1);
  }
  const used = new Set<string>();
  const out: TournamentTemplate[] = [];
  for (const tpl of source) {
    let id = shiftYearsInText(tpl.id, years);
    if (id === tpl.id) id = `${tpl.id}-ti${ti}`;
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    const startDate = shiftYears(tpl.startDate, years);
    const step = editions * (perSeries.get(tpl.seriesId || tpl.id) ?? 1);
    const name = bumpEditionName(shiftYearsInText(tpl.name, years), step, Number(startDate.slice(0, 4)) || tiYearOf(ti));
    out.push({
      ...tpl,
      id,
      name,
      startDate,
      endDate: shiftYears(tpl.endDate, years),
    });
  }
  return out.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

// ===========================================================================
// 赛季赛程
// ===========================================================================

/** 赛事受邀队伍：上赛季排名 ≤ invites（赛区锁定时取本赛区排名前 invites）或荣誉 ≥ inviteHonor[tier] */
function computeInvites(state: GameState, tier: TournamentTier, invites: number, size: number, regionLocked?: Region): string[] {
  const teams = Object.values(state.teams).filter((tm) => canCompete(tm) && (!regionLocked || tm.region === regionLocked));
  const rankOf = (tm: Team) => tm.lastSeasonRank ?? Number.MAX_SAFE_INTEGER;
  const byRank = teams.slice().sort((a, b) => rankOf(a) - rankOf(b) || b.honor - a.honor || (a.id < b.id ? -1 : 1));
  const n = clamp(Math.floor(invites) || 0, 0, size);
  const set = new Set<string>();
  if (regionLocked) {
    for (const tm of byRank.slice(0, n)) set.add(tm.id);
  } else {
    for (const tm of teams) if (tm.lastSeasonRank !== undefined && tm.lastSeasonRank <= n) set.add(tm.id);
  }
  const honorBar = CONFIG.tournament.inviteHonor[tier] ?? Number.MAX_SAFE_INTEGER;
  for (const tm of teams) if (tm.honor >= honorBar) set.add(tm.id);
  return byRank.filter((tm) => set.has(tm.id)).slice(0, size).map((tm) => tm.id);
}

function tournamentFromTemplate(state: GameState, tpl: TournamentTemplate, withInvites = true): Tournament {
  const season = state.season;
  const tier: TournamentTier = tpl.tier === 'ti' ? 'premier' : tpl.tier;
  const size = clamp(Math.floor(tpl.teams) || 8, MIN_EVENT_TEAMS, MAX_EVENT_TEAMS);
  let id = tpl.id || `event-${season.ti}`;
  if (state.tournaments[id] && state.tournaments[id].season !== season.ti) id = `${id}-s${season.ti}`;
  const prizePool = Math.max(0, Math.round(tpl.prizePool || 0));
  const seriesId = tpl.seriesId || tpl.id;
  return {
    id,
    seriesId,
    name: tpl.name,
    tier,
    season: season.ti,
    roundIndex: roundIndexForDate(season, tpl.startDate),
    startDate: tpl.startDate,
    city: tpl.city ?? '',
    hostRegion: tpl.hostRegion ?? 'EU',
    online: !!tpl.online,
    prizePool,
    appearanceFee: appearanceFeeFor(state, { prizePool, tier, season: season.ti, seriesId }),
    format: FORMATS.includes(tpl.format) ? tpl.format : 'de8',
    teamIds: [],
    invitedTeamIds: withInvites ? computeInvites(state, tier, tpl.invites, size, tpl.regionLocked) : [],
    qualifierTeamIds: [],
    regionLocked: tpl.regionLocked,
    stages: [],
    series: {},
    status: 'scheduled',
    placements: [],
    playerStatus: 'open',
    minHonor: CONFIG.tournament.minHonor[tier] ?? 0,
    size,
  };
}

function createTiTournament(state: GameState): Tournament {
  const ti = state.season.ti;
  const info = safeTiInfo(state, ti);
  return {
    id: tiTournamentId(ti),
    seriesId: 'ti',
    name: info.name,
    tier: 'ti',
    season: ti,
    roundIndex: tiRoundIdx(state),
    startDate: info.startDate,
    city: info.city,
    hostRegion: info.hostRegion,
    online: false,
    prizePool: info.prizePool,
    appearanceFee: appearanceFeeFor(state, { prizePool: info.prizePool, tier: 'ti', season: ti, seriesId: 'ti' }),
    format: 'ti',
    teamIds: [],
    invitedTeamIds: [],
    qualifierTeamIds: [],
    stages: [],
    series: {},
    status: 'scheduled',
    placements: [],
    playerStatus: 'locked',
    minHonor: CONFIG.tournament.minHonor.ti ?? 0,
    size: info.teams,
  };
}

/**
 * 往届赛事瘦身（控制存档体积）：AI 对局只留比分（清空 games），玩家对局保留 BP/比分但清空文字直播。
 * 更早赛季的实例整体裁剪由 season.ts 按 CONFIG.season.keepTournamentSeasons 处理。
 */
function compactPastSeasons(state: GameState, ti: number): void {
  const humans = new Set(isMultiplayer(state) ? humanTeamIds(state) : [playerTeamId(state)]);
  const isHuman = (id: string | null) => id !== null && humans.has(id);
  for (const t of Object.values(state.tournaments)) {
    if (t.season >= ti) continue;
    for (const s of Object.values(t.series ?? {})) {
      const res = s.result;
      if (!res || res.games.length === 0) continue;
      if (!isHuman(s.teamA) && !isHuman(s.teamB)) res.games = [];
      else for (const g of res.games) if (g.live && g.live.length > 0) g.live = [];
    }
  }
}

function sortSeasonTournamentIds(state: GameState): void {
  const date = (id: string) => state.tournaments[id]?.startDate ?? '';
  state.seasonTournamentIds.sort((a, b) => date(a).localeCompare(date(b)));
}

/** 线上公开赛（补位赛事）的系列 id 前缀 */
export const FILLER_SERIES_PREFIX = 'online-open-';

/** 是否为赛季初自动补位的线上公开赛 */
export function isFillerCup(t: Pick<Tournament, 'seriesId'> | null | undefined): boolean {
  return !!t && typeof t.seriesId === 'string' && t.seriesId.startsWith(FILLER_SERIES_PREFIX);
}

/**
 * 补位：玩家在某个常规回合没有任何可报名/受邀赛事（无赛事、荣誉不足或仅勉强够门槛、赛区锁定、同期受邀冲突）时，
 * 在该回合加一项开放报名的线上公开赛（CONFIG.tournament.fillerCup），不发邀请。
 * 规模 = min(teams, 同回合估算空闲队伍 + 玩家)；不足 minTeams（同回合大赛几乎占满全部战队）则不补。返回新增赛事。
 */
function addFillerCups(state: GameState, created: Tournament[], announce = true): Tournament[] {
  const cfg = CONFIG.tournament.fillerCup;
  const season = state.season;
  const me = state.teams[playerTeamId(state)];
  if (!cfg?.enabled || !me || me.disbanded) return [];
  // 受邀/已报名，或开放且荣誉稳稳高于门槛（赛季中荣誉波动后仍能报名）的赛事才算该回合有赛可打
  const covered = new Set<number>();
  for (const t of created) {
    const st = t.playerStatus;
    const safeOpen = st === 'open' && (t.minHonor <= 0 || me.honor >= t.minHonor + Math.max(0, cfg.honorMargin));
    if (st === 'invited' || st === 'registered' || safeOpen) covered.add(t.roundIndex);
  }
  // 空闲队伍估算：同回合其他赛事按「规模 vs 可参赛队伍数」占用的队伍（每队一回合只参加一项）
  const competing = Object.values(state.teams).filter((tm) => tm.id !== me.id && canCompete(tm));
  const honorFactor = CONFIG.tournament.aiMinHonorFactor;
  const occupied = (t: Tournament) => Math.min(
    t.size ?? MAX_EVENT_TEAMS,
    competing.filter((tm) => (!t.regionLocked || tm.region === t.regionLocked) && tm.honor >= t.minHonor * honorFactor).length,
  );
  const out: Tournament[] = [];
  // 多人模式：各座位依次调用；其他座位已在该回合补位的公开赛直接复用（只计算本座位的报名状态）
  const mp = isMultiplayer(state);
  const seasonFillers = () => (state.seasonTournamentIds ?? [])
    .map((id) => state.tournaments[id])
    .filter((x): x is Tournament => !!x && x.season === season.ti && isFillerCup(x));
  const existing = mp ? seasonFillers().length : 0;
  for (const r of season.rounds ?? []) {
    if (r.phase !== 'regular' || covered.has(r.index)) continue;
    if (mp) {
      const reuse = seasonFillers().find((x) => x.roundIndex === r.index);
      if (reuse) {
        reuse.playerStatus = computePlayerEntryStatus(state, reuse);
        continue;
      }
    }
    const busy = created.reduce((a, t) => a + (t.roundIndex === r.index ? occupied(t) : 0), 0);
    const size = Math.min(cfg.teams, Math.max(0, competing.length - busy) + 1);
    if (size < Math.max(2, cfg.minTeams)) continue;
    const span = Math.max(0, daysBetween(r.startDate, r.endDate));
    const startDate = span > 1 ? addDays(r.startDate, Math.min(span - 1, Math.floor(span * cfg.startOffset))) : r.startDate;
    const year = Number(startDate.slice(0, 4)) || season.year;
    const n = existing + out.length + 1;
    const tpl: TournamentTemplate = {
      id: `${FILLER_SERIES_PREFIX}ti${season.ti}-${n}`,
      seriesId: `${FILLER_SERIES_PREFIX}${n}`,
      name: `线上公开赛 ${year} 第${n}站`,
      tier: cfg.tier,
      startDate,
      endDate: addDays(startDate, 3),
      city: '线上',
      hostRegion: me.region,
      online: true,
      prizePool: Math.round(cfg.prizePool * econIndex(year)),
      teams: size,
      invites: 0,
      format: cfg.format,
    };
    const t = tournamentFromTemplate(state, tpl, false);
    if (state.tournaments[t.id]) continue;
    t.roundIndex = r.index; // 不依赖日期映射，确保落在目标回合
    t.minHonor = 0;
    t.noCircuitPoints = true; // 弱化阵容的补位赛不影响 TI 直邀积分
    registerInstance(state, t);
    t.playerStatus = computePlayerEntryStatus(state, t);
    out.push(t);
  }
  if (out.length > 0 && announce) announceFillerCups(state, out);
  return out;
}

function announceFillerCups(state: GameState, list: Tournament[]): void {
  addNews(state, 'tournament', '线上公开赛赛程公布',
    `本赛季共 ${list.length} 站线上公开赛（第 ${list.map((t) => t.roundIndex).join('、')} 回合），`
      + '不限赛区、无荣誉门槛，可在「赛事 › 赛程报名」中自由报名（需打封闭预选；只发奖金，不计巡回赛积分）。');
}

/**
 * 赛季初调用（calendar 已建立）：
 * 1. 取本赛季赛事模板（无数据 → cloneTemplatesForFutureSeason）
 * 2. 生成 Tournament 实例：roundIndex = 日期映射到常规回合 1..R（calendar.roundIndexForDate），
 *    appearanceFee、minHonor（CONFIG.tournament.minHonor）、invitedTeamIds（上赛季排名 lastSeasonRank ≤ invites，
 *    或荣誉 ≥ inviteHonor[tier]；regionLocked 时只在该赛区内取）
 * 3. 生成 TI 实例（id = `ti-${ti}`，roundIndex = R+2，tier 'ti'，format 'ti'，奖金来自 tis.json）
 * 4. 计算玩家 playerStatus：受邀 → 'invited'（自动报名；开赛前可婉拒 → 'declined'，也可重新接受）
 * 5. 写入 state.tournaments、state.seasonTournamentIds、season.rounds[i].tournamentIds；
 *    若玩家受邀的多项赛事位于同一回合，只保留等级最高者为 invited，其余自动婉拒为 'declined'
 *    （玩家可先婉拒保留的那项，再重新接受想打的那项）
 * 6. 玩家没有任何可参加赛事的常规回合 → 补一项线上公开赛（CONFIG.tournament.fillerCup，isFillerCup）
 */
export function buildSeasonTournaments(state: GameState): void {
  const season = state.season;
  const ti = season.ti;
  // 重复调用：清除本赛季旧实例
  for (const id of Object.keys(state.tournaments)) if (state.tournaments[id].season === ti) delete state.tournaments[id];
  for (const r of season.rounds ?? []) r.tournamentIds = [];
  season.registeredTournamentIds = [];
  state.seasonTournamentIds = [];
  compactPastSeasons(state, ti);

  let templates = getTournamentTemplates(ti).filter((t) => t.tier !== ('ti' as TournamentTier));
  if (templates.length === 0) templates = cloneTemplatesForFutureSeason(ti);
  templates = templates.slice().sort((a, b) => a.startDate.localeCompare(b.startDate));

  const created: Tournament[] = [];
  for (const tpl of templates) {
    const t = tournamentFromTemplate(state, tpl);
    if (state.tournaments[t.id]) continue; // 同 id 重复模板
    registerInstance(state, t);
    created.push(t);
  }
  registerInstance(state, createTiTournament(state));
  sortSeasonTournamentIds(state);

  if (!isMultiplayer(state)) {
    assignPlayerEntries(state, created);
    // 保证每个常规回合玩家都有可参加的赛事
    if (addFillerCups(state, created).length > 0) sortSeasonTournamentIds(state);
    return;
  }
  // 多人模式：报名状态、受邀冲突与补位公开赛都是座位私有的 → 每个座位各自计算
  forEachSeat(state, () => {
    state.season.registeredTournamentIds = [];
    assignPlayerEntries(state, created);
  });
  const fillers: Tournament[] = [];
  forEachSeat(state, () => {
    fillers.push(...addFillerCups(state, created, false));
  });
  // 其他座位补位的公开赛：补算本座位的报名状态
  forEachSeat(state, () => {
    for (const id of state.seasonTournamentIds) {
      const t = state.tournaments[id];
      if (t && t.season === ti && isFillerCup(t) && t.playerStatus === 'locked') t.playerStatus = computePlayerEntryStatus(state, t);
    }
  });
  if (fillers.length > 0) {
    sortSeasonTournamentIds(state);
    announceFillerCups(state, fillers.slice().sort((a, b) => a.roundIndex - b.roundIndex));
  }
}

/** 当前玩家（座位）对本赛季新赛事的报名状态 + 同回合受邀冲突（自动婉拒等级较低者） */
function assignPlayerEntries(state: GameState, created: Tournament[]): void {
  const season = state.season;
  for (const t of created) t.playerStatus = computePlayerEntryStatus(state, t);
  const pid = playerTeamId(state);
  const byRound = new Map<number, Tournament[]>();
  for (const t of created) {
    if (t.playerStatus !== 'invited') continue;
    const list = byRound.get(t.roundIndex) ?? [];
    list.push(t);
    byRound.set(t.roundIndex, list);
  }
  for (const list of byRound.values()) {
    list.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.prizePool - a.prizePool);
    const keep = list[0];
    season.registeredTournamentIds.push(keep.id);
    for (const other of list.slice(1)) {
      other.playerStatus = 'declined';
      addNews(state, 'tournament', `【婉拒邀请】${other.name}`,
        `${other.name} 与 ${keep.name} 同期举行，${state.teams[pid]?.name ?? '我们'} 优先出战后者，已自动婉拒前者的邀请。`
          + `如想改打 ${other.name}，可在「赛事 › 赛程报名」中先婉拒 ${keep.name}，再重新接受。`);
    }
  }
}

/**
 * 不考虑「已婉拒」时玩家对赛事的报名状态：
 * TI / TI 预选 → 在名单中 invited（必须参加），否则 locked；
 * 常规赛事 → 受邀 invited / 已报名 registered / 赛区不符或荣誉不足 locked / 其余 open。
 */
function baseEntryStatus(state: GameState, t: Tournament): PlayerEntryStatus {
  const pid = playerTeamId(state);
  const team = state.teams[pid];
  if (!team) return 'locked';
  if (isTiPhaseEvent(t)) return t.teamIds.includes(pid) || t.invitedTeamIds.includes(pid) ? 'invited' : 'locked';
  if (t.invitedTeamIds.includes(pid)) return 'invited';
  if (state.season?.registeredTournamentIds?.includes(t.id)) return 'registered';
  if (t.regionLocked && team.region !== t.regionLocked) return 'locked';
  return team.honor >= t.minHonor ? 'open' : 'locked';
}

/**
 * 玩家对赛事的报名状态：invited 受邀（常规赛事开赛前可婉拒；TI / TI 预选必须参加）/ registered 已报名 /
 * declined 已婉拒（主动婉拒或同回合受邀冲突自动婉拒；开赛前可重新接受）/ open（荣誉 ≥ minHonor 且赛区允许）/ locked
 */
export function computePlayerEntryStatus(state: GameState, t: Tournament): PlayerEntryStatus {
  if (!state.teams[playerTeamId(state)]) return 'locked';
  if (t.playerStatus === 'declined') return 'declined';
  return baseEntryStatus(state, t);
}

/** 同回合玩家已受邀/已报名的其他赛事（每回合最多参加一项） */
function sameRoundEntry(state: GameState, t: Tournament): Tournament | null {
  const ids = uniq([
    ...(state.season.registeredTournamentIds ?? []),
    ...(state.season.rounds?.[t.roundIndex]?.tournamentIds ?? []),
    ...(state.seasonTournamentIds ?? []),
  ]);
  for (const id of ids) {
    if (id === t.id) continue;
    const o = state.tournaments[id];
    if (o && o.season === t.season && o.roundIndex === t.roundIndex && o.status !== 'finished'
      && (o.playerStatus === 'registered' || o.playerStatus === 'invited')) return o;
  }
  return null;
}

function clashMessage(clash: Tournament): string {
  return clash.playerStatus === 'invited'
    ? `同一回合只能参加一项赛事：已受邀参加 ${clash.name}，请先婉拒该邀请`
    : `同一回合只能参加一项赛事：已报名 ${clash.name}，请先取消该报名`;
}

/**
 * 报名（'open' → 'registered'），或重新接受已婉拒的邀请（'declined' → 受邀名单中则 'invited'，否则按普通报名 'registered'）。
 * TI / TI 预选无需报名；赛事已开始 → 失败；同回合已受邀/已报名其他赛事 → 失败（需先婉拒/取消那一项）。
 */
export function registerForTournament(state: GameState, tournamentId: string): OpResult {
  const t = state.tournaments[tournamentId];
  if (!t || !state.season || t.season !== state.season.ti) return { ok: false, message: '赛事不存在或不属于本赛季' };
  if (isTiPhaseEvent(t)) return { ok: false, message: 'TI 与 TI 预选赛按积分榜自动安排，无需报名' };
  const team = state.teams[playerTeamId(state)];
  if (!team || team.disbanded) return { ok: false, message: '战队不存在或已解散' };
  if (!entryEditable(state, t)) return { ok: false, message: `${t.name} ${t.status === 'finished' ? '已结束' : '已开赛'}，报名通道关闭` };
  const declined = computePlayerEntryStatus(state, t) === 'declined';
  // 已婉拒：按「未婉拒」时的状态重新判断（受邀名单中 → 重新接受邀请；否则走普通报名）
  const status = declined ? baseEntryStatus(state, t) : computePlayerEntryStatus(state, t);
  if (status === 'invited' && !declined) return { ok: false, message: `已受邀参加 ${t.name}，无需报名` };
  if (status === 'registered' && !declined) return { ok: false, message: `已报名 ${t.name}` };
  if (status === 'locked') {
    if (t.regionLocked && team.region !== t.regionLocked) {
      return { ok: false, message: `${t.name} 仅限${REGION_LABEL[t.regionLocked]}赛区战队参加` };
    }
    return { ok: false, message: `荣誉不足：${t.name} 需要荣誉 ≥ ${t.minHonor}` };
  }
  const clash = sameRoundEntry(state, t);
  if (clash) return { ok: false, message: clashMessage(clash) };
  if (!state.season.registeredTournamentIds.includes(t.id)) state.season.registeredTournamentIds.push(t.id);
  if (status === 'invited') {
    t.playerStatus = 'invited';
    addNews(state, 'tournament', `【接受邀请】${team.name} 将出战 ${t.name}`,
      `${team.name} 重新接受了 ${t.name}（第 ${t.roundIndex} 回合）的邀请，以受邀身份直接进入正赛。`);
    return { ok: true, message: `已重新接受 ${t.name} 的邀请（受邀直接进入正赛）` };
  }
  t.playerStatus = 'registered';
  return { ok: true, message: `已报名 ${t.name}（未获直邀，需先打封闭预选赛争夺正赛席位）` };
}

/**
 * 取消报名（'registered' → open/locked），或婉拒邀请（'invited' → 'declined'，无荣誉惩罚，空出的席位开赛时由 AI 递补）。
 * TI 与 TI 赛区预选为赛季收官，必须参加；赛事已开始不可修改。
 */
export function unregisterFromTournament(state: GameState, tournamentId: string): OpResult {
  const t = state.tournaments[tournamentId];
  if (!t || !state.season) return { ok: false, message: '赛事不存在' };
  const pid = playerTeamId(state);
  if (isTiPhaseEvent(t)) {
    const entered = t.playerStatus === 'invited' || t.teamIds.includes(pid) || t.invitedTeamIds.includes(pid);
    return entered
      ? { ok: false, message: `${t.name} 为赛季收官的 TI 阶段赛事，必须参加，不可婉拒或退出` }
      : { ok: false, message: `尚未获得 ${t.name} 的参赛资格` };
  }
  const invited = t.playerStatus === 'invited';
  const closed = !entryEditable(state, t);
  const closedText = t.status === 'finished' ? '已结束' : '已开赛';
  if (t.playerStatus === 'declined') {
    if (closed) return { ok: false, message: `${t.name} ${closedText}，无法修改报名` };
    return t.invitedTeamIds.includes(pid)
      ? { ok: false, message: `已婉拒 ${t.name} 的邀请（开赛前可重新接受）` }
      : { ok: false, message: `尚未报名 ${t.name}` };
  }
  if (!invited && t.playerStatus !== 'registered') return { ok: false, message: `尚未报名 ${t.name}` };
  if (closed) return { ok: false, message: `${t.name} ${closedText}，无法${invited ? '婉拒' : '退出'}` };
  state.season.registeredTournamentIds = state.season.registeredTournamentIds.filter((id) => id !== t.id);
  if (invited) {
    t.playerStatus = 'declined';
    const name = state.teams[pid]?.name ?? '我们';
    addNews(state, 'tournament', `【婉拒邀请】${name} 婉拒 ${t.name}`,
      `${name} 婉拒了 ${t.name}（第 ${t.roundIndex} 回合）的邀请，空出的正赛席位将由其他战队递补。`
        + '开赛前仍可在「赛事 › 赛程报名」中重新接受。');
    return { ok: true, message: `已婉拒 ${t.name} 的邀请（开赛前可重新接受；如无其他安排，该回合为休赛回合）` };
  }
  t.playerStatus = computePlayerEntryStatus(state, t);
  return { ok: true, message: `已取消报名 ${t.name}，该回合将作为休赛回合` };
}

/** 玩家在指定回合参加的赛事（invited/registered，含 TI 预选与 TI），无则 null */
export function playerTournamentInRound(state: GameState, roundIndex: number): Tournament | null {
  const pid = playerTeamId(state);
  const ti = state.season?.ti;
  let best: Tournament | null = null;
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (!t || t.season !== ti || t.roundIndex !== roundIndex) continue;
    let mine: boolean;
    if (t.tier === 'ti') mine = t.playerStatus === 'invited' || t.teamIds.includes(pid);
    else mine = t.playerStatus === 'invited' || t.playerStatus === 'registered';
    if (!mine) continue;
    if (!best || TIER_ORDER[t.tier] < TIER_ORDER[best.tier]) best = t;
  }
  return best;
}

/** 本赛季回合统计（供「本赛季共 X 个大回合」展示）。TI 阶段尚未确定时，预选/正赛回合均按赛事回合计 */
export function roundCounts(state: GameState): { total: number; tournamentRounds: number; restRounds: number } {
  const rounds = state.season?.rounds ?? [];
  const tiSet = Object.values(state.tournaments).some((t) => t.season === state.season.ti && isTiQualifier(t))
    || (state.tournaments[tiTournamentId(state.season.ti)]?.invitedTeamIds.length ?? 0) > 0;
  let total = 0;
  let tournamentRounds = 0;
  rounds.forEach((r, i) => {
    if (r.phase === 'preseason' || r.phase === 'season_end') return;
    total++;
    const idx = r.index ?? i;
    if ((r.phase === 'ti_qualifier' || r.phase === 'ti') && !tiSet) tournamentRounds++;
    else if (playerTournamentInRound(state, idx)) tournamentRounds++;
  });
  return { total, tournamentRounds, restRounds: total - tournamentRounds };
}

/** 赛季积分榜：points 降序，荣誉为次序（未解散战队） */
export function seasonStandings(state: GameState): Team[] {
  return Object.values(state.teams)
    .filter((t) => !t.disbanded)
    .sort((a, b) => (b.points || 0) - (a.points || 0) || b.honor - a.honor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ===========================================================================
// TI 阶段
// ===========================================================================

/** 赛区名额：优先 tis.json；缺失时在有队伍的赛区间平均分配 */
function resolveQualifierSlots(info: TiInfo, regionsWithTeams: Region[], slotsTotal: number): Partial<Record<Region, number>> {
  const out: Partial<Record<Region, number>> = {};
  let sum = 0;
  for (const r of REGIONS) {
    const v = Math.max(0, Math.floor(info.qualifierSlots?.[r] ?? 0));
    if (v > 0) { out[r] = v; sum += v; }
  }
  if (sum > 0 || slotsTotal <= 0 || regionsWithTeams.length === 0) return out;
  const k = regionsWithTeams.length;
  const base = Math.floor(slotsTotal / k);
  let rem = slotsTotal - base * k;
  for (const r of regionsWithTeams) {
    const v = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    if (v > 0) out[r] = v;
  }
  return out;
}

/** 无 TI 名额赛区的队伍并入的邻近赛区（按顺序取第一个有名额的；都没有则并入名额最多的赛区） */
const NEIGHBOR_REGIONS: Record<Region, Region[]> = {
  CN: ['SEA'], SEA: ['CN'], CIS: ['EU'], EU: ['CIS'], NA: ['SA', 'EU'], SA: ['NA', 'EU'],
};

/** 某赛区队伍参加哪个赛区的 TI 预选；没有任何名额（全邀请制）→ null */
function qualifierHost(slots: Partial<Record<Region, number>>, r: Region): Region | null {
  if ((slots[r] ?? 0) > 0) return r;
  for (const n of NEIGHBOR_REGIONS[r] ?? []) if ((slots[n] ?? 0) > 0) return n;
  let best: Region | null = null;
  for (const x of REGIONS) if ((slots[x] ?? 0) > 0 && (!best || (slots[x] ?? 0) > (slots[best] ?? 0))) best = x;
  return best;
}

/**
 * 赛区名额多于该预选可参赛队伍（如该赛区强队全部直邀、或该赛区没有战队）时，多出的名额
 * 转给「可参赛队伍 - 名额」盈余最多的预选，使 TI 名额尽量由预选决出，而不是在 TI 开赛时按积分榜补齐。
 * poolSize(r) = 参加 r 赛区预选的队伍数（已按参赛上限截断）。原地修改 slots。
 */
function redistributeUnusableSlots(slots: Partial<Record<Region, number>>, poolSize: (r: Region) => number): void {
  let spare = 0;
  for (const r of REGIONS) {
    const n = slots[r] ?? 0;
    const excess = n - poolSize(r);
    if (n > 0 && excess > 0) {
      spare += excess;
      slots[r] = n - excess;
      if (!slots[r]) delete slots[r];
    }
  }
  while (spare > 0) {
    let best: Region | null = null;
    let bestSurplus = 0;
    for (const r of REGIONS) {
      const surplus = poolSize(r) - (slots[r] ?? 0);
      // 保留至少 1 个淘汰名额，否则预选失去意义；盈余相同则给名额少的赛区（分散）
      if (surplus <= 1) continue;
      if (!best || surplus > bestSurplus || (surplus === bestSurplus && (slots[r] ?? 0) < (slots[best] ?? 0))) {
        best = r;
        bestSurplus = surplus;
      }
    }
    if (!best) break;
    slots[best] = (slots[best] ?? 0) + 1;
    spare--;
  }
}

/**
 * 进入 TI 预选回合时调用：
 * 1. 积分榜前 directInvites 名直邀 TI（TI 实例 invitedTeamIds/teamIds）
 * 2. 为每个有名额的赛区创建预选赛实例（id `tiq-${ti}-${region}`，tier 'qualifier'，format 'de8' 或队伍不足时 'se8'，
 *    roundIndex = R+1，参赛 = 该赛区未受邀战队按排名取前 8（玩家战队若未受邀必定参加））。
 *    没有名额的赛区（如早期 TI 无南美/独联体名额）并入邻近赛区预选（NEIGHBOR_REGIONS），玩家同样跨区参赛；
 *    报名队伍不超过名额的预选（无竞争）连同名额并入邻近预选，避免白送门票；仍有多余名额则转给队伍富余的预选
 *    （redistributeUnusableSlots）；实在无处可并才全部直通 TI。
 *    全邀请制（无任何预选名额，如 TI1）→ 未获直邀者无缘 TI。
 * 3. 玩家：受邀 → TI playerStatus 'invited'；否则所在预选 playerStatus 'invited'（强制）
 * 4. 新闻：TI 直邀名单
 */
export function setupTiPhase(state: GameState): void {
  const season = state.season;
  const ti = season.ti;
  const pid = playerTeamId(state);
  let tiT = state.tournaments[tiTournamentId(ti)];
  if (!tiT) {
    tiT = createTiTournament(state);
    registerInstance(state, tiT);
  }
  // 幂等：已建立则跳过
  const already = Object.values(state.tournaments).some((t) => t.season === ti && isTiQualifier(t));
  if (already || tiT.invitedTeamIds.length > 0 || tiT.status !== 'scheduled') return;

  const info = safeTiInfo(state, ti);
  const size = clamp(Math.floor(tiT.size ?? info.teams), 2, MAX_EVENT_TEAMS);
  const mp = isMultiplayer(state);
  // 参与 TI 资格分配的玩家战队（单机 = 当前玩家；多人 = 全部仍在比赛中的座位）
  const humans = humansOf(state);
  const humanIds = new Set(humans);
  const activeOf = (id: string) => {
    const tm = state.teams[id];
    return !!tm && !tm.disbanded;
  };
  const standings = seasonStandings(state).filter((tm) => (humanIds.has(tm.id) ? activeOf(tm.id) : canCompete(tm)));
  const direct = Math.min(clamp(info.directInvites, 0, size), standings.length);
  const invited = standings.slice(0, direct).map((tm) => tm.id);
  tiT.invitedTeamIds = invited.slice();
  tiT.teamIds = invited.slice();
  const needsQual = humans.filter((h) => activeOf(h) && !invited.includes(h));

  const rest = standings.filter((tm) => !invited.includes(tm.id));
  const regionsWithTeams = REGIONS.filter((r) => rest.some((tm) => tm.region === r));
  const slots = resolveQualifierSlots(info, regionsWithTeams, size - invited.length);
  const maxTeams = Math.max(2, CONFIG.tournament.qualifierTeams);

  // 各预选的参赛队（积分榜顺序，按参赛上限截断；玩家未受邀则必定参加所属预选）
  const hostOf = new Map<Region, Region | null>(REGIONS.map((r) => [r, qualifierHost(slots, r)]));
  const pools = new Map<Region, string[]>();
  for (const tm of rest) {
    const h = hostOf.get(tm.region);
    if (!h) continue;
    const list = pools.get(h) ?? [];
    list.push(tm.id);
    pools.set(h, list);
  }
  const myHost = new Map<string, Region | null>();
  const regionHadSlots = new Map<string, boolean>();
  for (const h of humans) {
    const region = state.teams[h]?.region as Region;
    regionHadSlots.set(h, (slots[region] ?? 0) > 0);
    if (needsQual.includes(h)) myHost.set(h, hostOf.get(region) ?? null);
  }
  const entrants = (region: Region): string[] => {
    let list = (pools.get(region) ?? []).slice(0, maxTeams);
    for (const h of needsQual) {
      if (myHost.get(h) !== region || list.includes(h)) continue;
      if (list.length >= maxTeams) {
        // 名额已满：顶替最后一支非玩家队伍
        let k = list.length - 1;
        while (k >= 0 && humanIds.has(list[k])) k--;
        if (k < 0) continue;
        list = [...list.slice(0, k), ...list.slice(k + 1), h];
      } else {
        list = [...list, h];
      }
    }
    return list;
  };
  // 无竞争的预选（报名队伍 ≤ 名额，如该赛区强队都已直邀）连同名额并入邻近预选，避免白送 TI 门票；
  // 无处可并时才全部直通
  const order = new Map(rest.map((tm, i) => [tm.id, i]));
  for (let pass = 0; pass < REGIONS.length; pass++) {
    let changed = false;
    for (const r of REGIONS) {
      const n = slots[r] ?? 0;
      const cnt = entrants(r).length;
      if (n <= 0 || cnt === 0 || cnt > n) continue;
      const others = REGIONS.filter((x) => x !== r && (slots[x] ?? 0) > 0);
      const target = (NEIGHBOR_REGIONS[r] ?? []).find((x) => others.includes(x))
        ?? others.sort((a, b) => (entrants(b).length - (slots[b] ?? 0)) - (entrants(a).length - (slots[a] ?? 0)))[0];
      if (!target) continue;
      slots[target] = (slots[target] ?? 0) + n;
      delete slots[r];
      const merged = [...(pools.get(target) ?? []), ...(pools.get(r) ?? [])];
      merged.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      pools.set(target, merged);
      pools.delete(r);
      for (const x of REGIONS) if (hostOf.get(x) === r) hostOf.set(x, target);
      for (const [h, host] of myHost) if (host === r) myHost.set(h, target);
      changed = true;
    }
    if (!changed) break;
  }
  redistributeUnusableSlots(slots, (r) => entrants(r).length);

  const qIdx = tiQualifierRoundIdx(state);
  const qDate = season.rounds?.[qIdx]?.startDate ?? addDays(season.tiStartDate, -CONFIG.calendar.tiQualifierLeadDays);
  const lines = new Map<string, string[]>(humans.map((h) => [h, [] as string[]]));
  for (const h of needsQual) {
    const me = state.teams[h];
    const host = myHost.get(h) ?? null;
    if (!host) {
      lines.get(h)!.push(`TI${ti} 采用全邀请制，${me?.name} 未进入积分榜前 ${direct} 名，本届只能作壁上观。`);
    } else if (host !== me.region) {
      lines.get(h)!.push(regionHadSlots.get(h)
        ? `${REGION_LABEL[me.region]}赛区预选报名队伍不足，并入${REGION_LABEL[host]}预选赛，${me?.name} 将跨区争夺 TI 门票。`
        : `${REGION_LABEL[me.region]}赛区本届没有 TI 名额，${me?.name} 将跨区参加${REGION_LABEL[host]}预选赛。`);
    }
  }
  const createdQuals: Tournament[] = [];
  for (const region of REGIONS) {
    const n = slots[region] ?? 0;
    if (n <= 0) continue;
    const participants = entrants(region);
    if (participants.length === 0) continue;
    if (participants.length <= n) {
      // 报名队伍不超过名额：全部直通 TI
      for (const id of participants) if (!tiT.teamIds.includes(id)) tiT.teamIds.push(id);
      for (const h of humans) {
        if (participants.includes(h)) lines.get(h)!.push(`${REGION_LABEL[region]}预选报名队伍不足，${state.teams[h]?.name} 直通 TI${ti}！`);
      }
      continue;
    }
    const regionsIn = REGIONS.filter((r) => participants.some((id) => state.teams[id]?.region === r));
    const merged = regionsIn.some((r) => r !== region);
    const label = [region, ...regionsIn.filter((r) => r !== region)].map((r) => REGION_LABEL[r]).join('/');
    const q: Tournament = {
      id: `tiq-${ti}-${region}`,
      seriesId: `tiq-${region}`,
      name: `TI${ti} ${merged ? label : REGION_LABEL[region]}预选赛`,
      tier: 'qualifier',
      season: ti,
      roundIndex: qIdx,
      startDate: qDate,
      city: '线上',
      hostRegion: region,
      online: true,
      prizePool: 0,
      appearanceFee: 0,
      format: participants.length >= CONFIG.tournament.tiQualifierDeMinTeams ? 'de8' : 'se8',
      teamIds: participants.slice(),
      invitedTeamIds: participants.slice(),
      qualifierTeamIds: [],
      stages: [],
      series: {},
      status: 'scheduled',
      placements: [],
      playerStatus: participants.includes(pid) ? 'invited' : 'locked',
      minHonor: 0,
      size: participants.length,
      advanceToTi: { tiId: tiT.id, slots: n },
    };
    if (!merged) q.regionLocked = region; // 跨区合并的预选不标「仅限某赛区」
    registerInstance(state, q);
    createdQuals.push(q);
    for (const h of humans) {
      if (!participants.includes(h)) continue;
      if (!mp && !season.registeredTournamentIds.includes(q.id)) season.registeredTournamentIds.push(q.id);
      lines.get(h)!.push(`${state.teams[h]?.name} 未获直邀，将出战 ${q.name}：${participants.length} 支队伍争夺 ${n} 个 TI 名额。`);
    }
  }
  const tiTour = tiT;
  if (!mp) {
    tiTour.playerStatus = tiTour.teamIds.includes(pid) ? 'invited' : 'locked';
  } else {
    // 多人模式：预选/TI 的报名状态与已报名列表是座位私有字段
    for (const h of humans) {
      withSeat(state, h, () => {
        for (const q of createdQuals) {
          const inQ = q.teamIds.includes(h);
          q.playerStatus = inQ ? 'invited' : 'locked';
          if (inQ && !state.season.registeredTournamentIds.includes(q.id)) state.season.registeredTournamentIds.push(q.id);
        }
        tiTour.playerStatus = tiTour.teamIds.includes(h) ? 'invited' : 'locked';
      });
    }
  }
  sortSeasonTournamentIds(state);

  const names = invited.map((id) => state.teams[id]?.name ?? id).join('、');
  addNews(state, 'tournament', `TI${ti} 直邀名单出炉`,
    `${info.name}（${info.city}，奖金池 ${prizePoolLabel(state, { prizePool: info.prizePool, tier: 'ti', season: ti, seriesId: 'ti' })}）直邀 ${invited.length} 队：${names || '无'}。其余名额由各赛区预选决出。`, true);
  const humanNews = (h: string) => {
    if (invited.includes(h)) {
      addNews(state, 'tournament', `${state.teams[h]?.name} 获得 TI${ti} 直邀！`, '凭借本赛季积分稳居前列，我们无需再打预选，TI 舞台见！', true);
    } else {
      for (const line of lines.get(h) ?? []) addNews(state, 'tournament', `TI${ti} 资格之路`, line, true);
    }
  };
  if (!mp) humanNews(pid);
  else for (const h of humans) withSeat(state, h, () => humanNews(h));
}

// ===========================================================================
// 回合开赛
// ===========================================================================

/** AI 补位权重：积分 + 荣誉/2 + 评分×2（CONFIG.tournament.aiFillWeight） */
function aiFillWeight(team: Team, rating: number): number {
  const w = CONFIG.tournament.aiFillWeight;
  return Math.max(1, (team.points || 0) * w.points + Math.max(0, team.honor) * w.honor + rating * w.rating);
}

/** 无放回加权抽样 */
function weightedSample<T>(state: GameState, items: T[], weights: number[], k: number): T[] {
  const rng = rngOf(state);
  const pool = items.slice();
  const ws = weights.slice();
  const out: T[] = [];
  while (out.length < k && pool.length > 0) {
    const idx = rng.weighted(pool.map((_, i) => i), ws);
    out.push(pool[idx]);
    pool.splice(idx, 1);
    ws.splice(idx, 1);
  }
  return out;
}

/**
 * 进入某回合时调用：为本回合所有赛事确定参赛队（等级高的赛事先选，同一回合一队只能参加一项），
 * 玩家报名但未受邀 → 进入封闭预选（qualifierTeamIds，含玩家 + 7 支 AI）；玩家婉拒邀请（declined）→ 不入选，
 * 空出的受邀席位与其余名额一样按排名/荣誉加权随机由 AI 填满，
 * 然后调用 tournament.initTournamentStages 建立赛制、status='running'。
 * TI 回合：TI 参赛队 = 直邀 + 各赛区预选晋级队（由 tournament.finishTournament 写入），不足时按排名补齐。
 */
export function startRoundTournaments(state: GameState, roundIndex: number): void {
  const season = state.season;
  const ti = season.ti;
  const ids = uniq([...(season.rounds?.[roundIndex]?.tournamentIds ?? []), ...(state.seasonTournamentIds ?? [])]);
  const all = ids.map((id) => state.tournaments[id]).filter((t): t is Tournament => !!t && t.season === ti && t.roundIndex === roundIndex);
  const busy = new Set<string>();
  for (const t of all) if (t.status === 'running') for (const id of [...t.teamIds, ...t.qualifierTeamIds]) busy.add(id);
  const list = all.filter((t) => t.status === 'scheduled')
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.prizePool - a.prizePool || (a.id < b.id ? -1 : 1));
  if (list.length === 0) return;

  const ratingCache = new Map<string, number>();
  const rating = (id: string) => {
    let r = ratingCache.get(id);
    if (r === undefined) { r = teamRating(state, id); ratingCache.set(id, r); }
    return r;
  };
  const pid = playerTeamId(state);

  for (const t of list) {
    if (t.tier === 'ti') prepareTi(state, t, busy);
    else if (isTiQualifier(t)) prepareTiQualifier(state, t);
    else prepareRegular(state, t, busy, rating);
    if (t.status !== 'scheduled') continue;

    const participants = uniq([...t.teamIds, ...t.qualifierTeamIds]);
    if (participants.length < 2) {
      cancelTournament(state, t, participants);
      continue;
    }
    for (const id of participants) busy.add(id);
    const ranks = computeExpectedRanks(state, t);
    t.expectedRanks = ranks;
    if (!isMultiplayer(state)) {
      if (participants.includes(pid)) t.expectedRank = ranks[pid];
    } else {
      // 多人模式：赛前预期名次是座位私有字段
      for (const h of activeHumanIds(state)) if (participants.includes(h)) withSeat(state, h, () => { t.expectedRank = ranks[h]; });
    }
    initTournamentStages(state, t.id);
    t.status = 'running';
    announceStart(state, t);
  }
}

function prepareRegular(state: GameState, t: Tournament, busy: Set<string>, rating: (id: string) => number): void {
  // 多人模式：每位玩家按自己的报名状态（受邀 → 正赛；已报名 → 封闭预选）
  const humans = humansOf(state);
  const humanIds = new Set(humans);
  const size = clamp(Math.floor(t.size ?? Math.max(8, t.invitedTeamIds.length)), 2, MAX_EVENT_TEAMS);
  const canEnter = (id: string) => {
    const tm = state.teams[id];
    return !!tm && !tm.disbanded && !busy.has(id);
  };
  const invitedHumans = humans.filter((h) => canEnter(h) && statusOf(state, h, t) === 'invited');
  const qualHumans = humans.filter((h) => canEnter(h) && statusOf(state, h, t) === 'registered');
  const slotsCfg = Math.max(1, Math.floor(CONFIG.tournament.qualifierSlotsPerEvent));
  const reserve = qualHumans.length > 0 ? Math.min(slotsCfg, Math.max(1, size - 1)) : 0;

  const main: string[] = [...invitedHumans];
  for (const id of t.invitedTeamIds) {
    if (main.length >= size - reserve) break;
    if (humanIds.has(id) || main.includes(id) || busy.has(id) || !canCompete(state.teams[id])) continue;
    main.push(id);
  }

  const honorFactor = CONFIG.tournament.aiMinHonorFactor;
  const eligible = Object.values(state.teams).filter((tm) => !humanIds.has(tm.id) && !tm.isPlayer && canCompete(tm)
    && !busy.has(tm.id) && !main.includes(tm.id)
    && (!t.regionLocked || tm.region === t.regionLocked)
    && tm.honor >= t.minHonor * honorFactor);
  const need = Math.max(0, size - reserve - main.length);
  const picks = weightedSample(state, eligible, eligible.map((tm) => aiFillWeight(tm, rating(tm.id))), need);
  for (const tm of picks) main.push(tm.id);

  let quals: string[] = [];
  if (qualHumans.length > 0) {
    const myR = rating(qualHumans[0]);
    const picked = new Set(picks.map((tm) => tm.id));
    const pool = eligible.filter((tm) => !picked.has(tm.id))
      .sort((a, b) => Math.abs(rating(a.id) - myR) - Math.abs(rating(b.id) - myR) || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(0, CONFIG.tournament.qualifierTeams - qualHumans.length))
      .map((tm) => tm.id);
    quals = [...qualHumans, ...pool];
    if (quals.length <= reserve) {
      main.push(...quals);
      quals = [];
    }
  }
  t.teamIds = main;
  t.qualifierTeamIds = quals;
  t.qualifierSlots = quals.length > 0 ? reserve : 0;
}

function prepareTi(state: GameState, t: Tournament, busy: Set<string>): void {
  const pid = playerTeamId(state);
  const humanIds = new Set(humansOf(state));
  const info = safeTiInfo(state, t.season);
  const size = clamp(Math.floor(t.size ?? info.teams), 2, MAX_EVENT_TEAMS);
  const okTeam = (id: string) => {
    const tm = state.teams[id];
    return !!tm && !tm.disbanded && (humanIds.has(id) || tm.playerIds.length > 0);
  };
  const ids = uniq([...t.invitedTeamIds, ...t.teamIds]).filter(okTeam);
  if (ids.length < size) {
    // 名额不足：按积分榜补齐（先排除预选赛落败者与玩家）
    const lostQual = new Set<string>();
    for (const q of Object.values(state.tournaments)) {
      if (q.season === t.season && isTiQualifier(q)) for (const id of q.teamIds) lostQual.add(id);
    }
    const standings = seasonStandings(state).filter((tm) => !humanIds.has(tm.id) && canCompete(tm) && !ids.includes(tm.id) && !busy.has(tm.id));
    for (const tm of standings) {
      if (ids.length >= size) break;
      if (!lostQual.has(tm.id)) ids.push(tm.id);
    }
    for (const tm of standings) {
      if (ids.length >= size) break;
      if (!ids.includes(tm.id)) ids.push(tm.id);
    }
  }
  t.teamIds = ids;
  t.qualifierTeamIds = [];
  t.qualifierSlots = 0;
  if (!isMultiplayer(state)) t.playerStatus = ids.includes(pid) ? 'invited' : 'locked';
  else for (const h of activeHumanIds(state)) withSeat(state, h, () => { t.playerStatus = ids.includes(h) ? 'invited' : 'locked'; });
}

function prepareTiQualifier(state: GameState, t: Tournament): void {
  const pid = playerTeamId(state);
  const mp = isMultiplayer(state);
  const humans = humansOf(state);
  const humanIds = new Set(humans);
  t.teamIds = uniq(t.teamIds).filter((id) => {
    const tm = state.teams[id];
    return !!tm && !tm.disbanded && (humanIds.has(id) || tm.playerIds.length > 0);
  });
  t.qualifierTeamIds = [];
  t.qualifierSlots = 0;
  const slots = t.advanceToTi?.slots ?? 0;
  if (t.teamIds.length > 0 && t.teamIds.length <= slots) {
    // 人数不超过名额：全部直通 TI，无需比赛
    const tiT = t.advanceToTi ? state.tournaments[t.advanceToTi.tiId] : undefined;
    if (tiT) {
      for (const id of t.teamIds) if (!tiT.teamIds.includes(id)) tiT.teamIds.push(id);
      if (!mp) {
        if (tiT.teamIds.includes(pid)) tiT.playerStatus = 'invited';
      } else {
        for (const h of humans) if (tiT.teamIds.includes(h)) withSeat(state, h, () => { tiT.playerStatus = 'invited'; });
      }
    }
    closeUnplayed(state, t);
    const notify = (h: string) => {
      addNews(state, 'tournament', `${state.teams[h]?.name ?? '我们'} 直通 TI${t.season}`,
        `${t.name} 报名队伍不足 ${slots + 1} 支，无需比赛即获得 TI 门票。`, true);
    };
    if (!mp) {
      if (t.teamIds.includes(pid)) notify(pid);
    } else {
      for (const h of humans) if (t.teamIds.includes(h)) withSeat(state, h, () => notify(h));
    }
  }
}

/**
 * 未开打即结束的赛事（取消 / TI 预选人数不足直通）：status='finished'，
 * 释放为其雇佣的临时替补、清除选手对本赛事的不可用标记（与 tournament.finishTournament 的收尾一致）。
 */
function closeUnplayed(state: GameState, t: Tournament): void {
  t.status = 'finished';
  releaseTempSubs(state, t.id);
  for (const p of Object.values(state.players)) {
    const list = p.unavailableTournamentIds;
    if (!list || !list.includes(t.id)) continue;
    p.unavailableTournamentIds = list.filter((x) => x !== t.id);
    if (p.unavailableTournamentIds.length === 0) delete p.unavailableTournamentIds;
  }
}

function cancelTournament(state: GameState, t: Tournament, participants: string[]): void {
  const pid = playerTeamId(state);
  const wasEntered = participants.includes(pid) || t.playerStatus === 'registered' || t.playerStatus === 'invited';
  t.stages = [];
  t.series = {};
  t.placements = [];
  // 未开打：清空名单，避免残留队伍看起来同时参加了同回合的其他赛事
  t.teamIds = [];
  t.qualifierTeamIds = [];
  t.qualifierSlots = 0;
  // 多人模式：报名状态是座位私有字段 → 先记下每位玩家是否参赛
  const enteredHumans = isMultiplayer(state)
    ? activeHumanIds(state).filter((h) => {
      const st = statusOf(state, h, t);
      return participants.includes(h) || st === 'registered' || st === 'invited';
    })
    : [];
  closeUnplayed(state, t);
  if (isMultiplayer(state)) {
    if (isTiQualifier(t) || t.tier === 'ti') return;
    for (const h of enteredHumans) withSeat(state, h, () => withdrawCancelled(state, t));
    return;
  }
  if (!wasEntered || isTiQualifier(t) || t.tier === 'ti') return;
  withdrawCancelled(state, t);
}

/** 玩家报名/受邀的赛事取消：撤销报名，本回合按休赛回合处理（可训练） */
function withdrawCancelled(state: GameState, t: Tournament): void {
  t.playerStatus = 'declined';
  state.season.registeredTournamentIds = state.season.registeredTournamentIds.filter((id) => id !== t.id);
  addNews(state, 'tournament', `${t.name} 取消`, '参赛队伍不足，赛事主办方宣布取消。本回合转为休赛回合。');
}

function announceStart(state: GameState, t: Tournament): void {
  const n = uniq([...t.teamIds, ...t.qualifierTeamIds]).length;
  if (isMultiplayer(state)) {
    // 多人模式：每位参赛玩家收到自己的开赛新闻；无玩家参赛时发世界新闻
    const entered = activeHumanIds(state).filter((h) => t.qualifierTeamIds.includes(h) || t.teamIds.includes(h));
    for (const h of entered) withSeat(state, h, () => announceStartFor(state, t, h, n));
    if (entered.length) return;
  } else if (announceStartFor(state, t, playerTeamId(state), n)) {
    return;
  }
  if (t.tier === 'ti') {
    addNews(state, 'tournament', `${t.name} 开幕`, `${n} 支战队齐聚${t.city}，为不朽盾而战。`, true);
  } else if (t.tier === 'major') {
    addNews(state, 'tournament', `${t.name} 开赛`, `${n} 支战队角逐 ${prizePoolLabel(state, t)} 奖金。`);
  }
}

/** 玩家（pid）参赛时的开赛新闻；未参赛返回 false */
function announceStartFor(state: GameState, t: Tournament, pid: string, n: number): boolean {
  const inQual = t.qualifierTeamIds.includes(pid);
  const inMain = t.teamIds.includes(pid);
  if (inQual || inMain) {
    const exp = t.expectedRank ? `赛前预期：第 ${t.expectedRank} 名左右。` : '';
    const qual = inQual
      ? `我们未获直邀，需先在封闭预选赛中突围（${t.qualifierTeamIds.length} 进 ${t.qualifierSlots}）。`
      : '';
    const prize = t.prizePool > 0 ? `争夺 ${formatGold(awardedPrizePool(state, t))} 奖金。` : '';
    // 多人模式：这是写给该玩家的赛前简报（预期名次、「我们」），公开动态由「出征」新闻承担，避免对其他玩家重复快讯
    addNews(state, 'tournament', `${t.name} 开赛`, `${n} 支队伍${prize ? '' : '同场竞技。'}${prize}${exp}${qual}`, true,
      isMultiplayer(state) ? { visibility: 'private' } : undefined);
    return true;
  }
  return false;
}
