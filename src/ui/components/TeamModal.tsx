// 战队详情弹窗（全局）：useGameStore.selectedTeamId 非空时打开
import { useEffect, useState, type ReactNode } from 'react';
import { useGameStore } from '../../store/gameStore';
import type { GameState, Player, Position } from '../../engine/types';
import {
  CONFIG, REGION_LABEL, ageOf, benchPlayers, effectivePower, formatGold, formatRank, getCoach, lineupPlayers, overallRating,
  playerRating, playerTier, rankTeamsByRating, seasonStandings, teamRating, trainingBlockReason,
} from '../../engine';
import { Badge, Button, EmptyState, Modal, PosBadge, RegionBadge, TierBadge, cx } from './common';
import { TeamEmblem } from './TeamEmblem';
import { TourTierBadge, openTournamentView, rankClass, safe } from './TourShared';
import { PediaEntryButton } from './PediaKit';

export default function TeamModal() {
  const teamId = useGameStore((s) => s.selectedTeamId);
  const selectedPlayerId = useGameStore((s) => s.selectedPlayerId);
  const game = useGameStore((s) => s.game);
  useGameStore((s) => s.version);
  const openTeam = useGameStore((s) => s.openTeam);
  const openPlayer = useGameStore((s) => s.openPlayer);
  const setView = useGameStore((s) => s.setView);
  // 从本弹窗打开选手详情时暂时隐藏自己，选手弹窗关闭后恢复
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    if (!selectedPlayerId) setStacked(false);
  }, [selectedPlayerId]);
  useEffect(() => {
    setStacked(false);
  }, [teamId]);

  if (!game || !teamId) return null;
  const hidden = stacked && !!selectedPlayerId;
  const team = game.teams[teamId];
  const close = () => openTeam(null);

  if (!team) {
    return (
      <Modal
        open={!hidden}
        onClose={close}
        title="战队详情"
        width="max-w-md"
        footer={game.pedia?.teams?.[teamId] ? <PediaEntryButton kind="team" id={teamId} /> : undefined}
      >
        <EmptyState text="该战队已不存在（可能已解散或数据已清理）。" />
      </Modal>
    );
  }

  const me = game.settings.playerTeamId;
  const isMine = team.id === me;
  const showPlayer = (p: Player) => {
    setStacked(true);
    openPlayer(p.id);
  };

  // 训练赛与训练共用回合次数，规则以引擎为准（赛季初/赛事回合/比赛进行中不可约）
  const scrimBlocked = team.disbanded ? '该战队已解散' : safe(() => trainingBlockReason(game), null) ?? '';

  return (
    <Modal
      open={!hidden}
      onClose={close}
      width="max-w-4xl"
      title={
        <span className="flex items-center gap-2">
          <TeamEmblem tag={team.tag} color={team.color} teamId={team.id} />
          战队详情
        </span>
      }
      footer={
        <>
          <PediaEntryButton kind="team" id={team.id} className="mr-auto" />
          {isMine ? (
            <Button
              onClick={() => {
                close();
                setView('squad');
              }}
            >
              管理阵容
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!!scrimBlocked}
              title={scrimBlocked || `前往训练页，与 ${team.name} 约一场训练赛`}
              onClick={() => {
                close();
                setView('training');
              }}
            >
              约训练赛
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            关闭
          </Button>
        </>
      }
    >
      <TeamBody game={game} teamId={team.id} onPlayer={showPlayer} onTournament={(id) => { close(); openTournamentView(game, id); }} />
    </Modal>
  );
}

function TeamBody({
  game,
  teamId,
  onPlayer,
  onTournament,
}: {
  game: GameState;
  teamId: string;
  onPlayer: (p: Player) => void;
  onTournament: (id: string) => void;
}) {
  const team = game.teams[teamId];
  const me = game.settings.playerTeamId;
  const isMine = teamId === me;
  const rating = safe(() => teamRating(game, teamId), 0);
  const worldRank = safe(() => rankTeamsByRating(game).indexOf(teamId) + 1, 0);
  const standRank = safe(() => seasonStandings(game).findIndex((t) => t.id === teamId) + 1, 0);
  const coach = safe(() => getCoach(game, teamId), null);
  const starters = safe(() => lineupPlayers(game, teamId), [] as { pos: Position; player: Player | null }[]);
  const bench = safe(() => benchPlayers(game, teamId), [] as Player[]);
  const beef = game.beefs.find((b) => b.teamId === teamId && b.season === game.season.ti);
  const results = (game.history?.tournaments ?? [])
    .map((h, i) => ({ h, i, pl: h.placements?.[teamId] }))
    .filter((x) => !!x.pl)
    .sort((a, b) => b.h.season - a.h.season || b.i - a.i)
    .slice(0, 10);
  const running = (game.seasonTournamentIds ?? [])
    .map((id) => game.tournaments[id])
    .filter((t) => t && t.status === 'running' && ((t.teamIds ?? []).includes(teamId) || (t.qualifierTeamIds ?? []).includes(teamId)));
  const titles = (game.history?.tournaments ?? []).filter((h) => h.championId === teamId);
  const tiTitles = titles.filter((h) => h.tier === 'ti').length;

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <div
        className="relative overflow-hidden rounded-xl border border-line p-4"
        style={{ background: `linear-gradient(120deg, ${team.color}33, transparent 60%)` }}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={cx(
              'grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg px-1 text-center font-black leading-tight text-white shadow-lg',
              team.tag.length > 4 ? 'text-[11px]' : 'text-sm tracking-wide',
            )}
            style={{ background: team.color }}
            title={team.tag}
          >
            {team.tag.slice(0, 8)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-xl font-bold">{team.name}</span>
              <RegionBadge region={team.region} />
              {isMine && <Badge className="bg-gold text-black">我的战队</Badge>}
              {team.disbanded && (
                <Badge
                  className="bg-bad/20 text-bad border border-bad/40"
                  title={team.banned ? `TI${team.banned.season} 赛季因俱乐部全员假赛被永久除名` : undefined}
                >
                  {team.banned ? '假赛除名' : '已解散'}
                </Badge>
              )}
              {beef && (
                <Badge className="bg-dota/20 text-dota-2 border border-dota/40" title={`本赛季宿敌：胜 +${beef.winHonor} / 负 ${beef.loseHonor} 荣誉`}>
                  宿敌
                </Badge>
              )}
            </div>
            <div className="mt-0.5 text-xs text-mute">
              {REGION_LABEL[team.region]}
              {titles.length > 0 && (
                <span className="ml-2 text-gold">
                  本存档 {titles.length} 冠{tiTitles ? `（TI ×${tiTitles}）` : ''}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-6">
          <MiniStat label="荣誉" value={Math.round(team.honor)} />
          <MiniStat label="赛季积分" value={Math.round(team.points ?? 0)} hint={standRank > 0 ? `积分榜 #${standRank}` : undefined} />
          <MiniStat label="战队评分" value={Math.round(rating)} hint={coach ? '含教练加成' : undefined} />
          <MiniStat label="世界排名" value={worldRank > 0 ? `#${worldRank}` : '—'} />
          <MiniStat label="上季排名" value={team.lastSeasonRank ? `#${team.lastSeasonRank}` : '—'} />
          <MiniStat label="资金" value={<span className={team.gold < 0 ? 'text-bad' : 'text-gold'}>{formatGold(team.gold)}</span>} />
        </div>
      </div>

      {/* 教练 */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel-2/50 px-3 py-2 text-sm">
        <span className="text-xs text-faint">主教练</span>
        {coach ? (
          <>
            <TierBadge tier={coach.tier} />
            <span className="font-medium">{coach.name}</span>
            <span className="text-xs text-mute">{safe(() => ageOf(game, coach), 0)} 岁</span>
            <span className="text-xs text-mute">
              灵性 <span className="tabular text-ink">{Math.round(coach.insight)}</span>
            </span>
            <span className="text-xs text-mute">
              天赋提升 <span className="tabular text-ink">{coach.talentBoost.toFixed(1)}</span>
            </span>
            <span className="text-xs text-mute">
              韧性提升 <span className="tabular text-ink">{coach.resilienceBoost.toFixed(1)}</span>
            </span>
            {coach.formerPlayerId && <Badge>退役选手转任</Badge>}
          </>
        ) : (
          <span className="text-xs text-faint">空缺</span>
        )}
      </div>

      {/* 阵容 */}
      <div>
        <div className="mb-1.5 text-xs font-semibold text-mute">阵容（{starters.filter((s) => s.player).length + bench.length} 人）</div>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="tbl">
            <thead>
              <tr>
                <th>首发位</th>
                <th>选手</th>
                <th>本位</th>
                <th className="num">年龄</th>
                <th>天梯</th>
                <th className="num">战斗力</th>
                <th className="num" title="本位置评分">综合</th>
                <th className="num" title={`在当前首发位置上的评分（非本位 ×${CONFIG.team.offRoleFactor}）`}>位置评分</th>
                {isMine && <th className="num">合同至</th>}
              </tr>
            </thead>
            <tbody>
              {starters.map(({ pos, player }) =>
                player ? (
                  <RosterRow key={pos} game={game} p={player} slot={pos} onPlayer={onPlayer} showContract={isMine} />
                ) : (
                  <tr key={pos}>
                    <td>
                      <PosBadge pos={pos} />
                    </td>
                    <td colSpan={isMine ? 8 : 7} className="text-xs text-bad">
                      首发空缺
                    </td>
                  </tr>
                ),
              )}
              {bench.map((p) => (
                <RosterRow key={p.id} game={game} p={p} slot={null} onPlayer={onPlayer} showContract={isMine} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 战绩 */}
      <div>
        <div className="mb-1.5 text-xs font-semibold text-mute">近期战绩</div>
        {results.length === 0 && running.length === 0 ? (
          <div className="rounded-lg border border-line px-3 py-4 text-center text-xs text-faint">本存档中暂无赛事战绩</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="tbl">
              <tbody>
                {running.map((t) => (
                  <tr key={t.id}>
                    <td className="w-16 text-mute">TI{t.season}</td>
                    <td>
                      <button className="cursor-pointer hover:text-gold hover:underline" onClick={() => onTournament(t.id)}>
                        {t.name}
                      </button>
                    </td>
                    <td>
                      <TourTierBadge tier={t.tier} />
                    </td>
                    <td className="num text-good">进行中</td>
                  </tr>
                ))}
                {results.map(({ h, pl }) => (
                  <tr key={`${h.tournamentId}-${h.season}`}>
                    <td className="w-16 text-mute">TI{h.season}</td>
                    <td className="max-w-72 truncate">
                      {game.tournaments[h.tournamentId] ? (
                        <button className="cursor-pointer hover:text-gold hover:underline" onClick={() => onTournament(h.tournamentId)}>
                          {h.name}
                        </button>
                      ) : (
                        h.name
                      )}
                    </td>
                    <td>
                      <TourTierBadge tier={h.tier} />
                    </td>
                    <td className="num">
                      <span className={rankClass(pl![0])}>{formatRank(pl![0], pl![1])}</span>
                      <span className="ml-1 text-[11px] text-faint">/ {pl![2]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-md border border-line/70 bg-panel/70 px-2.5 py-1.5">
      <div className="text-[10px] text-faint">{label}</div>
      <div className="text-sm font-semibold tabular">{value}</div>
      {hint && <div className="text-[10px] text-faint">{hint}</div>}
    </div>
  );
}

function RosterRow({
  game,
  p,
  slot,
  onPlayer,
  showContract,
}: {
  game: GameState;
  p: Player;
  slot: Position | null;
  onPlayer: (p: Player) => void;
  showContract: boolean;
}) {
  // 只统计尚未结束的赛事（已结束赛事的禁赛记录不再影响出场）
  const blockedIn = (p.unavailableTournamentIds ?? [])
    .map((id) => game.tournaments[id])
    .filter((t) => !!t && t.status !== 'finished');
  const unavailable = blockedIn.length > 0;
  const tempMods = (p.modifiers ?? []).filter((m) => m.roundsLeft !== null);
  return (
    <tr className={cx(!slot && 'opacity-80')}>
      <td>{slot ? <PosBadge pos={slot} /> : <span className="text-xs text-faint">替补</span>}</td>
      <td>
        <button onClick={() => onPlayer(p)} className="cursor-pointer font-medium hover:text-gold hover:underline">
          {p.handle}
        </button>
        {p.tempSubUntilTournament && <Badge className="ml-1 bg-info/15 text-info">临时替补</Badge>}
        {unavailable && (
          <Badge className="ml-1 bg-bad/15 text-bad" title={`因签证/伤病等无法参加：${blockedIn.map((t) => t!.name).join('、')}`}>
            不可出赛
          </Badge>
        )}
        {tempMods.length > 0 && (
          <span className="ml-1 text-[10px] text-faint" title={tempMods.map((m) => `${m.source}（剩 ${m.roundsLeft} 回合）`).join('\n')}>
            状态×{tempMods.length}
          </span>
        )}
      </td>
      <td>
        <PosBadge pos={p.position} />
      </td>
      <td className="num">{safe(() => ageOf(game, p), 0)}</td>
      <td>
        <TierBadge tier={safe(() => playerTier(p), 'C')} />
      </td>
      <td className="num">{safe(() => effectivePower(p), p.power).toFixed(1)}</td>
      <td className="num font-semibold">{safe(() => overallRating(p), 0).toFixed(1)}</td>
      <td className={cx('num', slot && slot !== p.position ? 'text-bad' : 'text-mute')}>
        {slot ? safe(() => playerRating(p, slot), 0).toFixed(1) : '—'}
      </td>
      {showContract && <td className="num text-mute">TI{p.contractUntil}</td>}
    </tr>
  );
}
