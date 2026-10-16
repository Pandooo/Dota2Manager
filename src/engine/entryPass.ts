// 入场的下一回合 AI 接手（v0.4.3，【用户指定】2026-10-16「要，且真实战队优先」；参数 CONFIG.realEntry.aiPass）
//
// 背景：未被抽走的真实新秀、赛季初入场的复出 / 新面孔真实选手以自由身进入自由市场后，入场的回合内 AI 战队不签（公平窗口，marketEntry.ts）。
// AI 平时只在赛季初、赛季中期转会窗口与补员时从自由市场签人，所以公平窗口实际上成了人类玩家大半个赛季的独占期，
// 真实选手也很少回到自己的真实战队。用户决定：入场的下一回合由 AI 接手一次，真实战队优先。
//
// 时机：入场回合 E（Player.marketEntry.round；转会窗口锁定时入场的记为下个赛季初 {TI + 1, 0}）的下一个回合 E + 1 结束时
// （season.endRound：本回合比赛、人类玩家的自动训练、AI 训练、工资、挂牌处理之后，羁绊同步之前）。人类玩家在入场回合（AI 不签）
// 与下一回合（推进之前）都可以先签；懒人推进的自动补员也在推进之前执行。E + 1 回合内、接手之前 AI 的其他签约途径（赛季中期窗口、补员）
// 同样不签（marketEntry.aiSigningHeld，'pass'），接手是 AI 的第一次机会。E + 1 是 TI 预选（转会窗口锁定）时没有接手，
// 下个赛季初按往届记录清理（只有入场回合是最后一个常规赛回合时才会这样，如该回合解除主教练职务）。
//
// 每名仍未签约的新入场选手只处理一次（处理后清除 marketEntry）：
//   1. 真实战队优先：他当届真实阵容数据中的战队（clubIndex.realOrgOfPlayerAt；本届新秀即出道战队）在本局中存在、未解散、是 AI 战队，
//      付得起（同 AI 签自由选手：market.canAfford，签字费 + 工资 × ai.signBudgetRounds）、有空位（正式阵容 < ai.maxRoster，
//      否则放走能放走的最弱替补——非使命成员、比他弱，从不动首发），并且谈判骰子通过（market.negotiationRoll < 加盟意愿，
//      与人类玩家签约同一种确定性骰子；他是该队使命成员时意愿加 missions.willBonus，同使命引进）→ 签回。同一支真实战队可以签回多名自家选手（每人仍各自检查预算 / 空位 / 意愿）。
//      合同条件（用户选择的 (A)「新秀按旧的新秀合同条件」）：出道赛季的真实新秀（未被抽走而入场，Player.gacha.placed 且抽卡出身 TI = 本届）
//      按 v0.4.2 按真实出道去向加盟的新秀合同签回——无签字费、工资 gacha.gachaRookieSalary、合同 gacha.rookieContractSeasons 个赛季，
//      预算按这份工资检查（canAfford(签字费 0, 新秀工资)）；复出 / 新面孔与第 2 步的签约按 AI 签自由选手（签字费 + 市场工资）。
//   2. 否则按 AI 平常的需求给一次机会：补缺失的位置，或本队最弱的首发正好在他的本职位置、他比其强 ai.upgradeMinGain 倍
//      （「需要」按 ai.tryUpgrade 的口径：只看全队最弱的那名首发，不是他所在位置的首发；首发优先级锁定的位置除外），付得起、有空位、加盟意愿 ≥ ai.minWillingness（AI 签自由选手的门槛）的 AI 战队中，
//      补缺位优先、其次提升最多（同分按战队 id）。真实战队（第 1 步没签成）、本次已签过人的战队不参与；每队每次至多一人。
//      AI 战队生效中使命的缺失成员（现实巅峰阵容，如 TI8 的 Topson 之于 OG）不在这一步签——AI 窗口里使命俱乐部总是先引进自家巅峰阵容成员，
//      这里不让别队抢先（实测：不保护时第 1 步没签成的 Topson 7/12 局在第 2 步被别队签走，此前 12/12 局在中期窗口回到 OG）。
// 空位：签下后正式阵容超出 ai.maxRoster 时放走 k 名替补回到上限（同 AI 抽卡后的阵容整理 gacha.trimAiAfterPull；阵容本来就超出上限时 k 可以大于 1，极少见），
// 要放走的替补都必须比他弱，从不动首发与本队使命成员。
// 顺序：选手按综合评分降序（同分按 id），确定性；自由选手条件的签约用 AI 签约同一套（market.aiSignFreeAgent，合同年限取主随机序列），新秀合同不消耗随机数。
// 只涉及 AI 战队与自由选手、发一条公开新闻（标题写最重要的一两笔：真实战队签回优先，其次等级），多人模式与座位无关（在中性上下文中执行）。
// 当届真实战队是人类玩家战队时没有优先：入场时给该战队一条总览通知（notifyHumanRealTeams，AI 接手审查），提醒自己签。
import { CONFIG, POSITION_LABEL } from './config';
import { getPlayerIndex } from '../data/index';
import type { GameState, Player, PlayerIndexEntry, Team } from './types';
import { addNews, pushPopup } from './news';
import {
  aiSignFreeAgent, canAfford, departToFreeAgency, executeTransfer, freeAgents, isTransferWindowOpen, negotiationRoll, playerWillingness,
  regularRoster, signingFee,
} from './market';
import { gachaRookieContractSeasons, gachaRookieSalary } from './gacha';
import { startRookieContract } from './salary';
import { computeSalary, overallRating, playerRating, playerTier, tierIndex } from './player';
import { activeTeams, autoLineup, benchPlayers, lineupPlayers } from './team';
import { inSeatOf, isHumanTeam, isMultiplayer, seatInPlay } from './seat';
import { inMarketEntryRound } from './marketEntry';
import { orgOfTeamId, realOrgOfPlayerAt } from './clubIndex';
import { orgTeam } from './clubs';
import { isMissionPlayerOf, missionClubs, missionInEffect, missionTargets, missionWillingness, refreshMissions } from './missions';
import { aiLineupPriority, lineupPriorityLocks } from './lineupPriority';
import { naturalPositions, uncoveredPositions } from './roles';

/** 一次签约：realTeam = 当届真实战队签回（第 1 步）；rookieContract = 按新秀合同签回出道赛季的真实新秀（只在第 1 步）；released = 为腾出位置放走的替补 */
export interface EntryPassSigning {
  playerId: string;
  teamId: string;
  realTeam: boolean;
  rookieContract?: true;
  released: string[];
}

export interface EntryPassReport {
  ti: number;
  round: number;
  /** 本次处理的新入场选手（签下或没签下） */
  considered: string[];
  signings: EntryPassSigning[];
}

let INDEX: Map<string, PlayerIndexEntry> | null = null;
function indexEntry(id: string): PlayerIndexEntry | undefined {
  if (!INDEX) {
    INDEX = new Map();
    try {
      for (const e of getPlayerIndex() ?? []) if (e?.id) INDEX.set(e.id, e);
    } catch {
      /* 无索引（测试替身等） */
    }
  }
  return INDEX.get(id);
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 是否轮到 AI 接手：入场时刻在本赛季、早于当前回合（入场回合已过去），选手仍是自由身 */
export function entryPassDue(state: GameState, p: Pick<Player, 'marketEntry' | 'teamId'> | null | undefined): boolean {
  const e = p?.marketEntry;
  if (!e || p.teamId) return false;
  return e.ti === state.season?.ti && e.round < state.roundIndex;
}

/** 可以参与接手的 AI 战队（未解散、不是人类玩家战队、有正式队员） */
function isAiClub(state: GameState, t: Team | null | undefined): t is Team {
  return !!t && !t.disbanded && !t.isPlayer && !isHumanTeam(state, t.id) && regularRoster(state, t.id).length > 0;
}

/**
 * 选手当届的真实战队（本局中对应的战队，可能是人类玩家战队；不存在 / 已解散返回 null）：当届真实阵容数据中他所在的组织；
 * 当届数据没有他的战队记录、而本届是他的出道届时，退回真实选手索引的出道战队（playerIndex.firstTeamId）。
 */
export function entryRealTeam(state: GameState, p: Pick<Player, 'id'>, ti: number = state.season?.ti ?? 0): Team | null {
  const org = realOrgOfPlayerAt(p.id, ti);
  if (org) return orgTeam(state, org);
  const e = indexEntry(p.id);
  if (!e?.firstTeamId || Number(e.firstTi) !== ti) return null;
  const firstOrg = orgOfTeamId(e.firstTeamId);
  if (firstOrg) return orgTeam(state, firstOrg);
  const t = state.teams[e.firstTeamId];
  return t && !t.disbanded ? t : null;
}

/** 签下他（未签下时 + 1）之后为回到 ai.maxRoster 可以放走的替补：非首发、非临时替补、不是本队生效中使命的成员、不是他本人，评分从低到高（同分按 id） */
function releasable(state: GameState, team: Team, p: Player): { k: number; cands: Player[] } {
  const roster = regularRoster(state, team.id);
  const k = roster.length + (roster.some((q) => q.id === p.id) ? 0 : 1) - CONFIG.ai.maxRoster;
  if (k <= 0) return { k: 0, cands: [] };
  const peak = new Set(missionInEffect(state, team.id)?.peak.players ?? []);
  const cands = benchPlayers(state, team.id)
    .filter((q) => q.id !== p.id && !q.tempSubUntilTournament && !q.isWildSub && !peak.has(q.id))
    .sort((a, b) => overallRating(a) - overallRating(b) || byId(a, b));
  return { k, cands };
}

/**
 * 空位：正式阵容 + 1 不超过 ai.maxRoster；否则要放走的 k 名替补（releasable 的前 k 名）都必须比他弱，从不动首发。
 */
function hasRoom(state: GameState, team: Team, p: Player): boolean {
  const { k, cands } = releasable(state, team, p);
  if (k <= 0) return true;
  if (cands.length < k) return false;
  const r = overallRating(p);
  return cands.slice(0, k).every((q) => overallRating(q) < r);
}

/**
 * 出道赛季的真实新秀（未被抽走、以自由身入场：抽卡出身 placed 且出身 TI = 本届）：第 1 步由出道 / 当届真实战队按旧的新秀合同签回
 * （用户选择的 (A)「新秀按旧的新秀合同条件」，同 v0.4.2 按真实出道去向加盟）
 */
export function entryPassRookieTerms(state: GameState, p: Pick<Player, 'gacha'>): boolean {
  const g = p.gacha;
  return !!g && g.kind === 'real' && !!g.placed && g.ti === state.season?.ti;
}

/** 签约条件：新秀合同（无签字费、新秀工资、新秀合同年限）或自由选手（签字费 + 市场工资） */
function terms(state: GameState, p: Player, rookie: boolean): { fee: number; salary: number } {
  return rookie ? { fee: 0, salary: gachaRookieSalary(state, p) } : { fee: signingFee(state, p), salary: computeSalary(state, p) };
}

/** 预算：同 AI 签自由选手的规则（付完签字费后余额覆盖（现有工资 + 他的工资）× ai.signBudgetRounds），按这次签约的条件计算 */
function affordable(state: GameState, team: Team, p: Player, rookie = false): boolean {
  const { fee, salary } = terms(state, p, rookie);
  return team.gold > 0 && canAfford(state, team, fee, salary);
}

/**
 * 第 1 步的意愿：与人类玩家签约同一种确定性谈判骰子（同一回合、同一选手与战队结果固定）。他是这支战队生效中使命（现实巅峰阵容）的成员时，
 * 加盟意愿按使命引进的口径加 missions.willBonus（missions.missionWillingness，同 AI 窗口里使命俱乐部引进自家巅峰阵容成员）。
 */
export function entryPassWilling(state: GameState, p: Player, team: Team): boolean {
  const will = isMissionPlayerOf(state, p.id, team.id) ? missionWillingness(state, p, team.id) : playerWillingness(state, p.id, team.id);
  return negotiationRoll(state, `entry|${p.id}|${team.id}`) < will;
}

/**
 * 签下（自由选手条件：AI 签约同一套；新秀合同：无签字费、新秀工资与合同年限、归属感不变，同 v0.4.2 按真实出道去向加盟），
 * 按签下后的阵容放走最弱的可放走替补回到 ai.maxRoster（不动首发与他本人），重新排阵
 */
function sign(state: GameState, team: Team, p: Player, pool: Player[], realTeam: boolean, rookie = false): EntryPassSigning | null {
  if (rookie) {
    executeTransfer(state, p.id, team.id, 0, { salary: gachaRookieSalary(state, p), contractSeasons: gachaRookieContractSeasons(), loyalty: p.loyalty });
    if (p.teamId === team.id) startRookieContract(p);
    const i = pool.indexOf(p);
    if (i >= 0) pool.splice(i, 1);
  } else {
    aiSignFreeAgent(state, team, p, pool);
  }
  if (p.teamId !== team.id) return null;
  autoLineup(state, team.id);
  const released: string[] = [];
  const { k, cands } = releasable(state, team, p);
  for (const q of cands.slice(0, Math.max(0, k))) {
    departToFreeAgency(state, q.id);
    if (!q.teamId) released.push(q.id);
  }
  autoLineup(state, team.id);
  return { playerId: p.id, teamId: team.id, realTeam, ...(rookie ? { rookieContract: true as const } : {}), released };
}

/**
 * 第 2 步：AI 平常的需求评分（null = 不需要他），同 AI 补员 / 补强（market.fillRosterFromMarket、ai.tryUpgrade）：
 * 他能补上缺失的位置（本职覆盖不到 / 首发空缺）→ 1e6 + 该位置评分；否则本队最弱的首发（首发优先级锁定的位置——使命 / 巅峰选手
 * 打本位置——除外）在他的本职位置上、且他在该位置的评分超过其 ai.upgradeMinGain 倍 → 评分差。
 */
function needScore(state: GameState, team: Team, p: Player): number | null {
  const missing = uncoveredPositions(regularRoster(state, team.id));
  const slots = lineupPlayers(state, team.id);
  let best: number | null = null;
  for (const pos of naturalPositions(p)) {
    if (!missing.includes(pos) && slots.find((s) => s.pos === pos)?.player) continue;
    const score = 1e6 + playerRating(p, pos);
    if (best === null || score > best) best = score;
  }
  if (best !== null) return best;
  const prio = aiLineupPriority(state, team.id);
  let weakest: { pos: Player['position']; rating: number } | null = null;
  for (const s of slots) {
    if (!s.player || lineupPriorityLocks(state, team.id, s.player, s.pos, p, prio)) continue;
    const r = playerRating(s.player, s.pos);
    if (!weakest || r < weakest.rating) weakest = { pos: s.pos, rating: r };
  }
  if (!weakest || !naturalPositions(p).includes(weakest.pos)) return null;
  const rating = playerRating(p, weakest.pos);
  return rating > weakest.rating * CONFIG.ai.upgradeMinGain ? rating - weakest.rating : null;
}

/**
 * season.endRound 调用：对入场回合已过去、仍是自由身的新入场真实选手做一次 AI 接手（规则见文件头）。
 * 转会窗口锁定 / 游戏结束 / 开关关闭时不处理（不清除入场时刻）。有签约时发一条公开新闻。返回本次汇总（未处理时 null）。
 */
export function runEntryPass(state: GameState): EntryPassReport | null {
  if (!CONFIG.realEntry?.aiPass || state.gameOver || !state.season || !isTransferWindowOpen(state)) return null;
  const pool = freeAgents(state);
  const due = pool
    .filter((p) => entryPassDue(state, p))
    .sort((a, b) => overallRating(b) - overallRating(a) || byId(a, b));
  if (!due.length) return null;
  const ti = state.season.ti;
  const report: EntryPassReport = { ti, round: state.roundIndex, considered: due.map((p) => p.id), signings: [] };
  const signedTeams = new Set<string>();
  const rest: { p: Player; home: string | null }[] = [];

  // 1. 当届真实战队优先（出道赛季的真实新秀按新秀合同）
  for (const p of due) {
    const home = entryRealTeam(state, p, ti);
    const rookie = entryPassRookieTerms(state, p);
    if (isAiClub(state, home) && affordable(state, home, p, rookie) && hasRoom(state, home, p) && entryPassWilling(state, p, home)) {
      const s = sign(state, home, p, pool, true, rookie);
      if (s) {
        report.signings.push(s);
        signedTeams.add(home.id);
        continue;
      }
    }
    rest.push({ p, home: home?.id ?? null });
  }

  // 2. AI 平常的需求（每队至多一人；真实战队与本次已签过人的战队不参与）。AI 战队生效中使命的缺失成员（现实巅峰阵容）不在这一步签：
  //    AI 窗口里使命俱乐部总是先于其他操作引进自家巅峰阵容成员（ai.aiTransferWindow → missions.aiPursueMission），这里不让别队抢先
  const teams = activeTeams(state).filter((t) => isAiClub(state, t)).sort(byId);
  const reserved = new Set<string>();
  for (const t of missionClubs(state)) if (isAiClub(state, t)) for (const q of missionTargets(state, t.id)) reserved.add(q.id);
  for (const { p, home } of rest) {
    if (p.teamId || p.status !== 'active' || reserved.has(p.id)) continue;
    let pick: Team | null = null;
    let pickScore = -Infinity;
    for (const t of teams) {
      if (t.id === home || signedTeams.has(t.id)) continue;
      const score = needScore(state, t, p);
      if (score === null || !(score > pickScore)) continue;
      if (!affordable(state, t, p) || !hasRoom(state, t, p)) continue;
      if (playerWillingness(state, p.id, t.id) < CONFIG.ai.minWillingness) continue;
      pick = t;
      pickScore = score;
    }
    if (!pick) continue;
    const s = sign(state, pick, p, pool, false);
    if (s) {
      report.signings.push(s);
      signedTeams.add(pick.id);
    }
  }

  // 每名选手只接手一次：没签下的清除入场时刻（此后与普通自由选手相同）
  for (const p of due) if (!p.teamId) delete p.marketEntry;
  if (report.signings.length) {
    refreshMissions(state); // 签回的可能是使命成员：刷新使命进度（新集齐的发新闻）
    passNews(state, report);
  }
  return report;
}

/**
 * 新闻：一条公开新闻。顺序：当届真实战队签回在前，其次等级从高到低（同等级按 ID）。标题写最重要的一两笔
 * （「【转会】OG 签回 Topson」「【转会】OG 签回 Topson、LGD 签回 Chalice 等 12 人」），正文每笔一行
 * 「OG 签回 Topson（S 级 · 2号位 中单 · 新秀合同）」，最多 realEntry.newsMax 行
 */
function passNews(state: GameState, report: EntryPassReport): void {
  const max = Math.max(1, Math.floor(Number(CONFIG.realEntry?.newsMax) || 12));
  const handleKey = (p: Player) => p.handle.toLowerCase();
  const rows = report.signings
    .map((s) => ({ s, p: state.players[s.playerId], team: state.teams[s.teamId] }))
    .filter((r) => !!r.p && !!r.team)
    .sort((a, b) => Number(b.s.realTeam) - Number(a.s.realTeam)
      || tierIndex(playerTier(b.p)) - tierIndex(playerTier(a.p))
      || (handleKey(a.p) < handleKey(b.p) ? -1 : handleKey(a.p) > handleKey(b.p) ? 1 : byId(a.p, b.p)));
  if (!rows.length) return;
  const line = (r: (typeof rows)[number]) => `${r.team.name} ${r.s.realTeam ? '签回' : '签下'} ${r.p.handle}`;
  const shown = rows.slice(0, max);
  const n = rows.length;
  const head = rows.slice(0, 2).map(line).join('、');
  const title = `【转会】${head}${n > 2 ? ` 等 ${n} 人` : ''}`;
  const body = '入场回合之后，AI 战队对仍未签约的新入场真实选手做了一次签约（当届真实战队优先）：'
    + shown.map((r) => `${line(r)}（${playerTier(r.p)} 级 · ${POSITION_LABEL[r.p.position] ?? r.p.position}${r.s.rookieContract ? ' · 新秀合同' : ''}）`).join('；')
    + (n > max ? `；另有 ${n - max} 人` : '')
    + '。';
  addNews(state, 'transfer', title, body, rows.some((r) => tierIndex(playerTier(r.p)) >= tierIndex('S')), {
    playerIds: shown.map((r) => r.p.id),
    teamIds: [...new Set(shown.map((r) => r.team.id))],
    scope: 'world',
    visibility: 'public',
    tags: ['transfer'],
    noInfer: true,
  });
}

/**
 * 当届真实战队是人类玩家战队的新入场选手（本回合入场、仍是自由身）：给该战队一条总览通知——AI 接手不会替人类玩家战队签下他，
 * 本回合与下一回合可以先签，下一回合结束时需要他的 AI 战队可能签下他。season.ts 在入场之后调用（赛季初复出 / 新面孔入场后、
 * 第 1 回合真实新秀离池后）。开关 realEntry.aiPass 关闭时不发。不消耗随机数；多人模式写入各自座位（出局的座位不发）。
 */
export function notifyHumanRealTeams(state: GameState): void {
  if (!CONFIG.realEntry?.aiPass || !CONFIG.realEntry?.aiHoldEntryRound || state.gameOver || !state.season) return;
  const byTeam = new Map<string, Player[]>();
  for (const p of freeAgents(state)) {
    if (!p.isReal || !inMarketEntryRound(state, p)) continue;
    const home = entryRealTeam(state, p);
    if (!home || home.disbanded || !(home.isPlayer || isHumanTeam(state, home.id))) continue;
    const list = byTeam.get(home.id) ?? [];
    list.push(p);
    byTeam.set(home.id, list);
  }
  for (const teamId of [...byTeam.keys()].sort()) {
    if (isMultiplayer(state) && !seatInPlay(state, teamId)) continue;
    const ps = byTeam.get(teamId)!.sort((a, b) => overallRating(b) - overallRating(a) || byId(a, b));
    const who = ps.length === 1 ? '他' : '他们';
    const names = ps.map((p) => `${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position] ?? p.position}）`).join('、');
    const title = ps.length === 1
      ? `【新入场】你的战队是 ${ps[0].handle} 的当届真实战队`
      : `【新入场】你的战队是 ${ps.length} 名新入场选手的当届真实战队`;
    const body = `${names} 以自由身进入自由市场，你的战队是${who}现实中当届效力的战队。`
      + `AI 不会替你签下${who}：本回合 AI 战队不签，你可以在「转会 › 自由选手」中签约；下一回合结束时需要${who}的 AI 战队可能签下${who}。`;
    inSeatOf(state, teamId, () => pushPopup(state, { kind: 'message', title, body }));
  }
}
