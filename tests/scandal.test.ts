// 俱乐部全员假赛（src/engine/scandal.ts，第八波 #6）：每队每赛季 0.1% 掷骰、禁赛效果、AI 补位维持联赛规模、
// 单机玩家俱乐部被禁赛 → 游戏结束、多人模式座位出局（观战）而游戏继续
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import {
  banClub, bannedHumanTeamIds, clubScandalRoll, clubScandalState, fireDueClubScandals, isClubBanned, rollClubScandals,
} from '../src/engine/scandal';
import { activeTeams } from '../src/engine/team';
import { freeAgents } from '../src/engine/market';
import { advance, createNewGame, fillLineupWithTempSubs, getAdvanceBlockers, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import * as M from '../src/engine/multi';
import { makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const cfg = CONFIG.scandal as { clubBanChancePerSeason: number };
const baseChance = cfg.clubBanChancePerSeason;
afterEach(() => {
  cfg.clubBanChancePerSeason = baseChance;
});

/** 单机推进一步：待决事件选第一项，赛事快速模拟 */
function step(g: GameState): OpResult {
  for (let i = 0; i < 20 && g.pendingDecisions.length; i++) {
    const d = g.pendingDecisions[0];
    if (!resolveDecision(g, d.id, d.choices[0]?.id ?? '').ok) g.pendingDecisions.shift();
  }
  for (let i = 0; i < 5; i++) {
    const bl = getAdvanceBlockers(g);
    if (!bl.length) break;
    if (bl.some((b) => b.code === 'lineup_invalid')) fillLineupWithTempSubs(g);
    quickSimTournament(g);
  }
  return advance(g);
}

describe('scandal · 每队每赛季掷骰', () => {
  it('用户确认的概率：每队每赛季 0.1%', () => {
    expect(baseChance).toBe(0.001);
  });

  it('统计：命中率 ≈ 0.1%，曝光回合均匀落在常规赛回合内', () => {
    const N = 400_000;
    const R = 18;
    let hits = 0;
    const byRound = new Array(R + 1).fill(0);
    for (let i = 0; i < N; i++) {
      const r = clubScandalRoll(`game-${i % 2000}`, 1 + Math.floor(i / 2000) % 16, `team-${Math.floor(i / 32000)}`, baseChance, R);
      if (r === null) continue;
      hits++;
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(R);
      byRound[r]++;
    }
    const expected = N * baseChance; // 400
    const sd = Math.sqrt(N * baseChance * (1 - baseChance)); // ≈ 20
    expect(Math.abs(hits - expected)).toBeLessThan(4.5 * sd);
    // 每个回合都可能曝光（期望 ≈ 22 次/回合）
    for (let r = 1; r <= R; r++) expect(byRound[r]).toBeGreaterThan(3);
  });

  it('确定性：同一存档 / 赛季 / 战队结果一致；不消耗主随机序列', () => {
    const a = clubScandalRoll('s', 9, 't1', 0.5, 18);
    const b = clubScandalRoll('s', 9, 't1', 0.5, 18);
    expect(a).toBe(b);
    const state = makeTestState(8);
    const rng0 = state.rngState;
    cfg.clubBanChancePerSeason = 0.5;
    rollClubScandals(state);
    expect(state.rngState).toBe(rng0);
  });

  it('每队每赛季只掷一次：重复调用不追加；新赛季重新掷骰', () => {
    const state = makeTestState(40);
    cfg.clubBanChancePerSeason = 0.5;
    const first = rollClubScandals(state).map((p) => `${p.teamId}@${p.round}`);
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(35);
    expect(new Set(first.map((x) => x.split('@')[0])).size).toBe(first.length); // 每队至多一条
    const again = rollClubScandals(state).map((p) => `${p.teamId}@${p.round}`);
    expect(again).toEqual(first);
    state.season.ti = 10;
    const next = rollClubScandals(state);
    expect(next.every((p) => p.season === 10)).toBe(true);
  });

  it('概率为 0 时不产生任何计划；已解散的战队不参与', () => {
    const state = makeTestState(8);
    cfg.clubBanChancePerSeason = 0;
    expect(rollClubScandals(state)).toHaveLength(0);
    cfg.clubBanChancePerSeason = 1;
    state.teams.t2.disbanded = true;
    const plans = rollClubScandals(state);
    expect(plans.map((p) => p.teamId)).not.toContain('t2');
    expect(plans).toHaveLength(7);
  });
});

describe('scandal · 禁赛效果', () => {
  it('AI 俱乐部：全员永久禁赛、除名，新组织补位并接替未开赛赛事的邀请', () => {
    const state = makeTestState(8);
    const roster = state.teams.t3.playerIds.slice();
    const before = activeTeams(state).length;
    state.tournaments.x = {
      id: 'x', status: 'scheduled', season: 9, invitedTeamIds: ['t1', 't3'], teamIds: ['t3'], qualifierTeamIds: [],
    } as unknown as Tournament;
    state.seasonTournamentIds = ['x'];
    state.transferOffers.push({
      id: 'o1', playerId: roster[0], fromTeamId: 't0', toTeamId: 't3', fee: 1, salary: 1, status: 'pending', createdRound: 0, expiresRound: 3,
    });
    const rec = banClub(state, 't3');
    expect(rec).not.toBeNull();
    expect(state.teams.t3.banned).toBeTruthy();
    expect(state.teams.t3.disbanded).toBe(true);
    expect(state.teams.t3.playerIds).toHaveLength(0);
    for (const id of roster) {
      expect(state.players[id].status).toBe('banned');
      expect(state.players[id].teamId).toBeNull();
    }
    // 禁赛选手不进入自由市场
    expect(freeAgents(state).some((p) => roster.includes(p.id))).toBe(false);
    // 联赛规模不变：新组织补位
    expect(activeTeams(state).length).toBe(before);
    const repl = state.teams[rec!.replacementId!];
    expect(repl.replacesTeamId).toBe('t3');
    expect(repl.playerIds.length).toBeGreaterThanOrEqual(5);
    expect(state.tournaments.x.invitedTeamIds).toEqual(['t1', repl.id]);
    expect(state.tournaments.x.teamIds).toEqual([repl.id]);
    // 相关报价作废；公开重磅新闻；玩家收到弹窗
    expect(state.transferOffers[0].status).toBe('expired');
    const news = state.news.find((n) => n.tags?.includes('club-ban'));
    expect(news?.important).toBe(true);
    expect(news?.visibility).toBe('public');
    expect(state.popups.some((p) => p.kind === 'message' && p.title.includes('全员假赛'))).toBe(true);
    expect(isClubBanned(state, 't3')).toBe(true);
    expect(clubScandalState(state).history).toHaveLength(1);
    expect(state.gameOver).toBeNull();
    // 幂等
    expect(banClub(state, 't3')).toBeNull();
  });

  it('单机玩家俱乐部：游戏立即结束（reason = banned），生涯档案冻结截至禁赛的赛季', () => {
    const state = makeTestState(6);
    const roster = state.teams.t0.playerIds.slice();
    banClub(state, 't0');
    expect(state.gameOver?.reason).toBe('banned');
    expect(state.gameOver?.summary).toContain('全员假赛');
    for (const id of roster) expect(state.players[id].status).toBe('banned');
    const log = state.legacyLog?.t0 ?? [];
    expect(log).toHaveLength(1);
    expect(log[0].ending).toBe('banned');
    expect(log[0].squad.length).toBe(roster.length); // 阵容在禁赛前记录
    expect(Object.values(state.teams).some((t) => t.replacesTeamId === 't0')).toBe(false); // 玩家俱乐部不补位
  });

  it('fireDueClubScandals：只触发本赛季到期的计划，触发后移除', () => {
    const state = makeTestState(6);
    clubScandalState(state).plans.push({ teamId: 't2', season: 9, round: 3 }, { teamId: 't4', season: 9, round: 5 });
    expect(fireDueClubScandals(state, 2)).toHaveLength(0);
    expect(fireDueClubScandals(state, 3).map((r) => r.teamId)).toEqual(['t2']);
    expect(state.clubScandals!.plans.map((p) => p.teamId)).toEqual(['t4']);
    expect(isClubBanned(state, 't4')).toBe(false);
  });
});

describe('scandal · 整局集成', () => {
  it('单机：AI 俱乐部在赛季内曝光（联赛规模不变）；玩家俱乐部曝光 → 游戏结束且无法继续推进', async () => {
    const g = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 5,
      newClub: { name: '测试', tag: 'TST', region: 'CN', color: '#c23c2a' },
    });
    const me = g.settings.playerTeamId;
    const ai = activeTeams(g).find((t) => !t.isPlayer && t.playerIds.length >= 5)!;
    clubScandalState(g).plans.push({ teamId: ai.id, season: g.season.ti, round: 1 });
    const n = activeTeams(g).length;
    expect(step(g).ok).toBe(true); // 赛季初 → 第 1 回合
    expect(g.teams[ai.id].banned?.round).toBe(1);
    expect(activeTeams(g).length).toBe(n);
    expect(g.gameOver).toBeNull();

    clubScandalState(g).plans.push({ teamId: me, season: g.season.ti, round: 2 });
    step(g);
    expect(g.roundIndex).toBe(2);
    expect(g.gameOver?.reason).toBe('banned');
    expect(g.teams[me].banned).toBeTruthy();
    expect(bannedHumanTeamIds(g)).toEqual([me]);
    expect(advance(g).ok).toBe(false);
  }, 30_000);

  it('多人：被禁赛的座位出局转观战，其余玩家继续；全部出局 → 游戏结束（banned）', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 11,
      players: [
        { sessionId: 's0', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    const call = (id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
    const advanceAll = () => {
      for (let pass = 0; pass < 4; pass++) {
        for (const id of M.activeHumanIds(g)) {
          for (let i = 0; i < 20; i++) {
            const d = M.withSeat(g, id, () => g.pendingDecisions[0]);
            if (!d) break;
            if (!call(id, 'resolveDecision', d.id, d.choices[0]?.id ?? '').ok) M.withSeat(g, id, () => g.pendingDecisions.shift());
          }
          call(id, 'fillLineupWithTempSubs');
          call(id, 'quickSimTournament');
        }
      }
      for (const id of M.activeHumanIds(g)) M.setSeatReady(g, id, true);
      return M.advanceMultiplayer(g);
    };
    clubScandalState(g).plans.push({ teamId: B, season: 9, round: 1 });
    expect(M.seatView(g, A).clubScandals?.plans ?? []).toHaveLength(0); // 未曝光的计划不下发给客户端
    expect(advanceAll().ok).toBe(true);
    expect(g.multiplayer!.seats[B].eliminated).toBe(true);
    expect(g.teams[B].banned).toBeTruthy();
    expect(g.gameOver).toBeNull();
    expect(M.activeHumanIds(g)).toEqual([A]);
    expect(call(B, 'doTraining').ok).toBe(false);
    expect(g.legacyLog?.[B]?.[0]?.ending).toBe('banned');
    // A 收到重磅弹窗；B 不收到
    expect(M.seatView(g, A).popups.some((p) => p.kind === 'message' && p.title.includes('全员假赛'))).toBe(true);
    expect(M.seatView(g, B).popups.some((p) => p.kind === 'message' && p.title.includes('全员假赛'))).toBe(false);
    // 游戏继续推进
    expect(advanceAll().ok).toBe(true);
    expect(g.roundIndex).toBe(2);
    // A 也被禁赛 → 全部出局，游戏结束
    clubScandalState(g).plans.push({ teamId: A, season: 9, round: 3 });
    advanceAll();
    expect(g.gameOver?.reason).toBe('banned');
    expect(g.multiplayer!.activeSeat).toBeNull();
  }, 30_000);
});
