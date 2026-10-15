// 训练页（详细视图）：训练安排（焦点、次数/额外训练、本回合训练报告、训练赛、成长机制说明），
// 以及基于 history.training / history.squadProgress 的赛季汇总、成长曲线与训练历史，便于按进度决策。
// 快速操作见总览的训练弹窗（TrainingModal）。
import { useState, type ReactNode } from 'react';
import { useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG, POSITIONS, REGIONS, REGION_LABEL, ageOf, econ, effectiveAttr, formatGold,
  getCoach, trainingSummary,
} from '../../engine';
import type { GameState, Player, Region, Team, TrainingFocus, TrainingRecord, TrainingSummary } from '../../engine';
import {
  Badge, Button, Card, Delta, EmptyState, Gold, Hint, PlayerLink, PosBadge, RegionBadge, TableScroll, Tabs, TeamLink, TeamTag, cx,
} from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import { Chip, MiniBar, fmt1, pct, safe, useStickyFirstCol } from '../components/SquadShared';
import {
  FOCUS_INFO, FOCUS_ORDER, GainsTable, ROUND_KIND_TEXT, RecordKindChip, SCRIM_BOOKED_LABEL, costBreakdown, recordInsightMult,
  roundRecords, scrimInsightBonus, scrimMultTone, scrimOptions, scrimPerOpponentLimit, scrimReason, scrimRuleShort, sumGains,
  trainingStatus, type TrainingStatus,
} from '../components/TrainingShared';
import TrainingGrowth from '../components/TrainingGrowth';
import TrainingHistory from '../components/TrainingHistory';
import TrainingSeasonSummary from '../components/TrainingSeasonSummary';

type TabKey = 'plan' | 'summary' | 'growth' | 'history';
/** 记住上次查看的分页（离开训练页再回来时保持） */
let lastTab: TabKey = 'plan';

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------
export default function Training() {
  const game = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const [tab, setTabState] = useState<TabKey>(lastTab);
  const [regionFilter, setRegionFilter] = useState<Region | 'all'>('all');
  const [affordOnly, setAffordOnly] = useState(false);
  const [dismissed, setDismissed] = useState<TrainingRecord | null>(null);
  const setTab = (t: TabKey) => {
    lastTab = t;
    setTabState(t);
  };

  const st = trainingStatus(game);
  if (!st) {
    return (
      <Card title="训练">
        <EmptyState text="找不到玩家战队数据，请重新读取存档。" />
      </Card>
    );
  }
  const { team, kind, trainable, round, focus, coach } = st;
  // 回合标签已说明类型时不再重复
  const showKind = kind === 'rest' || kind === 'tournament' || kind === 'ti_watch';
  const season = safe(() => trainingSummary(game, game.season.ti), null as TrainingSummary | null);
  const historyCount = game.history?.training?.length ?? 0;

  // 本回合手动训练记录（最新在前）；「收起」后显示训练预估，下一次训练自动重新展开
  const recs = roundRecords(game).filter((r) => r.kind !== 'auto');
  const last = recs[0] ?? null;
  const showReport = !!last && last !== dismissed;

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="训练"
        subtitle={
          <>
            TI{game.season.ti} · {st.roundLabel}
            {round && <span className="text-faint">（{round.startDate}{round.endDate && round.endDate !== round.startDate ? ` ~ ${round.endDate}` : ''}）</span>}
            {showKind && (
              <>
                {' · '}
                <span className={trainable ? 'text-good' : 'text-gold'}>{ROUND_KIND_TEXT[kind]}</span>
              </>
            )}
            {' · '}
            <span className={trainable ? 'text-good' : 'text-faint'}>{trainable ? '可训练' : '不可训练'}</span>
          </>
        }
        nav={
          <>
            <Button variant="ghost" size="sm" onClick={() => setView('squad')}>阵容</Button>
            <Button variant="ghost" size="sm" onClick={() => setView('coach')}>教练</Button>
          </>
        }
      />

      {/* 本赛季进度速览 */}
      <SeasonStrip season={season} onOpen={() => setTab('summary')} />

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'plan', label: '训练安排', badge: st.sessionsLeft > 0 ? <Badge className="bg-good/20 text-good">{st.sessionsLeft}</Badge> : undefined },
          { key: 'summary', label: '赛季汇总' },
          { key: 'growth', label: '成长曲线' },
          { key: 'history', label: '训练历史', badge: historyCount > 0 ? <Badge>{historyCount}</Badge> : undefined },
        ]}
      />

      {tab === 'summary' && <TrainingSeasonSummary game={game} />}
      {tab === 'growth' && <TrainingGrowth game={game} />}
      {tab === 'history' && <TrainingHistory game={game} />}

      {tab === 'plan' && (
        <>
          {!trainable && (
            <div className="flex items-start gap-3 rounded-xl border border-gold/40 bg-gold/5 px-4 py-3">
              <div className="text-xl leading-none text-gold">⏸</div>
              <div>
                <div className="text-sm font-semibold text-gold">本回合无法训练 · {ROUND_KIND_TEXT[kind]}</div>
                <div className="mt-0.5 text-sm text-mute">{st.reason}</div>
              </div>
            </div>
          )}
          {kind === 'ti_watch' && trainable && (
            <div className="rounded-xl border border-info/40 bg-info/5 px-4 py-2.5 text-sm text-mute">
              你的战队未进入本届 TI 正赛。本回合没有比赛，可以照常训练，为下赛季打基础。
            </div>
          )}
          <GrowthSourceNote />

          {/* 单列也写 minmax(0,1fr)：隐式 auto 列会被训练赛表格撑出屏幕（docs/UI.md「手机适配」） */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            {/* ---------------- 焦点 + 开始训练 ---------------- */}
            <Card title="训练焦点" subtitle="选择本次训练的重点，倍数为 [战斗力 / 天梯 / 灵性] 收益系数">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {FOCUS_ORDER.map((f) => {
                  const info = FOCUS_INFO[f];
                  const mult = CONFIG.growth.focus[f] ?? [0.5, 0.5, 0.5];
                  const selected = focus === f;
                  const avg = season?.byFocus[f];
                  return (
                    <button
                      key={f}
                      onClick={() => !selected && void callSilent('setTrainingFocus', f)}
                      className={cx(
                        'relative flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
                        selected ? 'border-dota bg-dota/10 shadow-inner shadow-dota/20' : 'border-line bg-panel-2/50 hover:border-mute/50 hover:bg-panel-2',
                      )}
                    >
                      {selected && <span className="absolute right-2 top-2 text-xs text-dota-2">✓ 当前</span>}
                      <div className="flex items-center gap-2">
                        <span className={cx('text-lg', selected ? 'text-gold' : 'text-mute')}>{info.icon}</span>
                        <span className="font-semibold">{info.title}</span>
                      </div>
                      <div className="text-xs leading-relaxed text-mute">{info.desc}</div>
                      <div className="mt-auto flex gap-1 pt-1">
                        {(['战力', '天梯', '灵性'] as const).map((label, i) => (
                          <span
                            key={label}
                            className={cx(
                              'rounded px-1.5 py-0.5 text-[10px] tabular',
                              mult[i] >= 1 ? 'bg-gold/15 text-gold' : mult[i] >= 0.5 ? 'bg-info/10 text-info' : 'bg-panel-3 text-faint',
                            )}
                          >
                            {label}×{mult[i]}
                          </span>
                        ))}
                      </div>
                      {avg && avg.sessions > 0 && (
                        <div className="text-[10px] text-faint" title="本赛季该焦点每次训练的全队合计收益（平均）">
                          本季 {avg.sessions} 次 · 均 战力 +{avg.avg.power.toFixed(2)} / 天梯 +{Math.round(avg.avg.mmr)}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  size="lg"
                  disabled={!!st.trainReason}
                  title={st.trainReason || '消耗 1 次训练次数（优先使用免费次数）'}
                  onClick={() => void call('doTraining')}
                >
                  ⚔ 开始训练
                </Button>
                <div className="text-sm text-mute">
                  剩余 <span className={cx('text-lg font-bold tabular', st.sessionsLeft > 0 ? 'text-good' : 'text-faint')}>{st.sessionsLeft}</span> 次
                  <span className="ml-2 text-xs text-faint">首发全额收益，替补 ×{CONFIG.growth.benchTrainingMult}</span>
                </div>
                {coach && (
                  <Chip tone="info" title="教练在训练时额外提升队员天赋与韧性（每个休赛回合第一次训练全额，额外训练 / 训练赛按比例折算）">
                    教练 {coach.name}：天赋 +{fmt1(coach.talentBoost)} / 韧性 +{fmt1(coach.resilienceBoost)}
                  </Chip>
                )}
              </div>
            </Card>

            {/* ---------------- 训练次数 ---------------- */}
            <Card title="训练次数" subtitle={trainable ? '每个休赛回合 1 次免费训练' : ROUND_KIND_TEXT[kind]}>
              <div className="flex items-end gap-3">
                <div className={cx('text-4xl font-black tabular leading-none', st.sessionsLeft > 0 ? 'text-ink' : 'text-faint')}>{st.sessionsLeft}</div>
                <div className="pb-0.5 text-xs text-mute">本回合剩余可用</div>
              </div>
              <div className="mt-3 space-y-2 text-sm">
                <Row label="免费训练">
                  {!trainable ? (
                    <span className="text-faint">不可用</span>
                  ) : game.freeTrainingUsed ? (
                    <span className="text-faint">已使用</span>
                  ) : (
                    <span className="text-good">{st.freeLeft} 次可用</span>
                  )}
                </Row>
                <Row label="已购未用">
                  <span className={cx('tabular', st.extraAvail > 0 ? 'text-gold' : 'text-faint')}>{st.extraAvail} 次</span>
                </Row>
                <Row label="本回合已购">
                  <span className="flex items-center gap-2">
                    <MiniBar value={st.boughtThisRound} max={st.maxExtra} color={st.boughtThisRound >= st.maxExtra ? 'bg-bad' : 'bg-gold'} className="w-16" />
                    <span className="tabular">{st.boughtThisRound}/{st.maxExtra}</span>
                  </span>
                </Row>
                <Row label="下次价格">
                  <Gold value={st.extraCost} />
                </Row>
              </div>
              <Button
                variant="gold"
                className="mt-3 w-full"
                disabled={!!st.buyReason}
                title={st.buyReason || `花费 ${formatGold(st.extraCost)} 购买 1 次额外训练（同一回合内逐次加价）`}
                onClick={() => void call('buyExtraTraining')}
              >
                购买额外训练 · {formatGold(st.extraCost)}
              </Button>
              <Hint className="mt-2">
                同一回合内每多买一次 ×{CONFIG.training.extraCostGrowth}（下回合恢复）；本赛季已购 {st.boughtSeason} 次，每已购 1 次价格另 +
                {Math.round(CONFIG.training.extraSeasonStep * 100)}%（至多 ×{CONFIG.training.extraSeasonMaxMult}，赛季初重置）。资金 <Gold value={team.gold} />
              </Hint>
              {trainable && st.sessionsLeft > 0 && (
                <p className="mt-1 text-xs leading-relaxed text-info">
                  提示：本回合未用完的 {st.sessionsLeft} 次训练会在推进回合时按当前焦点「{FOCUS_INFO[focus].title}」自动完成，不会浪费；想约训练赛请在推进前进行。
                </p>
              )}
            </Card>
          </div>

          {/* ---------------- 报告 ---------------- */}
          {showReport && last ? (
            <ReportCard game={game} report={last} history={recs} onHide={() => setDismissed(last)} onHistory={() => setTab('history')} />
          ) : (
            <ForecastCard game={game} team={team} players={st.players} focus={focus} />
          )}

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ScrimPanel
              game={game}
              st={st}
              regionFilter={regionFilter}
              setRegionFilter={setRegionFilter}
              affordOnly={affordOnly}
              setAffordOnly={setAffordOnly}
              onScrim={(id) => void call('doScrim', id)}
            />
            <InfoCard game={game} players={st.players} team={team} />
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-mute">{label}</span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本赛季进度速览
// ---------------------------------------------------------------------------
function SeasonStrip({ season, onOpen }: { season: TrainingSummary | null; onOpen: () => void }) {
  if (!season || season.sessions === 0) {
    return (
      <div className="rounded-xl border border-line bg-panel/70 px-4 py-2 text-xs text-faint">
        本赛季还没有训练记录。每次训练、训练赛与回合结束的自动训练都会被记录，用于赛季汇总与成长曲线。
      </div>
    );
  }
  return (
    <button
      onClick={onOpen}
      className="flex w-full cursor-pointer flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-line bg-panel/70 px-4 py-2 text-left text-xs text-mute transition-colors hover:border-gold/40"
      title="查看赛季汇总"
    >
      <span className="font-semibold text-ink">本赛季训练</span>
      <span>
        <b className="tabular text-ink">{season.sessions}</b> 次（训练赛 {season.scrims}，{season.scrimWins} 胜）
      </span>
      <span>
        花费 <Gold value={season.totalSpend} />
      </span>
      <span>
        全队 战力 <Delta value={season.totals.power} digits={1} /> · 天梯 <Delta value={season.totals.mmr} /> · 灵性{' '}
        <Delta value={season.totals.insight} digits={1} />
      </span>
      <span className="ml-auto text-gold">赛季汇总 ›</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 本回合训练报告（来自 history.training）
// ---------------------------------------------------------------------------
function ReportCard({
  game,
  report,
  history,
  onHide,
  onHistory,
}: {
  game: GameState;
  report: TrainingRecord;
  history: TrainingRecord[];
  onHide: () => void;
  onHistory: () => void;
}) {
  const target = report.scrimTargetId ? game.teams[report.scrimTargetId] : undefined;
  const scrimNews =
    report.kind === 'scrim' && target
      ? game.news.find(
          (n) => n.season === report.season && n.round === report.round && n.category === 'match' && n.title.startsWith('训练赛') && n.title.includes(target.tag),
        )
      : undefined;

  return (
    <Card
      title={
        report.kind === 'scrim' ? (
          <>训练赛战报 · vs {target ? target.name : '对手'}</>
        ) : (
          <>训练报告 · {FOCUS_INFO[report.focus]?.title ?? '均衡'}焦点</>
        )
      }
      subtitle={history.length > 1 ? `本回合已训练 ${history.length} 次（显示最近一次）` : '本回合最近一次训练'}
      actions={
        <>
          <Button size="xs" variant="ghost" onClick={onHistory}>
            训练历史 ›
          </Button>
          <Button size="xs" variant="ghost" onClick={onHide} title="收起报告，显示训练预估">
            收起
          </Button>
        </>
      }
      bodyClassName="p-0"
    >
      {report.kind === 'scrim' && (
        <div
          className={cx(
            'flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5',
            report.scrimWon ? 'bg-good/10' : 'bg-bad/10',
          )}
        >
          <span className={cx('text-lg font-black', report.scrimWon ? 'text-good' : 'text-bad')}>{report.scrimWon ? '胜' : '负'}</span>
          {target && (
            <span className="inline-flex items-center gap-1.5">
              <TeamTag color={target.color} tag={target.tag} />
              <TeamLink teamId={target.id} name={target.name} className="text-mute" />
            </span>
          )}
          <span className="text-sm text-mute">
            收益倍数 <span className="font-semibold text-gold tabular">×{report.mult.toFixed(2)}</span>
            {recordInsightMult(report) !== 1 && (
              <span className="ml-1.5 text-xs text-info" title="训练赛双方交流 BP：灵性收益在训练赛倍数之上另乘此值">
                灵性另 ×{recordInsightMult(report).toFixed(1)}（交流 BP）
              </span>
            )}
          </span>
          {report.cost > 0 && (
            <span className="text-xs text-mute">
              花费 <Gold value={report.cost} />
              <span className="ml-1 text-faint">（{costBreakdown(report)}）</span>
            </span>
          )}
          {scrimNews && <span className="min-w-0 flex-1 truncate text-xs text-faint" title={scrimNews.body}>{scrimNews.body}</span>}
        </div>
      )}
      {report.kind !== 'scrim' && report.cost > 0 && (
        <div className="border-b border-line px-4 py-2 text-xs text-mute">
          使用已购额外训练（购买价 <Gold value={report.cost} />）
        </div>
      )}
      <GainsTable game={game} gains={report.gains} />
      {history.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-[11px] text-mute">
          <span className="text-faint">本回合记录：</span>
          {history
            .slice()
            .reverse()
            .map((r, i) => {
              const s = sumGains(r.gains);
              return (
                <span key={i} className="inline-flex items-center gap-1">
                  <RecordKindChip kind={r.kind} />
                  <Badge>
                    #{i + 1} {r.kind === 'scrim' ? (r.scrimWon ? '胜' : '负') : FOCUS_INFO[r.focus]?.title} · 战力 {s.power >= 0 ? '+' : ''}
                    {s.power.toFixed(2)} · 天梯 {s.mmr >= 0 ? '+' : ''}
                    {Math.round(s.mmr)}
                  </Badge>
                </span>
              );
            })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 训练预估（无报告时显示）
// ---------------------------------------------------------------------------
function ageFactorOf(age: number): number {
  for (const [maxAge, f] of CONFIG.growth.ageFactor) if (age <= maxAge) return f;
  const t = CONFIG.growth.ageFactor;
  return t.length ? t[t.length - 1][1] : 1;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function powerCap(power: number) {
  const c = CONFIG.player;
  return clamp((c.powerSoftCapStart - power) / c.powerSoftCapRange, c.powerSoftCapMin, 1);
}
function mmrCap(mmr: number) {
  const g = CONFIG.growth;
  return clamp((g.mmrSoftCap - mmr) / g.mmrSoftCapRange, g.mmrSoftCapMin, 1);
}
function insightCap(ins: number) {
  const g = CONFIG.growth;
  return clamp((g.insightSoftCapStart - ins) / g.insightSoftCapRange, g.insightSoftCapMin, 1);
}
function hiOf(base: { min: number; spread: number }, talent: number) {
  return base.min + base.spread * Math.pow(clamp(talent, 0, 100) / 100, CONFIG.growth.talentExponent);
}

function ForecastCard({ game, team, players, focus }: { game: GameState; team: Team; players: Player[]; focus: TrainingFocus }) {
  const sticky = useStickyFirstCol();
  const starters = new Set(POSITIONS.map((p) => team.lineup?.[p]).filter(Boolean) as string[]);
  const [fP, fM, fI] = CONFIG.growth.focus[focus] ?? [0.5, 0.5, 0.5];
  const tr = CONFIG.growth.training;
  const rows = players
    .map((p) => {
      const age = ageOf(game, p);
      const af = ageFactorOf(age);
      const talent = safe(() => effectiveAttr(p, 'talent'), p.talent);
      const bench = starters.has(p.id) ? 1 : CONFIG.growth.benchTrainingMult;
      const pw = af * fP * bench * powerCap(p.power);
      const mm = af * fM * bench * mmrCap(p.mmr);
      const ins = fI * bench * insightCap(p.insight);
      return {
        p,
        age,
        af,
        talent,
        starter: starters.has(p.id),
        power: [tr.power.min * pw, hiOf(tr.power, talent) * pw] as const,
        mmr: [tr.mmr.min * mm, hiOf(tr.mmr, talent) * mm] as const,
        insight: [tr.insight.min * ins, hiOf(tr.insight, talent) * ins] as const,
      };
    })
    .sort((a, b) => Number(b.starter) - Number(a.starter) || b.power[1] - a.power[1]);

  return (
    <Card title={`训练预估 · ${FOCUS_INFO[focus].title}焦点`} subtitle="单次训练每名队员的收益区间（随机落在区间内，不含训练赛倍数）" bodyClassName="p-0">
      {rows.length === 0 ? (
        <EmptyState text="阵容中没有选手，无法训练。" />
      ) : (
        // 手机：横向滑动，选手列固定在左侧
        <TableScroll stickyFirst={sticky}>
          <table className="tbl">
            <thead>
              <tr>
                <th>选手</th>
                <th>角色</th>
                <th className="num">年龄</th>
                <th className="num" title="年龄成长系数">年龄系数</th>
                <th className="num">天赋</th>
                <th className="num">战力区间</th>
                <th className="num">天梯区间</th>
                <th className="num">灵性区间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.p.id}>
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      <PosBadge pos={r.p.position} />
                      <PlayerLink player={r.p} />
                    </span>
                  </td>
                  <td>{r.starter ? <Chip tone="gold">首发</Chip> : <Chip>替补 ×{CONFIG.growth.benchTrainingMult}</Chip>}</td>
                  <td className="num">{r.age}</td>
                  <td className={cx('num', r.af >= 1 ? 'text-good' : r.af >= 0.55 ? 'text-ink' : 'text-bad')}>×{r.af}</td>
                  <td className="num">{fmt1(r.talent)}</td>
                  <td className="num text-good">+{r.power[0].toFixed(2)} ~ {r.power[1].toFixed(2)}</td>
                  <td className="num text-good">+{Math.round(r.mmr[0])} ~ {Math.round(r.mmr[1])}</td>
                  <td className="num text-good">+{r.insight[0].toFixed(2)} ~ {r.insight[1].toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 训练赛
// ---------------------------------------------------------------------------
function ScrimPanel({
  game,
  st,
  regionFilter,
  setRegionFilter,
  affordOnly,
  setAffordOnly,
  onScrim,
}: {
  game: GameState;
  st: TrainingStatus;
  regionFilter: Region | 'all';
  setRegionFilter: (r: Region | 'all') => void;
  affordOnly: boolean;
  setAffordOnly: (v: boolean) => void;
  onScrim: (id: string) => void;
}) {
  const openTeam = useGameStore((s) => s.openTeam);
  const { team, ownRating } = st;
  const rows = scrimOptions(game, team, ownRating);
  const shown = rows.filter((r) => (regionFilter === 'all' || r.t.region === regionFilter) && (!affordOnly || r.cost <= team.gold));
  const bookedCount = rows.filter((r) => r.booked).length;
  const ownPos = rows.filter((r) => r.rating > ownRating).length + 1;
  // 本赛季与各队的训练赛战绩
  const record = new Map<string, { w: number; l: number }>();
  for (const r of game.history?.training ?? []) {
    if (r.kind !== 'scrim' || r.season !== game.season.ti || !r.scrimTargetId) continue;
    const e = record.get(r.scrimTargetId) ?? { w: 0, l: 0 };
    if (r.scrimWon) e.w += 1;
    else e.l += 1;
    record.set(r.scrimTargetId, e);
  }

  return (
    <Card
      title="训练赛（约练）"
      subtitle={
        `消耗 1 次训练 · ${scrimRuleShort()} · 本队评分 ${fmt1(ownRating)}（第 ${ownPos} / ${rows.length + 1}）`
        + (bookedCount ? ` · 本回合已约 ${bookedCount} 队` : '')
      }
      bodyClassName="p-0"
      actions={
        <div className="flex items-center gap-2 text-xs">
          <select
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value as Region | 'all')}
            className="cursor-pointer rounded border border-line bg-panel-2 px-1.5 py-0.5 text-xs text-ink [color-scheme:dark] pointer-coarse:min-h-9"
          >
            <option value="all">全部赛区</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_LABEL[r]}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1 text-mute pointer-coarse:min-h-9">
            <input type="checkbox" checked={affordOnly} onChange={(e) => setAffordOnly(e.target.checked)} className="accent-[#c23c2a] pointer-coarse:size-4" />
            负担得起
          </label>
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState text="当前没有可约练的战队。" />
      ) : shown.length === 0 ? (
        <EmptyState text="没有符合筛选条件的战队。" />
      ) : (
        // 手机（< sm）：只显示战队简称 / 倍数 / 费用 / 约练按钮（序号、赛区、评分、差距、本季战绩与战队全名隐藏——倍数由评分差距算出；
        // 点简称看战队详情），仍放不下时横向滑动
        <TableScroll className="max-h-[460px] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="num max-sm:hidden">#</th>
                <th>战队</th>
                <th className="max-sm:hidden">赛区</th>
                <th className="num max-sm:hidden">评分</th>
                <th className="num max-sm:hidden" title="(对手评分 − 本队评分) / 本队评分">差距</th>
                <th className="num" title="训练收益倍数">倍数</th>
                <th className="num">费用</th>
                <th className="num max-sm:hidden" title="本赛季与该队的训练赛战绩">本季</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const rank = rows.indexOf(r) + 1;
                const why = scrimReason(st, r.cost, r.booked, r.t.name);
                const gapPct = Number.isFinite(r.gap) ? r.gap : 0;
                const rec = record.get(r.t.id);
                return (
                  <tr key={r.t.id} className={r.booked ? 'opacity-60' : undefined}>
                    <td className="num text-faint max-sm:hidden">{rank}</td>
                    <td>
                      <span className="inline-flex items-center gap-1.5">
                        {/* flex：按钮内不产生行盒，行高与以前（不可点的队标）一致 */}
                        <button type="button" className="flex cursor-pointer pointer-coarse:-my-2 pointer-coarse:py-2" onClick={() => openTeam(r.t.id)} title={r.t.name}>
                          <TeamTag color={r.t.color} tag={r.t.tag} />
                        </button>
                        <TeamLink teamId={r.t.id} name={r.t.name} className="max-w-24 truncate text-xs text-mute max-sm:hidden" />
                      </span>
                    </td>
                    <td className="max-sm:hidden">
                      <RegionBadge region={r.t.region} />
                    </td>
                    <td className="num max-sm:hidden">{fmt1(r.rating)}</td>
                    <td className="num max-sm:hidden">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        <GapBar gap={gapPct} />
                        <span className={cx('w-12 tabular', gapPct > 0.005 ? 'text-good' : gapPct < -0.005 ? 'text-bad' : 'text-faint')}>
                          {gapPct > 0 ? '+' : ''}
                          {pct(gapPct, 1)}
                        </span>
                      </span>
                    </td>
                    <td className={cx('num font-semibold', scrimMultTone(r.mult))}>×{r.mult.toFixed(2)}</td>
                    <td className="num">
                      <Gold value={r.cost} className={!r.booked && r.cost > team.gold ? 'text-bad' : undefined} />
                    </td>
                    <td className="num text-xs max-sm:hidden">
                      {rec ? (
                        <span>
                          <span className="text-good">{rec.w}</span>-<span className="text-bad">{rec.l}</span>
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="text-right">
                      {r.booked ? (
                        <span className="whitespace-nowrap text-[11px] text-faint" title={why}>
                          {SCRIM_BOOKED_LABEL}
                        </span>
                      ) : (
                        <Button size="xs" variant="secondary" disabled={!!why} title={why || `花费 ${formatGold(r.cost)} 与 ${r.t.name} 打一场训练赛`} onClick={() => onScrim(r.t.id)}>
                          <span className="sm:hidden">约练</span>
                          <span className="max-sm:hidden">约训练赛</span>
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Card>
  );
}

/** 差距条：中线为 0，左红右绿，±50% 封顶 */
function GapBar({ gap }: { gap: number }) {
  const w = Math.min(1, Math.abs(gap) / 0.5) * 50;
  return (
    <span className="relative inline-block h-1.5 w-10 overflow-hidden rounded-full bg-panel-3">
      <span className="absolute left-1/2 top-0 h-full w-px bg-line" />
      <span
        className={cx('absolute top-0 h-full', gap >= 0 ? 'bg-good' : 'bg-bad')}
        style={gap >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// 成长来源提示（训练页顶部）
// ---------------------------------------------------------------------------
function GrowthSourceNote() {
  return (
    <div className="rounded-xl border border-good/30 bg-good/5 px-4 py-2.5 text-sm leading-relaxed text-mute">
      <b className="text-good">训练是队员成长的主要来源</b>：天赋决定每次训练的收益区间，越年轻长得越快；一直训练成长最快，但额外训练与训练赛要花大量金钱。
      <b className="text-gold"> 比赛</b>主要带来荣誉、奖金与韧性，战力 / 天梯 / 灵性只有少量提升。
    </div>
  );
}

// ---------------------------------------------------------------------------
// 机制说明
// ---------------------------------------------------------------------------
function InfoCard({ game, players, team }: { game: GameState; players: Player[]; team: Team }) {
  const coach = safe(() => getCoach(game, team.id), null);
  const t = CONFIG.training;
  const ages = CONFIG.growth.ageFactor;
  let prev = 0;
  const ageRows = ages.map(([max, f]) => {
    const label = max >= 100 ? `${prev + 1}+` : prev === 0 ? `≤${max}` : prev + 1 === max ? `${max}` : `${prev + 1}–${max}`;
    prev = max;
    return { label, f };
  });
  const e = safe(() => econ(game), 1);

  return (
    <Card title="成长机制说明" subtitle="训练收益如何计算">
      <div className="space-y-3 text-xs leading-relaxed text-mute">
        <div>
          <div className="mb-0.5 font-semibold text-ink">成长从哪里来</div>
          <b className="text-good">训练是战斗力 / 天梯 / 灵性成长的主要来源</b>（看天赋、花钱多）：一直训练的队员成长快得多；
          <b className="text-gold">比赛主要带来荣誉、奖金与韧性</b>（打得越久、名次越好、赛事越大韧性涨得越多，TI 最多），战力 / 天梯 / 灵性只有少量提升。
          每个赛季初还有一次自主成长（向自身轨迹 / 潜力靠拢）。
        </div>
        <div>
          <div className="mb-0.5 font-semibold text-ink">练出来的能留住</div>
          队员被练到自身轨迹 / 潜力之上时，赛季初的「到顶回落」不会抹掉经理花钱练出来的部分：最多保护约 {CONFIG.development.investment.maxMmr} 天梯 /{' '}
          {CONFIG.development.investment.maxPower} 战力 × (天赋/100)<sup>{CONFIG.development.investment.talentExp}</sup>（天赋越高，越能超出自身上限）；
          停止训练后，这部分保护每赛季减少 {Math.round(CONFIG.development.investment.decay * 100)}%。
        </div>
        <TalentChart game={game} players={players} team={team} />
        <div>
          <div className="mb-0.5 font-semibold text-ink">天赋 = 随机区间的宽度</div>
          单次收益 = U(下限, 下限 + 幅度 × (天赋/100)<sup>{CONFIG.growth.talentExponent}</sup>) × 年龄系数 × 焦点倍数 × 软上限 × 训练赛倍数。天赋只抬高上限：高天赋
          = 高上限 + 高方差。战力越接近 {CONFIG.player.powerSoftCapStart}、天梯越高、灵性越高，收益越小。
        </div>
        <div>
          <div className="mb-1 font-semibold text-ink">年龄系数（战力/天梯）</div>
          <div className="flex flex-wrap gap-1">
            {ageRows.map((r) => (
              <span key={r.label} className={cx('rounded px-1.5 py-0.5 tabular', r.f >= 1 ? 'bg-good/15 text-good' : r.f >= 0.55 ? 'bg-panel-3 text-ink' : 'bg-bad/10 text-bad')}>
                {r.label}岁 ×{r.f}
              </span>
            ))}
          </div>
          <div className="mt-1">
            灵性不受年龄压制；{CONFIG.aging.talentDeclineStartAge} 岁以下训练时天赋自然小幅增长（每个休赛回合主要计一次），之后只能依靠教练。
          </div>
        </div>
        <div>
          <div className="mb-0.5 font-semibold text-ink">教练加成</div>
          每次训练：天赋 += 教练天赋提升 × {CONFIG.coach.talentPerTraining}，韧性 += 教练韧性提升 × {CONFIG.coach.resiliencePerTraining}（越接近 100 越难涨，替补 ×
          {CONFIG.growth.benchTrainingMult}）。每个休赛回合的第一次训练全额，同一回合的额外训练 / 训练赛只按 ×{CONFIG.training.extraSessionAttrMult} 计
          （年轻选手的天赋自然增长同样如此）：加练主要提升战力 / 天梯 / 灵性，天赋与韧性按回合成长，韧性主要靠比赛。
          {coach ? (
            <span className="text-info">
              {' '}
              现任 {coach.name}：每回合首次训练约 +{(coach.talentBoost * CONFIG.coach.talentPerTraining).toFixed(2)} 天赋 / +
              {(coach.resilienceBoost * CONFIG.coach.resiliencePerTraining).toFixed(2)} 韧性。
            </span>
          ) : (
            <span className="text-bad"> 当前没有教练，天赋/韧性无法通过训练提升。</span>
          )}
        </div>
        <div>
          <div className="mb-0.5 font-semibold text-ink">训练赛倍数</div>
          倍数 = clamp({t.scrimMultBase} + (对手评分 − 本队评分) / 本队评分 × {t.scrimK}, {t.scrimMultMin}, {t.scrimMultMax})：
          {`花钱约练总比普通训练收益高——约实力不如自己的队伍也有 ×${t.scrimMultMin}，同等实力 ×${t.scrimMultBase}，对手越强越高（至多 ×${t.scrimMultMax}）。`}
          {scrimInsightBonus() !== 1 && <>训练赛双方交流 BP，灵性收益在倍数之上另 ×{scrimInsightBonus()}（任何焦点都生效）。</>}
          每支战队每个休赛回合只能约练 {scrimPerOpponentLimit()} 次，下回合重置。费用 = ({formatGold(t.scrimBaseCost)} + max(0, 对手/本队 − {t.scrimCostRatioFloor}) ×{' '}
          {formatGold(t.scrimCostPerStrengthRatio)}) × 经济指数（当前 {e}），对手越强越贵。
        </div>
        <div>
          <div className="mb-0.5 font-semibold text-ink">额外训练</div>
          价格 = {formatGold(t.extraBaseCost)} × {t.extraCostGrowth}
          <sup>本回合已购次数</sup> × (1 + {Math.round(t.extraSeasonStep * 100)}% × 本赛季已购次数，至多 ×{t.extraSeasonMaxMult}) × 经济指数（当前 {e}），
          每回合最多 {t.maxExtraPerRound} 次。每个休赛回合都加满 {t.maxExtraPerRound} 次并约训练赛，一个赛季要花掉一大笔钱，与签人、存钱之间需要取舍。
        </div>
      </div>
    </Card>
  );
}

/** 天赋 → 单次战力收益上限曲线（阴影为随机区间），点为本队队员 */
function TalentChart({ game, players, team }: { game: GameState; players: Player[]; team: Team }) {
  const W = 300;
  const H = 130;
  const pad = { l: 30, r: 8, t: 10, b: 22 };
  const base = CONFIG.growth.training.power;
  const yMax = base.min + base.spread;
  const x = (talent: number) => pad.l + (talent / 100) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / yMax) * (H - pad.t - pad.b);
  const pts: string[] = [];
  for (let t = 0; t <= 100; t += 4) pts.push(`${x(t).toFixed(1)},${y(hiOf(base, t)).toFixed(1)}`);
  const area = `M${x(0)},${y(base.min)} L${pts.join(' L')} L${x(100)},${y(base.min)} Z`;
  const starters = new Set(POSITIONS.map((p) => team.lineup?.[p]).filter(Boolean) as string[]);

  return (
    <div className="rounded-lg border border-line bg-panel-2/40 p-2">
      <div className="mb-1 text-[11px] font-semibold text-ink">天赋 → 单次战力收益区间（基准，未乘系数）</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="天赋与战力收益区间">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(yMax * f)} y2={y(yMax * f)} stroke="var(--color-line)" strokeWidth={0.5} />
            <text x={pad.l - 4} y={y(yMax * f) + 3} textAnchor="end" fontSize={8} fill="var(--color-faint)">
              {(yMax * f).toFixed(2)}
            </text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize={8} fill="var(--color-faint)">
            {t}
          </text>
        ))}
        <path d={area} fill="var(--color-gold)" opacity={0.15} />
        <polyline points={pts.join(' ')} fill="none" stroke="var(--color-gold)" strokeWidth={1.5} />
        <line x1={x(0)} x2={x(100)} y1={y(base.min)} y2={y(base.min)} stroke="var(--color-mute)" strokeDasharray="3 2" strokeWidth={0.8} />
        {players.map((p) => {
          const tal = safe(() => effectiveAttr(p, 'talent'), p.talent);
          return (
            <g key={p.id}>
              <circle
                cx={x(clamp(tal, 0, 100))}
                cy={y(hiOf(base, tal))}
                r={3.2}
                fill={starters.has(p.id) ? 'var(--color-dota-2)' : 'var(--color-info)'}
                stroke="var(--color-panel)"
                strokeWidth={1}
              >
                <title>{`${p.handle}：天赋 ${tal.toFixed(1)}，上限 ${hiOf(base, tal).toFixed(2)}（${ageOf(game, p)} 岁，系数 ×${ageFactorOf(ageOf(game, p))}）`}</title>
              </circle>
            </g>
          );
        })}
        <text x={W - pad.r} y={H - 1} textAnchor="end" fontSize={8} fill="var(--color-mute)">
          天赋
        </text>
      </svg>
      <div className="mt-1 flex gap-3 text-[10px] text-faint">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-dota-2" />首发
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-info" />替补
        </span>
        <span>阴影 = 随机落点范围</span>
      </div>
    </div>
  );
}
