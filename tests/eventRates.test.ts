// 第九波 #4：玩家战队负面事件降频（events.ts / scandal.ts，CONFIG.humanEvents）
// - 人类战队（单机 + 多人每个座位）负面事件整体 × negativeMult；TI 预选 / 正赛回合再 × tiNegativeMult；
// - TI 预选 / 正赛回合禁赛类结果概率为 0：不触发假赛风波、到期的「假赛调查结果公开」顺延、全员假赛不计划也不曝光；
// - AI 战队不变。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, SeasonPhase, Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import {
  checkVisaForTournament, humanBanAllowed, humanNegativeEventMult, isTiEventRound, resolveDecision, rollGlobalRoundEvents,
  rollRoundEvents, rollSeatRoundEvents,
} from '../src/engine/events';
import {
  advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, getAdvanceBlockers, quickSimTournament,
} from '../src/engine/game';
import { banClub, fireDueClubScandals, rollClubScandals } from '../src/engine/scandal';
import { buildRounds, seasonStartDate, tiDates } from '../src/engine/calendar';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import * as M from '../src/engine/multi';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 全部事件概率置 0（再按需打开） */
const ZERO = {
  matchFixingPerTeam: 0, aiMatchFixingPerTeam: 0, heartbreakPerPlayer: 0, scandalPerTeam: 0, beefPerRound: 0, hotStreakPerPlayer: 0,
  sponsorPerRound: 0, injuryPerPlayer: 0, streamDealPerRound: 0, fanMeetingPerRound: 0,
};
/** 抬高的负面事件基础概率（统计检验用） */
const HOT = { ...ZERO, heartbreakPerPlayer: 0.2, injuryPerPlayer: 0.2, scandalPerTeam: 0.2, beefPerRound: 0.2, matchFixingPerTeam: 0.2 };
const ROUND_OF: Record<string, number> = { preseason: 0, regular: 5, ti_qualifier: 19, ti: 20 };

interface Counts {
  rolls: number;
  playerRolls: number;
  heartbreak: number;
  injury: number;
  scandal: number;
  beef: number;
  fixing: number;
  banned: number;
  aiHeartbreak: number;
  aiPlayerRolls: number;
}

/**
 * 在同一状态上重复滚动 n 次回合事件（单机路径 rollRoundEvents），每次之前清空上一次的结果，使每次都是独立机会。
 */
function rollMany(phase: SeasonPhase, n: number, events: Record<string, number>, seed = 2024): Counts {
  const s = makeTestState(2, seed);
  s.phase = phase;
  s.roundIndex = ROUND_OF[phase] ?? 0;
  const me = s.teams.t0;
  const ai = s.teams.t1;
  const c: Counts = { rolls: 0, playerRolls: 0, heartbreak: 0, injury: 0, scandal: 0, beef: 0, fixing: 0, banned: 0, aiHeartbreak: 0, aiPlayerRolls: 0 };
  withConfig('events', events, () => {
    for (let i = 0; i < n; i++) {
      for (const p of Object.values(s.players)) p.modifiers = [];
      s.pendingDecisions = [];
      s.beefs = [];
      s.news = [];
      delete me.lastMatchFixingSeason;
      rollRoundEvents(s);
      const roster = me.playerIds.map((id) => s.players[id]);
      c.rolls++;
      c.playerRolls += roster.length;
      for (const p of roster) {
        if (p.modifiers.some((m) => m.source === '情感受挫')) c.heartbreak++;
        if (p.modifiers.some((m) => m.source === '伤病')) c.injury++;
      }
      c.scandal += s.pendingDecisions.filter((d) => d.kind === 'scandal').length;
      c.fixing += s.pendingDecisions.filter((d) => d.kind === 'match_fixing').length;
      c.beef += s.beefs.length;
      for (const id of ai.playerIds) {
        c.aiPlayerRolls++;
        if (s.players[id].modifiers.some((m) => m.source === '情感受挫')) c.aiHeartbreak++;
      }
    }
  });
  c.banned = Object.values(s.players).filter((p) => p.status === 'banned' && p.lastTeamId === 't0').length;
  return c;
}

const rate = (k: number, n: number) => k / Math.max(1, n);

describe('eventRates · 倍数与 TI 回合判定', () => {
  it('isTiEventRound / humanNegativeEventMult / humanBanAllowed', () => {
    const s = makeTestState(2);
    const h = CONFIG.humanEvents;
    for (const phase of ['preseason', 'regular'] as const) {
      s.phase = phase;
      expect(isTiEventRound(s)).toBe(false);
      expect(humanBanAllowed(s)).toBe(true);
      expect(humanNegativeEventMult(s)).toBeCloseTo(h.negativeMult, 10);
    }
    for (const phase of ['ti_qualifier', 'ti'] as const) {
      s.phase = phase;
      expect(isTiEventRound(s)).toBe(true);
      expect(humanBanAllowed(s)).toBe(false);
      expect(humanNegativeEventMult(s)).toBeCloseTo(h.negativeMult * h.tiNegativeMult, 10);
    }
    // 默认值：整体降低、TI 大幅降低
    expect(h.negativeMult).toBeLessThan(1);
    expect(h.negativeMult * h.tiNegativeMult).toBeLessThanOrEqual(0.25);
  });
});

describe('eventRates · 人类战队负面事件降频（统计）', () => {
  const N = 3000;

  it('常规回合：负面事件频率 ≈ 基础概率 × negativeMult（对照组 × 1）', () => {
    const after = rollMany('regular', N, HOT);
    const before = withConfig('humanEvents', { negativeMult: 1, tiNegativeMult: 1 }, () => rollMany('regular', N, HOT));
    const m = CONFIG.humanEvents.negativeMult;
    // 每名选手每回合：情感受挫 / 伤病
    expect(rate(after.heartbreak, after.playerRolls)).toBeGreaterThan(0.2 * m - 0.015);
    expect(rate(after.heartbreak, after.playerRolls)).toBeLessThan(0.2 * m + 0.015);
    expect(rate(after.injury, after.playerRolls)).toBeGreaterThan(0.2 * m - 0.015);
    expect(rate(after.injury, after.playerRolls)).toBeLessThan(0.2 * m + 0.015);
    expect(rate(before.heartbreak, before.playerRolls)).toBeGreaterThan(0.2 - 0.015);
    expect(rate(before.heartbreak, before.playerRolls)).toBeLessThan(0.2 + 0.015);
    // 每队每回合：丑闻 / beef / 假赛风波
    for (const k of ['scandal', 'beef', 'fixing'] as const) {
      expect(rate(after[k], after.rolls)).toBeGreaterThan(0.2 * m - 0.03);
      expect(rate(after[k], after.rolls)).toBeLessThan(0.2 * m + 0.03);
      expect(rate(before[k], before.rolls)).toBeGreaterThan(0.2 - 0.03);
    }
    const total = (c: Counts) => c.heartbreak + c.injury + c.scandal + c.beef + c.fixing;
    expect(total(after) / total(before)).toBeGreaterThan(m - 0.06);
    expect(total(after) / total(before)).toBeLessThan(m + 0.06);
  });

  it('TI 预选 / TI 正赛回合：负面事件大幅降低（× negativeMult × tiNegativeMult），假赛风波为 0', () => {
    const h = CONFIG.humanEvents;
    const target = 0.2 * h.negativeMult * h.tiNegativeMult;
    for (const phase of ['ti_qualifier', 'ti'] as const) {
      const c = rollMany(phase, N, HOT, phase === 'ti' ? 77 : 78);
      expect(rate(c.heartbreak, c.playerRolls)).toBeGreaterThan(target - 0.01);
      expect(rate(c.heartbreak, c.playerRolls)).toBeLessThan(target + 0.01);
      expect(rate(c.injury, c.playerRolls)).toBeLessThan(target + 0.01);
      expect(rate(c.scandal, c.rolls)).toBeLessThan(target + 0.02);
      expect(rate(c.beef, c.rolls)).toBeLessThan(target + 0.02);
      expect(c.fixing).toBe(0);
      expect(c.banned).toBe(0);
    }
  });

  it('签证问题：常规回合拒签率 ≈ 基础 × negativeMult；TI 正赛回合（北美线下）拒签为 0（缺阵类结果，第九波 QA）', () => {
    const h = CONFIG.humanEvents;
    const visaRate = (phase: SeasonPhase, roundIndex: number) => {
      let hits = 0;
      let trials = 0;
      for (let i = 0; i < 600; i++) {
        const s = makeTestState(2, 900 + i);
        s.phase = phase;
        s.roundIndex = roundIndex;
        const t: Tournament = {
          id: `ti-${i}`, seriesId: 'ti', name: 'The International', tier: 'ti', season: 9, roundIndex, startDate: '2019-08-15',
          city: 'Seattle', hostRegion: 'NA', online: false, prizePool: 1000000, appearanceFee: 0, format: 'de8',
          teamIds: ['t0', 't1'], invitedTeamIds: [], qualifierTeamIds: [], stages: [], series: {}, status: 'running',
          placements: [], playerStatus: 'invited', minHonor: 0,
        };
        s.tournaments[t.id] = t;
        withConfig('events', { visaPerPlayerNA: 1 }, () => checkVisaForTournament(s, t.id));
        trials += s.teams.t0.playerIds.length; // 全部 CN 选手（高风险赛区）
        hits += s.teams.t0.playerIds.filter((id) => s.players[id].unavailableTournamentIds?.includes(t.id)).length;
      }
      return rate(hits, trials);
    };
    expect(visaRate('ti', 20)).toBe(0);
    expect(visaRate('ti_qualifier', 19)).toBe(0);
    const regular = visaRate('regular', 5);
    expect(regular).toBeGreaterThan(h.negativeMult - 0.05);
    expect(regular).toBeLessThan(h.negativeMult + 0.05);
  });
});

describe('eventRates · TI 回合禁赛类结果恰为 0', () => {
  it('假赛风波概率拉满（1）：TI 预选 / 正赛回合多次滚动仍为 0（常规回合对照组会触发）', () => {
    const maxed = { ...ZERO, matchFixingPerTeam: 1 };
    for (const phase of ['ti_qualifier', 'ti'] as const) {
      const c = withConfig('humanEvents', { negativeMult: 1, tiNegativeMult: 1 }, () => rollMany(phase, 2000, maxed, 5));
      expect(c.fixing).toBe(0);
      expect(c.banned).toBe(0);
    }
    const control = withConfig('humanEvents', { negativeMult: 1, tiNegativeMult: 1 }, () => rollMany('regular', 50, maxed, 5));
    expect(control.fixing).toBe(50);
  });

  it('冷处理后的「假赛调查结果公开」到期落在 TI 回合：顺延到 TI 之后（下赛季首回合）才禁赛', () => {
    const s = makeTestState(2);
    const pid = s.teams.t0.playerIds[0];
    s.delayedEvents = [{ id: 'de-1', kind: 'match_fixing', season: 9, round: 18, ctx: { playerId: pid, teamId: 't0', handle: 'X' } }];
    withConfig('events', ZERO, () => {
      for (const [phase, round] of [['ti_qualifier', 19], ['ti', 20]] as const) {
        s.phase = phase;
        s.roundIndex = round;
        rollRoundEvents(s);
        expect(s.players[pid].status).toBe('active');
        expect(s.delayedEvents).toHaveLength(1);
      }
      // 下赛季回合 0
      s.season.ti = 10;
      s.season.year = 2021;
      s.phase = 'preseason';
      s.roundIndex = 0;
      rollRoundEvents(s);
    });
    expect(s.players[pid].status).toBe('banned');
    expect(s.delayedEvents).toHaveLength(0);
  });

  function realSeason(s: GameState, ti = 9): void {
    const { startDate, endDate } = tiDates(ti);
    s.season.rounds = buildRounds(ti, seasonStartDate(ti), startDate, endDate);
  }

  it('全员假赛：只计划在常规赛回合；TI 预选 / 正赛回合不曝光', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = makeTestState(6, seed);
      s.id = `club-${seed}`;
      realSeason(s);
      const plans = withConfig('scandal', { clubBanChancePerSeason: 1 }, () => rollClubScandals(s));
      expect(plans.length).toBe(6);
      for (const p of plans) expect(s.season.rounds[p.round]?.phase).toBe('regular');
    }
    const s = makeTestState(4);
    realSeason(s);
    const tiQ = s.season.rounds.find((r) => r.phase === 'ti_qualifier')!.index;
    const tiR = s.season.rounds.find((r) => r.phase === 'ti')!.index;
    s.clubScandals = { plans: [{ teamId: 't1', season: 9, round: 2 }, { teamId: 't0', season: 9, round: 1 }], history: [] };
    for (const [phase, idx] of [['ti_qualifier', tiQ], ['ti', tiR]] as const) {
      s.phase = phase;
      s.roundIndex = idx;
      expect(fireDueClubScandals(s, idx)).toEqual([]);
      expect(s.teams.t0.banned).toBeUndefined();
      expect(s.gameOver).toBeNull();
    }
    // 对照：常规赛回合照常曝光（AI 与玩家；玩家俱乐部曝光即游戏结束，故 AI 计划排在前面）
    s.phase = 'regular';
    s.roundIndex = 3;
    const fired = fireDueClubScandals(s, 3);
    expect(fired.map((r) => r.teamId).sort()).toEqual(['t0', 't1']);
    expect(s.gameOver?.reason).toBe('banned');
  });

  it('人类俱乐部的全员假赛概率倍数 clubBanMult 只作用于人类战队（默认 1 = 用户确认的 0.1%）', () => {
    expect(CONFIG.humanEvents.clubBanMult).toBe(1);
    expect(CONFIG.scandal.clubBanChancePerSeason).toBe(0.001);
    const s = makeTestState(5);
    realSeason(s);
    const plans = withConfig('scandal', { clubBanChancePerSeason: 1 }, () =>
      withConfig('humanEvents', { clubBanMult: 0 }, () => rollClubScandals(s)));
    expect(plans.map((p) => p.teamId).sort()).toEqual(['t1', 't2', 't3', 't4']);
    // banClub 本身（测试 / 曝光入口）不受影响
    expect(banClub(s, 't2')?.teamId).toBe('t2');
  });
});

describe('eventRates · 端到端（单机真实回合流程 enterRound → 回合事件）', () => {
  /** 推进一回合：先处理阻塞（决策选第一项 / 补齐首发 / 快速模拟本回合赛事） */
  function step(g: GameState): void {
    for (let guard = 0; guard < 8; guard++) {
      for (const d of g.pendingDecisions.slice()) {
        if (!d.blocking) continue;
        resolveDecision(g, d.id, d.choices[0]?.id ?? 'ack');
        g.pendingDecisions = g.pendingDecisions.filter((x) => x.id !== d.id);
      }
      if (currentPlayerTournament(g)) {
        fillLineupWithTempSubs(g);
        quickSimTournament(g);
      }
      if (advance(g).ok || g.gameOver) return;
    }
    throw new Error(`推进卡住：TI${g.season.ti} 第 ${g.roundIndex} 回合 ${getAdvanceBlockers(g).map((b) => b.code).join(',')}`);
  }

  it('假赛风波概率拉满、冷却为 0：TI 预选 / 正赛回合不出现假赛风波与禁赛，到期的调查公开顺延到下赛季首回合', async () => {
    const g = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 77,
      newClub: { name: 'Fair Play', tag: 'FPL', region: 'EU', color: '#3a7bd5' },
    });
    const me = g.settings.playerTeamId;
    const tiQ = g.season.rounds.find((r) => r.phase === 'ti_qualifier')!.index;
    // 常规赛期间关闭全部事件，推进到最后一个常规赛回合
    withConfig('events', ZERO, () => {
      for (let guard = 0; guard < 60 && g.roundIndex < tiQ - 1; guard++) step(g);
    });
    expect(g.roundIndex).toBe(tiQ - 1);
    expect(g.phase).toBe('regular');
    // 冷处理留下的「假赛调查结果公开」恰好在 TI 预选回合到期
    const pid = g.teams[me].playerIds.find((id) => !g.players[id].tempSubUntilTournament)!;
    g.delayedEvents = [{ id: 'de-e2e', kind: 'match_fixing', season: g.season.ti, round: tiQ, ctx: { playerId: pid, teamId: me, handle: g.players[pid].handle } }];
    const bannedMine = () => Object.values(g.players).filter((p) => p.status === 'banned' && p.lastTeamId === me).length;
    withConfig('humanEvents', { negativeMult: 1, tiNegativeMult: 1 }, () =>
      withConfig('events', { ...ZERO, matchFixingPerTeam: 1, matchFixingCooldownSeasons: 0 }, () => {
        for (const phase of ['ti_qualifier', 'ti'] as const) {
          step(g);
          expect(g.phase).toBe(phase);
          expect(g.pendingDecisions.some((d) => d.kind === 'match_fixing')).toBe(false);
          expect(bannedMine()).toBe(0);
          expect(g.players[pid].status).toBe('active');
          expect(g.delayedEvents?.map((d) => d.id)).toEqual(['de-e2e']);
          expect(g.clubScandals?.plans ?? []).toEqual([]);
        }
        // TI 结束 → 下赛季回合 0：调查结果公开（禁赛），常规流程照常恢复
        step(g);
      }));
    expect(g.season.ti).toBe(10);
    expect(g.roundIndex).toBe(0);
    expect(g.players[pid].status).toBe('banned');
    expect(g.delayedEvents ?? []).toHaveLength(0);
  });
});

describe('eventRates · AI 战队不变', () => {
  it('AI 事件与 humanEvents 倍数无关（含 TI 回合；AI 假赛在 TI 回合照常发生）', () => {
    const run = (cfg: Record<string, number>) => {
      const s = makeTestState(6, 4321);
      s.phase = 'ti';
      s.roundIndex = 20;
      withConfig('humanEvents', cfg, () =>
        withConfig('events', { ...ZERO, aiMatchFixingPerTeam: 1, heartbreakPerPlayer: 0.3, scandalPerTeam: 0.5 }, () => rollGlobalRoundEvents(s)));
      return Object.values(s.teams).filter((t) => !t.isPlayer).map((t) => ({
        id: t.id,
        honor: t.honor,
        players: t.playerIds.map((id) => ({ id, status: s.players[id].status, mods: s.players[id].modifiers.map((m) => [m.source, m.value]) })),
        banned: Object.values(s.players).filter((p) => p.status === 'banned' && p.lastTeamId === t.id).length,
      }));
    };
    const a = run({ negativeMult: 0.7, tiNegativeMult: 0.25 });
    const b = run({ negativeMult: 1, tiNegativeMult: 1 });
    const c = run({ negativeMult: 0, tiNegativeMult: 0 });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.reduce((n, t) => n + t.banned, 0)).toBe(5);
  });

  it('单机路径统计：TI 回合 AI 选手的情感受挫频率 ≈ 基础概率（不降频）', () => {
    const c = rollMany('ti', 3000, { ...ZERO, heartbreakPerPlayer: 0.2 }, 99);
    expect(rate(c.aiHeartbreak, c.aiPlayerRolls)).toBeGreaterThan(0.2 - 0.015);
    expect(rate(c.aiHeartbreak, c.aiPlayerRolls)).toBeLessThan(0.2 + 0.015);
    expect(rate(c.heartbreak, c.playerRolls)).toBeLessThan(0.2 * CONFIG.humanEvents.negativeMult * CONFIG.humanEvents.tiNegativeMult + 0.01);
  });
});

describe('eventRates · 多人模式每个座位', () => {
  it('每个座位：常规回合按倍数降频；TI 回合假赛风波恰为 0', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 31,
      players: [
        { sessionId: 's0', name: '玩家1', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '玩家2', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
        { sessionId: 's2', name: '玩家3', newClub: { name: 'Gamma Club', tag: 'GAM', region: 'SEA', color: '#d4a017' } },
      ],
    });
    const seats = g.multiplayer!.order;
    expect(seats).toHaveLength(3);
    const fixingIn = (phase: SeasonPhase, rolls: number) => {
      g.phase = phase;
      let n = 0;
      withConfig('humanEvents', { negativeMult: 1, tiNegativeMult: 1 }, () => withConfig('events', { ...ZERO, matchFixingPerTeam: 1 }, () => {
        for (let i = 0; i < rolls; i++) {
          for (const id of seats) {
            M.withSeat(g, id, () => {
              g.pendingDecisions = g.pendingDecisions.filter((d) => d.kind !== 'match_fixing');
              delete g.teams[id].lastMatchFixingSeason;
              rollSeatRoundEvents(g);
              n += g.pendingDecisions.filter((d) => d.kind === 'match_fixing').length;
            });
          }
        }
      }));
      return n;
    };
    expect(fixingIn('ti_qualifier', 300)).toBe(0);
    expect(fixingIn('ti', 300)).toBe(0);
    expect(fixingIn('regular', 5)).toBe(15);
    // 常规回合：每个座位的情感受挫按 negativeMult 降频
    g.phase = 'regular';
    let hits = 0;
    let trials = 0;
    withConfig('events', { ...ZERO, heartbreakPerPlayer: 0.5 }, () => {
      for (let i = 0; i < 400; i++) {
        for (const id of seats) {
          M.withSeat(g, id, () => {
            const roster = g.teams[id].playerIds.map((pid) => g.players[pid]).filter((p) => !p.tempSubUntilTournament);
            for (const p of roster) p.modifiers = p.modifiers.filter((m) => m.source !== '情感受挫');
            rollSeatRoundEvents(g);
            trials += roster.length;
            hits += roster.filter((p) => p.modifiers.some((m) => m.source === '情感受挫')).length;
          });
        }
      }
    });
    const target = 0.5 * CONFIG.humanEvents.negativeMult;
    expect(rate(hits, trials)).toBeGreaterThan(target - 0.03);
    expect(rate(hits, trials)).toBeLessThan(target + 0.03);
  });
});
