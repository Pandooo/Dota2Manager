import { describe, expect, it } from 'vitest';
import type { GameState, TrainingGain } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { buildRounds, seasonStartDate, tiDates } from '../src/engine/calendar';
import { extraTrainingCost, scrimCost } from '../src/engine/economy';
import { advance, buyExtraTraining, createNewGame, doScrim, doTraining } from '../src/engine/game';
import { exportSave, importSave } from '../src/engine/save';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { endRound } from '../src/engine/season';
import {
  pendingExtraSessionCost, recordTraining, snapshotSquad, squadProgressOf, trainingRecords, trainingSummary,
} from '../src/engine/trainingLog';
import { makeTestState } from './helpers';

/** 常规赛休赛回合（无赛事）的测试状态 */
function restState(roundIndex = 3): GameState {
  const state = makeTestState(4);
  const start = seasonStartDate(9);
  const { startDate, endDate } = tiDates(9);
  state.season = { ...state.season, startDate: start, tiStartDate: startDate, rounds: buildRounds(9, start, startDate, endDate) };
  state.phase = 'regular';
  state.roundIndex = roundIndex;
  state.currentDate = state.season.rounds[roundIndex].startDate;
  return state;
}

function gain(playerId: string, power: number, mmr: number, insight = 0): TrainingGain {
  return { playerId, handle: playerId.toUpperCase(), power, mmr, insight, talent: 0, resilience: 0 };
}

describe('trainingLog: 训练记录', () => {
  it('免费训练写入 free 记录（花费 0），不可训练时不写入', () => {
    const pre = makeTestState(4);
    expect(doTraining(pre).ok).toBe(false);
    expect(trainingRecords(pre)).toEqual([]);

    const state = restState();
    state.trainingFocus = 'power';
    const r = doTraining(state);
    expect(r.ok).toBe(true);
    const list = trainingRecords(state);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      season: 9, round: 3, date: state.currentDate, kind: 'free', focus: 'power', mult: 1, cost: 0, session: 'free', sessionCost: 0,
    });
    expect(list[0].gains).toHaveLength(5);
    expect(r.record).toBe(list[0]);
    // 记录的收益与返回给 UI 的收益一致（存档精度 3 位小数）
    expect(list[0].gains[0].power).toBeCloseTo(r.gains![0].power, 3);
    expect(list[0].gains.every((g) => g.power > 0)).toBe(true);
  });

  it('额外训练 / 训练赛记录实际花费（先买先用）', () => {
    const state = restState();
    expect(doTraining(state).ok).toBe(true); // 免费
    const p0 = extraTrainingCost(state);
    expect(buyExtraTraining(state).ok).toBe(true);
    const p1 = extraTrainingCost(state);
    expect(buyExtraTraining(state).ok).toBe(true);
    expect(p1).toBeGreaterThan(p0);
    expect(pendingExtraSessionCost(state)).toBe(p0);

    const e = doTraining(state);
    expect(e.ok).toBe(true);
    expect(e.record).toMatchObject({ kind: 'extra', cost: p0, session: 'extra', sessionCost: p0 });

    const fee = scrimCost(state, 't3');
    const s = doScrim(state, 't3');
    expect(s.ok).toBe(true);
    expect(s.record).toMatchObject({
      kind: 'scrim', scrimTargetId: 't3', scrimWon: s.won, cost: fee + p1, session: 'extra', sessionCost: p1,
    });
    expect(s.record!.mult).toBeCloseTo(s.mult!, 3);

    // 记录花费合计 = 本回合训练/训练赛实际支出
    const spent = -state.finance
      .filter((f) => f.round === 3 && (f.category === 'training' || f.category === 'scrim'))
      .reduce((a, f) => a + f.amount, 0);
    const recorded = trainingRecords(state).reduce((a, r) => a + r.cost, 0);
    expect(recorded).toBe(spent);
    expect(trainingRecords(state).map((r) => r.kind)).toEqual(['free', 'extra', 'scrim']);

    const sum = trainingSummary(state, 9);
    expect(sum.trainingSpend).toBe(p0 + p1);
    expect(sum.scrimSpend).toBe(fee);
    expect(sum.totalSpend).toBe(spent);
    expect(sum.scrims).toBe(1);
    expect(sum.scrimWins).toBe(s.won ? 1 : 0);
  });

  it('免费训练时约练：训练赛花费只含约练费', () => {
    const state = restState();
    const fee = scrimCost(state, 't2');
    const s = doScrim(state, 't2');
    expect(s.ok).toBe(true);
    expect(s.record).toMatchObject({ kind: 'scrim', cost: fee, session: 'free', sessionCost: 0 });
  });

  it('回合结束自动训练写入 auto 记录（含已购未用次数的价格），并记录成长快照', () => {
    const state = restState();
    state.trainingFocus = 'insight';
    const p0 = extraTrainingCost(state);
    buyExtraTraining(state);
    const p1 = extraTrainingCost(state);
    buyExtraTraining(state);
    endRound(state);

    const autos = trainingRecords(state).filter((r) => r.kind === 'auto');
    expect(autos).toHaveLength(3);
    expect(autos.map((r) => r.cost)).toEqual([0, p0, p1]);
    expect(autos.map((r) => r.session)).toEqual(['free', 'extra', 'extra']);
    expect(autos.every((r) => r.focus === 'insight' && r.round === 3 && r.season === 9)).toBe(true);
    expect(state.extraTrainingAvailable).toBe(0);

    const team = state.teams.t0;
    for (const id of team.playerIds) {
      const pts = squadProgressOf(state, id);
      expect(pts).toHaveLength(1);
      expect(pts[0]).toMatchObject({ season: 9, round: 3, mmr: Math.round(state.players[id].mmr) });
      expect(pts[0].power).toBeCloseTo(state.players[id].power, 2);
    }
    // AI 战队选手不记录
    expect(squadProgressOf(state, state.teams.t1.playerIds[0])).toEqual([]);
  });

  it('训练已用完的休赛回合不产生 auto 记录', () => {
    const state = restState();
    doTraining(state);
    endRound(state);
    expect(trainingRecords(state).map((r) => r.kind)).toEqual(['free']);
  });
});

describe('trainingLog: 上限', () => {
  it('训练记录最多保留 logMaxRecords 条（丢弃最旧）', () => {
    const state = restState();
    const max = CONFIG.training.logMaxRecords;
    for (let i = 0; i < max + 5; i++) {
      recordTraining(state, { kind: 'free', focus: 'balanced', mult: 1, cost: i, gains: [] });
    }
    const list = trainingRecords(state);
    expect(list).toHaveLength(max);
    expect(list[0].cost).toBe(5);
    expect(list[list.length - 1].cost).toBe(max + 4);
  });

  it('旧存档（无 history.training/squadProgress）可直接写入；非法字段被规范化', () => {
    const state = restState();
    delete state.history.training;
    delete state.history.squadProgress;
    expect(trainingSummary(state).sessions).toBe(0);
    const r = recordTraining(state, {
      kind: 'bogus' as never, focus: 'nope' as never, mult: NaN, cost: -50, gains: [gain('x', 0.123456, 12.34)],
    });
    expect(r).toMatchObject({ kind: 'free', focus: 'balanced', mult: 1, cost: 0, season: 9, round: 3 });
    expect(r.gains[0]).toMatchObject({ power: 0.123, mmr: 12 });
    snapshotSquad(state);
    expect(Object.keys(state.history.squadProgress!)).toHaveLength(5);
  });

  it('成长快照：同回合覆盖、每人最多 progressMaxPointsPerPlayer 个点', () => {
    const state = restState();
    const id = state.teams.t0.playerIds[0];
    snapshotSquad(state);
    state.players[id].power += 1;
    snapshotSquad(state);
    expect(squadProgressOf(state, id)).toHaveLength(1);
    expect(squadProgressOf(state, id)[0].power).toBeCloseTo(state.players[id].power, 2);

    const maxPts = CONFIG.training.progressMaxPointsPerPlayer;
    for (let i = 0; i < maxPts + 10; i++) {
      state.season.ti = 9 + Math.floor(i / 20);
      state.roundIndex = i % 20;
      snapshotSquad(state);
    }
    const pts = squadProgressOf(state, id);
    expect(pts).toHaveLength(maxPts);
    expect(pts[pts.length - 1]).toMatchObject({ season: state.season.ti, round: state.roundIndex });
  });

  it('成长快照：选手数超限时优先删除已离队且最久未更新的选手', () => {
    const state = restState();
    const maxPlayers = CONFIG.training.progressMaxPlayers;
    const prog: NonNullable<GameState['history']['squadProgress']> = {};
    const pt = (season: number, round: number) => ({ season, round, power: 1, mmr: 1, insight: 1, talent: 1, resilience: 1, loyalty: 1 });
    for (let i = 0; i < maxPlayers + 3; i++) prog[`gone${i}`] = [pt(1, i)];
    state.history.squadProgress = prog;
    snapshotSquad(state);
    const ids = Object.keys(state.history.squadProgress!);
    expect(ids).toHaveLength(maxPlayers);
    for (const id of state.teams.t0.playerIds) expect(ids).toContain(id);
    // 最旧的 8 名（3 超出 + 5 名现役新增）被删除
    for (let i = 0; i < 8; i++) expect(ids).not.toContain(`gone${i}`);
    expect(ids).toContain('gone8');
  });
});

describe('trainingLog: 汇总', () => {
  it('选手累计收益、按焦点平均、花费拆分与赛季筛选', () => {
    const state = restState();
    delete state.history.training;
    recordTraining(state, { kind: 'free', focus: 'power', mult: 1, cost: 0, gains: [gain('a', 1, 10), gain('b', 0.5, 20)] });
    recordTraining(state, { kind: 'extra', focus: 'power', mult: 1, cost: 300, session: 'extra', sessionCost: 300, gains: [gain('a', 2, 30)] });
    recordTraining(state, {
      kind: 'scrim', focus: 'mmr', mult: 1.5, cost: 1000, session: 'extra', sessionCost: 400, scrimTargetId: 't1', scrimWon: true,
      gains: [gain('a', 0.2, 60, 0.1), gain('b', 0.1, 90, 0.3)],
    });
    recordTraining(state, { kind: 'auto', focus: 'mmr', mult: 1, cost: 0, gains: [gain('b', 0.1, 50)] });
    recordTraining(state, { season: 8, kind: 'free', focus: 'insight', mult: 1, cost: 0, gains: [gain('a', 9, 9, 9)] });

    const s = trainingSummary(state, 9);
    expect(s.season).toBe(9);
    expect(s.sessions).toBe(4);
    expect(s.byKind).toEqual({ free: 1, extra: 1, scrim: 1, auto: 1 });
    expect(s.trainingSpend).toBe(700);
    expect(s.scrimSpend).toBe(600);
    expect(s.totalSpend).toBe(1300);
    expect(s.scrims).toBe(1);
    expect(s.scrimWins).toBe(1);
    expect(s.totals.power).toBeCloseTo(3.9, 6);
    expect(s.totals.mmr).toBeCloseTo(260, 6);
    expect(s.totals.insight).toBeCloseTo(0.4, 6);

    const a = s.players.find((p) => p.playerId === 'a')!;
    const b = s.players.find((p) => p.playerId === 'b')!;
    expect(a).toMatchObject({ sessions: 3, handle: 'A' });
    expect(a.power).toBeCloseTo(3.2, 6);
    expect(a.mmr).toBeCloseTo(100, 6);
    expect(b.sessions).toBe(3);
    expect(b.power).toBeCloseTo(0.7, 6);
    expect(b.mmr).toBeCloseTo(160, 6);
    expect(s.players[0].playerId).toBe('a'); // 按战力收益降序

    // power 焦点：2 次训练，全队合计 (1.5 + 2) / 2；每人每次 3.5 / 3
    expect(s.byFocus.power.sessions).toBe(2);
    expect(s.byFocus.power.avg.power).toBeCloseTo(1.75, 6);
    expect(s.byFocus.power.avgPerPlayer.power).toBeCloseTo(3.5 / 3, 6);
    expect(s.byFocus.power.avgMult).toBeCloseTo(1, 6);
    // mmr 焦点：训练赛 ×1.5 + 自动训练
    expect(s.byFocus.mmr.sessions).toBe(2);
    expect(s.byFocus.mmr.avg.mmr).toBeCloseTo(100, 6);
    expect(s.byFocus.mmr.avgPerPlayer.mmr).toBeCloseTo(200 / 3, 6);
    expect(s.byFocus.mmr.avgMult).toBeCloseTo(1.25, 6);
    // 本赛季没有灵性焦点训练
    expect(s.byFocus.insight).toMatchObject({ sessions: 0, avgMult: 0 });
    expect(s.byFocus.insight.avg.power).toBe(0);

    const all = trainingSummary(state);
    expect(all.season).toBeUndefined();
    expect(all.sessions).toBe(5);
    expect(all.byFocus.insight.sessions).toBe(1);
    expect(all.players.find((p) => p.playerId === 'a')!.power).toBeCloseTo(12.2, 6);
    expect(trainingSummary(state, 7).sessions).toBe(0);
  });
});

describe('trainingLog: 健壮性与赛季起点', () => {
  it('损坏的 history.training / squadProgress（非数组/非对象）不崩溃并被重建', () => {
    const state = restState();
    (state.history as unknown as Record<string, unknown>).training = { bogus: true };
    (state.history as unknown as Record<string, unknown>).squadProgress = [1, 2, 3];
    expect(trainingRecords(state)).toEqual([]);
    expect(trainingSummary(state).sessions).toBe(0);
    expect(doTraining(state).ok).toBe(true);
    expect(trainingRecords(state)).toHaveLength(1);
    snapshotSquad(state);
    const id = state.teams.t0.playerIds[0];
    (state.history.squadProgress as Record<string, unknown>)[id] = 'x';
    expect(squadProgressOf(state, id)).toEqual([]);
    snapshotSquad(state);
    expect(squadProgressOf(state, id)).toHaveLength(1);
    // 汇总跳过非法记录
    (state.history.training as unknown[]).push(null, { kind: 'free', focus: 'power', mult: 1, cost: 0, season: 9, round: 3 });
    const sum = trainingSummary(state, 9);
    expect(sum.sessions).toBe(2);
    expect(sum.byKind.free).toBe(2);
  });

  it('免费训练次数为 0 时，回合末不会凭空自动训练', () => {
    const training = CONFIG.training as { freePerRestRound: number };
    const prev = training.freePerRestRound;
    try {
      training.freePerRestRound = 0;
      const state = restState();
      endRound(state);
      expect(trainingRecords(state)).toEqual([]);
    } finally {
      training.freePerRestRound = prev;
    }
  });

  it('新游戏：赛季初（回合 0）即有成长快照基线；训练记录与快照随存档导出/导入保留', async () => {
    registerNodeRosterLoader();
    const g = await createNewGame({
      startTi: 9, seasons: 1, difficulty: 'normal', managerName: 'T', seed: 7,
      newClub: { name: 'Log Test', tag: 'LT', region: 'CN', color: '#123456' },
    });
    const team = g.teams[g.settings.playerTeamId];
    expect(team.playerIds.length).toBeGreaterThanOrEqual(5);
    for (const id of team.playerIds) {
      const p = g.players[id];
      if (p.isWildSub || p.tempSubUntilTournament) continue;
      expect(squadProgressOf(g, id)[0]).toMatchObject({ season: 9, round: 0, mmr: Math.round(p.mmr) });
    }
    expect(advance(g).ok).toBe(true); // 赛季初 → 第 1 回合
    recordTraining(g, { kind: 'free', focus: 'mmr', mult: 1, cost: 0, gains: [gain(team.playerIds[0], 0.5, 20)] });
    const back = importSave(exportSave(g));
    expect(trainingRecords(back)).toEqual(trainingRecords(g));
    expect(back.history.squadProgress).toEqual(g.history.squadProgress);
    expect(trainingRecords(back)[0]).toMatchObject({ season: 9, round: 1, kind: 'free', focus: 'mmr' });
  });
});
