// 俱乐部收入【E1-economy】：奖金压缩、出场费、经常性收入（赞助 / 直播与内容 / 周边）
//
// - 奖金：赛事显示真实奖金池（美元），实际发放「游戏内奖金池」（按年代与等级压缩，见 awardedPrizePool）。
// - 经常性收入：每大回合结束时结算（economy.payRoundSalaries 先收入后付工资），人类与 AI 战队共用同一套公式；
//   人类玩家战队整体 × CONFIG.economy.revenue.difficultyMult[难度]。按来源分别记账（FinanceEntry 'sponsor' / 'streaming' / 'merch'）。
// - 状态全部存放在各战队自己的 Team.revenue 上（赞助合同、周边热度），与座位上下文无关，多人模式下每支人类战队互不干扰。
import type { GameState, MerchBoost, SponsorContract, Team, Tournament, TournamentTier } from './types';
import { CONFIG, TI_YEAR, TOURNAMENT_TIER_LABEL } from './config';
import { addFinance, econ, econIndex, roundWageBill } from './economy';
import { playerTier } from './player';
import { hashSeed, seededRng } from './rng';
import { addNews } from './news';
import { formatGold, formatRank } from './util';

/** 线上公开赛（schedule.ts 补位赛事）的系列前缀；与 schedule.FILLER_SERIES_PREFIX 一致（不 import schedule 以免循环依赖） */
const FILLER_SERIES_PREFIX = 'online-open-';

type PrizeTournament = Pick<Tournament, 'prizePool' | 'tier' | 'season' | 'seriesId'>;

function roundTo(v: number, unit: number): number {
  if (!Number.isFinite(v)) return 0;
  const u = unit > 0 ? unit : 1;
  return Math.round(v / u) * u;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function finite(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

// ===========================================================================
// 奖金压缩 / 出场费
// ===========================================================================

/** 是否为线上公开赛（补位赛事，无真实奖池） */
function isFiller(t: Pick<Tournament, 'seriesId'>): boolean {
  return typeof t?.seriesId === 'string' && t.seriesId.startsWith(FILLER_SERIES_PREFIX);
}

/** 赛事所属赛季的经济指数（同一赛季的工资与奖金使用同一尺度） */
function tournamentEcon(state: GameState, t: Pick<Tournament, 'season'>): number {
  const year = TI_YEAR[t.season] ?? state.season?.year ?? NaN;
  return econIndex(year);
}

/** 参与「赛季奖金预算」的赛事：同赛季、非 TI、非公开赛、有真实奖池 */
function budgetEvents(state: GameState, season: number): Tournament[] {
  const out: Tournament[] = [];
  for (const x of Object.values(state.tournaments ?? {})) {
    if (!x || x.season !== season || x.tier === 'ti' || isFiller(x)) continue;
    if (Number.isFinite(x.prizePool) && x.prizePool > 0) out.push(x);
  }
  return out;
}

function median(xs: number[]): number {
  const a = xs.slice().sort((p, q) => p - q);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 非 TI 赛事的相对权重（econ=1 的金币）：anchorPool[等级] × clamp((真实奖池 / 同等级中位数)^alpha, multRange) */
function rawWeight(t: PrizeTournament, tierMedian: number | undefined): number {
  const cfg = CONFIG.economy.prize;
  const anchor = cfg.anchorPool[t.tier] ?? 0;
  if (!(anchor > 0) || !(t.prizePool > 0)) return 0;
  const ref = tierMedian && tierMedian > 0 ? tierMedian : t.prizePool;
  const mult = clampNum(Math.pow(t.prizePool / ref, cfg.alpha), cfg.multRange[0], cfg.multRange[1]);
  return anchor * (Number.isFinite(mult) ? mult : 1);
}

/**
 * 赛季奖金系数：k = clamp(seasonBudget / Σ 本赛季非 TI 赛事权重, seasonScaleRange)。
 * 真实赛程每赛季的赛事数量差异很大（如 2017-18 赛季 10 项 Major），按赛季总预算归一，联赛整体奖金规模稳定。
 * 返回各等级中位数与系数（供 awardedPrizePool 复用）。
 */
function seasonPrizeContext(state: GameState, season: number): { medians: Partial<Record<TournamentTier, number>>; scale: number } {
  const cfg = CONFIG.economy.prize;
  const events = budgetEvents(state, season);
  const byTier: Partial<Record<TournamentTier, number[]>> = {};
  for (const x of events) (byTier[x.tier] ??= []).push(x.prizePool);
  const medians: Partial<Record<TournamentTier, number>> = {};
  for (const [tier, pools] of Object.entries(byTier) as [TournamentTier, number[]][]) if (pools.length) medians[tier] = median(pools);
  let total = 0;
  for (const x of events) total += rawWeight(x, medians[x.tier]);
  const scale = total > 0 ? clampNum(cfg.seasonBudget / total, cfg.seasonScaleRange[0], cfg.seasonScaleRange[1]) : 1;
  return { medians, scale: Number.isFinite(scale) ? scale : 1 };
}

/**
 * 实际发放的游戏内奖金池（金币）。赛事仍显示真实奖金池（t.prizePool，美元），发放按年代与等级压缩：
 *   TI：anchorPool.ti × econ × clamp((真实奖池 / tiRefPool)^tiAlpha, tiMultRange)
 *   其他：anchorPool[等级] × clamp((真实奖池 / 同赛季同等级真实奖池中位数)^alpha, multRange) × 赛季系数 × econ
 *         赛季系数 = clamp(seasonBudget / 本赛季非 TI 赛事权重之和, seasonScaleRange)
 *   线上公开赛：anchorPool.minor × fillerCupShare × 赛季系数 × econ（始终低于同赛季的典型 Minor）
 * 真实奖池为 0（TI 赛区预选等）→ 0。econ = 赛事所属赛季年份的经济指数。
 */
export function awardedPrizePool(state: GameState, t: PrizeTournament): number {
  if (!t || !Number.isFinite(t.prizePool) || !(t.prizePool > 0)) return 0;
  const cfg = CONFIG.economy.prize;
  const e = tournamentEcon(state, t);
  if (isFiller(t)) {
    const share = clampNum(finite(cfg.fillerCupShare), 0, 1);
    return roundTo((cfg.anchorPool.minor ?? 0) * share * seasonPrizeContext(state, t.season).scale * e, cfg.rounding);
  }
  if (t.tier === 'ti') {
    const mult = clampNum(Math.pow(t.prizePool / Math.max(1, cfg.tiRefPool), cfg.tiAlpha), cfg.tiMultRange[0], cfg.tiMultRange[1]);
    return roundTo(cfg.anchorPool.ti * e * (Number.isFinite(mult) ? mult : 1), cfg.rounding);
  }
  const ctx = seasonPrizeContext(state, t.season);
  return roundTo(rawWeight(t, ctx.medians[t.tier]) * ctx.scale * e, cfg.rounding);
}

/**
 * 新闻 / 界面用的奖金池文本：游戏内实际发放额（真实奖池按年代与等级压缩换算），附真实奖池美元数。
 * 例：「45.0万（真实奖池 $3,000,000）」；真实奖池为 0 时只给游戏内金额。
 */
export function prizePoolLabel(state: GameState, t: PrizeTournament): string {
  const awarded = awardedPrizePool(state, t);
  const real = Math.round(finite(t?.prizePool));
  return real > 0 ? `${formatGold(awarded)}（真实奖池 $${real.toLocaleString('en-US')}）` : formatGold(awarded);
}

/** 名次 → 基础比例表（CONFIG.tournament.prizeShare：取 key ≥ teams 的最小表，截取前 teams 项并归一化；与 tournament.ts 一致） */
function baseShareTable(teams: number): number[] {
  const table = CONFIG.tournament.prizeShare;
  if (teams <= 0) return [];
  const keys = Object.keys(table).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (keys.length === 0) return new Array(teams).fill(1 / teams);
  const key = keys.find((k) => k >= teams) ?? keys[keys.length - 1];
  const raw = (table[key] ?? []).slice(0, teams);
  while (raw.length < teams) raw.push(0);
  const total = raw.reduce((a, b) => a + b, 0);
  return total > 0 ? raw.map((v) => v / total) : new Array(teams).fill(1 / teams);
}

/**
 * 实际发放的名次比例（区间内平分）：基础比例表向平均分配混合 CONFIG.economy.prize.flatten[等级]，正赛全部名次都有奖金，
 * 全部名次之和 = 1；超出正赛队伍数的名次为 0。（巡回赛积分仍按 CONFIG.tournament.prizeShare 原表计算）
 */
export function payoutShare(teams: number, rankFrom: number, rankTo: number, tier: TournamentTier = 'major'): number {
  const n = Math.floor(teams);
  if (!(n > 0) || !Number.isFinite(rankFrom) || !Number.isFinite(rankTo)) return 0;
  const from = Math.max(1, Math.floor(rankFrom));
  if (from > n) return 0;
  const to = Math.min(n, Math.max(from, Math.floor(rankTo)));
  const f = clampNum(finite(CONFIG.economy.prize.flatten[tier]), 0, 1);
  const base = baseShareTable(n);
  let s = 0;
  for (let r = from; r <= to; r++) s += (1 - f) * (base[r - 1] ?? 0) + f / n;
  return s / (to - from + 1);
}

/** 名次区间实际发放的奖金（金币）：awardedPrizePool × payoutShare(正赛队伍数, 名次区间) */
export function awardedPrize(state: GameState, t: PrizeTournament, mainSize: number, rankFrom: number, rankTo: number): number {
  const pool = awardedPrizePool(state, t);
  if (!(pool > 0)) return 0;
  return Math.max(0, Math.round(pool * payoutShare(mainSize, rankFrom, rankTo, t.tier)));
}

/** 出场费（每支正赛队伍，金币）：appearanceByTier[等级] × econ；线上公开赛 fillerCupAppearance × econ；无奖金赛事为 0 */
export function tournamentAppearanceFee(state: GameState, t: PrizeTournament): number {
  if (!t || !Number.isFinite(t.prizePool) || !(t.prizePool > 0)) return 0;
  const cfg = CONFIG.economy;
  const e = tournamentEcon(state, t);
  const base = isFiller(t) ? cfg.fillerCupAppearance : cfg.appearanceByTier[t.tier] ?? 0;
  return roundTo(Math.max(0, base) * e, cfg.prize.rounding);
}

/** 封闭预选赛出局者的参赛补贴（金币）：出场费 × qualifierAppearanceShare（TI 赛区预选等无奖金赛事为 0） */
export function qualifierAppearanceFee(state: GameState, t: PrizeTournament): number {
  const share = clampNum(finite(CONFIG.economy.qualifierAppearanceShare), 0, 1);
  return roundTo(tournamentAppearanceFee(state, t) * share, CONFIG.economy.prize.rounding);
}

// ===========================================================================
// 经常性收入：赞助 / 直播与内容 / 周边
// ===========================================================================

export interface RoundRevenue {
  sponsor: number;
  streaming: number;
  merch: number;
  /** merch 中来自夺冠热度加成的部分 */
  merchBoost: number;
  total: number;
}

/** 人类玩家战队的难度倍数（AI = 1） */
function difficultyMult(state: GameState, team: Team): number {
  if (!team.isPlayer) return 1;
  const m = CONFIG.economy.revenue.difficultyMult[state.settings?.difficulty ?? 'normal'];
  return Number.isFinite(m) ? Math.max(0, m) : 1;
}

function honorOf(team: Team): number {
  return Math.max(0, finite(team.honor));
}

function ensureRevenue(team: Team): NonNullable<Team['revenue']> {
  if (!team.revenue || typeof team.revenue !== 'object') team.revenue = {};
  return team.revenue;
}

/** 赞助合同档次（按 econ=1 的每回合金额） */
function sponsorLevel(perRoundAtEcon1: number): string {
  const levels = CONFIG.economy.revenue.sponsor.levels;
  for (const [min, label] of levels) if (perRoundAtEcon1 >= min) return label;
  return levels[levels.length - 1]?.[1] ?? '赞助';
}

/** 上赛季排名奖励（每回合，econ=1） */
function rankBonus(rank: number | undefined): number {
  if (!rank || !Number.isFinite(rank) || rank < 1) return 0;
  for (const [maxRank, bonus] of CONFIG.economy.revenue.sponsor.rankBonus) if (rank <= maxRank) return bonus;
  return 0;
}

/**
 * 当前条件下的赞助报价（不写入状态）：
 * (base + perHonor × min(荣誉, honorCap) + 排名奖励) × (1 ± noise) × econ × 难度倍数。
 * 浮动由 seededRng(战队 id + 赛季) 决定：同一赛季重复询价结果一致。
 */
export function sponsorQuote(state: GameState, team: Team): SponsorContract {
  const c = CONFIG.economy.revenue.sponsor;
  const ti = state.season?.ti ?? 0;
  const raw = c.base + c.perHonor * Math.min(honorOf(team), c.honorCap) + rankBonus(team.lastSeasonRank);
  const noise = (seededRng(hashSeed(`sponsor|${team.id}|${ti}`)).next() * 2 - 1) * Math.max(0, c.noise);
  const atEcon1 = Math.max(0, raw * (1 + noise));
  return {
    season: ti,
    perRound: Math.max(0, Math.round(atEcon1 * econ(state) * difficultyMult(state, team))),
    level: sponsorLevel(atEcon1),
  };
}

/** 本赛季赞助合同：已签约返回合同；尚未签约（赛季初）返回报价（不写入状态） */
export function sponsorContract(state: GameState, team: Team): SponsorContract & { signed: boolean } {
  const cur = team.revenue?.sponsor;
  if (cur && cur.season === (state.season?.ti ?? 0) && Number.isFinite(cur.perRound)) return { ...cur, signed: true };
  return { ...sponsorQuote(state, team), signed: false };
}

/** 签订（或沿用）本赛季赞助合同：赛季内首次结算收入时调用；人类玩家战队发一条财务新闻 */
export function ensureSponsorContract(state: GameState, team: Team): SponsorContract {
  const ti = state.season?.ti ?? 0;
  const rev = ensureRevenue(team);
  if (rev.sponsor && rev.sponsor.season === ti && Number.isFinite(rev.sponsor.perRound)) return rev.sponsor;
  const prev = rev.sponsor;
  const next = sponsorQuote(state, team);
  rev.sponsor = next;
  if (team.isPlayer) {
    const rank = team.lastSeasonRank ? `上赛季排名第 ${team.lastSeasonRank}、` : '';
    const change = prev && prev.perRound > 0
      ? `（上赛季每回合 ${formatGold(prev.perRound)}，${next.perRound >= prev.perRound ? '上调' : '下调'} ${Math.abs(Math.round((next.perRound / prev.perRound - 1) * 100))}%）`
      : '';
    addNews(
      state, 'finance', `赞助合同签订：${next.level}`,
      `依据俱乐部荣誉（${Math.round(honorOf(team))}）与${rank}市场关注度，${team.name} 本赛季的赞助合同为每回合 ${formatGold(next.perRound)}${change}，`
        + '赛季内按回合支付，下赛季重新谈判。',
      false, { teamIds: [team.id], noInfer: true },
    );
  }
  return next;
}

/** 直播与内容收入（每回合）：Σ 签约选手 byTier[等级]（非首发 × benchFactor）× (1 + min(honorMaxBonus, 荣誉/honorDiv)) × econ */
export function streamingIncome(state: GameState, team: Team): number {
  const c = CONFIG.economy.revenue.streaming;
  const starters = new Set(Object.values(team.lineup ?? {}).filter((x): x is string => !!x));
  let star = 0;
  for (const id of team.playerIds ?? []) {
    const p = state.players[id];
    if (!p || p.status !== 'active' || p.teamId !== team.id || p.tempSubUntilTournament || p.isWildSub) continue;
    const v = finite(c.byTier[playerTier(p)]);
    star += starters.has(id) ? v : v * c.benchFactor;
  }
  const honorBonus = Math.min(c.honorMaxBonus, honorOf(team) / Math.max(1, c.honorDiv));
  return Math.max(0, Math.round(star * (1 + honorBonus) * econ(state) * difficultyMult(state, team)));
}

/** 周边基础收入（每回合）：(base + perHonor × min(荣誉, honorCap)) × econ */
function merchBase(state: GameState, team: Team): number {
  const c = CONFIG.economy.revenue.merch;
  return Math.max(0, Math.round((c.base + c.perHonor * Math.min(honorOf(team), c.honorCap)) * econ(state) * difficultyMult(state, team)));
}

/** 生效中的周边热度加成 */
export function activeMerchBoosts(team: Team): MerchBoost[] {
  const list = team.revenue?.merchBoosts;
  if (!Array.isArray(list)) return [];
  return list.filter((b) => b && b.roundsLeft > 0 && Number.isFinite(b.perRound) && b.perRound > 0);
}

/** 本回合（若现在结算）各来源经常性收入预估；赞助未签约时按报价计 */
export function roundRevenue(state: GameState, team: Team): RoundRevenue {
  if (!team || team.disbanded) return { sponsor: 0, streaming: 0, merch: 0, merchBoost: 0, total: 0 };
  const sponsor = sponsorContract(state, team).perRound;
  const streaming = streamingIncome(state, team);
  const merchBoost = activeMerchBoosts(team).reduce((a, b) => a + Math.round(b.perRound), 0);
  const merch = merchBase(state, team) + merchBoost;
  return { sponsor, streaming, merch, merchBoost, total: sponsor + streaming + merch };
}

/**
 * 结算一支战队本回合的经常性收入（economy.payRoundSalaries 调用，付工资之前）：签订/沿用赞助合同 → 入账三项收入 →
 * 周边热度加成剩余回合 −1。人类玩家战队按来源写入账目；AI 只改金币。返回本回合实收。
 */
export function payTeamRevenue(state: GameState, team: Team): RoundRevenue {
  if (!team || team.disbanded) return { sponsor: 0, streaming: 0, merch: 0, merchBoost: 0, total: 0 };
  ensureSponsorContract(state, team);
  const r = roundRevenue(state, team);
  const tag = `第${state.roundIndex}回合`;
  const level = team.revenue?.sponsor?.level ?? '赞助';
  if (r.sponsor > 0) addFinance(state, team.id, r.sponsor, 'sponsor', `${tag} 赞助（${level}）`);
  if (r.streaming > 0) addFinance(state, team.id, r.streaming, 'streaming', `${tag} 直播与内容`);
  if (r.merch > 0) {
    addFinance(state, team.id, r.merch, 'merch', r.merchBoost > 0 ? `${tag} 周边（含赛事热度 ${formatGold(r.merchBoost)}）` : `${tag} 周边`);
  }
  const rev = team.revenue;
  if (rev?.merchBoosts?.length) {
    for (const b of rev.merchBoosts) b.roundsLeft = Math.max(0, Math.floor(finite(b.roundsLeft)) - 1);
    rev.merchBoosts = rev.merchBoosts.filter((b) => b.roundsLeft > 0);
  }
  return r;
}

/** 名次 → 周边热度加成配置（[每回合金额(econ=1), 回合数]） */
function boostFor(tier: TournamentTier, rankFrom: number, rankTo: number): [number, number] | null {
  if (rankFrom !== rankTo) {
    // 并列名次（如 3-4）按最好名次取；TI 3-4 名表中同值
    const table = CONFIG.economy.revenue.merch.boosts[tier] ?? {};
    return table[rankFrom] ?? null;
  }
  return CONFIG.economy.revenue.merch.boosts[tier]?.[rankFrom] ?? null;
}

/**
 * 本回合已结束的赛事 → 为夺冠 / TI 好成绩的战队加入周边热度加成（按赛事 id 去重；加成从本回合起支付）。
 * 由 economy.payRoundSalaries 在结算收入前调用。
 */
export function applyResultMerchBoosts(state: GameState): void {
  const ti = state.season?.ti;
  const idx = state.roundIndex;
  for (const id of state.seasonTournamentIds ?? []) {
    const t = state.tournaments[id];
    if (!t || t.status !== 'finished' || t.season !== ti || t.roundIndex !== idx) continue;
    for (const pl of t.placements ?? []) {
      const cfg = boostFor(t.tier, pl.rankFrom, pl.rankTo);
      if (!cfg) continue;
      const team = state.teams[pl.teamId];
      if (!team || team.disbanded) continue;
      const [amount, rounds] = cfg;
      if (!(amount > 0) || !(rounds > 0)) continue;
      const rev = ensureRevenue(team);
      const list = Array.isArray(rev.merchBoosts) ? rev.merchBoosts : (rev.merchBoosts = []);
      if (list.some((b) => b.tournamentId === t.id)) continue;
      const perRound = Math.round(amount * econ(state) * difficultyMult(state, team));
      const source = `${t.tier === 'ti' ? `TI${t.season}` : t.name} ${formatRank(pl.rankFrom, pl.rankTo)}`;
      list.push({ tournamentId: t.id, perRound, roundsLeft: Math.floor(rounds), source });
      if (team.isPlayer) {
        addNews(
          state, 'finance', `周边热销：${source}`,
          `${TOURNAMENT_TIER_LABEL[t.tier] ?? '赛事'}佳绩带动俱乐部周边销量，未来 ${Math.floor(rounds)} 个回合每回合周边收入额外增加约 ${formatGold(perRound)}。`,
          false, { teamIds: [team.id], noInfer: true },
        );
      }
    }
  }
}

// ===========================================================================
// 赛季预测（财务页）
// ===========================================================================

export interface SeasonProjection {
  /** 本赛季剩余付薪回合（含当前回合；赛季初 = 全部付薪回合） */
  roundsLeft: number;
  /** 当前每回合经常性收入 */
  perRound: RoundRevenue;
  /** 当前每回合工资（选手 + 教练） */
  wagePerRound: number;
  /** 剩余回合经常性收入合计（周边热度加成按剩余回合计） */
  recurringTotal: number;
  sponsorTotal: number;
  streamingTotal: number;
  merchTotal: number;
  wageTotal: number;
  /** 预计赛季末资金 = 当前资金 + 经常性收入 − 工资（不含奖金、出场费、转会、训练等） */
  projectedEnd: number;
}

/** 本赛季剩余付薪回合：回合 1..最后一回合（TI 正赛）结束时各付一次 */
export function remainingPaidRounds(state: GameState): number {
  const total = state.season?.rounds?.length ?? 0;
  if (total <= 1) return 0;
  const last = total - 1;
  const cur = Math.max(1, finite(state.roundIndex));
  return Math.max(0, last - cur + 1);
}

/** 预测本赛季剩余回合的经常性收入与工资（UI：财务页「预计赛季末资金」） */
export function seasonProjection(state: GameState, teamId: string): SeasonProjection {
  const team = state.teams[teamId];
  const n = remainingPaidRounds(state);
  if (!team) {
    const zero = { sponsor: 0, streaming: 0, merch: 0, merchBoost: 0, total: 0 };
    return { roundsLeft: n, perRound: zero, wagePerRound: 0, recurringTotal: 0, sponsorTotal: 0, streamingTotal: 0, merchTotal: 0, wageTotal: 0, projectedEnd: 0 };
  }
  const perRound = roundRevenue(state, team);
  const wagePerRound = roundWageBill(state, teamId);
  const boostTotal = activeMerchBoosts(team).reduce((a, b) => a + Math.round(b.perRound) * Math.min(n, b.roundsLeft), 0);
  const sponsorTotal = perRound.sponsor * n;
  const streamingTotal = perRound.streaming * n;
  const merchTotal = (perRound.merch - perRound.merchBoost) * n + boostTotal;
  const recurringTotal = sponsorTotal + streamingTotal + merchTotal;
  const wageTotal = wagePerRound * n;
  return {
    roundsLeft: n,
    perRound,
    wagePerRound,
    recurringTotal,
    sponsorTotal,
    streamingTotal,
    merchTotal,
    wageTotal,
    projectedEnd: Math.round(finite(team.gold) + recurringTotal - wageTotal),
  };
}
