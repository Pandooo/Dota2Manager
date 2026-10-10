// ============================================================================
// 赛事卡片（总览「本回合」中内嵌、可展开；原赛事面板弹窗）：在总览中完成赛事回合的操作——
// 赛事概况、本方在当前阶段的位置、下一场（对手 / 阵容检查 / 进入比赛 / 快速模拟）、本赛事战绩；
// 查看完整对阵与积分时才进入「赛事中心」。标题行常驻显示下一场 / 比赛进度，收起时也能一键快速模拟本场。
// 展开状态 = store.tournamentOpen：赛事回合开始时自动展开（本方仍有比赛要打；见 store.syncTournamentCard + TourModalLogic），
// 其他回合自动收起；任何地方调用 setTournamentOpen(true)（如底栏「赛事面板」）都会回到总览、展开并滚动到这里。
// 二次确认（快速模拟整项赛事、首发不足时的「弃权本场」）用按钮旁的确认气泡（ConfirmButton），不弹窗。
// 一切修改经 call()（单机本地执行 / 多人发给服务器），按当前座位视图显示；玩家对决（H2H）显示等待状态。
// ============================================================================
import { useRef, useState, type ReactNode } from 'react';
import { useCall, useCallSilent, useGame, useGameStore, useIsMulti } from '../../store/gameStore';
import type { ActiveMatch, GameState, Series, Tournament } from '../../engine/types';
import {
  REGION_LABEL, awardedPrizePool, formatRank, h2hMatch, isAvailable, isTeamEliminated, playerNextSeries,
  readySeries, teamPlayers, teamRating, validateLineup,
} from '../../engine';
import { Badge, Button, Gold, TeamTag, cx } from './common';
import { ConfirmButton, type ConfirmSpec } from './ConfirmPopover';
import {
  InfoItem, TeamName, TourStatusBadge, TourTierBadge, openTournamentView, rankClass, safe, teamInfo,
} from './TourShared';
import { SeriesModal } from './TourSeriesModal';
import { seriesScore } from './MatchShared';
import { roundTournamentOf, seatSpectating } from './TourModalLogic';
import { MyResults, StageStatus, myStageOf, seriesStakes, stageText } from './TourModalParts';
import { useCardFocusScroll } from './TrainingModal';

/** 多人：该战队是否为仍在游戏中的玩家座位（未出局、战队未解散；与引擎 seatInPlay 一致） */
function seatInPlayOf(game: GameState, id: string | null | undefined): boolean {
  const seat = id ? game.multiplayer?.seats?.[id] : undefined;
  return !!id && !!seat && !seat.eliminated && !!game.teams[id] && !game.teams[id].disbanded;
}

/**
 * 多人：与该战队的系列赛是否为玩家对决（双方座位都仍在游戏中）。与引擎 isH2HSeries 一致：
 * 对手座位已出局 / 战队已解散时按普通比赛处理（快速模拟无需对方同意）。
 */
function isLiveH2H(game: GameState, oppId: string | null | undefined): boolean {
  return seatInPlayOf(game, oppId) && seatInPlayOf(game, game.settings.playerTeamId);
}

/** 操作被阻止的原因（待决策事件 / 观战），无则为空串 */
function actionBlockReason(game: GameState): string {
  if (seatSpectating(game)) return '你的战队已出局，当前为观战模式';
  const blocking = (game.pendingDecisions ?? []).filter((d) => d.blocking);
  return blocking.length ? `请先在消息中心处理待决策事件：${blocking[0].title}` : '';
}

/** 下一场的阵容检查与快速模拟按钮文案（标题行快捷按钮与展开后的「下一场」共用） */
function nextMatchInfo(game: GameState, t: Tournament, next: Series) {
  const me = game.settings.playerTeamId;
  const oppId = next.teamA === me ? next.teamB : next.teamA;
  const h2h = isLiveH2H(game, oppId);
  // 阵容检查（本赛事：签证 / 伤病 / 禁赛）
  const errs = safe(() => validateLineup(game, me, t.id), [] as string[]);
  const fieldable = safe(
    () => teamPlayers(game, me).filter((p) => isAvailable(p, t.id) && (!p.tempSubUntilTournament || p.tempSubUntilTournament === t.id)).length,
    5,
  );
  const short = errs.length > 0 && fieldable < 5;
  const block = actionBlockReason(game);
  const enterReason = block || (short ? `可出场选手不足 5 人（${fieldable}/5），请先用临时替补补位` : '');
  // 玩家对决：快速模拟需双方同意
  const hm = h2h ? safe(() => h2hMatch(game, next.id), null) : null;
  const oppWantsSim = !!(hm && oppId && hm.quickSim?.[oppId]);
  // 首发凑不齐 5 人时快速模拟 = 本场弃权判负（与底部操作栏的「弃权本场」一致，玩家对决同样直接弃权）
  const simLabel = short ? '弃权本场' : h2h ? (oppWantsSim ? '同意快速模拟' : '请求快速模拟') : '快速模拟本场';
  const simTitle = block
    ? block
    : short
      ? '首发不足 5 人：本场系列赛直接判负（先用临时替补补位可避免）'
      : h2h
        ? oppWantsSim
          ? '对手已请求快速模拟：同意后自动 BP、直接出结果'
          : '玩家对决的快速模拟需要双方都同意；请求后对手会看到提示'
        : '自动 BP、跳过直播，直接得出本系列赛结果';
  // 弃权不可撤销：与底部操作栏的「弃权本场」一样，在按钮旁确认（ConfirmButton）
  const simConfirm: ConfirmSpec | null = short
    ? { message: `本场系列赛（${next.label}）直接判负。先「用临时替补补位」可避免弃权。`, confirmLabel: '弃权', danger: true }
    : null;
  return { me, oppId, h2h, errs, fieldable, short, block, enterReason, simLabel, simTitle, simConfirm };
}

// ---------------------------------------------------------------------------
// 赛事卡片
// ---------------------------------------------------------------------------
export function TournamentCard({ className }: { className?: string }) {
  const game = useGame();
  const call = useCall();
  const open = useGameStore((s) => s.tournamentOpen);
  const setView = useGameStore((s) => s.setView);
  const [detail, setDetail] = useState<Series | null>(null);
  const ref = useRef<HTMLElement>(null);
  useCardFocusScroll('tournament', ref);

  const t = safe(() => roundTournamentOf(game), null);
  if (!t) return null;

  const me = game.settings.playerTeamId;
  const running = t.status === 'running';
  const am = game.activeMatch && game.activeMatch.tournamentId === t.id ? game.activeMatch : null;
  const amSeries = am ? t.series?.[am.seriesId] ?? null : null;
  const next = running && !am ? safe(() => playerNextSeries(game, t.id), null) : null;
  const eliminated = running ? safe(() => isTeamEliminated(game, t.id, me), false) : true;
  const stage = safe(() => myStageOf(t, me, amSeries ?? next), null);
  const exp = t.expectedRanks?.[me] ?? t.expectedRank;
  const pl = t.placements?.find((p) => p.teamId === me);
  // 卡片内的展开 / 收起只切换状态（不发滚动请求）；从其他地方打开用 store.setTournamentOpen(true)
  const toggle = () => useGameStore.setState({ tournamentOpen: !open });

  // ---------------- 标题行：一句话进度 + 收起时的快捷操作 ----------------
  let summary: ReactNode;
  let quick: ReactNode = null;
  if (am && amSeries) {
    const oppId = amSeries.teamA === me ? amSeries.teamB : amSeries.teamA;
    const sc = seriesScore(am.games ?? [], amSeries.teamA);
    const [my, theirs] = amSeries.teamA === me ? [sc.a, sc.b] : [sc.b, sc.a];
    summary = (
      <>
        <span className="text-gold">比赛进行中</span> · vs {teamInfo(game, oppId).tag} · 第 {(am.gameIndex ?? 0) + 1} 局 · 比分{' '}
        <b className="tabular text-ink">
          {my}:{theirs}
        </b>
      </>
    );
    quick = (
      <Button size="sm" variant="gold" onClick={() => setView('match')}>
        继续比赛 ▶
      </Button>
    );
  } else if (running && next) {
    const info = nextMatchInfo(game, t, next);
    summary = (
      <>
        下一场 vs <span className="text-ink">{teamInfo(game, info.oppId).tag}</span>
        {' · '}
        {stage?.name ? `${stage.name} · ` : ''}
        {next.label} · Bo{next.bestOf}
        {info.short && <span className="ml-1 text-bad">· 首发不足 5 人</span>}
      </>
    );
    quick = (
      <ConfirmButton
        size="sm"
        variant={info.short ? 'danger' : 'gold'}
        disabled={!!info.block}
        title={info.simTitle}
        confirm={info.simConfirm}
        onConfirm={() => void call('quickSimSeries')}
      >
        {info.simLabel}
        {info.short ? '' : ' ▶'}
      </ConfirmButton>
    );
  } else if (running && !eliminated) {
    summary = '等待下一场对手确定';
  } else if (t.status === 'scheduled') {
    summary = '尚未开赛';
  } else {
    summary = pl ? (
      <>
        {t.status === 'finished' ? '最终名次' : '本方已结束征程'}{' '}
        <b className={rankClass(pl.rankFrom)}>{formatRank(pl.rankFrom, pl.rankTo)}</b>
      </>
    ) : t.status === 'finished' ? (
      '赛事已结束'
    ) : (
      '本方已结束本项赛事征程'
    );
  }

  let main: ReactNode;
  if (am && amSeries) main = <LiveMatchPanel game={game} t={t} am={am} series={amSeries} />;
  else if (running && next) main = <NextMatchCard game={game} t={t} next={next} />;
  else if (running && !eliminated) main = <WaitingPanel game={game} t={t} />;
  else main = <OutcomePanel game={game} t={t} eliminated={eliminated} />;

  return (
    <>
      <section
        ref={ref}
        className={cx(
          'scroll-mt-4 overflow-hidden rounded-xl border bg-panel-2/40',
          t.tier === 'ti' ? 'border-gold/50' : running ? 'border-dota/40' : 'border-line',
          className,
        )}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            title={open ? '收起赛事卡片' : '展开赛事：下一场、阵容检查、本阶段战况与本赛事战绩'}
            className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-left"
          >
            <span className={cx('text-sm font-semibold', t.tier === 'ti' ? 'text-gold' : 'text-ink')}>♜ {t.name}</span>
            <TourTierBadge tier={t.tier} />
            <TourStatusBadge status={t.status} />
            <span className="min-w-0 truncate text-xs text-mute">{summary}</span>
          </button>
          {!open && quick}
          <button type="button" onClick={toggle} className="shrink-0 cursor-pointer text-xs text-faint hover:text-gold">
            {open ? '收起 ▴' : '展开 ▾'}
          </button>
        </div>

        {open && (
          <div className="space-y-4 border-t border-line/70 px-4 py-3">
            {/* 赛事概况 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-line bg-panel-2/50 px-3 py-2.5 sm:grid-cols-4">
              <InfoItem label="地点">
                {t.online ? '线上' : t.city || '—'}
                <span className="ml-1 text-xs text-faint">{REGION_LABEL[t.hostRegion] ?? t.hostRegion}</span>
              </InfoItem>
              <InfoItem label="奖金池（游戏内发放）">
                <span title={`真实奖金池 $${Math.round(t.prizePool ?? 0).toLocaleString('en-US')}，按年代与赛事等级换算为游戏金币发放`}>
                  <Gold value={safe(() => awardedPrizePool(game, t), 0)} />
                  {(t.prizePool ?? 0) > 0 && <span className="ml-1 text-[11px] text-faint">${Math.round(t.prizePool ?? 0).toLocaleString('en-US')}</span>}
                </span>
              </InfoItem>
              <InfoItem label="当前阶段">
                <span title={stage ? stageText(stage) : undefined}>
                  {t.status === 'finished' ? '已结束' : stage ? stageText(stage) : running ? '—' : '未开赛'}
                </span>
              </InfoItem>
              <InfoItem label="赛前预期">
                {exp !== undefined && Number.isFinite(exp) ? (
                  <span className="text-gold" title="开赛时按参赛队战力与荣誉排名得出，不达预期会扣荣誉">
                    第 {Math.round(exp)} 名左右
                  </span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </InfoItem>
            </div>
            {t.advanceToTi && <div className="-mt-2 text-[11px] text-mute">TI 赛区预选：前 {t.advanceToTi.slots} 名晋级本届 TI 正赛。</div>}

            {main}

            <div className="grid gap-4 md:grid-cols-2">
              <section className="min-w-0">
                <div className="mb-1.5 text-xs font-semibold text-mute">本方当前阶段</div>
                <StageStatus game={game} t={t} stage={stage} me={me} next={next ?? amSeries} eliminated={eliminated} />
              </section>
              <section className="min-w-0">
                <div className="mb-1.5 text-xs font-semibold text-mute">本赛事战绩</div>
                <MyResults game={game} t={t} me={me} onOpen={setDetail} />
              </section>
            </div>

            <div className="border-t border-line/60 pt-2.5">
              <button
                type="button"
                className="cursor-pointer text-xs text-mute hover:text-gold hover:underline"
                title="赛事 / 赛事中心：完整分组、对阵图、名次与参赛队伍"
                onClick={() => openTournamentView(game, t.id)}
              >
                查看赛事详情（完整分组与对阵图）›
              </button>
            </div>
          </div>
        )}
      </section>
      {/* 系列赛逐局详情（点击「本赛事战绩」中的一场时打开；放在卡片外，避免 fixed 定位受祖先样式影响） */}
      <SeriesModal game={game} series={detail} onClose={() => setDetail(null)} />
    </>
  );
}

export default TournamentCard;

function BlockBar({ game }: { game: GameState }) {
  const setView = useGameStore((s) => s.setView);
  const blocking = (game.pendingDecisions ?? []).filter((d) => d.blocking);
  if (!blocking.length || seatSpectating(game)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-dota/30 bg-dota/10 px-4 py-2 text-xs text-[#ffb4b4]">
      <span>⚠ 有 {blocking.length} 项待决策事件，处理后才能比赛：{blocking[0].title}</span>
      <Button size="xs" onClick={() => setView('inbox')}>
        前往消息中心
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 下一场
// ---------------------------------------------------------------------------
function NextMatchCard({ game, t, next }: { game: GameState; t: Tournament; next: Series }) {
  const call = useCall();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const info = nextMatchInfo(game, t, next);
  const { me, oppId, h2h, errs, fieldable, short, block, enterReason, simLabel, simTitle, simConfirm } = info;
  const opp = teamInfo(game, oppId);
  const oppTeam = oppId ? game.teams[oppId] : undefined;
  const stage = t.stages?.find((s) => s.id === next.stageId) ?? null;
  const myR = safe(() => teamRating(game, me), 0);
  const oppR = oppId ? safe(() => teamRating(game, oppId), 0) : 0;
  const share = myR + oppR > 0 ? myR / (myR + oppR) : 0.5;
  const beef = oppId ? (game.beefs ?? []).find((b) => b.teamId === oppId && b.season === game.season.ti) : undefined;
  const stakes = seriesStakes(next, stage);

  const enter = () => {
    void callSilent('prepareNextMatch').then((r) => {
      if (r && r.ok) setView('match');
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-dota/50 bg-gradient-to-r from-dota/15 via-panel/90 to-panel/90">
      <div className="space-y-2.5 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] tracking-wider text-dota-2">
            我的下一场 · {stage?.name ?? '比赛'} · {next.label}
          </div>
          <div className="flex items-center gap-1.5">
            <Badge className="bg-panel-3 text-ink">Bo{next.bestOf}</Badge>
            {h2h && <Badge className="bg-info/15 text-info border border-info/40">玩家对决</Badge>}
            {beef && (
              <Badge className="bg-dota/20 text-dota-2 border border-dota/40" title="本赛季宿敌：胜负额外影响荣誉">
                宿敌
              </Badge>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* 战队色块 + 标签 + 全名（全名可点击查看战队详情） */}
          <TeamName game={game} teamId={oppId} mode="both" className="min-w-0 text-base" />
          {oppTeam && (
            <span className="text-xs text-faint">
              荣誉 <span className="tabular text-mute">{Math.round(oppTeam.honor)}</span> · {REGION_LABEL[oppTeam.region] ?? oppTeam.region}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-mute">
          <span className="tabular" title="我方战队评分（首发评分之和 + 教练加成）">我方 {Math.round(myR)}</span>
          <div className="flex h-1.5 w-40 overflow-hidden rounded-full bg-panel-3">
            <div className="h-full bg-gold" style={{ width: `${share * 100}%` }} />
            <div className="h-full flex-1" style={{ background: opp.color }} />
          </div>
          <span className="tabular" title="对手战队评分">对手 {Math.round(oppR)}</span>
        </div>

        {(stakes || beef) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {stakes && <span className="text-mute">{stakes}</span>}
            {beef && (
              <span className="text-dota-2">
                宿敌对决：胜 +{beef.winHonor} / 负 {beef.loseHonor} 荣誉
              </span>
            )}
          </div>
        )}

        {/* 阵容检查 */}
        {errs.length > 0 ? (
          <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs">
            <div className="text-[#ffb4b4]">
              ⚠ 首发阵容有问题：{errs.join('；')}
              {short ? `。可出场选手不足 5 人（${fieldable}/5），未补齐将弃权判负。` : '。进入比赛时也会自动重排首发。'}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {short ? (
                <Button size="xs" variant="gold" onClick={() => void call('fillLineupWithTempSubs')} title="自动排阵，并为空缺位置招募评分最高、付得起的临时替补">
                  用临时替补补位
                </Button>
              ) : (
                <Button size="xs" variant="gold" onClick={() => void call('autoArrangeLineup', t.id)} title="按本赛事可出场的选手自动排出最强首发">
                  自动排阵
                </Button>
              )}
              <Button size="xs" onClick={() => setView('squad')}>
                调整阵容 ›
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-good">
            ✓ 首发阵容完整
            <button type="button" className="cursor-pointer text-[11px] text-mute hover:text-gold hover:underline" onClick={() => setView('squad')}>
              阵容 ›
            </button>
          </div>
        )}

        {h2h && oppId && <H2HStatus game={game} seriesId={next.id} oppId={oppId} joinedMe={false} />}

        {/* 主打轻松：快速模拟本场（主）→ 快速模拟整项赛事（副，按钮旁确认）→ 进入比赛·手动 BP（第三） */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <ConfirmButton
            variant={short ? 'danger' : 'gold'}
            size="lg"
            disabled={!!block}
            title={simTitle}
            confirm={simConfirm}
            onConfirm={() => void call('quickSimSeries')}
          >
            {simLabel} {short ? '' : '▶'}
          </ConfirmButton>
          <ConfirmButton
            variant="secondary"
            disabled={!!block}
            title={block || '自动完成你在本赛事的全部剩余比赛（自动 BP、跳过直播）'}
            confirm={{
              title: '快速模拟整项赛事',
              message: (
                <>
                  你在「{t.name}」的全部剩余比赛将自动 BP 并瞬时得出结果，不再有文字直播。
                  {game.multiplayer ? '与其他玩家的对决需要对方也同意快速模拟，届时会停下等待。' : ''}
                  {short && (
                    <span className="mt-1 block text-bad">⚠ 可出场选手不足 5 人：未补齐首发时，每一场都将直接弃权判负。建议先「用临时替补补位」。</span>
                  )}
                </>
              ),
              confirmLabel: '确认模拟',
              danger: short,
            }}
            onConfirm={() => void call('quickSimTournament')}
          >
            快速模拟整项赛事
          </ConfirmButton>
          <Button variant="ghost" disabled={!!enterReason} title={enterReason || '进入赛前准备 → 亲自 BP → 大老师胜率 → 文字直播'} onClick={enter}>
            进入比赛 · 手动 BP
          </Button>
        </div>
      </div>
      <BlockBar game={game} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 比赛进行中
// ---------------------------------------------------------------------------
function LiveMatchPanel({ game, t, am, series }: { game: GameState; t: Tournament; am: ActiveMatch; series: Series }) {
  const setView = useGameStore((s) => s.setView);
  const call = useCall();
  const me = game.settings.playerTeamId;
  const oppId = series.teamA === me ? series.teamB : series.teamA;
  const opp = teamInfo(game, oppId);
  const stage = t.stages?.find((s) => s.id === series.stageId);
  const sc = seriesScore(am.games ?? [], series.teamA);
  const my = series.teamA === me ? sc.a : sc.b;
  const theirs = series.teamA === me ? sc.b : sc.a;
  const h2h = isLiveH2H(game, oppId);
  // 快速模拟本场（与比赛页一致：自动补完 BP、直接出结果）；玩家对决需双方同意
  const hm = h2h ? safe(() => h2hMatch(game, series.id), null) : null;
  const oppSim = !!(hm && oppId && hm.quickSim?.[oppId]);
  const meSim = !!hm?.quickSim?.[me];
  const showSim = !seatSpectating(game) && !hm?.done;
  const simLabel = h2h ? (meSim ? '已请求快速模拟' : oppSim ? '同意快速模拟' : '请求快速模拟') : '快速模拟本场';
  const simTitle = h2h
    ? meSim
      ? '已请求快速模拟，等待对手同意'
      : oppSim
        ? '对手已请求快速模拟：同意后自动 BP、直接出结果'
        : '玩家对决的快速模拟需要双方都同意；请求后对手会看到提示'
    : '自动补完 BP，直接模拟本场系列赛剩余对局（不再有文字直播）';
  return (
    <div className="space-y-2 rounded-xl border border-gold/50 bg-gold/5 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <div className="font-semibold text-gold">比赛进行中</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-mute">
            <span>
              {stage?.name ? `${stage.name} · ` : ''}
              {series.label}
            </span>
            <span className="text-faint">vs</span>
            <TeamTag color={opp.color} tag={opp.tag} />
            <span>· 第 {(am.gameIndex ?? 0) + 1} 局</span>
            <span>
              · 比分 <b className="tabular text-ink">{my}:{theirs}</b>（Bo{series.bestOf}）
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="gold" size="lg" onClick={() => setView('match')}>
            继续比赛 ▶
          </Button>
          {showSim && (
            <Button disabled={meSim} title={simTitle} onClick={() => void call('quickSimSeries')}>
              {simLabel}
            </Button>
          )}
        </div>
      </div>
      {h2h && oppId && <H2HStatus game={game} seriesId={series.id} oppId={oppId} joinedMe />}
    </div>
  );
}

/** 玩家对决：对手是否进入比赛、快速模拟请求（服务器视图只含与本座位相关的对决） */
function H2HStatus({ game, seriesId, oppId, joinedMe }: { game: GameState; seriesId: string; oppId: string; joinedMe: boolean }) {
  const names = useGameStore((s) => s.mp.roundStatus?.names);
  const me = game.settings.playerTeamId;
  const h = safe(() => h2hMatch(game, seriesId), null);
  const who = `${names?.[oppId] ? `${names[oppId]}（${game.teams[oppId]?.tag ?? oppId}）` : game.teams[oppId]?.tag ?? '对手'}`;
  const oppJoined = !!h?.joined?.[oppId];
  const oppSim = !!h?.quickSim?.[oppId];
  const meSim = !!h?.quickSim?.[me];
  const text = h?.done
    ? '本场对决已出结果，进入比赛可看完本局回放'
    : oppSim && !meSim
    ? `${who} 已请求快速模拟：点「同意快速模拟」即直接出结果`
    : meSim
      ? `你已请求快速模拟，等待 ${who} 同意（也可以进入比赛继续手动 / 自动 BP）`
      : oppJoined
        ? joinedMe
          ? `${who} 已在比赛中，双方各自选择 BP 方式后开打`
          : `${who} 已进入比赛，正在等你`
        : joinedMe
          ? `等待 ${who} 进入比赛…`
          : `${who} 尚未进入比赛；你可以先进入比赛等待，或请求快速模拟（需双方同意）`;
  return (
    <div className="flex items-center gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-1.5 text-xs text-info">
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', oppJoined || oppSim ? 'bg-good' : 'animate-pulse bg-info')} />
      玩家对决：{text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 下一场对手未确定
// ---------------------------------------------------------------------------
function WaitingPanel({ game, t }: { game: GameState; t: Tournament }) {
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const multi = useIsMulti();
  const me = game.settings.playerTeamId;
  const block = actionBlockReason(game);
  // 多人：正在进行、牵涉其他玩家的系列赛（本方下一场要等它们的结果）
  const humanPending = multi
    ? safe(() => readySeries(game, t.id), [] as Series[]).filter((s) =>
        [s.teamA, s.teamB].some((id) => !!id && id !== me && seatInPlayOf(game, id)),
      )
    : [];
  const enter = () => {
    void callSilent('prepareNextMatch').then((r) => {
      if (r && r.ok && useGameStore.getState().game?.activeMatch) setView('match');
    });
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel-2/50">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
        <div className="min-w-0 text-mute">
          {humanPending.length > 0 ? (
            <>
              <div className="flex items-center gap-2 text-info">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
                你的下一场对手尚未确定，正在等待其他玩家完成比赛
              </div>
              <div className="mt-1 space-y-0.5 text-xs">
                {humanPending.slice(0, 3).map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5">
                    <span className="text-faint">{s.label}：</span>
                    <TeamName game={game} teamId={s.teamA} />
                    <span className="text-faint">vs</span>
                    <TeamName game={game} teamId={s.teamB} />
                  </div>
                ))}
              </div>
            </>
          ) : (
            '你的下一场对手尚未确定，需要先完成同轮其他比赛。'
          )}
        </div>
        {humanPending.length === 0 && (
          <Button variant="primary" disabled={!!block} title={block || '后台模拟其他比赛，直到你的下一场就绪'} onClick={enter}>
            进入下一场 ▶
          </Button>
        )}
      </div>
      <BlockBar game={game} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 本方赛程已结束 / 未开赛
// ---------------------------------------------------------------------------
function OutcomePanel({ game, t, eliminated }: { game: GameState; t: Tournament; eliminated: boolean }) {
  const me = game.settings.playerTeamId;
  const pl = t.placements?.find((p) => p.teamId === me);
  const failedQualifier = (t.qualifierTeamIds ?? []).includes(me) && !(t.teamIds ?? []).includes(me);
  const honor = t.settlement?.honor?.total;
  if (t.status === 'scheduled') {
    return (
      <div className="rounded-lg border border-line bg-panel-2/50 px-4 py-3 text-sm text-mute">
        「{t.name}」尚未开赛，开赛后在这里查看对阵与你的下一场。
      </div>
    );
  }
  const finished = t.status === 'finished';
  return (
    <div className={cx('rounded-xl border px-4 py-3', finished ? 'border-gold/40 bg-gold/5' : 'border-line bg-panel-2/50')}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] text-faint">{finished ? '赛事已结束' : '你的战队已结束本项赛事征程'}</div>
          <div className={cx('text-xl font-black', pl ? rankClass(pl.rankFrom) : 'text-mute')}>
            {pl ? formatRank(pl.rankFrom, pl.rankTo) : failedQualifier ? '未能晋级正赛' : '—'}
          </div>
        </div>
        <div className="text-right text-xs text-mute">
          {pl && (finished || (pl.prize ?? 0) > 0) && (
            <div>
              奖金 <Gold value={pl.prize ?? 0} />
            </div>
          )}
          {finished && honor !== undefined && Number.isFinite(honor) && (
            <div>
              荣誉 <span className={cx('tabular', honor >= 0 ? 'text-good' : 'text-bad')}>{honor >= 0 ? '+' : ''}{Math.round(honor)}</span>
            </div>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-mute">
        {finished
          ? '结算明细见总览顶部的「通知」与赛事中心。可以收起卡片，继续运营或推进到下一回合。'
          : eliminated
            ? `${failedQualifier && !pl ? '封闭预选赛未能晋级正赛。' : ''}剩余比赛将自动模拟，赛事结束后发放奖金与荣誉结算。`
            : ''}
      </p>
    </div>
  );
}
