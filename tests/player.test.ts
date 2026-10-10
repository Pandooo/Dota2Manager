import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import {
  addModifier, ageOf, clampPlayerAttrs, computeSalary, econIndexAt, effectiveAttr, effectivePower, eventImpactScale,
  isAvailable, ladderMult, marketValue, overallRating, playerRating, playerTier, regionOfNationality, tickModifiers,
  tierIndex, tierOf,
} from '../src/engine/player';
import { makePlayer, makeTestState } from './helpers';

describe('player: 天梯等级', () => {
  it('tierOf 按阈值划分，低于 C 也为 C', () => {
    expect(tierOf(3000)).toBe('C');
    expect(tierOf(4999)).toBe('C');
    expect(tierOf(5000)).toBe('C');
    expect(tierOf(5499)).toBe('C');
    expect(tierOf(5500)).toBe('B');
    expect(tierOf(6499)).toBe('B');
    expect(tierOf(6500)).toBe('A');
    expect(tierOf(8000)).toBe('S');
    expect(tierOf(10999)).toBe('S');
    expect(tierOf(11000)).toBe('SS');
    expect(tierOf(15000)).toBe('SSR');
    expect(tierOf(20000)).toBe('SSR');
    expect(tierOf(Number.NaN)).toBe('C');
  });

  it('tierIndex / ladderMult', () => {
    expect(tierIndex('C')).toBe(0);
    expect(tierIndex('SSR')).toBe(5);
    expect(ladderMult('C')).toBe(0.9);
    expect(ladderMult('B')).toBe(0.95);
    expect(ladderMult('SSR')).toBe(1.15);
  });
});

describe('player: 有效属性', () => {
  it('(base + Σadd) × Πmul，只作用于对应属性', () => {
    const p = makePlayer({ power: 80 });
    p.modifiers.push(
      { id: 'a', source: 't', attr: 'power', kind: 'add', value: 10, roundsLeft: 2 },
      { id: 'b', source: 't', attr: 'power', kind: 'mul', value: 0.5, roundsLeft: null },
      { id: 'c', source: 't', attr: 'insight', kind: 'add', value: 50, roundsLeft: null },
    );
    expect(effectiveAttr(p, 'power')).toBeCloseTo(45);
    expect(effectivePower(p)).toBeCloseTo(45);
    // insight 60 + 50 → 夹到 100
    expect(effectiveAttr(p, 'insight')).toBe(100);
  });

  it('mmr 夹在合法范围，等级基于有效 mmr', () => {
    const p = makePlayer({ mmr: 7900 });
    expect(playerTier(p)).toBe('A');
    p.modifiers.push({ id: 'x', source: 't', attr: 'mmr', kind: 'add', value: 200, roundsLeft: 1 });
    expect(playerTier(p)).toBe('S');
    p.modifiers.push({ id: 'y', source: 't', attr: 'mmr', kind: 'add', value: 1e6, roundsLeft: 1 });
    expect(effectiveAttr(p, 'mmr')).toBe(CONFIG.ladder.maxMmr);
  });

  it('playerRating：本位置全额，非本位置 × offRoleFactor', () => {
    const p = makePlayer({ power: 80, mmr: 9000, position: 'M' });
    expect(playerRating(p, 'M')).toBeCloseTo(80 * 1.05);
    expect(playerRating(p, 'C')).toBeCloseTo(80 * 1.05 * CONFIG.team.offRoleFactor);
    expect(overallRating(p)).toBeCloseTo(playerRating(p, 'M'));
  });

  it('eventImpactScale：高韧性 → 影响小，结果夹紧', () => {
    expect(eventImpactScale(makePlayer({ resilience: 0 }))).toBeCloseTo(1);
    expect(eventImpactScale(makePlayer({ resilience: 75 }))).toBeCloseTo(0.5);
    expect(eventImpactScale(makePlayer({ resilience: 100 }))).toBeCloseTo(1 - 100 / 150);
    const low = eventImpactScale(makePlayer({ resilience: 10 }));
    const high = eventImpactScale(makePlayer({ resilience: 90 }));
    expect(high).toBeLessThan(low);
  });
});

describe('player: 修正器', () => {
  it('addModifier 生成 id；tickModifiers 递减并移除到期，永久保留', () => {
    const s = makeTestState(1);
    const p = s.players['t0-C'];
    const m1 = addModifier(s, p, { source: '情感受挫', attr: 'power', kind: 'mul', value: 0.9, roundsLeft: 2 });
    addModifier(s, p, { source: '版本', attr: 'insight', kind: 'add', value: 1, roundsLeft: null });
    expect(m1.id).toBeTruthy();
    expect(p.modifiers).toHaveLength(2);
    tickModifiers(s);
    expect(p.modifiers.find((m) => m.id === m1.id)?.roundsLeft).toBe(1);
    tickModifiers(s);
    expect(p.modifiers.find((m) => m.id === m1.id)).toBeUndefined();
    expect(p.modifiers).toHaveLength(1);
    tickModifiers(s);
    expect(p.modifiers).toHaveLength(1);
  });

  it('addModifier 规范化异常输入：缺失/NaN 回合数 → 永久，小数取整，NaN 数值 → 中性', () => {
    const s = makeTestState(1);
    const p = s.players['t0-C'];
    const base = effectiveAttr(p, 'power');
    const a = addModifier(s, p, { source: 'x', attr: 'power', kind: 'mul', value: Number.NaN, roundsLeft: Number.NaN });
    expect(a.value).toBe(1);
    expect(a.roundsLeft).toBeNull();
    const b = addModifier(s, p, { source: 'x', attr: 'power', kind: 'add', value: Number.NaN, roundsLeft: undefined as unknown as null });
    expect(b.value).toBe(0);
    expect(b.roundsLeft).toBeNull();
    const c = addModifier(s, p, { source: 'x', attr: 'power', kind: 'mul', value: 0.9, roundsLeft: 1.6 });
    expect(c.roundsLeft).toBe(2);
    expect(effectiveAttr(p, 'power')).toBeCloseTo(base * 0.9);
    // 序列化往返后语义一致
    const restored = JSON.parse(JSON.stringify(p.modifiers));
    expect(restored.map((m: { roundsLeft: number | null }) => m.roundsLeft)).toEqual([null, null, 2]);
  });

  it('tickModifiers：异常的 NaN 回合数视为到期，不会永不过期', () => {
    const s = makeTestState(1);
    const p = s.players['t0-C'];
    p.modifiers.push({ id: 'bad', source: '旧存档', attr: 'power', kind: 'mul', value: 0.5, roundsLeft: Number.NaN });
    tickModifiers(s);
    expect(p.modifiers.find((m) => m.id === 'bad')).toBeUndefined();
  });
});

describe('player: 工资/身价/年龄', () => {
  it('ageOf 基于赛季年份', () => {
    const s = makeTestState(0);
    expect(ageOf(s, { birthYear: 1999 })).toBe(20);
  });

  it('econIndexAt 超出范围取最近年份', () => {
    expect(econIndexAt(2019)).toBe(1);
    expect(econIndexAt(2000)).toBe(CONFIG.economy.econIndexByYear[2011]);
    expect(econIndexAt(2050)).toBe(CONFIG.economy.econIndexByYear[2027]);
  });

  it('computeSalary = 等级工资 × 战力系数 × 经济指数 × 新人折扣，整数且有下限', () => {
    const s = makeTestState(0); // 2019，经济指数 1
    const eco = CONFIG.economy;
    const sBase = eco.salaryByTier.S; // mmr 9000 = S 级
    const p = makePlayer({ mmr: 9000, power: 70 });
    expect(computeSalary(s, p)).toBe(sBase);
    expect(computeSalary(s, p, true)).toBe(Math.round(sBase * eco.rookieSalaryMult));
    const strong = makePlayer({ mmr: 9000, power: 80 });
    expect(computeSalary(s, strong)).toBe(Math.round(sBase * (1 + 10 * eco.salaryPowerFactor)));
    const scrub = makePlayer({ mmr: 3000, power: 5 });
    expect(computeSalary(s, scrub)).toBe(eco.minSalary);
    s.season.year = 2011;
    expect(computeSalary(s, p)).toBe(Math.max(eco.minSalary, Math.round(sBase * eco.econIndexByYear[2011])));
    // 等级越高工资越高
    const ss = makePlayer({ mmr: 12000, power: 70 });
    s.season.year = 2019;
    expect(computeSalary(s, ss)).toBeGreaterThan(computeSalary(s, p));
  });

  it('marketValue：年轻、高天赋更值钱', () => {
    const s = makeTestState(0);
    const young = makePlayer({ birthYear: 2000, talent: 80 });
    const old = makePlayer({ birthYear: 1988, talent: 80 });
    const lowTalent = makePlayer({ birthYear: 2000, talent: 20 });
    expect(marketValue(s, young)).toBeGreaterThan(marketValue(s, old));
    expect(marketValue(s, young)).toBeGreaterThan(marketValue(s, lowTalent));
    expect(Number.isInteger(marketValue(s, young))).toBe(true);
    // S 级、战力 75、19 岁、天赋 80：工资(S) × 1.06 × marketValueMult × 年龄 1.3 × 天赋 (0.7 + 0.8 × 0.6)
    const eco = CONFIG.economy;
    const expected = eco.salaryByTier.S * (1 + 5 * eco.salaryPowerFactor) * eco.marketValueMult * 1.3
      * (eco.marketValueTalentBase + 0.8 * eco.marketValueTalentSpan);
    expect(marketValue(s, young)).toBeGreaterThan(expected * 0.97);
    expect(marketValue(s, young)).toBeLessThan(expected * 1.03);
    // 身价约为 50~70 回合工资（S 级年轻选手）
    expect(marketValue(s, young) / computeSalary(s, young)).toBeGreaterThan(40);
    expect(marketValue(s, young) / computeSalary(s, young)).toBeLessThan(80);
  });
});

describe('player: 国籍 → 赛区', () => {
  it('覆盖主要 Dota 国家', () => {
    for (const cc of ['CN', 'TW', 'HK', 'MO']) expect(regionOfNationality(cc)).toBe('CN');
    for (const cc of ['MY', 'PH', 'ID', 'SG', 'TH', 'VN', 'MM', 'KH', 'LA', 'JP', 'KR', 'AU', 'NZ']) {
      expect(regionOfNationality(cc)).toBe('SEA');
    }
    for (const cc of ['RU', 'UA', 'BY', 'KZ', 'KG', 'UZ', 'AM', 'GE', 'MD', 'LV', 'LT', 'EE']) {
      expect(regionOfNationality(cc)).toBe('CIS');
    }
    for (const cc of ['US', 'CA', 'MX']) expect(regionOfNationality(cc)).toBe('NA');
    for (const cc of ['BR', 'PE', 'AR', 'CL', 'BO', 'CO', 'UY', 'EC', 'VE']) expect(regionOfNationality(cc)).toBe('SA');
    for (const cc of ['DE', 'SE', 'DK', 'FI', 'JO', 'IL', 'BG', 'GB', 'UK', 'SA', 'XX']) {
      expect(regionOfNationality(cc)).toBe('EU'); // 'SA' 为沙特阿拉伯
    }
    expect(regionOfNationality('ru')).toBe('CIS');
    expect(regionOfNationality('')).toBe('EU');
  });
});

describe('player: 杂项', () => {
  it('clampPlayerAttrs 修正越界与 NaN', () => {
    const p = makePlayer({ talent: 150, resilience: -5, insight: Number.NaN, loyalty: 101, power: -3, mmr: 999999 });
    clampPlayerAttrs(p);
    expect(p.talent).toBe(100);
    expect(p.resilience).toBe(0);
    expect(p.insight).toBe(50);
    expect(p.loyalty).toBe(100);
    expect(p.power).toBe(1);
    expect(p.mmr).toBe(CONFIG.ladder.maxMmr);
  });

  it('isAvailable：active 且不在不可用赛事中', () => {
    const p = makePlayer({ unavailableTournamentIds: ['esl-2019'] });
    expect(isAvailable(p)).toBe(true);
    expect(isAvailable(p, 'other')).toBe(true);
    expect(isAvailable(p, 'esl-2019')).toBe(false);
    expect(isAvailable(makePlayer({ status: 'banned' }))).toBe(false);
    expect(isAvailable(makePlayer({ status: 'retired' }), null)).toBe(false);
  });
});
