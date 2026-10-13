// ============================================================================
// 比赛页 · 赛前准备：双方首发、战队评分/灵性/教练、宿敌提醒、本局阵营
// 开始 BP / 快速模拟等「下一步」按钮在底部吸附操作栏（MatchDock）。
// ============================================================================
import type { GameRecord, GameState, Series, Team, Tournament } from '../../engine/types';
import {
  REGION_LABEL, effectivePower, getCoach, isAvailable, lineupPlayers, playerRating, playerTier, teamInsight, teamRating,
  ROLE_FIT_LABEL, roleFit, roleFitFactor,
} from '../../engine';
import type { RoleFit } from '../../engine';
import { Badge, Button, Card, Hint, PlayerLink, PosBadge, TeamLink, TeamTag, TierBadge, cx } from './common';
import { HeroAvatar, heroCn } from './MatchHero';
import { CompareRow, FACTION_LABEL, FACTION_TEXT, MineBadge, fmtDuration, gameWinnerId, pct, safe, strengthShare, type Faction, type Side } from './MatchShared';

export default function MatchPre({
  game,
  tournament,
  series,
  teams,
  mySide,
  myFaction,
  games,
  gameNo,
  lineupErrors,
  onAutoLineup,
  onFillSubs,
  onGoSquad,
}: {
  game: GameState;
  tournament: Tournament;
  series: Series;
  teams: { A: Team; B: Team };
  mySide: Side;
  /** 本局我方阵营（按引擎约定预测） */
  myFaction: Faction | null;
  games: GameRecord[];
  gameNo: number;
  /** 我方首发校验错误（空 = 合法） */
  lineupErrors: string[];
  onAutoLineup: () => void;
  /** 自动排阵后仍缺人时，从野外招募临时替补补齐 */
  onFillSubs: () => void;
  onGoSquad: () => void;
}) {
  const myTeam = teams[mySide];
  const oppTeam = teams[mySide === 'A' ? 'B' : 'A'];
  const rA = safe(() => teamRating(game, teams.A.id), 0);
  const rB = safe(() => teamRating(game, teams.B.id), 0);
  const iA = safe(() => teamInsight(game, teams.A.id), 0);
  const iB = safe(() => teamInsight(game, teams.B.id), 0);
  const shareA = strengthShare(rA, rB);
  const myShare = mySide === 'A' ? shareA : 1 - shareA;
  const errors = lineupErrors;
  const beef = game.beefs?.find((b) => b.teamId === oppTeam.id && b.season === game.season.ti);
  const blocked = errors.length > 0;
  const colorA = mySide === 'A' ? 'bg-good' : 'bg-bad/80';
  const colorB = mySide === 'B' ? 'bg-good' : 'bg-bad/80';

  return (
    <div className="space-y-4">
      <Card
        title={`赛前准备 · 第 ${gameNo} 局`}
        subtitle={`${series.label} · Bo${series.bestOf} · 在底部选择 BP 方式开始本局`}
        bodyClassName="p-4"
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-4">
            <div className="grid items-end gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
              <div>
                <div className="text-[11px] text-faint">纸面实力胜率（我方）</div>
                <div className={cx('text-4xl font-black tabular', myShare >= 0.5 ? 'text-good' : 'text-bad')}>{pct(myShare)}</div>
                <div className="text-[11px] text-faint">BP 与局内表现仍会左右胜负</div>
              </div>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="flex items-center gap-1.5">
                    <TeamTag color={teams.A.color} tag={teams.A.tag} />
                    {mySide === 'A' && <MineBadge />}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {mySide === 'B' && <MineBadge />}
                    <TeamTag color={teams.B.color} tag={teams.B.tag} />
                  </span>
                </div>
                <CompareRow label="战队评分" a={rA} b={rB} fmt={(v) => v.toFixed(1)} colorA={colorA} colorB={colorB} hint="首发评分之和 + 教练加成" />
                <CompareRow label="战队灵性" a={iA} b={iB} fmt={(v) => v.toFixed(1)} colorA={colorA} colorB={colorB} hint="影响 BP 质量与大老师胜率" />
                <CompareRow label="俱乐部荣誉" a={teams.A.honor} b={teams.B.honor} fmt={(v) => Math.round(v).toString()} colorA={colorA} colorB={colorB} />
              </div>
            </div>

            {beef && (
              <div className="flex items-start gap-2 rounded-lg border border-dota/50 bg-dota/10 px-3 py-2 text-sm">
                <span className="mt-0.5 rounded bg-dota px-1.5 text-[11px] font-bold text-white">宿敌之战</span>
                <div>
                  本赛季与 <span className="font-semibold">{oppTeam.name}</span> 结下梁子：系列赛获胜荣誉
                  <span className="mx-1 font-semibold text-good tabular">+{Math.round(beef.winHonor)}</span>，失利
                  <span className="mx-1 font-semibold text-bad tabular">{Math.round(beef.loseHonor)}</span>。
                </div>
              </div>
            )}

            {blocked && (
              <div className="rounded-lg border border-bad/50 bg-bad/10 px-3 py-2 text-sm">
                <div className="font-semibold text-bad">首发阵容不合法，暂时无法开始 BP</div>
                <ul className="mt-1 list-inside list-disc text-xs text-[#ffb4b4]">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <div className="mt-1 text-[11px] text-mute">首发不足 5 人时，直接「快速模拟本场」将弃权判负。</div>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="primary" onClick={onAutoLineup}>
                    一键自动排阵
                  </Button>
                  <Button size="sm" onClick={onFillSubs} title="先自动排阵，仍有空位时招募负担得起的野外临时替补（需支付费用）">
                    补齐临时替补
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onGoSquad}>
                    去阵容页调整
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel-2/50 p-3 text-xs">
            <div className="text-[11px] tracking-widest text-faint">本局信息</div>
            <div className="flex items-center justify-between">
              <span className="text-mute">我方阵营</span>
              {myFaction ? <span className={cx('font-semibold', FACTION_TEXT[myFaction])}>{FACTION_LABEL[myFaction]}</span> : <span className="text-faint">—</span>}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-mute">BP 顺序</span>
              <span className="font-semibold">{mySide === 'A' ? '先手（先禁先选）' : '后手'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-mute">系列赛</span>
              <span className="font-semibold tabular">Bo{series.bestOf} · 第 {gameNo} 局</span>
            </div>
            <Hint className="mt-1 leading-relaxed">
              在底部选择<span className="text-gold">「自动 BP · 开始比赛」</span>直接开打，或<span className="text-ink">「手动 BP」</span>亲自操刀（每个我方回合都有推荐，推荐质量受战队灵性影响）。
            </Hint>
          </div>
        </div>
      </Card>

      {games.length > 0 && <SeriesSoFar game={game} games={games} myTeamId={myTeam.id} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <LineupCard game={game} team={teams.A} mine={mySide === 'A'} tournamentId={tournament.id} rating={rA} insight={iA} />
        <LineupCard game={game} team={teams.B} mine={mySide === 'B'} tournamentId={tournament.id} rating={rB} insight={iB} />
      </div>
    </div>
  );
}

function LineupCard({
  game,
  team,
  mine,
  tournamentId,
  rating,
  insight,
}: {
  game: GameState;
  team: Team;
  mine: boolean;
  tournamentId: string;
  rating: number;
  insight: number;
}) {
  const rows = safe(() => lineupPlayers(game, team.id), []);
  const coach = safe(() => getCoach(game, team.id), null);
  return (
    <Card
      className={mine ? 'border-gold/40' : undefined}
      title={
        <span className="flex items-center gap-2">
          <TeamTag color={team.color} tag={team.tag} />
          <TeamLink teamId={team.id} name={team.name} className="text-mute" />
          {mine && <MineBadge />}
        </span>
      }
      subtitle={`${REGION_LABEL[team.region] ?? team.region} · 荣誉 ${Math.round(team.honor)}`}
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>位置</th>
              <th>选手</th>
              <th>等级</th>
              <th className="num">战力</th>
              <th className="num">评分</th>
              <th>招牌英雄</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ pos, player }) => {
              if (!player) {
                return (
                  <tr key={pos}>
                    <td>
                      <PosBadge pos={pos} />
                    </td>
                    <td colSpan={5} className="text-bad">
                      空缺
                    </td>
                  </tr>
                );
              }
              const eff = safe(() => effectivePower(player), player.power);
              const diff = eff - player.power;
              const mods = (player.modifiers ?? []).filter((m) => m.attr === 'power').map((m) => m.source);
              const fit = safe(() => roleFit(player, pos), 'off' as RoleFit);
              const unavailable = !safe(() => isAvailable(player, tournamentId), true);
              return (
                <tr key={pos}>
                  <td>
                    <PosBadge pos={pos} />
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      <PlayerLink player={player} />
                      {fit !== 'main' && (
                        <Badge
                          className={fit === 'off' ? 'bg-bad/15 text-bad' : 'bg-info/15 text-info'}
                          title={`${ROLE_FIT_LABEL[fit]}，评分 ×${roleFitFactor(fit)}`}
                        >
                          {fit === 'off' ? '错位' : fit === 'alt' ? '副位' : '4/5互换'}
                        </Badge>
                      )}
                      {unavailable && <Badge className="bg-bad/25 text-bad">缺阵</Badge>}
                      {player.tempSubUntilTournament && <Badge title="临时替补">替</Badge>}
                    </div>
                  </td>
                  <td>
                    <TierBadge tier={safe(() => playerTier(player), 'C')} />
                  </td>
                  <td className="num">
                    <span className="tabular">{eff.toFixed(1)}</span>
                    {Math.abs(diff) >= 0.5 && (
                      <span className={cx('ml-1 text-[11px]', diff > 0 ? 'text-good' : 'text-bad')} title={mods.length ? `状态：${mods.join('、')}` : undefined}>
                        {diff > 0 ? '▲' : '▼'}
                      </span>
                    )}
                  </td>
                  <td className="num font-semibold">{safe(() => playerRating(player, pos), 0).toFixed(1)}</td>
                  <td>
                    <span className="flex items-center gap-0.5">
                      {(player.signatureHeroes ?? []).slice(0, 3).map((h) => (
                        <HeroAvatar key={h} heroId={h} size="xs" title={heroCn(h)} />
                      ))}
                      {(player.signatureHeroes ?? []).length === 0 && <span className="text-faint">—</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-line px-4 py-2.5 text-xs">
        <div>
          <div className="text-faint">教练</div>
          {coach ? (
            <div className="mt-0.5 flex items-center gap-1">
              <span className="truncate font-semibold">{coach.name}</span>
              <TierBadge tier={coach.tier} />
            </div>
          ) : (
            <div className="mt-0.5 text-mute">无教练</div>
          )}
        </div>
        <div>
          <div className="text-faint">战队评分</div>
          <div className="mt-0.5 font-semibold tabular">{rating.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-faint">战队灵性</div>
          <div className="mt-0.5 font-semibold tabular">{insight.toFixed(1)}</div>
        </div>
      </div>
    </Card>
  );
}

function SeriesSoFar({ game, games, myTeamId }: { game: GameState; games: GameRecord[]; myTeamId: string }) {
  return (
    <Card title="本系列赛战报" bodyClassName="p-3">
      <div className="flex flex-wrap gap-2">
        {games.map((g, i) => {
          const win = gameWinnerId(g) === myTeamId;
          const mvp = g.mvpPlayerId ? game.players[g.mvpPlayerId] : undefined;
          const mySideInGame: Side = g.teamA === myTeamId ? 'A' : 'B';
          const myK = mySideInGame === 'A' ? g.killsA : g.killsB;
          const opK = mySideInGame === 'A' ? g.killsB : g.killsA;
          return (
            <div key={i} className={cx('min-w-[180px] rounded-lg border px-3 py-2', win ? 'border-good/40 bg-good/5' : 'border-bad/40 bg-bad/5')}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-mute">第 {i + 1} 局</span>
                <span className={cx('font-bold', win ? 'text-good' : 'text-bad')}>{win ? '胜' : '负'}</span>
              </div>
              <div className="mt-0.5 text-sm tabular">
                击杀 {myK}:{opK} · {fmtDuration(g.durationMin)}
              </div>
              {mvp && <div className="text-[11px] text-faint">MVP {mvp.handle}</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
