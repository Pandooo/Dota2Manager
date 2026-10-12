// 第十波 #3：俱乐部使命（src/engine/missions.ts；AI 转会窗口 ai.ts / 休赛期转会潮 shuffle.ts 的使命引进与留人）
import { describe, expect, it } from 'vitest';
import type { GameState, Player, Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { seededRng } from '../src/engine/rng';
import {
  aiPursueMission, clubMissionView, isMissionPlayerOf, missionAwareTrim, missionContractRetention, missionFulfilled,
  missionInEffect, missionOf, missionProgress, missionSeasonEnd, refreshMissions,
} from '../src/engine/missions';
import { aiTransferWindow } from '../src/engine/ai';
import { offseasonShuffle } from '../src/engine/shuffle';
import { refreshFreeAgents } from '../src/engine/market';
import { addTeam, makePlayer, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';

const OG_PEAK = ['ana', 'topson', 'ceb', 'jerax', 'n0tail'];
const OG_POS = ['C', 'M', 'O', 'SS', 'HS'] as const;

/** 16 队测试联赛（t0 为玩家）+ AI 真实俱乐部 og；起始 TI8、当前 TI10 赛季初 */
function league(ti = 10): GameState {
  const s = makeTestState(16);
  s.settings.startTi = 8;
  s.settings.endTi = 16;
  s.season = { ...s.season, ti, year: 2021 };
  for (const t of Object.values(s.teams)) t.gold = 3_000_000;
  addTeam(s, 'og', { region: 'EU', power: 72, gold: 3_000_000 });
  s.teams.og.name = 'OG';
  return s;
}

function addPlayer(s: GameState, over: Partial<Player>): Player {
  const p = makePlayer({ isReal: true, contractUntil: 12, ...over });
  s.players[p.id] = p;
  if (p.teamId) s.teams[p.teamId].playerIds.push(p.id);
  return p;
}

/** OG 的 TI8 五人：i 号成员放到 where[i]（null = 自由身；'og' = 已在队） */
function placeOg(s: GameState, where: (string | null)[]): Player[] {
  return OG_PEAK.map((id, i) => addPlayer(s, { id, handle: id, position: OG_POS[i], teamId: where[i], power: 80 }));
}

/** og 的首发 = 巅峰阵容五人（各打巅峰阵容中的位置） */
function fieldPeak(s: GameState): void {
  OG_POS.forEach((pos, i) => {
    s.teams.og.lineup[pos] = OG_PEAK[i];
  });
}

describe('missions · 定义与进度', () => {
  it('AI 真实俱乐部有使命，玩家战队 / 虚构战队没有', () => {
    const s = league();
    expect(missionOf(s, 'og')?.peak.players).toEqual(OG_PEAK);
    expect(missionOf(s, 't3')).toBeNull(); // 测试战队不是真实组织
    s.teams.og.isPlayer = true;
    s.settings.playerTeamId = 'og';
    expect(missionOf(s, 'og')).toBeNull();
  });

  it('进度 k/5；集齐时发新闻一次，再次刷新不重复；新游戏第一个赛季回合 0 的初始集齐不发新闻', () => {
    const s = league();
    placeOg(s, ['og', 'og', 'og', null, 't4']);
    expect(missionProgress(s, 'og')!.have.length).toBe(3);
    expect(refreshMissions(s)).toEqual([]);
    expect(s.teams.og.mission?.have).toBe(3);
    // 补齐两人
    for (const id of ['jerax', 'n0tail']) {
      const p = s.players[id];
      if (p.teamId) s.teams[p.teamId].playerIds = s.teams[p.teamId].playerIds.filter((x) => x !== id);
      p.teamId = 'og';
      s.teams.og.playerIds.push(id);
    }
    expect(refreshMissions(s)).toEqual(['og']);
    expect(s.teams.og.mission).toMatchObject({ have: 5, firstCompletedTi: 10, completedTi: 10 });
    expect(s.news.filter((n) => n.title === '【使命】OG 集齐 TI8 巅峰阵容').length).toBe(1);
    expect(refreshMissions(s)).toEqual([]);
    expect(s.news.filter((n) => n.title === '【使命】OG 集齐 TI8 巅峰阵容').length).toBe(1);

    const q = league(8);
    placeOg(q, ['og', 'og', 'og', 'og', 'og']);
    expect(refreshMissions(q)).toEqual(['og']);
    expect(q.news.some((n) => n.title.startsWith('【使命】'))).toBe(false);
  });

  it('首次记录进度（旧存档升级）时即已集齐：只记录不发新闻；散而复聚的「再次集齐」新闻不标为重要', () => {
    const s = league();
    s.roundIndex = 5;
    s.phase = 'regular';
    placeOg(s, ['og', 'og', 'og', 'og', 'og']);
    expect(s.teams.og.mission).toBeUndefined();
    expect(refreshMissions(s)).toEqual(['og']);
    expect(s.teams.og.mission).toMatchObject({ have: 5, firstCompletedTi: 10 });
    expect(s.news.some((n) => n.title.startsWith('【使命】'))).toBe(false);
    // 拆散后重新集齐：发「再次」新闻（非重要）
    const ana = s.players.ana;
    s.teams.og.playerIds = s.teams.og.playerIds.filter((id) => id !== 'ana');
    ana.teamId = null;
    expect(refreshMissions(s)).toEqual([]);
    expect(s.teams.og.mission?.have).toBe(4);
    ana.teamId = 'og';
    s.teams.og.playerIds.push('ana');
    expect(refreshMissions(s)).toEqual(['og']);
    const news = s.news.find((n) => n.title === '【使命】OG 集齐 TI8 巅峰阵容');
    expect(news?.body).toContain('再次');
    expect(news?.important).toBe(false);
  });

  it('集齐状态下夺得 TI：记录并发新闻（新闻区分五人是否都是夺冠首发）', () => {
    const s = league();
    placeOg(s, ['og', 'og', 'og', 'og', 'og']);
    fieldPeak(s);
    const tiT = { placements: [{ teamId: 'og', rankFrom: 1, rankTo: 1 }] } as unknown as Tournament;
    expect(missionSeasonEnd(s, tiT)).toBe('og');
    expect(s.teams.og.mission?.tiTitles).toEqual([10]);
    expect(s.news.some((n) => n.title === '【使命】OG 以 TI8 巅峰阵容夺得 TI10 冠军')).toBe(true);
    // 未集齐的冠军不记
    const q = league();
    placeOg(q, ['og', 'og', 'og', 'og', null]);
    expect(missionSeasonEnd(q, tiT)).toBeNull();
    // 五人都在队，但 N0tail 坐替补席（首发是别人）：使命同样完成，新闻不说「以巅峰阵容夺得」并注明替补
    const b = league();
    placeOg(b, ['og', 'og', 'og', 'og', 'og']);
    fieldPeak(b);
    b.teams.og.lineup.HS = b.teams.og.playerIds.find((id) => !OG_PEAK.includes(id))!;
    expect(missionSeasonEnd(b, tiT)).toBe('og');
    expect(missionFulfilled(b, 'og')).toBe(true);
    expect(b.news.some((n) => n.title.includes('以 TI8 巅峰阵容夺得'))).toBe(false);
    const nb = b.news.find((n) => n.title === '【使命】集齐 TI8 巅峰阵容的 OG 夺得 TI10 冠军');
    expect(nb?.body).toContain('n0tail 担任替补');
  });

  it('使命完成（以巅峰阵容夺得 TI）后不再优先引进、不再额外留人，界面标注「使命完成」', () => {
    const s = league();
    placeOg(s, ['og', 'og', 'og', 'og', 'og']);
    fieldPeak(s);
    const tiT = { placements: [{ teamId: 'og', rankFrom: 1, rankTo: 1 }] } as unknown as Tournament;
    missionSeasonEnd(s, tiT);
    expect(missionFulfilled(s, 'og')).toBe(true);
    expect(missionInEffect(s, 'og')).toBeNull();
    expect(missionOf(s, 'og')).toBeTruthy(); // 定义仍在（展示用）
    expect(isMissionPlayerOf(s, 'ana', 'og')).toBe(false); // 不再有留人加成
    // 成员离队后也不再追回
    s.teams.og.playerIds = s.teams.og.playerIds.filter((id) => id !== 'ana');
    s.players.ana.teamId = null;
    expect(aiPursueMission(s, s.teams.og, [], 'preseason', seededRng(1))).toEqual([]);
    const v = clubMissionView(s, 'og')!;
    expect(v.fulfilled).toBe(true);
    expect(v.active).toBe(false);
    expect(v.note).toContain('使命完成');
  });

  it('DotaPedia 视图：成员去向（在队 / 其他战队 / 玩家战队 / 自由身 / 退役 / 未出道），现实成绩不剧透', () => {
    const s = league(8);
    const ps = placeOg(s, ['og', 't3', 't0', null, 'og']);
    ps[4].status = 'retired';
    s.players.n0tail.teamId = null;
    delete s.players.ana;
    s.teams.og.playerIds = s.teams.og.playerIds.filter((id) => id !== 'ana' && id !== 'n0tail');
    s.futureRookies.ana = 9;
    const v = clubMissionView(s, 'og')!;
    expect(v.active).toBe(true);
    expect(v.members.map((m) => m.status)).toEqual(['future', 'team', 'human', 'free', 'retired']);
    expect(v.members[1].teamId).toBe('t3');
    // 本局中尚未出现的成员：显示真实选手索引中的游戏 ID（而不是内部 id）
    delete s.players.topson;
    s.teams.t3.playerIds = s.teams.t3.playerIds.filter((id) => id !== 'topson');
    s.futureRookies.topson = 9;
    expect(clubMissionView(s, 'og')!.members[1]).toMatchObject({ handle: 'Topson', status: 'future' });
    expect(v.have).toBe(0);
    expect(v.resultLabel).toBeNull(); // TI8 赛季：TI8 的现实成绩尚未揭晓
    expect(v.titles).toEqual([]);
    s.season.ti = 10;
    const later = clubMissionView(s, 'og')!;
    expect(later.resultLabel).toBe('冠军');
    expect(later.titles).toEqual([8, 9]);
    // 虚构战队无使命视图；玩家执教的真实俱乐部只展示、不生效
    expect(clubMissionView(s, 't3')).toBeNull();
    s.teams.og.isPlayer = true;
    s.settings.playerTeamId = 'og';
    expect(clubMissionView(s, 'og')?.active).toBe(false);
  });
});

describe('missions · AI 优先引进与留人', () => {
  it('AI 窗口：自由身的使命成员签下、其他 AI 战队的溢价求购；人类玩家战队的成员不动', () => {
    const s = league();
    placeOg(s, [null, 't3', 't0', 'og', 'og']);
    const sellerGold = s.teams.t3.gold;
    const signed = withConfig('missions', { sellBase: 1, sellStarPenalty: 0, sellMissionPenalty: 0, maxBuys: { shuffle: 2, preseason: 3, midseason: 1 } }, () =>
      aiPursueMission(s, s.teams.og, [], 'preseason', seededRng(7)));
    expect(signed.map((p) => p.id).sort()).toEqual(['ana', 'topson']);
    expect(s.players.ana.teamId).toBe('og');
    expect(s.players.topson.teamId).toBe('og');
    expect(s.teams.t3.gold).toBeGreaterThan(sellerGold); // 溢价转会费
    expect(s.players.ceb.teamId).toBe('t0'); // 玩家战队的成员从不被带走
    expect(missionProgress(s, 'og')!.have.length).toBe(4);
    expect(s.teams.og.playerIds.length).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    expect(s.news.some((n) => n.tags?.includes('mission') && n.body.includes('使命进度'))).toBe(true);
  });

  it('每个窗口的引进上限；买不起时不出手', () => {
    const s = league();
    placeOg(s, [null, null, null, 'og', 'og']);
    const signed = withConfig('missions', { maxBuys: { shuffle: 2, preseason: 1, midseason: 1 } }, () =>
      aiPursueMission(s, s.teams.og, [], 'preseason', seededRng(3)));
    expect(signed.length).toBe(1);
    const poor = league();
    placeOg(poor, [null, 't3', null, 'og', 'og']);
    poor.teams.og.gold = 0;
    expect(aiPursueMission(poor, poor.teams.og, [], 'preseason', seededRng(3))).toEqual([]);
  });

  it('aiTransferWindow 集成：使命俱乐部引进缺失成员并刷新进度', () => {
    const s = league();
    placeOg(s, [null, null, 't0', 'og', 'og']);
    refreshFreeAgents(s);
    withConfig('ai', { preseasonUpgradeChance: 0 }, () => aiTransferWindow(s, 'preseason'));
    expect(s.players.ana.teamId).toBe('og');
    expect(s.players.ceb.teamId).toBe('t0');
    expect(s.teams.og.mission?.have).toBeGreaterThanOrEqual(3);
  });

  it('留人：裁员先放非使命替补；合同到期大概率续约；被挖角时 AI 窗口不放走使命成员', () => {
    const s = league();
    placeOg(s, ['og', 'og', 'og', 'og', 'og']); // og 现有 5 名测试队员 + 5 名使命成员 = 10 人
    const released = missionAwareTrim(s, 'og', 7);
    expect(released.length).toBe(3);
    expect(released.every((p) => !OG_PEAK.includes(p.id))).toBe(true);
    for (const id of OG_PEAK) expect(isMissionPlayerOf(s, id, 'og')).toBe(true);

    s.players.ana.contractUntil = 10;
    withConfig('missions', { renewChance: 1 }, () => missionContractRetention(s));
    expect(s.players.ana.contractUntil).toBeGreaterThan(10);
  });

  it('休赛期转会潮：使命俱乐部从其他 AI 战队引进使命成员（reason mission），同位置的非使命首发被顶下', () => {
    const s = league();
    placeOg(s, ['t5', 'og', 'og', 'og', 'og']);
    refreshMissions(s); // 上一个窗口结束时的进度 4/5
    refreshFreeAgents(s);
    const rep = withConfig('missions', { sellBase: 1, sellStarPenalty: 0, sellMissionPenalty: 0 }, () => offseasonShuffle(s))!;
    expect(rep).toBeTruthy();
    expect(s.players.ana.teamId).toBe('og');
    const move = rep.moves.find((m) => m.playerId === 'ana' && m.reason === 'mission');
    expect(move?.fromTeamId).toBe('t5');
    expect(s.teams.og.lineup.C).toBe('ana');
    // 进度在紧随其后的 AI 季前窗口结束时刷新（season.startSeason：转会潮 → aiTransferWindow）
    expect(s.teams.og.mission?.have).toBe(4);
    withConfig('ai', { preseasonUpgradeChance: 0 }, () => aiTransferWindow(s, 'preseason', { upgrades: false }));
    expect(s.teams.og.mission?.have).toBe(5);
    expect(s.news.filter((n) => n.title === '【使命】OG 集齐 TI8 巅峰阵容').length).toBe(1);
  });

  it('休赛期转会潮：玩家战队里的使命成员只会收到报价（玩家决定），不会被直接带走', () => {
    const s = league();
    placeOg(s, ['t0', 'og', 'og', 'og', 'og']);
    refreshFreeAgents(s);
    withConfig('missions', { humanOfferChance: 1 }, () => offseasonShuffle(s));
    expect(s.players.ana.teamId).toBe('t0');
    const offer = s.transferOffers.find((o) => o.playerId === 'ana' && o.fromTeamId === 'og');
    expect(offer?.status).toBe('pending');
    expect(s.news.some((n) => n.title === '【报价】OG 求购 ana' && n.body.includes('由你决定'))).toBe(true);
  });

  it('关闭使命（CONFIG.missions.enabled = false）：不引进、不刷新', () => {
    const s = league();
    placeOg(s, [null, null, null, 'og', 'og']);
    withConfig('missions', { enabled: false }, () => {
      expect(missionOf(s, 'og')).toBeNull();
      expect(aiPursueMission(s, s.teams.og, [], 'preseason', seededRng(1))).toEqual([]);
      expect(refreshMissions(s)).toEqual([]);
    });
    expect(s.players.ana.teamId).toBeNull();
  });
});
