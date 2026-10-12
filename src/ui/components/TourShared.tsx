// ============================================================================
// 赛程 / 赛事中心 / 排名 / 版本 / 荣誉史 共用的小组件与工具（Tour* 前缀）
// ============================================================================
import type { ReactNode } from 'react';
import { create } from 'zustand';
import type {
  GameState, HonorBreakdown, PlayerEntryStatus, SeasonPhase, Tournament, TournamentFormatPreset,
  TournamentPlacement, TournamentTier,
} from '../../engine/types';
import { TOURNAMENT_TIER_LABEL, addDays } from '../../engine';
import { useGameStore } from '../../store/gameStore';
import { Badge, Delta, TeamLink, cx } from './common';
import { TeamEmblem } from './TeamEmblem';

// ---------------------------------------------------------------------------
// 防御：引擎函数可能尚未实现或数据缺失时，渲染不崩溃
// ---------------------------------------------------------------------------
export function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 跨页面选中赛事（赛程页 → 赛事中心）
// ---------------------------------------------------------------------------
interface TourSelectionState {
  tournamentId: string | null;
  /** 选中时的回合键（赛季-回合），回合推进后失效，自动回到玩家当前赛事 */
  roundKey: string | null;
  select(id: string | null, roundKey: string | null): void;
}

export const useTourSelection = create<TourSelectionState>((set) => ({
  tournamentId: null,
  roundKey: null,
  select: (id, roundKey) => set({ tournamentId: id, roundKey }),
}));

export function roundKeyOf(game: GameState): string {
  return `${game.season?.ti ?? 0}-${game.roundIndex}`;
}

/** 跳转赛事中心并选中某项赛事 */
export function openTournamentView(game: GameState, tournamentId: string): void {
  useTourSelection.getState().select(tournamentId, roundKeyOf(game));
  useGameStore.getState().setView('tournament');
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------
export const PHASE_LABEL: Record<SeasonPhase, string> = {
  preseason: '赛季初',
  regular: '常规',
  ti_qualifier: 'TI预选',
  ti: 'TI',
  season_end: '结算',
};

export const PHASE_CLASS: Record<SeasonPhase, string> = {
  preseason: 'bg-info/15 text-info border border-info/40',
  regular: 'bg-panel-3 text-mute border border-line',
  ti_qualifier: 'bg-dota/15 text-dota-2 border border-dota/40',
  ti: 'bg-gold/15 text-gold border border-gold/50',
  season_end: 'bg-panel-3 text-mute border border-line',
};

export type RoundKind = 'preseason' | 'rest' | 'tournament' | 'ti_qualifier' | 'ti' | 'ti_watch';

export const ROUND_KIND_TEXT: Record<RoundKind, string> = {
  preseason: '赛季初',
  rest: '休赛回合',
  tournament: '赛事回合',
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  ti_watch: 'TI 观赛',
};

export const ROUND_KIND_CLASS: Record<RoundKind, string> = {
  preseason: 'text-info',
  rest: 'text-mute',
  tournament: 'text-good',
  ti_qualifier: 'text-dota-2',
  ti: 'text-gold',
  ti_watch: 'text-faint',
};

const TIER_CLASS: Record<TournamentTier, string> = {
  ti: 'bg-gold/20 text-gold border border-gold/50',
  major: 'bg-dota/20 text-dota-2 border border-dota/50',
  premier: 'bg-tier-s/15 text-tier-s border border-tier-s/40',
  minor: 'bg-info/15 text-info border border-info/40',
  qualifier: 'bg-panel-3 text-mute border border-line',
};

export function TourTierBadge({ tier, className }: { tier: TournamentTier; className?: string }) {
  return (
    <Badge className={cx(TIER_CLASS[tier] ?? TIER_CLASS.qualifier, 'whitespace-nowrap', className)} title={TOURNAMENT_TIER_LABEL[tier]}>
      {TOURNAMENT_TIER_LABEL[tier] ?? tier}
    </Badge>
  );
}

export const FORMAT_LABEL: Record<TournamentFormatPreset, string> = {
  se8: '单败淘汰',
  de8: '双败淘汰',
  gsl_de8: '双组 GSL → 双败淘汰',
  groups_de: '小组循环 → 双败淘汰',
  groups_se: '小组循环 → 单败淘汰',
  rr: '单循环联赛',
  ti: '小组 Bo2 → 双败淘汰（决赛 Bo5）',
};

export const TOUR_STATUS_LABEL: Record<Tournament['status'], string> = {
  scheduled: '未开始',
  running: '进行中',
  finished: '已结束',
};

export function TourStatusBadge({ status }: { status: Tournament['status'] }) {
  const cls =
    status === 'running'
      ? 'bg-good/15 text-good border border-good/40'
      : status === 'finished'
        ? 'bg-panel-3 text-faint border border-line'
        : 'bg-panel-2 text-mute border border-line';
  return (
    <Badge className={cls}>
      {status === 'running' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-good" />}
      {TOUR_STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export const ENTRY_STATUS_LABEL: Record<PlayerEntryStatus, string> = {
  invited: '受邀（可婉拒）',
  registered: '已报名',
  open: '可报名',
  locked: '荣誉不足',
  declined: '已婉拒',
};

export const ENTRY_STATUS_CLASS: Record<PlayerEntryStatus, string> = {
  invited: 'bg-gold/15 text-gold border border-gold/50',
  registered: 'bg-good/15 text-good border border-good/40',
  open: 'bg-info/10 text-info border border-info/40',
  locked: 'bg-panel-3 text-faint border border-line',
  declined: 'bg-panel-3 text-faint border border-dashed border-line',
};

// ---------------------------------------------------------------------------
// 战队显示（容错：战队可能已解散/不存在，例如真实历史冠军）
// ---------------------------------------------------------------------------
export function prettySlug(id: string): string {
  if (!id) return '未知';
  return id
    .split('-')
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export interface TeamInfo {
  id: string;
  name: string;
  tag: string;
  color: string;
  exists: boolean;
  isPlayer: boolean;
}

export function teamInfo(game: GameState, id: string | null | undefined): TeamInfo {
  const t = id ? game.teams[id] : undefined;
  if (t) return { id: t.id, name: t.name, tag: t.tag || t.name, color: t.color || '#5b6579', exists: true, isPlayer: t.id === game.settings.playerTeamId };
  const name = id ? prettySlug(id) : '待定';
  const tag = id
    ? id
        .split('-')
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
        .slice(0, 4)
    : 'TBD';
  return { id: id ?? '', name, tag, color: '#3a4458', exists: false, isPlayer: false };
}

/** 战队名（色块 + 可点击打开战队详情；玩家战队金色高亮） */
export function TeamName({
  game,
  teamId,
  mode = 'name',
  className,
  noHighlight,
}: {
  game: GameState;
  teamId: string | null | undefined;
  mode?: 'name' | 'tag' | 'both';
  className?: string;
  noHighlight?: boolean;
}) {
  const info = teamInfo(game, teamId);
  const label = mode === 'tag' ? info.tag : info.name;
  const hl = info.isPlayer && !noHighlight;
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
      {info.exists ? (
        <TeamEmblem tag={info.tag} color={info.color} teamId={info.id} />
      ) : (
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: info.color }} />
      )}
      {mode === 'both' && <span className={cx('shrink-0 font-semibold tracking-wide', hl ? 'text-gold' : 'text-ink')}>{info.tag}</span>}
      {info.exists ? (
        <TeamLink
          teamId={info.id}
          name={label}
          className={cx('truncate text-left', mode === 'both' && 'text-mute', hl && 'font-semibold text-gold', mode === 'tag' && 'font-semibold tracking-wide')}
        />
      ) : (
        <span className={cx('truncate', teamId ? 'text-mute' : 'italic text-faint')}>{label}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 日期 / 名次
// ---------------------------------------------------------------------------
/** 回合日期区间 [start, end) → "2019-09-01 ~ 09-14" */
export function dateRange(start: string, end?: string): string {
  if (!start) return '—';
  if (!end || end <= start) return start;
  const last = safe(() => addDays(end, -1), end);
  if (last <= start) return start;
  return last.slice(0, 4) === start.slice(0, 4) ? `${start} ~ ${last.slice(5)}` : `${start} ~ ${last}`;
}

export function teamPlacement(t: Tournament | undefined | null, teamId: string): TournamentPlacement | undefined {
  return t?.placements?.find((p) => p.teamId === teamId);
}

/** 冠军战队 id（名次 1） */
export function championOf(t: Tournament): string | null {
  const p = t.placements?.find((x) => x.rankFrom === 1 && x.rankTo === 1);
  return p?.teamId ?? null;
}

export function rankClass(rankFrom: number): string {
  if (rankFrom === 1) return 'text-gold font-semibold';
  if (rankFrom === 2) return 'text-[#cfd6e4] font-semibold';
  if (rankFrom <= 4) return 'text-[#d49a6a] font-semibold';
  return 'text-ink';
}

// ---------------------------------------------------------------------------
// 荣誉结算明细
// ---------------------------------------------------------------------------
function contrib(h: HonorBreakdown, term: number): number {
  return Math.round((h.tierBase || 0) * (term || 0));
}

export function honorBreakdownRows(h: HonorBreakdown): { label: string; value: number; hint?: string }[] {
  return [
    { label: '对比赛前预期', value: contrib(h, h.expTerm), hint: `预期第 ${fmtRankNum(h.expected)} 名 → 实际第 ${fmtRankNum(h.actual)} 名` },
    { label: '同比（上赛季同系列）', value: contrib(h, h.yoyTerm) },
    { label: '环比（上一项赛事）', value: contrib(h, h.momTerm) },
    { label: '名次奖励', value: contrib(h, h.placeBonus) },
    { label: '宿敌对决', value: Math.round(h.beef || 0) },
  ];
}

function fmtRankNum(v: number): string {
  if (!Number.isFinite(v)) return '?';
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function honorBreakdownText(h: HonorBreakdown): string {
  const lines = [`赛事等级基数 ${h.tierBase}`];
  for (const r of honorBreakdownRows(h)) lines.push(`${r.label}：${r.value >= 0 ? '+' : ''}${r.value}${r.hint ? `（${r.hint}）` : ''}`);
  lines.push(`合计：${h.total >= 0 ? '+' : ''}${Math.round(h.total)}`);
  return lines.join('\n');
}

export function HonorBreakdownGrid({ h, className }: { h: HonorBreakdown; className?: string }) {
  const rows = honorBreakdownRows(h);
  return (
    <div className={cx('space-y-1 text-xs', className)}>
      <div className="flex justify-between text-mute">
        <span>赛事等级基数</span>
        <span className="tabular">{h.tierBase}</span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3" title={r.hint}>
          <span className="text-mute">
            {r.label}
            {r.hint && <span className="ml-1 text-faint">· {r.hint}</span>}
          </span>
          <Delta value={r.value} />
        </div>
      ))}
      <div className="mt-1 flex justify-between border-t border-line pt-1 font-semibold">
        <span>荣誉合计</span>
        <Delta value={Math.round(h.total)} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 杂项小组件
// ---------------------------------------------------------------------------
/** 键值信息行 */
export function InfoItem({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="text-[11px] text-faint">{label}</div>
      <div className="truncate text-sm">{children}</div>
    </div>
  );
}

/** 原生下拉框（暗色） */
export function TourSelect({
  value,
  onChange,
  children,
  className,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <select
      value={value}
      title={title}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        'cursor-pointer rounded-md border border-line bg-panel-2 px-2 py-1.5 text-sm text-ink outline-none hover:border-mute focus:border-dota',
        className,
      )}
    >
      {children}
    </select>
  );
}

/** 小型分段切换 */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { key: K; label: ReactNode; title?: string }[];
  value: K;
  onChange: (k: K) => void;
  className?: string;
}) {
  return (
    <div className={cx('inline-flex rounded-md border border-line bg-panel-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.key}
          title={o.title}
          onClick={() => onChange(o.key)}
          className={cx(
            'cursor-pointer rounded px-2.5 py-1 text-xs transition-colors',
            value === o.key ? 'bg-panel-3 text-ink shadow-sm' : 'text-mute hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 倍数显示：×1.030（绿/红） */
export function MultValue({ v, className }: { v: number | undefined; className?: string }) {
  const val = typeof v === 'number' && Number.isFinite(v) ? v : 1;
  const d = val - 1;
  const cls = Math.abs(d) < 0.0005 ? 'text-faint' : d > 0 ? 'text-good' : 'text-bad';
  return (
    <span className={cx('tabular', cls, className)} title={`${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`}>
      ×{val.toFixed(3)}
    </span>
  );
}
