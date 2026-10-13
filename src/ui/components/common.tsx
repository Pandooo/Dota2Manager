// ============================================================================
// 通用 UI 组件（所有页面共用，保持风格一致）
// 主题色见 src/index.css @theme：bg / panel / panel-2 / panel-3 / line / ink / mute / faint /
// dota / gold / radiant / dire / good / bad / info / tier-*
// ============================================================================
import { useEffect, type ReactNode, type ButtonHTMLAttributes } from 'react';
import type { Position, Region, Tier, Player } from '../../engine/types';
import { CONFIG, POSITION_LABEL, POSITION_SHORT, REGION_LABEL, formatGold } from '../../engine';
import { useGameStore } from '../../store/gameStore';
import { TeamEmblem } from './TeamEmblem';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold';
const BUTTON_STYLE: Record<ButtonVariant, string> = {
  primary: 'bg-dota hover:bg-dota-2 text-white border border-dota-2/40 shadow-sm shadow-dota/30',
  secondary: 'bg-panel-2 hover:bg-panel-3 text-ink border border-line',
  ghost: 'bg-transparent hover:bg-panel-2 text-mute hover:text-ink border border-transparent',
  danger: 'bg-transparent hover:bg-bad/15 text-bad border border-bad/40',
  gold: 'bg-gold/90 hover:bg-gold text-black border border-gold font-semibold',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const sz = size === 'xs' ? 'px-2 py-0.5 text-xs' : size === 'sm' ? 'px-2.5 py-1 text-xs' : size === 'lg' ? 'px-5 py-2.5 text-base' : 'px-3.5 py-1.5 text-sm';
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md transition-colors cursor-pointer select-none',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-inherit',
        sz,
        BUTTON_STYLE[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Card / Section
// ---------------------------------------------------------------------------
export function Card({
  title,
  subtitle,
  actions,
  className,
  bodyClassName,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-panel/90 shadow-lg shadow-black/20', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h3 className="truncate text-sm font-semibold tracking-wide text-ink">{title}</h3>}
            {subtitle && <div className="truncate text-xs text-mute">{subtitle}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-wide">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-mute">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ text, children }: { text: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-mute">
      <div className="text-2xl opacity-40">◇</div>
      <div>{text}</div>
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-lg border border-line bg-panel-2/60 px-3 py-2', className)}>
      <div className="text-[11px] uppercase tracking-wider text-mute">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular">{value}</div>
      {hint && <div className="text-xs text-faint">{hint}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------
export function Badge({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-none', className ?? 'bg-panel-3 text-mute')}>
      {children}
    </span>
  );
}

export const TIER_TEXT: Record<Tier, string> = {
  C: 'text-tier-c', B: 'text-tier-b', A: 'text-tier-a', S: 'text-tier-s', SS: 'text-tier-ss', SSR: 'ssr-text',
};
const TIER_BG: Record<Tier, string> = {
  C: 'bg-tier-c/15 border-tier-c/40',
  B: 'bg-tier-b/15 border-tier-b/40',
  A: 'bg-tier-a/15 border-tier-a/40',
  S: 'bg-tier-s/15 border-tier-s/40',
  SS: 'bg-tier-ss/15 border-tier-ss/40',
  SSR: 'bg-gradient-to-r from-[#ffd54a]/20 to-[#ff4d6d]/20 border-[#ff4d6d]/50',
};

export function TierBadge({ tier, size = 'sm' }: { tier: Tier; size?: 'sm' | 'lg' }) {
  return (
    <span
      title={`天梯等级 ${tier}`}
      className={cx(
        'inline-flex items-center justify-center rounded border font-black italic tracking-tight',
        size === 'lg' ? 'min-w-10 px-2 py-0.5 text-lg' : 'min-w-7 px-1 text-xs',
        TIER_BG[tier],
      )}
    >
      <span className={TIER_TEXT[tier]}>{tier}</span>
    </span>
  );
}

const POS_COLOR: Record<Position, string> = {
  C: 'bg-[#c2543a]/25 text-[#ff8b6b] border-[#c2543a]/50',
  M: 'bg-[#3a6fc2]/25 text-[#7fb0ff] border-[#3a6fc2]/50',
  O: 'bg-[#8a5a2b]/25 text-[#e0a35f] border-[#8a5a2b]/50',
  SS: 'bg-[#3a9c6b]/25 text-[#6fe0a5] border-[#3a9c6b]/50',
  HS: 'bg-[#7a4fb5]/25 text-[#c39cff] border-[#7a4fb5]/50',
};

/** 副位置文字（与「5号位 保姆辅助」同用阿拉伯数字）：「可打4号位」「可打3、5、2号位」 */
export function altPositionsText(alts: readonly Position[]): string {
  return alts.length ? `可打${alts.map((q) => POSITION_SHORT[q]).join('、')}号位` : '';
}

/**
 * 位置徽章。alt = 副位置（Player.altPositions，第十三波）：徽章后附「可5」等小字，悬停说明副位置评分系数；
 * full 时显示「4号位 游走辅助（可打5号位）」，副位置较多时在徽章内换行（不撑破窄单元格）。
 */
export function PosBadge({ pos, full, alt }: { pos: Position; full?: boolean; alt?: readonly Position[] | null }) {
  const alts = (alt ?? []).filter((q) => q !== pos);
  const title = alts.length
    ? `${POSITION_LABEL[pos]}；副位置：${alts.map((q) => `${POSITION_SHORT[q]}号位`).join('、')}（评分 ×${CONFIG.team.altRoleFactor}）`
    : POSITION_LABEL[pos];
  return (
    <span
      title={title}
      className={cx(
        'inline-flex max-w-full items-center rounded border px-1.5 text-[11px] font-semibold leading-5',
        full && alts.length > 0 ? 'flex-wrap' : 'whitespace-nowrap',
        POS_COLOR[pos],
      )}
    >
      <span className="whitespace-nowrap">{full ? POSITION_LABEL[pos] : `${POSITION_SHORT[pos]}号位`}</span>
      {alts.length > 0 &&
        (full ? (
          <span className="font-normal opacity-80">（{altPositionsText(alts)}）</span>
        ) : (
          <span className="ml-1 text-[10px] font-normal opacity-75">可{alts.map((q) => POSITION_SHORT[q]).join('/')}</span>
        ))}
    </span>
  );
}

export function RegionBadge({ region }: { region: Region }) {
  return <Badge title={REGION_LABEL[region]}>{region}</Badge>;
}

// ---------------------------------------------------------------------------
// 数值展示
// ---------------------------------------------------------------------------
export function StatBar({ value, max = 100, className, color }: { value: number; max?: number; className?: string; color?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const auto = pct >= 85 ? 'bg-gold' : pct >= 70 ? 'bg-good' : pct >= 50 ? 'bg-info' : pct >= 30 ? 'bg-mute' : 'bg-bad';
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-panel-3', className)}>
      <div className={cx('h-full rounded-full', color ?? auto)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 带数值的属性条 */
export function AttrRow({ label, value, max = 100, digits = 0 }: { label: string; value: number; max?: number; digits?: number }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 shrink-0 text-mute">{label}</span>
      <StatBar value={value} max={max} className="flex-1" />
      <span className="w-10 shrink-0 text-right tabular">{value.toFixed(digits)}</span>
    </div>
  );
}

export function Gold({ value, className }: { value: number; className?: string }) {
  return <span className={cx('tabular text-gold', value < 0 && 'text-bad', className)}>{formatGold(value)}</span>;
}

/** 正负变化值（绿/红） */
export function Delta({ value, digits = 0, suffix = '' }: { value: number; digits?: number; suffix?: string }) {
  if (!value) return <span className="text-faint tabular">0{suffix}</span>;
  return (
    <span className={cx('tabular', value > 0 ? 'text-good' : 'text-bad')}>
      {value > 0 ? '+' : ''}
      {value.toFixed(digits)}
      {suffix}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 链接：点击打开选手/战队详情
// ---------------------------------------------------------------------------
export function PlayerLink({ player, className }: { player: Pick<Player, 'id' | 'handle'>; className?: string }) {
  const open = useGameStore((s) => s.openPlayer);
  return (
    <button onClick={() => open(player.id)} className={cx('cursor-pointer font-medium hover:text-gold hover:underline', className)}>
      {player.handle}
    </button>
  );
}

export function TeamLink({ teamId, name, className }: { teamId: string; name: string; className?: string }) {
  const open = useGameStore((s) => s.openTeam);
  return (
    <button onClick={() => open(teamId)} className={cx('cursor-pointer hover:text-gold hover:underline', className)}>
      {name}
    </button>
  );
}

/**
 * 战队队徽 + 标签。队徽（第十波 #4，TeamEmblem.tsx）：按简称 + 品牌配色生成的原创风格化图案；
 * 本地 public/local/logos/ 放了该战队的图片时显示图片（teamId 缺省时自动反查）。
 */
export function TeamTag({ color, tag, teamId }: { color: string; tag: string; teamId?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TeamEmblem color={color} tag={tag} teamId={teamId} />
      <span className="font-semibold tracking-wide">{tag}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { key: K; label: ReactNode; badge?: ReactNode; disabled?: boolean }[];
  value: K;
  onChange: (k: K) => void;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-wrap gap-1 border-b border-line', className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          disabled={t.disabled}
          onClick={() => onChange(t.key)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
            value === t.key ? 'border-dota text-ink' : 'border-transparent text-mute hover:text-ink',
          )}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-2xl',
  closable = true,
}: {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  closable?: boolean;
}) {
  useEffect(() => {
    if (!open || !closable) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closable, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={() => closable && onClose?.()}>
      <div
        className={cx('fade-up flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl', width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <div className="text-base font-semibold">{title}</div>
            {closable && (
              <button onClick={onClose} className="cursor-pointer text-mute hover:text-ink" aria-label="关闭">
                ✕
              </button>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts（App 中挂载一次）
// ---------------------------------------------------------------------------
export function ToastHost() {
  const toasts = useGameStore((s) => s.toasts);
  const dismiss = useGameStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-[70] flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col items-stretch gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx(
            'toast-drop pointer-events-auto flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl shadow-black/50 whitespace-pre-line backdrop-blur',
            t.ok ? 'border-good/50 bg-[#10241b]/95 text-ink' : 'border-bad/60 bg-[#2a1416]/95 text-[#ffd0d0]',
          )}
          title="点击关闭"
        >
          <span className={cx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold', t.ok ? 'bg-good text-black' : 'bg-bad text-white')}>
            {t.ok ? '✓' : '!'}
          </span>
          <span className="min-w-0 flex-1 leading-relaxed">{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 小号提示文字 */
export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-xs leading-relaxed text-mute', className)}>{children}</p>;
}
