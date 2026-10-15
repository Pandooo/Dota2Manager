// ============================================================================
// 触屏说明气泡（v0.4，docs/UI.md「手机适配 · 触屏说明」）：触屏没有悬停，`title` 里的说明看不到。
// - common.tsx 的 Button：触屏上「禁用 + 有 title」的按钮不再用原生 disabled（原生禁用的按钮收不到点击），
//   改为 aria-disabled + 半透明，点击时在按钮旁显示 title（禁用原因）——AGENTS.md「按钮禁用时用 title 说明原因」在手机上同样成立。
// - 其他只靠 title 说明的元素可直接调用 showTouchTip(元素, 文字)。
// 气泡在元素上方（放不下时在下方），4 秒后或下一次点按页面任意位置时收起；App 里挂载一次 <TouchTipHost />。
// 只是界面提示，不修改游戏状态。
// ============================================================================
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

interface Tip {
  id: number;
  text: string;
  rect: { top: number; bottom: number; left: number; width: number };
}

let current: Tip | null = null;
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** 在元素旁显示说明（同一时间只显示一个） */
export function showTouchTip(el: Element, text: string): void {
  const t = text.trim();
  if (!t) return;
  const r = el.getBoundingClientRect();
  current = { id: ++seq, text: t, rect: { top: r.top, bottom: r.bottom, left: r.left, width: r.width } };
  emit();
}

export function hideTouchTip(): void {
  if (!current) return;
  current = null;
  emit();
}

const TIP_MS = 4000;
const MAX_W = 300;
const GAP = 8;

export function TouchTipHost() {
  const tip = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => current,
    () => null,
  );
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ id: number; left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!tip) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(MAX_W, vw - 16);
    const h = boxRef.current?.offsetHeight ?? 60;
    const above = tip.rect.top - h - GAP >= 8 || tip.rect.bottom + h + GAP > vh;
    const top = above ? Math.max(8, tip.rect.top - h - GAP) : Math.min(vh - h - 8, tip.rect.bottom + GAP);
    const center = tip.rect.left + tip.rect.width / 2;
    const left = Math.min(Math.max(8, center - width / 2), vw - width - 8);
    setPos({ id: tip.id, left, top, width });
  }, [tip]);

  useEffect(() => {
    if (!tip) return;
    const timer = setTimeout(hideTouchTip, TIP_MS);
    // 下一次点按（不论点在哪里）收起；滚动 / 改变窗口大小时位置失效，也收起
    const onDown = () => hideTouchTip();
    const arm = setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
    window.addEventListener('scroll', onDown, true);
    window.addEventListener('resize', onDown);
    return () => {
      clearTimeout(timer);
      clearTimeout(arm);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onDown, true);
      window.removeEventListener('resize', onDown);
    };
  }, [tip]);

  if (!tip || typeof document === 'undefined') return null;
  const placed = pos && pos.id === tip.id;
  return createPortal(
    <div
      ref={boxRef}
      role="status"
      aria-live="polite"
      className="fade-up pointer-events-none fixed z-[85] max-h-[40vh] overflow-hidden rounded-lg border border-gold/40 bg-panel-2 px-3 py-2 text-xs leading-relaxed whitespace-pre-line text-ink shadow-2xl shadow-black/60"
      style={{ left: placed ? pos.left : -9999, top: placed ? pos.top : -9999, width: placed ? pos.width : Math.min(MAX_W, window.innerWidth - 16) }}
    >
      <span className="mr-1 font-semibold text-gold">ⓘ</span>
      {tip.text}
    </div>,
    document.body,
  );
}
