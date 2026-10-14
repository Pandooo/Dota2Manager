// ============================================================================
// Shell 系列页面（主菜单 / 新游戏 / 游戏结束 / 总览 / 消息中心 / 弹窗）共用的小工具与小组件。
// 只依赖 engine 公共出口与 common.tsx，不修改任何游戏状态。
// ============================================================================
import { useId, type ReactNode } from 'react';
import type { EventKind, GameState, NewsCategory, TournamentTier } from '../../engine';
import { CONFIG } from '../../engine';
import { cx } from './common';

/** 调用可能尚未实现/抛错的引擎函数时兜底，保证页面不崩溃 */
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 战队 slug → 可读名称（"natus-vincere" → "Natus Vincere"，"psg-lgd" → "PSG LGD"） */
const SLUG_UPPER = new Set(['og', 'dk', 'lgd', 'psg', 'ehome', 'cdec', 'ig', 'eg', 'vg', 'ar', 'xg', 'ts', 'gg', 'bb', 'nb', 'tl', 'mym', 'mvp', 'ihg', 'tnc', 'nip', 'col']);
export function prettySlug(slug: string | null | undefined): string {
  if (!slug) return '—';
  return slug
    .split('-')
    .map((w) => (SLUG_UPPER.has(w) || w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** 游戏内战队名（找不到时按 slug 美化） */
export function teamNameOf(game: GameState, id: string | null | undefined): string {
  if (!id) return '—';
  return game.teams[id]?.name ?? prettySlug(id);
}

/** 下载文本文件 */
export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function saveFileName(teamTag?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `dota2-manager-${teamTag ? `${teamTag}-` : ''}${stamp}.json`;
}

// ---------------------------------------------------------------------------
// 文案表
// ---------------------------------------------------------------------------
export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '简单', normal: '普通', hard: '困难' };

export const ROUND_KIND_TEXT: Record<string, string> = {
  preseason: '赛季初',
  rest: '休赛回合',
  tournament: '赛事回合',
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  ti_watch: 'TI 观赛',
};

export const NEWS_CATEGORY_LABEL: Record<NewsCategory, string> = {
  event: '事件',
  match: '比赛',
  transfer: '转会',
  patch: '版本',
  finance: '财务',
  tournament: '赛事',
  season: '赛季',
  system: '系统',
};

export const NEWS_CATEGORY_STYLE: Record<NewsCategory, string> = {
  event: 'bg-dota/20 text-[#ff9b8a]',
  match: 'bg-info/15 text-info',
  transfer: 'bg-gold/15 text-gold',
  patch: 'bg-tier-s/20 text-[#c9a6ff]',
  finance: 'bg-good/15 text-good',
  tournament: 'bg-tier-ss/15 text-tier-ss',
  season: 'bg-panel-3 text-ink',
  system: 'bg-panel-3 text-mute',
};

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  match_fixing: '假赛风波',
  heartbreak: '情感受挫',
  visa: '签证问题',
  scandal: '丑闻',
  beef: '战队恩怨',
  unpaid_salary: '俱乐部欠薪',
  hot_streak: '状态火热',
  sponsor: '赞助',
  injury: '伤病',
  stream_deal: '直播合约',
  fan_meeting: '粉丝见面会',
  leave_request: '离队申请',
  poach: '挖角报价',
  contract: '合同到期',
  retire: '退役',
  rookie_home: '真实新秀',
  other: '其他',
};

export const TOUR_TIER_STYLE: Record<TournamentTier, string> = {
  ti: 'bg-gold/20 text-gold border border-gold/40',
  major: 'bg-dota/20 text-[#ff9b8a] border border-dota/40',
  premier: 'bg-info/15 text-info border border-info/30',
  minor: 'bg-panel-3 text-ink border border-line',
  qualifier: 'bg-panel-3 text-mute border border-line',
};
export const TOUR_TIER_SHORT: Record<TournamentTier, string> = {
  ti: 'TI', major: 'Major', premier: '顶级', minor: 'Minor', qualifier: '预选',
};

/** 回合序号 → 简短标签（不同赛季的回合数按配置推算） */
export function roundLabel(game: GameState, season: number, round: number): string {
  const R = season === game.season?.ti
    ? (game.season.rounds ?? []).filter((r) => r.phase === 'regular').length || CONFIG.calendar.regularRounds
    : CONFIG.calendar.regularRounds;
  if (round <= 0) return '赛季初';
  if (round <= R) return `第${round}回合`;
  if (round === R + 1) return 'TI 预选';
  return 'TI 正赛';
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

/** 小号分区标题 */
export function MiniTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-2 flex items-center justify-between gap-2', className)}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{children}</div>
      {right}
    </div>
  );
}

/** 加载中转圈 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]', className)}
      aria-label="加载中"
    />
  );
}

/** 赛事等级徽章 */
export function TourTierBadge({ tier }: { tier: TournamentTier }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none', TOUR_TIER_STYLE[tier])}>{TOUR_TIER_SHORT[tier]}</span>;
}

/**
 * 迷你折线图（内联 SVG）。宽度随容器自适应，线宽不随缩放变形。
 * baseline：额外画一条虚线参考线（如荣誉 0 = 解散线），落在范围内才显示。
 */
export function Sparkline({
  values,
  height = 56,
  color = 'var(--color-gold)',
  baseline,
  baselineLabel,
  className,
}: {
  values: number[];
  height?: number;
  color?: string;
  baseline?: number;
  baselineLabel?: string;
  className?: string;
}) {
  const gid = useId().replace(/:/g, '');
  const W = 200;
  const H = 60;
  const pad = 4;
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length === 0) {
    return (
      <div className={cx('grid place-items-center rounded-md border border-dashed border-line text-xs text-faint', className)} style={{ height }}>
        暂无数据（推进回合后生成）
      </div>
    );
  }
  const series = vals.length === 1 ? [vals[0], vals[0]] : vals;
  let min = Math.min(...series);
  let max = Math.max(...series);
  const showBase = baseline !== undefined && baseline >= min - (max - min) * 0.4 && baseline <= max + (max - min) * 0.4;
  if (showBase && baseline !== undefined) {
    min = Math.min(min, baseline);
    max = Math.max(max, baseline);
  }
  if (max - min < 1e-6) {
    max += 1;
    min -= 1;
  }
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (H - pad * 2);
  const pts = series.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(series.length - 1).toFixed(2)},${H - pad} L${x(0).toFixed(2)},${H - pad} Z`;
  const lastX = x(series.length - 1);
  const lastY = y(series[series.length - 1]);
  return (
    <div className={cx('relative', className)} style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {showBase && baseline !== undefined && (
          <line
            x1={pad}
            x2={W - pad}
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="var(--color-bad)"
            strokeOpacity="0.6"
            strokeDasharray="4 3"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path d={area} fill={`url(#spark-${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {/* 末端圆点：零长度线段 + 圆头端点，不受非等比缩放影响 */}
        <line x1={lastX} y1={lastY} x2={lastX} y2={lastY} stroke={color} strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {showBase && baselineLabel && (
        <span className="pointer-events-none absolute right-0 text-[9px] text-bad/80" style={{ top: `${(y(baseline!) / H) * 100}%`, transform: 'translateY(-110%)' }}>
          {baselineLabel}
        </span>
      )}
    </div>
  );
}

/** 一行「标签 … 值」 */
export function KV({ k, v, className }: { k: ReactNode; v: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center justify-between gap-3 py-1 text-sm', className)}>
      <span className="text-mute">{k}</span>
      <span className="tabular text-right">{v}</span>
    </div>
  );
}
