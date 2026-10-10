// ============================================================================
// 顶栏玩家条（多人模式）：每位玩家的战队简称/颜色、昵称、回合准备 ✓、在线状态、出局 / 托管标记。点击查看战队详情。
// 房主可以托管离线玩家（服务器代为处理事件、快速模拟比赛并准备，玩家重连后自动解除），避免整个房间卡住。
// ============================================================================
import { mpHumanTeamIds, useGame, useGameStore } from '../../store/gameStore';
import { isRoomHost } from '../../shared/protocol';
import { cx } from './common';
import { OnlineDot } from './MpKit';

export default function MpPlayersStrip({ className }: { className?: string }) {
  const game = useGame();
  const roundStatus = useGameStore((s) => s.mp.roundStatus);
  const room = useGameStore((s) => s.mp.room);
  const openTeam = useGameStore((s) => s.openTeam);
  const send = useGameStore((s) => s.mpSend);
  const me = game.settings.playerTeamId;
  const isHost = isRoomHost(room);
  const ids = mpHumanTeamIds({ roundStatus, room }, game);
  if (!ids.length) return null;
  const seatOf = (teamId: string) => room?.seats.find((s) => s.gameTeamId === teamId);

  return (
    <div className={cx('flex min-w-0 items-center gap-1.5 overflow-x-auto', className)}>
      {ids.map((id) => {
        const team = game.teams[id];
        const seat = seatOf(id);
        const name = roundStatus?.names?.[id] ?? seat?.name ?? '玩家';
        const ready = !!roundStatus?.ready?.[id];
        const online = roundStatus?.connected?.[id] ?? seat?.connected ?? false;
        const out = !!roundStatus?.eliminated?.[id];
        const auto = !!roundStatus?.autopilot?.[id];
        const isMe = id === me;
        const canToggle = isHost && !isMe && !out && !game.gameOver && (auto || !online);
        const color = team?.color || '#8b96ab';
        const title = [
          `${name}${isMe ? '（我）' : ''}`,
          team ? `${team.name}（${team.tag}）` : id,
          online ? '在线' : '离线',
          ...(auto ? ['托管中（服务器代为操作）'] : []),
          out ? '已出局（观战）' : ready ? '已准备' : '未准备',
        ].join(' · ');
        return (
          <span key={id} className="flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => openTeam(id)}
              title={title}
              className={cx(
                'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border py-1 pl-1 pr-2 text-xs transition-colors',
                isMe ? 'border-gold/50 bg-gold/10' : 'border-line bg-panel-2/60 hover:border-gold/40',
                out && 'opacity-50',
              )}
            >
              <span
                className="grid h-5 min-w-[1.75rem] place-items-center rounded px-1 text-[10px] font-black text-white ring-1 ring-black/30"
                style={{ background: color }}
              >
                {(team?.tag ?? '?').slice(0, 5)}
              </span>
              <OnlineDot online={online} />
              <span className={cx('max-w-[6.5rem] truncate', isMe ? 'font-semibold text-gold' : 'text-ink', out && 'line-through')}>{name}</span>
              {auto && !out && <span className="rounded bg-gold/20 px-1 text-[10px] text-gold">托管</span>}
              {out ? (
                <span className="rounded bg-bad/20 px-1 text-[10px] text-bad">出局</span>
              ) : ready ? (
                <span className="font-bold text-good" aria-label="已准备">
                  ✓
                </span>
              ) : (
                <span className="text-faint" aria-label="未准备">
                  …
                </span>
              )}
            </button>
            {canToggle && (
              <button
                onClick={() => send({ t: 'setAutopilot', teamId: id, on: !auto })}
                title={
                  auto
                    ? `取消托管 ${name}（之后需要 ${name} 回来亲自操作才能推进回合）`
                    : `托管离线玩家 ${name}：服务器代为处理待决事件（保守选项）、快速模拟比赛并准备；${name} 重连后自动解除`
                }
                className="cursor-pointer rounded border border-line px-1.5 py-1 text-[10px] text-mute transition-colors hover:border-gold/50 hover:text-gold"
              >
                {auto ? '取消托管' : '托管'}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
