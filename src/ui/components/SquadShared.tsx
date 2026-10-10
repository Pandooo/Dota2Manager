// ============================================================================
// 阵容/训练/教练/选手详情 页面共用的小组件与工具（仅供 Squad / PlayerModal / Training / Coach 使用）
// ============================================================================
import { useState, type ReactNode } from 'react';
import type { GameState, ModAttr, Modifier, Player, Tier, Tournament } from '../../engine/types';
import { TIERS } from '../../engine/types';
import { CONFIG, effectivePower, formLabel, roundKindForPlayer, seasonFormModifier, tierOf } from '../../engine';
import type { FormLabel } from '../../engine';
import { Button, cx } from './common';

// ---------------------------------------------------------------------------
// 防御：引擎函数可能尚未实现（throw 'TODO'）或数据缺失时，返回兜底值而不是崩溃
// ---------------------------------------------------------------------------
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export const fmt1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
export const fmt0 = (v: number) => (Number.isFinite(v) ? Math.round(v).toString() : '—');
export const pct = (v: number, digits = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—');

// ---------------------------------------------------------------------------
// 国籍
// ---------------------------------------------------------------------------
/** ISO 3166-1 alpha-2 → 国旗 emoji（无效代码返回白旗） */
export function flagEmoji(cc?: string | null): string {
  if (!cc) return '🏳️';
  let code = String(cc).trim().toUpperCase();
  if (code === 'UK') code = 'GB';
  if (!/^[A-Z]{2}$/.test(code)) return '🏳️';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let regionNames: Intl.DisplayNames | null | undefined;
/** ISO 代码 → 中文国家/地区名（浏览器不支持时返回代码本身） */
export function countryName(cc?: string | null): string {
  if (!cc) return '未知';
  let code = String(cc).trim().toUpperCase();
  if (code === 'UK') code = 'GB';
  if (regionNames === undefined) {
    regionNames = safe(() => new Intl.DisplayNames(['zh-CN'], { type: 'region' }), null);
  }
  const name = regionNames ? safe(() => regionNames!.of(code), undefined) : undefined;
  return name ?? code;
}

export function Flag({ cc, className }: { cc?: string | null; className?: string }) {
  return (
    <span className={cx('inline-block leading-none', className)} title={countryName(cc)}>
      {flagEmoji(cc)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 回合类型
// ---------------------------------------------------------------------------
export type RoundKind = 'preseason' | 'rest' | 'tournament' | 'ti_qualifier' | 'ti' | 'ti_watch';
export const ROUND_KIND_TEXT: Record<RoundKind, string> = {
  preseason: '赛季初',
  rest: '休赛回合',
  tournament: '赛事回合',
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  ti_watch: 'TI 观赛',
};

export function roundKindOf(game: GameState): RoundKind {
  if (game.phase === 'season_end') return 'ti_watch';
  return safe(() => roundKindForPlayer(game, game.roundIndex) as RoundKind, game.roundIndex === 0 ? 'preseason' : 'rest');
}

/** 玩家接下来（含本回合）要参加的赛事：invited/registered 且未结束，按回合排序 */
export function upcomingPlayerTournament(game: GameState): Tournament | null {
  const me = game.settings.playerTeamId;
  const list: Tournament[] = [];
  for (const id of game.seasonTournamentIds ?? []) {
    const t = game.tournaments[id];
    if (!t || t.status === 'finished' || t.roundIndex < game.roundIndex) continue;
    const joined =
      t.playerStatus === 'invited' || t.playerStatus === 'registered' || t.teamIds.includes(me) || t.qualifierTeamIds.includes(me);
    if (joined && t.playerStatus !== 'declined') list.push(t);
  }
  list.sort((a, b) => a.roundIndex - b.roundIndex);
  return list[0] ?? null;
}

// ---------------------------------------------------------------------------
// 排序表头
// ---------------------------------------------------------------------------
export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
  toggle: (k: K, defaultDir?: SortDir) => void;
}

export function useSort<K extends string>(initial: K, initialDir: SortDir = 'desc'): SortState<K> {
  const [key, setKey] = useState<K>(initial);
  const [dir, setDir] = useState<SortDir>(initialDir);
  const toggle = (k: K, defaultDir: SortDir = 'desc') => {
    if (k === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setKey(k);
      setDir(defaultDir);
    }
  };
  return { key, dir, toggle };
}

export function sortList<T>(arr: T[], get: (x: T) => number | string, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return arr.slice().sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (typeof va === 'number' && typeof vb === 'number') {
      const na = Number.isFinite(va) ? va : -Infinity;
      const nb = Number.isFinite(vb) ? vb : -Infinity;
      return (na - nb) * sign;
    }
    return String(va).localeCompare(String(vb), 'zh-CN') * sign;
  });
}

export function SortTh<K extends string>({
  k,
  sort,
  children,
  className,
  title,
  defaultDir = 'desc',
}: {
  k: K;
  sort: SortState<K>;
  children: ReactNode;
  className?: string;
  title?: string;
  defaultDir?: SortDir;
}) {
  const active = sort.key === k;
  return (
    <th
      className={cx('cursor-pointer select-none transition-colors hover:text-ink', active && 'text-ink', className)}
      onClick={() => sort.toggle(k, defaultDir)}
      title={title ?? '点击排序'}
    >
      {children}
      <span className={cx('ml-0.5 inline-block w-2 text-[9px]', active ? 'text-gold' : 'text-transparent')}>
        {active && sort.dir === 'asc' ? '▲' : '▼'}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// 二次确认按钮
// ---------------------------------------------------------------------------
export function ConfirmButton({
  label,
  confirmLabel = '确认',
  prompt,
  onConfirm,
  disabled,
  title,
  variant = 'danger',
  size = 'sm',
}: {
  label: ReactNode;
  confirmLabel?: ReactNode;
  prompt?: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  title?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold';
  size?: 'xs' | 'sm' | 'md' | 'lg';
}) {
  const [armed, setArmed] = useState(false);
  if (!armed || disabled) {
    return (
      <Button variant={variant} size={size} disabled={disabled} title={title} onClick={() => setArmed(true)}>
        {label}
      </Button>
    );
  }
  return (
    <span className="fade-up inline-flex flex-wrap items-center gap-1.5 rounded-md border border-bad/40 bg-bad/10 px-2 py-1">
      {prompt && <span className="text-xs text-[#ffb4b4]">{prompt}</span>}
      <Button
        variant="danger"
        size={size === 'lg' ? 'md' : size}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
      <Button variant="ghost" size={size === 'lg' ? 'md' : size} onClick={() => setArmed(false)}>
        取消
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 状态小标签
// ---------------------------------------------------------------------------
export type ChipTone = 'gold' | 'good' | 'bad' | 'info' | 'mute' | 'dota';
const CHIP_TONE: Record<ChipTone, string> = {
  gold: 'border-gold/40 bg-gold/10 text-gold',
  good: 'border-good/40 bg-good/10 text-good',
  bad: 'border-bad/40 bg-bad/10 text-bad',
  info: 'border-info/40 bg-info/10 text-info',
  mute: 'border-line bg-panel-3 text-mute',
  dota: 'border-dota/50 bg-dota/15 text-dota-2',
};

export function Chip({ tone = 'mute', children, title }: { tone?: ChipTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center rounded border px-1.5 py-px text-[11px] leading-4', CHIP_TONE[tone])}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 赛季状态（form.ts：每赛季初掷出、持续整个赛季的战斗力修正）
// ---------------------------------------------------------------------------
export const FORM_TONE: Record<FormLabel, ChipTone> = {
  火热: 'gold',
  上升: 'good',
  平稳: 'mute',
  低迷: 'dota',
  挣扎: 'bad',
};
const FORM_ARROW: Record<FormLabel, string> = { 火热: '▲▲', 上升: '▲', 平稳: '–', 低迷: '▼', 挣扎: '▼▼' };

export interface SeasonFormInfo {
  label: FormLabel;
  /** 赛季状态倍数（无修正 = 1） */
  value: number;
  /** 相对基础战力的百分比变化，如 +3.2 */
  pct: number;
  tone: ChipTone;
  arrow: string;
  /** 悬停说明 */
  title: string;
}

/** 选手的赛季状态（标签 / 倍数 / 配色），引擎缺失时兜底为平稳 */
export function seasonFormInfo(p: Player): SeasonFormInfo {
  const label = safe(() => formLabel(p), '平稳' as FormLabel);
  const mod = safe(() => seasonFormModifier(p), null);
  const value = mod && Number.isFinite(mod.value) ? mod.value : 1;
  const pct = (value - 1) * 100;
  const pctText = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
  const title = mod
    ? `赛季状态：${label}（战斗力 ${pctText}，${modifierDuration(mod)}，赛季结束时重新评估）`
    : `赛季状态：${label}（本赛季暂无状态修正）`;
  return { label, value, pct, tone: FORM_TONE[label] ?? 'mute', arrow: FORM_ARROW[label] ?? '', title };
}

/** 赛季状态小标签：如「▲ 上升」，showPct 时附带百分比 */
export function FormChip({ player, showPct = false }: { player: Player; showPct?: boolean }) {
  const f = seasonFormInfo(player);
  return (
    <Chip tone={f.tone} title={f.title}>
      <span className="mr-0.5 text-[9px]">{f.arrow}</span>
      {f.label}
      {showPct && Math.abs(f.pct) >= 0.05 && <span className="tabular ml-1 opacity-80">{`${f.pct >= 0 ? '+' : ''}${f.pct.toFixed(1)}%`}</span>}
    </Chip>
  );
}

// ---------------------------------------------------------------------------
// 战力（基础 → 有效）
// ---------------------------------------------------------------------------
export function PowerValue({ player, className }: { player: Player; className?: string }) {
  const base = Number.isFinite(player.power) ? player.power : 0;
  const eff = safe(() => effectivePower(player), base);
  const diff = eff - base;
  if (Math.abs(diff) < 0.05) return <span className={cx('tabular', className)}>{base.toFixed(1)}</span>;
  return (
    <span className={cx('tabular', className)} title={`基础 ${base.toFixed(1)} → 有效 ${eff.toFixed(1)}（受临时状态影响）`}>
      <span className="text-faint">{base.toFixed(1)}</span>
      <span className="mx-0.5 text-faint">→</span>
      <span className={diff > 0 ? 'text-good' : 'text-bad'}>{eff.toFixed(1)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 修正器
// ---------------------------------------------------------------------------
export const MOD_ATTR_LABEL: Record<ModAttr, string> = {
  power: '战斗力',
  mmr: '天梯分',
  insight: '灵性',
  resilience: '韧性',
  loyalty: '归属感',
  talent: '天赋',
};

export function modifierText(m: Modifier): string {
  if (m.kind === 'mul') {
    const d = (m.value - 1) * 100;
    return `${d >= 0 ? '+' : ''}${d.toFixed(Math.abs(d) < 10 ? 1 : 0)}%`;
  }
  const digits = m.attr === 'mmr' ? 0 : 1;
  return `${m.value >= 0 ? '+' : ''}${m.value.toFixed(digits)}`;
}

export function modifierPositive(m: Modifier): boolean {
  return m.kind === 'mul' ? m.value >= 1 : m.value >= 0;
}

export function modifierDuration(m: Modifier): string {
  return m.roundsLeft === null || m.roundsLeft === undefined ? '永久' : `剩余${m.roundsLeft}回合`;
}

// ---------------------------------------------------------------------------
// 天梯进度
// ---------------------------------------------------------------------------
export function tierProgress(mmr: number): { tier: Tier; next: Tier | null; pct: number; need: number; from: number; to: number } {
  const th = CONFIG.ladder.thresholds;
  const tier = safe(() => tierOf(mmr), 'C' as Tier);
  const idx = TIERS.indexOf(tier);
  if (idx >= TIERS.length - 1) return { tier, next: null, pct: 1, need: 0, from: th[tier], to: th[tier] };
  const next = TIERS[idx + 1];
  const from = idx === 0 && mmr < th.C ? CONFIG.ladder.minMmr : th[tier];
  const to = th[next];
  const p = to > from ? (mmr - from) / (to - from) : 1;
  return { tier, next, pct: Math.max(0, Math.min(1, p)), need: Math.max(0, Math.ceil(to - mmr)), from, to };
}

// ---------------------------------------------------------------------------
// 迷你横条（0..max，可指定颜色）
// ---------------------------------------------------------------------------
export function MiniBar({ value, max, color = 'bg-info', className }: { value: number; max: number; color?: string; className?: string }) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-panel-3', className)}>
      <div className={cx('h-full rounded-full', color)} style={{ width: `${p}%` }} />
    </div>
  );
}

/** 归属感文字颜色 */
export function loyaltyClass(v: number): string {
  const th = CONFIG.loyalty.leaveThreshold;
  if (v < th) return 'text-bad font-semibold';
  if (v < th + 15) return 'text-gold';
  return '';
}
