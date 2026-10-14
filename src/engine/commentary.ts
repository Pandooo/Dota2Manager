// 文字直播生成（中文）【E2 负责实现】
import type {
  DraftAction, GameState, InMatchEvent, LiveEvent, LiveEventType, Player, Position, TournamentTier,
} from './types';
import { POSITIONS } from './types';
import { CONFIG, POSITION_SHORT } from './config';
import { heroName } from './heroes';
import { rngOf, seededRng } from './rng';
import type { Rng } from './rng';
import { clamp, ownEntry } from './util';
import { apportion } from './stats';

export interface LiveContext {
  teamA: string;
  teamB: string;
  radiant: 'A' | 'B';
  draft: DraftAction[];
  winner: 'A' | 'B';
  durationMin: number;
  killsA: number;
  killsB: number;
  incidents: InMatchEvent[];
  winProbA: number;
  /** 可选：本局 MVP（直播中更活跃，GG 时点名） */
  mvpPlayerId?: string;
  /** 可选：赛事等级（开场文案） */
  tier?: TournamentTier;
  /** 可选：阵容节奏倾向（-1 前期 … +1 后期） */
  leanA?: number;
  leanB?: number;
  /**
   * 可选输出（DotaPedia）：直播结束后写入每名有 id 的选手在直播中的 [击杀, 阵亡]，
   * 使个人数据与直播文本一致。只读取直播内部计数，不消耗随机数。
   */
  kdOut?: Record<string, [number, number]>;
}

// ---------------------------------------------------------------------------
// 文案模板（{KEY} 占位）
// ---------------------------------------------------------------------------
const TPL = {
  start: [
    '比赛开始！天辉 {RT} 对阵夜魇 {DT}，号角吹响',
    '双方英雄进场，{RT}（天辉）与 {DT}（夜魇）的较量正式打响',
    '{STAGE}{RT} 与 {DT} 的对决开始了，谁能先拔头筹？',
    '号角声中，天辉 {RT} 与夜魇 {DT} 各自走向线上',
    '{STAGE}天辉 {RT} vs 夜魇 {DT}，比赛开始！',
  ],
  lane: [
    '{C} 在优势路补刀稳健，{HS} 帮忙控线拉野',
    '中路对线：{M} 与 {EM} 你来我往，补刀几乎持平',
    '{O} 在劣势路顶住压力，等级没有落后',
    '{SS} 早早离开线上游走，{T} 正在寻找机会',
    '中路 {M} 正补领先 {N} 刀，对线占据上风',
    '{T} 的双辅助在优势路压得很凶，{EO} 只能远远吃经验',
    '{M} 拿下中路{RUNE}，准备发起第一次游走',
    '{SS} 拉野成功，{T} 的线上局面变得舒服',
    '赏金神符点爆发小规模冲突，双方各有消耗',
  ],
  firstblood: [
    '一血！{K} 击杀了 {V}，{T} 拔得头筹',
    '{T} 拿下一血：{K} 在{PLACE}抓死了 {V}',
    '第一滴血！{V} 被 {K} 留在了{PLACE}',
    '{T} 的前期布置奏效，{K} 收下一血',
    '{V} 走位过于激进，被 {K} 收下一血',
  ],
  gank: [
    '{K} 绕后成功，{V} 应声倒地',
    '{T} 多人包夹，{V} 交出技能也没能逃掉',
    '{K} 一套技能秒掉了 {V}',
    '{V} 视野被抓，{K} 顺利收下人头',
    '{K} 在{PLACE}蹲到了落单的 {V}',
    '{T} 的游走奏效，{V} 倒在{PLACE}',
    '{K} 闪烁进场，瞬间带走 {V}',
    '{V} 刷野太深，被 {K} 抓住机会击杀',
    '{T} 抓到 {V} 的走位失误，{K} 收下人头',
  ],
  gankMulti: [
    '{T} 在{PLACE}打出 {A} 换 {B}，{K} 收割全场',
    '{T} 抱团游走，连续抓死 {VLIST}',
    '{T} 绕后包抄，{VLIST} 先后倒下',
    '{K} 带队突袭{PLACE}，{E} 损失 {A} 人',
  ],
  trade: [
    '双方在{PLACE}互换人头，比分来到 {SCORE}',
    '{KA} 与 {KB} 各自收下人头，局面依旧胶着',
    '你来我往！{PLACE}的遭遇战打成 {A} 换 {B}',
  ],
  tradeOne: [
    '{PLACE}一换一：{KA} 击杀 {VA}，{KB} 随即带走 {VB}',
    '{VA} 倒在 {KA} 手下，{KB} 立刻还以颜色击杀 {VB}',
  ],
  tradeBig: [
    '{PLACE}爆发混战，双方打成 {A} 换 {B}，谁也没占到便宜',
    '一波大团过后双方 {A} 换 {B}，比分来到 {SCORE}',
  ],
  teamfight: [
    '{PLACE}爆发团战！{T} 打出 {A} 换 {B}',
    '{K} 一个大招开团，{T} 团战 {A} 换 {B} 大获全胜',
    '{T} 先手开团，{E} 阵型被打散，{A} 换 {B}',
    '{E} 想要接团却被反打，{T} {A} 换 {B} 拿下团战',
    '团战焦点：{K} 在人群中大杀四方，{T} 打出 {A} 换 {B}',
    '{PLACE}的团战持续了半分钟，{T} 笑到最后（{A} 换 {B}）',
    '{E} 关键技能放空，{T} 抓住机会 {A} 换 {B}',
    '{T} 团战拉扯到位，{A} 换 {B}，比分 {SCORE}',
  ],
  teamfightClean: [
    '{K} 完美切入后排，{T} 零阵亡收下 {A} 个人头',
    '{T} 包夹得手，{E} 一度濒临团灭，{T} 零损失拿下 {A} 杀',
  ],
  teamfightCostly: [
    '{K} 完美切入后排，{T} 收下 {A} 个人头，仅阵亡 {B} 人',
    '{T} 以 {B} 人阵亡的代价换掉对面 {A} 人，团战获胜',
  ],
  wipe: [
    '团灭！{T} 打出一波 {A} 换 0，{E} 全员阵亡',
    '零换五！{T} 在{PLACE}团灭了 {E}',
    '{K} 带领 {T} 横扫战场，{E} 五人全部倒下',
  ],
  tower: [
    '{T} 推掉了 {E} 的{LANE}{TIER}',
    '{T} 拿下{LANE}{TIER}，地图控制进一步扩大',
    '{E} 的{LANE}{TIER}告破，{T} 获得一波经济',
    '{T} 抱团推进，拔掉 {E} {LANE}{TIER}',
    '{K} 带线牵制，偷掉了{LANE}{TIER}',
    '{T} 趁 {E} 回防不及，强拆{LANE}{TIER}',
    '{LANE}{TIER}倒下，{T} 推进节奏很快',
    '{E} 放弃{LANE}{TIER}，转而在野区发育',
  ],
  roshan: [
    '{T} 击杀肉山，{K} 拿到不朽之守护',
    '{T} 打掉肉山，{K} 带上不朽之守护准备推进',
    '肉山倒下！{K} 吃下不朽盾，{T} 节奏起飞',
    '{T} 趁 {E} 视野缺失偷掉肉山，{K} 拿盾',
    '第 {RN} 代肉山被 {T} 收下，{K} 持有不朽之守护',
  ],
  roshanCheese: [
    '{T} 击杀第 {RN} 代肉山，{K} 拿到不朽之守护和奶酪',
    '奶酪掉落！{T} 拿下肉山，不朽盾交给了 {K}',
    '{T} 再次控下肉山，{K} 不朽盾 + 奶酪双保险',
  ],
  roshanSteal: [
    '肉山被偷了！{K} 在 {E} 眼皮底下抢走不朽之守护',
    '惊天一抢！{T} 的 {K} 惩戒级操作偷下肉山',
  ],
  buyback: [
    '{V} 果断买活，回到战场守高',
    '{T} 的 {V} 买活救场，基地暂时守住了',
    '{V} 买活后立刻传送回防',
    '关键时刻 {V} 选择买活，经济压力陡增',
    '{V} 买活接团，{T} 还没放弃',
  ],
  item: [
    '{K} 做出了{ITEM}，{T} 的输出能力大幅提升',
    '{K} 的{ITEM}到手，准备找机会开团',
    '{T} 的核心 {K} 合成{ITEM}，经济转化为战斗力',
    '{K} 憋出{ITEM}，关键装备成型',
    '{K} 拿到{ITEM}，{T} 开始主动找团',
  ],
  highground: [
    '{T} 带着不朽盾强上高地，{E} 的防线摇摇欲坠',
    '{T} 冲上{LANE}高地！',
    '{T} 五人抱团上高，{E} 无力阻挡',
    '高地战打响，{T} 稳扎稳打拆掉高地塔',
    '{T} 利用兵线压力撕开了 {E} 的高地防线',
  ],
  highgroundFail: [
    '{T} 第一次冲击高地无果，被 {E} 打退',
    '{T} 强攻高地遭遇顽强抵抗，只好撤退',
    '{E} 高地防守成功！{T} 的冒进付出了代价',
    '{T} 上高失败，{E} 守住了基地',
  ],
  barracks: [
    '{T} 拆掉了 {E} 的{LANE}兵营',
    '{E} {LANE}兵营告破，{T} 的兵线优势确立',
    '{T} 推掉{LANE}近战兵营与远程兵营',
    '{LANE}兵营倒下，{E} 的基地岌岌可危',
  ],
  mega: [
    '超级兵出现了！{E} 三路兵营全部告破',
    '{T} 拆光了 {E} 的全部兵营，超级兵压境',
    '超级兵！{E} 只剩最后的遗迹',
  ],
  rampage: [
    '暴走！{K} 一人收下五个人头，打出 RAMPAGE！',
    'RAMPAGE！{K} 在团战中连斩五人，全场沸腾',
    '{K} 暴走了！{E} 五人全部倒在 {P} 脚下',
  ],
  godlike: [
    '超神！{K} 已经超越神的杀戮，{E} 无人能挡',
    '{K} 超神了！连续击杀无人能终结',
  ],
  comeback: [
    '翻盘的号角吹响！{T} 一波团战扭转局势',
    '不可思议！{T} 从 {N} 的经济劣势中扳回局面',
    '{T} 绝地反击，{E} 的优势正在流失',
    '局势逆转！{T} 抓住 {E} 的冒进完成反打',
  ],
  incidentBad: [
    '突发状况：{TEXT}',
    '{TEXT}，{T} 的节奏受到影响',
    '场边消息：{TEXT}，{T} 有些被动',
  ],
  incidentGood: [
    '{TEXT}！{T} 士气大振',
    '高光时刻：{TEXT}',
    '{TEXT}，{T} 的气势完全起来了',
  ],
  farm: [
    '双方进入发育期，地图资源争夺激烈',
    '{T} 控下了 {E} 的野区，视野布置非常到位',
    '{E} 选择收缩防守，寻找翻盘机会',
    '{T} 开始抱团推进，{E} 需要谨慎应对',
    '{K} 正在{PLACE}快速刷钱，补刀数领先全场',
    '双方在肉山坑附近反复拉扯，谁都不敢先手',
    '{T} 的辅助正在布置真假眼，抢夺地图视野',
  ],
  gg: [
    '{L} 打出 GG！{W} 拿下本局胜利',
    '{W} 推平{LS}遗迹，赢下本局！最终比分 {SCORE}',
    '遗迹倒塌！{W} 获胜，全场最佳 {MVP}',
    '{L} 无力回天，GG 离场，{W} 赢下比赛',
    '{W} 完成最后一击，{LS}遗迹被摧毁',
  ],
  ggComeback: [
    '{W} 完成翻盘！{LS}遗迹倒塌，{L} 打出 GG',
    '惊天逆转！{W} 一路追回劣势，推平{LS}遗迹',
  ],
  ggBehind: [
    '逆风翻盘！{W} 在经济落后的情况下推平{LS}遗迹',
    '经济落后 {N} 也挡不住 {W}！{LS}遗迹倒塌，{L} 打出 GG',
  ],
} as const;

/** 模板总数（测试用） */
export function liveTemplateCount(): number {
  let n = 0;
  for (const arr of Object.values(TPL)) n += arr.length;
  return n;
}

const PLACES = ['河道', '符点', '野区', '塔下', '肉山坑附近', '远古野点', '优势路草丛', '高台', '中路河道', '三角区', '基地门口', '传送门附近'];
const RUNES = ['双倍伤害神符', '隐身神符', '急速神符', '幻象神符', '奥术神符', '恢复神符'];
const ITEMS = ['黑皇杖', '闪烁匕首', '辉耀', '狂战斧', '阿哈利姆神杖', '蝴蝶', '金箍棒', '撒旦之邪力', '刃甲', '林肯法球', '原力法杖', '否决坠饰', '代达罗斯之殇', '雷神之锤', '深渊之刃'];
const LANES = ['上路', '中路', '下路'];
const TOWER_TIERS = ['一塔', '二塔', '高地塔'];
const CORE_POSITIONS: Position[] = ['C', 'M', 'O'];
/**
 * 随版本才出现的神符/物品/地图元素：文本片段 → 引入日期（与 data/patches.json 一致）。
 * 早于该日期的比赛直播不使用含该片段的地点/物品/神符/模板，避免 2011 年的比赛出现「双生之门」之类的时代错位。
 */
const ERA_SINCE: [string, string][] = [
  ['赏金神符', '2014-09-25'], // 6.82
  ['奥术神符', '2015-12-16'], // 6.86
  ['否决坠饰', '2017-10-31'], // 7.07
  ['传送门', '2023-04-20'], // 7.33 双生之门
];
/** 7.30 起第二代肉山不再掉落奶酪（第三代起才掉） */
const CHEESE_FROM_THIRD_SINCE = '2021-08-18';
/** 不朽之守护持续时间（秒） */
const AEGIS_SEC = 300;
/** 单次击杀事件中一方最多阵亡人数（每队只有 5 名英雄） */
const MAX_DEATHS_PER_EVENT = 5;

function eraOk(text: string, date: string): boolean {
  if (!date) return true;
  for (const [key, since] of ERA_SINCE) if (date < since && text.includes(key)) return false;
  return true;
}

function eraFilter<T extends string>(arr: readonly T[], date: string): readonly T[] {
  const res = arr.filter((x) => eraOk(x, date));
  return res.length ? res : arr;
}

const STREAK_TEXT: Record<number, string> = {
  3: '正在大杀特杀', 4: '已经主宰比赛', 5: '杀人如麻', 6: '无人能挡', 7: '变态杀戮', 8: '妖怪般的杀戮', 9: '如同神一般',
};
const MULTI_TEXT: Record<number, string> = { 2: '双杀', 3: '三杀', 4: '疯狂杀戮' };

// ---------------------------------------------------------------------------
// 直播数值参数（展示层，不影响比赛结果）
// ---------------------------------------------------------------------------
const LIVE = {
  minDuration: 10,
  minEvents: 25,
  maxEvents: 60,
  /** 为动态插入事件（暴走/超神/翻盘）预留的条数 */
  dynamicReserve: 3,
  laneEvents: 3,
  itemEvents: 2,
  /** 目标事件数 ≈ base + perMin × 时长 */
  targetBase: 20,
  targetPerMin: 0.55,
  gankCap: 3,
  /** 「团战」至少需要的总击杀数，不足按小规模冲突描述 */
  teamfightMinKills: 3,
  /** 击杀事件平均击杀数下限（避免把少量击杀拆得过碎） */
  minUnitsPerKillEvent: 2,
  fightCap: 9,
  unitsPerEventMax: 7,
  /** 经济：每个人头 / 推塔 / 肉山 / 兵营 / 买活（随分钟线性增长） */
  killGold: [160, 24],
  towerGold: [500, 22],
  roshGold: [300, 12],
  raxGold: [900, 25],
  buybackGold: [300, 40],
  /** 每条事件向目标经济曲线收敛的比例 */
  drift: 0.55,
  /** 胜方最终经济领先：base + perMin × 时长 */
  endLead: [6000, 12000] as [number, number],
  endLeadPerMin: [120, 320] as [number, number],
  comebackEndLead: [2500, 7000] as [number, number],
  comebackEndLeadPerMin: [40, 120] as [number, number],
  comebackPeak: [5000, 14000] as [number, number],
  comebackPeakAt: [0.45, 0.68] as [number, number],
  comebackMinDuration: 25,
  comebackDetectLead: 6000,
  earlyDipChance: 0.45,
  earlyDip: [500, 2500] as [number, number],
  earlyDipUntil: 0.35,
  snowballExp: [1.0, 1.8] as [number, number],
  /** 相邻事件最小间隔（秒） */
  minGapSec: 8,
  /** 击杀方向偏好：pA = 0.5 + k × 归一化斜率 */
  slopeBias: 0.38,
  pAClamp: [0.08, 0.92] as [number, number],
  rampageChance: 0.35,
  stealChance: 0.15,
  hgFailChance: 0.4,
  hgFailMinDuration: 40,
  megaChance: 0.35,
  megaMinDuration: 45,
  buybackMinDuration: 30,
};

/**
 * 击杀者 / 阵亡者权重与 DotaPedia 的 K/D 分配同口径（CONFIG.pedia.killWeight / deathWeight / mvpKillMult / mvpDeathMult），
 * 另乘每名选手本局的发挥（对数尺度均匀、标准差 CONFIG.pedia.noiseSigma / deathNoiseSigma）。
 * 击杀事件按这套权重先算出每人本局的击杀 / 阵亡份额（与 stats.allocateSideKda 同一最大余数法），再逐次按剩余份额抽取击杀者 / 阵亡者，
 * 使直播里的个人击杀 / 阵亡分布（含尾部）与快速模拟一致；逐次独立按权重抽取会多出一层多项分布方差（辅助偶尔 20 杀）。
 */
const KILLER_W = (pos: Position) => CONFIG.pedia.killWeight[pos] ?? 1;
const VICTIM_W = (pos: Position) => CONFIG.pedia.deathWeight[pos] ?? 1;

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------
type Side = 'A' | 'B';

interface Actor {
  side: Side;
  pos: Position;
  playerId?: string;
  handle: string;
  hero: string;
  kills: number;
  deaths: number;
  streak: number;
  godlike: boolean;
  /** 本局发挥：击杀者 / 阵亡者权重倍数 */
  formK: number;
  formD: number;
  /** 本局剩余的击杀 / 阵亡份额（击杀事件按剩余份额抽取击杀者 / 阵亡者） */
  qK: number;
  qD: number;
}

type RawKind =
  | 'start' | 'lane' | 'firstblood' | 'gank' | 'teamfight' | 'tower' | 'roshan' | 'buyback' | 'item'
  | 'hg_fail' | 'highground' | 'barracks' | 'mega' | 'incident' | 'farm' | 'gg';

interface Raw {
  t: number;              // 秒
  kind: RawKind;
  side?: Side;
  cap?: number;           // 击杀数（击杀类事件）
  a?: number;             // A 方击杀数
  b?: number;
  pA?: number;            // 该时刻 A 方占优概率
  force?: Side;           // 强制由某方拿下（翻盘转折团）
  rampage?: boolean;
  turn?: boolean;         // 翻盘转折点
  incident?: InMatchEvent;
}

const KILL_KINDS: ReadonlySet<RawKind> = new Set(['firstblood', 'gank', 'teamfight']);
/** 可被删减的填充事件（按优先删除顺序） */
const TRIMMABLE: RawKind[] = ['farm', 'item', 'lane', 'buyback', 'tower'];

/**
 * 单次击杀事件中一方最多阵亡 MAX_DEATHS_PER_EVENT 人（避免「9 换 0」「零换五却杀了 6 个」）。
 * 在保持 A 方总击杀不变的前提下，把超额击杀与其他事件中的对方击杀互换（优先换到该方更占优的事件）。
 */
function capDeathsPerEvent(events: Raw[]): void {
  const hi = (e: Raw) => Math.min(MAX_DEATHS_PER_EVENT, e.cap ?? 0); // a 的上限（B 方阵亡）
  const lo = (e: Raw) => Math.max(0, (e.cap ?? 0) - MAX_DEATHS_PER_EVENT); // a 的下限（A 方阵亡 ≤ 上限）
  const pA = (e: Raw) => e.pA ?? 0.5;
  const guard = events.reduce((n, e) => n + (e.cap ?? 0), 0) * 2 + 4;
  /** 容量不足（其他事件都无可互换的击杀）时：把这一个击杀连同名额整体挪到该方未满的事件 */
  const move = (src: Raw, side: 'a' | 'b'): boolean => {
    let dst: Raw | null = null;
    for (const e of events) {
      if (e === src || (e[side] ?? 0) >= MAX_DEATHS_PER_EVENT || (e.cap ?? 0) >= 2 * MAX_DEATHS_PER_EVENT) continue;
      if (!dst || (side === 'a' ? pA(e) > pA(dst) : pA(e) < pA(dst))) dst = e;
    }
    if (!dst) return false;
    src[side] = (src[side] ?? 0) - 1;
    src.cap = (src.cap ?? 0) - 1;
    dst[side] = (dst[side] ?? 0) + 1;
    dst.cap = (dst.cap ?? 0) + 1;
    return true;
  };
  for (let it = 0; it < guard; it++) {
    const over = events.find((e) => (e.a ?? 0) > hi(e));
    if (over) {
      let to: Raw | null = null;
      for (const e of events) if (e !== over && (e.a ?? 0) < hi(e) && (!to || pA(e) > pA(to))) to = e;
      if (!to) {
        if (!move(over, 'a')) return;
        continue;
      }
      over.a = (over.a ?? 0) - 1;
      over.b = (over.b ?? 0) + 1;
      to.a = (to.a ?? 0) + 1;
      to.b = (to.b ?? 0) - 1;
      continue;
    }
    const under = events.find((e) => (e.a ?? 0) < lo(e));
    if (!under) return;
    let from: Raw | null = null;
    for (const e of events) if (e !== under && (e.a ?? 0) > lo(e) && (!from || pA(e) < pA(from))) from = e;
    if (!from) {
      if (!move(under, 'b')) return;
      continue;
    }
    under.a = (under.a ?? 0) + 1;
    under.b = (under.b ?? 0) - 1;
    from.a = (from.a ?? 0) - 1;
    from.b = (from.b ?? 0) + 1;
  }
}

function fill(tpl: string, v: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
}

/** 拼接两句：前句无句末标点时补逗号 */
function joinSentence(a: string, b: string): string {
  if (!b) return a;
  return /[！？。]$/.test(a) ? a + b : `${a}，${b}`;
}

function fmtGold(g: number): string {
  const a = Math.abs(g);
  return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
}

function teamLabel(state: GameState, teamId: string): string {
  const t = ownEntry(state.teams, teamId);
  return t?.tag || t?.name || teamId;
}

function buildActors(state: GameState, ctx: LiveContext, side: Side): Actor[] {
  const teamId = side === 'A' ? ctx.teamA : ctx.teamB;
  const team = ownEntry(state.teams, teamId);
  const tag = teamLabel(state, teamId);
  const picks = (ctx.draft ?? []).filter((a) => a.type === 'pick' && a.side === side);
  const byPos = new Map<Position, DraftAction>();
  const unplaced: DraftAction[] = [];
  for (const p of picks) {
    if (p.position && !byPos.has(p.position)) byPos.set(p.position, p);
    else unplaced.push(p);
  }
  for (const pos of POSITIONS) if (!byPos.has(pos) && unplaced.length) byPos.set(pos, unplaced.shift() as DraftAction);
  return POSITIONS.map((pos) => {
    const pick = byPos.get(pos);
    const pid = pick?.playerId ?? team?.lineup?.[pos] ?? undefined;
    const found: Player | undefined = pid ? state.players[pid] : undefined;
    const player = found && (!found.status || found.status === 'active') ? found : undefined;
    return {
      side,
      pos,
      playerId: player?.id,
      handle: player?.handle ?? `${tag} ${POSITION_SHORT[pos]}号位`,
      hero: pick ? heroName(pick.heroId) : '',
      kills: 0,
      deaths: 0,
      streak: 0,
      godlike: false,
      formK: 1,
      formD: 1,
      qK: 0,
      qD: 0,
    };
  });
}

/** 发挥子随机流的种子扰动（与主随机状态异或） */
const FORM_SEED_SALT = 0x2f6b9d13;

/**
 * 每名选手本局的发挥（击杀 → 阵亡顺序取数；与 stats.allocateSideKda 的噪声同口径）。
 * 使用由当前主随机状态派生的子随机流（确定性、可复现），不推进主随机序列。
 */
function rollForms(state: GameState, list: Actor[]): void {
  const rng = seededRng((state.rngState ^ FORM_SEED_SALT) | 0);
  const hwK = Math.sqrt(3) * CONFIG.pedia.noiseSigma;
  const hwD = Math.sqrt(3) * CONFIG.pedia.deathNoiseSigma;
  for (const a of list) {
    a.formK = Math.exp(hwK * (2 * rng.next() - 1));
    a.formD = Math.exp(hwD * (2 * rng.next() - 1));
  }
}

function nameOf(a: Actor | undefined): string {
  if (!a) return '无名英雄';
  return a.hero ? `${a.handle}（${a.hero}）` : a.handle;
}

/** 0..1 区间内的经济目标曲线（A 视角） */
interface Trajectory {
  at(x: number): number;
  comeback: boolean;
  peakAt: number;
}

function makeTrajectory(rng: Rng, ctx: LiveContext, D: number): Trajectory {
  const dW = ctx.winner === 'A' ? 1 : -1;
  const pW = ctx.winner === 'A' ? ctx.winProbA : 1 - ctx.winProbA;
  const threshold = CONFIG.match.comebackWinProb;
  const comeback = D >= LIVE.comebackMinDuration && pW < threshold
    && rng.chance(clamp(0.35 + (threshold - pW) * 2, 0, 0.95));
  if (comeback) {
    const peakAt = rng.range(LIVE.comebackPeakAt[0], LIVE.comebackPeakAt[1]);
    const peak = rng.range(LIVE.comebackPeak[0], LIVE.comebackPeak[1]);
    const end = rng.range(LIVE.comebackEndLead[0], LIVE.comebackEndLead[1])
      + D * rng.range(LIVE.comebackEndLeadPerMin[0], LIVE.comebackEndLeadPerMin[1]);
    return {
      comeback,
      peakAt,
      at: (x) => {
        const t = clamp(x, 0, 1);
        if (t <= peakAt) return -dW * peak * Math.pow(t / peakAt, 1.3);
        return dW * (-peak + (peak + end) * Math.pow((t - peakAt) / (1 - peakAt), 0.75));
      },
    };
  }
  const end = rng.range(LIVE.endLead[0], LIVE.endLead[1]) + D * rng.range(LIVE.endLeadPerMin[0], LIVE.endLeadPerMin[1]);
  const k = rng.range(LIVE.snowballExp[0], LIVE.snowballExp[1]);
  const dip = rng.chance(LIVE.earlyDipChance) ? rng.range(LIVE.earlyDip[0], LIVE.earlyDip[1]) : 0;
  return {
    comeback: false,
    peakAt: 0,
    at: (x) => {
      const t = clamp(x, 0, 1);
      const bump = t < LIVE.earlyDipUntil ? Math.sin((Math.PI * t) / LIVE.earlyDipUntil) : 0;
      return dW * (end * Math.pow(t, k) - dip * bump);
    },
  };
}

/**
 * 生成与结果一致的直播时间线（25~60 条）：开局、一血、对线、gank、团战、推塔、肉山/不朽盾、买活、
 * 超神/暴走、高地、翻盘（低胜率方获胜时）、局内突发事件、GG。
 * 使用选手 handle 与英雄中文名；killsA/killsB/goldDiff 单调累计，最后一条比分 = 最终比分。
 */
export function generateLive(state: GameState, ctx: LiveContext): LiveEvent[] {
  const rng = rngOf(state);
  const D = Math.max(LIVE.minDuration, Math.round(ctx.durationMin || 0));
  const Dsec = D * 60;
  const lastRawSec = Dsec - 20;
  const killsA = Math.max(0, Math.round(ctx.killsA || 0));
  const killsB = Math.max(0, Math.round(ctx.killsB || 0));
  const K = killsA + killsB;
  const W: Side = ctx.winner === 'B' ? 'B' : 'A';
  const L: Side = W === 'A' ? 'B' : 'A';
  const other = (s: Side): Side => (s === 'A' ? 'B' : 'A');
  const dirOf = (s: Side) => (s === 'A' ? 1 : -1);

  const date = state.currentDate || '';
  const places = eraFilter(PLACES, date);
  const runes = eraFilter(RUNES, date);
  const items = eraFilter(ITEMS, date);
  const tag: Record<Side, string> = { A: teamLabel(state, ctx.teamA), B: teamLabel(state, ctx.teamB) };
  const radiant: Side = ctx.radiant === 'B' ? 'B' : 'A';
  const sideName = (s: Side) => (s === radiant ? '天辉' : '夜魇');
  const actors: Record<Side, Actor[]> = { A: buildActors(state, ctx, 'A'), B: buildActors(state, ctx, 'B') };
  const mvpActor = [...actors.A, ...actors.B].find((a) => a.playerId && a.playerId === ctx.mvpPlayerId);
  rollForms(state, [...actors.A, ...actors.B]);

  // ---------------- 经济曲线与击杀方向偏好 ----------------
  const traj = makeTrajectory(rng, ctx, D);
  let maxSlope = 1;
  const slopeAt = (x: number) => traj.at(x + 0.02) - traj.at(x - 0.02);
  for (let x = 0; x <= 1; x += 0.02) maxSlope = Math.max(maxSlope, Math.abs(slopeAt(x)));
  const pAAt = (t: number) => clamp(0.5 + LIVE.slopeBias * (slopeAt(t / Dsec) / maxSlope), LIVE.pAClamp[0], LIVE.pAClamp[1]);
  const sideByTrend = (t: number): Side => (rng.chance(pAAt(t)) ? 'A' : 'B');
  const rt = (lo: number, hi: number) => rng.int(Math.round(Math.min(lo, hi)), Math.round(Math.max(lo, hi)));

  // ---------------- 事件骨架 ----------------
  const raws: Raw[] = [];
  raws.push({ t: 0, kind: 'start' });
  const laneEnd = Math.min(600, Dsec * 0.3);
  for (let i = 0; i < LIVE.laneEvents; i++) raws.push({ t: rt(60, laneEnd), kind: 'lane', side: rng.pick(['A', 'B'] as Side[]) });
  const fbT = rt(45, Math.min(330, Dsec * 0.2));
  if (K > 0) raws.push({ t: fbT, kind: 'firstblood', cap: 1 });
  for (const inc of ctx.incidents ?? []) {
    const s: Side = inc.teamId === ctx.teamB ? 'B' : 'A';
    raws.push({ t: clamp(inc.minute * 60 + rng.int(0, 59), 60, Dsec - 120), kind: 'incident', side: s, incident: inc });
  }
  // 胜方上高地的时刻先定下来：普通推塔都发生在上高之前（否则会出现「上高后才推掉一塔」）
  const hgT = Math.min(lastRawSec - 70, Dsec - rng.int(120, 240));
  const towerCount = clamp(Math.round(D / 6), 3, 9);
  for (let i = 0; i < towerCount; i++) {
    const t = rt(Math.max(480, Dsec * 0.2), Math.min(Dsec - 180, hgT - 2 * LIVE.minGapSec));
    raws.push({ t, kind: 'tower', side: sideByTrend(t) });
  }
  const roshCount = clamp(Math.floor((D - 12) / 10), 0, 4);
  let roshT = rng.range(14, 22) * 60;
  for (let i = 0; i < roshCount && roshT < Dsec - 180; i++) {
    raws.push({ t: Math.round(roshT), kind: 'roshan', side: sideByTrend(roshT) });
    roshT += rng.range(9, 12) * 60;
  }
  for (let i = 0; i < LIVE.itemEvents; i++) raws.push({ t: rt(Dsec * 0.25, Dsec * 0.7), kind: 'item', side: rng.pick(['A', 'B'] as Side[]) });
  if (D >= LIVE.buybackMinDuration) {
    const n = rng.int(0, 2);
    for (let i = 0; i < n; i++) raws.push({ t: rt(Dsec * 0.7, Dsec - 60), kind: 'buyback', side: L });
  }
  // 翻盘剧本：领先方（最终败方）强攻高地失败 → 胜方转折团战
  let turnT = -1;
  if (traj.comeback) {
    const t = Math.round(clamp(traj.peakAt * Dsec, 600, Dsec - 300));
    raws.push({ t, kind: 'hg_fail', side: L });
    turnT = t + rng.int(15, 40);
  } else if (D >= LIVE.hgFailMinDuration && rng.chance(LIVE.hgFailChance)) {
    raws.push({ t: rt(Dsec * 0.72, Dsec * 0.82), kind: 'hg_fail', side: W });
  }
  raws.push({ t: hgT, kind: 'highground', side: W });
  const raxT = Math.min(lastRawSec - 30, hgT + rng.int(20, 60));
  raws.push({ t: raxT, kind: 'barracks', side: W });
  if (D >= LIVE.megaMinDuration && rng.chance(LIVE.megaChance)) {
    raws.push({ t: Math.min(lastRawSec, raxT + rng.int(15, 40)), kind: 'mega', side: W });
  }

  // 击杀事件数量：凑到目标条数，同时保证每条事件击杀数合理
  const units = Math.max(0, K - (K > 0 ? 1 : 0));
  const target = clamp(Math.round(LIVE.targetBase + LIVE.targetPerMin * D), LIVE.minEvents, LIVE.maxEvents - LIVE.dynamicReserve);
  const fixedCount = raws.length + 1; // + gg
  let M = target - fixedCount;
  M = Math.max(M, Math.ceil(units / LIVE.unitsPerEventMax));
  // 每次事件一方最多 5 杀：一边倒的比分需要足够多的击杀事件（一血另算 1 杀）
  M = Math.max(M, Math.ceil((Math.max(killsA, killsB) - 1) / MAX_DEATHS_PER_EVENT));
  M = Math.min(M, Math.max(1, Math.floor(units / LIVE.minUnitsPerKillEvent)), units, LIVE.maxEvents - LIVE.dynamicReserve - fixedCount);
  M = Math.max(0, M);
  const killEvents: Raw[] = [];
  if (M > 0) {
    const tfFrac = clamp(0.35 + D / 200, 0.35, 0.6);
    let nTf = Math.round(M * tfFrac);
    if (M >= 2) nTf = Math.max(1, nTf);
    if (traj.comeback && turnT > 0) {
      killEvents.push({ t: turnT, kind: 'teamfight', cap: 1, force: W, turn: true });
      nTf = Math.max(0, nTf - 1);
    }
    const nGank = M - killEvents.length - nTf;
    for (let i = 0; i < nGank; i++) killEvents.push({ t: rt(fbT + 20, Dsec * 0.85), kind: 'gank', cap: 1 });
    for (let i = 0; i < nTf; i++) killEvents.push({ t: rt(Math.max(fbT + 30, Dsec * 0.3), Dsec - 90), kind: 'teamfight', cap: 1 });
    // 剩余击杀按权重分配到各事件（团战更多、越晚越多）
    let extra = units - killEvents.length;
    let capBoost = 0;
    while (extra > 0) {
      const open = killEvents.filter((e) => (e.cap ?? 0) < (e.kind === 'gank' ? LIVE.gankCap : LIVE.fightCap) + capBoost);
      if (open.length === 0) {
        capBoost++;
        continue;
      }
      const w = open.map((e) => (e.kind === 'gank' ? 0.5 : 2.5 + 2.5 * (e.t / Dsec)) * (e.turn ? 3 : 1));
      const e = rng.weighted(open, w);
      e.cap = (e.cap ?? 0) + 1;
      extra--;
    }
  }
  raws.push(...killEvents);

  // 填充至最少条数 / 删减至上限
  while (raws.length + 1 < LIVE.minEvents) raws.push({ t: rt(Dsec * 0.15, Dsec * 0.9), kind: 'farm', side: rng.pick(['A', 'B'] as Side[]) });
  for (const kind of TRIMMABLE) {
    while (raws.length + 1 > LIVE.maxEvents - LIVE.dynamicReserve) {
      const idx = raws.findIndex((r) => r.kind === kind);
      if (idx < 0) break;
      raws.splice(idx, 1);
    }
  }
  const ggT = Dsec + rng.int(5, 50);
  raws.push({ t: ggT, kind: 'gg', side: W });

  // 时间排序（同一时刻：一血优先），保证一血是第一个击杀事件
  for (const r of raws) if (r.kind !== 'start' && r.kind !== 'gg') r.t = clamp(Math.round(r.t), 1, lastRawSec);
  raws.sort((x, y) => x.t - y.t || (x.kind === 'firstblood' ? -1 : y.kind === 'firstblood' ? 1 : 0));
  const fbIdx = raws.findIndex((r) => r.kind === 'firstblood');
  const firstKill = raws.findIndex((r) => KILL_KINDS.has(r.kind));
  if (fbIdx > firstKill && firstKill >= 0) {
    // 交换类型，让最早的击杀事件成为一血
    const fb = raws[fbIdx];
    const early = raws[firstKill];
    [fb.kind, early.kind] = [early.kind, fb.kind];
    [fb.cap, early.cap] = [early.cap, fb.cap];
    [fb.force, early.force] = [early.force, fb.force];
    [fb.turn, early.turn] = [early.turn, fb.turn];
  }

  // 相邻事件拉开间隔；超出比赛末尾时向前压缩（gg 为最后一条，不参与）
  for (let i = 1; i < raws.length - 1; i++) {
    if (raws[i].t < raws[i - 1].t + LIVE.minGapSec) raws[i].t = raws[i - 1].t + LIVE.minGapSec;
  }
  for (let i = raws.length - 2; i >= 1; i--) {
    const bound = Math.min(lastRawSec, raws[i + 1].t - 1);
    if (raws[i].t > bound) raws[i].t = Math.max(1, bound);
  }

  // ---------------- 击杀分配：A 方恰好 killsA 个 ----------------
  const slots: { e: Raw; key: number }[] = [];
  for (const e of raws) {
    if (!KILL_KINDS.has(e.kind)) continue;
    e.a = 0;
    e.b = 0;
    const p = e.force ? (e.force === 'A' ? 0.97 : 0.03) : pAAt(e.t);
    e.pA = p;
    for (let i = 0; i < (e.cap ?? 0); i++) {
      // Efraimidis–Spirakis 加权无放回抽样：key = ln(u)/w，取最大的 killsA 个
      const u = Math.max(1e-12, rng.next());
      slots.push({ e, key: Math.log(u) / Math.max(1e-6, p) });
    }
  }
  slots.sort((x, y) => y.key - x.key);
  slots.forEach((s, i) => {
    if (i < killsA) s.e.a = (s.e.a ?? 0) + 1;
    else s.e.b = (s.e.b ?? 0) + 1;
  });
  capDeathsPerEvent(raws.filter((e) => KILL_KINDS.has(e.kind)));
  let rampageDone = false;
  for (const e of raws) {
    if (!KILL_KINDS.has(e.kind)) continue;
    const a = e.a ?? 0;
    const b = e.b ?? 0;
    e.side = a > b ? 'A' : b > a ? 'B' : ((e.pA ?? 0.5) >= 0.5 ? 'A' : 'B');
    if (!rampageDone && e.kind === 'teamfight' && Math.max(a, b) >= 5 && rng.chance(LIVE.rampageChance)) {
      e.rampage = true;
      rampageDone = true;
    }
  }

  // ---------------- 逐条生成文本与数值 ----------------
  // 同一局内尽量不重复使用同一模板
  const usedTpl = new Set<string>();
  const pickT = (all: readonly string[]): string => {
    const arr = eraFilter(all, date);
    const fresh = arr.filter((x) => !usedTpl.has(x));
    const tpl = rng.pick(fresh.length ? fresh : arr);
    usedTpl.add(tpl);
    return tpl;
  };

  const out: LiveEvent[] = [];
  let ka = 0;
  let kb = 0;
  let gd = 0;
  let dynamicLeft = LIVE.dynamicReserve;
  let comebackShown = false;
  let maxLoserLead = 0;
  let roshanNo = 0;
  /** 各方已拿下的肉山数（「再次控下肉山」只用于之前拿过肉山的一方） */
  const roshBy: Record<Side, number> = { A: 0, B: 0 };
  /** 各方最近一次拿到不朽之守护的时刻（秒）；不朽盾持续 AEGIS_SEC */
  const aegisAt: Record<Side, number> = { A: -Infinity, B: -Infinity };
  /** 各方每路已被推掉的塔数（0..3），保证一塔 → 二塔 → 高地塔顺序 */
  const towerProgress: Record<Side, Record<string, number>> = {
    A: Object.fromEntries(LANES.map((l) => [l, 0])),
    B: Object.fromEntries(LANES.map((l) => [l, 0])),
  };
  const raxDown: Record<Side, Set<string>> = { A: new Set(), B: new Set() };
  const hgLane: Partial<Record<Side, string>> = {};
  /** 被推进度最高的一路（高地/兵营优先选择） */
  const deepestLane = (victim: Side): string => {
    const prog = towerProgress[victim];
    let best = LANES[0];
    for (const l of LANES) if (prog[l] > prog[best]) best = l;
    return best;
  };

  const killerWeight = (a: Actor) => KILLER_W(a.pos) * a.formK * (a === mvpActor ? CONFIG.pedia.mvpKillMult : 1);
  const victimWeight = (a: Actor) => VICTIM_W(a.pos) * a.formD * (a === mvpActor ? CONFIG.pedia.mvpDeathMult : 1);
  const pickKiller = (s: Side) => rng.weighted(actors[s], actors[s].map(killerWeight));
  // 本局每人的击杀 / 阵亡份额：A 方击杀之和 = killsA、A 方阵亡之和 = killsB（与 stats.allocateSideKda 同口径）
  for (const s of ['A', 'B'] as Side[]) {
    const qk = apportion(s === 'A' ? killsA : killsB, actors[s].map(killerWeight));
    const qd = apportion(s === 'A' ? killsB : killsA, actors[s].map(victimWeight));
    actors[s].forEach((a, i) => {
      a.qK = qk[i] ?? 0;
      a.qD = qd[i] ?? 0;
    });
  }
  /** 击杀事件的击杀者：按剩余击杀份额抽取（与 pickKiller 同样只取 1 个随机数）；份额用完时按权重 */
  const pickScorer = (s: Side): Actor => {
    const arr = actors[s];
    const k = arr.some((a) => a.qK > 0) ? rng.weighted(arr, arr.map((a) => a.qK)) : rng.weighted(arr, arr.map(killerWeight));
    if (k.qK > 0) k.qK--;
    return k;
  };
  /** 一次击杀事件中某方的 n 名阵亡者（同一事件不重复）：按剩余阵亡份额抽取，份额用完时按权重 */
  const victimsOf = (s: Side, n: number): Actor[] => {
    const res: Actor[] = [];
    let pool = actors[s].slice();
    for (let i = 0; i < n; i++) {
      if (pool.length === 0) pool = actors[s].slice();
      const v = pool.some((a) => a.qD > 0) ? rng.weighted(pool, pool.map((a) => a.qD)) : rng.weighted(pool, pool.map(victimWeight));
      if (v.qD > 0) v.qD--;
      res.push(v);
      pool.splice(pool.indexOf(v), 1);
    }
    return res;
  };
  const baseVars = (s: Side): Record<string, string | number> => {
    const me = actors[s];
    const en = actors[other(s)];
    const byPos = (arr: Actor[], p: Position) => nameOf(arr.find((x) => x.pos === p));
    return {
      T: tag[s], E: tag[other(s)], S: sideName(s), ES: sideName(other(s)),
      RT: tag[radiant], DT: tag[other(radiant)],
      C: byPos(me, 'C'), M: byPos(me, 'M'), O: byPos(me, 'O'), SS: byPos(me, 'SS'), HS: byPos(me, 'HS'),
      EC: byPos(en, 'C'), EM: byPos(en, 'M'), EO: byPos(en, 'O'), ESS: byPos(en, 'SS'), EHS: byPos(en, 'HS'),
      PLACE: rng.pick(places), RUNE: rng.pick(runes), ITEM: rng.pick(items), LANE: rng.pick(LANES),
      N: rng.int(5, 20),
      STAGE: ctx.tier === 'ti' ? '国际邀请赛舞台上，' : ctx.tier === 'major' ? 'Major 赛场，' : '',
      SCORE: `${tag.A} ${ka}:${kb} ${tag.B}`,
    };
  };
  const scoreText = () => `${tag.A} ${ka}:${kb} ${tag.B}`;
  const push = (t: number, type: LiveEventType, text: string, side?: Side) => {
    out.push({ minute: Math.floor(t / 60), second: t % 60, type, text, side, killsA: ka, killsB: kb, goldDiff: gd });
  };
  /** 推进经济：swing 为事件直接影响（A 视角），actor 为得利方（用于方向校正） */
  const moveGold = (t: number, swing: number, actor?: Side) => {
    const targetGd = traj.at(t / Dsec);
    let delta = swing + (targetGd - (gd + swing)) * LIVE.drift;
    if (actor) {
      const d = dirOf(actor);
      if (delta * d < 0) delta = d * Math.max(Math.abs(swing) * 0.3, 100);
    }
    gd = Math.round((gd + delta) / 10) * 10;
    const loserLead = -dirOf(W) * gd;
    if (loserLead > maxLoserLead) maxLoserLead = loserLead;
  };
  const perMin = (pair: number[], t: number) => pair[0] + pair[1] * (t / 60);

  /** 结算一个击杀事件的击杀者/阵亡者，返回文本变量 */
  const resolveKills = (e: Raw) => {
    const a = e.a ?? 0;
    const b = e.b ?? 0;
    const order: Side[] = rng.shuffle([...Array(a).fill('A'), ...Array(b).fill('B')] as Side[]);
    const victims: Record<Side, Actor[]> = { A: victimsOf('B', a), B: victimsOf('A', b) };
    const vi: Record<Side, number> = { A: 0, B: 0 };
    const eventKills = new Map<Actor, number>();
    const firstKill: Partial<Record<Side, { k: Actor; v: Actor }>> = {};
    const major = e.side as Side;
    // 暴走：本事件多数方的 5 个击杀归同一人（只在其剩余击杀份额足够时发生；否则照常取 1 个随机数，不影响随机序列）
    let rampager: Actor | null = null;
    if (e.rampage) {
      const need = Math.min(5, major === 'A' ? a : b);
      const cand = actors[major].map((x) => (x.qK >= need ? x.qK : 0));
      if (cand.some((w) => w > 0)) rampager = rng.weighted(actors[major], cand);
      else rng.next();
    }
    let rampLeft = rampager ? 5 : 0;
    const crossed = new Map<Actor, number>();
    for (const s of order) {
      let killer: Actor;
      if (rampager && s === major && rampLeft > 0) {
        killer = rampager;
        if (killer.qK > 0) killer.qK--;
        rampLeft--;
        rng.next(); // 与按份额抽取击杀者同样取 1 个随机数
      } else killer = pickScorer(s);
      const victim = victims[s][vi[s]++];
      killer.kills++;
      killer.streak++;
      if (STREAK_TEXT[killer.streak]) crossed.set(killer, killer.streak);
      victim.deaths++;
      victim.streak = 0;
      crossed.delete(victim);
      eventKills.set(killer, (eventKills.get(killer) ?? 0) + 1);
      if (!firstKill[s]) firstKill[s] = { k: killer, v: victim };
      if (s === 'A') ka++;
      else kb++;
    }
    // 本事件主角：多数方击杀最多者
    let top: Actor | undefined;
    let topN = 0;
    for (const [actor, n] of eventKills) {
      if (actor.side === major && n > topN) {
        top = actor;
        topN = n;
      }
    }
    const vlist = [...new Set(victims[major].map((v) => v.handle))].slice(0, 3).join('、');
    const shouts: string[] = [];
    if (top && topN >= 2 && topN <= 4) shouts.push(MULTI_TEXT[topN]);
    else if (top && topN >= 5 && top !== rampager) shouts.push('暴走');
    const godlike = [...eventKills.keys()].find((x) => x.streak >= 10 && !x.godlike);
    // 即将单独播报「超神」时不再重复连杀文案
    if (top && crossed.has(top) && godlike !== top) shouts.push(STREAK_TEXT[crossed.get(top) as number]);
    const suffix = top && shouts.length ? `${top.handle} ${shouts.join('，')}！` : '';
    return {
      a, b, top: top ?? firstKill[major]?.k, first: firstKill, vlist, suffix, rampager,
      godlike,
    };
  };

  for (let i = 0; i < raws.length; i++) {
    const e = raws[i];
    const t = e.t;
    const s: Side = e.side ?? W;
    const v = baseVars(s);
    switch (e.kind) {
      case 'start': {
        push(t, 'start', fill(pickT(TPL.start), v));
        break;
      }
      case 'lane':
      case 'farm':
      case 'item': {
        // 装备/发育类事件只给核心位
        const cores = actors[s].filter((x) => CORE_POSITIONS.includes(x.pos));
        const k = e.kind === 'lane' ? pickKiller(s) : rng.weighted(cores, cores.map(killerWeight));
        v.K = nameOf(k);
        const tpl = e.kind === 'lane' ? TPL.lane : e.kind === 'farm' ? TPL.farm : TPL.item;
        moveGold(t, 0);
        push(t, 'info', fill(pickT(tpl), v), s);
        break;
      }
      case 'firstblood':
      case 'gank':
      case 'teamfight': {
        const r = resolveKills(e);
        const major = s;
        const minor = other(major);
        const swing = (r.a - r.b) * perMin(LIVE.killGold, t);
        const isTrade = r.a === r.b;
        moveGold(t, swing, isTrade ? undefined : major);
        const fk = r.first[major];
        v.K = nameOf(r.top);
        v.P = r.top?.handle ?? '';
        v.V = nameOf(fk?.v);
        v.A = major === 'A' ? r.a : r.b;
        v.B = major === 'A' ? r.b : r.a;
        v.VLIST = r.vlist || nameOf(fk?.v);
        v.SCORE = scoreText();
        const nMaj = v.A as number;
        const nMin = v.B as number;
        // 击杀数太少的「团战」按小规模冲突描述
        const bigFight = e.kind === 'teamfight' && nMaj + nMin >= LIVE.teamfightMinKills;
        let type: LiveEventType = bigFight ? 'teamfight' : 'kill';
        let text: string;
        if (e.kind === 'firstblood') {
          type = 'firstblood';
          text = fill(pickT(TPL.firstblood), v);
        } else if (isTrade) {
          const fa = r.first.A;
          const fb = r.first.B;
          v.KA = nameOf(fa?.k);
          v.VA = nameOf(fa?.v);
          v.KB = nameOf(fb?.k);
          v.VB = nameOf(fb?.v);
          const pool = nMaj === 1 ? [...TPL.trade, ...TPL.tradeOne] : nMaj >= 3 ? [...TPL.trade, ...TPL.tradeBig] : TPL.trade;
          text = fill(pickT(pool), v);
        } else if (bigFight) {
          const pool = nMaj >= 5 && nMin === 0 ? TPL.wipe
            : nMin === 0 ? [...TPL.teamfight, ...TPL.teamfightClean]
              : [...TPL.teamfight, ...TPL.teamfightCostly];
          text = fill(pickT(pool), v);
        } else {
          text = fill(pickT(nMaj >= 2 ? TPL.gankMulti : TPL.gank), v);
        }
        push(t, type, joinSentence(text, r.suffix), isTrade ? undefined : major);
        // 动态事件：暴走 / 超神 / 翻盘
        let dt = 1;
        if (r.rampager && dynamicLeft > 0) {
          dynamicLeft--;
          push(t + dt++, 'rampage', fill(pickT(TPL.rampage), { ...v, K: nameOf(r.rampager), P: r.rampager.handle }), major);
        }
        if (r.godlike && dynamicLeft > 0) {
          dynamicLeft--;
          r.godlike.godlike = true;
          const gs = r.godlike.side;
          push(t + dt++, 'godlike', fill(pickT(TPL.godlike), { ...baseVars(gs), K: nameOf(r.godlike) }), gs);
        }
        const winnerAhead = dirOf(W) * gd > 0;
        const scripted = e.turn && traj.comeback;
        const detected = !traj.comeback && winnerAhead && maxLoserLead >= LIVE.comebackDetectLead;
        if (!comebackShown && dynamicLeft > 0 && major === W && (scripted || detected) && i < raws.length - 1) {
          comebackShown = true;
          dynamicLeft--;
          push(t + dt++, 'comeback', fill(pickT(TPL.comeback), { ...baseVars(W), N: fmtGold(maxLoserLead) }), W);
        }
        break;
      }
      case 'tower': {
        const victim = other(s);
        const want = t < Dsec * 0.35 ? 0 : t < Dsec * 0.65 ? 1 : 2;
        const prog = towerProgress[victim];
        const open = LANES.filter((l) => prog[l] < TOWER_TIERS.length);
        let lane = '';
        let tierName = '基地塔';
        if (open.length) {
          // 优先选择「下一座塔」正好是当前阶段的路，否则选最接近的
          const gap = (l: string) => Math.abs(prog[l] - want);
          const bestGap = Math.min(...open.map(gap));
          lane = rng.pick(open.filter((l) => gap(l) === bestGap));
          tierName = TOWER_TIERS[prog[lane]];
          prog[lane]++;
        }
        v.LANE = lane;
        v.TIER = tierName;
        v.K = nameOf(pickKiller(s));
        moveGold(t, dirOf(s) * perMin(LIVE.towerGold, t), s);
        push(t, 'tower', fill(pickT(TPL.tower), v), s);
        break;
      }
      case 'roshan': {
        roshanNo++;
        v.RN = roshanNo;
        v.K = nameOf(pickKiller(s));
        const cheeseFrom = date && date >= CHEESE_FROM_THIRD_SINCE ? 3 : 2;
        const pool: readonly string[] = rng.chance(LIVE.stealChance) ? TPL.roshanSteal : roshanNo >= cheeseFrom ? TPL.roshanCheese : TPL.roshan;
        const tpl = roshBy[s] > 0 ? pool : pool.filter((x) => !x.includes('再次'));
        roshBy[s]++;
        aegisAt[s] = t;
        moveGold(t, dirOf(s) * perMin(LIVE.roshGold, t), s);
        push(t, 'roshan', fill(pickT(tpl.length ? tpl : pool), v), s);
        break;
      }
      case 'buyback': {
        const buyer = actors[s][rng.int(0, actors[s].length - 1)];
        v.V = nameOf(buyer);
        // 买活花钱 → 经济向对方倾斜
        moveGold(t, -dirOf(s) * perMin(LIVE.buybackGold, t));
        push(t, 'buyback', fill(pickT(TPL.buyback), v), s);
        break;
      }
      case 'hg_fail': {
        moveGold(t, 0);
        push(t, 'highground', fill(pickT(TPL.highgroundFail), v), s);
        break;
      }
      case 'highground': {
        const lane = deepestLane(other(s));
        towerProgress[other(s)][lane] = TOWER_TIERS.length; // 上高即拆掉该路高地塔
        hgLane[other(s)] = lane;
        v.LANE = lane;
        moveGold(t, dirOf(s) * perMin(LIVE.raxGold, t) * 0.5, s);
        // 「带着不朽盾」只在该方确实持有不朽盾时使用
        const hasAegis = t - aegisAt[s] <= AEGIS_SEC;
        const hgPool = hasAegis ? TPL.highground : TPL.highground.filter((x) => !x.includes('不朽盾'));
        push(t, 'highground', fill(pickT(hgPool), v), s);
        break;
      }
      case 'barracks':
      case 'mega': {
        const victim = other(s);
        const order = [hgLane[victim], deepestLane(victim), ...LANES].filter((l): l is string => !!l);
        const lane = order.find((l) => !raxDown[victim].has(l)) ?? deepestLane(victim);
        raxDown[victim].add(lane);
        v.LANE = lane;
        moveGold(t, dirOf(s) * perMin(LIVE.raxGold, t), s);
        push(t, 'barracks', fill(pickT(e.kind === 'mega' ? TPL.mega : TPL.barracks), v), s);
        break;
      }
      case 'incident': {
        const inc = e.incident as InMatchEvent;
        v.TEXT = inc.text;
        const good = inc.powerMult >= 1;
        moveGold(t, 0);
        push(t, 'incident', fill(pickT(good ? TPL.incidentGood : TPL.incidentBad), v), s);
        break;
      }
      case 'gg': {
        moveGold(t, dirOf(W) * perMin(LIVE.raxGold, t) * 0.5, W);
        const gv = baseVars(W);
        gv.W = tag[W];
        gv.L = tag[L];
        gv.LS = sideName(L);
        gv.MVP = mvpActor ? nameOf(mvpActor) : nameOf([...actors[W]].sort((x, y) => y.kills - x.kills)[0]);
        gv.SCORE = scoreText();
        const behind = dirOf(W) * gd < 0;
        gv.N = fmtGold(gd);
        const ggPool = behind ? TPL.ggBehind : traj.comeback && comebackShown ? TPL.ggComeback : TPL.gg;
        push(t, 'gg', fill(pickT(ggPool), gv), W);
        break;
      }
    }
  }

  // ---------------- 时间戳严格递增 ----------------
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].minute * 60 + out[i - 1].second;
    let cur = out[i].minute * 60 + out[i].second;
    if (cur <= prev) {
      cur = prev + 1;
      out[i].minute = Math.floor(cur / 60);
      out[i].second = cur % 60;
    }
  }
  // 兜底：最终比分必须与结果一致（理论上不会触发）
  const last = out[out.length - 1];
  if (last && (last.killsA !== killsA || last.killsB !== killsB)) {
    last.killsA = Math.max(last.killsA, killsA);
    last.killsB = Math.max(last.killsB, killsB);
  }
  if (ctx.kdOut) {
    for (const a of [...actors.A, ...actors.B]) if (a.playerId) ctx.kdOut[a.playerId] = [a.kills, a.deaths];
  }
  return out;
}
