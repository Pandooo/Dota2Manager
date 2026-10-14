// 更新说明与 New 徽标（src/ui/changelog.ts）：数据合法性、版本比较、已读 / 徽标纯函数、持久化小仓库
import { describe, expect, it } from 'vitest';
import pkg from '../package.json';
import {
  APP_VERSION, CHANGELOG, CHANGELOG_SEEN_KEY, DISMISSED_MAX, EMPTY_CHANGELOG_STATE, FEATURES, LATEST_VERSION, NEWBADGE_DISMISSED_KEY,
  changelogProblems, compareVersions, createChangelogStore, featureIsNew, hasUnread, isValidDate, isValidVersion, newFeatureKeys,
  normalizeVersion, parseDismissed, parseSeen, versionIsNew, withDismissed, withSeen, type ChangelogVersion, type FeatureDef,
} from '../src/ui/changelog';

describe('更新说明数据', () => {
  it('数据合法（版本倒序、无重复、日期格式、功能引用）', () => {
    expect(changelogProblems()).toEqual([]);
  });

  it('版本倒序且互不重复，日期为 YYYY-MM-DD', () => {
    const versions = CHANGELOG.map((v) => v.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < CHANGELOG.length; i++) expect(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)).toBe(1);
    for (const v of CHANGELOG) {
      expect(isValidVersion(v.version)).toBe(true);
      expect(isValidDate(v.date)).toBe(true);
      expect(v.items.length).toBeGreaterThan(0);
    }
  });

  it('功能表：key 唯一、版本存在于更新说明；条目引用的功能存在且版本一致', () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const versions = new Set(CHANGELOG.map((v) => v.version));
    for (const f of FEATURES) expect(versions.has(f.version)).toBe(true);
    for (const v of CHANGELOG) {
      for (const it of v.items) {
        if (!it.feature) continue;
        const f = FEATURES.find((x) => x.key === it.feature);
        expect(f, `v${v.version} 引用的功能「${it.feature}」应在功能表中`).toBeTruthy();
        expect(f!.version).toBe(v.version);
      }
    }
  });

  it('每个功能都在对应版本的更新条目中出现（面板里能找到「入口」说明）', () => {
    for (const f of FEATURES) {
      const v = CHANGELOG.find((x) => x.version === f.version)!;
      expect(v.items.some((it) => it.feature === f.key), `功能「${f.key}」应在 v${f.version} 的条目中引用`).toBe(true);
    }
  });

  it('最新版本与 package.json 的 version 一致（发版时同步）', () => {
    expect(LATEST_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('各版本应有的功能徽标：v0.3.0 交易 / 赛事报名 / 荣誉势头 / 新秀抽卡 / 名人堂 / 在线人数，v0.2.1 副位置，v0.2 挂牌 / 使命 / 羁绊 / 背景音乐 / 奖金分成', () => {
    const byKey = Object.fromEntries(FEATURES.map((f) => [f.key, f.version]));
    expect(byKey).toMatchObject({
      trade: '0.3.0', seasonEntry: '0.3.0', momentum: '0.3.0', gacha: '0.3.0', hallOfFame: '0.3.0', onlineStats: '0.3.0',
      altPositions: '0.2.1', listing: '0.2', missions: '0.2', synergies: '0.2', bgm: '0.2', prizeShare: '0.2',
    });
  });

  it('changelogProblems 能发现常见错误', () => {
    const base: ChangelogVersion[] = [
      { version: '0.3', date: '2026-11-01', items: [{ text: 'a' }] },
      { version: '0.2', date: '2026-10-12', items: [{ text: 'b' }] },
    ];
    const feats: FeatureDef[] = [{ key: 'x', version: '0.3', label: '入口' }];
    expect(changelogProblems(base, feats)).toEqual([]);
    // 顺序错误
    expect(changelogProblems([base[1], base[0]], feats).some((p) => p.includes('倒序'))).toBe(true);
    // 重复版本
    expect(changelogProblems([base[0], { ...base[0] }], feats).some((p) => p.includes('重复'))).toBe(true);
    // 日期格式
    expect(changelogProblems([{ ...base[0], date: '2026/11/01' }, base[1]], feats).some((p) => p.includes('日期'))).toBe(true);
    expect(changelogProblems([{ ...base[0], date: '2026-13-01' }, base[1]], feats).some((p) => p.includes('日期'))).toBe(true);
    // 引用不存在的功能
    expect(
      changelogProblems([{ ...base[0], items: [{ text: 'a', feature: 'nope' as never }] }, base[1]], feats).some((p) => p.includes('不存在的功能')),
    ).toBe(true);
    // 功能版本与条目版本不一致
    expect(
      changelogProblems([base[0], { ...base[1], items: [{ text: 'b', feature: 'x' as never }] }], feats).some((p) => p.includes('功能表中的版本')),
    ).toBe(true);
    // 功能版本不在更新说明中
    expect(changelogProblems(base, [{ key: 'y', version: '9.9', label: 'l' }]).some((p) => p.includes('不在更新说明中'))).toBe(true);
    // 功能 key 重复
    expect(changelogProblems(base, [feats[0], { ...feats[0] }]).some((p) => p.includes('key 重复'))).toBe(true);
  });
});

describe('版本比较', () => {
  it('按分段数值比较，缺段补 0，忽略前导 v', () => {
    expect(compareVersions('0.2', '0.2.1')).toBe(-1);
    expect(compareVersions('0.2.1', '0.2')).toBe(1);
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('0.10', '0.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('v0.2.1', '0.2.1')).toBe(0);
    expect(compareVersions('0.2.1', ' 0.2.1 ')).toBe(0);
    expect(normalizeVersion(' V0.3 ')).toBe('0.3');
  });

  it('版本号 / 日期格式判断', () => {
    expect(isValidVersion('0.2.1')).toBe(true);
    expect(isValidVersion('1.0')).toBe(true);
    expect(isValidVersion('v0.2')).toBe(false);
    expect(isValidVersion('1')).toBe(false);
    expect(isValidVersion('0.2.1.0.0')).toBe(false);
    expect(isValidDate('2026-10-13')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-10-1')).toBe(false);
  });
});

describe('已读 / 徽标（纯函数）', () => {
  const feats: FeatureDef[] = [
    { key: 'a', version: '0.2.1', label: 'A' },
    { key: 'b', version: '0.2', label: 'B' },
    { key: 'c', version: '0.1', label: 'C' },
  ];

  it('从未标记已读 → 有未读；已读最新 → 无未读；已读更高版本也不算未读', () => {
    expect(hasUnread(null, '0.2.1')).toBe(true);
    expect(hasUnread('0.2', '0.2.1')).toBe(true);
    expect(hasUnread('0.2.1', '0.2.1')).toBe(false);
    expect(hasUnread('0.3', '0.2.1')).toBe(false);
    expect(hasUnread(null)).toBe(true);
    expect(hasUnread(LATEST_VERSION)).toBe(false);
  });

  it('徽标：功能版本高于已读版本且未被单独关闭时显示', () => {
    expect(featureIsNew('a', EMPTY_CHANGELOG_STATE, feats)).toBe(true);
    expect(featureIsNew('c', EMPTY_CHANGELOG_STATE, feats)).toBe(true);
    expect(featureIsNew('a', { seen: '0.2', dismissed: [] }, feats)).toBe(true);
    expect(featureIsNew('b', { seen: '0.2', dismissed: [] }, feats)).toBe(false);
    expect(featureIsNew('a', { seen: '0.2.1', dismissed: [] }, feats)).toBe(false);
    expect(featureIsNew('a', { seen: null, dismissed: ['a'] }, feats)).toBe(false);
    expect(featureIsNew('unknown', EMPTY_CHANGELOG_STATE, feats)).toBe(false);
    expect(newFeatureKeys({ seen: '0.1', dismissed: ['b'] }, feats)).toEqual(['a']);
    expect(versionIsNew('0.2.1', '0.2')).toBe(true);
    expect(versionIsNew('0.2', '0.2')).toBe(false);
  });

  it('withSeen 只往前走；withDismissed 去重并有上限', () => {
    const s1 = withSeen(EMPTY_CHANGELOG_STATE, 'v0.2');
    expect(s1.seen).toBe('0.2');
    expect(withSeen(s1, '0.1').seen).toBe('0.2');
    expect(withSeen(s1, '0.2.1').seen).toBe('0.2.1');
    expect(withSeen(s1, '')).toBe(s1);
    const d1 = withDismissed(EMPTY_CHANGELOG_STATE, 'a');
    expect(d1.dismissed).toEqual(['a']);
    expect(withDismissed(d1, 'a')).toBe(d1);
    expect(withDismissed(d1, '')).toBe(d1);
    let s = EMPTY_CHANGELOG_STATE;
    for (let i = 0; i < DISMISSED_MAX + 5; i++) s = withDismissed(s, `k${i}`);
    expect(s.dismissed.length).toBe(DISMISSED_MAX);
    expect(s.dismissed[0]).toBe('k5');
    expect(s.dismissed.at(-1)).toBe(`k${DISMISSED_MAX + 4}`);
  });

  it('解析存储内容：损坏 / 非法 → 空', () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed('not json')).toEqual([]);
    expect(parseDismissed('{"a":1}')).toEqual([]);
    expect(parseDismissed('["a", 1, "b"]')).toEqual(['a', 'b']);
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen('garbage')).toBeNull();
    expect(parseSeen('v0.2.1')).toBe('0.2.1');
  });
});

describe('持久化小仓库', () => {
  function memStorage(init: Record<string, string> = {}) {
    const m = new Map(Object.entries(init));
    return {
      map: m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        m.set(k, v);
      },
    };
  }

  it('读取已有记录，标为已读 / 关闭徽标会写回并通知订阅者', () => {
    const st = memStorage({ [CHANGELOG_SEEN_KEY]: '0.1', [NEWBADGE_DISMISSED_KEY]: '["bgm"]' });
    const store = createChangelogStore(st);
    expect(store.getSnapshot()).toEqual({ seen: '0.1', dismissed: ['bgm'] });
    let n = 0;
    const off = store.subscribe(() => n++);
    store.dismiss('listing');
    expect(n).toBe(1);
    expect(store.getSnapshot().dismissed).toEqual(['bgm', 'listing']);
    expect(JSON.parse(st.map.get(NEWBADGE_DISMISSED_KEY)!)).toEqual(['bgm', 'listing']);
    store.dismiss('listing'); // 重复：不写、不通知
    expect(n).toBe(1);
    store.markAllRead();
    expect(n).toBe(2);
    expect(store.getSnapshot().seen).toBe(LATEST_VERSION);
    expect(st.map.get(CHANGELOG_SEEN_KEY)).toBe(LATEST_VERSION);
    expect(hasUnread(store.getSnapshot().seen)).toBe(false);
    expect(newFeatureKeys(store.getSnapshot())).toEqual([]);
    off();
    store.dismiss('x');
    expect(n).toBe(2);
  });

  it('存储不可用或读写抛错时退化为内存记录', () => {
    const none = createChangelogStore(null);
    expect(none.getSnapshot()).toEqual({ seen: null, dismissed: [] });
    none.dismiss('a');
    none.markAllRead('0.2');
    expect(none.getSnapshot()).toEqual({ seen: '0.2', dismissed: ['a'] });

    const broken = createChangelogStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    expect(broken.getSnapshot()).toEqual({ seen: null, dismissed: [] });
    broken.dismiss('a');
    expect(broken.getSnapshot().dismissed).toEqual(['a']);
  });

  it('refresh 读取其他标签页写入的变化', () => {
    const st = memStorage();
    const store = createChangelogStore(st);
    let n = 0;
    store.subscribe(() => n++);
    st.map.set(CHANGELOG_SEEN_KEY, '0.2.1');
    store.refresh();
    expect(n).toBe(1);
    expect(store.getSnapshot().seen).toBe('0.2.1');
    store.refresh(); // 无变化不通知
    expect(n).toBe(1);
  });
});
