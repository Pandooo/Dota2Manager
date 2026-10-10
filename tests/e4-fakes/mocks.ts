// E4 测试公用：临时修改 CONFIG 数值（测试结束后恢复）
import { CONFIG } from '../../src/engine/config';

type AnyRec = Record<string, unknown>;

/** 在 fn 执行期间覆盖 CONFIG[section][key]，结束后恢复 */
export function withConfig<T>(section: keyof typeof CONFIG, patch: AnyRec, fn: () => T): T {
  const target = CONFIG[section] as unknown as AnyRec;
  const saved: AnyRec = {};
  for (const k of Object.keys(patch)) {
    saved[k] = target[k];
    target[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) target[k] = saved[k];
  }
}
