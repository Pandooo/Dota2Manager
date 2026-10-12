// 选手派生属性与修正器【E1 负责实现】
import { CONFIG, TI_YEAR } from './config';
import type { GameState, ModAttr, Modifier, Player, Position, Region, Tier } from './types';
import { TIERS } from './types';
import { clamp, nextId, yearOf } from './util';

// ---------------------------------------------------------------------------
// 天梯等级
// ---------------------------------------------------------------------------

/** 从高到低的等级顺序（tierOf 查表用） */
const TIERS_DESC: Tier[] = TIERS.slice().reverse();

/** mmr → 天梯等级（按 CONFIG.ladder.thresholds；低于 C 阈值也返回 'C'） */
export function tierOf(mmr: number): Tier {
  const th = CONFIG.ladder.thresholds;
  if (!Number.isFinite(mmr)) return 'C';
  for (const t of TIERS_DESC) {
    if (mmr >= th[t]) return t;
  }
  return 'C';
}

/** 等级序号 C=0 … SSR=5 */
export function tierIndex(tier: Tier): number {
  const i = TIERS.indexOf(tier);
  return i < 0 ? 0 : i;
}

/** 天梯倍数（CONFIG.ladder.multipliers） */
export function ladderMult(tier: Tier): number {
  return CONFIG.ladder.multipliers[tier] ?? 1;
}

// ---------------------------------------------------------------------------
// 年龄 & 经济指数
// ---------------------------------------------------------------------------

/** 当前赛季年份（容错：season 缺失时按当前日期/起始 TI 推断） */
export function seasonYear(state: GameState): number {
  const y = state.season?.year;
  if (typeof y === 'number' && Number.isFinite(y)) return y;
  if (state.currentDate) {
    const cy = yearOf(state.currentDate);
    if (Number.isFinite(cy)) return cy;
  }
  return TI_YEAR[state.settings?.startTi ?? 9] ?? 2019;
}

/** 年龄 = 当前赛季年份 - birthYear */
export function ageOf(state: GameState, p: { birthYear: number }): number {
  return seasonYear(state) - p.birthYear;
}

const ECON_YEARS: number[] = Object.keys(CONFIG.economy.econIndexByYear)
  .map(Number)
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

/** 年代经济指数（与 economy.econIndex 同语义：超出范围或缺失年份取最近年份）。内联以避免模块依赖 */
export function econIndexAt(year: number): number {
  const table = CONFIG.economy.econIndexByYear;
  if (table[year] !== undefined) return table[year];
  if (ECON_YEARS.length === 0) return 1;
  let best = ECON_YEARS[0];
  for (const y of ECON_YEARS) {
    if (Math.abs(y - year) < Math.abs(best - year)) best = y;
  }
  return table[best] ?? 1;
}

/** 当前赛季经济指数 */
export function seasonEconIndex(state: GameState): number {
  return econIndexAt(seasonYear(state));
}

// ---------------------------------------------------------------------------
// 有效属性
// ---------------------------------------------------------------------------

/** 将某属性的值夹在合法范围内 */
function clampAttrValue(attr: ModAttr, v: number): number {
  if (!Number.isFinite(v)) v = 0;
  switch (attr) {
    case 'mmr':
      return clamp(v, CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr);
    case 'power':
      return Math.max(1, v);
    default:
      return clamp(v, 0, CONFIG.player.maxAttr);
  }
}

/** 属性有效值：(base + Σadd) × Πmul（talent/resilience/insight/loyalty 夹在 0..100；mmr 夹在 CONFIG.ladder.minMmr..maxMmr） */
export function effectiveAttr(p: Player, attr: ModAttr): number {
  let base = Number(p[attr]);
  if (!Number.isFinite(base)) base = 0;
  const mods = p.modifiers;
  if (mods && mods.length > 0) {
    let add = 0;
    let mul = 1;
    for (const m of mods) {
      if (m.attr !== attr || !Number.isFinite(m.value)) continue;
      if (m.kind === 'add') add += m.value;
      else mul *= m.value;
    }
    base = (base + add) * mul;
  }
  return clampAttrValue(attr, base);
}

export function effectivePower(p: Player): number {
  return effectiveAttr(p, 'power');
}

/** 选手当前天梯等级（基于有效 mmr） */
export function playerTier(p: Player): Tier {
  return tierOf(effectiveAttr(p, 'mmr'));
}

/** 选手在某位置上的评分 = effectivePower × ladderMult × (位置匹配 ? 1 : offRoleFactor) */
export function playerRating(p: Player, slot: Position): number {
  const roleFactor = slot === p.position ? 1 : CONFIG.team.offRoleFactor;
  return effectivePower(p) * ladderMult(playerTier(p)) * roleFactor;
}

/** 选手综合评分（本位置 playerRating），用于排序/展示 */
export function overallRating(p: Player): number {
  return playerRating(p, p.position);
}

/** 事件影响缩放系数（韧性）：1 - resilience/divisor，受 CONFIG.player.resilienceInverted 控制；结果夹在 [0.2, 1.2] */
export function eventImpactScale(p: Player): number {
  const { resilienceDivisor, resilienceInverted, maxAttr, eventScaleMin, eventScaleMax } = CONFIG.player;
  const r = effectiveAttr(p, 'resilience');
  const divisor = resilienceDivisor > 0 ? resilienceDivisor : 150;
  // 反转模式：按需求原文字面（低韧性 → 影响小），以 maxAttr 为轴镜像
  const effective = resilienceInverted ? maxAttr - r : r;
  return clamp(1 - effective / divisor, eventScaleMin, eventScaleMax);
}

// ---------------------------------------------------------------------------
// 修正器
// ---------------------------------------------------------------------------

/**
 * 添加修正器（自动生成 id），返回该修正器。
 * 防御：roundsLeft 缺失/非有限数 → null（永久，与存档序列化后的语义一致）；有限数取整；
 * value 非有限数 → 中性值（add 0 / mul 1），避免 NaN 污染有效属性。
 */
export function addModifier(state: GameState, p: Player, mod: Omit<Modifier, 'id'>): Modifier {
  const kind: Modifier['kind'] = mod.kind === 'add' ? 'add' : 'mul';
  const value = Number.isFinite(mod.value) ? mod.value : kind === 'add' ? 0 : 1;
  const rl = mod.roundsLeft;
  const roundsLeft = typeof rl === 'number' && Number.isFinite(rl) ? Math.round(rl) : null;
  const m: Modifier = { ...mod, kind, value, roundsLeft, id: nextId(state, 'm') };
  if (!Array.isArray(p.modifiers)) p.modifiers = [];
  p.modifiers.push(m);
  return m;
}

/** 所有选手修正器 roundsLeft-1，移除到期的（每大回合结束调用一次） */
export function tickModifiers(state: GameState): void {
  for (const id in state.players) {
    const p = state.players[id];
    const mods = p.modifiers;
    if (!mods || mods.length === 0) continue;
    let write = 0;
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      if (typeof m.roundsLeft === 'number') {
        // NaN（旧存档/异常数据）视为已到期，避免「永不过期」的临时修正
        m.roundsLeft -= 1;
        if (!(m.roundsLeft > 0)) continue; // 到期移除
      }
      mods[write++] = m;
    }
    mods.length = write;
  }
}

// ---------------------------------------------------------------------------
// 工资 & 身价
// ---------------------------------------------------------------------------

/** 按等级/战力/年代计算每大回合工资（rookie 打折） */
export function computeSalary(state: GameState, p: Player, rookie?: boolean): number {
  return standardSalary(p.mmr, p.power, seasonEconIndex(state), rookie);
}

/**
 * 标准工资（纯函数）：salaryByTier[天梯等级] × (1 + (战力 − 70) × salaryPowerFactor) × 年代经济指数（新秀 × rookieSalaryMult），不低于 minSalary。
 * computeSalary 与 economy.seedTeamWageBill（开局前按阵容数据估算真实俱乐部工资）共用
 */
export function standardSalary(mmr: number, power: number, econIndex: number, rookie?: boolean): number {
  const eco = CONFIG.economy;
  const tier = tierOf(mmr);
  const pw = Number.isFinite(power) ? power : 50;
  const powerFactor = Math.max(0, 1 + (pw - 70) * eco.salaryPowerFactor);
  const raw = eco.salaryByTier[tier] * powerFactor * econIndex * (rookie ? eco.rookieSalaryMult : 1);
  return Math.max(eco.minSalary, Math.round(raw));
}

function marketAgeMult(age: number): number {
  const table = CONFIG.economy.marketValueAgeMult;
  for (const [maxAge, mult] of table) {
    if (age <= maxAge) return mult;
  }
  return table.length ? table[table.length - 1][1] : 1;
}

/** 身价（转会参考价）：工资 × marketValueMult × 年龄系数 × 天赋系数 */
export function marketValue(state: GameState, p: Player): number {
  const eco = CONFIG.economy;
  // 以「按当前能力重算的正常工资」为基准，避免新人折扣/旧合同影响身价
  const salary = computeSalary(state, p, false);
  const talent = clamp(Number.isFinite(p.talent) ? p.talent : 50, 0, CONFIG.player.maxAttr);
  const talentMult = eco.marketValueTalentBase + (talent / 100) * eco.marketValueTalentSpan;
  const v = salary * eco.marketValueMult * marketAgeMult(ageOf(state, p)) * talentMult;
  // 取整到百位，便于展示
  return Math.max(0, Math.round(v / 100) * 100);
}

// ---------------------------------------------------------------------------
// 国籍 → 赛区
// ---------------------------------------------------------------------------

const NATIONALITY_REGION: Record<string, Region> = (() => {
  const map: Record<string, Region> = {};
  const put = (region: Region, codes: string[]) => {
    for (const c of codes) map[c] = region;
  };
  // 中国赛区：大陆、台湾、香港、澳门
  put('CN', ['CN', 'TW', 'HK', 'MO']);
  // 东南亚（含日韩、南亚、大洋洲、蒙古）
  put('SEA', [
    'MY', 'PH', 'ID', 'SG', 'TH', 'VN', 'MM', 'KH', 'LA', 'BN', 'TL',
    'JP', 'KR', 'AU', 'NZ', 'IN', 'PK', 'BD', 'LK', 'NP', 'MN', 'PG', 'FJ',
  ]);
  // 独联体/东欧（原苏联地区）
  put('CIS', ['RU', 'UA', 'BY', 'KZ', 'KG', 'UZ', 'TJ', 'TM', 'AM', 'GE', 'AZ', 'MD', 'LV', 'LT', 'EE']);
  // 北美（含墨西哥、中美洲、加勒比）
  put('NA', [
    'US', 'CA', 'MX', 'GT', 'HN', 'SV', 'NI', 'CR', 'PA', 'BZ',
    'CU', 'DO', 'PR', 'JM', 'TT', 'HT', 'BS', 'BB',
  ]);
  // 南美
  put('SA', ['BR', 'PE', 'AR', 'CL', 'BO', 'CO', 'UY', 'EC', 'VE', 'PY', 'GY', 'SR']);
  return map;
})();

/** 国籍 → 赛区（CN/TW/HK/MO→CN；SEA 各国；RU/UA/BY/KZ…→CIS；北美；南美；其余欧洲/中东→EU） */
export function regionOfNationality(cc: string): Region {
  if (!cc) return 'EU';
  let code = String(cc).trim().toUpperCase();
  if (code === 'UK') code = 'GB';
  return NATIONALITY_REGION[code] ?? 'EU';
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** 将 talent/resilience/insight/loyalty 夹在 [0,100]，power ≥ 1，mmr 夹在合法范围 */
export function clampPlayerAttrs(p: Player): void {
  const max = CONFIG.player.maxAttr;
  const fix = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);
  p.talent = clamp(fix(p.talent, 50), 0, max);
  p.resilience = clamp(fix(p.resilience, 50), 0, max);
  p.insight = clamp(fix(p.insight, 50), 0, max);
  p.loyalty = clamp(fix(p.loyalty, 60), 0, max);
  p.power = Math.max(1, fix(p.power, 50));
  p.mmr = Math.round(clamp(fix(p.mmr, CONFIG.ladder.thresholds.C), CONFIG.ladder.minMmr, CONFIG.ladder.maxMmr));
}

/** 选手是否可上场（active 且不在 unavailableTournamentIds 中） */
export function isAvailable(p: Player, tournamentId?: string | null): boolean {
  if (!p || p.status !== 'active') return false;
  if (tournamentId && p.unavailableTournamentIds && p.unavailableTournamentIds.includes(tournamentId)) return false;
  return true;
}
