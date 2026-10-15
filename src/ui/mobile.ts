// ============================================================================
// 手机适配的公共钩子（v0.4，docs/UI.md「手机适配」）。纯界面工具，不读写游戏状态。
// - 断点与 Tailwind 默认一致：手机 < sm（640）、无侧栏 < md（768）、桌面 ≥ lg（1024）。
// - useMediaQuery：同一个查询共用一个 MediaQueryList 与监听（每个 Button 都会订阅「是否触屏」，不能各建一个）。
// - useChromeVar：把顶栏 / 底栏的实际占位写进 CSS 变量（--chrome-top = 顶栏底边到视口顶部的距离，
//   --chrome-bottom = 底栏顶边到视口底部的距离，都含安全区），提示、横幅、底部抽屉据此避开两条栏。
// ============================================================================
import { useCallback, useSyncExternalStore } from 'react';

export const BREAKPOINT = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const;

/** 手机布局（< sm） */
export const PHONE_QUERY = `(max-width: ${BREAKPOINT.sm - 0.02}px)`;
/** 触屏为主的设备（手机 / 平板；触屏笔记本的主指针是触控板，不算） */
export const COARSE_QUERY = '(pointer: coarse)';

interface MqStore {
  mql: MediaQueryList | null;
  subs: Set<() => void>;
}
const stores = new Map<string, MqStore>();

function storeOf(query: string): MqStore {
  let s = stores.get(query);
  if (s) return s;
  let mql: MediaQueryList | null = null;
  try {
    mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    mql = null;
  }
  const store: MqStore = { mql, subs: new Set() };
  const notify = () => store.subs.forEach((f) => f());
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', notify);
    else (mql as MediaQueryList & { addListener?: (f: () => void) => void }).addListener?.(notify);
  }
  stores.set(query, store);
  return store;
}

/** 当前是否匹配（非浏览器环境返回 fallback） */
export function matchesQuery(query: string, fallback = false): boolean {
  const m = storeOf(query).mql;
  return m ? m.matches : fallback;
}

/** 订阅媒体查询；跨过断点时重渲染 */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const s = storeOf(query);
      s.subs.add(cb);
      return () => {
        s.subs.delete(cb);
      };
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matchesQuery(query, fallback),
    () => fallback,
  );
}

/** 视口宽度不小于 px（不支持 matchMedia 的环境按宽屏处理） */
export function useMinWidth(px: number): boolean {
  return useMediaQuery(`(min-width: ${px}px)`, true);
}

/** 手机布局（< 640px） */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** 横屏手机等矮视口（与 index.css 的 short 变体同一查询） */
export const SHORT_QUERY = '(max-height: 480px)';

/**
 * 是否显示左侧侧栏：≥ md，且不是横屏手机（矮视口且 < lg）。横屏手机只有约 390px 高，160px 宽的侧栏会把内容挤得很窄，
 * 改用顶栏 ☰ 的导航抽屉；≥ lg 的窗口即使很矮也保留侧栏（桌面布局不变）。App（侧栏）、TopBar（☰）、导航抽屉（自动收起）共用。
 */
export function useSideNav(): boolean {
  const md = useMinWidth(BREAKPOINT.md);
  const lg = useMinWidth(BREAKPOINT.lg);
  const short = useMediaQuery(SHORT_QUERY);
  return md && (lg || !short);
}

/** 触屏为主的设备：禁用按钮点击时显示原因、按钮加大触控高度等 */
export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_QUERY);
}

export function isCoarsePointer(): boolean {
  return matchesQuery(COARSE_QUERY);
}

/**
 * 把元素占据的屏幕边缘高度写进 CSS 变量（挂在 <html> 上）：edge = 'top' 时为元素底边到视口顶部，
 * 'bottom' 时为元素顶边到视口底部。返回 ref 回调（React 19：返回的函数在元素卸载时调用，此时移除变量）。
 */
export function useChromeVar(cssVar: '--chrome-top' | '--chrome-bottom', edge: 'top' | 'bottom') {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || typeof document === 'undefined') return;
      const root = document.documentElement;
      const set = () => {
        const r = el.getBoundingClientRect();
        const v = edge === 'top' ? r.bottom : window.innerHeight - r.top;
        root.style.setProperty(cssVar, `${Math.max(0, Math.round(v))}px`);
      };
      set();
      const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(set) : null;
      ro?.observe(el);
      window.addEventListener('resize', set);
      return () => {
        ro?.disconnect();
        window.removeEventListener('resize', set);
        root.style.removeProperty(cssVar);
      };
    },
    [cssVar, edge],
  );
}

/** 读取 CSS 变量里的像素值（未设置时为 fallback） */
export function chromePx(cssVar: '--chrome-top' | '--chrome-bottom', fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar));
  return Number.isFinite(v) ? v : fallback;
}
