// 第九波 #3：赛季教练供给（src/engine/coaches.ts）与 AI 聘请克制（src/engine/ai.ts maybeHireCoach）
import { beforeAll, describe, expect, it } from 'vitest';
import type { Coach, GameState } from '../src/engine/types';
import { TIERS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { makeCoach, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import {
  aiCoachCandidates, aiCoachPickWeight, coachSupplyTarget, coachVacancies, freeCoaches, isNewArrivalCoach, isTopTierCoach,
  realCoachCandidates, seasonCoachSupply,
} from '../src/engine/coaches';
import { aiTransferWindow } from '../src/engine/ai';
import { getCoachIndex } from '../src/data/index';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { createNewGame } from '../src/engine/game';
import * as M from '../src/engine/multi';

beforeAll(() => {
  registerNodeRosterLoader();
});

const topCount = (s: GameState) => freeCoaches(s).filter(isTopTierCoach).length;

/** 保底：可签约 ≥ max(minAvailable, 空缺 + margin)，S+ ≥ minTopTier */
function expectGuarantee(s: GameState): void {
  const cfg = CONFIG.coachSupply;
  const free = freeCoaches(s).length;
  expect(free).toBeGreaterThanOrEqual(Math.max(cfg.minAvailable, coachVacancies(s) + cfg.vacancyMargin));
  expect(topCount(s)).toBeGreaterThanOrEqual(cfg.minTopTier);
}

describe('coaches · 赛季教练供给', () => {
  it('空市场：生成至保底（空缺 + margin、S+ 名额），新闻与记录一致，标记为本赛季新到', () => {
    const s = makeTestState(12);
    s.coachSupply = { ti: 8, added: 0, generated: 0, topUp: 0, real: 0, retired: 0, other: 0, available: 0, topTier: 0, vacancies: 0 };
    expect(coachVacancies(s)).toBe(12);
    const rec = withConfig('coachSupply', { includeRealCoaches: false }, () => seasonCoachSupply(s))!;
    expect(rec).toBeTruthy();
    expectGuarantee(s);
    const free = freeCoaches(s);
    expect(free.length).toBe(rec.available);
    expect(rec.available).toBe(Math.max(CONFIG.coachSupply.minAvailable, 12 + CONFIG.coachSupply.vacancyMargin));
    expect(rec.generated).toBe(rec.added);
    expect(rec.added).toBe(free.length);
    expect(rec.topUp).toBe(rec.generated - CONFIG.coachSupply.generatedPerSeason);
    for (const c of free) {
      expect(c.arrivedTi).toBe(9);
      expect(isNewArrivalCoach(s, c)).toBe(true);
      expect(TIERS).toContain(c.tier);
      expect(c.salary).toBeGreaterThan(0);
    }
    const news = s.news.find((n) => n.title.startsWith('【教练市场】'));
    expect(news?.title).toBe(`【教练市场】本赛季新增 ${rec.added} 名教练`);
    expect(news?.visibility).toBe('public');
    expect(s.coachSupply).toEqual(rec);
  });

  it('同一赛季重复调用幂等；主随机序列不被消耗；同种子结果一致', () => {
    const a = makeTestState(6, 4242);
    const b = makeTestState(6, 4242);
    const rng0 = a.rngState;
    const ra = seasonCoachSupply(a)!;
    expect(a.rngState).toBe(rng0);
    const n = Object.keys(a.coaches).length;
    expect(seasonCoachSupply(a)).toBe(ra);
    expect(Object.keys(a.coaches).length).toBe(n);
    seasonCoachSupply(b);
    const sig = (s: GameState) => Object.values(s.coaches).map((c) => `${c.id}:${c.name}:${c.tier}:${c.talentBoost}`).sort();
    expect(sig(b)).toEqual(sig(a));
  });

  it('市场已充足时仍固定引入一批程序生成教练（等级分布含高等级），不追加', () => {
    const s = makeTestState(4);
    s.coachSupply = { ti: 8, added: 0, generated: 0, topUp: 0, real: 0, retired: 0, other: 0, available: 0, topTier: 0, vacancies: 0 };
    for (let i = 0; i < 30; i++) {
      const c = makeCoach({ id: `old-${i}`, tier: i % 3 === 0 ? 'S' : 'B', arrivedTi: 7 });
      s.coaches[c.id] = c;
    }
    const rec = seasonCoachSupply(s)!;
    expect(rec.generated).toBe(CONFIG.coachSupply.generatedPerSeason);
    expect(rec.topUp).toBe(0);
    expect(freeCoaches(s).length).toBe(30 + rec.generated + rec.real);
    // 老教练不算新到
    expect(isNewArrivalCoach(s, s.coaches['old-0'])).toBe(false);
  });

  it('程序生成教练的等级分布：大量样本中各等级均出现，高等级（S+）为少数', () => {
    const counts: Record<string, number> = {};
    let total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const s = makeTestState(2, seed);
      s.id = `dist-${seed}`;
      s.coachSupply = { ti: 8, added: 0, generated: 0, topUp: 0, real: 0, retired: 0, other: 0, available: 0, topTier: 0, vacancies: 0 };
      for (let i = 0; i < 20; i++) s.coaches[`pad-${i}`] = makeCoach({ id: `pad-${i}`, tier: 'S', arrivedTi: 7 }); // 关掉保底追加
      withConfig('coachSupply', { includeRealCoaches: false }, () => seasonCoachSupply(s));
      for (const c of Object.values(s.coaches)) {
        if (c.arrivedTi !== 9) continue;
        counts[c.tier] = (counts[c.tier] ?? 0) + 1;
        total++;
      }
    }
    expect(total).toBe(60 * CONFIG.coachSupply.generatedPerSeason);
    for (const t of TIERS) expect(counts[t] ?? 0).toBeGreaterThan(0);
    const top = (counts.S ?? 0) + (counts.SS ?? 0) + (counts.SSR ?? 0);
    expect(top / total).toBeGreaterThan(0.12);
    expect(top / total).toBeLessThan(0.4);
  });

  it('首次执行：已有教练记为上赛季；之后首次出现的退役转任教练计入「退役选手转任」并标记新到', () => {
    const s = makeTestState(4);
    const pre = makeCoach({ id: 'pre' });
    s.coaches.pre = pre;
    seasonCoachSupply(s);
    expect(pre.arrivedTi).toBe(8);
    expect(isNewArrivalCoach(s, pre)).toBe(false);
    // 下一赛季：上赛季结算时退役选手转任的教练
    s.season.ti = 10;
    s.season.year = 2021;
    const retiree = makeCoach({ id: 'coach-x', formerPlayerId: 'x', tier: 'A' });
    s.coaches[retiree.id] = retiree;
    const rec = seasonCoachSupply(s)!;
    expect(rec.ti).toBe(10);
    expect(rec.retired).toBe(1);
    expect(retiree.arrivedTi).toBe(10);
    expect(isNewArrivalCoach(s, retiree)).toBe(true);
    expect(rec.added).toBe(rec.generated + rec.real + rec.retired + rec.other);
  });

  it('真实教练：引入该届 roster 中尚未进入游戏的教练；在役同名选手、未来新秀、已转任者、已在游戏中的除外', () => {
    const ti = 10;
    const inTi = getCoachIndex().filter((e) => e.apps.some((a) => a[0] === ti));
    expect(inTi.length).toBeGreaterThan(3);
    const s = makeTestState(4);
    s.season.ti = ti;
    s.season.year = 2021;
    s.coachSupply = { ti: 9, added: 0, generated: 0, topUp: 0, real: 0, retired: 0, other: 0, available: 0, topTier: 0, vacancies: 0 };
    const [already, activeAsPlayer, future, converted] = inTi;
    s.coaches[already.id] = makeCoach({ id: already.id, arrivedTi: 5 });
    s.players[activeAsPlayer.id] = { ...s.players['t1-C'], id: activeAsPlayer.id, teamId: null, status: 'active' };
    s.futureRookies[future.id] = 12;
    s.coaches['coach-conv'] = makeCoach({ id: 'coach-conv', formerPlayerId: converted.id, arrivedTi: 5 });
    const cands = realCoachCandidates(s, ti);
    const ids = new Set(cands.map((c) => c.id));
    for (const e of [already, activeAsPlayer, future, converted]) expect(ids.has(e.id)).toBe(false);
    for (const c of cands) expect(s.season.year - c.birthYear).toBeLessThan(CONFIG.coach.retireAge);
    // 按等级 → 灵性降序
    for (let i = 1; i < cands.length; i++) {
      const a = TIERS.indexOf(cands[i - 1].tier);
      const b = TIERS.indexOf(cands[i].tier);
      expect(a > b || (a === b && cands[i - 1].insight >= cands[i].insight)).toBe(true);
    }
    const rec = seasonCoachSupply(s)!;
    expect(rec.real).toBe(Math.min(cands.length, CONFIG.coachSupply.realMaxPerSeason));
    for (const c of cands.slice(0, rec.real)) {
      const coach = s.coaches[c.id];
      expect(coach?.teamId).toBeNull();
      expect(coach?.arrivedTi).toBe(ti);
      expect(coach?.tier).toBe(c.tier);
    }
    // 下一赛季不会重复引入
    s.season.ti = 11;
    const again = realCoachCandidates(s, 11).map((c) => c.id);
    for (const c of cands.slice(0, rec.real)) expect(again).not.toContain(c.id);
  });

  it('新游戏（TI1 空缺极多 / TI9）：AI 季前签约之后保底依然成立', async () => {
    for (const [startTi, seed] of [[1, 5], [9, 6]] as const) {
      const g = await createNewGame({
        startTi, seasons: 2, difficulty: 'normal', managerName: 'T', seed,
        newClub: { name: 'Coach Test', tag: 'CT', region: 'CN', color: '#123456' },
      });
      expect(g.coachSupply?.ti).toBe(startTi);
      expectGuarantee(g);
      // 第一季新到的教练都是本季生成 / 引入的
      const fresh = Object.values(g.coaches).filter((c) => isNewArrivalCoach(g, c));
      expect(fresh.length).toBe(g.coachSupply!.added);
      expect(g.news.some((n) => n.title === `【教练市场】本赛季新增 ${g.coachSupply!.added} 名教练`)).toBe(true);
    }
  });

  it('多人模式：全局供给一次，保底覆盖所有座位的空缺；各座位视图可见新到教练与新闻，并可经 RPC 签下新到教练', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 23,
      players: [
        { sessionId: 's0', name: '玩家1', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '玩家2', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
        { sessionId: 's2', name: '玩家3', newClub: { name: 'Gamma Club', tag: 'GAM', region: 'SEA', color: '#d4a017' } },
      ],
    });
    const seats = g.multiplayer!.order;
    expect(seats).toHaveLength(3);
    const rec = g.coachSupply!;
    expect(rec.ti).toBe(9);
    // 新俱乐部没有主教练：全部计入空缺；AI 季前签约之后保底依然成立
    for (const id of seats) expect(g.teams[id].coachId).toBeNull();
    expect(rec.vacancies).toBeGreaterThanOrEqual(seats.length);
    expectGuarantee(g);
    expect(g.news.filter((n) => n.title.startsWith('【教练市场】'))).toHaveLength(1);
    for (const id of seats) {
      const v = M.seatView(g, id);
      expect(v.coachSupply).toEqual(rec);
      expect(v.news.some((n) => n.title === `【教练市场】本赛季新增 ${rec.added} 名教练`)).toBe(true);
      expect(Object.values(v.coaches).some((c) => c.teamId === null && c.arrivedTi === 9)).toBe(true);
    }
    // 每个座位都能签下一名新到教练（与单机同一 RPC）
    for (const id of seats) {
      const fresh = freeCoaches(g).filter((c) => isNewArrivalCoach(g, c)).sort((a, b) => a.salary - b.salary)[0];
      expect(fresh).toBeTruthy();
      g.teams[id].gold = Math.max(g.teams[id].gold, fresh.salary * 20);
      const r = M.callAsSeat(g, id, 'hireCoach', [fresh.id]) as { ok: boolean; message: string };
      expect(r.ok, r.message).toBe(true);
      expect(g.teams[id].coachId).toBe(fresh.id);
      expect(g.coaches[fresh.id].teamId).toBe(id);
    }
  });
});

describe('coaches · AI 聘请克制', () => {
  it('aiCoachCandidates：签下后不得跌破可签约下限与 S+ 下限', () => {
    const cfg = CONFIG.coachSupply;
    const pool: Coach[] = [];
    for (let i = 0; i < cfg.minAvailable; i++) pool.push(makeCoach({ id: `p${i}`, tier: 'B' }));
    // 恰好 minAvailable 人：AI 一个都不能签
    expect(aiCoachCandidates(pool, () => true)).toEqual([]);
    pool.push(makeCoach({ id: 'extra', tier: 'B' }));
    expect(aiCoachCandidates(pool, () => true).length).toBe(pool.length);
    // S+ 恰好 minTopTier 人：S+ 不可签，其余可签
    for (let i = 0; i < cfg.minTopTier; i++) pool.push(makeCoach({ id: `top${i}`, tier: i ? 'SS' : 'S' }));
    const c1 = aiCoachCandidates(pool, () => true);
    expect(c1.some(isTopTierCoach)).toBe(false);
    pool.push(makeCoach({ id: 'top-x', tier: 'SSR' }));
    expect(aiCoachCandidates(pool, () => true).filter(isTopTierCoach).length).toBe(cfg.minTopTier + 1);
    // 负担不起的排除；有东家的不计
    expect(aiCoachCandidates(pool, (c) => c.tier !== 'B').some((c) => c.tier === 'B')).toBe(false);
    pool.forEach((c) => { if (c.tier === 'B') c.teamId = 'tx'; });
    expect(aiCoachCandidates(pool, () => true)).toEqual([]);
  });

  it('aiCoachPickWeight：与本队等级匹配的教练权重最高，差距越大越低', () => {
    const w = (t: Coach['tier'], target: number) => aiCoachPickWeight(makeCoach({ tier: t }), target);
    expect(w('A', 2)).toBe(1);
    expect(w('S', 2)).toBeLessThan(1);
    expect(w('SSR', 2)).toBeLessThan(w('S', 2));
    expect(w('C', 2)).toBeLessThan(w('B', 2));
    expect(w('SSR', 5)).toBe(1);
  });

  it('季前窗口：AI 只在没有主教练时聘请，市场保底与 S+ 名额不被扫光', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = makeTestState(14, seed * 31);
      s.id = `ai-${seed}`;
      for (const t of Object.values(s.teams)) t.gold = 80_000_000;
      // 两支 AI 已有教练
      const keep1 = makeCoach({ id: 'keep1', teamId: 't1', tier: 'C' });
      const keep2 = makeCoach({ id: 'keep2', teamId: 't2', tier: 'B' });
      s.coaches.keep1 = keep1;
      s.coaches.keep2 = keep2;
      s.teams.t1.coachId = 'keep1';
      s.teams.t2.coachId = 'keep2';
      seasonCoachSupply(s);
      const target = coachSupplyTarget(s);
      expect(freeCoaches(s).length).toBeGreaterThanOrEqual(target.available);
      withConfig('ai', { coachHireChance: 1 }, () => aiTransferWindow(s, 'preseason'));
      expect(s.teams.t1.coachId).toBe('keep1');
      expect(s.teams.t2.coachId).toBe('keep2');
      expect(s.teams.t0.coachId).toBeNull(); // 玩家战队不被 AI 安排
      expectGuarantee(s);
      // AI 确实在聘请（有可签名额时）
      const hired = Object.values(s.teams).filter((t) => !t.isPlayer && t.coachId && !['keep1', 'keep2'].includes(t.coachId));
      expect(hired.length).toBeGreaterThan(0);
    }
  });

  it('AI 不总挑最好的：多局中弱队聘请的教练平均等级低于市场最高等级', () => {
    let hiredTierSum = 0;
    let hiredN = 0;
    let bestSum = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const s = makeTestState(10, seed * 7);
      s.id = `pick-${seed}`;
      for (const t of Object.values(s.teams)) t.gold = 80_000_000;
      for (const p of Object.values(s.players)) p.mmr = 3000; // 弱队：首发等级低
      seasonCoachSupply(s);
      const best = Math.max(...freeCoaches(s).map((c) => TIERS.indexOf(c.tier)));
      withConfig('ai', { coachHireChance: 1 }, () => aiTransferWindow(s, 'preseason'));
      for (const t of Object.values(s.teams)) {
        if (t.isPlayer || !t.coachId) continue;
        hiredTierSum += TIERS.indexOf(s.coaches[t.coachId].tier);
        hiredN++;
        bestSum += best;
      }
    }
    expect(hiredN).toBeGreaterThan(10);
    expect(hiredTierSum / hiredN).toBeLessThan(bestSum / hiredN - 0.75);
  });
});
