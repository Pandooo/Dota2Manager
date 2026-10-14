// 荣誉势头（第十四波）：荣誉的同比 / 环比变化影响战队赛季状态（Team.momentum，人机共用；参数 CONFIG.form.honorMomentum）
//
// - 赛季初（season.startSeason → rollTeamMomentum，在 form.rollSeasonForm 之前）：记录本季初荣誉，按与上季初荣誉的同比
//   计算全队赛季状态均值的平移（form.applySeasonForm 读取 teamYoyShift）；第一个赛季没有同比基准，平移为 0。
// - 每回合结束（season.endRound → updateTeamMomentumRound）：本回合荣誉变化 / 荣誉规模 做指数平滑（ewma），
//   回合乘子 = 1 + clamp(roundWeight × ewma, ±roundCap)，由 team.teamRating 乘在五名首发评分之和上；
//   荣誉不变时 ewma 按 (1 − alpha) 逐回合衰减，乘子回到 1。
// 存档只保存 4 个数（上季初 / 本季初荣誉、ewma、环比基准），同比平移与回合乘子按 CONFIG 即时推导；已解散战队不保存。
// 不消耗随机数；旧存档缺失 Team.momentum 时视为中性（乘子 1、平移 0），下一次回合结算建立基准（标记 partial：赛季中途建立的记录
// 不是真正的「季初荣誉」，下个赛季初不作为同比基准；单机读档时玩家战队按 season.honorStart 补建，见 initMomentumOnLoad）。
import { CONFIG } from './config';
import type { GameState, Team, TeamMomentum } from './types';
import { clamp, ownEntry } from './util';

const round4 = (v: number) => Math.round(v * 10000) / 10000;

function cfg() {
  return CONFIG.form.honorMomentum;
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 同比平移：yoyWeight × ln(max(本季初, floor) / max(上季初, floor))，夹在 ±yoyCap；没有上季基准 → 0。
 * 荣誉 +50% → 约 +0.02，翻倍 → 上限 +0.03，−30% → 约 −0.018（数值见 CONFIG.form.honorMomentum）。
 */
export function yoyShiftOf(prevStart: number | undefined, start: number): number {
  const c = cfg();
  if (!c.enabled || typeof prevStart !== 'number' || !Number.isFinite(prevStart) || !Number.isFinite(start)) return 0;
  const floor = Math.max(1, c.yoyFloor);
  const ratio = Math.max(start, floor) / Math.max(prevStart, floor);
  const v = c.yoyWeight * Math.log(ratio);
  return round4(clamp(Number.isFinite(v) ? v : 0, -c.yoyCap, c.yoyCap));
}

/** 环比一步更新后的 ewma：(1 − alpha) × ewma + alpha × (荣誉变化 / max(roundFloor, |基准荣誉|)) */
export function nextEwma(ewma: number, lastHonor: number, honor: number): number {
  const c = cfg();
  const alpha = clamp(finite(c.roundAlpha, 0.4), 0, 1);
  const scale = Math.max(finite(c.roundFloor, 100), Math.abs(lastHonor), 1);
  const v = (1 - alpha) * finite(ewma, 0) + alpha * ((honor - lastHonor) / scale);
  return round4(Number.isFinite(v) ? v : 0);
}

/** ewma → 回合乘子：1 + clamp(roundWeight × ewma, ±roundCap) */
export function roundMultOf(ewma: number): number {
  const c = cfg();
  if (!c.enabled) return 1;
  return round4(1 + clamp(c.roundWeight * finite(ewma, 0), -c.roundCap, c.roundCap));
}

/**
 * 赛季初：全部未解散战队记录本季初荣誉（上季初荣誉转为同比基准），环比清零；已解散战队清除记录（不占存档）。
 * 须在 form.rollSeasonForm 之前、季前转会之后调用（荣誉在赛季初不变，先后只影响新成立俱乐部是否有记录）。
 */
export function rollTeamMomentum(state: GameState): void {
  for (const id in state.teams) {
    const team = state.teams[id];
    if (!team) continue;
    if (team.disbanded) {
      if (team.momentum) delete team.momentum;
      continue;
    }
    const honor = finite(team.honor, 0);
    const prev = team.momentum;
    const prevRaw = prev?.seasonStart;
    const m: TeamMomentum = { seasonStart: honor, ewma: 0, lastHonor: honor };
    // 赛季中途建立的记录（旧存档读档 / 赛季中成立的战队）的 seasonStart 不是季初荣誉：不作为同比基准
    if (typeof prevRaw === 'number' && Number.isFinite(prevRaw) && !prev?.partial) m.prevSeasonStart = prevRaw;
    team.momentum = m;
  }
}

/** 每回合结束：按本回合荣誉变化更新环比；旧存档 / 赛季中新成立的战队缺失记录时只建立基准（本回合不产生势头） */
export function updateTeamMomentumRound(state: GameState): void {
  const enabled = cfg().enabled;
  for (const id in state.teams) {
    const team = state.teams[id];
    if (!team || team.disbanded) continue;
    const honor = finite(team.honor, 0);
    const m = team.momentum;
    if (!m) {
      team.momentum = { seasonStart: honor, ewma: 0, lastHonor: honor, partial: true };
      continue;
    }
    m.ewma = enabled ? nextEwma(finite(m.ewma, 0), finite(m.lastHonor, honor), honor) : 0;
    m.lastHonor = honor;
  }
}

/**
 * 读档迁移（save.upgradeLoadedState，单机）：旧存档的玩家战队没有势头记录时，按本赛季的季初荣誉（season.honorStart）补建，
 * 下个赛季初的同比基准是真实的季初荣誉；其他战队仍在下一次回合结算时建立（partial）。返回是否补建。
 */
export function initMomentumOnLoad(state: GameState): boolean {
  if (state.multiplayer || !state.season) return false;
  const team = state.teams?.[state.settings?.playerTeamId];
  const start = state.season.honorStart;
  if (!team || team.disbanded || team.momentum || typeof start !== 'number' || !Number.isFinite(start)) return false;
  const honor = finite(team.honor, 0);
  team.momentum = { seasonStart: start, ewma: 0, lastHonor: honor };
  return true;
}

/** 战队评分的势头乘子（缺失 / 关闭 → 1） */
export function teamMomentumMult(team: Team | null | undefined): number {
  const m = team?.momentum;
  if (!m || !cfg().enabled) return 1;
  const v = roundMultOf(m.ewma);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** 赛季状态均值的同比平移（缺失 / 关闭 / 首个赛季 → 0） */
export function teamYoyShift(team: Team | null | undefined): number {
  const m = team?.momentum;
  if (!m || !cfg().enabled) return 0;
  return yoyShiftOf(m.prevSeasonStart, finite(m.seasonStart, 0));
}

export type MomentumLabel = '强势' | '向好' | '平稳' | '走低' | '低迷';
/** 从好到差 */
export const MOMENTUM_LABELS: MomentumLabel[] = ['强势', '向好', '平稳', '走低', '低迷'];

export interface TeamMomentumView {
  label: MomentumLabel;
  /** 赛季初同比平移（赛季状态均值的加项） */
  yoy: number;
  /** 回合乘子（战队评分） */
  roundMult: number;
  /** 合计（(1 + yoy) × roundMult − 1） */
  total: number;
  /** 本季初荣誉（无记录 → null） */
  seasonStart: number | null;
  /** 上季初荣誉（有同比基准时） */
  prevSeasonStart: number | null;
  /** 一句话说明（界面悬停 / 简报） */
  text: string;
}

const pctText = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

/** 势头标签（按合计偏离） */
export function momentumLabel(total: number): MomentumLabel {
  const L = cfg().labels;
  if (total >= L.strong) return '强势';
  if (total >= L.up) return '向好';
  if (total > L.down) return '平稳';
  if (total > L.weak) return '走低';
  return '低迷';
}

/** 界面用的势头视图（只读） */
export function teamMomentumView(state: GameState, teamId: string): TeamMomentumView {
  const team = ownEntry(state.teams, teamId);
  const yoy = teamYoyShift(team);
  const roundMult = teamMomentumMult(team);
  const total = round4((1 + yoy) * roundMult - 1);
  const m = team?.momentum;
  const hasPrev = typeof m?.prevSeasonStart === 'number' && Number.isFinite(m.prevSeasonStart);
  const parts: string[] = [];
  if (!cfg().enabled) {
    parts.push('荣誉势头未启用');
  } else {
    if (hasPrev) {
      parts.push(`荣誉同比：上季初 ${Math.round(m!.prevSeasonStart!)} → 本季初 ${Math.round(m!.seasonStart)}，全队赛季状态均值 ${pctText(yoy)}`);
    } else {
      parts.push('暂无上赛季同期荣誉，本赛季没有同比影响');
    }
    parts.push(`近期荣誉变化（环比）：战队评分 ×${roundMult.toFixed(3)}（${pctText(roundMult - 1)}），荣誉不变时逐回合回落`);
  }
  return {
    label: momentumLabel(total),
    yoy,
    roundMult,
    total,
    seasonStart: m ? finite(m.seasonStart, 0) : null,
    prevSeasonStart: hasPrev ? m!.prevSeasonStart! : null,
    text: `${parts.join('；')}。`,
  };
}
