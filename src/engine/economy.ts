// 经济：工资、账目、费用、奖金压缩、出场费、起始资金【E4 / E1-economy】
import type { FinanceEntry, GameState, Team } from './types';
import { CONFIG, TI_YEAR } from './config';
import { yearOf } from './util';
import { teamRating } from './team';
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
  const team = state.teams[teamId];
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
  const team = state.teams[teamId];
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
  const own = me && state.teams[me] ? teamRating(state, me) : 0;
  const target = state.teams[targetTeamId] ? teamRating(state, targetTeamId) : 0;
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

/** 真实俱乐部起始资金：数据资金 × realClubScale（人类玩家接管时再 × team.realClubFundsMult[难度]） */
export function realClubStartingFunds(seedFunds: number, difficulty?: string | null): number {
  const base = Number.isFinite(seedFunds) ? Math.max(0, seedFunds) : 0;
  const mult = difficulty ? CONFIG.team.realClubFundsMult[difficulty] ?? 1 : 1;
  return fundsRound(base * CONFIG.economy.startingFunds.realClubScale * mult);
}

/** 新俱乐部起始资金：当前阵容每回合工资 × newClubWageRounds[难度] */
export function newClubStartingFunds(state: GameState, teamId: string, difficulty: string): number {
  const rounds = CONFIG.economy.startingFunds.newClubWageRounds[difficulty]
    ?? CONFIG.economy.startingFunds.newClubWageRounds.normal ?? 7;
  return fundsRound(roundWageBill(state, teamId) * rounds);
}

/**
 * 新俱乐部起始资金预估（新游戏向导用，开局前尚无阵容）：按初始阵容等级构成（CONFIG.season.newClubSTierCount/ATierCount，
 * 其余 B 级）的标准工资 × 起始年代经济指数 × newClubWageRounds[难度]。实际值以开局后的真实工资为准（相差通常 < 10%）。
 */
export function estimateNewClubStartingFunds(startTi: number, difficulty: string): number {
  return estimateNewClubStart(startTi, difficulty).funds;
}

/** 新俱乐部初始阵容每回合工资的预估（标准工资 × 起始年代经济指数；开局前尚无阵容） */
function estimateNewClubWage(startTi: number, difficulty: string): number {
  const eco = CONFIG.economy;
  const sCount = CONFIG.season.newClubSTierCount[difficulty] ?? CONFIG.season.newClubSTierCount.normal ?? 1;
  const aCount = CONFIG.season.newClubATierCount[difficulty] ?? CONFIG.season.newClubATierCount.normal ?? 3;
  const bCount = Math.max(0, 5 - sCount - aCount);
  return (sCount * eco.salaryByTier.S + aCount * eco.salaryByTier.A + bCount * eco.salaryByTier.B)
    * econIndex(TI_YEAR[startTi] ?? NaN);
}

/**
 * 新游戏向导用的新俱乐部开局资金预估：起始资金（≈ 难度回合数 × 初始工资）+ 创立礼包（若干次单抽的资金），
 * 与 game.createNewClub 同口径（实际值以开局后的真实工资为准，相差通常 < 10%）。
 */
export function estimateNewClubStart(
  startTi: number,
  difficulty: string,
): { funds: number; grantPulls: number; grantGold: number; total: number; wagePerRound: number } {
  const eco = CONFIG.economy;
  const wage = estimateNewClubWage(startTi, difficulty);
  const rounds = eco.startingFunds.newClubWageRounds[difficulty] ?? eco.startingFunds.newClubWageRounds.normal ?? 7;
  const funds = fundsRound(wage * rounds);
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
