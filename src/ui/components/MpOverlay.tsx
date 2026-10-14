// ============================================================================
// 多人模式断线遮罩：在房间 / 游戏中与服务器断开时覆盖全屏，显示自动重连状态。
// 重连成功后服务器按会话 ID 把玩家放回原座位并重新推送房间与状态，遮罩自动消失。
// ============================================================================
import { useGameStore } from '../../store/gameStore';
import { Button } from './common';
import { Spinner } from './ShellKit';
import { netStatusText, useTicker } from './MpKit';

export default function MpOverlay() {
  const multi = useGameStore((s) => s.mode === 'multi');
  const screen = useGameStore((s) => s.screen);
  const net = useGameStore((s) => s.mp.net);
  const reconnect = useGameStore((s) => s.mpReconnect);
  const exit = useGameStore((s) => s.mpExit);
  const publicServer = useGameStore((s) => s.mp.serverMode === 'public');
  const show = multi && (screen === 'game' || screen === 'room') && net.status !== 'open';
  useTicker(show && net.status === 'reconnecting');
  if (!show) return null;
  const s = netStatusText(net);
  // 被其他页面顶替 / 协议版本不一致：不会自动重连，由玩家决定是否在此页面重新连接
  const stopped = net.status === 'closed' && !!net.closeCode;
  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="fade-up w-full max-w-md overflow-hidden rounded-xl border border-bad/50 bg-panel shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          {!stopped && <Spinner className="h-5 w-5 text-gold" />}
          <div className="text-base font-semibold">{stopped ? '此页面已断开' : '与服务器的连接已断开'}</div>
        </div>
        <div className="space-y-2 px-5 py-4 text-sm leading-relaxed text-mute">
          {stopped ? <p className="text-ink">{net.error}</p> : <p className="text-ink">{s.text}</p>}
          {!stopped && net.error && <p className="text-xs text-faint">原因：{net.error}</p>}
          <p className="text-xs">
            服务器地址：<span className="font-mono text-ink">{net.url || '—'}</span>
          </p>
          <p className="text-xs">
            {net.closeCode === 4000
              ? '可以关闭此页面，在另一个页面继续游戏；或点「在此页面继续」把连接切换到这里（另一个页面会断开）。'
              : publicServer
                ? '你的座位会一直保留：重连成功后自动回到房间，游戏进度以服务器为准。服务器重启或维护时请稍候，恢复后会自动重连。'
                : '你的座位会一直保留：重连成功后自动回到房间，游戏进度以服务器为准。若房主的服务器已关闭，请等待房主重新启动。'}
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="ghost" onClick={exit} title="断开并返回主菜单（之后可在多人大厅重新加入）">
            返回主菜单
          </Button>
          <Button
            variant="primary"
            onClick={reconnect}
            disabled={net.status === 'connecting'}
            title={net.closeCode === 4000 ? '在此页面重新连接（另一个页面会被断开）' : undefined}
          >
            {net.closeCode === 4000 ? '在此页面继续' : net.closeCode === 4002 ? '重试连接' : '立即重连'}
          </Button>
        </div>
      </div>
    </div>
  );
}
