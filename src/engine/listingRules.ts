// 挂牌期规则（纯函数，只依赖 CONFIG）：squadOps 的挂牌逻辑与 market 的合同到期提示共用，避免 squadOps ↔ market 循环引用。
// 用户需求 2026-10-12：「队员挂牌到解约持续一整个赛季，而不是三个回合」。
import type { GameState, Player, TransferListing } from './types';
import { CONFIG } from './config';
import { clamp } from './util';

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

/**
 * 抽卡新秀的转售冷却（CONFIG.gacha.resaleHoldRounds，2026-10-14 审查）：本队抽到（或按真实出道去向加盟本队）的新秀仍在本队、
 * 入队不满 resaleHoldRounds 个转会回合时返回剩余回合数（> 0），否则 0。冷却期内不能挂牌、不接 AI 随机求购，交易抵价按签字费比例估值。
 */
export function gachaResaleLockLeft(state: GameState, p: Pick<Player, 'gacha' | 'teamId'> | null | undefined): number {
  const g = p?.gacha;
  const hold = Math.floor(Number(CONFIG.gacha.resaleHoldRounds) || 0);
  if (!g || hold <= 0 || !p?.teamId || g.teamId !== p.teamId) return 0;
  const left = hold - (listingClock(state) - listingClockAt(g.ti, g.round));
  return left > 0 ? left : 0;
}

/** 转售冷却的说明（挂牌按钮 / 失败提示）；不在冷却期返回 null */
export function gachaResaleLockText(state: GameState, p: Pick<Player, 'gacha' | 'teamId' | 'handle'> | null | undefined): string | null {
  const left = gachaResaleLockLeft(state, p);
  if (!left || !p) return null;
  const hold = Math.floor(Number(CONFIG.gacha.resaleHoldRounds) || 0);
  return `${p.handle} 是本队抽卡得到的新秀，入队满 ${hold} 个转会回合（约一个赛季）后才能挂牌出售（还差 ${left} 个转会回合）`;
}
