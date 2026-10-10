// 训练页 · 训练历史：history.training 时间线（最新在前），按赛季/类型筛选，分页，可展开查看每名选手收益。
import { Fragment, useState } from 'react';
import { CONFIG } from '../../engine';
import type { GameState, TrainingRecord, TrainingRecordKind } from '../../engine';
import { Button, Card, Delta, EmptyState, Gold, TeamTag, cx } from './common';
import { FOCUS_INFO, GainsTable, RecordKindChip, costBreakdown, recordWhen, sumGains } from './TrainingShared';

const PAGE_SIZE = 25;
const KIND_FILTERS: (TrainingRecordKind | 'all')[] = ['all', 'free', 'extra', 'scrim', 'auto'];
const KIND_FILTER_LABEL: Record<TrainingRecordKind | 'all', string> = { all: '全部', free: '免费', extra: '额外', scrim: '训练赛', auto: '自动' };

export default function TrainingHistory({ game }: { game: GameState }) {
  const all = game.history?.training ?? [];
  const seasons = [...new Set(all.map((r) => r.season))].sort((a, b) => b - a);
  const [season, setSeason] = useState<number | 'all'>(() => (seasons.includes(game.season.ti) ? game.season.ti : 'all'));
  const [kind, setKind] = useState<TrainingRecordKind | 'all'>('all');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<TrainingRecord>>(() => new Set());

  const filtered: TrainingRecord[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i];
    if ((season === 'all' || r.season === season) && (kind === 'all' || r.kind === kind)) filtered.push(r);
  }
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageIdx = Math.min(page, pages - 1);
  const shown = filtered.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);
  const spend = filtered.reduce((s, r) => s + (r.cost || 0), 0);
  const totals = sumGains(filtered.flatMap((r) => r.gains));

  const toggle = (r: TrainingRecord) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(r)) next.delete(r);
      else next.add(r);
      return next;
    });

  return (
    <Card
      title="训练历史"
      subtitle={`每次训练（含训练赛与回合结束自动训练）的记录 · 最多保留最近 ${CONFIG.training.logMaxRecords} 条`}
      bodyClassName="p-0"
      actions={
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={season}
            onChange={(e) => {
              setSeason(e.target.value === 'all' ? 'all' : Number(e.target.value));
              setPage(0);
            }}
            className="cursor-pointer rounded border border-line bg-panel-2 px-1.5 py-0.5 text-xs text-ink [color-scheme:dark]"
          >
            <option value="all">全部赛季</option>
            {seasons.map((s) => (
              <option key={s} value={s}>
                TI{s} 赛季
              </option>
            ))}
          </select>
          <div className="flex overflow-hidden rounded-md border border-line">
            {KIND_FILTERS.map((k) => (
              <button
                key={k}
                onClick={() => {
                  setKind(k);
                  setPage(0);
                }}
                className={cx(
                  'cursor-pointer px-2 py-0.5 transition-colors',
                  kind === k ? 'bg-dota/20 text-ink' : 'bg-panel-2/50 text-mute hover:text-ink',
                )}
              >
                {KIND_FILTER_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {all.length === 0 ? (
        <EmptyState text="还没有训练记录。在休赛回合训练或约训练赛后，这里会按时间记录每一次的收益与花费。" />
      ) : filtered.length === 0 ? (
        <EmptyState text="没有符合筛选条件的记录。" />
      ) : (
        <>
          <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line px-4 py-2 text-xs text-mute">
            <span>
              共 <b className="tabular text-ink">{filtered.length}</b> 次
            </span>
            <span>
              花费 <Gold value={spend} />
            </span>
            <span>
              全队 战力 <Delta value={totals.power} digits={1} /> · 天梯 <Delta value={totals.mmr} /> · 灵性 <Delta value={totals.insight} digits={1} />
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>焦点</th>
                  <th className="num" title="训练赛收益倍数">倍数</th>
                  <th className="num" title="训练赛费用 + 所消耗额外训练的购买价">花费</th>
                  <th className="num">Δ战力</th>
                  <th className="num">Δ天梯</th>
                  <th className="num">Δ灵性</th>
                  <th className="num">人数</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const open = expanded.has(r);
                  const s = sumGains(r.gains);
                  const target = r.scrimTargetId ? game.teams[r.scrimTargetId] : undefined;
                  return (
                    <Fragment key={`${pageIdx}-${i}`}>
                      <tr className="cursor-pointer" onClick={() => toggle(r)}>
                        <td className="whitespace-nowrap">
                          <span className="text-ink">{recordWhen(game, r.season, r.round)}</span>
                          <span className="ml-1.5 text-[11px] text-faint">{r.date}</span>
                        </td>
                        <td className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <RecordKindChip kind={r.kind} />
                            {r.kind === 'scrim' && (
                              <>
                                {target ? <TeamTag color={target.color} tag={target.tag} /> : <span className="text-faint">对手</span>}
                                <span className={cx('text-xs font-semibold', r.scrimWon ? 'text-good' : 'text-bad')}>{r.scrimWon ? '胜' : '负'}</span>
                              </>
                            )}
                            {r.session === 'extra' && r.kind !== 'extra' && <span className="text-[10px] text-faint">（已购次数）</span>}
                          </span>
                        </td>
                        <td>
                          {FOCUS_INFO[r.focus]?.icon} {FOCUS_INFO[r.focus]?.title ?? '均衡'}
                        </td>
                        <td className={cx('num', r.mult > 1.001 ? 'text-gold' : r.mult < 0.999 ? 'text-bad' : 'text-faint')}>×{r.mult.toFixed(2)}</td>
                        <td className="num" title={costBreakdown(r) || undefined}>
                          {r.cost > 0 ? <Gold value={r.cost} /> : <span className="text-faint">免费</span>}
                        </td>
                        <td className="num">
                          <Delta value={s.power} digits={2} />
                        </td>
                        <td className="num">
                          <Delta value={s.mmr} />
                        </td>
                        <td className="num">
                          <Delta value={s.insight} digits={2} />
                        </td>
                        <td className="num text-mute">{r.gains.length}</td>
                        <td className="text-right text-xs text-faint">{open ? '▾' : '▸'}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} className="bg-panel-2/40" style={{ padding: 0 }}>
                            <div className="px-3 py-2">
                              <GainsTable game={game} gains={r.gains} showCurrent={false} showRole={false} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2 text-xs text-mute">
              <Button size="xs" variant="ghost" disabled={pageIdx <= 0} onClick={() => setPage(pageIdx - 1)}>
                ‹ 上一页
              </Button>
              <span className="tabular">
                {pageIdx + 1} / {pages}
              </span>
              <Button size="xs" variant="ghost" disabled={pageIdx >= pages - 1} onClick={() => setPage(pageIdx + 1)}>
                下一页 ›
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
