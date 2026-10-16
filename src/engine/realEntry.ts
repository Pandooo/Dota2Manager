// 真实选手入场自由市场（v0.4.3）
//
// 用户反馈（2026-10-16）：「新开的一轮 Wings 主队的游戏中，Ceb 一直到 TI9 都检索不到，怎么回事？其实 Topson TI8 的中途才能检索到，
// 是不是新秀如果没人抽到就不会上场？那稍作修改，真实新秀如果没抽到则直接上场到自由市场中」
// 原因：
//   (a) 开局之后，本局只会再加入两类真实选手——本届新秀（经由抽卡卡池）与新成立的真实俱乐部签回的当届选手（clubs.bringBackRealPlayer）。
//       不是新秀、又不在开局届阵容数据里的真实选手（如 TI6 开局时 Ceb：TI2–TI5 是选手，TI6–TI7 是 OG 教练，TI8 起重返赛场）永远不会进入本局。
//   (b) 未被抽走的真实新秀在第 1 回合开始前才离池、按真实出道去向加盟，所以 Topson 到 TI8 第 1 回合才出现。
// 处理：
//   1. 【用户指定】未被抽走的真实新秀以自由身进入自由市场（gacha.releaseRealRookieCards）。
//   2. 复出 / 新面孔（seasonRealReturners，season.startSeason：新俱乐部成立与卡池建立之后、AI 休赛期转会之前）：当届真实阵容数据
//      （trajectories.json，含球队与自由选手）里有、本局中还没有出现过的真实选手（playerIndex.firstTi < 当届，即不是本届新秀；
//      不在待登场新秀名单中）按当届真实水平与位置（clubs.bringBackRealPlayer）以自由身进入自由市场。当届数据里没有他（退役 / 缺席）的不入场。
//      与他同 id 的真实教练（阵容数据中他那几届是教练，如 Ceb 在 TI6–7 执教 OG；sameIdCoach.ts）：自由教练 → 删除教练记录；在 AI 战队执教 → 卸任
//      （读档迁移时该队随即补签一名主教练；赛季初由 AI 季前窗口照常聘请）；在人类玩家战队执教 → 不替玩家做决定，继续执教、暂不入场（新闻注明）；
//      玩家解除其主教练职务时（realEntryAfterCoachRelease）他随即入场（本届新秀以未被抽走的真实新秀身份入场）。
//   3. 公平窗口（marketEntry.ts）：以 1 / 2 入场的选手在入场的回合内不会被 AI 战队从自由市场签下，人类玩家可以立即签约；入场的下一回合结束时
//      AI 接手一次（entryPass.ts：当届真实战队优先签回，否则按 AI 需求）。转会窗口锁定时入场的，公平窗口留到下个赛季初窗口开放的回合。
//   4. 旧存档 / 旧房间（migrateRealEntry，save.upgradeLoadedState / multi.migrateRoomState；按 GameState.realEntryVersion 只执行一次）：
//      按 2 补录当届缺失的真实选手；待决的「真实新秀希望加盟」事件（rookie_home）改为该新秀直接进入自由市场。
// 与新俱乐部成立（clubs.foundRealClub 先签回自家当届选手）、v0.4.2 复出（realCareer.ts：已退役的真实选手）不重复：
// 这里只处理 state.players 中不存在的 id。不消耗随机数（遍历按 id 排序）。
import { CONFIG, POSITION_LABEL } from './config';
import { getPlayerIndex, getTrajectories, getTrajectory } from '../data/index';
import { addNews, pushPopup } from './news';
import { playerTier, tierIndex } from './player';
import { bringBackRealPlayer } from './clubs';
import { coachEmployer, lastRealTi } from './realCareer';
import { realDebutTier, releaseRealRookieToMarket } from './gacha';
import { markMarketEntry, marketEntryNote } from './marketEntry';
import { resolveSameIdCoach } from './sameIdCoach';
import {
  allPendingDecisions, humanTeamIds, inSeatOf, isMultiplayer, removePendingDecisionsEverywhere, seatInPlay,
} from './seat';
import { syncSynergies } from './synergy';
import type { Coach, GameState, PlayerIndexEntry, Tier } from './types';
import { TIERS } from './types';
import { ownEntry } from './util';

/** 入场迁移的版本：新游戏创建时写入（game.createBlankState），旧存档缺失 / 落后时在读档迁移中执行一次 */
export const REAL_ENTRY_VERSION = 1;

const hasOwn = (o: object | null | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// 静态数据（首次查询时建索引）
// ---------------------------------------------------------------------------

let INDEX: Map<string, PlayerIndexEntry> | null = null;
function indexEntry(id: string): PlayerIndexEntry | undefined {
  if (!INDEX) {
    INDEX = new Map();
    try {
      for (const e of getPlayerIndex() ?? []) if (e?.id) INDEX.set(e.id, e);
    } catch {
      /* 无索引（测试替身等）：没有可入场的真实选手 */
    }
  }
  return INDEX.get(id);
}

const IDS_AT = new Map<number, string[]>();
/** 某届真实阵容数据（球队 + 自由选手）中的全部真实选手 id（按 id 排序） */
export function realRosterIdsAt(ti: number): string[] {
  const hit = IDS_AT.get(ti);
  if (hit) return hit;
  const out: string[] = [];
  try {
    const all = getTrajectories() ?? {};
    for (const id of Object.keys(all)) if (all[id]?.[ti]) out.push(id);
  } catch {
    /* 无数据 */
  }
  out.sort();
  IDS_AT.set(ti, out);
  return out;
}

/** 转会窗口是否开放（同 market.isTransferWindowOpen；不直接引用 market） */
function transferWindowOpen(state: GameState): boolean {
  return state.phase === 'preseason' || state.phase === 'regular';
}

/**
 * 入场资格：本局中没有这个 id、不是待登场新秀（futureRookies，含卡池中的真实新秀卡）、不是本届新秀（playerIndex.firstTi < ti），
 * 当届真实阵容数据中有他；转会窗口已关闭（TI 预选 / TI 阶段）时还要求真实生涯在当届之后仍在继续（当届 TI 前已无法签约，结算时又不受保护）。
 */
export function realEntryEligible(state: GameState, id: string, ti: number): boolean {
  if (!id || !Number.isFinite(ti) || hasOwn(state.players, id) || hasOwn(state.futureRookies, id)) return false;
  const e = indexEntry(id);
  if (!e || !(Number(e.firstTi) < ti)) return false;
  let point;
  try {
    point = getTrajectory(id)?.[ti];
  } catch {
    point = undefined;
  }
  if (!point) return false;
  if (!transferWindowOpen(state)) {
    const last = lastRealTi(id);
    if (last === null || !(last > ti)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 入场
// ---------------------------------------------------------------------------

export interface RealEntryRecord {
  playerId: string;
  handle: string;
  /** 卸任主教练的 AI 战队（与他同 id 的真实教练正在 AI 战队执教） */
  leftTeamIds: string[];
  /** 删除了与他同 id 的真实教练记录 */
  removedCoach: boolean;
  /** 卸任后 AI 战队随即补签的主教练（读档迁移） */
  replacements?: { teamId: string; coachName: string }[];
}

export interface RealEntrySkip {
  playerId: string;
  handle: string;
  /** 聘用他担任主教练的人类玩家战队 */
  teamId: string;
}

export interface RealEntryReport {
  ti: number;
  entered: RealEntryRecord[];
  /** 与他同 id 的真实教练正在人类玩家战队执教：暂不入场 */
  skipped: RealEntrySkip[];
  /** 读档迁移：待决的「真实新秀希望加盟」事件改为直接进入自由市场的新秀 */
  rookies: string[];
  /** 本届新秀因同 id 的教练在人类玩家战队执教而暂未出道、解除主教练职务后进入自由市场 */
  debuts?: string[];
}

function emptyReport(ti: number): RealEntryReport {
  return { ti, entered: [], skipped: [], rookies: [] };
}

/**
 * 让 ids 中符合资格的真实选手以自由身入场（按 ids 顺序；不发新闻）。与他同 id 的真实教练按 sameIdCoach.resolveSameIdCoach 处理：
 * 在人类玩家战队执教 → 暂不入场；replace：卸任的 AI 战队随即补签主教练（转会窗口之外：读档迁移）。
 */
function enterRealPlayers(state: GameState, ids: readonly string[], ti: number, out: RealEntryReport, replace: boolean): void {
  for (const id of ids) {
    if (!realEntryEligible(state, id, ti)) continue;
    const coach = resolveSameIdCoach(state, id, { replace });
    if (coach.humanTeamId) {
      out.skipped.push({ playerId: id, handle: indexEntry(id)?.handle || id, teamId: coach.humanTeamId });
      continue;
    }
    const p = bringBackRealPlayer(state, id, ti, undefined);
    if (!p) continue; // 不会发生（资格已检查索引与当届数据，同 id 教练已处理）
    p.loyalty = CONFIG.loyalty.freeAgentTarget;
    markMarketEntry(state, p); // bringBackRealPlayer 已记下，这里写明
    out.entered.push({
      playerId: id,
      handle: p.handle,
      leftTeamIds: coach.leftTeamIds,
      removedCoach: coach.removed,
      ...(coach.replacements.length ? { replacements: coach.replacements.map((r) => ({ teamId: r.teamId, coachName: r.coachName })) } : {}),
    });
  }
}

/**
 * 赛季初的复出 / 新面孔（season.startSeason：新俱乐部成立、卡池建立与过期新秀条目清理之后，教练供给与 AI 休赛期转会之前）：
 * 当届真实阵容数据中有、本局中还没有出现过的真实选手（非本届新秀）以自由身进入自由市场。新游戏的第一个赛季不执行（开局阵容已包含当届全部选手）。
 * 有人入场或暂不入场时发一条公开新闻。返回本次汇总（未执行时 null）。
 */
export function seasonRealReturners(state: GameState): RealEntryReport | null {
  if (!CONFIG.realEntry?.returners || state.gameOver || !state.season) return null;
  const ti = state.season.ti;
  const startTi = state.settings?.startTi ?? ti;
  if (!(ti > startTi)) return null;
  const out = emptyReport(ti);
  // 赛季初：卸任的 AI 战队不在这里补签，随后的 AI 季前窗口照常聘请
  enterRealPlayers(state, realRosterIdsAt(ti), ti, out, false);
  if (out.entered.length || out.skipped.length) entryNews(state, out, false);
  return out;
}

/**
 * 本届新秀因与他同 id 的教练在人类玩家战队执教而暂未出道（卡被抽中时退化为虚构卡 / 第 1 回合前离池或卡池关闭时没有生成，
 * futureRookies 条目已清除）：玩家解除其主教练职务时以未被抽走的真实新秀身份进入自由市场。转会窗口已关闭时同 realEntryEligible。
 */
function deferredRookieEligible(state: GameState, id: string, ti: number): boolean {
  if (!id || hasOwn(state.players, id) || hasOwn(state.futureRookies, id)) return false;
  const e = indexEntry(id);
  if (!e || Number(e.firstTi) !== ti || !realDebutTier(id)) return false;
  if (!transferWindowOpen(state)) {
    const last = lastRealTi(id);
    if (last === null || !(last > ti)) return false;
  }
  return true;
}

/**
 * 人类玩家战队解除主教练职务之后调用（game.fireCoach、game.hireCoach 替换现任、events.resolveRetire 聘请退役旧部替换现任；
 * 先经过 realCareer.comebackAfterCoachRelease）：这名教练与当届真实阵容数据中的真实选手同 id、而这名选手还没有进入本局
 * （赛季初因在人类玩家战队执教而暂不入场；或是本届新秀、因此暂未出道）时，他随即以自由身进入自由市场。返回入场选手的显示 ID；未入场返回 null。
 */
export function realEntryAfterCoachRelease(state: GameState, coach: Coach | null | undefined): string | null {
  if (!coach?.id || coach.formerPlayerId || coachEmployer(state, coach) || state.gameOver) return null;
  const ti = state.season?.ti;
  if (typeof ti !== 'number') return null;
  const out = emptyReport(ti);
  // 本届新秀不受复出 / 新面孔开关（realEntry.returners）影响
  if (deferredRookieEligible(state, coach.id, ti)) {
    // 本届新秀：教练记录删除后以未被抽走的真实新秀身份（出道届水平、新秀标记、抽卡出身 placed）进入自由市场
    resolveSameIdCoach(state, coach.id, { replace: false });
    const p = releaseRealRookieToMarket(state, coach.id, realDebutTier(coach.id)!, ti);
    if (p) (out.debuts ??= []).push(p.id);
  } else if (CONFIG.realEntry?.returners && realEntryEligible(state, coach.id, ti)) {
    enterRealPlayers(state, [coach.id], ti, out, false);
  }
  const id = out.entered[0]?.playerId ?? out.debuts?.[0];
  if (!id) return null;
  syncSynergies(state, { full: true });
  entryNews(state, out, false);
  return state.players[id]?.handle ?? id;
}

/** 解除主教练职务后入场时附在操作结果后的说明 */
export function realEntryReleaseNote(handle: string | null): string {
  return handle ? `；${handle} 以选手身份进入自由市场（当届真实阵容中他是职业选手）` : '';
}

// ---------------------------------------------------------------------------
// 旧存档 / 旧房间迁移
// ---------------------------------------------------------------------------

/** 是否需要入场迁移（multi.migrateRoomState 的快速判断） */
export function realEntryNeedsMigration(state: GameState): boolean {
  return !(Number(state?.realEntryVersion) >= REAL_ENTRY_VERSION);
}

/**
 * 旧存档迁移（幂等：realEntryVersion ≥ REAL_ENTRY_VERSION 时直接返回 null）：
 * 1. 待决的「真实新秀希望加盟」事件（rookie_home，全部座位）移除，该新秀以自由身进入自由市场；
 * 2. 当届真实阵容数据中有、本局还没有出现过的真实选手（非本届新秀）以自由身进入自由市场（同 seasonRealReturners；
 *    开关 CONFIG.realEntry.returners 关闭时跳过这一步）。
 * 游戏已结束的存档只写版本。有人入场或暂不入场时发一条公开新闻 + 每支人类玩家战队一条总览通知。
 */
export function migrateRealEntry(state: GameState): RealEntryReport | null {
  if (!state || typeof state !== 'object') return null;
  if (!realEntryNeedsMigration(state)) return null;
  state.realEntryVersion = REAL_ENTRY_VERSION;
  const ti = state.season?.ti;
  if (state.gameOver || typeof ti !== 'number' || !Number.isFinite(ti) || !state.players) return emptyReport(Number(ti) || 0);
  const out = emptyReport(ti);
  // 1. rookie_home → 自由市场（按新秀 id 排序；同一新秀只处理一次）
  const homes = allPendingDecisions(state)
    .filter((d) => d?.kind === 'rookie_home' && typeof d.ctx?.rookieId === 'string')
    .map((d) => ({
      id: String(d.ctx.rookieId),
      tier: ((TIERS as string[]).includes(String(d.ctx.tier)) ? d.ctx.tier : 'C') as Tier,
      ti: Number.isFinite(Number(d.ctx.ti)) ? Number(d.ctx.ti) : ti,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (homes.length) {
    removePendingDecisionsEverywhere(state, (d) => d?.kind === 'rookie_home');
    const seen = new Set<string>();
    for (const h of homes) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      const p = releaseRealRookieToMarket(state, h.id, h.tier, h.ti);
      if (p) out.rookies.push(p.id);
    }
  }
  // 2. 当届缺失的真实选手
  // 读档时 AI 季前窗口已经过去：卸任的 AI 战队随即补签主教练
  if (CONFIG.realEntry?.returners) enterRealPlayers(state, realRosterIdsAt(ti), ti, out, true);
  if (out.entered.length || out.rookies.length) syncSynergies(state, { full: true });
  if (out.entered.length || out.skipped.length || out.rookies.length) entryNews(state, out, true);
  return out;
}

// ---------------------------------------------------------------------------
// 新闻 / 通知（平实文案）
// ---------------------------------------------------------------------------

function teamName(state: GameState, teamId: string): string {
  return ownEntry(state.teams, teamId)?.name ?? teamId;
}

/** 「Ceb（SS 级 · 3号位 劣势路）」列表：等级从高到低、同级按显示 ID，最多 CONFIG.realEntry.newsMax 人 */
function nameList(state: GameState, ids: readonly string[]): { shown: string[]; text: string } {
  const max = Math.max(1, Math.floor(Number(CONFIG.realEntry?.newsMax) || 12));
  const key = (id: string) => (state.players[id]?.handle || id).toLowerCase();
  const sorted = ids.filter((id) => !!state.players[id]).sort((a, b) => {
    const d = tierIndex(playerTier(state.players[b])) - tierIndex(playerTier(state.players[a]));
    if (d) return d;
    return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const shown = sorted.slice(0, max);
  const text = shown.map((id) => {
    const p = state.players[id];
    return `${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position] ?? p.position}）`;
  }).join('、') + (sorted.length > max ? ` 等 ${sorted.length} 人` : '');
  return { shown, text };
}

/** notify：每支人类玩家战队另收一条总览通知（读档迁移）；否则只发公开新闻 */
function entryNews(state: GameState, res: RealEntryReport, notify: boolean): void {
  const debuts = res.debuts ?? [];
  const n = res.entered.length + res.rookies.length + debuts.length;
  const one = n === 1 ? state.players[res.entered[0]?.playerId ?? res.rookies[0] ?? debuts[0]] : undefined;
  let title: string;
  if (one) title = `【复出 / 新面孔】${one.handle} 进入自由市场`;
  else if (n > 1) title = `【复出 / 新面孔】${n} 名真实选手进入自由市场`;
  else if (res.skipped.length === 1) title = `【复出 / 新面孔】${res.skipped[0].handle} 继续执教`;
  else title = `【复出 / 新面孔】${res.skipped.length} 名真实选手继续执教`;
  let body = '';
  const listed: string[] = [];
  if (res.entered.length) {
    const { shown, text } = nameList(state, res.entered.map((r) => r.playerId));
    listed.push(...shown);
    body += `${text} 在 TI${res.ti} 赛季的真实阵容中，本局此前还没有出现过，现以自由身进入自由市场。`;
    const left = res.entered.filter((r) => r.leftTeamIds.length);
    if (left.length) {
      body += `${left.map((r) => `${r.handle} 卸任 ${r.leftTeamIds.map((t) => teamName(state, t)).join('、')} 主教练`).join('；')}，回到赛场。`;
      const hired = left.flatMap((r) => r.replacements ?? []);
      if (hired.length) body += `${hired.map((h) => `${teamName(state, h.teamId)} 随即聘请 ${h.coachName} 担任主教练`).join('；')}。`;
    }
  }
  if (res.rookies.length) {
    const { shown, text } = nameList(state, res.rookies);
    listed.push(...shown);
    body += `未被抽走的真实新秀 ${text} 不再等待出道战队的决定，直接进入自由市场。`;
  }
  if (debuts.length) {
    const { shown, text } = nameList(state, debuts);
    listed.push(...shown);
    body += `本届真实新秀 ${text} 卸任主教练，以选手身份出道，进入自由市场。`;
  }
  body += marketEntryNote(state, n);
  if (res.skipped.length) {
    const who = res.skipped.length === 1 ? '他' : '他们';
    body += `${res.skipped.map((s) => `${s.handle} 现任 ${teamName(state, s.teamId)} 主教练`).join('；')}，继续执教，暂不回到赛场；`
      + `解除其主教练职务后，${who}即以自由身进入自由市场。`;
  }
  addNews(state, 'transfer', title, body, true, {
    playerIds: listed,
    teamIds: res.skipped.map((s) => s.teamId),
    scope: 'world',
    visibility: 'public',
    tags: ['comeback', 'transfer'],
    noInfer: true,
  });
  if (!notify) return;
  // 总览「通知」：每支人类玩家战队一条（多人模式路由到各自座位）
  for (const teamId of humanTeamIds(state)) {
    const team = ownEntry(state.teams, teamId);
    if (!team || team.disbanded) continue;
    if (isMultiplayer(state) && !seatInPlay(state, teamId)) continue;
    inSeatOf(state, teamId, () => pushPopup(state, { kind: 'message', title, body }));
  }
}
