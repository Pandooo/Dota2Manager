// ============================================================================
// 更新说明与「New」徽标（顶栏右上角的版本芯片 → 更新说明面板；新功能入口旁的 New 徽标）
// 本文件是更新内容的唯一事实来源（README「更新日志」只是给 GitHub 读者看的副本），同时提供：
// - 纯函数：版本号比较、未读判断、徽标显示判断、状态变更（便于测试，不依赖 DOM）；
// - 按浏览器持久化的小仓库（localStorage，读写都 try/catch；不进存档、与游戏状态无关、不经 call()）：
//   `d2m:changelog:seen` = 已标为已读的版本号；`d2m:newbadge:dismissed` = 已单独关闭徽标的功能 key 列表。
// 语义：红点 = 还没有把最新版本「标为已读」；某功能的 New 徽标 = 该功能所属版本高于已读版本、且该入口还没被点击 / 看过。
// 打开面板**不**自动算已读（否则一打开面板，游戏里引导找到新功能的徽标就全没了）；面板里的「标为已读」一次清掉红点与全部徽标。
// 发版时（见 AGENTS.md「提交」）：在 CHANGELOG 顶部加版本条目、新功能加进 FEATURES（条目用 feature 引用）、同步 package.json 的 version、README 更新日志同步。
// 文案面向玩家、保持平实，不写搞笑 / 玩梗内容。
// ============================================================================

export interface FeatureDef {
  /** 稳定的功能 key（界面上 <NewBadge feature="…"/> 用它引用；localStorage 里记录的也是它，发布后不要改名） */
  key: string;
  /** 首次出现的版本（必须是 CHANGELOG 中存在的版本） */
  version: string;
  /** 面向玩家的入口说明（面板里显示为「入口：…」） */
  label: string;
}

/** 带 New 徽标的新功能（按版本倒序；发版时把新功能加在前面） */
export const FEATURES = [
  { key: 'trade', version: '0.3.0', label: '转会 › 转会市场 › 转会求购的报价弹窗（或选手详情「报价求购…」）：「加入本队选手抵价」' },
  { key: 'seasonEntry', version: '0.3.0', label: '总览的「赛事报名」卡片：赛季中报名 / 退赛、补充邀请' },
  { key: 'momentum', version: '0.3.0', label: '阵容页统计格的「荣誉势头」' },
  { key: 'gacha', version: '0.3.0', label: '转会 › 「新秀抽卡」标签' },
  { key: 'hallOfFame', version: '0.3.0', label: 'DotaPedia › 「名人堂」标签' },
  { key: 'onlineStats', version: '0.3.0', label: '多人对战大厅「服务器」卡片里的在线人数' },
  { key: 'altPositions', version: '0.2.1', label: '阵容页与选手详情的「位置」：副位置、真实生涯位置' },
  { key: 'listing', version: '0.2', label: '选手详情 / 阵容页的「挂牌出售」：挂牌期改为一整个赛季' },
  { key: 'missions', version: '0.2', label: 'DotaPedia › 战队词条的「使命」章节' },
  { key: 'synergies', version: '0.2', label: 'DotaPedia › 「羁绊图鉴」' },
  { key: 'bgm', version: '0.2', label: '顶栏的背景音乐按钮' },
  { key: 'prizeShare', version: '0.2', label: '俱乐部 › 财务的「选手奖金分成」' },
] as const satisfies readonly FeatureDef[];

export type FeatureKey = (typeof FEATURES)[number]['key'];

export interface ChangelogItem {
  text: string;
  /** 该条目对应的新功能（入口旁显示 New 徽标） */
  feature?: FeatureKey;
}

export interface ChangelogVersion {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  items: ChangelogItem[];
}

/** 更新内容（版本倒序，最新在前） */
export const CHANGELOG: readonly ChangelogVersion[] = [
  {
    version: '0.4.1',
    date: '2026-10-16',
    items: [
      { text: '操作提示统一显示在顶栏下方，不再遮挡底部的操作按钮。' },
      { text: '界面上同时最多显示 2 条提示：新的一条出现时，最早的一条提前渐隐消失，连续快速操作时不会叠满屏幕（多人模式下其他玩家的动态也计入这 2 条）。' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-10-16',
    items: [
      {
        text: '手机适配 · 导航：手机浏览器（竖屏与横屏）可以完整地玩。屏幕较窄时侧栏收进左上角 ☰ 打开的导航抽屉，每个入口下方写明用途，有待处理事项时 ☰ 上有提示点；「存档管理」与「更新说明」也在抽屉底部。',
      },
      {
        text: '手机适配 · 操作栏：手机上的底部操作栏分三行——本回合提示（点按看全文）、可左右滑动的本回合操作，以及「自动」开关、通栏的「下一回合」与「更多」。比赛页在手机上把记分板与文字直播排在最前，BP 改为「点按选中、再点一次确认」。',
      },
      {
        text: '手机适配 · 弹窗与表格：弹窗在手机上从屏幕底部升起，确认气泡不会盖住按钮；宽表格可以左右滑动并固定选手 / 战队名一列，转会市场、赛事列表、单局纪录等在手机上改为卡片或分行列表；页面里不再有吞掉滑动的小滚动框。',
      },
      {
        text: '手机适配 · 触屏提示：点按不可用的按钮会显示原因，原本只在鼠标悬停时显示的说明在手机上直接写出或点按显示；按钮与输入框按手指大小加大，输入时页面不再放大。',
      },
      {
        text: '添加到主屏幕：可以在手机浏览器里「添加到主屏幕」，之后像应用一样全屏打开（冠军盾图标），并避开刘海与底部横条。',
      },
      {
        text: '公网服务器改用 80 端口：直接打开 http://服务器地址/ 即可，不用再输入「:8686」。浏览器里的单机进度与多人身份按网址分开保存，旧地址（带 :8686）过渡期内仍可打开：进行中的多人对局请回旧地址继续；单机进度可在旧地址「存档管理 › 导出存档文件」，再到新地址主菜单「导入存档」。',
      },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-10-15',
    items: [
      {
        text: '新加入选手随队满 10 场比赛且入队满 6 个转会回合后才能挂牌：选手加盟后（签约自由选手、转会、交易、抽卡等任何途径），所在战队打满 10 场系列赛（不要求他本人上场）、并且他入队满 6 个转会回合（每个常规赛回合结束时计一次，赛季初与 TI 期间不计），两个条件都满足才能挂牌出售；在此之前其他俱乐部也不会主动求购他，解约不受影响。开局时已在队的选手不受限制。选手详情的挂牌面板显示「比赛 N / 10 场 · 转会回合 M / 6」，阵容页批量挂牌会列出跳过的选手与原因。刚从自由市场签下或本队抽卡得到、尚未满足这两个条件的选手作为交易抵价时同样只按签字费估值。',
      },
      {
        text: '服务器在线统计接口只允许本机访问：多人服务器的详细在线统计（/api/status）只回答服务器本机的查询；大厅显示的在线人数不变。',
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-15',
    items: [
      {
        text: '选手交易：转会求购的报价可以用「现金 + 本队选手抵价」，一次最多加入 3 名本队选手。每人按「身价 × 系数」折算，对方缺该位置或能顶替其首发时溢价，位置重叠、年龄偏大或等级低于其首发时折价；不愿加盟对方的选手会被拒收，刚从自由市场签下的选手与入队不满一个赛季的抽卡新秀只按签字费估值。对方阵容超员时会放走一名替补腾出位置。选手详情的「报价求购…」打开同一个报价弹窗。',
        feature: 'trade',
      },
      {
        text: '赛季中报名 / 退赛：本赛季尚未开赛的常规赛事在赛季中随时可以报名、重新接受已婉拒的邀请或退出（TI 与 TI 预选赛仍必须参加）。退出按赛事等级扣荣誉（Major 40 / 顶级赛事 25 / Minor 12 / 线上公开赛 5，距开赛 3 个回合及以上减半），报名或接受邀请的同一回合内退出不扣；按钮上直接标出扣分。总览新增「赛事报名」卡片。',
        feature: 'seasonEntry',
      },
      {
        text: '补充邀请：每回合结束时，本赛季积分榜靠前或荣誉达到受邀线、但还没有受邀的战队，会收到即将开赛赛事的补充邀请（默认接受，收到的回合内婉拒不扣荣誉），初始荣誉不高但赛季中表现好的战队能得到更多参赛机会。',
      },
      {
        text: '荣誉势头：荣誉的同比变化在赛季初调整全队的赛季状态（最多 ±3%），近几个回合的荣誉升降影响战队评分（最多 ±2%）。阵容页、战队详情与总览俱乐部卡片显示「强势 / 向好 / 平稳 / 走低 / 低迷」，悬停查看说明。',
        feature: 'momentum',
      },
      {
        text: '新秀抽卡回归并取代选秀：每个赛季的卡池包含真实新秀（能力与成长参照真实生涯）、请神新秀（与名人堂选手建立请神关系，成长走势、巅峰与天赋复制原型，同一联赛里可能同时出现真身与多名请神新秀）和虚构新秀。出卡概率 SSR 5% / SS 10% / S 10% / A 15% / B 30% / C 30%，每 100 抽必出 SSR；单抽价格随年代变化，十连 = 10 次单抽；本回合抽到的新秀可在同一回合内退回；新秀合同工资有上限，入队满一个赛季前不能挂牌出售。单抽 / 十连总是抽满，阵容可以因此超过 12 人的上限，但超编时需在本回合内放弃新秀或解约、退回 12 人后才能进入下一回合（总览与抽卡页会提示超编人数；开启「自动处理」时按「下一回合」会先自动退回评分最低的新秀）。真实新秀只在赛季初可抽：第 1 回合开始时没被抽走的真实新秀加盟其真实出道战队（出道战队是你的战队时由你决定签下或放弃）。AI 俱乐部按自身资金与阵容空位自动抽卡；卡池在 TI 预选赛转会锁定时关闭。',
        feature: 'gacha',
      },
      {
        text: '名人堂：初始收录 DotA1 时代的传奇选手；从 TI1 之后的届次开局时，补录开局之前真实历史中达到过 SS / SSR 的选手（只登记到开局为止的成绩，不剧透）；每个赛季结束时把该赛季的 SS / SSR 选手引入名人堂，成为此后新秀抽卡「请神」的原型。DotaPedia 新增「名人堂」标签（可按 DotA1 时代 / 真实数据补录 / 本局入堂筛选），选手词条新增「名人堂与请神」章节。旧存档读取时自动补录。',
        feature: 'hallOfFame',
      },
      {
        text: '懒人模式补员：开启「自动处理」一直点「下一回合」时，转会窗口内正式阵容缺位置或不足 5 人，会自动签下负担得起、愿意加盟的自由选手补位（优先签下后收入仍付得起工资的人选；不会自动抽卡；资金紧张时照旧由临时替补顶上，并说明原因）。按下前，按钮提示会列出人选与签字费。',
      },
      {
        text: '游戏内更新说明：右上角的版本号（手机上显示为「更新」）与主菜单页脚的版本号可以打开各版本的更新内容；新功能的入口旁带「New」徽标，点击或看过后消失，也可以在更新说明里一次标为已读。手机宽度下顶栏不再溢出。',
      },
      {
        text: '多人：大厅显示服务器当前在线人数、对局数与房间数，房间页顶栏（电脑端）显示在线人数；部署在公网的服务器不再向玩家显示或发送内网地址，发给玩家的错误提示不含服务器内部细节；同一网络地址的连接数、等待中的房间与开局次数有上限，聊天限速，房间数满时会清理长时间无人在线的对局；抽卡与报价结果无法提前算出。主菜单入口改名为「多人对战」。',
        feature: 'onlineStats',
      },
    ],
  },
  {
    version: '0.2.1',
    date: '2026-10-13',
    items: [
      {
        text: '真实选手的位置跟随真实生涯：每个新赛季同步为该届的真实位置（例如 Miposhka 自 TI7 起打 5 号位、rue 于 TI15 转为 5 号位），转型时在总览「通知」中提示；新秀与中途回归的真实选手按当届位置加入。',
      },
      {
        text: '新增副位置：真实生涯中打过的其他位置记为副位置（评分 ×0.95），4、5 号位之间所有选手互通（×0.93），其他非本位置仍为 ×0.85。位置徽章会标出「可5」等副位置，自动排阵与 AI 转会按同一规则补齐阵容。',
        feature: 'altPositions',
      },
      { text: 'DotaPedia 选手页新增「真实生涯位置」（只显示本局已发生的届次，不剧透）。' },
      { text: '存档升级：「继续游戏」与导入存档走同一套升级流程（此前「继续游戏」会跳过存档修正），旧存档读取时一次性修正位置与挂牌期限。' },
    ],
  },
  {
    version: '0.2',
    date: '2026-10-12',
    items: [
      { text: '破产结局：资金持续为负会破产出局，总览「待处理」常驻倒计时提示。' },
      { text: '新俱乐部会在联赛中陆续涌现；俱乐部名称与队徽随真实品牌时间线更替，队徽为按品牌配色生成的原创图案。' },
      {
        text: '真实俱乐部的「使命」：AI 俱乐部会设法重组自己历史上的巅峰阵容，进度见 DotaPedia 战队词条的「使命」章节。',
        feature: 'missions',
      },
      { text: '羁绊系统：历届冠军 / 经典阵容的成员同队首发时获得加成；DotaPedia 新增「羁绊图鉴」。', feature: 'synergies' },
      { text: 'TI 预选 / 正赛回合的顶栏冠军盾徽记（点击查看本届信息与本队参赛情况）。' },
      { text: '背景音乐：顶栏新增音乐按钮，内置原创氛围音乐，也可以选择本地音频文件（只保存在本浏览器，不上传）。', feature: 'bgm' },
      {
        text: '开局资金重新锚定（普通难度）：新俱乐部 TI1 起步 20 万、最强真实俱乐部 TI1 起步 10 万，其他届按年代折算；新俱乐部任何难度不低于该值，真实俱乐部保底 9 回合工资。',
      },
      {
        text: '奖金分成：所有俱乐部默认 50% 给队员，队员所得奖金全额计入薪资满意度；比例在「俱乐部 › 财务」调整。',
        feature: 'prizeShare',
      },
      { text: 'AI 首发优先安排使命选手与巅峰阵容选手，其余按评分；AI 转会不再为这些位置购入替补。' },
      {
        text: '挂牌出售改为持续一整个赛季（18 个转会回合，TI 锁定期间暂停）：整个挂牌期无人报价才自动解约，收到过报价则到期留队；标价越高、挂得越久，关注度越低。',
        feature: 'listing',
      },
      { text: '体验修正：游戏结束直接进入生涯总结（不再逐条弹出历史赛果）；主场作战的外籍队员无签证风险；选手转会意愿加入小幅随机浮动。' },
    ],
  },
  {
    version: '0.1',
    date: '2026-10-10',
    items: [{ text: '首个公开版本：单机 + 局域网多人、TI1–TI15 真实数据、赛季 / 比赛 / 转会 / 选秀 / 事件 / 新闻 / DotaPedia / 生涯总结。' }],
  },
];

/** 更新说明中的最新版本 */
export const LATEST_VERSION: string = CHANGELOG[0].version;

/** 应用版本号（vite.config.ts 注入 package.json 的 version；未注入的环境回退为更新说明中的最新版本） */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? normalizeVersion(__APP_VERSION__) : LATEST_VERSION;

// ---------------------------------------------------------------------------
// 版本号
// ---------------------------------------------------------------------------

/** 去掉前导 v / 空白：'v0.2.1 ' → '0.2.1' */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, '');
}

/**
 * 比较版本号：按「.」分段做数值比较，缺段补 0（'0.2' 与 '0.2.0' 相等），非数字段按 0。
 * a < b → -1，a == b → 0，a > b → 1。
 */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split('.');
  const pb = normalizeVersion(b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0;
    const y = parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isValidVersion(v: string): boolean {
  return /^\d+(\.\d+){1,3}$/.test(v);
}

export function isValidDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

// ---------------------------------------------------------------------------
// 已读 / 徽标（纯函数）
// ---------------------------------------------------------------------------

export interface ChangelogState {
  /** 已标为已读的版本号（null = 从未标记） */
  seen: string | null;
  /** 已单独关闭徽标的功能 key */
  dismissed: readonly string[];
}

export const EMPTY_CHANGELOG_STATE: ChangelogState = { seen: null, dismissed: [] };

/** 是否有未读的新版本：从未标记，或已读版本低于最新版本 */
export function hasUnread(seen: string | null, latest: string = LATEST_VERSION): boolean {
  return seen === null || compareVersions(seen, latest) < 0;
}

/** 某个版本相对已读版本是否为「新」 */
export function versionIsNew(version: string, seen: string | null): boolean {
  return seen === null || compareVersions(version, seen) > 0;
}

export function featureOf(key: string, features: readonly FeatureDef[] = FEATURES): FeatureDef | undefined {
  return features.find((f) => f.key === key);
}

/** 某功能是否应显示 New 徽标：功能存在、所属版本高于已读版本、且没有被单独关闭 */
export function featureIsNew(key: string, state: ChangelogState, features: readonly FeatureDef[] = FEATURES): boolean {
  const f = featureOf(key, features);
  if (!f) return false;
  if (state.dismissed.includes(key)) return false;
  return versionIsNew(f.version, state.seen);
}

/** 当前仍显示徽标的功能 key */
export function newFeatureKeys(state: ChangelogState, features: readonly FeatureDef[] = FEATURES): string[] {
  return features.filter((f) => featureIsNew(f.key, state, features)).map((f) => f.key);
}

/** 标为已读（只会往前走：已读版本不会被更低的版本覆盖） */
export function withSeen(state: ChangelogState, version: string): ChangelogState {
  const v = normalizeVersion(version);
  if (!v) return state;
  if (state.seen !== null && compareVersions(state.seen, v) >= 0) return state;
  return { seen: v, dismissed: state.dismissed };
}

/** 单独关闭某功能的徽标（列表有上限，超过时丢弃最早的记录） */
export const DISMISSED_MAX = 200;
export function withDismissed(state: ChangelogState, key: string): ChangelogState {
  if (!key || state.dismissed.includes(key)) return state;
  const dismissed = [...state.dismissed, key].slice(-DISMISSED_MAX);
  return { seen: state.seen, dismissed };
}

/** 解析存储中的 key 列表（损坏 / 非数组 → 空） */
export function parseDismissed(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 解析存储中的已读版本号（非法 → null） */
export function parseSeen(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = normalizeVersion(raw);
  return isValidVersion(v) ? v : null;
}

// ---------------------------------------------------------------------------
// 数据校验（tests/changelog.test.ts；也可在开发期调用）
// ---------------------------------------------------------------------------

/** 返回更新说明与功能表的问题列表（空数组 = 合法） */
export function changelogProblems(versions: readonly ChangelogVersion[] = CHANGELOG, features: readonly FeatureDef[] = FEATURES): string[] {
  const problems: string[] = [];
  if (!versions.length) problems.push('更新说明为空');
  const versionSet = new Set<string>();
  versions.forEach((v, i) => {
    if (!isValidVersion(v.version)) problems.push(`版本号格式不合法：「${v.version}」`);
    if (versionSet.has(v.version)) problems.push(`版本重复：${v.version}`);
    versionSet.add(v.version);
    if (!isValidDate(v.date)) problems.push(`v${v.version} 的日期格式应为 YYYY-MM-DD：「${v.date}」`);
    if (i > 0 && compareVersions(versions[i - 1].version, v.version) <= 0) problems.push(`版本应按倒序排列：v${versions[i - 1].version} 之后是 v${v.version}`);
    if (i > 0 && versions[i - 1].date < v.date) problems.push(`日期应随版本倒序：v${versions[i - 1].version}（${versions[i - 1].date}）早于 v${v.version}（${v.date}）`);
    if (!v.items.length) problems.push(`v${v.version} 没有更新条目`);
    v.items.forEach((it, j) => {
      if (!it.text.trim()) problems.push(`v${v.version} 第 ${j + 1} 条文字为空`);
      if (it.feature !== undefined) {
        const f = features.find((x) => x.key === it.feature);
        if (!f) problems.push(`v${v.version} 第 ${j + 1} 条引用了不存在的功能 key「${it.feature}」`);
        else if (f.version !== v.version) problems.push(`功能「${it.feature}」标在 v${v.version} 条目里，但功能表中的版本是 v${f.version}`);
      }
    });
  });
  const keys = new Set<string>();
  for (const f of features) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(f.key)) problems.push(`功能 key 不合法：「${f.key}」`);
    if (keys.has(f.key)) problems.push(`功能 key 重复：${f.key}`);
    keys.add(f.key);
    if (!versionSet.has(f.version)) problems.push(`功能「${f.key}」的版本 v${f.version} 不在更新说明中`);
    if (!f.label.trim()) problems.push(`功能「${f.key}」缺少入口说明`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 持久化小仓库（浏览器 localStorage；Node / 不可用时只在内存中）
// ---------------------------------------------------------------------------

export const CHANGELOG_SEEN_KEY = 'd2m:changelog:seen';
export const NEWBADGE_DISMISSED_KEY = 'd2m:newbadge:dismissed';

type KV = Pick<Storage, 'getItem' | 'setItem'>;

export interface ChangelogStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ChangelogState;
  /** 标为已读（默认最新版本）：清掉红点与全部 New 徽标 */
  markAllRead(version?: string): void;
  /** 单独关闭某功能的徽标（点击入口 / 看过入口） */
  dismiss(key: string): void;
  /** 重新从存储读取（其他标签页改动时） */
  refresh(): void;
}

export function createChangelogStore(storage: KV | null | undefined): ChangelogStore {
  const listeners = new Set<() => void>();
  const read = (): ChangelogState => {
    let seen: string | null = null;
    let dismissed: string[] = [];
    try {
      seen = parseSeen(storage?.getItem(CHANGELOG_SEEN_KEY));
    } catch {
      seen = null;
    }
    try {
      dismissed = parseDismissed(storage?.getItem(NEWBADGE_DISMISSED_KEY));
    } catch {
      dismissed = [];
    }
    return { seen, dismissed };
  };
  let snap: ChangelogState = read();
  const same = (a: ChangelogState, b: ChangelogState) =>
    a.seen === b.seen && a.dismissed.length === b.dismissed.length && a.dismissed.every((k, i) => k === b.dismissed[i]);
  const notify = () => {
    for (const l of listeners) l();
  };
  const commit = (next: ChangelogState) => {
    if (same(next, snap)) return;
    snap = next;
    try {
      if (next.seen) storage?.setItem(CHANGELOG_SEEN_KEY, next.seen);
    } catch {
      // 隐私模式 / 配额不足：本次页面会话内仍生效
    }
    try {
      storage?.setItem(NEWBADGE_DISMISSED_KEY, JSON.stringify(next.dismissed));
    } catch {
      // 同上
    }
    notify();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snap,
    markAllRead(version = LATEST_VERSION) {
      commit(withSeen(snap, version));
    },
    dismiss(key) {
      commit(withDismissed(snap, key));
    },
    refresh() {
      const next = read();
      if (same(next, snap)) return;
      snap = next;
      notify();
    },
  };
}

/** 浏览器 localStorage（Node / 被禁用 / 不完整的实现时为 null；先判断 window，避免在 Node 下触碰实验性的 localStorage 全局） */
function browserStorage(): KV | null {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined' || !localStorage) return null;
    return typeof localStorage.getItem === 'function' && typeof localStorage.setItem === 'function' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 页面级单例（界面用；其他标签页改动同一存储时同步） */
export const changelogStore: ChangelogStore = createChangelogStore(browserStorage());
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === null || e.key === CHANGELOG_SEEN_KEY || e.key === NEWBADGE_DISMISSED_KEY) changelogStore.refresh();
  });
}
