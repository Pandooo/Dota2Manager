// 俱乐部荣誉史：荣誉/资金曲线、奖杯柜、赛季总结、赛事结算记录
import { Fragment, useState } from 'react';
import { useGame } from '../../store/gameStore';
import type { GameState, TournamentHistoryEntry, TournamentSettlement, TournamentTier } from '../../engine/types';
import { TI_YEAR, formatGold, formatRank } from '../../engine';
import { Badge, Card, Delta, EmptyState, Gold, Hint, Stat, TeamTag, cx } from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import {
  HonorBreakdownGrid, Segmented, TeamName, TourTierBadge, honorBreakdownText, openTournamentView, rankClass,
} from '../components/TourShared';
import { TourLineChart } from '../components/TourHonorChart';

const TIER_ORDER: TournamentTier[] = ['ti', 'major', 'premier', 'minor', 'qualifier'];

type ChartKey = 'honor' | 'gold';

export default function Club() {
  const game = useGame();
  const me = game.settings.playerTeamId;
  const team = game.teams[me];
  const [chart, setChart] = useState<ChartKey>('honor');
  const hist = game.history ?? { tournaments: [], seasons: [], honor: [], gold: [], playerSettlements: [] };

  if (!team) {
    return (
      <div>
        <ScreenHeader title="俱乐部荣誉史" />
        <Card>
          <EmptyState text="找不到你的俱乐部数据" />
        </Card>
      </div>
    );
  }

  const trophies = (hist.tournaments ?? []).filter((h) => h.championId === me);
  const tiTrophies = trophies.filter((h) => h.tier === 'ti');
  const runnerUps = (hist.tournaments ?? []).filter((h) => h.placements?.[me]?.[0] === 2 && h.placements?.[me]?.[1] === 2).length;
  const top4 = (hist.tournaments ?? []).filter((h) => {
    const p = h.placements?.[me];
    return p && p[0] >= 3 && p[0] <= 4;
  }).length;
  const honorSeries = (hist.honor ?? []).slice();
  const goldSeries = (hist.gold ?? []).slice();
  const peakHonor = Math.max(team.honor, ...honorSeries.map((h) => h.value).filter(Number.isFinite));
  const settlements = (hist.playerSettlements ?? []).slice();
  const totalPrize = settlements.reduce((s, x) => s + (x.prize ?? 0) + (x.appearanceFee ?? 0), 0);
  const seasonsDone = (hist.seasons ?? []).length;

  const chartData = chart === 'honor' ? honorSeries : goldSeries;

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="俱乐部荣誉史"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <TeamTag color={team.color} tag={team.tag} />
            <span>{team.name}</span>
            <span className="text-faint">· 经理 {game.settings.managerName}</span>
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="当前荣誉" value={<span className={team.honor < 50 ? 'text-bad' : ''}>{Math.round(team.honor)}</span>} hint="低于 0 战队解散" />
        <Stat label="荣誉峰值" value={Math.round(peakHonor)} />
        <Stat label="TI 冠军" value={<span className={tiTrophies.length ? 'text-gold' : ''}>{tiTrophies.length}</span>} hint="不朽盾" />
        <Stat label="赛事冠军" value={trophies.length} hint={`亚军 ${runnerUps} · 四强 ${top4}`} />
        <Stat label="累计奖金+出场费" value={<Gold value={totalPrize} />} hint={`${settlements.length} 项赛事`} />
        <Stat label="完成赛季" value={seasonsDone} hint={`TI${game.settings.startTi} → TI${game.settings.endTi}`} />
      </div>

      <Card
        title={chart === 'honor' ? '荣誉走势' : '资金走势'}
        subtitle="每个大回合结束时记录；虚线为赛季分隔"
        actions={
          <Segmented<ChartKey>
            value={chart}
            onChange={setChart}
            options={[
              { key: 'honor', label: '荣誉' },
              { key: 'gold', label: '资金' },
            ]}
          />
        }
      >
        {chartData.length === 0 ? (
          <EmptyState text="推进回合后将开始记录历史曲线。" />
        ) : chart === 'honor' ? (
          <TourLineChart points={chartData} color="#e5b24d" dangerLine={0} dangerLabel="解散线" />
        ) : (
          <TourLineChart points={chartData} color="#4cc38a" formatValue={(v) => formatGold(v)} dangerLine={0} dangerLabel="欠薪线" />
        )}
      </Card>

      <TrophyCabinet game={game} trophies={trophies} />

      <SeasonTable game={game} />

      <SettlementTable game={game} settlements={settlements} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 奖杯柜
// ---------------------------------------------------------------------------
function TrophyCabinet({ game, trophies }: { game: GameState; trophies: TournamentHistoryEntry[] }) {
  const ti = trophies.filter((h) => h.tier === 'ti').sort((a, b) => a.season - b.season);
  const others = trophies.filter((h) => h.tier !== 'ti').sort(
    (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.season - a.season,
  );
  const byTier = TIER_ORDER.filter((t) => t !== 'ti').map((tier) => ({ tier, list: others.filter((h) => h.tier === tier) }));

  return (
    <Card title="奖杯柜" subtitle={trophies.length ? `共 ${trophies.length} 座冠军奖杯` : undefined}>
      {trophies.length === 0 ? (
        <EmptyState text="奖杯柜还空着。赢下第一项赛事，把奖杯摆进来吧！目标：捧起不朽盾（TI 冠军）。" />
      ) : (
        <div className="space-y-4">
          {ti.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {ti.map((h) => (
                <button
                  key={`${h.season}-${h.tournamentId}`}
                  onClick={() => game.tournaments[h.tournamentId] && openTournamentView(game, h.tournamentId)}
                  className="glow relative cursor-pointer overflow-hidden rounded-xl border border-gold/70 bg-gradient-to-br from-gold/25 via-[#3a2a10]/60 to-panel p-4 text-left"
                  title={h.name}
                >
                  <div className="pointer-events-none absolute -right-6 -top-6 text-[96px] leading-none text-gold/10">♛</div>
                  <div className="flex items-center gap-3">
                    <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-gold bg-gold/20 text-2xl text-gold">♛</div>
                    <div className="min-w-0">
                      <div className="text-[11px] tracking-[0.2em] text-gold/80">不朽盾 · AEGIS</div>
                      <div className="truncate text-lg font-black text-gold">TI{h.season} 冠军</div>
                      <div className="truncate text-xs text-mute">
                        {h.name} · {TI_YEAR[h.season] ?? ''}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {byTier
            .filter((g) => g.list.length > 0)
            .map((g) => (
              <div key={g.tier}>
                <div className="mb-2 flex items-center gap-2">
                  <TourTierBadge tier={g.tier} />
                  <span className="text-xs text-faint">× {g.list.length}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {g.list.map((h) => {
                    const pl = h.placements?.[h.championId];
                    return (
                      <div
                        key={`${h.season}-${h.tournamentId}`}
                        className={cx(
                          'flex items-center gap-2.5 rounded-lg border px-3 py-2',
                          g.tier === 'major' ? 'border-dota/40 bg-dota/10' : 'border-line bg-panel-2/60',
                        )}
                      >
                        <span className={cx('text-xl', g.tier === 'major' ? 'text-dota-2' : g.tier === 'premier' ? 'text-tier-s' : 'text-mute')}>★</span>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium" title={h.name}>
                            {h.name}
                          </div>
                          <div className="text-[11px] text-faint">
                            TI{h.season} 赛季{pl ? ` · ${pl[2]} 队参赛` : ''}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 赛季总结
// ---------------------------------------------------------------------------
function SeasonTable({ game }: { game: GameState }) {
  const seasons = (game.history?.seasons ?? []).slice().sort((a, b) => b.ti - a.ti);
  return (
    <Card title="赛季总结" subtitle="每届 TI 结束后记录" bodyClassName="p-0">
      {seasons.length === 0 ? (
        <EmptyState text="第一个赛季尚未结束。TI 结算后将在这里留下赛季总结。" />
      ) : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>赛季</th>
                <th className="num">积分排名</th>
                <th>TI 成绩</th>
                <th>冠军</th>
                <th className="num">荣誉</th>
                <th className="num">资金</th>
                <th>TI 冠军</th>
                <th>退役</th>
              </tr>
            </thead>
            <tbody>
              {seasons.map((s) => {
                const dh = (s.honorEnd ?? 0) - (s.honorStart ?? 0);
                const dg = (s.goldEnd ?? 0) - (s.goldStart ?? 0);
                return (
                  <tr key={s.ti} title={s.notes?.length ? s.notes.join('\n') : undefined}>
                    <td>
                      <span className="font-semibold">TI{s.ti}</span>
                      <span className="ml-1.5 text-xs text-faint">{s.year}</span>
                    </td>
                    <td className={cx('num', s.finalRank <= 3 ? 'font-semibold text-gold' : '')}>#{s.finalRank}</td>
                    <td>
                      {s.playerTiRank ? (
                        <span className={rankClass(s.playerTiRank[0])}>
                          {s.playerTiRank[0] === 1 && s.playerTiRank[1] === 1 ? '♛ ' : ''}
                          {formatRank(s.playerTiRank[0], s.playerTiRank[1])}
                        </span>
                      ) : (
                        <span className="text-faint">未参加</span>
                      )}
                    </td>
                    <td className="max-w-56">
                      {s.playerTitles?.length ? (
                        <span className="text-gold" title={s.playerTitles.join('\n')}>
                          {s.playerTitles.length} 冠 <span className="text-xs text-mute">· {s.playerTitles.slice(0, 2).join('、')}{s.playerTitles.length > 2 ? '…' : ''}</span>
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="num">
                      <span className="text-mute">{Math.round(s.honorStart)}→</span>
                      <span>{Math.round(s.honorEnd)}</span> <Delta value={Math.round(dh)} />
                    </td>
                    <td className="num">
                      <Gold value={s.goldEnd} /> <span className={cx('text-xs', dg >= 0 ? 'text-good' : 'text-bad')}>({dg >= 0 ? '+' : ''}{formatGold(dg)})</span>
                    </td>
                    <td className="text-xs">{s.tiChampionId ? <TeamName game={game} teamId={s.tiChampionId} /> : <span className="text-faint">—</span>}</td>
                    <td className="text-xs text-mute" title={s.retired?.join('、')}>
                      {s.retired?.length ? `${s.retired.length} 人` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 赛事结算记录
// ---------------------------------------------------------------------------
function SettlementTable({ game, settlements }: { game: GameState; settlements: TournamentSettlement[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = settlements.slice().reverse();
  const meta = (id: string) => {
    const t = game.tournaments[id];
    if (t) return { name: t.name, tier: t.tier, season: t.season, exists: true };
    const h = game.history?.tournaments?.find((x) => x.tournamentId === id);
    if (h) return { name: h.name, tier: h.tier, season: h.season, exists: false };
    return { name: id, tier: undefined, season: undefined, exists: false };
  };
  const honorSum = rows.reduce((s, x) => s + (x.honor?.total ?? 0), 0);

  return (
    <Card
      title="赛事结算记录"
      subtitle={rows.length ? `共 ${rows.length} 项 · 赛事荣誉累计 ${honorSum >= 0 ? '+' : ''}${Math.round(honorSum)}` : undefined}
      bodyClassName="p-0"
    >
      {rows.length === 0 ? (
        <EmptyState text="还没有参加过任何赛事。" />
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>赛季</th>
                <th>赛事</th>
                <th>等级</th>
                <th>名次</th>
                <th className="num">奖金</th>
                <th className="num">出场费</th>
                <th className="num">积分</th>
                <th className="num" title="悬停查看明细，点击展开">荣誉</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s, i) => {
                const m = meta(s.tournamentId);
                const key = `${s.tournamentId}-${i}`;
                const expanded = open === key;
                return (
                  <Fragment key={key}>
                    <tr className={cx('cursor-pointer', expanded && 'bg-panel-2/70')} onClick={() => setOpen(expanded ? null : key)}>
                      <td className="text-mute">{m.season ? `TI${m.season}` : '—'}</td>
                      <td className="max-w-64">
                        <span className="flex items-center gap-1.5">
                          <span className="text-faint">{expanded ? '▾' : '▸'}</span>
                          {m.exists ? (
                            <button
                              className="cursor-pointer truncate hover:text-gold hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                openTournamentView(game, s.tournamentId);
                              }}
                            >
                              {m.name}
                            </button>
                          ) : (
                            <span className="truncate">{m.name}</span>
                          )}
                        </span>
                      </td>
                      <td>{m.tier ? <TourTierBadge tier={m.tier} /> : <span className="text-faint">—</span>}</td>
                      <td>
                        <span className={rankClass(s.rankFrom)}>{formatRank(s.rankFrom, s.rankTo)}</span>
                        <span className="ml-1 text-[11px] text-faint">/ {s.teams}</span>
                      </td>
                      <td className="num">
                        <Gold value={s.prize ?? 0} />
                      </td>
                      <td className="num">
                        <Gold value={s.appearanceFee ?? 0} className="text-gold/70" />
                      </td>
                      <td className="num">{Math.round(s.points ?? 0)}</td>
                      <td className="num" title={s.honor ? honorBreakdownText(s.honor) : undefined}>
                        {s.honor ? <Delta value={Math.round(s.honor.total)} /> : '—'}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={8} className="bg-panel-2/40 !whitespace-normal">
                          <div className="grid gap-4 py-1 md:grid-cols-2">
                            {s.honor ? <HonorBreakdownGrid h={s.honor} /> : <Hint>无荣誉明细</Hint>}
                            <div>
                              <div className="mb-1 text-[11px] text-faint">赛事成长</div>
                              {s.playerGrowth?.length ? (
                                <div className="flex flex-wrap gap-1.5">
                                  {s.playerGrowth.map((g) => (
                                    <Badge key={g.playerId} className="bg-panel-3 text-mute">
                                      {game.players[g.playerId]?.handle ?? g.playerId}
                                      {(g.resilience ?? 0) > 0 && <span className="ml-1 text-gold">韧性+{(g.resilience ?? 0).toFixed(1)}</span>}
                                      <span className="ml-1 text-good">战力+{(g.power ?? 0).toFixed(1)}</span>
                                      <span className="ml-1 text-info">天梯+{Math.round(g.mmr ?? 0)}</span>
                                    </Badge>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-xs text-faint">无记录</span>
                              )}
                            </div>
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
      )}
    </Card>
  );
}

