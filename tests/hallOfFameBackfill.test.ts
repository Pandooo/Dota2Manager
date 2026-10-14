// 名人堂开局补录（2026-10-15 用户决策「补录」，src/engine/hallOfFame.ts）：开局届晚于 TI1 时，建名人堂即补录真实数据中在开局届之前
// 达到过 SS / SSR 的真实选手（ti = 首次达到的届次；出道等级 = 首届真实轨迹；巅峰只取开局届及之前的数据）；DotA1 时代传奇保持种子身份，
// 其中的真实选手同样只登记开局届及之前的巅峰；旧存档 / 旧房间按 backfillVersion 一次性补录（开局届之前的真实 SS / SSR + 当前在役的
// SS / SSR）并按现行口径重算真实成员的巅峰（去掉未来数据），幂等。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, HallOfFameMember, Player, Tier } from '../src/engine/types';
import { TIERS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { getTrajectories } from '../src/data/index';
import {
  HOF_BACKFILL_VERSION, backfillMembers, hallOfFameRows, hofMember, initialHallOfFame, inductHallOfFame, isSummonable, migrateHallOfFame,
  prototypeSteps, seedMembers, summonPrototypes,
} from '../src/engine/hallOfFame';
import { createNewGame } from '../src/engine/game';
import { exportSave, importSave, upgradeLoadedState } from '../src/engine/save';
import * as M from '../src/engine/multi';
import { makePlayer, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const ti = (t: Tier) => TIERS.indexOf(t);
const hof = (t: Tier) => t === 'SS' || t === 'SSR';
const maxOf = (tiers: Tier[]) => tiers.reduce<Tier>((m, t) => (ti(t) > ti(m) ? t : m), 'C');
/** 真实轨迹的逐届等级（按 TI 升序） */
const stepsOf = (id: string) => Object.entries(getTrajectories()[id] ?? {}).map(([k, v]) => [Number(k), v.tier as Tier] as const).sort((a, b) => a[0] - b[0]);

/** 独立实现的期望：真实数据中在 start 之前达到 SS / SSR 的选手（不含 DotA1 种子） */
function expectedBackfill(start: number): Map<string, { ti: number; debut: Tier; peak: Tier }> {
  const seeds = new Set(seedMembers().map((m) => m.id));
  const out = new Map<string, { ti: number; debut: Tier; peak: Tier }>();
  for (const id of Object.keys(getTrajectories())) {
    if (seeds.has(id)) continue;
    const steps = stepsOf(id);
    const first = steps.filter(([t]) => t < start).find(([, t]) => hof(t));
    if (!first) continue;
    // 巅峰：开局届及之前（开局届的等级就是开局阵容中的等级，不算剧透）
    const peak = maxOf(steps.filter(([t]) => t <= start).map(([, t]) => t));
    out.set(id, { ti: first[0], debut: steps[0][1], peak });
  }
  return out;
}

describe('名人堂 · 开局补录', () => {
  it('TI9 开局：补录的成员与真实数据逐人一致（首次达到 SS / SSR 的届次、出道等级、开局届及之前的巅峰），不含开局届之后的数据', () => {
    const want = expectedBackfill(9);
    const init = initialHallOfFame(9);
    expect(init.backfillVersion).toBe(HOF_BACKFILL_VERSION);
    const got = init.members.filter((m) => m.source === 'backfill');
    expect(got.map((m) => m.id).sort()).toEqual([...want.keys()].sort());
    expect(got.length).toBeGreaterThan(50);
    for (const m of got) {
      const w = want.get(m.id)!;
      expect({ id: m.id, ti: m.ti, debut: m.debutTier, peak: m.peakTier }).toEqual({ id: m.id, ti: w.ti, debut: w.debut, peak: w.peak });
      expect(m.ti).toBeLessThan(9);
      expect(m.src).toBe('real');
      expect(isSummonable(m)).toBe(true);
    }
    const by = (id: string) => init.members.find((m) => m.id === id);
    // 抽查：Miracle- TI5 SS 出道、TI6 起 SSR
    expect(by('miracle')).toMatchObject({ source: 'backfill', ti: 5, debutTier: 'SS', peakTier: 'SSR' });
    // SumaiL TI5 以 SSR 出道：成为 SSR 请神原型
    expect(by('sumail')).toMatchObject({ source: 'backfill', ti: 5, debutTier: 'SSR', peakTier: 'SSR' });
    expect(by('arteezy')).toMatchObject({ source: 'backfill', ti: 4, debutTier: 'S', peakTier: 'SSR' });
    expect(by('n0tail')).toMatchObject({ source: 'backfill', ti: 6, debutTier: 'S', peakTier: 'SS' });
    expect(by('topson')).toMatchObject({ source: 'backfill', ti: 8, debutTier: 'SS', peakTier: 'SS' });
    // 不剧透：Ame TI10 才到 SSR → 登记的巅峰为 SS；ana 开局届 TI9 为 SSR（开局阵容中即是 SSR）→ SSR
    expect(by('ame')).toMatchObject({ source: 'backfill', ti: 7, debutTier: 'S', peakTier: 'SS' });
    expect(by('ana')).toMatchObject({ source: 'backfill', ti: 7, debutTier: 'S', peakTier: 'SSR' });
    // 开局届及之后才达到 SS / SSR 的不补录
    for (const id of ['nisha', 'yatoro', '23savage', 'collapse', 'malr1ne']) expect(by(id), id).toBeUndefined();
    // DotA1 时代传奇保持种子身份（不重复）
    expect(by('dendi')).toMatchObject({ source: 'seed', era: 'dota1' });
    expect(by('puppey')).toMatchObject({ source: 'seed', era: 'dota1' });
    expect(new Set(init.members.map((m) => m.id)).size).toBe(init.members.length);
  });

  it('开局届越晚补录越多；TI1 开局没有补录（只有 DotA1 时代传奇）；补录成员按出道等级成为请神原型', () => {
    expect(backfillMembers(1)).toHaveLength(0);
    expect(initialHallOfFame(1).members).toHaveLength(seedMembers().length);
    const n5 = initialHallOfFame(5).members.length;
    const n9 = initialHallOfFame(9).members.length;
    const n13 = initialHallOfFame(13).members.length;
    expect(n5).toBeLessThan(n9);
    expect(n9).toBeLessThan(n13);
    // 每次调用返回新对象（修改不影响缓存）
    const a = backfillMembers(9);
    a[0].peakTier = 'C';
    expect(backfillMembers(9)[0].peakTier).not.toBe('C');
    // 请神原型（测试局 TI9 开局）
    const s = makeTestState(2);
    expect(summonPrototypes(s, 'SSR').map((m) => m.id)).toContain('sumail');
    expect(summonPrototypes(s, 'A').length).toBeGreaterThan(0);
    // 原型轨迹为完整真实生涯（与本局入选的真实选手相同）
    const ame = hofMember(s, 'ame')!;
    expect(prototypeSteps(ame).length).toBe(Object.keys(getTrajectories().ame).length);
  });

  it('DotA1 时代传奇中的真实选手：巅峰只取开局届及之前的真实数据（首届晚于开局届时取出道等级）', () => {
    const at = (start: number, id: string) => initialHallOfFame(start).members.find((m) => m.id === id)!;
    // TI1 开局：Ferrari_430 TI2 才到 SSR、KuroKy TI3 才到 SS → 登记 SS / S；TI2 / TI3 开局时才算上
    expect(at(1, 'ferrari430')).toMatchObject({ source: 'seed', era: 'dota1', peakTier: 'SS' });
    expect(at(2, 'ferrari430').peakTier).toBe('SSR');
    expect(at(1, 'kuroky').peakTier).toBe('S');
    expect(at(3, 'kuroky').peakTier).toBe('SS');
    // 首届真实轨迹是 TI2：取出道等级
    expect(at(1, 'loda').peakTier).toBe('SS');
    expect(at(1, 'dendi').peakTier).toBe('SSR');
    // 合成轨迹的伍声（2009）按登记数据
    expect(at(1, '2009').peakTier).toBe('SS');
    // 逐人独立计算
    for (const start of [1, 2, 5, 9]) {
      for (const m of initialHallOfFame(start).members.filter((x) => x.source === 'seed' && x.src === 'real')) {
        const steps = stepsOf(m.id);
        const cutoff = Math.max(start, steps[0][0]);
        expect(m.peakTier, `TI${start} ${m.id}`).toBe(maxOf(steps.filter(([t]) => t <= cutoff).map(([, t]) => t)));
        expect(m.debutTier, m.id).toBe(steps[0][1]);
      }
    }
  });

  it('真实成员（含 DotA1 传奇中的真实选手）在役时，赛季结算按本局等级更新巅峰；合成轨迹的传奇不变', () => {
    const s = makeTestState(2);
    s.settings.startTi = 1;
    s.hallOfFame = initialHallOfFame(1);
    const ferrari: Player = makePlayer({ id: 'ferrari430', handle: 'Ferrari_430', isReal: true, mmr: CONFIG.ladder.thresholds.SSR + 200 });
    s.players[ferrari.id] = ferrari;
    expect(hofMember(s, 'ferrari430')!.peakTier).toBe('SS');
    inductHallOfFame(s, 2, { news: false });
    expect(hofMember(s, 'ferrari430')).toMatchObject({ source: 'seed', peakTier: 'SSR' });
    expect(hofMember(s, '2009')!.peakTier).toBe('SS');
  });

  it('新游戏：名人堂在开局即含补录成员（TI13 起）；同一开局届结果确定', async () => {
    const opts = {
      startTi: 13, seasons: 1, difficulty: 'normal' as const, managerName: '补录', seed: 4,
      newClub: { name: 'Hall Club', tag: 'HAL', region: 'CN' as const, color: '#2a7bc2' },
    };
    const a = await createNewGame(opts);
    const ids = (g: GameState) => (g.hallOfFame?.members ?? []).filter((m) => m.source === 'backfill').map((m) => m.id).sort();
    expect(a.hallOfFame!.backfillVersion).toBe(HOF_BACKFILL_VERSION);
    expect(ids(a)).toEqual([...expectedBackfill(13).keys()].sort());
    const b = await createNewGame(opts);
    expect(ids(b)).toEqual(ids(a));
    expect(a.rngState).toBe(b.rngState);
  });
});

describe('名人堂 · 开局补录的迁移', () => {
  /** v0.3 开发版存档：有名人堂但没有补录（只有 DotA1 传奇 + 本局入选） */
  function oldSave(): GameState {
    const s = makeTestState(4);
    s.hallOfFame = { members: seedMembers() };
    return s;
  }

  it('旧存档（有名人堂、无补录）：读档补录开局届之前的真实 SS / SSR 与当前在役的 SS / SSR；已入选的不重复、不覆盖；幂等', () => {
    const s = oldSave();
    // 本局已入选的成员：一名在补录名单中的真实选手（Miracle- 在 TI9 赛季结算入选）与一名虚构选手
    const inducted: HallOfFameMember = {
      id: 'miracle', handle: 'Miracle-', source: 'inducted', ti: 9, debutTier: 'SS', peakTier: 'SSR', position: 'M', nationality: 'JO',
      birthYear: 1997, src: 'real',
    };
    s.hallOfFame!.members.push(inducted);
    // 当前在役的 SS（赛季结算规则本应收录）
    s.players['t1-C'].mmr = CONFIG.ladder.thresholds.SS + 300;
    s.season.ti = 11;
    const news = s.news.length;
    upgradeLoadedState(s);
    const h = s.hallOfFame!;
    expect(h.backfillVersion).toBe(HOF_BACKFILL_VERSION);
    expect(h.backfilledTi).toBe(11);
    const want = expectedBackfill(9); // 开局届 = settings.startTi（9），不是当前赛季
    want.delete('miracle');
    expect(h.members.filter((m) => m.source === 'backfill').map((m) => m.id).sort()).toEqual([...want.keys()].sort());
    expect(hofMember(s, 'miracle')).toEqual(inducted);
    expect(hofMember(s, 't1-C')).toMatchObject({ source: 'inducted', ti: 11 });
    expect(new Set(h.members.map((m) => m.id)).size).toBe(h.members.length);
    expect(s.news.length).toBe(news);
    // 幂等
    const snap = JSON.stringify(h);
    expect(migrateHallOfFame(s)).toBe(false);
    upgradeLoadedState(s);
    expect(JSON.stringify(s.hallOfFame)).toBe(snap);
    // JSON 往返
    expect(importSave(exportSave(s)).hallOfFame).toEqual(s.hallOfFame);
  });

  it('旧存档补录不追加本局记录成员的赛季点（留给赛季结算）', () => {
    const s = oldSave();
    s.players['t2-M'].mmr = CONFIG.ladder.thresholds.SSR + 100;
    inductHallOfFame(s, 9, { news: false });
    const before = JSON.stringify(hofMember(s, 't2-M'));
    s.season.ti = 10;
    delete s.hallOfFame!.backfillVersion;
    expect(migrateHallOfFame(s)).toBe(true);
    expect(JSON.stringify(hofMember(s, 't2-M'))).toBe(before);
  });

  it('多人旧房间：migrateRoomState 补录一次（幂等），中性上下文', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build', seed: 3,
      players: [{ sessionId: 's', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } }],
    });
    expect(M.migrateRoomState(g)).toBe(false);
    const full = g.hallOfFame!.members.filter((m) => m.source === 'backfill').length;
    expect(full).toBe(expectedBackfill(9).size);
    // 模拟补录之前的房间
    g.hallOfFame!.members = g.hallOfFame!.members.filter((m) => m.source !== 'backfill');
    delete g.hallOfFame!.backfillVersion;
    expect(M.migrateRoomState(g)).toBe(true);
    expect(g.hallOfFame!.members.filter((m) => m.source === 'backfill')).toHaveLength(full);
    expect(M.migrateRoomState(g)).toBe(false);
    expect(g.multiplayer!.activeSeat).toBeNull();
  });

  it('版本 1 的存档（v0.3 开发版）：真实成员的巅峰按现行口径重算——去掉未来数据、补上开局届与本局等级；不重复补录；幂等', () => {
    const s = makeTestState(4);
    const h = s.hallOfFame!;
    const member = (id: string, at: number, peakTier: Tier): HallOfFameMember => ({
      id, handle: id, source: 'inducted', ti: at, debutTier: 'S', peakTier, position: 'M', nationality: 'EU', birthYear: 2000, src: 'real',
    });
    // 旧口径按整个真实生涯登记：nisha（TI9 入选，真实 TI13 才到 SSR）、collapse（TI10 入选，真实 TI15 才到 SSR，但本局当前就是 SSR）
    h.members.push(member('nisha', 9, 'SSR'), member('collapse', 10, 'SSR'));
    s.players.collapse = makePlayer({ id: 'collapse', handle: 'Collapse', isReal: true, mmr: CONFIG.ladder.thresholds.SSR + 100 });
    // 旧口径的补录成员不含开局届：ana 登记 SS（开局届 TI9 为 SSR）
    hofMember(s, 'ana')!.peakTier = 'SS';
    // 赛季中途新晋 SS 的选手：版本 1 已补录过，迁移不再提前收录（留给赛季结算）
    s.players['t1-C'].mmr = CONFIG.ladder.thresholds.SS + 300;
    h.backfillVersion = 1;
    const backfilled = h.members.filter((m) => m.source === 'backfill').map((m) => m.id);
    const count = h.members.length;
    const seeds = JSON.stringify(h.members.filter((m) => m.source === 'seed'));
    s.season.ti = 11;
    upgradeLoadedState(s);
    expect(h.backfillVersion).toBe(HOF_BACKFILL_VERSION);
    expect(hofMember(s, 'nisha')!.peakTier).toBe('SS');
    expect(hofMember(s, 'collapse')!.peakTier).toBe('SSR');
    expect(hofMember(s, 'ana')!.peakTier).toBe('SSR');
    // 版本 1 已补录：不重复补录、不改补录届次；TI9 开局时 DotA1 传奇的登记不变
    expect(h.backfilledTi).toBeUndefined();
    expect(h.members.filter((m) => m.source === 'backfill').map((m) => m.id)).toEqual(backfilled);
    expect(JSON.stringify(h.members.filter((m) => m.source === 'seed'))).toBe(seeds);
    expect(new Set(h.members.map((m) => m.id)).size).toBe(h.members.length);
    expect(hofMember(s, 't1-C')).toBeNull();
    expect(h.members).toHaveLength(count);
    // 幂等
    const snap = JSON.stringify(h);
    expect(migrateHallOfFame(s)).toBe(false);
    upgradeLoadedState(s);
    expect(JSON.stringify(s.hallOfFame)).toBe(snap);
  });

  it('TI1 开局的旧存档：DotA1 传奇中的真实选手按整个真实生涯登记的巅峰改为开局届及之前（本局等级更高时保留）', () => {
    const s = makeTestState(2);
    s.settings.startTi = 1;
    s.hallOfFame = { members: seedMembers(), backfillVersion: 1 };
    expect(hofMember(s, 'ferrari430')!.peakTier).toBe('SSR');
    expect(hofMember(s, 'kuroky')!.peakTier).toBe('SS');
    // 本局 KuroKy 当前为 SS：保留 SS
    s.players.kuroky = makePlayer({ id: 'kuroky', handle: 'KuroKy', isReal: true, mmr: CONFIG.ladder.thresholds.SS + 100 });
    expect(migrateHallOfFame(s)).toBe(true);
    expect(hofMember(s, 'ferrari430')!.peakTier).toBe('SS');
    expect(hofMember(s, 'kuroky')!.peakTier).toBe('SS');
    expect(hofMember(s, 'fear')!.peakTier).toBe('S');
    expect(s.hallOfFame!.members.filter((m) => m.source === 'backfill')).toHaveLength(0);
    expect(s.hallOfFame!.members).toEqual(initialHallOfFame(1).members.map((m) => (m.id === 'kuroky' ? { ...m, peakTier: 'SS' } : m)));
  });

  it('DotaPedia 名人堂列表：来源（DotA1 时代 / 真实数据补录 / 本局入堂）', () => {
    const s = makeTestState(4);
    s.players['t1-C'].mmr = CONFIG.ladder.thresholds.SS + 300;
    inductHallOfFame(s, 9, { news: false });
    const rows = hallOfFameRows(s);
    const kinds = [...new Set(rows.map((r) => r.source))];
    expect(kinds).toEqual(['seed', 'backfill', 'inducted']);
    const ame = rows.find((r) => r.id === 'ame')!;
    expect(ame).toMatchObject({ source: 'backfill', era: null, ti: 7, summonable: true });
  });
});
