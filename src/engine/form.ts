// 赛季状态与年龄曲线：位置巅峰窗口、隐藏趋势（Player.formTrend）、赛季状态修正（Modifier「赛季状态」）【E3】
//
// 每个赛季开始时（season.startSeason → rollSeasonForm）：
//   1. 隐藏趋势 formTrend ← persistence × 上季趋势 + 年龄漂移 + N(0, σ)：衰退期的负趋势会延续 2~3 个赛季，
//      高天赋年轻选手有正漂移（偶尔出现「爆发赛季」）；趋势同时放大/缩小本赛季的训练成长与赛季末的年龄衰减（growth.ts）。
//   2. 赛季状态：战斗力 × N(1 + 趋势 × trendWeight, σ) 夹在 [0.93, 1.07]，σ 随韧性降低、对年轻选手放大；
//      以 Modifier（source「赛季状态」，roundsLeft = 本赛季大回合数）存储，TI 回合结束时自然到期。
// 赛季状态只影响有效战斗力（effectivePower），不改变基础属性。
// 荣誉势头（第十四波，momentum.ts）：战队的荣誉同比平移全队赛季状态的均值（teamYoyShift），环比乘子在 team.teamRating 读取。
import { CONFIG } from './config';
import { teamMomentumView, teamYoyShift } from './momentum';
import { addNews } from './news';
import { addModifier, ageOf, effectiveAttr } from './player';
import type { Rng } from './rng';
import { rngOf } from './rng';
import type { GameState, Modifier, Player, Position } from './types';
import { clamp, lerp } from './util';

/** 赛季状态修正器的来源名（UI 按此识别） */
export const FORM_SOURCE = '赛季状态';

export type FormLabel = '火热' | '上升' | '平稳' | '低迷' | '挣扎';
/** 从好到差 */
export const FORM_LABELS: FormLabel[] = ['火热', '上升', '平稳', '低迷', '挣扎'];

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// 位置巅峰窗口
// ---------------------------------------------------------------------------

/** 位置巅峰年龄窗口 [起, 止]（含），缺失时按 C 位处理 */
export function peakWindow(pos: Position | undefined): [number, number] {
  const table = CONFIG.aging.peakWindow;
  const w = (pos && table[pos]) || table.C;
  const lo = Number.isFinite(w?.[0]) ? w[0] : 21;
  const hi = Number.isFinite(w?.[1]) ? Math.max(lo, w[1]) : lo + 4;
  return [lo, hi];
}

/** 已过巅峰窗口的年数（仍在窗口内或更年轻时为 0） */
export function yearsPastPeak(age: number, pos: Position | undefined): number {
  if (!Number.isFinite(age)) return 0;
  return Math.max(0, age - peakWindow(pos)[1]);
}

/** 位置年龄成长倍数：已过巅峰窗口 → CONFIG.aging.postPeakGrowthMult（巅峰后训练/比赛也难再进步），否则 1 */
export function positionAgeGrowthMult(age: number, pos: Position | undefined): number {
  return yearsPastPeak(age, pos) > 0 ? CONFIG.aging.postPeakGrowthMult : 1;
}

// ---------------------------------------------------------------------------
// 隐藏趋势
// ---------------------------------------------------------------------------

/** 选手当前隐藏趋势（缺失/异常 → 0） */
export function formTrendOf(p: Player | null | undefined): number {
  const t = p?.formTrend;
  if (typeof t !== 'number' || !Number.isFinite(t)) return 0;
  const [lo, hi] = CONFIG.form.trend.range;
  return clamp(t, lo, hi);
}

/** 本赛季成长倍数（训练/赛事的战力与天梯成长）：max(0, 1 + 趋势 × growthWeight) */
export function trendGrowthMult(p: Player | null | undefined): number {
  return Math.max(0, 1 + formTrendOf(p) * CONFIG.form.trend.growthWeight);
}

/** 赛季末年龄衰减倍数：max(0, 1 - 趋势 × declineWeight)（负趋势 → 衰退更快） */
export function trendDeclineMult(p: Player | null | undefined): number {
  return Math.max(0, 1 - formTrendOf(p) * CONFIG.form.trend.declineWeight);
}

/** 趋势的年龄漂移：巅峰前按天赋向上（高天赋年轻人更易爆发），巅峰后逐年向下（衰退期延续） */
export function trendDrift(age: number, pos: Position | undefined, talent: number): number {
  const T = CONFIG.form.trend;
  const [start, end] = peakWindow(pos);
  if (!Number.isFinite(age)) return 0;
  if (age < start) {
    const t = Number.isFinite(talent) ? talent : T.talentPivot;
    const span = T.talentSpan > 0 ? T.talentSpan : 30;
    return T.youthDrift * clamp((t - T.talentPivot) / span, T.youthTalentFactorRange[0], T.youthTalentFactorRange[1]);
  }
  if (age > end) return T.postPeakDrift * Math.min(age - end, T.postPeakDriftCapYears);
  return 0;
}

/** 更新一名选手的隐藏趋势（每赛季一次），返回新值 */
export function updateFormTrend(state: GameState, p: Player, rng: Rng): number {
  const T = CONFIG.form.trend;
  const age = ageOf(state, p);
  const [start] = peakWindow(p.position);
  const sigma = Math.max(0, T.sigma * (age < start ? T.youthSigmaMult : 1));
  const next = T.persistence * formTrendOf(p) + trendDrift(age, p.position, effectiveAttr(p, 'talent')) + rng.normal(0, sigma);
  const [lo, hi] = T.range;
  p.formTrend = round3(clamp(Number.isFinite(next) ? next : 0, lo, hi));
  return p.formTrend;
}

// ---------------------------------------------------------------------------
// 赛季状态
// ---------------------------------------------------------------------------

function youthSigmaMult(age: number): number {
  for (const [maxAge, mult] of CONFIG.form.sigmaYouth) if (age <= maxAge) return mult;
  return 1;
}

/** 赛季状态的随机幅度 σ：基础 σ × 韧性系数（韧性高 → 波动小）× 年轻系数（越年轻波动越大） */
export function formSigma(state: GameState, p: Player): number {
  const F = CONFIG.form;
  const r = clamp(effectiveAttr(p, 'resilience') / 100, 0, 1);
  const resMult = lerp(F.sigmaResilience[0], F.sigmaResilience[1], r);
  return Math.max(0, F.sigma * resMult * youthSigmaMult(ageOf(state, p)));
}

/** 赛季状态修正器的持续回合：本赛季剩余的大回合结束次数（回合 1..TI，共 rounds.length - 1 次 tickModifiers） */
export function seasonFormRounds(state: GameState): number {
  const n = state.season?.rounds?.length ?? 0;
  const left = n - 1 - Math.max(0, state.roundIndex ?? 0);
  return Math.max(1, left);
}

/** 选手身上的赛季状态修正器（无则 null） */
export function seasonFormModifier(p: Player | null | undefined): Modifier | null {
  const mods = p?.modifiers;
  if (!mods?.length) return null;
  for (const m of mods) if (m.source === FORM_SOURCE && m.attr === 'power' && m.kind === 'mul') return m;
  return null;
}

/** 赛季状态倍数（无修正器 → 1） */
export function seasonFormOf(p: Player | null | undefined): number {
  const v = seasonFormModifier(p)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : 1;
}

/** 移除选手身上的赛季状态修正器 */
export function clearSeasonForm(p: Player): void {
  if (!Array.isArray(p.modifiers) || !p.modifiers.length) return;
  if (!p.modifiers.some((m) => m.source === FORM_SOURCE)) return;
  p.modifiers = p.modifiers.filter((m) => m.source !== FORM_SOURCE);
}

/**
 * 为一名选手掷本赛季状态（替换旧的赛季状态修正器），返回倍数。
 * 均值 = 1 + 趋势 × trendWeight + 所属战队的荣誉同比平移（momentum.teamYoyShift；自由选手 / 无记录 = 0），随机数用量不变。
 */
export function applySeasonForm(state: GameState, p: Player, rng: Rng, rounds = seasonFormRounds(state)): number {
  const F = CONFIG.form;
  clearSeasonForm(p);
  const mean = 1 + formTrendOf(p) * F.trendWeight + teamYoyShift(p.teamId ? state.teams[p.teamId] : null);
  const raw = rng.normal(mean, formSigma(state, p));
  const value = round3(clamp(Number.isFinite(raw) ? raw : 1, F.range[0], F.range[1]));
  addModifier(state, p, { source: FORM_SOURCE, attr: 'power', kind: 'mul', value, roundsLeft: Math.max(1, Math.round(rounds)) });
  return value;
}

/**
 * 赛季初：所有 active 选手（含自由选手，不含野外替补候选）更新隐藏趋势并掷赛季状态。
 * 非 active 选手只清除残留的赛季状态修正器。
 */
export function rollSeasonForm(state: GameState): void {
  if (!CONFIG.form.enabled) return;
  const rng = rngOf(state);
  const rounds = seasonFormRounds(state);
  for (const id in state.players) {
    const p = state.players[id];
    if (!p) continue;
    if (p.status !== 'active' || p.isWildSub) {
      clearSeasonForm(p);
      continue;
    }
    updateFormTrend(state, p, rng);
    applySeasonForm(state, p, rng, rounds);
  }
  if (CONFIG.form.newsForHumanTeams) seasonFormNews(state);
}

const pctText = (v: number) => {
  const d = (v - 1) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
};

/** 赛季初：为每支玩家战队（team.isPlayer）发一条本队赛季状态简报，只列状态明显起伏的正式队员 */
function seasonFormNews(state: GameState): void {
  for (const id in state.teams) {
    const team = state.teams[id];
    if (!team?.isPlayer || team.disbanded) continue;
    const roster = (team.playerIds ?? [])
      .map((pid) => state.players[pid])
      .filter((p): p is Player => !!p && p.status === 'active' && !p.tempSubUntilTournament && !p.isWildSub)
      .sort((a, b) => seasonFormOf(b) - seasonFormOf(a));
    if (!roster.length) continue;
    const good: string[] = [];
    const bad: string[] = [];
    const mentioned: string[] = [];
    for (const p of roster) {
      const label = formLabel(p);
      const text = `${p.handle}（${label} ${pctText(seasonFormOf(p))}）`;
      if (label === '火热' || label === '上升') good.push(text);
      else if (label === '低迷' || label === '挣扎') bad.unshift(text);
      else continue;
      mentioned.push(p.id);
    }
    const mv = teamMomentumView(state, team.id);
    const momentumText = mv.prevSeasonStart !== null
      ? `荣誉势头：上季初 ${Math.round(mv.prevSeasonStart)} → 本季初 ${Math.round(mv.seasonStart ?? team.honor)}，全队状态均值 ${pctText(1 + mv.yoy)}；`
        + '赛季中荣誉的升降还会小幅影响战队评分。'
      : '荣誉势头：首个赛季暂无同比，赛季中荣誉的升降会小幅影响战队评分。';
    const body = (good.length ? `状态向好：${good.join('、')}。` : '')
      + (bad.length ? `状态不佳：${bad.join('、')}。` : '')
      + (!good.length && !bad.length ? '全队状态平稳。' : '')
      + momentumText
      + '赛季状态作用于本赛季的有效战斗力，TI 结束后重新评估。';
    // 本队内部简报：显式关联战队/选手；多人模式下只对该座位可见（避免 N 个座位互相刷屏）
    addNews(state, 'season', `${team.name} 新赛季状态`, body, false, {
      teamIds: [team.id],
      playerIds: mentioned,
      scope: 'mine',
      visibility: 'private',
    });
  }
}

/** 赛季状态标签（按赛季状态倍数；无赛季状态 → 平稳） */
export function formLabel(p: Player | null | undefined): FormLabel {
  const v = seasonFormOf(p);
  const L = CONFIG.form.labels;
  if (v >= L.hot) return '火热';
  if (v >= L.up) return '上升';
  if (v > L.down) return '平稳';
  if (v > L.slump) return '低迷';
  return '挣扎';
}
