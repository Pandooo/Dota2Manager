import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_VERSION } from '../src/engine/config';
import { deleteSave, exportSave, importSave, listSaves, loadGame, saveGame } from '../src/engine/save';
import { makeTestState } from './helpers';

/** 内存版 localStorage；quotaKeyPrefix 命中时 setItem 抛出配额错误 */
class MemStorage {
  private map = new Map<string, string>();
  quotaKeyPrefix: string | null = null;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.quotaKeyPrefix && k.startsWith(this.quotaKeyPrefix)) {
      throw new DOMException('quota', 'QuotaExceededError');
    }
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('save: localStorage 存档', () => {
  it('保存 → 列表 → 读取 往返一致', () => {
    const ls = new MemStorage();
    vi.stubGlobal('localStorage', ls);
    const state = makeTestState(4);
    state.roundIndex = 3;
    expect(saveGame(state, '1')).toBe(true);
    expect(saveGame(state, 'auto')).toBe(true);

    const saves = listSaves();
    expect(saves.map((s) => s.slot).sort()).toEqual(['1', 'auto']);
    const meta = saves.find((s) => s.slot === '1')!;
    expect(meta.teamName).toBe('Team t0');
    expect(meta.ti).toBe(9);
    expect(meta.round).toBe(3);
    expect(meta.honor).toBe(300);
    expect(typeof meta.savedAt).toBe('string');

    const loaded = loadGame('1');
    expect(loaded).toEqual(state);
    expect(loadGame('missing')).toBeNull();
  });

  it('超出配额返回 false，且旧存档保持不变', () => {
    const ls = new MemStorage();
    vi.stubGlobal('localStorage', ls);
    const state = makeTestState(2);
    expect(saveGame(state, '2')).toBe(true);
    ls.quotaKeyPrefix = 'd2m:save:';
    state.roundIndex = 7;
    expect(saveGame(state, '2')).toBe(false);
    expect(loadGame('2')!.roundIndex).toBe(0);
  });

  it('删除存档', () => {
    const ls = new MemStorage();
    vi.stubGlobal('localStorage', ls);
    const state = makeTestState(2);
    saveGame(state, '3');
    deleteSave('3');
    expect(loadGame('3')).toBeNull();
    expect(listSaves()).toEqual([]);
  });

  it('损坏的元数据/存档被安全跳过', () => {
    const ls = new MemStorage();
    vi.stubGlobal('localStorage', ls);
    ls.setItem('d2m:meta:x', '{oops');
    ls.setItem('d2m:save:x', '{oops');
    ls.setItem('other:key', '1');
    expect(listSaves()).toEqual([]);
    expect(loadGame('x')).toBeNull();
  });

  it('无 localStorage 环境安全降级', () => {
    vi.stubGlobal('localStorage', undefined);
    const state = makeTestState(2);
    expect(listSaves()).toEqual([]);
    expect(saveGame(state, '1')).toBe(false);
    expect(loadGame('1')).toBeNull();
    expect(() => deleteSave('1')).not.toThrow();
  });
});

describe('save: 导入导出', () => {
  it('导出 → 导入 往返一致', () => {
    const state = makeTestState(3);
    state.news.push({ id: 'n1', season: 9, round: 0, date: '2018-09-01', category: 'system', title: '标题', body: '正文' });
    const json = exportSave(state);
    expect(importSave(json)).toEqual(state);
  });

  it('旧存档缺失的可选集合会被补齐', () => {
    const state = makeTestState(2) as unknown as Record<string, unknown>;
    delete state.news;
    delete state.popups;
    delete state.history;
    const s = importSave(JSON.stringify(state));
    expect(s.news).toEqual([]);
    expect(s.popups).toEqual([]);
    expect(s.history.seasons).toEqual([]);
  });

  it('非法存档抛出中文错误', () => {
    expect(() => importSave('not json')).toThrow('不是有效的 JSON');
    expect(() => importSave('[]')).toThrow('不是对象');
    expect(() => importSave('{}')).toThrow('缺少必要字段');
    const state = makeTestState(2);
    expect(() => importSave(JSON.stringify({ ...state, version: SAVE_VERSION + 1 }))).toThrow('高于当前游戏版本');
    expect(() => importSave(JSON.stringify({ ...state, version: 'x' }))).toThrow('版本号无效');
    expect(() => importSave(JSON.stringify({ ...state, settings: { ...state.settings, playerTeamId: 'ghost' } }))).toThrow('找不到玩家战队');
  });
});
