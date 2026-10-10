// 赛事中心：赛事选择、玩家下一场、小组/对阵图、名次与结算
import { useState } from 'react';
import { useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import type { GameState, Series, Stage, Tournament } from '../../engine/types';
import {
  REGION_LABEL, awardedPrizePool, currentPlayerTournament, expectedRank, formatRank, isTeamEliminated, playerNextSeries,
  teamRating, validateLineup,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Gold, Hint, Tabs, cx } from '../components/common';
import { ConfirmButton } from '../components/ConfirmPopover';
import { ScreenHeader } from '../layout/HubKit';
import {
  FORMAT_LABEL, HonorBreakdownGrid, InfoItem, PHASE_LABEL, TOUR_STATUS_LABEL, TeamName, TourSelect, TourStatusBadge,
  TourTierBadge, dateRange, rankClass, roundKeyOf, safe, teamInfo, useTourSelection,
} from '../components/TourShared';
import { StageView } from '../components/TourBracket';
import { SeriesModal } from '../components/TourSeriesModal';
import { entryControls } from '../components/TourEntry';

function byRound(a: Tournament, b: Tournament): number {
  return a.roundIndex - b.roundIndex || (a.startDate || '').localeCompare(b.startDate || '') || a.name.localeCompare(b.name);
}

function inEventOf(t: Tournament, me: string): boolean {
  return (t.teamIds ?? []).includes(me) || (t.qualifierTeamIds ?? []).includes(me);
}

function pickDefault(list: Tournament[], game: GameState): Tournament | null {
  const me = game.settings.playerTeamId;
  return (
    list.find((t) => t.status === 'running' && inEventOf(t, me)) ??
    list.find((t) => t.status === 'running') ??
    list
      .filter((t) => t.status === 'finished')
      .sort(byRound)
      .pop() ??
    list.find((t) => t.roundIndex >= game.roundIndex) ??
    list[0] ??
    null
  );
}

/** 赛事选择器选项 */
function tournamentLists(game: GameState) {
  const ti = game.season?.ti;
  const seen = new Set<string>();
  const current: Tournament[] = [];
  for (const id of game.seasonTournamentIds ?? []) {
    const t = game.tournaments[id];
    if (t && !seen.has(id)) {
      seen.add(id);
      current.push(t);
    }
  }
  for (const t of Object.values(game.tournaments)) {
    if (t.season === ti && !seen.has(t.id)) {
      seen.add(t.id);
      current.push(t);
    }
  }
  current.sort(byRound);
  const past = Object.values(game.tournaments)
    .filter((t) => !seen.has(t.id))
    .sort((a, b) => b.season - a.season || byRound(a, b));
  return { current, past };
}

export default function TournamentCenter() {
  const game = useGame();
  const setView = useGameStore((s) => s.setView);
  const selId = useTourSelection((s) => s.tournamentId);
  const selKey = useTourSelection((s) => s.roundKey);
  const select = useTourSelection((s) => s.select);
  const [openSeries, setOpenSeries] = useState<Series | null>(null);
  const [stageSel, setStageSel] = useState<{ tid: string; sid: string } | null>(null);

  const { current, past } = tournamentLists(game);
  const playerCur = safe(() => currentPlayerTournament(game), null);
  const chosen = selId && selKey === roundKeyOf(game) ? game.tournaments[selId] : undefined;
  const t: Tournament | null = chosen ?? playerCur ?? pickDefault(current, game) ?? past[0] ?? null;

  if (!t) {
    return (
      <div>
        <ScreenHeader title="赛事中心" subtitle="小组赛积分、淘汰赛对阵与赛事结算" />
        <Card>
          <EmptyState text="本赛季暂无赛事数据。赛程会在赛季初公布。">
            <Button size="sm" onClick={() => setView('schedule')}>
              前往赛程报名
            </Button>
          </EmptyState>
        </Card>
      </div>
    );
  }

  const me = game.settings.playerTeamId;
  const optionLabel = (x: Tournament) => {
    const mine = inEventOf(x, me) || x.playerStatus === 'invited' || x.playerStatus === 'registered';
    return `${x.season !== game.season.ti ? `TI${x.season} · ` : ''}R${x.roundIndex} · ${x.name} · ${TOUR_STATUS_LABEL[x.status] ?? x.status}${mine ? ' ★' : ''}`;
  };

  const defaultStage = (x: Tournament): Stage | undefined => {
    const stages = x.stages ?? [];
    if (stages.length === 0) return undefined;
    // 玩家所在且未结束的阶段优先，其次第一个未结束阶段，最后一个阶段
    const running = stages.filter((s) => !s.done);
    return (
      running.find((s) => s.teamIds.includes(me)) ??
      running.find((s) => (s.seriesIds ?? []).some((id) => x.series?.[id]?.teamA || x.series?.[id]?.teamB)) ??
      running[0] ??
      stages[stages.length - 1]
    );
  };
  const stage =
    (stageSel && stageSel.tid === t.id ? t.stages.find((s) => s.id === stageSel.sid) : undefined) ?? defaultStage(t);

  return (
    <div className="space-y-4">
      <ScreenHeader
        title="赛事中心"
        subtitle={`TI${game.season.ti} 赛季 · 共 ${current.length} 项赛事`}
        actions={
          <>
            {playerCur && playerCur.id !== t.id && (
              <Button size="sm" variant="gold" onClick={() => select(playerCur.id, roundKeyOf(game))}>
                回到我的赛事
              </Button>
            )}
            <TourSelect value={t.id} onChange={(v) => select(v, roundKeyOf(game))} className="max-w-[420px]" title="选择赛事">
              <optgroup label={`本赛季（TI${game.season.ti}）`}>
                {current.map((x) => (
                  <option key={x.id} value={x.id}>
                    {optionLabel(x)}
                  </option>
                ))}
              </optgroup>
              {past.length > 0 && (
                <optgroup label="往届">
                  {past.map((x) => (
                    <option key={x.id} value={x.id}>
                      {optionLabel(x)}
                    </option>
                  ))}
                </optgroup>
              )}
            </TourSelect>
          </>
        }
      />

      <TournamentHeader game={game} t={t} />
      <PlayerMatchPanel game={game} t={t} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card
            title="赛程与对阵"
            subtitle={t.stages?.length ? '点击已完成的系列赛查看逐局 BP 与数据' : undefined}
            bodyClassName="p-0"
          >
            {t.stages && t.stages.length > 0 && stage ? (
              <>
                <Tabs
                  className="px-3 pt-1"
                  value={stage.id}
                  onChange={(sid) => setStageSel({ tid: t.id, sid })}
                  tabs={t.stages.map((s) => ({
                    key: s.id,
                    label: s.name,
                    badge: s.done ? (
                      <span className="text-[10px] text-faint">✓</span>
                    ) : s === defaultStage(t) && t.status === 'running' ? (
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-good" />
                    ) : undefined,
                  }))}
                />
                <div className="p-4">
                  <StageView
                    game={game}
                    t={t}
                    stage={stage}
                    onOpen={setOpenSeries}
                    nextSeriesId={safe(() => (t.status === 'running' ? playerNextSeries(game, t.id)?.id ?? null : null), null)}
                  />
                </div>
              </>
            ) : (
              <ScheduledInfo game={game} t={t} />
            )}
          </Card>
          <PlacementsCard game={game} t={t} />
        </div>
        <div className="min-w-0 space-y-4">
          <SettlementCard game={game} t={t} />
          <TeamsCard game={game} t={t} />
        </div>
      </div>

      <SeriesModal game={game} series={openSeries} onClose={() => setOpenSeries(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 赛事头部
// ---------------------------------------------------------------------------
function TournamentHeader({ game, t }: { game: GameState; t: Tournament }) {
  const call = useCall();
  const me = game.settings.playerTeamId;
  const round = t.season === game.season.ti ? game.season?.rounds?.[t.roundIndex] : undefined;
  const sameSeason = t.season === game.season.ti;
  const entry = entryControls(game, t, call, { size: 'sm', inCenter: true });
  const inEvent = entry.inEvent;
  // 开赛后以引擎锁定的赛前预期为准；未开赛但已报名/受邀时按当前战力与荣誉估算
  const locked = t.expectedRanks?.[me] ?? (inEvent || t.status === 'finished' ? t.expectedRank : undefined);
  const estimate =
    locked === undefined && t.status === 'scheduled' && sameSeason && entry.mine
      ? safe<number | undefined>(() => expectedRank(game, t, me), undefined)
      : undefined;
  const exp = locked ?? estimate;
  const size = t.size ?? (t.teamIds?.length || undefined);
  const visa = t.hostRegion === 'NA' && !t.online;

  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-xl border bg-panel/90 p-4 shadow-lg shadow-black/20',
        t.tier === 'ti' ? 'border-gold/50' : 'border-line',
      )}
    >
      {t.tier === 'ti' && (
        <div className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-gold/10 blur-3xl" />
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={cx('text-lg font-bold tracking-wide', t.tier === 'ti' && 'text-gold')}>{t.name}</h2>
            <TourTierBadge tier={t.tier} />
            <TourStatusBadge status={t.status} />
            {entry.chip}
            {visa && (
              <Badge className="bg-dota/15 text-dota-2 border border-dota/40" title="北美线下赛：CN/SEA/CIS/SA 选手签证问题高发">
                签证风险
              </Badge>
            )}
            {t.regionLocked && <Badge title="仅限该赛区战队参赛">仅限{REGION_LABEL[t.regionLocked]}</Badge>}
          </div>
          <div className="mt-1 text-xs text-mute">
            {sameSeason ? '' : `TI${t.season} 赛季 · `}第 {t.roundIndex} 回合
            {round ? ` · ${PHASE_LABEL[round.phase]}` : ''} · {round ? dateRange(round.startDate, round.endDate) : t.startDate}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {entry.action}
          {exp !== undefined && Number.isFinite(exp) && (
            <div
              className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-1.5 text-right"
              title={
                locked !== undefined
                  ? '开赛时按参赛队战力与荣誉排名得出，赛后荣誉结算以此为基准（不达预期会扣荣誉）'
                  : '按当前战力与荣誉估算，开赛时正式确定'
              }
            >
              <div className="text-[11px] text-gold/80">{locked !== undefined ? '赛前预期' : '预计（开赛时确定）'}</div>
              <div className="text-sm font-semibold text-gold">第 {Math.round(exp)} 名左右</div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3 lg:grid-cols-6">
        <InfoItem label="地点">
          {t.online ? '线上' : t.city || '—'}
          <span className="ml-1 text-xs text-faint">{REGION_LABEL[t.hostRegion] ?? t.hostRegion}</span>
        </InfoItem>
        <InfoItem label="奖金池（游戏内发放）">
          <span title={`真实奖金池 $${Math.round(t.prizePool ?? 0).toLocaleString('en-US')}，按年代与赛事等级换算为游戏金币发放`}>
            <Gold value={safe(() => awardedPrizePool(game, t), 0)} />
            {(t.prizePool ?? 0) > 0 && (
              <span className="ml-1 text-[11px] text-faint">真实 ${Math.round(t.prizePool ?? 0).toLocaleString('en-US')}</span>
            )}
          </span>
        </InfoItem>
        <InfoItem label="出场费（每队）">
          <Gold value={t.appearanceFee ?? 0} />
        </InfoItem>
        <InfoItem label="赛制">
          <span title={FORMAT_LABEL[t.format]}>{FORMAT_LABEL[t.format] ?? t.format}</span>
        </InfoItem>
        <InfoItem label="正赛队伍">
          {size ?? '—'}
          {t.qualifierSlots ? <span className="ml-1 text-xs text-faint">（含预选 {t.qualifierSlots} 席）</span> : null}
        </InfoItem>
        <InfoItem label="荣誉门槛">{t.minHonor > 0 ? t.minHonor : '无'}</InfoItem>
      </div>
      {t.advanceToTi && (
        <Hint className="mt-2">TI 赛区预选：前 {t.advanceToTi.slots} 名晋级本届 TI 正赛。</Hint>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 玩家下一场
// ---------------------------------------------------------------------------
function PlayerMatchPanel({ game, t }: { game: GameState; t: Tournament }) {
  const call = useCall();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const me = game.settings.playerTeamId;
  const inEvent = inEventOf(t, me);
  if (t.status !== 'running') return null;

  if (!inEvent) {
    return (
      <div className="rounded-lg border border-line bg-panel-2/50 px-4 py-2.5 text-sm text-mute">
        你的战队未参加本项赛事，比赛将在后台进行，你可以随时在这里关注战况。
      </div>
    );
  }

  const am = game.activeMatch && game.activeMatch.tournamentId === t.id ? game.activeMatch : null;
  const next = safe(() => playerNextSeries(game, t.id), null);
  const eliminated = safe(() => isTeamEliminated(game, t.id, me), false);
  const myPlacement = t.placements?.find((p) => p.teamId === me);
  const isCurrent = safe(() => currentPlayerTournament(game)?.id === t.id, false);
  const blocking = game.pendingDecisions.filter((d) => d.blocking);
  // 阵容问题不阻止操作：进入比赛时引擎会先自动重排首发；仍凑不齐 5 人时快速模拟 = 弃权判负
  const lineupErr = safe(() => validateLineup(game, me, t.id), [] as string[]);

  if (am) {
    const s = t.series?.[am.seriesId];
    const opp = s ? (s.teamA === me ? s.teamB : s.teamA) : null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gold/50 bg-gold/5 px-4 py-3">
        <div className="text-sm">
          <span className="mr-2 font-semibold text-gold">比赛进行中</span>
          {s && (
            <span className="text-mute">
              {s.label} · 对阵 <TeamName game={game} teamId={opp} /> · 第 {am.gameIndex + 1} 局
            </span>
          )}
        </div>
        <Button variant="gold" onClick={() => setView('match')}>
          继续比赛 ▶
        </Button>
      </div>
    );
  }

  if (eliminated) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2/50 px-4 py-3 text-sm">
        <span className="text-mute">
          你的战队已结束本项赛事征程
          {myPlacement && (
            <>
              ：<span className={rankClass(myPlacement.rankFrom)}>{formatRank(myPlacement.rankFrom, myPlacement.rankTo)}</span>
            </>
          )}
          。剩余比赛将自动模拟。
        </span>
      </div>
    );
  }

  const blockReason = blocking.length
    ? `请先在消息中心处理待决策事件：${blocking[0].title}`
    : !isCurrent
      ? '这不是你本回合要出战的赛事'
      : '';
  const enter = () => {
    void callSilent('prepareNextMatch').then((r) => {
      if (r?.ok) setView('match');
    });
  };

  const warnings = (blocking.length > 0 || lineupErr.length > 0) && (
    <div className="flex flex-wrap items-center gap-2 border-t border-dota/30 bg-dota/10 px-4 py-2 text-xs text-[#ffb4b4]">
      {blocking.length > 0 ? (
        <>
          <span>⚠ {blockReason}</span>
          <Button size="xs" onClick={() => setView('inbox')}>
            前往消息中心
          </Button>
        </>
      ) : (
        <>
          <span>
            ⚠ 首发阵容有问题：{lineupErr.join('；')}。进入比赛时会自动重排首发；仍不足 5 人时需临时招募替补，否则将弃权判负。
          </span>
          <Button size="xs" variant="gold" onClick={() => void call('fillLineupWithTempSubs')} title="自动排阵，并为空缺位置招募评分最高、付得起的临时替补">
            一键补齐首发
          </Button>
          <Button size="xs" onClick={() => setView('squad')}>
            调整阵容
          </Button>
        </>
      )}
    </div>
  );

  if (!next) {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-panel-2/50">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-mute">你的下一场对手尚未确定，需要先完成同轮其他比赛。</span>
          <Button variant="primary" disabled={!!blockReason} title={blockReason || '后台模拟其他比赛，直到你的下一场就绪'} onClick={enter}>
            进入下一场 ▶
          </Button>
        </div>
        {warnings}
      </div>
    );
  }

  const oppId = next.teamA === me ? next.teamB : next.teamA;
  const opp = teamInfo(game, oppId);
  const stage = t.stages.find((s) => s.id === next.stageId);
  const myR = safe(() => teamRating(game, me), 0);
  const oppR = oppId ? safe(() => teamRating(game, oppId), 0) : 0;
  const share = myR + oppR > 0 ? myR / (myR + oppR) : 0.5;
  const beef = oppId ? game.beefs.find((b) => b.teamId === oppId && b.season === game.season.ti) : undefined;
  const oppTeam = oppId ? game.teams[oppId] : undefined;

  return (
    <div className="overflow-hidden rounded-xl border border-dota/50 bg-gradient-to-r from-dota/15 via-panel/90 to-panel/90 shadow-lg shadow-black/20">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[11px] tracking-wider text-dota-2">我的下一场 · {stage?.name ?? '比赛'} · {next.label}</div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <TeamName game={game} teamId={me} className="text-base" />
            <span className="text-faint">VS</span>
            <TeamName game={game} teamId={oppId} className="text-base font-semibold" />
            <Badge className="bg-panel-3 text-ink">Bo{next.bestOf}</Badge>
            {beef && (
              <Badge className="bg-dota/20 text-dota-2 border border-dota/40" title={`宿敌对决：胜 +${beef.winHonor} / 负 ${beef.loseHonor} 荣誉`}>
                宿敌
              </Badge>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-mute">
            <span className="tabular" title="战队评分（首发评分之和 + 教练加成）">战力 {Math.round(myR)}</span>
            <div className="flex h-1.5 w-40 overflow-hidden rounded-full bg-panel-3">
              <div className="h-full bg-gold" style={{ width: `${share * 100}%` }} />
              <div className="h-full flex-1" style={{ background: opp.color }} />
            </div>
            <span className="tabular">{Math.round(oppR)}</span>
            {oppTeam && <span className="ml-2 text-faint">对手荣誉 {Math.round(oppTeam.honor)} · {REGION_LABEL[oppTeam.region]}</span>}
          </div>
        </div>
        {/* 主打轻松：快速模拟本场（主）→ 快速模拟整项赛事（副）→ 进入比赛·手动 BP（第三） */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="gold"
            size="lg"
            disabled={!!blockReason}
            title={blockReason || '自动 BP、跳过直播，直接得出本系列赛结果'}
            onClick={() => void call('quickSimSeries')}
          >
            快速模拟本场 ▶
          </Button>
          <ConfirmButton
            variant="secondary"
            disabled={!!blockReason}
            title={blockReason || '自动完成你在本赛事的全部剩余比赛（自动 BP、跳过直播）'}
            confirm={{
              message: <>你在「{t.name}」的全部剩余比赛将自动 BP 并瞬时得出结果，不再有文字直播。</>,
              confirmLabel: '确认模拟',
            }}
            onConfirm={() => void call('quickSimTournament')}
          >
            快速模拟整项赛事
          </ConfirmButton>
          <Button variant="ghost" disabled={!!blockReason} title={blockReason || '进入赛前准备 → 亲自 BP → 大老师胜率 → 文字直播'} onClick={enter}>
            进入比赛 · 手动 BP
          </Button>
        </div>
      </div>
      {warnings}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 未开赛：受邀队伍
// ---------------------------------------------------------------------------
function ScheduledInfo({ game, t }: { game: GameState; t: Tournament }) {
  const invited = t.invitedTeamIds ?? [];
  const teams = (t.teamIds ?? []).length ? t.teamIds : invited;
  return (
    <div className="p-4">
      <EmptyState
        text={
          t.status === 'scheduled'
            ? `赛事将在第 ${t.roundIndex} 回合开赛，届时生成分组与对阵。`
            : '本赛事没有可显示的阶段数据。'
        }
      />
      {teams.length > 0 && (
        <div>
          <div className="mb-2 text-xs text-mute">
            {(t.teamIds ?? []).length ? '已确定参赛队伍' : '已确定受邀队伍'}（{teams.length}）
            {t.status === 'scheduled' && <span className="ml-1 text-faint">· 其余名额开赛时按排名/荣誉及预选赛确定</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {teams.map((id) => (
              <span key={id} className="rounded-md border border-line bg-panel-2 px-2 py-1 text-xs">
                <TeamName game={game} teamId={id} />
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 名次表
// ---------------------------------------------------------------------------
function PlacementsCard({ game, t }: { game: GameState; t: Tournament }) {
  const me = game.settings.playerTeamId;
  const rows = (t.placements ?? []).slice().sort((a, b) => a.rankFrom - b.rankFrom || a.rankTo - b.rankTo);
  if (rows.length === 0) return null;
  const hasExp = !!t.expectedRanks && Object.keys(t.expectedRanks).length > 0;
  return (
    <Card title={t.status === 'finished' ? '最终排名' : '已确定名次'} subtitle={`${rows.length} 支队伍`} bodyClassName="p-0">
      <div className="max-h-[480px] overflow-y-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>名次</th>
              <th>战队</th>
              <th className="num">奖金</th>
              <th className="num">巡回赛积分</th>
              {hasExp && <th className="num" title="赛前预期名次（实际优于预期为绿色）">赛前预期</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const exp = t.expectedRanks?.[p.teamId];
              const mid = (p.rankFrom + p.rankTo) / 2;
              return (
                <tr key={p.teamId} className={cx(p.teamId === me && 'bg-gold/10')}>
                  <td className={rankClass(p.rankFrom)}>{formatRank(p.rankFrom, p.rankTo)}</td>
                  <td className="max-w-56">
                    <TeamName game={game} teamId={p.teamId} />
                  </td>
                  <td className="num">
                    <Gold value={p.prize ?? 0} />
                  </td>
                  <td className="num">{p.points ? Math.round(p.points) : <span className="text-faint">0</span>}</td>
                  {hasExp && (
                    <td className={cx('num', exp === undefined ? 'text-faint' : mid < exp - 0.5 ? 'text-good' : mid > exp + 0.5 ? 'text-bad' : 'text-mute')}>
                      {exp === undefined ? '—' : `#${Math.round(exp)}`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 玩家结算
// ---------------------------------------------------------------------------
function SettlementCard({ game, t }: { game: GameState; t: Tournament }) {
  const s = t.settlement;
  if (!s) return null;
  return (
    <Card title="我的赛事结算" className="border-gold/40">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="text-[11px] text-faint">最终名次</div>
          <div className={cx('text-2xl font-black', rankClass(s.rankFrom))}>{formatRank(s.rankFrom, s.rankTo)}</div>
          <div className="text-[11px] text-faint">共 {s.teams} 队</div>
        </div>
        <div className="text-right text-xs">
          <div>
            奖金 <Gold value={s.prize ?? 0} />
          </div>
          <div>
            出场费 <Gold value={s.appearanceFee ?? 0} />
          </div>
          <div className="text-mute">
            积分 <span className="tabular text-ink">{Math.round(s.points ?? 0)}</span>
          </div>
        </div>
      </div>
      {s.honor && <HonorBreakdownGrid h={s.honor} className="rounded-lg border border-line bg-panel-2/50 p-2.5" />}
      {s.playerGrowth && s.playerGrowth.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] text-faint">赛事成长（比赛主要磨炼韧性；战力 / 天梯 / 灵性主要靠训练）</div>
          <table className="tbl">
            <thead>
              <tr>
                <th>选手</th>
                <th className="num">韧性</th>
                <th className="num">战力</th>
                <th className="num">天梯</th>
                <th className="num">灵性</th>
              </tr>
            </thead>
            <tbody>
              {s.playerGrowth.map((g) => (
                <tr key={g.playerId}>
                  <td>{game.players[g.playerId]?.handle ?? g.playerId}</td>
                  <td className="num text-good">+{(g.resilience ?? 0).toFixed(1)}</td>
                  <td className="num text-good">+{(g.power ?? 0).toFixed(1)}</td>
                  <td className="num text-good">+{Math.round(g.mmr ?? 0)}</td>
                  <td className="num text-good">+{(g.insight ?? 0).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 参赛队伍
// ---------------------------------------------------------------------------
function TeamsCard({ game, t }: { game: GameState; t: Tournament }) {
  const me = game.settings.playerTeamId;
  const ids = Array.from(new Set([...(t.teamIds ?? []), ...(t.qualifierTeamIds ?? [])]));
  if (ids.length === 0) return null;
  const qual = new Set(t.qualifierTeamIds ?? []);
  const main = new Set(t.teamIds ?? []);
  const rows = ids
    .map((id) => {
      const place = t.placements?.find((p) => p.teamId === id);
      const elim = t.status === 'running' && !place ? safe(() => isTeamEliminated(game, t.id, id), false) : false;
      return {
        id,
        rating: safe(() => teamRating(game, id), 0),
        exp: t.expectedRanks?.[id],
        place,
        elim,
      };
    })
    .sort((a, b) => (a.exp ?? 999) - (b.exp ?? 999) || b.rating - a.rating);
  return (
    <Card title="参赛队伍" subtitle={`${ids.length} 支${qual.size ? ` · 其中 ${qual.size} 支参加封闭预选` : ''}`} bodyClassName="p-0">
      <div className="max-h-[520px] overflow-y-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>战队</th>
              <th className="num">战力</th>
              <th className="num">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cx(r.id === me && 'bg-gold/10', (r.elim || (r.place && t.status !== 'finished')) && 'opacity-60')}>
                <td className="max-w-40">
                  <TeamName game={game} teamId={r.id} mode="name" />
                  {qual.has(r.id) && !main.has(r.id) && <span className="ml-1 text-[10px] text-faint">预选</span>}
                </td>
                <td className="num">{Math.round(r.rating)}</td>
                <td className="num text-xs">
                  {r.place ? (
                    <span className={rankClass(r.place.rankFrom)}>{formatRank(r.place.rankFrom, r.place.rankTo)}</span>
                  ) : t.status === 'running' ? (
                    r.elim ? <span className="text-bad">淘汰</span> : <span className="text-good">在赛</span>
                  ) : t.status === 'scheduled' ? (
                    <span className="text-faint">{r.exp ? `预期 #${Math.round(r.exp)}` : '待赛'}</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
