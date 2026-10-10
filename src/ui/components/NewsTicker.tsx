// 总览顶部的新闻滚动栏：优先滚动回合要闻、重要新闻与世界动态（newsroom.tickerHeadlines），
// 每条前有相关战队的色点；悬停暂停，点击跳转消息中心。
// 多人模式：其他玩家的实时快讯（服务器 feed）置顶滚动。
import { useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import type { NewsCategory } from '../../engine/types';
import { tickerHeadlines } from '../../engine/newsroom';
import { cx } from './common';

const CAT_LABEL: Record<NewsCategory, string> = {
  event: '事件', match: '比赛', transfer: '转会', patch: '版本', finance: '财务', tournament: '赛事', season: '赛季', system: '系统',
};
const CAT_COLOR: Record<NewsCategory, string> = {
  event: 'text-[#ff9b8a]', match: 'text-info', transfer: 'text-gold', patch: 'text-[#c9a6ff]', finance: 'text-good',
  tournament: 'text-tier-ss', season: 'text-ink', system: 'text-mute',
};

const TICKER_COUNT = 14;
/** 多人：置顶滚动的实时快讯条数 */
const FEED_COUNT = 6;

export default function NewsTicker() {
  const game = useGame();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const multi = useGameStore((s) => s.mode === 'multi');
  const feed = useGameStore((s) => s.mp.feed);
  // 引擎原地修改 game.news：每次渲染现算（最近 60 条打分，开销很小）
  const items = tickerHeadlines(game, TICKER_COUNT);
  const flash = multi ? feed.slice(0, FEED_COUNT) : [];
  const unread = game.news.filter((n) => !n.read).length;

  const open = (id?: string) => {
    if (id) void callSilent('markNewsRead', id);
    setView('inbox');
  };

  // 速度：每条约 6 秒
  const duration = Math.max(30, (items.length + flash.length) * 6);

  return (
    <div className="mb-4 flex h-10 items-stretch overflow-hidden rounded-xl border border-line bg-panel/90">
      <button
        onClick={() => open()}
        className="flex shrink-0 cursor-pointer items-center gap-2 bg-dota px-4 text-sm font-bold tracking-widest text-white hover:bg-dota-2"
        title="打开消息中心"
      >
        新闻
        {unread > 0 && <span className="rounded-full bg-white/90 px-1.5 text-[10px] font-bold leading-4 text-dota">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {items.length === 0 && flash.length === 0 ? (
        <div className="flex items-center px-4 text-xs text-faint">暂无新闻</div>
      ) : (
        <div className="ticker ticker-mask relative min-w-0 flex-1 overflow-hidden">
          <div className="ticker-track h-full items-center" style={{ ['--ticker-duration' as string]: `${duration}s` }}>
            {[0, 1].map((dup) => (
              <div key={dup} className="flex h-full items-center" aria-hidden={dup === 1}>
                {flash.map((f) => {
                  const t = f.actorTeamId ? game.teams[f.actorTeamId] : undefined;
                  return (
                    <button
                      key={`${dup}-feed-${f.id}`}
                      onClick={() => open()}
                      className="group flex cursor-pointer items-center gap-2 px-5 text-sm"
                      title={f.body ?? f.title}
                    >
                      <span className="text-[11px] font-semibold text-gold">【⚡ 快讯】</span>
                      {t && <span className="inline-block h-2 w-2 rounded-full" style={{ background: t.color || '#888' }} title={t.name} />}
                      <span className="font-semibold text-ink group-hover:text-gold group-hover:underline">
                        {f.actorName ? `${f.actorName}${t ? `·${t.tag}` : ''}：` : ''}
                        {f.title}
                      </span>
                      <span className="ml-3 text-faint">◆</span>
                    </button>
                  );
                })}
                {items.map((n) => {
                  const teams = (n.teamIds ?? []).map((id) => game.teams[id]).filter((t) => !!t).slice(0, 2);
                  const weekly = n.tags?.includes('weekly');
                  return (
                    <button
                      key={`${dup}-${n.id}`}
                      onClick={() => open(n.id)}
                      className="group flex cursor-pointer items-center gap-2 px-5 text-sm"
                      title={n.body}
                    >
                      <span className={cx('text-[11px] font-semibold', weekly ? 'text-gold' : CAT_COLOR[n.category])}>
                        【{weekly ? '周报' : CAT_LABEL[n.category] ?? '新闻'}】
                      </span>
                      {teams.length > 0 && (
                        <span className="flex items-center gap-0.5">
                          {teams.map((t) => (
                            <span key={t.id} className="inline-block h-2 w-2 rounded-full" style={{ background: t.color || '#888' }} title={t.name} />
                          ))}
                        </span>
                      )}
                      <span className={cx('group-hover:text-gold group-hover:underline', n.read ? 'text-mute' : 'text-ink', n.important && 'font-semibold')}>
                        {n.title}
                      </span>
                      <span className="text-[10px] text-faint">{n.date}</span>
                      <span className="ml-3 text-faint">◆</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
