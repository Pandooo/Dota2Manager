// 信息架构（第五波「界面精简」）：旧页面键 → 中心页 + 标签 的路由映射，以及侧栏恢复上次标签
import { beforeEach, describe, expect, it } from 'vitest';
import { HUB_TABS, hubEntryTab, resolveView, tabBelongsTo, useGameStore, type HubKey, type HubTab, type ViewKey } from '../src/store/gameStore';

describe('resolveView：旧页面键映射', () => {
  const cases: [ViewKey, HubKey, HubTab | null][] = [
    ['squad', 'team', 'squad'],
    ['training', 'team', 'training'],
    ['coach', 'team', 'coach'],
    ['market', 'transfer', 'market'],
    ['draft', 'transfer', 'draft'],
    ['tournament', 'events', 'tournament'],
    ['schedule', 'events', 'schedule'],
    ['rankings', 'events', 'rankings'],
    ['patches', 'events', 'patches'],
    ['finance', 'club', 'finance'],
    ['club', 'club', 'honors'],
    ['dashboard', 'dashboard', null],
    ['inbox', 'inbox', null],
    ['match', 'match', null],
  ];
  for (const [key, view, tab] of cases) {
    it(`${key} → ${view}${tab ? `/${tab}` : ''}`, () => {
      expect(resolveView(key)).toEqual({ view, tab });
    });
  }

  it('中心页键：显式标签 > 上次标签 > 默认标签', () => {
    expect(resolveView('team')).toEqual({ view: 'team', tab: 'squad' });
    expect(resolveView('events', null, { events: 'rankings' })).toEqual({ view: 'events', tab: 'rankings' });
    expect(resolveView('events', 'patches', { events: 'rankings' })).toEqual({ view: 'events', tab: 'patches' });
    // 不属于该中心页的标签被忽略
    expect(resolveView('transfer', 'training', { transfer: 'schedule' as HubTab })).toEqual({ view: 'transfer', tab: 'market' });
    // 'club' 无显式标签时保持旧语义（荣誉史）
    expect(resolveView('club', null, { club: 'finance' })).toEqual({ view: 'club', tab: 'honors' });
    expect(resolveView('club', 'finance')).toEqual({ view: 'club', tab: 'finance' });
  });

  it('未知键回到总览', () => {
    expect(resolveView('nope' as ViewKey)).toEqual({ view: 'dashboard', tab: null });
  });

  it('每个标签恰好属于一个中心页', () => {
    const all = Object.entries(HUB_TABS).flatMap(([hub, tabs]) => (tabs ?? []).map((t) => [hub, t] as const));
    expect(new Set(all.map(([, t]) => t)).size).toBe(all.length);
    for (const [hub, t] of all) expect(tabBelongsTo(hub as HubKey, t)).toBe(true);
    expect(HUB_TABS.team).toEqual(['squad', 'training', 'coach']);
    expect(HUB_TABS.transfer).toEqual(['market', 'draft']);
    expect(HUB_TABS.events).toEqual(['tournament', 'schedule', 'rankings', 'patches']);
    expect(HUB_TABS.club).toEqual(['finance', 'honors']);
  });
});

describe('store：setView / openHub', () => {
  beforeEach(() => useGameStore.setState({ view: 'dashboard', tab: null, hubTabs: {} }));

  it('setView(旧键) 切到中心页 + 标签并记住', () => {
    useGameStore.getState().setView('draft');
    expect(useGameStore.getState()).toMatchObject({ view: 'transfer', tab: 'draft' });
    expect(useGameStore.getState().hubTabs.transfer).toBe('draft');
  });

  it('openHub 回到上次停留的标签，无记录时用默认标签', () => {
    const s = useGameStore.getState();
    s.openHub('team');
    expect(useGameStore.getState()).toMatchObject({ view: 'team', tab: 'squad' });
    s.setView('coach');
    s.setView('dashboard');
    expect(useGameStore.getState()).toMatchObject({ view: 'dashboard', tab: null });
    s.openHub('team');
    expect(useGameStore.getState()).toMatchObject({ view: 'team', tab: 'coach' });
    s.openHub('club');
    expect(useGameStore.getState()).toMatchObject({ view: 'club', tab: 'finance' });
    s.setView('club');
    s.openHub('inbox');
    s.openHub('club');
    expect(useGameStore.getState()).toMatchObject({ view: 'club', tab: 'honors' });
  });
});

describe('hubEntryTab：侧栏入口带「需处理」徽标时直达对应标签', () => {
  it('无提醒 → null（恢复上次标签）', () => {
    for (const hub of ['dashboard', 'team', 'transfer', 'events', 'club', 'inbox'] as HubKey[]) {
      expect(hubEntryTab(hub, {})).toBeNull();
    }
  });

  it('阵容问题 → 阵容；报价 → 转会市场；进行中的赛事 → 赛事中心；资金为负 → 财务', () => {
    expect(hubEntryTab('team', { lineupProblem: true }, { team: 'coach' })).toBe('squad');
    expect(hubEntryTab('transfer', { offers: 2 }, { transfer: 'draft' })).toBe('market');
    expect(hubEntryTab('events', { live: true }, { events: 'rankings' })).toBe('tournament');
    expect(hubEntryTab('club', { goldNegative: true }, { club: 'honors' })).toBe('finance');
    // 提醒属于别的中心页时不影响
    expect(hubEntryTab('team', { offers: 3, live: true, goldNegative: true })).toBeNull();
  });

  it('赛季初的赛事页默认打开赛程报名，但尊重上次主动选择的其他标签', () => {
    expect(hubEntryTab('events', { preseason: true })).toBe('schedule');
    expect(hubEntryTab('events', { preseason: true }, { events: 'tournament' })).toBe('schedule');
    expect(hubEntryTab('events', { preseason: true }, { events: 'rankings' })).toBeNull();
    expect(hubEntryTab('events', {}, { events: 'tournament' })).toBeNull();
  });

  it('返回的标签总是属于该中心页', () => {
    const ctx = { lineupProblem: true, offers: 1, live: true, preseason: true, goldNegative: true };
    for (const hub of ['team', 'transfer', 'events', 'club'] as HubKey[]) {
      const t = hubEntryTab(hub, ctx);
      expect(t && tabBelongsTo(hub, t)).toBe(true);
    }
  });
});
