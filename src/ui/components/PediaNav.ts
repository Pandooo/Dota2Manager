// ============================================================================
// DotaPedia 词条导航（纯 UI 状态，不进存档）：每个标签记住选中的词条（null = 列表），并保留一条「返回」历史
// （可回到百科外的页面）；换局（game.id 变化）后自动清空。PediaKit.tsx 重新导出本文件的全部接口。
// ============================================================================
import { create } from 'zustand';
import type { GameState } from '../../engine/types';
import { useGameStore, type HubKey, type HubTab, type PediaTab } from '../../store/gameStore';

export type PediaKind = 'team' | 'player' | 'tournament' | 'hero';

export const PEDIA_KIND_TAB: Record<PediaKind, PediaTab> = {
  team: 'pediaTeams',
  player: 'pediaPlayers',
  tournament: 'pediaTours',
  hero: 'pediaHeroes',
};

const TAB_KIND: Partial<Record<HubTab, PediaKind>> = {
  pediaTeams: 'team',
  pediaPlayers: 'player',
  pediaTours: 'tournament',
  pediaHeroes: 'hero',
};

export const PEDIA_KIND_LABEL: Record<PediaKind, string> = { team: '战队', player: '选手', tournament: '赛事', hero: '英雄' };

type PediaSel = Record<PediaKind, string | null>;
const EMPTY_SEL: PediaSel = { team: null, player: null, tournament: null, hero: null };

interface PediaLoc {
  view: HubKey;
  tab: HubTab | null;
  kind: PediaKind | null;
  id: string | null;
}

interface PediaNavState {
  /** 选中状态所属的存档（换局后失效） */
  gameId: string | null;
  sel: PediaSel;
  /** 「返回」历史（最近的在末尾） */
  history: PediaLoc[];
}

export const usePediaNav = create<PediaNavState>(() => ({ gameId: null, sel: EMPTY_SEL, history: [] }));

const HISTORY_MAX = 40;

function scrollMainTop(): void {
  if (typeof document === 'undefined') return;
  // App 只在 view / tab 变化时回到顶部；同一标签内切换词条时由这里负责
  requestAnimationFrame(() => document.querySelector('main')?.scrollTo?.({ top: 0 }));
}

function hereLoc(): PediaLoc {
  const s = useGameStore.getState();
  const kind = s.view === 'pedia' && s.tab ? TAB_KIND[s.tab] ?? null : null;
  const nav = usePediaNav.getState();
  const sameGame = nav.gameId === (s.game?.id ?? null);
  return { view: s.view, tab: s.tab, kind, id: kind && sameGame ? nav.sel[kind] : null };
}

/**
 * 打开词条（id = null 打开该类的列表）：关闭选手 / 战队弹窗，切到百科对应标签。
 * opts.replace：不记入「返回」历史（同页内的选中切换，如英雄表）；opts.scroll = false：不回到页面顶部。
 */
export function openPedia(kind: PediaKind, id: string | null, opts: { replace?: boolean; scroll?: boolean } = {}): void {
  const s = useGameStore.getState();
  const nav = usePediaNav.getState();
  const gameId = s.game?.id ?? null;
  const fresh = nav.gameId !== gameId;
  const here = hereLoc();
  const same = here.view === 'pedia' && here.kind === kind && here.id === id;
  const base = fresh ? [] : nav.history;
  const history = same || opts.replace ? base : [...base, here].slice(-HISTORY_MAX);
  usePediaNav.setState({ gameId, sel: { ...(fresh ? EMPTY_SEL : nav.sel), [kind]: id }, history });
  if (s.selectedPlayerId) s.openPlayer(null);
  if (s.selectedTeamId) s.openTeam(null);
  s.setView(PEDIA_KIND_TAB[kind]);
  if (opts.scroll !== false) scrollMainTop();
}

/** 返回上一个位置（可能在百科外）；没有历史时回到当前类的列表 */
export function pediaBack(fallback?: PediaKind): void {
  const nav = usePediaNav.getState();
  const prev = nav.history[nav.history.length - 1];
  if (!prev) {
    if (fallback) usePediaNav.setState({ sel: { ...nav.sel, [fallback]: null } });
    scrollMainTop();
    return;
  }
  usePediaNav.setState({
    history: nav.history.slice(0, -1),
    sel: prev.kind ? { ...nav.sel, [prev.kind]: prev.id } : nav.sel,
  });
  useGameStore.getState().setView(prev.view, prev.tab ?? undefined);
  scrollMainTop();
}

/**
 * 再次点击 DotaPedia 当前标签（HubShell onReselect）：正在看词条时回到该类的列表（记入「返回」历史，可回到词条），
 * 已在列表 / 总览时回到页面顶部。返回是否切换了词条。
 */
export function pediaTabReselect(tab: HubTab): boolean {
  const kind = TAB_KIND[tab] ?? null;
  const nav = usePediaNav.getState();
  const gameId = useGameStore.getState().game?.id ?? null;
  if (kind && nav.gameId === gameId && nav.sel[kind]) {
    openPedia(kind, null);
    return true;
  }
  scrollMainTop();
  return false;
}

/** 当前存档下某类的选中词条（存档不一致时为 null） */
export function usePediaSel(kind: PediaKind, game: GameState): string | null {
  return usePediaNav((s) => (s.gameId === game.id ? s.sel[kind] : null));
}

/** 换局时清空选中与历史（PediaHub 渲染时调用） */
export function syncPediaGame(gameId: string): void {
  const nav = usePediaNav.getState();
  if (nav.gameId !== gameId) usePediaNav.setState({ gameId, sel: EMPTY_SEL, history: [] });
}

export function useCanGoBack(): boolean {
  return usePediaNav((s) => s.history.length > 0);
}
