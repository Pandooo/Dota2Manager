// DotaPedia 查询（src/engine/pedia.ts）：开局前（现实）成就、实时历史地位排序、战队 / 选手页与 Player.stats / 赛事史一致、
// 总览排行榜、赛事 / 英雄 / 搜索、旧存档、多人模式座位视图
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Series } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { forfeitResult, simulateGame } from '../src/engine/match';
import { recordSeriesStats } from '../src/engine/stats';
import { computeLegacyReport, legacyClubs } from '../src/engine/legacy';
import {
  majorSeasonOf, pediaDashboard, pediaHeroStats, pediaHeroTrend, pediaLegacyBoard, pediaPlayerPage,
  pediaPlayerStanding, pediaPreGameOf, pediaSearch, pediaSeasons, pediaTeamLegacy, pediaTeamPage, pediaTiChampions,
  pediaTournament, pediaTournaments,
} from '../src/engine/pedia';
import { getAllTiInfo, getTournamentTemplates } from '../src/data/index';
import tiResults from '../src/data/tiResults.json';
import * as M from '../src/engine/multi';

beforeAll(() => {
  registerNodeRosterLoader();
});

async function runGame(opts: { startTi: number; seasons: number; teamId: string; seed: number }): Promise<GameState> {
  const g = await createNewGame({ startTi: opts.startTi, seasons: opts.seasons, difficulty: 'easy', managerName: 'T', teamId: opts.teamId, seed: opts.seed });
  for (let step = 0; step < 6000 && !g.gameOver; step++) {
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

let G: GameState;
beforeAll(async () => {
  G = await runGame({ startTi: 9, seasons: 2, teamId: 'og', seed: 17 });
}, 120000);

describe('pedia · 开局前（现实）', () => {
  it('tiResults.json 与 tis.json 的冠亚军一致', () => {
    const tis = (tiResults as unknown as { tis: Record<string, [string, string, string, string[]][]> }).tis;
    for (const info of getAllTiInfo()) {
      if (info.projected || !info.champion) continue;
      const rows = tis[String(info.ti)];
      expect(rows, `TI${info.ti}`).toBeTruthy();
      expect(rows.find((r) => r[2] === '1')?.[0]).toBe(info.champion);
      if (info.runnerUp) expect(rows.find((r) => r[2] === '2')?.[0]).toBe(info.runnerUp);
      for (const r of rows) expect(r[3].length).toBeLessThanOrEqual(5);
    }
  });

  it('Valve Major 名称 → 所在赛季（按同年赛事模板匹配）', () => {
    expect(majorSeasonOf('Frankfurt Major 2015')).toBe(6);
    expect(majorSeasonOf('Manila Major 2016')).toBe(6);
    expect(majorSeasonOf('Boston Major 2016')).toBe(7);
    expect(majorSeasonOf('The Kuala Lumpur Major 2018')).toBe(9);
    expect(majorSeasonOf('DreamLeague Season 13 Leipzig Major 2020')).toBe(10);
    for (const c of legacyClubs()) {
      for (const name of c.majorList) {
        const s = majorSeasonOf(name);
        expect(s, name).toBeGreaterThan(0);
        // 匹配到的赛季确有同年的 Major 级赛事模板
        const year = Number(/(19|20)\d\d$/.exec(name)?.[0]);
        expect(getTournamentTemplates(s).some((t) => t.tier === 'major' && Number(t.startDate.slice(0, 4)) === year), name).toBe(true);
      }
    }
  });

  it('战队开局前成就：只含起始 TI 之前，同组织合并（PSG.LGD = LGD Gaming）', () => {
    const og = pediaPreGameOf(9, 'og')!;
    expect(og.stats.tiTitles).toEqual([8]);
    expect(og.tiResults.map((r) => r.ti)).toEqual([6, 7, 8]); // TI6 9-12 名、TI7 7-8 名、TI8 冠军
    expect(og.majors.map((m) => m.ti)).toEqual([6, 6, 7, 7]);
    expect(og.title.id).toBe('single');
    expect(og.summary).toContain('TI8');
    expect(pediaPreGameOf(8, 'og')!.stats.tiTitles).toEqual([]);
    expect(pediaPreGameOf(1, 'og')).toBeNull();
    expect(pediaPreGameOf(9, 'club-unknown')).toBeNull();
    const lgd = pediaPreGameOf(9, 'psg-lgd')!;
    expect(lgd.stats.tiRunnerUp).toEqual([8]);
    expect(lgd.tiResults.some((r) => r.ti === 2 && r.rankFrom === 3)).toBe(true);
    expect(lgd.majors.length).toBe(2); // EPICENTER XL 2018 / MDL Changsha 2018（TI8 赛季）
    const spirit = pediaPreGameOf(16, 'team-spirit')!;
    expect(spirit.stats.tiTitles).toEqual([10, 12, 15]);
    expect(spirit.title.id).toBe('triple');
  });

  it('历史俱乐部的 teamIds 覆盖全部改名 / 冠名战队：按 tiResults.json 合并后的 TI 履历与参照表完全一致（G2.iG = Invictus Gaming）', () => {
    const tis = (tiResults as unknown as { tis: Record<string, [string, string, string, string[]][]> }).tis;
    for (const c of legacyClubs()) {
      const best = new Map<number, number>();
      for (const [k, rows] of Object.entries(tis)) {
        for (const r of rows) {
          if (!c.teamIds.includes(r[0])) continue;
          const from = Number(r[2].split('-')[0]);
          best.set(Number(k), Math.min(best.get(Number(k)) ?? 99, from));
        }
      }
      const list = (lo: number, hi: number) => [...best].filter(([, f]) => f >= lo && f <= hi).map(([t]) => t).sort((x, y) => x - y);
      expect(best.size, c.id).toBe(c.tiAppearances);
      expect(list(1, 1), c.id).toEqual(c.tiTitles);
      expect(list(2, 2), c.id).toEqual(c.tiRunnerUp);
      expect(list(3, 4), c.id).toEqual(c.tiTop4);
      expect(list(5, 8), c.id).toEqual(c.tiTop8);
    }
    const ig = pediaPreGameOf(13, 'g2-ig')!;
    expect(ig.clubId).toBe('invictus-gaming');
    expect(ig.stats.tiTitles).toEqual([2]);
    expect(ig.title.id).toBe('single');
  });
});

describe('pedia · 实时历史地位', () => {
  it('开局第一回合：真实豪门按现实成就定位（不必等结束）', async () => {
    const g = await createNewGame({ startTi: 9, seasons: 3, difficulty: 'normal', managerName: 'T', teamId: 'og', seed: 3 });
    const board = pediaLegacyBoard(g);
    expect(board.length).toBeGreaterThan(20);
    const champs = board.filter((r) => (r.preGame?.stats.tiTitles.length ?? 0) > 0);
    expect(champs.length).toBeGreaterThanOrEqual(6);
    // 前 6 名都是开局前的 TI 冠军；所有 TI 冠军都排在没有任何现实履历的战队之前
    for (const r of board.slice(0, 6)) expect(r.preGame?.stats.tiTitles.length ?? 0).toBeGreaterThan(0);
    const worstChamp = Math.max(...champs.map((r) => r.rank));
    for (const r of board.filter((x) => !x.preGame)) expect(r.rank).toBeGreaterThan(worstChamp);
    // 排名单调、与总数一致；历史排行榜名次合理
    board.forEach((r, i) => {
      expect(r.rank).toBe(i + 1);
      expect(r.total).toBe(board.length);
      if (i > 0) expect(board[i - 1].score).toBeGreaterThanOrEqual(r.score);
      expect(r.historyRank).toBeGreaterThanOrEqual(1);
      expect(r.historyRank).toBeLessThanOrEqual(r.historySize);
    });
    const og = pediaTeamLegacy(g, 'og')!;
    expect(og.title.id).toBe('single');
    expect(og.preGameScore).toBeGreaterThan(150);
    expect(og.match).not.toBeNull();
    // 开局前的一句话不剧透：OG 的现实一句话（TI8–TI9 两连冠）含起始 TI 之后的成绩 → 不显示；现实履历早已结束的 EHOME（最后一次 TI6）照常显示
    expect(og.preGame?.highlight).toBeNull();
    expect(og.preGame?.tiResults.every((r) => r.ti < 9)).toBe(true);
    const ehome = pediaTeamLegacy(g, 'ehome');
    expect(ehome?.preGame?.highlight).toBe(legacyClubs().find((c) => c.id === 'ehome')!.highlight);
    // 真实俱乐部不与自己的现实条目比较：最接近的历史俱乐部不是自己，历史排行榜去掉自己的现实条目
    const clubs = legacyClubs().length;
    for (const r of board) {
      const own = legacyClubs().find((c) => c.teamIds.includes(r.teamId));
      if (own) {
        expect(r.match?.clubId, r.teamId).not.toBe(own.id);
        expect(r.historySize).toBe(clubs);
      } else expect(r.historySize).toBe(clubs + 1);
    }
    // 两冠以上的现实俱乐部（如 TI9 时还没有）：Na'Vi 有 TI1 冠军 + 两次亚军，应位列前三
    expect(pediaTeamLegacy(g, 'natus-vincere')!.rank).toBeLessThanOrEqual(3);
  });

  it('本局成就计入：TI 冠军的本局传奇值 ≥ 一座不朽盾；人类战队的本局部分与结算页一致', () => {
    const tiChamp = G.history.tournaments.find((h) => h.tier === 'ti' && h.season === 9)!.championId;
    const l = pediaTeamLegacy(G, tiChamp)!;
    expect(l.inGameStats.tiTitles).toContain(9);
    expect(l.inGameScore).toBeGreaterThanOrEqual(CONFIG.legacy.tiTitle);
    expect(l.stats.tiTitles).toContain(9);
    const me = G.settings.playerTeamId;
    expect(pediaTeamLegacy(G, me)!.inGameScore).toBe(computeLegacyReport(G, me).score.total);
    // 选手历史地位：有排名、称号
    const top = pediaPlayerStanding(G, G.teams[tiChamp].lineup.C as string);
    if (top) {
      expect(top.rank).toBeGreaterThanOrEqual(1);
      expect(top.title.length).toBeGreaterThan(0);
    }
  });
});

describe('pedia · 战队页 / 选手页', () => {
  it('战队页：合计 = 分赛季之和，冠军 / 名次 = 赛事史，阵容与教练', () => {
    for (const id of Object.keys(G.teams)) {
      const p = pediaTeamPage(G, id)!;
      expect(p).not.toBeNull();
      const sum = p.seasons.reduce((a, s) => [a[0] + s.seriesWins, a[1] + s.seriesDraws, a[2] + s.seriesLosses, a[3] + s.gameWins, a[4] + s.gameLosses],
        [0, 0, 0, 0, 0]);
      expect(sum).toEqual([p.totals.seriesWins, p.totals.seriesDraws, p.totals.seriesLosses, p.totals.gameWins, p.totals.gameLosses]);
      const hist = G.history.tournaments.filter((h) => h.championId === id && h.tier !== 'qualifier');
      expect(p.titles.total).toBe(hist.length);
      expect(p.placements.length).toBe(G.history.tournaments.filter((h) => !!h.placements[id]).length);
      expect(p.tiResults.length).toBe(G.history.tournaments.filter((h) => h.tier === 'ti' && !!h.placements[id]).length);
    }
    const og = pediaTeamPage(G, 'og')!;
    expect(og.status).toBe('active');
    expect(og.human).toBe(true);
    // 阵容 = 本队名单（不含野外替补）。懒人驱动不签人：赛季结算后有人退役时可能不满 5 人
    const ogRegular = G.teams.og.playerIds.filter((pid) => {
      const p = G.players[pid];
      return !!p && p.teamId === 'og' && !p.isWildSub;
    });
    expect(og.roster.length).toBe(ogRegular.length);
    expect(og.roster.length).toBeGreaterThanOrEqual(3);
    // 游戏结束于赛季结算之后：退役者已离队，首发可能不满 5 人
    expect(og.roster.filter((r) => r.starter).length).toBeGreaterThanOrEqual(3);
    expect(og.roster.filter((r) => r.starter).length).toBeLessThanOrEqual(5);
    expect(og.seasons.filter((s) => !s.partial)).toHaveLength(2);
    for (const s of og.seasons) {
      expect(s.roster.length).toBeGreaterThanOrEqual(5);
      expect(s.strengthRank).toBeGreaterThanOrEqual(1);
    }
    expect(og.preGame?.stats.tiTitles).toEqual([8]);
    expect(og.coaches.length).toBeGreaterThanOrEqual(1);
    expect(og.totals.avgDuration).toBeGreaterThan(20);
    expect(og.legacy?.summary).toContain('传奇值');
    expect(og.players[0].games).toBeGreaterThan(50);
    expect(pediaTeamPage(G, 'no-such-team')).toBeNull();
  });

  it('选手页：生涯合计与 Player.stats 一致，战队履历、成就（本局 + 开局前真实 TI）、英雄', () => {
    let checked = 0;
    for (const [id, p] of Object.entries(G.players)) {
      if (p.isWildSub) continue;
      const page = pediaPlayerPage(G, id)!;
      expect(page.totals.games).toBe(p.stats.matches);
      expect(page.totals.wins).toBe(p.stats.wins);
      expect(page.totals.mvps).toBe(p.stats.mvp);
      expect(page.achievements.titles.length).toBe(p.stats.titles);
      expect(page.achievements.tiTitles.filter((t) => !t.real).length).toBe(p.stats.tiTitles);
      if (p.stats.matches > 0) {
        expect(page.seasons.reduce((a, s) => a + s.games, 0)).toBe(p.stats.matches);
        expect(page.heroes.reduce((a, h) => a + h.games, 0) + (page.heroOther?.games ?? 0)).toBe(p.stats.matches);
        expect(page.teams.length).toBeGreaterThan(0);
        expect(page.totals.kda).toBeGreaterThan(0);
        checked++;
      }
      if (p.teamId && !p.tempSubUntilTournament) expect(page.teams.some((t) => t.teamId === p.teamId)).toBe(true);
    }
    expect(checked).toBeGreaterThan(150);
    // 开局前的真实 TI：N0tail（TI8 OG 冠军）
    const n0 = pediaPlayerPage(G, 'n0tail')!;
    expect(n0.preGame?.tiResults.some((r) => r.ti === 8 && r.rankFrom === 1 && r.teamId === 'og')).toBe(true);
    expect(n0.achievements.tiTitles.some((t) => t.real && t.ti === 8)).toBe(true);
    expect(n0.achievements.titleCounts.ti).toBe(G.players.n0tail.stats.tiTitles); // 本局口径
    expect(n0.standing?.title).toBeTruthy();
    expect(n0.peakTier).not.toBeNull();
    expect(pediaPlayerPage(G, 'no-such-player')).toBeNull();
  });
});

describe('pedia · 总览 / 赛事 / 英雄 / 搜索', () => {
  it('总览：排行榜按数值降序、遵守门槛；赛季筛选；TI 冠军含开局前现实', () => {
    const d = pediaDashboard(G);
    expect(d.overview.complete).toBe(true);
    expect(d.overview.games).toBe(G.pedia!.seq);
    expect(d.overview.seasonsRecorded).toBe(2);
    const ids = d.boards.map((b) => b.id);
    for (const id of ['teamTitles', 'playerKda', 'playerMvp', 'playerWinRate', 'playerKills', 'playerPrize', 'teamWinRate', 'teamPrize', 'playerStreak', 'teamStreak', 'heroPicks', 'heroWinRate']) {
      expect(ids).toContain(id);
    }
    for (const b of d.boards) {
      expect(b.rows.length).toBeGreaterThan(0);
      expect(b.rows.length).toBeLessThanOrEqual(CONFIG.pedia.boardRows);
      if (b.id !== 'teamTitles') for (let i = 1; i < b.rows.length; i++) expect(b.rows[i - 1].value).toBeGreaterThanOrEqual(b.rows[i].value);
    }
    const kda = d.boards.find((b) => b.id === 'playerKda')!;
    for (const r of kda.rows) expect(pediaPlayerPage(G, r.id)!.totals.games).toBeGreaterThanOrEqual(CONFIG.pedia.minGames);
    expect(d.records.length).toBeGreaterThanOrEqual(6);
    expect(d.legacy.length).toBeGreaterThan(0);
    // TI 冠军：TI1–TI8 为现实，TI9 / TI10 为本局
    const champs = pediaTiChampions(G);
    expect(champs.filter((c) => c.real).map((c) => c.ti).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(champs.filter((c) => !c.real).map((c) => c.ti).sort()).toEqual([10, 9]);
    // 赛季筛选
    expect(pediaSeasons(G)).toEqual([10, 9]);
    const d9 = pediaDashboard(G, { ti: 9 });
    expect(d9.ti).toBe(9);
    expect(d9.boards.some((b) => b.id === 'playerStreak')).toBe(false);
    const mvp9 = d9.boards.find((b) => b.id === 'playerMvp')!.rows[0];
    const mvpAll = d.boards.find((b) => b.id === 'playerMvp')!.rows[0];
    expect(mvp9.value).toBeLessThanOrEqual(mvpAll.value);
  });

  it('赛事列表 / 详情：TI 全部正赛队伍的首发、前四名奖金', () => {
    const list = pediaTournaments(G);
    expect(list.filter((r) => r.status === 'finished').length).toBe(G.history.tournaments.length);
    const ti = pediaTournaments(G, { tier: 'ti' });
    expect(ti.map((r) => r.season).sort()).toEqual([10, 9]);
    const page = pediaTournament(G, ti[0].id)!;
    expect(page.placements[0].rankFrom).toBe(1);
    expect(page.placements[0].teamId).toBe(page.championId);
    for (const pl of page.placements) expect(pl.lineup?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(page.placements[0].prize?.[0] ?? 0).toBeGreaterThan(0);
    expect(pediaTournament(G, 'no-such')).toBeNull();
  });

  it('英雄：每局 10 个英雄、出场率 ≤ 1、胜率与分赛季数据一致', () => {
    for (const ti of [9, 10]) {
      const rows = pediaHeroStats(G, { ti });
      const games = G.pedia!.seasons[String(ti)][0];
      expect(rows.reduce((a, r) => a + r.picks, 0)).toBe(games * 10);
      for (const r of rows) {
        expect(r.pickRate).toBeLessThanOrEqual(1);
        expect(r.wins).toBeLessThanOrEqual(r.picks);
      }
    }
    const all = pediaHeroStats(G);
    const trend = pediaHeroTrend(G, all[0].heroId);
    expect(trend.reduce((a, t) => a + t.picks, 0)).toBe(all[0].picks);
    expect(all[0].cn).not.toBe(all[0].heroId);
  });

  it('搜索 / 单局后查询刷新（不存逐局明细）', () => {
    expect(pediaSearch(G, 'OG')[0]).toMatchObject({ kind: 'team', id: 'og' });
    expect(pediaSearch(G, 'n0tail').some((h) => h.kind === 'player' && h.id === 'n0tail')).toBe(true);
    const hero = pediaHeroStats(G)[0];
    expect(pediaSearch(G, hero.cn).some((h) => h.kind === 'hero' && h.id === hero.heroId)).toBe(true);
    expect(pediaSearch(G, 'The International').some((h) => h.kind === 'tournament')).toBe(true);
    expect(pediaSearch(G, '')).toEqual([]);
    const s = JSON.parse(JSON.stringify(G)) as GameState;
    const ids = Object.values(s.teams).filter((t) => !t.disbanded && !t.isPlayer).map((t) => t.id);
    const g = simulateGame(s, { teamA: ids[0], teamB: ids[1], gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    expect('box' in g).toBe(false);
    // 缓存失效：多一局后总览随之更新（击杀合计 = 本局比分）
    const before = pediaDashboard(G).overview;
    const after = pediaDashboard(s).overview;
    expect(after.games).toBe(before.games + 1);
    expect(after.kills - before.kills).toBe(g.killsA + g.killsB);
  });

  it('旧存档（无统计）：查询不报错，从下一局开始记录', () => {
    const s = JSON.parse(JSON.stringify(G)) as GameState;
    delete s.pedia;
    const d = pediaDashboard(s);
    expect(d.overview.games).toBe(0);
    expect(d.tiChampions.length).toBeGreaterThan(8); // 赛事史仍在
    expect(pediaTeamPage(s, 'og')!.titles.total).toBe(pediaTeamPage(G, 'og')!.titles.total);
    expect(pediaPlayerPage(s, 'n0tail')!.totals.games).toBe(0);
    const ids = Object.values(s.teams).filter((t) => !t.disbanded && !t.isPlayer).map((t) => t.id);
    simulateGame(s, { teamA: ids[0], teamB: ids[1], gameIndex: 0, draft: null, withLive: false, tier: 'premier' });
    const after = pediaDashboard(s).overview;
    expect(after.games).toBe(1);
    expect(after.since.ti).toBe(s.season.ti);
    expect(after.complete).toBe(false);
  });
});

describe('pedia · 查询缓存', () => {
  it('不产生对局的写入（弃权系列赛）与回合内的世界变化（荣誉、转会等）立即反映在查询结果中', () => {
    const s = JSON.parse(JSON.stringify(G)) as GameState;
    const [a, b] = Object.values(s.teams).filter((t) => !t.disbanded && !t.isPlayer).map((t) => t.id);
    const before = pediaTeamPage(s, a)!.totals.seriesLosses;
    const lb = pediaTeamLegacy(s, a)!;
    const t = Object.values(s.tournaments).find((x) => x.season === s.season.ti) ?? Object.values(s.tournaments)[0];
    const series = { id: 'x', teamA: a, teamB: b, bestOf: 3 } as unknown as Series;
    recordSeriesStats(s, t, series, forfeitResult(series, 'A'), false);
    expect(pediaTeamPage(s, a)!.totals.seriesLosses).toBe(before + 1);
    // 事件 / 转会等回合内操作（分配 id）后荣誉峰值更新
    s.teams[a].honor = (lb.stats.honorPeak ?? 0) + 500;
    s.idCounter += 1;
    expect(pediaTeamLegacy(s, a)!.stats.honorPeak).toBe(Math.round(s.teams[a].honor));
  });
});

describe('pedia · 多人模式', () => {
  it('统计是全局公开数据：每个座位视图都含完整统计且一致', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 5,
      players: [
        { sessionId: 's-0', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-1', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    for (let r = 0; r < 4; r++) {
      for (let pass = 0; pass < 3; pass++) {
        for (const id of M.activeHumanIds(g)) {
          for (let i = 0; i < 20; i++) {
            const d = M.withSeat(g, id, () => g.pendingDecisions[0]);
            if (!d) break;
            M.callAsSeat(g, id, 'resolveDecision', [d.id, d.choices[0]?.id ?? '']);
          }
          M.callAsSeat(g, id, 'quickSimTournament', []);
        }
      }
      for (const id of M.activeHumanIds(g)) M.setSeatReady(g, id, true);
      M.advanceMultiplayer(g);
    }
    expect(g.pedia?.seq ?? 0).toBeGreaterThan(50);
    const [a, b] = g.multiplayer!.order;
    const va = M.seatView(g, a);
    const vb = M.seatView(g, b);
    expect(JSON.stringify(va.pedia)).toBe(JSON.stringify(g.pedia));
    expect(JSON.stringify(vb.pedia)).toBe(JSON.stringify(g.pedia));
    // 视图中各自的战队页可用；对方战队同样可查
    expect(pediaTeamPage(va, b)!.human).toBe(true);
    expect(pediaDashboard(vb).overview.games).toBe(g.pedia!.seq);
    const share = JSON.stringify(va.pedia).length / JSON.stringify(va).length;
    expect(share).toBeLessThan(0.2);
  }, 120000);
});
