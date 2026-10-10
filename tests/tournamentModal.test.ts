// 总览赛事卡片（内嵌在「本回合」中、可展开；原赛事面板弹窗）：自动展开判定（纯函数）、真实引擎下的关注进度，
// 以及 store.syncTournamentCard 的完整流程（赛事回合开始时自动展开、回合内由玩家决定、非赛事回合收起），
// 和 setTournamentOpen / setTrainingOpen 的「回到总览 + 展开 + 滚动请求」。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState } from '../src/engine/types';
import { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimSeries, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { playerNextSeries } from '../src/engine/tournament';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import {
  mySeriesResults, roundTournamentOf, tourCardAutoExpand, tourModalFocus, tourRoundKeyOf, type TourModalFocus,
} from '../src/ui/components/TourModalLogic';
import { syncTournamentCard, useGameStore } from '../src/store/gameStore';

registerNodeRosterLoader();

const focus = (over: Partial<TourModalFocus> = {}): TourModalFocus => ({
  key: 'g@t|og|ti9|r2|cup',
  sig: '0|s1',
  tournamentId: 'cup',
  actionable: true,
  ...over,
});

describe('tourCardAutoExpand：新回合是否自动展开赛事卡片', () => {
  it('本方在本回合的赛事仍有比赛要打 → 展开', () => {
    expect(tourCardAutoExpand(focus())).toBe(true);
  });

  it('没有赛事 / 本方比赛已结束 → 收起', () => {
    expect(tourCardAutoExpand(null)).toBe(false);
    expect(tourCardAutoExpand(undefined)).toBe(false);
    expect(tourCardAutoExpand(focus({ actionable: false }))).toBe(false);
  });
});

/** 推进到本方有就绪系列赛的赛事回合（自动处理待决事件，清空回合通知） */
async function gameAtTournamentRound(): Promise<GameState> {
  const g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '测试', teamId: 'og', seed: 7 });
  for (let step = 0; step < 40; step++) {
    g.popups.length = 0;
    for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
      const d = g.pendingDecisions[0];
      resolveDecision(g, d.id, d.choices[0]?.id ?? '');
      if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
    }
    const t = currentPlayerTournament(g);
    if (t && t.status === 'running' && playerNextSeries(g, t.id)) return g;
    if (!advance(g).ok) fillLineupWithTempSubs(g);
  }
  throw new Error('没有找到玩家的赛事回合');
}

describe('tourModalFocus：真实引擎的赛事回合', () => {
  let g: GameState;
  beforeAll(async () => {
    g = await gameAtTournamentRound();
  });

  it('本回合赛事、进度签名随系列赛推进而变化，本方比赛结束后不再自动展开', () => {
    const t = roundTournamentOf(g)!;
    expect(t).toBeTruthy();
    expect(t.id).toBe(currentPlayerTournament(g)!.id);
    const f0 = tourModalFocus(g)!;
    expect(f0.actionable).toBe(true);
    expect(f0.tournamentId).toBe(t.id);
    expect(f0.key).toContain(`|${g.settings.playerTeamId}|ti${g.season.ti}|r${g.roundIndex}|${t.id}`);
    expect(f0.sig).toBe(`0|${playerNextSeries(g, t.id)!.id}`);

    expect(quickSimSeries(g).ok).toBe(true);
    const f1 = tourModalFocus(g)!;
    expect(f1.key).toBe(f0.key);
    expect(f1.sig).not.toBe(f0.sig);
    expect(f1.sig.startsWith(`${mySeriesResults(g.tournaments[t.id], g.settings.playerTeamId).length}|`)).toBe(true);

    quickSimTournament(g);
    const fin = tourModalFocus(g)!;
    // 赛事已结束（或已被淘汰）：卡片仍在（可展开查看结果），但新回合不会因它自动展开
    expect(fin.tournamentId).toBe(t.id);
    expect(fin.actionable).toBe(false);
    expect(roundTournamentOf(g)?.id).toBe(t.id);
  });
});

describe('store.syncTournamentCard：赛事卡片自动展开流程', () => {
  it('赛事回合开始时展开（不等待通知 / TI 转场）；回合内由玩家决定；进入新回合重新判定；离开游戏界面收起', async () => {
    const g = await gameAtTournamentRound();
    const prev = useGameStore.getState();
    const bump = () => useGameStore.setState((s) => ({ version: s.version + 1 }));
    try {
      // 有待读通知、TI 横幅进行中也直接展开（卡片内嵌在总览，不弹窗）
      g.popups.push({ kind: 'message', title: '通知', body: '' });
      useGameStore.setState({ screen: 'menu', tournamentOpen: false });
      useGameStore.setState({ game: g, screen: 'game', mode: 'single', view: 'events', tournamentOpen: false, tiIntro: { kind: 'qualifier', ti: g.season.ti, key: 'k' } });
      expect(useGameStore.getState().tournamentOpen).toBe(true);
      // 自动展开只改变卡片状态，不切换页面
      expect(useGameStore.getState().view).toBe('events');
      useGameStore.setState({ tiIntro: null, view: 'dashboard' });

      // 玩家收起后，同一回合内的状态变化（打完一场等）不会再展开
      useGameStore.getState().setTournamentOpen(false);
      quickSimSeries(g);
      bump();
      syncTournamentCard();
      expect(useGameStore.getState().tournamentOpen).toBe(false);

      // 从其他页面请求打开：回到总览、展开，并发出滚动请求（seq 递增）
      useGameStore.getState().setView('squad');
      const seq0 = useGameStore.getState().cardFocus?.seq ?? 0;
      useGameStore.getState().setTournamentOpen(true);
      let st = useGameStore.getState();
      expect(st.view).toBe('dashboard');
      expect(st.tournamentOpen).toBe(true);
      expect(st.cardFocus?.card).toBe('tournament');
      expect(st.cardFocus!.seq).toBeGreaterThan(seq0);
      // 已展开时再次请求：仍发出新的滚动请求
      useGameStore.getState().setTournamentOpen(true);
      expect(useGameStore.getState().cardFocus!.seq).toBeGreaterThan(st.cardFocus!.seq);

      // 本方比赛结束：同一回合内保持玩家的选择（可查看名次与战绩）
      quickSimTournament(g);
      g.popups.length = 0;
      bump();
      expect(useGameStore.getState().tournamentOpen).toBe(true);

      // 进入新回合：按新回合重新判定（有比赛要打则展开，否则收起）
      g.pendingDecisions.length = 0;
      const key0 = tourRoundKeyOf(g);
      expect(advance(g).ok).toBe(true);
      expect(tourRoundKeyOf(g)).not.toBe(key0);
      bump();
      expect(useGameStore.getState().tournamentOpen).toBe(!!tourModalFocus(g)?.actionable);

      // 离开游戏界面：收起
      useGameStore.setState({ tournamentOpen: true });
      useGameStore.setState({ screen: 'menu' });
      expect(useGameStore.getState().tournamentOpen).toBe(false);
    } finally {
      useGameStore.setState({ game: prev.game, screen: prev.screen, view: prev.view, tiIntro: null, tournamentOpen: false, cardFocus: null });
    }
  });

  it('setTrainingOpen：回到总览、展开训练卡片并发出滚动请求；收起不切换页面', () => {
    const prev = useGameStore.getState();
    try {
      useGameStore.setState({ view: 'team', tab: 'squad', trainingOpen: false });
      useGameStore.getState().setTrainingOpen(true);
      let st = useGameStore.getState();
      expect(st.view).toBe('dashboard');
      expect(st.trainingOpen).toBe(true);
      expect(st.cardFocus?.card).toBe('training');
      useGameStore.getState().setView('market');
      useGameStore.getState().setTrainingOpen(false);
      st = useGameStore.getState();
      expect(st.trainingOpen).toBe(false);
      expect(st.view).toBe('transfer');
    } finally {
      useGameStore.setState({ view: prev.view, tab: prev.tab, trainingOpen: false, cardFocus: null });
    }
  });
});
