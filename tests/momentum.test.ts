// 荣誉势头（第十四波，src/engine/momentum.ts）：同比平移赛季状态均值、环比调整战队评分；数学、上限、衰减、确定性
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import {
  momentumLabel, nextEwma, rollTeamMomentum, roundMultOf, teamMomentumMult, teamMomentumView, teamYoyShift,
  updateTeamMomentumRound, yoyShiftOf,
} from '../src/engine/momentum';
import { FORM_SOURCE, applySeasonForm } from '../src/engine/form';
import { teamRating } from '../src/engine/team';
import { seededRng } from '../src/engine/rng';
import { makeTestState } from './helpers';

const C = CONFIG.form.honorMomentum;

describe('momentum · 同比（赛季初）', () => {
  it('yoy = weight × ln(本季初 / 上季初)，夹在 ±yoyCap，荣誉按 yoyFloor 托底；无上季基准为 0', () => {
    expect(yoyShiftOf(undefined, 800)).toBe(0);
    expect(yoyShiftOf(1000, 1000)).toBe(0);
    expect(yoyShiftOf(1000, 1500)).toBeCloseTo(C.yoyWeight * Math.log(1.5), 3);
    expect(yoyShiftOf(1000, 700)).toBeCloseTo(C.yoyWeight * Math.log(0.7), 3);
    // 翻 4 倍 / 腰斩再腰斩：上限
    expect(yoyShiftOf(500, 2000)).toBe(C.yoyCap);
    expect(yoyShiftOf(2000, 500)).toBe(-C.yoyCap);
    // 荣誉低于托底值时按托底值计（30 → 90 不算「翻三倍」）
    expect(yoyShiftOf(30, 90)).toBe(0);
    expect(yoyShiftOf(50, 150)).toBeCloseTo(C.yoyWeight * Math.log(1.5), 3);
  });

  it('rollTeamMomentum：首个赛季无同比；下个赛季以上季初荣誉为基准；已解散战队清除记录', () => {
    const s = makeTestState(3);
    s.teams.t1.honor = 1000;
    rollTeamMomentum(s);
    expect(s.teams.t1.momentum).toEqual({ seasonStart: 1000, ewma: 0, lastHonor: 1000 });
    expect(teamYoyShift(s.teams.t1)).toBe(0);
    s.teams.t1.honor = 1500;
    s.teams.t2.disbanded = true;
    rollTeamMomentum(s);
    expect(s.teams.t1.momentum).toEqual({ prevSeasonStart: 1000, seasonStart: 1500, ewma: 0, lastHonor: 1500 });
    expect(teamYoyShift(s.teams.t1)).toBeCloseTo(C.yoyWeight * Math.log(1.5), 3);
    expect(s.teams.t2.momentum).toBeUndefined();
    // 存档只保存 4 个原始量
    expect(Object.keys(s.teams.t1.momentum!).sort()).toEqual(['ewma', 'lastHonor', 'prevSeasonStart', 'seasonStart']);
  });

  it('同比平移赛季状态均值：随机数用量不变，状态值整体平移', () => {
    const base = makeTestState(2, 7);
    const up = makeTestState(2, 7);
    up.teams.t1.momentum = { prevSeasonStart: 500, seasonStart: 2000, ewma: 0, lastHonor: 2000 };
    const pa = base.teams.t1.playerIds.map((id) => base.players[id]);
    const pb = up.teams.t1.playerIds.map((id) => up.players[id]);
    const ra = seededRng(99);
    const rb = seededRng(99);
    const va = pa.map((p) => applySeasonForm(base, p, ra, 20));
    const vb = pb.map((p) => applySeasonForm(up, p, rb, 20));
    expect(ra.next()).toBe(rb.next()); // 随机序列对齐
    for (let i = 0; i < va.length; i++) {
      const [lo, hi] = CONFIG.form.range;
      const expected = Math.min(hi, Math.max(lo, va[i] + C.yoyCap));
      expect(vb[i]).toBeCloseTo(expected, 2);
      expect(pb[i].modifiers.some((m) => m.source === FORM_SOURCE)).toBe(true);
    }
  });
});

describe('momentum · 环比（每回合）', () => {
  it('ewma 指数平滑、回合乘子夹在 ±roundCap、荣誉不变时逐回合衰减回 1', () => {
    const e1 = nextEwma(0, 300, 320);
    expect(e1).toBeCloseTo(C.roundAlpha * (20 / 300), 4);
    expect(roundMultOf(e1)).toBeCloseTo(1 + C.roundWeight * e1, 4);
    // 规模按 max(roundFloor, |荣誉|)：低荣誉不会被小幅变化放大
    expect(nextEwma(0, 20, 40)).toBeCloseTo(C.roundAlpha * (20 / C.roundFloor), 4);
    expect(roundMultOf(1)).toBe(1 + C.roundCap);
    expect(roundMultOf(-1)).toBe(1 - C.roundCap);
    let e = 0.1;
    for (let i = 0; i < 12; i++) e = nextEwma(e, 500, 500);
    expect(Math.abs(e)).toBeLessThan(0.001);
    expect(roundMultOf(e)).toBeCloseTo(1, 3);
  });

  it('updateTeamMomentumRound：旧存档缺失记录时只建立基准；之后按荣誉变化更新；乘子作用于战队评分', () => {
    const s = makeTestState(3);
    const t = s.teams.t1;
    t.honor = 400;
    const r0 = teamRating(s, 't1');
    updateTeamMomentumRound(s);
    // 赛季中途建立的记录标记 partial：下个赛季初不作为同比基准（seasonStart 不是真正的季初荣誉）
    expect(t.momentum).toEqual({ seasonStart: 400, ewma: 0, lastHonor: 400, partial: true });
    expect(teamMomentumMult(t)).toBe(1);
    t.honor = 480; // 本回合 +80
    updateTeamMomentumRound(s);
    const mult = teamMomentumMult(t);
    expect(mult).toBeGreaterThan(1);
    expect(mult).toBeLessThanOrEqual(1 + C.roundCap);
    expect(teamRating(s, 't1')).toBeCloseTo(r0 * mult, 6);
    // 连续失利 → 乘子 < 1
    for (const h of [440, 380, 320]) {
      t.honor = h;
      updateTeamMomentumRound(s);
    }
    expect(teamMomentumMult(t)).toBeLessThan(1);
    expect(teamMomentumMult(t)).toBeGreaterThanOrEqual(1 - C.roundCap);
    // 已解散战队不再更新
    const frozen = JSON.stringify(s.teams.t2.momentum);
    s.teams.t2.disbanded = true;
    s.teams.t2.honor += 200;
    updateTeamMomentumRound(s);
    expect(JSON.stringify(s.teams.t2.momentum)).toBe(frozen);
  });

  it('确定性：同样的荣誉序列得到同样的势头（不消耗随机数）', () => {
    const run = () => {
      const s = makeTestState(4, 3);
      const rng0 = s.rngState;
      rollTeamMomentum(s);
      const seq = [20, -35, 0, 60, -10];
      for (const d of seq) {
        for (const id in s.teams) s.teams[id].honor += d * (id === 't2' ? 2 : 1);
        updateTeamMomentumRound(s);
      }
      expect(s.rngState).toBe(rng0);
      return JSON.stringify(Object.values(s.teams).map((t) => t.momentum));
    };
    expect(run()).toBe(run());
  });
});

describe('momentum · 视图与标签', () => {
  it('标签按合计偏离分档；视图给出同比 / 环比说明', () => {
    expect(momentumLabel(0.02)).toBe('强势');
    expect(momentumLabel(0.005)).toBe('向好');
    expect(momentumLabel(0)).toBe('平稳');
    expect(momentumLabel(-0.005)).toBe('走低');
    expect(momentumLabel(-0.02)).toBe('低迷');
    const s = makeTestState(2);
    s.teams.t1.momentum = { prevSeasonStart: 600, seasonStart: 900, ewma: 0.05, lastHonor: 950 };
    const v = teamMomentumView(s, 't1');
    expect(v.yoy).toBeCloseTo(C.yoyWeight * Math.log(1.5), 3);
    expect(v.roundMult).toBeCloseTo(1 + C.roundWeight * 0.05, 4);
    expect(v.total).toBeCloseTo((1 + v.yoy) * v.roundMult - 1, 4);
    expect(v.label).toBe('强势');
    expect(v.text).toContain('上季初 600 → 本季初 900');
    expect(v.text).toContain('环比');
    // 无记录 → 平稳、无同比
    const n = teamMomentumView(s, 't0');
    expect(n.label).toBe('平稳');
    expect(n.prevSeasonStart).toBeNull();
    expect(n.text).toContain('没有同比');
  });
});
