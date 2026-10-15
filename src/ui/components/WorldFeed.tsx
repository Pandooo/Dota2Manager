// 世界动态流：最新的世界新闻（不含玩家自己的消息），带战队色块；
// 点击战队/选手 → 详情弹窗，点击条目 → 标为已读并打开消息中心。
// 自包含组件（默认导出），由总览等页面按需放置。另导出 NewsChips 供消息中心/回合要闻复用。
import { useState } from 'react';
import { useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import type { GameState, NewsItem } from '../../engine/types';
import { worldHeadlines } from '../../engine/newsroom';
import { Badge, Card, EmptyState, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
import { NEWS_CATEGORY_LABEL, NEWS_CATEGORY_STYLE, roundLabel } from './ShellKit';

// ---------------------------------------------------------------------------
// 战队 / 选手标签（可点击）
// ---------------------------------------------------------------------------
export function NewsChips({
  n,
  maxTeams = 4,
  maxPlayers = 3,
  className,
}: {
  n: NewsItem;
  maxTeams?: number;
  maxPlayers?: number;
  className?: string;
}) {
  const game = useGame();
  const openTeam = useGameStore((s) => s.openTeam);
  const openPlayer = useGameStore((s) => s.openPlayer);
  const teams = (n.teamIds ?? []).map((id) => game.teams[id]).filter((t) => !!t).slice(0, maxTeams);
  const players = (n.playerIds ?? []).map((id) => game.players[id]).filter((p) => !!p).slice(0, maxPlayers);
  if (!teams.length && !players.length) return null;
  return (
    <span className={cx('flex flex-wrap items-center gap-1', className)}>
      {teams.map((t) => (
        <button
          key={t.id}
          onClick={(e) => {
            e.stopPropagation();
            openTeam(t.id);
          }}
          title={`查看战队 ${t.name}`}
          className={cx(
            'inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-px text-[11px] leading-4 transition-colors hover:border-gold/60 hover:text-gold pointer-coarse:py-1',
            t.isPlayer ? 'border-gold/40 bg-gold/10 text-ink' : 'border-line bg-panel-2/80 text-mute',
            t.disbanded && 'line-through opacity-60',
          )}
        >
          <TeamEmblem tag={t.tag || t.name} color={t.color || '#888888'} teamId={t.id} />
          <span className="font-semibold tracking-wide">{t.tag || t.name}</span>
        </button>
      ))}
      {players.map((p) => (
        <button
          key={p.id}
          onClick={(e) => {
            e.stopPropagation();
            openPlayer(p.id);
          }}
          title={`查看选手 ${p.handle}`}
          className="inline-flex cursor-pointer items-center rounded border border-line/70 bg-panel/60 px-1.5 py-px text-[11px] leading-4 text-mute transition-colors hover:border-gold/60 hover:text-gold pointer-coarse:py-1"
        >
          {p.handle}
        </button>
      ))}
    </span>
  );
}

/** 新闻第一个相关战队的主色（无则 null） */
export function newsTeamColor(game: GameState, n: NewsItem): string | null {
  for (const id of n.teamIds ?? []) {
    const t = game.teams[id];
    if (t?.color) return t.color;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 世界动态
// ---------------------------------------------------------------------------
export default function WorldFeed({
  limit = 10,
  title = '世界动态',
  className,
  onOpenItem,
}: {
  limit?: number;
  title?: string;
  className?: string;
  /** 自定义条目点击（默认：标为已读并打开消息中心） */
  onOpenItem?: (newsId: string) => void;
}) {
  const game = useGame();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const [showAll, setShowAll] = useState(false);
  const items = worldHeadlines(game, limit, showAll ? 0 : undefined);

  const open = (n: NewsItem) => {
    if (onOpenItem) {
      onOpenItem(n.id);
      return;
    }
    if (!n.read) {
      void callSilent('markNewsRead', n.id);
    }
    setView('inbox');
  };

  return (
    <Card
      title={title}
      subtitle="其他战队与社区的最新动态"
      className={className}
      bodyClassName="p-0"
      actions={
        <button
          onClick={() => setShowAll((v) => !v)}
          className="cursor-pointer text-[11px] text-faint hover:text-ink pointer-coarse:min-h-9 pointer-coarse:px-1"
          title={showAll ? '只看重要动态' : '包括八卦、小道消息等全部世界新闻'}
        >
          {showAll ? '只看要闻' : '显示全部'}
        </button>
      }
    >
      {items.length === 0 ? (
        <EmptyState text="暂无世界动态。推进回合后，其他战队的赛果、转会与社区动向会出现在这里。" />
      ) : (
        <ul>
          {items.map((n) => {
            const color = newsTeamColor(game, n);
            return (
              <li key={n.id} className="border-b border-line/50 last:border-b-0">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => open(n)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open(n)}
                  className={cx('flex cursor-pointer gap-2.5 px-4 py-2 transition-colors hover:bg-panel-2/60', n.important && 'bg-gold/[0.035]')}
                  title={n.body}
                >
                  <span
                    className="mt-1 h-3.5 w-1 shrink-0 rounded-full"
                    style={{ background: color ?? 'var(--color-line)' }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 max-sm:items-start">
                      <Badge className={NEWS_CATEGORY_STYLE[n.category]}>{n.tags?.includes('weekly') ? '周报' : NEWS_CATEGORY_LABEL[n.category] ?? n.category}</Badge>
                      {/* 手机：标题可换成两行（一行只放得下五六个字） */}
                      <span className={cx('break-words text-[13px] max-sm:line-clamp-2 sm:truncate', n.read ? 'text-mute' : 'text-ink', n.important && 'font-semibold')}>{n.title}</span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <NewsChips n={n} maxTeams={3} maxPlayers={2} />
                      <span className="text-[10px] tabular text-faint">
                        {roundLabel(game, n.season, n.round)} · {n.date}
                      </span>
                    </span>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
