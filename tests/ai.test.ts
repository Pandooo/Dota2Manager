import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/engine/player', () => import('./e4-fakes/player'));
vi.mock('../src/engine/team', () => import('./e4-fakes/team'));
vi.mock('../src/engine/honor', () => import('./e4-fakes/others'));
vi.mock('../src/engine/generation', () => import('./e4-fakes/others'));
vi.mock('../src/engine/growth', () => import('./e4-fakes/others'));
vi.mock('../src/engine/funEvents', () => import('./e4-fakes/others'));
vi.mock('../src/data/index', () => import('./e4-fakes/others'));

import { makeTestState, makePlayer, makeCoach } from './helpers';
import { trainCalls } from './e4-fakes/others';
import { withConfig } from './e4-fakes/mocks';
import { computeSalary } from './e4-fakes/player';
import { CONFIG } from '../src/engine/config';
import { POSITIONS, REGIONS } from '../src/engine/types';
import type { GameState, Player } from '../src/engine/types';
import { aiEnsureRosters, aiTrainRound, aiTransferWindow } from '../src/engine/ai';
import { refreshFreeAgents } from '../src/engine/market';

function active(s: GameState, teamId: string): Player[] {
  return s.teams[teamId].playerIds.map((id) => s.players[id]).filter((p) => p && p.status === 'active');
}

function expectValidAiRosters(s: GameState): void {
  for (const t of Object.values(s.teams)) {
    if (t.isPlayer || t.disbanded) continue;
    const ps = active(s, t.id);
    expect(ps.length).toBeGreaterThanOrEqual(CONFIG.ai.minRoster);
    expect(ps.length).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    for (const pos of POSITIONS) {
      const id = t.lineup[pos];
      expect(id).toBeTruthy();
      expect(s.players[id!].teamId).toBe(t.id);
    }
    for (const p of ps) expect(p.teamId).toBe(t.id);
  }
}

beforeEach(() => {
  trainCalls.length = 0;
});

describe('ai', () => {
  it('每回合 AI 训练，富队额外训练，玩家队不训练', () => {
    const s = makeTestState(4);
    s.teams.t1.gold = 0;
    s.teams.t2.gold = 1e9;
    const by = (id: string) => trainCalls.filter((c) => c.teamId === id).length;
    // 额外训练期望为小数时按概率取整：富队每回合 1 + ⌊rich⌋ 或 1 + ⌈rich⌉ 次，长期均值 ≈ 1 + rich（普通队同理 1 + normal）
    const { rich, normal } = CONFIG.training.aiExtraTrainingsPerRound;
    const N = 400;
    let richTotal = 0;
    let normalTotal = 0;
    for (let i = 0; i < N; i++) {
      trainCalls.length = 0;
      aiTrainRound(s);
      expect(by('t0')).toBe(0);
      expect(by('t1')).toBeGreaterThanOrEqual(1 + Math.floor(normal));
      expect(by('t1')).toBeLessThanOrEqual(1 + Math.ceil(normal));
      expect(by('t2')).toBeGreaterThanOrEqual(1 + Math.floor(rich));
      expect(by('t2')).toBeLessThanOrEqual(1 + Math.ceil(rich));
      normalTotal += by('t1');
      richTotal += by('t2');
      for (const c of trainCalls) expect(['power', 'mmr', 'insight', 'balanced']).toContain(c.focus);
      // 每回合第一次训练全额；加练的天赋 / 韧性收益 × extraSessionAttrMult（与人类玩家的额外训练相同）
      for (const id of ['t1', 't2']) {
        const calls = trainCalls.filter((c) => c.teamId === id);
        expect(calls[0].attrMult).toBeUndefined();
        for (const c of calls.slice(1)) expect(c.attrMult).toBe(CONFIG.training.extraSessionAttrMult);
      }
    }
    expect(Math.abs(richTotal / N - (1 + rich))).toBeLessThan(0.08);
    expect(Math.abs(normalTotal / N - (1 + normal))).toBeLessThan(0.08);
  });

  it('AI 训练收益单独缩放（aiGainMult）；本赛季参赛多的 AI 战队在休赛回合按参赛比例加练', () => {
    const s = makeTestState(4);
    for (const t of ['t1', 't2', 't3']) s.teams[t].gold = 0; // 都不是富队
    s.phase = 'regular';
    s.roundIndex = 4;
    // t1 本赛季第 1–3 回合都在比赛（第 4 回合休赛）
    for (let r = 1; r <= 3; r++) {
      s.tournaments[`x${r}`] = {
        id: `x${r}`, season: s.season.ti, roundIndex: r, status: 'finished', teamIds: ['t1', 't2'], qualifierTeamIds: [],
      } as unknown as GameState['tournaments'][string];
    }
    // t2 本回合（第 4 回合）在比赛：不训练
    s.tournaments.x4 = {
      id: 'x4', season: s.season.ti, roundIndex: 4, status: 'running', teamIds: ['t2'], qualifierTeamIds: [],
    } as unknown as GameState['tournaments'][string];
    const by = (id: string) => trainCalls.filter((c) => c.teamId === id).length;
    const share = 3 / 4;
    const normal = CONFIG.training.aiExtraTrainingsPerRound.normal;
    const N = 400;
    let busyTotal = 0;
    let idleTotal = 0;
    for (let i = 0; i < N; i++) {
      trainCalls.length = 0;
      aiTrainRound(s);
      expect(by('t2')).toBe(0);
      idleTotal += by('t3');
      busyTotal += by('t1');
    }
    // t3 本赛季没参赛：只有 1 + normal；t1 参赛比例 3/4：再按 aiBusyExtraPerRound × 3/4 加练
    expect(Math.abs(idleTotal / N - (1 + normal))).toBeLessThan(0.08);
    expect(Math.abs(busyTotal / N - (1 + normal + CONFIG.training.aiBusyExtraPerRound * share))).toBeLessThan(0.1);
    for (const c of trainCalls) expect(c.gainMult).toEqual(CONFIG.training.aiGainMult);
  });

  it('赛季初转会窗口：缺人补齐、超员裁剪，阵容始终合法', () => {
    const s = makeTestState(6);
    refreshFreeAgents(s);
    // t1 只剩 2 人
    const t1 = s.teams.t1;
    for (const id of t1.playerIds.slice(2)) s.players[id].teamId = null;
    t1.playerIds = t1.playerIds.slice(0, 2);
    t1.lineup = { C: t1.playerIds[0], M: t1.playerIds[1], O: null, SS: null, HS: null };
    // t2 塞到 10 人
    for (let i = 0; i < 5; i++) {
      const p = makePlayer({ teamId: 't2', position: POSITIONS[i], power: 40 });
      p.salary = computeSalary(s, p);
      s.players[p.id] = p;
      s.teams.t2.playerIds.push(p.id);
    }
    aiTransferWindow(s, 'preseason');
    expectValidAiRosters(s);
    expect(active(s, 't0')).toHaveLength(5); // 玩家战队不被动
  });

  it('赛中窗口：资金为负的战队出售/解约替补或降薪', () => {
    const s = makeTestState(4);
    const t1 = s.teams.t1;
    const bench = makePlayer({ teamId: 't1', position: 'C', mmr: 16000, power: 60 });
    bench.salary = 50000;
    s.players[bench.id] = bench;
    t1.playerIds.push(bench.id);
    t1.gold = -100000;
    for (const t of ['t2', 't3']) s.teams[t].gold = 50_000_000;
    aiTransferWindow(s, 'midseason');
    expect(bench.teamId).not.toBe('t1');
    expectValidAiRosters(s);

    // 无替补可卖 → 全员降薪
    const s2 = makeTestState(2);
    s2.teams.t1.gold = -1;
    const before = active(s2, 't1').map((p) => p.salary);
    withConfig('ai', { midseasonUpgradeChance: 0 }, () => aiTransferWindow(s2, 'midseason'));
    const after = active(s2, 't1').map((p) => p.salary);
    after.forEach((v, i) => expect(v).toBe(Math.round(before[i] * CONFIG.ai.salaryCutMult)));

    // 降薪不低于工资下限
    const s3 = makeTestState(2);
    s3.teams.t1.gold = -1;
    for (const p of active(s3, 't1')) p.salary = CONFIG.economy.minSalary + 1;
    withConfig('ai', { midseasonUpgradeChance: 0 }, () => aiTransferWindow(s3, 'midseason'));
    for (const p of active(s3, 't1')) expect(p.salary).toBe(CONFIG.economy.minSalary);
  });

  it('资金为负：连续出售/解约多名替补直到资金转正（首发不动）', () => {
    const s = makeTestState(2);
    const t1 = s.teams.t1;
    const starters = Object.values(t1.lineup);
    for (let i = 0; i < 2; i++) {
      const b = makePlayer({ teamId: 't1', position: 'C', mmr: 5200, power: 40 });
      b.salary = 3000;
      s.players[b.id] = b;
      t1.playerIds.push(b.id);
    }
    t1.gold = -10_000_000;
    withConfig('ai', { midseasonUpgradeChance: 0 }, () => aiTransferWindow(s, 'midseason'));
    expect(active(s, 't1')).toHaveLength(CONFIG.ai.minRoster);
    for (const id of starters) expect(s.players[id!].teamId).toBe('t1');
    expectValidAiRosters(s);
  });

  it('签约教练：无教练且资金充裕时从教练市场聘请', () => {
    const s = makeTestState(3);
    for (const t of ['t1', 't2']) s.teams[t].gold = 50_000_000;
    const c1 = makeCoach({ tier: 'SS', salary: 5000 });
    const c2 = makeCoach({ tier: 'A', salary: 3000 });
    s.coaches[c1.id] = c1;
    s.coaches[c2.id] = c2;
    // 第九波：AI 不会让教练市场跌破保底（tests/coaches.test.ts）；这里把保底置 0，只验证聘请机制
    withConfig('coachSupply', { minAvailable: 0, minTopTier: 0 }, () =>
      withConfig('ai', { coachHireChance: 1 }, () => aiTransferWindow(s, 'preseason')));
    expect(s.teams.t1.coachId).toBeTruthy();
    expect(s.teams.t2.coachId).toBeTruthy();
    expect(s.teams.t0.coachId).toBeNull();
    expect(new Set([c1.teamId, c2.teamId])).toEqual(new Set(['t1', 't2']));
  });

  it('aiEnsureRosters：补齐阵容并生成战队至下限，赛区均衡', () => {
    const s = makeTestState(4);
    const t3 = s.teams.t3;
    for (const id of t3.playerIds) s.players[id].status = 'banned';
    aiEnsureRosters(s);
    expect(Object.values(s.teams).filter((t) => !t.disbanded)).toHaveLength(CONFIG.team.minTeams);
    expectValidAiRosters(s);
    const count: Record<string, number> = {};
    for (const t of Object.values(s.teams)) count[t.region] = (count[t.region] ?? 0) + 1;
    const vals = REGIONS.map((r) => count[r] ?? 0);
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
  });

  it('空状态不崩溃', () => {
    const s = makeTestState(1);
    aiTrainRound(s);
    aiTransferWindow(s, 'midseason');
    expect(trainCalls).toHaveLength(0);
  });
});

describe('ai · 教练优先权', () => {
  it('玩家退役选手转来的教练在决策未处理前不被 AI 签走', () => {
    const s = makeTestState(3);
    for (const t of ['t1', 't2']) s.teams[t].gold = 50_000_000;
    const legend = makeCoach({ tier: 'SSR', salary: 5000, formerPlayerId: 't0-C' });
    s.coaches[legend.id] = legend;
    s.pendingDecisions.push({
      id: 'd-r', kind: 'retire', title: '退役', body: '…', choices: [{ id: 'hire_as_coach', label: '聘' }],
      ctx: { playerId: 't0-C', coachId: legend.id }, createdRound: 0, blocking: true,
    });
    withConfig('ai', { coachHireChance: 1 }, () => aiTransferWindow(s, 'preseason'));
    expect(legend.teamId).toBeNull();
  });
});
