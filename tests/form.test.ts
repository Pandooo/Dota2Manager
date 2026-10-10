import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import {
  FORM_SOURCE, applySeasonForm, clearSeasonForm, formLabel, formSigma, formTrendOf, peakWindow, rollSeasonForm,
  seasonFormOf, seasonFormRounds, trendDeclineMult, trendDrift, trendGrowthMult, updateFormTrend, yearsPastPeak,
} from '../src/engine/form';
import {
  ageFactor, agePlayersAtSeasonEnd, expectedMmrDecline, expectedPowerDecline, processRetirements,
} from '../src/engine/growth';
import { effectivePower, tickModifiers } from '../src/engine/player';
import { seededRng } from '../src/engine/rng';
import type { GameState, Player, Position, RoundInfo } from '../src/engine/types';
import { makePlayer, makeTestState } from './helpers';

/** 单年间隔赛季（TI11=2022 → TI12=2023），并给赛季填上 n 个回合（回合 0 = 赛季初） */
function seasonState(teams = 2, seed = 1, rounds = 21): GameState {
  const s = makeTestState(teams, seed);
  s.season.ti = 11;
  s.season.year = 2022;
  s.season.rounds = Array.from({ length: rounds }, (_, i): RoundInfo => ({
    index: i,
    phase: i === 0 ? 'preseason' : 'regular',
    startDate: '2022-01-01',
    endDate: '2022-01-02',
    tournamentIds: [],
    patchVersions: [],
  }));
  return s;
}

function formMods(p: Player) {
  return p.modifiers.filter((m) => m.source === FORM_SOURCE);
}

const sd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('form: 位置巅峰窗口', () => {
  it('窗口：核心/中单 21–25、劣势路 22–26、辅助 23–28', () => {
    expect(peakWindow('C')).toEqual([21, 25]);
    expect(peakWindow('M')).toEqual([21, 25]);
    expect(peakWindow('O')).toEqual([22, 26]);
    expect(peakWindow('SS')).toEqual([23, 28]);
    expect(peakWindow('HS')).toEqual([23, 28]);
    expect(yearsPastPeak(27, 'C')).toBe(2);
    expect(yearsPastPeak(27, 'HS')).toBe(0);
    expect(yearsPastPeak(30, 'HS')).toBe(2);
  });

  it('巅峰后衰减逐季加速（不是断崖），辅助更晚开始衰退；天梯分同理', () => {
    for (const pos of ['C', 'M', 'O', 'SS', 'HS'] as Position[]) {
      const [, end] = peakWindow(pos);
      expect(expectedPowerDecline(end, pos)).toBe(0);
      let prev = 0;
      for (let y = 1; y <= 6; y++) {
        const d = expectedPowerDecline(end + y, pos);
        expect(d).toBeGreaterThan(prev);
        // 逐季加速但每季增量有限（不会一季内崩盘）
        expect(d - prev).toBeLessThan(1.5);
        prev = d;
      }
      expect(expectedMmrDecline(end + 3, pos)).toBeGreaterThan(expectedMmrDecline(end + 1, pos));
    }
    expect(expectedPowerDecline(27, 'C')).toBeGreaterThan(0);
    expect(expectedPowerDecline(27, 'HS')).toBe(0);
    expect(expectedPowerDecline(30, 'C')).toBeGreaterThan(expectedPowerDecline(30, 'HS'));
    // 比旧版（27 岁起约 (age-25)^0.7 × 1.1）更强：27 岁 > 1.8，30 岁 > 3.4
    expect(expectedPowerDecline(27, 'C')).toBeGreaterThan(1.8);
    expect(expectedPowerDecline(30, 'C')).toBeGreaterThan(3.4);
  });

  it('ageFactor：不给位置时与旧表一致；过巅峰后成长放缓（辅助更晚）', () => {
    expect(ageFactor(26)).toBe(0.55);
    expect(ageFactor(24, 'C')).toBe(ageFactor(24));
    expect(ageFactor(27, 'C')).toBeLessThan(ageFactor(27, 'HS'));
    expect(ageFactor(27, 'HS')).toBe(ageFactor(27));
    expect(ageFactor(29, 'HS')).toBeCloseTo(ageFactor(29) * CONFIG.aging.postPeakGrowthMult);
  });

  it('agePlayersAtSeasonEnd：27 岁核心衰退、27 岁辅助不衰退；灵性/韧性随年龄继续提升', () => {
    let core = 0;
    let sup = 0;
    for (let t = 0; t < 40; t++) {
      const s = seasonState(0, 100 + t);
      s.players.c = makePlayer({ id: 'c', position: 'C', birthYear: 2022 - 27, power: 85, mmr: 11000, resilience: 50, insight: 50 });
      s.players.h = makePlayer({ id: 'h', position: 'HS', birthYear: 2022 - 27, power: 85, mmr: 11000 });
      agePlayersAtSeasonEnd(s);
      core += 85 - s.players.c.power;
      sup += 85 - s.players.h.power;
      expect(s.players.h.mmr).toBe(11000);
      expect(s.players.c.mmr).toBeLessThan(11000);
      expect(s.players.c.insight).toBeGreaterThan(50);
      expect(s.players.c.resilience).toBeGreaterThan(50);
    }
    expect(core / 40).toBeGreaterThan(1.5);
    expect(sup).toBe(0);
  });

  it('退役：辅助职业生涯更长；仍保持高战力的选手较少退役', () => {
    const count = (pos: Position, power: number) => {
      let n = 0;
      for (let t = 0; t < 30; t++) {
        const s = seasonState(0, 900 + t);
        for (let i = 0; i < 20; i++) {
          s.players[`x${i}`] = makePlayer({ id: `x${i}`, position: pos, birthYear: 2022 - 29, power, mmr: 9000 });
        }
        n += processRetirements(s).retired.length;
      }
      return n;
    };
    expect(count('HS', 70)).toBeLessThan(count('C', 70));
    expect(count('C', 92)).toBeLessThan(count('C', 70));
  });
});

describe('form: 隐藏趋势', () => {
  it('漂移：高天赋年轻人为正、低天赋年轻人略负、巅峰期为 0、巅峰后为负', () => {
    expect(trendDrift(18, 'C', 90)).toBeGreaterThan(0);
    expect(trendDrift(18, 'C', 30)).toBeLessThan(0);
    expect(trendDrift(23, 'C', 90)).toBe(0);
    expect(trendDrift(27, 'C', 60)).toBeLessThan(0);
    expect(trendDrift(27, 'HS', 60)).toBe(0);
    expect(trendDrift(32, 'C', 60)).toBeLessThan(trendDrift(27, 'C', 60));
  });

  it('趋势有持续性：上季负趋势的选手本季仍偏负（衰退期延续）', () => {
    const s = seasonState(0, 3);
    const neg: number[] = [];
    const pos: number[] = [];
    const rng = seededRng(77);
    for (let i = 0; i < 400; i++) {
      const a = makePlayer({ position: 'M', birthYear: 2022 - 24, formTrend: -0.8 });
      const b = makePlayer({ position: 'M', birthYear: 2022 - 24, formTrend: 0.8 });
      neg.push(updateFormTrend(s, a, rng));
      pos.push(updateFormTrend(s, b, rng));
    }
    expect(mean(neg)).toBeLessThan(-0.3);
    expect(mean(pos)).toBeGreaterThan(0.3);
    for (const v of [...neg, ...pos]) {
      expect(v).toBeGreaterThanOrEqual(CONFIG.form.trend.range[0]);
      expect(v).toBeLessThanOrEqual(CONFIG.form.trend.range[1]);
    }
  });

  it('趋势作用：正趋势成长更快、衰退更慢；缺失视为 0', () => {
    const up = makePlayer({ formTrend: 0.8 });
    const down = makePlayer({ formTrend: -0.8 });
    const none = makePlayer();
    expect(formTrendOf(none)).toBe(0);
    expect(trendGrowthMult(none)).toBe(1);
    expect(trendDeclineMult(none)).toBe(1);
    expect(trendGrowthMult(up)).toBeGreaterThan(1);
    expect(trendGrowthMult(down)).toBeLessThan(1);
    expect(trendDeclineMult(down)).toBeGreaterThan(1);
    expect(trendDeclineMult(up)).toBeLessThan(1);
    expect(formTrendOf(makePlayer({ formTrend: Number.NaN }))).toBe(0);
    expect(formTrendOf(makePlayer({ formTrend: 9 }))).toBe(CONFIG.form.trend.range[1]);

    let dDown = 0;
    let dUp = 0;
    for (let t = 0; t < 40; t++) {
      const s = seasonState(0, 300 + t);
      s.players.a = makePlayer({ id: 'a', position: 'C', birthYear: 2022 - 29, power: 85, formTrend: -0.8 });
      agePlayersAtSeasonEnd(s);
      dDown += 85 - s.players.a.power;
      const s2 = seasonState(0, 300 + t);
      s2.players.a = makePlayer({ id: 'a', position: 'C', birthYear: 2022 - 29, power: 85, formTrend: 0.8 });
      agePlayersAtSeasonEnd(s2);
      dUp += 85 - s2.players.a.power;
    }
    expect(dDown).toBeGreaterThan(dUp * 1.3);
  });
});

describe('form: 赛季状态', () => {
  it('rollSeasonForm：每名 active 选手恰好一个「赛季状态」修正器，持续到本赛季结束', () => {
    const s = seasonState(3, 11, 21);
    s.players.fa = makePlayer({ id: 'fa' }); // 自由选手
    s.players.gone = makePlayer({ id: 'gone', status: 'retired' });
    s.players.wild = makePlayer({ id: 'wild', isWildSub: true });
    rollSeasonForm(s);
    const expectRounds = s.season.rounds.length - 1;
    expect(seasonFormRounds(s)).toBe(expectRounds);
    for (const p of Object.values(s.players)) {
      const mods = formMods(p);
      if (p.status !== 'active' || p.isWildSub) {
        expect(mods).toHaveLength(0);
        continue;
      }
      expect(mods).toHaveLength(1);
      const m = mods[0];
      expect(m).toMatchObject({ attr: 'power', kind: 'mul', roundsLeft: expectRounds });
      expect(m.value).toBeGreaterThanOrEqual(CONFIG.form.range[0]);
      expect(m.value).toBeLessThanOrEqual(CONFIG.form.range[1]);
      expect(seasonFormOf(p)).toBe(m.value);
      expect(effectivePower(p)).toBeCloseTo(p.power * m.value, 6);
      expect(typeof p.formTrend).toBe('number');
    }
    // 再掷一次：替换而非叠加
    rollSeasonForm(s);
    for (const p of Object.values(s.players)) if (p.status === 'active' && !p.isWildSub) expect(formMods(p)).toHaveLength(1);
  });

  it('赛季初为玩家战队发一条本队赛季状态简报（AI 战队不发）', () => {
    const s = seasonState(3, 21);
    rollSeasonForm(s);
    const items = s.news.filter((n) => n.title.includes('新赛季状态'));
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain(s.teams.t0.name);
    expect(items[0].category).toBe('season');
    expect(items[0].body).toContain('赛季状态');
    // 本队内部简报：只关联本队，多人模式下只对该座位可见
    expect(items[0].teamIds).toEqual(['t0']);
    expect(items[0].scope).toBe('mine');
    expect(items[0].visibility).toBe('private');
    for (const pid of items[0].playerIds ?? []) expect(s.players[pid].teamId).toBe('t0');
  });

  it('多支玩家战队（多人模式）：每支各一条简报，AI 战队不发', () => {
    const s = seasonState(4, 22);
    s.teams.t2.isPlayer = true;
    rollSeasonForm(s);
    const items = s.news.filter((n) => n.title.includes('新赛季状态'));
    expect(items.map((n) => n.teamIds?.[0]).sort()).toEqual(['t0', 't2']);
  });

  it('状态有延续性：相邻赛季的赛季状态正相关，低迷/火热往往延续到下赛季（隐藏趋势）', () => {
    const s = seasonState(0, 31);
    for (let i = 0; i < 600; i++) {
      s.players[`p${i}`] = makePlayer({ id: `p${i}`, position: 'M', birthYear: 2022 - 24, resilience: 50 });
    }
    const ids = Object.keys(s.players);
    const prev: number[] = [];
    const next: number[] = [];
    for (let k = 0; k < 4; k++) rollSeasonForm(s); // 前几季：趋势从 0 起步，逐渐达到稳态
    for (const id of ids) prev.push(seasonFormOf(s.players[id]));
    rollSeasonForm(s); // 第 3 季
    for (const id of ids) next.push(seasonFormOf(s.players[id]));
    const mp = mean(prev);
    const mn = mean(next);
    let cov = 0;
    for (let i = 0; i < ids.length; i++) cov += (prev[i] - mp) * (next[i] - mn);
    const corr = cov / ids.length / (sd(prev) * sd(next));
    expect(corr).toBeGreaterThan(0.15);
    expect(corr).toBeLessThan(0.7); // 仍有每季独立的随机起伏
    // 本季「挣扎/低迷」的选手，下季均值仍低于 1；「火热/上升」的仍高于 1
    const lowNext = next.filter((_, i) => prev[i] < 0.97);
    const hotNext = next.filter((_, i) => prev[i] > 1.03);
    expect(mean(lowNext)).toBeLessThan(0.995);
    expect(mean(hotNext)).toBeGreaterThan(1.005);
  });

  it('趋势决定状态均值：强负趋势的选手赛季状态明显偏低，强正趋势偏高', () => {
    const s = seasonState(0, 6);
    const rng = seededRng(55);
    const lo: number[] = [];
    const hi: number[] = [];
    for (let i = 0; i < 800; i++) {
      lo.push(applySeasonForm(s, makePlayer({ birthYear: 2022 - 25, formTrend: -0.8 }), rng, 20));
      hi.push(applySeasonForm(s, makePlayer({ birthYear: 2022 - 25, formTrend: 0.8 }), rng, 20));
    }
    expect(mean(lo)).toBeLessThan(0.975);
    expect(mean(hi)).toBeGreaterThan(1.025);
  });

  it('赛季状态在 TI 回合结束（最后一次 tickModifiers）时到期，其他修正器不受影响', () => {
    const s = seasonState(1, 12, 21);
    const p = s.players['t0-C'];
    p.modifiers.push({ id: 'perm', source: '测试', attr: 'power', kind: 'add', value: 1, roundsLeft: null });
    rollSeasonForm(s);
    const ticks = s.season.rounds.length - 1; // 回合 1..TI 各结束一次
    for (let i = 0; i < ticks - 1; i++) tickModifiers(s);
    expect(formMods(p)).toHaveLength(1);
    tickModifiers(s);
    expect(formMods(p)).toHaveLength(0);
    expect(p.modifiers.map((m) => m.id)).toEqual(['perm']);
    clearSeasonForm(p);
    expect(p.modifiers).toHaveLength(1);
  });

  it('赛季状态分布：均值约 1，夹在 [0.93, 1.07]；高韧性波动更小、年轻选手波动更大', () => {
    const s = seasonState(0, 5);
    const rng = seededRng(2024);
    const steady: number[] = [];
    const shaky: number[] = [];
    const young: number[] = [];
    for (let i = 0; i < 1500; i++) {
      steady.push(applySeasonForm(s, makePlayer({ resilience: 95, birthYear: 2022 - 25 }), rng, 20));
      shaky.push(applySeasonForm(s, makePlayer({ resilience: 15, birthYear: 2022 - 25 }), rng, 20));
      young.push(applySeasonForm(s, makePlayer({ resilience: 50, birthYear: 2022 - 18 }), rng, 20));
    }
    const all = [...steady, ...shaky, ...young];
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0.93);
    expect(Math.max(...all)).toBeLessThanOrEqual(1.07);
    expect(Math.abs(mean(all) - 1)).toBeLessThan(0.004);
    expect(sd(steady)).toBeLessThan(sd(shaky) * 0.8);
    const mid = makePlayer({ resilience: 50, birthYear: 2022 - 25 });
    const kid = makePlayer({ resilience: 50, birthYear: 2022 - 18 });
    expect(formSigma(s, kid)).toBeGreaterThan(formSigma(s, mid));
    expect(sd(young)).toBeGreaterThan(sd(steady));
  });

  it('formLabel：按赛季状态倍数分五档，无赛季状态为平稳', () => {
    const p = makePlayer();
    expect(formLabel(p)).toBe('平稳');
    const set = (v: number) => {
      p.modifiers = [{ id: 'f', source: FORM_SOURCE, attr: 'power', kind: 'mul', value: v, roundsLeft: 5 }];
      return formLabel(p);
    };
    expect(set(1.06)).toBe('火热');
    expect(set(1.02)).toBe('上升');
    expect(set(1.0)).toBe('平稳');
    expect(set(0.98)).toBe('低迷');
    expect(set(0.94)).toBe('挣扎');
    // 其他来源的修正器（伤病等）不影响赛季状态标签
    p.modifiers = [{ id: 'i', source: '伤病', attr: 'power', kind: 'mul', value: 0.8, roundsLeft: 2 }];
    expect(formLabel(p)).toBe('平稳');
    expect(formLabel(null)).toBe('平稳');
  });

  it('存档往返保留隐藏趋势与赛季状态；损坏数据（NaN/非数字）按中性处理', async () => {
    const { exportSave, importSave } = await import('../src/engine/save');
    const s = seasonState(2, 41);
    rollSeasonForm(s);
    const loaded = importSave(exportSave(s));
    for (const id of Object.keys(s.players)) {
      expect(loaded.players[id].formTrend).toBe(s.players[id].formTrend);
      expect(seasonFormOf(loaded.players[id])).toBe(seasonFormOf(s.players[id]));
      expect(formMods(loaded.players[id])[0]?.roundsLeft).toBe(formMods(s.players[id])[0]?.roundsLeft);
    }
    const bad = makePlayer({ formTrend: 'x' as unknown as number });
    bad.modifiers = [{ id: 'f', source: FORM_SOURCE, attr: 'power', kind: 'mul', value: Number.NaN, roundsLeft: 3 }];
    expect(formTrendOf(bad)).toBe(0);
    expect(seasonFormOf(bad)).toBe(1);
    expect(formLabel(bad)).toBe('平稳');
    expect(effectivePower(bad)).toBe(bad.power);
    // 再掷一次：损坏的修正器被替换为合法值
    const s2 = seasonState(0, 42);
    s2.players[bad.id] = bad;
    rollSeasonForm(s2);
    expect(formMods(bad)).toHaveLength(1);
    expect(Number.isFinite(formMods(bad)[0].value)).toBe(true);
    expect(Number.isFinite(bad.formTrend)).toBe(true);
  });

  it('可复现：同一种子结果一致', () => {
    const a = seasonState(2, 99);
    const b = seasonState(2, 99);
    rollSeasonForm(a);
    rollSeasonForm(b);
    for (const id of Object.keys(a.players)) {
      expect(seasonFormOf(a.players[id])).toBe(seasonFormOf(b.players[id]));
      expect(a.players[id].formTrend).toBe(b.players[id].formTrend);
    }
    expect(a.rngState).toBe(b.rngState);
  });

  it('CONFIG.form.enabled = false 时不生效', () => {
    const s = seasonState(1, 4);
    const f = CONFIG.form as { enabled: boolean };
    const prev = f.enabled;
    f.enabled = false;
    try {
      rollSeasonForm(s);
      for (const p of Object.values(s.players)) expect(formMods(p)).toHaveLength(0);
    } finally {
      f.enabled = prev;
    }
  });
});

describe('form: 赛季流程集成', () => {
  it('新游戏开季即掷赛季状态；打完一个赛季后旧状态到期、新赛季重新掷出（每人恰好一个）', async () => {
    const { registerNodeRosterLoader } = await import('../scripts/nodeData');
    const { advance, createNewGame, currentPlayerTournament, fillLineupWithTempSubs, quickSimTournament } = await import('../src/engine/game');
    const { resolveDecision } = await import('../src/engine/events');
    registerNodeRosterLoader();
    const g = await createNewGame({
      startTi: 13, seasons: 2, difficulty: 'normal', managerName: 'T', seed: 11,
      newClub: { name: 'Form Test', tag: 'FT', region: 'CN', color: '#335577' },
    });
    const check = () => {
      const rounds = g.season.rounds.length - 1;
      let n = 0;
      for (const p of Object.values(g.players)) {
        if (p.status !== 'active' || p.isWildSub) continue;
        const mods = formMods(p);
        expect(mods.length).toBeLessThanOrEqual(1);
        if (!p.teamId) continue;
        expect(mods).toHaveLength(1);
        expect(mods[0].roundsLeft).toBe(rounds);
        n++;
      }
      expect(n).toBeGreaterThan(100);
    };
    check();
    expect(g.news.some((x) => x.title.includes('新赛季状态'))).toBe(true);
    const ti = g.season.ti;
    for (let step = 0; step < 400 && g.season.ti === ti && !g.gameOver; step++) {
      g.popups.length = 0;
      for (let k = 0; k < 20 && g.pendingDecisions.length; k++) {
        const d = g.pendingDecisions[0];
        resolveDecision(g, d.id, d.choices[0]?.id ?? '');
        if (g.pendingDecisions[0] === d) g.pendingDecisions.shift();
      }
      if (currentPlayerTournament(g) || g.activeMatch) {
        if (!quickSimTournament(g).ok) fillLineupWithTempSubs(g);
      }
      advance(g);
    }
    expect(g.season.ti).toBe(ti + 1);
    check();
  }, 30000);
});
