// 开局资金锚定（用户需求 2026-10-10「新队伍初始资金太少，强队初始资金太多，建议平衡，新队TI1的初始资金至少是20W，强队是10W」）：
// 新俱乐部 TI1 普通难度 20 万、最强真实俱乐部 TI1 普通难度 10 万（【用户指定】），其他起始届按年代经济指数折算；
// 其余真实俱乐部 = 原口径「数据资金 × 0.2」封顶于强队锚定额、不低于数据阵容 N 回合工资（审阅后由开平方改为封顶，第二档不再被削减）；
// 程序化生成的 AI 战队（开局 / 赛季中补足、假赛补位）同一公式；向导 / 房间预览与开局实际资金为同一函数。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, SeedTeam } from '../src/engine/types';
import { CONFIG, TI_YEAR } from '../src/engine/config';
import {
  econIndex, eraFundsFactor, estimateNewClubStart, newClubStartingFunds, realClubStartingFunds, realClubWealth, roundWageBill,
  seedTeamStartingFunds, seedTeamWageBill,
} from '../src/engine/economy';
import { createBlankState, createNewGame } from '../src/engine/game';
import { createMultiplayerGame, withSeat } from '../src/engine/multi';
import { generateAiTeam, teamFromSeed } from '../src/engine/generation';
import { readRosterSync, registerNodeRosterLoader, ROSTER_DIR } from '../scripts/nodeData';
import { readdirSync } from 'node:fs';

beforeAll(() => {
  registerNodeRosterLoader();
});

const SF = CONFIG.economy.startingFunds;
const DIFFS = ['easy', 'normal', 'hard'] as const;
const ROSTER_TIS = readdirSync(ROSTER_DIR)
  .map((f) => Number(/^ti(\d+)\.json$/.exec(f)?.[1]))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);
const NEW_CLUB = { name: '测试俱乐部', tag: 'TST', region: 'CN' as const, color: '#123456' };

/** 开局时的资金：当前资金减去开局后（赛季初选秀、第 0 回合事件等）记入账目的全部变动 */
function startGold(s: GameState, teamId: string): number {
  return s.teams[teamId].gold - s.finance.reduce((a, f) => a + f.amount, 0);
}

function topTeams(ti: number): SeedTeam[] {
  const teams = readRosterSync(ti).teams;
  const max = Math.max(...teams.map((t) => t.funds));
  return teams.filter((t) => t.funds === max);
}

describe('锚定额【用户指定】', () => {
  it('配置：新俱乐部 TI1 20 万、最强真实俱乐部 TI1 10 万', () => {
    expect(SF.newClubTi1Funds).toBe(200_000);
    expect(SF.realClubTopTi1Funds).toBe(100_000);
    expect(eraFundsFactor(1)).toBe(1);
  });

  it('新俱乐部：TI1 普通 = 200000，任何难度都不低于锚定额（「至少 20W」），简单不少于普通', () => {
    expect(newClubStartingFunds(1, 'normal')).toBe(200_000);
    for (const ti of ROSTER_TIS) {
      const anchor = newClubStartingFunds(ti, 'normal');
      expect(newClubStartingFunds(ti, 'hard')).toBeGreaterThanOrEqual(anchor);
      expect(newClubStartingFunds(ti, 'easy')).toBeGreaterThanOrEqual(anchor);
      expect(anchor).toBeGreaterThanOrEqual(200_000); // TI1 的经济指数最低
    }
  });

  it('最强真实俱乐部：TI1 普通难度 = 100000，困难 < 普通 < 简单', () => {
    const top = topTeams(1);
    expect(top.length).toBeGreaterThan(0);
    for (const st of top) {
      expect(seedTeamStartingFunds(st, 1, 'normal')).toBe(100_000);
      expect(seedTeamStartingFunds(st, 1, null)).toBe(100_000); // AI 同一公式
      expect(seedTeamStartingFunds(st, 1, 'hard')).toBeLessThan(100_000);
      expect(seedTeamStartingFunds(st, 1, 'easy')).toBeGreaterThan(100_000);
    }
  });

  it('年代折算：锚定额 × econIndex(该届) / econIndex(TI1)，随经济指数单调', () => {
    const e1 = econIndex(TI_YEAR[1]);
    for (const ti of ROSTER_TIS) {
      const f = econIndex(TI_YEAR[ti]) / e1;
      expect(eraFundsFactor(ti)).toBeCloseTo(f, 9);
      expect(newClubStartingFunds(ti, 'normal')).toBe(Math.round((200_000 * f) / 1000) * 1000);
      // 最强真实俱乐部（不计工资下限）
      expect(realClubStartingFunds(SF.realClubTopDataFunds * econIndex(TI_YEAR[ti]), 'normal', ti)).toBe(Math.round((100_000 * f) / 1000) * 1000);
    }
    for (const a of ROSTER_TIS) {
      for (const b of ROSTER_TIS) {
        if (econIndex(TI_YEAR[a]) < econIndex(TI_YEAR[b])) {
          expect(newClubStartingFunds(a, 'normal')).toBeLessThan(newClubStartingFunds(b, 'normal'));
          expect(realClubStartingFunds(SF.realClubTopDataFunds * econIndex(TI_YEAR[a]), 'normal', a))
            .toBeLessThan(realClubStartingFunds(SF.realClubTopDataFunds * econIndex(TI_YEAR[b]), 'normal', b));
        }
      }
    }
    expect(newClubStartingFunds(9, 'normal')).toBe(800_000);
    expect(realClubStartingFunds(4_000_000, 'normal', 9)).toBe(400_000);
  });

  it('数据约定：各届阵容中最富真实俱乐部的数据资金 = realClubTopDataFunds × econIndex(年份)（锚定额正好落在最强俱乐部上）', () => {
    for (const ti of ROSTER_TIS) {
      const roster = readRosterSync(ti);
      const max = Math.max(...roster.teams.map((t) => t.funds));
      expect(max).toBe(Math.round(SF.realClubTopDataFunds * econIndex(roster.year)));
      expect(realClubWealth(max, ti)).toBe(1);
    }
  });
});

describe('真实俱乐部：原口径封顶于锚定额 + 工资下限', () => {
  it('锚定额是封顶额：相对财力 ≥ realClubFullWealth 拿满，以下按比例（= 数据资金 × 0.2）', () => {
    const ref = SF.realClubTopDataFunds * econIndex(TI_YEAR[9]);
    const top = realClubStartingFunds(ref, null, 9);
    expect(top).toBe(400_000);
    expect(SF.realClubFullWealth).toBe(0.5);
    expect(realClubStartingFunds(ref / 2, null, 9)).toBe(top); // 第二档 = 锚定额（原口径 × 0.2 正好如此，不被削减）
    expect(realClubStartingFunds(ref / 4, null, 9)).toBe(Math.round((ref / 4) * 0.2 / 1000) * 1000);
    expect(realClubStartingFunds(ref / 8, null, 9)).toBe(Math.round((ref / 8) * 0.2 / 1000) * 1000);
    let prev = -1;
    for (const k of [1 / 16, 1 / 8, 1 / 4, 0.4, 1 / 2, 0.7, 1]) {
      const v = realClubStartingFunds(ref * k, null, 9);
      expect(v).toBeGreaterThanOrEqual(prev); // 单调不减
      expect(v).toBeLessThanOrEqual(top);
      prev = v;
    }
    expect(realClubStartingFunds(ref * 3, null, 9)).toBe(top); // 相对财力至多 1
    expect(realClubStartingFunds(NaN, 'normal', 9)).toBe(0);
  });

  it('全部阵容数据：只有最富一档比原口径（数据资金 × 0.2）少；不计工资下限时没有俱乐部超过锚定额', () => {
    for (const ti of ROSTER_TIS) {
      const anchor = Math.round((100_000 * eraFundsFactor(ti)) / 1000) * 1000;
      for (const st of readRosterSync(ti).teams) {
        const v = seedTeamStartingFunds(st, ti, null);
        const old = Math.round((st.funds * 0.2) / 1000) * 1000;
        const floor = Math.round((seedTeamWageBill(st, ti) * SF.realClubMinWageRounds) / 1000) * 1000;
        expect(v).toBe(Math.max(Math.min(anchor, old), floor));
        if (realClubWealth(st.funds, ti) < 1) expect(v).toBeGreaterThanOrEqual(old);
        expect(v).toBeLessThanOrEqual(Math.max(anchor, floor));
      }
    }
  });

  it('下限 = 每回合工资 × realClubMinWageRounds（再乘难度倍数）', () => {
    const wage = 50_000;
    const floor = wage * SF.realClubMinWageRounds;
    expect(realClubStartingFunds(0, null, 9, wage)).toBe(Math.round(floor / 1000) * 1000);
    expect(realClubStartingFunds(0, 'hard', 9, wage)).toBe(Math.round((floor * CONFIG.team.realClubFundsMult.hard) / 1000) * 1000);
    // 下限不影响 TI1 最强俱乐部的锚定额
    for (const st of topTeams(1)) expect(seedTeamWageBill(st, 1) * SF.realClubMinWageRounds).toBeLessThan(100_000);
  });

  it('seedTeamWageBill 与开局后 AI 战队的实际工资一致（预览可在开局前算出）', () => {
    let checked = 0;
    for (const ti of ROSTER_TIS) {
      const roster = readRosterSync(ti);
      const s = createBlankState({
        seed: 5, createdAt: '2026-10-10T00:00:00.000Z', startTi: ti, endTi: ti, difficulty: 'normal', managerName: 't', playerTeamId: '',
      });
      for (const st of roster.teams) {
        if (s.teams[st.id]) continue;
        teamFromSeed(s, st, false);
        const own = st.players.every((sp) => s.players[sp.id]?.teamId === st.id)
          && (!st.coach || s.teams[st.id].coachId === st.coach.id);
        if (!own) continue; // 同一选手 / 教练在多支战队重复出现（以先注册者为准）
        expect(roundWageBill(s, st.id)).toBe(seedTeamWageBill(st, ti));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe('边界与程序化战队', () => {
  it('非法起始届按 TI1 处理（不会静默得到最高年代的资金）', () => {
    expect(eraFundsFactor(NaN)).toBe(1);
    expect(eraFundsFactor(undefined as unknown as number)).toBe(1);
    expect(newClubStartingFunds(NaN, 'normal')).toBe(200_000);
    expect(realClubWealth(1_000_000, NaN)).toBe(realClubWealth(1_000_000, 1));
  });

  it('generateAiTeam（开局补足 / 赛季初补足联赛规模 / 假赛补位）：资金按真实俱乐部同一公式，不再是原始生成额', () => {
    for (const ti of [1, 9, 13]) {
      const s = createBlankState({
        seed: 21, createdAt: '2026-10-11T00:00:00.000Z', startTi: ti, endTi: ti, difficulty: 'normal', managerName: 't', playerTeamId: '',
      });
      const anchor = 100_000 * eraFundsFactor(ti);
      for (const strength of ['weak', 'mid', 'strong'] as const) {
        for (let i = 0; i < 4; i++) {
          const t = generateAiTeam(s, 'EU', strength);
          const floor = Math.round((roundWageBill(s, t.id) * SF.realClubMinWageRounds) / 1000) * 1000;
          expect(t.gold).toBeGreaterThanOrEqual(floor);
          // 生成额至多 180 万 × 经济指数（相对财力 0.45 < 1/2）→ 资金低于锚定额，除非工资下限更高
          expect(t.gold).toBeLessThanOrEqual(Math.max(Math.round(anchor / 1000) * 1000, floor));
          const [, hi] = CONFIG.generation.aiTeam.funds[strength];
          expect(t.gold).toBeLessThanOrEqual(Math.max(Math.round((hi * econIndex(TI_YEAR[ti]) * 0.2) / 1000) * 1000, floor));
        }
      }
    }
  });
});

describe('开局实际资金 = 预览（同一函数）', () => {
  it('单机新建俱乐部：TI1 普通 20 万；各起始届 / 难度与向导预估相同', async () => {
    for (const startTi of [1, 9, 13]) {
      for (const difficulty of DIFFS) {
        const s = await createNewGame({ startTi, seasons: 1, difficulty, managerName: 't', seed: 11, newClub: NEW_CLUB });
        const me = s.settings.playerTeamId;
        expect(startGold(s, me)).toBe(estimateNewClubStart(startTi, difficulty).funds);
        expect(startGold(s, me)).toBe(newClubStartingFunds(startTi, difficulty));
        if (startTi === 1 && difficulty === 'normal') expect(startGold(s, me)).toBe(200_000);
      }
    }
  });

  it('单机接管真实俱乐部：TI1 最强俱乐部普通难度 10 万；与向导战队卡片（seedTeamStartingFunds）相同', async () => {
    for (const st of topTeams(1)) {
      const s = await createNewGame({ startTi: 1, seasons: 1, difficulty: 'normal', managerName: 't', seed: 11, teamId: st.id });
      expect(startGold(s, st.id)).toBe(100_000);
    }
    for (const [ti, pick] of [[9, 0], [9, 14], [13, 25], [5, 13]] as const) {
      const teams = readRosterSync(ti).teams.slice().sort((a, b) => b.funds - a.funds || a.id.localeCompare(b.id));
      const st = teams[Math.min(pick, teams.length - 1)];
      for (const difficulty of ['normal', 'hard'] as const) {
        const s = await createNewGame({ startTi: ti, seasons: 1, difficulty, managerName: 't', seed: 7, teamId: st.id });
        expect(startGold(s, st.id)).toBe(seedTeamStartingFunds(st, ti, difficulty));
      }
    }
  });

  it('开局 AI 战队：真实俱乐部同一公式（不乘难度倍数）；新俱乐部比 TI1 最强俱乐部多', async () => {
    const s = await createNewGame({ startTi: 1, seasons: 1, difficulty: 'hard', managerName: 't', seed: 11, newClub: NEW_CLUB });
    const me = s.settings.playerTeamId;
    for (const st of topTeams(1)) expect(seedTeamStartingFunds(st, 1, null)).toBe(100_000);
    expect(startGold(s, me)).toBeGreaterThan(100_000);
  });

  it('多人：各自组建 / 选择已有战队（重置为新俱乐部标准）都按新俱乐部锚定额', async () => {
    const build = await createMultiplayerGame({
      startTi: 1, endTi: 2, difficulty: 'normal', mode: 'build', seed: 3,
      players: [{ sessionId: 'a', name: 'A', newClub: NEW_CLUB }, { sessionId: 'b', name: 'B', newClub: { ...NEW_CLUB, name: '测试二', tag: 'TSB' } }],
    });
    for (const id of build.multiplayer!.order) {
      expect(withSeat(build, id, () => startGold(build, id))).toBe(200_000);
    }
    const roster = readRosterSync(9);
    const [a, b] = roster.teams.slice().sort((x, y) => y.funds - x.funds);
    const ex = await createMultiplayerGame({
      startTi: 9, endTi: 9, difficulty: 'hard', mode: 'existing', seed: 3,
      players: [{ sessionId: 'x', name: 'x', teamId: a.id }, { sessionId: 'y', name: 'y', teamId: b.id }],
    });
    for (const id of [a.id, b.id]) {
      expect(withSeat(ex, id, () => startGold(ex, id))).toBe(newClubStartingFunds(9, 'hard'));
    }
  });
});
