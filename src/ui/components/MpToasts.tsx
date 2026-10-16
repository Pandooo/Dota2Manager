// ============================================================================
// 多人模式的提示宿主（替代 ToastHost）：顶栏下方居中（见 common.useToastPlacement），其他玩家的实时快讯「⚡ 玩家·战队：标题」
// 与普通操作提示（与单机 ToastHost 样式一致）按出现顺序排列，合计最多 store.TOAST_MAX_VISIBLE 条，超出时最早的一条提前渐隐。
// 单机模式仍使用 common.ToastHost。完整的快讯列表在消息中心「其他玩家动态」。
// ============================================================================
import type { ReactNode } from 'react';
import { useGameStore, type FeedToast } from '../../store/gameStore';
import { ToastCard, cx, useToastPlacement } from './common';

export default function MpToastHost() {
  const toasts = useGameStore((s) => s.toasts);
  const feedToasts = useGameStore((s) => s.mp.feedToasts);
  const place = useToastPlacement();

  // 早出现的在上、新出现的在下（最早的一条最先渐隐让位）
  const items: { order: number; node: ReactNode }[] = [
    ...feedToasts.map((f) => ({ order: f.order, node: <FeedCard key={`feed-${f.id}`} feed={f} anim={place.anim} /> })),
    ...toasts.map((t) => ({ order: t.order, node: <ToastCard key={`toast-${t.id}`} toast={t} anim={place.anim} /> })),
  ].sort((a, b) => a.order - b.order);

  return (
    <div className={place.className} style={place.style}>
      {items.map((it) => it.node)}
    </div>
  );
}

/** 一条其他玩家的实时快讯：点按打开消息中心，✕ 只关闭 */
function FeedCard({ feed: f, anim }: { feed: FeedToast; anim: string }) {
  const dismissFeed = useGameStore((s) => s.mpDismissFeed);
  const teams = useGameStore((s) => s.game?.teams);
  const inGame = useGameStore((s) => s.screen === 'game');
  const setView = useGameStore((s) => s.setView);
  const team = f.actorTeamId ? teams?.[f.actorTeamId] : undefined;
  const who = [f.actorName, team?.name].filter(Boolean).join('·');
  return (
    <div
      onClick={() => {
        if (f.leaving) return;
        dismissFeed(f.id);
        if (inGame) setView('inbox');
      }}
      className={cx(
        f.leaving ? 'toast-out pointer-events-none' : cx(anim, 'pointer-events-auto'),
        'flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-2xl shadow-black/50 backdrop-blur',
        f.important ? 'border-gold/70 bg-[#2a2210]/95' : 'border-gold/40 bg-[#1b1a14]/95',
      )}
      title={f.body ? `${f.body}\n（点击查看消息中心）` : '点击查看消息中心'}
    >
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-gold text-xs font-bold text-black">⚡</span>
      <span className="min-w-0 flex-1 leading-relaxed">
        {team && <span className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle" style={{ background: team.color || '#888' }} />}
        {who && <span className="font-semibold text-gold">{who}：</span>}
        <span className="text-ink">{f.title}</span>
      </span>
      {/* 只关闭、不跳转（点快讯本身会打开消息中心） */}
      <button
        type="button"
        aria-label="关闭"
        title="关闭"
        onClick={(e) => {
          e.stopPropagation();
          dismissFeed(f.id);
        }}
        className="-my-1.5 -mr-2 grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-md text-xs text-mute hover:bg-panel-3/60 hover:text-ink"
      >
        ✕
      </button>
    </div>
  );
}
