// ============================================================================
// 俱乐部全员假赛（第八波 #6；用户确认：每支战队每个赛季 0.1%）
//
// 赛季初（season.startSeason，赛程生成之后）每支未解散的战队（含玩家战队）掷一次
// CONFIG.scandal.clubBanChancePerSeason；命中则在本赛季随机一个常规赛回合曝光（season.enterRound 开始时、
// 随机事件之前）。一旦曝光：俱乐部与全部正式队员永久禁赛（选手 status = 'banned'），发布公开重磅新闻。
//   - AI 俱乐部：除名，由新组织补位以维持联赛规模（generation.generateAiTeam），新组织接替其本赛季尚未开赛的赛事邀请；
//   - 单机玩家的俱乐部：游戏立即结束（gameOver.reason = 'banned'），进入专门的结局与生涯总结；
//   - 多人模式的玩家座位：该座位出局（seat.eliminated，转为观战），其余玩家继续；
//     全部座位出局时由 multi.processEliminations 判定游戏结束。
//
// 第九波 #4：只在常规赛回合计划与曝光 —— TI 预选与 TI 正赛回合期间禁赛类结果为 0（用户要求）；
// 人类俱乐部的概率另乘 CONFIG.humanEvents.clubBanMult（默认 1，保持用户确认的 0.1%）。
//
// 随机数：每队每赛季使用独立的确定性子随机流 seededRng(hash(state.id | ti | teamId))（与 market.ts 的确定性噪声同法），
// 不消耗主随机序列 —— 0.1% 的掷骰不会扰动其余模拟，存档可复现；只有真正曝光时才会用 rngOf 生成补位新组织。
// ============================================================================
import type { ClubBanRecord, ClubScandalPlan, ClubScandalState, GameState, Team } from './types';
import { CONFIG } from './config';
import { hashSeed, seededRng } from './rng';
import { regularRoundCount } from './calendar';
import { departToFreeAgency } from './market';
import { generateAiTeam } from './generation';
import { addNews, pushPopup } from './news';
import {
  forEachSeat, humanTeamIds, inSeatOf, isHumanTeam, isMultiplayer, removePendingDecisionsEverywhere, seatOf,
} from './seat';
import { legacyCareerSummary, recordLegacyPartial } from './legacy';
import { isTiEventRound } from './events';

/**
 * 计划曝光回合必须是常规赛回合（第九波 #4：TI 预选 / TI 正赛回合不会出现禁赛类结果）。
 * 掷骰结果 1..常规赛回合数 在现行赛历中本就都是常规赛回合；回合表异常时退到最后一个常规赛回合，没有常规赛回合时返回 null（不计划）。
 */
function regularRoundFor(state: GameState, round: number): number | null {
  const rounds = state.season?.rounds;
  if (!Array.isArray(rounds) || !rounds.length) return round;
  if (rounds[round]?.phase === 'regular') return round;
  let last: number | null = null;
  for (const r of rounds) if (r?.phase === 'regular' && (last === null || r.index > last)) last = r.index;
  return last;
}

/** 读取（必要时初始化）全员假赛状态；旧存档缺失时补齐 */
export function clubScandalState(state: GameState): ClubScandalState {
  const cur = state.clubScandals;
  if (cur && Array.isArray(cur.plans) && Array.isArray(cur.history)) return cur;
  const fixed: ClubScandalState = {
    plans: Array.isArray(cur?.plans) ? cur!.plans : [],
    history: Array.isArray(cur?.history) ? cur!.history : [],
  };
  state.clubScandals = fixed;
  return fixed;
}

/**
 * 纯函数：某队某赛季的全员假赛掷骰（确定性子随机流）。命中返回曝光回合（1..regularRounds），否则 null。
 * 每队每赛季恰好掷一次；chance 为该赛季的发生概率。
 */
export function clubScandalRoll(
  seedKey: string, ti: number, teamId: string, chance: number, regularRounds: number,
): number | null {
  const p = Number.isFinite(chance) ? Math.min(1, Math.max(0, chance)) : 0;
  if (p <= 0) return null;
  const rng = seededRng(hashSeed(`${seedKey}|club-scandal|${ti}|${teamId}`));
  // 先空转一次：FNV 种子相邻时 mulberry32 首个输出的低位相关性更弱
  rng.next();
  if (!rng.chance(p)) return null;
  const rounds = Math.max(1, Math.floor(regularRounds));
  return rng.int(1, rounds);
}

/**
 * 赛季初掷骰（season.startSeason 调用，赛程 / 回合表生成之后）：每支未解散且有阵容的战队（玩家战队总是参与）掷一次，
 * 命中的写入 clubScandals.plans。旧赛季未触发的计划清除。返回本赛季的计划。
 */
export function rollClubScandals(state: GameState): ClubScandalPlan[] {
  const s = clubScandalState(state);
  const ti = state.season?.ti ?? 0;
  s.plans = s.plans.filter((p) => p.season === ti && !p.fired);
  const chance = CONFIG.scandal?.clubBanChancePerSeason ?? 0;
  if (!(chance > 0) || !state.season) return s.plans;
  const rounds = regularRoundCount(state.season);
  const seedKey = state.id || 'game';
  // 同一赛季重复调用（防御）：已有计划的战队不重复；其余战队的掷骰是确定性的，结果不变
  const planned = new Set(s.plans.map((p) => p.teamId));
  for (const id of Object.keys(state.teams).sort()) {
    const t = state.teams[id];
    if (!t || t.disbanded || t.banned || planned.has(id)) continue;
    const human = isHumanTeam(state, id);
    if (!t.playerIds?.length && !human) continue;
    // 人类俱乐部的概率倍数（CONFIG.humanEvents.clubBanMult，默认 1 = 用户确认的 0.1%）；AI 不变
    const mult = human ? CONFIG.humanEvents?.clubBanMult ?? 1 : 1;
    const p = human ? chance * (Number.isFinite(mult) ? Math.max(0, mult) : 1) : chance;
    const round = clubScandalRoll(seedKey, ti, id, p, rounds);
    const at = round === null ? null : regularRoundFor(state, round);
    if (at !== null) s.plans.push({ teamId: id, season: ti, round: at });
  }
  return s.plans;
}

/**
 * 回合开始时曝光到期的全员假赛（season.enterRound 在随机事件之前调用；只在常规赛回合）。
 * 返回本回合曝光的记录。单机玩家战队被禁赛时设置 gameOver，调用方应随即停止推进。
 */
export function fireDueClubScandals(state: GameState, roundIdx: number): ClubBanRecord[] {
  const s = state.clubScandals;
  if (!s?.plans?.length || state.gameOver) return [];
  // TI 预选 / TI 正赛回合不曝光（第九波 #4：TI 期间禁赛类结果为 0；现行流程本就只在常规赛回合调用，此处兜底）
  if (isTiEventRound(state) || state.season?.rounds?.[roundIdx]?.phase === 'ti_qualifier'
    || state.season?.rounds?.[roundIdx]?.phase === 'ti') return [];
  const ti = state.season?.ti ?? 0;
  const out: ClubBanRecord[] = [];
  for (const plan of s.plans) {
    if (plan.fired || plan.season !== ti || plan.round > roundIdx) continue;
    plan.fired = true;
    const rec = banClub(state, plan.teamId);
    if (rec) out.push(rec);
    if (state.gameOver) break;
  }
  s.plans = s.plans.filter((p) => !p.fired);
  return out;
}

/** 写入荣誉 / 资金曲线的当前点（与 season.snapshotHistory 同口径；在该战队所属座位上下文中执行） */
function snapshotCurves(state: GameState, team: Team): void {
  inSeatOf(state, team.id, () => {
    const h = state.history;
    if (!h) return;
    const season = state.season?.ti ?? 0;
    const round = state.roundIndex ?? 0;
    const put = (arr: { season: number; round: number; value: number }[] | undefined, value: number) => {
      if (!Array.isArray(arr)) return;
      const last = arr[arr.length - 1];
      if (last && last.season === season && last.round === round) last.value = value;
      else arr.push({ season, round, value });
    };
    put(h.honor, Math.round(team.honor));
    put(h.gold, Math.round(team.gold));
  });
}

/** 本赛季尚未开赛的赛事中，把被除名战队的位置交给补位新组织 */
function handOverInvites(state: GameState, oldId: string, newId: string): void {
  const swap = (list: string[] | undefined) => {
    if (!Array.isArray(list)) return;
    const i = list.indexOf(oldId);
    if (i < 0) return;
    if (list.includes(newId)) list.splice(i, 1);
    else list[i] = newId;
  };
  for (const tid of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[tid];
    if (!t || t.status !== 'scheduled') continue;
    swap(t.invitedTeamIds);
    swap(t.teamIds);
    swap(t.qualifierTeamIds);
  }
}

/**
 * 曝光一支俱乐部的全员假赛（测试与 fireDueClubScandals 使用）：
 * 俱乐部除名（disbanded + banned）、全部正式队员永久禁赛、主教练离队、相关报价 / 待决事件 / 延迟事件作废，公开重磅新闻；
 * AI 俱乐部由新组织补位；玩家俱乐部：单机 → gameOver('banned')；多人 → 该座位出局（观战）。
 * 战队不存在、已解散或已禁赛时返回 null（幂等）。
 */
export function banClub(state: GameState, teamId: string): ClubBanRecord | null {
  const team = state.teams[teamId];
  if (!team || team.disbanded || team.banned) return null;
  const human = isHumanTeam(state, teamId);
  const mp = isMultiplayer(state);
  const ti = state.season?.ti ?? 0;
  const round = state.roundIndex ?? 0;
  const date = state.currentDate ?? '';

  // 生涯档案：先冻结截至当下的赛季（阵容在禁赛前记录；在该座位上下文中读取其私有的赛事结算 / 账目）
  if (human) {
    try {
      inSeatOf(state, teamId, () => recordLegacyPartial(state, teamId, 'banned'));
    } catch (e) {
      console.error('[engine] recordLegacyPartial', e);
    }
  }

  // 1. 选手：正式队员永久禁赛；临时 / 野外替补按正常离队处理
  const bannedIds: string[] = [];
  const bannedHandles: string[] = [];
  for (const pid of team.playerIds.slice()) {
    const p = state.players[pid];
    if (!p) continue;
    if (p.tempSubUntilTournament || p.isWildSub) {
      departToFreeAgency(state, pid);
      continue;
    }
    departToFreeAgency(state, pid);
    p.status = 'banned';
    delete p.transferListing;
    bannedIds.push(pid);
    bannedHandles.push(p.handle);
  }
  team.playerIds = [];
  team.lineup = { C: null, M: null, O: null, SS: null, HS: null };

  // 2. 主教练离队进入教练市场
  if (team.coachId) {
    const c = state.coaches[team.coachId];
    if (c && c.teamId === teamId) c.teamId = null;
    team.coachId = null;
  }

  // 3. 除名
  team.disbanded = true;
  team.banned = { season: ti, round, date };

  // 4. 相关报价 / 待决事件 / 延迟事件作废
  const bannedSet = new Set(bannedIds);
  for (const o of state.transferOffers ?? []) {
    if (o.status !== 'pending') continue;
    if (o.fromTeamId === teamId || o.toTeamId === teamId || bannedSet.has(o.playerId)) o.status = 'expired';
  }
  removePendingDecisionsEverywhere(state, (d) => {
    const pid = d.ctx?.playerId;
    const tid = d.ctx?.teamId;
    return (typeof pid === 'string' && bannedSet.has(pid)) || tid === teamId
      || d.ctx?.buyerId === teamId || d.ctx?.fromTeamId === teamId;
  });
  if (Array.isArray(state.delayedEvents)) {
    state.delayedEvents = state.delayedEvents.filter((d) => {
      const pid = d.ctx?.playerId;
      return d.ctx?.teamId !== teamId && !(typeof pid === 'string' && bannedSet.has(pid));
    });
  }

  // 5. 补位（AI）或结局 / 出局（玩家）
  let replacement: Team | null = null;
  if (!human) {
    try {
      replacement = generateAiTeam(state, team.region, CONFIG.scandal?.replacementStrength ?? 'mid');
      replacement.replacesTeamId = team.id;
      replacement.lastSeasonRank = team.lastSeasonRank;
      handOverInvites(state, team.id, replacement.id);
    } catch (e) {
      console.error('[engine] club ban replacement', e);
      replacement = null;
    }
  }

  const rec: ClubBanRecord = {
    teamId, name: team.name, tag: team.tag, season: ti, round, date, players: bannedHandles, human,
    ...(replacement ? { replacementId: replacement.id } : {}),
  };
  clubScandalState(state).history.push(rec);

  // 6. 新闻（公开、重磅）
  const max = Math.max(1, CONFIG.scandal?.newsPlayerListMax ?? 8);
  const list = bannedHandles.length
    ? `${bannedHandles.slice(0, max).join('、')}${bannedHandles.length > max ? ` 等 ${bannedHandles.length} 人` : ''}`
    : '';
  const seat = seatOf(state, teamId);
  const tail = !human
    ? (replacement ? `联盟席位由新成立的 ${replacement.name}（${replacement.tag}）接替。` : '')
    : mp
      ? `玩家「${seat?.name ?? team.name}」的执教就此终止，转为观战。`
      : '你执教的俱乐部就此画上句号。';
  addNews(
    state,
    'event',
    `【重磅】${team.name} 全员假赛，俱乐部与全体队员永久禁赛`,
    `TI${ti} 赛季第 ${round} 回合（${date}），调查结果公布：${team.name}（${team.tag}）在多场比赛中操纵比赛结果，`
      + '牵涉俱乐部与全部正式队员。俱乐部即日起被永久除名'
      + (list ? `，${list} 终身禁赛。` : '。')
      + tail,
    true,
    {
      teamIds: replacement ? [team.id, replacement.id] : [team.id],
      playerIds: bannedIds,
      visibility: 'public',
      tags: ['scandal', 'club-ban', 'disband'],
      noInfer: true,
    },
  );
  if (replacement) {
    addNews(
      state,
      'transfer',
      `【新军】${replacement.name} 接替 ${team.name} 的联盟席位`,
      `${team.name} 被除名后，新组织 ${replacement.name}（${replacement.tag}）组建全新阵容加入 ${team.region} 赛区，`
        + '并接替其本赛季尚未开赛的赛事邀请。',
      true,
      { teamIds: [replacement.id, team.id], playerIds: replacement.playerIds.slice(), visibility: 'public', tags: ['disband'], noInfer: true },
    );
  }

  // 7. 玩家俱乐部：结局 / 出局
  if (human) {
    snapshotCurves(state, team);
    if (mp) {
      if (seat) {
        seat.eliminated = true;
        seat.ready = false;
      }
    } else if (!state.gameOver) {
      const summary = `${team.name} 全员假赛东窗事发：俱乐部被永久除名，${bannedHandles.length} 名队员终身禁赛。\n`
        + legacyCareerSummary(state, teamId, 'banned');
      state.gameOver = { reason: 'banned', summary };
      addNews(state, 'system', '执教生涯戛然而止', summary, true, { teamIds: [teamId], noInfer: true });
    }
  }

  // 8. 其他仍在比赛中的玩家：重磅弹窗
  const popupBody = `${team.name}（${team.tag}）全员假赛被永久除名${bannedHandles.length ? `，${bannedHandles.length} 名队员终身禁赛` : ''}。`
    + (replacement ? `新组织 ${replacement.name} 接替其联盟席位。` : '')
    + (human && mp ? `玩家「${seat?.name ?? team.name}」出局。` : '');
  forEachSeat(state, (me) => {
    if (me === teamId || state.gameOver) return;
    pushPopup(state, { kind: 'message', title: '重磅：俱乐部全员假赛', body: popupBody });
  });
  return rec;
}

/** 某战队是否因全员假赛被禁赛 */
export function isClubBanned(state: GameState, teamId: string | null | undefined): boolean {
  return !!teamId && !!state.teams[teamId]?.banned;
}

/** 全部人类战队中被禁赛的（多人模式结局判定用） */
export function bannedHumanTeamIds(state: GameState): string[] {
  return humanTeamIds(state).filter((id) => isClubBanned(state, id));
}
