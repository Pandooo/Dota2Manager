// 赛程报名：赛季回合表、赛事报名/取消、版本更新落点
import { useState } from 'react';
import { useCall, useGame, useGameStore } from '../../store/gameStore';
import type { GameState, RoundInfo, Tournament, TournamentTier } from '../../engine/types';
import {
  CONFIG, REGION_LABEL, TOURNAMENT_TIER_LABEL, awardedPrizePool, formatRank, patchByVersion, roundCounts, roundKindForPlayer,
} from '../../engine';
import { getTiInfo } from '../../data/index';
import { Badge, Button, Card, EmptyState, Gold, Stat, cx } from '../components/common';
import { ScreenHeader } from '../layout/HubKit';
import {
  FORMAT_LABEL, PHASE_CLASS, PHASE_LABEL, ROUND_KIND_CLASS, ROUND_KIND_TEXT, Segmented, TeamName, TourStatusBadge,
  TourTierBadge, championOf, dateRange, openTournamentView, rankClass, safe, teamPlacement, type RoundKind,
} from '../components/TourShared';
import { entryControls } from '../components/TourEntry';

const TIER_ORDER: Record<TournamentTier, number> = { ti: 0, major: 1, premier: 2, minor: 3, qualifier: 4 };
const TIERS_FOR_TABLE: TournamentTier[] = ['major', 'premier', 'minor'];

type Filter = 'all' | 'upcoming' | 'mine';

/** 游戏内实际发放的奖金池（真实奖池按年代/等级换算）；异常时退回 0 */
function awardedPoolOf(game: GameState, t: Tournament): number {
  try {
    return awardedPrizePool(game, t);
  } catch {
    return 0;
  }
}

function isMine(t: Tournament, me: string): boolean {
  return t.playerStatus === 'invited' || t.playerStatus === 'registered' || t.teamIds?.includes(me) || t.qualifierTeamIds?.includes(me);
}

function roundTournaments(game: GameState, r: RoundInfo): Tournament[] {
  const seen = new Set<string>();
  const out: Tournament[] = [];
  for (const id of r.tournamentIds ?? []) {
    const t = game.tournaments[id];
    if (t && !seen.has(id)) {
      seen.add(id);
      out.push(t);
    }
  }
  for (const t of Object.values(game.tournaments)) {
    if (t.season === game.season.ti && t.roundIndex === r.index && !seen.has(t.id)) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out.sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || (a.startDate || '').localeCompare(b.startDate || '') || a.name.localeCompare(b.name));
}

function kindOf(game: GameState, r: RoundInfo): RoundKind {
  return safe<RoundKind>(() => roundKindForPlayer(game, r.index), r.phase === 'preseason' ? 'preseason' : r.phase === 'ti' ? 'ti' : r.phase === 'ti_qualifier' ? 'ti_qualifier' : 'rest');
}

export default function Schedule() {
  const game = useGame();
  const setView = useGameStore((s) => s.setView);
  const [filter, setFilter] = useState<Filter>('all');
  const me = game.settings.playerTeamId;
  const myTeam = game.teams[me];
  const rounds = game.season?.rounds ?? [];

  if (rounds.length === 0 || !myTeam) {
    return (
      <div>
        <ScreenHeader title="赛程报名" />
        <Card>
          <EmptyState text="赛季日历尚未生成。赛程会在赛季初公布。" />
        </Card>
      </div>
    );
  }

  const kinds = rounds.map((r) => kindOf(game, r));
  const fallbackCounts = {
    total: rounds.length,
    tournamentRounds: kinds.filter((k) => k === 'tournament' || k === 'ti' || k === 'ti_qualifier').length,
    restRounds: kinds.filter((k) => k === 'rest' || k === 'ti_watch').length,
  };
  const counts = safe(() => roundCounts(game), fallbackCounts);
  const directInvites = safe(() => getTiInfo(game.season.ti).directInvites, 0);
  const allTours = rounds.flatMap((r) => roundTournaments(game, r));
  const mine = allTours.filter((t) => isMine(t, me)).sort((a, b) => a.roundIndex - b.roundIndex);
  // 可婉拒的受邀赛事（不含必须参加的 TI 正赛与 TI 赛区预选）
  const invitedCount = allTours.filter((t) => t.playerStatus === 'invited' && t.tier !== 'ti' && !t.advanceToTi).length;
  const declinedInvites = allTours.filter(
    (t) => t.playerStatus === 'declined' && t.status === 'scheduled' && (t.invitedTeamIds ?? []).includes(me),
  ).length;
  const registeredCount = allTours.filter((t) => t.playerStatus === 'registered').length;
  const totalPatches = rounds.reduce((n, r) => n + (r.patchVersions?.length ?? 0), 0);

  const visible = rounds.filter((r) => {
    if (filter === 'upcoming') return r.index >= game.roundIndex;
    if (filter === 'mine') return roundTournaments(game, r).some((t) => isMine(t, me));
    return true;
  });

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="赛程报名"
        subtitle={`TI${game.season.ti} 赛季 · ${game.season.year} · ${dateRange(game.season.startDate, game.season.tiStartDate)}`}
        nav={
          <Button size="sm" onClick={() => setView('tournament')}>
            赛事中心 →
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="赛季概况" className="lg:col-span-2">
          <div className="text-base font-semibold">
            本赛季共 <span className="text-gold tabular">{counts.total}</span> 个大回合
            <span className="text-mute">
              （<span className="text-good tabular">{counts.tournamentRounds}</span> 个赛事回合，
              <span className="tabular text-ink">{counts.restRounds}</span> 个休赛回合）
            </span>
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
            <ul className="space-y-1.5 text-xs leading-relaxed text-mute">
              <li>· 每个大回合<span className="text-ink">最多参加一项赛事</span>，同回合的多项赛事只能择一。</li>
              <li>
                · <span className="text-gold">受邀赛事</span>（上赛季排名靠前或荣誉足够高）已自动报名、直接进入正赛；
                开赛前可<span className="text-ink">婉拒</span>（空出的席位由其他战队递补），婉拒后也可<span className="text-ink">重新接受</span>。
                同回合多项邀请默认保留等级最高者，想改打其他赛事需先婉拒保留的那项。
              </li>
              <li>
                · <span className="text-ink">赛季中可随时报名、重新接受或退出</span>尚未开赛的赛事。退出（婉拒 / 取消报名）在报名或接受邀请的
                <span className="text-ink">同一回合内不扣荣誉</span>，之后按等级扣荣誉：Major {-CONFIG.honor.withdraw.major} / 顶级赛事{' '}
                {-CONFIG.honor.withdraw.premier} / Minor {-CONFIG.honor.withdraw.minor} / 线上公开赛 {-CONFIG.honor.withdrawOpenCup}，
                距开赛 ≥ {CONFIG.honor.withdrawFarRounds} 个回合减半，低荣誉减损（按钮上标出本次扣分）。
              </li>
              <li>
                · <span className="text-gold">补充邀请</span>：每回合结束时，本赛季积分榜排名进入某项未开赛赛事的直邀名额（或荣誉达到受邀线）的战队，
                可收到该赛事的补充邀请（婉拒 / 解散腾出的席位 + 每项最多 {CONFIG.tournament.lateInvite.extraSlots} 个追加席位）；
                默认接受，收到的回合内婉拒不扣荣誉。
              </li>
              <li>
                · <span className="text-gold">TI 与 TI 赛区预选赛为赛季收官，必须参加</span>。报名但未受邀的赛事需先打封闭预选赛。
              </li>
              <li>· 未报名任何赛事的回合为<span className="text-ink">休赛回合</span>：可进行免费训练、购买额外训练或约训练赛。</li>
              <li>· 报名 / 婉拒可在赛事所在回合开始前修改（回合开始即开赛）；TI 预选回合起转会窗口锁定。</li>
              <li>
                · 每个回合开始时依次结算：<span className="text-info">版本更新</span>（按真实发布日期落在该回合，本赛季共 {totalPatches} 次）→{' '}
                <span className="text-dota-2">随机事件</span> → 赛事开赛 / 训练。
              </li>
              {directInvites > 0 && <li>· 赛季积分榜前 {directInvites} 名直邀 TI，其余战队在 TI 预选回合打赛区预选。</li>}
            </ul>
            <div className="shrink-0">
              <table className="tbl text-xs">
                <thead>
                  <tr>
                    <th>等级</th>
                    <th className="num" title="报名所需最低荣誉">报名门槛</th>
                    <th className="num" title="荣誉达到此值即可获得邀请（亦可凭上赛季排名受邀）">免邀荣誉</th>
                  </tr>
                </thead>
                <tbody>
                  {TIERS_FOR_TABLE.map((tier) => {
                    const min = CONFIG.tournament.minHonor[tier] ?? 0;
                    const inv = CONFIG.tournament.inviteHonor[tier] ?? 0;
                    return (
                      <tr key={tier}>
                        <td>
                          <TourTierBadge tier={tier} />
                        </td>
                        <td className={cx('num', myTeam.honor >= min ? 'text-good' : 'text-bad')}>{min || '无'}</td>
                        <td className={cx('num', myTeam.honor >= inv ? 'text-good' : 'text-mute')}>{inv}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-1 text-right text-[11px] text-faint">
                当前荣誉 <span className="tabular text-ink">{Math.round(myTeam.honor)}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat
              label="当前回合"
              value={game.roundIndex === 0 ? '赛季初' : `R${game.roundIndex}`}
              hint={game.roundIndex === 0 ? '可报名 / 转会 / 处理新秀' : ROUND_KIND_TEXT[kinds[game.roundIndex] ?? 'rest']}
            />
            <Stat
              label="受邀赛事"
              value={invitedCount}
              hint={declinedInvites > 0 ? `已婉拒 ${declinedInvites} 项 · 可重新接受` : '开赛前可婉拒'}
            />
            <Stat label="已报名" value={registeredCount} hint="可在开赛回合前取消" />
            <Stat label="休赛回合" value={counts.restRounds} hint="可训练 / 训练赛" />
          </div>
        </Card>

        <Card title="我的参赛计划" subtitle={`${mine.length} 项赛事`} bodyClassName="p-0">
          {mine.length === 0 ? (
            <EmptyState text="还没有报名任何赛事。在下方回合表中点击「报名」。" />
          ) : (
            <div className="max-h-[340px] overflow-y-auto">
              {mine.map((t) => {
                const pl = teamPlacement(t, me);
                return (
                  <div
                    key={t.id}
                    className={cx(
                      'flex items-center gap-2 border-b border-line/60 px-3 py-2 text-xs',
                      t.roundIndex < game.roundIndex && 'opacity-60',
                      t.roundIndex === game.roundIndex && 'bg-gold/5',
                    )}
                  >
                    <span className="w-8 shrink-0 font-semibold tabular text-mute">R{t.roundIndex}</span>
                    <button className="min-w-0 flex-1 cursor-pointer truncate text-left hover:text-gold" onClick={() => openTournamentView(game, t.id)}>
                      {t.name}
                    </button>
                    <TourTierBadge tier={t.tier} className="shrink-0" />
                    <span className="w-16 shrink-0 text-right">
                      {pl ? (
                        <span className={rankClass(pl.rankFrom)}>{formatRank(pl.rankFrom, pl.rankTo)}</span>
                      ) : t.status === 'running' ? (
                        <span className="text-good">进行中</span>
                      ) : (
                        <span
                          className={t.playerStatus === 'invited' ? 'text-gold' : 'text-mute'}
                          title={t.tier === 'ti' || t.advanceToTi ? 'TI 与 TI 赛区预选赛为赛季收官赛事，必须参加' : undefined}
                        >
                          {t.tier === 'ti' || t.advanceToTi
                            ? '必须参加'
                            : t.playerStatus === 'invited'
                              ? '受邀'
                              : t.playerStatus === 'registered'
                                ? '已报名'
                                : '参赛'}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="赛季回合表"
        subtitle="点击赛事名称进入赛事中心；版本更新标签表示该版本在此回合开始时生效"
        actions={
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'all', label: '全部回合' },
              { key: 'upcoming', label: '未来回合' },
              { key: 'mine', label: '我的赛事' },
            ]}
          />
        }
        bodyClassName="p-0"
      >
        {visible.length === 0 ? (
          <EmptyState text={filter === 'mine' ? '你还没有参加任何赛事。' : '没有符合条件的回合。'} />
        ) : (
          <div>
            {visible.map((r) => (
              <RoundRow key={r.index} game={game} r={r} kind={kinds[r.index] ?? 'rest'} directInvites={directInvites} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 回合行
// ---------------------------------------------------------------------------
function RoundRow({ game, r, kind, directInvites }: { game: GameState; r: RoundInfo; kind: RoundKind; directInvites: number }) {
  const setView = useGameStore((s) => s.setView);
  const isCur = r.index === game.roundIndex;
  const isPast = r.index < game.roundIndex;
  const tours = roundTournaments(game, r);
  const patches = r.patchVersions ?? [];

  let emptyText = '本回合无赛事 · 休赛回合（可训练 / 训练赛）';
  if (r.phase === 'preseason') emptyText = '赛季初：处理选中的新秀、转会、签约教练、报名赛事。点击底部「开始赛季」进入第 1 回合。';
  else if (r.phase === 'ti_qualifier')
    emptyText = `TI 预选赛将在本回合开始时确定：积分榜前 ${directInvites || 'N'} 名直邀 TI，其余战队参加所在赛区的预选赛（直邀战队本回合休赛，可训练）。`;
  else if (r.phase === 'ti') emptyText = 'TI 正赛';

  return (
    <div
      className={cx(
        'grid grid-cols-[132px_minmax(0,1fr)] border-b border-line/60 md:grid-cols-[160px_minmax(0,1fr)]',
        isCur && 'bg-gold/5',
        r.phase === 'ti' && !isCur && 'bg-gold/[0.03]',
      )}
    >
      <div className={cx('border-l-2 px-3 py-2.5', isCur ? 'border-gold' : 'border-transparent', isPast && 'opacity-55')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cx('text-base font-bold tabular', isCur && 'text-gold')}>R{r.index}</span>
          <Badge className={PHASE_CLASS[r.phase]}>{PHASE_LABEL[r.phase]}</Badge>
          {isCur && <Badge className="bg-gold text-black">当前</Badge>}
        </div>
        <div className="mt-0.5 text-[11px] text-faint tabular">{dateRange(r.startDate, r.endDate)}</div>
        <div className={cx('mt-0.5 text-xs', ROUND_KIND_CLASS[kind])}>{ROUND_KIND_TEXT[kind]}</div>
      </div>
      <div className={cx('min-w-0 space-y-1 px-2 py-2', isPast && 'opacity-60')}>
        {patches.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2">
            {patches.map((v) => {
              const p = safe(() => patchByVersion(v), undefined);
              return (
                <button
                  key={v}
                  onClick={() => setView('patches')}
                  title={p ? `${p.date} · ${p.title}\n${p.summary}` : `版本 ${v}`}
                  className="inline-flex cursor-pointer items-center gap-1 rounded border border-info/40 bg-info/10 px-1.5 py-0.5 text-[11px] text-info hover:bg-info/20"
                >
                  ⟳ 版本 {v}
                  {p?.major && <span className="font-semibold text-gold">大版本</span>}
                  <span className="text-info/70">{isPast || isCur ? '已生效' : '本回合开始时生效'}</span>
                </button>
              );
            })}
          </div>
        )}
        {tours.length === 0 ? (
          <div className="px-2 py-1 text-xs text-faint">{emptyText}</div>
        ) : (
          tours.map((t) => <TourRow key={t.id} game={game} t={t} siblings={tours} directInvites={directInvites} />)
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛事行
// ---------------------------------------------------------------------------
function TourRow({ game, t, siblings, directInvites }: { game: GameState; t: Tournament; siblings: Tournament[]; directInvites: number }) {
  const call = useCall();
  const me = game.settings.playerTeamId;
  const isTi = t.tier === 'ti';
  const { mine, chip, action, placement } = entryControls(game, t, call, { siblings, directInvites });
  const champ = t.status === 'finished' ? championOf(t) : null;
  const visa = t.hostRegion === 'NA' && !t.online;
  const size = t.size ?? (t.teamIds?.length || 0);

  return (
    <div
      className={cx(
        'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border-l-2 px-2 py-1.5 hover:bg-panel-2/60',
        mine ? (isTi ? 'border-gold bg-gold/5' : 'border-good bg-good/5') : 'border-transparent',
      )}
    >
      <div className="min-w-[220px] flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            onClick={() => openTournamentView(game, t.id)}
            className={cx('cursor-pointer truncate text-left text-sm font-medium hover:text-gold hover:underline', isTi && 'text-gold')}
            title="在赛事中心查看"
          >
            {t.name}
          </button>
          <TourTierBadge tier={t.tier} />
          {t.status !== 'scheduled' && <TourStatusBadge status={t.status} />}
          {visa && (
            <Badge className="bg-dota/15 text-dota-2 border border-dota/40" title="北美线下赛：CN/SEA/CIS/SA 选手签证问题高发">
              签证风险
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-faint">
          {t.online ? '线上' : t.city || '—'} · {REGION_LABEL[t.hostRegion] ?? t.hostRegion}
          {' · '}
          {FORMAT_LABEL[t.format] ?? t.format}
          {size ? ` · ${size} 队` : ''}
          {t.invitedTeamIds?.length ? ` · 受邀 ${t.invitedTeamIds.length}` : ''}
          {t.minHonor > 0 ? ` · 门槛 ${t.minHonor}` : ''}
        </div>
      </div>
      <div
        className="w-20 text-right text-xs"
        title={`${TOURNAMENT_TIER_LABEL[t.tier]} · 游戏内发放奖金池（真实奖金池 $${Math.round(t.prizePool ?? 0).toLocaleString('en-US')}）`}
      >
        <Gold value={awardedPoolOf(game, t)} />
      </div>
      <div className="flex w-40 flex-wrap items-center justify-end gap-1 text-right text-xs">
        {t.status === 'finished' ? (
          <>
            {placement ? (
              <span>
                我的名次 <span className={rankClass(placement.rankFrom)}>{formatRank(placement.rankFrom, placement.rankTo)}</span>
              </span>
            ) : (
              <span className="text-faint">未参加</span>
            )}
            {champ && champ !== me && (
              <span className="flex items-center gap-1 text-faint">
                冠军 <TeamName game={game} teamId={champ} mode="tag" />
              </span>
            )}
          </>
        ) : (
          chip
        )}
      </div>
      <div className="flex w-24 justify-end">{action}</div>
    </div>
  );
}
