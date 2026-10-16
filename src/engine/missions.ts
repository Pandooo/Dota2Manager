// 俱乐部使命（第十波 #3）【J1-clubs-missions】
// 每个非玩家的真实俱乐部都以组建其现实巅峰阵容为目标（src/data/clubIndex.json 的 peak：TI 冠军阵容；多冠俱乐部取同一套五人夺冠最多、
// 再取最早的一届，如 OG 的 TI8/TI9 阵容、Spirit 的 TI10 阵容；未夺冠取最好名次的阵容）。
//   - 引进：休赛期转会潮（shuffle.ts）与 AI 转会窗口（ai.ts → aiPursueMission）中优先引进缺失的使命成员：自由身直接签，
//     其他 AI 战队的选手溢价求购（卖家可拒绝，卖家自己的使命成员更难买），必要时顶掉同位置的非使命首发（位置调整）；
//     人类玩家战队的使命成员只会收到报价（shuffle.ts，玩家可拒绝），从不强制带走；
//   - 留人：使命成员更难被换下 / 挂牌 / 挖走，合同到期时大概率续约（missionContractRetention）；裁员时最后才放（missionAwareTrim）；
//   - 进度 k/5 记在 Team.mission（AI 转会窗口结束时刷新：refreshMissions）；集齐时新闻「{俱乐部} 集齐 TI{n} 巅峰阵容」，集齐状态下夺得 TI 另发新闻（missionSeasonEnd）；
//     集齐状态下夺得 TI 即「使命完成」：之后不再优先引进、也不再额外留人（避免同一套阵容靠留人加成长期垄断冠军，平衡见 DESIGN.md 7.3）；
//   - 不保证成功：成员可能在人类玩家战队、已退役、尚未出道或买不起。
// 全部随机数取自 rngOf(state)（调用方传入）；查询函数不修改状态。
import type { GameState, Player, Position, Team, Tournament } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { rngOf, type Rng } from './rng';
import { clamp, formatGold, ownEntry } from './util';
import { addNews } from './news';
import { activeTeams, autoLineup, benchPlayers, teamPlayers } from './team';
import { computeSalary, effectiveAttr, marketValue, overallRating, playerTier } from './player';
import { roundWageBill } from './economy';
import {
  aiSignFreeAgent, departToFreeAgency, executeTransfer, fillRosterFromMarket, playerWillingness, roundFee, signingFee,
} from './market';
import { realOrgOf, realPlayerHandle, type ClubOrg, type ClubPeak } from './clubs';
import { isHumanTeam } from './seat';
import { aiSigningHeld } from './marketEntry';

// ---------------------------------------------------------------------------
// 定义与查询
// ---------------------------------------------------------------------------

const M = () => CONFIG.missions;

export interface ClubMission {
  teamId: string;
  org: ClubOrg;
  peak: ClubPeak;
}

export function missionsEnabled(): boolean {
  return !!M()?.enabled;
}

/** 战队的使命：非玩家、未解散、有巅峰阵容数据的真实俱乐部；否则 null */
export function missionOf(state: GameState, teamId: string | null | undefined): ClubMission | null {
  if (!teamId || !missionsEnabled()) return null;
  const team = ownEntry(state.teams, teamId);
  if (!team || team.disbanded || team.isPlayer || isHumanTeam(state, teamId)) return null;
  const org = realOrgOf(state, teamId);
  if (!org?.peak) return null;
  return { teamId, org, peak: org.peak };
}

/** 使命已完成：以巅峰阵容夺得过 TI（Team.mission.tiTitles 非空） */
export function missionFulfilled(state: GameState, teamId: string | null | undefined): boolean {
  return !!teamId && (ownEntry(state.teams, teamId)?.mission?.tiTitles?.length ?? 0) > 0;
}

/** 生效中的使命（尚未完成）：引进优先与留人加成只对它生效；已完成的使命返回 null */
export function missionInEffect(state: GameState, teamId: string | null | undefined): ClubMission | null {
  const m = missionOf(state, teamId);
  return m && !missionFulfilled(state, teamId) ? m : null;
}

/** 选手是否为某战队生效中使命的成员（留人加成 / 卖家使命成员扣减） */
export function isMissionPlayerOf(state: GameState, playerId: string, teamId: string | null | undefined): boolean {
  return !!missionInEffect(state, teamId)?.peak.players.includes(playerId);
}

/** 选手是否为其当前（AI）战队的使命成员（留人加成） */
export function isRetainedMissionPlayer(state: GameState, p: Player | null | undefined): boolean {
  return !!p && !!p.teamId && isMissionPlayerOf(state, p.id, p.teamId);
}

function onTeam(state: GameState, playerId: string, teamId: string): boolean {
  const p = state.players[playerId];
  return !!p && p.status === 'active' && p.teamId === teamId && !p.tempSubUntilTournament;
}

export interface MissionProgress {
  mission: ClubMission;
  /** 已在队的使命成员 id */
  have: string[];
  /** 尚未到队的使命成员 id */
  missing: string[];
  complete: boolean;
}

export function missionProgress(state: GameState, teamId: string): MissionProgress | null {
  const mission = missionOf(state, teamId);
  if (!mission) return null;
  const have: string[] = [];
  const missing: string[] = [];
  for (const pid of mission.peak.players) (onTeam(state, pid, teamId) ? have : missing).push(pid);
  return { mission, have, missing, complete: missing.length === 0 };
}

/**
 * 可追逐的缺失使命成员：在役、不在本队、不是野外 / 临时替补、不在人类玩家战队；按综合评分降序。
 */
export function missionTargets(state: GameState, teamId: string): Player[] {
  if (!missionInEffect(state, teamId)) return [];
  const prog = missionProgress(state, teamId);
  if (!prog) return [];
  const out: Player[] = [];
  for (const pid of prog.missing) {
    const p = state.players[pid];
    if (!p || p.status !== 'active' || p.isWildSub || p.tempSubUntilTournament) continue;
    if (p.teamId) {
      const seller = state.teams[p.teamId];
      if (!seller || seller.disbanded || seller.isPlayer || isHumanTeam(state, seller.id)) continue;
    }
    out.push(p);
  }
  out.sort((a, b) => overallRating(b) - overallRating(a) || (a.id < b.id ? -1 : 1));
  return out;
}

/** 卖家（AI 战队）对使命求购的放人概率 */
export function missionSellChance(state: GameState, p: Player, sellerId: string): number {
  const c = M();
  const roster = teamPlayers(state, sellerId).filter((q) => !q.tempSubUntilTournament);
  const r = overallRating(p);
  const top = roster.every((q) => q.id === p.id || overallRating(q) <= r);
  const chance = c.sellBase
    - (top ? c.sellStarPenalty : 0)
    - (isMissionPlayerOf(state, p.id, sellerId) ? c.sellMissionPenalty : 0)
    + ((50 - effectiveAttr(p, 'loyalty')) / 100) * c.sellLoyaltyFactor;
  return clamp(chance, 0.02, 0.95);
}

/** 使命求购报价（身价 × U(bidFee)） */
export function missionBidFee(state: GameState, p: Player, rng: Rng): number {
  const [a, b] = M().bidFee;
  return roundFee(marketValue(state, p) * rng.range(Math.min(a, b), Math.max(a, b)));
}

/** 使命引进的资金门槛（比普通引援宽松） */
export function missionCanAfford(state: GameState, team: Team, fee: number, salary: number): boolean {
  return team.gold - fee >= (roundWageBill(state, team.id) + salary) * M().budgetRounds;
}

/** 使命成员对本俱乐部的加盟意愿（含使命加成） */
export function missionWillingness(state: GameState, p: Player, teamId: string): number {
  return playerWillingness(state, p.id, teamId) + M().willBonus;
}

/** 使命生效中、仍有缺失成员的 AI 俱乐部 */
export function missionClubs(state: GameState): Team[] {
  if (!missionsEnabled()) return [];
  return activeTeams(state).filter((t) => {
    if (!missionInEffect(state, t.id)) return false;
    const prog = missionProgress(state, t.id);
    return !!prog && !prog.complete;
  });
}

// ---------------------------------------------------------------------------
// 阵容整理 / 留人
// ---------------------------------------------------------------------------

/**
 * 阵容裁到 max 人（不含临时替补）：先自动排阵，再依次放走 非使命替补 → 非使命首发 → 使命成员 中评分最低者
 * （使命成员最后才放；market.trimRoster 只看替补评分、不区分）。只对 AI 战队生效（人类玩家战队直接返回）。返回被放走的选手。
 */
export function missionAwareTrim(state: GameState, teamId: string, max: number = CONFIG.ai.maxRoster): Player[] {
  const team = ownEntry(state.teams, teamId);
  if (!team || team.disbanded || team.isPlayer || isHumanTeam(state, teamId)) return [];
  const peak = new Set(missionInEffect(state, teamId)?.peak.players ?? []);
  const released: Player[] = [];
  if (teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament).length <= max) return released;
  autoLineup(state, teamId);
  for (let guard = team.playerIds.length; guard > 0; guard--) {
    const roster = teamPlayers(state, teamId).filter((p) => !p.tempSubUntilTournament);
    if (roster.length <= max) break;
    const bench = new Set(benchPlayers(state, teamId).map((p) => p.id));
    const tiers: Player[][] = [
      roster.filter((p) => bench.has(p.id) && !peak.has(p.id)),
      roster.filter((p) => !bench.has(p.id) && !peak.has(p.id)),
      roster.filter((p) => bench.has(p.id)),
      roster,
    ];
    const from = tiers.find((t) => t.length) ?? [];
    if (!from.length) break;
    let worst = from[0];
    for (const p of from) if (overallRating(p) < overallRating(worst) || (overallRating(p) === overallRating(worst) && p.id < worst.id)) worst = p;
    departToFreeAgency(state, worst.id);
    released.push(worst);
  }
  return released;
}

/**
 * 合同到期前（season.settleSeason：market.processContractExpiry 之前）：AI 使命俱乐部以 renewChance 概率与本季到期的使命成员续约
 * （工资按当前市场工资），其余照原规则处理。返回续约人数。
 */
export function missionContractRetention(state: GameState): number {
  if (!missionsEnabled() || !state.season) return 0;
  const ti = state.season.ti;
  const rng = rngOf(state);
  const [lo, hi] = M().renewSeasons;
  let n = 0;
  for (const team of activeTeams(state)) {
    const mission = missionInEffect(state, team.id);
    if (!mission) continue;
    for (const pid of mission.peak.players) {
      const p = state.players[pid];
      if (!p || !onTeam(state, pid, team.id) || p.contractUntil > ti) continue;
      if (!rng.chance(M().renewChance)) continue;
      p.contractUntil = ti + rng.int(Math.min(lo, hi), Math.max(lo, hi));
      p.salary = computeSalary(state, p);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// AI 转会窗口中的使命引进（ai.ts）
// ---------------------------------------------------------------------------

function missionNews(state: GameState, team: Team, p: Player, fromId: string | null, fee: number, mission: ClubMission): void {
  const have = mission.peak.players.filter((id) => onTeam(state, id, team.id)).length;
  const from = fromId ? state.teams[fromId]?.name ?? fromId : null;
  const label = `${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}`;
  addNews(
    state,
    'transfer',
    from ? `【转会】${p.handle} 从 ${from} 加盟 ${team.name}` : `【签约】${team.name} 签下 ${p.handle}`,
    (from
      ? `${team.name}${fee > 0 ? ` 以 ${formatGold(fee)} 的转会费` : ''}从 ${from} 签下 ${p.handle}（${label}）。`
      : `${team.name} 签下自由选手 ${p.handle}（${label}）。`)
      + `${p.handle} 是 ${team.name} TI${mission.peak.ti} 巅峰阵容的成员，俱乐部的使命进度 ${have}/5。`,
    have >= 4 || p.isReal,
    { teamIds: [team.id, fromId].filter((x): x is string => !!x), playerIds: [p.id], tags: ['transfer', 'mission'], noInfer: true },
  );
}

/**
 * AI 转会窗口（ai.aiTransferWindow）中的使命引进：缺失的使命成员按评分从高到低尝试，每个窗口至多 maxBuys[mode] 名。
 * 新游戏第一个赛季的季前窗口不引进（与休赛期转会潮一致，保留真实开局阵容；使命从该赛季的中期窗口开始）。
 * 自由身 → 支付签字费签下；其他 AI 战队 → 溢价求购（中期窗口按 midseasonBuyChance 才出手），卖家按 missionSellChance 放人。
 * 引进后阵容超出 ai.maxRoster 时先放走非使命替补。返回引进的选手。
 */
export function aiPursueMission(
  state: GameState, team: Team, pool: Player[], mode: 'preseason' | 'midseason', rng: Rng,
): Player[] {
  const c = M();
  if (!missionsEnabled() || team.disbanded || team.isPlayer) return [];
  const mission = missionInEffect(state, team.id);
  if (!mission) return [];
  if (mode === 'preseason' && state.season && state.season.ti <= (state.settings?.startTi ?? state.season.ti)) return [];
  const limit = Math.max(0, Math.floor(c.maxBuys[mode] ?? 0));
  if (limit <= 0) return [];
  const minWill = CONFIG.ai.minWillingness;
  const signed: Player[] = [];
  for (const p of missionTargets(state, team.id)) {
    if (signed.length >= limit) break;
    const salary = computeSalary(state, p);
    if (missionWillingness(state, p, team.id) < minWill) continue;
    const fromId = p.teamId;
    if (!fromId) {
      // 本回合刚入场的真实选手（v0.4.3 公平窗口，marketEntry.aiSigningHeld）：入场的回合内不签
      if (aiSigningHeld(state, p)) continue;
      const fee = signingFee(state, p);
      if (!missionCanAfford(state, team, fee, salary)) continue;
      aiSignFreeAgent(state, team, p, pool);
      if (p.teamId !== team.id) continue;
      missionNews(state, team, p, null, fee, mission);
    } else {
      if (mode === 'midseason' && !rng.chance(c.midseasonBuyChance)) continue;
      const fee = missionBidFee(state, p, rng);
      if (!missionCanAfford(state, team, fee, salary)) continue;
      if (!rng.chance(missionSellChance(state, p, fromId))) continue;
      const [cLo, cHi] = c.signContractSeasons;
      executeTransfer(state, p.id, team.id, fee, {
        salary, contractSeasons: rng.int(Math.min(cLo, cHi), Math.max(cLo, cHi)), loyalty: c.signLoyalty,
      });
      if (p.teamId !== team.id) continue;
      const seller = state.teams[fromId];
      if (seller && !seller.disbanded && !seller.isPlayer) fillRosterFromMarket(state, fromId, CONFIG.ai.minRoster, pool);
      missionNews(state, team, p, fromId, fee, mission);
    }
    signed.push(p);
    missionAwareTrim(state, team.id, CONFIG.ai.maxRoster);
    autoLineup(state, team.id);
  }
  return signed;
}

// ---------------------------------------------------------------------------
// 进度与里程碑
// ---------------------------------------------------------------------------

/**
 * 刷新全部 AI 真实俱乐部的使命进度（Team.mission.have）：新集齐时记录赛季并发新闻「{俱乐部} 集齐 TI{n} 巅峰阵容」
 * （新游戏第一个赛季回合 0 的初始阵容即已集齐的、以及首次记录进度时（旧存档升级）即已集齐的只记录、不发新闻；
 * 散而复聚的「再次集齐」新闻不标为重要）。返回本次新集齐的战队 id。
 */
export function refreshMissions(state: GameState): string[] {
  if (!missionsEnabled() || !state.season) return [];
  const ti = state.season.ti;
  const opening = ti === state.settings?.startTi && state.roundIndex === 0 && state.phase === 'preseason';
  const out: string[] = [];
  for (const team of activeTeams(state)) {
    const prog = missionProgress(state, team.id);
    if (!prog) continue;
    const quiet = opening || !team.mission; // 首次记录（开局 / 旧存档）：只记录现状
    const m = (team.mission ??= { have: 0 });
    const wasComplete = m.have >= 5;
    m.have = prog.have.length;
    if (!prog.complete || wasComplete || missionFulfilled(state, team.id)) continue;
    const again = m.firstCompletedTi !== undefined;
    m.firstCompletedTi ??= ti;
    m.completedTi = ti;
    out.push(team.id);
    if (quiet) continue;
    const names = prog.mission.peak.players.map((id) => state.players[id]?.handle ?? id);
    addNews(
      state,
      'transfer',
      `【使命】${team.name} 集齐 TI${prog.mission.peak.ti} 巅峰阵容`,
      `${names.join('、')} ${again ? '再次' : ''}聚首 ${team.name}，俱乐部${again ? '重新' : ''}集齐了 TI${prog.mission.peak.ti} 时的巅峰阵容，将以这套阵容冲击 TI${ti}。`,
      !again,
      { teamIds: [team.id], playerIds: prog.mission.peak.players.slice(), tags: ['mission'], noInfer: true },
    );
  }
  return out;
}

/**
 * TI 结算（season.settleSeason：TI 结束后、退役之前）：TI 冠军是集齐巅峰阵容的使命俱乐部 → 记入 Team.mission.tiTitles（使命完成）并发新闻。
 * 新闻区分五人是否都是夺冠首发（Team.lineup）：都首发 →「以 TI{n} 巅峰阵容夺得」；有成员坐替补席（AI 首发优先使命选手，
 * 只有两人同位置或该赛事无法出场时才会坐替补，lineupPriority.ts）→
 * 「集齐 TI{n} 巅峰阵容的 {俱乐部} 夺得」并注明替补。返回该冠军战队 id（不满足时 null）。
 */
export function missionSeasonEnd(state: GameState, tiT: Tournament | null): string | null {
  if (!missionsEnabled() || !state.season || !tiT) return null;
  const champ = tiT.placements?.find((p) => p.rankFrom === 1 && p.rankTo === 1)?.teamId;
  if (!champ) return null;
  const prog = missionProgress(state, champ);
  if (!prog?.complete) return null;
  const team = state.teams[champ];
  const ti = state.season.ti;
  const peak = prog.mission.peak;
  const m = (team.mission ??= { have: 5 });
  m.have = 5;
  m.tiTitles = [...new Set([...(m.tiTitles ?? []), ti])].sort((a, b) => a - b);
  const handle = (id: string) => state.players[id]?.handle ?? id;
  const starters = new Set(Object.values(team.lineup ?? {}).filter((x): x is string => !!x));
  const bench = peak.players.filter((id) => !starters.has(id));
  addNews(
    state,
    'tournament',
    bench.length
      ? `【使命】集齐 TI${peak.ti} 巅峰阵容的 ${team.name} 夺得 TI${ti} 冠军`
      : `【使命】${team.name} 以 TI${peak.ti} 巅峰阵容夺得 TI${ti} 冠军`,
    bench.length
      ? `${team.name} 在 TI${ti} 捧起不朽盾，TI${peak.ti} 巅峰阵容的五名成员都在阵中（${bench.map(handle).join('、')} 担任替补），`
        + '重组巅峰阵容的使命就此完成。'
      : `${peak.players.map(handle).join('、')} 组成的 ${team.name} 在 TI${ti} 捧起不朽盾，重组 TI${peak.ti} 巅峰阵容的使命修成正果。`,
    true,
    { teamIds: [champ], playerIds: peak.players.slice(), tags: ['mission'], noInfer: true },
  );
  return champ;
}

// ---------------------------------------------------------------------------
// 界面：DotaPedia 战队页「使命」
// ---------------------------------------------------------------------------

export type MissionMemberStatus = 'here' | 'team' | 'human' | 'free' | 'retired' | 'banned' | 'future' | 'absent';

export const MISSION_STATUS_LABEL: Record<MissionMemberStatus, string> = {
  here: '已在队',
  team: '效力于其他战队',
  human: '效力于玩家战队',
  free: '自由身',
  retired: '已退役',
  banned: '禁赛',
  future: '尚未出道',
  absent: '不在本局',
};

export interface ClubMissionMember {
  id: string;
  handle: string;
  /** 巅峰阵容中的位置 */
  position: Position;
  status: MissionMemberStatus;
  /** 当前所在战队（status 为 team / human / here 时） */
  teamId?: string;
  teamName?: string;
}

export interface ClubMissionView {
  teamId: string;
  orgName: string;
  /** 使命在生效（AI 真实俱乐部、尚未完成）；玩家执教 / 已解散 / 已完成的俱乐部只展示巅峰阵容 */
  active: boolean;
  /** 使命已完成（以巅峰阵容夺得过 TI） */
  fulfilled: boolean;
  note?: string;
  peakTi: number;
  /** 巅峰阵容所在届次的队名（如 PSG.LGD） */
  peakName: string;
  /** 现实成绩（该届真实 TI 尚未到来时不剧透，为 null） */
  resultLabel: string | null;
  /** 同一套五人夺得的现实 TI（只列已到来的届次） */
  titles: number[];
  members: ClubMissionMember[];
  have: number;
  total: number;
  complete: boolean;
  firstCompletedTi?: number;
  completedTi?: number;
  /** 集齐状态下夺得的 TI（本局） */
  tiTitles: number[];
}

function resultText(result: string): string {
  if (result === '1') return '冠军';
  if (result === '2') return '亚军';
  if (result === '3') return '季军';
  if (/^\d+(-\d+)?$/.test(result)) return `第 ${result} 名`;
  return '未进入 TI 正赛';
}

/** DotaPedia 战队页「使命」（只读；虚构 / 程序化战队、无巅峰数据的组织返回 null） */
export function clubMissionView(state: GameState, teamId: string): ClubMissionView | null {
  const team = ownEntry(state.teams, teamId);
  if (!team) return null;
  const org = realOrgOf(state, teamId);
  const peak = org?.peak;
  if (!org || !peak) return null;
  const human = team.isPlayer || isHumanTeam(state, teamId);
  const fulfilled = !human && missionFulfilled(state, teamId);
  const active = !human && !team.disbanded && missionsEnabled() && !fulfilled;
  const cur = state.season?.ti ?? 0;
  const members: ClubMissionMember[] = peak.players.map((pid, i) => {
    const p = state.players[pid];
    const position = (peak.positions?.[i] ?? p?.position ?? 'C') as Position;
    if (!p) {
      const future = state.futureRookies?.[pid] !== undefined;
      return { id: pid, handle: realPlayerHandle(pid), position, status: future ? 'future' : 'absent' };
    }
    const base = { id: pid, handle: p.handle, position };
    if (p.status === 'retired') return { ...base, status: 'retired' };
    if (p.status === 'banned') return { ...base, status: 'banned' };
    if (!p.teamId) return { ...base, status: 'free' };
    const t = state.teams[p.teamId];
    const status: MissionMemberStatus = p.teamId === teamId ? 'here' : isHumanTeam(state, p.teamId) || t?.isPlayer ? 'human' : 'team';
    return { ...base, status, teamId: p.teamId, teamName: t?.name ?? p.teamId };
  });
  const have = members.filter((m) => m.status === 'here').length;
  return {
    teamId,
    orgName: team.name,
    active,
    fulfilled,
    note: human
      ? '玩家执教的俱乐部不设 AI 使命，以下为现实中的巅峰阵容。'
      : team.disbanded
        ? '俱乐部已解散，使命终止。'
        : fulfilled
          ? `集齐这套阵容后夺得 ${(team.mission?.tiTitles ?? []).map((t) => `TI${t}`).join('、')}，使命完成：此后不再优先引进、也不再额外挽留这些成员。`
          : undefined,
    peakTi: peak.ti,
    peakName: peak.name,
    resultLabel: peak.ti < cur ? resultText(peak.result) : null,
    titles: (peak.titles ?? []).filter((t) => t < cur),
    members,
    have,
    total: peak.players.length,
    complete: have === peak.players.length,
    firstCompletedTi: team.mission?.firstCompletedTi,
    completedTi: team.mission?.completedTi,
    tiTitles: team.mission?.tiTitles ?? [],
  };
}
