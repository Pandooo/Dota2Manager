import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useGameStore, type HubKey } from '../store/gameStore';
import { ToastHost } from './components/common';
import TopBar from './layout/TopBar';
import SideNav from './layout/SideNav';
import ActionBar from './layout/ActionBar';
import MainMenu from './screens/MainMenu';
import Dashboard from './screens/Dashboard';
import Inbox from './screens/Inbox';
import TeamHub from './screens/TeamHub';
import TransferHub from './screens/TransferHub';
import EventsHub from './screens/EventsHub';
import ClubHub from './screens/ClubHub';
import PediaHub from './screens/PediaLazy';
import Match from './screens/Match';
import PlayerModal from './components/PlayerModal';
import TeamModal from './components/TeamModal';
import { NoticeBadge } from './components/PopupHost';
import ErrorBoundary from './components/ErrorBoundary';
import MpToastHost from './components/MpToasts';
import MpOverlay from './components/MpOverlay';
import TiTransition from './components/TiTransition';
import MusicControl from './components/MusicControl';
import { TouchTipHost } from './components/TouchTip';
import { initBgm } from './audio/bgm';
import { useIsPhone, useSideNav } from './mobile';

// 生涯总结（游戏结束 / 多人本座位出局时才显示）：按需加载，主包保持在 vite.config.ts 的 800 kB 提示线以内
const GameOver = lazy(() => import('./screens/GameOver'));
// 新游戏向导（每局只用一次）与多人大厅 / 房间（只在进入多人时用到）：v0.4 手机适配后主包超过提示线，改为按需加载
const NewGame = lazy(() => import('./screens/NewGame'));
const Lobby = lazy(() => import('./screens/Lobby'));
const Room = lazy(() => import('./screens/Room'));

/** 侧栏 6 个中心页 + 独立的比赛页（中心页内的标签由各 Hub 根据 store.tab 渲染） */
const VIEWS: Record<HubKey, () => React.JSX.Element> = {
  dashboard: Dashboard,
  team: TeamHub,
  transfer: TransferHub,
  events: EventsHub,
  club: ClubHub,
  inbox: Inbox,
  match: Match,
  pedia: PediaHub,
};

function GameScreen() {
  const view = useGameStore((s) => s.view);
  const tab = useGameStore((s) => s.tab);
  const gameOver = useGameStore((s) => s.game?.gameOver);
  useGameStore((s) => s.version);
  // 多人：本座位已出局（解散 / 全员假赛除名）→ 先展示自己的生涯总结，可切换为观战（GameOver onSpectate）
  const seatOut = useGameStore((s) => {
    const g = s.game;
    const me = g?.settings?.playerTeamId;
    return !!(g?.multiplayer && me && g.multiplayer.seats?.[me]?.eliminated);
  });
  const [spectating, setSpectating] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  // < md（手机 / 窄平板）与横屏手机（矮视口且 < lg）不渲染侧栏：导航在顶栏 ☰ 的抽屉里（docs/UI.md「手机适配 · 导航」）
  const withSidebar = useSideNav();
  const phone = useIsPhone();
  // 切换页面 / 标签时回到顶部
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [view, tab]);
  if (gameOver || (seatOut && !spectating))
    return (
      <>
        <Suspense fallback={<div className="py-16 text-center text-sm text-mute">正在载入生涯总结…</div>}>
          <GameOver onSpectate={!gameOver && seatOut ? () => setSpectating(true) : undefined} />
        </Suspense>
        {/* 手机：音乐按钮放在生涯总结横幅里（随页面滚走），固定在右上角会压住排行表的右侧几列 */}
        {!phone && <MusicControl floating />}
        <PlayerModal />
        <TeamModal />
        {/* 结束时直接进入生涯总结：不再逐条弹出积压的回合通知（用户反馈：要点几十下才能清空） */}
      </>
    );
  const View = VIEWS[view] ?? Dashboard;
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {withSidebar && <SideNav />}
        {/* 手机内边距收窄（px-3 py-4）；MatchDock 的通栏出血按同样的断点取负外边距 */}
        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-5">
          <ErrorBoundary key={view}>
            <View />
          </ErrorBoundary>
        </main>
      </div>
      <ActionBar />
      {/* 回合通知不再弹窗：总览顶部为「通知」卡片，其他页面只在左下角（侧栏底部）显示徽标（点击回到总览；< md 改为顶栏 ☰ 上的蓝点）。
          训练 / 赛事操作是总览「本回合」中内嵌的可展开卡片（store.trainingOpen / tournamentOpen）。 */}
      <NoticeBadge />
      <PlayerModal />
      <TeamModal />
      {/* TI 正赛转场 / 预选横幅（每个存档 × 座位 × 届次一次；触发见 store syncTiIntro） */}
      <TiTransition />
      {seatOut && (
        <button
          type="button"
          onClick={() => setSpectating(false)}
          className="fixed z-40 cursor-pointer rounded-full border border-line bg-panel/95 px-3 py-1.5 text-xs text-ink shadow-lg hover:border-gold hover:text-gold pointer-coarse:min-h-10"
          // 在底栏上方（--chrome-bottom = 底栏实际高度，手机两三行时也不压住）
          style={{ bottom: 'calc(var(--chrome-bottom, 72px) + 24px)', right: 'calc(1rem + env(safe-area-inset-right, 0px))' }}
        >
          查看生涯总结
        </button>
      )}
    </div>
  );
}

export default function App() {
  const screen = useGameStore((s) => s.screen);
  const multi = useGameStore((s) => s.mode === 'multi');
  // 刷新 / 重新打开页面时回到上次所在的多人房间（服务器按会话 ID 恢复座位）
  useEffect(() => {
    useGameStore.getState().mpResumeIfNeeded();
  }, []);
  // 背景音乐（第十波 #6）：首次用户交互后开始播放（自动播放策略）
  useEffect(() => {
    initBgm();
  }, []);
  return (
    // 安全区（index.html viewport-fit=cover）：根容器让出顶部（刘海 / 状态栏）与左右（横屏刘海）；底部由贴底的栏各自让出（pb-safe）
    <div className="app-bg h-full pt-safe px-safe">
      {screen === 'menu' && <MainMenu />}
      {screen === 'newgame' && (
        <Suspense fallback={<div className="py-16 text-center text-sm text-mute">正在载入新游戏向导…</div>}>
          <NewGame />
        </Suspense>
      )}
      {(screen === 'lobby' || screen === 'room') && (
        <Suspense fallback={<div className="py-16 text-center text-sm text-mute">正在载入多人大厅…</div>}>
          {screen === 'lobby' ? <Lobby /> : <Room />}
        </Suspense>
      )}
      {screen === 'game' && <GameScreen />}
      {/* 非游戏界面没有顶栏：背景音乐控制固定在角落（主菜单右上角空着；新游戏 / 大厅 / 房间的右上角有返回按钮或玩家名 → 右下角） */}
      {screen !== 'game' && <MusicControl floating={screen === 'menu' ? 'top' : 'bottom'} />}
      {/* 多人：提示宿主额外显示其他玩家的实时快讯；断线时显示重连遮罩 */}
      {multi ? <MpToastHost /> : <ToastHost />}
      {multi && <MpOverlay />}
      {/* 触屏：点按禁用按钮时显示其原因（Button 的 title） */}
      <TouchTipHost />
    </div>
  );
}
