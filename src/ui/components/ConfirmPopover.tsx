// ============================================================================
// 就近确认：替代二次确认弹窗（Modal）。点击按钮后在按钮旁弹出小气泡，
// 「确定」按钮紧贴原按钮位置，减少鼠标移动距离；Esc / 点击外部取消，Enter 确定。
// 手机：气泡宽度不超过视口（左右各留 8px），点按外部（pointerdown）取消，触屏上确定 / 取消为常规尺寸按钮。
// 气泡从不盖住触发按钮：上下都放不下时放在空间较大的一侧并限制高度（正文滚动，按钮始终可见）；
// 打开后 350ms 内的点按不算确认（横屏矮视口里连点 / 幽灵点击不会直接花钱）。
//
// 用法：
//   <ConfirmButton variant="secondary" confirm={{ message: '将自动打完本赛事剩余比赛', confirmLabel: '模拟' }}
//                  onConfirm={() => call('quickSimTournament')}>快速模拟整项赛事</ConfirmButton>
// 也可直接用 useConfirmPopover() 给任意元素挂确认气泡。
// ============================================================================
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './common';
import { chromePx, useCoarsePointer } from '../mobile';

export interface ConfirmSpec {
  /** 气泡正文 */
  message: ReactNode;
  /** 可选标题（一行，加粗） */
  title?: ReactNode;
  /** 确定按钮文字，默认「确定」 */
  confirmLabel?: string;
  /** 取消按钮文字，默认「取消」 */
  cancelLabel?: string;
  /** 危险操作：确定按钮用红色 */
  danger?: boolean;
}

type Placement = 'top' | 'bottom';

interface Pos {
  left: number;
  top: number;
  placement: Placement;
  /** 可用高度（不盖住按钮）：气泡最高这么高，超出时正文滚动 */
  maxH: number;
  /** 小三角距气泡右边缘的距离：指向按钮中心（气泡被视口夹住时也指得准；不夹时为 62px，与以前相同） */
  arrowRight: number;
}

const POPOVER_WIDTH = 280;
const GAP = 8;
/** 打开后这段时间内的点按不触发确认（防止双击 / 幽灵点击落在刚弹出的「确定」上） */
const CONFIRM_GUARD_MS = 350;

/** 气泡宽度：手机上不超过视口（左右各留 8px） */
function popoverWidth(): number {
  return Math.min(POPOVER_WIDTH, window.innerWidth - 16);
}

function computePos(anchor: DOMRect, height: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = popoverWidth();
  // 让气泡右下角的「确定」按钮尽量落在原按钮正上 / 正下方：气泡右边缘对齐按钮中心偏右
  const center = anchor.left + anchor.width / 2;
  const left = Math.min(Math.max(8, center - w + 70), vw - w - 8);
  const arrowRight = Math.min(Math.max(10, left + w - center - 8), w - 20);
  // 按钮上方 / 下方可用的高度：先在顶栏与底栏之间找（--chrome-top / --chrome-bottom，游戏外为 0），距边缘留 8px
  const topLimit = Math.max(8, chromePx('--chrome-top', 0) + 8);
  const bottomLimit = Math.min(vh - 8, vh - chromePx('--chrome-bottom', 0) - 8);
  const inAbove = anchor.top - GAP - topLimit;
  const inBelow = bottomLimit - anchor.bottom - GAP;
  // 优先显示在按钮上方（底栏按钮最常见），放不下时放到下方
  if (height <= inAbove) return { left, top: anchor.top - GAP - height, placement: 'top', maxH: inAbove, arrowRight };
  if (height <= inBelow) return { left, top: anchor.bottom + GAP, placement: 'bottom', maxH: inBelow, arrowRight };
  // 两栏之间放不下（横屏矮视口）：可以压住顶栏 / 底栏，但不压住按钮——放在空间较大的一侧，限制高度（正文滚动）
  const above = Math.max(0, anchor.top - GAP - 8);
  const below = Math.max(0, vh - 8 - anchor.bottom - GAP);
  const placement: Placement = height <= above ? 'top' : height <= below ? 'bottom' : above >= below ? 'top' : 'bottom';
  const room = placement === 'top' ? above : below;
  if (room < 120) {
    // 极端情况（两侧都不到 120px）：在视口内居中放置，允许压住按钮（打开后的防误触仍然有效）
    const maxH = vh - 16;
    return { left, top: Math.max(8, (vh - Math.min(height, maxH)) / 2), placement, maxH, arrowRight };
  }
  const h = Math.min(height, room);
  return { left, top: placement === 'top' ? anchor.top - GAP - h : anchor.bottom + GAP, placement, maxH: room, arrowRight };
}

/** 确认气泡（受控）：anchorRef 指向触发元素 */
export function ConfirmPopover({
  open,
  anchorRef,
  spec,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  spec: ConfirmSpec;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  // 触屏：确定 / 取消用常规尺寸按钮（≥ 40px 高），减少误触
  const coarse = useCoarsePointer();
  // 打开时刻（防误触：打开后 CONFIRM_GUARD_MS 内点按「确定」不生效）
  const openedAt = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    // 量内容的自然高度（不受上一次限高影响）：气泡高度 − 正文可见高度 + 正文完整高度
    const box = boxRef.current;
    const body = bodyRef.current;
    const h = box && body ? box.offsetHeight - body.clientHeight + body.scrollHeight : 120;
    setPos(computePos(a, h));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    openedAt.current = performance.now();
    place();
    // 首帧量到真实高度后再校正一次
    const id = requestAnimationFrame(place);
    return () => cancelAnimationFrame(id);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        // 焦点在气泡外的输入框（如多人聊天）时，回车属于输入框，不触发确认
        const el = document.activeElement as HTMLElement | null;
        const typing = !!el && !boxRef.current?.contains(el) && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
        if (typing) return;
        e.preventDefault();
        onConfirm();
      }
    };
    // pointerdown（而不是 mousedown）：iOS Safari 点按页面空白处不发 mousedown，气泡会关不掉
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, onCancel, onConfirm, anchorRef, place]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-modal="false"
      className={cx(
        'fade-up fixed z-[80] flex max-h-[calc(100dvh_-_16px)] flex-col rounded-lg border bg-panel-2 p-3 text-sm shadow-2xl shadow-black/60',
        spec.danger ? 'border-bad/50' : 'border-gold/40',
      )}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        width: typeof window === 'undefined' ? POPOVER_WIDTH : popoverWidth(),
        maxHeight: pos ? pos.maxH : undefined,
      }}
    >
      {/* 标题与正文在可滚动区域里，确定 / 取消始终可见 */}
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {spec.title && <div className="mb-1 font-semibold text-ink">{spec.title}</div>}
        <div className="text-xs leading-relaxed text-mute">{spec.message}</div>
      </div>
      <div className="mt-2.5 flex shrink-0 justify-end gap-2">
        <Button size={coarse ? 'md' : 'sm'} variant="ghost" className="whitespace-nowrap" onClick={onCancel}>
          {spec.cancelLabel ?? '取消'}
        </Button>
        <Button
          size={coarse ? 'md' : 'sm'}
          variant={spec.danger ? 'danger' : 'gold'}
          className="whitespace-nowrap"
          onClick={() => {
            if (performance.now() - openedAt.current < CONFIRM_GUARD_MS) return;
            onConfirm();
          }}
          autoFocus
        >
          {spec.confirmLabel ?? '确定'}
        </Button>
      </div>
      {/* 指向按钮的小三角 */}
      <span
        style={{ right: pos?.arrowRight ?? 62 }}
        className={cx(
          'absolute h-2.5 w-2.5 rotate-45 border bg-panel-2',
          spec.danger ? 'border-bad/50' : 'border-gold/40',
          pos?.placement === 'bottom' ? '-top-1.5 border-b-0 border-r-0' : '-bottom-1.5 border-l-0 border-t-0',
        )}
      />
    </div>,
    document.body,
  );
}

/** 给任意触发元素挂确认气泡 */
export function useConfirmPopover<T extends HTMLElement = HTMLButtonElement>() {
  const anchorRef = useRef<T>(null);
  const [open, setOpen] = useState(false);
  return { anchorRef, open, ask: () => setOpen(true), close: () => setOpen(false) };
}

/**
 * 带就近确认的按钮：点击 → 气泡确认 → onConfirm。confirm 为 null/undefined 时直接执行。
 * wrapClassName：外层 span（气泡锚点）的类名，如手机上让按钮占满一行（`flex-1` / 网格单元里的按钮配 className="w-full"）。
 */
export function ConfirmButton({
  confirm,
  onConfirm,
  children,
  variant,
  size,
  className,
  wrapClassName,
  disabled,
  title,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  confirm?: ConfirmSpec | null;
  onConfirm: () => void;
  variant?: Parameters<typeof Button>[0]['variant'];
  size?: Parameters<typeof Button>[0]['size'];
  wrapClassName?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const ok = () => {
    setOpen(false);
    onConfirm();
  };
  return (
    <span ref={anchorRef} className={cx('inline-flex', wrapClassName)}>
      <Button
        {...rest}
        variant={variant}
        size={size}
        className={className}
        disabled={disabled}
        title={title}
        onClick={() => (confirm ? setOpen((o) => !o) : onConfirm())}
      >
        {children}
      </Button>
      {confirm && <ConfirmPopover open={open} anchorRef={anchorRef} spec={confirm} onConfirm={ok} onCancel={() => setOpen(false)} />}
    </span>
  );
}
