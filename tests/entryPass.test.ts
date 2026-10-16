// 入场的下一回合 AI 接手（v0.4.3，src/engine/entryPass.ts；【用户指定】2026-10-16「要，且真实战队优先」）
// - 入场的回合内 AI 不签（公平窗口，marketEntry.ts）；入场的下一回合结束时（season.endRound）AI 对仍未签约的新入场真实选手做一次定向签约；
// - 1. 当届真实战队优先：AI 战队、付得起、有空位（或放走一名更弱的非使命替补，不动首发）、谈判骰子通过 → 签回；
// - 2. 否则按 AI 平常的需求（补缺位 / 最弱首发在他的位置且他强 upgradeMinGain 倍）由一支 AI 战队签下，每队至多一人；使命成员不在这一步被别队签走；
// - 人类玩家在入场回合与下一回合（推进之前）都可以先签，下一回合内接手之前 AI 的其他签约途径（如赛季中期窗口）也不签；真实战队是人类玩家战队时没有优先；
//   确定性；每名选手只处理一次。
// - 出道赛季的真实新秀由真实战队按新秀合同签回（无签字费、新秀工资与合同年限；用户选择的 (A)），其余按自由选手条件；新闻标题写最重要的一两笔。
import { beforeAll, describe, expect, it } from 'vitest';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import type { GameState, Player, Position, Team } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { addTeam, makePlayer, makeTestState } from './helpers';
import { withConfig } from './e4-fakes/mocks';
import { entryPassDue, entryPassRookieTerms, entryPassWilling, entryRealTeam, notifyHumanRealTeams, runEntryPass } from '../src/engine/entryPass';
import { aiSigningHeld, marketEntryStatus } from '../src/engine/marketEntry';
import { canAfford, negotiationRoll, playerWillingness, regularRoster, signFreeAgent, signingFee } from '../src/engine/market';
import { gachaRookieSalary } from '../src/engine/gacha';
import { onRookieContract } from '../src/engine/salary';
import { aiTransferWindow } from '../src/engine/ai';
import { computeSalary, overallRating, playerRating } from '../src/engine/player';
import { roundWageBill } from '../src/engine/economy';
import { autoLineup, benchPlayers, lineupPlayers, removePlayerFromTeam } from '../src/engine/team';
import { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { createMultiplayerGame } from '../src/engine/multi';
import { inSeatOf, isHumanTeam } from '../src/engine/seat';

beforeAll(() => {
  registerNodeRosterLoader();
});

// ---------------------------------------------------------------------------
// 合成局面：TI8 常规赛第 1 回合，t0 为人类玩家战队，t1..t5 与 OG（真实组织 og，使命：TI8 巅峰阵容）为 AI 战队
// ---------------------------------------------------------------------------

function setup(): GameState {
  const s = makeTestState(6);
  s.season.ti = 8;
  s.season.year = 2018;
  s.settings.startTi = 7;
  s.settings.endTi = 10;
  s.phase = 'regular';
  s.roundIndex = 1;
  const og = addTeam(s, 'og', { power: 80, gold: 5_000_000, honor: 3000 });
  og.name = 'OG';
  for (const t of Object.values(s.teams)) t.gold = Math.max(t.gold, 5_000_000);
  return s;
}

/** 新入场的自由选手（入场时刻 {TI, round}） */
function newcomer(s: GameState, over: Partial<Player>, round = 0): Player {
  const p = makePlayer({ isReal: true, teamId: null, contractUntil: 7, ...over });
  p.marketEntry = { ti: s.season.ti, round };
  s.players[p.id] = p;
  return p;
}

/** 选一个存档 id，使谈判骰子（按存档 id 决定）满足 pred */
function pickId(s: GameState, pred: () => boolean): void {
  for (let i = 0; i < 2000; i++) {
    s.id = `entry-pass-${i}`;
    if (pred()) return;
  }
  throw new Error('找不到满足条件的存档 id');
}

/** 去掉战队某位置的首发（制造缺位） */
function dropStarter(s: GameState, teamId: string, pos: Position): void {
  const id = s.teams[teamId].lineup[pos]!;
  removePlayerFromTeam(s, id);
  s.players[id].status = 'retired';
}

function cebOf(s: GameState, power = 90): Player {
  return newcomer(s, { id: 'ceb', handle: 'Ceb', position: 'O', power, mmr: 11000 });
}

describe('第 1 步：当届真实战队优先', () => {
  it('付得起、有空位、谈判通过：入场的下一回合签回（AI 签约同一套费用）；新闻「OG 签回 Ceb」；每名选手只处理一次', () => {
    const s = setup();
    const ceb = cebOf(s);
    const og = s.teams.og;
    expect(entryRealTeam(s, ceb)?.id).toBe('og');
    expect(entryPassDue(s, ceb)).toBe(true);
    // 入场的下一回合、接手之前：AI 的其他签约途径同样不签（接手是 AI 的第一次机会）
    expect(aiSigningHeld(s, ceb)).toBe(true);
    expect(marketEntryStatus(s, ceb)).toBe('pass');
    pickId(s, () => entryPassWilling(s, ceb, og));
    const gold0 = og.gold;
    const fee = signingFee(s, ceb);
    const salary = computeSalary(s, ceb);
    const rep = runEntryPass(s)!;
    expect(rep.considered).toEqual(['ceb']);
    expect(rep.signings).toEqual([{ playerId: 'ceb', teamId: 'og', realTeam: true, released: [] }]);
    expect(ceb.teamId).toBe('og');
    expect(ceb.salary).toBe(salary);
    expect(og.gold).toBe(gold0 - fee);
    expect(ceb.marketEntry).toBeUndefined();
    const news = s.news.find((n) => n.title === '【转会】OG 签回 Ceb');
    expect(news).toBeDefined();
    expect(news!.body).toContain('OG 签回 Ceb');
    expect(news!.body).toContain('当届真实战队优先');
    // 只处理一次
    expect(runEntryPass(s)).toBeNull();
  });

  it('入场的回合内不接手（公平窗口）：入场回合结束时仍是自由身，下一回合才轮到；转会窗口锁定时不处理', () => {
    const s = setup();
    const ceb = cebOf(s);
    ceb.marketEntry = { ti: 8, round: 1 };
    expect(marketEntryStatus(s, ceb)).toBe('now');
    expect(aiSigningHeld(s, ceb)).toBe(true);
    expect(entryPassDue(s, ceb)).toBe(false);
    expect(runEntryPass(s)).toBeNull();
    expect(ceb.teamId).toBeNull();
    expect(ceb.marketEntry).toEqual({ ti: 8, round: 1 });
    s.roundIndex = 2;
    expect(marketEntryStatus(s, ceb)).toBe('pass');
    // 窗口锁定（TI 预选）：不处理、不清除；标记不显示「AI 接手」
    s.phase = 'ti_qualifier';
    expect(marketEntryStatus(s, ceb)).toBeNull();
    expect(runEntryPass(s)).toBeNull();
    expect(ceb.marketEntry).toEqual({ ti: 8, round: 1 });
    // 下个赛季初才开始公平窗口的（窗口锁定时入场）不在本赛季处理
    s.phase = 'regular';
    ceb.marketEntry = { ti: 9, round: 0 };
    expect(marketEntryStatus(s, ceb)).toBe('next');
    expect(runEntryPass(s)).toBeNull();
  });

  it('人类玩家在入场回合先签：AI 不再接手；下一回合（接手之前）签下同样有效', () => {
    const s = setup();
    const ceb = cebOf(s);
    const me = s.teams.t0;
    me.gold = 100_000_000;
    me.honor = 5000;
    s.phase = 'preseason';
    s.roundIndex = 0;
    expect(marketEntryStatus(s, ceb)).toBe('now');
    pickId(s, () => negotiationRoll(s, `sign|ceb|t0`) < playerWillingness(s, 'ceb', 't0'));
    expect(signFreeAgent(s, 'ceb').ok).toBe(true);
    expect(ceb.teamId).toBe('t0');
    s.phase = 'regular';
    s.roundIndex = 1;
    expect(runEntryPass(s)).toBeNull();
    expect(ceb.teamId).toBe('t0');
    expect(s.news.some((n) => n.title.includes('签回 Ceb'))).toBe(false);

    // 下一回合（入场回合已过、本回合结束时才接手）：人类玩家先签
    const s2 = setup();
    const ceb2 = cebOf(s2);
    s2.teams.t0.gold = 100_000_000;
    s2.teams.t0.honor = 5000;
    expect(marketEntryStatus(s2, ceb2)).toBe('pass');
    pickId(s2, () => negotiationRoll(s2, `sign|ceb|t0`) < playerWillingness(s2, 'ceb', 't0'));
    expect(signFreeAgent(s2, 'ceb').ok).toBe(true);
    expect(runEntryPass(s2)).toBeNull();
    expect(ceb2.teamId).toBe('t0');
  });

  it('真实战队是人类玩家战队：没有优先权，按第 2 步由需要他的 AI 战队签下', () => {
    const s = setup();
    // OG 由人类玩家执教（人类玩家战队没有使命，也不享受优先）
    s.settings.playerTeamId = 'og';
    s.teams.og.isPlayer = true;
    s.teams.t0.isPlayer = false;
    const ceb = cebOf(s);
    expect(entryRealTeam(s, ceb)?.id).toBe('og');
    expect(isHumanTeam(s, 'og')).toBe(true);
    // t2 缺三号位：需求最高
    dropStarter(s, 't2', 'O');
    s.teams.t2.honor = 3000;
    const rep = runEntryPass(s)!;
    expect(ceb.teamId).toBe('t2');
    expect(rep.signings).toEqual([{ playerId: 'ceb', teamId: 't2', realTeam: false, released: [] }]);
    expect(s.news.some((n) => n.title === '【转会】Team t2 签下 Ceb')).toBe(true);
  });

  it('真实战队是人类玩家战队：入场时给该战队一条总览通知（AI 不会替你签下）；真实战队是 AI 战队 / 不在本局时不发', () => {
    const s = setup();
    s.settings.playerTeamId = 'og';
    s.teams.og.isPlayer = true;
    s.teams.t0.isPlayer = false;
    s.popups = [];
    const ceb = cebOf(s);
    ceb.marketEntry = { ti: 8, round: 1 };
    newcomer(s, { id: 'nx-none', handle: 'NxNone', position: 'C', power: 90 }, 1);
    notifyHumanRealTeams(s);
    expect(s.popups).toHaveLength(1);
    const msg = s.popups[0];
    expect(msg.kind).toBe('message');
    if (msg.kind !== 'message') return;
    expect(msg.title).toBe('【新入场】你的战队是 Ceb 的当届真实战队');
    expect(msg.body).toContain('AI 不会替你签下他');
    expect(msg.body).toContain('下一回合结束时需要他的 AI 战队可能签下他');
    // 入场回合已过：不再发
    s.popups = [];
    s.roundIndex = 2;
    notifyHumanRealTeams(s);
    expect(s.popups).toHaveLength(0);
    // OG 是 AI 战队：不发
    const a = setup();
    a.popups = [];
    cebOf(a).marketEntry = { ti: 8, round: 1 };
    notifyHumanRealTeams(a);
    expect(a.popups).toHaveLength(0);
  });

  it('预算：付不起（签字费 + 工资 × signBudgetRounds）时真实战队不签；刚好付得起时签', () => {
    const go = (extra: number) => {
      const s = setup();
      const ceb = cebOf(s);
      const og = s.teams.og;
      pickId(s, () => entryPassWilling(s, ceb, og));
      const need = signingFee(s, ceb) + (roundWageBill(s, 'og') + computeSalary(s, ceb)) * CONFIG.ai.signBudgetRounds;
      og.gold = need + extra;
      runEntryPass(s);
      return ceb;
    };
    const poor = go(-1);
    // Ceb 是 OG 生效中使命的缺失成员：第 2 步不让别队签走，留在自由市场（之后由 OG 在 AI 窗口按使命引进）
    expect(poor.teamId).toBeNull();
    expect(poor.marketEntry).toBeUndefined();
    expect(go(0).teamId).toBe('og');
  });

  it('空位：阵容已满时放走能放走的最弱替补（非使命成员、比他弱），从不动首发；替补都不比他弱则不签', () => {
    const build = (cebPower: number) => {
      const s = setup();
      const og = s.teams.og;
      // 7 人：首发之外两名同为 80 的替补，再加一名使命成员（Ana，评分最低）作为替补
      for (const [id, pos, power] of [['og-x1', 'C', 85], ['og-x2', 'M', 85]] as const) {
        const p = makePlayer({ id, handle: id, position: pos, power, teamId: 'og', contractUntil: 9 });
        s.players[id] = p;
        og.playerIds.push(id);
      }
      autoLineup(s, 'og');
      expect(regularRoster(s, 'og').length).toBe(CONFIG.ai.maxRoster);
      const ceb = cebOf(s, cebPower);
      pickId(s, () => entryPassWilling(s, ceb, og));
      return { s, og, ceb };
    };
    // 替补（og-C / og-M，80）都比 Ceb（55）强：不签
    {
      const { s, og, ceb } = build(55);
      expect(benchPlayers(s, 'og').every((b) => overallRating(b) > overallRating(ceb))).toBe(true);
      runEntryPass(s);
      expect(ceb.teamId).toBeNull();
      expect(regularRoster(s, 'og').length).toBe(CONFIG.ai.maxRoster);
      expect(og.playerIds).toContain('og-C');
    }
    // Ceb（95）：签下，放走一名最弱的替补（评分最低、同分按 id），首发不动，阵容仍为上限
    {
      const { s, og, ceb } = build(95);
      const startersBefore = new Set(lineupPlayers(s, 'og').map((x) => x.player!.id));
      const rep = runEntryPass(s)!;
      expect(ceb.teamId).toBe('og');
      expect(regularRoster(s, 'og').length).toBe(CONFIG.ai.maxRoster);
      const released = rep.signings[0].released;
      expect(released.length).toBe(1);
      expect(s.players[released[0]].teamId).toBeNull();
      // 放走的是替补（80 的原首发之一：一号位 / 二号位被 85 的新人顶下，三号位被 Ceb 顶下），一号位 / 二号位的 85 首发不动
      expect(['og-C', 'og-M', 'og-O']).toContain(released[0]);
      expect(startersBefore.has('og-x1') && startersBefore.has('og-x2')).toBe(true);
      expect(s.players['og-x1'].teamId).toBe('og');
      expect(s.players['og-x2'].teamId).toBe('og');
      expect(lineupPlayers(s, 'og').every((x) => !!x.player && x.player.teamId === 'og')).toBe(true);
      expect(lineupPlayers(s, 'og').some((x) => x.player!.id === 'ceb')).toBe(true);
    }
    // 使命成员（巅峰阵容成员）即使评分最低也不放走：OG 五名首发 + 两名同为一号位的使命成员（Ana 40 / JerAx 41，优先级排阵后 Ana 坐替补）
    {
      const s = setup();
      const og = s.teams.og;
      for (const [id, power] of [['ana', 40], ['jerax', 41]] as const) {
        s.players[id] = makePlayer({ id, handle: id, position: 'C', power, teamId: 'og', contractUntil: 9 });
        og.playerIds.push(id);
      }
      autoLineup(s, 'og');
      expect(regularRoster(s, 'og').length).toBe(CONFIG.ai.maxRoster);
      expect(benchPlayers(s, 'og').map((b) => b.id)).toContain('ana');
      const ceb = cebOf(s, 95);
      pickId(s, () => entryPassWilling(s, ceb, og));
      const rep = runEntryPass(s)!;
      expect(ceb.teamId).toBe('og');
      expect(s.players.ana.teamId).toBe('og');
      expect(rep.signings[0].released).toEqual(['og-C']);
      expect(regularRoster(s, 'og').length).toBe(CONFIG.ai.maxRoster);
    }
  });

  it('谈判：骰子没过时真实战队不签（同一回合结果固定）；意愿为使命口径（使命成员 + missions.willBonus）', () => {
    const s = setup();
    const ceb = cebOf(s);
    const og = s.teams.og;
    og.honor = 300;
    const will = playerWillingness(s, 'ceb', 'og') + CONFIG.missions.willBonus;
    expect(will).toBeLessThan(1);
    pickId(s, () => !entryPassWilling(s, ceb, og));
    expect(negotiationRoll(s, 'entry|ceb|og')).toBeGreaterThanOrEqual(playerWillingness(s, 'ceb', 'og') + CONFIG.missions.willBonus);
    runEntryPass(s);
    expect(ceb.teamId).toBeNull();
    // 非使命成员：意愿不加成
    const x = newcomer(s, { id: 'x-free', handle: 'X', position: 'C', power: 90 });
    expect(entryPassWilling(s, x, og)).toBe(negotiationRoll(s, 'entry|x-free|og') < playerWillingness(s, 'x-free', 'og'));
  });
});

describe('第 1 步：出道赛季的真实新秀按新秀合同签回（用户选择的 (A)「新秀按旧的新秀合同条件」）', () => {
  /** 第 1 回合入场、未被抽走的 TI8 真实新秀 Topson（出道战队 OG）；当前第 2 回合（入场的下一回合） */
  const rookieOf = (s: GameState, giTi = 8): Player => {
    s.roundIndex = 2;
    const t = newcomer(s, { id: 'topson', handle: 'Topson', position: 'M', power: 90, mmr: 9500, isRookie: true }, 1);
    t.gacha = { ti: giTi, round: 1, teamId: '', tier: 'S', kind: 'real', mmr: t.mmr, power: t.power, talent: t.talent, insight: t.insight, placed: true };
    return t;
  };

  it('无签字费、新秀工资、新秀合同年限；预算按新秀工资检查（差 1 不签、刚好签——这时按自由选手条件付不起）', () => {
    const go = (extra: number) => {
      const s = setup();
      const t = rookieOf(s);
      const og = s.teams.og;
      expect(entryRealTeam(s, t)?.id).toBe('og');
      expect(entryPassRookieTerms(s, t)).toBe(true);
      pickId(s, () => entryPassWilling(s, t, og));
      const salary = gachaRookieSalary(s, t);
      og.gold = (roundWageBill(s, 'og') + salary) * CONFIG.ai.signBudgetRounds + extra;
      const gold0 = og.gold;
      const freeTermsOk = canAfford(s, og, signingFee(s, t), computeSalary(s, t));
      const rep = runEntryPass(s);
      return { s, t, og, gold0, salary, freeTermsOk, rep };
    };
    const poor = go(-1);
    // 付不起：Topson 是 OG 生效中使命的缺失成员，第 2 步不让别队签走，留在自由市场
    expect(poor.t.teamId).toBeNull();
    const ok = go(0);
    expect(ok.freeTermsOk).toBe(false);
    expect(ok.t.teamId).toBe('og');
    expect(ok.t.salary).toBe(ok.salary);
    expect(ok.t.contractUntil).toBe(8 + CONFIG.gacha.rookieContractSeasons - 1);
    expect(ok.og.gold).toBe(ok.gold0);
    // 新秀合同期内不计薪资差（同 v0.4.2 按真实出道去向加盟）
    expect(onRookieContract(ok.s, ok.t)).toBe(true);
    expect(ok.rep!.signings).toEqual([{ playerId: 'topson', teamId: 'og', realTeam: true, rookieContract: true, released: [] }]);
    const news = ok.s.news.find((n) => n.title === '【转会】OG 签回 Topson');
    expect(news?.body).toContain('OG 签回 Topson（');
    expect(news?.body).toContain('新秀合同');
  });

  it('非出道赛季（抽卡出身是往届）与第 2 步的签约按自由选手条件（签字费 + 市场工资）', () => {
    const s = setup();
    const t = rookieOf(s, 7);
    const og = s.teams.og;
    expect(entryPassRookieTerms(s, t)).toBe(false);
    pickId(s, () => entryPassWilling(s, t, og));
    const gold0 = og.gold;
    const fee = signingFee(s, t);
    const salary = computeSalary(s, t);
    const rep = runEntryPass(s)!;
    expect(t.teamId).toBe('og');
    expect(rep.signings[0].rookieContract).toBeUndefined();
    expect(t.salary).toBe(salary);
    expect(og.gold).toBe(gold0 - fee);
    expect(onRookieContract(s, t)).toBe(false);

    // 出道赛季的新秀、真实战队是人类玩家战队：第 2 步由需要他的 AI 战队按自由选手条件签下
    const h = setup();
    h.settings.playerTeamId = 'og';
    h.teams.og.isPlayer = true;
    h.teams.t0.isPlayer = false;
    const r = rookieOf(h);
    dropStarter(h, 't1', 'M');
    h.teams.t1.honor = 3000;
    const g1 = h.teams.t1.gold;
    const fee1 = signingFee(h, r);
    const rep1 = runEntryPass(h)!;
    expect(r.teamId).toBe('t1');
    expect(rep1.signings).toEqual([{ playerId: 'topson', teamId: 't1', realTeam: false, released: [] }]);
    expect(h.teams.t1.gold).toBe(g1 - fee1);
  });
});

describe('入场的下一回合、接手之前 AI 的其他签约途径不签', () => {
  it('该回合恰好是赛季中期转会窗口：AI 窗口不签新入场选手（人类玩家仍可先签），本回合结束时由接手处理；开关关闭时窗口照常签', () => {
    const make = () => {
      const s = setup();
      dropStarter(s, 't1', 'O');
      s.teams.t1.honor = 3000;
      const p = newcomer(s, { id: 'nx-mid', handle: 'NxMid', position: 'O', power: 95 }, 0);
      expect(marketEntryStatus(s, p)).toBe('pass');
      return { s, p };
    };
    {
      const { s, p } = make();
      expect(aiSigningHeld(s, p)).toBe(true);
      aiTransferWindow(s, 'midseason', { upgrades: false });
      expect(p.teamId).toBeNull();
      expect(p.marketEntry).toEqual({ ti: 8, round: 0 });
      // 本回合结束时由接手处理（窗口已用程序化选手补上 t1 的缺位，有没有球队需要他按第 2 步的规则），之后清除入场时刻
      expect(runEntryPass(s)!.considered).toEqual(['nx-mid']);
      expect(p.marketEntry).toBeUndefined();
      expect(aiSigningHeld(s, p)).toBe(false);
    }
    {
      const { s, p } = make();
      withConfig('realEntry', { aiPass: false }, () => {
        expect(aiSigningHeld(s, p)).toBe(false);
        aiTransferWindow(s, 'midseason', { upgrades: false });
      });
      expect(p.teamId).toBe('t1');
    }
  });
});

describe('新闻', () => {
  it('标题写最重要的一两笔：真实战队签回在前（即使等级较低），其次等级；多于两笔时「等 N 人」', () => {
    const s = setup();
    dropStarter(s, 't1', 'C');
    dropStarter(s, 't2', 'C');
    for (const t of ['t1', 't2']) s.teams[t].honor = 3000;
    const ceb = cebOf(s, 70);
    newcomer(s, { id: 'nx-a', handle: 'NxA', position: 'C', power: 99, mmr: 12000 });
    newcomer(s, { id: 'nx-b', handle: 'NxB', position: 'C', power: 98, mmr: 12000 });
    pickId(s, () => entryPassWilling(s, ceb, s.teams.og));
    const rep = runEntryPass(s)!;
    expect(rep.signings.map((x) => [x.playerId, x.teamId, x.realTeam])).toEqual([['ceb', 'og', true], ['nx-a', 't1', false], ['nx-b', 't2', false]]);
    expect(overallRating(ceb)).toBeLessThan(overallRating(s.players['nx-b']));
    const news = s.news.find((n) => n.title.startsWith('【转会】OG 签回 Ceb'));
    expect(news?.title).toBe('【转会】OG 签回 Ceb、Team t1 签下 NxA 等 3 人');
    expect(news?.body.indexOf('OG 签回 Ceb')).toBeLessThan(news!.body.indexOf('Team t1 签下 NxA'));
    expect(news?.body.indexOf('Team t1 签下 NxA')).toBeLessThan(news!.body.indexOf('Team t2 签下 NxB'));
  });
});

describe('第 2 步：AI 平常的需求', () => {
  it('没有当届真实战队：补缺位优先、同分按战队 id，每队至多一人；没人需要的留在自由市场；每人只处理一次', () => {
    const s = setup();
    dropStarter(s, 't1', 'O');
    dropStarter(s, 't2', 'O');
    for (const t of ['t1', 't2']) s.teams[t].honor = 3000;
    const a = newcomer(s, { id: 'nx-a', handle: 'NxA', position: 'O', power: 95 });
    const b = newcomer(s, { id: 'nx-b', handle: 'NxB', position: 'O', power: 94 });
    const c = newcomer(s, { id: 'nx-c', handle: 'NxC', position: 'O', power: 93 });
    for (const p of [a, b, c]) expect(entryRealTeam(s, p)).toBeNull();
    const rep = runEntryPass(s)!;
    expect(rep.considered).toEqual(['nx-a', 'nx-b', 'nx-c']);
    expect(rep.signings.map((x) => [x.playerId, x.teamId, x.realTeam])).toEqual([['nx-a', 't1', false], ['nx-b', 't2', false]]);
    expect(c.teamId).toBeNull();
    for (const p of [a, b, c]) expect(p.marketEntry).toBeUndefined();
    const news = s.news.find((n) => n.title === '【转会】Team t1 签下 NxA、Team t2 签下 NxB');
    expect(news?.body).toContain('Team t1 签下 NxA');
    expect(news?.body).toContain('Team t2 签下 NxB');
  });

  it('需求：最弱首发在他的位置、且他强 upgradeMinGain 倍才签；加盟意愿低于 ai.minWillingness 的战队跳过', () => {
    const at = (power: number) => {
      const s = setup();
      const t3 = s.teams.t3;
      t3.honor = 3000;
      s.players[t3.lineup.O!].power = 60; // t3 最弱的首发在三号位
      const starter = s.players[t3.lineup.O!];
      const p = newcomer(s, { id: 'nx-o', handle: 'NxO', position: 'O', power });
      const better = playerRating(p, 'O') > playerRating(starter, 'O') * CONFIG.ai.upgradeMinGain;
      runEntryPass(s);
      return { p, better };
    };
    // 只比 t3 三号位首发强一点：不到 upgradeMinGain 不签（其余战队五人同评分，最弱首发在一号位，也不需要他）
    const lo = at(61);
    expect(lo.better).toBe(false);
    expect(lo.p.teamId).toBeNull();
    const hi = at(75);
    expect(hi.better).toBe(true);
    expect(hi.p.teamId).toBe('t3');
    // 加盟意愿门槛
    const s2 = setup();
    dropStarter(s2, 't1', 'O');
    s2.teams.t1.honor = -1000;
    const p = newcomer(s2, { id: 'nx-w', handle: 'NxW', position: 'O', power: 99 });
    expect(playerWillingness(s2, 'nx-w', 't1')).toBeLessThan(CONFIG.ai.minWillingness);
    runEntryPass(s2);
    expect(p.teamId).not.toBe('t1');
  });

  it('使命成员不在第 2 步被别队签走：OG 谈判没谈成时 Topson 留在自由市场；OG 是人类玩家战队时照常由需要他的 AI 战队签下', () => {
    const make = (human: boolean) => {
      const s = setup();
      if (human) {
        s.settings.playerTeamId = 'og';
        s.teams.og.isPlayer = true;
        s.teams.t0.isPlayer = false;
      }
      dropStarter(s, 't1', 'M');
      s.teams.t1.honor = 3000;
      s.teams.og.honor = 300;
      const t = newcomer(s, { id: 'topson', handle: 'Topson', position: 'M', power: 95 });
      pickId(s, () => !entryPassWilling(s, t, s.teams.og));
      runEntryPass(s);
      return t;
    };
    expect(make(false).teamId).toBeNull();
    expect(make(true).teamId).toBe('t1');
  });
});

describe('确定性与开关', () => {
  it('同一局面两次结果逐字节相同；开关关闭时不接手、不清除入场时刻', () => {
    const run = () => {
      const s = setup();
      dropStarter(s, 't1', 'O');
      s.teams.t1.honor = 3000;
      cebOf(s);
      newcomer(s, { id: 'nx-a', handle: 'NxA', position: 'O', power: 95 });
      newcomer(s, { id: 'nx-b', handle: 'NxB', position: 'HS', power: 92 });
      s.id = 'det';
      runEntryPass(s);
      return s;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a.players)).toBe(JSON.stringify(b.players));
    expect(JSON.stringify(a.teams)).toBe(JSON.stringify(b.teams));
    expect(JSON.stringify(a.news)).toBe(JSON.stringify(b.news));
    expect(a.rngState).toBe(b.rngState);

    const s = setup();
    const ceb = cebOf(s);
    withConfig('realEntry', { aiPass: false }, () => {
      expect(marketEntryStatus(s, ceb)).toBeNull();
      expect(runEntryPass(s)).toBeNull();
    });
    expect(ceb.teamId).toBeNull();
    expect(ceb.marketEntry).toEqual({ ti: 8, round: 0 });
  });
});

// ---------------------------------------------------------------------------
// 整局：经由回合推进（season.endRound）
// ---------------------------------------------------------------------------

/** 推进一个回合（决策取第一项、本方比赛快速模拟） */
function step(g: GameState): void {
  const r0 = `${g.season.ti}:${g.roundIndex}`;
  for (let i = 0; i < 50 && `${g.season.ti}:${g.roundIndex}` === r0 && !g.gameOver; i++) {
    g.popups.length = 0;
    for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
      const d = g.pendingDecisions[0];
      resolveDecision(g, d.id, d.choices[0]?.id ?? '');
      if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
    }
    const me = g.teams[g.settings.playerTeamId];
    if (me && me.gold < 2_000_000) me.gold = 2_000_000;
    if (currentPlayerTournament(g) || g.activeMatch) {
      if (!quickSimTournament(g).ok) fillLineupWithTempSubs(g);
    }
    advance(g);
  }
  expect(g.gameOver).toBeNull();
}

/** 让真实战队一定付得起、有空位（放走最弱的替补到 maxRoster - 1），谈判骰子在当前回合通过 */
function makeReady(g: GameState, team: Team, p: Player): void {
  team.gold = 100_000_000;
  team.honor = 5000;
  while (regularRoster(g, team.id).length >= CONFIG.ai.maxRoster) {
    const b = benchPlayers(g, team.id).sort((x, y) => overallRating(x) - overallRating(y))[0];
    removePlayerFromTeam(g, b.id);
  }
  const id0 = g.id;
  for (let i = 0; i < 2000 && !entryPassWilling(g, p, team); i++) g.id = `${id0}-${i}`;
  expect(entryPassWilling(g, p, team)).toBe(true);
}

describe('整局推进', () => {
  it('复出选手：入场回合（赛季初）之后的第 1 回合结束时被当届真实战队签回（TI8 Ceb → OG）', async () => {
    const g = await createNewGame({
      startTi: 8, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 4,
      newClub: { name: 'Probe', tag: 'PRB', region: 'CN', color: '#888888' },
    });
    // 模拟赛季初入场的复出选手：Ceb 以自由身入场（回合 0）
    const ceb = g.players.ceb;
    removePlayerFromTeam(g, 'ceb');
    ceb.marketEntry = { ti: 8, round: 0 };
    expect(marketEntryStatus(g, ceb)).toBe('now');
    step(g);
    expect(g.roundIndex).toBe(1);
    expect(ceb.teamId).toBeNull();
    expect(marketEntryStatus(g, ceb)).toBe('pass');
    makeReady(g, g.teams.og, ceb);
    step(g);
    expect(g.roundIndex).toBe(2);
    expect(ceb.teamId).toBe('og');
    expect(g.news.some((n) => n.season === 8 && n.round === 1 && n.body.includes('OG 签回 Ceb'))).toBe(true);
  }, 60_000);

  it('真实新秀：第 1 回合入场（AI 不签）→ 第 2 回合结束时被出道战队签回（TI8 Topson → OG）；人类玩家在入场回合先签则归人类', async () => {
    const make = async () => {
      const g = await createNewGame({
        startTi: 7, seasons: 3, difficulty: 'normal', managerName: 'T', seed: 3,
        newClub: { name: 'Probe', tag: 'PRB', region: 'CN', color: '#888888' },
      });
      for (let i = 0; i < 40 && !(g.season.ti === 8 && g.roundIndex === 1); i++) step(g);
      expect(g.season.ti).toBe(8);
      expect(g.roundIndex).toBe(1);
      return g;
    };
    const g = await make();
    const t = g.players.topson;
    expect(t.teamId).toBeNull();
    expect(t.marketEntry).toEqual({ ti: 8, round: 1 });
    expect(entryRealTeam(g, t)?.id).toBe('og');
    // 入场回合结束：不接手
    step(g);
    expect(g.roundIndex).toBe(2);
    expect(t.teamId).toBeNull();
    expect(marketEntryStatus(g, t)).toBe('pass');
    makeReady(g, g.teams.og, t);
    step(g);
    expect(t.teamId).toBe('og');
    expect(t.marketEntry).toBeUndefined();
    // 出道赛季的真实新秀：按新秀合同签回（无签字费）
    expect(g.news.some((n) => n.season === 8 && n.round === 2 && /OG 签回 Topson（[^）]*新秀合同）/.test(n.body))).toBe(true);
    expect(t.contractUntil).toBe(8 + CONFIG.gacha.rookieContractSeasons - 1);

    // 人类玩家在入场回合签下：之后不会被 AI 接手
    const h = await make();
    const me = h.teams[h.settings.playerTeamId];
    me.gold = 100_000_000;
    me.honor = 5000;
    const id0 = h.id;
    for (let i = 0; i < 2000 && !(negotiationRoll(h, `sign|topson|${me.id}`) < playerWillingness(h, 'topson', me.id)); i++) h.id = `${id0}-${i}`;
    expect(signFreeAgent(h, 'topson').ok).toBe(true);
    makeReady(h, h.teams.og, h.players.topson);
    step(h);
    step(h);
    expect(h.players.topson.teamId).toBe(me.id);
    expect(h.news.some((n) => n.body.includes('签回 Topson'))).toBe(false);
  }, 120_000);

  it('多人模式：座位战队（接管 OG）不享受优先（入场时只给该座位一条总览通知），接手在中性上下文中执行、不签给任何座位', async () => {
    const g = await createMultiplayerGame({
      startTi: 8, endTi: 9, difficulty: 'normal', mode: 'existing', seed: 5,
      players: [{ sessionId: 's-a', name: '甲', teamId: 'og' }, { sessionId: 's-b', name: '乙', teamId: 'team-liquid' }],
    });
    g.phase = 'regular';
    g.roundIndex = 0;
    const ceb = g.players.ceb;
    removePlayerFromTeam(g, 'ceb');
    ceb.marketEntry = { ti: 8, round: 0 };
    expect(entryRealTeam(g, ceb)?.id).toBe('og');
    expect(isHumanTeam(g, 'og')).toBe(true);
    // 入场回合：只有座位战队 OG（他的当届真实战队）收到总览通知，另一个座位不收到
    const popupsOf = (teamId: string) => inSeatOf(g, teamId, () => [...(g.popups ?? [])]);
    const og0 = popupsOf('og').length;
    const liquid0 = popupsOf('team-liquid').length;
    notifyHumanRealTeams(g);
    const ogNew = popupsOf('og').slice(og0);
    expect(ogNew.map((p) => p.kind === 'message' && p.title)).toEqual(['【新入场】你的战队是 Ceb 的当届真实战队']);
    expect(popupsOf('team-liquid')).toHaveLength(liquid0);
    g.roundIndex = 1;
    const rep = runEntryPass(g)!;
    expect(rep.considered).toContain('ceb');
    expect(ceb.teamId === null || !isHumanTeam(g, ceb.teamId)).toBe(true);
    expect(rep.signings.every((x) => !isHumanTeam(g, x.teamId) && !(x.playerId === 'ceb' && x.realTeam))).toBe(true);
  }, 30_000);
});
