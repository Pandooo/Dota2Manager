import { describe, expect, it, onTestFinished } from 'vitest';
import type { GameState, Player, SeasonPhase } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeCoach, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { marketValue } from '../src/engine/player';
import { econ } from '../src/engine/economy';
import { respondToOffer, roundFee, releasePlayer } from '../src/engine/market';
import {
  LISTING_RULE_VERSION, activeListing, listPlayerForTransfer, listPlayersForTransfer, listingBidOutlook, listingDurationLabel,
  listingDurationRounds, listingOffers, listingProgress, listingRoundStatus, listingRoundsPerSeason, listingStaleFactor,
  migrateListing, processTransferListings, raiseSalary, raiseSalaryPreview, squadRoundKey, talkSuccessChance, talkToPlayer,
  teamBuilding, teamBuildingCost, unlistPlayer,
} from '../src/engine/squadOps';

/** 20 回合赛季：0 赛季初，1..18 常规，19 TI 预选，20 TI */
function setRounds(s: GameState): void {
  const phases: SeasonPhase[] = ['preseason', ...Array.from({ length: 18 }, () => 'regular' as const), 'ti_qualifier', 'ti'];
  s.season.rounds = phases.map((phase, index) => ({
    index, phase, startDate: '2019-01-01', endDate: '2019-01-08', tournamentIds: [], patchVersions: [],
  }));
}

function regularState(teams = 8, seed = 12345): GameState {
  const s = makeTestState(teams, seed);
  setRounds(s);
  s.roundIndex = 3;
  s.phase = 'regular';
  return s;
}

/**
 * 模拟回合结束（只跑挂牌处理）并进入下一回合，与 game.advanceRound 一致：赛季初没有回合结算（直接进入第 1 回合），
 * TI 回合之后进入下赛季的赛季初（回合表结构不变）
 */
function endRoundListings(s: GameState): void {
  if (s.phase !== 'preseason') processTransferListings(s);
  if (s.roundIndex >= s.season.rounds.length - 1) {
    s.season.ti += 1;
    s.roundIndex = 0;
  } else {
    s.roundIndex += 1;
  }
  s.phase = s.season.rounds[s.roundIndex]?.phase ?? s.phase;
}

/** 一直结算到满足条件（最多 limit 个回合），返回结算的回合数 */
function endRoundsUntil(s: GameState, done: () => boolean, limit = 60): number {
  let n = 0;
  while (!done() && n < limit) {
    endRoundListings(s);
    n++;
  }
  return n;
}

const me = (s: GameState, pos = 'C'): Player => s.players[`t0-${pos}`];

describe('squadOps · 加薪', () => {
  it('按比例上调工资、提升归属感（递减），每赛季限一次', () => {
    const s = regularState();
    const p = me(s);
    p.salary = 10000;
    p.loyalty = 60;
    const pv = raiseSalaryPreview(s, p.id, 20);
    expect(pv.allowed).toBe(true);
    expect(pv.newSalary).toBe(12000);
    expect(pv.loyaltyGain).toBeCloseTo(12 * (1 - 60 / 150), 1);

    const r = raiseSalary(s, p.id, 20);
    expect(r.ok).toBe(true);
    expect(p.salary).toBe(12000);
    expect(p.loyalty).toBeCloseTo(60 + 7.2, 1);
    expect(p.lastRaiseSeason).toBe(9);
    expect(s.news[0].title).toContain('【加薪】');

    // 同赛季再次加薪被拒绝（任何幅度）
    expect(raiseSalaryPreview(s, p.id, 10).allowed).toBe(false);
    const again = raiseSalary(s, p.id, 10);
    expect(again.ok).toBe(false);
    expect(p.salary).toBe(12000);

    // 下赛季可再次加薪
    s.season.ti = 10;
    expect(raiseSalary(s, p.id, 10).ok).toBe(true);
    expect(p.salary).toBe(13200);
  });

  it('归属感越高收益越小；非法幅度/外队/临时替补被拒绝', () => {
    const s = regularState();
    const a = me(s, 'C');
    const b = me(s, 'M');
    a.loyalty = 30;
    b.loyalty = 95;
    expect(raiseSalaryPreview(s, a.id, 30).loyaltyGain).toBeGreaterThan(raiseSalaryPreview(s, b.id, 30).loyaltyGain);
    expect(raiseSalary(s, a.id, 15).ok).toBe(false);
    expect(raiseSalary(s, 't1-C', 10).ok).toBe(false);
    a.tempSubUntilTournament = 'x';
    expect(raiseSalary(s, a.id, 10).ok).toBe(false);
    expect(raiseSalary(s, 'nobody', 10).ok).toBe(false);
  });
});

describe('squadOps · 谈心', () => {
  it('每名选手每回合一次，下一回合可再谈', () => {
    const s = regularState();
    const p = me(s);
    p.loyalty = 50;
    const r1 = talkToPlayer(s, p.id);
    expect(r1.ok).toBe(true);
    expect(p.lastTalkRound).toBe(squadRoundKey(s));
    const r2 = talkToPlayer(s, p.id);
    expect(r2.ok).toBe(false);
    // 其他选手不受影响
    expect(talkToPlayer(s, me(s, 'M').id).ok).toBe(true);
    s.roundIndex += 1;
    expect(talkToPlayer(s, p.id).ok).toBe(true);
  });

  it('成功率受教练灵性与荣誉影响并夹紧；失败仅在归属感 < 30 时 -1', () => {
    const s = regularState();
    const team = s.teams.t0;
    team.honor = 0;
    const base = talkSuccessChance(s);
    expect(base).toBeCloseTo(0.45, 5);
    const coach = makeCoach({ insight: 100, teamId: 't0' });
    s.coaches[coach.id] = coach;
    team.coachId = coach.id;
    team.honor = 100000;
    const high = talkSuccessChance(s);
    expect(high).toBeGreaterThan(base);
    expect(high).toBeLessThanOrEqual(CONFIG.squadOps.talk.chanceRange[1]);

    // 强制失败：成功率区间压到 0
    withConfig('squadOps', { talk: { ...CONFIG.squadOps.talk, chanceRange: [0, 0], base: 0 } }, () => {
      const low = me(s, 'C');
      low.loyalty = 20;
      const r = talkToPlayer(s, low.id);
      expect(r.ok).toBe(true);
      expect(r.success).toBe(false);
      expect(low.loyalty).toBe(19);
      const mid = me(s, 'M');
      mid.loyalty = 50;
      talkToPlayer(s, mid.id);
      expect(mid.loyalty).toBe(50);
    });
    // 强制成功：+3~6 × 递减
    withConfig('squadOps', { talk: { ...CONFIG.squadOps.talk, chanceRange: [1, 1], base: 1 } }, () => {
      const p = me(s, 'O');
      p.loyalty = 60;
      const r = talkToPlayer(s, p.id);
      expect(r.success).toBe(true);
      expect(p.loyalty - 60).toBeGreaterThanOrEqual(3 * (1 - 60 / 150) - 0.01);
      expect(p.loyalty - 60).toBeLessThanOrEqual(6 * (1 - 60 / 150) + 0.01);
    });
  });
});

describe('squadOps · 团建', () => {
  it('扣除费用（× 经济指数），全队归属感/韧性提升，每回合一次', () => {
    const s = regularState();
    const team = s.teams.t0;
    const cost = teamBuildingCost(s);
    expect(cost).toBe(Math.round(CONFIG.squadOps.teamBuildingCost * econ(s)));
    const gold = team.gold;
    const before = team.playerIds.map((id) => ({ l: s.players[id].loyalty, r: s.players[id].resilience }));
    const r = teamBuilding(s);
    expect(r.ok).toBe(true);
    expect(team.gold).toBe(gold - cost);
    team.playerIds.forEach((id, i) => {
      const p = s.players[id];
      expect(p.loyalty).toBeGreaterThan(before[i].l);
      expect(p.resilience).toBeCloseTo(before[i].r + CONFIG.squadOps.teamBuildingResilience, 5);
    });
    // 同回合第二次失败且不扣钱
    expect(teamBuilding(s).ok).toBe(false);
    expect(team.gold).toBe(gold - cost);
    // 下一回合可再次团建
    s.roundIndex += 1;
    expect(teamBuilding(s).ok).toBe(true);
    expect(team.gold).toBe(gold - 2 * cost);
  });

  it('资金不足时失败', () => {
    const s = regularState();
    s.teams.t0.gold = 100;
    const r = teamBuilding(s);
    expect(r.ok).toBe(false);
    expect(s.teams.t0.gold).toBe(100);
  });
});

describe('squadOps · 挂牌转会', () => {
  it('挂牌校验：窗口、临时替补、重复挂牌、标价范围；默认标价 = 身价；挂牌期一整个赛季', () => {
    const s = regularState();
    const p = me(s);
    s.phase = 'ti_qualifier';
    expect(listPlayerForTransfer(s, p.id).ok).toBe(false);
    s.phase = 'regular';
    const mv = marketValue(s, p);
    expect(listPlayerForTransfer(s, p.id, mv * 3).ok).toBe(false);
    expect(listPlayerForTransfer(s, p.id, mv * 0.2).ok).toBe(false);
    expect(listPlayerForTransfer(s, p.id, Number.NaN).ok).toBe(false);
    expect(listPlayerForTransfer(s, 't1-C').ok).toBe(false);

    // 挂牌期 = listingSeasons × 常规赛回合数（赛季初没有回合结算，TI 锁定期间暂停）
    expect(listingRoundsPerSeason()).toBe(CONFIG.calendar.regularRounds);
    expect(listingDurationRounds()).toBe(CONFIG.squadOps.listingSeasons * CONFIG.calendar.regularRounds);
    expect(listingDurationLabel()).toBe(`一整个赛季（${CONFIG.calendar.regularRounds} 个转会回合，TI 锁定期间暂停）`);

    const r = listPlayerForTransfer(s, p.id);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('一整个赛季');
    const n = listingDurationRounds();
    expect(p.transferListing).toEqual({
      season: 9, listedRound: 3, roundsLeft: n, askingPrice: roundFee(mv), v: LISTING_RULE_VERSION, totalRounds: n, bidRolls: 0,
    });
    expect(s.news[0].title).toContain('【挂牌】');
    expect(s.news[0].body).toContain('一整个赛季');
    expect(listPlayerForTransfer(s, p.id).ok).toBe(false);

    const t = me(s, 'M');
    t.tempSubUntilTournament = 'evt';
    expect(listPlayerForTransfer(s, t.id).ok).toBe(false);

    expect(unlistPlayer(s, p.id).ok).toBe(true);
    expect(p.transferListing).toBeUndefined();
    expect(unlistPlayer(s, p.id).ok).toBe(false);

    // 游戏结束后不再有有效挂牌
    expect(listPlayerForTransfer(s, me(s, 'O').id).ok).toBe(true);
    expect(activeListing(s, me(s, 'O'))).not.toBeNull();
    s.gameOver = { reason: 'disbanded', summary: 'x' };
    expect(activeListing(s, me(s, 'O'))).toBeNull();
  });

  it('低标价：前几个回合内出现 AI 出价（进入收到的报价），接受后成交并清除挂牌', () => {
    const s = regularState();
    const p = me(s);
    const mv = marketValue(s, p);
    const asking = roundFee(mv * 0.5);
    expect(listPlayerForTransfer(s, p.id, asking).ok).toBe(true);
    expect(listingBidOutlook(s, p.id).chance).toBeGreaterThan(0.5);

    for (let i = 0; i < CONFIG.squadOps.listingFreshRolls && listingOffers(s, p.id).length === 0; i++) endRoundListings(s);
    const offers = listingOffers(s, p.id);
    expect(offers.length).toBeGreaterThan(0);
    const o = offers[0];
    expect(o.listing).toBe(true);
    expect(o.toTeamId).toBe('t0');
    expect(s.teams[o.fromTeamId].isPlayer).toBe(false);
    expect(o.fee).toBeGreaterThanOrEqual(roundFee(asking * CONFIG.squadOps.bidFeeRange[0]) - CONFIG.market.feeRounding);
    expect(o.fee).toBeLessThanOrEqual(roundFee(asking * CONFIG.squadOps.bidFeeRange[1]) + CONFIG.market.feeRounding);
    expect(o.expiresRound).toBeGreaterThan(s.roundIndex);
    expect(s.news.some((n) => n.title.includes('【挂牌报价】'))).toBe(true);

    const gold = s.teams.t0.gold;
    const r = respondToOffer(s, o.id, true);
    expect(r.ok).toBe(true);
    expect(p.teamId).toBe(o.fromTeamId);
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.gold).toBe(gold + o.fee);
  });

  it('有待处理报价时到期不解约；收到过报价但全部拒绝 → 挂牌结束、选手留队（不自动解约）', () => {
    const s = regularState();
    const p = me(s);
    const asking = roundFee(marketValue(s, p) * 0.5);
    listPlayerForTransfer(s, p.id, asking);
    endRoundsUntil(s, () => (p.transferListing?.roundsLeft ?? 0) <= 0);
    expect(p.transferListing?.roundsLeft).toBe(0);
    expect(p.transferListing?.hadBids).toBe(true);
    const pending = listingOffers(s, p.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(p.teamId).toBe('t0');
    for (const o of pending) respondToOffer(s, o.id, false);
    const gold = s.teams.t0.gold;
    endRoundsUntil(s, () => !p.transferListing);
    expect(p.teamId).toBe('t0');
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.news.some((n) => n.title.includes('【挂牌结束】'))).toBe(true);
    // 收到过报价：不发「即将解约」提醒
    expect(s.news.some((n) => n.title.includes('仅剩最后 1 个回合'))).toBe(false);
  });

  it('高标价且无人需要：挂牌持续一整个赛季（TI 锁定期间暂停、跨赛季延续），在下赛季同一时间点到期自动解约，无补偿、荣誉不变', () => {
    const s = regularState(); // 第 3 回合挂牌
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    const mv = marketValue(s, p);
    expect(listPlayerForTransfer(s, p.id, roundFee(mv * 2)).ok).toBe(true);
    expect(listingBidOutlook(s, p.id).interested).toBe(0);
    const gold = s.teams.t0.gold;
    const honor = s.teams.t0.honor;
    const financeLen = s.finance.length;
    const R = CONFIG.calendar.regularRounds;
    const n = listingDurationRounds();

    endRoundListings(s);
    expect(p.transferListing?.roundsLeft).toBe(n - 1);
    // 本赛季余下的常规赛回合（含最后一回合：照常计时、不出价）
    endRoundsUntil(s, () => s.phase !== 'regular');
    expect(s.phase).toBe('ti_qualifier');
    const afterSeason = n - (R - 3 + 1);
    expect(p.transferListing?.roundsLeft).toBe(afterSeason);
    // TI 预选 / 正赛 / 下赛季的赛季初：倒计时暂停，挂牌跨赛季保留
    endRoundsUntil(s, () => s.phase === 'preseason');
    expect(s.season.ti).toBe(10);
    expect(p.transferListing?.roundsLeft).toBe(afterSeason);
    expect(p.teamId).toBe('t0');
    endRoundListings(s); // 赛季初 → 第 1 回合（无结算）
    expect(p.transferListing?.roundsLeft).toBe(afterSeason);

    // 第 1 回合结束：仅剩最后 1 个回合（剩 3 个回合时已有一条提醒）
    expect(s.news.some((x) => x.title.includes(`还剩 ${CONFIG.squadOps.listingReminderRounds} 个转会回合`))).toBe(true);
    endRoundsUntil(s, () => (p.transferListing?.roundsLeft ?? 0) <= 1);
    expect(s.news.some((x) => x.title.includes('仅剩最后 1 个回合'))).toBe(true);
    expect(p.teamId).toBe('t0');
    endRoundListings(s);

    // 第 3 回合挂牌 → 下赛季第 2 回合结束时到期（下赛季第 3 回合开始前）
    expect(s.season.ti).toBe(10);
    expect(s.roundIndex).toBe(3);
    expect(p.teamId).toBeNull();
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.playerIds).not.toContain(p.id);
    expect(s.teams.t0.lineup.C).not.toBe(p.id);
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.teams.t0.honor).toBe(honor);
    expect(s.finance.length).toBe(financeLen);
    expect(s.news[0].title).toContain('【挂牌到期】');
  });

  it('转会窗口锁定时倒计时暂停、不出价；常规赛最后一回合照常计时但不出价；赛季初不计时', () => {
    const s = regularState();
    const p = me(s);
    listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 0.5));
    const n = listingDurationRounds();
    const offersBefore = s.transferOffers.length;

    // 常规赛最后一回合：下一回合 TI 预选（锁定）→ 计时、不出价
    s.roundIndex = 18;
    expect(listingRoundStatus(s)).toMatchObject({ counts: true, bids: false });
    processTransferListings(s);
    expect(p.transferListing?.roundsLeft).toBe(n - 1);
    expect(p.transferListing?.bidRolls).toBe(0);
    // TI 预选 / 正赛回合：暂停
    for (const [idx, phase] of [[19, 'ti_qualifier'], [20, 'ti']] as const) {
      s.roundIndex = idx;
      s.phase = phase;
      expect(listingRoundStatus(s).counts).toBe(false);
      processTransferListings(s);
      expect(p.transferListing?.roundsLeft).toBe(n - 1);
    }
    expect(s.transferOffers.length).toBe(offersBefore);
    expect(p.teamId).toBe('t0');

    // 新赛季的赛季初（防御：即使被调用也不计时）
    s.season.ti = 10;
    s.roundIndex = 0;
    s.phase = 'preseason';
    expect(listingRoundStatus(s)).toMatchObject({ counts: false, bids: false });
    processTransferListings(s);
    expect(p.transferListing?.roundsLeft).toBe(n - 1);

    // 新赛季常规回合恢复倒计时与出价
    s.roundIndex = 1;
    s.phase = 'regular';
    expect(listingRoundStatus(s)).toMatchObject({ counts: true, bids: true, note: '' });
    processTransferListings(s);
    expect(p.transferListing?.roundsLeft).toBe(n - 2);
    expect(p.transferListing?.bidRolls).toBe(1);
  });

  it('标价约等于身价时，非升级型选手也有板凳深度需求（≈45% 量级）；超过 bidDepthMaxRatio 后无人问津', () => {
    const s = regularState();
    const p = me(s);
    // 明显弱于所有 AI 首发：不构成首发升级，只可能作为板凳补充
    p.power = 60;
    const mv = marketValue(s, p);
    const at1 = listingBidOutlook(s, p.id, roundFee(mv));
    expect(at1.interested).toBeGreaterThan(0);
    expect(at1.chance).toBeGreaterThan(0.25);
    expect(at1.chance).toBeLessThan(0.6);
    // 0.9 附近无断崖：0.95 倍仍有需求，且概率介于 0.9 与 1.0 倍之间
    const at09 = listingBidOutlook(s, p.id, roundFee(mv * 0.9));
    const at095 = listingBidOutlook(s, p.id, roundFee(mv * 0.95));
    expect(at095.interested).toBeGreaterThan(0);
    expect(at095.chance).toBeLessThanOrEqual(at09.chance + 1e-9);
    expect(at095.chance).toBeGreaterThanOrEqual(at1.chance - 1e-9);
    const over = listingBidOutlook(s, p.id, roundFee(mv * (CONFIG.squadOps.bidDepthMaxRatio + 0.1)));
    expect(over.interested).toBe(0);
    expect(over.chance).toBe(0);
  });

  it('挂牌过久的报价意愿衰减：前 listingFreshRolls 次出价机会与原规则相同，标价不高于身价不衰减', () => {
    const S = CONFIG.squadOps;
    const F = S.listingFreshRolls;
    const d = S.listingStaleDecay;
    const [lo, hi] = S.listingStaleRatioRange;
    for (let k = 0; k < F; k++) expect(listingStaleFactor(k, 2)).toBe(1);
    for (const k of [F, F + 5, 40]) {
      expect(listingStaleFactor(k, 1)).toBe(1);
      expect(listingStaleFactor(k, 0.6)).toBe(1);
    }
    expect(listingStaleFactor(F, hi)).toBeCloseTo(d, 9);
    expect(listingStaleFactor(F + 1, 2)).toBeCloseTo(d * d, 9);
    expect(listingStaleFactor(F, (lo + hi) / 2)).toBeCloseTo(1 - 0.5 * (1 - d), 9);
    // 单调：挂得越久、标价越高，系数越低
    expect(listingStaleFactor(F + 3, 1.5)).toBeLessThan(listingStaleFactor(F + 1, 1.5));
    expect(listingStaleFactor(F + 1, 1.25)).toBeLessThan(listingStaleFactor(F + 1, 1.1));

    // 出价前景：当前挂牌计入衰减，预览新标价不计
    const s = regularState();
    const p = me(s);
    const ask = roundFee(marketValue(s, p) * 1.5);
    expect(listPlayerForTransfer(s, p.id, ask).ok).toBe(true);
    const fresh = listingBidOutlook(s, p.id);
    expect(fresh.stale).toBe(1);
    expect(fresh.chance).toBeCloseTo(listingBidOutlook(s, p.id, ask).chance, 12);
    p.transferListing!.bidRolls = F + 2;
    const stale = listingBidOutlook(s, p.id);
    const ratio = stale.ratio;
    expect(stale.stale).toBeCloseTo(listingStaleFactor(F + 2, ratio), 12);
    expect(stale.stale).toBeLessThan(1);
    if (fresh.chance > 0) expect(stale.chance).toBeCloseTo(fresh.chance * stale.stale, 12);
    expect(listingBidOutlook(s, p.id, ask).stale).toBe(1);

    // 回合结算按衰减后的概率出价：概率极低时整季也几乎不会成交（衰减系数设为 0 → 第 F+1 次起不再出价）
    withConfig('squadOps', { listingStaleDecay: 0 }, () => {
      const t = regularState(8, 777);
      const q = me(t, 'M');
      expect(listPlayerForTransfer(t, q.id, roundFee(marketValue(t, q) * 2)).ok).toBe(true);
      q.transferListing!.bidRolls = F;
      expect(listingBidOutlook(t, q.id).chance).toBe(0);
      const before = t.transferOffers.length;
      for (let i = 0; i < 10; i++) endRoundListings(t);
      expect(t.transferOffers.length).toBe(before);
      expect(q.transferListing?.bidRolls).toBe(F + 10);
    });
  });

  it('旧存档：3 回合规则的挂牌按已过回合迁移到整赛季挂牌期（读档 / 回合结算；幂等、不消耗随机数）', async () => {
    const n = listingDurationRounds();
    const old = { season: 9, listedRound: 2, roundsLeft: 2, askingPrice: 80000 };
    // 纯函数视图（界面在迁移前也显示新挂牌期）
    expect(listingProgress(old)).toEqual({ roundsLeft: n - 1, totalRounds: n, bidRolls: 1 });
    expect(old).toEqual({ season: 9, listedRound: 2, roundsLeft: 2, askingPrice: 80000 });
    const L = { ...old };
    expect(migrateListing(L)).toBe(true);
    expect(L).toEqual({ ...old, roundsLeft: n - 1, totalRounds: n, bidRolls: 1, v: LISTING_RULE_VERSION });
    expect(migrateListing(L)).toBe(false);
    expect(L.roundsLeft).toBe(n - 1);
    // 已到期（等待待处理报价）的旧挂牌：已过 3 个回合
    const expired = { season: 9, listedRound: 1, roundsLeft: 0, askingPrice: 1000, hadBids: true };
    migrateListing(expired);
    expect(expired).toMatchObject({ roundsLeft: n - 3, bidRolls: 3, hadBids: true });

    // 读档迁移
    const s = regularState();
    const p = me(s);
    p.transferListing = { season: 9, listedRound: 1, roundsLeft: 1, askingPrice: 50000 };
    const { exportSave, importSave } = await import('../src/engine/save');
    const loaded = importSave(exportSave(s));
    expect(loaded.players[p.id].transferListing).toEqual({
      season: 9, listedRound: 1, roundsLeft: n - 2, askingPrice: 50000, totalRounds: n, bidRolls: 2, v: LISTING_RULE_VERSION,
    });

    // 回合结算迁移（多人房间的存档不经过读档）：先迁移再计时，不会因旧的「剩 1 回合」而立即解约
    p.power = 30;
    p.mmr = 5000;
    const rng = s.rngState;
    processTransferListings(s);
    expect(p.teamId).toBe('t0');
    expect(p.transferListing).toMatchObject({ v: LISTING_RULE_VERSION, totalRounds: n, roundsLeft: n - 3 });
    expect(s.rngState).toBe(rng); // 无人感兴趣：不掷骰
  });

  it('season.endRound 钩子：第 1 回合挂牌持续整个常规赛，最后一回合结束时到期自动解约（无补偿、荣誉不变）', async () => {
    const { endRound } = await import('../src/engine/season');
    const s = regularState();
    s.roundIndex = 1;
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    expect(listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 2)).ok).toBe(true);
    const honor = s.teams.t0.honor;
    const n = listingDurationRounds();
    const next = () => {
      endRound(s);
      s.roundIndex += 1;
      s.phase = s.season.rounds[s.roundIndex].phase;
    };
    next();
    expect(p.transferListing?.roundsLeft).toBe(n - 1);
    while (s.roundIndex < CONFIG.calendar.regularRounds) next();
    // 第 R-1 回合结束：仅剩最后 1 个回合，且最后一回合不会再有新报价
    expect(p.transferListing?.roundsLeft).toBe(1);
    const warn = s.news.find((x) => x.title.includes('仅剩最后 1 个回合'));
    expect(warn?.body).toContain('不会再收到新的报价');
    expect(warn?.visibility).toBe('private');
    expect(p.teamId).toBe('t0');
    next(); // 常规赛最后一回合结束
    expect(s.phase).toBe('ti_qualifier');
    expect(p.teamId).toBeNull();
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.honor).toBe(honor);
    expect(s.finance.some((f) => f.note?.includes('解约补偿'))).toBe(false);
    expect(s.news.some((x) => x.title.includes('【挂牌到期】'))).toBe(true);
  });

  it('多名人类玩家战队：处理当前战队时不清除 / 不迁移其他人类战队的挂牌；损坏的挂牌数据被清理且不抛错', () => {
    const s = regularState();
    s.teams.t1.isPlayer = true; // 模拟多人模式中的另一座位
    const other = s.players['t1-C'];
    other.transferListing = { season: 9, listedRound: 3, roundsLeft: 2, askingPrice: 100000 };
    processTransferListings(s);
    expect(other.transferListing).toEqual({ season: 9, listedRound: 3, roundsLeft: 2, askingPrice: 100000 });

    const broken = me(s, 'HS');
    (broken as unknown as { transferListing: unknown }).transferListing = true;
    expect(() => processTransferListings(s)).not.toThrow();
    expect(broken.transferListing).toBeUndefined();
    expect(broken.teamId).toBe('t0');
    expect(activeListing(s, broken)).toBeNull();

    // 剩余回合损坏：重置为完整挂牌期，而不是立即解约（旧格式 / 新格式）
    const n = listingDurationRounds();
    const nan = me(s, 'SS');
    nan.transferListing = { season: 9, listedRound: 3, roundsLeft: Number.NaN, askingPrice: 50000 };
    processTransferListings(s);
    expect(nan.teamId).toBe('t0');
    expect(nan.transferListing?.roundsLeft).toBe(n - 1);
    nan.transferListing = {
      season: 9, listedRound: 3, roundsLeft: Number.NaN, askingPrice: 50000, v: LISTING_RULE_VERSION, totalRounds: n, bidRolls: Number.NaN,
    };
    processTransferListings(s);
    expect(nan.teamId).toBe('t0');
    expect(nan.transferListing?.roundsLeft).toBe(n - 1);
    expect(Number.isFinite(nan.transferListing?.bidRolls)).toBe(true);
  });

  it('批量挂牌 / 失效挂牌清理 / 解约清除挂牌', () => {
    const s = regularState();
    const r = listPlayersForTransfer(s, ['t0-C', 't0-M', 't1-C']);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('一整个赛季');
    expect(activeListing(s, me(s, 'C'))).not.toBeNull();
    expect(activeListing(s, me(s, 'M'))).not.toBeNull();
    expect(s.players['t1-C'].transferListing).toBeUndefined();

    expect(releasePlayer(s, 't0-C').ok).toBe(true);
    expect(s.players['t0-C'].transferListing).toBeUndefined();

    // 数据不一致：外队选手残留挂牌 → 回合结束时清理
    s.players['t1-M'].transferListing = { season: 9, listedRound: 1, roundsLeft: 2, askingPrice: 1000 };
    processTransferListings(s);
    expect(s.players['t1-M'].transferListing).toBeUndefined();
  });

  it('合同到期放走 / 战队解散时挂牌随之结束', async () => {
    const { processContractExpiry } = await import('../src/engine/market');
    const { resolveDecision } = await import('../src/engine/events');
    const s = regularState();
    const p = me(s);
    expect(listPlayerForTransfer(s, p.id).ok).toBe(true);
    p.contractUntil = s.season.ti;
    processContractExpiry(s);
    const d = s.pendingDecisions.find((x) => x.kind === 'contract' && x.ctx?.playerId === p.id);
    expect(d).toBeDefined();
    expect(resolveDecision(s, d!.id, 'release').ok).toBe(true);
    expect(p.teamId).toBeNull();
    expect(p.transferListing).toBeUndefined();

    const q = me(s, 'M');
    expect(listPlayerForTransfer(s, q.id).ok).toBe(true);
    s.teams.t0.disbanded = true;
    processTransferListings(s);
    expect(q.transferListing).toBeUndefined();
  });

  it('收到过任何报价都算「收到过报价」：常规赛最后一回合被转会锁定作废的普通报价、当回合就拒绝的报价、挖角报价 → 到期不解约', async () => {
    const { createTransferOffer, expireOffers } = await import('../src/engine/market');
    // A：第 1 回合挂牌（本赛季常规赛最后一回合结束时到期），最后一回合开始时收到一份普通报价、未处理
    const s = regularState();
    s.roundIndex = 1;
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    expect(listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 2)).ok).toBe(true);
    endRoundsUntil(s, () => s.roundIndex === CONFIG.calendar.regularRounds);
    expect(p.transferListing?.roundsLeft).toBe(1);
    expect(p.transferListing?.hadBids).toBeUndefined();
    const o = createTransferOffer(s, p, s.teams.t1, 1000, false);
    expect(p.transferListing?.hadBids).toBe(true);
    // 与 season.endRound 相同的顺序：先作废报价（下一回合转会锁定），再处理挂牌
    expireOffers(s);
    expect(o.status).toBe('expired');
    processTransferListings(s);
    expect(p.teamId).toBe('t0');
    expect(p.transferListing).toBeUndefined();
    expect(s.news[0].title).toContain('【挂牌结束】');
    expect(s.news.some((n) => n.title.includes('【挂牌到期】'))).toBe(false);

    // B：报价当回合就被拒绝（回合结算时已没有待处理报价）
    const t = regularState(8, 4321);
    const q = me(t, 'M');
    q.power = 30;
    q.mmr = 5000;
    expect(listPlayerForTransfer(t, q.id, roundFee(marketValue(t, q) * 2)).ok).toBe(true);
    const r = createTransferOffer(t, q, t.teams.t2, 1000, false);
    expect(respondToOffer(t, r.id, false).ok).toBe(true);
    expect(q.transferListing?.hadBids).toBe(true);
    endRoundsUntil(t, () => !q.transferListing);
    expect(q.teamId).toBe('t0');
    expect(t.news.some((n) => n.title.includes(`【挂牌结束】${q.handle}`))).toBe(true);
    // 收到过报价：不发倒计时提醒
    expect(t.news.some((n) => n.title.includes(`${q.handle} 挂牌仅剩最后 1 个回合`) || n.title.includes(`${q.handle} 挂牌还剩`))).toBe(false);

    // C：挖角报价同样算数；未挂牌的选手收到报价不受影响
    const h = me(t, 'O');
    expect(listPlayerForTransfer(t, h.id).ok).toBe(true);
    createTransferOffer(t, h, t.teams.t3, 1000, true);
    expect(h.transferListing?.hadBids).toBe(true);
    const free = me(t, 'SS');
    createTransferOffer(t, free, t.teams.t3, 1000, false);
    expect(free.transferListing).toBeUndefined();
  });

  it('倒计时提醒是挂牌方的私有消息（多人模式下其他座位看不到）', async () => {
    const { newsIsMine } = await import('../src/engine/news');
    const s = regularState();
    s.teams.t1.isPlayer = true; // 另一名人类玩家
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    expect(listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 2)).ok).toBe(true);
    endRoundsUntil(s, () => (p.transferListing?.roundsLeft ?? 0) <= 1);
    const reminders = s.news.filter((n) => n.title.startsWith(`【挂牌】${p.handle} 挂牌`));
    expect(reminders.map((n) => n.title)).toEqual([
      `【挂牌】${p.handle} 挂牌仅剩最后 1 个回合`,
      `【挂牌】${p.handle} 挂牌还剩 ${CONFIG.squadOps.listingReminderRounds} 个转会回合`,
    ]);
    for (const n of reminders) {
      expect(n.visibility).toBe('private');
      expect(n.teamIds).toEqual(['t0']);
      expect(newsIsMine(s, n, 't0')).toBe(true);
      expect(newsIsMine(s, n, 't1')).toBe(false);
    }
    // 挂牌 / 到期 / 结束这类转会新闻仍然公开
    const listed = s.news.find((n) => n.title.startsWith(`【挂牌】Team t0 将 ${p.handle} 挂牌出售`) || n.title.includes(`将 ${p.handle} 挂牌出售`));
    expect(listed?.visibility).not.toBe('private');
  });

  it('挂牌报价的有效期：TI 转会锁定前的最后一个出价回合，新闻注明仅下一回合内有效', () => {
    withConfig('squadOps', { bidChanceCurve: [[0.5, 5], [2, 5]], bidMaxChance: 1 }, () => {
      const s = regularState();
      const p = me(s);
      expect(listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 0.5)).ok).toBe(true);
      processTransferListings(s); // 第 3 回合结束：之后还有多个开放回合
      const first = s.news.find((n) => n.title.includes('【挂牌报价】'));
      expect(first?.body).toContain(`（${CONFIG.market.offerExpireRounds} 回合内有效）`);
      for (const o of listingOffers(s, p.id)) respondToOffer(s, o.id, false);
      s.roundIndex = CONFIG.calendar.regularRounds - 1; // 第 17 回合结束：第 18 回合是锁定前的最后一回合
      const before = s.news.length;
      processTransferListings(s);
      const last = s.news.slice(0, s.news.length - before).find((n) => n.title.includes('【挂牌报价】'));
      expect(last?.body).toContain('仅下一回合内有效，之后 TI 转会锁定、报价作废');
    });
  });

  it('撤牌记忆：近期撤牌后重新挂牌沿用已经历的出价机会（衰减不被重置），超过记忆期或离队后清除', () => {
    const s = regularState();
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    const ask = roundFee(marketValue(s, p) * 2);
    expect(listPlayerForTransfer(s, p.id, ask).ok).toBe(true);
    for (let i = 0; i < 5; i++) endRoundListings(s);
    expect(p.transferListing?.bidRolls).toBe(5);
    expect(unlistPlayer(s, p.id).ok).toBe(true);
    expect(p.listingStaleMemo).toEqual({ clock: s.season.ti * CONFIG.calendar.regularRounds + s.roundIndex - 1, rolls: 5 });
    // 预览新标价：按沿用的次数计算衰减（与重挂后一致）
    const pv = listingBidOutlook(s, p.id, ask);
    expect(pv.stale).toBeCloseTo(listingStaleFactor(5, pv.ratio), 12);
    expect(pv.stale).toBeLessThan(1);
    // 立即重挂：沿用 5 次，挂牌期重新计满
    const r = listPlayerForTransfer(s, p.id, ask);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('5 次报价机会继续累计');
    expect(p.transferListing).toMatchObject({ bidRolls: 5, roundsLeft: listingDurationRounds() });
    expect(p.listingStaleMemo).toBeUndefined();
    expect(listingBidOutlook(s, p.id).stale).toBe(listingStaleFactor(5, listingBidOutlook(s, p.id).ratio));

    // 记忆期内（跨 TI 也算转会回合）仍沿用；满一个赛季的转会回合后不再沿用
    endRoundListings(s);
    expect(unlistPlayer(s, p.id).ok).toBe(true);
    expect(p.listingStaleMemo?.rolls).toBe(6);
    const R = CONFIG.calendar.regularRounds;
    endRoundsUntil(s, () => s.season.ti === 10 && s.roundIndex === 1); // 第 9 回合撤牌 → 下赛季第 1 回合：隔了 10 个转会回合
    expect(listPlayerForTransfer(s, p.id, ask).ok).toBe(true);
    expect(p.transferListing?.bidRolls).toBe(6);
    expect(unlistPlayer(s, p.id).ok).toBe(true);
    endRoundsUntil(s, () => s.season.ti === 11 && s.roundIndex === 1); // 正好 R 个转会回合
    expect(R).toBeGreaterThan(1);
    expect(listPlayerForTransfer(s, p.id, ask).ok).toBe(true);
    expect(p.transferListing?.bidRolls).toBe(0);

    // 标价不高于身价时沿用的次数不影响报价意愿
    expect(listingStaleFactor(30, 1)).toBe(1);
    // 关闭记忆
    withConfig('squadOps', { relistStaleMemorySeasons: 0 }, () => {
      p.transferListing!.bidRolls = 4;
      expect(unlistPlayer(s, p.id).ok).toBe(true);
      expect(listPlayerForTransfer(s, p.id, ask).ok).toBe(true);
      expect(p.transferListing?.bidRolls).toBe(0);
    });
    // 离队清除记忆
    p.transferListing!.bidRolls = 4;
    expect(unlistPlayer(s, p.id).ok).toBe(true);
    expect(p.listingStaleMemo?.rolls).toBe(4);
    expect(releasePlayer(s, p.id).ok).toBe(true);
    expect(p.listingStaleMemo).toBeUndefined();
  });

  it('合同到期决策注明挂牌状态（续约则挂牌继续，放走则挂牌结束）', async () => {
    const { processContractExpiry, refreshContractDecisions } = await import('../src/engine/market');
    const s = regularState();
    const p = me(s);
    expect(listPlayerForTransfer(s, p.id).ok).toBe(true);
    p.contractUntil = s.season.ti;
    processContractExpiry(s);
    const d = s.pendingDecisions.find((x) => x.kind === 'contract' && x.ctx?.playerId === p.id);
    expect(d?.body).toContain(`该选手挂牌中（标价 `);
    expect(d?.body).toContain(`挂牌期剩 ${listingDurationRounds()} 个转会回合`);
    expect(d?.body).toContain('续约则挂牌继续');
    // 撤牌后刷新：提示消失
    expect(unlistPlayer(s, p.id).ok).toBe(true);
    refreshContractDecisions(s);
    expect(d?.body).not.toContain('挂牌中');
  });

  it('退役时挂牌随之结束', async () => {
    const { processRetirements } = await import('../src/engine/growth');
    const s = regularState();
    const p = me(s);
    expect(listPlayerForTransfer(s, p.id).ok).toBe(true);
    p.birthYear = s.season.year - 45; // 远超退役年龄
    p.power = 10;
    withConfig('aging', { retireMax: 1, retireBase: 1 }, () => processRetirements(s));
    expect(p.status).toBe('retired');
    expect(p.transferListing).toBeUndefined();
  });
});

describe('squadOps · 整赛季挂牌（真实对局）', () => {
  it('多人：倒计时提醒只在挂牌方座位可见；各座位只处理 / 只能撤销自己的挂牌', async () => {
    const { registerNodeRosterLoader } = await import('../scripts/nodeData');
    const M = await import('../src/engine/multi');
    const { forEachSeat } = await import('../src/engine/seat');
    const { teamPlayers } = await import('../src/engine/team');
    registerNodeRosterLoader();
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 7,
      players: [
        { sessionId: 'a', name: 'A', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 'b', name: 'B', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    const regular = (tid: string) => teamPlayers(g, tid).filter((x) => !x.tempSubUntilTournament && !x.isWildSub);
    const pa = regular(A)[0];
    const pb = regular(B)[0];
    expect((M.callAsSeat(g, A, 'listPlayerForTransfer', [pa.id]) as { ok: boolean }).ok).toBe(true);
    expect((M.callAsSeat(g, B, 'listPlayerForTransfer', [pb.id]) as { ok: boolean }).ok).toBe(true);
    expect((M.callAsSeat(g, A, 'unlistPlayer', [pb.id]) as { ok: boolean }).ok).toBe(false);
    for (const p of [pa, pb]) p.transferListing!.askingPrice = 1e12; // 无人负担得起
    pa.transferListing!.roundsLeft = 2; // 下一次计时后仅剩 1 个回合
    g.roundIndex = 5;
    g.phase = 'regular';
    forEachSeat(g, () => processTransferListings(g));
    expect(pa.transferListing?.roundsLeft).toBe(1);
    expect(pb.transferListing?.roundsLeft).toBe(listingDurationRounds() - 1);
    const title = `【挂牌】${pa.handle} 挂牌仅剩最后 1 个回合`;
    expect(M.seatView(g, A).news.some((n) => n.title === title)).toBe(true);
    expect(M.seatView(g, B).news.some((n) => n.title === title)).toBe(false);
    // 挂牌新闻本身仍公开
    expect(M.seatView(g, B).news.some((n) => n.title.includes(`将 ${pa.handle} 挂牌出售`))).toBe(true);
  }, 60000);

  it('挂牌跨越 TI 与休赛期（转会潮 / 赛季初）保留，按下赛季同一时间点到期；懒人自动推进不受影响', async () => {
    const { registerNodeRosterLoader } = await import('../scripts/nodeData');
    const { advance, createNewGame, getAdvanceBlockers, previewAutoActions } = await import('../src/engine/game');
    const { teamPlayers } = await import('../src/engine/team');
    const { ageOf } = await import('../src/engine/player');
    registerNodeRosterLoader();
    const s = await createNewGame({
      startTi: 9, seasons: 3, difficulty: 'normal', managerName: '挂牌', seed: 4242,
      newClub: { name: 'List Club', tag: 'LST', region: 'CN', color: '#c23c2a' },
    });
    const step = () => {
      const r = advance(s, { auto: true });
      expect(r.ok, r.message).toBe(true);
    };
    const listAt = 12;
    // 本用例验证「整季无人报价 → 到期解约」：从开局就关掉与挂牌无关的普通随机求购（generateAiOffers），
    // 否则结果取决于随机序列（任何引擎改动都可能让某回合的普通求购恰好落到这名选手身上——包括挂牌前一刻
    // 第 12 回合开始时的求购，挂牌前已收到、仍待处理的报价同样算「收到过报价」——收到过报价就不会解约）。
    // 随机事件里的挖角报价（低归属感 / 薪资强烈不满的明星，events.ts createPoach）同理也会算作报价，一并关闭
    // （抽卡取代选秀后同种子的随机序列分叉，挂牌选手在下赛季第 8 回合被挖角，挂牌改为「收到过报价 → 留队」）
    const offerChance = CONFIG.market.aiOfferChancePerRound;
    const poachChance = CONFIG.loyalty.poachChancePerRound;
    const starPoachChance = CONFIG.salary.poach.unhappyStarPoachChance;
    (CONFIG.market as { aiOfferChancePerRound: number }).aiOfferChancePerRound = 0;
    (CONFIG.loyalty as { poachChancePerRound: number }).poachChancePerRound = 0;
    (CONFIG.salary.poach as { unhappyStarPoachChance: number }).unhappyStarPoachChance = 0;
    onTestFinished(() => {
      (CONFIG.market as { aiOfferChancePerRound: number }).aiOfferChancePerRound = offerChance;
      (CONFIG.loyalty as { poachChancePerRound: number }).poachChancePerRound = poachChance;
      (CONFIG.salary.poach as { unhappyStarPoachChance: number }).unhappyStarPoachChance = starPoachChance;
    });
    while (s.roundIndex < listAt) step();
    const me0 = s.settings.playerTeamId;
    // 最年轻的正式队员（避免赛季末退役）；挂牌后把标价抬到没有俱乐部负担得起，保证整季无人报价
    const p = teamPlayers(s, me0)
      .filter((x) => !x.tempSubUntilTournament && !x.isWildSub)
      .sort((a, b) => ageOf(s, a) - ageOf(s, b))[0];
    expect(listPlayerForTransfer(s, p.id).ok).toBe(true);
    p.transferListing!.askingPrice = 1e12;
    expect(listingBidOutlook(s, p.id).interested).toBe(0);
    expect(getAdvanceBlockers(s).length).toBe(0);
    expect(previewAutoActions(s).text).not.toContain('挂牌');
    const ti0 = s.season.ti;
    const n = listingDurationRounds();
    const R = CONFIG.calendar.regularRounds;

    while (s.season.ti === ti0) step();
    // 新赛季的赛季初：挂牌保留，倒计时停在本赛季常规赛结束时
    expect(s.phase).toBe('preseason');
    expect(p.teamId).toBe(me0);
    expect(activeListing(s, p)).not.toBeNull();
    expect(p.transferListing?.roundsLeft).toBe(n - (R - listAt + 1));
    expect(p.transferListing?.season).toBe(ti0);

    while (p.teamId === me0 && s.season.ti === ti0 + 1 && s.roundIndex < listAt) step();
    // 第 12 回合挂牌 → 下赛季第 11 回合结束时到期
    expect(s.season.ti).toBe(ti0 + 1);
    expect(s.roundIndex).toBe(listAt);
    expect(p.teamId).not.toBe(me0);
    expect(p.transferListing).toBeUndefined();
    expect(s.news.some((x) => x.title === `【挂牌到期】${p.handle} 以自由身离开 ${s.teams[me0].name}`)).toBe(true);
  }, 60000);
});
