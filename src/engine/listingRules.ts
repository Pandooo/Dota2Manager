// 挂牌期规则（纯函数，只依赖 CONFIG）：squadOps 的挂牌逻辑与 market 的合同到期提示共用，避免 squadOps ↔ market 循环引用。
// 用户需求 2026-10-12：「队员挂牌到解约持续一整个赛季，而不是三个回合」。
import type { GameState, Player, Team, TransferListing } from './types';
import { CONFIG } from './config';
import { clamp, ownEntry } from './util';

/** 挂牌规则版本：2 = 整赛季挂牌；缺失 = 旧存档的「3 个转会回合」挂牌 */
export const LISTING_RULE_VERSION = 2;

/**
 * 每赛季的挂牌倒计时回合数 = 常规赛回合数（CONFIG.calendar.regularRounds）。
 * 转会窗口开放的回合是赛季初 + 常规赛，但赛季初没有回合结算（game.advanceRound 从赛季初直接进入第 1 回合），
 * 所以倒计时在每个常规赛回合结束时走一格；TI 预选 / 正赛转会锁定期间暂停。按此计数，挂牌在下赛季的同一时间点到期。
 */
export function listingRoundsPerSeason(): number {
  const r = Math.floor(CONFIG.calendar.regularRounds);
  return Number.isFinite(r) && r >= 1 ? r : 1;
}

/** 新挂牌的挂牌期（倒计时回合数）= listingSeasons × 每赛季倒计时回合数 */
export function listingDurationRounds(): number {
  const seasons = CONFIG.squadOps.listingSeasons;
  return Math.max(1, Math.round((Number.isFinite(seasons) && seasons > 0 ? seasons : 1) * listingRoundsPerSeason()));
}

/** 挂牌期说明（操作提示 / 新闻 / 界面共用），如「一整个赛季（18 个转会回合，TI 锁定期间暂停）」 */
export function listingDurationLabel(): string {
  const seasons = CONFIG.squadOps.listingSeasons;
  const head = !(Number.isFinite(seasons) && seasons > 0) || seasons === 1 ? '一整个赛季' : `${seasons} 个赛季`;
  return `${head}（${listingDurationRounds()} 个转会回合，TI 锁定期间暂停）`;
}

/** 挂牌进度：剩余 / 总倒计时回合、已经历的出价机会次数 */
export interface ListingProgress {
  roundsLeft: number;
  totalRounds: number;
  bidRolls: number;
}

/**
 * 挂牌进度（纯函数，不修改挂牌；界面显示、合同到期提示与 squadOps.migrateListing 共用）。
 * 旧存档的 3 回合挂牌按已经过的回合换算到新挂牌期：剩余 = 新挂牌期 - 已过回合（旧规则每个计时回合都是一次出价机会）。
 */
export function listingProgress(L: TransferListing): ListingProgress {
  const full = listingDurationRounds();
  if (L.v === LISTING_RULE_VERSION) {
    const total = Number.isFinite(L.totalRounds) && (L.totalRounds as number) > 0 ? Math.round(L.totalRounds as number) : full;
    // 数据损坏的剩余回合：按完整挂牌期处理（宁可多等，也不因坏数据立即解约）
    const left = Number.isFinite(L.roundsLeft) ? L.roundsLeft : total;
    const rolls = Number.isFinite(L.bidRolls) && (L.bidRolls as number) >= 0
      ? Math.floor(L.bidRolls as number)
      : clamp(total - left, 0, total);
    return { roundsLeft: left, totalRounds: total, bidRolls: rolls };
  }
  const old = Math.max(1, Math.round(CONFIG.squadOps.legacyListingRounds));
  const oldLeft = Number.isFinite(L.roundsLeft) ? L.roundsLeft : old;
  const elapsed = clamp(Math.round(old - oldLeft), 0, old);
  return { roundsLeft: Math.max(1, full - elapsed), totalRounds: full, bidRolls: elapsed };
}

/**
 * 挂牌时钟：到当前时刻为止已走过的倒计时回合数（每个常规赛回合结束时 +1；赛季初与 TI 阶段不走）。
 * 只用于比较两个时刻之间隔了多少个转会回合（撤牌记忆 Player.listingStaleMemo）。
 */
export function listingClock(state: GameState): number {
  const R = listingRoundsPerSeason();
  const ti = Number.isFinite(state.season?.ti) ? (state.season.ti as number) : 0;
  const r = Number.isFinite(state.roundIndex) ? state.roundIndex : 0;
  return ti * R + clamp(r - 1, 0, R);
}

/** 挂牌时间说明（界面用）：「TI9 第 6 回合挂牌」/「TI9 赛季初挂牌」 */
export function listingListedAtLabel(L: Pick<TransferListing, 'season' | 'listedRound'>): string {
  const r = Number.isFinite(L.listedRound) ? Math.floor(L.listedRound) : 0;
  return r > 0 ? `TI${L.season} 第 ${r} 回合挂牌` : `TI${L.season} 赛季初挂牌`;
}

/** 某个（TI 序号, 回合）时刻的挂牌时钟读数（与 listingClock 同口径：赛季初 = 第 1 回合） */
export function listingClockAt(ti: number, round: number): number {
  const R = listingRoundsPerSeason();
  const t = Number.isFinite(ti) ? ti : 0;
  const r = Number.isFinite(round) ? round : 0;
  return t * R + clamp(r - 1, 0, R);
}

/** 抽卡新秀转售冷却的回合数（CONFIG.gacha.resaleHoldRounds；非法值或 ≤ 0 = 不限制） */
export function gachaResaleHoldRounds(): number {
  const n = Math.floor(Number(CONFIG.gacha.resaleHoldRounds) || 0);
  return n > 0 ? n : 0;
}

/**
 * 抽卡新秀的转售冷却（CONFIG.gacha.resaleHoldRounds，2026-10-14 审查）：本队抽到（或按真实出道去向加盟本队）的新秀仍在本队、
 * 入队不满 resaleHoldRounds 个转会回合时返回剩余回合数（> 0），否则 0。冷却期内不能挂牌、不接 AI 随机求购，交易抵价按签字费比例估值。
 */
export function gachaResaleLockLeft(state: GameState, p: Pick<Player, 'gacha' | 'teamId'> | null | undefined): number {
  const g = p?.gacha;
  const hold = gachaResaleHoldRounds();
  if (!g || hold <= 0 || !p?.teamId || g.teamId !== p.teamId) return 0;
  const left = hold - (listingClock(state) - listingClockAt(g.ti, g.round));
  return left > 0 ? left : 0;
}

/** 转售冷却的说明（挂牌按钮 / 失败提示）；不在冷却期返回 null */
export function gachaResaleLockText(state: GameState, p: Pick<Player, 'gacha' | 'teamId' | 'handle'> | null | undefined): string | null {
  const left = gachaResaleLockLeft(state, p);
  if (!left || !p) return null;
  const hold = gachaResaleHoldRounds();
  return `${p.handle} 是本队抽卡得到的新秀，入队满 ${hold} 个转会回合（约一个赛季）后才能挂牌出售（还差 ${left} 个转会回合）`;
}

/**
 * 转售冷却的简短说明（阵容页批量挂牌的跳过原因）：「入队 6 / 18 个转会回合（抽卡新秀）」——与加盟门槛的简短说明同一格式、同一读数；不在冷却期返回 null
 */
export function gachaResaleLockBrief(state: GameState, p: Pick<Player, 'gacha' | 'teamId'> | null | undefined): string | null {
  const left = gachaResaleLockLeft(state, p);
  if (!left) return null;
  const hold = gachaResaleHoldRounds();
  return `入队 ${hold - left} / ${hold} 个转会回合（抽卡新秀）`;
}

// ---------------------------------------------------------------------------
// 随队场数门槛（CONFIG.squadOps.listingMinTeamMatches，【用户指定】2026-10-15：
// 「增加签自由选手直接卖的难度，如果随队战绩10场以内，不需要上场，则无法挂牌」）
// ---------------------------------------------------------------------------

/** 挂牌所需的随队场数（CONFIG.squadOps.listingMinTeamMatches；非法值或 ≤ 0 = 不限制） */
export function listingMinTeamMatches(): number {
  const n = Math.floor(Number(CONFIG.squadOps.listingMinTeamMatches));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 战队累计完成的系列赛场数（Team.seriesCount，tournament.recordSeriesResult 计数；缺失 = 0） */
export function teamSeriesCount(team: Pick<Team, 'seriesCount'> | null | undefined): number {
  const n = team?.seriesCount;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 选手加盟当前战队后，该战队已完成的系列赛场数（不要求本人上场）。
 * 无记录（开局阵容 / 旧存档中已在队的选手 / 自由选手 / 数据损坏）返回 null —— 视为已满足门槛。
 * 起点大于战队当前的累计场数也按损坏处理（正常对局中起点取自加盟时的累计场数、累计场数只增不减，
 * 只有改动 / 拼接过的存档才会出现；否则选手会被锁到战队场数追上为止）。
 */
export function teamMatchesSinceJoin(
  state: GameState, p: Pick<Player, 'teamId' | 'joinedTeamSeries'> | null | undefined,
): number | null {
  if (!p?.teamId) return null;
  const mark = p.joinedTeamSeries;
  if (typeof mark !== 'number' || !Number.isFinite(mark)) return null;
  const team = ownEntry(state.teams, p.teamId);
  if (!team) return null;
  const now = teamSeriesCount(team);
  const start = Math.max(0, Math.floor(mark));
  return start > now ? null : now - start;
}

/** 随队场数还差几场才能挂牌（> 0 = 不能挂牌、AI 不主动求购）；无记录或已满返回 0 */
export function listingMatchLockLeft(
  state: GameState, p: Pick<Player, 'teamId' | 'joinedTeamSeries'> | null | undefined,
): number {
  const min = listingMinTeamMatches();
  if (!min) return 0;
  const n = teamMatchesSinceJoin(state, p);
  return n === null || n >= min ? 0 : min - n;
}

// ---------------------------------------------------------------------------
// 入队转会回合门槛（CONFIG.squadOps.listingMinTransferRounds，【用户指定】2026-10-15「再加入队满 6 个转会回合」）：
// 与随队场数门槛同时生效，两个条件都满足才能挂牌、AI 才会主动求购。计时与抽卡转售冷却 / 交易抵价「刚签下」同一时钟（listingClock）。
// ---------------------------------------------------------------------------

/** 挂牌所需的入队转会回合数（CONFIG.squadOps.listingMinTransferRounds；非法值或 ≤ 0 = 不限制） */
export function listingMinTransferRounds(): number {
  const n = Math.floor(Number(CONFIG.squadOps.listingMinTransferRounds));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 选手加盟当前战队后经过的转会回合数 = 当前挂牌时钟 − 加盟时的时钟（Player.joinedTeamClock）：每个常规赛回合结束时 +1，
 * 赛季初与 TI 预选 / 正赛转会锁定期间不计（与 gachaResaleLockLeft、trade 的 freeAgentHoldRounds 同一时钟）。
 * 无记录（开局阵容 / 旧存档中已在队的选手 / 自由选手 / 数据损坏）返回 null —— 视为已满足门槛；
 * 起点晚于当前时钟同样按损坏处理（时钟只增不减，只有改动 / 拼接过的存档才会出现）。
 */
export function transferRoundsSinceJoin(
  state: GameState, p: Pick<Player, 'teamId' | 'joinedTeamClock'> | null | undefined,
): number | null {
  if (!p?.teamId) return null;
  const mark = p.joinedTeamClock;
  if (typeof mark !== 'number' || !Number.isFinite(mark)) return null;
  const now = listingClock(state);
  const start = Math.max(0, Math.floor(mark));
  return start > now ? null : now - start;
}

/** 入队转会回合还差几个才能挂牌（> 0 = 不能挂牌、AI 不主动求购）；无记录或已满返回 0 */
export function listingRoundLockLeft(
  state: GameState, p: Pick<Player, 'teamId' | 'joinedTeamClock'> | null | undefined,
): number {
  const min = listingMinTransferRounds();
  if (!min) return 0;
  const n = transferRoundsSinceJoin(state, p);
  return n === null || n >= min ? 0 : min - n;
}

/**
 * 抽卡新秀（含按真实出道去向签下的真实新秀）挂牌条件的说明（抽卡页规则与「真实新秀」待决事件共用）：抽卡转售冷却与加盟门槛叠加，
 * 入队转会回合取两者中较长的——「入队满 18 个转会回合（约一个赛季；其他新加盟选手为 6 个）且随队满 10 场比赛」；没有任何限制时为空串。
 */
export function gachaListingRuleText(): string {
  const hold = gachaResaleHoldRounds();
  const minRounds = listingMinTransferRounds();
  const minMatches = listingMinTeamMatches();
  const rounds = Math.max(hold, minRounds);
  const parts: string[] = [];
  if (rounds > 0) {
    const notes: string[] = [];
    if (rounds === listingRoundsPerSeason()) notes.push('约一个赛季');
    if (minRounds > 0 && rounds > minRounds) notes.push(`其他新加盟选手为 ${minRounds} 个`);
    parts.push(`入队满 ${rounds} 个转会回合${notes.length ? `（${notes.join('；')}）` : ''}`);
  }
  if (minMatches > 0) parts.push(`随队满 ${minMatches} 场比赛`);
  return parts.join('且');
}

// ---------------------------------------------------------------------------
// 加盟门槛（随队场数 + 入队转会回合，两个条件都满足才能挂牌；挂牌、AI 主动求购、交易抵价估值共用）
// ---------------------------------------------------------------------------

type JoinLockFields = Pick<Player, 'teamId' | 'joinedTeamSeries' | 'joinedTeamClock' | 'gacha'>;

/**
 * 加盟门槛的进度：随队场数 / 入队转会回合（null = 无记录，视为已满足）、门槛值（0 = 不限制）与还差多少。
 * `locked` 只看加盟门槛本身（就是 listingJoinLocked）。门槛未满足、且选手是仍在转售冷却中的本队抽卡新秀时，入队转会回合一项改报两者中还差更多的那个
 * （默认冷却 18 个 ≥ 门槛 6 个，同一时钟、同一起点）：rounds / minRounds / roundLeft 取冷却的读数，`gachaHold` = true。
 * 这样说明与进度条显示的是真正还要等的回合数，门槛满足后接着显示的转售冷却说明（gachaResaleLockText）从同一个数继续倒数，
 * 不会从「还差 1 个转会回合」跳到「还差 12 个转会回合」。
 */
export interface ListingJoinLock {
  locked: boolean;
  matches: number | null;
  minMatches: number;
  matchLeft: number;
  rounds: number | null;
  minRounds: number;
  roundLeft: number;
  /** 入队转会回合一项显示的是抽卡新秀的转售冷却（CONFIG.gacha.resaleHoldRounds），不是加盟门槛本身 */
  gachaHold: boolean;
}

/**
 * 是否处于加盟门槛中（随队场数或入队转会回合任一未满足）。挂牌（resaleLockText / listingJoinLock）、AI 主动求购（resaleLocked）
 * 与交易抵价估值（trade.ts）共用这一个判断。
 */
export function listingJoinLocked(state: GameState, p: JoinLockFields | null | undefined): boolean {
  return listingMatchLockLeft(state, p) > 0 || listingRoundLockLeft(state, p) > 0;
}

export function listingJoinLock(state: GameState, p: JoinLockFields | null | undefined): ListingJoinLock {
  const minMatches = listingMinTeamMatches();
  const minRounds = listingMinTransferRounds();
  const L: ListingJoinLock = {
    locked: listingJoinLocked(state, p),
    matches: minMatches ? teamMatchesSinceJoin(state, p) : null,
    minMatches,
    matchLeft: listingMatchLockLeft(state, p),
    rounds: minRounds ? transferRoundsSinceJoin(state, p) : null,
    minRounds,
    roundLeft: listingRoundLockLeft(state, p),
    gachaHold: false,
  };
  if (L.locked) {
    const gachaLeft = gachaResaleLockLeft(state, p);
    if (gachaLeft > L.roundLeft) {
      const hold = gachaResaleHoldRounds();
      L.rounds = hold - gachaLeft;
      L.minRounds = hold;
      L.roundLeft = gachaLeft;
      L.gachaHold = true;
    }
  }
  return L;
}

/** 说明用的片段：有记录的条件逐项列出（进度 / 门槛 / 还差）；抽卡新秀的入队转会回合按转售冷却报（见 ListingJoinLock） */
function joinLockPhrases(L: ListingJoinLock): { progress: string[]; need: string[]; missing: string[]; brief: string[] } {
  const progress: string[] = [];
  const need: string[] = [];
  const missing: string[] = [];
  const brief: string[] = [];
  if (L.minMatches > 0 && L.matches !== null) {
    progress.push(`随队 ${L.matches} 场`);
    need.push(`随队满 ${L.minMatches} 场`);
    brief.push(`随队 ${L.matches} / ${L.minMatches} 场`);
    if (L.matchLeft > 0) missing.push(`${L.matchLeft} 场`);
  }
  if (L.minRounds > 0 && L.rounds !== null) {
    progress.push(`入队 ${L.rounds} 个转会回合`);
    need.push(`入队满 ${L.minRounds} 个转会回合${L.gachaHold ? '（本队抽卡得到的新秀）' : ''}`);
    brief.push(`入队 ${L.rounds} / ${L.minRounds} 个转会回合${L.gachaHold ? '（抽卡新秀）' : ''}`);
    if (L.roundLeft > 0) missing.push(`${L.roundLeft} 个转会回合`);
  }
  return { progress, need, missing, brief };
}

/**
 * 加盟门槛未满足时挂牌失败的说明（单个 / 批量挂牌）：
 * 「X 加盟后随队 4 场、入队 2 个转会回合，需随队满 10 场且入队满 6 个转会回合才能挂牌（还差 6 场、4 个转会回合）」；满足时 null。
 * 仍在转售冷却中的本队抽卡新秀按冷却报回合：「……需随队满 10 场且入队满 18 个转会回合（本队抽卡得到的新秀）才能挂牌（还差 6 场、16 个转会回合）」
 */
export function listingJoinLockText(
  state: GameState, p: (JoinLockFields & Pick<Player, 'handle'>) | null | undefined,
): string | null {
  if (!p) return null;
  const L = listingJoinLock(state, p);
  if (!L.locked) return null;
  const f = joinLockPhrases(L);
  return `${p.handle} 加盟后${f.progress.join('、')}，需${f.need.join('且')}才能挂牌（还差 ${f.missing.join('、')}）`;
}

/** 挂牌按钮禁用时的提示：「随队满 10 场且入队满 6 个转会回合后可挂牌（已随队 4 场、入队 2 个转会回合）」；满足时 null */
export function listingJoinLockTitle(state: GameState, p: JoinLockFields | null | undefined): string | null {
  if (!p) return null;
  const L = listingJoinLock(state, p);
  if (!L.locked) return null;
  const f = joinLockPhrases(L);
  return `${f.need.join('且')}后可挂牌（已${f.progress.join('、')}）`;
}

/** 批量挂牌跳过原因的简短说明：「随队 4 / 10 场、入队 2 / 6 个转会回合」（抽卡新秀「入队 2 / 18 个转会回合（抽卡新秀）」）；满足时 null */
export function listingJoinLockBrief(state: GameState, p: JoinLockFields | null | undefined): string | null {
  if (!p) return null;
  const L = listingJoinLock(state, p);
  return L.locked ? joinLockPhrases(L).brief.join('、') : null;
}

/**
 * 转售限制（挂牌与 AI 主动求购共用）：加盟门槛（随队场数 / 入队转会回合）未满足，或抽卡新秀转售冷却中。
 * 返回失败说明（加盟门槛优先；门槛说明里抽卡新秀的回合数已按冷却报，门槛满足后冷却说明从同一个数继续倒数），不受限时 null。
 */
export function resaleLockText(
  state: GameState, p: (JoinLockFields & Pick<Player, 'handle' | 'gacha'>) | null | undefined,
): string | null {
  return listingJoinLockText(state, p) ?? gachaResaleLockText(state, p);
}

/** 是否处于转售限制中（不能挂牌、AI 不主动求购：普通随机求购 / 休赛期求购 / 使命求购 / 挖角） */
export function resaleLocked(
  state: GameState, p: (JoinLockFields & Pick<Player, 'gacha'>) | null | undefined,
): boolean {
  return listingJoinLocked(state, p) || gachaResaleLockLeft(state, p) > 0;
}
