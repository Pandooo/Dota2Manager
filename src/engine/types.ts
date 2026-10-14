// ============================================================================
// Dota2 Manager — 核心类型定义（所有模块共享的契约）
// 修改本文件前请同步更新 docs/DESIGN.md
// ============================================================================

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

/** 位置：C=1号位(Carry) M=2号位(Mid) O=3号位(Offlane) SS=4号位(Soft Support) HS=5号位(Hard Support) */
export type Position = 'C' | 'M' | 'O' | 'SS' | 'HS';
export const POSITIONS: Position[] = ['C', 'M', 'O', 'SS', 'HS'];

/** 天梯等级，从低到高 */
export type Tier = 'C' | 'B' | 'A' | 'S' | 'SS' | 'SSR';
export const TIERS: Tier[] = ['C', 'B', 'A', 'S', 'SS', 'SSR'];

/** 赛区 */
export type Region = 'CN' | 'SEA' | 'CIS' | 'EU' | 'NA' | 'SA';
export const REGIONS: Region[] = ['CN', 'SEA', 'CIS', 'EU', 'NA', 'SA'];

/** 赛事等级 */
export type TournamentTier = 'ti' | 'major' | 'premier' | 'minor' | 'qualifier';

/** 赛季阶段 */
export type SeasonPhase = 'preseason' | 'regular' | 'ti_qualifier' | 'ti' | 'season_end';

/** 训练焦点 */
export type TrainingFocus = 'power' | 'mmr' | 'insight' | 'balanced';

/** 可被修正器影响的属性 */
export type ModAttr = 'power' | 'mmr' | 'insight' | 'resilience' | 'loyalty' | 'talent';

/** 英雄主属性 */
export type HeroAttr = 'str' | 'agi' | 'int' | 'uni';

/** 英雄风格标签（用于阵容搭配/克制） */
export type HeroStyle = 'early' | 'late' | 'teamfight' | 'push' | 'gank' | 'control' | 'sustain' | 'pickoff' | 'splitpush' | 'tempo';

// ---------------------------------------------------------------------------
// 静态数据（src/data/*.json）
// ---------------------------------------------------------------------------

export interface TiInfo {
  ti: number;                 // 1..16
  year: number;
  name: string;               // "The International 2019"
  city: string;
  country: string;
  hostRegion: Region;         // 举办地所属赛区（NA 时签证事件高发）
  startDate: string;          // YYYY-MM-DD（正赛开始）
  endDate: string;
  prizePool: number;          // 美元/金币
  teams: number;              // 参赛队伍数
  directInvites: number;      // 直邀名额
  qualifierSlots: Partial<Record<Region, number>>; // 各赛区预选名额，总和 = teams - directInvites
  champion?: string;          // 真实冠军 team id（历史数据，仅展示）
  runnerUp?: string;
  projected?: boolean;        // 未来/推演数据
  /** 该届官方主视觉配色（第八波：TI 转场与 TI 回合界面点缀；仅展示用，旧数据可能缺失） */
  theme?: TiTheme;
}

/** TI 主视觉主题：颜色均为 #RRGGBB */
export interface TiTheme {
  name: string;               // 主题名（中文，界面显示）
  primary: string;            // 主色
  secondary: string;          // 辅色（深色底）
  accent: string;             // 强调色（高光 / 发光）
  text?: string;              // 主色底上的文字颜色（缺省为浅色）
}

export interface SeedPlayer {
  id: string;                 // 规范 slug，跨文件一致，如 "miracle"
  handle: string;             // 该时期显示 ID，如 "Miracle-"
  name?: string;              // 真名
  nationality: string;        // ISO 3166-1 alpha-2，如 "UA" "CN"
  birthYear: number;
  position: Position;
  mmr: number;
  power: number;
  talent: number;
  resilience: number;
  insight: number;
  loyalty: number;
  signatureHeroes: string[];  // hero id
}

export interface SeedCoach {
  id: string;
  name: string;
  nationality: string;
  birthYear: number;
  tier: Tier;
  insight: number;
}

export interface SeedTeam {
  id: string;                 // 规范 slug，如 "team-spirit"
  name: string;
  tag: string;
  region: Region;
  honor: number;              // 初始荣誉
  funds: number;              // 初始资金（金币）
  color?: string;             // 主色 hex
  atTI: boolean;              // 是否为该届 TI 参赛队
  tiResult?: string;          // 该届 TI 真实名次（仅展示），如 "1" "5-6" "DNQ"
  coach?: SeedCoach | null;
  players: SeedPlayer[];      // 首发 5 人（位置各不相同），可附加替补
}

export interface RosterFile {
  ti: number;
  year: number;
  teams: SeedTeam[];
  freeAgents: SeedPlayer[];
  freeCoaches: SeedCoach[];
}

export interface PlayerIndexEntry {
  id: string;
  handle: string;
  name?: string;
  nationality: string;
  birthYear: number;
  firstTi: number;            // 首次出现在 roster 文件中的 TI
  position: Position;         // 首次出现时的位置
  firstPower: number;
  peakPower: number;
  peakTalent: number;
  insight: number;
  signatureHeroes: string[];
  /** 首次出现时效力的战队（roster 中的战队 id；当届为自由选手则缺省）：真实新秀未被抽走时优先加盟该队 */
  firstTeamId?: string;
}

/** 真实选手在某一届 TI 阵容数据中的水平（src/data/trajectories.json，scripts/build-trajectories.ts 生成；第九波自主成长） */
export interface TrajectoryPoint {
  power: number;
  mmr: number;
  tier: Tier;
  /**
   * 该届阵容数据中的位置（第十三波「真实生涯位置」，roles.ts）。游程压缩：只写在首届与位置变化的届次上，
   * 缺省 = 沿用之前最近一届的 pos（engine/roles.realRoleHistory 展开为逐届位置）。
   */
  pos?: Position;
}

/** 真实生涯轨迹：TI 序号（JSON 中为字符串键）→ 当届水平；只含该选手出现过的届次 */
export type PlayerTrajectory = Record<number, TrajectoryPoint>;

export interface PatchInfo {
  version: string;            // "7.33"
  date: string;               // YYYY-MM-DD
  title: string;              // 中文标题
  summary: string;            // 中文更新方向摘要
  powerMult: Record<Position, number>;
  insightMult: Record<Position, number>;
  heroBuffs?: string[];       // hero id
  heroNerfs?: string[];
  newHeroes?: string[];
  major?: boolean;            // 大版本
  projected?: boolean;
}

export interface HeroInfo {
  id: string;                 // slug
  name: string;               // 英文名
  cn: string;                 // 中文名
  attr: HeroAttr;
  positions: Record<Position, number>; // 0..1 适配度
  styles: HeroStyle[];
  releaseDate: string;        // 在 Dota 2 中可用的日期
  complexity: 1 | 2 | 3;
}

export interface TournamentTemplate {
  id: string;                 // 唯一 slug，含年份，如 "esl-one-frankfurt-2015"
  seriesId: string;           // 同系列跨年一致，用于「同比」，如 "esl-one-frankfurt"
  name: string;
  tier: TournamentTier;       // 非 TI
  startDate: string;
  endDate: string;
  city: string;
  hostRegion: Region;
  online?: boolean;           // 线上赛（无签证问题）
  prizePool: number;
  teams: number;              // 正赛队伍数（4..24）
  invites: number;            // 直邀名额（按上赛季排名）
  regionLocked?: Region;      // 仅限某赛区参赛（如联赛）
  format: TournamentFormatPreset;
}

export type TournamentFormatPreset =
  | 'se8'          // 8 队单败
  | 'de8'          // 8 队双败
  | 'gsl_de8'      // 2 组循环 → 8 队双败
  | 'groups_de'    // N 组循环(Bo2) → 双败淘汰赛
  | 'groups_se'    // N 组循环 → 单败
  | 'rr'           // 单循环联赛
  | 'ti';          // TI 赛制：小组 Bo2 → 双败淘汰赛（决赛 Bo5）

// ---------------------------------------------------------------------------
// 运行时实体
// ---------------------------------------------------------------------------

export interface Modifier {
  id: string;
  source: string;             // 中文来源描述，如 "情感受挫"
  attr: ModAttr;
  kind: 'add' | 'mul';
  value: number;
  roundsLeft: number | null;  // null = 永久；以大回合计
}

export type PlayerStatus = 'active' | 'banned' | 'retired';

export interface PlayerStats {
  matches: number;            // 局数
  wins: number;
  titles: number;
  tiTitles: number;
  mvp: number;
}

export interface Player {
  id: string;
  handle: string;
  name?: string;
  nationality: string;
  region: Region;
  birthYear: number;
  /** 本位置：真实选手随真实生涯同步为当届真实位置（roleSync.syncSeasonRoles，数据缺失的届次沿用上一个位置），程序生成选手固定 */
  position: Position;
  mmr: number;
  power: number;
  talent: number;
  resilience: number;
  insight: number;
  loyalty: number;
  salary: number;             // 每大回合
  contractUntil: number;      // 到期 TI 序号（含）
  teamId: string | null;      // null = 自由选手
  status: PlayerStatus;
  modifiers: Modifier[];
  signatureHeroes: string[];
  stats: PlayerStats;
  joinedSeason: number;       // 加入当前战队的 TI 序号
  isRookie?: boolean;
  isReal: boolean;            // 真实选手 vs 程序生成
  tempSubUntilTournament?: string; // 临时替补：效力的赛事实例 id（赛事结束后自动离队）
  benchRounds?: number;       // 连续替补回合数（影响归属感）
  /** 因签证/伤病等无法参加的赛事实例 id */
  unavailableTournamentIds?: string[];
  /** 最近一次离开的战队 id（离队/退役时由 team.removePlayerFromTeam 记录） */
  lastTeamId?: string;
  /** 野外替补（程序化临时替补候选/雇佣者）：不出现在自由选手池，离队后从 state.players 删除 */
  isWildSub?: boolean;
  /** 旧版：通过抽卡获得的赛季（第八波已取消玩家抽卡，仅旧存档可能残留） */
  gachaSeason?: number;
  /** 新秀选秀记录（rookieDraft.ts）：在哪一届、第几轮第几顺位被哪支战队选中（永久保留，用于展示与「赛季初免费放弃」） */
  draft?: PlayerDraftInfo;
  /**
   * 玩家从自由市场签下他的时刻（转会回合时钟 listingRules.listingClock；market.signFreeAgent 写入，离队时清除）：
   * 签下后不满 CONFIG.market.trade.freeAgentHoldRounds 个转会回合（约一个赛季）用于选手交易抵价时，对方按签字费估值（trade.ts）。
   * 旧存档缺失 = 无记录。
   */
  freeAgentSignedClock?: number;
  /** 最近一次加薪的赛季（TI 序号）：每名选手每赛季最多加薪一次（squadOps.raiseSalary） */
  lastRaiseSeason?: number;
  /** 最近一次一对一谈心的回合键（赛季 × 100 + 回合，squadOps.squadRoundKey）：每回合最多一次 */
  lastTalkRound?: number;
  /** 挂牌转会状态（仅玩家战队选手；squadOps.listPlayerForTransfer） */
  transferListing?: TransferListing;
  /**
   * 撤牌记忆（squadOps.unlistPlayer 写入）：撤牌时的挂牌时钟（listingRules.listingClock）与已经历的出价机会次数；
   * 在 CONFIG.squadOps.relistStaleMemorySeasons 个赛季的转会回合内重新挂牌时沿用（挂牌过久的衰减不因撤牌 / 重挂而重置）。
   * 重新挂牌、离队、退役时清除。
   */
  listingStaleMemo?: { clock: number; rolls: number };
  /**
   * 隐藏的跨赛季趋势（-1..1，form.ts 每赛季初更新；缺失 = 0）：负值 → 衰退期延续、成长放缓；
   * 正值 → 成长加快（年轻选手的爆发赛季）。不在界面直接展示。
   */
  formTrend?: number;
  /** 隐藏的薪资预期跟踪（salary.ts，第八波；不在界面显示数值，旧存档缺失 = 无记录） */
  salaryTrack?: SalaryTrack;
  /** 隐藏的赛季自主成长记录（development.ts，第九波；潜力上限不在界面显示数值，旧存档缺失 = 首次自主成长时评估） */
  development?: PlayerDevelopment;
  /**
   * 副位置（第十三波，roles.ts）：真实选手在真实阵容数据中担任过的其他位置（按最近担任的届次排序，不含本位置），
   * 评分 × CONFIG.team.altRoleFactor（本位置 1，其他非本位置 offRoleFactor；4/5 号位互换另有 supportSwapFactor）。
   * 程序生成选手没有副位置（缺省）。position 本身随真实生涯同步（roleSync.syncSeasonRoles），副位置随之更新。
   */
  altPositions?: Position[];
  /** 新秀抽卡出身（gacha.ts，2026-10-14 起取代选秀）：在哪一届、哪个回合被哪支战队以哪种卡抽中，及出道时的水平（永久保留） */
  gacha?: PlayerGachaInfo;
  /**
   * 请神（gacha.ts / hallOfFame.ts）：与名人堂成员（原型）构建的请神关系。出道时复制原型的出道水平，
   * 之后每个赛季的自主成长按原型的生涯轨迹（按出道届次平移）走，原型数据结束后按普通选手的年龄 / 潜力规律。
   */
  summon?: PlayerSummonInfo;
}

/** 抽卡卡种：真实新秀 / 请神新秀 / 虚构新秀 */
export type GachaCardKind = 'real' | 'summon' | 'fictional';

/** 选手的抽卡出身（Player.gacha） */
export interface PlayerGachaInfo {
  /** 抽中的赛季（TI 序号）与回合 */
  ti: number;
  round: number;
  /** 抽中他的战队 */
  teamId: string;
  /** 卡的等级与卡种 */
  tier: Tier;
  kind: GachaCardKind;
  /** 出道时的天梯 / 战力 / 天赋 / 灵性（名人堂记录本局生涯轨迹用） */
  mmr: number;
  power: number;
  talent: number;
  insight: number;
  /** 未被抽走、按真实出道去向加盟（真实新秀；第 1 回合开始前离池或卡池关闭时） */
  placed?: boolean;
}

/** 请神关系（Player.summon） */
export interface PlayerSummonInfo {
  /** 原型：名人堂成员 id */
  id: string;
  /** 原型的显示 ID（原型选手可能已被清理） */
  handle: string;
  /** 出道（被抽中）的赛季：生涯第 k 年对应原型生涯第 k 年 */
  ti: number;
}

/** 战队的抽卡计数（Team.gacha；随战队保存，多人模式各座位独立） */
export interface TeamGachaState {
  /** 距上一张 SSR 已抽的张数（跨赛季；达到 CONFIG.gacha.pityThreshold − 1 后下一抽必出 SSR） */
  pity: number;
  /** 累计抽卡张数 */
  pulls: number;
  /** 本赛季已抽张数（seasonTi 不是当前赛季时视为 0） */
  seasonTi?: number;
  seasonPulls?: number;
  /** 本赛季的抽卡记录（只记人类玩家战队；新赛季第一次抽卡时清空） */
  log?: GachaPullRecord[];
}

/** 一张抽卡记录（TeamGachaState.log） */
export interface GachaPullRecord {
  ti: number;
  round: number;
  /** 同一次操作（单抽 / 十连）的序号 */
  batch: number;
  playerId: string;
  handle: string;
  tier: Tier;
  kind: GachaCardKind;
  /** 请神原型 id / 显示 ID */
  proto?: string;
  protoHandle?: string;
  /** 保底触发 */
  pity?: boolean;
  /** 本回合内退回（返还部分抽卡费用） */
  discarded?: boolean;
  /** 实付单价（金币） */
  cost: number;
}

/** 本赛季卡池（GachaState.pool；全局世界状态，所有座位共享，先到先得） */
export interface GachaPool {
  ti: number;
  /** 剩余卡：各等级的真实新秀 id / 请神原型 id（同一原型可出现多张）/ 虚构新秀张数 */
  real: Partial<Record<Tier, string[]>>;
  summon: Partial<Record<Tier, string[]>>;
  fictional: Partial<Record<Tier, number>>;
  /** 本赛季建池的总张数（含补充卡池）与基础卡池张数（真实新秀超出比例时按 20 张一档放大） */
  size: number;
  base: number;
  /** 基础卡池为容纳真实新秀而放大时，超出比例的等级 */
  enlargedBy?: Tier[];
  /** 抽空后补充卡池的次数 */
  refills: number;
  /** 各等级发出的卡 [真实, 请神, 虚构]（含补充卡池与保底补发） */
  made: Partial<Record<Tier, [number, number, number]>>;
  /** 本赛季每个原型已发出的请神卡张数 */
  protoUsed: Record<string, number>;
  /** 已抽张数（全部 / AI 战队） */
  drawn: number;
  aiDrawn: number;
  /** 保底触发但卡池中已无 SSR 时补发的卡 */
  bonus?: number;
  /** 第 1 回合开始前未被抽走的真实新秀卡已离池（gacha.releaseRealRookieCards；每赛季一次） */
  realReleased?: boolean;
  /** 离池时同等级补入的请神 / 虚构卡张数 */
  backfilled?: number;
  /** 离池而未被抽走的真实新秀卡（按等级） */
  realPlaced?: Partial<Record<Tier, number>>;
  /** 离池的真实新秀：加盟 AI 战队 / 进入自由市场 / 交给出道战队（人类玩家）决定 */
  realJoined?: number;
  realFree?: number;
  realOffered?: number;
}

/** 一届抽卡的汇总（GachaState.history） */
export interface GachaSeasonRecord {
  ti: number;
  size: number;
  base: number;
  refills: number;
  made: Partial<Record<Tier, [number, number, number]>>;
  drawn: number;
  aiDrawn: number;
  /** 抽出的 SSR / 请神张数 */
  ssr: number;
  summons: number;
  /** 未被抽走的真实新秀（第 1 回合前离池或卡池关闭时）：加盟 AI 战队 / 进入自由市场 / 交给出道战队（人类玩家）决定 */
  realJoined: number;
  realFree: number;
  realOffered?: number;
}

/** 新秀抽卡（GameState.gacha；全局，非座位私有） */
export interface GachaState {
  /** 本赛季卡池（转会窗口开放期间可抽；TI 预选赛转会锁定时关闭 → null） */
  pool: GachaPool | null;
  /** 往届汇总（最新在后） */
  history: GachaSeasonRecord[];
}

/** 名人堂成员（HallOfFameState.members） */
export interface HallOfFameMember {
  id: string;
  handle: string;
  /**
   * seed = 开局即有（DotA1 时代传奇）；inducted = 本局赛季结算时以 SS / SSR 入选；
   * backfill = 开局补录（2026-10-15 用户决策「补录」：开局届之前的真实数据中达到过 SS / SSR 的真实选手，ti = 首次达到的届次）
   */
  source: 'seed' | 'inducted' | 'backfill';
  era?: 'dota1';
  /** 入选赛季（TI 序号；种子为 0） */
  ti: number;
  debutTier: Tier;
  peakTier: Tier;
  position: Position;
  nationality: string;
  birthYear: number;
  /**
   * 生涯轨迹来源：real = 真实生涯轨迹（trajectories.json）；seed = hallOfFame.json 的合成轨迹；
   * game = 本局记录（traj）；summon = 请神新秀入选（不能再作为原型，of = 其原型）
   */
  src: 'real' | 'seed' | 'game' | 'summon';
  /** game：本局记录的生涯轨迹 [TI, 天梯, 战力]（出道点 + 入选及之后每个赛季末） */
  traj?: [number, number, number][];
  /** game：出道时的天赋 / 灵性 / 招牌英雄 */
  talent?: number;
  insight?: number;
  heroes?: string[];
  /** summon：原型 id */
  of?: string;
}

/** 名人堂（GameState.hallOfFame；全局公开数据） */
export interface HallOfFameState {
  members: HallOfFameMember[];
  /** 旧存档迁移时补录的赛季（新游戏缺省） */
  migratedTi?: number;
  /**
   * 开局补录的版本（hallOfFame.HOF_BACKFILL_VERSION）：新游戏建名人堂时写入；旧存档 / 旧房间缺失或落后时在读档迁移中补录一次
   * （开局届之前的真实 SS / SSR + 当前在役的 SS / SSR）
   */
  backfillVersion?: number;
  /** 旧存档补录时的赛季（新游戏缺省） */
  backfilledTi?: number;
}

/**
 * 赛季自主成长（development.ts，第九波）：程序生成选手（及真实选手最后一届真实数据之后）的隐藏潜力上限
 * （首次自主成长时按当时水平 + 天赋/年龄决定的成长空间评估，之后固定）；最近一次自主成长的赛季与变化。
 * 每名选手一份（多人模式随选手同步，无需座位切换）。界面只显示定性的成长趋势，不显示潜力数值。
 */
export interface PlayerDevelopment {
  /** 潜力上限（天梯分 / 基础战力） */
  potentialMmr?: number;
  potentialPower?: number;
  /** 不参照真实生涯轨迹（多人「选择已有战队」玩法中被重置为新俱乐部水平的真实选手） */
  noTrajectory?: boolean;
  /** 最近一次自主成长的赛季（TI 序号；同一赛季只执行一次）与天梯 / 战力变化 */
  ti?: number;
  mmr?: number;
  power?: number;
  /**
   * 训练投入（成长重平衡，2026-10-09）：在人类玩家战队训练获得的天梯 / 战力累计（growth.trainTeam 记入，每个赛季自主成长后按
   * CONFIG.development.investment.decay 衰减）。自主成长的「到顶回落」最多保护其中天赋决定的一段（investmentAllowance），
   * 天梯相对校准优先回落没有训练投入的选手。旧存档缺失 = 0。
   */
  trainedMmr?: number;
  trainedPower?: number;
}

/**
 * 薪资预期跟踪（salary.ts）：近期荣誉热度（冠军 / MVP，按赛季衰减）、上回合的薪资差（判断差距是否拉大）、
 * 新秀合同标记、「对薪资不满」新闻冷却。每名选手一份（多人模式随选手同步，无需座位切换）。
 */
export interface SalaryTrack {
  /** 近期荣誉热度及其结算赛季（TI 序号） */
  fame?: number;
  ti?: number;
  /** 上次结算时的 stats.titles / stats.tiTitles / stats.mvp（增量计入热度） */
  titles?: number;
  tiTitles?: number;
  mvp?: number;
  /** 上回合结束时的薪资差 g 及所在战队（人类玩家战队选手） */
  gap?: number;
  gapTeamId?: string;
  /** 新秀合同：签约战队与到期赛季（含）；期间不计薪资差，续约后结束 */
  rookieTeamId?: string;
  rookieUntil?: number;
  /** 最近一次「对薪资不满」新闻的回合键（赛季 × 100 + 回合）与当时的满意度等级（0/1/2） */
  newsKey?: number;
  newsLevel?: number;
  /** 最近一次离队申请被挽留（加薪 / 谈话成功）的回合键：之后一段时间内不再提出离队申请 */
  retainKey?: number;
  /**
   * 近期分到的赛事奖金余额（金币，第九波奖金分成；2026-10-10 起按回合衰减：结算时的回合键 prizeRound = 赛季 × 100 + 回合，
   * 旧存档只有赛季 prizeTi，按该赛季第 0 回合计；所在战队 prizeTeamId）：
   * 按「余额 / 窗口回合数」全额计入薪资满意度（salary.prizeSalaryCredit），换队后不再计入
   */
  prizeEarned?: number;
  prizeTi?: number;
  prizeRound?: number;
  prizeTeamId?: string;
}

/**
 * 挂牌转会：等待 AI 俱乐部出价，挂牌期一整个赛季（squadOps.listingDurationRounds）。
 * roundsLeft 在每个常规赛回合结束时递减（赛季初没有回合结算；TI 预选 / 正赛转会锁定期间暂停），
 * 归零且无待处理报价时：整个挂牌期无人报价 → 自动解约（无补偿）；收到过报价 → 挂牌结束、选手留队。
 */
export interface TransferListing {
  season: number;             // 挂牌时的赛季（TI 序号）
  listedRound: number;        // 挂牌时的回合
  roundsLeft: number;         // 剩余等待回合（含当前回合）
  askingPrice: number;        // 标价
  /** 挂牌期间是否收到过报价（收到过报价但未成交 → 挂牌结束、选手留队，不自动解约） */
  hadBids?: boolean;
  /** 挂牌规则版本（squadOps.LISTING_RULE_VERSION）；缺失 = 旧存档的「3 个转会回合」挂牌，读档 / 回合结算时按已经过的回合迁移 */
  v?: number;
  /** 挂牌期总回合数（挂牌时按 CONFIG 计算并固定） */
  totalRounds?: number;
  /** 已经历的出价机会次数（超过 CONFIG.squadOps.listingFreshRolls 后，标价高于身价时报价意愿逐次衰减） */
  bidRolls?: number;
}

export interface Coach {
  id: string;
  name: string;
  nationality: string;
  birthYear: number;          // 年龄仅用于展示（season.year - birthYear）；教练属性不随年龄变化
  tier: Tier;
  insight: number;
  talentBoost: number;        // 0..10
  resilienceBoost: number;    // 0..10
  salary: number;
  teamId: string | null;
  formerPlayerId?: string;    // 由退役选手转来
  /** 首次出现在游戏世界（教练市场）的赛季（第九波教练供给，coaches.ts；开局已有的教练记为起始赛季 - 1）。界面据此标记本赛季「新到」 */
  arrivedTi?: number;
}

export interface Lineup {
  C: string | null;
  M: string | null;
  O: string | null;
  SS: string | null;
  HS: string | null;
}

/** 一次俱乐部品牌变化（第十波 #4，branding.ts；Team.brandHistory） */
export interface TeamBrandChange {
  /** 生效的赛季（TI 序号） */
  season: number;
  from: { name: string; tag: string; color: string };
  to: { name: string; tag: string; color: string };
  /** 事实说明（branding.json 的 note，中文） */
  note?: string;
}

export interface Team {
  id: string;
  name: string;
  tag: string;
  region: Region;
  color: string;
  /** 本局中的品牌沿革（第十波 #4，branding.ts：赛季开始时按真实历史更名 / 换配色；按时间升序，旧存档缺失） */
  brandHistory?: TeamBrandChange[];
  honor: number;
  gold: number;
  isPlayer: boolean;
  playerIds: string[];        // 全部签约选手（含替补、临时替补）
  lineup: Lineup;
  coachId: string | null;
  disbanded?: boolean;
  /** 赛季巡回赛积分（赛季初清零） */
  points: number;
  /** 上赛季最终排名（1 起），用于邀请 */
  lastSeasonRank?: number;
  /** 最近一次团建的回合键（赛季 × 100 + 回合，squadOps.teamBuilding）：每回合最多一次 */
  lastTeamBuildingRound?: number;
  /**
   * 本回合已约过训练赛的对手（人类玩家战队；trainingLog.bookScrim）：每支对手每回合最多约练
   * CONFIG.training.scrimPerOpponentPerRound 次。key = 回合键（赛季 × 100 + 回合），与当前回合不符视为空；回合结束时清除。
   * 多人模式按各自战队记录（无需座位换入字段）
   */
  scrimBookings?: ScrimBookings;
  /** 经常性收入状态（赞助合同、周边热度；revenue.ts 维护，人机共用；旧存档可能缺失） */
  revenue?: TeamRevenueState;
  /** 最近一次假赛风波所在赛季（events.ts 冷却：CONFIG.events.matchFixingCooldownSeasons） */
  lastMatchFixingSeason?: number;
  /** 俱乐部全员假赛被永久禁赛（scandal.ts；同时 disbanded = true） */
  banned?: { season: number; round: number; date: string };
  /** 因全员假赛除名的俱乐部的补位新组织：被替换的战队 id（scandal.ts） */
  replacesTeamId?: string;
  /** 开局之后才成立的俱乐部（第十波 #2，clubs.ts）：真实组织在现实首次出现的赛季加入联赛 / 偶尔成立的虚构新组织 */
  founded?: TeamFounding;
  /** 俱乐部使命进度（第十波 #3，missions.ts；AI 真实俱乐部组建现实巅峰阵容；旧存档缺失时首次刷新补齐） */
  mission?: TeamMissionState;
  /**
   * 选手奖金分成比例 ∈ [0.5, 1]（第九波，prizeShare.ts）：赛事奖金的该比例分给队员，俱乐部拿剩余部分
   * （出场费与经常性收入全归俱乐部）。旧存档缺失时按默认值补齐（prizeShare.ensurePrizeShares）
   */
  prizeShare?: number;
  /** 最近一次调整奖金分成的回合键（赛季 × 100 + 回合）：每回合最多调整一次 */
  prizeShareRoundKey?: number;
  /** 最近一次下调奖金分成的回合键：下调后一段时间内调回下调前的水平不带来即时归属感加成 */
  prizeShareCutKey?: number;
  /** 下调前的分成比例（冷静期内连续下调取最高值）：冷静期内只有超出该水平的上调才有即时加成 */
  prizeShareCutFrom?: number;
  /** 最近的奖金分成调整（最新在后，保留 CONFIG.prizeShare.logMax 条） */
  prizeShareLog?: PrizeShareChange[];
  /**
   * 资金连续为负的回合数（第十波 #1，bankruptcy.ts；只记人类战队）：回合结算后资金 < 0 时 +1，≥ 0 时清除。
   * 达到 CONFIG.bankruptcy.rounds 即破产
   */
  negativeFundsRounds?: number;
  /**
   * 本轮连续为负期间（各回合结算时）的最高每回合工资（第十波 #1，bankruptcy.ts）：负债上限按「当前工资」与它的较高者计算，
   * 避免负债期间裁员 / 解约降低工资后上限随之下降、反而立即触发破产；资金回正时与 negativeFundsRounds 一起清除
   */
  negativeFundsWageBill?: number;
  /** 俱乐部破产（第十波 #1，bankruptcy.ts；同时 disbanded = true） */
  bankrupt?: BankruptcyRecord;
  /**
   * 荣誉势头（第十四波，momentum.ts）：赛季初按荣誉同比平移全队赛季状态均值；赛季中按荣誉环比（指数平滑）
   * 小幅调整战队级战力乘子（team.teamRating 读取）。人机共用；旧存档缺失 = 中性（乘子 1）；已解散战队在赛季初清除
   */
  momentum?: TeamMomentum;
  /** 新秀抽卡计数（gacha.ts：SSR 保底、累计 / 本赛季张数、人类玩家本赛季记录）；旧存档缺失 = 未抽过 */
  gacha?: TeamGachaState;
}

/**
 * 战队荣誉势头（Team.momentum；见 momentum.ts）。只存原始量，同比平移（momentum.teamYoyShift）
 * 与回合乘子（momentum.teamMomentumMult）按 CONFIG.form.honorMomentum 即时推导
 */
export interface TeamMomentum {
  /** 上赛季初荣誉（同比基准；第一个赛季缺失） */
  prevSeasonStart?: number;
  /** 本赛季初荣誉 */
  seasonStart: number;
  /** 荣誉环比的指数平滑（相对荣誉规模的比例，无单位，保留 4 位小数） */
  ewma: number;
  /** 上次回合结算时的荣誉（环比基准） */
  lastHonor: number;
  /** 赛季中途建立的记录（旧存档 / 赛季中成立的战队）：seasonStart 不是季初荣誉，下个赛季初不作为同比基准 */
  partial?: boolean;
}

/** 破产记录（Team.bankrupt） */
export interface BankruptcyRecord {
  season: number;             // TI 序号
  round: number;
  date: string;
  /** 触发规则：rounds 资金连续为负达到上限 / debt 负债超过若干回合工资 */
  rule: 'rounds' | 'debt';
  /** 破产时的资金（负数）与每回合工资（选手 + 教练） */
  gold: number;
  wageBill: number;
  /** 破产时资金已连续为负的回合数 */
  negativeRounds: number;
}

/** 本回合的训练赛预约（Team.scrimBookings） */
export interface ScrimBookings {
  /** 回合键：赛季 × 100 + 回合 */
  key: number;
  /** 本回合已约练的对手战队 id（按约练顺序，可重复计次） */
  teamIds: string[];
}

/** 一次奖金分成调整（Team.prizeShareLog） */
export interface PrizeShareChange {
  season: number;             // TI 序号
  round: number;
  from: number;
  to: number;
  /** AI 战队调整的原因（中文，如「资金紧张」）；玩家调整缺省 */
  reason?: string;
}

/** 赛季赞助合同：赛季内首次结算收入时按荣誉 + 上赛季排名签订，每回合支付，下赛季重新谈判 */
export interface SponsorContract {
  season: number;             // 合同所属赛季（TI 序号）
  perRound: number;           // 每回合金额（金币）
  level: string;              // 合同档次（中文，如「主赞助」）
}

/** 周边热度加成：赛事夺冠 / TI 好成绩后若干回合内的额外周边收入 */
export interface MerchBoost {
  tournamentId: string;       // 来源赛事（去重）
  perRound: number;           // 每回合额外金额
  roundsLeft: number;         // 剩余回合
  source: string;             // 中文说明，如「TI9 冠军」
}

export interface TeamRevenueState {
  sponsor?: SponsorContract;
  merchBoosts?: MerchBoost[];
}

// ---------------------------------------------------------------------------
// 日历
// ---------------------------------------------------------------------------

export interface RoundInfo {
  index: number;              // 0..total-1
  phase: SeasonPhase;
  startDate: string;
  endDate: string;
  tournamentIds: string[];    // 本回合进行的赛事实例 id
  patchVersions: string[];    // 本回合开始时生效的版本
}

export interface Season {
  ti: number;
  year: number;
  startDate: string;
  tiStartDate: string;
  rounds: RoundInfo[];
  /** 玩家已报名/受邀的赛事实例 id（不含 TI） */
  registeredTournamentIds: string[];
  extraTrainingsBought: number; // 本赛季已购额外训练次数（价格递增依据）
  /** 赛季开始时玩家战队的荣誉/资金（赛季总结用） */
  honorStart?: number;
  goldStart?: number;
}

// ---------------------------------------------------------------------------
// 赛事运行时
// ---------------------------------------------------------------------------

export type PlayerEntryStatus = 'invited' | 'open' | 'locked' | 'registered' | 'declined';

export interface SeriesResult {
  winnerId: string;
  loserId: string;
  scoreA: number;
  scoreB: number;
  games: GameRecord[];
  /** 弃权判负的一方（首发凑不齐 5 人且未招募临时替补）；此时 games 为空、胜方记满胜局 */
  forfeit?: 'A' | 'B';
}

export interface Series {
  id: string;
  tournamentId: string;
  stageId: string;
  label: string;              // 中文，如 "A组 第3轮" "胜者组半决赛"
  teamA: string | null;       // 可能等待上一场结果
  teamB: string | null;
  bestOf: 1 | 2 | 3 | 5;
  result?: SeriesResult;
  /** 双败/单败树中：胜者/败者去向 */
  winnerTo?: { seriesId: string; slot: 'A' | 'B' };
  loserTo?: { seriesId: string; slot: 'A' | 'B' };
  /** 被淘汰者获得的名次区间（淘汰赛） */
  loserPlacement?: [number, number];
  round: number;              // 阶段内轮次（用于推进顺序）
}

export interface GroupStanding {
  teamId: string;
  wins: number;               // 系列赛胜
  draws: number;
  losses: number;
  gameWins: number;
  gameLosses: number;
}

export interface Stage {
  id: string;
  type: 'qualifier' | 'groups' | 'playoffs';
  format: 'se' | 'de' | 'rr';
  name: string;               // 中文
  teamIds: string[];
  groups?: { name: string; teamIds: string[]; standings: GroupStanding[] }[];
  advanceCount?: number;      // 每组/整体晋级数
  seriesIds: string[];
  done: boolean;
  /** 本阶段晋级/胜出的队伍（预选赛晋级者；淘汰赛最终胜者即冠军；小组赛按种子顺序的出线队） */
  advancedTeamIds?: string[];
}

export interface TournamentPlacement {
  teamId: string;
  rankFrom: number;
  rankTo: number;
  prize: number;
  points: number;
}

export interface Tournament {
  id: string;                 // 实例 id（= template.id 或 "ti-{n}"）
  seriesId: string;
  name: string;
  tier: TournamentTier;
  season: number;             // TI 序号
  roundIndex: number;         // 所在大回合
  startDate: string;
  city: string;
  hostRegion: Region;
  online: boolean;
  prizePool: number;
  appearanceFee: number;      // 出场费（每队）
  format: TournamentFormatPreset;
  teamIds: string[];          // 正赛（含经预选晋级）队伍
  invitedTeamIds: string[];
  qualifierTeamIds: string[]; // 参加封闭预选的队伍
  regionLocked?: Region;
  stages: Stage[];
  series: Record<string, Series>;
  status: 'scheduled' | 'running' | 'finished';
  placements: TournamentPlacement[];
  /** 玩家对该赛事的报名状态 */
  playerStatus: PlayerEntryStatus;
  /**
   * 玩家当前报名 / 接受邀请所在的回合（座位私有，第十四波）：赛季初的邀请缺省（按 0），赛季中补充邀请为收到通知的回合，
   * 主动报名 / 重新接受为操作时的回合；退出 / 婉拒后清除。在同一回合内退出免扣荣誉（schedule.withdrawPenaltyOf）
   */
  entryRound?: number;
  minHonor: number;
  /** 赛前预期名次（玩家，开赛时计算） */
  expectedRank?: number;
  /** 玩家赛事结算明细 */
  settlement?: TournamentSettlement;
  /** 正赛队伍数：开赛前为模板目标值，开赛后为实际值（含预选晋级名额） */
  size?: number;
  /** 封闭预选赛晋级正赛的名额（无预选时为 0） */
  qualifierSlots?: number;
  /** 全部参赛队的赛前预期名次（开赛时计算，用于荣誉结算） */
  expectedRanks?: Record<string, number>;
  /** TI 赛区预选赛：前 slots 名晋级 tiId */
  advanceToTi?: { tiId: string; slots: number };
  /** 本赛事中玩家宿敌对决累计荣誉（逐场已结算，仅用于结算展示） */
  playerBeefHonor?: number;
  /** 不计巡回赛积分（如补位的线上公开赛；奖金/荣誉/成长照常） */
  noCircuitPoints?: boolean;
  /**
   * 模板的直邀名额（第十四波：赛季中补充邀请按本赛季积分榜排名 ≤ 此值评估；旧存档缺失时按赛季初受邀队数）
   */
  inviteSlots?: number;
  /**
   * 赛季中的补充邀请（第十四波，schedule.refreshSeasonInvites）：teamId → 收到邀请后首个可行动的回合（发出邀请的回合 + 1）。
   * 补邀的队伍同时追加到 invitedTeamIds（不撤销已有邀请）；人类战队在该回合内婉拒免扣荣誉；AI 自动接受
   */
  lateInvites?: Record<string, number>;
}

export interface TournamentSettlement {
  tournamentId: string;
  rankFrom: number;
  rankTo: number;
  teams: number;
  prize: number;
  appearanceFee: number;
  points: number;
  honor: HonorBreakdown;
  /** 参赛选手的赛事成长（resilience：成长重平衡后新增的韧性成长，旧存档缺失 = 0） */
  playerGrowth: { playerId: string; power: number; mmr: number; insight: number; resilience?: number }[];
  /**
   * 奖金分成（第九波）：prize 为名次奖金总额，其中俱乐部实得 prizeClub、队员分得 prizePlayers（当时分成比例 prizeShare）。
   * 旧存档缺失 = 奖金全归俱乐部
   */
  prizeClub?: number;
  prizePlayers?: number;
  prizeShare?: number;
}

export interface HonorBreakdown {
  tierBase: number;
  expected: number;           // 预期名次
  actual: number;             // 实际名次（区间中点）
  expTerm: number;
  yoyTerm: number;            // 同比
  momTerm: number;            // 环比
  placeBonus: number;
  beef: number;
  total: number;
}

// ---------------------------------------------------------------------------
// 比赛（单局）
// ---------------------------------------------------------------------------

export type DraftActionType = 'ban' | 'pick';
export interface DraftStep {
  side: 'A' | 'B';
  type: DraftActionType;
}

export interface DraftAction extends DraftStep {
  heroId: string;
  /** pick 时指派给哪个位置 */
  position?: Position;
  playerId?: string;
}

export interface DraftState {
  sequence: DraftStep[];
  actions: DraftAction[];
  available: string[];        // 可用英雄 id
  done: boolean;
}

export interface DraftEvaluation {
  scoreA: number;
  scoreB: number;
  dotaPlusWinRateA: number;   // 大老师胜率（A 方）
  notes: string[];            // 中文点评，如 "天辉方阵容后期更强"
}

export interface InMatchEvent {
  minute: number;
  playerId: string;
  teamId: string;
  text: string;
  powerMult: number;          // 本局临时战力倍数
}

/** rampage = 暴走（一波团战一人五杀）；godlike = 超神（连续击杀 10 次以上未被终结） */
export type LiveEventType =
  | 'start' | 'firstblood' | 'kill' | 'teamfight' | 'tower' | 'roshan' | 'barracks'
  | 'buyback' | 'rampage' | 'godlike' | 'highground' | 'comeback' | 'incident' | 'gg' | 'info';

export interface LiveEvent {
  minute: number;
  second: number;
  type: LiveEventType;
  text: string;               // 中文直播文本
  side?: 'A' | 'B';
  killsA: number;
  killsB: number;
  goldDiff: number;           // A - B
}

export interface GameRecord {
  index: number;              // 系列赛第几局
  teamA: string;
  teamB: string;
  radiant: 'A' | 'B';
  draft: DraftAction[];
  eval: DraftEvaluation;
  strengthA: number;
  strengthB: number;
  winProbA: number;           // 最终胜率
  winner: 'A' | 'B';
  durationMin: number;
  killsA: number;
  killsB: number;
  incidents: InMatchEvent[];
  live: LiveEvent[];          // 只为玩家比赛生成完整直播；AI 比赛为空数组
  mvpPlayerId?: string;
  // 逐局个人 K/D/A 不存储（DotaPedia 只存聚合）；旧存档残留的 box 字段由 stats.stripLegacyGameBoxes 清除
}

// ---------------------------------------------------------------------------
// 事件 & 消息
// ---------------------------------------------------------------------------

export type EventKind =
  | 'match_fixing' | 'heartbreak' | 'visa' | 'scandal' | 'beef' | 'unpaid_salary'
  | 'hot_streak' | 'sponsor' | 'injury' | 'stream_deal' | 'fan_meeting' | 'leave_request'
  | 'poach' | 'contract' | 'retire' | 'rookie_home' | 'other';

export interface EventChoice {
  id: string;
  label: string;              // 中文
  description?: string;
}

export interface PendingDecision {
  id: string;
  kind: EventKind;
  title: string;
  body: string;
  choices: EventChoice[];
  /** 事件处理所需上下文（序列化友好） */
  ctx: Record<string, string | number | boolean | null>;
  createdRound: number;
  /** 必须在推进回合前处理 */
  blocking: boolean;
}

export type NewsCategory = 'event' | 'match' | 'transfer' | 'patch' | 'finance' | 'tournament' | 'season' | 'system';

export interface NewsItem {
  id: string;
  season: number;
  round: number;
  date: string;
  category: NewsCategory;
  title: string;
  body: string;
  important?: boolean;
  read?: boolean;
  /** 相关战队（第一个为主角）；未显式给出时由 news.addNews 从标题/正文识别 */
  teamIds?: string[];
  /** 相关选手；未显式给出时由 news.addNews 在相关战队与玩家战队名单中识别 */
  playerIds?: string[];
  /** mine = 与（任一）玩家战队相关；world = 世界新闻。旧存档缺失时按 news.newsScopeOf 推断 */
  scope?: NewsScope;
  /** 多人模式广播口径：private 只对相关座位可见（财务明细等） */
  visibility?: NewsVisibility;
  /** 触发此新闻的（玩家）战队 */
  actorTeamId?: string;
  /** 标签：weekly 刀塔周报 / digest 要闻 / champion / upset / record / trend / tier / big-transfer … */
  tags?: string[];
}

export type NewsScope = 'mine' | 'world';
export type NewsVisibility = 'public' | 'private';

/** 回合要闻（newsroom.ts 在每回合推进后生成，UI 的 RoundDigest 展示） */
export interface NewsDigest {
  /** 生成要闻时所在的赛季/回合（要闻覆盖自上一期以来的全部新闻：刚结束的回合 + 新回合开始时的动态） */
  season: number;
  round: number;
  /** 生成时（新回合）的日期 */
  date: string;
  /** 标题，如「TI9 · 第3回合要闻」「TI9 落幕 · 休赛期要闻」 */
  title: string;
  /** 按重要度排序的新闻 id（可能已被清理，UI 需容错） */
  items: string[];
}

/** 新闻编辑部的跨回合记忆（newsroom.ts；全局世界状态，非座位私有） */
export interface NewsroomState {
  /** 已生成要闻时的 idCounter 水位：之后创建的新闻进入下一期要闻 */
  digestMark?: number;
  /** 刀塔周报期数 */
  weeklyIssue?: number;
  /** 上期周报的 idCounter 水位（统计转会动态窗口） */
  weeklyMark?: number;
  /** 上期周报的实力榜（teamId，按名次） */
  powerRanking?: string[];
  /** 周报统计基线：playerId -> [MVP, 胜局, 局数] */
  statBase?: Record<string, [number, number, number]>;
  /** 选手天梯等级快照：playerId -> tierIndex */
  tiers?: Record<string, number>;
  /** 已处理的 history.tournaments 条数 */
  historyCursor?: number;
  /** 连续早早出局：teamId -> 最近的出局赛事（名称·名次·是否小组出局） */
  slumps?: Record<string, {
    n: number; groups: number; last: string[];
    /** 其中赛前预期进入前半区的场次 */ d?: number;
    /** 上次报道时的 n（之后每再 slumpRepeat 项报道一次） */ r?: number;
  }>;
  /** 连胜冠军：teamId -> 连续夺冠数（按该队参加的赛事） */
  titleStreaks?: Record<string, number>;
  /** 上期周报时 history.tournaments 的条数（「近期冠军」窗口） */
  weeklyHistoryCursor?: number;
}

export interface Beef {
  teamId: string;             // 宿敌战队
  season: number;
  winHonor: number;
  loseHonor: number;
}

/** 延迟触发的事件（如假赛冷处理后东窗事发），在到期回合开始时由 events.rollRoundEvents 处理 */
export interface DelayedEvent {
  id: string;
  kind: EventKind;
  season: number;             // 触发赛季（TI 序号）
  round: number;              // 触发回合（≥ 此回合即触发；跨赛季则立即触发）
  ctx: Record<string, string | number | boolean | null>;
}

// ---------------------------------------------------------------------------
// 市场
// ---------------------------------------------------------------------------

export interface TransferOffer {
  id: string;
  playerId: string;
  fromTeamId: string;         // 出价方
  toTeamId: string;           // 卖方（选手当前所属）
  fee: number;
  salary: number;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdRound: number;
  expiresRound: number;
  /** 报价所在赛季（TI 序号）；跨赛季的报价自动过期 */
  season?: number;
  /** 由低归属感挖角事件产生（关联 PendingDecision kind 'poach'） */
  poach?: boolean;
  /** 针对挂牌选手的出价（squadOps.processTransferListings） */
  listing?: boolean;
}

/** 选手的选秀出身（Player.draft） */
export interface PlayerDraftInfo {
  ti: number;                 // 选秀所在赛季（TI 序号）
  round: number;              // 第几轮（1 起）
  pick: number;               // 总顺位（1 起）
  teamId: string;             // 选中他的战队
}

/** 一个选秀顺位（RookieDraftRecord.picks） */
export interface RookieDraftPick {
  round: number;              // 第几轮（1 起）
  pick: number;               // 总顺位（1 起）
  teamId: string;
  /** 选中的新秀（现行规则下每个顺位都会选人；缺省只出现在旧存档中） */
  playerId?: string;
  /** 旧存档兼容：旧规则下「阵容已满放弃该顺位」的标记（现行规则不再放弃顺位） */
  forfeited?: boolean;
  /** 首轮经抽签产生的顺位 */
  lottery?: boolean;
  /** 选中时的快照（选手日后可能被清理/改变） */
  handle?: string;
  tier?: Tier;
  position?: Position;
  isReal?: boolean;
  power?: number;
  talent?: number;
  age?: number;
  salary?: number;
  contractUntil?: number;
  /** 赛季初被所属玩家免费放弃，或 AI 战队选秀后整理阵容时放走（进入自由市场） */
  released?: boolean;
}

/** 选秀抽签的参与者（RookieDraftRecord.lottery） */
export interface RookieDraftLotteryEntry {
  teamId: string;
  /** 上赛季最终排名（1 = 最好；首个赛季为初始实力/荣誉排名） */
  standing: number;
  /** 抽签前的顺位（1 = 排名最差） */
  seed: number;
  /** 抽签权重与抽中状元签的概率 */
  weight: number;
  oddsFirst: number;
  /** 进入前 lotteryPicks 顺位的概率 */
  oddsTop: number;
  /** 最终首轮顺位 */
  finalPick: number;
  /** 是否在抽签中被抽中（前 lotteryPicks 顺位） */
  won: boolean;
}

/** 一届选秀的结果（全局世界状态，所有玩家可见） */
export interface RookieDraftRecord {
  ti: number;
  rounds: number;
  /** 首个赛季：顺位依据初始实力 + 荣誉排名（无上赛季成绩） */
  firstSeason?: boolean;
  /** 首轮顺位（teamId，第 1 顺位在前） */
  order: string[];
  /** teamId → 上赛季最终排名（选秀依据） */
  standings: Record<string, number>;
  lotteryPicks: number;
  lottery: RookieDraftLotteryEntry[];
  picks: RookieDraftPick[];
  /** 新秀池：真实新秀 / 程序生成人数 */
  realCount: number;
  generatedCount: number;
  /** 本届新秀池中的 SSR 人数 */
  ssrCount: number;
  /** 落选新秀（进入自由市场） */
  undrafted: string[];
}

/** 新秀选秀的跨赛季状态（GameState.rookieDraft；全局，非座位私有） */
export interface RookieDraftState {
  /** 距上一名 SSR 新秀已出现的新秀人数（跨赛季；任何 SSR 新秀出现即清零） */
  ssrPity: number;
  /** 往届选秀（按时间，最新在后；保留 CONFIG.draft.historyMax 届） */
  history: RookieDraftRecord[];
}

export interface FinanceEntry {
  season: number;
  round: number;
  amount: number;             // 正=收入，负=支出
  category: 'prize' | 'appearance' | 'salary' | 'coach_salary' | 'transfer_in' | 'transfer_out'
    | 'signing' | 'training' | 'scrim' | 'gacha' | 'temp_sub' | 'event' | 'other'
    /** 经常性收入（revenue.ts）：赞助 / 直播与内容 / 周边 */
    | 'sponsor' | 'streaming' | 'merch';
  note: string;
}

// ---------------------------------------------------------------------------
// 历史
// ---------------------------------------------------------------------------

export interface TournamentHistoryEntry {
  tournamentId: string;
  seriesId: string;
  name: string;
  tier: TournamentTier;
  season: number;
  championId: string;
  /** teamId -> [rankFrom, rankTo, teamsCount] */
  placements: Record<string, [number, number, number]>;
}

export interface SeasonSummary {
  ti: number;
  year: number;
  tiChampionId: string | null;
  playerTiRank: [number, number] | null;  // null = 未参加
  playerTitles: string[];     // 本赛季冠军赛事名称
  honorStart: number;
  honorEnd: number;
  goldStart: number;
  goldEnd: number;
  finalRank: number;          // 赛季积分排名
  retired: string[];          // 退役选手 handle
  notes: string[];
}

// ---------------------------------------------------------------------------
// 游戏状态（存档即序列化此对象）
// ---------------------------------------------------------------------------

export interface GameSettings {
  startTi: number;
  seasons: number;            // N
  endTi: number;              // startTi + N - 1
  difficulty: 'easy' | 'normal' | 'hard';
  playerTeamId: string;
  managerName: string;
}

export interface ActiveMatch {
  tournamentId: string;
  seriesId: string;
  gameIndex: number;          // 当前进行到第几局（0 起）
  draft: DraftState | null;
  phase: 'pre' | 'draft' | 'live' | 'result';
  manualDraft: boolean;
  /** 本局已生成但尚未"播放完"的记录 */
  pendingGame?: GameRecord;
  /** 本系列赛已提交的各局记录（系列赛结束后写入 SeriesResult.games） */
  games?: GameRecord[];
}

/**
 * completed 生涯期满 / disbanded 荣誉跌破 0 解散 / banned 俱乐部全员假赛被永久禁赛（scandal.ts）/
 * bankrupt 资金持续为负或负债过高而破产（bankruptcy.ts，第十波 #1）
 */
export type GameOverReason = 'completed' | 'disbanded' | 'banned' | 'bankrupt';

// ---- 俱乐部全员假赛（scandal.ts；全局世界状态，非座位私有）----

/** 本赛季已掷出的全员假赛（赛季初每队掷一次，命中则在赛季内随机常规回合曝光） */
export interface ClubScandalPlan {
  teamId: string;
  season: number;             // TI 序号
  round: number;              // 曝光回合（常规赛回合）
  fired?: boolean;
}

/** 已曝光的全员假赛（历史档案） */
export interface ClubBanRecord {
  teamId: string;
  name: string;
  tag: string;
  season: number;
  round: number;
  date: string;
  /** 被永久禁赛的选手（handle） */
  players: string[];
  human: boolean;
  /** 补位的新组织（AI 俱乐部被除名时） */
  replacementId?: string;
}

export interface ClubScandalState {
  plans: ClubScandalPlan[];
  history: ClubBanRecord[];
}

// ---- 新俱乐部涌现 / 俱乐部使命（第十波 #2 #3：clubs.ts / missions.ts；全局世界状态，非座位私有）----

/** 俱乐部成立记录（Team.founded） */
export interface TeamFounding {
  /** 成立的赛季（TI 序号） */
  ti: number;
  /** real = 真实组织（src/data/clubIndex.json）；fictional = 虚构新组织 */
  kind: 'real' | 'fictional';
  /** 真实组织 id（clubIndex.json 的 orgs[].id） */
  orgId?: string;
}

/** 俱乐部使命进度（Team.mission）：使命目标（现实巅峰阵容）是静态数据，这里只记进度与里程碑 */
export interface TeamMissionState {
  /** 最近一次刷新时已在队的使命成员数（0..5） */
  have: number;
  /** 首次 / 最近一次集齐的赛季（TI 序号） */
  firstCompletedTi?: number;
  completedTi?: number;
  /** 集齐状态下夺得的 TI（TI 序号，升序） */
  tiTitles?: number[];
}

/** 新俱乐部涌现记录（GameState.clubFounding） */
export interface ClubFoundingState {
  /** 最近一次处理的赛季（TI 序号；同一赛季只处理一次） */
  ti: number;
  /** 历次成立（按时间） */
  founded: { ti: number; teamId: string; kind: 'real' | 'fictional' }[];
  /** 为给新俱乐部腾出联赛席位而解散的 AI 俱乐部（按时间） */
  retired: { ti: number; teamId: string }[];
}

// ---- 生涯总结（legacy.ts；按战队记录的公开生涯档案，全局世界状态）----

/** 某人类战队一个赛季的生涯档案（赛季结算时记录；出局 / 禁赛时记录截至当时的部分赛季） */
export interface LegacySeasonRecord {
  ti: number;
  year: number;
  /** 赛季末战力排名（rankTeamsByRating）与参与排名的队伍数 */
  strengthRank: number;
  strengthTeams: number;
  /** 赛季综合排名（积分 + TI 名次） */
  finalRank: number;
  /** TI 名次（未参加 = null）与参赛队数 */
  tiRank: [number, number] | null;
  tiTeams: number;
  /** 本赛季冠军（不含预选赛级别） */
  titles: { name: string; tier: TournamentTier }[];
  honorEnd: number;
  goldEnd: number;
  /** 本赛季关键时刻（中文短句） */
  moments: string[];
  /** 赛季末阵容（正式队员，按评分降序） */
  squad: { id: string; handle: string; position: Position; rating: number; tier: Tier }[];
  /** 非完整赛季（出局 / 禁赛时截止） */
  partial?: boolean;
  /** 该赛季以何种方式结束执教（仅 partial 记录） */
  ending?: GameOverReason;
}

// ---- DotaPedia 统计（stats.ts 记录，pedia.ts 查询；GameState.pedia，全局公开数据，非座位私有）----
// 只保存聚合（AI 对局不留逐局日志）：选手按「赛季 × 战队」分行、战队按赛季分行、英雄按赛季汇总、少量单局纪录。
// 数组元组是为了控制存档体积（每个字段的含义见注释）。

/**
 * 选手分赛季 / 分战队数据行（PediaPlayer.s）：
 * [0 TI 序号, 1 战队 id, 2 局数, 3 胜局, 4 击杀, 5 死亡, 6 助攻, 7 MVP, 8 奖金（队员分成，金币）, 9 系列赛胜, 10 系列赛平, 11 系列赛负]
 */
export type PediaPlayerSeason = [number, string, number, number, number, number, number, number, number, number, number, number];

/** 选手档案（PediaState.players） */
export interface PediaPlayer {
  /** 显示名 / 位置快照（程序生成的退役选手会从 state.players 清理，DotaPedia 仍保留其历史） */
  n: string;
  p: Position;
  /** 分赛季 / 分战队数据（按时间） */
  s: PediaPlayerSeason[];
  /** 英雄：heroId → [局数, 胜局]（赛季末只保留局数最多的 CONFIG.pedia.heroesPerPlayer 个，其余并入 ho） */
  h: Record<string, [number, number]>;
  /** 被合并的其他英雄 [局数, 胜局] */
  ho?: [number, number];
  /** 当前 / 最长连胜（局） */
  cs: number;
  bs: number;
  /** 巅峰天梯等级（TIERS 下标，尚未有赛季末快照时为 -1）与巅峰综合评分（每个赛季末更新） */
  pt: number;
  pr: number;
}

/** 战队一个赛季的数据（PediaTeam.s） */
export interface PediaTeamSeason {
  ti: number;
  /** 系列赛 胜 / 平 / 负（含弃权） */
  sw: number;
  sd: number;
  sl: number;
  /** 小局 胜 / 负 */
  gw: number;
  gl: number;
  /** 小局击杀 / 阵亡合计 */
  k: number;
  d: number;
  /** 小局时长合计（分钟；场均时长 = m / (gw + gl)；旧数据缺失） */
  m?: number;
  /** 赛事奖金：俱乐部所得 / 队员分成（金币） */
  pc: number;
  pp: number;
  /** 赛季末快照（season.settleSeason → stats.recordPediaSeasonEnd）：荣誉、综合排名、实力排名 / 参与排名的队数 */
  h?: number;
  fr?: number;
  sr?: number;
  st?: number;
  /** 赛季末阵容（正式队员 id，按评分降序） */
  r?: string[];
  /** 赛季末主教练 [id, 名字]（教练可能被清理，保留名字） */
  c?: [string, string] | null;
}

/** 战队档案（PediaState.teams） */
export interface PediaTeam {
  /** 名称 / 简称快照（解散 / 除名的战队仍可查看） */
  n: string;
  tag: string;
  s: PediaTeamSeason[];
  /** 系列赛当前 / 最长连胜；小局当前 / 最长连胜 */
  scs: number;
  sbs: number;
  gcs: number;
  gbs: number;
}

/** 一项已结束赛事的补充记录（PediaState.tours[赛事 id]；名称 / 等级 / 全部名次见 history.tournaments） */
export interface PediaTournament {
  /** 赛季（TI 序号）与开赛日期 */
  s: number;
  d: string;
  /** 显示用真实奖金池（美元） */
  pool: number;
  /** 冠亚军（TI 为全部正赛队伍）与当时的首发：[战队 id, 名次起, 名次止, 首发 id] */
  top: [string, number, number, string[]][];
  /** 名次奖金：战队 id → [俱乐部所得, 队员分成]（只记有奖金的战队） */
  pz: Record<string, [number, number]>;
}

/** 英雄一个赛季的数据：[出场, 胜, 击杀, 死亡, 助攻, 被禁（只统计有完整 BP 的对局）] */
export type PediaHeroLine = [number, number, number, number, number, number];

/** 单局纪录种类：个人击杀 / 助攻 / 阵亡最多、战队单局击杀最多、单局双方击杀最多、最长 / 最短对局 */
export type PediaRecordKind = 'kills' | 'assists' | 'deaths' | 'teamKills' | 'totalKills' | 'longest' | 'shortest';

/** 一条单局纪录（先创造者保持；追平不替换） */
export interface PediaRecord {
  /** 纪录数值（击杀数 / 分钟） */
  v: number;
  /** 赛季与日期 */
  ti: number;
  d: string;
  /** 创造纪录的战队与对手 */
  t: string;
  o: string;
  /** 选手 / 英雄（个人纪录） */
  p?: string;
  h?: string;
  tier: TournamentTier;
}

/** DotaPedia 统计状态（GameState.pedia） */
export interface PediaState {
  /** 格式版本 */
  v: number;
  /** 已记录的对局数（同时作为每局子随机流的序号；不消耗主随机序列） */
  seq: number;
  /** 开始记录的赛季 / 回合（旧存档从中途开始记录） */
  since: [number, number];
  /** 1 = 统计覆盖整个执教生涯（创建时全联盟还没有任何已赛对局）；旧存档中途开始记录时缺省 */
  full?: 1;
  players: Record<string, PediaPlayer>;
  teams: Record<string, PediaTeam>;
  tours: Record<string, PediaTournament>;
  /** 英雄：TI 序号 → heroId → 数据 */
  heroes: Record<string, Record<string, PediaHeroLine>>;
  /** 每赛季：TI 序号 → [对局数, 击杀合计, 时长合计（分钟）] */
  seasons: Record<string, [number, number, number]>;
  records: Partial<Record<PediaRecordKind, PediaRecord>>;
}

export interface GameState {
  version: number;            // 存档格式版本
  id: string;
  createdAt: string;
  settings: GameSettings;
  rngState: number;
  idCounter: number;

  season: Season;
  roundIndex: number;
  phase: SeasonPhase;
  currentDate: string;
  currentPatch: string;
  appliedPatches: string[];
  heroMeta: Record<string, number>;   // 当前版本英雄强度 -2..+2

  teams: Record<string, Team>;
  players: Record<string, Player>;
  coaches: Record<string, Coach>;
  tournaments: Record<string, Tournament>;
  /** 本赛季赛事实例 id（按日期排序） */
  seasonTournamentIds: string[];

  /** 真实新秀待登场队列：id -> 登场 TI 序号 */
  futureRookies: Record<string, number>;
  /** 第八波之前的旧版抽卡池（选手 id 列表；恒为空，仅为旧存档兼容保留；2026-10-14 回归的抽卡见 gacha） */
  gachaPool: string[];
  gachaPity: number;          // 旧版抽卡保底计数（已废弃；新版保底计数在 Team.gacha.pity）
  /** 新秀选秀（rookieDraft.ts；全局世界状态；旧存档可能缺失） */
  rookieDraft?: RookieDraftState;
  /** 新秀抽卡（gacha.ts，2026-10-14 起取代选秀；全局世界状态，卡池所有座位共享；旧存档在下个赛季初建池） */
  gacha?: GachaState;
  /** 名人堂（hallOfFame.ts；全局公开数据；旧存档读档时补建） */
  hallOfFame?: HallOfFameState;
  transferOffers: TransferOffer[];
  /** 当前可选的临时替补（player id） */
  tempSubCandidates: string[];

  activeMatch: ActiveMatch | null;
  /** 本回合是否已使用免费训练 */
  freeTrainingUsed: boolean;
  /** 本回合已购额外训练（未使用的） */
  extraTrainingAvailable: number;
  extraTrainingBoughtThisRound: number;
  trainingFocus: TrainingFocus;

  beefs: Beef[];
  pendingDecisions: PendingDecision[];
  /** 延迟事件队列（可选，旧存档可能缺失） */
  delayedEvents?: DelayedEvent[];
  news: NewsItem[];
  /** 最近一期回合要闻（newsroom.ts；旧存档可能缺失） */
  lastDigest?: NewsDigest | null;
  /** 新闻编辑部记忆（newsroom.ts；旧存档可能缺失） */
  newsroom?: NewsroomState;
  finance: FinanceEntry[];

  history: {
    tournaments: TournamentHistoryEntry[];
    seasons: SeasonSummary[];
    honor: { season: number; round: number; value: number }[];
    gold: { season: number; round: number; value: number }[];
    /** 玩家参加过的赛事结算，按时间 */
    playerSettlements: TournamentSettlement[];
    /** 玩家战队训练记录（按时间，保留最近 CONFIG.training.logMaxRecords 条；旧存档可能缺失） */
    training?: TrainingRecord[];
    /** 玩家战队选手的回合成长快照：playerId -> 按时间排序的快照（旧存档可能缺失） */
    squadProgress?: Record<string, SquadProgressPoint[]>;
  };

  /** 待 UI 弹出的结算/总结（UI 展示后清空） */
  popups: Popup[];

  gameOver: null | { reason: GameOverReason; summary: string };

  /** 俱乐部全员假赛：本赛季计划 + 历史档案（scandal.ts；全局；旧存档可能缺失） */
  clubScandals?: ClubScandalState;
  /** 最近一次赛季教练供给记录（第九波 #3，coaches.ts；全局；旧存档可能缺失） */
  coachSupply?: CoachSupplyRecord;
  /** 新俱乐部涌现（第十波 #2，clubs.ts；全局世界状态，非座位私有；旧存档缺失时按需创建） */
  clubFounding?: ClubFoundingState;
  /** 生涯档案：人类战队 id → 各赛季记录（legacy.ts；全局公开数据，多人模式各座位视图都可读；旧存档可能缺失） */
  legacyLog?: Record<string, LegacySeasonRecord[]>;
  /** DotaPedia 统计（stats.ts 记录、pedia.ts 查询；全局公开数据，多人模式各座位视图共享；旧存档缺失时从下一局开始记录） */
  pedia?: PediaState;
  /** 羁绊（第十波 #5，synergy.ts）：解锁记录 + 当前激活；全局公开数据（多人模式各座位共享，不进座位交换列表）；旧存档缺失时按需创建 */
  synergies?: SynergyState;
  /**
   * 真实生涯位置数据版本（第十三波，roles.ROLE_DATA_VERSION）：新游戏创建时写入；旧存档缺失 / 低于当前版本时，
   * 读档（save.importSave / upgradeLoadedState，含「继续游戏」）/ 多人房间载入（multi.migrateRoomState）时一次性把真实选手的位置同步到当届真实位置并补齐副位置（roleSync.migrateRealRoles）。
   * 全局标记（非座位私有）。
   */
  roleDataVersion?: number;

  /** 多人对局（局域网，src/engine/multi.ts）；单机为空 */
  multiplayer?: MultiplayerInfo;
}

// ---------------------------------------------------------------------------
// 羁绊（第十波 #5，src/engine/synergy.ts；定义数据 src/data/synergies.json 由 scripts/build-synergies.ts 生成）
// ---------------------------------------------------------------------------

/** 羁绊加成的属性（五种之一） */
export type SynergyAttr = 'insight' | 'resilience' | 'talent' | 'power' | 'mmr';

/** 一条羁绊定义（全局静态数据） */
export interface SynergyDef {
  /** 如 "ti6-wings-gaming" */
  id: string;
  /** champion = 历届 TI 冠军阵容；iconic = 少数标志性阵容 */
  kind: 'champion' | 'iconic';
  /** 届次（同一五人组多次夺冠时取最早一届） */
  ti: number;
  /** 该五人组夺冠（champion）/ 入选（iconic）的全部届次，升序 */
  tis: number[];
  /** 当届真实名次（iconic 用于展示，如 "2"、"4"） */
  result?: string;
  /** 当届 roster 中的战队 id、全名、简称、主色 */
  clubId: string;
  club: string;
  short: string;
  color: string;
  /** 「TI6 · Wings 五人组」（修正器来源为「羁绊：{name}」） */
  name: string;
  attr: SynergyAttr;
  /** 五名成员（当届 roster 的首发五人，位置各不相同） */
  members: { id: string; handle: string; position: Position }[];
  /** 属性选择理由（设计备注，不在界面显示） */
  note: string;
}

/** 羁绊首次觉醒记录 */
export interface SynergyUnlock {
  ti: number;
  round: number;
  date: string;
  teamId: string;
  teamName: string;
  /** 累计觉醒（激活）次数 */
  count: number;
}

/** 当前激活的羁绊 */
export interface SynergyActive {
  teamId: string;
  /** 本次激活的赛季 / 回合 */
  ti: number;
  round: number;
  /** 已发放加成修正器的选手（同属性羁绊不叠加时为空） */
  playerIds: string[];
}

/** 羁绊状态（GameState.synergies） */
export interface SynergyState {
  /** 已解锁（至少觉醒过一次）的羁绊：羁绊 id → 首次觉醒记录 */
  unlocked: Record<string, SynergyUnlock>;
  /** 当前激活：羁绊 id → 激活战队 */
  active: Record<string, SynergyActive>;
}

/** 赛季教练供给记录（第九波 #3，coaches.seasonCoachSupply 在赛季初、新秀选秀之后生成） */
export interface CoachSupplyRecord {
  /** 赛季（TI 序号） */
  ti: number;
  /** 本赛季新进入教练市场的人数（= generated + real + retired + other） */
  added: number;
  /** 程序生成（含为满足保底而追加的 topUp） */
  generated: number;
  /** 其中为满足保底追加生成的人数 */
  topUp: number;
  /** 该届 roster 中尚未进入游戏的真实教练 */
  real: number;
  /** 退役选手转任（上赛季结算时生成） */
  retired: number;
  /** 其他首次出现的自由教练（被解散 / 除名战队的教练等） */
  other: number;
  /** 供给后（AI 季前签约之前）教练市场可签约人数 / 其中 S 级及以上人数 */
  available: number;
  topTier: number;
  /** 供给时没有主教练的战队数（含玩家） */
  vacancies: number;
}

// ---------------------------------------------------------------------------
// 多人对局（docs/MULTIPLAYER.md §5 / §8；实现见 seat.ts / multi.ts）
// ---------------------------------------------------------------------------

export type MpMode = 'build' | 'existing';

/** 座位换出时保存的私有数据（结构由 seat.ts 维护，可 JSON 序列化） */
export interface SeatSaved {
  /** 顶层私有字段（freeTrainingUsed / pendingDecisions / finance / popups …） */
  top?: Record<string, unknown>;
  /** history 中的私有字段（playerSettlements / honor / gold / seasons / training / squadProgress） */
  history?: Record<string, unknown>;
  /** season 中的私有字段（registeredTournamentIds / extraTrainingsBought / honorStart / goldStart），ti = 所属赛季 */
  season?: { ti: number } & Record<string, unknown>;
  /** 各赛事的私有字段（playerStatus / expectedRank / settlement / playerBeefHonor） */
  tournaments?: Record<string, Record<string, unknown>>;
  /** settings 中的私有字段（managerName） */
  settings?: Record<string, unknown>;
  /** 已读新闻 id */
  readNews?: string[];
}

/** 每个座位（人类玩家）的状态 */
export interface SeatState {
  teamId: string;
  sessionId: string;
  name: string;               // 玩家昵称
  eliminated: boolean;        // 荣誉 < 0 解散 → 观战
  ready: boolean;             // 回合准备
  /**
   * 以「下一回合（自动处理）」请求准备（autoRound.ts）：仍需等待（玩家对决等对手同意快速模拟 / 下一场等其他玩家的结果）时
   * 保持该意图，之后任何玩家的操作后自动继续处理，无阻塞即准备；取消准备 / 推进回合 / 出局时清除。
   */
  autoReady?: boolean;
  /** 被换出的私有字段 */
  saved: SeatSaved;
}

/** 玩家对玩家系列赛的共享对局（multiplayer.h2h[seriesId]） */
export interface H2HMatch {
  seriesId: string;
  tournamentId: string;
  teamA: string;
  teamB: string;
  /** 已生成的对局（生成即计入系列赛进度） */
  games: GameRecord[];
  /** 当前局的 BP（双方共享） */
  draft: DraftState | null;
  /** 各方本局的 BP 方式（未选择 = 等待该方操作） */
  mode: { A?: 'manual' | 'auto'; B?: 'manual' | 'auto' };
  /** 已进入比赛的一方（teamId → true） */
  joined: Record<string, boolean>;
  /** 请求快速模拟的一方（teamId → true；双方都请求才生效） */
  quickSim: Record<string, boolean>;
  /** 系列赛已出结果 */
  done?: boolean;
  /** 结束时各方的结果文案（teamId → 文案） */
  summary?: Record<string, string>;
}

export interface MultiplayerInfo {
  mode: MpMode;
  hostTeamId: string;
  order: string[];            // 座位顺序（teamId）
  seats: Record<string, SeatState>;
  /** 当前换入顶层的座位（null = 无，顶层为「中性」状态） */
  activeSeat: string | null;
  /** 玩家对玩家系列赛（seriesId → 共享对局） */
  h2h?: Record<string, H2HMatch>;
  /**
   * 服务器生成的谈判密钥（server/rooms.ts 开局 / 载入时写入）：混入 market.negotiationRoll 的哈希，座位视图中清空，
   * 客户端无法预先算出 AI 是否接受报价。无服务器的多人模拟（simulate-mp）没有密钥，与单机相同。
   */
  secret?: string;
}

export type Popup =
  | { kind: 'tournament_settlement'; tournamentId: string }
  | { kind: 'season_summary'; ti: number }
  | { kind: 'patch'; version: string }
  | { kind: 'rookie_draft'; ti: number }
  | { kind: 'message'; title: string; body: string };

// ---------------------------------------------------------------------------
// 新游戏参数
// ---------------------------------------------------------------------------

export interface NewGameOptions {
  startTi: number;
  seasons: number;
  difficulty: 'easy' | 'normal' | 'hard';
  managerName: string;
  /** 接管真实战队 */
  teamId?: string;
  /** 或新建俱乐部 */
  newClub?: { name: string; tag: string; region: Region; color: string };
  seed?: number;
}

/** 通用操作结果（UI 以 toast 展示 message） */
export interface OpResult {
  ok: boolean;
  message: string;
}

/** 训练报告：每名选手本次训练的属性变化 */
export interface TrainingGain {
  playerId: string;
  handle: string;
  power: number;
  mmr: number;
  insight: number;
  talent: number;
  resilience: number;
}

/** 训练记录类型：free 免费训练 / extra 已购额外训练 / scrim 训练赛 / auto 回合结束自动完成的剩余训练 */
export type TrainingRecordKind = 'free' | 'extra' | 'scrim' | 'auto';

/** 一次训练的记录（玩家战队，存于 history.training，见 trainingLog.ts） */
export interface TrainingRecord {
  season: number;             // TI 序号
  round: number;
  date: string;
  kind: TrainingRecordKind;
  focus: TrainingFocus;
  mult: number;               // 收益倍数（训练赛倍数；普通训练 = 1）
  scrimTargetId?: string;
  scrimWon?: boolean;
  /** 训练赛的灵性额外倍数（交流 BP，叠加在 mult 之上；CONFIG.training.scrimInsightMult，旧记录缺省 = 1） */
  insightMult?: number;
  /** 本次实际花费：训练赛费用 + 所消耗的已购额外训练的购买价（免费次数为 0） */
  cost: number;
  /** 消耗的训练次数类型 */
  session?: 'free' | 'extra';
  /** cost 中属于额外训练购买价的部分 */
  sessionCost?: number;
  gains: TrainingGain[];
}

/** 选手成长快照（玩家战队选手，每回合结束记录一次，存于 history.squadProgress） */
export interface SquadProgressPoint {
  season: number;
  round: number;
  power: number;
  mmr: number;
  insight: number;
  talent: number;
  resilience: number;
  loyalty: number;
}

/** 推进回合的阻塞原因（UI 展示） */
export interface AdvanceBlocker {
  /** roster_over_cap：正式阵容超出绝对上限（新秀抽卡后超编，须在本回合内退回，team.rosterOverCap） */
  code: 'pending_decision' | 'tournament_running' | 'lineup_invalid' | 'game_over' | 'match_in_progress' | 'roster_over_cap';
  message: string;
}
