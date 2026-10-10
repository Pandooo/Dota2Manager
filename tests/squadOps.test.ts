import { describe, expect, it } from 'vitest';
import type { GameState, Player, SeasonPhase } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeCoach, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { marketValue } from '../src/engine/player';
import { econ } from '../src/engine/economy';
import { respondToOffer, roundFee, releasePlayer } from '../src/engine/market';
import {
  activeListing, listPlayerForTransfer, listPlayersForTransfer, listingBidOutlook, listingOffers, processTransferListings,
  raiseSalary, raiseSalaryPreview, squadRoundKey, talkSuccessChance, talkToPlayer, teamBuilding, teamBuildingCost,
  unlistPlayer,
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

/** 模拟回合结束（只跑挂牌处理）并进入下一回合 */
function endRoundListings(s: GameState): void {
  processTransferListings(s);
  s.roundIndex += 1;
  s.phase = s.season.rounds[s.roundIndex]?.phase ?? s.phase;
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
  it('挂牌校验：窗口、临时替补、重复挂牌、标价范围；默认标价 = 身价', () => {
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

    const r = listPlayerForTransfer(s, p.id);
    expect(r.ok).toBe(true);
    expect(p.transferListing).toEqual({ season: 9, listedRound: 3, roundsLeft: CONFIG.squadOps.listingRounds, askingPrice: roundFee(mv) });
    expect(s.news[0].title).toContain('【挂牌】');
    expect(listPlayerForTransfer(s, p.id).ok).toBe(false);

    const t = me(s, 'M');
    t.tempSubUntilTournament = 'evt';
    expect(listPlayerForTransfer(s, t.id).ok).toBe(false);

    expect(unlistPlayer(s, p.id).ok).toBe(true);
    expect(p.transferListing).toBeUndefined();
    expect(unlistPlayer(s, p.id).ok).toBe(false);
  });

  it('低标价：数回合内出现 AI 出价（进入收到的报价），接受后成交并清除挂牌', () => {
    const s = regularState();
    const p = me(s);
    const mv = marketValue(s, p);
    const asking = roundFee(mv * 0.5);
    expect(listPlayerForTransfer(s, p.id, asking).ok).toBe(true);
    expect(listingBidOutlook(s, p.id).chance).toBeGreaterThan(0.5);

    for (let i = 0; i < CONFIG.squadOps.listingRounds && listingOffers(s, p.id).length === 0; i++) endRoundListings(s);
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
    for (let i = 0; i < CONFIG.squadOps.listingRounds; i++) endRoundListings(s);
    expect(p.transferListing?.roundsLeft).toBe(0);
    const pending = listingOffers(s, p.id);
    expect(pending.length).toBeGreaterThan(0);
    expect(p.teamId).toBe('t0');
    for (const o of pending) respondToOffer(s, o.id, false);
    const gold = s.teams.t0.gold;
    endRoundListings(s);
    expect(p.teamId).toBe('t0');
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.gold).toBe(gold);
  });

  it('高标价且无人需要：到期自动解约，无补偿、荣誉不变', () => {
    const s = regularState();
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    const mv = marketValue(s, p);
    expect(listPlayerForTransfer(s, p.id, roundFee(mv * 2)).ok).toBe(true);
    expect(listingBidOutlook(s, p.id).interested).toBe(0);
    const gold = s.teams.t0.gold;
    const honor = s.teams.t0.honor;
    const financeLen = s.finance.length;

    endRoundListings(s);
    expect(p.transferListing?.roundsLeft).toBe(2);
    endRoundListings(s);
    expect(p.transferListing?.roundsLeft).toBe(1);
    expect(s.news.some((n) => n.title.includes('仅剩最后 1 个回合'))).toBe(true);
    expect(p.teamId).toBe('t0');
    endRoundListings(s);

    expect(p.teamId).toBeNull();
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.playerIds).not.toContain(p.id);
    expect(s.teams.t0.lineup.C).not.toBe(p.id);
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.teams.t0.honor).toBe(honor);
    expect(s.finance.length).toBe(financeLen);
    expect(s.news[0].title).toContain('【挂牌到期】');
  });

  it('转会窗口锁定（本回合或下一回合）时倒计时暂停、不出价', () => {
    const s = regularState();
    const p = me(s);
    listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 0.5));
    const offersBefore = s.transferOffers.length;

    // 常规赛最后一回合：下一回合 TI 预选（锁定）
    s.roundIndex = 18;
    processTransferListings(s);
    expect(p.transferListing?.roundsLeft).toBe(3);
    // TI 预选 / 正赛回合
    for (const [idx, phase] of [[19, 'ti_qualifier'], [20, 'ti']] as const) {
      s.roundIndex = idx;
      s.phase = phase;
      processTransferListings(s);
      expect(p.transferListing?.roundsLeft).toBe(3);
    }
    expect(s.transferOffers.length).toBe(offersBefore);
    expect(p.teamId).toBe('t0');

    // 新赛季常规回合恢复倒计时
    s.roundIndex = 1;
    s.phase = 'regular';
    processTransferListings(s);
    expect(p.transferListing?.roundsLeft).toBe(2);
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

  it('season.endRound 钩子：经真实回合结算倒计时并到期自动解约（无补偿、荣誉不变）', async () => {
    const { endRound } = await import('../src/engine/season');
    const s = regularState();
    const p = me(s);
    p.power = 30;
    p.mmr = 5000;
    expect(listPlayerForTransfer(s, p.id, roundFee(marketValue(s, p) * 2)).ok).toBe(true);
    const honor = s.teams.t0.honor;
    const next = () => {
      endRound(s);
      s.roundIndex += 1;
      s.phase = s.season.rounds[s.roundIndex].phase;
    };
    next();
    expect(p.transferListing?.roundsLeft).toBe(2);
    next();
    next();
    expect(p.teamId).toBeNull();
    expect(p.transferListing).toBeUndefined();
    expect(s.teams.t0.honor).toBe(honor);
    expect(s.finance.some((f) => f.note?.includes('解约补偿'))).toBe(false);
    expect(s.news.some((n) => n.title.includes('【挂牌到期】'))).toBe(true);
  });

  it('多名人类玩家战队：处理当前战队时不清除其他人类战队的挂牌；损坏的挂牌数据被清理且不抛错', () => {
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

    // 剩余回合损坏：重置为完整等待期，而不是立即解约
    const nan = me(s, 'SS');
    nan.transferListing = { season: 9, listedRound: 3, roundsLeft: Number.NaN, askingPrice: 50000 };
    processTransferListings(s);
    expect(nan.teamId).toBe('t0');
    expect(nan.transferListing?.roundsLeft).toBe(CONFIG.squadOps.listingRounds - 1);
  });

  it('批量挂牌 / 失效挂牌清理 / 解约清除挂牌', () => {
    const s = regularState();
    const r = listPlayersForTransfer(s, ['t0-C', 't0-M', 't1-C']);
    expect(r.ok).toBe(true);
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
});
