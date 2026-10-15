// ============================================================================
// 全部可调数值。业务代码禁止写魔法数字，统一从这里读取。
// ============================================================================
import type { Position, Tier, TournamentTier, Region } from './types';

export const SAVE_VERSION = 1;

export const CONFIG = {
  // -------------------------------------------------------------------------
  // 天梯
  // -------------------------------------------------------------------------
  ladder: {
    /** 等级阈值：mmr ≥ 阈值 即为该等级（低于 C 阈值也显示 C） */
    thresholds: { C: 5000, B: 5500, A: 6500, S: 8000, SS: 11000, SSR: 15000 } as Record<Tier, number>,
    /** 同等战斗力下的天梯倍数（需求原文 0.5 视为 0.95 笔误） */
    multipliers: { C: 0.9, B: 0.95, A: 1.0, S: 1.05, SS: 1.1, SSR: 1.15 } as Record<Tier, number>,
    minMmr: 3000,
    maxMmr: 20000,
  },

  // -------------------------------------------------------------------------
  // 选手
  // -------------------------------------------------------------------------
  player: {
    /** false: 高韧性 → 事件影响小（常识方向）；true: 按需求原文字面（低韧性 → 影响小） */
    resilienceInverted: false,
    /** 事件影响缩放：impact × (1 - resilience / resilienceDivisor) */
    resilienceDivisor: 150,
    /**
     * softCap = clamp((start - power)/range, min, 1)：战力越高越难涨（85 → 0.53，90 → 0.28，95 → 0.03）。
     * 起点/斜率决定联赛顶端的平衡点：多赛季模拟中顶级选手稳定在 88~98，极少超过 100（平衡性模拟标定）。
     * 97 → 95.5（E3）：赛季状态（±7%）让 TI 时有效战力前十均值约 +1.5，基础战力上限相应下调，使有效战力分布与之前一致
     */
    powerSoftCapStart: 95.5,
    powerSoftCapRange: 20,
    powerSoftCapMin: 0.02,
    maxAttr: 100,             // talent/resilience/insight/loyalty 上限
    rookieAgeRange: [16, 20] as [number, number],
    /** eventImpactScale 结果夹紧区间 */
    eventScaleMin: 0.2,
    eventScaleMax: 1.2,
  },

  // -------------------------------------------------------------------------
  // 成长（天赋决定随机区间宽度）
  // -------------------------------------------------------------------------
  growth: {
    talentExponent: 1.6,
    /**
     * 单次训练：gain = U(min, min + spread × (talent/100)^exp)（天赋 = 随机区间宽度，用户原始规则）。
     * 成长重平衡（用户反馈 2026-10-09「成长性不高」）：休赛训练是战斗力 / 天梯 / 灵性成长的主要来源。天赋 75 的单次均值
     * 战力 0.40 / 天梯 105 / 灵性 0.35，约为原来（power 0.05/0.75、mmr 10/110、insight 0.03/0.4）的 1.4 / 2.3 / 2.2 倍；
     * 天赋 40 只有 0.18 / 45 / 0.15（下限保持原值、只放大幅度：天赋 = 区间宽度，低天赋练了也长得慢）。比赛只带来少量成长（见 tournament）。
     * 复核（2026-10-09）：首版（0.1/1.35、15/380、0.05/1.75）下只用每回合的免费训练（不花钱、只是不打可选赛事）就能拿到大部分成长，
     * 额外训练又贵到几乎没人买得起——单次收益收回约 1/4、额外训练降价，「花钱多练」才是快速成长的来源。
     * AI 战队按 training.aiGainMult / aiExtraTrainingsPerRound / aiBusyExtraPerRound 另行标定（AI 参赛多、不花钱，保证联赛整体分布与改动前一致）。
     */
    training: {
      power: { min: 0.05, spread: 1.1 },
      mmr: { min: 10, spread: 300 },
      insight: { min: 0.03, spread: 1.0 },
    },
    /** 训练焦点倍数 [power, mmr, insight] */
    focus: {
      power: [1.0, 0.3, 0.2],
      mmr: [0.3, 1.0, 0.2],
      insight: [0.2, 0.2, 1.0],
      balanced: [0.5, 0.5, 0.5],
    } as Record<string, [number, number, number]>,
    /** 替补选手训练收益倍数 */
    benchTrainingMult: 0.6,
    /** 年龄成长系数：[maxAge(含), factor] 升序匹配 */
    ageFactor: [
      [19, 1.25], [22, 1.0], [24, 0.8], [26, 0.55], [29, 0.35], [200, 0.2],
    ] as [number, number][],
    /** 天梯越高越难涨：mmrGain × clamp((mmrCapSoft - mmr)/mmrCapRange, 0.15, 1) */
    mmrSoftCap: 17000,
    mmrSoftCapRange: 9000,
    mmrSoftCapMin: 0.15,
    /** 灵性越高越难涨：clamp((start - insight)/range, min, 1)（灵性不受年龄压制） */
    insightSoftCapStart: 110,
    insightSoftCapRange: 50,
    insightSoftCapMin: 0.1,
    /** 教练提升天赋/韧性的软上限：clamp((maxAttr - v)/range, min, 1) */
    coachBoostSoftCapRange: 50,
    coachBoostSoftCapMin: 0.1,
    /**
     * 年轻选手（< aging.talentDeclineStartAge）每次训练天赋自然增长 U(a,b) × ageFactor
     * （同一休赛回合第 2 次起的训练 × training.extraSessionAttrMult，与教练提升相同）
     */
    youngTalentGain: [0, 0.12] as [number, number],
    /**
     * 赛事结算成长：按名次百分位 p(0=冠军) 的倍数 = lerp(max, min, p) × 等级倍数 × 场次因子。
     * 成长重平衡（用户反馈 2026-10-09）：比赛主要带来荣誉、金钱与**韧性**——战斗力 / 天梯 / 灵性约为原来的 30%
     * （原 power 0.05/0.4、mmr 15/120、insight 0.05/0.4），新增韧性成长（大赛压力：打得越多、名次越靠前、赛事越大越多，TI 最多）。
     */
    tournament: {
      power: { min: 0.015, spread: 0.12 },
      mmr: { min: 4.5, spread: 36 },
      insight: { min: 0.015, spread: 0.12 },
      placeMultBest: 1.4,
      placeMultWorst: 0.6,
      tierMult: { ti: 1.5, major: 1.3, premier: 1.15, minor: 1.0, qualifier: 0.6 } as Record<TournamentTier, number>,
      /** 场次因子 = clamp(sqrt(seriesPlayed / seriesRef), range) */
      seriesRef: 5,
      seriesFactorRange: [0.4, 1.6] as [number, number],
      /**
       * 韧性：U(min, min + spread × (天赋/100)^exp) × 名次压力 lerp(best, worst, p) × resilienceTierMult × 场次因子 × 软上限（越接近 100 越难涨）。
       * 天赋 70 的首发每项赛事平均约 +0.3（只打比赛、一季约 19 项赛事约 +5，TI 冠军单项约 +1.4）——比赛是韧性的主要来源：
       * 复核（2026-10-09）：首版 0.06/0.3 时只打比赛一季只 +1.9，反而少于狂练（教练每次训练提升韧性）的 +3.1；现只打比赛 +5.3~5.7、狂练 +2.5~3.3。
       */
      resilience: { min: 0.2, spread: 0.9 },
      resiliencePlaceBest: 1.3,
      resiliencePlaceWorst: 0.7,
      resilienceTierMult: { ti: 2.0, major: 1.4, premier: 1.2, minor: 1.0, qualifier: 0.7 } as Record<TournamentTier, number>,
    },
  },

  // -------------------------------------------------------------------------
  // 年龄（每届 TI 结算）
  // -------------------------------------------------------------------------
  aging: {
    /**
     * 各位置巅峰年龄窗口 [起, 止]（含）：核心/中单 21–25、劣势路 22–26、辅助 23–28（辅助巅峰更晚、更长）。
     * 超过「止」之后：训练/赛事成长 × postPeakGrowthMult，且逐季加速衰减（见 postPeakDecline*）。
     * 成长年龄系数本身（growth.ageFactor 表）与位置无关：各位置成长速度相同，辅助只是更晚开始衰退。
     */
    peakWindow: {
      C: [21, 25], M: [21, 25], O: [22, 26], SS: [23, 28], HS: [23, 28],
    } as Record<Position, [number, number]>,
    postPeakGrowthMult: 0.6,
    /** 核心位（C/M）开始衰退的年龄 = peakWindow.C[1] + 1（仅界面说明用；实际按位置窗口计算） */
    powerDeclineStartAge: 26,
    /**
     * 巅峰后战力衰减（每赛季，按刚结束赛季的年龄）：y = 年龄 - 巅峰止，
     * 均值 = base × y^exp（≤ max）× U(jitter) × form.trendDeclineMult（隐藏趋势为负时衰退更快）。
     * 1 号位：26 岁约 -1.1、27 岁 -2.1、28 岁 -3.0、30 岁 -4.7/赛季（旧版 -1.1 / -1.8 / -2.4 / -3.4）；辅助顺延 3 年。
     * 抖动区间较窄：衰退是连续几个赛季的下滑，而不是某一季断崖。
     */
    postPeakDeclineBase: 1.1,
    postPeakDeclineExp: 0.9,
    postPeakDeclineMax: 5,
    postPeakDeclineJitter: [0.7, 1.3] as [number, number],
    /**
     * 天梯分衰减：y' = 年龄 - 巅峰止 + mmrDeclineLead（≥ 1 才衰减），均值 = perYear × y'（≤ max）× U(jitter) × 趋势倍数。
     * 幅度比战力温和：天梯等级跨档是 ±5% 的评分台阶，衰减过快会让老将在某一季突然掉档（断崖）
     */
    mmrDeclineLead: 0,
    mmrDeclinePerYear: 70,
    mmrDeclineMax: 400,
    mmrDeclineJitter: [0.5, 1.5] as [number, number],
    talentDeclineStartAge: 24,
    talentDecline: [0, 3] as [number, number],
    resilienceGain: [1, 4] as [number, number],
    insightGain: [0.2, 1.5] as [number, number],
    retireMinAge: 26,                    // 年龄超过 25 才可能退役
    retireBase: 0.06,                    // p = base × (age-25-位置后移) + lowTierBonus
    retireLowTierBonus: { C: 0.15, B: 0.1, A: 0.05, S: 0.02, SS: 0, SSR: 0 } as Record<Tier, number>,
    retireMax: 0.85,
    /** 退役年龄按位置后移（辅助职业生涯更长） */
    retireAgeShift: { C: 0, M: 0, O: 1, SS: 2, HS: 2 } as Record<Position, number>,
    /**
     * 仍保持高水准的选手较少退役：p × lerp(1, retireStarMult, clamp((基础战力 - retireStarFrom)/retireStarRange, 0, 1))。
     * 避免冠军队的主力在巅峰末期突然集体退役（衰退几个赛季、实力下滑后才更可能退役）
     */
    retireStarFrom: 80,
    retireStarRange: 10,
    /** 0.5 → 0.3（E3 复核）：冠军队次赛季评分大跌的案例中约 2/3 伴随主力退役，战力 90+ 的选手退役概率再减（退役平均年龄不变） */
    retireStarMult: 0.3,
  },

  // -------------------------------------------------------------------------
  // 赛季状态 & 隐藏趋势（form.ts）
  // -------------------------------------------------------------------------
  form: {
    enabled: true,
    /** 赛季初为玩家战队发一条本队赛季状态简报（只列状态明显起伏的选手） */
    newsForHumanTeams: true,
    /**
     * 赛季状态：战斗力 × N(1 + 趋势 × trendWeight, σ) 夹在 range；σ = sigma × 韧性系数 × 年轻系数。
     * 趋势项约占状态方差的一半（相邻赛季状态相关 ≈ 0.35）：低迷/火热往往延续到下赛季，而不是每季独立重掷；
     * 总体离散度不变（σ_总 ≈ 0.027），上下限触顶约 1%。
     */
    sigma: 0.02,
    range: [0.93, 1.07] as [number, number],
    trendWeight: 0.045,
    /** 韧性系数 = lerp(a, b, 韧性/100)：韧性越高，状态越稳定 */
    sigmaResilience: [1.3, 0.7] as [number, number],
    /** 年轻系数：[maxAge(含), mult] 升序匹配，未匹配 = 1 */
    sigmaYouth: [[19, 1.35], [21, 1.15]] as [number, number][],
    /** 状态标签（按赛季状态倍数）：≥ hot 火热 / ≥ up 上升 / > down 平稳 / > slump 低迷 / 否则挣扎 */
    labels: { hot: 1.035, up: 1.012, down: 0.988, slump: 0.965 },
    /**
     * 隐藏趋势 Player.formTrend（每赛季初更新）：trend = persistence × 上季 + 漂移 + N(0, σ)，夹在 range。
     * 漂移：巅峰前 youthDrift × clamp((天赋 - talentPivot)/talentSpan, youthTalentFactorRange)（高天赋年轻人易爆发）；
     *       巅峰后 postPeakDrift × min(已过巅峰年数, postPeakDriftCapYears)（衰退期延续 2~3 个赛季）。
     * 作用：本赛季训练/赛事成长 × (1 + 趋势 × growthWeight)；赛季末年龄衰减 × (1 - 趋势 × declineWeight)；赛季状态均值偏移。
     */
    trend: {
      /** 0.7：一个赛季后保留 70%、两季 49%、三季 34%（趋势延续 2~3 个赛季）；稳态标准差 ≈ sigma / √(1 - 0.7²) ≈ 0.42 */
      persistence: 0.7,
      sigma: 0.3,
      youthSigmaMult: 1.4,
      range: [-1, 1] as [number, number],
      /** 稳态均值 = 漂移 / (1 - persistence)：天赋 85+ 的年轻人 ≈ +0.3，巅峰后第 3 年起 ≈ -0.3 */
      youthDrift: 0.09,
      talentPivot: 55,
      talentSpan: 30,
      youthTalentFactorRange: [-0.5, 1] as [number, number],
      postPeakDrift: -0.03,
      postPeakDriftCapYears: 3,
      /** 趋势 +0.8 → 成长 ×1.4（爆发赛季），-0.8 → ×0.6 */
      growthWeight: 0.5,
      declineWeight: 0.3,
    },
    /**
     * 荣誉势头（第十四波，momentum.ts；人机共用，Team.momentum）：
     * - 同比（赛季初）：shift = clamp(yoyWeight × ln(max(本季初荣誉, floor) / max(上季初荣誉, floor)), ±yoyCap)，
     *   作为该队全部选手赛季状态均值的加项（荣誉 +50% → 约 +2%，翻倍 → 上限 +3%；−30% → 约 −1.8%）。第一个赛季无同比。
     * - 环比（每回合结束）：ewma ← (1 − alpha) × ewma + alpha × (本回合荣誉变化 / max(荣誉, floor))，
     *   roundMult = 1 + clamp(roundWeight × ewma, ±roundCap)，作用于五名首发评分之和（team.teamRating）；荣誉不变时按 (1 − alpha) 逐回合衰减回 1。
     *   荣誉 300 的战队连赢两站 Minor（各 +20）约 +1.3%，输掉一次 Major（−40）约 −1.6%。
     */
    honorMomentum: {
      enabled: true,
      yoyWeight: 0.05,
      yoyCap: 0.03,
      yoyFloor: 100,
      roundWeight: 0.3,
      roundCap: 0.02,
      roundAlpha: 0.4,
      roundFloor: 100,
      /** 势头标签阈值（按合计乘子偏离 1 的百分比） */
      labels: { strong: 0.012, up: 0.004, down: -0.004, weak: -0.012 },
    },
  },

  // -------------------------------------------------------------------------
  // 赛季自主成长（development.ts，第九波）：每个赛季开始时（TI 结算的退役 / 年龄衰退之后、选秀与转会潮之前），
  // 全体在役选手（首发、替补、自由选手、AI 战队选手）各执行一次；新游戏的第一个赛季不执行。
  // -------------------------------------------------------------------------
  development: {
    enabled: true,
    /**
     * 真实选手（有生涯轨迹，src/data/trajectories.json）：向「当届真实水平」（相邻两届之间线性插值）靠拢差距的 rate × U(jitter)；
     * 天梯为主、战力少量。最后一届真实数据之后改按潜力（天赋 / 年龄）成长；自主成长永远不超过真实生涯峰值 + peakMargin。
     */
    trajectory: {
      mmrRate: 0.7,
      powerRate: 0.35,
      peakMarginMmr: 600,
      peakMarginPower: 2,
    },
    /**
     * 程序生成选手（及真实选手最后一届数据之后）的隐藏潜力上限：首次自主成长时评估，之后固定。
     * 潜力 = 当时水平 + 成长空间；成长空间 = perYear × 剩余成长年数^yearsExp × 天赋系数 × U(jitter) × 软上限
     * （天梯 growth.mmrSoftCap、战力 player.powerSoftCap：越接近顶端空间越小，SSR 仍然稀有）。
     * 剩余成长年数 = 位置巅峰窗口起 + growthEndOffset − 年龄；巅峰窗口内至少 inWindowYears；已过巅峰为 0。
     * 天赋系数 = (max(0, 天赋 − talentPivot) / talentSpan)^talentExp，上限 talentMultMax（天赋 70 ≈ 1、90 ≈ 1.8、50 ≈ 0.4）。
     * 标定参照真实阵容数据的逐年变化：18 岁 → 23 岁平均约 +1700 天梯、+7 战力。
     */
    potential: {
      mmrPerYear: 550,
      powerPerYear: 1.6,
      growthEndOffset: 1,
      inWindowYears: 0.3,
      yearsExp: 0.85,
      talentPivot: 25,
      talentSpan: 45,
      talentExp: 1.6,
      talentMultMax: 2.4,
      jitter: [0.6, 1.4] as [number, number],
      /** 每赛季向潜力靠拢的比例 × 年龄系数（巅峰前 1、巅峰窗口内 inWindowMult、巅峰后 0：老将只会平稳或衰退） */
      mmrRate: 0.4,
      powerRate: 0.3,
      inWindowMult: 0.5,
    },
    /** 单赛季自主成长上限（天梯 / 战力） */
    maxUpMmr: 2500,
    maxUpPower: 6,
    /** 每名选手每赛季的随机幅度 */
    jitter: [0.8, 1.2] as [number, number],
    /**
     * 超出参照水平（当届真实水平 / 潜力上限）后的回落（天梯是相对排名，人人上分即整体回落）：超出 tolerance 的部分 × rate，
     * 单季最多 maxDown*。AI 战队与自由选手容差小，保证联赛整体等级分布稳定；人类玩家战队容差更大、回落更慢
     * （经理的训练仍叠加在自主成长之上：与 AI 同样训练时稳态约高 +500 天梯 / +1.5 战力，多练的部分大多保留）。
     * 标定（TI1 起 16 季无头模拟）：TI 时真实首发与当届真实水平平均只差 +0~300 天梯、+1 战力；首发前十战力约 89~91、最高 ≤ 95；
     * 关闭自主成长时首发 SS/SSR 占比第 6 个赛季即达约 67%、首发前十战力 93~94，真实新秀（如 Yatoro）因无人签约长期停在 C 级。
     */
    regression: {
      ai: { mmrTolerance: 100, powerTolerance: 0.5, mmrRate: 0.85, powerRate: 0.7 },
      human: { mmrTolerance: 500, powerTolerance: 1.5, mmrRate: 0.7, powerRate: 0.6 },
      maxDownMmr: 1500,
      maxDownPower: 5,
    },
    /**
     * 训练投入保护（成长重平衡，2026-10-09：训练是成长的主要来源，经理花钱练出来的提升要能留住）：
     * 人类玩家战队训练获得的天梯 / 战力记入 Player.development.trainedMmr / trainedPower（growth.trainTeam），
     * 赛季初回落时其中 min(训练投入, max × (天赋/100)^talentExp) 不计入超出部分（天赋 90 ≈ +3000 天梯 / +6 战力，
     * 70 ≈ +2000 / +4，50 ≈ +1150 / +2.3，30 ≈ +500 / +1）：训练过的选手可以超出自身轨迹 / 潜力，天赋越高超出越多。
     * 每个赛季自主成长之后训练投入 × (1 − decay)：停止训练的选手，保护逐季减少、慢慢回到自身水平。
     * 天梯相对校准（ladder）中训练投入 ≥ calibrationMinMmr 的选手最后才回落（仍计入名额，联赛整体公平）。
     */
    investment: {
      enabled: true as boolean,
      maxMmr: 3000,
      maxPower: 6,
      talentExp: 1.6,
      decay: 0.25,
      calibrationMinMmr: 800,
    },
    /**
     * 战队选手的赛季内预期成长（训练 + 赛事成长，多赛季模拟实测 AI 战队的均值）：自主成长的目标先扣除这部分，
     * 使「自主成长 + 赛季内成长」≈ 当届真实水平 / 潜力上限（否则联赛每季整体上浮一截）；自由选手不扣除。
     * 回落参照同样扣除（AI 与人类玩家战队同一基准，人类玩家战队只是回落容差更大）。
     * 预期成长 = per × 年龄系数（[最大年龄(含), 系数] 升序匹配）× 软上限（天梯 growth.mmrSoftCap、战力 player.powerSoftCap）。
     */
    seasonAllowance: {
      mmr: 1000,
      power: 4,
      byAge: [[22, 1], [25, 0.65], [28, 0.3], [200, 0.12]] as [number, number][],
      /** 替补（赛季初不在首发阵容）：训练 × 0.6 且不参加赛事成长，实测约为首发的 15% */
      benchMult: 0.15,
    },
    /**
     * 界面成长趋势（只显示定性标签，不显示潜力数值）：剩余空间 = max(0, 上限天梯 − 天梯) + max(0, 上限战力 − 战力) × powerToMmr；
     * ≥ roomHigh 且仍在成长期 → 仍有成长空间；已过巅峰且空间 < roomHigh → 已过巅峰；否则接近巅峰。
     */
    outlook: {
      powerToMmr: 250,
      roomHigh: 900,
    },
    /** 赛季初为玩家战队发一条本队自主成长简报（只列天梯变化 ≥ newsMinMmr、战力变化 ≥ newsMinPower 或天梯跨档的正式队员） */
    newsForHumanTeams: true,
    newsMinMmr: 400,
    newsMinPower: 1.5,
    /**
     * 天梯相对校准（第九波 QA，development.calibrateLadder）：天梯是相对排名——每个赛季自主成长之后（新秀选秀之前），
     * 联赛在籍选手（未解散战队的正式队员，不含临时 / 野外替补）中 SSR 人数 > max(ssrMin, 在籍人数 × ssrShare)、
     * SS 及以上人数 > 在籍人数 × ssPlusShare 时，没有当届真实参照的选手（程序生成选手、真实选手最后一届数据之后）
     * 按天梯从低到高回落到该等级门槛 − margin，潜力上限同步下调；有当届真实轨迹的真实选手不参与（真实历史优先）。
     * 新秀等级分布（用户指定）不变：选秀在校准之后，选中的新秀至少以原等级打完首个赛季。
     * 标定（真实阵容 rosters/ti1–15：在籍 SS+ 14%~55%、均值约 30%，SSR 每届 1~3 人）：不校准时用户指定分布下的
     * SS / SSR 程序生成新秀长期在役，TI1 起第 10 个赛季在籍 SS+ 约 44%、SSR 约 11 人，第 16 个赛季 49% / 18 人（首发 SS+ 60%）。
     */
    ladder: {
      enabled: true as boolean,
      ssrShare: 0.03,
      ssrMin: 3,
      ssPlusShare: 0.36,
      margin: 150,
    },
  },

  // -------------------------------------------------------------------------
  // 教练
  // -------------------------------------------------------------------------
  coach: {
    /** 按等级的基础提升幅度（0..10），实例在此基础上 ±30% 随机 */
    boostByTier: { C: 2, B: 3, A: 4.5, S: 6, SS: 7.5, SSR: 9 } as Record<Tier, number>,
    boostVariance: 0.3,
    talentPerTraining: 0.06,    // talent += talentBoost × 此值
    resiliencePerTraining: 0.1, // resilience += resilienceBoost × 此值
    insightWeightInDraft: 0.35, // 战队灵性 = 首发均值 × (1-w) + 教练灵性 × w
    ratingBonusPerInsight: 0.15, // 战队评分加成 = insight × 此值
    salaryByTier: { C: 700, B: 1100, A: 1800, S: 2900, SS: 4500, SSR: 6800 } as Record<Tier, number>,
    /**
     * 教练市场容量（第六波：在队选手退役一律转教练，原先教练池逐季无限增长，16 个赛季可达 400+）。
     * 每赛季初清理：年龄 ≥ retireAge 的自由教练退出；自由教练仍多于 freePoolMax 时按「等级 → 灵性」保留最好的。
     * 有东家的教练、待处理决策引用的教练、玩家战队旧部转任的教练不受影响。
     */
    freePoolMax: 40,
    retireAge: 60,
  },

  // -------------------------------------------------------------------------
  // 赛季教练供给（第九波 #3，coaches.ts）：每个赛季开始时（新秀选秀之后、AI 季前转会之前）向教练市场引入一批教练：
  // 程序生成（等级分布见 tierWeights，含少量高等级）+ 该届 roster 中尚未进入游戏的真实教练 + 上赛季退役选手转任（growth.ts 已有），
  // 不足保底时追加生成。AI 只在没有主教练时按概率 / 预算聘请，并且不会让市场跌破保底（ai.ts maybeHireCoach）。
  // -------------------------------------------------------------------------
  coachSupply: {
    /** 每赛季固定引入的程序生成教练数 */
    generatedPerSeason: 6,
    /** 程序生成教练的等级权重（%） */
    tierWeights: { C: 20, B: 30, A: 26, S: 15, SS: 7, SSR: 2 } as Record<Tier, number>,
    /** 保底追加生成高等级教练时的等级权重（S 级及以上） */
    topTierWeights: { C: 0, B: 0, A: 0, S: 70, SS: 25, SSR: 5 } as Record<Tier, number>,
    /** 是否引入该届 roster 中尚未进入游戏的真实教练（战队主教练 + 自由教练；src/data/coachIndex.json） */
    includeRealCoaches: true as boolean,
    /** 每赛季最多引入的真实教练数（按等级 → 灵性优先） */
    realMaxPerSeason: 12,
    /**
     * 保底：赛季初（AI 季前签约前后都成立）教练市场可签约人数 ≥ max(minAvailable, 没有主教练的战队数 + vacancyMargin)，
     * 其中 S 级及以上 ≥ minTopTier。AI 签约不会让市场跌破 minAvailable / minTopTier
     * （AI 每签一人，空缺与可签人数同减 1，「空缺 + margin」一项自然保持）。
     */
    minAvailable: 8,
    vacancyMargin: 5,
    minTopTier: 3,
    /** 「高等级」门槛 */
    topTier: 'S' as Tier,
    /**
     * AI 挑选教练：在负担得起的教练中按「与本队首发平均等级的差距」加权随机（差 k 级权重 × aiTierMatchDecay^k），
     * 而不是总挑市场上最好的；强队倾向高等级教练，弱队倾向中低等级。
     */
    aiTierMatchDecay: 0.4,
  },

  // -------------------------------------------------------------------------
  // 归属感
  // -------------------------------------------------------------------------
  loyalty: {
    leaveThreshold: 30,
    leaveChancePerRound: 0.12,     // 低于阈值时每回合主动申请离队概率
    poachChancePerRound: 0.08,     // 被挖角报价概率
    winSeries: 0.6,
    loseSeries: -0.4,
    title: 6,
    unpaidSalary: -12,
    benchPerRound: -0.8,           // 连续替补每回合
    tenurePerSeason: 3,
    honorGapPenalty: -1.5,         // 战队荣誉低于选手身价期待时每回合
    benchGraceRounds: 1,           // 连续替补超过此回合数才开始扣归属感
    /**
     * 阵容超出常规上限（team.maxRoster）时，长期替补（超过 benchGraceRounds）每回合额外扣的归属感：
     * 每超出 1 人 × 此值，最多按 overRosterBenchMaxExcess 人计（8 人阵容的替补每回合 −0.8；10 人时 −1.6；12 人起 −2.4）。
     */
    overRosterBenchPerRound: -0.4,
    overRosterBenchMaxExcess: 4,
    honorGapRatio: 0.75,           // 战队荣誉 < 期待(market.tierHonorExpectation) × 此值 才算「显著低于」
    freeAgentTarget: 60,           // 自由选手归属感每回合向此值回归
    freeAgentRegression: 0.05,     // 回归比例
  },

  // -------------------------------------------------------------------------
  // 隐藏的预期薪资与归属感环境模型（salary.ts，第八波）：预期薪资不在界面显示，只给定性情绪
  // -------------------------------------------------------------------------
  salary: {
    /**
     * 预期薪资 = 市场工资(computeSalary) × 荣誉系数 × 明星系数。
     * 荣誉系数（凸函数，荣誉越高增长越快）= honorBase + honorK × (max(0, 荣誉)/honorRef)^honorExp，夹在 [honorBase, honorMaxFactor]：
     * 100 荣誉（新俱乐部）≈ ×0.90、500 ≈ ×0.95、1000 ≈ ×1.06、1500 ≈ ×1.23、2000 ≈ ×1.46、2500 ≈ ×1.73、约 2800 起 ×1.9（上限）。
     * 平衡（第八波 QA，scripts/simulate 多局无头模拟）：原 1 + 0.06 × (h/1000)^1.6（2000 ≈ ×1.18）下，玩家接管的 OG（TI9 起 6 季）
     * 平均资金 0.9M → 7.2M、最高 11.5M，阵容不变也毫无工资压力；顶端加陡后 → 平均 4.5M，工资总额 +35%（TI 冠军次数不变）。
     * 底端 < 1：小俱乐部的选手按略低于市场的工资就满意，续约要价（≥ 预期）约等于市场工资 —— TI13 起新俱乐部 4 季解散率 4/8 → 0/8。
     */
    honorRef: 1000,
    honorBase: 0.9,
    honorK: 0.16,
    honorExp: 1.8,
    honorMaxFactor: 1.9,
    /** 明星系数 = 等级系数 × (1 + min(fame.maxBonus, 近期热度 × fame.weight)) */
    starTierMult: { C: 1, B: 1, A: 1.02, S: 1.04, SS: 1.07, SSR: 1.1 } as Record<Tier, number>,
    /**
     * 近期热度：每个冠军 +title（TI 冠军另加 tiTitle）、每个单局 MVP +mvp；每赛季 × seasonDecay；上限 max。
     * 平衡：王朝球星（一季 6~8 冠 + TI）热度 ≈ 12~15 → 明星加成达到上限 +50%；续约发生在新赛季初（热度已衰减一次），
     * seasonDecay 0.5 → 0.6 让「上赛季的成功」在续约要价里仍有分量
     */
    fame: { title: 1, tiTitle: 5, mvp: 0.05, seasonDecay: 0.6, max: 20, weight: 0.045, maxBonus: 0.5 },
    /**
     * 开局接管真实俱乐部（单机）：正式队员工资对齐到预期薪资 × U(range)（只上调；salary.alignInitialSalaries）。
     * 数据中的工资是普通市场工资，不含荣誉 / 明星系数；不对齐的话接管高荣誉豪门的第一回合全队就对薪资强烈不满。
     * 0.86~1 → 开局满意或略有不满（g ≤ 0.14）。新俱乐部与多人模式（玩家战队重置为新俱乐部水平）不受影响。
     */
    initialPay: { range: [0.86, 1] as [number, number] },
    /** 薪资差 g = (预期 − 实际)/预期 的下限（薪水远高于预期时） */
    gapFloor: 1,
    /** 定性薪资满意度：g ≥ strongGap 强烈不满；≥ mildGap 略有不满；否则满意 */
    mood: { mildGap: 0.1, strongGap: 0.28 },
    /** 整体情绪：归属感 < leaveThreshold 萌生去意；< waveringBelow 或每回合环境变化 ≤ waveringDrift 或强烈不满 → 有些动摇；
     *  归属感 ≥ contentFrom、环境变化 > contentMinDrift 且薪资满意 → 心满意足；其余状态安稳 */
    overall: { waveringBelow: 45, waveringDrift: -1, contentFrom: 70, contentMinDrift: -0.3 },
    /**
     * 每回合归属感（人类玩家战队；AI 战队沿用简化版：只有固定的荣誉落差扣分 loyalty.honorGapPenalty）：
     * (荣誉维度 + 薪资维度 + 差距拉大惩罚) × 在队时长速度倍数。
     * 薪资维度：g > gapGrace → −gapRate × ((g − gapGrace)/gapRef)^gapExp（≤ gapMaxPerRound）；g < −gapGrace → +overpaidRate × min(1, (−g − gapGrace)/overpaidRef)。
     * 差距拉大：g 比上回合增大 ≥ growthMinStep → −growthPer01 × 增幅/0.1（≤ growthMax）。
     * 荣誉维度：荣誉 < 期待 × loyalty.honorGapRatio → loyalty.honorGapPenalty × honorRate × (honorPenaltyFloor + (1 − floor) × 落差比例)；
     * 荣誉 ≥ 期待 × honorProudRatio → +honorProudBonus。
     * honorRate 0.6：速度倍数会逐季翻倍（×4 / ×8），基础值低于旧版固定扣分，前四个赛季的累计扣分与旧版相当。
     * 离队申请被挽留（加薪 / 谈话成功）后 retainCalmRounds 个回合内不再提出新的离队申请。
     */
    loyalty: {
      gapGrace: 0.08,
      gapRef: 0.2,
      gapExp: 1.5,
      gapRate: 0.8,
      gapMaxPerRound: 4,
      growthPer01: 1,
      growthMinStep: 0.005,
      /**
       * 3 → 1.5（第八波 QA）：g 的跳变（早期年代经济指数逐季 +33~50%、天梯跨档 +70% 市场工资）在速度倍数 ×4 下
       * 单回合可扣 18~20 点归属感；减半后合理经营（及时加薪 / 续约）不会因一次跳变崩盘
       */
      growthMax: 1.5,
      overpaidRate: 0.25,
      overpaidRef: 0.2,
      honorRate: 0.6,
      honorPenaltyFloor: 0.5,
      honorProudRatio: 1.5,
      honorProudBonus: 0.2,
      retainCalmRounds: 6,
    },
    /**
     * 在队时长速度倍数（荣誉、薪资两个维度）：firstSeasonMult × growth^在队赛季，上限 cap → 0.5 / 1 / 2 / 4 / 4 …
     * cap 8 → 4（第八波 QA）：×8 时第 5 个赛季起任何环境落差都放大到每回合 −5 以上（新俱乐部培养的 S 级选手只因
     * 俱乐部荣誉不够就必然离队，谈心也无法弥补）；TI1 起新俱乐部 6 季解散率 3/8 → 0/8，强队不受影响（冠军加成远大于落差）
     */
    // 【用户指定】在队时长倍数：第一季 ×0.5，之后每季 ×2，上限 ×3
    tenure: { firstSeasonMult: 0.5, growth: 2, cap: 3 },
    /**
     * 续约要价 = 预期 × (1 + askMarkup + askJitter × 隐藏浮动[0,1) + askLowLoyaltyPremium × clamp((askPremiumLoyalty − 归属感)/askPremiumLoyalty, 0, 1))，
     * 向上取整（两位有效数字，步长 ≤ askRounding）。隐藏浮动按 存档/选手/赛季 固定，界面显示的要价无法反推出精确的预期薪资。
     */
    renew: { askMarkup: 0.03, askJitter: 0.06, askLowLoyaltyPremium: 0.12, askPremiumLoyalty: 60, askRounding: 100 },
    /** 加薪归属感收益 × (1 + gapBonus × 被弥补的薪资差) */
    raise: { gapBonus: 2 },
    /**
     * 外部兴趣：AI 报价概率 × (1 + offerChanceGapMult × 阵中最大 g)（≤ offerChanceMax），目标权重 × (1 + offerWeightGapMult × g)；
     * 低归属感离队申请 / 挖角概率 × (1 + leaveGapMult / poachGapMult × g)；
     * 薪资强烈不满的明星（等级 ≥ unhappyStarMinTier、归属感 < unhappyStarLoyaltyMax）：每回合 unhappyStarPoachChance × g/strongGap（≤ unhappyStarPoachMax）被挖角；
     * 同一选手两次此类挖角至少间隔 unhappyStarCooldownRounds 个回合（本赛季内）
     */
    poach: {
      offerChanceGapMult: 2,
      offerChanceMax: 0.5,
      offerWeightGapMult: 4,
      leaveGapMult: 2,
      poachGapMult: 3,
      unhappyStarMinTier: 'S' as Tier,
      /** 70 → 85（第八波 QA）：70 时夺冠球队的明星（归属感被冠军加成撑在 85+）从不被挖角；85 时强队每赛季约 0.2~0.3 次 */
      unhappyStarLoyaltyMax: 85,
      unhappyStarPoachChance: 0.1,
      unhappyStarPoachMax: 0.3,
      unhappyStarCooldownRounds: 6,
    },
    /** 「对薪资不满」公开新闻：进入强烈不满时发布，仍强烈不满则每 newsCooldownRounds 回合再提一次 */
    newsCooldownRounds: 10,
  },

  // -------------------------------------------------------------------------
  // 选手奖金分成（prizeShare.ts，第九波）：赛事奖金的 50%–100% 分给队员，俱乐部只拿剩余部分
  // （出场费与经常性收入全归俱乐部）。人机共用；玩家每回合最多调整一次，步长 5%。全部战队默认 50%（2026-10-10）。
  // -------------------------------------------------------------------------
  prizeShare: {
    /** 分成比例范围与步长 */
    min: 0.5,
    max: 1,
    step: 0.05,
    /**
     * 全部战队的初始比例（用户决策 2026-10-10「比赛奖金默认调整为 50% 给队员，剩下 50% 给俱乐部」）：新俱乐部、真实俱乐部、
     * AI 战队、多人模式全部玩家战队一律 50%（原为新俱乐部 70%、真实俱乐部按 id 哈希 55%–85%）；AI 战队之后仍会偶尔调整（见 ai）
     */
    initial: 0.5,
    /** 队员之间的分配权重：首发（赛事结束时的首发，含临时替补）1，其余签约队员 benchWeight */
    benchWeight: 0.5,
    loyalty: {
      /**
       * 每回合环境项（人机共用，不乘在队时长倍数）：比例高于 norm → +abovePer10 × (比例 − norm)/0.1；
       * 低于 → −belowPer10 × (norm − 比例)/0.1。默认比例 50% 起即为中性（2026-10-10 随默认值从 70% 下移；norm = 下限时
       * belowPer10 不再生效）：70% ≈ +0.3/回合，100% ≈ +0.75/回合（一个赛季约 +6 / +15）
       */
      norm: 0.5,
      abovePer10: 0.15,
      belowPer10: 0.25,
      /**
       * 调整比例的即时影响（每名正式队员，每 5% × 在队时长速度倍数 salary.tenureSpeedMult）：
       * 上调 +raisePerStep（单次至多 +maxImmediateRaise）、下调 −cutPerStep（单次至多 −maxImmediate）。
       * 损失厌恶：同幅下调的影响为上调的 2.5 倍；两个上限同比例（25 / 10），大幅调整时也保持该比例。
       */
      raisePerStep: 0.8,
      cutPerStep: 2,
      maxImmediate: 25,
      maxImmediateRaise: 10,
      /**
       * 下调后 raiseCooldownRounds 个回合内（约一个赛季），把比例调回下调前的水平不带来即时加成（队员并不领情），
       * 只有超出下调前水平的部分才算上调；防止赛前压低、赛后调回（Team.prizeShareCutFrom）
       */
      raiseCooldownRounds: 21,
      /**
       * 发奖金时每名分到奖金的正式队员：+ prizeMax × (1 − e^(−分得奖金 / 每回合工资 / prizeRef))。
       * 标定（TI9 年代）：TI 冠军首发分得约 20+ 回合工资 → ≈ +6；Major 冠军约 3 回合 → ≈ +2.4；Minor 冠军 → < +1
       */
      prizeMax: 6,
      prizeRef: 6,
    },
    /**
     * 队员分到的奖金计入薪资满意度（预期薪资仍不显示）：有效薪水 = 工资 + 近期奖金余额 / windowRounds × weight，
     * 余额每回合 × (1 − 1/windowRounds)（一笔奖金折算到之后各回合的补贴合计正好等于奖金本身；只计在当前战队分到的）。
     * 用户决策 2026-10-10「给队员后计入总薪资，提升薪资满意度」：weight 0.3 → 1（全额计入），取消原先「至多工资 × 30%」的上限；
     * windowRounds 20 ≈ 一个赛季的付薪回合（原为按赛季 × 0.5 阶梯衰减）
     */
    salary: { weight: 1, windowRounds: 20 },
    /** 调整记录保留条数 */
    logMax: 8,
    /**
     * AI 战队偶尔调整（每回合满足条件时按概率调整一档）：资金 < 工资 × brokeWageRounds → 以 cutChance 下调（资金紧张）；
     * 首发平均归属感 < unhappyLoyalty 或资金 > 工资 × richWageRounds → 以 raiseChance 上调（至多 max）。
     * 联赛经济以奖金为主要盈余来源（AI 战队平均每赛季：经常性收入 ≈ 0.55 × 工资，奖金池 ≈ 0.9 × 工资（分成前口径））。
     * 第九波 QA：原 12 回合 / 20% 下调、25 回合上调时约 2 个赛季后几乎所有 AI 战队都降到 50%（各自比例名存实亡）；
     * 奖金池放大（economy.prize）后改为资金 < 8 回合工资才以 6% 下调、> 20 回合以 3% 上调：TI9 起 6 季 AI 平均比例保持 0.65~0.70，
     * 降到 50% 的 1~6 支，负资金 AI 战队 1~3 支（由 ai.handleDebt 处理）。
     * 荣誉 ≥ newsMinHonor 的 AI 战队调整时发公开新闻（玩家调整总是发新闻）
     */
    ai: {
      cutChance: 0.06,
      raiseChance: 0.03,
      brokeWageRounds: 8,
      richWageRounds: 20,
      unhappyLoyalty: 50,
      max: 0.9,
      newsMinHonor: 900,
    },
  },

  // -------------------------------------------------------------------------
  // 战队
  // -------------------------------------------------------------------------
  team: {
    /**
     * 常规阵容上限（软上限，不含临时替补）：人类玩家战队签约 / 求购 / 选秀都可以超过它，不会阻塞推进；
     * 超出后的代价是工资照付、替补归属感额外下降（loyalty.overRosterBenchPerRound）。AI 战队另按 ai.maxRoster 管理阵容。
     */
    maxRoster: 8,
    /**
     * 绝对上限：人类玩家战队签约自由选手 / 求购选手时受此限制（达到即不能再引进）。
     * 新秀抽卡总是抽满（2026-10-15 用户决策「十连后本回合内退回到 12 人」）：可以超出，但超编期间不能进入下一回合，
     * 须在本回合内放弃本回合抽到的新秀或解约 / 出售其他队员（game.getAdvanceBlockers 的 roster_over_cap；懒人推进自动处理）。
     * 赛事临时替补不计入；旧选秀（默认关闭）的新秀同样计入超编。
     */
    hardMaxRoster: 12,
    /**
     * 位置系数（roles.roleFactor；第十三波，用户反馈 2026-10-12「四号、五号位都可以」）：选手评分 = 有效战力 × 天梯倍数 × 位置系数。
     * 本位置 1 > 副位置 altRoleFactor（真实生涯中担任过的其他位置，Player.altPositions）≥ 四五号位互换 supportSwapFactor（所有选手：
     * 4 号位打 5 号位或反之）> 其他非本位置 offRoleFactor。两者同时适用时取较高者。规则与实测见 DESIGN.md 2.2.1。
     */
    offRoleFactor: 0.85,
    altRoleFactor: 0.95,
    supportSwapFactor: 0.93,
    /**
     * 真实生涯位置同步（roleSync.syncSeasonRoles）的新闻：人类玩家战队的队员一律私有通知；AI 战队 / 自由选手中天梯等级 ≥ roleNewsMinTier 的
     * 真实选手进入一条世界新闻（最多列 roleNewsMaxNames 人，其余计数）。
     */
    roleNewsMinTier: 'S' as Tier,
    roleNewsMaxNames: 8,
    newClubHonor: 100,
    /** 玩家接管真实俱乐部时起始资金的难度倍数（economy.realClubStartingFunds；新俱乐部见 economy.startingFunds.newClubDifficultyMult） */
    realClubFundsMult: { easy: 1.5, normal: 1.0, hard: 0.7 } as Record<string, number>,
    /** 战队数量下限：不足时程序化生成 AI 战队补足 */
    minTeams: 28,
    /**
     * AI 战队首发优先级（lineupPriority.ts，用户决策 2026-10-10「首发优先使命选手和巅峰选手，然后再基于评分安排」）：
     * mission = 本俱乐部使命（现实巅峰阵容）的在队成员最优先，peak = 历届巅峰阵容（synergies.json 的冠军 / 标志性阵容，
     * 该届真实 TI 已打完）的成员其次；优先选手排在各自的本位置（同一位置先比优先级、再比评分），其余位置按评分排。
     * 人类玩家战队的自动排阵不受影响。两项都为 false 时与原来一样只按评分（对照模拟用）。
     * lockTransfers：AI 转会补强 / 换人（ai.tryUpgrade、转会潮的补强 / 主动换人 / 明星去向 / 对玩家选手的求购）跳过被优先选手占据的本位置
     * （lineupPriority.lineupPriorityLocks）——否则按评分引进的同位置选手只会坐替补，白花转会费与工资（审阅实测：不配套时每届 TI
     * 全联盟约 4–8 名本赛季引进的 AI 选手坐在更早加盟的使命选手身后，AI 首发评分多降约 0.3%–0.5%）。false = 不配套（对照模拟用）。
     */
    aiLineupPriority: { mission: true, peak: true, lockTransfers: true } as { mission: boolean; peak: boolean; lockTransfers: boolean },
  },

  // -------------------------------------------------------------------------
  // 训练
  // -------------------------------------------------------------------------
  training: {
    freePerRestRound: 1,
    /**
     * 额外训练价格 = extraBaseCost × extraCostGrowth^本回合已购次数 × (1 + extraSeasonStep × 本赛季已购次数，至多 extraSeasonMaxMult) × 经济指数。
     * 成长重平衡（2026-10-09）：原为「× 1.35^本赛季已购次数」，几次之后价格就高到买不起，「每个休赛回合都加练」不可能；
     * 现在每回合内逐次加价、赛季内缓慢上涨：经济指数 1 时一个回合加购 3 次约 3.8 万（1.0 + 1.25 + 1.56），再约一场训练赛约 1.6~2.6 万；
     * 整季每个休赛回合都这样练（约 15 个回合）要花约 80~110 万——豪门一个赛季收入的一半左右，中游俱乐部收入的 1.5~3 倍、新俱乐部更买不起：
     * 狂练是要攒钱、和签人 / 存钱取舍的大投入。复核（2026-10-09）：首版 2 万 × 1.2^k 时整季狂练要 130~190 万，
     * 超过几乎所有俱乐部的全年收入，加练形同虚设、成长主要来自免费训练。
     */
    extraBaseCost: 10000,
    extraCostGrowth: 1.25,         // 同一回合内每多买一次 ×1.25
    extraSeasonStep: 0.02,         // 本赛季每已购 1 次，价格 +2%
    extraSeasonMaxMult: 1.6,
    maxExtraPerRound: 3,
    /**
     * 同一休赛回合第 2 次起的训练（额外训练、消耗已购次数的训练赛、回合末自动完成的已购次数、AI 加练）对天赋 / 韧性
     * （年轻选手天赋自然增长、教练提升）的收益倍数：天赋与韧性主要按「每个休赛回合一次」成长。
     * 复核（2026-10-09）：加练变得买得起之后，每回合 4 次训练会让教练的天赋提升翻 4 倍（S 级教练一季 +20 天赋以上），
     * 低天赋新人被「练成」高天赋，天赋不再决定成长快慢；韧性则应主要来自比赛。
     */
    extraSessionAttrMult: 0.2,
    scrimBaseCost: 12000,
    scrimCostPerStrengthRatio: 20000, // 费用 += max(0, 目标/本队 - 0.8) × 此值
    scrimCostRatioFloor: 0.8,      // 上式中的 0.8：目标/本队 ≤ 此值时不加价
    /**
     * 训练赛倍数 scrimMult = clamp(scrimMultBase + (目标评分 − 本队评分)/本队评分 × scrimK, scrimMultMin, scrimMultMax)。
     * 用户反馈（2026-10-10「约强队的加成提高一些，即使实力不如自己的队伍约练后也能比普通训练有更高的提升，毕竟花钱了」）：
     * 原为 clamp(1 + 差距 × 2.5, 0.8, 2.0)（约弱队收益反而低于普通训练）；现下限 ×1.25（弱 10% 以上的对手），
     * 同等实力 ×1.5，强 20% ×2.0，强 40% 以上封顶 ×2.5。费用仍随对手实力上涨（scrimBaseCost / scrimCostPerStrengthRatio）。
     */
    scrimMultBase: 1.5,
    scrimK: 2.5,
    scrimMultMin: 1.25,
    scrimMultMax: 2.5,
    /** 训练赛的灵性收益另 × 此值（双方交流 BP；叠加在 scrimMult 之上，对任何焦点都生效） */
    scrimInsightMult: 1.6,
    /** 每个休赛回合同一支对手最多约练的次数（每支强队每回合只能约 1 次，用户反馈 2026-10-10） */
    scrimPerOpponentPerRound: 1,
    /** AI 每回合额外训练次数期望（小数部分按概率），rich = 资金 > 工资 × ai.richWageMultiple（AI 加练不花钱） */
    aiExtraTrainingsPerRound: { rich: 0.4, normal: 0.1 },
    /**
     * AI 战队训练收益倍数（相对玩家的 growth.training，按属性）：AI 单次训练的战力 / 灵性与玩家相同，天梯略低（×0.92，AI 加练次数多、
     * 天梯决定 SS+ 占比）。AI 的成长量主要由加练次数（aiExtraTrainingsPerRound / aiBusyExtraPerRound，不花钱）标定：
     * 比赛成长压降后 AI 首发的赛季内成长与改动前相当（≤22 岁高天赋 +3.3 战力 / +616 天梯，改动前 +3.3 / +621），
     * 联赛 SS+ / SSR / 前十战力与改动前一致（标定数据见 DESIGN.md 3.2）。
     */
    aiGainMult: { power: 1, mmr: 0.92, insight: 1 },
    /**
     * AI 战队休赛回合按本赛季参赛比例加练的次数：期望 = 此值 × 参赛回合 / 已进行回合（小数部分按概率）。
     * 参赛多的强队休赛回合少，比赛成长压降后靠这部分不至于整体掉队（联赛前十战力 / SSR 人数与改动前一致）
     */
    aiBusyExtraPerRound: 1.2,
    /** false：AI 与玩家一致，只在本回合未参赛时训练（赛事回合不训练） */
    aiTrainInEventRounds: false,
    /** 训练记录（history.training）保留条数上限 */
    logMaxRecords: 400,
    /** 成长快照（history.squadProgress）每名选手保留的回合数上限 */
    progressMaxPointsPerPlayer: 150,
    /** 成长快照最多保留的选手数（超出时优先删除已离队且最久未更新的选手） */
    progressMaxPlayers: 30,
  },

  // -------------------------------------------------------------------------
  // 经济
  // -------------------------------------------------------------------------
  economy: {
    /** 年代经济指数（工资/费用缩放） */
    econIndexByYear: {
      2011: 0.25, 2012: 0.3, 2013: 0.4, 2014: 0.6, 2015: 0.8, 2016: 0.9, 2017: 1.0, 2018: 1.0,
      2019: 1.0, 2020: 1.0, 2021: 1.0, 2022: 0.85, 2023: 0.7, 2024: 0.6, 2025: 0.6, 2026: 0.6, 2027: 0.6,
    } as Record<number, number>,
    /** 每大回合工资（econIndex=1 时），按等级 */
    salaryByTier: { C: 800, B: 1300, A: 2200, S: 3800, SS: 6400, SSR: 9800 } as Record<Tier, number>,
    salaryPowerFactor: 0.012,      // salary × (1 + (power-70) × f)
    rookieSalaryMult: 0.6,
    minSalary: 500,                // 每回合工资下限
    /** 身价年龄系数：[maxAge(含), mult] 升序匹配 */
    marketValueAgeMult: [[21, 1.3], [24, 1.15], [27, 1.0], [30, 0.7], [200, 0.45]] as [number, number][],
    /** 身价天赋系数 = base + talent/100 × span */
    marketValueTalentBase: 0.7,
    marketValueTalentSpan: 0.6,
    /** 身价 = salary × marketValueMult × ageMult × talentMult */
    marketValueMult: 40,
    signingFeeRatio: 0.25,         // 签约自由选手：签字费 = 身价 × ratio
    contractSeasons: [1, 3] as [number, number],
    /** 旧版赛程出场费预估参数（第六波起 schedule.ts 直接按 revenue.tournamentAppearanceFee 写入实际发放额，此两项仅保留兼容） */
    appearanceFeeShare: 0.01,
    minAppearanceFee: 5000,
    debtRoundsBeforeArrears: 0,    // 资金不足立即触发欠薪
    /**
     * 起始资金（第五波经济重做：开局不再「第一回合就能买买买」；2026-10-10 第二次调整改为锚定额）：
     * - 新俱乐部 = newClubTi1Funds × 年代系数 × newClubDifficultyMult[难度]（economy.newClubStartingFunds）；
     * - 真实俱乐部 = max(realClubTopTi1Funds × 年代系数 × min(1, 相对财力 / realClubFullWealth), 数据阵容每回合工资 × realClubMinWageRounds)
     *   （economy.realClubStartingFunds / seedTeamStartingFunds；相对财力 = 数据资金 / (realClubTopDataFunds × econIndex(该届年份))，至多 1）
     *   = 原口径「数据资金 × 0.2」封顶于强队锚定额、不低于 9 回合工资；玩家接管的战队再 × team.realClubFundsMult[难度]；
     *   开局 AI 战队与程序化生成的 AI 战队（generation.generateAiTeam：开局补足、赛季初补足联赛规模、假赛除名补位）同一公式（不乘难度倍数）。
     * - 年代系数 = econIndex(起始届年份) / econIndex(TI1 年份)（economy.eraFundsFactor）：各年代起步的购买力相同（TI9 = ×4、TI13 = ×2.4）。
     * 用户决策（2026-10-10「新队伍初始资金太少，强队初始资金太多，建议平衡，新队TI1的初始资金至少是20W，强队是10W」）：
     * 原为新俱乐部 = 初始工资 × 18 / 15 / 12 回合（实测 TI1 普通约 4.7 万、TI9 约 17 万），真实俱乐部 = 数据资金 × 0.2（TI1 豪门 20 万、TI9 OG 80 万）。
     * 中途成立的真实俱乐部（clubs.ts）同一公式，另有 CONFIG.clubs.minFundsWageRounds 的工资下限。实测见 DESIGN.md 3.6「2026-10-10 开局资金锚定」。
     */
    startingFunds: {
      /**
       * 【用户指定，2026-10-10「新队TI1的初始资金至少是20W」】新俱乐部 TI1 普通难度起始资金 20 万；其他起始届 × 年代系数。
       * 平衡调整时不要修改。单机新建俱乐部、多人「各自组建」与「选择已有战队」（重置为新俱乐部标准）共用
       */
      newClubTi1Funds: 200000,
      /** 新俱乐部难度倍数：「至少 20 万」→ 任何难度都不低于锚定额（困难 = 普通），简单略多 */
      newClubDifficultyMult: { easy: 1.2, normal: 1.0, hard: 1.0 } as Record<string, number>,
      /**
       * 【用户指定，2026-10-10「强队是10W」】最强真实俱乐部（该届数据资金最高者，如 TI1 的 NaVi / EHOME / iG）TI1 普通难度接管时的起始资金 10 万；
       * 其他起始届 × 年代系数（TI9 Liquid / EG 40 万；工资最高的 OG 由 9 回合工资下限决定 41.8 万）。同时是封顶额（见 realClubFullWealth）。平衡调整时不要修改
       */
      realClubTopTi1Funds: 100000,
      /**
       * 数据约定：各届阵容数据中最富真实俱乐部的数据资金 = 此值 × econIndex(该届年份)（ti1 100 万 … ti9 400 万 … ti13 240 万；
       * tests/startingFunds.test.ts 校验）。相对财力 = 数据资金 / 此参照
       */
      realClubTopDataFunds: 4000000,
      /**
       * 相对财力达到此值即拿满锚定额，以下按比例：realClubTopTi1Funds × 年代系数 × min(1, 相对财力 / 此值)。
       * 取 1/2 → 低于锚定额的部分正好等于原口径「数据资金 × 0.2」，锚定额成为封顶额：只有原来超过锚定额的最富一档（强队）被压到锚定额，
       * 其余俱乐部开局资金不变（数据资金按 1 : 1/2 : 1/4 : 1/8 分档，第二档原本就正好是锚定额）。
       * 审阅对照（2026-10-11）：开平方（第二档 −29%）让入不敷出的第二档俱乐部被动经营 4 季破产 NiP TI9 9 → 37 / 90、XG TI13 7 → 19 / 90；
       * 本口径 13 / 90、12 / 90（与调整前在随机波动内），见 DESIGN.md 3.6
       */
      realClubFullWealth: 0.5,
      /**
       * 真实俱乐部起始资金下限 = 数据阵容（首发 + 替补 + 主教练）按标准工资计算的每回合工资 × 此回合数（economy.seedTeamWageBill；
       * 新游戏向导可在开局前算出同一数值）。取 9 = 【用户指定】锚定额给 TI1 最强俱乐部的储备（NaVi：10 万 / 每回合约 1.1 万 ≈ 9.1 回合）向下取整，
       * 不改变 TI1 最强俱乐部的 10 万（tests/startingFunds.test.ts 校验）；主要抬高原本只有 4~8 回合工资的后两档（406 支中 147 支由下限决定）。
       * 注意口径：这是「数据阵容 / AI 工资」下的 9 回合。玩家接管后工资会对齐预期薪资（明星加薪），且困难 × 0.7 乘在下限之上，
       * 所以接管豪门的实际储备更少（TI1 / 5 / 9 / 13 全部接管实测，不含选秀新秀）：普通难度最强一档 5.6~18 回合（TI1 9.1~13.4、TI9 6.5~9.5、TI13 5.6~12.3），
       * 困难 3.9~12.8 回合；其余三档普通 ≥ 8.5、困难 ≥ 5.9 回合（均高于财务页的 3 回合预警线）。
       * 实测（DESIGN.md 3.6）：6 / 8 / 9 回合时，中游明星队（TI8 OG、TI11 Tundra、TI13 XG）被动经营的首季破产明显随回合数下降
       */
      realClubMinWageRounds: 9,
      /** 新俱乐部创立礼包：赠送 N 次单抽的资金（不超过阵容空位，避免抽卡超编；0 = 不送）。抽卡价格为用户指定值，不随年代缩放 */
      newClubGachaGrantPulls: 3,
      /**
       * 礼包价值上限 ≈ 初始阵容此数回合的工资（至少 1 次单抽）：抽卡价格固定，早期年代工资低，故按年代收缩次数。
       * （第五波设定，当时 TI1 新俱乐部起始资金只有 2.1 万；第八波取消抽卡后礼包恒为 0，现起始资金为锚定额 20 万 × 年代系数，此项仅保留兼容）
       */
      newClubGachaGrantMaxWageRounds: 3,
      /** 取整单位 */
      rounding: 1000,
    },
    /**
     * 奖金压缩：赛事显示真实奖金池（美元），实际发放的「游戏内奖金池」（revenue.awardedPrizePool）=
     *   anchorPool[等级] × clamp((真实奖池 / 同赛季同等级真实奖池中位数)^alpha, multRange) × 赛季系数 × econIndex(赛季年份)
     *   赛季系数 = clamp(seasonBudget / Σ 本赛季非 TI 赛事的前两项乘积, seasonScaleRange)
     * 即同等级赛事按真实奖池的相对大小浮动（幂次压缩），跨年代由经济指数统一尺度；真实赛程各赛季赛事数量差异很大
     * （2017-18 赛季 10 项 Major、2018-19 赛季 5 Major + 7 顶级 + 10 Minor），按赛季总预算归一，联赛整体奖金规模稳定。
     * TI 众筹奖池跨年代差异巨大（160 万 ~ 4000 万美元）：不参与赛季预算，改用固定参照 tiRefPool 与更小的指数 tiAlpha。
     * 标定（W = 当季工资最高的 4 支战队的年工资均值，TI9 赛季 ≈ 87 万；见 E1 审阅的经济审计）：
     *   TI 冠军 ≈ 1.9~3.0W；Major 冠军 ≈ 0.3~0.4W（Major 少的赛季 0.6~0.7W）；顶级赛事冠军 ≈ 0.15~0.35W；
     *   Minor 冠军 ≈ 2~5 万（新俱乐部 2~5 回合工资）；线上公开赛冠军约为 Minor 冠军的一半。
     * 说明：若 Major 冠军按 0.6~1W、顶级赛事按 0.3~0.5W 发放（赛季预算 ≈ 1900 万），实测 TI9 起 OG 首赛季净赚 ≈ 4.4M（≈ 4.7W），
     *   联盟 AI 平均资金翻倍，与「强队有盈余但不至于钱多到没意义」冲突；当前取中间值（赛季预算 900 万）。
     * 第九波 QA（选手奖金分成）：奖金池为「队员 + 俱乐部」合计，俱乐部只拿 (1 − 分成比例)。非 TI 赛事锚定额与赛季预算 × 2、
     *   TI × 1.5（众筹奖池是王朝囤钱的主要来源，放大更少）：分成 50% 时俱乐部所得 ≈ 分成前的 100% / 75%（弱队不因此多拿钱），
     *   默认 70% 时 ≈ 60% / 45%（2026-10-10 起全部战队默认 50%）。上表 W 倍数此后指奖金池合计（TI 冠军奖金池 ≈ 3~4.5W，俱乐部按分成拿其中一部分）。
     *   实测见 DESIGN.md 3.6.1：接管 OG（TI9 起 6 季）峰值资金均值 633 万（分成前）→ 200 万（× 1）→ 333 万（本值），中游 Fnatic 收支持平。
     */
    prize: {
      anchorPool: { ti: 6900000, major: 4400000, premier: 2000000, minor: 500000, qualifier: 120000 } as Record<TournamentTier, number>,
      alpha: 0.65,
      multRange: [0.5, 2.0] as [number, number],
      /** 赛季非 TI 赛事奖金总预算（econ=1 的金币，不含线上公开赛）与系数范围（赛事少的赛季最多放大到上限） */
      seasonBudget: 18000000,
      seasonScaleRange: [0.2, 1.2] as [number, number],
      tiRefPool: 8000000,
      tiAlpha: 0.15,
      tiMultRange: [1.0, 1.1] as [number, number],
      /**
       * 线上公开赛（补位赛事，无真实奖池）的游戏内奖金池 = anchorPool.minor × 此比例 × 赛季系数 × econ，
       * 始终低于同赛季的典型 Minor（赛事多的赛季同步缩水）
       */
      fillerCupShare: 0.5,
      /**
       * 名次分配：在 CONFIG.tournament.prizeShare（同时决定巡回赛积分）基础上向平均分配混合 flatten 比例，
       * 让正赛中下游名次也拿到像样的奖金：share' = (1 - flatten) × share + flatten / 正赛队伍数。
       * TI 保持原表（冠军独揽约 45%，「TI 冠军 ≈ 2~3 倍顶级战队年工资」）
       */
      flatten: { ti: 0, major: 0.15, premier: 0.15, minor: 0.15, qualifier: 0.15 } as Record<TournamentTier, number>,
      rounding: 100,
    },
    /** 出场费（每支正赛队伍，× econ）：按赛事等级；无奖金的赛事（TI 赛区预选）不发 */
    appearanceByTier: { ti: 40000, major: 15000, premier: 8000, minor: 5000, qualifier: 2000 } as Record<TournamentTier, number>,
    fillerCupAppearance: 3000,
    /** 封闭预选赛出局的队伍领取「预选赛参赛补贴」= 出场费 × 此比例（小俱乐部参加赛事也有收入） */
    qualifierAppearanceShare: 0.5,
    /**
     * 经常性收入（revenue.ts，人机共用；每大回合结束结算，先收入后付工资），按来源分别记账：
     * - 赞助 sponsor：赛季合同（赛季内首次结算时按荣誉 + 上赛季排名签订，赛季内固定，下赛季重新谈判）
     *     每回合 = (base + perHonor × min(荣誉, honorCap) + 排名奖励) × (1 ± noise) × econ
     * - 直播与内容 streaming：明星效应 = Σ 签约选手 byTier[等级]（替补 × benchFactor）× (1 + min(honorMaxBonus, 荣誉 / honorDiv)) × econ
     * - 周边 merch：(base + perHonor × min(荣誉, honorCap)) × econ + 夺冠 / TI 好成绩后若干回合的热度加成
     * 人类玩家战队整体 × difficultyMult[难度]。
     */
    revenue: {
      difficultyMult: { easy: 1.2, normal: 1.0, hard: 0.85 } as Record<string, number>,
      sponsor: {
        base: 6500,
        perHonor: 2,
        honorCap: 2500,
        /** 上赛季排名 → 每回合奖励：[排名上限(含), 金额]，升序匹配 */
        rankBonus: [[1, 4000], [2, 3200], [4, 2500], [8, 1500], [12, 800], [16, 300]] as [number, number][],
        noise: 0.08,
        /** 合同档次（econ=1 的每回合金额达到下限即为该档，降序匹配） */
        levels: [[12500, '冠名赞助'], [9500, '主赞助'], [7000, '官方赞助'], [0, '区域赞助']] as [number, string][],
      },
      streaming: {
        byTier: { C: 100, B: 300, A: 600, S: 1000, SS: 1500, SSR: 2400 } as Record<Tier, number>,
        benchFactor: 0.5,
        honorDiv: 5000,
        honorMaxBonus: 0.2,
      },
      merch: {
        base: 600,
        perHonor: 0.8,
        honorCap: 2500,
        /** 热度加成（× econ）：等级 → 名次(rankFrom) → [每回合金额, 持续回合] */
        boosts: {
          ti: { 1: [12000, 8], 2: [6000, 6], 3: [3000, 4], 4: [3000, 4] },
          major: { 1: [5000, 5], 2: [2000, 3] },
          premier: { 1: [2500, 4] },
          minor: { 1: [1000, 3] },
          qualifier: {},
        } as Record<TournamentTier, Record<number, [number, number]>>,
      },
    },
  },

  // -------------------------------------------------------------------------
  // 荣誉
  // -------------------------------------------------------------------------
  honor: {
    tierBase: { ti: 220, major: 90, premier: 55, minor: 28, qualifier: 12 } as Record<TournamentTier, number>,
    wExp: 0.6,
    wYoY: 0.25,
    wMoM: 0.15,
    /** 名次奖励（不随预期抵消，是联赛荣誉的净流入；过高会让全联盟荣誉逐季通胀） */
    placeBonus: { 1: 0.5, 2: 0.25, 3: 0.1, 4: 0.1 } as Record<number, number>,
    /** 预期名次：按「战力 × (1 + honorWeight × log10(1+honor/100))」排名 */
    expectationHonorWeight: 0.05,
    /**
     * 参照名次校准（第六波：强队荣誉下滑过快）：名次受随机性影响会向中游回归——实测「预期第 1」的队伍平均名次百分位约 0.25、
     * 「预期垫底」约 0.75（E[实际] ≈ 0.5 + 0.55 × (预期 - 0.5)）。按名次预期直接比较时，热门队伍每项赛事平均都在扣分、
     * 冷门队伍平均都在加分，长期荣誉从强队流向弱队（真实豪门荣誉逐季下滑）。预期项改用校准后的百分位：
     *   pExp' = 0.5 + shrink × (pExp - 0.5)，shrink 按参照所在半区取 favorite（pExp < 0.5，热门）/ underdog（冷门）；
     * 同比/环比的参照（上赛季同系列 / 上一项同级赛事名次）同理按 historyShrink 收缩。1 = 不校准。
     * 冷门半区不校准（underdog = 1）：最弱的队伍（如白手起家的新俱乐部）实际名次比「平均冷门」更靠后，
     * 校准后它们每项赛事都会小幅扣分、开局两个赛季内几乎必然解散（实测 8 局 8 解散）。
     */
    expectationShrink: { favorite: 0.55, underdog: 1 },
    historyShrink: { favorite: 0.55, underdog: 1 },
    /** 预期项零和：校准带来的净流入均摊回全部参赛队（见 honor.expectationZeroSumShift），避免联盟荣誉额外通胀 */
    expectationZeroSum: true,
    transfer: {
      signTierBonus: { C: 0, B: 0, A: 1, S: 3, SS: 6, SSR: 10 } as Record<Tier, number>,
      sellTierPenalty: { C: 0, B: 0, A: -1, S: -3, SS: -6, SSR: -10 } as Record<Tier, number>,
      releasePenalty: -2,
    },
    beefWin: 6,
    beefLose: -6,
    /** 荣誉幸运度：luck = log10(1 + honor/100)，用于抽卡/招募/替补等级分布 */
    luckCap: 1.6,
    /** AI 战队荣誉下限（AI 不会因荣誉解散） */
    aiMinHonor: 30,
    /**
     * 单项赛事荣誉变化上限（绝对值，不含宿敌逐场结算）。超出时各分项按比例缩放，
     * 使「基数 × 分项之和 = 合计」仍成立。避免爆冷夺冠/大热出局时荣誉一次性暴涨暴跌。
     */
    maxDeltaByTier: { ti: 150, major: 75, premier: 50, minor: 35, qualifier: 20 } as Record<TournamentTier, number>,
    /** 荣誉缓冲：单项赛事扣分 ≤ 当前荣誉 × 此值（荣誉按不低于 lossCushionFloor 计）。低荣誉俱乐部一次大赛失利不会直接解散 */
    maxLossShareOfHonor: 0.35,
    lossCushionFloor: 100,
    /**
     * 低荣誉减损（第六波：新俱乐部 / 低荣誉强队解散过快）：单项赛事扣分 × lerp(lowHonorLossMinMult, 1, clamp(荣誉 / lowHonorLossRef, 0, 1))。
     * 荣誉 100 → ×0.6，200 → ×0.8，≥ 300 不减；加分不受影响。解散仍可能发生（欠薪、丑闻、假赛或长期失利），但不会因几项赛事失常而突然解散。
     */
    lowHonorLossRef: 300,
    lowHonorLossMinMult: 0.4,
    /**
     * 退赛扣荣誉（第十四波，schedule.unregisterFromTournament / withdrawPenaltyOf）：开赛前退出已接受的邀请或已报名的赛事，
     * 按赛事等级扣分（约为该等级赛事一次明显失常的扣分：Major 一次垫底约 −50~−75，Minor 约 −20~−35）。
     * 规则：报名 / 接受邀请所在的同一回合内退出免罚（赛季初的邀请在赛季初随意婉拒；补充邀请在收到通知的回合内婉拒免罚）；
     * 距开赛 ≥ withdrawFarRounds 回合退出 × withdrawFarMult（减半）；补位线上公开赛按 withdrawOpenCup；低荣誉减损与赛事扣分同口径
     * （lowHonorLossRef）；扣分会让荣誉跌破 0 时不允许退出。TI 与 TI 预选不可退出；主办方取消、补充邀请让位等非玩家操作不扣分；
     * AI 战队不退赛，不受影响。
     */
    withdraw: { ti: 0, major: -40, premier: -25, minor: -12, qualifier: -5 } as Record<TournamentTier, number>,
    withdrawOpenCup: -5,
    withdrawFarRounds: 3,
    withdrawFarMult: 0.5,
    /** 退赛扣分 ≥ 此值时新闻标为重要 */
    withdrawNewsImportant: 20,
  },

  // -------------------------------------------------------------------------
  // 新秀抽卡（gacha.ts；2026-10-14 用户决策：抽卡回归并完全取代新秀选秀，新增「请神」与名人堂）
  // 每个赛季的新秀（真实 + 虚构）只能经由抽卡进入联赛：赛季初建一个有限卡池，转会窗口开放期间
  // （赛季初 + 常规赛）人类玩家随时抽卡、AI 战队在第 1 回合开始前与赛季中期按自身资金自动抽卡；
  // 第 1 回合开始前未被抽走的真实新秀离池、加盟其真实出道战队（人类玩家的出道战队收到「签下 / 放弃」事件；否则其他 AI 战队 / 自由市场），
  // 卡池同等级补入请神 / 虚构卡；TI 预选赛转会锁定时卡池关闭。
  // -------------------------------------------------------------------------
  gacha: {
    /**
     * 【用户指定，2026-10-14】单抽价格随年代缩放：单抽 = singleCost × econIndex(赛季年份) / econIndex(priceBaseYear)
     * （TI1 1 万、TI9 4 万、TI13 2.4 万）；十连 = 单抽 × tenMult（不打折）。平衡调整时不要修改。
     */
    singleCost: 10000,
    priceBaseYear: 2011,
    tenMult: 10,
    /** 【用户指定】SSR 保底：距上一张 SSR 第 pityThreshold 抽必出 SSR（计数随战队、跨赛季；简单计数器，任何 SSR 即清零） */
    pityThreshold: 100,
    /**
     * 【用户指定，2026-10-14】总体出卡概率：SSR 5% / SS 10% / S 10% / A 15% / B 30% / C 30%。
     * 以有限卡池实现：基础卡池 poolSize（100）张，各等级张数 = 比例（100 张时张数 = 百分比）；卡池内均匀不放回抽取。
     * 平衡调整时不要修改（只调 AI 抽卡量或虚构新秀的初始水平）。
     */
    tierShares: { C: 30, B: 30, A: 15, S: 10, SS: 10, SSR: 5 } as Record<Tier, number>,
    poolSize: 100,
    /**
     * 本届真实新秀（playerIndex.firstTi = 本届，等级取出道届的真实轨迹）先占各自等级的名额；某等级的真实新秀超出名额时，
     * 卡池按 poolStep 张一档放大（各等级仍严格按比例，卡的等级 = 选手等级），并在卡池记录中注明（GachaPool.enlargedBy）。
     * 20 张是比例全部为整数的最小卡池单位（SSR 1 / SS 2 / S 2 / A 3 / B 6 / C 6）。
     */
    poolStep: 20,
    /**
     * 【用户指定，2026-10-14】各等级的非真实名额中请神卡的比例（取整），受该等级可用原型数限制：
     * 原型 = 名人堂中「出道等级」等于该等级的成员；同一原型每赛季至多 summonMaxPerPrototype 张。其余为虚构新秀卡。
     */
    summonShare: 0.5,
    summonMaxPerPrototype: 2,
    /** 请神新秀复制原型出道时的年龄（生涯走势含年龄衰退，完全复制原型）；false 时按普通新秀年龄 */
    summonCopyAge: true as boolean,
    /**
     * 新秀合同赛季数（含当前赛季）；工资 = 等级标准工资 × 新秀折扣（economy.rookieSalaryMult），不超过 rookieWageCap × 赛季经济指数
     * （不低于 economy.minSalary）。
     */
    rookieContractSeasons: 3,
    /**
     * 抽卡新秀（含按真实出道去向加盟的真实新秀）的新秀合同工资上限（econIndex = 1 时每回合），与选秀第 1 顺位工资 draft.salaryTop 相同。
     * 2026-10-14 审查：不设上限时 SS 新秀在 TI9 约 4253/回合、SSR 约 6787/回合，新俱乐部按常规玩法（保留真实 / 请神新秀）
     * TI1 / TI5 / TI9 起 8 季破产 22 / 16 / 14 次（40 个种子；选秀版本 10 / 4 / 0），加上限后见 DESIGN.md 3.3.5。
     */
    rookieWageCap: 1800,
    /**
     * 转售冷却：本队抽卡抽到（或按真实出道去向加盟本队）的新秀，入队不满此数的转会回合（listingRules.listingClock 之差，约一个赛季）时
     * 不能挂牌出售、不会收到 AI 的随机求购，作为交易抵价时按 market.trade.freeAgentSignedCap 估值。
     * 2026-10-14 审查：抽到的新秀平均身价是单抽价格的 3.4~4.5 倍，不设冷却时「抽卡 → 立即按 0.8 倍身价挂牌」每季净赚数百万，
     * 抽卡从花钱变成了赚钱（DESIGN.md 3.3.5）。与 market.trade.freeAgentHoldRounds 同一时钟。
     */
    resaleHoldRounds: 18,
    /** 抽到的新秀在同一回合内可退回（离队进入自由市场），返还单抽价格 × 此比例（无解约补偿、不扣荣誉） */
    discardRefundRatio: 0.2,
    /** 抽空后补充卡池（同比例，只含请神与虚构新秀）的张数 */
    refillSize: 100,
    /** 往届抽卡汇总保留的赛季数 */
    historyMax: 16,
    /** 新闻：抽到不低于此等级的新秀发公开新闻 */
    newsMinTier: 'S' as Tier,
    /** 【用户指定，2026-10-14】每支 AI 战队每赛季至多自动抽卡张数 */
    aiMaxPullsPerSeason: 3,
    /**
     * AI 战队自动抽卡（第 1 回合开始前：人类玩家先抽；以及赛季中期一次）：
     * 张数 = min(本阶段上限（开赛前 openingMax，中期不限）, 本赛季剩余上限 aiMaxPullsPerSeason, ⌊(资金 − 每回合工资 × reserveRounds) / 单抽价格⌋,
     *           ai.maxRoster + rosterSlack − 阵容人数)；抽完后自动排阵，超出 ai.maxRoster 时放走保留价值最低的非首发（进入自由市场）。
     * 弱队（资金少）自然抽得少。标定（DESIGN.md 3.3.5，8 季 × 8 种子对照选秀）：预留 12 回合 / 开赛前 2 张时每季 AI 抽 33~49 张、AI 中位资金约为选秀的一半；
     * 预留 30 回合且不超编时每季只抽约 7 张、SSR 降到选秀的一半以下；采用 20 / 1 / 1，联赛等级分布与选秀相当；
     * 加上超编门槛 slackKeepMax 后每季 12~16 张（2026-10-15 复测，新俱乐部懒人推进 TI1 / TI5 / TI9 起 8 季 × 8 种子）。
     */
    ai: {
      openingMax: 1,
      reserveRounds: 20,
      rosterSlack: 1,
      /**
       * 超编抽卡的门槛：替补中保留价值（rookieDraft.aiKeepValue）最低者低于此值时才使用 rosterSlack。2026-10-14 审查：不设门槛时
       * AI 每季约 38%~57% 的抽卡在同一回合就被整理阵容放走（抽到的新秀保留价值中位数约 63，满员 AI 替补最低者中位数约 79）。
       * 80 ≈ 满员 AI 替补最低值的中位数：约一半满员战队仍会超编抽卡，第 8 季 SSR 人数接近选秀版本（标定见 DESIGN.md 3.3.5）。
       */
      slackKeepMax: 80,
    },
    /**
     * DotA1 时代传奇等「合成轨迹」种子（src/data/hallOfFame.json 的 source = seed）：生涯第 1 年出道 → peakYear 达到巅峰
     * （线性）→ 保持到 declineFromYear − 1 → 之后每年衰退，生涯共 careerYears 年。天梯按等级区间取值：
     * 门槛 + frac × 区间宽度（SSR 区间宽度按 topTierSpan），衰退期每年 −declineMmrPerYear。出道年龄缺省 seedDebutAge。
     */
    seedTrajectory: {
      careerYears: 10,
      mmrFracDebut: 0.3,
      mmrFracPeak: 0.7,
      topTierSpan: 4000,
      declinePowerPerYear: 2,
      declineMmrPerYear: 600,
      seedDebutAge: 19,
    },
    /** 名人堂本局生涯记录（game 来源）最多保留的点数 */
    hofTrajMax: 20,
    // ---- 以下为旧版抽卡 / 通用生成沿用的数值 ----
    /** 基础等级概率（%）：程序化生成选手（AI 补员、自由市场等）的默认等级分布（旧版抽卡的【用户指定】值，沿用） */
    baseWeights: { C: 48.9, B: 35, A: 10, S: 5, SS: 1, SSR: 0.1 } as Record<Tier, number>,
    /**
     * 荣誉幸运度对等级权重的指数修正（临时替补等通用）：w × exp(luck' × slope[tier])，
     * luck' = max(0, luck - luckBaseline)：新俱乐部（荣誉 100）恰为基础概率，荣誉越高高等级概率小幅提升。
     */
    luckSlope: { C: -0.08, B: -0.04, A: 0.06, S: 0.15, SS: 0.25, SSR: 0.3 } as Record<Tier, number>,
    luckBaseline: 0.30103,
  },

  // -------------------------------------------------------------------------
  // 新秀选秀（rookieDraft.ts；第八波：取代玩家抽卡）
  // 每个赛季初（退役/年龄/合同之后、休赛期转会潮与赛程之前）举行，所有战队（含玩家）自动参加。
  // -------------------------------------------------------------------------
  draft: {
    /**
     * 选秀开关（2026-10-14 用户决策：抽卡完全取代选秀）。false = 赛季初不再举行选秀（新秀改由 gacha.ts 的卡池进入联赛）；
     * 选秀代码保留一个版本（下个版本删除），覆盖选秀的测试显式打开此开关。
     */
    enabled: false as boolean,
    /** 选秀轮数 */
    rounds: 2,
    /** 每赛季程序生成的新秀人数（另加本赛季登场的真实新秀）；新秀池总人数上限 poolMax（真实新秀优先） */
    generatedPerSeason: 30,
    poolMax: 70,
    /**
     * 【用户指定，2026-10-09 更新】程序生成新秀的等级分布（%）：C 42 / B 25 / A 15 / S 10 / SS 5 / SSR 3。
     * SSR 采用伪随机分布（连续未出时概率递增），并保证每 ssrPityThreshold 名新秀至少出 1 名 SSR
     * （跨赛季计数；真实新秀保留数据中的等级，但计入保底计数，任何 SSR 新秀出现即清零）。
     */
    tierWeights: { C: 42, B: 25, A: 15, S: 10, SS: 5, SSR: 3 } as Record<Tier, number>,
    ssrPityThreshold: 100,
    /**
     * NBA 式抽签：上赛季排名最差的 lotteryOdds.length 支战队参加，按「最差 → 较好」的权重抽出首轮前 lotteryPicks 个顺位
     * （逐个不放回抽取），其余顺位按上赛季排名倒序；第二轮起全部按排名倒序。权重沿用 NBA 2019 起的抽签概率（‰）。
     */
    lotteryPicks: 4,
    lotteryOdds: [140, 140, 140, 125, 105, 90, 75, 60, 45, 30, 20, 15, 10, 5],
    /**
     * 自动选人：评分 = 综合评分 + 天赋 × talentWeight + (20 - 年龄) × youthWeight + 位置需求；
     * 位置需求：首发空缺 +needEmpty；强于现首发 +(差值 × needUpgrade，上限 needUpgradeMax)；同位置已有 ≥2 人每多 1 人 −depthPenalty。
     * AI 战队选中自家真实出道新秀（playerIndex.firstTeamId）+homeTeamBonus。从评分前 topChoiceWeights.length 名中按权重随机挑选。
     */
    talentWeight: 0.15,
    youthWeight: 0.6,
    needEmpty: 12,
    needUpgrade: 0.5,
    needUpgradeMax: 8,
    depthPenalty: 4,
    homeTeamBonus: 6,
    topChoiceWeights: [6, 3, 1],
    /**
     * 新秀薪资表（econIndex = 1 时每回合工资）：第 1 顺位 salaryTop，按总顺位几何递减到最后一个顺位 salaryBottom；× 赛季经济指数，不低于 economy.minSalary。
     * 标定（simulate --runs 16，新俱乐部）：顶薪 1800 时保留新秀的新俱乐部 3 个赛季 0 解散、资金仍逐季增长；3200 时解散率升至约 20%。
     */
    salaryTop: 1800,
    salaryBottom: 500,
    /** 新秀合同赛季数：第 1 轮 / 第 2 轮及以后（含当前赛季） */
    contractSeasonsByRound: [3, 2],
    /** 选秀记录保留的赛季数 */
    historyMax: 20,
    /** 新闻：首轮前 N 顺位逐一列出；所有 ≥ notableTier 的新秀与真实新秀也列出 */
    newsTopPicks: 5,
    notableTier: 'SS' as Tier,
    /** 【选秀大会】新闻最多逐条列出的顺位数（其余汇总为一句，完整结果见「转会 › 新秀选秀」） */
    newsMaxLines: 16,
  },

  // -------------------------------------------------------------------------
  // 「下一回合」自动处理（懒人玩法，autoRound.ts）
  // -------------------------------------------------------------------------
  autoRound: {
    /**
     * 自动补员（v0.3 选秀取消后，只按「下一回合」的人类战队不再自动得到新秀）：转会窗口开放期间，正式阵容（不含临时 / 野外替补）
     * 不能覆盖五个位置（roles.uncoveredPositions，含副位置）或少于 minRosterFill 人时，先为缺失的位置、再为替补深度（多于 5 时）签下负担得起的自由选手。
     * 目标 5 人（只补能凑齐五个位置的首发，不自动补替补）：懒人推进默认开启，所有按「下一回合」的玩家都会经过这里，
     * 6（再补一名替补，只在经常性收入付得起时签）的实测结果与 5 几乎相同（DESIGN.md 3.4.2），却会给手动经营、有意只养 5 人的玩家多签人。
     */
    minRosterFill: 5,
    /**
     * 预算（autoRound.signingTerms / affordable）：付完签字费后余额 ≥（每回合工资 + 新签工资）× reserveRounds；
     * 人选分两轮挑：先在签约后每回合经常性收入（赞助 + 直播 + 周边，不含奖金与夺冠热度加成）仍付得起工资的人选中取评分最高者；
     * 没有时才允许入不敷出：首发（补上空着的首发位，或顶替跨位置首发）要求余额还能覆盖 coverDeficitRounds 个回合（约 4 个赛季）的缺口；
     * 替补（首发已满：补替补深度，或补位的人选不比现任跨位置首发强）不允许入不敷出。
     * 不满足时不签，赛事照常由临时替补顶上（按赛事一次性付费，比长期工资便宜）。
     * 标定（24 + 40 个种子，DESIGN.md 3.4.2）：(6, 40) 时 Mineski TI5 起破产 11/24（HEAD 8/24），(10, 80) 时 8/24 与 11/40（HEAD 10/40）。
     * 只按评分挑（不分两轮）时新俱乐部多签 S 级、工资长期高于收入，资金逐季降到预留线后再也签不起人，打满 TI16 时阵容覆盖率掉到 75%；
     * 分两轮后 86% / 94% / 100%（TI1 / TI5 / TI9 起）。入不敷出时改签最便宜的人选覆盖率更高，但强队（EG）成绩明显下滑，未采用。
     */
    reserveRounds: 10,
    coverDeficitRounds: 80,
    /** 每回合至多自动签下的人数（从空阵容补到 minRosterFill 也够用） */
    maxSigningsPerRound: 6,
  },

  // -------------------------------------------------------------------------
  // 临时替补
  // -------------------------------------------------------------------------
  tempSub: {
    candidates: 5,
    costMult: 0.5,                 // 费用 = 该等级单回合工资 × costMult × econIndex
    baseWeights: { C: 40, B: 32, A: 20, S: 7, SS: 1, SSR: 0 } as Record<Tier, number>,
  },

  // -------------------------------------------------------------------------
  // 市场
  // -------------------------------------------------------------------------
  market: {
    freeAgentPoolMin: 30,
    aiOfferChancePerRound: 0.15,   // AI 对玩家某选手报价的概率
    offerExpireRounds: 2,
    acceptBase: 0.35,              // AI 接受报价：base + (fee/value - 1) × slope - importance
    acceptSlope: 0.9,
    playerWillingnessHonorScale: 400, // 选手意愿：sigmoid((honor - expected)/scale)
    tierHonorExpectation: { C: 0, B: 50, A: 150, S: 350, SS: 700, SSR: 1100 } as Record<Tier, number>,
    /** 意愿修正（sigmoid 自变量加成）：自由身求职 / 上届 TI 冠军 / 归属感低于 50 时更愿离开原队 */
    freeAgentWillingnessBonus: 0.6,
    championWillingnessBonus: 0.8,
    loyaltyWillingnessFactor: 1.5,  // x += (50 - loyalty)/100 × factor（仅对已有东家的选手）
    willingnessRange: [0.03, 0.97] as [number, number],
    /**
     * 个体差异（用户需求）：每名选手对每家俱乐部的意愿在基础值附近随机浮动，
     * 以 sigmoid 自变量偏移实现（三角分布，±willingnessJitter；0.9 约等于基础 50% 时上下浮动 ±20 个百分点）。
     * 偏移由 选手 × 俱乐部 × 赛季 决定：同一赛季内稳定（不会因刷新或重试而变化），新赛季重新浮动。
     */
    willingnessJitter: 0.9,
    /** 自由选手池上限：超出时最弱的程序化老将退出职业圈 */
    freeAgentPoolMax: 90,
    /** 补充自由选手的等级分布（偏低） */
    freeAgentTierWeights: { C: 38, B: 32, A: 20, S: 8, SS: 2, SSR: 0 } as Record<Tier, number>,
    /** 选手在原队重要度：头号首发 / 普通首发（替补为 0） */
    importanceStar: 0.25,
    importanceStarter: 0.12,
    acceptLoyaltyFactor: 0.3,       // AI 接受概率 += (50 - loyalty)/100 × factor
    suggestedFeeBase: 1.1,          // 建议转会费 = 身价 × (base + importance × mult) → 1.1~1.5
    suggestedFeeImportanceMult: 1.6,
    feeRounding: 1000,
    aiOfferFeeRange: [0.9, 1.4] as [number, number],
    poachFeeRange: [0.7, 1.1] as [number, number], // 低归属感挖角：违约金可能低于身价
    offerSalaryRaise: 1.15,         // AI 报价附带的新工资 = 当前工资 × 此值
    declineLoyaltyPenalty: -6,      // 拒绝报价且选手想走（归属感 < leaveThreshold）
    newSigningLoyalty: [55, 80] as [number, number], // 新签约选手归属感 = lerp(min, max, 意愿)
    releaseCompRoundsPerSeason: 2,  // 解约补偿 = 工资 × 此值 × 剩余合同赛季
    renewRefuseLoyalty: 40,         // 归属感低于此值时可能拒绝续约
    renewLoyaltyGain: 5,
    tempSubMax: 5,                  // 同时在队的临时替补人数上限（= 首发人数；与阵容人数无关，阵容再大也能为赛事招临时替补）
    realTempSubChance: 0.25,        // 每个候选位从真实自由选手中挑选的概率
    offerHistoryMax: 40,            // 保留的已处理报价条数
    aiOfferLoyaltyWeight: 2.5,      // AI 报价目标权重 = sqrt(身价) × (1 + (100-归属感)/100 × 此值)
    /**
     * 选手交易（trade.ts；用户需求 2026-10-14：「报价可以通过现金 + 本队队员身价（可多个）× 一定比例折溢价来达到目标队员报价」）：
     * 向 AI 战队求购时，报价总额 = 现金 + Σ 抵价选手估值；估值 = 身价 × 系数 × 意愿修正，
     * 系数 = baseRatio × 需求修正（无首发 / 可顶替首发 → 溢价；位置重叠 / 年龄偏大 / 等级低于首发 → 折价），夹在 ratioRange 内。
     * 接受概率沿用 aiAcceptChance（fee := 总额）；目标选手的加盟意愿照旧另判。规则与实测见 DESIGN.md 3.4.1。
     */
    trade: {
      /** 一次最多用几名本队选手抵价 */
      maxPlayers: 3,
      /** 基础系数：抵价选手按身价的这个比例计价（对方按「以物易物」折价接收） */
      baseRatio: 0.8,
      /** 系数（基础 × 需求修正）的夹紧范围 */
      ratioRange: [0.5, 1.15] as [number, number],
      /** 需求修正：对方该位置（本位置 / 副位置，含目标离队后腾出的位置）没有可用首发 */
      needMult: 1.45,
      /** 需求修正：评分高于对方该位置首发（评分比 1.0 → upgradeMult[0]，≥ 1 + upgradeFullGain → upgradeMult[1]，线性插值） */
      upgradeMult: [1.1, 1.45] as [number, number],
      upgradeFullGain: 0.15,
      /** 需求修正：位置重叠（评分不高于对方首发，只能当替补）：评分比 ≤ overlapFloorRatio → overlapMult[0]，→ 1 时 overlapMult[1] */
      overlapMult: [0.65, 1.0] as [number, number],
      overlapFloorRatio: 0.8,
      /** 年龄偏大：超过所打位置巅峰窗口（aging.peakWindow）每一年 × (1 - agePenaltyPerYear)，不低于 ageMinMult */
      agePenaltyPerYear: 0.08,
      ageMinMult: 0.7,
      /** 天梯等级低于对方该位置首发 */
      tierBelowMult: 0.85,
      /** 意愿：抵价选手对卖方的加盟意愿低于 minWillingness 时卖方拒收；介于 minWillingness..willingnessFullAt 之间按 willingnessMinMult..1 线性折价 */
      minWillingness: 0.25,
      willingnessFullAt: 0.7,
      willingnessMinMult: 0.6,
      /**
       * 刚从自由市场签下的选手（Player.freeAgentSignedClock，签下后不满 freeAgentHoldRounds 个转会回合 = listingRules.listingClock 之差）：
       * 实际系数（含意愿修正）最多为 freeAgentSignedCap，与 economy.signingFeeRatio（0.25）相同——对方按签字费估值，
       * 「签自由选手 → 立即抵价」无利可图（不设上限时实测可省 40%～49% 的报价，见 DESIGN.md 3.4.1）。
       * 18 个转会回合 ≈ 一个赛季：赛季末签下、下赛季初抵价同样受限；满一个赛季的工资（约身价 × 0.4）已付，之后按正常系数估值。
       */
      freeAgentSignedCap: 0.25,
      /**
       * 2026-10-15 起另加「随队不满 squadOps.listingMinTeamMatches 场」：两个条件任一成立都按签字费估值（与挂牌门槛同一计数，
       * 战队打得少时 10 场可能长于 18 个转会回合；不以 10 场取代 18 回合——那会缩短抵价的持有期）。
       */
      freeAgentHoldRounds: 18,
    },
  },

  // -------------------------------------------------------------------------
  // 球员管理操作（加薪 / 谈心 / 团建）与挂牌转会（squadOps.ts）
  // -------------------------------------------------------------------------
  squadOps: {
    /** 加薪幅度（%）→ 归属感基础增量；实际增量 × (1 - 归属感/loyaltyDiminishDivisor)（越接近 100 收益越小） */
    raisePcts: [10, 20, 30] as number[],
    raiseLoyalty: { 10: 6, 20: 12, 30: 18 } as Record<number, number>,
    loyaltyDiminishDivisor: 150,
    /** 一对一谈心（免费，每名选手每回合一次）：成功率 = base + 教练灵性/coachInsightDivisor + 荣誉幸运度/honorLuckDivisor */
    talk: {
      base: 0.45,
      coachInsightDivisor: 250,
      honorLuckDivisor: 10,
      chanceRange: [0.3, 0.9] as [number, number],
      /** 成功：归属感 + U(a,b) × 递减系数 */
      successGain: [3, 6] as [number, number],
      /** 失败：归属感低于 failPenaltyBelow 时 failPenalty，否则无变化 */
      failPenalty: -1,
      failPenaltyBelow: 30,
    },
    /** 团建（全队，每回合一次）：费用 × econIndex；每名正式队员归属感 + U(a,b) × 递减系数，韧性 + teamBuildingResilience */
    teamBuildingCost: 20000,
    teamBuildingLoyalty: [4, 8] as [number, number],
    teamBuildingResilience: 0.5,
    /**
     * 挂牌期（用户需求 2026-10-12：「队员挂牌到解约持续一整个赛季，而不是三个回合」）：listingSeasons 个赛季。
     * 等待回合数 = listingSeasons × 每赛季的倒计时回合数（squadOps.listingRoundsPerSeason = calendar.regularRounds：
     * 转会窗口开放的回合是赛季初 + 各常规赛回合，但赛季初没有回合结算、直接进入第 1 回合，所以每个常规赛回合结束时计一次；
     * TI 预选 / 正赛转会锁定期间暂停）。挂牌在下赛季的同一时间点到期；到期时整个挂牌期无人报价 → 自动解约，无补偿、不扣荣誉。
     */
    listingSeasons: 1,
    /**
     * 【用户指定，2026-10-15「增加签自由选手直接卖的难度，如果随队战绩10场以内，不需要上场，则无法挂牌」】
     * 随队战绩满 10 场（系列赛，不要求本人上场）才可挂牌：选手加盟当前战队（签自由选手 / 转会 / 交易 / 抽卡 / 真实新秀加盟等任何途径）后，
     * 该战队完成的系列赛（任何赛事，含 TI 预选 / TI、Bo2 平局与弃权）不满这么多场时不能挂牌（单个 / 批量），AI 也不会主动求购他
     * （普通随机求购、休赛期求购、使命求购、挖角）。开局阵容与旧存档中已在队的选手没有记录，不受限制。抽卡新秀的转售冷却（gacha.resaleHoldRounds）另外叠加。
     * 用户确认（2026-10-15）：按系列赛计，满 10 场即可挂牌。另须入队满 listingMinTransferRounds 个转会回合，两个条件都满足才能挂牌。
     */
    listingMinTeamMatches: 10,
    /**
     * 【用户指定，2026-10-15「再加入队满 6 个转会回合」】在「随队满 10 场」之外，新加盟的选手还须入队满这么多个转会回合才可挂牌，
     * 两个条件都满足才行（AI 也不主动求购，范围同上）。计时与交易抵价「刚签下」（market.trade.freeAgentHoldRounds）、抽卡转售冷却（gacha.resaleHoldRounds）
     * 同一个转会回合时钟（listingRules.listingClock：每个常规赛回合结束时 +1，赛季初与 TI 预选 / 正赛转会锁定期间不计）；
     * 起点 = 加盟当前战队时的时钟（Player.joinedTeamClock，team.addPlayerToTeam 在换队时写入）。开局阵容与旧存档中已在队的选手没有记录，不受限制。
     * 原因：强队在大赛回合一个回合就能打满 10 场，「回合初签下 → 赛后挂牌」与不设门槛时同一时机拿到报价（DESIGN.md 3.4「加盟门槛」）。
     */
    listingMinTransferRounds: 6,
    /** 旧存档的挂牌等待回合（原「3 个转会回合」规则）：读档 / 回合结算时按已经过的回合迁移到新的挂牌期，仅用于迁移 */
    legacyListingRounds: 3,
    /** 剩余这么多个倒计时回合且从未收到报价时，追加一条提醒新闻（另有「仅剩最后 1 个回合」提醒） */
    listingReminderRounds: 3,
    /**
     * 挂牌过久的报价意愿衰减（整赛季挂牌后防止「高标价挂一整季等人接盘」）：前 listingFreshRolls 次出价机会与原 3 回合规则完全相同；
     * 之后每次出价概率 × (1 - 强度 × (1 - listingStaleDecay^(已过出价机会 - listingFreshRolls + 1)))，
     * 强度 = (标价/当前身价 - lo) / (hi - lo) 夹紧到 [0, 1]（listingStaleRatioRange = [lo, hi]）：标价不高于身价时不衰减。
     * 实测（DESIGN.md 3.4「整赛季挂牌」）：2 倍标价整季成交率 35% → 14%（原 3 回合 3%），1.5 倍 69% → 40%（原 15%），≤ 1 倍不变。
     */
    listingFreshRolls: 3,
    listingStaleDecay: 0.7,
    listingStaleRatioRange: [1.0, 1.3] as [number, number],
    /**
     * 撤牌记忆：撤销挂牌后 relistStaleMemorySeasons 个赛季的转会回合（× calendar.regularRounds）内重新挂牌，
     * 沿用撤牌前已经历的出价机会次数（衰减不因撤牌 / 重挂而重置；标价不高于身价时衰减本来就不起作用）。0 = 不记忆。
     */
    relistStaleMemorySeasons: 1,
    /** 标价范围（× 身价） */
    listingPriceRange: [0.5, 2.0] as [number, number],
    /** 每回合出价概率曲线：[标价/身价, 基础概率]，区间内线性插值，两端取端点值 */
    bidChanceCurve: [[0.8, 0.85], [1.0, 0.45], [1.5, 0.08], [2.0, 0.02]] as [number, number][],
    /** 概率 × 等级系数（高等级选手更抢手） */
    bidTierMult: { C: 0.7, B: 0.85, A: 1.0, S: 1.1, SS: 1.2, SSR: 1.3 } as Record<Tier, number>,
    /** 概率 × lerp(min, max, 需求度)；需求度 = min(1, Σ兴趣 / bidDemandRef) */
    bidDemandMult: [0.5, 1.0] as [number, number],
    bidDemandRef: 2,
    bidMaxChance: 0.95,
    /**
     * AI 兴趣：该位置无首发，或选手评分 ≥ 其首发评分 × bidUpgradeRatio → 1；
     * 否则（补充板凳深度，需阵容未满）：标价/身价 ≤ bidBargainRatio → bidBargainInterest，
     * 在 bidBargainRatio..bidDepthMaxRatio 之间线性衰减到 0（避免标价略高于 0.9 倍时兴趣骤降为 0）
     */
    bidUpgradeRatio: 0.97,
    bidBargainRatio: 0.9,
    bidBargainInterest: 0.5,
    bidDepthMaxRatio: 1.2,
    /** 出价 = 标价 × U(a,b) */
    bidFeeRange: [0.8, 1.15] as [number, number],
  },

  // -------------------------------------------------------------------------
  // 日历
  // -------------------------------------------------------------------------
  calendar: {
    regularRounds: 18,
    seasonStartGapDays: 14,        // 上届 TI 结束后多少天开始新赛季
    ti1SeasonStart: '2011-03-01',  // TI1 赛季开始日（无上届 TI）
    tiQualifierLeadDays: 35,       // TI 预选回合 = TI 开始前多少天起
  },

  // -------------------------------------------------------------------------
  // 赛季流程（season.ts / game.ts）
  // -------------------------------------------------------------------------
  season: {
    /** 赛季最终排名 = 巡回赛积分 + TI 名次加成（冠军 = 此值，按名次百分位线性递减） */
    tiRankBonusMax: 3000,
    /** 保留往届赛事实例的赛季数（更早的仅保留 history 摘要，控制存档体积） */
    keepTournamentSeasons: 1,
    /**
     * 新俱乐部初始 5 人：S 级 newClubSTierCount 人 + A 级 newClubATierCount 人，其余 B 级。
     * 普通难度 1S+3A+1B ≈ 联赛垫底档（真实战队首发多为 S 级）：白手起家但不至于每项赛事都垫底，可用启动资金再补强
     */
    newClubSTierCount: { easy: 2, normal: 1, hard: 0 } as Record<string, number>,
    newClubATierCount: { easy: 3, normal: 3, hard: 3 } as Record<string, number>,
    newClubContractSeasons: 2,
    /**
     * 新俱乐部创立礼包（若干次单抽的资金）。第八波取消玩家抽卡后关闭；2026-10-14 抽卡回归后仍关闭（开局资金已按锚定额给足，
     * 新俱乐部用启动资金自行抽卡；礼包按旧的固定单抽价计算，未随年代缩放，打开前需复核）
     */
    newClubGachaGrant: false,
    /** 签约教练签字费 = 工资 × 此值 */
    coachSigningFeeSalaryMult: 4,
    /** 生涯总结/赛季总结里列出的退役选手上限 */
    summaryRetiredMax: 20,
    /** 赛季初清理已退役的程序化选手（非真实、未转任教练、未效力过玩家战队），控制存档体积 */
    pruneRetiredGeneratedPlayers: true,
  },

  // -------------------------------------------------------------------------
  // 赛事
  // -------------------------------------------------------------------------
  tournament: {
    /** 名次 → 奖金比例（区间内平分），按队伍总数选用最接近的表 */
    prizeShare: {
      8: [0.4, 0.2, 0.12, 0.1, 0.06, 0.06, 0.03, 0.03],
      12: [0.36, 0.18, 0.11, 0.08, 0.055, 0.055, 0.035, 0.035, 0.02, 0.02, 0.02, 0.02],
      16: [0.35, 0.15, 0.1, 0.07, 0.05, 0.05, 0.035, 0.035, 0.02, 0.02, 0.02, 0.02, 0.01, 0.01, 0.01, 0.01],
      18: [0.45, 0.13, 0.09, 0.065, 0.045, 0.045, 0.03, 0.03, 0.015, 0.015, 0.015, 0.015, 0.01, 0.01, 0.01, 0.01, 0.006, 0.006],
      20: [0.45, 0.13, 0.09, 0.065, 0.045, 0.045, 0.03, 0.03, 0.015, 0.015, 0.015, 0.015, 0.01, 0.01, 0.01, 0.01, 0.005, 0.005, 0.005, 0.005],
    } as Record<number, number[]>,
    /** 巡回赛积分：冠军积分，其余按奖金比例折算 */
    championPoints: { ti: 0, major: 1500, premier: 800, minor: 400, qualifier: 0 } as Record<TournamentTier, number>,
    /** 受邀判定：上赛季排名 ≤ invites 或荣誉 ≥ inviteHonor */
    inviteHonor: { ti: 99999, major: 1400, premier: 900, minor: 500, qualifier: 99999 } as Record<TournamentTier, number>,
    minHonor: { ti: 0, major: 250, premier: 120, minor: 0, qualifier: 0 } as Record<TournamentTier, number>,
    qualifierSlotsPerEvent: 2,     // 封闭预选赛产生的正赛名额
    qualifierTeams: 8,
    /** 小组积分：系列赛胜/平（同分再比小局净胜、相互战绩、随机） */
    groupPointsWin: 2,
    groupPointsDraw: 1,
    /** 非 TI 小组赛：组内队伍数 ≥ 此值时改为 Bo1 */
    groupBo1MinSize: 7,
    /** 各阶段 Bo 数 */
    bestOf: {
      groups: 2, groupsLarge: 1, playoffs: 3, final: 3, finalBig: 5,
      tiLowerFirst: 1,             // TI 败者组首轮
      qualifier: 1, qualifierDecider: 3, // 封闭预选：前几轮 Bo1，晋级战 Bo3
    },
    /** 总决赛 Bo5 的赛事等级 */
    bigFinalTiers: ['ti', 'major'] as TournamentTier[],
    /** AI 补位权重 = 积分 × points + 荣誉 × honor + 战队评分 × rating */
    aiFillWeight: { points: 1, honor: 0.5, rating: 2 },
    /** AI 参赛门槛：荣誉 ≥ minHonor × 此值 */
    aiMinHonorFactor: 0.5,
    /**
     * 赛季中补充邀请（第十四波，schedule.refreshSeasonInvites，每回合结束时）：对本赛季未来 horizonRounds 个回合内开赛的常规赛事
     * 重新评估直邀——当前赛季积分榜排名 ≤ 直邀规模（模板直邀名额与赛季初受邀队数取大；赛区锁定赛事按赛区内排名；
     * 需本赛季已有积分）或荣誉 ≥ inviteHonor[等级] 的战队，若不在受邀名单中且名单有空位
     * （婉拒 / 解散腾出的席位 + extraSlots 个追加席位，总数不超过正赛规模）则补邀，按积分榜顺序补齐。
     * 已有邀请不撤销；AI 自动接受；人类战队默认接受（同回合已有同级或更高等级赛事则记为已婉拒，
     * 低等级的已有安排自动让位、不扣荣誉）并收到总览通知 + 新闻，至少提前 humanNoticeRounds 个回合通知，
     * 通知当回合内婉拒免扣荣誉。
     */
    lateInvite: {
      enabled: true,
      extraSlots: 2,
      /**
       * 只评估未来几个回合内开赛的赛事（含下一回合）：邀请随赛事临近逐回合发出、依据的是较新的积分榜，
       * 而不是第 1 回合结束时就把整季的赛事按一回合的成绩发完
       */
      horizonRounds: 4,
      /** 人类战队至少提前多少个回合收到补充邀请（1 = 下回合开赛的赛事不再补邀人类战队，留出婉拒窗口） */
      humanNoticeRounds: 1,
      /** 积分榜排名条件要求本赛季已有积分（避免赛季初按荣誉排序的「排名」把无成绩的战队补邀进来） */
      requirePoints: true,
    },
    /** TI 赛区预选：队伍数 ≥ 此值用双败，否则单败 */
    tiQualifierDeMinTeams: 6,
    /** tis.json 缺失某届时的 TI 兜底参数 */
    tiFallback: { teams: 18, directInvites: 12, prizePool: 2000000 },
    /** 单项赛事模拟循环上限（防御死循环） */
    seriesSimGuard: 20000,
    /**
     * 线上公开赛（补位赛事）：赛季初若玩家在某个常规回合没有任何可报名/受邀的赛事
     * （无赛事、荣誉不足、赛区锁定或同期受邀冲突），自动在该回合补一项开放报名的线上赛，
     * 让常规回合尽量都有比赛可打（是否报名由玩家决定）。不发邀请、不限赛区与荣誉；
     * 规模按同回合空闲队伍估算（最多 teams 队），空闲队伍不足 minTeams 时该回合不补位。
     * 不计巡回赛积分（Tournament.noCircuitPoints），以免刷积分抢 TI 直邀。
     */
    fillerCup: {
      enabled: true,
      tier: 'minor' as TournamentTier,
      teams: 8,
      format: 'de8' as const,
      /** 奖金池（× econIndex(year)） */
      prizePool: 50000,
      /** 开赛日 = 回合开始日 + 回合天数 × 此比例 */
      startOffset: 0.3,
      /** 估算的空闲队伍（含玩家）不足此数时不补位（同回合大赛已占满几乎所有战队） */
      minTeams: 4,
      /** 有荣誉门槛的开放赛事，玩家荣誉需高出门槛此值才视为该回合「有赛可打」（防止赛季中荣誉跌破门槛后无赛可打） */
      honorMargin: 50,
    },
  },

  // -------------------------------------------------------------------------
  // 比赛
  // -------------------------------------------------------------------------
  match: {
    gamma: 9,                      // strengthShare 指数
    wDraft: 0.4,
    wStrength: 0.6,
    kDraft: 0.018,                 // dotaPlusWR = 0.5 + draftDiff × kDraft + insightDiff × kInsight
    kInsight: 0.004,
    dotaPlusMin: 0.15,
    dotaPlusMax: 0.85,
    finalMin: 0.05,
    finalMax: 0.95,
    incidentChancePerGame: 0.45,   // 每局出现局内突发事件概率（可连续 roll 至多 2 个）
    incidentPowerRange: [-0.18, 0.12] as [number, number],
    draftNoiseByInsight: 3.0,      // AI BP 噪声 σ = noise × (1 - insight/100)
    comfortBonus: 1.5,
    positionFitWeight: 3.0,
    metaWeight: 1.0,
    synergyWeight: 0.6,
    counterWeight: 0.5,
    durationRange: [15, 100] as [number, number], // 单局时长硬上下限（分钟；真实职业比赛最短约 12 分钟、TI 最长 90~140 分钟）
    // --- BP / 单局模拟细节（E2） ---
    banComfortWeight: 1.4,         // 禁用评分：针对对方（位置未定的）招牌英雄
    banThreatWeight: 0.6,          // 禁用评分：克制我方已选英雄
    banOwnComfortPenalty: 0.8,     // 禁用评分：不禁自家招牌英雄
    fastDraftSigma: 3.7,           // AI 对 AI 快速模拟：BP 评分差 ~ N(slope × 灵性差, σ)（按完整 BP 实测标定）
    fastDraftInsightSlope: 0.1,    // 每 1 点灵性差带来的 BP 评分差期望
    // --- 单局时长 / 击杀（K1 按真实职业比赛标定，数据：OpenDota 历届 TI 联赛 2012–2026 全部对局） ---
    // 时长 = 年代平均时长 × e^(阵容 + 势均力敌 + 爆冷修正 + N(−σ²/2, σ))（对数正态，右偏：真实 p10 ≈ 0.66×、p90 ≈ 1.4× 平均）
    durationLeanShift: 0.2,        // ln 时长：双方阵容偏后期（每单位 lean，-1 前期 … +1 后期）
    durationClosenessShift: 0.3,   // ln 时长：势均力敌（closeness = 1 − |胜率 − 0.5| × 2，相对 durationClosenessRef）→ 更长；碾压 → 更短
    durationClosenessRef: 0.79,    // 实际赛季对阵的平均修正（closeness 均值约 0.75 + 爆冷 + 阵容）使时长均值 ≈ 年代平均（按实际赛季流程标定）
    durationUpsetShift: 0.07,      // ln 时长：爆冷（低胜率方获胜）→ 更长
    durationLogSigma: 0.28,        // ln 时长随机 σ（连同上面的修正，总体 ln σ ≈ 0.29，与真实一致）
    // 总击杀 = 年代平均总击杀 × (时长 / 年代平均时长)^killsDurationExp × 噪声（真实：22 分钟约 32 杀、40 分钟约 49、60 分钟约 67）
    killsDurationExp: 0.76,
    killsLogSigma: 0.2,            // 噪声：对数尺度均匀分布的标准差（均值归一，尾部有界）
    killsRange: [4, 120] as [number, number],
    // 胜方击杀占比 = 0.5 + (winnerKillShare − 0.5) × e^(−decay × (时长 / 年代平均时长 − 1)) + pWin 修正 + N(0, sd)
    // 真实：22 分钟 0.78、31 分钟 0.71、40 分钟 0.65、49 分钟 0.60、60 分钟 0.57（碾压局短且一边倒，长局比分接近；胜方击杀更少约 6%）
    winnerKillShare: 0.646,
    winnerKillShareDecay: 1.6,
    winnerKillSharePWin: 0.08,     // 胜方赛前胜率每高出 0.1 → 占比 +0.008
    winnerKillShareSd: 0.085,
    /**
     * 年代基准：TI 序号 → [平均时长（分钟）, 平均总击杀]（该届 TI 联赛真实对局均值；TI1 无数据沿用 TI2，TI16 为 TI12–15 均值）。
     * 真实值（时长 / 总击杀 / 每分钟击杀）：2012 35.8/39.3/1.12、2013 35.9/35.9/1.03、2014 38.1/41.1/1.11、2015 40.6/45.7/1.16、
     * 2016 39.7/42.7/1.10、2017 41.0/48.2/1.20、2018 39.5/54.1/1.40、2019 39.7/47.6/1.23、2021 40.0/47.4/1.21、2022 40.1/49.5/1.25、
     * 2023 42.5/50.4/1.24、2024 37.9/40.7/1.11、2025 43.6/44.4/1.04、2026 46.8/52.0/1.13
     */
    eraByTi: {
      1: [35.8, 39.3], 2: [35.8, 39.3], 3: [35.9, 35.9], 4: [38.1, 41.1], 5: [40.6, 45.7], 6: [39.7, 42.7],
      7: [41.0, 48.2], 8: [39.5, 54.1], 9: [39.7, 47.6], 10: [40.0, 47.4], 11: [40.1, 49.5], 12: [42.5, 50.4],
      13: [37.9, 40.7], 14: [43.6, 44.4], 15: [46.8, 52.0], 16: [42.7, 46.9],
    } as Record<number, [number, number]>,
    /** 表外赛季（数据异常 / 未来）的年代基准 */
    eraDefault: [42.7, 46.9] as [number, number],
    comebackWinProb: 0.42,         // 胜方赛前胜率低于此值时可能出现「翻盘」剧本
    mvpNoise: 0.15,                // MVP 评选：表现 = 评分 × 突发倍数 × N(1, σ)
  },

  // -------------------------------------------------------------------------
  // 版本
  // -------------------------------------------------------------------------
  patch: {
    futureIntervalDays: 110,
    /** 推演版本各位置倍数区间（真实版本单位置幅度多在 ±0.5%~1.5%） */
    futureMultRange: [0.985, 1.015] as [number, number],
    /** 版本倍数均值守恒：各位置倍数除以几何平均，只改变位置间相对强弱，不让全联盟战力随版本累积漂移 */
    meanPreserving: true,
    /** 推演版本覆盖到此日期 */
    futureUntil: '2028-12-31',
    /** 推演版本为「大版本」的概率 */
    futureMajorChance: 0.25,
    /** 新闻里「明显加强/削弱」的倍数阈值（|mult-1| ≥ 此值） */
    notableDelta: 0.005,
  },

  // -------------------------------------------------------------------------
  // 程序化生成（generation.ts）
  // -------------------------------------------------------------------------
  generation: {
    /** 未指定赛区时的赛区权重 */
    regionWeights: { CN: 24, CIS: 20, EU: 20, SEA: 16, NA: 10, SA: 10 } as Record<Region, number>,
    /** 各等级战力区间（再叠加 N(0, powerNoise)） */
    powerByTier: {
      C: [45, 55], B: [52, 62], A: [58, 70], S: [66, 78], SS: [74, 86], SSR: [82, 94],
    } as Record<Tier, [number, number]>,
    powerNoise: 2,
    /** 新人战力折扣（rookie / 真实新秀 firstPower × U(a,b)） */
    rookiePowerMult: [0.9, 0.97] as [number, number],
    /** 真实新秀灵性折扣（playerIndex.insight × U(a,b)）与归属感加成 */
    rookieInsightMult: [0.85, 0.95] as [number, number],
    rookieLoyaltyBonus: 4,
    /** 非新人年龄 ~ N(mean, sd) 夹在 range */
    ageMean: 22.5,
    ageSd: 3,
    ageRange: [17, 31] as [number, number],
    /** 天赋均值：[maxAge(含), mean] 升序匹配；rookie 额外 + rookieTalentBonus */
    talentByAge: [[18, 64], [20, 60], [23, 54], [26, 47], [200, 40]] as [number, number][],
    talentSd: 11,
    rookieTalentBonus: 6,
    /** 韧性/灵性均值 = base + (age-18) × perYear (+ 灵性按等级 perTier) */
    resilienceBase: 34,
    resiliencePerYear: 2.4,
    insightBase: 36,
    insightPerYear: 2.0,
    insightPerTier: 3,
    attrSd: 9,
    loyaltyMean: 66,
    loyaltySd: 10,
    /** 生成属性夹紧区间（避免出现 0/100 的极端值） */
    attrClamp: [8, 96] as [number, number],
    /** 招牌英雄：位置适配度 ≥ 此值的已上线英雄中随机 2~3 个 */
    signatureFit: 0.6,
    signatureCount: [2, 3] as [number, number],
    /** 教练 */
    coachTierWeights: { C: 18, B: 30, A: 28, S: 16, SS: 7, SSR: 1 } as Record<Tier, number>,
    coachAgeRange: [27, 44] as [number, number],
    coachInsightBase: 58,
    coachInsightPerTier: 6,
    /** 非真实、未签约的退役选手只有等级 ≥ 此值才转为教练（避免教练市场被路人填满） */
    retiredCoachMinTier: 'S' as Tier,
    /** AI 战队强度档 */
    aiTeam: {
      tiers: {
        weak: { B: 55, A: 45 }, mid: { A: 55, S: 45 }, strong: { S: 60, SS: 40 },
      } as Record<'weak' | 'mid' | 'strong', Partial<Record<Tier, number>>>,
      honor: { weak: [110, 240], mid: [240, 600], strong: [600, 1200] } as Record<'weak' | 'mid' | 'strong', [number, number]>,
      /** 资金（× econIndex） */
      funds: { weak: [250000, 450000], mid: [450000, 900000], strong: [900000, 1800000] } as Record<'weak' | 'mid' | 'strong', [number, number]>,
      subChance: 0.45,
      coachChance: { weak: 0.3, mid: 0.6, strong: 0.85 } as Record<'weak' | 'mid' | 'strong', number>,
      coachTier: { weak: { C: 40, B: 45, A: 15 }, mid: { B: 35, A: 45, S: 20 }, strong: { A: 35, S: 45, SS: 20 } } as Record<'weak' | 'mid' | 'strong', Partial<Record<Tier, number>>>,
    },
  },

  // -------------------------------------------------------------------------
  // 事件（每回合概率）
  // -------------------------------------------------------------------------
  events: {
    matchFixingPerTeam: 0.002,
    matchFixingHonor: -120,
    matchFixingHonorCooperate: -60,
    heartbreakPerPlayer: 0.015,
    heartbreakPower: [0.06, 0.15] as [number, number],
    heartbreakRounds: [2, 4] as [number, number],
    visaPerPlayerNA: 0.12,
    visaPerPlayerOther: 0.02,
    visaRiskRegions: ['CN', 'SEA', 'CIS', 'SA'] as Region[],
    scandalPerTeam: 0.01,
    scandalHonor: [-10, -35] as [number, number],
    beefPerRound: 0.03,
    unpaidHonor: -25,
    hotStreakPerPlayer: 0.02,
    hotStreakPower: [0.05, 0.12] as [number, number],
    hotStreakRounds: [2, 3] as [number, number],
    sponsorPerRound: 0.05,
    sponsorGoldPerHonor: 60,       // 金额 = honor × 此值 × econIndex
    injuryPerPlayer: 0.01,
    streamDealPerRound: 0.03,
    fanMeetingPerRound: 0.03,
    difficultyMult: { easy: 0.6, normal: 1.0, hard: 1.4 } as Record<string, number>,
    /** 无厘头搞笑事件：玩家战队每回合触发概率（不受难度倍数影响；事件表见 funEvents.ts） */
    funEventChancePerRound: 0.22,
    // ---- 以下为 events.ts 细节参数 ----
    /**
     * AI 战队假赛（直接永久禁赛）每回合概率（第六波：0.002 → 单独设置并下调，联盟每赛季约 0.3 起，原约 1.2 起且几乎全是真实选手）。
     * 人类玩家战队仍用 matchFixingPerTeam × 难度（带抉择）。
     */
    aiMatchFixingPerTeam: 0.0005,
    /** 涉事选手抽取权重 = (101 - 归属感) × sqrt(平均工资 / 工资) × 真实选手 realMult × 联盟明星 starMult（明星 = 评分前 starTop 或等级 ≥ SS） */
    matchFixingRealMult: 0.35,
    matchFixingStarMult: 0.08,
    matchFixingStarTop: 40,
    /** 同一战队两次假赛风波至少间隔的赛季数（本赛季与上赛季发生过则不再触发） */
    matchFixingCooldownSeasons: 2,
    /** 荣誉缓冲：假赛扣分 ≤ max(honor.lossCushionFloor, 当前荣誉) × 此值（东窗事发 × 2），避免一次事件直接解散小俱乐部 */
    matchFixingMaxHonorShare: 0.35,
    matchFixingLeakChance: 0.5,    // 冷处理后东窗事发概率（荣誉双倍扣除）
    matchFixingLeakDelay: [1, 4] as [number, number],
    matchFixingCoverLoyalty: -15,
    scandalPower: [0.03, 0.08] as [number, number],
    scandalRounds: [1, 3] as [number, number],
    scandalLoyalty: -8,
    scandalPrCost: 40000,          // 公关处理费用（× econ）
    scandalPrHonorMult: 0.4,       // 公关后荣誉损失倍数
    beefMaxPerSeason: 2,
    beefRankWindow: 5,             // 宿敌从战力排名相近 ±N 名中挑选
    injuryPower: [0.08, 0.2] as [number, number],
    injuryRounds: [1, 3] as [number, number],
    streamDealGold: [20000, 60000] as [number, number], // × econ
    streamDealLoyalty: 4,
    fanMeetingHonor: [2, 6] as [number, number],
    fanMeetingLoyalty: 2,
    visaNonRiskMult: 0.5,          // 非高风险赛区选手的签证概率倍数
    unpaidLeaveChance: 0.35,       // 欠薪时归属感低于阈值者直接离队概率
    leavePersuadeBase: 0.3,        // 挽留成功率 = base + honorLuck × luckFactor
    leavePersuadeLuck: 0.35,
    leavePersuadeLoyalty: 12,
    leaveRaiseSalaryMult: 1.3,
    leaveRaiseLoyalty: 20,
  },

  // -------------------------------------------------------------------------
  // 俱乐部全员假赛（scandal.ts，第八波 #6）
  // -------------------------------------------------------------------------
  scandal: {
    /** 每支战队每个赛季掷一次的概率（用户确认：0.1%）；命中则在本赛季随机一个常规赛回合曝光 */
    clubBanChancePerSeason: 0.001,
    /** AI 俱乐部被除名后补位新组织的实力档（generation.generateAiTeam：weak / mid / strong） */
    replacementStrength: 'mid' as 'weak' | 'mid' | 'strong',
    /** 曝光新闻里最多列出的选手数 */
    newsPlayerListMax: 8,
  },

  // -------------------------------------------------------------------------
  // 俱乐部品牌变迁（branding.ts，第十波 #4）：数据 src/data/branding.json，赛季开始时套用该届有效的名称 / 简称 / 配色
  // -------------------------------------------------------------------------
  branding: {
    /** 总开关（关闭后保持阵容数据中的名称 / 简称 / 配色不变） */
    enabled: true,
    /** 「更名为」新闻是否标为重要（进入回合要闻的权重更高） */
    renameNewsImportant: true,
    /** 「启用新视觉」（只换简称 / 配色）新闻是否标为重要 */
    visualNewsImportant: false,
    /** 每支战队保留的品牌沿革条数（Team.brandHistory，存档体积上限） */
    historyMax: 12,
    /** 品牌数据允许的最大届次（与 TI16 一致） */
    maxTi: 16,
    /** 简称最长字符数（界面 TeamTag / 队徽首字母） */
    maxTagLength: 8,
  },

  // -------------------------------------------------------------------------
  // 破产（bankruptcy.ts，第十波 #1）：只作用于人类俱乐部（单机玩家 + 多人每个座位）；AI 俱乐部沿用 ai.ts / shuffle.ts 的负债处理。
  // 每个回合结算（收入、工资、挂牌转会之后）检查一次资金：
  // -------------------------------------------------------------------------
  bankruptcy: {
    /** 资金连续 N 个回合结算后仍为负 → 破产（资金转正即清零） */
    rounds: 3,
    /** 负债（负资金的绝对值）超过 N × 每回合工资（选手 + 教练）→ 立即破产；每回合工资为 0 时此条不适用 */
    debtWageRounds: 6,
  },

  // -------------------------------------------------------------------------
  // 玩家战队负面事件降频（第九波 #4；events.ts / scandal.ts）。只作用于人类战队（单机玩家 + 多人模式每个座位），
  // AI 战队的事件概率不变。负面事件：情感受挫、伤病、丑闻、战队 beef、假赛风波、签证问题（与难度倍数相乘；正面事件不变；
  // 用户设定的无厘头事件 funEvents.ts 不受影响）。
  // 用户要求：TI 预选与 TI 正赛回合期间禁赛类结果（个人假赛永久禁赛、俱乐部全员假赛）一律为 0 —— 这是硬规则，不设开关：
  // TI 回合不触发假赛风波、到期的「假赛调查结果公开」顺延到 TI 之后、全员假赛只在常规赛回合计划与曝光；
  // 签证被拒（选手无法出战）同属缺阵类结果，TI 回合同样为 0（第九波 QA，events.checkVisaForTournament）。
  // -------------------------------------------------------------------------
  humanEvents: {
    /** 人类战队负面事件的整体倍数（无头模拟 45 局 × 4 季实测：约 5.7 → 3.5 起 / 队 / 赛季；TI 两回合合计 0.62 → 0.09 起） */
    negativeMult: 0.7,
    /** TI 预选与 TI 正赛回合的额外倍数（在 negativeMult 之上，合计 × 0.175） */
    tiNegativeMult: 0.25,
    /**
     * 人类俱乐部全员假赛的概率倍数（× scandal.clubBanChancePerSeason）。
     * 0.1% / 队 / 赛季为用户确认值，默认不另行下调（TI 回合曝光为 0 的规则另由 scandal.ts 保证）。
     */
    clubBanMult: 1,
  },

  // -------------------------------------------------------------------------
  // 生涯总结 / 传奇值（legacy.ts，第八波 #7）。历史俱乐部按同一口径计分（src/data/legacyClubs.json）
  // -------------------------------------------------------------------------
  legacy: {
    // ---- 成就分 ----
    /** TI 冠军基础分；多冠王朝逐冠递增：第 k 座 = tiTitle × (1 + tiTitleDynastyStep × (k-1))（150 / 180 / 210 …） */
    tiTitle: 150,
    tiTitleDynastyStep: 0.2,
    /** 卫冕：每段连续两届夺冠额外加分（OG TI8–TI9 记一段） */
    tiBackToBack: 30,
    tiRunnerUp: 40,
    /** TI 第 3–4 名 */
    tiTop4: 18,
    /** TI 第 5–8 名 */
    tiTop8: 8,
    /** 每次参加 TI 正赛 */
    tiAppearance: 2,
    /** Major 冠军（历史俱乐部 = Valve Major 2015–2023）；合计封顶 majorCap（历史最多 5 个 = 50） */
    majorTitle: 10,
    majorCap: 100,
    /** 顶级赛事（premier）冠军：历史参照表无此项，单独封顶，避免游戏内刷小赛事压过历史豪门 */
    premierTitle: 4,
    premierCap: 40,
    // ---- 实力分（每赛季按排名档：玩家 = 赛季末战力排名；历史俱乐部 = 以当届 TI 名次近似） ----
    /** [排名上限, 分值]：第 1 名 6 分、前 3 名 4 分、前 8 名 2.5 分、前 16 名 1 分 */
    strengthBands: [[1, 6], [3, 4], [8, 2.5], [16, 1]] as [number, number][],
    /** 联盟规模基准：排名先按 (排名-1)/(队数-1) 换算到该规模，跨年代 / 联盟大小可比 */
    strengthLeagueRef: 24,
    /** 动态平衡：实力分 ≤ strengthCapBase + strengthCapShare × 成就分（只有实力没有奖杯的俱乐部不会压过冠军） */
    strengthCapBase: 30,
    strengthCapShare: 0.6,
    // ---- 声望（荣誉峰值；历史俱乐部按 (成就 + 实力) / prestigeHistDiv 估计） ----
    prestigeHonorRef: 150,
    prestigeHonorPer: 50,
    prestigeCap: 15,
    prestigeHistDiv: 25,
    /** 全员假赛被禁赛：传奇值折算倍数 */
    bannedScoreMult: 0.5,
    // ---- 称号判定 ----
    /** 常青豪门：无 TI 冠军但满足任一（TI 前四次数 / TI 前八次数 / Major 冠军 / 战力前三的赛季数） */
    evergreenTop4: 2,
    evergreenTop8: 4,
    evergreenMajors: 2,
    evergreenTopSeasons: 4,
    /** 一时劲旅：至少 1 个 Major / 2 个顶级赛事冠军，或 1 次 TI 前八，或 1 个战力前三的赛季 */
    contenderPremiers: 2,
    // ---- 关键时刻 ----
    /** 爆冷 / 黑马：赛前预期名次 − 实际名次 ≥ 此值（且实际进入前三）；热门翻车：预期前 2 实际 ≥ 第 9 */
    upsetRankGap: 4,
    /** 大额转会：单笔 ≥ 当时每回合工资总额 × 此值（且为本赛季最大的 2 笔） */
    bigTransferWageRounds: 4,
    momentsPerSeasonMax: 6,
    /** 计入关键时刻的赛事等级（冠军 / 爆冷）：线上公开赛、Minor 不算 */
    momentTiers: ['ti', 'major', 'premier'] as TournamentTier[],
    /** 结算页：最佳选手人数、历史排行榜显示行数 */
    bestPlayers: 5,
    leaderboardRows: 30,
    /** 评级：[传奇值下限, 评级]（三冠 ≈ 560、两冠 ≈ 450、单冠 ≈ 150–250） */
    gradeBands: [[450, 'S+'], [300, 'S'], [170, 'A'], [100, 'B'], [45, 'C']] as [number, string][],
    /** 最接近的历史俱乐部：成就差距权重（另加 |传奇值差| / 100） */
    matchWeights: { titles: 6, backToBack: 3, runnerUp: 3, top4: 1.5, top8: 0.8, majors: 0.6, appearances: 0.25 },
  },

  // -------------------------------------------------------------------------
  // DotaPedia 百科（stats.ts 记录 / pedia.ts 查询）
  // 记录只使用按（存档, 对局序号）派生的独立子随机流，不消耗主随机序列：开关不影响任何比赛结果。
  // -------------------------------------------------------------------------
  pedia: {
    /** 记录开关（关闭时不记录任何统计） */
    enabled: true,
    // ---- 单局 K/D/A 分配（只用于统计展示）。A 方击杀之和 = killsA，A 方阵亡之和 = killsB ----
    // 真实 TI（2013 / 2018 / 2019 / 2023–2025，按本队经济排名近似 1–5 号位）每队击杀占比约 31% / 29% / 18% / 14% / 9%，
    // 阵亡约 13% / 17% / 20% / 23% / 27%，助攻约 15% / 17% / 21% / 23% / 23%；每个击杀约 2.0~2.6 个助攻
    /** 击杀分配权重（文字直播的击杀者权重同用此表：核心位杀得多） */
    killWeight: { C: 1.5, M: 1.45, O: 1.0, SS: 0.7, HS: 0.48 } as Record<Position, number>,
    /** 阵亡分配权重（辅助更容易阵亡；文字直播的阵亡者权重同用此表） */
    deathWeight: { C: 0.68, M: 0.85, O: 1.0, SS: 1.18, HS: 1.32 } as Record<Position, number>,
    /** 助攻分配权重（辅助助攻多） */
    assistWeight: { C: 0.8, M: 0.88, O: 1.05, SS: 1.15, HS: 1.15 } as Record<Position, number>,
    /** 个人发挥的对数正态噪声 σ（击杀；文字直播里每名选手本局的击杀者权重同样乘一次） */
    noiseSigma: 0.32,
    /**
     * 阵亡 / 助攻的发挥噪声 σ（比击杀小：真实比赛的阵亡受复活时间限制、助攻随全队击杀，个人之间更平均；文字直播的阵亡者权重同用 deathNoiseSigma）。
     * 按历届 TI 实测标定（OpenDota，TI4–TI15）：单人阵亡 > 15 约 0.24%、击杀参与率 > 90% 约 4%（与击杀同用 0.32 时分别约 0.5% / 8%）
     */
    deathNoiseSigma: 0.22,
    assistNoiseSigma: 0.2,
    /** 全队助攻 = 本队击杀 × U(lo, hi)（真实历届 TI 每个击杀约 2.0~2.6 个助攻，均值约 2.3）；每人助攻 ≤ 本队击杀 − 自己的击杀 */
    assistsPerKill: [1.95, 2.65] as [number, number],
    /** 本局 MVP 的击杀 / 阵亡 / 助攻权重倍数（MVP 与数据正相关；文字直播的击杀者权重同用 mvpKillMult） */
    mvpKillMult: 1.5,
    mvpDeathMult: 0.6,
    mvpAssistMult: 1.15,
    // ---- 英雄归属：有 BP 的对局取 BP；AI 快速模拟按招牌英雄 / 位置适配 / 版本强度确定性挑选 ----
    /** 选用招牌英雄的概率（招牌英雄当时已上线时） */
    signatureShare: 0.45,
    /** 每个位置的版本候选数（权重 = 位置适配 × e^(版本强度 × metaWeight)） */
    metaPoolSize: 14,
    metaWeight: 0.6,
    /** 位置适配低于此值的英雄不进入该位置的候选 */
    minPositionFit: 0.45,
    /** 每名选手保留的英雄数（赛季末压缩，其余并入「其他」，控制存档体积） */
    heroesPerPlayer: 14,
    // ---- 查询 ----
    /** 排行榜默认行数 */
    boardRows: 10,
    /** 选手生涯 KDA / 胜率榜的最少局数；按赛季筛选时的最少局数 */
    minGames: 30,
    minSeasonGames: 12,
    /** 战队胜率榜的最少系列赛数（按赛季筛选时为 minTeamSeasonSeries） */
    minTeamSeries: 30,
    minTeamSeasonSeries: 10,
    /** 英雄胜率榜的最少出场数 */
    minHeroPicks: 20,
    /** 搜索结果默认条数 */
    searchLimit: 20,
    /** 历史地位榜默认行数 */
    legacyRows: 20,
    // ---- 选手历史地位（简化版传奇值：TI 名次 + 冠军 + MVP + 赛季 + 巅峰等级；开局前的真实 TI 名次同样计入） ----
    playerScore: {
      tiTitle: 100,
      tiRunnerUp: 35,
      tiTop4: 15,
      tiTop8: 6,
      tiAppearance: 2,
      major: 12,
      premier: 5,
      minor: 1.5,
      mvp: 0.25,
      mvpCap: 60,
      season: 2,
      peakTier: { C: 0, B: 0, A: 0, S: 5, SS: 10, SSR: 20 } as Record<Tier, number>,
    },
    /** 选手称号：TI 冠军数 ≥ legendTi「不朽传奇」/ ≥ doubleTi「双冠名宿」/ ≥ 1「不朽盾得主」；Major 冠军 ≥ 1「大赛冠军」；其他冠军 ≥ 1「冠军选手」 */
    playerTitles: { legendTi: 3, doubleTi: 2 },
  },

  // -------------------------------------------------------------------------
  // 羁绊（第十波 #5，synergy.ts）：历届 TI 冠军阵容（及少数标志性阵容）五人同队集齐 → 全队属性加成
  // -------------------------------------------------------------------------
  synergy: {
    /** 总开关（关闭时全部羁绊失效、修正器收回；用于对照模拟） */
    enabled: true as boolean,
    /**
     * 只有对应届次的真实 TI 已经打完（当前赛季 > 羁绊届次）才能觉醒，避免开局剧透未来的冠军
     * （如 TI9 开局时 OG 的 TI8 阵容可以觉醒，Spirit 的 TI10 阵容要到 TI11 赛季起）
     */
    activateAfterRealTi: true as boolean,
    /** 五人是否必须都是首发（false = 同队签约即可，不含赛事临时替补 / 野外替补） */
    requireStarters: false as boolean,
    /**
     * 加成：激活期间全队每名在役队员一个永久修正器（来源「羁绊：{名称}」），羁绊失效时移除。
     * 战斗力 ×1.03 ≈ 同实力单局胜率 +4 个百分点（strengthShare 指数 9 × 权重 0.6）；天梯 +600 约 15% 的 SS 选手跨档；
     * 灵性 +5 ≈ 大老师胜率 +2%；韧性 +5 / 天赋 +3 作用于事件影响与训练成长
     */
    bonus: {
      insight: { kind: 'add', value: 5 },
      resilience: { kind: 'add', value: 5 },
      talent: { kind: 'add', value: 3 },
      power: { kind: 'mul', value: 1.03 },
      mmr: { kind: 'add', value: 600 },
    } as Record<'insight' | 'resilience' | 'talent' | 'power' | 'mmr', { kind: 'add' | 'mul'; value: number }>,
    /** 同一战队同时激活多个同属性羁绊（如 Spirit 的三套阵容共享核心）时是否叠加：false = 只生效最早的一个 */
    stackSameAttr: false as boolean,
  },

  // -------------------------------------------------------------------------
  // AI 战队管理
  // -------------------------------------------------------------------------
  ai: {
    minRoster: 5,
    maxRoster: 7,
    richWageMultiple: 10,          // gold > 每回合工资 × 此值 → 富队额外训练
    focusWeights: { power: 0.35, mmr: 0.25, insight: 0.15, balanced: 0.25 } as Record<string, number>,
    preseasonUpgradeChance: 0.6,
    midseasonUpgradeChance: 0.15,
    upgradeMinGain: 1.05,          // 新选手评分需 > 原首发 × 此值
    signBudgetRounds: 6,           // 签约后余额需覆盖新增工资的回合数
    minWillingness: 0.2,           // AI 签约要求的最低选手意愿
    benchTargetGoldRounds: 25,     // 资金 > 工资 × 此值时补到 6 人
    coachHireChance: 0.7,
    coachFeeSalaryMult: 4,         // 教练签字费 = 工资 × 此值
    salaryCutMult: 0.85,           // 资金为负且无人可卖时全员降薪
    salaryCutLoyalty: -5,
    // 商业收入已由 economy.revenue（赞助 / 直播与内容 / 周边，人机共用，见 revenue.ts）取代
    /**
     * AI 盈余再投入：资金超过「每回合工资 × reserveRounds」的部分，每回合按 rate 比例投入俱乐部运营
     * （青训、场馆、内容团队、投资方分红等，离开联赛经济），避免长期霸榜的 AI 豪门无限囤积资金。人类玩家战队不受影响。
     */
    surplusReinvest: { reserveRounds: 30, rate: 0.05 },
    distressSaleFeeMult: 0.8,      // 甩卖价 = 身价 × 此值
    renewStarterChance: 0.85,      // 合同到期续约基础概率（× (0.5 + 归属感/100)）
    renewBenchChance: 0.45,
    newTeamStrengthWeights: { weak: 0.4, mid: 0.45, strong: 0.15 } as Record<'weak' | 'mid' | 'strong', number>,
  },

  // -------------------------------------------------------------------------
  // 休赛期转会潮（shuffle.ts）：每届 TI 结算后（退役/年龄/合同之后）、新赛季赛程生成之前执行；
  // 新游戏的第一个赛季保留真实初始阵容，不触发。只动 AI 战队；玩家战队只会收到报价 / 离队申请。
  // -------------------------------------------------------------------------
  shuffle: {
    enabled: true,
    /**
     * 满意度 S = wPerf × 上赛季各赛事「预期名次 - 实际名次」加权均值（荣誉变化的主要来源）
     *          + wRank × (战力排名 - 赛季最终排名) / max(rankScaleMin, 战队数 × rankScaleShare)
     *          + wTi × TI 项；夹在 [-1, 1]，负 = 不满意
     */
    wPerf: 1.4,
    wRank: 0.6,
    wTi: 0.8,
    rankScaleMin: 4,
    rankScaleShare: 0.33,
    /** 去除「强队天然低于预期、弱队天然高于预期」的趋势比例（0 = 不处理，1 = 完全按同档队伍比较） */
    satDebias: 0.7,
    /** 「名次 vs 预期」均值中各赛事等级的权重 */
    tierWeight: { ti: 3, major: 2, premier: 1.5, minor: 1, qualifier: 0.4 } as Record<TournamentTier, number>,
    /** TI 项 = 预期百分位 - 实际百分位（+ 冠军加成）；战力前 tiMissRank 未进 TI → -tiMissPenalty × (1 - (排名-1)/tiMissRank) */
    tiChampionBonus: 0.6,
    tiMissRank: 12,
    tiMissPenalty: 0.6,
    /**
     * 主动换人（首发）期望数 λ = base + dissatisfied × max(0,-S) - satisfied × max(0,S)，夹在 [min, max]；
     * 实际次数 = maxChangesPerTeam 次伯努利(λ / maxChangesPerTeam)。退役/合同到期/被挖走另计。
     */
    changesBase: 1.5,
    changesDissatisfied: 3.2,
    changesSatisfied: 0.2,
    changesMin: 0.15,
    changesMax: 2.7,
    maxChangesPerTeam: 3,
    /** 战力前 contenderRank 且满意（S ≥ 0）的争冠队 λ 上限；卫冕 TI 冠军 λ 上限；两者的主动换人次数另封顶 ceil(contenderMaxChanges) */
    contenderRank: 4,
    contenderMaxChanges: 1.0,
    championMaxChanges: 0.45,
    /** S ≤ unhappyBelow 视为「不满意」：换人门槛更低、更愿意卖人、明星更想走 */
    unhappyBelow: -0.2,
    /**
     * 换人候选分（越高越先被换）= weakness × (1 - 评分/首发均分) + ageStep × max(0, 年龄 - ageFrom + 1)
     *   + lowLoyalty × max(0, (50 - 归属感)/50) + offRole（打非本位置） - 黏性 + N(0, noise)；
     * 黏性 = 在队赛季 × tenureStep（核心 = 评分 ≥ 均分 × coreRatio 全额，其余减半，上限 tenureMax）+ 归属感 ≥ highLoyalty 时 highLoyaltySticky
     */
    weakness: 2.5,
    ageFrom: 27,
    ageStep: 0.07,
    lowLoyalty: 0.6,
    offRole: 1.5,
    tenureStep: 0.12,
    tenureMax: 0.45,
    coreRatio: 1.03,
    highLoyalty: 80,
    highLoyaltySticky: 0.3,
    replaceNoise: 0.2,
    /** 新援本位置评分需 ≥ 原首发 × (1 + gain)：争冠队 / 普通 / 不满意的队（愿意做平级调整换血） */
    minGainContender: 0.02,
    minGainNormal: 0,
    minGainUnhappy: -0.04,
    /** 自由选手 / 新秀顶替首发的最低提升（新增人才进入联盟，门槛高于 AI 之间的转会） */
    faMinGain: 0.05,
    /** 候选挑选：评分 × (1 + U(0, pickNoise))；不满意的队对 ≤ youthAge 岁的选手额外 + youthBonus */
    pickNoise: 0.03,
    youthAge: 21,
    youthBonus: 0.02,
    /**
     * 明星求变：首发在全联盟首发中的评分百分位 pPct（0 = 最强）明显好于所在队战力百分位 tPct（gap = tPct - pPct ≥ ambitionMinGap），
     * 且等级 ≥ ambitionMinTier 或 pPct ≤ ambitionTopShare → 概率 = ambitionChance × min(1, ambitionFloor + (gap - minGap)/ambitionGapSpan)
     *   × (1 + ambitionUnhappyBoost × max(0,-S)) × 归属感系数（≥ highLoyalty: ambitionLoyalSticky；否则 1.2 - 归属感/100）× (1 - 核心黏性)
     * 不满意（S ≤ unhappyBelow）的队里前 unhappyStarShare 的明星另有 unhappyStarChance 概率求去。
     * 求变的明星只接受战力排名至少高 ambitionMinRankGain 名的买家。
     */
    ambitionMinGap: 0.2,
    ambitionMinTier: 'S' as Tier,
    ambitionTopShare: 0.35,
    ambitionChance: 0.5,
    ambitionFloor: 0.3,
    ambitionGapSpan: 0.4,
    ambitionUnhappyBoost: 0.8,
    ambitionLoyalSticky: 0.35,
    unhappyStarShare: 0.12,
    unhappyStarChance: 0.3,
    ambitionMinRankGain: 3,
    /**
     * 强队明星寻求新挑战（顶级战队之间的横向流动）：战力前 challengeTopRank 的 AI 战队里、联盟前 starTopN 的首发，概率 =
     *   (challengeBase + challengeUnhappy × max(0,-S) + 合同最后一年 challengeContractBonus
     *    + min(challengeTenureMax, challengeTenureStep × max(0, 在队赛季 - challengeTenureFrom)))
     *   × 归属感 ≥ highLoyalty 时 challengeLoyalMult × 卫冕冠军 challengeChampionMult；
     * 只接受战力排名 ≤ max(卖家排名 - 1, challengeBuyerRank) 的买家（不满意强队的明星同样适用该买家范围）。
     */
    challengeTopRank: 10,
    challengeBase: 0.025,
    challengeUnhappy: 0.25,
    challengeContractBonus: 0.05,
    challengeTenureFrom: 2,
    challengeTenureStep: 0.025,
    challengeTenureMax: 0.075,
    challengeLoyalMult: 0.7,
    challengeChampionMult: 0.3,
    challengeBuyerRank: 6,
    /** 明星去向（shuffle.placeStars）：买家该位置首发评分需低于明星评分 / (1 + starMinGain) */
    starMinGain: 0.03,
    /** 低归属感（< loyalty.leaveThreshold）选手求去概率；资金为负的队挂牌最高薪首发概率 */
    lowLoyaltyLeaveChance: 0.6,
    distressSellChance: 0.5,
    /** 老将下放：≥ veteranAge 岁、在战力前 veteranTopRank 的队且非队内头号选手 → 概率挂牌（多被二线队伍接手） */
    veteranAge: 28,
    veteranTopRank: 8,
    veteranStepDownChance: 0.12,
    /** 挂牌要价（× 身价）：求变 / 低归属感 / 老将 / 被替换的首发 / 甩卖 / 解散 */
    feeAmbition: [1.0, 1.25] as [number, number],
    feeLoyalty: [0.7, 1.05] as [number, number],
    feeVeteran: [0.55, 0.85] as [number, number],
    feeSurplus: [0.55, 0.9] as [number, number],
    feeDistress: [0.7, 0.9] as [number, number],
    /** 求变/低归属感选手对买家的意愿加成（加在 market.playerWillingness 上） */
    wantsOutWillingnessBonus: 0.25,
    /**
     * 挖角（未挂牌的选手）：买家战力排名 ≤ poachMaxBuyerRank 且强于卖家；转会费 = 身价 × U(poachFee)；
     * 卖家放人概率 = poachAccept + 不满意 poachAcceptUnhappy - 头号选手 poachStarPenalty + (50 - 归属感)/100 × poachLoyaltyFactor；
     * 每个需求最多尝试 poachTries 名候选
     */
    poachMaxBuyerRank: 12,
    poachFee: [1.2, 1.6] as [number, number],
    poachAccept: 0.3,
    poachAcceptUnhappy: 0.25,
    poachStarPenalty: 0.3,
    poachLoyaltyFactor: 0.5,
    poachTries: 3,
    /** AI 引援的资金门槛：付完转会费/签字费后余额 ≥（工资 + 新增工资）× budgetRounds（休赛期重组可以比赛季中更激进） */
    budgetRounds: 4,
    /** 市场轮数（连锁转会：被挖走首发的队伍在下一轮补人） */
    passes: 4,
    /** 被替换下来的首发：阵容 > keepRoster 人时（未被其他队买走）解约离队；解约补偿 = market 公式 × releaseCompMult */
    keepRoster: 6,
    releaseCompMult: 0.5,
    /** 罕见事件：资金 < -debtWageRounds × 回合工资 或 荣誉 ≤ honorMax 的 AI 战队按 chance 解散（每届至多 1 支），新组织接手 coreCount 名核心 */
    disbandChance: 0.35,
    disbandDebtWageRounds: 6,
    disbandHonorMax: 80,
    disbandCoreCount: [2, 3] as [number, number],
    newOrgHonor: [150, 300] as [number, number],
    /** 新组织资金 = 联盟 AI 战队资金中位数 × U(a, b)（随经济平衡自动缩放；中位数 ≤ 0 时按 generation.aiTeam.funds.mid × econIndex） */
    newOrgFundsMedianMult: [1.0, 1.5] as [number, number],
    /**
     * 玩家战队：休赛期每名正式选手被 AI 报价的概率（× 等级系数 × (1 + 不满意) × (1 + (100-归属感)/100)），每队至多 humanMaxOffers 份；
     * 买家 = 该位置首发评分 < 选手评分 × humanOfferFit 且付得起的 AI 战队（越强越可能出手）
     */
    humanOfferFit: 1.03,
    humanOfferChance: 0.18,
    humanOfferTierMult: { C: 0.4, B: 0.6, A: 0.9, S: 1.2, SS: 1.5, SSR: 1.8 } as Record<Tier, number>,
    humanOfferFee: [1.0, 1.4] as [number, number],
    humanMaxOffers: 3,
    /** 玩家战队明星求变（等级 ≥ ambitionMinTier、归属感 < humanLeaveLoyalty、满足明星求变的百分位差）：离队申请概率；每赛季至多 1 份 */
    humanLeaveChance: 0.25,
    humanLeaveLoyalty: 55,
    /** 新闻：明星 = 联盟评分前 starTopN；逐条新闻上限（防刷屏的保险，正常休赛期知名转会都能单独成文；其余只进汇总）；传闻条数（真 / 假） */
    starTopN: 30,
    maxMoveNews: 80,
    rumorTrueMax: 4,
    rumorFalse: [1, 2] as [number, number],
    /** 「换帅换人」传闻与假传闻只涉及战力排名前 rumorTeamRank 的知名战队 */
    rumorTeamRank: 12,
    /** 传闻日期：赛季开始日前 U(a, b) 天（上届 TI 结束后的休赛期） */
    rumorDaysBefore: [2, 12] as [number, number],
    /** 大额转会标签（big-transfer）：转会费 ≥ 身价参考 × econIndex 或 等级 ≥ SS */
    bigTransferFee: 300000,
  },

  // -------------------------------------------------------------------------
  // 新俱乐部涌现（第十波 #2，clubs.ts）：赛季初（新秀选秀与休赛期转会潮之前）全局执行一次（新游戏第一个赛季不执行）。
  // 真实组织（src/data/clubIndex.json）出现在当届 roster、而本局从未有过该组织的战队 → 以当届品牌 / 荣誉 / 资金成立并签回当届真实选手；
  // 偶尔成立一个虚构新组织。联赛规模保持在 [team.minTeams, maxTeams]（下限由 ai.aiEnsureRosters 补足）。
  // -------------------------------------------------------------------------
  clubs: {
    enabled: true,
    /** 联赛规模上限（未解散战队数，含玩家）：成立新俱乐部不会超过此数 */
    maxTeams: 34,
    /** 每个赛季至多成立的真实俱乐部数（按重要程度：现实 TI 冠军次数 / 最好名次、当届 TI 正赛队、荣誉） */
    maxRealPerSeason: 3,
    /**
     * 联赛已满时，为「重要」真实俱乐部（当届 TI 正赛队，或现实最好 TI 名次 ≤ majorBestRank）腾出席位：
     * 解散一支「过气」AI 俱乐部（虚构组织，或现实中已连续两届以上不在阵容数据中、且从未夺得 TI 的组织；荣誉 < retireHonorMax、
     * 战力排名在后 retireRankShare），每赛季至多 maxRetirePerSeason 支
     */
    majorBestRank: 8,
    maxRetirePerSeason: 2,
    retireHonorMax: 700,
    retireRankShare: 0.5,
    /**
     * 起始资金 = economy.realClubStartingFunds（与开局的 AI 真实俱乐部同一公式：原口径「数据资金 × 0.2」封顶于强队锚定额 × 年代系数，不乘难度倍数），
     * 不低于签约后每回合工资 × minFundsWageRounds（与开局的 9 回合下限分开：成立后还要付转会费签回真实选手，见 budgetRounds）。
     * 只有最富一档的组织比原口径少（封顶）；成立时签回的真实选手、每局成立 / 解散数见 DESIGN.md 3.6
     */
    minFundsWageRounds: 12,
    /**
     * 新俱乐部的「上赛季排名」：插入到排名表的 round(规模 × rankShare) 处、其后战队顺延（排名保持唯一）——选秀顺位 / 邀请 / 赞助的依据
     * （不排在最后，避免新俱乐部白拿状元签概率）
     */
    rankShare: 0.6,
    /**
     * 签回当届真实选手（自由选手直接签；AI 战队的选手付转会费求购，从不动人类玩家战队的选手）：
     * 转会费 = 身价 × U(fee)；卖家放人概率 = sellChance - 头号选手 sellStarPenalty - 卖家自己的使命成员 sellMissionPenalty
     */
    fee: [1.0, 1.3] as [number, number],
    sellChance: 0.75,
    sellStarPenalty: 0.25,
    sellMissionPenalty: 0.45,
    /** 付完费用后余额 ≥ (工资 + 新增工资) × budgetRounds（成立时的预算） */
    budgetRounds: 3,
    /** 签回的真实选手：合同 U{signContractSeasons} 个赛季、初始归属感 signLoyalty */
    signContractSeasons: [2, 3] as [number, number],
    signLoyalty: 72,
    /** 阵容已满时为当届真实选手腾位：被放走的补位队员综合评分最多比该真实选手高 spareMaxGap（否则不签） */
    spareMaxGap: 10,
    /**
     * 本局中从未出现过的当届真实选手按当届水平加入：天赋 = 真实天赋峰值 − bringBackTalentDecline × max(0, 年龄 − bringBackTalentAgeFrom)
     *（战力 / 天梯取当届真实生涯轨迹）
     */
    bringBackTalentAgeFrom: 24,
    bringBackTalentDecline: 1.5,
    /**
     * 虚构新组织：每个赛季的成立概率（至多 1 个；联赛已满时由一支过气 AI 俱乐部让出席位，与真实俱乐部共用解散名额、真实俱乐部优先），
     * 荣誉 U(fictionalHonor)，资金 = AI 战队资金中位数 × U(fictionalFundsMedianMult)
     */
    fictionalChance: 0.3,
    fictionalHonor: [150, 300] as [number, number],
    fictionalFundsMedianMult: [0.9, 1.3] as [number, number],
  },

  // -------------------------------------------------------------------------
  // 俱乐部使命（第十波 #3，missions.ts）：每个非玩家的真实俱乐部以组建现实巅峰阵容为目标
  // （clubIndex.json 的 peak：TI 冠军阵容，否则最好名次的阵容）。休赛期转会潮 / AI 转会窗口中优先引进、尽量留住使命成员，不保证成功。
  // -------------------------------------------------------------------------
  missions: {
    enabled: true,
    /** 每个窗口每支俱乐部至多引进的使命成员：休赛期转会潮 / AI 季前窗口 / 中期窗口 */
    maxBuys: { shuffle: 2, preseason: 1, midseason: 1 } as Record<'shuffle' | 'preseason' | 'midseason', number>,
    /** 中期窗口向其他 AI 战队求购的概率（自由身的使命成员总会尝试签下） */
    midseasonBuyChance: 0.3,
    /**
     * 求购（溢价）：报价 = 身价 × U(bidFee)；卖家放人概率 = sellBase - 头号选手 sellStarPenalty - 卖家自己的使命成员 sellMissionPenalty
     * + (50 - 归属感)/100 × sellLoyaltyFactor，夹在 [0.02, 0.95]
     */
    bidFee: [1.3, 1.7] as [number, number],
    sellBase: 0.5,
    sellStarPenalty: 0.2,
    sellMissionPenalty: 0.45,
    sellLoyaltyFactor: 0.5,
    /** 资金门槛：付完费用后余额 ≥ (工资 + 新增工资) × budgetRounds（比普通引援宽松） */
    budgetRounds: 3,
    /** 使命成员对本俱乐部的加盟意愿加成（加在 market.playerWillingness 上） */
    willBonus: 0.1,
    /** 使命引进（AI 窗口）的合同 U{signContractSeasons} 个赛季、初始归属感 signLoyalty */
    signContractSeasons: [2, 3] as [number, number],
    signLoyalty: 70,
    /** 转会潮明星去向：使命成员求变时，本俱乐部（使命方）的争夺权重 × starWeightMult */
    starWeightMult: 3,
    /**
     * 留人：转会潮换人候选分 - replaceSticky；求变 / 新挑战 / 老将下放 / 低归属感求去的挂牌概率 × listMult；
     * 被挖角时卖家放人概率 - poachPenalty；合同到期时以 renewChance 概率续约 renewSeasons 个赛季（其余按原规则）
     */
    replaceSticky: 0.8,
    listMult: 0.3,
    poachPenalty: 0.35,
    renewChance: 0.9,
    renewSeasons: [1, 2] as [number, number],
    /** 玩家战队里的使命成员：休赛期按概率向玩家报价（溢价，玩家可拒绝；从不强制带走），每支玩家战队每个休赛期至多 1 份 */
    humanOfferChance: 0.35,
    humanOfferFee: [1.2, 1.5] as [number, number],
  },

  // -------------------------------------------------------------------------
  // 新闻编辑部（news.ts / newsroom.ts）：世界动态、回合要闻、刀塔周报、社区趋势
  // -------------------------------------------------------------------------
  newsroom: {
    /**
     * 新闻条数上限（超出时先删较旧一半中的低价值新闻，再删最旧的）。600 → 900（第六波）：
     * 每赛季约 350~450 条（强队逐场赛果更多），600 条只能保留 1.5 个赛季；900 条约 2 个赛季以上（存档约 +0.15MB）
     */
    maxNews: 900,
    /** 回合要闻：条数区间、入选最低分、同类最多条数 */
    digestMin: 3,
    digestMax: 6,
    digestMinScore: 20,
    /** 不足下限时补位所需的最低基础分（不含加成；八卦、逐场赛果等不补位） */
    digestFillMinScore: 14,
    /** 仍不足下限时的最后补位线（基础分；八卦不补位） */
    digestLastFillMinScore: 6,
    digestPerKindMax: 2,
    /** 一期要闻中同一主角战队（teamIds[0]）最多几条（周报不计） */
    digestPerTeamMax: 2,
    /** 一期要闻中玩家战队自身的新闻最多几条（要闻以世界动态为主） */
    digestMineMax: 2,
    /** 刀塔周报：常规赛每 N 回合一期（赛季初另出休赛期特刊） */
    weeklyEvery: 3,
    powerRankingSize: 10,
    /** 实力榜分 = 战队评分 × (1 + formWeight × (近况 - 0.5))；近况 = 本赛季最近 formEvents 项赛事 (1 - 名次百分位) 的均值 */
    powerFormWeight: 0.12,
    powerFormEvents: 3,
    /** 热门选手：MVP × 此值 + 胜局 */
    hotPlayerMvpWeight: 3,
    /** 近期看点：未来 N 回合内的 TI / Major / 顶级赛事 */
    upcomingRounds: 3,
    upcomingMax: 4,
    /** 转会动态：列出的焦点条数；关注名单：归属感 < loyalty.leaveThreshold + margin 且等级 ≥ minTier 的选手 */
    weeklyTransfersMax: 3,
    rumorLoyaltyMargin: 5,
    rumorMinTier: 'S' as Tier,
    rumorMax: 3,
    /** 知名战队：荣誉排名或实力排名前 N（社区趋势/爆冷只报道知名战队） */
    notableTeams: 12,
    /** 连续早早出局（名次百分位 ≥ slumpPercentile）达到 slumpStreak 项赛事时报道，之后每再 slumpRepeat 项再报道 */
    slumpPercentile: 0.5,
    /** 参赛队数少于此值的赛事不计入连续出局（4 队邀请赛的 3-4 名不算早早出局） */
    slumpMinTeams: 8,
    slumpStreak: 3,
    slumpRepeat: 4,
    /** 连续出局中至少有 N 项是「赛前预期进入前半区」才报道（只报道表现低于预期的队伍） */
    slumpMinDisappointments: 2,
    /** 连冠：同队连续夺冠 ≥ 此数时报道；本赛季冠军数达到里程碑时报道（不含线上公开赛） */
    titleStreakMin: 2,
    seasonTitleMilestones: [3, 5, 8] as number[],
    /** 爆冷：淘汰赛胜者赛前预期名次比败者低 ≥ upsetRankGap；黑马冠军：预期名次 ≥ max(darkHorseRank, 参赛队数 × darkHorseFraction) */
    upsetRankGap: 5,
    darkHorseRank: 5,
    darkHorseFraction: 0.34,
    /** 热门出局：预期前 favoriteTop 名的战队名次百分位 ≥ favoriteCrashPercentile */
    favoriteTop: 2,
    favoriteCrashPercentile: 0.5,
    upsetTiers: ['ti', 'major', 'premier'] as TournamentTier[],
    /** 天梯变动：升至 ≥ tierNewsMin 的等级时报道（SSR 单独成条）；每条最多列出 N 人 */
    tierNewsMin: 'SS' as Tier,
    tierNewsListMax: 6,
    /** 要闻重要度：按标签计分（未打标签的新闻按标题/类别推断标签），另加重要/玩家相关/知名战队加成 */
    tagScore: {
      'ti-champion': 100, disband: 90, champion: 55, weekly: 50, upset: 45, record: 45, 'ti-story': 42,
      scandal: 38, 'big-transfer': 38, patch: 32, season: 30, trend: 30, 'tournament-start': 24, tier: 22,
      'transfer-window': 48, transfer: 15, rumor: 14, result: 12, 'player-event': 12, gossip: 3,
      synergy: 40, // 羁绊觉醒（第十波 #5）
      'new-club': 44, mission: 40, // 新俱乐部成立 / 俱乐部使命（第十波 #2 #3）
    } as Record<string, number>,
    /** 赛事类新闻（带 level:<等级> 标签）按赛事等级缩放；线上公开赛（filler 标签）再 × fillerScoreMult */
    levelScoreMult: { ti: 1, major: 1, premier: 0.8, minor: 0.55, qualifier: 0.5 } as Record<TournamentTier, number>,
    fillerScoreMult: 0.4,
    importantBonus: 10,
    mineBonus: 4,
    notableTeamBonus: 8,
  },
} as const;

export const POSITION_LABEL: Record<Position, string> = {
  C: '1号位 核心', M: '2号位 中单', O: '3号位 劣势路', SS: '4号位 游走辅助', HS: '5号位 保姆辅助',
};
export const POSITION_SHORT: Record<Position, string> = { C: '1', M: '2', O: '3', SS: '4', HS: '5' };
/** 中文数字位置名（新闻 / 位置标签：「Miposhka 转型为五号位」「四号位（可打五号位）」） */
export const POSITION_CN: Record<Position, string> = { C: '一号位', M: '二号位', O: '三号位', SS: '四号位', HS: '五号位' };

export const REGION_LABEL: Record<Region, string> = {
  CN: '中国', SEA: '东南亚', CIS: '独联体/东欧', EU: '西欧', NA: '北美', SA: '南美',
};

export const TOURNAMENT_TIER_LABEL: Record<TournamentTier, string> = {
  ti: 'TI 国际邀请赛', major: 'Major', premier: '顶级赛事', minor: 'Minor', qualifier: '预选赛',
};

/** TI 序号 → 年份 */
export const TI_YEAR: Record<number, number> = {
  1: 2011, 2: 2012, 3: 2013, 4: 2014, 5: 2015, 6: 2016, 7: 2017, 8: 2018,
  9: 2019, 10: 2021, 11: 2022, 12: 2023, 13: 2024, 14: 2025, 15: 2026, 16: 2027,
};
export const MAX_TI = 16;
