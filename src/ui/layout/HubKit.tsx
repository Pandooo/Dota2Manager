// ============================================================================
// 中心页骨架（信息架构，第五波「界面精简」）：
// - HubShell：中心页标题 + 一级标签（大号下划线），内容区为当前标签对应的原页面；
// - ScreenHeader：页面标题的「可嵌入」版本——独立渲染时等同 PageHeader；嵌入中心页标签时
//   不再重复标题（标题由标签承担），只保留副标题与操作按钮，`nav` 中的跳转按钮（如同一中心页的兄弟标签）也省略。
// 原页面只需把 PageHeader 换成 ScreenHeader，即可同时用于独立页与中心页标签。
// ============================================================================
import { createContext, useContext, type ReactNode } from 'react';
import { useGameStore, tabBelongsTo, HUB_TABS, type HubKey, type HubTab } from '../../store/gameStore';
import { PageHeader, cx } from '../components/common';
import ErrorBoundary from '../components/ErrorBoundary';

/** 是否渲染在中心页标签内（由 HubShell 提供） */
const HubEmbedContext = createContext(false);

export function useEmbedded(): boolean {
  return useContext(HubEmbedContext);
}

/** 页面标题：独立页面 = PageHeader；嵌入中心页时只保留副标题与操作（无则不渲染） */
export function ScreenHeader({
  title,
  subtitle,
  actions,
  nav,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** 跳转到其他页面的按钮：独立页面时显示在操作区末尾，嵌入中心页时省略（由标签/侧栏承担） */
  nav?: ReactNode;
}) {
  const embedded = useEmbedded();
  if (!embedded) {
    const all = actions || nav ? (
      <>
        {actions}
        {nav}
      </>
    ) : undefined;
    return <PageHeader title={title} subtitle={subtitle} actions={all} />;
  }
  if (!subtitle && !actions) return null;
  return (
    <div className="mb-4 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="min-w-0 text-sm text-mute">{subtitle}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface HubTabDef {
  key: HubTab;
  label: ReactNode;
  icon?: string;
  /** 标签右侧的徽标（数量、红点等） */
  badge?: ReactNode;
  title?: string;
}

/** 当前中心页应显示的标签：store.tab 属于本页时用之，否则用默认（第一项） */
export function useHubTab<T extends HubTab>(hub: HubKey): T {
  const view = useGameStore((s) => s.view);
  const tab = useGameStore((s) => s.tab);
  const fallback = (HUB_TABS[hub]?.[0] ?? null) as T;
  return (view === hub && tabBelongsTo(hub, tab) ? tab : fallback) as T;
}

export function HubShell({
  title,
  tabs,
  value,
  right,
  onReselect,
  children,
}: {
  title: ReactNode;
  tabs: HubTabDef[];
  value: HubTab;
  /** 标签行右侧的附加信息（可选） */
  right?: ReactNode;
  /** 点击当前已选中的标签时（可选；如 DotaPedia 回到该标签的列表） */
  onReselect?: (key: HubTab) => void;
  children: ReactNode;
}) {
  const setView = useGameStore((s) => s.setView);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-x-6 gap-y-1 border-b border-line">
        <h1 className="pb-2 text-xl font-bold tracking-wide">{title}</h1>
        <div role="tablist" className="flex min-w-0 flex-wrap items-end gap-1">
          {tabs.map((t) => {
            const active = t.key === value;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                title={t.title}
                onClick={() => (active && onReselect ? onReselect(t.key) : setView(t.key))}
                className={cx(
                  '-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 pb-2 pt-1.5 text-[15px] transition-colors',
                  active ? 'border-dota font-semibold text-ink' : 'border-transparent text-mute hover:border-line hover:text-ink',
                )}
              >
                {t.icon && <span className="text-xs opacity-60">{t.icon}</span>}
                {t.label}
                {t.badge}
              </button>
            );
          })}
        </div>
        {right && <div className="ml-auto flex items-center gap-2 pb-2 text-xs text-mute">{right}</div>}
      </div>
      <HubEmbedContext.Provider value={true}>
        {/* 不包 transform 动画容器：页面内的 Modal（position: fixed）需要以视口为包含块 */}
        <ErrorBoundary key={value}>{children}</ErrorBoundary>
      </HubEmbedContext.Provider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 徽标（侧栏 / 中心页标签共用）
// ---------------------------------------------------------------------------
export function CountBadge({ n, tone = 'gold', title }: { n: number | string; tone?: 'gold' | 'dota' | 'mute' | 'good'; title?: string }) {
  const cls =
    tone === 'dota' ? 'bg-dota text-white' : tone === 'mute' ? 'bg-panel-3 text-mute' : tone === 'good' ? 'bg-good/20 text-good' : 'bg-gold text-black';
  return (
    <span title={title} className={cx('rounded-full px-1.5 text-[10px] font-bold leading-4 tabular', cls)}>
      {n}
    </span>
  );
}

export function DotBadge({ tone = 'live', title }: { tone?: 'live' | 'bad' | 'gold'; title?: string }) {
  const cls = tone === 'live' ? 'animate-pulse bg-dota-2' : tone === 'bad' ? 'bg-bad' : 'bg-gold';
  return <span title={title} className={cx('inline-block h-2 w-2 rounded-full', cls)} />;
}

export function TextBadge({ children, tone = 'mute', title }: { children: ReactNode; tone?: 'mute' | 'gold' | 'bad'; title?: string }) {
  const cls = tone === 'gold' ? 'bg-gold text-black' : tone === 'bad' ? 'bg-bad/20 text-bad' : 'text-faint';
  return (
    <span title={title} className={cx('rounded-full px-1.5 text-[10px] font-bold leading-4', cls)}>
      {children}
    </span>
  );
}
