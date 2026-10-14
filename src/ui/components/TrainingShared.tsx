// ============================================================================
// 训练相关共用：焦点/记录类型文案、当前训练状态推导、训练赛对手列表、收益表
// （供 Training 页、总览训练卡片 TrainingCard 与 Training* 子组件使用）
// ============================================================================
import type { ReactNode } from 'react';
import {
  CONFIG, POSITIONS, activeTeams, currentPlayerTournament, currentRound, econ, extraTrainingCost, formatGold, getCoach, getPlayerTeam,
  isScrimBooked, scrimCost, scrimInsightMult, scrimMultiplier, teamPlayers, teamRating, trainingBlockReason, trainingRecords,
  trainingSessionsLeft,
} from '../../engine';
import type {
  Coach, GameState, Player, Team, Tournament, TrainingFocus, TrainingGain, TrainingRecord, TrainingRecordKind, RoundInfo,
} from '../../engine';
import { Delta, EmptyState, PlayerLink, PosBadge, cx } from './common';
import { Chip, ROUND_KIND_TEXT, roundKindOf, safe, type ChipTone, type RoundKind } from './SquadShared';

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------
export const FOCUS_ORDER: TrainingFocus[] = ['power', 'mmr', 'insight', 'balanced'];
export const FOCUS_INFO: Record<TrainingFocus, { title: string; icon: string; desc: string; short: string }> = {
  power: { title: '战斗力', icon: '⚔', desc: '对线、补刀与操作特训。战斗力收益最高，兼顾少量天梯与灵性。', short: '主练战斗力，兼顾少量天梯与灵性' },
  mmr: { title: '天梯', icon: '▲', desc: '集中冲分。天梯等级越高，同等战力下的评分倍数越高。', short: '冲天梯分，提高等级评分倍数' },
  insight: { title: '灵性', icon: '✦', desc: '复盘与 BP 研究。提升 BP 推荐质量与大老师胜率，不受年龄压制。', short: '复盘与 BP 研究，不受年龄压制' },
  balanced: { title: '均衡', icon: '◎', desc: '三项各取一半收益，稳健全面，适合没有明显短板的阵容。', short: '三项各取一半，稳健全面' },
};

export const RECORD_KIND_INFO: Record<TrainingRecordKind, { label: string; tone: ChipTone }> = {
  free: { label: '免费训练', tone: 'good' },
  extra: { label: '额外训练', tone: 'gold' },
  scrim: { label: '训练赛', tone: 'info' },
  auto: { label: '自动训练', tone: 'mute' },
};

export function RecordKindChip({ kind }: { kind: TrainingRecordKind }) {
  const info = RECORD_KIND_INFO[kind] ?? RECORD_KIND_INFO.free;
  return <Chip tone={info.tone}>{info.label}</Chip>;
}

export function unavailableReason(kind: RoundKind, tour: Tournament | null): string {
  switch (kind) {
    case 'preseason':
      return '赛季初不能训练：这是新秀抽卡、转会与赛事报名的阶段。点击「开始赛季」进入常规回合后，在休赛回合进行训练。';
    case 'tournament':
      return `本回合参加${tour ? `「${tour.name}」` : '赛事'}，赛事回合无法训练。比赛主要带来荣誉、奖金与韧性（打得越久、赛事越大韧性涨得越多），战力 / 天梯 / 灵性只有少量提升——队员的成长主要靠休赛回合训练。`;
    case 'ti_qualifier':
      return '本回合进行 TI 预选赛，全队全力备战，无法安排训练。';
    case 'ti':
      return '本回合为 TI 正赛，无法安排训练。';
    default:
      return '';
  }
}

/** 记录花费构成（训练赛费用 + 所消耗已购训练的购买价）；免费为空串 */
export function costBreakdown(r: TrainingRecord): string {
  const cost = Math.max(0, r.cost || 0);
  if (cost <= 0) return '';
  const session = Math.min(cost, Math.max(0, r.sessionCost ?? (r.kind === 'scrim' ? 0 : cost)));
  if (r.kind !== 'scrim') return `已购额外训练的购买价 ${formatGold(cost)}`;
  return session > 0 ? `约练 ${formatGold(cost - session)} + 已购额外训练 ${formatGold(session)}` : `约练 ${formatGold(cost)}`;
}

/** 记录时间标签：TI9 · 第3回合 */
export function recordWhen(game: GameState, season: number, round: number): string {
  const R =
    season === game.season?.ti
      ? (game.season.rounds ?? []).filter((r) => r.phase === 'regular').length || CONFIG.calendar.regularRounds
      : CONFIG.calendar.regularRounds;
  const r = round <= 0 ? '赛季初' : round <= R ? `第${round}回合` : round === R + 1 ? 'TI 预选' : 'TI 正赛';
  return `TI${season} · ${r}`;
}

// ---------------------------------------------------------------------------
// 当前训练状态
// ---------------------------------------------------------------------------
export interface TrainingStatus {
  team: Team;
  players: Player[];
  coach: Coach | null;
  kind: RoundKind;
  tour: Tournament | null;
  round: RoundInfo | null;
  roundLabel: string;
  trainable: boolean;
  /** 不可训练时的详细说明（横幅） */
  reason: string;
  /** 不可训练时按钮 title */
  lockTitle: string;
  freeLeft: number;
  extraAvail: number;
  sessionsLeft: number;
  maxExtra: number;
  boughtThisRound: number;
  boughtSeason: number;
  extraCost: number;
  focus: TrainingFocus;
  ownRating: number;
  /** 「开始训练」禁用原因（空 = 可用） */
  trainReason: string;
  /** 「购买额外训练」禁用原因（空 = 可用） */
  buyReason: string;
}

export function trainingStatus(game: GameState): TrainingStatus | null {
  const team = safe(() => getPlayerTeam(game), null as Team | null);
  if (!team) return null;
  const kind = roundKindOf(game);
  const tour = safe(() => currentPlayerTournament(game), null as Tournament | null);
  const seasonEnd = game.phase === 'season_end';
  // 以引擎判定为准（含比赛进行中/游戏结束等情况）；引擎异常时按回合类型兜底
  const fallbackBlock = seasonEnd ? '赛季已结束' : kind === 'rest' || kind === 'ti_watch' ? null : '仅在休赛回合可训练';
  const blockReason = safe(() => trainingBlockReason(game), fallbackBlock);
  const trainable = !blockReason;
  const reason = trainable
    ? ''
    : seasonEnd
      ? '赛季结算中，无法安排训练。进入新赛季后，在休赛回合继续训练。'
      : unavailableReason(kind, tour) || blockReason || '';
  const lockTitle = blockReason ?? '';
  const round = safe(() => currentRound(game), null as RoundInfo | null);
  const R = (game.season.rounds ?? []).filter((r) => r.phase === 'regular').length;
  const phase = round?.phase ?? game.phase;
  const roundLabel =
    game.roundIndex === 0
      ? '赛季初'
      : phase === 'regular'
        ? `常规赛第 ${game.roundIndex}/${R} 回合`
        : phase === 'ti_qualifier'
          ? 'TI 预选回合'
          : phase === 'ti'
            ? 'TI 正赛回合'
            : '赛季结算';

  const players = safe(() => teamPlayers(game, team.id), [] as Player[]);
  // 与引擎一致：每个休赛回合最多 1 次免费训练（freePerRestRound > 0 时）
  const freeLeft = trainable && !game.freeTrainingUsed && CONFIG.training.freePerRestRound > 0 ? 1 : 0;
  const extraAvail = Math.max(0, game.extraTrainingAvailable ?? 0);
  const sessionsLeft = safe(() => trainingSessionsLeft(game), trainable ? freeLeft + extraAvail : 0);
  const maxExtra = CONFIG.training.maxExtraPerRound;
  const boughtThisRound = Math.max(0, game.extraTrainingBoughtThisRound ?? 0);
  const boughtSeason = Math.max(0, game.season.extraTrainingsBought ?? 0);
  const extraCost = safe(() => extraTrainingCost(game), 0);
  const focus: TrainingFocus = game.trainingFocus ?? 'balanced';
  const coach = safe(() => getCoach(game, team.id), null as Coach | null);
  const ownRating = safe(() => teamRating(game, team.id), 0);

  const trainReason = !trainable
    ? lockTitle
    : players.length === 0
      ? '阵容中没有选手'
      : sessionsLeft <= 0
        ? boughtThisRound >= maxExtra
          ? `本回合训练次数已用完（额外训练已达每回合上限 ${maxExtra} 次）`
          : '本回合训练次数已用完，可购买额外训练'
        : '';
  const buyReason = !trainable
    ? lockTitle
    : boughtThisRound >= maxExtra
      ? `本回合额外训练已达上限（${maxExtra} 次）`
      : team.gold < extraCost
        ? `金币不足（需要 ${formatGold(extraCost)}）`
        : '';

  return {
    team, players, coach, kind, tour, round, roundLabel, trainable, reason, lockTitle, freeLeft, extraAvail, sessionsLeft,
    maxExtra, boughtThisRound, boughtSeason, extraCost, focus, ownRating, trainReason, buyReason,
  };
}

export { ROUND_KIND_TEXT };

// ---------------------------------------------------------------------------
// 训练赛对手
// ---------------------------------------------------------------------------
export interface ScrimOption {
  t: Team;
  rating: number;
  /** (对手评分 − 本队评分) / 本队评分 */
  gap: number;
  mult: number;
  cost: number;
  /** 本回合已约过（每支对手每回合限约 CONFIG.training.scrimPerOpponentPerRound 次） */
  booked: boolean;
}

/** 已约过的对手按钮文案 / 说明 */
export const SCRIM_BOOKED_LABEL = '本回合已约过';
export function scrimBookedTitle(name: string): string {
  return `本回合已与 ${name} 约过训练赛：每支战队每回合只能约练 ${scrimPerOpponentLimit()} 次，换个对手或下回合再约`;
}

/** 每支对手每回合的约练上限 */
export function scrimPerOpponentLimit(): number {
  const v = CONFIG.training.scrimPerOpponentPerRound;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** 训练赛灵性额外倍数（交流 BP） */
export function scrimInsightBonus(): number {
  return safe(() => scrimInsightMult(), 1);
}

/** 训练赛规则一句话（倍数区间 + 灵性加成 + 每队每回合限约次数） */
export function scrimRuleText(): string {
  const t = CONFIG.training;
  const ins = scrimInsightBonus();
  return `收益 ×${t.scrimMultMin}~×${t.scrimMultMax}（约弱队也比普通训练高，对手越强越高）`
    + (ins !== 1 ? `，灵性另 ×${ins}（交流 BP）` : '')
    + `；每支战队每回合限约 ${scrimPerOpponentLimit()} 次`;
}

/** 训练赛规则（紧凑版，用于卡片副标题）：倍数区间 · 灵性加成 · 每队每回合限约次数 */
export function scrimRuleShort(): string {
  const t = CONFIG.training;
  const ins = scrimInsightBonus();
  return `收益 ×${t.scrimMultMin}~×${t.scrimMultMax}` + (ins !== 1 ? ` · 灵性另 ×${ins}` : '') + ` · 每队每回合限约 ${scrimPerOpponentLimit()} 次`;
}

/** 全部可约练战队，按评分降序 */
export function scrimOptions(game: GameState, team: Team, ownRating: number): ScrimOption[] {
  const teams = safe(() => activeTeams(game), [] as Team[]).filter((t) => t.id !== team.id && !t.disbanded);
  return teams
    .map((t) => {
      const rating = safe(() => teamRating(game, t.id), 0);
      return {
        t,
        rating,
        gap: ownRating > 0 ? (rating - ownRating) / ownRating : NaN,
        mult: safe(() => scrimMultiplier(game, team.id, t.id), 1),
        cost: safe(() => scrimCost(game, t.id), Math.round(CONFIG.training.scrimBaseCost * safe(() => econ(game), 1))),
        booked: safe(() => isScrimBooked(game, t.id, team.id), false),
      };
    })
    .filter((r) => r.rating > 0)
    .sort((a, b) => b.rating - a.rating);
}

/**
 * 推荐约练对象：收益倍数最高，其次费用最低。凑满 n 个本回合还能约的对手为止；
 * 途中遇到的已约过的对手保留在原位（界面显示为「本回合已约过」并禁用），所以最多返回 n + 已约数 行。
 */
export function suggestedScrims(options: ScrimOption[], n: number): ScrimOption[] {
  const sorted = options.slice().sort((a, b) => b.mult - a.mult || a.cost - b.cost || b.rating - a.rating);
  const out: ScrimOption[] = [];
  let open = 0;
  for (const r of sorted) {
    if (open >= n) break;
    out.push(r);
    if (!r.booked) open++;
  }
  return out;
}

/** 约练按钮禁用原因（空 = 可约）；booked = 本回合已约过该对手 */
export function scrimReason(st: TrainingStatus, cost: number, booked = false, name = '该战队'): string {
  if (!st.trainable) return st.lockTitle || '仅在休赛回合可训练';
  if (booked) return scrimBookedTitle(name);
  if (st.ownRating <= 0) return '首发阵容为空，无法约练';
  if (st.sessionsLeft <= 0) return '没有剩余训练次数（训练赛消耗 1 次训练）';
  if (st.team.gold < cost) return `金币不足（需要 ${formatGold(cost)}）`;
  return '';
}

/** 训练赛倍数的颜色：≥ 同等实力倍数 + 0.5 金色，高于下限正常，处于下限（对手偏弱）淡色 */
export function scrimMultTone(mult: number): string {
  const t = CONFIG.training;
  return mult >= t.scrimMultBase + 0.5 ? 'text-gold' : mult > t.scrimMultMin + 1e-6 ? 'text-ink' : 'text-mute';
}

/** 训练赛记录的灵性额外倍数（旧记录缺省 = 1） */
export function recordInsightMult(r: TrainingRecord): number {
  return r.kind === 'scrim' && Number.isFinite(r.insightMult) && (r.insightMult as number) > 0 ? (r.insightMult as number) : 1;
}

// ---------------------------------------------------------------------------
// 收益
// ---------------------------------------------------------------------------
export type GainKey = 'power' | 'mmr' | 'insight' | 'talent' | 'resilience';
export const GAIN_KEYS: GainKey[] = ['power', 'mmr', 'insight', 'talent', 'resilience'];
export const GAIN_LABEL: Record<GainKey, string> = { power: '战力', mmr: '天梯', insight: '灵性', talent: '天赋', resilience: '韧性' };
export const GAIN_DIGITS: Record<GainKey, number> = { power: 2, mmr: 0, insight: 2, talent: 2, resilience: 2 };

export function sumGains(gains: TrainingGain[]): Record<GainKey, number> {
  const out: Record<GainKey, number> = { power: 0, mmr: 0, insight: 0, talent: 0, resilience: 0 };
  for (const g of gains) for (const k of GAIN_KEYS) out[k] += Number.isFinite(g[k]) ? g[k] : 0;
  return out;
}

/** 本回合（当前赛季、当前回合）的训练记录，最新在前 */
export function roundRecords(game: GameState): TrainingRecord[] {
  const list = safe(() => trainingRecords(game), [] as TrainingRecord[]);
  const out: TrainingRecord[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r || r.season !== game.season.ti || r.round !== game.roundIndex) break;
    out.push(r);
  }
  return out;
}

/** 每名选手一次训练的收益表（含合计行） */
export function GainsTable({
  game,
  gains,
  compact,
  showCurrent = true,
  showRole = true,
  empty,
}: {
  game: GameState;
  gains: TrainingGain[];
  compact?: boolean;
  showCurrent?: boolean;
  /** 显示「首发/替补」列（按当前阵容；历史记录不显示，避免误导） */
  showRole?: boolean;
  empty?: ReactNode;
}) {
  if (gains.length === 0) return <EmptyState text={empty ?? '本次没有队员获得属性变化。'} />;
  const team = game.teams[game.settings.playerTeamId];
  const starters = new Set(POSITIONS.map((p) => team?.lineup?.[p]).filter(Boolean) as string[]);
  const total = sumGains(gains);
  const keys: GainKey[] = compact ? ['power', 'mmr', 'insight'] : GAIN_KEYS;
  const role = !compact && showRole;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>选手</th>
            {role && <th>角色</th>}
            {keys.map((k) => (
              <th key={k} className="num">
                Δ{GAIN_LABEL[k]}
              </th>
            ))}
            {showCurrent && <th className="num">当前战力</th>}
            {showCurrent && <th className="num">当前天梯</th>}
          </tr>
        </thead>
        <tbody>
          {gains.map((g) => {
            const p = game.players[g.playerId];
            const onTeam = !!p && p.teamId === game.settings.playerTeamId;
            return (
              <tr key={g.playerId}>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    {p ? <PosBadge pos={p.position} /> : null}
                    {p ? <PlayerLink player={p} /> : <span className="text-mute">{g.handle}</span>}
                    {p && !onTeam && <span className="text-[10px] text-faint">已离队</span>}
                  </span>
                </td>
                {role && <td>{starters.has(g.playerId) ? <Chip tone="gold">首发</Chip> : <Chip>替补</Chip>}</td>}
                {keys.map((k) => (
                  <td key={k} className="num">
                    <Delta value={g[k]} digits={GAIN_DIGITS[k]} />
                  </td>
                ))}
                {showCurrent && <td className="num text-mute">{p ? p.power.toFixed(1) : '—'}</td>}
                {showCurrent && <td className="num text-mute">{p ? Math.round(p.mmr) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className="px-2.5 py-2 text-mute">合计</td>
            {role && <td />}
            {keys.map((k) => (
              <td key={k} className="num px-2.5">
                <Delta value={total[k]} digits={GAIN_DIGITS[k]} />
              </td>
            ))}
            {showCurrent && <td />}
            {showCurrent && <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** 训练次数小结：剩余 N（免费 x · 已购 y） */
export function SessionsText({ st, className }: { st: TrainingStatus; className?: string }) {
  return (
    <span className={cx('text-sm text-mute', className)}>
      剩余 <b className={cx('tabular text-base', st.sessionsLeft > 0 ? 'text-good' : 'text-faint')}>{st.sessionsLeft}</b> 次
      <span className="ml-1 text-xs text-faint">
        （免费 {st.freeLeft} · 已购 {st.extraAvail}）
      </span>
    </span>
  );
}
