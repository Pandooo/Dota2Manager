// 羁绊系统（src/engine/synergy.ts，第十波 #5）：定义数据、激活 / 失效（转会、解约、临时替补）、全队修正器、
// 同属性不叠加、隐藏 / 解锁（图鉴提示、首次觉醒新闻）、届次限制、AI 战队激活、多人模式全局状态
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Player, SynergyDef } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader, readRosterSync } from '../scripts/nodeData';
import {
  SYNERGY_SOURCE_PREFIX, allSynergies, synergyCatalog, synergyDef, synergyHolder, synergyProgress, synergySource,
  syncSynergies, teamSynergies,
} from '../src/engine/synergy';
import { addPlayerToTeam, removePlayerFromTeam } from '../src/engine/team';
import { effectiveAttr, effectivePower } from '../src/engine/player';
import { executeTransfer, releasePlayer } from '../src/engine/market';
import { resolveDecision } from '../src/engine/events';
import { createNewGame } from '../src/engine/game';
import { getPlayerIndex } from '../src/data/index';
import { SEAT_HISTORY_KEYS, SEAT_SEASON_KEYS, SEAT_TOP_KEYS } from '../src/engine/seat';
import * as M from '../src/engine/multi';
import { makePlayer, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const def = (id: string): SynergyDef => {
  const d = synergyDef(id);
  if (!d) throw new Error(`缺少羁绊 ${id}`);
  return d;
};

/** 把羁绊成员（按真实 id）签入指定战队 */
function gather(state: GameState, d: SynergyDef, teamId: string, skip: string[] = []): Player[] {
  const out: Player[] = [];
  for (const m of d.members) {
    if (skip.includes(m.id)) continue;
    const p = state.players[m.id] ?? makePlayer({ id: m.id, handle: m.handle, position: m.position });
    state.players[p.id] = p;
    addPlayerToTeam(state, p.id, teamId, { salary: 5000, contractSeasons: 2 });
    out.push(p);
  }
  return out;
}

const synMods = (p: Player | undefined) => (p?.modifiers ?? []).filter((m) => m.source.startsWith(SYNERGY_SOURCE_PREFIX));
const awakeningNews = (g: GameState) => g.news.filter((n) => n.title.startsWith('【羁绊觉醒】'));

describe('羁绊定义数据（scripts/build-synergies.ts → src/data/synergies.json）', () => {
  it('TI1–TI15 每届冠军阵容各一条（同一五人组多次夺冠合并），成员为当届冠军的首发五人', () => {
    const champs = allSynergies().filter((d) => d.kind === 'champion');
    const covered = champs.flatMap((d) => d.tis).sort((a, b) => a - b);
    expect(covered).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    for (const d of champs) {
      for (const ti of d.tis) {
        const team = readRosterSync(ti).teams.find((t) => t.atTI && String(t.tiResult) === '1');
        expect(team, `TI${ti} 冠军`).toBeTruthy();
        expect(d.members.map((m) => m.id).sort()).toEqual(team!.players.slice(0, 5).map((p) => p.id).sort());
      }
    }
    // OG 的 TI8 / TI9 为同一五人组：合并为一条
    expect(def('ti8-og').tis).toEqual([8, 9]);
    expect(champs.find((d) => d.ti === 9)).toBeUndefined();
    // TI4 Newbee 的替补 KingJ 不计入
    expect(def('ti4-newbee').members.map((m) => m.id)).not.toContain('kingj');
  });

  it('用户指定的属性：Wings、Na\'Vi 灵性；Spirit 韧性；OG 天赋；Newbee 战斗力；Liquid 天梯', () => {
    const byClub = (club: string) => allSynergies().filter((d) => d.clubId === club && d.kind === 'champion').map((d) => d.attr);
    expect(byClub('wings-gaming')).toEqual(['insight']);
    expect(byClub('natus-vincere')).toEqual(['insight']);
    expect(byClub('team-spirit')).toEqual(['resilience', 'resilience', 'resilience']);
    expect(byClub('og')).toEqual(['talent']);
    expect(byClub('newbee')).toEqual(['power']);
    expect(byClub('team-liquid')).toEqual(['mmr', 'mmr']);
  });

  it('名称唯一、成员位置各不相同且都是真实选手；标志性阵容只有少数几条', () => {
    const index = new Set(getPlayerIndex().map((e) => e.id));
    const names = new Set<string>();
    for (const d of allSynergies()) {
      expect(names.has(d.name)).toBe(false);
      names.add(d.name);
      expect(d.name).toBe(`TI${d.ti} · ${d.short} 五人组`);
      expect(new Set(d.members.map((m) => m.position)).size).toBe(5);
      for (const m of d.members) expect(index.has(m.id), `${d.id}: ${m.id}`).toBe(true);
    }
    const iconic = allSynergies().filter((d) => d.kind === 'iconic');
    expect(iconic.length).toBeGreaterThan(0);
    expect(iconic.length).toBeLessThanOrEqual(4);
  });
});

describe('羁绊激活 / 失效', () => {
  it('五人同队 → 激活：全队（含替补、临时替补）获得修正器；成员离队 → 失效并收回', () => {
    const g = makeTestState(4);
    const wings = def('ti6-wings-gaming');
    const members = gather(g, wings, 't1'); // AI 战队
    const bench = g.players['t1-C']; // 原有队员（被挤到替补也算全队）
    const before = effectiveAttr(bench, 'insight');
    syncSynergies(g);

    expect(synergyHolder(g, wings)).toBe('t1');
    expect(g.synergies?.active[wings.id]?.teamId).toBe('t1');
    for (const p of [...members, ...g.teams.t1.playerIds.map((id) => g.players[id])]) {
      const mods = synMods(p);
      expect(mods).toHaveLength(1);
      expect(mods[0]).toMatchObject({ source: synergySource(wings), attr: 'insight', kind: 'add', value: CONFIG.synergy.bonus.insight.value, roundsLeft: null });
    }
    expect(effectiveAttr(bench, 'insight')).toBeCloseTo(before + CONFIG.synergy.bonus.insight.value, 6);
    // 其他战队不受影响
    expect(synMods(g.players['t2-C'])).toHaveLength(0);

    // 转会走一名成员：羁绊失效，双方所有人都没有羁绊修正器
    const leaving = g.players['blink'];
    executeTransfer(g, leaving.id, 't2', 0, { contractSeasons: 2 });
    syncSynergies(g);
    expect(g.synergies?.active[wings.id]).toBeUndefined();
    for (const id of [...g.teams.t1.playerIds, ...g.teams.t2.playerIds]) expect(synMods(g.players[id])).toHaveLength(0);
    // 解锁记录保留
    expect(g.synergies?.unlocked[wings.id]?.teamId).toBe('t1');
  });

  it('人类玩家解约成员（market.releasePlayer）后立即失效，不必等回合结束', () => {
    const g = makeTestState(4);
    const og = def('ti8-og');
    gather(g, og, 't0');
    syncSynergies(g);
    expect(teamSynergies(g, 't0').map((v) => v.def.id)).toEqual([og.id]);
    const r = releasePlayer(g, 'topson');
    expect(r.ok).toBe(true);
    expect(teamSynergies(g, 't0')).toEqual([]);
    expect(synMods(g.players['ana'])).toHaveLength(0);
    expect(synMods(g.players['topson'])).toHaveLength(0);
    expect(g.news.some((n) => n.title === `【羁绊】「${og.name}」失效`)).toBe(true);
  });

  it('人类玩家同意离队申请（events.resolveDecision）后立即失效，不必等回合结束', () => {
    const g = makeTestState(4);
    const og = def('ti8-og');
    gather(g, og, 't0');
    syncSynergies(g);
    expect(teamSynergies(g, 't0')).toHaveLength(1);
    g.pendingDecisions.push({
      id: 'd-leave', kind: 'leave_request', title: '离队申请', body: '', createdRound: 0, blocking: true,
      choices: [{ id: 'allow', label: '同意' }, { id: 'persuade', label: '挽留' }],
      ctx: { playerId: 'ceb' },
    });
    const r = resolveDecision(g, 'd-leave', 'allow');
    expect(r.ok).toBe(true);
    expect(g.players['ceb'].teamId).toBeNull();
    expect(teamSynergies(g, 't0')).toEqual([]);
    for (const id of [...g.teams.t0.playerIds, 'ceb']) expect(synMods(g.players[id])).toHaveLength(0);
  });

  it('新队员加入已激活羁绊的战队会获得加成；离队的普通队员被收回', () => {
    const g = makeTestState(4);
    const newbee = def('ti4-newbee');
    gather(g, newbee, 't1');
    syncSynergies(g);
    const rookie = makePlayer({ id: 'rookie-x', position: 'M' });
    g.players[rookie.id] = rookie;
    addPlayerToTeam(g, rookie.id, 't1', { salary: 1000, contractSeasons: 1 });
    syncSynergies(g);
    expect(synMods(rookie)).toHaveLength(1);
    expect(effectivePower(rookie)).toBeCloseTo(rookie.power * CONFIG.synergy.bonus.power.value, 6);
    removePlayerFromTeam(g, rookie.id);
    syncSynergies(g);
    expect(synMods(rookie)).toHaveLength(0);
    expect(g.synergies?.active[newbee.id]).toBeTruthy();
  });

  it('临时替补不算成员；不要求都是首发（替补席上的成员也算）', () => {
    const g = makeTestState(4);
    const liquid = def('ti7-team-liquid');
    gather(g, liquid, 't1', ['kuroky']);
    const kuroky = makePlayer({ id: 'kuroky', handle: 'KuroKy', position: 'HS', tempSubUntilTournament: 'some-cup' });
    g.players[kuroky.id] = kuroky;
    addPlayerToTeam(g, kuroky.id, 't1', { salary: 1000 });
    syncSynergies(g);
    expect(g.synergies?.active[liquid.id]).toBeUndefined();
    delete kuroky.tempSubUntilTournament;
    // 把 KuroKy 放到替补席（首发由原队员担任）
    g.teams.t1.lineup.HS = 't1-HS';
    expect(CONFIG.synergy.requireStarters).toBe(false);
    syncSynergies(g);
    expect(g.synergies?.active[liquid.id]?.teamId).toBe('t1');
    expect(effectiveAttr(g.players['t1-HS'], 'mmr')).toBe(g.players['t1-HS'].mmr + CONFIG.synergy.bonus.mmr.value);
  });

  it('退役 / 解散战队的成员不算；full 同步清理残留修正器', () => {
    const g = makeTestState(4);
    const wings = def('ti6-wings-gaming');
    gather(g, wings, 't1');
    syncSynergies(g);
    // 模拟其他模块直接把成员移出（未经 market）：即时同步之前修正器残留，full 同步全部清理
    removePlayerFromTeam(g, 'shadow');
    g.players['shadow'].status = 'retired';
    g.synergies!.active[wings.id].playerIds = []; // 记录丢失也能靠全量扫描清理
    syncSynergies(g, { full: true });
    for (const id in g.players) expect(synMods(g.players[id])).toHaveLength(0);
    expect(g.synergies?.active[wings.id]).toBeUndefined();
  });

  it('同一战队的同属性羁绊不叠加：Spirit TI10 + TI12 只生效最早的一个，拆掉后由另一个接替', () => {
    const g = makeTestState(4);
    g.season.ti = 13;
    const s10 = def('ti10-team-spirit');
    const s12 = def('ti12-team-spirit');
    gather(g, s10, 't1');
    gather(g, s12, 't1'); // 共享 4 人，只多签 Larl
    syncSynergies(g);
    const views = teamSynergies(g, 't1');
    expect(views.map((v) => [v.def.id, v.effective])).toEqual([[s10.id, true], [s12.id, false]]);
    for (const id of g.teams.t1.playerIds) {
      const mods = synMods(g.players[id]);
      expect(mods).toHaveLength(1);
      expect(mods[0].source).toBe(synergySource(s10));
    }
    removePlayerFromTeam(g, 'torontotokyo');
    syncSynergies(g);
    expect(teamSynergies(g, 't1').map((v) => [v.def.id, v.effective])).toEqual([[s12.id, true]]);
    for (const id of g.teams.t1.playerIds) expect(synMods(g.players[id]).map((m) => m.source)).toEqual([synergySource(s12)]);
  });

  it('该届真实 TI 打完之后（当前赛季 > 羁绊届次）才能觉醒', () => {
    const g = makeTestState(4);
    const secret = def('ti9-team-secret');
    gather(g, secret, 't1');
    expect(g.season.ti).toBe(9);
    syncSynergies(g);
    expect(g.synergies?.active[secret.id]).toBeUndefined();
    expect(synergyCatalog(g).find((e) => e.def.id === secret.id)?.available).toBe(false);
    g.season.ti = 10;
    syncSynergies(g);
    expect(g.synergies?.active[secret.id]?.teamId).toBe('t1');
  });
});

describe('隐藏 / 解锁', () => {
  it('未解锁只显示提示；首次觉醒发新闻并解锁；再次激活不重复「觉醒」新闻', () => {
    const g = makeTestState(4);
    const wings = def('ti6-wings-gaming');
    const locked = synergyCatalog(g, 't0').find((e) => e.def.id === wings.id)!;
    expect(locked.unlocked).toBe(false);
    expect(locked.hint).toBe('TI6 冠军之魂 · ？？？');
    expect(locked.members).toEqual([]);
    expect(synergyProgress(g)).toMatchObject({ unlocked: 0, active: 0, total: allSynergies().length });

    gather(g, wings, 't0');
    syncSynergies(g);
    const news = awakeningNews(g);
    expect(news).toHaveLength(1);
    expect(news[0].title).toBe(`【羁绊觉醒】${wings.name}`);
    expect(news[0].important).toBe(true);
    const open = synergyCatalog(g, 't0').find((e) => e.def.id === wings.id)!;
    expect(open.unlocked).toBe(true);
    expect(open.members.map((m) => m.id)).toEqual(wings.members.map((m) => m.id));
    expect(open.owned).toBe(5);
    expect(open.active).toMatchObject({ teamId: 't0', effective: true });
    expect(open.visibleTis).toEqual([6]);
    expect(synergyProgress(g)).toMatchObject({ unlocked: 1, active: 1 });

    // 拆散后仍保持解锁；重新集结计数 +1，没有第二条「觉醒」新闻
    removePlayerFromTeam(g, 'y');
    syncSynergies(g);
    expect(synergyCatalog(g, 't0').find((e) => e.def.id === wings.id)).toMatchObject({ unlocked: true, active: null, owned: 4 });
    addPlayerToTeam(g, 'y', 't0', { salary: 1000, contractSeasons: 1 });
    syncSynergies(g);
    expect(awakeningNews(g)).toHaveLength(1);
    expect(g.synergies?.unlocked[wings.id]?.count).toBe(2);
    expect(g.news.some((n) => n.title === `【羁绊】「${wings.name}」再度集结`)).toBe(true);
  });

  it('合并的多冠阵容只展示已经打完的届次（TI9 赛季不剧透 TI9 冠军）', () => {
    const g = makeTestState(4);
    gather(g, def('ti8-og'), 't1');
    syncSynergies(g);
    expect(synergyCatalog(g).find((e) => e.def.id === 'ti8-og')?.visibleTis).toEqual([8]);
    g.season.ti = 10;
    expect(synergyCatalog(g).find((e) => e.def.id === 'ti8-og')?.visibleTis).toEqual([8, 9]);
  });

  it('同步幂等：重复调用不新增修正器、不消耗 id 与随机数', () => {
    const g = makeTestState(4);
    gather(g, def('ti6-wings-gaming'), 't1');
    syncSynergies(g);
    const ids = g.idCounter;
    const rng = g.rngState;
    const mods = JSON.stringify(Object.values(g.players).map((p) => p.modifiers));
    for (let i = 0; i < 3; i++) syncSynergies(g, { full: i % 2 === 0 });
    expect(g.idCounter).toBe(ids);
    expect(g.rngState).toBe(rng);
    expect(JSON.stringify(Object.values(g.players).map((p) => p.modifiers))).toBe(mods);
  });
});

describe('真实开局中的羁绊', () => {
  it('AI 战队同样可以激活：TI9 开局时 OG 的 TI8 夺冠原班五人仍在阵中', async () => {
    const g = await createNewGame({ startTi: 9, seasons: 2, difficulty: 'normal', teamId: 'team-liquid', seed: 5, managerName: '测试' });
    expect(g.teams.og.isPlayer).toBe(false);
    expect(g.synergies?.active['ti8-og']?.teamId).toBe('og');
    expect(g.synergies?.unlocked['ti8-og']).toMatchObject({ ti: 9, teamId: 'og' });
    expect(awakeningNews(g).some((n) => n.title === '【羁绊觉醒】TI8 · OG 五人组')).toBe(true);
    for (const id of g.teams.og.playerIds) {
      const p = g.players[id];
      if (p.status === 'active') expect(synMods(p).map((m) => m.attr)).toEqual(['talent']);
    }
    // TI9 冠军（同一五人组）不在届次之内，Spirit 等未来冠军不会提前觉醒
    expect(Object.keys(g.synergies?.unlocked ?? {}).every((id) => def(id).ti < 9)).toBe(true);
  });

  it('多人模式：羁绊状态为全局数据（不进座位交换列表），各座位视图一致', async () => {
    for (const keys of [SEAT_TOP_KEYS, SEAT_HISTORY_KEYS, SEAT_SEASON_KEYS]) expect(keys).not.toContain('synergies');
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 3,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [a, b] = g.multiplayer!.order;
    expect(g.synergies?.active['ti8-og']?.teamId).toBe('og');
    // 下发给各座位的视图（seatView）包含同一份羁绊状态与修正器
    const va = JSON.stringify(M.seatView(g, a).synergies);
    const vb = JSON.stringify(M.seatView(g, b).synergies);
    expect(M.seatView(g, a).players['ana'].modifiers.some((m) => m.source === '羁绊：TI8 · OG 五人组')).toBe(true);
    expect(va).toBe(vb);
    expect(va).toBe(JSON.stringify(g.synergies));
  });
});
