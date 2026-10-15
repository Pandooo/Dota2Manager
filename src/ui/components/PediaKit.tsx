// ============================================================================
// DotaPedia 共用（Pedia* 前缀）：词条导航（usePediaNav / openPedia / pediaBack）、词条链接、
// Liquipedia 式信息框（Infobox）、章节 / 目录 / 面包屑、格式化工具。
// 只读：本文件与所有 Pedia 页面都不修改游戏状态（数据来自 engine/pedia.ts 的纯查询）。
// ============================================================================
import { Component, useState, type MouseEvent, type ReactNode } from 'react';
import type { GameState, Tier, TournamentTier } from '../../engine';
import { useGameStore } from '../../store/gameStore';
import { cx } from './common';
import { PEDIA_KIND_LABEL, openPedia, pediaBack, useCanGoBack, type PediaKind } from './PediaNav';
import type { SortDir, SortState } from './SquadShared';
import { showTouchTip } from './TouchTip';
import { BREAKPOINT, isCoarsePointer, useMinWidth } from '../mobile';

export * from './PediaNav';

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------
export const fmtPct = (v: number, digits = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—');
export const fmtKda = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
export const fmt1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
export const fmtInt = (v: number) => (Number.isFinite(v) ? Math.round(v).toLocaleString('zh-CN') : '—');
/** 真实奖金池（美元） */
export const fmtUsd = (v: number | null | undefined) => (v && Number.isFinite(v) ? `$${Math.round(v).toLocaleString('en-US')}` : '—');
/** 分钟 → 「38:24」 */
export function fmtMinutes(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '—';
  const total = Math.round(m * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export const wdl = (w: number, d: number, l: number) => `${w}-${d}-${l}`;

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 名次着色（冠军金 / 亚军银 / 前四铜） */
export function placeClass(rankFrom: number): string {
  if (rankFrom === 1) return 'text-gold font-semibold';
  if (rankFrom === 2) return 'text-[#cfd6e4] font-semibold';
  if (rankFrom <= 4) return 'text-[#d49a6a] font-semibold';
  return 'text-ink';
}

/** 名次奖牌底色（表格单元格） */
export function placeCellClass(rankFrom: number): string {
  if (rankFrom === 1) return 'bg-gold/15';
  if (rankFrom === 2) return 'bg-[#cfd6e4]/10';
  if (rankFrom <= 4) return 'bg-[#d49a6a]/10';
  return '';
}

export const TIER_ORDER: Record<TournamentTier, number> = { ti: 0, major: 1, premier: 2, minor: 3, qualifier: 4 };

/** 历史地位评级配色 */
export function gradeClass(grade: string): string {
  switch (grade) {
    case 'S+':
      return 'ssr-text';
    case 'S':
      return 'text-gold';
    case 'A':
      return 'text-tier-s';
    case 'B':
      return 'text-info';
    case 'C':
      return 'text-good';
    default:
      return 'text-mute';
  }
}

export function GradeBadge({ grade, size = 'sm', title }: { grade: string; size?: 'sm' | 'lg'; title?: string }) {
  return (
    <span
      title={title ?? `历史地位评级 ${grade}`}
      className={cx(
        'inline-flex items-center justify-center rounded border border-line bg-panel-3 font-black italic tracking-tight',
        size === 'lg' ? 'min-w-11 px-2 py-0.5 text-xl' : 'min-w-7 px-1 text-xs',
      )}
    >
      <span className={gradeClass(grade)}>{grade}</span>
    </span>
  );
}

export const TIER_RANK: Record<Tier, number> = { C: 0, B: 1, A: 2, S: 3, SS: 4, SSR: 5 };

// ---------------------------------------------------------------------------
// 词条链接（点击打开 DotaPedia 词条；未知词条为纯文本）
// 触屏：上下各加 6px 点按区域（负外边距抵消，不改变行高），文字链接不再只有 16–20px 高
// ---------------------------------------------------------------------------
const LINK_TAP = 'pointer-coarse:-my-1.5 pointer-coarse:py-1.5';
function useGameOrNull(): GameState | null {
  return useGameStore((s) => s.game);
}

export function pediaTeamName(game: GameState, id: string | null | undefined): string {
  if (!id) return '—';
  return game.teams[id]?.name ?? game.pedia?.teams?.[id]?.n ?? id;
}

export function pediaTeamKnown(game: GameState, id: string | null | undefined): boolean {
  return !!id && (!!game.teams[id] || !!game.pedia?.teams?.[id]);
}

export function pediaPlayerName(game: GameState, id: string): string {
  return game.players[id]?.handle ?? game.pedia?.players?.[id]?.n ?? id;
}

/** 战队链接：色块 + 名称；本方战队金色高亮 */
export function PTeam({
  id,
  name,
  color,
  className,
  noSwatch,
  tag,
}: {
  id: string | null | undefined;
  name?: string;
  color?: string;
  className?: string;
  noSwatch?: boolean;
  /** 显示简称而不是全名 */
  tag?: boolean;
}) {
  const game = useGameOrNull();
  if (!id) return <span className={cx('text-faint', className)}>{name ?? '—'}</span>;
  const team = game?.teams[id];
  const label = tag ? team?.tag || game?.pedia?.teams?.[id]?.tag || name || id : name ?? (game ? pediaTeamName(game, id) : id);
  const known = !!game && pediaTeamKnown(game, id);
  const mine = !!game && game.settings.playerTeamId === id;
  const swatch = color ?? team?.color;
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
      {!noSwatch && <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: swatch ?? '#3a4458' }} />}
      {known ? (
        <button
          type="button"
          onClick={() => openPedia('team', id)}
          title={`DotaPedia：${label}`}
          className={cx('min-w-0 cursor-pointer truncate text-left hover:text-gold hover:underline', LINK_TAP, mine && 'font-semibold text-gold')}
        >
          {label}
        </button>
      ) : (
        <span className="min-w-0 truncate text-mute">{label}</span>
      )}
    </span>
  );
}

/** 选手链接 */
export function PPlayer({ id, handle, className }: { id: string; handle?: string; className?: string }) {
  const game = useGameOrNull();
  const label = handle ?? (game ? pediaPlayerName(game, id) : id);
  const mineTeam = game?.settings.playerTeamId;
  const mine = !!game && !!mineTeam && game.players[id]?.teamId === mineTeam;
  return (
    <button
      type="button"
      onClick={() => openPedia('player', id)}
      title={`DotaPedia：${label}`}
      className={cx('cursor-pointer text-left font-medium hover:text-gold hover:underline', LINK_TAP, mine && 'text-gold/90', className)}
    >
      {label}
    </button>
  );
}

/** 赛事链接 */
export function PTour({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openPedia('tournament', id)}
      title={`DotaPedia：${name}`}
      className={cx('inline-block min-w-0 max-w-full cursor-pointer truncate text-left align-bottom hover:text-gold hover:underline', LINK_TAP, className)}
    >
      {name}
    </button>
  );
}

/** 英雄链接 */
export function PHero({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openPedia('hero', id)}
      title={`DotaPedia：${name}`}
      className={cx('cursor-pointer text-left hover:text-gold hover:underline', LINK_TAP, className)}
    >
      {name}
    </button>
  );
}

/** 弹窗中的「DotaPedia ›」入口（生涯总结界面没有侧栏与中心页，不显示；多人模式本座位已出局时同样显示生涯总结） */
export function PediaEntryButton({ kind, id, className }: { kind: PediaKind; id: string; className?: string }) {
  const over = useGameStore((s) => {
    const g = s.game;
    const me = g?.settings?.playerTeamId;
    return !!g?.gameOver || !!(g?.multiplayer && me && g.multiplayer.seats?.[me]?.eliminated);
  });
  if (over) return null;
  return (
    <button
      type="button"
      onClick={() => openPedia(kind, id)}
      title={`在 DotaPedia 中查看${PEDIA_KIND_LABEL[kind]}词条（历史战绩、成就与历史地位）`}
      className={cx(
        'inline-flex cursor-pointer items-center gap-1 rounded-md border border-gold/40 bg-gold/10 px-3 py-1.5 text-sm font-semibold text-gold transition-colors hover:bg-gold/20',
        className,
      )}
    >
      DotaPedia ›
    </button>
  );
}

/**
 * 词条级错误边界：某个词条渲染出错时只影响该词条，并提供「返回列表」（中心页的错误边界按标签划分，
 * 选中状态又会被记住，没有这一层时出错的词条会在每次打开该标签时重现）。用法：<PediaEntryGuard key={id} kind=…>。
 */
export class PediaEntryGuard extends Component<{ kind: PediaKind; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const kind = this.props.kind;
    return (
      <div className="rounded-xl border border-bad/40 bg-[#2a1416] p-5 text-sm">
        <div className="mb-2 font-semibold text-bad">这个{PEDIA_KIND_LABEL[kind]}词条暂时无法显示</div>
        <pre className="whitespace-pre-wrap text-xs text-[#ffb4b4]">{this.state.error.message}</pre>
        <div className="mt-3 flex gap-2">
          <button type="button" className="cursor-pointer rounded border border-line px-3 py-1 text-xs" onClick={() => openPedia(kind, null)}>
            返回{PEDIA_KIND_LABEL[kind]}列表
          </button>
          <button type="button" className="cursor-pointer rounded border border-line px-3 py-1 text-xs" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// 页面骨架：面包屑 + 返回、词条标题、章节、目录、信息框
// ---------------------------------------------------------------------------
export function PediaCrumbs({ kind, title }: { kind: PediaKind; title: ReactNode }) {
  const canBack = useCanGoBack();
  return (
    // 触屏：「返回」与面包屑链接加大点按高度（pointer-coarse），桌面不变
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
      <button
        type="button"
        onClick={() => pediaBack(kind)}
        className="cursor-pointer rounded border border-line bg-panel-2 px-2 py-0.5 text-mute hover:border-mute hover:text-ink pointer-coarse:min-h-9 pointer-coarse:px-3"
        title={canBack ? '返回上一页' : `返回${PEDIA_KIND_LABEL[kind]}列表`}
      >
        ← 返回
      </button>
      <button type="button" className="cursor-pointer hover:text-ink pointer-coarse:min-h-9" onClick={() => useGameStore.getState().setView('pediaHome')}>
        DotaPedia
      </button>
      <span className="text-faint">›</span>
      <button type="button" className="cursor-pointer hover:text-ink pointer-coarse:min-h-9" onClick={() => openPedia(kind, null)}>
        {PEDIA_KIND_LABEL[kind]}
      </button>
      <span className="text-faint">›</span>
      <span className="min-w-0 truncate text-ink">{title}</span>
    </div>
  );
}

/** 词条标题（Liquipedia 风格：大标题 + 细分隔线） */
export function PediaTitle({ children, sub, right }: { children: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold tracking-wide sm:text-2xl">{children}</h1>
        {sub && <div className="mt-1 text-sm text-mute">{sub}</div>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/** 词条章节 */
export function PSection({
  id,
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  id?: string;
  title: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section id={id} className={cx('scroll-mt-4 rounded-xl border border-line bg-panel/90 shadow-lg shadow-black/20', className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-[15px] font-semibold tracking-wide text-ink">
          <span className="mr-2 inline-block h-3 w-0.5 rounded bg-dota align-[-1px]" />
          {title}
        </h2>
        {right && <div className="flex flex-wrap items-center gap-2 text-xs text-mute">{right}</div>}
      </header>
      {/* 与 Card 相同：bodyClassName 的 p-0 在桌面上被默认 p-4 覆盖（保持不变），手机上按原意去掉内边距 */}
      <div className={cx('p-4', bodyClassName, !!bodyClassName && /(^|\s)p-0(\s|$)/.test(bodyClassName) && 'max-sm:p-0')}>{children}</div>
    </section>
  );
}

/**
 * 目录（点击滚动到章节）。≥ lg 为右侧竖排目录（sticky）；更窄时（信息框与目录排在正文之前）改为一行可横向滑动的章节标签，
 * 不再占用大半屏高度（docs/UI.md「手机适配」）。
 */
export function PediaToc({ items }: { items: { id: string; label: string }[] }) {
  if (!items.length) return null;
  return (
    <nav className="rounded-xl border border-line bg-panel/90 px-2 py-2 text-[13px] lg:sticky lg:top-2 lg:px-4 lg:py-3" aria-label="目录">
      <div className="mb-1.5 hidden text-xs font-semibold tracking-wider text-mute lg:block">目录</div>
      <ol className="no-scrollbar flex gap-1.5 overflow-x-auto lg:block lg:space-y-0.5 lg:overflow-visible">
        {items.map((it, i) => (
          <li key={it.id} className="shrink-0">
            <button
              type="button"
              onClick={() => document.getElementById(it.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className={cx(
                'cursor-pointer whitespace-nowrap text-left text-info/90 hover:text-gold',
                'rounded-full border border-line bg-panel-2/70 px-3 py-1.5 lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0 lg:hover:underline',
              )}
            >
              <span className="mr-1.5 text-faint tabular">{i + 1}</span>
              {it.label}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * 信息框（右侧）。< lg 时信息框排在正文之前：默认只显示标题、醒目区域与 summary（几行要点），
 * 其余行收进「完整信息」（点开后与桌面相同），正文不再被挤到两屏之后。≥ lg 始终完整显示。
 */
export function Infobox({
  title,
  color,
  banner,
  summary,
  children,
  footer,
}: {
  title: ReactNode;
  color?: string;
  /** 标题下的醒目区域（如战队徽标、选手等级） */
  banner?: ReactNode;
  /** 窄屏（< lg）收起时显示的要点行（InfoRow） */
  summary?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const wide = useMinWidth(BREAKPOINT.lg);
  const [open, setOpen] = useState(false);
  const full = wide || open;
  return (
    <aside className="overflow-hidden rounded-xl border border-line bg-panel/95 text-[13px] shadow-lg shadow-black/30">
      <div className="h-1.5" style={{ background: color ?? 'var(--color-dota)' }} />
      <div className="border-b border-line bg-panel-2/70 px-4 py-2.5 text-center text-base font-bold tracking-wide">{title}</div>
      {banner && <div className="border-b border-line px-4 py-3 lg:py-4">{banner}</div>}
      {full ? <dl>{children}</dl> : summary ? <dl>{summary}</dl> : null}
      {!wide && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-10 w-full cursor-pointer items-center justify-center gap-1 border-t border-line px-4 py-2 text-xs text-info hover:text-gold"
        >
          {open ? '收起信息 ▴' : '完整信息 ▾'}
        </button>
      )}
      {footer && <div className="flex flex-wrap justify-center gap-2 border-t border-line px-4 py-3">{footer}</div>}
    </aside>
  );
}

export function InfoHead({ children }: { children: ReactNode }) {
  return <div className="border-y border-line bg-panel-3/60 px-4 py-1 text-center text-xs font-semibold tracking-wider text-mute">{children}</div>;
}

export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2 border-b border-line/40 px-4 py-1.5 last:border-b-0">
      <dt className="text-mute">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

/** 词条页布局：左侧章节、右侧信息框（窄屏时信息框在上） */
export function PediaPageLayout({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="order-2 min-w-0 space-y-4 lg:order-1">{main}</div>
      <div className="order-1 min-w-0 space-y-3 lg:order-2 lg:space-y-4">{side}</div>
    </div>
  );
}

/** 简洁的统计小块。手机（< sm）上小字可换成两行；触屏上点按带 title 的小块时显示完整说明（没有悬停） */
export function PStat({ label, value, sub, accent, title }: { label: ReactNode; value: ReactNode; sub?: ReactNode; accent?: boolean; title?: string }) {
  return (
    <div
      title={title}
      onClick={title ? (e) => isCoarsePointer() && showTouchTip(e.currentTarget, title) : undefined}
      className={cx('min-w-0 rounded-lg border px-3 py-2', accent ? 'border-gold/40 bg-gold/5' : 'border-line bg-panel-2/60')}
    >
      <div className="text-[11px] tracking-wider text-mute">{label}</div>
      <div className={cx('mt-0.5 text-lg font-semibold tabular', accent && 'text-gold')}>{value}</div>
      {sub && <div className="break-words text-[11px] text-faint max-sm:line-clamp-2 sm:truncate">{sub}</div>}
    </div>
  );
}

/** 搜索 / 筛选输入框 */
export function PediaInput({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cx(
        'rounded-md border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-faint hover:border-mute focus:border-dota',
        className,
      )}
    />
  );
}

/** 分页（文字不折行；触屏上按钮至少 36px 高） */
export function Pager({ page, pages, onPage, total }: { page: number; pages: number; onPage: (p: number) => void; total: number }) {
  if (pages <= 1) return <div className="whitespace-nowrap text-xs text-faint">共 {total} 条</div>;
  const btn =
    'shrink-0 cursor-pointer whitespace-nowrap rounded border border-line px-2 py-0.5 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-9 pointer-coarse:px-3';
  return (
    <div className="flex flex-wrap items-center gap-2 whitespace-nowrap text-xs text-mute">
      <span>共 {total} 条</span>
      <button type="button" disabled={page <= 0} onClick={() => onPage(page - 1)} className={btn}>
        上一页
      </button>
      <span className="tabular">
        {page + 1} / {pages}
      </span>
      <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} className={btn}>
        下一页
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手机上的宽表格（docs/UI.md「手机适配 · 表格」）
// ---------------------------------------------------------------------------
/**
 * < sm 时固定在左侧的名称列（th / td 分别使用；表格包在 TableScroll 里）：横向滑动时战队 / 选手名始终可见。
 * .tbl th 自带 sticky top 与 z-index（非 layer 样式），名称列表头的层级用 ! 提到其他表头之上。≥ sm 不生效。
 */
export const STICKY_TD = 'max-sm:sticky max-sm:left-0 max-sm:z-[2] max-sm:bg-panel max-sm:shadow-[1px_0_0_var(--color-line)]';
export const STICKY_TH = 'max-sm:left-0 max-sm:z-[3]! max-sm:shadow-[1px_0_0_var(--color-line)]';
/** < sm 隐藏的次要列（th 与 td 都加） */
export const PHONE_HIDE = 'max-sm:hidden';

/**
 * 只放在 title 里的说明（悬停才看得到）：触屏上点按该元素时在旁边显示（TouchTip）；非触屏不做任何事。
 * 用法：<td title={t} {...tipOnTap(t)}>。
 */
export function tipOnTap(text: string | null | undefined): { onClick?: (e: MouseEvent<HTMLElement>) => void } {
  if (!text) return {};
  return {
    onClick: (e) => {
      if (isCoarsePointer()) showTouchTip(e.currentTarget, text);
    },
  };
}

/**
 * 手机（< sm）上的排序选择：表头的排序列可能在屏幕外，用下拉框选排序项、按钮切换升降序。≥ sm 不显示（点表头排序）。
 */
export function PediaSortSelect<K extends string>({
  sort,
  options,
  className,
}: {
  sort: SortState<K>;
  options: { key: K; label: string; defaultDir?: SortDir }[];
  className?: string;
}) {
  return (
    <div className={cx('flex items-center gap-1.5 sm:hidden', className)}>
      <select
        value={sort.key}
        title="排序"
        onChange={(e) => {
          const o = options.find((x) => x.key === e.target.value);
          if (o) sort.toggle(o.key, o.defaultDir ?? 'desc');
        }}
        className="min-h-9 cursor-pointer rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-dota"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            按{o.label}排序
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => sort.toggle(sort.key)}
        className="min-h-9 cursor-pointer whitespace-nowrap rounded-md border border-line bg-panel-2 px-2.5 text-xs text-mute hover:text-ink"
        title="切换升序 / 降序"
      >
        {sort.dir === 'asc' ? '升序 ▲' : '降序 ▼'}
      </button>
    </div>
  );
}

/** 「统计始于」提示（旧存档中途开始记录时） */
export function CoverageNote({ game }: { game: GameState }) {
  const ps = game.pedia;
  const startTi = game.settings.startTi;
  if (!ps) {
    // 统计在第一局开打时创建：新游戏（全联盟还没有任何已赛对局）会覆盖整个执教生涯，只有旧存档才是「从下一局开始」
    let played = 0;
    for (const id in game.players) played += game.players[id]?.stats?.matches ?? 0;
    return played === 0
      ? <span className="text-faint">统计覆盖整个执教生涯（TI{startTi} 赛季起，第一局开打后开始出现数据）</span>
      : <span className="text-faint">本存档尚未开始记录 DotaPedia 数据（从下一局开始）</span>;
  }
  const [ti, round] = Array.isArray(ps.since) ? ps.since : [startTi, 0];
  const complete = ps.full === 1 || (ti === startTi && round <= 0);
  if (complete) return <span className="text-faint">统计覆盖整个执教生涯（TI{startTi} 赛季起）</span>;
  return (
    <span className="text-gold/80" title="旧存档从中途开始记录：此前的对局只有赛事名次（来自赛事史），没有 K/D/A 等统计数据">
      统计始于 TI{ti} 赛季{round > 0 ? `第 ${round} 回合` : '初'}（此前只有赛事名次）
    </span>
  );
}
