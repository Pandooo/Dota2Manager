// DotaPedia · 英雄：按赛季的出场 / 胜率 / 禁用 / K/D/A 表（来自已记录的对局），点击英雄查看分赛季趋势与常用选手
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { heroById, pediaHeroStats, pediaHeroTrend, pediaSeasons, tiYear } from '../../engine';
import type { GameState, PediaHeroRow } from '../../engine';
import { Card, EmptyState, TableScroll, cx } from '../components/common';
import { SortTh, sortList, useSort } from '../components/SquadShared';
import { TourSelect } from '../components/TourShared';
import {
  PHONE_HIDE, PPlayer, PStat, PTeam, PediaEntryGuard, PediaInput, PediaSortSelect, STICKY_TD, STICKY_TH, fmt1, fmtKda, fmtPct, openPedia, safe, usePediaSel,
} from '../components/PediaKit';
import { BREAKPOINT, matchesQuery } from '../mobile';
import { MeterBar, PBarChart, PLineChart, type ChartDatum } from '../components/PediaCharts';

type SortKey = 'name' | 'picks' | 'pickRate' | 'winRate' | 'bans' | 'kda' | 'kills';

export default function PediaHeroes() {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const sel = usePediaSel('hero', game);
  const seasons = useMemo(() => safe(() => pediaSeasons(game), [] as number[]), [game, version]);
  const [season, setSeason] = useState('all');
  const [q, setQ] = useState('');
  const [minPicks, setMinPicks] = useState('0');
  const sort = useSort<SortKey>('picks');
  const ti = season === 'all' ? undefined : Number(season);
  const rows = useMemo(() => safe(() => pediaHeroStats(game, { ti }), [] as PediaHeroRow[]), [game, version, ti]);
  const totalBans = rows.reduce((a, r) => a + r.bans, 0);

  const query = q.trim().toLowerCase();
  const min = Number(minPicks) || 0;
  const filtered = rows.filter((r) => r.picks >= min && (!query || `${r.cn} ${r.name} ${r.heroId}`.toLowerCase().includes(query)));
  const sorted = sortList(
    filtered,
    (r) => {
      switch (sort.key) {
        case 'name':
          return r.cn;
        case 'picks':
          return r.picks;
        case 'pickRate':
          return r.pickRate;
        case 'winRate':
          return r.winRate + r.picks * 1e-9;
        case 'bans':
          return r.bans;
        case 'kda':
          return r.kda;
        case 'kills':
          return r.picks > 0 ? r.kills / r.picks : 0;
      }
    },
    sort.dir,
  );
  const topPicks = Math.max(1, ...rows.map((r) => r.picks));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PediaInput value={q} onChange={setQ} placeholder="按中文 / 英文名筛选" className="w-full sm:w-48" />
        <TourSelect value={season} onChange={setSeason} title="赛季">
          <option value="all">全部赛季</option>
          {seasons.map((s) => (
            <option key={s} value={String(s)}>
              TI{s} 赛季（{tiYear(s)}）
            </option>
          ))}
        </TourSelect>
        <TourSelect value={minPicks} onChange={setMinPicks} title="最少出场次数（排除样本过少的胜率）">
          <option value="0">不限出场</option>
          <option value="10">≥ 10 场</option>
          <option value="20">≥ 20 场</option>
          <option value="50">≥ 50 场</option>
          <option value="100">≥ 100 场</option>
        </TourSelect>
        <PediaSortSelect
          sort={sort}
          options={[
            { key: 'picks', label: '出场' },
            { key: 'pickRate', label: '出场率' },
            { key: 'winRate', label: '胜率' },
            { key: 'bans', label: '被禁' },
            { key: 'kda', label: 'KDA' },
            { key: 'kills', label: '场均击杀' },
            { key: 'name', label: '英雄名', defaultDir: 'asc' },
          ]}
        />
        <span className="ml-auto text-xs text-faint">
          出场率 = 出场 / 对局数；被禁只统计有完整 BP 的对局{totalBans === 0 ? '（暂无）' : ''}
        </span>
      </div>

      {/* < xl：英雄详情排在列表之前（点选后滚动到详情），不用滑到上百行之后才看到 */}
      <div className={cx('grid grid-cols-[minmax(0,1fr)] gap-4', sel && 'xl:grid-cols-[minmax(0,1fr)_380px]')}>
        <Card bodyClassName="p-0" className="min-w-0">
          {sorted.length === 0 ? (
            <EmptyState text={rows.length ? '没有符合条件的英雄' : '还没有已记录的对局'} />
          ) : (
            // 手机：英雄列固定在左侧，序号、出场率、胜-负、K / D / A 隐藏（可用上方的排序选择）
            <TableScroll>
              <table className="tbl">
                <thead>
                  <tr>
                    <th className={cx('num', PHONE_HIDE)}>#</th>
                    <SortTh k="name" sort={sort} defaultDir="asc" className={STICKY_TH}>英雄</SortTh>
                    <SortTh k="picks" sort={sort}>出场</SortTh>
                    <SortTh k="pickRate" sort={sort} className={cx('num', PHONE_HIDE)}>出场率</SortTh>
                    <SortTh k="winRate" sort={sort} className="num">胜率</SortTh>
                    {!sel && <th className={cx('num', PHONE_HIDE)}>胜-负</th>}
                    <SortTh k="bans" sort={sort} className="num">被禁</SortTh>
                    {!sel && <SortTh k="kills" sort={sort} className={cx('num', PHONE_HIDE)} title="场均 击杀 / 阵亡 / 助攻">K / D / A</SortTh>}
                    <SortTh k="kda" sort={sort} className="num">KDA</SortTh>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr
                      key={r.heroId}
                      className={cx('cursor-pointer', sel === r.heroId && 'bg-gold/10')}
                      onClick={() => openPedia('hero', sel === r.heroId ? null : r.heroId, { replace: true, scroll: false })}
                      title="点击查看分赛季趋势与常用选手"
                    >
                      <td className={cx('num text-faint', PHONE_HIDE)}>{i + 1}</td>
                      <td className={STICKY_TD}>
                        <span className="font-medium text-ink">{r.cn}</span>
                        <span className="ml-1.5 text-[11px] text-faint max-sm:hidden">{r.name}</span>
                      </td>
                      <td className={cx(sel ? 'w-28' : 'w-40', 'max-sm:min-w-24')}>
                        <div className="flex items-center gap-2">
                          <span className="w-10 text-right tabular">{r.picks}</span>
                          <MeterBar value={r.picks} max={topPicks} className="flex-1" />
                        </div>
                      </td>
                      <td className={cx('num text-mute', PHONE_HIDE)}>{fmtPct(r.pickRate)}</td>
                      <td className={cx('num', r.picks >= 20 && r.winRate >= 0.55 && 'text-good', r.picks >= 20 && r.winRate <= 0.45 && 'text-bad')}>{fmtPct(r.winRate)}</td>
                      {!sel && (
                        <td className={cx('num text-mute', PHONE_HIDE)}>
                          {r.wins}-{r.picks - r.wins}
                        </td>
                      )}
                      <td className="num text-mute">{r.bans || '—'}</td>
                      {!sel && (
                        <td className={cx('num text-mute', PHONE_HIDE)}>
                          {r.picks > 0 ? `${fmt1(r.kills / r.picks)} / ${fmt1(r.deaths / r.picks)} / ${fmt1(r.assists / r.picks)}` : '—'}
                        </td>
                      )}
                      <td className="num font-semibold">{fmtKda(r.kda)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </Card>
        {sel && (
          <PediaEntryGuard key={sel} kind="hero">
            <HeroDetail game={game} heroId={sel} row={rows.find((r) => r.heroId === sel) ?? null} ti={ti} />
          </PediaEntryGuard>
        )}
      </div>
    </div>
  );
}

function HeroDetail({ game, heroId, row, ti }: { game: GameState; heroId: string; row: PediaHeroRow | null; ti?: number }) {
  const version = useGameStore((s) => s.version);
  const hero = heroById(heroId);
  const trend = useMemo(() => safe(() => pediaHeroTrend(game, heroId), []), [game, version, heroId]);
  // 常用选手：DotaPedia 选手档案中的英雄记录（生涯口径，每人只保留最常用的若干英雄）
  const players = useMemo(() => {
    const out: { id: string; games: number; wins: number }[] = [];
    for (const [id, e] of Object.entries(game.pedia?.players ?? {})) {
      const v = e?.h?.[heroId];
      if (v && v[0] > 0) out.push({ id, games: v[0], wins: v[1] });
    }
    return out.sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, 10);
  }, [game, version, heroId]);
  const picks: ChartDatum[] = trend.map((t) => ({ key: String(t.ti), label: `TI${t.ti}`, value: t.picks, highlight: t.ti === ti, tip: `TI${t.ti}：出场 ${t.picks}（${fmtPct(t.pickRate)}）· 被禁 ${t.bans}` }));
  const wr: ChartDatum[] = trend.map((t) => ({ key: String(t.ti), label: `TI${t.ti}`, value: t.picks > 0 ? t.winRate * 100 : NaN, highlight: t.ti === ti, tip: `TI${t.ti}：${t.wins} 胜 / ${t.picks} 场（${fmtPct(t.winRate)}）` }));
  // < xl：详情排在列表之前，点选英雄后滚动到详情（列表很长，否则看不到点选的结果）
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!matchesQuery(`(min-width: ${BREAKPOINT.xl}px)`, true)) anchor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [heroId]);
  return (
    <Card
      title={
        <span>
          {hero?.cn ?? heroId}
          <span className="ml-2 text-xs font-normal text-mute">{hero?.name}</span>
        </span>
      }
      subtitle={ti !== undefined ? `表格为 TI${ti} 赛季；趋势与常用选手为全部赛季` : '全部赛季'}
      actions={
        <button type="button" className="cursor-pointer text-xs text-mute hover:text-ink pointer-coarse:min-h-9 pointer-coarse:px-2" onClick={() => openPedia('hero', null, { replace: true, scroll: false })}>
          关闭
        </button>
      }
      className="h-fit max-xl:order-first xl:sticky xl:top-0"
    >
      <div ref={anchor} className="scroll-mt-16" />
      {row ? (
        <div className="grid grid-cols-2 gap-2">
          <PStat label="出场" value={row.picks} sub={`出场率 ${fmtPct(row.pickRate)}`} />
          <PStat label="胜率" value={fmtPct(row.winRate)} sub={`${row.wins} 胜 ${row.picks - row.wins} 负`} accent />
          <PStat label="被禁" value={row.bans} />
          <PStat label="KDA" value={fmtKda(row.kda)} sub={row.picks > 0 ? `场均 ${fmt1(row.kills / row.picks)}/${fmt1(row.deaths / row.picks)}/${fmt1(row.assists / row.picks)}` : undefined} />
        </div>
      ) : (
        <div className="text-xs text-faint">所选赛季没有该英雄的出场记录</div>
      )}
      <div className="mt-4">
        <div className="mb-1 text-xs text-mute">分赛季出场</div>
        <PBarChart data={picks} height={120} ariaLabel="分赛季出场" />
      </div>
      <div className="mt-3">
        <div className="mb-1 text-xs text-mute">分赛季胜率（%）</div>
        <PLineChart data={wr} height={120} format={(v) => `${Math.round(v)}%`} min={0} max={100} refLine={{ value: 50, label: '50%' }} color="var(--color-info)" ariaLabel="分赛季胜率" />
      </div>
      <div className="mt-4">
        <div className="mb-1.5 text-xs text-mute">常用选手</div>
        {players.length === 0 ? (
          <div className="text-xs text-faint">暂无</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>选手</th>
                <th>战队</th>
                <th className="num">局数</th>
                <th className="num">胜率</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const sp = game.players[p.id];
                return (
                  <tr key={p.id}>
                    <td>
                      <PPlayer id={p.id} />
                    </td>
                    <td className="max-w-28">{sp?.teamId ? <PTeam id={sp.teamId} tag /> : <span className="text-faint">—</span>}</td>
                    <td className="num">{p.games}</td>
                    <td className="num">{fmtPct(p.wins / p.games)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}
