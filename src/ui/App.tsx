import { useEffect, useRef, useState } from 'react';
import { useGameStore, type HubKey } from '../store/gameStore';
import { ToastHost } from './components/common';
import TopBar from './layout/TopBar';
import SideNav from './layout/SideNav';
import ActionBar from './layout/ActionBar';
import MainMenu from './screens/MainMenu';
import NewGame from './screens/NewGame';
import GameOver from './screens/GameOver';
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
import Lobby from './screens/Lobby';
import Room from './screens/Room';
import MpToastHost from './components/MpToasts';
import MpOverlay from './components/MpOverlay';
import TiTransition from './components/TiTransition';

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
  // 切换页面 / 标签时回到顶部
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [view, tab]);
  if (gameOver || (seatOut && !spectating))
    return (
      <>
        <GameOver onSpectate={!gameOver && seatOut ? () => setSpectating(true) : undefined} />
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
        <SideNav />
        <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <ErrorBoundary key={view}>
            <View />
          </ErrorBoundary>
        </main>
      </div>
      <ActionBar />
      {/* 回合通知不再弹窗：总览顶部为「通知」卡片，其他页面只在左下角（侧栏底部）显示徽标（点击回到总览）。
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
          className="fixed bottom-24 right-4 z-40 cursor-pointer rounded-full border border-line bg-panel/95 px-3 py-1.5 text-xs text-ink shadow-lg hover:border-gold hover:text-gold"
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
  return (
    <div className="app-bg h-full">
      {screen === 'menu' && <MainMenu />}
      {screen === 'newgame' && <NewGame />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'room' && <Room />}
      {screen === 'game' && <GameScreen />}
      {/* 多人：提示宿主额外显示其他玩家的实时快讯；断线时显示重连遮罩 */}
      {multi ? <MpToastHost /> : <ToastHost />}
      {multi && <MpOverlay />}
    </div>
  );
}
