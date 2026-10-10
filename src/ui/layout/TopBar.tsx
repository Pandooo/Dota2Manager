// 顶栏：只保留俱乐部、赛季 / 回合、金币、荣誉与存档（回合类型、赛事、日期由底部操作栏展示；版本在「赛事 / 版本」）
// 多人模式：中间为玩家条（战队 / 昵称 / 准备 / 在线 / 出局），右侧「存档」换为聊天与离开（服务器权威，不做本地会话存档）。
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useGame, useGameStore } from '../../store/gameStore';
import { getPlayerTeam, regularRoundCount, formatGold } from '../../engine';
import { Button, Modal, TeamTag, cx } from '../components/common';
import SaveMenu, { useSaveStatus } from './SaveMenu';
import MpPlayersStrip from '../components/MpPlayersStrip';
import MpChat from '../components/MpChat';
import { TiTopAccent } from '../components/TiTransition';

const PHASE_ROUND_LABEL: Record<string, string> = {
  ti_qualifier: 'TI 预选赛',
  ti: 'TI 正赛',
  season_end: 'TI 结算',
};

export default function TopBar() {
  const game = useGame();
  const setView = useGameStore((s) => s.setView);
  const [saveOpen, setSaveOpen] = useState(false);
  const multi = useGameStore((s) => s.mode === 'multi');
  const team = getPlayerTeam(game);
  const R = regularRoundCount(game.season);
  const roundText =
    game.roundIndex === 0 ? '赛季初' : game.roundIndex <= R ? `第 ${game.roundIndex}/${R} 回合` : PHASE_ROUND_LABEL[game.phase] ?? `第 ${game.roundIndex} 回合`;

  return (
    <>
    <header className="relative flex h-14 shrink-0 items-center gap-5 border-b border-line bg-panel/95 px-4 backdrop-blur">
      {/* TI 正赛回合：该届主题色点缀 */}
      <TiTopAccent />
      <button className="flex cursor-pointer items-center gap-2 pr-1 text-left" onClick={() => setView('dashboard')} title="回到总览">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-dota text-sm font-black text-white">D2</div>
        <div className="text-sm font-semibold leading-tight">
          <TeamTag color={team.color} tag={team.tag} /> <span className="ml-1 text-mute">{team.name}</span>
        </div>
      </button>

      <div className={cx('hidden text-sm md:block', multi && 'shrink-0')}>
        <span className="font-semibold">TI{game.season.ti} 赛季</span>
        <span className="mx-1.5 text-faint">·</span>
        <span className="text-mute">{roundText}</span>
      </div>

      {multi && <MpPlayersStrip className="flex-1" />}

      <div className={cx('flex items-center gap-4', multi ? 'shrink-0' : 'ml-auto')}>
        <button className="cursor-pointer text-right" onClick={() => setView('finance')} title="俱乐部 / 财务">
          <div className="text-[11px] text-faint">金币</div>
          <div className={cx('text-sm font-bold tabular', team.gold < 0 ? 'text-bad' : 'text-gold')}>{formatGold(team.gold)}</div>
        </button>
        <button className="cursor-pointer text-right" onClick={() => setView('club')} title="俱乐部 / 荣誉史">
          <div className="text-[11px] text-faint">荣誉</div>
          <div className={cx('text-sm font-bold tabular', team.honor < 50 ? 'text-bad' : 'text-ink')}>{Math.round(team.honor)}</div>
        </button>
        {multi ? (
          <MpTopActions />
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setSaveOpen(true)} title="进度自动保存到当前会话；可导出/导入存档文件">
            <SaveDot /> 存档
          </Button>
        )}
      </div>
    </header>
    {/* 弹窗放在 header 外：header 的 backdrop-filter 会成为 fixed 定位的包含块 */}
    <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="存档管理" width="max-w-lg">
      <SaveMenu onDone={() => setSaveOpen(false)} />
    </Modal>
    </>
  );
}

/** 多人：聊天 + 离开（顶栏右侧） */
function MpTopActions() {
  const unread = useGameStore((s) => s.mp.chatUnread);
  const roomName = useGameStore((s) => s.mp.room?.name);
  const roomId = useGameStore((s) => s.mp.room?.id);
  const leaveRoom = useGameStore((s) => s.mpLeaveRoom);
  const exit = useGameStore((s) => s.mpExit);
  const [chatOpen, setChatOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setChatOpen((v) => !v)} title="房间聊天">
        聊天
        {unread > 0 && !chatOpen && <span className="rounded-full bg-dota px-1.5 text-[10px] font-bold leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setLeaveOpen(true)} title={roomName ? `房间「${roomName}」（${roomId}）` : '离开对局'}>
        离开
      </Button>
      {/* 弹层用 portal 挂到 body：header 的 backdrop-filter 会成为 fixed 定位的包含块 */}
      {chatOpen &&
        createPortal(
          <div className="fade-up fixed right-4 top-16 z-[60] w-80 overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-semibold">
              房间聊天
              <button className="cursor-pointer text-mute hover:text-ink" onClick={() => setChatOpen(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <MpChat height="h-72" autoFocus />
          </div>,
          document.body,
        )}
      {leaveOpen &&
        createPortal(
          <Modal
            open
            onClose={() => setLeaveOpen(false)}
            title="离开多人对局"
            width="max-w-md"
            footer={
              <>
                <Button variant="ghost" onClick={() => setLeaveOpen(false)}>
                  取消
                </Button>
                <Button variant="secondary" onClick={exit} title="断开连接回到主菜单；座位保留，再次进入多人大厅会自动回到对局">
                  暂时离开
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    setLeaveOpen(false);
                    leaveRoom();
                  }}
                  title="退出房间回到大厅（之后可用房间码重新加入）"
                >
                  退出房间
                </Button>
              </>
            }
          >
            <p className="text-sm leading-relaxed text-mute">
              对局进度保存在房主的服务器上。<span className="text-ink">暂时离开</span>：断开连接回到主菜单，你的座位保留，再次进入多人大厅即可回到对局；
              <span className="text-ink">退出房间</span>：回到大厅，之后可在房间列表或用房间码 <span className="font-mono text-gold">{roomId}</span> 重新加入。
            </p>
          </Modal>,
          document.body,
        )}
    </>
  );
}

/** 自动保存状态小圆点 */
function SaveDot() {
  const s = useSaveStatus();
  const color = s.state === 'error' ? 'bg-bad' : s.state === 'saving' ? 'bg-gold animate-pulse' : s.state === 'saved' ? 'bg-good' : 'bg-faint';
  return <span className={cx('inline-block h-1.5 w-1.5 rounded-full', color)} />;
}
