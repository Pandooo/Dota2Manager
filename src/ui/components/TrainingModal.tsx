// 训练卡片（总览「本回合」中内嵌、可展开；原快速训练弹窗）：标题行常驻显示剩余次数、当前焦点、上次训练收益与「开始训练」，
// 展开后为完整操作——成长来源提示（训练为主、比赛主要带来荣誉 / 奖金 / 韧性）、训练焦点、开始训练（收益即时展示）、
// 购买额外训练、推荐训练赛对手，以及跳转训练页查看详细历史与成长曲线。
// 展开状态 = store.trainingOpen；任何页面调用 setTrainingOpen(true)（如底栏提示）都会回到总览、展开并滚动到这里（store.cardFocus）。
import { useEffect, useRef, type RefObject } from 'react';
import { useCall, useCallSilent, useGame, useGameStore, type DashboardCard } from '../../store/gameStore';
import { CONFIG, formatGold, trainingSummary } from '../../engine';
import type { TrainingRecord } from '../../engine';
import { Button, Gold, TeamTag, cx } from './common';
import { safe } from './SquadShared';
import {
  FOCUS_INFO, FOCUS_ORDER, GainsTable, ROUND_KIND_TEXT, RecordKindChip, SCRIM_BOOKED_LABEL, SessionsText, costBreakdown,
  recordInsightMult, roundRecords, scrimMultTone, scrimOptions, scrimReason, scrimRuleShort, scrimRuleText, suggestedScrims,
  sumGains, trainingStatus,
} from './TrainingShared';

const SUGGEST_COUNT = 5;

// ---------------------------------------------------------------------------
// 「打开卡片」请求 → 滚动到卡片（训练 / 赛事卡片共用）
// ---------------------------------------------------------------------------
/** 已处理的请求序号（模块级：离开总览再回来时不会重复滚动） */
const handledFocusSeq: Partial<Record<DashboardCard, number>> = {};

/**
 * store.cardFocus 指向该卡片且尚未处理时，滚动到卡片顶部。
 * 放在 requestAnimationFrame 里：从其他页面切回总览时，App 会先把主区域滚回顶部，再执行这里的滚动。
 */
export function useCardFocusScroll(card: DashboardCard, ref: RefObject<HTMLElement | null>): void {
  const seq = useGameStore((s) => (s.cardFocus?.card === card ? s.cardFocus.seq : 0));
  useEffect(() => {
    if (!seq || handledFocusSeq[card] === seq) return;
    const id = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      handledFocusSeq[card] = seq;
      el.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(id);
  }, [seq, card, ref]);
}

// ---------------------------------------------------------------------------
// 训练卡片
// ---------------------------------------------------------------------------
export function TrainingCard({ className }: { className?: string }) {
  const game = useGame();
  const call = useCall();
  const open = useGameStore((s) => s.trainingOpen);
  const setView = useGameStore((s) => s.setView);
  const ref = useRef<HTMLElement>(null);
  useCardFocusScroll('training', ref);
  const st = trainingStatus(game);
  if (!st) return null;

  const records = roundRecords(game);
  const manual = records.filter((r) => r.kind !== 'auto');
  const last: TrainingRecord | null = manual[0] ?? null;
  const lastTotal = last ? sumGains(last.gains) : null;
  const focusInfo = FOCUS_INFO[st.focus] ?? FOCUS_INFO.balanced;
  // 卡片内的展开 / 收起只切换状态（不发滚动请求）；从其他地方打开用 store.setTrainingOpen(true)
  const toggle = () => useGameStore.setState({ trainingOpen: !open });

  return (
    <section
      ref={ref}
      className={cx(
        'scroll-mt-4 overflow-hidden rounded-xl border bg-panel-2/40',
        st.trainable ? 'border-good/30' : 'border-line',
        className,
      )}
    >
      {/* 标题行（常驻）：点击展开 / 收起；收起时也能直接开始训练 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={open ? '收起训练卡片' : '展开训练：焦点、额外训练、训练赛'}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className={cx('text-sm font-semibold', st.trainable ? 'text-good' : 'text-mute')}>⚔ 训练</span>
          {st.trainable ? (
            <span className="min-w-0 truncate text-xs text-mute">
              剩余 <b className={cx('tabular', st.sessionsLeft > 0 ? 'text-good' : 'text-faint')}>{st.sessionsLeft}</b> 次
              <span className="mx-1.5 text-faint">·</span>
              焦点 <span className="text-ink">{focusInfo.icon} {focusInfo.title}</span>
              {lastTotal && (
                <>
                  <span className="mx-1.5 text-faint">·</span>
                  上次 全队战力 <span className="tabular text-good">+{lastTotal.power.toFixed(2)}</span> · 天梯{' '}
                  <span className="tabular text-good">+{Math.round(lastTotal.mmr)}</span>
                </>
              )}
            </span>
          ) : (
            <span className="min-w-0 truncate text-xs text-faint" title={st.reason || st.lockTitle}>
              本回合无法训练{st.lockTitle ? `：${st.lockTitle}` : ''}
            </span>
          )}
        </button>
        {!open && st.trainable && (
          <Button
            size="sm"
            variant="primary"
            disabled={!!st.trainReason}
            title={st.trainReason || `按当前焦点「${focusInfo.title}」训练一次（优先使用免费次数）`}
            onClick={() => void call('doTraining')}
          >
            ⚔ 开始训练
          </Button>
        )}
        <button type="button" onClick={toggle} className="shrink-0 cursor-pointer text-xs text-faint hover:text-gold">
          {open ? '收起 ▴' : '展开 ▾'}
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-line/70 px-4 py-3">
          {!st.trainable && (
            <div className="flex items-start gap-3 rounded-lg border border-gold/40 bg-gold/5 px-3 py-2.5">
              <div className="text-lg leading-none text-gold">⏸</div>
              <div className="text-sm text-mute">
                <div className="font-semibold text-gold">
                  本回合无法训练
                  <span className="ml-2 text-xs font-normal text-faint">
                    TI{game.season.ti} · {st.roundLabel} · {ROUND_KIND_TEXT[st.kind] ?? st.kind}
                  </span>
                </div>
                {st.reason}
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-mute">
            <b className="text-good">训练是队员成长的主要来源</b>：天赋决定收益区间、越年轻长得越快，一直训练成长最快但很花钱（额外训练同一回合内逐次加价
            ×{CONFIG.training.extraCostGrowth}）；<b className="text-gold">比赛</b>主要带来荣誉、奖金与韧性。
          </p>

          <TrainingBody st={st} last={last} manualCount={manual.length} />

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-2.5">
            <button type="button" className="cursor-pointer text-xs text-mute hover:text-gold hover:underline" onClick={() => setView('training')}>
              查看训练详情（历史与成长曲线）›
            </button>
            {st.trainable && st.sessionsLeft > 0 && (
              <span className="text-[11px] text-info">
                未用完的 {st.sessionsLeft} 次训练会在推进回合时按当前焦点「{focusInfo.title}」自动完成
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default TrainingCard;

// ---------------------------------------------------------------------------
// 展开后的操作区
// ---------------------------------------------------------------------------
function TrainingBody({
  st, last, manualCount,
}: {
  st: NonNullable<ReturnType<typeof trainingStatus>>;
  last: TrainingRecord | null;
  manualCount: number;
}) {
  const game = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const options = scrimOptions(game, st.team, st.ownRating);
  const suggested = suggestedScrims(options, SUGGEST_COUNT);
  const season = safe(() => trainingSummary(game, game.season.ti), null);

  return (
    <>
      {/* 次数 + 资金 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-panel-2/50 px-3 py-2.5">
        <SessionsText st={st} />
        <span className="text-xs text-faint">
          本回合已购 <span className="tabular text-ink">{st.boughtThisRound}/{st.maxExtra}</span> · 资金 <Gold value={st.team.gold} />
        </span>
        {season && season.sessions > 0 && (
          <span className="text-xs text-faint" title="本赛季全部训练（含训练赛与自动训练）的全队累计收益">
            本赛季已训练 <span className="tabular text-ink">{season.sessions}</span> 次 · 全队战力{' '}
            <span className="tabular text-good">+{season.totals.power.toFixed(1)}</span>
          </span>
        )}
      </div>

      {/* 焦点（切换不弹提示） */}
      <div>
        <div className="mb-1.5 text-xs font-semibold text-mute">训练焦点</div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {FOCUS_ORDER.map((f) => {
            const info = FOCUS_INFO[f];
            const mult = CONFIG.growth.focus[f] ?? [0.5, 0.5, 0.5];
            const selected = st.focus === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() => !selected && void callSilent('setTrainingFocus', f)}
                title={`${info.desc}（战力 ×${mult[0]} / 天梯 ×${mult[1]} / 灵性 ×${mult[2]}）`}
                className={cx(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                  selected ? 'border-dota bg-dota/10' : 'border-line bg-panel-2/40 hover:border-mute/50 hover:bg-panel-2',
                )}
              >
                <span className={cx('text-lg', selected ? 'text-gold' : 'text-mute')}>{info.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {info.title}
                    {selected && <span className="text-[11px] font-normal text-dota-2">✓ 当前</span>}
                  </span>
                  <span className="block truncate text-xs text-mute">{info.short}</span>
                </span>
                <span className="shrink-0 text-[10px] tabular text-faint">
                  {mult[0]}/{mult[1]}/{mult[2]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!!st.trainReason}
          title={st.trainReason || '消耗 1 次训练次数（优先使用免费次数）'}
          onClick={() => void call('doTraining')}
        >
          ⚔ 开始训练
        </Button>
        <Button
          variant="gold"
          disabled={!!st.buyReason}
          title={st.buyReason || `花费 ${formatGold(st.extraCost)} 购买 1 次额外训练（每回合最多 ${st.maxExtra} 次，同一回合内逐次加价）`}
          onClick={() => void call('buyExtraTraining')}
        >
          购买额外训练 · {formatGold(st.extraCost)}
        </Button>
        {st.trainReason && <span className="text-xs text-faint">{st.trainReason}</span>}
      </div>

      {/* 最近一次训练结果 */}
      {last && <LastResult record={last} count={manualCount} />}

      {/* 推荐训练赛 */}
      <div>
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-mute">推荐训练赛（按收益倍数）</span>
          <span className="text-[11px] text-faint" title={scrimRuleText()}>消耗 1 次训练 · {scrimRuleShort()}</span>
        </div>
        {suggested.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">当前没有可约练的战队。</div>
        ) : (
          <div className="divide-y divide-line/60 rounded-lg border border-line">
            {suggested.map((r) => {
              const why = scrimReason(st, r.cost, r.booked, r.t.name);
              return (
                <div key={r.t.id} className={cx('flex items-center gap-3 px-3 py-1.5 text-sm', r.booked && 'opacity-60')}>
                  <span className="min-w-0 flex-1 truncate">
                    <TeamTag color={r.t.color} tag={r.t.tag} />
                    <span className="ml-1.5 text-xs text-faint">评分 {r.rating.toFixed(1)}</span>
                  </span>
                  <span className={cx('w-14 text-right font-semibold tabular', scrimMultTone(r.mult))}>×{r.mult.toFixed(2)}</span>
                  <Gold value={r.cost} className={cx('w-24 text-right', !r.booked && r.cost > st.team.gold && 'text-bad')} />
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={!!why}
                    title={why || `花费 ${formatGold(r.cost)} 与 ${r.t.name} 打一场训练赛`}
                    onClick={() => void call('doScrim', r.t.id)}
                  >
                    {r.booked ? SCRIM_BOOKED_LABEL : '约训练赛'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function LastResult({ record, count }: { record: TrainingRecord; count: number }) {
  const game = useGame();
  const target = record.scrimTargetId ? game.teams[record.scrimTargetId] : undefined;
  const total = sumGains(record.gains);
  return (
    <div className="fade-up overflow-hidden rounded-lg border border-line">
      <div
        className={cx(
          'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-sm',
          record.kind === 'scrim' ? (record.scrimWon ? 'bg-good/10' : 'bg-bad/10') : 'bg-panel-2/60',
        )}
      >
        <RecordKindChip kind={record.kind} />
        {record.kind === 'scrim' ? (
          <span>
            vs {target ? target.name : '对手'}
            <b className={cx('ml-1.5', record.scrimWon ? 'text-good' : 'text-bad')}>{record.scrimWon ? '胜' : '负'}</b>
            <span className="ml-1.5 text-xs text-gold">×{record.mult.toFixed(2)}</span>
            {recordInsightMult(record) !== 1 && (
              <span className="ml-1.5 text-xs text-info" title="训练赛双方交流 BP：灵性收益在训练赛倍数之上另乘此值">
                灵性另 ×{recordInsightMult(record).toFixed(1)}
              </span>
            )}
          </span>
        ) : (
          <span>{FOCUS_INFO[record.focus]?.title ?? '均衡'}焦点</span>
        )}
        {record.cost > 0 && (
          <span className="text-xs text-mute" title={costBreakdown(record)}>
            花费 <Gold value={record.cost} />
            {record.kind === 'scrim' && (record.sessionCost ?? 0) > 0 && (
              <span className="ml-1 text-faint">（{costBreakdown(record)}）</span>
            )}
          </span>
        )}
        <span className="ml-auto text-xs text-mute">
          全队 战力 <span className="tabular text-good">+{total.power.toFixed(2)}</span> · 天梯{' '}
          <span className="tabular text-good">+{Math.round(total.mmr)}</span> · 灵性{' '}
          <span className="tabular text-good">+{total.insight.toFixed(2)}</span>
          {count > 1 && <span className="ml-2 text-faint">本回合第 {count} 次</span>}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto">
        <GainsTable game={game} gains={record.gains} compact />
      </div>
    </div>
  );
}
