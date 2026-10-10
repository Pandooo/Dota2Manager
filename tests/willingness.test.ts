import { describe, it, expect } from 'vitest';
import { makeTestState, makePlayer } from './helpers';
import { playerWillingness, willingnessJitter } from '../src/engine/market';
import { CONFIG } from '../src/engine/config';
import { withConfig } from './e4-fakes/mocks';

describe('选手转会意愿：基础值附近的个体浮动', () => {
  function freeAgents(n: number) {
    const s = makeTestState(2);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const p = makePlayer({ id: `fa${i}`, mmr: 9000, power: 75, teamId: null });
      s.players[p.id] = p;
      ids.push(p.id);
    }
    return { s, ids };
  }

  it('同等级、同属性的选手对同一俱乐部的意愿不再完全相同', () => {
    const { s, ids } = freeAgents(30);
    const values = ids.map((id) => playerWillingness(s, id, 't0'));
    expect(new Set(values.map((v) => v.toFixed(4))).size).toBeGreaterThan(20);
  });

  it('同一赛季内稳定（反复计算结果一致），新赛季重新浮动', () => {
    const { s, ids } = freeAgents(10);
    const a = ids.map((id) => playerWillingness(s, id, 't0'));
    const b = ids.map((id) => playerWillingness(s, id, 't0'));
    expect(b).toEqual(a);
    s.season.ti += 1;
    const c = ids.map((id) => playerWillingness(s, id, 't0'));
    expect(c).not.toEqual(a);
  });

  it('浮动围绕原基础值、有界，且不消耗主随机序列', () => {
    const { s, ids } = freeAgents(400);
    const rng0 = s.rngState;
    const jit = ids.map((id) => willingnessJitter(s, id, 't0'));
    expect(s.rngState).toBe(rng0);
    const max = CONFIG.market.willingnessJitter;
    for (const j of jit) expect(Math.abs(j)).toBeLessThanOrEqual(max + 1e-9);
    const mean = jit.reduce((x, y) => x + y, 0) / jit.length;
    expect(Math.abs(mean)).toBeLessThan(max * 0.1);
    // 关闭浮动时回到原来的「同等级同值」
    withConfig('market', { willingnessJitter: 0 }, () => {
      const vals = ids.slice(0, 10).map((id) => playerWillingness(s, id, 't0'));
      expect(new Set(vals.map((v) => v.toFixed(6))).size).toBe(1);
    });
  });
});
