// 多人对战引擎（src/engine/multi.ts / seat.ts）：座位上下文切换、隔离、先到先得、准备/推进、出局、玩家对决、视图隐私、单机回归
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Tournament } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader, readRosterSync } from '../scripts/nodeData';
import * as M from '../src/engine/multi';
import { advance, commitGame, createNewGame, doTraining, getAdvanceBlockers, playGame, startDraft } from '../src/engine/game';
import { addNews, pushPopup } from '../src/engine/news';
import { applyHonorChange } from '../src/engine/honor';
import { freeAgents, signingFee } from '../src/engine/market';
import { initTournamentStages, playerNextSeries, readySeries } from '../src/engine/tournament';
import { currentStep } from '../src/engine/draft';
import { addFinance } from '../src/engine/economy';
import { multiplayerCareerSummary } from '../src/engine/season';
import { gachaDiscardRefund, gachaPrice, poolRemaining } from '../src/engine/gacha';

beforeAll(() => {
  registerNodeRosterLoader();
});

const CLUBS = [
  { name: 'Alpha Club', tag: 'ALP', region: 'CN' as const, color: '#c23c2a' },
  { name: 'Beta Club', tag: 'BET', region: 'EU' as const, color: '#3a7bd5' },
  { name: 'Gamma Club', tag: 'GAM', region: 'SEA' as const, color: '#d4a017' },
];

async function buildGame(n = 2, seed = 11, endTi = 10): Promise<GameState> {
  return M.createMultiplayerGame({
    startTi: 9, endTi, difficulty: 'normal', mode: 'build', seed,
    players: CLUBS.slice(0, n).map((c, i) => ({ sessionId: `sess-${i}`, name: `玩家${i + 1}`, newClub: c })),
  });
}

const ids = (g: GameState) => g.multiplayer!.order;
const call = (g: GameState, id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
const inSeat = <T>(g: GameState, id: string, fn: () => T) => M.withSeat(g, id, fn);

/** 清空座位的待决事件（逐个选第一项） */
function resolveAll(g: GameState, id: string): void {
  for (let i = 0; i < 30; i++) {
    const d = inSeat(g, id, () => g.pendingDecisions[0]);
    if (!d) return;
    let r = call(g, id, 'resolveDecision', d.id, d.choices[0]?.id ?? '');
    if (!r.ok) for (const c of d.choices) if ((r = call(g, id, 'resolveDecision', d.id, c.id)).ok) break;
  }
}

/** 全员准备并推进一回合（先处理待决事件、快速模拟各自比赛） */
function advanceAll(g: GameState): OpResult {
  for (let pass = 0; pass < 4; pass++) {
    for (const id of M.activeHumanIds(g)) {
      resolveAll(g, id);
      call(g, id, 'quickSimTournament');
    }
  }
  for (const id of M.activeHumanIds(g)) {
    const r = M.setSeatReady(g, id, true);
    if (!r.ok) throw new Error(`${id} 无法准备：${r.message}`);
  }
  return M.advanceMultiplayer(g);
}

describe('multi · 创建对局', () => {
  it('build：每位玩家一支新俱乐部，全部 isPlayer，结束在中性上下文', async () => {
    const g = await buildGame(3);
    expect(M.isMultiplayer(g)).toBe(true);
    expect(ids(g)).toHaveLength(3);
    expect(g.multiplayer!.activeSeat).toBeNull();
    expect(g.settings.playerTeamId).toBe('');
    for (const id of ids(g)) {
      const t = g.teams[id];
      expect(t.isPlayer).toBe(true);
      expect(t.honor).toBe(CONFIG.team.newClubHonor);
      expect(t.playerIds.length).toBeGreaterThanOrEqual(5);
      // 欢迎弹窗在各自座位；2026-10-14 起新秀改由抽卡进入联赛：没有选秀结果弹窗，也没有创立礼包账目
      inSeat(g, id, () => {
        expect(g.settings.playerTeamId).toBe(id);
        expect(g.popups.some((p) => p.kind === 'message' && p.title.includes('多人'))).toBe(true);
        expect(g.popups.some((p) => p.kind === 'rookie_draft')).toBe(false);
        expect(g.finance.some((f) => f.note.includes('创立礼包'))).toBe(false);
      });
    }
    // 本赛季卡池全局一份（所有座位共享），名人堂已建立
    expect(g.gacha?.pool?.ti).toBe(g.season.ti);
    expect(poolRemaining(g.gacha!.pool)).toBe(g.gacha!.pool!.size);
    expect(g.hallOfFame?.members.length).toBeGreaterThan(0);
    expect(Object.values(g.teams).filter((t) => t.isPlayer).map((t) => t.id).sort()).toEqual([...ids(g)].sort());
  });

  it('existing：接管真实战队并重置为新俱乐部标准（只保留 ID、显示名、天赋），不可重复选择', async () => {
    const roster = readRosterSync(9);
    const [a, b] = roster.teams.slice(0, 2);
    await expect(M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'existing', seed: 3,
      players: [{ sessionId: 'x', name: 'x', teamId: a.id }, { sessionId: 'y', name: 'y', teamId: a.id }],
    })).rejects.toThrow();
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'existing', seed: 3,
      players: [{ sessionId: 'x', name: 'x', teamId: a.id }, { sessionId: 'y', name: 'y', teamId: b.id }],
    });
    for (const seed of [a, b]) {
      const t = g.teams[seed.id];
      expect(t.isPlayer).toBe(true);
      expect(t.honor).toBe(CONFIG.team.newClubHonor);
      expect(t.coachId).toBeNull();
      for (const sp of seed.players.slice(0, 5)) {
        const p = g.players[sp.id];
        expect(p.handle).toBe(sp.handle);
        expect(p.talent).toBe(sp.talent);
        expect(p.teamId).toBe(seed.id);
      }
      // 首发战力回到新俱乐部的水平（真实数据中的顶级战队首发明显更强）
      const power = seed.players.slice(0, 5).map((sp) => g.players[sp.id].power);
      const seedPower = seed.players.slice(0, 5).map((sp) => sp.power);
      expect(power.reduce((x, y) => x + y, 0)).toBeLessThan(seedPower.reduce((x, y) => x + y, 0));
    }
  });
});

describe('multi · 座位上下文切换', () => {
  it('换入/换出私有字段，嵌套与异常后都能恢复', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    const tid = g.seasonTournamentIds.find((id) => g.tournaments[id].tier !== 'ti')!;
    inSeat(g, A, () => {
      g.trainingFocus = 'power';
      g.gachaPity = 42;
      g.season.extraTrainingsBought = 3;
      g.tournaments[tid].playerStatus = 'declined';
      g.pendingDecisions.push({ id: 'd-test', kind: 'other', title: 't', body: 'b', choices: [], ctx: {}, createdRound: 0, blocking: false });
      g.news[0].read = true;
    });
    // 中性上下文看不到 A 的私有数据
    expect(g.settings.playerTeamId).toBe('');
    expect(g.trainingFocus).toBe('balanced');
    expect(g.pendingDecisions).toHaveLength(0);
    expect(g.news[0].read).toBe(false);
    // B 看到的是自己的
    inSeat(g, B, () => {
      expect(g.settings.playerTeamId).toBe(B);
      expect(g.trainingFocus).toBe('balanced');
      expect(g.gachaPity).toBe(0);
      expect(g.season.extraTrainingsBought).toBe(0);
      expect(g.tournaments[tid].playerStatus).not.toBe('declined');
      expect(g.pendingDecisions.some((d) => d.id === 'd-test')).toBe(false);
      expect(g.news[0].read).toBe(false);
      // 嵌套：B 中切到 A 再回来
      const inner = inSeat(g, A, () => g.gachaPity);
      expect(inner).toBe(42);
      expect(g.settings.playerTeamId).toBe(B);
      expect(g.gachaPity).toBe(0);
    });
    // A 的数据保留
    inSeat(g, A, () => {
      expect(g.trainingFocus).toBe('power');
      expect(g.gachaPity).toBe(42);
      expect(g.season.extraTrainingsBought).toBe(3);
      expect(g.tournaments[tid].playerStatus).toBe('declined');
      expect(g.pendingDecisions.some((d) => d.id === 'd-test')).toBe(true);
      expect(g.news[0].read).toBe(true);
      expect(g.settings.managerName).toBe('玩家1');
    });
    // 异常：换出仍然发生，修改保留在座位中
    expect(() => inSeat(g, B, () => {
      g.gachaPity = 7;
      throw new Error('boom');
    })).toThrow('boom');
    expect(g.multiplayer!.activeSeat).toBeNull();
    expect(g.settings.playerTeamId).toBe('');
    expect(inSeat(g, B, () => g.gachaPity)).toBe(7);
    expect(() => inSeat(g, 'no-such-team', () => 0)).toThrow();
  });

  it('forEachSeat 跳过出局座位；单机时 withSeat / forEachSeat 直接执行', async () => {
    const g = await buildGame(3);
    const [A, B, C] = ids(g);
    g.multiplayer!.seats[B].eliminated = true;
    const seen: string[] = [];
    M.forEachSeat(g, (id) => seen.push(`${id}:${g.settings.playerTeamId}`));
    expect(seen).toEqual([`${A}:${A}`, `${C}:${C}`]);

    const sp = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: 'S', newClub: CLUBS[0], seed: 5 });
    const me = sp.settings.playerTeamId;
    expect(M.isMultiplayer(sp)).toBe(false);
    expect(M.humanTeamIds(sp)).toEqual([me]);
    expect(M.withSeat(sp, 'anything', () => sp.settings.playerTeamId)).toBe(me);
    const once: string[] = [];
    M.forEachSeat(sp, (id) => once.push(id));
    expect(once).toEqual([me]);
  });
});

describe('multi · 座位隔离与 RPC', () => {
  it('训练、账目、抽卡只影响调用者座位；卡池全局共享、退回新秀只限本队本回合', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    // 赛季初：卡池全局一份；没有选秀与选秀弹窗
    expect(g.gacha?.pool?.ti).toBe(g.season.ti);
    expect(g.rookieDraft?.history ?? []).toHaveLength(0);
    for (const id of [A, B]) expect(inSeat(g, id, () => g.popups.filter((p) => p.kind === 'rookie_draft').length)).toBe(0);
    expect(g.popups).toEqual([]); // 中性上下文不残留弹窗
    const price = gachaPrice(g).single;
    const left0 = poolRemaining(g.gacha!.pool);
    const goldA = g.teams[A].gold;
    const goldB = g.teams[B].gold;
    const finB = inSeat(g, B, () => g.finance.length);
    // A 单抽：共享卡池少一张，A 付费、新秀入队；B 的资金 / 账目 / 抽卡计数不变
    const r1 = call(g, A, 'gachaPull', 1) as OpResult & { results?: { playerId: string }[] };
    expect(r1.ok).toBe(true);
    const rookieA = r1.results![0].playerId;
    expect(g.players[rookieA].teamId).toBe(A);
    expect(g.players[rookieA].gacha?.teamId).toBe(A);
    expect(poolRemaining(g.gacha!.pool)).toBe(left0 - 1);
    expect(g.teams[A].gold).toBe(goldA - price);
    expect(g.teams[B].gold).toBe(goldB);
    expect(inSeat(g, A, () => g.finance.some((f) => f.category === 'gacha' && f.amount === -price))).toBe(true);
    expect(inSeat(g, B, () => g.finance.length)).toBe(finB);
    expect(g.teams[A].gacha?.pulls).toBe(1);
    expect(g.teams[B].gacha?.pulls ?? 0).toBe(0);
    // 视图隐私：逐张抽卡记录只下发给本人（卡池与阵容公开）
    expect(M.seatView(g, A).teams[A].gacha?.log).toHaveLength(1);
    expect(M.seatView(g, B).teams[A].gacha?.log).toBeUndefined();
    expect(M.seatView(g, B).gacha?.pool?.drawn).toBe(1);
    // B 不能退回 A 的新秀；A 本回合退回：离队进入自由市场、返还部分费用、不扣荣誉
    expect(call(g, B, 'gachaDiscard', rookieA).ok).toBe(false);
    const honorA = g.teams[A].honor;
    const r = call(g, A, 'gachaDiscard', rookieA);
    expect(r.ok).toBe(true);
    expect(g.players[rookieA].teamId).toBeNull();
    expect(g.teams[A].honor).toBe(honorA);
    expect(g.teams[A].gold).toBe(goldA - price + gachaDiscardRefund(g));
    expect(inSeat(g, B, () => g.finance.length)).toBe(finB);
    expect(freeAgents(g).some((p) => p.id === rookieA)).toBe(true);
    expect(call(g, A, 'gachaDiscard', rookieA).ok).toBe(false); // 不能重复退回
    // 推进到休赛回合：A 训练，B 的训练次数不受影响
    expect(advanceAll(g).ok).toBe(true);
    const kindRest = inSeat(g, A, () => doTrainingAllowed(g)) && inSeat(g, B, () => doTrainingAllowed(g));
    if (kindRest) {
      expect(call(g, A, 'doTraining').ok).toBe(true);
      expect(inSeat(g, A, () => g.freeTrainingUsed)).toBe(true);
      expect(inSeat(g, B, () => g.freeTrainingUsed)).toBe(false);
      expect(inSeat(g, A, () => g.history.training?.length ?? 0)).toBeGreaterThan(0);
      expect(inSeat(g, B, () => g.history.training?.length ?? 0)).toBe(0);
    }
    // 其他座位战队的账目路由到其座位（不是当前上下文）
    inSeat(g, A, () => addFinance(g, B, 12345, 'other', '测试入账'));
    expect(inSeat(g, A, () => g.finance.some((f) => f.note === '测试入账'))).toBe(false);
    expect(inSeat(g, B, () => g.finance.some((f) => f.note === '测试入账'))).toBe(true);
  });

  it('未知函数抛错；带 teamId 的 RPC 强制为调用者战队', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    expect(() => M.callAsSeat(g, A, 'advance', [])).toThrow();
    expect(() => M.callAsSeat(g, A, 'constructor', [])).toThrow();
    expect(() => M.callAsSeat(g, 'nobody', 'doTraining', [])).toThrow();
    const lineupB = JSON.stringify(g.teams[B].lineup);
    call(g, A, 'setLineupSlot', B, 'C', null);
    expect(JSON.stringify(g.teams[B].lineup)).toBe(lineupB);
    expect(g.teams[A].lineup.C).toBeNull();
    call(g, A, 'autoLineup', B, null);
    expect(g.teams[A].lineup.C).not.toBeNull();
    // 求购其他玩家的选手被拒绝
    const victim = g.teams[B].playerIds[0];
    const r = call(g, A, 'bidForPlayer', victim, 1e9);
    expect(r.ok).toBe(false);
    expect(g.players[victim].teamId).toBe(B);
  });

  it('先到先得：两名玩家抢签同一名自由选手，后到者收到「已被签下」', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    g.teams[A].gold += 5_000_000;
    g.teams[B].gold += 5_000_000;
    const cands = inSeat(g, A, () => freeAgents(g)).filter((p) => signingFee(g, p) < 1_000_000);
    let won: string | null = null;
    for (const p of cands) {
      if (call(g, A, 'signFreeAgent', p.id).ok) {
        won = p.id;
        break;
      }
    }
    expect(won).not.toBeNull();
    expect(g.players[won!].teamId).toBe(A);
    const r = call(g, B, 'signFreeAgent', won!);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('已被');
    expect(g.players[won!].teamId).toBe(A);
  });
});

/** 当前座位本回合能否训练 */
function doTrainingAllowed(g: GameState): boolean {
  return g.phase !== 'preseason' && !g.activeMatch && !getAdvanceBlockers(g).some((b) => b.code === 'tournament_running');
}

describe('multi · 准备与推进', () => {
  it('有阻塞不能准备；全员准备后推进，准备状态清空', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    inSeat(g, A, () => {
      g.pendingDecisions.push({
        id: 'd-block', kind: 'other', title: '测试', body: '测试', choices: [{ id: 'ok', label: '好' }], ctx: {}, createdRound: 0, blocking: true,
      });
    });
    expect(M.seatBlockers(g, A).some((b) => b.code === 'pending_decision')).toBe(true);
    expect(M.setSeatReady(g, A, true).ok).toBe(false);
    expect(M.setSeatReady(g, B, true).ok).toBe(true);
    expect(M.allSeatsReady(g)).toBe(false);
    const early = M.advanceMultiplayer(g);
    expect(early.ok).toBe(false);
    expect(g.roundIndex).toBe(0);
    expect(call(g, A, 'resolveDecision', 'd-block', 'ok').ok).toBe(true);
    expect(M.setSeatReady(g, A, true).ok).toBe(true);
    expect(M.allSeatsReady(g)).toBe(true);
    // 取消准备总是允许
    expect(M.setSeatReady(g, A, false).ok).toBe(true);
    expect(M.allSeatsReady(g)).toBe(false);
    M.setSeatReady(g, A, true);
    const r = M.advanceMultiplayer(g);
    expect(r.ok).toBe(true);
    expect(g.roundIndex).toBe(1);
    expect(g.multiplayer!.activeSeat).toBeNull();
    for (const id of ids(g)) expect(g.multiplayer!.seats[id].ready).toBe(false);
    // 单机推进入口在多人模式下不可用
    expect(advance(g).ok).toBe(false);
  });

  it('多回合推进：每个座位各自的荣誉曲线、成长快照与赛事结算', async () => {
    const g = await buildGame(2);
    for (let i = 0; i < 6; i++) {
      for (const id of ids(g)) {
        if (g.phase === 'preseason') {
          for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => g.tournaments[x].playerStatus === 'open'))) {
            call(g, id, 'registerForTournament', tid);
          }
        }
      }
      expect(advanceAll(g).ok).toBe(true);
    }
    for (const id of ids(g)) {
      inSeat(g, id, () => {
        expect(g.history.honor.length).toBeGreaterThan(0);
        expect(g.history.honor.at(-1)!.value).toBe(Math.round(g.teams[id].honor));
        expect(Object.keys(g.history.squadProgress ?? {}).every((pid) => g.players[pid]?.lastTeamId === id || g.teams[id].playerIds.includes(pid) || !g.players[pid]?.teamId)).toBe(true);
        for (const st of g.history.playerSettlements) {
          expect(g.tournaments[st.tournamentId].placements.some((p) => p.teamId === id)).toBe(true);
        }
      });
    }
  });
});

describe('multi · 出局', () => {
  it('荣誉跌破 0：该座位出局转为观战，其余玩家继续；全部出局游戏结束', async () => {
    const g = await buildGame(3);
    const [A, B, C] = ids(g);
    applyHonorChange(g, B, -(g.teams[B].honor + 10), '测试', true);
    expect(g.multiplayer!.seats[B].eliminated).toBe(true);
    expect(g.teams[B].disbanded).toBe(true);
    expect(g.gameOver).toBeNull();
    // 观战座位不能操作；出局收尾在下一次 RPC 后执行
    expect(call(g, B, 'doTraining').ok).toBe(false);
    call(g, A, 'markAllNewsRead');
    expect(g.teams[B].playerIds).toHaveLength(0);
    expect(M.activeHumanIds(g)).toEqual([A, C]);
    expect(M.setSeatReady(g, B, true).ok).toBe(false);
    expect(advanceAll(g).ok).toBe(true);
    expect(g.roundIndex).toBe(1);
    // 其余玩家全部出局 → 游戏结束
    applyHonorChange(g, A, -(g.teams[A].honor + 10), '测试', true);
    applyHonorChange(g, C, -(g.teams[C].honor + 10), '测试', true);
    expect(g.gameOver).toBeNull();
    call(g, A, 'markAllNewsRead');
    expect(g.gameOver?.reason).toBe('disbanded');
  });
});

/** 在当前回合造一个只有两名玩家的单败赛事（决赛即玩家对决） */
function makeH2HTournament(g: GameState, a: string, b: string): Tournament {
  const t: Tournament = {
    id: 'test-h2h-cup', seriesId: 'test-h2h-cup', name: '测试对决杯', tier: 'major', season: g.season.ti,
    roundIndex: g.roundIndex, startDate: g.currentDate, city: '线上', hostRegion: 'CN', online: true, prizePool: 100000,
    appearanceFee: 0, format: 'se8', teamIds: [a, b], invitedTeamIds: [a, b], qualifierTeamIds: [], stages: [], series: {},
    status: 'scheduled', placements: [], playerStatus: 'locked', minHonor: 0, size: 2,
  };
  g.tournaments[t.id] = t;
  g.seasonTournamentIds.push(t.id);
  g.season.rounds[g.roundIndex].tournamentIds.push(t.id);
  t.expectedRanks = { [a]: 1, [b]: 2 };
  initTournamentStages(g, t.id);
  t.status = 'running';
  for (const id of [a, b]) {
    inSeat(g, id, () => {
      t.playerStatus = 'invited';
      t.expectedRank = t.expectedRanks![id];
    });
  }
  return t;
}

describe('multi · 快速模拟整项赛事（其他玩家仍在赛事中）', () => {
  it('本方系列赛打完、赛事因另一名玩家未打而继续 → 返回成功（不是失败提示）', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    // 4 队单败：A、B 首轮各对一支 AI 战队
    const ai = Object.values(g.teams).filter((t) => !t.isPlayer && t.playerIds.length >= 5).slice(0, 2).map((t) => t.id);
    expect(ai).toHaveLength(2);
    const t: Tournament = {
      id: 'test-qs-cup', seriesId: 'test-qs-cup', name: '测试快速模拟杯', tier: 'minor', season: g.season.ti,
      roundIndex: g.roundIndex, startDate: g.currentDate, city: '线上', hostRegion: 'CN', online: true, prizePool: 100000,
      appearanceFee: 0, format: 'se8', teamIds: [A, B, ...ai], invitedTeamIds: [A, B, ...ai], qualifierTeamIds: [],
      stages: [], series: {}, status: 'scheduled', placements: [], playerStatus: 'locked', minHonor: 0, size: 4,
    };
    g.tournaments[t.id] = t;
    g.seasonTournamentIds.push(t.id);
    g.season.rounds[g.roundIndex].tournamentIds.push(t.id);
    t.expectedRanks = { [A]: 1, [B]: 2, [ai[0]]: 3, [ai[1]]: 4 };
    initTournamentStages(g, t.id);
    t.status = 'running';
    for (const id of [A, B]) inSeat(g, id, () => {
      t.playerStatus = 'invited';
      t.expectedRank = t.expectedRanks![id];
    });
    const aFirst = inSeat(g, A, () => playerNextSeries(g, t.id))!;
    expect(aFirst).toBeTruthy();
    expect([aFirst.teamA, aFirst.teamB]).not.toContain(B);

    const r = call(g, A, 'quickSimTournament');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('已模拟 1 场');
    expect(g.tournaments[t.id].status).toBe('running'); // B 的首轮还没打
    expect(inSeat(g, A, () => g.activeMatch)).toBeNull();
    // 再次请求：本方没有就绪比赛 → 失败提示（不重复模拟）
    expect(call(g, A, 'quickSimTournament').ok).toBe(false);
  });
});

describe('multi · 玩家对决（H2H）', () => {
  it('双方进入、各自 BP（自动方由 AI 代选）、记录生成即计入、各自继续、快速模拟需双方同意', async () => {
    const g = await buildGame(3);
    const [A, B, C] = ids(g);
    // 赛季初婉拒/取消第 1 回合的全部赛事，避免与测试赛事冲突
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    expect(g.roundIndex).toBe(1);
    const t = makeH2HTournament(g, A, B);
    const series = Object.values(t.series).find((s) => s.teamA && s.teamB && !s.result)!;
    expect(series).toBeTruthy();
    // 赛事未打完：双方都被阻塞，第三名玩家不受影响
    expect(M.seatBlockers(g, A).some((b) => b.code === 'tournament_running')).toBe(true);
    expect(M.seatBlockers(g, B).some((b) => b.code === 'tournament_running')).toBe(true);
    expect(M.seatBlockers(g, C).some((b) => b.code === 'tournament_running')).toBe(false);

    const p1 = call(g, A, 'prepareNextMatch');
    expect(p1.ok).toBe(true);
    expect(p1.message).toContain('等待对手');
    const h = M.h2hMatch(g, series.id)!;
    expect(h).toBeTruthy();
    expect(h.joined[A]).toBe(true);
    // A 手动 BP；B 尚未选择方式 → 轮到 B 时等待
    expect(call(g, A, 'startDraft', true).ok).toBe(true);
    expect(call(g, B, 'prepareNextMatch').ok).toBe(true);
    // 对手已开始 BP 时，尚未选择方式的一方停留在赛前准备（客户端在此选择手动 / 自动 BP），不能直接进入 BP 界面
    expect(inSeat(g, B, () => g.activeMatch?.phase)).toBe('pre');
    expect(M.seatView(g, B).activeMatch?.phase).toBe('pre');
    expect(M.seatView(g, A).activeMatch?.phase).toBe('draft');
    expect(call(g, B, 'playGame').ok).toBe(false);
    // 后选择的一方点「自动 BP · 开始比赛」：对手仍在手动 BP → 只登记自动 BP，不报错也不开打
    const auto = call(g, B, 'autoDraftAndPlay');
    expect(auto.ok).toBe(true);
    expect(h.games).toHaveLength(0);
    expect(h.mode[h.teamA === B ? 'A' : 'B']).toBe('auto');
    expect(M.seatView(g, B).activeMatch?.phase).toBe('draft');
    const sideA = h.teamA === A ? 'A' : 'B';
    for (let i = 0; i < 40 && h.draft && !h.draft.done; i++) {
      const step = currentStep(h.draft);
      if (!step) break;
      expect(step.side).toBe(sideA); // B 的回合由 AI 自动完成
      // 不是自己的回合不能操作
      expect(call(g, B, 'playerDraftAction', h.draft.available[0]).ok).toBe(false);
      expect(call(g, A, 'playerDraftAction', h.draft.available[0]).ok).toBe(true);
    }
    expect(h.draft?.done || (h.draft && !currentStep(h.draft))).toBeTruthy();
    // 任一方开打：对局记录立即计入，双方视图各自回放
    expect(call(g, B, 'playGame').ok).toBe(true);
    expect(h.games).toHaveLength(1);
    expect(inSeat(g, A, () => !!g.activeMatch?.pendingGame)).toBe(true);
    expect(inSeat(g, B, () => !!g.activeMatch?.pendingGame)).toBe(true);
    // B 看完继续，只推进 B 的视图
    const done1 = !!h.done;
    if (!done1) {
      expect(call(g, B, 'commitGame').ok).toBe(true);
      expect(inSeat(g, B, () => g.activeMatch?.pendingGame)).toBeUndefined();
      expect(inSeat(g, A, () => !!g.activeMatch?.pendingGame)).toBe(true);
      // 快速模拟：单方请求只登记，双方都请求才生效
      const q1 = call(g, B, 'quickSimSeries');
      expect(q1.ok).toBe(true);
      expect(q1.message).toContain('等待对手');
      expect(h.done).toBeFalsy();
      const q2 = call(g, A, 'quickSimSeries');
      expect(q2.ok).toBe(true);
    } else {
      expect(call(g, A, 'commitGame').ok).toBe(true);
      expect(call(g, B, 'commitGame').ok).toBe(true);
    }
    expect(h.done).toBe(true);
    expect(g.tournaments[t.id].series[series.id].result).toBeTruthy();
    expect(inSeat(g, A, () => g.activeMatch)).toBeNull();
    expect(inSeat(g, B, () => g.activeMatch)).toBeNull();
    // 赛事结束：双方各自收到结算（结算/弹窗/新闻在各自座位）
    expect(g.tournaments[t.id].status).toBe('finished');
    for (const id of [A, B]) {
      inSeat(g, id, () => {
        expect(g.tournaments[t.id].settlement?.tournamentId).toBe(t.id);
        expect(g.history.playerSettlements.some((s) => s.tournamentId === t.id)).toBe(true);
        expect(g.popups.some((p) => p.kind === 'tournament_settlement' && p.tournamentId === t.id)).toBe(true);
      });
    }
    inSeat(g, C, () => {
      expect(g.tournaments[t.id].settlement).toBeUndefined();
      expect(g.popups.some((p) => p.kind === 'tournament_settlement' && p.tournamentId === t.id)).toBe(false);
    });
    expect(M.seatBlockers(g, A).some((b) => b.code === 'tournament_running')).toBe(false);
    expect(advanceAll(g).ok).toBe(true);
  });
});

describe('multi · 托管（离线玩家）', () => {
  it('托管处理待决事件、玩家对决（双方托管即结算）与各自比赛后准备；全部托管可连续推进多个回合', async () => {
    const g = await buildGame(3, 23);
    const [A, B, C] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    const t = makeH2HTournament(g, A, B);
    const series = Object.values(t.series).find((x) => x.teamA && x.teamB && !x.result)!;
    inSeat(g, C, () => {
      g.pendingDecisions.push({
        id: 'test-unpaid', kind: 'unpaid_salary', title: '测试欠薪', body: '', choices: [{ id: 'ack', label: '知道了' }],
        ctx: {}, createdRound: g.roundIndex, blocking: true,
      });
    });
    // A 托管：玩家对决只登记快速模拟，等待对手 → 仍被阻塞、未准备
    const ra = M.autopilotSeat(g, A);
    expect(ra.ok).toBe(true);
    expect(M.h2hMatch(g, series.id)?.quickSim[A]).toBe(true);
    expect(g.multiplayer!.seats[A].ready).toBe(false);
    // B 托管：双方都请求 → 结算；B 无阻塞后准备
    expect(M.autopilotSeat(g, B).ok).toBe(true);
    expect(g.tournaments[t.id].series[series.id].result).toBeTruthy();
    expect(g.multiplayer!.seats[B].ready).toBe(true);
    // 再次托管 A：关闭已结束的对决视图并准备；C：处理待决事件并准备
    expect(M.autopilotSeat(g, A).ok).toBe(true);
    const rc = M.autopilotSeat(g, C);
    expect(rc.message).toContain('测试欠薪');
    for (const id of [A, B, C]) {
      expect(M.seatBlockers(g, id)).toEqual([]);
      expect(g.multiplayer!.seats[id].ready).toBe(true);
    }
    expect(g.settings.playerTeamId).toBe('');
    // 已准备 / 无事可做：不产生摘要（服务器据此不重复推送视图）
    expect(M.autopilotSeat(g, C)).toEqual({ ok: true, message: '' });
    expect(M.advanceMultiplayer(g).ok).toBe(true);
    // 全部托管：连续推进 30 个回合（跨过 TI 与赛季结算 / 续约、退役等休赛期事务）不会卡住
    const startTi = g.season.ti;
    for (let i = 0; i < 30 && !g.gameOver; i++) {
      for (let pass = 0; pass < 2; pass++) for (const id of M.activeHumanIds(g)) M.autopilotSeat(g, id);
      expect(M.allSeatsReady(g)).toBe(true);
      expect(M.advanceMultiplayer(g).ok).toBe(true);
      expect(g.settings.playerTeamId).toBe('');
    }
    expect(g.season.ti).toBeGreaterThan(startTi);
  });
});

describe('multi · 托管 × 在线对手手动打玩家对决', () => {
  it('在线方手动 BP / 开打，托管方自动 BP、自动推进视图，整场系列赛打完不卡住', async () => {
    const g = await buildGame(2, 31);
    const [A, B] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    const t = makeH2HTournament(g, A, B);
    const series = Object.values(t.series).find((x) => x.teamA && x.teamB && !x.result)!;
    series.bestOf = 3;
    expect(call(g, A, 'prepareNextMatch').ok).toBe(true);
    for (let game = 0; game < 5 && !series.result; game++) {
      // 托管方先行（服务器在每次操作后都会运行托管）
      M.autopilotSeat(g, B);
      const h = M.h2hMatch(g, series.id)!;
      expect(h.mode[h.teamA === B ? 'A' : 'B']).toBe('auto');
      expect(call(g, A, 'startDraft', true).ok).toBe(true);
      for (let i = 0; i < 40 && h.draft && currentStep(h.draft); i++) {
        expect(call(g, A, 'playerDraftAction', h.draft.available[0]).ok).toBe(true);
        M.autopilotSeat(g, B);
      }
      expect(call(g, A, 'playGame').ok).toBe(true);
      M.autopilotSeat(g, B); // 托管方：看完本局（推进视图）、重新登记
      if (!series.result) expect(call(g, A, 'commitGame').ok).toBe(true);
    }
    expect(series.result).toBeTruthy();
    // 收尾：双方视图关闭、无阻塞
    if (inSeat(g, A, () => g.activeMatch)) call(g, A, 'commitGame');
    M.autopilotSeat(g, B);
    expect(M.seatBlockers(g, B)).toEqual([]);
    expect(g.multiplayer!.seats[B].ready).toBe(true);
    expect(M.seatBlockers(g, A).some((b) => b.code === 'match_in_progress')).toBe(false);
    expect(g.settings.playerTeamId).toBe('');
  });

  it('选了手动 BP 后掉线：托管接管为自动 BP，在线方仍能手动打完（不必快速模拟）', async () => {
    const g = await buildGame(2, 37);
    const [A, B] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    const t = makeH2HTournament(g, A, B);
    const series = Object.values(t.series).find((x) => x.teamA && x.teamB && !x.result)!;
    series.bestOf = 1;
    expect(call(g, A, 'prepareNextMatch').ok).toBe(true);
    expect(call(g, B, 'prepareNextMatch').ok).toBe(true);
    // 双方都选手动 BP；B 随后掉线（不再操作）
    expect(call(g, A, 'startDraft', true).ok).toBe(true);
    expect(call(g, B, 'startDraft', true).ok).toBe(true);
    const h = M.h2hMatch(g, series.id)!;
    const sideA = h.teamA === A ? 'A' : 'B';
    const sideB = sideA === 'A' ? 'B' : 'A';
    expect(h.mode[sideB]).toBe('manual');
    M.autopilotSeat(g, B); // 房主托管 B
    expect(h.mode[sideB]).toBe('auto');
    for (let i = 0; i < 40 && h.draft && currentStep(h.draft); i++) {
      expect(currentStep(h.draft)!.side).toBe(sideA); // B 的回合已由 AI 完成
      expect(call(g, A, 'playerDraftAction', h.draft.available[0]).ok).toBe(true);
    }
    expect(call(g, A, 'playGame').ok).toBe(true);
    expect(h.games.length).toBe(1);
    expect(series.result).toBeTruthy(); // BO1
    expect(h.quickSim[A]).toBeFalsy(); // 在线方没有被迫快速模拟
  });
});

describe('multi · 玩家对决中出局', () => {
  it('对手出局后，剩下的玩家仍能打完（对阵已解散的战队）', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    const t = makeH2HTournament(g, A, B);
    expect(call(g, A, 'prepareNextMatch').ok).toBe(true);
    expect(call(g, B, 'prepareNextMatch').ok).toBe(true);
    applyHonorChange(g, B, -(g.teams[B].honor + 10), '测试', true);
    call(g, A, 'markAllNewsRead'); // 出局收尾：B 的选手离队
    expect(g.teams[B].playerIds).toHaveLength(0);
    const r = call(g, A, 'quickSimTournament');
    expect(r.ok).toBe(true);
    expect(g.tournaments[t.id].status).toBe('finished');
    expect(inSeat(g, A, () => g.activeMatch)).toBeNull();
    expect(M.seatBlockers(g, A)).toHaveLength(0);
    expect(advanceAll(g).ok).toBe(true);
  });

  /** 两名玩家进入 BO3 玩家对决，各自自动 BP，A 开打第 1 局；返回系列赛 */
  async function bo3AfterGame1(seed: number) {
    const g = await buildGame(2, seed);
    const [A, B] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    const t = makeH2HTournament(g, A, B);
    const series = Object.values(t.series).find((s) => s.teamA && s.teamB && !s.result)!;
    series.bestOf = 3;
    expect(call(g, A, 'prepareNextMatch').ok).toBe(true);
    expect(call(g, B, 'prepareNextMatch').ok).toBe(true);
    expect(call(g, A, 'startDraft', false).ok).toBe(true);
    expect(call(g, B, 'startDraft', false).ok).toBe(true);
    expect(call(g, A, 'playGame').ok).toBe(true);
    expect(M.h2hMatch(g, series.id)?.games).toHaveLength(1);
    return { g, A, B, t, series };
  }

  /** A 手动（自动 BP + 开打 + 继续）打完剩余对局；返回打了几局 */
  function playOutManually(g: GameState, A: string, t: Tournament, seriesId: string): number {
    let n = 0;
    for (; n < 6 && inSeat(g, A, () => g.activeMatch?.seriesId === seriesId); n++) {
      expect(call(g, A, 'startDraft', false).ok).toBe(true);
      expect(call(g, A, 'playGame').ok).toBe(true);
      expect(call(g, A, 'commitGame').ok).toBe(true);
    }
    expect(g.tournaments[t.id].series[seriesId].result).toBeTruthy();
    return n;
  }

  it('BO3 打完第 1 局后对手出局：剩下的玩家手动打完剩余对局（对局计入系列赛，不会原地循环）', async () => {
    const { g, A, B, t, series } = await bo3AfterGame1(11);
    expect(call(g, A, 'commitGame').ok).toBe(true);
    applyHonorChange(g, B, -(g.teams[B].honor + 10), '测试', true);
    call(g, A, 'markAllNewsRead'); // 出局收尾
    // 共享对局作废：A 的比赛退化为普通比赛，视图不再按玩家对决同步
    expect(M.h2hMatch(g, series.id)).toBeNull();
    expect(M.seatView(g, A).multiplayer!.h2h?.[series.id]).toBeUndefined();
    const n = playOutManually(g, A, t, series.id);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
    const res = g.tournaments[t.id].series[series.id].result!;
    expect(res.scoreA + res.scoreB).toBe(n + 1); // 第 1 局（玩家对决）+ 之后手动打的局
    expect(g.tournaments[t.id].status).toBe('finished');
    expect(M.seatBlockers(g, A)).toHaveLength(0);
  });

  it('对手出局但共享对局尚未清理（同一操作内）：引擎照常按普通比赛计入对局', async () => {
    const { g, A, B, t, series } = await bo3AfterGame1(12);
    // A 仍在回放第 1 局；B 出局但尚未经过出局收尾（共享对局仍在）。直接调用引擎函数（不经 callAsSeat 的收尾）
    applyHonorChange(g, B, -(g.teams[B].honor + 10), '测试', true);
    expect(M.h2hMatch(g, series.id)).not.toBeNull();
    inSeat(g, A, () => {
      expect(commitGame(g).ok).toBe(true);
      expect(g.activeMatch?.games?.length).toBe(1);
      for (let i = 0; i < 6 && g.activeMatch?.seriesId === series.id; i++) {
        expect(startDraft(g, false).ok).toBe(true);
        expect(playGame(g).ok).toBe(true);
        expect(commitGame(g).ok).toBe(true);
      }
    });
    expect(g.tournaments[t.id].series[series.id].result).toBeTruthy();
    expect(g.tournaments[t.id].status).toBe('finished');
  });
});

describe('multi · 出局 × 赛事推进', () => {
  it('等待的下一场取决于刚出局玩家的系列赛：出局后赛事继续推进，剩下的玩家不会一直「等待其他玩家」', async () => {
    const g = await buildGame(2, 11);
    const [A, B] = ids(g);
    for (const id of [A, B]) {
      for (const tid of inSeat(g, id, () => g.seasonTournamentIds.filter((x) => {
        const t = g.tournaments[x];
        return t.roundIndex === 1 && (t.playerStatus === 'invited' || t.playerStatus === 'registered');
      }))) call(g, id, 'unregisterFromTournament', tid);
    }
    expect(advanceAll(g).ok).toBe(true);
    // 四队单败：A 与 B 分在两个半区
    const ai = Object.values(g.teams).filter((t) => !t.isPlayer && !t.disbanded && t.playerIds.length >= 5).slice(0, 2).map((t) => t.id);
    const t: Tournament = {
      id: 'test-cup4', seriesId: 'test-cup4', name: '测试四强杯', tier: 'major', season: g.season.ti,
      roundIndex: g.roundIndex, startDate: g.currentDate, city: '线上', hostRegion: 'CN', online: true, prizePool: 100000,
      appearanceFee: 0, format: 'se8', teamIds: [A, ai[0], B, ai[1]], invitedTeamIds: [A, ai[0], B, ai[1]], qualifierTeamIds: [],
      stages: [], series: {}, status: 'scheduled', placements: [], playerStatus: 'locked', minHonor: 0, size: 4,
    };
    g.tournaments[t.id] = t;
    g.seasonTournamentIds.push(t.id);
    g.season.rounds[g.roundIndex].tournamentIds.push(t.id);
    t.expectedRanks = { [A]: 1, [B]: 2 };
    initTournamentStages(g, t.id);
    t.status = 'running';
    for (const id of [A, B]) inSeat(g, id, () => { t.playerStatus = 'invited'; t.expectedRank = 2; });
    const aSemi = readySeries(g, t.id).find((s) => s.teamA === A || s.teamB === A)!;
    const opp = aSemi.teamA === A ? aSemi.teamB! : aSemi.teamA!;
    expect(opp).not.toBe(B);
    // A 的半决赛对手无人可上（实力为 0）。胜率 = BP 权重 × 大老师胜率 + 实力权重 × 实力份额，夹在 [finalMin, finalMax]，
    // 实力为 0 的一方仍有小概率赢下单局——本用例只验证「等待对手」的推进逻辑，临时让胜率只取决于实力，A 必胜（不依赖随机分叉）
    for (const pid of g.teams[opp].playerIds) g.players[pid].teamId = null;
    g.teams[opp].playerIds = [];
    g.teams[opp].lineup = { C: null, M: null, O: null, SS: null, HS: null };
    const mc = CONFIG.match as { wDraft: number; wStrength: number; finalMin: number; finalMax: number };
    const saved = { ...mc };
    Object.assign(mc, { wDraft: 0, wStrength: 1, finalMin: 0, finalMax: 1 });
    try {
      expect(call(g, A, 'quickSimSeries').ok).toBe(true);
    } finally {
      Object.assign(mc, { wDraft: saved.wDraft, wStrength: saved.wStrength, finalMin: saved.finalMin, finalMax: saved.finalMax });
    }
    // A 的决赛取决于 B 的半决赛（玩家比赛，赛事自动推进停在这里）
    expect(M.seatBlockers(g, A).some((b) => b.message.includes('尚未确定'))).toBe(true);
    applyHonorChange(g, B, -(g.teams[B].honor + 10), '测试', true);
    call(g, A, 'markAllNewsRead'); // 出局收尾
    expect(M.seatBlockers(g, A).some((b) => b.message.includes('尚未确定'))).toBe(false);
    expect(inSeat(g, A, () => playerNextSeries(g, t.id)?.label)).toBe('决赛');
    expect(call(g, A, 'quickSimSeries').ok).toBe(true);
    expect(g.tournaments[t.id].status).toBe('finished');
    expect(advanceAll(g).ok).toBe(true);
  });
});

describe('multi · RPC 参数校验', () => {
  it('批量操作的非数组参数、训练焦点的继承键都被拒绝，且不产生引擎异常', async () => {
    const g = await buildGame(2);
    const [A] = ids(g);
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      for (const fn of ['releasePlayers', 'listPlayersForTransfer']) {
        for (const bad of [undefined, null, 5, 'x', { length: 2 }]) {
          expect(call(g, A, fn, bad).ok).toBe(false);
        }
        expect(call(g, A, fn, [null, 7, '__proto__']).ok).toBeDefined();
      }
      for (const bad of ['toString', 'constructor', '__proto__', ['power'], 42]) {
        call(g, A, 'setTrainingFocus', bad);
        expect(inSeat(g, A, () => g.trainingFocus)).toBe('balanced');
      }
      call(g, A, 'setTrainingFocus', 'power');
      expect(inSeat(g, A, () => g.trainingFocus)).toBe('power');
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(0);
    expect(g.multiplayer!.activeSeat).toBeNull();
  });
});

describe('multi · 生涯总结', () => {
  it('中途出局的座位：执教区间止于出局赛季', async () => {
    const g = await buildGame(2);
    const [A, B] = ids(g);
    applyHonorChange(g, B, -(g.teams[B].honor + 10), '测试', true);
    call(g, A, 'markAllNewsRead');
    g.season.ti = 10; // 模拟一个赛季后
    const text = multiplayerCareerSummary(g);
    const [partA, partB] = text.split('\n\n');
    expect(partA).toContain('TI9–TI10');
    expect(partB).toContain('（已出局）');
    expect(partB).toContain('TI9–TI9');
  });
});

describe('multi · 视图隐私', () => {
  it('视图只含本座位的私有数据', async () => {
    const g = await buildGame(3);
    const [A, B] = ids(g);
    inSeat(g, A, () => {
      addNews(g, 'finance', 'A 的秘密账目', '只有 A 能看到', false, { teamIds: [A], visibility: 'private' });
      pushPopup(g, { kind: 'message', title: 'A 的弹窗', body: '' });
      g.pendingDecisions.push({ id: 'd-a', kind: 'other', title: 'A 的事务', body: '', choices: [], ctx: {}, createdRound: 0, blocking: false });
    });
    g.delayedEvents = [{ id: 'de-a', kind: 'match_fixing', season: g.season.ti, round: 5, ctx: { teamId: A, playerId: g.teams[A].playerIds[0] } }];
    const va = M.seatView(g, A);
    const vb = M.seatView(g, B);
    expect(va.settings.playerTeamId).toBe(A);
    expect(vb.settings.playerTeamId).toBe(B);
    expect(va.news.some((n) => n.title === 'A 的秘密账目')).toBe(true);
    expect(vb.news.some((n) => n.title === 'A 的秘密账目')).toBe(false);
    expect(va.popups.some((p) => p.kind === 'message' && p.title === 'A 的弹窗')).toBe(true);
    expect(vb.popups.some((p) => p.kind === 'message' && p.title === 'A 的弹窗')).toBe(false);
    expect(vb.pendingDecisions.some((d) => d.id === 'd-a')).toBe(false);
    expect(vb.finance.every((f) => !f.note.includes('A '))).toBe(true);
    expect(vb.delayedEvents).toHaveLength(0);
    expect(va.delayedEvents).toHaveLength(1);
    for (const v of [va, vb]) {
      for (const s of Object.values(v.multiplayer!.seats)) expect(s.saved).toEqual({});
    }
    expect(vb.multiplayer!.seats[A].sessionId).toBe('');
    expect(vb.multiplayer!.seats[B].sessionId).toBe('sess-1');
    // 视图是深拷贝：修改视图不影响服务器状态
    vb.teams[B].gold = -1;
    expect(g.teams[B].gold).not.toBe(-1);
    expect(g.multiplayer!.activeSeat).toBeNull();
  });

  it('同一赛事多名玩家参赛：各自的开赛简报（预期名次）只在本座位可见，公开动态为「出征」', async () => {
    const g = await buildGame(2, 41);
    const [A, B] = ids(g);
    // 两名玩家报名第 1 回合同一项开放赛事
    const tid = g.seasonTournamentIds.find((x) => {
      const t = g.tournaments[x];
      return t.roundIndex === 1 && t.minHonor <= 100 && !t.regionLocked && call(g, A, 'registerForTournament', x).ok;
    });
    expect(tid).toBeTruthy();
    if (!tid) return;
    expect(call(g, B, 'registerForTournament', tid).ok).toBe(true);
    expect(advanceAll(g).ok).toBe(true);
    const name = g.tournaments[tid].name;
    const briefs = g.news.filter((n) => n.title === `${name} 开赛`);
    expect(briefs.length).toBeGreaterThanOrEqual(2);
    expect(briefs.every((n) => n.visibility === 'private')).toBe(true);
    for (const id of [A, B]) {
      const mine = M.seatView(g, id).news.filter((n) => n.title === `${name} 开赛`);
      expect(mine).toHaveLength(1);
      expect(mine[0].actorTeamId).toBe(id);
    }
    expect(g.news.filter((n) => n.title === `出征 ${name}` && n.visibility === 'public').length).toBeGreaterThanOrEqual(2);
  });
});

describe('multi · 单机回归', () => {
  it('单机对局不受多人改造影响：无 multiplayer 字段、推进/训练/账目照旧', async () => {
    const sp = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: '单机', newClub: CLUBS[0], seed: 21 });
    const me = sp.settings.playerTeamId;
    expect(sp.multiplayer).toBeUndefined();
    expect(sp.settings.managerName).toBe('单机');
    const gold0 = sp.teams[me].gold - sp.finance.reduce((a, f) => a + f.amount, 0);
    for (let i = 0; i < 8; i++) {
      while (sp.pendingDecisions.length) {
        const d = sp.pendingDecisions[0];
        M.withSeat(sp, me, () => undefined);
        const r = (await import('../src/engine/events')).resolveDecision(sp, d.id, d.choices[0]?.id ?? '');
        if (sp.pendingDecisions[0] === d) sp.pendingDecisions.shift();
        void r;
      }
      (await import('../src/engine/game')).quickSimTournament(sp);
      doTraining(sp);
      expect(advance(sp).ok).toBe(true);
    }
    expect(sp.roundIndex).toBe(8);
    expect(sp.history.honor.length).toBeGreaterThan(0);
    // 账目全部记在单机玩家的 finance 中
    expect(sp.teams[me].gold).toBe(gold0 + sp.finance.reduce((a, f) => a + f.amount, 0));
    // 视图 = 深拷贝
    const v = M.seatView(sp, me);
    expect(v).not.toBe(sp);
    expect(v.teams[me].gold).toBe(sp.teams[me].gold);
  });

  it('单机同一种子两次结果一致（确定性）', async () => {
    const run = async () => {
      const sp = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: 'D', newClub: CLUBS[1], seed: 99 });
      const g = await import('../src/engine/game');
      for (let i = 0; i < 5; i++) {
        while (sp.pendingDecisions.length) {
          const d = sp.pendingDecisions[0];
          (await import('../src/engine/events')).resolveDecision(sp, d.id, d.choices[0]?.id ?? '');
          if (sp.pendingDecisions[0] === d) sp.pendingDecisions.shift();
        }
        g.quickSimTournament(sp);
        g.advance(sp);
      }
      const { createdAt: _c, ...rest } = sp;
      return JSON.stringify(rest);
    };
    expect(await run()).toBe(await run());
  });
});
