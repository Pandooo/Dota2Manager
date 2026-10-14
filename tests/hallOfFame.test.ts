// 名人堂（src/engine/hallOfFame.ts，2026-10-14 抽卡回归）：初始成员（DotA1 时代传奇，src/data/hallOfFame.json）、
// 赛季结算时 SS / SSR 入选（真实选手 / 本局记录 / 请神新秀三种轨迹来源）、旧存档 / 多人房间迁移、DotaPedia 视图。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Tier } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { getHallOfFameSeeds, getPlayerIndex, getTrajectory } from '../src/data/index';
import {
  HOF_BACKFILL_VERSION, backfillMembers, hallOfFameRows, hofMember, inductHallOfFame, isSummonable, livingSummonsOf, migrateHallOfFame,
  prototypeDebut, prototypeSteps, seedMembers, summonPrototypes,
} from '../src/engine/hallOfFame';
import { createSummonRookie, startGachaSeason } from '../src/engine/gacha';
import { exportSave, importSave, upgradeLoadedState } from '../src/engine/save';
import { playerFromSeed } from '../src/engine/generation';
import { tierOf } from '../src/engine/player';
import { pediaPlayerPage } from '../src/engine/pedia';
import * as M from '../src/engine/multi';
import { makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const thresholds = CONFIG.ladder.thresholds;

describe('名人堂 · 初始成员', () => {
  it('DotA1 时代传奇：真实阵容中的选手以真实生涯为原型（出道等级 = 首届 TI 的等级），2009 为合成轨迹', () => {
    const seeds = getHallOfFameSeeds();
    const members = seedMembers();
    expect(members).toHaveLength(seeds.length);
    expect(members.length).toBe(35);
    expect(new Set(members.map((m) => m.id)).size).toBe(members.length);
    for (const m of members) {
      expect(m.source).toBe('seed');
      expect(m.era).toBe('dota1');
      expect(m.ti).toBe(0);
      expect(isSummonable(m)).toBe(true);
      if (m.src === 'real') {
        const traj = getTrajectory(m.id)!;
        const first = Math.min(...Object.keys(traj).map(Number));
        expect(m.debutTier, m.id).toBe(traj[first].tier);
        expect(prototypeSteps(m)[0]).toEqual({ off: 0, mmr: traj[first].mmr, power: traj[first].power });
      }
    }
    const wu = members.find((m) => m.id === '2009')!;
    expect(wu).toMatchObject({ src: 'seed', debutTier: 'SS', peakTier: 'SS', position: 'C', nationality: 'CN', birthYear: 1987 });
    expect(getPlayerIndex().some((e) => e.id === '2009')).toBe(false);
    // 合成轨迹：出道 82 → 第 3 年 88 → 第 6 年起衰退；天梯始终在合理区间
    const steps = prototypeSteps(wu);
    expect(steps.map((x) => x.power).slice(0, 7)).toEqual([82, 85, 88, 88, 88, 86, 84]);
    for (const x of steps) expect(x.mmr).toBeGreaterThanOrEqual(thresholds.S);
    expect(tierOf(steps[0].mmr)).toBe('SS');
    expect(prototypeDebut(wu)).toMatchObject({ power: 82, talent: 60, insight: 72, position: 'C', heroes: ['anti-mage', 'weaver', 'phantom-lancer'] });
    // 请神原型按出道等级匹配（测试局 TI9 开局：DotA1 时代传奇 + 开局补录）
    const s = makeTestState(2);
    const all = s.hallOfFame!.members;
    expect(summonPrototypes(s, 'SSR').map((m) => m.id).sort()).toEqual(all.filter((m) => m.debutTier === 'SSR').map((m) => m.id).sort());
    expect(summonPrototypes(s, 'SSR').map((m) => m.id)).toEqual(expect.arrayContaining(members.filter((m) => m.debutTier === 'SSR').map((m) => m.id)));
    expect(summonPrototypes(s, 'C')).toHaveLength(0);
  });
});

/** 把选手的天梯设到某等级区间内 */
function setTier(s: GameState, id: string, t: Tier): void {
  s.players[id].mmr = thresholds[t] + 200;
}

describe('名人堂 · 赛季结算入选', () => {
  it('当时为 SS / SSR 的在役选手全部入选（只入选一次）；本局记录的生涯随赛季延长；新闻一条', () => {
    const s = makeTestState(4);
    setTier(s, 't1-C', 'SS');
    setTier(s, 't2-M', 'SSR');
    s.players['t3-O'].status = 'retired';
    setTier(s, 't3-O', 'SSR'); // 已退役：不入选
    const before = s.hallOfFame!.members.length;
    const fresh = inductHallOfFame(s, 9);
    expect(fresh.map((m) => m.id).sort()).toEqual(['t1-C', 't2-M']);
    expect(s.hallOfFame!.members).toHaveLength(before + 2);
    const m = hofMember(s, 't2-M')!;
    expect(m).toMatchObject({ source: 'inducted', ti: 9, src: 'game', debutTier: 'SSR', peakTier: 'SSR' });
    expect(m.traj).toEqual([[9, s.players['t2-M'].mmr, s.players['t2-M'].power]]);
    expect(s.news.filter((n) => n.title.includes('【名人堂】'))).toHaveLength(1);
    // 再次结算：不重复入选；仍在役的本局记录成员追加本届
    s.players['t2-M'].power = 90;
    expect(inductHallOfFame(s, 10)).toHaveLength(0);
    expect(hofMember(s, 't2-M')!.traj).toEqual([[9, s.players['t2-M'].mmr, m.traj![0][2]], [10, s.players['t2-M'].mmr, 90]]);
    expect(s.hallOfFame!.members).toHaveLength(before + 2);
  });

  it('三种轨迹来源：真实选手 = 真实生涯；抽卡出身的虚构选手 = 出道点 + 本局记录；请神新秀只作记录、不再作为原型', () => {
    const s = makeTestState(4);
    // 真实选手（Nisha：TI8 S、TI9 起 SS、TI13 SSR；TI9 开局之前没有达到 SS，不在开局补录中）
    const e = getPlayerIndex().find((x) => x.id === 'nisha')!;
    const traj = getTrajectory('nisha')!;
    const first = Math.min(...Object.keys(traj).map(Number));
    expect(hofMember(s, 'nisha')).toBeNull();
    const nisha = playerFromSeed(s, {
      id: 'nisha', handle: e.handle, nationality: e.nationality, birthYear: e.birthYear, position: e.position,
      mmr: thresholds.SS + 500, power: 88, talent: 90, resilience: 60, insight: 80, loyalty: 70, signatureHeroes: e.signatureHeroes,
    }, 't1');
    expect(nisha.isReal).toBe(true);
    // 抽卡出身的虚构选手：TI7 以 A 级出道，现为 SS
    const gp = s.players['t2-C'];
    setTier(s, 't2-C', 'SS');
    gp.gacha = { ti: 7, round: 0, teamId: 't2', tier: 'A', kind: 'fictional', mmr: thresholds.A + 100, power: 61, talent: 77, insight: 40 };
    // 请神新秀（原型 Dendi）
    const summon = createSummonRookie(s, hofMember(s, 'dendi')!, 'SSR')!;
    summon.teamId = 't3';
    s.teams.t3.playerIds.push(summon.id);
    inductHallOfFame(s, 9);
    const mr = hofMember(s, 'nisha')!;
    // 巅峰等级只取入选届及之前的真实数据与本局等级（不剧透 TI13 的 SSR）
    expect(mr).toMatchObject({ src: 'real', debutTier: traj[first].tier, source: 'inducted', ti: 9, peakTier: 'SS' });
    expect(isSummonable(mr)).toBe(true);
    const mg = hofMember(s, 't2-C')!;
    expect(mg.src).toBe('game');
    expect(mg.debutTier).toBe('A'); // 出道等级取抽卡出道点 → 之后可作为 A 级请神卡的原型
    expect(mg.traj![0]).toEqual([7, thresholds.A + 100, 61]);
    expect(prototypeDebut(mg)).toMatchObject({ mmr: thresholds.A + 100, power: 61, talent: 77, insight: 40 });
    expect(summonPrototypes(s, 'A').map((m) => m.id)).toContain('t2-C');
    const ms = hofMember(s, summon.id)!;
    expect(ms).toMatchObject({ src: 'summon', of: 'dendi' });
    expect(isSummonable(ms)).toBe(false);
    expect(summonPrototypes(s, 'SSR').map((m) => m.id)).not.toContain(summon.id);
    // 在役请神新秀
    expect(livingSummonsOf(s, 'dendi').map((p) => p.id)).toEqual([summon.id]);
    // 之后的赛季结算：在役的真实选手巅峰等级按本局等级更新
    nisha.mmr = thresholds.SSR + 100;
    inductHallOfFame(s, 10, { news: false });
    expect(hofMember(s, 'nisha')!.peakTier).toBe('SSR');
    // 下个赛季的卡池可以出现本局入选的原型（A 级请神卡）
    s.season.ti = 10;
    s.season.year = 2021;
    const pool = startGachaSeason(s)!;
    expect(pool.made.A![1]).toBeGreaterThan(0);
    expect(pool.summon.A).toContain('t2-C');
  });
});

describe('名人堂 · 迁移与视图', () => {
  it('旧存档：读档时以初始成员创建并补录当前 SS / SSR（不发新闻，幂等）；JSON 往返一致', () => {
    const s = makeTestState(4);
    delete s.hallOfFame;
    setTier(s, 't1-C', 'SS');
    const news = s.news.length;
    upgradeLoadedState(s);
    expect(s.hallOfFame!.migratedTi).toBe(9);
    expect(s.hallOfFame!.members.filter((m) => m.source === 'seed')).toHaveLength(35);
    expect(hofMember(s, 't1-C')).toMatchObject({ source: 'inducted', ti: 9 });
    expect(s.news.length).toBe(news);
    // 同新游戏：DotA1 时代传奇 + 开局补录（开局届 TI9 之前的真实 SS / SSR）
    expect(s.hallOfFame!.backfillVersion).toBe(HOF_BACKFILL_VERSION);
    expect(s.hallOfFame!.members.filter((m) => m.source === 'backfill').map((m) => m.id).sort())
      .toEqual(backfillMembers(9, new Set(seedMembers().map((m) => m.id))).map((m) => m.id).sort());
    const n = s.hallOfFame!.members.length;
    expect(migrateHallOfFame(s)).toBe(false);
    upgradeLoadedState(s);
    expect(s.hallOfFame!.members).toHaveLength(n);
    // 卡池不在读档时补建（本赛季已举行过选秀），下个赛季初建池
    expect(s.gacha?.pool ?? null).toBeNull();
    const back = importSave(exportSave(s));
    expect(back.hallOfFame).toEqual(s.hallOfFame);
  });

  it('多人旧房间：migrateRoomState 补建名人堂（幂等）', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build', seed: 3,
      players: [{ sessionId: 's', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } }],
    });
    expect(M.migrateRoomState(g)).toBe(false);
    delete g.hallOfFame;
    expect(M.migrateRoomState(g)).toBe(true);
    expect(g.hallOfFame!.members.length).toBeGreaterThanOrEqual(35);
    expect(M.migrateRoomState(g)).toBe(false);
    expect(g.multiplayer!.activeSeat).toBeNull();
  });

  it('DotaPedia：名人堂列表（种子在前、在役请神人数）；选手页的请神关系（新秀 → 原型、原型 → 在役请神新秀）', () => {
    const s = makeTestState(4);
    const summon = createSummonRookie(s, hofMember(s, 'dendi')!, 'SSR')!;
    const rows = hallOfFameRows(s);
    expect(rows[0].source).toBe('seed');
    // 顺序：DotA1 时代 → 真实数据补录 → 本局入堂
    const order = rows.map((r) => ({ seed: 0, backfill: 1, inducted: 2 })[r.source]);
    expect(order).toEqual(order.slice().sort((a, b) => a - b));
    expect(rows.some((r) => r.source === 'backfill')).toBe(true);
    expect(rows.find((r) => r.id === 'dendi')!.livingSummons).toBe(1);
    expect(rows.find((r) => r.id === '2009')).toMatchObject({ era: 'dota1', inGame: 'absent', summonable: true });
    const page = pediaPlayerPage(s, summon.id)!;
    expect(page.summon).toMatchObject({ protoId: 'dendi', protoHandle: 'Dendi', ti: 9, protoHasPage: true });
    expect(page.hallOfFame).toBeNull();
    const dendi = pediaPlayerPage(s, 'dendi')!;
    expect(dendi.hallOfFame).toMatchObject({ source: 'seed', era: 'dota1', summonable: true });
    expect(dendi.hallOfFame!.summons.map((x) => x.id)).toEqual([summon.id]);
  });
});
