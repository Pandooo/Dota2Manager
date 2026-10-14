// ============================================================================
// 荣誉势头标签（第十四波，engine/momentum.ts）：强势 / 向好 / 平稳 / 走低 / 低迷，悬停显示同比 / 环比说明。
// 阵容页、战队详情、总览俱乐部卡片共用。
// ============================================================================
import type { GameState } from '../../engine/types';
import { CONFIG, teamMomentumView, type MomentumLabel, type TeamMomentumView } from '../../engine';
import { Badge, cx } from './common';
import { safe } from './TourShared';

export const MOMENTUM_CLASS: Record<MomentumLabel, string> = {
  强势: 'bg-good/20 text-good border border-good/50',
  向好: 'bg-good/10 text-good border border-good/30',
  平稳: 'bg-panel-3 text-mute border border-line',
  走低: 'bg-bad/10 text-bad border border-bad/30',
  低迷: 'bg-bad/20 text-bad border border-bad/50',
};

export const MOMENTUM_TEXT_CLASS: Record<MomentumLabel, string> = {
  强势: 'text-good font-semibold',
  向好: 'text-good',
  平稳: 'text-mute',
  走低: 'text-bad',
  低迷: 'text-bad font-semibold',
};

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

/** 势头视图（异常时返回 null） */
export function momentumViewOf(game: GameState, teamId: string): TeamMomentumView | null {
  return safe(() => teamMomentumView(game, teamId), null);
}

/** 悬停说明：同比 / 环比两部分 + 规则 */
export function momentumTitle(v: TeamMomentumView): string {
  const c = CONFIG.form.honorMomentum;
  return `荣誉势头：${v.label}（合计 ${pct(v.total)}）\n${v.text}\n`
    + `规则：赛季初按荣誉同比（本季初 / 上季初）平移全队赛季状态均值，上限 ±${(c.yoyCap * 100).toFixed(0)}%；`
    + `赛季中按近几个回合的荣誉升降小幅调整战队评分，上限 ±${(c.roundCap * 100).toFixed(0)}%，荣誉不变时逐回合回落。`;
}

/** 势头标签：compact = 只显示文字（无边框） */
export function MomentumBadge({ game, teamId, compact, className }: { game: GameState; teamId: string; compact?: boolean; className?: string }) {
  if (!CONFIG.form.honorMomentum.enabled) return null;
  const v = momentumViewOf(game, teamId);
  if (!v) return null;
  if (compact) {
    return (
      <span className={cx('text-[10px]', MOMENTUM_TEXT_CLASS[v.label], className)} title={momentumTitle(v)}>
        势头 {v.label}
      </span>
    );
  }
  return (
    <Badge className={cx(MOMENTUM_CLASS[v.label], className)} title={momentumTitle(v)}>
      势头 {v.label} {pct(v.total)}
    </Badge>
  );
}
