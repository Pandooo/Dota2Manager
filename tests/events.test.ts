import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../src/engine/player', () => import('./e4-fakes/player'));
vi.mock('../src/engine/team', () => import('./e4-fakes/team'));
vi.mock('../src/engine/honor', () => import('./e4-fakes/others'));
vi.mock('../src/engine/generation', () => import('./e4-fakes/others'));
vi.mock('../src/engine/growth', () => import('./e4-fakes/others'));
vi.mock('../src/engine/funEvents', () => import('./e4-fakes/others'));
vi.mock('../src/data/index', () => import('./e4-fakes/others'));

import { makeTestState, makeCoach } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { funCalls } from './e4-fakes/others';
import { CONFIG } from '../src/engine/config';
import type { GameState, PendingDecision, Tournament } from '../src/engine/types';
import {
  checkVisaForTournament, processLoyaltyDepartures, resolveDecision, rollRoundEvents, triggerUnpaidSalary,
} from '../src/engine/events';
import { processContractExpiry, respondToOffer } from '../src/engine/market';

// 第九波 #4：玩家战队负面事件另乘 CONFIG.humanEvents 倍数（降频与 TI 回合规则见 tests/eventRates.test.ts）。
// 本文件验证事件机制本身（概率 1 时必然触发），倍数置 1；TI 回合禁赛类结果为 0 的硬规则不受倍数影响。
const HUMAN_EVENTS_SAVED = { ...CONFIG.humanEvents };
beforeAll(() => {
  Object.assign(CONFIG.humanEvents, { negativeMult: 1, tiNegativeMult: 1 });
});
afterAll(() => {
  Object.assign(CONFIG.humanEvents, HUMAN_EVENTS_SAVED);
});

/** 把所有事件概率设为 0（再按需打开某一项） */
const ZERO = {
  matchFixingPerTeam: 0, aiMatchFixingPerTeam: 0, heartbreakPerPlayer: 0, scandalPerTeam: 0, beefPerRound: 0, hotStreakPerPlayer: 0,
  sponsorPerRound: 0, injuryPerPlayer: 0, streamDealPerRound: 0, fanMeetingPerRound: 0,
};

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

function validDecision(d: PendingDecision): void {
  expect(d.id).toBeTruthy();
  expect(d.title.length).toBeGreaterThan(0);
  expect(d.body.length).toBeGreaterThan(0);
  expect(d.choices.length).toBeGreaterThan(0);
  expect(new Set(d.choices.map((c) => c.id)).size).toBe(d.choices.length);
  expect(typeof d.blocking).toBe('boolean');
  for (const v of Object.values(d.ctx)) expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
}

function only(kind: keyof typeof ZERO, v = 1) {
  return { ...ZERO, [kind]: v };
}

describe('events · 回合事件', () => {
  it('概率全开：修正器、决策、beef 均合法', () => {
    const s = makeTestState(8);
    s.phase = 'regular';
    s.roundIndex = 2;
    const gold0 = s.teams.t0.gold;
    withConfig('events', { ...ZERO, heartbreakPerPlayer: 1, scandalPerTeam: 1, beefPerRound: 1, matchFixingPerTeam: 0.0 }, () => {
      rollRoundEvents(s);
    });
    for (const p of Object.values(s.players)) {
      for (const m of p.modifiers) {
        expect(m.attr).toBe('power');
        expect(m.kind).toBe('mul');
        expect(m.value).toBeGreaterThan(0);
        expect(m.value).toBeLessThan(1);
        expect(Number.isInteger(m.roundsLeft)).toBe(true);
        expect(m.roundsLeft!).toBeGreaterThanOrEqual(1);
      }
    }
    // 玩家每名队员都有情感受挫
    for (const id of s.teams.t0.playerIds) expect(s.players[id].modifiers.some((m) => m.source === '情感受挫')).toBe(true);
    const scandal = s.pendingDecisions.filter((d) => d.kind === 'scandal');
    expect(scandal).toHaveLength(1);
    scandal.forEach(validDecision);
    expect(s.beefs).toHaveLength(1);
    expect(s.beefs[0].teamId).not.toBe('t0');
    expect(s.beefs[0]).toMatchObject({ season: 9, winHonor: CONFIG.honor.beefWin, loseHonor: CONFIG.honor.beefLose });
    expect(s.teams.t0.gold).toBe(gold0);
    expect(s.news.length).toBeGreaterThan(0);
  });

  it('正面事件：状态火热 / 赞助 / 直播 / 见面会', () => {
    const s = makeTestState(3);
    const gold0 = s.teams.t0.gold;
    const honor0 = s.teams.t0.honor;
    withConfig('events', { ...ZERO, hotStreakPerPlayer: 1, sponsorPerRound: 1, streamDealPerRound: 1, fanMeetingPerRound: 1 }, () => {
      rollRoundEvents(s);
    });
    for (const id of s.teams.t0.playerIds) {
      const m = s.players[id].modifiers.find((x) => x.source === '状态火热')!;
      expect(m.value).toBeGreaterThan(1);
    }
    expect(s.teams.t0.gold).toBeGreaterThan(gold0);
    expect(s.teams.t0.honor).toBeGreaterThan(honor0);
    expect(s.finance.filter((f) => f.category === 'event').length).toBe(2);
  });

  it('beef 每赛季有上限且不重复', () => {
    const s = makeTestState(8);
    withConfig('events', only('beefPerRound'), () => {
      for (let i = 0; i < 6; i++) rollRoundEvents(s);
    });
    expect(s.beefs.length).toBe(CONFIG.events.beefMaxPerSeason);
    expect(new Set(s.beefs.map((b) => b.teamId)).size).toBe(s.beefs.length);
  });

  it('AI 假赛：禁赛并自动补员', () => {
    const s = makeTestState(4);
    withConfig('events', { ...ZERO, matchFixingPerTeam: 1, aiMatchFixingPerTeam: 1 }, () => rollRoundEvents(s));
    const banned = Object.values(s.players).filter((p) => p.status === 'banned');
    expect(banned.length).toBe(3); // 3 支 AI 各禁 1 人；玩家战队为决策，不直接禁赛
    expect(s.pendingDecisions.filter((d) => d.kind === 'match_fixing')).toHaveLength(1);
    for (const t of ['t1', 't2', 't3']) {
      const active = s.teams[t].playerIds.map((id) => s.players[id]).filter((p) => p.status === 'active');
      expect(active.length).toBe(5);
    }
  });
});

describe('events · 假赛（第六波）', () => {
  it('同一战队冷却期内不会再次发生假赛风波', () => {
    const s = makeTestState(4);
    withConfig('events', { ...ZERO, aiMatchFixingPerTeam: 1 }, () => rollRoundEvents(s));
    const first = Object.values(s.players).filter((p) => p.status === 'banned').length;
    expect(first).toBe(3);
    for (const t of ['t1', 't2', 't3']) expect(s.teams[t].lastMatchFixingSeason).toBe(s.season.ti);
    withConfig('events', { ...ZERO, aiMatchFixingPerTeam: 1 }, () => rollRoundEvents(s));
    expect(Object.values(s.players).filter((p) => p.status === 'banned').length).toBe(first);
    // 冷却期过后可再次发生
    s.season.ti += CONFIG.events.matchFixingCooldownSeasons;
    withConfig('events', { ...ZERO, aiMatchFixingPerTeam: 1 }, () => rollRoundEvents(s));
    expect(Object.values(s.players).filter((p) => p.status === 'banned').length).toBe(first + 3);
  });

  it('真实明星极少卷入：程序化低薪替补优先被抽中', () => {
    let starHits = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const s = makeTestState(2, 100 + i);
      // t1：4 名真实明星 + 1 名程序化选手
      const ids = s.teams.t1.playerIds;
      ids.forEach((id, k) => {
        const p = s.players[id];
        p.isReal = k < 4;
        p.mmr = k < 4 ? 12000 : 6000;
        p.loyalty = 60;
      });
      // 测试联盟只有 10 人：明星名单取前 4（即 t1 的 4 名真实明星与 t0 的部分选手）
      withConfig('events', { ...ZERO, aiMatchFixingPerTeam: 1, matchFixingStarTop: 4 }, () => rollRoundEvents(s));
      const banned = Object.values(s.players).find((p) => p.status === 'banned');
      if (banned?.isReal) starHits++;
    }
    expect(starHits / N).toBeLessThan(0.25);
  });

  it('荣誉缓冲：小俱乐部配合调查的扣分不超过当前荣誉的上限比例', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 100;
    withConfig('events', only('matchFixingPerTeam'), () => rollRoundEvents(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'match_fixing')!;
    const cap = Math.round(Math.max(CONFIG.honor.lossCushionFloor, 100) * CONFIG.events.matchFixingMaxHonorShare);
    resolveDecision(s, d.id, 'cooperate');
    expect(s.teams.t0.honor).toBe(100 - Math.min(-CONFIG.events.matchFixingHonorCooperate, cap));
    expect(s.teams.t0.honor).toBeGreaterThan(0);
    expect(s.gameOver).toBeFalsy();
  });
});

describe('events · 抉择', () => {
  it('假赛：配合调查 → 禁赛 + 扣分', () => {
    const s = makeTestState(3);
    // 玩家战队假赛：只对玩家队生效
    withConfig('events', only('matchFixingPerTeam'), () => rollRoundEvents(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'match_fixing')!;
    validDecision(d);
    const pid = d.ctx.playerId as string;
    const honor0 = s.teams.t0.honor;
    const r = resolveDecision(s, d.id, 'cooperate');
    expect(r.ok).toBe(true);
    expect(s.players[pid].status).toBe('banned');
    expect(s.players[pid].teamId).toBeNull();
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.events.matchFixingHonorCooperate);
    expect(s.pendingDecisions.find((x) => x.id === d.id)).toBeUndefined();
  });

  it('假赛：冷处理东窗事发 → 双倍扣分', () => {
    const s = makeTestState(2);
    s.teams.t0.honor = 1000;
    withConfig('events', only('matchFixingPerTeam'), () => rollRoundEvents(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'match_fixing')!;
    const pid = d.ctx.playerId as string;
    withConfig('events', { matchFixingLeakChance: 1 }, () => resolveDecision(s, d.id, 'cover_up'));
    expect(s.players[pid].status).toBe('active');
    expect(s.delayedEvents).toHaveLength(1);
    const honor0 = s.teams.t0.honor;
    s.roundIndex = s.delayedEvents![0].round;
    withConfig('events', ZERO, () => rollRoundEvents(s));
    expect(s.players[pid].status).toBe('banned');
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.events.matchFixingHonor * 2);
    expect(s.delayedEvents).toHaveLength(0);
  });

  it('丑闻：公关（资金不足保留决策）/ 低调', () => {
    const s = makeTestState(2);
    withConfig('events', only('scandalPerTeam'), () => rollRoundEvents(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'scandal')!;
    s.teams.t0.gold = 0;
    const r = resolveDecision(s, d.id, 'pr');
    expect(r.ok).toBe(false);
    expect(s.pendingDecisions).toContain(d);
    const honor0 = s.teams.t0.honor;
    expect(resolveDecision(s, d.id, 'ignore').ok).toBe(true);
    expect(s.teams.t0.honor).toBe(honor0 + (d.ctx.honor as number));
  });

  it('签证：NA 线下赛高风险选手被拒签 → 野外替补 / 替补顶上', () => {
    const s = makeTestState(2);
    s.phase = 'regular';
    const t = addTournament(s);
    withConfig('events', { visaPerPlayerNA: 1 }, () => checkVisaForTournament(s, t.id));
    const d = s.pendingDecisions.find((x) => x.kind === 'visa')!;
    validDecision(d);
    const hit = (d.ctx.playerIds as string).split(',');
    expect(hit.length).toBe(5);
    for (const id of hit) expect(s.players[id].unavailableTournamentIds).toContain(t.id);
    const r = resolveDecision(s, d.id, 'temp_sub');
    expect(r.ok).toBe(true);
    expect(s.tempSubCandidates.length).toBe(CONFIG.tempSub.candidates);
    expect(s.popups.some((p) => p.kind === 'message')).toBe(true);

    // 线上赛不触发
    const s2 = makeTestState(2);
    const t2 = addTournament(s2, { online: true });
    withConfig('events', { visaPerPlayerNA: 1 }, () => checkVisaForTournament(s2, t2.id));
    expect(s2.pendingDecisions).toHaveLength(0);

    // 用替补顶上但替补不足 → 自动生成候选
    const s3 = makeTestState(2);
    const t3 = addTournament(s3);
    withConfig('events', { visaPerPlayerNA: 1 }, () => checkVisaForTournament(s3, t3.id));
    const d3 = s3.pendingDecisions.find((x) => x.kind === 'visa')!;
    expect(resolveDecision(s3, d3.id, 'bench').message).toContain('临时替补');
  });

  it('签证：战队就在举办地赛区（主场作战）时，外籍队员也没有签证风险', () => {
    // 复现用户反馈：CIS 籍选手效力中国战队，赛事在上海 → 不应拒签
    const s = makeTestState(2);
    s.phase = 'regular';
    s.teams.t0.region = 'CN';
    for (const id of s.teams.t0.playerIds) {
      s.players[id].region = 'CIS';
      s.players[id].nationality = 'UA';
    }
    const t = addTournament(s, { hostRegion: 'CN', city: 'Shanghai' });
    withConfig('events', { visaPerPlayerNA: 1, visaPerPlayerOther: 1, visaNonRiskMult: 1 }, () => checkVisaForTournament(s, t.id));
    expect(s.pendingDecisions.filter((d) => d.kind === 'visa')).toHaveLength(0);
    for (const id of s.teams.t0.playerIds) expect(s.players[id].unavailableTournamentIds ?? []).not.toContain(t.id);

    // 同一批外籍队员客场出征（战队不在举办地赛区）时仍可能被拒签
    const s2 = makeTestState(2);
    s2.phase = 'regular';
    s2.teams.t0.region = 'EU';
    for (const id of s2.teams.t0.playerIds) s2.players[id].region = 'CIS';
    const t2 = addTournament(s2, { hostRegion: 'CN', city: 'Shanghai' });
    withConfig('events', { visaPerPlayerNA: 1, visaPerPlayerOther: 1, visaNonRiskMult: 1 }, () => checkVisaForTournament(s2, t2.id));
    expect(s2.pendingDecisions.some((d) => d.kind === 'visa')).toBe(true);
  });

  it('离队申请：放行 / 加薪 / 挽留', () => {
    const s = makeTestState(3);
    s.phase = 'regular';
    for (const id of s.teams.t0.playerIds) s.players[id].loyalty = 5;
    withConfig('loyalty', { leaveChancePerRound: 1 }, () => processLoyaltyDepartures(s));
    const reqs = s.pendingDecisions.filter((d) => d.kind === 'leave_request');
    expect(reqs).toHaveLength(5);
    reqs.forEach(validDecision);
    // 不重复生成
    withConfig('loyalty', { leaveChancePerRound: 1 }, () => processLoyaltyDepartures(s));
    expect(s.pendingDecisions.filter((d) => d.kind === 'leave_request')).toHaveLength(5);

    const [a, b, c] = reqs;
    const pa = s.players[a.ctx.playerId as string];
    resolveDecision(s, a.id, 'allow');
    expect(pa.teamId).toBeNull();

    const pb = s.players[b.ctx.playerId as string];
    const sal = pb.salary;
    resolveDecision(s, b.id, 'raise');
    expect(pb.salary).toBe(Math.round(sal * CONFIG.events.leaveRaiseSalaryMult));
    expect(pb.loyalty).toBe(5 + CONFIG.events.leaveRaiseLoyalty);

    const pc = s.players[c.ctx.playerId as string];
    const r = resolveDecision(s, c.id, 'persuade');
    expect(r.ok).toBe(true);
    if (pc.teamId) expect(pc.loyalty).toBe(5 + CONFIG.events.leavePersuadeLoyalty);
    else expect(pc.teamId).toBeNull();
  });

  it('挖角：生成报价与决策，接受后选手转会', () => {
    const s = makeTestState(4);
    s.phase = 'regular';
    for (const t of ['t1', 't2', 't3']) s.teams[t].gold = 50_000_000;
    const p = s.players['t0-SS'];
    p.loyalty = 5;
    withConfig('loyalty', { leaveChancePerRound: 0, poachChancePerRound: 1 }, () => processLoyaltyDepartures(s));
    const d = s.pendingDecisions.find((x) => x.kind === 'poach')!;
    validDecision(d);
    const offer = s.transferOffers.find((o) => o.id === d.ctx.offerId)!;
    expect(offer.poach).toBe(true);
    const gold0 = s.teams.t0.gold;
    expect(resolveDecision(s, d.id, 'accept').ok).toBe(true);
    expect(p.teamId).toBe(offer.fromTeamId);
    expect(s.teams.t0.gold).toBe(gold0 + offer.fee);
    expect(s.pendingDecisions.find((x) => x.kind === 'poach')).toBeUndefined();
  });

  it('合同：续约 / 放走', () => {
    const s = makeTestState(2);
    s.teams.t0.playerIds.forEach((id) => (s.players[id].contractUntil = 9));
    processContractExpiry(s);
    const ds = s.pendingDecisions.filter((d) => d.kind === 'contract');
    const p0 = s.players[ds[0].ctx.playerId as string];
    expect(resolveDecision(s, ds[0].id, 'renew_2').ok).toBe(true);
    expect(p0.contractUntil).toBe(11);
    const p1 = s.players[ds[1].ctx.playerId as string];
    resolveDecision(s, ds[1].id, 'release');
    expect(p1.teamId).toBeNull();
    // 归属感极低 → 拒绝续约并离队
    const p2 = s.players[ds[2].ctx.playerId as string];
    p2.loyalty = 0;
    const r = resolveDecision(s, ds[2].id, 'renew_1');
    expect(r.ok).toBe(true);
    expect(p2.teamId).toBeNull();
  });

  it('退役转教练：免费上任并替换现任', () => {
    const s = makeTestState(2);
    const old = makeCoach({ teamId: 't0' });
    s.coaches[old.id] = old;
    s.teams.t0.coachId = old.id;
    const retired = makeCoach({ formerPlayerId: 't0-C', name: 'Legend' });
    s.coaches[retired.id] = retired;
    const gold0 = s.teams.t0.gold;
    s.pendingDecisions.push({
      id: 'd-retire', kind: 'retire', title: '退役', body: '…',
      choices: [{ id: 'hire_as_coach', label: '聘为教练' }, { id: 'decline', label: '婉拒' }],
      ctx: { playerId: 't0-C' }, createdRound: 0, blocking: true,
    });
    expect(resolveDecision(s, 'd-retire', 'hire_as_coach').ok).toBe(true);
    expect(s.teams.t0.coachId).toBe(retired.id);
    expect(retired.teamId).toBe('t0');
    expect(old.teamId).toBeNull();
    expect(s.teams.t0.gold).toBe(gold0);
  });

  it('欠薪：扣荣誉、降归属感、非阻塞通知', () => {
    const s = makeTestState(2);
    const honor0 = s.teams.t0.honor;
    triggerUnpaidSalary(s);
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.events.unpaidHonor);
    for (const id of s.teams.t0.playerIds) expect(s.players[id].loyalty).toBe(70 + CONFIG.loyalty.unpaidSalary);
    const d = s.pendingDecisions.find((x) => x.kind === 'unpaid_salary')!;
    expect(d.blocking).toBe(false);
    expect(resolveDecision(s, d.id, 'ack').ok).toBe(true);
    expect(s.pendingDecisions).toHaveLength(0);
  });

  it('未知 / 失效 / 趣味事件的容错', () => {
    const s = makeTestState(2);
    expect(resolveDecision(s, 'missing', 'x').ok).toBe(false);
    s.pendingDecisions.push({
      id: 'd1', kind: 'other', title: 't', body: 'b', choices: [{ id: 'a', label: 'A' }], ctx: {}, createdRound: 0, blocking: true,
    });
    expect(resolveDecision(s, 'd1', 'zzz').ok).toBe(false);
    expect(resolveDecision(s, 'd1', 'a').ok).toBe(true);
    expect(s.pendingDecisions).toHaveLength(0);
    // 选手已离队的离队申请
    s.pendingDecisions.push({
      id: 'd2', kind: 'leave_request', title: 't', body: 'b', choices: [{ id: 'allow', label: 'A' }],
      ctx: { playerId: 'ghost' }, createdRound: 0, blocking: true,
    });
    expect(resolveDecision(s, 'd2', 'allow').ok).toBe(true);
    expect(s.pendingDecisions).toHaveLength(0);
    // 失效报价的挖角
    s.pendingDecisions.push({
      id: 'd3', kind: 'poach', title: 't', body: 'b', choices: [{ id: 'accept', label: 'A' }],
      ctx: { offerId: 'nope' }, createdRound: 0, blocking: true,
    });
    expect(resolveDecision(s, 'd3', 'accept').ok).toBe(true);
    // 趣味事件转交 funEvents
    s.pendingDecisions.push({
      id: 'd4', kind: 'other', title: 't', body: 'b', choices: [{ id: 'x', label: 'X' }],
      ctx: { fun: 'teeth' }, createdRound: 0, blocking: true,
    });
    expect(resolveDecision(s, 'd4', 'x').message).toBe('fun');
    expect(s.pendingDecisions).toHaveLength(0);
  });

  it('趣味事件：无效选项不转交、不移除；有效选项原样转交 funEvents', () => {
    const s = makeTestState(2);
    s.pendingDecisions.push({
      id: 'f1', kind: 'other', title: 't', body: 'b', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      ctx: { fun: 'some_event', playerId: s.teams.t0.playerIds[0] }, createdRound: 0, blocking: true,
    });
    const before = funCalls.resolved.length;
    const bad = resolveDecision(s, 'f1', 'nope');
    expect(bad.ok).toBe(false);
    expect(s.pendingDecisions.map((d) => d.id)).toEqual(['f1']);
    expect(funCalls.resolved.length).toBe(before);
    expect(resolveDecision(s, 'f1', 'b').message).toBe('fun');
    expect(funCalls.resolved.slice(before)).toEqual([{ decisionId: 'f1', choiceId: 'b' }]);
    expect(s.pendingDecisions).toHaveLength(0);
  });
});

describe('events · 每个回合开始都滚动全部事件', () => {
  const PHASES = [
    { phase: 'preseason', round: 0 },
    { phase: 'regular', round: 3 },
    { phase: 'ti_qualifier', round: 19 },
    { phase: 'ti', round: 20 },
  ] as const;

  it('任意阶段（含赛季初回合 0、TI 预选、TI）都会调用 rollFunEvents', () => {
    for (const { phase, round } of PHASES) {
      const s = makeTestState(4);
      s.phase = phase;
      s.roundIndex = round;
      const n0 = funCalls.roll;
      withConfig('events', ZERO, () => rollRoundEvents(s));
      expect(funCalls.roll).toBe(n0 + 1);
    }
    // 游戏已结束也照常调用（由 funEvents 自行跳过）
    const s = makeTestState(2);
    s.gameOver = { reason: 'completed', summary: 'x' };
    const n0 = funCalls.roll;
    rollRoundEvents(s);
    expect(funCalls.roll).toBe(n0 + 1);
  });

  it('任意阶段都可能触发常规事件（无阶段限制）', () => {
    for (const { phase, round } of PHASES) {
      const s = makeTestState(4);
      s.phase = phase;
      s.roundIndex = round;
      const gold0 = s.teams.t0.gold;
      withConfig('events', { ...ZERO, heartbreakPerPlayer: 1, sponsorPerRound: 1, beefPerRound: 1 }, () => rollRoundEvents(s));
      expect(s.players[s.teams.t0.playerIds[0]].modifiers.some((m) => m.source === '情感受挫')).toBe(true);
      expect(s.teams.t0.gold).toBeGreaterThan(gold0);
      expect(s.beefs.length).toBeGreaterThan(0);
    }
  });

  it('选手被卖出后，其离队申请/续约决策一并清除', () => {
    const s = makeTestState(4);
    s.phase = 'regular';
    s.roundIndex = 2;
    const pid = s.teams.t0.playerIds[1];
    s.players[pid].loyalty = 5;
    withConfig('loyalty', { leaveChancePerRound: 1 }, () => processLoyaltyDepartures(s));
    expect(s.pendingDecisions.some((d) => d.kind === 'leave_request' && d.ctx.playerId === pid)).toBe(true);
    s.teams.t1.gold = 1e9;
    s.transferOffers.push({
      id: 'of-x', playerId: pid, fromTeamId: 't1', toTeamId: 't0', fee: 100000, salary: 9000, status: 'pending',
      createdRound: 2, expiresRound: 4, season: s.season.ti,
    });
    expect(respondToOffer(s, 'of-x', true).ok).toBe(true);
    expect(s.players[pid].teamId).toBe('t1');
    expect(s.pendingDecisions.some((d) => d.ctx.playerId === pid)).toBe(false);
  });
});
