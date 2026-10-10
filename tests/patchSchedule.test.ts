// 版本 → 回合映射：使用真实数据（src/data/patches.json + tis.json），不做 mock
import { describe, expect, it } from 'vitest';
import type { Season } from '../src/engine/types';
import { MAX_TI } from '../src/engine/config';
import { buildRounds, seasonStartDate, tiDates, tiYear } from '../src/engine/calendar';
import { allPatches, mapPatchesToRounds, patchAt, patchByVersion, resetPatchCache } from '../src/engine/patches';

function seasonOf(ti: number): Season {
  const startDate = seasonStartDate(ti);
  const { startDate: tiStart, endDate: tiEnd } = tiDates(ti);
  const rounds = buildRounds(ti, startDate, tiStart, tiEnd);
  return {
    ti, year: tiYear(ti), startDate, tiStartDate: tiStart, rounds, registeredTournamentIds: [], extraTrainingsBought: 0,
  };
}

describe('patches: 真实版本按发布日期映射到具体回合', () => {
  resetPatchCache();
  const seasons = Array.from({ length: MAX_TI }, (_, i) => seasonOf(i + 1));

  it('每个赛季：映射到回合的版本发布日落在该回合区间内，且晚于赛季开始日', () => {
    for (const s of seasons) {
      mapPatchesToRounds(s);
      expect(s.rounds[0].patchVersions).toEqual([]);
      for (const r of s.rounds.slice(1)) {
        for (const v of r.patchVersions) {
          const p = patchByVersion(v)!;
          expect(p, v).toBeDefined();
          expect(p.date > s.startDate, `${v} TI${s.ti}`).toBe(true);
          // 回合 1 从赛季开始日起算；其余回合 [startDate, endDate)
          expect(p.date >= r.startDate && p.date < r.endDate, `${v}@${p.date} → TI${s.ti} R${r.index}`).toBe(true);
        }
        // 同回合多次更新按日期升序
        const dates = r.patchVersions.map((v) => patchByVersion(v)!.date);
        expect(dates).toEqual(dates.slice().sort());
      }
    }
  });

  it('TI1..TI16 全程：每个版本恰好生效一次（赛季内某回合，或上届 TI 结束 ~ 赛季开始空档里的赛季初）', () => {
    const first = seasons[0];
    const lastEnd = seasons[seasons.length - 1].rounds.at(-1)!.endDate;
    const baseline = patchAt(first.startDate);
    const where = new Map<string, string[]>();
    const mark = (v: string, at: string) => where.set(v, [...(where.get(v) ?? []), at]);
    for (const s of seasons) {
      const prevEnd = s.ti > 1 ? tiDates(s.ti - 1).endDate : '0000-00-00';
      for (const p of allPatches()) {
        if (p.date >= prevEnd && p.date <= s.startDate && p.date > baseline.date) mark(p.version, `TI${s.ti} 赛季初`);
      }
      for (const r of s.rounds) for (const v of r.patchVersions) mark(v, `TI${s.ti} R${r.index}`);
    }
    const expected = allPatches().filter((p) => p.date > baseline.date && p.date < lastEnd);
    expect(expected.length).toBeGreaterThan(80);
    for (const p of expected) expect(where.get(p.version), `${p.version}@${p.date}`).toHaveLength(1);
  });

  it('具体样例：一个赛季内多次更新分布在不同回合；空档版本在赛季初生效', () => {
    const ti12 = seasons[11];
    const roundOf = (s: Season, v: string) => s.rounds.find((r) => r.patchVersions.includes(v))?.index ?? -1;
    for (const v of ['7.33', '7.33c', '7.34']) expect(roundOf(ti12, v), v).toBeGreaterThan(0);
    expect(roundOf(ti12, '7.33')).toBeLessThan(roundOf(ti12, '7.34'));
    // 7.30e（2021-10-28）发布于 TI10 结束（2021-10-17）之后、TI11 赛季开始之前 → 不映射到任何回合（赛季初生效）
    const ti11 = seasons[10];
    const p = patchByVersion('7.30e');
    if (p && p.date > tiDates(10).endDate && p.date <= ti11.startDate) {
      expect(roundOf(ti11, '7.30e')).toBe(-1);
      expect(roundOf(seasons[9], '7.30e')).toBe(-1);
    }
  });

  it('skip：已应用的版本不再映射', () => {
    const s = seasonOf(12);
    mapPatchesToRounds(s, (v) => v === '7.33');
    expect(s.rounds.some((r) => r.patchVersions.includes('7.33'))).toBe(false);
    expect(s.rounds.some((r) => r.patchVersions.includes('7.34'))).toBe(true);
  });
});
