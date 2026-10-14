// ============================================================================
// 隐藏的预期薪资与归属感环境模型（第八波 · 管理难度与公平性）【G1-salary-loyalty】
//
// - expectedSalary(state, p) = 当前市场工资(player.computeSalary) × 荣誉系数(所在战队荣誉，凸函数) × 明星系数(等级、近期冠军/MVP)。
//   预期薪资与薪资差 g 只在引擎内部使用，界面只显示定性情绪（满意 / 略有不满 / 强烈不满）。
// - 薪资差 g = (预期 − 实际) / 预期：越大、且比上回合拉大 → 归属感下降越快（growth.roundLoyaltyUpdate），
//   公开不满新闻、AI 报价/挖角更积极、低归属感时更易申请离队（events.ts / market.ts）。
// - 归属感环境维度（人类玩家战队，每回合）：荣誉（战队荣誉 vs 选手等级期待）、薪资差；
//   在队时长决定这两项的速度倍数：第一个赛季 ×0.5，第二个 ×1，第三个 ×2，之后等比（×4…，上限 CONFIG.salary.tenure.cap）。
// - 第八波平衡：玩家战队签约 / 求购按俱乐部地位开价（signingSalary）；单机接管真实俱乐部时工资对齐到预期附近（alignInitialSalaries）。
// 纯函数（除 update/record/align 外不修改 state）；不消耗 state.rng（续约 / 签约要价的隐藏浮动用存档/选手/赛季哈希，结果固定）。
// ============================================================================
import { CONFIG } from './config';
import { computeSalary, effectiveAttr, playerTier, tierIndex } from './player';
import { hashSeed, seededRng } from './rng';
import type { GameState, Player, SalaryTrack, Team, Tier } from './types';
import { clamp, ownEntry } from './util';
import { rosterSize } from './team';

/** 薪资满意度（定性） */
export type SalaryMood = 'satisfied' | 'mild' | 'strong';

export const SALARY_MOOD_LABEL: Record<SalaryMood, string> = {
  satisfied: '满意',
  mild: '略有不满',
  strong: '强烈不满',
};

/** 整体情绪（定性） */
export type OverallMood = 'content' | 'steady' | 'wavering' | 'leaving';

export const OVERALL_MOOD_LABEL: Record<OverallMood, string> = {
  content: '心满意足',
  steady: '状态安稳',
  wavering: '有些动摇',
  leaving: '萌生去意',
};

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function seasonTi(state: GameState): number {
  return num(state.season?.ti, 0);
}

// ---------------------------------------------------------------------------
// 预期薪资
// ---------------------------------------------------------------------------

/**
 * 荣誉系数（凸函数：荣誉越高增长越快）：base + k × (max(0, 荣誉) / ref)^exp，夹在 [base, maxFactor]（base = honorBase ≤ 1）。
 * 默认 100 荣誉 ≈ ×0.90、1000 ≈ ×1.06、1500 ≈ ×1.23、2000 ≈ ×1.46、2500 ≈ ×1.73（数值见 CONFIG.salary）。
 */
export function honorSalaryFactor(honor: number): number {
  const S = CONFIG.salary;
  const h = Math.max(0, num(honor, 0));
  const ref = S.honorRef > 0 ? S.honorRef : 1000;
  const exp = S.honorExp > 0 ? S.honorExp : 1;
  const base = clamp(num(S.honorBase, 1), 0.5, 1);
  const f = base + Math.max(0, S.honorK) * Math.pow(h / ref, exp);
  return clamp(Number.isFinite(f) ? f : 1, base, Math.max(1, S.honorMaxFactor));
}

/**
 * 近期荣誉热度（冠军 / MVP）：salaryTrack 中的累计热度按赛季衰减（seasonDecay^赛季差），
 * 再加上自上次结算以来新增的冠军 / TI 冠军 / MVP（只读，不修改选手）。无跟踪记录时为 0。
 */
export function playerFame(state: GameState, p: Player): number {
  const F = CONFIG.salary.fame;
  const t = p.salaryTrack;
  if (!t) return 0;
  const ti = seasonTi(state);
  let fame = Math.max(0, num(t.fame, 0));
  const seasons = Math.max(0, ti - num(t.ti, ti));
  if (seasons > 0 && fame > 0) fame *= Math.pow(clamp(F.seasonDecay, 0, 1), seasons);
  const st = p.stats;
  if (st) {
    fame += Math.max(0, num(st.titles) - num(t.titles, num(st.titles))) * F.title;
    fame += Math.max(0, num(st.tiTitles) - num(t.tiTitles, num(st.tiTitles))) * F.tiTitle;
    fame += Math.max(0, num(st.mvp) - num(t.mvp, num(st.mvp))) * F.mvp;
  }
  return clamp(fame, 0, F.max);
}

/** 明星系数 = 等级系数 × (1 + min(fameMaxBonus, 近期热度 × fameWeight)) */
export function starSalaryFactor(state: GameState, p: Player): number {
  const S = CONFIG.salary;
  const tier: Tier = playerTier(p);
  const tierMult = num(S.starTierMult[tier], 1);
  const bonus = Math.min(Math.max(0, S.fame.maxBonus), playerFame(state, p) * Math.max(0, S.fame.weight));
  return Math.max(0, tierMult) * (1 + bonus);
}

/** 当前市场工资（按当前能力与年代重算的正常工资，不含新秀折扣） */
export function marketWage(state: GameState, p: Player): number {
  return computeSalary(state, p, false);
}

/**
 * 隐藏的预期薪资：市场工资 × 荣誉系数（teamId 缺省为选手所在战队；自由选手按 ×1）× 明星系数。
 * 不在界面显示数值。
 */
export function expectedSalary(state: GameState, p: Player, teamId?: string | null): number {
  if (!p) return 0;
  const team = (teamId ?? p.teamId) ? state.teams[(teamId ?? p.teamId) as string] : undefined;
  const honorF = team && !team.disbanded ? honorSalaryFactor(team.honor) : 1;
  const v = marketWage(state, p) * honorF * starSalaryFactor(state, p);
  return Math.max(CONFIG.economy.minSalary, Math.round(Number.isFinite(v) ? v : 0));
}

/**
 * 登场赛季的新秀与当前战队签的是新秀合同：被本队抽卡抽中（player.gacha）/ 选秀选中（player.draft），或无记录（旧存档的新秀签约）。
 * 被其他战队选中后转投本队（按市场工资转会 / 签约）的不算。
 */
function rookieDealWith(p: Player, teamId: string): boolean {
  if (!p.isRookie) return false;
  // 抽卡新秀（gacha.ts）：抽中他的战队（或按真实出道去向加盟的战队）签的是新秀合同
  const g = p.gacha;
  if (g && typeof g === 'object') return g.teamId === teamId;
  const d = p.draft;
  return !d || typeof d !== 'object' || d.teamId === teamId;
}

/**
 * 是否仍在新秀合同期内（期间薪资差不计：新秀接受新秀合同，续约时才按预期要价）。
 * 判定：salaryTrack 记录了本队的新秀合同 → 按其到期赛季；否则以登场赛季的新秀合同（rookieDealWith）为准。
 */
export function onRookieContract(state: GameState, p: Player): boolean {
  if (!p?.teamId) return false;
  const t = p.salaryTrack;
  if (t && t.rookieTeamId === p.teamId) return num(t.rookieUntil, -Infinity) >= seasonTi(state);
  return rookieDealWith(p, p.teamId);
}

/** 是否适用薪资情绪（在队、active、非临时/野外替补） */
function salaryApplies(p: Player): boolean {
  return !!p && p.status === 'active' && !!p.teamId && !p.tempSubUntilTournament && !p.isWildSub;
}

/**
 * 薪资差 g = (预期 − 实际) / 预期（实际默认 = 当前工资），夹在 [-gapFloor, 1]。
 * 不适用（自由选手、临时替补、新秀合同期）时为 0。
 */
export function salaryGap(state: GameState, p: Player, salary?: number, teamId?: string | null): number {
  if (!salaryApplies(p) && teamId == null) return 0;
  if (teamId == null && onRookieContract(state, p)) return 0;
  const exp = expectedSalary(state, p, teamId);
  if (!(exp > 0)) return 0;
  const base = Math.max(0, num(salary ?? p.salary, 0));
  // 奖金分成：近期分到的赛事奖金按每回合折算全额计入薪资满意度（只计在该战队分到的；2026-10-10 用户决策）
  const s = base + prizeSalaryCredit(state, p, teamId ?? p.teamId, base);
  return clamp((exp - s) / exp, -Math.abs(CONFIG.salary.gapFloor), 1);
}

// ---------------------------------------------------------------------------
// 奖金分成（第九波，prizeShare.ts）：环境项与奖金收入计入薪资满意度
// ---------------------------------------------------------------------------

/**
 * 奖金分成比例的每回合归属感环境项（不乘在队时长倍数）：高于 norm 小幅加分、低于扣分。
 * 比例缺失（尚未补齐）视为 norm → 0。
 */
export function prizeShareLoyaltyDelta(share: number | null | undefined): number {
  const L = CONFIG.prizeShare.loyalty;
  if (typeof share !== 'number' || !Number.isFinite(share)) return 0;
  const d = share - L.norm;
  if (Math.abs(d) < 1e-9) return 0;
  const v = d > 0 ? Math.max(0, L.abovePer10) * (d / 0.1) : -Math.max(0, L.belowPer10) * (-d / 0.1);
  return Math.round(v * 1000) / 1000;
}

/** 回合键：赛季 × 100 + 回合（与 prizeShare / squadOps 的回合键一致） */
function roundKeyNow(state: GameState): number {
  return seasonTi(state) * 100 + Math.max(0, Math.floor(num(state.roundIndex, 0)));
}

/** 从回合键 key 到现在经过的回合数（跨赛季按每赛季回合数估算；不为负） */
function roundsSince(state: GameState, key: number): number {
  const perSeason = Math.max(1, state.season?.rounds?.length || CONFIG.calendar.regularRounds + 3);
  const now = roundKeyNow(state);
  const d = (Math.floor(now / 100) - Math.floor(key / 100)) * perSeason + ((now % 100) - (key % 100));
  return Number.isFinite(d) ? Math.max(0, d) : 0;
}

/** 奖金折算薪资的窗口回合数（CONFIG.prizeShare.salary.windowRounds，至少 1） */
function prizeWindowRounds(): number {
  return Math.max(1, num(CONFIG.prizeShare.salary.windowRounds, 20));
}

/**
 * 近期分到的奖金余额（只计在 teamId 战队分到的；无记录为 0）：每过一个回合 × (1 − 1/窗口回合数)，
 * 与 prizeSalaryCredit 的「余额 / 窗口回合数」配合，一笔奖金在之后的各回合中合计正好全额计入一次。
 * 余额低于一回合的最低工资（economy.minSalary）时视为 0。
 */
export function recentPrizeEarned(state: GameState, p: Player, teamId?: string | null): number {
  const t = p?.salaryTrack;
  if (!t || !(num(t.prizeEarned) > 0)) return 0;
  const tid = teamId === undefined ? p.teamId : teamId;
  if (!tid || t.prizeTeamId !== tid) return 0;
  // 旧存档只记录了赛季：按该赛季第 0 回合计
  const key = typeof t.prizeRound === 'number' && Number.isFinite(t.prizeRound)
    ? t.prizeRound
    : num(t.prizeTi, seasonTi(state)) * 100;
  const elapsed = Math.min(roundsSince(state, key), 2000);
  const v = num(t.prizeEarned) * Math.pow(1 - 1 / prizeWindowRounds(), elapsed);
  return Number.isFinite(v) && v >= CONFIG.economy.minSalary ? v : 0;
}

/**
 * 奖金收入折算的「薪资补贴」（每回合计入薪资满意度；不改变实际工资，预期薪资仍不显示）：
 * 近期奖金余额 / windowRounds × weight（用户决策 2026-10-10：队员分到的奖金全额计入总薪资，weight = 1；
 * 余额每回合按 1/windowRounds 衰减，一笔奖金折算到之后各回合的补贴合计 = 奖金本身）。不设上限：薪资差 g 本身有下限 gapFloor。
 */
export function prizeSalaryCredit(state: GameState, p: Player, teamId?: string | null, _baseSalary?: number): number {
  const S = CONFIG.prizeShare.salary;
  const earned = recentPrizeEarned(state, p, teamId);
  if (!(earned > 0)) return 0;
  const v = (earned / prizeWindowRounds()) * Math.max(0, num(S.weight, 0));
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** 记录队员分到的奖金（prizeShare.payTournamentPrize 调用；先把旧余额衰减到当前回合再累加；换队后从零开始累计） */
export function recordPrizeIncome(state: GameState, p: Player, amount: number, teamId: string): void {
  if (!p || !teamId || !(num(amount) > 0)) return;
  const t = trackOf(p);
  const prev = recentPrizeEarned(state, p, teamId);
  t.prizeEarned = Math.round(prev + num(amount));
  t.prizeTi = seasonTi(state);
  t.prizeRound = roundKeyNow(state);
  t.prizeTeamId = teamId;
}

/** g → 定性薪资满意度 */
export function salaryMoodOf(gap: number): SalaryMood {
  const M = CONFIG.salary.mood;
  const g = num(gap, 0);
  if (g >= M.strongGap) return 'strong';
  if (g >= M.mildGap) return 'mild';
  return 'satisfied';
}

/** 选手当前的薪资满意度（定性） */
export function playerSalaryMood(state: GameState, p: Player): SalaryMood {
  return salaryMoodOf(salaryGap(state, p));
}

/** 薪资满意度等级（0 满意 / 1 略有不满 / 2 强烈不满），便于比较 */
export function salaryMoodLevel(mood: SalaryMood): number {
  return mood === 'strong' ? 2 : mood === 'mild' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 在队时长 → 速度倍数
// ---------------------------------------------------------------------------

/** 在当前战队效力的赛季序号（加盟赛季 = 0） */
export function tenureSeasons(state: GameState, p: Player): number {
  const ti = seasonTi(state);
  return Math.max(0, ti - num(p.joinedSeason, ti));
}

/** 速度倍数：firstSeasonMult × growth^在队赛季，上限 cap（默认 0.5 / 1 / 2 / 4 / 8 …） */
export function tenureSpeedMult(seasons: number): number {
  const T = CONFIG.salary.tenure;
  const n = Math.max(0, Math.floor(num(seasons, 0)));
  const v = Math.max(0, T.firstSeasonMult) * Math.pow(Math.max(1, T.growth), Math.min(n, 64));
  return Math.min(Math.max(0, T.cap), Number.isFinite(v) ? v : T.cap);
}

// ---------------------------------------------------------------------------
// 归属感环境维度（每回合，速度倍数之前）
// ---------------------------------------------------------------------------

/**
 * 薪资维度：g > gapGrace 时 −gapRate × ((g − grace)/gapRef)^gapExp（随差距加速，单回合上限 gapMaxPerRound）；
 * g < −gapGrace（薪水高于预期）时小幅 +overpaidRate × min(1, (−g − grace)/overpaidRef)。
 */
export function salaryLoyaltyDelta(gap: number): number {
  const L = CONFIG.salary.loyalty;
  const g = num(gap, 0);
  if (g > L.gapGrace) {
    const x = (g - L.gapGrace) / Math.max(1e-6, L.gapRef);
    return -Math.min(Math.max(0, L.gapMaxPerRound), Math.max(0, L.gapRate) * Math.pow(x, Math.max(1, L.gapExp)));
  }
  if (g < -L.gapGrace) {
    return Math.max(0, L.overpaidRate) * Math.min(1, (-g - L.gapGrace) / Math.max(1e-6, L.overpaidRef));
  }
  return 0;
}

/** 差距拉大的额外惩罚：g 比上回合增大（且仍处于不满区间）时 −growthPer01 × 增幅/0.1（上限 growthMax） */
export function gapGrowthDelta(gap: number, prevGap: number | undefined | null): number {
  const L = CONFIG.salary.loyalty;
  if (prevGap == null || !Number.isFinite(prevGap)) return 0;
  const g = num(gap, 0);
  const rise = g - prevGap;
  if (g <= L.gapGrace || rise < L.growthMinStep) return 0;
  return -Math.min(Math.max(0, L.growthMax), Math.max(0, L.growthPer01) * (rise / 0.1));
}

/**
 * 荣誉维度：战队荣誉 < 选手等级期待(market.tierHonorExpectation) × loyalty.honorGapRatio 时扣分，
 * 落差越大越多：honorGapPenalty × honorRate × (floor + (1 − floor) × 落差比例)；荣誉 ≥ 期待 × honorProudRatio 时 +honorProudBonus。
 * 期待为 0（低等级）时无影响。
 */
export function honorLoyaltyDelta(honor: number, tier: Tier): number {
  const exp = num(CONFIG.market.tierHonorExpectation[tier], 0);
  if (!(exp > 0)) return 0;
  const L = CONFIG.salary.loyalty;
  const h = num(honor, 0);
  const line = exp * CONFIG.loyalty.honorGapRatio;
  if (h < line) {
    const d = clamp(1 - h / Math.max(1e-6, line), 0, 1);
    const floor = clamp(L.honorPenaltyFloor, 0, 1);
    return CONFIG.loyalty.honorGapPenalty * Math.max(0, L.honorRate) * (floor + (1 - floor) * d);
  }
  if (h >= exp * L.honorProudRatio) return Math.max(0, L.honorProudBonus);
  return 0;
}

export interface LoyaltyEnvironment {
  /** 当前薪资差 g（不适用时为 0） */
  gap: number;
  /** 荣誉维度（未乘速度倍数） */
  honor: number;
  /** 薪资维度（未乘速度倍数） */
  salary: number;
  /** 差距拉大的额外惩罚（未乘速度倍数） */
  growth: number;
  /** 在队时长速度倍数 */
  mult: number;
  /** 奖金分成环境项（第九波，不乘速度倍数；可选以兼容旧调用方） */
  prize?: number;
  /** 本回合环境维度合计（荣誉 + 薪资 + 差距拉大已乘速度倍数，再加奖金分成项） */
  total: number;
}

/**
 * 人类玩家战队选手的归属感环境（每回合）：(荣誉维度 + 薪资维度 + 差距拉大惩罚) × 在队时长速度倍数。
 * 上回合的薪资差取自 salaryTrack.gap（同一战队时才比较）。
 */
export function loyaltyEnvironment(state: GameState, p: Player, team?: Team | null): LoyaltyEnvironment {
  const t = team ?? (p?.teamId ? state.teams[p.teamId] : undefined);
  if (!p || !t || t.disbanded || !salaryApplies(p)) {
    return { gap: 0, honor: 0, salary: 0, growth: 0, mult: 0, total: 0 };
  }
  const gap = salaryGap(state, p);
  const honor = honorLoyaltyDelta(t.honor, playerTier(p));
  const salary = salaryLoyaltyDelta(gap);
  const track = p.salaryTrack;
  const prev = track && track.gapTeamId === t.id ? track.gap : undefined;
  const growth = gapGrowthDelta(gap, prev);
  const mult = tenureSpeedMult(tenureSeasons(state, p));
  const prize = prizeShareLoyaltyDelta(t.prizeShare);
  const total = (honor + salary + growth) * mult + prize;
  return { gap, honor, salary, growth, mult, prize, total: Number.isFinite(total) ? total : 0 };
}

// ---------------------------------------------------------------------------
// 跟踪记录（每回合由 growth.roundLoyaltyUpdate 调用）
// ---------------------------------------------------------------------------

function trackOf(p: Player): SalaryTrack {
  if (!p.salaryTrack || typeof p.salaryTrack !== 'object') p.salaryTrack = {};
  return p.salaryTrack;
}

/**
 * 更新近期荣誉热度（冠军 / MVP 增量计入、按赛季衰减）与新秀合同标记。所有在队 active 选手每回合一次。
 * 自由选手不打比赛、热度衰减按赛季差惰性计算（playerFame）：只清掉上回合的薪资差，不新建记录（控制存档体积）。
 */
export function updateSalaryTrack(state: GameState, p: Player): void {
  if (!p || p.status !== 'active') return;
  if (!p.teamId) {
    const ft = p.salaryTrack;
    if (ft && typeof ft === 'object') {
      delete ft.gap;
      delete ft.gapTeamId;
    }
    return;
  }
  const fame = playerFame(state, p);
  const t = trackOf(p);
  const st = p.stats;
  t.fame = round3(fame);
  t.ti = seasonTi(state);
  t.titles = num(st?.titles, 0);
  t.tiTitles = num(st?.tiTitles, 0);
  t.mvp = num(st?.mvp, 0);
  if (t.rookieTeamId !== p.teamId && rookieDealWith(p, p.teamId)) {
    t.rookieTeamId = p.teamId;
    t.rookieUntil = num(p.contractUntil, t.ti);
  }
}

/** 记录本回合的薪资差（下回合判断差距是否拉大） */
export function recordSalaryGap(p: Player, gap: number, teamId: string): void {
  const t = trackOf(p);
  t.gap = round3(num(gap, 0));
  t.gapTeamId = teamId;
}

/** 续约后结束新秀合同（之后按预期薪资计算薪资差） */
export function endRookieContract(state: GameState, p: Player): void {
  if (!p?.teamId) return;
  const t = trackOf(p);
  t.rookieTeamId = p.teamId;
  t.rookieUntil = seasonTi(state) - 1;
}

// ---------------------------------------------------------------------------
// 续约要价 / 加薪 / 挖角
// ---------------------------------------------------------------------------

/**
 * 要价的隐藏浮动 ∈ [0, 1)：同一存档、同一选手、同一赛季固定（哈希，不消耗 state.rng，界面预览与实际续约一致），
 * 使界面显示的要价无法反推出精确的预期薪资。
 */
function askJitterRoll(state: GameState, p: Player): number {
  return seededRng(hashSeed(`${state.id ?? ''}|ask|${p.id}|${seasonTi(state)}`)).next();
}

/**
 * 续约要价（≥ 预期薪资）：预期 × (1 + askMarkup + askJitter × 隐藏浮动 + 低归属感溢价)，向上取整
 * （两位有效数字，步长不超过 askRounding：低薪选手不会因取整多要太多）。
 * 低归属感溢价 = askLowLoyaltyPremium × clamp((askPremiumLoyalty − 归属感) / askPremiumLoyalty, 0, 1)。
 */
export function renewalAsk(state: GameState, p: Player): number {
  const R = CONFIG.salary.renew;
  const exp = expectedSalary(state, p, p.teamId);
  const loyalty = effectiveAttr(p, 'loyalty');
  const ref = R.askPremiumLoyalty > 0 ? R.askPremiumLoyalty : 60;
  const premium = Math.max(0, R.askLowLoyaltyPremium) * clamp((ref - loyalty) / ref, 0, 1);
  const jitter = Math.max(0, num(R.askJitter, 0)) * askJitterRoll(state, p);
  const raw = exp * (1 + Math.max(0, R.askMarkup) + jitter + premium);
  if (!(raw > 0) || !Number.isFinite(raw)) return exp;
  const maxStep = R.askRounding > 0 ? R.askRounding : 100;
  const step = clamp(Math.pow(10, Math.floor(Math.log10(raw)) - 1), 1, maxStep);
  return Math.max(exp, Math.ceil(raw / step) * step);
}

/**
 * 人类玩家战队签约 / 求购选手时的工资：max(市场工资, 预期薪资 × (1 + askMarkup + askJitter × 隐藏浮动))。
 * 高荣誉俱乐部要按自己的地位开价（否则新援一加盟就对薪资强烈不满）；荣誉系数 < 1 的小俱乐部按市场工资签约。
 * 浮动按 存档/选手/战队/赛季 固定（界面预览与实际签约一致，且无法反推出精确的预期薪资）；不消耗 state.rng。
 */
export function signingSalary(state: GameState, p: Player, teamId: string): number {
  if (!p) return 0;
  const market = marketWage(state, p);
  const team = ownEntry(state.teams, teamId);
  if (!team || team.disbanded) return market;
  const R = CONFIG.salary.renew;
  const roll = seededRng(hashSeed(`${state.id ?? ''}|sign|${p.id}|${teamId}|${seasonTi(state)}`)).next();
  const raw = expectedSalary(state, p, teamId) * (1 + Math.max(0, R.askMarkup) + Math.max(0, num(R.askJitter, 0)) * roll);
  if (!(raw > market) || !Number.isFinite(raw)) return market;
  const maxStep = R.askRounding > 0 ? R.askRounding : 100;
  const step = clamp(Math.pow(10, Math.floor(Math.log10(raw)) - 1), 1, maxStep);
  return Math.max(market, Math.ceil(raw / step) * step);
}

/**
 * 开局接管真实俱乐部（单机）：正式队员的工资对齐到预期薪资 × U(initialPay.range)（只上调不下调；新秀合同、临时替补除外）。
 * 数据中的工资是普通市场工资，而预期薪资含荣誉 / 明星系数 —— 不对齐的话，接管高荣誉豪门的第一回合全队就对薪资强烈不满。
 * 浮动按 存档/选手 哈希固定，不消耗 state.rng。返回调整的人数。
 */
export function alignInitialSalaries(state: GameState, teamId: string): number {
  const team = ownEntry(state.teams, teamId);
  const cfg = CONFIG.salary.initialPay;
  if (!team || team.disbanded || !cfg?.range) return 0;
  const lo = clamp(num(cfg.range[0], 1), 0.5, 1.5);
  const hi = clamp(num(cfg.range[1], lo), lo, 1.5);
  let n = 0;
  for (const id of team.playerIds ?? []) {
    const p = state.players[id];
    if (!p || p.teamId !== teamId || !salaryApplies(p) || onRookieContract(state, p)) continue;
    const roll = seededRng(hashSeed(`${state.id ?? ''}|initpay|${p.id}`)).next();
    const target = Math.round(expectedSalary(state, p, teamId) * (lo + (hi - lo) * roll));
    if (Number.isFinite(target) && target > num(p.salary, 0)) {
      p.salary = target;
      n++;
    }
  }
  return n;
}

/** 加薪的归属感收益倍数：1 + raiseGapBonus × 被弥补的薪资差（满意的选手为 1） */
export function raiseGapMultiplier(gapBefore: number, gapAfter: number): number {
  const before = Math.max(0, num(gapBefore, 0));
  const after = Math.max(0, num(gapAfter, 0));
  const closed = Math.max(0, before - after);
  return 1 + Math.max(0, CONFIG.salary.raise.gapBonus) * closed;
}

/** AI 报价目标权重的薪资倍数：1 + offerWeightGapMult × max(0, g) */
export function offerGapWeight(gap: number): number {
  return 1 + Math.max(0, CONFIG.salary.poach.offerWeightGapMult) * Math.max(0, num(gap, 0));
}

/** AI 报价（每回合）概率：base × (1 + offerChanceGapMult × 阵中最大 g)，上限 offerChanceMax（不低于 base） */
export function aiOfferChance(base: number, maxGap: number): number {
  const P = CONFIG.salary.poach;
  const b = Math.max(0, num(base, 0));
  const v = b * (1 + Math.max(0, P.offerChanceGapMult) * Math.max(0, num(maxGap, 0)));
  return clamp(v, 0, Math.max(b, P.offerChanceMax));
}

/**
 * 对薪资强烈不满的明星被挖角的概率（归属感尚未跌破离队阈值时）：等级 ≥ unhappyStarMinTier、归属感 < unhappyStarLoyaltyMax、
 * 薪资强烈不满 → unhappyStarPoachChance × g / strongGap（上限 unhappyStarPoachMax）；否则 0。
 */
export function unhappyStarPoachChance(p: Player, loyalty: number, gap: number): number {
  const P = CONFIG.salary.poach;
  const g = num(gap, 0);
  if (g < CONFIG.salary.mood.strongGap) return 0;
  if (num(loyalty, 100) >= P.unhappyStarLoyaltyMax) return 0;
  if (tierIndex(playerTier(p)) < tierIndex(P.unhappyStarMinTier)) return 0;
  const strong = Math.max(1e-6, CONFIG.salary.mood.strongGap);
  return clamp(Math.max(0, P.unhappyStarPoachChance) * (g / strong), 0, Math.max(0, P.unhappyStarPoachMax));
}

// ---------------------------------------------------------------------------
// 定性情绪（UI）
// ---------------------------------------------------------------------------

export interface PlayerMoodSummary {
  salary: SalaryMood;
  salaryLabel: string;
  overall: OverallMood;
  overallLabel: string;
  /** 定性原因（中文，不含数值） */
  notes: string[];
}

/** 选手情绪摘要（只含定性信息，供选手详情 / 阵容页展示） */
export function playerMoodSummary(state: GameState, p: Player): PlayerMoodSummary {
  const team = p?.teamId ? state.teams[p.teamId] : undefined;
  const env = loyaltyEnvironment(state, p, team);
  const salary = salaryMoodOf(env.gap);
  const loyalty = effectiveAttr(p, 'loyalty');
  const O = CONFIG.salary.overall;
  let overall: OverallMood;
  if (loyalty < CONFIG.loyalty.leaveThreshold) overall = 'leaving';
  else if (loyalty < O.waveringBelow || env.total <= O.waveringDrift || salary === 'strong') overall = 'wavering';
  else if (loyalty >= O.contentFrom && env.total > O.contentMinDrift && salary === 'satisfied') overall = 'content';
  else overall = 'steady';

  const notes: string[] = [];
  if (salaryApplies(p)) {
    if (onRookieContract(state, p)) notes.push('新秀合同期内，暂不计较薪资');
    else if (salary === 'strong') notes.push('认为薪水远低于自己的身价');
    else if (salary === 'mild') notes.push('觉得薪水略低于自己的身价');
    else if (env.gap < -CONFIG.salary.loyalty.gapGrace) notes.push('对待遇很满意');
    if (env.growth < 0) notes.push('近期身价上涨，对待遇的期望随之提高');
    if (!onRookieContract(state, p) && recentPrizeEarned(state, p) > 0) notes.push('近期分到的赛事奖金让他对收入更满意');
    if ((env.prize ?? 0) > 0) notes.push('对俱乐部的奖金分成比例很满意');
    else if ((env.prize ?? 0) < 0) notes.push('觉得俱乐部给队员的奖金分成太少');
    if (env.honor < 0) notes.push('觉得俱乐部的荣誉配不上自己');
    else if (env.honor > 0) notes.push('以效力这家俱乐部为荣');
    const seasons = tenureSeasons(state, p);
    if (seasons === 0) notes.push('刚加盟不久，对环境的感受还不强烈');
    else if (seasons >= 2) notes.push('效力多年，对俱乐部环境的感受更加强烈');
    if ((p.benchRounds ?? 0) > CONFIG.loyalty.benchGraceRounds) {
      notes.push(team && rosterSize(state, team.id) > CONFIG.team.maxRoster
        ? '长期坐在替补席上，阵容人数超出常规上限让他更难获得机会'
        : '长期坐在替补席上');
    }
  }
  return {
    salary,
    salaryLabel: SALARY_MOOD_LABEL[salary],
    overall,
    overallLabel: OVERALL_MOOD_LABEL[overall],
    notes,
  };
}
