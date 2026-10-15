// ============================================================================
// 经济差面积图（内联 SVG，随直播推进向右生长）
// 正值 = A 方领先（A 方颜色），负值 = B 方领先（B 方颜色）
// ============================================================================
import { useId } from 'react';
import { fmtGoldK } from './MatchShared';

export interface GoldPoint {
  t: number; // 分钟（可带小数）
  v: number; // A - B 经济差
}

export default function MatchGoldChart({
  points,
  colorA,
  colorB,
  height = 96,
  minSpan = 12,
}: {
  points: GoldPoint[];
  colorA: string;
  colorB: string;
  height?: number;
  /** x 轴最少显示的分钟数（开局时避免过度拉伸） */
  minSpan?: number;
}) {
  const rid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const W = 600;
  const H = height;
  const mid = H / 2;
  const pad = 4;
  const pts = points.length ? points : [{ t: 0, v: 0 }];
  const tMax = Math.max(minSpan, ...pts.map((p) => p.t));
  const vAbs = Math.max(2000, ...pts.map((p) => Math.abs(p.v)));
  const vMax = vAbs * 1.15;
  const x = (t: number) => (Math.max(0, t) / tMax) * W;
  const y = (v: number) => mid - (v / vMax) * (mid - pad);

  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const area = `${line} L${x(last.t).toFixed(1)},${mid} L${x(pts[0].t).toFixed(1)},${mid} Z`;

  const gridMinutes: number[] = [];
  for (let m = 10; m < tMax; m += 10) gridMinutes.push(m);

  const lastXPct = (x(last.t) / W) * 100;
  const lastYPct = (y(last.v) / H) * 100;
  const lastColor = last.v >= 0 ? colorA : colorB;

  return (
    <div>
      {/* 图表区单独定位：当前点与 ±标签按图表高度定位，不与下方的分钟刻度重叠 */}
      <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full" style={{ height: H }}>
        <defs>
          <clipPath id={`${rid}-top`}>
            <rect x="0" y="0" width={W} height={mid} />
          </clipPath>
          <clipPath id={`${rid}-bot`}>
            <rect x="0" y={mid} width={W} height={mid} />
          </clipPath>
          <linearGradient id={`${rid}-ga`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colorA} stopOpacity="0.55" />
            <stop offset="100%" stopColor={colorA} stopOpacity="0.05" />
          </linearGradient>
          <linearGradient id={`${rid}-gb`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={colorB} stopOpacity="0.05" />
            <stop offset="100%" stopColor={colorB} stopOpacity="0.55" />
          </linearGradient>
        </defs>
        {gridMinutes.map((m) => (
          <line key={m} x1={x(m)} x2={x(m)} y1={0} y2={H} stroke="#263147" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />
        ))}
        <path d={area} fill={`url(#${rid}-ga)`} clipPath={`url(#${rid}-top)`} />
        <path d={area} fill={`url(#${rid}-gb)`} clipPath={`url(#${rid}-bot)`} />
        <path d={line} fill="none" stroke={colorA} strokeWidth="1.6" vectorEffect="non-scaling-stroke" clipPath={`url(#${rid}-top)`} />
        <path d={line} fill="none" stroke={colorB} strokeWidth="1.6" vectorEffect="non-scaling-stroke" clipPath={`url(#${rid}-bot)`} />
        <line x1="0" x2={W} y1={mid} y2={mid} stroke="#5b6579" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* 当前点 */}
      <span
        className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg transition-all duration-300"
        style={{ left: `${lastXPct}%`, top: `${lastYPct}%`, background: lastColor }}
      />
      {/* 轴标签 */}
      <span className="pointer-events-none absolute left-1 top-0.5 text-[10px] tabular text-faint">+{fmtGoldK(vMax)}</span>
      <span className="pointer-events-none absolute bottom-0.5 left-1 text-[10px] tabular text-faint">-{fmtGoldK(vMax)}</span>
      </div>
      <div className="relative mt-0.5 h-3 text-[10px] leading-3 tabular text-faint">
        <span className="absolute left-0">0'</span>
        {gridMinutes.map((m) => {
          const left = (x(m) / W) * 100;
          if (left > 92) return null;
          return (
            <span key={m} className="absolute -translate-x-1/2" style={{ left: `${left}%` }}>
              {m}'
            </span>
          );
        })}
        <span className="absolute right-0">{Math.round(tMax)}'</span>
      </div>
    </div>
  );
}
