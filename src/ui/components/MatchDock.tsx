// ============================================================================
// 比赛页底部吸附操作栏：占满一整行、主按钮居中加宽，始终吸附在窗口底部（不随页面滚动）。
// 按钮随比赛阶段变为「当前最该做的下一步」：开始 BP / 采纳推荐 / 开始比赛 / 跳过直播 / 继续。
// 依赖 App 主内容区 <main> 的内边距（px-6 py-5）做通栏出血；样式与全局底部操作栏一致。
// ============================================================================
import type { ReactNode } from 'react';
import { Button, cx } from './common';

export interface DockAction {
  /** 动作标识：不同动作使用不同 key，切换阶段时按钮重建、焦点不会落到下一个动作上（防止空格误触） */
  key: string;
  label: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold';
  disabled?: boolean;
  /** 悬停说明；禁用时说明原因 */
  title?: string;
}

export default function MatchDock({
  status,
  sub,
  primary,
  secondary,
  extra,
  hint,
  hintTone = 'mute',
}: {
  /** 左侧：当前阶段 */
  status: ReactNode;
  /** 左侧第二行：比分 / 进度 */
  sub?: ReactNode;
  /** 居中主按钮 */
  primary: DockAction;
  /** 主按钮左侧的次要按钮 */
  secondary?: DockAction;
  /** 右侧附加操作（小按钮） */
  extra?: DockAction;
  /** 右侧说明文字 */
  hint?: ReactNode;
  hintTone?: 'mute' | 'bad' | 'gold';
}) {
  return (
    <div className="sticky -bottom-5 z-20 -mx-6 -mb-5 mt-6 border-t border-line bg-panel/95 shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6 py-3">
        <div className="min-w-0 text-xs">
          <div className="flex items-center gap-1.5 truncate font-semibold text-ink">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dota-2" />
            {status}
          </div>
          {sub && <div className="truncate text-faint">{sub}</div>}
        </div>

        <div className="flex items-center justify-center gap-2">
          {secondary && (
            <Button
              key={secondary.key}
              variant={secondary.variant ?? 'secondary'}
              size="lg"
              className="h-12"
              disabled={secondary.disabled}
              title={secondary.title}
              onClick={secondary.onClick}
            >
              {secondary.label}
            </Button>
          )}
          <Button
            key={primary.key}
            variant={primary.variant ?? 'gold'}
            size="lg"
            disabled={primary.disabled}
            title={primary.title}
            onClick={primary.onClick}
            className={cx(
              'h-12 min-w-[360px] max-w-[560px] text-base font-bold tracking-wider',
              (primary.variant ?? 'gold') === 'gold' && !primary.disabled && 'glow',
            )}
          >
            <span className="truncate">{primary.label}</span>
          </Button>
        </div>

        <div className="flex min-w-0 items-center justify-end gap-2 text-right text-xs">
          {hint && (
            <div className={cx('line-clamp-2 min-w-0', hintTone === 'bad' ? 'text-bad' : hintTone === 'gold' ? 'text-gold' : 'text-mute')}>{hint}</div>
          )}
          {extra && (
            <Button
              key={extra.key}
              variant={extra.variant ?? 'ghost'}
              size="sm"
              className="shrink-0"
              disabled={extra.disabled}
              title={extra.title}
              onClick={extra.onClick}
            >
              {extra.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
