// 抽卡（已退役）：第八波起取消玩家抽卡，改为每个赛季初的 NBA 式新秀选秀（rookieDraft.ts）。
// 本模块只保留可复用的概率工具：
//   - luckAdjustedWeights：荣誉幸运度对等级权重的修正（临时替补、自由市场等通用）；
//   - prdConstant：伪随机分布（PRD）常数（选秀新秀池的 SSR 伪随机 + 保底复用）。
import type { Tier } from './types';
import { TIERS } from './types';
import { CONFIG } from './config';

/** 荣誉幸运度修正：w × exp(luck × luckSlope[tier])（临时替补等通用） */
export function luckAdjustedWeights(base: Record<Tier, number>, luck: number): Record<Tier, number> {
  const l = Number.isFinite(luck) ? luck : 0;
  const out = {} as Record<Tier, number>;
  for (const t of TIERS) {
    out[t] = Math.max(0, base[t] ?? 0) * Math.exp(l * (CONFIG.gacha.luckSlope[t] ?? 0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSR 伪随机分布（PRD，与 Dota 2 暴击/闪避的伪随机同理）：
// 距上次 SSR 第 k 次的 SSR 概率 = min(1, C × k)，C 取使长期平均概率等于名义概率 p 的常数。
// ---------------------------------------------------------------------------
const prdCache = new Map<number, number>();

/** PRD 常数 C（名义概率 p 下），二分求解 */
export function prdConstant(p: number): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  const key = Math.round(p * 1e9);
  const hit = prdCache.get(key);
  if (hit !== undefined) return hit;
  const avgFor = (c: number) => {
    // 期望次数 E[N]，平均概率 = 1/E[N]
    let notYet = 1;
    let expected = 0;
    for (let k = 1; notYet > 1e-12; k++) {
      const pk = Math.min(1, c * k);
      expected += k * notYet * pk;
      notYet *= 1 - pk;
      if (k > 1e7) break;
    }
    return 1 / expected;
  };
  let lo = 0;
  let hi = p;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (avgFor(mid) < p) lo = mid;
    else hi = mid;
  }
  const c = (lo + hi) / 2;
  prdCache.set(key, c);
  return c;
}
