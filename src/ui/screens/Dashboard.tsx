// 总览（每个回合的中枢，信息精简版，没有弹窗）：
//   新闻滚动栏 → 通知（有回合通知时：赛事结算 / 版本更新 / 赛季总结 / 新秀选秀 / 消息，最新在前，点击在原处展开，见 PopupHost）→
//   本回合（时间轴 + 指引 + 内嵌卡片：赛事回合为赛事卡片〔回合开始时自动展开，见 TournamentModal〕，
//   休赛 / 观赛回合为训练卡片〔见 TrainingModal〕；报名 / 新秀选秀等跳转对应中心页）→ 待处理（红点，点击展开）→
//   回合要闻 + 世界动态 | 俱乐部概况（评分、排名、荣誉、金币、每回合收支）+ 积分榜。
// 最省事的玩法是一直点底部操作栏的主按钮（快速模拟本场 / 下一回合）；需要细调时在本页展开卡片完成，不必切换页面。
// 阵容、赛程、走势、版本详情分别在「战队」「赛事」「俱乐部」中心页查看，这里不再重复；
// 推进阻塞（进行中的比赛 / 待决事件 / 阵容问题）由底部操作栏的主按钮与提示负责，未读数在侧栏「消息」与新闻栏，这里也不重复。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useGame, useGameStore } from '../../store/gameStore';
import {
  CONFIG,
  activeTeams, currentPlayerTournament, currentRound, formatGold, formatRank, getCoach,
  draftedRookiesOf, isTransferWindowOpen, rankTeamsByRating, regularRoundCount, roundKindForPlayer, roundRevenue,
  roundWageBill, rosterOverflowNotice, seasonStandings, teamPlayers, teamRating, trainingSessionsLeft, validateLineup,
  type GameState, type RoundInfo, type RoundRevenue, type Team, type Tournament,
} from '../../engine';
import { getTiInfo } from '../../data/index';
import { Button, Card, Delta, EmptyState, Gold, PageHeader, TeamLink, cx } from '../components/common';
import { MiniTitle, ROUND_KIND_TEXT, TourTierBadge, roundLabel, safe } from '../components/ShellKit';
import NewsTicker from '../components/NewsTicker';
import RoundDigest from '../components/RoundDigest';
import WorldFeed from '../components/WorldFeed';
import { roundTournamentOf, seatSpectating, tourRoundKeyOf } from '../components/TourModalLogic';
import { NoticesCard } from '../components/PopupHost';
import { TournamentCard } from '../components/TournamentModal';
import { TrainingCard } from '../components/TrainingModal';

type Kind = 'preseason' | 'rest' | 'tournament' | 'ti_qualifier' | 'ti' | 'ti_watch';

const KIND_STYLE: Record<Kind, { text: string; chip: string; seg: string }> = {
  preseason: { text: 'text-info', chip: 'bg-info/15 text-info border-info/40', seg: 'bg-info/70' },
  rest: { text: 'text-good', chip: 'bg-good/15 text-good border-good/40', seg: 'bg-panel-3' },
  tournament: { text: 'text-gold', chip: 'bg-gold/15 text-gold border-gold/40', seg: 'bg-gold/80' },
  ti_qualifier: { text: 'text-tier-ss', chip: 'bg-tier-ss/15 text-tier-ss border-tier-ss/40', seg: 'bg-tier-ss/80' },
  ti: { text: 'text-gold', chip: 'bg-dota/25 text-gold border-gold/50', seg: 'bg-dota-2' },
  ti_watch: { text: 'text-mute', chip: 'bg-panel-3 text-mute border-line', seg: 'bg-dota/40' },
};

const ENTRY_LABEL: Record<string, string> = { invited: '受邀', registered: '已报名', open: '可报名', locked: '未解锁', declined: '未参加' };

const STANDINGS_TOP = 6;

function fallbackRound(game: GameState): RoundInfo {
  return { index: game.roundIndex, phase: game.phase, startDate: game.currentDate, endDate: game.currentDate, tournamentIds: [], patchVersions: [] };
}

/** 玩家本赛季参加（受邀/已报名/在名单中）的赛事，按回合排序 */
function playerSeasonTournaments(game: GameState): Tournament[] {
  const me = game.settings.playerTeamId;
  const ids = new Set<string>([...(game.seasonTournamentIds ?? []), `ti-${game.season.ti}`]);
  for (const r of game.season?.rounds ?? []) for (const id of r.tournamentIds ?? []) ids.add(id);
  const out: Tournament[] = [];
  for (const id of ids) {
    const t = game.tournaments[id];
    if (!t || t.season !== game.season.ti) continue;
    const mine =
      t.playerStatus === 'invited' || t.playerStatus === 'registered' || (t.teamIds ?? []).includes(me) || (t.qualifierTeamIds ?? []).includes(me);
    if (mine) out.push(t);
  }
  return out.sort((a, b) => a.roundIndex - b.roundIndex || a.startDate.localeCompare(b.startDate));
}

function TodoRow({ icon, tone, children, count, onClick, title }: { icon: string; tone: string; children: ReactNode; count?: ReactNode; onClick?: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors hover:border-line hover:bg-panel-2/70"
    >
      <span className={cx('grid h-6 w-6 shrink-0 place-items-center rounded text-xs font-bold', tone)}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && <span className="tabular text-xs font-semibold">{count}</span>}
      <span className="text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-gold">›</span>
    </button>
  );
}

export default function Dashboard() {
  const game = useGame();
  const setView = useGameStore((s) => s.setView);
  const trainingOpen = useGameStore((s) => s.trainingOpen);
  const trainingFocusRound = useGameStore((s) => (s.cardFocus?.card === 'training' ? s.cardFocus.roundKey : null));
  const [todoOpen, setTodoOpen] = useState(false);
  // 进入新回合（推进 / 多人服务器推进）时回到页面顶部：新的通知与本回合卡片都在上方
  const rootRef = useRef<HTMLDivElement>(null);
  const roundKey = safe(() => tourRoundKeyOf(game), '');
  const lastRoundKey = useRef(roundKey);
  useEffect(() => {
    if (lastRoundKey.current === roundKey) return;
    lastRoundKey.current = roundKey;
    rootRef.current?.closest('main')?.scrollTo?.({ top: 0 });
  }, [roundKey]);

  const me = game.settings.playerTeamId;
  const team: Team | undefined = game.teams[me];
  if (!team) {
    return (
      <Card>
        <EmptyState text="找不到你的战队数据，存档可能已损坏。请尝试读取其他存档。" />
      </Card>
    );
  }

  const ti = game.season?.ti ?? game.settings.startTi;
  const rounds = game.season?.rounds ?? [];
  const totalRounds = rounds.length;
  const R = safe(() => regularRoundCount(game.season), CONFIG.calendar.regularRounds);
  const round = safe(() => currentRound(game), fallbackRound(game));
  const kind = safe<Kind>(() => roundKindForPlayer(game, game.roundIndex), game.roundIndex === 0 ? 'preseason' : 'rest');
  const tour = safe(() => currentPlayerTournament(game), null as Tournament | null);
  const sessions = safe(() => trainingSessionsLeft(game), 0);
  // 赛季初：本届选秀选中、仍在队的新秀（可保留 / 免费放弃）
  const rookies = game.phase === 'preseason' ? safe(() => draftedRookiesOf(game, me).length, 0) : 0;
  const windowOpen = safe(() => isTransferWindowOpen(game), game.phase === 'preseason' || game.phase === 'regular');

  const wage = safe(() => roundWageBill(game, me), 0);
  // 回合结算时先入账赞助 / 直播 / 周边，再付工资（economy.payRoundSalaries）
  const income = safe(() => roundRevenue(game, team).total, 0);
  const roster = safe(() => teamPlayers(game, me), []);
  const lineupErrors = safe(() => validateLineup(game, me, tour && tour.status !== 'finished' ? tour.id : null), [] as string[]);
  const coach = safe(() => getCoach(game, me), null);
  const tiInfo = safe(() => getTiInfo(ti), null);

  const roundName = game.roundIndex === 0 ? '赛季初' : game.roundIndex <= R ? `常规赛 第 ${game.roundIndex}/${R} 回合` : ROUND_KIND_TEXT[round.phase] ?? '';
  const roundsToTi = Math.max(0, totalRounds - 1 - game.roundIndex);

  // ---------------- 本回合指引 ----------------
  const kindStyle = KIND_STYLE[kind] ?? KIND_STYLE.rest;
  const myTours = playerSeasonTournaments(game);
  const nextTour = myTours.find((t) => t.roundIndex > game.roundIndex && t.status !== 'finished');
  // 本回合玩家赛事（含已结束的；currentPlayerTournament 只返回未结束的）
  const roundTour = tour ?? myTours.find((t) => t.roundIndex === game.roundIndex && t.playerStatus !== 'declined') ?? null;
  // 内嵌赛事卡片显示的赛事（与卡片、底栏「赛事面板」入口同一判定）；为 null 时不显示卡片
  const panelTour = safe(() => roundTournamentOf(game), null as Tournament | null);
  // 可训练的回合（休赛 / TI 观赛）常驻训练卡片；其他回合只在本回合被请求打开时显示（说明本回合为何不能训练），
  // 避免上个休赛回合展开的训练卡片在赛事回合里占位
  // 多人：本座位已出局（战队解散）只能观战——不显示训练卡片（训练会被服务器拒绝），指引改为观战说明
  const spectating = safe(() => seatSpectating(game), false);
  const trainRound = kind === 'rest' || kind === 'ti_watch';
  const showTraining = !spectating && (trainRound || (trainingOpen && trainingFocusRound === roundKey));

  const marketBtn = (
    <Button onClick={() => setView('market')} disabled={!windowOpen} title={windowOpen ? '转会 / 转会市场' : '转会窗口已锁定（TI 阶段）'}>
      ⇄ 转会市场
    </Button>
  );

  let guideTitle = '';
  let guideText: ReactNode = null;
  let ctas: ReactNode = null;
  if (spectating) {
    guideTitle = '观战中 · 战队已解散';
    guideText = <>你的战队已解散，当前为观战模式：其余玩家继续比赛，你可以浏览各页面关注赛况与积分榜。</>;
    ctas = (
      <Button variant="ghost" onClick={() => setView('tournament')} title="赛事 / 赛事中心：完整分组、对阵图与名次">
        赛事中心 ›
      </Button>
    );
  } else if (kind === 'preseason') {
    guideTitle = '赛季初 · 备战期';
    guideText = (
      <>
        确认<b className="text-ink">赛事报名</b>（受邀赛事已自动报名），补强阵容；新秀选秀已自动完成，<b className="text-ink">选中的新秀只能在赛季初免费放弃</b>。准备好后点击底部「开始赛季 ▶」。
      </>
    );
    ctas = (
      <>
        <Button variant="primary" onClick={() => setView('schedule')} title="赛事 / 赛程报名">
          ▤ 赛程报名
        </Button>
        <Button variant={rookies ? 'gold' : 'secondary'} onClick={() => setView('draft')} title="转会 / 新秀选秀：本届选秀结果与我的新秀">
          ✧ 新秀选秀{rookies ? `（${rookies}）` : ''}
        </Button>
        {marketBtn}
      </>
    );
  } else if ((kind === 'tournament' || kind === 'ti' || kind === 'ti_qualifier') && roundTour) {
    const t = roundTour;
    const finished = t.status === 'finished';
    const s = t.settlement;
    guideTitle = finished ? `本回合赛事已结束 · ${t.name}` : `${kind === 'ti' ? 'TI 正赛' : kind === 'ti_qualifier' ? 'TI 预选赛' : '赛事回合'} · ${t.name}`;
    guideText = finished ? (
      <>
        你获得 <b className="text-gold">{s ? formatRank(s.rankFrom, s.rankTo) : '—'}</b>
        {s ? (
          <>
            ，奖金 <Gold value={s.prize} />，荣誉 <Delta value={s.honor?.total ?? 0} />
          </>
        ) : null}
        。可以推进到下一回合了。
      </>
    ) : (
      <>
        <TourTierBadge tier={t.tier} /> {t.online ? '线上赛' : t.city}
        {t.expectedRank ? (
          <>
            {' '}
            · 赛前预期 <b className="text-ink">第 {t.expectedRank} 名左右</b>（不达预期扣荣誉）
          </>
        ) : null}
        。底部操作栏可一键快速模拟{panelTour ? '；下方赛事卡片可查看对手、阵容检查与本阶段战况' : ''}，想亲自 BP 可「进入比赛」。
      </>
    );
    ctas = (
      <>
        {game.activeMatch && !panelTour ? (
          <Button variant="gold" onClick={() => setView('match')}>
            ⚔ 继续比赛
          </Button>
        ) : null}
        {!finished && <Button onClick={() => setView('squad')}>☰ 调整阵容</Button>}
        {/* 赛事回合不能训练（trainingBlockReason）：赛事结束后的下一步是运营或推进回合 */}
        {finished && marketBtn}
        <Button variant="ghost" onClick={() => setView('tournament')} title="赛事 / 赛事中心：完整分组、对阵图与名次">
          {finished ? '查看赛果 ›' : '赛事中心 ›'}
        </Button>
      </>
    );
  } else if (kind === 'ti_watch') {
    guideTitle = `TI${ti} 观赛`;
    guideText = <>本届 TI 你未能入围。可以关注各队对决，同时为下赛季做规划；观赛回合同样可以训练（见下方训练卡片）。</>;
    ctas = (
      <>
        <Button variant="primary" onClick={() => setView('tournament')}>
          ♜ 观看 TI
        </Button>
        {marketBtn}
      </>
    );
  } else {
    guideTitle = game.phase === 'ti_qualifier' ? 'TI 预选期 · 休赛（已获直邀或无需参赛）' : game.phase === 'ti' ? 'TI 期间 · 休赛' : '休赛回合 · 训练与运营';
    guideText = (
      <>
        剩余训练 <b className={cx(sessions > 0 ? 'text-good' : 'text-mute')}>{sessions}</b> 次，未用完的训练（含已购的额外训练）会在回合结束时按当前焦点自动完成；
        想调整焦点、加练或约训练赛，展开下方训练卡片。
        {!windowOpen ? <span className="text-bad"> 转会窗口已锁定（TI 阶段）。</span> : null}
      </>
    );
    ctas = (
      <>
        <Button onClick={() => setView('squad')} title="战队 / 阵容：首发、谈心、加薪、团建">
          ☰ 阵容
        </Button>
        {marketBtn}
      </>
    );
  }

  // ---------------- 待处理 ----------------
  const decisions = game.pendingDecisions ?? [];
  const blockingDecisions = decisions.filter((d) => d.blocking).length;
  const offers = (game.transferOffers ?? []).filter((o) => o.status === 'pending' && o.toTeamId === me);
  const expiring = roster.filter((p) => !p.tempSubUntilTournament && p.contractUntil <= ti);
  const lowLoyal = roster.filter((p) => p.loyalty < CONFIG.loyalty.leaveThreshold);
  const fundsShort = wage > 0 && team.gold + income < wage;
  const rosterCount = roster.filter((p) => !p.tempSubUntilTournament).length;
  // 超出常规上限只是提醒（不阻塞推进）：工资照付、替补归属感下降更快
  const overflowNote = safe<string | null>(() => rosterOverflowNotice(game, me), null);

  // ---------------- 接下来 ----------------
  const patchesNow = round.patchVersions ?? [];
  const nextPatchRound = rounds.find((r) => r.index > game.roundIndex && (r.patchVersions?.length ?? 0) > 0);

  return (
    <div ref={rootRef}>
      <PageHeader
        title="总览"
        actions={
          <span className="rounded-md border border-gold/30 bg-gold/10 px-2.5 py-1 text-xs text-gold" title="生涯目标">
            目标：TI{game.settings.endTi} 前夺得 TI 冠军 · 剩余 {Math.max(0, game.settings.endTi - ti + 1)} 个赛季
          </span>
        }
      />

      <NewsTicker />

      {/* ======================= 通知（有回合通知时：最新在前，点击在原处展开；不阻塞推进） ======================= */}
      <NoticesCard className="mb-4" />

      {/* ======================= 本回合（独占一行，内嵌赛事 / 训练卡片） ======================= */}
      <Card
        className="mb-4"
        title="本回合"
        subtitle={`${roundName} · ${round.startDate}${round.endDate && round.endDate !== round.startDate ? ` ~ ${round.endDate}` : ''}`}
        actions={<span className={cx('rounded border px-2 py-0.5 text-xs font-semibold', kindStyle.chip)}>{ROUND_KIND_TEXT[kind] ?? kind}</span>}
      >
        {/* 赛季时间轴 */}
        {totalRounds > 0 && (
          <div className="mb-4">
            <div className="flex gap-[3px]">
              {rounds.map((r) => {
                const k = safe<Kind>(() => roundKindForPlayer(game, r.index), r.index === 0 ? 'preseason' : 'rest');
                const cur = r.index === game.roundIndex;
                const past = r.index < game.roundIndex;
                const tNames = (r.tournamentIds ?? []).map((id) => game.tournaments[id]?.name).filter(Boolean).join('、');
                const hasPatch = (r.patchVersions?.length ?? 0) > 0;
                return (
                  <div
                    key={r.index}
                    className="relative flex-1"
                    title={`${roundLabel(game, ti, r.index)} · ${r.startDate} · ${ROUND_KIND_TEXT[k] ?? k}${tNames ? `\n赛事：${tNames}` : ''}${hasPatch ? `\n版本更新：${r.patchVersions.join('、')}` : ''}`}
                  >
                    <div
                      className={cx(
                        'h-2.5 rounded-sm transition-all',
                        KIND_STYLE[k]?.seg ?? 'bg-panel-3',
                        past && 'opacity-35',
                        cur && 'ring-2 ring-white/80 ring-offset-1 ring-offset-panel',
                      )}
                    />
                    {hasPatch && <span className="absolute -top-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-tier-s" />}
                  </div>
                );
              })}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
              <span className="flex flex-wrap gap-3">
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-gold/80" />赛事</span>
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-panel-3" />休赛</span>
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-dota-2" />TI</span>
                <span><i className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-tier-s" />版本更新</span>
              </span>
              <span>{roundsToTi > 0 ? `距 TI 正赛还有 ${roundsToTi} 个回合` : '本回合为 TI 正赛'}</span>
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">
            <div className={cx('text-lg font-bold', kindStyle.text)}>{guideTitle}</div>
            <p className="mt-1 text-sm leading-relaxed text-mute">{guideText}</p>
            <div className="mt-3 flex flex-wrap gap-2">{ctas}</div>
          </div>

          {/* 接下来：下一项赛事 + 版本更新 */}
          <div className="rounded-lg border border-line bg-panel-2/50 p-3 text-xs">
            <MiniTitle
              right={
                <button className="cursor-pointer text-[11px] text-gold hover:underline" onClick={() => setView('schedule')}>
                  赛程 ›
                </button>
              }
            >
              接下来
            </MiniTitle>
            {nextTour ? (
              <div className="flex items-center gap-2">
                <TourTierBadge tier={nextTour.tier} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink" title={nextTour.name}>
                    {nextTour.name}
                  </span>
                  <span className="block text-[11px] text-faint">
                    {roundLabel(game, ti, nextTour.roundIndex)} · {nextTour.startDate}
                  </span>
                </span>
                <span className={cx('shrink-0', nextTour.playerStatus === 'invited' ? 'text-gold' : 'text-mute')}>
                  {ENTRY_LABEL[nextTour.playerStatus] ?? nextTour.playerStatus}
                </span>
              </div>
            ) : (
              <div className="text-faint">
                本赛季没有更多已报名的赛事
                {tiInfo && kind !== 'ti' ? `；TI${ti} 积分前 ${tiInfo.directInvites || '若干'} 名直邀` : ''}
              </div>
            )}
            <div className="mt-2 border-t border-line/60 pt-2 text-mute">
              {patchesNow.length > 0 ? (
                <>
                  本回合版本更新：
                  {patchesNow.map((v) => (
                    <button key={v} onClick={() => setView('patches')} className="ml-1 cursor-pointer rounded bg-tier-s/20 px-1.5 py-0.5 font-semibold text-[#c9a6ff] hover:bg-tier-s/30">
                      {v}
                    </button>
                  ))}
                </>
              ) : nextPatchRound ? (
                <>
                  下次版本更新：<span className="text-ink">{roundLabel(game, ti, nextPatchRound.index)}</span>
                  <span className="ml-1 font-semibold text-[#c9a6ff]">{nextPatchRound.patchVersions.join('、')}</span>
                </>
              ) : (
                <span className="text-faint">当前版本 {game.currentPatch || '—'}，本赛季暂无后续更新</span>
              )}
            </div>
          </div>
        </div>

        {/* 内嵌卡片：赛事回合的赛事卡片（回合开始时自动展开）/ 可训练回合的训练卡片，均在原处展开 / 收起 */}
        {(panelTour || showTraining) && (
          <div className="mt-4 space-y-3">
            {panelTour && <TournamentCard />}
            {showTraining && <TrainingCard />}
          </div>
        )}
      </Card>

      {/* ======================= 待处理（红点提醒，点击展开） ======================= */}
      {(() => {
        const urgent =
          decisions.length + offers.length + (lineupErrors.length ? 1 : 0) + (fundsShort ? 1 : 0) +
          (team.honor < 50 ? 1 : 0) + (rosterCount < 5 ? 1 : 0);
        const info = (rookies ? 1 : 0) + (overflowNote ? 1 : 0) + (expiring.length ? 1 : 0) + (lowLoyal.length ? 1 : 0) + (!coach ? 1 : 0);
        const total = urgent + info;
        return (
          <section className={cx('mb-4 overflow-hidden rounded-xl border bg-panel/90', urgent ? 'border-bad/40' : 'border-line')}>
            <button onClick={() => setTodoOpen((o) => !o)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-panel-2/50">
              <span className="relative text-sm font-semibold">
                待处理
                {total > 0 && <span className={cx('absolute -right-2.5 -top-1 h-2.5 w-2.5 rounded-full', urgent ? 'animate-pulse bg-bad' : 'bg-gold')} />}
              </span>
              <span className="ml-2 text-xs text-mute">
                {total === 0 ? '✓ 一切就绪，没有待办事项' : urgent ? `${urgent} 项需要尽快处理${info ? `，另有 ${info} 项提醒` : ''}` : `${info} 项提醒`}
              </span>
              <span className="ml-auto text-xs text-faint">{todoOpen ? '收起 ▴' : '展开 ▾'}</span>
            </button>
            {todoOpen && (
              <div className="grid gap-x-4 border-t border-line px-2 py-2 md:grid-cols-2">
                {decisions.length > 0 && (
                  <TodoRow icon="!" tone="bg-dota text-white" count={decisions.length} onClick={() => setView('inbox')}>
                    待决策事件{blockingDecisions ? <span className="ml-1 text-xs text-bad">（{blockingDecisions} 个阻塞推进）</span> : null}
                  </TodoRow>
                )}
                {offers.length > 0 && (
                  <TodoRow icon="⇄" tone="bg-gold/20 text-gold" count={offers.length} onClick={() => setView('market')}>
                    收到转会报价
                    <span className="ml-1 text-xs text-mute">
                      {offers
                        .slice(0, 2)
                        .map((o) => `${game.players[o.playerId]?.handle ?? '?'} ← ${game.teams[o.fromTeamId]?.tag ?? '?'} ${formatGold(o.fee)}`)
                        .join('；')}
                    </span>
                  </TodoRow>
                )}
                {lineupErrors.length > 0 && (
                  <TodoRow icon="☰" tone="bg-bad/20 text-bad" count={lineupErrors.length} onClick={() => setView('squad')} title={lineupErrors.join('\n')}>
                    首发阵容有问题
                  </TodoRow>
                )}
                {fundsShort && (
                  <TodoRow icon="¥" tone="bg-bad/20 text-bad" onClick={() => setView('finance')}>
                    资金不足以支付本回合结束时的工资（工资 <Gold value={wage} />，预计收入 <Gold value={income} />），将触发欠薪
                  </TodoRow>
                )}
                {team.honor < 50 && (
                  <TodoRow icon="♛" tone="bg-bad/20 text-bad" onClick={() => setView('club')}>
                    荣誉告急（{Math.round(team.honor)}），跌破 0 战队解散
                  </TodoRow>
                )}
                {rookies > 0 && (
                  <TodoRow icon="✧" tone="bg-gold/20 text-gold" count={rookies} onClick={() => setView('draft')}>
                    本届选秀选中的新秀：赛季初可保留或免费放弃
                  </TodoRow>
                )}
                {overflowNote && (
                  <TodoRow
                    icon="☰"
                    tone="bg-gold/20 text-gold"
                    onClick={() => setView('squad')}
                    title={`常规上限 ${CONFIG.team.maxRoster} 人只是建议：超出不影响推进，可在阵容页安排首发与替补；签约 / 求购的绝对上限 ${CONFIG.team.hardMaxRoster} 人`}
                  >
                    {overflowNote}
                  </TodoRow>
                )}
                {expiring.length > 0 && (
                  <TodoRow icon="✎" tone="bg-tier-ss/20 text-tier-ss" count={expiring.length} onClick={() => setView('squad')} title={expiring.map((p) => p.handle).join('、')}>
                    合同将于本届 TI 后到期
                  </TodoRow>
                )}
                {lowLoyal.length > 0 && (
                  <TodoRow icon="♥" tone="bg-bad/15 text-bad" count={lowLoyal.length} onClick={() => setView('squad')} title={lowLoyal.map((p) => `${p.handle}（归属感 ${Math.round(p.loyalty)}）`).join('\n')}>
                    归属感过低，可能申请离队：{lowLoyal.slice(0, 2).map((p) => p.handle).join('、')}
                  </TodoRow>
                )}
                {rosterCount < 5 && (
                  <TodoRow icon="+" tone="bg-bad/20 text-bad" onClick={() => setView('market')}>
                    阵容不足 5 人（{rosterCount}/{CONFIG.team.maxRoster}），请招募选手
                  </TodoRow>
                )}
                {!coach && (
                  <TodoRow icon="✦" tone="bg-panel-3 text-mute" onClick={() => setView('coach')}>
                    教练岗位空缺
                  </TodoRow>
                )}
              </div>
            )}
          </section>
        );
      })()}

      {/* ======================= 回合要闻 + 世界动态 | 俱乐部概况 + 积分榜 ======================= */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {/* 回合要闻（推进回合后出现，可关闭） */}
          <RoundDigest />
          <WorldFeed limit={8} className="min-w-0" />
        </div>
        <div className="space-y-4">
          <ClubCard game={game} team={team} wage={wage} />
          <StandingsCard game={game} me={me} directInvites={tiInfo?.directInvites ?? 0} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 俱乐部概况：评分 / 实力排名 / 荣誉 / 金币 + 每回合收支（赞助、直播、周边 − 工资）
// ---------------------------------------------------------------------------
function ClubCard({ game, team, wage }: { game: GameState; team: Team; wage: number }) {
  const setView = useGameStore((s) => s.setView);
  const me = team.id;
  const ti = game.season?.ti ?? 0;
  const rating = safe(() => teamRating(game, me), 0);
  const ranking = safe(() => rankTeamsByRating(game), [] as string[]);
  const rank = ranking.indexOf(me) + 1;
  const rev = safe(() => roundRevenue(game, team), null as RoundRevenue | null);
  const income = rev?.total ?? 0;
  const net = income - wage;
  const runway = net < 0 && team.gold > 0 ? Math.floor(team.gold / -net) : null;
  const honorStart = game.season?.honorStart;
  // 上回合实际收支（全部来源：工资、奖金、训练、转会……），赛季初不显示
  const lastRound = game.roundIndex - 1;
  const lastNet =
    lastRound >= 1 ? (game.finance ?? []).filter((f) => f.season === ti && f.round === lastRound).reduce((s, f) => s + (Number.isFinite(f.amount) ? f.amount : 0), 0) : null;

  const tile = 'rounded-md border border-line bg-panel-2/60 px-2.5 py-1.5 text-left';
  return (
    <Card
      title="俱乐部"
      actions={
        <Button size="xs" variant="ghost" onClick={() => setView('finance')}>
          财务 ›
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <button className={cx(tile, 'cursor-pointer hover:border-gold/40')} onClick={() => setView('squad')} title="战队评分（首发五人 + 教练）">
          <div className="text-[10px] text-faint">战队评分</div>
          <div className="text-base font-bold tabular">{rating.toFixed(0)}</div>
        </button>
        <button className={cx(tile, 'cursor-pointer hover:border-gold/40')} onClick={() => setView('rankings')} title="按战队评分的世界排名">
          <div className="text-[10px] text-faint">实力排名</div>
          <div className="text-base font-bold tabular">
            {rank > 0 ? `#${rank}` : '—'}
            <span className="ml-0.5 text-[10px] font-normal text-faint">/{ranking.length || activeTeams(game).length}</span>
          </div>
        </button>
        <button className={cx(tile, 'cursor-pointer hover:border-gold/40')} onClick={() => setView('club')} title="荣誉低于 0 战队解散">
          <div className="text-[10px] text-faint">荣誉</div>
          <div className={cx('text-base font-bold tabular', team.honor < 50 ? 'text-bad' : 'text-ink')}>
            {Math.round(team.honor)}
            {honorStart !== undefined && Number.isFinite(honorStart) && (
              <span className="ml-1 text-[11px] font-normal">
                <Delta value={Math.round(team.honor - honorStart)} />
              </span>
            )}
          </div>
        </button>
        <button className={cx(tile, 'cursor-pointer hover:border-gold/40')} onClick={() => setView('finance')}>
          <div className="text-[10px] text-faint">金币</div>
          <div className="text-base font-bold">
            <Gold value={team.gold} />
          </div>
        </button>
      </div>

      <div className="mt-3 rounded-md border border-line/70 px-2.5 py-2 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-mute">每回合收支</span>
          <span className={cx('font-bold tabular', net >= 0 ? 'text-good' : 'text-bad')}>
            {net >= 0 ? '+' : '−'}
            {formatGold(Math.abs(net))}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-faint">
          <span
            title={rev ? `赞助 ${formatGold(rev.sponsor)} · 直播与内容 ${formatGold(rev.streaming)} · 周边 ${formatGold(rev.merch)}${rev.merchBoost > 0 ? `（含赛事热度 ${formatGold(rev.merchBoost)}）` : ''}` : undefined}
          >
            收入 <span className="text-good tabular">{formatGold(income)}</span>
            {rev && (
              <span className="ml-1">
                （赞助 {formatGold(rev.sponsor)} · 直播 {formatGold(rev.streaming)} · 周边 {formatGold(rev.merch)}）
              </span>
            )}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[11px] text-faint">
          <span>
            工资 <span className="tabular text-bad">{formatGold(wage)}</span>
          </span>
          {runway !== null ? (
            <span className={cx(runway < 3 ? 'text-bad' : 'text-mute')}>按此可支撑约 {runway} 回合</span>
          ) : lastNet !== null ? (
            <span title="上回合全部收支（含奖金、训练、转会等）">
              上回合实际 <span className={cx('tabular', lastNet >= 0 ? 'text-good' : 'text-bad')}>{lastNet >= 0 ? '+' : '−'}{formatGold(Math.abs(lastNet))}</span>
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 积分榜（精简）：前若干名 + 我的位置
// ---------------------------------------------------------------------------
function StandingsCard({ game, me, directInvites }: { game: GameState; me: string; directInvites: number }) {
  const setView = useGameStore((s) => s.setView);
  const ti = game.season?.ti ?? 0;
  const standings = safe(
    () => seasonStandings(game),
    activeTeams(game)
      .slice()
      .sort((a, b) => b.points - a.points || b.honor - a.honor),
  );
  const top = standings.slice(0, STANDINGS_TOP);
  const myIdx = standings.findIndex((t) => t.id === me);
  const mine = myIdx >= 0 ? standings[myIdx] : null;
  const cutTeam = directInvites > 0 ? standings[directInvites - 1] : undefined;
  const gap = mine && cutTeam && myIdx >= directInvites ? Math.max(0, Math.round((cutTeam.points || 0) - (mine.points || 0))) : null;
  // 赛季初尚无积分时名次只是荣誉排序，不提示直邀区
  const anyPoints = standings.some((t) => (t.points || 0) > 0);

  return (
    <Card
      title="赛季积分榜"
      subtitle={directInvites ? `前 ${directInvites} 名直邀 TI${ti}` : '巡回赛积分'}
      bodyClassName="p-0"
      actions={
        <Button size="xs" variant="ghost" onClick={() => setView('rankings')}>
          排名 ›
        </Button>
      }
    >
      {standings.length === 0 ? (
        <EmptyState text="积分榜暂无数据" />
      ) : (
        <>
          <table className="tbl">
            <tbody>
              {top.map((t, i) => (
                <StandRow key={t.id} rank={i + 1} t={t} isMe={t.id === me} />
              ))}
              {myIdx >= top.length && mine && (
                <>
                  <tr>
                    <td colSpan={3} className="py-0.5 text-center text-[10px] text-faint">
                      ⋯
                    </td>
                  </tr>
                  <StandRow rank={myIdx + 1} t={mine} isMe />
                </>
              )}
            </tbody>
          </table>
          {mine && directInvites > 0 && (
            <div className="border-t border-line px-4 py-2 text-[11px] text-mute">
              {!anyPoints ? (
                <span>本赛季尚未产生积分，排名按荣誉暂列</span>
              ) : myIdx < directInvites ? (
                <span className="text-good">当前处于直邀区（第 {myIdx + 1} 名）</span>
              ) : (
                <span>
                  距直邀线（第 {directInvites} 名）还差 <b className="tabular text-ink">{gap ?? '—'}</b> 分；否则需打赛区预选
                </span>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function StandRow({ rank, t, isMe }: { rank: number; t: Team; isMe: boolean }) {
  return (
    <tr className={cx(isMe && 'bg-dota/15')}>
      <td className={cx('w-8 tabular', rank <= 3 ? 'font-bold text-gold' : 'text-mute')}>{rank}</td>
      <td>
        <div className="flex max-w-[220px] items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: t.color }} />
          <TeamLink teamId={t.id} name={t.name} className={cx('min-w-0 truncate text-left', isMe && 'font-semibold text-gold')} />
          {isMe && <span className="shrink-0 text-[10px] text-gold">（你）</span>}
        </div>
      </td>
      <td className="num font-semibold">{Math.round(t.points || 0)}</td>
    </tr>
  );
}
