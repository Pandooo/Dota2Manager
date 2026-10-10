// 训练页 · 赛季汇总：本赛季（可切换）训练次数/花费/训练赛战绩、各选手累计收益、各焦点平均收益。
import { useState } from 'react';
import { POSITIONS, trainingSummary } from '../../engine';
import type { FocusTrainingStats, GameState, TrainingSummary } from '../../engine';
import { Card, Delta, EmptyState, Gold, PlayerLink, PosBadge, Stat, cx } from './common';
import { Chip, safe } from './SquadShared';
import { FOCUS_INFO, FOCUS_ORDER } from './TrainingShared';

const fmt = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '—');

export default function TrainingSeasonSummary({ game }: { game: GameState }) {
  const records = game.history?.training ?? [];
  const seasons = [...new Set([game.season.ti, ...records.map((r) => r.season)])].sort((a, b) => b - a);
  const [season, setSeason] = useState(game.season.ti);
  const sum = safe(() => trainingSummary(game, season), null as TrainingSummary | null);
  const me = game.settings.playerTeamId;
  const team = game.teams[me];
  const starters = new Set(POSITIONS.map((p) => team?.lineup?.[p]).filter(Boolean) as string[]);
  const isCurrent = season === game.season.ti;
  const prog = game.history?.squadProgress ?? {};

  const seasonSelect = (
    <select
      value={season}
      onChange={(e) => setSeason(Number(e.target.value))}
      className="cursor-pointer rounded border border-line bg-panel-2 px-1.5 py-0.5 text-xs text-ink [color-scheme:dark]"
    >
      {seasons.map((s) => (
        <option key={s} value={s}>
          TI{s} 赛季{s === game.season.ti ? '（本赛季）' : ''}
        </option>
      ))}
    </select>
  );

  if (!sum || sum.sessions === 0) {
    return (
      <Card title="赛季训练汇总" actions={seasonSelect}>
        <EmptyState text={isCurrent ? '本赛季还没有训练记录。休赛回合训练或约训练赛后，这里会汇总各选手的累计收益与花费。' : '该赛季没有训练记录。'} />
      </Card>
    );
  }

  const avgMult = (() => {
    const scrims = records.filter((r) => r.season === season && r.kind === 'scrim');
    return scrims.length ? scrims.reduce((s, r) => s + r.mult, 0) / scrims.length : 0;
  })();

  /** 快照变化：该赛季首个快照 → 当前（本赛季）或该赛季最后一个快照（往届） */
  const snapDelta = (id: string): number => {
    const pts = (prog[id] ?? []).filter((p) => p.season === season);
    if (!pts.length) return NaN;
    const end = isCurrent ? game.players[id]?.power ?? pts[pts.length - 1].power : pts[pts.length - 1].power;
    return end - pts[0].power;
  };

  const best = (k: 'power' | 'mmr' | 'insight', per: 'avg' | 'avgPerPlayer') => {
    let top: string | null = null;
    let v = -Infinity;
    for (const f of FOCUS_ORDER) {
      const st = sum.byFocus[f];
      if (st.sessions > 0 && st[per][k] > v) {
        v = st[per][k];
        top = f;
      }
    }
    return top;
  };

  return (
    <div className="space-y-4">
      <Card title="赛季训练汇总" subtitle={`TI${season} 赛季 · 全部训练（含训练赛与回合结束自动训练）`} actions={seasonSelect}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="训练次数"
            value={sum.sessions}
            hint={`免费 ${sum.byKind.free} · 额外 ${sum.byKind.extra} · 训练赛 ${sum.byKind.scrim} · 自动 ${sum.byKind.auto}`}
          />
          <Stat
            label="训练花费"
            value={<Gold value={sum.totalSpend} />}
            hint={
              <>
                额外训练 <Gold value={sum.trainingSpend} /> · 约练 <Gold value={sum.scrimSpend} />
              </>
            }
          />
          <Stat
            label="训练赛战绩"
            value={
              sum.scrims ? (
                <span>
                  <span className="text-good">{sum.scrimWins}</span> 胜 <span className="text-bad">{sum.scrims - sum.scrimWins}</span> 负
                </span>
              ) : (
                <span className="text-faint">未约练</span>
              )
            }
            hint={sum.scrims ? `平均收益倍数 ×${avgMult.toFixed(2)}` : '约练强队可获得更高收益倍数'}
          />
          <Stat
            label="全队累计收益"
            value={
              <span className="text-good">
                +{fmt(sum.totals.power, 1)} <span className="text-xs font-normal text-mute">战力</span>
              </span>
            }
            hint={`天梯 +${Math.round(sum.totals.mmr)} · 灵性 +${fmt(sum.totals.insight, 1)} · 天赋 +${fmt(sum.totals.talent, 1)}`}
          />
        </div>
      </Card>

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card title="选手累计收益" subtitle="所选赛季训练带来的属性变化；「快照变化」含赛事、版本与事件等全部因素" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>选手</th>
                  <th>角色</th>
                  <th className="num">次数</th>
                  <th className="num">Δ战力</th>
                  <th className="num">Δ天梯</th>
                  <th className="num">Δ灵性</th>
                  <th className="num">Δ天赋</th>
                  <th className="num">Δ韧性</th>
                  <th className="num" title="该赛季首个回合快照 → 当前（往届为赛季末）的战力变化，含赛事成长、版本与事件">
                    快照变化
                  </th>
                </tr>
              </thead>
              <tbody>
                {sum.players.map((pt, i) => {
                  const p = game.players[pt.playerId];
                  const onTeam = !!p && p.teamId === me;
                  const sd = snapDelta(pt.playerId);
                  return (
                    <tr key={pt.playerId}>
                      <td>
                        <span className="inline-flex items-center gap-1.5">
                          {p ? <PosBadge pos={p.position} /> : null}
                          {p ? <PlayerLink player={p} /> : <span className="text-mute">{pt.handle}</span>}
                          {i === 0 && pt.power > 0 && <span title="本赛季训练战力收益最高">★</span>}
                        </span>
                      </td>
                      <td>{!onTeam ? <Chip>已离队</Chip> : starters.has(pt.playerId) ? <Chip tone="gold">首发</Chip> : <Chip>替补</Chip>}</td>
                      <td className="num text-mute">{pt.sessions}</td>
                      <td className="num">
                        <Delta value={pt.power} digits={2} />
                      </td>
                      <td className="num">
                        <Delta value={pt.mmr} />
                      </td>
                      <td className="num">
                        <Delta value={pt.insight} digits={2} />
                      </td>
                      <td className="num">
                        <Delta value={pt.talent} digits={2} />
                      </td>
                      <td className="num">
                        <Delta value={pt.resilience} digits={2} />
                      </td>
                      <td className="num">{Number.isFinite(sd) ? <Delta value={sd} digits={2} /> : <span className="text-faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="各焦点平均收益" subtitle="每次训练的全队合计 / 每名队员平均（训练赛已含倍数加成）" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>焦点</th>
                  <th className="num">次数</th>
                  <th className="num" title="平均收益倍数（训练赛 > 1）">倍数</th>
                  <th className="num">战力/次</th>
                  <th className="num">天梯/次</th>
                  <th className="num">灵性/次</th>
                  <th className="num" title="每名队员每次训练的平均战力收益">人均战力</th>
                </tr>
              </thead>
              <tbody>
                {FOCUS_ORDER.map((f) => (
                  <FocusRow
                    key={f}
                    focus={f}
                    st={sum.byFocus[f]}
                    current={game.trainingFocus === f && isCurrent}
                    bests={{ power: best('power', 'avg'), mmr: best('mmr', 'avg'), insight: best('insight', 'avg'), pp: best('power', 'avgPerPlayer') }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2.5 text-xs leading-relaxed text-mute">
            金色为该列最高。收益受阵容人数、年龄与软上限影响：老将多、属性接近上限时，同一焦点的收益会逐渐下降，可据此调整焦点或约练更强的对手。
          </p>
        </Card>
      </div>
    </div>
  );
}

function FocusRow({
  focus,
  st,
  current,
  bests,
}: {
  focus: (typeof FOCUS_ORDER)[number];
  st: FocusTrainingStats;
  current: boolean;
  bests: { power: string | null; mmr: string | null; insight: string | null; pp: string | null };
}) {
  const info = FOCUS_INFO[focus];
  const none = st.sessions === 0;
  const hl = (b: string | null) => (!none && b === focus ? 'font-semibold text-gold' : '');
  return (
    <tr className={cx(none && 'opacity-50')}>
      <td>
        <span className="inline-flex items-center gap-1.5">
          {info.icon} {info.title}
          {current && <Chip tone="dota">当前</Chip>}
        </span>
      </td>
      <td className="num">{st.sessions}</td>
      <td className="num text-mute">{none ? '—' : `×${st.avgMult.toFixed(2)}`}</td>
      <td className={cx('num', hl(bests.power))}>{none ? '—' : `+${fmt(st.avg.power, 2)}`}</td>
      <td className={cx('num', hl(bests.mmr))}>{none ? '—' : `+${Math.round(st.avg.mmr)}`}</td>
      <td className={cx('num', hl(bests.insight))}>{none ? '—' : `+${fmt(st.avg.insight, 2)}`}</td>
      <td className={cx('num', hl(bests.pp))}>{none ? '—' : `+${fmt(st.avgPerPlayer.power, 2)}`}</td>
    </tr>
  );
}
