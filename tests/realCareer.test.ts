// 真实生涯保护与提前退役者复出（v0.4.2，src/engine/realCareer.ts）：
// 用户反馈「我在玩的一局比赛中，怎么没有 Insania（TI2024 Liquid 夺冠五号位）？想组羁绊都不行」——
// 旧版本按年龄 / 等级 / 战力让真实选手退役，Insania（1994 年生，五号位）在 15 局中有 4 局于 TI12 / TI13 结算时退役，
// 而他现实中一直打到 TI14。现在真实阵容数据中还有之后届次记录的真实选手不会退役；旧存档读档时让这类已退役选手复出。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import { getTrajectories } from '../src/data/index';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { processRetirements } from '../src/engine/growth';
import { computeSalary } from '../src/engine/player';
import { freeAgents } from '../src/engine/market';
import {
  REAL_CAREER_VERSION, comebackAfterCoachRelease, lastRealTi, migrateRealCareerComebacks, realCareerContinuesAfter, retirementProtected,
} from '../src/engine/realCareer';
import { exportSave, importSave, upgradeLoadedState } from '../src/engine/save';
import { callAsSeat, createMultiplayerGame, migrateRoomState, seatView } from '../src/engine/multi';
import { fireCoach, hireCoach } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { withSeat } from '../src/engine/seat';
import { removePlayerFromTeam } from '../src/engine/team';
import { synergyDef } from '../src/engine/synergy';
import type { GameState, Player } from '../src/engine/types';
import { makeCoach, makePlayer, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const protectDefault = CONFIG.aging.protectRealCareer;
afterEach(() => {
  (CONFIG.aging as { protectRealCareer: boolean }).protectRealCareer = protectDefault;
});
const setProtect = (on: boolean) => {
  (CONFIG.aging as { protectRealCareer: boolean }).protectRealCareer = on;
};

/** 某届赛季（年份按 TI → 年份：TI11 = 2022 … TI14 = 2025） */
function stateAt(ti: number, seed = 1, teams = 2): GameState {
  const s = makeTestState(teams, seed);
  s.season.ti = ti;
  s.season.year = 2011 + ti;
  s.settings.endTi = 16;
  return s;
}

/** 真实阵容数据中最后一届为 ti 的任一真实选手 */
function realIdEndingAt(ti: number): string {
  const all = getTrajectories();
  const id = Object.keys(all).sort().find((k) => lastRealTi(k) === ti && Object.keys(all[k]).length >= 2);
  if (!id) throw new Error(`no real player ending at TI${ti}`);
  return id;
}

/** 40 岁的低等级老将：旧规则下退役概率 0.85 */
function veteran(id: string, over: Partial<Player> = {}): Player {
  return makePlayer({ id, handle: id, isReal: true, birthYear: 1975, mmr: 4000, power: 60, position: 'C', ...over });
}

describe('真实生涯的最后一届（trajectories.json）', () => {
  it('Insania 真实数据 TI8–TI14；不在数据中的选手为 null', () => {
    expect(lastRealTi('insania')).toBe(14);
    expect(lastRealTi('miracle')).toBe(15);
    expect(lastRealTi('no-such-player')).toBeNull();
    const p = makePlayer({ id: 'insania', isReal: true });
    expect(realCareerContinuesAfter(p, 13)).toBe(true);
    expect(realCareerContinuesAfter(p, 14)).toBe(false);
    // 程序生成选手 / 请神新秀即使 id 相同也不算
    expect(realCareerContinuesAfter({ ...p, isReal: false }, 13)).toBe(false);
    expect(realCareerContinuesAfter({ ...p, summon: { id: 'insania', handle: 'Insania', ti: 9 } }, 13)).toBe(false);
  });
});

describe('TI 结算退役保护（growth.processRetirements）', () => {
  it('真实生涯仍在继续的真实选手不退役（30 个种子；Ceb 的 TI6–7 空档同样受保护），同批程序生成老将照常退役', () => {
    let fictionalRetired = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (const [ti, id] of [[11, 'insania'], [13, 'insania'], [6, 'ceb'], [12, 'puppey']] as const) {
        const s = stateAt(ti, seed, 1);
        s.players[id] = veteran(id);
        for (let i = 0; i < 5; i++) s.players[`f${i}`] = veteran(`f${i}`, { isReal: false });
        // 队内首发同样受保护
        const tp = s.players['t0-HS'];
        s.players.boxi = { ...tp, id: 'boxi', handle: 'Boxi', isReal: true, birthYear: 1975, mmr: 4000 };
        s.teams.t0.playerIds = s.teams.t0.playerIds.map((x) => (x === tp.id ? 'boxi' : x));
        s.teams.t0.lineup.HS = 'boxi';
        delete s.players[tp.id];
        const { retired } = processRetirements(s);
        expect(s.players[id].status, `${id} TI${ti} seed ${seed}`).toBe('active');
        expect(s.players.boxi.status).toBe('active');
        expect(s.teams.t0.lineup.HS).toBe('boxi');
        fictionalRetired += retired.filter((p) => !p.isReal).length;
      }
    }
    expect(fictionalRetired).toBeGreaterThan(30 * 4 * 5 * 0.7);
  });

  it('最后一届真实数据之后照旧按旧规则退役：与关闭保护时逐个相同（同种子）', () => {
    const endId = realIdEndingAt(9);
    let retiredAny = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const build = () => {
        const s = stateAt(14, seed, 2);
        s.players.insania = veteran('insania'); // TI14 是最后一届：TI14 结算不再受保护
        s.players[endId] = veteran(endId);
        for (let i = 0; i < 6; i++) s.players[`f${i}`] = veteran(`f${i}`, { isReal: i % 2 === 0, birthYear: 1985 + i });
        return s;
      };
      const on = build();
      const off = build();
      setProtect(true);
      const a = processRetirements(on).retired.map((p) => p.id).sort();
      setProtect(false);
      const b = processRetirements(off).retired.map((p) => p.id).sort();
      setProtect(true);
      expect(a).toEqual(b);
      expect(on.rngState).toBe(off.rngState);
      if (a.includes('insania')) retiredAny++;
      expect(retirementProtected(on, on.players.insania)).toBe(false);
    }
    expect(retiredAny).toBeGreaterThan(15); // 40 岁低等级：p = 0.85
  });

  it('关闭开关（CONFIG.aging.protectRealCareer = false）恢复旧规则', () => {
    setProtect(false);
    let retired = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = stateAt(11, seed, 0);
      s.players.insania = veteran('insania');
      expect(retirementProtected(s, s.players.insania)).toBe(false);
      processRetirements(s);
      if (s.players.insania.status === 'retired') retired++;
    }
    expect(retired).toBeGreaterThan(10);
  });
});

describe('旧存档：提前退役的真实选手复出（realCareer.migrateRealCareerComebacks）', () => {
  /** 旧存档（TI14 赛季初）：Insania 在 TI13 结算时退役并转任自由教练，人类玩家还有一个待决的「是否聘为教练」 */
  function oldSave(): GameState {
    const s = stateAt(14, 3, 3);
    const p = veteran('insania', {
      handle: 'Insania', birthYear: 1994, mmr: 10600, power: 81, position: 'SS', status: 'retired', teamId: null, lastTeamId: 't1',
      loyalty: 12, contractUntil: 13, joinedSeason: 10, benchRounds: 4,
      modifiers: [{ id: 'm1', attr: 'power', kind: 'add', value: 3, source: '羁绊：TI13 · Liquid 五人组', roundsLeft: 2 }],
      salaryTrack: { fame: 1.2, ti: 13, gap: -0.3, gapTeamId: 't1', rookieTeamId: 't1', rookieUntil: 12 },
      transferListing: { season: 13, listedRound: 2, roundsLeft: 3, askingPrice: 100, version: 2 } as Player['transferListing'],
    });
    s.players.insania = p;
    s.coaches['coach-insania'] = makeCoach({ id: 'coach-insania', name: 'Insania', formerPlayerId: 'insania', teamId: null });
    s.pendingDecisions.push({
      id: 'd1', kind: 'retire', title: 'Insania 宣布退役', body: '', choices: [{ id: 'hire_as_coach', label: '聘为主教练' }, { id: 'decline', label: '不聘用' }],
      ctx: { playerId: 'insania', coachId: 'coach-insania' }, createdRound: 0, blocking: true,
    });
    // 已结束真实生涯的退役真实选手、程序生成的退役选手：不受影响
    const endId = realIdEndingAt(9);
    s.players[endId] = veteran(endId, { status: 'retired' });
    s.players.gen = veteran('gen', { isReal: false, status: 'retired' });
    delete s.realCareerVersion;
    return s;
  }

  it('以自由身回到转会市场：清空修正器、归属感 / 合同 / 工资按自由选手重置，位置按当届真实生涯；删除自由教练记录与待决事件；新闻 + 通知', () => {
    const s = oldSave();
    const endId = realIdEndingAt(9);
    const res = migrateRealCareerComebacks(s)!;
    expect(res.returned.map((r) => r.playerId)).toEqual(['insania']);
    expect(res.returned[0].removedCoachIds).toEqual(['coach-insania']);
    expect(res.returned[0].leftTeamIds).toEqual([]);
    expect(res.skipped).toEqual([]);
    const p = s.players.insania;
    expect(p.status).toBe('active');
    expect(p.teamId).toBeNull();
    expect(p.modifiers).toEqual([]);
    expect(p.loyalty).toBe(CONFIG.loyalty.freeAgentTarget);
    expect(p.contractUntil).toBe(14);
    expect(p.joinedSeason).toBe(14);
    expect(p.benchRounds).toBe(0);
    expect(p.transferListing).toBeUndefined();
    expect(p.position).toBe('HS'); // 真实生涯 TI14 五号位
    expect(p.salary).toBe(computeSalary(s, p));
    expect(p.salaryTrack).toEqual({ fame: 1.2, ti: 13 });
    expect(p.lastTeamId).toBe('t1');
    // 水平不高于当届真实水平：退役时 10600 / 81，真实生涯 TI14 为 10500 / 80
    expect(p.mmr).toBe(10500);
    expect(p.power).toBe(80);
    expect(freeAgents(s).map((x) => x.id)).toContain('insania');
    expect(s.coaches['coach-insania']).toBeUndefined();
    expect(s.pendingDecisions).toEqual([]);
    expect(s.players[endId].status).toBe('retired');
    expect(s.players.gen.status).toBe('retired');
    expect(s.realCareerVersion).toBe(REAL_CAREER_VERSION);
    const n = s.news.filter((x) => x.title.startsWith('【复出】'));
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('【复出】Insania 宣布复出');
    expect(n[0].body).toContain('Insania 宣布复出（现实中的职业生涯仍在继续），以自由身回到转会市场');
    expect(n[0].visibility).toBe('public');
    expect(n[0].playerIds).toEqual(['insania']);
    expect(s.popups.filter((x) => x.kind === 'message' && x.title === '【复出】Insania 宣布复出')).toHaveLength(1);
    // 幂等
    const news = s.news.length;
    expect(migrateRealCareerComebacks(s)).toBeNull();
    upgradeLoadedState(s);
    expect(s.news.length).toBe(news);
    expect(s.popups.filter((x) => x.kind === 'message' && x.title.startsWith('【复出】'))).toHaveLength(1);
  });

  it('水平低于当届真实水平时不补（下个赛季初的自主成长照常靠拢）；空档届次按相邻两届插值封顶', () => {
    const s = oldSave();
    s.players.insania.mmr = 9000;
    s.players.insania.power = 70;
    migrateRealCareerComebacks(s);
    expect(s.players.insania.status).toBe('active');
    expect(s.players.insania.mmr).toBe(9000);
    expect(s.players.insania.power).toBe(70);
    // Ceb 真实数据 TI5 → TI8 空档：TI6 的真实水平为 TI5 / TI8 之间插值（9000 + (11500 - 9000) / 3，72 + (88 - 72) / 3）
    const c = stateAt(6, 4, 2);
    c.players.ceb = veteran('ceb', { handle: 'Ceb', status: 'retired', mmr: 12000, power: 90 });
    delete c.realCareerVersion;
    migrateRealCareerComebacks(c);
    expect(c.players.ceb.status).toBe('active');
    expect(c.players.ceb.mmr).toBe(Math.round(9000 + 2500 / 3));
    expect(c.players.ceb.power).toBeCloseTo(72 + 16 / 3, 1);
    expect(c.players.ceb.position).toBe('SS'); // 空档届次取此前最近一届（TI5）的真实位置
  });


  it('退役后转任的教练在 AI 战队执教：卸任（该队主教练空缺）后复出，新闻注明', () => {
    const s = oldSave();
    s.coaches['coach-insania'].teamId = 't2';
    s.teams.t2.coachId = 'coach-insania';
    s.pendingDecisions = [];
    const res = migrateRealCareerComebacks(s)!;
    expect(res.skipped).toEqual([]);
    expect(res.returned).toEqual([{ playerId: 'insania', handle: 'Insania', removedCoachIds: ['coach-insania'], leftTeamIds: ['t2'] }]);
    expect(s.players.insania.status).toBe('active');
    expect(s.players.insania.teamId).toBeNull();
    expect(s.coaches['coach-insania']).toBeUndefined();
    expect(s.teams.t2.coachId).toBeNull();
    const n = s.news.find((x) => x.title.startsWith('【复出】'));
    expect(n?.title).toBe('【复出】Insania 宣布复出');
    expect(n?.body).toContain('Insania 卸任 Team t2 主教练。');
  });

  it('执教的战队已解散：按自由教练处理（删除教练记录、清掉残留的主教练引用），照常复出', () => {
    const s = oldSave();
    s.coaches['coach-insania'].teamId = 't2';
    s.teams.t2.coachId = 'coach-insania';
    s.teams.t2.disbanded = true;
    const res = migrateRealCareerComebacks(s)!;
    expect(res.returned).toEqual([{ playerId: 'insania', handle: 'Insania', removedCoachIds: ['coach-insania'], leftTeamIds: [] }]);
    expect(s.coaches['coach-insania']).toBeUndefined();
    expect(s.teams.t2.coachId).toBeNull();
    expect(s.news.find((x) => x.title.startsWith('【复出】'))?.body).not.toContain('卸任');
  });

  it('退役后转任的教练在人类玩家战队执教：不替玩家做决定（继续执教，新闻 + 通知注明）；只有这种情况时同样发新闻', () => {
    const s = oldSave();
    s.coaches['coach-insania'].teamId = 't0';
    s.teams.t0.coachId = 'coach-insania';
    s.pendingDecisions = [];
    const res = migrateRealCareerComebacks(s)!;
    expect(res.returned).toEqual([]);
    expect(res.skipped).toEqual([{ playerId: 'insania', handle: 'Insania', coachId: 'coach-insania', teamId: 't0' }]);
    expect(s.players.insania.status).toBe('retired');
    expect(s.coaches['coach-insania'].teamId).toBe('t0');
    expect(s.teams.t0.coachId).toBe('coach-insania');
    expect(s.realCareerVersion).toBe(REAL_CAREER_VERSION);
    const n = s.news.filter((x) => x.title.startsWith('【复出】'));
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('【复出】Insania 继续执教');
    expect(n[0].body).toContain('Insania 现任 Team t0 主教练，继续执教，暂不复出；在他现实中的职业生涯结束之前解除其主教练职务，他即以自由身回到转会市场。');
    expect(n[0].playerIds).toEqual(['insania']);
    expect(s.popups.filter((x) => x.kind === 'message' && x.title === '【复出】Insania 继续执教')).toHaveLength(1);
  });

  it('同时有人复出与暂不复出：一条新闻', () => {
    const s = oldSave();
    s.coaches['coach-insania'].teamId = 't0';
    s.teams.t0.coachId = 'coach-insania';
    s.pendingDecisions = [];
    s.players.boxi = veteran('boxi', { handle: 'Boxi', status: 'retired', position: 'SS', mmr: 11000 });
    s.coaches['coach-boxi'] = makeCoach({ id: 'coach-boxi', name: 'Boxi', formerPlayerId: 'boxi' });
    const res = migrateRealCareerComebacks(s)!;
    expect(res.returned.map((r) => r.playerId)).toEqual(['boxi']);
    expect(res.skipped.map((r) => r.playerId)).toEqual(['insania']);
    expect(s.coaches['coach-boxi']).toBeUndefined();
    const n = s.news.filter((x) => x.title.startsWith('【复出】'));
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('【复出】Boxi 宣布复出');
    expect(n[0].body).toContain('Insania 现任 Team t0 主教练，继续执教，暂不复出');
    expect(n[0].playerIds).toEqual(['boxi', 'insania']);
  });

  it('玩家在他真实生涯结束之前解除主教练职务（解雇 / 签约新教练替换 / 聘请退役旧部替换）：随即以自由身复出', () => {
    const humanCoach = () => {
      const s = oldSave();
      s.coaches['coach-insania'].teamId = 't0';
      s.teams.t0.coachId = 'coach-insania';
      s.teams.t0.gold = 10_000_000;
      s.pendingDecisions = [];
      migrateRealCareerComebacks(s);
      expect(s.players.insania.status).toBe('retired');
      return s;
    };
    const check = (s: GameState, msg: string) => {
      expect(msg).toContain('Insania 宣布复出（现实中的职业生涯仍在继续），以自由身回到转会市场');
      expect(s.players.insania.status).toBe('active');
      expect(s.players.insania.teamId).toBeNull();
      expect(s.coaches['coach-insania']).toBeUndefined();
      expect(freeAgents(s).map((x) => x.id)).toContain('insania');
      expect(s.news.some((x) => x.title === '【复出】Insania 宣布复出' && x.visibility === 'public')).toBe(true);
    };
    // 解雇
    const a = humanCoach();
    const r1 = fireCoach(a);
    expect(r1.ok).toBe(true);
    check(a, r1.message);
    expect(a.teams.t0.coachId).toBeNull();
    // 签约新教练替换
    const b = humanCoach();
    b.coaches.other = makeCoach({ id: 'other', name: 'Other', salary: 1000 });
    const r2 = hireCoach(b, 'other');
    expect(r2.ok).toBe(true);
    check(b, r2.message);
    expect(b.teams.t0.coachId).toBe('other');
    // 聘请退役旧部替换
    const c = humanCoach();
    c.coaches.former = makeCoach({ id: 'former', name: 'Former', formerPlayerId: 'gen' });
    c.pendingDecisions.push({
      id: 'd2', kind: 'retire', title: 'Former 宣布退役', body: '', choices: [{ id: 'hire_as_coach', label: '聘为主教练' }, { id: 'decline', label: '不聘用' }],
      ctx: { playerId: 'gen', coachId: 'former' }, createdRound: 0, blocking: true,
    });
    const r3 = resolveDecision(c, 'd2', 'hire_as_coach');
    expect(r3.ok).toBe(true);
    check(c, r3.message);
    expect(c.teams.t0.coachId).toBe('former');
    // 真实生涯已经结束（TI15 赛季，Insania 最后一届 TI14）：解雇后只是进入教练市场
    const d = humanCoach();
    d.season.ti = 15;
    const r4 = fireCoach(d);
    expect(r4.message).not.toContain('复出');
    expect(d.players.insania.status).toBe('retired');
    expect(d.coaches['coach-insania'].teamId).toBeNull();
    // 普通教练 / 程序生成选手转任的教练：无事发生
    expect(comebackAfterCoachRelease(d, makeCoach({ id: 'x' }))).toBeNull();
    expect(comebackAfterCoachRelease(d, null)).toBeNull();
  });

  it('转会窗口已关闭（TI 阶段）：只让当届之后仍有真实数据的选手复出（当届 TI 前无法签约，结算时又会退役）', () => {
    for (const phase of ['ti_qualifier', 'ti'] as const) {
      const s = oldSave();
      s.phase = phase;
      s.players.boxi = veteran('boxi', { handle: 'Boxi', status: 'retired', position: 'SS', mmr: 11000 });
      const res = migrateRealCareerComebacks(s)!;
      expect(res.returned.map((r) => r.playerId)).toEqual(['boxi']); // Boxi 真实数据到 TI15
      expect(s.players.insania.status).toBe('retired'); // Insania 最后一届 TI14 = 当届
      expect(s.coaches['coach-insania']).toBeDefined();
      expect(s.pendingDecisions).toHaveLength(1);
    }
  });

  it('没有教练记录也能复出；JSON 导入（importSave）与「继续游戏」（upgradeLoadedState）同样迁移，只执行一次', () => {
    const s = oldSave();
    delete s.coaches['coach-insania'];
    s.pendingDecisions = [];
    const loaded = importSave(exportSave(s));
    expect(loaded.players.insania.status).toBe('active');
    expect(loaded.realCareerVersion).toBe(REAL_CAREER_VERSION);
    const again = importSave(exportSave(loaded));
    expect(again.news.filter((x) => x.title.startsWith('【复出】'))).toHaveLength(1);
    const g = upgradeLoadedState(oldSave());
    expect(g.players.insania.status).toBe('active');
  });

  it('新游戏与已结束的存档不复出；关闭开关时不迁移也不写版本', () => {
    const fresh = oldSave();
    fresh.realCareerVersion = REAL_CAREER_VERSION;
    expect(migrateRealCareerComebacks(fresh)).toBeNull();
    expect(fresh.players.insania.status).toBe('retired');

    const over = oldSave();
    over.gameOver = { reason: 'completed', summary: '' };
    expect(migrateRealCareerComebacks(over)).toEqual({ returned: [], skipped: [] });
    expect(over.players.insania.status).toBe('retired');
    expect(over.realCareerVersion).toBe(REAL_CAREER_VERSION);

    setProtect(false);
    const off = oldSave();
    expect(migrateRealCareerComebacks(off)).toBeNull();
    expect(off.players.insania.status).toBe('retired');
    expect(off.realCareerVersion).toBeUndefined();
  });

  it('真实生涯在当前届次之前已经结束（如 TI14 赛季时最后一届为 TI13）：不复出', () => {
    const s = oldSave();
    s.season.ti = 15;
    s.season.year = 2026;
    migrateRealCareerComebacks(s);
    expect(s.players.insania.status).toBe('retired'); // 最后一届 TI14 < 当前 TI15
    expect(s.coaches['coach-insania']).toBeDefined();
  });

  it('多人旧房间：migrateRoomState 迁移一次（中性上下文），公开新闻，各座位各一条通知', async () => {
    const g = await createMultiplayerGame({
      startTi: 14, endTi: 15, difficulty: 'normal', mode: 'build', seed: 5,
      players: [
        { sessionId: 's1', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's2', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#2a6cc2' } },
      ],
    });
    expect(migrateRoomState(g)).toBe(false); // 新房间已是最新版本
    const p = g.players.insania;
    expect(p?.status).toBe('active');
    removePlayerFromTeam(g, 'insania');
    p.status = 'retired';
    g.coaches['coach-insania'] = makeCoach({ id: 'coach-insania', name: 'Insania', formerPlayerId: 'insania' });
    const ids0 = Object.keys(g.multiplayer!.seats);
    // 第二个座位（非当前座位，状态保存在 seat.saved 中）有一个待决的「是否聘为教练」
    withSeat(g, ids0[1], () => {
      g.pendingDecisions.push({
        id: 'd-mp', kind: 'retire', title: 'Insania 宣布退役', body: '', choices: [{ id: 'hire_as_coach', label: '聘为主教练' }],
        ctx: { playerId: 'insania', coachId: 'coach-insania' }, createdRound: 0, blocking: true,
      });
    });
    // 另一名提前退役的真实选手在第一个座位的战队执教：暂不复出，各座位都收到通知
    const boxi = g.players.boxi;
    removePlayerFromTeam(g, 'boxi');
    boxi.status = 'retired';
    g.coaches['coach-boxi'] = makeCoach({ id: 'coach-boxi', name: 'Boxi', formerPlayerId: 'boxi', teamId: ids0[0] });
    g.teams[ids0[0]].coachId = 'coach-boxi';
    delete g.realCareerVersion;
    expect(seatView(g, ids0[1]).pendingDecisions.some((d) => d.id === 'd-mp')).toBe(true);
    expect(migrateRoomState(g)).toBe(true);
    expect(seatView(g, ids0[1]).pendingDecisions.some((d) => d.id === 'd-mp')).toBe(false);
    expect(g.players.boxi.status).toBe('retired');
    expect(g.teams[ids0[0]].coachId).toBe('coach-boxi');
    expect(g.multiplayer!.activeSeat).toBeNull();
    expect(g.players.insania.status).toBe('active');
    expect(g.players.insania.teamId).toBeNull();
    expect(g.coaches['coach-insania']).toBeUndefined();
    expect(migrateRoomState(g)).toBe(false);
    const ids = Object.keys(g.multiplayer!.seats);
    expect(ids).toHaveLength(2);
    const title = `【复出】${g.players.insania.handle} 宣布复出`;
    for (const id of ids) {
      const v = seatView(g, id);
      expect(v.news.some((x) => x.title === title)).toBe(true);
      expect(v.popups.filter((x) => x.kind === 'message' && x.title === title)).toHaveLength(1);
      const pop = v.popups.find((x) => x.kind === 'message' && x.title === title);
      expect(pop?.kind === 'message' ? pop.body : '').toContain('Boxi 现任');
    }
    expect(g.popups ?? []).toHaveLength(0); // 中性状态没有通知
    // 第一个座位解雇主教练（RPC）：Boxi 以自由身复出
    const r = callAsSeat(g, ids0[0], 'fireCoach', []) as { ok: boolean; message: string };
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Boxi 宣布复出');
    expect(g.players.boxi.status).toBe('active');
    expect(g.players.boxi.teamId).toBeNull();
    expect(g.coaches['coach-boxi']).toBeUndefined();
    expect(seatView(g, ids0[1]).news.some((x) => x.title === '【复出】Boxi 宣布复出')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 用户场景：TI9 / TI11 开局推进到 TI14 赛季初，Insania（与 TI13 Liquid 夺冠五人）都还在役
// ---------------------------------------------------------------------------

async function advanceTo(startTi: number, untilTi: number, seed: number): Promise<GameState> {
  const { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimTournament } = await import('../src/engine/game');
  const { resolveDecision } = await import('../src/engine/events');
  const g = await createNewGame({
    startTi, seasons: untilTi - startTi + 1, difficulty: 'normal', managerName: 'T', seed,
    newClub: { name: 'Probe', tag: 'PRB', region: 'CN', color: '#888888' },
  });
  for (let step = 0; step < 4000 && !g.gameOver && !(g.season.ti >= untilTi && g.phase === 'preseason'); step++) {
    g.popups.length = 0;
    for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
      const d = g.pendingDecisions[0];
      resolveDecision(g, d.id, d.choices[0]?.id ?? '');
      if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
    }
    const me = g.teams[g.settings.playerTeamId];
    if (me && g.phase === 'preseason' && me.gold < 2_000_000) me.gold = 2_000_000;
    if (currentPlayerTournament(g) || g.activeMatch) {
      if (!quickSimTournament(g).ok) fillLineupWithTempSubs(g);
    }
    advance(g);
  }
  return g;
}

describe('用户场景：Insania 打到 TI14', () => {
  const liquid = synergyDef('ti13-team-liquid')!;

  it('羁绊 TI13 Liquid 五人组：五人的真实生涯都至少到 TI14', () => {
    expect(liquid.members.map((m) => m.id).sort()).toEqual(['33', 'boxi', 'insania', 'micke', 'nisha']);
    for (const m of liquid.members) expect(lastRealTi(m.id)!, m.id).toBeGreaterThanOrEqual(14);
  });

  for (const startTi of [9, 11]) {
    it(`TI${startTi} 开局推进到 TI14 赛季初（10 个种子）：Insania 在役，TI13 Liquid 五人都没有退役`, async () => {
      for (let seed = 1; seed <= 10; seed++) {
        const g = await advanceTo(startTi, 14, seed);
        expect(g.season.ti, `seed ${seed}`).toBe(14);
        expect(g.phase).toBe('preseason');
        expect(g.players.insania?.status, `TI${startTi} seed ${seed}: insania`).toBe('active');
        // 其余四人：不会退役（AI 俱乐部全员假赛曝光时可能被禁赛，与退役无关）
        for (const m of liquid.members) {
          expect(g.players[m.id]?.status, `TI${startTi} seed ${seed}: ${m.id}`).not.toBe('retired');
        }
      }
    }, 120000);
  }
});
