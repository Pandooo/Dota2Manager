// 破产（src/engine/bankruptcy.ts，第十波 #1）：资金连续为负 N 回合 / 负债超过 N 回合工资 → 破产；
// 单机 → 游戏结束（reason = bankrupt，专门结局 + 生涯总结）；多人 → 该座位出局观战；AI 俱乐部不受影响；无误判。
// 以及背景音乐（src/ui/audio/bgm.ts）中与浏览器无关的纯逻辑：设置解析 / 音量曲线 / 音源选择 / 生成音乐的乐谱。
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, OpResult } from '../src/engine/types';
import { CONFIG } from '../src/engine/config';
import { registerNodeRosterLoader } from '../scripts/nodeData';
import {
  bankruptcyCountdownText, bankruptcyRules, bankruptcyStatus, checkBankruptcy, debtLimitOf, declareBankruptcy,
} from '../src/engine/bankruptcy';
import { roundWageBill } from '../src/engine/economy';
import { computeLegacyReport, legacyEndingOf } from '../src/engine/legacy';
import { applyHonorChange } from '../src/engine/honor';
import { advance, createNewGame, fillLineupWithTempSubs, getAdvanceBlockers, quickSimTournament } from '../src/engine/game';
import { resolveDecision } from '../src/engine/events';
import * as M from '../src/engine/multi';
import { makeTestState } from './helpers';
import {
  ARP_PATTERN, BGM_DEFAULTS, BGM_MAX_FILE_BYTES, PROGRESSION, arpNoteAt, chordAt, effectiveSource, fadeSeconds,
  midiToFreq, parseBgmSettings, patternLengthSeconds, serializeBgmSettings, targetGain, validateAudioFile, volumeToGain,
} from '../src/ui/audio/bgm';

beforeAll(() => {
  registerNodeRosterLoader();
});

const R = () => bankruptcyRules().rounds;

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

describe('bankruptcy · 参数', () => {
  it('CONFIG.bankruptcy：连续 3 回合为负 / 负债超过 6 回合工资', () => {
    expect(CONFIG.bankruptcy.rounds).toBe(3);
    expect(CONFIG.bankruptcy.debtWageRounds).toBe(6);
    expect(bankruptcyRules()).toEqual({ rounds: 3, debtWageRounds: 6 });
    expect(bankruptcyCountdownText(2)).toBe('资金为负：再持续 2 回合将破产');
  });
});

describe('bankruptcy · 单机判定', () => {
  it('资金连续 N 回合为负 → 破产：每回合预警倒计时，第 N 回合结束游戏（reason = bankrupt）', () => {
    const s = makeTestState(6);
    const team = s.teams.t0;
    team.gold = -1000; // 远低于负债上限，只会触发「连续为负」规则
    for (let n = 1; n < R(); n++) {
      expect(checkBankruptcy(s)).toEqual([]);
      expect(team.negativeFundsRounds).toBe(n);
      expect(s.gameOver).toBeNull();
      expect(s.news[0].title).toContain(bankruptcyCountdownText(R() - n));
      expect(s.news[0].visibility).toBe('private');
      expect(bankruptcyStatus(s, 't0')).toMatchObject({ warning: true, negativeRounds: n, roundsLeft: R() - n, debtOver: false });
    }
    expect(checkBankruptcy(s)).toEqual(['t0']);
    expect(s.gameOver?.reason).toBe('bankrupt');
    expect(s.gameOver?.summary).toContain('破产');
    expect(s.gameOver?.summary).toContain(`连续 ${R()} 个回合为负`);
    expect(team.disbanded).toBe(true);
    expect(team.bankrupt).toMatchObject({ rule: 'rounds', gold: -1000, negativeRounds: R(), season: 9 });
    // 生涯档案冻结、结局为破产（专门结局叙述）
    expect(s.legacyLog?.t0?.[0]?.ending).toBe('bankrupt');
    expect(legacyEndingOf(s, 't0')).toBe('bankrupt');
    const rep = computeLegacyReport(s, 't0');
    expect(rep.ending).toBe('bankrupt');
    expect(rep.epilogue.join('')).toContain('破产');
    expect(s.news.some((n) => n.title.includes('【破产】') && n.visibility === 'public')).toBe(true);
    // 游戏已结束：不再推进、不再重复判定
    expect(getAdvanceBlockers(s)[0]?.message).toContain('破产');
    expect(checkBankruptcy(s)).toEqual([]);
    expect(declareBankruptcy(s, 't0', 'debt')).toBe(false);
  });

  it('资金回正即清零：倒计时解除，之后重新计数（不会因为不连续的负资金回合误判）', () => {
    const s = makeTestState(6);
    const team = s.teams.t0;
    team.gold = -500;
    checkBankruptcy(s);
    checkBankruptcy(s);
    expect(team.negativeFundsRounds).toBe(R() - 1);
    team.gold = 0; // 恰好为 0 不算负
    checkBankruptcy(s);
    expect(team.negativeFundsRounds).toBeUndefined();
    expect(s.news[0].title).toContain('资金回正');
    expect(bankruptcyStatus(s, 't0').warning).toBe(false);
    team.gold = -500;
    for (let i = 0; i < R() - 1; i++) checkBankruptcy(s);
    expect(s.gameOver).toBeNull();
    expect(team.negativeFundsRounds).toBe(R() - 1);
  });

  it('负债超过 N 回合工资 → 立即破产；恰好等于上限不破产', () => {
    const s = makeTestState(6);
    const team = s.teams.t0;
    const wage = roundWageBill(s, 't0');
    expect(wage).toBeGreaterThan(0);
    const limit = debtLimitOf(s, 't0')!;
    expect(limit).toBe(wage * CONFIG.bankruptcy.debtWageRounds);
    team.gold = -limit;
    expect(checkBankruptcy(s)).toEqual([]);
    expect(s.gameOver).toBeNull();
    expect(bankruptcyStatus(s, 't0')).toMatchObject({ debt: limit, debtLimit: limit, debtOver: false });
    team.gold = -limit - 1;
    expect(bankruptcyStatus(s, 't0').debtOver).toBe(true);
    expect(checkBankruptcy(s)).toEqual(['t0']);
    expect(s.gameOver?.reason).toBe('bankrupt');
    expect(team.bankrupt?.rule).toBe('debt');
    expect(s.gameOver?.summary).toContain(`超过 ${CONFIG.bankruptcy.debtWageRounds} 个回合的工资`);
  });

  it('负债期间裁员降低工资不会降低负债上限（削减开支不会反而立即破产）；资金回正后重新按当前工资计算', () => {
    const s = makeTestState(6);
    const team = s.teams.t0;
    const wage = roundWageBill(s, 't0');
    expect(wage).toBeGreaterThan(0);
    team.gold = -2 * wage;
    expect(checkBankruptcy(s)).toEqual([]);
    expect(team.negativeFundsWageBill).toBe(wage);
    // 裁掉一半队员：当前工资下降，但上限仍按本轮负债期间的最高工资
    for (const id of team.playerIds.slice(0, Math.ceil(team.playerIds.length / 2))) s.players[id].status = 'retired';
    const lower = roundWageBill(s, 't0');
    expect(lower).toBeLessThan(wage);
    expect(debtLimitOf(s, 't0')).toBe(wage * CONFIG.bankruptcy.debtWageRounds);
    team.gold = -(lower * CONFIG.bankruptcy.debtWageRounds + 1); // 超过「当前工资 × 6」，但未超过「最高工资 × 6」
    expect(bankruptcyStatus(s, 't0').debtOver).toBe(false);
    expect(checkBankruptcy(s)).toEqual([]);
    expect(s.gameOver).toBeNull();
    expect(team.negativeFundsWageBill).toBe(wage);
    // 资金回正：记录清除，之后按当前工资计算上限
    team.gold = 0;
    checkBankruptcy(s);
    expect(team.negativeFundsWageBill).toBeUndefined();
    expect(debtLimitOf(s, 't0')).toBe(lower * CONFIG.bankruptcy.debtWageRounds);
  });

  it('没有工资时负债规则不适用（只按连续回合判定）', () => {
    const s = makeTestState(6);
    const team = s.teams.t0;
    for (const id of team.playerIds) s.players[id].status = 'retired';
    expect(roundWageBill(s, 't0')).toBe(0);
    expect(debtLimitOf(s, 't0')).toBeNull();
    team.gold = -10_000_000;
    expect(checkBankruptcy(s)).toEqual([]);
    expect(s.gameOver).toBeNull();
    expect(bankruptcyStatus(s, 't0')).toMatchObject({ debtLimit: null, debtOver: false, negativeRounds: 1 });
  });

  it('无误判：资金 ≥ 0 不计数、不发新闻；AI 俱乐部负债再多也不受影响', () => {
    const s = makeTestState(6);
    s.teams.t0.gold = 0;
    s.teams.t3.gold = -50_000_000;
    s.teams.t4.gold = -1;
    for (let i = 0; i < R() + 2; i++) expect(checkBankruptcy(s)).toEqual([]);
    expect(s.gameOver).toBeNull();
    expect(s.news).toHaveLength(0);
    for (const id of ['t0', 't3', 't4']) {
      expect(s.teams[id].negativeFundsRounds).toBeUndefined();
      expect(s.teams[id].bankrupt).toBeUndefined();
      expect(s.teams[id].disbanded).toBeFalsy();
    }
    expect(declareBankruptcy(s, 't3', 'debt')).toBe(false); // 只对人类俱乐部
    expect(bankruptcyStatus(s, 't0')).toMatchObject({ negative: false, warning: false, bankrupt: false, roundsLeft: R() });
  });

  it('已因荣誉解散的玩家俱乐部不再判定破产', () => {
    const s = makeTestState(6);
    s.teams.t0.gold = -10_000_000;
    applyHonorChange(s, 't0', -10_000, '测试', true);
    expect(s.gameOver?.reason).toBe('disbanded');
    expect(checkBankruptcy(s)).toEqual([]);
    expect(s.gameOver?.reason).toBe('disbanded');
    expect(s.teams.t0.bankrupt).toBeUndefined();
  });
});

describe('bankruptcy · 整局集成', () => {
  it('单机：回合结算时检查，持续负资金的第 N 个回合后游戏结束且无法继续推进', async () => {
    const g = await createNewGame({
      startTi: 9, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 5,
      newClub: { name: '测试', tag: 'TST', region: 'CN', color: '#c23c2a' },
    });
    const me = g.settings.playerTeamId;
    const team = g.teams[me];
    team.honor = 5000; // 排除欠薪扣荣誉导致的解散
    expect(step(g).ok).toBe(true); // 赛季初 → 第 1 回合
    for (let i = 1; i <= R(); i++) {
      // 回合内资金持续为负：4 回合工资的负债，本回合收入 + 奖金不足以回正，工资照付后也不超过 6 回合工资的上限
      team.gold = -4 * roundWageBill(g, me);
      expect(g.gameOver).toBeNull();
      step(g);
      expect(team.negativeFundsRounds ?? 0).toBe(i < R() ? i : R());
      if (i < R()) expect(g.news.some((n) => n.title.includes(bankruptcyCountdownText(R() - i)))).toBe(true);
    }
    expect(g.gameOver?.reason).toBe('bankrupt');
    expect(team.bankrupt?.round).toBe(R());
    expect(advance(g).ok).toBe(false);
    expect(computeLegacyReport(g, me).ending).toBe('bankrupt');
  }, 30_000);

  it('多人：破产的座位出局转观战（选手离队），其余玩家继续；全部破产 → 游戏结束（bankrupt）', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 11,
      players: [
        { sessionId: 's0', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    for (const id of [A, B]) g.teams[id].honor = 5000;
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
    expect(advanceAll().ok).toBe(true); // 赛季初 → 第 1 回合

    // A 负资金但未超过负债上限：只收到私有预警（B 看不到）；B 负债远超上限：本回合结算即破产
    g.teams[A].gold = -4 * roundWageBill(g, A);
    g.teams[B].gold = -100_000_000;
    expect(advanceAll().ok).toBe(true);
    expect(g.multiplayer!.seats[B].eliminated).toBe(true);
    expect(g.teams[B].bankrupt?.rule).toBe('debt');
    expect(g.teams[B].disbanded).toBe(true);
    expect(g.teams[B].playerIds).toHaveLength(0); // 出局收尾：选手成为自由选手
    expect(g.gameOver).toBeNull();
    expect(M.activeHumanIds(g)).toEqual([A]);
    expect(call(B, 'doTraining').ok).toBe(false);
    expect(g.legacyLog?.[B]?.filter((r) => r.ending)).toHaveLength(1);
    expect(g.legacyLog?.[B]?.[0]?.ending).toBe('bankrupt');
    expect(computeLegacyReport(M.seatView(g, B), B, [A, B]).ending).toBe('bankrupt');
    expect(g.news.some((n) => n.title.includes('【出局】') && n.title.includes('破产'))).toBe(true);
    const viewA = M.seatView(g, A);
    expect(viewA.popups.some((p) => p.kind === 'message' && p.title.includes('破产'))).toBe(true);
    expect(viewA.news.some((n) => n.title.includes('破产预警'))).toBe(true);
    expect(M.seatView(g, B).news.some((n) => n.title.includes('破产预警'))).toBe(false);
    expect(g.teams[A].negativeFundsRounds).toBe(1);
    expect(M.withSeat(g, B, () => getAdvanceBlockers(g)[0]?.message)).toContain('破产');

    // 游戏继续；A 也破产 → 全部出局，游戏结束
    g.teams[A].gold = -100_000_000;
    advanceAll();
    expect(g.teams[A].bankrupt).toBeTruthy();
    expect(g.gameOver?.reason).toBe('bankrupt');
    expect(g.gameOver?.summary).toContain('破产');
    expect(g.multiplayer!.activeSeat).toBeNull();
  }, 30_000);

  it('多人：一名玩家荣誉解散、另一名破产 → 游戏结束为 disbanded，各自结局正确', async () => {
    const g = await M.createMultiplayerGame({
      startTi: 9, endTi: 10, difficulty: 'normal', mode: 'build', seed: 7,
      players: [
        { sessionId: 's0', name: '甲', newClub: { name: 'Alpha Club', tag: 'ALP', region: 'CN', color: '#c23c2a' } },
        { sessionId: 's1', name: '乙', newClub: { name: 'Beta Club', tag: 'BET', region: 'EU', color: '#3a7bd5' } },
      ],
    });
    const [A, B] = g.multiplayer!.order;
    applyHonorChange(g, A, -(g.teams[A].honor + 10), '测试', true);
    expect(declareBankruptcy(g, B, 'rounds')).toBe(true);
    M.callAsSeat(g, A, 'markAllNewsRead', []); // 出局收尾
    expect(g.gameOver?.reason).toBe('disbanded');
    expect(legacyEndingOf(g, A)).toBe('disbanded');
    expect(legacyEndingOf(g, B)).toBe('bankrupt');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 背景音乐：纯逻辑部分（浏览器播放器本身需要 WebAudio，不在 Node 测试）
// ---------------------------------------------------------------------------

describe('bgm · 设置', () => {
  it('默认：开启、内置原创生成音乐、适中音量', () => {
    expect(BGM_DEFAULTS.enabled).toBe(true);
    expect(BGM_DEFAULTS.source).toBe('generated');
    expect(BGM_DEFAULTS.volume).toBeGreaterThan(0);
    expect(BGM_DEFAULTS.volume).toBeLessThanOrEqual(1);
  });

  it('解析：损坏 / 非法 / 缺失的字段回退默认值，音量夹到 [0, 1]', () => {
    expect(parseBgmSettings(null)).toEqual(BGM_DEFAULTS);
    expect(parseBgmSettings('not json')).toEqual(BGM_DEFAULTS);
    expect(parseBgmSettings('{"enabled":false}')).toEqual({ ...BGM_DEFAULTS, enabled: false });
    expect(parseBgmSettings({ volume: 7 }).volume).toBe(1);
    expect(parseBgmSettings({ volume: -1 }).volume).toBe(0);
    expect(parseBgmSettings({ volume: 'x' }).volume).toBe(BGM_DEFAULTS.volume);
    expect(parseBgmSettings({ source: 'spotify' }).source).toBe('generated');
    expect(parseBgmSettings({ source: 'file', fileName: 'a.mp3' })).toMatchObject({ source: 'file', fileName: 'a.mp3' });
    expect(parseBgmSettings({ fileName: 42 }).fileName).toBeUndefined();
    expect(parseBgmSettings({ fileName: 'x'.repeat(500) }).fileName!.length).toBeLessThanOrEqual(120);
  });

  it('序列化后可还原', () => {
    const s = { enabled: false, volume: 0.42, source: 'file' as const, fileName: '我的歌.ogg' };
    expect(parseBgmSettings(serializeBgmSettings(s))).toEqual(s);
  });

  it('音源选择：选了本地文件但文件不存在（被清除 / 读取失败）时回退到内置音乐', () => {
    expect(effectiveSource({ ...BGM_DEFAULTS, source: 'file' }, true)).toBe('file');
    expect(effectiveSource({ ...BGM_DEFAULTS, source: 'file' }, false)).toBe('generated');
    expect(effectiveSource({ ...BGM_DEFAULTS, source: 'generated' }, true)).toBe('generated');
  });

  it('目标音量：关闭 / 标签页隐藏 / 尚未解锁（自动播放策略）时为 0；音量曲线单调', () => {
    const on = { ...BGM_DEFAULTS, enabled: true, volume: 0.5 };
    expect(targetGain(on, { hidden: false, unlocked: true })).toBeCloseTo(volumeToGain(0.5));
    expect(targetGain(on, { hidden: true, unlocked: true })).toBe(0);
    expect(targetGain(on, { hidden: false, unlocked: false })).toBe(0);
    expect(targetGain({ ...on, enabled: false }, { hidden: false, unlocked: true })).toBe(0);
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBeCloseTo(1);
    let last = -1;
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const gv = volumeToGain(v);
      expect(gv).toBeGreaterThan(last);
      last = gv;
    }
    expect(fadeSeconds('in')).toBeGreaterThan(0);
    expect(fadeSeconds('out')).toBeGreaterThan(0);
  });

  it('本地文件校验：只接受音频、限制大小', () => {
    expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: 3_000_000 })).toBeNull();
    expect(validateAudioFile({ name: 'a.flac', type: '', size: 1000 })).toBeNull(); // 部分系统不给 MIME，按扩展名
    expect(validateAudioFile({ name: 'a.txt', type: 'text/plain', size: 10 })).toContain('音频');
    expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: 0 })).toContain('空');
    expect(validateAudioFile({ name: 'a.mp3', type: 'audio/mpeg', size: BGM_MAX_FILE_BYTES + 1 })).toContain('过大');
  });
});

describe('bgm · 生成音乐乐谱', () => {
  it('和弦进行循环、确定性，音高在合理范围', () => {
    expect(PROGRESSION.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < PROGRESSION.length * 2; i++) {
      const c = chordAt(i);
      expect(c).toEqual(chordAt(i + PROGRESSION.length));
      expect(c.notes.length).toBeGreaterThanOrEqual(3);
      for (const n of c.notes) {
        expect(n).toBeGreaterThanOrEqual(36);
        expect(n).toBeLessThanOrEqual(84);
      }
    }
    expect(chordAt(-1)).toEqual(chordAt(PROGRESSION.length - 1));
  });

  it('琶音：取自当前和弦音（可升八度），节奏缓慢，循环长度约一分钟', () => {
    expect(ARP_PATTERN.length).toBeGreaterThan(0);
    for (let chord = 0; chord < PROGRESSION.length; chord++) {
      const pcs = new Set(chordAt(chord).notes.map((n) => n % 12));
      for (let s = 0; s < ARP_PATTERN.length; s++) {
        const n = arpNoteAt(chord, s);
        if (n === null) continue;
        expect(pcs.has(n % 12)).toBe(true);
        expect(n).toBeLessThanOrEqual(96);
      }
    }
    const len = patternLengthSeconds();
    expect(len).toBeGreaterThan(30);
    expect(len).toBeLessThan(180);
  });

  it('midiToFreq：A4 = 440Hz，八度翻倍', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(81)).toBeCloseTo(880);
    expect(midiToFreq(57)).toBeCloseTo(220);
  });
});
