// 财务图表（内联 SVG / HTML，无第三方依赖）：资金曲线（十字准线 + 提示框）、收支分类发散条形图、收入来源构成、每回合收支
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatGold } from '../../engine';
import { cx } from './common';

// ---------------------------------------------------------------------------
// 容器宽度
// ---------------------------------------------------------------------------
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** 「好看」的刻度：返回 [min, max, step] */
function niceScale(lo: number, hi: number, ticks = 4): [number, number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1, 1];
  if (hi - lo < 1e-9) {
    const pad = Math.max(1, Math.abs(hi) * 0.1);
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  // 金额为整数：步长至少为 1，避免刻度取整后重复（重复的 React key / 标签）
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step, step];
}

// ---------------------------------------------------------------------------
// 资金曲线
// ---------------------------------------------------------------------------
export interface SeriesPoint {
  season: number;
  round: number;
  value: number;
}

export function GoldLineChart({
  points,
  height = 230,
  roundLabel,
}: {
  points: SeriesPoint[];
  height?: number;
  roundLabel: (season: number, round: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  // 渐变 id 需全局唯一（同页多个图表时避免互相引用）
  const gradId = `gold-area-${useId().replace(/:/g, '')}`;

  // 首帧尚未测量到宽度时按 720 绘制（容器 overflow-hidden，测量后立即按实际宽度重绘）
  const W = Math.max(280, width || 720);
  const H = height;
  const padL = 58;
  const padR = 18;
  const padT = 14;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const values = points.map((p) => p.value).filter((v) => Number.isFinite(v));
  if (!values.length) values.push(0);
  const [y0, y1, step] = niceScale(Math.min(0, ...values), Math.max(...values));
  const n = points.length;
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;

  const ticks: number[] = [];
  for (let v = y0; v <= y1 + step / 2; v += step) ticks.push(Math.round(v));

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const base = y(Math.max(y0, Math.min(0, y1)));
  const area = n > 1 ? `${path} L${x(n - 1).toFixed(1)},${base.toFixed(1)} L${x(0).toFixed(1)},${base.toFixed(1)} Z` : '';

  // 赛季分界
  const seasonMarks: { i: number; season: number }[] = [];
  points.forEach((p, i) => {
    if (i === 0 || p.season !== points[i - 1].season) seasonMarks.push({ i, season: p.season });
  });
  // 标签过密时抽稀
  const minGap = 46;
  const shownMarks = seasonMarks.filter((m, k) => k === 0 || x(m.i) - x(seasonMarks[k - 1].i) >= minGap || k === seasonMarks.length - 1);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = n <= 1 ? 0 : Math.round(((px - padL) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const last = points[n - 1];
  const hp = hover !== null ? points[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover) - 70, 0), W - 150) : 0;

  return (
    <div ref={ref} className="relative w-full select-none overflow-hidden">
      <svg width={W} height={H} className="block" role="img" aria-label="资金变化曲线">
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-gold)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-gold)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 网格 + y 轴刻度 */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} opacity={t === 0 ? 1 : 0.55} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--color-faint)" className="tabular">
              {formatGold(t)}
            </text>
          </g>
        ))}
        {y0 < 0 && (
          <rect x={padL} y={y(0)} width={innerW} height={Math.max(0, y(y0) - y(0))} fill="var(--color-bad)" opacity={0.06} />
        )}
        {/* 赛季分界 */}
        {seasonMarks.map((m) =>
          m.i === 0 ? null : (
            <line key={`sl${m.i}`} x1={x(m.i)} x2={x(m.i)} y1={padT} y2={padT + innerH} stroke="var(--color-line)" strokeWidth={1} />
          ),
        )}
        {shownMarks.map((m) => {
          // 靠右边缘的标签改为右对齐，避免溢出
          const nearRight = x(m.i) + 34 > W - padR;
          return (
            <text
              key={`st${m.i}`}
              x={nearRight ? Math.min(x(m.i), W - padR) - 3 : x(m.i) + (m.i === 0 ? 0 : 3)}
              y={H - 8}
              textAnchor={nearRight ? 'end' : 'start'}
              fontSize={10.5}
              fill="var(--color-mute)"
            >
              TI{m.season}
            </text>
          );
        })}
        {/* 面积 + 折线 */}
        {area && <path d={area} fill={`url(#${gradId})`} />}
        <path d={path} fill="none" stroke="var(--color-gold)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* 末端点 + 标签 */}
        {last && (
          <>
            <circle cx={x(n - 1)} cy={y(last.value)} r={4.5} fill="var(--color-gold)" stroke="var(--color-panel)" strokeWidth={2} />
            {hover === null && (
              <text
                x={x(n - 1) - 8}
                y={y(last.value) - 9}
                textAnchor="end"
                fontSize={11}
                fontWeight={600}
                fill="var(--color-ink)"
                className="tabular"
              >
                {formatGold(last.value)}
              </text>
            )}
          </>
        )}
        {/* 十字准线 */}
        {hp && hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke="var(--color-mute)" strokeWidth={1} opacity={0.7} />
            <circle cx={x(hover)} cy={y(hp.value)} r={4.5} fill={hp.value < 0 ? 'var(--color-bad)' : 'var(--color-gold)'} stroke="var(--color-panel)" strokeWidth={2} />
          </>
        )}
        <rect
          x={padL}
          y={padT}
          width={innerW}
          height={innerH}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hp && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 w-[150px] rounded-md border border-line bg-panel-2/95 px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: tipLeft }}
        >
          <div className={cx('text-sm font-semibold tabular', hp.value < 0 ? 'text-bad' : 'text-ink')}>{formatGold(hp.value)}</div>
          <div className="flex items-center gap-1.5 text-faint">
            <span className="inline-block h-0.5 w-3 rounded bg-gold" />
            TI{hp.season} · {roundLabel(hp.season, hp.round)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 发散条形图：每类左支出（红）右收入（绿）
// ---------------------------------------------------------------------------
export interface DivergingRow {
  key: string;
  label: ReactNode;
  income: number;   // ≥ 0
  expense: number;  // ≥ 0（绝对值）
}

export function DivergingBars({ rows, emptyText = '暂无数据' }: { rows: DivergingRow[]; emptyText?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => Math.max(r.income, r.expense)));
  if (rows.length === 0) return <div className="py-8 text-center text-sm text-mute">{emptyText}</div>;
  return (
    <div className="space-y-1">
      <div className="mb-2 flex items-center gap-4 text-[11px] text-mute">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-bad/80" />支出</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-good/80" />收入</span>
        <span className="ml-auto text-faint">净额</span>
      </div>
      {rows.map((r) => {
        const net = r.income - r.expense;
        const active = hover === r.key;
        return (
          <div
            key={r.key}
            onPointerEnter={() => setHover(r.key)}
            onPointerLeave={() => setHover(null)}
            className={cx('grid grid-cols-[72px_1fr_1fr_64px] items-center gap-x-1.5 rounded px-1 py-1 transition-colors', active && 'bg-panel-2/70')}
            title={`收入 ${formatGold(r.income)} · 支出 ${formatGold(r.expense)} · 净额 ${formatGold(net)}`}
          >
            <span className="truncate text-xs text-mute">{r.label}</span>
            {/* 支出（向左） */}
            <div className="flex h-4 items-center justify-end border-r border-line pr-px">
              {r.expense > 0 && (
                <>
                  {active && <span className="mr-1.5 text-[10px] tabular text-mute">{formatGold(-r.expense)}</span>}
                  <div
                    className={cx('h-3 rounded-l-[4px] transition-opacity', active ? 'bg-bad' : 'bg-bad/75')}
                    style={{ width: `${Math.max(2, (r.expense / max) * 100)}%` }}
                  />
                </>
              )}
            </div>
            {/* 收入（向右） */}
            <div className="flex h-4 items-center pl-px">
              {r.income > 0 && (
                <>
                  <div
                    className={cx('h-3 rounded-r-[4px] transition-opacity', active ? 'bg-good' : 'bg-good/75')}
                    style={{ width: `${Math.max(2, (r.income / max) * 100)}%` }}
                  />
                  {active && <span className="ml-1.5 text-[10px] tabular text-mute">+{formatGold(r.income)}</span>}
                </>
              )}
            </div>
            <span className={cx('text-right text-xs tabular', net > 0 ? 'text-good' : net < 0 ? 'text-bad' : 'text-faint')}>
              {net > 0 ? '+' : ''}{formatGold(net)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 收入来源：构成条（2px 间隔的堆叠条）+ 图例行（色块 · 来源 · 金额 · 占比）
// ---------------------------------------------------------------------------
export interface SourceItem {
  key: string;
  label: ReactNode;
  value: number;    // ≥ 0
  color: string;    // 固定顺序的分类色（由调用方按来源指定，不随排序变化）
  hint?: ReactNode; // 行内说明（悬停/次要文字）
}

export function SourceBreakdown({
  items,
  emptyText = '暂无数据',
  unitLabel = '合计',
}: {
  items: SourceItem[];
  emptyText?: string;
  unitLabel?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const rows = items.filter((r) => Number.isFinite(r.value) && r.value > 0);
  const total = rows.reduce((a, r) => a + r.value, 0);
  if (!rows.length || total <= 0) return <div className="py-8 text-center text-sm text-mute">{emptyText}</div>;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs text-mute">
        <span>{unitLabel}</span>
        <span className="tabular text-sm font-semibold text-ink">{formatGold(total)}</span>
      </div>
      {/* 构成条：段间 2px 背景间隔 */}
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]" role="img" aria-label="来源构成">
        {rows.map((r) => (
          <div
            key={r.key}
            onPointerEnter={() => setHover(r.key)}
            onPointerLeave={() => setHover(null)}
            className="h-full transition-opacity"
            style={{ width: `${(r.value / total) * 100}%`, background: r.color, opacity: hover && hover !== r.key ? 0.35 : 1, minWidth: 2 }}
            title={`${typeof r.label === 'string' ? r.label : ''} ${formatGold(r.value)}（${Math.round((r.value / total) * 100)}%）`}
          />
        ))}
      </div>
      <div className="mt-3 space-y-0.5">
        {rows.map((r) => {
          const share = r.value / total;
          return (
            <div
              key={r.key}
              onPointerEnter={() => setHover(r.key)}
              onPointerLeave={() => setHover(null)}
              className={cx('grid grid-cols-[12px_minmax(0,1fr)_auto_44px] items-center gap-x-2 rounded px-1 py-1 text-xs', hover === r.key && 'bg-panel-2/70')}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} />
              <span className="min-w-0 truncate text-ink/90">
                {r.label}
                {r.hint && <span className="ml-1.5 text-faint">{r.hint}</span>}
              </span>
              <span className="tabular text-ink">{formatGold(r.value)}</span>
              <span className="text-right tabular text-mute">{Math.round(share * 100)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 每回合收支：收入向上、支出向下的柱（同一 y 轴），净额为圆点；预测回合半透明描边
// ---------------------------------------------------------------------------
export interface PnlRow {
  key: string;
  label: string;          // 回合名（提示框标题）
  short: string;          // x 轴短标签
  income: number;         // ≥ 0
  expense: number;        // ≥ 0（绝对值）
  projected?: boolean;    // 预测值（尚未发生）
  parts?: { label: string; amount: number }[]; // 提示框明细（正 = 收入）
}

export function RoundPnlChart({ rows, height = 220 }: { rows: PnlRow[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(280, width || 720);
  const H = height;
  const padL = 58;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = rows.length;
  if (!n) return <div className="py-8 text-center text-sm text-mute">暂无回合数据</div>;

  const maxUp = Math.max(1, ...rows.map((r) => r.income));
  const maxDown = Math.max(1, ...rows.map((r) => r.expense));
  const [y0, y1, step] = niceScale(-maxDown, maxUp, 4);
  const y = (v: number) => padT + innerH - ((v - y0) / (y1 - y0 || 1)) * innerH;
  const ticks: number[] = [];
  for (let v = y0; v <= y1 + step / 2; v += step) ticks.push(Math.round(v));
  const band = innerW / n;
  const barW = Math.max(3, Math.min(22, band * 0.62));
  const cxOf = (i: number) => padL + band * (i + 0.5);
  const zero = y(0);
  const labelEvery = Math.max(1, Math.ceil(26 / band));

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - padL) / band);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hr = hover !== null ? rows[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(cxOf(hover) - 90, 0), W - 190) : 0;

  return (
    <div ref={ref} className="relative w-full select-none overflow-hidden">
      <svg width={W} height={H} className="block" role="img" aria-label="每回合收支柱状图">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} opacity={t === 0 ? 1 : 0.5} />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize={10.5} fill="var(--color-faint)" className="tabular">
              {formatGold(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = cxOf(i) - barW / 2;
          const upH = Math.max(0, zero - y(r.income));
          const downH = Math.max(0, y(-r.expense) - zero);
          const dim = hover !== null && hover !== i ? 0.45 : 1;
          const net = r.income - r.expense;
          return (
            <g key={r.key} opacity={dim}>
              {upH > 0 && (
                <path
                  d={roundedBar(x, zero - upH, barW, upH, 'up')}
                  fill="var(--color-good)"
                  fillOpacity={r.projected ? 0.22 : 0.8}
                  stroke={r.projected ? 'var(--color-good)' : 'none'}
                  strokeDasharray={r.projected ? '3 2' : undefined}
                />
              )}
              {downH > 0 && (
                <path
                  d={roundedBar(x, zero + 2, barW, Math.max(0, downH - 2), 'down')}
                  fill="var(--color-bad)"
                  fillOpacity={r.projected ? 0.22 : 0.8}
                  stroke={r.projected ? 'var(--color-bad)' : 'none'}
                  strokeDasharray={r.projected ? '3 2' : undefined}
                />
              )}
              <circle
                cx={cxOf(i)}
                cy={y(net)}
                r={3.5}
                fill={net >= 0 ? 'var(--color-ink)' : 'var(--color-bad)'}
                stroke="var(--color-panel)"
                strokeWidth={2}
                opacity={r.projected ? 0.6 : 1}
              />
              {i % labelEvery === 0 && (
                <text x={cxOf(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--color-mute)">
                  {r.short}
                </text>
              )}
            </g>
          );
        })}
        <rect x={padL} y={padT} width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hr && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 w-[190px] rounded-md border border-line bg-panel-2/95 px-2.5 py-1.5 text-xs shadow-xl"
          style={{ left: tipLeft }}
        >
          <div className="mb-0.5 font-semibold text-ink">{hr.label}{hr.projected ? '（预测）' : ''}</div>
          <div className="flex justify-between text-mute"><span>收入</span><span className="tabular text-good">+{formatGold(hr.income)}</span></div>
          <div className="flex justify-between text-mute"><span>支出</span><span className="tabular text-bad">-{formatGold(hr.expense)}</span></div>
          <div className="flex justify-between border-t border-line pt-0.5 text-mute">
            <span>净额</span>
            <span className={cx('tabular font-semibold', hr.income - hr.expense >= 0 ? 'text-ink' : 'text-bad')}>
              {hr.income - hr.expense >= 0 ? '+' : ''}{formatGold(hr.income - hr.expense)}
            </span>
          </div>
          {hr.parts && hr.parts.length > 0 && (
            <div className="mt-1 space-y-0.5 border-t border-line pt-1 text-[11px]">
              {hr.parts.slice(0, 6).map((p) => (
                <div key={p.label} className="flex justify-between gap-2 text-faint">
                  <span className="truncate">{p.label}</span>
                  <span className={cx('tabular', p.amount >= 0 ? 'text-mute' : 'text-[#ff9b9b]')}>
                    {p.amount >= 0 ? '+' : ''}{formatGold(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 只圆角远离基线一端（4px）的柱 path */
function roundedBar(x: number, top: number, w: number, h: number, dir: 'up' | 'down'): string {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  if (dir === 'up') {
    const b = top + h;
    return `M${x},${b} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${b} Z`;
  }
  const b = top + h;
  return `M${x},${top} L${x + w},${top} L${x + w},${b - r} Q${x + w},${b} ${x + w - r},${b} L${x + r},${b} Q${x},${b} ${x},${b - r} Z`;
}
