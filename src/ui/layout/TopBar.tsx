// 顶栏：只保留俱乐部、赛季 / 回合、金币、荣誉与存档（回合类型、赛事、日期由底部操作栏展示；版本在「赛事 / 版本」）
// 多人模式：中间为玩家条（战队 / 昵称 / 准备 / 在线 / 出局），右侧「存档」换为聊天与离开（服务器权威，不做本地会话存档）。
// 右上角另有「更新说明」版本芯片（ChangelogPanel.tsx，有未读新版本时带红点）与背景音乐按钮，单机 / 多人两种布局都显示。
// 窄屏（docs/UI.md「顶栏的窄屏布局」）：< sm 隐藏 D2 标志（简称 + 队徽即「回到总览」）；
// 多人 < lg 时玩家条与聊天 / 离开移到顶栏第二行（玩家条可横向滚动），第一行与单机相同。第一行另有横向滚动兜底（不显示滚动条），极端宽度下也不会撑破页面。
// 手机（v0.4，docs/UI.md「手机适配」）：没有侧栏时（< md 与横屏手机，mobile.useSideNav）最左侧为导航 ☰（SideNav.NavToggle），赛季 / 回合改为简写「5/18」「TI 预选」；
// < sm 时「更新」芯片与「存档」收进导航抽屉底部（有未读更新说明时 ☰ 带蓝点）；
// 触屏上各按钮至少 40px 高；顶栏实际高度写入 CSS 变量 --chrome-top（提示、TI 预选横幅贴在其下方）；横屏矮视口（short）行高 44px。
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useGame, useGameStore } from '../../store/gameStore';
import { getPlayerTeam, regularRoundCount, formatGold } from '../../engine';
import { Button, Modal, TeamTag, cx } from '../components/common';
import SaveMenu, { useSaveStatus } from './SaveMenu';
import MpPlayersStrip from '../components/MpPlayersStrip';
import MpChat from '../components/MpChat';
import { TiAegisBadge, TiTopAccent } from '../components/TiTransition';
import MusicControl from '../components/MusicControl';
import ChangelogButton, { ChangelogModal } from '../components/ChangelogPanel';
import { useChangelogState } from '../components/NewBadge';
import { APP_VERSION, hasUnread } from '../changelog';
import { DrawerRow, NavToggle } from './SideNav';
import { useChromeVar, useCoarsePointer, useIsPhone, useMinWidth, useSideNav } from '../mobile';

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
  // < md 的简写（侧栏与完整的赛季 / 回合文字都不显示时，顶栏仍能看到进度）
  const roundShort =
    game.roundIndex === 0 ? '赛季初' : game.roundIndex <= R ? `${game.roundIndex}/${R}` : PHASE_ROUND_LABEL[game.phase] ?? `第 ${game.roundIndex} 回合`;
  const withSidebar = useSideNav();
  const phone = useIsPhone();
  const chromeRef = useChromeVar('--chrome-top', 'top');
  // 手机（< sm）顶栏放不下「更新」芯片与「存档」：收进导航抽屉底部（弹窗由这里打开）
  const [changelogOpen, setChangelogOpen] = useState(false);
  const changelogUnread = hasUnread(useChangelogState().seen);
  const drawerFooter = (close: () => void) => (
    <>
      {!multi && (
        <DrawerRow
          onClick={() => {
            close();
            setSaveOpen(true);
          }}
          title="进度自动保存到当前会话；可导出/导入存档文件"
        >
          <SaveDot /> 存档管理
        </DrawerRow>
      )}
      <DrawerRow
        onClick={() => {
          close();
          setChangelogOpen(true);
        }}
        dot={changelogUnread}
        title={changelogUnread ? `更新说明：v${APP_VERSION} 有新内容` : `更新说明：当前 v${APP_VERSION}`}
      >
        更新说明 <span className="font-mono text-xs text-faint">v{APP_VERSION}</span>
      </DrawerRow>
    </>
  );

  // 多人：≥ lg 玩家条放在第一行中间；更窄时第二行（第一行放不下玩家条，挤成 0 宽就看不到谁还没准备）
  const mpOneRow = useMinWidth(1024);
  const twoRows = multi && !mpOneRow;

  return (
    <>
    <header ref={chromeRef} className="relative shrink-0 border-b border-line bg-panel/95 backdrop-blur">
      {/* TI 正赛回合：该届主题色点缀 */}
      <TiTopAccent />
      {/* 第一行。overflow-x-auto 只是兜底（超长简称 + 极窄屏）：正常宽度下各项都放得下，不会出现滚动 */}
      <div className="no-scrollbar flex h-14 items-center gap-2 overflow-x-auto px-3 short:h-11 sm:gap-5 sm:px-4">
        {/* 没有侧栏时（< md 与横屏手机）：导航抽屉入口 */}
        {!withSidebar && <NavToggle footer={drawerFooter} extraDot={phone && changelogUnread} />}
        <button
          className="flex shrink-0 cursor-pointer items-center gap-2 text-left pointer-coarse:min-h-10 sm:pr-1"
          onClick={() => setView('dashboard')}
          title={`回到总览（${team.name}）`}
        >
          <div className="hidden h-8 w-8 shrink-0 place-items-center rounded-md bg-dota text-sm font-black text-white sm:grid">D2</div>
          <div className="whitespace-nowrap text-sm font-semibold leading-tight">
            <TeamTag color={team.color} tag={team.tag} teamId={team.id} />
            {/* 俱乐部全名：单机 ≥ sm 显示；多人第一行还要放玩家条，≥ xl 才显示。过长时截断（完整名称见按钮悬停提示） */}
            <span className={cx('ml-1.5 hidden max-w-[7.5rem] truncate align-bottom text-mute lg:max-w-[14rem]', multi ? 'xl:inline-block' : 'sm:inline-block')}>
              {team.name}
            </span>
          </div>
        </button>

        <div className={cx('hidden text-sm md:block', multi && 'shrink-0')}>
          <span className="font-semibold">TI{game.season.ti} 赛季</span>
          <span className="mx-1.5 text-faint">·</span>
          <span className="text-mute">{roundText}</span>
        </div>
        <div className="shrink-0 whitespace-nowrap text-xs leading-tight text-mute md:hidden" title={`TI${game.season.ti} 赛季 · ${roundText}`}>
          {roundShort}
        </div>

        {/* TI 预选 / 正赛回合：冠军盾徽记（单机绝对居中；多人排在玩家条之前） */}
        <TiAegisBadge />
        {multi && !twoRows && <MpPlayersStrip className="flex-1" />}

        <div className={cx('flex shrink-0 items-center gap-1.5 whitespace-nowrap sm:gap-4', (!multi || twoRows) && 'ml-auto')}>
          <button className="cursor-pointer text-right pointer-coarse:min-h-10" onClick={() => setView('finance')} title="俱乐部 / 财务">
            <div className="text-[11px] text-faint">金币</div>
            <div className={cx('text-sm font-bold tabular', team.gold < 0 ? 'text-bad' : 'text-gold')}>{formatGold(team.gold)}</div>
          </button>
          <button className="cursor-pointer text-right pointer-coarse:min-h-10" onClick={() => setView('club')} title="俱乐部 / 荣誉史">
            <div className="text-[11px] text-faint">荣誉</div>
            <div className={cx('text-sm font-bold tabular', team.honor < 50 ? 'text-bad' : 'text-ink')}>{Math.round(team.honor)}</div>
          </button>
          {/* 更新说明：版本芯片，有未读新版本时带红点；手机（< sm）收进导航抽屉 */}
          {!phone && <ChangelogButton />}
          {/* 背景音乐（第十波 #6）：开关 / 音量 / 音源 */}
          <MusicControl />
          {multi ? (
            !twoRows && <MpTopActions />
          ) : (
            // 手机（< sm）收进导航抽屉（「存档管理」）
            !phone && (
              <Button variant="ghost" size="sm" onClick={() => setSaveOpen(true)} title="进度自动保存到当前会话；可导出/导入存档文件">
                <SaveDot /> 存档
              </Button>
            )
          )}
        </div>
      </div>
      {/* 多人 < lg：第二行 = 玩家条（横向滚动）+ 聊天 / 离开 */}
      {twoRows && (
        <div className="flex items-center gap-2 border-t border-line/60 px-3 py-1.5 short:py-1 sm:px-4">
          <MpPlayersStrip className="flex-1" />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <MpTopActions />
          </div>
        </div>
      )}
    </header>
    {/* 弹窗放在 header 外：header 的 backdrop-filter 会成为 fixed 定位的包含块 */}
    <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="存档管理" width="max-w-lg">
      <SaveMenu onDone={() => setSaveOpen(false)} />
    </Modal>
    {changelogOpen && createPortal(<ChangelogModal onClose={() => setChangelogOpen(false)} />, document.body)}
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
  const publicServer = useGameStore((s) => s.mp.serverMode === 'public');
  const [chatOpen, setChatOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  // 触屏不自动聚焦输入框：一打开就弹出软键盘、挡住半个屏幕
  const coarse = useCoarsePointer();
  // 聊天面板贴在顶栏下方（窄屏顶栏有两行，高度不固定）
  const [chatTop, setChatTop] = useState(64);
  const chatBtnRef = useRef<HTMLSpanElement>(null);
  const chatPanelRef = useRef<HTMLDivElement>(null);
  const toggleChat = (e: MouseEvent<HTMLButtonElement>) => {
    const bottom = e.currentTarget.closest('header')?.getBoundingClientRect().bottom;
    if (typeof bottom === 'number') setChatTop(Math.round(bottom) + 8);
    setChatOpen((v) => !v);
  };
  // 点面板外（聊天按钮除外，它自己切换）或按 Esc 收起；pointerdown：iOS Safari 点按非可点击元素不发 mousedown
  useEffect(() => {
    if (!chatOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (chatPanelRef.current?.contains(t) || chatBtnRef.current?.contains(t)) return;
      setChatOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [chatOpen]);
  return (
    <>
      <span ref={chatBtnRef} className="contents">
        <Button variant="ghost" size="sm" onClick={toggleChat} title="房间聊天">
          聊天
          {unread > 0 && !chatOpen && <span className="rounded-full bg-dota px-1.5 text-[10px] font-bold leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
        </Button>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          // 先收起聊天面板，否则它会盖在「离开多人对局」弹窗上
          setChatOpen(false);
          setLeaveOpen(true);
        }}
        title={roomName ? `房间「${roomName}」（${roomId}）` : '离开对局'}
      >
        离开
      </Button>
      {/* 弹层用 portal 挂到 body：header 的 backdrop-filter 会成为 fixed 定位的包含块。
          层级 z-[48]：在内容、底栏与 TI 横幅之上，弹窗（z-50）之下；消息列表最高 = 顶栏以下的视口 − 标题行 − 输入行（横屏矮视口时输入框仍在屏幕内） */}
      {chatOpen &&
        createPortal(
          <div
            ref={chatPanelRef}
            className="fade-up fixed right-3 z-[48] w-80 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/50 sm:right-4"
            style={{ top: chatTop }}
          >
            <div className="flex items-center justify-between border-b border-line py-1 pl-3 pr-1 text-sm font-semibold">
              房间聊天
              <button
                type="button"
                className="grid h-9 w-9 cursor-pointer place-items-center rounded-md text-mute hover:bg-panel-2 hover:text-ink"
                onClick={() => setChatOpen(false)}
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
            <MpChat height="h-72" listMaxHeight={`max(4rem, calc(100dvh - ${chatTop + 12 + 46 + 58}px))`} autoFocus={!coarse} />
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
              {publicServer ? '对局进度保存在服务器上。' : '对局进度保存在房主的服务器上。'}<span className="text-ink">暂时离开</span>：断开连接回到主菜单，你的座位保留，再次进入多人大厅即可回到对局；
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
