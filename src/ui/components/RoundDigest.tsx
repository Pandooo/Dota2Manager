// 回合要闻面板：展示 game.lastDigest（每次推进回合后由引擎 newsroom.ts 生成的 3~6 条头条）。
// 点击条目展开正文并标为已读；可关闭（按存档 + 期次记在本机浏览器，下一期要闻会重新出现）。
// 自包含组件（默认导出），由总览等页面按需放置。
import { useState } from 'react';
import { useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import type { NewsItem } from '../../engine/types';
import { digestItems } from '../../engine/newsroom';
import { Badge, cx } from './common';
import { NEWS_CATEGORY_LABEL, NEWS_CATEGORY_STYLE } from './ShellKit';
import { NewsChips, newsTeamColor } from './WorldFeed';

const STORAGE_KEY = 'd2m:digest-dismissed';

function readDismissed(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDismissed(map: Record<string, string>): void {
  try {
    // 只保留最近的若干存档，避免无限增长
    const keys = Object.keys(map);
    const trimmed = keys.length > 20 ? Object.fromEntries(keys.slice(-20).map((k) => [k, map[k]])) : map;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 隐私模式/禁用存储：只在本次会话内隐藏
  }
}

export default function RoundDigest({ className, onClose }: { className?: string; onClose?: () => void }) {
  const game = useGame();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const digest = game.lastDigest ?? null;
  const key = digest ? `${digest.season}-${digest.round}-${digest.items[0] ?? ''}` : '';
  const [dismissed, setDismissed] = useState<Record<string, string>>(() => readDismissed());
  const [openId, setOpenId] = useState<string | null>(null);

  const items = digestItems(game);
  if (!digest || !items.length || dismissed[game.id] === key) return null;

  const close = () => {
    const next = { ...dismissed, [game.id]: key };
    setDismissed(next);
    writeDismissed(next);
    onClose?.();
  };

  const toggle = (n: NewsItem) => {
    setOpenId((cur) => (cur === n.id ? null : n.id));
    if (!n.read) {
      void callSilent('markNewsRead', n.id);
    }
  };

  return (
    <section
      className={cx(
        'fade-up relative overflow-hidden rounded-xl border border-gold/30 bg-gradient-to-br from-gold/[0.07] via-panel to-panel shadow-lg shadow-black/20',
        className,
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1 bg-gold/70" />
      <header className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 pl-5">
        <span className="text-[11px] font-bold tracking-[0.2em] text-gold">要闻</span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{digest.title}</h3>
        <button onClick={() => setView('inbox')} className="cursor-pointer text-[11px] text-mute hover:text-ink" title="打开消息中心">
          全部消息 ›
        </button>
        <button onClick={close} className="cursor-pointer px-1 text-mute hover:text-ink" aria-label="关闭要闻" title="关闭（下一期要闻会重新出现）">
          ✕
        </button>
      </header>
      <ol className="py-1">
        {items.map((n, i) => {
          const open = openId === n.id;
          const color = newsTeamColor(game, n);
          return (
            <li key={n.id} className="border-b border-line/40 last:border-b-0">
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggle(n)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && toggle(n)}
                className={cx('flex cursor-pointer items-start gap-3 px-4 py-2 pl-5 transition-colors hover:bg-panel-2/50', open && 'bg-panel-2/40')}
              >
                <span
                  className={cx(
                    'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-[11px] font-black tabular',
                    i === 0 ? 'bg-gold text-black' : 'bg-panel-3 text-mute',
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {color && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
                    <span className={cx('text-[13px] leading-snug', open ? 'whitespace-normal' : 'truncate', n.read ? 'text-ink/80' : 'font-semibold text-ink')}>
                      {n.title}
                    </span>
                  </span>
                  {!open && n.body && <span className="mt-0.5 block truncate text-xs text-faint">{n.body.replace(/\s+/g, ' ')}</span>}
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge className={NEWS_CATEGORY_STYLE[n.category]}>{n.tags?.includes('weekly') ? '周报' : NEWS_CATEGORY_LABEL[n.category] ?? n.category}</Badge>
                    <NewsChips n={n} maxTeams={3} maxPlayers={2} />
                  </span>
                </span>
                <span className={cx('shrink-0 pt-0.5 text-xs text-faint transition-transform', open && 'rotate-90 text-gold')}>›</span>
              </div>
              {open && (
                <div className="fade-up px-4 pb-3 pl-[3.25rem]">
                  <p className="whitespace-pre-line rounded-lg border border-line/70 bg-panel/80 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink/90">
                    {n.body || '（无正文）'}
                  </p>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
