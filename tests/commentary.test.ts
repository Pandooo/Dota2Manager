import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/engine/team', async () => (await import('./engineMocks')).teamMock);
vi.mock('../src/engine/player', async () => (await import('./engineMocks')).playerMock);

import { generateLive, liveTemplateCount } from '../src/engine/commentary';
import type { LiveContext } from '../src/engine/commentary';
import { createDraft, runDraftUntil } from '../src/engine/draft';
import { heroName } from '../src/engine/heroes';
import { CONFIG } from '../src/engine/config';
import type { GameState, LiveEvent } from '../src/engine/types';
import { seededRng } from '../src/engine/rng';
import { makeTestState } from './helpers';

function ctxFor(s: GameState, over: Partial<LiveContext> = {}): LiveContext {
  const d = createDraft(s);
  runDraftUntil(s, d, 't0', 't1', null);
  return {
    teamA: 't0',
    teamB: 't1',
    radiant: 'A',
    draft: d.actions,
    winner: 'A',
    durationMin: 38,
    killsA: 30,
    killsB: 18,
    incidents: [],
    winProbA: 0.6,
    ...over,
  };
}

function secs(e: LiveEvent): number {
  return e.minute * 60 + e.second;
}

/** 校验时间线不变量，返回出错描述（空 = 通过） */
function check(live: LiveEvent[], ctx: LiveContext): string[] {
  const errs: string[] = [];
  if (live.length < 25 || live.length > 60) errs.push(`条数 ${live.length}`);
  if (live[0]?.type !== 'start' || secs(live[0]) !== 0) errs.push('首条不是开局');
  const last = live[live.length - 1];
  if (last?.type !== 'gg') errs.push('末条不是 GG');
  if (last && (last.killsA !== ctx.killsA || last.killsB !== ctx.killsB)) errs.push(`终局比分 ${last.killsA}:${last.killsB}`);
  if (last && last.minute !== Math.max(10, ctx.durationMin)) errs.push(`GG 分钟 ${last.minute}`);
  for (let i = 1; i < live.length; i++) {
    const p = live[i - 1];
    const c = live[i];
    if (secs(c) <= secs(p)) errs.push(`时间未递增 @${i}`);
    if (c.killsA < p.killsA || c.killsB < p.killsB) errs.push(`比分回退 @${i}`);
    if (c.second < 0 || c.second > 59) errs.push(`秒数越界 @${i}`);
  }
  for (const e of live) {
    if (/\{\w+\}|undefined|NaN/.test(e.text)) errs.push(`文案异常：${e.text}`);
    if (!Number.isFinite(e.goldDiff)) errs.push('经济差非法');
  }
  const fb = live.findIndex((e) => e.type === 'firstblood');
  const firstKill = live.findIndex((e) => e.killsA + e.killsB > 0);
  if (ctx.killsA + ctx.killsB > 0 && fb !== firstKill) errs.push('一血不是第一次击杀');
  return errs;
}

describe('commentary: 模板', () => {
  it('至少 60 个不同模板', () => {
    expect(liveTemplateCount()).toBeGreaterThanOrEqual(60);
  });
});

describe('commentary: 时间线一致性', () => {
  it('基础场景：条数、时间、比分、GG', () => {
    const s = makeTestState(2, 3);
    const ctx = ctxFor(s);
    const live = generateLive(s, ctx);
    expect(check(live, ctx)).toEqual([]);
    const all = live.map((e) => e.text).join('\n');
    expect(all).toMatch(/天辉|夜魇/);
    // 使用英雄中文名与选手 ID
    const heroCn = ctx.draft.filter((a) => a.type === 'pick').map((a) => heroName(a.heroId));
    expect(heroCn.some((cn) => all.includes(cn))).toBe(true);
    expect(all).toContain('t0_');
    // 胜方赛前胜率不低 → 终局经济领先
    expect(live[live.length - 1].goldDiff).toBeGreaterThan(0);
  });

  it('大量随机场景均满足不变量', () => {
    const s = makeTestState(2, 17);
    const base = ctxFor(s);
    const r = seededRng(2024);
    const [dLo, dHi] = CONFIG.match.durationRange;
    for (let i = 0; i < 400; i++) {
      const total = r.int(CONFIG.match.killsRange[0], CONFIG.match.killsRange[1]);
      const kA = r.int(0, total);
      const ctx: LiveContext = {
        ...base,
        radiant: r.chance(0.5) ? 'A' : 'B',
        winner: r.chance(0.5) ? 'A' : 'B',
        durationMin: r.int(dLo, dHi),
        killsA: kA,
        killsB: total - kA,
        winProbA: r.range(0.05, 0.95),
        incidents: r.chance(0.5)
          ? [{ minute: r.int(2, 35), playerId: 't1-M', teamId: 't1', text: 't1_M 心态爆炸', powerMult: 0.85 }]
          : [],
      };
      const live = generateLive(s, ctx);
      const errs = check(live, ctx);
      if (errs.length) throw new Error(`场景 ${i}: ${errs.join('; ')}`);
      // 非翻盘剧本（胜方赛前胜率不低）→ 胜方终局经济领先
      const pW = ctx.winner === 'A' ? ctx.winProbA : 1 - ctx.winProbA;
      const last = live[live.length - 1];
      if (pW >= CONFIG.match.comebackWinProb) expect(last.goldDiff * (ctx.winner === 'A' ? 1 : -1)).toBeGreaterThan(0);
      if (ctx.incidents.length) expect(live.some((e) => e.type === 'incident' && e.text.includes('心态爆炸'))).toBe(true);
    }
  });

  it('「暴走」与「超神」各用各的事件类型（标签与文本一致）', () => {
    const s = makeTestState(2, 23);
    const base = ctxFor(s);
    let rampages = 0;
    let godlikes = 0;
    for (let i = 0; i < 300; i++) {
      const live = generateLive(s, { ...base, killsA: 55, killsB: 8, durationMin: 50, winner: 'A', winProbA: 0.8 });
      for (const e of live) {
        if (e.type === 'rampage') {
          rampages++;
          expect(e.text).toMatch(/暴走|RAMPAGE/);
          expect(e.text).not.toContain('超神');
        }
        if (e.type === 'godlike') {
          godlikes++;
          expect(e.text).toContain('超神');
        }
      }
    }
    expect(rampages).toBeGreaterThan(0);
    expect(godlikes).toBeGreaterThan(0);
  });

  it('低胜率方获胜时会出现翻盘剧情；经济先落后后反超', () => {
    let comebacks = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = makeTestState(2, seed);
      const ctx = ctxFor(s, { winner: 'A', winProbA: 0.15, durationMin: 45, killsA: 34, killsB: 30 });
      const live = generateLive(s, ctx);
      expect(check(live, ctx)).toEqual([]);
      if (live.some((e) => e.type === 'comeback')) {
        comebacks++;
        expect(Math.min(...live.map((e) => e.goldDiff))).toBeLessThan(-2000);
      }
    }
    expect(comebacks).toBeGreaterThan(10);
  });

  it('击杀方事件推动经济向己方变化', () => {
    const s = makeTestState(2, 8);
    const ctx = ctxFor(s);
    const live = generateLive(s, ctx);
    for (let i = 1; i < live.length; i++) {
      const e = live[i];
      if (!e.side || !['tower', 'roshan', 'barracks', 'highground'].includes(e.type)) continue;
      if (e.type === 'highground' && /无果|撤退|防守成功|失败/.test(e.text)) continue;
      const d = e.goldDiff - live[i - 1].goldDiff;
      expect(d * (e.side === 'A' ? 1 : -1)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('commentary: 边界情况', () => {
  it('无 BP、0 击杀、极短时长、战队缺失均不崩溃', () => {
    const s = makeTestState(2, 4);
    const cases: LiveContext[] = [
      { teamA: 't0', teamB: 't1', radiant: 'B', draft: [], winner: 'B', durationMin: 25, killsA: 0, killsB: 0, incidents: [], winProbA: 0.5 },
      { teamA: 't0', teamB: 't1', radiant: 'A', draft: [], winner: 'A', durationMin: 5, killsA: 1, killsB: 0, incidents: [], winProbA: 0.9 },
      { teamA: 'ghost', teamB: 'nobody', radiant: 'A', draft: [], winner: 'B', durationMin: 30, killsA: 10, killsB: 20, incidents: [], winProbA: 0.3 },
      { teamA: 't0', teamB: 't1', radiant: 'A', draft: [], winner: 'A', durationMin: 62, killsA: 75, killsB: 0, incidents: [], winProbA: 0.95 },
    ];
    for (const ctx of cases) {
      const live = generateLive(s, ctx);
      expect(check(live, ctx)).toEqual([]);
    }
  });

  it('MVP 在胜方击杀中更活跃并在 GG 时可被点名', () => {
    let mentioned = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = makeTestState(2, seed);
      const ctx = ctxFor(s, { mvpPlayerId: 't0-HS' });
      const live = generateLive(s, ctx);
      if (live.some((e) => e.text.includes('t0_HS'))) mentioned++;
    }
    expect(mentioned).toBeGreaterThan(15);
  });

  it('直播输出的个人击杀 / 阵亡（kdOut）与比分一致，分布贴近真实：核心位杀得多、辅助死得多，单人 20 杀以上罕见', () => {
    const k: Record<string, number> = {};
    const d: Record<string, number> = {};
    let over20 = 0;
    let lines = 0;
    const N = 160;
    for (let seed = 1; seed <= N; seed++) {
      const s = makeTestState(2, seed * 7);
      const kA = 15 + (seed % 20);
      const kB = 8 + (seed % 13);
      const kd: Record<string, [number, number]> = {};
      generateLive(s, ctxFor(s, { killsA: kA, killsB: kB, durationMin: 30 + (seed % 25), kdOut: kd }));
      const onA = Object.keys(kd).filter((id) => id.startsWith('t0'));
      expect(onA.reduce((x, id) => x + kd[id][0], 0)).toBe(kA);
      expect(onA.reduce((x, id) => x + kd[id][1], 0)).toBe(kB);
      for (const [id, [kk, dd]] of Object.entries(kd)) {
        const pos = id.split('-')[1];
        k[pos] = (k[pos] ?? 0) + kk;
        d[pos] = (d[pos] ?? 0) + dd;
        if (kk > 20) over20++;
        lines++;
      }
    }
    expect(k.C).toBeGreaterThan(k.O);
    expect(k.M).toBeGreaterThan(k.SS);
    expect(k.O).toBeGreaterThan(k.HS * 1.5);
    expect(d.HS).toBeGreaterThan(d.C * 1.4);
    expect(over20 / lines).toBeLessThan(0.01);
  });

  it('直播的个人击杀按本局份额抽取（与快速模拟同口径）：没有逐次独立抽取多出的方差，辅助不会偶尔拿下近半击杀', () => {
    const share: Record<string, number[]> = {};
    let big = 0;
    let lines = 0;
    let hsMax = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const s = makeTestState(2, seed * 13);
      const kd: Record<string, [number, number]> = {};
      generateLive(s, ctxFor(s, { killsA: 36, killsB: 20, durationMin: 42, kdOut: kd }));
      for (const [id, [kk]] of Object.entries(kd)) {
        if (!id.startsWith('t0')) continue;
        const pos = id.split('-')[1];
        (share[pos] ??= []).push(kk / 36);
        lines++;
        if (kk / 36 > 0.45) big++;
        if (pos === 'HS') hsMax = Math.max(hsMax, kk);
      }
    }
    const sd = (a: number[]) => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    };
    // 逐次独立按权重抽取时：5 号位击杀占比 σ ≈ 0.06、最多 15 杀，单人拿下 45% 以上击杀约 3%
    expect(sd(share.HS)).toBeLessThan(0.045);
    expect(sd(share.C)).toBeLessThan(0.09);
    expect(hsMax).toBeLessThanOrEqual(10);
    expect(big / lines).toBeLessThan(0.015);
  });
});

describe('commentary: 局面合理性', () => {
  it('单次事件一方最多阵亡 5 人（一边倒比分也成立）；推塔不晚于上高地', () => {
    const s = makeTestState(2, 31);
    const base = ctxFor(s);
    const r = seededRng(77);
    const [dLo, dHi] = CONFIG.match.durationRange;
    for (let i = 0; i < 300; i++) {
      const D = r.int(dLo, dHi);
      const total = Math.min(CONFIG.match.killsRange[1], Math.max(CONFIG.match.killsRange[0], Math.round(D * r.range(0.9, 1.8))));
      const lopsided = r.chance(0.5);
      const kA = lopsided ? total - r.int(0, 3) : r.int(0, total);
      const ctx: LiveContext = { ...base, winner: kA * 2 >= total ? 'A' : 'B', durationMin: D, killsA: kA, killsB: total - kA, winProbA: r.range(0.1, 0.9) };
      const live = generateLive(s, ctx);
      expect(check(live, ctx)).toEqual([]);
      let pa = 0;
      let pb = 0;
      let hgDone = false;
      for (const e of live) {
        expect(e.killsA - pa).toBeLessThanOrEqual(5);
        expect(e.killsB - pb).toBeLessThanOrEqual(5);
        pa = e.killsA;
        pb = e.killsB;
        if (e.type === 'highground' && e.side === ctx.winner && !/无果|撤退|防守成功|失败|守住|打退/.test(e.text)) hgDone = true;
        if (hgDone) expect(e.type).not.toBe('tower');
      }
    }
  });

  it('早期比赛的直播不出现后来版本才有的地图元素/物品/神符', () => {
    const s = makeTestState(2, 5);
    s.currentDate = '2011-08-01';
    const base = ctxFor(s);
    const r = seededRng(11);
    const all: string[] = [];
    for (let i = 0; i < 200; i++) {
      const live = generateLive(s, { ...base, durationMin: r.int(22, 62), winner: r.chance(0.5) ? 'A' : 'B', winProbA: r.range(0.1, 0.9) });
      all.push(...live.map((e) => e.text));
    }
    const text = all.join('\n');
    for (const k of ['传送门', '赏金神符', '奥术神符', '否决坠饰']) expect(text).not.toContain(k);
    // 新版本可以出现
    s.currentDate = '2024-01-01';
    const later: string[] = [];
    for (let i = 0; i < 200; i++) later.push(...generateLive(s, { ...base, durationMin: 40 }).map((e) => e.text));
    expect(later.join('\n')).toContain('传送门');
  });
});
