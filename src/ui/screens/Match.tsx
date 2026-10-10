// ============================================================================
// 比赛页：赛前准备 → BP → 大老师胜率 → 文字直播 → 赛果（→ 系列赛结算）
// 状态读取 useGame()；一切修改经 call('engineFn', ...)（单机本地执行 / 多人发给服务器）；直播播放进度仅为本地 UI 状态。
// 「下一步」统一放在底部吸附操作栏（MatchDock），页面内不再重复放置主按钮。
// ============================================================================
import { useMemo, useState, type ReactNode } from 'react';
import { useCall, useCallSilent, useGame, useGameStore } from '../../store/gameStore';
import type { GameRecord, GameState, Series, Team, Tournament } from '../../engine/types';
import type { DraftSuggestion } from '../../engine';
import {
  REGION_LABEL, TOURNAMENT_TIER_LABEL, currentPlayerTournament, currentStep, getDraftSuggestions,
  isTeamEliminated, playerNextSeries, validateLineup,
} from '../../engine';
import { Badge, Button, Card, EmptyState, Hint, PageHeader, TeamLink, TeamTag, cx } from '../components/common';
import MatchDraft from '../components/MatchDraft';
import MatchDock from '../components/MatchDock';
import { heroCn } from '../components/MatchHero';
import MatchLive, { useLivePlayback, type Playback } from '../components/MatchLive';
import MatchPre from '../components/MatchPre';
import MatchSeriesSummary from '../components/MatchSeriesSummary';
import {
  FactionBadge, MineBadge, draftTeams, factionOf, gameWinnerId, predictedRadiant, safe, seriesDecided, seriesScore, teamOrStub,
  type Faction, type Side,
} from '../components/MatchShared';

interface FinishedSeries {
  tournamentId: string;
  seriesId: string;
  games: GameRecord[];
}

export default function Match() {
  const game = useGame();
  const call = useCall();
  const callSilent = useCallSilent();
  const setView = useGameStore((s) => s.setView);
  const [finished, setFinished] = useState<FinishedSeries | null>(null);

  const myId = game.settings.playerTeamId;
  const am = game.activeMatch;
  const tour = am ? game.tournaments[am.tournamentId] : undefined;
  const series = am && tour ? tour.series?.[am.seriesId] : undefined;
  const rec = am?.pendingGame;

  // 新的比赛已开始（如从底部操作栏「进入比赛」）→ 丢弃上一场的结算快照（渲染期派生状态重置）
  if (am && finished) setFinished(null);

  // ---- 以下 hooks 必须无条件调用（hooks 规则） ----
  const isLive = !!am && !!rec && (am.phase === 'live' || am.phase === 'result');
  const playback = useLivePlayback(isLive ? rec : null, am?.phase === 'result');

  // BP 推荐：按 BP 进度缓存（引擎推荐为确定性结果，且不修改游戏状态）
  const draft = am?.phase === 'draft' ? am.draft : null;
  const draftKey = draft ? `${am!.seriesId}|${am!.gameIndex}|${draft.done ? 1 : 0}|${draft.actions.map((a) => a.heroId).join(',')}` : '';
  const suggestions = useMemo<DraftSuggestion[]>(
    () => (draftKey ? safe(() => getDraftSuggestions(game), [] as DraftSuggestion[]) : []),
    // game 为原地修改的同一对象，BP 进度由 draftKey 表达
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftKey],
  );

  const goTournament = () => setView('tournament');
  // 打完 / 离开比赛默认回到总览（总览的赛事面板会自动显示下一场）；赛事中心只用于查看详细信息
  const goDashboard = () => setView('dashboard');

  const enterNext = () => {
    setFinished(null);
    void callSilent('prepareNextMatch');
  };

  // ------------------------------------------------------------------ 无比赛
  if (!am) {
    if (finished) {
      return (
        <div>
          <PageHeader
            title="系列赛结算"
            subtitle={game.tournaments[finished.tournamentId]?.name ?? '比赛'}
            actions={
              <Button variant="ghost" size="sm" onClick={goDashboard}>
                ← 返回总览
              </Button>
            }
          />
          <MatchSeriesSummary
            game={game}
            tournamentId={finished.tournamentId}
            seriesId={finished.seriesId}
            snapshot={finished.games}
            onBack={goDashboard}
            onDetails={goTournament}
            onNext={enterNext}
          />
        </div>
      );
    }
    return <NoMatch game={game} onTournament={goDashboard} onNext={enterNext} />;
  }

  // ------------------------------------------------------------------ 数据异常
  const invalidReason = !tour
    ? '找不到当前比赛对应的赛事'
    : !series
      ? '找不到当前比赛对应的系列赛'
      : !series.teamA || !series.teamB
        ? '对阵尚未确定'
        : series.result
          ? '该系列赛已经结束'
          : series.teamA !== myId && series.teamB !== myId
            ? '你的战队不在这场比赛中'
            : null;
  if (invalidReason || !tour || !series) {
    const reload = () => {
      void callSilent('prepareNextMatch').then((r) => {
        if (r && r.ok && !useGameStore.getState().game?.activeMatch) goTournament();
      });
    };
    return (
      <MatchPage
        dock={
          <MatchDock
            status="比赛数据异常"
            sub={invalidReason ?? undefined}
            primary={{ key: 'reload', label: '重新准备比赛 ▶', onClick: reload, title: '丢弃失效的比赛，载入下一场' }}
            extra={{ key: 'tour', label: '去赛事中心', onClick: goTournament }}
          />
        }
      >
        <PageHeader title="比赛" />
        <Card>
          <EmptyState text={`比赛数据异常：${invalidReason ?? '数据缺失'}`}>
            <Hint className="max-w-md">可能是读档后赛事已推进或存档数据不完整。点击「重新准备比赛」会丢弃这场失效的比赛，并载入你的下一场（如有）。</Hint>
          </EmptyState>
        </Card>
      </MatchPage>
    );
  }

  const teamA = teamOrStub(game, series.teamA);
  const teamB = teamOrStub(game, series.teamB);
  const mySeriesSide: Side = series.teamA === myId ? 'A' : 'B';
  const committed = am.games ?? [];
  const score = seriesScore(committed, series.teamA);
  const gameNo = (am.gameIndex ?? committed.length) + 1;
  const stage = tour.stages?.find((st) => st.id === series.stageId);

  // 阵营：本局生成后以记录为准；之前按引擎约定预测（系列赛 A 方在第 1/3/5 局为天辉）
  const seriesRadiant: Side = rec
    ? (rec.radiant === 'A') === (rec.teamA === series.teamA) ? 'A' : 'B'
    : predictedRadiant(am.gameIndex ?? committed.length);
  const factionA: Faction | null = factionOf(seriesRadiant, 'A');
  const factionB: Faction | null = factionOf(seriesRadiant, 'B');

  // 本局直播播完后，比分即计入本局（提交前预览）
  const scoreAfter = rec ? seriesScore([...committed, rec], series.teamA) : score;
  const seriesOver = !!rec && seriesDecided(series.bestOf, scoreAfter.a, scoreAfter.b);
  const shownScore = isLive && playback.done ? scoreAfter : score;
  const scoreText = (sc: { a: number; b: number }) => `${teamA.tag} ${sc.a} : ${sc.b} ${teamB.tag} · Bo${series.bestOf}`;

  const stepIndex =
    am.phase === 'pre' ? 0 : am.phase === 'draft' ? 1 : am.phase === 'result' || playback.done ? 4 : playback.n === 0 ? 2 : 3;

  // 多人玩家对决（对手是另一名玩家）：共享 BP 的对手状态（服务器视图只含与本座位相关的对决）
  const h2h = game.multiplayer?.h2h?.[am.seriesId] ?? null;
  const h2hOppSide: Side | null = h2h ? (h2h.teamA === myId ? 'B' : 'A') : null;
  const h2hOppMode = h2h && h2hOppSide ? h2h.mode?.[h2hOppSide] : undefined;
  const h2hOppId = h2h ? (h2h.teamA === myId ? h2h.teamB : h2h.teamA) : null;
  const h2hOppWantsSim = !!(h2h && h2hOppId && h2h.quickSim?.[h2hOppId]);
  const h2hMeWantsSim = !!(h2h && h2h.quickSim?.[myId]);
  const h2hPreHint = !h2h
    ? undefined
    : h2hOppWantsSim && !h2hMeWantsSim
      ? '玩家对决：对手已请求快速模拟，点击「快速模拟本场」即同意并直接出结果'
      : h2hMeWantsSim
        ? '玩家对决：你已请求快速模拟，等待对手同意（也可以继续手动 / 自动 BP）'
        : h2h.draft
          ? `玩家对决：对手已选择${h2hOppMode === 'manual' ? '手动' : '自动'} BP，请选择你的 BP 方式`
          : '玩家对决：双方各自选择手动或自动 BP；快速模拟需双方都同意';

  // ------------------------------------------------------------------ 操作（一律经 call 调用引擎）
  const onContinue = () => {
    const snap: FinishedSeries = {
      tournamentId: am.tournamentId,
      seriesId: am.seriesId,
      games: [...committed, ...(rec ? [rec] : [])],
    };
    void callSilent('commitGame').then((res) => {
      if (!res || !res.ok) return;
      const after = useGameStore.getState().game?.activeMatch;
      if (!after || after.seriesId !== snap.seriesId || after.tournamentId !== snap.tournamentId) setFinished(snap);
    });
  };

  const onQuickSim = () => {
    void call('quickSimSeries').then((res) => {
      // 玩家对决中单方请求只登记（ok=true，比赛仍在进行）：留在比赛页等待对手同意或继续 BP
      if (res && res.ok && !useGameStore.getState().game?.activeMatch) setView('dashboard');
    });
  };

  const startManual = () => void callSilent('startDraft', true);
  /** 自动 BP 后直接开打（大老师胜率 + 文字直播），省去一次确认 */
  const startAuto = () => void callSilent('autoDraftAndPlay');
  const startGame = () => void callSilent('playGame');
  const replayGame = () => void callSilent('playGame');

  let body: ReactNode;
  let dock: ReactNode;
  if (am.phase === 'pre') {
    const lineupErrors = safe(() => validateLineup(game, myId, am.tournamentId), [] as string[]);
    const blocked = lineupErrors.length > 0;
    const blockTitle = blocked ? `首发阵容不合法：${lineupErrors.join('；')}` : undefined;
    body = (
      <MatchPre
        game={game}
        tournament={tour}
        series={series}
        teams={{ A: teamA, B: teamB }}
        mySide={mySeriesSide}
        myFaction={mySeriesSide === 'A' ? factionA : factionB}
        games={committed}
        gameNo={gameNo}
        lineupErrors={lineupErrors}
        onAutoLineup={() => void callSilent('autoLineup', myId, am.tournamentId)}
        onFillSubs={() => void call('fillLineupWithTempSubs')}
        onGoSquad={() => setView('squad')}
      />
    );
    dock = (
      <MatchDock
        status={`第 ${gameNo} 局 · 赛前准备`}
        sub={scoreText(score)}
        secondary={{
          key: 'manual',
          label: '手动 BP',
          onClick: startManual,
          disabled: blocked,
          title: blockTitle ?? '亲自操刀 BP：每个我方回合给出推荐，也可在英雄池中任选',
        }}
        primary={{
          key: 'auto',
          label: '自动 BP · 开始比赛 ▶',
          onClick: startAuto,
          disabled: blocked,
          title: blockTitle ?? '教练组自动完成 BP，直接进入大老师胜率与文字直播',
        }}
        extra={{
          key: 'quick',
          label: '快速模拟本场',
          onClick: onQuickSim,
          title: blocked ? '首发不足 5 人：快速模拟将直接弃权判负' : '自动 BP、跳过直播，直接模拟本场系列赛剩余对局',
        }}
        hint={blocked ? '首发阵容不合法，请先调整' : h2hPreHint}
        hintTone={blocked ? 'bad' : h2h ? 'gold' : undefined}
      />
    );
  } else if (am.phase === 'draft') {
    if (!am.draft) {
      body = (
        <Card>
          <EmptyState text="BP 数据缺失">
            <Hint>可以重新开始本局 BP，或直接开打（自动 BP）。</Hint>
          </EmptyState>
        </Card>
      );
      dock = (
        <MatchDock
          status={`第 ${gameNo} 局 · BP 数据缺失`}
          sub={scoreText(score)}
          secondary={{ key: 'manual', label: '重新手动 BP', onClick: startManual }}
          primary={{ key: 'auto', label: '自动 BP · 开始比赛 ▶', onClick: startAuto }}
          extra={{ key: 'quick', label: '快速模拟本场', onClick: onQuickSim }}
        />
      );
    } else {
      const d = am.draft;
      const map = draftTeams(game, d, series);
      const dTeams = { A: teamOrStub(game, map.A), B: teamOrStub(game, map.B) };
      const myDraftSide: Side = map.A === myId ? 'A' : 'B';
      // 草稿 A 方 = 系列赛 A 方时直接沿用；若引擎交换了先手，阵营随之翻转
      const draftRadiant: Side = map.A === series.teamA ? seriesRadiant : seriesRadiant === 'A' ? 'B' : 'A';
      const step = safe(() => currentStep(d), null);
      const done = d.done || !step;
      const myTurn = !done && !!step && step.side === myDraftSide;
      const total = d.sequence?.length || 20;
      const verb = step?.type === 'ban' ? '禁用' : '选择';
      const top = myTurn ? suggestions[0] : undefined;
      body = (
        <MatchDraft
          game={game}
          draft={d}
          teams={dTeams}
          mySide={myDraftSide}
          radiant={draftRadiant}
          manual={am.manualDraft}
          suggestions={myTurn ? suggestions : []}
          onAction={(heroId) => void callSilent('playerDraftAction', heroId)}
        />
      );
      dock = done ? (
        <MatchDock
          status={`第 ${gameNo} 局 · BP 完成`}
          sub={scoreText(score)}
          primary={{ key: 'play', label: '开始比赛 ▶', onClick: startGame, title: '锁定阵容，查看大老师胜率并进入文字直播' }}
          hint="双方阵容已锁定"
        />
      ) : myTurn ? (
        <MatchDock
          status={`第 ${gameNo} 局 · BP 第 ${d.actions.length + 1}/${total} 步 · 我方${verb}`}
          sub={scoreText(score)}
          primary={
            top
              ? {
                  key: 'suggest',
                  label: `采纳首推 · ${verb} ${heroCn(top.heroId)}`,
                  variant: step?.type === 'ban' ? 'primary' : 'gold',
                  onClick: () => void callSilent('playerDraftAction', top.heroId),
                  title: top.reason || `${verb}推荐英雄`,
                }
              : { key: 'suggest', label: `请在上方英雄池中${verb}`, disabled: true, onClick: () => {}, title: '暂无推荐' }
          }
          hint="也可在上方推荐或英雄池中自选"
        />
      ) : (
        <MatchDock
          status={`第 ${gameNo} 局 · BP 第 ${d.actions.length + 1}/${total} 步`}
          sub={scoreText(score)}
          primary={{ key: 'wait', label: h2h && !h2hOppMode ? '等待对手选择 BP 方式…' : '对手 BP 中…', disabled: true, onClick: () => {} }}
          extra={{ key: 'quick', label: '快速模拟本场', onClick: onQuickSim, title: '自动补完 BP 并直接模拟本场系列赛剩余对局' }}
        />
      );
    }
  } else if (rec) {
    const recMySide: Side = rec.teamA === myId ? 'A' : 'B';
    const myScoreBefore = mySeriesSide === 'A' ? score.a : score.b;
    const oppScoreBefore = mySeriesSide === 'A' ? score.b : score.a;
    const win = rec.winner === recMySide;
    body = (
      <MatchLive
        game={game}
        rec={rec}
        gameNo={gameNo}
        mySide={recMySide}
        playback={playback}
        scoreBefore={{ mine: myScoreBefore, opp: oppScoreBefore }}
      />
    );
    dock = playback.done ? (
      <MatchDock
        status={`第 ${gameNo} 局 · ${win ? '胜利' : '失败'}`}
        sub={scoreText(scoreAfter)}
        primary={{
          key: 'continue',
          label: seriesOver ? '查看系列赛结算 ▶' : `继续 · 第 ${gameNo + 1} 局 ▶`,
          onClick: onContinue,
          title: seriesOver ? '提交本局并结算系列赛' : '提交本局，进入下一局的赛前准备',
        }}
        hint={seriesOver ? '本场系列赛已分出结果' : undefined}
        hintTone="gold"
      />
    ) : (
      <MatchDock
        status={`第 ${gameNo} 局 · ${playback.n === 0 ? '大老师胜率' : '文字直播'}`}
        sub={`${playback.n}/${playback.total} · ${scoreText(score)}`}
        primary={{ key: 'skip', label: '跳过直播 · 查看赛果 ⏭', variant: 'primary', onClick: playback.skip, title: '快捷键：空格' }}
        extra={{ key: 'pause', label: playback.paused ? '▶ 继续播放' : '❚❚ 暂停', onClick: playback.togglePause }}
        hint="空格键也可跳过"
      />
    );
  } else {
    body = (
      <Card>
        <EmptyState text="本局比赛记录缺失，无法播放文字直播">
          <Hint>可以重新开始本局（自动 BP），或快速模拟本场系列赛。</Hint>
        </EmptyState>
      </Card>
    );
    dock = (
      <MatchDock
        status={`第 ${gameNo} 局 · 记录缺失`}
        sub={scoreText(score)}
        primary={{ key: 'replay', label: '重新开始本局 ▶', onClick: replayGame }}
        extra={{ key: 'quick', label: '快速模拟本场', onClick: onQuickSim }}
      />
    );
  }

  return (
    <MatchPage dock={dock}>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {tour.name}
            <Badge className="bg-gold/15 text-gold">{TOURNAMENT_TIER_LABEL[tour.tier] ?? tour.tier}</Badge>
          </span>
        }
        subtitle={[stage?.name, series.label, `Bo${series.bestOf}`, `第 ${gameNo} 局`].filter(Boolean).join(' · ')}
        actions={
          <Button variant="ghost" size="sm" onClick={goDashboard} title="比赛进度会保留，可在总览的赛事面板中「继续比赛」">
            ← 返回总览
          </Button>
        }
      />
      <MatchBanner
        teamA={teamA}
        teamB={teamB}
        mySide={mySeriesSide}
        score={shownScore}
        bestOf={series.bestOf}
        gameNo={gameNo}
        factionA={factionA}
        factionB={factionB}
        stepIndex={stepIndex}
        playback={playback}
      />
      <div className="mt-4">{body}</div>
    </MatchPage>
  );
}

/** 页面容器：至少占满主内容区高度，使底部操作栏在内容较短时也贴住窗口底部 */
function MatchPage({ children, dock }: { children: ReactNode; dock?: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1">{children}</div>
      {dock}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 顶部对阵横幅 + 流程步骤
// ---------------------------------------------------------------------------
const STEPS = ['赛前准备', 'BP 禁选', '大老师胜率', '文字直播', '赛果'];

function MatchBanner({
  teamA,
  teamB,
  mySide,
  score,
  bestOf,
  gameNo,
  factionA,
  factionB,
  stepIndex,
  playback,
}: {
  teamA: Team;
  teamB: Team;
  mySide: Side;
  score: { a: number; b: number };
  bestOf: number;
  gameNo: number;
  factionA: Faction | null;
  factionB: Faction | null;
  stepIndex: number;
  playback: Playback;
}) {
  const pips = bestOf === 2 ? 2 : Math.ceil(bestOf / 2);
  return (
    <section
      className="overflow-hidden rounded-xl border border-line bg-panel/90 shadow-lg shadow-black/20"
      style={{ backgroundImage: `linear-gradient(90deg, ${teamA.color}2e, transparent 32%, transparent 68%, ${teamB.color}2e)` }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6 py-4">
        <BannerTeam team={teamA} mine={mySide === 'A'} faction={factionA} wins={score.a} pips={pips} />
        <div className="text-center">
          <div className="text-4xl font-black tabular tracking-wider">
            <span className={score.a > score.b ? 'text-ink' : 'text-mute'}>{score.a}</span>
            <span className="mx-2 text-faint">:</span>
            <span className={score.b > score.a ? 'text-ink' : 'text-mute'}>{score.b}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-faint">
            Bo{bestOf} · 第 {gameNo} 局
          </div>
        </div>
        <BannerTeam team={teamB} mine={mySide === 'B'} faction={factionB} wins={score.b} pips={pips} right />
      </div>
      <ol className="flex flex-wrap items-center gap-y-1 border-t border-line bg-panel-2/30 px-5 py-2 text-xs">
        {STEPS.map((s, i) => {
          const doneStep = i < stepIndex;
          const cur = i === stepIndex;
          return (
            <li key={s} className="flex items-center">
              <span className={cx('flex items-center gap-1.5', doneStep ? 'text-good' : cur ? 'font-semibold text-gold' : 'text-faint')}>
                <span
                  className={cx(
                    'grid h-5 w-5 place-items-center rounded-full border text-[10px]',
                    doneStep ? 'border-good/60 bg-good/15' : cur ? 'animate-pulse border-gold bg-gold/15' : 'border-line',
                  )}
                >
                  {doneStep ? '✓' : i + 1}
                </span>
                {s}
                {cur && i === 3 && !playback.done && (
                  <span className="tabular text-faint">
                    （{playback.n}/{playback.total}）
                  </span>
                )}
              </span>
              {i < STEPS.length - 1 && <span className={cx('mx-3 h-px w-8', doneStep ? 'bg-good/50' : 'bg-line')} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function BannerTeam({
  team,
  mine,
  faction,
  wins,
  pips,
  right,
}: {
  team: Team;
  mine: boolean;
  faction: Faction | null;
  wins: number;
  pips: number;
  right?: boolean;
}) {
  return (
    <div className={cx('flex min-w-0 items-center gap-3', right ? 'flex-row' : 'flex-row-reverse text-right')}>
      <div
        className="grid h-14 w-14 shrink-0 place-items-center rounded-xl text-sm font-black tracking-wide text-white shadow-lg ring-1 ring-black/40"
        style={{ background: `linear-gradient(135deg, ${team.color}, ${team.color}88)`, textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
      >
        {team.tag.slice(0, 4)}
      </div>
      <div className="min-w-0">
        <div className={cx('flex flex-wrap items-center gap-1.5', !right && 'justify-end')}>
          {mine && <MineBadge />}
          <FactionBadge faction={faction} />
          <span className="text-xs" title={REGION_LABEL[team.region] ?? team.region}>
            <TeamTag color={team.color} tag={team.tag} />
          </span>
          <span className="text-[11px] text-faint">{REGION_LABEL[team.region] ?? team.region}</span>
        </div>
        <div className="truncate text-lg font-bold">
          {team.id === 'tbd' ? team.name : <TeamLink teamId={team.id} name={team.name} />}
        </div>
        <div className={cx('mt-1 flex gap-1', !right && 'justify-end')}>
          {Array.from({ length: pips }).map((_, i) => (
            <span key={i} className={cx('h-1.5 w-5 rounded-full', i < wins ? 'bg-gold' : 'bg-panel-3')} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 无进行中比赛
// ---------------------------------------------------------------------------
function NoMatch({ game, onTournament, onNext }: { game: GameState; onTournament: () => void; onNext: () => void }) {
  const myId = game.settings.playerTeamId;
  const tour: Tournament | null = safe(() => currentPlayerTournament(game), null);
  const next: Series | null = tour && tour.status === 'running' ? safe(() => playerNextSeries(game, tour.id), null) : null;
  const eliminated = tour ? safe(() => isTeamEliminated(game, tour.id, myId), false) : false;
  const opp = next ? teamOrStub(game, next.teamA === myId ? next.teamB : next.teamA) : null;
  const last = lastPlayerGame(game);

  return (
    <div>
      <PageHeader title="比赛" subtitle="BP · 大老师胜率 · 文字直播" />
      <Card>
        <EmptyState text="当前没有进行中的比赛">
          <Hint className="max-w-md">
            {tour
              ? next
                ? `${tour.name} 的下一场已就绪，点击「进入下一场」开始赛前准备。`
                : tour.status !== 'running'
                  ? `${tour.name} 尚未开赛。`
                  : eliminated
                    ? `你已在 ${tour.name} 中被淘汰，剩余比赛会自动模拟。`
                    : `${tour.name} 进行中，正在等待其他比赛结果。`
              : '本回合没有待进行的比赛。赛事回合可在总览的赛事面板中点击「进入比赛」开始系列赛；休赛回合可以去训练或运营俱乐部。'}
          </Hint>
          {next && opp && (
            <div className="mt-1 flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-sm">
              <span className="text-mute">{next.label}</span>
              <span className="text-faint">·</span>
              <span>vs</span>
              <TeamTag color={opp.color} tag={opp.tag} />
              <span className="text-mute">{opp.name}</span>
              <Badge>Bo{next.bestOf}</Badge>
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button onClick={onTournament}>返回总览</Button>
            {tour && next && (
              <Button variant="gold" onClick={onNext}>
                进入下一场 ▶
              </Button>
            )}
          </div>
        </EmptyState>
      </Card>
      {last && (
        <Card title="最近一场系列赛" className="mt-4" bodyClassName="p-3">
          <LastSeriesLine game={game} series={last.series} tournament={last.tournament} myId={myId} />
        </Card>
      )}
    </div>
  );
}

/** 本赛季玩家最近一场已完成的系列赛 */
function lastPlayerGame(game: GameState): { series: Series; tournament: Tournament } | null {
  const myId = game.settings.playerTeamId;
  const ids = [...(game.seasonTournamentIds ?? [])].reverse();
  for (const tid of ids) {
    const t = game.tournaments[tid];
    if (!t?.series) continue;
    const done = Object.values(t.series).filter((s) => s.result && (s.teamA === myId || s.teamB === myId));
    if (done.length === 0) continue;
    done.sort((a, b) => {
      const sa = (t.stages ?? []).findIndex((st) => st.id === a.stageId);
      const sb = (t.stages ?? []).findIndex((st) => st.id === b.stageId);
      return sb - sa || b.round - a.round;
    });
    return { series: done[0], tournament: t };
  }
  return null;
}

function LastSeriesLine({ game, series, tournament, myId }: { game: GameState; series: Series; tournament: Tournament; myId: string }) {
  const a = teamOrStub(game, series.teamA);
  const b = teamOrStub(game, series.teamB);
  const r = series.result;
  if (!r) return null;
  const draw = r.scoreA === r.scoreB;
  const win = !draw && r.winnerId === myId;
  const mvps = (r.games ?? []).map((g) => (g.mvpPlayerId ? game.players[g.mvpPlayerId]?.handle : undefined)).filter(Boolean);
  const myWins = (r.games ?? []).filter((g) => gameWinnerId(g) === myId).length;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-mute">{tournament.name}</span>
      <span className="text-faint">{series.label}</span>
      <span className="flex items-center gap-2 font-semibold">
        <TeamTag color={a.color} tag={a.tag} />
        <span className="tabular">
          {r.scoreA} : {r.scoreB}
        </span>
        <TeamTag color={b.color} tag={b.tag} />
      </span>
      <Badge className={draw ? 'bg-info/15 text-info' : win ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad'}>{draw ? '平' : win ? '胜' : '负'}</Badge>
      {r.games?.length ? <span className="text-xs text-faint">我方赢下 {myWins} 局</span> : null}
      {mvps.length > 0 && <span className="text-xs text-faint">MVP：{mvps.join('、')}</span>}
    </div>
  );
}
