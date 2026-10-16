// 真实选手入场自由市场的公平窗口（v0.4.3，用户反馈「新开的一轮 Wings 主队的游戏中，Ceb 一直到 TI9 都检索不到」）
//
// 未被抽走的真实新秀（gacha.releaseRealRookieCards，第 1 回合开始前）与赛季初入场的复出 / 新面孔真实选手（realEntry.ts）
// 以自由身进入自由市场时记下入场的 {TI 序号, 回合}（Player.marketEntry）。入场的回合内 AI 战队不从自由市场签下他们
// （AI 签约自由选手 / 补员的入口：market.pickAffordableFreeAgent、missions.aiPursueMission、shuffle 的使命引进与自由选手候选），
// 人类玩家可以立即签约（多人模式所有座位相同、先到先得）。入场的下一回合结束时由 AI 接手一次（entryPass.ts，【用户指定】
// 「要，且真实战队优先」：当届真实战队优先签回，否则按 AI 平常的需求签下；之后清除入场时刻），人类玩家在那之前仍可以先签——
// 下一回合内、接手之前 AI 的其他签约途径同样不签（该回合恰好是赛季中期转会窗口、或 AI 卖人后补员时，不抢在人类玩家与接手之前）。
// 加盟任何战队时清除（team.addPlayerToTeam）。
// 转会窗口锁定（TI 预选 / TI / 赛季结束）时入场的（读档迁移、旧卡池关闭、TI 期间解除主教练职务）：人类玩家此时也签不了，
// 入场时刻记为下个赛季初（{TI + 1, 0}），公平窗口留到窗口重新开放的那个回合（休赛期转会潮与 AI 季前窗口都不签），第 1 回合结束时 AI 接手。
// 本赛季新成立的真实俱乐部签回自家出道新秀（clubs.signFoundedClubRookies）保持原规则。
// 只比较全局的赛季 / 回合序号：不消耗随机数，多人模式与座位无关。
import { CONFIG } from './config';
import type { GameState, Player } from './types';

/** 转会窗口是否锁定（TI 预选 / TI / 赛季结束；同 market.isTransferWindowOpen 的反面，缺失阶段按开放处理） */
function windowLocked(state: GameState): boolean {
  return state.phase === 'ti_qualifier' || state.phase === 'ti' || state.phase === 'season_end';
}

function finiteOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 记下入场时刻：转会窗口开放时为当前赛季 / 回合；窗口锁定时为下个赛季初 {TI + 1, 0}（窗口重新开放的回合）。
 */
export function markMarketEntry(state: GameState, p: Player): void {
  const ti = finiteOr0(state.season?.ti);
  p.marketEntry = windowLocked(state) ? { ti: ti + 1, round: 0 } : { ti, round: finiteOr0(state.roundIndex) };
}

/** 是否仍在入场的回合内（自由选手） */
export function inMarketEntryRound(state: GameState, p: Pick<Player, 'marketEntry' | 'teamId'> | null | undefined): boolean {
  const e = p?.marketEntry;
  if (!e || p.teamId) return false;
  return e.ti === state.season?.ti && e.round === state.roundIndex;
}

/** 新入场标记：'now' 入场的回合内 / 'pass' 入场的下一回合（本回合结束时 AI 接手）/ 'next' 下个赛季初才开始公平窗口 */
export type MarketEntryStatus = 'now' | 'pass' | 'next';

/**
 * 自由选手列表的「新入场」标记：'now' = 入场的回合内（AI 战队本回合不签）；'pass' = 入场回合已过去、本回合结束时 AI 接手
 * （entryPass.ts，转会窗口开放且开关打开时）；'next' = 转会窗口锁定期间入场、公平窗口在下个赛季初（窗口重新开放的回合）；其余 null。
 */
export function marketEntryStatus(state: GameState, p: Pick<Player, 'marketEntry' | 'teamId'> | null | undefined): MarketEntryStatus | null {
  const e = p?.marketEntry;
  if (!e || p.teamId) return null;
  if (inMarketEntryRound(state, p)) return 'now';
  const ti = state.season?.ti;
  if (typeof ti !== 'number') return null;
  if (e.ti > ti) return 'next';
  if (e.ti === ti && e.round < state.roundIndex && CONFIG.realEntry?.aiPass && !windowLocked(state)) return 'pass';
  return null;
}

/**
 * AI 战队本回合不能从自由市场签下他（人类玩家不受限；开关 CONFIG.realEntry.aiHoldEntryRound）：入场的回合内；
 * 以及入场的下一回合、本回合结束时 AI 接手之前（'pass'，CONFIG.realEntry.aiPass 打开时）——接手是 AI 的第一次机会，
 * 赛季中期转会窗口（enterRound）、补员等其他途径不抢在人类玩家与接手之前。
 */
export function aiSigningHeld(state: GameState, p: Pick<Player, 'marketEntry' | 'teamId'> | null | undefined): boolean {
  if (!CONFIG.realEntry?.aiHoldEntryRound) return false;
  return inMarketEntryRound(state, p) || marketEntryStatus(state, p) === 'pass';
}

/** 当届真实战队由玩家执教时没有优先（entryPass 第 1 步只给 AI 战队），新闻里提醒一句 */
const HUMAN_HOME = '；真实战队由玩家执教时不会自动签回，需要自己签';

/**
 * 新闻 / 通知里公平窗口的说明（按当前转会窗口是否开放；n = 人数）。开关关闭时为空串。
 * 入场的下一回合结束时 AI 接手（CONFIG.realEntry.aiPass，entryPass.ts）：当届真实战队优先。
 */
export function marketEntryNote(state: GameState, n: number): string {
  if (!CONFIG.realEntry?.aiHoldEntryRound || n <= 0) return '';
  const who = n === 1 ? '他' : '他们';
  const pass = CONFIG.realEntry?.aiPass;
  if (windowLocked(state)) {
    return `转会窗口锁定中，下个赛季初窗口开放的那个回合 AI 战队不会签下${who}（休赛期转会潮与 AI 季前转会都不签），你可以先签`
      + (pass ? `；第 1 回合结束时 AI 战队会尝试签约（当届真实战队优先${HUMAN_HOME}）。` : '。');
  }
  return `入场的这个回合 AI 战队不会签下${who}，你可以先签`
    + (pass ? `；下一回合结束时 AI 战队会尝试签约（当届真实战队优先${HUMAN_HOME}），在那之前你仍可以先签。` : '；之后 AI 战队也可以签约（多在赛季中期转会窗口与下个休赛期）。');
}

/** 赛季初清理过期的入场时刻（已加盟战队的、往届的；下个赛季初才生效的保留）。不消耗随机数 */
export function pruneMarketEntries(state: GameState): void {
  const ti = state.season?.ti;
  for (const id in state.players ?? {}) {
    const p = state.players[id];
    const e = p?.marketEntry;
    if (e && (p.teamId || typeof ti !== 'number' || !(e.ti >= ti))) delete p.marketEntry;
  }
}
