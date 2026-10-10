// ============================================================================
// 多人模式的提示宿主（替代 ToastHost）：顶部居中，上方为其他玩家的实时快讯「⚡ 玩家·战队：标题」，
// 下方为普通操作提示（与单机 ToastHost 样式一致）。单机模式仍使用 common.ToastHost。
// ============================================================================
import { useGameStore } from '../../store/gameStore';
import { cx } from './common';

export default function MpToastHost() {
  const toasts = useGameStore((s) => s.toasts);
  const dismiss = useGameStore((s) => s.dismissToast);
  const feedToasts = useGameStore((s) => s.mp.feedToasts);
  const dismissFeed = useGameStore((s) => s.mpDismissFeed);
  const teams = useGameStore((s) => s.game?.teams);
  const inGame = useGameStore((s) => s.screen === 'game');
  const setView = useGameStore((s) => s.setView);

  return (
    <div className="pointer-events-none fixed left-1/2 top-16 z-[70] flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col items-stretch gap-2">
      {feedToasts.map((f) => {
        const team = f.actorTeamId ? teams?.[f.actorTeamId] : undefined;
        const who = [f.actorName, team?.name].filter(Boolean).join('·');
        return (
          <div
            key={`feed-${f.id}`}
            onClick={() => {
              dismissFeed(f.id);
              if (inGame) setView('inbox');
            }}
            className={cx(
              'toast-drop pointer-events-auto flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-2xl shadow-black/50 backdrop-blur',
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
          </div>
        );
      })}
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cx(
            'toast-drop pointer-events-auto flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl shadow-black/50 whitespace-pre-line backdrop-blur',
            t.ok ? 'border-good/50 bg-[#10241b]/95 text-ink' : 'border-bad/60 bg-[#2a1416]/95 text-[#ffd0d0]',
          )}
          title="点击关闭"
        >
          <span className={cx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-bold', t.ok ? 'bg-good text-black' : 'bg-bad text-white')}>
            {t.ok ? '✓' : '!'}
          </span>
          <span className="min-w-0 flex-1 leading-relaxed">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
