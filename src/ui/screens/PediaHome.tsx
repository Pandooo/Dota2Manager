// DotaPedia 总览：联赛历史数据、TI 冠军时间线、实时历史地位榜（不必等生涯结束）、各类排行榜与单局纪录
import { useMemo, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { isHumanTeam, pediaDashboard, pediaTeamLegacy, tiYear } from '../../engine';
import type { GameState, PediaBoard, PediaBoardRow, PediaTeamLegacy } from '../../engine';
import { Card, EmptyState, TableScroll, cx } from '../components/common';
import { Chip } from '../components/SquadShared';
import { TourSelect } from '../components/TourShared';
import {
  CoverageNote, GradeBadge, PHONE_HIDE, PHero, PPlayer, PStat, PTeam, STICKY_TD, STICKY_TH, fmt1, fmtInt, fmtMinutes, fmtPct, openPedia, safe, tipOnTap,
} from '../components/PediaKit';
import { MeterBar, PBarChart, PLineChart, WdlBar, type ChartDatum } from '../components/PediaCharts';
import { BREAKPOINT, useMinWidth } from '../mobile';

export default function PediaHome() {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const [season, setSeason] = useState('all');
  const ti = season === 'all' ? undefined : Number(season);
  const dash = useMemo(() => safe(() => pediaDashboard(game, { ti, limit: 10 }), null), [game, version, ti]);

  if (!dash) return <Card><EmptyState text="DotaPedia 数据暂不可用" /></Card>;
  const ov = dash.overview;
  const seasonRow = ti !== undefined ? game.pedia?.seasons?.[String(ti)] : undefined;
  const games = seasonRow ? seasonRow[0] : ov.games;
  const avgKills = seasonRow ? (seasonRow[0] > 0 ? seasonRow[1] / seasonRow[0] : 0) : ov.avgKills;
  const avgDur = seasonRow ? (seasonRow[0] > 0 ? seasonRow[2] / seasonRow[0] : 0) : ov.avgDuration;
  const boards = new Map(dash.boards.map((b) => [b.id, b]));
  const pick = (...ids: string[]) => ids.map((id) => boards.get(id)).filter((b): b is PediaBoard => !!b);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-mute">
          刀塔经理世界的百科全书：TI{ov.startTi} 至今的战队、选手、赛事与英雄数据 · <CoverageNote game={game} />
        </div>
        <div className="flex items-center gap-2 text-xs text-mute">
          <span>排行榜范围</span>
          <TourSelect value={season} onChange={setSeason} title="排行榜按赛季筛选（连胜、单局纪录与历史地位为生涯口径）">
            <option value="all">全部赛季</option>
            {dash.seasons.map((s) => (
              <option key={s} value={String(s)}>
                TI{s} 赛季（{tiYear(s)}）
              </option>
            ))}
          </TourSelect>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <PStat label={ti !== undefined ? `TI${ti} 对局` : '已记录对局'} value={fmtInt(games)} accent />
        <PStat label="系列赛" value={fmtInt(ov.series)} sub="生涯合计" />
        <PStat label="正式赛事" value={fmtInt(ov.tournaments)} sub="不含预选赛" />
        <PStat label="场均击杀" value={fmt1(avgKills)} sub="双方合计" />
        <PStat label="场均时长" value={fmtMinutes(avgDur)} />
        <PStat label="出场选手" value={fmtInt(ov.playersWithGames)} />
        <PStat label="现役战队" value={fmtInt(ov.activeTeams)} />
        <PStat label="记录赛季" value={fmtInt(ov.seasonsRecorded)} sub={`当前 TI${ov.currentTi}`} />
      </div>

      {/* 网格一律带单列基准（minmax(0,1fr)）：窄屏时卡片不会被不换行的副标题 / 图表撑出屏幕 */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <MyTeamCard game={game} />
        <TrendCard game={game} highlightTi={ti} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <TiChampionsCard rows={dash.tiChampions} />
        <LegacyBoardCard game={game} rows={dash.legacy} />
      </div>

      <div>
        <h2 className="mb-2 text-[15px] font-semibold tracking-wide">
          排行榜{ti !== undefined && <span className="ml-2 text-xs font-normal text-mute">TI{ti} 赛季</span>}
        </h2>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-3">
          {pick('teamTitles', 'teamWinRate', 'teamPrize', 'teamStreak', 'playerKda', 'playerMvp', 'playerWinRate', 'playerKills', 'playerPrize', 'playerStreak', 'heroPicks', 'heroWinRate').map((b) => (
            <BoardCard key={b.id} game={game} board={b} />
          ))}
        </div>
      </div>

      <RecordsCard dash={dash} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本方战队：实时历史地位
// ---------------------------------------------------------------------------
function MyTeamCard({ game }: { game: GameState }) {
  const me = game.settings.playerTeamId;
  const lg = safe(() => pediaTeamLegacy(game, me), null);
  if (!lg) {
    return (
      <Card title="我的战队 · 历史地位">
        <EmptyState text="暂无数据" />
      </Card>
    );
  }
  return (
    <Card
      title="我的战队 · 历史地位"
      subtitle="不必等生涯结束：按当前成就实时评估（开局前的现实成就 + 本局成就）"
      actions={
        <button type="button" className="cursor-pointer text-xs text-info hover:text-gold hover:underline pointer-coarse:min-h-9" onClick={() => openPedia('team', me)}>
          战队词条 ›
        </button>
      }
    >
      <div className="flex flex-wrap items-start gap-4">
        <div
          className={cx('grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-xl border border-line px-1 font-black tracking-wide', (lg.tag?.length ?? 0) > 4 ? 'text-sm' : 'text-lg')}
          style={{ background: `${lg.color}33`, borderColor: `${lg.color}88` }}
        >
          {lg.tag || '—'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <PTeam id={lg.teamId} name={lg.name} color={lg.color} className="text-base" />
            <GradeBadge grade={lg.grade} />
          </div>
          <div className="mt-1 text-2xl font-bold text-gold" title={lg.title.desc}>
            {lg.title.name}
          </div>
          <div className="text-xs text-mute">{lg.title.desc}</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <PStat
          label="传奇值"
          value={lg.score}
          sub={`本局 ${lg.inGameScore} · 开局前 ${lg.preGameScore}`}
          title={`单算本局 ${lg.inGameScore} · 单算开局前（现实）${lg.preGameScore}；传奇值按合并后的全部成就重新计分（声望只计一次），不是两项之和`}
          accent
        />
        <PStat label="本局排名" value={`${lg.rank} / ${lg.total}`} sub="全部战队" />
        <PStat label="历史排名" value={`${lg.historyRank} / ${lg.historySize}`} sub="插入现实俱乐部榜" />
      </div>
      <div className="mt-1 text-[11px] text-faint">「本局」「开局前」各自单算；传奇值按合并后的全部成就重新计分（声望只计一次），不是两者之和。</div>
      <MyRecord game={game} teamId={me} />
      {lg.match && (
        <div className="mt-3 rounded-lg border border-line bg-panel-2/50 px-3 py-2 text-xs">
          <span className="text-mute">最接近的历史俱乐部：</span>
          <span className="font-semibold text-ink">{lg.match.name}</span>
          <span className="text-mute"> · {lg.match.title.name} · 传奇值 {lg.match.score}</span>
          <div className="mt-0.5 text-faint">{lg.match.line}</div>
        </div>
      )}
    </Card>
  );
}

/** 本方生涯战绩：系列赛胜平负、小局、击杀 / 阵亡、冠军数 */
function MyRecord({ game, teamId }: { game: GameState; teamId: string }) {
  let sw = 0, sd = 0, sl = 0, gw = 0, gl = 0, k = 0, d = 0;
  for (const r of game.pedia?.teams?.[teamId]?.s ?? []) {
    sw += r.sw || 0;
    sd += r.sd || 0;
    sl += r.sl || 0;
    gw += r.gw || 0;
    gl += r.gl || 0;
    k += r.k || 0;
    d += r.d || 0;
  }
  const titles = (game.history?.tournaments ?? []).filter((h) => h.championId === teamId && h.tier !== 'qualifier').length;
  if (sw + sd + sl === 0) return <div className="mt-3 text-xs text-faint">本局尚无系列赛记录</div>;
  return (
    <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-xs">
      <span className="text-mute">系列赛</span>
      <WdlBar w={sw} d={sd} l={sl} />
      <span className="text-mute">小局</span>
      {/* 每一项不在中间折行（窄屏时整项换到下一行） */}
      <span className="tabular">
        <span className="inline-block whitespace-nowrap">
          {gw}-{gl}
          <span className="ml-1 text-mute">（胜率 {fmtPct(gw + gl > 0 ? gw / (gw + gl) : NaN)}）</span>
        </span>
        <span className="ml-3 inline-block whitespace-nowrap">
          <span className="text-mute">K/D</span> {k} / {d}
        </span>
        <span className="ml-3 inline-block whitespace-nowrap">
          <span className="text-mute">冠军</span> <span className="text-gold">{titles}</span>
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 联赛趋势：每赛季对局数 / 场均击杀 / 场均时长
// ---------------------------------------------------------------------------
function TrendCard({ game, highlightTi }: { game: GameState; highlightTi?: number }) {
  const rows = Object.entries(game.pedia?.seasons ?? {})
    .map(([k, v]) => ({ ti: Number(k), games: v?.[0] ?? 0, kills: v?.[1] ?? 0, minutes: v?.[2] ?? 0 }))
    .filter((r) => Number.isFinite(r.ti))
    .sort((a, b) => a.ti - b.ti);
  const gamesData: ChartDatum[] = rows.map((r) => ({
    key: String(r.ti), label: `TI${r.ti}`, value: r.games, highlight: r.ti === highlightTi, tip: `TI${r.ti} 赛季：${r.games} 局`,
  }));
  const killData: ChartDatum[] = rows.map((r) => ({
    key: String(r.ti), label: `TI${r.ti}`, value: r.games > 0 ? r.kills / r.games : NaN, highlight: r.ti === highlightTi,
    tip: `TI${r.ti} 赛季：场均 ${r.games > 0 ? (r.kills / r.games).toFixed(1) : '—'} 杀 · 场均 ${fmtMinutes(r.games > 0 ? r.minutes / r.games : 0)}`,
  }));
  return (
    <Card title="联赛趋势" subtitle="每个赛季全联盟的对局数与场均击杀（双方合计）">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-mute">每赛季对局数</div>
          <PBarChart data={gamesData} format={(v) => String(Math.round(v))} ariaLabel="每赛季对局数" />
        </div>
        <div>
          <div className="mb-1 text-xs text-mute">场均击杀</div>
          <PLineChart data={killData} format={(v) => v.toFixed(1)} color="var(--color-info)" ariaLabel="每赛季场均击杀" />
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// TI 冠军时间线（含开局前的真实 TI）
// ---------------------------------------------------------------------------
/** 窄屏（< lg）先列出的现实冠军届数（其余点「显示全部」） */
const REAL_TI_PREVIEW = 4;

function TiChampionsCard({ rows }: { rows: ReturnType<typeof pediaDashboard>['tiChampions'] }) {
  const inGame = rows.filter((r) => !r.real);
  const allReal = rows.filter((r) => r.real);
  // 手机 / 平板：不用卡片内滚动（滑动会被卡片吞掉、页面滚不动），现实历史只先列几届
  const wide = useMinWidth(BREAKPOINT.lg);
  const [more, setMore] = useState(false);
  const real = wide || more ? allReal : allReal.slice(0, REAL_TI_PREVIEW);
  const line = (r: (typeof rows)[number]) => (
    <li key={`${r.real ? 'r' : 'g'}-${r.ti}`} className="relative grid grid-cols-[56px_minmax(0,1fr)] gap-2 py-1.5 pl-4">
      <span className={cx('absolute left-0 top-[11px] h-2 w-2 rounded-full', r.real ? 'bg-faint' : 'bg-gold')} />
      <div className="leading-tight">
        <div className={cx('text-sm font-semibold tabular', r.real ? 'text-mute' : 'text-gold')}>TI{r.ti}</div>
        <div className="text-[11px] text-faint tabular">{r.year}</div>
      </div>
      <div className="min-w-0 text-sm">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-gold">🏆</span>
          <PTeam id={r.championId} name={r.championName} noSwatch={r.real} className="font-semibold" />
        </div>
        <div className="flex min-w-0 items-center gap-1 text-xs text-mute">
          <span className="shrink-0">亚军</span>
          <PTeam id={r.runnerUpId} name={r.runnerUpName} noSwatch className="text-xs" />
        </div>
      </div>
    </li>
  );
  return (
    <Card title="TI 冠军" subtitle="本局冠军（金）与开局前的现实历史（灰）" bodyClassName="p-4 lg:max-h-[460px] lg:overflow-y-auto">
      {rows.length === 0 ? (
        <EmptyState text="尚无 TI 冠军" />
      ) : (
        <ol className="border-l border-line">
          {inGame.length === 0 && <li className="py-1.5 pl-4 text-xs text-faint">本局还没有决出 TI 冠军</li>}
          {inGame.map(line)}
          {real.length > 0 && (
            <li className="py-1 pl-4">
              <Chip>开局前（现实）</Chip>
            </li>
          )}
          {real.map(line)}
          {real.length < allReal.length && (
            <li className="pl-4 pt-1">
              <button type="button" className="min-h-9 cursor-pointer text-xs text-info hover:text-gold" onClick={() => setMore(true)}>
                显示全部 {allReal.length} 届 ▾
              </button>
            </li>
          )}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 历史地位榜
// ---------------------------------------------------------------------------
/** 窄屏（< lg）历史地位榜先列出的战队数（本方总会列出） */
const LEGACY_PREVIEW = 10;

function LegacyBoardCard({ game, rows }: { game: GameState; rows: PediaTeamLegacy[] }) {
  const me = game.settings.playerTeamId;
  const mine = rows.some((r) => r.teamId === me) ? null : safe(() => pediaTeamLegacy(game, me), null);
  const all = mine ? [...rows, mine] : rows;
  const top = Math.max(1, ...all.map((r) => r.score));
  // 手机 / 平板：不用卡片内滚动（滑动会被吞掉），先列前 10 名 + 本方，可展开全部
  const wide = useMinWidth(BREAKPOINT.lg);
  const [more, setMore] = useState(false);
  const cut = !wide && !more && all.length > LEGACY_PREVIEW + 1;
  const list = cut ? all.filter((r, i) => i < LEGACY_PREVIEW || r.teamId === me) : all;
  return (
    <Card
      title="历史地位榜"
      subtitle="实时传奇值：开局前的现实成就 + 本局成就（TI 名次、冠军、赛季实力、声望）"
      actions={
        <button type="button" className="cursor-pointer text-xs text-info hover:text-gold hover:underline pointer-coarse:min-h-9" onClick={() => openPedia('team', null)}>
          全部战队 ›
        </button>
      }
      bodyClassName="p-0 lg:max-h-[460px] lg:overflow-y-auto"
    >
      {all.length === 0 ? (
        <EmptyState text="暂无数据" />
      ) : (
        // 手机：横向滑动、战队列固定在左侧，名次并入战队列；「历史」「最接近的历史俱乐部」隐藏（战队词条里有）
        <TableScroll>
          <table className="tbl">
            <thead>
              <tr>
                <th className={cx('num', PHONE_HIDE)}>#</th>
                <th className={STICKY_TH}>战队</th>
                <th>称号</th>
                <th title="评级">级</th>
                <th className="w-40 max-sm:w-28">传奇值</th>
                <th className={PHONE_HIDE} title="插入现实俱乐部历史排行榜后的名次">历史</th>
                <th className={PHONE_HIDE}>最接近的历史俱乐部</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const human = isHumanTeam(game, r.teamId);
                const sep = !!mine && r === mine;
                return (
                  <tr key={r.teamId} className={cx(r.teamId === me && 'bg-gold/5', sep && 'border-t-2 border-gold/40')}>
                    <td className={cx('num text-mute', PHONE_HIDE)}>{r.rank}</td>
                    <td className={STICKY_TD}>
                      <div className="flex max-w-44 items-center gap-1.5 max-sm:max-w-[9.5rem]">
                        <span className="w-5 shrink-0 text-right text-xs text-mute tabular sm:hidden">{r.rank}</span>
                        <PTeam id={r.teamId} name={r.name} color={r.color} />
                        {human && <Chip tone={r.teamId === me ? 'gold' : 'info'}>{r.teamId === me ? '本方' : '玩家'}</Chip>}
                        {!r.active && <Chip>已解散</Chip>}
                      </div>
                    </td>
                    <td title={r.title.desc} {...tipOnTap(r.title.desc)} className={cx(r.title.id === 'unknown' ? 'text-faint' : 'text-ink')}>
                      {r.title.name}
                    </td>
                    <td>
                      <GradeBadge grade={r.grade} />
                    </td>
                    <td
                      title={`单算本局 ${r.inGameScore} · 单算开局前 ${r.preGameScore}（合并后重新计分，不是两项之和）`}
                      {...tipOnTap(`单算本局 ${r.inGameScore} · 单算开局前 ${r.preGameScore}（合并后重新计分，不是两项之和）`)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="w-12 text-right font-semibold tabular max-sm:w-9">{r.score}</span>
                        <MeterBar value={r.score} max={top} className="flex-1" />
                      </div>
                    </td>
                    <td className={cx('text-mute tabular', PHONE_HIDE)}>
                      {r.historyRank}/{r.historySize}
                    </td>
                    <td className={cx('max-w-48 truncate text-xs text-mute', PHONE_HIDE)} title={r.match?.line}>
                      {r.match ? r.match.name : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      {cut && (
        <div className="border-t border-line px-4 py-1.5 text-center">
          <button type="button" className="min-h-9 cursor-pointer text-xs text-info hover:text-gold" onClick={() => setMore(true)}>
            显示全部 {all.length} 支战队 ▾
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 排行榜
// ---------------------------------------------------------------------------
function BoardCard({ game, board }: { game: GameState; board: PediaBoard }) {
  const me = game.settings.playerTeamId;
  const isMine = (r: PediaBoardRow) =>
    (r.kind === 'team' && r.id === me) || (r.kind === 'player' && (game.players[r.id]?.teamId === me || r.teamId === me));
  return (
    <Card title={board.title} subtitle={board.note} bodyClassName="p-0">
      {board.rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-faint">暂无达到门槛的数据</div>
      ) : (
        <ol className="divide-y divide-line/50">
          {board.rows.map((r) => (
            <li key={`${r.kind}-${r.id}`} className={cx('grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 px-4 py-1.5 text-sm', isMine(r) && 'bg-gold/5')}>
              <span className={cx('text-right text-xs tabular', r.rank <= 3 ? 'font-semibold text-gold' : 'text-faint')}>{r.rank}</span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  {r.kind === 'team' && <PTeam id={r.id} name={r.name} />}
                  {r.kind === 'player' && <PPlayer id={r.id} handle={r.name} className="truncate" />}
                  {r.kind === 'hero' && <PHero id={r.id} name={r.name} />}
                  {r.kind === 'player' && r.teamId && (
                    <span className="min-w-0 truncate text-[11px] text-faint">· {r.teamName}</span>
                  )}
                </div>
                {r.sub && <div className="break-words text-[11px] text-faint max-sm:line-clamp-2 sm:truncate">{r.sub}</div>}
              </div>
              <span className="text-right font-semibold tabular">{r.display}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 单局纪录
// ---------------------------------------------------------------------------
function RecordsCard({ dash }: { dash: NonNullable<ReturnType<typeof pediaDashboard>> }) {
  return (
    <Card title="单局纪录" subtitle="全部赛季的单局之最（先创造者保持，追平不替换）" bodyClassName="p-0">
      {dash.records.length === 0 ? (
        <EmptyState text="还没有任何对局纪录" />
      ) : (
        <>
        {/* 手机（< sm）：每条纪录一张两三行的小卡片（表格有 7 列，横向滑动看不全） */}
        <ul className="divide-y divide-line/50 sm:hidden">
          {dash.records.map((r) => (
            <li key={r.kind} className="px-4 py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-mute">{r.label}</span>
                <span className="shrink-0 font-semibold text-gold tabular">{r.display}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {r.playerId ? (
                  <>
                    <PPlayer id={r.playerId} handle={r.playerName} />
                    {r.heroId && (
                      <>
                        <span className="text-faint">·</span>
                        <PHero id={r.heroId} name={r.heroName ?? r.heroId} className="text-mute" />
                      </>
                    )}
                    <span className="text-faint">·</span>
                  </>
                ) : null}
                <PTeam id={r.teamId} name={r.teamName} />
                <span className="text-xs text-faint">vs</span>
                <PTeam id={r.oppId} name={r.oppName} noSwatch className="text-mute" />
              </div>
              <div className="mt-0.5 text-[11px] text-faint tabular">
                TI{r.ti} · {r.date} · {r.tierLabel}
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto sm:block">
          <table className="tbl">
            <thead>
              <tr>
                <th>纪录</th>
                <th className="num">数值</th>
                <th>选手 / 英雄</th>
                <th>战队</th>
                <th>对手</th>
                <th>时间</th>
                <th>赛事等级</th>
              </tr>
            </thead>
            <tbody>
              {dash.records.map((r) => (
                <tr key={r.kind}>
                  <td className="text-mute">{r.label}</td>
                  <td className="num font-semibold text-gold">{r.display}</td>
                  <td>
                    {r.playerId ? (
                      <span className="inline-flex items-center gap-1.5">
                        <PPlayer id={r.playerId} handle={r.playerName} />
                        {r.heroId && (
                          <>
                            <span className="text-faint">·</span>
                            <PHero id={r.heroId} name={r.heroName ?? r.heroId} className="text-mute" />
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td>
                    <PTeam id={r.teamId} name={r.teamName} />
                  </td>
                  <td>
                    <PTeam id={r.oppId} name={r.oppName} />
                  </td>
                  <td className="text-mute tabular">
                    TI{r.ti} · {r.date}
                  </td>
                  <td className="text-mute">{r.tierLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Card>
  );
}
