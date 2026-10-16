// ============================================================================
// 新秀抽卡（2026-10-14 用户决策：抽卡回归并完全取代新秀选秀；新增「请神」与名人堂，见 hallOfFame.ts）
//
// 用户原话：「赛季新秀似乎在整套体系中没有太大用处。我在思考重新回归抽卡模式：分为真实新秀和非真实新秀两类卡，
// 真实新秀的能力参考其真实历史定位以及真实历史发展走势；虚拟新秀则会增加"请神"系统，有部分新秀将会与历史上的名人堂选手
// 构建请神关系，其能力和未来走势复制历史选手……」
//
// 1. 卡池（全局世界状态 GameState.gacha.pool，多人模式所有座位共享、先到先得）：每个赛季初（season.startSeason）建一个有限卡池，
//    只存抽象的卡（等级 + 卡种 + 引用），抽中时才生成选手。基础 CONFIG.gacha.poolSize（100）张，各等级张数严格按
//    【用户指定】比例 SSR 5 / SS 10 / S 10 / A 15 / B 30 / C 30。每个等级先放本届真实新秀（等级 = 出道届的真实轨迹等级；
//    超出名额时卡池按 poolStep 张一档放大并记录），再按 summonShare 放请神卡（原型的出道等级 = 卡的等级，同一原型每赛季
//    至多 summonMaxPerPrototype 张），其余为虚构新秀卡。卡池内均匀不放回抽取；抽空后补一个同比例的卡池（只含请神与虚构）。
// 2. 抽卡（gachaPull，白名单 RPC）：转会窗口开放期间（赛季初 + 常规赛）；单抽价格随年代缩放，十连 = 10 × 单抽；
//    抽中的新秀立即签入本队（新秀合同、等级标准工资 × 新秀折扣，不超过 rookieWageCap × 经济指数）。
//    十连 / 单抽总是抽满（2026-10-15 用户决策「十连后本回合内退回到 12 人」）：可以让正式阵容超过绝对上限（12 人），超编期间不能进入下一回合，
//    须在本回合内放弃本回合抽到的新秀或解约 / 出售其他队员（game.getAdvanceBlockers 的 roster_over_cap；懒人推进 / 多人托管自动处理，
//    autoRound.planOverCapTrim）；已经超编时不能再抽。
//    转售冷却：本队抽到的新秀入队不满 resaleHoldRounds 个转会回合（约一个赛季）时不能挂牌、不接 AI 随机求购，抵价按签字费比例估值
//    （listingRules.gachaResaleLockLeft）；另与所有新加盟选手的加盟门槛（随队场数 / 入队转会回合）叠加（listingRules.resaleLocked）。
//    SSR 保底：战队距上一张 SSR 第 pityThreshold 抽必出 SSR（计数在 Team.gacha，多人模式各座位独立）。
//    同一回合内可退回抽到的新秀（gachaDiscard，白名单 RPC）：离队进入自由市场，返还单抽价格 × discardRefundRatio。
// 3. AI 战队：第 1 回合开始前（人类玩家先抽）与赛季中期各自动抽一次，按资金盈余与阵容空位，每赛季至多 aiMaxPullsPerSeason 张；
//    超编 1 人（rosterSlack）只在替补中有保留价值低于 ai.slackKeepMax 的选手时才抽；抽完整理阵容（超出 ai.maxRoster 放走保留价值最低的非首发）。
//    抽到 S 级以上、整理后仍在队的发公开新闻。
// 4. 第 1 回合开始前（AI 开赛前抽卡之前，releaseRealRookieCards）：未被抽走的真实新秀卡离开卡池，同等级补入等量的请神 / 虚构卡
//    （之后的出卡比例仍为用户指定比例），真实新秀以自由身进入自由市场（v0.4.3【用户指定】「真实新秀如果没抽到则直接上场到自由市场中」；
//    此前按真实出道去向加盟）。入场的回合内 AI 战队不从自由市场签下他们（marketEntry.ts），人类玩家可以立即签约；
//    第 2 回合结束时仍是自由身的由 AI 接手一次，出道战队优先按新秀合同签回（entryPass.ts，【用户指定】「要，且真实战队优先」）。
// 5. TI 预选赛转会锁定时卡池关闭（其余卡作废；第 1 回合前已离池的真实新秀不受影响，旧卡池仍有真实卡时按 4 处理）。
// 随机数一律来自 rngOf(state)。
// ============================================================================
import type {
  GachaCardKind, GachaPool, GachaPullRecord, GachaSeasonRecord, GachaState, GameState, HallOfFameMember, OpResult, PendingDecision,
  Player, PlayerIndexEntry, SeedPlayer, Team, TeamGachaState, Tier,
} from './types';
import { POSITIONS, TIERS } from './types';
import { CONFIG, MAX_TI, POSITION_LABEL, TI_YEAR } from './config';
import { rngOf, type Rng } from './rng';
import { clamp, formatGold, ownEntry, round2 } from './util';
import { addNews } from './news';
import {
  ageOf, clampPlayerAttrs, computeSalary, econIndexAt, playerTier, seasonEconIndex, seasonYear, standardSalary,
  tierIndex, tierOf,
} from './player';
import { activeTeams, addPlayerToTeam, autoLineup, benchPlayers, rosterSize, teamPlayers } from './team';
import { generatePlayer, playerFromSeed } from './generation';
import { departToFreeAgency, isTransferWindowOpen } from './market';
import { addFinance, roundWageBill } from './economy';
import { isHumanTeam } from './seat';
import { syncSynergies } from './synergy';
import { aiKeepValue } from './rookieDraft';
import { markMarketEntry, marketEntryNote } from './marketEntry';
import { resolveSameIdCoach, sameIdHumanCoachTeam } from './sameIdCoach';
import { realRoleFor } from './roles';
import { heroById } from './heroes';
import { ensureHallOfFame, hofMember, prototypeDebut, summonPrototypes } from './hallOfFame';
import { getPlayerIndex, getTrajectory } from '../data/index';

export { luckAdjustedWeights, prdConstant } from './gachaOdds';

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const ok = (message: string): OpResult => ({ ok: true, message });
const fail = (message: string): OpResult => ({ ok: false, message });

/** 卡种中文名 */
export const GACHA_KIND_LABEL: Record<GachaCardKind, string> = { real: '真实新秀', summon: '请神新秀', fictional: '虚构新秀' };

// ---------------------------------------------------------------------------
// 状态与价格
// ---------------------------------------------------------------------------

/** 抽卡状态（缺失 / 损坏时补默认值） */
export function gachaState(state: GameState): GachaState {
  const cur = state.gacha;
  if (!cur || typeof cur !== 'object') {
    state.gacha = { pool: null, history: [] };
    return state.gacha;
  }
  if (!Array.isArray(cur.history)) cur.history = [];
  if (cur.pool === undefined) cur.pool = null;
  return cur;
}

/** 本赛季开放中的卡池（只读；未建池 / 已关闭 / 不是本赛季的返回 null） */
export function currentGachaPool(state: GameState): GachaPool | null {
  const pool = state.gacha?.pool;
  if (!pool || typeof pool !== 'object' || pool.ti !== state.season?.ti) return null;
  return pool;
}

/** 某年份的单抽 / 十连价格：单抽 = singleCost × econIndex(年份) / econIndex(priceBaseYear)；十连 = 单抽 × tenMult（不打折） */
export function gachaPriceForYear(year: number): { single: number; ten: number } {
  const g = CONFIG.gacha;
  const base = econIndexAt(g.priceBaseYear) || 1;
  const single = Math.max(1, Math.round((g.singleCost * econIndexAt(year)) / base));
  return { single, ten: single * Math.max(1, Math.round(num(g.tenMult, 10))) };
}

/** 某届（TI 序号）赛季的价格（新游戏向导预览用） */
export function gachaPriceForTi(ti: number): { single: number; ten: number } {
  return gachaPriceForYear(TI_YEAR[ti] ?? TI_YEAR[MAX_TI] ?? 2027);
}

/** 本赛季的单抽 / 十连价格 */
export function gachaPrice(state: GameState): { single: number; ten: number } {
  return gachaPriceForYear(seasonYear(state));
}

/** 某种张数的总价 */
export function gachaCost(state: GameState, count: number): number {
  const { single, ten } = gachaPrice(state);
  return count === 10 ? ten : single * Math.max(0, Math.floor(num(count, 0)));
}

/** 新秀合同工资上限（本赛季）：rookieWageCap × 赛季经济指数，不低于最低工资；未配置时不设上限 */
export function gachaRookieWageCap(state: GameState): number {
  const cap = num(CONFIG.gacha.rookieWageCap, 0);
  if (!(cap > 0)) return Infinity;
  return Math.max(CONFIG.economy.minSalary, Math.round(cap * seasonEconIndex(state)));
}

/** 抽卡新秀（含按真实出道去向加盟的真实新秀）的新秀合同工资：等级标准工资 × 新秀折扣，不超过 gachaRookieWageCap */
export function gachaRookieSalary(state: GameState, p: Pick<Player, 'mmr' | 'power'>): number {
  return Math.min(standardSalary(p.mmr, p.power, seasonEconIndex(state), true), gachaRookieWageCap(state));
}

/** 战队抽卡计数（缺失时创建；本赛季计数随赛季重置） */
export function teamGacha(state: GameState, team: Team): TeamGachaState {
  const ti = state.season?.ti ?? 0;
  const g = (team.gacha ??= { pity: 0, pulls: 0 });
  if (!Number.isFinite(g.pity) || g.pity < 0) g.pity = 0;
  if (!Number.isFinite(g.pulls) || g.pulls < 0) g.pulls = 0;
  if (g.seasonTi !== ti) {
    g.seasonTi = ti;
    g.seasonPulls = 0;
    if (g.log) delete g.log;
  }
  return g;
}

/** 本赛季已抽张数（只读） */
export function teamSeasonPulls(state: GameState, team: Team | null | undefined): number {
  const g = team?.gacha;
  return g && g.seasonTi === state.season?.ti ? num(g.seasonPulls, 0) : 0;
}

/** SSR 保底线（第 N 抽必出） */
export function gachaPityThreshold(): number {
  return Math.max(1, Math.floor(num(CONFIG.gacha.pityThreshold, 100)));
}

// ---------------------------------------------------------------------------
// 卡池构成
// ---------------------------------------------------------------------------

/** 各等级张数（按【用户指定】比例；size 为 poolStep 的整数倍时全部为整数） */
export function tierCounts(size: number): Record<Tier, number> {
  const shares = CONFIG.gacha.tierShares;
  const total = TIERS.reduce((s, t) => s + Math.max(0, num(shares[t], 0)), 0) || 1;
  const out = {} as Record<Tier, number>;
  let used = 0;
  for (const t of TIERS) {
    out[t] = Math.round((Math.max(0, num(shares[t], 0)) * size) / total);
    used += out[t];
  }
  // 取整误差（非整档时）记在占比最大的等级上，保证合计 = size
  const big = TIERS.slice().sort((a, b) => num(shares[b], 0) - num(shares[a], 0))[0];
  out[big] += size - used;
  return out;
}

/** 名义出卡概率（UI 展示） */
export function gachaTierProbabilities(): Record<Tier, number> {
  const counts = tierCounts(CONFIG.gacha.poolSize);
  const out = {} as Record<Tier, number>;
  const total = TIERS.reduce((s, t) => s + counts[t], 0) || 1;
  for (const t of TIERS) out[t] = counts[t] / total;
  return out;
}

let INDEX: Map<string, PlayerIndexEntry> | null = null;
function indexEntry(id: string): PlayerIndexEntry | undefined {
  if (!INDEX) {
    INDEX = new Map();
    try {
      for (const e of getPlayerIndex() ?? []) if (e?.id) INDEX.set(e.id, e);
    } catch {
      /* 无索引：没有真实新秀卡 */
    }
  }
  return INDEX.get(id);
}

/** 真实新秀的出道点（出道届的真实轨迹）；数据缺失返回 null */
function realDebutPoint(id: string): { ti: number; mmr: number; power: number; tier: Tier } | null {
  const e = indexEntry(id);
  if (!e) return null;
  let raw;
  try {
    raw = getTrajectory(id);
  } catch {
    raw = undefined;
  }
  const point = raw?.[e.firstTi];
  if (!point || !Number.isFinite(point.mmr) || !Number.isFinite(point.power)) return null;
  const tier = (TIERS as string[]).includes(point.tier) ? point.tier : tierOf(point.mmr);
  return { ti: e.firstTi, mmr: point.mmr, power: point.power, tier };
}

/** 真实新秀出道届的等级（卡的等级；数据缺失返回 null） */
export function realDebutTier(id: string): Tier | null {
  return realDebutPoint(id)?.tier ?? null;
}

/** 本届到期的真实新秀（futureRookies 登场届 ≤ 本届、尚未进入本局），按等级分组（组内按 id 排序） */
function dueRealRookieCards(state: GameState, ti: number): Record<Tier, string[]> {
  const out = Object.fromEntries(TIERS.map((t) => [t, [] as string[]])) as Record<Tier, string[]>;
  const ids = Object.entries(state.futureRookies ?? {})
    .filter(([, debut]) => num(debut, Infinity) <= ti)
    .map(([id]) => id)
    .sort();
  for (const id of ids) {
    if (state.players[id]) continue;
    const pt = realDebutPoint(id);
    if (pt) out[pt.tier].push(id);
  }
  return out;
}

/** 某等级还能发出的请神卡（受每原型上限），按原型均匀分配（先洗牌，再轮流各发一张） */
function assignSummons(state: GameState, pool: GachaPool, tier: Tier, want: number, rng: Rng): string[] {
  if (want <= 0) return [];
  const cap = Math.max(0, Math.floor(num(CONFIG.gacha.summonMaxPerPrototype, 2)));
  const protos = summonPrototypes(state, tier).filter((m) => num(pool.protoUsed[m.id], 0) < cap);
  if (!protos.length) return [];
  const order = rng.shuffle(protos.slice());
  const out: string[] = [];
  let progressed = true;
  while (out.length < want && progressed) {
    progressed = false;
    for (const m of order) {
      if (out.length >= want) break;
      if (num(pool.protoUsed[m.id], 0) >= cap) continue;
      pool.protoUsed[m.id] = num(pool.protoUsed[m.id], 0) + 1;
      out.push(m.id);
      progressed = true;
    }
  }
  return out;
}

/** 往卡池加一组卡（真实新秀已按等级给出；其余按比例放请神 / 虚构），并记录构成 */
function fillTiers(state: GameState, pool: GachaPool, counts: Record<Tier, number>, real: Record<Tier, string[]> | null, rng: Rng): void {
  const share = clamp(num(CONFIG.gacha.summonShare, 0), 0, 1);
  for (const t of TIERS) {
    const r = real?.[t] ?? [];
    const nonReal = Math.max(0, counts[t] - r.length);
    const summons = assignSummons(state, pool, t, Math.round(share * nonReal), rng);
    const fictional = nonReal - summons.length;
    if (r.length) (pool.real[t] ??= []).push(...r);
    if (summons.length) (pool.summon[t] ??= []).push(...summons);
    if (fictional > 0) pool.fictional[t] = num(pool.fictional[t], 0) + fictional;
    const made = (pool.made[t] ??= [0, 0, 0]);
    made[0] += r.length;
    made[1] += summons.length;
    made[2] += fictional;
  }
}

/** 剩余张数 */
export function poolRemaining(pool: GachaPool | null | undefined): number {
  if (!pool) return 0;
  let n = 0;
  for (const t of TIERS) n += (pool.real[t]?.length ?? 0) + (pool.summon[t]?.length ?? 0) + num(pool.fictional[t], 0);
  return n;
}

/** 某等级剩余张数 */
function tierRemaining(pool: GachaPool, t: Tier): number {
  return (pool.real[t]?.length ?? 0) + (pool.summon[t]?.length ?? 0) + num(pool.fictional[t], 0);
}

/**
 * 建本赛季卡池（season.startSeason 在 CONFIG.draft.enabled = false 时调用；同一赛季只建一次）：
 * 先关闭仍未关闭的旧卡池，确保名人堂存在，再按比例放真实新秀 / 请神 / 虚构卡。
 */
export function startGachaSeason(state: GameState): GachaPool | null {
  if (state.gameOver || !state.season) return null;
  const gs = gachaState(state);
  const ti = state.season.ti;
  if (gs.pool && gs.pool.ti === ti) return gs.pool;
  if (gs.pool) closeGachaPool(state);
  ensureHallOfFame(state);
  const rng = rngOf(state);
  const cfg = CONFIG.gacha;
  const step = Math.max(1, Math.floor(num(cfg.poolStep, 20)));
  const real = dueRealRookieCards(state, ti);
  let size = Math.max(step, Math.floor(num(cfg.poolSize, 100)));
  const enlargedBy = new Set<Tier>();
  for (let guard = 0; guard < 500; guard++) {
    const counts = tierCounts(size);
    const over = TIERS.filter((t) => real[t].length > counts[t]);
    if (!over.length) break;
    for (const t of over) enlargedBy.add(t);
    size += step;
  }
  const pool: GachaPool = {
    ti,
    real: {},
    summon: {},
    fictional: {},
    size,
    base: size,
    refills: 0,
    made: {},
    protoUsed: {},
    drawn: 0,
    aiDrawn: 0,
  };
  if (enlargedBy.size) pool.enlargedBy = TIERS.filter((t) => enlargedBy.has(t));
  fillTiers(state, pool, tierCounts(size), real, rng);
  gs.pool = pool;
  return pool;
}

/** 抽空后补充一个同比例的卡池（只含请神与虚构新秀） */
function refillPool(state: GameState, pool: GachaPool, rng: Rng): void {
  const size = Math.max(1, Math.floor(num(CONFIG.gacha.refillSize, 100)));
  fillTiers(state, pool, tierCounts(size), null, rng);
  pool.size += size;
  pool.refills += 1;
}

/** 是否仍在本赛季卡池中待抽（真实新秀）：这些选手尚未进入本局，保留在 futureRookies 里 */
export function gachaHoldsRealRookie(state: GameState, id: string): boolean {
  const pool = currentGachaPool(state);
  if (!pool) return false;
  return TIERS.some((t) => pool.real[t]?.includes(id));
}

// ---------------------------------------------------------------------------
// 抽卡
// ---------------------------------------------------------------------------

interface DrawnCard {
  tier: Tier;
  kind: GachaCardKind;
  ref?: string;
  pity?: boolean;
}

/** 从卡池均匀抽一张（不放回）；forceSsr：只在 SSR 卡中均匀抽（没有 SSR 卡时补发一张） */
function drawCard(state: GameState, pool: GachaPool, rng: Rng, forceSsr: boolean): DrawnCard {
  if (forceSsr) {
    if (tierRemaining(pool, 'SSR') <= 0) {
      // 保底触发但卡池中已无 SSR：补发一张（有可用原型时为请神卡，否则虚构）
      const s = rng.chance(clamp(num(CONFIG.gacha.summonShare, 0), 0, 1)) ? assignSummons(state, pool, 'SSR', 1, rng) : [];
      const made = (pool.made.SSR ??= [0, 0, 0]);
      if (s.length) {
        (pool.summon.SSR ??= []).push(...s);
        made[1] += 1;
      } else {
        pool.fictional.SSR = num(pool.fictional.SSR, 0) + 1;
        made[2] += 1;
      }
      pool.bonus = num(pool.bonus, 0) + 1;
      pool.size += 1;
    }
    const card = takeAt(pool, 'SSR', rng.int(0, tierRemaining(pool, 'SSR') - 1));
    return { ...card, pity: true };
  }
  if (poolRemaining(pool) <= 0) refillPool(state, pool, rng);
  let idx = rng.int(0, poolRemaining(pool) - 1);
  for (const t of TIERS) {
    const n = tierRemaining(pool, t);
    if (idx < n) return takeAt(pool, t, idx);
    idx -= n;
  }
  // 不会发生（idx 在范围内）：兜底取最后一张
  const last = TIERS.slice().reverse().find((t) => tierRemaining(pool, t) > 0) ?? 'C';
  return takeAt(pool, last, 0);
}

/** 取出某等级的第 idx 张（顺序：真实 → 请神 → 虚构） */
function takeAt(pool: GachaPool, t: Tier, idx: number): DrawnCard {
  const real = pool.real[t] ?? [];
  if (idx < real.length) {
    const [id] = real.splice(idx, 1);
    if (!real.length) delete pool.real[t];
    return { tier: t, kind: 'real', ref: id };
  }
  idx -= real.length;
  const sum = pool.summon[t] ?? [];
  if (idx < sum.length) {
    const [id] = sum.splice(idx, 1);
    if (!sum.length) delete pool.summon[t];
    return { tier: t, kind: 'summon', ref: id };
  }
  const left = num(pool.fictional[t], 0);
  if (left > 1) pool.fictional[t] = left - 1;
  else delete pool.fictional[t];
  return { tier: t, kind: 'fictional' };
}

/**
 * 真实新秀卡 → 选手：身份取真实选手索引，水平取出道届的真实轨迹，位置取当届（或此前最近一届）的真实位置。
 * 与他同 id 的真实教练（阵容数据中他出道前是教练，如 TI7 的 Papita / StanKing / SVG；sameIdCoach.ts）：自由教练 → 删除；
 * 在 AI 战队执教 → 卸任，该队随即补签主教练（新闻注明）；在人类玩家战队执教 → 不生成（返回 null，暂不出道；
 * 玩家解除其主教练职务时 realEntry.realEntryAfterCoachRelease 让他进入自由市场）。
 */
export function createRealRookie(state: GameState, id: string): Player | null {
  if (state.players[id]) return null;
  const e = indexEntry(id);
  const pt = realDebutPoint(id);
  if (!e || !pt) return null;
  const ti = state.season?.ti ?? e.firstTi;
  const coach = resolveSameIdCoach(state, id, { replace: true });
  if (coach.humanTeamId) return null;
  if (coach.leftTeamIds.length) {
    const handle = e.handle || id;
    const names = coach.leftTeamIds.map((t) => state.teams[t]?.name ?? t).join('、');
    const hired = coach.replacements.map((r) => `${state.teams[r.teamId]?.name ?? r.teamId} 随即聘请 ${r.coachName} 担任主教练。`).join('');
    addNews(
      state,
      'transfer',
      `【教练】${handle} 卸任 ${names} 主教练`,
      `${handle} 是 TI${ti} 登场的真实新秀，卸任 ${names} 主教练，以选手身份出道。${hired}`,
      false,
      { teamIds: coach.leftTeamIds, tags: ['transfer'], noInfer: true },
    );
  }
  const gen = CONFIG.generation;
  const age = seasonYear(state) - num(e.birthYear, seasonYear(state) - 18);
  const seed: SeedPlayer = {
    id,
    handle: e.handle || id,
    ...(e.name ? { name: e.name } : {}),
    nationality: e.nationality,
    birthYear: e.birthYear,
    position: realRoleFor(id, ti) ?? e.position,
    mmr: pt.mmr,
    power: pt.power,
    talent: num(e.peakTalent, 60),
    resilience: clamp(gen.resilienceBase + (age - 18) * gen.resiliencePerYear, 20, 95),
    insight: num(e.insight, 50),
    loyalty: gen.loyaltyMean + gen.rookieLoyaltyBonus,
    signatureHeroes: e.signatureHeroes ?? [],
  };
  const p = playerFromSeed(state, seed, null);
  p.isRookie = true;
  return p;
}

/** 请神卡 → 选手：程序生成的虚拟新秀，复制原型的出道水平 / 天赋 / 灵性 / 位置 / 招牌英雄（与出道年龄），绑定请神关系 */
export function createSummonRookie(state: GameState, member: HallOfFameMember, tier: Tier): Player | null {
  const d = prototypeDebut(member);
  if (!d) return null;
  const copyAge = !!CONFIG.gacha.summonCopyAge;
  const p = generatePlayer(state, { tier, rookie: true, position: d.position, ...(copyAge ? { age: d.age } : {}) });
  p.mmr = Math.round(clamp(d.mmr, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr));
  p.power = round2(Math.max(1, d.power));
  p.talent = round2(d.talent);
  p.insight = round2(d.insight);
  p.position = d.position;
  delete p.altPositions;
  const heroes = d.heroes.filter((h) => !!heroById(h));
  if (heroes.length) p.signatureHeroes = heroes.slice(0, 4);
  p.summon = { id: member.id, handle: member.handle, ti: state.season?.ti ?? 0 };
  clampPlayerAttrs(p);
  p.salary = gachaRookieSalary(state, p);
  return p;
}

/** 卡 → 选手（真实新秀已在本局中 / 原型缺失时退化为同等级虚构新秀） */
function realizeCard(state: GameState, card: DrawnCard): Player {
  if (card.kind === 'real' && card.ref) {
    const p = createRealRookie(state, card.ref);
    if (state.futureRookies) delete state.futureRookies[card.ref];
    if (p) return p;
  } else if (card.kind === 'summon' && card.ref) {
    const m = hofMember(state, card.ref);
    const p = m ? createSummonRookie(state, m, card.tier) : null;
    if (p) return p;
  }
  card.kind = 'fictional';
  delete card.ref;
  return generatePlayer(state, { tier: card.tier, rookie: true });
}

/** 一次抽到的新秀 */
export interface GachaPullResult {
  playerId: string;
  handle: string;
  tier: Tier;
  kind: GachaCardKind;
  proto?: string;
  protoHandle?: string;
  pity?: boolean;
}

/**
 * 为某战队抽 count 张（扣款、抽卡、签约；不做阵容 / 价格校验，调用方负责）。返回抽到的新秀。
 * opts.ai：AI 战队抽卡（计入 pool.aiDrawn，不记逐张记录）。
 */
export function teamGachaPull(state: GameState, teamId: string, count: number, opts: { ai?: boolean } = {}): GachaPullResult[] {
  const team = ownEntry(state.teams, teamId);
  const pool = currentGachaPool(state);
  const n = Math.max(0, Math.floor(num(count, 0)));
  if (!team || team.disbanded || !pool || n <= 0) return [];
  const rng = rngOf(state);
  const { single } = gachaPrice(state);
  const cost = gachaCost(state, n);
  addFinance(state, teamId, -cost, 'gacha', `新秀抽卡 ×${n}`);
  const tg = teamGacha(state, team);
  const threshold = gachaPityThreshold();
  const human = !opts.ai && (team.isPlayer || isHumanTeam(state, teamId));
  const batch = human ? (tg.log?.reduce((m, x) => Math.max(m, num(x.batch, 0)), 0) ?? 0) + 1 : 0;
  const ti = state.season.ti;
  const out: GachaPullResult[] = [];
  for (let i = 0; i < n; i++) {
    const force = tg.pity >= threshold - 1;
    const card = drawCard(state, pool, rng, force);
    const p = realizeCard(state, card);
    addPlayerToTeam(state, p.id, teamId, { salary: gachaRookieSalary(state, p), contractSeasons: gachaRookieContractSeasons() });
    p.isRookie = true;
    p.gacha = {
      ti,
      round: state.roundIndex,
      teamId,
      tier: card.tier,
      kind: card.kind,
      mmr: Math.round(num(p.mmr, 0)),
      power: round2(num(p.power, 0)),
      talent: round2(num(p.talent, 0)),
      insight: round2(num(p.insight, 0)),
    };
    tg.pulls += 1;
    tg.seasonPulls = num(tg.seasonPulls, 0) + 1;
    tg.pity = card.tier === 'SSR' ? 0 : tg.pity + 1;
    pool.drawn += 1;
    if (opts.ai) pool.aiDrawn += 1;
    const res: GachaPullResult = { playerId: p.id, handle: p.handle, tier: card.tier, kind: card.kind };
    if (card.kind === 'summon' && p.summon) {
      res.proto = p.summon.id;
      res.protoHandle = p.summon.handle;
    }
    if (card.pity) res.pity = true;
    out.push(res);
    if (human) {
      const rec: GachaPullRecord = {
        ti, round: state.roundIndex, batch, playerId: p.id, handle: p.handle, tier: card.tier, kind: card.kind, cost: single,
      };
      if (res.proto) {
        rec.proto = res.proto;
        rec.protoHandle = res.protoHandle;
      }
      if (res.pity) rec.pity = true;
      (tg.log ??= []).push(rec);
    }
  }
  syncSynergies(state); // 羁绊：真实新秀可能是羁绊成员
  return out;
}

/** 抽卡新秀的新秀合同赛季数（含当前赛季）；入场的下一回合 AI 接手时出道 / 当届真实战队签回本届真实新秀也用它（entryPass.ts） */
export function gachaRookieContractSeasons(): number {
  return Math.max(1, Math.floor(num(CONFIG.gacha.rookieContractSeasons, 3)));
}

/** 抽卡结果的简短描述（新闻 / 提示） */
export function pullLabel(r: Pick<GachaPullResult, 'handle' | 'tier' | 'kind' | 'protoHandle'>): string {
  const kind = r.kind === 'real' ? ' · 真实新秀' : r.kind === 'summon' ? ` · 请神 ${r.protoHandle ?? ''}` : '';
  return `${r.handle}（${r.tier}${kind}）`;
}

// ---------------------------------------------------------------------------
// 人类玩家操作
// ---------------------------------------------------------------------------

/** 不能抽 count 张的原因（null = 可以）；UI 用作禁用按钮的说明 */
export function gachaPullBlock(state: GameState, count: number): string | null {
  const me = state.settings?.playerTeamId;
  const team = me ? state.teams[me] : undefined;
  if (state.gameOver) return '游戏已结束';
  if (!team || team.disbanded) return '战队不存在';
  if (count !== 1 && count !== 10) return '只能单抽或十连';
  if (!isTransferWindowOpen(state)) return '转会窗口已锁定，本赛季卡池已关闭（TI 结束后的新赛季开放新卡池）';
  if (!currentGachaPool(state)) return '本赛季卡池尚未开放（下个赛季初开放）';
  // 2026-10-15 用户决策「十连后本回合内退回到 12 人」：十连 / 单抽总是抽满，可以让阵容超过绝对上限（12 人），
  // 超编须在本回合内退回（game.getAdvanceBlockers 的 roster_over_cap）；已经超编时先退回才能再抽
  const hard = CONFIG.team.hardMaxRoster;
  const size = rosterSize(state, team.id);
  if (size > hard) {
    return `阵容已超编（${size}/${hard} 人）：先在本回合内放弃新秀或解约 ${size - hard} 人（降到 ${hard} 人以内）后才能继续抽卡`;
  }
  const cost = gachaCost(state, count);
  if (num(team.gold, 0) < cost) return `金币不足：${count === 10 ? '十连' : '单抽'}需要 ${formatGold(cost)}`;
  return null;
}

/** 抽 count 张后超出绝对上限的人数（0 = 不超编；新秀抽卡页的确认文案用） */
export function gachaOverCapAfter(state: GameState, count: number): number {
  const me = state.settings?.playerTeamId;
  if (!me || !state.teams[me]) return 0;
  return Math.max(0, rosterSize(state, me) + Math.max(0, Math.floor(num(count, 0))) - CONFIG.team.hardMaxRoster);
}

/** 抽卡（白名单 RPC）：count = 1（单抽）或 10（十连）。总是抽满；超出绝对上限时须在本回合内退回（见 gachaPullBlock） */
export function gachaPull(state: GameState, count: number): OpResult & { results?: GachaPullResult[] } {
  const n = Math.floor(num(count, 0));
  const block = gachaPullBlock(state, n);
  if (block) return fail(block);
  const me = state.settings.playerTeamId;
  const team = state.teams[me];
  const cost = gachaCost(state, n);
  const results = teamGachaPull(state, me, n);
  if (!results.length) return fail('抽卡失败：卡池不可用');
  const best = results.slice().sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier))[0];
  const hard = CONFIG.team.hardMaxRoster;
  const over = Math.max(0, rosterSize(state, me) - hard);
  const overNote = over > 0
    ? `阵容 ${rosterSize(state, me)}/${hard} 人，超编 ${over} 人：本回合内放弃新秀或解约 ${over} 人（降到 ${hard} 人以内）后才能进入下一回合`
    : '';
  addNews(
    state,
    'transfer',
    `【新秀抽卡】${team.name} ${n === 10 ? '十连' : '单抽'}：${results.length === 1 ? pullLabel(best) : `最高 ${best.tier}`}`,
    `花费 ${formatGold(cost)} 抽到 ${results.length} 名新秀：${results.map(pullLabel).join('、')}。新秀已签下新秀合同入队，`
      + `本回合内可在「转会 › 新秀抽卡」退回（返还单抽价格的 ${Math.round(num(CONFIG.gacha.discardRefundRatio, 0) * 100)}%）。`
      + (overNote ? `\n${overNote}。` : ''),
    false,
    { teamIds: [me], playerIds: results.map((r) => r.playerId), visibility: 'private', actorTeamId: me, tags: ['gacha'], noInfer: true },
  );
  notablePullNews(state, me, results);
  const pity = results.some((r) => r.pity) ? '（保底）' : '';
  return {
    ok: true,
    message: `抽到 ${results.map(pullLabel).join('、')}${pity}${overNote ? `。${overNote}` : ''}`,
    results,
  };
}

/** S 级以上的抽卡结果发公开新闻（人类玩家每次操作一条） */
function notablePullNews(state: GameState, teamId: string, results: GachaPullResult[]): void {
  const min = tierIndex(CONFIG.gacha.newsMinTier ?? 'S');
  const notable = results.filter((r) => tierIndex(r.tier) >= min);
  if (!notable.length) return;
  const team = ownEntry(state.teams, teamId);
  const top = notable.slice().sort((a, b) => tierIndex(b.tier) - tierIndex(a.tier))[0];
  addNews(
    state,
    'transfer',
    `【新秀抽卡】${team?.name ?? teamId} 抽中 ${top.tier} 级新秀 ${top.handle}${top.kind === 'summon' ? `（请神：${top.protoHandle}）` : top.kind === 'real' ? '（真实新秀）' : ''}`,
    `${team?.name ?? teamId} 在 TI${state.season.ti} 新秀抽卡中抽到：${notable.map(pullLabel).join('、')}。`,
    notable.some((r) => r.tier === 'SSR'),
    { teamIds: [teamId], playerIds: notable.map((r) => r.playerId), visibility: 'public', tags: ['gacha'], noInfer: true },
  );
}

/** 本回合抽到、仍可退回的记录（只读） */
function discardableRecord(state: GameState, team: Team, p: Player): GachaPullRecord | null {
  const g = p.gacha;
  if (!g || g.placed || g.teamId !== team.id || g.ti !== state.season?.ti || g.round !== state.roundIndex) return null;
  const log = team.gacha?.seasonTi === state.season?.ti ? team.gacha?.log ?? [] : [];
  return log.find((r) => r.playerId === p.id && !r.discarded && r.round === state.roundIndex) ?? null;
}

/** 不能退回该新秀的原因（null = 可以） */
export function gachaDiscardBlock(state: GameState, p: Player | null | undefined): string | null {
  const me = state.settings?.playerTeamId;
  const team = me ? state.teams[me] : undefined;
  if (state.gameOver) return '游戏已结束';
  if (!team || team.disbanded) return '战队不存在';
  if (!p || p.teamId !== team.id) return '该选手不在你的战队';
  if (!p.gacha || p.gacha.teamId !== team.id) return '只能退回本队抽到的新秀';
  if (!isTransferWindowOpen(state)) return '转会窗口已锁定';
  if (!discardableRecord(state, team, p)) return '只能在抽到他的同一回合内退回';
  return null;
}

/** 退回可得的金币（单抽价格 × discardRefundRatio） */
export function gachaDiscardRefund(state: GameState): number {
  return Math.round(gachaPrice(state).single * clamp(num(CONFIG.gacha.discardRefundRatio, 0), 0, 1));
}

/** 退回本回合抽到的新秀（白名单 RPC）：离队进入自由市场，返还部分抽卡费用（无解约补偿、不扣荣誉） */
export function gachaDiscard(state: GameState, playerId: string): OpResult {
  const p = ownEntry(state.players, playerId);
  const block = gachaDiscardBlock(state, p);
  if (block || !p) return fail(block ?? '该选手不在你的战队');
  const team = state.teams[state.settings.playerTeamId];
  const rec = discardableRecord(state, team, p)!;
  departToFreeAgency(state, p.id);
  if (p.teamId) return fail(`未能退回 ${p.handle}`);
  rec.discarded = true;
  const refund = gachaDiscardRefund(state);
  if (refund > 0) addFinance(state, team.id, refund, 'gacha', `退回新秀 ${p.handle}`);
  addNews(
    state,
    'transfer',
    `【新秀】${team.name} 退回新秀 ${p.handle}`,
    `${team.name} 退回了本回合抽到的 ${p.handle}（${rec.tier} · ${POSITION_LABEL[p.position]}${rec.kind === 'summon' ? ` · 请神 ${rec.protoHandle ?? ''}` : rec.kind === 'real' ? ' · 真实新秀' : ''}），`
      + `返还 ${formatGold(refund)}。他将以自由选手身份寻找新东家。`,
    false,
    { teamIds: [team.id], playerIds: [p.id], visibility: 'private', actorTeamId: team.id, tags: ['gacha'], noInfer: true },
  );
  syncSynergies(state);
  return ok(`已退回 ${p.handle}，返还 ${formatGold(refund)}，他已进入自由市场`);
}

// ---------------------------------------------------------------------------
// AI 战队
// ---------------------------------------------------------------------------

/** AI 替补中保留价值最低者（aiKeepValue；没有替补返回 Infinity） */
function weakestBenchKeep(state: GameState, team: Team): number {
  let min = Infinity;
  for (const p of benchPlayers(state, team.id)) {
    if (p.tempSubUntilTournament) continue;
    const v = aiKeepValue(state, p);
    if (v < min) min = v;
  }
  return min;
}

/**
 * AI 战队本阶段可抽张数（资金盈余、阵容空位、本赛季上限）。超编名额 rosterSlack 只在替补中有保留价值低于 ai.slackKeepMax 的选手时使用
 * （抽到的新秀大概率比他强，整理阵容时放走的是这名替补；否则多抽的一张多半刚抽到就被放走，白花钱）。
 */
export function aiPullAllowance(state: GameState, team: Team, phase: 'opening' | 'midseason'): number {
  const cfg = CONFIG.gacha;
  const price = gachaPrice(state).single;
  const left = Math.max(0, Math.floor(num(cfg.aiMaxPullsPerSeason, 3)) - teamSeasonPulls(state, team));
  const phaseMax = phase === 'opening' ? Math.max(0, Math.floor(num(cfg.ai.openingMax, left))) : left;
  const reserve = roundWageBill(state, team.id) * Math.max(0, num(cfg.ai.reserveRounds, 0));
  const afford = price > 0 ? Math.floor((num(team.gold, 0) - reserve) / price) : 0;
  let room = CONFIG.ai.maxRoster - rosterSize(state, team.id);
  const slack = Math.max(0, Math.floor(num(cfg.ai.rosterSlack, 0)));
  if (slack > 0 && Math.min(left, phaseMax, afford) > 0 && weakestBenchKeep(state, team) < num(cfg.ai.slackKeepMax, Infinity)) room += slack;
  return Math.max(0, Math.min(left, phaseMax, afford, room));
}

/**
 * AI 抽卡后整理阵容：超出 ai.maxRoster 时放走保留价值最低的非首发（进入自由市场）。
 * 放走的是本回合刚抽到的新秀时，与人类玩家退回同一规则返还单抽价格 × discardRefundRatio。
 */
function trimAiAfterPull(state: GameState, team: Team): Player[] {
  const out: Player[] = [];
  const ti = state.season?.ti;
  const refund = gachaDiscardRefund(state);
  for (let guard = 0; guard < 20; guard++) {
    const roster = teamPlayers(state, team.id).filter((p) => !p.tempSubUntilTournament);
    if (roster.length <= CONFIG.ai.maxRoster) break;
    const starters = new Set(POSITIONS.map((pos) => team.lineup?.[pos]).filter((x): x is string => !!x));
    const bench = roster.filter((p) => !starters.has(p.id));
    const pool = bench.length ? bench : roster;
    const victim = pool
      .map((p) => ({ p, v: aiKeepValue(state, p) }))
      .sort((a, b) => a.v - b.v || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0))[0]?.p;
    if (!victim) break;
    departToFreeAgency(state, victim.id);
    if (victim.teamId) break;
    out.push(victim);
    const g = victim.gacha;
    if (refund > 0 && g && !g.placed && g.teamId === team.id && g.ti === ti && g.round === state.roundIndex) {
      addFinance(state, team.id, refund, 'gacha', `退回新秀 ${victim.handle}`);
    }
  }
  return out;
}

/**
 * AI 战队自动抽卡（season.enterRound：第 1 回合开始前 = 'opening'，人类玩家已在赛季初先抽；赛季中期 = 'midseason'）。
 * 战队顺序随机；每队按 aiPullAllowance 抽卡、自动排阵、整理阵容。整理后仍在队的 S 级以上新秀汇总为一条公开新闻。返回抽卡张数。
 */
export function aiGachaPulls(state: GameState, phase: 'opening' | 'midseason'): number {
  const pool = currentGachaPool(state);
  if (!pool || state.gameOver || !isTransferWindowOpen(state)) return 0;
  const rng = rngOf(state);
  const teams = rng.shuffle(
    activeTeams(state)
      .filter((t) => !t.isPlayer && !isHumanTeam(state, t.id) && t.playerIds.length > 0)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
  const min = tierIndex(CONFIG.gacha.newsMinTier ?? 'S');
  const notable: { teamId: string; r: GachaPullResult }[] = [];
  let total = 0;
  for (const team of teams) {
    const n = aiPullAllowance(state, team, phase);
    if (n <= 0) continue;
    const res = teamGachaPull(state, team.id, n, { ai: true });
    total += res.length;
    autoLineup(state, team.id);
    if (trimAiAfterPull(state, team).length) autoLineup(state, team.id);
    for (const r of res) if (tierIndex(r.tier) >= min && state.players[r.playerId]?.teamId === team.id) notable.push({ teamId: team.id, r });
  }
  if (notable.length) {
    notable.sort((a, b) => tierIndex(b.r.tier) - tierIndex(a.r.tier) || (a.r.handle < b.r.handle ? -1 : 1));
    const lines = notable.slice(0, 12).map(({ teamId, r }) => `${ownEntry(state.teams, teamId)?.name ?? teamId}：${pullLabel(r)}`);
    addNews(
      state,
      'transfer',
      `【新秀抽卡】${phase === 'opening' ? '开赛前' : '赛季中期'}各队抽卡：${notable.length} 名 S 级以上新秀加盟`,
      `${lines.join('\n')}${notable.length > lines.length ? `\n……另有 ${notable.length - lines.length} 名。` : ''}`,
      notable.some((x) => x.r.tier === 'SSR'),
      {
        teamIds: [...new Set(notable.map((x) => x.teamId))].slice(0, 8),
        playerIds: notable.slice(0, 12).map((x) => x.r.playerId),
        visibility: 'public',
        tags: ['gacha'],
        noInfer: true,
      },
    );
  }
  return total;
}

// ---------------------------------------------------------------------------
// 真实新秀离池（第 1 回合开始前）/ 卡池关闭（TI 预选赛转会锁定）
// v0.4.3【用户指定，2026-10-16】「真实新秀如果没抽到则直接上场到自由市场中」：未被抽走的真实新秀以自由身进入自由市场，
// 不再按真实出道去向加盟（此前出道战队是 AI 时直接加盟、是人类玩家时发「签下 / 放弃」事件 rookie_home）。
// 入场的回合内 AI 战队不从自由市场签下他们（marketEntry.ts），人类玩家先看到、可以立即签约；入场的下一回合结束时 AI 接手一次
// （entryPass.ts：出道战队 / 当届真实战队优先按新秀合同签回，否则按 AI 需求）。卡池关闭（转会窗口锁定）时离池的，公平窗口留到下个赛季初窗口开放的回合。
// ---------------------------------------------------------------------------

/** 真实新秀的抽卡出身记录（未被抽走：teamId 为空 = 进入自由市场；旧版本按真实出道去向加盟时为加盟的战队） */
function placedRecord(state: GameState, p: Player, ti: number, tier: Tier, teamId: string): NonNullable<Player['gacha']> {
  return {
    ti,
    round: state.roundIndex,
    teamId,
    tier,
    kind: 'real',
    mmr: Math.round(num(p.mmr, 0)),
    power: round2(num(p.power, 0)),
    talent: round2(num(p.talent, 0)),
    insight: round2(num(p.insight, 0)),
    placed: true,
  };
}

/**
 * 一名未被抽走的真实新秀以自由身进入自由市场：按出道届的真实水平与当届真实位置生成（createRealRookie），记录抽卡出身（placed，teamId 为空）
 * 与入场时刻（入场的回合内 AI 不签）。已在本局中或数据缺失时返回 null（同时清掉 futureRookies 条目）。不消耗随机数。
 * 也用于旧存档待决的「真实新秀希望加盟」事件的迁移（realEntry.migrateRealEntry）。
 */
export function releaseRealRookieToMarket(state: GameState, id: string, tier: Tier, ti: number): Player | null {
  const p = createRealRookie(state, id);
  if (state.futureRookies) delete state.futureRookies[id];
  if (!p) return null;
  p.gacha = placedRecord(state, p, ti, tier, '');
  markMarketEntry(state, p);
  return p;
}

/** 离池的真实新秀：进入自由市场的选手；与他同 id 的教练在人类玩家战队执教而暂不出道的（显示 ID、战队） */
interface RealRelease {
  free: Player[];
  held: { handle: string; teamId: string }[];
}

/** 一批未被抽走的真实新秀卡进入自由市场；结果计入 pool 的离池统计 */
function releaseRealCards(state: GameState, pool: GachaPool, cards: { id: string; t: Tier }[]): RealRelease {
  const out: RealRelease = { free: [], held: [] };
  for (const { id, t } of cards) {
    // 离池而未被抽走的卡（本届抽出张数 = 构成 − 剩余 − 离池）
    (pool.realPlaced ??= {})[t] = num(pool.realPlaced[t], 0) + 1;
    // 与他同 id 的教练在人类玩家战队执教：暂不出道（解除主教练职务后进入自由市场，realEntry.realEntryAfterCoachRelease）
    const humanTeam = state.players[id] ? null : sameIdHumanCoachTeam(state, id);
    if (humanTeam) {
      if (state.futureRookies) delete state.futureRookies[id];
      out.held.push({ handle: indexEntry(id)?.handle || id, teamId: humanTeam });
      continue;
    }
    const p = releaseRealRookieToMarket(state, id, t, pool.ti);
    if (p) out.free.push(p);
  }
  pool.realFree = num(pool.realFree, 0) + out.free.length;
  return out;
}

/** 暂不出道的说明（新闻正文） */
function heldRookieText(state: GameState, held: RealRelease['held']): string {
  if (!held.length) return '';
  return `${held.map((h) => `${h.handle} 现任 ${state.teams[h.teamId]?.name ?? h.teamId} 主教练`).join('；')}，继续执教、暂不出道；`
    + `解除其主教练职务后以自由身进入自由市场。`;
}

/** 新闻里的名单：「Topson（S 级 · 2号位 中单）」，等级从高到低、同级按显示 ID，最多 CONFIG.realEntry.newsMax 人 */
function rookieNewsList(list: Player[]): string {
  const max = Math.max(1, Math.floor(num(CONFIG.realEntry?.newsMax, 12)));
  const key = (p: Player) => (p.handle || p.id).toLowerCase();
  const sorted = list.slice().sort((a, b) => tierIndex(playerTier(b)) - tierIndex(playerTier(a))
    || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const shown = sorted.slice(0, max).map((p) => `${p.handle}（${playerTier(p)} 级 · ${POSITION_LABEL[p.position]}）`);
  return `${shown.join('、')}${sorted.length > max ? ` 等 ${sorted.length} 人` : ''}`;
}

/**
 * 第 1 回合开始前（season.enterRound，AI 开赛前抽卡之前）：未被抽走的真实新秀卡离开卡池，以自由身进入自由市场
 * （入场的回合内 AI 战队不签，人类玩家可以立即签约），同等级补入等量的请神 / 虚构卡（之后的出卡比例仍为用户指定比例）。
 * 同一赛季只执行一次；返回离池的真实新秀人数。
 */
export function releaseRealRookieCards(state: GameState): number {
  const pool = currentGachaPool(state);
  if (!pool || pool.realReleased || state.gameOver) return 0;
  pool.realReleased = true;
  const cards = TIERS.slice().reverse().flatMap((t) => (pool.real[t] ?? []).map((id) => ({ id, t })));
  if (!cards.length) return 0;
  pool.real = {};
  const backfill = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const c of cards) backfill[c.t] += 1;
  fillTiers(state, pool, backfill, null, rngOf(state));
  pool.size += cards.length;
  pool.backfilled = num(pool.backfilled, 0) + cards.length;
  const { free, held } = releaseRealCards(state, pool, cards);
  if (free.length || held.length) {
    const note = marketEntryNote(state, free.length);
    addNews(
      state,
      'transfer',
      free.length ? `【新秀】TI${pool.ti} 未被抽走的真实新秀进入自由市场：${free.length} 人` : `【新秀】TI${pool.ti} 未被抽走的真实新秀暂不出道`,
      `开赛前没有被抽走的真实新秀离开卡池（卡池补入同等级的请神 / 虚构卡，继续开放到 TI 预选赛）`
        + `${free.length ? `，以自由身进入自由市场：${rookieNewsList(free)}。` : '。'}`
        + `${note ? `${note}本赛季新成立的真实俱乐部签回自家出道新秀不受此限。` : ''}`
        + heldRookieText(state, held),
      true,
      { playerIds: free.map((p) => p.id), teamIds: held.map((h) => h.teamId), tags: ['gacha', 'transfer'], noInfer: true },
    );
  }
  return cards.length;
}

/**
 * 旧存档待决的「真实新秀希望加盟」事件（rookie_home，v0.4.3 起不再产生；读档时 realEntry.migrateRealEntry 会把它们改为直接进入自由市场）
 * 的处理结果（events.resolveDecision 调用；keep = 不移除该事件，玩家可改选）：签下 = 新秀合同加盟本队；放弃 = 他进入自由市场。
 */
export function resolveHomeRookieDecision(
  state: GameState, team: Team, decision: Pick<PendingDecision, 'ctx'>, choiceId: string,
): { ok: boolean; message: string; keep?: boolean } {
  const ctx = decision.ctx ?? {};
  const id = typeof ctx.rookieId === 'string' ? ctx.rookieId : '';
  const tier = (TIERS as string[]).includes(String(ctx.tier)) ? (ctx.tier as Tier) : 'C';
  const ti = num(ctx.ti, state.season?.ti ?? 0);
  if (!id || ctx.teamId !== team.id) return { ok: true, message: '事件已失效' };
  if (Object.prototype.hasOwnProperty.call(state.players, id)) return { ok: true, message: '他已有新的去向' };
  if (choiceId === 'sign') {
    const hard = CONFIG.team.hardMaxRoster;
    if (rosterSize(state, team.id) >= hard) {
      return { ok: false, keep: true, message: `阵容已达绝对上限（${hard} 人），请先解约或出售选手，或选择放弃` };
    }
    const p = createRealRookie(state, id);
    if (state.futureRookies) delete state.futureRookies[id];
    if (!p) return { ok: true, message: '新秀数据缺失，事件取消' };
    addPlayerToTeam(state, p.id, team.id, { salary: gachaRookieSalary(state, p), contractSeasons: gachaRookieContractSeasons() });
    if (p.teamId !== team.id) return { ok: false, message: `未能签下 ${p.handle}` };
    p.isRookie = true;
    p.gacha = placedRecord(state, p, ti, tier, team.id);
    addNews(
      state,
      'transfer',
      `【新秀】${p.handle} 加盟 ${team.name}`,
      `TI${ti} 真实新秀 ${p.handle}（${tier} · ${POSITION_LABEL[p.position]}）按真实出道去向加盟 ${team.name}，`
        + `签下 ${gachaRookieContractSeasons()} 个赛季的新秀合同，工资 ${formatGold(p.salary)}/回合。`,
      false,
      { teamIds: [team.id], playerIds: [p.id], tags: ['gacha', 'transfer'], noInfer: true },
    );
    syncSynergies(state);
    return { ok: true, message: `已签下 ${p.handle}（工资 ${formatGold(p.salary)}/回合）` };
  }
  const p = releaseRealRookieToMarket(state, id, tier, ti);
  if (!p) return { ok: true, message: '新秀数据缺失，事件取消' };
  addNews(
    state,
    'transfer',
    `【新秀】${team.name} 放弃真实新秀 ${p.handle}`,
    `${team.name} 没有签下按真实出道去向而来的 ${p.handle}（${tier}），他进入自由市场。`,
    false,
    { teamIds: [team.id], playerIds: [p.id], visibility: 'private', actorTeamId: team.id, tags: ['gacha'], noInfer: true },
  );
  return { ok: true, message: `已放弃 ${p.handle}，他进入自由市场` };
}

/**
 * 关闭本赛季卡池（season.enterRound 进入 TI 预选赛回合时；新赛季建池前若旧卡池仍未关闭也会先关闭）：
 * 仍在池中的真实新秀（旧卡池：第 1 回合前没有离池）以自由身进入自由市场，其余卡作废；记录本届汇总并发一条新闻。
 */
export function closeGachaPool(state: GameState): GachaSeasonRecord | null {
  const gs = gachaState(state);
  const pool = gs.pool;
  if (!pool) return null;
  gs.pool = null;
  const cards = TIERS.slice().reverse().flatMap((t) => (pool.real[t] ?? []).map((id) => ({ id, t })));
  let late: RealRelease = { free: [], held: [] };
  if (cards.length && !state.gameOver && (CONFIG.gacha as { placeUnpulledReal?: boolean }).placeUnpulledReal !== false) {
    pool.real = {};
    late = releaseRealCards(state, pool, cards);
  }
  const made = pool.made ?? {};
  const rec: GachaSeasonRecord = {
    ti: pool.ti,
    size: pool.size,
    base: pool.base,
    refills: pool.refills,
    made,
    drawn: pool.drawn,
    aiDrawn: pool.aiDrawn,
    ssr: 0,
    summons: 0,
    realJoined: num(pool.realJoined, 0),
    realFree: num(pool.realFree, 0),
  };
  if (pool.realOffered) rec.realOffered = pool.realOffered;
  // 本届抽出的 SSR / 请神：构成 − 剩余 − 离池的真实新秀
  for (const t of TIERS) {
    const m = made[t] ?? [0, 0, 0];
    const left = (pool.real[t]?.length ?? 0) + (pool.summon[t]?.length ?? 0) + num(pool.fictional[t], 0);
    if (t === 'SSR') rec.ssr = Math.max(0, m[0] + m[1] + m[2] - left - num(pool.realPlaced?.[t], 0));
    rec.summons += Math.max(0, m[1] - (pool.summon[t]?.length ?? 0));
  }
  gs.history.push(rec);
  const keep = Math.max(1, Math.floor(num(CONFIG.gacha.historyMax, 16)));
  if (gs.history.length > keep) gs.history.splice(0, gs.history.length - keep);
  if (!state.gameOver && (late.free.length || late.held.length)) {
    // 进入 TI 预选赛时关闭：转会窗口锁定，公平窗口留到下个赛季初（marketEntry.ts）；新赛季建池前关闭旧卡池时为赛季初
    addNews(
      state,
      'transfer',
      late.free.length
        ? `【新秀】TI${pool.ti} 卡池关闭：${late.free.length} 名未被抽走的真实新秀进入自由市场`
        : `【新秀】TI${pool.ti} 卡池关闭：未被抽走的真实新秀暂不出道`,
      `本赛季新秀抽卡结束（共抽出 ${pool.drawn} 张）。`
        + `${late.free.length ? `未被抽走的真实新秀以自由身进入自由市场：${rookieNewsList(late.free)}。${marketEntryNote(state, late.free.length)}` : ''}`
        + heldRookieText(state, late.held),
      false,
      { playerIds: late.free.map((p) => p.id), teamIds: late.held.map((h) => h.teamId), tags: ['gacha'], noInfer: true },
    );
  }
  return rec;
}

// ---------------------------------------------------------------------------
// 界面（只读）
// ---------------------------------------------------------------------------

export interface GachaTierView {
  tier: Tier;
  real: number;
  summon: number;
  fictional: number;
  total: number;
  /** 下一抽抽到该等级的概率（按剩余张数） */
  chance: number;
  /** 本赛季发出的 [真实, 请神, 虚构] */
  made: [number, number, number];
}

export interface GachaView {
  open: boolean;
  ti: number;
  single: number;
  ten: number;
  remaining: number;
  size: number;
  base: number;
  refills: number;
  enlargedBy: Tier[];
  drawn: number;
  aiDrawn: number;
  tiers: GachaTierView[];
  /** 剩余的真实新秀卡（id + 显示 ID），按等级从高到低 */
  realLeft: { id: string; handle: string; tier: Tier }[];
  /** 剩余请神卡的原型（id + 显示 ID + 张数），按等级从高到低 */
  summonLeft: { id: string; handle: string; tier: Tier; n: number }[];
  /** 第 1 回合开始前未被抽走的真实新秀卡已离池（之后只有请神与虚构卡） */
  realReleased: boolean;
  pity: number;
  pityThreshold: number;
  seasonPulls: number;
  refund: number;
}

/** 抽卡页数据（只读，不修改状态、不消耗随机数） */
export function gachaView(state: GameState, teamId: string = state.settings?.playerTeamId): GachaView {
  const pool = currentGachaPool(state);
  const { single, ten } = gachaPrice(state);
  const team = ownEntry(state.teams, teamId);
  const remaining = poolRemaining(pool);
  const tiers: GachaTierView[] = TIERS.slice().reverse().map((t) => {
    const real = pool?.real[t]?.length ?? 0;
    const summon = pool?.summon[t]?.length ?? 0;
    const fictional = num(pool?.fictional[t], 0);
    const total = real + summon + fictional;
    const m = pool?.made[t] ?? [0, 0, 0];
    return { tier: t, real, summon, fictional, total, chance: remaining > 0 ? total / remaining : 0, made: [m[0], m[1], m[2]] };
  });
  const realLeft: GachaView['realLeft'] = [];
  const summonLeft: GachaView['summonLeft'] = [];
  if (pool) {
    for (const t of TIERS.slice().reverse()) {
      for (const id of pool.real[t] ?? []) realLeft.push({ id, handle: indexEntry(id)?.handle ?? id, tier: t });
      const counts = new Map<string, number>();
      for (const id of pool.summon[t] ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, n] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        summonLeft.push({ id, handle: hofMember(state, id)?.handle ?? id, tier: t, n });
      }
    }
  }
  return {
    open: !!pool && isTransferWindowOpen(state),
    ti: state.season?.ti ?? 0,
    single,
    ten,
    remaining,
    size: pool?.size ?? 0,
    base: pool?.base ?? 0,
    refills: pool?.refills ?? 0,
    enlargedBy: pool?.enlargedBy ?? [],
    drawn: pool?.drawn ?? 0,
    aiDrawn: pool?.aiDrawn ?? 0,
    tiers,
    realLeft,
    summonLeft,
    realReleased: !!pool?.realReleased,
    pity: num(team?.gacha?.pity, 0),
    pityThreshold: gachaPityThreshold(),
    seasonPulls: teamSeasonPulls(state, team),
    refund: gachaDiscardRefund(state),
  };
}

/** 本赛季的抽卡记录（只读；最新在前） */
export function gachaLog(state: GameState, teamId: string = state.settings?.playerTeamId): GachaPullRecord[] {
  const g = ownEntry(state.teams, teamId)?.gacha;
  if (!g || g.seasonTi !== state.season?.ti) return [];
  return (g.log ?? []).slice().reverse();
}

/** 往届抽卡汇总（最新在前） */
export function gachaHistory(state: GameState): GachaSeasonRecord[] {
  return (state.gacha?.history ?? []).filter((r) => !!r).slice().reverse();
}
