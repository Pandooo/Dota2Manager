// 新秀选秀（src/engine/rookieDraft.ts，第八波）：抽签概率偏向弱队、确定性、顺位与阵容上限、新秀池等级分布与
// 100 名新秀的 SSR 保底、赛季初免费放弃、首个赛季同样举行、多人模式全局一次；以及休赛回合结束时自动用掉全部训练额度。
// 2026-10-14 起新秀改由抽卡进入联赛（gacha.ts），选秀默认关闭（CONFIG.draft.enabled = false，保留一个版本）：
// 经由赛季流程举行选秀的集成用例显式打开开关。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult, Tier } from '../src/engine/types';
import { TIERS } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import { getPlayerIndex } from '../src/data/index';
import {
  aiKeepValue, buildRookiePool, draftedRookieReleaseBlock, draftedRookiesOf, lotteryOddsTable, lotteryProbabilities,
  nextRookieSsrChance, postDraftRosterLimit, releaseDraftedRookie, rookieContractSeasons, rookieDraftRecord, rookieSlotSalary,
  rookieTierProbabilities, runRookieDraft,
} from '../src/engine/rookieDraft';
import { playerTier, tierIndex } from '../src/engine/player';
import { freeAgents, releaseCompensation, releasePlayer, releasePlayers } from '../src/engine/market';
import { addPlayerToTeam } from '../src/engine/team';
import { generatePlayer } from '../src/engine/generation';
import { advance, buyExtraTraining, createNewGame, getAdvanceBlockers, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import { endRound } from '../src/engine/season';
import { buildRounds, roundKindForPlayer, seasonStartDate, tiDates } from '../src/engine/calendar';
import { extraTrainingCost } from '../src/engine/economy';
import { trainingRecords } from '../src/engine/trainingLog';
import * as M from '../src/engine/multi';
import { makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 第二个赛季起的测试状态：n 支战队，上赛季排名 = 编号 + 1（t0 最好） */
function draftState(n = 16, seed = 7): GameState {
  const s = makeTestState(n, seed);
  s.settings.startTi = 8; // 非首个赛季：按 lastSeasonRank
  Object.values(s.teams).forEach((t, i) => {
    t.lastSeasonRank = i + 1;
  });
  return s;
}

describe('rookieDraft · 抽签', () => {
  it('抽签概率矩阵：每行/每列和为 1，NBA 权重下最差三队状元签各 14%、进入前 4 约 52.1%', () => {
    const odds = CONFIG.draft.lotteryOdds;
    const P = lotteryProbabilities(odds, CONFIG.draft.lotteryPicks);
    const n = odds.length;
    for (let i = 0; i < n; i++) expect(P[i].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    for (let k = 0; k < n; k++) expect(P.reduce((a, row) => a + row[k], 0)).toBeCloseTo(1, 9);
    const table = lotteryOddsTable();
    expect(table[0].oddsFirst).toBeCloseTo(0.14, 6);
    expect(table[0].oddsTop).toBeCloseTo(0.521, 3);
    // 越差越有利：状元签与前 4 概率单调不增
    for (let i = 1; i < table.length; i++) {
      expect(table[i].oddsFirst).toBeLessThanOrEqual(table[i - 1].oddsFirst + 1e-12);
      expect(table[i].oddsTop).toBeLessThanOrEqual(table[i - 1].oddsTop + 1e-12);
    }
    // 最差的队最多掉到第 5 顺位（前 4 都被别人抽走）
    expect(table[0].dist.slice(5).every((x) => x === 0)).toBe(true);
  });

  it('实际抽签偏向排名差的队；非抽签队按排名倒序排在其后；第二轮按排名倒序', () => {
    const firstCount = new Map<string, number>();
    for (let seed = 1; seed <= 160; seed++) {
      const s = draftState(16, seed * 31);
      const rec = runRookieDraft(s)!;
      expect(rec).toBeTruthy();
      firstCount.set(rec.order[0], (firstCount.get(rec.order[0]) ?? 0) + 1);
      // 最好的两支（t0、t1）不参加抽签：首轮第 16、15 顺位
      expect(rec.order[15]).toBe('t0');
      expect(rec.order[14]).toBe('t1');
      expect(rec.lottery.map((e) => e.teamId)).not.toContain('t0');
      // 抽签区：前 4 为中签者，其余按签前顺位
      const rest = rec.lottery.filter((e) => !e.won).sort((a, b) => a.seed - b.seed);
      rest.forEach((e, i) => expect(e.finalPick).toBe(rec.lotteryPicks + i + 1));
      // 第二轮：按排名倒序（t15 先选）
      const r2 = rec.picks.filter((p) => p.round === 2).map((p) => p.teamId);
      const expected = Object.keys(s.teams).sort((a, b) => s.teams[b].lastSeasonRank! - s.teams[a].lastSeasonRank!);
      expect(r2).toEqual(expected.slice(0, r2.length));
    }
    const worst = (firstCount.get('t15') ?? 0) + (firstCount.get('t14') ?? 0) + (firstCount.get('t13') ?? 0);
    const better = (firstCount.get('t2') ?? 0) + (firstCount.get('t3') ?? 0) + (firstCount.get('t4') ?? 0);
    expect(worst).toBeGreaterThan(better * 3);
    expect(firstCount.get('t0') ?? 0).toBe(0);
  });

  it('同一种子结果完全一致（确定性）；不同种子结果不同', () => {
    const a = draftState(12, 99);
    const b = draftState(12, 99);
    const ra = runRookieDraft(a)!;
    const rb = runRookieDraft(b)!;
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
    expect(a.rngState).toBe(b.rngState);
    const c = draftState(12, 100);
    const rc = runRookieDraft(c)!;
    expect(JSON.stringify(rc.picks.map((p) => [p.teamId, p.tier, p.position]))).not.toBe(
      JSON.stringify(ra.picks.map((p) => [p.teamId, p.tier, p.position])),
    );
  });

  it('同一赛季只举行一次', () => {
    const s = draftState(8);
    expect(runRookieDraft(s)).toBeTruthy();
    const players = Object.keys(s.players).length;
    expect(runRookieDraft(s)).toBeNull();
    expect(Object.keys(s.players).length).toBe(players);
    expect(s.rookieDraft!.history).toHaveLength(1);
  });
});

describe('rookieDraft · 选人与阵容上限', () => {
  it('每个顺位都选人（不因阵容人数放弃）：满员玩家战队照选并保留全部新秀，满员 AI 战队选后整理回 AI 上限；合同与薪资表；落选者进入自由市场', () => {
    const s = draftState(10, 5);
    const regular = (id: string) => s.teams[id].playerIds.filter((x) => s.players[x]?.status === 'active' && !s.players[x].tempSubUntilTournament);
    // t9（最差，AI）阵容塞满到 AI 上限
    expect(postDraftRosterLimit(s, s.teams.t9)).toBe(CONFIG.ai.maxRoster);
    expect(postDraftRosterLimit(s, s.teams.t0)).toBeNull();
    while (regular('t9').length < CONFIG.ai.maxRoster) {
      const p = generatePlayer(s, { tier: 'B', position: 'HS' });
      addPlayerToTeam(s, p.id, 't9', { contractSeasons: 2 });
    }
    // 玩家战队 t0 已到签约 / 求购的绝对上限：选秀照样进行
    while (regular('t0').length < CONFIG.team.hardMaxRoster) {
      const p = generatePlayer(s, { tier: 'B', position: 'SS' });
      addPlayerToTeam(s, p.id, 't0', { contractSeasons: 2 });
    }
    const before = Object.fromEntries(Object.values(s.teams).map((t) => [t.id, regular(t.id).length]));
    const t9Before = regular('t9');
    const lineup0 = { ...s.teams.t0.lineup };
    const rec = runRookieDraft(s)!;
    const ti = s.season.ti;

    // 没有放弃的顺位
    expect(rec.picks.length).toBe(rec.order.length * rec.rounds);
    expect(rec.picks.every((p) => !!p.playerId && !p.forfeited)).toBe(true);
    // 玩家战队：每轮都选人，新秀全部留队（超出常规与绝对上限也一样），首发安排不变（新秀进替补，由经理决定）
    const t0Picks = rec.picks.filter((p) => p.teamId === 't0');
    expect(t0Picks).toHaveLength(rec.rounds);
    expect(t0Picks.every((p) => !p.released && s.players[p.playerId!].teamId === 't0')).toBe(true);
    expect(regular('t0').length).toBe(before.t0 + rec.rounds);
    expect(regular('t0').length).toBeGreaterThan(CONFIG.team.hardMaxRoster);
    expect(s.teams.t0.lineup).toEqual(lineup0);
    // 满员 AI 战队：照样选人，选后放走价值最低的非首发，阵容回到 AI 上限
    const t9Picks = rec.picks.filter((p) => p.teamId === 't9');
    expect(t9Picks).toHaveLength(rec.rounds);
    expect(regular('t9').length).toBe(CONFIG.ai.maxRoster);
    const gone = [...t9Before, ...t9Picks.map((p) => p.playerId!)].filter((id) => s.players[id].teamId !== 't9');
    expect(gone).toHaveLength(before.t9 + rec.rounds - CONFIG.ai.maxRoster);
    const starters9 = new Set(Object.values(s.teams.t9.lineup).filter(Boolean));
    const worstKeptBench = Math.min(
      ...regular('t9').filter((id) => !starters9.has(id)).map((id) => aiKeepValue(s, s.players[id])),
    );
    for (const id of gone) {
      expect(s.players[id].teamId).toBeNull(); // 进入自由市场
      expect(aiKeepValue(s, s.players[id])).toBeLessThanOrEqual(worstKeptBench + 1e-9);
    }
    // 被放走的本届新秀在选秀记录中标为 released
    for (const pk of t9Picks) expect(!!pk.released).toBe(gone.includes(pk.playerId!));
    // 所有 AI 战队选秀后都不超过 AI 上限
    for (const t of Object.values(s.teams)) if (t.id !== 't0') expect(regular(t.id).length).toBeLessThanOrEqual(CONFIG.ai.maxRoster);

    const total = rec.order.length * rec.rounds;
    let lastSalary = Infinity;
    const seen = new Set<string>();
    for (const pk of rec.picks) {
      expect(pk.pick).toBe(rec.picks.indexOf(pk) + 1);
      if (!pk.playerId) continue;
      const p = s.players[pk.playerId];
      expect(seen.has(p.id)).toBe(false);
      seen.add(p.id);
      if (pk.released) {
        // AI 选秀后整理阵容放走的新秀：进入自由市场
        expect(p.teamId).toBeNull();
      } else {
        expect(p.teamId).toBe(pk.teamId);
        expect(s.teams[pk.teamId].playerIds).toContain(p.id);
      }
      expect(p.draft).toEqual({ ti, round: pk.round, pick: pk.pick, teamId: pk.teamId });
      expect(p.contractUntil).toBe(ti + rookieContractSeasons(pk.round) - 1);
      expect(p.salary).toBe(rookieSlotSalary(s, pk.pick, total));
      expect(p.salary).toBeLessThanOrEqual(lastSalary);
      lastSalary = p.salary;
      expect(pk.tier).toBe(playerTier(p));
    }
    // 合同 2–3 赛季
    expect(rookieContractSeasons(1)).toBe(3);
    expect(rookieContractSeasons(2)).toBe(2);
    expect(rookieContractSeasons(9)).toBe(2);
    // 新秀池 = 选中 + 落选；落选者是自由选手
    expect(seen.size + rec.undrafted.length).toBe(rec.realCount + rec.generatedCount);
    const fa = new Set(freeAgents(s).map((p) => p.id));
    for (const id of rec.undrafted) {
      expect(s.players[id].teamId).toBeNull();
      expect(fa.has(id)).toBe(true);
    }
    // 弹窗 + 新闻
    expect(s.popups).toContainEqual({ kind: 'rookie_draft', ti });
    expect(s.news.some((n) => n.title.includes('【选秀大会】'))).toBe(true);
    expect(s.news.some((n) => n.title.includes('【选秀抽签】') && n.title.includes('状元签'))).toBe(true);
  });

  it('自动选人兼顾位置需求：首发空缺的位置优先补强', () => {
    let filled = 0;
    let runs = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = draftState(4, seed * 13);
      // t3（最差，抽签前第 1 顺位）中单空缺
      const mid = s.teams.t3.lineup.M!;
      s.teams.t3.lineup.M = null;
      s.teams.t3.playerIds = s.teams.t3.playerIds.filter((id) => id !== mid);
      s.players[mid].teamId = null;
      const rec = runRookieDraft(s)!;
      const first = rec.picks.find((p) => p.teamId === 't3' && p.playerId);
      if (!first) continue;
      runs++;
      if (first.position === 'M') filled++;
    }
    expect(runs).toBeGreaterThan(20);
    // 随机挑选时命中中单的基线约 0.2；高等级新秀更多后实力权重更大，但位置需求仍明显生效
    expect(filled / runs).toBeGreaterThan(0.35);
  });
});

describe('rookieDraft · 新秀池等级与 SSR 保底', () => {
  it('程序生成新秀：C 42 / B 25 / A 15 / S 10 / SS 5 / SSR 3（用户指定），每 100 名新秀至少 1 名 SSR（跨赛季）', () => {
    const probs = rookieTierProbabilities();
    expect(probs.C).toBeCloseTo(0.42, 9);
    expect(probs.B).toBeCloseTo(0.25, 9);
    expect(probs.A).toBeCloseTo(0.15, 9);
    expect(probs.S).toBeCloseTo(0.1, 9);
    expect(probs.SS).toBeCloseTo(0.05, 9);
    expect(probs.SSR).toBeCloseTo(0.03, 9);
    expect(nextRookieSsrChance(50)).toBeGreaterThan(nextRookieSsrChance(0));
    expect(nextRookieSsrChance(CONFIG.draft.ssrPityThreshold - 1)).toBe(1);

    const s = makeTestState(2, 4242);
    const seq: Tier[] = [];
    for (let season = 0; season < 70; season++) {
      const { ids } = buildRookiePool(s);
      for (const id of ids) {
        seq.push(playerTier(s.players[id]));
        delete s.players[id];
      }
    }
    expect(seq.length).toBe(70 * CONFIG.draft.generatedPerSeason);
    const share = (t: Tier) => seq.filter((x) => x === t).length / seq.length;
    expect(share('A')).toBeGreaterThan(0.12);
    expect(share('A')).toBeLessThan(0.18);
    expect(share('S')).toBeGreaterThan(0.075);
    expect(share('S')).toBeLessThan(0.125);
    expect(share('SS')).toBeGreaterThan(0.03);
    expect(share('SS')).toBeLessThan(0.07);
    // 名义 3%，伪随机 + 每 100 名保底使实际略高于名义
    expect(share('SSR')).toBeGreaterThan(0.022);
    expect(share('SSR')).toBeLessThan(0.04);
    expect(share('C') + share('B')).toBeGreaterThan(0.62);
    // 任意连续 100 名新秀中至少 1 名 SSR
    let gap = 0;
    let maxGap = 0;
    for (const t of seq) {
      gap = t === 'SSR' ? 0 : gap + 1;
      maxGap = Math.max(maxGap, gap);
    }
    expect(maxGap).toBeLessThan(CONFIG.draft.ssrPityThreshold);
    expect(s.rookieDraft!.ssrPity).toBe(gap);
    for (const t of TIERS) expect(seq.includes(t)).toBe(true);
  });

  it('真实新秀计入保底计数；保底到点时程序生成的 SSR 插在真实新秀之前', () => {
    const s = makeTestState(2, 77);
    s.season.ti = 10;
    const reals = getPlayerIndex().filter((e) => e.firstTi === 10).slice(0, 6);
    expect(reals.length).toBe(6);
    for (const e of reals) s.futureRookies[e.id] = 10;
    s.rookieDraft = { ssrPity: CONFIG.draft.ssrPityThreshold - 1, history: [] };
    const pool = buildRookiePool(s);
    expect(pool.realCount).toBe(6);
    const first = s.players[pool.ids[0]];
    expect(first.isReal).toBe(false);
    expect(playerTier(first)).toBe('SSR');
    // 真实新秀从队列中移除并生成为自由选手，计入保底计数
    for (const e of reals) {
      expect(s.futureRookies[e.id]).toBeUndefined();
      expect(s.players[e.id]?.isReal).toBe(true);
      expect(pool.ids).toContain(e.id);
    }
    // 保底计数 = 最后一名 SSR 之后的新秀数
    const tiers = pool.ids.map((id) => playerTier(s.players[id]));
    const lastSsr = tiers.lastIndexOf('SSR');
    expect(s.rookieDraft!.ssrPity).toBe(tiers.length - 1 - lastSsr);

    // 计数接近保底线时由真实新秀推到线上 → 下一名程序生成新秀必为 SSR
    const t = makeTestState(2, 78);
    t.season.ti = 10;
    for (const e of reals.slice(0, 3)) t.futureRookies[e.id] = 10;
    t.rookieDraft = { ssrPity: CONFIG.draft.ssrPityThreshold - 3, history: [] };
    const p2 = buildRookiePool(t);
    const seq = p2.ids.map((id) => t.players[id]);
    const firstGen = seq.findIndex((p) => !p.isReal);
    expect(seq.slice(0, firstGen).every((p) => p.isReal)).toBe(true);
    const realBefore = seq.slice(0, firstGen).filter((p) => playerTier(p) !== 'SSR').length;
    if (realBefore >= 2 && seq.slice(0, firstGen).every((p) => playerTier(p) !== 'SSR')) {
      expect(playerTier(seq[firstGen])).toBe('SSR');
    }
  });
});

describe('rookieDraft · 赛季初免费放弃', () => {
  it('只能在赛季初放弃本队本届选中的新秀：无费用、不扣荣誉、进入自由市场', () => {
    const s = draftState(8, 21);
    // 玩家战队 t0 排名最好，第 8 顺位；确保有空位
    runRookieDraft(s);
    const mine = draftedRookiesOf(s, 't0');
    expect(mine.length).toBeGreaterThan(0);
    const other = s.teams.t5.playerIds.map((id) => s.players[id]).find((p) => p.draft?.ti === s.season.ti);
    expect(other).toBeTruthy();
    expect(releaseDraftedRookie(s, other!.id).ok).toBe(false);
    expect(releaseDraftedRookie(s, s.teams.t0.playerIds[0]).ok).toBe(false); // 非新秀
    expect(releaseDraftedRookie(s, 'ghost').ok).toBe(false);

    const p = mine[0];
    const gold = s.teams.t0.gold;
    const honor = s.teams.t0.honor;
    const fin = s.finance.length;
    const r = releaseDraftedRookie(s, p.id);
    expect(r.ok).toBe(true);
    expect(p.teamId).toBeNull();
    expect(s.teams.t0.playerIds).not.toContain(p.id);
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.teams.t0.honor).toBe(honor);
    expect(s.finance.length).toBe(fin);
    expect(freeAgents(s).some((x) => x.id === p.id)).toBe(true);
    expect(rookieDraftRecord(s)!.picks.find((x) => x.playerId === p.id)!.released).toBe(true);
    expect(releaseDraftedRookie(s, p.id).ok).toBe(false);

    // 被放弃后又被原队从自由市场签回：已是普通合同，不再算本届新秀
    addPlayerToTeam(s, p.id, 't0', { contractSeasons: 2 });
    expect(p.teamId).toBe('t0');
    expect(draftedRookiesOf(s, 't0').some((x) => x.id === p.id)).toBe(false);
    expect(draftedRookieReleaseBlock(s, p)).toMatch(/本届选秀/);
    expect(releaseCompensation(s, p.id)).toBeGreaterThan(0);

    // 赛季开始后不能免费放弃
    const q = mine[1] ?? null;
    s.phase = 'regular';
    if (q) {
      expect(draftedRookieReleaseBlock(s, q)).toMatch(/赛季初/);
      expect(releaseDraftedRookie(s, q.id).ok).toBe(false);
    }
  });

  it('赛季初从普通解约入口（releasePlayer / releasePlayers）放弃本届新秀同样免费', () => {
    const s = draftState(8, 23);
    runRookieDraft(s);
    const mine = draftedRookiesOf(s, 't0');
    expect(mine.length).toBeGreaterThan(0);
    const p = mine[0];
    expect(releaseCompensation(s, p.id)).toBe(0);
    const gold = s.teams.t0.gold;
    const honor = s.teams.t0.honor;
    const fin = s.finance.length;
    const r = mine.length > 1 ? releasePlayers(s, [p.id, mine[1].id]) : releasePlayer(s, p.id);
    expect(r.ok).toBe(true);
    expect(p.teamId).toBeNull();
    expect(s.teams.t0.gold).toBe(gold);
    expect(s.teams.t0.honor).toBe(honor);
    expect(s.finance.length).toBe(fin);
    expect(rookieDraftRecord(s)!.picks.find((x) => x.playerId === p.id)!.released).toBe(true);
    // 非新秀照常支付补偿
    const vet = s.teams.t0.playerIds.map((id) => s.players[id]).find((x) => !x.draft)!;
    expect(releaseCompensation(s, vet.id)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 集成：新游戏首个赛季、跨赛季、多人
// ---------------------------------------------------------------------------

function settle(state: GameState): void {
  for (let i = 0; i < 30 && state.pendingDecisions.length; i++) {
    const d = state.pendingDecisions[0];
    let r: OpResult = { ok: false, message: '' };
    for (const c of d.choices) if ((r = resolveDecision(state, d.id, c.id)).ok) break;
    if (!r.ok) state.pendingDecisions.shift();
  }
}

/** 单机：推进到下一个赛季（或游戏结束） */
function playToNextSeason(state: GameState): void {
  const ti = state.season.ti;
  for (let guard = 0; guard < 80 && state.season.ti === ti && !state.gameOver; guard++) {
    settle(state);
    quickSimTournament(state);
    settle(state);
    const r = advance(state);
    if (!r.ok) {
      const codes = getAdvanceBlockers(state).map((b) => b.code);
      if (codes.includes('game_over')) return;
      throw new Error(`无法推进：${r.message}`);
    }
  }
}

describe('rookieDraft · 集成', () => {
  // 选秀默认关闭（2026-10-14 抽卡取代选秀）：本组用例显式打开开关
  const draftCfg = CONFIG.draft as { enabled: boolean };
  let prevEnabled = draftCfg.enabled;
  beforeAll(() => {
    prevEnabled = draftCfg.enabled;
    draftCfg.enabled = true;
  });
  afterAll(() => {
    draftCfg.enabled = prevEnabled;
  });

  it('新游戏首个赛季同样举行选秀（按初始实力 + 荣誉），新俱乐部获得新秀；欢迎弹窗在前；次赛季按上赛季排名并纳入真实新秀', async () => {
    const g = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 2024,
      newClub: { name: 'Draft Club', tag: 'DFT', region: 'CN', color: '#123456' },
    });
    const me = g.settings.playerTeamId;
    const rec = rookieDraftRecord(g, 9)!;
    expect(rec).toBeTruthy();
    expect(rec.firstSeason).toBe(true);
    expect(rec.generatedCount).toBe(CONFIG.draft.generatedPerSeason);
    // 玩家战队的每个顺位都选人、新秀全部入队（新秀池选空后不再有顺位）
    const myPicks9 = rec.picks.filter((p) => p.teamId === me);
    expect(myPicks9.length).toBeGreaterThanOrEqual(1);
    expect(myPicks9.every((p) => !!p.playerId && !p.forfeited)).toBe(true);
    expect(draftedRookiesOf(g, me)).toHaveLength(myPicks9.length);
    expect(g.teams[me].playerIds.length).toBe(5 + myPicks9.length);
    expect(g.popups[0]).toMatchObject({ kind: 'message', title: '欢迎来到刀塔经理' });
    expect(g.popups.some((p) => p.kind === 'rookie_draft' && p.ti === 9)).toBe(true);
    expect(g.finance.some((f) => f.note.includes('创立礼包'))).toBe(false);
    // 新俱乐部（荣誉 100、实力偏弱）在抽签区
    expect(rec.lottery.some((e) => e.teamId === me)).toBe(true);
    // 没有放弃的顺位；AI 战队选秀与季前转会后阵容不超过 AI 上限
    expect(rec.picks.every((p) => !!p.playerId && !p.forfeited)).toBe(true);
    for (const t of Object.values(g.teams)) {
      if (!t.disbanded && t.id !== me) expect(t.playerIds.length).toBeLessThanOrEqual(CONFIG.ai.maxRoster);
    }

    playToNextSeason(g);
    if (g.gameOver) return;
    expect(g.season.ti).toBe(10);
    const rec10 = rookieDraftRecord(g, 10)!;
    expect(rec10).toBeTruthy();
    expect(rec10.firstSeason).toBeUndefined();
    expect(rec10.realCount).toBeGreaterThan(0);
    // 第二届同样不放弃顺位，玩家选中的新秀都在队；阵容人数不产生推进阻塞
    expect(rec10.picks.filter((p) => p.teamId === me).every((p) => !!p.playerId && !p.forfeited)).toBe(true);
    expect(getAdvanceBlockers(g).map((b) => b.code)).not.toContain('lineup_invalid');
    // 顺位依据上赛季排名：抽签区为排名最差的队
    const rankOf = (id: string) => g.teams[id]?.lastSeasonRank ?? Infinity;
    const worst = Object.keys(rec10.standings).sort((a, b) => rankOf(b) - rankOf(a) || (a < b ? -1 : 1));
    expect(rec10.lottery[0].teamId).toBe(worst[0]);
    expect(rec10.lottery.map((e) => e.teamId)).toEqual(worst.slice(0, rec10.lottery.length));
    // 本赛季的真实新秀：要么在选秀中被选中，要么落选（进入自由市场）——AI 不再在休赛期提前签下
    const draftedOrUndrafted = new Set([...rec10.picks.map((p) => p.playerId), ...rec10.undrafted]);
    for (const e of getPlayerIndex().filter((x) => x.firstTi === 10)) {
      const p = g.players[e.id];
      if (!p) continue;
      expect(draftedOrUndrafted.has(e.id)).toBe(true);
    }
    expect(g.rookieDraft!.history.map((r) => r.ti)).toEqual([9, 10]);
  }, 60_000);

  it('多人：选秀全局一次、弹窗按座位；赛季初免费放弃走 RPC 白名单', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 5,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    expect(g.rookieDraft!.history).toHaveLength(1);
    for (const id of [A, B]) {
      expect(M.withSeat(g, id, () => g.popups.filter((p) => p.kind === 'rookie_draft'))).toHaveLength(1);
    }
    const mine = g.teams[A].playerIds.find((pid) => g.players[pid].draft?.teamId === A);
    expect(mine).toBeTruthy();
    expect((M.callAsSeat(g, B, 'releaseDraftedRookie', [mine]) as OpResult).ok).toBe(false);
    expect((M.callAsSeat(g, A, 'releaseDraftedRookie', [mine]) as OpResult).ok).toBe(true);
    expect(g.players[mine!].teamId).toBeNull();
    // 旧版抽卡的 RPC 名已不存在（2026-10-14 抽卡回归后为 gachaPull / gachaDiscard）
    expect(() => M.callAsSeat(g, A, 'gachaDraw', [1])).toThrow();
    expect(() => M.callAsSeat(g, A, 'discardGachaPlayers', [[]])).toThrow();
    // 选秀开启时不建卡池：新秀抽卡不可用
    expect((M.callAsSeat(g, A, 'gachaPull', [1]) as OpResult).ok).toBe(false);
  });

  it('多人：每个座位同样适用软上限——阵容超出常规上限不阻塞准备，绝对上限挡住签约；超出绝对上限时不能准备', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 11,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    // 座位 A 塞到绝对上限
    const regular = (id: string) => g.teams[id].playerIds.filter((x) => !g.players[x].tempSubUntilTournament).length;
    const blockersBefore = M.seatBlockers(g, A).map((b) => b.code);
    while (regular(A) < CONFIG.team.hardMaxRoster) {
      const p = generatePlayer(g, { tier: 'B', position: 'SS' });
      addPlayerToTeam(g, p.id, A, { contractSeasons: 2 });
    }
    // 超出常规上限不产生新的阻塞：没有待决事件时可以直接准备
    expect(M.seatBlockers(g, A).map((b) => b.code)).toEqual(blockersBefore);
    if (!blockersBefore.length) expect(M.setSeatReady(g, A, true).ok).toBe(true);
    const fa = M.withSeat(g, A, () => freeAgents(g))[0];
    const r = M.callAsSeat(g, A, 'signFreeAgent', [fa.id]) as OpResult;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('绝对上限');
    // 再多 2 人（超出绝对上限，如抽卡超编）：不能准备，已准备的座位被撤销准备
    for (let i = 0; i < 2; i++) addPlayerToTeam(g, generatePlayer(g, { tier: 'B', position: 'SS' }).id, A, { contractSeasons: 2 });
    expect(M.seatBlockers(g, A).map((b) => b.code)).toContain('roster_over_cap');
    M.callAsSeat(g, A, 'markAllNewsRead', []);
    expect(g.multiplayer!.seats[A].ready).toBe(false);
    expect(M.setSeatReady(g, A, true).ok).toBe(false);
    // 座位 B 不受 A 的阵容影响
    expect(regular(B)).toBeLessThan(CONFIG.team.hardMaxRoster);
    expect(M.seatBlockers(g, B).map((b) => b.code)).not.toContain('lineup_invalid');
  });
});

// ---------------------------------------------------------------------------
// 第八波第 4 项：休赛回合忘记训练直接推进 → 回合结束自动用掉全部剩余训练额度
// ---------------------------------------------------------------------------

function restState(): GameState {
  const state = makeTestState(4);
  const start = seasonStartDate(9);
  const { startDate, endDate } = tiDates(9);
  state.season = { ...state.season, startDate: start, tiStartDate: startDate, rounds: buildRounds(9, start, startDate, endDate) };
  state.phase = 'regular';
  state.roundIndex = 2;
  state.currentDate = state.season.rounds[2].startDate;
  return state;
}

describe('休赛回合自动训练', () => {
  it('回合结束时用掉全部剩余额度（免费 + 已购额外），按当前焦点记为 auto', () => {
    const s = restState();
    expect(roundKindForPlayer(s, 2)).toBe('rest');
    s.trainingFocus = 'mmr';
    const max = CONFIG.training.maxExtraPerRound;
    for (let i = 0; i < max; i++) expect(buyExtraTraining(s).ok).toBe(true);
    const gold = s.teams.t0.gold;
    const mmrBefore = s.teams.t0.playerIds.reduce((a, id) => a + s.players[id].mmr, 0);
    endRound(s);
    const autos = trainingRecords(s).filter((r) => r.kind === 'auto');
    expect(autos).toHaveLength(1 + max);
    expect(autos.every((r) => r.focus === 'mmr')).toBe(true);
    expect(autos.filter((r) => r.session === 'free')).toHaveLength(1);
    expect(autos.filter((r) => r.session === 'extra')).toHaveLength(max);
    expect(s.extraTrainingAvailable).toBe(0);
    expect(s.freeTrainingUsed).toBe(true);
    expect(s.teams.t0.playerIds.reduce((a, id) => a + s.players[id].mmr, 0)).toBeGreaterThan(mmrBefore);
    // 自动训练不额外扣费（已购次数的价格在购买时已支付；回合结算只发生工资与经常性收入）
    expect(extraTrainingCost(s)).toBeGreaterThan(0);
    expect(s.finance.filter((f) => f.category === 'training')).toHaveLength(max);
    void gold;
  });

  it('多人：每个座位各自用掉自己的剩余额度', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'normal', mode: 'build', seed: 9,
      players: [
        { sessionId: 's-a', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's-b', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    const call = (id: string, fn: string, ...args: unknown[]) => M.callAsSeat(g, id, fn, args) as OpResult;
    const settleSeat = (id: string) => {
      for (let i = 0; i < 30; i++) {
        const d = M.withSeat(g, id, () => g.pendingDecisions[0]);
        if (!d) return;
        let r: OpResult = { ok: false, message: '' };
        for (const c of d.choices) if ((r = call(id, 'resolveDecision', d.id, c.id)).ok) break;
        if (!r.ok) return;
      }
    };
    const advanceAll = () => {
      for (const id of [A, B]) {
        settleSeat(id);
        call(id, 'quickSimTournament');
        settleSeat(id);
        const r = M.setSeatReady(g, id, true);
        if (!r.ok) throw new Error(r.message);
      }
      const r = M.advanceMultiplayer(g);
      if (!r.ok) throw new Error(r.message);
    };
    // 找到双方都是休赛回合的回合
    let found = false;
    for (let guard = 0; guard < 12 && !g.gameOver; guard++) {
      advanceAll();
      const restA = M.withSeat(g, A, () => roundKindForPlayer(g, g.roundIndex) === 'rest');
      const restB = M.withSeat(g, B, () => roundKindForPlayer(g, g.roundIndex) === 'rest');
      if (restA && restB) {
        found = true;
        break;
      }
    }
    if (!found) return; // 赛程使然（双方都没有共同休赛回合）：不做断言
    g.teams[A].gold += 1_000_000;
    expect(call(A, 'buyExtraTraining').ok).toBe(true);
    expect(call(A, 'buyExtraTraining').ok).toBe(true);
    const round = g.roundIndex;
    advanceAll();
    const autosOf = (id: string) => M.withSeat(g, id, () => trainingRecords(g).filter((r) => r.kind === 'auto' && r.round === round));
    expect(autosOf(A)).toHaveLength(3);
    expect(autosOf(B)).toHaveLength(1);
  }, 60_000);
});
