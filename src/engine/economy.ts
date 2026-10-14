// 经济：工资、账目、费用、奖金压缩、出场费、起始资金【E4 / E1-economy】
import type { FinanceEntry, GameState, SeedTeam, Team } from './types';
import { TIERS } from './types';
import { CONFIG, TI_YEAR } from './config';
import { ownEntry, yearOf } from './util';
import { teamRating } from './team';
import { standardSalary } from './player';
import { triggerUnpaidSalary } from './events';
import { applyResultMerchBoosts, payTeamRevenue, roundRevenue } from './revenue';
import { inSeatOf, isHumanTeam, isMultiplayer } from './seat';

/** 账目最多保留条数（防止存档无限膨胀；非玩法数值） */
const FINANCE_LOG_MAX = 3000;

const ECON_YEARS: number[] = Object.keys(CONFIG.economy.econIndexByYear)
  .map(Number)
  .filter((y) => Number.isFinite(y))
  .sort((a, b) => a - b);

/** 年代经济指数（CONFIG.economy.econIndexByYear，超出范围取最近年份） */
export function econIndex(year: number): number {
  const table = CONFIG.economy.econIndexByYear;
  if (!ECON_YEARS.length) return 1;
  if (!Number.isFinite(year)) return table[ECON_YEARS[ECON_YEARS.length - 1]] ?? 1;
  const y = Math.round(year);
  if (table[y] !== undefined) return table[y];
  if (y <= ECON_YEARS[0]) return table[ECON_YEARS[0]];
  if (y >= ECON_YEARS[ECON_YEARS.length - 1]) return table[ECON_YEARS[ECON_YEARS.length - 1]];
  // 表中缺失的中间年份：取最近年份（距离相同取较早年份）
  let best = ECON_YEARS[0];
  for (const k of ECON_YEARS) if (Math.abs(k - y) < Math.abs(best - y)) best = k;
  return table[best];
}

/** 当前赛季经济指数 */
export function econ(state: GameState): number {
  const year = state.season?.year ?? (state.currentDate ? yearOf(state.currentDate) : NaN);
  return econIndex(year);
}

/**
 * 改变战队金币；人类玩家战队（isPlayer）同时写入 state.finance（AI 只改金币）。
 * opts.keepZero：金额为 0 时仍记一条账目（如奖金全部分给队员时的「奖金 X（俱乐部 0 / 队员 X）」，第九波）。
 */
export function addFinance(
  state: GameState,
  teamId: string,
  amount: number,
  category: FinanceEntry['category'],
  note: string,
  opts?: { keepZero?: boolean },
): void {
  const team = ownEntry(state.teams, teamId);
  if (!team || !Number.isFinite(amount)) return;
  const value = Math.round(amount);
  if (value === 0 && !opts?.keepZero) return;
  team.gold = Math.round((Number.isFinite(team.gold) ? team.gold : 0) + value);
  if (!team.isPlayer) return;
  // 多人模式：账目写入该战队所属座位（可能不是当前上下文）
  inSeatOf(state, teamId, () => {
    if (!Array.isArray(state.finance)) state.finance = [];
    state.finance.push({
      season: state.season?.ti ?? 0,
      round: state.roundIndex,
      amount: value,
      category,
      note,
    });
    if (state.finance.length > FINANCE_LOG_MAX) state.finance.splice(0, state.finance.length - FINANCE_LOG_MAX);
  });
}

/** 选手工资合计（含临时替补，不含禁赛/退役） */
function playerWages(state: GameState, team: Team): number {
  let total = 0;
  for (const id of team.playerIds) {
    const p = state.players[id];
    if (!p || p.status !== 'active') continue;
    total += Math.max(0, Number.isFinite(p.salary) ? p.salary : 0);
  }
  return Math.round(total);
}

function coachWage(state: GameState, team: Team): number {
  if (!team.coachId) return 0;
  const c = state.coaches[team.coachId];
  return c && Number.isFinite(c.salary) ? Math.max(0, Math.round(c.salary)) : 0;
}

/**
 * AI 战队每大回合经常性收入（赞助 + 直播与内容 + 周边，revenue.roundRevenue）；人类玩家战队返回 0。
 * 兼容旧接口（原 CONFIG.ai.commercialIncome 已由 revenue.ts 取代）。
 */
export function aiCommercialIncome(state: GameState, team: Team): number {
  if (!team || team.isPlayer) return 0;
  return roundRevenue(state, team).total;
}

/** 人类玩家战队每大回合经常性收入（赞助 + 直播与内容 + 周边，含难度倍数）。兼容旧接口 */
export function playerCommercialIncome(state: GameState, team?: Team | null): number {
  const t = team ?? state.teams[state.settings?.playerTeamId];
  if (!t || t.disbanded) return 0;
  return roundRevenue(state, t).total;
}

/**
 * 每大回合结束：先结算本回合赛事的周边热度加成（revenue.applyResultMerchBoosts），
 * 再对每支战队计入经常性收入（赞助 / 直播与内容 / 周边，revenue.payTeamRevenue；人机共用），最后支付工资。
 * 人类玩家战队（isPlayer）资金不足 → 仍扣（可为负）并调用 events.triggerUnpaidSalary（对当前座位）；
 * AI 战队若 gold < 0，下一转会窗口抛售/降薪（由 ai.ts 处理）。
 * 返回 settings.playerTeamId 战队本次支出与是否足额支付。
 */
export function payRoundSalaries(state: GameState): { total: number; paidInFull: boolean } {
  let result = { total: 0, paidInFull: true };
  const playerTeamId = state.settings?.playerTeamId;
  applyResultMerchBoosts(state);
  for (const team of Object.values(state.teams)) {
    if (team.disbanded) continue;
    const human = team.isPlayer || team.id === playerTeamId;
    if (human && state.gameOver) continue;
    if (!Number.isFinite(team.gold)) team.gold = 0;
    payTeamRevenue(state, team);
    const wages = playerWages(state, team);
    const coach = coachWage(state, team);
    const total = wages + coach;
    if (human) {
      const paidInFull = team.gold >= total;
      if (wages > 0) addFinance(state, team.id, -wages, 'salary', `第${state.roundIndex}回合 选手工资`);
      if (coach > 0) addFinance(state, team.id, -coach, 'coach_salary', `第${state.roundIndex}回合 教练工资`);
      if (team.id === playerTeamId) {
        result = { total, paidInFull };
        if (!paidInFull && total > 0) triggerUnpaidSalary(state);
      } else if (isMultiplayer(state) && isHumanTeam(state, team.id) && !paidInFull && total > 0) {
        // 多人模式：其他座位的欠薪在其座位上下文中处理
        inSeatOf(state, team.id, () => triggerUnpaidSalary(state));
      }
    } else {
      team.gold = Math.round(team.gold - total);
      aiReinvestSurplus(team, total);
    }
  }
  return result;
}

/** AI 盈余再投入：资金超出 工资 × reserveRounds 的部分按 rate 比例离开联赛经济（CONFIG.ai.surplusReinvest） */
function aiReinvestSurplus(team: Team, wagePerRound: number): void {
  const c = CONFIG.ai.surplusReinvest;
  if (!c || !(c.rate > 0) || team.isPlayer) return;
  const reserve = Math.max(0, wagePerRound) * Math.max(0, c.reserveRounds);
  const excess = team.gold - reserve;
  if (excess > 0) team.gold = Math.round(team.gold - excess * Math.min(1, c.rate));
}

/** 每回合工资总支出（选手 + 教练；UI 显示 / 预估） */
export function roundWageBill(state: GameState, teamId: string): number {
  const team = ownEntry(state.teams, teamId);
  if (!team) return 0;
  return playerWages(state, team) + coachWage(state, team);
}

/** 下一次额外训练价格：本回合内逐次加价、本赛季缓慢上涨（见 extraTrainingCostAt / CONFIG.training） */
export function extraTrainingCost(state: GameState): number {
  return extraTrainingCostAt(state, state.extraTrainingBoughtThisRound ?? 0, state.season?.extraTrainingsBought ?? 0);
}

/**
 * 指定购买序号的额外训练价格：extraBaseCost × extraCostGrowth^本回合已购 × min(seasonMaxMult, 1 + seasonStep × 本赛季已购) × econ。
 * roundBought / seasonBought = 这次购买之前本回合 / 本赛季已购的次数（trainingLog 复算历史购买价时使用）。
 */
export function extraTrainingCostAt(state: GameState, roundBought: number, seasonBought: number): number {
  const t = CONFIG.training;
  const k = Math.max(0, Number.isFinite(roundBought) ? Math.floor(roundBought) : 0);
  const n = Math.max(0, Number.isFinite(seasonBought) ? Math.floor(seasonBought) : 0);
  const seasonMult = Math.min(Math.max(1, t.extraSeasonMaxMult), 1 + Math.max(0, t.extraSeasonStep) * n);
  return Math.round(t.extraBaseCost * Math.pow(t.extraCostGrowth, k) * seasonMult * econ(state));
}

/** 训练赛费用：(scrimBaseCost + max(0, 目标评分/本队评分 - scrimCostRatioFloor) × scrimCostPerStrengthRatio) × econ */
export function scrimCost(state: GameState, targetTeamId: string): number {
  const t = CONFIG.training;
  const me = state.settings?.playerTeamId;
  const own = me && ownEntry(state.teams, me) ? teamRating(state, me) : 0;
  const target = ownEntry(state.teams, targetTeamId) ? teamRating(state, targetTeamId) : 0;
  const ratio = own > 0 ? target / own : 1;
  const extra = Math.max(0, ratio - t.scrimCostRatioFloor) * t.scrimCostPerStrengthRatio;
  return Math.round((t.scrimBaseCost + extra) * econ(state));
}

// ===========================================================================
// 奖金压缩 / 出场费：实现在 revenue.ts（俱乐部收入模块；tournament.ts 直接从 revenue 引用，
// 以免依赖 economy 的单测替身缺少这些导出），此处转出供 UI / 其他模块按「经济」口径使用
// ===========================================================================
export { awardedPrizePool, awardedPrize, payoutShare, qualifierAppearanceFee, tournamentAppearanceFee } from './revenue';

function roundTo(v: number, unit: number): number {
  if (!Number.isFinite(v)) return 0;
  const u = unit > 0 ? unit : 1;
  return Math.round(v / u) * u;
}

// ===========================================================================
// 起始资金
// ===========================================================================

function fundsRound(v: number): number {
  return Math.max(0, roundTo(v, CONFIG.economy.startingFunds.rounding));
}

/**
 * 起始资金的年代系数 = econIndex(该届年份) / econIndex(TI1 年份)：锚定额按 TI1 给出，其他起始届按经济指数折算，
 * 各年代起步的购买力（相对工资 / 签约费 / 转会费）相同（TI9 ×4、TI13 ×2.4）
 */
export function eraFundsFactor(ti: number): number {
  const base = econIndex(yearOfTi(1));
  const now = econIndex(yearOfTi(ti));
  return base > 0 && Number.isFinite(now) ? now / base : 1;
}

/**
 * TI 序号 → 年份（TI_YEAR；表外同 calendar.tiYear 的推演：TI1..9 = 2010 + ti，TI10 起 = 2011 + ti）。
 * 非法序号（NaN / undefined）按 TI1 处理：econIndex(NaN) 会取最新年份，否则缺失的起始届会静默得到最高年代的资金
 */
function yearOfTi(ti: number): number {
  const t = Math.round(ti);
  if (!Number.isFinite(t)) return TI_YEAR[1] ?? 2011;
  return TI_YEAR[t] ?? (t < 10 ? 2010 + t : 2011 + t);
}

/**
 * 新俱乐部起始资金（纯函数，【用户指定】锚定额）：newClubTi1Funds（TI1 普通难度 20 万）× 年代系数 × newClubDifficultyMult[难度]，
 * 任何难度都不低于锚定额 × 年代系数。game.createNewClub、multi（各自组建 / 选择已有战队）与新游戏向导、多人房间预览共用
 */
export function newClubStartingFunds(startTi: number, difficulty: string): number {
  const sf = CONFIG.economy.startingFunds;
  const anchor = Math.max(0, sf.newClubTi1Funds) * eraFundsFactor(startTi);
  const mult = Math.max(1, sf.newClubDifficultyMult[difficulty] ?? sf.newClubDifficultyMult.normal ?? 1);
  return fundsRound(anchor * mult);
}

/** 真实俱乐部的相对财力：数据资金 / (realClubTopDataFunds × econIndex(该届年份))，夹在 [0, 1] */
export function realClubWealth(seedFunds: number, ti: number): number {
  const sf = CONFIG.economy.startingFunds;
  const ref = Math.max(0, sf.realClubTopDataFunds) * econIndex(yearOfTi(ti));
  if (!(ref > 0) || !Number.isFinite(seedFunds) || seedFunds <= 0) return 0;
  return Math.min(1, seedFunds / ref);
}

/**
 * 真实俱乐部起始资金：max(realClubTopTi1Funds × 年代系数 × min(1, 相对财力 / realClubFullWealth), 每回合工资 × realClubMinWageRounds)，
 * 人类玩家接管时再 × team.realClubFundsMult[难度]（difficulty 为空 = AI 战队，不乘）。
 * 即锚定额是封顶额：最强真实俱乐部（相对财力 1）TI1 普通难度 = 10 万（【用户指定】）；相对财力 ≥ realClubFullWealth（1/2）的同样拿满，
 * 以下按比例（= 原口径「数据资金 × 0.2」，没有超过锚定额的俱乐部资金不变）。wagePerRound 缺省 / 非法时不设下限。
 */
export function realClubStartingFunds(seedFunds: number, difficulty: string | null | undefined, ti: number, wagePerRound?: number): number {
  const sf = CONFIG.economy.startingFunds;
  const wealth = realClubWealth(seedFunds, ti);
  const full = Number.isFinite(sf.realClubFullWealth) && sf.realClubFullWealth > 0 ? Math.min(1, sf.realClubFullWealth) : 1;
  const base = Math.max(0, sf.realClubTopTi1Funds) * eraFundsFactor(ti) * Math.min(1, wealth / full);
  const wage = wagePerRound !== undefined && Number.isFinite(wagePerRound) ? Math.max(0, wagePerRound) : 0;
  const floor = wage * Math.max(0, sf.realClubMinWageRounds);
  const mult = difficulty ? CONFIG.team.realClubFundsMult[difficulty] ?? 1 : 1;
  return fundsRound(Math.max(base, floor) * mult);
}

/**
 * 阵容数据（SeedTeam）的每回合工资（纯函数）：首发 + 替补按标准工资（player.standardSalary，与 generation.playerFromSeed 同口径）
 * + 主教练（coach.salaryByTier × 经济指数，与 generation.coachFromSeed 同口径），年代按该届年份。
 * 开局前（新游戏向导）即可算出，与开局后 AI 战队的实际工资一致（同一选手在多支战队重复出现时以开局为准，属罕见数据问题）
 */
export function seedTeamWageBill(seed: SeedTeam, ti: number): number {
  const econ = econIndex(yearOfTi(ti));
  const lad = CONFIG.ladder;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  let total = 0;
  const seen = new Set<string>();
  for (const sp of seed?.players ?? []) {
    if (!sp || seen.has(sp.id)) continue;
    seen.add(sp.id);
    const mmr = Math.round(Math.min(lad.maxMmr, Math.max(lad.minMmr, num(sp.mmr, lad.thresholds.A))));
    const power = Math.max(1, num(sp.power, 60));
    total += standardSalary(mmr, power, econ);
  }
  if (seed?.coach) {
    const tier = TIERS.includes(seed.coach.tier) ? seed.coach.tier : 'A';
    total += Math.max(CONFIG.economy.minSalary, Math.round((CONFIG.coach.salaryByTier[tier] ?? 0) * econ));
  }
  return Math.round(total);
}

/**
 * 某支真实俱乐部（阵容数据）在起始届 ti 的开局资金：realClubStartingFunds(数据资金, 难度, ti, seedTeamWageBill)。
 * game.createNewGame / multi.createMultiplayerGame 与新游戏向导的战队卡片共用（预览 = 实际）
 */
export function seedTeamStartingFunds(seed: SeedTeam, ti: number, difficulty: string | null | undefined): number {
  return realClubStartingFunds(num0(seed?.funds), difficulty, ti, seedTeamWageBill(seed, ti));
}

function num0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 新俱乐部起始资金预估（兼容旧接口）：= newClubStartingFunds（锚定额与阵容无关，预估即实际） */
export function estimateNewClubStartingFunds(startTi: number, difficulty: string): number {
  return estimateNewClubStart(startTi, difficulty).funds;
}

/**
 * 新俱乐部初始 5 人每回合工资的预估（开局前尚无阵容，仅用于「约 N 回合工资」的说明）：各等级按该等级战力区间中点的标准工资
 * （player.standardSalary 同口径：salaryByTier × 战力系数 × 起始年代经济指数）。实际阵容的战力随机，另有赛季初选秀的新秀，故只是约数
 */
function estimateNewClubWage(startTi: number, difficulty: string): number {
  const eco = CONFIG.economy;
  const sCount = CONFIG.season.newClubSTierCount[difficulty] ?? CONFIG.season.newClubSTierCount.normal ?? 1;
  const aCount = CONFIG.season.newClubATierCount[difficulty] ?? CONFIG.season.newClubATierCount.normal ?? 3;
  const bCount = Math.max(0, 5 - sCount - aCount);
  const econ = econIndex(yearOfTi(startTi));
  const one = (tier: 'S' | 'A' | 'B'): number => {
    const [lo, hi] = CONFIG.generation.powerByTier[tier] ?? [70, 70];
    const powerFactor = Math.max(0, 1 + ((lo + hi) / 2 - 70) * eco.salaryPowerFactor);
    return Math.max(eco.minSalary, Math.round(eco.salaryByTier[tier] * powerFactor * econ));
  };
  return sCount * one('S') + aCount * one('A') + bCount * one('B');
}

/**
 * 新游戏向导 / 多人房间用的新俱乐部开局资金：funds = newClubStartingFunds（与 game.createNewClub 完全相同）+ 创立礼包（第八波起关闭，恒为 0）；
 * wagePerRound = 初始 5 人每回合工资的预估（标准工资，实际以开局阵容为准），用于「约 N 回合工资」的说明。
 */
export function estimateNewClubStart(
  startTi: number,
  difficulty: string,
): { funds: number; grantPulls: number; grantGold: number; total: number; wagePerRound: number } {
  const wage = estimateNewClubWage(startTi, difficulty);
  const funds = newClubStartingFunds(startTi, difficulty);
  const grant = newClubGachaGrant(Math.max(0, CONFIG.team.maxRoster - 5), wage);
  return { funds, grantPulls: grant.pulls, grantGold: grant.gold, total: funds + grant.gold, wagePerRound: Math.round(wage) };
}

/**
 * 新俱乐部创立礼包（金币）：若干次单抽的价格。次数 = min(newClubGachaGrantPulls, 阵容空位,
 * max(1, ⌊newClubGachaGrantMaxWageRounds × 每回合工资 / 单抽价格⌋))；roomLeft / wagePerRound 缺省视为不受限。
 * 抽卡价格为用户指定的固定值，早期年代工资低，礼包按工资收缩，避免礼包价值超过起始资金本身。
 */
export function newClubGachaGrant(roomLeft?: number, wagePerRound?: number): { pulls: number; gold: number } {
  if (!CONFIG.season.newClubGachaGrant) return { pulls: 0, gold: 0 };
  const sf = CONFIG.economy.startingFunds;
  let pulls = Math.max(0, Math.floor(sf.newClubGachaGrantPulls));
  const single = CONFIG.gacha.singleCost;
  const maxRounds = Number(sf.newClubGachaGrantMaxWageRounds);
  if (pulls > 0 && wagePerRound !== undefined && Number.isFinite(wagePerRound) && wagePerRound > 0
    && Number.isFinite(maxRounds) && maxRounds > 0 && single > 0) {
    pulls = Math.min(pulls, Math.max(1, Math.floor((maxRounds * wagePerRound) / single)));
  }
  if (roomLeft !== undefined) pulls = Math.max(0, Math.min(pulls, Number.isFinite(roomLeft) ? Math.floor(roomLeft) : 0));
  return { pulls, gold: pulls * single };
}
