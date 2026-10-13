// 位置（第十三波；用户反馈 2026-10-12：「spirit 的 mira/miposhka/rue/notme 都是四号位……至少有两个是 5 号位，
// 或者是四号、五号位都可以，不然无法组建完整阵容」）：真实生涯位置数据、位置系数、副位置、自动排阵、赛季同步、旧存档迁移。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Player, Position } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { addTeam, makePlayer, makeTestState } from './helpers';
import {
  ROLE_DATA_VERSION, naturalPositions, parseRoleHistory, playsNaturally, positionText, realAltPositions, realRoleExactAt,
  realRoleFor, realRoleHistory, realRoleSpans, roleFactor, roleFit, uncoveredPositions,
} from '../src/engine/roles';
import { migrateRealRoles, syncSeasonRoles } from '../src/engine/roleSync';
import { overallRating, playerRating } from '../src/engine/player';
import { autoLineup, validateLineup } from '../src/engine/team';
import { fillEmptyLineupSlots } from '../src/engine/season';
import { aiLineupPriority } from '../src/engine/lineupPriority';
import { playerFromSeed, rookieFromIndex } from '../src/engine/generation';
import { exportSave, importSave, upgradeLoadedState } from '../src/engine/save';
import { foundSeasonClubs } from '../src/engine/clubs';
import { withConfig } from './e4-fakes/mocks';
import { getPlayerIndex, getTrajectories } from '../src/data/index';
import { readRosterSync, registerNodeRosterLoader } from '../scripts/nodeData';
import { createNewGame } from '../src/engine/game';
import { autopilotSeat, createMultiplayerGame, migrateRoomState, seatView } from '../src/engine/multi';

beforeAll(() => {
  registerNodeRosterLoader();
});

const T = CONFIG.team as { altRoleFactor: number; supportSwapFactor: number; offRoleFactor: number };
const savedFactors = { ...T };
afterEach(() => {
  T.altRoleFactor = savedFactors.altRoleFactor;
  T.supportSwapFactor = savedFactors.supportSwapFactor;
  T.offRoleFactor = savedFactors.offRoleFactor;
});

/** 把真实选手（按 id）放进战队 */
function putReal(s: GameState, teamId: string | null, id: string, position: Position, power = 80, extra: Partial<Player> = {}): Player {
  const p = makePlayer({ id, handle: id, position, power, teamId, isReal: true, ...extra });
  s.players[id] = p;
  if (teamId && !s.teams[teamId].playerIds.includes(id)) s.teams[teamId].playerIds.push(id);
  return p;
}

/** 清空战队，换成给定名单 */
function roster(s: GameState, teamId: string, list: [string, Position, number, Position[]?][]): void {
  const team = s.teams[teamId];
  for (const id of team.playerIds) delete s.players[id];
  team.playerIds = [];
  team.lineup = { C: null, M: null, O: null, SS: null, HS: null };
  for (const [id, pos, power, alt] of list) {
    const p = makePlayer({ id, handle: id, position: pos, power, teamId, ...(alt ? { altPositions: alt } : {}) });
    s.players[id] = p;
    team.playerIds.push(id);
  }
}

describe('真实生涯位置数据（trajectories.json 的 pos）', () => {
  it('Miposhka TI6 四号位、TI7 起五号位；rue TI14 四号位、TI15 五号位；puppey TI7 起五号位；Mira / notme 四号位', () => {
    expect(realRoleExactAt('miposhka', 6)).toBe('SS');
    for (let ti = 7; ti <= 14; ti++) expect(realRoleFor('miposhka', ti), `miposhka TI${ti}`).toBe('HS');
    expect(realRoleExactAt('miposhka', 15)).toBeNull(); // 没有 TI15 数据：保留最近一届
    expect(realRoleFor('miposhka', 15)).toBe('HS');
    expect(realRoleExactAt('rue', 14)).toBe('SS');
    expect(realRoleExactAt('rue', 15)).toBe('HS');
    expect(realRoleExactAt('puppey', 6)).toBe('SS');
    for (let ti = 7; ti <= 14; ti++) expect(realRoleFor('puppey', ti), `puppey TI${ti}`).toBe('HS');
    expect(realRoleFor('mira', 15)).toBe('SS');
    expect(realRoleExactAt('notme', 15)).toBe('SS');
    expect(realRoleFor('notme', 14)).toBe('SS'); // 早于真实首届：取首届
    expect(realAltPositions('miposhka', 'HS', 15)).toEqual(['SS']);
    expect(realAltPositions('mira', 'SS', 15)).toEqual([]);
    expect(realRoleSpans('miposhka')).toEqual([{ from: 6, to: 6, pos: 'SS' }, { from: 7, to: 14, pos: 'HS' }]);
    expect(realRoleHistory('no-such-player')).toBeNull();
  });

  it('副位置只算截至当届担任过的位置（未来才担任的不算；早于真实首届没有副位置）', () => {
    // n0tail：TI2–5 四号位 → TI6–7 一号位 → TI8–11 五号位
    expect(realAltPositions('n0tail', 'C', 6)).toEqual(['SS']);
    expect(realAltPositions('n0tail', 'HS', 8)).toEqual(['C', 'SS']);
    expect(realAltPositions('miposhka', 'SS', 6)).toEqual([]); // TI7 起才是五号位
    expect(realAltPositions('miposhka', 'HS', 7)).toEqual(['SS']);
    expect(realAltPositions('notme', 'SS', 7)).toEqual([]); // 真实首届 TI15
    expect(realAltPositions('torontotokyo', 'M', 10)).toEqual([]); // TI12 起才打五号位
    expect(realAltPositions('torontotokyo', 'HS', 15)).toEqual(['O', 'M']); // 按最近担任排序
  });

  it('DotaPedia 真实生涯位置：缺席的届次断开，不显示本局尚未到来的届次', () => {
    // alwayswannafly：TI1–5、TI8 五号位（TI6–7 不在任何阵容）
    expect(realRoleSpans('alwayswannafly')).toEqual([{ from: 1, to: 5, pos: 'HS' }, { from: 8, to: 8, pos: 'HS' }]);
    // puppey 在 TI6 的局里：只到 TI6
    expect(realRoleSpans('puppey', 6)).toEqual([
      { from: 1, to: 4, pos: 'SS' }, { from: 5, to: 5, pos: 'HS' }, { from: 6, to: 6, pos: 'SS' },
    ]);
    expect(realRoleSpans('miposhka', 6)).toEqual([{ from: 6, to: 6, pos: 'SS' }]);
    expect(realRoleSpans('miposhka', 5)).toEqual([]);
  });

  it('展开后的逐届位置与全部 roster 一致；首届必有 pos；playerIndex.position = 首届位置', () => {
    let checked = 0;
    for (let ti = 1; ti <= 15; ti++) {
      const r = readRosterSync(ti);
      for (const p of [...r.teams.flatMap((t) => t.players), ...(r.freeAgents ?? [])]) {
        expect(realRoleExactAt(p.id, ti), `${p.id}@TI${ti}`).toBe(p.position);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
    const traj = getTrajectories();
    for (const e of getPlayerIndex()) {
      const tis = Object.keys(traj[e.id] ?? {}).map(Number).sort((a, b) => a - b);
      expect(traj[e.id][tis[0]].pos, e.id).toBe(e.position);
    }
    // 游程压缩：位置不变的届次不重复写 pos
    const marks = Object.values(traj).reduce((a, t) => a + Object.values(t).filter((x) => x.pos).length, 0);
    const points = Object.values(traj).reduce((a, t) => a + Object.keys(t).length, 0);
    expect(marks).toBeLessThan(points / 2);
    expect(parseRoleHistory({ 3: { power: 1, mmr: 1, tier: 'C' }, 5: { power: 1, mmr: 1, tier: 'C', pos: 'M' }, 6: { power: 1, mmr: 1, tier: 'C' } }))
      .toEqual([{ ti: 5, pos: 'M' }, { ti: 6, pos: 'M' }]);
  });
});

describe('位置系数：本位置 > 副位置 / 四五号位互换 > 非本位置', () => {
  it('roleFactor / roleFit / playerRating', () => {
    const p = makePlayer({ position: 'SS', altPositions: ['C'], power: 80 });
    expect(roleFactor(p, 'SS')).toBe(1);
    expect(roleFactor(p, 'C')).toBe(T.altRoleFactor);
    expect(roleFactor(p, 'HS')).toBe(T.supportSwapFactor);
    expect(roleFactor(p, 'M')).toBe(T.offRoleFactor);
    expect(1).toBeGreaterThan(T.altRoleFactor);
    expect(T.altRoleFactor).toBeGreaterThanOrEqual(T.supportSwapFactor);
    expect(T.supportSwapFactor).toBeGreaterThan(T.offRoleFactor);
    expect(POSITIONS.map((q) => roleFit(p, q))).toEqual(['alt', 'off', 'off', 'main', 'swap']);
    expect(playerRating(p, 'HS') / overallRating(p)).toBeCloseTo(T.supportSwapFactor, 10);
    expect(playerRating(p, 'C') / overallRating(p)).toBeCloseTo(T.altRoleFactor, 10);
    // 副位置与互换同时适用：取较高者
    const q = makePlayer({ position: 'HS', altPositions: ['SS'] });
    expect(roleFactor(q, 'SS')).toBe(Math.max(T.altRoleFactor, T.supportSwapFactor));
    T.supportSwapFactor = 0.97;
    expect(roleFactor(q, 'SS')).toBe(0.97);
    expect(roleFit(q, 'SS')).toBe('swap');
    expect(playsNaturally(p, 'C')).toBe(true);
    expect(playsNaturally(p, 'HS')).toBe(false); // 四五号位互换不算本职
    expect(naturalPositions(p)).toEqual(['SS', 'C']);
    expect(positionText(q)).toBe('五号位（可打四号位）');
  });

  it('uncoveredPositions：每人只打一个位置的本职匹配', () => {
    const P = (position: Position, altPositions?: Position[]) => makePlayer({ position, ...(altPositions ? { altPositions } : {}) });
    expect(uncoveredPositions([P('C'), P('M'), P('O'), P('SS'), P('HS')])).toEqual([]);
    expect(uncoveredPositions([P('C'), P('M'), P('O'), P('SS'), P('SS')])).toEqual(['HS']);
    expect(uncoveredPositions([P('C'), P('M'), P('O'), P('SS'), P('SS', ['HS'])])).toEqual([]);
    // 唯一能打 HS 的人也是唯一的 SS：仍缺一个位置
    expect(uncoveredPositions([P('C'), P('M'), P('O'), P('SS', ['HS'])])).toEqual(['HS']);
    // 本位置优先、副位置可以腾挪：C 由 M 的副位置补上
    expect(uncoveredPositions([P('M', ['C']), P('M'), P('O'), P('SS'), P('HS')])).toEqual([]);
  });
});

describe('自动排阵：4 名四号位、没有五号位也能排出完整阵容', () => {
  it('人类玩家战队：评分最高的四号位打五号位（四五号位互换），其余按本位置', () => {
    const s = makeTestState(2);
    roster(s, 't0', [['c', 'C', 80], ['m', 'M', 80], ['o', 'O', 80], ['ss1', 'SS', 85], ['ss2', 'SS', 82], ['ss3', 'SS', 78], ['ss4', 'SS', 70]]);
    autoLineup(s, 't0');
    const L = s.teams.t0.lineup;
    expect(validateLineup(s, 't0')).toEqual([]);
    expect([L.C, L.M, L.O]).toEqual(['c', 'm', 'o']);
    expect(new Set([L.SS, L.HS])).toEqual(new Set(['ss1', 'ss2']));
    expect(roleFit(s.players[L.HS!], 'HS')).toBe('swap');
  });

  it('有副位置五号位的四号位优先打五号位（副位置 ×0.95 优于互换）', () => {
    const s = makeTestState(2);
    roster(s, 't0', [['c', 'C', 80], ['m', 'M', 80], ['o', 'O', 80], ['ss1', 'SS', 85], ['ss2', 'SS', 80, ['HS']], ['ss3', 'SS', 79]]);
    autoLineup(s, 't0');
    expect(s.teams.t0.lineup.SS).toBe('ss1');
    expect(s.teams.t0.lineup.HS).toBe('ss2');
    expect(roleFit(s.players.ss2, 'HS')).toBe('alt');
  });

  it('补空位先用本职（本位置 / 副位置）替补', () => {
    const s = makeTestState(2);
    roster(s, 't0', [['c', 'C', 80], ['m', 'M', 80], ['o', 'O', 80], ['ss1', 'SS', 85], ['sub', 'SS', 70, ['HS']], ['c2', 'C', 90]]);
    autoLineup(s, 't0');
    s.teams.t0.lineup.HS = null;
    fillEmptyLineupSlots(s, 't0');
    expect(s.teams.t0.lineup.HS).toBe('sub'); // 评分更高的 c2 打五号位是非本位置
  });

  it('AI 首发优先级不受影响：使命选手仍排在本位置，其余四号位补五号位', () => {
    const s = makeTestState(3);
    addTeam(s, 'og');
    roster(s, 'og', [['ana', 'C', 70], ['topson', 'M', 70], ['ceb', 'O', 70], ['jerax', 'SS', 70], ['og-ss', 'SS', 90], ['og-ss2', 'SS', 60]]);
    expect(aiLineupPriority(s, 'og')?.get('jerax')).toBe(1);
    autoLineup(s, 'og');
    expect(s.teams.og.lineup.SS).toBe('jerax');
    expect(s.teams.og.lineup.HS).toBe('og-ss');
    expect(validateLineup(s, 'og')).toEqual([]);
  });
});

describe('真实生涯位置同步', () => {
  it('新赛季：当届有数据的真实选手切到当届真实位置；无数据保留；人类玩家战队保留首发并收到私有通知；AI 战队重排', () => {
    const s = makeTestState(3);
    s.season.ti = 7;
    s.season.year = 2017;
    // 人类玩家战队：Miposhka（旧位置四号位）在四号位首发
    const mip = putReal(s, 't0', 'miposhka', 'SS', 85);
    s.teams.t0.lineup.SS = 'miposhka';
    // AI 战队：puppey（TI6 四号位）首发四号位、本队五号位较弱
    const pup = putReal(s, 't1', 'puppey', 'SS', 95);
    s.teams.t1.lineup.SS = 'puppey';
    s.players['t1-HS'].power = 60;
    // 没有当届数据：notme（TI15 才出现）保持原位置
    const notme = putReal(s, null, 'notme', 'C', 60);
    const before = s.news.length;
    const changes = syncSeasonRoles(s);
    expect(changes.map((c) => c.playerId).sort()).toEqual(['miposhka', 'puppey']);
    expect(mip.position).toBe('HS');
    expect(mip.altPositions).toEqual(['SS']);
    expect(pup.position).toBe('HS');
    expect(notme.position).toBe('C');
    expect(notme.altPositions).toBeUndefined(); // 真实首届（TI15）之前没有副位置
    expect(s.teams.t0.lineup.SS).toBe('miposhka'); // 人类玩家的首发不动（副位置 ×0.95）
    expect(s.teams.t1.lineup.HS).toBe('puppey'); // AI 重新排阵
    const mine = s.news.slice(0, s.news.length - before).find((n) => n.teamIds?.includes('t0'));
    expect(mine?.title).toBe('【位置调整】miposhka 转型为五号位（真实生涯）');
    expect(mine?.visibility).toBe('private');
    expect(mine?.body).toContain('目前首发四号位（副位置 ×0.95）');
    // 总览「通知」也有一条（新闻列表里容易被淹没）
    expect(s.popups.filter((x) => x.kind === 'message' && x.title === mine?.title).length).toBe(1);
    // 幂等：同一赛季再同步没有变化
    expect(syncSeasonRoles(s)).toEqual([]);
  });

  it('赛季中途创建的真实选手用当届真实位置（不是首次出现时的位置）', () => {
    const s = makeTestState(2);
    s.season.ti = 8;
    s.season.year = 2018;
    const entry = getPlayerIndex().find((e) => e.id === 'miposhka')!;
    expect(entry.position).toBe('SS'); // 首次出现（TI6）时是四号位
    const p = rookieFromIndex(s, entry);
    expect(p.position).toBe('HS');
    expect(p.altPositions).toEqual(['SS']);
    const seeded = playerFromSeed(s, { ...readRosterSync(10).teams.find((t) => t.id === 'team-spirit')!.players.find((x) => x.id === 'mira')! }, null);
    expect(seeded.position).toBe('SS');
    expect(seeded.altPositions).toBeUndefined();
  });

  it('新俱乐部签回本局中从未出现过的当届真实选手：用当届真实位置与截至当届的副位置（不是首次出现时的位置）', () => {
    const s = makeTestState(16);
    s.settings.startTi = 8;
    s.settings.endTi = 16;
    s.season = { ...s.season, ti: 9, year: 2019 };
    for (const t of Object.values(s.teams)) t.gold = 2_000_000;
    expect(s.players.god).toBeUndefined();
    withConfig('clubs', { fictionalChance: 0 }, () => foundSeasonClubs(s));
    const spirit = s.teams['team-spirit'];
    expect(spirit).toBeTruthy();
    const god = s.players.god;
    expect(god?.teamId).toBe('team-spirit');
    expect(getPlayerIndex().find((e) => e.id === 'god')?.position).toBe('C'); // 首次出现（TI2）时是一号位
    expect(god.position).toBe('M');
    expect(god.altPositions).toEqual(['C']);
    for (const pid of spirit.playerIds) {
      const p = s.players[pid];
      if (!p?.isReal || !realRoleHistory(pid)) continue;
      expect(p.position, pid).toBe(realRoleExactAt(pid, 9) ?? realRoleFor(pid, 9));
      expect(p.altPositions ?? [], pid).toEqual(realAltPositions(pid, p.position, 9));
    }
  });

  it('新游戏：真实选手按开局届位置创建并带副位置，无需迁移', async () => {
    const g = await createNewGame({ startTi: 10, seasons: 2, difficulty: 'normal', managerName: 'T', teamId: 'team-spirit', seed: 5 });
    expect(g.roleDataVersion).toBe(ROLE_DATA_VERSION);
    expect(g.players.miposhka.position).toBe('HS');
    expect(g.players.miposhka.altPositions).toEqual(['SS']);
    expect(g.players.n0tail.altPositions).toEqual(['C', 'SS']); // 截至 TI10 担任过的位置
    expect(g.players.torontotokyo.altPositions).toBeUndefined(); // TI12 起才打五号位：TI10 没有副位置
    expect(g.players.yatoro.altPositions).toBeUndefined();
    expect(migrateRealRoles(g)).toBeNull();
  });
});

describe('旧存档迁移（读档 / 多人房间）', () => {
  /** 用户的旧存档：TI15 的 Spirit，Mira / Miposhka / rue / notme 全是四号位 */
  function oldSpiritSave(): GameState {
    const s = makeTestState(3);
    s.season.ti = 15;
    s.season.year = 2026;
    roster(s, 't0', [['yatoro', 'C', 90], ['larl', 'M', 88], ['collapse', 'O', 88]]);
    for (const id of ['mira', 'miposhka', 'rue', 'notme']) putReal(s, 't0', id, 'SS', id === 'notme' ? 78 : 84);
    for (const id of ['yatoro', 'larl', 'collapse']) s.players[id].isReal = true;
    s.teams.t0.lineup = { C: 'yatoro', M: 'larl', O: 'collapse', SS: 'mira', HS: 'miposhka' };
    delete s.roleDataVersion;
    return s;
  }

  it('Spirit 4 名四号位 → Miposhka / rue 五号位，阵容可以全部按本位置排出；只迁移一次', () => {
    const loaded = importSave(exportSave(oldSpiritSave()));
    expect(loaded.roleDataVersion).toBe(ROLE_DATA_VERSION);
    const P = loaded.players;
    expect(P.miposhka.position).toBe('HS');
    expect(P.rue.position).toBe('HS');
    expect(P.mira.position).toBe('SS');
    expect(P.notme.position).toBe('SS');
    expect(P.rue.altPositions).toEqual(['SS']);
    expect(uncoveredPositions(['yatoro', 'larl', 'collapse', 'mira', 'miposhka', 'rue', 'notme'].map((id) => P[id]))).toEqual([]);
    // 人类玩家的首发不动：Miposhka 本来就在五号位首发，现在是本位置
    expect(loaded.teams.t0.lineup.HS).toBe('miposhka');
    expect(roleFit(P.miposhka, 'HS')).toBe('main');
    const news = loaded.news.find((n) => n.title.startsWith('【位置修正】'));
    expect(news?.teamIds).toEqual(['t0']);
    expect(news?.body).toContain('miposhka 改为五号位（原四号位，仍可打四号位）');
    autoLineup(loaded, 't0');
    for (const pos of POSITIONS) expect(roleFit(P[loaded.teams.t0.lineup[pos]!], pos), pos).toBe('main');
    // 再次读档不重复迁移 / 发新闻
    const again = importSave(exportSave(loaded));
    expect(again.news.filter((n) => n.title.startsWith('【位置修正】')).length).toBe(1);
  });

  it('「继续游戏」（IndexedDB 中的进度对象，不经过 JSON 导入）同样迁移，并在总览「通知」提示', () => {
    const s = oldSpiritSave();
    const g = upgradeLoadedState(s);
    expect(g.roleDataVersion).toBe(ROLE_DATA_VERSION);
    expect(g.players.miposhka.position).toBe('HS');
    expect(g.players.rue.position).toBe('HS');
    expect(g.popups.filter((x) => x.kind === 'message' && x.title.startsWith('【位置修正】')).length).toBe(1);
    // 幂等：再次继续不重复迁移
    upgradeLoadedState(g);
    expect(g.news.filter((n) => n.title.startsWith('【位置修正】')).length).toBe(1);
    expect(g.popups.filter((x) => x.kind === 'message' && x.title.startsWith('【位置修正】')).length).toBe(1);
  });

  it('第一版迁移（副位置含未来才担任的位置）的存档：重算副位置，本位置不变时不发通知，AI 战队重排', () => {
    const s = makeTestState(3);
    s.season.ti = 10;
    s.season.year = 2020;
    const tt = putReal(s, 't1', 'torontotokyo', 'M', 95, { altPositions: ['HS', 'O'] });
    s.players['t1-M'].power = 60;
    s.teams.t1.lineup.HS = 'torontotokyo'; // 按第一版的副位置（五号位 ×0.95）首发五号位
    s.teams.t1.lineup.M = 't1-M';
    s.roleDataVersion = 1;
    const before = s.news.length;
    expect(migrateRealRoles(s)).toEqual([]);
    expect(tt.altPositions).toBeUndefined();
    expect(s.roleDataVersion).toBe(ROLE_DATA_VERSION);
    expect(s.news.length).toBe(before);
    expect(s.teams.t1.lineup.M).toBe('torontotokyo'); // AI 重排：回到本位置
  });

  it('TI14 的旧存档：Miposhka 五号位，rue 仍是四号位（TI15 才转五号位）', () => {
    const s = oldSpiritSave();
    s.season.ti = 14;
    s.season.year = 2025;
    const loaded = importSave(exportSave(s));
    expect(loaded.players.miposhka.position).toBe('HS');
    expect(loaded.players.rue.position).toBe('SS');
    expect(loaded.players.rue.altPositions).toBeUndefined(); // TI15 才打五号位：TI14 还不算副位置
    // 进入 TI15 赛季：rue 转五号位，副位置四号位
    loaded.season.ti = 15;
    loaded.season.year = 2026;
    syncSeasonRoles(loaded);
    expect(loaded.players.rue.position).toBe('HS');
    expect(loaded.players.rue.altPositions).toEqual(['SS']);
  });

  it('多人房间：载入时迁移（幂等），新闻只给对应座位', async () => {
    const g = await createMultiplayerGame({
      startTi: 14, endTi: 15, difficulty: 'normal', mode: 'existing', seed: 3,
      players: [{ sessionId: 's1', name: 'A', teamId: 'team-spirit' }, { sessionId: 's2', name: 'B', teamId: 'team-liquid' }],
    });
    expect(migrateRoomState(g)).toBe(false); // 新房间已是最新版本
    g.players.miposhka.position = 'SS';
    delete g.players.miposhka.altPositions;
    delete g.roleDataVersion;
    expect(migrateRoomState(g)).toBe(true);
    expect(g.players.miposhka.position).toBe('HS');
    expect(migrateRoomState(g)).toBe(false);
    const n = g.news.find((x) => x.title.startsWith('【位置修正】'));
    expect(n?.teamIds).toEqual(['team-spirit']);
    expect(n?.visibility).toBe('private');
    // 座位视图：只有 Spirit 的座位看得到（新闻与总览「通知」）
    expect(seatView(g, 'team-spirit').news.some((x) => x.id === n!.id)).toBe(true);
    expect(seatView(g, 'team-liquid').news.some((x) => x.id === n!.id)).toBe(false);
    const notice = (teamId: string) => seatView(g, teamId).popups.filter((x) => x.kind === 'message' && x.title === n!.title).length;
    expect(notice('team-spirit')).toBe(1);
    expect(notice('team-liquid')).toBe(0);
  });

  it('多人房间：服务器托管（autopilotSeat）前同样兜底迁移', async () => {
    const g = await createMultiplayerGame({
      startTi: 14, endTi: 15, difficulty: 'normal', mode: 'existing', seed: 4,
      players: [{ sessionId: 's1', name: 'A', teamId: 'team-spirit' }, { sessionId: 's2', name: 'B', teamId: 'team-liquid' }],
    });
    g.players.miposhka.position = 'SS';
    delete g.players.miposhka.altPositions;
    delete g.roleDataVersion;
    autopilotSeat(g, 'team-spirit');
    expect(g.roleDataVersion).toBe(ROLE_DATA_VERSION);
    expect(g.players.miposhka.position).toBe('HS');
  });
});
