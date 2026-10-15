// 选手交易（src/engine/trade.ts）：现金 + 本队选手抵价求购 AI 战队选手
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Player } from '../src/engine/types';
import { POSITIONS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { RPC_WHITELIST } from '../src/shared/protocol';
import { makePlayer, makeTestState } from './helpers';
import { tradeForPlayer, tradeOfferBlock, tradeQuote, tradeValuation } from '../src/engine/trade';
import { computeSalary, marketValue, playerTier } from '../src/engine/player';
import { aiAcceptChance, playerWillingness, signFreeAgent } from '../src/engine/market';
import { roundWageBill } from '../src/engine/economy';
import { lineupPlayers, teamPlayers } from '../src/engine/team';
import { listingClock } from '../src/engine/listingRules';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import * as M from '../src/engine/multi';

const T = CONFIG.market.trade;

/** 玩家战队 t0 荣誉极高（目标愿意加盟）；卖方荣誉高（抵价选手愿意加盟卖方，意愿修正 = 1） */
function prep(teams = 4): GameState {
  const s = makeTestState(teams);
  s.teams.t0.honor = 5000;
  for (let i = 1; i < teams; i++) s.teams[`t${i}`].honor = 2000;
  return s;
}

const mine = (s: GameState, pos: string): Player => s.players[`t0-${pos}`];

/** 让某战队的首发离队（成为自由选手） */
function vacate(s: GameState, teamId: string, pos: (typeof POSITIONS)[number]): void {
  const id = s.teams[teamId].lineup[pos]!;
  s.teams[teamId].lineup[pos] = null;
  s.teams[teamId].playerIds = s.teams[teamId].playerIds.filter((x) => x !== id);
  s.players[id].teamId = null;
}

/** 往战队塞替补（不经签约流程） */
function stuff(s: GameState, teamId: string, n: number, over: Partial<Player> = {}): Player[] {
  const out: Player[] = [];
  for (let i = 0; i < n; i++) {
    const p = makePlayer({ teamId, position: POSITIONS[i % 5], power: 60, mmr: 6000, ...over });
    s.players[p.id] = p;
    s.teams[teamId].playerIds.push(p.id);
    out.push(p);
  }
  return out;
}

/** 谈判骰子按回合固定：换回合重试直到成功（最多 limit 次） */
function tradeRetry(s: GameState, target: string, cash: number, offered: string[], limit = 30): OpResult {
  let r = tradeForPlayer(s, target, cash, offered);
  for (let i = 1; !r.ok && i < limit; i++) {
    s.roundIndex = i;
    r = tradeForPlayer(s, target, cash, offered);
  }
  return r;
}

describe('trade · 估值系数随需求变化', () => {
  it('对方缺该位置 > 可顶替首发 > 位置重叠；系数夹在 ratioRange 内', () => {
    const s = prep();
    const target = s.players['t1-C'];
    const o = mine(s, 'O'); // 战力 70，对方 O 首发战力 71 → 位置重叠
    const overlap = tradeValuation(s, target.id, [o.id]).items[0];
    expect(overlap.refused).toBeNull();
    expect(overlap.slot).toBe('O');
    expect(overlap.ratio).toBeLessThan(T.baseRatio);
    expect(overlap.notes.join('')).toContain('位置重叠');

    o.power = 80; // 可顶替首发
    const upgrade = tradeValuation(s, target.id, [o.id]).items[0];
    expect(upgrade.ratio).toBeGreaterThan(T.baseRatio);
    expect(upgrade.ratio).toBeGreaterThan(overlap.ratio);
    expect(upgrade.notes.join('')).toContain('可顶替');

    vacate(s, 't1', 'O'); // 对方缺三号位
    const need = tradeValuation(s, target.id, [o.id]).items[0];
    expect(need.ratio).toBeGreaterThanOrEqual(upgrade.ratio);
    expect(need.ratio).toBe(T.ratioRange[1]);
    expect(need.notes.join('')).toContain('对方缺三号位');
    expect(need.value).toBe(Math.round((marketValue(s, o) * need.ratio * need.willMult) / 1000) * 1000);
    for (const it of [overlap, upgrade, need]) {
      expect(it.ratio).toBeGreaterThanOrEqual(T.ratioRange[0]);
      expect(it.ratio).toBeLessThanOrEqual(T.ratioRange[1]);
    }
  });

  it('目标离队后腾出的位置算「缺人」；同一位置第二名抵价选手与第一名比较', () => {
    const s = prep();
    const target = s.players['t1-M']; // 对方中单，离队后 M 位置无人
    const m = mine(s, 'M');
    const only = tradeValuation(s, target.id, [m.id]).items[0];
    expect(only.notes.join('')).toContain('对方缺二号位');
    expect(only.ratio).toBe(T.ratioRange[1]);
    // 再加一名更强的中单：他顶上空位，原来那名只能当替补
    const m2 = stuff(s, 't0', 1, { position: 'M', power: 90, mmr: 9000 })[0];
    const both = tradeValuation(s, target.id, [m.id, m2.id]);
    const first = both.items.find((x) => x.playerId === m2.id)!;
    const second = both.items.find((x) => x.playerId === m.id)!;
    expect(first.notes.join('')).toContain('对方缺二号位');
    expect(second.notes.join('')).toContain('位置重叠');
    expect(second.ratio).toBeLessThan(first.ratio);
    expect(both.playersValue).toBe(first.value + second.value);
  });

  it('等级低于首发、年龄偏大分别折价', () => {
    const s = prep();
    const target = s.players['t1-C'];
    const o = mine(s, 'O');
    const base = tradeValuation(s, target.id, [o.id]).items[0];
    o.mmr = 6000; // B 级 < 对方 S 级首发
    const lowTier = tradeValuation(s, target.id, [o.id]).items[0];
    expect(lowTier.notes.join('')).toContain('等级低于其首发');
    expect(lowTier.ratio).toBeLessThan(base.ratio);
    o.mmr = 9000;
    o.birthYear = 1985; // 34 岁
    const old = tradeValuation(s, target.id, [o.id]).items[0];
    expect(old.notes.join('')).toContain('年龄偏大');
    expect(old.ratio).toBeLessThan(base.ratio);
    expect(old.ratio).toBeGreaterThanOrEqual(T.ratioRange[0]);
  });

  it('估值只读：不消耗随机数、不改状态', () => {
    const s = prep();
    const before = JSON.stringify(s);
    tradeValuation(s, 't1-C', ['t0-O', 't0-M', 't0-HS']);
    tradeQuote(s, 't1-C', 100_000, ['t0-O']);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('trade · 校验', () => {
  it('低意愿的抵价选手被卖方拒收，失败原因点名该选手', () => {
    const s = prep();
    s.teams.t1.honor = 0;
    const star = mine(s, 'O');
    star.mmr = 16000; // SSR：对荣誉 0 的卖方几乎没有意愿
    star.loyalty = 100;
    expect(playerWillingness(s, star.id, 't1')).toBeLessThan(T.minWillingness);
    const v = tradeValuation(s, 't1-C', [star.id]);
    expect(v.items[0].refused).toContain(star.handle);
    expect(v.items[0].value).toBe(0);
    expect(v.playersValue).toBe(0);
    const r = tradeForPlayer(s, 't1-C', 10_000, [star.id]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain(star.handle);
    expect(r.message).toContain('拒收');
    expect(star.teamId).toBe('t0');
  });

  it('人数上限；对方超员时可放走的替补（不放首发 / 顶替目标位置的替补），不够时拒绝', () => {
    const s = prep();
    const ids = POSITIONS.map((pos) => mine(s, pos).id);
    const tooMany = tradeForPlayer(s, 't1-C', 0, ids.slice(0, T.maxPlayers + 1));
    expect(tooMany.ok).toBe(false);
    expect(tooMany.message).toContain(`${T.maxPlayers} 名`);
    // 对方 5 人：目标离队后 4 人，不必放人即可接收 7 − 4 = 3 名
    const v5 = tradeValuation(s, 't1-C', []);
    expect(v5.freeSlots).toBe(CONFIG.ai.maxRoster - 4);
    expect(v5.releasable).toEqual([]);
    expect(v5.maxIncoming).toBe(CONFIG.ai.maxRoster - 4);
    expect(tradeQuote(s, 't1-C', 0, ids.slice(0, 3)).releases).toEqual([]);
    // 7 人（多一名一号位替补、一名中单替补）：空余 1 名；一号位替补要顶替离队的目标，不放；中单替补可以放 → 最多接收 2 名
    const [benchC, benchM] = stuff(s, 't1', 2);
    const v7 = tradeValuation(s, 't1-C', []);
    expect(v7.freeSlots).toBe(1);
    expect(v7.releasable).toEqual([benchM.id]);
    expect(v7.maxIncoming).toBe(2);
    expect(tradeQuote(s, 't1-C', 0, ids.slice(0, 1)).releases).toEqual([]);
    const q2 = tradeQuote(s, 't1-C', 0, ids.slice(0, 2));
    expect(q2.block).toBeNull();
    expect(q2.releases).toEqual([benchM.id]);
    const q3 = tradeQuote(s, 't1-C', 0, ids.slice(0, 3));
    expect(q3.block).toContain('最多只能接收 2 名');
    expect(q3.block).toContain('不会为此放走首发');
    // 目标是替补时：其余替补都可以放（首发不动）
    expect(tradeValuation(s, benchC.id, []).releasable).toEqual([benchM.id]);
    // 再来两名更强的替补（一号位 / 中单）：阵容 9 人、目标离队后 8 人 → 没有空余名额，每接收 1 名放走 1 名；
    // 顶替目标的换成更强的一号位替补，原一号位替补可以放；首发一律不放；按保留价值从低到高放
    const [strongC, strongM] = stuff(s, 't1', 2, { power: 80, mmr: 9500 });
    const v9 = tradeValuation(s, 't1-C', []);
    expect(v9.freeSlots).toBe(0);
    expect(v9.releasable).not.toContain(strongC.id);
    expect(v9.releasable).toHaveLength(3);
    expect(v9.releasable).toEqual(expect.arrayContaining([benchC.id, benchM.id, strongM.id]));
    expect(v9.releasable[2]).toBe(strongM.id); // 评分最高，最后才放
    for (const pos of POSITIONS) expect(v9.releasable).not.toContain(s.teams.t1.lineup[pos]);
    expect(tradeQuote(s, 't1-C', 0, ids.slice(0, 2)).releases).toEqual(v9.releasable.slice(0, 2));
  });

  it('可放走的替补不够时拒绝，原因写明不会放走首发', () => {
    const s = prep();
    const [benchC] = stuff(s, 't1', 1); // 6 人：目标离队后 5 人，空余 2 名；唯一的替补要顶替目标，不能放
    const v = tradeValuation(s, 't1-C', []);
    expect(v.freeSlots).toBe(2);
    expect(v.releasable).toEqual([]);
    expect(v.maxIncoming).toBe(2);
    const ids = [mine(s, 'O').id, mine(s, 'SS').id, mine(s, 'HS').id];
    const q = tradeQuote(s, 't1-C', 0, ids);
    expect(q.block).toContain('最多只能接收 2 名');
    expect(q.block).toContain('可放走的替补 0 名');
    expect(q.block).toContain('不会为此放走首发');
    const r = tradeForPlayer(s, 't1-C', 0, ids);
    expect(r.ok).toBe(false);
    expect(benchC.teamId).toBe('t1');
    for (const id of ids) expect(s.players[id].teamId).toBe('t0');
  });

  it('资金 / 卖方工资 / 窗口 / 目标校验；重复 id 去重；无抵价选手时等同纯现金报价', () => {
    const s = prep();
    const target = s.players['t1-C'];
    const o = mine(s, 'O');
    expect(tradeQuote(s, target.id, s.teams.t0.gold + 1, [o.id]).block).toContain('资金不足');
    expect(tradeQuote(s, target.id, -5, [o.id]).block).toBeNull(); // 负数现金按 0 计
    expect(tradeQuote(s, target.id, Number.NaN, [o.id]).block).toContain('现金金额无效');
    // 卖方工资：抵价选手按市场工资计薪，高于目标工资时卖方须能负担
    target.salary = 1000;
    expect(computeSalary(s, o)).toBeGreaterThan(target.salary);
    s.teams.t1.gold = 0;
    expect(tradeQuote(s, target.id, 0, [o.id]).block).toContain('无法负担');
    const need = (roundWageBill(s, 't1') - target.salary + computeSalary(s, o)) * CONFIG.ai.signBudgetRounds;
    expect(tradeQuote(s, target.id, need, [o.id]).block).toBeNull();
    s.teams.t1.gold = 1_000_000;
    // 窗口
    s.phase = 'ti';
    expect(tradeForPlayer(s, target.id, 1000, [o.id]).message).toContain('转会窗口已关闭');
    s.phase = 'preseason';
    // 目标校验与 bidForPlayer 一致
    expect(tradeValuation(s, 't0-C', [o.id]).error).toContain('已经是你的队员');
    expect(tradeValuation(s, 'missing', [o.id]).error).toBe('该选手无法转会');
    // 重复 id 去重
    expect(tradeValuation(s, target.id, [o.id, o.id]).items).toHaveLength(1);
    // 不是本队 / 临时替补
    expect(tradeValuation(s, target.id, ['t2-C']).items[0].refused).toContain('不是你的正式队员');
    const sub = stuff(s, 't0', 1, { tempSubUntilTournament: 'tour-x' })[0];
    expect(tradeOfferBlock(s, sub, s.teams.t0)).toContain('临时替补');
    // 无抵价选手 → bidForPlayer 的校验（现金 0 无效）
    expect(tradeForPlayer(s, target.id, 0, []).message).toBe('报价金额无效');
    expect(tradeForPlayer(s, target.id, 0, 'oops' as unknown as string[]).message).toBe('报价金额无效');
  });

  it('接受概率沿用 aiAcceptChance（fee := 总额）', () => {
    const s = prep();
    const target = s.players['t1-C'];
    const o = mine(s, 'O');
    const q = tradeQuote(s, target.id, 200_000, [o.id]);
    expect(q.block).toBeNull();
    expect(q.total).toBe(200_000 + q.playersValue);
    expect(q.accept).toBeCloseTo(aiAcceptChance(s, target, q.total), 10);
  });
});

describe('trade · 成交', () => {
  function deal(s: GameState) {
    const target = s.players['t1-M'];
    target.loyalty = 10; // 对方更愿意放人
    const o = mine(s, 'O');
    const cash = marketValue(s, target) * 2;
    const gold0 = s.teams.t0.gold;
    const gold1 = s.teams.t1.gold;
    const honor0 = s.teams.t0.honor;
    const q = tradeQuote(s, target.id, cash, [o.id]);
    expect(q.block).toBeNull();
    expect(q.accept).toBe(1);
    const r = tradeRetry(s, target.id, cash, [o.id]);
    return { target, o, cash, gold0, gold1, honor0, q, r };
  }

  it('双方阵容、账目、荣誉、新闻正确', () => {
    const s = prep();
    const { target, o, cash, gold0, gold1, honor0, q, r } = deal(s);
    expect(r.ok, r.message).toBe(true);
    expect(target.teamId).toBe('t0');
    expect(o.teamId).toBe('t1');
    expect(s.teams.t0.playerIds).toContain(target.id);
    expect(s.teams.t0.playerIds).not.toContain(o.id);
    expect(s.teams.t1.playerIds).toContain(o.id);
    expect(s.teams.t1.playerIds).not.toContain(target.id);
    // 现金：我方 −cash、卖方 +cash；抵价部分不产生现金流
    expect(s.teams.t0.gold).toBe(gold0 - cash);
    expect(s.teams.t1.gold).toBe(gold1 + cash);
    expect(s.finance.some((f) => f.category === 'transfer_in' && f.amount === -cash)).toBe(true);
    expect(s.finance.some((f) => f.category === 'transfer_out' && f.amount === 0 && f.note.includes('抵价'))).toBe(true);
    // 荣誉：引进 S 级 +3；送走不扣
    expect(s.teams.t0.honor).toBe(honor0 + CONFIG.honor.transfer.signTierBonus[playerTier(target)]);
    // 工资：目标按我方地位开价，抵价选手按市场工资；归属感按新签处理
    expect(o.salary).toBe(computeSalary(s, o));
    expect(o.joinedSeason).toBe(s.season.ti);
    expect(target.joinedSeason).toBe(s.season.ti);
    // 卖方阵容完整
    expect(teamPlayers(s, 't1').filter((p) => !p.tempSubUntilTournament).length).toBeGreaterThanOrEqual(CONFIG.ai.minRoster);
    expect(lineupPlayers(s, 't1').every((x) => x.player)).toBe(true);
    expect(lineupPlayers(s, 't0').find((x) => x.pos === 'M')!.player!.id).toBe(target.id);
    // 新闻
    const n = s.news.find((x) => x.title.startsWith('【交易】'))!;
    expect(n).toBeTruthy();
    expect(n.title).toContain(target.handle);
    expect(n.title).toContain(o.handle);
    expect(n.body).toContain('抵价');
    expect(n.teamIds).toEqual(expect.arrayContaining(['t0', 't1']));
    expect(r.message).toContain('交易成功');
    expect(r.message).toContain(`${q.playersValue >= 10000 ? '' : ''}`);
  });

  it('对方超员时同回合放走保留价值最低的替补：新闻 / 提示写明，被放走者成为自由选手，抵价选手留在对方', () => {
    const s = prep();
    const [benchC, benchM] = stuff(s, 't1', 2); // 7 人
    const target = s.players['t1-C'];
    target.loyalty = 10;
    const offered = [mine(s, 'O').id, mine(s, 'SS').id];
    const cash = marketValue(s, target) * 2;
    const q = tradeQuote(s, target.id, cash, offered);
    expect(q.block).toBeNull();
    expect(q.releases).toEqual([benchM.id]);
    const r = tradeRetry(s, target.id, cash, offered);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toContain(`放走替补 ${benchM.handle}`);
    expect(benchM.teamId).toBeNull();
    expect(benchM.status).toBe('active');
    expect(benchC.teamId).toBe('t1');
    for (const id of offered) expect(s.players[id].teamId).toBe('t1');
    expect(teamPlayers(s, 't1').filter((p) => !p.tempSubUntilTournament)).toHaveLength(CONFIG.ai.maxRoster);
    expect(lineupPlayers(s, 't1').every((x) => x.player)).toBe(true);
    const n = s.news.find((x) => x.title.startsWith('【交易】'))!;
    expect(n.body).toContain(`放走替补 ${benchM.handle}`);
    expect(n.playerIds).toContain(benchM.id);
  });

  it('本赛季选秀的新秀可以抵价；刚从自由市场签下的选手（不满一个赛季的转会回合）按签字费估值，离队后记录清除', () => {
    const s = prep(); // 赛季初
    const rookie = mine(s, 'O');
    rookie.draft = { ti: s.season.ti, round: 1, pick: 3, teamId: 't0' };
    expect(tradeOfferBlock(s, rookie, s.teams.t0)).toBeNull();
    expect(tradeValuation(s, 't1-C', [rookie.id]).items[0].refused).toBeNull();
    // 签下一名自由选手（荣誉很高，换回合重试直到签下）
    const fa = makePlayer({ position: 'M', power: 80, mmr: 9500, birthYear: 2000 });
    s.players[fa.id] = fa;
    let signed = signFreeAgent(s, fa.id);
    for (let i = 1; !signed.ok && i < 20; i++) {
      s.roundIndex = i;
      signed = signFreeAgent(s, fa.id);
    }
    expect(signed.ok, signed.message).toBe(true);
    const at = listingClock(s);
    expect(fa.freeAgentSignedClock).toBe(at);
    const capped = tradeValuation(s, 't1-M', [fa.id]).items[0]; // 对方缺中单：不设上限时系数 1.15
    expect(capped.refused).toBeNull();
    expect(capped.factor).toBe(T.freeAgentSignedCap);
    expect(capped.value).toBe(Math.round((marketValue(s, fa) * T.freeAgentSignedCap) / 1000) * 1000);
    expect(capped.notes.join('')).toContain('自由市场');
    // 赛季末签下、下赛季初抵价：仍不满 freeAgentHoldRounds 个转会回合 → 仍受限；满了之后按正常系数
    fa.freeAgentSignedClock = at - (T.freeAgentHoldRounds - 1);
    expect(tradeValuation(s, 't1-M', [fa.id]).items[0].factor).toBe(T.freeAgentSignedCap);
    fa.freeAgentSignedClock = at - T.freeAgentHoldRounds;
    // v0.3.1：未满足挂牌的加盟门槛（随队场数 / 入队转会回合）时同样按签字费估值（见 tests/listingLock.test.ts），这里让两项也满足
    expect(fa.joinedTeamClock).toBe(at);
    fa.joinedTeamClock = at - T.freeAgentHoldRounds; // 与 freeAgentSignedClock 同一时刻签下
    expect(tradeValuation(s, 't1-M', [fa.id]).items[0].factor).toBe(T.freeAgentSignedCap);
    s.teams.t0.seriesCount = (s.teams.t0.seriesCount ?? 0) + CONFIG.squadOps.listingMinTeamMatches;
    const free = tradeValuation(s, 't1-M', [fa.id]).items[0];
    expect(free.factor).toBeGreaterThan(T.freeAgentSignedCap);
    expect(free.notes.join('')).not.toContain('自由市场');
    // 离队（交易到对方）时记录清除
    fa.freeAgentSignedClock = at;
    const target = s.players['t1-M'];
    target.loyalty = 10;
    const r = tradeRetry(s, target.id, marketValue(s, target) * 2, [fa.id]);
    expect(r.ok, r.message).toBe(true);
    expect(fa.teamId).toBe('t1');
    expect(fa.freeAgentSignedClock).toBeUndefined();
  });

  it('抵价选手的挂牌与待处理报价被清理', () => {
    const s = prep();
    const o = mine(s, 'O');
    o.transferListing = { season: 9, listedRound: 0, roundsLeft: 10, askingPrice: 100_000 };
    s.transferOffers.push({
      id: 'of-1', playerId: o.id, fromTeamId: 't2', toTeamId: 't0', fee: 1000, salary: 1000, status: 'pending', createdRound: 0, expiresRound: 5,
    });
    const { r } = deal(s);
    expect(r.ok, r.message).toBe(true);
    expect(o.transferListing).toBeUndefined();
    expect(s.transferOffers[0].status).toBe('expired');
  });

  it('确定性：同一状态、同一操作结果一致；同一回合现金报价与交易报价掷同一枚骰子', () => {
    const a = prep();
    const b = prep();
    const ra = deal(a);
    const rb = deal(b);
    expect(rb.r).toEqual(ra.r);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // 同一回合：交易被拒（概率 p）时，同样总额的纯现金报价也被拒
    const s = prep();
    const target = s.players['t2-C'];
    const o = mine(s, 'HS');
    const q = tradeQuote(s, target.id, 1000, [o.id]);
    expect(q.block).toBeNull();
    const r1 = tradeForPlayer(s, target.id, 1000, [o.id]);
    if (!r1.ok && r1.message.includes('拒绝了')) {
      const r2 = tradeForPlayer(s, target.id, q.total, []); // 等同 bidForPlayer
      expect(r2.ok).toBe(false);
      expect(r2.message).toContain('拒绝了');
    }
  });
});

describe('trade · 多人座位', () => {
  beforeAll(() => {
    registerNodeRosterLoader();
  });

  const CLUBS = [
    { name: 'Alpha Club', tag: 'ALP', region: 'CN' as const, color: '#c23c2a' },
    { name: 'Beta Club', tag: 'BET', region: 'EU' as const, color: '#3a7bd5' },
  ];
  const call = (g: GameState, id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;

  it('tradeForPlayer 在白名单中；只能用本座位战队的选手抵价；不能求购其他玩家的选手；参数须为数组', async () => {
    expect(RPC_WHITELIST).toContain('tradeForPlayer');
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 11,
      players: CLUBS.map((c, i) => ({ sessionId: `sess-${i}`, name: `玩家${i + 1}`, newClub: c })),
    });
    const [A, B] = g.multiplayer!.order;
    for (const id of [A, B]) {
      g.teams[id].honor = 5000;
      g.teams[id].gold = 50_000_000;
    }
    const aPlayer = g.teams[A].playerIds.map((id) => g.players[id]).find((p) => !p.tempSubUntilTournament && !p.draft)!;
    // 候选目标：AI 战队首发，卖方阵容 ≤ 6 人（能接收 1 名）
    const targets: Player[] = [];
    for (const t of Object.values(g.teams)) {
      if (t.isPlayer || t.disbanded || teamPlayers(g, t.id).length > 6) continue;
      t.honor = 2000;
      for (const s of lineupPlayers(g, t.id)) if (s.player) targets.push(s.player);
    }
    expect(targets.length).toBeGreaterThan(5);
    // B 用 A 的选手抵价 → 拒绝；B 求购 A 的选手 → 拒绝；参数不是数组 → 拒绝
    const t0 = targets[0];
    const rb = call(g, B, 'tradeForPlayer', t0.id, 1000, [aPlayer.id]);
    expect(rb.ok).toBe(false);
    expect(rb.message).toContain('不是你的正式队员');
    const rv = call(g, B, 'tradeForPlayer', aPlayer.id, 1_000_000, [g.teams[B].playerIds[0]]);
    expect(rv.ok).toBe(false);
    expect(rv.message).toContain('由其他玩家执教');
    expect(call(g, A, 'tradeForPlayer', t0.id, 1000, 'x').message).toBe('操作参数无效');
    expect(g.multiplayer!.activeSeat).toBeNull();
    // A 用自己的选手 + 现金求购：换目标直到成交（每名目标各有一枚骰子）
    let done: { target: Player; cash: number } | null = null;
    for (const target of targets) {
      target.loyalty = 10;
      const cash = marketValue(g, target) * 3;
      const q = M.withSeat(g, A, () => tradeQuote(g, target.id, cash, [aPlayer.id]));
      if (q.block) continue;
      const sellerId = target.teamId!;
      const r = call(g, A, 'tradeForPlayer', target.id, cash, [aPlayer.id]);
      if (r.ok) {
        done = { target, cash };
        expect(target.teamId).toBe(A);
        expect(aPlayer.teamId).toBe(sellerId);
        break;
      }
    }
    expect(done).not.toBeNull();
    expect(g.multiplayer!.activeSeat).toBeNull();
    // 账目与新闻归属 A 座位
    expect(M.withSeat(g, A, () => g.finance.some((f) => f.category === 'transfer_in' && f.amount === -done!.cash))).toBe(true);
    expect(M.withSeat(g, B, () => g.finance.some((f) => f.category === 'transfer_in'))).toBe(false);
    const n = g.news.find((x) => x.title.startsWith('【交易】'))!;
    expect(n.actorTeamId).toBe(A);
    expect(g.teams[A].playerIds).toContain(done!.target.id);
    expect(g.teams[B].playerIds).not.toContain(done!.target.id);
  });
});
