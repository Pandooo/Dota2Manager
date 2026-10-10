// 财务：资金概况、选手奖金分成、收入来源 / 支出构成、每回合收支与赛季预测、经常性收入明细、赛事奖金（真实奖池 vs 游戏内发放）、工资表、账目明细
import { useState } from 'react';
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, TOURNAMENT_TIER_LABEL, activeMerchBoosts, awardedPrize, awardedPrizePool, econ, formatGold, formatPrizeShare, getCoach,
  isFillerCup, lineupPlayers, playerTier, prizeShareOf, prizeSharePreview, prizeShareStatus, qualifierAppearanceFee, regularRoundCount,
  roundWageBill, seasonProjection, sponsorContract, teamPlayers, tournamentAppearanceFee,
  type FinanceEntry, type GameState, type Player, type PlayerEntryStatus, type Tournament,
} from '../../engine';
import {
  Badge, Button, Card, Delta, EmptyState, Gold, Hint, PlayerLink, PosBadge, Stat, TierBadge, cx,
} from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import { ConfirmButton } from '../components/ConfirmPopover';
import { Banner, Field, Pager, Select, TableWrap, TextInput, num, safe, usePaged } from '../components/MarketKit';
import {
  GoldLineChart, RoundPnlChart, SourceBreakdown, type PnlRow, type SeriesPoint, type SourceItem,
} from '../components/MarketCharts';

type Category = FinanceEntry['category'];

const CATEGORY_LABEL: Record<Category, string> = {
  sponsor: '赞助',
  streaming: '直播与内容',
  merch: '周边',
  prize: '奖金',
  appearance: '出场费',
  salary: '工资',
  coach_salary: '教练工资',
  transfer_in: '转会支出',
  transfer_out: '转会收入',
  signing: '签约费',
  training: '训练',
  scrim: '训练赛',
  gacha: '抽卡（旧存档）',
  temp_sub: '临时替补',
  event: '事件',
  other: '其他',
};
/** 账目筛选的展示顺序：收入类在前 */
const CATEGORY_ORDER: Category[] = [
  'sponsor', 'streaming', 'merch', 'prize', 'appearance', 'transfer_out', 'event', 'salary', 'coach_salary', 'transfer_in',
  'signing', 'training', 'scrim', 'gacha', 'temp_sub', 'other',
];

/** 收入来源（分类色按固定顺序分配，已在暗色面板背景上做过色觉校验；「事件与其他」为中性灰） */
type IncomeSource = 'sponsor' | 'streaming' | 'merch' | 'prize' | 'appearance' | 'transfer' | 'misc';
const INCOME_SOURCES: { key: IncomeSource; label: string; color: string }[] = [
  { key: 'sponsor', label: '赞助', color: '#3987e5' },
  { key: 'streaming', label: '直播与内容', color: '#d95926' },
  { key: 'merch', label: '周边', color: '#199e70' },
  { key: 'prize', label: '赛事奖金', color: '#c98500' },
  { key: 'appearance', label: '出场费', color: '#d55181' },
  { key: 'transfer', label: '出售选手', color: '#9085e9' },
  { key: 'misc', label: '事件与其他', color: '#6b7385' },
];
function incomeSourceOf(c: Category): IncomeSource {
  switch (c) {
    case 'sponsor':
    case 'streaming':
    case 'merch':
    case 'prize':
    case 'appearance':
      return c;
    case 'transfer_in':
    case 'transfer_out':
      return 'transfer';
    default:
      return 'misc';
  }
}

/** 支出构成（单色条按金额排序） */
type ExpenseGroup = 'salary' | 'coach' | 'transfer' | 'training' | 'gacha' | 'temp_sub' | 'misc';
const EXPENSE_LABEL: Record<ExpenseGroup, string> = {
  salary: '选手工资',
  coach: '教练工资',
  transfer: '转会与签约',
  training: '额外训练与训练赛',
  gacha: '抽卡（旧存档）',
  temp_sub: '临时替补',
  misc: '事件与其他',
};
function expenseGroupOf(c: Category): ExpenseGroup {
  switch (c) {
    case 'salary':
      return 'salary';
    case 'coach_salary':
      return 'coach';
    case 'transfer_in':
    case 'transfer_out':
    case 'signing':
      return 'transfer';
    case 'training':
    case 'scrim':
      return 'training';
    case 'gacha':
      return 'gacha';
    case 'temp_sub':
      return 'temp_sub';
    default:
      return 'misc';
  }
}

/** 分类中文名：引擎中 transfer_in = 买入选手（支出）、transfer_out = 卖出选手（收入），按金额方向兜底 */
function categoryLabel(c: string, amount?: number): string {
  if ((c === 'transfer_in' || c === 'transfer_out') && amount !== undefined) return amount >= 0 ? '转会收入' : '转会支出';
  return CATEGORY_LABEL[c as Category] ?? '其他';
}

const ENTRY_STATUS_LABEL: Record<PlayerEntryStatus, string> = {
  invited: '受邀', registered: '已报名', open: '可报名', locked: '不可报名', declined: '已婉拒',
};

function roundLabelOf(g: GameState) {
  const curR = safe(() => regularRoundCount(g.season), CONFIG.calendar.regularRounds);
  return (season: number, round: number): string => {
    const R = season === g.season.ti ? curR : CONFIG.calendar.regularRounds;
    if (round <= 0) return '赛季初';
    if (round <= R) return `第 ${round} 回合`;
    if (round === R + 1) return 'TI 预选';
    return 'TI 正赛';
  };
}

function shortRoundOf(g: GameState) {
  const curR = safe(() => regularRoundCount(g.season), CONFIG.calendar.regularRounds);
  return (season: number, round: number): string => {
    const R = season === g.season.ti ? curR : CONFIG.calendar.regularRounds;
    if (round <= 0) return '初';
    if (round <= R) return String(round);
    if (round === R + 1) return '预';
    return 'TI';
  };
}

const PAGE = 25;

export default function Finance() {
  const g = useGame();
  const setView = useGameStore((s) => s.setView);
  const me = g.settings.playerTeamId;
  const team = g.teams[me];
  const ti = g.season.ti;

  const ledgerAll: FinanceEntry[] = Array.isArray(g.finance) ? g.finance.filter((e) => e && Number.isFinite(e.amount)) : [];
  const seasons = Array.from(new Set([ti, ...ledgerAll.map((e) => e.season)])).sort((a, b) => b - a);
  // 默认看本赛季；赛季初本赛季尚无账目时默认看最近有账目的赛季
  const [scope, setScope] = useState<string>(() =>
    String(ledgerAll.some((x) => x.season === ti) ? ti : seasons.find((s) => ledgerAll.some((x) => x.season === s)) ?? ti),
  );
  const [cat, setCat] = useState<'all' | Category>('all');
  const [dir, setDir] = useState<'all' | 'in' | 'out'>('all');
  const [q, setQ] = useState('');
  const [eventFilter, setEventFilter] = useState<'mine' | 'all'>('mine');

  const roundLabel = roundLabelOf(g);
  const shortRound = shortRoundOf(g);

  const gold = num(team?.gold);
  const e = safe(() => econ(g), 1);
  const wage = safe(() => roundWageBill(g, me), 0);
  const coach = safe(() => getCoach(g, me), null);
  const coachWage = coach ? num(coach.salary) : 0;
  const totalRounds = g.season.rounds?.length ?? CONFIG.calendar.regularRounds + 3;
  const paidRounds = Math.max(1, totalRounds - 1);
  /** 资金可支撑的付薪回合数（资金为负时为 0） */
  const runway = wage > 0 ? Math.max(0, Math.floor(gold / wage)) : null;

  // 本赛季经营预测（经常性收入 − 工资；不含奖金、出场费、转会、训练）
  const proj = team ? safe(() => seasonProjection(g, me), null) : null;
  const sponsor = team ? safe(() => sponsorContract(g, team), null) : null;
  const boosts = team ? safe(() => activeMerchBoosts(team), []) : [];
  const per = proj?.perRound;
  const recurring = per?.total ?? 0;
  const operatingNet = recurring - wage;

  // 范围内账目
  const scoped = scope === 'all' ? ledgerAll : ledgerAll.filter((x) => String(x.season) === scope);
  const income = scoped.filter((x) => x.amount > 0).reduce((s, x) => s + x.amount, 0);
  const expense = scoped.filter((x) => x.amount < 0).reduce((s, x) => s - x.amount, 0);
  const net = income - expense;
  const scopeLabel = scope === 'all' ? '全部赛季' : `TI${scope}`;

  // 收入来源 / 支出构成
  const incomeBy = new Map<IncomeSource, number>();
  const expenseBy = new Map<ExpenseGroup, number>();
  for (const x of scoped) {
    const c = (CATEGORY_LABEL[x.category] ? x.category : 'other') as Category;
    if (x.amount > 0) incomeBy.set(incomeSourceOf(c), (incomeBy.get(incomeSourceOf(c)) ?? 0) + x.amount);
    else expenseBy.set(expenseGroupOf(c), (expenseBy.get(expenseGroupOf(c)) ?? 0) - x.amount);
  }
  const incomeItems: SourceItem[] = INCOME_SOURCES.map((s) => ({ key: s.key, label: s.label, color: s.color, value: incomeBy.get(s.key) ?? 0 }));
  const recurringIncome = (incomeBy.get('sponsor') ?? 0) + (incomeBy.get('streaming') ?? 0) + (incomeBy.get('merch') ?? 0);
  const eventIncome = (incomeBy.get('prize') ?? 0) + (incomeBy.get('appearance') ?? 0);
  const expenseRows = (Object.keys(EXPENSE_LABEL) as ExpenseGroup[])
    .map((k) => ({ key: k, label: EXPENSE_LABEL[k], value: expenseBy.get(k) ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const expenseMax = Math.max(1, ...expenseRows.map((r) => r.value));
  const topIncome = incomeItems.slice().sort((a, b) => b.value - a.value)[0];
  const topExpense = expenseRows[0];

  // 每回合收支（单个赛季；「全部赛季」时看本赛季）。本赛季未来回合按经营预测补齐（经常性收入 vs 工资）
  const pnlSeason = scope === 'all' ? ti : Number(scope);
  const pnlRows: PnlRow[] = [];
  {
    const bucket = new Map<number, { income: number; expense: number; parts: Map<string, number> }>();
    for (const x of ledgerAll) {
      if (x.season !== pnlSeason) continue;
      const b = bucket.get(x.round) ?? { income: 0, expense: 0, parts: new Map<string, number>() };
      if (x.amount > 0) b.income += x.amount;
      else b.expense -= x.amount;
      const label = categoryLabel(x.category, x.amount);
      b.parts.set(label, (b.parts.get(label) ?? 0) + x.amount);
      bucket.set(x.round, b);
    }
    const lastRound = pnlSeason === ti ? totalRounds - 1 : Math.max(0, ...Array.from(bucket.keys()));
    for (let r = 0; r <= lastRound; r++) {
      const b = bucket.get(r);
      const future = pnlSeason === ti && (r > g.roundIndex || (r === g.roundIndex && r >= 1 && !b?.parts.has('工资')));
      if (future && per && r >= 1) {
        // 预测：本回合结束时结算的经常性收入（周边热度按剩余回合）− 工资；本回合已有账目时叠加
        const boost = boosts.reduce((a, x) => a + (r - Math.max(1, g.roundIndex) < x.roundsLeft ? x.perRound : 0), 0);
        const inc = per.sponsor + per.streaming + (per.merch - per.merchBoost) + boost;
        pnlRows.push({
          key: `p${r}`,
          label: roundLabel(pnlSeason, r),
          short: shortRound(pnlSeason, r),
          income: inc + (b?.income ?? 0),
          expense: wage + (b?.expense ?? 0),
          projected: true,
          parts: [
            { label: '赞助', amount: per.sponsor },
            { label: '直播与内容', amount: per.streaming },
            { label: '周边', amount: per.merch - per.merchBoost + boost },
            { label: '工资（预计）', amount: -wage },
            ...Array.from(b?.parts.entries() ?? []).map(([label, amount]) => ({ label, amount })),
          ],
        });
        continue;
      }
      if (!b) {
        if (r === 0) continue;
        pnlRows.push({ key: `r${r}`, label: roundLabel(pnlSeason, r), short: shortRound(pnlSeason, r), income: 0, expense: 0 });
        continue;
      }
      pnlRows.push({
        key: `r${r}`,
        label: roundLabel(pnlSeason, r),
        short: shortRound(pnlSeason, r),
        income: b.income,
        expense: b.expense,
        parts: Array.from(b.parts.entries())
          .map(([label, amount]) => ({ label, amount }))
          .sort((a2, b2) => Math.abs(b2.amount) - Math.abs(a2.amount)),
      });
    }
  }

  // 资金曲线
  const hist: SeriesPoint[] = (g.history?.gold ?? [])
    .filter((p) => p && Number.isFinite(p.value))
    .map((p) => ({ season: p.season, round: p.round, value: p.value }));
  // 追加「当前」点：快照在回合结束时记录，本回合内的收支（如赛季初签约、转会）尚未入档；
  // 与最后快照同一回合时覆盖其值，避免出现两个同名的点
  const lastH = hist[hist.length - 1];
  if (lastH && lastH.season === ti && lastH.round === g.roundIndex) lastH.value = gold;
  else hist.push({ season: ti, round: g.roundIndex, value: gold });
  const peak = hist.reduce((m, p) => Math.max(m, p.value), -Infinity);
  const low = hist.reduce((m, p) => Math.min(m, p.value), Infinity);

  // 本赛季赛事奖金：真实奖池（美元）vs 游戏内发放
  const seasonEvents = (g.seasonTournamentIds ?? [])
    .map((id) => g.tournaments[id])
    .filter((t): t is Tournament => !!t && t.season === ti && num(t.prizePool) > 0)
    .filter((t) => eventFilter === 'all' || t.playerStatus === 'invited' || t.playerStatus === 'registered' || t.teamIds.includes(me))
    .sort((a, b) => a.roundIndex - b.roundIndex || b.prizePool - a.prizePool);

  // 工资表
  const roster = safe(() => teamPlayers(g, me), [] as Player[]);
  const starters = new Set(
    safe(() => lineupPlayers(g, me), [] as { player: Player | null }[]).map((s) => s.player?.id).filter(Boolean) as string[],
  );
  const wageRows = roster.slice().sort((a, b) => num(b.salary) - num(a.salary));
  const wageMax = Math.max(1, ...wageRows.map((p) => num(p.salary)), coachWage);
  const seasonGoldStart = g.season.goldStart;

  // 账目明细
  const needle = q.trim().toLowerCase();
  const ledger = scoped
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => (cat === 'all' || x.category === cat) && (dir === 'all' || (dir === 'in' ? x.amount > 0 : x.amount < 0)))
    .filter(({ x }) => !needle || (x.note ?? '').toLowerCase().includes(needle))
    .reverse();
  const paged = usePaged(ledger, PAGE, `${scope}|${cat}|${dir}|${needle}`);

  if (!team) {
    return (
      <>
        <ScreenHeader title="财务" />
        <EmptyState text="找不到你的战队数据。">
          <Button onClick={() => setView('dashboard')}>返回总览</Button>
        </EmptyState>
      </>
    );
  }

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="财务"
        subtitle={`TI${ti} · ${g.season.year} 年 · 年代经济指数 ×${e.toFixed(2)}（工资、费用与各项收入随年代缩放）`}
        actions={
          <Field label="统计范围" className="min-w-36">
            <Select value={scope} onChange={(ev) => setScope(ev.target.value)}>
              {seasons.map((s) => (
                <option key={s} value={String(s)}>TI{s}{s === ti ? '（本赛季）' : ''}</option>
              ))}
              <option value="all">全部赛季</option>
            </Select>
          </Field>
        }
      />

      {gold < 0 && (
        <Banner tone="bad" title="俱乐部资金为负">
          资金不足以支付工资将触发欠薪事件（荣誉下降、全员归属感下降，甚至有人离队）。考虑出售选手、减少训练开支或参加更多赛事获取奖金与出场费。
        </Banner>
      )}
      {gold >= 0 && runway !== null && runway < 3 && (
        <Banner tone="warn" title={`资金仅够支付约 ${runway} 回合工资`}>
          每回合工资 {formatGold(wage)}，经常性收入 {formatGold(recurring)}，建议尽快开源节流，避免欠薪。
        </Banner>
      )}
      {gold >= 0 && proj && proj.projectedEnd < 0 && (runway === null || runway >= 3) && (
        <Banner tone="warn" title="按当前收支，赛季末资金将转负">
          只计赞助、直播与周边收入和工资，预计赛季末资金 {formatGold(proj.projectedEnd)}。需要靠赛事奖金、出场费或出售选手填补缺口，额外训练与训练赛请量力而行（不需要的选秀新秀可在赛季初免费放弃）。
        </Banner>
      )}

      {/* 概况 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="当前金币"
          value={<Gold value={gold} />}
          hint={seasonGoldStart !== undefined ? <>较赛季初 <span className={cx('tabular', gold - seasonGoldStart >= 0 ? 'text-good' : 'text-bad')}>{gold - seasonGoldStart >= 0 ? '+' : ''}{formatGold(gold - seasonGoldStart)}</span></> : undefined}
        />
        <Stat
          label="每回合经常性收入"
          value={<span className="text-good">+{formatGold(recurring)}</span>}
          hint={per ? `赞助 ${formatGold(per.sponsor)} · 直播 ${formatGold(per.streaming)} · 周边 ${formatGold(per.merch)}` : undefined}
        />
        <Stat
          label="每回合工资"
          value={<span className="text-bad">-{formatGold(wage)}</span>}
          hint={`选手 ${formatGold(wage - coachWage)} · 教练 ${formatGold(coachWage)}`}
        />
        <Stat
          label="每回合经营净额"
          value={<span className={operatingNet >= 0 ? 'text-good' : 'text-bad'}>{operatingNet >= 0 ? '+' : ''}{formatGold(operatingNet)}</span>}
          hint={runway === null ? '无工资支出' : <>资金可支付 <span className={cx('tabular', runway < 3 && 'text-bad')}>{runway}</span> 回合工资</>}
        />
        <Stat
          label="预计赛季末资金"
          value={proj ? <Gold value={proj.projectedEnd} /> : '—'}
          hint={proj ? `剩余 ${proj.roundsLeft} 个付薪回合 · 不含奖金/出场费/转会` : undefined}
        />
        <Stat
          label={`净收支 · ${scopeLabel}`}
          value={<span className={net > 0 ? 'text-good' : net < 0 ? 'text-bad' : 'text-ink'}>{net > 0 ? '+' : ''}{formatGold(net)}</span>}
          hint={`收入 ${formatGold(income)} · 支出 ${formatGold(expense)}`}
        />
      </div>

      {/* 选手奖金分成（第九波） */}
      <PrizeShareCard g={g} me={me} roundLabel={roundLabel} />

      {/* 收入来源 + 支出构成 + 经营预测 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card
          title="收入来源"
          subtitle={income > 0 ? `${scopeLabel} · 经常性收入 ${formatGold(recurringIncome)} · 赛事收入 ${formatGold(eventIncome)}` : scopeLabel}
        >
          <SourceBreakdown
            items={incomeItems}
            unitLabel={`${scopeLabel} 总收入${topIncome && topIncome.value > 0 ? ` · 最大来源：${topIncome.label}` : ''}`}
            emptyText={`${scopeLabel} 暂无收入记录（经常性收入在每回合结束时入账）`}
          />
        </Card>
        <Card title="支出构成" subtitle={expense > 0 ? `${scopeLabel} · 最大开销：${topExpense?.label ?? '—'}` : scopeLabel}>
          {expenseRows.length === 0 ? (
            <div className="py-8 text-center text-sm text-mute">{scopeLabel} 暂无支出记录</div>
          ) : (
            <div>
              <div className="mb-2 flex items-baseline justify-between text-xs text-mute">
                <span>{scopeLabel} 总支出</span>
                <span className="tabular text-sm font-semibold text-ink">{formatGold(expense)}</span>
              </div>
              <div className="space-y-1.5">
                {expenseRows.map((r) => (
                  <div key={r.key} className="grid grid-cols-[minmax(0,7.5rem)_1fr_auto_40px] items-center gap-x-2 text-xs">
                    <span className="truncate text-ink/90">{r.label}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-panel-3">
                      <div className="h-full rounded-full bg-bad/70" style={{ width: `${Math.max(2, (r.value / expenseMax) * 100)}%` }} />
                    </div>
                    <span className="tabular text-ink">{formatGold(r.value)}</span>
                    <span className="text-right tabular text-mute">{Math.round((r.value / Math.max(1, expense)) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
        <Card title="本赛季经营预测" subtitle={proj ? `剩余 ${proj.roundsLeft} 个付薪回合（每回合结束先收入后发工资）` : undefined}>
          {proj && per ? (
            <div className="space-y-2 text-xs">
              <ForecastRow
                label="赞助"
                badge={sponsor ? (sponsor.signed ? sponsor.level : `${sponsor.level} · 待签约`) : undefined}
                perRound={per.sponsor}
                total={proj.sponsorTotal}
                note={sponsor?.signed ? '本赛季合同，赛季内固定' : '赛季内首次结算时按荣誉与上赛季排名签约'}
              />
              <ForecastRow
                label="直播与内容"
                perRound={per.streaming}
                total={proj.streamingTotal}
                note="随签约选手天梯等级（明星效应）与荣誉浮动"
              />
              <ForecastRow
                label="周边"
                perRound={per.merch}
                total={proj.merchTotal}
                note={boosts.length ? `含赛事热度：${boosts.map((b) => `${b.source} 余 ${b.roundsLeft} 回合`).join('、')}` : '随荣誉增长；夺冠、Major 亚军、TI 前四名后数回合热销'}
              />
              <ForecastRow label="工资" perRound={-wage} total={-proj.wageTotal} note="选手 + 教练，每回合支付" />
              <div className="flex items-center justify-between border-t border-line pt-2">
                <span className="text-mute">预计赛季末资金</span>
                <span className="text-sm font-semibold"><Gold value={proj.projectedEnd} /></span>
              </div>
              <Hint>
                预测只含经常性收入与工资；赛事奖金、出场费、转会、额外训练与训练赛都会在此基础上增减。
              </Hint>
            </div>
          ) : (
            <EmptyState text="暂无预测数据。" />
          )}
        </Card>
      </div>

      {/* 每回合收支 + 资金曲线 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="每回合收支"
          subtitle={`TI${pnlSeason}${pnlSeason === ti ? ' · 半透明虚线为按当前收支预测的未来回合' : ''} · 圆点为净额`}
        >
          {pnlRows.length === 0 ? <EmptyState text="推进回合后将在此记录每回合收支。" /> : <RoundPnlChart rows={pnlRows} />}
        </Card>
        <Card
          title="资金曲线"
          subtitle={hist.length > 1 ? `峰值 ${formatGold(peak)} · 低谷 ${formatGold(low)} · 共 ${hist.length} 个回合快照` : '每回合结束时记录一次资金'}
        >
          {hist.length < 2 ? <EmptyState text="推进回合后将在此记录资金变化。" /> : <GoldLineChart points={hist} roundLabel={roundLabel} />}
        </Card>
      </div>

      {/* 钱从哪里来 */}
      <Card title="钱从哪里来">
        <div className="grid gap-x-6 gap-y-2 text-xs leading-relaxed text-mute md:grid-cols-2">
          <p><span className="font-semibold text-ink">赞助</span>：赛季内首次结算时按俱乐部荣誉与上赛季排名签订合同，整个赛季每回合固定支付，下赛季重新谈判。</p>
          <p><span className="font-semibold text-ink">直播与内容</span>：明星效应——签约选手天梯等级越高（首发全额、替补减半）、荣誉越高，收入越多。</p>
          <p><span className="font-semibold text-ink">周边</span>：随荣誉稳定增长；赛事夺冠、Major 亚军、TI 前四名后的若干回合热销加成。</p>
          <p><span className="font-semibold text-ink">赛事奖金</span>：赛程显示真实奖金池（美元），实际发放按年代与赛事等级换算的游戏内奖金，正赛所有名次都有奖金，TI 冠军最为丰厚。奖金按「选手奖金分成」比例分给队员，俱乐部只保留剩余部分。</p>
          <p><span className="font-semibold text-ink">出场费</span>：进入正赛的队伍按赛事等级领取；封闭预选赛出局也有少量参赛补贴。</p>
          <p><span className="font-semibold text-ink">其他</span>：出售选手、随机事件（赞助注资、直播合约等）。支出主要是每回合工资，以及签约/转会、额外训练、训练赛与临时替补。</p>
        </div>
      </Card>

      {/* 赛事奖金 */}
      <Card
        title="本赛季赛事奖金"
        subtitle="奖池为真实奖金（美元，仅展示）；实际发放为游戏内奖金"
        actions={
          <Select value={eventFilter} onChange={(ev) => setEventFilter(ev.target.value as 'mine' | 'all')}>
            <option value="mine">已报名 / 受邀</option>
            <option value="all">全部赛事</option>
          </Select>
        }
        bodyClassName="p-0"
      >
        {seasonEvents.length === 0 ? (
          <EmptyState text={eventFilter === 'mine' ? '本赛季尚未报名或受邀任何有奖金的赛事。可切换为「全部赛事」查看。' : '本赛季没有有奖金的赛事。'} />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>回合</th>
                  <th className="w-full">赛事</th>
                  <th>状态</th>
                  <th className="num" title="真实奖金池（美元），仅展示">奖池（真实）</th>
                  <th className="num" title="游戏内实际发放的奖金池">游戏内发放</th>
                  <th className="num">冠军奖金</th>
                  <th className="num" title="正赛队伍出场费 / 封闭预选出局补贴">出场费</th>
                  <th className="num" title="俱乐部实得：名次奖金扣除队员分成 + 出场费">本队所得</th>
                </tr>
              </thead>
              <tbody>
                {seasonEvents.map((t) => {
                  const size = Math.max(1, num(t.size, t.teamIds.length || 8));
                  const pool = safe(() => awardedPrizePool(g, t), 0);
                  const champ = safe(() => awardedPrize(g, t, size, 1, 1), 0);
                  const fee = safe(() => tournamentAppearanceFee(g, t), 0);
                  const qFee = safe(() => qualifierAppearanceFee(g, t), 0);
                  const st = t.status === 'finished' ? t.settlement : undefined;
                  // 俱乐部实得：奖金扣除队员分成（旧存档无拆分 = 全归俱乐部）+ 出场费
                  const mine = st ? num(st.prizeClub, num(st.prize)) + num(st.appearanceFee) : null;
                  const mineTitle = st && num(st.prize) > 0
                    ? `奖金 ${formatGold(num(st.prize))}（俱乐部 ${formatGold(num(st.prizeClub, num(st.prize)))} / 队员 ${formatGold(num(st.prizePlayers))}）+ 出场费 ${formatGold(num(st.appearanceFee))}`
                    : undefined;
                  const active = t.playerStatus === 'invited' || t.playerStatus === 'registered';
                  const filler = safe(() => isFillerCup(t), false);
                  return (
                    <tr key={t.id}>
                      <td className="text-xs text-mute">{roundLabel(ti, t.roundIndex)}</td>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{t.name}</span>
                          <Badge>{TOURNAMENT_TIER_LABEL[t.tier] ?? t.tier}</Badge>
                        </div>
                      </td>
                      <td>
                        <Badge className={active ? 'bg-info/15 text-info' : undefined}>
                          {t.status === 'finished' ? '已结束' : ENTRY_STATUS_LABEL[t.playerStatus] ?? '—'}
                        </Badge>
                      </td>
                      <td className="num text-xs text-mute tabular" title={filler ? '线上公开赛为补位赛事，没有真实奖金池' : '真实奖金池（美元）'}>
                        {filler ? '—' : `$${formatGold(num(t.prizePool))}`}
                      </td>
                      <td className="num"><Gold value={pool} /></td>
                      <td className="num"><Gold value={champ} /></td>
                      <td className="num text-xs" title={qFee > 0 ? `封闭预选出局补贴 ${formatGold(qFee)}` : undefined}>
                        <Gold value={fee} />
                      </td>
                      <td className="num" title={mineTitle}>{mine === null ? <span className="text-faint">—</span> : <Gold value={mine} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {/* 工资表 */}
      <Card
        title="工资表"
        subtitle={`${roster.length} 名选手${coach ? ' + 1 名教练' : ''} · 每回合合计 ${formatGold(wage)} · 本赛季约 ${paidRounds} 个付薪回合`}
        actions={<Button size="sm" variant="ghost" onClick={() => setView('squad')}>管理阵容</Button>}
        bodyClassName="p-0"
      >
        {roster.length === 0 && !coach ? (
          <EmptyState text="队中没有签约选手或教练。" />
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>角色</th>
                  <th>等级</th>
                  <th className="num">工资/回合</th>
                  <th className="w-[28%]">占工资总额</th>
                  <th className="num" title={`按 ${paidRounds} 个付薪回合估算`}>赛季合计</th>
                  <th className="num">合同到期</th>
                </tr>
              </thead>
              <tbody>
                {wageRows.map((p) => {
                  const s = num(p.salary);
                  const share = wage > 0 ? s / wage : 0;
                  const role = p.tempSubUntilTournament ? '临时替补' : starters.has(p.id) ? '首发' : '替补';
                  const expiring = num(p.contractUntil) <= ti;
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="flex items-center gap-1.5">
                          <PlayerLink player={p} />
                          <PosBadge pos={p.position} />
                          {p.isRookie && <span className="text-[10px] text-faint">新秀</span>}
                        </div>
                      </td>
                      <td>
                        <Badge className={role === '首发' ? 'bg-info/15 text-info' : role === '临时替补' ? 'bg-gold/15 text-gold' : undefined}>
                          {role}
                        </Badge>
                      </td>
                      <td><TierBadge tier={playerTier(p)} /></td>
                      <td className="num"><Gold value={s} /></td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
                            <div className="h-full rounded-full bg-gold/80" style={{ width: `${(s / wageMax) * 100}%` }} />
                          </div>
                          <span className="w-10 text-right text-[11px] tabular text-mute">{Math.round(share * 100)}%</span>
                        </div>
                      </td>
                      <td className="num text-mute"><Gold value={s * paidRounds} /></td>
                      <td className={cx('num text-xs', expiring ? 'text-gold' : 'text-mute')} title={expiring ? '本赛季结束后到期，需续约' : undefined}>
                        TI{p.contractUntil}{expiring ? ' ⚑' : ''}
                      </td>
                    </tr>
                  );
                })}
                {coach && (
                  <tr>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <button className="cursor-pointer font-medium hover:text-gold hover:underline" onClick={() => setView('coach')}>
                          {coach.name}
                        </button>
                      </div>
                    </td>
                    <td><Badge className="bg-dota/20 text-dota-2">主教练</Badge></td>
                    <td><TierBadge tier={coach.tier} /></td>
                    <td className="num"><Gold value={coachWage} /></td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
                          <div className="h-full rounded-full bg-dota-2/80" style={{ width: `${(coachWage / wageMax) * 100}%` }} />
                        </div>
                        <span className="w-10 text-right text-[11px] tabular text-mute">{wage > 0 ? Math.round((coachWage / wage) * 100) : 0}%</span>
                      </div>
                    </td>
                    <td className="num text-mute"><Gold value={coachWage * paidRounds} /></td>
                    <td className="num text-xs text-faint">—</td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="text-xs font-semibold text-mute">合计</td>
                  <td className="num font-semibold"><Gold value={wage} /></td>
                  <td />
                  <td className="num font-semibold"><Gold value={wage * paidRounds} /></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        )}
      </Card>

      {/* 账目明细 */}
      <Card title="账目明细" subtitle={`${scopeLabel} · 最新在前`} bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
          <Field label="类别">
            <Select value={cat} onChange={(ev) => setCat(ev.target.value as 'all' | Category)}>
              <option value="all">全部类别</option>
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>{c === 'transfer_in' ? '转会（买入）' : c === 'transfer_out' ? '转会（卖出）' : CATEGORY_LABEL[c]}</option>
              ))}
            </Select>
          </Field>
          <Field label="方向">
            <Select value={dir} onChange={(ev) => setDir(ev.target.value as 'all' | 'in' | 'out')}>
              <option value="all">收入 + 支出</option>
              <option value="in">仅收入</option>
              <option value="out">仅支出</option>
            </Select>
          </Field>
          <Field label="搜索说明">
            <TextInput value={q} onChange={(ev) => setQ(ev.target.value)} placeholder="如：赞助、奖金、工资、选手 ID" className="w-48" />
          </Field>
        </div>
        {ledger.length === 0 ? (
          <EmptyState text={ledgerAll.length === 0 ? '还没有任何账目。推进回合、参加赛事或进行转会后会产生记录。' : '没有符合条件的账目。'} />
        ) : (
          <>
            <TableWrap>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>赛季</th>
                    <th>回合</th>
                    <th>类别</th>
                    <th className="w-full">说明</th>
                    <th className="num">金额</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map(({ x, i }) => (
                    <tr key={`${x.season}-${x.round}-${i}`}>
                      <td className="text-xs text-mute tabular">TI{x.season}</td>
                      <td className="text-xs text-mute">{roundLabel(x.season, x.round)}</td>
                      <td>
                        <Badge className={x.amount >= 0 ? 'bg-good/10 text-good' : 'bg-bad/10 text-[#ff9b9b]'}>
                          {categoryLabel(x.category, x.amount)}
                        </Badge>
                      </td>
                      <td className="max-w-0 truncate text-ink/90" title={x.note}>{x.note || '—'}</td>
                      <td className={cx('num font-semibold', x.amount >= 0 ? 'text-good' : 'text-bad')}>
                        {x.amount >= 0 ? '+' : ''}{formatGold(x.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <Pager {...paged} onChange={paged.setPage} unit="笔" />
          </>
        )}
      </Card>
    </div>
  );
}

/** 经营预测的一行：来源 · 每回合 · 本赛季剩余合计 + 说明 */
function ForecastRow({
  label,
  badge,
  perRound,
  total,
  note,
}: {
  label: string;
  badge?: string;
  perRound: number;
  total: number;
  note?: string;
}) {
  const positive = perRound >= 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium text-ink">{label}</span>
          {badge && <Badge className="bg-gold/15 text-gold">{badge}</Badge>}
        </span>
        <span className="flex items-baseline gap-2 tabular">
          <span className={positive ? 'text-good' : 'text-bad'}>{positive ? '+' : ''}{formatGold(perRound)}/回合</span>
          <span className="w-16 text-right text-mute">{total >= 0 ? '+' : ''}{formatGold(total)}</span>
        </span>
      </div>
      {note && <div className="truncate text-[11px] text-faint" title={note}>{note}</div>}
    </div>
  );
}

/** 选手奖金分成（第九波）：当前比例、50%–100% 调整（步长 5%，每回合一次）、效果预览与说明、最近调整、本赛季奖金去向 */
function PrizeShareCard({ g, me, roundLabel }: { g: GameState; me: string; roundLabel: (season: number, round: number) => string }) {
  const call = useCall();
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const status = safe(() => prizeShareStatus(g, me), null);
  if (!status) return null;
  const C = CONFIG.prizeShare;
  const pct = (v: number) => safe(() => formatPrizeShare(v), `${Math.round(v * 100)}%`);
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const current = status.share;
  const selected = pick ?? current;
  const changed = !same(selected, current);
  const pv = changed ? safe(() => prizeSharePreview(g, selected), null) : null;
  const options: number[] = [];
  for (let i = 0; i < 40; i++) {
    const v = Math.round((status.min + i * status.step) * 100) / 100;
    if (v > status.max + 1e-9) break;
    options.push(v);
  }

  // 本赛季奖金去向（玩家结算；旧存档无拆分 = 全归俱乐部）
  let clubSum = 0;
  let playersSum = 0;
  for (const st of g.history?.playerSettlements ?? []) {
    if (!st || g.tournaments[st.tournamentId]?.season !== g.season.ti) continue;
    clubSum += num(st.prizeClub, num(st.prize));
    playersSum += num(st.prizePlayers);
  }
  const league = Object.values(g.teams).filter((t) => t && !t.disbanded);
  const leagueAvg = league.length ? league.reduce((a, t) => a + safe(() => prizeShareOf(g, t), C.newClub), 0) / league.length : C.newClub;
  const ratio = C.loyalty.raisePerStep > 0 ? C.loyalty.cutPerStep / C.loyalty.raisePerStep : 0;
  const deltas = pv?.members.map((m) => m.delta) ?? [];
  const lo = deltas.length ? Math.min(...deltas) : 0;
  const hi = deltas.length ? Math.max(...deltas) : 0;

  const blockReason = !changed ? '请选择新的分成比例' : busy ? '正在提交…' : pv && !pv.allowed ? pv.reason : '';
  const apply = () => {
    if (blockReason) return;
    setBusy(true);
    void call('setPrizeShare', selected).then(() => {
      setBusy(false);
      setPick(null);
    });
  };

  return (
    <Card
      title="选手奖金分成"
      subtitle={`赛事奖金的 ${pct(current)} 分给队员，俱乐部保留 ${pct(1 - current)}；出场费与赞助、直播、周边收入全归俱乐部`}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3">
          <div>
            <div className="flex items-baseline justify-between gap-2 text-xs text-mute">
              <span>队员 <b className="tabular text-base text-info">{pct(selected)}</b>{changed && <span className="ml-1 text-faint">（当前 {pct(current)}）</span>}</span>
              <span>俱乐部 <b className="tabular text-base text-gold">{pct(1 - selected)}</b></span>
            </div>
            <div className="mt-1 flex h-2.5 overflow-hidden rounded-full bg-panel-3" aria-hidden>
              <div className="h-full bg-info/70" style={{ width: `${selected * 100}%` }} />
              <div className="h-full bg-gold/80" style={{ width: `${(1 - selected) * 100}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1" role="group" aria-label="选择奖金分成比例">
            {options.map((v) => {
              const isCur = same(v, current);
              const isSel = same(v, selected);
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => setPick(isCur ? null : v)}
                  title={isCur ? `当前比例 ${pct(v)}` : `队员 ${pct(v)} / 俱乐部 ${pct(1 - v)}`}
                  className={cx(
                    'cursor-pointer whitespace-nowrap rounded border px-0.5 py-1 text-xs tabular transition-colors',
                    isSel ? 'border-gold bg-gold/15 text-gold' : 'border-line bg-panel-2 text-mute hover:bg-panel-3 hover:text-ink',
                    isCur && 'font-semibold underline decoration-dotted underline-offset-2',
                  )}
                >
                  {Math.round(v * 100)}%
                </button>
              );
            })}
          </div>
          <div className="space-y-1 rounded-lg border border-line bg-panel-2/60 px-3 py-2 text-xs text-mute">
            {changed && pv ? (
              <>
                <div>
                  调整为 {pct(selected)}：队员归属感立即 <Delta value={pv.avgDelta} digits={1} />（平均
                  {deltas.length > 1 && !same(lo, hi) ? `，${lo > 0 ? '+' : ''}${lo.toFixed(1)} ~ ${hi > 0 ? '+' : ''}${hi.toFixed(1)}，效力越久反应越强烈` : ''}）
                  {pv.raiseSuppressed && pv.restoreLevel !== null && (
                    <span className="text-gold"> · 刚下调过分成：调回 {pct(pv.restoreLevel)} 以内的部分没有即时效果</span>
                  )}
                </div>
                <div>
                  每回合环境：每名队员 <Delta value={pv.roundDeltaBefore} digits={2} /> → <Delta value={pv.roundDeltaAfter} digits={2} />
                </div>
              </>
            ) : (
              <div>
                当前比例下每回合环境：每名队员归属感 <Delta value={status.roundDelta} digits={2} />（{pct(C.loyalty.norm)} 为中性）
              </div>
            )}
            <div>
              每 10 万奖金：俱乐部 <span className="tabular text-gold">{formatGold(Math.round(100000 * (1 - selected)))}</span> / 队员{' '}
              <span className="tabular text-info">{formatGold(Math.round(100000 * selected))}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ConfirmButton
              variant="gold"
              size="sm"
              disabled={!!blockReason}
              title={blockReason || undefined}
              confirm={
                pv
                  ? {
                      title: `奖金分成 ${pct(current)} → ${pct(selected)}`,
                      danger: selected < current,
                      confirmLabel: '确认调整',
                      message: (
                        <>
                          队员归属感立即 <Delta value={pv.avgDelta} digits={1} />（平均），每回合环境 <Delta value={pv.roundDeltaBefore} digits={2} /> →{' '}
                          <Delta value={pv.roundDeltaAfter} digits={2} />。每回合最多调整一次，调整会以新闻公开。
                          {pv.raiseSuppressed && pv.restoreLevel !== null && (
                            <span className="mt-1 block text-gold">刚下调过分成：调回 {pct(pv.restoreLevel)} 以内的部分没有即时效果。</span>
                          )}
                        </>
                      ),
                    }
                  : null
              }
              onConfirm={apply}
            >
              调整为 {pct(selected)}
            </ConfirmButton>
            {changed && (
              <Button size="sm" variant="ghost" onClick={() => setPick(null)}>
                取消
              </Button>
            )}
            <span className="text-[11px] text-faint">
              {!status.canChange
                ? status.reason
                : status.raiseCooldownLeft > 0 && status.restoreLevel !== null
                  ? `刚下调过分成：${status.raiseCooldownLeft} 回合内调回 ${pct(status.restoreLevel)} 以内不会提升归属感`
                  : '每回合最多调整一次，调整会以新闻公开'}
            </span>
          </div>
        </div>
        <div className="min-w-0 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="本赛季奖金 · 俱乐部" value={<Gold value={clubSum} />} />
            <Stat label="本赛季奖金 · 队员" value={<span className="text-info">{formatGold(playersSum)}</span>} />
          </div>
          <ul className="list-disc space-y-1 pl-4 leading-relaxed text-mute">
            <li>比例越高队员越满意：高于 {pct(C.loyalty.norm)} 每回合小幅提升归属感，低于则每回合下降。</li>
            <li>
              上调立即小幅提升归属感；下调立即明显下降（约为同幅上调的 {ratio.toFixed(1)} 倍），效力越久的队员反应越强烈；
              下调后 {C.loyalty.raiseCooldownRounds} 个回合内把比例调回原来的水平，队员并不领情（只有超出原水平的部分才算上调）。
            </li>
            <li>赢得奖金时，队员按分到的金额（相对其工资）额外提升归属感；近期分到的奖金也会部分计入他们对薪资的满意度。</li>
            <li>赛事结束时的首发全额分配，其余队员按 {Math.round(C.benchWeight * 100)}% 权重分配。</li>
          </ul>
          <div>
            <div className="mb-1 text-[11px] text-faint">最近调整 · 联赛平均 {pct(leagueAvg)}</div>
            {status.log.length === 0 ? (
              <div className="text-faint">尚未调整过</div>
            ) : (
              <ul className="space-y-0.5">
                {status.log.slice(0, 5).map((x, i) => (
                  <li key={`${x.season}-${x.round}-${i}`} className="flex items-center justify-between gap-2 tabular">
                    <span className="text-mute">TI{x.season} · {roundLabel(x.season, x.round)}</span>
                    <span>
                      {pct(x.from)} → <span className={x.to > x.from ? 'text-good' : 'text-bad'}>{pct(x.to)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
