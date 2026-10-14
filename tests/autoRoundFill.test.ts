// 「下一回合」自动处理 · 自动补员（src/engine/autoRound.ts planRosterFill / autoHandleRound；CONFIG.autoRound）：
// 选秀取消后只按「下一回合」的人类战队不再自动得到新秀——转会窗口开放期间，正式阵容不能覆盖五个位置或少于 minRosterFill 人时，
// 签下负担得起、愿意加盟的自由选手（先补缺失的位置，再补替补深度；先挑签下后收入仍付得起工资的人选）；预览逐人列出且与实际一致
// （有待决事件时先按默认选项处理，本回合因事件离队的选手不签回）；窗口关闭 / 资金不足时不签，并说明原因；
// 多人模式按座位执行、自动处理记录只给本座位，客户端视图（无谈判密钥）预览注明「婉拒则顺延」。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Player, Position } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { AUTO_ROUND_NEWS_TAG, advance, autoHandleRound, createNewGame, previewAutoActions } from '../src/engine/game';
import { planRosterFill } from '../src/engine/autoRound';
import { departToFreeAgency, freeAgents, negotiationRoll, playerWillingness, signingFee } from '../src/engine/market';
import { formatGold } from '../src/engine/util';
import { signingSalary } from '../src/engine/salary';
import { roundWageBill } from '../src/engine/economy';
import { roundRevenue } from '../src/engine/revenue';
import { playsNaturally, uncoveredPositions } from '../src/engine/roles';
import { playerRating } from '../src/engine/player';
import { addPlayerToTeam, autoLineup, teamPlayers } from '../src/engine/team';
import * as M from '../src/engine/multi';

beforeAll(() => {
  registerNodeRosterLoader();
});

const clone = <T>(v: T): T => structuredClone(v);

function regular(s: GameState, teamId = s.settings.playerTeamId): Player[] {
  return teamPlayers(s, teamId).filter((p) => !p.tempSubUntilTournament && !p.isWildSub);
}

/** 签下后每回合经常性收入（赞助 + 直播 + 周边）与工资的差额（> 0 = 收入付得起） */
function surplus(s: GameState, me: string): number {
  const rv = roundRevenue(s, s.teams[me]);
  return rv.total - rv.merchBoost - roundWageBill(s, me);
}

/** 把正式队员的工资整体平移，使每回合经常性收入 − 工资 = target */
function setSurplus(s: GameState, me: string, target: number): void {
  const ps = regular(s, me);
  const delta = (surplus(s, me) - target) / ps.length;
  for (const p of ps) p.salary = Math.max(0, Math.round(p.salary + delta));
}

/** 新俱乐部单机局（赛季初，转会窗口开放）：送走某个位置的首发，正式阵容 4 人、缺该位置 */
async function shortGame(seed = 21, pos: Position = 'HS'): Promise<{ s: GameState; me: string; gone: Player }> {
  const s = await createNewGame({
    startTi: 9, seasons: 2, difficulty: 'normal', managerName: '补员', seed,
    newClub: { name: 'Fill Club', tag: 'FIL', region: 'CN', color: '#2a7bc2' },
  });
  const me = s.settings.playerTeamId;
  expect(s.phase).toBe('preseason');
  const gone = s.players[s.teams[me].lineup[pos]!];
  departToFreeAgency(s, gone.id);
  expect(regular(s)).toHaveLength(4);
  expect(uncoveredPositions(regular(s))).toEqual([pos]);
  return { s, me, gone };
}

describe('autoRound · 自动补员（单机）', () => {
  it('缺一个位置：预览逐人列出补位人选（纯函数），自动处理签下同一人、补上空着的首发位；记录写进私有新闻', async () => {
    const { s, me } = await shortGame();
    s.teams[me].gold = 2_000_000;
    const snap = JSON.stringify(s);
    const pv = previewAutoActions(s);
    expect(JSON.stringify(s)).toBe(snap);
    expect(pv.rosterFillExact).toBe(true);
    expect(pv.signings.length).toBeGreaterThanOrEqual(1);
    const first = pv.signings[0];
    expect(first.reason).toBe('cover');
    expect(first.position).toBe('HS');
    expect(playsNaturally(s.players[first.playerId], 'HS')).toBe(true);
    expect(pv.items[0]).toMatch(new RegExp(`^签下自由选手 ${first.handle}（`));
    expect(pv.text).toMatch(/^将自动：签下自由选手 /);
    expect(pv.items[0]).toContain('五号位）补位，签字费');
    expect(pv.text).toContain(first.handle);
    // 默认只补到 5 人（minRosterFill = 5）；目标多于 5 人时替补深度只在经常性收入付得起时签
    expect(pv.signings.length).toBeLessThanOrEqual(Math.max(1, CONFIG.autoRound.minRosterFill - 4));

    const gold0 = s.teams[me].gold;
    const rep = autoHandleRound(s);
    expect(rep.signings.map((x) => x.playerId)).toEqual(pv.signings.map((x) => x.playerId));
    expect(rep.signingFees).toBe(pv.signings.reduce((a, x) => a + x.fee, 0));
    expect(s.teams[me].gold).toBe(gold0 - rep.signingFees);
    const p = s.players[first.playerId];
    expect(p.teamId).toBe(me);
    expect(s.teams[me].lineup.HS).toBe(p.id);
    expect(uncoveredPositions(regular(s))).toEqual([]);
    expect(rep.lines.some((l) => l.startsWith(`自动签下自由选手 ${first.handle}`))).toBe(true);
    const news = s.news.filter((n) => n.tags?.includes(AUTO_ROUND_NEWS_TAG));
    expect(news).toHaveLength(1);
    expect(news[0].title).toContain(`签下 ${rep.signings.length} 名自由选手`);
    expect(news[0].visibility).toBe('private');
    // 补员后无事可做：再次预览不再列出补员，再次处理不改动状态（同一回合重复调用是空操作）
    expect(previewAutoActions(s).signings).toEqual([]);
    const snap2 = JSON.stringify(s);
    autoHandleRound(s, { news: false });
    expect(JSON.stringify(s)).toBe(snap2);
  });

  it('人选：该位置评分最高的本职自由选手中，第一个预算允许且不会婉拒的（与 signFreeAgent 同一枚谈判骰子）；婉拒的被跳过', async () => {
    const { s, me } = await shortGame(21);
    s.teams[me].gold = 2_000_000;
    expect(surplus(s, me)).toBeLessThan(0); // 新俱乐部已入不敷出：没有「收入付得起」的人选，按评分挑
    const plan = planRosterFill(s);
    const pick = plan.picks[0];
    expect(pick).toBeTruthy();
    const cands = freeAgents(s)
      .filter((p) => playsNaturally(p, 'HS'))
      .sort((a, b) => playerRating(b, 'HS') - playerRating(a, 'HS') || (a.id < b.id ? -1 : 1));
    const idx = cands.findIndex((p) => p.id === pick.playerId);
    expect(idx).toBeGreaterThan(0); // 本种子排在前面的人选会婉拒（覆盖跳过婉拒的路径）
    const accepts = (p: Player) => negotiationRoll(s, `sign|${p.id}|${me}`) < playerWillingness(s, p.id, me);
    expect(accepts(s.players[pick.playerId])).toBe(true);
    // 排在前面的人选：资金充足时只可能因为会婉拒而被跳过
    for (const p of cands.slice(0, idx)) expect(accepts(p)).toBe(false);
  });

  it('预算：付完签字费后余额 ≥（工资 + 新签工资）× reserveRounds；入不敷出时只允许首发、且余额能覆盖 coverDeficitRounds 回合的缺口', async () => {
    const C = CONFIG.autoRound;
    for (const gold of [2_000_000, 300_000, 150_000]) {
      const { s, me } = await shortGame(45);
      s.teams[me].gold = gold;
      const plan = planRosterFill(s);
      let g = gold;
      let wages = roundWageBill(s, me);
      const rv = roundRevenue(s, s.teams[me]);
      const income = rv.total - rv.merchBoost;
      let size = regular(s).length;
      for (const x of plan.picks) {
        const p = s.players[x.playerId];
        expect(x.fee).toBe(signingFee(s, p));
        expect(x.salary).toBe(signingSalary(s, p, me));
        const left = g - x.fee;
        const w = wages + x.salary;
        expect(left).toBeGreaterThanOrEqual(w * C.reserveRounds);
        if (w > income) {
          // 入不敷出：只有补首发空位（阵容不足 5 人或该位置空着）才签
          expect(size < POSITIONS.length || x.reason === 'cover').toBe(true);
          expect(left).toBeGreaterThanOrEqual((w - income) * C.coverDeficitRounds);
        }
        g = left;
        wages = w;
        size += 1;
      }
    }
  });

  it('两轮挑人：有签下后收入仍付得起工资的人选时，先在其中取评分最高者，不签评分更高、会入不敷出的人选', async () => {
    const { s, me } = await shortGame(45);
    s.teams[me].gold = 2_000_000;
    const accepts = (p: Player) => negotiationRoll(s, `sign|${p.id}|${me}`) < playerWillingness(s, p.id, me);
    const cands = freeAgents(s)
      .filter((p) => playsNaturally(p, 'HS') && accepts(p))
      .sort((a, b) => playerRating(b, 'HS') - playerRating(a, 'HS') || (a.id < b.id ? -1 : 1));
    // 愿意加盟的最强人选工资较高；收入盈余设在他与一名较便宜的人选之间
    const top = cands[0];
    const topSalary = signingSalary(s, top, me);
    const cheaper = cands.find((p) => signingSalary(s, p, me) < topSalary)!;
    expect(cheaper).toBeTruthy();
    setSurplus(s, me, Math.round((topSalary + signingSalary(s, cheaper, me)) / 2));
    const room = surplus(s, me);
    expect(signingSalary(s, top, me)).toBeGreaterThan(room);
    const plan = planRosterFill(s);
    const pick = plan.picks[0];
    expect(pick.reason).toBe('cover');
    expect(pick.playerId).not.toBe(top.id);
    expect(pick.salary).toBeLessThanOrEqual(room);
    // 取的是收入付得起的人选中评分最高、愿意加盟者
    const within = cands.filter((p) => signingSalary(s, p, me) <= room);
    expect(pick.playerId).toBe(within[0].id);
    // 收入付不起任何人选时（入不敷出）才退回按评分挑首发：此时选的是最强的愿意加盟者
    setSurplus(s, me, -1000);
    expect(planRosterFill(s).picks[0].playerId).toBe(top.id);
  });

  it('替补深度：已有 5 人、少于 minRosterFill 时只在经常性收入付得起工资时才补，且不改动首发', async () => {
    const C = CONFIG.autoRound;
    const keep = C.minRosterFill;
    Object.assign(C, { minRosterFill: 6 });
    try {
      // 正常工资（新俱乐部入不敷出）：只补位，不补替补
      const { s, me } = await shortGame(21);
      s.teams[me].gold = 2_000_000;
      expect(planRosterFill(s).picks.map((x) => x.reason)).toEqual(['cover']);
      // 工资极低（收入有盈余）：补位后再补一名替补
      const { s: t, me: me2 } = await shortGame(21);
      for (const p of regular(t)) p.salary = 100;
      t.teams[me2].gold = 2_000_000;
      const plan = planRosterFill(t);
      expect(plan.picks.map((x) => x.reason)).toEqual(['cover', 'depth']);
      const rep = autoHandleRound(t, { news: false });
      expect(regular(t)).toHaveLength(6);
      const depth = rep.signings.find((x) => x.reason === 'depth')!;
      expect(POSITIONS.some((q) => t.teams[me2].lineup[q] === depth.playerId)).toBe(false);
      expect(rep.lines.some((l) => l.includes(`${depth.handle}`) && l.includes('补充替补'))).toBe(true);
    } finally {
      Object.assign(C, { minRosterFill: keep });
    }
    // 默认目标：已有 5 人且五个位置齐全时不再签人
    const { s: u, me: me3 } = await shortGame(21);
    for (const p of regular(u)) p.salary = 100;
    u.teams[me3].gold = 2_000_000;
    expect(planRosterFill(u).picks.filter((x) => x.reason === 'depth')).toHaveLength(Math.max(0, CONFIG.autoRound.minRosterFill - 5));
  });

  it('补位顶替跨位置首发：缺五号位、首发由其他位置的队员顶着时，签下评分更高的本职五号位并让他首发', async () => {
    const { s, me } = await shortGame(21);
    // 补一名打一号位的弱队员（5 人，五号位由跨位置的队员顶着）
    const weak = freeAgents(s).filter((p) => p.position === 'C' && !playsNaturally(p, 'HS')).pop()!;
    addPlayerToTeam(s, weak.id, me, { contractSeasons: 1 });
    autoLineup(s, me);
    expect(regular(s)).toHaveLength(5);
    const occ = s.players[s.teams[me].lineup.HS!];
    expect(playsNaturally(occ, 'HS')).toBe(false);
    s.teams[me].gold = 2_000_000;
    const pv = previewAutoActions(s);
    const x = pv.signings[0];
    expect(x.reason).toBe('cover');
    expect(x.replaces?.playerId).toBe(occ.id);
    expect(pv.items[0]).toContain(`替下跨位置首发的 ${occ.handle}`);
    autoHandleRound(s, { news: false });
    expect(s.teams[me].lineup.HS).toBe(x.playerId);
    expect(POSITIONS.some((q) => s.teams[me].lineup[q] === occ.id)).toBe(false); // 回到替补席
    expect(occ.teamId).toBe(me);
  });

  it('资金不足：不签人、不扣钱，预览说明原因与由临时替补顶上；自动推进照常', async () => {
    const { s, me } = await shortGame();
    s.teams[me].gold = 5_000;
    const pv = previewAutoActions(s);
    expect(pv.signings).toEqual([]);
    expect(pv.rosterShortfallReason).toBe('funds');
    expect(pv.rosterShortfall).toBe(
      `正式阵容 4 人：资金不足：付完签字费后余额需留足 ${CONFIG.autoRound.reserveRounds} 回合工资，赛事由临时替补或现有队员顶上`,
    );
    expect(pv.items).toContain(pv.rosterShortfall);
    const c = clone(s);
    const rep = autoHandleRound(c);
    expect(rep.signings).toEqual([]);
    expect(c.teams[me].gold).toBe(5_000);
    expect(regular(c)).toHaveLength(4);
    // 只有这一句时不单独提示（每回合都会重复）
    expect(rep.lines).toEqual([]);
    expect(advance(s, { auto: true }).ok).toBe(true);
  });

  it('没签到人的原因：入不敷出（写明工资、经常性收入与需覆盖的缺口）/ 自由市场没有该位置的人选', async () => {
    const C = CONFIG.autoRound;
    // 资金充足（付得起签字费并留足工资）但工资远高于经常性收入：首发缺口超过余额能覆盖的回合数
    const { s, me } = await shortGame(21);
    for (const p of regular(s)) p.salary = 20_000;
    s.teams[me].gold = 2_000_000;
    const plan = planRosterFill(s);
    expect(plan.picks).toEqual([]);
    expect(plan.shortfallReason).toBe('deficit');
    const rv = roundRevenue(s, s.teams[me]);
    expect(plan.shortfall).toMatch(new RegExp(
      `^正式阵容 4 人：入不敷出：签下后工资 .+/回合高于经常性收入 ${formatGold(rv.total - rv.merchBoost)}/回合，`
      + `自动补员需余额覆盖 ${C.coverDeficitRounds} 回合的缺口 .+，赛事由临时替补或现有队员顶上$`,
    ));
    expect(previewAutoActions(s).items).toContain(plan.shortfall);
    // 自由市场没有打五号位的选手（其余位置都在）
    const { s: t, me: me2 } = await shortGame(21);
    t.teams[me2].gold = 2_000_000;
    for (const p of freeAgents(t)) if (playsNaturally(p, 'HS')) p.status = 'retired';
    const p2 = planRosterFill(t);
    expect(p2.shortfallReason).toBe('none');
    expect(p2.shortfall).toContain('自由市场没有打五号位的选手');
    // 缺五号位没人可签时，不足 5 人改签一名跨位置首发
    expect(p2.picks.map((x) => x.reason)).toEqual(['fill']);
  });

  it('有待决事件：预览先在副本上按默认选项处理（离队的人选不签回），与执行逐人一致', async () => {
    const s = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: '补员', seed: 96,
      newClub: { name: 'Fill Club', tag: 'FIL', region: 'CN', color: '#2a7bc2' },
    });
    const me = s.settings.playerTeamId;
    s.teams[me].gold = 2_000_000;
    const leaver = s.players[s.teams[me].lineup.HS!];
    // 只有「放行」一个选项的离队申请：默认处理后他必定离队
    s.pendingDecisions.push({
      id: 'd-test-leave', kind: 'leave_request', title: `【离队申请】${leaver.handle} 想换个环境`, body: '',
      choices: [{ id: 'allow', label: '放行' }], ctx: { playerId: leaver.id }, createdRound: s.roundIndex, blocking: true,
    });
    expect(planRosterFill(s).picks).toEqual([]); // 处理事件之前阵容完整
    // 若不排除，离队的他就是补位人选（同一回合签回）
    const after = clone(s);
    departToFreeAgency(after, leaver.id);
    expect(planRosterFill(after).picks[0]?.playerId).toBe(leaver.id);

    const snap = JSON.stringify(s);
    const pv = previewAutoActions(s);
    expect(JSON.stringify(s)).toBe(snap);
    expect(pv.decisions).toBe(1);
    expect(pv.signings.length).toBeGreaterThanOrEqual(1);
    expect(pv.signings[0].position).toBe('HS');
    expect(pv.signings.some((x) => x.playerId === leaver.id)).toBe(false);
    const rep = autoHandleRound(s);
    expect(rep.decisions).toBe(1);
    expect(rep.signings.map((x) => [x.playerId, x.fee, x.salary])).toEqual(pv.signings.map((x) => [x.playerId, x.fee, x.salary]));
    expect(leaver.teamId).toBeNull();
    expect(s.teams[me].lineup.HS).toBe(pv.signings[0].playerId);
  });

  it('转会窗口关闭（TI 预选 / 正赛）：不签人，预览也不列出', async () => {
    const s = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: '补员', seed: 57,
      newClub: { name: 'Fill Club', tag: 'FIL', region: 'CN', color: '#2a7bc2' },
    });
    const me = s.settings.playerTeamId;
    for (let i = 0; i < 40 && s.phase !== 'ti_qualifier'; i++) expect(advance(s, { auto: true }).ok).toBe(true);
    expect(s.phase).toBe('ti_qualifier');
    s.teams[me].gold = 2_000_000;
    for (const p of regular(s).slice(0, 2)) departToFreeAgency(s, p.id);
    expect(regular(s).length).toBeLessThan(5);
    expect(planRosterFill(s).needed).toBe(false);
    expect(previewAutoActions(s).signings).toEqual([]);
    const ids0 = regular(s).map((p) => p.id).sort();
    const rep = autoHandleRound(s, { news: false });
    expect(rep.signings).toEqual([]);
    expect(regular(s).map((p) => p.id).sort()).toEqual(ids0);
  });

  it('不超过常规阵容上限：阵容已达 team.maxRoster 时即使缺位置也不签', async () => {
    const { s, me } = await shortGame();
    s.teams[me].gold = 5_000_000;
    // 用自由选手里打一号位的凑到常规上限（不补五号位）
    const extra = freeAgents(s).filter((p) => p.position === 'C' && !playsNaturally(p, 'HS'));
    for (const p of extra.slice(0, CONFIG.team.maxRoster - regular(s).length)) {
      p.teamId = me;
      s.teams[me].playerIds.push(p.id);
    }
    expect(regular(s)).toHaveLength(CONFIG.team.maxRoster);
    expect(uncoveredPositions(regular(s))).toContain('HS');
    const plan = planRosterFill(s);
    expect(plan.needed).toBe(true);
    expect(plan.picks).toEqual([]);
    expect(plan.shortfall).toContain('常规上限');
  });

  it('确定性：同一种子一路自动推进（含自动补员）两次结果一致', async () => {
    const run = async () => {
      const { s } = await shortGame(71);
      for (let i = 0; i < 25 && !s.gameOver; i++) expect(advance(s, { auto: true }).ok).toBe(true);
      const { createdAt: _c, ...rest } = s;
      return JSON.stringify(rest);
    };
    expect(await run()).toBe(await run());
  }, 60_000);
});

describe('autoRound · 自动补员（多人座位）', () => {
  const CLUBS = [
    { name: 'Alpha Club', tag: 'ALP', region: 'CN' as const, color: '#c23c2a' },
    { name: 'Beta Club', tag: 'BET', region: 'EU' as const, color: '#3a7bd5' },
  ];

  it('按座位补员：只动请求自动处理的座位，记录只给本座位；客户端视图（无谈判密钥）预览注明婉拒顺延', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 83,
      players: CLUBS.map((c, i) => ({ sessionId: `sess-${i}`, name: `玩家${i + 1}`, newClub: c })),
    });
    g.multiplayer!.secret = 'server-only-secret'; // 与服务器一致：谈判骰子混入密钥，座位视图中清空
    const [A, B] = g.multiplayer!.order;
    const goneA = g.players[g.teams[A].lineup.M!];
    M.withSeat(g, A, () => departToFreeAgency(g, goneA.id));
    const goneB = g.players[g.teams[B].lineup.C!];
    M.withSeat(g, B, () => departToFreeAgency(g, goneB.id));
    g.teams[A].gold = 2_000_000;
    g.teams[B].gold = 2_000_000;
    expect(regular(g, A)).toHaveLength(4);

    // 服务器端（座位上下文，有密钥）的预览是确切的；客户端视图无法预知婉拒，按首选人选列出并注明
    const pvServer = M.withSeat(g, A, () => previewAutoActions(g));
    expect(pvServer.rosterFillExact).toBe(true);
    expect(pvServer.signings[0]?.position).toBe('M');
    const view = M.seatView(g, A);
    const pvClient = previewAutoActions(view);
    expect(pvClient.rosterFillExact).toBe(false);
    expect(pvClient.signings[0]?.position).toBe('M');
    expect(pvClient.text).toContain('婉拒则顺延下一人选');

    const r = M.setSeatReady(g, A, true, { auto: true });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('自动签下自由选手');
    const signed = pvServer.signings.map((x) => x.playerId);
    for (const id of signed) expect(g.players[id].teamId).toBe(A);
    expect(uncoveredPositions(regular(g, A))).toEqual([]);
    expect(g.teams[A].lineup.M).toBe(signed[0]);
    // B 没有请求自动处理：阵容不变
    expect(regular(g, B)).toHaveLength(4);
    // 自动处理记录只给 A
    const n = g.news.find((x) => x.tags?.includes(AUTO_ROUND_NEWS_TAG) && x.actorTeamId === A);
    expect(n?.visibility).toBe('private');
    expect(n?.body).toContain('自动签下自由选手');
    expect(M.seatView(g, A).news.some((x) => x.id === n!.id)).toBe(true);
    expect(M.seatView(g, B).news.some((x) => x.id === n!.id)).toBe(false);
    expect(g.settings.playerTeamId).toBe('');

    // 房主托管（离线座位）走同一条路径
    const ap = M.autopilotSeat(g, B);
    expect(ap.ok).toBe(true);
    expect(ap.message).toContain('自动签下自由选手');
    expect(uncoveredPositions(regular(g, B))).toEqual([]);
    expect(g.settings.playerTeamId).toBe('');
  });
});
