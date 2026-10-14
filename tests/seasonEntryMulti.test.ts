// 赛季中报名 / 退赛、补充邀请与荣誉势头（第十四波）在多人模式下：补充邀请的通知 / 新闻与报名回合是座位私有的，
// 退赛扣荣誉经 callAsSeat 按座位计算；真实对局中回合结算会产生补充邀请与全部战队的势头记录。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Tournament } from '../src/engine/types';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import * as M from '../src/engine/multi';
import { refreshSeasonInvites, withdrawPenaltyOf } from '../src/engine/schedule';
import { RPC_WHITELIST } from '../src/shared/protocol';
import { advance, createNewGame } from '../src/engine/game';

beforeAll(() => {
  registerNodeRosterLoader();
});

const CLUBS = [
  { name: 'Alpha Club', tag: 'ALP', region: 'CN' as const, color: '#c23c2a' },
  { name: 'Beta Club', tag: 'BET', region: 'EU' as const, color: '#3a7bd5' },
];

async function buildGame(seed = 21): Promise<GameState> {
  return M.createMultiplayerGame({
    startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed,
    players: CLUBS.map((c, i) => ({ sessionId: `sess-${i}`, name: `玩家${i + 1}`, newClub: c })),
  });
}

const call = (g: GameState, id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;

function resolveAll(g: GameState, id: string): void {
  for (let i = 0; i < 30; i++) {
    const d = M.withSeat(g, id, () => g.pendingDecisions[0]);
    if (!d) return;
    let r = call(g, id, 'resolveDecision', d.id, d.choices[0]?.id ?? '');
    if (!r.ok) for (const c of d.choices) if ((r = call(g, id, 'resolveDecision', d.id, c.id)).ok) break;
  }
}

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

const lateTitle = (t: string) => t.startsWith('【补充邀请】');

describe('多人 · 补充邀请与退赛扣荣誉', () => {
  it('补充邀请只对收到的座位可见（通知 / 新闻 / 报名状态 / 报名回合）；收到的回合内婉拒免扣，之后按座位扣荣誉', async () => {
    const g = await buildGame();
    const [A, B] = g.multiplayer!.order;
    expect(RPC_WHITELIST).toEqual(expect.arrayContaining(['registerForTournament', 'unregisterFromTournament']));
    expect(advanceAll(g).ok).toBe(true); // 赛季初 → 第 1 回合
    expect(g.roundIndex).toBe(1);
    // A 本赛季积分遥遥领先（B 没有积分）
    for (const id in g.teams) g.teams[id].points = 0;
    g.teams[A].points = 99999;
    expect(g.multiplayer!.activeSeat).toBeNull();
    refreshSeasonInvites(g);
    const late = g.seasonTournamentIds.map((id) => g.tournaments[id])
      .filter((t): t is Tournament => !!t && t.lateInvites?.[A] !== undefined);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((t) => t.roundIndex >= 3)).toBe(true); // 至少提前一个回合通知
    expect(g.seasonTournamentIds.some((id) => g.tournaments[id]?.lateInvites?.[B] !== undefined)).toBe(false);

    const va = M.seatView(g, A);
    const vb = M.seatView(g, B);
    expect(va.popups.some((p) => p.kind === 'message' && lateTitle(p.title))).toBe(true);
    expect(vb.popups.some((p) => p.kind === 'message' && lateTitle(p.title))).toBe(false);
    expect(va.news.some((n) => lateTitle(n.title))).toBe(true);
    expect(vb.news.some((n) => lateTitle(n.title))).toBe(false);
    // 取开赛最晚的一项（第 3 回合时仍未开赛，用来验证之后退出要扣荣誉）
    const accepted = late.filter((t) => va.tournaments[t.id].playerStatus === 'invited')
      .sort((a, b) => b.roundIndex - a.roundIndex)[0];
    expect(accepted).toBeTruthy();
    expect(accepted.roundIndex).toBeGreaterThanOrEqual(4);
    expect(va.tournaments[accepted.id].entryRound).toBe(2);
    expect(vb.tournaments[accepted.id].entryRound).toBeUndefined();
    expect(vb.tournaments[accepted.id].playerStatus).not.toBe('invited');

    // 第 2 回合：A 婉拒刚收到的补充邀请不扣荣誉
    expect(advanceAll(g).ok).toBe(true);
    expect(g.roundIndex).toBe(2);
    const honorA = g.teams[A].honor;
    const pen = M.withSeat(g, A, () => withdrawPenaltyOf(g, accepted.id));
    expect(pen?.free).toBe(true);
    const r = call(g, A, 'unregisterFromTournament', accepted.id);
    expect(r.ok, r.message).toBe(true);
    expect(g.teams[A].honor).toBe(honorA);
    expect(M.seatView(g, A).tournaments[accepted.id].playerStatus).toBe('declined');
    // 重新接受，再到下一回合退出：按 A 的报名回合扣 A 的荣誉，B 不受影响
    expect(call(g, A, 'registerForTournament', accepted.id).ok).toBe(true);
    expect(advanceAll(g).ok).toBe(true);
    const t = g.tournaments[accepted.id];
    expect(g.roundIndex).toBe(3);
    expect(t.status).toBe('scheduled');
    const before = { a: g.teams[A].honor, b: g.teams[B].honor };
    const cost = M.withSeat(g, A, () => withdrawPenaltyOf(g, t.id))!;
    expect(cost.free).toBe(false);
    expect(cost.honor).toBeLessThan(0);
    expect(call(g, A, 'unregisterFromTournament', t.id).ok).toBe(true);
    expect(g.teams[A].honor).toBe(before.a + cost.honor);
    expect(g.teams[B].honor).toBe(before.b);
    // 婉拒 / 退赛新闻与原来一样是公开动态（荣誉本身公开），写明扣分原因
    const news = M.seatView(g, B).news.find((n) => n.title.includes('【婉拒邀请】') && n.title.includes(g.teams[A].name));
    expect(news?.body).toContain(`俱乐部荣誉 −${-cost.honor}`);
  }, 60000);

  it('真实对局：回合结算为 AI 补发邀请（只增不撤），全部战队有势头记录', async () => {
    const g = await buildGame(33);
    const before = new Map<string, string[]>();
    expect(advanceAll(g).ok).toBe(true);
    for (const id of g.seasonTournamentIds) before.set(id, g.tournaments[id].invitedTeamIds.slice());
    for (let i = 0; i < 6; i++) expect(advanceAll(g).ok).toBe(true);
    let late = 0;
    for (const id of g.seasonTournamentIds) {
      const t = g.tournaments[id];
      late += Object.keys(t.lateInvites ?? {}).length;
      // 已有邀请不撤销：赛季初的名单是现在名单的前缀
      const b = before.get(id) ?? [];
      expect(t.invitedTeamIds.slice(0, b.length)).toEqual(b);
    }
    expect(late).toBeGreaterThan(0);
    for (const t of Object.values(g.teams)) {
      if (t.disbanded) continue;
      expect(t.momentum).toBeTruthy();
      expect(Number.isFinite(t.momentum!.ewma)).toBe(true);
    }
  }, 60000);

  it('单机懒人自动推进（下一回合 · 自动处理）不会替玩家退赛或婉拒；整季确定性', async () => {
    const run = async () => {
      const g = await createNewGame({ startTi: 9, seasons: 1, difficulty: 'normal', managerName: 'T', teamId: 'keen-gaming', seed: 77 });
      const me = g.settings.playerTeamId;
      const ti = g.season.ti;
      for (let i = 0; i < 40 && !g.gameOver && g.season.ti === ti; i++) {
        const r = advance(g, { auto: true });
        expect(r.ok, r.message).toBe(true);
      }
      const mine = g.news.filter((n) => n.title.startsWith('【退赛】') || (n.title.startsWith('【婉拒邀请】') && n.round > 0));
      expect(mine).toEqual([]);
      return JSON.stringify({
        honor: g.history.honor,
        momentum: Object.values(g.teams).map((t) => t.momentum ?? null),
        late: Object.values(g.tournaments).map((t) => t.lateInvites ?? null),
        me: g.teams[me]?.honor,
      });
    };
    expect(await run()).toBe(await run());
  }, 60000);
});
