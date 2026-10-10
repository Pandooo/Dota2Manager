// BP（队长模式简化版）【E2 负责实现】
import type {
  DraftAction, DraftEvaluation, DraftState, DraftStep, GameState, HeroInfo, HeroStyle, Player, Position,
} from './types';
import { POSITIONS } from './types';
import { CONFIG, POSITION_LABEL } from './config';
import { availableHeroes, fillHeroMeta, heroById, heroName } from './heroes';
import { patchByVersion } from './patches';
import { teamInsight } from './team';
import { hashSeed, rngOf, seededRng } from './rng';
import type { Rng } from './rng';
import { clamp, round2 } from './util';

/**
 * BP 顺序（A 为先手方）：禁4 → 选4 → 禁4 → 选4 → 禁2 → 选2
 * 选人阶段 ABBA 交替，禁人阶段 ABAB 交替。共 10 禁 10 选。
 */
export const DRAFT_SEQUENCE: DraftStep[] = [
  // 第一轮禁用 ABAB
  { side: 'A', type: 'ban' }, { side: 'B', type: 'ban' }, { side: 'A', type: 'ban' }, { side: 'B', type: 'ban' },
  // 第一轮选人 ABBA
  { side: 'A', type: 'pick' }, { side: 'B', type: 'pick' }, { side: 'B', type: 'pick' }, { side: 'A', type: 'pick' },
  // 第二轮禁用 ABAB
  { side: 'A', type: 'ban' }, { side: 'B', type: 'ban' }, { side: 'A', type: 'ban' }, { side: 'B', type: 'ban' },
  // 第二轮选人 BAAB
  { side: 'B', type: 'pick' }, { side: 'A', type: 'pick' }, { side: 'A', type: 'pick' }, { side: 'B', type: 'pick' },
  // 第三轮禁用 AB
  { side: 'A', type: 'ban' }, { side: 'B', type: 'ban' },
  // 第三轮选人 BA（先手方拿最后一手）
  { side: 'B', type: 'pick' }, { side: 'A', type: 'pick' },
];

// ---------------------------------------------------------------------------
// 风格搭配 / 克制表（领域数据）
// ---------------------------------------------------------------------------
const STYLES: HeroStyle[] = ['early', 'late', 'teamfight', 'push', 'gank', 'control', 'sustain', 'pickoff', 'splitpush', 'tempo'];

type StyleMatrix = Record<HeroStyle, Record<HeroStyle, number>>;
function emptyMatrix(): StyleMatrix {
  const m = {} as StyleMatrix;
  for (const s of STYLES) {
    m[s] = {} as Record<HeroStyle, number>;
    for (const t of STYLES) m[s][t] = 0;
  }
  return m;
}

/** 阵容搭配（对称）：正 = 互补，负 = 冲突 */
const SYNERGY_PAIRS: [HeroStyle, HeroStyle, number][] = [
  ['teamfight', 'control', 0.5],
  ['teamfight', 'teamfight', 0.2],
  ['teamfight', 'sustain', 0.25],
  ['control', 'pickoff', 0.35],
  ['gank', 'pickoff', 0.35],
  ['gank', 'tempo', 0.35],
  ['tempo', 'early', 0.3],
  ['early', 'push', 0.4],
  ['push', 'push', 0.2],
  ['push', 'tempo', 0.3],
  ['late', 'sustain', 0.4],
  ['late', 'control', 0.25],
  ['splitpush', 'pickoff', 0.25],
  ['splitpush', 'control', 0.2],
  ['late', 'late', -0.4],          // 多核抢资源
  ['splitpush', 'splitpush', -0.2],
  ['early', 'late', -0.15],        // 节奏不统一
  ['push', 'late', -0.1],
];

/** 克制（有向）：s 克制 t 的程度 */
const COUNTER_PAIRS: [HeroStyle, HeroStyle, number][] = [
  ['early', 'late', 0.4],
  ['push', 'late', 0.35],
  ['tempo', 'late', 0.25],
  ['gank', 'late', 0.2],
  ['pickoff', 'splitpush', 0.45],
  ['gank', 'splitpush', 0.3],
  ['teamfight', 'push', 0.3],
  ['teamfight', 'gank', 0.2],
  ['control', 'tempo', 0.25],
  ['control', 'gank', 0.2],
  ['sustain', 'early', 0.3],
  ['sustain', 'push', 0.2],
  ['late', 'teamfight', 0.2],
  ['splitpush', 'teamfight', 0.35],
];

const SYN: StyleMatrix = emptyMatrix();
for (const [s, t, v] of SYNERGY_PAIRS) {
  SYN[s][t] = v;
  SYN[t][s] = v;
}
/** 净克制 NET[s][t] = C[s][t] - C[t][s] */
const NET: StyleMatrix = emptyMatrix();
for (const [s, t, v] of COUNTER_PAIRS) {
  NET[s][t] += v;
  NET[t][s] -= v;
}

/** 风格节奏倾向：正 = 后期，负 = 前期 */
const STYLE_LEAN: Record<HeroStyle, number> = {
  late: 1, splitpush: 0.4, sustain: 0.3, control: 0.1, teamfight: 0,
  pickoff: -0.2, gank: -0.4, tempo: -0.5, push: -0.7, early: -1,
};

/** 单条阵容的风格合计上限（避免极端值） */
const STYLE_SCORE_CAP = 3;
/** 禁用评分：对方可用度、破坏对方搭配的折算比例 */
const BAN_USEFULNESS_FACTOR = 0.5;
const BAN_DENY_SYNERGY_FACTOR = 0.5;
/** 推荐度换算：与最佳候选每差 1 分扣多少推荐度 */
const SUGGESTION_SCORE_STEP = 12;
/** 未知英雄（数据缺失）的位置适配度 */
const UNKNOWN_HERO_FIT = 0.5;
/** 点评阈值 */
const NOTE = {
  leanDiff: 0.3,
  strongMeta: 1,
  hotMeta: 0.4,
  weakMeta: -1,
  goodFit: 0.75,
  poorFit: 0.4,
  counterEdge: 0.6,
  insightEdge: 6,
  favoredWr: 0.05,
  synergyNote: 0.5,
  counterNote: 0.4,
};

type StyleCounts = Record<HeroStyle, number>;
function emptyCounts(): StyleCounts {
  const c = {} as StyleCounts;
  for (const s of STYLES) c[s] = 0;
  return c;
}

function stylesOf(h: HeroInfo | undefined): HeroStyle[] {
  return h?.styles ?? [];
}

function fitOf(h: HeroInfo | undefined, pos: Position): number {
  if (!h) return UNKNOWN_HERO_FIT;
  const v = h.positions?.[pos];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 英雄 h 与一组风格计数的搭配分 */
function synergyWith(h: HeroInfo | undefined, counts: StyleCounts): number {
  let v = 0;
  for (const s of stylesOf(h)) {
    const row = SYN[s];
    if (!row) continue;
    for (const t of STYLES) if (counts[t]) v += row[t] * counts[t];
  }
  return clamp(v, -STYLE_SCORE_CAP, STYLE_SCORE_CAP);
}

/** 英雄 h 对一组风格计数的净克制分 */
function counterVs(h: HeroInfo | undefined, counts: StyleCounts): number {
  let v = 0;
  for (const s of stylesOf(h)) {
    const row = NET[s];
    if (!row) continue;
    for (const t of STYLES) if (counts[t]) v += row[t] * counts[t];
  }
  return clamp(v, -STYLE_SCORE_CAP, STYLE_SCORE_CAP);
}

function pairSynergy(a: HeroInfo | undefined, b: HeroInfo | undefined): number {
  let v = 0;
  for (const s of stylesOf(a)) for (const t of stylesOf(b)) v += SYN[s]?.[t] ?? 0;
  return v;
}

function pairCounter(a: HeroInfo | undefined, b: HeroInfo | undefined): number {
  let v = 0;
  for (const s of stylesOf(a)) for (const t of stylesOf(b)) v += NET[s]?.[t] ?? 0;
  return v;
}

/** 英雄节奏倾向（-1 前期 … +1 后期） */
export function heroLean(heroId: string): number {
  const st = stylesOf(heroById(heroId));
  if (st.length === 0) return 0;
  let v = 0;
  for (const s of st) v += STYLE_LEAN[s] ?? 0;
  return clamp(v / st.length, -1, 1);
}

/** 双方阵容节奏倾向（-1 前期 … +1 后期），供时长/直播使用 */
export function draftLean(actions: DraftAction[]): { leanA: number; leanB: number } {
  let a = 0, na = 0, b = 0, nb = 0;
  for (const act of actions) {
    if (act.type !== 'pick') continue;
    const l = heroLean(act.heroId);
    if (act.side === 'A') { a += l; na++; } else { b += l; nb++; }
  }
  return { leanA: na ? a / na : 0, leanB: nb ? b / nb : 0 };
}

function leanLabel(lean: number): string {
  if (lean >= 0.25) return '后期';
  if (lean <= -0.25) return '前期';
  return '中期';
}

// ---------------------------------------------------------------------------
// BP 上下文
// ---------------------------------------------------------------------------
interface SideCtx {
  side: 'A' | 'B';
  teamId: string;
  tag: string;
  lineup: Record<Position, Player | null>;
  /** 招牌英雄 → 拥有它的首发位置 */
  signature: Map<string, Position[]>;
  picks: DraftAction[];
  pickedHeroes: (HeroInfo | undefined)[];
  openPositions: Position[];
  styleCounts: StyleCounts;
}

function teamTag(state: GameState, teamId: string): string {
  const t = state.teams[teamId];
  return t?.tag || t?.name || teamId;
}

function buildSide(state: GameState, draft: DraftState, side: 'A' | 'B', teamId: string): SideCtx {
  const team = state.teams[teamId];
  const lineup = { C: null, M: null, O: null, SS: null, HS: null } as Record<Position, Player | null>;
  const signature = new Map<string, Position[]>();
  if (team) {
    for (const pos of POSITIONS) {
      const pid = team.lineup?.[pos];
      const p = pid ? state.players[pid] : undefined;
      if (!p || (p.status && p.status !== 'active')) continue;
      lineup[pos] = p;
      for (const h of p.signatureHeroes ?? []) {
        const arr = signature.get(h);
        if (arr) arr.push(pos);
        else signature.set(h, [pos]);
      }
    }
  }
  const picks = draft.actions.filter((a) => a.side === side && a.type === 'pick');
  const taken = new Set(picks.map((a) => a.position).filter((p): p is Position => !!p));
  const pickedHeroes = picks.map((a) => heroById(a.heroId));
  const styleCounts = emptyCounts();
  for (const h of pickedHeroes) for (const s of stylesOf(h)) styleCounts[s] = (styleCounts[s] ?? 0) + 1;
  return {
    side,
    teamId,
    tag: teamTag(state, teamId),
    lineup,
    signature,
    picks,
    pickedHeroes,
    openPositions: POSITIONS.filter((p) => !taken.has(p)),
    styleCounts,
  };
}

function buildCtx(state: GameState, draft: DraftState, teamA: string, teamB: string): { A: SideCtx; B: SideCtx } {
  return { A: buildSide(state, draft, 'A', teamA), B: buildSide(state, draft, 'B', teamB) };
}

function safeInsight(state: GameState, teamId: string): number {
  if (!state.teams[teamId]) return 50;
  const v = teamInsight(state, teamId);
  return Number.isFinite(v) ? v : 50;
}

function noiseSigma(insight: number): number {
  return CONFIG.match.draftNoiseByInsight * clamp(1 - insight / 100, 0, 1);
}

// ---------------------------------------------------------------------------
// 候选评分
// ---------------------------------------------------------------------------
interface PickEval {
  score: number;
  pos: Position;
  fit: number;
  meta: number;
  comfortPlayer: Player | null;
  syn: number;
  ctr: number;
}

/** pick 评分：meta + 最适配空位（位置适配 + 招牌）+ 搭配 + 克制 */
function evalPick(state: GameState, heroId: string, own: SideCtx, enemy: SideCtx): PickEval {
  const M = CONFIG.match;
  const h = heroById(heroId);
  const meta = state.heroMeta?.[heroId] ?? 0;
  const positions = own.openPositions.length ? own.openPositions : POSITIONS;
  const sigPos = own.signature.get(heroId);
  let bestV = -Infinity;
  let bestPos: Position = positions[0];
  let bestFit = 0;
  let comfortPlayer: Player | null = null;
  for (const pos of positions) {
    const fit = fitOf(h, pos);
    const comfort = sigPos?.includes(pos) ? M.comfortBonus : 0;
    const v = M.positionFitWeight * fit + comfort;
    if (v > bestV) {
      bestV = v;
      bestPos = pos;
      bestFit = fit;
      comfortPlayer = comfort > 0 ? own.lineup[pos] : null;
    }
  }
  const syn = synergyWith(h, own.styleCounts);
  const ctr = counterVs(h, enemy.styleCounts);
  const score = M.metaWeight * meta + bestV + M.synergyWeight * syn + M.counterWeight * ctr;
  return { score, pos: bestPos, fit: bestFit, meta, comfortPlayer, syn, ctr };
}

interface BanEval {
  score: number;
  meta: number;
  /** 被针对的对方选手（招牌英雄） */
  target: Player | null;
  threat: number;
}

/** ban 评分：meta + 针对对方招牌 + 对方可用度 + 克制我方阵容 - 自家招牌 */
function evalBan(state: GameState, heroId: string, own: SideCtx, enemy: SideCtx): BanEval {
  const M = CONFIG.match;
  const h = heroById(heroId);
  const meta = state.heroMeta?.[heroId] ?? 0;
  const enemyPositions = enemy.openPositions.length ? enemy.openPositions : POSITIONS;
  let enemyFit = 0;
  for (const pos of enemyPositions) enemyFit = Math.max(enemyFit, fitOf(h, pos));
  let target: Player | null = null;
  const sig = enemy.signature.get(heroId);
  if (sig) {
    for (const pos of sig) {
      if (enemyPositions.includes(pos) && enemy.lineup[pos]) {
        target = enemy.lineup[pos];
        break;
      }
    }
  }
  const ownSig = own.signature.get(heroId)?.some((pos) => own.openPositions.includes(pos)) ?? false;
  const threat = counterVs(h, own.styleCounts);
  const denySyn = synergyWith(h, enemy.styleCounts);
  // 对方可用度：英雄若没人能打则禁它意义不大
  const usefulness = M.positionFitWeight * (enemyFit - UNKNOWN_HERO_FIT) * BAN_USEFULNESS_FACTOR;
  const score = M.metaWeight * meta
    + (target ? M.banComfortWeight : 0)
    + usefulness
    + M.banThreatWeight * threat
    + M.synergyWeight * BAN_DENY_SYNERGY_FACTOR * denySyn
    - (ownSig ? M.banOwnComfortPenalty : 0);
  return { score, meta, target, threat };
}

function scoreCandidate(state: GameState, step: DraftStep, heroId: string, own: SideCtx, enemy: SideCtx): number {
  return step.type === 'pick' ? evalPick(state, heroId, own, enemy).score : evalBan(state, heroId, own, enemy).score;
}

/** 带噪声地选出最佳候选 */
function chooseHero(state: GameState, draft: DraftState, step: DraftStep, own: SideCtx, enemy: SideCtx, sigma: number, rng: Rng): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const id of draft.available) {
    let s = scoreCandidate(state, step, id, own, enemy);
    if (sigma > 0) s += rng.normal(0, sigma);
    if (s > bestScore) {
      bestScore = s;
      best = id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 公共接口
// ---------------------------------------------------------------------------

/**
 * BP 英雄池日期：版本在其所在回合开始时就已生效（回合开始日可能早于版本发布日），
 * 随版本一同上线的英雄也应从该回合起可选 → 取 max(当前日期, 当前版本发布日)。
 */
export function draftHeroDate(state: GameState): string {
  const date = state.currentDate || '';
  const patch = state.currentPatch ? patchByVersion(state.currentPatch) : undefined;
  return patch?.date && date && patch.date > date ? patch.date : date;
}

/**
 * 创建 BP（可用英雄 = draftHeroDate 时已上线英雄）。
 * 同时为当前版本强度表补齐版本生效后才上线的英雄（确定性，不消耗存档随机数）。
 */
export function createDraft(state: GameState): DraftState {
  const date = draftHeroDate(state);
  if (state.heroMeta && state.currentPatch) {
    fillHeroMeta(state.heroMeta, patchByVersion(state.currentPatch), date);
  }
  return {
    sequence: DRAFT_SEQUENCE.map((s) => ({ ...s })),
    actions: [],
    available: availableHeroes(date).map((h) => h.id),
    done: false,
  };
}

export function currentStep(draft: DraftState): DraftStep | null {
  if (!draft || draft.done) return null;
  return draft.sequence[draft.actions.length] ?? null;
}

export interface DraftSuggestion {
  heroId: string;
  position?: Position;      // pick 时建议的位置
  playerId?: string;
  score: number;            // 0..100 推荐度（UI 显示）
  reason: string;           // 中文，如 "版本强势 · Miracle- 招牌英雄"
}

/** 找出与 h 搭配最好的己方英雄 / 被 h 克制最狠的敌方英雄 */
function bestPartner(h: HeroInfo | undefined, picks: DraftAction[], fn: (a: HeroInfo | undefined, b: HeroInfo | undefined) => number): { heroId: string; v: number } | null {
  let best: { heroId: string; v: number } | null = null;
  for (const p of picks) {
    const v = fn(h, heroById(p.heroId));
    if (!best || v > best.v) best = { heroId: p.heroId, v };
  }
  return best;
}

function pickReason(state: GameState, heroId: string, ev: PickEval, own: SideCtx, enemy: SideCtx): string {
  const parts: string[] = [];
  const h = heroById(heroId);
  if (ev.comfortPlayer) parts.push(`${ev.comfortPlayer.handle} 招牌英雄`);
  if (ev.meta >= NOTE.strongMeta) parts.push('版本强势');
  else if (ev.meta >= NOTE.hotMeta) parts.push('版本热门');
  else if (ev.meta <= NOTE.weakMeta) parts.push('版本偏弱，慎选');
  const slot = POSITION_LABEL[ev.pos] ?? ev.pos;
  if (ev.fit >= NOTE.goodFit) parts.push(`适合${slot}`);
  else parts.push(`补位${slot}`);
  if (ev.syn >= NOTE.synergyNote) {
    const partner = bestPartner(h, own.picks, pairSynergy);
    if (partner && partner.v > 0) parts.push(`与${heroName(partner.heroId)}配合出色`);
  }
  if (ev.ctr >= NOTE.counterNote) {
    const victim = bestPartner(h, enemy.picks, pairCounter);
    if (victim && victim.v > 0) parts.push(`克制对面${heroName(victim.heroId)}`);
  }
  return parts.join(' · ');
}

function banReason(heroId: string, ev: BanEval, own: SideCtx): string {
  const parts: string[] = [];
  const h = heroById(heroId);
  if (ev.target) parts.push(`针对 ${ev.target.handle} 的招牌英雄`);
  if (ev.meta >= NOTE.strongMeta) parts.push('版本强势');
  else if (ev.meta >= NOTE.hotMeta) parts.push('版本热门');
  if (ev.threat >= NOTE.counterNote) {
    const victim = bestPartner(h, own.picks, (a, b) => pairCounter(a, b));
    parts.push(victim && victim.v > 0 ? `克制我方${heroName(victim.heroId)}` : '克制我方阵容');
  }
  if (parts.length === 0) parts.push('常规禁用，压缩对手选择');
  return parts.join(' · ');
}

/**
 * 推荐英雄（按当前步骤是 ban 还是 pick）。评分 = meta + 位置适配 + 招牌英雄 + 阵容搭配 + 克制；
 * 推荐质量受战队灵性影响（低灵性 → 推荐中混入噪声）。
 */
export function draftSuggestions(
  state: GameState,
  draft: DraftState,
  teamA: string,
  teamB: string,
  count = 5,
): DraftSuggestion[] {
  const step = currentStep(draft);
  if (!step || draft.available.length === 0 || count <= 0) return [];
  const ctx = buildCtx(state, draft, teamA, teamB);
  const own = step.side === 'A' ? ctx.A : ctx.B;
  const enemy = step.side === 'A' ? ctx.B : ctx.A;
  const sigma = noiseSigma(safeInsight(state, own.teamId));
  // UI 反复调用时结果需稳定 → 使用与存档无关的确定性随机（按 BP 进度取种子）
  const rng = seededRng(hashSeed(`${state.id}|${teamA}|${teamB}|${draft.actions.map((a) => a.heroId).join(',')}`));
  const scored = draft.available.map((id) => {
    if (step.type === 'pick') {
      const ev = evalPick(state, id, own, enemy);
      return { id, noisy: ev.score + (sigma > 0 ? rng.normal(0, sigma) : 0), pick: ev, ban: null as BanEval | null };
    }
    const ev = evalBan(state, id, own, enemy);
    return { id, noisy: ev.score + (sigma > 0 ? rng.normal(0, sigma) : 0), pick: null as PickEval | null, ban: ev };
  });
  scored.sort((x, y) => y.noisy - x.noisy);
  const top = scored.slice(0, count);
  const best = top[0]?.noisy ?? 0;
  return top.map((c) => {
    const score = Math.round(clamp(100 - (best - c.noisy) * SUGGESTION_SCORE_STEP, 1, 100));
    if (c.pick) {
      const player = own.lineup[c.pick.pos];
      return {
        heroId: c.id,
        position: c.pick.pos,
        playerId: player?.id,
        score,
        reason: pickReason(state, c.id, c.pick, own, enemy),
      };
    }
    return { heroId: c.id, score, reason: banReason(c.id, c.ban as BanEval, own) };
  });
}

/**
 * 执行当前步骤（校验英雄可用）。pick 时自动分配到该方尚未选英雄的位置中最适配者，并绑定该位置首发 playerId。
 * 返回执行的动作；非法时抛错。
 */
export function applyDraftAction(state: GameState, draft: DraftState, heroId: string, teamA: string, teamB: string): DraftAction {
  const step = currentStep(draft);
  if (!step) throw new Error('BP 已结束');
  const idx = draft.available.indexOf(heroId);
  if (idx < 0) throw new Error(`英雄不可选：${heroName(heroId)}`);
  const action: DraftAction = { side: step.side, type: step.type, heroId };
  if (step.type === 'pick') {
    const own = buildSide(state, draft, step.side, step.side === 'A' ? teamA : teamB);
    const h = heroById(heroId);
    const positions = own.openPositions.length ? own.openPositions : POSITIONS;
    let bestPos: Position = positions[0];
    let bestV = -Infinity;
    for (const pos of positions) {
      const v = CONFIG.match.positionFitWeight * fitOf(h, pos)
        + (own.signature.get(heroId)?.includes(pos) ? CONFIG.match.comfortBonus : 0);
      if (v > bestV) {
        bestV = v;
        bestPos = pos;
      }
    }
    action.position = bestPos;
    const p = own.lineup[bestPos];
    if (p) action.playerId = p.id;
  }
  draft.available.splice(idx, 1);
  draft.actions.push(action);
  if (draft.actions.length >= draft.sequence.length) draft.done = true;
  return action;
}

/** AI 执行当前步骤（选择受该方战队灵性影响的噪声），返回动作 */
export function aiDraftStep(state: GameState, draft: DraftState, teamA: string, teamB: string): DraftAction {
  const step = currentStep(draft);
  if (!step) throw new Error('BP 已结束');
  if (draft.available.length === 0) throw new Error('没有可选英雄');
  const ctx = buildCtx(state, draft, teamA, teamB);
  const own = step.side === 'A' ? ctx.A : ctx.B;
  const enemy = step.side === 'A' ? ctx.B : ctx.A;
  const sigma = noiseSigma(safeInsight(state, own.teamId));
  const heroId = chooseHero(state, draft, step, own, enemy, sigma, rngOf(state)) ?? draft.available[0];
  return applyDraftAction(state, draft, heroId, teamA, teamB);
}

/** AI 连续执行，直到轮到 manualSide（null = 全自动直到结束） */
export function runDraftUntil(
  state: GameState,
  draft: DraftState,
  teamA: string,
  teamB: string,
  manualSide: 'A' | 'B' | null,
): void {
  let guard = draft.sequence.length + 1;
  while (!draft.done && guard-- > 0) {
    const step = currentStep(draft);
    if (!step) {
      draft.done = true;
      break;
    }
    if (manualSide && step.side === manualSide) break;
    if (draft.available.length === 0) {
      // 英雄池耗尽（数据异常）：提前结束 BP，评估按已有阵容进行
      draft.done = true;
      break;
    }
    aiDraftStep(state, draft, teamA, teamB);
  }
}

// ---------------------------------------------------------------------------
// 阵容评估
// ---------------------------------------------------------------------------
interface SideScore {
  meta: number;
  fit: number;
  comfort: number;
  synergy: number;
  score: number;
  lean: number;
  bestMeta: { heroId: string; meta: number } | null;
  comfortPicks: { heroId: string; player: Player }[];
  poorFits: { heroId: string; pos: Position; fit: number }[];
  styleCounts: StyleCounts;
}

function scoreSide(state: GameState, ctx: SideCtx): Omit<SideScore, 'score'> {
  const M = CONFIG.match;
  let meta = 0, fit = 0, comfort = 0, synergy = 0, lean = 0;
  let bestMeta: SideScore['bestMeta'] = null;
  const comfortPicks: SideScore['comfortPicks'] = [];
  const poorFits: SideScore['poorFits'] = [];
  ctx.picks.forEach((a, i) => {
    const h = ctx.pickedHeroes[i];
    const m = state.heroMeta?.[a.heroId] ?? 0;
    meta += m;
    if (!bestMeta || m > bestMeta.meta) bestMeta = { heroId: a.heroId, meta: m };
    const pos = a.position ?? POSITIONS[i % POSITIONS.length];
    const f = fitOf(h, pos);
    fit += M.positionFitWeight * f;
    if (f < NOTE.poorFit) poorFits.push({ heroId: a.heroId, pos, fit: f });
    const player = (a.playerId ? state.players[a.playerId] : null) ?? ctx.lineup[pos];
    if (player && (player.signatureHeroes ?? []).includes(a.heroId)) {
      comfort += M.comfortBonus;
      comfortPicks.push({ heroId: a.heroId, player });
    }
    for (let j = 0; j < i; j++) synergy += pairSynergy(h, ctx.pickedHeroes[j]);
    lean += heroLean(a.heroId);
  });
  return {
    meta, fit, comfort, synergy,
    lean: ctx.picks.length ? lean / ctx.picks.length : 0,
    bestMeta, comfortPicks, poorFits, styleCounts: ctx.styleCounts,
  };
}

/**
 * 评估阵容 → 大老师胜率：dotaPlusWR = clamp(0.5 + (scoreA-scoreB)×kDraft + (insightA-insightB)×kInsight, min, max)
 * notes 给出 2~4 条中文点评（如"夜魇阵容后期更强""天辉拿下版本强势英雄"）。
 */
export function evaluateDraft(state: GameState, draft: DraftState, teamA: string, teamB: string): DraftEvaluation {
  const M = CONFIG.match;
  const ctx = buildCtx(state, draft, teamA, teamB);
  const a = scoreSide(state, ctx.A);
  const b = scoreSide(state, ctx.B);
  // 跨阵容净克制（A 视角）
  let net = 0;
  for (const ha of ctx.A.pickedHeroes) for (const hb of ctx.B.pickedHeroes) net += pairCounter(ha, hb);
  const scoreA = M.metaWeight * a.meta + a.fit + a.comfort + M.synergyWeight * a.synergy + M.counterWeight * net;
  const scoreB = M.metaWeight * b.meta + b.fit + b.comfort + M.synergyWeight * b.synergy - M.counterWeight * net;
  const insA = safeInsight(state, teamA);
  const insB = safeInsight(state, teamB);
  const wr = clamp(0.5 + (scoreA - scoreB) * M.kDraft + (insA - insB) * M.kInsight, M.dotaPlusMin, M.dotaPlusMax);

  const notes = buildNotes(state, ctx, a, b, net, insA, insB, wr);
  return { scoreA: round2(scoreA), scoreB: round2(scoreB), dotaPlusWinRateA: Math.round(wr * 1000) / 1000, notes };
}

function buildNotes(
  state: GameState,
  ctx: { A: SideCtx; B: SideCtx },
  a: Omit<SideScore, 'score'>,
  b: Omit<SideScore, 'score'>,
  net: number,
  insA: number,
  insB: number,
  wr: number,
): string[] {
  const tagA = ctx.A.tag;
  const tagB = ctx.B.tag;
  const hasPicks = ctx.A.picks.length + ctx.B.picks.length > 0;
  const head = Math.abs(wr - 0.5) >= NOTE.favoredWr
    ? `${wr > 0.5 ? tagA : tagB} BP 占优，大老师胜率 ${Math.round(Math.max(wr, 1 - wr) * 100)}%`
    : `双方 BP 势均力敌，大老师胜率 ${Math.round(wr * 100)}% : ${100 - Math.round(wr * 100)}%`;
  if (!hasPicks) return [head, '双方尚未选人，阵容仍有悬念'];

  const cand: { p: number; text: string }[] = [];
  // 节奏
  const leanDiff = a.lean - b.lean;
  if (Math.abs(leanDiff) >= NOTE.leanDiff) {
    const late = leanDiff > 0 ? tagA : tagB;
    const early = leanDiff > 0 ? tagB : tagA;
    cand.push({ p: Math.abs(leanDiff) * 2, text: `${late} 阵容后期更强，${early} 需要在前中期打开局面` });
  }
  // 版本强势英雄
  for (const [tag, s] of [[tagA, a], [tagB, b]] as const) {
    if (s.bestMeta && s.bestMeta.meta >= NOTE.strongMeta) {
      cand.push({ p: s.bestMeta.meta, text: `${tag} 拿下版本强势英雄${heroName(s.bestMeta.heroId)}` });
    }
  }
  // 招牌英雄
  for (const s of [a, b]) {
    const c = s.comfortPicks[0];
    if (c) cand.push({ p: 1.2 + 0.1 * (s.comfortPicks.length - 1), text: `${c.player.handle} 拿到招牌英雄${heroName(c.heroId)}${s.comfortPicks.length > 1 ? `，另有 ${s.comfortPicks.length - 1} 名队员也拿到拿手英雄` : ''}` });
  }
  // 体系
  for (const [tag, s] of [[tagA, a], [tagB, b]] as const) {
    const sc = s.styleCounts;
    if (sc.teamfight + sc.control >= 7) cand.push({ p: 1.05, text: `${tag} 团战控制链完整，正面接团很难打` });
    else if (sc.push + sc.early >= 4) cand.push({ p: 1.0, text: `${tag} 推进体系成型，想要速战速决` });
    else if (sc.gank + sc.pickoff >= 5) cand.push({ p: 0.95, text: `${tag} 抓单能力出众，地图上要小心走位` });
    if (sc.late >= 3) cand.push({ p: 0.9, text: `${tag} 多核后期阵容，资源分配是隐患` });
    else if (sc.splitpush >= 2) cand.push({ p: 0.8, text: `${tag} 有带线牵制能力，可以拉扯四一分推` });
  }
  // 克制
  const counterEdge = net * CONFIG.match.counterWeight;
  if (Math.abs(counterEdge) >= NOTE.counterEdge) {
    cand.push({ p: Math.abs(counterEdge), text: `${counterEdge > 0 ? tagA : tagB} 阵容针对性更强，克制关系占上风` });
  }
  // 位置错配
  for (const [tag, s] of [[tagA, a], [tagB, b]] as const) {
    const pf = s.poorFits.sort((x, y) => x.fit - y.fit)[0];
    if (pf) cand.push({ p: 0.9 + (NOTE.poorFit - pf.fit), text: `${tag} 的${heroName(pf.heroId)}打${POSITION_LABEL[pf.pos]}有些勉强` });
  }
  // 灵性
  if (Math.abs(insA - insB) >= NOTE.insightEdge) {
    cand.push({ p: Math.abs(insA - insB) / 10, text: `${insA > insB ? tagA : tagB} 的 BP 思路更清晰，灵性领先` });
  }
  cand.sort((x, y) => y.p - x.p);
  const notes = [head, ...cand.slice(0, 3).map((c) => c.text)];
  if (notes.length < 2) notes.push(`${tagA} 阵容偏${leanLabel(a.lean)}，${tagB} 阵容偏${leanLabel(b.lean)}`);
  return notes;
}
