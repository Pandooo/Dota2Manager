// ============================================================================
// 比赛页底部吸附操作栏：占满一整行、主按钮居中加宽，始终吸附在窗口底部（不随页面滚动）。
// 按钮随比赛阶段变为「当前最该做的下一步」：开始 BP / 采纳推荐 / 开始比赛 / 跳过直播 / 继续。
// 依赖 App 主内容区 <main> 的内边距（手机 px-3 py-4，≥ sm px-6 py-5）做通栏出血；样式与全局底部操作栏一致。
// 手机（< sm）：左侧阶段与右侧提示 / 附加操作并排在上一行，下一行为次要按钮 + 通栏主按钮；比赛进行中底栏（ActionBar）不渲染，本栏让出底部安全区并写入 --chrome-bottom。
// sm–lg（平板 / 横屏手机，主区较窄）：主按钮最小宽度收窄到 240px，右栏至少容得下附加按钮（不会压到主按钮上）；
// 矮视口（short，横屏手机）收紧上下内边距与按钮高度。≥ lg 与桌面版一致。
// ============================================================================
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, cx } from './common';
import { useChromeVar } from '../mobile';

/**
 * 主按钮换成另一个动作（key 变化，如直播播完时「跳过直播」→「继续 · 第 N 局」）后的这段时间内不响应点按：
 * 手机上通栏主按钮在原地换动作，本想跳过直播的一下若恰好落在播完之后，会直接进入下一局、错过赛果。
 */
const PRIMARY_SWAP_GUARD_MS = 600;

/** 主按钮动作切换后的短暂保护：返回 [是否在保护期内（用于样式）, 点按时检查的函数] */
function usePrimarySwapGuard(key: string): [boolean, () => boolean] {
  const swap = useRef({ key, at: 0 });
  const [cooling, setCooling] = useState(false);
  useEffect(() => {
    if (swap.current.key === key) return;
    swap.current = { key, at: performance.now() };
    setCooling(true);
    const t = setTimeout(() => setCooling(false), PRIMARY_SWAP_GUARD_MS);
    return () => clearTimeout(t);
  }, [key]);
  const blocked = () => swap.current.key !== key || performance.now() - swap.current.at < PRIMARY_SWAP_GUARD_MS;
  return [cooling, blocked];
}

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
  const chromeRef = useChromeVar('--chrome-bottom', 'bottom');
  const [cooling, swapBlocked] = usePrimarySwapGuard(primary.key);
  return (
    <div
      ref={chromeRef}
      className="sticky -bottom-4 z-20 -mx-3 -mb-4 mt-6 border-t border-line bg-panel/95 pb-safe shadow-[0_-8px_24px_rgba(0,0,0,0.35)] backdrop-blur sm:-bottom-5 sm:-mx-6 sm:-mb-5"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(min-content,1fr)] sm:gap-4 sm:px-6 sm:py-3 short:py-1.5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="min-w-0 text-xs">
          <div className="flex items-center gap-1.5 truncate font-semibold text-ink">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-dota-2" />
            {status}
          </div>
          {sub && <div className="truncate text-faint">{sub}</div>}
        </div>

        {/* 手机：第一行为阶段 / 提示，这里是第二行（次要按钮 + 通栏主按钮） */}
        <div className="order-last col-span-2 flex min-w-0 items-center justify-center gap-2 sm:order-none sm:col-span-1">
          {secondary && (
            <Button
              key={secondary.key}
              variant={secondary.variant ?? 'secondary'}
              size="lg"
              className="h-12 shrink-0 whitespace-nowrap max-sm:px-3 short:h-10"
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
            onClick={() => {
              if (!swapBlocked()) primary.onClick();
            }}
            className={cx(
              'h-12 w-full min-w-0 max-w-[560px] whitespace-nowrap text-base font-bold tracking-wider short:h-10 sm:w-auto sm:min-w-[240px] lg:min-w-[360px]',
              (primary.variant ?? 'gold') === 'gold' && !primary.disabled && 'glow',
              cooling && 'opacity-70',
            )}
          >
            <span className="truncate">{primary.label}</span>
          </Button>
        </div>

        <div className="flex min-w-0 max-w-[55vw] items-center justify-end gap-2 text-right text-xs sm:max-w-none">
          {hint && (
            <div className={cx('line-clamp-2 min-w-0', hintTone === 'bad' ? 'text-bad' : hintTone === 'gold' ? 'text-gold' : 'text-mute')}>{hint}</div>
          )}
          {extra && (
            <Button
              key={extra.key}
              variant={extra.variant ?? 'ghost'}
              size="sm"
              className="shrink-0 whitespace-nowrap"
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
