import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/engine/player', () => import('./e4-fakes/player'));
vi.mock('../src/engine/team', () => import('./e4-fakes/team'));
vi.mock('../src/engine/honor', () => import('./e4-fakes/others'));
vi.mock('../src/engine/generation', () => import('./e4-fakes/others'));
vi.mock('../src/engine/growth', () => import('./e4-fakes/others'));
vi.mock('../src/engine/funEvents', () => import('./e4-fakes/others'));
vi.mock('../src/data/index', () => import('./e4-fakes/others'));

import { makeTestState, makePlayer } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { CONFIG } from '../src/engine/config';
import type { GameState, Player, Tournament } from '../src/engine/types';
import { marketValue, computeSalary, playerTier } from './e4-fakes/player';
import {
  bidForPlayer, expireOffers, freeAgents, generateAiOffers, generateTempSubCandidates, hireTempSub,
  isTransferWindowOpen, playerWillingness, processContractExpiry, refreshFreeAgents, releasePlayer, releaseTempSubs,
  renewContract, respondToOffer, signFreeAgent, suggestedFee, tempSubCost, signingFee, fillRosterFromMarket,
  departToFreeAgency, executeTransfer,
} from '../src/engine/market';

function addFreeAgent(s: GameState, over: Partial<Player> = {}): Player {
  const p = makePlayer({ teamId: null, ...over });
  p.salary = computeSalary(s, p);
  s.players[p.id] = p;
  return p;
}

function addTournament(s: GameState, over: Partial<Tournament> = {}): Tournament {
  const t: Tournament = {
    id: 'tour1', seriesId: 'tour', name: 'Test Major', tier: 'major', season: 9, roundIndex: 1, startDate: '2019-01-01',
    city: 'Los Angeles', hostRegion: 'NA', online: false, prizePool: 1000000, appearanceFee: 10000, format: 'de8',
    teamIds: ['t0', 't1'], invitedTeamIds: [], qualifierTeamIds: [], stages: [], series: {}, status: 'scheduled',
    placements: [], playerStatus: 'registered', minHonor: 0, ...over,
  };
  s.tournaments[t.id] = t;
  return t;
}

describe('market · 窗口与自由市场', () => {
  it('转会窗口只在 preseason / regular 开放', () => {
    const s = makeTestState(2);
    for (const [phase, open] of [['preseason', true], ['regular', true], ['ti_qualifier', false], ['ti', false], ['season_end', false]] as const) {
      s.phase = phase;
      expect(isTransferWindowOpen(s)).toBe(open);
    }
  });

  it('freeAgents 排除卡池、替补候选、野外替补，并按评分降序', () => {
    const s = makeTestState(2);
    const a = addFreeAgent(s, { power: 60 });
    const b = addFreeAgent(s, { power: 90 });
    const g = addFreeAgent(s, { power: 99 });
    const w = addFreeAgent(s, { power: 98, isWildSub: true });
    const c = addFreeAgent(s, { power: 97 });
    const r = addFreeAgent(s, { power: 96, status: 'retired' });
    s.gachaPool = [g.id];
    s.tempSubCandidates = [c.id];
    const ids = freeAgents(s).map((p) => p.id);
    expect(ids).toEqual([b.id, a.id]);
    expect(ids).not.toContain(w.id);
    expect(ids).not.toContain(r.id);
  });

  it('refreshFreeAgents 补足下限，过大时裁剪程序化选手', () => {
    const s = makeTestState(2);
    refreshFreeAgents(s);
    expect(freeAgents(s).length).toBe(CONFIG.market.freeAgentPoolMin);
    withConfig('market', { freeAgentPoolMax: 10 }, () => refreshFreeAgents(s));
    expect(freeAgents(s).length).toBe(10);
  });

  it('选手意愿随荣誉单调递增，且夹在合法区间', () => {
    const s = makeTestState(2);
    const star = addFreeAgent(s, { mmr: 16000 }); // SSR
    let prev = -1;
    for (const h of [0, 50, 100, 300, 600, 1000, 1500, 3000]) {
      s.teams.t0.honor = h;
      const w = playerWillingness(s, star.id, 't0');
      expect(w).toBeGreaterThanOrEqual(prev);
      expect(w).toBeGreaterThanOrEqual(CONFIG.market.willingnessRange[0]);
      expect(w).toBeLessThanOrEqual(CONFIG.market.willingnessRange[1]);
      prev = w;
    }
    // 自由身比有东家（高归属感）更愿意加盟
    const contracted = s.players['t1-C'];
    contracted.loyalty = 90;
    contracted.mmr = 16000;
    s.teams.t0.honor = 500;
    expect(playerWillingness(s, star.id, 't0')).toBeGreaterThan(playerWillingness(s, contracted.id, 't0'));
    expect(playerWillingness(s, contracted.id, 't1')).toBe(1);
    expect(playerWillingness(s, 'missing', 't0')).toBe(0);
  });
});

describe('market · 签约与转会', () => {
  it('签约自由选手：扣签字费、入队、按等级加荣誉', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 5000; // 意愿接近上限
    const p = addFreeAgent(s, { mmr: 9000, position: 'C' }); // S 级
    const gold0 = s.teams.t0.gold;
    const honor0 = s.teams.t0.honor;
    const fee = signingFee(s, p);
    expect(fee).toBe(Math.round((marketValue(s, p) * CONFIG.economy.signingFeeRatio) / 1000) * 1000);
    // 意愿 97%：同一回合骰子固定，若被拒则换回合重试
    let r = signFreeAgent(s, p.id);
    for (let i = 1; !r.ok && i < 5; i++) {
      s.roundIndex = i;
      r = signFreeAgent(s, p.id);
    }
    expect(r.ok).toBe(true);
    expect(p.teamId).toBe('t0');
    expect(s.teams.t0.gold).toBe(gold0 - fee);
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.honor.transfer.signTierBonus.S);
    expect(s.finance.some((f) => f.category === 'signing')).toBe(true);
  });

  /** 直接塞进 t0 的正式队员（不经签约流程） */
  function stuffRoster(s: GameState, size: number): void {
    while (s.teams.t0.playerIds.filter((id) => !s.players[id]?.tempSubUntilTournament).length < size) {
      const x = addFreeAgent(s);
      s.teams.t0.playerIds.push(x.id);
      x.teamId = 't0';
    }
  }

  /** 签约意愿按回合固定：被婉拒则换回合重试 */
  function signRetry(s: GameState, id: string) {
    let r = signFreeAgent(s, id);
    for (let i = 1; !r.ok && !r.message.includes('上限') && i < 12; i++) {
      s.roundIndex = i;
      r = signFreeAgent(s, id);
    }
    return r;
  }

  it('签约失败：窗口关闭 / 已有东家 / 不存在', () => {
    const s = makeTestState(2);
    const p = addFreeAgent(s);
    s.phase = 'ti';
    expect(signFreeAgent(s, p.id).ok).toBe(false);
    s.phase = 'regular';
    expect(signFreeAgent(s, 't1-C').ok).toBe(false);
    expect(signFreeAgent(s, 'missing').ok).toBe(false);
  });

  it('常规阵容上限是软上限：满 8 人仍可签约自由选手，只有达到绝对上限才被拦下（明确提示）', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    s.teams.t0.honor = 5000;
    s.teams.t0.gold = 50_000_000;
    expect(CONFIG.team.hardMaxRoster).toBeGreaterThan(CONFIG.team.maxRoster);
    stuffRoster(s, CONFIG.team.maxRoster);
    const p = addFreeAgent(s);
    const r = signRetry(s, p.id);
    expect(r.ok, r.message).toBe(true);
    expect(p.teamId).toBe('t0');
    expect(s.teams.t0.playerIds).toHaveLength(CONFIG.team.maxRoster + 1);

    // 一路签到绝对上限
    stuffRoster(s, CONFIG.team.hardMaxRoster - 1);
    const last = addFreeAgent(s);
    expect(signRetry(s, last.id).ok).toBe(true);
    expect(s.teams.t0.playerIds).toHaveLength(CONFIG.team.hardMaxRoster);
    const over = addFreeAgent(s);
    const blocked = signFreeAgent(s, over.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain(`绝对上限（${CONFIG.team.hardMaxRoster} 人）`);
    expect(over.teamId).toBeNull();
    // 临时替补不计入阵容人数
    const t = addTournament(s);
    const sub = generateTempSubCandidates(s, 'M')[0];
    expect(hireTempSub(s, sub.id, t.id).ok).toBe(true);
    s.roundIndex = 20;
    expect(signFreeAgent(s, addFreeAgent(s).id).message).toContain('绝对上限');
  });

  it('求购：常规上限已满仍可报价成交，绝对上限时被拦下', () => {
    const s = makeTestState(3);
    s.phase = 'regular';
    s.teams.t0.honor = 5000;
    s.teams.t0.gold = 50_000_000;
    stuffRoster(s, CONFIG.team.maxRoster);
    const target = s.players['t1-M'];
    target.loyalty = 10;
    const r = bidForPlayer(s, target.id, marketValue(s, target) * 5);
    expect(r.ok, r.message).toBe(true);
    expect(target.teamId).toBe('t0');
    expect(s.teams.t0.playerIds).toHaveLength(CONFIG.team.maxRoster + 1);

    stuffRoster(s, CONFIG.team.hardMaxRoster);
    const other = s.players['t2-M'];
    other.loyalty = 10;
    const b = bidForPlayer(s, other.id, marketValue(s, other) * 5);
    expect(b.ok).toBe(false);
    expect(b.message).toContain('绝对上限');
    expect(other.teamId).toBe('t2');
  });

  it('临时替补不受阵容人数上限限制（绝对上限时也能为赛事招募），只限同时在队的临时替补人数', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    s.teams.t0.gold = 50_000_000;
    stuffRoster(s, CONFIG.team.hardMaxRoster);
    const t = addTournament(s);
    s.players['t0-M'].unavailableTournamentIds = [t.id];
    const sub = generateTempSubCandidates(s, 'M')[0];
    const r = hireTempSub(s, sub.id, t.id);
    expect(r.ok, r.message).toBe(true);
    expect(sub.teamId).toBe('t0');
    // 临时替补人数上限
    for (let i = 1; i < CONFIG.market.tempSubMax; i++) {
      const c = generateTempSubCandidates(s)[0];
      expect(hireTempSub(s, c.id, t.id).ok).toBe(true);
    }
    const extra = generateTempSubCandidates(s)[0];
    const no = hireTempSub(s, extra.id, t.id);
    expect(no.ok).toBe(false);
    expect(no.message).toContain(`临时替补已有 ${CONFIG.market.tempSubMax} 人`);
  });

  it('同一回合重复签约结果一致（防刷概率）', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 0;
    const p = addFreeAgent(s, { mmr: 16000 });
    const a = signFreeAgent(s, p.id);
    const b = signFreeAgent(s, p.id);
    if (!a.ok) expect(b.ok).toBe(false);
  });

  it('求购：高价成交、AI 原队补齐 5 人；低价被拒', () => {
    const s = makeTestState(3);
    s.teams.t0.honor = 5000;
    s.teams.t0.gold = 50_000_000;
    const target = s.players['t1-M'];
    target.loyalty = 10;
    const low = bidForPlayer(s, target.id, 1000);
    expect(low.ok).toBe(false);
    expect(target.teamId).toBe('t1');

    const value = marketValue(s, target);
    const sellerGold = s.teams.t1.gold;
    const r = bidForPlayer(s, target.id, value * 5);
    expect(r.ok).toBe(true);
    expect(target.teamId).toBe('t0');
    expect(s.teams.t1.gold).toBe(sellerGold + value * 5);
    const seller = s.teams.t1.playerIds.map((id) => s.players[id]).filter((p) => p.status === 'active');
    expect(seller.length).toBeGreaterThanOrEqual(5);
    expect(Object.values(s.teams.t1.lineup).every(Boolean)).toBe(true);
    expect(suggestedFee(s, 't1-C')).toBeGreaterThanOrEqual(marketValue(s, s.players['t1-C']));
  });

  it('fillRosterFromMarket 生成或签约补齐至目标人数', () => {
    const s = makeTestState(2);
    const team = s.teams.t1;
    for (const id of team.playerIds.slice(0, 3)) {
      s.players[id].teamId = null;
    }
    team.playerIds = team.playerIds.slice(3);
    team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
    fillRosterFromMarket(s, 't1', 5);
    expect(team.playerIds.length).toBe(5);
    const positions = new Set(team.playerIds.map((id) => s.players[id].position));
    expect(positions.size).toBe(5);
  });
});

describe('market · AI 报价', () => {
  it('AI 报价写入 transferOffers，可接受 / 拒绝 / 过期', () => {
    const s = makeTestState(4);
    s.phase = 'regular';
    s.roundIndex = 3;
    for (const t of ['t1', 't2', 't3']) s.teams[t].gold = 50_000_000;
    withConfig('market', { aiOfferChancePerRound: 1 }, () => generateAiOffers(s));
    expect(s.transferOffers).toHaveLength(1);
    const offer = s.transferOffers[0];
    const p = s.players[offer.playerId];
    const value = marketValue(s, p);
    expect(offer.fee).toBeGreaterThanOrEqual(value * 0.9 - 1000);
    expect(offer.fee).toBeLessThanOrEqual(value * 1.4 + 1000);
    expect(offer.expiresRound).toBe(3 + CONFIG.market.offerExpireRounds);

    const gold0 = s.teams.t0.gold;
    const buyerGold = s.teams[offer.fromTeamId].gold;
    const r = respondToOffer(s, offer.id, true);
    expect(r.ok).toBe(true);
    expect(offer.status).toBe('accepted');
    expect(p.teamId).toBe(offer.fromTeamId);
    expect(s.teams.t0.gold).toBe(gold0 + offer.fee);
    expect(s.teams[offer.fromTeamId].gold).toBe(buyerGold - offer.fee);
    expect(respondToOffer(s, offer.id, true).ok).toBe(false);

    // 拒绝：想走的选手归属感下降
    withConfig('market', { aiOfferChancePerRound: 1 }, () => generateAiOffers(s));
    const o2 = s.transferOffers.find((o) => o.status === 'pending')!;
    const p2 = s.players[o2.playerId];
    p2.loyalty = 10;
    expect(respondToOffer(s, o2.id, false).ok).toBe(true);
    expect(o2.status).toBe('rejected');
    expect(p2.loyalty).toBe(10 + CONFIG.market.declineLoyaltyPenalty);

    // 过期
    withConfig('market', { aiOfferChancePerRound: 1 }, () => generateAiOffers(s));
    const o3 = s.transferOffers.find((o) => o.status === 'pending')!;
    expireOffers(s);
    expect(o3.status).toBe('pending');
    s.roundIndex += 1;
    expireOffers(s);
    expect(o3.status).toBe('expired');
  });

  it('窗口关闭时不生成报价', () => {
    const s = makeTestState(3);
    s.phase = 'ti';
    withConfig('market', { aiOfferChancePerRound: 1 }, () => generateAiOffers(s));
    expect(s.transferOffers).toHaveLength(0);
  });
});

describe('market · 解约与续约', () => {
  it('解约：支付补偿、扣荣誉、成为自由选手', () => {
    const s = makeTestState(2);
    const p = s.players['t0-HS'];
    p.contractUntil = 10; // 剩 2 个赛季
    const gold0 = s.teams.t0.gold;
    const honor0 = s.teams.t0.honor;
    const r = releasePlayer(s, p.id);
    expect(r.ok).toBe(true);
    expect(p.teamId).toBeNull();
    expect(s.teams.t0.gold).toBe(gold0 - p.salary * CONFIG.market.releaseCompRoundsPerSeason * 2);
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.honor.transfer.releasePenalty);
    expect(freeAgents(s).map((x) => x.id)).toContain(p.id);

    // 合同已到期（待续约）的选手：放走不需补偿、不扣荣誉，续约决策一并清除
    const q = s.players['t0-SS'];
    q.contractUntil = s.season.ti - 1;
    s.pendingDecisions.push({
      id: 'dc', kind: 'contract', title: 't', body: 'b', choices: [{ id: 'release', label: 'x' }],
      ctx: { playerId: q.id }, createdRound: 0, blocking: true,
    });
    const gold1 = s.teams.t0.gold;
    const honor1 = s.teams.t0.honor;
    expect(releasePlayer(s, q.id).ok).toBe(true);
    expect(q.teamId).toBeNull();
    expect(s.teams.t0.gold).toBe(gold1);
    expect(s.teams.t0.honor).toBe(honor1);
    expect(s.pendingDecisions).toHaveLength(0);
  });

  it('续约：延长合同；归属感极低时拒绝', () => {
    const s = makeTestState(2);
    const p = s.players['t0-C'];
    p.contractUntil = 9;
    const r = renewContract(s, p.id, 2);
    expect(r.ok).toBe(true);
    expect(p.contractUntil).toBe(11);
    const q = s.players['t0-M'];
    q.contractUntil = 9;
    q.loyalty = 0;
    expect(renewContract(s, q.id, 1).ok).toBe(false);
    expect(q.contractUntil).toBe(9);
  });

  it('合同到期：玩家生成续约决策，AI 续约或放出', () => {
    const s = makeTestState(4);
    for (const p of Object.values(s.players)) p.contractUntil = 9;
    processContractExpiry(s);
    const decisions = s.pendingDecisions.filter((d) => d.kind === 'contract');
    expect(decisions).toHaveLength(5);
    for (const d of decisions) {
      expect(d.blocking).toBe(true);
      expect(d.choices.map((c) => c.id)).toEqual(['renew_1', 'renew_2', 'release']);
    }
    for (const t of ['t1', 't2', 't3']) {
      for (const p of Object.values(s.players).filter((x) => x.lastTeamId === t || x.teamId === t)) {
        if (p.teamId === t) expect(p.contractUntil).toBeGreaterThan(9);
        else expect(p.teamId).toBeNull();
      }
    }
    // 再次调用不重复生成
    processContractExpiry(s);
    expect(s.pendingDecisions.filter((d) => d.kind === 'contract')).toHaveLength(5);
  });
});

describe('market · 临时替补', () => {
  it('生成候选（不进自由市场）→ 雇佣 → 赛后释放并删除程序化选手', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    const t = addTournament(s);
    const cands = generateTempSubCandidates(s, 'M');
    expect(cands).toHaveLength(CONFIG.tempSub.candidates);
    expect(cands.every((p) => p.position === 'M')).toBe(true);
    const fa = new Set(freeAgents(s).map((p) => p.id));
    expect(cands.some((p) => fa.has(p.id))).toBe(false);

    const sub = cands[0];
    const cost = tempSubCost(s, sub.id);
    expect(cost).toBe(Math.round(CONFIG.economy.salaryByTier[playerTier(sub)] * CONFIG.tempSub.costMult));
    const gold0 = s.teams.t0.gold;
    s.players['t0-M'].unavailableTournamentIds = [t.id];
    const r = hireTempSub(s, sub.id, t.id);
    expect(r.ok).toBe(true);
    expect(sub.teamId).toBe('t0');
    expect(sub.tempSubUntilTournament).toBe(t.id);
    expect(s.teams.t0.gold).toBe(gold0 - cost);
    expect(s.teams.t0.lineup.M).toBe(sub.id);
    expect(s.tempSubCandidates).not.toContain(sub.id);
    expect(hireTempSub(s, cands[1].id, 'nope').ok).toBe(false);

    const others = s.tempSubCandidates.slice();
    releaseTempSubs(s, t.id);
    expect(s.players[sub.id]).toBeUndefined();
    for (const id of others) expect(s.players[id]).toBeUndefined();
    expect(s.tempSubCandidates).toEqual([]);
    expect(s.teams.t0.playerIds).not.toContain(sub.id);
  });

  it('临时替补被提前移出战队（禁赛/离队等）：不留下孤儿临时标记，程序化野外替补直接删除', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    const t = addTournament(s);
    const [wild] = generateTempSubCandidates(s, 'C');
    expect(hireTempSub(s, wild.id, t.id).ok).toBe(true);
    departToFreeAgency(s, wild.id);
    expect(s.players[wild.id]).toBeUndefined();
    expect(s.teams.t0.playerIds).not.toContain(wild.id);
    expect(Object.values(s.teams.t0.lineup)).not.toContain(wild.id);

    const real = addFreeAgent(s, { isReal: true, position: 'O' });
    s.tempSubCandidates = [real.id];
    expect(hireTempSub(s, real.id, t.id).ok).toBe(true);
    departToFreeAgency(s, real.id);
    expect(real.teamId).toBeNull();
    expect(real.tempSubUntilTournament).toBeUndefined();
    expect(freeAgents(s).map((p) => p.id)).toContain(real.id);
  });

  it('真实选手替补赛后回到自由市场', () => {
    const s = makeTestState(2);
    const t = addTournament(s);
    const real = addFreeAgent(s, { isReal: true, position: 'O' });
    s.tempSubCandidates = [real.id];
    expect(hireTempSub(s, real.id, t.id).ok).toBe(true);
    releaseTempSubs(s, t.id);
    expect(s.players[real.id]).toBeDefined();
    expect(real.teamId).toBeNull();
    expect(real.tempSubUntilTournament).toBeUndefined();
    expect(freeAgents(s).map((p) => p.id)).toContain(real.id);
  });
});

describe('market · 转会后清理', () => {
  it('转出后清除抽卡标记、待处理报价与离队/续约决策', () => {
    const s = makeTestState(3);
    s.phase = 'regular';
    const pid = s.teams.t0.playerIds[0];
    const p = s.players[pid];
    p.gachaSeason = s.season.ti;
    s.transferOffers.push({
      id: 'of-a', playerId: pid, fromTeamId: 't2', toTeamId: 't0', fee: 1000, salary: 1000, status: 'pending',
      createdRound: 0, expiresRound: 2, season: s.season.ti,
    });
    s.pendingDecisions.push({
      id: 'dl', kind: 'contract', title: 't', body: 'b', choices: [{ id: 'release', label: 'x' }],
      ctx: { playerId: pid }, createdRound: 0, blocking: true,
    });
    expect(executeTransfer(s, pid, 't1', 5000)).toBe(true);
    expect(p.teamId).toBe('t1');
    expect(p.gachaSeason).toBeUndefined();
    expect(s.transferOffers.find((o) => o.id === 'of-a')!.status).toBe('expired');
    expect(s.pendingDecisions).toHaveLength(0);
    expect(s.teams.t0.playerIds).not.toContain(pid);
    expect(Object.values(s.teams.t0.lineup)).not.toContain(pid);
  });
});
