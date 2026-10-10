// 荣誉系统【E3 负责实现】
import type { GameState, HonorBreakdown, Tournament } from './types';
import { CONFIG } from './config';
import { clamp, placementPercentile } from './util';
import { teamRating } from './team';
import { addNews } from './news';
import { inSeatOf, isMultiplayer, seatOf } from './seat';

/** 荣誉幸运度 luck = clamp(log10(1 + max(0,honor)/100), 0, CONFIG.honor.luckCap)，用于各类等级分布 */
export function honorLuck(honor: number): number {
  const h = Number.isFinite(honor) ? Math.max(0, honor) : 0;
  return clamp(Math.log10(1 + h / 100), 0, CONFIG.honor.luckCap);
}

/** 赛前预期评分：teamRating × (1 + expectationHonorWeight × log10(1 + honor/100)) */
export function expectationScore(state: GameState, teamId: string): number {
  const team = state.teams[teamId];
  if (!team) return 0;
  const rating = teamRating(state, teamId);
  const honor = Number.isFinite(team.honor) ? Math.max(0, team.honor) : 0;
  const v = rating * (1 + CONFIG.honor.expectationHonorWeight * Math.log10(1 + honor / 100));
  return Number.isFinite(v) ? v : 0;
}

function uniq(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

/** 按评分降序排名（同分按 id 保证确定性），返回 id → 名次（1 起） */
function rankBy(ids: string[], score: Map<string, number>): Map<string, number> {
  const sorted = ids.slice().sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const out = new Map<string, number>();
  sorted.forEach((id, i) => out.set(id, i + 1));
  return out;
}

/**
 * 全部参赛队的赛前预期名次（一次性计算，避免逐队 O(n²) 评分）。
 * - 直邀/正赛队：在「正赛队 + 预计从预选晋级的队伍」中排名（与正赛规模一致）
 * - 封闭预选队：预选池中评分前 slots 名视为预计晋级，按正赛池排名；其余预计止步预选，名次排在正赛之后
 */
export function computeExpectedRanks(state: GameState, t: Tournament): Record<string, number> {
  const quals = uniq(t.qualifierTeamIds.filter((id) => state.teams[id]));
  const qualSet = new Set(quals);
  const all = uniq([...t.teamIds, ...t.qualifierTeamIds]).filter((id) => state.teams[id]);
  const score = new Map<string, number>();
  for (const id of all) score.set(id, expectationScore(state, id));

  const out: Record<string, number> = {};
  if (quals.length === 0) {
    rankBy(all, score).forEach((r, id) => { out[id] = r; });
    return out;
  }
  const direct = all.filter((id) => !qualSet.has(id));
  const qStage = t.stages.find((s) => s.type === 'qualifier');
  let projected: string[];
  if (qStage?.done) {
    projected = quals.filter((id) => t.teamIds.includes(id));
  } else {
    const slots = Math.max(1, t.qualifierSlots ?? CONFIG.tournament.qualifierSlotsPerEvent);
    projected = quals.slice().sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0)).slice(0, slots);
  }
  const mainPool = uniq([...direct, ...projected]);
  const mainRanks = rankBy(mainPool, score);
  for (const id of direct) out[id] = mainRanks.get(id) ?? mainPool.length;
  // 预选队：预计晋级者按正赛池排名；其余预计止步预选，排在正赛之后（按预选池内评分）。
  // 否则评分居中、却注定要和 7 支同档队伍争 2 个名额的队伍会被预期为正赛中游，预选出局就系统性扣荣誉。
  const projectedSet = new Set(projected);
  for (const id of projected) out[id] = mainRanks.get(id) ?? mainPool.length;
  const rest = quals.filter((id) => !projectedSet.has(id));
  const restRanks = rankBy(rest, score);
  for (const id of rest) out[id] = Math.min(all.length, mainPool.length + (restRanks.get(id) ?? rest.length));
  return out;
}

/**
 * 赛前预期名次：按 teamRating × (1 + expectationHonorWeight × log10(1+honor/100)) 在全部参赛队中排名（1 起）。
 * 若赛事含预选阶段且该队在预选中，则在全部（正赛+预选）队伍中排名。
 * 赛事尚未确定参赛名单（scheduled）时，按「受邀队 + 同赛区可参赛战队」估算，并夹在正赛规模内。
 */
export function expectedRank(state: GameState, t: Tournament, teamId: string): number {
  if (t.teamIds.includes(teamId) || t.qualifierTeamIds.includes(teamId)) {
    const ranks = computeExpectedRanks(state, t);
    return ranks[teamId] ?? Math.max(1, t.teamIds.length);
  }
  // 未在名单中（如报名后尚未开赛）：估算
  const myScore = expectationScore(state, teamId);
  const pool = t.status === 'scheduled'
    ? Object.values(state.teams).filter((tm) => !tm.disbanded && tm.id !== teamId
      && (!t.regionLocked || tm.region === t.regionLocked)).map((tm) => tm.id)
    : uniq([...t.teamIds, ...t.qualifierTeamIds]).filter((id) => id !== teamId);
  let better = 0;
  for (const id of pool) if (expectationScore(state, id) > myScore) better++;
  const size = Math.max(1, t.size ?? (pool.length + 1));
  return clamp(better + 1, 1, size);
}

/** 上赛季同系列赛事中该队的名次百分位；无记录 → null */
function lastSeasonPercentile(state: GameState, teamId: string, t: Tournament): number | null {
  const hist = state.history?.tournaments ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.seriesId !== t.seriesId || h.season !== t.season - 1 || h.tournamentId === t.id) continue;
    const pl = h.placements[teamId];
    if (pl) return placementPercentile(pl[0], pl[1], pl[2]);
  }
  return null;
}

/**
 * 该队上一项参加的「同等级」赛事名次百分位（环比）；无记录 → null。
 * 只和同等级比：不同等级赛事的对手强度不同，名次百分位不可比（Minor 第 2 → Premier 第 10 并不是退步），
 * 跨级比较会让在两个级别间来回参赛的中游队伍系统性掉荣誉（高等级赛事的扣分按更大的基数结算）。
 */
function previousEventPercentile(state: GameState, teamId: string, t: Tournament): number | null {
  const hist = state.history?.tournaments ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i];
    if (h.tournamentId === t.id) continue;
    const pl = h.placements[teamId];
    if (!pl) continue;
    if (h.tier !== t.tier) return null;
    return placementPercentile(pl[0], pl[1], pl[2]);
  }
  return null;
}

/**
 * 参照名次百分位的校准：名次受随机性影响会向中游回归，参照百分位按 shrink 向 0.5 收缩
 * （CONFIG.honor.expectationShrink / historyShrink：热门半区 p < 0.5 用 favorite，冷门半区用 underdog；1 = 不校准）。
 */
export function calibratedPercentile(p: number, shrink: { favorite: number; underdog: number } | number): number {
  const raw = typeof shrink === 'number' ? shrink : p < 0.5 ? shrink?.favorite : shrink?.underdog;
  const k = typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw, 0, 1) : 1;
  return 0.5 + k * (p - 0.5);
}

/**
 * 预期校准的零和修正：n 支队伍、预期名次 1..n 时，校准让热门半区的参照百分位整体后移（预期项净流入），
 * 返回把净流入均摊回全部参赛队所需的平移量（每队参照百分位 - 此值），使预期项在一项赛事内仍近似零和、不额外抬高联盟荣誉。
 * CONFIG.honor.expectationZeroSum = false 时为 0。
 */
export function expectationZeroSumShift(n: number): number {
  const h = CONFIG.honor;
  if (!h.expectationZeroSum || !(n > 1)) return 0;
  let sum = 0;
  for (let r = 1; r <= n; r++) {
    const p = (r - 1) / (n - 1);
    sum += calibratedPercentile(p, h.expectationShrink) - p;
  }
  return sum / n;
}

/** 名次奖励：单一名次查表；3-4 名并列按季军档（key 3） */
function placeBonusFor(rankFrom: number, rankTo: number): number {
  const table = CONFIG.honor.placeBonus;
  if (rankFrom === rankTo) return table[rankFrom] ?? 0;
  if (rankFrom === 3 && rankTo === 4) return table[3] ?? 0;
  return 0;
}

const r2 = (v: number) => Math.round(v * 1000) / 1000;

/** 预期名次 e 所在的实际名次档位（t.placements 中包含 e 且不超出 n 的并列区间）；赛事尚无名次时为 [e, e] */
function expectedBucket(t: Tournament, e: number, n: number): [number, number] {
  for (const p of t.placements ?? []) {
    if (p.rankFrom <= e && e <= p.rankTo && p.rankTo <= n) return [p.rankFrom, p.rankTo];
  }
  return [e, e];
}

/**
 * 赛事荣誉结算明细（见 DESIGN 3.5）：
 * expTerm  = wExp × (pExp' - pAct)；pExp 取预期名次所在的实际并列名次档位的中点（与 pAct 同口径），
 *            breakdown.expected 即该中点；pExp' = 0.5 + expectationShrink × (pExp - 0.5) - 零和平移（校准名次向中游回归，
 *            见 expectationZeroSumShift）
 * yoyTerm  = wYoY × (pSameSeriesLastSeason' - pAct)（上赛季未参加同系列 → 0；参照按 historyShrink 校准）
 * momTerm  = wMoM × (pPrevEvent' - pAct)（本队上一项赛事，无 → 0；参照按 historyShrink 校准）
 * placeBonus 按 CONFIG.honor.placeBonus（rankFrom===rankTo 时才给冠/亚；3-4 名区间给季殿军奖励）
 * total = round(tierBase × (expTerm + yoyTerm + momTerm + placeBonus))；beef 字段由调用方另计（此处为 0）
 * |total| 超过 CONFIG.honor.maxDeltaByTier[tier] 时夹到上限，四个分项等比缩放（明细仍可加总为合计）；
 * 扣分另不超过当前荣誉 × maxLossShareOfHonor（荣誉按 ≥ lossCushionFloor 计）。
 * 环比只取上一项同等级赛事。
 * 预选阶段被淘汰的队伍：teams 计为正赛+预选总数，名次排在正赛之后。
 */
export function computeHonorBreakdown(
  state: GameState,
  teamId: string,
  t: Tournament,
  rankFrom: number,
  rankTo: number,
  teamsCount: number,
): HonorBreakdown {
  const h = CONFIG.honor;
  const tierBase = h.tierBase[t.tier] ?? 0;
  const n = Math.max(1, Math.floor(teamsCount) || 1);
  const from = clamp(Math.floor(rankFrom) || 1, 1, n);
  const to = clamp(Math.max(from, Math.floor(rankTo) || from), from, n);

  let expectedRaw = t.expectedRanks?.[teamId];
  if (expectedRaw === undefined && teamId === state.settings?.playerTeamId) expectedRaw = t.expectedRank;
  if (expectedRaw === undefined) expectedRaw = expectedRank(state, t, teamId);
  // 预期名次按本赛事实际的并列名次分档、同样取区间中点：落在预期所在的档位即为「达到预期」。
  // 否则垫底预期（第 n 名）的队伍只要进入并列区间（中点 < n）就会「输了也加分」，荣誉逐季虚涨。
  const expRank = Number.isFinite(expectedRaw) ? clamp(Math.round(expectedRaw), 1, n) : n;
  const [expFrom, expTo] = expectedBucket(t, expRank, n);
  const expected = (expFrom + expTo) / 2;

  const pAct = placementPercentile(from, to, n);
  // 参照百分位按「实际平均会落在哪里」校准（热门不会每项都夺冠、冷门也不会每项都垫底），见 CONFIG.honor.expectationShrink
  const pExp = clamp(
    calibratedPercentile(placementPercentile(expFrom, expTo, n), h.expectationShrink) - expectationZeroSumShift(n), 0, 1,
  );
  const rawYoY = lastSeasonPercentile(state, teamId, t);
  const rawMoM = previousEventPercentile(state, teamId, t);
  const pYoY = rawYoY === null ? null : calibratedPercentile(rawYoY, h.historyShrink);
  const pMoM = rawMoM === null ? null : calibratedPercentile(rawMoM, h.historyShrink);

  let expTerm = h.wExp * (pExp - pAct);
  let yoyTerm = pYoY === null ? 0 : h.wYoY * (pYoY - pAct);
  let momTerm = pMoM === null ? 0 : h.wMoM * (pMoM - pAct);
  let placeBonus = placeBonusFor(from, to);
  let raw = tierBase * (expTerm + yoyTerm + momTerm + placeBonus);
  // 低荣誉减损：荣誉越低，单项赛事扣分越少（各分项等比缩放，明细仍可加总）；见 CONFIG.honor.lowHonorLossRef
  if (raw < 0 && h.lowHonorLossRef > 0) {
    const honorNow = state.teams[teamId]?.honor;
    const hv = Number.isFinite(honorNow) ? Math.max(0, honorNow as number) : 0;
    const k = clamp(h.lowHonorLossMinMult + (1 - h.lowHonorLossMinMult) * clamp(hv / h.lowHonorLossRef, 0, 1), 0, 1);
    if (k < 1) {
      expTerm *= k;
      yoyTerm *= k;
      momTerm *= k;
      placeBonus = r2(placeBonus * k);
      raw *= k;
    }
  }
  // 单项赛事上限：各分项等比缩放，保持「基数 × 分项之和 = 合计」。
  // 扣分另受「荣誉缓冲」限制：单项赛事最多扣当前荣誉的 maxLossShareOfHonor（荣誉按不低于 lossCushionFloor 计），
  // 低荣誉俱乐部不会因一次大赛失利直接解散，解散需要持续失利或丑闻。
  let cap = h.maxDeltaByTier?.[t.tier] ?? 0;
  if (raw < 0 && cap > 0 && h.maxLossShareOfHonor > 0) {
    const honorNow = state.teams[teamId]?.honor;
    const base = Math.max(h.lossCushionFloor, Number.isFinite(honorNow) ? (honorNow as number) : 0);
    cap = Math.min(cap, Math.max(1, Math.round(base * h.maxLossShareOfHonor)));
  }
  if (cap > 0 && Number.isFinite(raw) && Math.abs(raw) > cap) {
    const k = cap / Math.abs(raw);
    expTerm *= k;
    yoyTerm *= k;
    momTerm *= k;
    placeBonus = r2(placeBonus * k);
    raw = Math.sign(raw) * cap;
  }
  const total = Number.isFinite(raw) ? Math.round(raw) : 0;

  return {
    tierBase,
    expected,
    actual: (from + to) / 2,
    expTerm: r2(expTerm),
    yoyTerm: r2(yoyTerm),
    momTerm: r2(momTerm),
    placeBonus,
    beef: 0,
    total,
  };
}

/**
 * 荣誉变更的统一实现。notify=false 时玩家战队不写新闻（由调用方写更完整的新闻，如赛事结算），
 * 但仍记录 history.honor 并做解散判定。返回实际变化值。
 */
export function applyHonorChange(state: GameState, teamId: string, delta: number, reason: string, notify: boolean): number {
  const team = state.teams[teamId];
  if (!team || !Number.isFinite(delta)) return 0;
  const d = Math.round(delta);
  if (d === 0) return 0;
  const before = Number.isFinite(team.honor) ? team.honor : 0;
  if (!team.isPlayer && teamId !== state.settings?.playerTeamId) {
    team.honor = Math.max(CONFIG.honor.aiMinHonor, before + d);
    return team.honor - before;
  }
  team.honor = before + d;
  // 多人模式：新闻归属与荣誉曲线写入该战队所属座位（可能不是当前上下文）
  inSeatOf(state, teamId, () => {
    if (notify) {
      addNews(state, 'event', `俱乐部荣誉 ${d > 0 ? '+' : ''}${d}`, `${reason}。当前荣誉 ${team.honor}。`, Math.abs(d) >= 30);
    }
    // 与 season.snapshotHistory 同口径：同一 (赛季, 回合) 只保留最后值，曲线每回合一个点
    const hist = state.history?.honor;
    if (hist) {
      const season = state.season?.ti ?? 0;
      const last = hist[hist.length - 1];
      if (last && last.season === season && last.round === state.roundIndex) last.value = team.honor;
      else hist.push({ season, round: state.roundIndex, value: team.honor });
    }
    if (team.honor < 0 && isMultiplayer(state)) {
      // 多人模式：该座位出局（战队解散、转为观战），其余玩家继续；全部出局时由 multi.ts 判定游戏结束
      const seat = seatOf(state, teamId);
      if (!team.disbanded) {
        team.disbanded = true;
        if (seat) seat.eliminated = true;
        addNews(
          state, 'system', `${team.name} 宣告解散`,
          `${team.name} 荣誉跌破 0（${team.honor}），赞助商撤资，俱乐部宣告解散。直接原因：${reason}。`
            + (seat ? `玩家「${seat.name}」转为观战。` : ''),
          true, { teamIds: [team.id], visibility: 'public' },
        );
      }
    } else if (team.honor < 0 && !state.gameOver) {
      team.disbanded = true;
      state.gameOver = {
        reason: 'disbanded',
        summary: `${team.name} 荣誉跌破 0（${team.honor}），赞助商撤资，俱乐部宣告解散。直接原因：${reason}。`,
      };
      addNews(state, 'system', `${team.name} 宣告解散`, state.gameOver.summary, true);
    }
  });
  return d;
}

/**
 * 修改荣誉并记录：玩家战队写入新闻（reason 中文）与 history.honor；
 * 玩家战队荣誉 < 0 → state.gameOver = { reason: 'disbanded', ... } 并标记 team.disbanded；
 * AI 战队荣誉最低夹到 30。
 */
export function changeHonor(state: GameState, teamId: string, delta: number, reason: string): void {
  applyHonorChange(state, teamId, delta, reason, true);
}

/** 宿敌对决结算：若 winner/loser 之一为玩家且对方为本赛季 beef 对象，按 beefWin/beefLose 修改玩家荣誉，返回变化值（否则 0） */
export function applyBeefResult(state: GameState, winnerId: string, loserId: string): number {
  const pid = state.settings?.playerTeamId;
  if (!pid || winnerId === loserId) return 0;
  const season = state.season?.ti;
  const findBeef = (other: string) => (state.beefs ?? []).find((b) => b.teamId === other && b.season === season);
  if (winnerId === pid) {
    const b = findBeef(loserId);
    if (!b) return 0;
    const v = Number.isFinite(b.winHonor) ? b.winHonor : CONFIG.honor.beefWin;
    const name = state.teams[loserId]?.name ?? loserId;
    return applyHonorChange(state, pid, v, `宿敌对决获胜：击败 ${name}`, true);
  }
  if (loserId === pid) {
    const b = findBeef(winnerId);
    if (!b) return 0;
    const v = Number.isFinite(b.loseHonor) ? b.loseHonor : CONFIG.honor.beefLose;
    const name = state.teams[winnerId]?.name ?? winnerId;
    return applyHonorChange(state, pid, v, `宿敌对决失利：负于 ${name}`, true);
  }
  return 0;
}
