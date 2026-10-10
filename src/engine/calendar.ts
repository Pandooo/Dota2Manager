// 赛季日历【E5 负责实现】
// 回合表：0=preseason，1..R=regular，R+1=ti_qualifier，R+2=ti。日期区间均为 [startDate, endDate)。
import type { GameState, RoundInfo, Season, SeasonPhase, Tournament } from './types';
import { CONFIG, TI_YEAR } from './config';
import { addDays, compareDate, daysBetween, parseDate } from './util';
import { getTiInfo } from '../data/index';
import { playerTournamentInRound } from './schedule';

/**
 * 内置 TI 正赛日期兜底表（tis.json 缺失/损坏时使用）。
 * 历届为近似真实日期（含小组赛），TI15/TI16 为推演。
 */
const FALLBACK_TI_DATES: Record<number, [string, string]> = {
  1: ['2011-08-17', '2011-08-21'],
  2: ['2012-08-26', '2012-09-02'],
  3: ['2013-08-03', '2013-08-11'],
  4: ['2014-07-08', '2014-07-21'],
  5: ['2015-07-27', '2015-08-08'],
  6: ['2016-08-03', '2016-08-13'],
  7: ['2017-08-02', '2017-08-12'],
  8: ['2018-08-15', '2018-08-25'],
  9: ['2019-08-15', '2019-08-25'],
  10: ['2021-10-07', '2021-10-17'],
  11: ['2022-10-08', '2022-10-30'],
  12: ['2023-10-12', '2023-10-29'],
  13: ['2024-09-04', '2024-09-15'],
  14: ['2025-09-04', '2025-09-14'],
  15: ['2026-08-13', '2026-08-23'],
  16: ['2027-08-12', '2027-08-22'],
};

/** 推演年份的 TI 默认月日（兜底表之外） */
const DEFAULT_TI_MONTH_DAY: [string, string] = ['08-15', '08-25'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(d: unknown): d is string {
  return typeof d === 'string' && DATE_RE.test(d) && Number.isFinite(parseDate(d));
}

/** TI 序号 → 年份（CONFIG TI_YEAR） */
export function tiYear(ti: number): number {
  const y = TI_YEAR[ti];
  if (y) return y;
  // 表外：TI1..9 = 2010+ti；TI10 起（2020 停办）= 2011+ti
  return ti < 10 ? 2010 + ti : 2011 + ti;
}

/** TI 正赛日期（优先 tis.json，缺失时用内置兜底表/推演） */
export function tiDates(ti: number): { startDate: string; endDate: string } {
  let start: string | null = null;
  let end: string | null = null;
  try {
    const info = getTiInfo(ti);
    if (isValidDate(info?.startDate)) start = info.startDate;
    if (isValidDate(info?.endDate)) end = info.endDate;
  } catch {
    // tis.json 尚无该届数据 → 兜底
  }
  if (!start) {
    const fb = FALLBACK_TI_DATES[ti];
    const y = tiYear(ti);
    start = fb ? fb[0] : `${y}-${DEFAULT_TI_MONTH_DAY[0]}`;
    if (!end) end = fb ? fb[1] : `${y}-${DEFAULT_TI_MONTH_DAY[1]}`;
  }
  if (!end || compareDate(end, start) <= 0) end = addDays(start, 1);
  return { startDate: start, endDate: end };
}

/** 赛季开始日：上届 TI endDate + seasonStartGapDays；TI1 赛季为 2011-03-01 */
export function seasonStartDate(ti: number): string {
  if (ti <= 1) return CONFIG.calendar.ti1SeasonStart;
  return addDays(tiDates(ti - 1).endDate, CONFIG.calendar.seasonStartGapDays);
}

function makeRound(index: number, phase: SeasonPhase, startDate: string, endDate: string): RoundInfo {
  return { index, phase, startDate, endDate, tournamentIds: [], patchVersions: [] };
}

/**
 * 建立回合表：0=preseason（日期=startDate），1..R=regular（startDate→TI 预选开始前线性切分），
 * R+1=ti_qualifier（TI startDate 前约 35 天），R+2=ti（TI startDate~endDate）。tournamentIds/patchVersions 先为空。
 */
export function buildRounds(ti: number, startDate: string, tiStartDate: string, tiEndDate: string): RoundInfo[] {
  void ti;
  const R = Math.max(1, Math.floor(CONFIG.calendar.regularRounds));
  // 预选回合起点；保证常规赛每回合至少 1 天，且各回合日期单调
  let qStart = addDays(tiStartDate, -CONFIG.calendar.tiQualifierLeadDays);
  const minRegularEnd = addDays(startDate, R);
  if (compareDate(qStart, minRegularEnd) < 0) qStart = minRegularEnd;
  const tiStart = compareDate(tiStartDate, qStart) > 0 ? tiStartDate : addDays(qStart, 1);
  const tiEnd = compareDate(tiEndDate, tiStart) > 0 ? tiEndDate : addDays(tiStart, 1);

  const totalDays = daysBetween(startDate, qStart);
  const rounds: RoundInfo[] = [makeRound(0, 'preseason', startDate, startDate)];
  let prev = startDate;
  for (let i = 1; i <= R; i++) {
    const end = i === R ? qStart : addDays(startDate, Math.round((i * totalDays) / R));
    rounds.push(makeRound(i, 'regular', prev, end));
    prev = end;
  }
  rounds.push(makeRound(R + 1, 'ti_qualifier', qStart, tiStart));
  rounds.push(makeRound(R + 2, 'ti', tiStart, tiEnd));
  return rounds;
}

/** 日期 → 常规赛回合序号（1..R，越界夹紧） */
export function roundIndexForDate(season: Season, date: string): number {
  let last = -1;
  for (const r of season.rounds ?? []) {
    if (r.phase !== 'regular') continue;
    last = r.index;
    if (date < r.endDate) return r.index;
  }
  if (last >= 1) return last;
  // 回合表缺失：按配置夹紧到 1
  return 1;
}

/** 任意日期 → 回合序号（0..total-1，用于版本映射；早于赛季开始 → 0） */
export function anyRoundIndexForDate(season: Season, date: string): number {
  const rounds = season.rounds ?? [];
  if (rounds.length === 0) return 0;
  if (compareDate(date, season.startDate) <= 0) return 0;
  for (const r of rounds) {
    if (r.index === 0) continue;
    if (date < r.endDate) return r.index;
  }
  return rounds[rounds.length - 1].index;
}

export function currentRound(state: GameState): RoundInfo {
  const rounds = state.season?.rounds ?? [];
  const r = rounds[state.roundIndex];
  if (r) return r;
  // 防御：回合表缺失或越界时返回一个与当前状态一致的临时回合
  return makeRound(state.roundIndex, state.phase, state.currentDate, state.currentDate);
}

/** 常规赛回合数 R */
export function regularRoundCount(season: Season): number {
  let n = 0;
  for (const r of season.rounds ?? []) if (r.phase === 'regular') n++;
  return n > 0 ? n : Math.max(1, Math.floor(CONFIG.calendar.regularRounds));
}

/** TI 预选回合序号（R+1） */
export function tiQualifierRoundIndex(season: Season): number {
  const r = (season.rounds ?? []).find((x) => x.phase === 'ti_qualifier');
  return r ? r.index : regularRoundCount(season) + 1;
}

/** TI 正赛回合序号（R+2，即最后一个回合） */
export function tiRoundIndex(season: Season): number {
  const r = (season.rounds ?? []).find((x) => x.phase === 'ti');
  return r ? r.index : regularRoundCount(season) + 2;
}

/** 本赛季 TI 赛事实例（id `ti-{n}`，缺失时按 tier 查找） */
export function findTiTournament(state: GameState): Tournament | null {
  const ti = state.season?.ti;
  const direct = state.tournaments[`ti-${ti}`];
  if (direct) return direct;
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (t && t.tier === 'ti' && t.season === ti) return t;
  }
  return null;
}

/**
 * 玩家在某回合参加的赛事：先按报名状态（schedule.playerTournamentInRound），
 * 再兜底检查本回合赛事的实际参赛名单（如经预选晋级 TI、报名状态未同步的情况）。
 */
export function playerTournamentForRound(state: GameState, roundIndex: number): Tournament | null {
  const t = playerTournamentInRound(state, roundIndex);
  if (t) return t;
  const me = state.settings?.playerTeamId;
  if (!me) return null;
  const round = state.season?.rounds?.[roundIndex];
  const ids = round?.tournamentIds ?? [];
  for (const id of ids) {
    const x = state.tournaments[id];
    if (!x || x.playerStatus === 'declined') continue;
    if (x.teamIds.includes(me) || x.qualifierTeamIds.includes(me)) return x;
  }
  if (round?.phase === 'ti') {
    const tiT = findTiTournament(state);
    if (tiT && tiT.teamIds.includes(me)) return tiT;
  }
  return null;
}

/**
 * 赛事实际上没有进行：已结束却没有任何阶段与名次
 * （参赛队伍不足被主办方取消；TI 赛区预选报名队伍不超过名额、全部直通 TI）。
 * 这样的回合对玩家而言是休赛回合（可训练、回合结束时自动训练）。
 */
export function tournamentNeverPlayed(t: Tournament): boolean {
  return t.status === 'finished' && !(t.placements?.length) && !(t.stages?.length);
}

/** 玩家视角的回合类型 */
export function roundKindForPlayer(
  state: GameState,
  roundIndex: number,
): 'preseason' | 'rest' | 'tournament' | 'ti_qualifier' | 'ti' | 'ti_watch' {
  const round = state.season?.rounds?.[roundIndex];
  if (!round) return roundIndex === 0 ? 'preseason' : 'rest';
  switch (round.phase) {
    case 'preseason':
      return 'preseason';
    case 'regular': {
      const t = playerTournamentForRound(state, roundIndex);
      return t && !tournamentNeverPlayed(t) ? 'tournament' : 'rest';
    }
    case 'ti_qualifier': {
      const q = playerTournamentForRound(state, roundIndex);
      if (q) return tournamentNeverPlayed(q) ? 'rest' : 'ti_qualifier';
      // 预选赛尚未建立（未到该回合）→ 先展示为「TI 预选」；已建立且玩家不参加（直邀/无名额）→ 休赛
      return state.roundIndex >= roundIndex ? 'rest' : 'ti_qualifier';
    }
    case 'ti': {
      if (playerTournamentForRound(state, roundIndex)) return 'ti';
      if (state.roundIndex >= roundIndex) return 'ti_watch';
      if (state.roundIndex === roundIndex - 1) {
        // 预选回合中：玩家未参加预选，或预选已结束仍未进入 TI 名单 → 观赛
        const q = playerTournamentForRound(state, roundIndex - 1);
        if (!q || q.status === 'finished') return 'ti_watch';
      }
      return 'ti';
    }
    default:
      return 'rest';
  }
}

/** 回合类型中文标签 */
export const ROUND_KIND_LABEL: Record<ReturnType<typeof roundKindForPlayer>, string> = {
  preseason: '赛季初',
  rest: '休赛回合',
  tournament: '赛事回合',
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  ti_watch: 'TI 观赛',
};
