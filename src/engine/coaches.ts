// ============================================================================
// 赛季教练供给（第九波 #3；用户决策：每个赛季随新秀一起向市场引入一批教练，保证可签约教练明显多于空缺岗位，
// 玩家不会长期找不到教练；AI 只在需要时聘请，不把好教练全部扫光）
//
// season.startSeason 在新秀选秀之后、休赛期转会潮 / AI 季前转会之前调用 seasonCoachSupply（全局一次，多人模式在中性上下文）：
//   1. 标记新到：首次出现在游戏世界的教练记下 arrivedTi（上赛季结算时由退役选手转任的教练、被解散 / 除名战队留下的教练等）；
//      新游戏 / 旧存档第一次执行时，已有教练记为「上赛季」，不算新到；
//   2. 真实教练：该届 roster（src/data/coachIndex.json，由 scripts/build-coach-index.ts 生成）中尚未进入游戏的教练
//      （本世界里仍在役 / 尚未出道的同名选手、已转任教练的退役选手、超龄者除外），按等级 → 灵性取前 realMaxPerSeason 名；
//   3. 程序生成 generatedPerSeason 名（等级分布 CONFIG.coachSupply.tierWeights，含少量高等级）；
//   4. 保底：可签约教练 ≥ max(minAvailable, 没有主教练的战队数 + vacancyMargin)，其中 S 级及以上 ≥ minTopTier，不足时追加生成；
//   5. 新闻「【教练市场】本赛季新增 N 名教练」。
// AI 克制（ai.ts maybeHireCoach 使用 aiCoachCandidates / aiCoachPickWeight）：AI 只在没有主教练时按概率 / 预算聘请，
// 不会让市场跌破 minAvailable / minTopTier，并按「与本队实力匹配」加权随机挑选，而不是总挑最好的。
// 教练市场容量上限（CONFIG.coach.freePoolMax，season.pruneCoachPool）在供给之前清理，因此不会让赛季初的市场低于保底。
//
// 随机数：供给使用按 (存档 id, 赛季) 派生的确定性子随机流（临时换入 state.rngState，结束后恢复），
// 不消耗主随机序列 —— 引入教练不会扰动其余模拟，存档可复现。
// ============================================================================
import type { Coach, CoachSupplyRecord, GameState, SeedCoach, Team, Tier } from './types';
import { TIERS } from './types';
import { CONFIG } from './config';
import { hashSeed, rngOf } from './rng';
import { coachFromSeed, generateCoach } from './generation';
import { addNews } from './news';
import { getCoachIndex, type CoachIndexEntry } from '../data/index';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 等级序号（C=0 … SSR=5；未知等级按 0）。不依赖 player.ts，便于测试替身 */
function tierIdx(t: Tier | string | undefined): number {
  const i = TIERS.indexOf(t as Tier);
  return i < 0 ? 0 : i;
}

function nonNegInt(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(0, n);
}

/** 是否为高等级教练（≥ CONFIG.coachSupply.topTier，默认 S） */
export function isTopTierCoach(c: Pick<Coach, 'tier'> | null | undefined): boolean {
  return !!c && tierIdx(c.tier) >= tierIdx(CONFIG.coachSupply?.topTier ?? 'S');
}

/** 教练市场上可签约的教练（teamId = null）。退役旧部在赛季交替时为玩家暂留（teamId 指向玩家战队但未上任）的不算 */
export function freeCoaches(state: GameState): Coach[] {
  const out: Coach[] = [];
  for (const id in state.coaches) {
    const c = state.coaches[id];
    if (c && c.teamId === null) out.push(c);
  }
  return out;
}

/** 教练是否「在市场上」：自由身，或为玩家暂留的退役旧部（teamId 指向某队但该队主教练不是他） */
function onMarket(state: GameState, c: Coach): boolean {
  if (!c.teamId) return true;
  return state.teams[c.teamId]?.coachId !== c.id;
}

/** 某战队是否有在任主教练 */
function hasCoach(state: GameState, team: Team): boolean {
  const c = team.coachId ? state.coaches[team.coachId] : undefined;
  return !!c && c.teamId === team.id;
}

/** 没有主教练的战队数（未解散、有阵容；人类战队总是计入） */
export function coachVacancies(state: GameState): number {
  let n = 0;
  for (const id in state.teams) {
    const t = state.teams[id];
    if (!t || t.disbanded) continue;
    if (!t.playerIds?.length && !t.isPlayer) continue;
    if (!hasCoach(state, t)) n++;
  }
  return n;
}

/** 保底目标：可签约总数 / 其中高等级人数 */
export function coachSupplyTarget(state: GameState): { available: number; topTier: number; vacancies: number } {
  const cfg = CONFIG.coachSupply;
  const vacancies = coachVacancies(state);
  return {
    available: Math.max(nonNegInt(cfg?.minAvailable), vacancies + nonNegInt(cfg?.vacancyMargin)),
    topTier: nonNegInt(cfg?.minTopTier),
    vacancies,
  };
}

/** 在按 (存档 id, 赛季) 派生的子随机流中执行 fn（rngOf(state) 在 fn 内读写子流），结束后恢复主随机序列 */
function withSupplyRng<T>(state: GameState, ti: number, fn: () => T): T {
  const saved = state.rngState;
  let seed = hashSeed(`${state.id || 'game'}|coach-supply|${ti}`);
  if (!Number.isFinite(seed)) seed = ti | 0;
  state.rngState = seed;
  try {
    rngOf(state).next(); // 先空转一次：相邻种子的首个输出相关性更弱
    return fn();
  } finally {
    state.rngState = saved;
  }
}

/** 按权重生成一名教练（标记为本赛季新到） */
function generateOne(state: GameState, ti: number, weights: Record<Tier, number> | undefined): Coach {
  const rng = rngOf(state);
  const w = TIERS.map((t) => Math.max(0, Number(weights?.[t]) || 0));
  const tier = w.some((x) => x > 0) ? rng.weighted(TIERS, w) : undefined;
  const c = generateCoach(state, tier ? { tier } : undefined);
  c.arrivedTi = ti;
  return c;
}

// ---------------------------------------------------------------------------
// 真实教练
// ---------------------------------------------------------------------------

/**
 * 该届 roster 中尚未进入游戏、可以引入教练市场的真实教练（纯查询，不修改 state），按等级 → 灵性降序。
 * 排除：已在游戏中的同 id 教练；本世界里仍在役 / 被禁赛的同名选手；尚未出道的未来新秀；已由退役选手转任的教练；年龄 ≥ coach.retireAge。
 */
export function realCoachCandidates(state: GameState, ti: number): SeedCoach[] {
  let index: CoachIndexEntry[] = [];
  try {
    index = getCoachIndex() ?? [];
  } catch {
    index = []; // 测试替身等无索引环境
  }
  if (!Array.isArray(index) || !index.length) return [];
  const year = state.season?.year ?? 0;
  const retireAge = Number.isFinite(CONFIG.coach.retireAge) ? CONFIG.coach.retireAge : Infinity;
  const converted = new Set<string>();
  for (const id in state.coaches) {
    const f = state.coaches[id]?.formerPlayerId;
    if (f) converted.add(f);
  }
  const out: SeedCoach[] = [];
  for (const e of index) {
    if (!e?.id || !Array.isArray(e.apps)) continue;
    const app = e.apps.find((a) => Array.isArray(a) && a[0] === ti);
    if (!app) continue;
    if (state.coaches[e.id] || converted.has(e.id)) continue;
    const p = state.players[e.id];
    if (p && p.status !== 'retired') continue;
    if (state.futureRookies && Object.prototype.hasOwnProperty.call(state.futureRookies, e.id)) continue;
    const birthYear = Number.isFinite(e.birthYear) ? e.birthYear : year - 35;
    if (year - birthYear >= retireAge) continue;
    const tier = (TIERS as string[]).includes(app[1]) ? (app[1] as Tier) : 'A';
    out.push({
      id: e.id,
      name: e.name || e.id,
      nationality: e.nationality || 'EU',
      birthYear,
      tier,
      insight: Number.isFinite(app[2]) ? app[2] : 60,
    });
  }
  out.sort((a, b) => tierIdx(b.tier) - tierIdx(a.tier) || b.insight - a.insight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// 赛季供给
// ---------------------------------------------------------------------------

/**
 * 赛季初教练供给（season.startSeason 在新秀选秀之后调用；全局一次）。同一赛季重复调用直接返回已有记录（幂等）。
 * 返回本赛季的供给记录（同时写入 state.coachSupply），游戏已结束或没有赛季时返回 null。
 */
export function seasonCoachSupply(state: GameState): CoachSupplyRecord | null {
  if (state.gameOver || !state.season || !state.coaches) return null;
  const ti = state.season.ti;
  const prev = state.coachSupply;
  if (prev && prev.ti === ti) return prev;
  const cfg = CONFIG.coachSupply;
  const firstRun = !prev;

  // 1. 标记新到（首次执行：已有教练记为上赛季，不算新到）
  let retired = 0;
  let other = 0;
  for (const id of Object.keys(state.coaches).sort()) {
    const c = state.coaches[id];
    if (!c || Number.isFinite(c.arrivedTi)) continue;
    if (firstRun) {
      c.arrivedTi = ti - 1;
      continue;
    }
    c.arrivedTi = ti;
    if (!onMarket(state, c)) continue; // 例如新组建战队自带的教练：首次出现即在任，不计入市场新增
    if (c.formerPlayerId) retired++;
    else other++;
  }

  const realNames: string[] = [];
  const newTop: Coach[] = [];
  let generated = 0;
  let topUp = 0;
  withSupplyRng(state, ti, () => {
    // 2. 真实教练
    if (cfg?.includeRealCoaches !== false) {
      const max = nonNegInt(cfg?.realMaxPerSeason, 12);
      for (const seed of realCoachCandidates(state, ti).slice(0, max)) {
        const c = coachFromSeed(state, seed, null);
        if (!c || c.teamId !== null) continue;
        c.arrivedTi = ti;
        // 本世界里已退役（未转任教练）的同名真实选手：关联为其转型（界面显示「前选手」）
        if (!c.formerPlayerId && state.players[c.id]?.status === 'retired') c.formerPlayerId = c.id;
        realNames.push(c.name);
        if (isTopTierCoach(c)) newTop.push(c);
      }
    }
    // 3. 程序生成
    const n = nonNegInt(cfg?.generatedPerSeason);
    for (let i = 0; i < n; i++) {
      const c = generateOne(state, ti, cfg?.tierWeights);
      generated++;
      if (isTopTierCoach(c)) newTop.push(c);
    }
    // 4. 保底：先补高等级，再补总数
    const target = coachSupplyTarget(state);
    const pool = freeCoaches(state);
    let available = pool.length;
    let top = pool.filter(isTopTierCoach).length;
    const guardMax = 200;
    for (let guard = 0; top < target.topTier && guard < guardMax; guard++) {
      const c = generateOne(state, ti, cfg?.topTierWeights);
      generated++;
      topUp++;
      available++;
      if (isTopTierCoach(c)) {
        top++;
        newTop.push(c);
      }
    }
    for (let guard = 0; available < target.available && guard < guardMax; guard++) {
      const c = generateOne(state, ti, cfg?.tierWeights);
      generated++;
      topUp++;
      available++;
      if (isTopTierCoach(c)) newTop.push(c);
    }
  });

  const pool = freeCoaches(state);
  const record: CoachSupplyRecord = {
    ti,
    added: generated + realNames.length + retired + other,
    generated,
    topUp,
    real: realNames.length,
    retired,
    other,
    available: pool.length,
    topTier: pool.filter(isTopTierCoach).length,
    vacancies: coachVacancies(state),
  };
  state.coachSupply = record;
  if (record.added > 0) supplyNews(state, record, realNames, newTop);
  return record;
}

function supplyNews(state: GameState, r: CoachSupplyRecord, realNames: string[], newTop: Coach[]): void {
  const parts: string[] = [];
  if (r.generated) parts.push(`新人教练 ${r.generated} 名`);
  if (r.real) {
    const max = 6;
    const names = realNames.slice(0, max).join('、') + (realNames.length > max ? ' 等' : '');
    parts.push(`知名教练 ${r.real} 名（${names}）`);
  }
  if (r.retired) parts.push(`退役选手转任 ${r.retired} 名`);
  if (r.other) parts.push(`其他自由教练 ${r.other} 名`);
  const topText = newTop.length
    ? `其中 S 级及以上 ${newTop.length} 名：${newTop.slice(0, 5).map((c) => `${c.name}（${c.tier}）`).join('、')}${newTop.length > 5 ? ' 等' : ''}。`
    : '';
  addNews(
    state,
    'transfer',
    `【教练市场】本赛季新增 ${r.added} 名教练`,
    `TI${r.ti} 赛季开始，教练市场迎来一批新面孔：${parts.join('、')}。${topText}`
      + `目前可签约教练 ${r.available} 名（S 级及以上 ${r.topTier} 名），${r.vacancies} 支战队的主教练岗位空缺。`
      + '可在「战队 › 教练」查看本赛季新到的教练。',
    true,
    { visibility: 'public', tags: ['coach-market'], noInfer: true },
  );
}

/** 某教练是否为本赛季新到（界面标记用） */
export function isNewArrivalCoach(state: GameState, c: Coach | null | undefined): boolean {
  return !!c && Number.isFinite(c.arrivedTi) && c.arrivedTi === state.season?.ti;
}

// ---------------------------------------------------------------------------
// AI 克制（ai.ts）
// ---------------------------------------------------------------------------

/**
 * AI 可以签约的教练：pool 中自由身、affordable 为真，且签下后市场不跌破保底
 * （可签约总数 ≥ minAvailable；签下高等级教练后高等级人数 ≥ minTopTier）。
 */
export function aiCoachCandidates(pool: readonly Coach[], affordable: (c: Coach) => boolean): Coach[] {
  const cfg = CONFIG.coachSupply;
  let free = 0;
  let top = 0;
  for (const c of pool) {
    if (!c || c.teamId !== null) continue;
    free++;
    if (isTopTierCoach(c)) top++;
  }
  if (free - 1 < nonNegInt(cfg?.minAvailable)) return [];
  const minTop = nonNegInt(cfg?.minTopTier);
  const out: Coach[] = [];
  for (const c of pool) {
    if (!c || c.teamId !== null) continue;
    if (isTopTierCoach(c) && top - 1 < minTop) continue;
    if (affordable(c)) out.push(c);
  }
  return out;
}

/** AI 挑选权重：与本队目标等级（首发平均等级序号）差 k 级 → aiTierMatchDecay^k */
export function aiCoachPickWeight(c: Coach, targetTierIndex: number): number {
  const decay = CONFIG.coachSupply?.aiTierMatchDecay;
  const d = Number.isFinite(decay) && decay > 0 ? Math.min(1, decay) : 0.4;
  const target = Number.isFinite(targetTierIndex) ? targetTierIndex : 2;
  const w = Math.pow(d, Math.abs(tierIdx(c.tier) - target));
  return Number.isFinite(w) && w > 0 ? w : 1e-6;
}
