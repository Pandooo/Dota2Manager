// ============================================================================
// DotaPedia 小型图表（内联 SVG / HTML，无第三方库）：单系列柱状图、折线图、胜平负条、分项条、生涯时间线。
// 约定：单系列只用一种颜色（默认金色），细柱 + 顶端圆角、2px 间隔、网格线弱化；
// 每个数据点都有悬停提示（SVG <title>），数值标签只标注最大值 / 最后一项，避免满屏数字。
// ============================================================================
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { cx } from './common';

/** 容器宽度（像素）：图表按实际宽度绘制，文字保持 11px，不随缩放变形 */
function useWidth(fallback = 480): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0) setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const cw = Math.round(entries[0]?.contentRect.width ?? 0);
      if (cw > 0) setW(cw);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, Math.max(160, w)];
}

export interface ChartDatum {
  key: string;
  /** x 轴标签（如「TI12」） */
  label: string;
  value: number;
  /** 悬停提示（默认 = 标签 + 数值） */
  tip?: string;
  /** 高亮（如当前赛季 / 本方） */
  highlight?: boolean;
}

const INK = 'var(--color-ink)';
const MUTE = 'var(--color-mute)';
const FAINT = 'var(--color-faint)';
const LINE = 'var(--color-line)';

/** 顶端圆角的柱子（底部贴基线，直角） */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** 单系列柱状图 */
export function PBarChart({
  data,
  height = 132,
  format = (v) => String(Math.round(v)),
  color = 'var(--color-gold)',
  max,
  empty = '暂无数据',
  ariaLabel,
}: {
  data: ChartDatum[];
  height?: number;
  format?: (v: number) => string;
  color?: string;
  max?: number;
  empty?: ReactNode;
  ariaLabel?: string;
}) {
  const [ref, W] = useWidth();
  if (!data.length) {
    return (
      <div ref={ref} className="w-full py-6 text-center text-xs text-faint">
        {empty}
      </div>
    );
  }
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 20;
  const innerH = height - padT - padB;
  const top = Math.max(max ?? 0, ...data.map((d) => (Number.isFinite(d.value) ? d.value : 0)), 1e-9);
  const slot = (W - padL - padR) / data.length;
  const bw = Math.max(4, Math.min(28, slot * 0.62));
  const maxIdx = data.reduce((bi, d, i) => (d.value > data[bi].value ? i : bi), 0);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(W / 44))));
  return (
    <div ref={ref} className="w-full">
    <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="block" role="img" aria-label={ariaLabel}>
      {[0.5, 1].map((f) => (
        <line key={f} x1={padL} x2={W - padR} y1={padT + innerH * (1 - f)} y2={padT + innerH * (1 - f)} stroke={LINE} strokeDasharray="2 4" strokeWidth={1} />
      ))}
      <line x1={padL} x2={W - padR} y1={padT + innerH} y2={padT + innerH} stroke={LINE} strokeWidth={1} />
      {data.map((d, i) => {
        const v = Number.isFinite(d.value) ? Math.max(0, d.value) : 0;
        const h = (v / top) * innerH;
        const cx0 = padL + slot * i + slot / 2;
        const x = cx0 - bw / 2;
        const y = padT + innerH - h;
        const showVal = i === maxIdx || d.highlight || (i === data.length - 1 && data.length <= 16);
        return (
          <g key={d.key}>
            <title>{d.tip ?? `${d.label}：${format(d.value)}`}</title>
            <rect x={padL + slot * i} y={padT - 14} width={slot} height={innerH + 14} fill="transparent" />
            <path d={barPath(x, y, bw, h, 4)} fill={color} opacity={d.highlight ? 1 : 0.78} />
            {showVal && v > 0 && (
              <text x={cx0} y={y - 4} textAnchor="middle" fontSize={11} fill={INK} className="tabular">
                {format(d.value)}
              </text>
            )}
            {(i % labelEvery === 0 || i === data.length - 1) && (
              <text x={cx0} y={height - 5} textAnchor="middle" fontSize={11} fill={d.highlight ? INK : MUTE}>
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
    </div>
  );
}

/** 单系列折线图（invert = 数值越小越好，如名次） */
export function PLineChart({
  data,
  height = 140,
  format = (v) => String(v),
  color = 'var(--color-gold)',
  min,
  max,
  invert,
  refLine,
  empty = '暂无数据',
  ariaLabel,
}: {
  data: ChartDatum[];
  height?: number;
  format?: (v: number) => string;
  color?: string;
  min?: number;
  max?: number;
  invert?: boolean;
  /** 参考线（如 50% 胜率） */
  refLine?: { value: number; label: string };
  empty?: ReactNode;
  ariaLabel?: string;
}) {
  const [ref, W] = useWidth();
  const pts = data.filter((d) => Number.isFinite(d.value));
  if (!pts.length) {
    return (
      <div ref={ref} className="w-full py-6 text-center text-xs text-faint">
        {empty}
      </div>
    );
  }
  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 20;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const vals = pts.map((d) => d.value).concat(refLine ? [refLine.value] : []);
  let lo = min ?? Math.min(...vals);
  let hi = max ?? Math.max(...vals);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const yOf = (v: number) => {
    const f = (v - lo) / (hi - lo);
    return padT + innerH * (invert ? f : 1 - f);
  };
  const xOf = (i: number) => (data.length <= 1 ? padL + innerW / 2 : padL + (innerW * i) / (data.length - 1));
  const coords = data.map((d, i) => (Number.isFinite(d.value) ? { d, x: xOf(i), y: yOf(d.value) } : null));
  const path = coords
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join('');
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 44))));
  // 刻度：最大 / 中间 / 最小（格式化后相同的只保留一个，如名次图的「第 1.5」）
  const ticks = [hi, (hi + lo) / 2, lo].filter((t, i, arr) => arr.findIndex((x) => format(x) === format(t)) === i);
  const last = coords.filter(Boolean).pop();
  return (
    <div ref={ref} className="w-full">
    <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="block" role="img" aria-label={ariaLabel}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={yOf(t)} y2={yOf(t)} stroke={LINE} strokeDasharray={i === ticks.length - 1 ? undefined : '2 4'} strokeWidth={1} />
          <text x={padL - 6} y={yOf(t) + 4} textAnchor="end" fontSize={10.5} fill={FAINT} className="tabular">
            {format(t)}
          </text>
        </g>
      ))}
      {refLine && (
        <g>
          <line x1={padL} x2={W - padR} y1={yOf(refLine.value)} y2={yOf(refLine.value)} stroke={MUTE} strokeWidth={1} strokeDasharray="5 3" opacity={0.6} />
          <text x={W - padR} y={yOf(refLine.value) - 4} textAnchor="end" fontSize={10} fill={MUTE}>
            {refLine.label}
          </text>
        </g>
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {coords.map((c, i) =>
        c ? (
          <g key={c.d.key}>
            <title>{c.d.tip ?? `${c.d.label}：${format(c.d.value)}`}</title>
            <circle cx={c.x} cy={c.y} r={12} fill="transparent" />
            <circle cx={c.x} cy={c.y} r={c.d.highlight ? 5 : 4} fill={color} stroke="var(--color-panel)" strokeWidth={2} />
          </g>
        ) : (
          <g key={data[i].key} />
        ),
      )}
      {last && (
        <text x={Math.min(last.x, W - padR - 2)} y={last.y - 9} textAnchor={last.x > W - padR - 30 ? 'end' : 'middle'} fontSize={11} fill={INK} className="tabular">
          {format(last.d.value)}
        </text>
      )}
      {data.map((d, i) =>
        i % labelEvery === 0 || i === data.length - 1 ? (
          <text key={d.key} x={xOf(i)} y={height - 5} textAnchor="middle" fontSize={11} fill={d.highlight ? INK : MUTE}>
            {d.label}
          </text>
        ) : null,
      )}
    </svg>
    </div>
  );
}

/** 胜 / 平 / 负 条（2px 间隔，旁边有文字，不只靠颜色） */
export function WdlBar({ w, d, l, className, showText = true }: { w: number; d: number; l: number; className?: string; showText?: boolean }) {
  const n = w + d + l;
  return (
    <div className={cx('flex items-center gap-2', className)} title={`${w} 胜 ${d} 平 ${l} 负`}>
      <div className="flex h-2 min-w-16 flex-1 gap-[2px] overflow-hidden rounded-full bg-panel-3">
        {n > 0 && (
          <>
            {w > 0 && <div className="h-full bg-good" style={{ width: `${(w / n) * 100}%` }} />}
            {d > 0 && <div className="h-full bg-mute/70" style={{ width: `${(d / n) * 100}%` }} />}
            {l > 0 && <div className="h-full bg-bad/85" style={{ width: `${(l / n) * 100}%` }} />}
          </>
        )}
      </div>
      {showText && (
        <span className="shrink-0 text-xs tabular">
          <span className="text-good">{w}</span>
          <span className="text-faint">-</span>
          <span className="text-mute">{d}</span>
          <span className="text-faint">-</span>
          <span className="text-bad">{l}</span>
        </span>
      )}
    </div>
  );
}

/** 分项条（如传奇值构成）：标签 | 条 | 数值；负值用红色 */
export function PartBars({ parts, max }: { parts: { label: string; value: number }[]; max?: number }) {
  if (!parts.length) return <div className="text-xs text-faint">暂无可计分的成就</div>;
  const top = Math.max(max ?? 0, ...parts.map((p) => Math.abs(p.value)), 1e-9);
  return (
    <div className="space-y-1.5">
      {parts.map((p) => (
        <div key={p.label} className="grid grid-cols-[120px_minmax(0,1fr)_48px] items-center gap-2 text-xs" title={`${p.label}：${p.value}`}>
          <span className="truncate text-mute">{p.label}</span>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel-3">
            <div className={cx('h-full rounded-full', p.value < 0 ? 'bg-bad' : 'bg-gold')} style={{ width: `${(Math.abs(p.value) / top) * 100}%` }} />
          </div>
          <span className={cx('text-right tabular', p.value < 0 ? 'text-bad' : 'text-ink')}>
            {p.value > 0 ? '+' : ''}
            {p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 水平比例条（排行榜行内） */
export function MeterBar({ value, max, className, color = 'bg-gold' }: { value: number; max: number; className?: string; color?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cx('h-1 overflow-hidden rounded-full bg-panel-3', className)}>
      <div className={cx('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 背景色上可读的文字色（按相对亮度） */
export function inkOn(color: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color ?? '').trim());
  if (!m) return 'rgba(0,0,0,0.8)';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.3 ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)';
}

/** 生涯时间线：每行一段（战队效力 / 主教练等），横轴为赛季 */
export function CareerTimeline({
  from,
  to,
  rows,
}: {
  from: number;
  to: number;
  rows: { key: string; label: ReactNode; start: number; end: number; color?: string; tip?: string; sub?: ReactNode }[];
}) {
  if (!rows.length || to < from) return <div className="text-xs text-faint">暂无记录</div>;
  const span = to - from + 1;
  const cols = Array.from({ length: span }, (_, i) => from + i);
  const labelEvery = Math.max(1, Math.ceil(span / 12));
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[150px_minmax(0,1fr)] items-end gap-2">
        <span />
        <div className="relative flex text-[10.5px] text-faint">
          {cols.map((c, i) => (
            <span key={c} className="flex-1 text-center tabular">
              {i % labelEvery === 0 || i === span - 1 ? `TI${c}` : ''}
            </span>
          ))}
        </div>
      </div>
      {rows.map((r) => {
        const s = Math.max(from, r.start);
        const e = Math.min(to, r.end);
        const left = ((s - from) / span) * 100;
        const width = ((e - s + 1) / span) * 100;
        return (
          <div key={r.key} className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-2" title={r.tip}>
            <div className="min-w-0 truncate text-xs">{r.label}</div>
            <div className="relative h-5 rounded bg-panel-3/50">
              {cols.slice(1).map((c, i) => (
                <span key={c} className="absolute bottom-0 top-0 w-px bg-line/60" style={{ left: `${((i + 1) / span) * 100}%` }} />
              ))}
              <div
                className="absolute bottom-0.5 top-0.5 flex items-center overflow-hidden rounded px-1.5 text-[10.5px] font-semibold"
                style={{
                  left: `calc(${left}% + 1px)`, width: `calc(${width}% - 2px)`, background: r.color ?? 'var(--color-gold)',
                  color: r.color ? inkOn(r.color) : 'rgba(0,0,0,0.82)',
                }}
              >
                <span className="truncate">{r.sub}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
