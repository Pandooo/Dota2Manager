// ============================================================================
// 比赛页 · 系列赛结算（系列赛结束、activeMatch 清空后展示）
// 手机（< sm）：头部收紧、按钮撑满一行；各局回顾由 7 列表格改为每局一张小卡片（胜负 · 击杀 · 时长 · 胜率 / 阵容 · MVP）。
// ============================================================================
import type { GameRecord, GameState } from '../../engine/types';
import { TOURNAMENT_TIER_LABEL, isTeamEliminated, playerNextSeries } from '../../engine';
import { Badge, Button, Card, EmptyState, TeamTag, cx } from './common';
import { HeroAvatar, heroCn } from './MatchHero';
import { MineBadge, fmtDuration, gameWinnerId, pct, safe, seriesScore, teamOrStub } from './MatchShared';
import { useIsPhone } from '../mobile';

export default function MatchSeriesSummary({
  game,
  tournamentId,
  seriesId,
  snapshot,
  onBack,
  onDetails,
  onNext,
}: {
  game: GameState;
  tournamentId: string;
  seriesId: string;
  /** 提交前记录的本系列赛各局（系列赛结果缺失时兜底） */
  snapshot: GameRecord[];
  /** 返回总览 */
  onBack: () => void;
  /** 查看赛事详情（赛事中心），可选 */
  onDetails?: () => void;
  onNext: () => void;
}) {
  const phone = useIsPhone();
  const myId = game.settings.playerTeamId;
  const t = game.tournaments[tournamentId];
  const s = t?.series?.[seriesId];
  if (!t || !s) {
    return (
      <Card>
        <EmptyState text="系列赛已结束，但赛事数据已不可用">
          <Button variant="primary" onClick={onBack}>
            返回总览
          </Button>
        </EmptyState>
      </Card>
    );
  }
  const teamA = teamOrStub(game, s.teamA);
  const teamB = teamOrStub(game, s.teamB);
  const games = s.result?.games?.length ? s.result.games : snapshot;
  const sc = s.result ? { a: s.result.scoreA, b: s.result.scoreB } : seriesScore(games, s.teamA);
  const mySide = s.teamA === myId ? 'A' : 'B';
  const myScore = mySide === 'A' ? sc.a : sc.b;
  const oppScore = mySide === 'A' ? sc.b : sc.a;
  const outcome: 'win' | 'lose' | 'draw' = myScore === oppScore ? 'draw' : myScore > oppScore ? 'win' : 'lose';
  const eliminated = safe(() => isTeamEliminated(game, tournamentId, myId), false);
  const finished = t.status === 'finished';
  const next = finished ? null : safe(() => playerNextSeries(game, tournamentId), null);
  const nextOpp = next ? teamOrStub(game, next.teamA === myId ? next.teamB : next.teamA) : null;

  const headline = outcome === 'win' ? '系列赛胜利' : outcome === 'lose' ? '系列赛失利' : '系列赛战平';
  const tone = outcome === 'win' ? 'text-gold' : outcome === 'lose' ? 'text-bad' : 'text-info';

  return (
    <div className="space-y-4">
      <section
        className={cx(
          'fade-up overflow-hidden rounded-xl border p-4 shadow-xl shadow-black/30 sm:p-6',
          outcome === 'win'
            ? 'border-gold/60 bg-gradient-to-br from-gold/20 via-panel to-panel'
            : outcome === 'lose'
              ? 'border-bad/50 bg-gradient-to-br from-bad/20 via-panel to-panel'
              : 'border-info/50 bg-gradient-to-br from-info/15 via-panel to-panel',
        )}
      >
        {/* 手机：字距收窄（宽字距下长赛事名会把「第 1 轮」拆到两行） */}
        <div className="text-[11px] tracking-[0.3em] text-faint max-sm:tracking-[0.08em]">
          {t.name} · {TOURNAMENT_TIER_LABEL[t.tier] ?? t.tier} · {s.label} · Bo{s.bestOf}
        </div>
        <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6">
          <div className="min-w-0 text-right">
            <div className="flex items-center justify-end gap-1.5">
              {mySide === 'A' && <MineBadge />}
              <TeamTag color={teamA.color} tag={teamA.tag} />
            </div>
            <div className="truncate text-base font-bold sm:text-lg">{teamA.name}</div>
          </div>
          <div className="text-center">
            <div className={cx('pop-in whitespace-nowrap text-4xl font-black tabular sm:text-5xl', tone)}>
              {sc.a} : {sc.b}
            </div>
            <div className={cx('mt-1 whitespace-nowrap text-base font-bold tracking-widest sm:text-lg', tone)}>{headline}</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <TeamTag color={teamB.color} tag={teamB.tag} />
              {mySide === 'B' && <MineBadge />}
            </div>
            <div className="truncate text-base font-bold sm:text-lg">{teamB.name}</div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm">
          {finished ? (
            <Badge className="bg-gold/20 text-gold">赛事已结束 · 结算详情见弹窗与赛事中心</Badge>
          ) : eliminated ? (
            <Badge className="bg-bad/20 text-bad">已被淘汰 · 剩余比赛将自动模拟</Badge>
          ) : next && nextOpp ? (
            <Badge className="bg-good/15 text-good">
              下一场：{next.label} · vs {nextOpp.tag} · Bo{next.bestOf}
            </Badge>
          ) : (
            <Badge>等待其他比赛结果</Badge>
          )}
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2 max-sm:[&>*]:grow">
          {next && (
            <Button variant="gold" size="lg" onClick={onNext}>
              进入下一场 ▶
            </Button>
          )}
          <Button variant={next ? 'secondary' : 'primary'} size="lg" onClick={onBack}>
            返回总览
          </Button>
          {onDetails && (
            <Button variant="ghost" size="lg" onClick={onDetails}>
              赛事详情 ›
            </Button>
          )}
        </div>
      </section>

      <Card title="各局回顾" subtitle={`共 ${games.length} 局`} bodyClassName="p-0">
        {games.length === 0 ? (
          <EmptyState text="没有对局记录" />
        ) : phone ? (
          <ul>
            {games.map((g, i) => {
              const win = gameWinnerId(g) === myId;
              const side = g.teamA === myId ? 'A' : 'B';
              const myK = side === 'A' ? g.killsA : g.killsB;
              const opK = side === 'A' ? g.killsB : g.killsA;
              const myProb = side === 'A' ? g.winProbA : 1 - g.winProbA;
              const mvp = g.mvpPlayerId ? game.players[g.mvpPlayerId] : undefined;
              const picks = (g.draft ?? []).filter((a) => a.type === 'pick' && a.side === side);
              return (
                <li key={i} className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-mute">第 {i + 1} 局</span>
                    <span className={cx('font-bold', win ? 'text-good' : 'text-bad')}>{win ? '胜' : '负'}</span>
                    <span className="tabular">
                      击杀 {myK}:{opK}
                    </span>
                    <span className="tabular text-faint">{fmtDuration(g.durationMin)}</span>
                    <span className={cx('ml-auto text-xs tabular', myProb >= 0.5 ? 'text-good' : 'text-bad')}>
                      胜率 {Number.isFinite(myProb) ? pct(myProb) : '—'}
                    </span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs">
                    <span className="flex items-center gap-0.5">
                      {picks.map((a, j) => (
                        <HeroAvatar key={j} heroId={a.heroId} size="sm" title={heroCn(a.heroId)} tip />
                      ))}
                      {picks.length === 0 && <span className="text-faint">—</span>}
                    </span>
                    <span className="ml-auto min-w-0 truncate text-faint">
                      MVP {mvp ? <span className="font-semibold text-gold">{mvp.handle}</span> : '—'}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>局</th>
                  <th>胜者</th>
                  <th className="num">击杀</th>
                  <th className="num">时长</th>
                  <th className="num">我方胜率</th>
                  <th>我方阵容</th>
                  <th>MVP</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g, i) => {
                  const winId = gameWinnerId(g);
                  const win = winId === myId;
                  const winner = teamOrStub(game, winId);
                  const side = g.teamA === myId ? 'A' : 'B';
                  const myK = side === 'A' ? g.killsA : g.killsB;
                  const opK = side === 'A' ? g.killsB : g.killsA;
                  const myProb = side === 'A' ? g.winProbA : 1 - g.winProbA;
                  const mvp = g.mvpPlayerId ? game.players[g.mvpPlayerId] : undefined;
                  const picks = (g.draft ?? []).filter((a) => a.type === 'pick' && a.side === side);
                  return (
                    <tr key={i}>
                      <td className="text-mute">第 {i + 1} 局</td>
                      <td>
                        <span className="flex items-center gap-1.5">
                          <TeamTag color={winner.color} tag={winner.tag} />
                          <span className={cx('text-xs font-bold', win ? 'text-good' : 'text-bad')}>{win ? '胜' : '负'}</span>
                        </span>
                      </td>
                      <td className="num">
                        {myK}:{opK}
                      </td>
                      <td className="num">{fmtDuration(g.durationMin)}</td>
                      <td className={cx('num', myProb >= 0.5 ? 'text-good' : 'text-bad')}>{Number.isFinite(myProb) ? pct(myProb) : '—'}</td>
                      <td>
                        <span className="flex items-center gap-0.5">
                          {picks.map((a, j) => (
                            <HeroAvatar key={j} heroId={a.heroId} size="xs" title={heroCn(a.heroId)} tip />
                          ))}
                          {picks.length === 0 && <span className="text-faint">—</span>}
                        </span>
                      </td>
                      <td>{mvp ? <span className="font-semibold text-gold">{mvp.handle}</span> : <span className="text-faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
