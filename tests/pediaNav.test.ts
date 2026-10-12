// DotaPedia 导航（纯 UI 状态）：中心页 / 标签路由、词条选中与「返回」历史、换局清空
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from '../src/engine/types';
import { HUB_TABS, resolveView, tabBelongsTo, useGameStore } from '../src/store/gameStore';
import { PEDIA_KIND_TAB, openPedia, pediaBack, pediaTabReselect, syncPediaGame, usePediaNav } from '../src/ui/components/PediaNav';

const fakeGame = (id: string) => ({ id }) as unknown as GameState;

describe('DotaPedia 路由', () => {
  it('pedia 中心页的标签与默认标签', () => {
    expect(HUB_TABS.pedia).toEqual(['pediaHome', 'pediaTeams', 'pediaPlayers', 'pediaTours', 'pediaHeroes', 'pediaSynergies']);
    expect(resolveView('pedia')).toEqual({ view: 'pedia', tab: 'pediaHome' });
    expect(resolveView('pediaPlayers')).toEqual({ view: 'pedia', tab: 'pediaPlayers' });
    expect(resolveView('pedia', null, { pedia: 'pediaHeroes' })).toEqual({ view: 'pedia', tab: 'pediaHeroes' });
    for (const tab of Object.values(PEDIA_KIND_TAB)) expect(tabBelongsTo('pedia', tab)).toBe(true);
  });
});

describe('DotaPedia 词条导航', () => {
  beforeEach(() => {
    useGameStore.setState({
      game: fakeGame('g1'), view: 'dashboard', tab: null, hubTabs: {}, selectedPlayerId: null, selectedTeamId: null,
    });
    usePediaNav.setState({ gameId: null, sel: { team: null, player: null, tournament: null, hero: null }, history: [] });
  });

  it('从其他页面（含弹窗）打开词条：切到对应标签、关闭弹窗、记下来源', () => {
    useGameStore.setState({ selectedTeamId: 'og' });
    openPedia('team', 'og');
    expect(useGameStore.getState()).toMatchObject({ view: 'pedia', tab: 'pediaTeams', selectedTeamId: null });
    expect(usePediaNav.getState().sel.team).toBe('og');
    expect(usePediaNav.getState().history).toEqual([{ view: 'dashboard', tab: null, kind: null, id: null }]);
  });

  it('词条间跳转可逐级返回，最后回到百科外的来源页面', () => {
    openPedia('team', 'og');
    openPedia('player', 'topson');
    expect(useGameStore.getState().tab).toBe('pediaPlayers');
    pediaBack('player');
    expect(useGameStore.getState().tab).toBe('pediaTeams');
    expect(usePediaNav.getState().sel.team).toBe('og');
    pediaBack('team');
    expect(useGameStore.getState()).toMatchObject({ view: 'dashboard', tab: null });
    // 没有历史时返回 = 回到该类列表
    useGameStore.getState().setView('pediaTeams');
    pediaBack('team');
    expect(usePediaNav.getState().sel.team).toBeNull();
  });

  it('同一词条重复打开 / replace 不记入历史', () => {
    openPedia('hero', 'invoker');
    const n = usePediaNav.getState().history.length;
    openPedia('hero', 'invoker');
    openPedia('hero', 'pudge', { replace: true });
    expect(usePediaNav.getState().history.length).toBe(n);
    expect(usePediaNav.getState().sel.hero).toBe('pudge');
  });

  it('再次点击当前标签：词条 → 列表（可返回词条）；列表 / 总览不变', () => {
    openPedia('team', 'og');
    expect(pediaTabReselect('pediaTeams')).toBe(true);
    expect(usePediaNav.getState().sel.team).toBeNull();
    expect(useGameStore.getState().tab).toBe('pediaTeams');
    pediaBack('team');
    expect(usePediaNav.getState().sel.team).toBe('og');
    // 已在列表 / 总览：不改变选中，也不记历史
    openPedia('player', null);
    const n = usePediaNav.getState().history.length;
    expect(pediaTabReselect('pediaPlayers')).toBe(false);
    expect(pediaTabReselect('pediaHome')).toBe(false);
    expect(usePediaNav.getState().history.length).toBe(n);
    // 上一局残留的选中不算
    usePediaNav.setState({ gameId: 'old', sel: { team: 'x', player: null, tournament: null, hero: null } });
    expect(pediaTabReselect('pediaTeams')).toBe(false);
  });

  it('换局后清空选中与历史', () => {
    openPedia('team', 'og');
    syncPediaGame('g1');
    expect(usePediaNav.getState().sel.team).toBe('og');
    syncPediaGame('g2');
    expect(usePediaNav.getState()).toMatchObject({ gameId: 'g2', history: [] });
    expect(usePediaNav.getState().sel.team).toBeNull();
    // 另一局中打开词条时不沿用上一局的历史
    usePediaNav.setState({ gameId: 'old', history: [{ view: 'pedia', tab: 'pediaTeams', kind: 'team', id: 'x' }] });
    openPedia('player', 'p1');
    expect(usePediaNav.getState().gameId).toBe('g1');
    expect(usePediaNav.getState().history).toEqual([{ view: 'pedia', tab: 'pediaTeams', kind: 'team', id: null }]);
  });
});
