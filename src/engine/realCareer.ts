// 真实生涯保护与提前退役者复出（v0.4.2，用户反馈「TI2024 Liquid 夺冠五号位 Insania 在我这局里提前退役，组不了羁绊」）
//
// - 保护（growth.processRetirements，开关 CONFIG.aging.protectRealCareer）：真实选手只要真实阵容数据（src/data/trajectories.json，
//   由 rosters/ti*.json 生成，含替补与自由选手）里还有晚于本次结算届次的记录，本次 TI 结算就不会退役；
//   最后一届真实数据之后照旧按年龄 / 等级 / 战力的概率退役。保护判断放在掷骰之前（受保护的选手不消耗随机数）。
// - 复出（读档 save.upgradeLoadedState / 多人房间载入 multi.migrateRoomState；按 GameState.realCareerVersion 每个存档只执行一次）：
//   旧版本中已提前退役、真实生涯在当前届次或之后仍在继续的真实选手以自由身回到转会市场（status = active、无东家、
//   清空修正器、归属感 / 合同 / 工资按普通自由选手重置，本位置与副位置按当届真实生涯同步，水平不高于当届真实水平）。
//   转会窗口已关闭（TI 预选 / TI 阶段）时只让当届之后仍有真实数据的选手复出：当届 TI 前已无法签约，结算时又会退役。
//   退役时转任的教练：自由教练 → 删除该教练记录（及引用它的「是否聘为教练」待决事件）；在 AI 战队执教 → 卸任（该队主教练空缺，
//   AI 之后照常从教练市场补签）后复出；在人类玩家战队执教 → 不替玩家做决定，继续执教，新闻 / 通知注明；
//   玩家在他真实生涯结束之前解除其主教练职务（解雇 / 签约新教练替换 / 聘请退役旧部替换）时，他随即以自由身复出（comebackAfterCoachRelease）。
//   复出或暂不复出时发一条公开新闻 + 每支人类玩家战队一条总览通知；有人复出时之后全量同步羁绊。
// 确定性：不消耗随机数（新闻 / 通知只按 id 排序）。
import { CONFIG, POSITION_CN } from './config';
import { getTrajectories } from '../data/index';
import { trajectoryOf, trajectoryValueAt } from './development';
import { addNews, pushPopup } from './news';
import { clampPlayerAttrs, computeSalary, playerTier, tierIndex } from './player';
import { realRoleFor, refreshAltPositions } from './roles';
import { humanTeamIds, inSeatOf, isHumanTeam, isMultiplayer, removePendingDecisionsEverywhere, seatInPlay } from './seat';
import { syncSynergies } from './synergy';
import type { Coach, GameState, Player, Team } from './types';
import { POSITIONS } from './types';
import { ownEntry, round2 } from './util';

/** 复出迁移的版本：新游戏创建时写入（game.createBlankState），旧存档缺失 / 落后时在读档迁移中执行一次 */
export const REAL_CAREER_VERSION = 1;

// ---------------------------------------------------------------------------
// 真实生涯的最后一届（静态数据，首次查询时建索引）
// ---------------------------------------------------------------------------

let LAST_REAL_TI: Map<string, number> | null = null;

function lastRealTiIndex(): Map<string, number> {
  if (LAST_REAL_TI) return LAST_REAL_TI;
  const m = new Map<string, number>();
  try {
    const all = getTrajectories();
    for (const id of Object.keys(all ?? {})) {
      const traj = all[id];
      if (!traj || typeof traj !== 'object') continue;
      let last = -Infinity;
      for (const k of Object.keys(traj)) {
        const ti = Number(k);
        if (Number.isFinite(ti) && ti > last) last = ti;
      }
      if (Number.isFinite(last)) m.set(id, last);
    }
  } catch {
    // 数据层不可用（测试替身等）：没有真实生涯数据，按普通规则退役
  }
  LAST_REAL_TI = m;
  return m;
}

/** 真实选手在真实阵容数据中的最后一届（TI 序号）；没有真实数据返回 null */
export function lastRealTi(playerId: string): number | null {
  return lastRealTiIndex().get(playerId) ?? null;
}

/** 本局的真实选手（不含请神新秀 / 野外替补；多人「选择已有战队」中被重置水平的真实选手仍是真实选手） */
function isRealCareerPlayer(p: Player | null | undefined): p is Player {
  return !!p && !!p.isReal && !p.summon && !p.isWildSub;
}

/** 真实生涯在 ti 之后仍在继续：真实阵容数据中有晚于 ti 的届次 */
export function realCareerContinuesAfter(p: Player | null | undefined, ti: number): boolean {
  if (!isRealCareerPlayer(p) || !Number.isFinite(ti)) return false;
  const last = lastRealTi(p.id);
  return last !== null && last > ti;
}

/** TI 结算退役保护（growth.processRetirements）：开关打开且真实生涯在本次结算的届次之后仍在继续 */
export function retirementProtected(state: GameState, p: Player): boolean {
  if (!CONFIG.aging.protectRealCareer) return false;
  const ti = state.season?.ti;
  return typeof ti === 'number' && realCareerContinuesAfter(p, ti);
}

// ---------------------------------------------------------------------------
// 复出
// ---------------------------------------------------------------------------

export interface ComebackRecord {
  playerId: string;
  handle: string;
  /** 删除的教练记录（退役时转任） */
  removedCoachIds: string[];
  /** 卸任主教练的 AI 战队（退役后转任的教练正在 AI 战队执教：卸任后复出） */
  leftTeamIds: string[];
}

export interface ComebackSkip {
  playerId: string;
  handle: string;
  coachId: string;
  /** 聘用他担任主教练的人类玩家战队 */
  teamId: string;
}

export interface RealCareerMigration {
  returned: ComebackRecord[];
  /** 退役后转任的教练正在人类玩家战队执教：不复出（玩家解除其主教练职务后复出） */
  skipped: ComebackSkip[];
}

/** 是否需要复出迁移（multi.migrateRoomState 的快速判断） */
export function realCareerNeedsMigration(state: GameState): boolean {
  if (!CONFIG.aging.protectRealCareer) return false;
  return !(Number(state?.realCareerVersion) >= REAL_CAREER_VERSION);
}

/** 转会窗口是否开放（同 market.isTransferWindowOpen；不直接引用以免 market → growth → realCareer → market 循环引用） */
function transferWindowOpen(state: GameState): boolean {
  return state.phase === 'preseason' || state.phase === 'regular';
}

/**
 * 复出资格：已退役的真实选手，真实生涯在当前届次仍在继续（最后一届真实数据 ≥ 当届）；
 * 转会窗口已关闭时须 > 当届（当届 TI 前已无法签约，当届结算时又不再受保护）。
 */
function comebackEligible(state: GameState, p: Player | null | undefined, ti: number): p is Player {
  if (!p || typeof p !== 'object' || p.status !== 'retired' || !isRealCareerPlayer(p)) return false;
  const last = lastRealTi(p.id);
  if (last === null) return false;
  return transferWindowOpen(state) ? last >= ti : last > ti;
}

/** 教练是否在任：所属战队存在且未解散，或被未解散战队登记为主教练 */
function employerOf(state: GameState, c: Coach): Team | null {
  const own = c.teamId ? ownEntry(state.teams, c.teamId) : undefined;
  if (own && !own.disbanded) return own;
  for (const tid in state.teams) {
    const t = state.teams[tid];
    if (t && !t.disbanded && t.coachId === c.id) return t;
  }
  return null;
}

/** 退役时转任的教练（formerPlayerId → 教练，按 id 排序） */
function coachesByFormerPlayer(state: GameState): Map<string, Coach[]> {
  const m = new Map<string, Coach[]>();
  for (const cid in state.coaches ?? {}) {
    const c = state.coaches[cid];
    const f = c?.formerPlayerId;
    if (!f) continue;
    const list = m.get(f);
    if (list) list.push(c);
    else m.set(f, [c]);
  }
  for (const list of m.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return m;
}

/** 复出：普通自由选手的默认状态；水平不高于当届真实水平（当届的自主成长已在赛季初执行过，退役时的水平可能高于现实） */
function revive(state: GameState, p: Player, ti: number): void {
  // 防御：清掉可能残留在战队名单 / 首发中的引用（退役时已移出战队）
  for (const tid in state.teams) {
    const t = state.teams[tid];
    if (!t) continue;
    if (Array.isArray(t.playerIds) && t.playerIds.includes(p.id)) t.playerIds = t.playerIds.filter((x) => x !== p.id);
    if (t.lineup) for (const pos of POSITIONS) if (t.lineup[pos] === p.id) t.lineup[pos] = null;
  }
  p.status = 'active';
  p.teamId = null;
  p.modifiers = [];
  p.benchRounds = 0;
  delete p.unavailableTournamentIds;
  delete p.tempSubUntilTournament;
  delete p.transferListing;
  delete p.listingStaleMemo;
  delete p.freeAgentSignedClock;
  delete p.joinedTeamSeries;
  delete p.joinedTeamClock;
  delete p.isRookie;
  delete p.gachaSeason;
  p.loyalty = CONFIG.loyalty.freeAgentTarget;
  p.contractUntil = ti;
  p.joinedSeason = ti;
  // 薪资预期跟踪：清掉与旧东家绑定的记录（薪资差、新秀合同、挽留、奖金分成），保留荣誉热度
  const track = p.salaryTrack;
  if (track && typeof track === 'object') {
    delete track.gap;
    delete track.gapTeamId;
    delete track.rookieTeamId;
    delete track.rookieUntil;
    delete track.retainKey;
    delete track.newsKey;
    delete track.newsLevel;
    delete track.prizeEarned;
    delete track.prizeTi;
    delete track.prizeRound;
    delete track.prizeTeamId;
  }
  // 水平：高于当届真实水平（空档届次按相邻两届插值）时降到当届真实水平；低于时不补（下个赛季初的自主成长照常靠拢）
  const steps = trajectoryOf(p, state);
  const real = steps ? trajectoryValueAt(steps, ti) : null;
  if (real) {
    if (Number.isFinite(p.mmr) && p.mmr > real.mmr) p.mmr = Math.round(real.mmr);
    if (Number.isFinite(p.power) && p.power > real.power) p.power = round2(real.power);
  }
  // 位置：当届（无当届数据取此前最近一届）的真实位置与截至当届的副位置
  const pos = realRoleFor(p.id, ti);
  if (pos && POSITIONS.includes(pos)) p.position = pos;
  refreshAltPositions(p, ti);
  clampPlayerAttrs(p);
  p.salary = computeSalary(state, p);
}

/**
 * 让 ids 中符合复出资格的退役真实选手复出（按 ids 顺序；不发新闻、不同步羁绊）：
 * 转任的教练在人类玩家战队执教 → 跳过；在 AI 战队执教 → 卸任；教练记录删除，引用该选手退役 / 已删除教练的待决事件从全部座位移除。
 */
function runComebacks(state: GameState, ids: readonly string[]): RealCareerMigration {
  const out: RealCareerMigration = { returned: [], skipped: [] };
  const ti = state.season?.ti;
  if (typeof ti !== 'number' || !Number.isFinite(ti) || state.gameOver || !state.players) return out;
  const coachesOf = coachesByFormerPlayer(state);
  for (const id of ids) {
    const p = ownEntry(state.players, id);
    if (!comebackEligible(state, p, ti)) continue;
    const coaches = coachesOf.get(p.id) ?? [];
    let humanEmployer: { coach: Coach; team: Team } | null = null;
    for (const c of coaches) {
      const team = employerOf(state, c);
      if (team && isHumanTeam(state, team.id)) {
        humanEmployer = { coach: c, team };
        break;
      }
    }
    if (humanEmployer) {
      out.skipped.push({ playerId: p.id, handle: p.handle, coachId: humanEmployer.coach.id, teamId: humanEmployer.team.id });
      continue;
    }
    const removed = new Set<string>();
    const left: string[] = [];
    for (const c of coaches) {
      const team = employerOf(state, c);
      if (team && !left.includes(team.id)) left.push(team.id);
      delete state.coaches[c.id];
      removed.add(c.id);
      // 执教的 AI 战队与已解散战队残留的主教练引用
      for (const tid in state.teams) if (state.teams[tid]?.coachId === c.id) state.teams[tid].coachId = null;
    }
    // 「是否聘为教练」等引用该选手退役 / 已删除教练的待决事件（全部座位）
    removePendingDecisionsEverywhere(state, (d) => (d.kind === 'retire' && d.ctx?.playerId === p.id)
      || (typeof d.ctx?.coachId === 'string' && removed.has(d.ctx.coachId)));
    revive(state, p, ti);
    out.returned.push({ playerId: p.id, handle: p.handle, removedCoachIds: [...removed], leftTeamIds: left });
  }
  return out;
}

/**
 * 旧存档迁移（幂等：realCareerVersion ≥ REAL_CAREER_VERSION 时直接返回 null；开关关闭时不执行也不写版本）：
 * 已退役、真实生涯在当前届次或之后仍在继续的真实选手复出为自由选手。游戏已结束的存档只写版本。
 * 有人复出或因在人类玩家战队执教而暂不复出时发新闻 + 通知。
 */
export function migrateRealCareerComebacks(state: GameState): RealCareerMigration | null {
  if (!state || typeof state !== 'object') return null;
  if (!realCareerNeedsMigration(state)) return null;
  state.realCareerVersion = REAL_CAREER_VERSION;
  if (!state.players) return { returned: [], skipped: [] };
  const out = runComebacks(state, Object.keys(state.players).sort());
  if (out.returned.length) syncSynergies(state, { full: true });
  if (out.returned.length || out.skipped.length) comebackNews(state, out, true);
  return out;
}

/**
 * 人类玩家战队解除主教练职务之后调用（game.fireCoach、game.hireCoach 替换现任、events.resolveRetire 聘请退役旧部替换现任）：
 * 该教练若由真实生涯仍在继续的退役真实选手转任（读档迁移时因在人类玩家战队执教而暂不复出），他随即以自由身复出
 * （删除教练记录，公开新闻，同步羁绊）。返回复出选手的显示 ID；未复出返回 null。
 */
export function comebackAfterCoachRelease(state: GameState, coach: Coach | null | undefined): string | null {
  if (!CONFIG.aging.protectRealCareer || !coach?.formerPlayerId || employerOf(state, coach)) return null;
  const out = runComebacks(state, [coach.formerPlayerId]);
  if (!out.returned.length) return null;
  syncSynergies(state, { full: true });
  comebackNews(state, { returned: out.returned, skipped: [] }, false);
  return out.returned[0].handle;
}

/** 解除主教练职务后复出时附在操作结果后的说明 */
export function comebackReleaseNote(handle: string | null): string {
  return handle ? `；${handle} 宣布复出（现实中的职业生涯仍在继续），以自由身回到转会市场` : '';
}

// ---------------------------------------------------------------------------
// 新闻 / 通知（平实文案）
// ---------------------------------------------------------------------------

/** 「Insania（五号位 · S 级）」 */
function detail(state: GameState, id: string): string {
  const p = state.players[id];
  if (!p) return id;
  return `${p.handle}（${POSITION_CN[p.position] ?? p.position} · ${playerTier(p)} 级）`;
}

function teamName(state: GameState, teamId: string): string {
  return ownEntry(state.teams, teamId)?.name ?? teamId;
}

/** notify：每支人类玩家战队另收一条总览通知（读档迁移）；否则只发公开新闻（解除主教练职务后复出） */
function comebackNews(state: GameState, res: RealCareerMigration, notify: boolean): void {
  const max = Math.max(1, Math.floor(CONFIG.aging.comebackNewsMax));
  // 展示顺序：等级从高到低，同级按显示 ID
  const ids = res.returned.map((r) => r.playerId).sort((a, b) => {
    const pa = state.players[a];
    const pb = state.players[b];
    const d = tierIndex(playerTier(pb)) - tierIndex(playerTier(pa));
    if (d) return d;
    const ha = (pa.handle ?? a).toLowerCase();
    const hb = (pb.handle ?? b).toLowerCase();
    return ha < hb ? -1 : ha > hb ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const shown = ids.slice(0, max);
  const more = ids.length > max ? ` 等 ${ids.length} 人` : '';
  const skippedIds = res.skipped.map((s) => s.playerId);
  let title: string;
  if (ids.length === 1) title = `【复出】${state.players[ids[0]].handle} 宣布复出`;
  else if (ids.length > 1) title = `【复出】${ids.length} 名选手宣布复出`;
  else if (res.skipped.length === 1) title = `【复出】${res.skipped[0].handle} 继续执教`;
  else title = `【复出】${res.skipped.length} 名退役选手继续执教`;
  let body = '';
  if (ids.length) {
    body += `${shown.map((id) => state.players[id].handle).join('、')}${more} 宣布复出（现实中的职业生涯仍在继续），以自由身回到转会市场。`;
    body += `复出选手：${shown.map((id) => detail(state, id)).join('、')}${more}。`;
    const left = res.returned.filter((r) => r.leftTeamIds.length);
    if (left.length) {
      body += `${left.map((r) => `${r.handle} 卸任 ${r.leftTeamIds.map((t) => teamName(state, t)).join('、')} 主教练`).join('；')}。`;
    }
  }
  if (res.skipped.length) {
    const who = res.skipped.length === 1 ? '他' : '他们';
    body += `${res.skipped.map((s) => `${s.handle} 现任 ${teamName(state, s.teamId)} 主教练`).join('；')}，继续执教，暂不复出；`
      + `在${who}现实中的职业生涯结束之前解除其主教练职务，${who}即以自由身回到转会市场。`;
  }
  addNews(state, 'transfer', title, body, true, {
    playerIds: [...shown, ...skippedIds],
    scope: 'world',
    visibility: 'public',
    tags: ['comeback'],
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
