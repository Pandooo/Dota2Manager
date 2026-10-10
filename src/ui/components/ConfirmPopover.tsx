// ============================================================================
// 就近确认：替代二次确认弹窗（Modal）。点击按钮后在按钮旁弹出小气泡，
// 「确定」按钮紧贴原按钮位置，减少鼠标移动距离；Esc / 点击外部取消，Enter 确定。
//
// 用法：
//   <ConfirmButton variant="secondary" confirm={{ message: '将自动打完本赛事剩余比赛', confirmLabel: '模拟' }}
//                  onConfirm={() => call('quickSimTournament')}>快速模拟整项赛事</ConfirmButton>
// 也可直接用 useConfirmPopover() 给任意元素挂确认气泡。
// ============================================================================
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Button, cx } from './common';

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
}

const POPOVER_WIDTH = 280;
const GAP = 8;

function computePos(anchor: DOMRect, height: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 优先显示在按钮上方（底栏按钮最常见），空间不足时放到下方
  const placement: Placement = anchor.top - height - GAP >= 8 || anchor.bottom + height + GAP > vh ? 'top' : 'bottom';
  const top = placement === 'top' ? Math.max(8, anchor.top - height - GAP) : Math.min(vh - height - 8, anchor.bottom + GAP);
  // 让气泡右下角的「确定」按钮尽量落在原按钮正上 / 正下方：气泡右边缘对齐按钮中心偏右
  const center = anchor.left + anchor.width / 2;
  let left = center - POPOVER_WIDTH + 70;
  left = Math.min(Math.max(8, left), vw - POPOVER_WIDTH - 8);
  return { left, top, placement };
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

  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    const h = boxRef.current?.offsetHeight ?? 120;
    setPos(computePos(a, h));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
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
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
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
        'fade-up fixed z-[80] rounded-lg border bg-panel-2 p-3 text-sm shadow-2xl shadow-black/60',
        spec.danger ? 'border-bad/50' : 'border-gold/40',
      )}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POPOVER_WIDTH }}
    >
      {spec.title && <div className="mb-1 font-semibold text-ink">{spec.title}</div>}
      <div className="text-xs leading-relaxed text-mute">{spec.message}</div>
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {spec.cancelLabel ?? '取消'}
        </Button>
        <Button size="sm" variant={spec.danger ? 'danger' : 'gold'} onClick={onConfirm} autoFocus>
          {spec.confirmLabel ?? '确定'}
        </Button>
      </div>
      {/* 指向按钮的小三角 */}
      <span
        className={cx(
          'absolute right-[62px] h-2.5 w-2.5 rotate-45 border bg-panel-2',
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

/** 带就近确认的按钮：点击 → 气泡确认 → onConfirm。confirm 为 null/undefined 时直接执行 */
export function ConfirmButton({
  confirm,
  onConfirm,
  children,
  variant,
  size,
  className,
  disabled,
  title,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  confirm?: ConfirmSpec | null;
  onConfirm: () => void;
  variant?: Parameters<typeof Button>[0]['variant'];
  size?: Parameters<typeof Button>[0]['size'];
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const ok = () => {
    setOpen(false);
    onConfirm();
  };
  return (
    <span ref={anchorRef} className="inline-flex">
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
