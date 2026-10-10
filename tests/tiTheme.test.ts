// 第八波 item 8：TI 主视觉主题数据（tis.json theme）与 TI 转场触发逻辑（src/ui/tiTheme.ts，纯函数）
import { describe, expect, it } from 'vitest';
import { getAllTiInfo } from '../src/data/index';
import type { GameState } from '../src/engine/types';
import {
  DEFAULT_TI_THEME, TI_SEEN_STORAGE_KEY, createTiSeenStore, isHexColor, resolveTiTheme, rgba, tiCityOf, tiEntryInfo,
  tiIntroCanShow, tiIntroCue, tiIntroKey, tiIntroKindOf, tiThemeOf, tiThemeProblems, type TiIntroView,
} from '../src/ui/tiTheme';
import { syncTiIntro, useGameStore } from '../src/store/gameStore';

describe('tis.json：每届 TI 都有合法主题', () => {
  const tis = getAllTiInfo();

  it('覆盖 TI1–TI16', () => {
    const ids = tis.map((t) => t.ti).sort((a, b) => a - b);
    for (let ti = 1; ti <= 16; ti++) expect(ids).toContain(ti);
  });

  for (const t of getAllTiInfo()) {
    it(`TI${t.ti}（${t.year}）主题合法`, () => {
      expect(tiThemeProblems(t.theme)).toEqual([]);
      const th = t.theme!;
      expect(th.name.trim().length).toBeGreaterThan(0);
      for (const c of [th.primary, th.secondary, th.accent]) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
      if (th.text !== undefined) expect(isHexColor(th.text)).toBe(true);
      // 主色与辅色不能相同（转场背景需要层次）
      expect(th.primary.toLowerCase()).not.toBe(th.secondary.toLowerCase());
    });
  }

  it('主题名互不重复', () => {
    const names = tis.map((t) => t.theme?.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('tiThemeOf 对每届返回数据中的主题；未知届次回退默认主题', () => {
    for (const t of tis) expect(tiThemeOf(t.ti).primary).toBe(t.theme!.primary);
    expect(tiThemeOf(999)).toEqual({ ...DEFAULT_TI_THEME, text: undefined });
  });
});

describe('主题工具', () => {
  it('tiThemeProblems 识别非法数据', () => {
    expect(tiThemeProblems(undefined)).toEqual(['缺少 theme']);
    expect(tiThemeProblems({ name: '', primary: 'red', secondary: '#123', accent: '#12345G' })).toHaveLength(4);
    expect(tiThemeProblems({ name: 'x', primary: '#000000', secondary: '#111111', accent: '#222222', text: 'white' })).toEqual(['text 不是 #RRGGBB']);
  });

  it('resolveTiTheme 逐字段回退', () => {
    const r = resolveTiTheme({ name: '测试', primary: '#ABCDEF', secondary: 'oops' } as never);
    expect(r).toEqual({ name: '测试', primary: '#ABCDEF', secondary: DEFAULT_TI_THEME.secondary, accent: DEFAULT_TI_THEME.accent, text: undefined });
    expect(resolveTiTheme(null).name).toBe(DEFAULT_TI_THEME.name);
  });

  it('rgba 转换与夹紧', () => {
    expect(rgba('#FF8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)');
    expect(rgba('#FF8000', 7)).toBe('rgba(255, 128, 0, 1)');
    expect(rgba('bad', 0.2)).toBe('rgba(194, 60, 42, 0.2)');
  });
});

// ---------------------------------------------------------------------------
// 触发逻辑
// ---------------------------------------------------------------------------
function view(over: Partial<TiIntroView> & { phase: TiIntroView['phase']; ti?: number; team?: string } ): TiIntroView {
  return {
    id: over.id ?? 'g-abc',
    createdAt: over.createdAt ?? '2026-10-09T00:00:00.000Z',
    phase: over.phase,
    season: { ti: over.ti ?? 9 } as GameState['season'],
    settings: { playerTeamId: over.team ?? 'my-team' } as GameState['settings'],
    gameOver: over.gameOver ?? null,
  };
}

/** 模拟 UI：每次状态变化调用一次，触发即记为已看过 */
function runner() {
  const seen = createTiSeenStore(null);
  const fired: string[] = [];
  const step = (v: TiIntroView) => {
    const cue = tiIntroCue(v, (k) => seen.has(k));
    if (cue) {
      seen.add(cue.key);
      fired.push(`${cue.kind}:${cue.ti}`);
    }
    return cue;
  };
  return { step, fired };
}

describe('TI 转场触发（纯函数）', () => {
  it('阶段 → 类型', () => {
    expect(tiIntroKindOf('ti')).toBe('main');
    expect(tiIntroKindOf('ti_qualifier')).toBe('qualifier');
    for (const p of ['preseason', 'regular', 'season_end', undefined, 42]) expect(tiIntroKindOf(p)).toBeNull();
  });

  it('非 TI 回合 / 游戏结束 / 无效届次不触发', () => {
    const never = () => false;
    expect(tiIntroCue(view({ phase: 'regular' }), never)).toBeNull();
    expect(tiIntroCue(view({ phase: 'preseason' }), never)).toBeNull();
    expect(tiIntroCue(view({ phase: 'ti', gameOver: { reason: 'disbanded', summary: '' } as GameState['gameOver'] }), never)).toBeNull();
    expect(tiIntroCue(view({ phase: 'ti', ti: 0 }), never)).toBeNull();
    expect(tiIntroCue(null, never)).toBeNull();
    expect(tiIntroCue(undefined, never)).toBeNull();
  });

  it('进入 TI 正赛回合只触发一次（重复渲染 / 回合内多次状态变化不再触发）', () => {
    const r = runner();
    r.step(view({ phase: 'regular' }));
    const q = r.step(view({ phase: 'ti_qualifier' }));
    expect(q?.kind).toBe('qualifier');
    const m = r.step(view({ phase: 'ti' }));
    expect(m).toMatchObject({ kind: 'main', ti: 9 });
    for (let i = 0; i < 5; i++) expect(r.step(view({ phase: 'ti' }))).toBeNull();
    expect(r.fired).toEqual(['qualifier:9', 'main:9']);
  });

  it('下一届 TI 再次触发；同一届读档重进不再触发', () => {
    const r = runner();
    r.step(view({ phase: 'ti', ti: 9 }));
    r.step(view({ phase: 'season_end', ti: 9 }));
    r.step(view({ phase: 'regular', ti: 10 }));
    r.step(view({ phase: 'ti', ti: 9 })); // 同一存档同一届：已看过
    r.step(view({ phase: 'ti', ti: 10 }));
    expect(r.fired).toEqual(['main:9', 'main:10']);
  });

  it('多人：每个座位各触发一次；不同存档（含同种子不同创建时间）互不影响', () => {
    const r = runner();
    for (const team of ['seat-a', 'seat-b', 'seat-c']) {
      expect(r.step(view({ phase: 'ti', team }))?.kind).toBe('main');
      expect(r.step(view({ phase: 'ti', team }))).toBeNull();
    }
    expect(r.step(view({ phase: 'ti', team: 'seat-a', createdAt: '2027-01-01T00:00:00.000Z' }))?.kind).toBe('main');
    expect(r.step(view({ phase: 'ti', team: 'seat-a', id: 'mp-xyz' }))?.kind).toBe('main');
    expect(r.fired).toHaveLength(5);
  });

  it('记录键包含存档、座位、届次与类型', () => {
    const v = view({ phase: 'ti', team: 'og', ti: 8 });
    const a = tiIntroKey(v, 8, 'main');
    expect(a).toContain('g-abc');
    expect(a).toContain('og');
    expect(a).not.toBe(tiIntroKey(v, 8, 'qualifier'));
    expect(a).not.toBe(tiIntroKey(v, 9, 'main'));
  });

  it('「已看过」持久化：新的页面会话（新 store）读取同一存储不再触发；存储损坏 / 抛错时退化为内存', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const v = view({ phase: 'ti' });
    const s1 = createTiSeenStore(storage);
    const cue = tiIntroCue(v, (k) => s1.has(k))!;
    expect(cue).not.toBeNull();
    s1.add(cue.key);
    const s2 = createTiSeenStore(storage);
    expect(tiIntroCue(v, (k) => s2.has(k))).toBeNull();

    mem.set(TI_SEEN_STORAGE_KEY, '{not json');
    const s3 = createTiSeenStore(storage);
    expect(s3.has(cue.key)).toBe(false);

    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const s4 = createTiSeenStore(broken);
    expect(s4.has('x')).toBe(false);
    s4.add('x');
    expect(s4.has('x')).toBe(true);
  });

  it('同一浏览器两个标签页（两个座位）同时写入：被覆盖的记录在下次写入时补回', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const tabA = createTiSeenStore(storage);
    const tabB = createTiSeenStore(storage);
    // 两个标签页几乎同时收到推进推送：B 先读到空记录，A 写入后 B 用旧数据覆盖
    const stale = mem.get(TI_SEEN_STORAGE_KEY) ?? null;
    tabA.add('a-q');
    mem.set(TI_SEEN_STORAGE_KEY, stale ?? '[]');
    tabB.add('b-q');
    expect(createTiSeenStore(storage).has('a-q')).toBe(false); // A 的记录被覆盖
    expect(tabA.has('a-q')).toBe(true); // 本页面会话内仍记得
    tabA.add('a-main');
    const fresh = createTiSeenStore(storage);
    for (const k of ['a-q', 'a-main', 'b-q']) expect(fresh.has(k)).toBe(true);
  });

  it('存储容量有上限（只保留最近的记录）', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = createTiSeenStore(storage, 3);
    for (const k of ['a', 'b', 'c', 'd']) s.add(k);
    expect(JSON.parse(mem.get(TI_SEEN_STORAGE_KEY)!)).toEqual(['b', 'c', 'd']);
    expect(createTiSeenStore(storage, 3).has('a')).toBe(false);
  });
});

describe('展示时机（tiIntroCanShow）', () => {
  it('页面在后台时不播放（回到页面再播放）', () => {
    expect(tiIntroCanShow('main', { visible: false, popupsPending: 0 })).toBe(false);
    expect(tiIntroCanShow('qualifier', { visible: false, popupsPending: 0 })).toBe(false);
  });

  it('正赛转场是最上层遮罩，不等弹窗；预选横幅等回合开始的弹窗关闭后再出现', () => {
    expect(tiIntroCanShow('main', { visible: true, popupsPending: 3 })).toBe(true);
    expect(tiIntroCanShow('qualifier', { visible: true, popupsPending: 1 })).toBe(false);
    expect(tiIntroCanShow('qualifier', { visible: true, popupsPending: 0 })).toBe(true);
    expect(tiIntroCanShow('qualifier', { visible: true, popupsPending: Number.NaN })).toBe(true);
  });
});

describe('参赛说明与城市', () => {
  const tour = (over: Record<string, unknown>) => ({ teamIds: [], invitedTeamIds: [], qualifierTeamIds: [], ...over });
  const game = (tours: Record<string, unknown>, me = 'me') =>
    ({ settings: { playerTeamId: me }, tournaments: tours }) as unknown as Pick<GameState, 'tournaments' | 'settings'>;

  it('预选回合：直邀 / 参加预选 / 无缘', () => {
    const tours = {
      'ti-9': tour({ invitedTeamIds: ['inv'], teamIds: ['inv'], city: '上海' }),
      'tiq-9-CN': tour({ name: 'TI9 中国区预选赛', teamIds: ['me'], advanceToTi: { tiId: 'ti-9', slots: 2 } }),
    };
    expect(tiEntryInfo(game(tours, 'inv'), 9, 'qualifier')).toEqual({ status: 'invited' });
    expect(tiEntryInfo(game(tours, 'me'), 9, 'qualifier')).toEqual({ status: 'qualifier', qualifierName: 'TI9 中国区预选赛', qualifierSlots: 2 });
    expect(tiEntryInfo(game(tours, 'other'), 9, 'qualifier')).toEqual({ status: 'out' });
  });

  it('正赛回合：入围 / 观赛；数据缺失返回 null', () => {
    const tours = { 'ti-9': tour({ teamIds: ['me'] }) };
    expect(tiEntryInfo(game(tours, 'me'), 9, 'main')).toEqual({ status: 'main' });
    expect(tiEntryInfo(game(tours, 'x'), 9, 'main')).toEqual({ status: 'out' });
    expect(tiEntryInfo(game({}, 'me'), 9, 'main')).toBeNull();
    expect(tiEntryInfo(game(tours, ''), 9, 'main')).toBeNull();
  });

  it('城市：tis.json 优先，待定时用赛事实例城市', () => {
    expect(tiCityOf(null, 9)).toBe('上海');
    expect(tiCityOf(null, 16)).toBe('');
    expect(tiCityOf({ tournaments: { 'ti-16': { city: '柏林' } } } as unknown as Pick<GameState, 'tournaments'>, 16)).toBe('柏林');
  });
});

describe('store：syncTiIntro 在游戏状态进入 TI 回合时设置一次', () => {
  it('单机流程：预选横幅 → 正赛转场 → 同一回合不再触发', () => {
    const base = {
      id: `g-test-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      phase: 'regular',
      season: { ti: 5 },
      settings: { playerTeamId: 'me' },
      gameOver: null,
      tournaments: {},
    } as unknown as GameState;
    const prev = useGameStore.getState();
    try {
      useGameStore.setState({ game: base, screen: 'game', tiIntro: null });
      expect(useGameStore.getState().tiIntro).toBeNull();

      base.phase = 'ti_qualifier';
      useGameStore.setState((s) => ({ version: s.version + 1 }));
      expect(useGameStore.getState().tiIntro).toMatchObject({ kind: 'qualifier', ti: 5 });
      useGameStore.getState().dismissTiIntro();

      base.phase = 'ti';
      useGameStore.setState((s) => ({ version: s.version + 1 }));
      expect(useGameStore.getState().tiIntro).toMatchObject({ kind: 'main', ti: 5 });
      useGameStore.getState().dismissTiIntro();

      useGameStore.setState((s) => ({ version: s.version + 1 }));
      syncTiIntro();
      expect(useGameStore.getState().tiIntro).toBeNull();

      // 退出到主菜单：清空
      base.phase = 'ti';
      useGameStore.setState({ tiIntro: { kind: 'main', ti: 5, key: 'k' } });
      useGameStore.setState({ game: null, screen: 'menu' });
      expect(useGameStore.getState().tiIntro).toBeNull();
    } finally {
      useGameStore.setState({ game: prev.game, screen: prev.screen, tiIntro: null });
    }
  });
});
