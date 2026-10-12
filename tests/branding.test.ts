// 第十波 #4 俱乐部品牌变迁（src/engine/branding.ts + src/data/branding.json）与风格化队徽（src/ui/emblem.ts）
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Team } from '../src/engine/types';
import {
  applySeasonBranding, brandColor2For, brandEraAt, brandHistoryOf, brandNewsTitle, brandOrgOf, brandOrgs, brandingProblems,
  sameOrgTeamIds,
} from '../src/engine/branding';
import { CONFIG } from '../src/engine/config';
import { createNewGame } from '../src/engine/game';
import { startSeason } from '../src/engine/season';
import {
  EMBLEM_MOTIFS, EMBLEM_SHAPES, emblemHash, emblemInitials, emblemSpec, localLogoKeys, luminance, mixHex,
} from '../src/ui/emblem';
import { readRosterSync, registerNodeRosterLoader } from '../scripts/nodeData';
import { addTeam, makeTestState } from './helpers';

beforeAll(() => {
  registerNodeRosterLoader();
});

/** 测试状态：startTi 开局、当前处于 ti 赛季 */
function stateAt(startTi: number, ti: number): GameState {
  const s = makeTestState(2);
  s.settings.startTi = startTi;
  s.settings.endTi = Math.max(ti, startTi) + 2;
  s.season.ti = ti;
  return s;
}

function realTeam(s: GameState, id: string, name: string, tag: string, color: string): Team {
  const t = addTeam(s, id);
  t.name = name;
  t.tag = tag;
  t.color = color;
  return t;
}

const brandNews = (s: GameState) => s.news.filter((n) => n.title.startsWith('【品牌更新】'));

describe('branding.json 数据', () => {
  it('结构合法（brandingProblems 为空）', () => {
    expect(brandingProblems()).toEqual([]);
    expect(brandOrgs().length).toBeGreaterThanOrEqual(10);
  });

  it('teamIds 都是 roster 数据中真实存在的战队 id', () => {
    const known = new Set<string>();
    for (let ti = 1; ti <= 15; ti++) for (const t of readRosterSync(ti).teams) known.add(t.id);
    const missing = brandOrgs().flatMap((o) => o.teamIds).filter((id) => !known.has(id));
    expect(missing).toEqual([]);
  });

  it('换届时期在 roster 中出现的那一届，名称与阵容数据一致（数据口径：fromTi = 新品牌首次在 TI 上使用的届次）', () => {
    // 已知阵容数据与品牌数据口径不同的届次（以品牌数据为准，开局时静默对齐）
    const known = new Set(['nigma@10', 'navi@10', 'tsm@11']);
    const bad: string[] = [];
    for (const org of brandOrgs()) {
      for (const era of org.eras) {
        if (era.fromTi > 15 || known.has(`${org.id}@${era.fromTi}`)) continue;
        const t = readRosterSync(era.fromTi).teams.find((x) => org.teamIds.includes(x.id));
        if (t && t.name !== era.name) bad.push(`${org.id}@TI${era.fromTi}: roster「${t.name}」≠「${era.name}」`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('LGD ↔ PSG.LGD：同一组织、按届次的品牌', () => {
    expect(sameOrgTeamIds('psg-lgd').sort()).toEqual(['lgd-gaming', 'psg-lgd']);
    expect(sameOrgTeamIds('og')).toEqual(['og']);
    expect(brandOrgOf('lgd-gaming')?.id).toBe('lgd');
    expect(brandEraAt('lgd-gaming', 7)?.name).toBe('LGD Gaming');
    expect(brandEraAt('psg-lgd', 8)?.name).toBe('PSG.LGD');
    expect(brandEraAt('psg-lgd', 11)?.tag).toBe('PSG.LGD');
    expect(brandEraAt('psg-lgd', 12)?.name).toBe('LGD Gaming');
    expect(brandEraAt('natus-vincere', 9)?.tag).toBe("Na'Vi");
    expect(brandEraAt('natus-vincere', 10)?.tag).toBe('NAVI');
    expect(brandEraAt('team-nigma', 9)).toBeNull();
    expect(brandEraAt('og', 9)).toBeNull();
    // TI15 的中性名称只用于 TI15
    expect(brandEraAt('betboom-team', 15)?.name).toBe('BoomBoys');
    expect(brandEraAt('betboom-team', 16)?.name).toBe('BetBoom Team');
  });

  it('队徽辅色：按简称 + 主色查品牌数据', () => {
    expect(brandColor2For('PSG.LGD', '#004170')).toBe('#DA291C');
    expect(brandColor2For('psg.lgd', '#004170')).toBe('#DA291C');
    expect(brandColor2For('PSG.LGD', '#C8102E')).toBeUndefined();
    expect(brandColor2For('OG', '#3AA0FF')).toBeUndefined();
  });
});

describe('applySeasonBranding', () => {
  it('开局赛季：已是当届品牌时不变；与品牌数据不一致时静默对齐名称 / 简称（不改配色、不发新闻、不记沿革）', () => {
    const s = stateAt(9, 9);
    const lgd = realTeam(s, 'psg-lgd', 'PSG.LGD', 'PSG.LGD', '#C8102E');
    expect(applySeasonBranding(s)).toEqual([]);
    expect(lgd.name).toBe('PSG.LGD');

    const s2 = stateAt(11, 11);
    const ngx = realTeam(s2, 'nigma-galaxy', 'Nigma Galaxy', 'Nigma', '#6D2077');
    const ups = applySeasonBranding(s2);
    expect(ups).toHaveLength(1);
    expect(ups[0].announced).toBe(false);
    expect(ngx.tag).toBe('NGX');
    expect(ngx.color).toBe('#6D2077');
    expect(brandNews(s2)).toHaveLength(0);
    expect(ngx.brandHistory).toBeUndefined();
  });

  it('换届：LGD Gaming → PSG.LGD（TI8，换 PSG 配色）→ LGD Gaming（TI12），发新闻并记入沿革', () => {
    const s = stateAt(7, 8);
    const lgd = realTeam(s, 'lgd-gaming', 'LGD Gaming', 'LGD', '#F05A28');
    const rng0 = s.rngState;
    const ups = applySeasonBranding(s);
    expect(ups).toHaveLength(1);
    expect(lgd.name).toBe('PSG.LGD');
    expect(lgd.tag).toBe('PSG.LGD');
    expect(lgd.color).toBe('#004170');
    expect(s.rngState).toBe(rng0); // 不消耗随机数
    const news = brandNews(s);
    expect(news.map((n) => n.title)).toEqual(['【品牌更新】LGD Gaming 更名为 PSG.LGD']);
    expect(news[0].teamIds).toEqual(['lgd-gaming']);
    expect(news[0].body).toContain('巴黎圣日耳曼');
    expect(brandHistoryOf(s, 'lgd-gaming')).toEqual([
      expect.objectContaining({ season: 8, from: { name: 'LGD Gaming', tag: 'LGD', color: '#F05A28' }, to: { name: 'PSG.LGD', tag: 'PSG.LGD', color: '#004170' } }),
    ]);

    // 同一赛季再次调用：幂等
    expect(applySeasonBranding(s)).toEqual([]);
    expect(brandNews(s)).toHaveLength(1);

    // 中间赛季无变化
    s.season.ti = 9;
    expect(applySeasonBranding(s)).toEqual([]);

    s.season.ti = 12;
    applySeasonBranding(s);
    expect(lgd.name).toBe('LGD Gaming');
    expect(lgd.tag).toBe('LGD');
    expect(lgd.color).toBe('#F05A28');
    expect(brandNews(s)[0].title).toBe('【品牌更新】PSG.LGD 更名为 LGD Gaming');
    expect(brandHistoryOf(s, 'lgd-gaming').map((c) => c.season)).toEqual([8, 12]);
  });

  it('只换简称 / 配色：「启用新视觉」', () => {
    const s = stateAt(9, 10);
    const navi = realTeam(s, 'natus-vincere', 'Natus Vincere', "Na'Vi", '#FFE600');
    applySeasonBranding(s);
    expect(navi.tag).toBe('NAVI');
    expect(navi.name).toBe('Natus Vincere');
    const n = brandNews(s);
    expect(n.map((x) => x.title)).toEqual(['【品牌更新】Natus Vincere 启用新视觉']);
    expect(n[0].body).toContain("简称 Na'Vi → NAVI");
    expect(n[0].important).toBe(CONFIG.branding.visualNewsImportant);
  });

  it('非换届赛季的数据对齐（如旧存档 / 中途加入）：对齐名称 / 简称并发新闻，但不改配色', () => {
    const s = stateAt(9, 11);
    const navi = realTeam(s, 'natus-vincere', 'Natus Vincere', "Na'Vi", '#ABCDEF');
    applySeasonBranding(s);
    expect(navi.tag).toBe('NAVI');
    expect(navi.color).toBe('#ABCDEF');
    expect(brandNews(s)).toHaveLength(1);
  });

  it('已解散 / 除名的俱乐部不更新；本赛季刚成立的俱乐部只静默对齐', () => {
    const s = stateAt(7, 8);
    const lgd = realTeam(s, 'lgd-gaming', 'LGD Gaming', 'LGD', '#F05A28');
    lgd.disbanded = true;
    const tnc = realTeam(s, 'tnc-pro-team', 'TNC Pro Team', 'TNC', '#F4B400');
    (tnc as Team & { founded?: { ti: number; kind: 'real' } }).founded = { ti: 8, kind: 'real' };
    applySeasonBranding(s);
    expect(lgd.name).toBe('LGD Gaming');
    expect(tnc.name).toBe('TNC Predator');
    expect(brandNews(s)).toHaveLength(0);
    expect(tnc.brandHistory).toBeUndefined();
  });

  it('新闻标题格式', () => {
    const c = { season: 8, from: { name: 'A', tag: 'A', color: '#000000' }, to: { name: 'B', tag: 'B', color: '#000000' } };
    expect(brandNewsTitle(c)).toBe('【品牌更新】A 更名为 B');
    expect(brandNewsTitle({ ...c, to: { name: 'A', tag: 'AA', color: '#111111' } })).toBe('【品牌更新】A 启用新视觉');
  });

  it('关闭总开关时不做任何改动', () => {
    const s = stateAt(7, 8);
    const lgd = realTeam(s, 'lgd-gaming', 'LGD Gaming', 'LGD', '#F05A28');
    const cfg = CONFIG.branding as { enabled: boolean };
    cfg.enabled = false;
    try {
      expect(applySeasonBranding(s)).toEqual([]);
      expect(lgd.name).toBe('LGD Gaming');
    } finally {
      cfg.enabled = true;
    }
  });
});

describe('整局：开局对齐 + 下一赛季换届', () => {
  it('TI10 开局：Team Nigma 静默对齐为 Nigma Galaxy；进入 TI11 赛季时 Team Undying / Quincy Crew / Thunder Predator 按真实历史更名', async () => {
    const g = await createNewGame({ startTi: 10, seasons: 3, difficulty: 'normal', managerName: 'T', teamId: 'og', seed: 7 });
    if (g.teams['team-nigma'] && !g.teams['team-nigma'].disbanded) {
      expect(g.teams['team-nigma'].name).toBe('Nigma Galaxy');
      expect(g.teams['team-nigma'].tag).toBe('NGX');
    }
    expect(g.teams['natus-vincere']?.tag).toBe('NAVI');
    expect(brandNews(g)).toHaveLength(0);

    const before = {
      'team-undying': 'TSM FTX',
      'quincy-crew': 'Soniqs',
      'thunder-predator': 'Thunder Awaken',
    } as const;
    startSeason(g, 11);
    let renamed = 0;
    for (const [id, name] of Object.entries(before)) {
      const t = g.teams[id];
      if (!t || t.disbanded) continue;
      expect(t.name).toBe(name);
      expect(brandHistoryOf(g, id).at(-1)?.season).toBe(11);
      renamed++;
    }
    expect(renamed).toBeGreaterThan(0);
    expect(brandNews(g).length).toBeGreaterThanOrEqual(renamed);
    // 有配色变化的换届（Thunder Awaken）套用品牌主色
    const ta = g.teams['thunder-predator'];
    if (ta && !ta.disbanded) expect(ta.color).toBe('#F5C518');
  }, 30_000);
});

describe('新俱乐部涌现 × 品牌变迁', () => {
  it('赛季中途成立的真实俱乐部以当届品牌成立（TI10 的 Nigma：阵容数据写作 Team Nigma，品牌数据为 Nigma Galaxy），下个赛季不再补发品牌更新', async () => {
    const c = CONFIG.clubs as { maxRealPerSeason: number; maxTeams: number };
    const saved = { maxRealPerSeason: c.maxRealPerSeason, maxTeams: c.maxTeams };
    c.maxRealPerSeason = 40; // 让 TI10 首次出现的真实组织全部成立
    c.maxTeams = 90;
    try {
      const g = await createNewGame({ startTi: 9, seasons: 4, difficulty: 'normal', managerName: 'T', teamId: 'og', seed: 3 });
      startSeason(g, 10);
      const n = g.teams['team-nigma'];
      expect(n?.founded?.ti).toBe(10);
      expect(n?.name).toBe('Nigma Galaxy');
      expect(n?.tag).toBe('NGX');
      expect(g.news.some((x) => x.title === '【新战队】Nigma Galaxy 成立')).toBe(true);
      startSeason(g, 11);
      expect(brandNews(g).filter((x) => x.teamIds?.includes('team-nigma'))).toHaveLength(0);
      expect(n?.brandHistory).toBeUndefined();
    } finally {
      Object.assign(c, saved);
    }
  }, 60_000);
});

describe('风格化队徽（src/ui/emblem.ts）', () => {
  it('确定性：同一简称 + 配色得到同一规格；字段合法', () => {
    const a = emblemSpec('PSG.LGD', '#004170', '#DA291C');
    const b = emblemSpec('PSG.LGD', '#004170', '#DA291C');
    expect(a).toEqual(b);
    expect(EMBLEM_SHAPES).toContain(a.shape);
    expect(EMBLEM_MOTIFS).toContain(a.motif);
    for (const c of [a.fill, a.fill2, a.ring, a.text]) expect(c).toMatch(/^#[0-9A-F]{6}$/);
    expect(a.fill2).toBe('#DA291C');
    expect(a.outline.startsWith('M')).toBe(true);
    expect(emblemHash('OG')).toBe(emblemHash('OG'));
  });

  it('换品牌（简称 / 配色变化）→ 队徽变化；外形随简称分布在多种形状', () => {
    const old = emblemSpec('LGD', '#F05A28');
    const neu = emblemSpec('PSG.LGD', '#004170', '#DA291C');
    expect(old.initials).not.toBe(neu.initials);
    expect(old.fill).not.toBe(neu.fill);
    const tags = ['OG', 'Liquid', 'Secret', 'EG', 'VP', 'TSpirit', 'Tundra', 'NAVI', 'iG', 'LGD', 'VG', 'Newbee', 'Alliance', 'fnatic', 'C9', 'DK'];
    const shapes = new Set(tags.map((t) => emblemSpec(t, '#336699').shape));
    expect(shapes.size).toBeGreaterThanOrEqual(4);
  });

  it('首字母规则', () => {
    expect(emblemInitials('OG')).toBe('OG');
    expect(emblemInitials('iG')).toBe('iG');
    expect(emblemInitials('bc')).toBe('BC');
    expect(emblemInitials('LGD')).toBe('LGD');
    expect(emblemInitials('PSG.LGD')).toBe('PL');
    expect(emblemInitials("Na'Vi")).toBe('NV');
    expect(emblemInitials('TSpirit')).toBe('TS');
    expect(emblemInitials('NAVI')).toBe('N');
    expect(emblemInitials('Liquid')).toBe('L');
    expect(emblemInitials('[A]')).toBe('A');
    expect(emblemInitials('')).toBe('?');
  });

  it('文字颜色随主色明暗；深色主色用亮描边', () => {
    expect(emblemSpec('Secret', '#C0C0C0').text).toBe('#111317');
    expect(emblemSpec('Secret', '#1B1B1B').text).toBe('#FFFFFF');
    expect(luminance(emblemSpec('BLCK', '#111111').ring)).toBeGreaterThan(luminance('#111111'));
    expect(emblemSpec('x', 'not-a-color').fill).toBe('#8B96AB');
    expect(mixHex('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('本地队标文件键：{id}.{简称} 优先于 {id}', () => {
    expect(localLogoKeys('lgd-gaming', 'PSG.LGD')).toEqual(['lgd-gaming.psglgd', 'lgd-gaming']);
    expect(localLogoKeys('og', '')).toEqual(['og']);
    expect(localLogoKeys(null, 'OG')).toEqual([]);
  });
});
