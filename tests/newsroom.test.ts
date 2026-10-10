import { describe, expect, it } from 'vitest';
import type { GameState, Series, Stage, Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { addNews, inferTeamIds, newsIsMine, newsScopeOf } from '../src/engine/news';
import {
  buildRoundDigest, digestItems, headlineScore, newsroomRoundEnd, publishWeekly, reportTournamentResult,
  reportTournamentUpsets, scanFinishedTournaments, scanTierChanges, tickerHeadlines, worldHeadlines,
} from '../src/engine/newsroom';
import { makeTestState } from './helpers';

function regularState(): GameState {
  const s = makeTestState(8);
  s.phase = 'regular';
  s.roundIndex = 3;
  s.season.rounds = Array.from({ length: 21 }, (_, i) => ({
    index: i,
    phase: i === 0 ? 'preseason' : i <= 18 ? 'regular' : i === 19 ? 'ti_qualifier' : 'ti',
    startDate: '2019-01-01',
    endDate: '2019-01-08',
    tournamentIds: [],
    patchVersions: [],
  }));
  return s;
}

describe('addNews 标注', () => {
  it('旧的 5 参数调用照常工作，并自动识别战队与范围', () => {
    const s = makeTestState(4);
    const n = addNews(s, 'transfer', '【重磅转会】t2_M 从 Team t2 加盟 Team t3', '转会费 50 万。');
    expect(n.teamIds).toEqual(['t2', 't3']);
    expect(n.playerIds).toEqual(['t2-M']);
    expect(n.scope).toBe('world');
    expect(n.visibility).toBe('public');
    expect(s.news[0]).toBe(n);
  });

  it('涉及玩家战队（team.isPlayer）→ mine；只提到玩家选手也算 mine', () => {
    const s = makeTestState(4);
    expect(addNews(s, 'transfer', '【报价】Team t1 求购 t0_C', '').scope).toBe('mine');
    const ev = addNews(s, 'event', '【伤病】t0_HS 带伤作战', '战斗力 -10%');
    expect(ev.playerIds).toEqual(['t0-HS']);
    expect(ev.scope).toBe('mine');
    // 多队名单中玩家战队不是主角 → world
    expect(addNews(s, 'tournament', 'TI9 直邀名单出炉', '直邀：Team t1、Team t2、Team t0。').scope).toBe('world');
    // 多人模式：任意 isPlayer 战队都算「我的」
    s.teams.t3.isPlayer = true;
    expect(addNews(s, 'transfer', '【官宣】x 加盟 Team t3', '').scope).toBe('mine');
  });

  it('显式选项优先；玩家财务消息为 private', () => {
    const s = makeTestState(4);
    const n = addNews(s, 'season', '周报', 'Team t1 Team t2', true, { teamIds: ['t2', 'nope'], scope: 'world', tags: ['weekly'], actorTeamId: 't0' });
    expect(n.teamIds).toEqual(['t2']);
    expect(n.scope).toBe('world');
    expect(n.tags).toEqual(['weekly']);
    expect(n.actorTeamId).toBe('t0');
    const f = addNews(s, 'finance', '【赞助】新赞助商注资 10万', '首付款已到账。');
    expect(f.scope).toBe('mine');
    expect(f.visibility).toBe('private');
  });

  it('战队名识别按词边界，长名优先', () => {
    const s = makeTestState(12);
    expect(inferTeamIds(s, 'Team t10 击败 Team t1', '')).toEqual(['t10', 't1']);
    expect(inferTeamIds(s, 'Team t10 夺冠', '')).toEqual(['t10']);
  });

  it('旧存档新闻（无 scope）按类别兜底', () => {
    const s = makeTestState(4);
    expect(newsScopeOf(s, { id: 'x', season: 9, round: 1, date: '', category: 'finance', title: '工资', body: '' })).toBe('mine');
    expect(newsScopeOf(s, { id: 'y', season: 9, round: 1, date: '', category: 'patch', title: '版本 7.22', body: '' })).toBe('world');
  });

  it('超出上限时优先清理较旧的低价值新闻（逐场赛果/系统/八卦）', () => {
    const s = makeTestState(2);
    const cap = CONFIG.newsroom.maxNews;
    const keep = addNews(s, 'transfer', '【重磅转会】旧闻', '');
    for (let i = 0; i < cap / 2; i++) addNews(s, 'match', `m${i}`, '');
    for (let i = 0; i < cap / 2 + 10; i++) addNews(s, 'tournament', `t${i}`, '');
    expect(s.news.length).toBe(cap);
    expect(s.news).toContain(keep);
    expect(s.news.filter((n) => n.category === 'match').length).toBe(cap / 2 - 11);
  });

  it('新闻条数上限为 CONFIG.newsroom.maxNews，删除最旧的', () => {
    const s = makeTestState(2);
    const cap = CONFIG.newsroom.maxNews;
    for (let i = 0; i < cap + 25; i++) addNews(s, 'system', `n${i}`, '');
    expect(s.news.length).toBe(cap);
    expect(s.news[0].title).toBe(`n${cap + 24}`);
    expect(s.news[s.news.length - 1].title).toBe('n25');
  });
});

describe('回合要闻', () => {
  it('按重要度挑选 3~6 条，排除 private 与八卦，窗口只含上一期之后的新闻', () => {
    const s = regularState();
    addNews(s, 'event', '【八卦】Team t3 的 t3_C 疑似情感受挫', '');
    const champ = addNews(s, 'tournament', 'Team t2 夺得 ESL One 冠军', '', false, { tags: ['champion', 'level:major'] });
    const big = addNews(s, 'transfer', '【重磅转会】t4_M 从 Team t4 加盟 Team t5', '');
    const patch = addNews(s, 'patch', '版本 7.22 上线：测试', '');
    addNews(s, 'finance', '工资支出', '', true);
    const upset = addNews(s, 'tournament', '【爆冷】Team t7 2:0 淘汰 Team t1', '', true, { tags: ['upset', 'level:major'] });
    const d = buildRoundDigest(s);
    expect(d).not.toBeNull();
    expect(d!.items.length).toBeGreaterThanOrEqual(CONFIG.newsroom.digestMin);
    expect(d!.items.length).toBeLessThanOrEqual(CONFIG.newsroom.digestMax);
    expect([champ.id, upset.id]).toContain(d!.items[0]);
    expect(d!.items).toEqual(expect.arrayContaining([champ.id, big.id, patch.id, upset.id]));
    expect(d!.items.some((id) => s.news.find((n) => n.id === id)?.title.startsWith('【八卦】'))).toBe(false);
    expect(d!.items.some((id) => s.news.find((n) => n.id === id)?.category === 'finance')).toBe(false);
    expect(d!.title).toBe('上回合要闻 · TI9 第2回合');
    expect(digestItems(s).map((n) => n.id)).toEqual(d!.items);

    // 没有新新闻：保留上一期
    expect(buildRoundDigest(s)).toEqual(d);
    // 新窗口只含新新闻
    const next = addNews(s, 'tournament', 'Team t6 夺得 DreamLeague 冠军', '', false, { tags: ['champion', 'level:premier'] });
    const d2 = buildRoundDigest(s);
    expect(d2!.items).toEqual([next.id]);
  });

  it('同一主角战队最多 2 条；玩家自己的赛事名次只在补位时出现', () => {
    const s = regularState();
    const champ = addNews(s, 'tournament', 'Team t2 夺得 ESL One 冠军', '', true, { tags: ['champion', 'level:major'] });
    const rec = addNews(s, 'tournament', '【纪录】Team t2 豪取三连冠', '', false, { teamIds: ['t2'], tags: ['record', 'level:major'] });
    addNews(s, 'event', '【丑闻】Team t2 的 t2_C 陷入舆论风波', '');
    const other = addNews(s, 'transfer', '【重磅转会】t4_M 从 Team t4 加盟 Team t5', '');
    const myResult = addNews(s, 'tournament', 'ESL One 战罢：冠军', '', true, { teamIds: ['t0'], tags: ['result', 'level:major'] });
    const patch = addNews(s, 'patch', '版本 7.22 上线：测试', '');
    const d = buildRoundDigest(s)!;
    expect(d.items).toEqual(expect.arrayContaining([champ.id, rec.id, other.id, patch.id]));
    expect(d.items.filter((id) => s.news.find((n) => n.id === id)?.teamIds?.[0] === 't2')).toHaveLength(2);
    expect(d.items).not.toContain(myResult.id);
    // 世界上没什么大事时，玩家名次可以补位
    const r2 = addNews(s, 'tournament', 'Minor 战罢：5-8名', '', false, { teamIds: ['t0'], tags: ['result', 'level:minor'] });
    addNews(s, 'event', '【八卦】Team t3 的 t3_C 疑似情感受挫', '');
    expect(buildRoundDigest(s)!.items).toEqual([r2.id]);
  });

  it('世界动态与滚动栏：世界新闻优先、过滤私密消息', () => {
    const s = regularState();
    addNews(s, 'finance', '工资支出', '');
    const w = addNews(s, 'transfer', '【重磅转会】t4_M 从 Team t4 加盟 Team t5', '');
    addNews(s, 'event', '【八卦】Team t3 的 t3_C 疑似情感受挫', '');
    const world = worldHeadlines(s, 10);
    expect(world.map((n) => n.id)).toEqual([w.id]);
    const ticker = tickerHeadlines(s, 2);
    expect(ticker[0].id).not.toBe(s.news.find((n) => n.category === 'finance')!.id);
    expect(ticker.map((n) => n.id)).toContain(w.id);
  });
});

describe('刀塔周报', () => {
  it('实力榜升降、热门选手、标签 weekly', () => {
    const s = regularState();
    const first = publishWeekly(s, false)!;
    expect(first.tags).toEqual(['weekly']);
    expect(first.scope).toBe('world');
    expect(first.body).toContain('【实力榜】');
    // makeTestState：战力 70+i → t7 最强
    expect(first.teamIds![0]).toBe('t7');
    expect(s.newsroom?.weeklyIssue).toBe(1);

    // t0 大幅变强 → 登顶；t1_C 打出 MVP
    for (const id of s.teams.t0.playerIds) s.players[id].power = 99;
    const star = s.players['t1-C'];
    star.stats.mvp += 4;
    star.stats.wins += 6;
    star.stats.matches += 8;
    s.roundIndex = 6;
    const second = publishWeekly(s, false)!;
    expect(second.title).toContain('第2期');
    expect(second.title).toContain('Team t0 登顶实力榜');
    expect(second.body).toMatch(/1\. Team t0（实力分 \d+） ↑7/);
    expect(second.body).toContain('【热门选手】t1_C（Team t1）');
    expect(second.playerIds).toEqual(['t1-C']);
  });

  it('回合结束钩子每 weeklyEvery 个常规回合出一期', () => {
    const s = regularState();
    const every = CONFIG.newsroom.weeklyEvery;
    let issues = 0;
    for (let r = 1; r <= 18; r++) {
      s.roundIndex = r;
      newsroomRoundEnd(s);
      issues = s.news.filter((n) => n.tags?.includes('weekly')).length;
    }
    expect(issues).toBe(Math.floor(18 / every));
  });
});

describe('社区趋势与纪录', () => {
  function finish(
    s: GameState, name: string, placements: Record<string, [number, number, number]>, champ: string,
    expectedRanks?: Record<string, number>,
  ): void {
    if (expectedRanks) s.tournaments[name] = { id: name, expectedRanks } as unknown as Tournament;
    s.history.tournaments.push({ tournamentId: name, seriesId: name, name, tier: 'premier', season: 9, championId: champ, placements });
  }

  it('知名战队连续三项赛事早早出局 → 社区趋势新闻；连冠 → 纪录', () => {
    const s = regularState();
    scanFinishedTournaments(s); // 初始化游标
    const bad: [number, number, number] = [7, 8, 8];
    for (let i = 0; i < 3; i++) finish(s, `Cup${i}`, { t6: bad, t2: [1, 1, 8], t3: [2, 2, 8] }, 't2', { t6: 2, t2: 1, t3: 3 });
    scanFinishedTournaments(s);
    const trend = s.news.find((n) => n.tags?.includes('trend'));
    expect(trend?.title).toBe('Team t6 连续三项赛事早早出局，社区对阵容调整的呼声高涨');
    expect(trend?.teamIds).toEqual(['t6']);
    const records = s.news.filter((n) => n.tags?.includes('record'));
    expect(records.map((n) => n.title)).toEqual(['【纪录】Team t2 豪取三连冠', '【纪录】Team t2 豪取两连冠']);
    expect(records[0].body).toContain('这是其本赛季第 3 个冠军');
  });

  it('只报道低于预期的连续出局：缺少赛前预期/预期本就靠后不算；够条件后立即报道，之后每 slumpRepeat 项再报', () => {
    const s = regularState();
    scanFinishedTournaments(s);
    const bad: [number, number, number] = [7, 8, 8];
    // 3 项都没有赛前预期 → 不报道
    for (let i = 0; i < 3; i++) finish(s, `A${i}`, { t6: bad, t2: [1, 1, 8] }, 't2');
    scanFinishedTournaments(s);
    expect(s.news.filter((n) => n.tags?.includes('trend'))).toHaveLength(0);
    // 第 4、5 项被看好却早早出局 → 第 5 项（满足「≥ 2 项低于预期」）时立即报道，而不是等到第 7 项
    finish(s, 'A3', { t6: bad, t2: [1, 1, 8] }, 't2', { t6: 2 });
    scanFinishedTournaments(s);
    expect(s.news.filter((n) => n.tags?.includes('trend'))).toHaveLength(0);
    finish(s, 'A4', { t6: bad, t2: [1, 1, 8] }, 't2', { t6: 1 });
    scanFinishedTournaments(s);
    const trends = s.news.filter((n) => n.tags?.includes('trend'));
    expect(trends.map((n) => n.title)).toEqual(['Team t6 连续五项赛事早早出局，社区对阵容调整的呼声高涨']);
    // 预期垫底的队伍早早出局不算新闻
    for (let i = 0; i < 4; i++) finish(s, `B${i}`, { t1: bad, t2: [1, 1, 8] }, 't2', { t1: 8 });
    scanFinishedTournaments(s);
    expect(s.news.some((n) => n.tags?.includes('trend') && n.teamIds?.[0] === 't1')).toBe(false);
  });
});

describe('范围标注（玩家视角消息 / 多人座位）', () => {
  it('玩家消息只提到对手时仍为 mine（荣誉变动、待决事件、玩家赛事开赛）', () => {
    const s = makeTestState(4);
    const honor = addNews(s, 'event', '俱乐部荣誉 -6', '宿敌对决落败：不敌 Team t2，被对面粉丝刷屏嘲讽。当前荣誉 113。');
    expect(honor.teamIds).toEqual(['t2']);
    expect(honor.scope).toBe('mine');
    expect(addNews(s, 'tournament', 'Test Cup 开赛', '8 支队伍争夺 30万 奖金。赛前预期：第 3 名左右。').scope).toBe('mine');
    expect(addNews(s, 'event', '某事件', 'Team t3 发来邀请。\n（请在消息中心做出选择）').scope).toBe('mine');
    // 版本新闻里的「战力影响：」不算玩家视角
    expect(addNews(s, 'patch', '版本 7.22 上线', '改动\n战力影响：核心 +1').scope).toBe('world');
    // AI 战队之间的新闻不受影响
    expect(addNews(s, 'event', '【丑闻】Team t2 的 t2_C 陷入舆论风波', '').scope).toBe('world');
  });

  it('多人模式：newsIsMine 只算与该座位相关的消息，worldHeadlines 含其他玩家的公开动态', () => {
    const s = makeTestState(4);
    s.teams.t3.isPlayer = true; // 第二个座位
    const mineT0 = addNews(s, 'transfer', '【重磅转会】t2_M 从 Team t2 加盟 Team t0', '');
    const mineT3 = addNews(s, 'transfer', '【重磅转会】t1_M 从 Team t1 加盟 Team t3', '');
    // 当前座位 t0 的无名玩家消息：记下座位
    const seat = addNews(s, 'tournament', '出征 Test Cup', '共 8 支队伍，赛前预期：第 3 名左右。');
    expect(seat.actorTeamId).toBe('t0');
    expect(newsIsMine(s, mineT0, 't0')).toBe(true);
    expect(newsIsMine(s, mineT3, 't0')).toBe(false);
    expect(newsIsMine(s, mineT3, 't3')).toBe(true);
    expect(newsIsMine(s, seat, 't3')).toBe(false);
    const world = worldHeadlines(s, 10, 0, 't0').map((n) => n.id);
    expect(world).toContain(mineT3.id);
    expect(world).not.toContain(mineT0.id);
    // 单机（只有一个玩家战队）时与 scope 等价
    s.teams.t3.isPlayer = false;
    expect(newsIsMine(s, mineT3)).toBe(newsScopeOf(s, mineT3) === 'mine');
  });
});

describe('天梯变动', () => {
  it('升至 SSR 单独成条；首次扫描只建立快照', () => {
    const s = regularState();
    scanTierChanges(s);
    expect(s.news.length).toBe(0);
    s.players['t5-M'].mmr = CONFIG.ladder.thresholds.SSR + 100;
    s.players['t4-C'].mmr = CONFIG.ladder.thresholds.SS + 100;
    scanTierChanges(s);
    const titles = s.news.map((n) => n.title);
    expect(titles).toContain('【天梯】t5_M 天梯升至 SSR');
    expect(titles).toContain('【天梯】t4_C 天梯升至 SS');
    expect(s.news.find((n) => n.title.includes('SSR'))?.playerIds).toEqual(['t5-M']);
  });
});

describe('赛事结果新闻', () => {
  function playoffTournament(s: GameState): Tournament {
    const stage: Stage = { id: 'cup-st0', type: 'playoffs', format: 'se', name: '单败淘汰赛', teamIds: ['t1', 't2', 't6', 't7'], seriesIds: ['s1', 's2', 's3'], done: true };
    const mk = (id: string, a: string, b: string, sa: number, sb: number, round: number): Series => ({
      id, tournamentId: 'cup', stageId: stage.id, label: round === 3 ? '决赛' : round === 2 ? '半决赛' : '四分之一决赛', teamA: a, teamB: b, bestOf: 3, round,
      result: { winnerId: sa > sb ? a : b, loserId: sa > sb ? b : a, scoreA: sa, scoreB: sb, games: [] },
    });
    const t: Tournament = {
      id: 'cup', seriesId: 'cup', name: 'Test Major', tier: 'major', season: 9, roundIndex: 3, startDate: '2019-01-01', city: 'X',
      hostRegion: 'EU', online: false, prizePool: 1000000, appearanceFee: 0, format: 'se8', teamIds: ['t1', 't2', 't6', 't7'],
      invitedTeamIds: [], qualifierTeamIds: [], stages: [stage],
      series: { s1: mk('s1', 't7', 't1', 0, 2, 1), s2: mk('s2', 't6', 't2', 2, 1, 2), s3: mk('s3', 't1', 't2', 3, 1, 3) },
      status: 'finished', placements: [
        { teamId: 't1', rankFrom: 1, rankTo: 1, prize: 400000, points: 0 },
        { teamId: 't2', rankFrom: 2, rankTo: 2, prize: 200000, points: 0 },
        { teamId: 't6', rankFrom: 3, rankTo: 4, prize: 0, points: 0 },
        { teamId: 't7', rankFrom: 5, rankTo: 8, prize: 0, points: 0 },
      ],
      playerStatus: 'open', minHonor: 0, size: 8,
      expectedRanks: { t7: 1, t6: 2, t2: 6, t1: 7 },
    };
    s.tournaments.cup = t;
    return t;
  }

  it('TI 冠军：队史首冠 / 卫冕、最终排名、标签', () => {
    const run = (prevChampion: string | null) => {
      const s = regularState();
      s.season.ti = 10;
      const t = playoffTournament(s);
      Object.assign(t, { tier: 'ti', season: 10, name: 'The International 2020', seriesId: 'ti' });
      if (prevChampion) {
        s.history.tournaments.push({ tournamentId: 'ti-9', seriesId: 'ti', name: 'TI9', tier: 'ti', season: 9, championId: prevChampion, placements: {} });
      }
      s.history.tournaments.push({ tournamentId: 'cup', seriesId: 'ti', name: t.name, tier: 'ti', season: 10, championId: 't1', placements: {} });
      reportTournamentResult(s, t, { championId: 't1', runnerUpId: 't2', prize: 1000, playerInvolved: false });
      return s.news[0];
    };
    const first = run(null);
    expect(first.title).toBe('Team t1 捧起不朽盾！');
    expect(first.body).toContain('这是 Team t1 队史首个 TI 冠军。');
    expect(first.body).toContain('最终排名：亚军 Team t2');
    expect(first.tags).toEqual(expect.arrayContaining(['ti-champion', 'champion', 'level:ti']));
    const again = run('t1');
    expect(again.body).toContain('成功卫冕');
    expect(again.body).not.toContain('队史首个');
  });

  it('TI 冠军的个人夺冠次数只写职业生涯完全在本存档内的选手', () => {
    const s = regularState();
    s.season.ti = 10;
    const t = playoffTournament(s);
    Object.assign(t, { tier: 'ti', season: 10, name: 'The International 2020', seriesId: 'ti' });
    s.history.tournaments.push({ tournamentId: 'cup', seriesId: 'ti', name: t.name, tier: 'ti', season: 10, championId: 't1', placements: {} });
    const gen = s.players['t1-C'];
    const real = s.players['t1-M'];
    gen.stats.tiTitles = 2;
    real.stats.tiTitles = 2;
    real.isReal = true; // 开局（TI9）前已出道的真实选手：可能另有真实 TI 冠军，存档内的次数不完整
    reportTournamentResult(s, t, { championId: 't1', runnerUpId: 't2', prize: 1000, playerInvolved: false });
    expect(s.news[0].body).toContain('t1_C 个人第 2 次捧起不朽盾');
    expect(s.news[0].body).not.toContain('t1_M');
  });

  it('冠军新闻含决赛比分与黑马；热门出局 → 爆冷新闻', () => {
    const s = regularState();
    const t = playoffTournament(s);
    reportTournamentResult(s, t, { championId: 't1', runnerUpId: 't2', prize: 400000, playerInvolved: false });
    const champ = s.news[0];
    expect(champ.title).toBe('黑马 Team t1 夺得 Test Major 冠军');
    expect(champ.body).toContain('决赛以 3:1 击败 Team t2');
    expect(champ.tags).toEqual(expect.arrayContaining(['champion', 'level:major', 'upset']));
    expect(champ.teamIds).toEqual(['t1', 't2']);
    reportTournamentUpsets(s, t);
    const up = s.news[0];
    expect(up.tags).toContain('upset');
    expect(up.title).toBe('【爆冷】赛前热门 Team t7 止步 Test Major 5-8名');
    expect(up.body).toContain('Team t1 以 2:0 击败预期第 1 名的 Team t7');
    expect(headlineScore(s, up)).toBeGreaterThan(CONFIG.newsroom.digestMinScore);
  });
});
