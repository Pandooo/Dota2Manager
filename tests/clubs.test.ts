// 第十波 #2：新俱乐部涌现（src/engine/clubs.ts + src/data/clubIndex.json）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Player } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import {
  clubOrg, clubOrgs, foundSeasonClubs, leagueSize, leagueSizeRange, orgAppAt, orgOfTeamId, pendingRealClubs, realOrgOf,
  signFoundedClubRookies,
} from '../src/engine/clubs';
import { buildClubIndex } from '../scripts/build-club-index';
import { getTrajectory } from '../src/data/index';
import { ROSTER_DIR, readRosterSync, registerNodeRosterLoader } from '../scripts/nodeData';
import { advance, createNewGame } from '../src/engine/game';
import { activeTeams } from '../src/engine/team';
import { refreshMissions } from '../src/engine/missions';
import { addTeam, makePlayer, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 16 队测试联赛（t0 为玩家），起始 TI8、当前 TI9 赛季初 */
function league(teamCount = 16, ti = 9, startTi = 8): GameState {
  const s = makeTestState(teamCount);
  s.settings.startTi = startTi;
  s.settings.endTi = 16;
  s.season = { ...s.season, ti };
  for (const t of Object.values(s.teams)) t.gold = 2_000_000;
  return s;
}

function addPlayer(s: GameState, over: Partial<Player>): Player {
  const p = makePlayer(over);
  s.players[p.id] = p;
  if (p.teamId) s.teams[p.teamId].playerIds.push(p.id);
  return p;
}

describe('clubIndex · 真实俱乐部索引', () => {
  it('巅峰阵容：OG 取 TI8/TI9 同一套夺冠五人（TI8），Spirit 取 TI10，LGD 系各名称归入同一组织', () => {
    const og = orgOfTeamId('og')!;
    expect(og.peak?.ti).toBe(8);
    expect(og.peak?.players).toEqual(['ana', 'topson', 'ceb', 'jerax', 'n0tail']);
    expect(og.peak?.titles).toEqual([8, 9]);
    const spirit = orgOfTeamId('team-spirit')!;
    expect(spirit.first).toBe(9);
    expect(spirit.peak?.ti).toBe(10);
    expect(spirit.peak?.players).toEqual(['yatoro', 'torontotokyo', 'collapse', 'mira', 'miposhka']);
    expect(orgOfTeamId('psg-lgd')).toBe(orgOfTeamId('lgd-gaming'));
    expect(orgOfTeamId('g2-ig')).toBe(orgOfTeamId('invictus-gaming'));
    expect(orgOfTeamId('nigma-galaxy')).toBe(orgOfTeamId('team-nigma'));
    // 未夺冠：最好名次（Secret TI11 亚军）
    expect(orgOfTeamId('team-secret')?.peak).toMatchObject({ ti: 11, result: '2' });
  });

  it('每个组织：首次出现 = 最早一届，巅峰阵容 5 名不同选手且来自该组织的某一届', () => {
    for (const o of clubOrgs()) {
      expect(o.first).toBe(Math.min(...o.apps.map((a) => a.ti)));
      if (!o.peak) continue;
      expect(new Set(o.peak.players).size).toBe(5);
      const app = orgAppAt(o, o.peak.ti);
      expect(app, o.id).toBeTruthy();
      expect(app!.players.slice(0, 5)).toEqual(o.peak.players);
    }
  });

  it('clubIndex.json 与 rosters / legacyClubs / branding 一致（数据变动后需重新运行 scripts/build-club-index.ts）', () => {
    const tis = Array.from({ length: 15 }, (_, i) => i + 1).filter((ti) => existsSync(join(ROSTER_DIR, `ti${ti}.json`)));
    const legacy = JSON.parse(readFileSync(join(ROSTER_DIR, '..', 'legacyClubs.json'), 'utf8')).clubs;
    const brandingPath = join(ROSTER_DIR, '..', 'branding.json');
    const branding = existsSync(brandingPath) ? JSON.parse(readFileSync(brandingPath, 'utf8')).orgs ?? [] : [];
    const built = buildClubIndex(tis.map((ti) => readRosterSync(ti)), legacy, branding);
    const committed = JSON.parse(readFileSync(join(ROSTER_DIR, '..', 'clubIndex.json'), 'utf8')).orgs;
    expect(JSON.parse(JSON.stringify(built))).toEqual(committed);
  });
});

describe('clubs · 赛季初成立真实俱乐部', () => {
  it('在现实首次出现的赛季成立（Spirit：TI9），之前的赛季不成立；新游戏第一个赛季不执行；同一赛季只执行一次', () => {
    const early = league(16, 8, 7);
    withConfig('clubs', { fictionalChance: 0 }, () => foundSeasonClubs(early));
    expect(early.teams['team-spirit']).toBeUndefined();

    const first = league(16, 9, 9);
    expect(foundSeasonClubs(first)).toBeNull();
    expect(first.teams['team-spirit']).toBeUndefined();

    const s = league(16, 9, 8);
    const rep = withConfig('clubs', { fictionalChance: 0 }, () => foundSeasonClubs(s))!;
    const spirit = s.teams['team-spirit'];
    expect(spirit).toBeTruthy();
    expect(spirit.founded).toEqual({ ti: 9, kind: 'real', orgId: 'team-spirit' });
    expect(spirit.name).toBe('Team Spirit');
    expect(spirit.honor).toBe(orgAppAt(clubOrg('team-spirit')!, 9)!.honor);
    expect(spirit.isPlayer).toBe(false);
    expect(rep.founded.length).toBeLessThanOrEqual(CONFIG.clubs.maxRealPerSeason);
    expect(rep.founded.map((f) => f.teamId)).toContain('team-spirit');
    expect(s.news.some((n) => n.title === '【新战队】Team Spirit 成立')).toBe(true);
    // 新俱乐部至少 5 人、5 个首发都有人
    expect(spirit.playerIds.length).toBeGreaterThanOrEqual(CONFIG.ai.minRoster);
    expect(Object.values(spirit.lineup).every((x) => !!x)).toBe(true);
    // 同一赛季再次调用不再成立
    const n = Object.keys(s.teams).length;
    expect(foundSeasonClubs(s)).toBeNull();
    expect(Object.keys(s.teams).length).toBe(n);
    // 已成立的组织不再是候选
    expect(pendingRealClubs(s, 9).some((o) => o.id === 'team-spirit')).toBe(false);
  });

  it('签回当届真实选手：自由身直接签、AI 战队的选手付费求购（卖家收到转会费）、人类玩家战队的选手不动', () => {
    const s = league();
    // Spirit TI9 名单：illidan / god / 633 / velheor / vanskor
    const fa = addPlayer(s, { id: 'illidan', handle: 'Illidan', position: 'C', isReal: true });
    const ai = addPlayer(s, { id: 'god', handle: 'God', position: 'M', teamId: 't3', isReal: true });
    const human = addPlayer(s, { id: '633', handle: '633', position: 'O', teamId: 't0', isReal: true });
    const fa2 = addPlayer(s, { id: 'velheor', handle: 'Velheor', position: 'SS', isReal: true });
    const sellerGold = s.teams.t3.gold;
    const rep = withConfig('clubs', { fictionalChance: 0, sellChance: 1, sellStarPenalty: 0, sellMissionPenalty: 0 }, () => foundSeasonClubs(s))!;
    const info = rep.founded.find((f) => f.teamId === 'team-spirit')!;
    expect(fa.teamId).toBe('team-spirit');
    expect(fa2.teamId).toBe('team-spirit');
    expect(ai.teamId).toBe('team-spirit');
    expect(s.teams.t3.gold).toBeGreaterThan(sellerGold); // 卖家收到转会费
    expect(s.teams.t3.playerIds.filter((id) => s.players[id]?.teamId === 't3').length).toBeGreaterThanOrEqual(CONFIG.ai.minRoster);
    expect(human.teamId).toBe('t0'); // 从不动人类玩家战队的选手
    expect(s.teams.t0.playerIds).toContain('633');
    // vanskor 不在本局（未出现过）→ 按当届水平加入后签下
    expect(info.signed.sort()).toEqual(['god', 'illidan', 'vanskor', 'velheor']);
    expect(info.skippedHuman).toEqual(['633']);
    expect(s.news.find((n) => n.title === '【新战队】Team Spirit 成立')?.body).toContain('目前效力于玩家战队');
  });

  it('本局中从未出现过的当届真实选手（不在开局届名单、也不是待登场新秀）按当届真实水平加入并签下', () => {
    const s = league();
    expect(s.players.god).toBeUndefined();
    s.futureRookies.vanskor = 12; // 待登场的不动（只是测试构造）
    withConfig('clubs', { fictionalChance: 0 }, () => foundSeasonClubs(s));
    const god = s.players.god;
    expect(god?.teamId).toBe('team-spirit');
    expect(god.isReal).toBe(true);
    expect(god.power).toBe(getTrajectory('god')![9].power);
    expect(god.mmr).toBe(getTrajectory('god')![9].mmr);
    expect(s.players.vanskor).toBeUndefined();
  });

  it('卖家可以拒绝：放人概率为 0 时 AI 战队的选手留队', () => {
    const s = league();
    const ai = addPlayer(s, { id: 'god', handle: 'God', position: 'M', teamId: 't3', isReal: true });
    withConfig('clubs', { fictionalChance: 0, sellChance: 0 }, () => foundSeasonClubs(s));
    expect(s.teams['team-spirit']).toBeTruthy();
    expect(ai.teamId).toBe('t3');
  });

  it('选秀之后签回本届登场的真实新秀（AI 选中的付费求购、人类玩家选中的不动）', () => {
    const s = league(16, 10, 9);
    withConfig('clubs', { fictionalChance: 0 }, () => foundSeasonClubs(s));
    const spirit = s.teams['team-spirit'];
    expect(spirit?.founded?.ti).toBe(10);
    // 选秀后阵容已满（补位的自由选手 + 选中的新秀）
    while (spirit.playerIds.length < CONFIG.ai.maxRoster) addPlayer(s, { handle: `Filler${spirit.playerIds.length}`, teamId: 'team-spirit', power: 70 });
    const fillers = spirit.playerIds.slice();
    // 模拟选秀：yatoro 被 AI 战队 t5 选中、collapse 被玩家选中
    const yatoro = addPlayer(s, { id: 'yatoro', handle: 'Yatoro', position: 'C', teamId: 't5', isReal: true, isRookie: true, power: 78 });
    const collapse = addPlayer(s, { id: 'collapse', handle: 'Collapse', position: 'O', teamId: 't0', isReal: true, isRookie: true });
    const signed = withConfig('clubs', { sellChance: 1, sellStarPenalty: 0, sellMissionPenalty: 0 }, () => signFoundedClubRookies(s));
    expect(signed).toContain('yatoro');
    expect(yatoro.teamId).toBe('team-spirit');
    expect(collapse.teamId).toBe('t0');
    // 当届真实选手优先于补位队员：放走一名补位队员腾出名额，阵容不超过 AI 上限
    expect(spirit.playerIds.length).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    expect(fillers.some((id) => s.players[id].teamId !== 'team-spirit')).toBe(true);
  });

  it('联赛已满：为重要的真实俱乐部解散一支过气的 AI 俱乐部腾位，规模不超过上限；人类玩家战队不会被解散', () => {
    const { max } = leagueSizeRange();
    const s = league(max);
    s.teams.t0.honor = 10; // 玩家战队最弱、荣誉最低，也不能被解散
    for (const p of Object.values(s.players)) if (p.teamId === 't0') p.power = 40;
    expect(leagueSize(s)).toBe(max);
    const rep = withConfig('clubs', { fictionalChance: 0 }, () => foundSeasonClubs(s))!;
    expect(leagueSize(s)).toBeLessThanOrEqual(max);
    expect(rep.retired.length).toBeGreaterThan(0);
    expect(rep.retired.length).toBeLessThanOrEqual(CONFIG.clubs.maxRetirePerSeason);
    expect(rep.retired).not.toContain('t0');
    expect(s.teams.t0.disbanded).toBeFalsy();
    for (const id of rep.retired) {
      expect(s.teams[id].disbanded).toBe(true);
      expect(s.teams[id].playerIds.length).toBe(0);
      expect(s.news.some((n) => n.title === `【解散】${s.teams[id].name} 宣布解散`)).toBe(true);
    }
    expect(s.teams['team-spirit']?.founded?.ti).toBe(9);
    // 成立数 ≤ 解散数（满员时只能等额替换）
    expect(rep.founded.length).toBeLessThanOrEqual(rep.retired.length);
  });

  it('多人模式：任一座位战队（含未标 isPlayer 的）的当届真实选手都不动', () => {
    const s = league();
    s.settings.playerTeamId = '';
    s.teams.t1.isPlayer = true;
    const seat = (teamId: string) => ({ teamId, sessionId: teamId, name: teamId, eliminated: false, ready: false, saved: {} });
    s.multiplayer = { mode: 'build', hostTeamId: 't0', order: ['t0', 't1', 't2'], seats: { t0: seat('t0'), t1: seat('t1'), t2: seat('t2') }, activeSeat: null } as unknown as GameState['multiplayer'];
    const a = addPlayer(s, { id: 'illidan', handle: 'Illidan', position: 'C', teamId: 't1', isReal: true });
    const b = addPlayer(s, { id: 'god', handle: 'God', position: 'M', teamId: 't2', isReal: true }); // 座位战队，isPlayer 未设
    const c = addPlayer(s, { id: '633', handle: '633', position: 'O', teamId: 't3', isReal: true });
    const rep = withConfig('clubs', { fictionalChance: 0, sellChance: 1, sellStarPenalty: 0, sellMissionPenalty: 0 }, () => foundSeasonClubs(s))!;
    const info = rep.founded.find((f) => f.teamId === 'team-spirit')!;
    expect(a.teamId).toBe('t1');
    expect(b.teamId).toBe('t2');
    expect(c.teamId).toBe('team-spirit');
    expect(info.skippedHuman.sort()).toEqual(['god', 'illidan']);
    // 联赛已满时腾位也不会解散座位战队
    for (const id of rep.retired) expect(['t0', 't1', 't2']).not.toContain(id);
  });

  it('成立时即已集齐巅峰阵容（巅峰就是当届阵容）：使命进度从成立时记起，只记录不发「集齐」新闻', () => {
    const s = league();
    withConfig('clubs', { fictionalChance: 0, maxRealPerSeason: 20 }, () => foundSeasonClubs(s));
    const founded = activeTeams(s).filter((t) => t.founded?.kind === 'real');
    expect(founded.length).toBeGreaterThan(1);
    let completeAtFounding = 0;
    for (const t of founded) {
      const org = clubOrg(t.founded!.orgId)!;
      if (!org.peak) continue;
      const have = org.peak.players.filter((id) => s.players[id]?.teamId === t.id).length;
      expect(t.mission?.have, t.id).toBe(have);
      if (have === 5) {
        completeAtFounding++;
        expect(t.mission).toMatchObject({ firstCompletedTi: 9, completedTi: 9 });
      }
    }
    expect(completeAtFounding).toBeGreaterThan(0);
    refreshMissions(s);
    expect(s.news.some((n) => n.title.startsWith('【使命】'))).toBe(false);
  });

  it('虚构新组织：按概率偶尔成立（联赛未满），阵容补齐', () => {
    const s = league();
    const rep = withConfig('clubs', { fictionalChance: 1, maxRealPerSeason: 0 }, () => foundSeasonClubs(s))!;
    const fic = rep.founded.filter((f) => f.kind === 'fictional');
    expect(fic.length).toBe(1);
    const team = s.teams[fic[0].teamId];
    expect(team.founded).toEqual({ ti: 9, kind: 'fictional' });
    expect(realOrgOf(s, team.id)).toBeUndefined();
    expect(team.playerIds.length).toBeGreaterThanOrEqual(CONFIG.ai.minRoster);
    expect(s.news.some((n) => n.title === `【新战队】${team.name} 成立`)).toBe(true);
    expect(s.clubFounding?.founded).toEqual([{ ti: 9, teamId: team.id, kind: 'fictional' }]);
  });
});

describe('clubs · 集成：新游戏中途成立', () => {
  it('TI8 开局推进到 TI9 赛季初：Spirit 等真实俱乐部成立，联赛规模在目标区间内，没有从人类玩家战队带走选手', async () => {
    const s = await createNewGame({
      startTi: 8, seasons: 3, difficulty: 'normal', managerName: 'T', seed: 4242,
      newClub: { name: 'Club Test', tag: 'CT', region: 'CN', color: '#ffffff' },
    });
    const me = s.settings.playerTeamId;
    const { min, max } = leagueSizeRange();
    expect(s.teams['team-spirit']).toBeUndefined();
    let before = new Map<string, string | null>();
    for (let i = 0; i < 400 && s.season.ti === 8 && !s.gameOver; i++) {
      s.teams[me].gold = Math.max(s.teams[me].gold, 5_000_000);
      before = new Map(Object.values(s.players).map((p) => [p.id, p.teamId]));
      const r = advance(s, { auto: true });
      expect(r.ok || !!s.gameOver).toBe(true);
    }
    expect(s.season.ti).toBe(9);
    const spirit = s.teams['team-spirit'];
    expect(spirit?.founded?.ti).toBe(9);
    expect(s.news.some((n) => n.title === '【新战队】Team Spirit 成立' && n.season === 9)).toBe(true);
    const size = activeTeams(s).length;
    expect(size).toBeGreaterThanOrEqual(min);
    expect(size).toBeLessThanOrEqual(max);
    // 本赛季成立的俱乐部：队员此前都不在人类玩家战队
    for (const t of activeTeams(s)) {
      if (t.founded?.ti !== 9) continue;
      for (const pid of t.playerIds) expect(before.get(pid) ?? null).not.toBe(me);
    }
  }, 60_000);

  it('多赛季（TI11 起 4 季）：每个赛季初联赛规模都在目标区间内，成立的真实俱乐部从成立起就记录使命进度', async () => {
    const s = await createNewGame({
      startTi: 11, seasons: 4, difficulty: 'normal', managerName: 'T', seed: 777,
      newClub: { name: 'Club Test', tag: 'CT', region: 'EU', color: '#ffffff' },
    });
    const me = s.settings.playerTeamId;
    const { min, max } = leagueSizeRange();
    const sizes: number[] = [];
    let ti = s.season.ti;
    for (let i = 0; i < 2000 && !s.gameOver; i++) {
      s.teams[me].gold = Math.max(s.teams[me].gold, 5_000_000);
      const r = advance(s, { auto: true });
      expect(r.ok || !!s.gameOver).toBe(true);
      if (s.season.ti !== ti) {
        ti = s.season.ti;
        sizes.push(activeTeams(s).length);
        for (const t of activeTeams(s)) {
          if (t.founded?.kind === 'real' && clubOrg(t.founded.orgId)?.peak) expect(t.mission, t.id).toBeTruthy();
        }
      }
    }
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const n of sizes) {
      expect(n).toBeGreaterThanOrEqual(min);
      expect(n).toBeLessThanOrEqual(max);
    }
    expect((s.clubFounding?.founded ?? []).length).toBeGreaterThan(0);
  }, 120_000);
});
