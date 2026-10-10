import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/engine/team', async () => (await import('./engineMocks')).teamMock);
vi.mock('../src/engine/player', async () => (await import('./engineMocks')).playerMock);

import {
  DRAFT_SEQUENCE, aiDraftStep, applyDraftAction, createDraft, currentStep, draftHeroDate, draftLean, draftSuggestions,
  evaluateDraft, runDraftUntil,
} from '../src/engine/draft';
import { availableHeroes, generateHeroMeta, heroById, heroMetaValue } from '../src/engine/heroes';
import { patchByVersion } from '../src/engine/patches';
import { CONFIG } from '../src/engine/config';
import type { GameState, Position } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { makeTestState } from './helpers';
import { setTeamAttr } from './engineMocks';

/** 某位置适配度最高的可用英雄 */
function bestFor(state: GameState, pos: Position, exclude: string[] = []): string {
  const list = availableHeroes(state.currentDate).filter((h) => !exclude.includes(h.id));
  list.sort((a, b) => b.positions[pos] - a.positions[pos] || a.id.localeCompare(b.id));
  return list[0].id;
}

describe('draft: BP 顺序', () => {
  it('10 禁 10 选，每方各 5 禁 5 选，阶段顺序正确', () => {
    expect(DRAFT_SEQUENCE).toHaveLength(20);
    const count = (side: 'A' | 'B', type: 'ban' | 'pick') => DRAFT_SEQUENCE.filter((s) => s.side === side && s.type === type).length;
    expect(count('A', 'ban')).toBe(5);
    expect(count('B', 'ban')).toBe(5);
    expect(count('A', 'pick')).toBe(5);
    expect(count('B', 'pick')).toBe(5);
    const types = DRAFT_SEQUENCE.map((s) => (s.type === 'ban' ? 'b' : 'p')).join('');
    expect(types).toBe('bbbbppppbbbbppppbbpp');
    expect(DRAFT_SEQUENCE.slice(0, 4).map((s) => s.side).join('')).toBe('ABAB');
    expect(DRAFT_SEQUENCE.slice(4, 8).map((s) => s.side).join('')).toBe('ABBA');
  });

  it('createDraft / currentStep', () => {
    const s = makeTestState(2);
    const d = createDraft(s);
    expect(d.available.length).toBeGreaterThanOrEqual(20);
    expect(d.sequence).toHaveLength(20);
    expect(currentStep(d)).toEqual({ side: 'A', type: 'ban' });
    expect(d.done).toBe(false);
  });
});

describe('draft: 执行与校验', () => {
  it('全自动 BP：无重复英雄、每方 5 个位置各一、绑定首发选手', () => {
    const s = makeTestState(2, 99);
    const d = createDraft(s);
    const total = d.available.length;
    runDraftUntil(s, d, 't0', 't1', null);
    expect(d.done).toBe(true);
    expect(d.actions).toHaveLength(20);
    expect(currentStep(d)).toBeNull();
    const ids = d.actions.map((a) => a.heroId);
    expect(new Set(ids).size).toBe(20);
    expect(d.available).toHaveLength(total - 20);
    for (const id of ids) expect(d.available).not.toContain(id);
    d.actions.forEach((a, i) => {
      expect(a.side).toBe(DRAFT_SEQUENCE[i].side);
      expect(a.type).toBe(DRAFT_SEQUENCE[i].type);
    });
    for (const side of ['A', 'B'] as const) {
      const picks = d.actions.filter((a) => a.side === side && a.type === 'pick');
      expect(picks.map((p) => p.position).sort()).toEqual([...POSITIONS].sort());
      const team = side === 'A' ? 't0' : 't1';
      for (const p of picks) expect(p.playerId).toBe(s.teams[team].lineup[p.position as Position]);
    }
  });

  it('非法操作抛错', () => {
    const s = makeTestState(2);
    const d = createDraft(s);
    expect(() => applyDraftAction(s, d, 'definitely-not-a-hero', 't0', 't1')).toThrow();
    const h = d.available[0];
    applyDraftAction(s, d, h, 't0', 't1');
    expect(() => applyDraftAction(s, d, h, 't0', 't1')).toThrow(); // 已被禁
    runDraftUntil(s, d, 't0', 't1', null);
    expect(() => applyDraftAction(s, d, d.available[0], 't0', 't1')).toThrow();
    expect(() => aiDraftStep(s, d, 't0', 't1')).toThrow();
  });

  it('runDraftUntil 停在玩家回合', () => {
    const s = makeTestState(2);
    const d = createDraft(s);
    runDraftUntil(s, d, 't0', 't1', 'A');
    expect(d.actions).toHaveLength(0); // 第一步就是 A
    runDraftUntil(s, d, 't0', 't1', 'B');
    expect(d.actions).toHaveLength(1);
    expect(currentStep(d)?.side).toBe('B');
  });

  it('首发不足 5 人、战队不存在时不崩溃', () => {
    const s = makeTestState(2);
    s.teams.t0.lineup.SS = null;
    s.teams.t0.lineup.HS = null;
    const d = createDraft(s);
    runDraftUntil(s, d, 't0', 'ghost', null);
    expect(d.done).toBe(true);
    const ev = evaluateDraft(s, d, 't0', 'ghost');
    expect(ev.notes.length).toBeGreaterThanOrEqual(2);
    const ss = d.actions.find((a) => a.side === 'A' && a.position === 'SS');
    expect(ss?.playerId).toBeUndefined();
  });

  it('英雄池耗尽时提前结束而不是死循环', () => {
    const s = makeTestState(2);
    const d = createDraft(s);
    d.available = d.available.slice(0, 7);
    runDraftUntil(s, d, 't0', 't1', null);
    expect(d.done).toBe(true);
    expect(d.actions).toHaveLength(7);
  });
});

describe('draft: 推荐', () => {
  it('只推荐可用英雄，数量与分数合法', () => {
    const s = makeTestState(2);
    const d = createDraft(s);
    runDraftUntil(s, d, 't0', 't1', null);
    expect(draftSuggestions(s, d, 't0', 't1')).toEqual([]);

    const d2 = createDraft(s);
    for (let i = 0; i < 6; i++) aiDraftStep(s, d2, 't0', 't1'); // 进行到 B 选人
    const sug = draftSuggestions(s, d2, 't0', 't1', 8);
    expect(sug.length).toBe(8);
    const taken = new Set(d2.actions.map((a) => a.heroId));
    for (const x of sug) {
      expect(d2.available).toContain(x.heroId);
      expect(taken.has(x.heroId)).toBe(false);
      expect(x.score).toBeGreaterThanOrEqual(1);
      expect(x.score).toBeLessThanOrEqual(100);
      expect(x.reason.length).toBeGreaterThan(0);
      expect(x.position).toBeDefined();
    }
    expect(sug[0].score).toBe(100);
    // 稳定：同一 BP 进度重复调用结果一致，且不消耗存档随机数
    const rng0 = s.rngState;
    expect(draftSuggestions(s, d2, 't0', 't1', 8)).toEqual(sug);
    expect(s.rngState).toBe(rng0);
  });

  it('禁用推荐针对对手招牌英雄', () => {
    const s = makeTestState(2);
    s.heroMeta = {};
    setTeamAttr(s, 't0', 'insight', 100); // 无噪声
    const sig = bestFor(s, 'M');
    s.players['t1-M'].signatureHeroes = [sig];
    const d = createDraft(s);
    const sug = draftSuggestions(s, d, 't0', 't1', 5);
    expect(sug[0].heroId).toBe(sig);
    expect(sug[0].reason).toContain(s.players['t1-M'].handle);
    // 满灵性 AI 与推荐首位一致
    expect(aiDraftStep(s, d, 't0', 't1').heroId).toBe(sig);
  });

  it('选人推荐偏好本方招牌英雄并给出位置', () => {
    const s = makeTestState(2);
    s.heroMeta = {};
    setTeamAttr(s, 't0', 'insight', 100);
    const sig = bestFor(s, 'C');
    s.players['t0-C'].signatureHeroes = [sig];
    const d = createDraft(s);
    // 前 4 手禁用避开招牌英雄
    for (let i = 0; i < 4; i++) applyDraftAction(s, d, d.available.find((h) => h !== sig) as string, 't0', 't1');
    expect(currentStep(d)).toEqual({ side: 'A', type: 'pick' });
    const sug = draftSuggestions(s, d, 't0', 't1', 3);
    expect(sug[0].heroId).toBe(sig);
    expect(sug[0].position).toBe('C');
    expect(sug[0].playerId).toBe('t0-C');
    expect(sug[0].reason).toContain('招牌');
    const act = applyDraftAction(s, d, sig, 't0', 't1');
    expect(act.position).toBe('C');
    expect(act.playerId).toBe('t0-C');
  });

  it('低灵性推荐带噪声（排序与无噪声版本不同）', () => {
    let differs = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = makeTestState(2, seed);
      const d = createDraft(s);
      for (let i = 0; i < 4; i++) aiDraftStep(s, d, 't0', 't1');
      setTeamAttr(s, 't0', 'insight', 100);
      const clean = draftSuggestions(s, d, 't0', 't1', 5).map((x) => x.heroId);
      setTeamAttr(s, 't0', 'insight', 0);
      const noisy = draftSuggestions(s, d, 't0', 't1', 5).map((x) => x.heroId);
      if (clean.join() !== noisy.join()) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });
});

describe('draft: 阵容评估', () => {
  it('大老师胜率在范围内，点评 2~4 条', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = makeTestState(2, seed);
      const d = createDraft(s);
      runDraftUntil(s, d, 't0', 't1', null);
      const ev = evaluateDraft(s, d, 't0', 't1');
      expect(ev.dotaPlusWinRateA).toBeGreaterThanOrEqual(CONFIG.match.dotaPlusMin);
      expect(ev.dotaPlusWinRateA).toBeLessThanOrEqual(CONFIG.match.dotaPlusMax);
      expect(ev.notes.length).toBeGreaterThanOrEqual(2);
      expect(ev.notes.length).toBeLessThanOrEqual(4);
      expect(Number.isFinite(ev.scoreA) && Number.isFinite(ev.scoreB)).toBe(true);
    }
  });

  it('灵性与招牌英雄提升胜率', () => {
    const s = makeTestState(2, 5);
    const d = createDraft(s);
    runDraftUntil(s, d, 't0', 't1', null);
    const base = evaluateDraft(s, d, 't0', 't1');
    setTeamAttr(s, 't0', 'insight', 95);
    setTeamAttr(s, 't1', 'insight', 30);
    const smart = evaluateDraft(s, d, 't0', 't1');
    expect(smart.dotaPlusWinRateA).toBeGreaterThan(base.dotaPlusWinRateA);
    const pickC = d.actions.find((a) => a.side === 'A' && a.position === 'C');
    s.players['t0-C'].signatureHeroes = [pickC?.heroId as string];
    const comfy = evaluateDraft(s, d, 't0', 't1');
    expect(comfy.scoreA).toBeCloseTo(smart.scoreA + CONFIG.match.comfortBonus, 5);
    expect(comfy.notes.some((n) => n.includes(s.players['t0-C'].handle))).toBe(true);
  });

  it('BP 中途也可评估；节奏倾向在 [-1,1]', () => {
    const s = makeTestState(2);
    const d = createDraft(s);
    expect(evaluateDraft(s, d, 't0', 't1').dotaPlusWinRateA).toBeCloseTo(0.5, 2);
    runDraftUntil(s, d, 't0', 't1', null);
    const { leanA, leanB } = draftLean(d.actions);
    for (const v of [leanA, leanB]) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(heroById(d.actions[0].heroId)).toBeDefined();
  });
});

describe('draft: 英雄池日期与版本强度', () => {
  it('随版本上线的英雄在版本生效的回合即可选（回合开始日早于版本发布日）', () => {
    const s = makeTestState(2);
    s.currentPatch = '7.23';
    s.currentDate = '2019-11-20'; // 7.23（2019-11-26）所在回合的开始日
    expect(draftHeroDate(s)).toBe('2019-11-26');
    expect(createDraft(s).available).toContain('snapfire');
    s.currentPatch = 'no-such-patch';
    expect(draftHeroDate(s)).toBe('2019-11-20');
    expect(createDraft(s).available).not.toContain('snapfire');
  });

  it('为版本生效后才上线的英雄补齐强度（确定性、不改已有值、不消耗随机数；空表不补）', () => {
    const s = makeTestState(2);
    const p = patchByVersion('7.19');
    expect(p).toBeDefined();
    s.currentPatch = '7.19';
    s.currentDate = '2018-09-01';
    s.heroMeta = generateHeroMeta(p!, p!.date); // 7.19 生效时 grimstroke（2018-08-24）尚未上线
    expect(s.heroMeta.grimstroke).toBeUndefined();
    const before = { ...s.heroMeta };
    const rng0 = s.rngState;
    const d = createDraft(s);
    expect(d.available).toContain('grimstroke');
    expect(s.heroMeta.grimstroke).toBe(heroMetaValue(p, 'grimstroke'));
    for (const [id, v] of Object.entries(before)) expect(s.heroMeta[id]).toBe(v);
    expect(s.rngState).toBe(rng0);
    s.heroMeta = {};
    createDraft(s);
    expect(s.heroMeta).toEqual({});
  });

  it('2011 年初英雄不足时 BP 仍可完成，且不出现远未上线的英雄', () => {
    const s = makeTestState(2, 7);
    s.currentPatch = '';
    s.currentDate = '2011-03-01';
    const pool = availableHeroes('2011-03-01');
    expect(pool.length).toBeGreaterThanOrEqual(20);
    // 只补最早即将上线的少数几个，不会出现一年后才上线的英雄
    for (const h of pool) expect(h.releaseDate < '2011-06-01').toBe(true);
    for (const side of ['A', 'B'] as const) {
      const d = createDraft(s);
      runDraftUntil(s, d, 't0', 't1', side);
      for (let i = 0; i < 40 && !d.done; i++) {
        applyDraftAction(s, d, d.available[d.available.length - 1], 't0', 't1');
        runDraftUntil(s, d, 't0', 't1', side);
      }
      expect(d.done).toBe(true);
      expect(d.actions).toHaveLength(20);
      for (const a of d.actions) expect(pool.some((h) => h.id === a.heroId)).toBe(true);
    }
  });
});
