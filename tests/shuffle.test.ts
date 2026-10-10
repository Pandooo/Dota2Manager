import { describe, expect, it } from 'vitest';
import type { GameState, Player, Tournament } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { seededRng } from '../src/engine/rng';
import { refreshFreeAgents } from '../src/engine/market';
import { lastSeasonSatisfaction, offseasonLeaveRequests, offseasonShuffle } from '../src/engine/shuffle';
import { makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';

const UNDER = 't14'; // 第二强，上赛季大幅低于预期
const CHAMP = 't13'; // 第三强，上赛季 TI 冠军

/** 16 队联赛（t0 为玩家），TI10 赛季初（起始 TI9），带上赛季 TI 记录 */
function buildLeague(seed = 1): GameState {
  const s = makeTestState(16, seed);
  s.settings.startTi = 9;
  s.settings.endTi = 12;
  s.season = { ...s.season, ti: 10, year: 2021, startDate: '2019-09-01', tiStartDate: '2021-10-07' };
  s.currentDate = '2019-09-01';
  const rng = seededRng(seed * 7919);
  for (const p of Object.values(s.players)) {
    p.power = Math.round((p.power + rng.range(-4, 4)) * 10) / 10;
    p.mmr = 7000 + rng.int(0, 4500);
    p.birthYear = 1992 + rng.int(0, 9);
    p.joinedSeason = 9 - rng.int(0, 2);
    p.loyalty = 40 + rng.int(0, 50);
    p.salary = 4000;
  }
  for (const t of Object.values(s.teams)) {
    const i = Number(t.id.slice(1));
    t.honor = 200 + i * 60;
    t.gold = 2_000_000;
  }
  // 战力序：t15 > t14 > t13 > …；上赛季排名：大体按战力，UNDER 跌到第 14，CHAMP 第 1
  const order = Object.keys(s.teams).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const finish = order.filter((id) => id !== UNDER && id !== CHAMP);
  finish.unshift(CHAMP);
  finish.splice(13, 0, UNDER);
  finish.forEach((id, i) => {
    s.teams[id].lastSeasonRank = i + 1;
  });
  // 上赛季 TI：16 队，赛前预期按战力
  const placements: Record<string, [number, number, number]> = {};
  const expectedRanks: Record<string, number> = {};
  order.forEach((id, i) => {
    expectedRanks[id] = i + 1;
  });
  finish.forEach((id, i) => {
    placements[id] = [i + 1, i + 1, 16];
  });
  s.tournaments['ti-9'] = { id: 'ti-9', season: 9, tier: 'ti', status: 'finished', expectedRanks } as unknown as Tournament;
  s.history.tournaments.push({
    tournamentId: 'ti-9', seriesId: 'ti', name: 'The International 2019', tier: 'ti', season: 9, championId: CHAMP, placements,
  });
  refreshFreeAgents(s);
  return s;
}

function regular(s: GameState, teamId: string): Player[] {
  return s.teams[teamId].playerIds
    .map((id) => s.players[id])
    .filter((p) => p && p.status === 'active' && !p.tempSubUntilTournament);
}

function expectValidAiRosters(s: GameState): void {
  for (const t of Object.values(s.teams)) {
    if (t.isPlayer || t.disbanded) continue;
    const ps = regular(s, t.id);
    expect(ps.length, `${t.id} roster`).toBeGreaterThanOrEqual(CONFIG.ai.minRoster);
    expect(ps.length, `${t.id} roster`).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    const ids = POSITIONS.map((pos) => t.lineup[pos]);
    expect(ids.every((id) => !!id), `${t.id} lineup`).toBe(true);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(s.players[id!].teamId).toBe(t.id);
    expect(new Set(ps.map((p) => p.position)).size, `${t.id} natural positions`).toBe(5);
    for (const p of ps) expect(p.teamId).toBe(t.id);
  }
}

function lineupOf(s: GameState, teamId: string): string[] {
  return POSITIONS.map((pos) => s.teams[teamId].lineup[pos]).filter((x): x is string => !!x);
}

describe('offseasonShuffle', () => {
  it('新游戏第一个赛季不触发（保留真实初始阵容）', () => {
    const s = buildLeague(3);
    s.season.ti = 9;
    const before = JSON.stringify(s.teams);
    expect(offseasonShuffle(s)).toBeNull();
    expect(JSON.stringify(s.teams)).toBe(before);
  });

  it('满意度：大幅低于预期的队为负，TI 冠军为正', () => {
    const s = buildLeague(4);
    const sat = lastSeasonSatisfaction(s);
    expect(sat.get(UNDER)!).toBeLessThan(-0.3);
    expect(sat.get(CHAMP)!).toBeGreaterThan(0.3);
  });

  it('AI 阵容始终合法（5~7 人、五个本职位置、首发 5 人不重复），玩家阵容不被直接改动', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = buildLeague(seed);
      const human = s.teams.t0.playerIds.slice();
      const report = offseasonShuffle(s);
      expect(report).not.toBeNull();
      expect(report!.moves.length).toBeGreaterThan(0);
      expectValidAiRosters(s);
      expect(s.teams.t0.playerIds).toEqual(human);
      for (const m of report!.moves) {
        expect(m.toTeamId).not.toBe('t0');
        expect(m.fromTeamId).not.toBe('t0');
      }
    }
  });

  it('成绩不达预期的队换人明显多于卫冕冠军', () => {
    let under = 0;
    let champ = 0;
    const runs = 24;
    for (let seed = 1; seed <= runs; seed++) {
      const s = buildLeague(seed);
      const u0 = lineupOf(s, UNDER);
      const c0 = lineupOf(s, CHAMP);
      offseasonShuffle(s);
      under += u0.filter((id) => !lineupOf(s, UNDER).includes(id)).length;
      champ += c0.filter((id) => !lineupOf(s, CHAMP).includes(id)).length;
    }
    expect(under / runs).toBeGreaterThan(1);
    expect(champ / runs).toBeLessThan(under / runs - 0.4);
  });

  it('新闻：休赛期传闻（日期早于赛季开始）+ 知名转会 + 转会汇总', () => {
    const s = buildLeague(5);
    const report = offseasonShuffle(s)!;
    const rumors = s.news.filter((n) => n.title.startsWith('【传闻】'));
    expect(rumors.length).toBe(report.rumors);
    expect(rumors.length).toBeGreaterThan(0);
    for (const n of rumors) expect(n.date < s.season.startDate).toBe(true);
    const summary = s.news.find((n) => n.title === '【转会窗口】本届休赛期转会汇总');
    expect(summary).toBeTruthy();
    expect(summary!.important).toBe(true);
    expect(summary!.category).toBe('transfer');
    for (const m of report.moves) expect(summary!.body).toContain(m.handle);
    expect(s.news.filter((n) => n.category === 'transfer' && /^【(转会|签约|新秀|离队)】/.test(n.title)).length)
      .toBeLessThanOrEqual(CONFIG.shuffle.maxMoveNews);
  });

  it('同一种子结果可复现', () => {
    const a = offseasonShuffle(buildLeague(9))!;
    const b = offseasonShuffle(buildLeague(9))!;
    expect(a.moves).toEqual(b.moves);
  });

  it('转会费在 AI 之间流动：联盟 AI 总资金不增加', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const s = buildLeague(seed);
      const total = () => Object.values(s.teams).filter((t) => !t.isPlayer).reduce((a, t) => a + t.gold, 0);
      const before = total();
      const report = offseasonShuffle(s)!;
      expect(total()).toBeLessThanOrEqual(before);
      for (const m of report.moves) if (m.kind === 'transfer') expect(m.fee).toBeGreaterThanOrEqual(0);
    }
  });

  it('玩家战队只会收到报价 / 离队申请，不会被直接搬走选手', () => {
    withConfig('shuffle', { humanOfferChance: 1, humanLeaveChance: 1, humanLeaveLoyalty: 101, ambitionMinGap: -1 }, () => {
      const s = buildLeague(11);
      const human = s.teams.t0.playerIds.slice();
      const report = offseasonShuffle(s)!;
      expect(s.teams.t0.playerIds).toEqual(human);
      const offers = s.transferOffers.filter((o) => o.status === 'pending' && o.toTeamId === 't0');
      expect(offers.length).toBe(report.humanOffers);
      expect(offers.length).toBeGreaterThan(0);
      expect(offers.length).toBeLessThanOrEqual(CONFIG.shuffle.humanMaxOffers);
      for (const o of offers) {
        expect(s.teams[o.fromTeamId].isPlayer).toBe(false);
        expect(o.fee).toBeGreaterThan(0);
      }
      const leave = s.pendingDecisions.filter((d) => d.kind === 'leave_request');
      expect(leave.length).toBe(report.humanLeaveRequests);
      expect(leave.length).toBe(1);
      expect(leave[0].choices.map((c) => c.id)).toEqual(['raise', 'persuade', 'allow']);
      expect(s.players[String(leave[0].ctx.playerId)].teamId).toBe('t0');
    });
  });

  it('罕见事件：资金见底的 AI 战队解散，新组织接手核心，战队总数不变', () => {
    withConfig('shuffle', { disbandChance: 1 }, () => {
      const s = buildLeague(12);
      s.teams.t3.gold = -50_000_000;
      const core = regular(s, 't3').map((p) => p.id);
      const activeBefore = Object.values(s.teams).filter((t) => !t.disbanded).length;
      const report = offseasonShuffle(s)!;
      expect(report.disbandedTeamId).toBe('t3');
      expect(s.teams.t3.disbanded).toBe(true);
      expect(s.teams.t3.playerIds).toEqual([]);
      const org = s.teams[report.newTeamId!];
      expect(org).toBeTruthy();
      expect(org.isPlayer).toBe(false);
      expect(org.lastSeasonRank).toBe(s.teams.t3.lastSeasonRank);
      const inherited = org.playerIds.filter((id) => core.includes(id));
      expect(inherited.length).toBeGreaterThanOrEqual(CONFIG.shuffle.disbandCoreCount[0]);
      expect(Object.values(s.teams).filter((t) => !t.disbanded).length).toBe(activeBefore);
      expect(s.news.some((n) => n.title.includes('【解散】'))).toBe(true);
      expectValidAiRosters(s);
    });
  });
  it('本窗口刚引进的选手不会再被替换 / 解约；每名选手至多加盟一次；解约后又加盟新队的只发加盟新闻', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = buildLeague(seed);
      const report = offseasonShuffle(s)!;
      const joins = new Map<string, number>();
      report.moves.forEach((m, i) => {
        if (m.kind === 'release') {
          const joinedHere = report.moves
            .slice(0, i)
            .some((x) => x.playerId === m.playerId && x.kind !== 'release' && x.toTeamId === m.fromTeamId);
          expect(joinedHere, `${m.handle} 刚加盟 ${m.fromTeamId} 就被解约`).toBe(false);
        } else if (m.toTeamId) {
          joins.set(m.playerId, (joins.get(m.playerId) ?? 0) + 1);
        }
      });
      for (const [id, n] of joins) expect(n, `${id} 加盟次数`).toBe(1);
      for (const m of report.moves) {
        if (m.kind !== 'release' || !joins.has(m.playerId)) continue;
        expect(s.news.some((n) => n.title === `【离队】${m.handle} 离开 ${s.teams[m.fromTeamId!].name}`)).toBe(false);
      }
    }
  });

  it('争冠队 / 卫冕冠军的主动换人计划至多 1 人', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = buildLeague(seed);
      const sat = lastSeasonSatisfaction(s);
      const report = offseasonShuffle(s)!;
      for (const t of report.teams) {
        const contender = t.rank <= CONFIG.shuffle.contenderRank && (sat.get(t.teamId) ?? -1) >= 0;
        if (contender || t.teamId === CHAMP) expect(t.planned, t.teamId).toBeLessThanOrEqual(1);
      }
    }
  });

  it('强队明星可横向转投其他一线战队（寻求新挑战），老将下放只去更弱的队', () => {
    withConfig('shuffle', { challengeBase: 1, challengeLoyalMult: 1, challengeChampionMult: 1, veteranStepDownChance: 1 }, () => {
      let lateral = 0;
      let veterans = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const s = buildLeague(seed);
        const report = offseasonShuffle(s)!;
        const rank = new Map(report.teams.map((t) => [t.teamId, t.rank]));
        for (const m of report.moves) {
          if (m.kind !== 'transfer' || !m.fromTeamId || !m.toTeamId) continue;
          const from = rank.get(m.fromTeamId)!;
          const to = rank.get(m.toTeamId)!;
          if (m.reason === 'challenge') {
            expect(from).toBeLessThanOrEqual(CONFIG.shuffle.challengeTopRank);
            expect(to).toBeLessThanOrEqual(Math.max(from - 1, CONFIG.shuffle.challengeBuyerRank));
            if (to > from) lateral++;
          } else if (m.reason === 'veteran') {
            expect(to, `${m.handle} ${m.fromTeamId}→${m.toTeamId}`).toBeGreaterThan(from);
            veterans++;
          }
        }
        expectValidAiRosters(s);
      }
      expect(lateral).toBeGreaterThan(0);
      expect(veterans).toBeGreaterThan(0);
    });
  });

  it('离队申请按座位生成：每座位每赛季至多 1 份，其他玩家战队可在自己的上下文中调用', () => {
    withConfig('shuffle', { humanLeaveChance: 1, humanLeaveLoyalty: 101, ambitionMinGap: -1 }, () => {
      const s = buildLeague(13);
      s.teams.t1.isPlayer = true; // 第二个人类座位
      const t1Roster = s.teams.t1.playerIds.slice();
      const report = offseasonShuffle(s)!;
      expect(report.humanLeaveRequests).toBe(1);
      expect(s.teams.t1.playerIds).toEqual(t1Roster);
      expect(offseasonLeaveRequests(s)).toBe(0);
      // 模拟座位切换：换出 t0 的私有待决事件，换入 t1
      const t0Decisions = s.pendingDecisions;
      s.pendingDecisions = [];
      s.settings.playerTeamId = 't1';
      expect(offseasonLeaveRequests(s)).toBe(1);
      const d = s.pendingDecisions[0];
      expect(d.kind).toBe('leave_request');
      expect(s.players[String(d.ctx.playerId)].teamId).toBe('t1');
      expect(t0Decisions.every((x) => s.players[String(x.ctx.playerId)].teamId === 't0')).toBe(true);
      // 常规赛回合不生成
      s.pendingDecisions = [];
      s.roundIndex = 3;
      s.phase = 'regular';
      expect(offseasonLeaveRequests(s)).toBe(0);
    });
  });
});
