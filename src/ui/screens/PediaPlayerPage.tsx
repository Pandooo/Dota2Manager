// DotaPedia · 选手词条（仿 Liquipedia）：左侧章节（概述 / 历史地位 / 生涯数据 / 成就 / 战队履历 / 赛季数据 / 常用英雄），
// 右侧信息框（ID、本名、国籍、出生年份 / 年龄、位置、当前战队、等级与巅峰、状态、奖金）。只读。
import { useMemo, type ReactNode } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import { POSITION_LABEL, POSITION_SHORT, TOURNAMENT_TIER_LABEL, pediaPlayerPage, tiYear } from '../../engine';
import type { PediaPlayerPage as PlayerPage, TournamentTier } from '../../engine';
import { Card, EmptyState, Gold, PosBadge, TierBadge, altPositionsText, cx } from '../components/common';
import { Chip, Flag, countryName } from '../components/SquadShared';
import { TourTierBadge } from '../components/TourShared';
import {
  InfoHead, InfoRow, Infobox, PHero, PSection, PStat, PTeam, PTour, PediaCrumbs, PediaPageLayout, PediaTitle, PediaToc,
  fmt1, fmtKda, fmtPct, placeCellClass, placeClass, safe, wdl,
} from '../components/PediaKit';
import { CareerTimeline, MeterBar, PLineChart, PartBars, type ChartDatum } from '../components/PediaCharts';

export default function PediaPlayerPage({ id }: { id: string }) {
  const game = useGame();
  const version = useGameStore((s) => s.version);
  const page = useMemo(() => safe(() => pediaPlayerPage(game, id), null), [game, version, id]);
  if (!page) {
    return (
      <div>
        <PediaCrumbs kind="player" title={id} />
        <Card>
          <EmptyState text="没有找到这名选手的词条" />
        </Card>
      </div>
    );
  }
  const toc = [
    { id: 'pp-overview', label: '概述' },
    { id: 'pp-standing', label: '历史地位' },
    { id: 'pp-career', label: '生涯数据' },
    { id: 'pp-achievements', label: '成就' },
    { id: 'pp-teams', label: '战队履历' },
    { id: 'pp-seasons', label: '赛季数据' },
    { id: 'pp-heroes', label: '常用英雄' },
  ];
  const sp = game.players[page.id];
  return (
    <div>
      <PediaCrumbs kind="player" title={page.handle} />
      <PediaTitle
        sub={page.name ? `${page.name}${page.position ? ` · ${POSITION_LABEL[page.position]}` : ''}` : page.position ? POSITION_LABEL[page.position] : undefined}
        right={
          sp ? (
            <button
              type="button"
              onClick={() => useGameStore.getState().openPlayer(page.id)}
              className="cursor-pointer rounded-md border border-line bg-panel-2 px-3 py-1.5 text-sm text-ink hover:bg-panel-3"
              title="打开选手详情弹窗（属性、合同与操作）"
            >
              选手详情
            </button>
          ) : undefined
        }
      >
        {page.nationality && <Flag cc={page.nationality} className="text-xl" />}
        <span>{page.handle}</span>
        {page.tier && <TierBadge tier={page.tier} />}
        <Chip tone={page.status === 'active' ? 'good' : page.status === 'banned' ? 'bad' : page.status === 'free' ? 'info' : 'mute'}>{page.statusLabel}</Chip>
        {page.standing && page.standing.title !== '职业选手' && <Chip tone="gold">{page.standing.title}</Chip>}
      </PediaTitle>
      <PediaPageLayout
        main={
          <>
            <PSection id="pp-overview" title="概述">
              <Overview page={page} />
            </PSection>
            <PSection id="pp-standing" title="历史地位" right={<span>含开局前的现实 TI 履历</span>}>
              <Standing page={page} />
            </PSection>
            <PSection id="pp-career" title="生涯数据">
              <Career page={page} />
            </PSection>
            <PSection id="pp-achievements" title="成就">
              <Achievements page={page} />
            </PSection>
            <PSection id="pp-teams" title="战队履历">
              <Teams page={page} />
            </PSection>
            <PSection id="pp-seasons" title="赛季数据" bodyClassName="p-0">
              <Seasons page={page} />
            </PSection>
            <PSection id="pp-heroes" title="常用英雄" bodyClassName="p-0">
              <Heroes page={page} />
            </PSection>
          </>
        }
        side={
          <>
            <PlayerInfobox page={page} />
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
function Overview({ page }: { page: PlayerPage }) {
  const t = page.totals;
  const a = page.achievements;
  const bits: ReactNode[] = [];
  bits.push(
    <span key="a">
      <b className="text-ink">{page.handle}</b>
      {page.name ? `（${page.name}）` : ''}是一名{page.nationality ? `来自${countryName(page.nationality)}的` : ''}
      {page.position ? POSITION_LABEL[page.position].replace(/^\d号位 /, '') : ''}选手，
      {page.teamName && page.status === 'active' ? `现效力于 ${page.teamName}${page.statusLabel !== '现役' ? `（${page.statusLabel}）` : ''}` : page.statusLabel}。
    </span>,
  );
  if (t.games > 0) {
    bits.push(
      <span key="b">
        本局共出场 {t.games} 局，{t.wins} 胜 {t.losses} 负（胜率 {fmtPct(t.winRate)}），场均 {fmt1(t.avgKills)} 杀 / {fmt1(t.avgDeaths)} 死 /{' '}
        {fmt1(t.avgAssists)} 助攻，KDA {fmtKda(t.kda)}{t.mvps > 0 ? `，${t.mvps} 次当选 MVP` : ''}。
      </span>,
    );
  } else {
    bits.push(<span key="b">本局尚无出场记录。</span>);
  }
  const tiWins = a.tiTitles.length;
  const titles = a.titles.length;
  if (tiWins > 0 || titles > 0) {
    bits.push(
      <span key="c">
        {tiWins > 0 ? `职业生涯捧起 ${tiWins} 座不朽盾（${a.tiTitles.map((x) => `TI${x.ti}${x.real ? '·现实' : ''}`).join('、')}）` : ''}
        {tiWins > 0 && titles > 0 ? '，' : ''}
        {titles > 0 ? `本局夺得 ${titles} 个冠军` : ''}。
      </span>,
    );
  }
  return <p className="text-sm leading-7 text-mute">{bits}</p>;
}

// ---------------------------------------------------------------------------
// 历史地位
// ---------------------------------------------------------------------------
function Standing({ page }: { page: PlayerPage }) {
  const s = page.standing;
  if (!s) return <div className="text-sm text-faint">尚无可评估的成就</div>;
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div>
        <div className={cx('text-2xl font-bold', s.title === '职业选手' ? 'text-ink' : 'text-gold')}>{s.title}</div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <PStat label="地位分" value={s.score} accent />
          <PStat label="全部选手排名" value={`${s.rank} / ${s.total}`} />
        </div>
        <div className="mt-2 text-[11px] leading-relaxed text-faint">
          地位分 = TI 名次（含开局前的现实 TI）+ 各级冠军 + MVP + 活跃赛季 + 巅峰天梯等级，生涯进行中实时更新。
        </div>
      </div>
      <div>
        <div className="mb-2 text-xs text-mute">地位分构成</div>
        <PartBars parts={s.parts} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 生涯数据（统计块 + 分赛季小图）
// ---------------------------------------------------------------------------
function bySeason(page: PlayerPage) {
  const m = new Map<number, { games: number; wins: number; k: number; d: number; a: number }>();
  for (const r of page.seasons) {
    const v = m.get(r.ti) ?? { games: 0, wins: 0, k: 0, d: 0, a: 0 };
    v.games += r.games;
    v.wins += r.wins;
    v.k += r.kills;
    v.d += r.deaths;
    v.a += r.assists;
    m.set(r.ti, v);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

function Career({ page }: { page: PlayerPage }) {
  const t = page.totals;
  const seasons = bySeason(page).filter(([, v]) => v.games > 0);
  const kdaData: ChartDatum[] = seasons.map(([ti, v]) => ({
    key: String(ti), label: `TI${ti}`, value: (v.k + v.a) / Math.max(1, v.d),
    tip: `TI${ti}：${v.games} 局 · KDA ${((v.k + v.a) / Math.max(1, v.d)).toFixed(2)} · 场均 ${(v.k / v.games).toFixed(1)}/${(v.d / v.games).toFixed(1)}/${(v.a / v.games).toFixed(1)}`,
  }));
  const wrData: ChartDatum[] = seasons.map(([ti, v]) => ({
    key: String(ti), label: `TI${ti}`, value: (v.wins / v.games) * 100, tip: `TI${ti}：${v.wins} 胜 ${v.games - v.wins} 负（${fmtPct(v.wins / v.games)}）`,
  }));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <PStat label="出场" value={t.games} sub={`${t.seasonsActive} 个赛季`} />
        <PStat label="胜 - 负" value={`${t.wins}-${t.losses}`} sub={`胜率 ${fmtPct(t.winRate)}`} />
        <PStat label="场均 K / D / A" value={t.games > 0 ? `${fmt1(t.avgKills)} / ${fmt1(t.avgDeaths)} / ${fmt1(t.avgAssists)}` : '—'} sub={`合计 ${t.kills} / ${t.deaths} / ${t.assists}`} />
        <PStat label="KDA" value={t.games > 0 ? fmtKda(t.kda) : '—'} accent />
        <PStat label="MVP" value={t.mvps} sub={t.mvps > 0 ? `平均每 ${(t.games / t.mvps).toFixed(0)} 局一次` : undefined} />
        <PStat label="系列赛" value={wdl(t.seriesWins, t.seriesDraws, t.seriesLosses)} sub="胜-平-负" />
        <PStat label="连胜（局）" value={`最长 ${t.bestStreak}`} sub={t.currentStreak > 0 ? `当前 ${t.currentStreak} 连胜` : undefined} />
        <PStat label="奖金" value={<Gold value={t.prize} />} sub="赛事奖金的队员分成" />
      </div>
      {seasons.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-mute">分赛季 KDA</div>
            <PLineChart data={kdaData} format={(v) => v.toFixed(2)} min={0} ariaLabel="分赛季 KDA" />
          </div>
          <div>
            <div className="mb-1 text-xs text-mute">分赛季胜率（%）</div>
            <PLineChart data={wrData} format={(v) => `${Math.round(v)}%`} min={0} max={100} refLine={{ value: 50, label: '50%' }} color="var(--color-info)" ariaLabel="分赛季胜率" />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 成就
// ---------------------------------------------------------------------------
function Achievements({ page }: { page: PlayerPage }) {
  const a = page.achievements;
  const tiers: TournamentTier[] = ['ti', 'major', 'premier', 'minor'];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
        <PStat label="TI 冠军" value={a.tiTitles.length} sub={a.tiTitles.some((x) => x.real) ? '含开局前（现实）' : undefined} accent={a.tiTitles.length > 0} />
        {tiers.slice(1).map((t) => (
          <PStat key={t} label={`${TOURNAMENT_TIER_LABEL[t]} 冠军`} value={a.titleCounts[t] ?? 0} />
        ))}
        <PStat label="亚军" value={a.finals.length} sub="本局决赛失利" />
        <PStat label="MVP" value={a.mvps} />
      </div>

      {a.tiResults.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs text-mute">TI 履历</div>
          <div className="flex flex-wrap gap-1.5">
            {a.tiResults.map((r) => (
              <div
                key={`${r.real ? 'r' : 'g'}${r.ti}`}
                title={`TI${r.ti}（${tiYear(r.ti)}）· ${r.teamName} · ${r.label}${r.real ? ' · 现实' : ''}`}
                className={cx('min-w-20 rounded-lg border px-2 py-1.5 text-center', r.real ? 'border-dashed border-line' : 'border-line', placeCellClass(r.rankFrom))}
              >
                <div className="text-[11px] text-mute tabular">TI{r.ti}</div>
                <div className={cx('text-sm', placeClass(r.rankFrom))}>{r.label}</div>
                <div className="truncate text-[10px] text-faint">{r.real ? r.teamName : <PTeam id={r.teamId} name={r.teamName} noSwatch className="text-[10px]" />}</div>
              </div>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-faint">虚线框为开局前的现实 TI；实线框为本局成绩。</div>
        </div>
      )}

      {a.titles.length > 0 ? (
        <div>
          <div className="mb-1.5 text-xs text-mute">本局冠军</div>
          <div className="space-y-1.5">
            {tiers
              .filter((t) => a.titles.some((x) => x.tier === t))
              .map((t) => (
                <div key={t} className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-2">
                  <TourTierBadge tier={t} className="justify-self-start" />
                  <div className="flex flex-wrap gap-1.5">
                    {a.titles
                      .filter((x) => x.tier === t)
                      .map((x) => (
                        <span key={x.tournamentId} className="inline-flex items-center gap-1 rounded border border-gold/30 bg-gold/5 px-1.5 py-0.5 text-xs">
                          <span className="text-gold">🏆</span>
                          <span className="text-mute">TI{x.season}</span>
                          <PTour id={x.tournamentId} name={x.name} />
                          <span className="text-faint">·</span>
                          <PTeam id={x.teamId} name={x.teamName} noSwatch className="text-xs text-mute" />
                        </span>
                      ))}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div className="text-sm text-faint">本局尚无冠军</div>
      )}

      {a.finals.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs text-mute">亚军</div>
          <div className="flex flex-wrap gap-1.5">
            {a.finals.map((x) => (
              <span key={x.tournamentId} className="inline-flex items-center gap-1 rounded border border-line bg-panel-2/50 px-1.5 py-0.5 text-xs">
                <span className="text-mute">TI{x.season}</span>
                <PTour id={x.tournamentId} name={x.name} />
                <span className="text-faint">· {x.teamName}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 战队履历（时间线 + 表）
// ---------------------------------------------------------------------------
function Teams({ page }: { page: PlayerPage }) {
  const game = useGame();
  if (!page.teams.length) return <div className="text-sm text-faint">暂无战队履历</div>;
  const from = Math.min(...page.teams.map((t) => t.fromTi));
  const to = Math.max(...page.teams.map((t) => t.toTi), game.season?.ti ?? 0);
  return (
    <div className="space-y-4">
      <CareerTimeline
        from={from}
        to={to}
        rows={page.teams.map((t, i) => ({
          key: `${t.teamId}-${t.fromTi}-${i}`,
          label: <PTeam id={t.teamId} name={t.teamName} />,
          start: t.fromTi,
          end: t.toTi,
          color: game.teams[t.teamId]?.color,
          tip: `${t.teamName}：${t.fromTi === t.toTi ? `TI${t.fromTi}` : `TI${t.fromTi}–TI${t.toTi}`} · ${t.games} 局`,
          sub: t.games > 0 ? `${t.games} 局` : '',
        }))}
      />
      <table className="tbl">
        <thead>
          <tr>
            <th>战队</th>
            <th>时间</th>
            <th className="num">局数</th>
            <th className="num">胜率</th>
          </tr>
        </thead>
        <tbody>
          {page.teams.map((t, i) => (
            <tr key={`${t.teamId}-${t.fromTi}-${i}`}>
              <td>
                <PTeam id={t.teamId} name={t.teamName} />
              </td>
              <td className="text-mute tabular">
                {t.fromTi === t.toTi ? `TI${t.fromTi}` : `TI${t.fromTi} – TI${t.toTi}`}
                <span className="ml-1 text-[11px] text-faint">（{tiYear(t.fromTi)}{t.toTi !== t.fromTi ? `–${tiYear(t.toTi)}` : ''}）</span>
              </td>
              <td className="num">{t.games}</td>
              <td className="num">{t.games > 0 ? fmtPct(t.wins / t.games) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛季数据（每赛季 × 战队一行）
// ---------------------------------------------------------------------------
function Seasons({ page }: { page: PlayerPage }) {
  if (!page.seasons.length) return <div className="p-4 text-sm text-faint">暂无赛季数据</div>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>赛季</th>
            <th>战队</th>
            <th className="num">局数</th>
            <th className="num" title="胜-负（胜率）">胜-负</th>
            <th className="num" title="场均 击杀 / 阵亡 / 助攻">K / D / A</th>
            <th className="num">KDA</th>
            <th className="num">MVP</th>
            <th className="num" title="系列赛 胜-平-负">系列赛</th>
            <th className="num">奖金</th>
          </tr>
        </thead>
        <tbody>
          {page.seasons.map((s, i) => (
            <tr key={`${s.ti}-${s.teamId}-${i}`}>
              <td className="tabular" title={`TI${s.ti} 赛季（${s.year}）`}>
                TI{s.ti}
              </td>
              <td>
                <PTeam id={s.teamId} name={s.teamName} className="max-w-40" />
              </td>
              <td className="num">{s.games}</td>
              <td className="num">
                {s.wins}-{s.losses}
                {s.games > 0 && <span className="ml-1 text-[11px] text-mute">{fmtPct(s.winRate)}</span>}
              </td>
              <td className="num text-mute">{s.games > 0 ? `${fmt1(s.avgKills)} / ${fmt1(s.avgDeaths)} / ${fmt1(s.avgAssists)}` : '—'}</td>
              <td className="num font-semibold">{s.games > 0 ? fmtKda(s.kda) : '—'}</td>
              <td className="num">{s.mvps || <span className="text-faint">0</span>}</td>
              <td className="num text-mute">{wdl(s.seriesWins, s.seriesDraws, s.seriesLosses)}</td>
              <td className="num">{s.prize > 0 ? <Gold value={s.prize} /> : <span className="text-faint">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 常用英雄
// ---------------------------------------------------------------------------
function Heroes({ page }: { page: PlayerPage }) {
  if (!page.heroes.length) return <div className="p-4 text-sm text-faint">暂无英雄数据</div>;
  const top = Math.max(1, ...page.heroes.map((h) => h.games));
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>英雄</th>
            <th className="w-48">局数</th>
            <th className="num">胜-负</th>
            <th className="num">胜率</th>
          </tr>
        </thead>
        <tbody>
          {page.heroes.map((h) => (
            <tr key={h.heroId}>
              <td>
                <PHero id={h.heroId} name={h.name} />
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <span className="w-8 text-right tabular">{h.games}</span>
                  <MeterBar value={h.games} max={top} className="flex-1" />
                </div>
              </td>
              <td className="num text-mute">
                {h.wins}-{h.games - h.wins}
              </td>
              <td className={cx('num', h.games >= 5 && h.winRate >= 0.6 && 'text-good', h.games >= 5 && h.winRate < 0.4 && 'text-bad')}>{fmtPct(h.winRate)}</td>
            </tr>
          ))}
          {page.heroOther && (
            <tr>
              <td className="text-mute">其他英雄</td>
              <td>
                <span className="inline-block w-8 text-right text-mute tabular">{page.heroOther.games}</span>
              </td>
              <td className="num text-mute">
                {page.heroOther.wins}-{page.heroOther.games - page.heroOther.wins}
              </td>
              <td className="num text-mute">{fmtPct(page.heroOther.games > 0 ? page.heroOther.wins / page.heroOther.games : NaN)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 信息框
// ---------------------------------------------------------------------------
/**
 * 真实生涯位置（截至本局当届）：同一位置的各段（中间缺席的届次断开）用「、」连接，换位置用「→」，
 * 如「TI1–5、TI8 5号位」「TI6 4号位 → TI7–14 5号位」（与「位置」一行同用阿拉伯数字）。
 */
function realRolesText(spans: PlayerPage['realRoles']): string {
  const out: string[] = [];
  let i = 0;
  while (i < spans.length) {
    const pos = spans[i].pos;
    const parts: string[] = [];
    for (; i < spans.length && spans[i].pos === pos; i++) {
      const r = spans[i];
      parts.push(r.from === r.to ? `TI${r.from}` : `TI${r.from}–${r.to}`);
    }
    out.push(`${parts.join('、')} ${POSITION_SHORT[pos]}号位`);
  }
  return out.join(' → ');
}

function PlayerInfobox({ page }: { page: PlayerPage }) {
  const game = useGame();
  const sp = game.players[page.id];
  const color = page.teamId ? game.teams[page.teamId]?.color : undefined;
  return (
    <Infobox
      title={page.handle}
      color={color}
      banner={
        <div className="flex flex-col items-center gap-2">
          <div className="text-5xl leading-none">{page.nationality ? <Flag cc={page.nationality} /> : '◇'}</div>
          <div className="flex items-center gap-2">
            {page.tier && <TierBadge tier={page.tier} size="lg" />}
            {page.position && <PosBadge pos={page.position} alt={page.altPositions} full />}
          </div>
          {page.standing && (
            <div className="text-xs text-mute">
              <span className={page.standing.title === '职业选手' ? 'text-ink' : 'font-semibold text-gold'}>{page.standing.title}</span>
              <span className="ml-1 tabular">· 地位分 {page.standing.score}（第 {page.standing.rank}）</span>
            </div>
          )}
        </div>
      }
    >
      <InfoRow label="ID">{page.handle}</InfoRow>
      <InfoRow label="本名">{page.name ?? '—'}</InfoRow>
      <InfoRow label="国籍">
        {page.nationality ? (
          <span className="inline-flex items-center gap-1.5">
            <Flag cc={page.nationality} />
            {countryName(page.nationality)}
          </span>
        ) : (
          '—'
        )}
      </InfoRow>
      <InfoRow label="出生">
        {sp?.birthYear ? `${sp.birthYear} 年` : '—'}
        {page.age !== null && <span className="ml-1 text-xs text-mute">（{page.age} 岁）</span>}
      </InfoRow>
      <InfoRow label="位置">
        {page.position ? POSITION_LABEL[page.position] : '—'}
        {page.altPositions.length > 0 && (
          <span className="ml-1 text-xs text-mute">（{altPositionsText(page.altPositions)}）</span>
        )}
      </InfoRow>
      {new Set(page.realRoles.map((r) => r.pos)).size > 1 && (
        <InfoRow label="真实生涯位置">
          <span className="text-xs">{realRolesText(page.realRoles)}</span>
        </InfoRow>
      )}
      <InfoRow label="当前战队">{page.teamId ? <PTeam id={page.teamId} name={page.teamName ?? undefined} /> : <span className="text-mute">—</span>}</InfoRow>
      <InfoRow label="状态">{page.statusLabel}</InfoRow>
      <InfoHead>实力</InfoHead>
      <InfoRow label="天梯等级">
        {page.tier ? <TierBadge tier={page.tier} /> : '—'}
        {page.peakTier && (
          <span className="ml-2 text-xs text-mute">
            巅峰 <TierBadge tier={page.peakTier} />
          </span>
        )}
      </InfoRow>
      <InfoRow label="综合评分">
        {page.rating !== null ? fmt1(page.rating) : '—'}
        {page.peakRating !== null && page.peakRating > 0 && <span className="ml-2 text-xs text-mute">巅峰 {fmt1(page.peakRating)}</span>}
      </InfoRow>
      <InfoRow label="来源">{page.isReal === null ? '—' : page.isReal ? '现实选手' : '程序生成'}</InfoRow>
      <InfoHead>生涯</InfoHead>
      <InfoRow label="出场">
        {page.totals.games} 局<span className="ml-1 text-xs text-mute">（{page.totals.seasonsActive} 季）</span>
      </InfoRow>
      <InfoRow label="KDA">{page.totals.games > 0 ? fmtKda(page.totals.kda) : '—'}</InfoRow>
      <InfoRow label="本局冠军">
        {page.achievements.titles.length}
        {page.achievements.titleCounts.ti > 0 && <span className="ml-1 text-gold">（TI ×{page.achievements.titleCounts.ti}）</span>}
      </InfoRow>
      {page.achievements.tiTitles.some((x) => x.real) && (
        <InfoRow label="现实 TI 冠军">
          <span className="text-gold">
            {page.achievements.tiTitles
              .filter((x) => x.real)
              .map((x) => `TI${x.ti}`)
              .join('、')}
          </span>
        </InfoRow>
      )}
      <InfoRow label="奖金">
        <Gold value={page.totals.prize} />
      </InfoRow>
    </Infobox>
  );
}
