// 抽卡已退役（第八波：改为新秀选秀，见 tests/rookieDraft.test.ts）：只保留复用的概率工具
import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/engine/config';
import { TIERS } from '../src/engine/types';
import { luckAdjustedWeights, prdConstant } from '../src/engine/gacha';

/** PRD 常数 c 对应的长期平均概率（1 / 期望次数） */
function prdAverage(c: number): number {
  let notYet = 1;
  let expected = 0;
  for (let k = 1; notYet > 1e-12; k++) {
    const pk = Math.min(1, c * k);
    expected += k * notYet * pk;
    notYet *= 1 - pk;
  }
  return 1 / expected;
}

describe('gacha（通用概率工具）', () => {
  it('PRD 常数：长期平均概率 ≈ 名义概率，且 C < p', () => {
    for (const p of [0.01, 0.05, 0.25]) {
      const c = prdConstant(p);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(p);
      expect(prdAverage(c)).toBeCloseTo(p, 4);
    }
    expect(prdConstant(0)).toBe(0);
    expect(prdConstant(1)).toBe(1);
    expect(prdConstant(Number.NaN)).toBe(0);
  });

  it('荣誉幸运度修正：luck 0 为基础权重，luck 越高高等级权重越大', () => {
    const base = CONFIG.tempSub.baseWeights;
    const w0 = luckAdjustedWeights(base, 0);
    for (const t of TIERS) expect(w0[t]).toBeCloseTo(Math.max(0, base[t] ?? 0), 9);
    const hi = luckAdjustedWeights(base, 2);
    expect(hi.S / hi.C).toBeGreaterThan(w0.S / w0.C);
    expect(luckAdjustedWeights(base, Number.NaN)).toEqual(w0);
  });
});
