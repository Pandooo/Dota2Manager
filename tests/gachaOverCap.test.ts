// 抽卡超编（2026-10-15 用户决策「十连后本回合内退回到 12 人」）：十连 / 单抽总是抽满，可以让正式阵容超过绝对上限（12 人）；
// 超编期间不能进入下一回合（getAdvanceBlockers 的 roster_over_cap），须在本回合内放弃本回合抽到的新秀或解约 / 出售其他队员；
// 懒人推进 / 多人托管自动处理（先退回本回合抽到的新秀中评分最低者，仍超编再解约替补中「解约补偿 + 身价」最低者）。
// 另：team.setLineupSlot / autoLineup 只认自有键的战队 id（'__proto__' / 'constructor' 不能写 Object.prototype）。
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Player } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { gachaDiscard, gachaDiscardRefund, gachaPull, gachaPullBlock, startGachaSeason } from '../src/engine/gacha';
import { advance, getAdvanceBlockers, previewAutoActions } from '../src/engine/game';
import { planOverCapTrim } from '../src/engine/autoRound';
import { listPlayerForTransfer } from '../src/engine/squadOps';
import { executeTransfer, releaseCompensation, releasePlayer } from '../src/engine/market';
import { payTournamentPrize, prizeShareOf, prizeShareStatus, splitPrize } from '../src/engine/prizeShare';
import { bankruptcyStatus, debtLimitOf } from '../src/engine/bankruptcy';
import { brandHistoryOf } from '../src/engine/branding';
import { bookScrim, isScrimBooked, scrimBookedIds } from '../src/engine/trainingLog';
import { marketValue, overallRating } from '../src/engine/player';
import { autoLineup, rosterOverCap, rosterOverCapNotice, rosterSize, setLineupSlot, teamOf } from '../src/engine/team';
import { generatePlayer } from '../src/engine/generation';
import { addFinance, scrimCost } from '../src/engine/economy';
import { applyHonorChange, changeHonor } from '../src/engine/honor';
import * as M from '../src/engine/multi';
import { makePlayer, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

const HARD = CONFIG.team.hardMaxRoster;

/** 测试局（TI9 赛季初，转会窗口开放）：开好卡池、资金充足 */
function pullState(): GameState {
  const s = makeTestState(4);
  startGachaSeason(s);
  s.teams.t0.gold = 5_000_000;
  return s;
}

/** 本回合抽到的新秀（在队） */
function pulledHere(s: GameState): Player[] {
  return s.teams.t0.playerIds.map((id) => s.players[id]).filter((p) => p.gacha?.round === s.roundIndex && p.gacha.teamId === 't0');
}

describe('抽卡超编 · 规则', () => {
  it('十连总是抽满（5 + 10 = 15 人）；超编时推进被挡住，说明超编人数；放弃新秀 / 解约退回 12 人后可以推进（挂牌不算）', () => {
    const s = pullState();
    expect(gachaPullBlock(s, 10)).toBeNull();
    const r = gachaPull(s, 10);
    expect(r.ok, r.message).toBe(true);
    expect(r.results).toHaveLength(10);
    expect(rosterSize(s, 't0')).toBe(15);
    expect(rosterOverCap(s, 't0')).toBe(3);
    expect(r.message).toContain(`超编 3 人：本回合内放弃新秀或解约 3 人（降到 ${HARD} 人以内）后才能进入下一回合`);
    expect(s.news.some((n) => n.title.includes('十连') && n.body.includes('超编 3 人'))).toBe(true);
    const bl = getAdvanceBlockers(s).find((b) => b.code === 'roster_over_cap')!;
    expect(bl.message).toBe(rosterOverCapNotice(s, 't0'));
    expect(bl.message).toBe(`超编 3 人：本回合内放弃新秀或解约 3 人（降到 ${HARD} 人以内）后才能进入下一回合`);
    expect(advance(s).ok).toBe(false);
    expect(s.phase).toBe('preseason');
    // 超编时不能再抽
    expect(gachaPullBlock(s, 1)).toContain('超编');
    // 放弃本回合抽到的新秀（返还部分费用）
    const [a, b] = pulledHere(s);
    const gold = s.teams.t0.gold;
    expect(gachaDiscard(s, a.id).ok).toBe(true);
    expect(s.teams.t0.gold).toBe(gold + gachaDiscardRefund(s));
    expect(rosterOverCap(s, 't0')).toBe(2);
    // 挂牌不算（成交离队后才算）
    const veteran = s.players['t0-C'];
    const listed = listPlayerForTransfer(s, veteran.id) as OpResult;
    expect(listed.ok, listed.message).toBe(true);
    expect(rosterOverCap(s, 't0')).toBe(2);
    // 解约其他队员（正常补偿与荣誉规则）
    const rel = releasePlayer(s, 't0-M');
    expect(rel.ok, rel.message).toBe(true);
    expect(rosterOverCap(s, 't0')).toBe(1);
    expect(getAdvanceBlockers(s).map((x) => x.code)).toContain('roster_over_cap');
    // 解约本回合抽到的新秀 = 退回
    expect(releasePlayer(s, b.id).ok).toBe(true);
    expect(s.players[b.id].teamId).toBeNull();
    expect(rosterSize(s, 't0')).toBe(HARD);
    expect(getAdvanceBlockers(s)).toEqual([]);
    expect(gachaPullBlock(s, 1)).toBeNull(); // 退回 12 人后又可以抽（单抽可再超出 1 人）
    expect(advance(s).ok).toBe(true);
  });

  it('单抽同样可以超出 1 人（12 → 13），同一规则', () => {
    const s = pullState();
    expect(gachaPull(s, 1).ok).toBe(true);
    while (rosterSize(s, 't0') < HARD) {
      const p = makePlayer({ teamId: 't0', position: 'HS' });
      s.players[p.id] = p;
      s.teams.t0.playerIds.push(p.id);
    }
    expect(gachaPullBlock(s, 1)).toBeNull();
    const r = gachaPull(s, 1);
    expect(r.ok).toBe(true);
    expect(rosterOverCap(s, 't0')).toBe(1);
    expect(getAdvanceBlockers(s).map((b) => b.code)).toEqual(['roster_over_cap']);
  });
});

describe('抽卡超编 · 懒人推进自动处理', () => {
  it('先退回本回合抽到的新秀中评分最低者（返还），预览与执行逐人一致；写进「本回合自动处理」私有新闻', () => {
    const s = pullState();
    gachaPull(s, 10);
    const pulled = pulledHere(s);
    const lowest = pulled.slice().sort((a, b) => overallRating(a) - overallRating(b) || (a.id < b.id ? -1 : 1)).slice(0, 3).map((p) => p.id);
    const snap = JSON.stringify(s);
    const pv = previewAutoActions(s);
    expect(JSON.stringify(s)).toBe(snap); // 纯预览
    expect(pv.overCap).toBe(3);
    expect(pv.overCapLeft).toBe(0);
    expect(pv.trims.map((x) => x.action)).toEqual(['discard', 'discard', 'discard']);
    expect(pv.trims.map((x) => x.playerId)).toEqual(lowest);
    expect(pv.items.join(' · ')).toContain('处理超编 3 人：退回本回合抽到的新秀');
    expect(pv.blocked).toBeNull();
    const refund = gachaDiscardRefund(s);
    const r = advance(s, { auto: true });
    expect(r.ok, r.message).toBe(true);
    expect(r.autoActions?.filter((l) => l.startsWith('超编：自动退回本回合抽到的新秀'))).toHaveLength(3);
    for (const id of lowest) expect(s.players[id].teamId).toBeNull();
    expect(rosterSize(s, 't0')).toBe(HARD);
    const refunds = s.finance.filter((f) => f.category === 'gacha' && f.amount > 0 && f.note.startsWith('退回新秀'));
    expect(refunds).toHaveLength(3);
    for (const f of refunds) expect(f.amount).toBe(refund);
    const news = s.news.find((n) => n.tags?.includes('auto_round'))!;
    expect(news.title).toContain('处理超编：退回 3 名新秀');
    expect(news.visibility).toBe('private');
  });

  it('退回仍不够时解约替补中「解约补偿 + 身价」最低者（不动首发，合同到期的无补偿）；之后才能推进', () => {
    const s = pullState();
    // 12 名正式队员 + 本回合单抽 1 张 + 再多 1 人（旧存档式的超编）→ 超编 2 人，只有 1 张可退回
    while (rosterSize(s, 't0') < HARD - 1) {
      const p = makePlayer({ teamId: 't0', position: 'SS', salary: 20000, contractUntil: 11, mmr: 10500, power: 85 });
      s.players[p.id] = p;
      s.teams.t0.playerIds.push(p.id);
    }
    const cheap = makePlayer({ id: 'cheap', teamId: 't0', position: 'HS', salary: 3000, contractUntil: 9, mmr: 6000, power: 55 });
    const expired = makePlayer({ id: 'expired', teamId: 't0', position: 'O', salary: 30000, contractUntil: 8, mmr: 7000, power: 60 });
    s.players.cheap = cheap;
    s.players.expired = expired;
    s.teams.t0.playerIds.push('cheap');
    expect(rosterSize(s, 't0')).toBe(HARD);
    expect(gachaPull(s, 1).ok).toBe(true);
    expect(rosterOverCap(s, 't0')).toBe(1);
    s.teams.t0.playerIds.push('expired');
    expect(rosterOverCap(s, 't0')).toBe(2);
    const plan = planOverCapTrim(s);
    expect(plan.over).toBe(2);
    expect(plan.left).toBe(0);
    expect(plan.trims[0].action).toBe('discard');
    expect(plan.trims[0].playerId).toBe(pulledHere(s)[0].id);
    // 解约：替补中「解约补偿 + 身价」最低者
    const starters = new Set(Object.values(s.teams.t0.lineup));
    const bench = s.teams.t0.playerIds.map((id) => s.players[id])
      .filter((p) => !starters.has(p.id) && p.id !== plan.trims[0].playerId)
      .map((p) => ({ id: p.id, cost: releaseCompensation(s, p.id) + marketValue(s, p) }))
      .sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : 1));
    expect(plan.trims[1]).toMatchObject({ action: 'release', playerId: bench[0].id, amount: releaseCompensation(s, bench[0].id) });
    expect(starters.has(plan.trims[1].playerId)).toBe(false);
    expect(['cheap', 'expired']).toContain(plan.trims[1].playerId);
    if (plan.trims[1].playerId === 'expired') expect(plan.trims[1]).toMatchObject({ amount: 0, expired: true });
    // 执行
    const r = advance(s, { auto: true });
    expect(r.ok, r.message).toBe(true);
    expect(r.autoActions?.some((l) => l.startsWith('超编：自动解约替补'))).toBe(true);
    expect(s.players[plan.trims[1].playerId].teamId).toBeNull();
    expect(rosterSize(s, 't0')).toBe(HARD);
  });

  it('不带 auto 的推进不自动处理；转会窗口锁定时不处理也不阻塞', () => {
    const s = pullState();
    gachaPull(s, 10);
    expect(advance(s).ok).toBe(false);
    expect(rosterOverCap(s, 't0')).toBe(3);
    s.phase = 'ti';
    expect(planOverCapTrim(s).trims).toEqual([]);
    expect(getAdvanceBlockers(s).map((b) => b.code)).not.toContain('roster_over_cap');
  });
});

describe('抽卡超编 · 多人', () => {
  async function room() {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 17,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    for (const id of [A, B]) g.teams[id].gold = 8_000_000;
    // 赛季初的待决事件先处理掉（只看超编）
    for (const id of [A, B]) {
      for (let k = 0; k < 10; k++) {
        const d = M.withSeat(g, id, () => g.pendingDecisions.find((x) => x.blocking));
        if (!d) break;
        M.callAsSeat(g, id, 'resolveDecision', [d.id, d.choices[0].id]);
      }
    }
    return { g, A, B };
  }

  it('超编的座位不能准备（已准备的被撤销）；「下一回合」自动处理 / 房主托管退回到 12 人后准备，处理记录只进本座位', async () => {
    const { g, A, B } = await room();
    const size = (id: string) => M.withSeat(g, id, () => rosterSize(g, id));
    expect(M.setSeatReady(g, A, true).ok).toBe(true);
    const r = M.callAsSeat(g, A, 'gachaPull', [10]) as OpResult;
    expect(r.ok, r.message).toBe(true);
    expect(size(A)).toBeGreaterThan(HARD);
    expect(g.multiplayer!.seats[A].ready).toBe(false); // 抽卡后超编：准备被撤销
    expect(M.seatBlockers(g, A).map((b) => b.code)).toContain('roster_over_cap');
    const no = M.setSeatReady(g, A, true);
    expect(no.ok).toBe(false);
    expect(no.message).toContain('超编');
    // 「下一回合」（auto）：先退回再准备
    const yes = M.setSeatReady(g, A, true, { auto: true });
    expect(yes.ok, yes.message).toBe(true);
    expect(yes.message).toContain('超编：自动退回本回合抽到的新秀');
    expect(size(A)).toBe(HARD);
    expect(g.multiplayer!.seats[A].ready).toBe(true);
    // 房主托管（离线座位）同一路径
    expect((M.callAsSeat(g, B, 'gachaPull', [10]) as OpResult).ok).toBe(true);
    expect(size(B)).toBeGreaterThan(HARD);
    const ap = M.autopilotSeat(g, B);
    expect(ap.ok, ap.message).toBe(true);
    expect(ap.message).toContain('超编：自动退回本回合抽到的新秀');
    expect(size(B)).toBe(HARD);
    expect(g.multiplayer!.seats[B].ready).toBe(true);
    // 自动处理新闻是座位私有的
    const viewA = M.seatView(g, A);
    const viewB = M.seatView(g, B);
    const autoNews = (v: GameState) => v.news.filter((n) => n.tags?.includes('auto_round'));
    expect(autoNews(viewA).every((n) => n.actorTeamId === A)).toBe(true);
    expect(autoNews(viewB).every((n) => n.actorTeamId === B)).toBe(true);
    expect(M.advanceMultiplayer(g).ok).toBe(true);
  });

  it('已按「下一回合」等待自动准备的座位抽卡超编：撤销自动准备的意图（不立刻替玩家退回刚抽到的新秀）', async () => {
    const { g, A } = await room();
    const seat = g.multiplayer!.seats[A];
    seat.autoReady = true; // 模拟「下一回合」后仍在等待其他玩家
    seat.ready = false;
    const r = M.callAsSeat(g, A, 'gachaPull', [10]) as OpResult;
    expect(r.ok, r.message).toBe(true);
    expect(seat.autoReady).toBeUndefined();
    expect(M.withSeat(g, A, () => rosterOverCap(g, A))).toBeGreaterThan(0); // 新秀仍在队
    expect(seat.ready).toBe(false);
  });
});

/** 加固测试检查的 Object.prototype 键（被误写时 afterEach 清理，避免污染其他测试） */
const PROTO_KEYS = ['lineup', 'gold', 'honor', 'playerIds', 'prizeShare', 'finances', 'scrimBookings', 'brandHistory', 'name'];

describe('teamId 只认自有键（加固）', () => {
  afterEach(() => {
    for (const k of PROTO_KEYS) delete (Object.prototype as Record<string, unknown>)[k];
  });

  it("setLineupSlot / autoLineup（及资金 / 荣誉等接受 teamId 的函数）传入 '__proto__' / 'constructor' 不会写到 Object.prototype；非法位置被忽略", () => {
    const s = makeTestState(4);
    const id = s.teams.t0.playerIds[0];
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(teamOf(s, bad)).toBeUndefined();
      setLineupSlot(s, bad, 'C', id);
      setLineupSlot(s, bad, 'C', null);
      autoLineup(s, bad);
      autoLineup(s, bad, 'x');
      expect(rosterSize(s, bad)).toBe(0);
      expect(rosterOverCap(s, bad)).toBe(0);
    }
    // 其他接受 teamId 的引擎函数（资金 / 荣誉）同样只认自有键
    // 奖金分成 / 转会 / 训练赛 / 破产 / 品牌沿革（审查补充：`teams?.[id]` 写法同样改为自有键）
    const moved = s.teams.t1.playerIds[s.teams.t1.playerIds.length - 1];
    for (const bad of ['__proto__', 'constructor', 'hasOwnProperty']) {
      addFinance(s, bad, 1000, 'other', '测试');
      changeHonor(s, bad, 5, '测试');
      expect(applyHonorChange(s, bad, 5, '测试', false)).toBe(0);
      expect(payTournamentPrize(s, bad, 100_000, '测试赛事')).toMatchObject({ total: 100_000, club: 100_000, players: 0 });
      expect(splitPrize(s, bad, 100_000).players).toBe(0);
      expect(prizeShareOf(s, bad)).toBe(prizeShareOf(s, null));
      expect(prizeShareStatus(s, bad).reason).toBeTruthy();
      expect(executeTransfer(s, moved, bad, 0)).toBe(false);
      expect(s.players[moved].teamId).toBe('t1');
      expect(executeTransfer(s, bad, 't0', 0)).toBe(false);
      expect(Number.isFinite(scrimCost(s, bad))).toBe(true);
      bookScrim(s, 't1', bad);
      expect(scrimBookedIds(s, bad)).toEqual([]);
      expect(isScrimBooked(s, 't1', bad)).toBe(false);
      expect(bankruptcyStatus(s, bad).negative).toBe(false);
      expect(debtLimitOf(s, bad)).toBeNull();
      expect(brandHistoryOf(s, bad)).toEqual([]);
    }
    for (const k of PROTO_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, k), k).toBe(false);
      expect(({} as Record<string, unknown>)[k], k).toBeUndefined();
    }
    // 位置参数同样只接受五个首发位
    const before = JSON.stringify(s.teams.t0.lineup);
    setLineupSlot(s, 't0', '__proto__' as never, id);
    setLineupSlot(s, 't0', 'constructor' as never, id);
    expect(JSON.stringify(s.teams.t0.lineup)).toBe(before);
    expect(Object.getPrototypeOf(s.teams.t0.lineup)).toBe(Object.prototype);
    // 正常调用不受影响
    const p = generatePlayer(s, { tier: 'B', position: 'C' });
    s.players[p.id].teamId = 't0';
    s.teams.t0.playerIds.push(p.id);
    setLineupSlot(s, 't0', 'C', p.id);
    expect(s.teams.t0.lineup.C).toBe(p.id);
  });
});
