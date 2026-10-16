// 提示（toast）的同时显示上限与渐隐：界面上最多 TOAST_MAX_VISIBLE 条（操作提示 + 多人快讯合计），
// 新的一条出现时最早的一条提前渐隐（TOAST_FADE_MS 后移除）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMsg } from '../src/shared/protocol';
import { net } from '../src/store/net';
import { TOAST_FADE_MS, TOAST_MAX_VISIBLE, useGameStore } from '../src/store/gameStore';

const visible = () => useGameStore.getState().toasts.filter((t) => !t.leaving);
const visibleFeeds = () => useGameStore.getState().mp.feedToasts.filter((f) => !f.leaving);

/** 把一条服务器消息交给客户端的消息处理（与真实连接收到消息时相同） */
function receive(msg: ServerMsg): void {
  (net as unknown as { msgListeners: Set<(m: ServerMsg) => void> }).msgListeners.forEach((fn) => fn(msg));
}

describe('提示：同时最多显示 2 条，最早的提前渐隐', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGameStore.setState((s) => ({ mode: 'single', toasts: [], mp: { ...s.mp, feed: [], feedToasts: [] } }));
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    useGameStore.setState((s) => ({ mode: 'single', toasts: [], mp: { ...s.mp, feed: [], feedToasts: [] } }));
  });

  it('上限为 2 条', () => {
    expect(TOAST_MAX_VISIBLE).toBe(2);
  });

  it('连续出现 3 条：最早的一条立即开始渐隐，渐隐结束后移除', () => {
    const { toast } = useGameStore.getState();
    toast('第一条');
    toast('第二条');
    expect(visible().map((t) => t.text)).toEqual(['第一条', '第二条']);
    toast('第三条');
    expect(visible().map((t) => t.text)).toEqual(['第二条', '第三条']);
    expect(useGameStore.getState().toasts.find((t) => t.text === '第一条')?.leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(useGameStore.getState().toasts.map((t) => t.text)).toEqual(['第二条', '第三条']);
  });

  it('快速连点 6 次：任何时刻最多 2 条未渐隐，列表不会无限堆积', () => {
    const { toast } = useGameStore.getState();
    for (let i = 1; i <= 6; i++) {
      toast(`第 ${i} 条`);
      expect(visible().length).toBeLessThanOrEqual(TOAST_MAX_VISIBLE);
    }
    expect(visible().map((t) => t.text)).toEqual(['第 5 条', '第 6 条']);
    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(useGameStore.getState().toasts.length).toBe(2);
  });

  it('到时自动消失也是先渐隐再移除；点按关闭同样渐隐', () => {
    const { toast } = useGameStore.getState();
    toast('成功提示');
    vi.advanceTimersByTime(3500);
    expect(useGameStore.getState().toasts[0]?.leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(useGameStore.getState().toasts).toHaveLength(0);

    toast('点一下关掉');
    const id = useGameStore.getState().toasts[0].id;
    useGameStore.getState().dismissToast(id);
    expect(useGameStore.getState().toasts[0]?.leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(useGameStore.getState().toasts).toHaveLength(0);
  });

  it('点开全文留住的提示最后才让位', () => {
    const { toast, holdToast } = useGameStore.getState();
    toast('长提示');
    holdToast(useGameStore.getState().toasts[0].id);
    toast('第二条');
    toast('第三条');
    expect(visible().map((t) => t.text)).toEqual(['长提示', '第三条']);
  });

  it('多人：快讯与操作提示合计最多 2 条，最早出现的（快讯）先渐隐', () => {
    useGameStore.setState({ mode: 'multi', game: null });
    receive({ t: 'feed', items: [{ id: 'f1', at: '2026-10-16T00:00:00Z', title: '乙签下了某选手', actorName: '乙' }] });
    expect(visibleFeeds().map((f) => f.id)).toEqual(['f1']);
    const { toast } = useGameStore.getState();
    toast('我的操作 1');
    expect(visibleFeeds().length + visible().length).toBe(2);
    toast('我的操作 2');
    expect(visibleFeeds()).toHaveLength(0);
    expect(useGameStore.getState().mp.feedToasts.find((f) => f.id === 'f1')?.leaving).toBe(true);
    expect(visible().map((t) => t.text)).toEqual(['我的操作 1', '我的操作 2']);
    vi.advanceTimersByTime(TOAST_FADE_MS);
    expect(useGameStore.getState().mp.feedToasts).toHaveLength(0);
  });
});
