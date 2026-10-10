// ============================================================================
// 内联 SVG 折线图（荣誉/资金历史），带赛季分隔线与悬停读数
// ============================================================================
import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { cx } from './common';

export interface HistoryPoint {
  season: number;
  round: number;
  value: number;
}

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(240, Math.floor(el.getBoundingClientRect().width)));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function TourLineChart({
  points,
  color = '#e5b24d',
  height = 220,
  formatValue = (v) => String(Math.round(v)),
  dangerLine,
  dangerLabel,
  className,
}: {
  points: HistoryPoint[];
  color?: string;
  height?: number;
  formatValue?: (v: number) => string;
  /** 危险线（如荣誉 0 = 解散线），在可视范围附近时绘制 */
  dangerLine?: number;
  dangerLabel?: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(800);
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, '');
  const data = points.filter((p) => Number.isFinite(p.value));
  const n = data.length;
  // 始终渲染容器，保证 ref 在首帧就挂上（否则宽度测量永远停留在默认值）
  if (n === 0) return <div ref={ref} className={cx('relative w-full', className)} style={{ height }} />;

  const padL = 52;
  const padR = 14;
  const padT = 22;
  const padB = 26;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  let lo = Math.min(...data.map((p) => p.value));
  let hi = Math.max(...data.map((p) => p.value));
  if (dangerLine !== undefined && lo - dangerLine < (hi - lo) * 0.5 + 1) lo = Math.min(lo, dangerLine);
  if (hi === lo) {
    hi += Math.max(1, Math.abs(hi) * 0.1);
    lo -= Math.max(1, Math.abs(lo) * 0.1);
  }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);

  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * innerH;

  const line = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  // 赛季分段
  const segments: { season: number; from: number; to: number }[] = [];
  data.forEach((p, i) => {
    const last = segments[segments.length - 1];
    if (last && last.season === p.season) last.to = i;
    else segments.push({ season: p.season, from: i, to: i });
  });
  const half = n > 1 ? innerW / (n - 1) / 2 : 0;

  const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * width;
    const i = n === 1 ? 0 : Math.round(((mx - padL) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hp = hover !== null ? data[hover] : null;
  const showDanger = dangerLine !== undefined && dangerLine >= lo && dangerLine <= hi;

  return (
    <div ref={ref} className={cx('relative w-full', className)}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block select-none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`g${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* 网格 + Y 轴 */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="#263147" strokeDasharray="2 4" />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="#5b6579">
              {formatValue(t)}
            </text>
          </g>
        ))}
        {/* 赛季分隔 */}
        {segments.map((s, k) => {
          const sx = k === 0 ? padL : x(s.from) - half;
          const ex = k === segments.length - 1 ? width - padR : x(s.to) + half;
          return (
            <g key={`${s.season}-${k}`}>
              {k > 0 && <line x1={sx} x2={sx} y1={padT - 8} y2={padT + innerH} stroke="#3a4560" strokeDasharray="4 3" />}
              {k % 2 === 1 && <rect x={sx} y={padT} width={Math.max(0, ex - sx)} height={innerH} fill="#ffffff" opacity={0.015} />}
              {ex - sx > 26 && (
                <text x={(sx + ex) / 2} y={height - 8} textAnchor="middle" fontSize={10} fill="#8b96ab">
                  TI{s.season}
                </text>
              )}
            </g>
          );
        })}
        {showDanger && (
          <g>
            <line x1={padL} x2={width - padR} y1={y(dangerLine!)} y2={y(dangerLine!)} stroke="#ef5b5b" strokeOpacity={0.7} strokeDasharray="6 3" />
            {dangerLabel && (
              <text x={width - padR - 4} y={y(dangerLine!) - 4} textAnchor="end" fontSize={10} fill="#ef5b5b">
                {dangerLabel}
              </text>
            )}
          </g>
        )}
        <path d={area} fill={`url(#g${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {n <= 60 &&
          data.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.value)} r={2} fill={color} opacity={0.7} />)}
        {hp && hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke="#8b96ab" strokeOpacity={0.5} />
            <circle cx={x(hover)} cy={y(hp.value)} r={4.5} fill={color} stroke="#0a0d13" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && hover !== null && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-line bg-panel-2/95 px-2 py-1 text-xs shadow-lg"
          style={{
            left: Math.min(Math.max(x(hover) - 60, 0), width - 130),
            top: Math.max(0, y(hp.value) - 46),
          }}
        >
          <div className="text-faint">
            TI{hp.season} · {hp.round === 0 ? '赛季初' : `第 ${hp.round} 回合`}
          </div>
          <div className="font-semibold tabular" style={{ color }}>
            {formatValue(hp.value)}
          </div>
        </div>
      )}
    </div>
  );
}
