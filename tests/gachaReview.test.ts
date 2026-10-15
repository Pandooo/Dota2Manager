// v0.3 审查修复（2026-10-14）：抽卡新秀工资上限、转售冷却（挂牌 / AI 求购 / 交易抵价）、真实新秀第 1 回合前离池按出道去向加盟
// （人类出道战队收到「签下 / 放弃」事件）、AI 超编抽卡门槛与退回返还、欢迎弹窗文案、荣誉势头的旧存档 / 赛季中记录、
// 多人座位视图不含随机数状态 / 谈判密钥 / 他队保底、谈判骰子混入服务器密钥、原型链上的 id。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Team, Tier } from '../src/engine/types';
import { TIERS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { getTrajectory } from '../src/data/index';
import {
  aiGachaPulls, aiPullAllowance, currentGachaPool, gachaPrice, gachaPull, gachaRookieWageCap, gachaView, releaseRealRookieCards,
  startGachaSeason, teamGachaPull,
} from '../src/engine/gacha';
import { gachaResaleLockLeft, listingRoundsPerSeason } from '../src/engine/listingRules';
import { listPlayerForTransfer } from '../src/engine/squadOps';
import { tradeValuation } from '../src/engine/trade';
import { generateAiOffers, negotiationRoll } from '../src/engine/market';
import { resolveDecision } from '../src/engine/events';
import { autoHandleRound } from '../src/engine/autoRound';
import { createNewGame } from '../src/engine/game';
import { pediaPlayerPage } from '../src/engine/pedia';
import { initMomentumOnLoad, rollTeamMomentum, updateTeamMomentumRound } from '../src/engine/momentum';
import { setPlayerAsStarter } from '../src/engine/uiActions';
import { aiKeepValue } from '../src/engine/rookieDraft';
import { seasonEconIndex } from '../src/engine/player';
import { benchPlayers, rosterSize } from '../src/engine/team';
import * as M from '../src/engine/multi';
import { addTeam, makePlayer, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 卡池各等级剩余张数 */
function tierLeft(s: GameState): Record<Tier, number> {
  const pool = currentGachaPool(s)!;
  return Object.fromEntries(
    TIERS.map((t) => [t, (pool.real[t]?.length ?? 0) + (pool.summon[t]?.length ?? 0) + (pool.fictional[t] ?? 0)]),
  ) as Record<Tier, number>;
}

/** 给战队补替补到 n 人（替补的天梯 / 战力 / 年龄可调，用来控制保留价值） */
function fillBench(s: GameState, team: Team, n: number, over: { mmr: number; power: number; birthYear: number; talent: number }): void {
  for (let i = team.playerIds.length; i < n; i++) {
    const p = makePlayer({ id: `${team.id}-b${i}`, teamId: team.id, position: 'C', ...over });
    s.players[p.id] = p;
    team.playerIds.push(p.id);
  }
}

describe('抽卡新秀：工资上限与转售冷却', () => {
  it('新秀合同工资不超过 rookieWageCap × 赛季经济指数；冷却期内不能挂牌、不接 AI 求购、抵价按签字费比例估值；满 18 个转会回合后解除', () => {
    const s = makeTestState(6);
    startGachaSeason(s);
    const me = s.teams.t0;
    me.gold = 100_000_000;
    const cap = gachaRookieWageCap(s);
    expect(cap).toBe(Math.max(CONFIG.economy.minSalary, Math.round(CONFIG.gacha.rookieWageCap * seasonEconIndex(s))));
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = gachaPull(s, 1) as OpResult & { results?: { playerId: string }[] };
      expect(r.ok, r.message).toBe(true);
      ids.push(r.results![0].playerId);
    }
    for (const id of ids) expect(s.players[id].salary).toBeLessThanOrEqual(cap);
    // SSR 级的新秀工资原本远高于上限：抽到时正好等于上限
    const ssr = teamGachaPull(s, 't1', 1)[0];
    const sp = s.players[ssr.playerId];
    if (sp.salary >= cap) expect(sp.salary).toBe(cap);

    const id = ids[0];
    const p = s.players[id];
    expect(gachaResaleLockLeft(s, p)).toBe(CONFIG.gacha.resaleHoldRounds);
    // 加盟门槛（v0.3.1：随队场数 + 入队转会回合）另外叠加：先满足加盟门槛，再看转售冷却
    s.teams.t0.seriesCount = CONFIG.squadOps.listingMinTeamMatches;
    p.joinedTeamClock = (p.joinedTeamClock ?? 0) - CONFIG.squadOps.listingMinTransferRounds;
    const listed = listPlayerForTransfer(s, id, null);
    expect(listed.ok).toBe(false);
    expect(listed.message).toContain('本队抽卡得到的新秀，入队满');
    // 交易抵价：按签字费比例封顶
    const target = s.teams.t1.playerIds[0];
    const v = tradeValuation(s, target, [id]);
    const it0 = v.items[0];
    if (!it0.refused) {
      expect(it0.factor).toBeLessThanOrEqual(CONFIG.market.trade.freeAgentSignedCap + 1e-9);
      expect(it0.notes.join('；')).toContain('抽卡得到的新秀');
    }
    // AI 随机求购不会挑中冷却期内的新秀：只留下抽到的新秀时不产生报价
    const keep = new Set(ids);
    for (const pid of me.playerIds.slice()) if (!keep.has(pid)) s.players[pid].teamId = null;
    me.playerIds = me.playerIds.filter((pid) => keep.has(pid));
    s.phase = 'regular';
    s.roundIndex = 1;
    const before = s.transferOffers.length;
    for (let k = 0; k < 30; k++) generateAiOffers(s);
    expect(s.transferOffers.length).toBe(before);
    // 满 resaleHoldRounds 个转会回合（下个赛季同一时刻）后解除
    s.season.ti += Math.ceil(CONFIG.gacha.resaleHoldRounds / listingRoundsPerSeason());
    expect(gachaResaleLockLeft(s, p)).toBe(0);
    // 离开抽中他的战队后不再受限（冷却只对本队）
    s.season.ti -= Math.ceil(CONFIG.gacha.resaleHoldRounds / listingRoundsPerSeason());
    expect(gachaResaleLockLeft(s, { ...p, teamId: 't3' })).toBe(0);
  });
});

describe('真实新秀：第 1 回合开始前离池，按真实出道去向加盟', () => {
  /** TI11：OG（人类）有 bzm / misha / yuragi 三名出道新秀，Team Secret（AI）有 crystallis */
  function setup(): GameState {
    const s = makeTestState(4);
    s.season.ti = 11;
    s.season.year = 2022;
    s.settings.startTi = 11;
    s.teams.t0.isPlayer = false;
    const og = addTeam(s, 'og', { isPlayer: true });
    og.name = 'OG';
    s.settings.playerTeamId = 'og';
    addTeam(s, 'team-secret').name = 'Team Secret';
    for (const id of ['bzm', 'misha', 'yuragi', 'crystallis']) s.futureRookies[id] = 11;
    startGachaSeason(s);
    s.phase = 'regular';
    s.roundIndex = 1;
    return s;
  }

  it('离池：真实卡全部离开、同等级补入请神 / 虚构卡（剩余张数与各等级比例不变）；AI 出道战队直接签下；人类出道战队收到待决事件', () => {
    const s = setup();
    const pool = currentGachaPool(s)!;
    const real = TIERS.flatMap((t) => pool.real[t] ?? []);
    expect(real.sort()).toEqual(['bzm', 'crystallis', 'misha', 'yuragi']);
    const left = tierLeft(s);
    expect(releaseRealRookieCards(s)).toBe(4);
    expect(TIERS.flatMap((t) => currentGachaPool(s)!.real[t] ?? [])).toHaveLength(0);
    expect(tierLeft(s)).toEqual(left);
    expect(currentGachaPool(s)!.realReleased).toBe(true);
    expect(gachaView(s).realReleased).toBe(true);
    // 同一赛季只执行一次
    expect(releaseRealRookieCards(s)).toBe(0);
    // AI 出道战队：直接加盟（新秀合同，工资不超过上限），标记 placed
    const cr = s.players.crystallis;
    expect(cr.teamId).toBe('team-secret');
    expect(cr.gacha).toMatchObject({ kind: 'real', placed: true, teamId: 'team-secret', ti: 11 });
    expect(cr.salary).toBeLessThanOrEqual(gachaRookieWageCap(s));
    // 人类出道战队：三条「签下 / 放弃」事件，新秀尚未生成
    const ds = s.pendingDecisions.filter((d) => d.kind === 'rookie_home');
    expect(ds.map((d) => d.ctx.rookieId).sort()).toEqual(['bzm', 'misha', 'yuragi']);
    expect(ds.every((d) => d.blocking && d.choices.map((c) => c.id).join() === 'sign,decline')).toBe(true);
    expect(s.players.bzm).toBeUndefined();
    expect(currentGachaPool(s)!.realOffered).toBe(3);
  });

  it('签下 → 加盟本队（新秀合同、工资上限、转售冷却）；放弃 → 加盟 AI 战队或进入自由市场；阵容达到绝对上限时签下被拦下、事件保留', () => {
    const s = setup();
    releaseRealRookieCards(s);
    const byId = (id: string) => s.pendingDecisions.find((d) => d.kind === 'rookie_home' && d.ctx.rookieId === id)!;
    const r1 = resolveDecision(s, byId('bzm').id, 'sign');
    expect(r1.ok, r1.message).toBe(true);
    const bzm = s.players.bzm;
    expect(bzm.teamId).toBe('og');
    expect(bzm.gacha).toMatchObject({ kind: 'real', placed: true, teamId: 'og' });
    expect(bzm.salary).toBeLessThanOrEqual(gachaRookieWageCap(s));
    expect(s.futureRookies.bzm).toBeUndefined();
    expect(gachaResaleLockLeft(s, bzm)).toBeGreaterThan(0);
    const r2 = resolveDecision(s, byId('misha').id, 'decline');
    expect(r2.ok).toBe(true);
    expect(s.players.misha.teamId).not.toBe('og');
    // 阵容满（绝对上限）：签下失败但事件保留，可以改选放弃
    const og = s.teams.og;
    fillBench(s, og, CONFIG.team.hardMaxRoster, { mmr: 6000, power: 60, birthYear: 1995, talent: 40 });
    expect(rosterSize(s, 'og')).toBe(CONFIG.team.hardMaxRoster);
    const d3 = byId('yuragi');
    const r3 = resolveDecision(s, d3.id, 'sign');
    expect(r3.ok).toBe(false);
    expect(r3.message).toContain('绝对上限');
    expect(s.pendingDecisions.some((d) => d.id === d3.id)).toBe(true);
    expect(resolveDecision(s, d3.id, 'decline').ok).toBe(true);
    expect(s.pendingDecisions.some((d) => d.kind === 'rookie_home')).toBe(false);
  });

  it('自动处理（懒人推进 / 托管）：默认签下；阵容已满签不下时改为放弃，不会卡住回合', () => {
    const s = setup();
    releaseRealRookieCards(s);
    fillBench(s, s.teams.og, CONFIG.team.hardMaxRoster, { mmr: 6000, power: 60, birthYear: 1995, talent: 40 });
    const rep = autoHandleRound(s, { news: false });
    expect(s.pendingDecisions.some((d) => d.kind === 'rookie_home')).toBe(false);
    expect(rep.decisions).toBe(3);
    expect(rep.lines.some((l) => l.includes('默认选项未能执行'))).toBe(true);
    for (const id of ['bzm', 'misha', 'yuragi']) expect(s.players[id]?.teamId).not.toBe('og');
    // 有空位时默认签下
    const t = setup();
    releaseRealRookieCards(t);
    autoHandleRound(t, { news: false });
    for (const id of ['bzm', 'misha', 'yuragi']) expect(t.players[id]?.teamId).toBe('og');
  });

  it('确定性：同一状态两次离池结果相同', () => {
    const a = setup();
    const b = setup();
    releaseRealRookieCards(a);
    releaseRealRookieCards(b);
    expect(JSON.stringify(a.gacha)).toBe(JSON.stringify(b.gacha));
    expect(a.rngState).toBe(b.rngState);
  });
});

describe('AI 抽卡：超编门槛与退回返还', () => {
  it('阵容已满（ai.maxRoster）时，只有替补里有保留价值低于 slackKeepMax 的选手才超编抽 1 张', () => {
    const s = makeTestState(3);
    startGachaSeason(s);
    s.phase = 'regular';
    s.roundIndex = 1;
    const strong = s.teams.t1;
    const weak = s.teams.t2;
    strong.gold = weak.gold = 100_000_000;
    fillBench(s, strong, CONFIG.ai.maxRoster, { mmr: 13000, power: 95, birthYear: 2001, talent: 95 });
    fillBench(s, weak, CONFIG.ai.maxRoster, { mmr: 3000, power: 40, birthYear: 1988, talent: 30 });
    const minKeep = (t: Team) => Math.min(...benchPlayers(s, t.id).map((p) => aiKeepValue(s, p)));
    expect(minKeep(strong)).toBeGreaterThanOrEqual(CONFIG.gacha.ai.slackKeepMax);
    expect(minKeep(weak)).toBeLessThan(CONFIG.gacha.ai.slackKeepMax);
    expect(aiPullAllowance(s, strong, 'opening')).toBe(0);
    expect(aiPullAllowance(s, weak, 'opening')).toBe(1);
  });

  it('抽完整理阵容时放走的是本回合刚抽到的新秀：与人类退回同一规则返还单抽价格的 20%；公开新闻不列已放走的新秀', () => {
    const s = makeTestState(2);
    startGachaSeason(s);
    s.phase = 'regular';
    s.roundIndex = 1;
    const t = s.teams.t1;
    t.gold = 100_000_000;
    // 超强替补 + 放宽门槛：抽到的新秀几乎必然最弱、被放走
    fillBench(s, t, CONFIG.ai.maxRoster, { mmr: 13500, power: 99, birthYear: 2002, talent: 99 });
    const ai = CONFIG.gacha.ai as { slackKeepMax: number };
    const keep = ai.slackKeepMax;
    ai.slackKeepMax = Infinity;
    try {
      const price = gachaPrice(s).single;
      const g0 = t.gold;
      expect(aiGachaPulls(s, 'opening')).toBe(1);
      const pulled = Object.values(s.players).find((p) => p.gacha?.teamId === 't1' && p.gacha.round === 1)!;
      const refund = Math.round(price * CONFIG.gacha.discardRefundRatio);
      if (pulled.teamId === 't1') {
        expect(t.gold).toBe(g0 - price);
      } else {
        expect(t.gold).toBe(g0 - price + refund);
        expect(s.news.some((n) => n.playerIds?.includes(pulled.id) && n.title.includes('S 级以上新秀加盟'))).toBe(false);
      }
      expect(rosterSize(s, 't1')).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    } finally {
      ai.slackKeepMax = keep;
    }
  });
});

describe('新游戏欢迎弹窗', () => {
  it('选秀关闭时介绍新秀抽卡，不再提新秀选秀', async () => {
    expect(CONFIG.draft.enabled).toBe(false);
    const g = await createNewGame({
      startTi: 9, seasons: 1, difficulty: 'normal', managerName: 'T', seed: 3,
      newClub: { name: 'Welcome Club', tag: 'WEL', region: 'CN', color: '#123456' },
    });
    const pop = g.popups.find((p) => p.kind === 'message' && p.title === '欢迎来到刀塔经理');
    expect(pop && pop.kind === 'message').toBe(true);
    const body = pop && pop.kind === 'message' ? pop.body : '';
    expect(body).toContain('新秀抽卡');
    expect(body).not.toContain('新秀选秀');
    // DotaPedia：不在本局选手中的真实传奇（TI9 起的 BurNIng）选手页用索引里的身份，而不是小写 id
    expect(g.players.burning).toBeUndefined();
    const page = pediaPlayerPage(g, 'burning')!;
    expect(page.handle).toBe('BurNIng');
    expect(page.nationality).toBe('CN');
    expect(page.birthYear).toBe(1988);
  });
});

describe('荣誉势头：旧存档 / 赛季中建立的记录', () => {
  it('赛季中途建立的记录标记 partial，下个赛季初不作为同比基准；单机读档按 season.honorStart 补建玩家战队', () => {
    const s = makeTestState(3);
    s.teams.t1.honor = 169;
    updateTeamMomentumRound(s);
    expect(s.teams.t1.momentum?.partial).toBe(true);
    s.teams.t1.honor = 118;
    rollTeamMomentum(s);
    expect(s.teams.t1.momentum?.prevSeasonStart).toBeUndefined();
    expect(s.teams.t1.momentum?.partial).toBeUndefined();
    // 下一个赛季初才有同比基准（真正的季初荣誉）
    s.teams.t1.honor = 130;
    rollTeamMomentum(s);
    expect(s.teams.t1.momentum?.prevSeasonStart).toBe(118);
    // 读档迁移：玩家战队没有记录 → 按本赛季季初荣誉补建
    const o = makeTestState(2);
    o.season.honorStart = 106;
    o.teams.t0.honor = 147;
    delete o.teams.t0.momentum;
    const mom = (t: Team) => t.momentum;
    expect(initMomentumOnLoad(o)).toBe(true);
    expect(mom(o.teams.t0)).toEqual({ seasonStart: 106, ewma: 0, lastHonor: 147 });
    expect(initMomentumOnLoad(o)).toBe(false);
    rollTeamMomentum(o);
    expect(mom(o.teams.t0)?.prevSeasonStart).toBe(106);
  });
});

describe('多人：座位视图与服务器密钥', () => {
  it('视图不含随机数状态与谈判密钥，其他座位的保底进度不下发；谈判骰子混入密钥后改变', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build', seed: 21,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    expect((M.callAsSeat(g, A, 'gachaPull', [1]) as OpResult).ok).toBe(true);
    expect(g.rngState).not.toBe(0);
    const roll0 = negotiationRoll(g, 'bid|x');
    g.multiplayer!.secret = 'server-only-secret';
    expect(negotiationRoll(g, 'bid|x')).not.toBe(roll0);
    const vb = M.seatView(g, B);
    expect(vb.rngState).toBe(0);
    expect(vb.multiplayer!.secret).toBe('');
    expect(vb.teams[A].gacha?.pity).toBeUndefined();
    expect(vb.teams[A].gacha?.log).toBeUndefined();
    const va = M.seatView(g, A);
    expect(va.teams[A].gacha?.pity).toBe(g.teams[A].gacha!.pity);
    // 引擎状态本身不受影响
    expect(g.multiplayer!.secret).toBe('server-only-secret');
    expect(g.rngState).not.toBe(0);
  });

  it('原型链上的键不是选手：setPlayerAsStarter / gachaDiscard 拒绝 __proto__、constructor', () => {
    const s = makeTestState(2);
    for (const id of ['__proto__', 'constructor', 'toString']) {
      expect(setPlayerAsStarter(s, id).ok).toBe(false);
    }
  });
});

describe('真实轨迹数据可用（测试前提）', () => {
  it('TI11 OG / Secret 出道新秀有出道届的真实轨迹', () => {
    for (const id of ['bzm', 'misha', 'yuragi', 'crystallis']) expect(getTrajectory(id)?.[11], id).toBeTruthy();
  });
});
