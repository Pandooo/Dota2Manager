import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/engine/config';
import {
  coachFromRetiredPlayer, coachFromSeed, colorFromId, generateAiTeam, generateCoach, generateHandle, generatePlayer,
  generateTeamName, mmrForTier, NATIONALITY_POOLS, playerFromSeed, randomTier, rookieFromIndex, teamFromSeed, tierForPower,
} from '../src/engine/generation';
import { ageOf, playerTier, regionOfNationality, tierIndex, tierOf } from '../src/engine/player';
import { seededRng } from '../src/engine/rng';
import { validateLineup } from '../src/engine/team';
import type { PlayerIndexEntry, Position, SeedPlayer, SeedTeam, Tier } from '../src/engine/types';
import { POSITIONS, REGIONS, TIERS } from '../src/engine/types';
import { makePlayer, makeTestState } from './helpers';
import { getPlayerIndex } from '../src/data';
import { createNewGame } from '../src/engine/game';
import { registerNodeRosterLoader } from '../scripts/nodeData';

function seedPlayer(id: string, position: Position, over: Partial<SeedPlayer> = {}): SeedPlayer {
  return {
    id, handle: id.toUpperCase(), nationality: 'UA', birthYear: 1997, position, mmr: 9500, power: 82, talent: 75,
    resilience: 60, insight: 70, loyalty: 70, signatureHeroes: ['invoker'], ...over,
  };
}

describe('generation: handle', () => {
  it('各赛区生成非空、不重复的 ID', () => {
    const s = makeTestState(0, 99);
    for (const r of REGIONS) {
      for (let i = 0; i < 80; i++) {
        const p = generatePlayer(s, { region: r });
        expect(p.handle.length).toBeGreaterThanOrEqual(2);
        expect(p.handle.length).toBeLessThanOrEqual(17);
      }
    }
    const handles = Object.values(s.players).map((p) => p.handle.toLowerCase());
    expect(new Set(handles).size).toBe(handles.length);
  });

  it('不冒用真实选手的 handle（playerIndex），避免与日后登场的真实新秀重名', () => {
    const real = new Set(getPlayerIndex().map((e) => e.handle.toLowerCase()));
    expect(real.size).toBeGreaterThan(0);
    const s = makeTestState(0, 4242);
    for (let i = 0; i < 1800; i++) {
      const h = generateHandle(s, REGIONS[i % REGIONS.length]);
      expect(real.has(h.toLowerCase())).toBe(false);
    }
  });

  it('与现有 handle 不重复（大小写不敏感）', () => {
    const s = makeTestState(0, 3);
    for (let i = 0; i < 50; i++) {
      const h = generateHandle(s, 'CN');
      s.players[`x${i}`] = makePlayer({ id: `x${i}`, handle: h.toUpperCase() });
    }
    for (let i = 0; i < 50; i++) {
      const h = generateHandle(s, 'CN');
      expect(Object.values(s.players).some((p) => p.handle.toLowerCase() === h.toLowerCase())).toBe(false);
    }
  });
});

describe('generation: 等级与 mmr', () => {
  it('randomTier 遵守权重（0 权重不出现）', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 300; i++) {
      const t = randomTier(rng, { C: 0, B: 0, A: 1, S: 1, SS: 0, SSR: 0 });
      expect(['A', 'S']).toContain(t);
    }
  });

  it('mmrForTier 落在对应等级内', () => {
    const rng = seededRng(7);
    for (const t of TIERS) {
      for (let i = 0; i < 200; i++) {
        const m = mmrForTier(rng, t);
        expect(tierOf(m)).toBe(t);
        expect(m).toBeGreaterThanOrEqual(CONFIG.ladder.minMmr);
        expect(m).toBeLessThanOrEqual(CONFIG.ladder.maxMmr);
      }
    }
  });

  it('tierForPower', () => {
    expect(tierForPower(50)).toBe('C');
    expect(tierForPower(72)).toBe('S');
    expect(tierForPower(92)).toBe('SSR');
  });
});

describe('generation: 选手/教练', () => {
  it('generatePlayer：按等级生成并注册为自由选手', () => {
    const s = makeTestState(0, 5);
    for (const tier of TIERS) {
      const p = generatePlayer(s, { tier, position: 'M', region: 'CIS' });
      expect(s.players[p.id]).toBe(p);
      expect(playerTier(p)).toBe(tier);
      expect(p.position).toBe('M');
      expect(p.region).toBe('CIS');
      expect(regionOfNationality(p.nationality)).toBe('CIS');
      expect(p.teamId).toBeNull();
      expect(p.isReal).toBe(false);
      expect(p.status).toBe('active');
      expect(p.salary).toBeGreaterThanOrEqual(CONFIG.economy.minSalary);
      const [lo, hi] = CONFIG.generation.powerByTier[tier];
      expect(p.power).toBeGreaterThan(lo - 10);
      expect(p.power).toBeLessThan(hi + 10);
      for (const k of ['talent', 'resilience', 'insight', 'loyalty'] as const) {
        expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(p[k]).toBeLessThanOrEqual(100);
      }
    }
  });

  it('rookie：年龄 16-20、新人工资、标记 isRookie', () => {
    const s = makeTestState(0, 6);
    let talentSum = 0;
    for (let i = 0; i < 40; i++) {
      const p = generatePlayer(s, { rookie: true, tier: 'A' });
      const age = ageOf(s, p);
      expect(age).toBeGreaterThanOrEqual(16);
      expect(age).toBeLessThanOrEqual(20);
      expect(p.isRookie).toBe(true);
      talentSum += p.talent;
    }
    expect(talentSum / 40).toBeGreaterThan(55);
  });

  it('国籍池与赛区一致', () => {
    for (const r of REGIONS) {
      for (const [cc] of NATIONALITY_POOLS[r]) expect(regionOfNationality(cc)).toBe(r);
    }
  });

  it('generateCoach：boost 在等级基准 ±30% 内', () => {
    const s = makeTestState(0, 8);
    for (const tier of TIERS) {
      const c = generateCoach(s, { tier, region: 'EU' });
      expect(s.coaches[c.id]).toBe(c);
      expect(c.teamId).toBeNull();
      const base = CONFIG.coach.boostByTier[tier];
      expect(c.talentBoost).toBeGreaterThanOrEqual(base * 0.7 - 0.01);
      expect(c.talentBoost).toBeLessThanOrEqual(Math.min(10, base * 1.3) + 0.01);
      expect(c.salary).toBeGreaterThan(0);
    }
  });
});

describe('generation: AI 战队', () => {
  it('5 个位置不同的首发 + 等级符合强度档', () => {
    const s = makeTestState(0, 11);
    const allowed: Record<'weak' | 'mid' | 'strong', Tier[]> = { weak: ['B', 'A'], mid: ['A', 'S'], strong: ['S', 'SS'] };
    for (const strength of ['weak', 'mid', 'strong'] as const) {
      for (const region of REGIONS) {
        const t = generateAiTeam(s, region, strength);
        expect(s.teams[t.id]).toBe(t);
        expect(t.region).toBe(region);
        expect(t.isPlayer).toBe(false);
        expect(validateLineup(s, t.id)).toEqual([]);
        expect(t.playerIds.length).toBeGreaterThanOrEqual(5);
        expect(t.playerIds.length).toBeLessThanOrEqual(6);
        const starters = POSITIONS.map((pos) => s.players[t.lineup[pos]!]);
        expect(new Set(starters.map((p) => p.position)).size).toBe(5);
        for (const p of starters) {
          expect(allowed[strength]).toContain(playerTier(p));
          expect(p.teamId).toBe(t.id);
          expect(p.region).toBe(region);
        }
        const [hLo, hHi] = CONFIG.generation.aiTeam.honor[strength];
        expect(t.honor).toBeGreaterThanOrEqual(hLo);
        expect(t.honor).toBeLessThanOrEqual(hHi);
        if (t.coachId) expect(s.coaches[t.coachId].teamId).toBe(t.id);
      }
    }
    const names = Object.values(s.teams).map((t) => t.name);
    const tags = Object.values(s.teams).map((t) => t.tag);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('大量生成战队名仍唯一', () => {
    const s = makeTestState(0, 12);
    for (let i = 0; i < 60; i++) {
      const { name, tag } = generateTeamName(s, 'CN');
      s.teams[`x${i}`] = {
        id: `x${i}`, name, tag, region: 'CN', color: '#fff', honor: 100, gold: 0, isPlayer: false, playerIds: [],
        lineup: { C: null, M: null, O: null, SS: null, HS: null }, coachId: null, points: 0,
      };
    }
    const names = Object.values(s.teams).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('确定性：同一种子结果一致', () => {
    const a = makeTestState(0, 77);
    const b = makeTestState(0, 77);
    const ta = generateAiTeam(a, 'SEA', 'mid');
    const tb = generateAiTeam(b, 'SEA', 'mid');
    expect(ta.name).toBe(tb.name);
    expect(ta.playerIds.map((id) => a.players[id].handle)).toEqual(tb.playerIds.map((id) => b.players[id].handle));
  });
});

describe('generation: 种子数据', () => {
  it('playerFromSeed：复制字段、赛区、工资、合同', () => {
    const s = makeTestState(1);
    const p = playerFromSeed(s, seedPlayer('miracle-x', 'C', { nationality: 'jo', name: 'Amer' }), 't0');
    expect(s.players['miracle-x']).toBe(p);
    expect(p.isReal).toBe(true);
    expect(p.region).toBe('EU');
    expect(p.nationality).toBe('JO');
    expect(p.name).toBe('Amer');
    expect(p.contractUntil).toBeGreaterThanOrEqual(9);
    expect(p.contractUntil).toBeLessThanOrEqual(11);
    expect(p.stats).toEqual({ matches: 0, wins: 0, titles: 0, tiTitles: 0, mvp: 0 });
    expect(p.salary).toBeGreaterThan(0);
    expect(s.teams.t0.playerIds).toContain('miracle-x');
    // 重复注册返回已有选手
    expect(playerFromSeed(s, seedPlayer('miracle-x', 'M'), null)).toBe(p);
  });

  it('teamFromSeed：按位置排首发、其余替补、教练', () => {
    const s = makeTestState(0);
    const seed: SeedTeam = {
      id: 'team-test', name: 'Team Test', tag: 'TT', region: 'CIS', honor: 800, funds: 1_000_000, atTI: true,
      coach: { id: 'coach-x', name: 'Coach X', nationality: 'RU', birthYear: 1985, tier: 'S', insight: 85 },
      players: [
        seedPlayer('a', 'C'), seedPlayer('b', 'M'), seedPlayer('c', 'O'), seedPlayer('d', 'SS'), seedPlayer('e', 'HS'),
        seedPlayer('f', 'M', { power: 99 }),
      ],
    };
    const t = teamFromSeed(s, seed, true);
    expect(t.isPlayer).toBe(true);
    expect(t.lineup).toEqual({ C: 'a', M: 'b', O: 'c', SS: 'd', HS: 'e' });
    expect(t.playerIds).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(t.coachId).toBe('coach-x');
    expect(s.coaches['coach-x'].teamId).toBe('team-test');
    expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(t.color).toBe(colorFromId('team-test'));
    expect(t.gold).toBe(1_000_000);
  });

  it('teamFromSeed：位置冲突时回退 autoLineup', () => {
    const s = makeTestState(0);
    const seed: SeedTeam = {
      id: 'dup', name: 'Dup', tag: 'DUP', region: 'EU', honor: 100, funds: 0, atTI: false,
      players: [seedPlayer('a1', 'C'), seedPlayer('a2', 'C'), seedPlayer('a3', 'O'), seedPlayer('a4', 'SS'), seedPlayer('a5', 'HS')],
    };
    const t = teamFromSeed(s, seed, false);
    expect(Object.values(t.lineup).every(Boolean)).toBe(true);
    expect(new Set(Object.values(t.lineup)).size).toBe(5);
  });

  it('coachFromSeed：boost 按等级', () => {
    const s = makeTestState(0);
    const c = coachFromSeed(s, { id: 'cc', name: 'CC', nationality: 'cn', birthYear: 1980, tier: 'SSR', insight: 95 }, null);
    expect(c.teamId).toBeNull();
    expect(c.insight).toBe(95);
    expect(c.talentBoost).toBeGreaterThan(5);
  });

  it('rookieFromIndex：战力折扣、天赋≈峰值、mmr 低一档', () => {
    const s = makeTestState(0, 21);
    const entry: PlayerIndexEntry = {
      id: 'future-star', handle: 'FutureStar', nationality: 'PE', birthYear: 2002, firstTi: 10, position: 'M',
      firstPower: 80, peakPower: 92, peakTalent: 90, insight: 70, signatureHeroes: ['storm-spirit'],
    };
    const p = rookieFromIndex(s, entry);
    expect(s.players['future-star']).toBe(p);
    expect(p.isReal).toBe(true);
    expect(p.isRookie).toBe(true);
    expect(p.teamId).toBeNull();
    expect(p.region).toBe('SA');
    expect(p.power).toBeGreaterThanOrEqual(80 * 0.88 - 0.01);
    expect(p.power).toBeLessThanOrEqual(80 * 0.95 + 0.01);
    expect(Math.abs(p.talent - 90)).toBeLessThan(10);
    expect(tierIndex(playerTier(p))).toBe(tierIndex(tierForPower(80)) - 1);
    expect(p.signatureHeroes).toEqual(['storm-spirit']);
    expect(rookieFromIndex(s, entry)).toBe(p);
  });

  it('coachFromRetiredPlayer：等级=退役时等级，灵性继承', () => {
    const s = makeTestState(0);
    const p = makePlayer({ id: 'vet', handle: 'Vet', mmr: 12000, insight: 88, birthYear: 1985 });
    s.players.vet = p;
    const c = coachFromRetiredPlayer(s, p);
    expect(c.tier).toBe('SS');
    expect(c.insight).toBe(88);
    expect(c.name).toBe('Vet');
    expect(c.formerPlayerId).toBe('vet');
    expect(s.coaches[c.id]).toBe(c);
    const base = CONFIG.coach.boostByTier.SS;
    expect(c.resilienceBoost).toBeGreaterThanOrEqual(base * 0.7 - 0.01);
    expect(c.resilienceBoost).toBeLessThanOrEqual(Math.min(10, base * 1.3) + 0.01);
    expect(c.salary).toBe(CONFIG.coach.salaryByTier.SS); // 2019 经济指数 1
    // 再次转化不冲突
    const c2 = coachFromRetiredPlayer(s, p);
    expect(c2.id).not.toBe(c.id);
  });
});

describe('generation: 新建俱乐部', () => {
  it('新俱乐部始终有 5 名位置各不相同的合法首发（多起点 × 多种子 × 难度）', async () => {
    registerNodeRosterLoader();
    for (const startTi of [1, 9, 15, 16]) {
      for (let seed = 1; seed <= 4; seed++) {
        for (const difficulty of ['easy', 'normal', 'hard'] as const) {
          const g = await createNewGame({
            startTi, seasons: 1, difficulty, managerName: 'T', seed: seed * 97 + startTi,
            newClub: { name: 'Gen Test', tag: 'GT', region: REGIONS[seed % REGIONS.length], color: '#123456' },
          });
          const team = g.teams[g.settings.playerTeamId];
          expect(validateLineup(g, team.id)).toEqual([]);
          const starters = POSITIONS.map((pos) => g.players[team.lineup[pos]!]);
          for (const [i, p] of starters.entries()) {
            expect(p.position).toBe(POSITIONS[i]);
            expect(p.teamId).toBe(team.id);
            expect(p.status).toBe('active');
          }
          const aCount = CONFIG.season.newClubATierCount[difficulty];
          expect(starters.filter((p) => playerTier(p) === 'A')).toHaveLength(aCount);
          // 开局礼包是若干次单抽的资金，次数不超过阵容空位（第六波：开局十连导致超编）
          const grant = g.finance.find((f) => f.category === 'event' && f.note.includes('创立礼包'));
          if (grant) {
            const pulls = Math.round(grant.amount / CONFIG.gacha.singleCost);
            expect(pulls * CONFIG.gacha.singleCost).toBe(grant.amount);
            expect(pulls).toBeLessThanOrEqual(CONFIG.team.maxRoster - team.playerIds.length);
          }
          expect(team.playerIds.length).toBeLessThanOrEqual(CONFIG.team.maxRoster);
        }
      }
    }
  });
});
