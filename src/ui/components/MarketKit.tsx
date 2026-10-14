// ============================================================================
// 转会市场 / 新秀选秀 / 财务 页面共用的小组件与工具（仅供 Market/RookieDraft/Finance 使用）
// ============================================================================
import { useEffect, useMemo, useState, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes } from 'react';
import { cx } from './common';
import {
  CONFIG, aiAcceptChance, econ, importanceInTeam, signingFee, tierOf,
  type GameState, type Player,
} from '../../engine';

/**
 * 安全调用引擎函数：引擎模块由其他成员并行实现，个别函数可能暂未就绪或在异常数据上抛错，
 * 读操作一律兜底为 fallback，避免整页崩溃。
 */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 有限数字兜底 */
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// 表单控件
// ---------------------------------------------------------------------------
const FIELD = 'h-8 rounded-md border border-line bg-panel-2 px-2 text-sm text-ink outline-none transition-colors focus:border-dota/70 hover:border-panel-3';

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(FIELD, 'cursor-pointer pr-6', className)}>
      {children}
    </select>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(FIELD, 'placeholder:text-faint', className)} />;
}

/** 带标签的筛选项 */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1', className)}>
      <span className="text-[11px] tracking-wide text-faint">{label}</span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// 提示横幅
// ---------------------------------------------------------------------------
type Tone = 'warn' | 'info' | 'bad' | 'good' | 'gold';
const TONE: Record<Tone, string> = {
  warn: 'border-dota/45 bg-dota/10 text-[#ffc2b6]',
  bad: 'border-bad/45 bg-bad/10 text-[#ffb4b4]',
  info: 'border-info/35 bg-info/10 text-[#b9d9ff]',
  good: 'border-good/35 bg-good/10 text-[#b5f0d2]',
  gold: 'border-gold/40 bg-gold/10 text-[#f6dca5]',
};
const TONE_ICON: Record<Tone, string> = { warn: '⊘', bad: '!', info: 'i', good: '✓', gold: '★' };

export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    // 窄屏：正文至少保留 10rem，放不下时操作按钮换到正文下方（不会把正文挤成一字一行）
    <div className={cx('flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-2.5', TONE[tone], className)}>
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border border-current text-[11px] font-bold opacity-80">
        {TONE_ICON[tone]}
      </span>
      <div className="min-w-[10rem] flex-1">
        <div className="text-sm font-semibold">{title}</div>
        {children && <div className="mt-0.5 text-xs leading-relaxed opacity-85">{children}</div>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2 self-center">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------
export function usePaged<T>(items: T[], pageSize: number, resetKey?: unknown) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => setPage(0), [resetKey]);
  const safePage = Math.min(page, pages - 1);
  const rows = useMemo(() => items.slice(safePage * pageSize, safePage * pageSize + pageSize), [items, safePage, pageSize]);
  return { page: safePage, pages, rows, setPage, total: items.length, pageSize };
}

export function Pager({
  page,
  pages,
  total,
  pageSize,
  onChange,
  unit = '条',
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onChange: (p: number) => void;
  unit?: string;
}) {
  if (total === 0) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const btn = 'h-7 min-w-7 rounded-md border border-line bg-panel-2 px-2 text-xs text-mute transition-colors hover:bg-panel-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer';
  // 页码窗口
  const nums: number[] = [];
  const start = Math.max(0, Math.min(page - 2, pages - 5));
  for (let i = start; i < Math.min(pages, start + 5); i++) nums.push(i);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-mute">
      <span className="tabular">
        第 {from}–{to} {unit}，共 {total} {unit}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <button className={btn} disabled={page === 0} onClick={() => onChange(0)} title="第一页">«</button>
          <button className={btn} disabled={page === 0} onClick={() => onChange(page - 1)} title="上一页">‹</button>
          {nums.map((n) => (
            <button
              key={n}
              className={cx(btn, 'tabular', n === page && 'border-dota/60 bg-dota/20 text-ink')}
              onClick={() => onChange(n)}
            >
              {n + 1}
            </button>
          ))}
          <button className={btn} disabled={page >= pages - 1} onClick={() => onChange(page + 1)} title="下一页">›</button>
          <button className={btn} disabled={page >= pages - 1} onClick={() => onChange(pages - 1)} title="最后一页">»</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 可排序表头
// ---------------------------------------------------------------------------
export interface SortState<K extends string> {
  key: K;
  dir: 'asc' | 'desc';
}

export function useSort<K extends string>(initial: K, dir: 'asc' | 'desc' = 'desc') {
  const [sort, setSort] = useState<SortState<K>>({ key: initial, dir });
  const toggle = (key: K) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  return { sort, toggle };
}

export function SortTh<K extends string>({
  k,
  sort,
  onSort,
  children,
  num: isNum,
  title,
  className,
}: {
  k: K;
  sort: SortState<K>;
  onSort: (k: K) => void;
  children: ReactNode;
  num?: boolean;
  title?: string;
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={cx(isNum && 'num', className)} title={title}>
      <button
        onClick={() => onSort(k)}
        className={cx('inline-flex cursor-pointer items-center gap-0.5 hover:text-ink', active && 'text-ink')}
      >
        {children}
        <span className={cx('text-[9px]', active ? 'opacity-100' : 'opacity-0')}>{sort.dir === 'desc' ? '▼' : '▲'}</span>
      </button>
    </th>
  );
}

/** 通用比较：按 dir 排序数值/字符串 */
export function cmp(a: number | string, b: number | string, dir: 'asc' | 'desc'): number {
  const r = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'zh-CN');
  return dir === 'asc' ? r : -r;
}

// ---------------------------------------------------------------------------
// 数值徽标
// ---------------------------------------------------------------------------
/** 意愿/概率百分比，按高低着色 */
export function PctBadge({ value, title }: { value: number | null; title?: string }) {
  if (value === null || !Number.isFinite(value)) return <span className="text-faint">—</span>;
  const pct = Math.round(value * 100);
  const color = pct >= 65 ? 'text-good' : pct >= 40 ? 'text-gold' : 'text-bad';
  return (
    <span title={title} className="inline-flex items-center gap-1.5">
      <span className="relative h-1.5 w-10 overflow-hidden rounded-full bg-panel-3">
        <span
          className={cx('absolute inset-y-0 left-0 rounded-full', pct >= 65 ? 'bg-good' : pct >= 40 ? 'bg-gold' : 'bg-bad')}
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </span>
      <span className={cx('tabular text-xs font-semibold', color)}>{pct}%</span>
    </span>
  );
}

/** 0..100 属性值着色数字（FM 风格） */
export function AttrNum({ value, digits = 0 }: { value: number; digits?: number }) {
  const v = num(value);
  const color = v >= 85 ? 'text-gold' : v >= 70 ? 'text-good' : v >= 50 ? 'text-ink' : v >= 35 ? 'text-mute' : 'text-bad';
  return <span className={cx('tabular', color)}>{v.toFixed(digits)}</span>;
}

/** 进度条（自定义颜色、带刻度标记） */
export function Meter({ value, max, color = 'bg-gold', className }: { value: number; max: number; color?: string; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cx('h-2 w-full overflow-hidden rounded-full bg-panel-3', className)}>
      <div className={cx('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 表格容器：横向滚动 + 可选最大高度 */
export function TableWrap({ children, maxH, className }: { children: ReactNode; maxH?: string; className?: string }) {
  return <div className={cx('overflow-x-auto', maxH && 'overflow-y-auto', maxH, className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// 金额 / 概率：优先直接调用引擎（与实际结算一致）
// ---------------------------------------------------------------------------
/** 金额取整到 CONFIG.market.feeRounding（同 market.roundFee，用于报价滑块） */
export function roundFee(v: number): number {
  const step = CONFIG.market.feeRounding || 1000;
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.max(step, Math.round(v / step) * step);
}

/** 签约自由选手的签字费（engine.signingFee） */
export function signingFeeOf(g: GameState, p: Player): number {
  return safe(() => signingFee(g, p), 0);
}

/**
 * 按当前能力重算的每回合工资：签约/转会时引擎按 player.computeSalary 重定工资。
 * computeSalary 未从 engine/index.ts 导出，此处按同公式复刻（等级取基础 mmr，战力取基础 power）。
 */
export function expectedSalary(g: GameState, p: Player, rookie = false): number {
  const eco = CONFIG.economy;
  const tier = tierOf(num(p.mmr));
  const power = Number.isFinite(p.power) ? p.power : 50;
  const powerFactor = Math.max(0, 1 + (power - 70) * eco.salaryPowerFactor);
  const raw = (eco.salaryByTier[tier] ?? 0) * powerFactor * safe(() => econ(g), 1) * (rookie ? eco.rookieSalaryMult : 1);
  return Math.max(eco.minSalary, Math.round(raw));
}

/** 选手在原队的重要度（engine.importanceInTeam）：头号首发 / 首发 / 替补 0 */
export function importanceOf(g: GameState, p: Player): number {
  return safe(() => importanceInTeam(g, p), 0);
}

/** AI 接受报价概率（engine.aiAcceptChance） */
export function aiAcceptEstimate(g: GameState, p: Player, fee: number): number {
  const v = safe(() => aiAcceptChance(g, p, fee), 0);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

// ---------------------------------------------------------------------------
// 谈判结果本回合内固定（引擎按 存档+赛季+回合+选手 生成确定性骰子，结果 = 骰子 < 概率）：
// 记录本回合的失败谈判，避免玩家反复点击同样必然失败的操作。
// - 选手婉拒：骰子固定，只有意愿（受荣誉影响）上升才可能改变结果 → 记录当时的意愿
// - 俱乐部拒绝报价：骰子固定，只有提高报价才可能成功 → 记录被拒的最高报价
// ---------------------------------------------------------------------------
const refusedWill = new Map<string, number>();
const rejectedBid = new Map<string, number>();
function roundKey(g: GameState, playerId: string): string {
  return `${g.id}|${g.season?.ti ?? 0}|${g.roundIndex}|${playerId}`;
}
/** 记录选手本回合婉拒（will = 婉拒时的加盟意愿） */
export function markRefused(g: GameState, playerId: string, will: number): void {
  const k = roundKey(g, playerId);
  refusedWill.set(k, Math.max(refusedWill.get(k) ?? 0, Number.isFinite(will) ? will : 1));
}
/** 选手本回合是否已婉拒（当前意愿未超过婉拒时的意愿 → 结果必然相同） */
export function isRefused(g: GameState, playerId: string, will: number | null): boolean {
  const w = refusedWill.get(roundKey(g, playerId));
  if (w === undefined) return false;
  return will === null || !Number.isFinite(will) || will <= w + 1e-9;
}
/** 记录俱乐部本回合拒绝的报价 */
export function markBidRejected(g: GameState, playerId: string, fee: number): void {
  const k = roundKey(g, playerId);
  rejectedBid.set(k, Math.max(rejectedBid.get(k) ?? 0, fee));
}
/** 本回合被对方俱乐部拒绝过的最高报价（无记录返回 0） */
export function rejectedBidOf(g: GameState, playerId: string): number {
  return rejectedBid.get(roundKey(g, playerId)) ?? 0;
}
