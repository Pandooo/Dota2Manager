// 训练赛规则（用户反馈 2026-10-10）：每支对手每回合只能约 1 次（Team.scrimBookings，回合结束清除；多人按座位战队隔离）、
// 训练赛倍数下限 > 1（约弱队也比普通训练强）且对手越强越高、训练赛灵性额外加成（交流 BP）
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, TrainingGain } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import * as M from '../src/engine/multi';
import { advance, createNewGame, doScrim, doTraining, getAdvanceBlockers, trainingBlockReason } from '../src/engine/game';
import { scrimCost } from '../src/engine/economy';
import { scrimInsightMult, scrimMultiplier, scrimTrainOptions, sessionTrainOptions, trainTeam } from '../src/engine/growth';
import { bookScrim, clearScrimBookings, isScrimBooked, scrimBookedIds, trainingRecords } from '../src/engine/trainingLog';
import { resolveDecision } from '../src/engine/events';
import { unregisterFromTournament } from '../src/engine/schedule';
import { buildRounds, seasonStartDate, tiDates } from '../src/engine/calendar';
import { SEAT_TOP_KEYS } from '../src/engine/seat';
import { makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 测试夹具：常规赛休赛回合（无赛事），t0 为玩家战队，t0..t(n-1) 战力 70..70+n-1 */
function restState(teams = 6, roundIndex = 2): GameState {
  const state = makeTestState(teams);
  const start = seasonStartDate(9);
  const { startDate, endDate } = tiDates(9);
  state.season = { ...state.season, startDate: start, tiStartDate: startDate, rounds: buildRounds(9, start, startDate, endDate) };
  state.phase = 'regular';
  state.roundIndex = roundIndex;
  state.currentDate = state.season.rounds[roundIndex].startDate;
  state.teams.t0.gold = 10_000_000;
  state.extraTrainingAvailable = CONFIG.training.maxExtraPerRound; // 1 免费 + 3 已购
  return state;
}

const clone = (s: GameState): GameState => JSON.parse(JSON.stringify(s)) as GameState;
const sum = (gains: TrainingGain[] | undefined, k: 'power' | 'mmr' | 'insight') => (gains ?? []).reduce((a, g) => a + g[k], 0);

// ---------------------------------------------------------------------------
// 每支对手每回合限约 1 次
// ---------------------------------------------------------------------------
describe('scrim · 每支对手每回合只能约 1 次', () => {
  it('同一回合重复约同一支对手被拒（不扣钱、不耗次数），换对手可以', () => {
    const s = restState();
    expect(trainingBlockReason(s)).toBeNull();
    expect(CONFIG.training.scrimPerOpponentPerRound).toBe(1);
    const r1 = doScrim(s, 't3');
    expect(r1.ok).toBe(true);
    expect(isScrimBooked(s, 't3')).toBe(true);
    expect(isScrimBooked(s, 't2')).toBe(false);

    const gold = s.teams.t0.gold;
    const avail = s.extraTrainingAvailable;
    const rec = trainingRecords(s).length;
    const r2 = doScrim(s, 't3');
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('本回合已与');
    expect(r2.message).toContain('只能约练 1 次');
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.extraTrainingAvailable).toBe(avail);
    expect(trainingRecords(s).length).toBe(rec);

    expect(doScrim(s, 't2').ok).toBe(true);
    expect(doScrim(s, 't5').ok).toBe(true);
    expect(scrimBookedIds(s)).toEqual(['t3', 't2', 't5']);
    expect(s.teams.t0.scrimBookings?.key).toBe(9 * 100 + 2);
    // 普通训练不受影响
    expect(doTraining(s).ok).toBe(true);
  });

  it('下一回合重置：回合键不同的旧记录视为空；回合结束 clearScrimBookings 清除全部战队的记录', () => {
    const s = restState();
    expect(doScrim(s, 't3').ok).toBe(true);
    expect(doScrim(s, 't3').ok).toBe(false);
    // 进入下一回合（不经推进流程：旧记录的回合键过期即视为空）
    s.roundIndex = 3;
    s.currentDate = s.season.rounds[3].startDate;
    s.freeTrainingUsed = false;
    expect(scrimBookedIds(s)).toEqual([]);
    expect(isScrimBooked(s, 't3')).toBe(false);
    expect(doScrim(s, 't3').ok).toBe(true);
    expect(s.teams.t0.scrimBookings).toEqual({ key: 9 * 100 + 3, teamIds: ['t3'] }); // 旧回合的记录被替换
    // 回合结束清除
    bookScrim(s, 't4', 't1');
    clearScrimBookings(s);
    expect(s.teams.t0.scrimBookings).toBeUndefined();
    expect(s.teams.t1.scrimBookings).toBeUndefined();
    // 约练记录不需要新的座位换入字段（存在战队上）
    expect(SEAT_TOP_KEYS).not.toContain('scrimBookings');
  });

  it('上限可配置：scrimPerOpponentPerRound = 2 时同一对手可约 2 次', () => {
    const t = CONFIG.training as unknown as Record<string, number>;
    const old = t.scrimPerOpponentPerRound;
    try {
      t.scrimPerOpponentPerRound = 2;
      const s = restState();
      expect(doScrim(s, 't3').ok).toBe(true);
      expect(doScrim(s, 't3').ok).toBe(true);
      const r = doScrim(s, 't3');
      expect(r.ok).toBe(false);
      expect(r.message).toContain('只能约练 2 次');
    } finally {
      t.scrimPerOpponentPerRound = old;
    }
  });

  it('非法 / 原型键对手 id 被拒', () => {
    const s = restState();
    expect(doScrim(s, 'toString').ok).toBe(false);
    expect(doScrim(s, '__proto__').ok).toBe(false);
    expect(doScrim(s, 't0').ok).toBe(false);
    expect(s.teams.t0.scrimBookings).toBeUndefined();
  });

  it('双方都要有首发：约没有首发的空壳战队 / 本队没有首发时被拒（倍数下限 > 1 后不能白拿加成），不扣钱、不记预约', () => {
    const s = restState();
    const gold = s.teams.t0.gold;
    s.teams.t4.lineup = { 1: null, 2: null, 3: null, 4: null, 5: null } as never;
    const r1 = doScrim(s, 't4');
    expect(r1.ok).toBe(false);
    expect(r1.message).toContain('没有首发');
    const own = s.teams.t0.lineup;
    s.teams.t0.lineup = { 1: null, 2: null, 3: null, 4: null, 5: null } as never;
    const r2 = doScrim(s, 't3');
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('首发阵容为空');
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.teams.t0.scrimBookings).toBeUndefined();
    s.teams.t0.lineup = own;
    expect(doScrim(s, 't3').ok).toBe(true);
  });

  it('单机完整流程：推进回合后清除预约，下个休赛回合可以再约同一支对手', async () => {
    const state = await createNewGame({
      startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', seed: 3,
      newClub: { name: 'Scrim Club', tag: 'SCR', region: 'CN', color: '#c23c2a' },
    });
    const me = state.settings.playerTeamId;
    const toRest = () => {
      for (let i = 0; i < 12 && trainingBlockReason(state); i++) {
        for (const id of [...(state.season.registeredTournamentIds ?? [])]) unregisterFromTournament(state, id);
        for (const d of [...state.pendingDecisions]) resolveDecision(state, d.id, d.choices[0]?.id ?? '');
        advance(state);
      }
    };
    toRest();
    expect(trainingBlockReason(state)).toBeNull();
    state.teams[me].gold = 10_000_000;
    const opp = Object.values(state.teams).find((t) => !t.disbanded && t.id !== me && t.playerIds.length >= 5)!;
    expect(doScrim(state, opp.id).ok).toBe(true);
    expect(doScrim(state, opp.id).ok).toBe(false);
    const round = state.roundIndex;
    for (const id of [...(state.season.registeredTournamentIds ?? [])]) unregisterFromTournament(state, id);
    for (const d of [...state.pendingDecisions]) resolveDecision(state, d.id, d.choices[0]?.id ?? '');
    expect(getAdvanceBlockers(state)).toEqual([]);
    expect(advance(state).ok).toBe(true);
    expect(state.roundIndex).toBe(round + 1);
    expect(state.teams[me].scrimBookings).toBeUndefined();
    toRest();
    expect(trainingBlockReason(state)).toBeNull();
    expect(doScrim(state, opp.id).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 训练赛倍数：下限 > 1、对手越强越高、上限
// ---------------------------------------------------------------------------
describe('scrim · 倍数下限 / 上限', () => {
  it('配置：下限 > 1 < 同等实力 < 上限', () => {
    const t = CONFIG.training;
    expect(t.scrimMultMin).toBeGreaterThan(1);
    expect(t.scrimMultBase).toBeGreaterThan(t.scrimMultMin);
    expect(t.scrimMultMax).toBeGreaterThan(t.scrimMultBase);
  });

  it('约弱队也 > 1（不低于下限），同等实力 = 基准，对手越强越高，封顶', () => {
    const s = makeTestState(6); // t0 战力 70 … t5 战力 75
    const t = CONFIG.training;
    const weak = scrimMultiplier(s, 't5', 't0');
    const equal = scrimMultiplier(s, 't2', 't2');
    const strong = scrimMultiplier(s, 't0', 't5');
    expect(weak).toBeGreaterThanOrEqual(t.scrimMultMin);
    expect(weak).toBeGreaterThan(1);
    expect(equal).toBeCloseTo(t.scrimMultBase, 6);
    expect(strong).toBeGreaterThan(equal);
    expect(equal).toBeGreaterThan(weak);
    // 极弱 / 极强：夹在下限 / 上限
    for (const id of s.teams.t0.playerIds) s.players[id].power = 20;
    expect(scrimMultiplier(s, 't5', 't0')).toBe(t.scrimMultMin);
    expect(scrimMultiplier(s, 't0', 't5')).toBe(t.scrimMultMax);
    // 本队评分为 0（无首发）：对手有评分即按上限
    s.teams.t1.lineup = { 1: null, 2: null, 3: null, 4: null, 5: null } as never;
    expect(scrimMultiplier(s, 't1', 't5')).toBe(t.scrimMultMax);
  });

  it('费用仍随对手实力上涨', () => {
    const s = restState(8);
    expect(scrimCost(s, 't7')).toBeGreaterThan(scrimCost(s, 't1'));
  });

  it('同一随机序列下：约最弱的对手，战力 / 天梯收益也高于普通训练（× 下限）', () => {
    const base = restState();
    for (const id of base.teams.t0.playerIds) base.players[id].power = 80; // 本队最强：所有对手都弱于本队
    const a = clone(base);
    const b = clone(base);
    const normal = doTraining(a);
    const scrim = doScrim(b, 't1');
    expect(normal.ok && scrim.ok).toBe(true);
    expect(scrim.mult).toBeCloseTo(CONFIG.training.scrimMultMin, 6);
    expect(sum(scrim.gains, 'power')).toBeGreaterThan(sum(normal.gains, 'power'));
    expect(sum(scrim.gains, 'mmr')).toBeGreaterThan(sum(normal.gains, 'mmr'));
    expect(sum(scrim.gains, 'power') / sum(normal.gains, 'power')).toBeCloseTo(CONFIG.training.scrimMultMin, 1);
  });
});

// ---------------------------------------------------------------------------
// 灵性额外加成（交流 BP）
// ---------------------------------------------------------------------------
describe('scrim · 灵性额外加成', () => {
  it('配置在 1.6~2 之间；scrimTrainOptions 叠加在 sessionTrainOptions 之上', () => {
    expect(scrimInsightMult()).toBeGreaterThanOrEqual(1.6);
    expect(scrimInsightMult()).toBeLessThanOrEqual(2);
    expect(scrimTrainOptions('free')).toEqual({ gainMult: { insight: scrimInsightMult() } });
    expect(scrimTrainOptions('extra')).toEqual({ attrMult: CONFIG.training.extraSessionAttrMult, gainMult: { insight: scrimInsightMult() } });
    expect(sessionTrainOptions('free')).toBeUndefined();
  });

  it('同一随机序列、同一倍数：灵性 × scrimInsightMult，战力 / 天梯不变', () => {
    const base = restState();
    for (const id of base.teams.t0.playerIds) base.players[id].insight = 30;
    const a = clone(base);
    const b = clone(base);
    const g1 = trainTeam(a, 't0', 'insight', 8, sessionTrainOptions('free'));
    const g2 = trainTeam(b, 't0', 'insight', 8, scrimTrainOptions('free'));
    expect(sum(g2, 'power')).toBeCloseTo(sum(g1, 'power'), 6);
    expect(sum(g2, 'mmr')).toBe(sum(g1, 'mmr'));
    expect(sum(g2, 'insight') / sum(g1, 'insight')).toBeCloseTo(scrimInsightMult(), 1);
  });

  it('doScrim：灵性 ≈ 普通训练 × 倍数 × 灵性加成，战力 ≈ × 倍数；记录与战报带上灵性加成', () => {
    const base = restState();
    base.trainingFocus = 'balanced';
    for (const id of base.teams.t0.playerIds) base.players[id].insight = 30;
    const a = clone(base);
    const b = clone(base);
    const normal = doTraining(a);
    const scrim = doScrim(b, 't5');
    expect(normal.ok && scrim.ok).toBe(true);
    const mult = scrim.mult!;
    const ins = scrimInsightMult();
    expect(scrim.insightMult).toBe(ins);
    expect(sum(scrim.gains, 'insight') / sum(normal.gains, 'insight')).toBeCloseTo(mult * ins, 0);
    expect(sum(scrim.gains, 'insight') / sum(normal.gains, 'insight')).toBeGreaterThan(mult * 1.4);
    expect(sum(scrim.gains, 'power') / sum(normal.gains, 'power')).toBeCloseTo(mult, 0);
    expect(scrim.record?.insightMult).toBe(ins);
    expect(scrim.message).toContain('交流 BP');
    expect(b.news[0]?.title).toContain('训练赛'); // addNews 最新在前
    expect(b.news[0]?.body).toContain('灵性另');
    // 普通训练的记录不带灵性加成字段
    expect(normal.record?.insightMult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 多人：按座位战队隔离
// ---------------------------------------------------------------------------
describe('scrim · 多人座位隔离', () => {
  const CLUBS = [
    { name: 'Alpha Club', tag: 'ALP', region: 'CN' as const, color: '#c23c2a' },
    { name: 'Beta Club', tag: 'BET', region: 'EU' as const, color: '#3a7bd5' },
  ];
  const call = (g: GameState, id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
  const inSeat = <T>(g: GameState, id: string, fn: () => T) => M.withSeat(g, id, fn);

  function clearRound(g: GameState, round: number): void {
    for (const id of M.activeHumanIds(g)) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === round && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
      for (let i = 0; i < 30; i++) {
        const d = inSeat(g, id, () => g.pendingDecisions[0]);
        if (!d) break;
        let r = call(g, id, 'resolveDecision', d.id, d.choices[0]?.id ?? '');
        if (!r.ok) for (const c of d.choices) if ((r = call(g, id, 'resolveDecision', d.id, c.id)).ok) break;
      }
    }
  }
  function advanceAll(g: GameState): OpResult {
    for (const id of M.activeHumanIds(g)) {
      const r = M.setSeatReady(g, id, true);
      if (!r.ok) throw new Error(`${id} 无法准备：${r.message}`);
    }
    return M.advanceMultiplayer(g);
  }

  it('每个座位各自记录：A 约过的对手 B 仍可约；A 重复约被拒；推进后各自重置', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 11,
      players: CLUBS.map((c, i) => ({ sessionId: `sess-${i}`, name: `玩家${i + 1}`, newClub: c })),
    });
    const [A, B] = g.multiplayer!.order;
    clearRound(g, 1);
    expect(advanceAll(g).ok).toBe(true);
    expect(inSeat(g, A, () => trainingBlockReason(g))).toBeNull();
    expect(inSeat(g, B, () => trainingBlockReason(g))).toBeNull();
    g.teams[A].gold = 10_000_000;
    g.teams[B].gold = 10_000_000;
    const [x, y] = Object.values(g.teams).filter((t) => !t.isPlayer && !t.disbanded && t.playerIds.length >= 5).map((t) => t.id);

    expect(call(g, A, 'doScrim', x).ok).toBe(true);
    const again = call(g, A, 'doScrim', x);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('本回合已与');
    expect(call(g, B, 'doScrim', x).ok).toBe(true); // 另一座位不受影响
    expect(call(g, A, 'doScrim', y).ok).toBe(false); // A 的训练次数已用完（只有免费 1 次）
    call(g, A, 'buyExtraTraining');
    expect(call(g, A, 'doScrim', y).ok).toBe(true);
    expect(g.teams[A].scrimBookings?.teamIds).toEqual([x, y]);
    expect(g.teams[B].scrimBookings?.teamIds).toEqual([x]);
    expect(inSeat(g, A, () => isScrimBooked(g, y))).toBe(true);
    expect(inSeat(g, B, () => isScrimBooked(g, y))).toBe(false);
    // 中性上下文不残留
    expect(g.settings.playerTeamId).toBe('');

    // 推进到下一回合：预约清除
    clearRound(g, g.roundIndex + 1);
    expect(advanceAll(g).ok).toBe(true);
    expect(g.teams[A].scrimBookings).toBeUndefined();
    expect(g.teams[B].scrimBookings).toBeUndefined();
    if (inSeat(g, A, () => trainingBlockReason(g)) === null) expect(call(g, A, 'doScrim', x).ok).toBe(true);
  });
});
