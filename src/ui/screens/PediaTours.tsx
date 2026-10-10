// DotaPedia · 赛事：历届赛事列表（按赛季 / 等级筛选；冠亚军与本方名次）→ 赛事词条（名次、奖金、冠亚军 / TI 正赛首发）
import { useMemo, useState } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { PEDIA_TIERS, TOURNAMENT_TIER_LABEL, formatRank, pediaSeasons, pediaTournament, pediaTournaments, tiYear } from '../../engine';
import type { GameState, PediaTournamentRow, TournamentHistoryEntry, TournamentTier } from '../../engine';
import { Card, EmptyState, Gold, cx } from '../components/common';
import { Chip } from '../components/SquadShared';
import { Segmented, TourSelect, TourTierBadge, openTournamentView } from '../components/TourShared';
import {
  InfoRow, Infobox, PPlayer, PSection, PTeam, PTour, PediaCrumbs, PediaPageLayout, PediaTitle, fmtUsd, placeCellClass, placeClass,
  safe, usePediaSel,
  PediaEntryGuard,
} from '../components/PediaKit';

export default function PediaTours() {
  const game = useGame();
  const sel = usePediaSel('tournament', game);
  if (sel) {
    return (
      <PediaEntryGuard key={sel} kind="tournament">
        <TourPage id={sel} />
      </PediaEntryGuard>
    );
  }
  return <TourList game={game} />;
}

const STATUS_LABEL: Record<PediaTournamentRow['status'], string> = { finished: '已结束', running: '进行中', scheduled: '未开始' };

/** 本方在某赛事中的名次 / 状态（byId：赛事史按 id 索引） */
function myResult(
  game: GameState,
  row: PediaTournamentRow,
  byId: Map<string, TournamentHistoryEntry>,
): { text: string; rank: number | null } | null {
  const me = game.settings.playerTeamId;
  const h = byId.get(row.id);
  const pl = h?.placements?.[me];
  if (pl) return { text: formatRank(pl[0], pl[1]), rank: pl[0] };
  const live = game.tournaments[row.id];
  if (live && row.status !== 'finished' && (live.teamIds ?? []).includes(me)) {
    const lp = (live.placements ?? []).find((p) => p.teamId === me);
    return lp ? { text: formatRank(lp.rankFrom, lp.rankTo), rank: lp.rankFrom } : { text: '参赛中', rank: null };
  }
  return null;
}

function TourList({ game }: { game: GameState }) {
  const version = useGameStore((s) => s.version);
  const seasons = useMemo(() => safe(() => pediaSeasons(game), [] as number[]), [game, version]);
  const [season, setSeason] = useState<string>(() => String(game.season?.ti ?? 'all'));
  const [tier, setTier] = useState<'all' | TournamentTier>('all');
  const [mine, setMine] = useState(false);
  // 默认只看已赛 / 进行中；赛季初本季还没有开赛的赛事时默认显示全部（否则列表为空）
  const [state, setState] = useState<'played' | 'all' | 'scheduled'>(() =>
    safe(() => pediaTournaments(game, { ti: game.season?.ti }).some((r) => r.status !== 'scheduled'), true) ? 'played' : 'all',
  );
  const ti = season === 'all' ? undefined : Number(season);
  const rows = useMemo(
    () => safe(() => pediaTournaments(game, { ti, tier: tier === 'all' ? undefined : tier }), [] as PediaTournamentRow[]),
    [game, version, ti, tier],
  );
  const histById = useMemo(
    () => new Map((game.history?.tournaments ?? []).map((h) => [h.tournamentId, h] as [string, TournamentHistoryEntry])),
    [game, version],
  );
  const withMine = rows
    .filter((r) => (state === 'all' ? true : state === 'scheduled' ? r.status === 'scheduled' : r.status !== 'scheduled'))
    .map((r) => ({ r, my: myResult(game, r, histById) }))
    .filter((x) => !mine || x.my);
  const me = game.settings.playerTeamId;

  // 按赛季分组（全部赛季时）
  const groups = new Map<number, typeof withMine>();
  for (const x of withMine) {
    const list = groups.get(x.r.season) ?? [];
    list.push(x);
    groups.set(x.r.season, list);
  }
  const seasonOpts = seasons.includes(game.season?.ti ?? -1) ? seasons : [game.season.ti, ...seasons];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <TourSelect value={season} onChange={setSeason} title="赛季">
          <option value="all">全部赛季</option>
          {seasonOpts.map((s) => (
            <option key={s} value={String(s)}>
              TI{s} 赛季（{tiYear(s)}）
            </option>
          ))}
        </TourSelect>
        <TourSelect value={tier} onChange={(v) => setTier(v as 'all' | TournamentTier)} title="赛事等级">
          <option value="all">全部等级</option>
          {PEDIA_TIERS.map((t) => (
            <option key={t} value={t}>
              {TOURNAMENT_TIER_LABEL[t]}
            </option>
          ))}
        </TourSelect>
        <Segmented
          value={state}
          onChange={setState}
          options={[
            { key: 'played', label: '已赛 / 进行中' },
            { key: 'scheduled', label: '未开始' },
            { key: 'all', label: '全部' },
          ]}
        />
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-mute">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          只看本方参加的赛事
        </label>
        <span className="ml-auto text-xs text-faint">共 {withMine.length} 项</span>
      </div>

      {withMine.length === 0 ? (
        <Card>
          <EmptyState text="没有符合条件的赛事" />
        </Card>
      ) : (
        [...groups.entries()].map(([s, list]) => (
          <Card key={s} title={`TI${s} 赛季 · ${tiYear(s)}`} subtitle={`${list.length} 项赛事`} bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>等级</th>
                    <th>赛事</th>
                    <th>冠军</th>
                    <th>亚军</th>
                    <th>本方</th>
                    <th className="num">队伍</th>
                    <th className="num">奖金池</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(({ r, my }) => (
                    <tr key={r.id} className={cx(my && 'bg-gold/[0.03]', r.championId === me && 'bg-gold/10')}>
                      <td className="text-mute tabular">{r.date || '—'}</td>
                      <td>
                        <TourTierBadge tier={r.tier} />
                      </td>
                      <td>
                        <div className="max-w-56 truncate">
                          <PTour id={r.id} name={r.name} className="font-medium" />
                        </div>
                      </td>
                      <td>{r.championId ? <PTeam id={r.championId} name={r.championName} className="max-w-36" /> : <span className="text-faint">—</span>}</td>
                      <td>{r.runnerUpId ? <PTeam id={r.runnerUpId} name={r.runnerUpName} className="max-w-36" /> : <span className="text-faint">—</span>}</td>
                      <td className={cx(my?.rank ? placeCellClass(my.rank) : null)}>
                        {my ? <span className={my.rank ? placeClass(my.rank) : 'text-info'}>{my.text}</span> : <span className="text-faint">—</span>}
                      </td>
                      <td className="num text-mute">{r.teams || '—'}</td>
                      <td className="num text-mute">{fmtUsd(r.prizePool)}</td>
                      <td className={cx('text-xs', r.status === 'running' ? 'text-info' : r.status === 'scheduled' ? 'text-faint' : 'text-mute')}>{STATUS_LABEL[r.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

function TourPage({ id }: { id: string }) {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const page = useMemo(() => safe(() => pediaTournament(game, id), null), [game, version, id]);
  if (!page) {
    return (
      <div>
        <PediaCrumbs kind="tournament" title={id} />
        <Card>
          <EmptyState text="没有找到这项赛事的词条" />
        </Card>
      </div>
    );
  }
  const me = game.settings.playerTeamId;
  const inCenter = (game.seasonTournamentIds ?? []).includes(page.id) && !!game.tournaments[page.id];
  const anyPrize = page.placements.some((p) => p.prize);
  const anyLineup = page.placements.some((p) => p.lineup && p.lineup.length);
  return (
    <div>
      <PediaCrumbs kind="tournament" title={page.name} />
      <PediaTitle
        sub={`TI${page.season} 赛季 · ${page.tierLabel}${page.date ? ` · ${page.date}` : ''}`}
        right={
          inCenter ? (
            <button
              type="button"
              onClick={() => openTournamentView(game, page.id)}
              className="cursor-pointer rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm text-ink hover:bg-panel-3"
              title="在「赛事 › 赛事中心」查看分组与对阵图"
            >
              赛事中心查看对阵 ›
            </button>
          ) : undefined
        }
      >
        <TourTierBadge tier={page.tier} />
        <span>{page.name}</span>
        <Chip tone={page.status === 'running' ? 'info' : 'mute'}>{STATUS_LABEL[page.status]}</Chip>
      </PediaTitle>
      <PediaPageLayout
        main={
          <>
            <PSection title="名次" bodyClassName="p-0">
              {page.placements.length === 0 ? (
                <div className="p-4 text-sm text-faint">赛事尚未决出名次</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>名次</th>
                        <th>战队</th>
                        {anyPrize && <th className="num" title="俱乐部所得（只记录前四名）">俱乐部奖金</th>}
                        {anyPrize && <th className="num" title="队员分成（只记录前四名）">队员分成</th>}
                        {anyLineup && <th>首发</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {page.placements.map((p) => (
                        <tr key={p.teamId} className={cx(p.teamId === me && 'bg-gold/5')}>
                          <td className={cx('w-24', placeCellClass(p.rankFrom))}>
                            <span className={placeClass(p.rankFrom)}>{p.label}</span>
                          </td>
                          <td className="max-w-52">
                            <PTeam id={p.teamId} name={p.teamName} />
                          </td>
                          {anyPrize && <td className="num">{p.prize ? <Gold value={p.prize[0]} /> : <span className="text-faint">—</span>}</td>}
                          {anyPrize && <td className="num">{p.prize ? <Gold value={p.prize[1]} /> : <span className="text-faint">—</span>}</td>}
                          {anyLineup && (
                            <td className="whitespace-normal">
                              {p.lineup?.length ? (
                                <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
                                  {p.lineup.map((x) => (
                                    <PPlayer key={x.id} id={x.id} handle={x.handle} />
                                  ))}
                                </div>
                              ) : (
                                <span className="text-faint">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </PSection>
            {page.status !== 'finished' && (
              <div className="text-xs text-faint">赛事进行中：最终名次、奖金与首发在赛事结束后记录。</div>
            )}
          </>
        }
        side={
          <Infobox title={page.name} color={page.tier === 'ti' ? 'var(--color-gold)' : undefined}>
            <InfoRow label="等级">{page.tierLabel}</InfoRow>
            <InfoRow label="赛季">
              TI{page.season}（{page.year}）
            </InfoRow>
            <InfoRow label="开赛日期">{page.date || '—'}</InfoRow>
            <InfoRow label="状态">{STATUS_LABEL[page.status]}</InfoRow>
            <InfoRow label="参赛队伍">{page.teams || '—'}</InfoRow>
            <InfoRow label="奖金池">{fmtUsd(page.prizePool)}</InfoRow>
            <InfoRow label="冠军">{page.championId ? <PTeam id={page.championId} name={page.championName} /> : '—'}</InfoRow>
            <InfoRow label="亚军">{page.runnerUpId ? <PTeam id={page.runnerUpId} name={page.runnerUpName} /> : '—'}</InfoRow>
          </Infobox>
        }
      />
    </div>
  );
}
