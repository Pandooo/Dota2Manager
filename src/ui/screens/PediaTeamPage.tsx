// DotaPedia · 战队词条（仿 Liquipedia）：左侧章节（概述 / 历史地位 / 成就 / TI 成绩 / 赛事战绩 / 赛季数据 / 阵容变迁 / 历代队员），
// 右侧信息框（简称、赛区、状态、首次出战、荣誉、主教练、当前阵容、生涯合计）。只读。
import { useMemo, useState, type ReactNode } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { POSITION_LABEL, REGION_LABEL, TOURNAMENT_TIER_LABEL, pediaTeamPage, tiYear } from '../../engine';
import type { PediaTeamLegacy, PediaTeamPage as TeamPage, TournamentTier } from '../../engine';
import { Card, EmptyState, Gold, PosBadge, RegionBadge, TableScroll, TierBadge, cx } from '../components/common';
import { Chip } from '../components/SquadShared';
import { TourTierBadge } from '../components/TourShared';
import {
  GradeBadge, InfoHead, InfoRow, Infobox, PHONE_HIDE, PPlayer, PSection, PStat, PTour, PediaCrumbs, PediaPageLayout, PediaTitle,
  PediaToc, STICKY_TD, STICKY_TH, TIER_ORDER, fmtKda, fmtMinutes, fmtPct, placeCellClass, placeClass, safe, wdl,
} from '../components/PediaKit';
import { PLineChart, PartBars, WdlBar, type ChartDatum } from '../components/PediaCharts';
import { TeamSynergyList, hasTeamSynergies } from '../components/SynergyKit';
import { TeamBrandHistoryRow, TeamEmblem } from '../components/TeamEmblem';
import PediaTeamMission, { TeamFoundedRow, teamMissionOf } from './PediaTeamMission';

const TIERS_SHOWN: TournamentTier[] = ['ti', 'major', 'premier', 'minor'];

export default function PediaTeamPage({ id }: { id: string }) {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const page = useMemo(() => safe(() => pediaTeamPage(game, id), null), [game, version, id]);
  if (!page) {
    return (
      <div>
        <PediaCrumbs kind="team" title={id} />
        <Card>
          <EmptyState text="没有找到这支战队的词条" />
        </Card>
      </div>
    );
  }

  // 首次出战：有系列赛 / 小局或赛事名次的最早赛季（只有赛季末快照的赛季不算出战）
  const played = page.seasons
    .filter((s) => s.seriesWins + s.seriesDraws + s.seriesLosses + s.gameWins + s.gameLosses > 0)
    .map((s) => s.ti)
    .concat(page.placements.map((p) => p.season));
  const firstTi = played.length ? Math.min(...played) : null;
  const mission = teamMissionOf(game, page.id); // 第十波 #3：俱乐部使命（真实俱乐部的现实巅峰阵容）
  const toc = [
    { id: 'pt-overview', label: '概述' },
    ...(hasTeamSynergies(game, page.id) ? [{ id: 'pt-synergy', label: '羁绊' }] : []), // 第十波 #5：有激活的羁绊时显示
    { id: 'pt-legacy', label: '历史地位' },
    ...(mission ? [{ id: 'pt-mission', label: '使命' }] : []),
    { id: 'pt-achievements', label: '成就' },
    { id: 'pt-ti', label: 'TI 成绩' },
    { id: 'pt-results', label: '赛事战绩' },
    { id: 'pt-seasons', label: '赛季数据' },
    { id: 'pt-rosters', label: '阵容变迁' },
    { id: 'pt-players', label: '历代队员' },
  ];

  return (
    <div>
      <PediaCrumbs kind="team" title={page.name} />
      <PediaTitle
        sub={page.legacy?.summary}
        right={
          game.teams[page.id] ? (
            <button
              type="button"
              onClick={() => useGameStore.getState().openTeam(page.id)}
              className="cursor-pointer rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm text-ink hover:bg-panel-3 pointer-coarse:min-h-10"
              title="打开战队详情弹窗（当前阵容评分、训练赛）"
            >
              战队详情
            </button>
          ) : undefined
        }
      >
        <TeamEmblem tag={page.tag || page.name} color={page.color} teamId={page.id} size={28} />
        <span>{page.name}</span>
        {page.tag && <span className="text-base font-semibold text-mute">{page.tag}</span>}
        {page.human && <Chip tone={page.id === game.settings.playerTeamId ? 'gold' : 'info'}>{page.id === game.settings.playerTeamId ? '本方战队' : '玩家战队'}</Chip>}
        <Chip tone={page.status === 'active' ? 'good' : page.status === 'banned' ? 'bad' : 'mute'}>{page.statusLabel}</Chip>
      </PediaTitle>
      <PediaPageLayout
        main={
          <>
            <PSection id="pt-overview" title="概述">
              <Overview page={page} firstTi={firstTi} />
            </PSection>
            {hasTeamSynergies(game, page.id) && (
              <PSection id="pt-synergy" title="羁绊" right={<span>五人同队集齐 · 全队加成</span>}>
                <TeamSynergyList game={game} teamId={page.id} renderPlayer={(pid, handle) => <PPlayer id={pid} handle={handle} />} />
              </PSection>
            )}
            <PSection id="pt-legacy" title="历史地位" right={<span>实时评估，不必等生涯结束</span>}>
              {page.legacy ? <LegacyPanel lg={page.legacy} /> : <div className="text-sm text-faint">暂无数据</div>}
            </PSection>
            <PediaTeamMission view={mission} />
            <PSection id="pt-achievements" title="成就">
              <Achievements page={page} />
            </PSection>
            <PSection id="pt-ti" title="TI 成绩">
              <TiResults page={page} />
            </PSection>
            <PSection id="pt-results" title="赛事战绩" bodyClassName="p-0">
              <Results page={page} />
            </PSection>
            <PSection id="pt-seasons" title="赛季数据">
              <Seasons page={page} />
            </PSection>
            <PSection id="pt-rosters" title="阵容变迁">
              <Rosters page={page} />
            </PSection>
            <PSection id="pt-players" title="历代队员" bodyClassName="p-0">
              <Members page={page} />
            </PSection>
          </>
        }
        side={
          <>
            <TeamInfobox page={page} firstTi={firstTi} />
            <PediaToc items={toc} />
          </>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 概述（只陈述数据）
// ---------------------------------------------------------------------------
function Overview({ page, firstTi }: { page: TeamPage; firstTi: number | null }) {
  const t = page.totals;
  const series = t.seriesWins + t.seriesDraws + t.seriesLosses;
  const bits: ReactNode[] = [];
  bits.push(
    <span key="a">
      <b className="text-ink">{page.name}</b>
      {page.tag && page.tag !== page.name ? `（${page.tag}）` : ''}是一支{page.region ? `${REGION_LABEL[page.region]}赛区的` : ''}
      {page.status === 'active' ? '现役' : ''}战队{page.status !== 'active' ? `，${page.statusLabel}` : ''}。
    </span>,
  );
  if (firstTi && series > 0) {
    bits.push(
      <span key="b">
        自 TI{firstTi} 赛季起，共打出 {t.seriesWins} 胜 {t.seriesDraws} 平 {t.seriesLosses} 负的系列赛战绩（小局 {t.gameWins} 胜 {t.gameLosses} 负），
        {t.titles > 0 ? `夺得 ${t.titles} 个冠军${t.tiTitles > 0 ? `，其中包括 ${t.tiTitles} 座不朽盾` : ''}` : '尚未夺得冠军'}。
      </span>,
    );
  } else {
    bits.push(<span key="b">本局尚未留下系列赛记录。</span>);
  }
  if (page.preGame) bits.push(<span key="c">开局前（现实）：{page.preGame.summary}。</span>);
  if (page.legacy) {
    bits.push(
      <span key="d">
        按当前成就，其历史地位为「<b className="text-gold">{page.legacy.title.name}</b>」（评级 {page.legacy.grade}），
        {page.legacy.match ? `最接近现实中的 ${page.legacy.match.name}。` : ''}
      </span>,
    );
  }
  return <p className="text-sm leading-7 text-mute">{bits}</p>;
}

// ---------------------------------------------------------------------------
// 历史地位
// ---------------------------------------------------------------------------
function LegacyPanel({ lg }: { lg: PediaTeamLegacy }) {
  const pre = lg.preGame;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="flex items-center gap-3">
            <GradeBadge grade={lg.grade} size="lg" />
            <div>
              <div className="text-2xl font-bold text-gold">{lg.title.name}</div>
              <div className="text-xs text-mute">{lg.title.desc}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <PStat label="传奇值" value={lg.score} accent />
            <PStat label="本局排名" value={`${lg.rank || '—'} / ${lg.total || '—'}`} />
            <PStat label="历史排名" value={`${lg.historyRank} / ${lg.historySize}`} sub="含现实俱乐部" />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg border border-line bg-panel-2/50 px-3 py-2" title="只按本局成就计分：本局 TI 名次、冠军、赛季实力，加上按荣誉峰值计的声望（人类战队与生涯总结一致）">
              <div className="text-mute">单算本局</div>
              <div className="text-base font-semibold tabular">{lg.inGameScore}</div>
            </div>
            <div className="rounded-lg border border-line bg-panel-2/50 px-3 py-2" title="只按开局前的现实成就计分（与现实俱乐部同一口径，声望按成就估计）">
              <div className="text-mute">单算开局前（现实）</div>
              <div className="text-base font-semibold tabular">{lg.preGameScore}</div>
            </div>
          </div>
          <div className="mt-1 text-[11px] leading-5 text-faint">
            传奇值按合并后的全部成就重新计分（声望只计一次），不是两项之和；构成见右侧。
          </div>
          {lg.match && (
            <div className="mt-2 rounded-lg border border-line bg-panel-2/50 px-3 py-2 text-xs">
              <div className="text-mute">最接近的历史俱乐部</div>
              <div className="mt-0.5 text-sm font-semibold text-ink">{lg.match.name}</div>
              <div className="text-faint">
                {lg.match.title.name} · 传奇值 {lg.match.score} · {lg.match.line}
              </div>
            </div>
          )}
        </div>
        <div>
          <div className="mb-2 text-xs text-mute">传奇值构成</div>
          <PartBars parts={lg.parts} />
        </div>
      </div>
      {pre && (
        <div className="rounded-lg border border-line bg-panel-2/40 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
            <Chip>开局前（现实）</Chip>
            <span className="text-ink">{pre.clubName ?? lg.name}</span>
            <span className="text-xs text-mute">· {pre.title.name} · 传奇值 {pre.score}</span>
          </div>
          {pre.highlight && <div className="mb-2 text-xs text-mute">{pre.highlight}</div>}
          <div className="flex flex-wrap gap-1.5">
            {pre.tiResults.map((r) => (
              <span key={r.ti} title={`TI${r.ti}（${r.year}）· ${r.teamName} · ${r.label}`} className={cx('rounded border border-line px-1.5 py-0.5 text-[11px]', placeCellClass(r.rankFrom))}>
                <span className="text-mute">TI{r.ti}</span> <span className={placeClass(r.rankFrom)}>{r.label}</span>
              </span>
            ))}
          </div>
          {pre.majors.length > 0 && (
            <div className="mt-2 text-xs text-mute">
              Major 冠军：<span className="text-ink">{pre.majors.map((m) => m.name).join('、')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 成就：按等级列出冠军（含赛季），另计亚军
// ---------------------------------------------------------------------------
function Achievements({ page }: { page: TeamPage }) {
  const finals = page.placements.filter((p) => p.rankFrom === 2 && p.rankTo === 2 && p.tier !== 'qualifier');
  const tiers = TIERS_SHOWN.filter((t) => page.titles.byTier[t] > 0);
  const counts = (['ti', 'major', 'premier', 'minor'] as TournamentTier[]).map((t) => ({ t, n: page.titles.byTier[t] ?? 0 }));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {counts.map((c) => (
          <PStat key={c.t} label={`${TOURNAMENT_TIER_LABEL[c.t]} 冠军`} value={c.n} accent={c.t === 'ti' && c.n > 0} />
        ))}
        <PStat label="亚军" value={finals.length} />
      </div>
      {tiers.length === 0 ? (
        <div className="text-sm text-faint">本局尚无冠军{page.preGame ? '（开局前的现实成就见「历史地位」）' : ''}</div>
      ) : (
        <div className="space-y-2">
          {tiers.map((tier) => (
            <div key={tier} className="grid grid-cols-[minmax(0,1fr)] items-start gap-2 sm:grid-cols-[110px_minmax(0,1fr)]">
              <TourTierBadge tier={tier} className="justify-self-start" />
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {page.titles.list
                  .filter((x) => x.tier === tier)
                  .map((x) => (
                    <span key={x.tournamentId} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-gold/30 bg-gold/5 px-1.5 py-0.5 text-xs">
                      <span className="text-gold">🏆</span>
                      <span className="text-mute">TI{x.season}</span>
                      <PTour id={x.tournamentId} name={x.name} />
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {finals.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-2 sm:grid-cols-[110px_minmax(0,1fr)]">
          <span className="text-xs text-mute">亚军</span>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {finals.map((x) => (
              <span key={x.tournamentId} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded border border-line bg-panel-2/50 px-1.5 py-0.5 text-xs">
                <span className="text-mute">TI{x.season}</span>
                <PTour id={x.tournamentId} name={x.name} />
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TI 成绩（开局前的现实名次 + 本局）
// ---------------------------------------------------------------------------
function TiResults({ page }: { page: TeamPage }) {
  const real = (page.preGame?.tiResults ?? []).map((r) => ({ ti: r.ti, label: r.label, from: r.rankFrom, teams: 0, name: r.teamName, real: true }));
  const inGame = page.tiResults.map((r) => ({ ti: r.ti, label: r.label, from: r.rankFrom, teams: r.teams, name: page.name, real: false }));
  const all = [...real, ...inGame].sort((a, b) => a.ti - b.ti);
  if (!all.length) return <div className="text-sm text-faint">尚未参加过 TI 正赛</div>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {all.map((r) => (
          <div
            key={`${r.real ? 'r' : 'g'}${r.ti}`}
            title={`TI${r.ti}（${tiYear(r.ti)}）${r.real ? ` · 现实 · ${r.name}` : ''} · ${r.label}${r.teams ? ` / ${r.teams} 队` : ''}`}
            className={cx('min-w-16 rounded-lg border px-2 py-1.5 text-center', r.real ? 'border-dashed border-line' : 'border-line', placeCellClass(r.from))}
          >
            <div className="text-[11px] text-mute tabular">TI{r.ti}</div>
            <div className={cx('text-sm', placeClass(r.from))}>{r.label}</div>
            <div className="text-[10px] text-faint">{r.real ? '现实' : '本局'}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-faint">虚线框为开局前的现实历史（按同一组织合并）；实线框为本局成绩。</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛事战绩（名次表）
// ---------------------------------------------------------------------------
function Results({ page }: { page: TeamPage }) {
  const [all, setAll] = useState(false);
  const [noQual, setNoQual] = useState(false);
  const rows = page.placements.filter((p) => !noQual || p.tier !== 'qualifier');
  const shown = all ? rows : rows.slice(0, 25);
  if (!page.placements.length) return <div className="p-4 text-sm text-faint">本局尚无赛事名次</div>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs text-mute">
        <label className="inline-flex cursor-pointer items-center gap-1.5 pointer-coarse:min-h-9">
          <input type="checkbox" checked={noQual} onChange={(e) => setNoQual(e.target.checked)} />
          隐藏预选赛
        </label>
        <span>共 {rows.length} 项</span>
      </div>
      {/* 手机（< sm）：每项两行（赛季 · 等级 · 赛事 / 名次 · 奖金）；表格横向滑动时看不到名次 */}
      <ul className="divide-y divide-line/50 sm:hidden">
        {shown.map((p) => (
          <li key={p.tournamentId} className="px-4 py-2 text-sm">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs text-mute tabular">TI{p.season}</span>
              <TourTierBadge tier={p.tier} />
              <PTour id={p.tournamentId} name={p.name} className="min-w-0 flex-1" />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs">
              <span className={cx('rounded px-1', placeCellClass(p.rankFrom))}>
                <span className={placeClass(p.rankFrom)}>{p.label}</span>
                <span className="text-faint"> / {p.teams} 队</span>
              </span>
              {p.prize && (
                <span className="text-mute">
                  奖金 <Gold value={p.prize[0] + p.prize[1]} />
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="tbl">
          <thead>
            <tr>
              <th>赛季</th>
              <th>等级</th>
              <th>赛事</th>
              <th>名次</th>
              <th className="num">队伍</th>
              <th className="num" title="俱乐部所得（只记录前四名）">俱乐部奖金</th>
              <th className="num" title="队员分成（只记录前四名）">队员分成</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.tournamentId}>
                <td className="text-mute tabular">TI{p.season}</td>
                <td>
                  <TourTierBadge tier={p.tier} />
                </td>
                <td>
                  <div className="max-w-72 truncate">
                    <PTour id={p.tournamentId} name={p.name} />
                  </div>
                </td>
                <td className={cx(placeCellClass(p.rankFrom))}>
                  <span className={placeClass(p.rankFrom)}>{p.label}</span>
                </td>
                <td className="num text-mute">{p.teams}</td>
                <td className="num">{p.prize ? <Gold value={p.prize[0]} /> : <span className="text-faint">—</span>}</td>
                <td className="num">{p.prize ? <Gold value={p.prize[1]} /> : <span className="text-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 25 && (
        <div className="border-t border-line px-4 py-2 text-center">
          <button type="button" className="cursor-pointer text-xs text-info hover:text-gold pointer-coarse:min-h-9" onClick={() => setAll(!all)}>
            {all ? '收起' : `显示全部 ${rows.length} 项`}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛季数据（表 + 小图）
// ---------------------------------------------------------------------------
function Seasons({ page }: { page: TeamPage }) {
  if (!page.seasons.length) return <div className="text-sm text-faint">暂无赛季数据</div>;
  const asc = page.seasons.slice().sort((a, b) => a.ti - b.ti);
  const rateData: ChartDatum[] = asc.map((s) => ({
    key: String(s.ti), label: `TI${s.ti}`, value: s.gameWins + s.gameLosses > 0 ? s.gameWinRate * 100 : NaN,
    tip: `TI${s.ti}：小局 ${s.gameWins} 胜 ${s.gameLosses} 负（${fmtPct(s.gameWinRate)}）`,
  }));
  const rankData: ChartDatum[] = asc.map((s) => ({
    key: String(s.ti), label: `TI${s.ti}`, value: s.finalRank ?? NaN,
    tip: `TI${s.ti}：赛季综合排名 ${s.finalRank ?? '—'}${s.strengthRank ? ` · 实力第 ${s.strengthRank}/${s.strengthTeams ?? '—'}` : ''}`,
  }));
  const maxRank = Math.max(8, ...asc.map((s) => s.finalRank ?? 1));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-mute">小局胜率（%）</div>
          <PLineChart data={rateData} format={(v) => `${Math.round(v)}%`} min={0} max={100} refLine={{ value: 50, label: '50%' }} ariaLabel="分赛季小局胜率" />
        </div>
        <div>
          <div className="mb-1 text-xs text-mute">赛季综合排名（越高越好）</div>
          <PLineChart data={rankData} format={(v) => `第${Math.round(v)}`} min={1} max={maxRank} invert color="var(--color-info)" empty="尚无赛季末排名" ariaLabel="分赛季综合排名" />
        </div>
      </div>
      {/* 手机：赛季列固定在左侧，K / D 与荣誉隐藏，其余横向滑动 */}
      <TableScroll>
        <table className="tbl">
          <thead>
            <tr>
              <th className={STICKY_TH}>赛季</th>
              <th title="系列赛 胜-平-负">系列赛</th>
              <th className="num" title="小局 胜-负（胜率）；悬停查看场均时长">小局</th>
              <th className={cx('num', PHONE_HIDE)} title="击杀 / 阵亡">K / D</th>
              <th title="本赛季冠军（悬停查看赛事）">冠军</th>
              <th>TI</th>
              <th className="num" title="赛季综合排名（悬停查看赛季末实力排名）">排名</th>
              <th className={cx('num', PHONE_HIDE)} title="赛季末荣誉">荣誉</th>
              <th className="num">奖金</th>
            </tr>
          </thead>
          <tbody>
            {page.seasons.map((s) => (
              <tr key={s.ti}>
                <td className={cx('tabular', STICKY_TD)}>
                  TI{s.ti}
                  {s.partial && <span className="ml-1 text-[10px] text-info">进行中</span>}
                </td>
                <td className="w-32">
                  <WdlBar w={s.seriesWins} d={s.seriesDraws} l={s.seriesLosses} />
                </td>
                <td className="num" title={`场均时长 ${fmtMinutes(s.avgDuration)}`}>
                  {s.gameWins}-{s.gameLosses}
                  <span className="ml-1 text-[11px] text-mute">{s.gameWins + s.gameLosses > 0 ? fmtPct(s.gameWinRate) : ''}</span>
                </td>
                <td className={cx('num text-mute', PHONE_HIDE)}>
                  {s.kills} / {s.deaths}
                </td>
                <td title={s.titles.map((t) => `${t.tierLabel} · ${t.name}`).join('\n') || undefined}>
                  {s.titles.length ? <span className="text-gold">🏆 {s.titles.length}</span> : <span className="text-faint">—</span>}
                </td>
                <td className={cx(s.tiResult && placeCellClass(s.tiResult.rankFrom))}>
                  {s.tiResult ? <span className={placeClass(s.tiResult.rankFrom)}>{s.tiResult.label}</span> : <span className="text-faint">—</span>}
                </td>
                <td className="num" title={s.strengthRank ? `赛季末实力第 ${s.strengthRank} / ${s.strengthTeams ?? '—'}` : undefined}>
                  {s.finalRank ?? '—'}
                </td>
                <td className={cx('num text-mute', PHONE_HIDE)}>{s.honorEnd ?? '—'}</td>
                <td className="num">{s.prizeClub + s.prizePlayers > 0 ? <Gold value={s.prizeClub + s.prizePlayers} /> : <span className="text-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 阵容变迁（赛季末快照）+ 历任主教练
// ---------------------------------------------------------------------------
function Rosters({ page }: { page: TeamPage }) {
  const snaps = page.seasons.filter((s) => s.roster.length > 0 || s.coach);
  return (
    <div className="space-y-3">
      {page.coaches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-mute">历任主教练：</span>
          {page.coaches.map((c) => (
            <span key={`${c.id}-${c.fromTi}`} className="rounded border border-line bg-panel-2/60 px-1.5 py-0.5">
              {c.name}
              <span className="ml-1 text-faint tabular">{c.fromTi === c.toTi ? `TI${c.fromTi}` : `TI${c.fromTi}–TI${c.toTi}`}</span>
            </span>
          ))}
        </div>
      )}
      {snaps.length === 0 ? (
        <div className="text-sm text-faint">赛季结束时记录阵容快照（尚无已结算的赛季）</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>赛季</th>
              <th>赛季末阵容</th>
              <th>主教练</th>
            </tr>
          </thead>
          <tbody>
            {snaps.map((s) => {
              const prev = page.seasons.find((x) => x.ti === s.ti - 1);
              const before = new Set(prev?.roster.map((r) => r.id) ?? []);
              return (
                <tr key={s.ti}>
                  <td className="tabular">TI{s.ti}</td>
                  <td className="whitespace-normal">
                    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {s.roster.map((r) => (
                        <span key={r.id} className="inline-flex items-center gap-0.5">
                          <PPlayer id={r.id} handle={r.handle} />
                          {prev && prev.roster.length > 0 && !before.has(r.id) && (
                            <span className="text-[10px] text-good" title="较上赛季新加入">
                              新
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="text-mute">{s.coach?.name ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 历代队员
// ---------------------------------------------------------------------------
function Members({ page }: { page: TeamPage }) {
  if (!page.players.length) return <div className="p-4 text-sm text-faint">尚无队员出场记录</div>;
  return (
    // 手机：选手列固定在左侧，效力赛季与 MVP 隐藏
    <TableScroll>
      <table className="tbl">
        <thead>
          <tr>
            <th className={STICKY_TH}>选手</th>
            <th>位置</th>
            <th className={PHONE_HIDE}>效力赛季</th>
            <th className="num">局数</th>
            <th className="num">胜率</th>
            <th className="num">KDA</th>
            <th className={cx('num', PHONE_HIDE)}>MVP</th>
          </tr>
        </thead>
        <tbody>
          {page.players.map((p) => (
            <tr key={p.id} className={cx(p.current && 'bg-good/5')}>
              <td className={STICKY_TD}>
                <span className="inline-flex items-center gap-1.5">
                  <PPlayer id={p.id} handle={p.handle} />
                  {p.current && <Chip tone="good">现役</Chip>}
                </span>
              </td>
              <td>{p.position ? <PosBadge pos={p.position} /> : <span className="text-faint">—</span>}</td>
              <td className={cx('text-mute tabular', PHONE_HIDE)}>
                {p.seasons.length ? (p.seasons.length === 1 ? `TI${p.seasons[0]}` : `TI${p.seasons[0]}–TI${p.seasons[p.seasons.length - 1]}`) : '—'}
                {p.seasons.length > 1 && <span className="ml-1 text-[11px] text-faint">（{p.seasons.length} 季）</span>}
              </td>
              <td className="num">{p.games}</td>
              <td className="num">{fmtPct(p.games > 0 ? p.wins / p.games : NaN)}</td>
              <td className="num font-semibold">{fmtKda(p.kda)}</td>
              <td className={cx('num', PHONE_HIDE)}>{p.mvps || <span className="text-faint">0</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ---------------------------------------------------------------------------
// 信息框
// ---------------------------------------------------------------------------
function TeamInfobox({ page, firstTi }: { page: TeamPage; firstTi: number | null }) {
  const t = page.totals;
  const lg = page.legacy;
  const sorted = page.titles.list.slice().sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
  return (
    <Infobox
      title={page.name}
      color={page.color}
      summary={
        <>
          <InfoRow label="赛区">{page.region ? <span className="inline-flex items-center gap-1.5"><RegionBadge region={page.region} />{REGION_LABEL[page.region]}</span> : '—'}</InfoRow>
          <InfoRow label="状态">{page.statusLabel}</InfoRow>
          <InfoRow label="系列赛">
            <span className="tabular">{wdl(t.seriesWins, t.seriesDraws, t.seriesLosses)}</span>
            <span className="ml-1 text-xs text-mute">（{fmtPct(t.seriesWinRate)}）</span>
          </InfoRow>
        </>
      }
      banner={
        <div className="flex flex-col items-center gap-2">
          <div
            className={cx('grid h-20 w-28 place-items-center overflow-hidden rounded-xl border px-1 font-black tracking-wider', (page.tag || page.name).length > 6 ? 'text-lg' : 'text-2xl')}
            style={{ background: `${page.color}2e`, borderColor: `${page.color}99` }}
          >
            {page.tag || page.name.slice(0, 3)}
          </div>
          {lg && (
            <div className="flex items-center gap-2 text-sm" title={lg.title.desc}>
              <GradeBadge grade={lg.grade} />
              <span className="font-semibold text-gold">{lg.title.name}</span>
              <span className="text-xs text-mute tabular">{lg.score}</span>
            </div>
          )}
        </div>
      }
    >
      <InfoRow label="简称">{page.tag || '—'}</InfoRow>
      <TeamBrandHistoryRow teamId={page.id} />
      <TeamFoundedRow teamId={page.id} />
      <InfoRow label="赛区">{page.region ? <span className="inline-flex items-center gap-1.5"><RegionBadge region={page.region} />{REGION_LABEL[page.region]}</span> : '—'}</InfoRow>
      <InfoRow label="状态">{page.statusLabel}</InfoRow>
      <InfoRow label="首次出战">{firstTi ? `TI${firstTi} 赛季（${tiYear(firstTi)}）` : '—'}</InfoRow>
      {page.preGame && <InfoRow label="现实成就">{page.preGame.summary}</InfoRow>}
      <InfoRow label="荣誉">{page.honor ?? '—'}</InfoRow>
      <InfoRow label="上赛季排名">{page.lastSeasonRank ? `第 ${page.lastSeasonRank} 名` : '—'}</InfoRow>
      <InfoRow label="主教练">
        {page.coach ? (
          <span className="inline-flex items-center gap-1.5">
            {page.coach.name}
            <TierBadge tier={page.coach.tier} />
          </span>
        ) : (
          '—'
        )}
      </InfoRow>
      {page.roster.length > 0 && (
        <>
          <InfoHead>当前阵容</InfoHead>
          <div className="space-y-1 px-4 py-2">
            {page.roster.map((p) => (
              <div key={p.id} className="flex items-center gap-1.5" title={POSITION_LABEL[p.position]}>
                <PosBadge pos={p.position} />
                <PPlayer id={p.id} handle={p.handle} className="min-w-0 truncate" />
                {!p.starter && <span className="text-[10px] text-faint">替补</span>}
                <span className="ml-auto flex items-center gap-1.5">
                  <span className="text-[10px] text-faint tabular" title="为本队出场局数">
                    {p.games} 局
                  </span>
                  <TierBadge tier={p.tier} />
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <InfoHead>生涯合计</InfoHead>
      <InfoRow label="系列赛">
        <span className="tabular">{wdl(t.seriesWins, t.seriesDraws, t.seriesLosses)}</span>
        <span className="ml-1 text-xs text-mute">（{fmtPct(t.seriesWinRate)}）</span>
      </InfoRow>
      <InfoRow label="小局">
        <span className="tabular">
          {t.gameWins}-{t.gameLosses}
        </span>
        <span className="ml-1 text-xs text-mute">（{fmtPct(t.gameWinRate)}）</span>
      </InfoRow>
      <InfoRow label="击杀 / 阵亡">
        <span className="tabular">
          {t.kills} / {t.deaths}
        </span>
        <span className="ml-1 text-xs text-mute">K/D {t.kd.toFixed(2)}</span>
      </InfoRow>
      <InfoRow label="场均时长">{fmtMinutes(t.avgDuration)}</InfoRow>
      <InfoRow label="冠军">
        {t.titles}
        {t.tiTitles > 0 && <span className="ml-1 text-gold">（TI ×{t.tiTitles}）</span>}
        {sorted.length > 0 && <div className="truncate text-[11px] text-faint">最近：{page.titles.list[0]?.name}</div>}
      </InfoRow>
      <InfoRow label="总奖金">
        <Gold value={t.prizeTotal} />
        <div className="text-[11px] text-faint">
          俱乐部 <Gold value={t.prizeClub} className="text-[11px]" /> · 队员 <Gold value={t.prizePlayers} className="text-[11px]" />
        </div>
      </InfoRow>
      <InfoRow label="系列赛连胜">
        当前 {page.streaks.series.current} · 最长 {page.streaks.series.best}
      </InfoRow>
      <InfoRow label="小局连胜">
        当前 {page.streaks.games.current} · 最长 {page.streaks.games.best}
      </InfoRow>
    </Infobox>
  );
}
